/**
 * seed-home-map — import the Westwood floor plan into the `home_map` store
 * (design-household-awareness-layer.md §4a; floor-plan import session,
 * 2026-06-14).
 *
 * Writes ONE owner-global row: both floors' rooms (id/name/floor/kind/polygon),
 * the room adjacency graph (incl. the inter-floor `via:'stairs'` edge), the
 * floor metadata, and `units:'ft'`. Leaves every room's cameras/ble_areas
 * EMPTY — the awareness layer (P1.5) writes that overlay; set_geometry carries
 * any existing assignment forward by id, so re-running this never wipes it.
 *
 * Geometry is Jasper's build: the LEFT-RIGHT MIRROR of the neighbor's identical
 * tract plan (3257 Westwood Ct appraisal), mirror BAKED into the polygons
 * per floor (`floors[].mirrored:true` is provenance only — topology is
 * reflection-invariant, so adjacency is as-is). Basement NOT imported (Jasper's
 * is furnished/different from the listing's unfinished one).
 *
 * Polygons are RENDER-only (the canvas backdrop). They're the locked schematic
 * rects/polygons from the design session, expressed in FEET (the design frame
 * was 12 px/ft; these are px/12). NOT a pixel-trace of the appraisal — the
 * fusion scorer never reads a polygon. Refine later, independently.
 *
 * Idempotent: re-running re-writes geometry + bumps `revision`, preserving the
 * assignment overlay. The geometry builder is EXPORTED so smoke:home-map
 * validates the real seed (single source of truth — no parallel tracked JSON).
 *
 * Honors HEARTH_DB_PATH (default ./data/hearth.db). On the LLM host, run inside the
 * container so it targets /data/db/hearth.db:
 *   docker compose exec hearth-orchestrator bun run seed:home-map
 *   docker compose exec hearth-orchestrator bun run seed:home-map --dry-run
 */
import { open_db } from '@memory/stores/structured';
import {
  HomeMapStore,
  type HomeMapGeometry,
  type RoomGeometry,
  type AdjacencyEdge,
  type RoomKind,
} from '@memory/stores/home_map';

/** Design frame → feet. The locked schematic was authored at 12 px per foot. */
const PX_PER_FT = 12;
const ft = (px: number): number => Math.round((px / PX_PER_FT) * 10) / 10;
const toFt = (poly: Array<[number, number]>): Array<[number, number]> =>
  poly.map(([x, y]) => [ft(x), ft(y)] as [number, number]);
/** Axis-aligned rectangle (design px) → CW polygon. */
const rect = (x: number, y: number, w: number, h: number): Array<[number, number]> => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

interface RoomDef {
  id: string;
  name: string;
  floor: number;
  kind: RoomKind;
  px: Array<[number, number]>;
}

// ── Floor 0 (First Floor) — mirrored, design px ────────────────────────────
const FLOOR0: RoomDef[] = [
  { id: 'living-room', name: 'Living Room', floor: 0, kind: 'room', px: rect(292, 126, 208, 163) },
  { id: 'kitchen', name: 'Kitchen', floor: 0, kind: 'room', px: rect(112, 126, 180, 163) },
  { id: 'pantry', name: 'Pantry', floor: 0, kind: 'room', px: rect(86, 234, 26, 55) },
  {
    id: 'formal-space',
    name: 'Formal Space',
    floor: 0,
    kind: 'room',
    px: [[58, 289], [206, 289], [206, 525], [176, 553], [88, 553], [58, 525]],
  },
  { id: 'jaspers-office', name: "Jasper's Office", floor: 0, kind: 'room', px: rect(347, 289, 153, 151) },
  { id: 'laundry', name: 'Laundry', floor: 0, kind: 'room', px: rect(284, 366, 63, 74) },
  { id: 'powder-1', name: 'Bath', floor: 0, kind: 'room', px: rect(284, 289, 63, 53) },
  { id: 'stairs-1', name: 'Stairs', floor: 0, kind: 'transition', px: rect(206, 289, 54, 125) },
  {
    id: 'foyer-1',
    name: 'Foyer',
    floor: 0,
    kind: 'transition',
    px: [[260, 289], [284, 289], [284, 440], [272, 440], [272, 486], [206, 486], [206, 414], [260, 414]],
  },
  { id: 'garage', name: 'Garage', floor: 0, kind: 'room', px: rect(272, 440, 351, 246) },
  // The general backyard (north side) — the "Backyard" camera's zone. Slug stays
  // 'patio' so the camera already bound to this id survives the rename; only the
  // display name + extent change (it spans the full back of the house now).
  { id: 'patio', name: 'Backyard', floor: 0, kind: 'outside', px: rect(112, 28, 388, 98) },
  { id: 'cov-porch', name: 'Cov Porch', floor: 0, kind: 'outside', px: rect(206, 486, 66, 67) },
  // East-side strip the rear-door camera sees: right of the Living Room +
  // Jasper's Office, out to the garage's right edge, up past the Living Room's
  // top-right corner.
  { id: 'rear-yard', name: 'Rear Yard', floor: 0, kind: 'outside', px: rect(500, 108, 123, 332) },
];

