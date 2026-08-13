/**
 * message_user — a specialist proactively messages a USER it serves
 * (2026-06-16). The specialist→user delivery path that was missing: a
 * household assistant has to be able to reach the people it works for.
 *
 * The message lands in the recipient's OWN chat thread with that specialist
 * (so they can reply and it routes back), emits a live `message_added`
 * event, and fires an APNs push so they know — quiet-hours / notification
 * thresholds gate the push exactly like any other. No owner approval: a
 * specialist reaching the user it serves is routine, and routing every such
 * contact through the owner is precisely the friction this removes.
 *
 * The cordon is the safety: a specialist may message a user ONLY if that
 * user's roster (`allowed_specialists`) includes it — Linda serves Kim, so
 * Linda can message Kim; Kate (whom Kim doesn't roster) cannot, and is told
 * to relay through Linda. Meta-agents (Mariah, Beatrice) aren't on any
 * user's roster, so they can't message users at all. Granting `message_user`
 * to another specialist is a one-line YAML edit (hot-reloaded).
 *
 * Distinct from `draft_message` (compose a message for the OWNER to review
 * and send to an EXTERNAL contact) and from `present_questions` (surface a
 * tappable form to the conversation's user). For an option-pick, the
 * specialist should still prefer present_questions.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { ConversationStore } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';
import type { UserRegistry } from '@core/users';
import type { SpecialistRegistry } from '@core/specialist';
import {
  push_text_to_user,
  type PushResult,
  type PushSourceContext,
} from '@policy/push';

const InputSchema = z.object({
  to_user: z
    .string()
    .min(1)
    .describe(
      "Who to message — the user's id or display name (e.g. 'kim' or 'Kim'). " +
        'You can only message a user you SERVE (one whose roster includes you); ' +
        'anyone else is refused with the list of who does serve them.',
    ),
  message: z
    .string()
    .min(2)
    .max(2000)
    .describe(
      'The message to send, in your own voice — the literal text the user ' +
        'reads in their chat with you. They get a push and see it in-app, and ' +
        'can reply straight back to you. If you are asking them to pick between ' +
        'options, prefer `present_questions` instead.',
    ),
});

const OutputSchema = z.object({
  ok: z.boolean(),
  conversation_id: z.string().optional(),
  delivered: z.boolean().optional(),
  via: z.string().optional(),
  error: z.string().optional(),
  candidates: z.array(z.string()).optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/**
 * Proactive-messaging policy (2026-06-16, owner-chosen "tiered + rate-limited"):
 *
 *  - OWNER / HOUSEHOLD recipients: a specialist may message proactively
 *    (Astrid goals, Cassandra alerts, Iris departure nudges) — they opted
 *    into a proactive assistant; the push is already quiet-hours / threshold
 *    gated downstream.
 *  - FRIEND recipients (transactional, e.g. a seller): NO cold outreach. A
 *    specialist may only message them as a FOLLOW-UP — they must have a
 *    user-authored message in the thread within INITIATION_WINDOW_MS. A friend
 *    is using a tool, not signing up for unprompted contact.
 *  - ALL tiers — anti-nag: if the specialist already spoke last and the user
 *    hasn't replied since, no re-ping within NUDGE_COOLDOWN_MS. The rate limit
 *    is reply-gated — one outreach, then wait for a reply (or the cooldown).
 *
 * Tunable via env; the defaults are the guardrail.
 */
const INITIATION_WINDOW_MS =
  Number(process.env.HEARTH_MSG_USER_INITIATION_H ?? 48) * 3_600_000;
const NUDGE_COOLDOWN_MS =
  Number(process.env.HEARTH_MSG_USER_COOLDOWN_H ?? 4) * 3_600_000;

export interface MessageUserDeps {
  conversations: Pick<ConversationStore, 'resolve_for_user' | 'append_message' | 'list_messages'>;
  events: Pick<AppEventBus, 'emit'>;
  users?: Pick<UserRegistry, 'list' | 'get' | 'is_specialist_allowed'>;
  specialists?: Pick<SpecialistRegistry, 'get'>;
  /** Injectable for tests; production uses the configured APNs pipeline. */
  deliver?: (user_id: string, text: string, ctx: PushSourceContext) => Promise<PushResult>;
}

