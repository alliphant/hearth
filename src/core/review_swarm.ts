/**
 * review_swarm — grow the single code-critic (Vera) into a red/blue/JUDGE bench.
 *
 * When a Beatrice code change lands in `pending_kate_review`, the swarm fans out
 * a small bench of critic sub-agents over it: RED seats attack the diff (find the
 * break), a BLUE seat refutes/repairs the red findings, and a JUDGE adjudicates a
 * verdict. Every seat is one `runtime.turn` on the existing `critic` profile
 * (Vera) — same tool-using spine as `delegate to:'critic'`, just N of them,
 * bounded by a dedicated Semaphore so the shared 35B isn't starved. NO new agent
 * runtime.
 *
 * INFORM-ONLY (2026-07-21, owner-decided): the swarm persists its findings +
 * verdict and reports them to Kate as an FYI. It does NOT touch `review_change`
 * or the code-teeth guard — Kate still rules, the owner still merges. The rows +
 * `swarm_*` events drive the live iOS bee icon + web Code Shop panel.
 *
 * DARK behind HEARTH_REVIEW_SWARM (flag off ⇒ `commission_review_swarm` is a
 * no-op ⇒ byte-identical behavior). See docs/build-kate-swarm-beeicon.md.
 */
import type { Database } from 'bun:sqlite';
import { Semaphore } from './semaphore';
import type { SpecialistTurnInput, SpecialistTurnOutput } from './specialist_runtime';
import type { AppEvent } from '@app/events';
import { ChangeRecordsStore, type ChangeRecord } from '@memory/stores/change_records';
import { emit_job_progress, job_from_swarm_row } from './jobs';
import {
  SwarmReviewStore,
  type SwarmSeatSpec,
  type SwarmRole,
  type SwarmSeatPhase,
  type SwarmVerdict,
  type SwarmSeverity,
  type SwarmTier,
} from '@memory/stores/swarm_reviews';

/** The narrow slice of SpecialistRuntime the swarm needs — same structural
 *  contract DelegationRunner uses, so the production runtime satisfies it. */
export interface SwarmTurnRunner {
  turn(input: SpecialistTurnInput): Promise<SpecialistTurnOutput>;
}

interface SwarmInbox {
  push(msg: {
    from_specialist_id: string;
    to_specialist_id: string;
    kind: string;
    body_md: string;
  }): string;
}

export interface SwarmDeps {
  runtime: SwarmTurnRunner;
  events: { emit: (e: AppEvent) => void };
  db: Database;
  inbox: SwarmInbox;
}

/** The bench: 2 red + 1 blue + judge (owner-chosen 2026-07-21). */
const SEATS: Array<{ seat_id: string; role: SwarmRole }> = [
  { seat_id: 'red-1', role: 'red' },
  { seat_id: 'red-2', role: 'red' },
  { seat_id: 'blue-1', role: 'blue' },
  { seat_id: 'judge', role: 'judge' },
];

/**
 * The HIGHER COURT (2026-07-21) — where a `block` goes on appeal. Deliberately
 * NOT more red/blue: three DIFFERENT lenses on DIFFERENT profiles, run on the
 * DEPTH tier with thinking ON (`specialist_deliberation`) instead of the bench's
 * fast think-OFF pass. The change's author (`trainer`) is recused by construction.
 * It answers exactly one question: is the blocker real enough to stand?
 */
const HIGHER_COURT_SEATS: Array<{
  seat_id: string;
  role: SwarmRole;
  profile: string;
  lens: string;
}> = [
  {
    seat_id: 'hc-evidence',
    role: 'evidence',
    profile: 'mariah',
    lens: 'EVIDENCE — is the blocker actually supported by the diff and the real repo, or merely asserted?',
  },
  {
    seat_id: 'hc-mechanism',
    role: 'mechanism',
    profile: 'critic',
    lens: 'MECHANISM — trace the code yourself. Does it genuinely do the wrong thing the blocker claims?',
  },
  {
    seat_id: 'hc-impact',
    role: 'impact',
    profile: 'kate',
    lens: 'BLAST RADIUS — if this shipped as-is, what actually breaks, and does it matter to the household?',
  },
];

