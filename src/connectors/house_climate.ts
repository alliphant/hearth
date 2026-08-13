/**
 * House-climate connector — the fused "state of the house thermals" read
 * (house-fusion Phase 1, 2026-07-13).
 *
 * The indoor sibling of `tempest_conditions` (outdoor ground truth) and the
 * thermal counterpart of `airthings_conditions` (pollutants): ONE typed read
 * that fuses, from a single HA `/api/states` dump:
 *   - the ecobee thermostat's `climate.*` entity — current temp, target
 *     SETPOINT(s), `hvac_action` (actively heating/cooling/idle), mode, fan,
 *     thermostat humidity;
 *   - the per-zone temperature points (ecobee SmartSensors + AirThings
 *     monitors), each with optional humidity + occupancy;
 *   - the on-property outdoor reference (Tempest temp + humidity), so every
 *     zone carries an honest indoor-outdoor delta.
 *
 * Why typed (not raw `ha_get_state`): "is the AC actually running and what's
 * it chasing" is a many-entity question — a curated, owner-named surface
 * answers it in one call, and `house_thermal_history` (the efficiency
 * analysis over recorder history) reads the SAME zone map, so the now-read
 * and the trend-read can never disagree about what a zone is.
 *
 * Entity resolution is CONFIGURABLE, read at CALL time (no restart to
 * re-point). Defaults are the live household's verified entity ids
 * (2026-07-13 inventory):
 *   - `HEARTH_HVAC_CLIMATE_ENTITY` (default `climate.home`) — the thermostat.
 *   - `HEARTH_HOUSE_ZONES` — semicolon-separated zone defs, each
 *     `Label|temp_entity|humidity_entity|occupancy_entity` (empty slots
 *     allowed: `Attic|sensor.attic_temperature||`). Defaults to the four
 *     live zones (Main Floor / Basement / En Suite / Living Room).
 *   - Outdoor reference self-configures from the Tempest connector's
 *     `HEARTH_TEMPEST_ENTITY_PREFIX` (`_temperature` / `_humidity`
 *     suffixes); override individually via `HEARTH_HOUSE_OUTDOOR_TEMP` /
 *     `HEARTH_HOUSE_OUTDOOR_HUMIDITY`.
 * When neither the thermostat nor any zone resolves, the tool degrades to
 * `{ ok:false, error, candidates }` listing the climate-shaped entities HA
 * DOES have — the same recovery-hint pattern as its siblings.
 *
 * Units pass through HONESTLY from HA (`unit_of_measurement`) — never
 * inferred. The one exception is `climate.*` attributes, which carry no unit
 * attribute in HA; their unit is reported as the first resolved zone/outdoor
 * temperature unit (they share the HA system unit) or null.
 */

import { z } from 'zod';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import { require_caller_tier } from '@core/tool_gates';
import { fetch_ha_all_states, type HAEntityState } from './home_assistant';

// ── Zone + entity resolution (read at call time) ───────────────────────────

export interface ZoneDef {
  /** Display label used in messages + the `zones` map key. */
  label: string;
  /** Full entity id of the zone's temperature sensor. */
  temp: string;
  /** Optional humidity sensor entity id. */
  humidity: string | null;
  /** Optional occupancy binary_sensor entity id. */
  occupancy: string | null;
}

// The live household's zones (verified 2026-07-13): the ecobee thermostat +
// two SmartSensors carry temperature AND occupancy; the AirThings monitors
// fill in humidity where a room has one, and Living Room is AirThings-only.
const DEFAULT_ZONES: readonly ZoneDef[] = [
  {
    label: 'Main Floor',
    temp: 'sensor.home_temperature',
    humidity: null, // the thermostat's own humidity rides on the hvac block
    occupancy: 'binary_sensor.home_occupancy',
  },
  {
    label: 'Basement',
    temp: 'sensor.basement_temperature',
    humidity: 'sensor.basement_view_plus_humidity',
    occupancy: 'binary_sensor.basement_occupancy',
  },
  {
    label: 'En Suite',
    temp: 'sensor.en_suite_temperature',
    humidity: 'sensor.en_suite_airthings_humidity',
    occupancy: 'binary_sensor.en_suite_occupancy',
  },
  {
    label: 'Living Room',
    temp: 'sensor.living_room_temperature',
    humidity: 'sensor.living_room_humidity',
    occupancy: null,
  },
];

