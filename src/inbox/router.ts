import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ulid } from 'ulid';
import type { MemoryClient } from '@memory/client';
import { convert } from './pipeline';
import { InboxStorage } from './storage';
import type { ConversionInput } from './types';

export interface InboxRouterDeps {
  vault_root: string;
  memory: MemoryClient;
}

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

const UrlSubmitSchema = z.object({
  url: z.string().url(),
});

export function create_inbox_router(deps: InboxRouterDeps): Hono {
  const router = new Hono();
  const storage = new InboxStorage({
    vault_root: deps.vault_root,
    memory: deps.memory,
  });

  // Path to the HTML page (resolved relative to this file at runtime via
  // import.meta.dir, which Bun supports)
  const html_path = resolve(import.meta.dir, 'client.html');

  // ── GET /inbox — the web UI ───────────────────────────────────────────
  router.get('/', (c) => {
    const html = readFileSync(html_path, 'utf8');
    return c.html(html);
  });

  // ── POST /inbox/upload — multipart file upload ────────────────────────
  router.post('/upload', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody();
    } catch (err) {
      return c.json({ error: `Failed to parse upload: ${(err as Error).message}` }, 400);
    }

    const file = body.file;
    if (!(file instanceof File)) {
      return c.json({ error: 'No file in upload (expected field name "file")' }, 400);
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return c.json(
        { error: `File too large: ${file.size} bytes (max ${MAX_UPLOAD_BYTES})` },
        413,
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const input: ConversionInput = {
      filename: file.name,
      mime_type: file.type || 'application/octet-stream',
      bytes,
    };

    try {
      const result = await convert(input);
      const u = c.get('user');
      const saved = storage.save(result, {
        source: 'file',
        tz: c.get('user_tz'),
        ...(u ? { caller: { user_id: u.id, tier: u.tier } } : {}),
      });

      // Log to audit
      deps.memory.log_action({
        intent_id: `inbox_upload:${ulid()}`,
        agent: 'orchestrator',
        tool_name: 'inbox_upload',
        tool_input: {
          filename: input.filename,
          mime: input.mime_type,
          byte_size: bytes.length,
        },
        execution_result: {
          id: saved.id,
          wrapper_note_path: saved.wrapper_note_path,
          kind: saved.kind,
        },
      });

      return c.json(saved);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.memory.log_action({
        intent_id: `inbox_upload:${ulid()}`,
        agent: 'orchestrator',
        tool_name: 'inbox_upload',
        tool_input: {
          filename: input.filename,
          mime: input.mime_type,
          byte_size: bytes.length,
        },
        error: message,
      });
      return c.json({ error: message }, 500);
    }
  });

  // ── POST /inbox/url — fetch URL and convert ───────────────────────────
  router.post('/url', async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch (err) {
      return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = UrlSubmitSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    const input: ConversionInput = {
      filename: parsed.data.url,
      mime_type: 'text/url',
      url: parsed.data.url,
    };

    try {
      const result = await convert(input);
      const u = c.get('user');
      const saved = storage.save(result, {
        source: 'url',
        source_url: parsed.data.url,
        tz: c.get('user_tz'),
        ...(u ? { caller: { user_id: u.id, tier: u.tier } } : {}),
      });

      deps.memory.log_action({
        intent_id: `inbox_url:${ulid()}`,
        agent: 'orchestrator',
        tool_name: 'inbox_url',
        tool_input: { url: parsed.data.url },
        execution_result: {
          id: saved.id,
          wrapper_note_path: saved.wrapper_note_path,
          kind: saved.kind,
        },
      });

      return c.json(saved);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.memory.log_action({
        intent_id: `inbox_url:${ulid()}`,
        agent: 'orchestrator',
        tool_name: 'inbox_url',
        tool_input: { url: parsed.data.url },
        error: message,
      });
      return c.json({ error: message }, 500);
    }
  });

  // ── GET /inbox/recent — list recent items ─────────────────────────────
  router.get('/recent', (c) => {
    const limit_param = c.req.query('limit');
    const limit = limit_param ? Math.max(1, Math.min(100, parseInt(limit_param, 10) || 20)) : 20;
    return c.json({ items: storage.list_recent(limit) });
  });

  return router;
}
