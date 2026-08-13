/**
 * Device-as-sensor pipeline routes (BACKEND_SENSORS_BRIEF 2026-05-25).
 *
 *   POST /api/sensors/:signal              ingest a SensorPacket
 *   GET  /api/sensors/derived/:query       computed projection over latest packets
 *   GET  /api/sensors/status               per-signal stats for Settings → Sensors
 *
 * iOS feeders (Focus, Calendar, CarPlay first; Location and HealthKit
 * later) call `HearthClient.pushSensor(_:)` which POSTs SensorPacket
 * JSON. Auth is required: `c.get('user')` is the canonical user_id;
 * unauthenticated traffic gets a 401 from the auth middleware before
 * this handler runs.
 *
 * Storage split (matches architecture.md "Vault as source of truth"):
 *   - SQLite `sensor_packets` table = index only (id, user, signal,
 *     timestamps, payload_path)
 *   - JSON payload bytes = vault file at
 *       <vault_root>/Users/<user_id>/sensors/<signal>/<YYYY-MM-DD>/<captured_at>-<id>.json
 *     One file per packet, daily-partitioned. Cheap, append-only, easy
 *     to re-encrypt or rotate by directory.
 *
 * Rate limit: 60 packets/minute per (user_id, signal). Burst tolerated;
 * iOS replays a queued batch on reconnect, so the cap protects against
 * a runaway feeder, not against normal catch-up traffic.
 *
 * Event bus: every successful POST emits `sensor_packet_received` so
 * Iris's runtime + Kate's router can react without polling. The event
 * carries identifiers only; consumers re-fetch the body via this same
 * route (or directly from the vault file via packet_path()) if needed.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulid';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { MemoryClient } from '@memory/client';
import type { AppEventBus } from '../events';
import type { UserRegistry } from '@core/users';
import { local_iso_date } from '@core/time';
import { classify_home_transition, type HomeAnchor } from '@core/home_anchor';

export interface SensorsRoutesDeps {
  db: Database;
  vault_root: string;
  memory: MemoryClient;
  events: AppEventBus;
  /** For the guaranteed-home geofence in /places/monitored (2026-07-15).
   *  Optional — legacy wiring/smokes without it just skip the home entry. */
  users?: UserRegistry;
}

// ── Per-signal payload schemas ───────────────────────────────────────────
// `.strict()` rejects unknown fields per the brief. iOS sends a known
// payload shape per signal; anything unexpected is a client bug worth
// surfacing immediately, not a future-compat slot.

export const FocusPayload = z
  .object({
    mode: z
      .enum([
        'sleep',
        'work',
        'driving',
        'personal',
        'fitness',
        'reading',
        'custom',
      ])
      .nullable(),
    filter_id: z.string().optional(),
    since: z.string().min(1),
  })
  .strict();

// Edge-triggered: per-event, fast. iOS emits these as the user's day
// flows past calendar boundaries (event_upcoming 15 min before start;
// event_started at start; event_ended at end). Append-only stream in
// `sensor_packets` — same as every other signal kind.
export const CalendarEdgePayload = z
  .object({
    kind: z.enum(['event_started', 'event_ended', 'event_upcoming']),
    event_id: z.string().min(1),
    title: z.string(),
    ts_start: z.string().min(1),
    ts_end: z.string().min(1),
    location: z.string().nullable().optional(),
    category: z.enum(['work', 'personal', 'household']).nullable().optional(),
    is_all_day: z.boolean().default(false),
  })
  .strict();

// Per-event entry inside a snapshot's events array. Richer than the
// edge-triggered shape because the snapshot is the canonical view of
// multi-week awareness (organizer, attendees, notes preview, calendar
// account) — context specialists need for proposing changes that
// don't fire on a per-event boundary.
export const CalendarSnapshotEvent = z
  .object({
    event_id: z.string().min(1),
    title: z.string(),
    ts_start: z.string().min(1),
    ts_end: z.string().min(1),
    location: z.string().nullable().optional(),
    is_all_day: z.boolean().default(false),
    calendar_name: z.string(),
    calendar_type: z.enum([
      'caldav',
      'exchange',
      'local',
      'subscription',
      'birthday',
      'unknown',
    ]),
    organizer: z.string().nullable().optional(),
    has_attendees: z.boolean(),
    notes_preview: z.string().nullable().optional(),
  })
  .strict();

// Bulk snapshot: full-window awareness. iOS emits on first auth grant,
// every 6h, and reactively on EKEventStoreChangedNotification. Backend
// stores via DELETE+INSERT on `calendar_snapshots` — one row per user,
// never accumulates. The events array goes to a vault file like every
// other packet payload.
export const CalendarSnapshotPayload = z
  .object({
    kind: z.literal('snapshot'),
    window_start: z.string().min(1),
    window_end: z.string().min(1),
    event_count: z.number().int().nonnegative(),
    events: z.array(CalendarSnapshotEvent),
  })
  .strict();

const CalendarPayload = z.discriminatedUnion('kind', [
  CalendarEdgePayload,
  CalendarSnapshotPayload,
]);

/** Narrow a parsed CalendarPayload to its snapshot branch. Cleaner than
 *  casting at the call site; lets `if (isCalendarSnapshot(p))` flow types. */
function isCalendarSnapshot(
  p: unknown,
): p is z.infer<typeof CalendarSnapshotPayload> {
  return (
    typeof p === 'object' &&
    p !== null &&
    (p as { kind?: unknown }).kind === 'snapshot'
  );
}

export const CarplayPayload = z
  .object({
    state: z.enum(['connected', 'disconnected']),
    since: z.string().min(1),
  })
  .strict();

export const LocationPayload = z
  .object({
    kind: z.enum([
      'visit_arrival',
      'visit_departure',
      'region_enter',
      'region_exit',
      'significant_change',
      // One-shot foreground fix from iOS (requestLocation on scene-phase
      // .active). Same trust bucket as significant_change everywhere — a
      // fresh raw transit fix, never sticky presence. Distinct so consumers
      // can tell "the app was foregrounded here" from "the device moved 5km".
      'foreground_fix',
    ]),
    lat: z.number(),
    lng: z.number(),
    horizontal_accuracy_m: z.number().nonnegative().optional(),
    place_id: z.string().nullable().optional(),
    // Travel-mode classification from iOS CMMotionActivity, when the device
    // resolved one for this event. Optional so packets from feeders that
    // don't post it (and all pre-2026-05-31 packets) still validate; the
    // schema is .strict(), so the field must be declared here for iOS to
    // begin sending it without a 400. Read back by
    // MemoryClient.list_location_events → summarize_recent_trips so Ruby's
    // recent_trips tool can report HOW a trip was made (car vs bike), not
    // just where/when. Until the iOS LocationSensorFeeder ships it, every
    // packet's motion is absent and consumers omit the mode honestly.
    motion: z
      .enum(['automotive', 'cycling', 'walking', 'running', 'stationary', 'unknown'])
      .optional(),
    ts: z.string().min(1),
  })
  .strict();

