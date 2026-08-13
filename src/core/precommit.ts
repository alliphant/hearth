/**
 * Pre-commit action lane (BACKEND_FILTER_BRIEF.md, Phase 3 minimum).
 *
 * A specialist declares an action they're about to take — "Vivian will
 * pay PSE&G $48.12" — with a configurable intercept window (default
 * 60s). The action is queued in `kate_filter_queue` with disposition
 * `precommit_pending`, an `executes_at` timestamp, and the dispatch
 * coordinates needed to fire it (matches the existing `schedule_calendar_event`
 * `dispatch_tool` / `dispatch_input` pattern).
 *
 * Lifecycle:
 *   1. specialist → `create_precommit(...)` → queue row with
 *      precommit_window_seconds + precommit_executes_at
 *   2. backend emits `precommit_proposed` AppEvent; iOS starts the Live
 *      Activity countdown
 *   3. either:
 *        a. user taps "Stop" → POST /api/kate/precommit/:id/intercept
 *           → row marked outcome='re_elevated' (effectively cancelled).
 *           Backend emits `precommit_intercepted`.
 *        b. window expires → scheduler tick marks outcome='executed'
 *           and (when the dispatch hook lands) invokes dispatch_tool.
 *           Backend emits `precommit_executed`.
 *
 * v0.1 ships the rails but **does not invoke dispatch_tool on expiry**.
 * No specialist currently creates pre-commits, so there's no real action
 * to dispatch yet. When the first specialist tool that uses this lane
 * lands (Vivian auto-pay is the canonical use case), the dispatch
 * invocation gets wired through the existing `tool_registry`. Keeping
 * dispatch deferred is deliberate — auto-execute is a trust-touching
 * feature that deserves its own deliberate add.
 */

import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { AppEventBus } from '../app/events';

export interface CreatePrecommitInput {
  user_id: string;
  specialist_id: string;
  /** User-facing one-line description rendered on the Live Activity.
   *  e.g. "Pay PSE&G bill, $48.12" or "Auto-confirm Brigid's reservation." */
  summary: string;
  /** Seconds until the action auto-executes if not intercepted. */
  window_seconds: number;
  /** Tool name to dispatch on expiry (e.g. 'media_add').
   *  v0.1 stores it for future use; the scheduler doesn't invoke it yet. */
  dispatch_tool?: string;
  /** Input bag for the dispatched tool. Persisted in payload_json. */
  dispatch_input?: Record<string, unknown>;
}

export interface PrecommitRow {
  id: string;
  user_id: string;
  specialist_id: string;
  summary: string;
  window_seconds: number;
  executes_at: string;
  created_at: string;
  outcome: string | null;
  dispatch_tool: string | null;
  dispatch_input: Record<string, unknown> | null;
}

export function create_precommit(
  db: Database,
  events: AppEventBus,
  input: CreatePrecommitInput,
): { id: string; executes_at: string } {
  if (input.window_seconds < 5 || input.window_seconds > 600) {
    throw new Error(
      `precommit window_seconds must be between 5 and 600 (got ${input.window_seconds})`,
    );
  }
  const id = ulid();
  const now = new Date();
  const executes_at = new Date(now.getTime() + input.window_seconds * 1000);
  const created_at = now.toISOString();
  const executes_at_iso = executes_at.toISOString();

  const payload = {
    summary: input.summary,
    dispatch_tool: input.dispatch_tool ?? null,
    dispatch_input: input.dispatch_input ?? null,
  };

  db.prepare(
    `INSERT INTO kate_filter_queue
       (id, user_id, specialist_id, kind, category, payload_json,
        created_at, urgency_score, disposition, disposition_reason,
        precommit_window_seconds, precommit_executes_at)
     VALUES (@id, @u, @sid, 'action_proposal', 'decision', @pl,
             @ts, 0.8, 'precommit_pending', @reason,
             @ws, @execs_at)`,
  ).run({
    '@id': id,
    '@u': input.user_id,
    '@sid': input.specialist_id,
    '@pl': JSON.stringify(payload),
    '@ts': created_at,
    '@reason': `${input.specialist_id} will act in ${input.window_seconds}s — tap to stop.`,
    '@ws': input.window_seconds,
    '@execs_at': executes_at_iso,
  });

  events.emit({
    type: 'precommit_proposed',
    id,
    specialist_id: input.specialist_id,
    summary: input.summary,
    window_seconds: input.window_seconds,
    executes_at: executes_at_iso,
  });

  return { id, executes_at: executes_at_iso };
}

// ── Reads + intercept ────────────────────────────────────────────────────

