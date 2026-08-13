/**
 * household_awareness — the Household Awareness Layer, Phase 1 ("who's home &
 * where"). 2026-06-14. Owner-directed; design at
 * docs/design-household-awareness-layer.md (§8 P1).
 *
 * P1 is mostly ASSEMBLY over signals we already collect: the passive
 * face-sighting sweep (face_sightings.ts) now stamps a VL appearance per
 * sighting, and iOS device-as-sensor gives each member home/away. This module
 * owns the one piece that needs the UserRegistry + the async location read —
 * resolving each household member's home/away against the owner's home anchor —
 * so MemoryClient.get_household_occupancy can stay sync + DB-only and just
 * name-match the join. The occupancy derivation itself lives there; the human
 * one-liner summary lives here (pure).
 *
 * Privacy rails (design §7): owner-only, local-only, derived-not-raw. This
 * module reads the same iOS location cache the maps/EV/away-monitor paths use;
 * it never touches raw frames, and the occupancy state it feeds never enters
 * RAG/search/cross-specialist sharing. Fail-open throughout — an unknown
 * location is reported as `unknown`, never guessed as home or away.
 */

import type { Database } from 'bun:sqlite';
import type { UserRegistry } from './users';
import { at_home } from './home_anchor';
import { get_current_location, type LocationKind } from './location_awareness';
import type { HouseholdLocation, HouseholdOccupancy } from '@memory/client';
import { wifi_presence_enabled, resolve_wifi_home, apply_wifi_home } from './wifi_presence';
import { ble_presence_enabled, apply_ble_home } from './ble_presence';

// "At home" is defined ONCE, in core/home_anchor.ts (`at_home` +
// `home_radius_m` — still HEARTH_HOME_RADIUS_M, still 180m). It is the same
// predicate the reactive home triggers, the `is_home` derived signal and the
// push presence gate use, so "away" means the same thing system-wide by
// construction rather than by four modules agreeing to copy each other. This
// module used to keep its own HOME_RADIUS_M + haversine call.

/** A raw TRANSIT fix (significant_change) older than this can't confirm where the
 *  user is right now — treat as unknown. Arrival/departure EVENTS are sticky and
 *  NOT subject to this window (see resolve_household_locations). */
const PRESENCE_FRESH_MS = Number(process.env.HEARTH_PRESENCE_FRESH_MS ?? String(30 * 60 * 1000));
/** A sticky arrival/enter event holds presence this long without a newer event
 *  before degrading to unknown — the backstop for a phone that quietly stopped
 *  posting (app killed), so a day-old "arrived home" can't claim home forever. */
const PRESENCE_STICKY_MAX_MS = Number(
  process.env.HEARTH_PRESENCE_STICKY_MAX_MS ?? String(18 * 60 * 60 * 1000),
);
/** iOS edge-event kinds: "arrived/at a place" (sticky) vs "left a place". */
const ARRIVAL_KINDS = new Set<LocationKind>(['visit_arrival', 'region_enter']);
const DEPARTURE_KINDS = new Set<LocationKind>(['visit_departure', 'region_exit']);

/**
 * Resolve every household member's home/away for the OWNER's home anchor.
 * Async (it reads the per-user iOS location cache); fail-open per member — a
 * missing/stale/anchorless fix yields `unknown`, never a guess. The result is
 * the location-join input for MemoryClient.get_household_occupancy.
 */
