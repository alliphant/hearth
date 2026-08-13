/**
 * House-energy connector — the Teslemetry solar/grid/load read
 * (house-fusion Phase 1, 2026-07-13).
 *
 * The energy sibling of `house_climate`: ONE typed read over the Tesla
 * energy site's HA entities (the Teslemetry integration) returning, from a
 * single `/api/states` dump:
 *   - LIVE power flows (kW): solar generation, home load, grid
 *     import(+)/export(−), battery when one exists;
 *   - TODAY's energy counters (kWh): solar generated, grid imported /
 *     exported, home usage — plus derived self-consumption /
 *     self-sufficiency ratios computed from those counters only;
 *   - site status passthroughs (grid_status / storm_watch / island_status)
 *     as RAW states — their semantics vary by site config (this household
 *     has no Powerwall, where several of them are only meaningful with
 *     one), so the connector reports, never interprets.
 *
 * Battery honesty: the live site has NO Powerwall — `percentage_charged`
 * reads 0 and the battery kWh counters read `unknown`. `battery.present`
 * is derived from whether the battery COUNTERS resolve (the honest signal),
 * and every battery field degrades to null rather than fabricating a 0%
 * battery the household doesn't own.
 *
 * Entity resolution is CONFIGURABLE, read at CALL time. The Teslemetry
 * integration names entities after the site (`sensor.<site>_solar_power`);
 * the default slug is the live household's site:
 *   - `HEARTH_ENERGY_SITE_SLUG` (default `honeysuckle`) — the site device
 *     slug. ⚠ The live HA also has a `honeysuckle_house_*` device (a UniFi
 *     NVR) — suffix matching is exact, so it never collides.
 *   - per-measurement override `HEARTH_ENERGY_<KEY>` (full entity_id) wins
 *     over slug+suffix, for a differently-named sensor.
 * When nothing resolves the tool degrades to `{ ok:false, error,
 * candidates }` listing the energy-shaped sensors HA DOES have.
 *
 * Units pass through HONESTLY (`unit_of_measurement`) — the derived ratios
 * are unitless fractions and say so in the schema.
 */

import { z } from 'zod';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import { require_caller_tier } from '@core/tool_gates';
import {
  fetch_ha_all_states,
  type HAEntityState,
  type HAHistoryPoint,
} from './home_assistant';

// ── Entity resolution config (read at call time) ──────────────────────────

function site_slug(): string {
  return (process.env.HEARTH_ENERGY_SITE_SLUG ?? 'honeysuckle').trim().replace(/^sensor\./, '');
}

type MeasurementKind = 'number' | 'text';

interface MeasurementDef {
  /** Logical key in the `readings` output map. */
  key: string;
  /** Entity domain + suffix appended to the site slug. Matches the
   *  Teslemetry integration's naming (verified live 2026-07-13). */
  domain: 'sensor' | 'binary_sensor';
  suffix: string;
  kind: MeasurementKind;
}

const MEASUREMENTS: readonly MeasurementDef[] = [
  // live power flows (kW)
  { key: 'solar_power', domain: 'sensor', suffix: '_solar_power', kind: 'number' },
  { key: 'load_power', domain: 'sensor', suffix: '_load_power', kind: 'number' },
  { key: 'grid_power', domain: 'sensor', suffix: '_grid_power', kind: 'number' },
  { key: 'battery_power', domain: 'sensor', suffix: '_battery_power', kind: 'number' },
  { key: 'battery_charge', domain: 'sensor', suffix: '_percentage_charged', kind: 'number' },
  // today's energy counters (kWh)
  { key: 'solar_generated', domain: 'sensor', suffix: '_solar_generated', kind: 'number' },
  { key: 'grid_imported', domain: 'sensor', suffix: '_grid_imported', kind: 'number' },
  { key: 'grid_exported', domain: 'sensor', suffix: '_grid_exported', kind: 'number' },
  { key: 'home_usage', domain: 'sensor', suffix: '_home_usage', kind: 'number' },
  { key: 'battery_charged', domain: 'sensor', suffix: '_battery_charged', kind: 'number' },
  { key: 'battery_discharged', domain: 'sensor', suffix: '_battery_discharged', kind: 'number' },
  // raw site status passthroughs (semantics vary by site config — reported, never interpreted)
  { key: 'grid_status', domain: 'binary_sensor', suffix: '_grid_status', kind: 'text' },
  { key: 'storm_watch', domain: 'binary_sensor', suffix: '_storm_watch_active', kind: 'text' },
  { key: 'island_status', domain: 'sensor', suffix: '_island_status', kind: 'text' },
];

