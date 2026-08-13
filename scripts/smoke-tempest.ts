/**
 * Smoke test for the WeatherFlow Tempest connector (Path 1 — HA-relay).
 *
 * Fully self-contained and DEVICE-FREE: no Home Assistant, no hub, no
 * network. The tool's HA `/api/states` provider is swapped for an injected
 * canned-entity transport via `_test_set_states_provider`, so this exercises
 * the parsing + recovery logic against the WeatherFlow entity shape exactly
 * as it appears on a live station. The fixture mirrors HA's CORE WeatherFlow
 * integration naming (`sensor.<slug>_temperature`, `_precipitation_intensity`,
 * `_lightning_count`, `_irradiance`, …), verified against a live
 * `sensor.st_00214775_*` device 2026-06-23.
 *
 * Asserts:
 *   1. The WeatherFlow `sensor.*` shape parses into the typed conditions
 *      object — numeric values + HA units, text readings (precip type), the
 *      derived raining / lightning-active signals, and the missing[] list for
 *      unavailable/absent entities.
 *   2. Configurability — a custom HEARTH_TEMPEST_ENTITY_PREFIX and a
 *      per-measurement HEARTH_TEMPEST_<KEY> override both resolve.
 *   3. Degrades to `{ ok:false, error, candidates }` when NO Tempest entity
 *      is present (integration not added / wrong prefix), listing the
 *      weather-shaped sensors HA does have — and to a token recovery hint
 *      when HA itself can't be read.
 *   4. The owner/household tier gate refuses a friend caller.
 *
 * Mirrors the self-contained connector-smoke pattern (smoke:connectors).
 */

import {
  tempest_conditions,
  _test_set_states_provider,
  _test_reset_states_provider,
} from '../src/connectors/tempest';
import type { ToolContext } from '../src/core/tool';
import type { HAEntityState } from '../src/connectors/home_assistant';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

const NOW = new Date();

function ctx(tier: 'owner' | 'household' | 'friend' = 'owner'): ToolContext {
  return {
    now: NOW,
    intent_id: 'smoke-tempest',
    user: { id: 'jasper', tier },
    memory: { log_action: () => 'audit_x' },
  } as unknown as ToolContext;
}

function entity(
  entity_id: string,
  state: string,
  unit?: string,
  friendly_name?: string,
): HAEntityState {
  return {
    entity_id,
    state,
    attributes: {
      ...(unit ? { unit_of_measurement: unit } : {}),
      ...(friendly_name ? { friendly_name } : {}),
    },
    last_changed: NOW.toISOString(),
    last_updated: NOW.toISOString(),
  };
}

/** A realistic WeatherFlow-on-HA (CORE integration) entity set under `prefix`,
 *  with an ACTIVE lightning strike + light rain to exercise the signals.
 *  `irradiance` is `unavailable`; `battery_voltage` is absent — both exercise
 *  the missing[] path. */
function tempest_states(prefix = 'sensor.tempest'): HAEntityState[] {
  return [
    entity(`${prefix}_temperature`, '80.9', '°F', 'Temperature'),
    entity(`${prefix}_feels_like`, '80.7', '°F'),
    entity(`${prefix}_dew_point`, '55.2', '°F'),
    entity(`${prefix}_wet_bulb_temperature`, '63.6', '°F'),
    entity(`${prefix}_humidity`, '41', '%'),
    entity(`${prefix}_air_pressure`, '25.03', 'inHg'),
    entity(`${prefix}_vapor_pressure`, '0.44', 'inHg'),
    entity(`${prefix}_air_density`, '0.983', 'kg/m³'),
    entity(`${prefix}_wind_speed`, '3.69', 'mph'),
    entity(`${prefix}_wind_speed_average`, '1.81', 'mph'),
    entity(`${prefix}_wind_gust`, '3.04', 'mph'),
    entity(`${prefix}_wind_lull`, '1.10', 'mph'),
    entity(`${prefix}_wind_direction`, '112', '°'),
    entity(`${prefix}_wind_direction_average`, '118', '°'),
    entity(`${prefix}_precipitation_intensity`, '0.04', 'in/h'),
    entity(`${prefix}_precipitation`, '0.12', 'in'),
    entity(`${prefix}_precipitation_type`, 'rain'),
    entity(`${prefix}_uv_index`, '3.24', 'UV index'),
    entity(`${prefix}_irradiance`, 'unavailable', 'W/m²'),
    entity(`${prefix}_illuminance`, '30970', 'lx'),
    entity(`${prefix}_lightning_count`, '2'),
    entity(`${prefix}_lightning_average_distance`, '3', 'mi'),
    entity(`${prefix}_battery`, '92', '%'),
    // _battery_voltage intentionally absent
    // unrelated noise
    entity('sensor.living_room_temperature', '69', '°F', 'Living Room Temperature'),
    entity('light.kitchen', 'on'),
  ];
}

