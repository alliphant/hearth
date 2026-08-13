/**
 * Self-contained test for the narrative guard opt-out (`narrative: true`).
 *
 * No LLM, no DB, no server. Drives the pure re-roll-budget policy
 * (content_reroll_budget in src/core/specialist_runtime.ts) plus the real
 * persona YAML loader, because the two failure modes this guards against are
 * a policy inversion and a persona that silently loses the flag.
 *
 * The case it exists for (2026-07-27): Mariah's chat surface carries roleplay
 * as well as PM work. Every finalize guard checks a reply's specifics against
 * evidence retrieved THIS turn — invented narrative has none by construction,
 * so ghost-promise matched present-tense narration (26 fires over 07-13..27,
 * nothing factual in any of them) and the fact critic flagged in-fiction nouns
 * as fabrications (30 fires: `named_entity:Chief of Staff`). Because she also
 * sets `proactive.research_workload: true` her chat streams LIVE, so each
 * re-roll superseded a visible draft and re-typed it in front of the user.
 *
 * The load-bearing assertion is the CHAT-ONLY scope: suppressing a narrative
 * specialist's deliberation guards would silently un-guard the stuck-work
 * ledger and process-miss reporting, which are real assertions about real
 * state. If someone later "simplifies" the mode check away, this fails.
 *
 *   bun run smoke:narrative-guards
 */

import { content_reroll_budget, tool_channel_reroll_budget } from '@core/specialist_runtime';
import { load_specialist_file } from '@core/specialist';
import { load_extra_capabilities } from '@core/capabilities';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// Personas grant capabilities declared in config/capabilities.yaml, not just
// the built-in set — load them or the real loader rejects half the roster.
load_extra_capabilities(join(import.meta.dir, '..', 'config', 'capabilities.yaml'));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assert: ${message}`);
}

let checks = 0;
function ok(label: string): void {
  checks++;
  console.log(`  ✓ ${label}`);
}

const SPECIALIST_DIR = join(import.meta.dir, '..', 'config', 'specialists');

/** Load through the REAL loader, so a schema/loader regression fails here. */
function load_specialist(id: string) {
  return load_specialist_file(join(SPECIALIST_DIR, `${id}.yaml`));
}

function main(): void {
  const prior = process.env.HEARTH_MAX_REROLLS_PER_TURN;
  delete process.env.HEARTH_MAX_REROLLS_PER_TURN; // exercise the default (1)

  try {
    // ── 1. The policy ────────────────────────────────────────────────────
    assert(
      content_reroll_budget('conversation', false) === 1,
      'an ordinary chat turn keeps the default budget of 1',
    );
    assert(
      content_reroll_budget('deliberation', false) === 1,
      'an ordinary deliberation turn keeps the default budget of 1',
    );
    ok('non-narrative turns keep the default re-roll budget');

    assert(
      content_reroll_budget('conversation', true) === 0,
      'a NARRATIVE chat turn must get zero re-rolls (the whole point)',
    );
    ok('narrative chat is suppressed');

    // THE load-bearing one. Narrative is a CHAT-surface property; a narrative
    // specialist's deliberation still files process misses and stuck-work
    // findings, and those are real assertions that must stay guarded.
    assert(
      content_reroll_budget('deliberation', true) === 1,
      'a narrative specialist must KEEP its deliberation guards',
    );
    ok('narrative does NOT leak into deliberation');

    // Voice was already zero for the same structural reason; narrative must
    // not have disturbed it in either direction.
    assert(content_reroll_budget('voice', false) === 0, 'voice stays at zero');
    assert(content_reroll_budget('voice', true) === 0, 'narrative voice stays at zero');
    ok('voice remains suppressed regardless of narrative');

    // ── 2. The env override still reaches the un-suppressed paths ────────
    process.env.HEARTH_MAX_REROLLS_PER_TURN = '2';
    assert(
      content_reroll_budget('conversation', false) === 2,
      'HEARTH_MAX_REROLLS_PER_TURN must still raise a normal chat turn',
    );
    assert(
      content_reroll_budget('conversation', true) === 0,
      'the env override must NOT resurrect guards on a narrative chat turn',
    );
    process.env.HEARTH_MAX_REROLLS_PER_TURN = '0';
    assert(
      content_reroll_budget('deliberation', false) === 0,
      'HEARTH_MAX_REROLLS_PER_TURN=0 must still disable everything globally',
    );
    ok('env override composes correctly with the structural zeroes');

    // ── 3. Tool-channel guards are NOT narrative-suppressed ──────────────
    // The narrative zero exists because the content guards check prose
    // against retrieved evidence. The tool-channel guards check a minted
    // filename / registered tool name against the turn's actual calls, which
    // fiction cannot fake — and the miss they catch ("the tool call fires"
    // with an empty tool channel) is a false claim about machine state, not
    // storytelling. Mariah was immune to all three before this split.
    delete process.env.HEARTH_MAX_REROLLS_PER_TURN;
    assert(
      tool_channel_reroll_budget('conversation') === 1,
      'a narrative chat turn must STILL get its tool-channel guards',
    );
    assert(
      tool_channel_reroll_budget('deliberation') === 1,
      'deliberation keeps the tool-channel guards',
    );
    assert(
      tool_channel_reroll_budget('voice') === 0,
      'voice stays suppressed — a mid-speech rewrite is worse than the miss',
    );
    process.env.HEARTH_MAX_REROLLS_PER_TURN = '0';
    assert(
      tool_channel_reroll_budget('conversation') === 0,
      'the global kill switch must still disable the tool-channel guards',
    );
    ok('tool-channel guards survive narrative but respect voice + kill switch');
  } finally {
    if (prior === undefined) delete process.env.HEARTH_MAX_REROLLS_PER_TURN;
    else process.env.HEARTH_MAX_REROLLS_PER_TURN = prior;
  }

  // ── 3. The persona actually carries the flag ──────────────────────────
  const mariah = load_specialist('mariah');
  assert(mariah.narrative === true, 'mariah.yaml must set narrative: true');
  ok('mariah.yaml carries narrative: true');

  // ── 4. Backward compatibility — nobody else changed ───────────────────
  const others = readdirSync(SPECIALIST_DIR)
    .filter((f) => f.endsWith('.yaml') && f !== 'mariah.yaml')
    .map((f) => f.replace(/\.yaml$/, ''));
  assert(others.length > 0, 'expected other specialist personas to exist');
  for (const id of others) {
    const s = load_specialist(id);
    assert(
      s.narrative === false,
      `${id} must default to narrative: false (guards unchanged)`,
    );
  }
  ok(`all ${others.length} other specialists default to narrative: false`);

  console.log(`\n✓ NARRATIVE GUARD SMOKE PASSED (${checks} checks)`);
}

main();
