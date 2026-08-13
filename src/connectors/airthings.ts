/**
 * AirThings indoor-air-quality connector (via Home Assistant).
 *
 * The complement to `tempest_conditions` (outdoor ground-truth): this reads the
 * household's AirThings monitors through HA and returns a typed CURRENT
 * indoor-air-quality object — radon, CO₂, VOC (TVOC), particulates (PM1/PM2.5),
 * humidity, temperature — for each monitored room, plus a small `signals` digest
 * (the WORST room per pollutant) for safety calls. One `/api/states` dump
 * resolves every reading; no per-entity round-trips.
 *
 * Why typed (not raw `ha_get_state`): a curated, owner-named surface means a
 * specialist can answer "what's the radon right now?" without guessing entity
 * ids, and the DangerousWeather-style indoor-air alert driver reads ONE shape.
 *
 * Entity resolution is CONFIGURABLE (the device slugs are the AirThings device
 * names HA assigns), read at CALL time so re-pointing needs no restart:
 *   - `HEARTH_AIRTHINGS_ROOMS` — comma-separated `Label:slug` (or bare `slug`)
 *     list of monitored rooms; defaults to the live household's three monitors.
 *   - `HEARTH_AIRTHINGS_SUFFIX_<KEY>` — override a pollutant's entity-id suffix
 *     (KEY ∈ CO2 RADON VOC PM1 PM25 HUMIDITY TEMPERATURE) when a monitor names a
 *     sensor unusually.
 * When NOTHING resolves the tool degrades to `{ ok:false, error, candidates }`
 * listing the air-quality-shaped `sensor.*` entities HA DOES have — the same
 * recovery-hint pattern as `tempest_conditions` / `ha_get_state`.
 *
 * Units pass through HONESTLY: each reading carries HA's own
 * `unit_of_measurement` (Bq/m³, ppm, ppb, µg/m³, %, °F) — never inferred.
 */

import { z } from 'zod';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import { require_caller_tier } from '@core/tool_gates';
import { fetch_ha_all_states, type HAEntityState } from './home_assistant';

// ── Room + pollutant resolution (read at call time) ────────────────────────

interface RoomDef {
  /** Display label used in messages + the `rooms` map key. */
  label: string;
  /** HA device slug — the entity-id stem before each pollutant suffix. */
  slug: string;
}

// The live household's three AirThings monitors (verified 2026-06-25). Override
// the whole set via HEARTH_AIRTHINGS_ROOMS.
const DEFAULT_ROOMS: readonly RoomDef[] = [
  { label: 'Basement', slug: 'basement_view_plus' },
  { label: 'En Suite', slug: 'en_suite_airthings' },
  { label: 'Living Room', slug: 'living_room' },
];

function humanize(slug: string): string {
  return slug
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function rooms(): RoomDef[] {
  const raw = process.env.HEARTH_AIRTHINGS_ROOMS;
  if (!raw || !raw.trim()) return [...DEFAULT_ROOMS];
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry): RoomDef => {
      const idx = entry.indexOf(':');
      if (idx === -1) {
        const slug = entry.replace(/^sensor\./, '');
        return { label: humanize(slug), slug };
      }
      return {
        label: entry.slice(0, idx).trim(),
        slug: entry.slice(idx + 1).trim().replace(/^sensor\./, ''),
      };
    });
  return parsed.length ? parsed : [...DEFAULT_ROOMS];
}

interface PollutantDef {
  /** Logical key in each room's readings map. */
  key: string;
  /** Default entity-id suffix appended to the room slug. */
  suffix: string;
}

// The AirThings sensor set HA's integration exposes (confirmed live on all three
// monitors 2026-06-25). The first four back the alert driver; humidity/temp are
// context.
const POLLUTANTS: readonly PollutantDef[] = [
  { key: 'co2', suffix: '_carbon_dioxide' },
  { key: 'radon', suffix: '_radon' },
  { key: 'voc', suffix: '_volatile_organic_compounds_parts' },
  { key: 'pm1', suffix: '_pm1' },
  { key: 'pm25', suffix: '_pm2_5' },
  { key: 'humidity', suffix: '_humidity' },
  { key: 'temperature', suffix: '_temperature' },
];

