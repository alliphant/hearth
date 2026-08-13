/**
 * smoke:presence — self-contained test of the LD2450 presence office backend
 * (design-ld2450-zone-editor.md). Mounts the REAL /api/presence router on a
 * throwaway Hono app with an injectable user, a real AppEventBus (to assert
 * SSE fan-out), a temp SQLite db, and a fresh PresenceLiveCache.
 *
 * Asserts:
 *   - targets POST caches the snapshot + emits `presence_targets`;
 *   - state GET degrades (device_connected:false) before any targets, and
 *     reports the live snapshot + zones after;
 *   - the zone write lifecycle: POST zones → pending → coordinator pending
 *     poll → ack → applied (+ `presence_zones_acked` SSE);
 *   - owner-gating (state/zones/settings/reboot are 403 for non-owner);
 *   - out-of-range corners 4xx; stale-revision ack is ignored;
 *   - settings calibration does NOT bump the zone revision;
 *   - reboot request surfaces in the coordinator's pending poll.
 *
 *   bun run smoke:presence
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { AppEventBus, type AppEvent } from '@app/events';
import { create_presence_router } from '@app/routes/presence';
import { PresenceZonesStore, DEFAULT_PRESENCE_DEVICE_ID } from '@memory/stores/presence_zones';
import { get_presence_cache, _reset_presence_cache_for_test } from '@core/presence_cache';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const DEV = DEFAULT_PRESENCE_DEVICE_ID;
const dir = mkdtempSync(join(tmpdir(), 'hearth-presence-'));
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root: join(dir, 'vault'), db });
const bus = new AppEventBus();
const events_seen: AppEvent[] = [];
bus.subscribe((e) => events_seen.push(e));

_reset_presence_cache_for_test();

// Mount the real router; the test middleware sets the user from a header so we
// can simulate owner / non-owner / unauthenticated callers.
const app = new Hono();
app.use('*', async (c, next) => {
  const tier = c.req.header('x-test-tier');
  if (tier && tier !== 'none') c.set('user', { id: 'tester', tier } as never);
  await next();
});
app.route('/api/presence', create_presence_router({ db, memory, events: bus }));

type Tier = 'owner' | 'household' | 'none';
async function req(
  method: string,
  path: string,
  opts: { tier?: Tier; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'x-test-tier': opts.tier ?? 'owner' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }),
  );
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  device_id: DEV,
  present: true,
  moving: 1,
  still: 0,
  nearest_mm: 1850,
  targets: [
    { index: 1, x_mm: -320, y_mm: 1820, speed_mms: 110, angle_deg: -10, distance_mm: 1850, active: true },
  ],
  captured_at: new Date().toISOString(),
  ...overrides,
});

try {
  // 1 — cold state: no targets yet → device_connected false, but config present.
  {
    const { status, json } = await req('GET', '/api/presence/state');
    check('state GET (owner) 200 before any targets', status === 200);
    check('cold state device_connected:false', json?.device_connected === false);
    check('cold state has 3 default zones', json?.config?.zones?.length === 3);
    check('cold state snapshot null', json?.snapshot === null);
  }

  // 2 — state GET is owner-gated.
  {
    const { status } = await req('GET', '/api/presence/state', { tier: 'household' });
    check('state GET (household) 403', status === 403);
    const anon = await req('GET', '/api/presence/state', { tier: 'none' });
    check('state GET (unauthenticated) 403', anon.status === 403);
  }

  // 3 — targets POST caches + emits presence_targets.
  {
    events_seen.length = 0;
    const { status, json } = await req('POST', '/api/presence/targets', { tier: 'none', body: snapshot() });
    check('targets POST 200 (no owner needed — machine route)', status === 200 && json?.ok === true);
    check('targets POST emitted presence_targets', events_seen.some((e) => e.type === 'presence_targets'));
    check('cache.is_live true after POST', get_presence_cache().is_live(DEV));
  }

  // 4 — state GET now reports the live snapshot.
  {
    const { json } = await req('GET', '/api/presence/state');
    check('state device_connected:true after targets', json?.device_connected === true);
    check('state carries the live snapshot', json?.snapshot?.present === true && json?.snapshot?.targets?.length === 1);
  }

  // 5 — targets POST rejects a malformed snapshot (4 targets > max 3).
  {
    const bad = snapshot({ targets: [1, 2, 3, 4].map((i) => ({ index: i, x_mm: 0, y_mm: 0, speed_mms: 0, angle_deg: null, distance_mm: 0, active: false })) });
    const { status } = await req('POST', '/api/presence/targets', { tier: 'none', body: bad });
    check('targets POST 400 on >3 targets', status === 400);
  }

  // 6 — zone write lifecycle: owner saves → pending → coordinator poll → ack.
  {
    events_seen.length = 0;
    const zones = [{ index: 1, type: 'Detection', x1_mm: -1000, y1_mm: 500, x2_mm: 1000, y2_mm: 2500 }];
    const save = await req('POST', '/api/presence/zones', { body: { device_id: DEV, zones } });
    check('zones POST (owner) 200', save.status === 200);
    check('zones POST → status pending', save.json?.config?.status === 'pending');
    check('zones POST → revision 1', save.json?.config?.revision === 1);
    check('zones POST → zone 1 is Detection', save.json?.config?.zones?.[0]?.type === 'Detection');

    const pend = await req('GET', `/api/presence/zones/pending?device_id=${DEV}`, { tier: 'none' });
    check('coordinator pending poll returns revision 1', pend.json?.pending?.revision === 1);
    check('pending carries the zone corners', pend.json?.pending?.zones?.[0]?.x1_mm === -1000);

    const ack = await req('POST', '/api/presence/zones/ack', {
      tier: 'none',
      body: { device_id: DEV, revision: 1, applied: true, reboot_required: false },
    });
    check('ack 200 → status applied', ack.status === 200 && ack.json?.config?.status === 'applied');
    check('ack emitted presence_zones_acked', events_seen.some((e) => e.type === 'presence_zones_acked'));

    const pend2 = await req('GET', `/api/presence/zones/pending?device_id=${DEV}`, { tier: 'none' });
    check('pending poll null after ack', pend2.json?.pending === null);
  }

  // 7 — zones POST is owner-gated + range-validated.
  {
    const z = [{ index: 1, type: 'Detection', x1_mm: 0, y1_mm: 0, x2_mm: 100, y2_mm: 100 }];
    const nonowner = await req('POST', '/api/presence/zones', { tier: 'household', body: { zones: z } });
    check('zones POST (household) 403', nonowner.status === 403);
    const oob = await req('POST', '/api/presence/zones', {
      body: { zones: [{ index: 1, type: 'Detection', x1_mm: 0, y1_mm: 0, x2_mm: 100, y2_mm: 7000 }] },
    });
    check('zones POST 400 on out-of-range Y (7000 > 6000)', oob.status === 400);
  }

  // 8 — stale-revision ack is ignored (a newer save survives).
  {
    const save2 = await req('POST', '/api/presence/zones', {
      body: { device_id: DEV, zones: [{ index: 2, type: 'Filter', x1_mm: -500, y1_mm: 0, x2_mm: 500, y2_mm: 800 }] },
    });
    check('second save → revision 2 pending', save2.json?.config?.revision === 2 && save2.json?.config?.status === 'pending');
    const stale = await req('POST', '/api/presence/zones/ack', {
      tier: 'none',
      body: { device_id: DEV, revision: 1, applied: true },
    });
    check('stale ack (rev 1) leaves status pending', stale.json?.config?.status === 'pending' && stale.json?.config?.revision === 2);
    // Now ack the real revision to settle.
    await req('POST', '/api/presence/zones/ack', { tier: 'none', body: { device_id: DEV, revision: 2, applied: true } });
  }

  // 9 — settings calibration does NOT bump the zone revision.
  {
    const before = new PresenceZonesStore(db).get(DEV);
    const set = await req('POST', '/api/presence/settings', {
      body: { device_id: DEV, room_name: 'Studio', firmware_target: 'entity', mount_rotation_deg: 15, zones: [{ index: 1, name: 'Couch' }] },
    });
    check('settings POST (owner) 200', set.status === 200);
    check('settings applied room_name', set.json?.config?.room_name === 'Studio');
    check('settings applied firmware_target', set.json?.config?.firmware_target === 'entity');
    check('settings applied zone presentation name', set.json?.config?.zones?.[0]?.name === 'Couch');
    check('settings did NOT bump revision', set.json?.config?.revision === before.revision);
    const nonowner = await req('POST', '/api/presence/settings', { tier: 'household', body: { room_name: 'x' } });
    check('settings POST (household) 403', nonowner.status === 403);
    const get = await req('GET', '/api/presence/settings');
    check('settings GET returns the config', get.json?.config?.room_name === 'Studio');
  }

  // 10 — reboot request surfaces in the coordinator's pending poll.
  {
    const reboot = await req('POST', '/api/presence/reboot', { body: { device_id: DEV } });
    check('reboot POST (owner) 200 queued', reboot.status === 200 && reboot.json?.queued === true);
    check('reboot set reboot_requested', reboot.json?.config?.reboot_requested === true);
    const pend = await req('GET', `/api/presence/zones/pending?device_id=${DEV}`, { tier: 'none' });
    check('pending poll non-null due to reboot_requested', pend.json?.pending?.reboot_requested === true);
    const nonowner = await req('POST', '/api/presence/reboot', { tier: 'household' });
    check('reboot POST (household) 403', nonowner.status === 403);
  }
} finally {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll presence smoke checks passed.');
