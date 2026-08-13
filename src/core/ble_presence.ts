/**
 * ble_presence — the Hearth read + fusion half of the BLE room-presence layer
 * (Household Awareness Layer P3; design-ble-room-presence.md §6). DORMANT until
 * `HEARTH_BLE_PRESENCE=1` AND the hardware is live (Atom Lite proxies + Bermuda +
 * Private BLE Device in HA). When off, every entry point is a no-op and occupancy
 * is byte-identical to today (fail-open contract).
 *
 * Three pieces:
 *   - run_ble_presence_sweep  — read each enrolled device's Bermuda area sensor
 *     from HA, resolve HA Area → room via home_map.ble_areas, write the cache.
 *   - resolve_ble_occupants   — per-PERSON best fresh room from the cache.
 *   - augment_occupancy_with_ble — merge BLE people into the occupancy result
 *     (the Garage payoff: a person with no face sighting still shows in their
 *     room). Face occupants win; BLE only ADDS people the cameras didn't catch.
 */
import type { Database } from 'bun:sqlite';
import type {
  MemoryClient,
  HouseholdOccupancy,
  OccupancyOccupant,
  HouseholdLocation,
} from '@memory/client';
import { BleDevicesStore } from '@memory/stores/ble_devices';
import { HomeMapStore } from '@memory/stores/home_map';
import { fetch_ha_state } from '@connectors/home_assistant';
import { get_ble_presence_cache, type BlePresenceCache, type BleReading } from './ble_presence_cache';

/** The whole layer is dark unless explicitly enabled (hardware-gated rollout). */
export function ble_presence_enabled(): boolean {
  return process.env.HEARTH_BLE_PRESENCE === '1';
}

/**
 * HA data older than this can't confirm the current room — skip.
 *
 * The original comment here claimed "Bermuda updates every 0-3s, so a healthy
 * reading is always well within this." That is FALSE and was never measured.
 * Bermuda pushes on CHANGE: a stationary phone generates no updates at all.
 * Measured 2026-08-03 — `sensor.jasper_s_iphone_area` held `Kitchen` with
 * last_updated frozen for 14+ minutes and aging monotonically (691s -> 867s
 * across a 3-minute sample).
 *
 * BUT the window is NOT why the layer is dark, and widening it does not help.
 * The same sweep showed `bermuda_global_visible_device_count` = 60 refreshing
 * every ~40s (Bermuda is healthy) while THIS device sat 101 minutes stale, and
 * `bermuda_global_active_proxy_count` = 1 — a single proxy, where the design
 * (design-ble-room-presence.md) assumes several Atom Lite proxies for
 * trilateration. With one proxy and an idle iPhone (iOS throttles BLE
 * advertising when locked) the per-device reading simply stops refreshing.
 * No freshness value passes a 101-minute-old fix.
 *
 * So this stays at the conservative 30s: presence should FAIL CLOSED, and
 * reporting a room from a stale fix is the confident-but-wrong failure this
 * layer must not have. Set the real value from measurement once proxy
 * coverage is in place; HEARTH_BLE_FRESH_MS overrides without a deploy.
 */
const BLE_FRESH_MS = Number(process.env.HEARTH_BLE_FRESH_MS ?? 30_000);
/** Don't re-hit HA more often than this — the read path calls the sweep, so a
 *  burst of office opens shouldn't hammer the controller. */
const SWEEP_THROTTLE_MS = Number(process.env.HEARTH_BLE_SWEEP_THROTTLE_MS ?? 8_000);

type FetchState = (entity_id: string) => Promise<{ state?: string; last_updated?: string } | null>;

let _last_sweep_ms = 0;
/** Test seam — clear the throttle so a smoke's sweeps always run. */
export function _reset_ble_sweep_throttle(): void {
  _last_sweep_ms = 0;
}

export interface BleSweepDeps {
  db: Database;
  owner_user_id: string;
  /** Injectable for tests; defaults to the live HA REST read. */
  fetch_state?: FetchState;
  cache?: BlePresenceCache;
  now_ms?: number;
  /** Bypass the throttle (tests / a forced refresh). */
  force?: boolean;
}

/**
 * Read every enrolled BLE device's Bermuda area sensor from HA, resolve the HA
 * Area → room via home_map.ble_areas, and write fresh readings to the cache.
 * Fail-open per device; throttled. Returns how many readings landed.
 */
