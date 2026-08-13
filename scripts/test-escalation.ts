/**
 * smoke:escalation — escalate-on-evidence, the successor to the complexity gate.
 *
 * The three things that have to hold, in order of how badly they'd hurt:
 *
 *  1. IT ONLY FIRES ON A SURVIVING FINDING. A guard firing is normal; the
 *     re-roll usually fixes it, and escalating THAT would spend the 122B on
 *     every self-correction in the system. The trigger is a claim that came
 *     back UNCHANGED after the fast tier was told exactly what was wrong.
 *  2. IT NEVER FIRES ON A WRONG-TOOL FAILURE. Tool spirals, false denials and
 *     missed tool calls all reach the same code path; none is evidence that
 *     more reasoning was missing, and escalating them wastes the scarcest tier
 *     in the fleet on a problem thinking cannot touch.
 *  3. IT NEVER QUEUES. `deep_consult` is max_concurrency 2 behind an UNBOUNDED
 *     FIFO. The admission gate is a try-acquire precisely so the third
 *     escalation declines instead of parking a user behind two 300s calls for
 *     an improvement they never asked for.
 *
 * Everything here is pure — no model, no runtime, no clock dependency beyond
 * the injected `now`.
 */
import { build_grounding_context } from '../src/core/provenance';
import {
  ESCALATION_TOOL,
  EscalationGate,
  claim_persists,
  detect_escalation_evidence,
  escalation_budget_ms,
  escalation_decision,
  escalation_max_inflight,
  escalation_max_turn_ms,
  escalation_mode,
  escalation_nudge,
  type CarriedFinding,
} from '../src/core/escalation';

let checks = 0;
function check(name: string, ok: boolean): void {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) process.exitCode = 1;
}

const grounding = (...results: string[]) =>
  build_grounding_context({
    tool_results: results,
    history: [],
    user_message: '',
    retrieved: [],
    verified: [],
  });

const carried = (claim: string, from: CarriedFinding['from'] = 'fact_critic'): CarriedFinding[] => [
  { claim, kind: 'named_entity', from },
];

