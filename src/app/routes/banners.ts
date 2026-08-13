/**
 * Banner images — the wide hero strip across the top of each specialist's
 * profile card. Same upload pattern as avatars (manual drop for now); when
 * an SDXL backend lands, the generator just POSTs the rendered PNG to this
 * same endpoint with its prompt derived from persona.
 *
 * Fallback when no banner is uploaded: a themed SVG gradient keyed to the
 * specialist's accent color, so a profile always looks intentional even on
 * day one.
 */
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

export interface BannersRoutesDeps {
  specialists: SpecialistRegistry;
  vault_root: string;
  memory: MemoryClient;
}

const ACCENT: Record<string, string> = {
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
};
// Banners can reasonably be larger than avatars (wide hero strip).
const MAX_BANNER_BYTES = 8 * 1024 * 1024;

function capitalize_id(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function banner_candidates(vault_root: string, spec_id: string): string[] {
  const base = resolve(vault_root, 'Knowledge', capitalize_id(spec_id));
  return Object.values(ACCEPTED_MIMES).map((ext) => resolve(base, `banner${ext}`));
}

function mime_for(abs: string): string {
  const lower = abs.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

function _hash_hue(id: string): number {
  let h = 0;
  for (const ch of id) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
  return Math.abs(h) % 360;
}

function fallback_for(spec_id: string): string {
  const accent = ACCENT[spec_id];
  const hue = accent ? null : _hash_hue(spec_id);
  const top = accent ?? `hsl(${hue} 38% 52%)`;
  const bottom = accent ? `${accent}cc` : `hsl(${hue} 30% 30%)`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 300" width="1200" height="300">` +
    `<defs>` +
    `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${top}" stop-opacity="0.92"/>` +
    `<stop offset="1" stop-color="${bottom}" stop-opacity="0.98"/>` +
    `</linearGradient>` +
    `<radialGradient id="r" cx="0.18" cy="0.25" r="0.85">` +
    `<stop offset="0" stop-color="white" stop-opacity="0.18"/>` +
    `<stop offset="1" stop-color="white" stop-opacity="0"/>` +
    `</radialGradient>` +
    `</defs>` +
    `<rect width="1200" height="300" fill="url(#g)"/>` +
    `<rect width="1200" height="300" fill="url(#r)"/>` +
    `</svg>`
  );
}

export function create_banners_router(deps: BannersRoutesDeps): Hono {
  const r = new Hono();

  r.get('/:specialist_id', (c) => {
    const id = c.req.param('specialist_id');
    const spec = deps.specialists.get(id);
    const fallback = () =>
      new Response(fallback_for(id), {
        status: 200,
        headers: {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'public, max-age=300',
        },
      });
    if (!spec) return fallback();

    for (const abs of banner_candidates(deps.vault_root, id)) {
      if (existsSync(abs)) {
        const bytes = readFileSync(abs);
        return new Response(new Uint8Array(bytes), {
          status: 200,
          headers: {
            'Content-Type': mime_for(abs),
            'Cache-Control': 'public, max-age=60, must-revalidate',
          },
        });
      }
    }
    return fallback();
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
    if (!(file instanceof File)) return c.json({ error: 'missing "file" field' }, 400);
    if (file.size === 0) return c.json({ error: 'empty file' }, 400);
    if (file.size > MAX_BANNER_BYTES) {
      return c.json({ error: `file too large (${file.size} > ${MAX_BANNER_BYTES})` }, 413);
    }
    const ext = ACCEPTED_MIMES[file.type];
    if (!ext) {
      return c.json({ error: `unsupported image type: ${file.type || 'unknown'}` }, 415);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const home = resolve(deps.vault_root, 'Knowledge', capitalize_id(id));
    const target = resolve(home, `banner${ext}`);
    mkdirSync(dirname(target), { recursive: true });
    for (const candidate of banner_candidates(deps.vault_root, id)) {
      if (candidate !== target && existsSync(candidate)) {
        try { rmSync(candidate); } catch { /* ignore */ }
      }
    }
    writeFileSync(target, bytes);

    deps.memory.log_action({
      intent_id: `banner_upload:${id}:${Date.now()}`,
      agent: 'orchestrator',
      tool_name: 'banner_upload',
      tool_input: { specialist_id: id, mime: file.type, size: file.size },
      execution_result: { rel_path: `Knowledge/${capitalize_id(id)}/banner${ext}` },
    });

    return c.json({ ok: true, specialist_id: id, mime: file.type, size: file.size });
  });

  r.delete('/:specialist_id', (c) => {
    const id = c.req.param('specialist_id');
    const spec = deps.specialists.get(id);
    if (!spec) return c.json({ error: `unknown specialist: ${id}` }, 404);
    let removed = 0;
    for (const candidate of banner_candidates(deps.vault_root, id)) {
      if (existsSync(candidate)) {
        try { rmSync(candidate); removed += 1; } catch { /* ignore */ }
      }
    }
    if (removed > 0) {
      deps.memory.log_action({
        intent_id: `banner_delete:${id}:${Date.now()}`,
        agent: 'orchestrator',
        tool_name: 'banner_delete',
        tool_input: { specialist_id: id },
        execution_result: { files_removed: removed },
      });
    }
    return c.json({ ok: true, specialist_id: id, files_removed: removed });
  });

  return r;
}