export const HealthkitPayload = z
  .object({
    /**
     * `workout` carries a post-completion HKWorkout summary (one packet
     * per workout, fired on HKWorkoutSession end). `value` is the rich
     * workout-detail object (see WorkoutValue below); `ts_start` and
     * `ts_end` mark the session boundaries; `unit` is unused for the
     * workout shape. Astrid's awareness handler keys her recovery-snack
     * handoff to Brigid off active_kcal in these packets.
     *
     * Pre-existing types (sleep / hr / hrv / steps / activity_ring /
     * mindful_minutes) are daily snapshots — see HealthKitSensorFeeder.swift
     * on iOS. `mindful_minutes` carries a numeric daily total in
     * `value` with `unit: "minutes"`.
     */
    sample_type: z.enum([
      'sleep',
      'hr',
      'hrv',
      'steps',
      'activity_ring',
      'mindful_minutes',
      'workout',
    ]),
    ts_start: z.string().min(1),
    ts_end: z.string().min(1),
    /**
     * For numeric samples (steps, hr): a number.
     * For activity_ring: ActivityRingValue — raw achieved + goal +
     *   percent per ring component (move kcal, exercise min, stand hr).
     * For workout: WorkoutValue shape — see below; iOS posts the rich
     * object as JSON, backend stores verbatim, downstream consumers
     * (get_health_summary, astrid_awareness) destructure as needed.
     */
    value: z.union([z.number(), z.record(z.unknown())]),
    unit: z.string().optional(),
    source_device: z.enum(['iphone', 'watch']),
  })
  .strict();

/**
 * The shape iOS posts inside `value` when `sample_type === 'workout'`.
 * Not enforced at the sensor route boundary (which keeps `value` as the
 * permissive union for backward compat with existing snapshot types),
 * but used by downstream consumers via `safeParse(packet.value)` so
 * malformed entries return null instead of crashing the consumer.
 *
 * Fields chosen to match what HKWorkout exposes at session-end:
 *   - `workout_type` — HKWorkoutActivityType raw name (`cycling`,
 *     `running`, `traditional_strength_training`, `high_intensity_
 *     interval_training`, `yoga`, etc.). Free string at this layer to
 *     stay forward-compatible with new HKWorkoutActivityType cases
 *     Apple introduces; Astrid's persona handles the unfamiliar.
 *   - `duration_s` — total session seconds.
 *   - `active_kcal` — HKQuantityTypeIdentifier.activeEnergyBurned summed
 *     across the session. THE field Astrid keys her Brigid recovery-snack
 *     flag off when it exceeds the per-user threshold.
 *   - `total_distance_m` — meters where applicable (cardio); 0/null for
 *     strength/yoga.
 *   - `avg_hr` / `max_hr` / `min_hr` — bpm; null when not captured.
 *     iOS runs an HKStatisticsQuery scoped to the workout window and
 *     ships all three when present.
 *   - `hr_zone_minutes` — optional minute counts per HR zone (1..5).
 *     iOS bins the heart-rate sample stream against the same absolute-
 *     bpm bands the live throttle uses (z1<120, z2<140, z3<160, z4<180,
 *     z5≥180). Per-user %HRmax bands will swap in when training.max_hr
 *     lands in users.yaml; the consumer-facing shape stays the same.
 *   - `recovery_hr_drop_1min_bpm` — heart-rate recovery: HR at session
 *     end minus the average HR across the first 60s after end. A
 *     classic aerobic-recovery metric — higher is fitter. Null when
 *     the post-workout HR stream is missing (Watch left at home,
 *     wrist-detection paused, etc.).
 *   - `vo2_max` — most recent `HKQuantityTypeIdentifier.vo2Max` sample
 *     within ±24h of session end, in ml/(kg·min). Apple Watch writes
 *     these on outdoor walks / runs / hikes / cycling. Null when
 *     HealthKit has none in that window for this workout type.
 *   - `elevation_ascended_m` — meters climbed, read from the workout's
 *     `HKMetadataKeyElevationAscended` metadata when Apple's Workout
 *     app filled it. Null when the workout type or the source app
 *     didn't track elevation.
 *
 * The Pass 2 enrichments (recovery / vo2 / elevation / min_hr) are
 * additive — every field is `.nullable().optional()` so an older iOS
 * build that only posts the original four keeps validating. Astrid's
 * `get_health_summary` + `awareness/astrid.ts` destructure with
 * `value?.recovery_hr_drop_1min_bpm`-style guards.
 */
export const WorkoutValueSchema = z
  .object({
    workout_type: z.string().min(1).max(80),
    duration_s: z.number().int().nonnegative(),
    active_kcal: z.number().nonnegative(),
    total_distance_m: z.number().nonnegative().nullable().optional(),
    avg_hr: z.number().nonnegative().nullable().optional(),
    max_hr: z.number().nonnegative().nullable().optional(),
    min_hr: z.number().nonnegative().nullable().optional(),
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
    recovery_hr_drop_1min_bpm: z.number().nullable().optional(),
    vo2_max: z.number().positive().nullable().optional(),
    elevation_ascended_m: z.number().nonnegative().nullable().optional(),
  })
  .strict();

export type WorkoutValue = z.infer<typeof WorkoutValueSchema>;

/**
 * The shape iOS posts inside `value` when `sample_type === 'activity_ring'`.
 * Like WorkoutValueSchema, not enforced at the sensor-route boundary
 * (the route keeps `value` permissive for back-compat) — downstream
 * consumers `safeParse` it.
 *
 * Each ring component ships RAW achieved + goal in its natural unit
 * (move = kcal, exercise = minutes, stand = hours) alongside the capped
 * percent. The raw values are the wire that was missing: the comment on
 * the route's `value` union promised `{ move_kcal, move_goal_kcal,
 * exercise_min }` but the iOS feeder only ever sent percentages, so
 * Astrid's office had no daily calorie-burn signal to show. Every field
 * is optional so packets written before the iOS feeder shipped raw
 * values (percent-only) still parse — consumers null-check per field.
 */
export const ActivityRingValueSchema = z
  .object({
    move_kcal: z.number().nonnegative().optional(),
    move_goal_kcal: z.number().nonnegative().optional(),
    move_percent: z.number().nonnegative().optional(),
    exercise_min: z.number().nonnegative().optional(),
    exercise_goal_min: z.number().nonnegative().optional(),
    exercise_percent: z.number().nonnegative().optional(),
    stand_hours: z.number().nonnegative().optional(),
    stand_goal_hours: z.number().nonnegative().optional(),
    stand_percent: z.number().nonnegative().optional(),
  })
  .partial();

export type ActivityRingValue = z.infer<typeof ActivityRingValueSchema>;