function entity_id_for(def: MeasurementDef): string {
  const override = process.env[`HEARTH_ENERGY_${def.key.toUpperCase()}`];
  if (override && override.trim()) return override.trim();
  return `${def.domain}.${site_slug()}${def.suffix}`;
}

/** The daily kWh counter entity ids — shared with the nightly house ledger
 *  (distill_house_day reads their end-of-day values from recorder history). */
export function energy_counter_entities(): Record<
  'solar_generated' | 'grid_imported' | 'grid_exported' | 'home_usage',
  string
> {
  const pick = (key: string): string => {
    const def = MEASUREMENTS.find((m) => m.key === key);
    return def ? entity_id_for(def) : `sensor.${site_slug()}_${key}`;
  };
  return {
    solar_generated: pick('solar_generated'),
    grid_imported: pick('grid_imported'),
    grid_exported: pick('grid_exported'),
    home_usage: pick('home_usage'),
  };
}

/** The live home-load power entity id (kW) — shared with house_thermal's
 *  HVAC electrical-signature estimator (load steps at hvac_action edges). */
export function load_power_entity(): string {
  const def = MEASUREMENTS.find((m) => m.key === 'load_power');
  return def ? entity_id_for(def) : `sensor.${site_slug()}_load_power`;
}

// ── EV charging (2026-07-18: the car is not the house) ─────────────────────
//
// Whole-home usage conflates the house with the car — an EV-charging evening
// reads as a "heavy house day" and drags self-sufficiency down. The
// ChargePoint integration exposes charger STATE only (no kWh), but the EVSE's
// continuous draw is a known constant (NEC 80% rule: the owner's 30 A breaker
// → 24 A × 240 V = 5.76 kW), and AC charging holds that rate for essentially
// the whole session — so state-window minutes × configured rate is the honest
// primary estimate, with the load-step measurement as a drift cross-check.

/** The EVSE state entity (ChargePoint CPH50; "In Use" while charging). */
export function ev_charger_state_entity(): string {
  return process.env.HEARTH_EV_CHARGER_ENTITY?.trim() || 'sensor.cph50_charger_state';
}

/** Configured EVSE continuous draw in kW (override HEARTH_EV_CHARGER_KW). */
export function ev_charger_kw(): number {
  const v = Number.parseFloat(process.env.HEARTH_EV_CHARGER_KW ?? '');
  return Number.isFinite(v) && v > 0 ? v : 5.76;
}

/** True when the charger state string means a session is active. */
export function ev_charging_state(state: string): boolean {
  return /in.?use|charging/i.test(state);
}

export interface StateWindow {
  start: number;
  end: number;
}

/**
 * Contiguous windows where `is_match(state)` holds, clamped to [t0, t1].
 * A state holds until the next recorded change; a window still open at t1
 * closes there (recorder semantics — pure, shared with the smoke).
 */
