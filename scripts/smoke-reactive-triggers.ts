/**
 * smoke:reactive-triggers — the event-driven specialist-waking layer.
 *
 * Self-contained (no DB, no LLM, no network). Three layers:
 *
 *   1. The `home_arrival` TriggerDef edge detector (pure): arrival ⇒ edge,
 *      repeat-arrival ⇒ none (level not edge), departure ⇒ re-arm, non-home /
 *      no-packet ⇒ none. Section [1c] drives the REAL iOS wire shape.
 *   2. ReactiveTriggerDriver fan-out over a real AppEventBus: a matching
 *      location packet wakes EVERY subscribing specialist once (edge-dedup
 *      across repeats), passes through per-sub debounce/min-interval, honors the
 *      HEARTH_REACTIVE_TRIGGERS kill switch, and is fail-open against a throwing
 *      def.
 *   3. LoopDriver.wake_deliberation_scoped: debounce coalesces a burst, the
 *      per-key min-interval suppresses a too-soon re-fire, and the woken pass
 *      runs at slot `trigger:<key>` carrying the TriggerContext.
 */
import { AppEventBus, type AppEvent } from '@app/events';
import type { MemoryClient } from '@memory/client';
import type { SpecialistRegistry } from '@core/specialist';
import {
  ReactiveTriggerDriver,
  home_arrival_trigger,
  home_departure_trigger,
  type TriggerDef,
  type ScopedWaker,
} from '@core/reactive_triggers';
import { LoopDriver, type LoopDriverDeps } from '@core/loops';
import type { LoadedSpecialist } from '@core/specialist';
import type { DirectedTask, TriggerContext } from '@core/deliberation';

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Fakes ────────────────────────────────────────────────────────────────────

/** Jasper's real home anchor shape (config/users.yaml `home_location`). The
 *  resolver every test passes as `trigger_deps.home_anchor`. */
const HOME = { lat: 39.7411, lng: -104.9880 };
const home_anchor = (_user_id: string) => HOME;

/** ~80m north of the anchor — inside the 180m home radius. Whole live
 *  visit_arrival packets land within a few tens of metres of the anchor. */
const NEAR_HOME = { lat: 39.7418, lng: -104.9880 };
/** ~4.8km away (Old Town Pleasantville) — comfortably outside the radius. */
const AWAY = { lat: 39.7392, lng: -104.9903 };

/** A location packet the fake memory will return for the NEXT query.
 *
 *  `set_packet` takes the payload FIELDS, not a canned shape, so a test can
 *  post the exact bytes iOS sends. `place_id` is deliberately OMITTED unless a
 *  test passes one: the whole 2026-07-26 bug was that every fixture here set
 *  `place_id` while no real payload ever carries it. */
function make_memory(): {
  client: MemoryClient;
  set_packet: (payload: Record<string, unknown>) => void;
  clear: () => void;
} {
  let packet: unknown = null;
  return {
    client: {
      query_latest_location_packet: (_user_id: string) => packet,
    } as unknown as MemoryClient,
    set_packet: (payload) => {
      packet = {
        user_id: 'jasper',
        captured_at: '2026-06-18T12:00:00Z',
        received_at: '2026-06-18T12:00:00Z',
        payload: { ts: '2026-06-18T12:00:00Z', ...payload },
      };
    },
    clear: () => {
      packet = null;
    },
  };
}

/** A packet at/near the home anchor. `place_id` omitted — the live shape. */
const at_home_pkt = (kind: string) => ({ kind, ...NEAR_HOME });
/** A packet far from the home anchor. */
const away_pkt = (kind: string) => ({ kind, ...AWAY });

/** Minimal SpecialistRegistry exposing only `list()`. */
function make_registry(specialists: Array<{ id: string; triggers: unknown[] }>): SpecialistRegistry {
  const list = specialists.map((s) => ({ id: s.id, proactive: { triggers: s.triggers } }));
  return { list: () => list } as unknown as SpecialistRegistry;
}

function make_spy_waker(): { waker: ScopedWaker; calls: Array<{ id: string; opts: any }> } {
  const calls: Array<{ id: string; opts: any }> = [];
  return {
    waker: { wake_deliberation_scoped: (id, opts) => calls.push({ id, opts }) },
    calls,
  };
}

