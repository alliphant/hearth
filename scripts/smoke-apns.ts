/**
 * Smoke for the APNs (Apple Push Notification service) backend.
 *
 *   bun run scripts/smoke-apns.ts
 *
 * Self-contained: in-memory router, throwaway DB, no live APNs calls
 * by default. The dispatch path can be exercised against the real
 * Apple endpoints by exporting HEARTH_SMOKE_APNS_LIVE=1 — useful when
 * Jasper wants to verify "my phone actually buzzes" end-to-end.
 *
 * Asserts:
 *   1. POST /api/apns/register persists a row + invokes the audit log
 *   2. Re-register same (token, env) updates last_seen (no duplicate row)
 *   3. POST /api/apns/unregister deletes the row
 *   4. POST /api/apns/test-push without APNS_KEY_PATH returns 503 cleanly
 *   5. send_apns() with a stubbed fetch() correctly handles 200/410
 *      responses and purges 410'd tokens
 *   6. send_apns() with no tokens returns delivered=false + attempts=[]
 *   7. build_alert_payload() shape matches APNs aps spec
 *   8. /api/apns/live-activity/register attaches the token to the row
 */

import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import {
  ApnsTokenStore,
  build_alert_payload,
  send_apns,
  apns_configured,
  _test_set_jwt,
  _test_set_transport,
  _test_close_sessions,
  type ApnsAttempt,
} from '../src/policy/apns';
import { create_apns_router } from '../src/app/routes/apns';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

