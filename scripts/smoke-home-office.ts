/**
 * smoke:home-office — Household Awareness Layer P1.5 (Luna's household "Home"
 * office + the camera/BLE assignment overlay). Self-contained: temp vault + db,
 * a seeded home_map (geometry from the import session's shape) + enrolled people
 * + a MOCK location source. The camera/sighting layer was removed 2026-08-04;
 * in-room occupancy is BLE-fed now, so this covers the map, the assignment
 * overlay, the home/away roster and tier gating.
 *
 * Asserts the NEW P1.5 surface on top of the shipped P1 occupancy derivation:
 *   - the owner-only assignment overlay (POST .../home_map/assign) sets a
 *     camera→room mapping WITHOUT bumping the geometry revision;
 *   - derive_zone_map turns that assignment into a camera→room lookup (still
 *     live: connectors/unifi.ts resolves Protect cameras to rooms through it);
 *   - the household read (GET .../home_occupancy) is the SANITIZED projection —
 *     named occupants only, NEVER unknown_present, NEVER crop thumbnails;
 *   - tier gating: household reads OK, friend is excluded (403), assignment is
 *     owner-only (403 for household);
 *   - the unknown-room-id guard (400);
 *   - compose_home_pane composes the office (hero + "In the house" list,
 *     room-named, no unknowns).
 */
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { HomeMapStore, derive_zone_map, type HomeMapGeometry } from '../src/memory/stores/home_map';
import { create_home_router } from '../src/app/routes/home';
import { compose_home_pane } from '../src/core/home_pane';
import type { PaneDeps } from '../src/core/specialist_pane';
import { reset_location_cache, _set_cached_snapshot } from '../src/core/location_awareness';
import { resolve_household_locations } from '../src/core/household_awareness';
import type { UserRegistry } from '../src/core/users';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-home-office-'));
const vault_root = join(dir, 'vault');
mkdirSync(vault_root, { recursive: true });
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root, db });
const OWNER = 'jasper';
const MIN = 60_000;

// A users stub with a real owner tier so owner-resolution + home/away resolve.
const users_stub = {
  home_coords: (id: string) =>
    id === OWNER ? { lat: 39.7, lng: -104.89, label: null, source: 'env_fallback' as const } : null,
  list: () => [
    { id: 'jasper', display_name: 'Jasper', tier: 'owner' },
    { id: 'sam', display_name: 'Sam', tier: 'household' },
  ],
} as unknown as UserRegistry;

const specialists_stub = {
  get(id: string) {
    return id === 'luna' ? { granted: new Set(['read_home']) } : undefined;
  },
} as unknown as Parameters<typeof create_home_router>[0]['specialists'];

