/**
 * smoke:deliberation-envelope — the robust deliberation-envelope parser.
 *
 * Pure-function smoke (no orchestrator, no LLM). Replays the 2026-06-17
 * missing-owner-brief class: the deep tier (qwen36-35b-a3b) drifted off the
 * strict ```json fence on Kate's larger owner brief, `extract_envelope`
 * returned null, and `deliberation_pass` silently produced no brief and no
 * audit row. The parser now recovers fence drift / bare objects; this asserts
 * the recovery matrix AND that genuinely malformed output still fails closed.
 */
import { extract_envelope, parse_envelope_object, generate_brief_fallback } from '@core/deliberation';
import type { SpecialistRuntime } from '@core/specialist_runtime';
import type { LoadedSpecialist } from '@core/specialist';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assert: ${message}`);
}

let passed = 0;
function ok(label: string): void {
  passed++;
  console.log(`  ✓ ${label}`);
}

const ENVELOPE = {
  summary_for_self: 'Quiet morning; calendar clear.',
  flags: [],
  proposals: [],
  interrupts: [],
  miss_actions: [],
  morning_brief: {
    mood: 'calm',
    sections: { noticed: 'Nothing urgent.', attention_today: 'Wastewater tour tomorrow 9:20.' },
  },
};
const JSON_BODY = JSON.stringify(ENVELOPE, null, 2);

console.log('deliberation envelope parser:');

// 1. Strict ```json fence — the canonical happy path, unchanged behavior.
{
  const text = '```json\n' + JSON_BODY + '\n```';
  const env = extract_envelope(text);
  assert(env, 'strict fence parses');
  assert(env.summary_for_self === ENVELOPE.summary_for_self, 'strict fence summary preserved');
  assert(env.morning_brief !== undefined, 'strict fence morning_brief preserved');
  ok('strict ```json fence → parses, brief preserved');
}

// 2. Untagged ``` fence (model dropped the `json` tag).
{
  const text = 'Here is my envelope:\n```\n' + JSON_BODY + '\n```';
  const env = extract_envelope(text);
  assert(env, 'untagged fence parses');
  assert(env.morning_brief !== undefined, 'untagged fence brief preserved');
  ok('untagged ``` fence → parses');
}

// 3. Fence with the JSON on the same line as the tag / no clean newlines.
{
  const text = '```json ' + JSON.stringify(ENVELOPE) + ' ```';
  const env = extract_envelope(text);
  assert(env, 'same-line fence parses');
  assert(env.summary_for_self === ENVELOPE.summary_for_self, 'same-line summary preserved');
  ok('```json on same line as body → parses');
}

// 4. Bare object, no fence at all, with prose around it.
{
  const text = 'Sure, here you go.\n' + JSON_BODY + '\nLet me know if you need anything else.';
  const env = extract_envelope(text);
  assert(env, 'bare object parses');
  assert(env.morning_brief !== undefined, 'bare object brief preserved');
  ok('bare {…} object wrapped in prose → parses');
}

// 5. A `}` INSIDE a string value must not close the object early.
{
  const tricky = {
    ...ENVELOPE,
    summary_for_self: 'EV at 76% } and charging not active { per HA',
  };
  const text = 'note:\n' + JSON.stringify(tricky) + '\ndone';
  const env = extract_envelope(text);
  assert(env, 'string-brace object parses');
  assert(env.summary_for_self === tricky.summary_for_self, 'brace-in-string value intact (no early close)');
  ok('} inside a string value → balanced scan does not close early');
}

// 6. Strict fence is preferred over a later bare object (precedence).
{
  const real = '```json\n' + JSON.stringify(ENVELOPE) + '\n```';
  const decoy = '\n{ "summary_for_self": "DECOY", "flags": [] }';
  const env = extract_envelope(real + decoy);
  assert(env, 'precedence parses');
  assert(env.summary_for_self === ENVELOPE.summary_for_self, 'strict fence wins over later bare object');
  ok('strict fence preferred over a trailing decoy object');
}

