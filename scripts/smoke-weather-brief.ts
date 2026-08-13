/**
 * Smoke for the Pirate Weather connector + iOS-snapshot calendar tools
 * + Kate's brief context puller.
 *
 * Self-contained: stubs the Pirate Weather HTTP transport with canned
 * DarkSky-shape JSON; stubs MemoryClient.query_calendar_snapshot with
 * an in-memory snapshot. No live network, no real DB.
 *
 *   bun run scripts/smoke-weather-brief.ts
 *
 * Asserts:
 *   1. weather_now falls to home_location anchor when no current
 *      location is available.
 *   1b. Fresh iOS sensor packet wins — weather routes to cabin
 *      coords, not home.
 *   1c. Stale sensor packet (>6h) falls through to anchor.
 *   1d. Low-accuracy sensor packet (>2km) falls through to anchor.
 *   2. No source at all returns ok=false + recovery_hint.
 *   3. weather_now upstream error returns key-aware recovery hint.
 *   4. weather_forecast returns hourly + daily arrays sliced to the
 *      requested counts.
 *   5. weather_alerts returns an empty array when Pirate omits the alerts
 *      block (the right answer is "no alerts," not an error).
 *   5b. Per-user routing dispatches distinct Pirate requests.
 *   6. sensor_calendar_upcoming returns events from the snapshot in
 *      chronological order, capped at `limit`, future-only.
 *   7. sensor_calendar_upcoming with no snapshot returns ok=false +
 *      recovery_hint pointing at the iOS push path.
 *   8. pull_brief_context: anchor path cites user_config source.
 *   8b. pull_brief_context: fresh sensor packet routes to current
 *      location, label threaded into source.
 *   9. pull_brief_context marks weather and calendar 'unavailable' with
 *      actionable reasons when sources are missing.
 */

import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  create as create_weather_tools,
  _test_set_transport,
  _test_clear_cache,
} from '../src/connectors/weather';
import { create as create_sensor_calendar_tools } from '../src/connectors/sensor_calendar';
import { pull_brief_context } from '../src/core/brief_context';
import type { ToolContext, Tool } from '../src/core/tool';
import type { ToolDeps } from '../src/core/tool_deps';
import type {
  MemoryClient,
  CalendarSnapshotResult,
  CalendarSnapshotEventShape,
} from '../src/memory/client';
import type { UserRegistry } from '../src/core/users';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

// ── Stubs ────────────────────────────────────────────────────────────────

interface AuditRow {
  intent_id: string;
  agent: string;
  tool_name: string;
  tool_input: unknown;
  execution_result?: unknown;
  error?: string;
}

function fake_memory(opts: {
  calendar?: CalendarSnapshotResult | null;
  location_packet?: {
    lat: number;
    lng: number;
    place_id?: string | null;
    accuracy_m?: number;
    age_seconds: number;
  } | null;
} = {}): {
  client: MemoryClient;
  audit: AuditRow[];
} {
  const audit: AuditRow[] = [];
  const client = {
    log_action(row: AuditRow): string {
      audit.push(row);
      return `audit_${audit.length}`;
    },
    query_calendar_snapshot(_uid: string): CalendarSnapshotResult | null {
      return opts.calendar ?? null;
    },
    query_latest_location_packet(_uid: string) {
      const p = opts.location_packet;
      if (!p) return null;
      const ts = new Date(Date.now() - p.age_seconds * 1000).toISOString();
      return {
        user_id: _uid,
        captured_at: ts,
        received_at: ts,
        payload: {
          kind: 'significant_change' as const,
          lat: p.lat,
          lng: p.lng,
          horizontal_accuracy_m: p.accuracy_m,
          place_id: p.place_id ?? null,
          ts,
        },
      };
    },
  } as unknown as MemoryClient;
  return { client, audit };
}

/**
 * Minimal UserRegistry stub for tests. `home_coords` is the only
 * method weather + brief_context call; other UserRegistry methods
 * aren't exercised here.
 */
