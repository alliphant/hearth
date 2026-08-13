/**
 * Weather connector — backed by Pirate Weather (DarkSky-shape).
 *
 * Why this exists: Kate's briefs lead with "weather worth acting on"
 * (precip windows, temp extremes) but the backend had no first-class
 * weather source. The brief context puller's `HEARTH_BRIEF_WEATHER_ENTITY`
 * pointed at a Home Assistant `weather.*` entity that wasn't configured
 * in this deployment, so Kate kept reporting "no current reading on
 * weather" honestly but uselessly. This connector closes that gap with
 * a real provider that doesn't depend on HA having its own weather
 * integration wired.
 *
 * Provider: Pirate Weather (https://pirateweather.net). DarkSky-shape
 * forecast JSON — single API call returns current conditions, hourly
 * (next 48h), daily (next 7-8d), and active alerts. Free tier is 10k
 * calls/month, more than enough for one household at our cache TTL.
 * Swapping providers later (OpenWeatherMap, NWS, Met.no) means
 * replacing this file's `pirate_fetch` and the shape adapter; the
 * Tool surface stays stable.
 *
 * Tool surface:
 *   - weather_now: current conditions + nowcast precip window
 *   - weather_forecast: hourly + daily blocks for planning
 *   - weather_alerts: active severe-weather alerts only
 *
 * All three read from the SAME cached forecast response — Pirate
 * bundles everything in one call, and our cache key is (lat, lon)
 * rounded to 3 decimals (~110m). A specialist that calls weather_now
 * + weather_forecast in the same turn hits the API once.
 *
 * Coords: every call accepts optional `lat`/`lng` (e.g. when Iris is
 * routing a trip and wants weather at a specific destination). When
 * omitted, falls back to `HEARTH_HOME_LAT` / `HEARTH_HOME_LON` env
 * vars. If neither is provided, the tool returns an actionable
 * recovery hint instead of fabricating a default — same pattern as
 * `ha_get_state`'s 404 candidates.
 *
 * Audit redaction: raw coords are rounded to 3 decimal places in the
 * audit row when `audit_redaction_enabled()`, matching the maps
 * connector's pattern. The `provider` and result shape get logged
 * fully — those aren't sensitive.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { UserRegistry } from '@core/users';
import type { MemoryClient } from '@memory/client';
import { local_iso_date } from '@core/time';
import {
  resolve_weather_coords,
  weather_coords_recovery_hint,
  type ResolvedWeatherCoords,
} from '@core/weather_location';
import { audit_redaction_enabled } from '@core/privacy';
import { safe_fetch } from './_audit';

// ── Configuration ────────────────────────────────────────────────────────
// Env reads at CALL time, not module load. Means an operator editing
// ~/hearth/.env doesn't need an orchestrator restart for the next
// weather call to see the new value.

function pirate_api_key(): string {
  return process.env.PIRATE_WEATHER_API_KEY ?? '';
}
function pirate_base_url(): string {
  return process.env.PIRATE_WEATHER_BASE_URL ?? 'https://api.pirateweather.net';
}
// Pirate Weather (especially the free tier) returns transient 5xx blips — a
// single upstream 500 used to make Kate report "I couldn't consult the weather"
// mid-turn even though the service is up (observed 2026-06-16: a 500 at one
// minute, real data the next). pirate_fetch retries a 5xx a few times with short
// backoff. A 5xx returns FAST, so this stays sub-second; 4xx (bad key/coords)
// and transport timeouts (status 0 — already spent the 10s budget; a retry would
// double a voice turn's latency) are deliberately NOT retried.
function pirate_max_retries(): number {
  const n = parseInt(process.env.PIRATE_WEATHER_MAX_RETRIES ?? '2', 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}
const PIRATE_RETRY_BACKOFF_MS = 400;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Cache ────────────────────────────────────────────────────────────────
// Process-local TTL cache on the FULL forecast response. Pirate returns
// current + hourly + daily + alerts in one call; caching at that level
// means weather_now + weather_forecast + weather_alerts called in the
// same turn (or by different specialists on the same minute) hit the
// API once. 5-minute TTL is generous for "current" conditions and tight
// enough for alert latency. Coords are rounded to 3 decimals (~110m)
// so a specialist asking about "the vet, 0.4 miles away" and "home"
// don't double-spend the cache for nearly-identical queries.

interface CacheEntry {
  value: PirateResponse;
  expires_at: number;
}

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, CacheEntry>();

function cache_key(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

function cache_get(lat: number, lng: number): PirateResponse | null {
  const e = cache.get(cache_key(lat, lng));
  if (!e) return null;
  if (Date.now() > e.expires_at) {
    cache.delete(cache_key(lat, lng));
    return null;
  }
  return e.value;
}

function cache_put(lat: number, lng: number, value: PirateResponse): void {
  cache.set(cache_key(lat, lng), {
    value,
    expires_at: Date.now() + CACHE_TTL_MS,
  });
}

/** Test-only: clear all cached entries between runs. */
export function _test_clear_cache(): void {
  cache.clear();
}