function location_event(): Extract<AppEvent, { type: 'sensor_packet_received' }> {
  return {
    type: 'sensor_packet_received',
    user_id: 'jasper',
    signal: 'location',
    captured_at: '2026-06-18T12:00:00Z',
    packet_id: 'pkt_1',
  };
}

// ── Layer 1: the home_arrival edge detector ──────────────────────────────────

function test_edge_detector(): void {
  console.log('\n[1] home_arrival edge detector');
  const mem = make_memory();
  const state = new Map<string, unknown>();
  const ev = location_event();
  const detect = () => home_arrival_trigger.detect(ev, { memory: mem.client, home_anchor }, state);

  mem.set_packet({ ...at_home_pkt('region_enter'), place_id: 'home' });
  const first = detect();
  assert(first?.dedupe_key === 'home_arrival:jasper', 'arrival at home ⇒ edge with per-user dedupe_key');
  assert(/arrived home/i.test(first?.reason ?? ''), 'edge reason names the arrival');

  // Still home — a second arrival packet is a LEVEL, not an edge.
  assert(detect() === null, 'repeat arrival ⇒ no edge (level, not edge)');

  // Departure re-arms; leaving never wakes anyone.
  mem.set_packet({ ...at_home_pkt('region_exit'), place_id: 'home' });
  assert(detect() === null, 'departure ⇒ no wake (re-arms the edge)');

  // Arriving again after a departure is a fresh edge.
  mem.set_packet({ ...at_home_pkt('visit_arrival'), place_id: 'home' });
  assert(detect()?.dedupe_key === 'home_arrival:jasper', 'arrival after departure ⇒ fresh edge');

  // Arriving somewhere that ISN'T home never fires the arrival def.
  mem.set_packet({ ...away_pkt('region_enter'), place_id: 'gym' });
  assert(detect() === null, 'arrival at a non-home place ⇒ no arrival edge');
  mem.clear();
  assert(detect() === null, 'no location packet ⇒ no edge');

  // A raw transit fix is NOT an edge — 3,825 of the 4,723 live location
  // packets are significant_change, and treating them as transitions would
  // fire every time the phone wandered across the radius in the driveway.
  const s2 = new Map<string, unknown>();
  const detect2 = () => home_arrival_trigger.detect(ev, { memory: mem.client, home_anchor }, s2);
  mem.set_packet(at_home_pkt('significant_change'));
  assert(detect2() === null, 'significant_change AT home ⇒ no edge (transit fix, not an edge)');
}

// ── Layer 1c: THE REGRESSION — the real iOS wire shape ───────────────────────
//
// This is the test whose absence let the bug ship. Every fixture above sets
// `place_id`; NO live iOS payload does. Verified 2026-07-26 against
// /data/vault/Users/jasper/sensors/location: 280 visit_arrival + 248
// visit_departure packets, and `grep -rl place_id` over the whole tree matches
// exactly 3 files (all region_enter, all 2026-06-19). A real visit payload is
// EXACTLY the object below — no place_id key at all. The old detector gated on
// `HOME_PLACE_IDS.has((place_id ?? '').toLowerCase())`, so 528 real arrivals and
// departures produced ZERO wakes over two months.

