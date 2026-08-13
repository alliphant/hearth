/**
 * Tempest weather-station connector — Path 1 (HA-relay).
 *
 * Why this exists: the `weather.ts` connector serves a GEOCODED forecast
 * (Pirate Weather, keyed off home_coords). A WeatherFlow Tempest is a
 * physical station on the property — it reports ACTUAL on-site readings
 * (temp/humidity/pressure, wind speed+dir+gust+lull, rain rate +
 * accumulation, UV/solar/illuminance, and lightning strike count +
 * distance). Forecast and ground-truth are complementary: the forecast
 * says "rain likely this afternoon," the station says "it is raining at
 * 0.04 in/hr right now and there were 2 lightning strikes in the last
 * minute, ~3 mi out."
 *
 * Ingestion path (of three — see docs/design-tempest-weather-integration.md):
 *   1. HA-RELAY (this file). The hub is added to Home Assistant via HA's
 *      native WeatherFlow integration (local LAN UDP, no cloud); HA then
 *      exposes one `sensor.*` entity per measurement. This connector reads
 *      those entities through the EXISTING HA connector and returns a typed
 *      current-conditions object. ONE `/api/states` dump resolves every
 *      measurement; no per-entity round-trips.
 *   2. Direct UDP listener (DESIGN ONLY — needs the device).
 *   3. Cloud "Better Forecast" API (DESIGN ONLY — replaces the geocoded
 *      forecast, needs a token).
 *
 * Entity-id resolution is CONFIGURABLE because the entity prefix is the
 * station's device slug (HA's core WeatherFlow integration names the device
 * after the Tempest serial — e.g. `sensor.st_00214775_*`), not known until
 * the hub is added. Resolution, read at CALL time (no restart to re-point):
 *   - `HEARTH_TEMPEST_ENTITY_PREFIX` (default `sensor.tempest`) — the
 *     station's device slug. The common case is setting this one value; the
 *     default suffix map below matches HA's CORE WeatherFlow integration, so
 *     the prefix alone resolves every measurement on that integration.
 *   - per-measurement override `HEARTH_TEMPEST_<KEY>` (full entity_id) wins
 *     over prefix+suffix — for a differently-named sensor or the community
 *     `weatherflow2mqtt` integration, whose suffixes differ.
 * When no measurement resolves (integration not added yet, or the prefix is
 * wrong) the tool degrades to `{ ok:false, error, candidates }` listing the
 * weather-shaped `sensor.*` entities HA DOES have — the same recovery-hint
 * pattern as `ha_get_state`'s candidates-on-404. Set the prefix to the
 * candidate's device slug and the next read returns real conditions.
 *
 * Units are passed through HONESTLY: each reading carries HA's own
 * `unit_of_measurement` (°F/°C, mph, in/hr, inHg/hPa, mi, …) — the connector
 * never converts or assumes a unit system. Consumers render `{value} {unit}`.
 */

import { z } from 'zod';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import { require_caller_tier } from '@core/tool_gates';
import { fetch_ha_all_states, type HAEntityState } from './home_assistant';

// ── Entity resolution config (read at call time) ──────────────────────────

function tempest_prefix(): string {
  return (process.env.HEARTH_TEMPEST_ENTITY_PREFIX ?? 'sensor.tempest').replace(/\.+$/, '');
}

type ReadingKind = 'number' | 'text';

interface MeasurementDef {
  /** Logical key in the `readings` output map. */
  key: string;
  /** Default entity-id suffix appended to the station prefix. Matches HA's
   *  CORE WeatherFlow integration (verified against a live `sensor.st_*`
   *  device 2026-06-23). Override per-measurement via `HEARTH_TEMPEST_<KEY>`
   *  for a differently-named sensor / a different integration. */
  suffix: string;
  kind: ReadingKind;
}

