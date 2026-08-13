/**
 * DirectedDispatchStore — the durable journal behind directed deliberations
 * (2026-08-10).
 *
 * A directed build fires fire-and-forget in-process (`fire_deliberation_now`),
 * and every upstream record goes terminal the moment it's dispatched: the
 * proposal is `acknowledged`, the trainer inbox FYI says "do NOT re-file". So
 * when a deploy restarted the orchestrator mid-build, the work died with the
 * process and NOTHING re-fired it — four approved builds were lost invisibly
 * on 2026-08-10 (audit trail: `blank_turn_fallback`/`deliberation_pass` rows
 * around 23:25-23:44Z bracketing the docker restarts).
 *
 * The contract fix: `LoopDriver.fire_deliberation_now` journals every directed
 * task here BEFORE running it and stamps the outcome when it settles. Boot
 * reconciliation (server.ts, next to the auto-deploy /deploy/last check)
 * re-fires rows still unfinished — the restart-survivor path. `attempts` is
 * capped there so a build that somehow kills the process can't crash-loop the
 * boot; at the cap the row is abandoned LOUDLY (inbox flag), never silently.
 */
import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import type { DirectedTask } from '@core/deliberation';

/** Re-fires a journal row gets before reconciliation abandons it (loudly). */
export const MAX_DISPATCH_ATTEMPTS = 3;

export interface DirectedDispatchRow {
  id: string;
  /** Which door fired it: 'decide' | 'court' | 'scrum' | 'fire_deliberation' | 'direct'. */
  source: string;
  proposal_id: string | null;
  specialist_id: string;
  slot: string;
  user_id: string | null;
  /** The full DirectedTask; null when task_json fails to parse (corrupt row). */
  task: DirectedTask | null;
  attempts: number;
  fired_at: string;
  finished_at: string | null;
  /** 'ok' | 'failed' | 'abandoned'; null while unfinished. */
  outcome: string | null;
  error: string | null;
}

interface RawRow {
  id: string;
  source: string;
  proposal_id: string | null;
  specialist_id: string;
  slot: string;
  user_id: string | null;
  task_json: string;
  attempts: number;
  fired_at: string;
  finished_at: string | null;
  outcome: string | null;
  error: string | null;
}

function hydrate(r: RawRow): DirectedDispatchRow {
  let task: DirectedTask | null = null;
  try {
    const parsed = JSON.parse(r.task_json) as DirectedTask;
    if (parsed && typeof parsed.instruction === 'string') task = parsed;
  } catch {
    /* corrupt task_json → task stays null; reconciliation abandons the row */
  }
  return {
    id: r.id,
    source: r.source,
    proposal_id: r.proposal_id,
    specialist_id: r.specialist_id,
    slot: r.slot,
    user_id: r.user_id,
    task,
    attempts: r.attempts,
    fired_at: r.fired_at,
    finished_at: r.finished_at,
    outcome: r.outcome,
    error: r.error,
  };
}

export class DirectedDispatchStore {
  constructor(private db: Database) {}

  /** Journal a dispatch about to fire. Returns the row id (`dd_…`). */
  open(input: {
    source: string;
    specialist_id: string;
    slot: string;
    task: DirectedTask;
    proposal_id?: string;
    user_id?: string;
    now?: Date;
  }): string {
    const id = `dd_${ulid().toLowerCase().slice(-12)}`;
    this.db
      .prepare(
        `INSERT INTO directed_dispatches
           (id, source, proposal_id, specialist_id, slot, user_id, task_json, fired_at)
         VALUES (@id, @source, @proposal, @specialist, @slot, @user, @task, @at)`,
      )
      .run({
        '@id': id,
        '@source': input.source,
        '@proposal': input.proposal_id ?? null,
        '@specialist': input.specialist_id,
        '@slot': input.slot,
        '@user': input.user_id ?? null,
        '@task': JSON.stringify(input.task),
        '@at': (input.now ?? new Date()).toISOString(),
      });
    return id;
  }

  /** Stamp a terminal outcome. Idempotent-safe: only unfinished rows flip. */
  finish(id: string, ok: boolean, error?: string, now?: Date): void {
    this.db
      .prepare(
        `UPDATE directed_dispatches
            SET finished_at = @at, outcome = @outcome, error = @error
          WHERE id = @id AND finished_at IS NULL`,
      )
      .run({
        '@at': (now ?? new Date()).toISOString(),
        '@outcome': ok ? 'ok' : 'failed',
        '@error': ok ? null : (error ?? 'unknown error').slice(0, 2000),
        '@id': id,
      });
  }

  /** Rows dispatched but never finished — the restart casualties. Oldest first. */
  unfinished(): DirectedDispatchRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM directed_dispatches WHERE finished_at IS NULL ORDER BY fired_at ASC`,
        )
        .all() as RawRow[]
    ).map(hydrate);
  }

  /** Count a re-fire against the row (reconciliation reuses the row, so one
   *  logical build stays one row however many boots it takes). */
  bump_attempt(id: string, now?: Date): void {
    this.db
      .prepare(
        `UPDATE directed_dispatches
            SET attempts = attempts + 1, fired_at = @at
          WHERE id = @id`,
      )
      .run({ '@at': (now ?? new Date()).toISOString(), '@id': id });
  }

  /** Terminal give-up at the attempt cap (or a corrupt row) — always paired
   *  with a loud surface (inbox flag) at the call site, never silent. */
  abandon(id: string, reason: string, now?: Date): void {
    this.db
      .prepare(
        `UPDATE directed_dispatches
            SET finished_at = @at, outcome = 'abandoned', error = @error
          WHERE id = @id AND finished_at IS NULL`,
      )
      .run({
        '@at': (now ?? new Date()).toISOString(),
        '@error': reason.slice(0, 2000),
        '@id': id,
      });
  }

  get(id: string): DirectedDispatchRow | null {
    const row = this.db
      .prepare(`SELECT * FROM directed_dispatches WHERE id = @id`)
      .get({ '@id': id }) as RawRow | null;
    return row != null ? hydrate(row) : null;
  }

  recent(limit = 20): DirectedDispatchRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM directed_dispatches ORDER BY fired_at DESC LIMIT @lim`)
        .all({ '@lim': Math.min(Math.max(limit, 1), 200) }) as RawRow[]
    ).map(hydrate);
  }
}
