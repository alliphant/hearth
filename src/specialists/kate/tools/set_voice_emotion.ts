/**
 * set_voice_emotion — SERVICE MODE (owner-only): pin (or report) Kate's spoken
 * voice register.
 *
 * The owner can tell Kate "speak warmer from now on" / "use your tender voice" /
 * "go back to neutral" / "just read the room" and she persists the choice. The
 * register is applied to her spoken replies on the gapless voice path
 * (`/api/voice/stream` — the web orb + the native iOS/macOS orb) as ONE `instruct`
 * for the whole reply. `auto` hands the tone back to the model (classified once
 * per reply — LAW #1: the model decides the tone; this tool only records the
 * owner's standing PREFERENCE, it doesn't hard-code a per-reply tone).
 *
 * Owner-only, hard-gated at the tool layer (`ctx.user.tier === 'owner'`) — the
 * same cordon as reveal_self. Called with NO `mode` it just reports the current
 * setting (one all-encompassing get/set tool, not two). Persists to kv_settings,
 * the same store the Settings picker writes; nothing here touches personas or
 * routes through Beatrice — it's a per-user preference, not a config change.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { KvSettings } from '@core/users';
import {
  VOICE_EMOTION_MODES,
  VOICE_EMOTION_LABELS,
  VOICE_EMOTION_INTIMATE,
  resolve_voice_emotion_mode,
  set_voice_emotion_mode,
  voice_stream_emotion_enabled,
} from '@core/voice_emotion';

const InputSchema = z.object({
  mode: z
    .enum(VOICE_EMOTION_MODES)
    .optional()
    .describe(
      "The spoken register to pin: 'neutral' (plain, the default), 'auto' (you " +
        "choose the tone per reply), or a fixed tone — 'warm', 'playful', 'calm', " +
        "'reassuring', 'upbeat', 'serious', or the intimate set 'tender' / 'sultry' / " +
        "'flirty' / 'shy'. OMIT `mode` to just report the current setting without " +
        'changing it.',
    ),
});

const OutputSchema = z.object({
  ok: z.boolean(),
  mode: z.string(),
  content_md: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function create_set_voice_emotion(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'set_voice_emotion',
    description:
      'SERVICE MODE (owner-only): pin your spoken VOICE REGISTER, or report it. Call this ' +
      "WHENEVER {{user_name}} tells you how to SOUND from now on — \"speak warmer\", \"use your " +
      'tender/sultry voice", "be more playful", "go back to neutral", "just read the room" (= ' +
      'auto) — or asks what your voice is set to (call with no `mode`). It sets a standing ' +
      'preference applied to your spoken replies; it does NOT change what you say. Owner-only.',
    risk: 'write_internal',
    required_capabilities: ['reveal_self'],
    volatile: true,
    input_schema: InputSchema,
    output_schema: OutputSchema,
    idempotency_key(input) {
      return `set_voice_emotion:${input.mode ?? 'read'}`;
    },
    async execute(input, ctx: ToolContext): Promise<Output> {
      // Owner-only hard gate — the same cordon reveal_self uses.
      if (ctx.user && ctx.user.tier !== 'owner') {
        return {
          ok: false,
          mode: 'neutral',
          content_md:
            "My voice register is the owner's to set — service mode is owner-only.",
        };
      }
      if (!ctx.user?.id) {
        return { ok: false, mode: 'neutral', content_md: "I couldn't tell who's asking." };
      }

      const kv = new KvSettings(deps.db);
      const current = resolve_voice_emotion_mode(kv, ctx.user.id);

      // No mode → report the current setting (get/set in one tool).
      if (!input.mode) {
        const label = VOICE_EMOTION_LABELS[current] ?? current;
        const off = voice_stream_emotion_enabled() ? '' : ' _(spoken-emotion is currently disabled system-wide.)_';
        return {
          ok: true,
          mode: current,
          content_md: `My spoken voice is set to **${label}**.${off}`,
        };
      }

      const mode = input.mode;
      set_voice_emotion_mode(kv, ctx.user.id, mode);

      ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kate',
        tool_name: 'set_voice_emotion',
        tool_input: { mode },
        execution_result: { previous: current, mode },
        user_id: ctx.user.id,
      });

      const label = VOICE_EMOTION_LABELS[mode] ?? mode;
      const intimate = VOICE_EMOTION_INTIMATE.has(mode);
      const note = !voice_stream_emotion_enabled()
        ? ' _(Heads up: spoken-emotion is disabled system-wide right now, so this takes effect once it’s turned on.)_'
        : mode === 'auto'
          ? " I’ll read each reply and pick the tone that fits."
          : mode === 'neutral'
            ? ''
            : intimate
              ? ' Just for you.'
              : '';
      return {
        ok: true,
        mode,
        content_md: `Done — my spoken voice is now **${label}**.${note}`,
      };
    },
  };
}
