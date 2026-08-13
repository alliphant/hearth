/**
 * announce_on_device — Kate speaks an ARBITRARY sentence aloud on the household
 * Satellite1 / house speaker, on command (2026-07-21).
 *
 * THE GAP THIS CLOSES. The full plumbing to make Kate say something out loud in
 * the room already existed and worked — `try_speak_followup` → the voice
 * coordinator's `/speak` route → forza TTS → the device `media_player`,
 * presence-gated, fail-open to push. But the ONLY specialist-callable door into
 * it was `test_emergency_alert`, which ignores its input and speaks a fixed
 * "this is only a test" drill string. So when the owner typed "say hi to Kyle on
 * the speaker," there was literally no tool Kate could call — she could only
 * answer in prose. She did nothing of the sort, correctly, because nothing of
 * the sort was reachable.
 *
 * This is that missing door: a thin wrapper that exposes the SAME proven speak
 * path to free text. It is the first "terminal act as a real, composable tool"
 * — the wedge for the tool-composition spine. It deliberately does NOT push:
 * announce = the speaker only. If nobody's near it, Kate relays that honestly
 * and can compose `message_user` if the owner wants it on phones instead. One
 * lego, one job; chains are built from clean single-purpose legos, not from
 * tools that secretly do three things.
 *
 * Risk is `write_internal` (speaks on OUR device to OUR household, no external
 * send) → auto-approved, exactly like the emergency drill. The guardrail lives
 * where the EFFECT is: caller-tier (owner/household), the coordinator's physical
 * presence latch, and the audit row — not a proposal queue. This tool can never
 * fire the EAS alarm tone: `chime` maps only to the gentle notice chime, never
 * `critical`, which stays emergency-only.
 */
import { z } from 'zod';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import { require_caller_tier } from '@core/tool_gates';
import { try_speak_followup } from '@core/voice_announce';
import { strip_markdown_for_speech } from '@core/voice_text';

const InputSchema = z
  .object({
    /** What to say out loud, verbatim. Plain speakable prose — markdown is
     *  stripped before it reaches the TTS voice. */
    text: z.string().min(1).max(400),
    /** Play a gentle attention chime BEFORE the words (e.g. an announcement to
     *  the room). Default false — most greetings/messages want no tone. Never
     *  fires the critical EAS alarm; that's emergency-only. */
    chime: z.boolean().optional(),
  })
  .strict();

const OutputSchema = z.object({
  ok: z.boolean(),
  spoken: z.boolean(),
  reason: z.string(),
  next_action: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/** Injectable for the smoke; defaults to the real coordinator speak path. */
export interface AnnounceDelivery {
  speak(text: string, summary: string, chime: boolean): Promise<{ spoken: boolean; reason: string }>;
}

function default_delivery(): AnnounceDelivery {
  return {
    speak: async (text, summary, chime) =>
      try_speak_followup({
        text,
        conversation_id: 'announce',
        summary,
        pre_tone: chime ? 'notice' : undefined,
        coordinator_url: process.env.HEARTH_VOICE_COORDINATOR_URL,
        bearer: process.env.HEARTH_INTERNAL_BEARER,
        // announce = speaker only. No push fallback — if no one's near, Kate
        // reports that honestly and can compose message_user on request.
        push: async () => false,
      }).then((r) => ({ spoken: r.spoken, reason: r.reason })),
  };
}

export function make_announce_on_device(
  delivery: AnnounceDelivery = default_delivery(),
): Tool<Input, Output> {
  return {
    name: 'announce_on_device',
    description:
      "Speak a message aloud RIGHT NOW on the household Satellite1 / house speaker. Use this whenever the owner wants you to say something out loud in the room — \"say hi to Kyle on the speaker\", \"announce that dinner's ready\", \"tell the house I'm heading out\", \"read this to the kitchen\". `text` is exactly what you'll say (plain speech; markdown is stripped). `chime: true` plays a soft attention chime first (good for an announcement to the room); default is no tone. It's presence-gated by the device — if no one is near the Satellite1 it won't play, and you'll be told so; relay that honestly and offer to push it to their phone instead (message_user) if they want. Speaker only — it never sends a push itself. Cannot fire the emergency alarm tone (that's test_emergency_alert).",
    risk: 'write_internal', // speaks on OUR device to OUR household; no external send → auto-approved
    required_capabilities: ['announce_on_device'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `announce_on_device:${input.text.slice(0, 64)}:${input.chime ? 'chime' : 'plain'}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      require_caller_tier(ctx, ['owner', 'household'], 'kate');

      const speakable = strip_markdown_for_speech(input.text).trim();
      if (!speakable) {
        return {
          ok: false,
          spoken: false,
          reason: 'empty_after_strip',
          next_action:
            "That message had nothing speakable in it once formatting was removed. Ask the user what they'd like said aloud.",
        };
      }

      let spoken = false;
      let reason = 'no_coordinator';
      try {
        const r = await delivery.speak(speakable, input.text.slice(0, 80), Boolean(input.chime));
        spoken = r.spoken;
        reason = r.reason;
      } catch (err) {
        reason = `error:${(err as Error).name}`;
      }

      const next_action = spoken
        ? `Said it aloud on the Satellite1. Tell the user it played on the speaker.`
        : `It didn't play aloud — no one's near the Satellite1 right now (${reason}). Tell the user honestly, and offer to push it to their phone instead (message_user) if they'd like.`;

      ctx.memory?.log_action?.({
        intent_id: ctx.intent_id || ulid(),
        agent: ctx.specialist_id || 'kate',
        tool_name: 'announce_on_device',
        tool_input: { chars: input.text.length, chime: Boolean(input.chime) },
        execution_result: { spoken, reason },
      });

      return { ok: spoken, spoken, reason, next_action };
    },
  };
}