// The WeatherFlow measurement set HA's CORE integration exposes (24 sensors,
// confirmed live). Every entry is independently overridable; the `candidates`
// recovery path surfaces the real names if a default ever misses.
const MEASUREMENTS: readonly MeasurementDef[] = [
  { key: 'temperature', suffix: '_temperature', kind: 'number' },
  { key: 'feels_like', suffix: '_feels_like', kind: 'number' },
  { key: 'dew_point', suffix: '_dew_point', kind: 'number' },
  { key: 'wet_bulb', suffix: '_wet_bulb_temperature', kind: 'number' },
  { key: 'humidity', suffix: '_humidity', kind: 'number' },
  { key: 'pressure', suffix: '_air_pressure', kind: 'number' },
  { key: 'vapor_pressure', suffix: '_vapor_pressure', kind: 'number' },
  { key: 'air_density', suffix: '_air_density', kind: 'number' },
  { key: 'wind_speed', suffix: '_wind_speed', kind: 'number' },
  { key: 'wind_speed_avg', suffix: '_wind_speed_average', kind: 'number' },
  { key: 'wind_gust', suffix: '_wind_gust', kind: 'number' },
  { key: 'wind_lull', suffix: '_wind_lull', kind: 'number' },
  { key: 'wind_direction', suffix: '_wind_direction', kind: 'number' },
  { key: 'wind_direction_avg', suffix: '_wind_direction_average', kind: 'number' },
  { key: 'rain_rate', suffix: '_precipitation_intensity', kind: 'number' },
  { key: 'precipitation', suffix: '_precipitation', kind: 'number' },
  { key: 'precip_type', suffix: '_precipitation_type', kind: 'text' },
  { key: 'uv_index', suffix: '_uv_index', kind: 'number' },
  { key: 'solar_radiation', suffix: '_irradiance', kind: 'number' },
  { key: 'illuminance', suffix: '_illuminance', kind: 'number' },
  { key: 'lightning_count', suffix: '_lightning_count', kind: 'number' },
  { key: 'lightning_distance', suffix: '_lightning_average_distance', kind: 'number' },
  { key: 'battery', suffix: '_battery', kind: 'number' },
  { key: 'battery_voltage', suffix: '_battery_voltage', kind: 'number' },
];

function entity_id_for(def: MeasurementDef): string {
  const override = process.env[`HEARTH_TEMPEST_${def.key.toUpperCase()}`];
  if (override && override.trim()) return override.trim();
  return `${tempest_prefix()}${def.suffix}`;
}

// ── Output shapes ──────────────────────────────────────────────────────────

const Reading = z.object({
  entity_id: z.string(),
  /** False when the entity is absent, `unavailable`, or `unknown`. */
  available: z.boolean(),
  /** Numeric parse of the state (null for text readings or when absent). */
  value: z.number().nullable(),
  /** Raw HA state string — the landing place for text readings
   *  (`precip_type` = none/rain/hail) and the verbatim value. */
  raw: z.string().nullable(),
  /** HA's own `unit_of_measurement` attribute — never inferred. */
  unit: z.string().nullable(),
  /** Entity `last_changed` (ISO) when present. */
  as_of: z.string().nullable(),
});

const Signals = z.object({
  /** Precipitation intensity > 0 (or precip_type != none). Null when neither
   *  rain reading resolved. */
  raining: z.boolean().nullable(),
  /** ≥1 lightning strike in the last observation window (lightning_count > 0).
   *  Tempest reports strike count per ~1-min obs, so this means "lightning
   *  in the last minute" — a real-time safety signal. Null when no count. */
  lightning_active: z.boolean().nullable(),
  /** Average strike distance when lightning is active (in the
   *  lightning_distance reading's unit — mi on a US-unit station). */
  lightning_distance: z.number().nullable(),
});

const TempestInput = z.object({}).strict();

const TempestOutput = z.object({
  ok: z.boolean(),
  source: z.literal('home_assistant'),
  error: z.string().optional(),
  recovery_hint: z.string().optional(),
  /** Set only when NO measurement resolved — weather-shaped `sensor.*`
   *  entities HA actually has, so the operator/LLM can re-point the prefix. */
  candidates: z
    .array(z.object({ entity_id: z.string(), friendly_name: z.string().nullable() }))
    .optional(),
  station_prefix: z.string().optional(),
  /** Newest `last_changed` across resolved readings. */
  as_of: z.string().nullable().optional(),
  resolved_count: z.number().int().optional(),
  requested_count: z.number().int().optional(),
  /** Measurement keys whose entity was absent/unavailable. */
  missing: z.array(z.string()).optional(),
  readings: z.record(z.string(), Reading).optional(),
  signals: Signals.optional(),
});