const SWARM_MAX_TOKENS = 1500;
const HIGHER_COURT_MAX_TOKENS = 1200;

let cfg: SwarmDeps | null = null;

/** Wire the swarm to the orchestrator singletons — called once at boot. */
export function configure_review_swarm(deps: SwarmDeps): void {
  cfg = deps;
}

function swarm_enabled(): boolean {
  return process.env.HEARTH_REVIEW_SWARM === '1';
}

function swarm_concurrency(): number {
  const n = Number(process.env.HEARTH_SWARM_CONCURRENCY ?? '2');
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
}

/** The appeal rides with the swarm; HEARTH_SWARM_HIGHER_COURT=0 disables it. */
function higher_court_enabled(): boolean {
  return process.env.HEARTH_SWARM_HIGHER_COURT !== '0';
}

/**
 * Commission a swarm over a freshly-routed code change. Called from
 * `route_change_for_review`. No-op unless the flag is on, the swarm is wired,
 * and the change is code (config tunings skip it). Fire-and-forget: the run is
 * detached so it never blocks the build's return.
 */
export function commission_review_swarm(input: {
  change_id: string;
  change_kind: string;
  user_id?: string | null;
}): void {
  if (!swarm_enabled() || !cfg || input.change_kind !== 'code') return;
  const deps = cfg;
  const store = new SwarmReviewStore(deps.db);
  if (store.has_active_for_change(input.change_id)) return; // dedup: one live run per change
  void run_swarm(deps, input.change_id, input.user_id ?? null).catch((err) => {
    console.error('[review-swarm] run failed:', (err as Error)?.message ?? err);
  });
}

/**
 * Patch the "On the Fire" ledger after a persist. Re-reads the committed row so
 * the emit reflects what is actually in the table — same discipline as the media
 * runner's `record_slice`. Fail-open: this is a UI signal, never a reason to
 * fail a review.
 *
 * This is why the bench no longer needs a floating glyph of its own (deleted
 * 2026-07-30): a review is one row in the single pane that holds every piece of
 * live background work.
 */
function patch_ledger(deps: SwarmDeps, store: SwarmReviewStore, review_id: string): void {
  try {
    const row = store.get(review_id);
    if (row) emit_job_progress(deps.events, job_from_swarm_row(row, store.get_findings(review_id)));
  } catch {
    /* the ledger patch is best-effort */
  }
}

