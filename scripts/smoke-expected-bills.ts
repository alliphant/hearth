/**
 * smoke:expected-bills — Phase C of the executive-assistant endgame: the
 * EXPECTED-but-missing bill probe + lapse edge over the Services & Bills
 * ledger (detect_bill_edges + Kate's scan_expected_bills job).
 *
 * Self-contained: temp db + vault, no LLM, no network. Exercises:
 *   - detect_bill_edges pure matrix: missing-bill fires past grace, muted by
 *     ANY inbound vendor mail this cycle, silent before grace; the lapse edge
 *     at ≥2.5 cadence cycles quiet (and it PREEMPTS missing); non-active /
 *     low-confidence / unknown-cadence / no-evidence rows skipped;
 *     null-confidence (told-first) rows trusted; deterministic ordering.
 *   - the tool end-to-end: kill switch dark → no-op; edges file cordoned
 *     once-only advisory proposals (stable anchors — a re-run and a later
 *     day in the same cycle never re-file); a member-private service's
 *     proposal cordons to that member; audit row written.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient, type HouseholdServiceRow } from '../src/memory/client';
import { ProposalsStore } from '../src/core/proposals';
import { build_last_mail_by_root, detect_bill_edges } from '../src/core/household_services';
import { make_scan_expected_bills } from '../src/specialists/kate/tools/scan_expected_bills';
import type { ToolContext } from '../src/core/tool';

let pass = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  pass++;
}

const tmp = mkdtempSync(join(tmpdir(), 'hearth-bills-'));
const prev_flag = process.env.HEARTH_BILL_ANTICIPATION;

/** 2026-07-04 noon UTC — every date below is relative to this. */
const NOW = new Date('2026-07-04T12:00:00Z');

let seq = 0;
function svc(over: Partial<HouseholdServiceRow>): HouseholdServiceRow {
  seq += 1;
  return {
    id: `hs_test${seq}`,
    vendor: `Vendor${seq}`,
    vendor_anchor: `vendor${seq}.com`,
    category: 'utility',
    cadence: 'monthly',
    typical_amount_cents: 16000,
    currency: 'USD',
    autopay: null,
    account_hint: null,
    status: 'active',
    confidence: 0.9,
    sender_domains_json: '[]',
    last_bill_date: null,
    next_due_estimate: null,
    source: 'mail',
    note_path: `Household/Services/vendor${seq}.md`,
    frontmatter_json: '{}',
    mtime: NOW.toISOString(),
    private_to: 'household',
    ...over,
  };
}

