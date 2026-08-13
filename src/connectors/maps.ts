/**
 * Maps connector. Four tools — geocode, route, distance_matrix, nearby —
 * dispatched to a configurable provider stack. Local-first defaults:
 * OSRM for routing (drive/bike/walk on separate ports), Nominatim for
 * geocoding, Overpass for POI search. Optional Mapbox / Google Maps
 * fallback with traffic-aware ETAs when MAPBOX_TOKEN or
 * GOOGLE_MAPS_API_KEY is set.
 *
 * Audit redaction (PART 10): coordinates are rounded to 3 decimals before
 * any audit_log row is written. Street-level addresses are stripped down
 * to "<city>, <region>". The full data flows freely through specialist
 * reasoning — only the recording side is redacted.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import { safe_fetch } from './_audit';
import { maps_cache } from './maps_cache';
import { audit_redaction_enabled } from '@core/privacy';
import { get_current_location } from '@core/location_awareness';

// ── Provider configuration ──────────────────────────────────────────────

const NOMINATIM_BASE_URL =
  process.env.NOMINATIM_BASE_URL ?? 'http://localhost:8989';
const OSRM_DRIVE_URL =
  process.env.OSRM_DRIVE_URL ?? 'http://localhost:5001';
const OSRM_BIKE_URL =
  process.env.OSRM_BIKE_URL ?? 'http://localhost:5002';
const OSRM_WALK_URL =
  process.env.OSRM_WALK_URL ?? 'http://localhost:5003';
const OVERPASS_URL =
  process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';

const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN ?? '';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY ?? '';
const MAPS_PRIMARY = (process.env.MAPS_PRIMARY ?? 'osrm') as MapsProvider;
const MAPS_FALLBACK_RAW = process.env.MAPS_FALLBACK ?? '';
const MAPS_HIGH_PRECISION = process.env.MAPS_HIGH_PRECISION === 'true';

const TIMEOUT_MS = 30_000;

export type MapsProvider = 'osrm' | 'mapbox' | 'google';

interface ProviderState {
  primary: MapsProvider;
  fallback: MapsProvider | null;
}

export function get_providers(): ProviderState {
  let fallback: MapsProvider | null = null;
  if (MAPS_FALLBACK_RAW === 'mapbox' && MAPBOX_TOKEN) fallback = 'mapbox';
  else if (MAPS_FALLBACK_RAW === 'google' && GOOGLE_MAPS_API_KEY) fallback = 'google';
  else if (!MAPS_FALLBACK_RAW) {
    if (MAPBOX_TOKEN) fallback = 'mapbox';
    else if (GOOGLE_MAPS_API_KEY) fallback = 'google';
  }
  return { primary: MAPS_PRIMARY, fallback };
}

// ── Audit redaction (PART 10) ───────────────────────────────────────────

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function redact_point(p: { lat: number; lon: number } | undefined):
  | { lat: number; lon: number }
  | undefined {
  if (!p) return p;
  if (!audit_redaction_enabled()) return p;
  return { lat: round3(p.lat), lon: round3(p.lon) };
}

/**
 * Strip a street-level address to "<city>, <region>" if it looks
 * civic-recognizable; otherwise the literal string "<address redacted>".
 */
function redact_address(addr: string | undefined | null): string | null {
  if (!addr) return addr ?? null;
  if (!audit_redaction_enabled()) return addr;
  const parts = addr.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return parts.slice(-2).join(', ');
  }
  return '<address redacted>';
}

export function redact_for_audit(input: unknown): unknown {
  if (input === null || typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map(redact_for_audit);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if ((k === 'lat' || k === 'lon') && typeof v === 'number') {
      out[k] = audit_redaction_enabled() ? round3(v) : v;
    } else if (k === 'coords' && Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number') {
      out[k] = audit_redaction_enabled() ? [round3(v[0]), round3(v[1])] : v;
    } else if (k === 'address' && typeof v === 'string') {
      out[k] = redact_address(v);
    } else if (k === 'geocoded_address' && typeof v === 'string') {
      out[k] = redact_address(v);
    } else if (k === 'from' || k === 'to' || k === 'point' || k === 'near') {
      out[k] = redact_for_audit(v);
    } else if (k === 'origins' || k === 'destinations') {
      out[k] = redact_for_audit(v);
    } else {
      out[k] = redact_for_audit(v);
    }
  }
  return out;
}

function audit_log(
  ctx: ToolContext,
  tool_name: string,
  input: unknown,
  result: unknown,
  error?: string,
): void {
  ctx.memory.log_action({
    intent_id: ctx.intent_id || ulid(),
    agent: 'maps_connector',
    tool_name,
    tool_input: redact_for_audit(input),
    execution_result: error
      ? undefined
      : { provider: (result as { provider?: string })?.provider, ok: !error },
    error,
  });
}

// ── geocode ─────────────────────────────────────────────────────────────

const GeocodeInput = z.object({
  query: z.string().min(1).max(500),
  near: z
    .object({
      lat: z.number(),
      lon: z.number(),
      radius_km: z.number().positive().max(500).default(50),
    })
    .optional(),
});

const GeocodeResult = z.object({
  name: z.string(),
  address: z.string(),
  lat: z.number(),
  lon: z.number(),
  type: z.enum(['address', 'poi', 'locality', 'region']),
  confidence: z.number().min(0).max(1),
});