// ── Pirate Weather response shape ────────────────────────────────────────
// Modeled from https://docs.pirateweather.net/. All blocks are
// individually optional — Pirate omits any block whose data is not
// available for the queried point (e.g. high-latitude minutely
// gaps). Number fields can be missing on individual entries; our
// adapter normalizes to `null` so consumer code reads consistently.

interface PirateCurrent {
  time: number;
  summary?: string;
  icon?: string;
  precipIntensity?: number;       // in/h
  precipProbability?: number;     // 0..1
  precipType?: string;
  temperature?: number;           // °F (units=us)
  apparentTemperature?: number;
  dewPoint?: number;
  humidity?: number;              // 0..1
  pressure?: number;              // hPa (Pirate stays metric on pressure regardless of units=us)
  windSpeed?: number;             // mph
  windGust?: number;
  windBearing?: number;
  cloudCover?: number;            // 0..1
  uvIndex?: number;
  visibility?: number;            // mi
  ozone?: number;
}

interface PirateHour {
  time: number;
  summary?: string;
  icon?: string;
  precipIntensity?: number;
  precipProbability?: number;
  precipType?: string;
  temperature?: number;
  apparentTemperature?: number;
  humidity?: number;
  windSpeed?: number;
  windGust?: number;
  windBearing?: number;
  cloudCover?: number;
  uvIndex?: number;
}

interface PirateDay {
  time: number;
  summary?: string;
  icon?: string;
  sunriseTime?: number;
  sunsetTime?: number;
  moonPhase?: number;
  precipIntensity?: number;
  precipIntensityMax?: number;
  precipProbability?: number;
  precipType?: string;
  temperatureHigh?: number;
  temperatureLow?: number;
  apparentTemperatureHigh?: number;
  apparentTemperatureLow?: number;
  humidity?: number;
  windSpeed?: number;
  windGust?: number;
  windBearing?: number;
  cloudCover?: number;
  uvIndex?: number;
}

interface PirateAlert {
  title: string;
  regions?: string[];
  severity?: 'advisory' | 'watch' | 'warning' | string;
  time?: number;
  expires?: number;
  description?: string;
  uri?: string;
}

interface PirateResponse {
  latitude: number;
  longitude: number;
  timezone: string;
  currently?: PirateCurrent;
  hourly?: { summary?: string; icon?: string; data: PirateHour[] };
  daily?: { summary?: string; icon?: string; data: PirateDay[] };
  alerts?: PirateAlert[];
  flags?: { sources?: string[]; units?: string; version?: string };
}

// ── Fetch ────────────────────────────────────────────────────────────────

/** Live fetch transport — swappable for tests. */
let _transport: (url: string) => Promise<{ ok: boolean; status: number; body: string; error?: string }>
  = (url) => safe_fetch(url, { headers: { Accept: 'application/json' } }, 10_000);

/** Test-only: swap the fetch transport to return canned bodies. */
export function _test_set_transport(
  fn: (url: string) => Promise<{ ok: boolean; status: number; body: string; error?: string }>,
): void {
  _transport = fn;
}

async function pirate_fetch(
  lat: number,
  lng: number,
): Promise<{ ok: true; data: PirateResponse } | { ok: false; status: number; error: string }> {
  const cached = cache_get(lat, lng);
  if (cached) return { ok: true, data: cached };

  const key = pirate_api_key();
  if (!key) {
    return {
      ok: false,
      status: 0,
      error: 'PIRATE_WEATHER_API_KEY not set',
    };
  }
  const url = `${pirate_base_url().replace(/\/$/, '')}/forecast/${key}/${lat},${lng}?units=us`;
  let res = await _transport(url);
  // Retry transient upstream 5xx only (see pirate_max_retries above).
  for (let attempt = 1; attempt <= pirate_max_retries() && !res.ok && res.status >= 500; attempt++) {
    await sleep(PIRATE_RETRY_BACKOFF_MS * attempt);
    res = await _transport(url);
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: res.error ?? `HTTP ${res.status}`,
    };
  }
  let parsed: PirateResponse;
  try {
    parsed = JSON.parse(res.body) as PirateResponse;
  } catch (err) {
    return {
      ok: false,
      status: res.status,
      error: `parse: ${(err as Error).message}`,
    };
  }
  cache_put(lat, lng, parsed);
  return { ok: true, data: parsed };
}

