/**
 * GuardCounterStore — durable telemetry for gate rejections (2026-08-11).
 *
 * The 2026-08-10/11 directed-build postmortem found three guards silently
 * eating approved work: change_pipeline's deterministic checks (a red tsc/guard
 * run refuses the PR), the change-record dedup supersession (PR #269 wrongly
 * retired PR #268 — sibling changes for one proposal shared a dedup key), and
 * the tool-round ceiling (three builds died at exactly their chat-sized caps).
 * Each rejection lived only as a per-row audit entry, so a guard REPEATEDLY
 * blocking work was invisible until a human tripped over the wreckage.
 *
 * This table is the reviewable signal: every gate rejection increments one
 * (guard, scope) counter, and Mariah's `scan_program_health` sweep reads it —
 * a counter that keeps climbing becomes a process miss (→ her ledger → a
 * proposal) without anyone spelunking audit_log. Counters are telemetry, not
 * lifecycle: nothing ever decrements or resets; the sweep windows on `last_at`.
 *
 * Writes are FAIL-OPEN at every call site — a telemetry error must never break
 * the guard (or the turn) it observes.
 */
import { Database } from 'bun:sqlite';

/** Canonical guard names. String-typed on the table so a future guard can
 *  count itself without a migration; these constants keep call sites and the
 *  Mariah sweep spelling them identically. */
export const GUARD_CHANGE_CHECKS_FAILED = 'change_checks_failed';
export const GUARD_CHANGE_DEDUP_SUPERSESSION = 'change_dedup_supersession';
export const GUARD_ROUND_CEILING_EXHAUST = 'round_ceiling_exhaust';
export const GUARD_DIRECTED_DUP_FAILURE_CUT = 'directed_dup_failure_cut';

export interface GuardCounterRow {
  guard: string;
  /** Discriminator within the guard: a specialist id, a dedup_key, a branch
   *  base — whatever identifies the repeatedly-blocked subject. */
  scope: string;
  count: number;
  first_at: string;
  last_at: string;
  /** Short human-readable context from the most recent hit. */
  last_detail: string | null;
}

export class GuardCounterStore {
  constructor(private db: Database) {}

  /** Bump (guard, scope) by one. UPSERT so the first hit creates the row. */
  increment(guard: string, scope: string, detail?: string, now?: Date): void {
    const at = (now ?? new Date()).toISOString();
    this.db
      .prepare(
        `INSERT INTO guard_counters (guard, scope, count, first_at, last_at, last_detail)
         VALUES (@guard, @scope, 1, @at, @at, @detail)
         ON CONFLICT (guard, scope) DO UPDATE SET
           count = count + 1,
           last_at = @at,
           last_detail = COALESCE(@detail, last_detail)`,
      )
      .run({
        '@guard': guard,
        '@scope': scope.slice(0, 200),
        '@at': at,
        '@detail': detail ? detail.slice(0, 500) : null,
      });
  }

  get(guard: string, scope: string): GuardCounterRow | null {
    const row = this.db
      .prepare(`SELECT * FROM guard_counters WHERE guard = @guard AND scope = @scope`)
      .get({ '@guard': guard, '@scope': scope.slice(0, 200) }) as GuardCounterRow | undefined;
    return row ?? null;
  }

  /** Counters at/above `min_count` whose LAST hit is inside the window —
   *  the shape Mariah's recurrence sweep asks for. */
  list(opts: { guard?: string; min_count?: number; since_hours?: number; limit?: number } = {}): GuardCounterRow[] {
    const params: Record<string, string | number> = {
      '@min': opts.min_count ?? 1,
      '@lim': Math.min(Math.max(opts.limit ?? 100, 1), 500),
    };
    let clause = `WHERE count >= @min`;
    if (opts.guard) {
      clause += ` AND guard = @guard`;
      params['@guard'] = opts.guard;
    }
    if (opts.since_hours) {
      clause += ` AND last_at >= @cut`;
      params['@cut'] = new Date(Date.now() - opts.since_hours * 3600_000).toISOString();
    }
    return this.db
      .prepare(`SELECT * FROM guard_counters ${clause} ORDER BY count DESC, last_at DESC LIMIT @lim`)
      .all(params) as GuardCounterRow[];
  }
}

/**
 * Fail-open increment for call sites inside guards. A telemetry write must
 * never break the code path it observes, so every guard increments through
 * this instead of calling the store directly.
 */
export function bump_guard_counter(
  db: Database | undefined,
  guard: string,
  scope: string,
  detail?: string,
): void {
  if (!db) return;
  try {
    new GuardCounterStore(db).increment(guard, scope, detail);
  } catch (err) {
    console.error(`[guard-counters] increment failed for ${guard}:${scope}:`, err);
  }
}
