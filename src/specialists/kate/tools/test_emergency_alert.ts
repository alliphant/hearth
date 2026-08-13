/**
 * test_emergency_alert — Kate's on-demand drill of the household emergency
 * broadcast (2026-06-24).
 *
 * The dangerous-weather driver fires autonomously on REAL danger; this is the
 * MANUAL counterpart the owner can ask Kate for ("test the emergency alert"),
 * by voice or chat. It fires a clearly-labeled "this is only a test" through
 * BOTH channels at once — the SAME live path a real lightning/tornado/flood
 * alert uses, so it's a true end-to-end test:
 *   1. Satellite1: an alert tone (critical EAS attention tone or the gentle
 *      notice chime) + Kate speaking the test, if anyone's home + near it.
 *   2. Push: a high-severity push to the household's phones.
 *
 * Doing BOTH is the tool's job, not the model's — the LLM only has to call this
 * one tool (the "don't depend on the model to chain two deliveries" lesson from
 * the driver). Owner/household-gated; friends + synthetic/test accounts never
 * receive it (mirrors the driver's recipient rule).
 */
import { z } from 'zod';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import type { UserRegistry } from '@core/users';
import { require_caller_tier } from '@core/tool_gates';
import { push_text_to_user } from '@policy/push';
import { try_speak_followup } from '@core/voice_announce';
import { is_synthetic_account } from '@core/dangerous_weather';
import { maybe_flash_emergency_lights } from '@core/emergency_lights';

const InputSchema = z
  .object({
    /** Which tone to test — 'critical' = the EAS attention alarm (default,
     *  since "the emergency broadcast" means the real thing), 'notice' = the
     *  gentle chime used for routine lightning/wind. */
    tone: z.enum(['critical', 'notice']).optional(),
  })
  .strict();

const OutputSchema = z.object({
  ok: z.boolean(),
  tone: z.enum(['critical', 'notice']),
  spoke: z.boolean(),
  spoke_reason: z.string(),
  pushed_to: z.array(z.string()),
  next_action: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const TEST_SPOKEN =
  'This is Kate, with a test of the household emergency alert system. This is only a test. If this were a real emergency, I would tell you what is happening and what to do.';
const TEST_PUSH =
  '🔔 TEST — household emergency alert system. This is only a test. A real alert would tell you what is happening and what to do.';

/** Injectable for the smoke; defaults to the real speak + push primitives. */
export interface EmergencyTestDelivery {
  speak(text: string, summary: string, tone: 'critical' | 'notice'): Promise<{ spoken: boolean; reason: string }>;
  push(user_id: string, text: string): Promise<boolean>;
}

function default_delivery(): EmergencyTestDelivery {
  return {
    speak: async (text, summary, tone) =>
      try_speak_followup({
        text,
        conversation_id: 'emergency-test',
        summary,
        pre_tone: tone,
        coordinator_url: process.env.HEARTH_VOICE_COORDINATOR_URL,
        bearer: process.env.HEARTH_INTERNAL_BEARER,
        // We push every household member explicitly below, so the speak path's
        // own push-fallback would double-notify — make it a no-op.
        push: async () => true,
      }).then((r) => ({ spoken: r.spoken, reason: r.reason })),
    push: async (user_id, text) => {
      const res = await push_text_to_user(user_id, text, {
        kind: 'ad_hoc',
        severity: 'high', // same as a real alert — pierces quiet hours + read-the-room
        originating_specialist_id: 'kate',
      });
      return Boolean(res.delivered || res.queued || res.via === 'audit_only');
    },
  };
}

export function make_test_emergency_alert(
  users: UserRegistry | undefined,
  delivery: EmergencyTestDelivery = default_delivery(),
): Tool<Input, Output> {
  return {
    name: 'test_emergency_alert',
    description:
      "Run a TEST of the household emergency-alert system on demand. Fires a clearly-labeled \"this is only a test\" through BOTH channels at once — the Satellite1 (an alert tone + you speaking the test, if anyone's home + near it) AND a high-priority push to the household's phones — exactly the live path a real lightning / tornado / flood alert uses. Call this when the owner asks to test the emergency broadcast / alert notifications (by voice or chat). `tone`: 'critical' = the EAS attention alarm (the default), 'notice' = the gentle chime. Returns whether it spoke aloud and which phones it pushed; relay that back warmly.",
    risk: 'write_internal', // notifies OUR own household on OUR own channels; no external send → auto-approved
    required_capabilities: ['test_emergency_alert'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    yield: { none: true, reason: 'a manual drill — it fires a labeled test alert and writes no rows' },
    idempotency_key(input) {
      return `test_emergency_alert:${input.tone ?? 'critical'}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      // The household may drill it; friends defer to Kate.
      require_caller_tier(ctx, ['owner', 'household']);
      const tone = input.tone ?? 'critical';

      // Satellite1 (presence-gated by the coordinator).
      let spoke = false;
      let spoke_reason = 'no_coordinator';
      try {
        const r = await delivery.speak(TEST_SPOKEN, 'Emergency alert system test', tone);
        spoke = r.spoken;
        spoke_reason = r.reason;
      } catch (err) {
        spoke_reason = `error:${(err as Error).name}`;
      }

      // Push to every real household member (owner + household; never friend or
      // a synthetic/test account — same rule as a real alert).
      const recipients = (users?.list() ?? [])
        .filter((u) => u.tier === 'owner' || u.tier === 'household')
        .filter((u) => !is_synthetic_account(u))
        .map((u) => u.id);
      const pushed_to: string[] = [];
      for (const uid of recipients) {
        try {
          if (await delivery.push(uid, TEST_PUSH)) pushed_to.push(uid);
        } catch {
          /* skip a failed recipient */
        }
      }

      // Third channel: on a CRITICAL drill, exercise the EBS red-light flash too
      // (so a live-fire test covers the lights). Fire-and-forget + fail-open +
      // gated (HEARTH_EMERGENCY_LIGHT_FLASH); restores all lights after ~5s.
      if (tone === 'critical') maybe_flash_emergency_lights({ memory: ctx.memory });

      const tone_label = tone === 'critical' ? 'the emergency alarm tone' : 'the gentle chime';
      const next_action = spoke
        ? `The test played ${tone_label} aloud on the Satellite1 and pushed to ${pushed_to.join(', ') || 'no phones'}. Tell the user it fired on both channels — speaker and phones.`
        : `No one was near the Satellite1 (${spoke_reason}), so the test pushed to ${pushed_to.join(', ') || 'no phones'} only. Tell the user it reached their phones; the spoken tone + test plays when someone's near the device.`;

      ctx.memory?.log_action?.({
        intent_id: ctx.intent_id || ulid(),
        agent: ctx.specialist_id || 'kate',
        tool_name: 'test_emergency_alert',
        tool_input: { tone },
        execution_result: { spoke, spoke_reason, pushed_to, tone },
      });

      return {
        ok: spoke || pushed_to.length > 0,
        tone,
        spoke,
        spoke_reason,
        pushed_to,
        next_action,
      };
    },
  };
}
