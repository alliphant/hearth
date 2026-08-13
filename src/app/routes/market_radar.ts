/**
 * GET /api/specialists/:id/market_radar — the Market Radar office tab's
 * data feed (Vivian's fuel office, 2026-06-12).
 *
 * Serves the latest market_radar_snapshots run (written by the
 * refresh_market_radar background job) grouped per theme, a cross-theme
 * spotlight, and the finance-news headlines (news_items in the radar
 * categories — Vivian's daily feed rack rides Cordelia's refresh, same
 * machinery as Kate's News Desk).
 *
 * Generic by capability, not by name: any specialist GRANTED
 * read_market_data serves a radar (a future second finance-adjacent
 * specialist gets the surface for free); everyone else 404s. Owner-only —
 * the radar is part of the finance office, which is captain-only by
 * Vivian's discretion config.
 *
 * Mounted at app.route('/api/specialists', …) — an EXISTING /api
 * namespace, so no nginx alternation change is needed (unlike /api/news).
 */
import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { SpecialistRegistry } from '@core/specialist';
import { MarketRadarStore, type MarketRadarRow } from '@memory/stores/market_radar';

/** news_items categories the radar's headline rail reads, newest first.
 *  Cross-rack by design (the News Desk idiom): `markets`/`ai-business`
 *  are Vivian's feeds; `ai` is Kate's AI vertical riding the same
 *  news_items table. */
export const RADAR_NEWS_CATEGORIES = ['markets', 'ai-business', 'ai'];

/** A run older than this renders with a staleness notice in the tab. */
const STALE_MS = 36 * 60 * 60 * 1000;

export interface MarketRadarRouterDeps {
  db: Database;
  specialists: SpecialistRegistry;
}

interface RadarNewsItem {
  title: string;
  link: string;
  description: string;
  source_domain: string;
  category: string | null;
  published_at: string | null;
  fetched_at: string;
}

/** 50/50 raw-return blend — comparable ACROSS themes, unlike the
 *  within-universe momentum_score. */
function spotlight_blend(r: MarketRadarRow): number {
  return (r.r_1mo_pct ?? -999) * 0.5 + (r.r_3mo_pct ?? -999) * 0.5;
}

/** A comparison run at least this old is preferred for week-over-week. */
const DELTA_MIN_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** Momentum-score jump that counts as "accelerating". */
const ACCEL_MIN = 8;

/** Best (highest momentum) row per symbol across a run's rows. */
function best_by_symbol(rows: MarketRadarRow[]): Map<string, MarketRadarRow> {
  const m = new Map<string, MarketRadarRow>();
  for (const row of rows) {
    const prior = m.get(row.symbol);
    if (!prior || row.momentum_score > prior.momentum_score) m.set(row.symbol, row);
  }
  return m;
}

interface MoverEntry {
  symbol: string;
  name: string;
  theme_label: string;
  momentum_score: number;
  score_delta?: number;
  r_1mo_pct: number | null;
  r_3mo_pct: number | null;
}

function to_mover(r: MarketRadarRow, score_delta?: number): MoverEntry {
  return {
    symbol: r.symbol,
    name: r.name,
    theme_label: r.theme_label || r.theme,
    momentum_score: r.momentum_score,
    ...(score_delta !== undefined ? { score_delta } : {}),
    r_1mo_pct: r.r_1mo_pct,
    r_3mo_pct: r.r_3mo_pct,
  };
}

/**
 * Week-over-week movement of the radar: which names just entered, which
 * accelerated, which dropped out — pure diff of the latest run against a
 * prior comparison run. null when there's no prior run to compare.
 */
