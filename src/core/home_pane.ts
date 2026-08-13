/**
 * Luna's `home` pane — the household-shared "Home" office: a glance at WHO IS
 * WHERE in the house (Household Awareness Layer P1.5;
 * design-household-awareness-layer.md §6a). Lives in its OWN file (not
 * specialist_pane.ts) so the sessions sharing that hot file don't collide —
 * specialist_pane.ts imports `compose_home_pane` and adds only the dispatch case.
 *
 * Privacy (design §7 / §9.2): the NAMED occupancy map is HOUSEHOLD-visible
 * (mutual transparency) — friend tier is excluded at the dispatch. This pane
 * renders the named map ONLY: names + rooms + "since" + home/away. It never
 * renders unknown/unrecognized people, camera crops, or the away-monitor — those
 * are the SECURITY half and stay owner-only on Cassandra's Watch Desk. So no
 * crop thumbnails, no `unknown_present`, ever, here.
 *
 * Occupancy is the HOME's, keyed by the owner's user_id (enrolled people + the
 * home anchor are the owner's); any household member viewing sees the same map.
 * Room names come from the imported home_map (camera→room assignment via
 * derive_zone_map); until a camera is assigned its zone falls back to the camera
 * name (the P1 behavior). Fail-open: no users registry / no home_map → a
 * sighting-only view, never an error.
 */
import type { Database } from 'bun:sqlite';
import type { PaneDeps, PaneDocument, PaneBlock } from './specialist_pane';
import { HomeMapStore, derive_zone_map } from '@memory/stores/home_map';
import { resolve_household_locations } from './household_awareness';
import {
  ble_presence_enabled,
  run_ble_presence_sweep,
  resolve_ble_occupants,
  augment_occupancy_with_ble,
} from './ble_presence';
import type { HouseholdLocation } from '@memory/client';

function ago(seconds: number | null): string {
  if (seconds == null) return '';
  if (seconds < 90) return 'just now';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

export async function compose_home_pane(
  db: Database,
  viewer_id: string,
  deps: PaneDeps,
): Promise<PaneDocument> {
  const now = new Date().toISOString();

  // The home is the OWNER's; a household viewer sees the same shared map.
  const owner_id = deps.users?.list().find((u) => u.tier === 'owner')?.id ?? viewer_id;

  // Home/away per member (async; needs the UserRegistry + home anchor).
  // Fail-open: no registry / a throw → sighting-only view (presence unknown).
  let locations: HouseholdLocation[] = [];
  if (deps.users) {
    try {
      locations = await resolve_household_locations(deps.users, owner_id, { db });
    } catch {
      locations = [];
    }
  }

  // Imported room geometry → the camera→room zone_map + room display names.
  const map = new HomeMapStore(db).get();
  const zone_map = derive_zone_map(map);
  const room_name = new Map(map.rooms.map((r) => [r.id, r.name]));
  const display_zone = (zone: string | null): string | null =>
    zone == null ? null : room_name.get(zone) ?? zone;

  let occ = deps.memory.get_household_occupancy(owner_id, {
    window_minutes: 30,
    locations,
    ...(Object.keys(zone_map).length > 0 ? { zone_map } : {}),
  });

  // P3 BLE room layer — dormant unless HEARTH_BLE_PRESENCE=1 + devices enrolled.
  // Adds household members whose phone is in a room but who weren't seen on a
  // camera (the face-blind-room payoff). Fail-open: errors leave `occ` untouched.
  if (ble_presence_enabled()) {
    try {
      await run_ble_presence_sweep({ db, owner_user_id: owner_id });
      occ = augment_occupancy_with_ble(occ, resolve_ble_occupants(db, deps.memory, owner_id), { locations });
    } catch {
      /* fail-open — BLE is opportunistic, never load-bearing */
    }
  }

  const blocks: PaneBlock[] = [];

  // ── Hero: how many people are in the house right now. "In the house" =
  //    members whose phone reads home OR who were just seen on a camera.
  const present = new Set<string>();
  for (const o of occ.occupants) present.add(o.name.toLowerCase());
  for (const h of occ.household) if (h.presence === 'home') present.add(h.display_name.toLowerCase());
  blocks.push({
    type: 'hero_metric',
    value: present.size > 0 ? String(present.size) : '—',
    label: present.size === 0 ? 'no one home' : present.size === 1 ? 'person home' : 'people home',
    delta_kind: 'neutral',
  });

  // ── Where everyone is — named occupants seen on a camera in-window.
  if (occ.occupants.length > 0) {
    blocks.push({
      type: 'list',
      title: 'In the house',
      items: occ.occupants.map((o) => {
        const where = [display_zone(o.zone), ago(o.seconds_ago)].filter(Boolean).join(' · ');
        const pres = o.presence && o.presence !== 'unknown' ? ` (${o.presence})` : '';
        return {
          title: o.name,
          subtitle: `${where}${pres}`.trim() || 'seen recently',
          ...(o.appearance ? { detail_md: o.appearance } : {}),
        };
      }),
    });
  }

  // ── Members not on a camera right now — their phone's home/away.
  const seen = new Set(occ.occupants.map((o) => o.name.toLowerCase()));
  const off_camera = occ.household.filter(
    (h) => h.presence !== 'unknown' && !seen.has(h.display_name.toLowerCase()),
  );
  if (off_camera.length > 0) {
    const home = off_camera.filter((h) => h.presence === 'home').map((h) => h.display_name);
    const away = off_camera.filter((h) => h.presence === 'away').map((h) => h.display_name);
    const lines: string[] = [];
    if (home.length > 0) lines.push(`**Home** (not on a camera): ${home.join(', ')}`);
    if (away.length > 0) lines.push(`**Out:** ${away.join(', ')}`);
    if (lines.length > 0) blocks.push({ type: 'text', body_md: lines.join('  \n') });
  }

  if (occ.occupants.length === 0 && off_camera.length === 0) {
    blocks.push({
      type: 'text',
      body_md:
        locations.length === 0
          ? 'No one seen on a camera recently, and home/away presence is unavailable.'
          : 'No one seen on a camera in the last 30 minutes.',
    });
  }

  const subtitle =
    map.rooms.length > 0
      ? `${map.rooms.length} rooms${Object.keys(zone_map).length === 0 ? ' · assign cameras to rooms to see room names' : ''}`
      : 'who is where';

  return { pane_kind: 'home', title: 'Home', subtitle, blocks, generated_at: now };
}
