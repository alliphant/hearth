/**
 * get_health_summary — Astrid's read into HealthKit aggregates.
 *
 * Reads `sensor_packets` where signal='healthkit' for the requested
 * user over a window (7d / 30d), aggregates by sample_type, returns a
 * small digest small enough not to blow the deliberation budget.
 *
 * What's in the digest:
 *   - daily_steps: avg / max / min over the window + count of days
 *     with any data
 *   - sleep: avg hours per night, longest / shortest, samples seen
 *   - resting_hr: latest value, 7-day avg vs prior 7-day avg trend
 *   - hrv: latest value, trend
 *   - activity_ring: latest move_kcal / move_goal_kcal / exercise_min
 *   - workouts: list of {date, type, duration_min, active_kcal,
 *     avg_hr, total_distance_km}, capped at 20 most recent
 *   - body_mass / body_fat_percentage / lean_body_mass: latest +
 *     trend — null when iOS isn't pushing them yet (Withings via
 *     HealthKit auto-sync would deliver these; v0 iOS feeder doesn't
 *     ship them, awaiting schema extension)
 *
 * Empty-state behavior: returns the digest shape with null values when
 * no packets exist (e.g. before the iOS HealthKit feeder is enabled
 * for this user, or for users without an iPhone connected). The tool
 * NEVER throws on missing data — Astrid checks for null and tells the
 * user honestly that she has nothing yet.
 *
 * Capability: read_health. Per-user scope — a specialist with this
 * capability reads only the caller-context user's data.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { ActivityRingValueSchema } from '../../../app/routes/sensors';

const InputSchema = z.object({
  user_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Omit — defaults to the conversation's user (resolved from context), which is the correct member to serve. " +
      "Only set it to explicitly summarize a different household member's health data; never hard-code 'jasper'.",
    ),
  window: z
    .enum(['7d', '30d'])
    .default('7d')
    .describe(
      'Aggregation window. 7d for "what\'s happening this week"; 30d for trend / month-over-month.',
    ),
});

const WorkoutSummary = z.object({
  date: z.string(),
  workout_type: z.string(),
  duration_min: z.number(),
  active_kcal: z.number(),
  avg_hr: z.number().nullable(),
  max_hr: z.number().nullable(),
  min_hr: z.number().nullable(),
  total_distance_km: z.number().nullable(),
  /** Display-units distance (the household reads miles). */
  total_distance_mi: z.number().nullable(),
  elevation_gain_m: z.number().nullable(),
  /** Display-units climb. */
  elevation_gain_ft: z.number().nullable(),
  /** HR drop one minute post-workout (bpm) — higher is fitter; the
   *  Watch computes it after the ride ends. */
  recovery_hr_drop_1min_bpm: z.number().nullable(),
});

