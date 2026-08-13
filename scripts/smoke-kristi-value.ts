/**
 * smoke:kristi-value — self-contained (temp DB, no LLM, no network).
 *
 * Exercises the value/health/alert layers added 2026-06-10:
 *   - benchmark scores: the canonical-key + class + window gate, name
 *     canonicalization onto the price table's keys, the worklist ordering
 *     (street-priced parts first, scored parts excluded), and the
 *     perf-per-dollar join (score ÷ robust street; null when unpriced).
 *   - data_health: spec-completeness + price-freshness per cell, and the
 *     worklist naming stale/thin cells ("stale beats missing").
 *   - cost_watch decision logic (pure): materiality thresholds over the
 *     outlook + the sync_meta dedup (new / bucket-moved / re-ping window).
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KristiWorkstationsStore } from '@memory/stores/kristi_workstations';
import { validate_benchmark_score, validate_commodity_price } from '@specialists/kristi/cost_model';
import { decide_alerts, should_fire, REPING_DAYS } from '@specialists/kristi/tools/cost_watch';
import { ground_price_to_page } from '@specialists/kristi/tools/drive_configurator';

const db_path = join(tmpdir(), `kristi-value-smoke-${process.pid}.db`);
let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures++;
}

try {
  // ── 1. benchmark gate (pure) ───────────────────────────────────────────────
  check('bench gate: unknown benchmark rejected', !validate_benchmark_score('cinebench_r23', 'cpu', 30_000).ok);
  check('bench gate: class mismatch rejected (G3D is not a CPU benchmark)', !validate_benchmark_score('passmark_g3d', 'cpu', 20_000).ok);
  check('bench gate: implausible score rejected (CPU Mark 47)', !validate_benchmark_score('passmark_cpu', 'cpu', 47).ok);
  check('bench gate: sane score accepted', validate_benchmark_score('passmark_cpu', 'cpu', 62_000).ok);

  // ── 1a-bis. per-GB floors (the live "$32 for a 32GB ECC RDIMM" class) ─────
  check('floor: $32 for 32GB memory rejected (first observation, no history needed)',
    !validate_commodity_price('memory', 32, null, '32GB DDR5-6400 ECC RDIMM').ok);
  check('floor: $160 for 32GB memory accepted', validate_commodity_price('memory', 160, null, '32GB DDR5-6400 ECC RDIMM').ok);
  check('floor: $25 for a 2TB SSD rejected (~$0.012/GB)', !validate_commodity_price('storage', 25, null, '2TB NVMe Gen4 M.2 SSD').ok);
  check('floor: no capacity in the name → no floor applied', validate_commodity_price('memory', 32, null, 'DDR5 ECC RDIMM upgrade').ok);

  // ── 1b. base-price page grounding (the live Lenovo ×100 misread class) ────
  const page = 'Est Value :: $1,529.00\nFREE Delivery :: $1,467.84\nupgrade +$109.00';
  check('ground: page-literal price accepted', ground_price_to_page(1467.84, page) === 1467.84);
  check('ground: cents-dropped ×100 misread self-corrects (146784 → 1467.84)', ground_price_to_page(146784, page) === 1467.84);
  check('ground: a number the page never shows is rejected', ground_price_to_page(2999, page) === null);

  const store = new KristiWorkstationsStore(db_path);

  // ── 2. benchmark store: record + canonicalize + worklist + ppd ────────────
  // Street-priced GPU (standalone) + an unpriced GPU option on a SKU.
  store.record_commodity_price({
    commodity: 'NVIDIA RTX 4000 Ada', commodity_class: 'gpu', vendor: 'other',
    price: 1250, price_kind: 'standalone', url: 'https://example.test/street',
  });
  store.upsert_sku({
    model_id: 'hp-z2-tower-g1i', vendor: 'hp', family: 'Z2', model_name: 'HP Z2 Tower G1i',
    form_factor: 'tower', chassis_variant: '', cpu_platform: 'core_ultra' as never, status: 'shipping' as never,
    announced_at: '', launched_at: '', source_url: 'https://example.test', notes: '',
  });
  store.record_gpu_option({
    model_id: 'hp-z2-tower-g1i', gpu_name: 'NVIDIA RTX 2000 Ada Graphics', gpu_class: 'rtx_pro_ada',
    vram_gb: 16, tdp_w: 70, source_url: 'https://example.test',
  });

  // $0 'included' base options must STORE (the configurator records them; the
  // gate's positive-number check used to silently reject them), and they must
  // enter the street-lookup worklist so base components get priced.
  const inc = store.record_commodity_price({
    commodity: 'Intel Core Ultra 5 225', commodity_class: 'cpu', vendor: 'hp',
    model_id: 'hp-z2-tower-g1i', price: 0, price_kind: 'included', url: 'https://example.test/config',
  });
  check('included: $0 base option stores', inc.stored);
  check('included: base component enters the street-lookup worklist',
    store.delta_commodities(['cpu']).some((d) => d.commodity === 'Intel Core Ultra 5 225'));

  const wl = store.unbenchmarked_components(10);
  check('worklist: street-priced part first', wl[0]?.component === 'NVIDIA RTX 4000 Ada' && wl[0]?.has_street === true);
  check('worklist: gpu_options name canonicalized in ("Graphics" stripped)', wl.some((w) => w.component === 'NVIDIA RTX 2000 Ada'));

  const b1 = store.record_benchmark_score({
    component: 'NVIDIA RTX 4000 Ada GPU', // non-canonical — must normalize onto the priced key
    component_class: 'gpu', benchmark: 'passmark_g3d', score: 26_500, source_url: 'https://videocardbenchmark.test/x',
  });
  check('bench store: stored + name canonicalized onto the price key', b1.stored && store.benchmark_scores_for('NVIDIA RTX 4000 Ada').length === 1);
  check('bench store: implausible score refused with reason', !store.record_benchmark_score({
    component: 'NVIDIA RTX 2000 Ada', component_class: 'gpu', benchmark: 'passmark_g3d', score: 12, source_url: 'https://x.test',
  }).stored);
  check('worklist: scored part drops off', !store.unbenchmarked_components(10).some((w) => w.component === 'NVIDIA RTX 4000 Ada'));

  store.record_benchmark_score({
    component: 'NVIDIA RTX 2000 Ada', component_class: 'gpu', benchmark: 'passmark_g3d', score: 12_400, source_url: 'https://videocardbenchmark.test/y',
  });
  const ppd = store.perf_per_dollar({ component_class: 'gpu' });
  const priced = ppd.find((p) => p.component === 'NVIDIA RTX 4000 Ada');
  const unpriced = ppd.find((p) => p.component === 'NVIDIA RTX 2000 Ada');
  check('ppd: score ÷ robust street (26500/1250 = 21.2)', priced?.score_per_dollar === 21.2);
  check('ppd: scored-but-unpriced row listed with null ppd (the worklist)', !!unpriced && unpriced.score_per_dollar === null);
  check('ppd: priced row ranks above unpriced within the benchmark', ppd.indexOf(priced!) < ppd.indexOf(unpriced!));

  // ── 3. data_health ─────────────────────────────────────────────────────────
  // Z2: 3 comparable metrics + a fresh price → healthy. A second SKU: thin + stale.
  store.record_spec('hp-z2-tower-g1i', 'Max memory', '128 GB', 'GB', 'https://example.test');
  store.record_spec('hp-z2-tower-g1i', 'Max cores', '24 cores', 'cores', 'https://example.test');
  store.record_spec('hp-z2-tower-g1i', 'PSU', '700 W', 'W', 'https://example.test');
  store.record_price({ model_id: 'hp-z2-tower-g1i', config_label: 'base', segment: 'prosumer', list_price: 1899, sale_price: null, url: 'https://example.test' });
  store.upsert_sku({
    model_id: 'dell-precision-3680', vendor: 'dell', family: 'Precision', model_name: 'Dell Precision 3680 Tower',
    form_factor: 'tower', chassis_variant: '', cpu_platform: 'core_ultra' as never, status: 'shipping' as never,
    announced_at: '', launched_at: '', source_url: 'https://example.test', notes: '',
  });
  const health = store.data_health();
  const hp_cell = health.cells.find((c) => c.vendor === 'hp');
  const dell_cell = health.cells.find((c) => c.vendor === 'dell');
  check('health: HP cell healthy (3 metrics + fresh price)', hp_cell?.specs_ok === 1 && hp_cell?.price_fresh === 1);
  check('health: Dell cell thin + unpriced', dell_cell?.specs_ok === 0 && dell_cell?.price_fresh === 0);
  check('health: worklist names the thin-spec cell', health.worklist.some((w) => w.includes('dell') && w.includes('thin')));
  check('health: worklist names the no-fresh-price cell', health.worklist.some((w) => w.includes('dell') && w.includes('no system price')));
  check('health: totals roll up', health.totals.skus === 2 && health.totals.specs_ok === 1);

  // ── 4. cost_watch decision logic (pure) ────────────────────────────────────
  const outlook = {
    as_of: '', horizons_months: [6],
    market_drift: [
      { commodity_class: 'memory', monthly_pct: 7.8, n_commodities: 3 }, // fires
      { commodity_class: 'gpu', monthly_pct: 9.0, n_commodities: 1 },    // too few fits
      { commodity_class: 'storage', monthly_pct: 1.2, n_commodities: 4 }, // under threshold
    ],
    platforms: [
      {
        model_id: 'hp-z2-tower-g1i', vendor: 'hp', base_config_price: 1899, platform_residual: 1235,
        components: [], confidence: 'medium' as const, missing: [], flags: [], caveats: [],
        projections: [{ months: 6, projected_base_config: 2031, delta_abs: 132, delta_pct: 7.0, low: 1922, high: 2140 }], // fires (≥5%)
      },
      {
        model_id: 'dell-precision-3680', vendor: 'dell', base_config_price: 1169, platform_residual: 825,
        components: [], confidence: 'medium' as const, missing: [], flags: [], caveats: [],
        projections: [{ months: 6, projected_base_config: 1192, delta_abs: 23, delta_pct: 2.0, low: 1150, high: 1240 }], // quiet
      },
    ],
  } as ReturnType<KristiWorkstationsStore['cost_outlook']>;
  const alerts = decide_alerts(outlook);
  check('watch: memory class drift fires; 1-fit gpu and flat storage stay quiet', alerts.filter((a) => a.key.startsWith('class:')).length === 1);
  check('watch: 7% platform move fires; 2% stays quiet', alerts.filter((a) => a.key.startsWith('platform:')).length === 1 && alerts.some((a) => a.key === 'platform:hp-z2-tower-g1i'));

  const now = Date.now();
  check('watch dedup: new alert fires', should_fire(null, '8', now));
  check('watch dedup: same bucket, fresh → suppressed', !should_fire({ content_hash: '8', synced_at: new Date(now - 2 * 86_400_000).toISOString() }, '8', now));
  check('watch dedup: bucket moved → re-fires early', should_fire({ content_hash: '8', synced_at: new Date(now - 2 * 86_400_000).toISOString() }, '11', now));
  check(`watch dedup: same bucket past ${REPING_DAYS}d → re-pings`, should_fire({ content_hash: '8', synced_at: new Date(now - (REPING_DAYS + 1) * 86_400_000).toISOString() }, '8', now));

  store.close?.();
} catch (err) {
  console.error('✗ threw:', err instanceof Error ? err.stack : err);
  failures++;
} finally {
  try { rmSync(db_path, { force: true }); rmSync(`${db_path}-wal`, { force: true }); rmSync(`${db_path}-shm`, { force: true }); } catch { /* best effort */ }
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
