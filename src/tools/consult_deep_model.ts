/**
 * consult_deep_model — the escalation path in the two-tier model topology.
 *
 * Every specialist runs its conversational turns on the fast 9B
 * (Qwen3.5-9B — the official Qwen build, per the live gguf metadata; a prior
 * "Heretic"/abliterated label here was STALE, 2026-06-22). The 9B is quick and
 * capable on ordinary chat, but
 * when a turn hits a question that genuinely needs depth — a multi-step
 * inference, a subtle tradeoff, a piece of reasoning the 9B can feel
 * itself fumbling — it hands that one scoped sub-question here. This tool
 * runs a single one-shot turn on the 35B depth model
 * (Qwen3.6-35B-A3B-Heretic, LLM role `deep_consult`) and returns the
 * answer as plain text for the calling specialist to fold into its reply.
 *
 * It is the model-layer sibling of `consult_specialist`: where that
 * consults a teammate for domain knowledge, this consults the deep model
 * for raw reasoning. No tools, no vault access, no side effects — it is a
 * pure read-tier "think harder about this" call.
 *
 * Capability: `consult_deep_model` (config/capabilities.yaml), granted
 * broadly — every specialist in the seed roster carries it.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { Tool, ToolContext } from '@core/tool';

const InputSchema = z.object({
  question: z
    .string()
    .min(1)
    .max(8000)
    .describe(
      'The hard, self-contained sub-question to hand to the deep model. ' +
        'Phrase it so it can be answered without the rest of the ' +
        'conversation — state what you actually need reasoned through.',
    ),
  context: z
    .string()
    .max(20000)
    .optional()
    .describe(
      'Optional background the deep model needs to answer well: relevant ' +
        'facts from the conversation, constraints, data you have already ' +
        'gathered. Paste the substance; do not assume it can see the chat.',
    ),
  image_path: z
    .string()
    .optional()
    .describe(
      'Optional vault-relative or absolute path to an image to attach to ' +
        'the question. The deep model is vision-capable (Qwen3.6 + mmproj ' +
        "on the LLM host) — useful when you're reasoning ABOUT a routed " +
        'capture, a photo {{user_name}} sent, or a screenshot. HEIC is ' +
        'transcoded server-side; JPEG/PNG/WEBP pass through.',
    ),
});

const OutputSchema = z.object({
  answer: z
    .string()
    .describe('The deep model’s reasoned answer to the question.'),
  model: z.string().describe('The model that produced the answer.'),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const SYSTEM_PROMPT = [
  'You are the depth tier of a household chief-of-staff system — a larger,',
  'slower reasoning model that a faster model consults when a question',
  'needs real thinking. You have been handed ONE scoped sub-question.',
  '',
  'Answer it directly, completely, and honestly. Reason carefully, then',
  'give a clear, self-contained answer the calling assistant can use',
  'immediately. If the question is underspecified, answer the most likely',
  'reading and name the assumption. If you genuinely cannot answer, say so',
  'plainly and say what would be needed. Do not pad, do not hedge for its',
  'own sake, and do not ask the user follow-up questions — you are talking',
  'to another assistant, not the user.',
].join('\n');

export const consult_deep_model: Tool<Input, Output> = {
  name: 'consult_deep_model',
  description:
    'Escalate ONE hard sub-question to the deep reasoning model and get a ' +
    'thorough answer back. Use this when a turn needs depth your fast chat ' +
    'model is fumbling — multi-step inference, a subtle tradeoff, careful ' +
    'analysis. Pass a self-contained `question` plus any `context` the ' +
    'deep model needs (it cannot see this conversation). It returns text; ' +
    'fold the answer into your reply in your own voice.',
  risk: 'read',
  required_capabilities: ['consult_deep_model'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.question);
    h.update('\n');
    h.update(input.context ?? '');
    h.update('\n');
    h.update(input.image_path ?? '');
    return `consult_deep_model:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    // Everything goes to `deep_consult` — since 2026-07-30 that's the
    // Qwen3.5-122B on forza, which is natively VL, so image-bearing consults
    // get the DEEP look too. (The old image→`vision` split existed only
    // because the previous deep tier was text-only; `vision` remains the
    // fast local glance tier for analyze_image_direct + unifi_camera_view.)
    const resolved = ctx.llm.for_role('deep_consult');

    const user_content = input.context
      ? `## Context\n\n${input.context}\n\n## Question\n\n${input.question}`
      : input.question;

    // Resolve a vault-relative image path against the orchestrator's
    // vault root; absolute paths pass through.
    let vision: { image_path: string } | undefined;
    if (input.image_path) {
      const vault_root =
        process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`;
      const abs = isAbsolute(input.image_path)
        ? input.image_path
        : resolve(vault_root, input.image_path);
      vision = { image_path: abs };
    }

    // Honour the caller's cancellation (2026-08-05). Two callers need it: the
    // user pressing Stop mid-turn (this call can otherwise hold a `deep_consult`
    // slot for the role's full 300s after they've walked away), and the
    // escalate-on-evidence path, which hands down a signal already narrowed to
    // HEARTH_ESCALATE_BUDGET_MS so the deep leg can't outlive its budget.
    const resp = await resolved.provider.complete({
      ...resolved.defaults,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user_content },
      ],
      vision,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    const answer = resp.content.trim();
    if (!answer) {
      // The depth model spent its whole budget on the <think> trace and
      // emitted no visible answer — surface that as a usable failure
      // rather than returning an empty string the caller can't act on.
      throw new Error(
        'consult_deep_model: the deep model returned no answer (likely ' +
          'exhausted its token budget while reasoning). Try a tighter, ' +
          'more specific question.',
      );
    }

    return { answer, model: resolved.model };
  },
};
