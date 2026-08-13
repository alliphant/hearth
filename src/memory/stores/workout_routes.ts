/**
 * Ride routes + the coaching-cue ledger (Live Ride Companion Phase 3 —
 * the coached-ride map + route learning).
 *
 * PRIVACY: this is the most privileged data in the system — actual GPS
 * tracks of the user's rides. Stored at the OWNER's explicit request
 * (2026-06-12: "coaching should show up on a map that routes the path
 * I take"). The contract:
 *   - rows are cordoned to the session's user (the sessions API
 *     enforces caller == owner of the session; no cross-user reads,
 *     no owner god-view over another user's rides),
 *   - raw coordinates NEVER appear in audit rows (point counts +
 *     length only — same redaction posture as the maps connector),
 *   - routes are NEVER exposed to cross-specialist sharing or the
 *     ambient location feed; they live in Astrid's ride domain only.
 *
 * ROUTE LEARNING: rides over the same path group together via a
 * deterministic fingerprint match (start + end proximity, length
 * ratio, mean point-to-path distance). The group id is the FIRST
 * session's id; `group_stats` turns a group into evidence ("your 5th
 * time on this loop; best is 48 min") for live cues, session-end
 * recaps, and ride names.
 *
 * The cue ledger (workout_session_cues) records every DELIVERED cue
 * with its timestamp, trigger, class, and the throttle's reason — the
 * map joins cue.ts to the nearest route point so each pin can say
 * WHAT she said and WHY, exactly where she said it.
 */

import type { Database } from 'bun:sqlite';

export interface RoutePoint {
  /** ISO timestamp of the fix. */
  t: string;
  lat: number;
  lon: number;
  /** Altitude in meters, when the device provided it. */
  ele?: number | null;
}

export interface WorkoutRouteRow {
  session_id: string;
  user_id: string;
  ts: string;
  points: RoutePoint[];
  start_lat: number;
  start_lon: number;
  end_lat: number;
  end_lon: number;
  length_m: number;
  point_count: number;
  route_group_id: string;
}

export interface RouteGroupStats {
  route_group_id: string;
  times_ridden: number;
  best_duration_s: number | null;
  last_duration_s: number | null;
  /** Most recent non-null ride_name in the group — the route's de facto name. */
  name: string | null;
}

export interface SessionCueRow {
  cue_id: string;
  session_id: string;
  user_id: string;
  ts: string;
  elapsed_s: number | null;
  trigger_id: string;
  cls: string | null;
  text: string;
  reason: string | null;
  clip_id: string | null;
}

const MAX_STORED_POINTS = 1200;
const MATCH_ENDPOINT_M = 400;
const MATCH_LENGTH_RATIO = 0.18;
const MATCH_MEAN_DIST_M = 250;
const MATCH_SAMPLES = 16;
const MATCH_GROUPS_SCAN_CAP = 50;

const DDL = `
CREATE TABLE IF NOT EXISTS workout_routes (
  session_id     TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  ts             TEXT NOT NULL,
  points_json    TEXT NOT NULL,
  start_lat      REAL NOT NULL,
  start_lon      REAL NOT NULL,
  end_lat        REAL NOT NULL,
  end_lon        REAL NOT NULL,
  length_m       REAL NOT NULL,
  point_count    INTEGER NOT NULL,
  route_group_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workout_routes_user ON workout_routes(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_workout_routes_group ON workout_routes(route_group_id);

CREATE TABLE IF NOT EXISTS workout_session_cues (
  cue_id     TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  ts         TEXT NOT NULL,
  elapsed_s  INTEGER,
  trigger_id TEXT NOT NULL,
  cls        TEXT,
  text       TEXT NOT NULL,
  reason     TEXT,
  clip_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_workout_session_cues_session ON workout_session_cues(session_id);
`;

export function haversine_m(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const to_rad = (d: number) => (d * Math.PI) / 180;
  const dlat = to_rad(lat2 - lat1);
  const dlon = to_rad(lon2 - lon1);
  const a =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(to_rad(lat1)) * Math.cos(to_rad(lat2)) * Math.sin(dlon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function track_length_m(points: Array<{ lat: number; lon: number }>): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += haversine_m(points[i - 1]!.lat, points[i - 1]!.lon, points[i]!.lat, points[i]!.lon);
  }
  return total;
}