async function run_swarm(
  deps: SwarmDeps,
  change_id: string,
  user_id: string | null,
): Promise<void> {
  const changes = new ChangeRecordsStore(deps.db);
  const change = changes.get(change_id);
  if (!change) return;

  const store = new SwarmReviewStore(deps.db);
  const review_id = `swr_${crypto.randomUUID()}`;
  const bench: SwarmSeatSpec[] = SEATS.map((s) => ({
    seat_id: s.seat_id,
    role: s.role,
    conversation_id: `swarm:${review_id}:${s.seat_id}`,
  }));
  const title = deriveTitle(change);

  store.create({ id: review_id, change_id, title, bench, user_id, tier: 'bench' });
  patch_ledger(deps, store, review_id);
  emit(deps, {
    type: 'swarm_review_started',
    review_id,
    change_id,
    title,
    bench,
    tier: 'bench',
    user_id,
  });

  const emitSeat = (seat: SwarmSeatSpec, phase: SwarmSeatPhase, summary?: string) =>
    emit(deps, {
      type: 'swarm_seat_update',
      review_id,
      change_id,
      seat_id: seat.seat_id,
      role: seat.role,
      phase,
      ...(summary ? { summary } : {}),
      tier: 'bench',
      user_id,
    });

  const addFinding = (
    seat: SwarmSeatSpec,
    severity: SwarmSeverity,
    summary: string,
  ) => {
    store.add_finding({ review_id, seat_id: seat.seat_id, role: seat.role, severity, summary });
    patch_ledger(deps, store, review_id);
    emit(deps, {
      type: 'swarm_finding_added',
      review_id,
      change_id,
      seat_id: seat.seat_id,
      severity,
      summary,
      refuted: false,
      tier: 'bench',
      user_id,
    });
  };

  try {
    const pool = new Semaphore(swarm_concurrency());

    // RED seats attack in parallel (bounded by the pool).
    const redSeats = bench.filter((s) => s.role === 'red');
    const redResults: Array<{ seat: SwarmSeatSpec; digest: string }> = [];
    await Promise.all(
      redSeats.map((seat) =>
        pool.with_slot(async () => {
          emitSeat(seat, 'working');
          try {
            const digest = await runSeat(deps, seat, redFraming(change, seat));
            redResults.push({ seat, digest });
            const finding = extractFinding(digest);
            if (finding) addFinding(seat, finding.severity, finding.summary);
            emitSeat(seat, 'done', snippet(digest));
          } catch {
            emitSeat(seat, 'failed', 'review error');
          }
        }),
      ),
    );

    // BLUE seat refutes/repairs, seeing the red findings.
    const blueSeat = bench.find((s) => s.role === 'blue');
    let blueDigest = '';
    if (blueSeat) {
      emitSeat(blueSeat, 'working');
      try {
        blueDigest = await pool.with_slot(() =>
          runSeat(deps, blueSeat, blueFraming(change, redResults)),
        );
        const finding = extractFinding(blueDigest);
        if (finding) addFinding(blueSeat, finding.severity, finding.summary);
        emitSeat(blueSeat, 'done', snippet(blueDigest));
      } catch {
        emitSeat(blueSeat, 'failed', 'review error');
      }
    }

    // JUDGE adjudicates. Parse its verdict; fall back to the deterministic rule
    // over the findings ledger if the judge turn fails or is unparseable.
    const judgeSeat = bench.find((s) => s.role === 'judge');
    let verdict: SwarmVerdict = deriveVerdict(store.get_findings(review_id));
    if (judgeSeat) {
      emitSeat(judgeSeat, 'working');
      try {
        const judgeDigest = await pool.with_slot(() =>
          runSeat(deps, judgeSeat, judgeFraming(change, redResults, blueDigest)),
        );
        verdict = parseVerdict(judgeDigest) ?? verdict;
        emitSeat(judgeSeat, 'done', snippet(judgeDigest));
      } catch {
        emitSeat(judgeSeat, 'failed', 'adjudication error');
      }
    }

    store.set_verdict(review_id, verdict);
    patch_ledger(deps, store, review_id);
    emit(deps, { type: 'swarm_verdict', review_id, change_id, verdict, tier: 'bench', user_id });

    // A BLOCK is not the last word. It escalates ONCE to the higher court, which
    // re-reads the change through three different lenses on the depth tier and
    // rules whether the blocker is real enough to stand. Bounded by construction:
    // the higher court itself never escalates.
    let final_verdict: SwarmVerdict = verdict;
    let ruling: 'upheld' | 'overturned' | null = null;
    if (verdict === 'block' && higher_court_enabled()) {
      const appeal = await run_higher_court(deps, change, title, review_id, store, user_id, {
        blue: blueDigest,
        findings: store.get_findings(review_id),
      });
      ruling = appeal.ruling;
      final_verdict = appeal.verdict;
    }
    informKate(deps, change_id, title, final_verdict, store.get_findings(review_id).length, ruling);
  } catch (err) {
    store.fail(review_id);
    patch_ledger(deps, store, review_id);
    console.error('[review-swarm] aborted:', (err as Error)?.message ?? err);
  }
}

async function runSeat(
  deps: SwarmDeps,
  seat: SwarmSeatSpec,
  framing: string,
  opts?: { profile?: string; deep?: boolean; max_tokens?: number },
): Promise<string> {
  const out = await deps.runtime.turn({
    specialist_id: opts?.profile ?? 'critic',
    conversation_id: seat.conversation_id,
    message: { role: 'specialist', content: framing, from_specialist_id: 'kate' },
    conversation_history: [],
    max_tokens_override: opts?.max_tokens ?? SWARM_MAX_TOKENS,
    // The higher court thinks harder than the bench: depth tier, think ON.
    ...(opts?.deep ? { llm_role: 'specialist_deliberation' as const } : {}),
  });
  return out.message_text.trim();
}

