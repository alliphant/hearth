/**
 * Live workout streaming route (Astrid Pass 3).
 *
 *   POST /api/workout    ingest a WorkoutPacket {session_id, kind, captured_at, payload}
 *   GET  /api/workout/active   peek active sessions (debug + Astrid tool)
 *
 * Mounted at /api/workout (NOT /api/sensors/workout) to avoid colliding
 * with the existing /api/sensors/:signal pattern — if the workout
 * router were nested under /api/sensors, the sensors router's :signal
 * handler would match POST /api/sensors/workout first as a generic
 * sensor packet with signal='workout', shadowing this router entirely.
 *
 * Distinct from the existing /api/sensors/healthkit route — different
 * cadence (per-30s heartbeat vs daily snapshot), different consumers
 * (live throttle/coaching vs Brigid handoff), different persistence
 * (workout_sessions header + in-memory tracker vs sensor_packets vault
 * file). On session-end packets the route ALSO writes a healthkit
 * sample_type='workout' row so the Pass 2 Astrid awareness handler
 * still fires Brigid's recovery-snack flag without changing that path.
 *
 * Architecture:
 *   - start    → INSERT workout_sessions row (status='active') +
 *                tracker.open(session) + emit workout_started
 *   - heartbeat → tracker.update(session, snapshot) +
 *                 emit workout_packet
 *   - end      → UPDATE workout_sessions row (status='completed') +
 *                tracker.close(session) + write sensor_packets row
 *                (signal='healthkit', sample_type='workout') +
 *                emit workout_completed
 *
 * Auth: required (same middleware as /api/sensors). Rate limit:
 * 120 packets/min per (user, signal=workout) — a 60-min session at
 * 30s heartbeats is 120 packets, so the cap is tight but not
 * suffocating. Burst tolerated via the same in-memory bucket as the
 * other sensor signals.
 *
 * Session state across packets — see WorkoutSessionTracker below.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulid';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { MemoryClient } from '@memory/client';
import type { AppEventBus } from '../events';
import { WorkoutCueStore, clip_content_type } from '@memory/stores/workout_cues';
import { WorkoutRouteStore } from '@memory/stores/workout_routes';
import { local_iso_date } from '@core/time';

// ── Payload schemas ──────────────────────────────────────────────────────

export const WorkoutStartPayload = z
  .object({
    workout_type: z.string().min(1).max(80),
    planned_duration_min: z.number().int().positive().nullable().optional(),
    /** iOS computes the user's PR for this workout_type+metric locally
     *  when known and ships it here so Astrid's first turn already has
     *  the "what counts as in-reach" anchor. Optional — backend's PR
     *  shelf is the authoritative source if absent. */
    prior_pr_metric: z
      .object({
        metric: z.enum(['longest_seconds', 'longest_distance_m', 'highest_active_kcal']),
        value: z.number().positive(),
      })
      .optional(),
  })
  .strict();

export const WorkoutHeartbeatPayload = z
  .object({
    elapsed_s: z.number().int().nonnegative(),
    active_kcal: z.number().nonnegative(),
    distance_m: z.number().nonnegative().nullable().optional(),
    pace_s_per_km: z.number().nonnegative().nullable().optional(),
    current_hr: z.number().nonnegative().nullable().optional(),
    current_hr_zone: z.number().int().min(1).max(5).nullable().optional(),
    /** Cumulative barometric elevation gain (m) since session start —
     *  iOS accumulates positive CMAltimeter deltas. Feeds the climb
     *  detectors + the Ride Log elevation curve. */
    elevation_gain_m: z.number().nonnegative().nullable().optional(),
    /** Device autopause state (the Watch detected a stop and paused the
     *  HKWorkoutSession). Heartbeats keep flowing while paused with
     *  frozen elapsed/distance; the live throttle goes silent and the
     *  pane shows the paused state. Optional — pre-autopause clients
     *  never send it. */
    paused: z.boolean().optional(),
    /** Live position for route recognition (owner-requested 2026-06-12).
     *  Memory-only on the server: feeds the in-RAM live track for
     *  route matching, never persisted per-heartbeat, never audited. */
    lat: z.number().min(-90).max(90).nullable().optional(),
    lon: z.number().min(-180).max(180).nullable().optional(),
    hr_zone_minutes_so_far: z
      .object({
        z1: z.number().nonnegative().default(0),
        z2: z.number().nonnegative().default(0),
        z3: z.number().nonnegative().default(0),
        z4: z.number().nonnegative().default(0),
        z5: z.number().nonnegative().default(0),
      })
      .partial()
      .optional(),
  })
  .strict();

export const WorkoutEndPayload = z
  .object({
    workout_type: z.string().min(1).max(80),
    duration_s: z.number().int().nonnegative(),
    active_kcal: z.number().nonnegative(),
    total_distance_m: z.number().nonnegative().nullable().optional(),
    avg_hr: z.number().nonnegative().nullable().optional(),
    max_hr: z.number().nonnegative().nullable().optional(),
    /** Total barometric elevation gain for the session (m). */
    elevation_gain_m: z.number().nonnegative().nullable().optional(),
    /** Watch-estimated average cycling power (W), when the session
     *  produced power samples. Re-scoped IN 2026-06-11 for ride-name /
     *  recap evidence (see astrid-cycling-metrics-scope). */
    avg_power_w: z.number().nonnegative().nullable().optional(),
    /** On-device-derived route descriptors — road/place NAMES only
     *  ("Lookout Mountain Rd", "Clear Creek path"). Coordinates never
     *  leave the phone (design §10); these strings are the deliberate,
     *  bounded exception that lets the ride name know its roads. */
    route_notes: z.array(z.string().min(1).max(120)).max(12).optional(),
    hr_zone_minutes: z
      .object({
        z1: z.number().nonnegative().default(0),
        z2: z.number().nonnegative().default(0),
        z3: z.number().nonnegative().default(0),
        z4: z.number().nonnegative().default(0),
        z5: z.number().nonnegative().default(0),
      })
      .partial()
      .optional(),
  })
  .strict();

