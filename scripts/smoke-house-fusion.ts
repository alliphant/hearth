/**
 * Smoke for the house-fusion Phase 1 stack (house_climate + house_energy +
 * house_thermal_history).
 *
 * Self-contained + device-free: no HA, no network. The connectors' HA state
 * provider and the thermal tool's history provider + clock are the injected
 * test seams. Canned values mirror the live 2026-07-13 entity inventory so
 * the smoke tests the shipped default entity map.
 *
 * Asserts:
 *   - house_climate fuses thermostat (setpoint / hvac_action / humidity) +
 *     zones (temp / humidity / occupancy) + outdoor into deltas + signals
 *     (conditioning, setpoint gap, warmest/coolest, occupied zones);
 *     degrades to candidates when nothing resolves; HA-down is an error.
 *   - house_energy reads flows + counters, derives grid_flow /
 *     self_powered_now / self_consumption / self_sufficiency / net, and
 *     reports battery_present HONESTLY (absent on the live no-Powerwall
 *     shape, present when the battery counters resolve).
 *   - the thermal pure helpers (interp_at / mean_between / median /
 *     build_hvac_segments) — interpolation refuses to extrapolate, runs and
 *     idle segments merge correctly, coverage is honest.
 *   - house_thermal_history end-to-end on a synthetic winter night: duty
 *     cycle + cycle counts + setpoints; exactly one drift-usable idle
 *     segment yields a physical Newton coefficient + time constant; sparse
 *     segments are skipped, not fabricated; empty history → insufficient;
 *     unknown zone filter → typed error with recovery hint.
 */
import { Database } from 'bun:sqlite';
import {
  house_climate,
  house_zones,
  normalize_hvac_action,
  _test_set_states_provider as set_climate_states,
  _test_reset_states_provider as reset_climate_states,
} from '../src/connectors/house_climate';
import {
  house_energy,
  derive_energy_signals,
  state_windows,
  ev_charging_state,
  _test_set_states_provider as set_energy_states,
  _test_reset_states_provider as reset_energy_states,
} from '../src/connectors/house_energy';
import {
  house_thermal_history,
  interp_at,
  mean_between,
  median,
  to_series,
  to_climate_points,
  build_hvac_segments,
  _test_set_history_provider,
  _test_reset_history_provider,
  _test_set_now,
  estimate_step_kw,
  estimate_window_step_kw,
  classify_high_state_ms,
  degree_hours,
  fit_zone_loss,
} from '../src/connectors/house_thermal';
import type { HAEntityState, HAHistoryPoint } from '../src/connectors/home_assistant';
import {
  create as create_distill_house_day,
  _test_set_history_provider as set_ledger_history,
  _test_set_now as set_ledger_now,
} from '../src/specialists/kate/tools/distill_house_day';
import { HouseAnomalyDriver, detect_losing_ground } from '../src/core/house_anomaly';
import type { ToolDeps } from '../src/core/tool_deps';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}
const approx = (a: number | null | undefined, b: number, eps = 0.02): boolean =>
  a !== null && a !== undefined && Math.abs(a - b) <= eps;

const ctx = { memory: { log_action: () => 'a' }, now: new Date(), intent_id: 'x' } as never;

function ent(
  entity_id: string,
  state: string,
  unit: string | null,
  fn: string,
  attributes: Record<string, unknown> = {},
): HAEntityState {
  return {
    entity_id,
    state,
    attributes: { ...(unit ? { unit_of_measurement: unit } : {}), friendly_name: fn, ...attributes },
    last_changed: '2026-07-13T18:00:00Z',
  } as unknown as HAEntityState;
}

// The live entity map (2026-07-13 inventory), summer afternoon shape.
function live_states(): HAEntityState[] {
  return [
    ent('climate.home', 'cool', null, 'Home', {
      current_temperature: 78,
      temperature: 79,
      hvac_action: 'idle',
      hvac_modes: ['off', 'heat', 'cool', 'heat_cool'],
      fan_mode: 'auto',
      preset_mode: 'none',
      current_humidity: 47,
    }),
    ent('sensor.home_temperature', '78.6', '°F', 'Home Temperature'),
    ent('binary_sensor.home_occupancy', 'on', null, 'Home Occupancy'),
    ent('sensor.basement_temperature', '70.4', '°F', 'Basement Temperature'),
    ent('sensor.basement_view_plus_humidity', '52.0', '%', 'Basement humidity'),
    ent('binary_sensor.basement_occupancy', 'off', null, 'Basement Occupancy'),
    ent('sensor.en_suite_temperature', '80.6', '°F', 'En Suite Temperature'),
    ent('sensor.en_suite_airthings_humidity', '36.0', '%', 'En Suite humidity'),
    ent('binary_sensor.en_suite_occupancy', 'off', null, 'En Suite Occupancy'),
    ent('sensor.living_room_temperature', '78.26', '°F', 'Living room Temperature'),
    ent('sensor.living_room_humidity', '40.0', '%', 'Living room humidity'),
    ent('sensor.st_00214775_temperature', '93.3', '°F', 'Tempest Temperature'),
    ent('sensor.st_00214775_humidity', '31.0', '%', 'Tempest Humidity'),
  ];
}

