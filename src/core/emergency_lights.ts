/**
 * Emergency light flash — the third alert channel (2026-06-26).
 *
 * On a CRITICAL (EBS) alert — tornado / flash-flood / extreme-wind / fire
 * warning, the CO₂-leak klaxon, a real CO/smoke alarm, or the manual critical
 * drill — smoothly fade the household's lights to RED and back over ~4-5s, then
 * restore EVERY light to exactly its prior state. A visual alarm that reaches you
 * when you're not near a speaker, asleep, or can't hear it — alongside the tone +
 * push. Deterministic + fail-open, composed in code (never an LLM decision); the
 * single WRITE into HA is `ha_call_service` (a code helper, not a model tool).
 *
 * SPEED + SMOOTHNESS (redesigned 2026-06-26 #2 after a live test). The naïve
 * version addressed all ~46 Hue bulbs individually, and the Hue bridge processes
 * each over Zigbee serially (~130 ms × 46 = 6 s, and they flip at different
 * moments = a jagged wave). Two fixes:
 *   1. Target Hue ROOM GROUPS (`is_hue_group` entities), not the member bulbs —
 *      one bridge group-cast per room changes all its bulbs AT ONCE, fast
 *      (measured 1.5 s for 9 groups vs 6 s for 46 bulbs). Lutron / ungrouped
 *      lights are flashed individually (few of them).
 *   2. Use `transition` so the fade is interpolated IN HARDWARE — a smooth
 *      current→red→current ramp, not a hard on/off strobe.
 *
 * The restore stays PER-BULB (snapshot the individual bulbs, not the groups) so a
 * multi-bulb / gradient room comes back to its exact prior per-bulb state — a
 * group-level restore would uniformise it. Restore runs in `finally`, so a
 * failure mid-flash never leaves the house red; fail-SAFE on the snapshot (no
 * restore point → never flash).
 *
 * DARK by default (`HEARTH_EMERGENCY_LIGHT_FLASH=1`).
 */
import { ha_call_service, fetch_ha_all_states, type HAEntityState } from '@connectors/home_assistant';
import type { MemoryClient } from '@memory/client';

export function emergency_light_flash_enabled(): boolean {
  return process.env.HEARTH_EMERGENCY_LIGHT_FLASH === '1';
}

