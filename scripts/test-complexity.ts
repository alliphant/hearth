/**
 * smoke:complexity — the hard-question heuristic behind the deep-tier gate.
 * Precision over recall: two independent signals required; one-liners never
 * escalate; consult_deep_model stays the in-turn escape hatch for misses.
 *
 * ⚠ 2026-08-05 — READ `.hard` AND `.would_have_escalated` AS DIFFERENT THINGS.
 * The gate was demoted to a pre-filter when escalate-on-evidence landed: only
 * an EXPLICIT request for depth still routes a whole turn up front, while the
 * heuristic keeps running as an INSTRUMENT (`would_have_escalated`) so the
 * prediction can be graded against what the turn went on to demonstrate.
 *
 * So an assertion here means one of three distinct things, and the wording
 * says which:
 *   `.hard`                  — this turn routes to the deep tier NOW.
 *   `.would_have_escalated`  — the heuristic still recognises the shape.
 *   `.explicit`              — the user asked for depth in words.
 * A test that only ever checked `.hard` would now pass while the heuristic
 * silently rotted, which is the opposite of what this file is for.
 */
import {
  assess_complexity,
  complexity_gate_enabled,
  complexity_predicts,
  explicit_depth_request,
} from '../src/core/complexity';

let checks = 0;
function check(name: string, ok: boolean): void {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) process.exitCode = 1;
}

