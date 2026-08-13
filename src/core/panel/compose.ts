/**
 * Pane composition for the guest panel.
 *
 * The client never decides what a room offers — this does, from HA's area map
 * plus live state. A tile exists because an entity exists, is alive, and suits
 * the time of day. That keeps every panel surface (web today, a slab later)
 * honest against one composer instead of each re-deciding what a room means.
 */
import {
  fetch_ha_all_states,
  fetch_ha_area_map,
  type HAEntityState,
} from '@connectors/home_assistant';
import { local_hhmm } from '@core/time';
import { ROOMS, ROOM_ORDER, HOUSE_TEMP, OUTDOOR_TEMP, type RoomConfig } from './rooms';

export type Phase = 'morning' | 'afternoon' | 'evening' | 'night';

export type Tile = {
  entity_id: string;
  /**
   * What a tap MEANS, decided here rather than inferred from the domain.
   *
   * - `toggle`   — flip it (light, switch, fan)
   * - `activate` — fire it once (scene, play/pause)
   * - `open`     — this tile is a DOOR to a client surface named by `opens`
   *
   * A client that does not implement a given `opens` target must degrade
   * rather than break: `open` entities stay in the actuation allowlist, so the
   * web panel (which has no media surface yet) still play/pauses them. Same
   * instinct as the QR parity rule — render what you can, hand off what you
   * can't, never show a dead control.
   */
  kind: 'toggle' | 'activate' | 'open';
  icon: string;
  label: string;
  sub: string;
  on: boolean;
  urgent?: boolean;
  /** Only on `kind: 'open'`. The client surface this tile leads to. */
  opens?: 'media';
};

export type Pane = {
  room: string;
  phase: Phase;
  tiles: Tile[];
  temps: { outside: string | null; house: string | null; room: string | null };
};

export type Snapshot = {
  states: Map<string, HAEntityState>;
  by_entity_area: Map<string, string>;
  at: number;
};

const TILE_DOMAINS = new Set(['light', 'switch', 'fan', 'scene', 'media_player']);

/**
 * A scene's state is the timestamp it was last activated, so a scene that has
 * not fired since the last HA restart sits at "unknown" indefinitely — which
 * is ALL 46 Hue scenes in this house right now. Treating that as dead deletes
 * every scene button in the panel, including `scene.half_bath_red_night`.
 * Only "unavailable" means gone (~320 of 1047 entities genuinely are).
 */
function is_usable(s: HAEntityState | undefined): s is HAEntityState {
  if (!s) return false;
  if (s.state === 'unavailable') return false;
  if (s.entity_id.startsWith('scene.')) return true;
  return s.state !== 'unknown';
}

// ── snapshot cache ────────────────────────────────────────────────────────
//
// Every connected panel polls; without this each one would drag a full
// /api/states dump out of HA on its own schedule. One cached read serves all
// of them, so HA load is bounded by the TTL, not by guest count.

let cached: Snapshot | null = null;
let inflight: Promise<Snapshot | null> | null = null;

const STATES_TTL_MS = 3_000;
/** Areas change when a device is re-homed — minutes-stale is fine. */
const AREAS_TTL_MS = 300_000;
let areas_at = 0;
let areas_cache: Map<string, string> = new Map();

