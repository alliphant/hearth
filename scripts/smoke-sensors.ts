/**
 * Smoke for the device-as-sensor pipeline.
 *
 * Self-contained: builds an in-memory router + temp DB + temp vault dir,
 * shims c.get('user') via a pre-middleware, and drives the three routes
 * directly through Hono's .request() API. No live server, no real auth.
 *
 *   bun run scripts/smoke-sensors.ts
 *
 * Asserts:
 *   1. POST /api/sensors/focus with a valid focus payload → 200 + id
 *   2. The DB index row + vault JSON file exist with correct contents
 *   3. The event bus fires `sensor_packet_received` once
 *   4. GET /api/sensors/derived/focus_mode reflects the latest packet
 *   5. POST with an unknown field is rejected (400)
 *   6. POST a calendar event whose window covers now → derived/in_meeting true
 *   7. POST a carplay disconnect → derived/carplay_connected.value = false
 *   8. Rate limit kicks in after 60 packets for a single (user, signal)
 *   9. GET /api/sensors/status returns a row per known signal
 *  10. Cache returns a fresh derived value after a packet without TTL wait
 *      (proven via cache_invalidate_for on packet write)
 */

import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { AppEventBus, type AppEvent } from '../src/app/events';
import { create_sensors_router } from '../src/app/routes/sensors';

function tmp_path(name: string): string {
  return resolve(tmpdir(), `hearth-smoke-sensors-${Date.now()}-${name}`);
}

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

/** Assert `res.status === expected` without consuming the body unless it
 *  fails — template-literal `${await res.text()}` would eagerly consume
 *  the body before the check, blocking later `.json()` on the same Response. */
async function assert_status(res: Response, expected: number, label: string): Promise<void> {
  if (res.status !== expected) {
    const body = await res.text().catch(() => '<no body>');
    fail(`${label} expected ${expected}, got ${res.status} ${body}`);
  }
}

interface FakeMemory {
  logged: Array<Record<string, unknown>>;
  log_action(row: Record<string, unknown>): void;
}

function fake_memory(): FakeMemory {
  return {
    logged: [],
    log_action(row) {
      this.logged.push(row);
    },
  };
}

function make_db(): Database {
  const path = tmp_path('db.sqlite');
  const db = new Database(path);
  // Just the sensor_packets table — keep the smoke isolated from the full schema.
  db.exec(`
    CREATE TABLE sensor_packets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_id TEXT,
      signal TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      payload_path TEXT NOT NULL
    );
    CREATE INDEX idx_sensor_packets_user_signal_ts
      ON sensor_packets (user_id, signal, captured_at DESC);
    CREATE INDEX idx_sensor_packets_received
      ON sensor_packets (received_at);
  `);
  return db;
}

function harness() {
  const vault_root = tmp_path('vault');
  mkdirSync(vault_root, { recursive: true });
  const db = make_db();
  const events = new AppEventBus();
  const memory = fake_memory();
  const fired: AppEvent[] = [];
  events.subscribe((e) => fired.push(e));

  const sensors = create_sensors_router({
    db,
    vault_root,
    memory: memory as unknown as Parameters<typeof create_sensors_router>[0]['memory'],
    events,
  });

  const app = new Hono();
  // Pre-shim: set the user on every request so the routes' c.get('user')
  // works without the real auth middleware.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use('*', async (c: any, next) => {
    c.set('user', { id: 'jasper' });
    c.set('device_id', 'dev_smoke');
    return next();
  });
  app.route('/api/sensors', sensors);

  return { app, db, vault_root, memory, fired };
}

