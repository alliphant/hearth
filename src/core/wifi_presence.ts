/**
 * wifi_presence — a corroborating presence SOURCE for resolve_household_locations
 * (Household Awareness). A household member whose phone is currently associated
 * to the home UniFi APs is HOME — direct physical evidence that beats the
 * edge-triggered iOS geofence (which reads 'unknown' most of the time). Reuses
 * the EXISTING UniFi connector (`list_active_clients` → /proxy/network stat/sta);
 * no new hardware, one cookie already covers Network + Protect.
 *
 * Gated behind `HEARTH_WIFI_PRESENCE` (fail-open: off / UniFi down / no mapping
 * → presence is exactly the iOS-derived value, byte-identical). Mirrors the
 * dormant-layer pattern (ble_presence / person_tracks).
 *
 * Direction of effect, deliberately: WiFi only ever CONFIRMS home (overriding a
 * stale/unknown geofence). It never sets 'away' — a device's ABSENCE from the AP
 * could be WiFi-off / a sleeping radio, not departure; confident 'away' stays the
 * iOS departure event's job. So this is a pure positive corroborator. (The
 * phone-left-at-home false-home is the universal device≠person caveat, accepted
 * like BLE; naming a track still requires a face match.)
 */
import type { Database } from 'bun:sqlite';
import type { HouseholdLocation } from '@memory/client';
import { WifiDevicesStore, type WifiDeviceRow } from '@memory/stores/wifi_devices';
import { list_active_clients, type ActiveClient } from '@connectors/unifi';

/** Dark unless explicitly enabled. */
export function wifi_presence_enabled(): boolean {
  return process.env.HEARTH_WIFI_PRESENCE === '1';
}

/** A device matches a live client by MAC (precise) OR a hostname substring
 *  (zero-capture fallback). Pure. */
export function match_device(dev: WifiDeviceRow, client: ActiveClient): boolean {
  if (dev.mac && client.mac === dev.mac.toLowerCase()) return true;
  if (dev.hostname_match) {
    const needle = dev.hostname_match.toLowerCase();
    // Match the UniFi alias OR the device hostname — the alias ("Jasper's iPhone")
    // is the reliable one; the hostname is often just "iPhone".
    if ((client.alias ?? '').toLowerCase().includes(needle)) return true;
    if ((client.hostname ?? '').toLowerCase().includes(needle)) return true;
  }
  return false;
}

export interface WifiHomeResult {
  /** Household member ids whose device is currently associated to the home APs. */
  home_members: Set<string>;
  /** False when the active-client read failed/empty (so callers know it's not
   *  authoritative — though WiFi never forces 'away', so this is informational). */
  available: boolean;
  /** Per-match detail for the debug surface (member + which device + AP). */
  matched: Array<{ member_user_id: string; kind: string; ap_mac: string | null; via: 'mac' | 'hostname' }>;
}

/**
 * Resolve which household members are home by WiFi association. Reads the live
 * active-client list (injectable for tests) + the wifi_devices mapping, matches,
 * and returns the home set. Fail-open: disabled / read error / empty → an empty
 * home set with `available:false` (no change to iOS presence downstream).
 */
export async function resolve_wifi_home(
  db: Database,
  owner_user_id: string,
  opts: { fetch_clients?: () => Promise<ActiveClient[]> } = {},
): Promise<WifiHomeResult> {
  const empty: WifiHomeResult = { home_members: new Set(), available: false, matched: [] };
  if (!wifi_presence_enabled()) return empty;
  const fetch_clients = opts.fetch_clients ?? list_active_clients;
  let clients: ActiveClient[];
  try {
    clients = await fetch_clients();
  } catch {
    return empty;
  }
  if (clients.length === 0) return empty; // UniFi unreachable / nothing associated — don't conclude away
  const devices = new WifiDevicesStore(db).list(owner_user_id);
  const home_members = new Set<string>();
  const matched: WifiHomeResult['matched'] = [];
  for (const dev of devices) {
    for (const c of clients) {
      if (!match_device(dev, c)) continue;
      home_members.add(dev.member_user_id);
      matched.push({
        member_user_id: dev.member_user_id,
        kind: dev.kind,
        ap_mac: c.ap_mac,
        via: dev.mac && c.mac === dev.mac.toLowerCase() ? 'mac' : 'hostname',
      });
      break;
    }
  }
  return { home_members, available: true, matched };
}

/**
 * Apply the WiFi home-confirmation to iOS-derived presence (pure). A member in
 * `home_members` whose presence isn't already 'home' is upgraded to home/high,
 * stamped as-of now (the association is live). Members not WiFi-home are left
 * exactly as the geofence resolved them. WiFi never sets 'away'.
 */
export function apply_wifi_home(
  locations: HouseholdLocation[],
  home_members: Set<string>,
  now_ms: number,
): HouseholdLocation[] {
  if (home_members.size === 0) return locations;
  const as_of = new Date(now_ms).toISOString();
  return locations.map((l) =>
    home_members.has(l.user_id) && l.presence !== 'home'
      ? { ...l, presence: 'home' as const, presence_confidence: 'high' as const, as_of }
      : l,
  );
}
