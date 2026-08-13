/**
 * /api/presence/* — the web↔backend contract for the LD2450 presence office
 * (design-ld2450-zone-editor.md §3–§4).
 *
 * Data flow is strictly web → Hearth → coordinator → device; the web pane
 * never touches the device. This router is the Hearth hinge:
 *
 *   Live targets UP (device → coordinator → here → SSE):
 *     POST /api/presence/targets        coordinator republishes a snapshot
 *     GET  /api/presence/state          pane cold-paints (snapshot + zones)
 *
 *   Zones DOWN (editor → here → coordinator pulls → device):
 *     POST /api/presence/zones          editor saves desired config (owner)
 *     GET  /api/presence/zones/pending  coordinator polls
 *     POST /api/presence/zones/ack      coordinator reports applied/reboot
 *
 *   Gear + reboot (owner):
 *     GET/POST /api/presence/settings   room calibration + firmware target
 *     POST     /api/presence/reboot     queue a device reboot (custom fw)
 *
 * AUTH: everything sits behind the global auth middleware (a request reaches
 * here only authenticated). The coordinator authenticates with its service
 * bearer (minted via `bun run mint:service-bearer`, resolves to the owner
 * today). Owner-only surfaces additionally assert `user.tier === 'owner'` —
 * presence-in-the-home is privacy-sensitive (§11), so the viewer/editor/gear
 * are owner-gated like the Code Shop gear; the machine routes the coordinator
 * calls (targets / pending / ack) require only an authenticated principal.
 *
 * UNITS: millimeters everywhere (radar frame, X signed, Y positive-away). The
 * cm↔mm conversion the FutureProof tuner needs lives only in the coordinator's
 * TunerHttpZoneWriter, never here.
 *
 * NOTE: `POST /api/presence/targets` deliberately does NOT write an audit row
 * — it lands at ≤4 Hz and the targets are ephemeral (PresenceLiveCache, never
 * SQLite). Auditing it would flood the log. The owner-gated WRITES (zones,
 * settings, reboot) are all audited by the fact-of-change.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { MemoryClient } from '@memory/client';
import type { AppEventBus } from '@app/events';
import {
  PresenceZonesStore,
  DEFAULT_PRESENCE_DEVICE_ID,
  LD2450_X_MIN_MM,
  LD2450_X_MAX_MM,
  LD2450_Y_MIN_MM,
  LD2450_Y_MAX_MM,
} from '@memory/stores/presence_zones';
import { get_presence_cache, type PresenceSnapshot } from '@core/presence_cache';

export interface PresenceRouterDeps {
  db: Database;
  memory: MemoryClient;
  events?: AppEventBus;
}

// ── inbound schemas ───────────────────────────────────────────────────────

const TargetSchema = z.object({
  index: z.number().int().min(1).max(3),
  x_mm: z.number().finite(),
  y_mm: z.number().finite(),
  speed_mms: z.number().finite(),
  angle_deg: z.number().finite().nullable(),
  distance_mm: z.number().finite(),
  active: z.boolean(),
});

// Live targets are validated for SHAPE, not clamped to legal ranges — a target
// momentarily reading just past the datasheet box shouldn't drop the frame.
const SnapshotSchema = z.object({
  device_id: z.string().min(1),
  present: z.boolean(),
  moving: z.number().int().min(0),
  still: z.number().int().min(0),
  nearest_mm: z.number().finite().nullable(),
  targets: z.array(TargetSchema).max(3),
  captured_at: z.string().min(1),
});

// Stored zone corners ARE clamped to the LD2450's legal box — the editor
// clamps on drag, so an out-of-range corner is a contract violation (4xx).
const ZoneRectInputSchema = z.object({
  index: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  type: z.enum(['Disabled', 'Detection', 'Filter']),
  x1_mm: z.number().min(LD2450_X_MIN_MM).max(LD2450_X_MAX_MM),
  y1_mm: z.number().min(LD2450_Y_MIN_MM).max(LD2450_Y_MAX_MM),
  x2_mm: z.number().min(LD2450_X_MIN_MM).max(LD2450_X_MAX_MM),
  y2_mm: z.number().min(LD2450_Y_MIN_MM).max(LD2450_Y_MAX_MM),
  name: z.string().max(60).optional(),
  color: z.string().max(32).optional(),
});

const ZonesPostSchema = z.object({
  device_id: z.string().min(1).optional(),
  zones: z.array(ZoneRectInputSchema).min(1).max(3),
});

const AckSchema = z.object({
  device_id: z.string().min(1).optional(),
  revision: z.number().int().min(0),
  applied: z.boolean(),
  reboot_required: z.boolean().optional(),
  error: z.string().nullable().optional(),
});

const CalibrationPostSchema = z.object({
  device_id: z.string().min(1).optional(),
  room_name: z.string().max(80).optional(),
  room_width_mm: z.number().positive().max(20_000).optional(),
  room_depth_mm: z.number().positive().max(20_000).optional(),
  px_per_m: z.number().positive().max(2000).nullable().optional(),
  mount_x_offset_mm: z.number().min(LD2450_X_MIN_MM).max(LD2450_X_MAX_MM).optional(),
  mount_rotation_deg: z.number().min(-180).max(180).optional(),
  mount_height_mm: z.number().min(0).max(10_000).optional(),
  snap_grid_mm: z.number().min(0).max(1000).optional(),
  snap_enabled: z.boolean().optional(),
  firmware_target: z.enum(['auto', 'entity', 'tuner']).optional(),
  zones: z
    .array(
      z.object({
        index: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        name: z.string().max(60).optional(),
        color: z.string().max(32).optional(),
      }),
    )
    .max(3)
    .optional(),
});

const RebootSchema = z.object({ device_id: z.string().min(1).optional() }).optional();

export function create_presence_router(deps: PresenceRouterDeps): Hono {
  const r = new Hono();
  const store = () => new PresenceZonesStore(deps.db);

  const require_owner = (c: Context) => {
    const user = c.get('user');
    return user && user.tier === 'owner' ? user : null;
  };

  const device_of = (q: string | undefined, body_id?: string): string =>
    body_id || q || DEFAULT_PRESENCE_DEVICE_ID;

  async function read_json(c: Context): Promise<unknown | { __err: string }> {
    try {
      return await c.req.json();
    } catch (err) {
      return { __err: `Invalid JSON: ${(err as Error).message}` };
    }
  }

  // ── Live targets UP ──────────────────────────────────────────────────────

  // Coordinator republish. Authenticated (any principal); not owner-gated and
  // not audited (≤4 Hz, ephemeral). Caches + fans out over SSE.
  r.post('/targets', async (c) => {
    const raw = await read_json(c);
    if (raw && typeof raw === 'object' && '__err' in raw) {
      return c.json({ error: (raw as { __err: string }).__err }, 400);
    }
    const parsed = SnapshotSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const snap: PresenceSnapshot = parsed.data;
    get_presence_cache().set(snap);
    deps.events?.emit({
      type: 'presence_targets',
      device_id: snap.device_id,
      present: snap.present,
      moving: snap.moving,
      still: snap.still,
      nearest_mm: snap.nearest_mm,
      targets: snap.targets,
      captured_at: snap.captured_at,
    });
    return c.json({ ok: true });
  });

  // Pane cold-paint: the live snapshot (when fresh) + the zone config +
  // calibration, plus `device_connected` so the editor degrades to read-only
  // when the coordinator isn't feeding targets (HA holds the device — §8).
  // Owner-gated (presence is private to the household owner).
  r.get('/state', (c) => {
    if (!require_owner(c)) return c.json({ error: 'owner only' }, 403);
    const device_id = device_of(c.req.query('device_id'));
    const cache = get_presence_cache();
    const live = cache.is_live(device_id);
    const config = store().get(device_id);
    return c.json({
      device_id,
      device_connected: live,
      snapshot: cache.get(device_id),
      snapshot_age_ms: cache.age_ms(device_id),
      config,
    });
  });

  // ── Zones DOWN ───────────────────────────────────────────────────────────

  // Editor "Save" — owner only. Persists the desired config (status=pending,
  // revision++). The coordinator pulls + applies + acks. Audited by fact.
  r.post('/zones', async (c) => {
    const user = require_owner(c);
    if (!user) return c.json({ error: 'owner only' }, 403);
    const raw = await read_json(c);
    if (raw && typeof raw === 'object' && '__err' in raw) {
      return c.json({ error: (raw as { __err: string }).__err }, 400);
    }
    const parsed = ZonesPostSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const device_id = device_of(undefined, parsed.data.device_id);
    const cfg = store().set_zones(device_id, parsed.data.zones);
    deps.memory.log_action({
      intent_id: ulid(),
      agent: 'orchestrator',
      tool_name: 'presence_zones_update',
      tool_input: {
        device_id,
        revision: cfg.revision,
        by: user.id,
        zones: parsed.data.zones.map((z) => ({ index: z.index, type: z.type })),
      },
    });
    return c.json({ ok: true, config: cfg });
  });

  // Coordinator poll — the desired config to apply, or { pending: null }.
  r.get('/zones/pending', (c) => {
    const device_id = device_of(c.req.query('device_id'));
    const pending = store().get_pending(device_id);
    return c.json({ pending });
  });

  // Coordinator ack — flips applied/error, records reboot_required, emits the
  // SSE the editor confirms on.
  r.post('/zones/ack', async (c) => {
    const raw = await read_json(c);
    if (raw && typeof raw === 'object' && '__err' in raw) {
      return c.json({ error: (raw as { __err: string }).__err }, 400);
    }
    const parsed = AckSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const device_id = device_of(undefined, parsed.data.device_id);
    const cfg = store().ack(device_id, parsed.data.revision, {
      applied: parsed.data.applied,
      reboot_required: parsed.data.reboot_required,
      error: parsed.data.error ?? null,
    });
    deps.events?.emit({
      type: 'presence_zones_acked',
      device_id,
      revision: parsed.data.revision,
      applied: parsed.data.applied,
      reboot_required: Boolean(parsed.data.reboot_required),
      error: parsed.data.error ?? null,
    });
    return c.json({ ok: true, config: cfg });
  });

  // ── Gear (calibration + firmware target) + reboot ────────────────────────

  r.get('/settings', (c) => {
    if (!require_owner(c)) return c.json({ error: 'owner only' }, 403);
    const device_id = device_of(c.req.query('device_id'));
    return c.json({ config: store().get(device_id) });
  });

  r.post('/settings', async (c) => {
    const user = require_owner(c);
    if (!user) return c.json({ error: 'owner only' }, 403);
    const raw = await read_json(c);
    if (raw && typeof raw === 'object' && '__err' in raw) {
      return c.json({ error: (raw as { __err: string }).__err }, 400);
    }
    const parsed = CalibrationPostSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { device_id: body_id, ...patch } = parsed.data;
    const device_id = device_of(undefined, body_id);
    const cfg = store().set_calibration(device_id, patch);
    deps.memory.log_action({
      intent_id: ulid(),
      agent: 'orchestrator',
      tool_name: 'presence_settings_update',
      tool_input: { device_id, by: user.id, changed: Object.keys(patch) },
    });
    return c.json({ ok: true, config: cfg });
  });

  // Owner queues a device reboot (custom firmware needs it to persist zones).
  // A reboot drops the voice session, so it's explicit, never automatic; the
  // coordinator picks it up on its next poll. (PIN step-up is a documented
  // follow-up — owner-gating is the v1 bar.)
  r.post('/reboot', async (c) => {
    const user = require_owner(c);
    if (!user) return c.json({ error: 'owner only' }, 403);
    const raw = (await read_json(c)) ?? {};
    if (raw && typeof raw === 'object' && '__err' in raw) {
      return c.json({ error: (raw as { __err: string }).__err }, 400);
    }
    const parsed = RebootSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const device_id = device_of(undefined, parsed.data?.device_id);
    const cfg = store().request_reboot(device_id);
    deps.memory.log_action({
      intent_id: ulid(),
      agent: 'orchestrator',
      tool_name: 'presence_reboot_requested',
      tool_input: { device_id, by: user.id },
    });
    return c.json({ ok: true, queued: true, config: cfg });
  });

  return r;
}