/** Parse `Label|temp|humidity|occupancy;...` — empty slots become null. */
export function house_zones(): ZoneDef[] {
  const raw = process.env.HEARTH_HOUSE_ZONES;
  if (!raw || !raw.trim()) return [...DEFAULT_ZONES];
  const parsed = raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry): ZoneDef | null => {
      const parts = entry.split('|').map((p) => p.trim());
      const label = parts[0];
      const temp = parts[1];
      if (!label || !temp) return null;
      return {
        label,
        temp,
        humidity: parts[2] || null,
        occupancy: parts[3] || null,
      };
    })
    .filter((z): z is ZoneDef => z !== null);
  return parsed.length ? parsed : [...DEFAULT_ZONES];
}

export function hvac_climate_entity(): string {
  return process.env.HEARTH_HVAC_CLIMATE_ENTITY?.trim() || 'climate.home';
}

export function outdoor_temp_entity(): string {
  const explicit = process.env.HEARTH_HOUSE_OUTDOOR_TEMP?.trim();
  if (explicit) return explicit;
  const prefix = (process.env.HEARTH_TEMPEST_ENTITY_PREFIX ?? 'sensor.tempest').replace(/\.+$/, '');
  return `${prefix}_temperature`;
}

export function outdoor_humidity_entity(): string {
  const explicit = process.env.HEARTH_HOUSE_OUTDOOR_HUMIDITY?.trim();
  if (explicit) return explicit;
  const prefix = (process.env.HEARTH_TEMPEST_ENTITY_PREFIX ?? 'sensor.tempest').replace(/\.+$/, '');
  return `${prefix}_humidity`;
}

// The Phase-3 outdoor context set (2026-07-13): wind explains infiltration-
// driven heat loss (a windy night reads as a worse envelope than a calm one at
// the same ΔT), irradiance is the honest denominator for "are the panels
// underperforming the light that actually fell". Suffixes match HA's core
// WeatherFlow integration (see connectors/tempest.ts MEASUREMENTS).

export function outdoor_wind_entity(): string {
  const explicit = process.env.HEARTH_HOUSE_OUTDOOR_WIND?.trim();
  if (explicit) return explicit;
  const prefix = (process.env.HEARTH_TEMPEST_ENTITY_PREFIX ?? 'sensor.tempest').replace(/\.+$/, '');
  return `${prefix}_wind_speed_average`;
}

export function outdoor_gust_entity(): string {
  const explicit = process.env.HEARTH_HOUSE_OUTDOOR_GUST?.trim();
  if (explicit) return explicit;
  const prefix = (process.env.HEARTH_TEMPEST_ENTITY_PREFIX ?? 'sensor.tempest').replace(/\.+$/, '');
  return `${prefix}_wind_gust`;
}

export function outdoor_irradiance_entity(): string {
  const explicit = process.env.HEARTH_HOUSE_OUTDOOR_IRRADIANCE?.trim();
  if (explicit) return explicit;
  const prefix = (process.env.HEARTH_TEMPEST_ENTITY_PREFIX ?? 'sensor.tempest').replace(/\.+$/, '');
  return `${prefix}_irradiance`;
}

/**
 * Correct `hvac_action` against ecobee's raw `equipment_running` string when
 * the entity carries one (the community fork exposes it verbatim, e.g.
 * "compCool1,fan"). Found live 2026-07-18: the fork labeled every
 * compressor-and-fan interval `fan` (its keyword table is right but it
 * matched EXACT set members against NUMBERED equipment names — `compCool` ∉
 * {"compCool1","fan"}), so five days of history recorded zero cooling.
 * Equipment truth outranks the reported action: compressor/heat equipment
 * running IS conditioning regardless of the label; with no equipment string
 * (core integration, other thermostats) the reported action passes through.
 */
