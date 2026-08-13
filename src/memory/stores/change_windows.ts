/**
 * ChangeWindowStore — every automated change carries a metric baseline
 * (2026-08-01).
 *
 * A change window is opened at the moment an automated change is APPLIED,
 * snapshotting the golden suite's outcomes as they stood. The next eval run
 * scores the window: same task set, before vs after. Without the snapshot there
 * is nothing to compare against later — the baseline has to be captured at
 * apply time or the evidence is simply gone.
 *
 * `baseline_json` is a task_id → passed map rather than a pass RATE, because
 * the arbiter is a per-task delta (see change_measurement.ts): the live suite
 * runs a standing mix of passing and known-failing tasks, so a rate says
 * nothing and a per-task comparison says everything.
 */
import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import type { ChangeKind, ChangeVerdict, TaskOutcomes } from '@core/change_measurement';

export interface ChangeWindowRow {
  id: string;
  kind: ChangeKind;
  /** What changed — an override id, an audit_id, a commit sha. */
  ref: string;
  /** Human-facing target: the role, the specialist, the file. */
  target: string;
  reason: string;
  applied_by: string;
  applied_at: string;
  baseline: TaskOutcomes;
  verdict: ChangeVerdict | null;
  measured_at: string | null;
  delta_summary: string | null;
  /** What was done about a regression: 'reverted' | 'flagged' | null. */
  action_taken: string | null;
}

interface RawRow {
  id: string;
  kind: string;
  ref: string;
  target: string;
  reason: string;
  applied_by: string;
  applied_at: string;
  baseline_json: string;
  verdict: string | null;
  measured_at: string | null;
  delta_summary: string | null;
  action_taken: string | null;
}

function hydrate(r: RawRow): ChangeWindowRow {
  let baseline: TaskOutcomes = new Map();
  try {
    const obj = JSON.parse(r.baseline_json) as Record<string, boolean>;
    baseline = new Map(Object.entries(obj));
  } catch {
    /* a corrupt baseline yields an empty map → the window measures inconclusive */
  }
  return {
    id: r.id,
    kind: r.kind as ChangeKind,
    ref: r.ref,
    target: r.target,
    reason: r.reason,
    applied_by: r.applied_by,
    applied_at: r.applied_at,
    baseline,
    verdict: (r.verdict as ChangeVerdict | null) ?? null,
    measured_at: r.measured_at,
    delta_summary: r.delta_summary,
    action_taken: r.action_taken,
  };
}

export class ChangeWindowStore {
  constructor(private db: Database) {}

  /**
   * The suite's CURRENT outcomes — the latest run per task. This is both the
   * baseline captured at apply time and the "after" read at measure time.
   */
  current_outcomes(): TaskOutcomes {
    const rows = this.db
      .prepare(
        `SELECT task_id, passed FROM eval_runs r
          WHERE ts = (SELECT MAX(ts) FROM eval_runs r2 WHERE r2.task_id = r.task_id)
          GROUP BY task_id`,
      )
      .all() as Array<{ task_id: string; passed: number }>;
    return new Map(rows.map((r) => [r.task_id, r.passed === 1]));
  }

  open(input: {
    kind: ChangeKind;
    ref: string;
    target: string;
    reason: string;
    applied_by: string;
    baseline: TaskOutcomes;
    now?: Date;
  }): string {
    const id = `cw_${ulid().toLowerCase().slice(-12)}`;
    this.db
      .prepare(
        `INSERT INTO change_windows
           (id, kind, ref, target, reason, applied_by, applied_at, baseline_json)
         VALUES (@id, @kind, @ref, @target, @reason, @by, @at, @base)`,
      )
      .run({
        '@id': id,
        '@kind': input.kind,
        '@ref': input.ref,
        '@target': input.target,
        '@reason': input.reason.slice(0, 2000),
        '@by': input.applied_by,
        '@at': (input.now ?? new Date()).toISOString(),
        '@base': JSON.stringify(Object.fromEntries(input.baseline)),
      });
    return id;
  }

  /** Windows not yet scored, oldest first. */
  pending(limit = 20): ChangeWindowRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM change_windows WHERE verdict IS NULL ORDER BY applied_at ASC LIMIT @lim`)
        .all({ '@lim': Math.min(Math.max(limit, 1), 200) }) as RawRow[]
    ).map(hydrate);
  }

  get(id: string): ChangeWindowRow | null {
    const row = this.db.prepare(`SELECT * FROM change_windows WHERE id = @id`).get({ '@id': id }) as RawRow | null;
    return row != null ? hydrate(row) : null;
  }

  record_verdict(input: {
    id: string;
    verdict: ChangeVerdict;
    delta_summary: string;
    action_taken: string;
    now?: Date;
  }): void {
    this.db
      .prepare(
        `UPDATE change_windows
            SET verdict = @v, delta_summary = @s, action_taken = @a, measured_at = @at
          WHERE id = @id`,
      )
      .run({
        '@v': input.verdict,
        '@s': input.delta_summary.slice(0, 2000),
        '@a': input.action_taken,
        '@at': (input.now ?? new Date()).toISOString(),
        '@id': input.id,
      });
  }

  recent(limit = 20): ChangeWindowRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM change_windows ORDER BY applied_at DESC LIMIT @lim`)
        .all({ '@lim': Math.min(Math.max(limit, 1), 200) }) as RawRow[]
    ).map(hydrate);
  }
}