type TempestOut = z.infer<typeof TempestOutput>;

// ── Parsing helpers ────────────────────────────────────────────────────────

// HA's genuine "no data" markers. NOT 'none' — that's a valid enum value
// (precip_type reports "none" when it's dry), so treating it as unavailable
// would drop a real reading into `missing`.
const UNAVAILABLE = new Set(['unavailable', 'unknown', '']);

function parse_number(state: string): number | null {
  const n = Number.parseFloat(state);
  return Number.isFinite(n) ? n : null;
}

// ── Candidate discovery (recovery path) ────────────────────────────────────

const WEATHERISH =
  /tempest|weatherflow|\bst_\d|wind|rain|precip|temperature|humidity|pressure|barometric|uv|lightning|solar|irradian|illumin|dew/i;

function weather_candidates(
  states: HAEntityState[],
): Array<{ entity_id: string; friendly_name: string | null }> {
  return states
    .filter((e) => e.entity_id.startsWith('sensor.'))
    .filter((e) => {
      const fn =
        typeof e.attributes?.friendly_name === 'string' ? e.attributes.friendly_name : '';
      return WEATHERISH.test(e.entity_id) || WEATHERISH.test(fn);
    })
    .slice(0, 24)
    .map((e) => ({
      entity_id: e.entity_id,
      friendly_name:
        typeof e.attributes?.friendly_name === 'string' ? e.attributes.friendly_name : null,
    }));
}

// ── Test seam ──────────────────────────────────────────────────────────────
// Lets the smoke inject canned HA `/api/states` results with no live HA.

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

function audit(ctx: ToolContext, input: unknown, out: TempestOut): void {
  // The connector reads HA entity state only — no coords, nothing to redact.
  ctx.memory?.log_action?.({
    intent_id: ctx.intent_id || ulid(),
    agent: ctx.specialist_id || 'tempest_connector',
    tool_name: 'tempest_conditions',
    tool_input: input as Record<string, unknown>,
    execution_result: {
      ok: out.ok,
      resolved_count: out.resolved_count ?? 0,
      missing_count: out.missing?.length ?? 0,
    },
    error: out.error,
  });
}

// ── Tool ────────────────────────────────────────────────────────────────────

