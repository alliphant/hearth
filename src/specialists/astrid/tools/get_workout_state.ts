/**
 * get_workout_state — Astrid's read into the live session tracker.
 *
 * Returns the user's currently active workout session, or null when
 * idle. The session shape carries the rolling state heart-rate,
 * elapsed time, active kcal, HR-zone-minutes-so-far — everything
 * Astrid needs to decide whether to push a coaching note.
 *
 * The tracker is in-memory (WorkoutSessionTracker, instantiated at
 * orchestrator boot). It's threaded into this tool via the events
 * bus — see register_tracker below for the wiring.
 *
 * Capability: read_health. Per-user — never reveals another user's
 * active session.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { WorkoutSessionTracker } from '../../../app/routes/workout';

const InputSchema = z.object({
  user_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Omit — defaults to the conversation's user (resolved from context). Only set it to read another household member's live state.",
    ),
});

const SessionSchema = z.object({
  session_id: z.string(),
  workout_type: z.string(),
  started_at: z.string(),
  last_packet_at: z.string(),
  elapsed_s: z.number(),
  active_kcal: z.number(),
  distance_m: z.number().nullable(),
  elevation_gain_m: z.number().nullable(),
  elevation_gain_ft: z.number().nullable(),
  paused: z.boolean(),
  current_hr: z.number().nullable(),
  current_hr_zone: z.number().nullable(),
  hr_zone_minutes: z.object({
    z1: z.number(),
    z2: z.number(),
    z3: z.number(),
    z4: z.number(),
    z5: z.number(),
  }),
  pushes_sent_count: z.number(),
  last_push_at: z.string().nullable(),
  prior_pr_metric: z.object({
    metric: z.string(),
    value: z.number(),
  }).nullable(),
});

const OutputSchema = z.object({
  user_id: z.string(),
  active: z.boolean(),
  session: SessionSchema.nullable(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

// Module-level reference to the tracker. Set by register_tracker()
// from server.ts at boot. Keeping it as a module singleton (rather
// than threading through ToolDeps) avoids a cross-cutting ToolDeps
// change for a single Astrid-specific tracker.
let _tracker: WorkoutSessionTracker | null = null;

export function register_tracker(tracker: WorkoutSessionTracker): void {
  _tracker = tracker;
}

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'get_workout_state',
    description:
      "Read the user's currently active workout session (in-memory live state). Returns active=false with session=null when the user isn't mid-workout. Returns rolling stats — HR, kcal, elapsed, HR-zone minutes — Astrid uses to decide whether/when to push a coaching note.",
    risk: 'read',
    required_capabilities: ['read_health'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.user_id ?? '');
      // Intentionally NOT including time — the call is fast enough
      // that two calls in the same turn returning the same cached
      // result is fine; deduping at the tool registry level is OK.
      return `get_workout_state:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      // user_id is ambient (the conversation's user), not model-supplied.
      const user_id = input.user_id ?? ctx.user?.id;
      if (!user_id) {
        throw new Error('get_workout_state: no user on ToolContext and no user_id override.');
      }
      // Rolling state comes through MemoryClient (the warm
      // workout_sessions row) so the read survives an orchestrator
      // restart even before a heartbeat rehydrates the tracker. The
      // in-memory tracker is consulted ONLY for the ephemeral
      // push-ledger (count + last-push time), which isn't persisted —
      // post-restart it reads 0/null until the session ends.
      const snap = deps.memory.query_active_workout(user_id);
      if (!snap || snap.stale) {
        // No active row, or a stale one (dead stream whose end packet
        // never arrived) — either way Astrid is NOT tracking a ride.
        return { user_id, active: false, session: null };
      }
      const tracked = _tracker?.get(snap.session_id) ?? null;
      const started_ms = Date.parse(snap.started_at);
      const elapsed_s =
        snap.elapsed_s ??
        (Number.isFinite(started_ms) ? Math.max(0, Math.floor((Date.now() - started_ms) / 1000)) : 0);
      const pushes = tracked?.pushes_sent_at ?? [];
      return {
        user_id,
        active: true,
        session: {
          session_id: snap.session_id,
          workout_type: snap.workout_type,
          started_at: snap.started_at,
          last_packet_at: snap.last_packet_at ?? snap.started_at,
          elapsed_s,
          active_kcal: snap.active_kcal ?? 0,
          distance_m: snap.distance_m,
          elevation_gain_m: snap.elevation_gain_m,
          elevation_gain_ft: snap.elevation_gain_m != null ? Math.round(snap.elevation_gain_m * 3.28084) : null,
          paused: snap.paused,
          current_hr: snap.current_hr,
          current_hr_zone: snap.current_hr_zone,
          hr_zone_minutes: snap.hr_zone_minutes,
          pushes_sent_count: pushes.length,
          last_push_at: pushes.length > 0 ? pushes[pushes.length - 1]! : null,
          prior_pr_metric: tracked?.prior_pr_metric ?? null,
        },
      };
    },
  };
}
