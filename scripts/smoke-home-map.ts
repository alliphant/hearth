/**
 * smoke:home-map — self-contained test of the HomeMapStore + the real seed
 * (design-household-awareness-layer.md §4a). Temp SQLite db, no orchestrator.
 *
 * Asserts:
 *   - empty store → 0 rooms, revision 0;
 *   - set_geometry seeds the singleton row, bumps revision, persists + re-parses;
 *   - the real seed's topology: the inter-floor stairs-1–stairs-2 via:'stairs'
 *     edge (the no-teleport chokepoint), sam-office ✗ en-suite NON-edge (the
 *     open foyer splits them), the living-room–formal-space great-room edge, and
 *     no dangling adjacency endpoints;
 *   - kind values are all in the {room,transition,outside} enum;
 *   - derive_zone_map flattens rooms[].cameras → Record<camera,room>;
 *   - set_assignments writes the overlay WITHOUT bumping revision, throws on an
 *     unknown id, and is CARRIED FORWARD across a geometry re-import.
 *
 *   bun run smoke:home-map
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import {
  HomeMapStore,
  derive_zone_map,
  adjacency_index,
  type RoomKind,
} from '@memory/stores/home_map';
import { build_home_map_geometry } from './seed-home-map';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-homemap-'));
const db = open_db(join(dir, 'smoke.db'));

try {
  const store = new HomeMapStore(db);

  // 1 — empty store.
  {
    const m = store.get();
    check('empty store → 0 rooms', m.rooms.length === 0);
    check('empty store → revision 0', m.revision === 0);
    check('empty store → units default ft', m.units === 'ft');
  }

  // 2 — seed the real geometry.
  const geometry = build_home_map_geometry();
  {
    const r = store.set_geometry(geometry);
    check('set_geometry → revision 1', r.revision === 1);
    check('seeded 24 rooms', r.rooms.length === 24);
    check('seeded 2 floors', r.floors.length === 2);
    check('floors mirrored:true (provenance)', r.floors.every((f) => f.mirrored === true));
    check('units ft', r.units === 'ft');
    check('every room cameras/ble_areas empty at seed', r.rooms.every((x) => x.cameras.length === 0 && x.ble_areas.length === 0));
    check('polygons in ft (kitchen first point ~9.3)', Math.abs((r.rooms.find((x) => x.id === 'kitchen')?.polygon[0]?.[0] ?? 0) - 9.3) < 0.2);
  }

  // 3 — persists + re-parses from JSON.
  {
    const m = store.get();
    check('re-read persists 24 rooms', m.rooms.length === 24);
    check('re-read revision 1', m.revision === 1);
    const enSuite = m.rooms.find((x) => x.id === 'en-suite');
    check('en-suite present, kind room, floor 1', enSuite?.kind === 'room' && enSuite?.floor === 1);
    const KINDS = new Set<RoomKind>(['room', 'transition', 'outside']);
    check('all kinds in enum', m.rooms.every((x) => KINDS.has(x.kind)));
    check('outside rooms present (patio, cov-porch, rear-yard)', m.rooms.filter((x) => x.kind === 'outside').length === 3);
    check('open-foyer is a transition', m.rooms.find((x) => x.id === 'open-foyer')?.kind === 'transition');
  }

  // 4 — topology: the part the fusion scorer actually consumes.
  {
    const m = store.get();
    const ids = new Set(m.rooms.map((r) => r.id));
    const dangling = m.adjacency.filter((e) => !ids.has(e.a) || !ids.has(e.b));
    check('no dangling adjacency endpoints', dangling.length === 0);

    const stairsEdges = m.adjacency.filter((e) => e.via === 'stairs');
    check('exactly one inter-floor stairs edge', stairsEdges.length === 1);
    check('inter-floor edge joins stairs-1 ↔ stairs-2', stairsEdges.some((e) => (e.a === 'stairs-1' && e.b === 'stairs-2') || (e.a === 'stairs-2' && e.b === 'stairs-1')));

    const idx = adjacency_index(m);
    check('stairs-1 neighbors include stairs-2 (no-teleport chokepoint)', idx.get('stairs-1')?.has('stairs-2') === true);
    check('sam-office ✗ en-suite (open foyer splits them)', idx.get('en-suite')?.has('sam-office') !== true);
    check('living-room ↔ formal-space (open great-room edge)', idx.get('living-room')?.has('formal-space') === true);
    check('living-room ↔ kitchen', idx.get('living-room')?.has('kitchen') === true);
    check('laundry ↔ garage (mudroom entry)', idx.get('laundry')?.has('garage') === true);
    check('rear-yard is outside + adjacent to living-room (rear-door cam zone)', m.rooms.find((x) => x.id === 'rear-yard')?.kind === 'outside' && idx.get('rear-yard')?.has('living-room') === true);
  }

  // 5 — derive_zone_map: empty until cameras assigned.
  {
    const m = store.get();
    check('zone_map empty before any camera assignment', Object.keys(derive_zone_map(m)).length === 0);
  }

  // 6 — set_assignments: overlay write, no revision bump.
  {
    const r = store.set_assignments('kitchen', { cameras: ['Kitchen Cam'], ble_areas: ['ha.kitchen'] });
    check('set_assignments does NOT bump revision', r.revision === 1);
    const zm = derive_zone_map(r);
    check('zone_map now maps Kitchen Cam → kitchen', zm['Kitchen Cam'] === 'kitchen');
    let threw = false;
    try {
      store.set_assignments('no-such-room', { cameras: ['x'] });
    } catch {
      threw = true;
    }
    check('set_assignments throws on unknown room id', threw);
  }

  // 7 — re-import geometry preserves the assignment overlay (carry-forward by id).
  {
    const r = store.set_geometry(geometry);
    check('re-import → revision 2', r.revision === 2);
    const kitchen = r.rooms.find((x) => x.id === 'kitchen');
    check('kitchen camera assignment carried forward across re-import', kitchen?.cameras[0] === 'Kitchen Cam');
    check('kitchen ble area carried forward', kitchen?.ble_areas[0] === 'ha.kitchen');
    check('other rooms still empty after re-import', r.rooms.filter((x) => x.cameras.length > 0).length === 1);
  }
} finally {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll home_map smoke checks passed.');
