/**
 * smoke:kristi-tiering — self-contained (temp DB, no LLM, no network).
 *
 * Exercises the IDC class × tier taxonomy plumbing end-to-end at the store
 * layer: the `tier` column migration, `set_swimlane` writing slug + tier, the
 * swimlane grouping that keeps an ENTRY box out of an EXPERT lane (the Z1 ↔ Pro
 * Precision 9 conflation this work fixes), and the `coverage_summary` gap map
 * that drives recording. Running the real code path would have caught the stray
 * NUL bytes that a grep-only check missed.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KristiWorkstationsStore } from '@memory/stores/kristi_workstations';

const db_path = join(tmpdir(), `kristi-tiering-smoke-${process.pid}.db`);
let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures++;
}

try {
  const store = new KristiWorkstationsStore(db_path);

  // Seed cross-OEM SKUs spanning entry → expert + a mobile.
  const seed = [
    { model_id: 'hp-z1-g1i', vendor: 'hp', family: 'Z1', model_name: 'HP Z1 Tower G1i', form_factor: 'tower' },
    { model_id: 'lenovo-thinkstation-p3', vendor: 'lenovo', family: 'ThinkStation P3', model_name: 'Lenovo ThinkStation P3', form_factor: 'tower' },
    { model_id: 'dell-pro-precision-9-t2', vendor: 'dell', family: 'Pro Precision 9', model_name: 'Dell Pro Precision 9 T2', form_factor: 'tower' },
    { model_id: 'hp-zbook-fury-g1i', vendor: 'hp', family: 'ZBook Fury', model_name: 'HP ZBook Fury G1i', form_factor: 'mobile' },
  ] as const;
  for (const s of seed) {
    store.upsert_sku({
      model_id: s.model_id, vendor: s.vendor, family: s.family, model_name: s.model_name,
      form_factor: s.form_factor, chassis_variant: '', cpu_platform: 'intel_xeon_w' as never,
      status: 'shipping' as never, announced_at: '', launched_at: '', source_url: 'https://example.test', notes: '',
    });
  }

  // Simulate cluster_swimlanes output: slug = `<class> · <tier>`, tier stored.
  store.set_swimlane('hp-z1-g1i', 'desktop · entry', 'Z1 is HP entry value tower', 'entry');
  store.set_swimlane('lenovo-thinkstation-p3', 'desktop · entry', 'P3 is Lenovo entry', 'entry');
  store.set_swimlane('dell-pro-precision-9-t2', 'desktop · expert', 'Pro Precision 9 is Dell expert line', 'expert');
  store.set_swimlane('hp-zbook-fury-g1i', 'mobile · performance', 'ZBook Fury performance mobile', 'performance');

  // The categorization invariant: Z1 (entry) and Pro Precision 9 (expert) must
  // NOT share a lane; Z1 and the Lenovo P3 (both entry) MUST.
  const lanes = new Map(store.swimlane_view().map((l) => [l.swimlane, l.members.map((m) => m.model_id)]));
  const z1_lane = [...lanes.entries()].find(([, ms]) => ms.includes('hp-z1-g1i'))?.[0];
  const pp9_lane = [...lanes.entries()].find(([, ms]) => ms.includes('dell-pro-precision-9-t2'))?.[0];
  check('Z1 filed under desktop · entry', z1_lane === 'desktop · entry');
  check('Pro Precision 9 filed under desktop · expert', pp9_lane === 'desktop · expert');
  check('Z1 and Pro Precision 9 are NOT co-located', z1_lane !== pp9_lane);
  check('Z1 and Lenovo P3 share the entry lane', (lanes.get('desktop · entry') ?? []).includes('lenovo-thinkstation-p3'));

  // Coverage map: filled cells present, empty cells surfaced.
  const cells = store.coverage_summary();
  const cell = (cls: string, vendor: string, tier: string) =>
    cells.find((c) => c.ws_class === cls && c.vendor === vendor && c.tier === tier)?.count ?? -1;
  check('coverage: desktop·entry / hp = 1', cell('dtws', 'hp', 'entry') === 1);
  check('coverage: desktop·entry / lenovo = 1', cell('dtws', 'lenovo', 'entry') === 1);
  check('coverage: desktop·expert / dell = 1', cell('dtws', 'dell', 'expert') === 1);
  check('coverage: mobile / lenovo = 0 (empty cell surfaced)', cell('mws', 'lenovo', 'performance') === 0);
  check('coverage: edge-ai / nvidia cell exists', cells.some((c) => c.ws_class === 'edge_ai' && c.vendor === 'nvidia'));
  check('coverage total_recorded == 4', cells.reduce((n, c) => n + c.count, 0) === 4);

  store.close?.();
} catch (err) {
  console.error('✗ threw:', err instanceof Error ? err.stack : err);
  failures++;
} finally {
  try { rmSync(db_path, { force: true }); rmSync(`${db_path}-wal`, { force: true }); rmSync(`${db_path}-shm`, { force: true }); } catch { /* best effort */ }
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
