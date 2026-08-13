/**
 * Process-wide cached location snapshot.
 *
 * Source: iOS CoreLocation packets posted to /api/sensors/location by
 * the Hearth iOS app (LocationSensorFeeder). The app emits edge-
 * triggered events — `visit_arrival`, `visit_departure`, `region_enter`,
 * `region_exit`, `significant_change` — each carrying lat/lng,
 * horizontal accuracy, optional place_id, and a wall-clock ts.
 *
 * Pre-2026-05-30 this module polled HA's device_tracker via the now-
 * removed `ha_get_my_location` connector tool. HA Companion is no
 * longer the location source; Hearth iOS is. This module reads the
 * latest `location`-signal row from sensor_packets, loads the payload
 * file from the vault, and caches the derived snapshot per-user with
 * a short in-memory TTL so a chat turn that calls get_current_location
 * several times doesn't re-read SQLite + the file each call.
 *
 * Cache miss / no packet ever / unreadable payload → empty snapshot
 * with `available: false`. Consumers (maps `my_current_location`,
 * plan_ev_day start coord, deliberation spatial context) already
 * degrade gracefully on `coords: null`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve as path_resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
import { snapshot_ttl_ms } from './privacy';

export type LocationKind =
  | 'visit_arrival'
  | 'visit_departure'
  | 'region_enter'
  | 'region_exit'
  | 'significant_change'
  | 'foreground_fix';

export interface LocationSnapshot {
  coords: { lat: number; lon: number } | null;
  horizontal_accuracy_m: number | null;
  place_id: string | null;
  kind: LocationKind | null;
  ts: string;
  staleness_seconds: number;
  confidence: 'high' | 'medium' | 'low';
  cached_at_ms: number;
  available: boolean;
}

const EMPTY_SNAPSHOT: LocationSnapshot = {
  coords: null,
  horizontal_accuracy_m: null,
  place_id: null,
  kind: null,
  ts: new Date(0).toISOString(),
  staleness_seconds: Number.MAX_SAFE_INTEGER,
  confidence: 'low',
  cached_at_ms: 0,
  available: false,
};

let _db: Database | null = null;
let _vault_root: string | null = null;
const _cache = new Map<string, { snap: LocationSnapshot; expires_at_ms: number }>();

/** Called once at orchestrator boot. */
export function init_location_awareness(db: Database, vault_root: string): void {
  _db = db;
  _vault_root = vault_root;
}

/** Test-only: clear the cache. */
export function reset_location_cache(): void {
  _cache.clear();
}

/** Test-only: prime the cache for a user with a synthetic snapshot. */
export function _set_cached_snapshot(user_id: string, snap: Partial<LocationSnapshot>): void {
  const merged: LocationSnapshot = {
    ...EMPTY_SNAPSHOT,
    ...snap,
    cached_at_ms: Date.now(),
    available: snap.coords != null,
  };
  _cache.set(user_id, { snap: merged, expires_at_ms: Date.now() + snapshot_ttl_ms() });
}

interface LocationPacketRow {
  captured_at: string;
  payload_path: string;
}

interface LocationPayload {
  kind: LocationKind;
  lat: number;
  lng: number;
  horizontal_accuracy_m?: number;
  place_id?: string | null;
  ts: string;
}

function classify_confidence(
  staleness_seconds: number,
  accuracy_m: number | null,
): 'high' | 'medium' | 'low' {
  if (staleness_seconds < 300 && accuracy_m !== null && accuracy_m < 50) return 'high';
  if (staleness_seconds < 1800 || (accuracy_m !== null && accuracy_m < 200)) return 'medium';
  return 'low';
}