/**
 * Music context — full-state snapshot of the user's Apple Music
 * account, read by iOS via the local MusicKit Swift API. Replaces
 * the prior server-side MusicKit JWT path (`MUSICKIT_KEY_ID` etc.)
 * with a device-as-sensor pattern: iOS owns the account-scoped read,
 * posts a snapshot here on a daily cadence (and on-foreground if
 * stale > 24h), and the backend's intake handlers (Maggie's
 * `intake_band_poster.ts` is the first consumer) query it as
 * artist-affinity signal without standing up server-side MusicKit.
 *
 * Same DELETE+INSERT-per-upload shape as calendar_snapshots — at
 * most one row per user. `top_artists` are pre-aggregated by iOS
 * over the 90d window so backend lookups don't redo the count.
 */
export const MusicContextPayload = z
  .object({
    window_start: z.string().min(1),
    window_end: z.string().min(1),
    /** Aggregated over `recently_played` for the window. */
    top_artists: z.array(
      z.object({
        artist: z.string().min(1),
        play_count: z.number().int().nonnegative(),
        last_played: z.string().nullable().optional(),
      }),
    ),
    /** Up to 200 most-recent plays — iOS truncates client-side. */
    recently_played: z.array(
      z.object({
        title: z.string(),
        artist: z.string(),
        album: z.string().nullable().optional(),
        played_at: z.string(),
      }),
    ),
    /** Names of starred / loved playlists. */
    starred_playlists: z.array(z.string()).default([]),
    /** Counts only — keeps the payload bounded. */
    library_counts: z
      .object({
        songs: z.number().int().nonnegative(),
        albums: z.number().int().nonnegative(),
        artists: z.number().int().nonnegative(),
        playlists: z.number().int().nonnegative(),
      })
      .optional(),
  })
  .strict();

// Future-compatible: an unknown signal name is allowed through as a
// pass-through (iOS can ship a new feeder before backend catches up),
// but the payload must at least be a JSON object.
const PassThroughPayload = z.record(z.unknown());

const PAYLOAD_SCHEMAS: Record<string, z.ZodTypeAny> = {
  focus: FocusPayload,
  calendar: CalendarPayload,
  carplay: CarplayPayload,
  location: LocationPayload,
  healthkit: HealthkitPayload,
  music_context: MusicContextPayload,
};

const SensorPacketEnvelope = z
  .object({
    signal: z.string().min(1).max(64),
    captured_at: z.string().min(1),
    payload: z.unknown(),
  })
  .strict();

// ── Rate limiter ─────────────────────────────────────────────────────────
// Sliding-window 60/min per (user_id, signal). In-memory map; resets on
// process restart (acceptable — the cap is a runaway-feeder guard, not
// a security boundary). Trim entries older than the window on access so
// the map can't grow unbounded.

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_PER_WINDOW = 60;
const rate_buckets = new Map<string, number[]>();

function rate_check(user_id: string, signal: string): { ok: boolean; reset_in_ms: number } {
  const key = `${user_id}:${signal}`;
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const bucket = rate_buckets.get(key) ?? [];
  const live = bucket.filter((t) => t > cutoff);
  if (live.length >= RATE_LIMIT_PER_WINDOW) {
    const reset_in_ms = (live[0] ?? now) + RATE_WINDOW_MS - now;
    rate_buckets.set(key, live);
    return { ok: false, reset_in_ms };
  }
  live.push(now);
  rate_buckets.set(key, live);
  return { ok: true, reset_in_ms: 0 };
}

// ── HA webhook emission ──────────────────────────────────────────────────
// Replaces Home Assistant's polling CalDAV integration per
// BACKEND_HA_CALDAV_DEPRECATION_BRIEF.md. When `HEARTH_HA_WEBHOOK_URL`
// is set, every calendar edge-triggered packet (event_upcoming /
// event_started / event_ended) fires a non-blocking POST to that URL
// so HA automations can trigger on the push instead of polling
// `/api/sensors/derived/upcoming_events`. Fire-and-forget — a failed
// webhook never blocks the ingest path, and Hearth has its own
// canonical record of the event in `sensor_packets` regardless.
//
// Set HEARTH_HA_WEBHOOK_URL in the orchestrator's environment (e.g.
// `https://home.your-tailnet.ts.net/api/webhook/hearth_calendar_event`).
// Unset (default) = no outbound POST, no behavior change.

function fire_ha_calendar_webhook(args: {
  user_id: string;
  payload: z.infer<typeof CalendarEdgePayload>;
}): void {
  const url = process.env.HEARTH_HA_WEBHOOK_URL;
  if (!url) return;
  const body = JSON.stringify({
    hearth_user_id: args.user_id,
    kind: args.payload.kind,
    event_id: args.payload.event_id,
    title: args.payload.title,
    ts_start: args.payload.ts_start,
    ts_end: args.payload.ts_end,
    location: args.payload.location ?? null,
  });
  // Fire-and-forget. HA's webhook is best-effort; Hearth's append-only
  // packet table is the canonical record. 4s timeout via AbortController
  // so a hung HA can't accumulate dangling fetches.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: controller.signal,
  })
    .catch((err) => {
      console.warn(`[ha-webhook] ${args.payload.kind} fire failed: ${(err as Error).message}`);
    })
    .finally(() => clearTimeout(timeout));
}

// ── Vault file layout ────────────────────────────────────────────────────

/** Relative path under <vault_root>. Stored in DB; portable across vault moves. */
function packet_rel_path(args: {
  user_id: string;
  signal: string;
  captured_at: string;
  id: string;
  tz?: string;
}): string {
  // YYYY-MM-DD partition from captured_at; falls back to received-now
  // if the client sent something we can't parse (still grouped per day).
  const d = new Date(args.captured_at);
  const date_str = Number.isFinite(d.getTime()) ? local_iso_date(d, args.tz) : local_iso_date(new Date(), args.tz);
  // captured_at carries ':' which is unfriendly on some filesystems
  // (Windows in particular) — replace it for the filename only.
  const safe_ts = args.captured_at.replace(/[:]/g, '-');
  return `Users/${args.user_id}/sensors/${args.signal}/${date_str}/${safe_ts}-${args.id}.json`;
}

function packet_abs_path(vault_root: string, rel_path: string): string {
  return resolve(vault_root, rel_path);
}

// ── Derived signal computation ───────────────────────────────────────────
// Computed on read from the latest raw packets — no separate "derived"
// table. Cache TTL keyed by (user_id, query). Cheap queries 30s; the
// sleep aggregation (only one we have) gets 5 min.

interface CacheEntry {
  expires_at_ms: number;
  body: unknown;
}
const derived_cache = new Map<string, CacheEntry>();

function cache_get(key: string): unknown | null {
  const e = derived_cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expires_at_ms) {
    derived_cache.delete(key);
    return null;
  }
  return e.body;
}
function cache_put(key: string, body: unknown, ttl_ms: number): void {
  derived_cache.set(key, { body, expires_at_ms: Date.now() + ttl_ms });
}
function cache_invalidate_for(user_id: string): void {
  // Coarse but cheap: any new packet for the user wipes that user's
  // entries. Net 5/min ingest rate makes this cheaper than per-query
  // invalidation tracking.
  for (const k of derived_cache.keys()) {
    if (k.startsWith(`${user_id}:`)) derived_cache.delete(k);
  }
}