function main(): void {
  check('a one-liner never escalates, whatever it says', !assess_complexity('compare notes later?').hard);
  check(
    'simple lookup stays fast',
    !assess_complexity('What time is the dentist appointment tomorrow and should I bring the insurance card with me to it?').hard,
  );
  // The garden ask carries "think through the tradeoffs" — that is the USER
  // asking to be reasoned at, so it still routes up front. It is the only
  // class that does.
  check(
    'an explicit "think through" routes the whole turn up front',
    assess_complexity(
      'Can you help me plan out the garden beds for next spring? Compare drip irrigation versus soaker hoses for the east bed, ' +
        'and think through the tradeoffs on cost and water use — also, should we prioritize the tomatoes or the peppers first?',
    ).hard,
  );
  check(
    'single signal alone stays fast (precision over recall)',
    !assess_complexity(
      'Why is the garage door opener acting funny lately when it rains in the evening, do you think? It seems weird to me.',
    ).hard,
  );
  // The same message WITHOUT an explicit ask: the heuristic still recognises
  // it (that is the instrument working) but it no longer routes (that is the
  // demotion). Both halves are asserted, because a test that checked only one
  // would go green if the other silently broke.
  const v = assess_complexity(
    'Design a strategy for restructuring the home network: weigh the tradeoffs between a flat LAN and VLAN segmentation, ' +
      'and lay out the long-term implications for the camera system. What should we do first? And what comes second?',
  );
  check('signals are reported for audit/tuning', v.signals.length >= 2);
  check('the heuristic still recognises a hard-shaped ask', v.would_have_escalated);
  check('...but recognising it no longer routes the turn', !v.hard);
  check('...and it is recorded as a non-explicit ask', !v.explicit);

  // Per-specialist floor (Kate the COS sets complexity_floor: 1) — a SHORT
  // single-signal reasoning ask escalates at floor 1 but not at the default 2.
  const short_reasoning = 'Why does Kristi own new-hire packets?';
  check(
    'short reasoning ask is not even RECOGNISED at default floor 2',
    !assess_complexity(short_reasoning).would_have_escalated,
  );
  check(
    'short reasoning ask IS recognised at floor 1 (the floor still means something)',
    assess_complexity(short_reasoning, 1).would_have_escalated,
  );
  check(
    'a short single-signal "should I X or Y" is recognised at floor 1',
    assess_complexity('Should I list it on eBay or Facebook?', 1).would_have_escalated,
  );
  check(
    'neither one routes the turn any more — that is escalation`s job now',
    !assess_complexity(short_reasoning, 1).hard &&
      !assess_complexity('Should I list it on eBay or Facebook?', 1).hard,
  );
  // ...but trivial chat (zero signals) NEVER escalates, even at floor 1 —
  // a lowered floor must not make small talk slow.
  check('zero-signal chitchat stays fast at floor 1', !assess_complexity('Hey there', 1).hard);
  check("zero-signal lookup stays fast at floor 1", !assess_complexity("What's the weather this week?", 1).hard);

  // Repeated terminal punctuation is EMPHASIS, not multiple questions. This
  // was the live false positive: at Kate's floor 1, `multi_part` fired on
  // "???" alone and routed a throwaway line to the deep tier (three
  // context-overflow 400s in a week, 2026-07-31).
  const emphatic = "??? you can't clean things... how would YOU handle the greeting?";
  check('"???" is one question, not three (floor 1)', !assess_complexity(emphatic, 1).hard);
  check('"What?!" is one question (floor 1)', !assess_complexity('What?! I thought it was done.', 1).hard);
  // ── SHAPE IS NOT DIFFICULTY (2026-08-05) ──────────────────────────────
  // These two assertions used to read "still escalates at floor 1", pinning
  // `multi_part` ALONE as sufficient. Replaying 14 days of real
  // `complexity_route` rows showed that path was carrying 130 of 184
  // escalations (71%) with no reasoning signal at all — Kate's were "What's
  // the review status of Maggie's proposal…" and "is there a proposal in the
  // merge queue…", i.e. ledger reads sent to a think-ON 122B. Two plain
  // questions about the mower are still two plain questions.
  check(
    'two plain questions do NOT escalate — shape alone is not difficulty',
    !assess_complexity('Is the mower serviced? Do we need the belt replaced?', 1).hard,
  );
  check(
    'two questions WITH reasoning language are recognised',
    assess_complexity(
      'Should I service the mower or replace the belt instead? What are the tradeoffs?',
      1,
    ).would_have_escalated,
  );
  check(
    'a long message with no reasoning language does not escalate',
    !assess_complexity('generate a new image: ' + 'a hyper-realistic shot, '.repeat(40), 1).hard,
  );
  // Status/existence lookups are suppressed even when a reasoning regex
  // incidentally matches — "why is X still pending" trips `why (is)` while
  // being a pure ledger read. The audit row still records what fired.
  const suppressed = assess_complexity(
    'What is the status of the the clinic StreetMedia proposal, and why is it still pending?',
    1,
  );
  check('a status lookup is suppressed even with a reasoning match', !suppressed.hard);
  check(
    'suppression is recorded in the signals, not hidden',
    suppressed.signals.includes('suppressed:lookup'),
  );
  // Adversarial review IS reasoning-shaped, so the vocabulary stays a real
  // signal — but it no longer ROUTES, and that is the point of the 2026-08-05
  // demotion rather than an oversight. `critic` already pins
  // `llm_role: critic_review` (122B, forza :8090, think:false, temp 0.2) and
  // its YAML records that think-ON was benched and REFUTED for scrutiny on
  // 2026-07-02 — no accuracy gain at 14x the latency. `deep_consult` is the
  // same model on the same endpoint with `think: true`, and delegate /
  // review_swarm call runtime.turn with no think_override — so every one of
  // those 26 "kept" critic escalations was the gate quietly overriding a bench
  // result, never a bigger model. The lever for a seat's depth is its own
  // llm_role, not a regex over the prompt it was handed.
  const red_team = assess_complexity(
    "You are the RED TEAM reviewing Beatrice's code change bchg_01. Find every blocker.",
    1,
  );
  check('adversarial-review vocabulary is still recognised', red_team.would_have_escalated);
  check('...but no longer flips a pinned critic seat to think-ON', !red_team.hard);
  check(
    'a trailing bare "?" adds nothing',
    !assess_complexity('So the sprinklers are off ?', 1).hard,
  );
  check(
    'an enumerated ask with no reasoning language does NOT escalate',
    !assess_complexity('Analyze the photo and report: (1) the make, (2) the model.', 1).hard,
  );

  // ── THE EXPLICIT-DEPTH PRE-FILTER (2026-08-05) ────────────────────────
  // The one prediction that isn't one: the user telling you how they want it
  // answered. It must survive the sub-80-char short-circuit — "think hard
  // about this" is 22 characters — and it must not fire on ordinary English
  // that happens to contain the word "think".
  check('an explicit ask routes even at the default floor', assess_complexity('Think hard about this: should we refinance?').hard);
  check(
    'an explicit ask survives the short-message short-circuit',
    assess_complexity('think this through').hard,
  );
  check('"step by step" is an explicit ask', explicit_depth_request('walk it step by step'));
  check('"take your time" is an explicit ask', explicit_depth_request('take your time on this one'));
  check('"deep dive" is an explicit ask', explicit_depth_request('do a deep dive on the invoice'));
  check(
    'the explicit ask is recorded in the signals',
    assess_complexity('think this through').signals.includes('explicit_depth_request'),
  );
  check(
    'an explicit ask is flagged explicit, not merely hard',
    assess_complexity('think this through').explicit,
  );
  // "hard" is an ordinary adjective, and the collision is a real household
  // question. Without the clause-boundary lookahead this routes a four-word
  // water-softener question to a think-ON 122B — the exact class the whole
  // 2026-08-05 change exists to stop sending there.
  check(
    '"do you think hard water is the problem?" is NOT a depth request',
    !explicit_depth_request('Do you think hard water is the problem?'),
  );
  check(
    '"walk me through the implications" is an explanation ask, not a depth ask',
    !explicit_depth_request('walk me through the implications for the camera system'),
  );
  check(
    '"I don\'t think over-engineering helps" is not a depth request',
    !explicit_depth_request("I don't think over-engineering helps here"),
  );

  // `predict` restores pre-demotion routing without disarming escalation —
  // one flag, one revert, independently testable.
  check('prediction routing is OFF by default', !complexity_predicts());
  const heuristic_only = 'Should I service the mower or replace the belt instead? What are the tradeoffs?';
  check('a hard-shaped ask does not route by default', !assess_complexity(heuristic_only, 1).hard);
  process.env.HEARTH_COMPLEXITY_GATE = 'predict';
  check('predict mode reads env at call time', complexity_predicts());
  check('predict mode restores heuristic routing', assess_complexity(heuristic_only, 1).hard);
  check(
    'predict mode still records the same signals',
    assess_complexity(heuristic_only, 1).would_have_escalated,
  );
  delete process.env.HEARTH_COMPLEXITY_GATE;

  check('kill switch reads env at call time', complexity_gate_enabled() === true);
  process.env.HEARTH_COMPLEXITY_GATE = '0';
  check('kill switch disables', complexity_gate_enabled() === false);
  check('the kill switch also disables prediction mode', !complexity_predicts());
  delete process.env.HEARTH_COMPLEXITY_GATE;

  if (process.exitCode === 1) {
    console.log('\nsmoke:complexity FAILED');
    process.exit(1);
  }
  console.log(`\n✓ smoke:complexity — ${checks} checks passed`);
}

main();
