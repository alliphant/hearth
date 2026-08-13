/**
 * On-hire knowledge bootstrap.
 *
 * Fires once per newly-discovered specialist (see
 * `SpecialistRegistry.on_specialist_added`). Pushes a high-severity
 * `flag` from `orchestrator` to `cordelia` carrying 3–5 focus areas
 * derived from the new specialist's role + persona. Cordelia's
 * wake-on-flag debounce picks the flag up and her next deliberation
 * routes each focus area through `curate_for_specialist` against
 * whatever `trusted_sources` manifest the new hire arrived with,
 * filing Tier-1 hits straight onto their library shelf and Tier-3
 * candidates as `trusted_source_addition` proposals.
 *
 * History — why this lives at registry level rather than inline in a
 * hire route:
 *
 *   1. `POST /api/specialists` (modal hire) and `POST /api/specialists
 *      /from-packet` (agentic hire) both call `materialize_specialist`
 *      which writes the YAML and reloads the registry. Inlining the
 *      bootstrap in `/from-packet` (the original 2026-05-30 shape)
 *      left the modal path silent.
 *
 *   2. A specialist can also land via direct YAML write — a human or
 *      Claude session drops `config/specialists/<id>.yaml` directly
 *      and chokidar reloads. This is how Ruby (Pleasantville Civic
 *      Correspondent) arrived on 2026-05-30, which is what surfaced
 *      this gap: she landed with a complete `trusted_sources`
 *      manifest, 12 empty `Knowledge/Pleasantville/` topic dirs, and no
 *      Cordelia kick — her first deliberation pass at 05:29 MDT ran
 *      against zero curated context until a follow-up Claude session
 *      manually injected the bootstrap flags 8 hours later.
 *
 *   3. Future hire paths (a git pull from a teammate, a CLI tool, a
 *      schedulable spec-gen) all funnel through the same registry
 *      reload. Hooking at the registry level means they all bootstrap
 *      automatically.
 *
 * Idempotency: a guard query against `audit_log` ensures we don't
 * re-fire across orchestrator restarts (the constructor reload looks
 * like every existing specialist "just appeared" to the diff).
 */

import type { SpecialistRegistry } from './specialist';
import type { AppEventBus } from '@app/events';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { MemoryClient } from '@memory/client';
import { ulid } from 'ulid';

export interface BootstrapDeps {
  specialists: SpecialistRegistry;
  inbox: SpecialistInbox;
  events?: AppEventBus;
  memory: MemoryClient;
}

// Idempotency lives in SpecialistRegistry: the constructor's initial
// reload suppresses added-listeners (so cold start doesn't re-fire for
// every existing specialist), and an in-memory `added_fired_for` set
// dedupes within a single process lifetime. Across orchestrator
// restarts a hire that lands mid-restart could theoretically miss its
// bootstrap window — that's accepted; Cordelia's 04:00 nightly pass
// catches under-stocked shelves regardless, so the worst-case is a
// few hours of delayed enrichment rather than a permanent gap.

/**
 * Derive 3–5 focus areas for Cordelia's on-hire bootstrap pass from a
 * new specialist's role + persona. Strategy:
 *   1. The role as a bare focus area ("fundamentals of <role>").
 *   2. A "current evidence-based practice" anchor that pins the
 *      curation to authoritative + not-decade-stale sources.
 *   3. The persona's opening sentence (Kate's `propose_hire` reliably
 *      writes "You are X. You do Y." there), capped at 180 chars so a
 *      runaway persona doesn't blow the focus-area budget.
 *   4. A "common reference questions" anchor that produces concrete
 *      URLs (FAQ pages, professional-body resource hubs, overview
 *      articles).
 *
 * Deliberately simple — Cordelia (and Beatrice via follow-up scans)
 * refine over time.
 */
export function derive_hire_bootstrap_focus(
  role: string,
  persona: string,
): string[] {
  const focus: string[] = [];
  const clean_role = role.trim().toLowerCase();
  focus.push(`fundamentals of ${clean_role}`);
  focus.push(`current evidence-based practice in ${clean_role}`);
  const opening = persona
    .replace(/\{\{[^}]+\}\}/g, '') // drop template placeholders
    .split(/[.!?]\s/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20)[0];
  if (opening && opening.length <= 180) {
    focus.push(opening);
  }
  focus.push(`common reference questions a ${clean_role} answers`);
  return focus;
}

/**
 * Fire the on-hire knowledge bootstrap for a newly-discovered
 * specialist. No-op if the specialist isn't loaded (e.g. unlink
 * races) or if the new specialist is cordelia herself (avoid
 * self-flagging — she has no shelf to curate her own canon against).
 */
export function bootstrap_new_specialist(
  specialist_id: string,
  deps: BootstrapDeps,
): void {
  // Cordelia bootstrapping herself would loop — she'd flag her own
  // inbox to enrich her own canon. Skip.
  if (specialist_id === 'cordelia') return;
  const spec = deps.specialists.get(specialist_id);
  if (!spec) return;

  const focus_areas = derive_hire_bootstrap_focus(spec.role, spec.persona);
  const capitalized =
    specialist_id.charAt(0).toUpperCase() + specialist_id.slice(1);
  const body_md =
    `**Knowledge gap** flagged by orchestrator — target shelf: ` +
    `\`${spec.id}\`, severity: \`high\`.\n\n` +
    `**Context:**\nNew hire \`${spec.name}\` (${spec.role}) just landed ` +
    `in the registry. Their shelf at ` +
    `\`Knowledge/${capitalized}/library/\` is empty. Bootstrap ` +
    `evidence-backed content from their persona's domain so they ` +
    `don't fabricate their first conversation.\n\n` +
    `**Focus areas for the curate pass:**\n` +
    focus_areas.map((f) => `- \`${f}\``).join('\n') +
    `\n\nRun \`curate_for_specialist\` against \`${spec.id}\`'s ` +
    `\`trusted_sources\` for these focus areas in your next ` +
    `deliberation pass.`;

  const inbox_id = deps.inbox.push({
    from_specialist_id: 'orchestrator',
    to_specialist_id: 'cordelia',
    kind: 'flag',
    body_md,
  });
  deps.events?.emit({
    type: 'inbox_message_added',
    message_id: inbox_id,
    from_specialist_id: 'orchestrator',
    to_specialist_id: 'cordelia',
    kind: 'flag',
    severity: 'high',
  });
  deps.memory.log_action({
    intent_id: ulid(),
    agent: 'orchestrator',
    tool_name: 'on_hire_knowledge_bootstrap',
    tool_input: {
      new_specialist_id: spec.id,
      role: spec.role,
      focus_areas,
      trigger: 'registry_added_listener',
    },
    execution_result: {
      cordelia_inbox_message_id: inbox_id,
    },
  });
  console.log(
    `[specialist_bootstrap] fired for ${spec.id} (${focus_areas.length} focus areas) → cordelia inbox ${inbox_id}`,
  );
}