interface LatestPacketRow {
  id: string;
  signal: string;
  captured_at: string;
  payload_path: string;
}

function load_payload(vault_root: string, row: LatestPacketRow): unknown | null {
  const abs = packet_abs_path(vault_root, row.payload_path);
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

function latest_packet(
  db: Database,
  user_id: string,
  signal: string,
): LatestPacketRow | null {
  const row = db
    .prepare(
      `SELECT id, signal, captured_at, payload_path FROM sensor_packets
       WHERE user_id = @u AND signal = @s
       ORDER BY captured_at DESC LIMIT 1`,
    )
    .get({ '@u': user_id, '@s': signal }) as LatestPacketRow | undefined;
  return row ?? null;
}

function packets_since(
  db: Database,
  user_id: string,
  signal: string,
  since_iso: string,
): LatestPacketRow[] {
  return db
    .prepare(
      `SELECT id, signal, captured_at, payload_path FROM sensor_packets
       WHERE user_id = @u AND signal = @s AND captured_at >= @since
       ORDER BY captured_at DESC`,
    )
    .all({ '@u': user_id, '@s': signal, '@since': since_iso }) as LatestPacketRow[];
}

interface DerivedSignal {
  name: string;
  value: unknown;
  computed_at: string;
}

function compute_is_home(
  db: Database,
  vault_root: string,
  user_id: string,
  home_anchor: HomeAnchor | null,
): DerivedSignal {
  // True when the most recent location packet puts the user at home. We only
  // need the latest packet — strictly chronological semantics: the last
  // arrival/enter wins until a departure/exit (or an arrival somewhere else).
  //
  // Home-ness comes from `classify_home_transition` — the ONE definition,
  // shared with the reactive home triggers + the push presence gate. It used to
  // be `place_id === 'home'`, which live iOS payloads never send, so this signal
  // read `false` unconditionally for its whole life (see core/home_anchor.ts).
  const empty = { name: 'is_home', value: { value: false, since: null }, computed_at: new Date().toISOString() };
  const row = latest_packet(db, user_id, 'location');
  if (!row) return empty;
  const payload = load_payload(vault_root, row) as
    | z.infer<typeof LocationPayload>
    | null;
  if (!payload) return empty;

  const t = classify_home_transition(payload, home_anchor);
  // A packet that carries no home transition (a `significant_change` transit
  // fix, a departure from elsewhere) leaves home-ness UNKNOWN, which this
  // boolean signal reports as false — same as before, and honest: this query
  // answers from one packet and never guesses.
  const at_home_now = t?.presence === 'home';
  return {
    name: 'is_home',
    value: {
      value: at_home_now,
      since: at_home_now ? payload.ts : null,
    },
    computed_at: new Date().toISOString(),
  };
}

export function compute_focus_mode(
  db: Database,
  vault_root: string,
  user_id: string,
): DerivedSignal {
  const row = latest_packet(db, user_id, 'focus');
  if (!row) {
    return { name: 'focus_mode', value: { value: null }, computed_at: new Date().toISOString() };
  }
  const payload = load_payload(vault_root, row) as
    | z.infer<typeof FocusPayload>
    | null;
  return {
    name: 'focus_mode',
    value: { value: payload?.mode ?? null },
    computed_at: new Date().toISOString(),
  };
}

export function compute_in_meeting(
  db: Database,
  vault_root: string,
  user_id: string,
): DerivedSignal {
  // Two sources of truth, in order:
  //   1. Edge-triggered packets in the last 24h (newest-first): a known
  //      `event_started` whose ts_end is in the future wins immediately —
  //      fastest, most reliable signal for "right now."
  //   2. Latest calendar_snapshot: scan its events array for one whose
  //      [ts_start, ts_end) covers now. Fills the gap when an event
  //      started before iOS had a chance to fire `event_started` (e.g.,
  //      the phone was asleep) but the snapshot still knows about it.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = packets_since(db, user_id, 'calendar', since);
  const now_iso = new Date().toISOString();

  for (const r of rows) {
    const p = load_payload(vault_root, r) as z.infer<typeof CalendarPayload> | null;
    if (!p) continue;
    if (p.kind === 'snapshot') continue; // shouldn't appear here, but guard
    if (p.ts_start <= now_iso && now_iso < p.ts_end) {
      return {
        name: 'in_meeting',
        value: { value: true, ends_at: p.ts_end },
        computed_at: new Date().toISOString(),
      };
    }
  }

  const snapshot = load_calendar_snapshot(db, vault_root, user_id);
  if (snapshot) {
    for (const e of snapshot.events) {
      if (e.ts_start <= now_iso && now_iso < e.ts_end) {
        return {
          name: 'in_meeting',
          value: { value: true, ends_at: e.ts_end },
          computed_at: new Date().toISOString(),
        };
      }
    }
  }

  return {
    name: 'in_meeting',
    value: { value: false, ends_at: null },
    computed_at: new Date().toISOString(),
  };
}

// ── Calendar snapshot helpers ────────────────────────────────────────────
// Snapshots live in their own table (`calendar_snapshots`) keyed by
// user_id — one row per user, replaced on every ingest. Payload bytes
// follow the same vault-path convention as edge-triggered packets but
// under a `snapshot/` partition so daily folders don't fill with
// rewritten history.

interface CalendarSnapshotRow {
  user_id: string;
  captured_at: string;
  received_at: string;
  window_start: string;
  window_end: string;
  event_count: number;
  payload_path: string;
}

interface LoadedSnapshot {
  captured_at: string;
  window_start: string;
  window_end: string;
  event_count: number;
  events: z.infer<typeof CalendarSnapshotEvent>[];
}

function snapshot_rel_path(user_id: string, captured_at: string, id: string): string {
  const safe_ts = captured_at.replace(/[:]/g, '-');
  return `Users/${user_id}/sensors/calendar/snapshot/${safe_ts}-${id}.json`;
}

function load_calendar_snapshot(
  db: Database,
  vault_root: string,
  user_id: string,
): LoadedSnapshot | null {
  const row = db
    .prepare(
      `SELECT user_id, captured_at, received_at, window_start, window_end,
              event_count, payload_path
       FROM calendar_snapshots WHERE user_id = @u`,
    )
    .get({ '@u': user_id }) as CalendarSnapshotRow | undefined;
  if (!row) return null;
  const abs = packet_abs_path(vault_root, row.payload_path);
  if (!existsSync(abs)) return null;
  try {
    const parsed = JSON.parse(readFileSync(abs, 'utf8')) as {
      events?: unknown;
    };
    const events_parsed = z.array(CalendarSnapshotEvent).safeParse(parsed.events);
    if (!events_parsed.success) return null;
    return {
      captured_at: row.captured_at,
      window_start: row.window_start,
      window_end: row.window_end,
      event_count: row.event_count,
      events: events_parsed.data,
    };
  } catch {
    return null;
  }
}

// ── Calendar-derived signals over the snapshot ───────────────────────────

function compute_upcoming_events(
  db: Database,
  vault_root: string,
  user_id: string,
  limit: number,
): DerivedSignal {
  const snap = load_calendar_snapshot(db, vault_root, user_id);
  const now_iso = new Date().toISOString();
  if (!snap) {
    return {
      name: 'upcoming_events',
      value: { events: [], window_end: null },
      computed_at: now_iso,
    };
  }
  const upcoming = snap.events
    .filter((e) => e.ts_start >= now_iso)
    .sort((a, b) => (a.ts_start < b.ts_start ? -1 : a.ts_start > b.ts_start ? 1 : 0))
    .slice(0, limit);
  return {
    name: 'upcoming_events',
    value: {
      events: upcoming.map((e) => ({
        event_id: e.event_id,
        title: e.title,
        ts_start: e.ts_start,
        ts_end: e.ts_end,
        location: e.location ?? null,
        is_all_day: e.is_all_day,
        calendar_name: e.calendar_name,
        has_attendees: e.has_attendees,
      })),
      window_end: snap.window_end,
    },
    computed_at: now_iso,
  };
}

function compute_calendar_density(
  db: Database,
  vault_root: string,
  user_id: string,
  window_ms: number,
): DerivedSignal {
  // "Density" = fraction of the lookahead window covered by event
  // intervals (clipped to the window). All-day events count their full
  // duration. Overlapping events are merged before measuring so two
  // back-to-back conflicts don't inflate the score above 1.0.
  const now = Date.now();
  const end = now + window_ms;
  const now_iso = new Date(now).toISOString();
  const end_iso = new Date(end).toISOString();
  const snap = load_calendar_snapshot(db, vault_root, user_id);
  if (!snap) {
    return {
      name: 'calendar_density',
      value: { value: 0, busy_minutes: 0, window_minutes: window_ms / 60_000, event_count: 0 },
      computed_at: now_iso,
    };
  }

  type Interval = { start: number; end: number };
  const clipped: Interval[] = [];
  for (const e of snap.events) {
    const s_ms = Date.parse(e.ts_start);
    const e_ms = Date.parse(e.ts_end);
    if (!Number.isFinite(s_ms) || !Number.isFinite(e_ms)) continue;
    const cs = Math.max(s_ms, now);
    const ce = Math.min(e_ms, end);
    if (cs < ce) clipped.push({ start: cs, end: ce });
  }
  clipped.sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const iv of clipped) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      merged.push({ ...iv });
    }
  }
  const busy_ms = merged.reduce((acc, iv) => acc + (iv.end - iv.start), 0);
  const window_min = window_ms / 60_000;
  return {
    name: 'calendar_density',
    value: {
      value: window_ms > 0 ? busy_ms / window_ms : 0,
      busy_minutes: Math.round(busy_ms / 60_000),
      window_minutes: window_min,
      event_count: clipped.length,
      window_end: end_iso,
    },
    computed_at: now_iso,
  };
}

