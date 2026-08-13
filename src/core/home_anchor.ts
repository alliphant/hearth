/**
 * home_anchor — the ONE definition of "is the user home?" (2026-07-26).
 *
 * WHY THIS MODULE EXISTS. Three call sites independently decided home/away by
 * string-matching a client-supplied `place_id` against `'home'`:
 *   - `detect_home_edge`   (reactive_triggers.ts) — wakes Kate on a home edge
 *   - `compute_is_home`    (routes/sensors.ts)    — the `is_home` derived signal
 *   - `resolve_presence`   (delivery_window.ts)   — the push presence gate
 *
 * All three were STRUCTURALLY DEAD. Live iOS location payloads do not carry
 * `place_id` at all: of 4,723 location packets, the `visit_arrival` /
 * `visit_departure` events (528 of them — the ones that actually mark arriving
 * and leaving) carry only `{ kind, lat, lng, horizontal_accuracy_m, motion, ts }`.
 * `place_id` appears on exactly 3 packets in the entire history, all
 * `region_enter` from 2026-06-19. So `(place_id ?? '').toLowerCase() === 'home'`
 * was false on every real arrival, forever: 528 real arrivals/departures
 * produced ZERO home edges, and Kate was never once woken by the world.
 * (Verified 2026-07-26: every non-`trainer` `reactive_trigger_fired` audit row
 * carries `dedupe_key: home_*:manual` — the `fire_trigger` test endpoint. Not
 * one organic fire.)
 *
 * THE FIX: resolve the place SERVER-side from the coordinates every packet
 * already carries, against the home anchor we already know
 * (`UserRegistry.home_coords` ← config/users.yaml `home_location`, the same
 * anchor the away-monitor + household-awareness layer resolve presence with).
 * The `place_id` path is KEPT as a first-class fast path — when the geofence
 * does fire it is the higher-confidence signal (an OS-level region crossing,
 * not a point-in-circle test on a possibly-coarse fix).
 *
 * Everything here is PURE — the caller resolves the anchor and passes it in, so
 * a smoke drives the whole matrix with no DB, no vault, and no clock.
 */

import { haversine_m } from './geo';

/** A home anchor: the coordinates of a user's home, from config/users.yaml. */
export interface HomeAnchor {
  lat: number;
  lng: number;
}

/** Resolves a user's home anchor. `UserRegistry.home_coords` satisfies it.
 *  Returns null when no anchor is configured — callers must degrade to the
 *  `place_id` path rather than guessing a location. */
export type HomeAnchorResolver = (user_id: string) => HomeAnchor | null;

/**
 * Within this many metres of the anchor counts as "at home". Read at CALL time
 * (not module load) so a test can set it without import-order games. Matches
 * the away-monitor + `resolve_household_locations` so "home" means the same
 * thing system-wide, and matches the `radius_m: 180` the `/api/sensors/places/monitored`
 * home region hands iOS — the geofence and the proximity test agree by construction.
 */
export function home_radius_m(): number {
  const raw = Number(process.env.HEARTH_HOME_RADIUS_M ?? '180');
  return Number.isFinite(raw) && raw > 0 ? raw : 180;
}

/** iOS edge-event kinds that mean "arrived / is at a place" (sticky). */
const ARRIVAL_KINDS = new Set(['visit_arrival', 'region_enter']);
/** iOS edge-event kinds that mean "left a place". */
const DEPARTURE_KINDS = new Set(['visit_departure', 'region_exit']);

/** The `place_id` value iOS reports for the home region served by
 *  `/api/sensors/places/monitored` (it hands back `id: 'home'`). */
const HOME_PLACE_IDS = new Set(['home']);

/** Point-in-circle against the home anchor. Fail-closed on a missing anchor or
 *  non-finite coords — an unknown location is never guessed as home. */
export function at_home(
  lat: number | null | undefined,
  lng: number | null | undefined,
  anchor: HomeAnchor | null | undefined,
  radius_m: number = home_radius_m(),
): boolean {
  if (!anchor) return false;
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return haversine_m(lat, lng, anchor.lat, anchor.lng) <= radius_m;
}

