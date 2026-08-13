import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { Tool, ToolContext } from '@core/tool';
import type { ProposalsStore } from '@core/proposals';

/**
 * draft_message — Kate composes a message in Jasper's voice and queues
 * it as a `draft_message` proposal. The proposal's iOS UI renders three
 * actions: **Send / Edit draft / Discard** (see `compute_proposal_actions`
 * in `src/core/proposal_render.ts`).
 *
 * Those buttons are sensible ONLY when `draft` actually carries the
 * literal message body Jasper will read, edit if he wants, and either
 * send or discard. Before 2026-05-29 the tool tolerated a missing /
 * empty `notes` field and substituted a placeholder string — that's
 * how "Kate asked what Jasper should bring for Bailey's dropoff" landed
 * as a `draft_message` proposal with a bracketed `[draft for …]` stub
 * and three buttons that made no sense (Send what?). The fix is
 * structural: require a non-trivial `draft` at the tool boundary; reject
 * with a recovery hint at any other shape.
 *
 * Question-shaped asks (where Jasper is meant to PICK between options,
 * not review a composed message) belong in `present_questions`. The
 * error path on this tool tells the LLM exactly that.
 */
const InputSchema = z.object({
  recipient_id: z
    .string()
    .min(1)
    .describe(
      "Who the message is going to — a person id, a name, or " +
        "a recipient label that disambiguates inside Knowledge/People/.",
    ),
  channel: z
    .enum(['email', 'note', 'other'])
    .describe(
      'How the message would be framed. NOTE: there is no live SMS/text ' +
        'surface — this tool does NOT send a text to anyone. It only files ' +
        "a proposal for the OWNER to review and send. Don't pick 'note' as a " +
        'dumping ground for a question — see the `draft` field rules.',
    ),
  occasion: z
    .string()
    .min(1)
    .describe(
      "One-line frame for why this message exists. Goes into the " +
        'proposal card title and Mariah-side signature anchor.',
    ),
  draft: z
    .string()
    .min(20)
    .describe(
      'The LITERAL message body Jasper will read and decide on. Not a ' +
        'placeholder, not a question for Jasper, not a note about what ' +
        "you'd say — the actual text, ready to send if he taps Send. " +
        'Minimum 20 characters because a draft shorter than that is ' +
        'never a real message. ' +
        'If you wanted to ASK Jasper something (e.g. "what should I ' +
        'bring for Bailey\'s dropoff?"), STOP and call ' +
        '`present_questions` instead — that renders option buttons and ' +
        'triggers a follow-up turn with his pick. Filing a question as ' +
        '`draft_message` shows up to Jasper as "Send / Edit draft / ' +
        'Discard," which is the wrong UX for a question.',
    ),
});

const OutputSchema = z.object({
  proposal_id: z.string(),
  draft: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/**
 * Style is two-tier: a distilled profile (jasper_style_profile.md) is the
 * canonical reference; raw dated bullets (jasper_style.md) are the audit
 * trail. Prefer the profile; fall back to bullets until the first distill
 * run produces one.
 */
function read_style(vault_root: string): {
  text: string;
  source: 'profile' | 'bullets' | 'none';
} {
  const profile = resolve(vault_root, 'Knowledge', 'Kate', 'jasper_style_profile.md');
  if (existsSync(profile)) {
    return { text: readFileSync(profile, 'utf8'), source: 'profile' };
  }
  const bullets = resolve(vault_root, 'Knowledge', 'Kate', 'jasper_style.md');
  if (existsSync(bullets)) {
    return { text: readFileSync(bullets, 'utf8'), source: 'bullets' };
  }
  return { text: '', source: 'none' };
}

export function make_draft_message(
  proposals: ProposalsStore,
  vault_root: string,
): Tool<Input, Output> {
  return {
    name: 'draft_message',
    description:
      "Compose a message in Jasper's voice and queue it as a proposal the " +
      "OWNER reads and decides to Send / Edit draft / Discard. " +
      "Required: recipient_id, channel (email|note|other), occasion " +
      "(one-line frame), and `draft` (the LITERAL message body, ≥20 " +
      "chars — not a placeholder, not a question). " +
      "This does NOT directly deliver a message to anyone — there is no " +
      "live SMS/text channel, and it never messages a household member or " +
      "friend (e.g. Kim) directly. To get something from another user, " +
      "route through the specialist they're working with " +
      "(`consult_specialist` / `flag_<name>`), not this tool. " +
      "Do NOT use this tool to ASK Jasper something: questions belong in " +
      "`present_questions`, which renders option buttons and routes his " +
      "answer back into a follow-up turn. The Send/Edit/Discard buttons " +
      "this tool produces are the wrong UX for a question. " +
      "Style guidance is pulled from Knowledge/Kate/jasper_style_profile.md " +
      "(or jasper_style.md bullets when no distilled profile exists yet).",
    risk: 'write_internal',
    required_capabilities: ['write_proposals', 'read_vault'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.recipient_id);
      h.update('\n');
      h.update(input.channel);
      h.update('\n');
      h.update(input.occasion);
      h.update('\n');
      h.update(input.draft);
      return `draft_message:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext) {
      const style = read_style(vault_root);
      const id = proposals.create({
        specialist_id: 'kate',
        kind: 'draft_message',
        // Cordon this draft to the user it was made for.
        user_id: ctx.user?.id ?? null,
        execution_kind: 'manual',
        payload: {
          recipient_id: input.recipient_id,
          channel: input.channel,
          occasion: input.occasion,
          draft: input.draft,
          style_source: style.source,
        },
        rationale: `Drafted ${input.channel} to ${input.recipient_id} for: ${input.occasion}`,
        signature: {
          specialist_id: 'kate',
          kind: 'draft_message',
          category: input.channel,
          anchor: input.recipient_id,
        },
      });
      void ctx; // silence unused
      return { proposal_id: id, draft: input.draft };
    },
  };
}
