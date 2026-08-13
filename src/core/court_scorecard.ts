/**
 * Court scorecard — instrument Proposal-Court–vs–owner agreement
 * (2026-07-02, trust-teeth Phase 1: the evidence gate).
 *
 * ARMING GATE (the documented target): flipping HEARTH_TRUST_TEETH on is a
 * HUMAN decision informed by ≥ 1 week of scorecard data — the bar is
 * `overall.rate ≥ 0.90` (HEARTH_COURT_TARGET_AGREEMENT) with at least
 * MIN_COMPARISONS (10) scored comparisons. `meets_target` reports exactly
 * that; null means "not enough data yet — keep collecting", never "close
 * enough". The scorecard itself carries no flag — it is a read surface,
 * armed from day one.
 *
 * What counts as a comparison (per lens vote, strongest signal first —
 * each court case contributes through at most ONE rung):
 *
 *   1. DIRECT — the owner later decided the case's own proposal (a split
 *      the court left pending, or a trust-teeth arm the owner canceled):
 *      his verdict vs each seat's non-abstain vote. The purest signal.
 *   2. REVERSAL — the court decided the case, and the owner later decided
 *      a SAME-SIGNATURE proposal the OPPOSITE way (court rejected/lapsed
 *      it, he approved the re-file; court approved, he denied the next
 *      one). Revealed disagreement for every voting seat.
 *   3. DIGEST REACTION — the convening's digest card: 'Got it' endorses
 *      that day's court-decided cases (agreement); 'Discuss' challenges
 *      them (disagreement — the owner wanted to talk, which is the only
 *      per-day signal a briefing card gives). Untouched digests leave the
 *      cases UNCHALLENGED — excluded from the rate, counted separately
 *      (silence is not consent).
 *
 * The BACKTEST is a separate rate, deliberately not blended into
 * `overall`: for each case where the court took a position, compare it to
 * the owner's HISTORICAL majority verdict on the same category signature
 * (his real decides, court decisions excluded). Weaker epistemics — a
 * proxy, not a response — but available from day one.
 *
 * Pure compute (`compute_scorecard`) + a db gather (`gather_court_scorecard`)
 * reading the `proposal_court_verdict` audit rows and the proposals table.
 * No new writes — the scorecard is entirely derived.
 */

import type { Database } from 'bun:sqlite';
import { TEETH_KINDS } from './trust_teeth';

export const SCORECARD_MIN_COMPARISONS = 10;

export function target_agreement_rate(): number {
  const n = Number(process.env.HEARTH_COURT_TARGET_AGREEMENT ?? 0.9);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.9;
}

/**
 * Comparisons a SINGLE kind needs before its own rate is judged. Lower than
 * SCORECARD_MIN_COMPARISONS by design, and the tradeoff is deliberate: a
 * kind is a far narrower and more homogeneous class than the blended
 * aggregate, so a given N buys more confidence about it — while requiring
 * the full aggregate N per kind would make the per-kind gate strictly harder
 * to reach than the one it exists to unblock.
 */
export const SCORECARD_MIN_KIND_COMPARISONS = 5;

export function min_kind_comparisons(): number {
  const n = Number(process.env.HEARTH_COURT_MIN_KIND_COMPARISONS ?? SCORECARD_MIN_KIND_COMPARISONS);
  return Number.isFinite(n) && n >= 3 ? n : SCORECARD_MIN_KIND_COMPARISONS;
}

export type CourtPositionVote = 'approve' | 'reject' | 'lapse' | 'abstain';

export interface CourtVerdictEvent {
  proposal_id: string;
  kind: string;
  /** Audit-row timestamp (the convening instant). */
  ts: string;
  outcome: string; // approved | rejected | lapsed | split | owner_class | skipped | auto_armed
  votes: Array<{ seat: string; vote: CourtPositionVote }>;
}

export interface ProposalFact {
  proposal_id: string;
  status: string;
  ts_decided: string | null;
  /** The decide was the court's own (consensus or trust-teeth auto-exec),
   *  not the owner's — detected from the decide feedback marker. */
  decided_by_court: boolean;
}

export interface OwnerDecision {
  proposal_id: string;
  signature_hash: string | null;
  verdict: 'approve' | 'deny';
  ts_decided: string;
}

export type DigestReaction = 'endorsed' | 'challenged';

