/**
 * smoke:kristi-leaks — self-contained (temp DB, no LLM, no network).
 *
 * Exercises the VERIFIED leak radar end-to-end at the store + verdict-apply
 * layers: an unverified sighting is NEVER a leak row (pending count only),
 * the deterministic catalog match clears known SKUs, web-evidence verdicts
 * stamp freshness + provenance, an in_market verdict AUTO-RECORDS the
 * identified SKU (catalog enrichment → future sightings of the line match
 * deterministically), and pre_launch verdicts expire into the re-verify
 * worklist so a leak that launches retires itself.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KristiWorkstationsStore } from '@memory/stores/kristi_workstations';
import { apply_reconcile_verdicts } from '@specialists/kristi/tools/reconcile_leaks';

const db_path = join(tmpdir(), `kristi-leaks-smoke-${process.pid}.db`);
let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures++;
}

try {
  const store = new KristiWorkstationsStore(db_path);

  // Known universe: one catalogued shipping SKU.
  store.upsert_sku({
    model_id: 'dell-precision-7960', vendor: 'dell', family: 'Precision', model_name: 'Dell Precision 7960 Tower',
    form_factor: 'tower', chassis_variant: '', cpu_platform: 'xeon_w' as never, status: 'shipping' as never,
    announced_at: '', launched_at: '2023-04-01', source_url: 'https://example.test/7960', notes: '',
  });

  // Four fresh sightings: A matches the catalog, B is a genuine leak, C is a
  // shipping machine the catalog doesn't know yet, D stays unverified.
  const sightings = [
    { registry: 'dmtf', cert_model_string: 'Dell Precision 7960 Tower Workstation' },
    { registry: 'energystar', cert_model_string: 'hp-z6-g6-vision-x1' },
    { registry: 'tco', cert_model_string: 'Lenovo ThinkStation P3 Ultra 30HA' },
    { registry: 'dmtf', cert_model_string: 'dell-pro-max-16-mc16250' },
  ] as const;
  for (const s of sightings) {
    store.record_cert_sighting({ registry: s.registry, cert_model_string: s.cert_model_string, raw_url: 'https://registry.test/x' });
  }

  // THE invariant Jasper asked for: an unverified sighting is NOT a leak.
  check('radar empty while everything is unverified (only NEW platforms ever show)', store.leak_radar().length === 0);
  check('pending count carries the unverified sightings', store.cert_watch_totals().pending === 4);

  // Deterministic catalog pass clears the known SKU's sighting.
  const matched = store.reconcile_sightings_against_catalog();
  check('catalog match reconciles the tracked SKU sighting', matched >= 1);
  check('radar still empty after catalog pass', store.leak_radar().length === 0);

  // Web-evidence verdicts (parsed rows as the LLM would return them).
  const pending = store.unclassified_sightings(10).filter((s) => s.cert_model_string !== 'dell-pro-max-16-mc16250');
  const verdicts = apply_reconcile_verdicts(store, pending, [
    {
      cert_model_string: 'hp-z6-g6-vision-x1',
      market_status: 'pre_launch',
      reason: 'no product page, review, or store listing in evidence',
      evidence_url: 'https://example.test/evB',
    },
    {
      cert_model_string: 'Lenovo ThinkStation P3 Ultra 30HA',
      market_status: 'in_market',
      reason: 'shipping product — vendor page + reviews in evidence',
      evidence_url: 'https://example.test/evC',
      product: {
        vendor: 'lenovo', model_name: 'Lenovo ThinkStation P3 Ultra',
        family: 'ThinkStation P3', form_factor: 'sff', status: 'shipping',
      },
    },
  ]);
  check('verdicts applied (2 judged, 1 each way, 1 enriched)',
    verdicts.judged === 2 && verdicts.pre_launch === 1 && verdicts.in_market === 1 && verdicts.catalog_enriched === 1);

  const radar = store.leak_radar();
  check('radar shows ONLY the verified pre-launch string', radar.length === 1 && radar[0]!.cert_model_string === 'hp-z6-g6-vision-x1');
  check('verdict carries freshness + evidence provenance', !!radar[0]!.market_checked_at && radar[0]!.evidence_url === 'https://example.test/evB');
  check('class badge counts only verified leaks', store.leak_counts_by_class().dtws === 1);

  // Catalog enrichment: the in-market machine is now a tracked SKU, its
  // sighting is matched, and the NEXT sighting of the same line reconciles
  // deterministically with no LLM at all.
  const enriched = store.get_sku('lenovo-thinkstation-p3-ultra');
  check('in_market verdict auto-recorded the SKU', !!enriched && enriched.vendor === 'lenovo' && enriched.status === 'shipping');
  check('enriched SKU cites the web evidence', !!enriched && enriched.source_url === 'https://example.test/evC');
  store.record_cert_sighting({ registry: 'energystar', cert_model_string: 'ThinkStation P3 Ultra 30HB', raw_url: 'https://registry.test/y' });
  store.reconcile_sightings_against_catalog();
  const sibling = store.db
    .prepare(`SELECT matched_sku FROM cert_sightings WHERE cert_model_string='ThinkStation P3 Ultra 30HB'`)
    .get() as { matched_sku: string };
  check('future sighting of the enriched line matches deterministically', sibling.matched_sku === 'lenovo-thinkstation-p3-ultra');

  const totals = store.cert_watch_totals();
  check('coverage: 5 watching, 3 accounted, 1 pending', totals.watching === 5 && totals.accounted === 3 && totals.pending === 1);

  // Expiry: a fresh pre_launch verdict is not due; a 20-day-old one is — and
  // re-verifying it as in_market retires it from the radar on its own.
  check('fresh pre_launch verdict not yet due a re-check', store.stale_pre_launch(10).length === 0);
  store.db
    .prepare(`UPDATE cert_sightings SET market_checked_at=@t WHERE cert_model_string='hp-z6-g6-vision-x1'`)
    .run({ '@t': new Date(Date.now() - 20 * 86_400_000).toISOString() });
  const stale = store.stale_pre_launch(10);
  check('20-day-old pre_launch verdict enters the re-verify worklist', stale.length === 1 && stale[0]!.cert_model_string === 'hp-z6-g6-vision-x1');
  apply_reconcile_verdicts(store, stale, [
    { cert_model_string: 'hp-z6-g6-vision-x1', market_status: 'in_market', reason: 'launched since last check', evidence_url: 'https://example.test/launch' },
  ]);
  check('a leak that launches retires itself off the radar', store.leak_radar().length === 0);

  store.close?.();
} catch (err) {
  console.error('✗ threw:', err instanceof Error ? err.stack : err);
  failures++;
} finally {
  try { rmSync(db_path, { force: true }); rmSync(`${db_path}-wal`, { force: true }); rmSync(`${db_path}-shm`, { force: true }); } catch { /* best effort */ }
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