const OutputSchema = z.object({
  user_id: z.string(),
  window: z.string(),
  window_start: z.string(),
  window_end: z.string(),
  // Empty state — true when no healthkit packets exist in the window.
  // Astrid keys "I don't have data yet" responses off this so she
  // doesn't claim insight she doesn't have.
  empty: z.boolean(),
  daily_steps: z
    .object({
      days_with_data: z.number(),
      avg: z.number().nullable(),
      max: z.number().nullable(),
      min: z.number().nullable(),
    })
    .nullable(),
  sleep: z
    .object({
      samples: z.number(),
      avg_hours: z.number().nullable(),
      longest_hours: z.number().nullable(),
      shortest_hours: z.number().nullable(),
    })
    .nullable(),
  resting_hr: z
    .object({
      latest_bpm: z.number().nullable(),
      avg_bpm_recent: z.number().nullable(),
      avg_bpm_prior: z.number().nullable(),
      trend: z.enum(['up', 'down', 'flat', 'insufficient_data']),
    })
    .nullable(),
  hrv: z
    .object({
      latest_ms: z.number().nullable(),
      avg_ms_recent: z.number().nullable(),
      trend: z.enum(['up', 'down', 'flat', 'insufficient_data']),
    })
    .nullable(),
  // Latest daily Activity-ring snapshot, parsed into the structured
  // shape. move_kcal / move_goal_kcal is the daily calorie-burn signal
  // Astrid's office surfaces. Null when no ring packet exists in the
  // window; individual fields null when an older percent-only packet is
  // the latest (pre raw-value iOS feeder).
  activity_ring_latest: z
    .object({
      move_kcal: z.number().nullable(),
      move_goal_kcal: z.number().nullable(),
      move_percent: z.number().nullable(),
      exercise_min: z.number().nullable(),
      exercise_goal_min: z.number().nullable(),
      stand_hours: z.number().nullable(),
    })
    .nullable(),
  workouts: z.array(WorkoutSummary),
  body_composition: z
    .object({
      body_mass_kg: z.number().nullable(),
      body_fat_pct: z.number().nullable(),
      lean_mass_kg: z.number().nullable(),
      note: z.string().nullable(),
    })
    .nullable(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

interface PacketRow {
  id: string;
  captured_at: string;
  payload_path: string;
}

interface HealthkitPayloadShape {
  sample_type: string;
  ts_start: string;
  ts_end: string;
  value: number | Record<string, unknown>;
  unit?: string;
  source_device?: string;
}

function window_start(window: '7d' | '30d', now: Date): Date {
  const days = window === '7d' ? 7 : 30;
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days); // time-guard-ok: UTC date arithmetic (rolling window start, no wall-clock render)
  return d;
}

function load_payload(vault_root: string, rel_path: string): HealthkitPayloadShape | null {
  const abs = resolve(vault_root, rel_path);
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, 'utf8')) as HealthkitPayloadShape;
  } catch {
    return null;
  }
}