export function make_message_user(deps: MessageUserDeps): Tool<Input, Output> {
  const deliver = deps.deliver ?? push_text_to_user;
  return {
    name: 'message_user',
    description:
      'Send a message directly to a household member or friend you serve — ' +
      'it lands in their chat with you, pushes to their phone, and they can ' +
      'reply back to you. Use it to reach a user who is not currently in the ' +
      'conversation (e.g. to ask a seller for a detail you need). You can only ' +
      'message a user whose roster includes you; if not, you are told who to ' +
      'relay through. A friend-tier user you may only FOLLOW UP with on a ' +
      'thread they started recently (no cold outreach); the owner/household you ' +
      'may message proactively. Don\'t re-send until they reply. ' +
      'NOT for messaging the owner on someone else\'s behalf, ' +
      'NOT an external email/SMS (that is draft_message), and NOT an ' +
      'option-pick (that is present_questions).',
    risk: 'write_internal',
    required_capabilities: ['message_user'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.to_user.trim().toLowerCase());
      h.update('\n');
      h.update(input.message);
      return `message_user:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const specialist_id = ctx.specialist_id;
      if (!specialist_id) {
        return { ok: false, error: 'message_user can only be called from inside a specialist turn.' };
      }
      const users = deps.users;
      if (!users) {
        return { ok: false, error: 'The user registry is unavailable, so I can\'t resolve the recipient.' };
      }

      // Resolve by id or display name (the model naturally says "Kim").
      const want = input.to_user.trim().toLowerCase();
      const target =
        users.get(input.to_user) ??
        users.list().find(
          (u) => u.id.toLowerCase() === want || u.display_name.toLowerCase() === want,
        ) ??
        null;
      if (!target) {
        return {
          ok: false,
          error: `No user "${input.to_user}".`,
          candidates: users.list().map((u) => `${u.id} (${u.display_name})`),
        };
      }

      // Context guard (the structural seal on cross-user leakage): you may
      // only message the user whose context THIS turn is — the one you're
      // serving in chat, or deliberating about. The recipient must BE the
      // turn's user, so a specialist reading the owner's data in the OWNER's
      // turn can't carry it into a message to a different user. ctx.user is
      // set by the runtime from the authenticated turn / deliberation
      // recipient — a specialist can't forge it.
      if (!ctx.user || ctx.user.id !== target.id) {
        return {
          ok: false,
          error:
            `You can only message the user whose conversation you're in (or ` +
            `deliberating about) — that keeps one person's data from crossing ` +
            `into a message to another. This turn isn't ${target.display_name}'s, ` +
            `so you can't reach them from here; message them while you're working with them.`,
        };
      }

      // Cordon (defense-in-depth) — you may only message a user you serve.
      if (!users.is_specialist_allowed(target, specialist_id)) {
        const servers =
          target.allowed_specialists === '*'
            ? ['anyone on the team']
            : target.allowed_specialists;
        return {
          ok: false,
          error:
            `You don't serve ${target.display_name}, so you can't message them directly. ` +
            `They work with: ${servers.join(', ')}. Ask one of them (or Kate) to relay.`,
        };
      }

      // Resolve their thread with you, then apply the proactive-messaging
      // policy against its recent history before sending.
      const { conversation } = deps.conversations.resolve_for_user(target.id, specialist_id);
      const recent = deps.conversations.list_messages(conversation.id, { limit: 30 });
      const now_ms = ctx.now?.getTime() ?? Date.now();

      // Anti-nag (all tiers): if you spoke last and they haven't replied,
      // don't pile on within the cooldown. Reply-gated rate limit.
      const last = recent[recent.length - 1];
      if (
        last &&
        last.role === 'specialist' &&
        now_ms - Date.parse(last.ts) < NUDGE_COOLDOWN_MS
      ) {
        return {
          ok: false,
          error:
            `You already messaged ${target.display_name} and they haven't replied yet — ` +
            `wait for their response before reaching out again.`,
        };
      }

      // Friend tier: follow-up only, no cold outreach. They must have written
      // in the thread recently (a thread THEY are part of), or this is unsolicited.
      if (target.tier === 'friend') {
        const had_recent_user_msg = recent.some(
          (m) => m.role === 'user' && now_ms - Date.parse(m.ts) < INITIATION_WINDOW_MS,
        );
        if (!had_recent_user_msg) {
          return {
            ok: false,
            error:
              `${target.display_name} hasn't messaged you recently, and they're a friend-tier ` +
              `user — you can only follow up on a conversation they started, not reach out cold. ` +
              `Wait for them to message you.`,
          };
        }
      }

      // Cleared the policy — deliver into their thread with you.
      const msg = deps.conversations.append_message({
        conversation_id: conversation.id,
        role: 'specialist',
        specialist_id,
        content_md: input.message,
      });
      deps.events.emit({
        type: 'message_added',
        conversation_id: conversation.id,
        message_id: msg.id,
        role: 'specialist',
        specialist_id,
        content_preview: input.message.slice(0, 140),
      });

      // Push so they know (quiet-hours gated downstream).
      const name = deps.specialists?.get(specialist_id)?.name ?? specialist_id;
      const push = await deliver(target.id, `${name}: ${input.message.slice(0, 160)}`, {
        kind: 'ad_hoc',
        severity: 'medium',
        originating_specialist_id: specialist_id,
      });

      ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: specialist_id,
        user_id: target.id,
        tool_name: 'message_user',
        tool_input: { to_user: target.id, preview: input.message.slice(0, 200) },
        execution_result: {
          conversation_id: conversation.id,
          delivered: push.delivered,
          via: push.via ?? 'in_app',
        },
        error: push.error,
      });

      return {
        ok: true,
        conversation_id: conversation.id,
        delivered: push.delivered,
        via: push.via ?? 'in_app',
      };
    },
  };
}

/** ToolLoader entry — wires the production dependency bag. */
export function create(deps: ToolDeps): Tool {
  return make_message_user({
    conversations: deps.conversations,
    events: deps.events,
    users: deps.users,
    specialists: deps.specialists,
  }) as Tool;
}
