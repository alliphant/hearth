/**
 * /files — the library web UI + JSON API.
 *
 * A Hono sub-router mounted by the orchestrator the same way /inbox is.
 * It serves the Finder-grade file manager (client.html) and the API the
 * page drives: tree / list / search reads, plus the upload / mkdir /
 * move / rename / delete mutations. File bytes are served by id from
 * /api/file/:id.
 *
 * Reads are not audited (a file manager lists constantly — that would
 * drown the audit log). Mutations are: every upload, mkdir, move,
 * rename, and delete writes an audit_log row, mirroring how /inbox
 * audits its uploads.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ulid } from 'ulid';
import type { MemoryClient } from '@memory/client';
import { LibraryStore, mime_of } from './store';

export interface LibraryRouterDeps {
  library: LibraryStore;
  memory: MemoryClient;
}

/** UI upload cap. parseBody() buffers the whole body in memory, so this
 *  is deliberately well below the 5 GB server-side download cap — large
 *  acquisitions go through Cordelia's download_to_library, not a browser
 *  multipart POST. */
const MAX_UPLOAD_BYTES = parseInt(
  process.env.HEARTH_LIBRARY_MAX_UPLOAD_BYTES ?? String(1024 * 1024 * 1024),
  10,
);

const PathBody = z.object({ path: z.string().min(1).max(2000) });
const MkdirBody = z.object({ path: z.string().min(1).max(2000) });
const MoveBody = z.object({
  from: z.string().min(1).max(2000),
  to: z.string().min(0).max(2000),
});
const RenameBody = z.object({
  path: z.string().min(1).max(2000),
  new_name: z.string().min(1).max(255),
});