export function normalize_hvac_action(
  action: string | null,
  equipment_running: string | null,
): string | null {
  const eq = (equipment_running ?? '').toLowerCase();
  if (eq.includes('compcool')) return 'cooling';
  if (/heatpump|compheat|auxheat/.test(eq)) return 'heating';
  return action;
}

// ── Output shapes ──────────────────────────────────────────────────────────

const Reading = z.object({
  entity_id: z.string(),
  /** False when the entity is absent, `unavailable`, or `unknown`. */
  available: z.boolean(),
  value: z.number().nullable(),
  raw: z.string().nullable(),
  /** HA's own `unit_of_measurement` — never inferred. */
  unit: z.string().nullable(),
  as_of: z.string().nullable(),
});
type ReadingT = z.infer<typeof Reading>;

const Hvac = z.object({
  entity_id: z.string(),
  available: z.boolean(),
  /** The climate entity's state — the MODE ("cool", "heat", "heat_cool", "off"). */
  mode: z.string().nullable(),
  /** What the equipment is DOING right now: "heating" | "cooling" | "idle" |
   *  "fan" | "off" — the utilization signal. */
  hvac_action: z.string().nullable(),
  current_temperature: z.number().nullable(),
  /** Single-setpoint target (heat or cool mode). Null in heat_cool mode. */
  setpoint: z.number().nullable(),
  /** Range setpoints (heat_cool mode). Null in single-setpoint modes. */
  setpoint_low: z.number().nullable(),
  setpoint_high: z.number().nullable(),
  fan_mode: z.string().nullable(),
  preset_mode: z.string().nullable(),
  /** The thermostat's own humidity reading (%). */
  humidity: z.number().nullable(),
  /** Temperature unit shared by the climate values (from a resolved zone /
   *  outdoor sensor — climate attributes carry no unit of their own). */
  unit: z.string().nullable(),
  as_of: z.string().nullable(),
});

const Zone = z.object({
  temperature: Reading,
  humidity: Reading.nullable(),
  /** true/false from the occupancy binary_sensor; null when the zone has none. */
  occupied: z.boolean().nullable(),
  /** zone temp − outdoor temp (positive = warmer inside). Null unless both resolved. */
  delta_to_outdoor: z.number().nullable(),
  /** zone temp − active setpoint (signed; single-setpoint mode only). */
  delta_to_setpoint: z.number().nullable(),
});

const ZoneExtreme = z.object({
  zone: z.string(),
  value: z.number(),
  unit: z.string().nullable(),
});

const Signals = z.object({
  /** hvac_action collapsed to the one-word utilization answer. */
  conditioning: z.string().nullable(),
  /** current_temperature − active setpoint (signed). Null in heat_cool/off. */
  setpoint_gap: z.number().nullable(),
  /** thermostat current temp − outdoor temp. */
  indoor_outdoor_delta: z.number().nullable(),
  warmest_zone: ZoneExtreme.nullable(),
  coolest_zone: ZoneExtreme.nullable(),
  /** Labels of zones whose occupancy sensor reads occupied right now. */
  occupied_zones: z.array(z.string()),
});

const HouseClimateInput = z.object({}).strict();

const HouseClimateOutput = z.object({
  ok: z.boolean(),
  source: z.literal('home_assistant'),
  error: z.string().optional(),
  recovery_hint: z.string().optional(),
  /** Set only when NOTHING resolved — climate/thermostat-shaped entities HA
   *  actually has, so the operator/LLM can re-point the env config. */
  candidates: z
    .array(z.object({ entity_id: z.string(), friendly_name: z.string().nullable() }))
    .optional(),
  as_of: z.string().nullable().optional(),
  resolved_count: z.number().int().optional(),
  requested_count: z.number().int().optional(),
  /** `<zone>.<reading>` keys whose entity was absent/unavailable. */
  missing: z.array(z.string()).optional(),
  hvac: Hvac.optional(),
  outdoor: z
    .object({ temperature: Reading, humidity: Reading })
    .optional(),
  zones: z.record(z.string(), Zone).optional(),
  signals: Signals.optional(),
});

