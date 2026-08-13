/**
 * Luna's Home office routes — the household-shared "who is where" surface +
 * the owner-only camera/BLE assignment overlay (Household Awareness Layer P1.5;
 * design-household-awareness-layer.md §6a). Mounted under the EXISTING
 * `/api/specialists` namespace (no nginx change — the P1 precedent), alongside
 * the Cassandra router.
 *
 * Privacy split (§9.2):
 *   - GET /:id/home_occupancy  — HOUSEHOLD tier (friend excluded). The NAMED map
 *     only: occupants (name/room/since/appearance/home-away) + each member's
 *     home/away. NEVER unknown/unrecognized people, NEVER crop thumbnails — the
 *     security half stays owner-only on Cassandra's Watch Desk.
 *   - GET /:id/home_map        — HOUSEHOLD tier. The imported room geometry +
 *     the camera/BLE assignment overlay (for the canvas render).
 *   - POST /:id/home_map/assign — OWNER only. Sets one room's cameras/ble_areas.
 *
 * Occupancy is the HOME's, keyed by the owner's user_id; any household member
 * sees the same shared map. The route gates on the specialist holding `read_home`
 * so it's wired to whichever specialist hosts the office (Luna).
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { MemoryClient } from '@memory/client';
import type { SpecialistRegistry } from '@core/specialist';
import type { UserRegistry } from '@core/users';
import type { AppEventBus } from '@app/events';
import { HomeMapStore, derive_zone_map } from '@memory/stores/home_map';
import { list_cameras } from '@connectors/unifi';
import { resolve_household_locations, summarize_occupancy } from '@core/household_awareness';
import {
  ble_presence_enabled,
  run_ble_presence_sweep,
  resolve_ble_occupants,
  augment_occupancy_with_ble,
} from '@core/ble_presence';

export interface HomeRouterDeps {
  db: Database;
  memory: MemoryClient;
  specialists: SpecialistRegistry;
  users: UserRegistry;
  events?: AppEventBus;
}

const AssignBody = z.object({
  room_id: z.string().min(1),
  cameras: z.array(z.string()).optional(),
  ble_areas: z.array(z.string()).optional(),
});

export function create_home_router(deps: HomeRouterDeps): Hono {
  const r = new Hono();

  /** The home's owner (occupancy is owner-keyed; the household shares the map). */
  const owner_id = (fallback: string): string =>
    deps.users.list().find((u) => u.tier === 'owner')?.id ?? fallback;

  /** Household-tier gate: authenticated, NOT friend, and the specialist holds
   *  `read_home`. `owner_only` tightens it to the owner tier (assignment). */
  function gate(c: Context, opts: { owner_only?: boolean } = {}): Response | null {
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthenticated' }, 401);
    if (opts.owner_only) {
      if (user.tier !== 'owner') return c.json({ error: 'owner only' }, 403);
    } else if (user.tier === 'friend') {
      // The named occupancy map is household-mutual; friends are excluded.
      return c.json({ error: 'household only' }, 403);
    }
    const id = c.req.param('id');
    const spec = id ? deps.specialists.get(id) : undefined;
    if (!spec || !spec.granted.has('read_home')) {
      return c.json({ error: 'no home office for this specialist' }, 404);
    }
    return null;
  }

  // ── GET /:id/home_occupancy — the household-shared "who is where" map ───────
  r.get('/:id/home_occupancy', async (c) => {
    const denied = gate(c);
    if (denied) return denied;
    const home = owner_id(c.get('user').id);
    const raw = Number.parseInt(c.req.query('window_minutes') ?? '30', 10);
    const window_minutes = Number.isFinite(raw) ? Math.min(720, Math.max(1, raw)) : 30;

    let locations: Awaited<ReturnType<typeof resolve_household_locations>> = [];
    try {
      locations = await resolve_household_locations(deps.users, home, { db: deps.db });
    } catch {
      locations = [];
    }

    const map = new HomeMapStore(deps.db).get();
    const zone_map = derive_zone_map(map);
    const room_name = new Map(map.rooms.map((rm) => [rm.id, rm.name]));
    const display_zone = (zone: string | null): string | null =>
      zone == null ? null : room_name.get(zone) ?? zone;

    let occ = deps.memory.get_household_occupancy(home, {
      window_minutes,
      locations,
      ...(Object.keys(zone_map).length > 0 ? { zone_map } : {}),
    });

    // P3 BLE room layer — dormant unless HEARTH_BLE_PRESENCE=1 + devices enrolled.
    // Adds people whose phone is in a room but who weren't seen on a camera (the
    // face-blind-room payoff). Fail-open: any error leaves `occ` untouched.
    if (ble_presence_enabled()) {
      try {
        await run_ble_presence_sweep({ db: deps.db, owner_user_id: home });
        occ = augment_occupancy_with_ble(occ, resolve_ble_occupants(deps.db, deps.memory, home), { locations });
      } catch {
        /* fail-open — BLE is opportunistic, never load-bearing */
      }
    }

    // NAMED map only — no unknown_present, no crop thumbnails (owner-only security).
    return c.json({
      generated_at: occ.generated_at,
      window_minutes: occ.window_minutes,
      summary: summarize_occupancy(occ),
      presence_available: locations.length > 0,
      occupants: occ.occupants.map((o) => ({
        name: o.name,
        relationship: o.relationship,
        zone: display_zone(o.zone),
        // The raw room id (or camera name when unassigned) — the canvas places
        // dots by id, since display names can collide across floors (e.g. two
        // "Stairs"). Display uses `zone`; placement uses `zone_id`.
        zone_id: o.zone,
        last_seen_at: o.last_seen_at,
        seconds_ago: o.seconds_ago,
        appearance: o.appearance,
        presence: o.presence,
        is_household_member: o.household_user_id != null,
      })),
      household: occ.household.map((h) => ({
        name: h.display_name,
        presence: h.presence,
        last_zone: display_zone(h.last_zone),
      })),
    });
  });

  // ── GET /:id/home_map — the imported geometry + assignment overlay ─────────
  r.get('/:id/home_map', (c) => {
    const denied = gate(c);
    if (denied) return denied;
    const map = new HomeMapStore(deps.db).get();
    // `editable` is the server-authoritative owner check the canvas keys its
    // assign mode on (/auth/me carries role, not tier — so the client can't
    // decide this itself). Owner writes the overlay; household reads only.
    return c.json({ ...map, editable: c.get('user').tier === 'owner' });
  });

  // ── GET /:id/home_cameras — the full Protect camera roster (assign options) ─
  // The datalist source for the assign overlay. Sourced from list_cameras() (all
  // adopted cameras) rather than only cameras that have produced a sighting — so
  // motion-only cameras (no smart detect; they never auto-fire) are still
  // offerable. Fail-open to [] when UniFi is unconfigured/unreachable.
  r.get('/:id/home_cameras', async (c) => {
    const denied = gate(c);
    if (denied) return denied;
    let cameras: Array<{ id: string; name: string; connected: boolean }> = [];
    try {
      cameras = await list_cameras();
    } catch {
      cameras = [];
    }
    return c.json({ cameras });
  });

  // ── POST /:id/home_map/assign — OWNER sets a room's camera/BLE overlay ─────
  r.post('/:id/home_map/assign', async (c) => {
    const denied = gate(c, { owner_only: true });
    if (denied) return denied;
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = AssignBody.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const store = new HomeMapStore(deps.db);
    let updated;
    try {
      updated = store.set_assignments(parsed.data.room_id, {
        ...(parsed.data.cameras !== undefined ? { cameras: parsed.data.cameras } : {}),
        ...(parsed.data.ble_areas !== undefined ? { ble_areas: parsed.data.ble_areas } : {}),
      });
    } catch (err) {
      // Unknown room id (the store throws so a typo surfaces, not a silent no-op).
      return c.json({ error: (err as Error).message }, 400);
    }

    // Audit the assignment (the fact + which room/counts, never coordinates).
    deps.memory.log_action({
      intent_id: ulid(),
      agent: c.req.param('id') ?? 'luna',
      tool_name: 'home_map_assign',
      tool_input: {
        room_id: parsed.data.room_id,
        cameras: parsed.data.cameras?.length ?? null,
        ble_areas: parsed.data.ble_areas?.length ?? null,
      },
      execution_result: { revision: updated.revision },
      user_id: c.get('user').id,
    });

    return c.json(updated);
  });

  return r;
}