export async function resolve_household_locations(
  users: UserRegistry,
  owner_user_id: string,
  opts: { now_ms?: number; db?: Database } = {},
): Promise<HouseholdLocation[]> {
  const now_ms = opts.now_ms ?? Date.now();
  const home = users.home_coords(owner_user_id);
  const members = users.list();
  const out: HouseholdLocation[] = [];

  for (const m of members) {
    let snap;
    try {
      snap = await get_current_location(m.id);
    } catch {
      snap = null;
    }
    if (!snap || !snap.available || !snap.coords || !home) {
      out.push({ user_id: m.id, display_name: m.display_name, presence: 'unknown', presence_confidence: null, as_of: snap?.available ? snap.ts : null });
      continue;
    }
    const fix_ms = Date.parse(snap.ts);
    const age_ms = Number.isFinite(fix_ms) ? now_ms - fix_ms : Number.MAX_SAFE_INTEGER;
    const at_home_loc = at_home(snap.coords.lat, snap.coords.lon, home);

    // iOS location is EDGE-triggered (visit/region/significant-change), so the
    // latest fix is usually minutes-to-hours old even when the user hasn't moved.
    // Derive home/away from the EVENT KIND (a sticky geofence state), not a raw
    // freshness window — otherwise a member who's been home for hours (last event
    // = a home arrival) wrongly reads 'unknown'.
    let presence: 'home' | 'away' | 'unknown';
    let confidence: 'high' | 'medium' | 'low';
    if (snap.kind && ARRIVAL_KINDS.has(snap.kind)) {
      // Arrived somewhere + stayed until a departure — STICKY, no 30-min expiry.
      // Home iff the arrival was at the home anchor. The generous ceiling guards
      // a phone that silently stopped posting.
      if (age_ms > PRESENCE_STICKY_MAX_MS) {
        presence = 'unknown';
        confidence = 'low';
      } else {
        presence = at_home_loc ? 'home' : 'away';
        confidence = age_ms <= PRESENCE_FRESH_MS ? 'high' : 'medium';
      }
    } else if (snap.kind && DEPARTURE_KINDS.has(snap.kind)) {
      // Just left a place → in transit, not at a confirmed home (a later
      // arrival-home event flips it back). Never read as home.
      presence = 'away';
      confidence = age_ms <= PRESENCE_STICKY_MAX_MS ? 'medium' : 'low';
    } else {
      // significant_change / foreground_fix / unknown kind: a raw transit fix —
      // trustworthy only while fresh.
      if (age_ms > PRESENCE_FRESH_MS) {
        presence = 'unknown';
        confidence = 'low';
      } else {
        presence = at_home_loc ? 'home' : 'away';
        confidence = snap.confidence;
      }
    }
    out.push({
      user_id: m.id,
      display_name: m.display_name,
      presence,
      presence_confidence: presence === 'unknown' ? 'low' : confidence,
      as_of: snap.ts,
    });
  }

  // WiFi-association corroborator: a member whose phone is currently associated
  // to the home APs is HOME — overriding a stale/unknown geofence. Gated +
  // fail-open (off / UniFi down / no mapping → iOS presence unchanged). Needs
  // `db` for the device→member mapping; callers without it are unaffected.
  let resolved = out;
  if (opts.db && wifi_presence_enabled()) {
    try {
      const { home_members } = await resolve_wifi_home(opts.db, owner_user_id);
      resolved = apply_wifi_home(resolved, home_members, now_ms);
    } catch {
      /* fail-open — geofence-only */
    }
  }
  // BLE corroborator (2026-07-15, the security-autonomy audit): a member whose
  // enrolled BLE device reads a mapped home room (the Bermuda proxies) is
  // HOME — the second independent non-GPS signal. Same gate + fail-open
  // contract as WiFi; before this, BLE only fed the Home-map display.
  if (opts.db && ble_presence_enabled()) {
    try {
      resolved = await apply_ble_home(opts.db, owner_user_id, resolved, now_ms);
    } catch {
      /* fail-open */
    }
  }
  return resolved;
}

/** Coarse "Nm ago" for a one-liner. */
function ago(seconds: number | null): string {
  if (seconds == null) return '';
  if (seconds < 90) return 'just now';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

/**
 * One-line human summary of the occupancy state, for a specialist's reasoning
 * or a brief. Pure. Leads with recognized occupants, then the home/away of
 * members not on camera, then unknowns last (the concern signal stands out).
 * e.g. "Jasper — kitchen cam, 2m ago (home); an unrecognized person — living
 * room, 1m ago. Sam: home (not on camera)."
 */
export function summarize_occupancy(occ: HouseholdOccupancy): string {
  const parts: string[] = [];
  for (const o of occ.occupants) {
    const where = [o.zone, ago(o.seconds_ago)].filter(Boolean).join(', ');
    const pres = o.presence && o.presence !== 'unknown' ? ` (${o.presence})` : '';
    const wore = o.appearance ? `, ${o.appearance}` : '';
    parts.push(`${o.name} — ${where}${wore}${pres}`.trim());
  }
  for (const u of occ.unknown_present) {
    const where = [u.zone, ago(u.seconds_ago)].filter(Boolean).join(', ');
    const wore = u.appearance ? `, ${u.appearance}` : '';
    parts.push(`an unrecognized person — ${where}${wore}`.trim());
  }
  // Members with a presence but no recent camera sighting.
  const seen = new Set(occ.occupants.map((o) => o.name.toLowerCase()));
  const off_camera = occ.household
    .filter((h) => h.presence !== 'unknown' && !seen.has(h.display_name.toLowerCase()))
    .map((h) => `${h.display_name}: ${h.presence}`);
  let line = parts.join('; ');
  if (off_camera.length > 0) line += `${line ? '. ' : ''}Not on camera — ${off_camera.join(', ')}`;
  return line || 'No one seen on a camera recently.';
}