async function main(): Promise<void> {
  // Keep env clean of any operator overrides from the shell.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('HEARTH_TEMPEST_')) delete process.env[k];
  }

  // ── 1. Parse the WeatherFlow shape (default prefix) ──────────────────────
  console.log('→ parses WeatherFlow (HA core) entity shape, default prefix sensor.tempest');
  _test_set_states_provider(async () => ({ ok: true, states: tempest_states() }));
  {
    const out = await tempest_conditions.execute({}, ctx());
    check('ok true', out.ok === true, JSON.stringify(out.error));
    check('source is home_assistant', out.source === 'home_assistant');
    const r = out.readings ?? {};
    check('temperature parsed (_temperature)', r.temperature?.value === 80.9 && r.temperature?.unit === '°F',
      JSON.stringify(r.temperature));
    check('temperature available', r.temperature?.available === true);
    check('humidity parsed', r.humidity?.value === 41);
    check('pressure inHg unit preserved (_air_pressure)', r.pressure?.unit === 'inHg' && r.pressure?.value === 25.03);
    check('rain_rate parsed (_precipitation_intensity)', r.rain_rate?.value === 0.04);
    check('solar_radiation maps to _irradiance', r.solar_radiation?.entity_id.endsWith('_irradiance') === true);
    check('wind_direction numeric', r.wind_direction?.value === 112);
    check('precip_type is text (value null, raw rain)',
      r.precip_type?.value === null && r.precip_type?.raw === 'rain');
    check('lightning_count parsed', r.lightning_count?.value === 2);
    check('lightning_distance parsed (_lightning_average_distance)', r.lightning_distance?.value === 3);
    // signals
    check('signals.raining true (rate 0.04 > 0)', out.signals?.raining === true);
    check('signals.lightning_active true (count 2 > 0)', out.signals?.lightning_active === true);
    check('signals.lightning_distance hoisted (3)', out.signals?.lightning_distance === 3);
    // missing path: irradiance unavailable + battery_voltage absent
    check('missing includes solar_radiation (irradiance unavailable)', (out.missing ?? []).includes('solar_radiation'));
    check('missing includes battery_voltage (absent)', (out.missing ?? []).includes('battery_voltage'));
    check('solar_radiation reading available=false', r.solar_radiation?.available === false);
    check('resolved_count = requested - missing',
      out.resolved_count === (out.requested_count ?? 0) - (out.missing?.length ?? 0),
      `${out.resolved_count} vs ${out.requested_count} - ${out.missing?.length}`);
    check('as_of present', typeof out.as_of === 'string' && out.as_of.length > 0);
    check('station_prefix echoed', out.station_prefix === 'sensor.tempest');
  }

  // ── 1b. Signals: no rain / no lightning ──────────────────────────────────
  console.log('\n→ signals reflect calm conditions (no rain, no lightning)');
  _test_set_states_provider(async () => ({
    ok: true,
    states: tempest_states().map((e) =>
      e.entity_id.endsWith('_precipitation_intensity') ? { ...e, state: '0.0' }
      : e.entity_id.endsWith('_precipitation_type') ? { ...e, state: 'none' }
      : e.entity_id.endsWith('_lightning_count') ? { ...e, state: '0' }
      : e),
  }));
  {
    const out = await tempest_conditions.execute({}, ctx());
    check('signals.raining false', out.signals?.raining === false);
    check('signals.lightning_active false', out.signals?.lightning_active === false);
    check('signals.lightning_distance null when inactive', out.signals?.lightning_distance === null);
    // "none" is a valid precip_type value, not an unavailable marker — it must
    // resolve as an available reading, NOT land in missing[].
    check('precip_type "none" resolves available (not missing)',
      out.readings?.precip_type?.available === true && out.readings?.precip_type?.raw === 'none');
    check('precip_type "none" not in missing', !(out.missing ?? []).includes('precip_type'));
  }

  // ── 2a. Configurable prefix (the real device slug) ───────────────────────
  console.log('\n→ honors HEARTH_TEMPEST_ENTITY_PREFIX override (real device slug)');
  process.env.HEARTH_TEMPEST_ENTITY_PREFIX = 'sensor.st_00214775';
  _test_set_states_provider(async () => ({
    ok: true,
    states: tempest_states('sensor.st_00214775'),
  }));
  {
    const out = await tempest_conditions.execute({}, ctx());
    check('resolves under custom prefix', out.ok === true && out.readings?.temperature?.value === 80.9);
    check('temperature entity_id is the real device id',
      out.readings?.temperature?.entity_id === 'sensor.st_00214775_temperature');
    check('station_prefix reflects override', out.station_prefix === 'sensor.st_00214775');
  }
  delete process.env.HEARTH_TEMPEST_ENTITY_PREFIX;

  // ── 2b. Per-measurement override ─────────────────────────────────────────
  console.log('\n→ honors per-measurement HEARTH_TEMPEST_<KEY> override');
  process.env.HEARTH_TEMPEST_TEMPERATURE = 'sensor.weird_temp_id';
  _test_set_states_provider(async () => ({
    ok: true,
    states: [
      ...tempest_states().filter((e) => e.entity_id !== 'sensor.tempest_temperature'),
      entity('sensor.weird_temp_id', '99.0', '°F'),
    ],
  }));
  {
    const out = await tempest_conditions.execute({}, ctx());
    check('temperature read from override entity_id',
      out.readings?.temperature?.entity_id === 'sensor.weird_temp_id' &&
      out.readings?.temperature?.value === 99.0,
      JSON.stringify(out.readings?.temperature));
  }
  delete process.env.HEARTH_TEMPEST_TEMPERATURE;

  // ── 3a. No Tempest entities → candidates ─────────────────────────────────
  console.log('\n→ degrades to {error, candidates} when no Tempest entity present');
  _test_set_states_provider(async () => ({
    ok: true,
    states: [
      entity('sensor.outdoor_temperature', '70', '°F', 'Outdoor Temperature'),
      entity('sensor.backyard_wind_speed', '5', 'mph', 'Backyard Wind Speed'),
      entity('sensor.greenhouse_humidity', '55', '%'),
      entity('light.porch', 'off'),
    ],
  }));
  {
    const out = await tempest_conditions.execute({}, ctx());
    check('ok false', out.ok === false);
    check('error names the missing prefix', (out.error ?? '').includes('sensor.tempest'));
    check('candidates populated', (out.candidates?.length ?? 0) > 0, JSON.stringify(out.candidates));
    check('candidates are weather-shaped sensors',
      (out.candidates ?? []).some((c) => c.entity_id === 'sensor.outdoor_temperature') &&
      (out.candidates ?? []).some((c) => c.entity_id === 'sensor.backyard_wind_speed'));
    check('candidates exclude non-weather entities',
      !(out.candidates ?? []).some((c) => c.entity_id === 'light.porch'));
    check('recovery_hint points at HEARTH_TEMPEST_ENTITY_PREFIX',
      (out.recovery_hint ?? '').includes('HEARTH_TEMPEST_ENTITY_PREFIX'));
    check('resolved_count 0', out.resolved_count === 0);
  }

  // ── 3b. HA unreadable (no token) → recovery hint, no candidates ──────────
  console.log('\n→ degrades to recovery hint when HA cannot be read');
  _test_set_states_provider(async () => ({ ok: false, reason: 'HA_TOKEN not configured' }));
  {
    const out = await tempest_conditions.execute({}, ctx());
    check('ok false', out.ok === false);
    check('recovery_hint mentions HA_TOKEN', (out.recovery_hint ?? '').includes('HA_TOKEN'));
    check('no candidates (cannot enumerate)', out.candidates === undefined);
  }

  // ── 4. Tier gate refuses friend ──────────────────────────────────────────
  console.log('\n→ owner/household tier gate refuses a friend caller');
  _test_set_states_provider(async () => ({ ok: true, states: tempest_states() }));
  {
    let threw = '';
    try {
      await tempest_conditions.execute({}, ctx('friend'));
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    check('friend caller throws TIER_FORBIDDEN', threw.includes('TIER_FORBIDDEN'), threw);
    const out = await tempest_conditions.execute({}, ctx('household'));
    check('household caller allowed', out.ok === true);
  }

  _test_reset_states_provider();

  console.log(`\n  passed=${passed}  failed=${failed}`);
  if (failed > 0) {
    console.error('\n✗ TEMPEST SMOKE FAILED');
    process.exit(1);
  }
  console.log('\n✓ TEMPEST SMOKE OK');
}

main().catch((err: unknown) => {
  console.error('\n✗ TEMPEST SMOKE CRASHED:', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