function fake_users(homes: Record<string, { lat: number; lng: number; label?: string }>): UserRegistry {
  return {
    // pull_brief_context resolves the recipient tier via users.get(id)?.tier
    // (owner-only HA/EV gating). Jasper is the household owner; anyone else is a
    // member. An unknown id → null, so the caller falls to its owner default.
    get(user_id: string) {
      if (!(user_id in homes)) return null;
      return { id: user_id, tier: user_id === 'jasper' ? 'owner' : 'household' };
    },
    get_timezone(_user_id: string) {
      return 'America/Denver';
    },
    home_coords(user_id: string) {
      const h = homes[user_id];
      if (h) {
        return { lat: h.lat, lng: h.lng, label: h.label ?? null, source: 'user_config' as const };
      }
      const lat_raw = process.env.HEARTH_HOME_LAT;
      const lng_raw = process.env.HEARTH_HOME_LON;
      if (lat_raw && lng_raw) {
        return {
          lat: Number.parseFloat(lat_raw),
          lng: Number.parseFloat(lng_raw),
          label: null,
          source: 'env_fallback' as const,
        };
      }
      return null;
    },
  } as unknown as UserRegistry;
}

// The weather (make_weather_now) + sensor_calendar tools read `memory` from the
// factory deps (a CLOSURE), never from ctx.memory — so a per-case fake_memory
// client only reaches the tool through the factory, not through ctx_for. The
// shared tools are built ONCE (line ~303), so we hand the factory a proxy that
// delegates to whichever client the current case selected. ctx_for() sets it,
// which every execute site already calls immediately before running the tool.
let _active_memory: MemoryClient | undefined;
const shared_memory = new Proxy({} as MemoryClient, {
  get(_t, prop) {
    if (!_active_memory) throw new Error('smoke: no active memory set (call ctx_for first)');
    const v = (_active_memory as unknown as Record<PropertyKey, unknown>)[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(_active_memory) : v;
  },
});

function tools_from_deps(users: UserRegistry): { weather: Tool[]; calendar: Tool[] } {
  const deps = { users, memory: shared_memory } as unknown as ToolDeps;
  return {
    weather: create_weather_tools(deps),
    calendar: create_sensor_calendar_tools({ memory: deps.memory } as ToolDeps),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any>;

function find(list: Tool[], name: string): AnyTool {
  const t = list.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not present in factory output`);
  return t as AnyTool;
}

function ctx_for(memory: MemoryClient, specialist_id = 'kate'): ToolContext {
  _active_memory = memory; // shared tools read their snapshot from the closure proxy
  return {
    intent_id: 'smoke_intent_' + Math.random().toString(36).slice(2, 10),
    agent: 'specialist',
    specialist_id,
    memory,
    // Other fields are tolerated as unknown by the tool execute signatures.
  } as unknown as ToolContext;
}

const CANNED_PIRATE = JSON.stringify({
  latitude: 39.739,
  longitude: -104.990,
  timezone: 'America/Denver',
  currently: {
    time: 1716800000,
    summary: 'Partly Cloudy',
    icon: 'partly-cloudy-day',
    temperature: 68.2,
    apparentTemperature: 67.0,
    humidity: 0.42,
    pressure: 1013,
    windSpeed: 8.5,
    windGust: 14.0,
    windBearing: 270,
    cloudCover: 0.45,
    uvIndex: 6,
    visibility: 10,
    precipIntensity: 0,
    precipProbability: 0.1,
    precipType: 'none',
  },
  hourly: {
    summary: 'Light rain this evening',
    icon: 'rain',
    data: Array.from({ length: 24 }, (_, i) => ({
      time: 1716800000 + i * 3600,
      icon: 'partly-cloudy-day',
      summary: 'Mild',
      temperature: 65 + Math.sin(i / 4) * 5,
      apparentTemperature: 64 + Math.sin(i / 4) * 5,
      humidity: 0.5,
      windSpeed: 7,
      windBearing: 270,
      cloudCover: 0.5,
      uvIndex: i > 8 && i < 18 ? 5 : 0,
      precipIntensity: i > 18 ? 0.05 : 0,
      precipProbability: i > 18 ? 0.6 : 0.05,
      precipType: i > 18 ? 'rain' : 'none',
    })),
  },
  daily: {
    summary: 'Mixed sun and showers through midweek',
    icon: 'partly-cloudy-day',
    data: Array.from({ length: 8 }, (_, i) => ({
      time: 1716800000 + i * 86400,
      icon: i === 0 ? 'partly-cloudy-day' : 'rain',
      summary: i === 0 ? 'Partly cloudy' : 'Showers',
      temperatureHigh: 75 - i,
      temperatureLow: 50 - i,
      sunriseTime: 1716800000 + i * 86400 + 22000,
      sunsetTime: 1716800000 + i * 86400 + 70000,
      precipProbability: i === 0 ? 0.2 : 0.7,
      precipIntensityMax: 0.15,
      precipType: i === 0 ? 'none' : 'rain',
      humidity: 0.45,
      uvIndex: 7,
      windSpeed: 8,
      windBearing: 270,
    })),
  },
  alerts: [],
  flags: { sources: ['nws', 'gfs'], units: 'us' },
});

function set_transport_ok(): void {
  _test_set_transport(async (_url) => ({
    ok: true,
    status: 200,
    body: CANNED_PIRATE,
  }));
}

function set_transport_fail(status: number, error: string): void {
  _test_set_transport(async (_url) => ({
    ok: false,
    status,
    body: '',
    error,
  }));
}

function make_snapshot(events_count: number, all_future: boolean): CalendarSnapshotResult {
  const now = Date.now();
  const events: CalendarSnapshotEventShape[] = [];
  for (let i = 0; i < events_count; i++) {
    const offset_ms = all_future ? (i + 1) * 3600_000 : (i - 1) * 3600_000;
    const start = new Date(now + offset_ms).toISOString();
    const end = new Date(now + offset_ms + 3600_000).toISOString();
    events.push({
      event_id: `evt_${i}`,
      title: `Event ${i}`,
      ts_start: start,
      ts_end: end,
      location: i % 2 === 0 ? 'Office' : null,
      is_all_day: false,
      calendar_name: 'Personal',
      calendar_type: 'caldav',
      organizer: null,
      has_attendees: true,
      notes_preview: null,
    });
  }
  return {
    user_id: 'jasper',
    captured_at: new Date(now - 60_000).toISOString(),
    received_at: new Date(now - 30_000).toISOString(),
    window_start: new Date(now - 7 * 86400_000).toISOString(),
    window_end: new Date(now + 60 * 86400_000).toISOString(),
    event_count: events_count,
    events,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

async function main() {
  const checks: string[] = [];

  // Env baseline. PIRATE_WEATHER_API_KEY is captured at module load
  // (top-level read in weather.ts), so this must be set BEFORE the
  // import. Bun reads it at run time the first call so we're safe.
  process.env.PIRATE_WEATHER_API_KEY = 'test-key';
  delete process.env.HEARTH_HOME_LAT;
  delete process.env.HEARTH_HOME_LON;

  // Per-user homes — Jasper at FoCo, Sam at Fairview. Different
  // coords → distinct cache keys → distinct fetches.
  const users = fake_users({
    jasper: { lat: 39.739, lng: -104.990, label: 'Pleasantville, CO' },
    sam: { lat: 39.578, lng: -104.76, label: 'Fairview, CO' },
  });
  const { weather: weather_tools, calendar: cal_tools } = tools_from_deps(users);
  const weather_now = find(weather_tools, 'weather_now');
  const weather_forecast = find(weather_tools, 'weather_forecast');
  const weather_alerts = find(weather_tools, 'weather_alerts');

  // ── 1. weather_now happy path — defaults to static anchor ─────────
  _test_clear_cache();
  set_transport_ok();
  {
    const { client } = fake_memory(); // no current location → anchor wins
    const out = await weather_now.execute({ user_id: 'jasper' }, ctx_for(client));
    assert(out.ok === true, '1a: weather_now ok');
    assert(out.temperature_f === 68.2, `1b: temperature_f want 68.2 got ${out.temperature_f}`);
    assert(out.condition?.icon === 'partly-cloudy-day', '1c: condition icon');
    assert(out.coords_used?.source === 'user_config', `1d: coords source user_config (got ${out.coords_used?.source})`);
    assert(out.coords_used?.confidence === 'static', '1e: anchor confidence static');
    assert(out.coords_used?.label === 'Pleasantville, CO', '1f: coords label threaded');
    assert(out.provider === 'pirate_weather', '1g: provider tag');
    checks.push('1. weather_now without current-location falls to home anchor');
  }

  // ── 1b. weather_now with fresh iOS sensor packet → current wins ───
  _test_clear_cache();
  set_transport_ok();
  {
    const fetched_urls: string[] = [];
    _test_set_transport(async (url) => {
      fetched_urls.push(url);
      return { ok: true, status: 200, body: CANNED_PIRATE };
    });
    // Jasper at the cabin — sensor packet 30 min old, 50m accuracy.
    const { client } = fake_memory({
      location_packet: {
        lat: 40.301, // some random cabin coords
        lng: -105.815,
        place_id: 'Cabin',
        accuracy_m: 50,
        age_seconds: 30 * 60,
      },
    });
    const out = await weather_now.execute({ user_id: 'jasper' }, ctx_for(client));
    assert(out.ok === true, '1b-i: weather_now ok with sensor packet');
    assert(
      out.coords_used?.source === 'sensor_current',
      `1b-ii: source=sensor_current (got ${out.coords_used?.source})`,
    );
    assert(out.coords_used?.confidence === 'high', '1b-iii: fresh sensor = high confidence');
    assert(
      typeof out.coords_used?.staleness_seconds === 'number' &&
        out.coords_used!.staleness_seconds! < 2000,
      '1b-iv: staleness_seconds threaded',
    );
    assert(
      fetched_urls[0]?.includes('40.301,-105.815'),
      `1b-v: Pirate fetched cabin coords (got ${fetched_urls[0]})`,
    );
    checks.push('1b. fresh iOS location packet wins over home anchor (cabin > home)');
  }

  // ── 1c. stale iOS sensor packet → falls through to anchor ─────────
  _test_clear_cache();
  set_transport_ok();
  {
    const { client } = fake_memory({
      location_packet: {
        lat: 40.301,
        lng: -105.815,
        place_id: 'Cabin',
        accuracy_m: 50,
        age_seconds: 12 * 3600, // 12h old — past the 6h freshness ceiling
      },
    });
    const out = await weather_now.execute({ user_id: 'jasper' }, ctx_for(client));
    assert(out.ok === true, '1c-i: weather_now ok');
    assert(
      out.coords_used?.source === 'user_config',
      `1c-ii: stale packet rejected, falls to anchor (got ${out.coords_used?.source})`,
    );
    checks.push('1c. stale sensor packet (>6h) falls through to home anchor');
  }

  // ── 1d. low-accuracy sensor packet → falls through to anchor ──────
  _test_clear_cache();
  set_transport_ok();
  {
    const { client } = fake_memory({
      location_packet: {
        lat: 40.301,
        lng: -105.815,
        accuracy_m: 5000, // 5km — past the 2km ceiling
        age_seconds: 60,
      },
    });
    const out = await weather_now.execute({ user_id: 'jasper' }, ctx_for(client));
    assert(out.ok === true, '1d-i: weather_now ok');
    assert(
      out.coords_used?.source === 'user_config',
      `1d-ii: low-accuracy packet rejected, falls to anchor (got ${out.coords_used?.source})`,
    );
    checks.push('1d. low-accuracy sensor packet (>2km) falls through to home anchor');
  }

  // ── 2. weather_now without any coords source ──────────────────────
  _test_clear_cache();
  set_transport_ok();
  {
    // No sensor packet, no per-user home, no env → resolver returns
    // null + recovery hint.
    const empty_users = fake_users({});
    const empty_now = find(create_weather_tools({ users: empty_users, memory: fake_memory().client } as ToolDeps), 'weather_now');
    const { client } = fake_memory();
    const out = await empty_now.execute({ user_id: 'ghost' }, ctx_for(client));
    assert(out.ok === false, '2a: ok=false when no coords');
    assert(
      typeof out.recovery_hint === 'string' &&
        out.recovery_hint.includes('users.yaml') &&
        out.recovery_hint.includes('/api/sensors/location'),
      `2b: recovery_hint cites iOS location route + users.yaml (got: ${out.recovery_hint})`,
    );
    checks.push('2. weather_now with no source returns recovery hint');
  }

  // ── 3. weather_now upstream-error recovery hint ────────────────────
  _test_clear_cache();
  set_transport_fail(0, 'PIRATE_WEATHER_API_KEY not set');
  {
    const { client } = fake_memory();
    const out = await weather_now.execute({ user_id: 'jasper' }, ctx_for(client));
    assert(out.ok === false, '3a: ok=false when upstream errors with missing-key');
    assert(
      typeof out.recovery_hint === 'string' && out.recovery_hint.includes('PIRATE_WEATHER_API_KEY'),
      `3b: recovery_hint cites PIRATE_WEATHER_API_KEY (got: ${out.recovery_hint})`,
    );
    checks.push('3. weather_now upstream error returns key-aware recovery hint');
  }

  // ── 4. weather_forecast slicing ────────────────────────────────────
  _test_clear_cache();
  set_transport_ok();
  {
    const { client } = fake_memory({ calendar: null });
    const out = await weather_forecast.execute(
      { hours: 6, days: 3, user_id: 'jasper' },
      ctx_for(client),
    );
    assert(out.ok === true, '4a: forecast ok');
    assert(out.hourly?.length === 6, `4b: hourly sliced to 6 (got ${out.hourly?.length})`);
    assert(out.daily?.length === 3, `4c: daily sliced to 3 (got ${out.daily?.length})`);
    assert(out.daily?.[0]?.temperature_high_f === 75, '4d: daily high temp');
    checks.push('4. weather_forecast slices hourly + daily to requested counts');
  }

  // ── 5. weather_alerts empty array ──────────────────────────────────
  _test_clear_cache();
  set_transport_ok();
  {
    const { client } = fake_memory({ calendar: null });
    const out = await weather_alerts.execute({ user_id: 'jasper' }, ctx_for(client));
    assert(out.ok === true, '5a: alerts ok');
    assert(Array.isArray(out.alerts) && out.alerts.length === 0, '5b: empty alerts array');
    checks.push('5. weather_alerts returns empty array (real answer for "no alerts")');
  }

  // ── 5b. per-user routing: jasper and sam hit distinct cache keys ───
  _test_clear_cache();
  const fetched_urls: string[] = [];
  _test_set_transport(async (url) => {
    fetched_urls.push(url);
    return { ok: true, status: 200, body: CANNED_PIRATE };
  });
  {
    const { client } = fake_memory({ calendar: null });
    await weather_now.execute({ user_id: 'jasper' }, ctx_for(client));
    await weather_now.execute({ user_id: 'sam' }, ctx_for(client));
    assert(
      fetched_urls.length === 2,
      `5b-i: per-user routes hit Pirate twice (got ${fetched_urls.length})`,
    );
    assert(
      fetched_urls[0]!.includes('39.739,-104.990'),
      '5b-ii: jasper request uses Pleasantville coords',
    );
    assert(
      fetched_urls[1]!.includes('39.578,-104.76'),
      '5b-iii: sam request uses Fairview coords',
    );
    // Second call for jasper should hit the cache (no new URL).
    await weather_now.execute({ user_id: 'jasper' }, ctx_for(client));
    assert(fetched_urls.length === 2, '5b-iv: 5-min TTL cache skips repeat jasper fetch');
    checks.push('5b. per-user routing dispatches distinct Pirate requests + caches per (lat,lng)');
  }
  // Restore canned-OK transport for subsequent tests.
  set_transport_ok();

  // ── 6. sensor_calendar_upcoming with snapshot ──────────────────────
  {
    const snap = make_snapshot(5, true);
    const { client } = fake_memory({ calendar: snap });
    const upcoming = find(cal_tools, 'sensor_calendar_upcoming');
    void client; // cal_tools were built from a different memory; re-make to inject this snapshot
    const tools = create_sensor_calendar_tools({ memory: client } as unknown as ToolDeps);
    const upcoming2 = find(tools, 'sensor_calendar_upcoming');
    void upcoming;
    const out = (await upcoming2.execute({ limit: 3 }, ctx_for(client))) as {
      ok: boolean;
      events: Array<{ event_id: string }>;
    };
    assert(out.ok === true, '6b: upcoming ok');
    assert(out.events.length === 3, `6c: limited to 3 (got ${out.events.length})`);
    assert(out.events[0]?.event_id === 'evt_0', '6d: chronological order, first event_id');
    // The output localizes times into `when`/`when_end` (display strings — never
    // re-convert them), so chronological order is asserted via the event_id
    // sequence: make_snapshot names events chronologically (evt_0 earliest), and
    // the tool sorts by ts_start, so a correctly-sorted top-3 is evt_0/1/2.
    const ids = out.events.map((e) => e.event_id);
    const sorted = ids[0] === 'evt_0' && ids[1] === 'evt_1' && ids[2] === 'evt_2';
    assert(sorted, '6e: events in chronological order');
    checks.push('6. sensor_calendar_upcoming returns chronological, limited, future events');
  }

  // ── 7. sensor_calendar_upcoming without snapshot ───────────────────
  {
    const { client } = fake_memory({ calendar: null });
    const tools = create_sensor_calendar_tools({ memory: client } as unknown as ToolDeps);
    const upcoming = find(tools, 'sensor_calendar_upcoming');
    const out = (await upcoming.execute({ limit: 5 }, ctx_for(client))) as {
      ok: boolean;
      recovery_hint?: string;
    };
    assert(out.ok === false, '7a: ok=false when no snapshot');
    assert(
      typeof out.recovery_hint === 'string' && out.recovery_hint.includes('iOS'),
      '7b: recovery_hint cites iOS push path',
    );
    checks.push('7. sensor_calendar_upcoming without snapshot returns recovery hint');
  }

  // ── 8. pull_brief_context — anchor path ────────────────────────────
  _test_clear_cache();
  set_transport_ok();
  {
    const snap = make_snapshot(3, true);
    const { client } = fake_memory({ calendar: snap }); // no current location → anchor
    const ctx = await pull_brief_context({ memory: client, user_id: 'jasper', users });
    assert(
      ctx.weather.forecast.status === 'fresh',
      `8a: weather forecast fresh (got ${ctx.weather.forecast.status} reason=${ctx.weather.forecast.reason})`,
    );
    assert(
      ctx.weather.temperature_high_today.value === 75,
      '8b: weather high temp threaded through',
    );
    assert(
      String(ctx.weather.forecast.source_entity ?? '').includes('via user_config'),
      `8c: brief source cites user_config (anchor path) (got: ${ctx.weather.forecast.source_entity})`,
    );
    assert(ctx.calendar.status === 'fresh', '8d: calendar fresh');
    assert(ctx.calendar.today.length + ctx.calendar.tomorrow.length === 3, '8e: events split today/tomorrow');
    checks.push('8. pull_brief_context: anchor path cites user_config source');
  }

  // ── 8b. pull_brief_context — sensor_current path ───────────────────
  _test_clear_cache();
  set_transport_ok();
  {
    const snap = make_snapshot(2, true);
    const { client } = fake_memory({
      calendar: snap,
      location_packet: {
        lat: 40.301,
        lng: -105.815,
        place_id: 'Cabin',
        accuracy_m: 30,
        age_seconds: 5 * 60, // 5 min — very fresh
      },
    });
    const ctx = await pull_brief_context({ memory: client, user_id: 'jasper', users });
    assert(ctx.weather.forecast.status === 'fresh', '8b-i: weather fresh');
    assert(
      String(ctx.weather.forecast.source_entity ?? '').includes('via sensor_current'),
      `8b-ii: brief source cites sensor_current (got: ${ctx.weather.forecast.source_entity})`,
    );
    assert(
      String(ctx.weather.forecast.source_entity ?? '').includes('Cabin'),
      '8b-iii: place label threaded ("Cabin")',
    );
    checks.push('8b. pull_brief_context: fresh sensor packet routes to current location');
  }

  // ── 9. pull_brief_context degraded (unknown user) ──────────────────
  _test_clear_cache();
  set_transport_ok();
  {
    const empty_users = fake_users({}); // no homes registered
    const { client } = fake_memory(); // no calendar, no location packet
    const ctx = await pull_brief_context({ memory: client, user_id: 'ghost', users: empty_users });
    assert(ctx.weather.forecast.status === 'unavailable', '9a: weather unavailable');
    assert(
      typeof ctx.weather.forecast.reason === 'string' &&
        ctx.weather.forecast.reason.includes('home_location'),
      `9b: weather reason cites home_location (got: ${ctx.weather.forecast.reason})`,
    );
    assert(ctx.calendar.status === 'unavailable', '9c: calendar unavailable');
    assert(
      typeof ctx.calendar.reason === 'string' && ctx.calendar.reason.includes('iOS'),
      '9d: calendar reason cites iOS push path',
    );
    checks.push('9. pull_brief_context surfaces actionable unavailable reasons');
  }

  console.log('\nweather + brief smoke ✓');
  for (const c of checks) console.log(`  ✓ ${c}`);
}

main()
  // A module-level handle (weather/location caches) keeps the loop alive on the
  // success path — fail() already process.exit(1)s, so exit cleanly on pass too.
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

// Suppress unused-import noise from the local imports we touch only in
// stub-construction paths above (TypeScript flags them when the smoke
// is type-checked in isolation).
void resolve;
void tmpdir;