/** Test-only: exercise the fetch + 5xx-retry path directly (smoke:weather-retry). */
export { pirate_fetch as _test_pirate_fetch };

// ── Audit ────────────────────────────────────────────────────────────────

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function audit_input(input: { lat?: number; lng?: number } & Record<string, unknown>): Record<string, unknown> {
  const redacted = audit_redaction_enabled();
  return {
    ...input,
    lat: typeof input.lat === 'number' ? (redacted ? round3(input.lat) : input.lat) : input.lat,
    lng: typeof input.lng === 'number' ? (redacted ? round3(input.lng) : input.lng) : input.lng,
  };
}

function audit_log(
  ctx: ToolContext,
  tool_name: string,
  input: Record<string, unknown>,
  result: unknown,
  error?: string,
): void {
  ctx.memory.log_action({
    intent_id: ctx.intent_id || ulid(),
    agent: ctx.specialist_id || 'weather_connector',
    tool_name,
    tool_input: audit_input(input as { lat?: number; lng?: number }),
    execution_result: error
      ? undefined
      : { ok: !error, has_alerts: Boolean((result as { alerts?: unknown[] })?.alerts?.length) },
    error,
  });
}

// ── Resolve coords ───────────────────────────────────────────────────────
//
// Resolution delegated to @core/weather_location so the same resolver
// chain is shared between the tool surface (chat-turn weather_now etc.)
// and the brief context puller. Order: caller-provided → iOS sensor
// packet (live, per-user) → HA Companion (owner-only, live) → static
// home anchor → env → null. See weather_location.ts for the full
// rationale + freshness thresholds.

async function resolve_coords_with_recovery(
  input: { lat?: number; lng?: number; user_id?: string },
  users: UserRegistry | undefined,
  memory: MemoryClient,
  ctx: ToolContext,
):
  | Promise<{ ok: true; coords: ResolvedWeatherCoords } | { ok: false; recovery_hint: string }> {
  const turn_user_id = (ctx as { turn_user?: { id?: string } }).turn_user?.id;
  const user_id = input.user_id ?? turn_user_id ?? process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
  const resolved = await resolve_weather_coords({
    user_id,
    users,
    memory,
    caller_lat: input.lat,
    caller_lng: input.lng,
  });
  if (!resolved) {
    return { ok: false, recovery_hint: weather_coords_recovery_hint(user_id) };
  }
  return { ok: true, coords: resolved };
}

function recovery_for_fetch_error(status: number, error: string): string {
  if (error.includes('PIRATE_WEATHER_API_KEY not set')) {
    return 'Pirate Weather API key not configured. Set PIRATE_WEATHER_API_KEY in ~/hearth/.env on the orchestrator host. Free tier sign-up: https://pirateweather.net/en/latest/';
  }
  if (status === 401 || status === 403) {
    return 'Pirate Weather rejected the API key. Verify PIRATE_WEATHER_API_KEY in ~/hearth/.env matches the key at https://pirateweather.net/, and that the key has not been revoked.';
  }
  if (status === 429) {
    return 'Pirate Weather rate-limited the request. Free tier is 10k calls/month; backoff for ~1 hour. The connector caches responses for 5 min per location, so this should only fire under unusual load.';
  }
  if (status >= 500) {
    return 'Pirate Weather server error. Retry in a few minutes; if it persists check https://pirateweather.net for status.';
  }
  return 'Pirate Weather fetch failed. Check network reachability from the orchestrator host and the value of PIRATE_WEATHER_BASE_URL (default https://api.pirateweather.net).';
}

// ── Shared output shapes ─────────────────────────────────────────────────

const ConditionBlock = z.object({
  /** Pirate's compact icon code: `clear-day`, `rain`, `snow`, `wind`, `fog`, `cloudy`, `partly-cloudy-day`, … */
  icon: z.string().nullable(),
  /** One-line human summary Pirate computed ("Possible Light Rain Until Evening"). */
  summary: z.string().nullable(),
});