function days_between_iso(from_iso: string, to_iso: string): number {
  const from = Date.parse(from_iso);
  const to = Date.parse(to_iso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(1, Math.ceil((to - from) / (24 * 60 * 60 * 1000)));
}

function date_part(iso: string): string {
  return iso.slice(0, 10);
}

function trend(recent: number | null, prior: number | null): 'up' | 'down' | 'flat' | 'insufficient_data' {
  if (recent == null || prior == null || prior === 0) return 'insufficient_data';
  const delta_pct = (recent - prior) / prior;
  if (delta_pct > 0.05) return 'up';
  if (delta_pct < -0.05) return 'down';
  return 'flat';
}

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'get_health_summary',
    description:
      "Read HealthKit aggregates for a household member over a 7d or 30d window. Returns daily steps avg, sleep, resting HR, HRV trend, latest activity-ring, recent workouts list, and body composition (when iOS pushes it via Withings → Apple Health). Returns `empty: true` with all null fields when no packets exist yet — Astrid uses this to say 'I have no data on you yet' honestly instead of guessing. Capability: read_health.",
    risk: 'read',
    required_capabilities: ['read_health'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.user_id ?? '');
      h.update('\n');
      h.update(input.window);
      return `get_health_summary:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      // user_id is ambient (the conversation's user), not model-supplied.
      const user_id = input.user_id ?? ctx.user?.id;
      if (!user_id) {
        throw new Error('get_health_summary: no user on ToolContext and no user_id override.');
      }
      const now = new Date();
      const start = window_start(input.window, now);
      const start_iso = start.toISOString();
      const end_iso = now.toISOString();

      const rows = deps.db
        .prepare(
          `SELECT id, captured_at, payload_path FROM sensor_packets
           WHERE user_id = @u AND signal = 'healthkit' AND captured_at >= @since
           ORDER BY captured_at ASC`,
        )
        .all({ '@u': user_id, '@since': start_iso }) as PacketRow[];

      const empty_response: Output = {
        user_id,
        window: input.window,
        window_start: start_iso,
        window_end: end_iso,
        empty: true,
        daily_steps: null,
        sleep: null,
        resting_hr: null,
        hrv: null,
        activity_ring_latest: null,
        workouts: [],
        body_composition: null,
      };

      if (rows.length === 0) {
        return empty_response;
      }

      // Bucket payloads by sample_type for the per-type aggregations.
      const by_type = new Map<string, Array<{ row: PacketRow; payload: HealthkitPayloadShape }>>();
      for (const row of rows) {
        const payload = load_payload(deps.vault_root, row.payload_path);
        if (!payload) continue;
        const bucket = by_type.get(payload.sample_type) ?? [];
        bucket.push({ row, payload });
        by_type.set(payload.sample_type, bucket);
      }

      // ── Daily steps ────────────────────────────────────────────────────
      // iOS pushes one packet per day with a step total. Aggregate across
      // the window for avg/min/max.
      let daily_steps: Output['daily_steps'] = null;
      const steps_packets = by_type.get('steps') ?? [];
      if (steps_packets.length > 0) {
        // De-dupe by date_part so a same-day re-push doesn't double-count.
        const per_day = new Map<string, number>();
        for (const { payload } of steps_packets) {
          if (typeof payload.value !== 'number') continue;
          const day = date_part(payload.ts_end);
          per_day.set(day, payload.value);
        }
        if (per_day.size > 0) {
          const vals = [...per_day.values()];
          const sum = vals.reduce((a, b) => a + b, 0);
          daily_steps = {
            days_with_data: per_day.size,
            avg: Math.round(sum / per_day.size),
            max: Math.max(...vals),
            min: Math.min(...vals),
          };
        }
      }

      // ── Sleep ──────────────────────────────────────────────────────────
      // Sleep packets carry minutes-asleep per night (iOS pre-aggregates).
      let sleep: Output['sleep'] = null;
      const sleep_packets = by_type.get('sleep') ?? [];
      if (sleep_packets.length > 0) {
        const per_night = new Map<string, number>();
        for (const { payload } of sleep_packets) {
          if (typeof payload.value !== 'number') continue;
          const day = date_part(payload.ts_end);
          // Take the max if a night has multiple samples (sometimes iOS
          // sends partial + final). Conservative: don't sum, just pick
          // the largest record for that date.
          const prev = per_night.get(day) ?? 0;
          per_night.set(day, Math.max(prev, payload.value));
        }
        if (per_night.size > 0) {
          const hours = [...per_night.values()].map((m) => m / 60);
          const sum = hours.reduce((a, b) => a + b, 0);
          sleep = {
            samples: per_night.size,
            avg_hours: Math.round((sum / per_night.size) * 10) / 10,
            longest_hours: Math.round(Math.max(...hours) * 10) / 10,
            shortest_hours: Math.round(Math.min(...hours) * 10) / 10,
          };
        }
      }

      // ── Resting HR ─────────────────────────────────────────────────────
      // hr packets carry resting HR (iOS sends restingHeartRate via this
      // sample_type per the existing feeder). Trend = recent half avg vs
      // prior half avg (within window).
      let resting_hr: Output['resting_hr'] = null;
      const hr_packets = by_type.get('hr') ?? [];
      if (hr_packets.length > 0) {
        const numeric = hr_packets
          .filter((p) => typeof p.payload.value === 'number')
          .map((p) => ({ ts: p.payload.ts_end, bpm: p.payload.value as number }));
        if (numeric.length > 0) {
          numeric.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
          const latest = numeric[numeric.length - 1]?.bpm ?? null;
          const mid = Math.floor(numeric.length / 2);
          const recent_avg =
            numeric.length >= 2
              ? numeric.slice(mid).reduce((a, b) => a + b.bpm, 0) / Math.max(numeric.length - mid, 1)
              : null;
          const prior_avg =
            numeric.length >= 4
              ? numeric.slice(0, mid).reduce((a, b) => a + b.bpm, 0) / Math.max(mid, 1)
              : null;
          resting_hr = {
            latest_bpm: latest != null ? Math.round(latest) : null,
            avg_bpm_recent: recent_avg != null ? Math.round(recent_avg) : null,
            avg_bpm_prior: prior_avg != null ? Math.round(prior_avg) : null,
            trend: trend(recent_avg, prior_avg),
          };
        }
      }

      // ── HRV ────────────────────────────────────────────────────────────
      let hrv: Output['hrv'] = null;
      const hrv_packets = by_type.get('hrv') ?? [];
      if (hrv_packets.length > 0) {
        const numeric = hrv_packets
          .filter((p) => typeof p.payload.value === 'number')
          .map((p) => ({ ts: p.payload.ts_end, ms: p.payload.value as number }));
        if (numeric.length > 0) {
          numeric.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
          const latest = numeric[numeric.length - 1]?.ms ?? null;
          const mid = Math.floor(numeric.length / 2);
          const recent_avg =
            numeric.length >= 2
              ? numeric.slice(mid).reduce((a, b) => a + b.ms, 0) / Math.max(numeric.length - mid, 1)
              : null;
          const prior_avg =
            numeric.length >= 4
              ? numeric.slice(0, mid).reduce((a, b) => a + b.ms, 0) / Math.max(mid, 1)
              : null;
          hrv = {
            latest_ms: latest != null ? Math.round(latest) : null,
            avg_ms_recent: recent_avg != null ? Math.round(recent_avg) : null,
            trend: trend(recent_avg, prior_avg),
          };
        }
      }

      // ── Activity ring (latest only — the daily snapshot already encodes
      // the day's progress; older snapshots are less interesting at digest
      // scale) ──────────────────────────────────────────────────────────
      let activity_ring_latest: Output['activity_ring_latest'] = null;
      const ring_packets = by_type.get('activity_ring') ?? [];
      if (ring_packets.length > 0) {
        const last = ring_packets[ring_packets.length - 1];
        if (last && typeof last.payload.value === 'object' && last.payload.value !== null) {
          const parsed = ActivityRingValueSchema.safeParse(last.payload.value);
          if (parsed.success) {
            const r = parsed.data;
            activity_ring_latest = {
              move_kcal: r.move_kcal != null ? Math.round(r.move_kcal) : null,
              move_goal_kcal: r.move_goal_kcal != null ? Math.round(r.move_goal_kcal) : null,
              move_percent: r.move_percent != null ? Math.round(r.move_percent) : null,
              exercise_min: r.exercise_min != null ? Math.round(r.exercise_min) : null,
              exercise_goal_min: r.exercise_goal_min != null ? Math.round(r.exercise_goal_min) : null,
              stand_hours: r.stand_hours != null ? Math.round(r.stand_hours) : null,
            };
          }
        }
      }

      // ── Workouts — list of recent sessions ────────────────────────────
      // Delegate to MemoryClient.query_workouts (the structured read over
      // the healthkit workout packets) instead of re-parsing inline —
      // one owner for "what workouts happened in this window," shared with
      // the rest of Astrid's office. Already newest-first + capped at 20.
      const workouts: Output['workouts'] = deps.memory.query_workouts(user_id, input.window).map((r) => ({
        ...r,
        total_distance_mi:
          r.total_distance_km != null ? Math.round((r.total_distance_km / 1.609344) * 10) / 10 : null,
        elevation_gain_ft: r.elevation_gain_m != null ? Math.round(r.elevation_gain_m * 3.28084) : null,
      }));

      // ── Body composition — placeholder for Withings-via-HealthKit ─────
      // iOS feeder doesn't push body_mass / body_fat / lean_mass yet
      // (the existing sample_type enum doesn't include those — would
      // need a schema bump + iOS extension). When that lands, this block
      // populates from the latest sample per type. For now: null with a
      // note so Astrid says "Withings sync isn't piped to me yet" instead
      // of guessing.
      const body_composition: Output['body_composition'] = {
        body_mass_kg: null,
        body_fat_pct: null,
        lean_mass_kg: null,
        note: 'iOS HealthKit feeder does not yet push body composition sample types; awaiting schema extension.',
      };

      // Don't count days_between in the response — useful only to the
      // caller if they want to compute per-day rates themselves, which
      // the daily_steps section already exposes. Skip.
      void days_between_iso;

      return {
        user_id,
        window: input.window,
        window_start: start_iso,
        window_end: end_iso,
        empty: false,
        daily_steps,
        sleep,
        resting_hr,
        hrv,
        activity_ring_latest,
        workouts,
        body_composition,
      };
    },
  };
}