export function list_pending_precommits(
  db: Database,
  user_id: string,
): PrecommitRow[] {
  const rows = db.prepare(
    `SELECT id, user_id, specialist_id, payload_json, created_at,
            precommit_window_seconds, precommit_executes_at, outcome
     FROM kate_filter_queue
     WHERE user_id = @u
       AND disposition = 'precommit_pending'
       AND outcome IS NULL
     ORDER BY precommit_executes_at ASC
     LIMIT 50`,
  ).all({ '@u': user_id }) as Array<{
    id: string;
    user_id: string;
    specialist_id: string;
    payload_json: string;
    created_at: string;
    precommit_window_seconds: number;
    precommit_executes_at: string;
    outcome: string | null;
  }>;

  return rows.map((r) => {
    let parsed: { summary?: string; dispatch_tool?: string | null; dispatch_input?: Record<string, unknown> | null } = {};
    try { parsed = JSON.parse(r.payload_json); } catch { /* fall through */ }
    return {
      id: r.id,
      user_id: r.user_id,
      specialist_id: r.specialist_id,
      summary: parsed.summary ?? '',
      window_seconds: r.precommit_window_seconds,
      executes_at: r.precommit_executes_at,
      created_at: r.created_at,
      outcome: r.outcome,
      dispatch_tool: parsed.dispatch_tool ?? null,
      dispatch_input: parsed.dispatch_input ?? null,
    };
  });
}

export function intercept_precommit(
  db: Database,
  events: AppEventBus,
  user_id: string,
  id: string,
): { ok: boolean; error?: string } {
  const row = db.prepare(
    `SELECT user_id, outcome, disposition FROM kate_filter_queue WHERE id = @id`,
  ).get({ '@id': id }) as { user_id: string; outcome: string | null; disposition: string } | undefined;

  if (!row) return { ok: false, error: 'not found' };
  if (row.user_id !== user_id) return { ok: false, error: 'not yours' };
  if (row.disposition !== 'precommit_pending') {
    return { ok: false, error: 'not a pending precommit' };
  }
  if (row.outcome !== null) return { ok: false, error: 'already resolved' };

  const now_iso = new Date().toISOString();
  db.prepare(
    `UPDATE kate_filter_queue
     SET outcome = 're_elevated',
         engaged_at = @ts,
         disposition = 'deliver_now'
     WHERE id = @id`,
  ).run({ '@id': id, '@ts': now_iso });

  events.emit({
    type: 'precommit_intercepted',
    id,
  });
  return { ok: true };
}

// ── Scheduler ────────────────────────────────────────────────────────────
// Polls the queue every PRECOMMIT_TICK_MS for pending pre-commits whose
// executes_at < now. Marks them outcome='executed' and fires the
// `precommit_executed` event. v0.1 does NOT invoke the dispatch_tool —
// that lands when a real specialist tool builds against the lane. Until
// then the scheduler just resolves the row + emits the event so iOS can
// terminate the Live Activity.
//
// Started by the orchestrator at boot; cleanly stopped via the returned
// disposer (used by smokes that need deterministic teardown).

const PRECOMMIT_TICK_MS = 5_000;

export function start_precommit_scheduler(
  db: Database,
  events: AppEventBus,
): () => void {
  const tick = () => {
    const now_iso = new Date().toISOString();
    let rows: Array<{ id: string; user_id: string }> = [];
    try {
      rows = db.prepare(
        `SELECT id, user_id FROM kate_filter_queue
         WHERE disposition = 'precommit_pending'
           AND outcome IS NULL
           AND precommit_executes_at <= @now
         LIMIT 25`,
      ).all({ '@now': now_iso }) as Array<{ id: string; user_id: string }>;
    } catch (err) {
      console.warn(`[precommit-scheduler] tick query failed: ${(err as Error).message}`);
      return;
    }
    for (const r of rows) {
      try {
        db.prepare(
          `UPDATE kate_filter_queue
           SET outcome = 'executed',
               engaged_at = @ts
           WHERE id = @id AND outcome IS NULL`,
        ).run({ '@id': r.id, '@ts': now_iso });
        events.emit({ type: 'precommit_executed', id: r.id });
      } catch (err) {
        console.warn(`[precommit-scheduler] resolve ${r.id} failed: ${(err as Error).message}`);
      }
    }
  };

  const handle = setInterval(tick, PRECOMMIT_TICK_MS);
  // First tick on the next macro-task so the orchestrator boot doesn't
  // block on a long sweep if there's a backlog.
  setTimeout(tick, 100);
  return () => clearInterval(handle);
}
