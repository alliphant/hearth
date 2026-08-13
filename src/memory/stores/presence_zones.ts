/**
 * PresenceZonesStore — per-device room calibration + LD2450 detection-zone
 * config for the presence office (design-ld2450-zone-editor.md §7).
 *
 * One row per device (`device_id` PK), owner-global. v1 has a single device,
 * but keying by `device_id` from day one means a second Satellite1 is a new
 * row, not a migration. The whole config is a JSON column (`config_json`) —
 * the same single-row-merged-over-defaults shape as `codeshop_settings.ts`.
 *
 * SECRET-FREE: unlike the Code Shop store this holds no credentials, so the
 * GET endpoint returns the full config (nothing to redact). Same discipline
 * otherwise — never LLM-readable, owner-gated at the route, audited by the
 * fact-of-change.
 *
 * UNITS: everything stored here is MILLIMETERS in the radar's own frame
 * (origin = sensor, X signed −left/+right, Y positive-away — matches the
 * datasheet + the rest of Hearth). The cm↔mm conversion the FutureProof tuner
 * needs lives ONLY inside the coordinator's `TunerHttpZoneWriter`, never here.
 *
 * WRITE LIFECYCLE: the editor saves a desired config (`set_zones`) which bumps
 * a monotonic `revision` and flips `status` to `pending`. The coordinator
 * polls `get_pending`, applies the zones to the device, then `ack`s — flipping
 * to `applied` (or `error`) and recording whether a reboot is required (the
 * custom-firmware path). The web pane never touches the device.
 *
 * Table created in this store's constructor (CREATE TABLE IF NOT EXISTS), not
 * the central SCHEMA_SQL — self-contained, same pattern as the Kristi /
 * CodeShop stores. Columns are additive; no SCHEMA_VERSION bump.
 */
import { Database } from 'bun:sqlite';

/** LD2450 datasheet legal ranges (mm). Exported so the route's Zod schema and
 *  the client clamp share ONE source of truth. */
export const LD2450_X_MIN_MM = -3000;
export const LD2450_X_MAX_MM = 3000;
export const LD2450_Y_MIN_MM = 0;
export const LD2450_Y_MAX_MM = 6000;

/** Which write path the coordinator uses for THIS device. The owner picks this
 *  in the gear (it's a real tradeoff — the stock `ld2450` build writes zones as
 *  live entities with no reboot; the custom `satellite1_radar` firmware writes
 *  via the on-device HTTP tuner and needs a reboot to persist). `auto` lets the
 *  coordinator probe the device's entity set and pick. See design §2–§3. */
export type FirmwareTarget = 'auto' | 'entity' | 'tuner';

export type ZoneType = 'Disabled' | 'Detection' | 'Filter';

/** One axis-aligned zone rectangle in the radar frame (mm). `name`/`color` are
 *  presentation only (edited in the gear); `type` + corners are the device
 *  write (edited in the canvas editor). */
export interface ZoneRect {
  index: 1 | 2 | 3;
  name: string;
  color: string;
  type: ZoneType;
  x1_mm: number;
  y1_mm: number;
  x2_mm: number;
  y2_mm: number;
}

export type ZoneWriteStatus = 'pending' | 'applied' | 'error';

export interface PresenceDeviceConfig {
  device_id: string;
  // ── room calibration (the gear) ───────────────────────────────────────
  room_name: string;
  room_width_mm: number;
  room_depth_mm: number;
  /** Canvas scale; null ⇒ auto-fit 6 m of range to the canvas height. */
  px_per_m: number | null;
  /** Sensor offset from the wall centerline (mm); + = right. */
  mount_x_offset_mm: number;
  /** Sensor rotation about its mount (deg); 0 = facing straight out. */
  mount_rotation_deg: number;
  /** Mounting height (mm) — informational, not used by the 2-D transform. */
  mount_height_mm: number;
  /** Editor snap grid (mm); 0 ⇒ off. */
  snap_grid_mm: number;
  snap_enabled: boolean;
  /** Which coordinator write path to use (owner choice). */
  firmware_target: FirmwareTarget;
  // ── the zones (mm, radar frame, axis-aligned rects) ───────────────────
  zones: ZoneRect[];
  // ── write lifecycle ───────────────────────────────────────────────────
  /** Bumped on every editor save; the coordinator acks against it. */
  revision: number;
  status: ZoneWriteStatus;
  /** True when the last write needs a device reboot to persist (custom fw). */
  reboot_required: boolean;
  /** True when the owner has requested a reboot the coordinator hasn't run. */
  reboot_requested: boolean;
  last_error: string | null;
  updated_at: string;
}