/**
 * The appeal. Three lenses, depth tier, author recused — each votes UPHOLD or
 * OVERTURN on the bench's block. Majority rules; a tie, a failed seat, or an
 * unparseable vote UPHOLDS (fail-closed: a block stands unless the appeal
 * clearly clears it). Never escalates further.
 */
async function run_higher_court(
  deps: SwarmDeps,
  change: ChangeRecord,
  title: string,
  bench_review_id: string,
  store: SwarmReviewStore,
  user_id: string | null,
  evidence: { blue: string; findings: Array<{ severity: SwarmSeverity; summary: string }> },
): Promise<{ verdict: SwarmVerdict; ruling: 'upheld' | 'overturned' }> {
  const review_id = `swr_${crypto.randomUUID()}`;
  const bench: SwarmSeatSpec[] = HIGHER_COURT_SEATS.map((s) => ({
    seat_id: s.seat_id,
    role: s.role,
    conversation_id: `swarm:${review_id}:${s.seat_id}`,
  }));

  store.create({
    id: review_id,
    change_id: change.id,
    title,
    bench,
    user_id,
    tier: 'higher_court',
    escalated_from: bench_review_id,
  });
  emit(deps, {
    type: 'swarm_review_started',
    review_id,
    change_id: change.id,
    title,
    bench,
    tier: 'higher_court',
    escalated_from: bench_review_id,
    user_id,
  });

  const seatUpdate = (seat: SwarmSeatSpec, phase: SwarmSeatPhase, summary?: string) =>
    emit(deps, {
      type: 'swarm_seat_update',
      review_id,
      change_id: change.id,
      seat_id: seat.seat_id,
      role: seat.role,
      phase,
      ...(summary ? { summary } : {}),
      tier: 'higher_court',
      user_id,
    });

  const pool = new Semaphore(swarm_concurrency());
  const votes: Array<'uphold' | 'overturn'> = [];

  await Promise.all(
    HIGHER_COURT_SEATS.map((spec, i) => {
      const seat = bench[i];
      if (!seat) return Promise.resolve();
      return pool.with_slot(async () => {
        seatUpdate(seat, 'working');
        try {
          const digest = await runSeat(
            deps,
            seat,
            higherCourtFraming(change, spec.lens, evidence),
            { profile: spec.profile, deep: true, max_tokens: HIGHER_COURT_MAX_TOKENS },
          );
          const vote = parseAppealVote(digest) ?? 'uphold';
          votes.push(vote);
          const severity: SwarmSeverity = vote === 'uphold' ? 'blocker' : 'nit';
          const summary = `${vote.toUpperCase()} — ${snippet(digest)}`;
          store.add_finding({ review_id, seat_id: seat.seat_id, role: seat.role, severity, summary });
    patch_ledger(deps, store, review_id);
          emit(deps, {
            type: 'swarm_finding_added',
            review_id,
            change_id: change.id,
            seat_id: seat.seat_id,
            severity,
            summary,
            refuted: false,
            tier: 'higher_court',
            user_id,
          });
          seatUpdate(seat, 'done', summary);
        } catch {
          votes.push('uphold'); // a seat that cannot sit cannot clear a blocker
          seatUpdate(seat, 'failed', 'appeal error');
        }
      });
    }),
  );

  const overturns = votes.filter((v) => v === 'overturn').length;
  const ruling: 'upheld' | 'overturned' =
    overturns > votes.length / 2 ? 'overturned' : 'upheld';
  const verdict: SwarmVerdict = ruling === 'overturned' ? 'pass_with_concerns' : 'block';

  store.set_verdict(review_id, verdict);
  patch_ledger(deps, store, review_id);
  emit(deps, {
    type: 'swarm_verdict',
    review_id,
    change_id: change.id,
    verdict,
    tier: 'higher_court',
    ruling,
    user_id,
  });
  return { verdict, ruling };
}

