/**
 * Promised follow-ups. When a specialist says "let me dig into X", they
 * call `promise_followup` — the tool enqueues a scheduled_tasks row that
 * the scheduler will fire later, POSTing the orchestrator's
 * /api/specialists/deliver-followup endpoint. That endpoint runs another
 * specialist turn (with a synthetic trigger message) and appends the
 * answer to the original conversation.
 *
 * Without this, promises rot — the specialist returns "Available" with no
 * delivery on what they said they'd do. With this, the loop closes.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from './tool';

export const DELIVER_FOLLOWUP_PATH = '/api/specialists/deliver-followup';

const DEFAULT_DUE_MINUTES = 2;
const MAX_DUE_MINUTES = 60 * 24 * 7;
const MIN_DUE_MINUTES = 0.5;
const MAX_ATTEMPTS = 3;

const InputSchema = z.object({
  summary: z.string().min(3).max(280),
  scope: z.string().min(3).max(4_000),
  // Qwen routinely emits numerics as strings ("2"); coerce so the
  // tool call actually lands instead of failing input-validation and
  // looking like a ghost promise.
  due_in_minutes: z.coerce
    .number()
    .min(MIN_DUE_MINUTES)
    .max(MAX_DUE_MINUTES)
    .optional(),
});

const OutputSchema = z.object({
  followup_id: z.string(),
  fire_at_iso: z.string(),
  conversation_id: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export interface DeliverFollowupContext {
  conversation_id: string;
  specialist_id: string;
  summary: string;
  scope: string;
  promised_at_iso: string;
  /** The scheduled_tasks row id (flw_*). Threaded through so the
   *  deliver-followup route can emit a `followup_delivered` SSE
   *  event that matches the original `followup_scheduled` event by
   *  id, letting the client retire the pending pill. */
  followup_id?: string;
}

export function make_promise_followup(db: Database): Tool<Input, Output> {
  return {
    name: 'promise_followup',
    description:
      "Schedule a follow-up message to the user on the current conversation. Call this WHENEVER you tell the user you'll look into something, get back to them, or send something later — otherwise your promise will be dropped and they will never hear back. The follow-up fires in `due_in_minutes` (default 2; max 7 days), at which point you get a fresh turn with your tools to actually complete the work and reply. `summary` is what you promised in one line (e.g. 'find Pleasantville last-frost date'). `scope` is the detail you need to remember to do the work (e.g. 'the clinic PlantTalk gave May 15 Front Range; user wants Pleasantville specifically; check Herald and Almanac sources').",
    risk: 'write_internal',
    required_capabilities: [],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      // The runtime injects conversation_id / specialist_id into ctx, so
      // the LLM doesn't pass them — but the idempotency key only sees the
      // input. A ulid in execute() gives us a unique row per call; this
      // key just guards against double-fire from the same tool call.
      const h = createHash('sha256');
      h.update(input.summary);
      h.update('\n');
      h.update(String(input.due_in_minutes ?? DEFAULT_DUE_MINUTES));
      return `followup-call:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      if (!ctx.conversation_id || !ctx.specialist_id) {
        throw new Error(
          'promise_followup requires conversation_id and specialist_id on ToolContext; ' +
            'this tool can only be called from a specialist turn inside a real conversation',
        );
      }
      const due_minutes = input.due_in_minutes ?? DEFAULT_DUE_MINUTES;
      const fire_at = new Date(ctx.now.getTime() + due_minutes * 60_000);
      const followup_id = `flw_${ulid().toLowerCase().slice(-12)}`;
      const idem_key = `followup:${followup_id}`;

      const deliver_body: DeliverFollowupContext = {
        conversation_id: ctx.conversation_id,
        specialist_id: ctx.specialist_id,
        summary: input.summary,
        scope: input.scope,
        promised_at_iso: ctx.now.toISOString(),
        followup_id,
      };

      const context_json = JSON.stringify({
        method: 'POST',
        path: DELIVER_FOLLOWUP_PATH,
        body: deliver_body,
      });

      db.prepare(
        `INSERT INTO scheduled_tasks
           (id, fire_at, intent, context_json, idempotency_key, max_attempts, attempts, status)
         VALUES (@id, @fire_at, @intent, @ctx, @idem, @max, 0, 'pending')
         ON CONFLICT(idempotency_key) DO NOTHING`,
      ).run({
        '@id': followup_id,
        '@fire_at': fire_at.toISOString(),
        '@intent': 'deliver_followup',
        '@ctx': context_json,
        '@idem': idem_key,
        '@max': MAX_ATTEMPTS,
      });

      return {
        followup_id,
        fire_at_iso: fire_at.toISOString(),
        conversation_id: ctx.conversation_id,
      };
    },
  };
}

/**
 * Build the synthetic trigger message handed to runtime.turn() when the
 * scheduler invokes deliver-followup. Phrased so the specialist
 * understands this is a self-prompt to complete promised work, not a new
 * user request. The message is NOT persisted to the conversation.
 *
 * `for_voice` shapes the OUTPUT (not the tool surface) for a followup that
 * was PROMISED on the voice surface — the deliver turn keeps its full chat
 * tools (the work may need web_search etc., which the voice surface lacks),
 * but the reply will be SPOKEN ALOUD on the Satellite1, so it must be one or
 * two plain spoken sentences with no markdown. `strip_markdown_for_speech`
 * (src/core/voice_text.ts) is the deterministic backstop downstream.
 */
export function build_followup_trigger(
  ctx: DeliverFollowupContext,
  now: Date,
  opts?: { for_voice?: boolean },
): string {
  const promised_at = new Date(ctx.promised_at_iso);
  const elapsed_min = Math.max(1, Math.round((now.getTime() - promised_at.getTime()) / 60_000));
  const voice_rules = opts?.for_voice
    ? `\n\nThis reply will be READ ALOUD to the user by a voice — shape it for the ear: ` +
      `one or two natural spoken sentences, no markdown, no lists, no headers. Lead with ` +
      `the answer. Speak it the way a trusted assistant would say it out loud.`
    : '';
  return (
    `[FOLLOW-UP TRIGGER — not a new user message; this is your own scheduled self-prompt]\n\n` +
    `${elapsed_min} minute${elapsed_min === 1 ? '' : 's'} ago you promised the user:\n` +
    `  "${ctx.summary}"\n\n` +
    `Scope of the work you committed to:\n` +
    `  ${ctx.scope}\n\n` +
    `Now do the work and reply in the conversation. Use your tools. Open with a brief ` +
    `continuation cue so the user knows what you're addressing (e.g. "back on the ` +
    `<topic> question..."). Don't restate the whole question; just deliver. If you ` +
    `genuinely need more time, you may call promise_followup again — but only if you ` +
    `made real progress and have a concrete reason. Do not loop.` +
    voice_rules
  );
}
