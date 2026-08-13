/**
 * complexity — the "think before you answer" gate (2026-06-10).
 *
 * The fleet's tier selection is declarative-by-situation (the private dev log: never
 * load-based), and "this question needs real reasoning" IS a situation.
 * Today a hard multi-step question runs on the fast think-OFF interactive
 * tier unless the SPECIALIST decides to consult the deep model — i.e. the
 * least capable judge assesses the question's difficulty. This gate makes
 * the call deterministically, BEFORE the turn starts:
 *
 *   simple lookup / chat  → fast tier, think-OFF (unchanged — the A/B
 *                           showed think-off grounds better and 3-7x
 *                           faster on grounding-shaped prompts)
 *   hard-shaped question  → the deep tier (35B) with thinking ON for
 *                           the WHOLE turn
 *
 * "Hard-shaped" is a cheap, transparent heuristic — planning/comparison/
 * tradeoff language, multi-part asks, explicit think-hard requests, or
 * sheer length. No LLM pre-pass (that would tax every turn to detect the
 * rare hard one); false negatives still have consult_deep_model as the
 * escape hatch, false positives just get a slower-but-smarter turn.
 *
 * NEVER fires on voice (TTFB-critical) or deliberation (already on the
 * deep tier). Kill switch: HEARTH_COMPLEXITY_GATE=0.
 *
 * ── 2026-08-05: DEMOTED TO A PRE-FILTER ────────────────────────────────────
 * Everything above describes what this file did when prediction was the ONLY
 * mechanism available. It no longer is: `escalation.ts` escalates on what the
 * turn DEMONSTRATES, which is strictly better evidence applied at the point of
 * most information. Predicting difficulty from the question is now reserved for
 * the one case where it is not a prediction at all — THE USER SAID SO. "Think
 * hard about this", "reason it through step by step", "deep dive on this" is an
 * INSTRUCTION about how they want it answered, and honouring it up front is
 * correct; guessing at difficulty from planning vocabulary and question count
 * is what the 14-day replay showed going wrong.
 *
 * The rest of the signals are still COMPUTED and still AUDITED — every turn
 * writes a `complexity_route` row carrying `would_have_escalated` — so the
 * prediction and the demonstration sit side by side on the same `intent_id` and
 * the next person can grade one against the other. That replay is exactly what
 * made this fix possible; removing the signals outright would have destroyed
 * the instrument along with the behaviour.
 *
 * The other thing the replay turned up: `critic` pins `llm_role: critic_review`
 * (122B on forza :8090, think:false, temp 0.2) and its YAML says think-ON was
 * BENCHED and REFUTED for scrutiny on 2026-07-02 — no accuracy gain at 14x the
 * latency. `deep_consult` is the SAME model on the SAME endpoint with
 * `think: true`. So the 26 `critic` escalations the reasoning-signal fix
 * deliberately kept were never buying a bigger model; they were switching
 * thinking back on against a bench result, because delegate/review_swarm call
 * `runtime.turn` with no `think_override` and the gate then supplies one. That
 * class stops escalating here, and the right lever for it stays where it
 * already is — the seat's own `llm_role`.
 *
 * HEARTH_COMPLEXITY_GATE: `0` off entirely; `predict` restores the full
 * pre-2026-08-05 prediction routing (an independent revert lever that doesn't
 * touch escalate-on-evidence); unset/anything else = explicit-request only.
 */

export function complexity_gate_enabled(): boolean {
  return process.env.HEARTH_COMPLEXITY_GATE !== '0';
}

/**
 * Does the gate still route NON-explicit hard-shaped turns up front?
 *
 * Off by default since 2026-08-05. `HEARTH_COMPLEXITY_GATE=predict` restores
 * it — a single-flag revert for the case where escalate-on-evidence turns out
 * to under-catch, without having to also disarm escalation.
 */
export function complexity_predicts(): boolean {
  return (process.env.HEARTH_COMPLEXITY_GATE ?? '').trim().toLowerCase() === 'predict';
}

/**
 * The user ASKING for depth. Not a difficulty heuristic — an instruction.
 *
 * Kept narrow on purpose: each of these is a phrase whose only reading is
 * "spend more on this one". Generic reasoning vocabulary (compare, tradeoffs,
 * plan, why does) is deliberately NOT here — that is the guessing the replay
 * indicted, and it now lives in the audited-but-not-routed signal set.
 */
const EXPLICIT_DEPTH: readonly RegExp[] = [
  // "think through the tradeoffs", "reason it through", "think this over".
  // `(?!-)` keeps "I don't think over-engineering helps" out.
  /\b(?:think|reason)\s+(?:it|this|that)?\s*(?:really|very|extra|super)?\s*(?:through|over)\b(?!-)/i,
  /\bthink\s+(?:about\s+(?:it|this|that)\s+)?(?:really|very|extra|super)?\s*(?:carefully|deeply)\b/i,
  // "hard" needs a clause boundary the others don't, because it is also an
  // ordinary adjective: without the lookahead "do you think hard water is the
  // problem?" reads as a request for the 122B — precisely the mis-route this
  // whole change exists to stop. The lookahead is grammar (punctuation, end of
  // message, or a function word), not a vocabulary list.
  /\bthink\s+(?:it|this|that|about\s+(?:it|this|that))?\s*(?:really|very|extra|super)?\s*hard\b(?=\s*(?:[,.;:!?—]|$|\b(?:about|on|before|for|with|and|but|then|please|first)\b))/i,
  /\bstep[- ]by[- ]step\b/i,
  /\b(?:deep[- ]dive|dive deep)\b/i,
  /\btake your time\b/i,
  /\bdon'?t rush\b/i,
  /\b(?:use|ask) the (?:deep|big|bigger|large|larger|smart(?:er)?) model\b/i,
];

