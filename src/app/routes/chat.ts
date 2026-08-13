/**
 * /app/api/chat — convenience endpoints in front of the 6a /api/conversations.
 *
 * The UI talks to /api/conversations/:id/messages directly for the main
 * send/receive flow (one route handles both directions). This module
 * additionally exposes:
 *
 *   POST /app/api/chat/send  — equivalent shape but accepts specialist_id +
 *     optional conversation_id; creates a conversation when none is supplied.
 *     Useful for "start a new thread with X" UI flows.
 *
 *   POST /app/api/chat/transcribe — voice-to-text placeholder (501 until
 *     Whisper integration ships).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { SpecialistRegistry } from '@core/specialist';
import type { SpecialistRuntime } from '@core/specialist_runtime';
import type { ConversationStore } from '@memory/stores/conversations';
import type { AppEventBus } from '../events';
import { to_turn_user } from '@core/users';
import { transcribe_audio } from '@connectors/stt';

export interface ChatRoutesDeps {
  specialists: SpecialistRegistry;
  runtime: SpecialistRuntime;
  conversations: ConversationStore;
  events?: AppEventBus;
}

const SendSchema = z.object({
  specialist_id: z.string(),
  conversation_id: z.string().optional(),
  content: z.string().min(1).max(20_000),
});

export function create_chat_router(deps: ChatRoutesDeps): Hono {
  const r = new Hono();

  r.post('/send', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = SendSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const spec = deps.specialists.get(parsed.data.specialist_id);
    if (!spec) {
      return c.json({ error: `unknown specialist: ${parsed.data.specialist_id}` }, 400);
    }

    let conv_id = parsed.data.conversation_id;
    if (!conv_id) {
      conv_id = deps.conversations.create(parsed.data.specialist_id).id;
    } else if (!deps.conversations.get(conv_id)) {
      return c.json({ error: `unknown conversation: ${conv_id}` }, 404);
    }

    const user_msg = deps.conversations.append_message({
      conversation_id: conv_id,
      role: 'user',
      content_md: parsed.data.content,
    });
    deps.events?.emit({
      type: 'message_added',
      conversation_id: conv_id,
      message_id: user_msg.id,
      role: 'user',
      content_preview: parsed.data.content.slice(0, 200),
    });

    const history = deps.conversations
      .list_messages(conv_id, { limit: 20 })
      .filter((m) => m.id !== user_msg.id)
      .map((m) => ({
        role: m.role,
        content: m.content_md,
        specialist_id: m.specialist_id ?? undefined,
      }));

    // Use the streaming runtime so the UI sees tokens as they arrive
    // (message_token SSE events). If the provider doesn't support
    // streaming or HEARTH_TEST_MODE is set, this transparently falls
    // back to the non-streaming turn() path.
    // Phase 2b — pass caller for per-tier discretion. Auth middleware
    // populates c.get('user') when the request carried a session.
    const user = c.get('user');
    // Interactive chat → concurrent LIVE tier (A4000, :8089) so it never
    // queues behind background deliberation/consults on the single-slot
    // DEEP endpoint (:8088). See the messages route for the rationale: an
    // explicit `llm_role: specialist` still moves; a genuine non-chat pin
    // (e.g. voice_realtime, already on the A4000) is preserved.
    const chat_tier: 'live' | undefined =
      spec.llm_role && spec.llm_role !== 'specialist' ? undefined : 'live';
    const out = await deps.runtime.turn_streaming({
      specialist_id: parsed.data.specialist_id,
      conversation_id: conv_id,
      message: { role: 'user', content: parsed.data.content },
      conversation_history: history,
      user: to_turn_user(user, c.get('user_tz')),
      ...(chat_tier ? { tier: chat_tier } : {}),
    });

    const spec_msg = deps.conversations.append_message({
      conversation_id: conv_id,
      role: 'specialist',
      specialist_id: parsed.data.specialist_id,
      content_md: out.message_text,
      tool_calls: out.tool_calls_made,
      proposals_created: out.proposals_created,
      reasoning_trace: out.reasoning_trace || undefined,
    });
    deps.events?.emit({
      type: 'message_added',
      conversation_id: conv_id,
      message_id: spec_msg.id,
      role: 'specialist',
      specialist_id: parsed.data.specialist_id,
      content_preview: out.message_text.slice(0, 200),
    });

    return c.json({
      conversation_id: conv_id,
      message: spec_msg,
      tool_calls_made: out.tool_calls_made,
      proposals_created: out.proposals_created,
      consulted_specialists: out.consulted_specialists,
      cost: out.cost,
    });
  });

  /**
   * Audio in, text out. Was a hardcoded 501 ("Whisper integration is a future
   * addition") while an OpenAI-compatible whisper server was already running on
   * the LLM host :8093 and the relay route was forwarding to it — this points the
   * app-wide endpoint at the same helper. Local model; audio does not leave the
   * house.
   */
  r.post('/transcribe', async (c) => {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch (err) {
      return c.json({ error: `multipart parse: ${(err as Error).message}` }, 400);
    }
    const file = form.get('file') ?? form.get('audio');
    if (!(file instanceof File)) return c.json({ error: 'file field required' }, 400);

    const lang = form.get('language');
    const said = await transcribe_audio(file, typeof lang === 'string' ? lang : undefined);
    if (!said.ok) return c.json({ error: said.reason }, said.status);
    return c.json({ transcript: said.text, text: said.text });
  });

  return r;
}
