/**
 * smoke:kristi-cost — self-contained (temp DB, no LLM, no network).
 *
 * Exercises Kristi's cost-accuracy + future-impact layer end-to-end at the
 * store + pure-math layers:
 *   - cost_model pure functions: the price plausibility gates (absolute window
 *     + history-relative outlier), the log-linear drift fit recovering a known
 *     synthetic drift, the forward projection compounding, median.
 *   - store integration: record_price / record_commodity_price REJECT the
 *     misread class before the INSERT (and return the reason), the robust
 *     median street price shrugging off one bad scrape, base_unit_view's
 *     residual math + name canonicalization + missing/flags, class_drift,
 *     and cost_outlook's projected base-config totals agreeing with the math
 *     recomputed by hand from the same fits.
 *   - the three cost_analysis read tools' contract shapes.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KristiWorkstationsStore } from '@memory/stores/kristi_workstations';
import {
  validate_commodity_price,
  validate_system_price,
  fit_drift,
  project_price,
  trend_direction,
  trend_confidence,
  median,
} from '@specialists/kristi/cost_model';
import { create as create_cost_tools } from '@specialists/kristi/tools/cost_analysis';
import type { ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';

const db_path = join(tmpdir(), `kristi-cost-smoke-${process.pid}.db`);
let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures++;
}
function approx(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}
function days_ago(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

try {
  // ── 1. pure math: plausibility gates ───────────────────────────────────────
  check('gate: $4 GPU rejected (absolute window)', !validate_commodity_price('gpu', 4).ok);
  check('gate: $900 GPU accepted (no history)', validate_commodity_price('gpu', 900).ok);
  check('gate: $200k storage rejected', !validate_commodity_price('storage', 200_000).ok);
  check(
    'gate: 10× the series median rejected (decimal-shift class)',
    !validate_commodity_price('gpu', 8500, { median: 850, n: 3 }).ok,
  );
  check(
    'gate: 1.4× the series median accepted (a real move)',
    validate_commodity_price('gpu', 1200, { median: 850, n: 3 }).ok,
  );
  check(
    'gate: relative gate needs ≥2 prior points (one bad seed cannot lock the series)',
    validate_commodity_price('gpu', 8500, { median: 850, n: 1 }).ok,
  );
  check('gate: $5 system price rejected', !validate_system_price(5).ok);
  check('gate: $2M system price rejected', !validate_system_price(2_000_000).ok);
  check('gate: $6,799 system price accepted', validate_system_price(6799).ok);

  // ── 2. pure math: drift fit + projection ───────────────────────────────────
  // Synthetic series compounding at exactly +10%/mo over 60 days.
  const MONTH = 30.44;
  const rising = Array.from({ length: 7 }, (_, i) => {
    const d = i * 10; // 0..60 days
    return { date: days_ago(60 - d), price: 100 * Math.pow(1.1, d / MONTH) };
  });
  const fit = fit_drift(rising);
  check('fit: synthetic +10%/mo recovered', fit != null && approx(fit.monthly_pct, 10, 0.5));
  check('fit: clean series r² ≈ 1', fit != null && fit.r2 >= 0.98);
  check('fit: direction up, confidence high', fit != null && trend_direction(fit) === 'up' && trend_confidence(fit) === 'high');

  const flat = [0, 15, 30].map((d) => ({ date: days_ago(30 - d), price: 500 }));
  const flat_fit = fit_drift(flat);
  check('fit: flat series ≈ 0%/mo, direction flat', flat_fit != null && approx(flat_fit.monthly_pct, 0, 0.1) && trend_direction(flat_fit) === 'flat');
  check('fit: two points → null (not a trend)', fit_drift(rising.slice(0, 2)) === null);
  check(
    'fit: 3 points inside 7 days → null (span too short)',
    fit_drift([{ date: days_ago(6), price: 100 }, { date: days_ago(3), price: 101 }, { date: days_ago(0), price: 102 }]) === null,
  );

  const proj = project_price(100, 10, 6, 2);
  check('project: 100 @ +10%/mo × 6mo ≈ 177.16', approx(proj.projected, 177.16, 0.05));
  check('project: band widens and brackets the point', proj.low < proj.projected && proj.projected < proj.high && proj.band_pct >= 5);
  const proj_flat = project_price(100, 0, 6, 0);
  check('project: zero drift holds flat', approx(proj_flat.projected, 100, 0.001));

  check('median: odd', median([3, 1, 2]) === 2);
  check('median: even', median([1, 2, 3, 4]) === 2.5);
  check('median: empty → null', median([]) === null);

  // ── 3. store: write gates live at the chokepoints ──────────────────────────
  const store = new KristiWorkstationsStore(db_path);

  const r1 = store.record_commodity_price({
    commodity: 'NVIDIA RTX 4000 Ada', commodity_class: 'gpu', vendor: 'other',
    price: 2, price_kind: 'standalone', url: 'https://example.test/p',
  });
  check('store gate: $2 GPU rejected with reason', !r1.stored && !!r1.reason);

  // Seed a 3-point history (raw inserts — backdated rows have no public write
  // path on purpose), then verify the relative gate fires against it.
  const raw = store.db.prepare(
    `INSERT INTO commodity_prices
       (commodity, commodity_class, vendor, model_id, price, price_kind, currency, url, captured_at, captured_date)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const [d, p] of [[20, 800], [10, 810], [5, 805]] as const) {
    raw.run('NVIDIA RTX 4000 Ada', 'gpu', 'other', '', p, 'standalone', 'USD', 'https://example.test/h', new Date().toISOString(), days_ago(d));
  }
  const r2 = store.record_commodity_price({
    commodity: 'NVIDIA RTX 4000 Ada', commodity_class: 'gpu', vendor: 'other',
    price: 8050, price_kind: 'standalone', url: 'https://example.test/p',
  });
  check('store gate: 10× own-series median rejected', !r2.stored && (r2.reason ?? '').includes('median'));
  const r3 = store.record_commodity_price({
    commodity: 'NVIDIA RTX 4000 Ada', commodity_class: 'gpu', vendor: 'other',
    price: 820, price_kind: 'standalone', url: 'https://example.test/p',
  });
  check('store gate: in-line price stored', r3.stored);

  const p1 = store.record_price({
    model_id: 'hp-z2-g9', config_label: 'base', segment: 'prosumer',
    list_price: 5, sale_price: null, url: 'https://example.test/sys',
  });
  check('store gate: $5 system price rejected', !p1.stored);
  const p2 = store.record_price({
    model_id: 'hp-z2-g9', config_label: 'base', segment: 'prosumer',
    list_price: 1899, sale_price: null, url: 'https://example.test/sys',
  });
  check('store gate: $1,899 system price stored', p2.stored && store.price_history('hp-z2-g9').length === 1);

  // ── 4. store: robust street price shrugs off one bad scrape ────────────────
  for (const [d, p] of [[12, 100], [9, 102], [6, 98], [3, 5000], [1, 101]] as const) {
    raw.run('64GB DDR5-6400 ECC', 'memory', 'other', '', p, 'standalone', 'USD', 'https://example.test/m', new Date().toISOString(), days_ago(d));
  }
  const robust = store.robust_standalone('64GB DDR5-6400 ECC');
  check('robust street: median 101 beats the 5000 bad-scrape point', robust != null && robust.price === 101);
  check('robust street: dispersion surfaced', robust != null && robust.n_obs === 5 && robust.spread_pct > 25);

  // ── 5. store: base-unit residual + canonicalization + flags ────────────────
  store.upsert_sku({
    model_id: 'hp-z2-g9', vendor: 'hp', family: 'Z2', model_name: 'HP Z2 G9 Tower',
    form_factor: 'tower', chassis_variant: '', cpu_platform: 'core_ultra' as never,
    status: 'shipping' as never, announced_at: '', launched_at: '', source_url: 'https://example.test', notes: '',
  });
  store.record_commodity_price({
    commodity: 'Intel Core Ultra 7 265', commodity_class: 'cpu', vendor: 'other',
    price: 400, price_kind: 'standalone', url: 'https://example.test/cpu',
  });
  store.record_commodity_price({
    commodity: '1TB NVMe Gen4 M.2 SSD', commodity_class: 'storage', vendor: 'other',
    price: 100, price_kind: 'standalone', url: 'https://example.test/ssd',
  });
  store.record_base_unit({
    model_id: 'hp-z2-g9', vendor: 'hp', base_config_price: 1899,
    base_components: [
      { commodity_class: 'cpu', commodity: 'Intel Core Ultra 7 265' },
      // Deliberately NON-canonical name (no trailing SSD) — the read must
      // canonicalize it onto the street row above.
      { commodity_class: 'storage', commodity: '1TB NVMe Gen4 M.2' },
      { commodity_class: 'memory', commodity: '64GB DDR5-6400 ECC' },
      { commodity_class: 'gpu', commodity: 'Intel integrated UHD 770' }, // no street row → missing
    ],
    source_url: 'https://example.test/config',
  });
  const view = store.base_unit_view('dtws');
  check('base unit: one desktop platform', view.length === 1);
  const bu = view[0]!;
  // 1899 − 400 (cpu) − 100 (ssd, canonicalized name) − 101 (robust memory) = 1298
  check('base unit: residual = base − robust street sum (1298)', bu.base_unit != null && approx(bu.base_unit, 1298, 0.01));
  check('base unit: non-canonical component name still backed out', bu.backed_out.some((c) => c.commodity === '1TB NVMe Gen4 M.2 SSD' && c.street === 100));
  check('base unit: unpriced component listed missing', bu.missing.length === 1);
  check('base unit: noisy street window flagged', bu.flags.some((f) => f.includes('noisy')));

  // Negative residual flagged (a loaded config recorded as base).
  store.upsert_sku({
    model_id: 'dell-pp9-t2', vendor: 'dell', family: 'Pro Precision 9', model_name: 'Dell Pro Precision 9 T2',
    form_factor: 'tower', chassis_variant: '', cpu_platform: 'xeon_w' as never,
    status: 'shipping' as never, announced_at: '', launched_at: '', source_url: 'https://example.test', notes: '',
  });
  store.record_base_unit({
    model_id: 'dell-pp9-t2', vendor: 'dell', base_config_price: 350,
    base_components: [{ commodity_class: 'cpu', commodity: 'Intel Core Ultra 7 265' }],
    source_url: 'https://example.test/config2',
  });
  const neg = store.base_unit_view('dtws').find((b) => b.model_id === 'dell-pp9-t2');
  check('base unit: negative residual flagged', !!neg && neg.flags.some((f) => f.includes('NEGATIVE residual')));

  // ── 6. store: trends, class drift, cost outlook ────────────────────────────
  // Backdate a clean rising memory series (~+8%/mo over 45 days) so the memory
  // component gets its own fit. (The earlier 5-point noisy window stays — these
  // older points extend the same series.)
  for (const d of [45, 38, 31, 24, 17] as const) {
    const price = 70 * Math.pow(1.08, (45 - d) / MONTH);
    raw.run('64GB DDR5-6400 ECC', 'memory', 'other', '', Math.round(price * 100) / 100, 'standalone', 'USD', 'https://example.test/m', new Date().toISOString(), days_ago(d));
  }
  const trend = store.commodity_trend('64GB DDR5-6400 ECC');
  check('trend: memory series has a fit', trend.fit != null);
  const table = store.trend_table({ commodity_class: 'memory' });
  check('trend table: memory commodity listed with fit first', table.length >= 1 && table[0]!.fit != null);
  const cdrift = store.class_drift('memory');
  check('class drift: memory rollup exists', cdrift != null && cdrift.n_commodities >= 1);

  const outlook = store.cost_outlook({ ws_class: 'dtws', model_id: 'hp-z2-g9', horizons_months: [6] });
  check('outlook: one platform, one horizon', outlook.platforms.length === 1 && outlook.platforms[0]!.projections.length === 1);
  const plat = outlook.platforms[0]!;
  const proj6 = plat.projections[0]!;
  // Recompute the expected total by hand from the SAME store state: residual +
  // Σ components (own fit → compounded; class-median proxy → compounded; no
  // drift → flat). cpu/storage have no series and no class fit → flat.
  const mem_fit = store.commodity_trend('64GB DDR5-6400 ECC').fit!;
  const mem_street = store.robust_standalone('64GB DDR5-6400 ECC')!.price;
  const expected =
    (bu.base_unit as number) +
    400 + 100 + // cpu + storage held flat
    project_price(mem_street, mem_fit.monthly_pct, 6, mem_fit.sigma_pct).projected;
  check('outlook: projected base config matches hand math', approx(proj6.projected_base_config, expected, 0.05));
  check('outlook: delta vs today positive (memory drifts up)', proj6.delta_abs > 0 && proj6.projected_base_config > 1899);
  check('outlook: residual-held-constant caveat present', plat.caveats.some((c) => c.includes('held constant')));
  check('outlook: market drift includes memory class', outlook.market_drift.some((m) => m.commodity_class === 'memory'));
  check('outlook: confidence degraded (flat-held components)', plat.confidence === 'low');

  // ── 7. read-tool contracts ─────────────────────────────────────────────────
  process.env.HEARTH_KRISTI_DB_PATH = db_path; // tools resolve the singleton from env
  const tools = create_cost_tools({} as ToolDeps);
  const ctx = { intent_id: 'smoke', specialist_id: 'kristi' } as unknown as ToolContext;
  const by_name = new Map(tools.map((t) => [t.name, t]));
  check('tools: cost-analysis tools created', by_name.size === 4 && by_name.has('base_unit_costs') && by_name.has('commodity_trends') && by_name.has('cost_outlook') && by_name.has('perf_per_dollar'));

  const buc = (await by_name.get('base_unit_costs')!.execute({}, ctx)) as { platforms: unknown[]; missing_street_prices: string[] };
  check('tool base_unit_costs: platforms + worklist', Array.isArray(buc.platforms) && buc.platforms.length === 2 && buc.missing_street_prices.length === 1);

  const ct = (await by_name.get('commodity_trends')!.execute({ commodity_class: 'memory' }, ctx)) as { market_drift: unknown[]; trends: unknown[] };
  check('tool commodity_trends: market_drift + trends', Array.isArray(ct.market_drift) && Array.isArray(ct.trends) && ct.trends.length >= 1);

  const co = (await by_name.get('cost_outlook')!.execute({ model_id: 'hp-z2-g9' }, ctx)) as { platforms: Array<{ projections: unknown[] }> };
  check('tool cost_outlook: default horizons applied', co.platforms.length === 1 && co.platforms[0]!.projections.length === 3);

  store.close?.();
} catch (err) {
  console.error('✗ threw:', err instanceof Error ? err.stack : err);
  failures++;
} finally {
  try { rmSync(db_path, { force: true }); rmSync(`${db_path}-wal`, { force: true }); rmSync(`${db_path}-shm`, { force: true }); } catch { /* best effort */ }
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
