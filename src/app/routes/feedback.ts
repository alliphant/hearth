/**
 * /app/api/feedback — bubble feedback trainer.
 *
 * Accepts a 👍/👎 (with optional reason) on a specific message and
 * appends a structured note to the specialist's `Knowledge/<Name>/memory.md`.
 * The note is timestamped + tagged so the specialist's next
 * deliberation pass can read it and tune her behavior:
 *
 *   - 👍  → "this pattern worked, keep doing it"
 *   - 👎 (with reason) → concrete instruction to adjust
 *   - 👎 (no reason)  → "this kind of response didn't land"
 *
 * The note format is plain markdown, with the message excerpt + the
 * verdict + the optional reason. The specialist's persona prompt
 * already tells her to consult recent memory entries, so this just
 * lets her learn from the user's signal at the next pass.
 *
 * No model invocation here — append-only file write + audit log.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulid';
import type { SpecialistRegistry } from '@core/specialist';
import type { MemoryClient } from '@memory/client';
import { append_to_memory } from '@core/memory_files';

export interface FeedbackRoutesDeps {
  specialists: SpecialistRegistry;
  memory: MemoryClient;
}

const REASON_PRESETS = new Set([
  'Too long',
  'Wrong tone',
  'Inaccurate',
  'Wrong timing',
  'Other',
]);

const FeedbackSchema = z.object({
  specialist_id: z.string().min(1).max(64),
  message_id:    z.string().min(1).max(128),
  kind:          z.enum(['up', 'down']),
  excerpt:       z.string().max(280).optional(),
  // For 👎: one of the presets above OR free text via "Other" → text.
  reason:        z.string().max(280).optional(),
  // Optional user id (multi-user); defaults to undefined (= Jasper).
  user_id:       z.string().min(1).max(64).optional(),
  // Optional UI-side conversation context — purely informational on
  // the memory entry, never load-bearing.
  conversation_id: z.string().max(128).optional(),
});

export function create_feedback_router(deps: FeedbackRoutesDeps): Hono {
  const r = new Hono();

  r.post('/', async (c) => {
    let raw: unknown;
    try { raw = await c.req.json(); }
    catch (err) {
      return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = FeedbackSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const {
      specialist_id, message_id, kind, excerpt, reason,
      user_id, conversation_id,
    } = parsed.data;

    const spec = deps.specialists.get(specialist_id);
    if (!spec) {
      return c.json({ error: `unknown specialist: ${specialist_id}` }, 404);
    }

    // Compose the memory.md entry. Markdown so it reads naturally
    // when the specialist (or a human) scans the file.
    const verdict = kind === 'up' ? '👍 worked' : '👎 did not land';
    const reasonLine = reason
      ? (REASON_PRESETS.has(reason)
          ? `Reason: **${reason}**`
          : `Reason (user wrote): ${reason.trim()}`)
      : '';
    const excerptLine = excerpt
      ? `> ${excerpt.trim().replace(/\n+/g, ' ').slice(0, 280)}`
      : '';

    const lines = [
      `**User feedback** — ${verdict}.`,
      excerptLine,
      reasonLine,
      conversation_id ? `_(conv: ${conversation_id}, msg: ${message_id})_` : `_(msg: ${message_id})_`,
    ].filter(Boolean);

    const body = lines.join('\n\n');
    append_to_memory(deps.memory, specialist_id, body, 'feedback', user_id);

    // Audit + return a small ack the client can attach to the chip.
    const audit_id = deps.memory.log_action({
      intent_id: ulid(),
      agent: 'orchestrator',
      tool_name: 'feedback',
      tool_input: { specialist_id, kind, message_id, has_reason: !!reason },
      execution_result: { ok: true },
    });
    return c.json({ ok: true, audit_id });
  });

  return r;
}