/** Evenly thin a track to at most n points (keeps first + last). */
export function thin_track<T>(points: T[], n: number): T[] {
  if (points.length <= n) return points;
  const out: T[] = [];
  const step = (points.length - 1) / (n - 1);
  for (let i = 0; i < n; i += 1) {
    out.push(points[Math.round(i * step)]!);
  }
  return out;
}

/** Mean distance from sampled points of `a` to the nearest point of `b`. */
function mean_min_distance_m(
  a: Array<{ lat: number; lon: number }>,
  b: Array<{ lat: number; lon: number }>,
): number {
  const samples = thin_track(a, MATCH_SAMPLES);
  let sum = 0;
  for (const p of samples) {
    let best = Number.POSITIVE_INFINITY;
    for (const q of b) {
      const d = haversine_m(p.lat, p.lon, q.lat, q.lon);
      if (d < best) best = d;
    }
    sum += best;
  }
  return sum / samples.length;
}

/** True when two tracks plausibly trace the same route. */
export function tracks_match(
  a: { points: Array<{ lat: number; lon: number }>; length_m: number },
  b: { points: Array<{ lat: number; lon: number }>; length_m: number },
): boolean {
  const a0 = a.points[0];
  const aN = a.points[a.points.length - 1];
  const b0 = b.points[0];
  const bN = b.points[b.points.length - 1];
  if (!a0 || !aN || !b0 || !bN) return false;
  if (haversine_m(a0.lat, a0.lon, b0.lat, b0.lon) > MATCH_ENDPOINT_M) return false;
  if (haversine_m(aN.lat, aN.lon, bN.lat, bN.lon) > MATCH_ENDPOINT_M) return false;
  const ratio = Math.abs(a.length_m - b.length_m) / Math.max(a.length_m, b.length_m, 1);
  if (ratio > MATCH_LENGTH_RATIO) return false;
  return mean_min_distance_m(a.points, b.points) <= MATCH_MEAN_DIST_M;
}

export class WorkoutRouteStore {
  constructor(private db: Database) {
    this.db.exec(DDL);
  }