const PrecipBlock = z.object({
  /** Probability 0..1 of any precip in the period covered by this block. */
  chance: z.number().min(0).max(1).nullable(),
  /** Intensity for hour/current blocks (in/hr); intensityMax for daily. */
  intensity_in_per_hr: z.number().nullable(),
  /** `rain` | `snow` | `sleet` | `mixed` | `none`. */
  type: z.string().nullable(),
});

// ── weather_now ──────────────────────────────────────────────────────────

const NowInput = z
  .object({
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    /** Look up another household member's home coords (Sam, Kim). When
     *  omitted, falls back to the calling turn's user_id, then to the
     *  HEARTH_OWNER_USER_ID env / 'jasper' default. */
    user_id: z.string().optional(),
    /** Optional friendly label for audit ("home", "Tesla service center"). */
    place_label: z.string().max(120).optional(),
  })
  .strict();

const NowOutput = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  recovery_hint: z.string().optional(),
  // Present on success only.
  timezone: z.string().optional(),
  as_of: z.string().optional(),               // ISO from Pirate's `currently.time`
  temperature_f: z.number().nullable().optional(),
  apparent_temperature_f: z.number().nullable().optional(),
  humidity: z.number().nullable().optional(),
  wind_speed_mph: z.number().nullable().optional(),
  wind_gust_mph: z.number().nullable().optional(),
  wind_bearing_deg: z.number().nullable().optional(),
  cloud_cover: z.number().nullable().optional(),
  uv_index: z.number().nullable().optional(),
  visibility_mi: z.number().nullable().optional(),
  pressure_hpa: z.number().nullable().optional(),
  condition: ConditionBlock.optional(),
  precip: PrecipBlock.optional(),
  /** Next 60 minutes nowcast — minute-resolution precip when Pirate supplies it.
   *  Empty array when the point doesn't have minutely coverage. */
  precip_next_60min: z
    .array(
      z.object({
        ts: z.string(),
        intensity_in_per_hr: z.number().nullable(),
        chance: z.number().nullable(),
      }),
    )
    .optional(),
  provider: z.literal('pirate_weather').optional(),
  coords_used: z
    .object({
      lat: z.number(),
      lng: z.number(),
      source: z.string(),
      label: z.string().nullable(),
      confidence: z.string(),
      staleness_seconds: z.number().nullable(),
    })
    .optional(),
});

type NowIn = z.infer<typeof NowInput>;
type NowOut = z.infer<typeof NowOutput>;

function iso_from_pirate_time(t: number | undefined): string | null {
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  return new Date(t * 1000).toISOString();
}

function val_or_null<T>(v: T | undefined): T | null {
  return v === undefined ? null : v;
}