const GeocodeOutput = z.object({
  results: z.array(GeocodeResult),
  provider: z.enum(['osrm', 'mapbox', 'google', 'none']).default('none'),
  error: z.string().optional(),
  // Affordance hint, populated only when no result was found, so the model
  // gets an actionable next step instead of an ambiguous empty array (which
  // it otherwise retries with reformatted query variants until it spirals).
  recovery_hint: z.string().optional(),
});

type GeocodeIn = z.infer<typeof GeocodeInput>;
type GeocodeOut = z.infer<typeof GeocodeOutput>;
type GeocodeRes = z.infer<typeof GeocodeResult>;

interface NominatimResult {
  display_name?: string;
  lat?: string;
  lon?: string;
  importance?: number;
  type?: string;
  class?: string;
  name?: string;
}

async function geocode_nominatim(input: GeocodeIn): Promise<GeocodeRes[]> {
  const params = new URLSearchParams({
    q: input.query,
    format: 'jsonv2',
    limit: '5',
    addressdetails: '0',
  });
  if (input.near) {
    // Nominatim "viewbox" uses lon1,lat1,lon2,lat2 (left,top,right,bottom).
    const dlon = input.near.radius_km / 111;
    const dlat = input.near.radius_km / 111;
    params.set(
      'viewbox',
      `${input.near.lon - dlon},${input.near.lat + dlat},${input.near.lon + dlon},${input.near.lat - dlat}`,
    );
    params.set('bounded', '1');
  }
  const url = `${NOMINATIM_BASE_URL.replace(/\/$/, '')}/search?${params.toString()}`;
  const res = await safe_fetch(
    url,
    { headers: { 'User-Agent': 'hearth-maps/0.1' } },
    TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(res.error ?? `nominatim HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const arr = JSON.parse(res.body) as NominatimResult[];
  const out: GeocodeRes[] = [];
  for (const r of arr) {
    if (!r.lat || !r.lon) continue;
    const lat = parseFloat(r.lat);
    const lon = parseFloat(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const t = classify_osm_type(r.class, r.type);
    out.push({
      name: r.name ?? r.display_name ?? input.query,
      address: r.display_name ?? '',
      lat,
      lon,
      type: t,
      confidence: typeof r.importance === 'number' ? Math.min(1, r.importance) : 0.5,
    });
  }
  return out;
}

function classify_osm_type(
  cls: string | undefined,
  type: string | undefined,
): GeocodeRes['type'] {
  if (cls === 'place' && (type === 'city' || type === 'town' || type === 'village' || type === 'hamlet'))
    return 'locality';
  if (cls === 'place' && (type === 'state' || type === 'region' || type === 'country'))
    return 'region';
  if (cls === 'amenity' || cls === 'shop' || cls === 'tourism' || cls === 'leisure')
    return 'poi';
  return 'address';
}

interface MapboxGeocodingFeature {
  text?: string;
  place_name?: string;
  center?: [number, number]; // [lon, lat]
  relevance?: number;
  place_type?: string[];
}

async function geocode_mapbox(input: GeocodeIn): Promise<GeocodeRes[]> {
  const params = new URLSearchParams({
    access_token: MAPBOX_TOKEN,
    limit: '5',
  });
  if (input.near) {
    params.set('proximity', `${input.near.lon},${input.near.lat}`);
  }
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(
    input.query,
  )}.json?${params.toString()}`;
  const res = await safe_fetch(url, {}, TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(res.error ?? `mapbox HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const json = JSON.parse(res.body) as { features?: MapboxGeocodingFeature[] };
  const out: GeocodeRes[] = [];
  for (const f of json.features ?? []) {
    if (!f.center) continue;
    const [lon, lat] = f.center;
    const pt = f.place_type?.[0];
    const type: GeocodeRes['type'] =
      pt === 'address' ? 'address'
        : pt === 'poi' ? 'poi'
          : pt === 'place' || pt === 'locality' ? 'locality'
            : pt === 'region' || pt === 'country' ? 'region'
              : 'address';
    out.push({
      name: f.text ?? input.query,
      address: f.place_name ?? '',
      lat,
      lon,
      type,
      confidence: typeof f.relevance === 'number' ? f.relevance : 0.7,
    });
  }
  return out;
}

/**
 * Reverse-geocode a point to a short, human label — used to name Ruby's
 * learned location corridors (e.g. "S College Ave, Old Town" instead of
 * "Frequent area 2"). Prefers road, then neighbourhood/suburb, then the
 * locality. Best-effort: returns null on any failure so the caller falls
 * back to its own label. Hits the same local Nominatim instance as
 * forward geocoding.
 */
export async function reverse_geocode_label(
  lat: number,
  lon: number,
): Promise<string | null> {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    format: 'jsonv2',
    addressdetails: '1',
    zoom: '16',
  });
  const url = `${NOMINATIM_BASE_URL.replace(/\/$/, '')}/reverse?${params.toString()}`;
  try {
    const res = await safe_fetch(
      url,
      { headers: { 'User-Agent': 'hearth-maps/0.1' } },
      TIMEOUT_MS,
    );
    if (!res.ok) return null;
    const j = JSON.parse(res.body) as {
      address?: Record<string, string>;
      name?: string;
    };
    const a = j.address ?? {};
    const road = a.road ?? a.pedestrian ?? a.cycleway ?? a.footway;
    const area = a.neighbourhood ?? a.suburb ?? a.quarter ?? a.hamlet;
    const city = a.city ?? a.town ?? a.village;
    if (road && area) return `${road}, ${area}`;
    if (road && city) return `${road}, ${city}`;
    if (road) return road;
    if (area) return area;
    if (city) return city;
    if (j.name && j.name.length > 0) return j.name;
    return null;
  } catch {
    return null;
  }
}

export const geocode: Tool<GeocodeIn, GeocodeOut> = {
  name: 'geocode',
  description:
    'Resolve a place name or address to coordinates. Optional `near` biases results to a point + radius. Primary: local Nominatim; falls back to Mapbox if MAPBOX_TOKEN is set and primary returned no usable result.',
  risk: 'read',
  required_capabilities: ['query_maps'],
  input_schema: GeocodeInput,
  output_schema: GeocodeOutput,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.query);
    if (input.near) h.update(`@${input.near.lat},${input.near.lon},${input.near.radius_km}`);
    return `geocode:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<GeocodeOut> {
    // Cache hit?
    const cache_key = `geocode:${JSON.stringify(input)}`;
    const cached = maps_cache.get(cache_key) as GeocodeOut | undefined;
    if (cached) return cached;

    const providers = get_providers();
    let results: GeocodeRes[] = [];
    let provider_used: GeocodeOut['provider'] = 'none';
    let error: string | undefined;

    try {
      if (providers.primary === 'osrm') {
        results = await geocode_nominatim(input);
        provider_used = 'osrm';
      } else if (providers.primary === 'mapbox' && MAPBOX_TOKEN) {
        results = await geocode_mapbox(input);
        provider_used = 'mapbox';
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    // Fallback if primary failed or returned weak/no result.
    const need_fallback =
      providers.fallback &&
      (error !== undefined ||
        results.length === 0 ||
        (results[0]?.confidence ?? 1) < 0.3);
    if (need_fallback && providers.fallback === 'mapbox' && MAPBOX_TOKEN) {
      try {
        const fb = await geocode_mapbox(input);
        if (fb.length > 0) {
          results = fb;
          provider_used = 'mapbox';
          error = undefined;
        }
      } catch (err) {
        if (!error) error = err instanceof Error ? err.message : String(err);
      }
    }

    const out: GeocodeOut =
      results.length === 0
        ? {
            results: [],
            provider: provider_used,
            error:
              error ?? `no match for "${input.query}" in the loaded map data`,
            recovery_hint:
              `The geocoder found no match for "${input.query}" in the locally-loaded ` +
              `OpenStreetMap data (this Hearth instance loads a limited map region). The ` +
              `lookup already ran — do NOT retry reformatted variants of the same address. ` +
              `Confirm the address with the user, or use web_search for an approximate ` +
              `location. Never invent coordinates.`,
          }
        : { results, provider: provider_used };

    // Audit carries only the real transport error (a not-found is a legitimate
    // empty, not a connector fault) so health monitoring isn't polluted.
    audit_log(ctx, 'geocode', input, out, error);
    // Cache only successful, non-empty results. A not-found / out-of-region miss
    // must stay retryable: the loaded map region can change (re-import) and the
    // address may later resolve, so caching the empty would serve a stale "not found".
    if (results.length > 0) maps_cache.set(cache_key, out);

    // Vault writeback (PART 5).
    if (results.length > 0 && results[0]) {
      const top = results[0];
      void writeback_geocode_to_vault(ctx, input.query, top).catch((err) => {
        console.error('[maps] geocode writeback failed:', err);
      });
    }

    return out;
  },
};

/**
 * If the geocode query matches a known Place name/alias or a Person's
 * address field, update its coords. Best-effort — failures are logged
 * but don't fail the geocode call.
 */
async function writeback_geocode_to_vault(
  ctx: ToolContext,
  query: string,
  top: GeocodeRes,
): Promise<void> {
  // Match on Place name/alias.
  try {
    const place = ctx.memory.find_place_by_name?.(query);
    if (place && (place.lat == null || place.lon == null)) {
      ctx.memory.update_place_coords?.(place.id, top.lat, top.lon);
      ctx.memory.log_action({
        intent_id: ctx.intent_id || ulid(),
        agent: 'maps_connector',
        tool_name: 'geocode_writeback',
        tool_input: redact_for_audit({ place_id: place.id, kind: 'place' }),
        execution_result: { updated: true },
      });
    }
  } catch (err) {
    void err;
  }
  // Match on Person name (exact, case-insensitive). The address writeback
  // path is invoked by Kate's tools when she enriches a Person — we
  // don't speculatively rewrite People notes from arbitrary geocodes.
}

// ── route ───────────────────────────────────────────────────────────────

const PointSchema = z.object({ lat: z.number(), lon: z.number() });

// Note: stringified-nested-object handling lives in tool_registry.invoke()
// via _normalize_qwen_tool_args. These schemas don't need a per-tool
// preprocess for that quirk — bare-string inputs are still accepted as
// addresses or place names to be geocoded internally.

const FromSchema = z.union([
  PointSchema,
  z.object({ my_current_location: z.literal(true) }),
  z.object({ place_id: z.string() }),
  z.object({ address: z.string().min(1) }),
  z.string().min(1), // bare string: address or place name
]);

const ToSchema = z.union([
  PointSchema,
  z.object({ place_id: z.string() }),
  z.object({ address: z.string().min(1) }),
  z.string().min(1),
]);

const RouteInput = z.object({
  from: FromSchema,
  to: ToSchema,
  mode: z.enum(['drive', 'bike', 'walk']),
  depart_at: z.string().optional(),
  include_geometry: z.boolean().default(false),
});

const RouteOutput = z.object({
  distance_meters: z.number(),
  duration_seconds: z.number(),
  duration_in_traffic_seconds: z.number().optional(),
  provider: z.enum(['osrm', 'mapbox', 'google']),
  /**
   * Major road segments traversed, in order. Each entry has the
   * road name, its own bearing (the cardinal direction THAT SEGMENT
   * travels — NOT the overall trip direction; a north-south road
   * used while heading east on a longer trip is still north-south),
   * and the distance covered on that road in meters. Source of
   * truth for narrating the route — do not infer a road's
   * orientation; read it here.
   */
  via_roads: z
    .array(
      z.object({
        name: z.string(),
        bearing_compass: z.enum(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']),
        bearing_degrees: z.number(),
        distance_meters: z.number(),
      }),
    )
    .default([]),
  /**
   * Compass bearing from `from` to `to` (degrees, 0=N, 90=E, 180=S, 270=W).
   * Just the great-circle direction — useful for sentences like "head
   * northeast." Don't confuse with the actual driving direction.
   */
  bearing_degrees: z.number(),
  bearing_compass: z.enum(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']),
  geometry: z.unknown().optional(),
  error: z.string().optional(),
});

type RouteIn = z.infer<typeof RouteInput>;
type RouteOut = z.infer<typeof RouteOutput>;

function osrm_url_for_mode(mode: 'drive' | 'bike' | 'walk'): string {
  return mode === 'drive'
    ? OSRM_DRIVE_URL
    : mode === 'bike'
      ? OSRM_BIKE_URL
      : OSRM_WALK_URL;
}

function osrm_profile_for_mode(mode: 'drive' | 'bike' | 'walk'): string {
  return mode === 'drive' ? 'driving' : mode === 'bike' ? 'cycling' : 'walking';
}

interface OsrmStep {
  name?: string;
  distance?: number;
  maneuver?: {
    type?: string;
    /** [lon, lat] where this step's maneuver fires (i.e. the step's start). */
    location?: [number, number];
    bearing_before?: number;
    bearing_after?: number;
  };
}

interface OsrmLeg {
  steps?: OsrmStep[];
  distance?: number;
  duration?: number;
}

export interface VRoad {
  name: string;
  bearing_compass: 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';
  bearing_degrees: number;
  distance_meters: number;
}

interface OsrmRouteResp {
  code?: string;
  routes?: Array<{
    distance?: number;
    duration?: number;
    geometry?: unknown;
    legs?: OsrmLeg[];
  }>;
  message?: string;
}

function _bearing_to_compass(deg: number): VRoad['bearing_compass'] {
  return (['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const)[
    Math.round(((deg + 360) % 360) / 45) % 8
  ]!;
}

/**
 * Extract major road segments from OSRM's per-step output. Consecutive
 * steps sharing a road name are merged into one segment (OSRM splits
 * roads at intersections, but a human thinks of "took Mulberry for
 * 1.2 mi" as one segment). Each segment's bearing is computed from
 * its start point to the start of the next step (= its end point);
 * for the final step we use bearing_before. We drop anything under
 * 200 m so parking-lot maneuvers don't clutter the list.
 */
function extract_major_roads(legs: OsrmLeg[] | undefined): VRoad[] {
  if (!legs) return [];
  // Flatten all steps, keep ordered.
  const steps: OsrmStep[] = [];
  for (const leg of legs) {
    for (const s of leg.steps ?? []) steps.push(s);
  }
  if (steps.length === 0) return [];

  // Compute end-location of each step (== start of next step).
  function step_start(i: number): [number, number] | null {
    return steps[i]?.maneuver?.location ?? null;
  }
  function step_bearing_deg(i: number): number {
    const start = step_start(i);
    const end = step_start(i + 1);
    if (start && end) {
      return compute_bearing(
        { lat: start[1], lon: start[0] },
        { lat: end[1], lon: end[0] },
      ).degrees;
    }
    // Last step: fall back to the step's own bearing_before (the
    // direction you were heading as you ENTERED the maneuver).
    return steps[i]?.maneuver?.bearing_before ?? 0;
  }

  const out: VRoad[] = [];
  let cur: VRoad | null = null;
  let cur_key: string | null = null;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    const name = (s.name ?? '').trim();
    const dist = s.distance ?? 0;
    if (!name || dist < 50) {
      // Skip noise; don't break cur — we may pick the same name up
      // again on the next step.
      continue;
    }
    const key = name.toLowerCase();
    const bearing_deg = step_bearing_deg(i);
    if (cur && cur_key === key) {
      cur.distance_meters += dist;
      // Re-derive bearing as the weighted mean direction across the
      // merged span. Simpler: just take the longest sub-step's
      // bearing — we already have one, leave it.
    } else {
      if (cur && cur.distance_meters >= 200) out.push(cur);
      cur = {
        name,
        bearing_degrees: bearing_deg,
        bearing_compass: _bearing_to_compass(bearing_deg),
        distance_meters: dist,
      };
      cur_key = key;
    }
  }
  if (cur && cur.distance_meters >= 200) out.push(cur);
  // Cap at a reasonable number — beyond ~10 the list isn't useful.
  return out.slice(0, 12);
}

function compute_bearing(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): { degrees: number; compass: 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW' } {
  const φ1 = (from.lat * Math.PI) / 180;
  const φ2 = (to.lat * Math.PI) / 180;
  const Δλ = ((to.lon - from.lon) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  const deg = ((θ * 180) / Math.PI + 360) % 360;
  const compass = (['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const)[
    Math.round(deg / 45) % 8
  ]!;
  return { degrees: deg, compass };
}

async function route_osrm(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  mode: 'drive' | 'bike' | 'walk',
  include_geometry: boolean,
): Promise<{
  distance_meters: number;
  duration_seconds: number;
  via_roads: VRoad[];
  geometry?: unknown;
}> {
  const base = osrm_url_for_mode(mode);
  const prof = osrm_profile_for_mode(mode);
  const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
  const params = new URLSearchParams({
    overview: include_geometry ? 'simplified' : 'false',
    alternatives: 'false',
    steps: 'true',
    geometries: 'geojson',
  });
  const url = `${base.replace(/\/$/, '')}/route/v1/${prof}/${coords}?${params.toString()}`;
  const res = await safe_fetch(url, {}, TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(res.error ?? `osrm HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const json = JSON.parse(res.body) as OsrmRouteResp;
  if (json.code && json.code !== 'Ok') {
    throw new Error(`osrm code=${json.code}: ${json.message ?? ''}`);
  }
  const r = json.routes?.[0];
  if (!r || typeof r.distance !== 'number' || typeof r.duration !== 'number') {
    throw new Error('osrm returned no route');
  }
  const out: {
    distance_meters: number;
    duration_seconds: number;
    via_roads: VRoad[];
    geometry?: unknown;
  } = {
    distance_meters: r.distance,
    duration_seconds: r.duration,
    via_roads: extract_major_roads(r.legs),
  };
  if (include_geometry && r.geometry) out.geometry = r.geometry;
  return out;
}

interface MapboxRouteResp {
  code?: string;
  routes?: Array<{
    distance?: number;
    duration?: number;
    duration_typical?: number;
    geometry?: unknown;
    legs?: Array<{
      steps?: Array<{
        name?: string;
        distance?: number;
      }>;
    }>;
  }>;
}

async function route_mapbox(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  mode: 'drive' | 'bike' | 'walk',
  include_geometry: boolean,
  depart_at?: string,
): Promise<{
  distance_meters: number;
  duration_seconds: number;
  duration_in_traffic_seconds?: number;
  via_roads: VRoad[];
  geometry?: unknown;
}> {
  const profile =
    mode === 'drive'
      ? depart_at
        ? 'driving-traffic'
        : 'driving'
      : mode === 'bike'
        ? 'cycling'
        : 'walking';
  const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
  const params = new URLSearchParams({
    access_token: MAPBOX_TOKEN,
    overview: include_geometry ? 'simplified' : 'false',
    alternatives: 'false',
    steps: 'true',
    geometries: 'geojson',
  });
  if (depart_at && profile === 'driving-traffic') {
    params.set('depart_at', depart_at);
  }
  const url = `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coords}?${params.toString()}`;
  const res = await safe_fetch(url, {}, TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(res.error ?? `mapbox HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const json = JSON.parse(res.body) as MapboxRouteResp;
  const r = json.routes?.[0];
  if (!r || typeof r.distance !== 'number' || typeof r.duration !== 'number') {
    throw new Error('mapbox returned no route');
  }
  const out: {
    distance_meters: number;
    duration_seconds: number;
    duration_in_traffic_seconds?: number;
    via_roads: VRoad[];
    geometry?: unknown;
  } = {
    distance_meters: r.distance,
    duration_seconds: r.duration,
    via_roads: extract_major_roads(r.legs as OsrmLeg[] | undefined),
  };
  if (profile === 'driving-traffic') {
    out.duration_in_traffic_seconds = r.duration;
  }
  if (include_geometry && r.geometry) out.geometry = r.geometry;
  return out;
}

async function _resolve_endpoint(
  ctx: ToolContext,
  ep: z.infer<typeof FromSchema> | z.infer<typeof ToSchema>,
  allow_current: boolean,
): Promise<{ point: { lat: number; lon: number } | null; error?: string }> {
  // Bare string: try Place lookup first, then geocode.
  if (typeof ep === 'string') {
    const place = ctx.memory.find_place_by_name?.(ep);
    if (place && place.lat != null && place.lon != null) {
      return { point: { lat: place.lat, lon: place.lon } };
    }
    const g = await geocode.execute({ query: ep }, ctx);
    const top = g.results[0];
    if (!top) {
      return {
        point: null,
        error: `could not geocode "${ep}" — not found in the loaded map region; confirm the address with the user or use web_search, don't retry variants`,
      };
    }
    return { point: { lat: top.lat, lon: top.lon } };
  }
  if (
    allow_current &&
    'my_current_location' in ep &&
    (ep as { my_current_location?: boolean }).my_current_location
  ) {
    const loc_user = ctx.user?.id ?? process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
    const snap = await get_current_location(loc_user);
    if (!snap.coords) {
      return { point: null, error: 'current location unavailable' };
    }
    return { point: snap.coords };
  }
  if ('place_id' in ep && typeof ep.place_id === 'string') {
    const place = ctx.memory.find_place_by_id?.(ep.place_id);
    if (!place || place.lat == null || place.lon == null) {
      return { point: null, error: `place ${ep.place_id} has no coords` };
    }
    return { point: { lat: place.lat, lon: place.lon } };
  }
  if ('address' in ep && typeof ep.address === 'string') {
    // First check Places, then geocode.
    const place = ctx.memory.find_place_by_name?.(ep.address);
    if (place && place.lat != null && place.lon != null) {
      return { point: { lat: place.lat, lon: place.lon } };
    }
    const g = await geocode.execute({ query: ep.address }, ctx);
    const top = g.results[0];
    if (!top) {
      return {
        point: null,
        error: `could not geocode "${ep.address}" — not found in the loaded map region; confirm the address with the user or use web_search, don't retry variants`,
      };
    }
    return { point: { lat: top.lat, lon: top.lon } };
  }
  const pt = ep as { lat: number; lon: number };
  if (typeof pt.lat !== 'number' || typeof pt.lon !== 'number') {
    return { point: null, error: 'endpoint missing lat/lon' };
  }
  return { point: { lat: pt.lat, lon: pt.lon } };
}

async function resolve_from(
  ctx: ToolContext,
  from: z.infer<typeof FromSchema>,
): Promise<{ point: { lat: number; lon: number } | null; error?: string }> {
  return _resolve_endpoint(ctx, from, true);
}

async function resolve_to(
  ctx: ToolContext,
  to: z.infer<typeof ToSchema>,
): Promise<{ point: { lat: number; lon: number } | null; error?: string }> {
  return _resolve_endpoint(ctx, to, false);
}

export const route: Tool<RouteIn, RouteOut> = {
  name: 'route',
  description:
    'Compute the route between two locations for drive / bike / walk. Easy path: pass plain strings — they can be addresses ("302 S College Ave") or Place names ("Home", "the clinic VTH"). Example: {from: "302 S College Ave", to: "3215 Westwood Ct", mode: "drive"}. Coordinate objects {lat, lon} also work. Returns: distance_meters, duration_seconds, **bearing_compass** (cardinal direction from→to: N/NE/E/SE/S/SW/W/NW — use THIS, not your own geography, when telling the user which way the destination is), and **via_roads** (the major road segments traversed, in order, each with its OWN bearing_compass and distance_meters). Each road in via_roads carries its own bearing — that is the direction THAT SEGMENT travels, not the trip overall. A north-south road used during an overall eastward trip is still north-south; do not call it east-west. If via_roads is empty, just give distance + time and say you do not have turn-by-turn detail. Never invent road names or road orientations not present in via_roads.',
  risk: 'read',
  required_capabilities: ['query_maps'],
  input_schema: RouteInput,
  output_schema: RouteOutput,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(JSON.stringify({ from: input.from, to: input.to, mode: input.mode }));
    return `route:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<RouteOut> {
    const f = await resolve_from(ctx, input.from);
    if (f.error || !f.point) {
      const out: RouteOut = {
        distance_meters: 0,
        duration_seconds: 0,
        provider: 'osrm',
        via_roads: [],
        bearing_degrees: 0,
        bearing_compass: 'N',
        error: f.error ?? 'could not resolve `from`',
      };
      audit_log(ctx, 'route', input, out, out.error);
      return out;
    }
    const t = await resolve_to(ctx, input.to);
    if (t.error || !t.point) {
      const out: RouteOut = {
        distance_meters: 0,
        duration_seconds: 0,
        provider: 'osrm',
        via_roads: [],
        bearing_degrees: 0,
        bearing_compass: 'N',
        error: t.error ?? 'could not resolve `to`',
      };
      audit_log(ctx, 'route', input, out, out.error);
      return out;
    }

    const providers = get_providers();
    let primary_result:
      | {
          distance_meters: number;
          duration_seconds: number;
          via_roads: VRoad[];
          geometry?: unknown;
        }
      | null = null;
    let provider_used: RouteOut['provider'] = 'osrm';
    let primary_err: string | undefined;

    try {
      if (providers.primary === 'osrm') {
        primary_result = await route_osrm(f.point, t.point, input.mode, input.include_geometry);
        provider_used = 'osrm';
      } else if (providers.primary === 'mapbox' && MAPBOX_TOKEN) {
        primary_result = await route_mapbox(
          f.point,
          t.point,
          input.mode,
          input.include_geometry,
          input.depart_at,
        );
        provider_used = 'mapbox';
      }
    } catch (err) {
      primary_err = err instanceof Error ? err.message : String(err);
    }

    if (!primary_result && providers.fallback === 'mapbox' && MAPBOX_TOKEN) {
      try {
        primary_result = await route_mapbox(
          f.point,
          t.point,
          input.mode,
          input.include_geometry,
          input.depart_at,
        );
        provider_used = 'mapbox';
        primary_err = undefined;
      } catch (err) {
        if (!primary_err) primary_err = err instanceof Error ? err.message : String(err);
      }
    }

    if (!primary_result) {
      const out: RouteOut = {
        distance_meters: 0,
        duration_seconds: 0,
        provider: provider_used,
        via_roads: [],
        bearing_degrees: 0,
        bearing_compass: 'N',
        error: primary_err ?? 'route unavailable',
      };
      audit_log(ctx, 'route', input, out, out.error);
      return out;
    }

    let traffic_seconds: number | undefined;
    let final_duration = primary_result.duration_seconds;

    // High-precision overlay: prefer the more conservative ETA when both
    // are available and Mapbox is on the side. Only applies to drive mode
    // (traffic-aware ETA isn't a thing for bike/walk).
    if (
      MAPS_HIGH_PRECISION &&
      MAPBOX_TOKEN &&
      input.mode === 'drive' &&
      provider_used !== 'mapbox'
    ) {
      try {
        const mb = await route_mapbox(
          f.point,
          t.point,
          input.mode,
          false,
          input.depart_at,
        );
        if (mb.duration_in_traffic_seconds !== undefined) {
          traffic_seconds = mb.duration_in_traffic_seconds;
          if (traffic_seconds > final_duration) final_duration = traffic_seconds;
        } else if (mb.duration_seconds > final_duration) {
          final_duration = mb.duration_seconds;
        }
      } catch {
        // Conservative bias: if mapbox layer fails, just stick with OSRM.
      }
    }

    const bearing = compute_bearing(f.point, t.point);
    const out: RouteOut = {
      distance_meters: primary_result.distance_meters,
      duration_seconds: final_duration,
      provider: provider_used,
      via_roads: primary_result.via_roads,
      bearing_degrees: bearing.degrees,
      bearing_compass: bearing.compass,
    };
    if (traffic_seconds !== undefined) out.duration_in_traffic_seconds = traffic_seconds;
    if (input.include_geometry && primary_result.geometry) {
      out.geometry = primary_result.geometry;
    }

    audit_log(ctx, 'route', input, out);
    return out;
  },
};

// ── distance_matrix ─────────────────────────────────────────────────────

const MatrixInput = z.object({
  origins: z.array(PointSchema).min(1).max(25),
  destinations: z.array(PointSchema).min(1).max(25),
  mode: z.enum(['drive', 'bike', 'walk']),
});

const MatrixCell = z.object({
  distance_meters: z.number(),
  duration_seconds: z.number(),
});

const MatrixOutput = z.object({
  rows: z.array(z.array(MatrixCell)),
  provider: z.enum(['osrm', 'mapbox', 'google']),
  error: z.string().optional(),
});

type MatrixIn = z.infer<typeof MatrixInput>;
type MatrixOut = z.infer<typeof MatrixOutput>;

interface OsrmTableResp {
  code?: string;
  durations?: number[][] | null;
  distances?: number[][] | null;
}

async function matrix_osrm(input: MatrixIn): Promise<MatrixOut> {
  const base = osrm_url_for_mode(input.mode);
  const prof = osrm_profile_for_mode(input.mode);
  const points = [...input.origins, ...input.destinations];
  const coords = points.map((p) => `${p.lon},${p.lat}`).join(';');
  const sources = input.origins.map((_, i) => i).join(';');
  const destinations = input.destinations
    .map((_, i) => i + input.origins.length)
    .join(';');
  const params = new URLSearchParams({
    sources,
    destinations,
    annotations: 'distance,duration',
  });
  const url = `${base.replace(/\/$/, '')}/table/v1/${prof}/${coords}?${params.toString()}`;
  const res = await safe_fetch(url, {}, TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(res.error ?? `osrm-table HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const json = JSON.parse(res.body) as OsrmTableResp;
  if (json.code && json.code !== 'Ok') {
    throw new Error(`osrm-table code=${json.code}`);
  }
  if (!json.durations || !json.distances) {
    throw new Error('osrm-table returned no annotations');
  }
  const rows: Array<Array<{ distance_meters: number; duration_seconds: number }>> = [];
  for (let i = 0; i < input.origins.length; i++) {
    const row: Array<{ distance_meters: number; duration_seconds: number }> = [];
    for (let j = 0; j < input.destinations.length; j++) {
      row.push({
        distance_meters: json.distances[i]?.[j] ?? 0,
        duration_seconds: json.durations[i]?.[j] ?? 0,
      });
    }
    rows.push(row);
  }
  return { rows, provider: 'osrm' };
}

export const distance_matrix: Tool<MatrixIn, MatrixOut> = {
  name: 'distance_matrix',
  description:
    'Compute a distance + duration matrix between origins and destinations. Useful for "which of these is closest" queries. Local OSRM /table endpoint by default.',
  risk: 'read',
  required_capabilities: ['query_maps'],
  input_schema: MatrixInput,
  output_schema: MatrixOutput,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(JSON.stringify({ o: input.origins, d: input.destinations, m: input.mode }));
    return `distance_matrix:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<MatrixOut> {
    try {
      const out = await matrix_osrm(input);
      audit_log(ctx, 'distance_matrix', input, out);
      return out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const out: MatrixOut = { rows: [], provider: 'osrm', error: msg };
      audit_log(ctx, 'distance_matrix', input, out, msg);
      return out;
    }
  },
};

// ── nearby ──────────────────────────────────────────────────────────────

/**
 * `nearby`'s point accepts the same shapes route does (string address,
 * Place name, {lat, lon}, {my_current_location}, {address}). The
 * radius can be expressed as km OR meters — pick whichever name Kate
 * happens to use; we treat values > 50 as meters and convert.
 */
const NearbyInput = z
  .object({
    point: z.union([
      PointSchema,
      z.object({ my_current_location: z.literal(true) }),
      z.object({ address: z.string().min(1) }),
      z.string().min(1),
    ]),
    category: z.string().min(1),
    radius_km: z.coerce.number().positive().max(50).optional(),
    radius_meters: z.coerce.number().positive().max(50_000).optional(),
    radius: z.coerce.number().positive().optional(), // ambiguous: km if ≤ 50, else m
  })
  .transform((d) => {
    let km = d.radius_km;
    if (km === undefined && d.radius_meters !== undefined) km = d.radius_meters / 1000;
    if (km === undefined && d.radius !== undefined) km = d.radius > 50 ? d.radius / 1000 : d.radius;
    if (km === undefined) km = 5;
    return { point: d.point, category: d.category, radius_km: Math.min(km, 50) };
  });

const NearbyPlace = z.object({
  name: z.string(),
  address: z.string(),
  lat: z.number(),
  lon: z.number(),
  distance_meters: z.number(),
  category: z.string(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

const NearbyOutput = z.object({
  places: z.array(NearbyPlace),
  provider: z.enum(['osrm', 'mapbox', 'google', 'none']).default('none'),
  error: z.string().optional(),
});

type NearbyIn = z.infer<typeof NearbyInput>;
type NearbyOut = z.infer<typeof NearbyOutput>;

const OVERPASS_CATEGORY_TAGS: Record<string, string> = {
  pharmacy: 'amenity=pharmacy',
  veterinary: 'amenity=veterinary',
  grocery: 'shop=supermarket',
  gas: 'amenity=fuel',
  charging: 'amenity=charging_station',
  restaurant: 'amenity=restaurant',
  cafe: 'amenity=cafe',
  hospital: 'amenity=hospital',
  bank: 'amenity=bank',
  atm: 'amenity=atm',
};

function haversine_meters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

interface OverpassElement {
  type?: 'node' | 'way' | 'relation';
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

async function nearby_overpass(
  point: { lat: number; lon: number },
  category: string,
  radius_km: number,
): Promise<z.infer<typeof NearbyPlace>[]> {
  const tag = OVERPASS_CATEGORY_TAGS[category] ?? `amenity=${category}`;
  const radius_m = Math.round(radius_km * 1000);
  const q =
    `[out:json][timeout:25];` +
    `(node[${tag}](around:${radius_m},${point.lat},${point.lon});` +
    `way[${tag}](around:${radius_m},${point.lat},${point.lon});` +
    `relation[${tag}](around:${radius_m},${point.lat},${point.lon}););` +
    `out center 50;`;
  const res = await safe_fetch(
    OVERPASS_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'hearth-maps/0.1',
      },
      body: `data=${encodeURIComponent(q)}`,
    },
    TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(res.error ?? `overpass HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const json = JSON.parse(res.body) as { elements?: OverpassElement[] };
  const out: z.infer<typeof NearbyPlace>[] = [];
  for (const e of json.elements ?? []) {
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    const tags = e.tags ?? {};
    const dist = haversine_meters(point, { lat, lon });
    const addr_parts = [
      tags['addr:housenumber'],
      tags['addr:street'],
      tags['addr:city'],
      tags['addr:state'],
    ].filter(Boolean);
    out.push({
      name: tags.name ?? '(unnamed)',
      address: addr_parts.join(' '),
      lat,
      lon,
      distance_meters: dist,
      category,
      attributes: {
        phone: tags.phone ?? tags['contact:phone'],
        website: tags.website ?? tags['contact:website'],
        opening_hours: tags.opening_hours,
      },
    });
  }
  out.sort((a, b) => a.distance_meters - b.distance_meters);
  return out;
}

export const nearby: Tool<NearbyIn, NearbyOut> = {
  name: 'nearby',
  description:
    'Find places of a given category within a radius around a point. `point` accepts plain strings (address or Place name), {lat, lon}, or {my_current_location: true}. `radius_km` is the radius in kilometers (default 5). Common categories: pharmacy, veterinary, grocery, gas, charging, restaurant, cafe, hospital, bank. Example: {point: "Lima Coffee Pleasantville", category: "cafe", radius_km: 1}. Backed by local Overpass; falls back to Mapbox Places if MAPBOX_TOKEN is set.',
  risk: 'read',
  required_capabilities: ['query_maps'],
  input_schema: NearbyInput,
  output_schema: NearbyOutput,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(JSON.stringify(input));
    return `nearby:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<NearbyOut> {
    // Reuse the route-tool endpoint resolver — same shapes accepted
    // (string, {address}, {lat,lon}, {my_current_location}).
    const resolved = await _resolve_endpoint(
      ctx,
      input.point as Parameters<typeof _resolve_endpoint>[1],
      true,
    );
    if (resolved.error || !resolved.point) {
      const out: NearbyOut = {
        places: [],
        provider: 'none',
        error: resolved.error ?? "couldn't resolve `point`",
      };
      audit_log(ctx, 'nearby', input, out, out.error);
      return out;
    }
    const point: { lat: number; lon: number } = resolved.point;

    let places: z.infer<typeof NearbyPlace>[] = [];
    let provider_used: NearbyOut['provider'] = 'none';
    let error: string | undefined;

    try {
      places = await nearby_overpass(point, input.category, input.radius_km);
      provider_used = 'osrm';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    if (places.length === 0 && MAPBOX_TOKEN) {
      try {
        const url =
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(input.category)}.json` +
          `?proximity=${point.lon},${point.lat}&access_token=${MAPBOX_TOKEN}&limit=20`;
        const res = await safe_fetch(url, {}, TIMEOUT_MS);
        if (res.ok) {
          const json = JSON.parse(res.body) as { features?: MapboxGeocodingFeature[] };
          for (const f of json.features ?? []) {
            if (!f.center) continue;
            const [lon, lat] = f.center;
            const dist = haversine_meters(point, { lat, lon });
            if (dist > input.radius_km * 1000) continue;
            places.push({
              name: f.text ?? '(unnamed)',
              address: f.place_name ?? '',
              lat,
              lon,
              distance_meters: dist,
              category: input.category,
            });
          }
          provider_used = 'mapbox';
          error = undefined;
        }
      } catch (err) {
        if (!error) error = err instanceof Error ? err.message : String(err);
      }
    }

    if (places.length === 0 && !error) {
      error = 'no nearby results and no fallback provider configured';
    }

    const out: NearbyOut =
      places.length === 0 && error
        ? { places: [], provider: provider_used, error }
        : { places, provider: provider_used };
    audit_log(ctx, 'nearby', input, out, error);
    return out;
  },
};

