/**
 * smoke:fabricated-save — the SEMANTIC fabricated-save guard (the LLM-judge
 * backstop for "Noted — X is Y" / "her phone is recorded" save-claims the strict
 * regex misses). Pure-function + a mock planner judge; no live model.
 *
 *   bun run scripts/smoke-fabricated-save.ts
 */
import {
  looks_like_save_claim,
  assess_fabricated_save,
  fabricated_save_retry_nudge,
  fabricated_save_semantic_enabled,
} from '@core/fabricated_save';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); }
}

// Minimal LLMRouter mock: for_role().provider.complete() → { content }.
function mockLLM(content: string): never | any {
  return {
    for_role: () => ({
      provider: {
        complete: async () => {
          if (content === 'THROW') throw new Error('judge down');
          return { content };
        },
      },
      defaults: {},
    }),
  };
}

async function main(): Promise<void> {
  console.log('\n1. looks_like_save_claim — Layer 1 high-recall gate (the live misses)');
  check('the Ceci miss "Noted — birthday is April 16" matches', looks_like_save_claim("Noted — Ceci's birthday is April 16, 1994."));
  check('"her phone number is recorded" matches', looks_like_save_claim("Got it — Ceci's phone number is recorded."));
  check('"all set — … are recorded" matches', looks_like_save_claim('All set — Ceci\'s email and address are recorded.'));
  check('"that\'s in her record now" matches (IN_RECORD)', looks_like_save_claim("Okay, that's in her record now."));
  check('a plain ack does NOT match', !looks_like_save_claim("Got it, what's next?"));
  check('a question does NOT match', !looks_like_save_claim("How's your evening going?"));
  check('empty → false', !looks_like_save_claim(''));

  console.log('\n2. assess_fabricated_save — Layer 2 judge + fail-open matrix');
  const r1 = await assess_fabricated_save({ reply: "Noted — Ceci's birthday is April 16.", ledger: '(none)', llm: mockLLM('{"fabricated": true, "item": "Ceci\'s birthday"}') });
  check('judge says fabricated → fabricated:true + item', r1.checked && r1.fabricated && /birthday/.test(r1.item));
  const r2 = await assess_fabricated_save({ reply: "I noted your concern, I'll look into it.", ledger: '(none)', llm: mockLLM('{"fabricated": false, "item": ""}') });
  check('judge says not-fabricated → fabricated:false', r2.checked && !r2.fabricated);
  const r3 = await assess_fabricated_save({ reply: "How's your evening?", ledger: '(none)', llm: mockLLM('{"fabricated": true}') });
  check('no save-claim → judge NOT called (checked:false)', !r3.checked && !r3.fabricated);
  const r4 = await assess_fabricated_save({ reply: 'Noted — her email is x@y.com.', ledger: '(none)', llm: mockLLM('THROW') });
  check('judge throws → FAIL-OPEN (fabricated:false)', r4.checked && !r4.fabricated);
  const r5 = await assess_fabricated_save({ reply: 'Noted — her email is x@y.com.', ledger: '(none)', llm: mockLLM('not json at all') });
  check('unparseable → fail-open false', r5.checked && !r5.fabricated);
  const r6 = await assess_fabricated_save({ reply: 'Noted — her email.', ledger: '(none)', llm: undefined });
  check('no llm → checked:false (fail-open, no call)', !r6.checked && !r6.fabricated);

  console.log('\n3. nudge contract + kill switch');
  const nudge = fabricated_save_retry_nudge("Ceci's birthday");
  check('nudge names the guard + record_person_pref + the item', /FABRICATED-SAVE GUARD/.test(nudge) && /record_person_pref/.test(nudge) && /Ceci/.test(nudge));
  check('nudge forbids meta-narration (no apology / never mention)', /no apology/.test(nudge) && /never mention/.test(nudge));
  const prev = process.env.HEARTH_FABRICATED_SAVE_SEMANTIC;
  process.env.HEARTH_FABRICATED_SAVE_SEMANTIC = '0';
  check('kill switch HEARTH_FABRICATED_SAVE_SEMANTIC=0 disables', !fabricated_save_semantic_enabled());
  delete process.env.HEARTH_FABRICATED_SAVE_SEMANTIC;
  check('default ON', fabricated_save_semantic_enabled());
  if (prev !== undefined) process.env.HEARTH_FABRICATED_SAVE_SEMANTIC = prev;

  console.log(`\n${fail === 0 ? '✓' : '✗'} fabricated-save: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main();
