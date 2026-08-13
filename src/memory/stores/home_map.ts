/**
 * HomeMapStore — the home's room map: geometry + topology for the Household
 * Awareness Layer (design-household-awareness-layer.md §4a). The SHARED
 * contract between the floor-plan IMPORT session (writes rooms/adjacency/floors)
 * and the awareness layer (writes the rooms[i].cameras/ble_areas overlay).
 *
 * ONE owner-global row per house (singleton, id = 1): a `config_json` blob + a
 * monotonic `revision` + `updated_at` — the same single-row-merged shape as
 * codeshop_settings.ts / presence_zones.ts. The table is created in this store's
 * constructor (CREATE TABLE IF NOT EXISTS), NOT the central SCHEMA_SQL —
 * self-contained, additive, no SCHEMA_VERSION bump.
 *
 * WRITE SPLIT — the two sessions never collide on this file. This file has ONE
 * author (the import session); the awareness layer CALLS its methods rather than
 * editing it:
 *   - set_geometry()    — import session: rooms (id/name/floor/kind/polygon),
 *                         adjacency, floors, units. Bumps `revision`. PRESERVES
 *                         each room's cameras/ble_areas by id, so a re-import of
 *                         geometry never wipes the assignment overlay.
 *   - set_assignments() — awareness layer: one room's cameras/ble_areas. Does
 *                         NOT bump `revision` (an overlay edit, not geometry).
 *
 * UNITS: `units` declares the polygon frame ('ft' here). Polygons are
 * RENDER-ONLY (the canvas backdrop) — the fusion scorer runs on adjacency +
 * kind + floor, never on a polygon. The per-floor left-right mirror is baked
 * into the polygons at import (`floors[].mirrored` is provenance only; topology
 * is reflection-invariant, so adjacency imports as-is).
 *
 * NEVER LLM-readable; owner/household-gated at the consuming route. No secrets.
 */
import { Database } from 'bun:sqlite';

export type RoomKind = 'room' | 'transition' | 'outside';
export type AdjacencyVia = 'doorway' | 'open' | 'stairs';
export type MapUnits = 'ft' | 'm' | 'px';

export interface Room {
  /** Stable slug, unique house-wide: 'kitchen', 'en-suite', 'stairs-1'. */
  id: string;
  name: string;
  /** 0 ground, 1 up, -1 basement. */
  floor: number;
  /** transition = hall/stairs/landing/open-void; outside = yard/deck/patio. */
  kind: RoomKind;
  /** RENDER-only, his-house-correct (mirror already applied). */
  polygon: Array<[number, number]>;
  /** Protect camera names that see this room (0..n) — the awareness layer writes. */
  cameras: string[];
  /** HA area names / node ids that map here (0..n) — the awareness layer writes. */
  ble_areas: string[];
}

/** Undirected; 'stairs' = inter-floor (the no-teleport gate's only cross-floor edge). */
export interface AdjacencyEdge {
  a: string;
  b: string;
  via: AdjacencyVia;
}

/** `mirrored` is provenance; geometry is already baked his-house-correct. */
export interface FloorMeta {
  level: number;
  name: string;
  mirrored: boolean;
}

export interface HomeMap {
  rooms: Room[];
  adjacency: AdjacencyEdge[];
  floors: FloorMeta[];
  units: MapUnits;
}

/** get() returns the map plus its row metadata. */
export interface StoredHomeMap extends HomeMap {
  revision: number;
  updated_at: string;
}

export const EMPTY_HOME_MAP: HomeMap = { rooms: [], adjacency: [], floors: [], units: 'ft' };

/** The geometry an import writes — rooms WITHOUT the overlay fields. The store
 *  fills cameras/ble_areas, carrying forward any existing assignment by id. */
export type RoomGeometry = Omit<Room, 'cameras' | 'ble_areas'>;
export interface HomeMapGeometry {
  rooms: RoomGeometry[];
  adjacency: AdjacencyEdge[];
  floors: FloorMeta[];
  units: MapUnits;
}