function compute_free_blocks(
  db: Database,
  vault_root: string,
  user_id: string,
  duration_min: number,
  window_ms: number,
): DerivedSignal {
  // Find gaps of >= duration_min minutes between events in the window
  // [now, now + window_ms]. Useful surface for specialists proposing
  // commitments — Kate can say "Tuesday 2-3pm is your only hour-long
  // hole this week" without the specialist having to walk events itself.
  const now = Date.now();
  const end = now + window_ms;
  const now_iso = new Date(now).toISOString();
  const duration_ms = duration_min * 60_000;
  const snap = load_calendar_snapshot(db, vault_root, user_id);
  if (!snap) {
    return {
      name: 'free_blocks',
      value: { blocks: [], duration_min, window_minutes: window_ms / 60_000 },
      computed_at: now_iso,
    };
  }

  type Interval = { start: number; end: number };
  const busy: Interval[] = [];
  for (const e of snap.events) {
    const s_ms = Date.parse(e.ts_start);
    const e_ms = Date.parse(e.ts_end);
    if (!Number.isFinite(s_ms) || !Number.isFinite(e_ms)) continue;
    const cs = Math.max(s_ms, now);
    const ce = Math.min(e_ms, end);
    if (cs < ce) busy.push({ start: cs, end: ce });
  }
  busy.sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const iv of busy) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      merged.push({ ...iv });
    }
  }

  const blocks: Array<{ start: string; end: string; duration_min: number }> = [];
  let cursor = now;
  for (const iv of merged) {
    if (iv.start - cursor >= duration_ms) {
      blocks.push({
        start: new Date(cursor).toISOString(),
        end: new Date(iv.start).toISOString(),
        duration_min: Math.round((iv.start - cursor) / 60_000),
      });
    }
    cursor = Math.max(cursor, iv.end);
  }
  if (end - cursor >= duration_ms) {
    blocks.push({
      start: new Date(cursor).toISOString(),
      end: new Date(end).toISOString(),
      duration_min: Math.round((end - cursor) / 60_000),
    });
  }

  return {
    name: 'free_blocks',
    value: {
      blocks,
      duration_min,
      window_minutes: window_ms / 60_000,
    },
    computed_at: now_iso,
  };
}

function compute_carplay_connected(
  db: Database,
  vault_root: string,
  user_id: string,
): DerivedSignal {
  const row = latest_packet(db, user_id, 'carplay');
  if (!row) {
    return {
      name: 'carplay_connected',
      value: { value: false, since: null },
      computed_at: new Date().toISOString(),
    };
  }
  const payload = load_payload(vault_root, row) as z.infer<typeof CarplayPayload> | null;
  const connected = payload?.state === 'connected';
  return {
    name: 'carplay_connected',
    value: {
      value: connected,
      since: connected ? payload?.since ?? row.captured_at : null,
    },
    computed_at: new Date().toISOString(),
  };
}

function compute_slept_hours(
  db: Database,
  vault_root: string,
  user_id: string,
): DerivedSignal {
  // Sum sleep-sample value (minutes) over the last 24h window, then
  // divide by 60. Sample shape per brief: value is a number-or-object.
  // For HealthKit's sleep samples we expect a numeric minutes-asleep
  // value (iOS aggregates per sleep session before pushing).
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = packets_since(db, user_id, 'healthkit', since);
  let minutes = 0;
  let counted = 0;
  for (const r of rows) {
    const p = load_payload(vault_root, r) as z.infer<typeof HealthkitPayload> | null;
    if (!p || p.sample_type !== 'sleep') continue;
    if (typeof p.value === 'number' && Number.isFinite(p.value)) {
      minutes += p.value;
      counted += 1;
    }
  }
  return {
    name: 'slept_hours',
    value: {
      value: counted > 0 ? minutes / 60 : null,
      window: 'last_24h',
      samples: counted,
    },
    computed_at: new Date().toISOString(),
  };
}

