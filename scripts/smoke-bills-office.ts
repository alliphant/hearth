/**
 * smoke:bills-office — the Bills office tab's data route, in-process.
 *
 * Mounts create_bills_router under /api/specialists with a fake-auth
 * middleware (no orchestrator; the smoke-research-office harness). Seeds
 * household_services rows + probe proposals directly, then asserts:
 *   - gating: unauth → 401; specialist without monitor_household_services →
 *     404; unknown specialist → 404.
 *   - shape: monthly-equivalent total math (with an unpriced row excluded
 *     from the basis), upcoming window, active roster, inactive tail.
 *   - CORDON: a member-siloed service is invisible to the owner (no
 *     god-view) and visible to that member; the attention list rides the
 *     proposals queue's own visible_to filter; non-probe pending proposals
 *     never appear in attention.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient, type HouseholdServiceRow } from '../src/memory/client';
import { SpecialistRegistry } from '../src/core/specialist';
import { load_extra_capabilities } from '../src/core/capabilities';
import { ProposalsStore } from '../src/core/proposals';
import { create_bills_router } from '../src/app/routes/bills';

let pass = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  pass++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-bills-office-'));
const db = open_db(join(dir, 'smoke.db'));
load_extra_capabilities(join(import.meta.dir, '../config/capabilities.yaml'));

const spec_dir = join(dir, 'specialists');
mkdirSync(spec_dir, { recursive: true });
writeFileSync(
  join(spec_dir, 'kate.yaml'),
  'id: kate\nname: Kate\nrole: Fixture\nvoice: warm\npersona: |\n  Fixture persona for the bills office smoke. Long enough to pass.\nproactive:\n  mode: reactive\ncapabilities:\n  monitor_household_services: true\n',
);
writeFileSync(
  join(spec_dir, 'nocap.yaml'),
  'id: nocap\nname: NoCap\nrole: Fixture\nvoice: warm\npersona: |\n  Fixture persona without the ledger grant. Long enough to pass.\nproactive:\n  mode: reactive\n',
);
const specialists = new SpecialistRegistry(spec_dir);
const memory = new MemoryClient({ vault_root: join(dir, 'vault'), db });
const proposals = new ProposalsStore(db);

// ── seed ledger rows ───────────────────────────────────────────────────
const NOW = new Date();
const soon = new Date(NOW.getTime() + 10 * 86_400_000).toISOString().slice(0, 10); // time-guard-ok: fixture due-date key
const far = new Date(NOW.getTime() + 300 * 86_400_000).toISOString().slice(0, 10); // time-guard-ok: fixture due-date key
const insert = db.prepare(
  `INSERT INTO household_services (id, vendor, vendor_anchor, category, cadence,
     typical_amount_cents, currency, autopay, account_hint, status, confidence,
     sender_domains_json, last_bill_date, next_due_estimate, source, note_path,
     frontmatter_json, mtime, private_to)
   VALUES (@id, @vendor, @vendor_anchor, @category, @cadence, @amt, 'USD', @autopay,
     NULL, @status, 0.9, '[]', @last_bill, @due, 'mail', @note_path, '{}', @mtime, @private_to)`,
);
const seed = (o: {
  id: string; vendor: string; cadence: string | null; amt: number | null;
  status?: string; due?: string | null; private_to?: string;
}) =>
  insert.run({
    '@id': o.id, '@vendor': o.vendor, '@vendor_anchor': `${o.id}.example`,
    '@category': 'utility', '@cadence': o.cadence, '@amt': o.amt, '@autopay': 1,
    '@status': o.status ?? 'active', '@last_bill': '2026-06-20',
    '@due': o.due ?? null, '@note_path': `Household/Services/${o.id}.md`,
    '@mtime': NOW.toISOString(), '@private_to': o.private_to ?? 'household',
  });

seed({ id: 'cox', vendor: 'Cox', cadence: 'monthly', amt: 16000, due: soon });
seed({ id: 'ins', vendor: 'Insurer', cadence: 'annual', amt: 120000, due: far });
seed({ id: 'mystery', vendor: 'Mystery', cadence: null, amt: null }); // unpriced — excluded from the total basis
seed({ id: 'gym', vendor: 'OldGym', cadence: 'monthly', amt: 3000, status: 'lapsed' });
seed({ id: 'sara1', vendor: 'SaraStudio', cadence: 'monthly', amt: 5000, private_to: 'sam' });

// ── seed proposals: two probe flags (one sam-cordoned) + one unrelated ──
proposals.create({
  specialist_id: 'kate', kind: 'action_proposal', user_id: null, execution_kind: 'none',
  payload: { followup_kind: 'expected_bill_missing', vendor: 'Cox', expected_date: '2026-06-23', verb: 'review' },
  rationale: 'The **Cox** bill usually lands around 2026-06-23 and has not shown up yet.',
  signature: { specialist_id: 'kate', kind: 'action_proposal', category: 'expected_bill_missing', anchor: 'cox:missing:2026-06-23' },
});
proposals.create({
  specialist_id: 'kate', kind: 'action_proposal', user_id: 'sam', execution_kind: 'none',
  payload: { followup_kind: 'service_lapsed', vendor: 'SaraStudio', last_heard: '2026-03-01', cycles_quiet: 4.1, verb: 'review' },
  rationale: '**SaraStudio** has gone quiet.',
  signature: { specialist_id: 'kate', kind: 'action_proposal', category: 'service_lapsed', anchor: 'sara1:lapsed:2026-03-01' },
});
proposals.create({
  specialist_id: 'kate', kind: 'action_proposal', user_id: null, execution_kind: 'none',
  payload: { followup_kind: 'birthday_gift', person_name: 'Kim', verb: 'review' },
  rationale: 'Gift for Kim?',
  signature: { specialist_id: 'kate', kind: 'action_proposal', category: 'birthday_gift', anchor: 'p_lee:2026-07-20' },
});

// ── the route, in-process ──────────────────────────────────────────────
let current_user: { id: string; tier: string } | null = { id: 'jasper', tier: 'owner' };
const app = new Hono();
app.use('*', async (ctx, next) => {
  if (current_user) ctx.set('user', current_user as never);
  await next();
});
app.route('/api/specialists', create_bills_router({ memory, specialists, proposals }));

const get = async (path: string) => {
  const res = await app.request(path);
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body: body as Record<string, unknown> };
};

try {
  // gating
  current_user = null;
  assert((await get('/api/specialists/kate/bills')).status === 401, 'gate: unauth → 401');
  current_user = { id: 'jasper', tier: 'owner' };
  assert((await get('/api/specialists/nocap/bills')).status === 404, 'gate: no ledger grant → 404');
  assert((await get('/api/specialists/ghost/bills')).status === 404, 'gate: unknown specialist → 404');

  // owner view
  const r = await get('/api/specialists/kate/bills');
  assert(r.status === 200, 'owner: 200');
  const d = r.body as {
    monthly_total_cents: number; monthly_total_basis: number;
    services: Array<{ vendor: string }>; inactive: Array<{ vendor: string; status: string }>;
    upcoming: Array<{ vendor: string }>; attention: Array<{ vendor: string; kind: string }>;
  };
  // total: Cox 16000 + Insurer 120000/12=10000 = 26000; Mystery unpriced excluded; Sam cordoned out.
  assert(d.monthly_total_cents === 26_000, `owner: monthly-equivalent total (got ${d.monthly_total_cents})`);
  assert(d.monthly_total_basis === 2, 'owner: unpriced row excluded from the basis');
  const vendors = d.services.map((s) => s.vendor);
  assert(vendors.includes('Cox') && vendors.includes('Mystery'), 'owner: active roster present');
  assert(!vendors.includes('SaraStudio'), 'owner: CORDON — no god-view of a member-siloed service');
  assert(d.inactive.some((s) => s.vendor === 'OldGym' && s.status === 'lapsed'), 'owner: inactive tail carries the lapsed service');
  assert(d.upcoming.length === 1 && d.upcoming[0]!.vendor === 'Cox', 'owner: upcoming window (10d in, 300d out)');
  assert(d.attention.length === 1 && d.attention[0]!.vendor === 'Cox' && d.attention[0]!.kind === 'expected_bill_missing', 'owner: attention = the probe flag only (no sam flag, no birthday proposal)');

  // member view
  current_user = { id: 'sam', tier: 'household' };
  const rs = await get('/api/specialists/kate/bills');
  const ds = rs.body as typeof d;
  const svendors = ds.services.map((s) => s.vendor);
  assert(svendors.includes('SaraStudio') && svendors.includes('Cox'), 'member: sees her own + household services');
  assert(ds.attention.length === 1 && ds.attention[0]!.kind === 'service_lapsed', 'member: attention = her cordoned flag (owner-global system view withheld from non-owner queue rules)');

  console.log(`\n✅ smoke:bills-office — ${pass} checks passed`);
} catch (e) {
  console.error(`\n❌ smoke:bills-office FAILED after ${pass} checks`);
  console.error(e);
  process.exitCode = 1;
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