export function create_library_router(deps: LibraryRouterDeps): Hono {
  const router = new Hono();
  const { library, memory } = deps;
  const html_path = resolve(import.meta.dir, 'client.html');

  // Per-user data cordon (2026-06-04): the /files manager is the captain's
  // raw binary store (Cordelia downloads here on his behalf, ~/hearth-library/).
  // It is owner-only — household/friend users work with curated libraries
  // through the /app specialist surface, never this Finder. An authenticated
  // non-owner is refused; an unauthenticated/internal caller (no user on the
  // context — smokes, localhost tooling) passes through unchanged.
  router.use('*', async (c, next) => {
    const u = c.get('user');
    if (u && u.tier !== 'owner') {
      return c.json({ error: 'the file manager is owner-only' }, 403);
    }
    return next();
  });

  const audit = (
    tool_name: string,
    tool_input: Record<string, unknown>,
    execution_result?: unknown,
    error?: string,
  ): void => {
    memory.log_action({
      intent_id: `library:${ulid()}`,
      agent: 'orchestrator',
      tool_name,
      tool_input,
      execution_result,
      error,
    });
  };

  const read_json = async (
    c: Context,
  ): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> => {
    try {
      return { ok: true, body: await c.req.json() };
    } catch (err) {
      return { ok: false, error: `Invalid JSON: ${(err as Error).message}` };
    }
  };

  // ── GET /files — the web UI ───────────────────────────────────────────
  router.get('/', (c) => c.html(readFileSync(html_path, 'utf8')));

  // ── GET /files/api/tree — sidebar folder tree ─────────────────────────
  router.get('/api/tree', (c) => {
    try {
      return c.json({ categories: library.tree() });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // ── GET /files/api/list?path= — one directory ─────────────────────────
  router.get('/api/list', (c) => {
    const path = c.req.query('path') ?? '';
    try {
      return c.json(library.list(path));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ── GET /files/api/search?q= — filename + tag/metadata search ─────────
  router.get('/api/search', (c) => {
    const q = c.req.query('q') ?? '';
    try {
      return c.json({ query: q, results: library.search(q) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ── GET /files/api/recents?limit= — most recently added files ─────────
  router.get('/api/recents', (c) => {
    const raw = c.req.query('limit');
    const limit = raw ? parseInt(raw, 10) || 50 : 50;
    try {
      return c.json({ files: library.recents(limit) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ── GET /files/api/info/:id — file metadata (Get Info) ────────────────
  router.get('/api/info/:id', (c) => {
    const file = library.get_by_id(c.req.param('id'));
    if (!file) return c.json({ error: 'file not found' }, 404);
    return c.json(file);
  });

  // ── GET /files/api/file/:id — serve the file bytes ────────────────────
  // Inline by default so images / PDFs preview in a new tab; ?download=1
  // forces a save dialog.
  router.get('/api/file/:id', (c) => {
    const file = library.get_by_id(c.req.param('id'));
    if (!file) return c.json({ error: 'file not found' }, 404);
    let abs: string;
    try {
      abs = library.abs_path(file.rel_path);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    const as_download = c.req.query('download') === '1';
    const disposition = as_download ? 'attachment' : 'inline';
    // RFC 5987 — encode the filename so non-ASCII names survive.
    const enc = encodeURIComponent(file.filename);
    return new Response(Bun.file(abs), {
      headers: {
        'Content-Type': file.mime ?? mime_of(file.filename),
        'Content-Disposition': `${disposition}; filename*=UTF-8''${enc}`,
        'Cache-Control': 'private, max-age=0',
      },
    });
  });

  // ── POST /files/api/upload — multipart upload (OS drag-in) ────────────
  router.post('/api/upload', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody();
    } catch (err) {
      return c.json({ error: `Failed to parse upload: ${(err as Error).message}` }, 400);
    }
    const file = body.file;
    const dir = typeof body.path === 'string' ? body.path : '';
    if (!(file instanceof File)) {
      return c.json({ error: 'No file in upload (expected field "file")' }, 400);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return c.json(
        { error: `File too large: ${file.size} bytes (max ${MAX_UPLOAD_BYTES})` },
        413,
      );
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const saved = library.write_file({
        dir,
        filename: file.name,
        bytes,
        mime: file.type || null,
        downloaded_by: 'jasper',
      });
      audit('library_upload', { dir, filename: file.name, byte_size: bytes.length }, {
        id: saved.id,
        rel_path: saved.rel_path,
      });
      return c.json(saved);
    } catch (err) {
      const message = (err as Error).message;
      audit('library_upload', { dir, filename: file.name }, undefined, message);
      return c.json({ error: message }, 400);
    }
  });

  // ── POST /files/api/mkdir — create a folder ───────────────────────────
  router.post('/api/mkdir', async (c) => {
    const j = await read_json(c);
    if (!j.ok) return c.json({ error: j.error }, 400);
    const parsed = MkdirBody.safeParse(j.body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const result = library.mkdir(parsed.data.path);
      audit('library_mkdir', { path: parsed.data.path }, result);
      return c.json(result);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ── POST /files/api/move — move a file or folder ──────────────────────
  router.post('/api/move', async (c) => {
    const j = await read_json(c);
    if (!j.ok) return c.json({ error: j.error }, 400);
    const parsed = MoveBody.safeParse(j.body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const result = library.move(parsed.data.from, parsed.data.to);
      audit('library_move', { from: parsed.data.from, to: parsed.data.to }, result);
      return c.json(result);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ── POST /files/api/rename — rename a file or folder ──────────────────
  router.post('/api/rename', async (c) => {
    const j = await read_json(c);
    if (!j.ok) return c.json({ error: j.error }, 400);
    const parsed = RenameBody.safeParse(j.body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const result = library.rename(parsed.data.path, parsed.data.new_name);
      audit('library_rename', parsed.data, result);
      return c.json(result);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ── POST /files/api/delete — delete a file or folder ──────────────────
  router.post('/api/delete', async (c) => {
    const j = await read_json(c);
    if (!j.ok) return c.json({ error: j.error }, 400);
    const parsed = PathBody.safeParse(j.body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      library.remove(parsed.data.path);
      audit('library_delete', { path: parsed.data.path }, { deleted: parsed.data.path });
      return c.json({ ok: true, deleted: parsed.data.path });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  return router;
}
