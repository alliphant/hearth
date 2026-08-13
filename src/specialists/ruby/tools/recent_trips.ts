/**
 * Ruby — read the user's recent trips out of the house.
 *
 * get_current_location answers "where are you NOW" (one packet). It can't
 * answer "where did you GO" — the trips by car or bike that the user expects
 * Ruby to be aware of. This tool reconstructs those from the iOS edge events
 * (visit_arrival / departure / region enter-exit / significant_change),
 * assembling them into a newest-first list of visits with arrive/depart
 * times and durations.
 *
 * Travel MODE (car vs bike) rides the optional `motion` field iOS attaches
 * (CMMotionActivity) — surfaced as `arrived_via` when present, omitted with
 * an honest note when iOS hasn't started posting it. The tool never infers
 * the mode from speed or guesses it.
 *
 * Location is the most privileged data in the system. This is an on-demand,
 * audit-logged read gated on the `read_my_location` capability AND a runtime
 * re-check of the privacy allowlist (`location_specialist_allowed`) as
 * defense-in-depth. The audit row records counts only — never coordinates.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import { location_specialist_allowed } from '@core/privacy';
import { summarize_recent_trips } from '@core/location_awareness';

const InputSchema = z.object({
  /** How far back to look. Defaults to 48h — "trips I made recently." */
  lookback_hours: z.number().int().min(1).max(720).default(48),
  /** Cap on visits returned (newest first). */
  max_visits: z.number().int().min(1).max(50).default(15),
});

const VisitSchema = z.object({
  place_label: z.string(),
  arrived_at: z.string().nullable(),
  departed_at: z.string().nullable(),
  duration_minutes: z.number().nullable(),
  arrived_via: z.string().nullable(),
  ongoing: z.boolean(),
});

const OutputSchema = z.object({
  ok: z.boolean(),
  visits: z.array(VisitSchema).optional(),
  event_count: z.number().optional(),
  window_start: z.string().optional(),
  window_end: z.string().optional(),
  motion_available: z.boolean().optional(),
  /** Honest framing for the LLM — e.g. mode-not-recorded, or empty window. */
  note: z.string().optional(),
  error: z.string().optional(),
  recovery_hint: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export const recent_trips: Tool<Input, Output> = {
  name: 'recent_trips',
  description:
    "Read the user's recent trips out of the house — where they went and when, reconstructed from their phone's location history. Call this when the conversation is about somewhere they've been or travel they made. Returns places with arrive/depart times; travel mode (car/bike) only when the phone recorded it.",
  risk: 'read',
  required_capabilities: ['read_my_location'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(`${input.lookback_hours}:${input.max_visits}`);
    return `recent_trips:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    const user_id = ctx.user?.id;
    if (!user_id) {
      return { ok: false, error: 'No user in context — trip history is user-scoped.' };
    }

    const specialist_id = ctx.specialist_id ?? 'ruby';
    if (!location_specialist_allowed(specialist_id)) {
      return {
        ok: false,
        error: `Location access not granted to ${specialist_id}.`,
        recovery_hint:
          'Add the specialist to cross_specialist_sharing.read_my_location_granted_to in config/privacy.yaml.',
      };
    }

    const since_iso = new Date(
      ctx.now.getTime() - input.lookback_hours * 60 * 60 * 1000,
    ).toISOString();
    const events = ctx.memory.list_location_events(user_id, since_iso);
    const summary = summarize_recent_trips(events, { max_visits: input.max_visits });

    let note: string;
    if (summary.event_count === 0) {
      note = `No location events in the last ${input.lookback_hours}h — either nothing was logged or the phone hasn't been posting location.`;
    } else if (!summary.motion_available) {
      note =
        'Travel mode (car vs bike) is not recorded on these trips yet — the phone is sending places and times but not motion type. Report where and when, not how.';
    } else {
      note = 'Travel mode is available on some legs (arrived_via).';
    }

    // Audit redaction: counts only, never coordinates. The trip detail
    // returned to the (location-granted) specialist is not logged.
    ctx.memory.log_action({
      intent_id: ctx.intent_id,
      agent: specialist_id,
      tool_name: 'recent_trips',
      tool_input: { lookback_hours: input.lookback_hours },
      execution_result: {
        visits: summary.visits.length,
        events: summary.event_count,
        motion_available: summary.motion_available,
      },
      user_id,
    });

    return {
      ok: true,
      visits: summary.visits.map((v) => ({
        place_label: v.place_label,
        arrived_at: v.arrived_at,
        departed_at: v.departed_at,
        duration_minutes: v.duration_minutes,
        arrived_via: v.arrived_via,
        ongoing: v.ongoing,
      })),
      event_count: summary.event_count,
      window_start: summary.window_start,
      window_end: summary.window_end,
      motion_available: summary.motion_available,
      note,
    };
  },
};