export function state_windows(
  points: HAHistoryPoint[],
  is_match: (state: string) => boolean,
  t0: number,
  t1: number,
): StateWindow[] {
  const rows = points
    .map((p) => ({ t: Date.parse(p.last_changed), match: is_match(p.state) }))
    .filter((r) => Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t);
  const out: StateWindow[] = [];
  let open: number | null = null;
  for (const r of rows) {
    if (r.match && open === null) open = Math.max(r.t, t0);
    else if (!r.match && open !== null) {
      const end = Math.min(r.t, t1);
      if (end > open) out.push({ start: open, end });
      open = null;
    }
  }
  if (open !== null && t1 > open) out.push({ start: open, end: t1 });
  return out.filter((w) => w.start < t1 && w.end > t0);
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

const Signals = z.object({
  /** grid_power > threshold → importing; < −threshold → exporting; else balanced.
   *  Null when grid_power didn't resolve. */
  grid_flow: z.enum(['importing', 'exporting', 'balanced']).nullable(),
  /** Fraction of the CURRENT home load served by solar, 0..1 (unitless).
   *  1 when solar ≥ load (surplus exporting). Null unless both flows resolved. */
  self_powered_now: z.number().nullable(),
  /** TODAY: fraction of solar generation consumed at home (generated − exported)
   *  ÷ generated, 0..1. Null unless both counters resolved. */
  self_consumption_today: z.number().nullable(),
  /** TODAY: fraction of home usage served by solar (generated − exported)
   *  ÷ usage, 0..1. Null unless the counters resolved. */
  self_sufficiency_today: z.number().nullable(),
  /** TODAY: solar generated − home usage (kWh, signed). */
  net_today_kwh: z.number().nullable(),
  /** Whether the site has a battery, derived from the battery kWh counters
   *  resolving — NOT from percentage_charged, which reads 0 on battery-less
   *  sites. */
  battery_present: z.boolean(),
});

const HouseEnergyInput = z.object({}).strict();

const HouseEnergyOutput = z.object({
  ok: z.boolean(),
  source: z.literal('home_assistant'),
  error: z.string().optional(),
  recovery_hint: z.string().optional(),
  /** Set only when NO measurement resolved — energy-shaped sensors HA
   *  actually has, so HEARTH_ENERGY_SITE_SLUG can be re-pointed. */
  candidates: z
    .array(z.object({ entity_id: z.string(), friendly_name: z.string().nullable() }))
    .optional(),
  site_slug: z.string().optional(),
  as_of: z.string().nullable().optional(),
  resolved_count: z.number().int().optional(),
  requested_count: z.number().int().optional(),
  /** Measurement keys whose entity was absent/unavailable. On a site with no
   *  battery the battery keys land here by design. */
  missing: z.array(z.string()).optional(),
  readings: z.record(z.string(), Reading).optional(),
  signals: Signals.optional(),
});

type HouseEnergyOut = z.infer<typeof HouseEnergyOutput>;

// ── Parsing helpers ────────────────────────────────────────────────────────

const UNAVAILABLE = new Set(['unavailable', 'unknown', '']);

function parse_number(state: string): number | null {
  const n = Number.parseFloat(state);
  return Number.isFinite(n) ? n : null;
}

/** grid_power within ±this (kW) reads as "balanced" rather than a flow. */
const GRID_BALANCED_BAND_KW = 0.05;

// ── Candidate discovery (recovery path) ────────────────────────────────────

const ENERGYISH =
  /solar|grid|load_power|home_usage|powerwall|battery_power|percentage_charged|energy_site|wall_connector|tesla/i;

function energy_candidates(
  states: HAEntityState[],
): Array<{ entity_id: string; friendly_name: string | null }> {
  return states
    .filter((e) => e.entity_id.startsWith('sensor.') || e.entity_id.startsWith('binary_sensor.'))
    .filter((e) => {
      const fn =
        typeof e.attributes?.friendly_name === 'string' ? e.attributes.friendly_name : '';
      return ENERGYISH.test(e.entity_id) || ENERGYISH.test(fn);
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

function audit(ctx: ToolContext, input: unknown, out: HouseEnergyOut): void {
  // Reads HA entity state only — no coords / PII, nothing to redact.
  ctx.memory?.log_action?.({
    intent_id: ctx.intent_id || ulid(),
    agent: ctx.specialist_id || 'house_energy_connector',
    tool_name: 'house_energy',
    tool_input: input as Record<string, unknown>,
    execution_result: {
      ok: out.ok,
      resolved_count: out.resolved_count ?? 0,
      missing_count: out.missing?.length ?? 0,
      grid_flow: out.signals?.grid_flow ?? null,
    },
    error: out.error,
  });
}

// ── Pure derivations (exported for the smoke) ──────────────────────────────

export function derive_energy_signals(readings: Record<string, ReadingT>): z.infer<typeof Signals> {
  const val = (key: string): number | null => {
    const r = readings[key];
    return r?.available ? r.value : null;
  };

  const solar = val('solar_power');
  const load = val('load_power');
  const grid = val('grid_power');

  let grid_flow: 'importing' | 'exporting' | 'balanced' | null = null;
  if (grid !== null) {
    grid_flow =
      grid > GRID_BALANCED_BAND_KW ? 'importing' : grid < -GRID_BALANCED_BAND_KW ? 'exporting' : 'balanced';
  }

  let self_powered_now: number | null = null;
  if (solar !== null && load !== null && load > 0) {
    self_powered_now = Number(Math.min(1, Math.max(0, solar / load)).toFixed(3));
  }

  const generated = val('solar_generated');
  const exported = val('grid_exported');
  const usage = val('home_usage');

  let self_consumption_today: number | null = null;
  let self_sufficiency_today: number | null = null;
  if (generated !== null && exported !== null && generated > 0) {
    const consumed = Math.max(0, generated - exported);
    self_consumption_today = Number(Math.min(1, consumed / generated).toFixed(3));
    if (usage !== null && usage > 0) {
      self_sufficiency_today = Number(Math.min(1, consumed / usage).toFixed(3));
    }
  }

  const battery_present =
    (readings['battery_charged']?.available ?? false) ||
    (readings['battery_discharged']?.available ?? false);

  return {
    grid_flow,
    self_powered_now,
    self_consumption_today,
    self_sufficiency_today,
    net_today_kwh:
      generated !== null && usage !== null ? Number((generated - usage).toFixed(3)) : null,
    battery_present,
  };
}

// ── Tool ────────────────────────────────────────────────────────────────────

export const house_energy: Tool<z.infer<typeof HouseEnergyInput>, HouseEnergyOut> = {
  name: 'house_energy',
  description:
    "Current household ENERGY picture from the Tesla energy site (Teslemetry via Home Assistant): LIVE power flows — solar generation, home load, and grid import/export in kW — plus TODAY's counters (solar generated, grid imported/exported, home usage, kWh) and a `signals` digest: grid_flow (importing/exporting/balanced), self_powered_now (fraction of current load served by solar), self_consumption_today + self_sufficiency_today, net_today_kwh, battery_present. This household has NO Powerwall — battery fields honestly read absent. Use this for 'how much solar are we making', 'are we importing or exporting', 'how much of today ran on sunshine', and pair with house_climate when reasoning about HVAC cost (the AC is usually the load spike). If nothing resolves the result carries `candidates` so HEARTH_ENERGY_SITE_SLUG can be re-pointed.",
  risk: 'read',
  required_capabilities: ['read_house_energy'],
  // Bounded, structured output — every field carries weight; don't truncate.
  llm_budget: 'full',
  input_schema: HouseEnergyInput,
  output_schema: HouseEnergyOutput,

  idempotency_key() {
    return 'house_energy:v1';
  },

  async execute(input, ctx: ToolContext): Promise<HouseEnergyOut> {
    // Energy flows reveal occupancy patterns — owner + household read;
    // friend tier defers (mirrors house_climate / tempest_conditions).
    require_caller_tier(ctx, ['owner', 'household']);

    const fetched = await _states_provider();
    if (!fetched.ok) {
      const out: HouseEnergyOut = {
        ok: false,
        source: 'home_assistant',
        error: `Could not read Home Assistant: ${fetched.reason}`,
        recovery_hint: fetched.reason.includes('HA_TOKEN')
          ? 'HA_TOKEN not configured on the orchestrator — set HA_BASE_URL + HA_TOKEN in hearth.env so Hearth can read the energy entities.'
          : 'Home Assistant was unreachable. Check HA_BASE_URL reachability from the orchestrator host; retry shortly.',
        site_slug: site_slug(),
      };
      audit(ctx, input, out);
      return out;
    }

    const by_id = new Map<string, HAEntityState>();
    for (const e of fetched.states) by_id.set(e.entity_id, e);

    const readings: Record<string, ReadingT> = {};
    const missing: string[] = [];
    let resolved_count = 0;
    let newest_as_of: string | null = null;

    for (const def of MEASUREMENTS) {
      const entity_id = entity_id_for(def);
      const ha = by_id.get(entity_id);
      const unit =
        ha && typeof ha.attributes?.unit_of_measurement === 'string'
          ? ha.attributes.unit_of_measurement
          : null;
      const state = ha?.state;
      const available =
        ha !== undefined && state !== undefined && !UNAVAILABLE.has(state.toLowerCase());

      if (!available) {
        missing.push(def.key);
        readings[def.key] = {
          entity_id,
          available: false,
          value: null,
          raw: state ?? null,
          unit,
          as_of: ha?.last_changed ?? null,
        };
        continue;
      }
      resolved_count++;
      const as_of = ha.last_changed ?? null;
      if (as_of && (newest_as_of === null || as_of > newest_as_of)) newest_as_of = as_of;
      readings[def.key] = {
        entity_id,
        available: true,
        value: def.kind === 'number' ? parse_number(state as string) : null,
        raw: state as string,
        unit,
        as_of,
      };
    }

    if (resolved_count === 0) {
      const out: HouseEnergyOut = {
        ok: false,
        source: 'home_assistant',
        error: `No energy entities resolved for site slug "${site_slug()}" — the Teslemetry integration may be named differently on this HA instance.`,
        recovery_hint:
          'Set HEARTH_ENERGY_SITE_SLUG to the site device slug of the candidate entity ids below (e.g. "honeysuckle" for sensor.honeysuckle_solar_power).',
        candidates: energy_candidates(fetched.states),
        site_slug: site_slug(),
        requested_count: MEASUREMENTS.length,
        resolved_count,
      };
      audit(ctx, input, out);
      return out;
    }

    const out: HouseEnergyOut = {
      ok: true,
      source: 'home_assistant',
      site_slug: site_slug(),
      as_of: newest_as_of,
      resolved_count,
      requested_count: MEASUREMENTS.length,
      ...(missing.length ? { missing } : {}),
      readings,
      signals: derive_energy_signals(readings),
    };
    audit(ctx, input, out);
    return out;
  },
};