/** The location-packet fields this module reads. Structurally a subset of both
 *  `LocationPacketPayloadShape` (memory/client) and `LocationSnapshot`
 *  (location_awareness), so either can be passed without adaptation. */
export interface HomeTransitionInput {
  kind: string | null | undefined;
  lat?: number | null;
  lng?: number | null;
  place_id?: string | null;
}

/** Which real-world move produced the transition — lets a caller word an
 *  honest reason string instead of asserting "left home" for an event that was
 *  actually an arrival somewhere else. */
export type HomeTransitionCause = 'arrived_home' | 'left_home' | 'arrived_elsewhere';

export interface HomeTransition {
  /** Where the user is after this event. */
  presence: 'home' | 'away';
  cause: HomeTransitionCause;
  /** How home-ness was decided — the geofence's own id, or coordinate proximity. */
  via: 'place_id' | 'proximity';
  /** Metres from the anchor; null when decided by `place_id` with no anchor
   *  available (or no usable coords). */
  distance_m: number | null;
  /** The raw iOS event kind, for reason strings + observability. */
  event_kind: string;
}

/**
 * Classify one location packet into a home/away STATE, or null when the packet
 * says nothing about home-ness.
 *
 * Semantics, in order:
 *   - arrival AT home        ⇒ 'home'  (the flagship edge)
 *   - departure FROM home    ⇒ 'away'
 *   - arrival somewhere ELSE ⇒ 'away'  — you're demonstrably not home. This is
 *     the robustness case: iOS drops a `visit_departure` often enough that
 *     without it a missed departure would strand the state at 'home' and
 *     swallow the NEXT arrival edge. `resolve_presence` already worked this way.
 *   - departure from somewhere else ⇒ null (in transit; says nothing about home)
 *   - `significant_change` / unknown kind ⇒ null. These are raw TRANSIT fixes,
 *     not edges — 3,825 of the 4,723 live packets are `significant_change`, and
 *     treating them as transitions would fire an edge every time the phone
 *     wandered across the radius boundary while parked in the driveway.
 *
 * A departure is only a home-departure when it happened AT home — a
 * `visit_departure` at the gym must not read as leaving the house.
 */
export function classify_home_transition(
  input: HomeTransitionInput,
  anchor: HomeAnchor | null | undefined,
  radius_m: number = home_radius_m(),
): HomeTransition | null {
  const kind = input.kind ?? '';
  const arrived = ARRIVAL_KINDS.has(kind);
  const left = DEPARTURE_KINDS.has(kind);
  if (!arrived && !left) return null; // significant_change / unknown — not an edge

  // The geofence's own id wins when present: an OS region crossing is a
  // stronger claim than a point-in-circle test on a fix of unknown accuracy.
  const by_place_id = HOME_PLACE_IDS.has((input.place_id ?? '').toLowerCase());
  const near = by_place_id || at_home(input.lat, input.lng, anchor, radius_m);
  const distance_m =
    anchor && typeof input.lat === 'number' && typeof input.lng === 'number' &&
    Number.isFinite(input.lat) && Number.isFinite(input.lng)
      ? haversine_m(input.lat, input.lng, anchor.lat, anchor.lng)
      : null;
  const via: 'place_id' | 'proximity' = by_place_id ? 'place_id' : 'proximity';

  if (arrived && near) return { presence: 'home', cause: 'arrived_home', via, distance_m, event_kind: kind };
  if (left && near) return { presence: 'away', cause: 'left_home', via, distance_m, event_kind: kind };

  // "Arrived somewhere that isn't home" ⇒ away — but ONLY when we could
  // actually have recognized home. Without an anchor (or an explicit place_id),
  // `near` is false because we're BLIND, not because the user is elsewhere;
  // inferring 'away' there would fire a spurious `home_departure` on every
  // arrival. Unknown must stay unknown.
  const could_have_seen_home = distance_m !== null || input.place_id != null;
  if (arrived && could_have_seen_home) {
    return { presence: 'away', cause: 'arrived_elsewhere', via, distance_m, event_kind: kind };
  }
  return null; // departure from a non-home place, or no way to tell — no transition
}