const ZONE_DEFAULT_COLORS = ['#5e8aa8', '#5b8e7d', '#c9a227'];

function default_zones(): ZoneRect[] {
  return ([1, 2, 3] as const).map((index) => ({
    index,
    name: `Zone ${index}`,
    color: ZONE_DEFAULT_COLORS[index - 1] ?? '#5e8aa8',
    type: 'Disabled' as ZoneType,
    x1_mm: 0,
    y1_mm: 0,
    x2_mm: 0,
    y2_mm: 0,
  }));
}

export function default_presence_config(device_id: string): PresenceDeviceConfig {
  return {
    device_id,
    room_name: 'Living room',
    room_width_mm: 4000,
    room_depth_mm: 4000,
    px_per_m: null,
    mount_x_offset_mm: 0,
    mount_rotation_deg: 0,
    mount_height_mm: 1200,
    snap_grid_mm: 100,
    snap_enabled: true,
    // Default 'tuner': the live `.29` runs FutureProof's custom satellite1_radar
    // firmware (zones via the on-device HTTP tuner, reboot-to-persist), and the
    // owner chose to keep it (2026-06-07). Switch to 'entity' in the gear after
    // flashing the stock `ld2450` build for live, no-reboot writes.
    firmware_target: 'tuner',
    zones: default_zones(),
    revision: 0,
    status: 'applied',
    reboot_required: false,
    reboot_requested: false,
    last_error: null,
    updated_at: new Date().toISOString(),
  };
}

/** Default device id — the household's single Satellite1 today. Keyed so a
 *  second device is a row, not a migration. */
export const DEFAULT_PRESENCE_DEVICE_ID = process.env.HEARTH_VC_DEVICE_NAME ?? 'satellite1';

/** Calibration patch — the gear's fields. Zone presentation (name/color) rides
 *  here too (it's not a device write), keyed by index; corners/type do NOT. */
export interface CalibrationPatch {
  room_name?: string;
  room_width_mm?: number;
  room_depth_mm?: number;
  px_per_m?: number | null;
  mount_x_offset_mm?: number;
  mount_rotation_deg?: number;
  mount_height_mm?: number;
  snap_grid_mm?: number;
  snap_enabled?: boolean;
  firmware_target?: FirmwareTarget;
  /** Per-zone presentation, matched by index. */
  zones?: Array<{ index: 1 | 2 | 3; name?: string; color?: string }>;
}

/** The desired-config slice the coordinator pulls to apply. */
export interface PendingZones {
  device_id: string;
  revision: number;
  zones: ZoneRect[];
  firmware_target: FirmwareTarget;
  reboot_requested: boolean;
}

export class PresenceZonesStore {
  constructor(private db: Database) {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS presence_zones (
         device_id TEXT PRIMARY KEY,
         config_json TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    );
  }

  /** Full config for a device (stored values merged over defaults). */
  get(device_id: string = DEFAULT_PRESENCE_DEVICE_ID): PresenceDeviceConfig {
    const row = this.db
      .prepare(`SELECT config_json FROM presence_zones WHERE device_id = @id`)
      .get({ '@id': device_id }) as { config_json: string } | undefined;
    const base = default_presence_config(device_id);
    if (!row) return base;
    try {
      const stored = JSON.parse(row.config_json) as Partial<PresenceDeviceConfig>;
      // Zones merge by replacement (the stored array is authoritative when
      // present), everything else shallow-merges over defaults.
      return {
        ...base,
        ...stored,
        device_id,
        zones: Array.isArray(stored.zones) && stored.zones.length > 0 ? stored.zones : base.zones,
      };
    } catch {
      return base;
    }
  }

  private _write(cfg: PresenceDeviceConfig): void {
    const now = new Date().toISOString();
    cfg.updated_at = now;
    this.db
      .prepare(
        `INSERT INTO presence_zones (device_id, config_json, updated_at)
           VALUES (@id, @json, @now)
         ON CONFLICT(device_id) DO UPDATE SET config_json = @json, updated_at = @now`,
      )
      .run({ '@id': cfg.device_id, '@json': JSON.stringify(cfg), '@now': now });
  }