export async function get_snapshot(): Promise<Snapshot | null> {
  const now = Date.now();
  if (cached && now - cached.at < STATES_TTL_MS) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    const states_res = await fetch_ha_all_states();
    if (!states_res.ok) return cached; // serve the last good read rather than blanking the panel

    if (now - areas_at > AREAS_TTL_MS) {
      const areas_res = await fetch_ha_area_map();
      if (areas_res.ok) {
        areas_cache = areas_res.by_entity;
        areas_at = now;
      }
    }

    const states = new Map<string, HAEntityState>();
    for (const s of states_res.states) states.set(s.entity_id, s);
    cached = { states, by_entity_area: areas_cache, at: Date.now() };
    return cached;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

// ── tile shaping ──────────────────────────────────────────────────────────

function icon_for(entity_id: string, label: string): string {
  const domain = entity_id.split('.')[0];
  const n = `${entity_id} ${label}`.toLowerCase();
  if (domain === 'fan') return 'fan';
  if (domain === 'media_player') return /theater|ht_a9|marantz|cinema/.test(n) ? 'film' : 'music';
  if (domain === 'scene') {
    if (/night|dim|red/.test(n)) return 'moon';
    if (/bright|energize/.test(n)) return 'sun';
    return 'scene';
  }
  if (/porch|outdoor|sconce|foyer/.test(n)) return 'door';
  return 'bulb';
}

/** Scene name fragments worth surfacing, most-wanted first, per time of day. */
const SCENE_RANK: Record<Phase, string[]> = {
  morning: ['bright', 'energize', 'read', 'concentrate'],
  afternoon: ['bright', 'read', 'concentrate', 'relax'],
  evening: ['relax', 'dimmed', 'soho', 'read', 'bright'],
  night: ['nightlight', 'red_night', 'dimmed', 'relax'],
};

/**
 * Lower sorts first. A room's `scene_priority` outranks the time-of-day
 * ranking entirely — a pinned scene is one the room is *for*, and it should not
 * drop off the pane at 9pm because the evening list prefers something else.
 */
function scene_score(entity_id: string, phase: Phase, pinned: string[] = []): number {
  const pin = pinned.indexOf(entity_id);
  if (pin >= 0) return -1000 + pin;

  const wanted = SCENE_RANK[phase];
  for (let i = 0; i < wanted.length; i++) if (entity_id.includes(wanted[i]!)) return i;
  return wanted.length + 1;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_');

/**
 * "scene.basement_nightlight" -> "Nightlight". A scene's own area is not always
 * the room it is pinned to (basement scenes show in the Game Area), so strip
 * whichever area name the id actually starts with, longest first.
 */
function pretty_scene(entity_id: string, area_names: string[]): string {
  let tail = entity_id.split('.')[1] ?? entity_id;
  const prefixes = area_names.map(slug).sort((a, b) => b.length - a.length);
  for (const p of prefixes) {
    if (tail.startsWith(`${p}_`)) {
      tail = tail.slice(p.length + 1);
      break;
    }
  }
  const words = tail.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function sub_for(s: HAEntityState): string {
  const domain = s.entity_id.split('.')[0];
  if (domain === 'scene') return 'Hue scene';
  if (domain === 'fan') return s.state === 'on' ? 'Running' : 'Off';
  if (domain === 'media_player') {
    const name = (s.attributes.friendly_name as string) ?? s.entity_id;
    if (s.state === 'playing') return `Playing · ${name}`;
    return `${s.state === 'off' ? 'Off' : 'Idle'} · ${name}`;
  }
  return s.state === 'on' ? 'On' : 'Off';
}

function candidates_for(cfg: RoomConfig, snap: Snapshot): string[] {
  const exclude = new Set(cfg.exclude ?? []);
  const in_area: string[] = [];
  for (const [entity_id, area] of snap.by_entity_area) {
    if (area === cfg.area && TILE_DOMAINS.has(entity_id.split('.')[0]!)) in_area.push(entity_id);
  }
  const all = [...new Set([...in_area, ...(cfg.extras ?? [])])];
  return all.filter((id) => !exclude.has(id));
}

/**
 * A weather station that stops reporting does NOT go `unavailable` — HA keeps
 * serving its last reading, forever. Preferring the on-site Tempest over the
 * forecast is only right while the Tempest is actually alive, so a source that
 * hasn't updated inside this window is skipped in favour of the next one.
 * The Tempest reports about once a minute; 20 minutes is dead, not quiet.
 */
const TEMP_STALE_MS = 20 * 60_000;

function fresh_enough(s: HAEntityState, window_ms = TEMP_STALE_MS): boolean {
  const at = s.last_updated ?? s.last_changed;
  if (!at) return true; // no timestamp to judge by — trust the value
  const t = Date.parse(at);
  return !Number.isFinite(t) || Date.now() - t < window_ms;
}

/** First source that is alive, fresh and numeric. Order is the preference. */
function temp_of(snap: Snapshot, source: string | readonly string[] | undefined): string | null {
  if (!source) return null;
  for (const entity_id of typeof source === 'string' ? [source] : source) {
    const s = snap.states.get(entity_id);
    if (!is_usable(s) || !fresh_enough(s)) continue;
    const n = Number(s.state);
    if (Number.isFinite(n)) return `${n.toFixed(1).replace(/\.0$/, '')}°`;
  }
  return null;
}

export function phase_now(d = new Date()): Phase {
  // Denver wall clock, not the host's — in a UTC container getHours() put
  // every evening pane six hours ahead. (% 24: en-GB renders midnight as 24.)
  const h = Number(local_hhmm(d).slice(0, 2)) % 24;
  return h < 11 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
}

export function compose_pane(room: string, phase: Phase, snap: Snapshot): Pane {
  const cfg = ROOMS[room];
  if (!cfg) throw new Error(`unknown room: ${room}`);

  const dark = phase === 'night' || phase === 'evening';
  const urgent_set = new Set(cfg.urgent_when_off_at_night ?? []);
  const area_names = [...new Set(snap.by_entity_area.values())];

  const toggles: Tile[] = [];
  const scenes: (Tile & { score: number })[] = [];
  const media: Tile[] = [];

  for (const entity_id of candidates_for(cfg, snap)) {
    const s = snap.states.get(entity_id);
    if (!is_usable(s)) continue;

    const domain = entity_id.split('.')[0];
    const friendly = (s.attributes.friendly_name as string) ?? entity_id;
    const label = cfg.labels?.[entity_id] ?? friendly;

    if (domain === 'scene') {
      scenes.push({
        entity_id,
        kind: 'activate',
        icon: icon_for(entity_id, label),
        label: cfg.labels?.[entity_id] ?? pretty_scene(entity_id, area_names),
        sub: 'Hue scene',
        on: false,
        score: scene_score(entity_id, phase, cfg.scene_priority),
      });
    } else if (domain === 'media_player') {
      const is_door = cfg.media_surface === entity_id;
      media.push({
        entity_id,
        kind: is_door ? 'open' : 'activate',
        ...(is_door ? { opens: 'media' as const } : {}),
        icon: icon_for(entity_id, label),
        // Half the speakers in this house are named after a room they are not
        // in, so the button says where YOU are and the real name goes in the
        // subtitle where it can't mislead a tap.
        label: cfg.labels?.[entity_id] ?? (is_door ? 'Watch something' : 'Play music in here'),
        // A door says where it leads; a play button says what it is playing.
        sub: is_door ? 'Plex, and the Apple TV remote' : sub_for(s),
        on: s.state === 'playing',
      });
    } else {
      const on = s.state === 'on';
      toggles.push({
        entity_id,
        kind: 'toggle',
        icon: icon_for(entity_id, label),
        label,
        sub: sub_for(s),
        on,
        urgent: dark && !on && urgent_set.has(entity_id),
      });
    }
  }

  scenes.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
  // The door outranks the speakers: only two media tiles survive the slice
  // below, and the room's own media surface must not be the one dropped.
  media.sort((a, b) => Number(b.kind === 'open') - Number(a.kind === 'open'));
  toggles.sort((a, b) => Number(!!b.urgent) - Number(!!a.urgent) || a.label.localeCompare(b.label));

  const tiles: Tile[] = [
    ...toggles.filter((t) => t.urgent),
    ...scenes.slice(0, 3).map(({ score: _score, ...t }) => t),
    ...toggles.filter((t) => !t.urgent).slice(0, 4),
    ...media.slice(0, 2),
  ];

  return {
    room,
    phase,
    tiles,
    temps: {
      outside: temp_of(snap, OUTDOOR_TEMP),
      house: temp_of(snap, HOUSE_TEMP),
      room: temp_of(snap, cfg.temp_sensor),
    },
  };
}

export function room_list(): string[] {
  return ROOM_ORDER;
}

// ── where is this panel? ──────────────────────────────────────────────────

/**
 * HA area name → the panel room that draws from it, or null.
 *
 * Null is a real answer and must stay one: HA has areas the panel has no room
 * for (`Basement` holds the game area's scenes and thermometer, `Primary
 * Bedroom` is not a guest space at all). A device sitting in one of those gets
 * NO suggestion rather than the nearest guess — the panel would rather say
 * nothing than move a guest to the wrong room.
 */
export function room_for_area(area: string): string | null {
  const want = area.trim();
  if (!want) return null;
  for (const [room, cfg] of Object.entries(ROOMS)) if (cfg.area === want) return room;
  return null;
}

/** Presence older than this is a memory, not a location. */
const PRESENCE_STALE_MS = 5 * 60_000;

/**
 * Which room the panel appears to be in, per Bermuda BLE trilateration.
 *
 * Bermuda already does the hard part: its `device_tracker.*` entities carry an
 * `area` attribute resolved from BLE proxies around the house. So the device
 * only has to ADVERTISE — it never scans, never holds a beacon map, and never
 * learns the floor plan. Same rule as everything else here: the house works out
 * where you are, the panel just draws it.
 *
 * Inert until `HEARTH_PANEL_TRACKER` names the panel's tracker entity, read at
 * call time so re-pointing it needs no restart.
 *
 * ⚠ Room-level resolution needs roughly one BLE proxy per area. The house
 * currently runs ONE, so every device resolves to that proxy's area today.
 */
export function suggest_room(snap: Snapshot): { room: string; source: 'bermuda' } | null {
  const tracker = (process.env.HEARTH_PANEL_TRACKER ?? '').trim();
  if (!tracker) return null;

  const s = snap.states.get(tracker);
  if (!is_usable(s) || s.state !== 'home') return null;
  if (!fresh_enough(s, PRESENCE_STALE_MS)) return null;

  const room = room_for_area(String(s.attributes.area ?? ''));
  return room ? { room, source: 'bermuda' } : null;
}

/**
 * Every entity the panel can actuate, across all rooms and phases — the
 * allowlist the router enforces. A guest may only touch what the composer
 * actually put on a tile, which leaves the garage door, the car lock and 163
 * other switches unreachable by construction rather than by a deny-list
 * somebody has to maintain.
 */
export function actuable_entities(snap: Snapshot): Set<string> {
  const ids = new Set<string>();
  const phases: Phase[] = ['morning', 'afternoon', 'evening', 'night'];
  for (const room of ROOM_ORDER) {
    for (const phase of phases) {
      for (const t of compose_pane(room, phase, snap).tiles) ids.add(t.entity_id);
    }
  }
  return ids;
}
