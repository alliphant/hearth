/**
 * escalate-on-evidence — the successor to the complexity gate (2026-08-05).
 *
 * THE PROBLEM IT REPLACES. `complexity.ts` decided whether a turn deserved the
 * deep tier by pattern-matching the USER'S MESSAGE before the turn started —
 * the weakest available evidence, applied at the point of least information.
 * Replaying 14 days of `complexity_route` rows showed 130 of 184 escalations
 * (71%) firing on question-count and character-count alone, and Kate's were
 * ledger reads sent to a think-ON 122B. The 2026-08-05 fix (b64ca080) required
 * a reasoning signal and suppressed lookups, which is a better predictor — but
 * it is still a PREDICTION, made before anything is known.
 *
 * THE INVERSION. Run the fast tier first. Escalate only when the turn
 * DEMONSTRATES it needed more. The fast tier's own output is far stronger
 * evidence than any regex over the question, and the cost is one extra leg on
 * the rare hard turn instead of a 122B turn on every turn that merely LOOKS
 * hard.
 *
 * WHAT COUNTS AS A DEMONSTRATION. Not "a guard fired" — guards fire constantly
 * and the re-roll usually fixes it, which is the system working. The evidence
 * is narrower and much stronger: A FINDING THAT SURVIVED ITS OWN CORRECTION.
 * The fast tier was handed the specific claim it could not support, told
 * exactly what was wrong with it, given a fresh round with every tool result
 * still in context — and produced the same unsupported claim again. That is
 * the fast tier reporting, in its own output, that it is out of road.
 *
 * Two triggers, both DETERMINISTIC and both free (no extra judge call — the
 * claims were already extracted by the guard that fired the first time):
 *
 *   unresolved_grounding  — a claim flagged by fact_critic/provenance/citation
 *                           is still in the re-rolled reply and still absent
 *                           from the turn's grounding.
 *   unresolved_synthesis  — the synthesis nudge fired and the redo is STILL
 *                           blank or meta-only, with tool results in hand.
 *
 * ── WHAT IS DELIBERATELY *NOT* A SIGNAL ────────────────────────────────────
 * The question that decides whether this module helps or hurts is "did this
 * turn need a BIGGER MODEL, or a DIFFERENT TOOL?" Escalating the second class
 * spends the scarcest resource in the fleet on a problem more thinking cannot
 * touch. Each exclusion below is a class that LOOKS like failure and is not
 * evidence of insufficient reasoning:
 *
 *   same_tool_spiral_exhaust  The model can't fill the args or can't stop
 *                             calling. A 122B fills the same bad args. The fix
 *                             shipped 2026-07-29: retire the tool, keep the turn.
 *   data_denial               A false "I don't have that" is a REACH failure —
 *                             the nudge names the read tool that would settle
 *                             it, and calling it is the whole fix.
 *   ghost_promise /           All four are "claimed it without calling the
 *   fabricated_save /         tool". Forced `tool_choice` already fixes them and
 *   fabricated_action /       is orders of magnitude cheaper. A bigger model
 *   intent_miss               told to acknowledge instead of act does the same.
 *   read_failure              Infrastructure. Thinking harder about a 404 is
 *                             not a strategy.
 *   shell_safety              SAFETY. A destructive command handed to the owner
 *                             must be rewritten NOW, on the fast path. Never
 *                             trade a safety correction for a slower one.
 *   folded_name, fabricated_  Tool-channel mechanics: a minted filename or a
 *   image, unplaced_image,    registered tool name compared against the turn's
 *   narrated_tool_call        actual calls. Nothing to reason about.
 *
 * ── HOW IT ESCALATES ───────────────────────────────────────────────────────
 * By forcing ONE `consult_deep_model` call into the existing turn — not by
 * re-running the turn on `deep_consult`. The tool results are the expensive
 * part and are already paid for; a re-run re-pays every one, pushes a ~26-28K
 * prompt through a think-ON endpoint with a 300s timeout (the shape behind
 * three 400s in the week before its window went 16384 → 65536), and has no
 * fallback when it times out. Forcing the tool keeps the fast tier's grounding
 * AND its voice — the 122B supplies reasoning, the specialist still writes the
 * reply — and degrades to "the fast answer ships" on any failure.
 *
 * ── BUDGETS, AND WHY THEY ARE HARD ─────────────────────────────────────────
 * The user has ALREADY waited for the fast turn. Everything here is optional
 * improvement to an answer that already exists, so every budget fails toward
 * shipping that answer:
 *
 *   HEARTH_ESCALATE_BUDGET_MS    (45000) ceiling on the deep leg — NOT the
 *                                role's 300s. Enforced with a real AbortSignal.
 *   HEARTH_ESCALATE_MAX_TURN_MS  (90000) don't START an escalation on a turn
 *                                that already burned this long.
 *   HEARTH_ESCALATE_MAX_INFLIGHT (1)     see the admission gate below.
 *
 * ── ADMISSION, AND THE THIRD ESCALATION ────────────────────────────────────
 * `deep_consult` is `max_concurrency: 2` and `SerializedProvider` queues FIFO
 * with NO BOUND — so a third escalation would park behind two calls that may
 * each run 300s, and the user would wait minutes for an improvement they never
 * asked for. The gate below is therefore a NON-BLOCKING try-acquire: if there
 * is no slot, there is no escalation, the fast answer ships, and the audit row
 * says `deep_tier_busy`. Default 1 rather than 2 because those two slots also
 * serve voluntary `consult_deep_model` calls, `court_judge_deep` and
 * `critic_review` (all the same base_url) — escalation is the lowest-priority
 * consumer of that endpoint and must never be the reason a voluntary consult
 * queues. Under load the whole feature degrades to exactly today's behavior,
 * which is the property worth having.
 *
 * ── ROLLOUT ────────────────────────────────────────────────────────────────
 * HEARTH_ESCALATE_ON_EVIDENCE: unset/`shadow` = decide and audit every turn,
 * never escalate; `1` = armed; `0` = off entirely. Shipping in shadow means the
 * corpus starts accumulating the day it merges, so arming is a one-line env
 * change made with a real escalation rate in hand — the same replay-from-data
 * path that made the 2026-08-05 complexity fix possible.
 *
 * Voice needs no exclusion here: `content_reroll_budget('voice')` is 0, so a
 * voice turn never re-rolls, never carries a finding forward, and therefore can
 * never reach a trigger.
 */

