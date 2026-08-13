/**
 * read_specialist_conversation — owner-only: let Kate read the OWNER's own
 * conversation with another specialist.
 *
 * The owner routinely talks to several specialists (Mariah, Vivian, Astrid…).
 * When he tells Kate "about the thing I was working through with Mariah", she
 * should be able to pull that thread's transcript instead of guessing. This
 * reads the owner's OWN threads only — same user, so it never crosses the
 * per-user cordon; it's the transcript equivalent of reveal_self ("see the
 * system's own state"), which is why it reuses that owner-introspection
 * capability and hard-gates on owner tier at the tool layer.
 *
 * Read-only. Returns the recent message tail as plain markdown, tagged by
 * speaker, newest context last. Pull it ON DEMAND when the owner references
 * another thread — it is not injected into every turn.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';

const InputSchema = z.object({
  specialist: z
    .string()
    .describe(
      'Which specialist\'s conversation to read — id, name, or alias (e.g. "mariah", "Vivian", "astrid").',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('How many of the most recent messages to return (default 30).'),
});

const OutputSchema = z.object({
  ok: z.boolean(),
  content_md: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function create_read_specialist_conversation(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'read_specialist_conversation',
    description:
      "Owner-only: read {{user_name}}'s OWN recent conversation with another specialist, as a " +
      'transcript. Call this WHENEVER he refers to something he discussed with another ' +
      'teammate ("what did Mariah and I land on?", "pick up where Vivian left off", "he told ' +
      'Astrid about the trip") so you work from the real thread, not a guess. Reads his own ' +
      'threads only — never another person\'s. Read-only.',
    input_schema: InputSchema,
    output_schema: OutputSchema,
    required_capabilities: ['reveal_self'],
    risk: 'read',
    idempotency_key(input) {
      return `read_specialist_conversation:${input.specialist}:${input.limit ?? 30}`;
    },
    async execute(input, ctx: ToolContext): Promise<Output> {
      // Owner-only: this reads across the owner's own threads. Same cordon as
      // reveal_self — never expose it to a household/friend caller.
      if (ctx.user && ctx.user.tier !== 'owner') {
        return {
          ok: false,
          content_md: "Reading other conversations is owner-only — I can't do that for this account.",
        };
      }
      const uid = ctx.user?.id;
      if (!uid) return { ok: false, content_md: "I couldn't tell whose conversations to read." };

      const sid = deps.specialists.resolve_id(input.specialist);
      if (!sid) {
        return { ok: false, content_md: `I don't have a teammate matching "${input.specialist}".` };
      }
      const profile = deps.specialists.get(sid);
      const name = profile?.name ?? sid;

      // Most-recent non-empty thread for (owner, specialist). resolve_for_user
      // would CREATE a thread on a miss, so use list() (read-only).
      const convs = deps.conversations.list({
        user_id: uid,
        specialist_id: sid,
        exclude_empty: true,
        limit: 1,
      });
      if (convs.length === 0) {
        return { ok: true, content_md: `No conversation between you and ${name} yet.` };
      }
      const conv = convs[0]!;
      const limit = input.limit ?? 30;
      // list_messages returns newest-first; reverse to chronological so the
      // transcript reads top-to-bottom the way the conversation happened.
      const rows = deps.conversations.list_messages(conv.id, { limit }).slice().reverse();
      if (rows.length === 0) {
        return { ok: true, content_md: `No messages in your conversation with ${name} yet.` };
      }

      const speaker = (r: (typeof rows)[number]): string => {
        if (r.role === 'user') return ctx.user?.id === 'jasper' ? 'Jasper' : 'Owner';
        if (r.role === 'system') return 'system';
        return deps.specialists.get(r.specialist_id ?? sid)?.name ?? name;
      };
      const body = rows
        .map((r) => `**${speaker(r)}:** ${(r.content_md ?? '').trim()}`)
        .join('\n\n');

      const header =
        `Transcript — your conversation with ${name} ` +
        `(${rows.length} most-recent message${rows.length === 1 ? '' : 's'}, oldest first):`;
      return { ok: true, content_md: `${header}\n\n${body}` };
    },
  };
}
