/**
 * /api/kate — surfaces over the Kate-as-filter queue.
 *
 * Endpoints in v0.1 (Phase 1 + minimum Phase 2 from BACKEND_FILTER_BRIEF.md):
 *
 *   GET  /api/kate/held               — held items + dropped today + batched
 *   POST /api/kate/held/:id/action    — surface_now | dismiss | always_drop_like_this
 *
 * Auth: bearer / cookie via the existing middleware; `c.get('user')`
 * scopes every read and every mutation.
 *
 * NB: when adding `/api/kate` as a new top-level Hearth namespace, the
 * nginx regex on the Tailscale proxy at
 * `~/docker/nginx/locations.conf` needs to extend the alternation:
 *
 *   location ~ ^/api/(specialists|conversations|proposals|interrupts
 *                     |search|briefs|inbox|users|present-questions|auth
 *                     |sensors|kate)(/|$)
 *
 * Then `docker restart nginx`. Without that, /api/kate falls through to
 * Home Assistant's catch-all and returns whatever HA decides — usually
 * 404. See architecture.md "Endpoint paths (no version prefix)".
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import {
  list_held,
  apply_held_action,
  type HeldAction,
} from '@core/kate_filter';
import {
  list_pending_precommits,
  intercept_precommit,
} from '@core/precommit';
import type { AppEventBus } from '../events';

export interface KateRoutesDeps {
  db: Database;
  events: AppEventBus;
}

const ActionBody = z
  .object({
    action: z.enum(['surface_now', 'dismiss', 'always_drop_like_this']),
  })
  .strict();

export function create_kate_router(deps: KateRoutesDeps): Hono {
  const r = new Hono();

  r.get('/held', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'authentication required' }, 401);
    const body = list_held(deps.db, user.id);
    return c.json(body);
  });

  r.post('/held/:id/action', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'authentication required' }, 401);
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'missing id' }, 400);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      return c.json({ error: `invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = ActionBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    const result = apply_held_action({
      db: deps.db,
      user_id: user.id,
      id,
      action: parsed.data.action as HeldAction,
    });
    if (!result.ok) {
      const status = result.error === 'not found' ? 404 : 400;
      return c.json({ error: result.error }, status);
    }
    return c.json({ ok: true });
  });

  // ── Pre-commit countdown lane ──────────────────────────────────────────

  r.get('/precommit/pending', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'authentication required' }, 401);
    const rows = list_pending_precommits(deps.db, user.id);
    // Project to a tight wire shape — drop internal-only fields the
    // iOS Live Activity has no use for (dispatch_tool / dispatch_input
    // are server-side concerns; iOS just renders summary + countdown).
    return c.json({
      pending: rows.map((r) => ({
        id: r.id,
        specialist_id: r.specialist_id,
        summary: r.summary,
        window_seconds: r.window_seconds,
        executes_at: r.executes_at,
        created_at: r.created_at,
      })),
    });
  });

  r.post('/precommit/:id/intercept', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'authentication required' }, 401);
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'missing id' }, 400);
    const result = intercept_precommit(deps.db, deps.events, user.id, id);
    if (!result.ok) {
      const status =
        result.error === 'not found'        ? 404 :
        result.error === 'already resolved' ? 409 :
                                              400;
      return c.json({ error: result.error }, status);
    }
    return c.json({ ok: true });
  });

  return r;
}