export async function run_ble_presence_sweep(deps: BleSweepDeps): Promise<{ updated: number }> {
  const now_ms = deps.now_ms ?? Date.now();
  if (!deps.force && now_ms - _last_sweep_ms < SWEEP_THROTTLE_MS) return { updated: 0 };
  _last_sweep_ms = now_ms;

  const fetch_state = deps.fetch_state ?? fetch_ha_state;
  const cache = deps.cache ?? get_ble_presence_cache();
  const devices = new BleDevicesStore(deps.db).list(deps.owner_user_id);
  if (devices.length === 0) return { updated: 0 };

  // HA Area name (lowercased) → room_id, from the home_map overlay.
  const map = new HomeMapStore(deps.db).get();
  const area_to_room = new Map<string, string>();
  for (const room of map.rooms) for (const area of room.ble_areas) area_to_room.set(area.toLowerCase(), room.id);

  let updated = 0;
  await Promise.all(
    devices.map(async (d) => {
      let st: Awaited<ReturnType<FetchState>>;
      try {
        st = await fetch_state(d.ha_area_entity);
      } catch {
        st = null;
      }
      if (!st || typeof st.state !== 'string' || !st.state) return;
      const area = st.state;
      if (area === 'unknown' || area === 'unavailable') return;
      // HA-side freshness: a stale area reading can't confirm the room now.
      const fix_ms = st.last_updated ? Date.parse(st.last_updated) : NaN;
      if (Number.isFinite(fix_ms) && now_ms - fix_ms > BLE_FRESH_MS) return;
      cache.set({
        device_id: d.id,
        enrolled_person_id: d.enrolled_person_id,
        room_id: area_to_room.get(area.toLowerCase()) ?? null,
        ha_area: area,
        reliability: d.reliability,
        captured_at: st.last_updated ?? new Date(now_ms).toISOString(),
      });
      updated++;
    }),
  );
  return { updated };
}

export interface BleOccupant {
  person_id: string;
  name: string;
  relationship: string | null;
  room_id: string;
  ha_area: string;
  captured_at: string;
  reliability: 'primary' | 'best_effort';
}

/**
 * Per-PERSON best fresh BLE room from the live cache. A person with phone+watch
 * gets ONE entry (primary > best_effort, then most recent). Readings whose HA
 * Area isn't mapped to a room (room_id null) are dropped — can't be placed.
 */
export function resolve_ble_occupants(
  db: Database,
  memory: MemoryClient,
  owner_user_id: string,
  cache?: BlePresenceCache,
): BleOccupant[] {
  const c = cache ?? get_ble_presence_cache();
  const live = c.live_readings();
  if (live.length === 0) return [];

  const persons = memory.list_enrolled_persons(owner_user_id);
  const person_by_id = new Map(persons.map((p) => [p.id, p]));

  const best = new Map<string, BleReading>();
  for (const r of live) {
    if (!r.room_id) continue; // HA Area not assigned to a room — unplaceable
    const prev = best.get(r.enrolled_person_id);
    if (!prev) {
      best.set(r.enrolled_person_id, r);
      continue;
    }
    const better =
      (r.reliability === 'primary' && prev.reliability !== 'primary') ||
      (r.reliability === prev.reliability && Date.parse(r.captured_at) > Date.parse(prev.captured_at));
    if (better) best.set(r.enrolled_person_id, r);
  }

  const out: BleOccupant[] = [];
  for (const [pid, r] of best) {
    const p = person_by_id.get(pid);
    if (!p || !r.room_id) continue;
    out.push({
      person_id: pid,
      name: p.display_name,
      relationship: p.relationship ?? null,
      room_id: r.room_id,
      ha_area: r.ha_area,
      captured_at: r.captured_at,
      reliability: r.reliability,
    });
  }
  return out;
}

/**
 * Merge BLE occupants into an occupancy result. Face occupants WIN (a person
 * already seen on camera keeps their face row); BLE only ADDS people the cameras
 * missed — the face-blind-room payoff. `zone` carries the room ID (the route's
 * display_zone maps id → name; the canvas places the dot by id).
 */