type HouseClimateOut = z.infer<typeof HouseClimateOutput>;

// ── Parsing helpers ────────────────────────────────────────────────────────

const UNAVAILABLE = new Set(['unavailable', 'unknown', '']);

function parse_number(state: string): number | null {
  const n = Number.parseFloat(state);
  return Number.isFinite(n) ? n : null;
}

function attr_number(attrs: Record<string, unknown> | undefined, key: string): number | null {
  const v = attrs?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function attr_string(attrs: Record<string, unknown> | undefined, key: string): string | null {
  const v = attrs?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function read_entity(by_id: Map<string, HAEntityState>, entity_id: string): ReadingT {
  const ha = by_id.get(entity_id);
  const unit =
    ha && typeof ha.attributes?.unit_of_measurement === 'string'
      ? ha.attributes.unit_of_measurement
      : null;
  const state = ha?.state;
  const available =
    ha !== undefined && state !== undefined && !UNAVAILABLE.has(state.toLowerCase());
  return {
    entity_id,
    available,
    value: available ? parse_number(state as string) : null,
    raw: state ?? null,
    unit,
    as_of: ha?.last_changed ?? null,
  };
}

// ── Candidate discovery (recovery path) ────────────────────────────────────

const CLIMATEISH = /climate\.|thermostat|ecobee|hvac|temperature|occupancy|setpoint/i;

function climate_candidates(
  states: HAEntityState[],
): Array<{ entity_id: string; friendly_name: string | null }> {
  return states
    .filter(
      (e) =>
        e.entity_id.startsWith('climate.') ||
        e.entity_id.startsWith('sensor.') ||
        e.entity_id.startsWith('binary_sensor.'),
    )
    .filter((e) => {
      const fn =
        typeof e.attributes?.friendly_name === 'string' ? e.attributes.friendly_name : '';
      return CLIMATEISH.test(e.entity_id) || CLIMATEISH.test(fn);
    })
    .slice(0, 24)
    .map((e) => ({
      entity_id: e.entity_id,
      friendly_name:
        typeof e.attributes?.friendly_name === 'string' ? e.attributes.friendly_name : null,
    }));
}

// ── Test seam ──────────────────────────────────────────────────────────────

type StatesResult = { ok: true; states: HAEntityState[] } | { ok: false; reason: string };
let _states_provider: () => Promise<StatesResult> = fetch_ha_all_states;

/** Test-only: swap the HA state provider to return canned entities. */
export function _test_set_states_provider(fn: () => Promise<StatesResult>): void {
  _states_provider = fn;
}
/** Test-only: restore the live HA state provider. */
export function _test_reset_states_provider(): void {
  _states_provider = fetch_ha_all_states;
}

// ── Audit ──────────────────────────────────────────────────────────────────

function audit(ctx: ToolContext, input: unknown, out: HouseClimateOut): void {
  // Reads HA entity state only — no coords / PII, nothing to redact.
  ctx.memory?.log_action?.({
    intent_id: ctx.intent_id || ulid(),
    agent: ctx.specialist_id || 'house_climate_connector',
    tool_name: 'house_climate',
    tool_input: input as Record<string, unknown>,
    execution_result: {
      ok: out.ok,
      resolved_count: out.resolved_count ?? 0,
      missing_count: out.missing?.length ?? 0,
      hvac_action: out.hvac?.hvac_action ?? null,
    },
    error: out.error,
  });
}

// ── Tool ────────────────────────────────────────────────────────────────────

export const house_climate: Tool<z.infer<typeof HouseClimateInput>, HouseClimateOut> = {
  name: 'house_climate',
  description:
    "Fused CURRENT state of the house's thermals (via Home Assistant): the thermostat's target SETPOINT + `hvac_action` (whether the HVAC is actively heating / cooling / idle RIGHT NOW — the utilization answer) + mode/fan/preset, per-zone indoor temperatures (Main Floor, Basement, En Suite, Living Room) with humidity + occupancy where the zone has sensors, and the on-property outdoor temperature + humidity reference so every zone carries its indoor-outdoor delta. A `signals` digest answers the common questions in one glance: conditioning (heating/cooling/idle), setpoint gap, indoor-outdoor delta, warmest/coolest zone, occupied zones. Use this for 'is the AC running', 'what's the house set to', 'which room is hottest', and as the now-state companion to house_thermal_history (which analyzes efficiency over time). If nothing resolves the result carries `candidates` — the climate-shaped entities HA has — so the zone config can be re-pointed.",
  risk: 'read',
  required_capabilities: ['read_house_climate'],
  // Bounded, structured output — every field carries weight; don't truncate.
  llm_budget: 'full',
  input_schema: HouseClimateInput,
  output_schema: HouseClimateOutput,

  idempotency_key() {
    return 'house_climate:v1';
  },

  async execute(input, ctx: ToolContext): Promise<HouseClimateOut> {
    // Whole-house temperature + occupancy is household data — owner +
    // household read; friend tier defers (mirrors airthings_conditions).
    require_caller_tier(ctx, ['owner', 'household']);

    const fetched = await _states_provider();
    if (!fetched.ok) {
      const out: HouseClimateOut = {
        ok: false,
        source: 'home_assistant',
        error: `Could not read Home Assistant: ${fetched.reason}`,
        recovery_hint: fetched.reason.includes('HA_TOKEN')
          ? 'HA_TOKEN not configured on the orchestrator — set HA_BASE_URL + HA_TOKEN in hearth.env so Hearth can read the climate entities.'
          : 'Home Assistant was unreachable. Check HA_BASE_URL reachability from the orchestrator host; retry shortly.',
      };
      audit(ctx, input, out);
      return out;
    }

    const by_id = new Map<string, HAEntityState>();
    for (const e of fetched.states) by_id.set(e.entity_id, e);

    const missing: string[] = [];
    let resolved_count = 0;
    let requested_count = 0;
    let newest_as_of: string | null = null;
    const bump = (r: ReadingT, key: string): ReadingT => {
      requested_count++;
      if (r.available) {
        resolved_count++;
        if (r.as_of && (newest_as_of === null || r.as_of > newest_as_of)) newest_as_of = r.as_of;
      } else {
        missing.push(key);
      }
      return r;
    };

    // ── thermostat ──
    const climate_id = hvac_climate_entity();
    const climate_row = by_id.get(climate_id);
    requested_count++;
    const climate_available =
      climate_row !== undefined && !UNAVAILABLE.has(climate_row.state.toLowerCase());
    if (climate_available) resolved_count++;
    else missing.push('hvac.climate');

    // ── outdoor reference ──
    const outdoor_temp = bump(read_entity(by_id, outdoor_temp_entity()), 'outdoor.temperature');
    const outdoor_hum = bump(read_entity(by_id, outdoor_humidity_entity()), 'outdoor.humidity');

    // ── zones ──
    const zone_defs = house_zones();
    const zones_out: Record<string, z.infer<typeof Zone>> = {};
    let unit_hint: string | null = outdoor_temp.available ? outdoor_temp.unit : null;

    const attrs = climate_available ? climate_row.attributes : undefined;
    const setpoint = attr_number(attrs, 'temperature');
    const setpoint_low = attr_number(attrs, 'target_temp_low');
    const setpoint_high = attr_number(attrs, 'target_temp_high');
    const current_temperature = attr_number(attrs, 'current_temperature');

    const occupied_zones: string[] = [];
    let warmest: z.infer<typeof ZoneExtreme> | null = null;
    let coolest: z.infer<typeof ZoneExtreme> | null = null;

    for (const zone of zone_defs) {
      const temp = bump(read_entity(by_id, zone.temp), `${zone.label}.temperature`);
      if (temp.available && temp.unit && !unit_hint) unit_hint = temp.unit;

      let humidity: ReadingT | null = null;
      if (zone.humidity) humidity = bump(read_entity(by_id, zone.humidity), `${zone.label}.humidity`);

      let occupied: boolean | null = null;
      if (zone.occupancy) {
        requested_count++;
        const occ = by_id.get(zone.occupancy);
        if (occ && !UNAVAILABLE.has(occ.state.toLowerCase())) {
          resolved_count++;
          occupied = occ.state.toLowerCase() === 'on';
          if (occupied) occupied_zones.push(zone.label);
        } else {
          missing.push(`${zone.label}.occupancy`);
        }
      }

      const t = temp.available ? temp.value : null;
      if (t !== null) {
        if (warmest === null || t > warmest.value) warmest = { zone: zone.label, value: t, unit: temp.unit };
        if (coolest === null || t < coolest.value) coolest = { zone: zone.label, value: t, unit: temp.unit };
      }

      zones_out[zone.label] = {
        temperature: temp,
        humidity,
        occupied,
        delta_to_outdoor:
          t !== null && outdoor_temp.value !== null
            ? Number((t - outdoor_temp.value).toFixed(1))
            : null,
        delta_to_setpoint:
          t !== null && setpoint !== null ? Number((t - setpoint).toFixed(1)) : null,
      };
    }

    // NOTHING resolved → candidates recovery (config points at a dead set).
    if (resolved_count === 0) {
      const out: HouseClimateOut = {
        ok: false,
        source: 'home_assistant',
        error: `No climate entities resolved (thermostat ${climate_id}, ${zone_defs.length} zones, outdoor reference). The configured entity ids may not match this HA instance.`,
        recovery_hint:
          'Re-point HEARTH_HVAC_CLIMATE_ENTITY / HEARTH_HOUSE_ZONES / HEARTH_HOUSE_OUTDOOR_TEMP at the candidate entity ids below.',
        candidates: climate_candidates(fetched.states),
        requested_count,
        resolved_count,
      };
      audit(ctx, input, out);
      return out;
    }

    const hvac_action = normalize_hvac_action(
      attr_string(attrs, 'hvac_action'),
      attr_string(attrs, 'equipment_running'),
    );
    const out: HouseClimateOut = {
      ok: true,
      source: 'home_assistant',
      as_of: newest_as_of,
      resolved_count,
      requested_count,
      ...(missing.length ? { missing } : {}),
      hvac: {
        entity_id: climate_id,
        available: climate_available,
        mode: climate_available ? climate_row.state : null,
        hvac_action,
        current_temperature,
        setpoint,
        setpoint_low,
        setpoint_high,
        fan_mode: attr_string(attrs, 'fan_mode'),
        preset_mode: attr_string(attrs, 'preset_mode'),
        humidity: attr_number(attrs, 'current_humidity'),
        unit: unit_hint,
        as_of: climate_row?.last_changed ?? null,
      },
      outdoor: { temperature: outdoor_temp, humidity: outdoor_hum },
      zones: zones_out,
      signals: {
        conditioning: hvac_action,
        setpoint_gap:
          current_temperature !== null && setpoint !== null
            ? Number((current_temperature - setpoint).toFixed(1))
            : null,
        indoor_outdoor_delta:
          current_temperature !== null && outdoor_temp.value !== null
            ? Number((current_temperature - outdoor_temp.value).toFixed(1))
            : null,
        warmest_zone: warmest,
        coolest_zone: coolest,
        occupied_zones,
      },
    };
    audit(ctx, input, out);
    return out;
  },
};