function higherCourtFraming(
  change: ChangeRecord,
  lens: string,
  evidence: { blue: string; findings: Array<{ severity: SwarmSeverity; summary: string }> },
): string {
  const blockers =
    evidence.findings
      .filter((f) => f.severity === 'blocker')
      .map((f) => `- ${f.summary}`)
      .join('\n') || '- (none recorded)';
  return (
    `You sit on the HIGHER COURT hearing an APPEAL. A first bench BLOCKED Beatrice's code ` +
    `${changeContext(change)}\n\nYour lens: ${lens}\n\n` +
    `The blocking finding(s):\n${blockers}\n\n` +
    `The defending response:\n${snippet(evidence.blue) || '- (none)'}\n\n` +
    `Read the change yourself with read_change_for_critique('${change.id}') and verify it against the ` +
    `REAL repo — do not take the first bench's word for it. Then answer one question through your lens: ` +
    `is the blocker real and severe enough to stop this change?\n\n` +
    `On the FIRST line output EXACTLY one word: UPHOLD (the block stands) or OVERTURN (the block does ` +
    `not hold). Then 2-3 sentences of grounded reasoning citing what you actually verified.`
  );
}

function parseAppealVote(digest: string): 'uphold' | 'overturn' | null {
  const scan = (s: string): 'uphold' | 'overturn' | null => {
    if (/\bOVERTURN/.test(s)) return 'overturn';
    if (/\bUPHOLD|\bUPHELD/.test(s)) return 'uphold';
    return null;
  };
  // The first line is the declared vote; fall back to a whole-text scan.
  const first = (digest.trim().split('\n')[0] ?? '').toUpperCase();
  return scan(first) ?? scan(digest.toUpperCase());
}

// ── framings ────────────────────────────────────────────────────────────────

function changeContext(change: ChangeRecord): string {
  const files = change.files.slice(0, 12).join(', ') || 'n/a';
  return (
    `change \`${change.id}\` (${change.change_kind}, +${change.lines_added}/−${change.lines_removed}). ` +
    `Files: ${files}. Rationale: ${change.rationale_md.slice(0, 500)}`
  );
}

function redFraming(change: ChangeRecord, seat: SwarmSeatSpec): string {
  return (
    `You are the RED TEAM (seat ${seat.seat_id}) reviewing Beatrice's code ${changeContext(change)}\n\n` +
    `Read the full change with read_change_for_critique('${change.id}'), then verify its claims against ` +
    `the REAL repo (grep_codebase / read_codebase_file). Your job is to BREAK it: find the input, edge ` +
    `case, security hole, regression, or scope-creep that makes this diff wrong. Report each finding as ` +
    `blocker / concern / nit with a file+line anchor and quoted evidence. If after a genuine look you ` +
    `find nothing, say so plainly — do not invent nits.`
  );
}

function blueFraming(
  change: ChangeRecord,
  redResults: Array<{ seat: SwarmSeatSpec; digest: string }>,
): string {
  const red = redResults.map((r) => `- (${r.seat.seat_id}) ${snippet(r.digest)}`).join('\n') || '- (none)';
  return (
    `You are the BLUE TEAM reviewing Beatrice's code ${changeContext(change)}\n\n` +
    `Read it with read_change_for_critique('${change.id}'). The RED team reported:\n${red}\n\n` +
    `For each red finding, either REFUTE it with concrete evidence from the real repo, or CONFIRM it and ` +
    `propose the minimal fix. Then add any real concern the red team missed. Be specific with file+line.`
  );
}

function judgeFraming(
  change: ChangeRecord,
  redResults: Array<{ seat: SwarmSeatSpec; digest: string }>,
  blueDigest: string,
): string {
  const red = redResults.map((r) => `- (${r.seat.seat_id}) ${snippet(r.digest)}`).join('\n') || '- (none)';
  return (
    `You are the JUDGE for Beatrice's code ${changeContext(change)}\n\n` +
    `RED findings:\n${red}\n\nBLUE response:\n${snippet(blueDigest) || '- (none)'}\n\n` +
    `Weigh them. On the FIRST line output your verdict as EXACTLY one of: PASS, PASS_WITH_CONCERNS, BLOCK. ` +
    `Then 2–3 sentences of rationale. BLOCK only if a real, un-refuted blocker survives; PASS_WITH_CONCERNS ` +
    `if only non-blocking concerns remain; PASS if it is clean.`
  );
}