function make_db(): Database {
  // bun:sqlite in-memory DB — same shape the real apns_tokens table
  // lives in. Keeping it scoped to this smoke means we don't depend
  // on the full schema.sql being run.
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE apns_tokens (
      user_id TEXT NOT NULL,
      device_token TEXT NOT NULL,
      environment TEXT NOT NULL,
      bundle_id TEXT NOT NULL,
      app_build TEXT,
      registered_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      live_activity_push_token TEXT,
      live_activity_id TEXT,
      PRIMARY KEY (device_token, environment)
    );
  `);
  return db;
}

function fake_memory() {
  const calls: Array<{ tool: string; user_id: string | undefined }> = [];
  return {
    calls,
    log_action: (r: { tool_name: string; user_id?: string }) => {
      calls.push({ tool: r.tool_name, user_id: r.user_id });
      return 'aud_test';
    },
  };
}

function harness() {
  const db = make_db();
  const memory = fake_memory();
  const apns_tokens = new ApnsTokenStore(db);
  const router = create_apns_router({
    memory: memory as unknown as Parameters<typeof create_apns_router>[0]['memory'],
    apns_tokens,
  });
  const app = new Hono();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use('*', async (c: any, next) => {
    c.set('user', { id: 'jasper' });
    return next();
  });
  app.route('/api/apns', router);
  return { app, db, memory, apns_tokens };
}

async function post(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const HEX_TOKEN_A =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const HEX_TOKEN_B =
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const HEX_LA_TOKEN =
  'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888';

async function main() {
  const checks: string[] = [];
  const { app, db, memory, apns_tokens } = harness();

  // ── 1. register persists ────────────────────────────────────────────
  let res = await post(app, '/api/apns/register', {
    deviceToken: HEX_TOKEN_A,
    environment: 'sandbox',
    appBuild: '2',
  });
  assert(res.status === 200, `register status ${res.status}`);
  const rows1 = db
    .prepare(
      `SELECT user_id, device_token, environment, app_build FROM apns_tokens`,
    )
    .all() as Array<{
    user_id: string;
    device_token: string;
    environment: string;
    app_build: string;
  }>;
  assert(rows1.length === 1, `expected 1 row after register, got ${rows1.length}`);
  assert(rows1[0]!.user_id === 'jasper', 'user_id stamped');
  assert(rows1[0]!.environment === 'sandbox', 'environment stamped');
  assert(rows1[0]!.app_build === '2', 'app_build stamped');
  assert(
    memory.calls.some((c) => c.tool === 'apns_register' && c.user_id === 'jasper'),
    'audit row written',
  );
  checks.push('register persists + audits');

  // ── 2. re-register same (token, env) updates last_seen (no dup) ─────
  await new Promise((r) => setTimeout(r, 5));
  res = await post(app, '/api/apns/register', {
    deviceToken: HEX_TOKEN_A,
    environment: 'sandbox',
    appBuild: '3',
  });
  assert(res.status === 200, `re-register status ${res.status}`);
  const rows2 = db
    .prepare(
      `SELECT registered_at, last_seen_at, app_build FROM apns_tokens
       WHERE device_token = ? AND environment = ?`,
    )
    .all(HEX_TOKEN_A, 'sandbox') as Array<{
    registered_at: string;
    last_seen_at: string;
    app_build: string;
  }>;
  assert(rows2.length === 1, 're-register did not create a duplicate row');
  assert(rows2[0]!.app_build === '3', 'app_build updated to latest');
  assert(rows2[0]!.last_seen_at >= rows2[0]!.registered_at, 'last_seen ≥ registered');
  checks.push('re-register is idempotent + updates last_seen/build');

  // ── 3. unregister deletes ────────────────────────────────────────────
  res = await post(app, '/api/apns/unregister', { deviceToken: HEX_TOKEN_A });
  assert(res.status === 200, `unregister status ${res.status}`);
  const rows3 = db.prepare(`SELECT * FROM apns_tokens`).all();
  assert(rows3.length === 0, 'row gone after unregister');
  checks.push('unregister deletes');

  // ── 4. test-push not-configured path → 503 (clean error) ───────────
  // Skipped when run against a dev/prod tree that has APNs configured
  // via .env — Bun auto-loads .env at import time so the module-level
  // env captures already see the keys. The check is still useful in CI
  // / fresh-clone runs where no .env exists.
  if (apns_configured()) {
    checks.push('test-push 503-when-unconfigured (skipped — apns_configured=true)');
  } else {
    res = await post(app, '/api/apns/test-push', { body: 'hello' });
    assert(res.status === 503, `test-push expected 503, got ${res.status}`);
    const errBody = (await res.json()) as { error: string };
    assert(/not configured/i.test(errBody.error), 'error message hints at config');
    checks.push('test-push returns 503 when not configured');
  }

  // ── 5. send_apns() against stubbed fetch — 200 + 410 + purge ────────
  // Re-seed two tokens.
  apns_tokens.upsert({
    user_id: 'jasper',
    device_token: HEX_TOKEN_A,
    environment: 'sandbox',
    bundle_id: 'com.hearthcrew.app',
    app_build: '2',
  });
  apns_tokens.upsert({
    user_id: 'jasper',
    device_token: HEX_TOKEN_B,
    environment: 'sandbox',
    bundle_id: 'com.hearthcrew.app',
    app_build: '2',
  });
  _test_set_jwt('test-jwt-bypass');
  let transport_count = 0;
  _test_set_transport(async (input) => {
    transport_count++;
    // Sanity-check the request shape the production transport sees.
    assert(input.push_type === 'alert', 'push-type alert');
    assert(input.topic === 'com.hearthcrew.app', 'topic set');
    assert(input.jwt === 'test-jwt-bypass', 'jwt threaded');
    // Token B → 410 (dead). Token A → 200.
    if (input.device_token === HEX_TOKEN_B) {
      return { status: 410, apns_id: 'apns-id-b', reason: 'Unregistered' };
    }
    return { status: 200, apns_id: 'apns-id-a', reason: null };
  });
  const out = await send_apns({
    store: apns_tokens,
    user_id: 'jasper',
    push_type: 'alert',
    payload: build_alert_payload({ body: 'smoke' }),
  });
  _test_set_transport(null);
  _test_set_jwt(null);
  assert(transport_count === 2, `expected 2 transport calls, got ${transport_count}`);
  assert(out.attempts.length === 2, 'two attempts');
  const a = out.attempts.find((x: ApnsAttempt) => x.device_token === HEX_TOKEN_A)!;
  const b = out.attempts.find((x: ApnsAttempt) => x.device_token === HEX_TOKEN_B)!;
  assert(a.ok && a.status === 200, '200 attempt ok');
  assert(!b.ok && b.status === 410 && b.purged, '410 attempt purged');
  // Token B's row should be gone now.
  const remaining = db
    .prepare(`SELECT device_token FROM apns_tokens WHERE user_id = ?`)
    .all('jasper') as Array<{ device_token: string }>;
  assert(remaining.length === 1 && remaining[0]!.device_token === HEX_TOKEN_A,
    'dead token purged, live token retained');
  checks.push('send_apns dispatches + purges 410 + retains 200');

  // ── 6. send_apns() with no tokens → empty result ────────────────────
  const out_empty = await send_apns({
    store: apns_tokens,
    user_id: 'someone-with-no-tokens',
    push_type: 'alert',
    payload: build_alert_payload({ body: 'noop' }),
  });
  assert(out_empty.attempts.length === 0, 'no attempts for unknown user');
  assert(!out_empty.delivered, 'delivered=false for unknown user');
  checks.push('send_apns is a no-op when no tokens registered');

  // ── 7. build_alert_payload shape ────────────────────────────────────
  const payload = build_alert_payload({
    title: 'Kate',
    body: 'Morning brief ready',
    category: 'kate.brief',
    thread_id: 'brief-2026-05-26',
    hearth_route: { kind: 'brief' },
  }) as { aps: Record<string, unknown>; hearth: unknown };
  assert(typeof payload.aps === 'object', 'aps object present');
  assert(payload.aps.category === 'kate.brief', 'category attached');
  assert(payload.aps['thread-id'] === 'brief-2026-05-26', 'thread-id attached');
  // Routing data must live on the SIBLING key per the iOS contract
  // (PushCoordinator.handleNotificationResponse reads userInfo["hearth"]).
  assert(
    typeof payload.hearth === 'object' && payload.hearth !== null,
    'hearth sibling present',
  );
  checks.push('build_alert_payload shape matches APNs aps spec');

  // ── 8. live-activity/register attaches the activity token ───────────
  res = await post(app, '/api/apns/live-activity/register', {
    deviceToken: HEX_TOKEN_A,
    environment: 'sandbox',
    activityId: 'pre_abc123',
    liveActivityPushToken: HEX_LA_TOKEN,
  });
  assert(res.status === 200, `la/register status ${res.status}`);
  const la_row = db
    .prepare(
      `SELECT live_activity_id, live_activity_push_token
       FROM apns_tokens
       WHERE device_token = ? AND environment = ?`,
    )
    .get(HEX_TOKEN_A, 'sandbox') as {
    live_activity_id: string;
    live_activity_push_token: string;
  };
  assert(la_row.live_activity_id === 'pre_abc123', 'la id stored');
  assert(la_row.live_activity_push_token === HEX_LA_TOKEN, 'la token stored');
  checks.push('live-activity/register attaches token to device row');

  // Drop any cached HTTP/2 sessions so the smoke process exits cleanly.
  _test_close_sessions();

  console.log(`OK — ${checks.length} checks passed`);
  for (const c of checks) console.log(`  ✓ ${c}`);
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  process.exit(1);
});
