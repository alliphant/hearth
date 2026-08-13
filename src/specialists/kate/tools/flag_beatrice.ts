/**
 * flag_beatrice — Kate's fire-and-forget structural-feedback flag to
 * the trainer.
 *
 * Why this exists separately from `consult_specialist(trainer, ...)`:
 *
 *   - A `consult_specialist` call runs Beatrice synchronously in
 *     Kate's turn, bound to a ~10-round tool budget. For "how do we
 *     prevent fabrication?" or "Maggie keeps inventing band members
 *     when MusicKit returns empty" — questions that need Beatrice to
 *     scan misses, read connectors, and ship a binding proposal —
 *     that budget is too tight. The audit_log on 2026-05-26 shows
 *     the failure mode: Beatrice burns 10 rounds on `read_codebase_file`
 *     spelunking, returns `blank_turn_fallback`, and Kate reports
 *     "Beatrice could use a more specific prompt to be useful."
 *
 *   - A flag goes into trainer's inbox with `severity: 'high'` and
 *     emits `inbox_message_added`. The orchestrator's wake-on-flag
 *     subscriber forwards that into LoopDriver.wake_deliberation,
 *     so Beatrice wakes off-schedule with her FULL deliberation
 *     tool surface (analyze_systemic_pattern, propose_connector_
 *     recovery_hint, write_binding_proposal, apply_low_risk_fix) and
 *     ships the structural fix in batched-thinking mode rather than
 *     under turn-time pressure.
 *
 * Use when:
 *   - A teammate is failing recurrently in a way that needs a tool/
 *     persona change (e.g. Maggie's MusicKit fabrication pattern).
 *   - Kate herself catches a fabrication and wants the structural
 *     gap fixed at the layer that owns it.
 *   - A tool description steered the model wrong, an affordance is
 *     missing, a connector returns bare errors with no recovery hint.
 *
 * Don't use for:
 *   - One-off "look up X for me" — that's `consult_specialist` on
 *     the right SME (Iris, Brigid, etc.), not Beatrice.
 *   - Asking the user a question — that's `present_questions`.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';

const SuspectedClassEnum = z.enum([
  /** A connector / tool returns `error` with no `candidates` /
   *  `suggestions` recovery hint, and downstream specialists
   *  fabricate after the bare error. */
  'connector-affordance-gap',
  /** A specialist's persona is steering them toward a wrong move
   *  (over-prescribing, silent-on-posture, etc.). */
  'persona-gap',
  /** A tool's description is misleading the LLM into wrong args or
   *  wrong tool choice. */
  'tool-description-gap',
  /** A capability is missing that the specialist's workflow needs. */
  'capability-gap',
  /** Direct UX feedback from Jasper about how a specialist landed
   *  with him (the canonical persona-tuning input). */
  'ux-feedback',
  /** A specialist (often Kate herself) is fabricating facts and the
   *  fix isn't obvious — Beatrice diagnoses the layer. */
  'fabrication-pattern',
  /** Doesn't fit the others; Beatrice diagnoses from the body. */
  'other',
]);

/**
 * The model frequently writes a free-text DESCRIPTION of the issue into this
 * enum field (e.g. "connector/observation handler — the wake reflection's
 * escalate_to_kate payload omits interrupt IDs…") instead of picking a token —
 * 37 INPUT_VALIDATION_FAILED on this one field in 14 days, each an arg-spiral
 * that can burn the whole deliberation turn (the same class as
 * propose_action.rationale). Coerce, don't reject: map an out-of-enum value to
 * the best-matching class by keyword, falling back to 'other'. The full prose
 * is preserved in `what_went_wrong`, which Beatrice reads verbatim and
 * re-diagnoses from — so a coarse class here costs nothing.
 */
function coerce_suspected_class(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const s = v.trim().toLowerCase();
  const VALID = [
    'connector-affordance-gap',
    'persona-gap',
    'tool-description-gap',
    'capability-gap',
    'ux-feedback',
    'fabrication-pattern',
    'other',
  ];
  if (VALID.includes(s)) return s;
  if (/connector|affordance/.test(s)) return 'connector-affordance-gap';
  if (/persona/.test(s)) return 'persona-gap';
  if (/capabilit|permission|grant/.test(s)) return 'capability-gap';
  if (/fabricat|hallucinat|invent|made[ -]?up/.test(s)) return 'fabrication-pattern';
  if (/feedback|\bux\b/.test(s)) return 'ux-feedback';
  if (/tool|description|naming/.test(s)) return 'tool-description-gap';
  return 'other';
}

const InputSchema = z.object({
  /** The structural issue, in Kate's own words. Should name the
   *  specialist or tool involved, what they did or didn't do, and
   *  why it matters. Beatrice reads this verbatim. */
  what_went_wrong: z.string().min(20).max(4_000),
  /** When suspected_class is 'ux-feedback', quote Jasper's exact words
   *  verbatim. Beatrice's propose_persona_tuning prompt requires the
   *  literal user voice — paraphrasing loses signal. Leave empty for
   *  the other classes. */
  verbatim_feedback: z.string().max(4_000).optional(),
  /** Which specialist or tool the gap centers on. `id` for a
   *  specialist (e.g. 'maggie'), or `tool:<name>` for a tool
   *  (e.g. 'tool:music_top_artists'). Beatrice routes to the right
   *  fix workflow based on this. OPTIONAL: the model routinely omits it and
   *  dumps everything into `what_went_wrong`; rather than arg-spiral on a
   *  missing required field, default to 'unspecified' and let Beatrice infer
   *  the subject from the body she reads verbatim (audit 2026-06-22). */
  subject: z.string().min(1).max(120).optional(),
  /** Best guess at the fix layer. OPTIONAL: omission defaults to 'other'
   *  (Beatrice diagnoses the layer from the body regardless), and a free-text
   *  value is coerced to the nearest token — both avoid the arg-spiral this
   *  field caused. */
  suspected_class: z.preprocess(
    (v) => (v === undefined || v === null || v === '' ? 'other' : coerce_suspected_class(v)),
    SuspectedClassEnum,
  ),
});