async function main(): Promise<void> {
  // ── 1. the pure detector matrix ───────────────────────────────────────
  const no_mail = new Map<string, string>();

  // monthly, last bill 2026-05-24 → expected 06-23, 11 days late ≥ grace 8 → fires
  const missing = svc({ vendor: 'Cox', vendor_anchor: 'cox.com', last_bill_date: '2026-05-24' });
  let edges = detect_bill_edges([missing], no_mail, NOW);
  assert(edges.length === 1 && edges[0]!.kind === 'missing_bill', 'pure: missing bill past grace fires');
  const e0 = edges[0]!;
  assert(e0.kind === 'missing_bill' && e0.expected_date === '2026-06-23' && e0.days_late === 11, 'pure: expected date + days_late from cadence math');
  assert(e0.kind === 'missing_bill' && e0.grace_days === 8, 'pure: monthly grace ≈ 8 days');

  // same service, vendor mail arrived after (expected − lead) → muted
  const heard = build_last_mail_by_root([{ from_addr: 'billing@email.cox.com', last_date: '2026-06-25T10:00:00Z' }]);
  assert(detect_bill_edges([missing], heard, NOW).length === 0, 'pure: ANY inbound vendor mail this cycle mutes the edge');
  // mail BEFORE the cycle's lead window doesn't mute
  const old_mail = build_last_mail_by_root([{ from_addr: 'billing@cox.com', last_date: '2026-05-30T10:00:00Z' }]);
  assert(detect_bill_edges([missing], old_mail, NOW).length === 1, 'pure: pre-cycle vendor mail does not mute');

  // not yet past grace (expected 06-29, 5 days late < 8) → silent
  const early = svc({ last_bill_date: '2026-05-30' });
  assert(detect_bill_edges([early], no_mail, NOW).length === 0, 'pure: within grace → no edge');

  // quiet ≥ 2.5 cycles (monthly: 75d) → lapsed, and it PREEMPTS missing
  const lapsed = svc({ vendor: 'Progressive', last_bill_date: '2026-04-01' });
  edges = detect_bill_edges([lapsed], no_mail, NOW);
  assert(edges.length === 1 && edges[0]!.kind === 'lapsed', 'pure: 2.5 cycles quiet → lapsed (not missing)');
  const l0 = edges[0]!;
  assert(l0.kind === 'lapsed' && l0.quiet_days === 94 && l0.cycles_quiet === 3.1, 'pure: quiet_days + cycles from cadence');
  // recent vendor mail resets last_heard → neither edge... (mail 06-25 → 9 quiet days)
  const lapsed_heard = build_last_mail_by_root([{ from_addr: 'no-reply@progressive.com', last_date: '2026-06-25T00:00:00Z' }]);
  const lapsed2 = svc({ vendor: 'Progressive', vendor_anchor: 'progressive.com', last_bill_date: '2026-04-01' });
  assert(detect_bill_edges([lapsed2], lapsed_heard, NOW).length === 0, 'pure: recent vendor mail resets the quiet clock');

  // skips: non-active, low confidence, unknown cadence, no evidence
  assert(detect_bill_edges([svc({ status: 'lapsed', last_bill_date: '2026-01-01' })], no_mail, NOW).length === 0, 'pure: non-active skipped');
  assert(detect_bill_edges([svc({ confidence: 0.3, last_bill_date: '2026-05-24' })], no_mail, NOW).length === 0, 'pure: low-confidence learner row skipped');
  assert(detect_bill_edges([svc({ confidence: null, last_bill_date: '2026-05-24' })], no_mail, NOW).length === 1, 'pure: null confidence (told-first) is trusted');
  assert(detect_bill_edges([svc({ cadence: 'irregular', last_bill_date: '2026-01-01' })], no_mail, NOW).length === 0, 'pure: unknown/irregular cadence skipped');
  assert(detect_bill_edges([svc({ last_bill_date: null })], no_mail, NOW).length === 0, 'pure: no date evidence at all skipped');

  // lapse purely from learned sender domains (no last_bill_date)
  const domains_only = svc({
    vendor: 'OldGym',
    vendor_anchor: 'oldgym.example',
    last_bill_date: null,
    sender_domains_json: JSON.stringify(['mail.oldgym.example']),
  });
  const gym_mail = build_last_mail_by_root([{ from_addr: 'hello@mail.oldgym.example', last_date: '2026-03-01T00:00:00Z' }]);
  edges = detect_bill_edges([domains_only], gym_mail, NOW);
  assert(edges.length === 1 && edges[0]!.kind === 'lapsed', 'pure: lapse detectable from sender-domain mail alone');

  // deterministic ordering (by vendor) + determinism
  const pair = [svc({ vendor: 'Zeta', last_bill_date: '2026-05-24' }), svc({ vendor: 'Alpha', last_bill_date: '2026-05-24' })];
  const o1 = detect_bill_edges(pair, no_mail, NOW).map((e) => e.vendor);
  const o2 = detect_bill_edges([...pair].reverse(), no_mail, NOW).map((e) => e.vendor);
  assert(JSON.stringify(o1) === JSON.stringify(['Alpha', 'Zeta']) && JSON.stringify(o1) === JSON.stringify(o2), 'pure: deterministic vendor ordering regardless of input order');

  // ── 2. the tool end-to-end ────────────────────────────────────────────
  const db = open_db(join(tmp, 'hearth.db'));
  const memory = new MemoryClient({ vault_root: join(tmp, 'vault'), db });
  const proposals = new ProposalsStore(db);

  const insert = db.prepare(
    `INSERT INTO household_services (id, vendor, vendor_anchor, category, cadence,
       typical_amount_cents, currency, autopay, account_hint, status, confidence,
       sender_domains_json, last_bill_date, next_due_estimate, source, note_path,
       frontmatter_json, mtime, private_to)
     VALUES (@id, @vendor, @vendor_anchor, @category, @cadence, @typical_amount_cents,
       @currency, @autopay, @account_hint, @status, @confidence, @sender_domains_json,
       @last_bill_date, @next_due_estimate, @source, @note_path, @frontmatter_json,
       @mtime, @private_to)`,
  );
  const seed = (row: HouseholdServiceRow) =>
    insert.run({
      '@id': row.id, '@vendor': row.vendor, '@vendor_anchor': row.vendor_anchor,
      '@category': row.category, '@cadence': row.cadence,
      '@typical_amount_cents': row.typical_amount_cents, '@currency': row.currency,
      '@autopay': row.autopay, '@account_hint': row.account_hint, '@status': row.status,
      '@confidence': row.confidence, '@sender_domains_json': row.sender_domains_json,
      '@last_bill_date': row.last_bill_date, '@next_due_estimate': row.next_due_estimate,
      '@source': row.source, '@note_path': row.note_path,
      '@frontmatter_json': row.frontmatter_json, '@mtime': row.mtime, '@private_to': row.private_to,
    });

  const cox = svc({ vendor: 'Cox', vendor_anchor: 'cox.com', last_bill_date: '2026-05-24' });
  const prog = svc({ vendor: 'Progressive', vendor_anchor: 'progressive.com', last_bill_date: '2026-04-01' });
  const sams = svc({ vendor: 'SaraStudio', vendor_anchor: 'sarastudio.example', last_bill_date: '2026-05-20', private_to: 'sam' });
  seed(cox);
  seed(prog);
  seed(sams);

  const mail_stub = { latest_inbound_by_sender: () => [] as Array<{ from_addr: string; last_date: string }> };
  const tool = make_scan_expected_bills({ memory, proposals, mail: mail_stub });
  const ctx = { memory, now: NOW, intent_id: 'i-bills', specialist_id: 'kate' } as unknown as ToolContext;

  // kill switch dark → pure no-op
  delete process.env.HEARTH_BILL_ANTICIPATION;
  const dark = await tool.execute({}, ctx);
  assert(dark.enabled === false && dark.filed === 0 && proposals.list({}).length === 0, 'tool: DARK by default → no proposals');

  process.env.HEARTH_BILL_ANTICIPATION = '1';
  const r1 = await tool.execute({}, ctx);
  assert(r1.enabled === true && r1.services === 3, 'tool: scans active ledger rows');
  assert(r1.edges === 3 && r1.filed === 3, 'tool: cox missing + progressive lapsed + sam missing filed');

  const all = proposals.list({});
  const payload_of = (p: { payload_json: string }) =>
    JSON.parse(p.payload_json) as { vendor?: string; followup_kind?: string };
  const cox_p = all.find((p) => payload_of(p).vendor === 'Cox');
  assert(cox_p != null && cox_p.kind === 'action_proposal' && cox_p.user_id == null, 'tool: household service → owner-global proposal');
  assert(cox_p!.rationale_md.includes('usually lands around 2026-06-23'), 'tool: "usually lands around" phrasing, never overdue');
  assert(cox_p!.rationale_md.includes('$160.00 monthly'), 'tool: typical amount rendered');
  const prog_p = all.find((p) => payload_of(p).vendor === 'Progressive');
  assert(prog_p != null && payload_of(prog_p).followup_kind === 'service_lapsed', 'tool: lapse edge files service_lapsed');
  const sara_p = all.find((p) => payload_of(p).vendor === 'SaraStudio');
  assert(sara_p != null && sara_p.user_id === 'sam', 'tool: CORDON — a member-private service proposes to that member');

  // re-run same day + a later day inside the same cycle → no re-file
  const r2 = await tool.execute({}, ctx);
  assert(r2.filed === 0, 'tool: same-day re-run files nothing (edge dedup)');
  const later = { ...ctx, now: new Date('2026-07-10T12:00:00Z') } as unknown as ToolContext;
  const r3 = await tool.execute({}, later);
  assert(r3.filed === 0 && proposals.list({}).length === 3, 'tool: later day, same cycle → stable anchor, no re-file');

  // audit row
  const audit = db
    .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE tool_name = 'expected_bills_scan'`)
    .get() as { n: number } | null;
  assert(audit != null && audit.n >= 2, 'tool: audit rows written');

  db.close();
  console.log(`\n✅ smoke:expected-bills — ${pass} checks passed`);
}

main()
  .catch((e) => {
    console.error(`\n❌ smoke:expected-bills FAILED after ${pass} checks`);
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    if (prev_flag === undefined) delete process.env.HEARTH_BILL_ANTICIPATION;
    else process.env.HEARTH_BILL_ANTICIPATION = prev_flag;
    rmSync(tmp, { recursive: true, force: true });
  });