import { normalize_text, squash, type GroundingContext } from './provenance';

/** Off / audit-only / armed. See the rollout note above. */
export type EscalationMode = 'off' | 'shadow' | 'armed';

export function escalation_mode(): EscalationMode {
  const raw = (process.env.HEARTH_ESCALATE_ON_EVIDENCE ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'off') return 'off';
  if (raw === '1' || raw === 'on' || raw === 'armed') return 'armed';
  // Unset, 'shadow', or anything unrecognised → shadow. An unreadable value
  // must never silently ARM a feature that spends the scarcest tier.
  return 'shadow';
}

function env_ms(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return fallback;
}

/** Ceiling on the deep leg itself. Read at call time so smokes can toggle. */
export function escalation_budget_ms(): number {
  return env_ms('HEARTH_ESCALATE_BUDGET_MS', 45_000);
}

/** A turn already this old never starts an escalation. */
export function escalation_max_turn_ms(): number {
  return env_ms('HEARTH_ESCALATE_MAX_TURN_MS', 90_000);
}

/** Concurrent escalations allowed across the process. See the admission note. */
export function escalation_max_inflight(): number {
  return Math.max(1, env_ms('HEARTH_ESCALATE_MAX_INFLIGHT', 1));
}

/** The tool an escalation forces. Named once so the runtime and the smoke agree. */
export const ESCALATION_TOOL = 'consult_deep_model';

/**
 * A claim a finalize guard flagged, carried across the re-roll so the redo can
 * be checked against it. `claim` is the exact substring the guard reported —
 * `Claim.text` from provenance, or `FactFinding.claim` from the critic.
 */
export interface CarriedFinding {
  claim: string;
  kind: string;
  from: 'fact_critic' | 'provenance' | 'citation';
}

export type EscalationTrigger = 'unresolved_grounding' | 'unresolved_synthesis';

export type EscalationDecline =
  | 'no_evidence'
  | 'shadow_only'
  | 'over_turn_budget'
  | 'deep_tier_busy'
  | 'tool_unavailable'
  | 'already_escalated';

/** What the fast tier demonstrated. Pure detection — no policy, no side effects. */
export interface EscalationEvidence {
  trigger: EscalationTrigger;
  /** The specific claims that survived correction (capped for the audit row). */
  unresolved: string[];
  /** Which guard originally flagged them. Null for the synthesis trigger. */
  carried_from: CarriedFinding['from'] | null;
}

/**
 * Is `claim` still asserted in `reply` AND still absent from the turn's
 * grounding?
 *
 * Mirrors `is_grounded()` in provenance.ts exactly rather than inventing a
 * second notion of "present": identifier-ish tokens compare squashed (case and
 * punctuation carry no meaning in an id), everything else compares as a
 * normalized substring. Sharing the definition is what makes "the correction
 * did not take" mean the same thing here as it did in the guard that fired.
 */