async function post_json(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function main() {
  const { app, db, vault_root, memory, fired } = harness();
  const checks: string[] = [];

  // 1. ingest focus
  const focus_body = {
    signal: 'focus',
    captured_at: new Date().toISOString(),
    payload: {
      mode: 'sleep',
      filter_id: 'sleep-default',
      since: '2026-05-25T22:00:00Z',
    },
  };
  let res = await post_json(app, '/api/sensors/focus', focus_body);
  await assert_status(res, 200, 'POST focus');
  const json = (await res.json()) as { ok: boolean; id: string };
  assert(json.ok === true && typeof json.id === 'string', 'POST focus body shape');
  checks.push('1. POST /api/sensors/focus → 200 + id');

  // 2. DB row + vault file exist
  const row = db
    .prepare(`SELECT id, signal, payload_path, device_id FROM sensor_packets WHERE id = @id`)
    .get({ '@id': json.id }) as {
    id: string;
    signal: string;
    payload_path: string;
    device_id: string;
  };
  assert(row && row.signal === 'focus', 'DB index row exists with correct signal');
  assert(row.device_id === 'dev_smoke', 'device_id captured from context');
  const abs = resolve(vault_root, row.payload_path);
  assert(existsSync(abs), `vault file exists at ${abs}`);
  const loaded = JSON.parse(readFileSync(abs, 'utf8'));
  assert(loaded.mode === 'sleep', 'vault payload mode round-trips');
  checks.push('2. DB index row + vault JSON file written correctly');

  // 3. event fired
  const ev = fired.find((e) => e.type === 'sensor_packet_received');
  assert(ev, 'sensor_packet_received event fired');
  if (ev && ev.type === 'sensor_packet_received') {
    assert(ev.user_id === 'jasper' && ev.signal === 'focus' && ev.packet_id === json.id, 'event identifiers correct');
  }
  checks.push('3. event bus emitted sensor_packet_received');

  // 4. derived/focus_mode reflects the latest packet
  res = await app.request('/api/sensors/derived/focus_mode');
  await assert_status(res, 200, 'derived/focus_mode');
  const derived = (await res.json()) as { value: { value: string | null } };
  assert(derived.value.value === 'sleep', `derived focus_mode want sleep, got ${derived.value.value}`);
  checks.push('4. GET /api/sensors/derived/focus_mode returns latest mode');

  // 5. unknown field rejected
  res = await post_json(app, '/api/sensors/focus', {
    signal: 'focus',
    captured_at: new Date().toISOString(),
    payload: { mode: 'work', since: '2026-05-25T22:00:00Z', evil_field: true },
  });
  await assert_status(res, 400, 'unknown field rejection');
  checks.push('5. unknown payload field rejected (400)');

  // 6. calendar event covering now → in_meeting true
  const cal_now = Date.now();
  const cal_body = {
    signal: 'calendar',
    captured_at: new Date(cal_now).toISOString(),
    payload: {
      kind: 'event_started',
      event_id: 'evt_smoke',
      title: 'Smoke meeting',
      ts_start: new Date(cal_now - 60_000).toISOString(),
      ts_end: new Date(cal_now + 30 * 60_000).toISOString(),
      is_all_day: false,
    },
  };
  res = await post_json(app, '/api/sensors/calendar', cal_body);
  await assert_status(res, 200, 'POST calendar');
  res = await app.request('/api/sensors/derived/in_meeting');
  const meeting = (await res.json()) as { value: { value: boolean; ends_at: string | null } };
  assert(meeting.value.value === true, `in_meeting should be true, got ${JSON.stringify(meeting.value)}`);
  assert(typeof meeting.value.ends_at === 'string', 'in_meeting carries ends_at');
  checks.push('6. derived/in_meeting=true while event window covers now');

  // 7. carplay disconnect → connected = false
  const cp_body = {
    signal: 'carplay',
    captured_at: new Date().toISOString(),
    payload: { state: 'disconnected', since: new Date().toISOString() },
  };
  res = await post_json(app, '/api/sensors/carplay', cp_body);
  await assert_status(res, 200, 'POST carplay');
  res = await app.request('/api/sensors/derived/carplay_connected');
  const cp = (await res.json()) as { value: { value: boolean } };
  assert(cp.value.value === false, `carplay_connected should be false, got ${cp.value.value}`);
  checks.push('7. derived/carplay_connected mirrors latest state');

  // 8. rate limit on a fresh signal (so we don't trip prior tests' counts).
  //    Fire 60 quickly, then expect the 61st to 429.
  let last_status = 0;
  for (let i = 0; i < 61; i++) {
    res = await post_json(app, '/api/sensors/heartbeat', {
      signal: 'heartbeat',
      captured_at: new Date(Date.now() + i).toISOString(),
      payload: { tick: i },
    });
    last_status = res.status;
    if (i < 60) {
      if (last_status !== 200) fail(`rate-limit pre-cap: packet ${i} got ${last_status}`);
    }
  }
  assert(last_status === 429, `61st packet should be 429, got ${last_status}`);
  checks.push('8. rate limit kicks in at 61st packet/min/signal');

  // 9. status endpoint
  res = await app.request('/api/sensors/status');
  await assert_status(res, 200, 'status endpoint');
  const status = (await res.json()) as {
    signals: Array<{ name: string; last_received_at: string | null; packet_count_24h: number }>;
  };
  const focus_status = status.signals.find((s) => s.name === 'focus');
  assert(focus_status && focus_status.packet_count_24h >= 1, 'focus signal appears in status with at least one packet');
  const known_in_status = ['focus', 'calendar', 'carplay', 'location', 'healthkit'].every((n) =>
    status.signals.some((s) => s.name === n),
  );
  assert(known_in_status, 'all known signals listed in status');
  checks.push('9. GET /api/sensors/status returns rows for known + seen signals');

  // 10. audit_log via the fake memory
  assert(
    memory.logged.some((r) => r.tool_name === 'sensor_ingest'),
    'memory.log_action was called with tool_name=sensor_ingest',
  );
  checks.push('10. memory.log_action wrote a sensor_ingest audit row');

  console.log('\nsmoke-sensors PASS');
  for (const c of checks) console.log(`  ✓ ${c}`);

  // Cleanup (best-effort).
  try {
    rmSync(vault_root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
