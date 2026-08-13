/**
 * smoke:ble-presence — Household Awareness Layer P3b (the Hearth read + fusion
 * half of the BLE room layer). Self-contained: temp vault + db, an INJECTED HA
 * state fetcher (no Home Assistant, no hardware), an injected cache. Proves the
 * scaffolding that lights up when HEARTH_BLE_PRESENCE=1 + the Atom Lites/Bermuda
 * are live.
 *
 * Asserts:
 *   - BleDevicesStore round-trip (upsert idempotent on ha_area_entity, list,
 *     list_for_person, delete) — the device→person grouping.
 *   - run_ble_presence_sweep: HA Area → room via home_map.ble_areas; HA-stale
 *     reading skipped; unmapped Area cached with room_id null.
 *   - resolve_ble_occupants: per-person best room (primary phone > best_effort
 *     watch); unmapped (room_id null) excluded.
 *   - augment_occupancy_with_ble: a BLE-only person is ADDED as an occupant
 *     (zone = room id, presence home, no camera/crop); a face-occupant is NOT
 *     duplicated (face wins).
 *   - the flag gate (ble_presence_enabled) + the home_occupancy route end-to-end
 *     with the flag on + a warm cache.
 */
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient, type HouseholdOccupancy, type HouseholdLocation } from '../src/memory/client';
import { BleDevicesStore } from '../src/memory/stores/ble_devices';
import { HomeMapStore, type HomeMapGeometry } from '../src/memory/stores/home_map';
import { BlePresenceCache, get_ble_presence_cache, _reset_ble_presence_cache } from '../src/core/ble_presence_cache';
import {
  ble_presence_enabled,
  run_ble_presence_sweep,
  resolve_ble_occupants,
  augment_occupancy_with_ble,
  apply_ble_home,
  _reset_ble_sweep_throttle,
} from '../src/core/ble_presence';
import { create_home_router } from '../src/app/routes/home';
import type { UserRegistry } from '../src/core/users';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-ble-'));
const vault_root = join(dir, 'vault');
mkdirSync(vault_root, { recursive: true });
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root, db });
const OWNER = 'jasper';
const NOW = Date.now();
const MIN = 60_000;
const iso = (ms_ago: number) => new Date(NOW - ms_ago).toISOString();

const fake_ha = (states: Record<string, { state?: string; last_updated?: string } | null>) =>
  async (entity: string) => states[entity] ?? null;