function test_live_payload_shape(): void {
  console.log('\n[1c] REGRESSION — the real iOS payload (no place_id, coords only)');

  // Byte-for-byte the shape of a live visit_arrival packet, coords swapped to
  // the home anchor. Note: no `place_id` key.
  const live_arrival = {
    kind: 'visit_arrival',
    lat: 39.7411,
    lng: -104.9880,
    horizontal_accuracy_m: 65,
    motion: 'automotive',
    ts: '2026-07-26T18:04:11Z',
  };
  const live_departure = { ...live_arrival, kind: 'visit_departure', ts: '2026-07-26T21:30:02Z' };

  const mem = make_memory();
  const ev = location_event();
  const arr_state = new Map<string, unknown>();
  const dep_state = new Map<string, unknown>();
  const deps = { memory: mem.client, home_anchor };
  const arrival = () => home_arrival_trigger.detect(ev, deps, arr_state);
  const departure = () => home_departure_trigger.detect(ev, deps, dep_state);

  mem.set_packet(live_arrival);
  assert(!('place_id' in live_arrival), 'the fixture carries NO place_id — the live wire shape');
  const fired = arrival();
  assert(fired?.dedupe_key === 'home_arrival:jasper', 'a live visit_arrival at home coords FIRES home_arrival');
  assert(/arrived home/i.test(fired?.reason ?? ''), 'the reason reads as an arrival home');
  assert(/from home/.test(fired?.reason ?? ''), 'the reason shows the resolved distance (proximity path)');

  mem.set_packet(live_departure);
  assert(departure()?.dedupe_key === 'home_departure:jasper', 'a live visit_departure at home coords FIRES home_departure');

  // A visit at a DIFFERENT place must not read as home just because it has no
  // place_id — the proximity test is what distinguishes them now.
  const arr2 = new Map<string, unknown>();
  mem.set_packet({ kind: 'visit_arrival', ...AWAY, horizontal_accuracy_m: 65, ts: '2026-07-26T19:00:00Z' });
  assert(
    home_arrival_trigger.detect(ev, deps, arr2) === null,
    'a live visit_arrival 4.8km away does NOT fire home_arrival',
  );

  // Robustness: iOS drops a visit_departure often enough that the state machine
  // must not strand at 'home'. An arrival ELSEWHERE means the house is empty.
  const dep2 = new Map<string, unknown>();
  const detect_dep2 = () => home_departure_trigger.detect(ev, deps, dep2);
  mem.set_packet(live_arrival);
  assert(detect_dep2() === null, 'arriving home leaves the departure def quiet');
  mem.set_packet({ kind: 'visit_arrival', ...AWAY, ts: '2026-07-26T19:00:00Z' });
  const away_fire = detect_dep2();
  assert(away_fire?.dedupe_key === 'home_departure:jasper', 'a missed departure is recovered: arriving elsewhere fires home_departure');
  assert(
    /arrived somewhere else/i.test(away_fire?.reason ?? '') && !/just left home/i.test(away_fire?.reason ?? ''),
    'that reason says "arrived somewhere else", never fabricating "just left home"',
  );

  // No anchor ⇒ the defs degrade to the place_id path rather than guessing.
  const no_anchor = { memory: mem.client, home_anchor: () => null };
  const arr3 = new Map<string, unknown>();
  mem.set_packet(live_arrival);
  assert(
    home_arrival_trigger.detect(ev, no_anchor, arr3) === null,
    'no configured home anchor ⇒ no proximity edge (degrades, never guesses)',
  );
  // …and critically it must not fire the OPPOSITE def either. Without an anchor
  // `near` is false because we're blind, not because he's elsewhere — inferring
  // 'away' there would fire a spurious home_departure on every single arrival.
  const dep3 = new Map<string, unknown>();
  assert(
    home_departure_trigger.detect(ev, no_anchor, dep3) === null,
    'no anchor ⇒ an arrival does NOT spuriously fire home_departure',
  );
  mem.set_packet({ ...live_arrival, place_id: 'home' });
  const arr4 = new Map<string, unknown>();
  assert(
    home_arrival_trigger.detect(ev, no_anchor, arr4)?.dedupe_key === 'home_arrival:jasper',
    'no anchor but an explicit place_id=home ⇒ the geofence path still fires',
  );
}

// ── Layer 1b: the home_departure edge detector (symmetric partner) ───────────

function test_departure_detector(): void {
  console.log('\n[1b] home_departure edge detector');
  const mem = make_memory();
  const state = new Map<string, unknown>();
  const ev = location_event();
  const detect = () => home_departure_trigger.detect(ev, { memory: mem.client, home_anchor }, state);

  // Fresh state: a departure-at-home is the home→away edge.
  mem.set_packet({ ...at_home_pkt('region_exit'), place_id: 'home' });
  const first = detect();
  assert(first?.dedupe_key === 'home_departure:jasper', 'departure at home ⇒ edge with per-user dedupe_key');
  assert(/left home/i.test(first?.reason ?? ''), 'edge reason names the departure');

  // Still away — a repeat departure is a level, not an edge.
  assert(detect() === null, 'repeat departure ⇒ no edge (level)');

  // Arriving home re-arms (departure def does NOT fire on arrival).
  mem.set_packet({ ...at_home_pkt('region_enter'), place_id: 'home' });
  assert(detect() === null, 'arrival ⇒ departure def stays quiet (re-arms)');

  // Leaving again after arriving is a fresh departure edge.
  mem.set_packet({ ...at_home_pkt('visit_departure'), place_id: 'home' });
  assert(detect()?.dedupe_key === 'home_departure:jasper', 'departure after arrival ⇒ fresh edge');

  // A departure from somewhere that ISN'T home is in-transit, not a home
  // departure — it must not re-fire the "house is empty" pass.
  const s2 = new Map<string, unknown>();
  const detect2 = () => home_departure_trigger.detect(ev, { memory: mem.client, home_anchor }, s2);
  mem.set_packet(at_home_pkt('visit_arrival'));
  assert(detect2() === null, 'arrival home ⇒ departure def quiet');
  mem.set_packet(away_pkt('visit_departure'));
  assert(detect2() === null, 'leaving the GYM ⇒ no home_departure edge');
}