export const WorkoutRoutePayload = z
  .object({
    points: z
      .array(
        z.object({
          t: z.string().min(1),
          lat: z.number().min(-90).max(90),
          lon: z.number().min(-180).max(180),
          ele: z.number().nullable().optional(),
        }),
      )
      .min(2)
      .max(4000),
  })
  .strict();

const WorkoutPacketEnvelope = z
  .object({
    session_id: z.string().min(1).max(64),
    kind: z.enum(['start', 'heartbeat', 'end', 'route']),
    captured_at: z.string().min(1),
    payload: z.unknown(),
  })
  .strict();

// ── In-memory session tracker ────────────────────────────────────────────
// Per active session: rolling state Astrid's live-mode tools read
// (current HR, kcal so far, last-push timestamp for throttle, HR zone
// minutes). Cleaned up on workout_completed; orphaned sessions older
// than 6h are GC'd by the periodic sweep so a never-ended workout
// (iOS crashed mid-session) doesn't leak forever.

export interface ActiveWorkoutSession {
  session_id: string;
  user_id: string;
  workout_type: string;
  started_at: string;
  last_packet_at: string;
  elapsed_s: number;
  active_kcal: number;
  distance_m: number | null;
  current_hr: number | null;
  current_hr_zone: number | null;
  /** Cumulative barometric elevation gain (m) so far; null until the
   *  device reports it. */
  elevation_gain_m: number | null;
  hr_zone_minutes: { z1: number; z2: number; z3: number; z4: number; z5: number };
  /** Device autopause state from the latest heartbeat. */
  paused: boolean;
  /** Latest live position (memory-only, route recognition). */
  lat: number | null;
  lon: number | null;
  /** ISO timestamps of every coaching push sent during this session.
   *  Used by the throttle subscriber for the 10-min hard cap +
   *  15-min check-in budget. */
  pushes_sent_at: string[];
  /** iOS-shipped PR anchor if known; null = no prior record. */
  prior_pr_metric: { metric: string; value: number } | null;
}

const ORPHAN_GC_MS = 6 * 60 * 60 * 1000; // 6 hours
const ORPHAN_GC_INTERVAL_MS = 30 * 60 * 1000; // sweep every 30 min

// Stale-active reaper (2026-06-13): a session whose `end` packet never
// arrived (app killed at teardown, lost relay) sits status='active'
// forever — the in-memory orphan GC only cleans the tracker, not the
// DB row, so the pane + chat tool keep reading it as a live ride. The
// reaper finalizes any active row silent longer than REAP_MS to
// 'abandoned' (NOT 'completed' — there's no real end packet, so no
// totals/PRs; abandoned rows are filtered from every read). Conservative
// by design: a one-way finalization, threshold well past any plausible
// connectivity gap. The non-destructive `stale` read-guard already hides
// these from the UI; the reaper is DB hygiene.
const REAP_INTERVAL_MS = 10 * 60 * 1000; // sweep every 10 min

function reap_ms(): number {
  return Number(process.env.HEARTH_WORKOUT_REAP_MIN ?? '60') * 60_000;
}

export function reap_stale_active_sessions(
  db: Database,
  memory: MemoryClient,
  tracker: WorkoutSessionTracker,
): number {
  const cutoff = new Date(Date.now() - reap_ms()).toISOString();
  let rows: Array<{ session_id: string; user_id: string; last_packet_at: string | null }> = [];
  try {
    rows = db
      .prepare(
        `SELECT session_id, user_id, last_packet_at
           FROM workout_sessions
          WHERE status = 'active'
            AND COALESCE(last_packet_at, started_at) < @cut`,
      )
      .all({ '@cut': cutoff }) as typeof rows;
  } catch (err) {
    console.error(`[workout] reaper query failed: ${(err as Error).message}`);
    return 0;
  }
  for (const row of rows) {
    try {
      db.prepare("UPDATE workout_sessions SET status = 'abandoned' WHERE session_id = @s AND status = 'active'").run({
        '@s': row.session_id,
      });
      tracker.close(row.session_id);
      memory.log_action({
        intent_id: `workout_reap:${row.session_id}`,
        agent: 'orchestrator',
        tool_name: 'workout_session_reaped',
        tool_input: { session_id: row.session_id },
        execution_result: { reason: 'stale_active_no_end_packet', last_packet_at: row.last_packet_at },
      });
    } catch (err) {
      console.error(`[workout] reaper failed for ${row.session_id}: ${(err as Error).message}`);
    }
  }
  if (rows.length > 0) {
    console.log(`[workout] reaper finalized ${rows.length} stale active session(s) → abandoned`);
  }
  return rows.length;
}