// ── parsing / helpers ─────────────────────────────────────────────────────────

function snippet(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > 280 ? `${t.slice(0, 277)}…` : t;
}

function deriveTitle(change: ChangeRecord): string {
  const firstLine = change.rationale_md.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  const base = (firstLine ?? `Code change ${change.id}`).replace(/^#+\s*/, '');
  return base.length > 80 ? `${base.slice(0, 79)}…` : base;
}

/** Crude severity extraction from a seat's prose digest. No keyword ⇒ no
 *  finding row (clean review), so the ledger stays signal, not noise. */
function extractFinding(digest: string): { severity: SwarmSeverity; summary: string } | null {
  const low = digest.toLowerCase();
  let severity: SwarmSeverity | null = null;
  if (/\bblocker\b/.test(low)) severity = 'blocker';
  else if (/\bconcern\b/.test(low)) severity = 'concern';
  if (!severity) return null;
  return { severity, summary: snippet(digest) };
}

function parseVerdict(digest: string): SwarmVerdict | null {
  const u = digest.toUpperCase();
  if (u.includes('PASS_WITH_CONCERNS') || u.includes('PASS WITH CONCERNS')) return 'pass_with_concerns';
  if (/\bBLOCK(ED)?\b/.test(u)) return 'block';
  if (/\bPASS\b/.test(u)) return 'pass';
  return null;
}

function deriveVerdict(
  findings: Array<{ severity: SwarmSeverity; refuted: boolean }>,
): SwarmVerdict {
  if (findings.some((f) => f.severity === 'blocker' && !f.refuted)) return 'block';
  if (findings.some((f) => f.severity === 'concern' && !f.refuted)) return 'pass_with_concerns';
  return 'pass';
}

/**
 * Wake Kate with the verdict. This is a `flag`, not an `fyi`, on purpose: the
 * first live run (2026-07-21) had Kate rule 97s BEFORE the bench returned, so a
 * silent courtesy note informed nobody. Paired with the `review_change`
 * interlock (which refuses a ruling while a swarm is still sitting), this is
 * what makes "inform-only" actually inform.
 */
function informKate(
  deps: SwarmDeps,
  change_id: string,
  title: string,
  verdict: SwarmVerdict,
  finding_count: number,
  ruling: 'upheld' | 'overturned' | null,
): void {
  const verdict_line =
    verdict === 'block'
      ? '⛔ BLOCKED — a blocker survived'
      : verdict === 'pass_with_concerns'
        ? '⚠️ passed with concerns'
        : '✅ passed clean';
  const appeal_line =
    ruling === 'upheld'
      ? '\n\n**Higher court: UPHELD.** The block was appealed to a deeper, three-lens bench and it stood.'
      : ruling === 'overturned'
        ? '\n\n**Higher court: OVERTURNED.** A deeper three-lens bench found the blocker did not hold; treat it as a concern, not a stop.'
        : '';
  try {
    deps.inbox.push({
      from_specialist_id: 'critic',
      to_specialist_id: 'kate',
      kind: 'flag',
      body_md:
        `**Review swarm** ruled on \`${change_id}\` — ${verdict_line} (${finding_count} finding` +
        `${finding_count === 1 ? '' : 's'}).\n\n_${title}_${appeal_line}\n\n` +
        `Read the findings before you rule. Advisory — you still decide via \`review_change\`, and the ` +
        `owner still merges. A blocker you cannot dismiss with evidence is a deny.`,
    });
  } catch {
    /* a push failure must not fail the run */
  }
}

function emit(deps: SwarmDeps, e: AppEvent): void {
  try {
    deps.events.emit(e);
  } catch {
    /* observability, never control flow */
  }
}
