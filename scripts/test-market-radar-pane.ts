/**
 * smoke:market-radar-pane — self-contained test of Vivian's Market Radar TAB
 * (compose_market_radar_tab in src/core/market_radar_pane.ts), the server-block
 * summary that makes the radar render on iOS/macOS.
 *
 * Temp db. Seeds a market_radar_snapshots run across two themes, then asserts:
 * the tab is composed with id 'radar', the hero counts distinct symbols across
 * themes, the cross-theme Spotlight ranks by the 1mo/3mo return blend, the
 * per-theme breakdown appears, the as-of line reflects freshness/staleness, and
 * an empty store yields null (→ flat fuel pane). No LLM, no network.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { MarketRadarStore, type MarketRadarRowInput } from '../src/memory/stores/market_radar';
import { compose_market_radar_tab } from '../src/core/market_radar_pane';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-radarpane-'));
const db = open_db(join(dir, 'smoke.db'));
const store = new MarketRadarStore(db);

function row(o: Partial<MarketRadarRowInput> & {
  theme: string;
  symbol: string;
  name: string;
  momentum_score: number;
  r_1mo_pct: number;
  r_3mo_pct: number;
}): MarketRadarRowInput {
  return {
    theme: o.theme,
    theme_label: o.theme_label ?? o.theme,
    symbol: o.symbol,
    name: o.name,
    price: o.price ?? 100,
    momentum_score: o.momentum_score,
    r_1mo_pct: o.r_1mo_pct,
    r_3mo_pct: o.r_3mo_pct,
    pct_off_52w_high: o.pct_off_52w_high ?? null,
    volume_surge: o.volume_surge ?? null,
    rsi_14: o.rsi_14 ?? null,
    annualized_volatility_pct: o.annualized_volatility_pct ?? null,
    max_drawdown_3mo_pct: o.max_drawdown_3mo_pct ?? null,
  };
}

// Empty store → null (flat fuel pane, byte-identical to pre-Radar).
check('empty store → null', compose_market_radar_tab(db) === null);

const fresh = new Date().toISOString();
store.insert_run(
  [
    row({ theme: 'ai_infra', theme_label: 'AI Infrastructure', symbol: 'NVDA', name: 'NVIDIA', momentum_score: 92, r_1mo_pct: 12, r_3mo_pct: 30 }),
    row({ theme: 'ai_infra', theme_label: 'AI Infrastructure', symbol: 'AVGO', name: 'Broadcom', momentum_score: 70, r_1mo_pct: 5, r_3mo_pct: 14 }),
    row({ theme: 'energy', theme_label: 'Energy', symbol: 'XOM', name: 'Exxon', momentum_score: 40, r_1mo_pct: 2, r_3mo_pct: 6 }),
  ],
  fresh,
);

const tab = compose_market_radar_tab(db);
check('composes a radar tab', tab !== null && tab.id === 'radar' && tab.label === 'Market Radar');

const hero = tab?.blocks.find((b) => b.type === 'hero_metric') as { value: string; label: string } | undefined;
check('hero counts 3 distinct symbols', hero?.value === '3');
check('hero names 2 themes', /2 themes/.test(hero?.label ?? ''));

const asof = tab?.blocks.find((b) => b.type === 'text') as { body_md: string } | undefined;
check('fresh run shows an as-of line (not stale)', /as of/.test(asof?.body_md ?? '') && !/stale/.test(asof?.body_md ?? ''));

const lists = (tab?.blocks ?? []).filter((b) => b.type === 'list') as Array<{
  title?: string;
  items: Array<{ title: string; subtitle?: string }>;
}>;
const spot = lists.find((l) => l.title === 'Spotlight');
check('Spotlight leads with the strongest blend (NVDA: 12/30)', !!spot?.items[0]?.title.startsWith('NVDA'));
check('Spotlight shows the return blend in the subtitle', /\+12\.0% 1mo, \+30\.0% 3mo/.test(spot?.items[0]?.subtitle ?? ''));
check('per-theme breakdown present (AI Infrastructure list)', lists.some((l) => l.title === 'AI Infrastructure'));

// A stale run (>36h) flips the as-of line to a staleness notice.
const db2 = open_db(join(dir, 'smoke2.db'));
const store2 = new MarketRadarStore(db2);
store2.insert_run(
  [row({ theme: 'energy', theme_label: 'Energy', symbol: 'XOM', name: 'Exxon', momentum_score: 40, r_1mo_pct: 2, r_3mo_pct: 6 })],
  new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
);
const stale_tab = compose_market_radar_tab(db2);
const stale_asof = stale_tab?.blocks.find((b) => b.type === 'text') as { body_md: string } | undefined;
check('a 48h-old run renders the staleness notice', /stale/.test(stale_asof?.body_md ?? ''));

rmSync(dir, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\nsmoke:market-radar-pane FAILED (${failures})`);
  process.exit(1);
}
console.log('\n✓ smoke:market-radar-pane — all checks passed');