export class WorkoutSessionTracker {
  private sessions = new Map<string, ActiveWorkoutSession>();
  private gc_timer: ReturnType<typeof setInterval> | null = null;

  start_gc(): void {
    if (this.gc_timer) return;
    this.gc_timer = setInterval(() => this.gc_orphans(), ORPHAN_GC_INTERVAL_MS);
  }

  stop_gc(): void {
    if (this.gc_timer) {
      clearInterval(this.gc_timer);
      this.gc_timer = null;
    }
  }

  open(session: Omit<ActiveWorkoutSession, 'pushes_sent_at' | 'elapsed_s' | 'active_kcal' | 'distance_m' | 'current_hr' | 'current_hr_zone' | 'elevation_gain_m' | 'hr_zone_minutes' | 'last_packet_at' | 'paused' | 'lat' | 'lon'> & {
    last_packet_at: string;
  }): void {
    this.sessions.set(session.session_id, {
      ...session,
      elapsed_s: 0,
      active_kcal: 0,
      distance_m: null,
      current_hr: null,
      current_hr_zone: null,
      elevation_gain_m: null,
      paused: false,
      lat: null,
      lon: null,
      hr_zone_minutes: { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 },
      pushes_sent_at: [],
    });
  }

  update(session_id: string, snapshot: {
    captured_at: string;
    elapsed_s: number;
    active_kcal: number;
    distance_m: number | null;
    current_hr: number | null;
    current_hr_zone: number | null;
    elevation_gain_m?: number | null;
    paused?: boolean;
    lat?: number | null;
    lon?: number | null;
    hr_zone_minutes_so_far?: Partial<{ z1: number; z2: number; z3: number; z4: number; z5: number }>;
  }): ActiveWorkoutSession | null {
    const session = this.sessions.get(session_id);
    if (!session) return null;
    session.last_packet_at = snapshot.captured_at;
    session.elapsed_s = snapshot.elapsed_s;
    session.active_kcal = snapshot.active_kcal;
    session.distance_m = snapshot.distance_m;
    session.current_hr = snapshot.current_hr;
    session.current_hr_zone = snapshot.current_hr_zone;
    if (snapshot.elevation_gain_m !== undefined) {
      session.elevation_gain_m = snapshot.elevation_gain_m;
    }
    if (snapshot.paused !== undefined) {
      session.paused = snapshot.paused;
    }
    if (snapshot.lat !== undefined) session.lat = snapshot.lat;
    if (snapshot.lon !== undefined) session.lon = snapshot.lon;
    if (snapshot.hr_zone_minutes_so_far) {
      for (const k of ['z1', 'z2', 'z3', 'z4', 'z5'] as const) {
        const v = snapshot.hr_zone_minutes_so_far[k];
        if (typeof v === 'number') session.hr_zone_minutes[k] = v;
      }
    }
    return session;
  }

  record_push(session_id: string, at_iso: string): void {
    const session = this.sessions.get(session_id);
    if (!session) return;
    session.pushes_sent_at.push(at_iso);
  }

  close(session_id: string): ActiveWorkoutSession | null {
    const session = this.sessions.get(session_id);
    if (!session) return null;
    this.sessions.delete(session_id);
    return session;
  }

  get(session_id: string): ActiveWorkoutSession | null {
    return this.sessions.get(session_id) ?? null;
  }

  /** Most recently active session for the given user, or null when
   *  idle. Astrid's get_workout_state tool keys off this. */
  active_for(user_id: string): ActiveWorkoutSession | null {
    let latest: ActiveWorkoutSession | null = null;
    for (const session of this.sessions.values()) {
      if (session.user_id !== user_id) continue;
      if (!latest || session.last_packet_at > latest.last_packet_at) {
        latest = session;
      }
    }
    return latest;
  }

  list_active(): ActiveWorkoutSession[] {
    return Array.from(this.sessions.values());
  }

  private gc_orphans(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      const last = Date.parse(session.last_packet_at);
      if (!Number.isFinite(last)) continue;
      if (now - last > ORPHAN_GC_MS) {
        this.sessions.delete(id);
      }
    }
  }
}

// ── Vault path for the session-end summary ───────────────────────────────

function packet_rel_path(args: { user_id: string; captured_at: string; id: string; tz?: string }): string {
  const d = new Date(args.captured_at);
  const date_str = Number.isFinite(d.getTime()) ? local_iso_date(d, args.tz) : local_iso_date(new Date(), args.tz);
  const safe_ts = args.captured_at.replace(/[:]/g, '-');
  return `Users/${args.user_id}/sensors/healthkit/${date_str}/${safe_ts}-${args.id}.json`;
}

// ── Rate limiter ─────────────────────────────────────────────────────────
// Per-user sliding-window cap on /api/workout, mirroring the sensors
// route's limiter. A 60-min session at 30s heartbeats is ~120 packets/
// hour (2/min); 120/min leaves generous headroom for the start/end
// bookends AND a reconnect backfill burst (iOS may flush queued packets
// after the orchestrator restarts) without letting a wedged client
// hammer the route. Keyed on user_id alone — this router only ever
// serves signal=workout.
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_PER_WINDOW = 120;
const rate_buckets = new Map<string, number[]>();