  /**
   * The editor's "Save" — replace the device-relevant zone fields (type +
   * corners) per index, preserving each zone's presentation (name/color),
   * bump `revision`, flip `status` to `pending`. The coordinator applies it
   * next poll. Returns the new config.
   */
  set_zones(
    device_id: string,
    zones: Array<Pick<ZoneRect, 'index' | 'type' | 'x1_mm' | 'y1_mm' | 'x2_mm' | 'y2_mm'> & Partial<Pick<ZoneRect, 'name' | 'color'>>>,
  ): PresenceDeviceConfig {
    const cfg = this.get(device_id);
    const by_index = new Map(cfg.zones.map((z) => [z.index, z]));
    for (const incoming of zones) {
      const existing = by_index.get(incoming.index);
      const merged: ZoneRect = {
        index: incoming.index,
        name: incoming.name ?? existing?.name ?? `Zone ${incoming.index}`,
        color: incoming.color ?? existing?.color ?? (ZONE_DEFAULT_COLORS[incoming.index - 1] ?? '#5e8aa8'),
        type: incoming.type,
        x1_mm: incoming.x1_mm,
        y1_mm: incoming.y1_mm,
        x2_mm: incoming.x2_mm,
        y2_mm: incoming.y2_mm,
      };
      by_index.set(incoming.index, merged);
    }
    cfg.zones = ([1, 2, 3] as const)
      .map((i) => by_index.get(i))
      .filter((z): z is ZoneRect => Boolean(z));
    cfg.revision += 1;
    cfg.status = 'pending';
    cfg.last_error = null;
    this._write(cfg);
    return cfg;
  }

  /**
   * The gear's "Save" — merge room/mount/snap/scale/firmware + per-zone
   * presentation (name/color, by index). Does NOT bump `revision` or change
   * zone corners/type: presentation isn't a device write.
   */
  set_calibration(device_id: string, patch: CalibrationPatch): PresenceDeviceConfig {
    const cfg = this.get(device_id);
    const { zones: zone_presentation, ...rest } = patch;
    for (const [k, v] of Object.entries(rest) as [keyof Omit<CalibrationPatch, 'zones'>, unknown][]) {
      if (v === undefined) continue;
      (cfg as unknown as Record<string, unknown>)[k] = v;
    }
    if (zone_presentation) {
      const by_index = new Map(cfg.zones.map((z) => [z.index, z]));
      for (const p of zone_presentation) {
        const z = by_index.get(p.index);
        if (!z) continue;
        if (p.name !== undefined) z.name = p.name;
        if (p.color !== undefined) z.color = p.color;
      }
      cfg.zones = Array.from(by_index.values()).sort((a, b) => a.index - b.index);
    }
    this._write(cfg);
    return cfg;
  }

  /** The coordinator's poll — returns the desired config to apply when a write
   *  is pending (or a reboot was requested), else null. */
  get_pending(device_id: string = DEFAULT_PRESENCE_DEVICE_ID): PendingZones | null {
    const cfg = this.get(device_id);
    if (cfg.status !== 'pending' && !cfg.reboot_requested) return null;
    return {
      device_id: cfg.device_id,
      revision: cfg.revision,
      zones: cfg.zones,
      firmware_target: cfg.firmware_target,
      reboot_requested: cfg.reboot_requested,
    };
  }

  /** The coordinator's ack — flip to applied/error, record reboot_required,
   *  and clear any pending reboot request once a write+reboot cycle is done.
   *  A stale-revision ack (the editor saved again mid-apply) is ignored so the
   *  newer pending revision survives. */
  ack(
    device_id: string,
    revision: number,
    result: { applied: boolean; reboot_required?: boolean; error?: string | null },
  ): PresenceDeviceConfig {
    const cfg = this.get(device_id);
    if (revision !== cfg.revision) return cfg; // superseded by a newer save
    cfg.status = result.applied ? 'applied' : 'error';
    cfg.reboot_required = Boolean(result.reboot_required);
    cfg.last_error = result.error ?? null;
    if (result.applied) cfg.reboot_requested = false;
    this._write(cfg);
    return cfg;
  }

  /** Owner pressed "Reboot device" — the coordinator picks this up on its next
   *  poll and reboots the device (which drops the voice session, so it's
   *  explicit, never automatic). */
  request_reboot(device_id: string = DEFAULT_PRESENCE_DEVICE_ID): PresenceDeviceConfig {
    const cfg = this.get(device_id);
    cfg.reboot_requested = true;
    this._write(cfg);
    return cfg;
  }
}