export function claim_persists(
  claim: string,
  reply: string,
  grounding: GroundingContext,
): boolean {
  const raw = (claim ?? '').trim();
  if (!raw) return false;
  // An identifier-shaped token (letters+digits, no spaces) is matched squashed;
  // anything shorter than 4 chars is too weak to judge, exactly as provenance
  // declines to strip a 3-char id.
  const identifier_ish = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(raw) && /\d/.test(raw);
  if (identifier_ish) {
    const needle = squash(raw);
    if (needle.length < 4) return false;
    return squash(reply).includes(needle) && !grounding.squashed.includes(needle);
  }
  const needle = normalize_text(raw).replace(/^["'“”‘’\s]+|["'“”‘’\s.,;:!?]+$/g, '');
  if (needle.length < 3) return false;
  return normalize_text(reply).includes(needle) && !grounding.text.includes(needle);
}

/**
 * Did this turn demonstrate it needed more model? Pure.
 *
 * `carried` is empty on a turn whose guards never fired, which is the common
 * path — so the common path costs one array-length check.
 */
export function detect_escalation_evidence(args: {
  /** The RE-ROLLED reply — the one produced after the correction. */
  reply: string;
  /** Findings the first pass flagged, carried across the re-roll. */
  carried: readonly CarriedFinding[];
  /** Grounding recomputed on the redo (it may have gathered more). */
  grounding: GroundingContext;
  /** True when the synthesis nudge already fired this turn. */
  synthesis_nudged: boolean;
  /** True when the redo is still empty or still only states intent. */
  reply_blank_or_meta: boolean;
  /** Tool results are in hand — distinguishes "can't synthesize" from "has nothing". */
  had_tool_calls: boolean;
}): EscalationEvidence | null {
  const { reply, carried, grounding, synthesis_nudged, reply_blank_or_meta, had_tool_calls } =
    args;

  // Grounding first: a surviving unsupported claim is the sharper signal, and
  // a reply carrying one is not blank, so the two triggers can't both apply.
  if (carried.length > 0) {
    const survivors = carried.filter((c) => claim_persists(c.claim, reply, grounding));
    if (survivors.length > 0) {
      return {
        trigger: 'unresolved_grounding',
        unresolved: survivors.map((s) => s.claim.slice(0, 160)).slice(0, 8),
        carried_from: survivors[0]!.from,
      };
    }
  }

  // The fast tier had its results, was told the user is still waiting on the
  // substance, and came back with nothing (or with intent) a second time.
  if (synthesis_nudged && reply_blank_or_meta && had_tool_calls) {
    return {
      trigger: 'unresolved_synthesis',
      unresolved: [reply.trim().slice(0, 160) || '(empty reply)'],
      carried_from: null,
    };
  }

  return null;
}

/**
 * Non-blocking admission gate for the deep tier.
 *
 * Leases carry an expiry and are swept lazily on the next `admit()`, so a
 * caller that never releases (an uncaught throw between the decision and the
 * finalize path) cannot permanently wedge the gate. The expiry is generous —
 * twice the leg budget — because it is a LEAK BACKSTOP, not the latency bound;
 * the AbortSignal on the call itself is what actually bounds the wait.
 */
export class EscalationGate {
  /** Monotonic expiry timestamps of live leases. */
  private leases: number[] = [];

  private sweep(now: number): void {
    if (this.leases.length > 0) this.leases = this.leases.filter((exp) => exp > now);
  }

  /** Leases currently held (after a sweep). Diagnostics + audit rows. */
  inflight(now = Date.now()): number {
    this.sweep(now);
    return this.leases.length;
  }

  /**
   * Take a slot if one is free. Returns a release fn, or null when the deep
   * tier is saturated — NEVER queues. The caller must release; failing to is
   * covered by the expiry sweep.
   */
  admit(now = Date.now()): (() => void) | null {
    this.sweep(now);
    if (this.leases.length >= escalation_max_inflight()) return null;
    const expiry = now + escalation_budget_ms() * 2;
    this.leases.push(expiry);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const i = this.leases.indexOf(expiry);
      if (i !== -1) this.leases.splice(i, 1);
    };
  }

  /** Test-only: drop every lease. */
  _reset_for_test(): void {
    this.leases = [];
  }
}

/** Process-wide gate — one deep tier, one counter. */
const GATE = new EscalationGate();
export function escalation_gate(): EscalationGate {
  return GATE;
}

export interface EscalationVerdict {
  /** Act on it: force the consult and re-roll. */
  escalate: boolean;
  /** What the fast tier demonstrated — present even when we decline to act. */
  evidence: EscalationEvidence | null;
  /** Why we did not act. Null exactly when `escalate` is true. */
  declined_reason: EscalationDecline | null;
  /** Release the deep-tier lease. Non-null exactly when `escalate` is true. */
  release: (() => void) | null;
  /** Leases held at decision time, including this one. For the audit row. */
  inflight: number;
}

/**
 * Detection + policy in one call, because the admission decision has to be
 * atomic with the decision to escalate.
 *
 * ⚠ SIDE EFFECT: on `escalate: true` this HOLDS a deep-tier lease. The caller
 * owns `release` and must call it when the turn ends, on every path.
 *
 * Evaluated even in shadow mode (that is the entire point of shadow mode) —
 * but shadow never touches the gate, so an audit-only deployment cannot
 * starve a voluntary consult.
 */
export function escalation_decision(args: {
  evidence: EscalationEvidence | null;
  mode: EscalationMode;
  /** Wall-clock the user has already spent on this turn. */
  turn_elapsed_ms: number;
  /** `consult_deep_model` is granted AND reachable on this turn's surface. */
  tool_available: boolean;
  /** This turn already escalated once. */
  already_escalated: boolean;
  gate?: EscalationGate;
}): EscalationVerdict {
  const { evidence, mode, turn_elapsed_ms, tool_available, already_escalated } = args;
  const gate = args.gate ?? GATE;
  const nil = (declined_reason: EscalationDecline): EscalationVerdict => ({
    escalate: false,
    evidence,
    declined_reason,
    release: null,
    inflight: gate.inflight(),
  });

  if (!evidence) return nil('no_evidence');
  if (already_escalated) return nil('already_escalated');
  // Ordered cheapest-first, and deliberately BEFORE the mode check so a shadow
  // row records the reason it would have declined anyway rather than flattening
  // every decline to `shadow_only`. An audit corpus that can't tell "we chose
  // not to" from "we couldn't have" is not worth replaying.
  if (turn_elapsed_ms > escalation_max_turn_ms()) return nil('over_turn_budget');
  if (!tool_available) return nil('tool_unavailable');
  if (mode !== 'armed') return nil('shadow_only');

  const release = gate.admit();
  if (!release) return nil('deep_tier_busy');
  return { escalate: true, evidence, declined_reason: null, release, inflight: gate.inflight() };
}

/**
 * The forcing nudge. Paired with `tool_choice:'required'` narrowed to
 * `consult_deep_model` — a text nudge alone is exactly what the small model
 * ignores (the 2026-06-20 intent-miss finding), and this fires only after a
 * plain nudge has already failed once.
 *
 * It asks for a SELF-CONTAINED question plus the evidence as `context`,
 * because the deep model cannot see the conversation — and the whole reason
 * this beats a whole-turn re-run is that the fast tier is the one holding the
 * tool results and knows which ones matter.
 *
 * ⚠ KNOWN LIMIT, stated plainly because the audit corpus will eventually show
 * it: the consult's answer lands in `tool_calls_made`, so it becomes part of
 * the turn's GROUNDING. A specific the 122B asserts from its own memory is
 * therefore grounded on the next pass and the fact critic will pass it. That
 * is not new — it is true of every voluntary `consult_deep_model` call and of
 * every tool result — but escalation makes it reachable from a FABRICATION,
 * which voluntary consults do not. The mitigations are the deep model's own
 * system prompt ("if you genuinely cannot answer, say so plainly") and the
 * last paragraph of this nudge, which licenses dropping the specific outright.
 * Neither is a proof. If the shadow corpus shows escalated turns keeping
 * claims that a human read calls invented, the answer is to stop grounding on
 * the consult result — not to add another judge.
 */
export function escalation_nudge(evidence: EscalationEvidence): string {
  const head = `[DEPTH ESCALATION — internal system note, not from the user]\n\n`;
  const tail =
    `\nCall \`${ESCALATION_TOOL}\` now — once.\n` +
    `  - \`question\`: the specific thing you are stuck on, phrased so it can be ` +
    `answered WITHOUT this conversation. Ask for the reasoning, not for facts ` +
    `about the household — the deep model has no tools and no access to your ` +
    `stores.\n` +
    `  - \`context\`: paste the actual tool results and constraints you are ` +
    `working from. It cannot see any of this; unpasted evidence does not exist ` +
    `to it.\n\n` +
    `Then write the reply in YOUR voice, folding in what came back. If the deep ` +
    `model can't support a specific either, DROP that specific or say plainly ` +
    `that you couldn't confirm it. An honest gap is a correct answer; a ` +
    `confident unsupported one is not.`;

  if (evidence.trigger === 'unresolved_synthesis') {
    return (
      head +
      `You've now been asked twice for the substance and returned ${
        evidence.unresolved[0] === '(empty reply)'
          ? 'an empty reply both times'
          : 'only a statement of intent'
      }. The tool results are above and the user is still waiting.\n` +
      tail
    );
  }

  const list = evidence.unresolved.map((c) => `  - "${c}"`).join('\n');
  return (
    head +
    `You were already told these specifics aren't supported by anything you ` +
    `retrieved this turn, and your rewrite asserts them again:\n${list}\n\n` +
    `One correction has already failed, so re-wording won't fix it. Get help ` +
    `reasoning it out.\n` +
    tail
  );
}
