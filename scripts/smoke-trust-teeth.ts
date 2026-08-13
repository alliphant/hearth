/**
 * smoke:trust-teeth — the court scorecard (Phase 1) + graduated consensus
 * auto-execution with undo window (Phase 2).
 *
 * Self-contained: temp dbs + vault, scripted lenses, spy push, fake tool
 * registry — no LLM, no APNs, no network. Exercises:
 *
 *   Scorer (src/core/court_scorecard.ts):
 *     - split-resolved direct comparison (per-lens + overall math)
 *     - reversal detection (court-decided, owner later flips the signature)
 *     - digest reactions (got_it endorses / discuss challenges / silence
 *       excluded), reversal outranking endorsement
 *     - the historical-signature backtest (its own rate, ties skipped)
 *     - meets_target: null below min comparisons, true/false above
 *     - gather_court_scorecard end-to-end from audit rows + proposals
 *
 *   Teeth (src/core/trust_teeth.ts + the court branch):
 *     - kill switch: teeth off ⇒ unanimous approve on a user-action kind
 *       stays 'skipped', nothing armed
 *     - tier gating: tier2a never arms; tier2c/tier3 arms
 *     - the permanent floor: requires_step_up ⇒ owner_class even at tier3;
 *       draft_message excluded by kind even at tier3
 *     - arm: durable row + notification (recipient threading, cancel
 *       instruction) + proposal STAYS pending; re-convene is idempotent
 *       (no second row, no second push)
 *     - undo: owner deny during the window ⇒ sweep cancels; denial_count
 *       (the reject XP signal) moved through the normal decide path
 *     - snooze during the window ⇒ sweep cancels (owner defer respected)
 *     - execute: sweep past the window runs decide('approve') + the shared
 *       owner-tap effects — 'none' kind lands acknowledged, dispatch kind
 *       lands executed via the tool registry; XP accrues at decide()
 *     - sweep kill switch freezes armed rows without resolving them
 *
 *   bun run smoke:trust-teeth
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { ProposalsStore, hash_signature } from '@core/proposals';
import { convene_proposal_court, type CourtVote, type CourtDeps } from '@core/proposal_court';
import {
  sweep_trust_autoexec,
  teeth_armed_for_kind,
  undo_window_minutes,
  type TrustTeethSweepDeps,
} from '@core/trust_teeth';
import { TrustAutoexecStore } from '@memory/stores/trust_autoexec';
import {
  compute_scorecard,
  gather_court_scorecard,
  type CourtVerdictEvent,
  type ProposalFact,
  type OwnerDecision,
  type DigestReaction,
} from '@core/court_scorecard';
import { execute_approved_proposal } from '../src/app/routes/specialists';
import { readFileSync } from 'node:fs';
import { ulid } from 'ulid';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

// ── Part A: the scorer (pure) ───────────────────────────────────────────────

function scorer_pure_checks(): void {
  console.log('\nA. scorer — pure compute');
  const votes3 = (v: CourtVote['vote']): CourtVerdictEvent['votes'] => [
    { seat: 'mariah', vote: v },
    { seat: 'trainer', vote: v },
    { seat: 'kate', vote: v },
  ];
  const events: CourtVerdictEvent[] = [
    // e1: split, owner later approved the very proposal → direct comparison
    {
      proposal_id: 'p_split',
      kind: 'trusted_source_addition',
      ts: '2026-07-01T15:00:00.000Z',
      outcome: 'split',
      votes: [
        { seat: 'mariah', vote: 'approve' },
        { seat: 'trainer', vote: 'reject' },
        { seat: 'kate', vote: 'approve' },
      ],
    },
    // e2: court rejected; owner later approved a same-signature re-file → reversal
    {
      proposal_id: 'p_rev',
      kind: 'recommendation',
      ts: '2026-07-01T15:00:00.000Z',
      outcome: 'rejected',
      votes: votes3('reject'),
    },
    // e3: court approved; digest got_it that day → endorsed
    {
      proposal_id: 'p_endorse',
      kind: 'recommendation',
      ts: '2026-07-01T15:00:00.000Z',
      outcome: 'approved',
      votes: votes3('approve'),
    },
    // e4: court approved on a challenged day → disagreement
    {
      proposal_id: 'p_challenge',
      kind: 'recommendation',
      ts: '2026-07-02T15:00:00.000Z',
      outcome: 'approved',
      votes: votes3('approve'),
    },
    // e5: court approved, no reaction → unchallenged (excluded from rate)
    {
      proposal_id: 'p_silent',
      kind: 'recommendation',
      ts: '2026-07-03T15:00:00.000Z',
      outcome: 'approved',
      votes: votes3('approve'),
    },
    // e6: backtest disagree — court rejected a signature the owner
    // historically approves (history strictly BEFORE the event → no reversal)
    {
      proposal_id: 'p_backtest',
      kind: 'recommendation',
      ts: '2026-07-03T16:00:00.000Z',
      outcome: 'rejected',
      votes: votes3('reject'),
    },
  ];
  const facts = new Map<string, ProposalFact>([
    ['p_split', { proposal_id: 'p_split', status: 'approved', ts_decided: '2026-07-01T18:00:00.000Z', decided_by_court: false }],
    ['p_rev', { proposal_id: 'p_rev', status: 'denied', ts_decided: '2026-07-01T15:00:01.000Z', decided_by_court: true }],
    ['p_endorse', { proposal_id: 'p_endorse', status: 'acknowledged', ts_decided: '2026-07-01T15:00:01.000Z', decided_by_court: true }],
    ['p_challenge', { proposal_id: 'p_challenge', status: 'acknowledged', ts_decided: '2026-07-02T15:00:01.000Z', decided_by_court: true }],
    ['p_silent', { proposal_id: 'p_silent', status: 'acknowledged', ts_decided: '2026-07-03T15:00:01.000Z', decided_by_court: true }],
    ['p_backtest', { proposal_id: 'p_backtest', status: 'denied', ts_decided: '2026-07-03T16:00:01.000Z', decided_by_court: true }],
  ]);
  const signatures = new Map<string, string | null>([
    ['p_split', 'h_split'],
    ['p_rev', 'h_rev'],
    ['p_endorse', 'h_endorse'],
    ['p_challenge', 'h_challenge'],
    ['p_silent', 'h_silent'],
    ['p_backtest', 'h_backtest'],
  ]);
  const owner_decisions: OwnerDecision[] = [
    // The reversal: same signature as e2, AFTER the convening, opposite verdict.
    { proposal_id: 'p_rev2', signature_hash: 'h_rev', verdict: 'approve', ts_decided: '2026-07-02T10:00:00.000Z' },
    // Backtest history for e6 — 3:1 approve majority, all BEFORE the event.
    { proposal_id: 'b1', signature_hash: 'h_backtest', verdict: 'approve', ts_decided: '2026-06-20T10:00:00.000Z' },
    { proposal_id: 'b2', signature_hash: 'h_backtest', verdict: 'approve', ts_decided: '2026-06-21T10:00:00.000Z' },
    { proposal_id: 'b3', signature_hash: 'h_backtest', verdict: 'approve', ts_decided: '2026-06-22T10:00:00.000Z' },
    { proposal_id: 'b4', signature_hash: 'h_backtest', verdict: 'deny', ts_decided: '2026-06-23T10:00:00.000Z' },
    // A tie signature — never backtests.
    { proposal_id: 't1', signature_hash: 'h_endorse', verdict: 'approve', ts_decided: '2026-06-20T10:00:00.000Z' },
    { proposal_id: 't2', signature_hash: 'h_endorse', verdict: 'deny', ts_decided: '2026-06-21T10:00:00.000Z' },
  ];
  const digest_reactions = new Map<string, DigestReaction>([
    ['2026-07-01', 'endorsed'],
    ['2026-07-02', 'challenged'],
  ]);

  const card = compute_scorecard({
    events, facts, signatures, owner_decisions, digest_reactions,
    window_days: 7, since: '2026-06-28T00:00:00.000Z',
  });

  check('split resolved by the owner is a direct comparison', card.split_resolved === 1 && card.split_pending === 0);
  const mariah = card.per_lens.find((l) => l.seat === 'mariah')!;
  const trainer = card.per_lens.find((l) => l.seat === 'trainer')!;
  // mariah: split agree + rev disagree + endorse agree + challenge disagree + backtest-day disagree? (e6 unreacted day → excluded) = 2/4
  check('per-lens tallies (mariah 2/4)', mariah.comparisons === 4 && mariah.agreed === 2);
  check('per-lens tallies (trainer split-dissent agreed with owner? no — he rejected, owner approved)', trainer.comparisons === 4 && trainer.agreed === 1);
  // overall: split 2/3 + reversal 0/3 + endorsed 3/3 + challenged 0/3 = 5/12
  // (p_silent + p_backtest excluded: silence is not consent)
  check('overall = 5/12 (unchallenged cases excluded)', card.overall.comparisons === 12 && card.overall.agreed === 5);
  check('reversal counted once', card.decided_reversed === 1);
  check('digest endorsement/challenge counted', card.decided_endorsed === 1 && card.decided_challenged === 1);
  check('silence is not consent (unchallenged excluded)', card.decided_unchallenged === 2);
  // e2 (h_rev): court reject vs owner majority approve (1:0) → disagree.
  // e3 (h_endorse): tie history → skipped. e6 (h_backtest): reject vs 3:1 approve → disagree.
  check('backtest = 0/2 (tie skipped, reversal case still backtests)', card.backtest.cases === 2 && card.backtest.agreed === 0);
  check('meets_target null below min comparisons (12 < default 10? no — check gate)', card.meets_target !== null || card.overall.comparisons < card.min_comparisons);
  // 12 comparisons ≥ 10 → gate judged; 5/12 < 0.9 → false.
  check('gate judged false at 5/12 vs 90%', card.meets_target === false && card.gate_note.includes('NOT met'));

  const small = compute_scorecard({
    events: events.slice(0, 1), facts, signatures, owner_decisions, digest_reactions,
    window_days: 7, since: '2026-06-28T00:00:00.000Z',
  });
  check('insufficient data → meets_target null (never "close enough")', small.meets_target === null && small.gate_note.includes('Not enough'));

  const winning = compute_scorecard({
    events: [events[2]!], facts, signatures, owner_decisions, digest_reactions,
    window_days: 7, since: '2026-06-28T00:00:00.000Z', min_comparisons: 3,
  });
  check('gate true when rate clears target over min comparisons', winning.meets_target === true && winning.overall.rate === 1);

  // ── the RATCHET: a kind earns arming on its own record ───────────────────
  // The live blocker: ONE blended rate across every kind at once, so a strong
  // narrow record is averaged away and the gate never opens. Per-kind scoring
  // is what gives the ladder a rung between "nothing" and "everything".
  const rec = card.per_kind.find((k) => k.kind === 'recommendation');
  const tsa = card.per_kind.find((k) => k.kind === 'trusted_source_addition');
  // The blended 5/12 splits: the split case (2/3) is a different kind from
  // the reversal/endorse/challenge run (3/9). Averaging them is exactly what
  // hides a good record behind a bad one.
  check('per-kind: the blended tally decomposes by kind',
    tsa?.comparisons === 3 && tsa.agreed === 2 && rec?.comparisons === 9 && rec.agreed === 3);
  check('per-kind: the parts sum to the whole',
    card.per_kind.reduce((n, k) => n + k.comparisons, 0) === card.overall.comparisons);
  check('armable: a NON-teeth kind never becomes armable however well it scores',
    card.armable_kinds.length === 0);

  // A teeth-eligible kind with a clean record IS armable — on data whose
  // blended gate still says no.
  // All on one ENDORSED day, so the kind's own record is clean 9/9.
  const cal_events: CourtVerdictEvent[] = [0, 1, 2].map((i) => ({
    proposal_id: `p_cal${i}`,
    kind: 'calendar_event',
    ts: `2026-07-03T1${i}:00:00.000Z`,
    outcome: 'approved',
    votes: votes3('approve'),
  }));
  const mixed = compute_scorecard({
    events: [...events, ...cal_events],
    facts: new Map([
      ...facts,
      ...cal_events.map((e) => [
        e.proposal_id,
        { proposal_id: e.proposal_id, status: 'acknowledged', ts_decided: `${e.ts.slice(0, 19)}.001Z`, decided_by_court: true },
      ] as const),
    ]),
    signatures: new Map([...signatures, ...cal_events.map((e) => [e.proposal_id, `h_${e.proposal_id}`] as const)]),
    owner_decisions,
    digest_reactions: new Map([...digest_reactions, ['2026-07-03', 'endorsed'] as const]),
    window_days: 7, since: '2026-06-28T00:00:00.000Z', min_kind_comparisons: 3,
  });
  const cal = mixed.per_kind.find((k) => k.kind === 'calendar_event');
  check('ratchet: the clean kind meets its own target', cal?.meets_target === true && cal.rate === 1);
  check('ratchet: the blended gate still says NO on the same data', mixed.meets_target === false);
  check('ratchet: yet the earned kind IS armable', mixed.armable_kinds.includes('calendar_event'));
  check('ratchet: the weak kind is not', !mixed.armable_kinds.includes('recommendation'));
  check('ratchet: the gate note names what was earned', mixed.gate_note.includes('Earned now: calendar_event'));

  // The arming switch itself.
  const teeth_before = process.env.HEARTH_TRUST_TEETH;
  delete process.env.HEARTH_TRUST_TEETH;
  delete process.env.HEARTH_TRUST_TEETH_KINDS;
  check('arm: nothing armed with both switches off', !teeth_armed_for_kind('calendar_event'));
  process.env.HEARTH_TRUST_TEETH_KINDS = 'calendar_event';
  check('arm: the listed kind arms', teeth_armed_for_kind('calendar_event'));
  check('arm: an unlisted teeth kind stays dark', !teeth_armed_for_kind('action_proposal'));
  process.env.HEARTH_TRUST_TEETH_KINDS = 'draft_message,book_candidate';
  check('arm: the allowlist filters to TEETH_KINDS, so a permanent-floor kind is dropped',
    !teeth_armed_for_kind('draft_message') && teeth_armed_for_kind('book_candidate'));
  delete process.env.HEARTH_TRUST_TEETH_KINDS;
  process.env.HEARTH_TRUST_TEETH = '1';
  check('arm: the global flag still means every teeth kind',
    teeth_armed_for_kind('calendar_event') && teeth_armed_for_kind('action_proposal'));
  check('arm: and still never the permanent floor', !teeth_armed_for_kind('draft_message'));
  if (teeth_before === undefined) delete process.env.HEARTH_TRUST_TEETH;
  else process.env.HEARTH_TRUST_TEETH = teeth_before;
}

// ── Part B: gather from a seeded db ─────────────────────────────────────────

function scorer_gather_checks(): void {
  console.log('\nB. scorer — gather from audit rows + proposals');
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-scorecard-'));
  const vault = join(tmp, 'vault');
  mkdirSync(vault, { recursive: true });
  const db = open_db(join(tmp, 's.db'));
  const memory = new MemoryClient({ vault_root: vault, db });
  const proposals = new ProposalsStore(db);

  // A split the owner later approves.
  const p1 = proposals.create({
    specialist_id: 'cordelia', kind: 'trusted_source_addition', execution_kind: 'none',
    payload: { target_specialist_id: 'ruby', domain: 'gather.example', tier: 2 },
    rationale: 'Gather-path split case.',
    signature: { specialist_id: 'cordelia', kind: 'trusted_source_addition', category: 'scout', anchor: 'gather.example' },
  });
  memory.log_action({
    intent_id: ulid(), agent: 'kate', tool_name: 'proposal_court_verdict',
    tool_input: { proposal_id: p1, kind: 'trusted_source_addition' },
    execution_result: { outcome: 'split', votes: ['mariah=approve', 'trainer=reject', 'kate=approve'] },
  });
  proposals.decide(p1, 'approve'); // the owner clears the split

  // A court-decided case + a got_it digest the same (UTC) day.
  const p2 = proposals.create({
    specialist_id: 'cordelia', kind: 'trusted_source_addition', execution_kind: 'none',
    payload: { target_specialist_id: 'ruby', domain: 'gather2.example', tier: 2 },
    rationale: 'Gather-path endorsed decide.',
    signature: { specialist_id: 'cordelia', kind: 'trusted_source_addition', category: 'scout', anchor: 'gather2.example' },
  });
  memory.log_action({
    intent_id: ulid(), agent: 'kate', tool_name: 'proposal_court_verdict',
    tool_input: { proposal_id: p2, kind: 'trusted_source_addition' },
    execution_result: { outcome: 'approved', votes: ['mariah=approve', 'trainer=approve', 'kate=approve'] },
  });
  proposals.decide(p2, 'approve', undefined, 'proposal court consensus: mariah=approve, trainer=approve, kate=approve', 'approve');
  const digest = proposals.create({
    specialist_id: 'kate', kind: 'briefing', execution_kind: 'none',
    payload: { topic: 'Proposal Court — 1 approved, 0 declined, 0 lapsed, 0 for you', depth: 'quick', body_md: '-' },
    rationale: 'Daily Proposal Court digest — gather test.',
    signature: { specialist_id: 'kate', kind: 'briefing', category: 'proposal_court', anchor: 'gather-day' },
  });
  proposals.decide(digest, 'approve', undefined, undefined, 'got_it');

  const card = gather_court_scorecard(db, { window_days: 7 });
  check('gather parsed both verdict events', card.cases_total === 2);
  check('gather: split resolved + court decide endorsed', card.split_resolved === 1 && card.decided_endorsed === 1);
  // split: mariah/kate agree, trainer disagrees (2/3); endorsed: 3/3 → 5/6
  check('gather: overall 5/6 across both rungs', card.overall.comparisons === 6 && card.overall.agreed === 5);
  check('gather: court decides do NOT count as owner history (backtest empty)', card.backtest.cases === 0);

  rmSync(tmp, { recursive: true, force: true });
}

// ── Part C: trust teeth — arm / undo / execute / floor / kill switch ───────

async function teeth_checks(): Promise<void> {
  console.log('\nC. trust teeth — court arm + undo window + sweep');
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-teeth-'));
  const vault = join(tmp, 'vault');
  mkdirSync(join(vault, 'Knowledge', 'Cordelia'), { recursive: true });
  const db = open_db(join(tmp, 't.db'));
  const memory = new MemoryClient({ vault_root: vault, db });
  const proposals = new ProposalsStore(db);
  const store = new TrustAutoexecStore(db);

  const backdate = (id: string, hours: number): void => {
    const ts = new Date(Date.now() - hours * 3_600_000).toISOString();
    db.prepare(`UPDATE proposals SET ts_created = @ts WHERE id = @id`).run({ '@ts': ts, '@id': id });
  };

  // Signatures: S (tier2c, 'none' kind), S2 (tier3, dispatch), S3 (tier3 but
  // draft_message — floor by kind), S4 (tier2a — not graduated).
  const S = { specialist_id: 'kate', kind: 'action_proposal', category: 'household', anchor: 'refill' } as const;
  const S2 = { specialist_id: 'kate', kind: 'action_proposal', category: 'household', anchor: 'dispatchable' } as const;
  const S3 = { specialist_id: 'kate', kind: 'draft_message', category: 'comms', anchor: 'x' } as const;
  const S4 = { specialist_id: 'kate', kind: 'action_proposal', category: 'household', anchor: 'unearned' } as const;

  const pA = proposals.create({
    specialist_id: 'kate', kind: 'action_proposal', execution_kind: 'none',
    payload: { verb: 'reorder the water filters', description: 'Standing refill' },
    rationale: 'Filter refill window reached.', signature: S, user_id: 'jasper',
  });
  const pB = proposals.create({
    specialist_id: 'kate', kind: 'action_proposal', execution_kind: 'none',
    payload: { verb: 'reorder the furnace filters', description: 'Second refill' },
    rationale: 'Furnace filter refill window reached.', signature: S, user_id: 'jasper',
  });
  const pC = proposals.create({
    specialist_id: 'kate', kind: 'action_proposal', execution_kind: 'dispatch',
    payload: { dispatch_tool: 'fake_household_tool', dispatch_input: { item: 'salt' }, description: 'Softener salt' },
    rationale: 'Softener salt low.', signature: S2, user_id: 'jasper',
  });
  const pD = proposals.create({
    specialist_id: 'kate', kind: 'draft_message', execution_kind: 'none',
    payload: { message: { to: 'plumber', body_md: 'hi' } },
    rationale: 'Draft to the plumber.', signature: S3, user_id: 'jasper',
  });
  const pE = proposals.create({
    specialist_id: 'kate', kind: 'action_proposal', execution_kind: 'dispatch',
    payload: { requires_step_up: true, dispatch_tool: 'fake_household_tool', description: 'Step-up gated' },
    rationale: 'A gated action.', signature: S, user_id: 'jasper',
  });
  const pF = proposals.create({
    specialist_id: 'kate', kind: 'action_proposal', execution_kind: 'none',
    payload: { verb: 'try a brand-new thing', description: 'No track record' },
    rationale: 'First of its class.', signature: S4, user_id: 'jasper',
  });
  const pG = proposals.create({
    specialist_id: 'kate', kind: 'action_proposal', execution_kind: 'none',
    payload: { verb: 'book the car wash', description: 'Snooze case' },
    rationale: 'Car wash cadence.', signature: S2, user_id: 'jasper',
  });
  for (const id of [pA, pB, pC, pD, pE, pF, pG]) backdate(id, 48);

  // Graduate the earned signatures.
  proposals.graduate(hash_signature(S), 'tier2c');
  proposals.graduate(hash_signature(S2), 'tier3');
  proposals.graduate(hash_signature(S3), 'tier3');

  const pushes: Array<{ user_id: string | null; text: string; related_id: string }> = [];
  const approve_all = async (seat: string, _b: string, cases: Array<{ id: string }>): Promise<CourtVote[]> =>
    cases.map(() => ({ seat, vote: 'approve' as const, reason: 'scripted' }));
  const deps: CourtDeps = {
    db, proposals, memory,
    llm: null as unknown as CourtDeps['llm'],
    specialists: { get: () => null } as unknown as CourtDeps['specialists'],
    lens_fn: approve_all,
    tiebreak_fn: async () => ({ seat: 'qwen-27b', vote: 'approve', reason: 'scripted fill' }),
    push_fn: async (user_id, text, related_id) => { pushes.push({ user_id, text, related_id }); },
  };

  // 1. Court on, teeth OFF → unanimous approve on a user-action kind stays skipped.
  process.env.HEARTH_PROPOSAL_COURT = '1';
  delete process.env.HEARTH_TRUST_TEETH;
  const off = await convene_proposal_court(deps);
  check('teeth off: nothing armed, user-action kinds skipped', off.armed.length === 0 && store.list_armed().length === 0);
  check('teeth off: proposals untouched (pending)', proposals.get(pA)!.status === 'pending');
  // Clear run 1's digest so run 2's (same signature anchor + rationale — the
  // daily-digest re-fire collapse) files fresh with its own topic.
  if (off.digest_id) proposals.expire_one(off.digest_id, 'smoke: reset digest between convenings');

  // 2. Teeth ON → tier-gated arming.
  process.env.HEARTH_TRUST_TEETH = '1';
  process.env.HEARTH_TRUST_XP = '1';
  const armed_at = new Date();
  const r = await convene_proposal_court(deps, { now: armed_at });
  check('tier2c/tier3 user-action proposals armed', [pA, pB, pC, pG].every((id) => r.armed.includes(id)));
  check('tier2a signature does NOT arm (skipped)', !r.armed.includes(pF) && proposals.get(pF)!.status === 'pending');
  // The floor property, asserted on a case seated for the FIRST time in this
  // convening. Since 2026-08-02 an owner_class verdict PARKS the case (the
  // bench has no authority over the permanent floor, so re-seating it every
  // convening was pure churn) — so pE, drawn owner_class by run 1 above, is no
  // longer on run 2's docket to read an outcome from. Parking strictly reduces
  // teeth exposure: a parked case never reaches the arming gate at all. pE
  // still carries the safety half of the assertion below.
  const pE2 = proposals.create({
    specialist_id: 'kate', kind: 'action_proposal', execution_kind: 'dispatch',
    payload: { requires_step_up: true, dispatch_tool: 'fake_household_tool', description: 'Step-up gated (tier2c, seated fresh)' },
    rationale: 'A gated action, first seated with teeth ON.', signature: S, user_id: 'jasper',
  });
  backdate(pE2, 48);
  const r_floor = await convene_proposal_court(deps, { now: armed_at });
  check('floor: step-up proposal stays owner-class even at tier2c',
    !r_floor.armed.includes(pE2) && r_floor.cases.find((c) => c.id === pE2)!.outcome === 'owner_class');
  check('floor: a parked step-up case is never armed and never auto-executes',
    !r.armed.includes(pE) && !r_floor.armed.includes(pE) && proposals.get(pE)!.status === 'pending');
  if (r_floor.digest_id) proposals.expire_one(r_floor.digest_id, 'smoke: reset digest after the floor convening');
  check('floor: draft_message excluded by kind even at tier3', !r.armed.includes(pD) && r.cases.find((c) => c.id === pD)!.outcome === 'skipped');
  check('armed proposals STAY pending through the window', [pA, pB, pC, pG].every((id) => proposals.get(id)!.status === 'pending'));
  const rowA = store.get_by_proposal(pA)!;
  const expected_after = armed_at.getTime() + undo_window_minutes() * 60_000;
  check('undo window stamped (~default 30m)', Math.abs(Date.parse(rowA.execute_after) - expected_after) < 5_000);
  check('notification per arm, threaded to the proposal user', pushes.length === 4 && pushes.every((p) => p.user_id === 'jasper'));
  check('notification says what runs and how to stop it', pushes[0]!.text.includes('deny it in the proposal queue') && pushes[0]!.text.includes('auto-execution'));
  const digest_topic = r.digest_id
    ? String((JSON.parse(proposals.get(r.digest_id)!.payload_json) as { topic?: string }).topic ?? '')
    : '';
  check('digest counts the arms', digest_topic.includes('auto-executing'));

  // 3. Idempotent re-convening — no new rows, no re-push, window not reset.
  const r2 = await convene_proposal_court(deps, { now: new Date(armed_at.getTime() + 60_000) });
  check('re-convening re-arms nothing (no second push, window kept)', pushes.length === 4 && store.get_by_proposal(pA)!.execute_after === rowA.execute_after && r2.enabled);

  // 4. The undo: owner denies pB inside the window — the normal decide path
  //    carries the reject signal (denial_count on the signature).
  proposals.decide(pB, 'deny', undefined, 'not this one', 'reject');
  const sigS = db.prepare(`SELECT denial_count FROM category_signatures WHERE hash = ?`)
    .get(hash_signature(S)) as { denial_count: number };
  check('undo (queue deny) carries the reject XP signal', sigS.denial_count === 1);

  // 5. Snooze during the window is an owner touch too.
  proposals.snooze(pG, new Date(Date.now() + 86_400_000).toISOString());

  // 6. Sweep BEFORE the window → nothing due.
  const fake_tools_calls: Array<{ tool: string; specialist: string }> = [];
  const sweep_deps: TrustTeethSweepDeps = {
    db, proposals, memory,
    specialists: { get: (id: string) => ({ id, granted: new Set(['x']) }) } as unknown as TrustTeethSweepDeps['specialists'],
    tools: {
      invoke: async (tool: string, _input: unknown, _ctx: unknown, _granted: unknown, specialist: string) => {
        fake_tools_calls.push({ tool, specialist });
        return { ok: true, result: { done: true } };
      },
    } as unknown as TrustTeethSweepDeps['tools'],
    llm: null as unknown as TrustTeethSweepDeps['llm'],
    events: { emit: () => {} },
  };
  const early = await sweep_trust_autoexec(sweep_deps, armed_at);
  check('sweep before the window resolves nothing', early.due === 0 && early.executed.length === 0);

  // 7. Kill switch freezes armed rows even past the window.
  const past_window = new Date(expected_after + 60_000);
  process.env.HEARTH_TRUST_TEETH = '0';
  const frozen = await sweep_trust_autoexec(sweep_deps, past_window);
  check('sweep kill switch: armed rows frozen, nothing executes', frozen.enabled === false && store.get_by_proposal(pA)!.status === 'armed');
  process.env.HEARTH_TRUST_TEETH = '1';

  // 8. The sweep past the window: executes pA + pC, cancels pB (denied) + pG (snoozed).
  const xp_before = proposals.trust_level_for(hash_signature(S2))!.xp;
  const swept = await sweep_trust_autoexec(sweep_deps, past_window);
  check('due rows all resolved', swept.due === 4 && swept.failed.length === 0);
  check('owner deny during the window cancels the execution', swept.canceled.includes(pB) && store.get_by_proposal(pB)!.status === 'canceled' && proposals.get(pB)!.status === 'denied');
  check('owner snooze during the window cancels too', swept.canceled.includes(pG) && store.get_by_proposal(pG)!.status === 'canceled' && proposals.get(pG)!.status === 'snoozed');
  check('no-execution kind lands acknowledged via the owner-tap path', swept.executed.includes(pA) && proposals.get(pA)!.status === 'acknowledged');
  check('dispatch kind executed through the tool registry as the author', proposals.get(pC)!.status === 'executed' && fake_tools_calls.length === 1 && fake_tools_calls[0]!.tool === 'fake_household_tool' && fake_tools_calls[0]!.specialist === 'kate');
  check('decide feedback marks the auto-exec as court-made (scorecard reads it)', (proposals.get(pA)!.user_feedback ?? '').startsWith('trust teeth'));
  check('XP flowed at decide() for the auto-exec', proposals.trust_level_for(hash_signature(S2))!.xp > xp_before);
  const audit_armed = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE tool_name = 'trust_autoexec_armed'`).get() as { n: number };
  const audit_exec = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE tool_name = 'trust_autoexec_executed' AND error IS NULL`).get() as { n: number };
  check('arm + execution audited', audit_armed.n === 4 && audit_exec.n === 2);

  // 9. Sweep is idempotent — everything already terminal.
  const again = await sweep_trust_autoexec(sweep_deps, new Date(past_window.getTime() + 60_000));
  check('re-sweep finds nothing due', again.due === 0);

  delete process.env.HEARTH_PROPOSAL_COURT;
  delete process.env.HEARTH_TRUST_TEETH;
  delete process.env.HEARTH_TRUST_XP;
  rmSync(tmp, { recursive: true, force: true });
}

// ── Part D: the shared executor's resolver branch ──────────────────────────

async function resolver_branch_checks(): Promise<void> {
  console.log('\nD. shared executor — kind-resolver branch (book_candidate)');
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-teeth-resolver-'));
  const vault = join(tmp, 'vault');
  mkdirSync(join(vault, 'Cordelia', 'queue'), { recursive: true });
  const db = open_db(join(tmp, 'r.db'));
  const memory = new MemoryClient({ vault_root: vault, db });
  const proposals = new ProposalsStore(db);

  const queue_rel = 'Cordelia/queue/test-book.md';
  memory.upsert_note(
    queue_rel,
    { type: 'clipping', status: 'pending_decision', specialist_scope: 'cordelia' },
    'A captured book cover awaiting a decision.',
  );
  const p = proposals.create({
    specialist_id: 'cordelia', kind: 'book_candidate', execution_kind: 'composite',
    payload: { queue_note_path: queue_rel, title_candidate: 'Test Book', author_candidate: null, source_capture_id: 'c_testcapture' },
    rationale: 'Book cover routed by the visual pipeline.',
    signature: { specialist_id: 'cordelia', kind: 'book_candidate', category: 'library_acquisition', anchor: queue_rel },
    user_id: 'jasper',
  });
  proposals.decide(p, 'approve', undefined, undefined, 'acquire');
  const exec = await execute_approved_proposal(
    {
      proposals, memory,
      specialists: { get: () => null } as never,
      tools: { invoke: async () => ({ ok: true, result: {} }) } as never,
      llm: null as never,
    },
    p,
    'acquire',
  );
  check('resolver branch taken and succeeded', exec.path === 'resolver' && 'ok' in exec && exec.ok === true);
  check('queue note mutated by the resolver', /status: queued/.test(readFileSync(join(vault, queue_rel), 'utf8')));
  check('proposal recorded executed', proposals.get(p)!.status === 'executed');

  rmSync(tmp, { recursive: true, force: true });
}

async function main(): Promise<void> {
  delete process.env.HEARTH_PROPOSAL_COURT;
  delete process.env.HEARTH_TRUST_TEETH;
  delete process.env.HEARTH_TRUST_UNDO_MINUTES;
  scorer_pure_checks();
  scorer_gather_checks();
  await teeth_checks();
  await resolver_branch_checks();
  console.log(`\nsmoke:trust-teeth — ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