export interface ScorecardInput {
  events: CourtVerdictEvent[];
  /** proposal_id → current fact for every event's proposal. */
  facts: Map<string, ProposalFact>;
  /** Event proposal_id → its signature hash (from the proposals table). */
  signatures: Map<string, string | null>;
  /** EVERY owner-made decision on the relevant signatures (reversal probe). */
  owner_decisions: OwnerDecision[];
  /** UTC-date (ISO prefix) of a convening → the owner's digest reaction. */
  digest_reactions: Map<string, DigestReaction>;
  window_days: number;
  since: string;
  target_rate?: number;
  min_comparisons?: number;
  min_kind_comparisons?: number;
}

export interface LensAgreement {
  seat: string;
  comparisons: number;
  agreed: number;
  rate: number | null;
}

/** Agreement scoped to ONE proposal kind — the arming unit (`armable_kinds`). */
export interface KindAgreement {
  kind: string;
  comparisons: number;
  agreed: number;
  rate: number | null;
  /** Same three-way semantics as `meets_target`: null = not enough data. */
  meets_target: boolean | null;
}

export interface CourtScorecard {
  window_days: number;
  since: string;
  cases_total: number;
  split_resolved: number;
  split_pending: number;
  decided_by_court: number;
  decided_reversed: number;
  decided_endorsed: number;
  decided_challenged: number;
  decided_unchallenged: number;
  armed: number;
  overall: { comparisons: number; agreed: number; rate: number | null };
  per_lens: LensAgreement[];
  /** Agreement broken out by proposal kind, best-evidenced first. */
  per_kind: KindAgreement[];
  /** The kinds that have EARNED arming on their own record — teeth-eligible
   *  kinds at/above target with enough comparisons of their own. This is the
   *  ratchet: the owner arms what has proven out instead of waiting for one
   *  blended number to clear, which it may never do. */
  armable_kinds: string[];
  backtest: { cases: number; agreed: number; rate: number | null };
  target_rate: number;
  min_comparisons: number;
  min_kind_comparisons: number;
  /** true/false once `overall.comparisons ≥ min_comparisons`; null = not
   *  enough data to judge (never "close enough"). */
  meets_target: boolean | null;
  gate_note: string;
}

/** Map a lens vote to the deny/approve axis an owner verdict lives on.
 *  A `lapse` vote is a decline-direction position (don't do it — the moment
 *  passed); `abstain` never compares. */
function vote_direction(vote: CourtPositionVote): 'approve' | 'deny' | null {
  if (vote === 'approve') return 'approve';
  if (vote === 'reject' || vote === 'lapse') return 'deny';
  return null;
}

/** The court's case-level position, when it took one. */
function court_position(outcome: string): 'approve' | 'deny' | null {
  if (outcome === 'approved' || outcome === 'auto_armed') return 'approve';
  if (outcome === 'rejected') return 'deny';
  // `lapsed` is a timeliness call, not a merits verdict — it takes the deny
  // direction ONLY for reversal detection (an owner approving the re-file
  // says the court expired something he wanted); it is excluded from the
  // merits backtest.
  return null;
}

/** The owner's verdict revealed by a proposal's terminal status, when the
 *  decide was HIS (not the court's). */
export function owner_verdict_from_status(status: string): 'approve' | 'deny' | null {
  if (status === 'denied') return 'deny';
  if (
    status === 'approved' ||
    status === 'acknowledged' ||
    status === 'executed' ||
    status === 'failed'
  ) {
    return 'approve';
  }
  return null; // pending / snoozed / expired / superseded — no verdict
}

