/**
 * Geographic helpers — great-circle distance + corridor-affinity scoring.
 *
 * Ruby's office promotes civic items (traffic, construction, events) that
 * sit on routes Jasper actually travels. "Routes he travels" are the
 * `location_corridors` her background job learns from the location sensor
 * stream; scoring a civic item's coordinates against those corridors is
 * the geographic analogue of Maggie's music play-share affinity.
 */

import type { LocationCorridor } from '@memory/client';

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in meters between two lat/lon points. */
export function haversine_m(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface CorridorMatch {
  label: string;
  distance_m: number;
  /** 0..1 — 1 at the corridor center, decaying linearly to 0 at radius. */
  affinity: number;
}

/**
 * Best corridor match for a point, or null when the point is outside
 * every corridor's catchment. Affinity decays linearly from 1 at the
 * center to 0 at `radius_m` — how strongly this location sits on a route
 * Jasper actually travels.
 */
export function score_corridors(
  lat: number,
  lon: number,
  corridors: LocationCorridor[],
): CorridorMatch | null {
  let best: CorridorMatch | null = null;
  for (const c of corridors) {
    const d = haversine_m(lat, lon, c.center_lat, c.center_lon);
    if (d > c.radius_m) continue;
    const affinity = 1 - d / c.radius_m;
    if (!best || affinity > best.affinity) {
      best = { label: c.label, distance_m: d, affinity };
    }
  }
  return best;
}

export interface ClusterPoint {
  lat: number;
  lon: number;
  ts: string;
  place_id: string | null;
}

export interface RawCorridor {
  label: string;
  center_lat: number;
  center_lon: number;
  radius_m: number;
  visit_count: number;
  last_seen_at: string | null;
}

/**
 * Single-pass greedy spatial clustering of location points into
 * corridors. A point joins the first existing cluster whose running
 * centroid is within `merge_radius_m`; otherwise it seeds a new cluster.
 * Centroids update incrementally as members join. After clustering,
 * clusters below `min_visits` are dropped as noise (a corridor has to be
 * visited repeatedly to earn promotion — this is what "refines over time"
 * means: more history → more, tighter corridors). Each surviving cluster's
 * radius is the max member distance from its centroid, floored / capped so
 * a single anchor still has a sensible catchment and a sprawling cluster
 * doesn't swallow the whole city.
 */
export function cluster_corridors(
  points: ClusterPoint[],
  opts: {
    merge_radius_m?: number;
    min_visits?: number;
    floor_radius_m?: number;
    cap_radius_m?: number;
  } = {},
): RawCorridor[] {
  const merge_radius_m = opts.merge_radius_m ?? 400;
  const min_visits = opts.min_visits ?? 3;
  const floor_radius_m = opts.floor_radius_m ?? 300;
  const cap_radius_m = opts.cap_radius_m ?? 2_500;

  interface Acc {
    lat: number;
    lon: number;
    n: number;
    last_seen: string | null;
    place_ids: Map<string, number>;
    members: Array<{ lat: number; lon: number }>;
  }
  const clusters: Acc[] = [];

  for (const p of points) {
    let target: Acc | null = null;
    let best_d = Infinity;
    for (const c of clusters) {
      const d = haversine_m(p.lat, p.lon, c.lat, c.lon);
      if (d <= merge_radius_m && d < best_d) {
        best_d = d;
        target = c;
      }
    }
    if (!target) {
      target = {
        lat: p.lat,
        lon: p.lon,
        n: 0,
        last_seen: null,
        place_ids: new Map(),
        members: [],
      };
      clusters.push(target);
    }
    // Incremental centroid update.
    target.n += 1;
    target.lat += (p.lat - target.lat) / target.n;
    target.lon += (p.lon - target.lon) / target.n;
    target.members.push({ lat: p.lat, lon: p.lon });
    if (!target.last_seen || p.ts > target.last_seen) target.last_seen = p.ts;
    if (p.place_id) target.place_ids.set(p.place_id, (target.place_ids.get(p.place_id) ?? 0) + 1);
  }

  const out: RawCorridor[] = [];
  let ordinal = 0;
  for (const c of clusters) {
    if (c.n < min_visits) continue;
    ordinal += 1;
    let spread = 0;
    for (const m of c.members) {
      const d = haversine_m(m.lat, m.lon, c.lat, c.lon);
      if (d > spread) spread = d;
    }
    const radius_m = Math.min(cap_radius_m, Math.max(floor_radius_m, spread));
    // Prefer the dominant place_id as a stable, human-meaningful label;
    // fall back to an ordinal. (Reverse-geocoding to a street/neighborhood
    // name is a future refinement — see PLAN.md.)
    let label = `Frequent area ${ordinal}`;
    let top_place: string | null = null;
    let top_n = 0;
    for (const [pid, n] of c.place_ids) {
      if (n > top_n) {
        top_n = n;
        top_place = pid;
      }
    }
    if (top_place) label = top_place;
    out.push({
      label,
      center_lat: c.lat,
      center_lon: c.lon,
      radius_m,
      visit_count: c.n,
      last_seen_at: c.last_seen,
    });
  }
  // Busiest corridors first.
  out.sort((a, b) => b.visit_count - a.visit_count);
  return out;
}