/** True when the message explicitly asks for a deeper, slower answer. */
export function explicit_depth_request(message: string): boolean {
  return EXPLICIT_DEPTH.some((re) => re.test(message));
}

/** Reasoning-shaped language — planning, comparison, design, tradeoffs. */
const HARD_SIGNALS: readonly RegExp[] = [
  /\b(compare|versus|vs\.?|trade-?offs?|pros and cons|weigh)\b/i,
  /\b(plan|strategy|strategize|roadmap|design|architect|restructure)\b/i,
  /\bshould (i|we)\b.*\b(or|instead|rather)\b/i,
  /\b(why (does|is|would|did)|how (would|could|should) (i|we|it))\b/i,
  /\b(think (hard|carefully|through)|reason through|step by step|deep dive)\b/i,
  /\b(implications?|consequences?|second[- ]order|long[- ]term effects?)\b/i,
  /\b(optimi[sz]e|allocate|prioriti[sz]e|budget out)\b/i,
  // Adversarial review / judgement vocabulary (2026-08-05). Added when the
  // "reasoning signal required" rule was replayed against 14 days of real
  // escalations and dropped 20 `critic` turns whose text begins "You are the
  // RED TEAM (seat red-1) reviewing Beatrice's code change …". Those are the
  // single clearest case in the corpus for wanting the big thinking model, and
  // they were only ever escalating on `multi_part` + `long_form` — i.e. by
  // accident, because adversarial-review language was simply missing from this
  // list. This is a gap in the signals, not an exception to the rule.
  /\b(red team|blue team|adversarial|critique|counter-?argument)\b/i,
  /\b(assess|evaluate|judge|verdict|blocker|what could go wrong|failure mode)\b/i,
  /\brisks? (of|in|to|with)\b/i,
];

/**
 * Count question marks that terminate DISTINCT clauses — not `?` characters.
 *
 * 2026-07-31: the old form was `message.match(/\?/g).length >= 2`, so an
 * emphatic "???" counted as three questions. At Kate's lowered floor of 1
 * that single signal escalated the WHOLE turn to the deep tier: every one
 * of the six most recent `complexity_route` audit rows for kate fired on
 * `multi_part` alone, and `"??? you can't clean things... how would YOU
 * handle the greeting?"` is not a multi-part ask by any reading. Collapse
 * runs of terminal punctuation, then require real content in front of each
 * mark, so "What?!" and "???" are one question and "Is it A? Is it B?" is
 * still two.
 */
function distinct_questions(message: string): number {
  return message
    .replace(/[?!]{2,}/g, '?')
    .split('?')
    .slice(0, -1) // the text preceding each '?'
    .filter((clause) => /[a-z0-9]/i.test(clause)).length;
}

/** Multi-part shape: several questions, or an enumerated ask. */
function multi_part(message: string): boolean {
  if (distinct_questions(message) >= 2) return true;
  return /\b(1\)|2\)|first(ly)?,|second(ly)?,|and also|as well as.*\?)/i.test(message);
}

/**
 * STATUS / EXISTENCE lookups — questions answered by reading one store, where
 * a bigger model with thinking on is not just wasted but actively worse.
 *
 * These suppress escalation even when a reasoning regex incidentally matches,
 * which is the case rule 1 below can't catch on its own: "why is the proposal
 * for X still pending?" trips `why (is)` while being a pure ledger read.
 *
 * Deliberately narrow — status and existence only. "Why did the deploy fail?"
 * is NOT here and stays escalatable, because that genuinely is reasoning over
 * evidence rather than a field lookup.
 */
