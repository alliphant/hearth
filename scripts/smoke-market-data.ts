/**
 * smoke-market-data — self-contained checks for the market_data connector.
 *
 * No live Yahoo calls: a throwaway Bun server serves fixture chart /
 * trending / screener / search responses (YAHOO_FINANCE_BASE_URL is the
 * seam), and a temp themes YAML stands in for config/market-themes.yaml
 * (HEARTH_MARKET_THEMES). Pure-math helpers are checked against
 * hand-computed values; the REAL config/market-themes.yaml is validated
 * at the end. Run: bun run smoke:market-data
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ToolContext } from '@core/tool';

// ── fixture data ────────────────────────────────────────────────────────────

const BARS = 252;
const BASE_TS = Math.floor(Date.UTC(2025, 5, 1) / 1000); // fixed — deterministic

function series(start: number, daily_factor: number): number[] {
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < BARS; i++) {
    out.push(Math.round(v * 100) / 100);
    v *= daily_factor;
  }
  return out;
}

const MOON_CLOSES = series(10, 1.008); // strong uptrend, ends at 52w high
const CRTR_CLOSES = series(100, 0.995); // steady downtrend
const MOON_VOLUMES = MOON_CLOSES.map((_, i) =>
  i >= BARS - 5 ? 3_000_000 : 1_000_000,
);
const CRTR_VOLUMES = CRTR_CLOSES.map(() => 1_000_000);

function chart_payload(symbol: string, name: string, closes: number[], volumes: number[]) {
  const last = closes[closes.length - 1] ?? 0;
  return {
    chart: {
      result: [
        {
          meta: {
            currency: 'USD',
            symbol,
            exchangeTimezoneName: 'America/New_York',
            regularMarketPrice: last,
            fiftyTwoWeekHigh: Math.max(...closes),
            fiftyTwoWeekLow: Math.min(...closes),
            longName: name,
            regularMarketTime: BASE_TS + BARS * 86400,
          },
          timestamp: closes.map((_, i) => BASE_TS + i * 86400),
          indicators: { quote: [{ close: closes, volume: volumes }] },
        },
      ],
      error: null,
    },
  };
}

function slice_chart(payload: ReturnType<typeof chart_payload>, n: number) {
  const r = payload.chart.result[0]!;
  return {
    chart: {
      result: [
        {
          meta: r.meta,
          timestamp: r.timestamp.slice(-n),
          indicators: {
            quote: [
              {
                close: r.indicators.quote[0]!.close.slice(-n),
                volume: r.indicators.quote[0]!.volume.slice(-n),
              },
            ],
          },
        },
      ],
      error: null,
    },
  };
}

const NOT_FOUND = {
  chart: {
    result: null,
    error: { code: 'Not Found', description: 'No data found, symbol may be delisted' },
  },
};

const RANGE_BARS: Record<string, number> = {
  '5d': 5,
  '1mo': 21,
  '3mo': 63,
  '6mo': 126,
  '1y': BARS,
};

// ── SEC XBRL + submissions fixtures (for company_fundamentals) ──────────────
// MOON (CIK 0000000111) has full financials; FRGN (0000000333) has none
// (foreign/IFRS path). Revenue is served under the 2nd fallback tag
// ("Revenues") with the 1st 404'd, to exercise the tag-fallback.

const SEC_TICKERS = {
  '0': { cik_str: 111, ticker: 'MOON', title: 'Moonshot Corp' },
  '1': { cik_str: 222, ticker: 'CRTR', title: 'Crater Industries' },
  '2': { cik_str: 333, ticker: 'FRGN', title: 'Foreign Holdings PLC' },
};

function dur(rows: Array<[string, number, string]>, unit = 'USD') {
  return {
    units: {
      [unit]: rows.map(([year, val, filed]) => ({
        start: `${year}-01-01`,
        end: `${year}-12-31`,
        val,
        form: '10-K',
        filed,
        fy: Number(year),
        fp: 'FY',
      })),
    },
  };
}
function inst(rows: Array<[string, number, string]>, unit = 'USD') {
  return {
    units: {
      // Instant (point-in-time) facts carry no real `start`; the connector
      // ignores start/fy/fp for instants (annual_series checks `start` only
      // for duration facts, and XbrlFact has no fy/fp), so mirroring dur()'s
      // shape here is purely to satisfy the shared ReturnType<typeof dur>.
      [unit]: rows.map(([end, val, filed]) => ({
        start: end,
        end,
        val,
        form: '10-K',
        filed,
        fy: Number(end.slice(0, 4)),
        fp: 'FY',
      })),
    },
  };
}

const MOON_FACTS: Record<string, ReturnType<typeof dur>> = {
  Revenues: dur([
    ['2023', 100_000_000, '2024-02-15'],
    ['2024', 150_000_000, '2025-02-15'],
  ]),
  NetIncomeLoss: dur([
    ['2023', 20_000_000, '2024-02-15'],
    ['2024', 30_000_000, '2025-02-15'],
  ]),
  GrossProfit: dur([['2024', 60_000_000, '2025-02-15']]),
  EarningsPerShareDiluted: dur([['2024', 2, '2025-02-15']], 'USD/shares'),
  NetCashProvidedByUsedInOperatingActivities: dur([['2024', 40_000_000, '2025-02-15']]),
  PaymentsToAcquirePropertyPlantAndEquipment: dur([['2024', 10_000_000, '2025-02-15']]),
  Assets: inst([['2024-12-31', 500_000_000, '2025-02-15']]),
  Liabilities: inst([['2024-12-31', 200_000_000, '2025-02-15']]),
  StockholdersEquity: inst([['2024-12-31', 300_000_000, '2025-02-15']]),
  CashAndCashEquivalentsAtCarryingValue: inst([['2024-12-31', 80_000_000, '2025-02-15']]),
  EntityCommonStockSharesOutstanding: inst(
    [
      ['2023-12-31', 45_000_000, '2024-02-15'],
      ['2025-01-31', 50_000_000, '2025-02-15'],
    ],
    'shares',
  ),
};

// ── fixture server ──────────────────────────────────────────────────────────

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    const chart_match = url.pathname.match(/^\/v8\/finance\/chart\/([^/]+)$/);
    if (chart_match) {
      const sym = decodeURIComponent(chart_match[1] ?? '').toUpperCase();
      const range = url.searchParams.get('range') ?? '1y';
      const n = RANGE_BARS[range] ?? BARS;
      if (sym === 'MOON') {
        return Response.json(
          slice_chart(chart_payload('MOON', 'Moonshot Corp', MOON_CLOSES, MOON_VOLUMES), n),
        );
      }
      if (sym === 'CRTR') {
        return Response.json(
          slice_chart(chart_payload('CRTR', 'Crater Industries', CRTR_CLOSES, CRTR_VOLUMES), n),
        );
      }
      return Response.json(NOT_FOUND, { status: 404 });
    }
    if (url.pathname.startsWith('/v1/finance/trending/')) {
      return Response.json({
        finance: { result: [{ quotes: [{ symbol: 'MOON' }, { symbol: 'CRTR' }] }] },
      });
    }
    if (url.pathname.startsWith('/v1/finance/screener/')) {
      return Response.json({
        finance: { result: [{ quotes: [{ symbol: 'CRTR' }, { symbol: 'MOON' }] }] },
      });
    }
    if (url.pathname.startsWith('/v1/finance/search')) {
      return Response.json({
        quotes: [
          { symbol: 'MOON', shortname: 'Moonshot Corp', quoteType: 'EQUITY' },
          { symbol: 'MOO', shortname: 'Moo Industries', quoteType: 'EQUITY' },
        ],
      });
    }
    // SEC ticker map
    if (url.pathname.endsWith('/files/company_tickers.json')) {
      return Response.json(SEC_TICKERS);
    }
    // SEC XBRL companyconcept: /api/xbrl/companyconcept/CIK<cik>/<ns>/<tag>.json
    const xbrl = url.pathname.match(
      /\/api\/xbrl\/companyconcept\/CIK(\d{10})\/[^/]+\/([^/]+)\.json$/,
    );
    if (xbrl) {
      const cik = xbrl[1] ?? '';
      const tag = xbrl[2] ?? '';
      if (cik === '0000000111' && MOON_FACTS[tag]) return Response.json(MOON_FACTS[tag]);
      return new Response('no data', { status: 404 });
    }
    // SEC submissions: /submissions/CIK<cik>.json
    const subs = url.pathname.match(/\/submissions\/CIK(\d{10})\.json$/);
    if (subs) {
      const cik = subs[1] ?? '';
      if (cik === '0000000111') {
        return Response.json({
          filings: {
            recent: {
              form: ['8-K', '10-K', '10-Q'],
              filingDate: ['2026-06-08', '2025-02-15', '2025-05-01'],
              primaryDocDescription: ['Results of Operations', 'Annual Report', 'Quarterly Report'],
            },
          },
        });
      }
      return Response.json({ filings: { recent: { form: [], filingDate: [], primaryDocDescription: [] } } });
    }
    return new Response('not found', { status: 404 });
  },
});

// ── temp themes file ────────────────────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), 'hearth-market-smoke-'));
const themes_path = join(tmp, 'themes.yaml');
writeFileSync(
  themes_path,
  [
    'themes:',
    '  uptest:',
    '    label: Up test',
    '    description: fixture theme',
    '    tickers: [MOON, CRTR, BADP]',
  ].join('\n'),
);

process.env.YAHOO_FINANCE_BASE_URL = `http://localhost:${server.port}`;
process.env.HEARTH_MARKET_THEMES = themes_path;
process.env.SEC_DATA_BASE = `http://localhost:${server.port}`;
process.env.SEC_TICKERS_URL = `http://localhost:${server.port}/files/company_tickers.json`;

const {
  market_quote,
  market_history,
  technical_snapshot,
  market_movers,
  momentum_screen,
  list_market_themes,
  load_market_themes,
  pct_return_over,
  sma_last,
  rsi_14,
  max_drawdown_pct,
  volume_surge_ratio,
  annualized_volatility_pct,
  compute_momentum_scores,
  create,
} = await import('../src/connectors/market_data');

const ctx = { now: new Date(), intent_id: 'smoke-market-data' } as ToolContext;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── pure math ───────────────────────────────────────────────────────────────

console.log('\n→ pure math helpers');
check('sma_last([1..10], 5) = 8', sma_last([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5) === 8);
check('sma_last too-short → null', sma_last([1, 2], 5) === null);
{
  const r = pct_return_over([100, 101, 102, 110], 3);
  check('pct_return_over 3-back = 10%', r !== null && Math.abs(r - 10) < 1e-9, String(r));
  check('pct_return_over too-short → null', pct_return_over([100, 110], 3) === null);
}
{
  const dd = max_drawdown_pct([10, 5, 8, 4]);
  check('max_drawdown [10,5,8,4] = 60%', dd !== null && Math.abs(dd - 60) < 1e-9, String(dd));
}
{
  const vols: Array<number | null> = new Array(63).fill(1_000_000);
  for (let i = 58; i < 63; i++) vols[i] = 3_000_000;
  const surge = volume_surge_ratio(vols);
  check('volume_surge ≈ 2.59 on 3x recent', surge !== null && surge > 2.4 && surge < 2.8, String(surge));
}
{
  const up = rsi_14(MOON_CLOSES);
  const down = rsi_14(CRTR_CLOSES);
  check('RSI(uptrend) > 60', up !== null && up > 60, String(up));
  check('RSI(downtrend) < 40', down !== null && down < 40, String(down));
  check('RSI too-short → null', rsi_14([1, 2, 3]) === null);
}
check('volatility(uptrend) finite', (annualized_volatility_pct(MOON_CLOSES) ?? -1) >= 0);
{
  const scored = compute_momentum_scores([
    { symbol: 'A', name: 'A', price: 1, r_1mo_pct: 20, r_3mo_pct: 50, pct_off_52w_high: 0, volume_surge: 2, rsi_14: 70, annualized_volatility_pct: 40, max_drawdown_3mo_pct: 5 },
    { symbol: 'B', name: 'B', price: 1, r_1mo_pct: -5, r_3mo_pct: -20, pct_off_52w_high: 40, volume_surge: 0.8, rsi_14: 35, annualized_volatility_pct: 40, max_drawdown_3mo_pct: 30 },
    { symbol: 'C', name: 'C', price: 1, r_1mo_pct: 5, r_3mo_pct: 10, pct_off_52w_high: 10, volume_surge: null, rsi_14: 55, annualized_volatility_pct: 40, max_drawdown_3mo_pct: 12 },
  ]);
  const by = Object.fromEntries(scored.map((s) => [s.symbol, s.momentum_score]));
  check('scores rank A > C > B', (by.A ?? 0) > (by.C ?? 0) && (by.C ?? 0) > (by.B ?? 0), JSON.stringify(by));
  check('top score near 100, bottom near 0', (by.A ?? 0) >= 85 && (by.B ?? 100) <= 15, JSON.stringify(by));
}

// ── market_quote ────────────────────────────────────────────────────────────

console.log('\n→ market_quote');
{
  const out = await market_quote.execute({ symbols: ['MOON', 'BADP'] }, ctx);
  const moon = out.quotes.find((q) => q.symbol === 'MOON');
  const last = MOON_CLOSES[BARS - 1] ?? 0;
  const prev = MOON_CLOSES[BARS - 2] ?? 0;
  const want_chg = ((last - prev) / prev) * 100;
  check('MOON quoted at last close', moon !== undefined && Math.abs(moon.price - last) < 0.01);
  check(
    'session change matches last two bars',
    moon?.session_change_pct !== null && moon !== undefined &&
      Math.abs((moon.session_change_pct ?? 0) - want_chg) < 0.05,
    `got ${moon?.session_change_pct}, want ~${want_chg.toFixed(2)}`,
  );
  check('MOON at 52w high → pct_off ≈ 0', moon !== undefined && Math.abs(moon.pct_off_52w_high ?? 99) < 0.01);
  const bad = out.failed.find((f) => f.symbol === 'BADP');
  check('BADP lands in failed', bad !== undefined);
  check('failed symbol carries candidates', (bad?.candidates?.length ?? 0) > 0, JSON.stringify(bad));
}

// ── market_history ──────────────────────────────────────────────────────────

console.log('\n→ market_history');
{
  const out = await market_history.execute(
    { symbol: 'MOON', range: '6mo', interval: '1d', max_points: 20 },
    ctx,
  );
  check('no error', out.error === undefined, out.error);
  check('downsampled to ≤ 20 points', out.points.length > 0 && out.points.length <= 20, String(out.points.length));
  const last_point = out.points[out.points.length - 1];
  check('most recent bar survives exactly', last_point !== undefined && Math.abs(last_point.close - (MOON_CLOSES[BARS - 1] ?? 0)) < 0.01);
  const n = RANGE_BARS['6mo'] ?? 126;
  const start = MOON_CLOSES[BARS - n] ?? 1;
  const end = MOON_CLOSES[BARS - 1] ?? 1;
  const want = ((end - start) / start) * 100;
  check(
    'summary total_return matches window',
    out.summary !== null && Math.abs(out.summary.total_return_pct - want) < 0.1,
    `got ${out.summary?.total_return_pct}, want ~${want.toFixed(2)}`,
  );
  const bad = await market_history.execute(
    { symbol: 'BADP', range: '6mo', interval: '1d', max_points: 20 },
    ctx,
  );
  check('bad symbol → error + candidates', bad.error !== undefined && (bad.candidates?.length ?? 0) > 0);
}

// ── technical_snapshot ──────────────────────────────────────────────────────

console.log('\n→ technical_snapshot');
{
  const up = await technical_snapshot.execute({ symbol: 'MOON' }, ctx);
  check('uptrend: 1mo return > 0', (up.returns?.r_1mo_pct ?? -1) > 0);
  check('uptrend: sma50 above sma200', up.trend?.sma50_above_sma200 === true);
  check('uptrend: price above sma200', (up.trend?.price_vs_sma200_pct ?? -1) > 0);
  check('uptrend: RSI > 60', (up.rsi_14 ?? 0) > 60);
  check('uptrend: volume surge > 2', (up.volume_surge ?? 0) > 2);
  check('risk numbers present', up.risk !== null && up.risk.annualized_volatility_pct !== null);
  const down = await technical_snapshot.execute({ symbol: 'CRTR' }, ctx);
  check('downtrend: 3mo return < 0', (down.returns?.r_3mo_pct ?? 1) < 0);
  check('downtrend: well off 52w high', (down.fifty_two_week?.pct_off_high ?? 0) > 30);
  const bad = await technical_snapshot.execute({ symbol: 'BADP' }, ctx);
  check('bad symbol → error + candidates', bad.error !== undefined && (bad.candidates?.length ?? 0) > 0);
}

// ── market_movers ───────────────────────────────────────────────────────────

console.log('\n→ market_movers');
{
  const trend = await market_movers.execute({ source: 'trending', count: 10 }, ctx);
  check('trending returns both fixtures enriched', trend.movers.length === 2, JSON.stringify(trend.movers.map((m) => m.symbol)));
  check('trending keeps feed order', trend.movers[0]?.symbol === 'MOON');
  const gain = await market_movers.execute({ source: 'day_gainers', count: 10 }, ctx);
  check(
    'day_gainers sorted by session change (MOON first)',
    gain.movers[0]?.symbol === 'MOON',
    JSON.stringify(gain.movers.map((m) => [m.symbol, m.session_change_pct])),
  );
}

// ── momentum_screen ─────────────────────────────────────────────────────────

console.log('\n→ momentum_screen');
{
  const out = await momentum_screen.execute(
    { theme: 'uptest', include_trending: false, top_n: 8 },
    ctx,
  );
  check('no error on themed screen', out.error === undefined, out.error);
  check('universe = 3 symbols', out.universe_size === 3);
  check('MOON outranks CRTR', out.ranked[0]?.symbol === 'MOON', JSON.stringify(out.ranked.map((r) => [r.symbol, r.momentum_score])));
  check('failed symbol tolerated → skipped', out.skipped.some((s) => s.symbol === 'BADP'));
  check('rows carry risk columns', out.ranked.every((r) => r.annualized_volatility_pct !== undefined && r.max_drawdown_3mo_pct !== undefined));

  const unknown = await momentum_screen.execute(
    { theme: 'no_such_theme', include_trending: false, top_n: 8 },
    ctx,
  );
  check('unknown theme → error + available_themes', unknown.error !== undefined && (unknown.available_themes ?? []).includes('uptest'));

  const empty = await momentum_screen.execute({ include_trending: false, top_n: 8 }, ctx);
  check('no universe → error + available_themes', empty.error !== undefined && (empty.available_themes ?? []).length > 0);

  const trending = await momentum_screen.execute({ include_trending: true, top_n: 8 }, ctx);
  check('trending-only universe screens', trending.error === undefined && trending.ranked.length === 2, trending.error);
}

// ── list_market_themes + real config file ───────────────────────────────────

console.log('\n→ themes');
{
  const out = await list_market_themes.execute({}, ctx);
  check('temp themes listed', out.themes.length === 1 && out.themes[0]?.id === 'uptest');

  process.env.HEARTH_MARKET_THEMES = resolve(import.meta.dir, '../config/market-themes.yaml');
  const real = await load_market_themes();
  if ('error' in real) {
    check('REAL config/market-themes.yaml parses', false, real.error);
  } else {
    const ids = Object.keys(real.themes);
    check('REAL themes file has ≥ 5 themes', ids.length >= 5, String(ids.length));
    check('REAL theme ids are snake_case', ids.every((id) => /^[a-z][a-z0-9_]*$/.test(id)), JSON.stringify(ids));
    check(
      'REAL themes each have ≥ 3 unique tickers',
      Object.values(real.themes).every((t) => new Set(t.tickers).size >= 3 && new Set(t.tickers).size === t.tickers.length),
    );
    check('the asked-for themes exist (AI / datacenters / vertical farming)',
      ids.includes('ai_infrastructure') && ids.includes('datacenters') && ids.includes('vertical_farming_agtech'));
  }
  process.env.HEARTH_MARKET_THEMES = themes_path;
}

// ── declarations ────────────────────────────────────────────────────────────

console.log('\n→ tool declarations');
{
  const tools = create({} as never);
  check('factory exports 6 tools', tools.length === 6, String(tools.length));
  check('all read risk', tools.every((t) => t.risk === 'read'));
  check(
    'all gated on read_market_data',
    tools.every((t) => (t.required_capabilities ?? []).includes('read_market_data')),
  );
  check('all declare idempotency keys', tools.every((t) => typeof t.idempotency_key === 'function'));
}

// ── company_fundamentals (SEC XBRL) ─────────────────────────────────────────

console.log('\n→ company_fundamentals');
{
  const { company_fundamentals, cagr_pct, pct_change } = await import(
    '../src/connectors/sec_fundamentals'
  );
  check('cagr_pct [100→150 over 1y] = 50%', Math.abs((cagr_pct([{ fy_end: '2023-12-31', value: 100 }, { fy_end: '2024-12-31', value: 150 }]) ?? 0) - 50) < 1e-9);
  check('pct_change(150,100) = 50%', pct_change(150, 100) === 50);

  const f_ctx = { now: new Date('2026-06-12T00:00:00Z'), intent_id: 'smoke-fund' } as ToolContext;
  const out = await company_fundamentals.execute({ ticker: 'MOON', years: 5 }, f_ctx);
  check('no error for MOON', out.error === undefined, out.error);
  check('company name resolved', out.company_name === 'Moonshot Corp', out.company_name);
  check('revenue series via tag-fallback (Revenues)', (out.fundamentals?.revenue.length ?? 0) === 2);
  check('latest revenue = 150M', (out.fundamentals?.revenue.at(-1)?.value ?? 0) === 150_000_000);
  check('free cash flow = OCF − capex = 30M', (out.fundamentals?.free_cash_flow.at(-1)?.value ?? 0) === 30_000_000);
  check('shares = latest (50M, not 45M)', out.fundamentals?.shares_outstanding === 50_000_000);
  check('revenue YoY growth = 50%', out.derived?.revenue_growth_yoy_pct === 50);
  check('gross margin = 40%', out.derived?.gross_margin_pct === 40);
  check('net margin = 20%', out.derived?.net_margin_pct === 20);
  check('fcf margin = 20%', out.derived?.fcf_margin_pct === 20);
  check('debt/equity = 0.67', out.derived?.debt_to_equity === 0.67);
  check('profitable_ttm = true', out.derived?.profitable_ttm === true);
  const price = out.price ?? 0;
  check('price resolved from quote', price > 0);
  check('P/E ≈ price / EPS(2.0)', out.valuation?.pe_fy !== null && Math.abs((out.valuation?.pe_fy ?? 0) - price / 2) < 0.02, `pe=${out.valuation?.pe_fy} price=${price}`);
  check('market_cap = price × 50M', out.valuation?.market_cap !== null && Math.abs((out.valuation?.market_cap ?? 0) - price * 50_000_000) < 1);
  check('P/S ≈ market_cap / revenue', out.valuation?.ps_fy !== null && Math.abs((out.valuation?.ps_fy ?? 0) - (price * 50_000_000) / 150_000_000) < 0.02);
  check('recent 8-K surfaced (4 days ago)', out.recent_8k?.days_ago === 4 && out.recent_8k?.description === 'Results of Operations');
  check('latest periodic filing = 10-K', out.latest_periodic_filing?.form === '10-K');

  const frgn = await company_fundamentals.execute({ ticker: 'FRGN', years: 5 }, f_ctx);
  check('foreign/IFRS filer → honest no-financials note', frgn.error !== undefined && frgn.fundamentals === null);

  const bad = await company_fundamentals.execute({ ticker: 'ZZZZ', years: 5 }, f_ctx);
  check('unknown ticker → error + candidates field', bad.error !== undefined && bad.candidates !== undefined);

  check('gated on read_market_data', (company_fundamentals.required_capabilities ?? []).includes('read_market_data'));
}

// ── done ────────────────────────────────────────────────────────────────────

server.stop(true);
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