// ── Floor 1 (Second Floor) — mirrored, design px ───────────────────────────
const FLOOR1: RoomDef[] = [
  { id: 'bedroom-2', name: 'Bedroom 2', floor: 1, kind: 'room', px: rect(118, 48, 197, 122) },
  { id: 'loft', name: 'Loft', floor: 1, kind: 'room', px: rect(315, 48, 151, 122) },
  { id: 'guest-bath', name: 'Guest Bath', floor: 1, kind: 'room', px: rect(118, 170, 102, 76) },
  { id: 'linen-1', name: 'Linen Closet', floor: 1, kind: 'transition', px: rect(118, 246, 102, 48) },
  {
    id: 'hall-up',
    name: 'Hall',
    floor: 1,
    kind: 'transition',
    // U around the stairwell + open foyer: landing band + both side halls.
    px: [[220, 170], [424, 170], [424, 294], [346, 294], [346, 198], [268, 198], [268, 294], [220, 294]],
  },
  { id: 'stairs-2', name: 'Stairs', floor: 1, kind: 'transition', px: rect(268, 198, 78, 96) },
  { id: 'open-foyer', name: 'Open Foyer', floor: 1, kind: 'transition', px: rect(268, 294, 78, 168) },
  { id: 'primary-bath', name: 'Primary Bath', floor: 1, kind: 'room', px: rect(424, 170, 138, 124) },
  { id: 'sam-office', name: "Sam's Office", floor: 1, kind: 'room', px: rect(118, 294, 150, 168) },
  { id: 'en-suite', name: 'En Suite', floor: 1, kind: 'room', px: rect(346, 294, 156, 168) },
  { id: 'primary-closet', name: 'Closet', floor: 1, kind: 'transition', px: rect(502, 294, 60, 168) },
];

const edge = (a: string, b: string, via: AdjacencyEdge['via']): AdjacencyEdge => ({ a, b, via });

/** Build the full HomeMap geometry (mirror baked, units:'ft'). Exported so the
 *  smoke validates the SAME data the seed writes. */
export function build_home_map_geometry(): HomeMapGeometry {
  const rooms: RoomGeometry[] = [...FLOOR0, ...FLOOR1].map((r) => ({
    id: r.id,
    name: r.name,
    floor: r.floor,
    kind: r.kind,
    polygon: toFt(r.px),
  }));

  const adjacency: AdjacencyEdge[] = [
    // ── Floor 0 ──
    edge('living-room', 'kitchen', 'open'),
    edge('kitchen', 'pantry', 'doorway'),
    edge('kitchen', 'formal-space', 'open'),
    edge('living-room', 'formal-space', 'open'), // open great-room: living+kitchen+dining one volume
    edge('formal-space', 'foyer-1', 'open'),
    edge('formal-space', 'stairs-1', 'open'),
    edge('foyer-1', 'stairs-1', 'open'),
    edge('foyer-1', 'jaspers-office', 'doorway'),
    edge('foyer-1', 'powder-1', 'doorway'),
    edge('foyer-1', 'cov-porch', 'doorway'),
    edge('laundry', 'garage', 'doorway'), // garage→house mudroom entry
    edge('laundry', 'foyer-1', 'doorway'),
    edge('living-room', 'patio', 'doorway'),
    edge('rear-yard', 'living-room', 'doorway'), // rear door off the great room → the strip the rear-door cam sees
    // ── Floor 1 ──
    edge('stairs-2', 'hall-up', 'open'),
    edge('hall-up', 'loft', 'open'),
    edge('hall-up', 'bedroom-2', 'doorway'),
    edge('hall-up', 'guest-bath', 'doorway'),
    edge('hall-up', 'linen-1', 'doorway'),
    edge('hall-up', 'sam-office', 'doorway'),
    edge('hall-up', 'en-suite', 'doorway'),
    edge('en-suite', 'primary-bath', 'doorway'),
    edge('en-suite', 'primary-closet', 'doorway'),
    edge('open-foyer', 'hall-up', 'open'),
    // ── Inter-floor (the no-teleport gate's only cross-floor edge) ──
    edge('stairs-1', 'stairs-2', 'stairs'),
    // NOTE: sam-office and en-suite are deliberately NOT adjacent — the
    // two-story open foyer splits them.
  ];

  return {
    rooms,
    adjacency,
    floors: [
      { level: 0, name: 'First Floor', mirrored: true },
      { level: 1, name: 'Second Floor', mirrored: true },
    ],
    units: 'ft',
  };
}

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry-run');
  const geometry = build_home_map_geometry();

  // Integrity: every adjacency endpoint must reference a real room id.
  const ids = new Set(geometry.rooms.map((r) => r.id));
  const dangling = geometry.adjacency.filter((e) => !ids.has(e.a) || !ids.has(e.b));
  if (dangling.length > 0) {
    console.error('Dangling adjacency endpoints:', dangling);
    process.exit(1);
  }

  console.log(
    `home_map: ${geometry.rooms.length} rooms across ${geometry.floors.length} floors, ` +
      `${geometry.adjacency.length} edges (${geometry.adjacency.filter((e) => e.via === 'stairs').length} inter-floor), units=${geometry.units}`,
  );

  if (dry) {
    console.log('\n--dry-run — not writing. Geometry:\n');
    console.log(JSON.stringify(geometry, null, 2));
    return;
  }

  const db_path = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
  const db = open_db(db_path);
  try {
    const store = new HomeMapStore(db);
    const before = store.get();
    const result = store.set_geometry(geometry);
    console.log(
      `\nSeeded home_map → ${db_path}  (revision ${before.revision} → ${result.revision}, ` +
        `${result.rooms.filter((r) => r.cameras.length > 0 || r.ble_areas.length > 0).length} rooms carry an existing assignment overlay)`,
    );
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  void main();
}