// ── Layer 2: ReactiveTriggerDriver fan-out ───────────────────────────────────

async function test_driver_fanout(): Promise<void> {
  console.log('\n[2] ReactiveTriggerDriver fan-out');
  delete process.env.HEARTH_REACTIVE_TRIGGERS; // ensure enabled

  const mem = make_memory();
  const bus = new AppEventBus();
  const { waker, calls } = make_spy_waker();
  // luna + kate subscribe to home_arrival (luna carries per-sub overrides);
  // vivian subscribes to a different def and must NOT fire.
  const registry = make_registry([
    { id: 'luna', triggers: [{ def: 'home_arrival', task: 'check the house', debounce_ms: 7, min_interval_ms: 11 }] },
    { id: 'kate', triggers: [{ def: 'home_arrival', task: 'anything to surface' }] },
    { id: 'vivian', triggers: [{ def: 'some_other_def', task: 'irrelevant' }] },
  ]);
  const driver = new ReactiveTriggerDriver({
    specialists: registry,
    waker,
    trigger_deps: { memory: mem.client, home_anchor },
  });
  const unsub = driver.attach(bus);

  mem.set_packet({ ...at_home_pkt('region_enter'), place_id: 'home' });
  bus.emit(location_event());
  assert(calls.length === 2, `one matching arrival wakes both subscribers, not the unrelated one (got ${calls.length})`);
  const ids = calls.map((c) => c.id).sort();
  assert(ids[0] === 'kate' && ids[1] === 'luna', 'the two woken specialists are luna + kate');
  const luna_call = calls.find((c) => c.id === 'luna');
  assert(luna_call?.opts.task === 'check the house', 'each wake carries that specialist‑s own scoped task');
  assert(luna_call?.opts.dedupe_key === 'home_arrival:jasper', 'wake dedupe_key is the world edge key');
  assert(luna_call?.opts.debounce_ms === 7 && luna_call?.opts.min_interval_ms === 11, 'per-sub debounce/min_interval are passed through');

  // Still home — a second location packet does not re-fire (edge-dedup).
  calls.length = 0;
  bus.emit(location_event());
  assert(calls.length === 0, 'a repeat home packet (still home) wakes no one');

  // Leave, then arrive again — the edge re-arms and fires once more per sub.
  mem.set_packet({ ...at_home_pkt('region_exit'), place_id: 'home' });
  bus.emit(location_event());
  assert(calls.length === 0, 'a departure wakes no one');
  mem.set_packet({ ...at_home_pkt('visit_arrival'), place_id: 'home' });
  bus.emit(location_event());
  assert(calls.length === 2, 'arriving again after leaving re-fires both subscribers');
  unsub();

  // Kill switch: a fresh driver with HEARTH_REACTIVE_TRIGGERS=0 never wakes.
  process.env.HEARTH_REACTIVE_TRIGGERS = '0';
  const { waker: w2, calls: c2 } = make_spy_waker();
  const bus2 = new AppEventBus();
  const killed = new ReactiveTriggerDriver({ specialists: registry, waker: w2, trigger_deps: { memory: mem.client, home_anchor } });
  killed.attach(bus2);
  mem.set_packet({ ...at_home_pkt('region_enter'), place_id: 'home' });
  bus2.emit(location_event());
  assert(c2.length === 0, 'HEARTH_REACTIVE_TRIGGERS=0 ⇒ attach is a no-op, zero wakes');
  delete process.env.HEARTH_REACTIVE_TRIGGERS;

  // Fail-open: a def whose detect() throws is logged and skipped — the bus emit
  // does not throw, and a healthy def alongside still fires.
  const exploding: TriggerDef = {
    name: 'boom',
    event_types: ['sensor_packet_received'],
    detect: () => {
      throw new Error('boom');
    },
  };
  const { waker: w3, calls: c3 } = make_spy_waker();
  const bus3 = new AppEventBus();
  const reg3 = make_registry([
    { id: 'luna', triggers: [{ def: 'home_arrival', task: 'check the house' }] },
    { id: 'kate', triggers: [{ def: 'boom', task: 'x' }] },
  ]);
  const driver3 = new ReactiveTriggerDriver({
    specialists: reg3,
    waker: w3,
    trigger_deps: { memory: mem.client, home_anchor },
    defs: [home_arrival_trigger, exploding],
  });
  driver3.attach(bus3);
  mem.set_packet({ ...at_home_pkt('region_enter'), place_id: 'home' });
  let threw = false;
  try {
    bus3.emit(location_event());
  } catch {
    threw = true;
  }
  assert(!threw, 'a throwing def does not propagate to the event bus (fail-open)');
  assert(c3.length === 1 && c3[0]!.id === 'luna', 'the healthy def still fires while the throwing one is skipped');
}

