/**
 * smoke:market-radar — self-contained test of Vivian's Market Radar
 * stack: the refresh_market_radar background-job tool (against the
 * fixture Yahoo server via the YAHOO_FINANCE_BASE_URL seam + a temp
 * themes file), the MarketRadarStore run lifecycle, and the
 * GET /api/specialists/:id/market_radar route mounted in-process behind
 * a fake auth middleware (owner-gating, capability-gating, theme
 * grouping, cross-theme spotlight order, news-category filter,
 * staleness).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ulid } from 'ulid';
import { open_db } from '../src/memory/stores/structured';
import { SpecialistRegistry } from '../src/core/specialist';
import { load_extra_capabilities } from '../src/core/capabilities';
import { MarketRadarStore } from '../src/memory/stores/market_radar';
import type { ToolContext } from '../src/core/tool';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

load_extra_capabilities(join(import.meta.dir, '../config/capabilities.yaml'));

// ── fixture Yahoo server (MOON uptrend / CRTR downtrend / BADP 404) ────────

const BARS = 252;
const BASE_TS = Math.floor(Date.UTC(2025, 5, 1) / 1000);
function series(start: number, factor: number): number[] {
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < BARS; i++) {
    out.push(Math.round(v * 100) / 100);
    v *= factor;
  }
  return out;
}
const SERIES: Record<string, number[]> = {
  MOON: series(10, 1.008),
  CRTR: series(100, 0.995),
};
function chart_payload(sym: string, closes: number[]) {
  return {
    chart: {
      result: [
        {
          meta: {
            currency: 'USD',
            symbol: sym,
            exchangeTimezoneName: 'America/New_York',
            regularMarketPrice: closes[closes.length - 1],
            fiftyTwoWeekHigh: Math.max(...closes),
            fiftyTwoWeekLow: Math.min(...closes),
            longName: `${sym} Corp`,
          },
          timestamp: closes.map((_, i) => BASE_TS + i * 86400),
          indicators: { quote: [{ close: closes, volume: closes.map(() => 1_000_000) }] },
        },
      ],
      error: null,
    },
  };
}
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/v8\/finance\/chart\/([^/]+)$/);
    if (m) {
      const sym = decodeURIComponent(m[1] ?? '').toUpperCase();
      const closes = SERIES[sym];
      if (!closes) {
        return Response.json(
          { chart: { result: null, error: { code: 'Not Found', description: 'No data found' } } },
          { status: 404 },
        );
      }
      return Response.json(chart_payload(sym, closes));
    }
    if (url.pathname.startsWith('/v1/finance/trending/')) {
      return Response.json({ finance: { result: [{ quotes: [{ symbol: 'MOON' }, { symbol: 'CRTR' }] }] } });
    }
    if (url.pathname.startsWith('/v1/finance/search')) {
      return Response.json({ quotes: [{ symbol: 'MOON', shortname: 'Moonshot' }] });
    }
    return new Response('not found', { status: 404 });
  },
});

const dir = mkdtempSync(join(tmpdir(), 'hearth-market-radar-'));
const themes_path = join(dir, 'themes.yaml');
writeFileSync(
  themes_path,
  ['themes:', '  uptest:', '    label: Up test', '    description: fixture', '    tickers: [MOON, CRTR, BADP]'].join('\n'),
);
process.env.YAHOO_FINANCE_BASE_URL = `http://localhost:${server.port}`;
process.env.HEARTH_MARKET_THEMES = themes_path;

const { make_refresh_market_radar } = await import('../src/specialists/vivian/tools/refresh_market_radar');
const { create_market_radar_router } = await import('../src/app/routes/market_radar');

const db = open_db(join(dir, 'smoke.db'));
const ctx = { now: new Date('2026-06-12T13:30:00Z'), intent_id: 'smoke-radar' } as ToolContext;

// ── the refresh job ─────────────────────────────────────────────────────────

console.log('\n→ refresh_market_radar');
const tool = make_refresh_market_radar(db);
check('tool is volatile (refresh must re-run, never cache-serve)', tool.volatile === true);
check('tool gated on write_market_radar', (tool.required_capabilities ?? []).includes('write_market_radar'));
const out = await tool.execute({ per_theme: 3, include_trending: true }, ctx);
check('run landed', out.run_id !== null, JSON.stringify(out.errors));
check('theme + trending screened', out.themes_screened === 2, String(out.themes_screened));
check('4 rows (2 fetchable per universe)', out.rows_inserted === 4, String(out.rows_inserted));
check('BADP tolerated as skipped', out.symbols_skipped >= 1);
check('no theme-level errors', out.errors.length === 0, JSON.stringify(out.errors));

const store = new MarketRadarStore(db);
const run1 = store.latest_run();
check('latest_run returns the run', run1 !== null && run1.rows.length === 4);
const out2 = await tool.execute({ per_theme: 2, include_trending: false }, ctx);
const run2 = store.latest_run();
check('second refresh becomes the latest run', run2 !== null && out2.run_id === run2.run_id && run2.run_id !== run1?.run_id);
check('store prune removes old rows', store.prune_older_than('2099-01-01T00:00:00Z') > 0 && store.latest_run() === null);

// Re-seed a fresh run for the route checks. Stamp it with real wall-clock now —
// the route's staleness check compares run.ts against Date.now() (36h window),
// so a run pinned to the fixed fixture date reads as stale once real time moves
// >36h past it. The news_items fixtures below keep the fixed date (they test
// category aggregation, not radar staleness).
const route_ctx = { ...ctx, now: new Date() } as ToolContext;
await tool.execute({ per_theme: 3, include_trending: true }, route_ctx);

// ── news_items fixtures ─────────────────────────────────────────────────────

const ins = db.prepare(
  `INSERT INTO news_items (id, link, title, description, source_url, source_domain, specialist_id, category, published_at, fetched_at)
   VALUES (@id, @link, @title, '', @src, @dom, 'vivian', @cat, @pub, @fetched)`,
);
for (const [title, cat, pub] of [
  ['NVDA datacenter revenue beats', 'markets', '2026-06-12T10:00:00Z'],
  ['Agentic AI startup raises round', 'ai-business', '2026-06-12T09:00:00Z'],
  ['City council passes zoning rule', 'world', '2026-06-12T08:00:00Z'],
] as const) {
  ins.run({
    '@id': ulid().toLowerCase(),
    '@link': `https://example.com/${ulid().toLowerCase()}`,
    '@title': title,
    '@src': 'https://example.com/feed',
    '@dom': 'example.com',
    '@cat': cat,
    '@pub': pub,
    '@fetched': '2026-06-12T11:00:00Z',
  });
}

// ── the route, in-process ───────────────────────────────────────────────────

console.log('\n→ /api/specialists/:id/market_radar');
const spec_dir = join(dir, 'specialists');
mkdirSync(spec_dir, { recursive: true });
writeFileSync(
  join(spec_dir, 'vivian.yaml'),
  'id: vivian\nname: Vivian\nrole: Fixture\nvoice: warm\npersona: |\n  Fixture persona for the market radar smoke. Long enough to pass.\nproactive:\n  mode: reactive\ncapabilities:\n  read_market_data: true\n  write_market_radar: true\n',
);
writeFileSync(
  join(spec_dir, 'kate.yaml'),
  'id: kate\nname: Kate\nrole: Fixture\nvoice: warm\npersona: |\n  Fixture persona for the market radar smoke. Long enough to pass.\nproactive:\n  mode: reactive\n',
);
const specialists = new SpecialistRegistry(spec_dir);

let current_user: { id: string; tier: string } | null = { id: 'jasper', tier: 'owner' };
const app = new Hono();
app.use('*', async (c, next) => {
  if (current_user) c.set('user', current_user as never);
  await next();
});
app.route('/api/specialists', create_market_radar_router({ db, specialists }));

const get = async (path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.json().catch(() => null) };
};

{
  const { status, body } = await get('/api/specialists/vivian/market_radar');
  check('owner gets 200', status === 200);
  check('fresh run → not stale', body && body.stale === false);
  const theme_ids = (body?.themes ?? []).map((t: { theme: string }) => t.theme);
  check('themes grouped, trending LAST', theme_ids.length === 2 && theme_ids[theme_ids.length - 1] === '_trending', JSON.stringify(theme_ids));
  const spot = (body?.spotlight ?? []).map((s: { symbol: string }) => s.symbol);
  check('spotlight deduped + MOON outranks CRTR', spot[0] === 'MOON' && spot.length === 2, JSON.stringify(spot));
  const cats = new Set((body?.news ?? []).map((n: { category: string }) => n.category));
  check('news filtered to radar categories', cats.has('markets') && cats.has('ai-business') && !cats.has('world'), JSON.stringify([...cats]));
  check('news newest first', body?.news?.[0]?.title === 'NVDA datacenter revenue beats');
}
{
  current_user = { id: 'sam', tier: 'household' };
  const { status } = await get('/api/specialists/vivian/market_radar');
  check('household tier → 403', status === 403);
  current_user = null;
  const { status: s2 } = await get('/api/specialists/vivian/market_radar');
  check('unauthenticated → 401', s2 === 401);
  current_user = { id: 'jasper', tier: 'owner' };
  const { status: s3 } = await get('/api/specialists/kate/market_radar');
  check('specialist without read_market_data → 404', s3 === 404);
  const { status: s4 } = await get('/api/specialists/nosuch/market_radar');
  check('unknown specialist → 404', s4 === 404);
}
{
  // Empty store → null timestamps + stale, never an error.
  const db2 = open_db(join(dir, 'smoke2.db'));
  const app2 = new Hono();
  app2.use('*', async (c, next) => {
    c.set('user', { id: 'jasper', tier: 'owner' } as never);
    await next();
  });
  app2.route('/api/specialists', create_market_radar_router({ db: db2, specialists }));
  const res = await app2.request('/api/specialists/vivian/market_radar');
  const body = await res.json();
  check('empty store → 200 + stale + null generated_at', res.status === 200 && body.stale === true && body.generated_at === null);
}

// ── radar deltas (week-over-week movers) ────────────────────────────────────

console.log('\n→ radar deltas');
{
  const mkrow = (theme: string, symbol: string, score: number, r1: number, r3: number) => ({
    theme,
    theme_label: theme === 'ai' ? 'AI' : theme,
    symbol,
    name: `${symbol} Inc`,
    price: 10,
    momentum_score: score,
    r_1mo_pct: r1,
    r_3mo_pct: r3,
    pct_off_52w_high: 5,
    volume_surge: 1,
    rsi_14: 60,
    annualized_volatility_pct: 50,
    max_drawdown_3mo_pct: 10,
  });

  const db3 = open_db(join(dir, 'smoke3.db'));
  const store3 = new MarketRadarStore(db3);
  const now = new Date('2026-06-12T13:30:00Z');
  const week_ago = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  // Old run: MOON @50, OLDY @60. New run: MOON @70 (accelerating +20),
  // NEWB @65 (entered). OLDY absent → dropped.
  store3.insert_run([mkrow('ai', 'MOON', 50, 5, 10), mkrow('ai', 'OLDY', 60, 4, 8)], week_ago);
  store3.insert_run([mkrow('ai', 'MOON', 70, 30, 60), mkrow('ai', 'NEWB', 65, 25, 50)], now.toISOString());

  const app3 = new Hono();
  app3.use('*', async (c, next) => {
    c.set('user', { id: 'jasper', tier: 'owner' } as never);
    await next();
  });
  app3.route('/api/specialists', create_market_radar_router({ db: db3, specialists }));
  const res = await app3.request('/api/specialists/vivian/market_radar');
  const body = await res.json();
  const mv = body.movers;
  check('movers present with two runs', mv !== null && mv !== undefined);
  check('entered = [NEWB]', JSON.stringify((mv?.entered ?? []).map((m: { symbol: string }) => m.symbol)) === '["NEWB"]');
  check('accelerating = [MOON] with score_delta 20',
    (mv?.accelerating ?? []).length === 1 && mv.accelerating[0].symbol === 'MOON' && mv.accelerating[0].score_delta === 20);
  check('dropped = [OLDY]', JSON.stringify((mv?.dropped ?? []).map((m: { symbol: string }) => m.symbol)) === '["OLDY"]');
  check('movers.since points at the old run', mv?.since === week_ago);

  // Single run → no comparison → movers null.
  const db4 = open_db(join(dir, 'smoke4.db'));
  new MarketRadarStore(db4).insert_run([mkrow('ai', 'MOON', 70, 30, 60)], now.toISOString());
  const app4 = new Hono();
  app4.use('*', async (c, next) => {
    c.set('user', { id: 'jasper', tier: 'owner' } as never);
    await next();
  });
  app4.route('/api/specialists', create_market_radar_router({ db: db4, specialists }));
  const body4 = await (await app4.request('/api/specialists/vivian/market_radar')).json();
  check('single run → movers null (nothing to compare)', body4.movers === null);
}

// ── done ────────────────────────────────────────────────────────────────────

server.stop(true);
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nall green' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
