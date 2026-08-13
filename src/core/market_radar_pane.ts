/**
 * market_radar_pane — the "Market Radar" TAB for Vivian's fuel office
 * (2026-06-16), the server-block sibling of the web's interactive radar
 * canvas (GET /api/specialists/:id/market_radar, app.js render_market_radar_view).
 *
 * Vivian's office is TABBED via the server `tabs` primitive (the Kate News
 * Desk / Cordelia Brain pattern): tab 1 is Finances (her receipts + holdings
 * blocks), tab 2 is this Market Radar — a SERVER-composed summary of the
 * latest theme-momentum run so it renders on iOS/macOS natively (PaneTabsView).
 * The WEB office UNWRAPS the primitive and shows its richer themed-grid canvas
 * (see app.js render_pane's fuel branch).
 *
 * Light + self-contained — reads the latest market_radar_snapshots run via
 * MarketRadarStore (the same store the route reads) and builds a cross-theme
 * spotlight + per-theme breakdown. No external HTTP at view time (the data was
 * fetched by the refresh_market_radar background job). OWNER-ONLY (the radar is
 * part of the finance office); the caller gates on viewer_is_owner.
 */
import type { Database } from 'bun:sqlite';
import { MarketRadarStore, type MarketRadarRow } from '@memory/stores/market_radar';
import type { PaneBlock } from './specialist_pane';
import { format_short_datetime } from './time';

export interface MarketRadarTab {
  id: string;
  label: string;
  badge?: number;
  blocks: PaneBlock[];
}

const STALE_MS = 36 * 60 * 60 * 1000;

/** 50/50 raw-return blend — comparable ACROSS themes (mirrors the route). */
function blend(r: MarketRadarRow): number {
  return (r.r_1mo_pct ?? -999) * 0.5 + (r.r_3mo_pct ?? -999) * 0.5;
}

function pct(v: number | null): string {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function returns_sub(r: MarketRadarRow): string {
  return `${r.theme_label || r.theme} · ${pct(r.r_1mo_pct)} 1mo, ${pct(r.r_3mo_pct)} 3mo`;
}

/**
 * Compose the Market Radar tab from the latest snapshot run, or null when
 * no run exists yet (→ the fuel pane stays flat, byte-identical to pre-Radar).
 */
export function compose_market_radar_tab(db: Database): MarketRadarTab | null {
  const run = new MarketRadarStore(db).latest_run();
  if (!run || run.rows.length === 0) return null;

  const stale = Date.now() - new Date(run.ts).getTime() > STALE_MS;

  // Cross-theme spotlight — dedup by symbol (best blend wins), top 8.
  const best = new Map<string, MarketRadarRow>();
  for (const row of run.rows) {
    const prior = best.get(row.symbol);
    if (!prior || blend(row) > blend(prior)) best.set(row.symbol, row);
  }
  const spotlight = [...best.values()].sort((a, b) => blend(b) - blend(a)).slice(0, 8);

  // Per-theme groups (trending last, else alpha by label).
  const by_theme = new Map<string, { label: string; items: MarketRadarRow[] }>();
  for (const row of run.rows) {
    const slot = by_theme.get(row.theme) ?? { label: row.theme_label || row.theme, items: [] };
    slot.items.push(row);
    by_theme.set(row.theme, slot);
  }
  const themes = [...by_theme.entries()]
    .map(([theme, slot]) => ({ theme, label: slot.label, items: slot.items }))
    .sort((a, b) =>
      a.theme === '_trending' ? 1 : b.theme === '_trending' ? -1 : a.label.localeCompare(b.label),
    );

  const blocks: PaneBlock[] = [];

  // 1. Hero — the breadth of the run.
  blocks.push({
    type: 'hero_metric',
    value: String(best.size),
    label: `names tracked across ${themes.length} ${themes.length === 1 ? 'theme' : 'themes'}`,
    delta_kind: stale ? 'neutral' : 'up_good',
  });

  // 2. As-of / staleness.
  blocks.push({
    type: 'text',
    body_md: stale
      ? `*Last refreshed ${format_short_datetime(run.ts)} — data may be stale.*`
      : `*as of ${format_short_datetime(run.ts)}*`,
  });

  // 3. Spotlight — strongest momentum across all themes.
  blocks.push({
    type: 'list',
    title: 'Spotlight',
    items: spotlight.map((r) => ({
      title: `${r.symbol} · ${r.name}`,
      subtitle: returns_sub(r),
    })),
  });

  // 4. By theme — top 3 by momentum per theme, capped at 4 themes so the tab
  //    stays a glance, not the full grid (that's the web canvas).
  for (const t of themes.slice(0, 4)) {
    const top = [...t.items].sort((a, b) => b.momentum_score - a.momentum_score).slice(0, 3);
    blocks.push({
      type: 'list',
      title: t.label,
      items: top.map((r) => ({
        title: `${r.symbol} · ${r.name}`,
        subtitle: `momentum ${r.momentum_score.toFixed(0)} · ${pct(r.r_1mo_pct)} 1mo`,
      })),
    });
  }

  return { id: 'radar', label: 'Market Radar', blocks };
}