function make_weather_now(
  users: UserRegistry | undefined,
  memory: MemoryClient,
): Tool<NowIn, NowOut> {
  return {
    name: 'weather_now',
    description:
      "Get the current weather conditions. Coordinates: (1) caller lat/lng wins for destination queries, (2) otherwise the user's latest iOS location packet when fresh (< 6h, ≤ 2km accuracy) — weather follows the user, (3) otherwise the user's home_location anchor from config/users.yaml. `coords_used` on the response tells you which source resolved. Returns temperature (°F), apparent temperature, condition (icon + summary), precipitation, humidity, wind, UV, visibility, pressure, cloud cover, and the next-60-min precip nowcast when available. Pass `user_id` to read another household member's location. Cached 5 min per (lat,lng).",
    risk: 'read',
    required_capabilities: ['read_weather'],
    input_schema: NowInput,
    output_schema: NowOutput,

    idempotency_key(input) {
      const lat = typeof input.lat === 'number' ? input.lat.toFixed(3) : 'env';
      const lng = typeof input.lng === 'number' ? input.lng.toFixed(3) : 'env';
      return `weather_now:${createHash('sha256').update(`${lat},${lng},${input.user_id ?? ''}`).digest('hex').slice(0, 12)}`;
    },

    async execute(input, ctx: ToolContext): Promise<NowOut> {
      const resolved = await resolve_coords_with_recovery(input, users, memory, ctx);
      if (!resolved.ok) {
        const out: NowOut = { ok: false, error: 'no coordinates available', recovery_hint: resolved.recovery_hint };
        audit_log(ctx, 'weather_now', input as Record<string, unknown>, out, out.error);
        return out;
      }
      const c = resolved.coords;
      const fetched = await pirate_fetch(c.lat, c.lng);
      if (!fetched.ok) {
        const out: NowOut = {
          ok: false,
          error: fetched.error,
          recovery_hint: recovery_for_fetch_error(fetched.status, fetched.error),
        };
        audit_log(ctx, 'weather_now', { ...input, lat: c.lat, lng: c.lng }, out, out.error);
        return out;
      }
      const data = fetched.data;
      const cur = data.currently;
      const out: NowOut = {
        ok: true,
        timezone: data.timezone,
        as_of: iso_from_pirate_time(cur?.time) ?? new Date().toISOString(),
        temperature_f: val_or_null(cur?.temperature),
        apparent_temperature_f: val_or_null(cur?.apparentTemperature),
        humidity: val_or_null(cur?.humidity),
        wind_speed_mph: val_or_null(cur?.windSpeed),
        wind_gust_mph: val_or_null(cur?.windGust),
        wind_bearing_deg: val_or_null(cur?.windBearing),
        cloud_cover: val_or_null(cur?.cloudCover),
        uv_index: val_or_null(cur?.uvIndex),
        visibility_mi: val_or_null(cur?.visibility),
        pressure_hpa: val_or_null(cur?.pressure),
        condition: {
          icon: cur?.icon ?? null,
          summary: cur?.summary ?? null,
        },
        precip: {
          chance: val_or_null(cur?.precipProbability),
          intensity_in_per_hr: val_or_null(cur?.precipIntensity),
          type: cur?.precipType ?? null,
        },
        precip_next_60min: [],
        provider: 'pirate_weather',
        coords_used: {
          lat: c.lat,
          lng: c.lng,
          source: c.source,
          label: c.label,
          confidence: c.confidence,
          staleness_seconds: c.staleness_seconds,
        },
      };
      audit_log(ctx, 'weather_now', { ...input, lat: c.lat, lng: c.lng, coord_source: c.source }, out);
      return out;
    },
  };
}

// ── weather_forecast ─────────────────────────────────────────────────────

const ForecastInput = z
  .object({
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    user_id: z.string().optional(),
    place_label: z.string().max(120).optional(),
    /** Number of hourly entries to return (max 48 — Pirate's window). */
    hours: z.number().int().min(0).max(48).default(24),
    /** Number of daily entries to return (max 8 — Pirate's window). */
    days: z.number().int().min(0).max(8).default(7),
  })
  .strict();

const HourEntry = z.object({
  ts: z.string(),
  temperature_f: z.number().nullable(),
  apparent_temperature_f: z.number().nullable(),
  humidity: z.number().nullable(),
  wind_speed_mph: z.number().nullable(),
  wind_bearing_deg: z.number().nullable(),
  cloud_cover: z.number().nullable(),
  uv_index: z.number().nullable(),
  condition: ConditionBlock,
  precip: PrecipBlock,
});

const DayEntry = z.object({
  date: z.string(),
  temperature_high_f: z.number().nullable(),
  temperature_low_f: z.number().nullable(),
  apparent_high_f: z.number().nullable(),
  apparent_low_f: z.number().nullable(),
  humidity: z.number().nullable(),
  wind_speed_mph: z.number().nullable(),
  wind_bearing_deg: z.number().nullable(),
  cloud_cover: z.number().nullable(),
  uv_index: z.number().nullable(),
  sunrise: z.string().nullable(),
  sunset: z.string().nullable(),
  condition: ConditionBlock,
  precip: PrecipBlock,
});

const ForecastOutput = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  recovery_hint: z.string().optional(),
  timezone: z.string().optional(),
  hourly_summary: z.string().nullable().optional(),
  daily_summary: z.string().nullable().optional(),
  hourly: z.array(HourEntry).optional(),
  daily: z.array(DayEntry).optional(),
  provider: z.literal('pirate_weather').optional(),
  coords_used: z
    .object({
      lat: z.number(),
      lng: z.number(),
      source: z.string(),
      label: z.string().nullable(),
      confidence: z.string(),
      staleness_seconds: z.number().nullable(),
    })
    .optional(),
});

type ForecastIn = z.infer<typeof ForecastInput>;
type ForecastOut = z.infer<typeof ForecastOutput>;