function suffix_for(def: PollutantDef): string {
  const override = process.env[`HEARTH_AIRTHINGS_SUFFIX_${def.key.toUpperCase()}`];
  return override && override.trim() ? override.trim() : def.suffix;
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

const WorstHit = z.object({
  room: z.string(),
  value: z.number(),
  unit: z.string().nullable(),
});

const Signals = z.object({
  /** The WORST (highest) room per pollutant — the small-model-friendly digest a
   *  specialist or the alert driver reads. Null when no room resolved it. */
  worst: z.object({
    co2: WorstHit.nullable(),
    radon: WorstHit.nullable(),
    voc: WorstHit.nullable(),
    pm25: WorstHit.nullable(),
  }),
});

const AirthingsInput = z.object({}).strict();

const AirthingsOutput = z.object({
  ok: z.boolean(),
  source: z.literal('home_assistant'),
  error: z.string().optional(),
  recovery_hint: z.string().optional(),
  /** Set only when NO reading resolved — air-quality-shaped `sensor.*` entities
   *  HA actually has, so the operator/LLM can re-point HEARTH_AIRTHINGS_ROOMS. */
  candidates: z
    .array(z.object({ entity_id: z.string(), friendly_name: z.string().nullable() }))
    .optional(),
  as_of: z.string().nullable().optional(),
  resolved_count: z.number().int().optional(),
  requested_count: z.number().int().optional(),
  /** `<room>.<pollutant>` keys whose entity was absent/unavailable. */
  missing: z.array(z.string()).optional(),
  /** Per-room readings: `{ <room label>: { co2, radon, voc, pm1, pm25, humidity, temperature } }`. */
  rooms: z.record(z.string(), z.record(z.string(), Reading)).optional(),
  signals: Signals.optional(),
});

type AirthingsOut = z.infer<typeof AirthingsOutput>;

// ── Parsing helpers ────────────────────────────────────────────────────────

const UNAVAILABLE = new Set(['unavailable', 'unknown', '']);

function parse_number(state: string): number | null {
  const n = Number.parseFloat(state);
  return Number.isFinite(n) ? n : null;
}

// ── Candidate discovery (recovery path) ────────────────────────────────────

const AIRQUALITYISH =
  /airthings|radon|carbon_dioxide|\bco2\b|volatile_organic|\bvoc\b|pm1|pm2_5|pm25|particulate|air_quality|view_plus/i;

function airquality_candidates(
  states: HAEntityState[],
): Array<{ entity_id: string; friendly_name: string | null }> {
  return states
    .filter((e) => e.entity_id.startsWith('sensor.'))
    .filter((e) => {
      const fn =
        typeof e.attributes?.friendly_name === 'string' ? e.attributes.friendly_name : '';
      return AIRQUALITYISH.test(e.entity_id) || AIRQUALITYISH.test(fn);
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

function audit(ctx: ToolContext, input: unknown, out: AirthingsOut): void {
  // Reads HA entity state only — no coords / PII, nothing to redact.
  ctx.memory?.log_action?.({
    intent_id: ctx.intent_id || ulid(),
    agent: ctx.specialist_id || 'airthings_connector',
    tool_name: 'airthings_conditions',
    tool_input: input as Record<string, unknown>,
    execution_result: {
      ok: out.ok,
      resolved_count: out.resolved_count ?? 0,
      missing_count: out.missing?.length ?? 0,
    },
    error: out.error,
  });
}

// ── The worst-room digest (pure) ───────────────────────────────────────────

/** The room with the highest value for `key`, or null if none resolved. */
export function worst_room(
  rooms_readings: Record<string, Record<string, z.infer<typeof Reading>>>,
  key: string,
): z.infer<typeof WorstHit> | null {
  let best: z.infer<typeof WorstHit> | null = null;
  for (const [label, readings] of Object.entries(rooms_readings)) {
    const r = readings[key];
    if (r?.available && r.value !== null && (best === null || r.value > best.value)) {
      best = { room: label, value: r.value, unit: r.unit };
    }
  }
  return best;
}

// ── Tool ────────────────────────────────────────────────────────────────────

export const airthings_conditions: Tool<z.infer<typeof AirthingsInput>, AirthingsOut> = {
  name: 'airthings_conditions',
  description:
    "Current INDOOR air quality from the household's AirThings monitors (via Home Assistant) — ACTUAL room readings, not a forecast. Per room (Basement, En Suite, Living Room): radon (Bq/m³), CO₂ (ppm), VOC/TVOC (ppb), particulates PM1 + PM2.5 (µg/m³), humidity (%), temperature (°F), each with HA's own unit. A `signals.worst` digest names the WORST room per pollutant for safety calls. Use this for 'what's the radon / CO₂ / air quality right now', ventilation decisions, and indoor-air safety. Context: EPA radon action level is 4 pCi/L ≈ 148 Bq/m³; normal indoor CO₂ is 400-1000 ppm. If no monitors resolve, the result carries `candidates` — the air-quality sensors HA has — so HEARTH_AIRTHINGS_ROOMS can be re-pointed.",
  risk: 'read',
  required_capabilities: ['read_air_quality'],
  // Bounded, structured output — every field carries weight; don't truncate.
  llm_budget: 'full',
  input_schema: AirthingsInput,
  output_schema: AirthingsOutput,

  idempotency_key() {
    return 'airthings_conditions:v1';
  },

  async execute(input, ctx: ToolContext): Promise<AirthingsOut> {
    // Indoor air quality is household data (presence-in-the-home adjacent) —
    // owner + household read; friend tier defers (mirrors tempest_conditions).
    require_caller_tier(ctx, ['owner', 'household']);

    const fetched = await _states_provider();
    if (!fetched.ok) {
      const out: AirthingsOut = {
        ok: false,
        source: 'home_assistant',
        error: `Could not read Home Assistant: ${fetched.reason}`,
        recovery_hint: fetched.reason.includes('HA_TOKEN')
          ? 'HA_TOKEN not configured on the orchestrator — set HA_BASE_URL + HA_TOKEN in hearth.env so Hearth can read the AirThings entities.'
          : 'Home Assistant was unreachable. Check HA_BASE_URL reachability from the orchestrator host; retry shortly.',
      };
      audit(ctx, input, out);
      return out;
    }

    const by_id = new Map<string, HAEntityState>();
    for (const e of fetched.states) by_id.set(e.entity_id, e);

    const room_defs = rooms();
    const rooms_out: Record<string, Record<string, z.infer<typeof Reading>>> = {};
    const missing: string[] = [];
    let resolved_count = 0;
    let requested_count = 0;
    let newest_as_of: string | null = null;

    for (const room of room_defs) {
      const readings: Record<string, z.infer<typeof Reading>> = {};
      for (const def of POLLUTANTS) {
        requested_count++;
        const entity_id = `sensor.${room.slug}${suffix_for(def)}`;
        const ha = by_id.get(entity_id);
        const unit =
          ha && typeof ha.attributes?.unit_of_measurement === 'string'
            ? ha.attributes.unit_of_measurement
            : null;
        const as_of = ha?.last_changed ?? null;
        const state = ha?.state;
        const available =
          ha !== undefined && state !== undefined && !UNAVAILABLE.has(state.toLowerCase());

        if (!available) {
          missing.push(`${room.label}.${def.key}`);
          readings[def.key] = { entity_id, available: false, value: null, raw: state ?? null, unit, as_of };
          continue;
        }
        resolved_count++;
        readings[def.key] = {
          entity_id,
          available: true,
          value: parse_number(state as string),
          raw: state as string,
          unit,
          as_of,
        };
        if (as_of && (newest_as_of === null || as_of > newest_as_of)) newest_as_of = as_of;
      }
      rooms_out[room.label] = readings;
    }

    // Nothing resolved → monitors not in HA yet, or the slugs are wrong.
    if (resolved_count === 0) {
      const candidates = airquality_candidates(fetched.states);
      const out: AirthingsOut = {
        ok: false,
        source: 'home_assistant',
        error: `No AirThings entities found for rooms [${room_defs.map((r) => r.slug).join(', ')}].`,
        recovery_hint:
          candidates.length > 0
            ? `Home Assistant has these air-quality sensors — set HEARTH_AIRTHINGS_ROOMS to "Label:slug" pairs using the device slug (the part before "_radon"/"_carbon_dioxide"): ${candidates
                .map((c) => c.entity_id)
                .slice(0, 8)
                .join(', ')}`
            : 'No air-quality sensors are present in Home Assistant. Add the AirThings integration in HA, then set HEARTH_AIRTHINGS_ROOMS.',
        candidates,
        resolved_count: 0,
        requested_count,
        missing,
      };
      audit(ctx, input, out);
      return out;
    }

    const out: AirthingsOut = {
      ok: true,
      source: 'home_assistant',
      as_of: newest_as_of,
      resolved_count,
      requested_count,
      missing,
      rooms: rooms_out,
      signals: {
        worst: {
          co2: worst_room(rooms_out, 'co2'),
          radon: worst_room(rooms_out, 'radon'),
          voc: worst_room(rooms_out, 'voc'),
          pm25: worst_room(rooms_out, 'pm25'),
        },
      },
    };
    audit(ctx, input, out);
    return out;
  },
};
