export {};
/**
 * Companion to flag-beatrice-runtime-affordance.ts (filed earlier on
 * 2026-05-30). Same class of architectural concern — generic fallback
 * instead of mechanism-driven specific labels.
 *
 * Jasper's exact words: "all proposals from hereon out should have
 * option text SPECIFICALLY human language oriented related to the
 * proposal itself, instead of that 'run' and 'dismiss' crap."
 *
 * If Beatrice judges this is the same surface as the runtime-affordance
 * gap, she's welcome to roll them into one binding proposal. If they
 * read as distinct layers (runtime guidance injection vs. proposal
 * render), two proposals is fine. Her call.
 *
 * Run from inside the orchestrator container:
 *
 *   bun run scripts/flag-beatrice-action-labels.ts
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
    `\`tool-description-gap\`, subject: \`proposal_render:action_labels\`.\n\n` +
    `**Jasper's verbatim words:**\n\n` +
    `> "all proposals from hereon out should have option text ` +
    `SPECIFICALLY human language oriented related to the proposal ` +
    `itself, instead of that 'run' and 'dismiss' crap."\n\n` +
    `**What went wrong:**\n\n` +
    `Most proposal kinds in \`src/core/proposal_render.ts\` already ` +
    `have kind-specific action labels (book_candidate: "Find a copy" / ` +
    `"Just file the note" / "Skip"; trusted_source_addition: "Add to ` +
    `trusted_sources" / "Add at other tier" / "Reject"; calendar_event: ` +
    `"Add to calendar" / "Edit time" / "Skip"; etc.). Two kinds still ` +
    `ship generic verbs that tell the reader nothing:\n\n` +
    `- **\`action_proposal\`** — the most-common kind specialists file ` +
    `  when they want Jasper to do something specific ("send email X", ` +
    `  "cancel subscription Y", "pay bill Z"). Today the buttons say ` +
    `  **"Run / Modify / Reject"**. The proposal title is already ` +
    `  payload-aware (\`compute_proposal_title\` reads recipient + ` +
    `  messageBody / action_description). The actions should do the ` +
    `  same — synthesize "Send the email" / "Cancel the subscription" / ` +
    `  "Pay $89 to ConEd" from the payload instead of "Run".\n` +
    `- **\`draft_message\`** — falls through to \`DEFAULT_ACTIONS\` which ` +
    `  is **"Approve / Deny"**. Should read recipient + body to produce ` +
    `  "Send to Sarah" / "Edit before sending" / "Drop it."\n\n` +
    `**The deeper structural issue:**\n\n` +
    `\`DEFAULT_ACTIONS\` exists as a fallback in \`default_actions_for_kind()\` ` +
    `(the switch statement's \`default\` arm). That's a load-bearing ` +
    `fallback — it means any new proposal kind shipped without its own ` +
    `action set quietly inherits "Approve / Deny" without anyone ` +
    `noticing. Same shape of bug as the runtime-affordance one I flagged ` +
    `you about earlier today: a generic fallback masking a per-kind ` +
    `carve-out gap.\n\n` +
    `**What I'd like you to ship:**\n\n` +
    `Three things, in one binding proposal (or rolled into the ` +
    `runtime-affordance proposal if you judge them the same layer):\n\n` +
    `1. **Make \`action_proposal\` labels payload-aware.** ` +
    `\`actions_for_kind\` (in \`src/core/proposal_render.ts\`) should ` +
    `accept the payload, and the \`action_proposal\` arm should ` +
    `synthesize the primary-action label from \`payload.action_description\` / ` +
    `\`payload.recipient\` / \`payload.body_md\` — same pattern as ` +
    `\`compute_proposal_title\` already does. Modify becomes ` +
    `"Edit before running" / "Edit before sending" depending on shape.\n\n` +
    `2. **Same for \`draft_message\`** — kind needs its own action arm, ` +
    `synthesized from \`payload.recipient\` + \`payload.body_md\`. ` +
    `Stop falling through to DEFAULT_ACTIONS.\n\n` +
    `3. **Make \`DEFAULT_ACTIONS\` a logged warning, not a silent ` +
    `fallback.** When the switch falls through, log a warning naming ` +
    `the kind so future new-kind ships don't silently inherit ` +
    `"Approve / Deny." Treat the fallback as a "fix me" signal, not a ` +
    `legitimate render path. Same shape as the runtime-affordance ` +
    `injection — structural mechanism, not opt-in carve-out.\n\n` +
    `**Existing proposals get the fix for free:** Actions aren't ` +
    `stored on proposal rows — they're computed at render time. So ` +
    `the moment your code lands, every existing proposal in the queue ` +
    `(including the backlog) immediately gets the new labels. No ` +
    `migration.\n\n` +
    `**Companion to your other open structural flag:**\n\n` +
    `The runtime-affordance-gap I flagged you about earlier today ` +
    `(inbox id from the same script — query ` +
    `\`SELECT id FROM specialist_inbox WHERE to_specialist_id='trainer' ` +
    `AND kind='flag' ORDER BY ts_created DESC LIMIT 5\`) is the same ` +
    `class of architectural concern — generic fallback instead of ` +
    `mechanism-driven specific behavior. If you judge these are the ` +
    `same surface and want to ship one binding proposal covering both, ` +
    `that's fine. If they read as distinct layers (runtime guidance ` +
    `injection vs. proposal render labels), two proposals is also fine. ` +
    `Your call. Either way, the user's verbatim ask deserves to be ` +
    `quoted in the proposal you ship — it's the cleanest motivator for ` +
    `why the load-bearing fallback is the wrong shape.`;

  const inbox_id = inbox.push({
    from_specialist_id: 'orchestrator',
    to_specialist_id: 'trainer',
    kind: 'flag',
    body_md,
  });

  console.log(`Flagged Beatrice — inbox id: ${inbox_id}`);
  console.log(`Companion to the runtime-affordance flag from earlier.`);
}

void main();