export const tempest_conditions: Tool<z.infer<typeof TempestInput>, TempestOut> = {
  name: 'tempest_conditions',
  description:
    "Current ON-PROPERTY weather from the WeatherFlow Tempest station (via Home Assistant) — ACTUAL ground-truth readings, not a forecast. Returns temperature, feels-like, dew point, humidity, barometric pressure, wind speed/gust/lull/direction (+ rolling averages), rain rate + accumulation + type, UV index, solar irradiance, illuminance, and LIGHTNING strike count + average distance, each with HA's own unit. A `signals` digest flags `raining`, `lightning_active` (≥1 strike in the last minute), and the strike distance for safety calls. Use this for 'what's it actually doing outside right now', irrigation decisions (real rain + UV), lightning safety, and departure conditions. For the multi-day forecast use weather_forecast (geocoded). If the station isn't set up in HA yet the result carries `candidates` — the weather-shaped sensors HA has — so the entity prefix can be re-pointed.",
  risk: 'read',
  required_capabilities: ['read_weather_station'],
  // Bounded, structured output — every field carries weight; don't truncate.
  llm_budget: 'full',
  input_schema: TempestInput,
  output_schema: TempestOutput,

  idempotency_key() {
    return 'tempest_conditions:v1';
  },

  async execute(input, ctx: ToolContext): Promise<TempestOut> {
    // Tempest data flows through the owner's HA instance — household reads,
    // friend tier defers to Kate (mirrors ha_get_state / ha_list_entities).
    require_caller_tier(ctx, ['owner', 'household']);

    const fetched = await _states_provider();
    if (!fetched.ok) {
      const out: TempestOut = {
        ok: false,
        source: 'home_assistant',
        error: `Could not read Home Assistant: ${fetched.reason}`,
        recovery_hint: fetched.reason.includes('HA_TOKEN')
          ? 'HA_TOKEN not configured on the orchestrator — set HA_BASE_URL + HA_TOKEN in hearth.env so Hearth can read the Tempest entities. Until then no station readings are available.'
          : 'Home Assistant was unreachable. Check HA_BASE_URL reachability from the orchestrator host; retry shortly.',
        station_prefix: tempest_prefix(),
      };
      audit(ctx, input, out);
      return out;
    }

    const states = fetched.states;
    const by_id = new Map<string, HAEntityState>();
    for (const e of states) by_id.set(e.entity_id, e);

    const readings: Record<string, z.infer<typeof Reading>> = {};
    const missing: string[] = [];
    let newest_as_of: string | null = null;

    for (const def of MEASUREMENTS) {
      const entity_id = entity_id_for(def);
      const row = by_id.get(entity_id);
      const unit =
        row && typeof row.attributes?.unit_of_measurement === 'string'
          ? row.attributes.unit_of_measurement
          : null;
      const as_of = row?.last_changed ?? null;
      const state = row?.state;
      const available =
        row !== undefined && state !== undefined && !UNAVAILABLE.has(state.toLowerCase());

      if (!available) {
        missing.push(def.key);
        readings[def.key] = {
          entity_id,
          available: false,
          value: null,
          raw: state ?? null,
          unit,
          as_of,
        };
        continue;
      }

      const s = state as string;
      readings[def.key] = {
        entity_id,
        available: true,
        value: def.kind === 'number' ? parse_number(s) : null,
        raw: s,
        unit,
        as_of,
      };
      if (as_of && (newest_as_of === null || as_of > newest_as_of)) newest_as_of = as_of;
    }

    const resolved_count = MEASUREMENTS.length - missing.length;

    // No measurement resolved → the integration isn't added yet, or the
    // prefix is wrong. Degrade to candidates so the prefix can be re-pointed.
    if (resolved_count === 0) {
      const candidates = weather_candidates(states);
      const out: TempestOut = {
        ok: false,
        source: 'home_assistant',
        error: `No Tempest entities found under prefix "${tempest_prefix()}".`,
        recovery_hint:
          candidates.length > 0
            ? `Home Assistant has these weather-shaped sensors — set HEARTH_TEMPEST_ENTITY_PREFIX to the station's device slug (the part before "_temperature" etc.), or override individual ids via HEARTH_TEMPEST_<KEY>: ${candidates
                .map((c) => c.entity_id)
                .slice(0, 8)
                .join(', ')}`
            : 'No weather-shaped sensors are present in Home Assistant. Add the WeatherFlow integration in HA (Settings → Devices & Services → Add Integration → WeatherFlow; it auto-discovers the hub over local UDP), then re-point HEARTH_TEMPEST_ENTITY_PREFIX.',
        candidates,
        station_prefix: tempest_prefix(),
        resolved_count: 0,
        requested_count: MEASUREMENTS.length,
        missing,
      };
      audit(ctx, input, out);
      return out;
    }

    // Derived safety signals — pure functions of the resolved readings.
    const rate = readings['rain_rate'];
    const ptype = readings['precip_type'];
    let raining: boolean | null = null;
    if (rate?.available && rate.value !== null) raining = rate.value > 0;
    else if (ptype?.available && ptype.raw !== null) raining = ptype.raw.toLowerCase() !== 'none';

    const count = readings['lightning_count'];
    const dist = readings['lightning_distance'];
    const lightning_active = count?.available && count.value !== null ? count.value > 0 : null;
    const lightning_distance =
      lightning_active && dist?.available && dist.value !== null ? dist.value : null;

    const out: TempestOut = {
      ok: true,
      source: 'home_assistant',
      station_prefix: tempest_prefix(),
      as_of: newest_as_of,
      resolved_count,
      requested_count: MEASUREMENTS.length,
      missing,
      readings,
      signals: { raining, lightning_active, lightning_distance },
    };
    audit(ctx, input, out);
    return out;
  },
};