function read_latest_packet(user_id: string): LocationSnapshot {
  if (!_db || !_vault_root) return EMPTY_SNAPSHOT;
  const row = _db
    .prepare(
      `SELECT captured_at, payload_path FROM sensor_packets
       WHERE user_id = @u AND signal = 'location'
       ORDER BY captured_at DESC LIMIT 1`,
    )
    .get({ '@u': user_id }) as LocationPacketRow | undefined;
  if (!row) return EMPTY_SNAPSHOT;

  const abs = path_resolve(_vault_root, row.payload_path);
  if (!existsSync(abs)) return EMPTY_SNAPSHOT;
  let payload: LocationPayload;
  try {
    payload = JSON.parse(readFileSync(abs, 'utf8')) as LocationPayload;
  } catch {
    return EMPTY_SNAPSHOT;
  }

  const ts = payload.ts ?? row.captured_at;
  const ts_ms = Date.parse(ts);
  const staleness_seconds = Number.isFinite(ts_ms)
    ? Math.max(0, Math.floor((Date.now() - ts_ms) / 1000))
    : Number.MAX_SAFE_INTEGER;
  const accuracy = payload.horizontal_accuracy_m ?? null;

  return {
    coords: { lat: payload.lat, lon: payload.lng },
    horizontal_accuracy_m: accuracy,
    place_id: payload.place_id ?? null,
    kind: payload.kind,
    ts,
    staleness_seconds,
    confidence: classify_confidence(staleness_seconds, accuracy),
    cached_at_ms: Date.now(),
    available: true,
  };
}

/**
 * Latest location snapshot for the given user, derived from their most
 * recent iOS location packet. Falls back to the empty/unavailable
 * snapshot when no packet has arrived, the payload file is missing, or
 * init_location_awareness hasn't been called yet (smokes mocking the
 * cache directly via `_set_cached_snapshot` skip the DB path entirely).
 *
 * Async return type preserved from the pre-2026-05-30 HA-polling shape;
 * the implementation is sync but callers already await it.
 */
export async function get_current_location(user_id: string): Promise<LocationSnapshot> {
  const now = Date.now();
  const cached = _cache.get(user_id);
  if (cached && cached.expires_at_ms > now) return cached.snap;
  const snap = read_latest_packet(user_id);
  _cache.set(user_id, { snap, expires_at_ms: now + snapshot_ttl_ms() });
  return snap;
}

/**
 * Render a one-line spatial context string for deliberation prompts.
 * Uses place_id when known (post-2026-05-30 iOS region/visit IDs);
 * falls back to a "lat,lon" stub otherwise.
 */
// ── Recent-trip awareness ───────────────────────────────────────────────
//
// get_current_location answers "where is the user NOW" (one packet). It
// cannot answer "where did the user GO" — the trips out of the house by car
// or bike. iOS posts the edge events that make a trip reconstructable
// (visit_arrival / visit_departure / region_enter / region_exit, plus
// significant_change while in transit); the functions below assemble those
// events into a chronological list of visits the user can be told about.
//
// Travel MODE (car vs bike) rides the optional `motion` field on each event
// — iOS attaches CMMotionActivity when available. Until the iOS feeder ships
// that field every event's motion is null and `motion_available` is false,
// so a consumer reports place + time honestly and omits the mode rather than
// guessing it.

/** Travel-mode classification carried on a location event, when iOS posted
 *  it (CMMotionActivity). `unknown` is an explicit low-confidence value;
 *  null means the field was absent entirely. */
export type MotionMode =
  | 'automotive'
  | 'cycling'
  | 'walking'
  | 'running'
  | 'stationary'
  | 'unknown';

/** One iOS location packet, with the fields a trip reconstruction needs —
 *  `kind` and `motion`, both of which list_location_points() drops. */
export interface LocationEvent {
  kind: LocationKind;
  lat: number;
  lon: number;
  ts: string;
  place_id: string | null;
  horizontal_accuracy_m: number | null;
  motion: MotionMode | null;
}

/** A reconstructed stop: somewhere the user was, between an arrival and a
 *  departure (either may be unknown when it falls outside the window). */
export interface TripVisit {
  place_label: string;
  coords: { lat: number; lon: number };
  arrived_at: string | null;
  departed_at: string | null;
  duration_minutes: number | null;
  /** Travel mode INTO this stop, when iOS posted motion for the arrival or
   *  the transit leg preceding it. Null when motion wasn't recorded. */
  arrived_via: MotionMode | null;
  /** True when no departure was seen — the user is (probably) still here. */
  ongoing: boolean;
}

export interface RecentTripsSummary {
  visits: TripVisit[];
  event_count: number;
  window_start: string;
  window_end: string;
  /** Did ANY event in the window carry a real motion mode? When false the
   *  caller should say travel mode isn't recorded yet, not infer it. */
  motion_available: boolean;
}

const ARRIVAL_KINDS: ReadonlySet<LocationKind> = new Set<LocationKind>([
  'visit_arrival',
  'region_enter',
]);
const DEPARTURE_KINDS: ReadonlySet<LocationKind> = new Set<LocationKind>([
  'visit_departure',
  'region_exit',
]);

