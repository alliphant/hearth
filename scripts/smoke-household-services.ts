/**
 * smoke:household-services — the Services & Bills ledger (Phase A of Kate's
 * executive-assistant endgame, 2026-07-04).
 *
 * Self-contained: temp db + vault, scripted LLM, no network. Exercises:
 *   - pure core: root_domain / amount extraction / median / due-date math vs
 *     a FIXED ctx.now / monthly-equivalent totals / stable ids+paths
 *   - clustering determinism (same input → same candidates, same order),
 *     the min_messages gate, the heterogeneous-local-parts drop, and the
 *     structural authentic_reply exclusion
 *   - the learner end-to-end: scripted classifier → household_service note
 *     upsert; idempotency (re-run refreshes the SAME note, never duplicates)
 *   - kill switch (HEARTH_HOUSEHOLD_SERVICES off → no-op) + fail-open (a
 *     throwing classifier writes nothing, never throws)
 *   - projection (rebuild → household_services row) + the cordon matrix
 *     (owner/household see the communal ledger; a friend-tier caller sees
 *     none of it; the owner has NO god-view of a friend-siloed service)
 *   - due-window math (services_with_upcoming_bills vs fixed now)
 *   - the comprehensive read tool (match, bills picture, monthly total,
 *     known_vendors recovery on a miss)
 *   - triage grounding (services_matching_domain match + the evidence lines
 *     landing in the judge's prompt)
 *   - the working-memory "Bills & services" section (+ its cordon)
 *
 *   bun run smoke:household-services
 */
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { MailStore, type MailMessageInput } from '@memory/stores/mail';
import { rebuild } from '@ingestor/rebuild';
import {
  root_domain,
  domain_of_addr,
  extract_amounts_cents,
  median,
  estimate_next_due,
  monthly_equivalent_cents,
  format_cents,
  service_id_for,
  service_note_path,
  cluster_mail_candidates,
  parse_service_classification,
  services_matching_domain,
  render_service_triage_lines,
  type ServiceMailLike,
} from '@core/household_services';
import { make_learn_household_services } from '@specialists/kate/tools/learn_household_services';
import { make_household_services } from '@specialists/kate/tools/household_services';
import { triage_message } from '@core/mail_triage';
import { compose_working_memory } from '@core/working_memory';
import type { ToolContext } from '@core/tool';
import type { LLMRouter } from '@core/llm';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

// Fixed clock — everything grounds on this, never the host clock.
const NOW = new Date('2026-07-04T18:00:00Z'); // 2026-07-04 in America/Denver

// ── A. pure core ──────────────────────────────────────────────────────────

function pure_checks(): void {
  console.log('A. pure core');
  check('domain_of_addr parses', domain_of_addr('billing@Email.RepublicServices.com') === 'email.republicservices.com');
  check('root_domain strips subdomains', root_domain('email.republicservices.com') === 'republicservices.com');
  check('root_domain passes bare domains', root_domain('xfinity.com') === 'xfinity.com');
  check('root_domain null-safe', root_domain(null) === null);
  check(
    'amount extraction finds cents',
    JSON.stringify(extract_amounts_cents('Your bill of $62.00 (was $1,024.50) is due')) === JSON.stringify([6200, 102450]),
  );
  check('amount extraction drops implausible', extract_amounts_cents('$0.00 and $999,999,999').length === 0);
  check('median odd', median([30, 31, 29]) === 30);
  check('median even rounds', median([30, 32]) === 31);
  check('median empty → null', median([]) === null);

  check('next_due advances into the future', estimate_next_due('2026-06-10', 'monthly', NOW) === '2026-07-10');
  check('next_due catches up a stale anchor', estimate_next_due('2026-01-01', 'monthly', NOW) === '2026-07-30');
  check('next_due annual', estimate_next_due('2025-09-15', 'annual', NOW) === '2026-09-15');
  check('next_due irregular → null', estimate_next_due('2026-06-10', 'irregular', NOW) === null);
  check('next_due no anchor → null', estimate_next_due(null, 'monthly', NOW) === null);

  check('monthly equivalent: monthly is itself', monthly_equivalent_cents({ typical_amount_cents: 6200, cadence: 'monthly' }) === 6200);
  check('monthly equivalent: annual /12', monthly_equivalent_cents({ typical_amount_cents: 1200, cadence: 'annual' }) === 100);
  check('monthly equivalent: unknown cadence → null', monthly_equivalent_cents({ typical_amount_cents: 1200, cadence: null }) === null);
  check('format_cents', format_cents(6200) === '$62.00');

  check('service id is stable + typed', service_id_for('republicservices.com') === service_id_for('republicservices.com') && /^hs_[a-z0-9]{8}$/.test(service_id_for('republicservices.com')));
  check('note path is anchor-keyed', service_note_path('republicservices.com') === 'Household/Services/republicservices-com.md');
}

