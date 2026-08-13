/**
 * CapabilityDemandStore — the ledger of tool-surface MISSES (2026-07-14).
 *
 * One row per moment a specialist reached for a tool it could not use:
 *   - 'forbidden'    — called a real tool whose required capability it lacks
 *   - 'unknown_tool' — called a tool name that exists nowhere (the model
 *                      WANTED an ability the system doesn't have — the
 *                      strongest capability-gap signal of the three)
 *   - 'load_miss'    — asked `load_tools` for a name outside its granted
 *                      catalog
 *
 * This is the tool-capability sibling of knowledge_demand (which mines
 * unmet KNOWLEDGE demand): recurring rows are the evidence Kate reads via
 * `read_capability_demand` to decide what to commission through
 * `file_build_request` — real, live demand instead of the mined-cluster
 * signal that got drive_roster_gaps disabled (2026-06-20).
 *
 * Content-free BY DESIGN: no user message text is stored, only which tool
 * / capability was wanted, by whom, on which surface, how often. That
 * keeps the ledger cordon-safe (nothing a per-user cordon protects can
 * leak through it) and the write path cheap enough to sit on the tool
 * dispatch hot path. Writes are best-effort at the call sites — a ledger
 * failure must never break a turn.
 */
import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';

export type DemandKind = 'forbidden' | 'unknown_tool' | 'load_miss';

export interface DemandRecord {
  specialist_id: string;
  kind: DemandKind;
  tool_name: string;
  missing_capability?: string | null;
  /** Turn surface the miss happened on ('chat' | 'deliberation' | …). */
  surface?: string | null;
}

/** One aggregated gap — a (specialist, tool, kind) cluster with its recurrence. */
export interface DemandSummaryRow {
  specialist_id: string;
  kind: DemandKind;
  tool_name: string;
  missing_capability: string | null;
  hits: number;
  first_seen: string;
  last_seen: string;
}

export class CapabilityDemandStore {
  constructor(private db: Database) {}

  record(input: DemandRecord): void {
    this.db
      .prepare(
        `INSERT INTO capability_demand (id, ts, specialist_id, kind, tool_name, missing_capability, surface)
         VALUES (@id, @ts, @spec, @kind, @tool, @cap, @surface)`,
      )
      .run({
        '@id': `cdem_${ulid().toLowerCase().slice(-16)}`,
        '@ts': new Date().toISOString(),
        '@spec': input.specialist_id,
        '@kind': input.kind,
        '@tool': input.tool_name.slice(0, 120),
        '@cap': input.missing_capability ?? null,
        '@surface': input.surface ?? null,
      });
  }

  /**
   * The gap report: misses in the window, clustered by (specialist, tool,
   * kind), most-recurrent first. `days` bounds the window (ISO string
   * compare — the ts column is ISO-8601 TEXT, so lexicographic IS
   * chronological).
   */
  summarize(opts: { days?: number; limit?: number } = {}): DemandSummaryRow[] {
    const days = Math.min(Math.max(opts.days ?? 14, 1), 90);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.db
      .prepare(
        `SELECT specialist_id, kind, tool_name,
                MAX(missing_capability) AS missing_capability,
                COUNT(*) AS hits,
                MIN(ts) AS first_seen,
                MAX(ts) AS last_seen
           FROM capability_demand
          WHERE ts >= @since
          GROUP BY specialist_id, kind, tool_name
          ORDER BY hits DESC, last_seen DESC
          LIMIT @lim`,
      )
      .all({ '@since': since, '@lim': Math.min(Math.max(opts.limit ?? 30, 1), 200) }) as DemandSummaryRow[];
  }
}