function live_energy_states(): HAEntityState[] {
  return [
    ent('sensor.honeysuckle_solar_power', '1.09', 'kW', 'Westwood Solar power'),
    ent('sensor.honeysuckle_load_power', '7.55', 'kW', 'Westwood Load power'),
    ent('sensor.honeysuckle_grid_power', '6.46', 'kW', 'Westwood Grid power'),
    ent('sensor.honeysuckle_percentage_charged', '0', '%', 'Westwood Percentage charged'),
    ent('sensor.honeysuckle_solar_generated', '69.272', 'kWh', 'Westwood Solar generated'),
    ent('sensor.honeysuckle_grid_imported', '16.822', 'kWh', 'Westwood Grid imported'),
    ent('sensor.honeysuckle_grid_exported', '25.04', 'kWh', 'Westwood Grid exported'),
    ent('sensor.honeysuckle_home_usage', '61.054', 'kWh', 'Westwood Home usage'),
    ent('sensor.honeysuckle_battery_charged', 'unknown', 'kWh', 'Westwood Battery charged'),
    ent('sensor.honeysuckle_battery_discharged', 'unknown', 'kWh', 'Westwood Battery discharged'),
    ent('binary_sensor.honeysuckle_grid_status', 'off', null, 'Westwood Grid status'),
    ent('binary_sensor.honeysuckle_storm_watch_active', 'off', null, 'Westwood Storm watch'),
    ent('sensor.honeysuckle_island_status', 'island_status_unknown', null, 'Westwood Island status'),
  ];
}

// History helper: a point with attributes.
function hpoint(iso_ts: string, state: string, attributes?: Record<string, unknown>): HAHistoryPoint {
  return { state, last_changed: iso_ts, ...(attributes ? { attributes } : {}) };
}