function iso_date_from_pirate_time(t: number | undefined, tz: string | undefined): string | null {
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  const d = new Date(t * 1000);
  // Use the forecast's timezone to derive the day label when available;
  // fall back to UTC. The Intl path is cheap and handles DST cleanly.
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', { // time-guard-ok: tz-threaded forecast day label (forecast-supplied zone)
      timeZone: tz ?? 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fmt.format(d);
  } catch {
    return local_iso_date(d);
  }
}

function make_weather_forecast(
  users: UserRegistry | undefined,
  memory: MemoryClient,
): Tool<ForecastIn, ForecastOut> {
  return {
    name: 'weather_forecast',
    description:
      "Get the hourly (next 48h) and daily (next 7-8 days) weather forecast. Coordinates: caller lat/lng → fresh iOS location packet → users.yaml home_location anchor. Each hour returns temperature, condition, precip chance + intensity + type, humidity, wind, UV. Each day returns high/low temp, sunrise/sunset, daily condition, precip chance + max intensity, humidity, wind, UV. Pass `hours` (0-48) and `days` (0-8) to trim. Pass `user_id` for another household member. Cached 5 min per (lat,lng). Use this for 'should I water the yard today', 'how cold will it be tomorrow morning', 'precip windows this week'.",
    risk: 'read',
    required_capabilities: ['read_weather'],
    input_schema: ForecastInput,
    output_schema: ForecastOutput,

    idempotency_key(input) {
      const lat = typeof input.lat === 'number' ? input.lat.toFixed(3) : 'env';
      const lng = typeof input.lng === 'number' ? input.lng.toFixed(3) : 'env';
      return `weather_forecast:${createHash('sha256').update(`${lat},${lng},${input.hours},${input.days},${input.user_id ?? ''}`).digest('hex').slice(0, 12)}`;
    },

    async execute(input, ctx: ToolContext): Promise<ForecastOut> {
      const resolved = await resolve_coords_with_recovery(input, users, memory, ctx);
      if (!resolved.ok) {
        const out: ForecastOut = { ok: false, error: 'no coordinates available', recovery_hint: resolved.recovery_hint };
        audit_log(ctx, 'weather_forecast', input as Record<string, unknown>, out, out.error);
        return out;
      }
      const c = resolved.coords;
      const fetched = await pirate_fetch(c.lat, c.lng);
      if (!fetched.ok) {
        const out: ForecastOut = {
          ok: false,
          error: fetched.error,
          recovery_hint: recovery_for_fetch_error(fetched.status, fetched.error),
        };
        audit_log(ctx, 'weather_forecast', { ...input, lat: c.lat, lng: c.lng }, out, out.error);
        return out;
      }
      const data = fetched.data;
      const tz = data.timezone;
      const hourly: z.infer<typeof HourEntry>[] = (data.hourly?.data ?? [])
        .slice(0, input.hours)
        .map((h) => ({
          ts: iso_from_pirate_time(h.time) ?? new Date().toISOString(),
          temperature_f: val_or_null(h.temperature),
          apparent_temperature_f: val_or_null(h.apparentTemperature),
          humidity: val_or_null(h.humidity),
          wind_speed_mph: val_or_null(h.windSpeed),
          wind_bearing_deg: val_or_null(h.windBearing),
          cloud_cover: val_or_null(h.cloudCover),
          uv_index: val_or_null(h.uvIndex),
          condition: { icon: h.icon ?? null, summary: h.summary ?? null },
          precip: {
            chance: val_or_null(h.precipProbability),
            intensity_in_per_hr: val_or_null(h.precipIntensity),
            type: h.precipType ?? null,
          },
        }));
      const daily: z.infer<typeof DayEntry>[] = (data.daily?.data ?? [])
        .slice(0, input.days)
        .map((d) => ({
          date: iso_date_from_pirate_time(d.time, tz) ?? local_iso_date(),
          temperature_high_f: val_or_null(d.temperatureHigh),
          temperature_low_f: val_or_null(d.temperatureLow),
          apparent_high_f: val_or_null(d.apparentTemperatureHigh),
          apparent_low_f: val_or_null(d.apparentTemperatureLow),
          humidity: val_or_null(d.humidity),
          wind_speed_mph: val_or_null(d.windSpeed),
          wind_bearing_deg: val_or_null(d.windBearing),
          cloud_cover: val_or_null(d.cloudCover),
          uv_index: val_or_null(d.uvIndex),
          sunrise: iso_from_pirate_time(d.sunriseTime),
          sunset: iso_from_pirate_time(d.sunsetTime),
          condition: { icon: d.icon ?? null, summary: d.summary ?? null },
          precip: {
            chance: val_or_null(d.precipProbability),
            intensity_in_per_hr: val_or_null(d.precipIntensityMax ?? d.precipIntensity),
            type: d.precipType ?? null,
          },
        }));
      const out: ForecastOut = {
        ok: true,
        timezone: tz,
        hourly_summary: data.hourly?.summary ?? null,
        daily_summary: data.daily?.summary ?? null,
        hourly,
        daily,
        provider: 'pirate_weather',
        coords_used: {
          lat: c.lat,
          lng: c.lng,
          source: c.source,
          label: c.label,
          confidence: c.confidence,
          staleness_seconds: c.staleness_seconds,
        },
      };
      audit_log(ctx, 'weather_forecast', { ...input, lat: c.lat, lng: c.lng, coord_source: c.source }, out);
      return out;
    },
  };
}

