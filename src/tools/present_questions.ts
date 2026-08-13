/**
 * present_questions — surface a structured form to Jasper instead of
 * writing prose with implicit decisions.
 *
 * Pattern mirrors Claude Code's AskUserQuestion: 1-4 questions, each
 * with 2-4 options + free-text "Other" auto-appended on the client.
 * The tool persists a pending_questions row, emits a SSE event so the
 * open web pane renders the form, and returns immediately with the
 * question_set_id so the specialist can keep its closing message tight
 * ("I dropped a couple choices in the brief — pick when you have a
 * second"). When Jasper submits, `POST /api/present-questions/:id/answer`
 * triggers a fresh specialist turn with the answers folded in.
 *
 * Cross-cutting: lives under `src/tools` so any specialist whose
 * capabilities resolve to it can call it. No required_capability — this
 * is presentation, not effect. Risk is `read` because we only persist
 * UI state.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { PendingQuestionsStore } from '@memory/stores/pending_questions';

const OptionSchema = z.object({
  value: z
    .string()
    .min(1)
    .max(80)
    .describe(
      'Machine-readable token returned to the specialist when this option is chosen. Short snake_case is conventional, e.g. "water_yard" or "skip".',
    ),
  label: z
    .string()
    .min(1)
    .max(120)
    .describe(
      "What Jasper sees on the button. 1-5 words. Should be concise and clearly describe the choice (e.g. 'Water the front yard tonight').",
    ),
  description: z
    .string()
    .max(240)
    .optional()
    .describe(
      'Optional one-sentence elaboration shown under the label (the trade-off, the consequence).',
    ),
});

const QuestionSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .describe(
      'Stable snake_case identifier for this question. Used as the key in the returned answers map. Pick something meaningful, e.g. "water_tonight" or "leak_priority".',
    ),
  text: z
    .string()
    .min(3)
    .max(280)
    .describe(
      'The question Jasper will see. Short and decision-shaped — "Water the front yard before tonight\'s storm?", not "I am wondering whether perhaps the lawn might benefit from...".',
    ),
  options: z
    .array(OptionSchema)
    .min(2)
    .max(4)
    .describe(
      '2-4 mutually exclusive options (when multi_select is false) or 2-4 individually selectable options (when true). A free-text "Other" is auto-appended on the client — do NOT include an "Other" option yourself.',
    ),
  multi_select: z
    .boolean()
    .optional()
    .describe(
      "When true, Jasper can pick multiple options. Default false. Use when the question is 'which of these apply' rather than 'pick one'.",
    ),
  target_user: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Who the question is for — usually leave unset; it defaults to the " +
        "user you're talking with (the seller, household member, or owner), " +
        "which is correct in nearly every case. Set 'either' for an " +
        "open-to-anyone household question. Informational today (the form " +
        'renders to whoever is viewing this conversation).',
    ),
});

const InputSchema = z.object({
  intro: z
    .string()
    .max(500)
    .optional()
    .describe(
      'Optional one-line preamble that frames the choices ("Two small decisions for the morning brief —"). Skip when the question text is self-explanatory.',
    ),
  questions: z
    .array(QuestionSchema)
    .min(1)
    .max(4)
    .describe(
      'The questions to surface. 1-4 of them. Each gets its own block with options as tap-able buttons. Order matters — put the most consequential one first.',
    ),
});

const OutputSchema = z.object({
  question_set_id: z
    .string()
    .describe('Stable id for this set; appears in the SSE event and the answer route.'),
  status: z.literal('pending'),
  conversation_id: z.string().nullable(),
  brief_id: z.string().nullable(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const DESCRIPTION =
  "Surface 1-4 structured multi-select questions to Jasper as a tappable form instead of writing prose with implicit decisions. Call this WHEN your reply is about to ask Jasper to choose between explicit options (water the yard or skip; A vs B vs C; pick a date) — taps beat re-typing. The form renders in the same conversation; when Jasper answers, you get a fresh turn with the answers and can act on them. Keep your closing prose tight ('Two small choices below — pick when you have a second.') because the form is the substance. Don't double-narrate the options in prose — they appear as buttons. NEVER include an 'Other' option yourself; the client auto-appends a free-text 'Other' on every question.";

export function create(deps: ToolDeps): Tool<Input, Output> {
  const store = new PendingQuestionsStore(deps.db);

  return {
    name: 'present_questions',
    description: DESCRIPTION,
    risk: 'read',
    required_capabilities: [],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.intro ?? '');
      h.update('\n');
      for (const q of input.questions) {
        h.update(q.id);
        h.update('\n');
        h.update(q.text);
        h.update('\n');
        for (const o of q.options) {
          h.update(o.value);
          h.update('=');
          h.update(o.label);
          h.update('\n');
        }
      }
      return `present_questions:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      if (!ctx.specialist_id) {
        throw new Error(
          'present_questions requires specialist_id on ToolContext — it can only be called from inside a specialist turn.',
        );
      }

      // A consult sub-turn (consult_specialist) runs against an ephemeral
      // `consult:<ulid>` conversation the user never sees — a form persisted
      // here would ORPHAN (its conversation_id can never match the user's chat,
      // so the web/app client never renders it). A consult is agent-to-agent:
      // the right move is to return the options to the specialist who consulted
      // you, who then surfaces the choice to the user via their OWN
      // present_questions on the user-facing turn (where it renders correctly).
      // This is a tool-layer redirect (the error IS the in-context nudge), not
      // a per-persona negation — so it holds for every current and future
      // specialist with no config edits.
      if ((ctx.conversation_id ?? '').startsWith('consult:')) {
        throw new Error(
          "present_questions can't reach the user from inside a consult — you're answering another specialist, not talking to the user directly. Don't call it here. Instead, return your recommended option(s) as normal text to the specialist who consulted you; they'll put the choice to the user.",
        );
      }

      // The deliberation loop uses synthetic conversation ids of the
      // form `deliberation:<sid>:<slot>` that aren't backed by a
      // `conversations` row. In that case persist with conversation_id
      // null and leave brief_id null — `deliberation_pass` patches the
      // brief_id onto every set this specialist created during the
      // pass once the brief row exists. (Brief is persisted AFTER the
      // turn returns, so there's no real brief_id to write here yet.)
      const is_deliberation = (ctx.conversation_id ?? '').startsWith('deliberation:');
      const conversation_id: string | null = is_deliberation
        ? null
        : (ctx.conversation_id ?? null);
      const brief_id: string | null = null;

      const row = store.create({
        specialist_id: ctx.specialist_id,
        conversation_id,
        brief_id,
        intro_md: input.intro ?? null,
        questions: input.questions.map((q) => ({
          id: q.id,
          text: q.text,
          options: q.options,
          multi_select: q.multi_select ?? false,
          target_user: q.target_user ?? ctx.user?.id ?? 'jasper',
        })),
      });

      deps.events.emit({
        type: 'questions_presented',
        question_set_id: row.id,
        specialist_id: ctx.specialist_id,
        conversation_id,
        brief_id,
        question_count: input.questions.length,
      });

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id,
        tool_name: 'present_questions',
        tool_input: {
          conversation_id,
          brief_id,
          question_ids: input.questions.map((q) => q.id),
        },
        execution_result: { question_set_id: row.id },
      });

      return {
        question_set_id: row.id,
        status: 'pending',
        conversation_id,
        brief_id,
      };
    },
  };
}