function rate_check(user_id: string): { ok: boolean; reset_in_ms: number } {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const bucket = rate_buckets.get(user_id) ?? [];
  const live = bucket.filter((t) => t > cutoff);
  if (live.length >= RATE_LIMIT_PER_WINDOW) {
    const reset_in_ms = (live[0] ?? now) + RATE_WINDOW_MS - now;
    rate_buckets.set(user_id, live);
    return { ok: false, reset_in_ms };
  }
  live.push(now);
  rate_buckets.set(user_id, live);
  return { ok: true, reset_in_ms: 0 };
}

// ── Warm-row writer ──────────────────────────────────────────────────────
// Keeps the workout_sessions row's rolling LIVE columns current on every
// heartbeat so the session survives an orchestrator restart: the Activity
// pane + get_workout_state read these via MemoryClient.query_active_workout
// without depending on the in-memory tracker. Best-effort — a warm-write
// failure must never fail the heartbeat (the live event + tracker update
// already happened). Scoped to status='active' so it never disturbs a
// completed row's final rollups.
interface WarmRolling {
  last_packet_at: string;
  elapsed_s: number;
  active_kcal: number;
  distance_m: number | null;
  current_hr: number | null;
  current_hr_zone: number | null;
  elevation_gain_m: number | null;
  paused: boolean;
  hr_zone_minutes: { z1: number; z2: number; z3: number; z4: number; z5: number };
}

function warm_session_row(db: Database, session_id: string, s: WarmRolling): void {
  try {
    db.prepare(
      `UPDATE workout_sessions
          SET last_packet_at = @lpa, elapsed_s = @el, active_kcal = @kcal,
              distance_m = @dist, current_hr = @hr, current_hr_zone = @zone,
              elevation_gain_m = @gain, hr_zone_minutes_json = @zmin,
              paused = @paused
        WHERE session_id = @sid AND status = 'active'`,
    ).run({
      '@sid': session_id,
      '@lpa': s.last_packet_at,
      '@el': s.elapsed_s,
      '@kcal': s.active_kcal,
      '@dist': s.distance_m,
      '@hr': s.current_hr,
      '@zone': s.current_hr_zone,
      '@gain': s.elevation_gain_m,
      '@zmin': JSON.stringify(s.hr_zone_minutes),
      '@paused': s.paused ? 1 : 0,
    });
  } catch (err) {
    console.error(`[workout] failed to warm session row ${session_id}: ${(err as Error).message}`);
  }
}

// ── Heartbeat time-series writer (Ride Log) ──────────────────────────────
// One row per heartbeat so the detail surfaces (iOS Ride Log + /app/rides)
// can draw HR / pace / elevation curves after the fact. Best-effort — a
// series-write failure must never fail the heartbeat. INSERT OR REPLACE on
// (session_id, elapsed_s) so an iOS retry of the same packet stays one row.
function append_heartbeat_row(db: Database, session_id: string, s: WarmRolling): void {
  try {
    db.prepare(
      `INSERT OR REPLACE INTO workout_heartbeats
         (session_id, captured_at, elapsed_s, active_kcal, distance_m,
          current_hr, current_hr_zone, elevation_gain_m)
       VALUES (@sid, @at, @el, @kcal, @dist, @hr, @zone, @gain)`,
    ).run({
      '@sid': session_id,
      '@at': s.last_packet_at,
      '@el': s.elapsed_s,
      '@kcal': s.active_kcal,
      '@dist': s.distance_m,
      '@hr': s.current_hr,
      '@zone': s.current_hr_zone,
      '@gain': s.elevation_gain_m,
    });
  } catch (err) {
    console.error(`[workout] failed to append heartbeat row ${session_id}: ${(err as Error).message}`);
  }
}

// ── Router ───────────────────────────────────────────────────────────────

export interface WorkoutRoutesDeps {
  db: Database;
  vault_root: string;
  memory: MemoryClient;
  events: AppEventBus;
  tracker: WorkoutSessionTracker;
}