export function compute_scorecard(input: ScorecardInput): CourtScorecard {
  const target = input.target_rate ?? target_agreement_rate();
  const min_n = input.min_comparisons ?? SCORECARD_MIN_COMPARISONS;

  const per_lens = new Map<string, { comparisons: number; agreed: number }>();
  const per_kind = new Map<string, { comparisons: number; agreed: number }>();
  const overall = { comparisons: 0, agreed: 0 };
  const backtest = { cases: 0, agreed: 0 };

  let split_resolved = 0;
  let split_pending = 0;
  let decided_by_court = 0;
  let decided_reversed = 0;
  let decided_endorsed = 0;
  let decided_challenged = 0;
  let decided_unchallenged = 0;
  let armed = 0;

  // The owner's historical majority per signature — from his REAL decides
  // only (the gather already excluded court-made ones). Feeds the backtest.
  const history = new Map<string, { approvals: number; denials: number }>();
  for (const d of input.owner_decisions) {
    if (!d.signature_hash) continue;
    let h = history.get(d.signature_hash);
    if (!h) {
      h = { approvals: 0, denials: 0 };
      history.set(d.signature_hash, h);
    }
    if (d.verdict === 'approve') h.approvals++;
    else h.denials++;
  }

  const score_lenses = (event: CourtVerdictEvent, owner: 'approve' | 'deny'): void => {
    for (const v of event.votes) {
      const dir = vote_direction(v.vote);
      if (!dir) continue;
      let l = per_lens.get(v.seat);
      if (!l) {
        l = { comparisons: 0, agreed: 0 };
        per_lens.set(v.seat, l);
      }
      let k = per_kind.get(event.kind);
      if (!k) {
        k = { comparisons: 0, agreed: 0 };
        per_kind.set(event.kind, k);
      }
      l.comparisons++;
      k.comparisons++;
      overall.comparisons++;
      if (dir === owner) {
        l.agreed++;
        k.agreed++;
        overall.agreed++;
      }
    }
  };

  for (const event of input.events) {
    const fact = input.facts.get(event.proposal_id);
    const sig = input.signatures.get(event.proposal_id) ?? null;
    const position = court_position(event.outcome);
    const court_decided =
      event.outcome === 'approved' || event.outcome === 'rejected' || event.outcome === 'lapsed';

    if (event.outcome === 'auto_armed') armed++;

    // Rung 1 — DIRECT: the owner himself decided this very proposal after
    // the convening (a split he cleared, or an arm he canceled/beat).
    if (event.outcome === 'split' || event.outcome === 'auto_armed') {
      const owner =
        fact && !fact.decided_by_court && fact.ts_decided && fact.ts_decided >= event.ts
          ? owner_verdict_from_status(fact.status)
          : null;
      if (event.outcome === 'split') {
        if (owner) split_resolved++;
        else split_pending++;
      }
      if (owner) {
        score_lenses(event, owner);
        continue;
      }
      // An arm the court itself executed contributes nothing further here —
      // reversal detection below still applies to its signature.
    }

    if (!court_decided && event.outcome !== 'auto_armed') continue;
    if (court_decided) decided_by_court++;

    // Rung 2 — REVERSAL: the owner later decided a same-signature proposal
    // the opposite way. `lapsed` compares in the deny direction here (he
    // approved a re-file the court had expired).
    const reversal_position = position ?? (event.outcome === 'lapsed' ? 'deny' : null);
    let reversed = false;
    if (reversal_position && sig) {
      reversed = input.owner_decisions.some(
        (d) =>
          d.signature_hash === sig &&
          d.proposal_id !== event.proposal_id &&
          d.ts_decided > event.ts &&
          d.verdict !== reversal_position,
      );
    }
    if (reversed) {
      if (court_decided) decided_reversed++;
      score_lenses(event, reversal_position === 'approve' ? 'deny' : 'approve');
      continue;
    }

    // Rung 3 — DIGEST REACTION on the convening's date (court-decided
    // cases only; an armed-and-executed case has no digest button of its
    // own beyond the arm line).
    if (court_decided) {
      const reaction = input.digest_reactions.get(event.ts.slice(0, 10));
      const dir = reversal_position ?? 'approve';
      if (reaction === 'endorsed') {
        decided_endorsed++;
        score_lenses(event, dir);
      } else if (reaction === 'challenged') {
        decided_challenged++;
        score_lenses(event, dir === 'approve' ? 'deny' : 'approve');
      } else {
        decided_unchallenged++;
      }
    }
  }

  // BACKTEST (separate rate, its own pass so every court-position case
  // scores regardless of which comparison rung it landed on): the court's
  // merits position vs the owner's historical majority on the signature.
  // Lapses excluded (timeliness, not merits); ties/no-history skipped.
  for (const event of input.events) {
    const position = court_position(event.outcome);
    const sig = input.signatures.get(event.proposal_id) ?? null;
    if (!position || !sig) continue;
    const h = history.get(sig);
    if (!h || h.approvals === h.denials) continue;
    backtest.cases++;
    if ((h.approvals > h.denials ? 'approve' : 'deny') === position) backtest.agreed++;
  }

  const rate = (n: { comparisons: number; agreed: number }): number | null =>
    n.comparisons > 0 ? n.agreed / n.comparisons : null;

  const overall_rate = rate(overall);
  const meets_target =
    overall.comparisons >= min_n && overall_rate !== null ? overall_rate >= target : null;

  const min_kind_n = input.min_kind_comparisons ?? min_kind_comparisons();
  const kinds: KindAgreement[] = [...per_kind.entries()]
    .map(([kind, k]) => {
      const r = rate(k);
      return {
        kind,
        ...k,
        rate: r,
        meets_target: k.comparisons >= min_kind_n && r !== null ? r >= target : null,
      };
    })
    .sort((a, b) => b.comparisons - a.comparisons || a.kind.localeCompare(b.kind));
  // Only kinds teeth can actually execute are ARMABLE. A `briefing` kind
  // scoring 100% is not an autonomy result — nothing would ever auto-run.
  const armable_kinds = kinds
    .filter((k) => k.meets_target === true && TEETH_KINDS.has(k.kind))
    .map((k) => k.kind);

  return {
    window_days: input.window_days,
    since: input.since,
    cases_total: input.events.length,
    split_resolved,
    split_pending,
    decided_by_court,
    decided_reversed,
    decided_endorsed,
    decided_challenged,
    decided_unchallenged,
    armed,
    overall: { ...overall, rate: overall_rate },
    per_lens: [...per_lens.entries()]
      .map(([seat, l]) => ({ seat, ...l, rate: rate(l) }))
      .sort((a, b) => a.seat.localeCompare(b.seat)),
    per_kind: kinds,
    armable_kinds,
    backtest: {
      cases: backtest.cases,
      agreed: backtest.agreed,
      rate: backtest.cases > 0 ? backtest.agreed / backtest.cases : null,
    },
    target_rate: target,
    min_comparisons: min_n,
    min_kind_comparisons: min_kind_n,
    meets_target,
    gate_note:
      `HEARTH_TRUST_TEETH arming is a human decision informed by ≥1 week of scorecard data: ` +
      `overall agreement ≥ ${Math.round(target * 100)}% with ≥ ${min_n} scored comparisons. ` +
      (meets_target === null
        ? `Not enough comparisons yet (${overall.comparisons}/${min_n}) — keep collecting.`
        : meets_target
          ? `Currently MET (${overall.agreed}/${overall.comparisons}).`
          : `Currently NOT met (${overall.agreed}/${overall.comparisons}).`) +
      ` Per-kind arming (HEARTH_TRUST_TEETH_KINDS) needs only that kind's own ` +
      `record — ≥ ${Math.round(target * 100)}% over ≥ ${min_kind_n} comparisons — so ` +
      `trust can be granted where it is earned instead of waiting on one blended ` +
      `number. ` +
      (armable_kinds.length > 0
        ? `Earned now: ${armable_kinds.join(', ')}.`
        : `No kind has earned it yet.`),
  };
}

