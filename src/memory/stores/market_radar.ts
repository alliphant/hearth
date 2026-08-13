/**
 * MarketRadarStore — momentum snapshots behind Vivian's Market Radar
 * office tab (2026-06-12).
 *
 * Written by her refresh_market_radar background job (one "run" per
 * firing, rows per theme×symbol from momentum_screen); read by the
 * GET /api/specialists/:id/market_radar route. History is kept so a
 * future pass can render week-over-week deltas; the job prunes runs
 * older than ~14 days.
 */
import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';

export interface MarketRadarRowInput {
  theme: string;
  theme_label: string;
  symbol: string;
  name: string;
  price: number;
  momentum_score: number;
  r_1mo_pct: number | null;
  r_3mo_pct: number | null;
  pct_off_52w_high: number | null;
  volume_surge: number | null;
  rsi_14: number | null;
  annualized_volatility_pct: number | null;
  max_drawdown_3mo_pct: number | null;
}

export interface MarketRadarRow extends MarketRadarRowInput {
  id: string;
  run_id: string;
  ts: string;
}

export class MarketRadarStore {
  constructor(private db: Database) {}

  /** Insert one refresh run; all rows share a run_id + timestamp. */
  insert_run(
    rows: MarketRadarRowInput[],
    now_iso: string,
  ): { run_id: string; inserted: number } {
    const run_id = `mr_${ulid().toLowerCase()}`;
    const stmt = this.db.prepare(
      `INSERT INTO market_radar_snapshots
         (id, run_id, ts, theme, theme_label, symbol, name, price,
          momentum_score, r_1mo_pct, r_3mo_pct, pct_off_52w_high,
          volume_surge, rsi_14, annualized_volatility_pct, max_drawdown_3mo_pct)
       VALUES
         (@id, @run_id, @ts, @theme, @theme_label, @symbol, @name, @price,
          @momentum_score, @r_1mo_pct, @r_3mo_pct, @pct_off_52w_high,
          @volume_surge, @rsi_14, @annualized_volatility_pct, @max_drawdown_3mo_pct)`,
    );
    let inserted = 0;
    for (const r of rows) {
      stmt.run({
        '@id': ulid().toLowerCase(),
        '@run_id': run_id,
        '@ts': now_iso,
        '@theme': r.theme,
        '@theme_label': r.theme_label,
        '@symbol': r.symbol.toUpperCase(),
        '@name': r.name,
        '@price': r.price,
        '@momentum_score': r.momentum_score,
        '@r_1mo_pct': r.r_1mo_pct,
        '@r_3mo_pct': r.r_3mo_pct,
        '@pct_off_52w_high': r.pct_off_52w_high,
        '@volume_surge': r.volume_surge,
        '@rsi_14': r.rsi_14,
        '@annualized_volatility_pct': r.annualized_volatility_pct,
        '@max_drawdown_3mo_pct': r.max_drawdown_3mo_pct,
      });
      inserted++;
    }
    return { run_id, inserted };
  }

  /** Distinct run heads, newest first. For delta/comparison selection. */
  run_heads(limit = 60): Array<{ run_id: string; ts: string }> {
    return this.db
      .prepare(
        `SELECT run_id, MIN(ts) AS ts FROM market_radar_snapshots
         GROUP BY run_id
         ORDER BY ts DESC, run_id DESC
         LIMIT @limit`,
      )
      .all({ '@limit': limit }) as Array<{ run_id: string; ts: string }>;
  }

  /** All rows of one run, theme-grouped / score-desc. */
  rows_for_run(run_id: string): MarketRadarRow[] {
    return this.db
      .prepare(
        `SELECT * FROM market_radar_snapshots
         WHERE run_id = @run_id
         ORDER BY theme ASC, momentum_score DESC, symbol ASC`,
      )
      .all({ '@run_id': run_id }) as MarketRadarRow[];
  }

  /** The newest run's rows (theme-grouped ordering left to the caller). */
  latest_run(): { run_id: string; ts: string; rows: MarketRadarRow[] } | null {
    const head = this.run_heads(1)[0];
    if (!head) return null;
    return { run_id: head.run_id, ts: head.ts, rows: this.rows_for_run(head.run_id) };
  }

  /**
   * The run best suited as a "last week" comparison for `latest_ts`: the
   * newest run at least `min_age_ms` older; failing that (shallow history),
   * the oldest run strictly older than latest. null when there's only one
   * run. Pure selection over run_heads so the route can diff in memory.
   */
  comparison_run(latest_ts: string, min_age_ms: number): { run_id: string; ts: string } | null {
    const heads = this.run_heads(60).filter((h) => h.ts < latest_ts);
    if (heads.length === 0) return null;
    const cutoff = new Date(Date.parse(latest_ts) - min_age_ms).toISOString();
    const aged = heads.find((h) => h.ts <= cutoff);
    return aged ?? heads[heads.length - 1] ?? null;
  }

  /** Drop runs older than the cutoff; returns rows deleted. */
  prune_older_than(cutoff_iso: string): number {
    const res = this.db
      .prepare(`DELETE FROM market_radar_snapshots WHERE ts < @cutoff`)
      .run({ '@cutoff': cutoff_iso });
    return Number(res.changes ?? 0);
  }
}