async function main(): Promise<void> {
  /* ── 1. Seed the imported home_map geometry (import session's shape) ──────── */
  const store = new HomeMapStore(db);
  const geometry: HomeMapGeometry = {
    units: 'ft',
    floors: [
      { level: 0, name: 'First Floor', mirrored: true },
      { level: 1, name: 'Second Floor', mirrored: true },
    ],
    rooms: [
      { id: 'kitchen', name: 'Kitchen', floor: 0, kind: 'room', polygon: [[0, 0], [15, 0], [15, 14], [0, 14]] },
      { id: 'living-room', name: 'Living Room', floor: 0, kind: 'room', polygon: [[15, 0], [32, 0], [32, 14], [15, 14]] },
      { id: 'stairs-1', name: 'Stairs', floor: 0, kind: 'transition', polygon: [[32, 0], [36, 0], [36, 8], [32, 8]] },
      { id: 'stairs-2', name: 'Stairs', floor: 1, kind: 'transition', polygon: [[32, 0], [36, 0], [36, 8], [32, 8]] },
      { id: 'loft', name: 'Loft', floor: 1, kind: 'room', polygon: [[0, 0], [12, 0], [12, 10], [0, 10]] },
    ],
    adjacency: [
      { a: 'kitchen', b: 'living-room', via: 'open' },
      { a: 'living-room', b: 'stairs-1', via: 'open' },
      { a: 'stairs-2', b: 'loft', via: 'open' },
      { a: 'stairs-1', b: 'stairs-2', via: 'stairs' },
    ],
  };
  const seeded = store.set_geometry(geometry);
  check('seed: geometry written, revision bumped to 1', seeded.revision === 1 && seeded.rooms.length === 5);
  check('seed: rooms start with EMPTY camera assignments', seeded.rooms.every((r) => r.cameras.length === 0));
  check('zone_map empty before any assignment', Object.keys(derive_zone_map(seeded)).length === 0);

  /* ── 2. Seed people: a named member (Jasper) + an UNKNOWN cluster ──────────── */
  const jasper_pid = memory.upsert_enrolled_person({
    user_id: OWNER,
    cpai_userid: 'jasper',
    display_name: 'Jasper',
    relationship: 'self',
    add_image_count: 1,
  });
  // Location: Jasper home so presence joins.
  reset_location_cache();
  _set_cached_snapshot('jasper', { coords: { lat: 40.0001, lon: -104.8901 }, ts: new Date().toISOString(), confidence: 'high' });

  /* ── 3. The in-process router with a swappable caller tier ────────────────── */
  let current_user: { id: string; tier: string } = { id: OWNER, tier: 'owner' };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', current_user as never);
    await next();
  });
  app.route('/api/specialists', create_home_router({ db, memory, specialists: specialists_stub, users: users_stub }));

  const post_assign = (body: unknown) =>
    app.request('/api/specialists/luna/home_map/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /* ── 4. Assignment overlay (owner) — camera→room, no revision bump ────────── */
  const assignRes = await post_assign({ room_id: 'kitchen', cameras: ['Kitchen Cam'] });
  const assignBody = (await assignRes.json()) as { revision: number; rooms: Array<{ id: string; cameras: string[] }> };
  check('assign: owner POST → 200', assignRes.status === 200);
  check('assign: revision NOT bumped (overlay, not geometry)', assignBody.revision === 1);
  check('assign: kitchen now maps "Kitchen Cam"', !!assignBody.rooms.find((r) => r.id === 'kitchen')?.cameras.includes('Kitchen Cam'));
  check('assign: zone_map now derives the camera→room', derive_zone_map(store.get())['Kitchen Cam'] === 'kitchen');

  const badRoom = await post_assign({ room_id: 'no-such-room', cameras: ['X'] });
  check('assign: unknown room id → 400', badRoom.status === 400);

  /* ── 5. Household read — sanitized projection (room-named, no unknowns) ────── */
  const occRes = await app.request('/api/specialists/luna/home_occupancy?window_minutes=30');
  const occBody = (await occRes.json()) as {
    occupants: Array<{ name: string; zone: string | null; zone_id: string | null; presence: string | null }>;
    household: Array<{ name: string; presence: string }>;
    presence_available: boolean;
  };
  check('read: household GET → 200', occRes.status === 200);
  // Occupants are BLE-fed since the camera layer was removed (2026-08-04); with
  // no BLE device enrolled in this fixture the list is legitimately empty. The
  // home/away roster is the half that still derives from location.
  check('read: Jasper on the household roster, home', !!occBody.household.find((h) => h.name === 'Jasper' && h.presence === 'home'));
  check('read: presence_available true (a location fix resolved)', occBody.presence_available === true);
  check('read: NO unknown_present key in the household projection', !('unknown_present' in occBody));
  check('read: NO crop/thumb field on occupants', occBody.occupants.every((o) => !('thumb_url' in o)));

  /* ── 6. home_map read (household) ─────────────────────────────────────────── */
  const mapRes = await app.request('/api/specialists/luna/home_map');
  const mapBody = (await mapRes.json()) as { rooms: unknown[]; adjacency: unknown[]; editable: boolean };
  check('map: household GET → 200 with rooms + adjacency', mapRes.status === 200 && mapBody.rooms.length === 5 && mapBody.adjacency.length === 4);
  check('map: owner sees editable:true', mapBody.editable === true);

  /* ── 7. Tier gating ──────────────────────────────────────────────────────── */
  current_user = { id: 'kim', tier: 'friend' };
  check('gate: friend home_occupancy → 403', (await app.request('/api/specialists/luna/home_occupancy')).status === 403);
  check('gate: friend home_map → 403', (await app.request('/api/specialists/luna/home_map')).status === 403);

  current_user = { id: 'sam', tier: 'household' };
  check('gate: household CAN read occupancy (200)', (await app.request('/api/specialists/luna/home_occupancy')).status === 200);
  const hhMap = (await (await app.request('/api/specialists/luna/home_map')).json()) as { editable: boolean };
  check('gate: household sees editable:false (assign UI hidden)', hhMap.editable === false);
  check('gate: household CANNOT assign (owner-only, 403)', (await post_assign({ room_id: 'kitchen', cameras: [] })).status === 403);
  current_user = { id: OWNER, tier: 'owner' };

  /* ── 8. compose_home_pane composes the office ────────────────────────────── */
  const deps = { memory, users: users_stub, vault_root } as unknown as PaneDeps;
  const pane = await compose_home_pane(db, 'sam', deps);
  check('pane: pane_kind home', pane.pane_kind === 'home');
  const hero = pane.blocks.find((b) => b.type === 'hero_metric');
  check('pane: hero_metric present', !!hero);
  // No unknown/unrecognized person may ever render in the household office.
  const text_blob = JSON.stringify(pane.blocks);
  check('pane: no unknown/unrecognized person rendered', !/unrecognized|unknown_live|dark coat/i.test(text_blob));

  /* ── 9. Presence freshness — sticky geofence state (home anchor 40,-105) ──── */
  const NOW = Date.now();
  const near = { lat: 40.0001, lon: -104.8901 }; // ~14 m from the stub home anchor
  const far = { lat: 39.75, lon: -104.94 };
  const resolve_jasper = async () =>
    (await resolve_household_locations(users_stub, OWNER, { now_ms: NOW })).find((r) => r.user_id === 'jasper')?.presence;

  // STICKY: a 3h-old arrival AT HOME is STILL home (iOS edge events are sparse —
  // don't stale a home arrival to unknown; this was the live "everyone unknown" bug).
  reset_location_cache();
  _set_cached_snapshot('jasper', { coords: near, ts: new Date(NOW - 180 * MIN).toISOString(), confidence: 'low', kind: 'region_enter' });
  check('presence: 3h-old arrival AT HOME → home (sticky, not unknown)', (await resolve_jasper()) === 'home');

  // A departure from home → away, even with near-home coords (never read as home).
  reset_location_cache();
  _set_cached_snapshot('jasper', { coords: near, ts: new Date(NOW - 10 * MIN).toISOString(), confidence: 'high', kind: 'region_exit' });
  check('presence: departure from home → away (not home despite near coords)', (await resolve_jasper()) === 'away');

  // An arrival ELSEWHERE (far) → away.
  reset_location_cache();
  _set_cached_snapshot('jasper', { coords: far, ts: new Date(NOW - 30 * MIN).toISOString(), confidence: 'high', kind: 'visit_arrival' });
  check('presence: arrival far from home → away', (await resolve_jasper()) === 'away');

  // An arrival older than the sticky ceiling (20h > 18h) → unknown (phone may be dead).
  reset_location_cache();
  _set_cached_snapshot('jasper', { coords: near, ts: new Date(NOW - 1200 * MIN).toISOString(), confidence: 'low', kind: 'region_enter' });
  check('presence: arrival older than the sticky ceiling → unknown', (await resolve_jasper()) === 'unknown');

  // A raw transit fix (no event kind) still respects the 30-min freshness window.
  reset_location_cache();
  _set_cached_snapshot('jasper', { coords: near, ts: new Date(NOW - 60 * MIN).toISOString(), confidence: 'low' });
  check('presence: stale transit fix (no kind, 60m) → unknown', (await resolve_jasper()) === 'unknown');
  reset_location_cache();
  _set_cached_snapshot('jasper', { coords: near, ts: new Date(NOW).toISOString(), confidence: 'high' });
  check('presence: fresh transit fix near home → home', (await resolve_jasper()) === 'home');

  db.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('');
  console.log(failures === 0 ? 'smoke:home-office — all checks passed' : `smoke:home-office — ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke:home-office crashed:', err);
  process.exit(1);
});