// ── gather (db reads; no writes) ───────────────────────────────────────────

const COURT_FEEDBACK_MARKERS = ['proposal court%', 'trust teeth%'] as const;

function parse_votes(raw: unknown): CourtVerdictEvent['votes'] {
  if (!Array.isArray(raw)) return [];
  const out: CourtVerdictEvent['votes'] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const seat = entry.slice(0, eq);
    const vote = entry.slice(eq + 1) as CourtPositionVote;
    if (vote === 'approve' || vote === 'reject' || vote === 'lapse' || vote === 'abstain') {
      out.push({ seat, vote });
    }
  }
  return out;
}

export function gather_court_scorecard(
  db: Database,
  opts?: { window_days?: number; now?: Date },
): CourtScorecard {
  const requested = opts?.window_days;
  const window_days =
    typeof requested === 'number' && Number.isFinite(requested)
      ? Math.min(90, Math.max(1, Math.floor(requested)))
      : 30;
  const now = opts?.now ?? new Date();
  const since = new Date(now.getTime() - window_days * 86_400_000).toISOString();

  // 1. The court's verdict trail.
  const audit_rows = db
    .prepare(
      `SELECT ts, tool_input, execution_result FROM audit_log
       WHERE tool_name = 'proposal_court_verdict' AND ts >= @since
       ORDER BY ts ASC`,
    )
    .all({ '@since': since }) as Array<{
    ts: string;
    tool_input: string;
    execution_result: string | null;
  }>;
  const events: CourtVerdictEvent[] = [];
  for (const row of audit_rows) {
    try {
      const input = JSON.parse(row.tool_input) as { proposal_id?: string; kind?: string };
      const result = JSON.parse(row.execution_result ?? '{}') as {
        outcome?: string;
        votes?: unknown;
      };
      if (!input.proposal_id || !result.outcome) continue;
      events.push({
        proposal_id: input.proposal_id,
        kind: input.kind ?? 'unknown',
        ts: row.ts,
        outcome: result.outcome,
        votes: parse_votes(result.votes),
      });
    } catch {
      /* a malformed row never breaks the scorecard */
    }
  }

  // 2. Current facts + signatures for the events' proposals.
  const facts = new Map<string, ProposalFact>();
  const signatures = new Map<string, string | null>();
  const ids = [...new Set(events.map((e) => e.proposal_id))];
  const court_clause = COURT_FEEDBACK_MARKERS.map(() => `user_feedback LIKE ?`).join(' OR ');
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = db
      .prepare(
        `SELECT id, status, ts_decided, user_feedback, category_signature_hash
         FROM proposals WHERE id IN (${chunk.map(() => '?').join(', ')})`,
      )
      .all(...chunk) as Array<{
      id: string;
      status: string;
      ts_decided: string | null;
      user_feedback: string | null;
      category_signature_hash: string | null;
    }>;
    for (const r of rows) {
      const fb = (r.user_feedback ?? '').toLowerCase();
      facts.set(r.id, {
        proposal_id: r.id,
        status: r.status,
        ts_decided: r.ts_decided,
        decided_by_court: fb.startsWith('proposal court') || fb.startsWith('trust teeth'),
      });
      signatures.set(r.id, r.category_signature_hash);
    }
  }

  // 3. The owner's OWN decisions on the relevant signatures — all time, so
  //    the backtest has real history (court/teeth decides excluded).
  const sig_hashes = [...new Set([...signatures.values()].filter((s): s is string => s !== null))];
  const owner_decisions: OwnerDecision[] = [];
  for (let i = 0; i < sig_hashes.length; i += 400) {
    const chunk = sig_hashes.slice(i, i + 400);
    const rows = db
      .prepare(
        `SELECT id, category_signature_hash, status, ts_decided, user_feedback
         FROM proposals
         WHERE category_signature_hash IN (${chunk.map(() => '?').join(', ')})
           AND ts_decided IS NOT NULL
           AND status IN ('approved', 'acknowledged', 'executed', 'failed', 'denied')
           AND (user_feedback IS NULL OR NOT (${court_clause}))`,
      )
      .all(...chunk, ...COURT_FEEDBACK_MARKERS) as Array<{
      id: string;
      category_signature_hash: string | null;
      status: string;
      ts_decided: string;
      user_feedback: string | null;
    }>;
    for (const r of rows) {
      const verdict = owner_verdict_from_status(r.status);
      if (!verdict) continue;
      owner_decisions.push({
        proposal_id: r.id,
        signature_hash: r.category_signature_hash,
        verdict,
        ts_decided: r.ts_decided,
      });
    }
  }

  // 4. Digest reactions by convening date. 'discuss' outranks 'got_it' when
  //    the same day somehow carries both (a challenge is the louder signal).
  const digest_reactions = new Map<string, DigestReaction>();
  const digest_rows = db
    .prepare(
      `SELECT ts_created, action_taken FROM proposals
       WHERE kind = 'briefing' AND specialist_id = 'kate'
         AND payload_json LIKE '%"topic":"Proposal Court%'
         AND ts_created >= @since`,
    )
    .all({ '@since': since }) as Array<{ ts_created: string; action_taken: string | null }>;
  for (const r of digest_rows) {
    const day = r.ts_created.slice(0, 10);
    if (r.action_taken === 'discuss') {
      digest_reactions.set(day, 'challenged');
    } else if (r.action_taken === 'got_it' && digest_reactions.get(day) !== 'challenged') {
      digest_reactions.set(day, 'endorsed');
    }
  }

  return compute_scorecard({
    events,
    facts,
    signatures,
    owner_decisions,
    digest_reactions,
    window_days,
    since,
  });
}