function place_label_for(place_id: string | null, lat: number, lon: number): string {
  return place_id ?? `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

function minutes_between(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ma = Date.parse(a);
  const mb = Date.parse(b);
  if (!Number.isFinite(ma) || !Number.isFinite(mb) || mb < ma) return null;
  return Math.round((mb - ma) / 60000);
}

/**
 * Assemble edge-triggered location events into a chronological list of
 * visits. Pure (no DB / clock dependence) so it's directly unit-testable;
 * the recent_trips tool reads the events via MemoryClient and feeds them in.
 *
 * The walk is deliberately forgiving of missing pairs (iOS edge events drop):
 *  - arrival/enter → open a visit (closing any open one as an inferred
 *    departure when the place changed);
 *  - departure/exit → close the open visit, or emit an arrival-unknown visit
 *    when none was open (the user left a place we never saw them enter);
 *  - significant_change → in transit; only updates the running travel mode;
 *  - an open visit at the end of the window is marked `ongoing`.
 */
export function summarize_recent_trips(
  events: LocationEvent[],
  opts?: { max_visits?: number },
): RecentTripsSummary {
  const sorted = [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const visits: TripVisit[] = [];
  let open: TripVisit | null = null;
  let last_motion: MotionMode | null = null;

  const close_open = (departed_at: string | null): void => {
    if (!open) return;
    open.departed_at = departed_at;
    open.duration_minutes = minutes_between(open.arrived_at, departed_at);
    visits.push(open);
    open = null;
  };

  for (const ev of sorted) {
    if (ev.motion && ev.motion !== 'unknown') last_motion = ev.motion;

    if (ARRIVAL_KINDS.has(ev.kind)) {
      const label = place_label_for(ev.place_id, ev.lat, ev.lon);
      // A new arrival at a different place means we (implicitly) left the
      // previous one; close it with this arrival as the inferred departure.
      if (open && open.place_label !== label) close_open(ev.ts);
      if (!open) {
        open = {
          place_label: label,
          coords: { lat: ev.lat, lon: ev.lon },
          arrived_at: ev.ts,
          departed_at: null,
          duration_minutes: null,
          arrived_via: ev.motion ?? last_motion,
          ongoing: false,
        };
      }
    } else if (DEPARTURE_KINDS.has(ev.kind)) {
      if (open) {
        close_open(ev.ts);
      } else {
        // Left a place we never saw entered (it predates the window).
        visits.push({
          place_label: place_label_for(ev.place_id, ev.lat, ev.lon),
          coords: { lat: ev.lat, lon: ev.lon },
          arrived_at: null,
          departed_at: ev.ts,
          duration_minutes: null,
          arrived_via: null,
          ongoing: false,
        });
      }
    }
    // significant_change: transit only — already folded into last_motion.
  }

  if (open) {
    open.ongoing = true;
    visits.push(open);
  }

  // Newest first — the user cares about the most recent trips.
  visits.reverse();
  const capped = opts?.max_visits ? visits.slice(0, opts.max_visits) : visits;

  const times = sorted.map((e) => e.ts).filter(Boolean);
  return {
    visits: capped,
    event_count: events.length,
    window_start: times[0] ?? '',
    window_end: times[times.length - 1] ?? '',
    motion_available: sorted.some((e) => e.motion != null && e.motion !== 'unknown'),
  };
}

export function spatial_context_summary(snap: LocationSnapshot): string {
  if (!snap.available || !snap.coords) {
    return "Jasper's location is currently unknown.";
  }
  const where =
    snap.place_id ??
    `${snap.coords.lat.toFixed(3)},${snap.coords.lon.toFixed(3)}`;
  const acc =
    snap.horizontal_accuracy_m !== null
      ? `${Math.round(snap.horizontal_accuracy_m)}m accuracy.`
      : '';
  const kind_phrase =
    snap.kind === 'visit_arrival' || snap.kind === 'region_enter'
      ? 'at'
      : snap.kind === 'visit_departure' || snap.kind === 'region_exit'
        ? 'leaving'
        : 'near';
  return (
    `Jasper is ${kind_phrase} ${where}, confidence: ${snap.confidence}, ` +
    `as of ${snap.ts}. ${acc}`.trimEnd()
  );
}