// ── B. clustering determinism ─────────────────────────────────────────────

function mail_like(over: Partial<ServiceMailLike> & { id: string; from_addr: string; date_utc: string }): ServiceMailLike {
  return { from_name: '', subject: '', snippet: '', ...over };
}

function cluster_checks(): void {
  console.log('B. clustering');
  const msgs: ServiceMailLike[] = [
    mail_like({ id: 'm1', from_addr: 'billing@email.republicservices.com', from_name: 'Republic Services', subject: 'Your bill is ready: $62.00', date_utc: '2026-04-11T15:00:00Z' }),
    mail_like({ id: 'm2', from_addr: 'billing@email.republicservices.com', from_name: 'Republic Services', subject: 'Your bill is ready: $62.00', date_utc: '2026-05-11T15:00:00Z' }),
    mail_like({ id: 'm3', from_addr: 'noreply@republicservices.com', from_name: 'Republic Services', subject: 'AutoPay scheduled — $62.00 on 6/15', date_utc: '2026-06-10T15:00:00Z' }),
    // newsletter noise — recurring but the MODEL's to reject (still a candidate)
    mail_like({ id: 'n1', from_addr: 'digest@substackmail.com', from_name: 'Some Newsletter', subject: 'Issue #41', date_utc: '2026-06-01T15:00:00Z' }),
    mail_like({ id: 'n2', from_addr: 'digest@substackmail.com', from_name: 'Some Newsletter', subject: 'Issue #42', date_utc: '2026-06-08T15:00:00Z' }),
    // below min_messages — never a candidate
    mail_like({ id: 'o1', from_addr: 'noreply@one-off.com', subject: 'Welcome!', date_utc: '2026-06-20T15:00:00Z' }),
    // structural human reply — excluded before grouping
    mail_like({ id: 'r1', from_addr: 'friend@replyfriend.com', subject: 'Re: dinner', date_utc: '2026-06-21T15:00:00Z', triage_category: 'authentic_reply' }),
    mail_like({ id: 'r2', from_addr: 'friend@replyfriend.com', subject: 'Re: dinner again', date_utc: '2026-06-22T15:00:00Z', triage_category: 'authentic_reply' }),
    // heterogeneous local parts (5 distinct humans on one freemail root) — dropped
    ...['a', 'b', 'c', 'd', 'e'].map((lp, i) =>
      mail_like({ id: `f${i}`, from_addr: `${lp}@freemailhost.com`, subject: 'hi', date_utc: `2026-06-0${i + 1}T15:00:00Z` }),
    ),
  ];

  const run1 = cluster_mail_candidates(msgs);
  const run2 = cluster_mail_candidates([...msgs]);
  check('clustering is deterministic', JSON.stringify(run1) === JSON.stringify(run2));
  check('two candidates survive (republic + newsletter)', run1.length === 2 && run1[0]!.anchor === 'republicservices.com' && run1[1]!.anchor === 'substackmail.com');
  check('one-off sender gated by min_messages', !run1.some((c) => c.anchor === 'one-off.com'));
  check('authentic_reply excluded structurally', !run1.some((c) => c.anchor === 'replyfriend.com'));
  check('heterogeneous freemail root dropped', !run1.some((c) => c.anchor === 'freemailhost.com'));
  const rep = run1[0]!;
  check('cadence hint ≈ 30d', rep.median_gap_days === 30);
  // The cap must trim volume-noise, not sparse billers: a 2-message
  // transactional sender outranks a 40-message promotional blaster.
  const ranked = cluster_mail_candidates([
    ...Array.from({ length: 40 }, (_, i) =>
      mail_like({ id: `promo${i}`, from_addr: 'deals@megamart.com', subject: `Sale #${i}`, date_utc: `2026-05-${String((i % 28) + 1).padStart(2, '0')}T15:00:00Z`, triage_category: 'promotional' }),
    ),
    mail_like({ id: 'b1', from_addr: 'billing@coxmail.cox.com', subject: 'Your statement is ready', date_utc: '2026-05-10T15:00:00Z', triage_category: 'transactional' }),
    mail_like({ id: 'b2', from_addr: 'billing@coxmail.cox.com', subject: 'Your statement is ready', date_utc: '2026-06-10T15:00:00Z', triage_category: 'transactional' }),
  ]);
  check('transactional-first ranking beats raw volume', ranked[0]!.anchor === 'cox.com' && ranked[0]!.transactional_count === 2 && ranked[1]!.anchor === 'megamart.com');
  check('amounts + median extracted', rep.typical_amount_cents === 6200 && rep.amounts_cents.length === 3);
  check('evidence refs newest-first', rep.evidence_refs[0] === 'mail:m3');
  check('sender domains preserved (subdomain + root)', rep.domains.length === 2);

  const parsed = parse_service_classification(
    '```json\n[{"ref":1,"vendor":"Republic Services","category":"waste","cadence":"monthly","typical_amount_cents":6200,"autopay":true,"confidence":0.9},{"ref":99,"vendor":"OutOfRange"},{"vendor":"NoRef"}]\n```',
    2,
  );
  check('classification parse: fence-strip + drop out-of-range/invalid', parsed !== null && parsed.length === 1 && parsed[0]!.vendor === 'Republic Services');
  check('classification parse: garbage → null (fail-open)', parse_service_classification('no json here', 2) === null);
}