// ── Layer 3: LoopDriver.wake_deliberation_scoped debounce + min-interval ──────

class SpyLoopDriver extends LoopDriver {
  fires: Array<{ id: string; slot: string; ctx?: TriggerContext }> = [];
  override async deliberate(
    specialist: LoadedSpecialist,
    slot: string,
    _user_id?: string,
    _directed?: DirectedTask,
    trigger_context?: TriggerContext,
  ): Promise<void> {
    this.fires.push({ id: specialist.id, slot, ...(trigger_context ? { ctx: trigger_context } : {}) });
  }
}

async function test_wake_scoped(): Promise<void> {
  console.log('\n[3] LoopDriver.wake_deliberation_scoped');
  const audits: Array<{ tool_name: string; agent: string; tool_input: any }> = [];
  const deps = {
    specialists: { get: (_id: string) => ({ id: 'luna' }) },
    memory: { log_action: (rec: any) => { audits.push(rec); return 'aud_x'; } },
  } as unknown as LoopDriverDeps;
  const driver = new SpyLoopDriver(deps);

  // Debounce: two rapid calls on the same key collapse to ONE fire.
  driver.wake_deliberation_scoped('luna', { task: 'check the house', reason: 'Jasper just arrived home.', dedupe_key: 'home_arrival:jasper', debounce_ms: 15 });
  driver.wake_deliberation_scoped('luna', { task: 'check the house', reason: 'Jasper just arrived home.', dedupe_key: 'home_arrival:jasper', debounce_ms: 15 });
  await sleep(40);
  assert(driver.fires.length === 1, `burst of 2 same-key wakes coalesces to 1 deliberation (got ${driver.fires.length})`);
  assert(driver.fires[0]!.slot === 'trigger:home_arrival:jasper', 'woken pass runs at slot trigger:<dedupe_key>');
  assert(driver.fires[0]!.ctx?.task === 'check the house' && /arrived home/i.test(driver.fires[0]!.ctx?.reason ?? ''), 'the TriggerContext (task + reason) reaches the pass');
  const trig_audits = audits.filter((a) => a.tool_name === 'reactive_trigger_fired');
  assert(trig_audits.length === 1 && trig_audits[0]!.tool_input.dedupe_key === 'home_arrival:jasper', 'a fire records a reactive_trigger_fired audit row (self-evidencing)');

  // Min-interval: a re-fire of the same key inside the window is dropped.
  driver.wake_deliberation_scoped('luna', { task: 'check the house', reason: 'again', dedupe_key: 'home_arrival:jasper', debounce_ms: 5, min_interval_ms: 100_000 });
  await sleep(30);
  assert(driver.fires.length === 1, 'a same-key re-fire inside min_interval is suppressed');

  // A DIFFERENT key is independent — it fires on its own schedule.
  driver.wake_deliberation_scoped('luna', { task: 'other', reason: 'r', dedupe_key: 'home_arrival:sam', debounce_ms: 5 });
  await sleep(30);
  assert(driver.fires.length === 2, 'a different dedupe_key fires independently');

  driver.stop();
}

async function main(): Promise<void> {
  console.log('=== smoke:reactive-triggers ===');
  test_edge_detector();
  test_departure_detector();
  test_live_payload_shape();
  await test_driver_fanout();
  await test_wake_scoped();
  console.log('');
  if (failures > 0) {
    console.error(`✗ ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('✓ all reactive-trigger checks passed');
  process.exit(0);
}

void main();
