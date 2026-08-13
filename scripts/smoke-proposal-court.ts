/**
 * smoke:proposal-court — the Council (src/core/proposal_court.ts).
 *
 * Self-contained: temp db + vault, scripted lens/tiebreak seams, no LLM.
 * Exercises: the kill switch; age gating; consensus-approve on a system kind
 * (trusted_source_addition → the REAL resolver runs against the temp vault);
 * consensus-reject with reasons on record; the LAPSE path for a user-action
 * kind (Kate concurrence required, expired status, NO decide/XP); the
 * owner-class floor (requires_step_up never touched); authorship recusal
 * (the filer's seat passes to the tie-break model); 2-1 split → tie-break
 * invoked → still split stays pending; the single owner digest; the
 * per-convening cap; lens fail-open (a throwing lens abstains, court
 * proceeds).
 *
 * Owner-queue triage gate additions (2026-07-04): split memory (a split case
 * is stamped + excluded from every later docket); digest-supersedes-digest
 * (one court card in the queue, ever); the TRIAGE rung (a scripted judge
 * files work-log/peer-reply cards to the record pre-bench — never the
 * owner-only floor; fail-open on a throwing judge; kill switch); the ROLLUP
 * rung (related cards consolidate into ONE ask, members superseded into it;
 * snoozed/cordoned/owner-only cards never candidates; out-of-range groups
 * dropped; per-convening group cap; kill switch).
 *
 *   bun run smoke:proposal-court
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { ProposalsStore, type ProposalRow } from '@core/proposals';
import {
  convene_proposal_court,
  describe_case,
  is_owner_only,
  owner_only_reason,
  type CourtVote,
  type CourtDeps,
} from '@core/proposal_court';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

function backdate(db: ReturnType<typeof open_db>, id: string, hours: number): void {
  const ts = new Date(Date.now() - hours * 3_600_000).toISOString();
  db.prepare(`UPDATE proposals SET ts_created = @ts WHERE id = @id`).run({ '@ts': ts, '@id': id });
}

async function main(): Promise<void> {
  delete process.env.HEARTH_PROPOSAL_COURT;
  // The triage + rollup rungs are ON-by-default with the court; hold them
  // off for the legacy sections so each rung is exercised deliberately below.
  process.env.HEARTH_COURT_TRIAGE = '0';
  process.env.HEARTH_COURT_ROLLUP = '0';
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-court-'));
  const vault = join(tmp, 'vault');
  mkdirSync(join(vault, 'Knowledge', 'Cordelia'), { recursive: true });
  const db = open_db(join(tmp, 'h.db'));
  const memory = new MemoryClient({ vault_root: vault, db });
  const proposals = new ProposalsStore(db);

  // The trusted_source_addition resolver (run by an approved court case, same
  // as the /decide route) patches config/specialists/<id>.yaml relative to
  // CWD. chdir into a sandboxed config tree with STUB specialist YAMLs so an
  // approved source-add lands in the temp dir, never the real repo files —
  // otherwise vivian.yaml / ruby.yaml get dirtied on every `bun run ci`.
  // Mirrors smoke:scout's resolver sandbox. Stub the ids that any approved
  // trusted_source_addition case targets (vivian, ruby; kate stays pending as
  // a split, but stub it for safety).
  const spec_dir = join(tmp, 'config', 'specialists');
  mkdirSync(spec_dir, { recursive: true });
  for (const [id, name] of [['vivian', 'Vivian'], ['ruby', 'Ruby'], ['kate', 'Kate']] as const) {
    writeFileSync(
      join(spec_dir, `${id}.yaml`),
      `id: ${id}\nname: ${name}\ntrusted_sources:\n  tier_1: []\n  tier_2: []\n`,
    );
  }
  const prev_cwd = process.cwd();
  process.chdir(tmp);

  const sig = (cat: string, anchor: string) =>
    ({ specialist_id: 'cordelia', kind: 'trusted_source_addition', category: cat, anchor }) as const;

  // ── seed the docket ─────────────────────────────────────────────────────
  const p_approve = proposals.create({
    specialist_id: 'cordelia', kind: 'trusted_source_addition', execution_kind: 'none',
    payload: { target_specialist_id: 'vivian', domain: 'example.org', tier: 2, cadence: 'weekly' },
    rationale: 'Well-sourced market data feed with independent authorship; scout judge scored 0.8.', signature: sig('scout', 'example.org'),
  });
  const p_reject = proposals.create({
    specialist_id: 'cordelia', kind: 'trusted_source_addition', execution_kind: 'none',
    payload: { target_specialist_id: 'vivian', domain: 'sketchy.example', tier: 2 },
    rationale: 'Aggregator blog reposting other outlets without attribution; weak authority signals.', signature: sig('scout', 'sketchy.example'),
  });
  const p_split = proposals.create({
    specialist_id: 'cordelia', kind: 'trusted_source_addition', execution_kind: 'none',
    payload: { target_specialist_id: 'kate', domain: 'maybe.example', tier: 1 },
    rationale: 'High-authority publisher but paywalled and rarely relevant to standing racks.', signature: sig('scout', 'maybe.example'),
  });
  const p_lapse = proposals.create({
    specialist_id: 'kate', kind: 'action_proposal', execution_kind: 'none',
    payload: { description: 'Order a birthday gift for the visit on 2026-06-20' },
    rationale: 'Gift window before the visit.', signature: { specialist_id: 'kate', kind: 'action_proposal', category: 'gift', anchor: 'x' },
    user_id: null,
  });
  const p_floor = proposals.create({
    specialist_id: 'trainer', kind: 'recommendation', execution_kind: 'dispatch',
    payload: { description: 'Merge change bc_123', dispatch_tool: 'merge_approved_change', requires_step_up: true },
    rationale: 'Owner merge.', signature: { specialist_id: 'trainer', kind: 'recommendation', category: 'merge', anchor: 'bc_123' },
    skip_kate_review: true, // production path: Kate's pre-gate already promoted it
  });
  const p_recuse = proposals.create({
    specialist_id: 'trainer', kind: 'persona_tuning', execution_kind: 'manual',
    payload: { description: 'Tighten Maggie venue phrasing' },
    rationale: 'Persona drift observed.', signature: { specialist_id: 'trainer', kind: 'persona_tuning', category: 'tuning', anchor: 'maggie' },
    skip_kate_review: true, // production path: Kate's pre-gate already promoted it
  });
  // Fast-track semantics (2026-07-05): a fresh INTERNAL (COURT_KINDS)
  // proposal is examinable immediately — parking a staff enablement behind
  // the 24h owner-first grace was the jerky-flow class. A fresh USER-ACTION
  // proposal keeps the grace (the owner gets first crack at HIS cards).
  const p_fresh = proposals.create({
    specialist_id: 'cordelia', kind: 'trusted_source_addition', execution_kind: 'none',
    payload: { target_specialist_id: 'ruby', domain: 'fresh.example', tier: 2 },
    rationale: 'Municipal agenda mirror discovered this morning; internal kinds skip the aging grace.', signature: sig('scout', 'fresh.example'),
  });
  const p_fresh_user = proposals.create({
    specialist_id: 'kate', kind: 'action_proposal', execution_kind: 'none',
    payload: { description: 'Book the exterior hail inspection this week' },
    rationale: 'Filed an hour ago — the owner sees his cards first.',
    signature: { specialist_id: 'kate', kind: 'action_proposal', category: 'house', anchor: 'hail-check' },
    user_id: null,
  });
  for (const id of [p_approve, p_reject, p_split, p_lapse, p_floor, p_recuse]) backdate(db, id, 48);
  backdate(db, p_fresh, 1);
  backdate(db, p_fresh_user, 1);

  check('floor detector: requires_step_up is owner-only', is_owner_only(proposals.get(p_floor)!));
  check('floor detector: a plain system kind is not', !is_owner_only(proposals.get(p_approve)!));

  // ── scripted seats ──────────────────────────────────────────────────────
  const vote = (seat: string, v: CourtVote['vote'], why = 'scripted'): CourtVote => ({ seat, vote: v, reason: why });
  const script: Record<string, Record<string, CourtVote['vote']>> = {
    [p_fresh]: { mariah: 'approve', trainer: 'approve', kate: 'approve' }, // fast-tracked internal kind
    [p_approve]: { mariah: 'approve', trainer: 'approve', kate: 'approve' },
    [p_reject]: { mariah: 'reject', trainer: 'reject', kate: 'reject' },
    [p_split]: { mariah: 'approve', trainer: 'reject', kate: 'approve' }, // dissent → owner
    [p_lapse]: { mariah: 'lapse', trainer: 'abstain', kate: 'lapse' },
    [p_floor]: { mariah: 'approve', trainer: 'approve', kate: 'approve' }, // must be ignored
    [p_recuse]: { mariah: 'approve', trainer: 'approve', kate: 'approve' }, // trainer's vote must not count
  };
  let tiebreaks = 0;
  const deps: CourtDeps = {
    db, proposals, memory,
    llm: null as unknown as CourtDeps['llm'],
    specialists: { get: () => null } as unknown as CourtDeps['specialists'],
    lens_fn: async (seat, _brief, cases) => cases.map((c) => vote(seat, script[c.id]?.[seat] ?? 'abstain')),
    tiebreak_fn: async (p) => {
      tiebreaks++;
      // recused-trainer replacement seat approves the tuning; the true split stays contested
      return p.id === p_recuse ? vote('qwen-27b', 'approve') : vote('qwen-27b', 'abstain', 'genuinely torn');
    },
  };

  // ── 1. kill switch ──────────────────────────────────────────────────────
  const off = await convene_proposal_court(deps);
  check('kill switch: disabled court examines nothing', off.enabled === false && off.examined === 0);
  process.env.HEARTH_PROPOSAL_COURT = '1';

  // ── 2. the convening ────────────────────────────────────────────────────
  const r = await convene_proposal_court(deps);
  check('docket: aged cases + the fast-tracked fresh internal kind; fresh user-action still excluded', r.examined === 7);
  check('fast-track: a fresh internal kind is decided same-convening', r.approved.includes(p_fresh) && proposals.get(p_fresh)!.status !== 'pending');
  check('owner-first grace holds for a fresh user-action card', proposals.get(p_fresh_user)!.status === 'pending');
  check('consensus approve → decided', r.approved.includes(p_approve) && proposals.get(p_approve)!.status !== 'pending');
  check('approve ran the REAL resolver (subscription upserted)', String(r.cases.find((c) => c.id === p_approve)?.detail ?? '').includes('resolver'));
  check('consensus reject → no longer pending, reasons on record', r.rejected.includes(p_reject) && proposals.get(p_reject)!.status !== 'pending' && (proposals.get(p_reject)!.user_feedback ?? '').includes('proposal court'));
  check('lapse: user-action kind expired, not decided', r.lapsed.includes(p_lapse) && proposals.get(p_lapse)!.status === 'expired');
  check('floor: step-up proposal untouched despite unanimous approve', r.owner_class >= 1 && proposals.get(p_floor)!.status === 'pending');
  check('recusal: trainer-filed case decided WITHOUT trainer voting', r.approved.includes(p_recuse) && r.cases.find((c) => c.id === p_recuse)!.votes.every((v) => v.seat !== 'trainer'));
  check('dissent → stays pending for the owner (no outvoting)', r.split.includes(p_split) && proposals.get(p_split)!.status === 'pending');
  check('tie-break seat consulted ONLY for the recusal fill', tiebreaks === 1);
  const digest = proposals.get(r.digest_id ?? '');
  check('ONE owner digest filed', Boolean(digest && digest.kind === 'briefing'));

  // ── 3. cap ──────────────────────────────────────────────────────────────
  process.env.HEARTH_COURT_MAX_DECIDES = '1';
  const extra = proposals.create({
    specialist_id: 'cordelia', kind: 'trusted_source_addition', execution_kind: 'none',
    payload: { target_specialist_id: 'ruby', domain: 'another.example', tier: 2 },
    rationale: 'County records index with stable citations; complements the civic ledger sources.', signature: sig('scout', 'another.example'),
  });
  backdate(db, extra, 48);
  const capped = await convene_proposal_court({ ...deps, lens_fn: async (seat, _b, cases) => cases.map(() => vote(seat, 'approve')) });
  check('cap bounds the docket per convening', capped.cases.length <= 1);
  delete process.env.HEARTH_COURT_MAX_DECIDES;

  // ── 3b. every seat is briefed that `lapse` is a votable verdict ──────────
  // `lapse_consensus` needs unanimity among the non-abstaining seats, so ONE
  // seat that was never told lapse exists votes approve and vetoes every
  // timeliness lapse. That was live until 2026-07-18 (only Kate's brief named
  // it; zero all-lapse tallies formed across 947 verdicts and the owner queue
  // grew without bound). Assert against the brief the court actually HANDS the
  // seat, so rewording a lens can't silently resurrect the veto.
  // Needs at least one seatable case, or the court short-circuits on an empty
  // docket and no seat is ever briefed. Until 2026-08-02 this leaned on
  // `p_floor` being immortal — an owner_class case stamped nothing and so came
  // back to the bench at every convening. Now that such a case is parked after
  // its one hand-off, the section brings its own card and retires it straight
  // after, so it can't perturb the docket-ordering checks that follow.
  const briefable = proposals.create({
    specialist_id: 'cordelia', kind: 'trusted_source_addition', execution_kind: 'none',
    payload: { target_specialist_id: 'ruby', domain: 'briefable.example', tier: 2 },
    rationale: 'A seatable case so the bench actually convenes for the brief assertion.',
    signature: sig('scout', 'briefable.example'),
  });
  backdate(db, briefable, 48);
  const briefs = new Map<string, string>();
  await convene_proposal_court({
    ...deps,
    lens_fn: async (seat, brief, cases) => {
      briefs.set(seat, brief);
      return cases.map(() => vote(seat, 'abstain'));
    },
  });
  proposals.expire_one(briefable, 'smoke fixture: retired after the brief assertion');
  check('every court seat was briefed', briefs.size === 3);
  for (const [seat, brief] of briefs) {
    check(`lens brief for ${seat} offers the lapse verdict`, /\blapse\b/i.test(brief));
  }

  // ── 3c. docket seats the OLDEST eligible case, not the newest ───────────
  // `list()` returns newest-first; a plain slice(0, cap) re-judged each day's
  // fresh inflow forever while aged cards — the ones `lapse` exists to retire —
  // were never seated at all.
  process.env.HEARTH_COURT_MAX_DECIDES = '1';
  const p_old = proposals.create({
    specialist_id: 'cordelia', kind: 'trusted_source_addition', execution_kind: 'none',
    payload: { target_specialist_id: 'ruby', domain: 'aged.example', tier: 2 },
    rationale: 'Aged candidate seeded to prove the docket reaches the back of the queue.',
    signature: sig('scout', 'aged.example'),
  });
  const p_new = proposals.create({
    specialist_id: 'cordelia', kind: 'trusted_source_addition', execution_kind: 'none',
    payload: { target_specialist_id: 'ruby', domain: 'fresh.example', tier: 2 },
    rationale: 'Recent candidate that must not monopolize the single docket slot.',
    signature: sig('scout', 'fresh.example'),
  });
  backdate(db, p_old, 30 * 24);
  backdate(db, p_new, 48);
  const seated: string[] = [];
  await convene_proposal_court({
    ...deps,
    lens_fn: async (seat, _b, cases) => {
      if (seat === 'mariah') seated.push(...cases.map((c) => c.id));
      return cases.map(() => vote(seat, 'abstain'));
    },
  });
  check('the aged case takes the scarce docket slot', seated.includes(p_old));
  check('the fresh case waits its turn', !seated.includes(p_new));
  delete process.env.HEARTH_COURT_MAX_DECIDES;

  // ── 4. lens fail-open ───────────────────────────────────────────────────
  const boom = await convene_proposal_court({
    ...deps,
    lens_fn: async (seat) => {
      if (seat === 'mariah') throw new Error('lens down');
      return [];
    },
  });
  check('a throwing lens abstains; the court survives', boom.enabled === true);

  // ── 5. split memory + digest-supersedes-digest ──────────────────────────
  // (Same-day convenings idempotency-collapse into ONE digest row via the
  // date-anchored signature — the stale-digest problem is CROSS-day, so
  // fabricate yesterday's digest to prove the supersession.)
  check('split case is stamped', proposals.get(p_split)!.court_split_at !== null);
  const stale_digest = proposals.create({
    specialist_id: 'kate', kind: 'briefing', execution_kind: 'none',
    payload: { topic: 'Proposal Court — 0 approved, 0 declined (yesterday)', depth: 'quick', body_md: '-' },
    rationale: 'Yesterday\'s court digest.',
    signature: { specialist_id: 'kate', kind: 'briefing', category: 'proposal_court', anchor: 'yesterday' },
    user_id: null,
  });
  backdate(db, stale_digest, 30);
  const r5 = await convene_proposal_court(deps);
  check('a stamped split never re-enters the docket', r5.cases.every((c) => c.id !== p_split) && proposals.get(p_split)!.status === 'pending');
  check('split case is parked with its reason',
    proposals.get(p_split)!.court_parked_at != null &&
    proposals.get(p_split)!.court_parked_reason === 'split');

  // 2026-08-02 — the OTHER way a case becomes the owner's. `owner_class`
  // stamped nothing, so floor cases were re-seated and re-digested at every
  // convening forever: 12 of the 28 live pending proposals were >29 days old
  // and three ids drew an owner_class verdict three times in ONE day. Parking
  // is a bench-rotation stamp only — the card stays pending in the queue.
  check('owner-class floor case is parked', proposals.get(p_floor)!.court_parked_at != null);
  check('…with the reason that made it owner-only',
    proposals.get(p_floor)!.court_parked_reason === 'step_up');
  check('…and is STILL pending for the owner', proposals.get(p_floor)!.status === 'pending');
  check('a parked floor case never re-enters the docket', r5.cases.every((c) => c.id !== p_floor));

  // The one UNSTABLE reason must not be parked: floor-by-default because the
  // registry doesn't know the tool YET is a safety stance, not a property.
  {
    const p_unknown = proposals.create({
      specialist_id: 'kate', kind: 'action_proposal', execution_kind: 'dispatch',
      payload: { description: 'Dispatch to a tool that is not registered yet', dispatch_tool: 'not_registered_yet' },
      rationale: 'The registry has never seen this tool name.',
      signature: { specialist_id: 'kate', kind: 'action_proposal', category: 'unknown_tool', anchor: 'u1' },
      user_id: null,
    });
    backdate(db, p_unknown, 48);
    const row = () => proposals.get(p_unknown)!;
    check('unknown dispatch tool is owner-only (floor by default)', is_owner_only(row(), () => null));
    check('…reported as the unstable reason', owner_only_reason(row(), () => null) === 'unknown_tool');
    const r_unknown = await convene_proposal_court(deps);
    check('…seated by the bench rather than parked', r_unknown.cases.some((c) => c.id === p_unknown));
    check('…and left unparked so a later registration can lift the floor',
      row().court_parked_at == null);
  }
  const old_digest = proposals.get(stale_digest);
  check(
    'yesterday\'s digest superseded by today\'s (one court card, ever)',
    Boolean(old_digest && old_digest.status === 'superseded' && old_digest.superseded_by === r5.digest_id),
  );

  // ── 5b. a split is a COOLDOWN, not a grave (the drain fix, 2026-08-02) ───
  // Live proof of the bug this closes: every one of the 28 pending proposals
  // carried outcome `split` and had been judged exactly ONCE, the oldest
  // sitting 41 days. Parking treated "the bench disagreed" the same as "the
  // bench has no authority", so the owner's tap became the only exit and
  // splits accreted forever.
  {
    const park_age = (id: string, days: number): void => {
      const ts = new Date(Date.now() - days * 86_400_000).toISOString();
      db.prepare(`UPDATE proposals SET court_parked_at = @ts WHERE id = @id`).run({ '@ts': ts, '@id': id });
    };
    const rehears = (id: string): number => proposals.get(id)!.court_rehear_count ?? 0;

    check('a fresh split is still off the docket (cooldown holds)',
      (await convene_proposal_court(deps)).cases.every((c) => c.id !== p_split));
    check('…and has not been re-heard', rehears(p_split) === 0);

    park_age(p_split, 30); // past HEARTH_COURT_SPLIT_COOLDOWN_DAYS (10)
    const r_re1 = await convene_proposal_court(deps);
    check('a cooled-off split IS re-seated', r_re1.cases.some((c) => c.id === p_split));
    check('…the re-hearing is counted', rehears(p_split) === 1);
    check('…and it stays pending, not force-decided', proposals.get(p_split)!.status === 'pending');
    check('…the park stamp moved, so the next cooldown starts now',
      Date.parse(proposals.get(p_split)!.court_parked_at!) > Date.now() - 60_000);
    check('…so it does NOT re-seat again immediately',
      (await convene_proposal_court(deps)).cases.every((c) => c.id !== p_split));

    park_age(p_split, 30);
    await convene_proposal_court(deps);
    check('a second cooldown yields a second re-hearing', rehears(p_split) === 2);

    // Budget spent: the bench has failed to agree across weeks. That is not a
    // live disagreement, it is an undecidable one — retire it honestly.
    park_age(p_split, 30);
    const r_lapse = await convene_proposal_court(deps);
    check('past the re-hearing budget the case LAPSES instead of cycling',
      proposals.get(p_split)!.status === 'expired' && r_lapse.lapsed.includes(p_split));
    check('…recorded as a timing verdict, never a rejection',
      (proposals.get(p_split)!.user_feedback ?? '').includes('without consensus or owner action'));
    check('…and it never comes back',
      (await convene_proposal_court(deps)).cases.every((c) => c.id !== p_split));

    // A park the bench genuinely cannot move is untouched by all of this.
    park_age(p_floor, 90);
    check('an owner-class park is NEVER re-heard, however old',
      (await convene_proposal_court(deps)).cases.every((c) => c.id !== p_floor) &&
      proposals.get(p_floor)!.status === 'pending');
  }

  // ── 5c. the drain, read as a learning signal ─────────────────────────────
  {
    const y = proposals.filing_yield({ window_days: 90 });
    check('a lapsed filing counts against yield, not toward it',
      y.some((g) => g.lapsed > 0 && (g.yield_rate ?? 1) < 1));
    check('yield stays null until something is terminal',
      y.every((g) => g.yield_rate !== null || g.acted + g.denied + g.lapsed === 0));
    check('every filing lands in exactly one bucket',
      y.every((g) => g.acted + g.denied + g.lapsed + g.open === g.filed));
  }

  // ── 6. the triage rung ──────────────────────────────────────────────────
  process.env.HEARTH_COURT_TRIAGE = '1';
  const t_worklog = proposals.create({
    specialist_id: 'kate', kind: 'action_proposal', execution_kind: 'none',
    payload: { description: 'Routine 22:00 reflection log' },
    rationale: 'Routine 22:00 reflection log. Quiet night, nothing needed attention.',
    signature: { specialist_id: 'kate', kind: 'action_proposal', category: 'log', anchor: 'n1' },
    user_id: null,
  });
  const t_decision = proposals.create({
    specialist_id: 'kate', kind: 'action_proposal', execution_kind: 'none',
    payload: { description: 'Order the gift before Friday?' },
    rationale: 'The birthday window closes Friday — want me to order the trail guide?',
    signature: { specialist_id: 'kate', kind: 'action_proposal', category: 'gift', anchor: 'n2' },
    user_id: null,
  });
  backdate(db, t_worklog, 48);
  backdate(db, t_decision, 48);

  let triage_seen: string[] = [];
  const triage_deps: CourtDeps = {
    ...deps,
    lens_fn: async (seat, _b, cases) => cases.map(() => vote(seat, 'abstain')),
    triage_fn: async (cases) => {
      triage_seen = cases.map((c) => c.id);
      return cases.map((c) => ({
        id: c.id,
        class: c.id === t_worklog ? ('work_log' as const) : ('decision' as const),
        reason: c.id === t_worklog ? 'reports work already done' : 'genuine ask',
      }));
    },
  };
  const r6 = await convene_proposal_court(triage_deps);
  check('triage: work-log card filed to the record (expired, no XP)', r6.triaged_out.includes(t_worklog) && proposals.get(t_worklog)!.status === 'expired' && (proposals.get(t_worklog)!.user_feedback ?? '').includes('court triage: work log'));
  check('triage: a genuine decision proceeds untouched', !r6.triaged_out.includes(t_decision) && proposals.get(t_decision)!.status === 'pending');
  check('triage: the owner-only floor never reaches the judge', !triage_seen.includes(p_floor));
  check('triage: expired card left the bench docket', r6.cases.every((c) => c.id !== t_worklog));

  const r6b = await convene_proposal_court({
    ...triage_deps,
    triage_fn: async () => { throw new Error('judge down'); },
  });
  check('triage fail-open: a throwing judge expires nothing', r6b.triaged_out.length === 0 && proposals.get(t_decision)!.status === 'pending');

  process.env.HEARTH_COURT_TRIAGE = '0';
  let triage_called = false;
  await convene_proposal_court({
    ...triage_deps,
    triage_fn: async (cases) => { triage_called = true; return cases.map((c) => ({ id: c.id, class: 'decision' as const, reason: '' })); },
  });
  check('triage kill switch: judge never consulted', triage_called === false);

  // ── 7. the rollup rung ──────────────────────────────────────────────────
  process.env.HEARTH_COURT_ROLLUP = '1';
  const seed_ap = (n: number, desc: string, extra?: { user_id?: string }): string => {
    const id = proposals.create({
      specialist_id: 'kate', kind: 'action_proposal', execution_kind: 'none',
      payload: { description: desc },
      rationale: desc,
      signature: { specialist_id: 'kate', kind: 'action_proposal', category: 'sensor', anchor: `s${n}` },
      user_id: extra?.user_id ?? null,
    });
    backdate(db, id, 48);
    return id;
  };
  const r_a = seed_ap(1, 'EV battery sensor down 12h — investigate?');
  const r_b = seed_ap(2, 'EV battery SOC unavailable since morning — flag to owner');
  const r_c = seed_ap(3, 'Ioniq 5 battery sensor dark — needs a decision on the integration');
  const r_cordoned = seed_ap(4, 'A member-private card that must never roll up', { user_id: 'u_lee' });
  const r_snoozed = seed_ap(5, 'A snoozed card that must never roll up');
  db.prepare(`UPDATE proposals SET snoozed_until = @u WHERE id = @id`).run({ '@u': new Date(Date.now() + 86_400_000).toISOString(), '@id': r_snoozed });

  let rollup_candidate_ids: string[] = [];
  const rollup_deps: CourtDeps = {
    ...deps,
    lens_fn: async (seat, _b, cases) => cases.map(() => vote(seat, 'abstain')),
    rollup_fn: async (cases) => {
      rollup_candidate_ids = cases.map((c) => c.id);
      const idx = (id: string) => cases.findIndex((c) => c.id === id) + 1;
      return [
        { theme: 'EV battery sensor outage', ask: 'One decision: investigate the Ioniq 5 SOC integration or wait it out.', members: [idx(r_a), idx(r_b), idx(r_c)] },
        { theme: 'bogus out-of-range', ask: 'must be dropped', members: [500, 501] },
      ];
    },
  };
  const r7 = await convene_proposal_court(rollup_deps);
  check('rollup: candidates exclude snoozed + cordoned + owner-only', !rollup_candidate_ids.includes(r_snoozed) && !rollup_candidate_ids.includes(r_cordoned) && !rollup_candidate_ids.includes(p_floor) && rollup_candidate_ids.includes(r_a));
  check('rollup: ONE consolidated card created; bogus group dropped', r7.rollups.length === 1);
  const rollup_id = r7.rollups[0]!;
  const rollup_row = proposals.get(rollup_id)!;
  check('rollup card: pending kate ask carrying member ids', rollup_row.status === 'pending' && rollup_row.kind === 'action_proposal' && (JSON.parse(rollup_row.payload_json) as { member_ids?: string[] }).member_ids?.length === 3);
  check('rollup members superseded INTO the rollup', [r_a, r_b, r_c].every((id) => proposals.get(id)!.status === 'superseded' && proposals.get(id)!.superseded_by === rollup_id));
  check('rollup: untouched cards stay pending', proposals.get(r_cordoned)!.status === 'pending' && proposals.get(t_decision)!.status === 'pending');

  // group cap: 8 fresh related-ish cards, 4 scripted groups → only 3 applied.
  const cap_ids = Array.from({ length: 8 }, (_, i) => seed_ap(10 + i, `cap fodder ${i}`));
  const r8 = await convene_proposal_court({
    ...rollup_deps,
    rollup_fn: async (cases) => {
      const idx = (id: string) => cases.findIndex((c) => c.id === id) + 1;
      return [0, 1, 2, 3].map((g) => ({
        theme: `group ${g}`, ask: 'consolidated', members: [idx(cap_ids[g * 2]!), idx(cap_ids[g * 2 + 1]!)],
      }));
    },
  });
  check('rollup: per-convening group cap holds', r8.rollups.length === 3);

  process.env.HEARTH_COURT_ROLLUP = '0';
  let rollup_called = false;
  await convene_proposal_court({
    ...rollup_deps,
    rollup_fn: async () => { rollup_called = true; return []; },
  });
  check('rollup kill switch: grouper never consulted', rollup_called === false);
  // ── 8. digest humanizer (kate_line slice, 2026-07-04) ───────────────────
  // Deterministic case lines: card title + prose outcome, dissenter named,
  // seat 'trainer' rendered as Beatrice, no raw proposal ids on the card.
  const v = (seat: string, vote_: 'approve' | 'reject'): { seat: string; vote: 'approve' | 'reject'; reason: string } =>
    ({ seat, vote: vote_, reason: 'x' });
  const line_ok = describe_case({
    id: '01X', kind: 'action_proposal', outcome: 'approved',
    votes: [v('kate', 'approve'), v('trainer', 'approve'), v('mariah', 'approve')],
    title: 'Order the furnace filters',
  });
  check('approved line: title + unanimously, no raw id',
    line_ok.includes('Order the furnace filters') && line_ok.includes('unanimously') && !line_ok.includes('01X'));
  const line_rej = describe_case({
    id: '01Y', kind: 'trusted_source_addition', outcome: 'rejected',
    votes: [v('kate', 'approve'), v('trainer', 'reject'), v('mariah', 'reject')],
    title: 'Add example.com to sources',
  });
  check('declined line names dissenters, trainer → Beatrice',
    line_rej.includes('declined') && line_rej.includes('Beatrice') && line_rej.includes('Mariah'));
  const line_fallback = describe_case({ id: '01Z', kind: 'briefing', outcome: 'owner_class', votes: [] });
  check('missing title falls back to the kind', line_fallback.includes('briefing'));

  delete process.env.HEARTH_PROPOSAL_COURT;
  delete process.env.HEARTH_COURT_TRIAGE;
  delete process.env.HEARTH_COURT_ROLLUP;
  process.chdir(prev_cwd);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\nsmoke:proposal-court — ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
