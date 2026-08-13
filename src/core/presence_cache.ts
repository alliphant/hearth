/**
 * PresenceLiveCache — the in-process, EPHEMERAL cache of the most recent
 * LD2450 target snapshot per device.
 *
 * Live mmWave targets are ~10 Hz, transient, and worthless a few hundred
 * milliseconds after they land — so they are deliberately NOT persisted to
 * SQLite (same call as the `WorkoutSessionTracker` ephemeral push-ledger). The
 * Voice Coordinator republishes a throttled snapshot to
 * `POST /api/presence/targets`; that route writes it here and fans it out over
 * SSE. The presence office pane reads the latest snapshot here so a cold page
 * load paints a first frame before the next SSE frame arrives.
 *
 * Liveness is derived, not asserted: a snapshot is "live" only if a republish
 * landed within `LIVE_TTL_MS`. With no coordinator holding the device session
 * (HA owns `.29` today — see design-ld2450-zone-editor.md §8) nothing
 * republishes, so `is_live()` is false and the office degrades to
 * read-only/unavailable instead of pretending stale data is current.
 *
 * Process singleton via `get_presence_cache()` — mirrors the
 * `location_awareness` process-wide cache. The route writes it; the pane
 * composer reads it; neither owns its lifecycle.
 */

/** One tracked target in the radar's own frame (origin = sensor). All
 *  millimeters, X signed (−left/+right), Y positive-away. Mirrors the
 *  coordinator's `PresenceSnapshot.to_wire()` per-target shape. */
export interface PresenceTarget {
  /** 1-based target slot (the LD2450 tracks up to 3). */
  index: number;
  x_mm: number;
  y_mm: number;
  /** Signed speed along the radar's reported direction (mm/s); + = away. */
  speed_mms: number;
  /** Reported azimuth in degrees, if the firmware exposes it. */
  angle_deg: number | null;
  /** √(x²+y²) in mm — distance from the sensor. */
  distance_mm: number;
  /** False for an empty/idle target slot (x=y=0 with no presence). */
  active: boolean;
}

/** The wire snapshot the coordinator republishes and the pane/SSE consume. */
export interface PresenceSnapshot {
  device_id: string;
  present: boolean;
  moving: number;
  still: number;
  /** Distance (mm) to the nearest active target, or null when empty. */
  nearest_mm: number | null;
  targets: PresenceTarget[];
  /** ISO 8601 UTC stamp from the coordinator at capture time. */
  captured_at: string;
}

/** How long after the last republish a snapshot is still considered live.
 *  The coordinator republishes at ≤4 Hz; 10 s tolerates a brief stall /
 *  reconnect without flapping the "unavailable" banner. Override via env so
 *  a noisier network can widen it without a code change. */
const LIVE_TTL_MS = Number(process.env.HEARTH_PRESENCE_LIVE_TTL_MS ?? 10_000);

interface CacheEntry {
  snapshot: PresenceSnapshot;
  /** Monotonic-ish wall-clock ms when this snapshot was received. */
  received_at_ms: number;
}

export class PresenceLiveCache {
  private entries = new Map<string, CacheEntry>();

  /** Record the latest snapshot for a device. Called by the targets route
   *  AFTER Zod validation. Overwrites any prior snapshot for the device. */
  set(snapshot: PresenceSnapshot): void {
    this.entries.set(snapshot.device_id, { snapshot, received_at_ms: Date.now() });
  }

  /** The latest snapshot for a device, or null if none received. Does NOT
   *  consider liveness — callers that need "is this current" use `is_live`. */
  get(device_id: string): PresenceSnapshot | null {
    return this.entries.get(device_id)?.snapshot ?? null;
  }

  /** True when a republish landed within `LIVE_TTL_MS` — i.e. the coordinator
   *  is actively holding the device session and feeding targets. */
  is_live(device_id: string): boolean {
    const e = this.entries.get(device_id);
    if (!e) return false;
    return Date.now() - e.received_at_ms <= LIVE_TTL_MS;
  }

  /** Milliseconds since the last republish for a device, or null if none. */
  age_ms(device_id: string): number | null {
    const e = this.entries.get(device_id);
    if (!e) return null;
    return Date.now() - e.received_at_ms;
  }

  /** Device ids with any cached snapshot (live or stale). */
  device_ids(): string[] {
    return Array.from(this.entries.keys());
  }
}

let _singleton: PresenceLiveCache | null = null;

/** Process-wide singleton accessor. The route and the pane composer both
 *  reach for the same instance through this. */
export function get_presence_cache(): PresenceLiveCache {
  if (!_singleton) _singleton = new PresenceLiveCache();
  return _singleton;
}

/** Test seam — reset the singleton so a smoke gets a clean cache. */
export function _reset_presence_cache_for_test(): void {
  _singleton = null;
}
