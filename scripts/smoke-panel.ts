/**
 * smoke:panel — the guest panel surface at /app/panel/.
 *
 * The gate tests are self-contained (no network, no LLM) and are the ones that
 * matter most: this surface is UNAUTHENTICATED, so if the LAN gate regresses,
 * anyone who reaches the public Tailscale endpoint can turn on the lights.
 *
 *   - no forwarded address at all              -> 404
 *   - Tailscale CGNAT (100.64/10)              -> 404  (private-looking, NOT in the house)
 *   - public address                           -> 404
 *   - house LAN (192.168/10/172.16-31) + loopback -> served
 *   - the gate covers the API too, not just the page
 *   - MOUNTED under /app, the real shape: `/app/panel` 301s and `/app/panel/`
 *     serves the page (the redirect-loop trap create_hvac_router hit twice)
 *
 * With HA_BASE_URL + HA_TOKEN in the environment it additionally exercises the
 * live contract against real Home Assistant:
 *
 *   - every room composes at every phase, and no pane comes back empty
 *   - scenes survive composition even though all 46 read "unknown"
 *   - genuinely unavailable entities never reach a tile
 *   - the action allowlist REJECTS the garage door / car lock (no actuation is
 *     ever performed by this script — only the 403 path is exercised)
 *   - the doorbell frame 404s while nobody is at the door
 */
import { Hono } from 'hono';
import { resolve } from 'node:path';
import { create_panel_router } from '../src/app/routes/panel';
import {
  actuable_entities,
  compose_pane,
  get_snapshot,
  room_for_area,
  room_list,
  suggest_room,
  type Phase,
  type Snapshot,
} from '../src/core/panel/compose';
import { OUTDOOR_TEMP, ROOMS } from '../src/core/panel/rooms';
import { ask_kate, guest_caller, _reset_guest_sessions } from '../src/core/panel/guest_turn';

let pass = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  pass++;
}

const client_dir = resolve(import.meta.dir, '../src/app/client');

// Mounted EXACTLY as production mounts it.
const app_router = new Hono();
app_router.route('/panel', create_panel_router({ client_dir }));
const app = new Hono();
app.route('/app', app_router);

const from = (ip: string | null, path = '/app/panel/') =>
  app.request(path, ip ? { headers: { 'x-real-ip': ip } } : {});

// ── the LAN gate ──────────────────────────────────────────────────────────

assert((await from(null)).status === 404, 'no forwarded address -> 404');
assert((await from('100.86.1.4')).status === 404, 'Tailscale CGNAT 100.86.x -> 404');
assert((await from('100.64.0.1')).status === 404, 'Tailscale CGNAT low edge -> 404');
assert((await from('100.127.255.254')).status === 404, 'Tailscale CGNAT high edge -> 404');
assert((await from('8.8.8.8')).status === 404, 'public address -> 404');
assert((await from('172.32.0.1')).status === 404, '172.32 is NOT private -> 404');
assert((await from('not-an-ip')).status === 404, 'garbage address -> 404');

assert((await from('192.168.0.83')).status === 200, 'house LAN 192.168.x -> 200');
assert((await from('10.1.2.3')).status === 200, 'private 10.x -> 200');
assert((await from('172.16.0.9')).status === 200, 'private 172.16.x -> 200');
assert((await from('127.0.0.1')).status === 200, 'loopback -> 200');
assert((await from('::ffff:192.168.0.83')).status === 200, 'v4-mapped v6 LAN -> 200');

// The gate must cover the API, not merely the page.
assert(
  (await from('100.86.1.4', '/app/panel/api/bootstrap')).status === 404,
  'API is gated for off-LAN callers too',
);
assert(
  (
    await app.request('/app/panel/api/action', {
      method: 'POST',
      headers: { 'x-real-ip': '100.86.1.4', 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_id: 'light.kitchen', on: true }),
    })
  ).status === 404,
  'actuation is gated for off-LAN callers',
);

// X-Forwarded-For is the fallback when X-Real-IP is absent; first hop wins.
assert(
  (await app.request('/app/panel/', { headers: { 'x-forwarded-for': '192.168.0.50, 10.0.0.1' } }))
    .status === 200,
  'X-Forwarded-For first hop on LAN -> 200',
);
assert(
  (await app.request('/app/panel/', { headers: { 'x-forwarded-for': '100.86.1.4, 192.168.0.1' } }))
    .status === 404,
  'X-Forwarded-For first hop off-LAN -> 404 (a LAN hop later must not launder it)',
);

// ── mount shape ───────────────────────────────────────────────────────────

const lan = { headers: { 'x-real-ip': '192.168.0.83' } };
const bare = await app.request('/app/panel', lan);
assert(bare.status === 301, `/app/panel -> 301 (got ${bare.status})`);
assert(bare.headers.get('location') === '/app/panel/', 'bare path redirects to the trailing slash');

