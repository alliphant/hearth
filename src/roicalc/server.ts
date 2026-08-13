// src/roicalc/server.ts — standalone local-vs-cloud LLM ROI calculator.
// Deliberately NOT mounted on the orchestrator: benching is an ad-hoc owner
// activity (a bench against a live tier competes with real turns), so this
// runs on demand:  bun run roicalc  →  http://localhost:7790
//
// Routes:
//   GET  /             the calculator UI (no build step, like /inbox)
//   GET  /api/presets  GPU price/wattage presets (editable defaults)
//   GET  /api/models   proxy to the target endpoint's /v1/models (CORS-free)
//   POST /api/bench    run a live prefill/generation benchmark (see bench.ts)
//   POST /api/calc     pure ROI math (see calc.ts)

import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { BenchInputSchema, normalize_base, run_bench } from './bench';
import { compute_roi, RoiInputSchema } from './calc';
import { GPU_PRESETS } from './presets';

const ModelsQuerySchema = z.object({
  base_url: z.string().url(),
  api_key: z.string().min(1).optional(),
});

export function create_roicalc_app(): Hono {
  const app = new Hono({ strict: false });
  const html_path = resolve(import.meta.dir, 'client.html');

  app.get('/', (c) => c.html(readFileSync(html_path, 'utf8')));

  app.get('/status', (c) => c.json({ ok: true, service: 'hearth-roicalc' }));

  app.get('/api/presets', (c) => c.json({ presets: GPU_PRESETS }));

  app.get('/api/models', async (c) => {
    const parsed = ModelsQuerySchema.safeParse({
      base_url: c.req.query('base_url'),
      api_key: c.req.query('api_key') || undefined,
    });
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const base = normalize_base(parsed.data.base_url).replace(/\/chat\/completions$/, '');
      const res = await fetch(`${base}/models`, {
        headers: parsed.data.api_key
          ? { authorization: `Bearer ${parsed.data.api_key}` }
          : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return c.json({ error: `endpoint returned HTTP ${res.status}` }, 502);
      const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
      const models = (body.data ?? [])
        .map((m) => (typeof m.id === 'string' ? m.id : null))
        .filter((m): m is string => m !== null);
      return c.json({ models });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.post('/api/bench', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = BenchInputSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const result = await run_bench(parsed.data);
    return result.ok ? c.json(result) : c.json(result, 502);
  });

  app.post('/api/calc', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = RoiInputSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return c.json(compute_roi(parsed.data));
  });

  return app;
}

if (import.meta.main) {
  const port = Number(process.env.HEARTH_ROICALC_PORT ?? 7790);
  // idleTimeout 0: a bench response can take minutes (model load) with no
  // bytes flowing; Bun's default idle timeout would cut the connection.
  Bun.serve({ port, fetch: create_roicalc_app().fetch, idleTimeout: 0 });
  console.log(`[roicalc] local-vs-cloud LLM calculator on http://localhost:${port}`);
}