export function create_workout_router(deps: WorkoutRoutesDeps): Hono {
  const r = new Hono();

  // Reap stale-active sessions on boot (clears any row whose end packet
  // was lost while the server was last up) and every 10 min thereafter.
  reap_stale_active_sessions(deps.db, deps.memory, deps.tracker);
  const reap_timer = setInterval(
    () => reap_stale_active_sessions(deps.db, deps.memory, deps.tracker),
    REAP_INTERVAL_MS,
  );
  (reap_timer as unknown as { unref?: () => void }).unref?.();

  r.post('/', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'authentication required' }, 401);

    const rate = rate_check(user.id);
    if (!rate.ok) {
      return c.json(
        {
          error: 'rate limit exceeded',
          limit: RATE_LIMIT_PER_WINDOW,
          window_ms: RATE_WINDOW_MS,
          retry_after_ms: rate.reset_in_ms,
        },
        429,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      return c.json({ error: `invalid JSON: ${(err as Error).message}` }, 400);
    }

    const env_parsed = WorkoutPacketEnvelope.safeParse(body);
    if (!env_parsed.success) {
      // Log strict-schema rejections so a silently-400'd device packet is
      // diagnosable from the server side. Pre-fix, the only signal a live
      // session left was DB rows — which a 400 never produces — so "iOS
      // never sent" and "iOS sent and we rejected it" looked identical.
      console.warn(
        `[workout] 400 invalid envelope (user=${user.id}): ${JSON.stringify(env_parsed.error.issues)}`,
      );
      return c.json({ error: 'invalid WorkoutPacket envelope', issues: env_parsed.error.issues }, 400);
    }

    const env = env_parsed.data;
    const received_at = new Date().toISOString();

    // Dispatch by kind. Each branch validates its own payload shape
    // strictly so iOS bugs surface immediately rather than at downstream
    // consumers.
    if (env.kind === 'start') {
      const payload_parsed = WorkoutStartPayload.safeParse(env.payload);
      if (!payload_parsed.success) {
        console.warn(
          `[workout] 400 invalid start payload (session=${env.session_id}): ${JSON.stringify(payload_parsed.error.issues)}`,
        );
        return c.json({ error: 'invalid start payload', issues: payload_parsed.error.issues }, 400);
      }
      const payload = payload_parsed.data;

      try {
        deps.db
          .prepare(
            `INSERT INTO workout_sessions
               (session_id, user_id, workout_type, started_at, status)
             VALUES (@sid, @u, @wt, @ts, 'active')
             ON CONFLICT(session_id) DO NOTHING`,
          )
          .run({ '@sid': env.session_id, '@u': user.id, '@wt': payload.workout_type, '@ts': env.captured_at });
      } catch (err) {
        return c.json({ error: `failed to insert session: ${(err as Error).message}` }, 500);
      }

      deps.tracker.open({
        session_id: env.session_id,
        user_id: user.id,
        workout_type: payload.workout_type,
        started_at: env.captured_at,
        last_packet_at: env.captured_at,
        prior_pr_metric: payload.prior_pr_metric ?? null,
      });

      deps.events.emit({
        type: 'workout_started',
        session_id: env.session_id,
        user_id: user.id,
        workout_type: payload.workout_type,
        started_at: env.captured_at,
      });

      deps.memory.log_action({
        intent_id: `workout_start:${env.session_id}`,
        agent: 'orchestrator',
        tool_name: 'workout_session_start',
        tool_input: { session_id: env.session_id, workout_type: payload.workout_type },
        execution_result: { received_at },
      });

      return c.json({ ok: true, session_id: env.session_id, kind: 'start' });
    }

    if (env.kind === 'heartbeat') {
      const payload_parsed = WorkoutHeartbeatPayload.safeParse(env.payload);
      if (!payload_parsed.success) {
        console.warn(
          `[workout] 400 invalid heartbeat payload (session=${env.session_id}): ${JSON.stringify(payload_parsed.error.issues)}`,
        );
        return c.json({ error: 'invalid heartbeat payload', issues: payload_parsed.error.issues }, 400);
      }
      const payload = payload_parsed.data;

      const snapshot = {
        captured_at: env.captured_at,
        elapsed_s: payload.elapsed_s,
        active_kcal: payload.active_kcal,
        distance_m: payload.distance_m ?? null,
        current_hr: payload.current_hr ?? null,
        current_hr_zone: payload.current_hr_zone ?? null,
        elevation_gain_m: payload.elevation_gain_m ?? null,
        paused: payload.paused,
        lat: payload.lat ?? null,
        lon: payload.lon ?? null,
        hr_zone_minutes_so_far: payload.hr_zone_minutes_so_far,
      };

      let updated = deps.tracker.update(env.session_id, snapshot);

      // A heartbeat arriving for an unknown session is the
      // orchestrator-restart case: the in-memory tracker was wiped but
      // the workout_sessions row still says status='active'. Rehydrate
      // the tracker from the warm row so live coaching + state reads
      // resume mid-session, then apply this heartbeat. (Push history is
      // not persisted — it restarts clean; orphan GC covers the rest.)
      if (!updated) {
        const snap = deps.memory.query_active_workout(user.id);
        if (snap && snap.session_id === env.session_id) {
          deps.tracker.open({
            session_id: snap.session_id,
            user_id: user.id,
            workout_type: snap.workout_type,
            started_at: snap.started_at,
            last_packet_at: env.captured_at,
            prior_pr_metric: null,
          });
          updated = deps.tracker.update(env.session_id, snapshot);
        }
      }

      // Still unknown even after the rehydrate attempt → no active row in
      // the DB either (start packet was genuinely missed). Surface the
      // condition so iOS re-sends start, but don't 4xx the heartbeat.
      if (!updated) {
        return c.json({ ok: true, session_id: env.session_id, kind: 'heartbeat', warning: 'no active session — start packet missed; iOS should re-send start' });
      }

      // Warm the DB row with the tracker's merged rolling values so the
      // session is restart-proof and readable through MemoryClient.
      const rolling: WarmRolling = {
        last_packet_at: env.captured_at,
        elapsed_s: updated.elapsed_s,
        active_kcal: updated.active_kcal,
        distance_m: updated.distance_m,
        current_hr: updated.current_hr,
        current_hr_zone: updated.current_hr_zone,
        elevation_gain_m: updated.elevation_gain_m,
        paused: updated.paused,
        hr_zone_minutes: updated.hr_zone_minutes,
      };
      warm_session_row(deps.db, env.session_id, rolling);
      append_heartbeat_row(deps.db, env.session_id, rolling);

      deps.events.emit({
        type: 'workout_packet',
        session_id: env.session_id,
        user_id: user.id,
        captured_at: env.captured_at,
        elapsed_s: payload.elapsed_s,
        active_kcal: payload.active_kcal,
        current_hr: payload.current_hr ?? null,
        current_hr_zone: payload.current_hr_zone ?? null,
        elevation_gain_m: payload.elevation_gain_m ?? null,
      });

      return c.json({ ok: true, session_id: env.session_id, kind: 'heartbeat' });
    }

    if (env.kind === 'route') {
      // Ride route upload (owner-requested 2026-06-12) — iOS posts the
      // simplified GPS track once, just BEFORE the end packet, so the
      // session-end cue + ride name can see the recognized route. The
      // store thins to ≤1200 points and assigns the route group
      // (fingerprint match against the user's prior rides). Audit
      // carries counts + length ONLY — never coordinates.
      const route_parsed = WorkoutRoutePayload.safeParse(env.payload);
      if (!route_parsed.success) {
        return c.json({ error: 'invalid route payload', issues: route_parsed.error.issues }, 400);
      }
      const owner = deps.db
        .prepare('SELECT user_id FROM workout_sessions WHERE session_id = @s')
        .get({ '@s': env.session_id }) as { user_id: string } | null;
      if (!owner || owner.user_id !== user.id) return c.json({ error: 'not found' }, 404);
      const route_row = route_store.upsert({
        session_id: env.session_id,
        user_id: user.id,
        points: route_parsed.data.points,
      });
      deps.db
        .prepare('UPDATE workout_sessions SET route_group_id = @g WHERE session_id = @s')
        .run({ '@g': route_row.route_group_id, '@s': env.session_id });
      deps.memory.log_action({
        intent_id: `workout_route:${env.session_id}`,
        agent: 'orchestrator',
        tool_name: 'workout_route_stored',
        tool_input: { session_id: env.session_id, point_count: route_row.point_count },
        execution_result: {
          length_m: Math.round(route_row.length_m),
          route_group_id: route_row.route_group_id,
        },
      });
      return c.json({
        ok: true,
        session_id: env.session_id,
        kind: 'route',
        route_group_id: route_row.route_group_id,
        point_count: route_row.point_count,
        length_m: Math.round(route_row.length_m),
      });
    }

    // env.kind === 'end'
    const payload_parsed = WorkoutEndPayload.safeParse(env.payload);
    if (!payload_parsed.success) {
      console.warn(
        `[workout] 400 invalid end payload (session=${env.session_id}): ${JSON.stringify(payload_parsed.error.issues)}`,
      );
      return c.json({ error: 'invalid end payload', issues: payload_parsed.error.issues }, 400);
    }
    const payload = payload_parsed.data;

    // Update session header to completed status with rollups.
    try {
      deps.db
        .prepare(
          `UPDATE workout_sessions
           SET ended_at = @ts, status = 'completed',
               total_active_kcal = @kcal, total_duration_s = @dur,
               total_distance_m = @dist, avg_hr = @ahr, max_hr = @mhr,
               elevation_gain_m = COALESCE(@gain, elevation_gain_m),
               avg_power_w = @pw, route_notes_json = @route,
               hr_zone_minutes_json = @zmin
           WHERE session_id = @sid`,
        )
        .run({
          '@sid': env.session_id,
          '@ts': env.captured_at,
          '@kcal': payload.active_kcal,
          '@dur': payload.duration_s,
          '@dist': payload.total_distance_m ?? null,
          '@ahr': payload.avg_hr ?? null,
          '@mhr': payload.max_hr ?? null,
          // COALESCE keeps the last warmed rolling gain when the end
          // packet omits the field (older iOS builds).
          '@gain': payload.elevation_gain_m ?? null,
          '@pw': payload.avg_power_w ?? null,
          '@route': payload.route_notes && payload.route_notes.length > 0
            ? JSON.stringify(payload.route_notes)
            : null,
          '@zmin': payload.hr_zone_minutes ? JSON.stringify(payload.hr_zone_minutes) : null,
        });
    } catch (err) {
      return c.json({ error: `failed to update session: ${(err as Error).message}` }, 500);
    }

    // Mirror the completed workout into the healthkit signal so the
    // Pass 2 astrid_awareness handler's Brigid recovery-snack flag
    // still fires without duplicating the awareness logic in two
    // event subscribers. The vault file payload uses the same shape
    // as HealthkitPayload + WorkoutValueSchema.
    const mirror_id = ulid();
    const rel_path = packet_rel_path({ user_id: user.id, captured_at: env.captured_at, id: mirror_id, tz: c.get('user_tz') });
    const abs_path = resolve(deps.vault_root, rel_path);
    const mirror_payload = {
      sample_type: 'workout' as const,
      ts_start: deps.tracker.get(env.session_id)?.started_at ?? env.captured_at,
      ts_end: env.captured_at,
      value: {
        workout_type: payload.workout_type,
        duration_s: payload.duration_s,
        active_kcal: payload.active_kcal,
        total_distance_m: payload.total_distance_m ?? null,
        avg_hr: payload.avg_hr ?? null,
        max_hr: payload.max_hr ?? null,
        hr_zone_minutes: payload.hr_zone_minutes ?? null,
      },
      source_device: 'watch' as const,
    };
    try {
      mkdirSync(dirname(abs_path), { recursive: true });
      writeFileSync(abs_path, JSON.stringify(mirror_payload, null, 2));
      deps.db
        .prepare(
          `INSERT INTO sensor_packets
             (id, user_id, device_id, signal, captured_at, received_at, payload_path)
           VALUES (@id, @user_id, NULL, 'healthkit', @captured_at, @received_at, @path)`,
        )
        .run({
          '@id': mirror_id,
          '@user_id': user.id,
          '@captured_at': env.captured_at,
          '@received_at': received_at,
          '@path': rel_path,
        });
    } catch (err) {
      // Mirror write failure is not fatal to the workout-end packet —
      // the session is still recorded in workout_sessions and the live
      // workout_completed event still fires. Brigid handoff is the only
      // thing that misses; log loudly so it's visible.
      console.error(`[workout] failed to mirror end packet to sensor_packets: ${(err as Error).message}`);
    }

    deps.tracker.close(env.session_id);

    deps.events.emit({
      type: 'workout_completed',
      session_id: env.session_id,
      user_id: user.id,
      workout_type: payload.workout_type,
      ended_at: env.captured_at,
      total_active_kcal: payload.active_kcal,
      total_duration_s: payload.duration_s,
      total_distance_m: payload.total_distance_m ?? null,
      elevation_gain_m: payload.elevation_gain_m ?? null,
      avg_power_w: payload.avg_power_w ?? null,
      route_notes: payload.route_notes ?? null,
    });

    deps.memory.log_action({
      intent_id: `workout_end:${env.session_id}`,
      agent: 'orchestrator',
      tool_name: 'workout_session_end',
      tool_input: { session_id: env.session_id, workout_type: payload.workout_type, active_kcal: payload.active_kcal, duration_s: payload.duration_s },
      execution_result: { received_at, mirrored_to_healthkit: true },
    });

    return c.json({ ok: true, session_id: env.session_id, kind: 'end' });
  });

  r.get('/active', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'authentication required' }, 401);
    // List the caller's active sessions only — never expose another
    // user's session metadata.
    const sessions = deps.tracker.list_active().filter((s) => s.user_id === user.id);
    return c.json({ sessions });
  });

  // ── Ride Log (Live Ride Companion Phase 2.5) ────────────────────────
  // Browsable workout history — one contract for both clients (iOS Ride
  // Log + /app/rides; the auth middleware accepts bearer AND cookie, so
  // both reach this top-level mount). Owner-cordoned like the cue route.

  interface SessionRow {
    session_id: string;
    workout_type: string;
    started_at: string;
    ended_at: string | null;
    status: string;
    ride_name: string | null;
    total_duration_s: number | null;
    total_distance_m: number | null;
    total_active_kcal: number | null;
    avg_hr: number | null;
    max_hr: number | null;
    elevation_gain_m: number | null;
    avg_power_w: number | null;
    hr_zone_minutes_json: string | null;
    end_weather_json: string | null;
    route_notes_json: string | null;
  }

  const parse_json = (s: string | null): unknown => {
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  const session_summary = (row: SessionRow) => {
    const duration_s = row.total_duration_s ?? null;
    const distance_m = row.total_distance_m ?? null;
    const avg_speed_kmh =
      duration_s != null && duration_s > 0 && distance_m != null && distance_m > 0
        ? Math.round((distance_m / 1000 / (duration_s / 3600)) * 10) / 10
        : null;
    return {
      session_id: row.session_id,
      workout_type: row.workout_type,
      started_at: row.started_at,
      ended_at: row.ended_at,
      ride_name: row.ride_name,
      duration_s,
      distance_m,
      active_kcal: row.total_active_kcal,
      avg_hr: row.avg_hr,
      max_hr: row.max_hr,
      elevation_gain_m: row.elevation_gain_m,
      avg_power_w: row.avg_power_w,
      avg_speed_kmh,
      hr_zone_minutes: parse_json(row.hr_zone_minutes_json),
      weather: parse_json(row.end_weather_json),
      route_notes: parse_json(row.route_notes_json),
    };
  };

  // Completed sessions, newest first. Sub-2-min phantom sessions are
  // excluded by default (same floor as the PR shelf) — pass
  // ?min_duration_s=0 to see everything.
  r.get('/sessions', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'authentication required' }, 401);
    const limit = Math.min(200, Math.max(1, Number.parseInt(c.req.query('limit') ?? '60', 10) || 60));
    const floor_raw = Number.parseInt(c.req.query('min_duration_s') ?? '120', 10);
    const floor = Number.isFinite(floor_raw) ? Math.max(0, floor_raw) : 120;
    const type = c.req.query('type') ?? null;
    try {
      const rows = deps.db
        .prepare(
          `SELECT session_id, workout_type, started_at, ended_at, status, ride_name,
                  total_duration_s, total_distance_m, total_active_kcal, avg_hr, max_hr,
                  elevation_gain_m, avg_power_w, hr_zone_minutes_json, end_weather_json,
                  route_notes_json
             FROM workout_sessions
            WHERE user_id = @u AND status = 'completed'
              AND COALESCE(total_duration_s, 0) >= @floor
              AND (@type IS NULL OR workout_type = @type)
            ORDER BY started_at DESC
            LIMIT @lim`,
        )
        .all({ '@u': user.id, '@floor': floor, '@type': type, '@lim': limit }) as SessionRow[];
      return c.json({ sessions: rows.map(session_summary) });
    } catch (err) {
      return c.json({ error: `failed to list sessions: ${(err as Error).message}` }, 500);
    }
  });

  // One session + its heartbeat time series + any still-live cue texts.
  // 404 (not 403) on someone else's session so ids don't leak existence.
  r.get('/sessions/:session_id', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'authentication required' }, 401);
    const sid = c.req.param('session_id');
    try {
      const row = deps.db
        .prepare(
          `SELECT session_id, workout_type, started_at, ended_at, status, ride_name,
                  total_duration_s, total_distance_m, total_active_kcal, avg_hr, max_hr,
                  elevation_gain_m, avg_power_w, hr_zone_minutes_json, end_weather_json,
                  route_notes_json, user_id
             FROM workout_sessions
            WHERE session_id = @sid`,
        )
        .get({ '@sid': sid }) as (SessionRow & { user_id: string }) | null;
      if (!row || row.user_id !== user.id) return c.json({ error: 'not found' }, 404);

      const series = deps.db
        .prepare(
          `SELECT elapsed_s, captured_at, active_kcal, distance_m, current_hr,
                  current_hr_zone, elevation_gain_m
             FROM workout_heartbeats
            WHERE session_id = @sid
            ORDER BY elapsed_s ASC`,
        )
        .all({ '@sid': sid }) as Array<{
          elapsed_s: number;
          captured_at: string;
          active_kcal: number | null;
          distance_m: number | null;
          current_hr: number | null;
          current_hr_zone: number | null;
          elevation_gain_m: number | null;
        }>;

      // Cue texts survive only until the 48h clip sweep — best-effort
      // color for the detail timeline, not a durable record (the
      // coaching log markdown is).
      // Cue ledger first (every delivered cue, with class + WHY);
      // pre-ledger sessions fall back to the voice-clip rows.
      const ledger = route_store.cues_for_session(sid).filter((cue) => cue.user_id === user.id);
      const cues =
        ledger.length > 0
          ? ledger.map((cue) => ({
              clip_id: cue.clip_id,
              ts: cue.ts,
              elapsed_s: cue.elapsed_s,
              trigger_id: cue.trigger_id,
              cls: cue.cls,
              text: cue.text,
              reason: cue.reason,
            }))
          : (deps.db
              .prepare(
                `SELECT clip_id, ts, trigger_id, text
                   FROM workout_cue_clips
                  WHERE session_id = @sid AND user_id = @u
                  ORDER BY ts ASC`,
              )
              .all({ '@sid': sid, '@u': user.id }) as Array<{
              clip_id: string;
              ts: string;
              trigger_id: string;
              text: string;
            }>);
      const route = route_store.get(sid);

      return c.json({
        session: session_summary(row),
        series,
        cues,
        route:
          route && route.user_id === user.id
            ? { points: route.points, length_m: Math.round(route.length_m), route_group_id: route.route_group_id }
            : null,
      });
    } catch (err) {
      return c.json({ error: `failed to load session: ${(err as Error).message}` }, 500);
    }
  });

  // ── Live Ride Companion cues (design doc §6.3–6.5) ──────────────────

  const cue_store = new WorkoutCueStore(deps.db);
  const route_store = new WorkoutRouteStore(deps.db);

  // Serve a synthesized Laur cue clip. Per-user cordon: a clip
  // narrates someone's workout, so ONLY that user may fetch it — 404
  // (not 403) on anyone else so clip ids don't leak existence.
  r.get('/cues/:clip_id', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'authentication required' }, 401);
    const clip_id = c.req.param('clip_id');
    const rec = cue_store.get(clip_id);
    if (!rec || rec.user_id !== user.id) return c.json({ error: 'not found' }, 404);
    const file = Bun.file(rec.file_path);
    if (!(await file.exists())) return c.json({ error: 'not found' }, 404);
    const etag = `"${rec.clip_id}"`; // clips are immutable — the id IS the version
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    return new Response(file, {
      status: 200,
      headers: {
        'content-type': clip_content_type(rec.format),
        'content-length': String(rec.bytes),
        'cache-control': 'private, max-age=86400, immutable',
        etag,
      },
    });
  });

  const MuteCuesSchema = z
    .object({
      session_id: z.string().min(1).max(64).optional(),
      muted: z.boolean().default(true),
    })
    .strict();

  // Mute/unmute live coaching cues. No session_id ⇒ every active
  // session of the caller. The live-throttle subscriber checks the
  // cues_muted column before any send, so this is restart-proof.
  r.post('/cues/mute', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'authentication required' }, 401);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      raw = {};
    }
    const parsed = MuteCuesSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const muted_val = parsed.data.muted ? 1 : 0;
    let changed = 0;
    if (parsed.data.session_id) {
      const row = deps.db
        .prepare('SELECT user_id FROM workout_sessions WHERE session_id = @s')
        .get({ '@s': parsed.data.session_id }) as { user_id: string } | null;
      if (!row || row.user_id !== user.id) return c.json({ error: 'not found' }, 404);
      deps.db
        .prepare('UPDATE workout_sessions SET cues_muted = @m WHERE session_id = @s')
        .run({ '@m': muted_val, '@s': parsed.data.session_id });
      changed = 1;
    } else {
      const res = deps.db
        .prepare("UPDATE workout_sessions SET cues_muted = @m WHERE user_id = @u AND status = 'active'")
        .run({ '@m': muted_val, '@u': user.id });
      changed = Number(res.changes ?? 0);
    }
    const intent_id = ulid();
    const audit_id = deps.memory.log_action({
      intent_id,
      agent: 'orchestrator',
      tool_name: 'workout_cues_mute',
      tool_input: { session_id: parsed.data.session_id ?? null, muted: parsed.data.muted },
      execution_result: { sessions: changed },
    });
    return c.json({ intent_id, audit_id, muted: parsed.data.muted, sessions: changed });
  });

  return r;
}
