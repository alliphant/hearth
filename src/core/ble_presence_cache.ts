/**
 * BlePresenceCache — the ephemeral "latest room per BLE device" cache for the
 * BLE room-presence layer (Household Awareness Layer P3; design-ble-room-presence.md
 * §6c). Mirrors PresenceLiveCache / location_awareness: a process singleton, never
 * SQLite — BLE readings are transient, recency-derived live, and worthless once
 * stale. The sweep ([ble_presence.ts](./ble_presence.ts)) writes it from HA's
 * Bermuda area sensors; the occupancy fusion reads it.
 */

export interface BleReading {
  device_id: string;
  enrolled_person_id: string;
  /** The home_map room id this device's HA Area maps to, or null when the HA
   *  Area isn't assigned to any room yet (can't place on the floor plan). */
  room_id: string | null;
  /** The raw HA Area name (Bermuda's area sensor state), for the "why" string. */
  ha_area: string;
  reliability: 'primary' | 'best_effort';
  /** HA's `last_updated` for the reading (ISO) — the data's own freshness. */
  captured_at: string;
}

interface Entry {
  reading: BleReading;
  /** Wall-clock ms when we fetched it — drives cache liveness. */
  received_at_ms: number;
}

/** A reading older than this (since WE fetched it) is no longer "live" — the
 *  office degrades to not-placing the device rather than asserting a stale room. */
const LIVE_TTL_MS = Number(process.env.HEARTH_BLE_LIVE_TTL_MS ?? 60_000);

export class BlePresenceCache {
  private entries = new Map<string, Entry>();

  set(reading: BleReading): void {
    this.entries.set(reading.device_id, { reading, received_at_ms: Date.now() });
  }

  get(device_id: string): BleReading | null {
    return this.entries.get(device_id)?.reading ?? null;
  }

  is_live(device_id: string, ttl = LIVE_TTL_MS): boolean {
    const e = this.entries.get(device_id);
    return !!e && Date.now() - e.received_at_ms <= ttl;
  }

  /** All readings fetched within the TTL (the live set the fusion reads). */
  live_readings(ttl = LIVE_TTL_MS): BleReading[] {
    const now = Date.now();
    return [...this.entries.values()]
      .filter((e) => now - e.received_at_ms <= ttl)
      .map((e) => e.reading);
  }

  clear(): void {
    this.entries.clear();
  }
}

let _singleton: BlePresenceCache | null = null;

/** Process-wide singleton — the sweep writes it, the fusion reads it. */
export function get_ble_presence_cache(): BlePresenceCache {
  if (!_singleton) _singleton = new BlePresenceCache();
  return _singleton;
}

/** Test seam — reset the singleton so a smoke starts clean. */
export function _reset_ble_presence_cache(): void {
  _singleton = null;
}