// ── weather_alerts ───────────────────────────────────────────────────────

const AlertsInput = z
  .object({
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    user_id: z.string().optional(),
    place_label: z.string().max(120).optional(),
  })
  .strict();

const AlertEntry = z.object({
  title: z.string(),
  severity: z.string(),
  regions: z.array(z.string()).default([]),
  ts_start: z.string().nullable(),
  ts_expires: z.string().nullable(),
  description: z.string().nullable(),
  url: z.string().nullable(),
});

const AlertsOutput = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  recovery_hint: z.string().optional(),
  timezone: z.string().optional(),
  alerts: z.array(AlertEntry).optional(),
  provider: z.literal('pirate_weather').optional(),
  coords_used: z
    .object({
      lat: z.number(),
      lng: z.number(),
      source: z.string(),
      label: z.string().nullable(),
      confidence: z.string(),
      staleness_seconds: z.number().nullable(),
    })
    .optional(),
});

type AlertsIn = z.infer<typeof AlertsInput>;
type AlertsOut = z.infer<typeof AlertsOutput>;

function make_weather_alerts(
  users: UserRegistry | undefined,
  memory: MemoryClient,
): Tool<AlertsIn, AlertsOut> {
  return {
    name: 'weather_alerts',
    description:
      "Active severe-weather alerts (advisories, watches, warnings) from official sources for the user's location (caller lat/lng → fresh iOS location packet → home anchor). Returns title, severity, affected regions, start/expires timestamps, full description, and the source URL when available. Empty array when no active alerts — that is the answer, not an error. Pass `user_id` for another household member. Use this to gate suppression of non-critical chatter during dangerous weather, to surface 'Tornado warning in effect until 7pm' in a brief, or to recommend household actions (close blinds before hail, charge devices before a wind event).",
    risk: 'read',
    required_capabilities: ['read_weather'],
    input_schema: AlertsInput,
    output_schema: AlertsOutput,

    idempotency_key(input) {
      const lat = typeof input.lat === 'number' ? input.lat.toFixed(3) : 'env';
      const lng = typeof input.lng === 'number' ? input.lng.toFixed(3) : 'env';
      return `weather_alerts:${createHash('sha256').update(`${lat},${lng},${input.user_id ?? ''}`).digest('hex').slice(0, 12)}`;
    },

    async execute(input, ctx: ToolContext): Promise<AlertsOut> {
      const resolved = await resolve_coords_with_recovery(input, users, memory, ctx);
      if (!resolved.ok) {
        const out: AlertsOut = { ok: false, error: 'no coordinates available', recovery_hint: resolved.recovery_hint };
        audit_log(ctx, 'weather_alerts', input as Record<string, unknown>, out, out.error);
        return out;
      }
      const c = resolved.coords;
      const fetched = await pirate_fetch(c.lat, c.lng);
      if (!fetched.ok) {
        const out: AlertsOut = {
          ok: false,
          error: fetched.error,
          recovery_hint: recovery_for_fetch_error(fetched.status, fetched.error),
        };
        audit_log(ctx, 'weather_alerts', { ...input, lat: c.lat, lng: c.lng }, out, out.error);
        return out;
      }
      const data = fetched.data;
      const alerts: z.infer<typeof AlertEntry>[] = (data.alerts ?? []).map((a) => ({
        title: a.title,
        severity: a.severity ?? 'unknown',
        regions: a.regions ?? [],
        ts_start: iso_from_pirate_time(a.time),
        ts_expires: iso_from_pirate_time(a.expires),
        description: a.description ?? null,
        url: a.uri ?? null,
      }));
      const out: AlertsOut = {
        ok: true,
        timezone: data.timezone,
        alerts,
        provider: 'pirate_weather',
        coords_used: {
          lat: c.lat,
          lng: c.lng,
          source: c.source,
          label: c.label,
          confidence: c.confidence,
          staleness_seconds: c.staleness_seconds,
        },
      };
      audit_log(ctx, 'weather_alerts', { ...input, lat: c.lat, lng: c.lng, coord_source: c.source }, out);
      return out;
    },
  };
}

