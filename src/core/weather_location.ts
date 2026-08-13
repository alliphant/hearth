/**
 * Weather-coordinate resolution.
 *
 * Order:
 *   1. Caller-provided lat/lng (destination queries).
 *   2. iOS-pushed location packet — POST /api/sensors/location. Fresh
 *      when captured_at < 6h ago and horizontal_accuracy_m <= 2km.
 *   3. home_location in config/users.yaml (anchor).
 *
 * Nothing else. When iOS hasn't pushed a packet yet, the brief reads
 * weather at the user's home anchor. When iOS is pushing, weather
 * follows the user. That's the whole story.
 */

import type { MemoryClient } from '@memory/client';
import type { UserRegistry } from './users';

export interface ResolvedWeatherCoords {
  lat: number;
  lng: number;
  label: string | null;
  source: 'caller' | 'sensor_current' | 'user_config' | 'env_fallback';
  /** 'high' / 'medium' when source is live; 'static' for anchor. */
  confidence: 'high' | 'medium' | 'static';
  /** Seconds since the underlying reading was captured. Null for anchor. */
  staleness_seconds: number | null;
}

const SENSOR_FRESHNESS_CEILING_S = 6 * 60 * 60; // 6 hours
const SENSOR_ACCURACY_CEILING_M = 2000;          // 2 km

function try_sensor_current(
  user_id: string,
  memory: MemoryClient,
): ResolvedWeatherCoords | null {
  const pkt = memory.query_latest_location_packet(user_id);
  if (!pkt) return null;
  const captured_ms = Date.parse(pkt.payload.ts ?? pkt.captured_at);
  if (!Number.isFinite(captured_ms)) return null;
  const staleness_seconds = Math.max(0, Math.round((Date.now() - captured_ms) / 1000));
  if (staleness_seconds > SENSOR_FRESHNESS_CEILING_S) return null;
  const acc = pkt.payload.horizontal_accuracy_m;
  if (typeof acc === 'number' && acc > SENSOR_ACCURACY_CEILING_M) return null;
  const confidence: 'high' | 'medium' =
    staleness_seconds < 3600 && (typeof acc !== 'number' || acc < 200) ? 'high' : 'medium';
  return {
    lat: pkt.payload.lat,
    lng: pkt.payload.lng,
    label: pkt.payload.place_id ?? null,
    source: 'sensor_current',
    confidence,
    staleness_seconds,
  };
}

function try_anchor(
  user_id: string,
  users: UserRegistry | undefined,
): ResolvedWeatherCoords | null {
  if (!users) return null;
  const home = users.home_coords(user_id);
  if (!home) return null;
  return {
    lat: home.lat,
    lng: home.lng,
    label: home.label,
    source: home.source,
    confidence: 'static',
    staleness_seconds: null,
  };
}

export async function resolve_weather_coords(args: {
  user_id: string;
  users: UserRegistry | undefined;
  memory: MemoryClient;
  caller_lat?: number;
  caller_lng?: number;
}): Promise<ResolvedWeatherCoords | null> {
  if (typeof args.caller_lat === 'number' && typeof args.caller_lng === 'number') {
    return {
      lat: args.caller_lat,
      lng: args.caller_lng,
      label: null,
      source: 'caller',
      confidence: 'high',
      staleness_seconds: 0,
    };
  }
  const sensor = try_sensor_current(args.user_id, args.memory);
  if (sensor) return sensor;
  const anchor = try_anchor(args.user_id, args.users);
  if (anchor) return anchor;
  return null;
}

export function weather_coords_recovery_hint(user_id: string): string {
  return (
    `No coordinates available for user "${user_id}". Tried: ` +
    `(1) caller lat/lng (none passed), ` +
    `(2) latest iOS location packet from POST /api/sensors/location (no packet yet for this user), ` +
    `(3) home_location in config/users.yaml (none configured for this user). ` +
    `Add home_location to the user's users.yaml entry.`
  );
}