const LOOKUP_SHAPES: readonly RegExp[] = [
  /\b(what|what'?s|what is) the (status|state|verdict|outcome|result) of\b/i,
  /\bis there (a|an|any)\b/i,
  /\bdo (we|i) have\b/i,
  /\b(did|has|have) (it|he|she|they|we|i|[a-z]+) (ever )?(already )?(get|got|gotten|been|land|landed|ship|shipped|arrive[d]?|reply|replied|respond|responded|finish|finished)\b/i,
  /\b(when|where|who) (is|are|was|were|does|do)\b/i,
  /\bhow many\b/i,
  /\bwhat'?s on my\b/i,
  /\b(any|anything) (news|word|update)s? on\b/i,
];

function lookup_shaped(message: string): boolean {
  return LOOKUP_SHAPES.some((re) => re.test(message));
}

export interface ComplexityVerdict {
  /**
   * Route this whole turn to the deep tier NOW.
   *
   * Since the 2026-08-05 demotion this is `explicit || (predict-mode &&
   * hard-shaped)` — NOT the raw heuristic. Read `would_have_escalated` for
   * what the old gate would have said.
   */
  hard: boolean;
  /** Which signals fired — audited so the heuristic is tunable from data. */
  signals: string[];
  /** The user asked for depth in words. The one prediction that isn't one. */
  explicit: boolean;
  /**
   * What the pre-demotion gate would have decided from the same signals.
   * Recorded on EVERY turn so the prediction can be graded against what the
   * turn went on to demonstrate. This is the instrument, not the behaviour.
   */
  would_have_escalated: boolean;
}

/**
 * @param min_signals  how many independent signals make a turn "hard". At
 *   least one of them must be a REASONING signal regardless of this number —
 *   see the "SHAPE IS NOT DIFFICULTY" note below.
 *   Default 2 (precision over recall). A broad-grant generalist that
 *   reasons in SHORT operational asks — Kate the chief-of-staff — opts
 *   into a LOWERED floor (1) via `complexity_floor` in its YAML. A floor
 *   below 2 also drops the one-liner short-circuit, so a terse reasoning
 *   ask ("Why does Kristi own hire packets?", "Is this redundant with X?")
 *   escalates to the deep tier instead of being answered — and fabricated
 *   — by the fast 9B (the 2026-06-16 Kristi-scope spiral). Trivial chat
 *   ("hey", "weather?") still has ZERO signals → never escalates at any
 *   floor, so a lowered floor doesn't make small talk slow.
 *
 *   ⚠ Since the 2026-08-05 demotion `min_signals` only decides
 *   `would_have_escalated` unless HEARTH_COMPLEXITY_GATE=predict. A floor is
 *   now a statement about the INSTRUMENT, not about routing.
 */
export function assess_complexity(message: string, min_signals = 2): ComplexityVerdict {
  const signals: string[] = [];
  const trimmed = message.trim();
  const explicit = explicit_depth_request(trimmed);
  // The verdict shape in one place: an explicit ask always routes; the
  // heuristic only routes in `predict` mode, and is otherwise recorded.
  const verdict = (would: boolean, sig: string[]): ComplexityVerdict => ({
    hard: explicit || (would && complexity_predicts()),
    signals: explicit ? [...sig, 'explicit_depth_request'] : sig,
    explicit,
    would_have_escalated: would,
  });

  // Short messages are conversational by construction — never escalate a
  // one-liner in DEFAULT mode ("compare notes later!"). A lowered floor
  // skips this so a short REASONING ask can still escalate; the signal
  // count below still gates it, so a short *chitchat* line (no signals)
  // stays fast regardless of floor.
  //
  // "think hard about this" is 22 chars and is the ONE thing that must survive
  // the short-circuit, so `verdict()` — not a bare false — carries it out.
  if (min_signals >= 2 && trimmed.length < 80) return verdict(false, signals);

  let reasoning = 0;
  for (const re of HARD_SIGNALS) {
    if (re.test(trimmed)) {
      signals.push(re.source.slice(0, 32));
      reasoning++;
    }
  }
  if (multi_part(trimmed)) signals.push('multi_part');
  if (trimmed.length > 600) signals.push('long_form');

  // ── SHAPE IS NOT DIFFICULTY (2026-08-05) ────────────────────────────────
  // `multi_part` and `long_form` describe the FORM of a message — how many
  // question marks, how many characters — and neither says anything about
  // whether answering requires reasoning. Allowing them to fire alone made
  // them the dominant escalation path: over 14 days of `complexity_route`
  // audit rows, 130 of 183 escalations (71%) carried NO reasoning signal at
  // all. `["multi_part"]` alone accounted for 69.
  //
  // What that bought, in Kate's own rows: "What's the review status of
  // Maggie's proposal 01KZ…", "Is there a proposal in the merge queue for the clinic
  // StreetMedia", "take this ref2va prompt and make it more sensual/sexy".
  // Lookups and a rewrite — each routed to a think-ON 122B with a 300s
  // timeout and concurrency 2, where the fast tier plus one tool call answers
  // in seconds.
  //
  // And this is not merely wasteful. THINK_OFF_CHAT_BRIEF's A/B found
  // think-OFF STRICTLY BETTER on grounding-shaped prompts — same accuracy, no
  // new fabrication, 3-7x faster, ~10x fewer tokens. Escalating a lookup to a
  // thinking model degrades the exact class it was firing on most.
  //
  // So shape signals still COUNT toward `min_signals` — a long, many-part
  // design question should clear a floor of 2 more easily than a terse one —
  // but they can no longer carry a turn on their own.
  const hard_enough = signals.length >= min_signals && reasoning >= 1;

  // A status/existence lookup never escalates, even when a reasoning regex
  // incidentally matches it. Applied after the count so the audit row still
  // records what fired — a suppressed escalation is data about the gate, and
  // silently dropping the signals would hide it.
  if (hard_enough && lookup_shaped(trimmed)) {
    return verdict(false, [...signals, 'suppressed:lookup']);
  }
  return verdict(hard_enough, signals);
}