// ── C–G. the integrated ledger ────────────────────────────────────────────

function seed_message(store: MailStore, over: Partial<MailMessageInput> & { uid: number; from_addr: string; date_utc: string }): void {
  store.upsert({
    direction: 'inbound',
    account_id: 'acct1',
    user_id: 'u_jasper',
    private_to: 'u_jasper',
    message_id: `<${over.uid}@x>`,
    in_reply_to: null,
    references: [],
    thread_key: `t${over.uid}`,
    from_name: '',
    to: ['jasperdoe@example.com'],
    subject: '',
    snippet: '',
    body_text: '',
    auth_spf: 'pass',
    auth_dkim: 'pass',
    auth_dmarc: 'pass',
    is_bulk: true,
    aligned: true,
    triage_category: 'transactional',
    triage_importance: 0.6,
    triage_reasons: [],
    triage_bucket: 'fyi',
    is_reply_to_me: false,
    summary: '',
    suggested_action: 'review',
    list_unsubscribe: null,
    ...over,
  });
}

async function main(): Promise<void> {
  pure_checks();
  cluster_checks();

  const tmp = mkdtempSync(join(tmpdir(), 'hearth-services-'));
  const vault = join(tmp, 'vault');
  mkdirSync(vault, { recursive: true });
  const db = open_db(join(tmp, 'hearth.db'));
  const memory = new MemoryClient({ vault_root: vault, db });
  const mail = new MailStore(db);

  // Republic Services: three bills ~30d apart, $62.00, autopay language.
  seed_message(mail, { uid: 1, from_addr: 'billing@email.republicservices.com', from_name: 'Republic Services', subject: 'Your bill is ready', snippet: 'Amount due: $62.00', date_utc: '2026-04-11T15:00:00Z' });
  seed_message(mail, { uid: 2, from_addr: 'billing@email.republicservices.com', from_name: 'Republic Services', subject: 'Your bill is ready', snippet: 'Amount due: $62.00', date_utc: '2026-05-11T15:00:00Z' });
  seed_message(mail, { uid: 3, from_addr: 'noreply@republicservices.com', from_name: 'Republic Services', subject: 'AutoPay scheduled', snippet: '$62.00 will be drafted', date_utc: '2026-06-10T15:00:00Z' });
  // Newsletter noise — a candidate the model rejects.
  seed_message(mail, { uid: 4, from_addr: 'digest@substackmail.com', from_name: 'Some Newsletter', subject: 'Issue #41', date_utc: '2026-06-01T15:00:00Z', triage_category: 'subscription_informational' });
  seed_message(mail, { uid: 5, from_addr: 'digest@substackmail.com', from_name: 'Some Newsletter', subject: 'Issue #42', date_utc: '2026-06-08T15:00:00Z', triage_category: 'subscription_informational' });

  // Scripted classifier: finds the republic candidate BY NUMBER from the
  // rendered prompt (robust to ordering), accepts it, rejects the newsletter.
  let classify_calls = 0;
  let classify_user_prompt = '';
  const scripted_llm = {
    for_role: () => ({
      provider: {
        complete: async (req: { messages: Array<{ role: string; content: string }> }) => {
          classify_calls++;
          classify_user_prompt = req.messages[1]?.content ?? '';
          const m = classify_user_prompt.match(/\[(\d+)\] republicservices\.com/);
          const ref = m ? Number(m[1]) : 1;
          return {
            content: JSON.stringify([
              { ref, vendor: 'Republic Services', category: 'waste', cadence: 'monthly', typical_amount_cents: 6200, autopay: true, status: 'active', confidence: 0.9 },
            ]),
          };
        },
      },
      defaults: {},
    }),
  } as unknown as LLMRouter;

  const ctx: ToolContext = { memory, llm: scripted_llm, now: NOW, intent_id: 'it_smoke' };
  const learn = make_learn_household_services({ db, memory, llm: scripted_llm });
  const input = { window_days: 90, min_messages: 2, max_candidates: 24 };

  console.log('C. learner');
  // Kill switch first — flag not yet set.
  delete process.env.HEARTH_HOUSEHOLD_SERVICES;
  const off = await learn.execute(input, ctx);
  check('kill switch: learner no-ops', off.enabled === false && off.upserted === 0 && classify_calls === 0);

  process.env.HEARTH_HOUSEHOLD_SERVICES = '1';
  const run1 = await learn.execute(input, ctx);
  check('learner: 2 candidates, 1 classified, 1 upserted', run1.enabled && run1.candidates === 2 && run1.classified === 1 && run1.upserted === 1);
  check('ONE classifier call per run (batch)', classify_calls === 1);
  check('classifier saw numbered candidates', /\[1\] /.test(classify_user_prompt) && /\[2\] /.test(classify_user_prompt));

  const note = memory.read_note('Household/Services/republicservices-com.md');
  check('ledger note written at the anchor-keyed path', note !== null);
  const fm = note!.frontmatter as Record<string, unknown>;
  check('note fm: vendor + anchor + category + cadence', fm.vendor === 'Republic Services' && fm.vendor_anchor === 'republicservices.com' && fm.category === 'waste' && fm.cadence === 'monthly');
  check('note fm: amount + autopay + evidence + domains', fm.typical_amount_cents === 6200 && fm.autopay === true && Array.isArray(fm.evidence_refs) && (fm.evidence_refs as string[]).length === 3 && (fm.sender_domains as string[]).length === 2);
  check('note fm: last_bill + deterministic next-due estimate', fm.last_bill_date === '2026-06-10' && fm.next_due_estimate === '2026-07-10');
  check('note fm: household cordon stamp', fm.private_to === 'household');

  // Idempotency: re-run refreshes the same note, never duplicates.
  await learn.execute(input, ctx);
  const files = readdirSync(join(vault, 'Household', 'Services'));
  check('idempotent re-run: one note file, id stable', files.length === 1 && (memory.read_note('Household/Services/republicservices-com.md')!.frontmatter as Record<string, unknown>).id === service_id_for('republicservices.com'));

  // Fail-open: throwing classifier writes nothing new, never throws.
  const throwing_llm = { for_role: () => ({ provider: { complete: async () => { throw new Error('deep tier down'); } }, defaults: {} }) } as unknown as LLMRouter;
  const learn_broken = make_learn_household_services({ db, memory, llm: throwing_llm });
  const broken = await learn_broken.execute(input, { ...ctx, llm: throwing_llm });
  check('fail-open: classifier outage → nothing written, no throw', broken.enabled && broken.classified === 0 && broken.upserted === 0);

  console.log('D. projection + cordon');
  // Two more hand-written ledger notes: a far-out annual + a friend-siloed one.
  memory.upsert_note('Household/Services/example-insurance-com.md', {
    type: 'household_service', id: service_id_for('example-insurance.com'), vendor: 'Example Insurance',
    vendor_anchor: 'example-insurance.com', category: 'insurance', cadence: 'annual',
    typical_amount_cents: 1200, currency: 'USD', status: 'active', confidence: 0.8,
    evidence_refs: [], sender_domains: ['example-insurance.com'],
    last_bill_date: '2025-09-01', next_due_estimate: '2026-09-01', source: 'mail', private_to: 'household',
  }, 'annual policy');
  memory.upsert_note('Household/Services/kim-gym-com.md', {
    type: 'household_service', id: service_id_for('kim-gym.com'), vendor: 'Kim Gym',
    vendor_anchor: 'kim-gym.com', category: 'membership', cadence: 'monthly',
    typical_amount_cents: 3000, currency: 'USD', status: 'active', confidence: 0.9,
    evidence_refs: [], sender_domains: ['kim-gym.com'],
    last_bill_date: '2026-06-28', next_due_estimate: '2026-07-08', source: 'mail', private_to: 'u_lee',
  }, "kim's own membership");

  await rebuild(vault, memory, db);
  const owner = { user_id: 'u_jasper', tier: 'owner' as const };
  const household = { user_id: 'u_sara', tier: 'household' as const };
  const friend = { user_id: 'u_friend', tier: 'friend' as const };
  const kim = { user_id: 'u_lee', tier: 'friend' as const };

  check('projection: rows land in household_services', memory.query_household_services({ caller: owner }).length === 2);
  check('cordon: household member sees the communal ledger', memory.query_household_services({ caller: household }).length === 2);
  check('cordon: friend tier sees none of it', memory.query_household_services({ caller: friend }).length === 0);
  check('cordon: owner has NO god-view of a friend-siloed service', !memory.query_household_services({ caller: owner }).some((r) => r.vendor === 'Kim Gym'));
  check('cordon: the friend sees their own siloed service', memory.query_household_services({ caller: kim }).some((r) => r.vendor === 'Kim Gym'));
  check('category filter works', memory.query_household_services({ caller: owner, category: 'insurance' }).length === 1);

  const due14 = memory.services_with_upcoming_bills(14, owner, NOW);
  check('due-window: republic (~07-10) inside 14d of fixed now', due14.length === 1 && due14[0]!.vendor === 'Republic Services');
  const due90 = memory.services_with_upcoming_bills(90, owner, NOW);
  check('due-window: annual (~09-01) enters at 90d', due90.some((r) => r.vendor === 'Example Insurance'));
  check('due-window: cordoned too', memory.services_with_upcoming_bills(14, kim, NOW).every((r) => r.vendor === 'Kim Gym'));

  console.log('E. the comprehensive read tool');
  const read = make_household_services({ memory });
  const owner_ctx: ToolContext = { memory, llm: scripted_llm, now: NOW, intent_id: 'it_read', user: { id: 'u_jasper', tier: 'owner' } };
  const r1 = await read.execute({ query: 'republic', due_within_days: 45, limit: 25 }, owner_ctx);
  check('read: query matches vendor fragment', r1.services.length === 1 && r1.services[0]!.vendor === 'Republic Services' && r1.services[0]!.typical_amount === '$62.00');
  check('read: bills picture rides along', r1.upcoming_bills.some((b) => b.vendor === 'Republic Services' && b.due_estimate === '2026-07-10'));
  check('read: monthly-equivalent total (62 + 12/12)', r1.monthly_total_estimate === '$63.00');
  const r2 = await read.execute({ query: 'zzz-nothing', due_within_days: 45, limit: 25 }, owner_ctx);
  check('read: miss returns known_vendors recovery', r2.services.length === 0 && (r2.known_vendors ?? []).includes('Republic Services') && !!r2.note);
  const r3 = await read.execute({ due_within_days: 45, limit: 25 }, { ...owner_ctx, user: { id: 'u_friend', tier: 'friend' } });
  check('read: friend tier gets an empty ledger', r3.services.length === 0 && r3.upcoming_bills.length === 0);

  console.log('F. triage grounding');
  const matched = services_matching_domain(db, 'email.republicservices.com', owner);
  check('domain match: subdomain → root → service', matched.length === 1 && matched[0]!.vendor === 'Republic Services');
  check('domain match: unknown domain → none', services_matching_domain(db, 'scammy-recovery.biz', owner).length === 0);
  check('domain match: cordoned (friend sees none)', services_matching_domain(db, 'email.republicservices.com', friend).length === 0);
  const lines = render_service_triage_lines(matched);
  check('triage lines carry vendor + amount + autopay + last bill', /Republic Services — waste, ~\$62\.00 monthly, autopay, last bill 2026-06-10/.test(lines[0] ?? ''));

  let judge_system = '';
  let judge_user = '';
  const capture_llm = {
    for_role: () => ({
      provider: {
        complete: async (req: { messages: Array<{ role: string; content: string }> }) => {
          judge_system = req.messages[0]?.content ?? '';
          judge_user = req.messages[1]?.content ?? '';
          return { content: JSON.stringify({ category: 'transactional', importance: 0.8, needs_action: true, summary: 'Trash bill — the household has Republic service.', suggested_action: 'review' }) };
        },
      },
      defaults: {},
    }),
  } as unknown as LLMRouter;
  const verdict = await triage_message(
    {
      from_addr: 'billing@email.republicservices.com',
      from_name: 'Republic Services',
      subject: 'Your bill is ready',
      snippet: 'Amount due: $62.00',
      body_text: 'Amount due: $62.00 by July 15',
      structural: { spf: 'pass', dkim: 'pass', dmarc: 'pass', is_bulk: true, aligned: true, has_list_unsub: false },
      is_reply_to_me: false,
      owner_names: ['Jasper Doe', 'jasperdoe@example.com'],
      known_services: lines,
      household_names: ['Jasper', 'Sam'],
    },
    capture_llm,
  );
  check('triage evidence carries the VERIFIED ledger lines', judge_user.includes('VERIFIED ledger') && judge_user.includes('Republic Services — waste'));
  check('triage evidence carries household members', judge_user.includes('Household members: Jasper, Sam'));
  check('judge prompt teaches the known-services rule', judge_system.includes('KNOWN HOUSEHOLD SERVICES'));
  check('the model still judges (transactional verdict passes through)', verdict.category === 'transactional' && verdict.used_llm);

  console.log('G. working memory');
  process.env.HEARTH_WORKING_MEMORY = '1';
  const wm_owner = compose_working_memory({ memory, db }, { user_id: 'u_jasper', tier: 'owner', now: NOW });
  check('bills section present for the owner', wm_owner.counts.bills === 1 && wm_owner.sections.some((s) => s.startsWith('**Bills & services')));
  check('bills line names vendor + estimate + autopay', wm_owner.sections.some((s) => s.includes('~2026-07-10 — Republic Services (waste) — ~$62.00 [autopay]')));
  const wm_friend = compose_working_memory({ memory, db }, { user_id: 'u_friend', tier: 'friend', now: NOW });
  check('bills section cordoned (friend sees none)', wm_friend.counts.bills === 0);
  const throwing_memory = new Proxy(memory, {
    get(target, prop, receiver) {
      if (prop === 'services_with_upcoming_bills') return () => { throw new Error('table gone'); };
      return Reflect.get(target, prop, receiver);
    },
  });
  const wm_broken = compose_working_memory({ memory: throwing_memory as MemoryClient, db }, { user_id: 'u_jasper', tier: 'owner', now: NOW });
  check('bills section fail-open (throwing read drops ONLY that section)', wm_broken.counts.bills === 0 && !wm_broken.sections.some((s) => s.startsWith('**Bills & services')));

  rmSync(tmp, { recursive: true, force: true });
  console.log(`\nsmoke:household-services — ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
