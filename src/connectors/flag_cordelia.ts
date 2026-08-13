/**
 * flag_cordelia — fire-and-forget knowledge-gap flag to Cordelia.
 *
 * Parallel to `flag_beatrice` but for knowledge / library gaps rather
 * than structural / persona gaps. Any specialist can call this when
 * mid-turn they hit "I don't have evidence on X and my shelf doesn't
 * cover it." Cordelia wakes off-schedule via the inbox-flag
 * deliberation path and runs `curate_for_specialist` against the
 * caller's shelf with the supplied focus areas.
 *
 * The semantic distinction from `flag_beatrice`:
 *   - Beatrice fixes the SYSTEM (persona drift, missing affordance,
 *     fabrication pattern, wrong tool description).
 *   - Cordelia fills KNOWLEDGE (shelf is thin on a topic the
 *     specialist needs to act on).
 *
 * Use when:
 *   - A specialist starts a turn, runs `search_library`, gets zero
 *     hits or only Tier-2 hits on a load-bearing question, and
 *     decides the right move is curation not fabrication. The
 *     specialist's persona should say "search the shelf first, then
 *     flag Cordelia if it's not there."
 *   - The future Doctor sees a chief-complaint pattern that needs
 *     differential-diagnosis content; flags Cordelia with the
 *     symptom cluster as focus areas.
 *   - Beatrice's daily scan identifies a recurring knowledge gap;
 *     she flags Cordelia rather than filing a persona-tuning
 *     proposal (the gap is in the shelf, not the persona).
 *
 * Don't use for:
 *   - "Look up X for me right now" — that's `web_search` /
 *     `web_fetch_clean` / `consult_specialist`. Cordelia's flag is
 *     for building durable shelf depth, not satisfying the current
 *     turn.
 *   - One-off URL ingest — that's `ingest_to_library` directly via
 *     Cordelia (synchronously, via consult_specialist).
 *
 * Gated by `write_proposals` (same as flag_beatrice — these are
 * fire-and-forget flags that don't fit the action_proposal kind
 * boundary but share the broad "this specialist may write durable
 * cross-specialist signals" posture).
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';

const SeverityEnum = z.enum(['low', 'medium', 'high']);

const InputSchema = z.object({
  /**
   * Free-text description of the gap. "Astrid's shelf returned 0
   * hits on Zone 2 endurance training for ebike-assisted rides" /
   * "Doctor's differential-diagnosis content doesn't cover
   * pediatric photophobia." Cordelia reads this verbatim when
   * deciding which trusted-domains to search.
   */
  gap_context: z.string().min(20).max(2_000),
  /**
   * The actual topics to feed `curate_for_specialist`. Phrased as
   * the user would ("Zone 2 endurance training for adults",
   * "pediatric headache differential diagnosis"), not as search
   * strings. 1-5 items. Cordelia's tool wraps each in a
   * site-scoped query against the target's trusted_sources.
   */
  focus_areas: z.array(z.string().min(3).max(180)).min(1).max(5),
  /**
   * Which specialist's shelf to enrich. Defaults to the caller
   * (the specialist filing the flag); override when one specialist
   * notices a gap for another (Kate spotting that Astrid is thin
   * on a topic, Mariah seeing a pattern across multiple shelves).
   */
  target_specialist_id: z.string().min(1).optional(),
  /**
   * Cordelia's wake-on-flag debounce honors severity. Default
   * 'medium' triggers her next 04:00 pass; bump to 'high' when
   * the caller can't act on the current turn without the content
   * (Doctor in the middle of a symptom workup, Astrid asked a
   * direct evidence question).
   */
  severity: SeverityEnum.default('medium'),
});

const OutputSchema = z.object({
  inbox_message_id: z.string(),
  target_specialist_id: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_flag_cordelia(
  inbox: SpecialistInbox,
  events: AppEventBus | undefined,
): Tool<Input, Output> {
  return {
    name: 'flag_cordelia',
    description:
      "Fire-and-forget knowledge-gap flag to the library curation pass (internal machinery — NOT a colleague; never name it to the user). Use when your shelf is thin or empty on a topic you need evidence for, AND that gap is durable enough to be worth fixing (not a one-shot lookup). The pass wakes off-schedule and runs curate_for_specialist against the target shelf using your focus_areas. `gap_context` is your description of why this matters; `focus_areas` are the topic prompts (1-5 items, phrased as the user would, not as search strings); `target_specialist_id` defaults to you but you can flag for another specialist when you spot their gap; `severity` controls wake-debounce (default 'medium' — the next scheduled pass picks it up). Returns the inbox message id; reply to the user (if relevant) with 'I'll pull deeper sources on X overnight.' Don't wait synchronously.",
    risk: 'write_internal',
    required_capabilities: ['write_proposals'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      // Hash on (target, focus_areas) — same gap re-flagged should
      // collapse, but a different target or different focus areas
      // (the caller refined their thinking) is its own row.
      const h = createHash('sha256');
      h.update(input.target_specialist_id ?? 'self');
      h.update('\n');
      h.update(input.focus_areas.slice().sort().join('|'));
      return `flag_cordelia:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext) {
      const reporter = ctx.specialist_id ?? 'orchestrator';
      const target = input.target_specialist_id ?? reporter;
      const focus_list = input.focus_areas
        .map((f) => `- \`${f}\``)
        .join('\n');
      const body_md =
        `**Knowledge gap** flagged by ${reporter} — target shelf: ` +
        `\`${target}\`, severity: \`${input.severity}\`.\n\n` +
        `**Context:**\n${input.gap_context}\n\n` +
        `**Focus areas for the curate pass:**\n${focus_list}\n\n` +
        `Run \`curate_for_specialist\` against ${target}'s ` +
        `\`trusted_sources\` for these focus areas in your next ` +
        `deliberation pass (or sooner if severity demands). The ` +
        `flagger has already moved on; ship the curation without ` +
        `needing them in the loop.`;

      const inbox_id = inbox.push({
        from_specialist_id: reporter,
        to_specialist_id: 'cordelia',
        kind: 'flag',
        body_md,
      });
      events?.emit({
        type: 'inbox_message_added',
        message_id: inbox_id,
        from_specialist_id: reporter,
        to_specialist_id: 'cordelia',
        kind: 'flag',
        severity: input.severity,
      });
      return { inbox_message_id: inbox_id, target_specialist_id: target };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_flag_cordelia(deps.inbox, deps.events) as Tool;
}
