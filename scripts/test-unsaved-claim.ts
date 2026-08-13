/**
 * test:unsaved-claim — the verify-before-claim trust guarantee.
 *
 * The runtime KNOWS whether a write landed (InvokeOutcome + the tool's own
 * output payload). This asserts the model can no longer confirm a save the
 * runtime knows FAILED — the trust-killer class (a person's address/birthday
 * "saved" per the reply but never persisted). Pure-function: drives the
 * exported `_detect_fabricated_save` against a minimal registry, no model.
 *
 * Four cases the guard must distinguish:
 *   1. successful write + save-claim   → no nudge (honest).
 *   2. write ERRORED + save-claim      → UNSAVED-CLAIM nudge naming the tool.
 *   3. write ok at registry but result {saved:false} + claim → UNSAVED-CLAIM
 *      (the SILENT soft-failure gap this build closes).
 *   4. NO write fired + save-claim     → the plain FABRICATED-SAVE no-write nudge.
 */
import { z } from 'zod';
import { ToolRegistry } from '../src/core/tool_registry';
import { _detect_fabricated_save } from '../src/core/specialist_runtime';
import type { Tool } from '../src/core/tool';

let fails = 0;
const check = (label: string, ok: boolean): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) fails++;
};

const reg = new ToolRegistry();
const write_tool: Tool<Record<string, unknown>, unknown> = {
  name: 'upsert_person_note',
  description: 'write probe',
  risk: 'write_internal',
  required_capabilities: [],
  input_schema: z.object({}).passthrough(),
  output_schema: z.any(),
  idempotency_key: () => 'k',
  execute: async () => ({ ok: true }),
};
reg.register(write_tool as Tool);

const CLAIM = "Got it — I've saved that to Sam's contact note.";

// 1. A real, successful write makes the claim honest.
check(
  'successful write + save-claim → no nudge',
  _detect_fabricated_save(
    CLAIM,
    [{ name: 'upsert_person_note', input: {}, result: { ok: true, saved: true } }],
    reg,
  ) === null,
);

// 2. The write threw → registry error → UNSAVED-CLAIM nudge naming the tool.
const n2 = _detect_fabricated_save(
  CLAIM,
  [{ name: 'upsert_person_note', input: {}, error: 'disk full' }],
  reg,
);
check(
  'errored write + claim → UNSAVED-CLAIM nudge naming the tool',
  !!n2 && /UNSAVED-CLAIM/.test(n2) && /upsert_person_note/.test(n2),
);

// 3. The SILENT gap: registry ok (no throw, output validated) but the payload
//    reports it didn't persist. Must still fire.
const n3 = _detect_fabricated_save(
  CLAIM,
  [{ name: 'upsert_person_note', input: {}, result: { ok: false, saved: false, error: 'rejected' } }],
  reg,
);
check(
  'soft-failure result {saved:false} + claim → UNSAVED-CLAIM nudge (the silent gap)',
  !!n3 && /UNSAVED-CLAIM/.test(n3),
);

// 4. No write fired at all → the plain fabricated-save (no-write) message.
const n4 = _detect_fabricated_save(CLAIM, [], reg);
check('no write fired + claim → FABRICATED-SAVE no-write nudge', !!n4 && /FABRICATED-SAVE/.test(n4));

// 5. No save-claim → never nudges (even with a failed write present).
check(
  'no save-claim in the reply → no nudge',
  _detect_fabricated_save(
    'The battery is at 78% right now.',
    [{ name: 'upsert_person_note', input: {}, error: 'x' }],
    reg,
  ) === null,
);

if (fails > 0) {
  console.error(`\n${fails} unsaved-claim assertion(s) FAILED`);
  process.exit(1);
}
console.log('\n✓ test:unsaved-claim — all checks passed');
