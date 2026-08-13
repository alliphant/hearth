export {};
/**
 * One-shot script to file a high-severity flag to Beatrice naming
 * the runtime-affordance-gap class as a structural problem
 * (2026-05-30).
 *
 * Filed BY HAND on Jasper's behalf because the closed-loop pattern
 * normally waits for N≥3 recurrence before Beatrice's pattern scan
 * fires — but the gap is structural-by-shape already (the
 * specialist-roster has 6+ research-heavy specialists: Maggie,
 * Cordelia, Vivian, Ruby, Mariah, Beatrice herself; the future
 * Doctor will be a seventh). N=1 is just confirmation. Beatrice
 * shouldn't have to wait for two more Vivians.
 *
 * The wire underneath (commit landing alongside this script):
 * `_file_runtime_affordance_miss()` in specialist_runtime.ts now
 * files a `runtime-affordance-gap` process_miss on every tool-
 * round-ceiling exhaustion, so when Beatrice DOES diagnose, the
 * audit trail is queryable.
 *
 * Run from inside the orchestrator container:
 *
 *   bun run scripts/flag-beatrice-runtime-affordance.ts
 */

import { open_db } from '@memory/stores/structured';
import { SpecialistInbox } from '@memory/stores/conversations';
import { resolve } from 'node:path';

const DB_PATH = resolve(process.env.HEARTH_DB_PATH ?? './data/hearth.db');

async function main(): Promise<void> {
  const db = open_db(DB_PATH);
  const inbox = new SpecialistInbox(db);

  const body_md =
    `**Structural flag** from orchestrator — suspected class: ` +
    `\`capability-gap\`, subject: \`runtime-affordance:research-efficiency\`.\n\n` +
    `**What went wrong:**\n\n` +
    `Today (2026-05-30) Vivian got equity research capability (SEC EDGAR + ` +
    `FRED + portfolio ops). First real research turn — a multi-leg Dell ` +
    `question — exhausted her 10-round tool ceiling. I patched it ` +
    `tactically by bumping her to 14 + adding a "research efficiency" ` +
    `section to her persona (commit \`10a0473\`). Both of those are ` +
    `carve-outs, exactly the pattern the CLAUDE.md rule prohibits:\n\n` +
    `> "Specific-case carve-outs are a signal you missed the general ` +
    `mechanism."\n\n` +
    `**Why this is a structural gap, not a Vivian gap:**\n\n` +
    `The research-efficiency lessons I baked into her persona apply ` +
    `verbatim to every research-heavy specialist in the roster:\n\n` +
    `- **Maggie** — concert/artist recon, already at \`max_tool_rounds: 14\`\n` +
    `- **Cordelia** — deep catalog research + curate_for_specialist drives ` +
    `  further fan-out\n` +
    `- **Mariah** — scan_program_patterns reads many audit rows\n` +
    `- **Ruby** — council/civic deep dives, Sunday 10:00 corpus build\n` +
    `- **Vivian** — equity research (this incident)\n` +
    `- **You (Beatrice)** — analyze_systemic_pattern + propose_code_change ` +
    `  pull codebase context\n` +
    `- **Future Doctor** — differential diagnosis research is the same ` +
    `  workload shape\n\n` +
    `Every one of these specialists needs the same five behaviors:\n` +
    `1. Plan tool calls before firing (avoid "let me search again to be sure")\n` +
    `2. Fan out in parallel where possible (same-ticker different-form-type ` +
    `   EDGAR queries; multi-series FRED observations; multi-shelf ` +
    `   search_library; siblings of the same audit query)\n` +
    `3. Don't re-fetch documents already in turn context\n` +
    `4. Cap scope when the question is broad\n` +
    `5. On exhaust, surface what couldn't confirm rather than truncating\n\n` +
    `**What I'd like you to ship:**\n\n` +
    `A \`proactive.research_workload: true\` archetype flag on the ` +
    `SpecialistConfig schema. When set, the runtime auto-injects research-` +
    `efficiency guidance at turn-start (same pattern as \`CHAT_BASE_TOOLSET\` ` +
    `ensuring the knowledge floor — guidance is structural, not opt-in). ` +
    `Once that lands, the Vivian persona text (commit \`10a0473\` "Research ` +
    `efficiency — don't burn rounds") becomes superseded and should be ` +
    `removed; same for any equivalent text in Maggie's persona.\n\n` +
    `**Detection layer already wired (same commit):**\n\n` +
    `\`_file_runtime_affordance_miss()\` in specialist_runtime.ts now files ` +
    `a \`runtime-affordance-gap\` process_miss on every tool-round-ceiling ` +
    `exhaustion. You can query \`process_misses WHERE gap LIKE ` +
    `'%runtime-affordance-gap%'\` to see recurrence as it accumulates. ` +
    `Today: N=1 (Vivian). Don't wait for N≥3 — the roster shape implies ` +
    `the gap regardless. Use the wire as your validation, not your trigger.\n\n` +
    `Diagnose the fix layer (capability-gap → runtime affordance, per the ` +
    `the private dev log "fix at the layer that owns the problem" principle) and ` +
    `ship a binding_proposal. After it lands, run a sweep that removes the ` +
    `now-redundant per-persona research-efficiency text from Vivian's YAML.`;

  const inbox_id = inbox.push({
    from_specialist_id: 'orchestrator',
    to_specialist_id: 'trainer',
    kind: 'flag',
    body_md,
  });

  console.log(`Flagged Beatrice — inbox id: ${inbox_id}`);
  console.log(`She wakes on the next loop tick (inbox-flag wake_on_flag).`);
}

void main();
