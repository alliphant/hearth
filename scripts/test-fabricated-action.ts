/**
 * smoke:fabricated-action — the fabricated-action guard (2026-06-16).
 *
 * The structural answer to "prose wins over calling tools": a reply that
 * CLAIMS a completed peer/external action ("I've flagged Beatrice",
 * "Message sent to Kim", "Mariah will audit my tool usage") while NO tool
 * performed it gets a one-retry nudge. Pure-function precision test — no
 * LLM, no live runtime. Mirrors the Kate spiral that motivated it.
 */
import { _detect_fabricated_action } from '../src/core/specialist_runtime';
import { SpecialistRegistry } from '../src/core/specialist';
import { load_extra_capabilities } from '../src/core/capabilities';
import { all_persona_names } from '../src/core/staff_roster';
import { resolve } from 'node:path';
import type { ToolRegistry } from '../src/core/tool_registry';

// Minimal registry stub: only `.get(name).risk` is consulted, and only for
// tool names the detector doesn't enumerate. The guard's enumerated set
// (flag_*, consult_specialist, present_questions, promise_followup) needs no
// registry lookup, so a registry that knows draft_message as write_internal
// is enough to exercise the risk-tier branch too.
const tools = {
  get(name: string) {
    if (name === 'draft_message') return { risk: 'write_internal' } as { risk: string };
    if (name === 'search_library' || name === 'read_note') return { risk: 'read' } as { risk: string };
    return undefined;
  },
} as unknown as ToolRegistry;

type Call = { name: string; error?: string };
// The detector reads only `name` + `error` off each call here.
const calls = (...cs: Call[]) => cs as unknown as Parameters<typeof _detect_fabricated_action>[1];

let checks = 0;
function check(name: string, ok: boolean): void {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) process.exitCode = 1;
}

/**
 * Persona names for the attribution pattern. Read from the LIVE registry
 * (2026-08-03) rather than assumed: the detector's name list used to be a
 * hardcoded alternation inside the module, which had rotted in both directions
 * — it still listed four retired personas and had no entry for Vera. Passing
 * the derived set here means this smoke exercises the same path production
 * does, and a fold is covered the moment the YAML changes.
 */
load_extra_capabilities(
  resolve(import.meta.dir, '..', process.env.HEARTH_CAPABILITIES_PATH ?? 'config/capabilities.yaml'),
);
const PERSONA_NAMES = all_persona_names(
  new SpecialistRegistry(resolve(import.meta.dir, '..', 'config/specialists')).list(),
);

function fires(text: string, cs: Call[]): boolean {
  return _detect_fabricated_action(text, calls(...cs), tools, PERSONA_NAMES) !== null;
}

function main(): void {
  // ── FIRES: completed-action claim, no backing tool call ───────────────
  check(
    "'I've flagged this to Beatrice' with zero tool calls fires",
    fires("You're right. I've flagged this to Beatrice as a structural fix.", []),
  );
  check(
    "'Message sent to Kim' with zero tool calls fires",
    fires('Message sent to Kim. Back to you — anything else?', []),
  );
  check(
    "'I've delegated it' fires",
    fires("I've delegated the listing follow-up to Linda.", []),
  );
  check(
    "'Mariah will audit my tool usage' (peer-acting claim) fires",
    fires("I've noted the issue. Mariah will audit my recent tool calls for slips.", []),
  );
  check(
    "'I've escalated it' fires with only a READ tool this turn",
    fires("I've escalated this to the team.", [{ name: 'search_library' }]),
  );
  check(
    'an ERRORED flag does not count — the claim still fires',
    fires("I've flagged Beatrice on the prose-over-tools pattern.", [
      { name: 'flag_beatrice', error: 'INPUT_VALIDATION_FAILED' },
    ]),
  );

  // ── DOES NOT FIRE: a real backing action landed ───────────────────────
  check(
    "'I've flagged Beatrice' is honest when flag_beatrice fired",
    !fires("I've flagged Beatrice on the prose-over-tools pattern.", [{ name: 'flag_beatrice' }]),
  );
  check(
    "'I've asked Linda' is honest when consult_specialist fired",
    !fires("I've asked Linda for the comps and she's pulling them now.", [
      { name: 'consult_specialist' },
    ]),
  );
  check(
    "'queued a draft' is honest when draft_message fired (write-tier)",
    !fires('Draft queued for your review — tap Send when ready.', [{ name: 'draft_message' }]),
  );

  // ── DOES NOT FIRE: no action claim, or honest failure admission ───────
  check(
    'a plain answer with no action claim does not fire',
    !fires('The weather this week is dry with highs near 80°F.', []),
  );
  check(
    'an honest "I tried but couldn\'t" admission does not fire',
    !fires("I tried but couldn't get my tool calls to land cleanly. Try again.", []),
  );

  if (process.exitCode === 1) {
    console.log('\nsmoke:fabricated-action FAILED');
    process.exit(1);
  }
  console.log(`\n✓ smoke:fabricated-action — ${checks} checks passed`);
}

main();