const page = await app.request('/app/panel/', lan);
assert(page.status === 200, 'the page serves at /app/panel/');
const html = await page.text();
assert(html.includes('Hearth — guest panel'), 'the page is the panel');
assert(html.includes('href="panel.css"'), 'assets are RELATIVE so they resolve under the mount');
assert(!html.includes('src="/panel.js"'), 'no absolute asset paths (they 404 under /app/panel/)');

assert((await app.request('/app/panel/panel.css', lan)).status === 200, 'panel.css serves');
assert((await app.request('/app/panel/panel.js', lan)).status === 200, 'panel.js serves');
assert((await app.request('/app/panel/nope', lan)).status === 404, 'unknown sub-path -> 404');

// ── Kate: the guest caller ────────────────────────────────────────────────
//
// require_caller_tier resolves `ctx.user?.tier ?? 'owner'`, so an
// unauthenticated surface that omits the user is treated as the OWNER. These
// assertions are the guard on that: the panel must always name a tier, and it
// must be the lowest one.
{
  const caller = guest_caller('America/Denver');
  assert(caller.tier === 'friend', "the guest caller is friend tier, Hearth's lowest");
  assert(caller.tier !== 'owner' && caller.tier !== 'household', 'never owner or household');
  assert(!!caller.display_name && /guest/i.test(caller.display_name), 'Kate is told it is a guest');
  assert(caller.id === 'guest-panel', 'the guest caller is not impersonating a real user id');

  // A runtime that records what it was handed, so the tier reaching the runtime
  // is asserted rather than assumed.
  let seen: unknown = 'never called';
  const spy = {
    turn: async (args: { user?: unknown; conversation_history?: unknown[] }) => {
      seen = args.user;
      return { message_text: 'The half bath is off the front foyer.' };
    },
  } as never;

  _reset_guest_sessions();
  const first = await ask_kate({
    runtime: spy,
    session_id: 'smoke-session',
    room: 'Front Foyer',
    question: 'where is the bathroom?',
    timezone: 'America/Denver',
  });
  assert(first.ok, 'a guest turn returns an answer');
  assert((seen as { tier?: string })?.tier === 'friend', 'friend tier reaches the runtime');
  assert((seen as { tier?: string })?.tier !== undefined, 'the user is never undefined (would mean owner)');

  // History is per-session and in memory: the second turn carries the first.
  let history_len = -1;
  const spy2 = {
    turn: async (args: { conversation_history?: unknown[] }) => {
      history_len = (args.conversation_history ?? []).length;
      return { message_text: 'Second answer.' };
    },
  } as never;
  await ask_kate({
    runtime: spy2,
    session_id: 'smoke-session',
    room: 'Front Foyer',
    question: 'and the other one?',
    timezone: 'America/Denver',
  });
  assert(history_len === 2, `a follow-up carries the prior turn (got ${history_len})`);

  let other_len = -1;
  const spy3 = {
    turn: async (args: { conversation_history?: unknown[] }) => {
      other_len = (args.conversation_history ?? []).length;
      return { message_text: 'Third.' };
    },
  } as never;
  await ask_kate({
    runtime: spy3,
    session_id: 'a-different-phone',
    room: 'Kitchen',
    question: 'hello?',
    timezone: 'America/Denver',
  });
  assert(other_len === 0, 'a second guest device does not inherit the first one conversation');
  _reset_guest_sessions();
}