function compute_wrist_on(
  db: Database,
  vault_root: string,
  user_id: string,
): DerivedSignal {
  // Watch app deferred per § 14, but the schema is forward-compatible.
  // Return null until a Watch feeder lands; iOS uses the null marker
  // to gate Watch-only logic.
  void db; void vault_root; void user_id;
  return {
    name: 'wrist_on',
    value: { value: null },
    computed_at: new Date().toISOString(),
  };
}

interface QuerySpec {
  ttl_ms: number;
  /** URLSearchParams-based dispatch lets calendar-snapshot queries take
   *  `?limit=`, `?window=`, `?duration_min=` without each compute needing
   *  to know about the Hono context. Queries that don't need params just
   *  ignore the argument. */
  compute: (
    db: Database,
    vault_root: string,
    user_id: string,
    params: URLSearchParams,
    /** The user's home anchor (config/users.yaml `home_location`), or null when
     *  unconfigured. `is_home` decides home-ness from packet COORDINATES against
     *  it — live iOS payloads carry no `place_id`. See core/home_anchor.ts. */
    home_anchor: HomeAnchor | null,
  ) => DerivedSignal;
}

// ── Param parsers for snapshot-backed queries ────────────────────────────
// Shared so a malformed `?window=foo` always means the same fallback, and
// negative / absurd values can't blow up the compute step.

const ONE_HOUR_MS = 60 * 60_000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