  /** Store a session's route, thinning + assigning its route group. */
  upsert(args: {
    session_id: string;
    user_id: string;
    points: RoutePoint[];
  }): WorkoutRouteRow {
    const points = thin_track(args.points, MAX_STORED_POINTS);
    const length_m = track_length_m(points);
    const first = points[0]!;
    const last = points[points.length - 1]!;
    const group = this.match_group(args.user_id, { points, length_m }) ?? args.session_id;
    const row: WorkoutRouteRow = {
      session_id: args.session_id,
      user_id: args.user_id,
      ts: new Date().toISOString(),
      points,
      start_lat: first.lat,
      start_lon: first.lon,
      end_lat: last.lat,
      end_lon: last.lon,
      length_m,
      point_count: points.length,
      route_group_id: group,
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO workout_routes
           (session_id, user_id, ts, points_json, start_lat, start_lon, end_lat, end_lon, length_m, point_count, route_group_id)
         VALUES (@sid, @uid, @ts, @pts, @slat, @slon, @elat, @elon, @len, @n, @grp)`,
      )
      .run({
        '@sid': row.session_id,
        '@uid': row.user_id,
        '@ts': row.ts,
        '@pts': JSON.stringify(points),
        '@slat': row.start_lat,
        '@slon': row.start_lon,
        '@elat': row.end_lat,
        '@elon': row.end_lon,
        '@len': row.length_m,
        '@n': row.point_count,
        '@grp': row.route_group_id,
      });
    return row;
  }

  get(session_id: string): WorkoutRouteRow | null {
    const r = this.db
      .prepare('SELECT * FROM workout_routes WHERE session_id = @s')
      .get({ '@s': session_id }) as
      | (Omit<WorkoutRouteRow, 'points'> & { points_json: string })
      | null;
    if (!r) return null;
    let points: RoutePoint[] = [];
    try {
      points = JSON.parse(r.points_json) as RoutePoint[];
    } catch {
      points = [];
    }
    const { points_json: _drop, ...rest } = r;
    return { ...rest, points };
  }

  /**
   * Match a track (full or LIVE partial) against the user's known
   * route groups. For a partial live track only the START gate +
   * point-to-path proximity apply — you don't know the end yet.
   */
  match_group(
    user_id: string,
    track: { points: Array<{ lat: number; lon: number }>; length_m: number },
    opts?: { partial?: boolean },
  ): string | null {
    const reps = this.db
      .prepare(
        `SELECT session_id, points_json, length_m, route_group_id,
                MAX(ts) AS latest
           FROM workout_routes
          WHERE user_id = @u
          GROUP BY route_group_id
          ORDER BY latest DESC
          LIMIT @cap`,
      )
      .all({ '@u': user_id, '@cap': MATCH_GROUPS_SCAN_CAP }) as Array<{
      points_json: string;
      length_m: number;
      route_group_id: string;
    }>;
    const t0 = track.points[0];
    if (!t0) return null;
    for (const rep of reps) {
      let rep_points: RoutePoint[];
      try {
        rep_points = JSON.parse(rep.points_json) as RoutePoint[];
      } catch {
        continue;
      }
      if (rep_points.length < 2) continue;
      if (opts?.partial) {
        const r0 = rep_points[0]!;
        if (haversine_m(t0.lat, t0.lon, r0.lat, r0.lon) > MATCH_ENDPOINT_M) continue;
        if (track.length_m > rep.length_m * (1 + MATCH_LENGTH_RATIO)) continue;
        if (mean_min_distance_m(track.points, rep_points) <= MATCH_MEAN_DIST_M) {
          return rep.route_group_id;
        }
        continue;
      }
      if (tracks_match(track, { points: rep_points, length_m: rep.length_m })) {
        return rep.route_group_id;
      }
    }
    return null;
  }

  /** Group evidence — times ridden, best/last duration, de facto name. */
  group_stats(user_id: string, route_group_id: string): RouteGroupStats {
    const rows = this.db
      .prepare(
        `SELECT r.session_id, s.total_duration_s, s.ride_name, s.started_at
           FROM workout_routes r
           LEFT JOIN workout_sessions s ON s.session_id = r.session_id
          WHERE r.user_id = @u AND r.route_group_id = @g
          ORDER BY s.started_at DESC`,
      )
      .all({ '@u': user_id, '@g': route_group_id }) as Array<{
      total_duration_s: number | null;
      ride_name: string | null;
      started_at: string | null;
    }>;
    const durations = rows.map((r) => r.total_duration_s).filter((d): d is number => d != null && d > 0);
    return {
      route_group_id,
      times_ridden: rows.length,
      best_duration_s: durations.length > 0 ? Math.min(...durations) : null,
      last_duration_s: rows.length > 1 ? (rows[1]?.total_duration_s ?? null) : null,
      name: rows.find((r) => r.ride_name != null)?.ride_name ?? null,
    };
  }

  // ── Cue ledger ─────────────────────────────────────────────────────

  record_cue(row: SessionCueRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO workout_session_cues
           (cue_id, session_id, user_id, ts, elapsed_s, trigger_id, cls, text, reason, clip_id)
         VALUES (@id, @sid, @uid, @ts, @el, @trig, @cls, @text, @reason, @clip)`,
      )
      .run({
        '@id': row.cue_id,
        '@sid': row.session_id,
        '@uid': row.user_id,
        '@ts': row.ts,
        '@el': row.elapsed_s,
        '@trig': row.trigger_id,
        '@cls': row.cls,
        '@text': row.text,
        '@reason': row.reason,
        '@clip': row.clip_id,
      });
  }

  cues_for_session(session_id: string): SessionCueRow[] {
    return this.db
      .prepare('SELECT * FROM workout_session_cues WHERE session_id = @s ORDER BY ts ASC')
      .all({ '@s': session_id }) as SessionCueRow[];
  }
}