// 7. Missing fields are normalized to safe defaults (partial object).
{
  const env = extract_envelope('```json\n{ "summary_for_self": "x" }\n```');
  assert(env, 'partial object parses');
  assert(Array.isArray(env.flags) && env.flags.length === 0, 'flags default to []');
  assert(Array.isArray(env.miss_actions), 'miss_actions default to []');
  assert(env.morning_brief === undefined, 'absent morning_brief stays undefined');
  ok('partial object → fields normalized, no brief when absent');
}

// 8. Genuinely malformed JSON (truncated) → null. Fails CLOSED.
{
  const truncated = '```json\n{ "summary_for_self": "x", "flags": [ {';
  assert(extract_envelope(truncated) === null, 'truncated JSON → null');
  assert(parse_envelope_object(truncated) === null, 'truncated parse_envelope_object → null');
  ok('truncated/malformed JSON → null (fails closed)');
}

// 9. No JSON anywhere (pure prose) → null.
{
  assert(extract_envelope('I had a great morning, nothing to report!') === null, 'prose → null');
  ok('pure prose, no object → null');
}

// 10. Top-level array is not an envelope object → null.
{
  assert(extract_envelope('```json\n[1, 2, 3]\n```') === null, 'array → null');
  ok('top-level JSON array → null (envelope must be an object)');
}

// ── Guaranteed-brief fallback (the dedicated tool-free regeneration) ──────
// When a brief-slot pass ends without a morning_brief, generate_brief_fallback
// re-asks the model for ONLY the brief JSON, grounded in already-gathered
// context. Fail-open at every step. Tested with a fake runtime (no live LLM).
const fake_specialist = { name: 'Kate', role: 'Chief of Staff' } as unknown as LoadedSpecialist;
const base_args = {
  specialist: fake_specialist,
  slot: '12:30',
  brief_kind: 'midday',
  user_display_name: 'Jasper',
  now_local: '2026-06-18 12:30 PM',
  verified_life_context: { weather: 'High 94F, breezy' } as never,
  tool_results: ['calendar: clear today'],
  unread: [],
};
function fake_runtime(complete: (req: unknown) => Promise<{ content: string }>): SpecialistRuntime {
  return {
    llm: { for_role: () => ({ provider: { complete }, defaults: {} }) },
  } as unknown as SpecialistRuntime;
}
const GOOD_BRIEF =
  '```json\n' +
  JSON.stringify({
    morning_brief: {
      sections: { noticed: 'Clear afternoon.', attention_today: [], ready_for_review: [], watching: '' },
      mood: 'calm',
    },
  }) +
  '\n```';

console.log('\nguaranteed-brief fallback:');
{
  const runtime = fake_runtime(async () => ({ content: GOOD_BRIEF }));
  const fb = await generate_brief_fallback({ ...base_args, runtime });
  assert(fb, 'fallback returns a brief on good fenced output');
  assert(fb.sections.noticed === 'Clear afternoon.', 'fallback preserves the noticed section');
  assert(fb.mood === 'calm', 'fallback preserves mood');
  ok('good fenced output → brief regenerated');
}
{
  const runtime = fake_runtime(async () => ({ content: 'Sorry, I had nothing to report today.' }));
  assert((await generate_brief_fallback({ ...base_args, runtime })) === null, 'prose → null');
  ok('non-JSON prose reply → null (fail-open)');
}
{
  const runtime = fake_runtime(async () => ({
    content: '```json\n' + JSON.stringify({ summary_for_self: 'x', flags: [] }) + '\n```',
  }));
  assert((await generate_brief_fallback({ ...base_args, runtime })) === null, 'no morning_brief → null');
  ok('valid envelope but no morning_brief → null');
}
{
  const runtime = fake_runtime(async () => {
    throw new Error('endpoint down');
  });
  assert((await generate_brief_fallback({ ...base_args, runtime })) === null, 'complete throw → null');
  ok('LLM endpoint error → null (fail-open)');
}
{
  const runtime = {
    llm: {
      for_role: () => {
        throw new Error('role unresolved');
      },
    },
  } as unknown as SpecialistRuntime;
  assert((await generate_brief_fallback({ ...base_args, runtime })) === null, 'for_role throw → null');
  ok('role unresolved → null (fail-open)');
}

console.log(`\nsmoke:deliberation-envelope — ${passed} checks passed`);