export function augment_occupancy_with_ble(
  occ: HouseholdOccupancy,
  ble: BleOccupant[],
  opts: { now_ms?: number; locations?: HouseholdLocation[] } = {},
): HouseholdOccupancy {
  if (ble.length === 0) return occ;
  const now_ms = opts.now_ms ?? Date.now();
  const seen = new Set(occ.occupants.map((o) => o.person_id));
  const user_by_name = new Map((opts.locations ?? []).map((l) => [l.display_name.toLowerCase(), l.user_id]));

  const added: OccupancyOccupant[] = [];
  for (const b of ble) {
    if (seen.has(b.person_id)) continue; // already a camera/face occupant — face wins
    const cap_ms = Date.parse(b.captured_at);
    added.push({
      kind: 'known',
      person_id: b.person_id,
      name: b.name,
      relationship: b.relationship,
      cluster_id: '', // no face cluster — BLE-sourced
      rep_sighting_id: null,
      zone: b.room_id, // room ID (route maps id→name; canvas places by id)
      camera_name: null, // not seen on a camera
      last_seen_at: b.captured_at,
      seconds_ago: Number.isFinite(cap_ms) ? Math.max(0, Math.floor((now_ms - cap_ms) / 1000)) : null,
      appearance: null,
      sighting_confidence: null,
      household_user_id: user_by_name.get(b.name.toLowerCase()) ?? null,
      presence: 'home', // their device is in a home room
      presence_confidence: b.reliability === 'primary' ? 'high' : 'medium',
      presence_as_of: b.captured_at,
    });
  }
  if (added.length === 0) return occ;
  return { ...occ, occupants: [...occ.occupants, ...added] };
}

/**
 * BLE HOME corroborator for the shared presence resolver (2026-07-15, the
 * security-autonomy audit). The WiFi-association corroborator's sibling: a
 * member whose enrolled BLE device has a FRESH reading in a mapped home room
 * is HOME — overriding a stale/unknown iOS geofence. This is what finally
 * lets the away-monitor's emptiness gate, the who's-home view, and every
 * other resolver consumer see the Bermuda proxies; before this, BLE only
 * ever ADDED occupants to the Home-map display.
 *
 * Person→member mapping mirrors the roster convention used everywhere else
 * (display-name match, case-insensitive). Direct db read for the person
 * names — the resolver deliberately has no MemoryClient. Fail-open by
 * contract: disabled / HA down / no devices / any throw → locations
 * unchanged.
 */
export async function apply_ble_home(
  db: Database,
  owner_user_id: string,
  locations: HouseholdLocation[],
  now_ms: number = Date.now(),
  /** Test seams — the smoke injects a fake HA read + its own cache. */
  opts: { fetch_state?: FetchState; cache?: BlePresenceCache } = {},
): Promise<HouseholdLocation[]> {
  if (!ble_presence_enabled()) return locations;
  try {
    const cache = opts.cache ?? get_ble_presence_cache();
    await run_ble_presence_sweep({
      db,
      owner_user_id,
      now_ms,
      cache,
      ...(opts.fetch_state ? { fetch_state: opts.fetch_state, force: true } : {}),
    });
    const live = cache.live_readings();
    if (live.length === 0) return locations;

    // Best fresh in-home-room reading per person (primary beats best_effort,
    // then recency) — the resolve_ble_occupants selection, without the
    // MemoryClient dependency.
    const best = new Map<string, BleReading>();
    for (const r of live) {
      if (!r.room_id) continue; // unmapped HA Area — can't place in the home
      const prev = best.get(r.enrolled_person_id);
      const better =
        !prev ||
        (r.reliability === 'primary' && prev.reliability !== 'primary') ||
        (r.reliability === prev.reliability &&
          Date.parse(r.captured_at) > Date.parse(prev.captured_at));
      if (better) best.set(r.enrolled_person_id, r);
    }
    if (best.size === 0) return locations;

    const persons = db
      .prepare(`SELECT id, display_name FROM enrolled_persons WHERE user_id = @u`)
      .all({ '@u': owner_user_id }) as Array<{ id: string; display_name: string }>;
    const reading_by_name = new Map<string, BleReading>();
    for (const p of persons) {
      const r = best.get(p.id);
      if (r) reading_by_name.set(p.display_name.toLowerCase(), r);
    }
    if (reading_by_name.size === 0) return locations;

    return locations.map((l) => {
      if (l.presence === 'home') return l;
      const r = reading_by_name.get(l.display_name.toLowerCase());
      if (!r) return l;
      return {
        ...l,
        presence: 'home' as const,
        presence_confidence: r.reliability === 'primary' ? ('high' as const) : ('medium' as const),
        as_of: r.captured_at,
      };
    });
  } catch {
    return locations; // fail-open — geofence/wifi-only
  }
}