function parse_int_param(params: URLSearchParams, key: string, fallback: number, min: number, max: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** Accepts `24h`, `7d`, `90m`, or a bare integer treated as minutes.
 *  Returns milliseconds. Falls back to `fallback_ms` on parse failure. */
function parse_window_ms(params: URLSearchParams, fallback_ms: number, max_ms: number): number {
  const raw = params.get('window');
  if (!raw) return fallback_ms;
  const m = /^(\d+)\s*(m|h|d)?$/i.exec(raw.trim());
  if (!m) return fallback_ms;
  const n = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback_ms;
  const unit = (m[2] ?? 'm').toLowerCase();
  const ms =
    unit === 'd' ? n * ONE_DAY_MS :
    unit === 'h' ? n * ONE_HOUR_MS :
                   n * 60_000;
  return Math.min(ms, max_ms);
}

const DERIVED_QUERIES: Record<string, QuerySpec> = {
  is_home:           { ttl_ms: 30_000, compute: (db, v, u, _p, anchor) => compute_is_home(db, v, u, anchor) },
  focus_mode:        { ttl_ms: 30_000, compute: (db, v, u) => compute_focus_mode(db, v, u) },
  in_meeting:        { ttl_ms: 30_000, compute: (db, v, u) => compute_in_meeting(db, v, u) },
  carplay_connected: { ttl_ms: 30_000, compute: (db, v, u) => compute_carplay_connected(db, v, u) },
  // Aggregations over a 24h window are more expensive — longer TTL.
  slept_hours:       { ttl_ms: 5 * 60_000, compute: (db, v, u) => compute_slept_hours(db, v, u) },
  wrist_on:          { ttl_ms: 30_000, compute: (db, v, u) => compute_wrist_on(db, v, u) },

  // Snapshot-backed queries. Cache TTL is generous (5 min) since the
  // snapshot only changes on bulk refresh (every 6h) or
  // EKEventStoreChangedNotification — edge-triggered events don't invalidate
  // these projections.
  upcoming_events: {
    ttl_ms: 5 * 60_000,
    compute: (db, v, u, params) =>
      compute_upcoming_events(db, v, u, parse_int_param(params, 'limit', 10, 1, 100)),
  },
  calendar_density: {
    ttl_ms: 5 * 60_000,
    compute: (db, v, u, params) =>
      compute_calendar_density(db, v, u, parse_window_ms(params, 24 * ONE_HOUR_MS, 30 * ONE_DAY_MS)),
  },
  free_blocks: {
    ttl_ms: 5 * 60_000,
    compute: (db, v, u, params) =>
      compute_free_blocks(
        db,
        v,
        u,
        parse_int_param(params, 'duration_min', 30, 5, 480),
        parse_window_ms(params, 7 * ONE_DAY_MS, 30 * ONE_DAY_MS),
      ),
  },
};

// ── Router ───────────────────────────────────────────────────────────────

export function create_sensors_router(deps: SensorsRoutesDeps): Hono {
  const r = new Hono();

  r.post('/:signal', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'authentication required' }, 401);
    const url_signal = c.req.param('signal');
    if (!url_signal || url_signal.length > 64) {
      return c.json({ error: 'invalid signal name' }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      return c.json({ error: `invalid JSON: ${(err as Error).message}` }, 400);
    }

    const env_parsed = SensorPacketEnvelope.safeParse(body);
    if (!env_parsed.success) {
      return c.json(
        { error: 'invalid SensorPacket envelope', issues: env_parsed.error.issues },
        400,
      );
    }
    if (env_parsed.data.signal !== url_signal) {
      return c.json(
        {
          error: `signal mismatch: URL=${url_signal} body.signal=${env_parsed.data.signal}`,
        },
        400,
      );
    }

    // Per-signal payload validation — strict when we know the shape,
    // pass-through (object only) when we don't.
    const payload_schema = PAYLOAD_SCHEMAS[url_signal] ?? PassThroughPayload;
    const payload_parsed = payload_schema.safeParse(env_parsed.data.payload);
    if (!payload_parsed.success) {
      return c.json(
        {
          error: `invalid payload for signal "${url_signal}"`,
          issues: payload_parsed.error.issues,
        },
        400,
      );
    }

    const rate = rate_check(user.id, url_signal);
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

    const id = ulid();
    const received_at = new Date().toISOString();
    const device_id = c.get('device_id') ?? null;

    // ── Calendar bulk-snapshot branch ─────────────────────────────────
    // Snapshots replace prior state instead of appending. Keep them out
    // of `sensor_packets` (which holds the append-only edge stream) and
    // route to `calendar_snapshots` keyed by user. One row per user,
    // one vault file per snapshot, prior file deleted on replace.
    if (
      url_signal === 'calendar' &&
      isCalendarSnapshot(payload_parsed.data)
    ) {
      const snap_rel_path = snapshot_rel_path(
        user.id,
        env_parsed.data.captured_at,
        id,
      );
      const snap_abs_path = packet_abs_path(deps.vault_root, snap_rel_path);

      // Read prior path (if any) before overwriting so we can drop its
      // file from disk after the DB swap succeeds.
      const prior = deps.db
        .prepare(
          `SELECT payload_path FROM calendar_snapshots WHERE user_id = @u`,
        )
        .get({ '@u': user.id }) as { payload_path: string } | undefined;

      try {
        mkdirSync(dirname(snap_abs_path), { recursive: true });
        writeFileSync(
          snap_abs_path,
          JSON.stringify(payload_parsed.data, null, 2),
        );
      } catch (err) {
        return c.json(
          { error: `failed to write snapshot: ${(err as Error).message}` },
          500,
        );
      }

      try {
        // Atomic DELETE+INSERT via a transaction so a partial write can
        // never leave the table without a row.
        deps.db.transaction(() => {
          deps.db
            .prepare(`DELETE FROM calendar_snapshots WHERE user_id = @u`)
            .run({ '@u': user.id });
          deps.db
            .prepare(
              `INSERT INTO calendar_snapshots
                 (user_id, captured_at, received_at, window_start, window_end,
                  event_count, payload_path)
               VALUES (@u, @cap, @rec, @ws, @we, @ec, @path)`,
            )
            .run({
              '@u': user.id,
              '@cap': env_parsed.data.captured_at,
              '@rec': received_at,
              '@ws': payload_parsed.data.window_start,
              '@we': payload_parsed.data.window_end,
              '@ec': payload_parsed.data.event_count,
              '@path': snap_rel_path,
            });
        })();
      } catch (err) {
        try { rmSync(snap_abs_path); } catch { /* ignore */ }
        return c.json(
          { error: `failed to index snapshot: ${(err as Error).message}` },
          500,
        );
      }

      // Drop prior file from disk best-effort. Keeping the table swap
      // atomic above means an orphan file is at worst harmless storage,
      // not an inconsistent index.
      if (prior && prior.payload_path && prior.payload_path !== snap_rel_path) {
        try { rmSync(packet_abs_path(deps.vault_root, prior.payload_path)); } catch { /* ignore */ }
      }

      cache_invalidate_for(user.id);

      deps.events.emit({
        type: 'sensor_packet_received',
        user_id: user.id,
        signal: url_signal,
        captured_at: env_parsed.data.captured_at,
        packet_id: id,
      });

      deps.memory.log_action({
        intent_id: `sensor_ingest:${id}`,
        agent: 'orchestrator',
        tool_name: 'sensor_ingest',
        tool_input: {
          signal: url_signal,
          kind: 'snapshot',
          captured_at: env_parsed.data.captured_at,
        },
        execution_result: {
          id,
          payload_path: snap_rel_path,
          device_id,
          event_count: payload_parsed.data.event_count,
        },
      });

      return c.json({ ok: true, id, kind: 'snapshot' });
    }

    // ── Music-context snapshot branch ─────────────────────────────────
    // Same shape as the calendar branch: write payload to the vault,
    // DELETE+INSERT atomically into the music_context table, drop the
    // prior file. Used by Maggie's intake_band_poster to score artist
    // affinity without standing up server-side MusicKit.
    if (url_signal === 'music_context') {
      const snap_rel_path = snapshot_rel_path(
        user.id,
        env_parsed.data.captured_at,
        id,
      );
      const snap_abs_path = packet_abs_path(deps.vault_root, snap_rel_path);

      const prior = deps.db
        .prepare(
          `SELECT 1 AS exists_row FROM music_context WHERE user_id = @u`,
        )
        .get({ '@u': user.id }) as { exists_row: number } | undefined;

      try {
        mkdirSync(dirname(snap_abs_path), { recursive: true });
        writeFileSync(
          snap_abs_path,
          JSON.stringify(payload_parsed.data, null, 2),
        );
      } catch (err) {
        return c.json(
          { error: `failed to write music snapshot: ${(err as Error).message}` },
          500,
        );
      }

      try {
        deps.db.transaction(() => {
          deps.db
            .prepare(`DELETE FROM music_context WHERE user_id = @u`)
            .run({ '@u': user.id });
          deps.db
            .prepare(
              `INSERT INTO music_context
                 (user_id, captured_at, received_at, snapshot_json)
               VALUES (@u, @cap, @rec, @json)`,
            )
            .run({
              '@u': user.id,
              '@cap': env_parsed.data.captured_at,
              '@rec': received_at,
              '@json': JSON.stringify(payload_parsed.data),
            });
        })();
      } catch (err) {
        try { rmSync(snap_abs_path); } catch { /* ignore */ }
        return c.json(
          { error: `failed to index music snapshot: ${(err as Error).message}` },
          500,
        );
      }

      cache_invalidate_for(user.id);

      deps.events.emit({
        type: 'sensor_packet_received',
        user_id: user.id,
        signal: url_signal,
        captured_at: env_parsed.data.captured_at,
        packet_id: id,
      });

      deps.memory.log_action({
        intent_id: `sensor_ingest:${id}`,
        agent: 'orchestrator',
        tool_name: 'sensor_ingest',
        tool_input: {
          signal: url_signal,
          kind: 'snapshot',
          captured_at: env_parsed.data.captured_at,
        },
        execution_result: {
          id,
          payload_path: snap_rel_path,
          replaced_prior: Boolean(prior),
        },
      });

      return c.json({ ok: true, id, kind: 'snapshot' });
    }

    // ── Edge-triggered / single-shot packet branch ────────────────────
    const rel_path = packet_rel_path({
      user_id: user.id,
      signal: url_signal,
      captured_at: env_parsed.data.captured_at,
      id,
      tz: c.get('user_tz'),
    });
    const abs_path = packet_abs_path(deps.vault_root, rel_path);

    try {
      mkdirSync(dirname(abs_path), { recursive: true });
      writeFileSync(abs_path, JSON.stringify(payload_parsed.data, null, 2));
    } catch (err) {
      return c.json(
        { error: `failed to write packet: ${(err as Error).message}` },
        500,
      );
    }

    try {
      deps.db
        .prepare(
          `INSERT INTO sensor_packets
             (id, user_id, device_id, signal, captured_at, received_at, payload_path)
           VALUES (@id, @user_id, @device_id, @signal, @captured_at, @received_at, @path)`,
        )
        .run({
          '@id': id,
          '@user_id': user.id,
          '@device_id': device_id,
          '@signal': url_signal,
          '@captured_at': env_parsed.data.captured_at,
          '@received_at': received_at,
          '@path': rel_path,
        });
    } catch (err) {
      // Roll back the file write so we don't orphan it.
      try { rmSync(abs_path); } catch { /* ignore */ }
      return c.json(
        { error: `failed to index packet: ${(err as Error).message}` },
        500,
      );
    }

    cache_invalidate_for(user.id);

    deps.events.emit({
      type: 'sensor_packet_received',
      user_id: user.id,
      signal: url_signal,
      captured_at: env_parsed.data.captured_at,
      packet_id: id,
    });

    // HA webhook fan-out for calendar edge-triggered events. No-op when
    // HEARTH_HA_WEBHOOK_URL is unset; fire-and-forget otherwise.
    if (url_signal === 'calendar') {
      const parsed = payload_parsed.data as z.infer<typeof CalendarPayload>;
      if (parsed.kind !== 'snapshot') {
        fire_ha_calendar_webhook({ user_id: user.id, payload: parsed });
      }
    }

    deps.memory.log_action({
      intent_id: `sensor_ingest:${id}`,
      agent: 'orchestrator',
      tool_name: 'sensor_ingest',
      tool_input: { signal: url_signal, captured_at: env_parsed.data.captured_at },
      execution_result: { id, payload_path: rel_path, device_id },
    });

    return c.json({ ok: true, id });
  });

  r.get('/derived/:query', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'authentication required' }, 401);
    const query = c.req.param('query');
    const spec = DERIVED_QUERIES[query];
    if (!spec) {
      return c.json(
        {
          error: `unknown derived query: ${query}`,
          available: Object.keys(DERIVED_QUERIES),
        },
        404,
      );
    }
    // Parse the query string once and use it both for compute and the
    // cache key. Sorting the param suffix keeps `?a=1&b=2` and
    // `?b=2&a=1` sharing a cache entry — semantically identical queries.
    const url = new URL(c.req.url);
    const params = url.searchParams;
    const sorted_suffix = Array.from(params.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const cache_key = sorted_suffix
      ? `${user.id}:${query}?${sorted_suffix}`
      : `${user.id}:${query}`;
    const cached = cache_get(cache_key);
    if (cached !== null) return c.json(cached);
    const computed = spec.compute(
      deps.db,
      deps.vault_root,
      user.id,
      params,
      deps.users?.home_coords(user.id) ?? null,
    );
    cache_put(cache_key, computed, spec.ttl_ms);
    return c.json(computed);
  });

  r.get('/status', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'authentication required' }, 401);
    const since_24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // Pull stats per signal in one query. UNION the known-signal list
    // with anything that has actually arrived so a custom signal still
    // shows up in the UI.
    const known = Object.keys(PAYLOAD_SCHEMAS);
    const seen_rows = deps.db
      .prepare(
        `SELECT signal FROM sensor_packets WHERE user_id = @u GROUP BY signal`,
      )
      .all({ '@u': user.id }) as Array<{ signal: string }>;
    const all_signals = Array.from(
      new Set<string>([...known, ...seen_rows.map((s) => s.signal)]),
    ).sort();

    const last_stmt = deps.db.prepare(
      `SELECT MAX(captured_at) as ts FROM sensor_packets
       WHERE user_id = @u AND signal = @s`,
    );
    const count_stmt = deps.db.prepare(
      `SELECT COUNT(*) as n FROM sensor_packets
       WHERE user_id = @u AND signal = @s AND received_at >= @since`,
    );
    const dev_stmt = deps.db.prepare(
      `SELECT COUNT(DISTINCT device_id) as n FROM sensor_packets
       WHERE user_id = @u AND signal = @s AND device_id IS NOT NULL`,
    );

    const signals = all_signals.map((s) => {
      const last = (last_stmt.get({ '@u': user.id, '@s': s }) as { ts: string | null } | undefined)?.ts ?? null;
      const count_24h = (count_stmt.get({ '@u': user.id, '@s': s, '@since': since_24h }) as { n: number } | undefined)?.n ?? 0;
      const devs = (dev_stmt.get({ '@u': user.id, '@s': s }) as { n: number } | undefined)?.n ?? 0;
      return {
        name: s,
        last_received_at: last,
        packet_count_24h: count_24h,
        enabled_devices: devs,
      };
    });

    return c.json({ signals });
  });

  // ── Monitored places for iOS geofencing ─────────────────────────────
  //
  // GET /api/sensors/places/monitored?limit=15
  //   → { places: [{ id, label, lat, lng, radius_m }] }
  //
  // The set of geofence regions iOS should register with CLMonitor /
  // region monitoring. Unions the user's LEARNED `location_corridors`
  // (where they actually go — ranked by frequency then recency) with
  // curated `places` (POIs that carry coords, ranked by recency).
  // Corridors come first (highest-signal), then places fill remaining
  // slots. Hard-capped at 20 — iOS's per-app region-monitoring limit.
  // De-duped on a coarse coord key so a corridor centered on a known
  // place doesn't double-register. Namespaced under /api/sensors/* so
  // the existing nginx `sensors` prefix routes it with no proxy change.
  const DEFAULT_PLACE_RADIUS_M = 150;
  const REGION_HARD_CAP = 20;

  r.get('/places/monitored', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'authentication required' }, 401);

    const raw_limit = Number(new URL(c.req.url).searchParams.get('limit') ?? '15');
    const limit = Math.max(
      1,
      Math.min(REGION_HARD_CAP, Number.isFinite(raw_limit) ? Math.floor(raw_limit) : 15),
    );

    const corridors = deps.db
      .prepare(
        `SELECT id, label, center_lat AS lat, center_lon AS lng, radius_m
           FROM location_corridors
          WHERE user_id = @u AND center_lat IS NOT NULL AND center_lon IS NOT NULL
          ORDER BY visit_count DESC, last_seen_at DESC
          LIMIT @lim`,
      )
      .all({ '@u': user.id, '@lim': limit }) as Array<{
      id: string;
      label: string;
      lat: number;
      lng: number;
      radius_m: number;
    }>;

    const places = deps.db
      .prepare(
        `SELECT id, name AS label, lat, lon AS lng
           FROM places
          WHERE lat IS NOT NULL AND lon IS NOT NULL
          ORDER BY mtime DESC
          LIMIT @lim`,
      )
      .all({ '@lim': limit }) as Array<{
      id: string;
      label: string;
      lat: number;
      lng: number;
    }>;

    const seen = new Set<string>();
    const coord_key = (lat: number, lng: number) =>
      `${lat.toFixed(3)},${lng.toFixed(3)}`;
    const out: Array<{
      id: string;
      label: string;
      lat: number;
      lng: number;
      radius_m: number;
    }> = [];

    // HOME rides FIRST, always (2026-07-15, the security-autonomy audit).
    // The list used to be purely learned-corridors ∪ curated-places — nothing
    // guaranteed the home anchor made the cut, so iOS could go months never
    // geofencing HOME and presence read 'unknown' between sparse visit
    // events. A home region gives the resolver its best signal: sticky
    // region_enter/region_exit edges exactly at the anchor. The seen-key
    // dedupes any learned corridor centered on home behind it.
    const home = deps.users?.home_coords(user.id);
    if (home) {
      seen.add(coord_key(home.lat, home.lng));
      out.push({
        id: 'home',
        label: home.label ?? 'Home',
        lat: home.lat,
        lng: home.lng,
        radius_m: 180,
      });
    }

    for (const corr of corridors) {
      const k = coord_key(corr.lat, corr.lng);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        id: corr.id,
        label: corr.label,
        lat: corr.lat,
        lng: corr.lng,
        radius_m: Math.round(corr.radius_m),
      });
    }
    for (const p of places) {
      if (out.length >= limit) break;
      const k = coord_key(p.lat, p.lng);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        id: p.id,
        label: p.label,
        lat: p.lat,
        lng: p.lng,
        radius_m: DEFAULT_PLACE_RADIUS_M,
      });
    }

    return c.json({ places: out.slice(0, limit) });
  });

  return r;
}