function env_int(name: string, def: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Parse "R,G,B" (0-255 each) from env; falls back to `def` on anything off. */
function parse_rgb(raw: string | undefined, def: [number, number, number]): number[] {
  if (!raw) return def;
  const parts = raw.split(',').map((s) => Number.parseInt(s.trim(), 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return def;
  return parts;
}

const SCENE_ID = 'hearth_emergency_restore';
const SCENE_ENTITY = `scene.${SCENE_ID}`;

/** HA color modes that can render RED (vs brightness-only / tunable-white). */
const COLOR_MODES = new Set(['rgb', 'rgbw', 'rgbww', 'xy', 'hs']);
const UNAVAILABLE = new Set(['unavailable', 'unknown']);

type CallService = (
  domain: string,
  service: string,
  data?: Record<string, unknown>,
) => Promise<{ ok: true } | { ok: false; reason: string }>;
type FetchStates = () => Promise<{ ok: true; states: HAEntityState[] } | { ok: false; reason: string }>;

export interface EmergencyFlashDeps {
  call_service?: CallService;
  fetch_states?: FetchStates;
  sleep?: (ms: number) => Promise<void>;
  memory?: MemoryClient;
}

export interface FlashResult {
  ok: boolean;
  reason?: string;
  cycles: number;
  /** Hue room/zone groups flashed (one group-cast each). */
  group_count: number;
  /** Total flash targets = groups + ungrouped individuals (Lutron, orphan bulbs). */
  target_count: number;
  /** Per-bulb set snapshotted for the accurate restore. */
  snapshot_count: number;
  color_count: number;
  bright_count: number;
  restored: boolean;
}

function attr(s: HAEntityState, key: string): unknown {
  return (s.attributes as Record<string, unknown> | undefined)?.[key];
}
function is_color_capable(s: HAEntityState): boolean {
  const modes = attr(s, 'supported_color_modes');
  return Array.isArray(modes) && modes.some((m) => typeof m === 'string' && COLOR_MODES.has(m));
}
/** A Hue room/zone group entity — flashing it is one bridge group-cast. */
function is_group(s: HAEntityState): boolean {
  return attr(s, 'is_hue_group') === true;
}
/** The member bulb entity_ids of a Hue group. */
function group_members(s: HAEntityState): string[] {
  const ids = attr(s, 'entity_id');
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Smoothly fade the household lights to red and back, then restore. Returns a
 * summary. Fail-open: never throws. `deps` injects the HA transport / sleep.
 */
export async function flash_emergency_lights(deps: EmergencyFlashDeps = {}): Promise<FlashResult> {
  const call: CallService = deps.call_service ?? ha_call_service;
  const fetch_states: FetchStates = deps.fetch_states ?? fetch_ha_all_states;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const cycles = env_int('HEARTH_EMERGENCY_FLASH_CYCLES', 1);
  const ramp_ms = env_int('HEARTH_EMERGENCY_FLASH_RAMP_MS', 1200);
  const hold_ms = env_int('HEARTH_EMERGENCY_FLASH_HOLD_MS', 300);
  const gap_ms = env_int('HEARTH_EMERGENCY_FLASH_GAP_MS', 300);
  const ramp_s = ramp_ms / 1000;
  const rgb = parse_rgb(process.env.HEARTH_EMERGENCY_FLASH_RGB, [255, 0, 0]);
  const exclude = new Set(
    (process.env.HEARTH_EMERGENCY_FLASH_EXCLUDE ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const result: FlashResult = {
    ok: false, cycles, group_count: 0, target_count: 0, snapshot_count: 0,
    color_count: 0, bright_count: 0, restored: false,
  };

  const fetched = await fetch_states().catch((err: unknown) => ({ ok: false as const, reason: String(err) }));
  if (!fetched.ok) {
    result.reason = `state read failed: ${fetched.reason}`;
    audit(deps.memory, result);
    return result;
  }

  const lights = fetched.states.filter(
    (s) => s.entity_id.startsWith('light.') && !UNAVAILABLE.has((s.state ?? '').toLowerCase()),
  );
  const groups = lights.filter(is_group);
  const member_ids = new Set<string>();
  for (const g of groups) for (const m of group_members(g)) member_ids.add(m);

  // FLASH targets: the room GROUPS (one group-cast each) + any UNGROUPED individual
  // (Lutron, orphan bulbs). NOT the individual group members — their group flashes
  // them simultaneously + fast. Excluded entities (e.g. the outdoor sconce) drop out.
  const flash_targets = [...groups, ...lights.filter((s) => !is_group(s) && !member_ids.has(s.entity_id))]
    .filter((s) => !exclude.has(s.entity_id));
  const color_targets = flash_targets.filter(is_color_capable).map((s) => s.entity_id);
  const bright_targets = flash_targets.filter((s) => !is_color_capable(s)).map((s) => s.entity_id);

  // RESTORE set: the individual (non-group) bulbs, so a gradient / multi-bulb room
  // restores to its EXACT per-bulb state (a group-level restore would uniformise it).
  const snapshot_targets = lights
    .filter((s) => !is_group(s) && !exclude.has(s.entity_id))
    .map((s) => s.entity_id);

  result.group_count = groups.filter((s) => !exclude.has(s.entity_id)).length;
  result.target_count = flash_targets.length;
  result.snapshot_count = snapshot_targets.length;
  result.color_count = color_targets.length;
  result.bright_count = bright_targets.length;

  if (flash_targets.length === 0 || snapshot_targets.length === 0) {
    result.reason = 'no controllable lights';
    audit(deps.memory, result);
    return result;
  }

  // 1. Snapshot per-bulb — the restore point. Snapshot fails → do NOT flash (fail-safe).
  const snap = await call('scene', 'create', { scene_id: SCENE_ID, snapshot_entities: snapshot_targets });
  if (!snap.ok) {
    result.reason = `snapshot failed: ${snap.reason}`;
    audit(deps.memory, result);
    return result;
  }

  // 2. Smooth fade → red → back, per cycle. Restore ALWAYS runs (finally).
  let clean_restore = false;
  try {
    for (let i = 0; i < cycles; i++) {
      // Fade to red (groups + ungrouped), interpolated in hardware over `transition`.
      if (color_targets.length) {
        await call('light', 'turn_on', { entity_id: color_targets, rgb_color: rgb, brightness: 255, transition: ramp_s });
      }
      if (bright_targets.length) {
        await call('light', 'turn_on', { entity_id: bright_targets, brightness: 255, transition: ramp_s });
      }
      await sleep(ramp_ms + hold_ms); // let the fade complete + a brief hold at red
      // Smooth per-bulb fade back to the exact prior state.
      const r = await call('scene', 'turn_on', { entity_id: SCENE_ENTITY, transition: ramp_s });
      if (i === cycles - 1) clean_restore = r.ok;
      else await sleep(ramp_ms + gap_ms); // let it settle before the next pulse
    }
    result.ok = true;
  } catch (err) {
    result.reason = `flash error: ${String(err)}`;
  } finally {
    if (!clean_restore) {
      // Error path — make sure the house isn't left red (snap back, no transition).
      const r = await call('scene', 'turn_on', { entity_id: SCENE_ENTITY }).catch(
        (err: unknown) => ({ ok: false as const, reason: String(err) }),
      );
      clean_restore = r.ok;
      if (!r.ok) result.reason = result.reason ?? `restore failed: ${r.reason}`;
    }
    result.restored = clean_restore;
    await call('scene', 'delete', { entity_id: SCENE_ENTITY }).catch(() => undefined); // cleanup, best-effort
  }

  audit(deps.memory, result);
  return result;
}

function audit(memory: MemoryClient | undefined, r: FlashResult): void {
  try {
    memory?.log_action?.({
      intent_id: 'emergency-lights',
      agent: 'emergency_lights',
      tool_name: 'emergency_light_flash',
      tool_input: { cycles: r.cycles, groups: r.group_count, targets: r.target_count, snapshot: r.snapshot_count },
      execution_result: { ok: r.ok, restored: r.restored, color: r.color_count, bright: r.bright_count, reason: r.reason },
    });
  } catch {
    /* audit is best-effort */
  }
}

/**
 * Fire-and-forget convenience for a CRITICAL delivery: gated, fail-open, never
 * awaited on the alert's critical path (the push/speak must not wait on lights).
 */
export function maybe_flash_emergency_lights(deps: EmergencyFlashDeps = {}): void {
  if (!emergency_light_flash_enabled()) return;
  void flash_emergency_lights(deps).catch((err: unknown) =>
    console.error('[emergency-lights] flash failed (swallowed):', err),
  );
}
