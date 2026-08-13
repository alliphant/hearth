/**
 * Briefs HTTP routes (Prompt 6c).
 *
 *   GET  /api/briefs            list briefs (filterable by kind)
 *   GET  /api/briefs/latest     latest brief (any kind, or filter by kind)
 *   GET  /api/briefs/:id        one brief
 *   POST /api/briefs/:id/consumed   mark consumed_at=now
 *
 * 2026-05-27 — per-user briefs land. Every route filters by the
 * caller's `user_id` (from the session, never the URL) so each
 * household member sees their own brief. The legacy
 * `tier === 'owner'` gate is gone — both owner and household tiers
 * now have first-class briefs. The schema migration in
 * `structured.ts` backfilled pre-2026-05-27 rows to the owner id,
 * so historical briefs stay queryable for jasper and only jasper.
 * Per-row tier-based discretion (Vivian's finance, Cassandra's
 * security content showing up in a non-allowed user's brief)
 * remains a follow-up: today the brief generator pulls Kate's full
 * inbox; allowed_specialists-aware content filtering ships when
 * the prompt grows a user-tier discriminator.
 */

import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { PendingQuestionsStore } from '@memory/stores/pending_questions';

export interface BriefsRouterDeps {
  db: Database;
}

interface BriefRow {
  id: string;
  ts_generated: string;
  generated_by_specialist_id: string;
  kind: string;
  sections_json: string;
  mood: string;
  consumed_at: string | null;
  user_id: string | null;
}

function row_to_brief(r: BriefRow) {
  return {
    id: r.id,
    ts_generated: r.ts_generated,
    generated_by_specialist_id: r.generated_by_specialist_id,
    kind: r.kind,
    sections: (() => {
      try {
        return JSON.parse(r.sections_json);
      } catch {
        return null;
      }
    })(),
    mood: r.mood,
    consumed_at: r.consumed_at,
    user_id: r.user_id,
  };
}

export function create_briefs_router(deps: BriefsRouterDeps): Hono {
  const r = new Hono();
  const pending_questions = new PendingQuestionsStore(deps.db);

  function attach_question_sets<T extends { id: string }>(brief: T): T & {
    pending_question_sets: ReturnType<PendingQuestionsStore['list_for_brief']>;
  } {
    return {
      ...brief,
      pending_question_sets: pending_questions.list_for_brief(brief.id),
    };
  }

  r.get('/', (c) => {
    const uid = c.get('user').id;
    const kind = c.req.query('kind') ?? undefined;
    const limit_raw = c.req.query('limit');
    const limit = limit_raw ? Math.max(1, Math.min(50, parseInt(limit_raw, 10) || 10)) : 10;
    const rows = kind
      ? (deps.db
          .prepare(
            `SELECT * FROM briefs
              WHERE kind = @k AND user_id = @uid
              ORDER BY ts_generated DESC LIMIT @lim`,
          )
          .all({ '@k': kind, '@uid': uid, '@lim': limit }) as BriefRow[])
      : (deps.db
          .prepare(
            `SELECT * FROM briefs
              WHERE user_id = @uid
              ORDER BY ts_generated DESC LIMIT @lim`,
          )
          .all({ '@uid': uid, '@lim': limit }) as BriefRow[]);
    return c.json({ briefs: rows.map((b) => attach_question_sets(row_to_brief(b))) });
  });

  r.get('/latest', (c) => {
    const uid = c.get('user').id;
    const kind = c.req.query('kind') ?? undefined;
    // ?include_consumed=1 returns the absolute latest brief regardless
    // of consumed status. Default (omitted or 0) returns the latest
    // UNCONSUMED brief — so "Mark read" actually clears the right rail
    // and a stale stale brief from this morning stops shadowing the
    // empty post-consumption state. The UI relies on this default.
    const include_consumed =
      c.req.query('include_consumed') === '1' ||
      c.req.query('include_consumed') === 'true';
    const consumed_clause = include_consumed ? '' : 'AND consumed_at IS NULL';
    const sql = kind
      ? `SELECT * FROM briefs WHERE user_id = @uid AND kind = @k ${consumed_clause} ORDER BY ts_generated DESC LIMIT 1`
      : `SELECT * FROM briefs WHERE user_id = @uid ${consumed_clause} ORDER BY ts_generated DESC LIMIT 1`;
    const row = (kind
      ? deps.db.prepare(sql).get({ '@uid': uid, '@k': kind })
      : deps.db.prepare(sql).get({ '@uid': uid })) as BriefRow | undefined;
    if (!row) return c.json({ brief: null });
    return c.json({ brief: attach_question_sets(row_to_brief(row)) });
  });

  r.get('/:id', (c) => {
    const uid = c.get('user').id;
    const id = c.req.param('id');
    // user_id in the WHERE means a brief belonging to another user
    // returns 404 (not 403) — don't leak that the id exists.
    const row = deps.db
      .prepare(`SELECT * FROM briefs WHERE id = @id AND user_id = @uid`)
      .get({ '@id': id, '@uid': uid }) as BriefRow | undefined;
    if (!row) return c.json({ error: 'brief not found' }, 404);
    return c.json({ brief: attach_question_sets(row_to_brief(row)) });
  });

  r.post('/:id/consumed', (c) => {
    const uid = c.get('user').id;
    const id = c.req.param('id');
    const ts = new Date().toISOString();
    const res = deps.db
      .prepare(
        `UPDATE briefs SET consumed_at = COALESCE(consumed_at, @ts)
          WHERE id = @id AND user_id = @uid`,
      )
      .run({ '@id': id, '@ts': ts, '@uid': uid });
    if (res.changes === 0) return c.json({ error: 'brief not found' }, 404);
    return c.json({ id, consumed_at: ts });
  });

  return r;
}