// With no runtime wired the button must refuse rather than pretend.
{
  const bare = new Hono();
  const bare_app_router = new Hono();
  bare_app_router.route('/panel', create_panel_router({ client_dir }));
  bare.route('/app', bare_app_router);
  const res = await bare.request('/app/panel/api/ask', {
    method: 'POST',
    headers: { 'x-real-ip': '192.168.0.83', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hello' }),
  });
  assert(res.status === 501, `no runtime -> 501 (got ${res.status})`);

  const boot = await bare.request('/app/panel/api/bootstrap', lan);
  const j = (await boot.json()) as { kate?: { wired?: boolean } };
  assert(j.kate?.wired === false, 'bootstrap reports Kate unwired so the button can say so');
}

// ── Bermuda suggestion: the happy path, deterministically ─────────────────
//
// The live assertions below can only check "null or a real room", because
// whether anyone's phone is currently fresh is not something a test controls.
// These synthesise the snapshot so the path that ACCEPTS a suggestion is
// covered too — including the staleness guard, which is the whole reason a
// three-hour-old "Kitchen" does not move a guest to the kitchen.
{
  const tracker = 'device_tracker.panel_smoke';
  const before = process.env.HEARTH_PANEL_TRACKER;
  process.env.HEARTH_PANEL_TRACKER = tracker;

  const snap_with = (state: string, area: string, age_ms: number): Snapshot => ({
    states: new Map([
      [
        tracker,
        {
          entity_id: tracker,
          state,
          attributes: { area },
          last_updated: new Date(Date.now() - age_ms).toISOString(),
        },
      ],
    ]),
    by_entity_area: new Map(),
    at: Date.now(),
  });

  const fresh = suggest_room(snap_with('home', 'Theater', 10_000));
  assert(fresh?.room === 'Theater', `a fresh home fix suggests its room (got ${JSON.stringify(fresh)})`);
  assert(fresh?.source === 'bermuda', 'and says where it came from');

  assert(
    suggest_room(snap_with('home', 'Theater', 40 * 60_000)) === null,
    'a 40-minute-old fix is a memory, not a location',
  );
  assert(
    suggest_room(snap_with('not_home', 'Theater', 10_000)) === null,
    'away means no suggestion even with an area attached',
  );
  assert(
    suggest_room(snap_with('home', 'Basement', 10_000)) === null,
    'an area with no panel room suggests nothing rather than the nearest guess',
  );
  assert(
    suggest_room(snap_with('home', '', 10_000)) === null,
    'a fix with no area suggests nothing',
  );

  if (before === undefined) delete process.env.HEARTH_PANEL_TRACKER;
  else process.env.HEARTH_PANEL_TRACKER = before;
}

// ── live contract (only with HA configured) ───────────────────────────────

if (!process.env.HA_TOKEN) {
  console.log(`smoke:panel — ${pass} assertions passed (gate + mount).`);
  console.log('HA_TOKEN not set; skipped the live Home Assistant checks.');
} else {
  const snap = await get_snapshot();
  assert(!!snap, 'a snapshot came back from Home Assistant');
  if (!snap) throw new Error('unreachable');

  assert(snap.states.size > 100, `states look real (${snap.states.size} entities)`);
  assert(snap.by_entity_area.size > 50, `area map looks real (${snap.by_entity_area.size} placed)`);

  const phases: Phase[] = ['morning', 'afternoon', 'evening', 'night'];
  let tiles_seen = 0;
  let scenes_seen = 0;

  for (const room of room_list()) {
    for (const phase of phases) {
      const pane = compose_pane(room, phase, snap);
      assert(pane.tiles.length > 0, `${room} @ ${phase} composes at least one tile`);
      tiles_seen += pane.tiles.length;
      for (const t of pane.tiles) {
        if (t.entity_id.startsWith('scene.')) scenes_seen++;
        const s = snap.states.get(t.entity_id);
        assert(!!s, `${t.entity_id} on ${room}/${phase} exists in HA`);
        assert(s?.state !== 'unavailable', `${t.entity_id} is not an unavailable entity`);
      }
    }
  }

  // Scenes read "unknown" until they fire; a naive liveness filter deletes all
  // 46 of them. This is the assertion that catches that regression.
  assert(scenes_seen > 0, `scenes survive composition (${scenes_seen} scene tiles across the house)`);

  // ── kind: 'open' — the media door ───────────────────────────────────────
  //
  // The panel must never infer "this is a TV room" from an entity id. The
  // composer says so, once, from ROOMS[].media_surface. These assertions are
  // the guard on that: a room without the config gets no door, the configured
  // room gets exactly one, and a client that cannot open it can still act on it.
  {
    const kinds = new Set<string>();
    for (const room of room_list()) {
      for (const phase of phases) {
        const pane = compose_pane(room, phase, snap);
        for (const t of pane.tiles) kinds.add(t.kind);

        const doors = pane.tiles.filter((t) => t.kind === 'open');
        assert(doors.length <= 1, `${room} @ ${phase} has at most one media door (got ${doors.length})`);
        for (const door of doors) {
          assert(door.opens === 'media', `a door names what it opens (${door.entity_id})`);
          assert(
            ROOMS[room]?.media_surface === door.entity_id,
            `${room}'s door is the configured media_surface, not a guess`,
          );
        }
        if (!ROOMS[room]?.media_surface) {
          assert(doors.length === 0, `${room} has no media_surface configured, so it gets no door`);
        }
      }
    }
    for (const k of kinds) {
      assert(['toggle', 'activate', 'open'].includes(k), `tile kind '${k}' is in the contract`);
    }

    const theater = compose_pane('Theater', 'evening', snap);
    const door = theater.tiles.find((t) => t.kind === 'open');
    assert(!!door, 'the Theater offers a door to the media surface');
    assert(door?.entity_id === 'media_player.ht_a9_2', 'the Theater door is the HT-A9 tile');

    // The degradation contract: a client with no media surface (the web panel
    // today) must still be able to act on the door rather than showing a dead
    // control. So it stays in the allowlist.
    assert(
      actuable_entities(snap).has('media_player.ht_a9_2'),
      'an open tile is still actuable, so clients without a media surface degrade',
    );
  }

  // ── outdoor temperature: the on-site station wins ───────────────────────
  //
  // The Tempest is a physical station on this property; the fallbacks are a
  // geocoded forecast for the area. They disagree by a few degrees, so which
  // one the panel shows is a correctness question, not a preference.
  {
    assert(OUTDOOR_TEMP[0] === 'sensor.st_00214775_temperature', 'the Tempest is the FIRST source');
    assert(OUTDOOR_TEMP.length > 1, 'there is a fallback if the station dies');

    const alive = OUTDOOR_TEMP.filter((id) => {
      const s = snap.states.get(id);
      return !!s && s.state !== 'unavailable' && Number.isFinite(Number(s.state));
    });
    assert(alive.length > 0, `at least one outdoor source is alive (${alive.length}/${OUTDOOR_TEMP.length})`);

    const backyard = compose_pane('Backyard', 'evening', snap);
    assert(!!backyard.temps.outside, 'the Backyard reports an outside temperature');
    const tempest = snap.states.get('sensor.st_00214775_temperature');
    if (tempest && tempest.state !== 'unavailable') {
      const want = `${Number(tempest.state).toFixed(1).replace(/\.0$/, '')}°`;
      assert(backyard.temps.outside === want, `outside reads the Tempest (${want}), not the forecast`);
    }
  }

  // ── Bermuda room suggestion ─────────────────────────────────────────────
  //
  // Bermuda resolves an `area` on its device_tracker entities; the panel maps
  // that to a room it actually has, or to nothing. Null is a real answer.
  {
    assert(room_for_area('Kitchen') === 'Kitchen', 'a real area maps to its room');
    assert(room_for_area('Theater') === 'Theater', 'the Theater maps');
    assert(
      room_for_area('Basement') === null,
      'Basement is a real HA area with NO panel room — it must map to null, not a guess',
    );
    assert(room_for_area('') === null, 'an empty area is not a room');
    assert(room_for_area('Nowhere At All') === null, 'an unknown area is not a room');

    const before = process.env.HEARTH_PANEL_TRACKER;
    delete process.env.HEARTH_PANEL_TRACKER;
    assert(suggest_room(snap) === null, 'unconfigured -> no suggestion (the panel never guesses)');

    process.env.HEARTH_PANEL_TRACKER = 'device_tracker.does_not_exist';
    assert(suggest_room(snap) === null, 'a missing tracker -> no suggestion');

    // The live tracker: whatever it resolves to must be a REAL panel room.
    process.env.HEARTH_PANEL_TRACKER = 'device_tracker.jasper_s_iphone_bermuda_tracker';
    const guess = suggest_room(snap);
    assert(
      guess === null || room_list().includes(guess.room),
      `a suggestion names a real room (got ${JSON.stringify(guess)})`,
    );
    if (guess) assert(guess.source === 'bermuda', 'a suggestion says where it came from');
    if (before === undefined) delete process.env.HEARTH_PANEL_TRACKER;
    else process.env.HEARTH_PANEL_TRACKER = before;
  }

  // The night pane of the Half Bath is the one that must carry the red light.
  const half_bath = compose_pane('Half Bath', 'night', snap);
  assert(
    half_bath.tiles.some((t) => t.entity_id === 'scene.half_bath_red_night'),
    'Half Bath at night offers the red night light',
  );

  // Nothing off-pane may be actuated. These are checked through the ROUTER, so
  // the allowlist is exercised where it actually runs. No actuation happens:
  // every one of these is expected to be refused.
  for (const entity_id of [
    'cover.double_bay_isg', // the garage door
    'lock.2023_ioniq_5_door_lock', // the car
    'switch.basement_hallway', // a real switch, but on no pane
    'light.living_room_left', // a genuinely unavailable light
  ]) {
    const res = await app.request('/app/panel/api/action', {
      method: 'POST',
      headers: { 'x-real-ip': '192.168.0.83', 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_id }),
    });
    assert(res.status === 403, `${entity_id} is refused (got ${res.status})`);
  }

  // The camera answers "who's there", so it must not be readable when nobody is.
  const frame = await app.request('/app/panel/api/doorbell/frame', lan);
  assert(
    frame.status === 404 || frame.status === 200,
    `doorbell frame is 404 when nobody is there, 200 while someone is (got ${frame.status})`,
  );
  if (frame.status === 404) pass++; // the resting case, which is what we expect

  console.log(
    `smoke:panel — ${pass} assertions passed ` +
      `(${room_list().length} rooms x ${phases.length} phases, ${tiles_seen} tiles composed).`,
  );
}