async function main(): Promise<void> {
  // Mirror the live the LLM host env for the whole suite: the outdoor reference
  // self-configures from the Tempest prefix (sensor.st_00214775_* live).
  process.env.HEARTH_TEMPEST_ENTITY_PREFIX = 'sensor.st_00214775';

  // ── house_climate: the fused now-read ─────────────────────────────────────
  console.log('→ house_climate: thermostat + zones + outdoor fusion');
  {
    set_climate_states(async () => ({ ok: true, states: live_states() }));
    const out = await house_climate.execute({}, ctx);
    check('ok', out.ok === true);
    check('hvac mode + action', out.hvac?.mode === 'cool' && out.hvac?.hvac_action === 'idle');
    check('setpoint 79 / current 78', out.hvac?.setpoint === 79 && out.hvac?.current_temperature === 78);
    check('thermostat humidity 47', out.hvac?.humidity === 47);
    check('unit inferred from a resolved sensor', out.hvac?.unit === '°F');
    check('outdoor temp reads the Tempest', approx(out.outdoor?.temperature.value, 93.3));
    check('basement zone temp', approx(out.zones?.['Basement']?.temperature.value, 70.4));
    check('basement delta_to_outdoor ≈ −22.9', approx(out.zones?.['Basement']?.delta_to_outdoor, -22.9, 0.11));
    check('en-suite delta_to_setpoint ≈ +1.6', approx(out.zones?.['En Suite']?.delta_to_setpoint, 1.6, 0.11));
    check('zone humidity rides along', approx(out.zones?.['Living Room']?.humidity?.value, 40));
    check('occupancy: main floor occupied', out.zones?.['Main Floor']?.occupied === true);
    check('signals.conditioning = idle', out.signals?.conditioning === 'idle');
    check('signals.setpoint_gap = −1', approx(out.signals?.setpoint_gap, -1));
    check('signals.indoor_outdoor_delta ≈ −15.3', approx(out.signals?.indoor_outdoor_delta, -15.3, 0.11));
    check('warmest zone = En Suite', out.signals?.warmest_zone?.zone === 'En Suite');
    check('coolest zone = Basement', out.signals?.coolest_zone?.zone === 'Basement');
    check('occupied_zones = [Main Floor]', (out.signals?.occupied_zones ?? []).join(',') === 'Main Floor');
    reset_climate_states();
  }
  console.log('\n→ house_climate: degradations');
  {
    set_climate_states(async () => ({
      ok: true,
      states: [ent('climate.upstairs', 'heat', null, 'Upstairs Thermostat', { hvac_action: 'idle' })],
    }));
    const out = await house_climate.execute({}, ctx);
    check('nothing configured resolves → ok:false', out.ok === false);
    check('offers climate-shaped candidates', (out.candidates ?? []).some((c) => c.entity_id === 'climate.upstairs'));
    set_climate_states(async () => ({ ok: false, reason: 'HA_TOKEN not configured' }));
    const down = await house_climate.execute({}, ctx);
    check('HA down → error + recovery hint', down.ok === false && /HA_TOKEN/.test(down.recovery_hint ?? ''));
    reset_climate_states();
  }
  {
    const zones = house_zones();
    check('default zone map has the four live zones', zones.length === 4 && zones[0]?.label === 'Main Floor');
    process.env.HEARTH_HOUSE_ZONES = 'Attic|sensor.attic_temperature||binary_sensor.attic_occ; Garage|sensor.garage_temp';
    const custom = house_zones();
    check('HEARTH_HOUSE_ZONES parses labels + empty slots', custom.length === 2 && custom[0]?.humidity === null && custom[0]?.occupancy === 'binary_sensor.attic_occ' && custom[1]?.label === 'Garage');
    delete process.env.HEARTH_HOUSE_ZONES;
  }

  // ── house_energy ──────────────────────────────────────────────────────────
  console.log('\n→ house_energy: flows + counters + honest battery');
  {
    set_energy_states(async () => ({ ok: true, states: live_energy_states() }));
    const out = await house_energy.execute({}, ctx);
    check('ok', out.ok === true);
    check('solar/load/grid resolve', approx(out.readings?.['solar_power']?.value, 1.09) && approx(out.readings?.['load_power']?.value, 7.55) && approx(out.readings?.['grid_power']?.value, 6.46));
    check('grid_flow = importing', out.signals?.grid_flow === 'importing');
    check('self_powered_now ≈ 0.144', approx(out.signals?.self_powered_now, 0.144, 0.005));
    check('self_consumption_today ≈ 0.639', approx(out.signals?.self_consumption_today, 0.639, 0.005));
    check('self_sufficiency_today ≈ 0.724', approx(out.signals?.self_sufficiency_today, 0.724, 0.005));
    check('net_today_kwh ≈ +8.218', approx(out.signals?.net_today_kwh, 8.218, 0.005));
    check('NO battery: unknown counters → battery_present:false', out.signals?.battery_present === false);
    check('battery keys land in missing (by design)', (out.missing ?? []).includes('battery_charged'));
    check('grid_status passes through RAW (never interpreted)', out.readings?.['grid_status']?.raw === 'off' && out.readings?.['grid_status']?.value === null);
    reset_energy_states();
  }
  {
    // battery present when the counters resolve; exporting flow
    const sig = derive_energy_signals({
      solar_power: { entity_id: 'x', available: true, value: 8.0, raw: '8', unit: 'kW', as_of: null },
      load_power: { entity_id: 'x', available: true, value: 2.0, raw: '2', unit: 'kW', as_of: null },
      grid_power: { entity_id: 'x', available: true, value: -6.0, raw: '-6', unit: 'kW', as_of: null },
      battery_charged: { entity_id: 'x', available: true, value: 3.2, raw: '3.2', unit: 'kWh', as_of: null },
    });
    check('exporting flow detected', sig.grid_flow === 'exporting');
    check('surplus solar → self_powered_now caps at 1', sig.self_powered_now === 1);
    check('battery counters resolving → battery_present:true', sig.battery_present === true);
  }
  console.log('\n→ house_energy: candidates recovery');
  {
    set_energy_states(async () => ({
      ok: true,
      states: [ent('sensor.solaredge_ac_power', '3.1', 'kW', 'SolarEdge AC power')],
    }));
    const out = await house_energy.execute({}, ctx);
    check('wrong site slug → ok:false + candidates', out.ok === false && (out.candidates ?? []).some((c) => /solaredge/.test(c.entity_id)));
    reset_energy_states();
  }

  // ── thermal pure helpers ──────────────────────────────────────────────────
  console.log('\n→ thermal pure helpers');
  {
    const s = to_series([hpoint('2026-01-15T00:00:00Z', '70'), hpoint('2026-01-15T00:10:00Z', '71')]);
    const t0 = Date.parse('2026-01-15T00:00:00Z');
    check('interp_at midpoint', approx(interp_at(s, t0 + 5 * 60000), 70.5, 0.001));
    check('interp_at exact point', approx(interp_at(s, t0), 70, 0.001));
    check('interp_at refuses to extrapolate past the gap', interp_at(s, t0 + 3 * 3600_000) === null);
    check('mean_between of a flat pair', approx(mean_between(s, t0, t0 + 10 * 60000), 70.5, 0.001));
    check('median odd', median([3, 1, 2]) === 2);
    check('median even', median([1, 2, 3, 4]) === 2.5);
    check('median empty → null', median([]) === null);
  }
  console.log('\n→ Phase 4 pure math: step estimator, degree-hours, wind split');
  {
    const t0 = Date.parse('2026-01-15T00:00:00Z');
    const mkrun = (s: number, e: number) => ({
      action: 'cooling' as const,
      start: t0 + s * 60000,
      end: t0 + e * 60000,
      minutes: e - s,
      setpoint: 76,
      temp_start: null,
      temp_end: null,
    });
    const runs = [mkrun(20, 50), mkrun(80, 110), mkrun(140, 170)];
    const load: { t: number; v: number }[] = [];
    for (let m = 0; m <= 190; m++) {
      const at = t0 + m * 60000;
      const inside = runs.some((r) => at >= r.start && at < r.end);
      load.push({ t: at, v: inside ? 7.5 : 2.0 });
    }
    const est = estimate_step_kw(load, runs as never, 'cooling');
    check('step estimator recovers the 5.5 kW compressor', approx(est.kw, 5.5, 0.15), `got ${est.kw} (${est.edges_used} edges)`);
    check('no heating edges → null, not zero', estimate_step_kw(load, runs as never, 'heating').kw === null);

    // outdoor hourly (the Tempest is ~1-min cadence live; the default 30-min
    // interp gap needs points at least that dense) — indoor sparse is FINE
    // (its gap is relaxed to 3h inside degree_hours).
    const outdoor10 = Array.from({ length: 11 }, (_, h) => ({ t: t0 + h * 3600_000, v: 90 }));
    const indoor10 = [0, 2.5, 5, 7.5, 10].map((h) => ({ t: t0 + h * 3600_000, v: 75 }));
    const dh = degree_hours(outdoor10, indoor10, t0, t0 + 10 * 3600_000, 'cooling');
    check('degree-hours: 15° gap × 10h = 150', approx(dh.value, 150, 1), `got ${dh.value}`);
    check('heating degree-hours of a hot day = 0', degree_hours(outdoor10, indoor10, t0, t0 + 10 * 3600_000, 'heating').value === 0);
    check('sparse indoor → null, honest coverage', degree_hours(outdoor10, [{ t: t0, v: 75 }], t0, t0 + 10 * 3600_000, 'cooling').value === null);

    const idle_segs = [
      { start: t0, end: t0 + 2 * 3600_000 },
      { start: t0 + 3 * 3600_000, end: t0 + 5 * 3600_000 },
    ];
    const zone_series = [
      { t: t0, v: 70 },
      { t: t0 + 2 * 3600_000, v: 68 },
      { t: t0 + 3 * 3600_000, v: 68 },
      { t: t0 + 5 * 3600_000, v: 62 },
    ];
    const outdoor_c = [0, 1, 2, 3, 4, 5].map((h) => ({ t: t0 + h * 3600_000, v: 30 }));
    const windser = [
      { t: t0, v: 2 },
      { t: t0 + 2 * 3600_000, v: 2 },
      { t: t0 + 3 * 3600_000, v: 12 },
      { t: t0 + 5 * 3600_000, v: 12 },
    ];
    const wfit = fit_zone_loss(zone_series, outdoor_c, idle_segs, windser);
    check('wind split: calm + windy buckets fitted', wfit.calm_count === 1 && wfit.windy_count === 1, `calm=${wfit.calm_count} windy=${wfit.windy_count}`);
    check('windy k ≫ calm k (infiltration signature)', (wfit.k_windy ?? 0) > 2 * (wfit.k_calm ?? 1), `calm=${wfit.k_calm} windy=${wfit.k_windy}`);
  }
  {
    const t = (h: number): number => Date.parse('2026-01-15T00:00:00Z') + h * 3600_000;
    const pts = to_climate_points([
      hpoint('2026-01-15T00:00:00Z', 'heat', { hvac_action: 'idle', temperature: 68, current_temperature: 68 }),
      hpoint('2026-01-15T02:00:00Z', 'heat', { hvac_action: 'heating', temperature: 68, current_temperature: 67 }),
      hpoint('2026-01-15T02:30:00Z', 'heat', { hvac_action: 'heating', temperature: 68, current_temperature: 67.5 }),
      hpoint('2026-01-15T03:00:00Z', 'heat', { hvac_action: 'idle', temperature: 68, current_temperature: 68.4 }),
    ]);
    const seg = build_hvac_segments(pts, t(0), t(6));
    check('one merged heating run (two adjacent heating points)', seg.runs.length === 1 && seg.runs[0]?.minutes === 60);
    check('run boundary temps tracked (end = the closing point)', seg.runs[0]?.temp_start === 67 && seg.runs[0]?.temp_end === 68.4);
    check('idle segments merge around the run', seg.idle.length === 2 && seg.idle[0]?.end === t(2) && seg.idle[1]?.start === t(3));
    check('coverage counts only known-action time', seg.known_ms === 6 * 3600_000);
  }

  // The live 2026-07-18 regression: the ecobee fork labeled compressor+fan
  // intervals `fan` (exact-match vs NUMBERED equipment names) → five ledger
  // days of "cooling 0 min". equipment_running outranks the label, always.
  {
    check('normalize: compCool1,fan mislabeled fan → cooling', normalize_hvac_action('fan', 'compCool1,fan') === 'cooling');
    check('normalize: auxHeat2 → heating', normalize_hvac_action('idle', 'auxHeat2,fan') === 'heating');
    check('normalize: heatPump2 → heating', normalize_hvac_action('fan', 'heatPump2,fan') === 'heating');
    check('normalize: fan-only stays fan', normalize_hvac_action('fan', 'fan') === 'fan');
    check('normalize: empty equipment passes the label through', normalize_hvac_action('idle', '') === 'idle');
    check('normalize: no equipment attr (core integration) passes through', normalize_hvac_action('cooling', null) === 'cooling');
    const mislabeled = to_climate_points([
      hpoint('2026-01-14T12:00:00Z', 'cool', { hvac_action: 'fan', equipment_running: 'compCool1,fan', temperature: 74, current_temperature: 76 }),
      hpoint('2026-01-14T13:00:00Z', 'cool', { hvac_action: 'idle', equipment_running: '', temperature: 74, current_temperature: 73.8 }),
    ]);
    check('to_climate_points recovers cooling from equipment_running', mislabeled[0]?.action === 'cooling' && mislabeled[1]?.action === 'idle');
  }

  // ── house_thermal_history end-to-end (synthetic winter night) ─────────────
  console.log('\n→ house_thermal_history: synthetic winter night');
  {
    const NOW = Date.parse('2026-01-15T12:00:00Z');
    _test_set_now(() => NOW);
    const day = (h: number): string => new Date(Date.parse('2026-01-14T12:00:00Z') + h * 3600_000).toISOString();

    const climate_history: HAHistoryPoint[] = [
      hpoint(day(0), 'heat', { hvac_action: 'idle', temperature: 68, current_temperature: 69 }),
      hpoint(day(6), 'heat', { hvac_action: 'heating', temperature: 68, current_temperature: 67 }),
      hpoint(day(6.5), 'heat', { hvac_action: 'idle', temperature: 68, current_temperature: 68.5 }),
      hpoint(day(18), 'heat', { hvac_action: 'heating', temperature: 68, current_temperature: 66.3 }),
      hpoint(day(19), 'heat', { hvac_action: 'idle', temperature: 68, current_temperature: 68.2 }),
    ];
    // Basement temps cover ONLY the long idle stretch 6.5h→18h (drift 70 → 66.25).
    const basement_history: HAHistoryPoint[] = [
      hpoint(day(6.5), '70', { unit_of_measurement: '°F' }),
      hpoint(day(12), '68.5'),
      hpoint(day(18), '66.25'),
    ];
    const outdoor_history: HAHistoryPoint[] = [0, 6, 12, 18, 24].map((h) => hpoint(day(h), '30'));
    const humidity_history: HAHistoryPoint[] = [0, 12, 24].map((h) => hpoint(day(h), '55'));
    const wind_history: HAHistoryPoint[] = [0, 12, 24].map((h) => hpoint(day(h), '5'));
    // ~1-min cadence like the live Teslemetry sensor (edge windows exclude
    // the transition minute, so a dense series reads the step exactly).
    const load_history: HAHistoryPoint[] = [];
    for (let m = 5.5 * 60; m <= 7 * 60; m += 1) {
      const h = m / 60;
      load_history.push(hpoint(day(h), h >= 6 && h < 6.5 ? '4.6' : '1.0'));
    }
    for (let m = 17.5 * 60; m <= 19.5 * 60; m += 1) {
      const h = m / 60;
      load_history.push(hpoint(day(h), h >= 18 && h < 19 ? '4.6' : '1.0'));
    }
    const gust_history: HAHistoryPoint[] = [hpoint(day(3), '12'), hpoint(day(15), '22')];
    const irradiance_history: HAHistoryPoint[] = [
      hpoint(day(0), '0'),
      hpoint(day(12), '300'),
      hpoint(day(24), '0'),
    ];

    _test_set_history_provider(async (ids) => {
      const history: Record<string, HAHistoryPoint[]> = {};
      for (const id of ids) {
        if (id === 'climate.home') history[id] = climate_history;
        else if (id === 'sensor.basement_temperature') history[id] = basement_history;
        else if (id === 'sensor.st_00214775_temperature') history[id] = outdoor_history;
        else if (id === 'sensor.st_00214775_humidity') history[id] = humidity_history;
        else if (id === 'sensor.st_00214775_wind_speed_average') history[id] = wind_history;
        else if (id === 'sensor.st_00214775_wind_gust') history[id] = gust_history;
        else if (id === 'sensor.st_00214775_irradiance') history[id] = irradiance_history;
        else if (id === 'sensor.honeysuckle_load_power') history[id] = load_history;
        else history[id] = [];
      }
      return { ok: true, history };
    });

    const out = await house_thermal_history.execute({ hours: 24, zone: undefined } as never, ctx);
    check('ok + window echoes the request', out.ok === true && out.window?.hours === 24);
    check('heating minutes = 90 across 2 cycles', out.hvac?.heating_minutes === 90 && out.hvac?.heating_cycles === 2, `got ${out.hvac?.heating_minutes}m/${out.hvac?.heating_cycles}c`);
    check('heating duty ≈ 6.3%', approx(out.hvac?.heating_duty_pct, 6.3, 0.2));
    check('no cooling in the window', out.hvac?.cooling_minutes === 0 && out.hvac?.cooling_cycles === 0);
    check('runs carry setpoint + boundary temps', out.hvac?.runs[0]?.setpoint === 68 && out.hvac?.runs[0]?.temp_start === 67);
    check('setpoints_seen = [68]', out.hvac?.setpoints_seen.length === 1 && out.hvac?.setpoints_seen[0]?.setpoint === 68);
    check('full hvac coverage', approx(out.hvac?.coverage, 1, 0.001));
    check('outdoor mean 30 / humidity mean 55', approx(out.outdoor?.temp_mean, 30, 0.5) && approx(out.outdoor?.humidity_mean, 55, 0.5));
    check('wind mean 5 / gust max 22 (infiltration context)', approx(out.outdoor?.wind_mean, 5, 0.2) && out.outdoor?.gust_max === 22);
    check('hvac_energy: heating draw ≈ 3.6 kW from load steps', approx(out.hvac_energy?.estimated_heating_kw_electric, 3.6, 0.1), `got ${out.hvac_energy?.estimated_heating_kw_electric} (${out.hvac_energy?.heating_edges} edges)`);
    check('hvac_energy: heating ≈ 5.4 kWh (3.6 kW × 1.5 h)', approx(out.hvac_energy?.heating_kwh_electric, 5.4, 0.2));
    check('hvac_energy: cooling honestly null (no cooling ran)', out.hvac_energy?.estimated_cooling_kw === null);
    check('envelope block present (degree-hours honest under sparse indoor)', out.envelope !== undefined && typeof out.envelope?.degree_hour_coverage === 'number');
    check('irradiance mean ≈ 150 (solar-yield context)', approx(out.outdoor?.irradiance_mean, 150, 5));

    const bz = out.zones?.['Basement'];
    check('basement: exactly one usable idle segment', bz?.idle_segments_usable === 1, `got ${bz?.idle_segments_usable}`);
    check('basement: sparse segments skipped, not fabricated', (bz?.skipped_sparse_data ?? 0) >= 1);
    // drift = (66.25−70)/11.5h ≈ −0.326°F/h; ΔT = 30 − 68.125 ≈ −38.1; k ≈ 0.00856
    check('basement loss rate ≈ 0.0086/h', approx(bz?.loss_rate_per_hour, 0.0086, 0.0004), `got ${bz?.loss_rate_per_hour}`);
    check('basement time constant ≈ 117h', approx(bz?.time_constant_hours, 116.9, 3), `got ${bz?.time_constant_hours}`);
    check('quality = good', out.quality === 'good');
    check('zones with no data carry a caveat', (out.caveats ?? []).some((c) => /Main Floor/.test(c)));

    // zone filter: unknown label → typed error with the known labels
    const bad = await house_thermal_history.execute({ hours: 24, zone: 'Attic' } as never, ctx);
    check('unknown zone → error naming known zones', bad.ok === false && /Basement/.test(bad.error ?? ''));

    // empty history → insufficient, never fabricated
    _test_set_history_provider(async () => ({ ok: true, history: {} }));
    const thin = await house_thermal_history.execute({ hours: 24 } as never, ctx);
    check('empty history → quality insufficient', thin.ok === true && thin.quality === 'insufficient');
    check('insufficient carries the honesty caveat', (thin.caveats ?? []).some((c) => /not enough recorder history/.test(c)));

    // the day-one ecobee shape: a valid zone fit but hvac_action known for
    // ~4% of the window → 'partial', never 'good' (live-caught 2026-07-13).
    _test_set_history_provider(async (ids) => {
      const history: Record<string, HAHistoryPoint[]> = {};
      for (const id of ids) {
        if (id === 'climate.home')
          history[id] = [hpoint(day(23), 'cool', { hvac_action: 'idle', temperature: 79, current_temperature: 78 })];
        else if (id === 'sensor.basement_temperature')
          history[id] = [hpoint(day(23), '70', { unit_of_measurement: '°F' }), hpoint(day(24), '66')];
        else if (id === 'sensor.st_00214775_temperature') history[id] = outdoor_history;
        else history[id] = [];
      }
      return { ok: true, history };
    });
    const dayone = await house_thermal_history.execute({ hours: 24 } as never, ctx);
    const dz = dayone.zones?.['Basement'];
    check('day-one shape: the zone fit itself is usable', dz?.idle_segments_usable === 1, `got ${dz?.idle_segments_usable}`);
    check('day-one shape: low hvac coverage caps quality at partial', dayone.quality === 'partial', `got ${dayone.quality} (coverage ${dayone.hvac?.coverage})`);

    _test_reset_history_provider();
    _test_set_now(null);
    delete process.env.HEARTH_TEMPEST_ENTITY_PREFIX;
  }

  // ── distill_house_day: the nightly ledger (Phase 3) ───────────────────────
  console.log('\n→ distill_house_day: the nightly house ledger');
  {
    process.env.HEARTH_TEMPEST_ENTITY_PREFIX = 'sensor.st_00214775';
    // Local day 2026-01-15 in America/Denver = 07:00Z → 07:00Z next day.
    const dd = (h: number): string =>
      new Date(Date.parse('2026-01-15T07:00:00Z') + h * 3600_000).toISOString();

    const canned: Record<string, HAHistoryPoint[]> = {
      'climate.home': [
        hpoint(dd(0), 'heat', { hvac_action: 'idle', temperature: 68, current_temperature: 69 }),
        hpoint(dd(6), 'heat', { hvac_action: 'heating', temperature: 68, current_temperature: 67 }),
        hpoint(dd(6.5), 'heat', { hvac_action: 'idle', temperature: 68, current_temperature: 68.5 }),
      ],
      'sensor.basement_temperature': [
        hpoint(dd(6.5), '70', { unit_of_measurement: '°F' }),
        hpoint(dd(12), '68.5'),
        hpoint(dd(24), '64'),
      ],
      'sensor.st_00214775_temperature': [0, 6, 12, 18, 24].map((h) => hpoint(dd(h), '30')),
      'sensor.st_00214775_humidity': [0, 12, 24].map((h) => hpoint(dd(h), '55')),
      'sensor.st_00214775_wind_speed_average': [0, 12, 24].map((h) => hpoint(dd(h), '5')),
      'sensor.st_00214775_wind_gust': [hpoint(dd(3), '12'), hpoint(dd(15), '18')],
      'sensor.st_00214775_irradiance': [hpoint(dd(0), '0'), hpoint(dd(12), '300'), hpoint(dd(24), '0')],
      'sensor.honeysuckle_solar_generated': [hpoint(dd(10), '5'), hpoint(dd(23), '42.5')],
      'sensor.honeysuckle_grid_imported': [hpoint(dd(23), '10')],
      'sensor.honeysuckle_grid_exported': [hpoint(dd(23), '20')],
      'sensor.honeysuckle_home_usage': [hpoint(dd(23), '30')],
      'sensor.cph50_charger_state': [
        hpoint(dd(0), 'Available'),
        hpoint(dd(10), 'In Use'),
        hpoint(dd(14), 'Available'),
      ],
      // plugged 10→14 but CHARGING only 10→12 — "In Use" ≠ charging
      'sensor.honeysuckle_load_power': Array.from({ length: 49 }, (_, i) => {
        const h = i / 2;
        return hpoint(dd(h), h >= 10 && h < 12 ? '6.76' : '1.0');
      }),
    };
    set_ledger_history(async (ids) => {
      const history: Record<string, HAHistoryPoint[]> = {};
      for (const id of ids) history[id] = canned[id] ?? [];
      return { ok: true, history };
    });

    const vault = mkdtempSync(join(tmpdir(), 'house-ledger-smoke-'));
    const tool = create_distill_house_day({ vault_root: vault } as unknown as ToolDeps);
    const out = await tool.execute({ date: '2026-01-15' } as never, ctx);
    check('ledger writes (not skipped)', out.skipped === false, out.reason);
    const content = readFileSync(join(vault, 'Knowledge/Luna/house-log.md'), 'utf8');
    check('entry headed by the date', content.includes('### 2026-01-15'));
    check('HVAC line: 30 heating minutes / 1 cycle', content.includes('heating 30 min / 1 cycles'));
    check('zone fit line (Basement k + τ)', content.includes('Basement k=0.0093') && /τ=10[78]\.\d+h/.test(content), content.match(/- Zones.*$/m)?.[0]);
    check('zones without data write an honest dash', content.includes('Main Floor —'));
    check('outdoor line carries wind + gust + irradiance', content.includes('wind 5.0 avg / 18.0 gust') && content.includes('irradiance 150 W/m²'));
    check('energy line: totals + self-sufficiency 75%', content.includes('solar 42.5 kWh') && content.includes('self-sufficiency 75%'));
    check('yield index = generated ÷ mean irradiance ≈ 0.283', content.includes('yield index 0.283'));
    check('ledger: HVAC-energy line renders honest dashes with <3 edges', content.includes('- HVAC energy: cooling —'));
    check('ledger: envelope-index line present', content.includes('- Envelope index:'));
    check('EV line: charging 120 of 240 plugged → 11.5 kWh (plugged ≠ charging)', content.includes('- EV charging: 11.5 kWh (charging 120 min of 240 plugged @ 5.76 kW config'));
    check('energy line splits house vs car', content.includes('usage 30.0 (house 18.5 + EV 11.5)'));

    const again = await tool.execute({ date: '2026-01-15' } as never, ctx);
    check('idempotent per date — second run skipped', again.skipped === true && /already exists/.test(again.reason ?? ''));
    const bad = await tool.execute({ date: 'Jan 15' } as never, ctx);
    check('malformed date → typed recovery reason', bad.skipped === true && /YYYY-MM-DD/.test(bad.reason ?? ''));

    // an UNFINISHED day would be locked in partial by idempotency — refused.
    set_ledger_now(() => Date.parse('2026-01-16T18:00:00Z'));
    const partial = await tool.execute({ date: '2026-01-16' } as never, ctx);
    check('today (unfinished) → refused, never a partial locked entry', partial.skipped === true && /isn't finished/.test(partial.reason ?? ''));
    set_ledger_now(null);

    set_ledger_history(null);
  }

  // ── EV separation pure helpers ────────────────────────────────────────────
  console.log('\n→ EV separation: state windows + measured-draw cross-check');
  {
    const day0 = Date.parse('2026-01-14T00:00:00Z');
    const day1 = Date.parse('2026-01-15T00:00:00Z');
    const pts = [
      hpoint('2026-01-14T00:00:00Z', 'Available'),
      hpoint('2026-01-14T10:00:00Z', 'In Use'),
      hpoint('2026-01-14T14:00:00Z', 'Available'),
      hpoint('2026-01-14T22:00:00Z', 'In Use'),
    ];
    const ws = state_windows(pts, ev_charging_state, day0, day1);
    check(
      'state_windows: closed session + tail-open clamps to day end',
      ws.length === 2 &&
        ws[0]?.start === Date.parse('2026-01-14T10:00:00Z') &&
        ws[0]?.end === Date.parse('2026-01-14T14:00:00Z') &&
        ws[1]?.end === day1,
    );
    check('ev_charging_state: In Use/charging yes, Available no', ev_charging_state('In Use') && ev_charging_state('charging') && !ev_charging_state('Available'));
    check('no matching states → no windows', state_windows([hpoint('2026-01-14T01:00:00Z', 'Available')], ev_charging_state, day0, day1).length === 0);

    const hr = 3600_000;
    const wins = [
      { start: day0 + 1 * hr, end: day0 + 2 * hr },
      { start: day0 + 4 * hr, end: day0 + 5 * hr },
    ];
    const load: Array<{ t: number; v: number }> = [];
    // odd minutes: no sample lands exactly on a window edge (edge-aligned
    // samples smear the step into the pre-window via interpolation)
    for (let m = 1; m <= 6 * 60; m += 2) {
      const t = day0 + m * 60_000;
      const inside = wins.some((w) => t >= w.start && t < w.end);
      load.push({ t, v: inside ? 6.76 : 1.0 });
    }
    const est = estimate_window_step_kw(load, wins);
    check('measured EV draw recovered from charger-window load steps ≈ 5.76', est.kw !== null && Math.abs(est.kw - 5.76) < 0.15, String(est.kw));
    const excl = estimate_window_step_kw(load, wins, [wins[0]!.start, wins[0]!.end]);
    check('excluded edges drop below the 3-edge floor → honest null', excl.kw === null && excl.edges_used === 2);

    // classify: plugged window [1h,3h] but load high only [1h,2h] (car full after)
    const plugged = [{ start: day0 + 1 * hr, end: day0 + 3 * hr }];
    const cls = classify_high_state_ms(load, plugged, 5.76);
    check(
      'classify: charging share of a plugged window = the high-load subset',
      cls !== null && Math.abs(cls.high_ms - 1 * hr) < 5 * 60_000 && cls.sub_windows.length === 1,
      cls === null ? 'null' : String(cls.high_ms / 60000),
    );
    check('classify: thin load data → null, never zero', classify_high_state_ms(load.slice(0, 4), plugged, 5.76) === null);
    check('classify: no windows → zero, not null', classify_high_state_ms(load, [], 5.76)?.high_ms === 0);
  }

  // ── HouseAnomalyDriver: losing-ground detection (Phase 3) ─────────────────
  console.log('\n→ HouseAnomalyDriver: HVAC losing ground');
  {
    const s = (t: number, action: string | null, current: number | null) => ({ t, action, current });
    // cooling + rising ≥ threshold across a spanned window → hit
    const rising = [s(0, 'cooling', 78), s(500, 'cooling', 78.9), s(1000, 'cooling', 79.8), s(1500, 'cooling', 80.7)];
    const hit = detect_losing_ground(rising, 1500, 1000, 1.5);
    check('cooling + rising → losing ground', hit?.action === 'cooling' && approx(hit?.delta, 1.8, 0.01));
    check('heating + falling → losing ground', detect_losing_ground([s(0, 'heating', 70), s(500, 'heating', 69.1), s(1000, 'heating', 68.2), s(1500, 'heating', 67.3)], 1500, 1000, 1.5)?.action === 'heating');
    check('mixed actions in the window → no alert', detect_losing_ground([s(500, 'cooling', 78.9), s(1000, 'idle', 79.8), s(1500, 'cooling', 80.7)], 1500, 1000, 1.5) === null);
    check('drift under threshold → no alert', detect_losing_ground([s(500, 'cooling', 79), s(1000, 'cooling', 79.4), s(1500, 'cooling', 79.9)], 1500, 1000, 1.5) === null);
    check('run clustered at one end (no span) → no alert', detect_losing_ground([s(1400, 'cooling', 78), s(1450, 'cooling', 79.5), s(1500, 'cooling', 80.5)], 1500, 1000, 1.5) === null);

    // driver harness: once-per-episode + severity honesty
    process.env.HEARTH_HOUSE_ANOMALY_WINDOW_MS = '1000';
    process.env.HEARTH_HOUSE_ANOMALY_DELTA = '1.5';
    process.env.HEARTH_HOUSE_ANOMALY_CLEAR_GAP_MS = '1000';
    process.env.HEARTH_HOUSE_ANOMALY_CRITICAL_MIN_INTERVAL_MS = '500';
    process.env.HEARTH_HOUSE_ANOMALY_GARAGE_MIN_MS = '1000';

    const make_harness = () => {
      const pushes: Array<{ uid: string; text: string; severity: string }> = [];
      const speaks: Array<{ tone: string }> = [];
      const clock = { ms: 0 };
      let sample: { action: string | null; current: number | null; setpoint: number | null; outdoor: number | null; garage: string | null } = { action: 'idle', current: 75, setpoint: 76, outdoor: 99, garage: null };
      const quiet = { on: false };
      const driver = new HouseAnomalyDriver({
        db: new Database(':memory:'),
        memory: { log_action: () => 'a' } as never,
        sources: { read_climate: async () => sample },
        delivery: {
          push: async (uid, text, severity) => { pushes.push({ uid, text, severity }); },
          speak: async (_t, _s, tone) => { speaks.push({ tone }); },
        },
        home_user_ids: () => ['jasper', 'sam'],
        quiet_now: () => quiet.on,
        now: () => clock.ms,
      });
      return { driver, pushes, speaks, clock, quiet, set: (x: typeof sample) => { sample = x; } };
    };

    {
      const h = make_harness();
      for (let i = 0; i <= 6; i++) {
        h.set({ action: 'cooling', current: 78 + 0.9 * i, setpoint: 76, outdoor: 99, garage: null });
        await h.driver.tick();
        h.clock.ms += 500;
      }
      check('AC losing ground fires ONCE per episode (2 recipients)', h.pushes.length === 2, `pushes=${h.pushes.length}`);
      check('non-freezing → medium severity (quiet hours hold it)', h.pushes.every((p) => p.severity === 'medium'));
      check('push names the AC + the deficit', /AC has run .* losing ground/.test(h.pushes[0]?.text ?? ''));
    }
    {
      const h = make_harness();
      h.quiet.on = true; // 3am
      for (let i = 0; i <= 4; i++) {
        h.set({ action: 'heating', current: 70 - 0.9 * i, setpoint: 72, outdoor: 20, garage: null });
        await h.driver.tick();
        h.clock.ms += 500;
      }
      check('freezing furnace failure → HIGH severity (pierces quiet hours)', h.pushes.length >= 2 && h.pushes.every((p) => p.severity === 'high'), `pushes=${h.pushes.length}`);
      check('critical warns about pipes', /pipe/i.test(h.pushes[0]?.text ?? ''));
      check('critical SPEAKS even during quiet hours', h.speaks.length >= 1 && h.speaks.every((x) => x.tone === 'critical'));
    }

    {
      const h = make_harness();
      for (let i = 0; i <= 5; i++) {
        h.set({ action: 'cooling', current: 76, setpoint: 76, outdoor: 99, garage: 'open' });
        await h.driver.tick();
        h.clock.ms += 500;
      }
      check('garage open while conditioning → fresh + one escalation (2 recipients each)', h.pushes.length === 4, `pushes=${h.pushes.length}`);
      check('garage alert names the door + the gear', /garage door.*open/i.test(h.pushes[0]?.text ?? '') && /AC/.test(h.pushes[0]?.text ?? ''));
      check('garage alert is a notice (medium)', h.pushes.every((p) => p.severity === 'medium'));
    }
    {
      const h = make_harness();
      for (let i = 0; i <= 5; i++) {
        h.set({ action: 'cooling', current: 76, setpoint: 76, outdoor: 99, garage: 'closed' });
        await h.driver.tick();
        h.clock.ms += 500;
      }
      check('garage closed → no alert', h.pushes.length === 0, `pushes=${h.pushes.length}`);
    }

    // Owner kill-switches (2026-07-28): cooling + garage off, heating stays.
    {
      process.env.HEARTH_HOUSE_ANOMALY_COOLING = '0';
      process.env.HEARTH_HOUSE_ANOMALY_GARAGE = '0';
      const h = make_harness();
      for (let i = 0; i <= 6; i++) {
        h.set({ action: 'cooling', current: 78 + 0.9 * i, setpoint: 76, outdoor: 99, garage: 'open' });
        await h.driver.tick();
        h.clock.ms += 500;
      }
      check('cooling + garage kill-switches → silence on a losing-ground open-garage day', h.pushes.length === 0, `pushes=${h.pushes.length}`);
      const h2 = make_harness();
      for (let i = 0; i <= 4; i++) {
        h2.set({ action: 'heating', current: 70 - 0.9 * i, setpoint: 72, outdoor: 20, garage: null });
        await h2.driver.tick();
        h2.clock.ms += 500;
      }
      check('heating (pipe-freeze) stays armed with cooling+garage off', h2.pushes.length >= 2 && h2.pushes.every((p) => p.severity === 'high'), `pushes=${h2.pushes.length}`);
      delete process.env.HEARTH_HOUSE_ANOMALY_COOLING;
      delete process.env.HEARTH_HOUSE_ANOMALY_GARAGE;
    }

    delete process.env.HEARTH_HOUSE_ANOMALY_GARAGE_MIN_MS;
    delete process.env.HEARTH_HOUSE_ANOMALY_WINDOW_MS;
    delete process.env.HEARTH_HOUSE_ANOMALY_DELTA;
    delete process.env.HEARTH_HOUSE_ANOMALY_CLEAR_GAP_MS;
    delete process.env.HEARTH_HOUSE_ANOMALY_CRITICAL_MIN_INTERVAL_MS;
    delete process.env.HEARTH_TEMPEST_ENTITY_PREFIX;
  }

  console.log(`\n  passed=${passed}  failed=${failed}`);
  if (failed > 0) { console.error('\n✗ HOUSE-FUSION SMOKE FAILED'); process.exit(1); }
  console.log('\n✓ HOUSE-FUSION SMOKE OK');
}

main().catch((err: unknown) => {
  console.error('\n✗ HOUSE-FUSION SMOKE CRASHED:', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