export class HomeMapStore {
  constructor(private db: Database) {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS home_map (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         config_json TEXT NOT NULL,
         revision INTEGER NOT NULL DEFAULT 0,
         updated_at TEXT NOT NULL
       )`,
    );
  }

  /** The whole map (empty + revision 0 if never seeded). */
  get(): StoredHomeMap {
    const row = this.db
      .prepare(`SELECT config_json, revision, updated_at FROM home_map WHERE id = 1`)
      .get() as { config_json: string; revision: number; updated_at: string } | undefined;
    if (!row) return { ...EMPTY_HOME_MAP, revision: 0, updated_at: '' };
    try {
      const map = JSON.parse(row.config_json) as Partial<HomeMap>;
      return {
        rooms: Array.isArray(map.rooms) ? map.rooms : [],
        adjacency: Array.isArray(map.adjacency) ? map.adjacency : [],
        floors: Array.isArray(map.floors) ? map.floors : [],
        units: map.units ?? 'ft',
        revision: row.revision,
        updated_at: row.updated_at,
      };
    } catch {
      return { ...EMPTY_HOME_MAP, revision: row.revision, updated_at: row.updated_at };
    }
  }

  private _write(map: HomeMap, revision: number): StoredHomeMap {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO home_map (id, config_json, revision, updated_at)
           VALUES (1, @json, @rev, @now)
         ON CONFLICT(id) DO UPDATE SET config_json = @json, revision = @rev, updated_at = @now`,
      )
      .run({ '@json': JSON.stringify(map), '@rev': revision, '@now': now });
    return { ...map, revision, updated_at: now };
  }

  /**
   * Import session: replace the geometry (rooms + adjacency + floors + units)
   * and bump `revision`. Existing cameras/ble_areas are CARRIED FORWARD by room
   * id, so re-importing geometry never wipes the awareness layer's overlay;
   * new/renamed ids start with empty assignments.
   */
  set_geometry(geometry: HomeMapGeometry): StoredHomeMap {
    const prev = this.get();
    const overlay = new Map(prev.rooms.map((r) => [r.id, { cameras: r.cameras, ble_areas: r.ble_areas }]));
    const rooms: Room[] = geometry.rooms.map((r) => {
      const kept = overlay.get(r.id);
      return { ...r, cameras: kept?.cameras ?? [], ble_areas: kept?.ble_areas ?? [] };
    });
    const map: HomeMap = {
      rooms,
      adjacency: geometry.adjacency,
      floors: geometry.floors,
      units: geometry.units,
    };
    return this._write(map, prev.revision + 1);
  }

  /**
   * Awareness layer: set a room's camera/BLE assignment overlay. Does NOT bump
   * `revision` (an overlay edit, not geometry). Throws on an unknown room id so
   * a typo'd slug surfaces instead of silently no-op'ing.
   */
  set_assignments(room_id: string, overlay: { cameras?: string[]; ble_areas?: string[] }): StoredHomeMap {
    const cur = this.get();
    const room = cur.rooms.find((r) => r.id === room_id);
    if (!room) throw new Error(`home_map: unknown room id ${JSON.stringify(room_id)}`);
    if (overlay.cameras !== undefined) room.cameras = overlay.cameras;
    if (overlay.ble_areas !== undefined) room.ble_areas = overlay.ble_areas;
    const map: HomeMap = { rooms: cur.rooms, adjacency: cur.adjacency, floors: cur.floors, units: cur.units };
    return this._write(map, cur.revision); // same revision — overlay, not geometry
  }
}

/**
 * Flatten rooms[].cameras → the `Record<camera_name, room_id>` zone_map that
 * MemoryClient.get_household_occupancy() consumes (§4a — "the flat zone_map is
 * derived from rooms[].cameras"). Empty until the awareness layer assigns
 * cameras. Pure; no store dependency.
 */
export function derive_zone_map(map: HomeMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const room of map.rooms) {
    for (const cam of room.cameras) out[cam] = room.id;
  }
  return out;
}

/**
 * Undirected neighbor index (room id → set of neighbor ids) for the §5 fusion
 * scorer's no-teleport gate. Inter-floor `stairs` edges are included like any
 * other — a track may transition between the two stair nodes. Pure.
 */
export function adjacency_index(map: HomeMap): Map<string, Set<string>> {
  const idx = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    let set = idx.get(a);
    if (!set) {
      set = new Set<string>();
      idx.set(a, set);
    }
    set.add(b);
  };
  for (const e of map.adjacency) {
    add(e.a, e.b);
    add(e.b, e.a);
  }
  return idx;
}