function compute_movers(
  store: MarketRadarStore,
  latest: { run_id: string; ts: string; rows: MarketRadarRow[] },
): {
  since: string;
  entered: MoverEntry[];
  accelerating: MoverEntry[];
  dropped: MoverEntry[];
} | null {
  const cmp = store.comparison_run(latest.ts, DELTA_MIN_AGE_MS);
  if (!cmp) return null;
  const prior = best_by_symbol(store.rows_for_run(cmp.run_id));
  const curr = best_by_symbol(latest.rows);

  const entered: MoverEntry[] = [];
  const accelerating: MoverEntry[] = [];
  for (const [sym, row] of curr) {
    const was = prior.get(sym);
    if (!was) {
      entered.push(to_mover(row));
    } else {
      const delta = row.momentum_score - was.momentum_score;
      if (delta >= ACCEL_MIN) accelerating.push(to_mover(row, delta));
    }
  }
  const dropped: MoverEntry[] = [];
  for (const [sym, row] of prior) {
    if (!curr.has(sym)) dropped.push(to_mover(row));
  }

  entered.sort((a, b) => b.momentum_score - a.momentum_score);
  accelerating.sort((a, b) => (b.score_delta ?? 0) - (a.score_delta ?? 0));
  dropped.sort((a, b) => b.momentum_score - a.momentum_score);

  return {
    since: cmp.ts,
    entered: entered.slice(0, 6),
    accelerating: accelerating.slice(0, 6),
    dropped: dropped.slice(0, 6),
  };
}

export function create_market_radar_router(deps: MarketRadarRouterDeps): Hono {
  const r = new Hono();
  const store = new MarketRadarStore(deps.db);

  r.get('/:id/market_radar', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthenticated' }, 401);
    if (user.tier !== 'owner') return c.json({ error: 'owner only' }, 403);
    const id = c.req.param('id');
    const specialist = deps.specialists.get(id);
    if (!specialist || !specialist.granted.has('read_market_data')) {
      return c.json({ error: 'no market radar for this specialist' }, 404);
    }

    const run = store.latest_run();
    const themes: Array<{
      theme: string;
      label: string;
      items: MarketRadarRow[];
    }> = [];
    if (run) {
      const by_theme = new Map<string, { label: string; items: MarketRadarRow[] }>();
      for (const row of run.rows) {
        const slot = by_theme.get(row.theme) ?? {
          label: row.theme_label || row.theme,
          items: [],
        };
        slot.items.push(row);
        by_theme.set(row.theme, slot);
      }
      for (const [theme, slot] of by_theme) {
        themes.push({ theme, label: slot.label, items: slot.items });
      }
      // Trending section last; named themes alphabetical by label.
      themes.sort((a, b) =>
        a.theme === '_trending' ? 1 : b.theme === '_trending' ? -1
          : a.label.localeCompare(b.label),
      );
    }

    // Cross-theme spotlight: dedup by symbol (best blend wins), rank by
    // the raw-return blend, top 8.
    const best = new Map<string, MarketRadarRow>();
    for (const row of run?.rows ?? []) {
      const prior = best.get(row.symbol);
      if (!prior || spotlight_blend(row) > spotlight_blend(prior)) {
        best.set(row.symbol, row);
      }
    }
    const spotlight = [...best.values()]
      .sort((a, b) => spotlight_blend(b) - spotlight_blend(a))
      .slice(0, 8);

    const placeholders = RADAR_NEWS_CATEGORIES.map(() => '?').join(',');
    const news = deps.db
      .prepare(
        `SELECT title, link, description, source_domain, category,
                published_at, fetched_at
         FROM news_items
         WHERE category IN (${placeholders})
         ORDER BY COALESCE(published_at, fetched_at) DESC
         LIMIT 25`,
      )
      .all(...RADAR_NEWS_CATEGORIES) as RadarNewsItem[];

    const movers = run ? compute_movers(store, run) : null;

    const stale =
      !run || Date.now() - new Date(run.ts).getTime() > STALE_MS;
    return c.json({
      generated_at: run?.ts ?? null,
      stale,
      themes,
      spotlight,
      movers,
      news,
      news_categories: RADAR_NEWS_CATEGORIES,
    });
  });

  return r;
}