// ── Loader factory ───────────────────────────────────────────────────────

export function create(deps: ToolDeps): Tool[] {
  return [
    make_weather_now(deps.users, deps.memory),
    make_weather_forecast(deps.users, deps.memory),
    make_weather_alerts(deps.users, deps.memory),
  ];
}

// ── Internal helper for brief_context ────────────────────────────────────
// pull_brief_context calls this directly (not via the tool registry) to
// avoid spinning up a ToolContext just to bake a verified-life-context
// envelope. Caller resolves user-specific coords via UserRegistry and
// passes them explicitly — keeps the connector decoupled from user
// identity resolution. Returns a structured failure so the puller can
// mark the readings 'unavailable' with the right reason instead of
// crashing.

export interface BriefWeatherSnapshot {
  as_of: string;
  forecast_summary: string | null;
  precip_chance_today: number | null;
  temperature_high_f: number | null;
  temperature_low_f: number | null;
  current_temperature_f: number | null;
  current_condition: string | null;
  alert_count: number;
  source: 'pirate_weather';
  location_label: string | null;
}

export async function fetch_brief_weather(args: {
  lat: number;
  lng: number;
  location_label?: string | null;
}): Promise<{ ok: true; data: BriefWeatherSnapshot } | { ok: false; reason: string }> {
  if (!pirate_api_key()) {
    return {
      ok: false,
      reason:
        'PIRATE_WEATHER_API_KEY not set (free key at https://pirateweather.net)',
    };
  }
  const fetched = await pirate_fetch(args.lat, args.lng);
  if (!fetched.ok) {
    return { ok: false, reason: fetched.error };
  }
  const cur = fetched.data.currently;
  const today = fetched.data.daily?.data?.[0];
  return {
    ok: true,
    data: {
      as_of: iso_from_pirate_time(cur?.time) ?? new Date().toISOString(),
      forecast_summary: today?.summary ?? fetched.data.daily?.summary ?? cur?.summary ?? null,
      precip_chance_today: today?.precipProbability ?? null,
      temperature_high_f: today?.temperatureHigh ?? null,
      temperature_low_f: today?.temperatureLow ?? null,
      current_temperature_f: cur?.temperature ?? null,
      current_condition: cur?.summary ?? null,
      alert_count: fetched.data.alerts?.length ?? 0,
      source: 'pirate_weather',
      location_label: args.location_label ?? null,
    },
  };
}

export interface ActiveWeatherAlert {
  title: string;
  severity: string; // 'advisory' | 'watch' | 'warning' | provider-specific
  ts_expires: string | null;
  description: string | null;
}

/**
 * The active severe-weather alerts (NWS via Pirate) for a point — a
 * non-tool sibling of `weather_alerts` for callers (the dangerous-weather
 * monitor) that want the alert list without spinning up a ToolContext.
 * Returns a tagged result so the caller distinguishes "no key / fetch
 * failed" (skip this danger source, fail-open) from "fetched, zero alerts."
 */
export async function fetch_weather_alerts(args: {
  lat: number;
  lng: number;
}): Promise<{ ok: true; alerts: ActiveWeatherAlert[] } | { ok: false; reason: string }> {
  if (!pirate_api_key()) {
    return { ok: false, reason: 'PIRATE_WEATHER_API_KEY not set' };
  }
  const fetched = await pirate_fetch(args.lat, args.lng);
  if (!fetched.ok) return { ok: false, reason: fetched.error };
  const alerts: ActiveWeatherAlert[] = (fetched.data.alerts ?? []).map((a) => ({
    title: a.title,
    severity: a.severity ?? 'unknown',
    ts_expires: iso_from_pirate_time(a.expires),
    description: a.description ?? null,
  }));
  return { ok: true, alerts };
}