function main(): void {
  // ── A. mode + budgets read env at call time ────────────────────────────
  delete process.env.HEARTH_ESCALATE_ON_EVIDENCE;
  check('default mode is SHADOW — decide and audit, never spend', escalation_mode() === 'shadow');
  process.env.HEARTH_ESCALATE_ON_EVIDENCE = '1';
  check('=1 arms it', escalation_mode() === 'armed');
  process.env.HEARTH_ESCALATE_ON_EVIDENCE = '0';
  check('=0 is the kill switch', escalation_mode() === 'off');
  // An unreadable value must never silently ARM the thing that spends the 122B.
  process.env.HEARTH_ESCALATE_ON_EVIDENCE = 'yes-please';
  check('an unrecognised value falls back to shadow, never armed', escalation_mode() === 'shadow');
  delete process.env.HEARTH_ESCALATE_ON_EVIDENCE;

  check('the deep leg is bounded well under deep_consult`s 300s', escalation_budget_ms() === 45_000);
  check('a turn already 90s old never starts one', escalation_max_turn_ms() === 90_000);
  check('one escalation in flight by default', escalation_max_inflight() === 1);
  process.env.HEARTH_ESCALATE_BUDGET_MS = '1234';
  check('the leg budget reads env at call time', escalation_budget_ms() === 1234);
  delete process.env.HEARTH_ESCALATE_BUDGET_MS;

  // ── B. claim persistence — "the correction did not take" ───────────────
  const g = grounding('the mower belt part number is MB-9910 and it is in stock');
  check(
    'a claim absent from grounding and still in the reply PERSISTS',
    claim_persists('Torrington Fire District', 'The Torrington Fire District meets Tuesday.', g),
  );
  check(
    'a claim the rewrite DROPPED does not persist',
    !claim_persists('Torrington Fire District', 'I could not confirm which district that is.', g),
  );
  check(
    'a claim the turn actually retrieved does not persist',
    !claim_persists('MB-9910', 'The belt is MB-9910, in stock.', g),
  );
  check(
    'an identifier is matched squashed, so punctuation drift still counts',
    !claim_persists('mb 9910', 'the belt is MB-9910', g),
  );
  check('an empty claim is never a survivor', !claim_persists('   ', 'anything', g));
  check(
    'a 2-char token is too weak to judge and is not a survivor',
    !claim_persists('E3', 'E3 is the code', grounding('nothing relevant')),
  );

  // ── C. detection: the two triggers, and everything that is NOT one ─────
  const survived = detect_escalation_evidence({
    reply: 'The Torrington Fire District still meets Tuesday.',
    carried: carried('Torrington Fire District'),
    grounding: g,
    synthesis_nudged: false,
    reply_blank_or_meta: false,
    had_tool_calls: true,
  });
  check('a surviving claim triggers unresolved_grounding', survived?.trigger === 'unresolved_grounding');
  check('the surviving claim is named for the audit row', survived?.unresolved[0] === 'Torrington Fire District');
  check('the originating guard is recorded', survived?.carried_from === 'fact_critic');

  check(
    'a correction that WORKED does not trigger — this is the common path',
    detect_escalation_evidence({
      reply: 'I could not confirm that district, so I have left it out.',
      carried: carried('Torrington Fire District'),
      grounding: g,
      synthesis_nudged: false,
      reply_blank_or_meta: false,
      had_tool_calls: true,
    }) === null,
  );
  check(
    'no carried findings at all → nothing to trigger on (the cheap path)',
    detect_escalation_evidence({
      reply: 'The Torrington Fire District meets Tuesday.',
      carried: [],
      grounding: g,
      synthesis_nudged: false,
      reply_blank_or_meta: false,
      had_tool_calls: true,
    }) === null,
  );

  const blank_twice = detect_escalation_evidence({
    reply: '',
    carried: [],
    grounding: g,
    synthesis_nudged: true,
    reply_blank_or_meta: true,
    had_tool_calls: true,
  });
  check('a second blank reply after the synthesis nudge triggers', blank_twice?.trigger === 'unresolved_synthesis');
  check(
    'the FIRST blank reply does not — the cheap nudge gets its shot first',
    detect_escalation_evidence({
      reply: '',
      carried: [],
      grounding: g,
      synthesis_nudged: false,
      reply_blank_or_meta: true,
      had_tool_calls: true,
    }) === null,
  );
  check(
    'a blank turn with NO tool results is not an escalation — it has nothing to reason over',
    detect_escalation_evidence({
      reply: '',
      carried: [],
      grounding: g,
      synthesis_nudged: true,
      reply_blank_or_meta: true,
      had_tool_calls: false,
    }) === null,
  );

  // THE WRONG-TOOL CLASSES. Each of these is a real turn shape that reaches
  // this code and must fall through: a tool spiral (the model can't fill the
  // args), a false denial (it didn't reach for the tool), a missed forced call.
  // None of them carries a surviving CLAIM, so detection declines by
  // construction rather than by an exception list — which is why it stays
  // correct as new guards are added.
  check(
    'a tool spiral is not evidence of insufficient reasoning',
    detect_escalation_evidence({
      reply: 'I tried but could not get the lookup to land cleanly.',
      carried: [],
      grounding: grounding('ERROR: INPUT_VALIDATION_FAILED', 'ERROR: INPUT_VALIDATION_FAILED'),
      synthesis_nudged: false,
      reply_blank_or_meta: false,
      had_tool_calls: true,
    }) === null,
  );
  check(
    'an honest decline after a failed read is not evidence either',
    detect_escalation_evidence({
      reply: "I don't have that — the read failed and I couldn't recover it.",
      carried: carried('Torrington Fire District'),
      grounding: g,
      synthesis_nudged: false,
      reply_blank_or_meta: false,
      had_tool_calls: true,
    }) === null,
  );

  // ── D. policy: budgets, admission, and the fail-toward-shipping rule ───
  const gate = new EscalationGate();
  const armed = {
    evidence: survived,
    mode: 'armed' as const,
    turn_elapsed_ms: 5_000,
    tool_available: true,
    already_escalated: false,
    gate,
  };
  const ok = escalation_decision(armed);
  check('armed + evidence + a free slot escalates', ok.escalate);
  check('escalating hands back a release fn the caller owns', typeof ok.release === 'function');
  check('the held lease is reported for the audit row', ok.inflight === 1);

  // THE THIRD ESCALATION. With the slot held, the next one must DECLINE, not
  // queue — the whole reason this gate exists rather than leaning on the
  // provider's FIFO.
  const busy = escalation_decision(armed);
  check('a second concurrent escalation declines instead of queueing', !busy.escalate);
  check('...and says why, so the corpus can count it', busy.declined_reason === 'deep_tier_busy');
  check('...and holds no lease of its own', busy.release === null);
  ok.release?.();
  check('releasing frees the slot', gate.inflight() === 0);
  ok.release?.();
  check('release is idempotent — a double-release cannot over-admit', gate.inflight() === 0);

  const stale = escalation_decision({ ...armed, turn_elapsed_ms: 120_000 });
  check('a turn already past the ceiling never starts a deep leg', !stale.escalate);
  check('...for the stated reason', stale.declined_reason === 'over_turn_budget');
  check('...and does not take a slot on the way out', gate.inflight() === 0);

  const ungranted = escalation_decision({ ...armed, tool_available: false });
  check(
    `a specialist without ${ESCALATION_TOOL} on its surface cannot escalate`,
    ungranted.declined_reason === 'tool_unavailable',
  );
  check(
    'a turn that already escalated will not escalate twice',
    escalation_decision({ ...armed, already_escalated: true }).declined_reason === 'already_escalated',
  );
  check(
    'no evidence, no escalation — whatever the mode',
    escalation_decision({ ...armed, evidence: null }).declined_reason === 'no_evidence',
  );

  // SHADOW is the shipped default: it must reach a real decision and record it
  // WITHOUT touching the gate, so an audit-only deployment can never starve a
  // voluntary consult.
  const shadow = escalation_decision({ ...armed, mode: 'shadow' });
  check('shadow mode decides but does not act', !shadow.escalate && shadow.declined_reason === 'shadow_only');
  check('shadow mode takes no deep-tier slot', gate.inflight() === 0);
  // ...and a shadow row must not flatten every decline to `shadow_only`, or the
  // corpus can't tell "we chose not to" from "we couldn't have".
  const shadow_stale = escalation_decision({ ...armed, mode: 'shadow', turn_elapsed_ms: 120_000 });
  check(
    'a shadow decline reports the reason it would have declined anyway',
    shadow_stale.declined_reason === 'over_turn_budget',
  );

  // The leak backstop: a caller that never releases must not wedge escalation
  // for the life of the process.
  const leaky = new EscalationGate();
  const t0 = 1_000_000;
  leaky.admit(t0);
  check('a held lease blocks admission', leaky.admit(t0) === null);
  check('...and expires on its own if never released', leaky.admit(t0 + escalation_budget_ms() * 2 + 1) !== null);

  // ── E. the nudge ───────────────────────────────────────────────────────
  const nudge = escalation_nudge(survived!);
  check('the nudge names the tool it is forcing', nudge.includes(ESCALATION_TOOL));
  check('the nudge quotes the claim that survived', nudge.includes('Torrington Fire District'));
  check(
    'the nudge tells it to PASTE the evidence — the deep model has no tools',
    /cannot see|no tools/i.test(nudge),
  );
  check(
    'the nudge licenses an honest gap rather than another confident guess',
    /drop that specific|couldn't confirm|could not confirm/i.test(nudge),
  );
  check(
    'the nudge is marked internal so it never reads as the user speaking',
    nudge.includes('not from the user'),
  );
  const synth_nudge = escalation_nudge(blank_twice!);
  check('the synthesis trigger gets its own wording', synth_nudge.includes('still waiting'));
  check('...and still forces the same tool', synth_nudge.includes(ESCALATION_TOOL));

  if (process.exitCode === 1) {
    console.log('\nsmoke:escalation FAILED');
    process.exit(1);
  }
  console.log(`\n✓ smoke:escalation — ${checks} checks passed`);
}

main();
