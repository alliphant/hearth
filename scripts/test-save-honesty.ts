/**
 * smoke:save-honesty — the save-honesty guard (2026-06-22).
 *
 * The durable fix for a trust failure Jasper hit repeatedly: a person-write
 * tool is CALLED and FAILS, but the reply still confirms a completed save
 * ("Got it, I've noted it"). The complement of the fabricated-save guard
 * (which fires when NO write ran at all): here the model DID reach for the
 * tool, it didn't land, no other durable write backs the claim, and the reply
 * hides the failure. Pure-function precision test — no LLM, no live runtime.
 * The end-to-end "passes only because the guard fires" proof lives in
 * smoke:evals (scripted model + kill switch).
 */
import { _detect_failed_save } from '../src/core/specialist_runtime';
import type { ToolRegistry } from '../src/core/tool_registry';

// Minimal registry stub: the detector consults `.get(name).risk` to decide
// which calls are write-tier. Person writes are write_internal; the reads are
// read-tier (so a failed read never counts as a failed WRITE).
const tools = {
  get(name: string) {
    if (
      name === 'upsert_person_note' ||
      name === 'find_or_create_person' ||
      name === 'record_decision'
    ) {
      return { risk: 'write_internal' } as { risk: string };
    }
    if (name === 'search_library' || name === 'read_note' || name === 'web_fetch_clean') {
      return { risk: 'read' } as { risk: string };
    }
    return undefined;
  },
} as unknown as ToolRegistry;

type Call = { name: string; error?: string; result?: unknown };
// The detector reads name + error + result off each call.
const calls = (...cs: Call[]) => cs as unknown as Parameters<typeof _detect_failed_save>[1];

let checks = 0;
function check(name: string, ok: boolean): void {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) process.exitCode = 1;
}

function fires(text: string, cs: Call[]): boolean {
  return _detect_failed_save(text, calls(...cs), tools) !== null;
}

const SAVE_CLAIM = "Got it — I've noted Dr. Alba Moreno as your dermatologist in your records.";

function main(): void {
  // ── FIRES: save-claim + an attempted write that FAILED, nothing landed ──
  check(
    'hard-errored write (c.error: thrown/validation) + save-claim fires',
    fires(SAVE_CLAIM, [
      { name: 'upsert_person_note', error: "Patch didn't fit the person-record schema" },
    ]),
  );
  check(
    'SOFT {error} result on a write + save-claim fires (the gap _had_durable_write missed)',
    fires(SAVE_CLAIM, [
      { name: 'upsert_person_note', result: { error: 'write failed: People/ read-only' } },
    ]),
  );
  check(
    'DUPLICATE_TOOL_CALL on a write (c.error) + save-claim fires',
    fires("I've saved that to her note.", [
      { name: 'find_or_create_person', error: 'DUPLICATE_TOOL_CALL: you already called…' },
    ]),
  );
  check(
    'all writes failed (hard + soft) + save-claim fires',
    fires("I've recorded it to your vault.", [
      { name: 'find_or_create_person', error: 'INPUT_VALIDATION_FAILED' },
      { name: 'upsert_person_note', result: { error: 'no person to patch' } },
    ]),
  );
  check(
    'a failed write alongside a successful READ still fires (the read is not a save)',
    fires("I've updated her record.", [
      { name: 'search_library', result: { hits: [] } },
      { name: 'upsert_person_note', error: 'boom' },
    ]),
  );

  // ── DOES NOT FIRE: a real durable write landed → the claim is honest ────
  check(
    'a successful write + save-claim does NOT fire',
    !fires(SAVE_CLAIM, [{ name: 'upsert_person_note', result: { id: 'p_abc123', note_path: 'People/x.md' } }]),
  );
  check(
    'mixed: one write failed but another SUCCEEDED → does NOT fire (claim backed)',
    !fires("I've added her and noted the follow-up.", [
      { name: 'find_or_create_person', error: 'transient' },
      { name: 'upsert_person_note', result: { id: 'p_abc123', note_path: 'People/x.md' } },
    ]),
  );

  // ── DOES NOT FIRE: no write was even ATTEMPTED → fabricated-save's job ───
  check(
    'save-claim with NO tool calls does NOT fire here (fabricated-save handles it)',
    !fires(SAVE_CLAIM, []),
  );
  check(
    'save-claim with only a FAILED READ does NOT fire here (read-failure guard\'s job)',
    !fires("I've noted it to your file.", [
      { name: 'web_fetch_clean', result: { error: '404', candidates: [] } },
    ]),
  );

  // ── DOES NOT FIRE: no save-claim, or the reply already owns the failure ─
  check(
    'a plain answer with no save-claim does NOT fire even with a failed write',
    !fires('Sure — Dr. Moreno is a dermatologist on Ashgrove.', [
      { name: 'upsert_person_note', error: 'boom' },
    ]),
  );
  check(
    'an honest "the save did not go through" admission does NOT fire',
    !fires("I couldn't save that — the write failed. Want me to try again?", [
      { name: 'upsert_person_note', error: 'boom' },
    ]),
  );
  check(
    'empty reply does NOT fire',
    !fires('', [{ name: 'upsert_person_note', error: 'boom' }]),
  );

  // ── The nudge is an internal, actionable retry instruction ──────────────
  const nudge = _detect_failed_save(
    SAVE_CLAIM,
    calls({ name: 'upsert_person_note', error: 'boom' }),
    tools,
  );
  check('nudge names the failed tool + frames it as internal', Boolean(nudge && nudge.includes('upsert_person_note') && nudge.includes('SAVE-HONESTY GUARD')));
  check('nudge steers to fix-or-admit, never claim success', Boolean(nudge && /never report a failed write as done/i.test(nudge)));

  if (process.exitCode === 1) {
    console.log('\nsmoke:save-honesty FAILED');
    process.exit(1);
  }
  console.log(`\n✓ smoke:save-honesty — ${checks} checks passed`);
}

main();
