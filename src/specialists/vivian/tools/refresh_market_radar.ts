/**
 * refresh_market_radar — Vivian's Market Radar snapshot job (2026-06-12).
 *
 * Runs momentum_screen over EVERY theme in config/market-themes.yaml
 * (plus the trending feed as a pseudo-theme), keeps each theme's top
 * names, and persists one run into market_radar_snapshots — the store
 * behind the fuel office's Market Radar tab and the brief's radar line.
 *
 * Fired as a background job (06:50 + 13:30 in vivian.yaml), and
 * on-demand via POST /api/specialists/vivian/fire_background_job?name=…
 * Per-theme failures are tolerated (collected in `errors`, the run
 * still lands) — a Yahoo hiccup on one universe must not blank the tab.
 *
 * volatile: a refresh must actually re-run when called twice in a turn,
 * never serve the per-turn duplicate-call cache (refresh_subscriptions
 * precedent).
 */
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import {
  momentum_screen,
  load_market_themes,
} from '../../../connectors/market_data';
import { MarketRadarStore, type MarketRadarRowInput } from '@memory/stores/market_radar';

const TRENDING_THEME = '_trending';
const PRUNE_MS = 14 * 24 * 60 * 60 * 1000;

const InputSchema = z.object({
  per_theme: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(3)
    .describe('Top names kept per theme.'),
  include_trending: z
    .boolean()
    .default(true)
    .describe('Also screen the live trending-ticker feed as its own section.'),
});

const OutputSchema = z.object({
  run_id: z.string().nullable(),
  themes_screened: z.number(),
  rows_inserted: z.number(),
  symbols_skipped: z.number(),
  pruned_rows: z.number(),
  errors: z.array(z.object({ theme: z.string(), error: z.string() })),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_refresh_market_radar(db: Database): Tool<Input, Output> {
  return {
    name: 'refresh_market_radar',
    description:
      'Refresh the Market Radar snapshot: screen every theme in config/market-themes.yaml (plus the trending feed) with momentum_screen and persist the top names per theme for the office tab and briefs. Background-job workhorse; call it manually only when the snapshot is stale and someone is asking about the radar right now.',
    risk: 'write_internal',
    required_capabilities: ['write_market_radar'],
    volatile: true,
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `refresh_market_radar:${input.per_theme}:${input.include_trending}`;
    },

    async execute(input: Input, ctx: ToolContext): Promise<Output> {
      const loaded = await load_market_themes();
      if ('error' in loaded) {
        return {
          run_id: null,
          themes_screened: 0,
          rows_inserted: 0,
          symbols_skipped: 0,
          pruned_rows: 0,
          errors: [{ theme: '*', error: loaded.error }],
        };
      }
      const rows: MarketRadarRowInput[] = [];
      const errors: Output['errors'] = [];
      let skipped = 0;
      let themes_screened = 0;

      const screen_one = async (
        theme_id: string,
        theme_label: string,
        screen_input: Parameters<typeof momentum_screen.execute>[0],
      ) => {
        try {
          const out = await momentum_screen.execute(screen_input, ctx);
          if (out.error) {
            errors.push({ theme: theme_id, error: out.error });
            return;
          }
          themes_screened++;
          skipped += out.skipped.length;
          for (const r of out.ranked) {
            rows.push({
              theme: theme_id,
              theme_label,
              symbol: r.symbol,
              name: r.name,
              price: r.price,
              momentum_score: r.momentum_score,
              r_1mo_pct: r.r_1mo_pct,
              r_3mo_pct: r.r_3mo_pct,
              pct_off_52w_high: r.pct_off_52w_high,
              volume_surge: r.volume_surge,
              rsi_14: r.rsi_14,
              annualized_volatility_pct: r.annualized_volatility_pct,
              max_drawdown_3mo_pct: r.max_drawdown_3mo_pct,
            });
          }
        } catch (err) {
          errors.push({ theme: theme_id, error: (err as Error).message });
        }
      };

      for (const [id, t] of Object.entries(loaded.themes)) {
        await screen_one(id, t.label, {
          theme: id,
          include_trending: false,
          top_n: input.per_theme,
        });
      }
      if (input.include_trending) {
        await screen_one(TRENDING_THEME, 'Trending now', {
          include_trending: true,
          top_n: input.per_theme,
        });
      }

      const store = new MarketRadarStore(db);
      const now_iso = ctx.now.toISOString();
      let run_id: string | null = null;
      let inserted = 0;
      if (rows.length > 0) {
        const res = store.insert_run(rows, now_iso);
        run_id = res.run_id;
        inserted = res.inserted;
      }
      const pruned = store.prune_older_than(
        new Date(ctx.now.getTime() - PRUNE_MS).toISOString(),
      );
      return {
        run_id,
        themes_screened,
        rows_inserted: inserted,
        symbols_skipped: skipped,
        pruned_rows: pruned,
        errors,
      };
    },
  };
}
