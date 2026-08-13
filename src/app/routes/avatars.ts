import { Hono } from 'hono';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { SpecialistRegistry } from '@core/specialist';
import type { MemoryClient } from '@memory/client';

export interface AvatarsRoutesDeps {
  specialists: SpecialistRegistry;
  specialists_dir: string;
  vault_root: string;
  memory: MemoryClient;
}

const COLORS: Record<string, string> = {
  kate: '#7f5af0',
  vivian: '#5b8e7d',
  anya: '#c87065',
  eleanor: '#7a9b58',
  marguerite: '#9a7aa0',
  iris: '#5e8aa8',
  cassandra: '#a87d4a',
};

const ACCEPTED_MIMES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/gif': '.gif',
};

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

function capitalize_id(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function initial_svg(letter: string, color: string): string {
  const safe = (letter[0] ?? '?').toUpperCase();
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="128" height="128">` +
    `<circle cx="32" cy="32" r="32" fill="${color}"/>` +
    `<text x="32" y="42" text-anchor="middle" font-size="30" font-weight="600" ` +
    `font-family="-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif" ` +
    `fill="white">${safe}</text>` +
    `</svg>`
  );
}

function svg_response(svg: string, cache_ok: boolean): Response {
  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      // No cache when we just mutated (so the UI sees the new avatar
      // immediately); short cache otherwise.
      'Cache-Control': cache_ok ? 'public, max-age=60' : 'no-cache',
    },
  });
}

/**
 * Locate every avatar file that might exist for this specialist, so we
 * can clean them all up when the user uploads a new one in a different
 * format (avoids two side-by-side avatar.png + avatar.webp).
 */
function avatar_candidates(vault_root: string, spec_id: string): string[] {
  const base = resolve(vault_root, 'Knowledge', capitalize_id(spec_id));
  return Object.values(ACCEPTED_MIMES).map((ext) => resolve(base, `avatar${ext}`));
}

function existing_avatar_path(
  vault_root: string,
  declared: string | undefined,
  spec_id: string,
): { abs: string; mime: string } | null {
  if (declared) {
    const abs = resolve(vault_root, declared);
    if (existsSync(abs)) {
      return { abs, mime: mime_for_extension(abs) };
    }
  }
  for (const abs of avatar_candidates(vault_root, spec_id)) {
    if (existsSync(abs)) return { abs, mime: mime_for_extension(abs) };
  }
  return null;
}

function mime_for_extension(abs: string): string {
  const lower = abs.toLowerCase();
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/png';
}

export function create_avatars_router(deps: AvatarsRoutesDeps): Hono {
  const r = new Hono();

  r.get('/:specialist_id', (c) => {
    const id = c.req.param('specialist_id');
    const spec = deps.specialists.get(id);
    if (!spec) {
      return svg_response(initial_svg('?', '#888'), true);
    }

    const found = existing_avatar_path(deps.vault_root, spec.avatar, id);
    if (found) {
      const bytes = readFileSync(found.abs);
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          'Content-Type': found.mime,
          // mtime-anchored ETag-lite so the browser revalidates after
          // an upload without us having to bust query strings everywhere.
          'Cache-Control': 'public, max-age=60, must-revalidate',
        },
      });
    }

    const color = COLORS[id] ?? '#7f5af0';
    const letter = (spec.name ?? id)[0] ?? '?';
    return svg_response(initial_svg(letter, color), true);
  });

  r.post('/:specialist_id', async (c) => {
    const id = c.req.param('specialist_id');
    const spec = deps.specialists.get(id);
    if (!spec) return c.json({ error: `unknown specialist: ${id}` }, 404);

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch (err) {
      return c.json({ error: `bad multipart: ${(err as Error).message}` }, 400);
    }
    const file = form.get('file');
    if (!(file instanceof File)) {
      return c.json({ error: 'missing "file" field' }, 400);
    }
    if (file.size === 0) {
      return c.json({ error: 'empty file' }, 400);
    }
    if (file.size > MAX_AVATAR_BYTES) {
      return c.json(
        { error: `file too large (${file.size} > ${MAX_AVATAR_BYTES})` },
        413,
      );
    }
    const ext = ACCEPTED_MIMES[file.type];
    if (!ext) {
      return c.json(
        { error: `unsupported image type: ${file.type || 'unknown'}` },
        415,
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const home = resolve(deps.vault_root, 'Knowledge', capitalize_id(id));
    const target = resolve(home, `avatar${ext}`);
    mkdirSync(dirname(target), { recursive: true });

    // Remove any avatar in a different format so we don't end up with
    // two parallel files and ambiguous serving order.
    for (const candidate of avatar_candidates(deps.vault_root, id)) {
      if (candidate !== target && existsSync(candidate)) {
        try { rmSync(candidate); } catch { /* ignore */ }
      }
    }
    writeFileSync(target, bytes);

    const rel = `Knowledge/${capitalize_id(id)}/avatar${ext}`;

    deps.memory.log_action({
      intent_id: `avatar_upload:${id}:${Date.now()}`,
      agent: 'orchestrator',
      tool_name: 'avatar_upload',
      tool_input: { specialist_id: id, mime: file.type, size: file.size },
      execution_result: { rel_path: rel },
    });

    return c.json({
      ok: true,
      specialist_id: id,
      rel_path: rel,
      mime: file.type,
      size: file.size,
    });
  });

  r.delete('/:specialist_id', (c) => {
    const id = c.req.param('specialist_id');
    const spec = deps.specialists.get(id);
    if (!spec) return c.json({ error: `unknown specialist: ${id}` }, 404);

    let removed = 0;
    for (const candidate of avatar_candidates(deps.vault_root, id)) {
      if (existsSync(candidate)) {
        try {
          rmSync(candidate);
          removed += 1;
        } catch {
          /* ignore */
        }
      }
    }
    if (spec.avatar) {
      const declared_abs = resolve(deps.vault_root, spec.avatar);
      if (existsSync(declared_abs)) {
        try {
          rmSync(declared_abs);
          removed += 1;
        } catch {
          /* ignore */
        }
      }
    }

    if (removed > 0) {
      deps.memory.log_action({
        intent_id: `avatar_delete:${id}:${Date.now()}`,
        agent: 'orchestrator',
        tool_name: 'avatar_delete',
        tool_input: { specialist_id: id },
        execution_result: { files_removed: removed },
      });
    }

    return c.json({ ok: true, specialist_id: id, files_removed: removed });
  });

  return r;
}