async function main(): Promise<void> {
  /* ── 1. Seed home_map (Garage + Office, with HA-Area→room overlay) + person ── */
  const store = new HomeMapStore(db);
  const geometry: HomeMapGeometry = {
    units: 'ft',
    floors: [{ level: 0, name: 'First Floor', mirrored: false }],
    rooms: [
      { id: 'garage', name: 'Garage', floor: 0, kind: 'room', polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] },
      { id: 'office', name: 'Office', floor: 0, kind: 'room', polygon: [[10, 0], [20, 0], [20, 10], [10, 10]] },
    ],
    adjacency: [{ a: 'garage', b: 'office', via: 'doorway' }],
  };
  store.set_geometry(geometry);
  store.set_assignments('garage', { ble_areas: ['Garage'] });
  store.set_assignments('office', { ble_areas: ['Office'] });

  const pid = memory.upsert_enrolled_person({
    user_id: OWNER, cpai_userid: 'jasper', display_name: 'Jasper', relationship: 'self', add_image_count: 1,
  });

  /* ── 2. BleDevicesStore round-trip ───────────────────────────────────────── */
  const ble = new BleDevicesStore(db);
  const phone_id = ble.upsert({ user_id: OWNER, enrolled_person_id: pid, kind: 'phone', ha_area_entity: 'sensor.jasons_iphone_area', reliability: 'primary', label: "Jasper's iPhone" });
  const watch_id = ble.upsert({ user_id: OWNER, enrolled_person_id: pid, kind: 'watch', ha_area_entity: 'sensor.jasons_watch_area', reliability: 'best_effort' });
  check('store: two devices for Jasper', ble.list(OWNER).length === 2);
  check('store: list_for_person groups both devices under Jasper', ble.list_for_person(OWNER, pid).length === 2);
  const reup = ble.upsert({ user_id: OWNER, enrolled_person_id: pid, kind: 'phone', ha_area_entity: 'sensor.jasons_iphone_area', reliability: 'primary' });
  check('store: upsert idempotent on (user, ha_area_entity)', reup === phone_id && ble.list(OWNER).length === 2);

  /* ── 3. run_ble_presence_sweep — HA Area → room via ble_areas ─────────────── */
  const c1 = new BlePresenceCache();
  await run_ble_presence_sweep({
    db, owner_user_id: OWNER, cache: c1, now_ms: NOW, force: true,
    fetch_state: fake_ha({
      'sensor.jasons_iphone_area': { state: 'Garage', last_updated: iso(2_000) },
      'sensor.jasons_watch_area': { state: 'Office', last_updated: iso(2_000) },
    }),
  });
  check('sweep: phone HA Area "Garage" → room_id garage', c1.get(phone_id)?.room_id === 'garage');
  check('sweep: watch HA Area "Office" → room_id office', c1.get(watch_id)?.room_id === 'office');

  // HA-stale reading (last_updated older than the freshness window) is skipped.
  const c2 = new BlePresenceCache();
  await run_ble_presence_sweep({
    db, owner_user_id: OWNER, cache: c2, now_ms: NOW, force: true,
    fetch_state: fake_ha({ 'sensor.jasons_iphone_area': { state: 'Garage', last_updated: iso(5 * MIN) } }),
  });
  check('sweep: HA-stale reading (5m) skipped', c2.get(phone_id) === null);

  // An HA Area not mapped to any room caches with room_id null (unplaceable).
  const c3 = new BlePresenceCache();
  await run_ble_presence_sweep({
    db, owner_user_id: OWNER, cache: c3, now_ms: NOW, force: true,
    fetch_state: fake_ha({ 'sensor.jasons_iphone_area': { state: 'Basement', last_updated: iso(2_000) } }),
  });
  check('sweep: unmapped HA Area → cached room_id null', c3.get(phone_id)?.room_id === null && c3.get(phone_id)?.ha_area === 'Basement');

  /* ── 4. resolve_ble_occupants — per-person best room (primary > watch) ────── */
  // Phone in garage (primary) + watch in office (best_effort) → Jasper resolves to garage.
  const occJason = resolve_ble_occupants(db, memory, OWNER, c1);
  check('resolve: one occupant (Jasper), deduped across phone+watch', occJason.length === 1 && occJason[0]!.name === 'Jasper');
  check('resolve: primary phone wins over best_effort watch (garage)', occJason[0]!.room_id === 'garage');
  // A cache with only the unmapped reading → no placeable occupant.
  check('resolve: unmapped-only reading → no occupant', resolve_ble_occupants(db, memory, OWNER, c3).length === 0);

  /* ── 5. augment_occupancy_with_ble ───────────────────────────────────────── */
  const locations: HouseholdLocation[] = [
    { user_id: 'jasper', display_name: 'Jasper', presence: 'home', presence_confidence: 'high', as_of: iso(2_000) },
  ];
  const empty_occ: HouseholdOccupancy = { generated_at: new Date(NOW).toISOString(), window_minutes: 30, occupants: [], unknown_present: [], household: [] };
  const fused = augment_occupancy_with_ble(empty_occ, occJason, { now_ms: NOW, locations });
  const j = fused.occupants.find((o) => o.name === 'Jasper');
  check('augment: BLE-only Jasper ADDED as occupant', !!j);
  check('augment: zone = room id (canvas places by id), presence home, no camera/crop',
    j?.zone === 'garage' && j?.presence === 'home' && j?.camera_name === null && j?.rep_sighting_id === null);
  check('augment: household_user_id resolved by name', j?.household_user_id === 'jasper');

  // Face wins: a person already a camera occupant is NOT duplicated by BLE.
  const face_occ: HouseholdOccupancy = {
    generated_at: new Date(NOW).toISOString(), window_minutes: 30, unknown_present: [], household: [],
    occupants: [{
      kind: 'known', person_id: pid, name: 'Jasper', relationship: 'self', cluster_id: 'cl_x', rep_sighting_id: 's_x',
      zone: 'kitchen', camera_name: 'Kitchen Cam', last_seen_at: iso(60_000), seconds_ago: 60, appearance: 'gray hoodie',
      sighting_confidence: 0.9, household_user_id: 'jasper', presence: 'home', presence_confidence: 'high', presence_as_of: iso(60_000),
    }],
  };
  const fused2 = augment_occupancy_with_ble(face_occ, occJason, { now_ms: NOW, locations });
  check('augment: face occupant NOT duplicated by BLE (face wins)',
    fused2.occupants.filter((o) => o.person_id === pid).length === 1 && fused2.occupants[0]!.camera_name === 'Kitchen Cam');

  /* ── 6. flag gate ────────────────────────────────────────────────────────── */
  delete process.env.HEARTH_BLE_PRESENCE;
  check('flag: disabled by default', ble_presence_enabled() === false);
  process.env.HEARTH_BLE_PRESENCE = '1';
  check('flag: enabled when HEARTH_BLE_PRESENCE=1', ble_presence_enabled() === true);

  /* ── 7. home_occupancy route end-to-end (flag on, warm singleton cache) ───── */
  // No HA, no devices on the sweep path: delete the devices so the route's
  // internal sweep no-ops (0 devices → no HA calls), and warm the singleton
  // cache directly — proving the read+fusion path the route wires.
  ble.delete(OWNER, phone_id);
  ble.delete(OWNER, watch_id);
  _reset_ble_presence_cache();
  _reset_ble_sweep_throttle();
  get_ble_presence_cache().set({ device_id: phone_id, enrolled_person_id: pid, room_id: 'garage', ha_area: 'Garage', reliability: 'primary', captured_at: new Date().toISOString() });

  const users_stub = {
    home_coords: () => ({ lat: 40, lng: -105, label: null, source: 'env_fallback' as const }),
    list: () => [{ id: 'jasper', display_name: 'Jasper', tier: 'owner' }],
  } as unknown as UserRegistry;
  const specialists_stub = {
    get: (id: string) => (id === 'luna' ? { granted: new Set(['read_home']) } : undefined),
  } as unknown as Parameters<typeof create_home_router>[0]['specialists'];
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('user', { id: OWNER, tier: 'owner' } as never); await next(); });
  app.route('/api/specialists', create_home_router({ db, memory, specialists: specialists_stub, users: users_stub }));

  const res = await app.request('/api/specialists/luna/home_occupancy?window_minutes=30');
  const body = (await res.json()) as { occupants: Array<{ name: string; zone: string | null; zone_id: string | null; presence: string | null }> };
  const route_j = body.occupants.find((o) => o.name === 'Jasper');
  check('route: flag on + warm cache → Jasper BLE occupant in response', !!route_j);
  check('route: zone shows room NAME "Garage", zone_id "garage" (canvas-placeable)', route_j?.zone === 'Garage' && route_j?.zone_id === 'garage');

  delete process.env.HEARTH_BLE_PRESENCE;
  /* ── apply_ble_home — the resolver corroborator (2026-07-15) ──────────────── */
  {
    process.env.HEARTH_BLE_PRESENCE = '1';
    // Section 7 deleted the devices — re-enroll the phone for the corroborator.
    ble.upsert({ user_id: OWNER, enrolled_person_id: pid, kind: 'phone', ha_area_entity: 'sensor.jasons_iphone_area', reliability: 'primary', label: "Jasper's iPhone" });
    _reset_ble_sweep_throttle();
    const cache = new BlePresenceCache();
    const locations = [
      { user_id: 'jasper', display_name: 'Jasper', presence: 'unknown' as const, presence_confidence: null, as_of: null },
      { user_id: 'sam', display_name: 'Sam', presence: 'away' as const, presence_confidence: 'high' as const, as_of: iso(0) },
    ];
    const applied = await apply_ble_home(db, OWNER, locations, NOW, {
      cache,
      fetch_state: fake_ha({
        'sensor.jasons_iphone_area': { state: 'Garage', last_updated: iso(2_000) },
      }),
    });
    const jasper = applied.find((l) => l.user_id === 'jasper')!;
    const sam = applied.find((l) => l.user_id === 'sam')!;
    check('corroborator: fresh primary BLE reading flips unknown → home/high', jasper.presence === 'home' && jasper.presence_confidence === 'high');
    check('corroborator: members without a BLE reading untouched', sam.presence === 'away');

    // Unmapped HA Area (no room) never claims home.
    _reset_ble_sweep_throttle();
    const cache2 = new BlePresenceCache();
    const applied2 = await apply_ble_home(db, OWNER, locations, NOW, {
      cache: cache2,
      fetch_state: fake_ha({
        'sensor.jasons_iphone_area': { state: 'Attic Crawlspace', last_updated: iso(2_000) },
      }),
    });
    check('corroborator: unmapped HA Area cannot claim home', applied2.find((l) => l.user_id === 'jasper')!.presence === 'unknown');

    // Kill switch honors.
    process.env.HEARTH_BLE_PRESENCE = '0';
    _reset_ble_sweep_throttle();
    const applied3 = await apply_ble_home(db, OWNER, locations, NOW, {
      cache: new BlePresenceCache(),
      fetch_state: fake_ha({ 'sensor.jasons_iphone_area': { state: 'Garage', last_updated: iso(2_000) } }),
    });
    check('corroborator: kill switch is a no-op', applied3.find((l) => l.user_id === 'jasper')!.presence === 'unknown');
    process.env.HEARTH_BLE_PRESENCE = '1';
  }

  _reset_ble_presence_cache();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('');
  console.log(failures === 0 ? 'smoke:ble-presence — all checks passed' : `smoke:ble-presence — ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke:ble-presence crashed:', err);
  process.exit(1);
});