const OutputSchema = z.object({
  inbox_message_id: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_flag_beatrice(
  inbox: SpecialistInbox,
  events: AppEventBus | undefined,
): Tool<Input, Output> {
  return {
    name: 'flag_beatrice',
    description:
      "Fire-and-forget structural-feedback flag to Beatrice (trainer). " +
      "Use for issues that need a persona, tool, or connector change — " +
      "not for one-off info requests (those go to the relevant SME via " +
      "consult_specialist). Beatrice wakes off-schedule on this flag " +
      "and ships a proposal in batched-thinking mode. `what_went_wrong` " +
      "is your own description of the structural issue (include the " +
      "specialist or tool, what they did wrong, why it matters). " +
      "`verbatim_feedback` is Jasper's exact words when suspected_class " +
      "is 'ux-feedback'; omit otherwise. `subject` names the specialist " +
      "(e.g. 'maggie') or tool ('tool:music_top_artists'). " +
      "`suspected_class` is your best guess at the fix layer: " +
      "'connector-affordance-gap' | 'persona-gap' | " +
      "'tool-description-gap' | 'capability-gap' | 'ux-feedback' | " +
      "'fabrication-pattern' | 'other'. Returns the inbox message id; " +
      "reply to Jasper with 'Flagged to Beatrice — she'll come back with " +
      "a proposal.' Don't wait for her here.",
    risk: 'write_internal',
    required_capabilities: ['write_proposals'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      // Hash the content so a repeated flag about the same issue
      // collapses inside the proposals/inbox idempotency window —
      // Kate restating "Maggie keeps fabricating band members" three
      // times in one session shouldn't burn Beatrice's deliberation
      // queue three times.
      const h = createHash('sha256');
      h.update(input.subject ?? 'unspecified');
      h.update('\n');
      h.update(input.suspected_class);
      h.update('\n');
      h.update(input.what_went_wrong);
      if (input.verbatim_feedback) {
        h.update('\n');
        h.update(input.verbatim_feedback);
      }
      return `flag_beatrice:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext) {
      const reporter = ctx.specialist_id ?? 'kate';
      // subject is optional now — Beatrice infers it from the body when the
      // model omitted it (the common case that used to arg-spiral).
      const subject = input.subject ?? 'unspecified';

      // Per-user cordon: the owner's verbatim words may be quoted inline
      // (propose_persona_tuning needs the captain's literal voice). A
      // household/friend user's words must NOT surface to the owner via
      // Beatrice's queue — log them to the audit trail and reference the
      // row id instead, so the improvement signal survives without the
      // personal text leaking.
      const is_owner = (ctx.user?.tier ?? 'owner') === 'owner';
      let verbatim_block = '';
      if (input.verbatim_feedback) {
        if (is_owner) {
          verbatim_block = `\n\n**Owner's verbatim words:**\n> ${input.verbatim_feedback}`;
        } else {
          const audit_id = ctx.memory.log_action({
            intent_id: ctx.intent_id || ulid(),
            agent: reporter,
            tool_name: 'flag_beatrice_feedback',
            tool_input: {
              subject,
              suspected_class: input.suspected_class,
            },
            user_id: ctx.user?.id,
            execution_result: { verbatim_feedback: input.verbatim_feedback },
          });
          verbatim_block =
            `\n\n**User feedback (cordoned):** the reporting user's verbatim ` +
            `words are recorded in audit row \`${audit_id}\` — read with owner ` +
            `authorization. Not inlined here to keep a household/friend user's ` +
            `words out of the owner-visible queue.`;
        }
      }

      const body_md =
        `**Structural flag** from ${reporter} — suspected class: ` +
        `\`${input.suspected_class}\`, subject: \`${subject}\`.\n\n` +
        `**What went wrong:**\n${input.what_went_wrong}` +
        verbatim_block +
        `\n\nDiagnose the fix layer (persona / tool / connector / ` +
        `capability) per your structural-question playbook and ship a ` +
        `proposal. Don't reply synchronously — Kate already told Jasper ` +
        `you'd come back with a proposal.`;

      const inbox_id = inbox.push({
        from_specialist_id: reporter,
        to_specialist_id: 'trainer',
        kind: 'flag',
        body_md,
        // Cordon: scope to the flagging user (verbatim already redacted for
        // non-owners above); keeps a non-owner flag off the owner's surfaces.
        originating_user_id: ctx.user?.id ?? null,
      });
      events?.emit({
        type: 'inbox_message_added',
        message_id: inbox_id,
        from_specialist_id: reporter,
        to_specialist_id: 'trainer',
        kind: 'flag',
        severity: 'high',
      });
      return { inbox_message_id: inbox_id };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_flag_beatrice(deps.inbox, deps.events) as Tool;
}
