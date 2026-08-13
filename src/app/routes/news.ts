/**
 * /api/news — the News Desk API behind the second tab in Kate's office
 * (2026-06-10).
 *
 *   GET  /api/news/desk?category=&limit=   word-cloud categories + headlines
 *                                          (any authenticated household user)
 *   POST /api/news/categories/:key         { paused: bool } — gear toggle;
 *                                          pauses/resumes every subscription
 *                                          in the category (owner)
 *   POST /api/news/activate/:key           switch ON an offered bundle —
 *                                          seeds its feeds onto Kate's rack
 *                                          (owner)
 *   POST /api/news/track                   { topic } — free-text "track
 *                                          something new": runs Cordelia's
 *                                          scout_sources targeting Kate;
 *                                          proposals land in the owner's
 *                                          queue and approval auto-subscribes
 *                                          (owner)
 *
 * Compose logic lives in src/core/news_desk.ts; this router stays thin
 * (validate → call → audit → respond). NOTE: `/api/news/` is a NEW
 * top-level namespace — it must be added to the nginx `/api/(...)`
 * alternation on the LLM host (`docker restart nginx`) or it 404s through
 * the proxy (the the private dev log "API mount topology" gotcha).
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { MemoryClient } from '@memory/client';
import type { SpecialistRegistry } from '@core/specialist';
import type { ToolRegistry } from '@core/tool_registry';
import type { LLMRouter } from '@core/llm';
import {
  compose_desk,
  set_category_paused,
  activate_offered_bundle,
  type NewsDeskDeps,
} from '@core/news_desk';

export interface NewsRouterDeps {
  db: Database;
  memory: MemoryClient;
  specialists: SpecialistRegistry;
  tool_registry: ToolRegistry;
  llm: LLMRouter;
  /** Smoke seam, threaded into compose_desk. */
  watched_titles_fn?: () => Promise<string[]>;
}

const PausedSchema = z.object({ paused: z.boolean() });
const TrackSchema = z.object({ topic: z.string().min(3).max(180) });

export function create_news_router(deps: NewsRouterDeps): Hono {
  const r = new Hono();
  const desk_deps: NewsDeskDeps = {
    db: deps.db,
    memory: deps.memory,
    specialists: deps.specialists,
    tool_registry: deps.tool_registry,
    llm: deps.llm,
    ...(deps.watched_titles_fn ? { watched_titles_fn: deps.watched_titles_fn } : {}),
  };

  const require_owner = (c: Context) => {
    const user = c.get('user');
    return user && user.tier === 'owner' ? user : null;
  };

  // Reading the desk: any authenticated household principal — news is
  // shelf-wide public material. Mutations below are owner-only.
  r.get('/desk', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthenticated' }, 401);
    const category = c.req.query('category') || undefined;
    const limit_raw = Number(c.req.query('limit'));
    const payload = await compose_desk(desk_deps, {
      ...(category ? { category } : {}),
      ...(Number.isFinite(limit_raw) && limit_raw > 0 ? { limit: limit_raw } : {}),
    });
    return c.json(payload);
  });

  r.post('/categories/:key', async (c) => {
    const user = require_owner(c);
    if (!user) return c.json({ error: 'owner only' }, 403);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = PausedSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const key = c.req.param('key');
    const flipped = set_category_paused(deps.memory, key, parsed.data.paused);
    deps.memory.log_action({
      intent_id: ulid(),
      agent: 'orchestrator',
      tool_name: 'news_category_toggle',
      tool_input: { category: key, paused: parsed.data.paused, by: user.id },
      execution_result: { flipped },
      user_id: user.id,
    });
    return c.json({ ok: true, category: key, paused: parsed.data.paused, flipped });
  });

  r.post('/activate/:key', async (c) => {
    const user = require_owner(c);
    if (!user) return c.json({ error: 'owner only' }, 403);
    const key = c.req.param('key');
    const bundle = activate_offered_bundle(deps.memory, key);
    if (!bundle) return c.json({ error: `unknown offered bundle: ${key}` }, 404);
    deps.memory.log_action({
      intent_id: ulid(),
      agent: 'orchestrator',
      tool_name: 'news_bundle_activated',
      tool_input: { category: key, by: user.id },
      execution_result: { sources: bundle.sources.map((s) => s.url) },
      user_id: user.id,
    });
    return c.json({ ok: true, category: key, sources_added: bundle.sources.length });
  });

  // Free-text "track something new" — Cordelia scouts, Jasper approves,
  // approval auto-subscribes. The scout runs inline (search + judge,
  // typically 10–30s); the UI shows the proposal count on return.
  r.post('/track', async (c) => {
    const user = require_owner(c);
    if (!user) return c.json({ error: 'owner only' }, 403);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = TrackSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const cordelia = deps.specialists.get('cordelia');
    if (!cordelia) return c.json({ error: 'cordelia is not on the roster' }, 500);

    const outcome = await deps.tool_registry.invoke(
      'scout_sources',
      { topic: parsed.data.topic, specialist_id: 'kate' },
      {
        memory: deps.memory,
        llm: deps.llm,
        now: new Date(),
        intent_id: ulid(),
        specialist_id: 'cordelia',
        user: { id: user.id, tier: user.tier },
      },
      cordelia.granted,
      'cordelia',
    );
    if (!outcome.ok) {
      return c.json({ error: outcome.error ?? 'scout failed' }, 502);
    }
    const result = outcome.result as {
      candidates?: unknown[];
      proposals?: unknown[];
      judge_error?: string;
      next_action?: string;
    };
    return c.json({
      ok: true,
      topic: parsed.data.topic,
      candidates: result.candidates?.length ?? 0,
      proposals_filed: result.proposals?.length ?? 0,
      judge_error: result.judge_error,
      next_action: result.next_action,
    });
  });

  return r;
}
