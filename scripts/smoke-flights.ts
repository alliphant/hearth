/**
 * smoke:flights — self-contained proof of the flight-tracking spine.
 *
 * No live AeroDataBox, no orchestrator: a throwaway fixture server stands in
 * for the API (AERODATABOX_BASE_URL seam), an in-memory SQLite holds the
 * watch-list. Exercises: time/status/number normalization, the parse +
 * candidates-recovery matrix, fetch against the fixture, the adaptive cadence +
 * is_due windows, the diff→event classifier, the store round-trip, the four
 * tools through a fake ToolContext, and a full driver tick (poll → diff →
 * snapshot → retire).
 */
import { Database } from 'bun:sqlite';
import {
  normalize_flight_no,
  to_iso_utc,
  phase_of,
  parse_flight_status,
  fetch_flight_status,
  cadence_ms,
  is_due,
  diff_events,
  snapshot_columns,
  create as create_flight_tools,
  type FlightSnapshot,
} from '../src/connectors/flights';
import { TrackedFlightsStore, type TrackedFlight, type TrackedFlightSnapshot } from '../src/memory/stores/flights';
import { FlightTrackingDriver } from '../src/core/flight_tracking';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}
function section(s: string): void {
  console.log(`\n${s}`);
}

// ── Fixture server (mutable payload so we can flip status between polls) ─────
const base = new Date('2026-06-24T20:00:00.000Z');
function adb_flight(over: Record<string, unknown> = {}): unknown {
  return {
    number: 'UA 2245',
    status: 'Departed',
    airline: { name: 'United' },
    aircraft: { model: 'Boeing 737' },
    departure: {
      airport: { iata: 'LAX', name: 'Los Angeles' },
      scheduledTime: { utc: '2026-06-24 19:30Z' },
      revisedTime: { utc: '2026-06-24 19:45Z' },
      terminal: '7',
      gate: '71B',
    },
    arrival: {
      airport: { iata: 'DEN', name: 'Denver' },
      scheduledTime: { utc: '2026-06-24 20:25Z' },
      revisedTime: { utc: '2026-06-24 20:25Z' },
      terminal: 'B',
      gate: 'B40',
      baggageBelt: null,
    },
    ...over,
  };
}
let payload: unknown[] | 'empty' = [adb_flight()];
let force_status = 200; // flip to 429 to simulate the BASIC per-second rate limit
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.includes('/flights/number/')) {
      if (force_status === 429) {
        return new Response(JSON.stringify({ message: 'rate limit exceeded' }), { status: 429, headers: { 'content-type': 'application/json' } });
      }
      const no = path.split('/').slice(-2)[0];
      if (no === 'ZZ9999') return new Response('[]', { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify(payload === 'empty' ? [] : payload), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  },
});
process.env.AERODATABOX_BASE_URL = `http://localhost:${server.port}`;
process.env.AERODATABOX_API_KEY = 'test-key';

function empty_prev(over: Partial<TrackedFlightSnapshot> = {}): TrackedFlightSnapshot {
  return {
    status: null,
    phase: 'unknown',
    dep_iata: null,
    arr_iata: null,
    dep_terminal: null,
    dep_gate: null,
    arr_terminal: null,
    arr_gate: null,
    baggage_belt: null,
    sched_dep_utc: null,
    sched_arr_utc: null,
    est_dep_utc: null,
    est_arr_utc: null,
    ...over,
  };
}

async function main(): Promise<void> {
  // ── A. pure normalization ────────────────────────────────────────────────
  section('A. normalization');
  check('normalize_flight_no spaces/case', normalize_flight_no('ua 2245') === 'UA2245');
  check('normalize_flight_no hyphen', normalize_flight_no('BA-117') === 'BA117');
  check('to_iso_utc canonicalizes space→T', to_iso_utc({ utc: '2026-06-24 21:00Z' }) === '2026-06-24T21:00:00.000Z');
  check('to_iso_utc null on empty', to_iso_utc({ utc: null }) === null && to_iso_utc(null) === null);
  check('phase_of Departed=active', phase_of('Departed') === 'active');
  check('phase_of Arrived=landed', phase_of('Arrived') === 'landed');
  check('phase_of Canceled=canceled', phase_of('Canceled') === 'canceled');
  check('phase_of Diverted=diverted', phase_of('Diverted') === 'diverted');
  check('phase_of Expected=scheduled', phase_of('Expected') === 'scheduled');
  check('phase_of undefined=unknown', phase_of(undefined) === 'unknown');

  // ── B. parse matrix ──────────────────────────────────────────────────────
  section('B. parse + candidates recovery');
  const parsed = parse_flight_status(JSON.stringify([adb_flight()]), 'UA2245', '2026-06-24');
  check('parse found', parsed.found && parsed.flights.length === 1);
  check('parse dep gate', parsed.flights[0]?.departure.gate === '71B');
  check('parse arr iata', parsed.flights[0]?.arrival.airport_iata === 'DEN');
  check('parse est arr (revised)', parsed.flights[0]?.arrival.revised_utc === '2026-06-24T20:25:00.000Z');
  const empty = parse_flight_status('[]', 'UA2245', '2026-06-24');
  check('parse empty → not found + candidates', !empty.found && (empty.candidates?.length ?? 0) >= 2);
  const msg = parse_flight_status('{"message":"no data for the request"}', 'UA2245', '2026-06-24');
  check('parse {message} → error + candidates', !msg.found && msg.error === 'no data for the request' && !!msg.candidates);
  const bad = parse_flight_status('not json', 'UA2245', '2026-06-24');
  check('parse non-json → unparseable + candidates', !bad.found && !!bad.error && !!bad.candidates);

  // ── C. fetch against fixture ─────────────────────────────────────────────
  section('C. fetch_flight_status');
  const f1 = await fetch_flight_status('ua 2245', '2026-06-24');
  check('fetch found + normalized no', f1.found && f1.flights[0]?.flight_no === 'UA2245');
  const f2 = await fetch_flight_status('ZZ9999', '2026-06-24');
  check('fetch unknown → not found + candidates', !f2.found && (f2.candidates?.length ?? 0) >= 2);

  // ── D. adaptive cadence + is_due ─────────────────────────────────────────
  section('D. cadence + is_due');
  const far = cadence_ms({ phase: 'scheduled', sched_dep_utc: new Date(base.getTime() + 5 * 3600_000).toISOString(), sched_arr_utc: null, est_dep_utc: null, est_arr_utc: null }, base);
  check('far before departure → 30m', far === 30 * 60_000);
  const near_dep = cadence_ms({ phase: 'scheduled', sched_dep_utc: new Date(base.getTime() + 60 * 60_000).toISOString(), sched_arr_utc: null, est_dep_utc: null, est_arr_utc: null }, base);
  check('within 2h of departure → 2m', near_dep === 2 * 60_000);
  const arr_window = cadence_ms({ phase: 'active', sched_dep_utc: null, sched_arr_utc: new Date(base.getTime() + 20 * 60_000).toISOString(), est_dep_utc: null, est_arr_utc: null }, base);
  check('active + arrival within 30m → 1m', arr_window === 60_000);
  const cruising = cadence_ms({ phase: 'active', sched_dep_utc: null, sched_arr_utc: new Date(base.getTime() + 3 * 3600_000).toISOString(), est_dep_utc: null, est_arr_utc: null }, base);
  check('active cruising → 5m', cruising === 5 * 60_000);
  const landed = cadence_ms({ phase: 'landed', sched_dep_utc: null, sched_arr_utc: null, est_dep_utc: null, est_arr_utc: null }, base);
  check('landed → 1m', landed === 60_000);
  const never_polled = { last_polled_at: null, phase: 'scheduled', sched_dep_utc: null, sched_arr_utc: null, est_dep_utc: null, est_arr_utc: null } as unknown as TrackedFlight;
  check('is_due never polled', is_due(never_polled, base));
  const just_polled = { last_polled_at: base.toISOString(), phase: 'scheduled', sched_dep_utc: new Date(base.getTime() + 5 * 3600_000).toISOString(), sched_arr_utc: null, est_dep_utc: null, est_arr_utc: null } as unknown as TrackedFlight;
  check('is_due just polled (far) = false', !is_due(just_polled, base));
  check('is_due 31m later (far) = true', is_due(just_polled, new Date(base.getTime() + 31 * 60_000)));

  // ── E. diff → event classifier ───────────────────────────────────────────
  section('E. diff_events');
  const scheduled_snap: FlightSnapshot = { ...parsed.flights[0]!, status: 'Expected', phase: 'scheduled' };
  check('seed (unknown→scheduled) → no events', diff_events(empty_prev(), scheduled_snap).length === 0);
  const dep_ev = diff_events(empty_prev({ phase: 'scheduled' }), { ...parsed.flights[0]!, status: 'Departed', phase: 'active' });
  check('scheduled→active → departed', dep_ev.some((e) => e.kind === 'departed'));
  const land_ev = diff_events(empty_prev({ phase: 'active' }), { ...parsed.flights[0]!, status: 'Arrived', phase: 'landed' });
  check('active→landed → landed', land_ev.some((e) => e.kind === 'landed'));
  const gate_ev = diff_events(empty_prev({ phase: 'active', dep_gate: '71A' }), { ...parsed.flights[0]!, phase: 'active' });
  check('gate change → gate_change', gate_ev.some((e) => e.kind === 'gate_change'));
  const bag_prev = empty_prev({ phase: 'active', baggage_belt: null });
  const bag_next: FlightSnapshot = { ...parsed.flights[0]!, phase: 'landed', arrival: { ...parsed.flights[0]!.arrival, baggage_belt: '12' } };
  check('belt assigned → baggage', diff_events(bag_prev, bag_next).some((e) => e.kind === 'baggage'));
  const delay_prev = empty_prev({ phase: 'active', est_arr_utc: '2026-06-24T20:25:00.000Z' });
  const delay_next: FlightSnapshot = { ...parsed.flights[0]!, phase: 'active', arrival: { ...parsed.flights[0]!.arrival, revised_utc: '2026-06-24T20:55:00.000Z' } };
  check('ETA +30m → delayed', diff_events(delay_prev, delay_next).some((e) => e.kind === 'delayed'));
  const cancel_ev = diff_events(empty_prev({ phase: 'scheduled' }), { ...parsed.flights[0]!, status: 'Canceled', phase: 'canceled' });
  check('→ canceled → cancelled', cancel_ev.some((e) => e.kind === 'cancelled'));

  // ── F. store round-trip ──────────────────────────────────────────────────
  section('F. TrackedFlightsStore');
  const db = new Database(':memory:');
  const store = new TrackedFlightsStore(db);
  const u1 = store.upsert({ flight_no: 'UA2245', flight_date: '2026-06-24', user_id: 'jasper', label: 'Sam home' }, base.toISOString());
  check('upsert new', !u1.already && u1.row.id.startsWith('tf_'));
  const u2 = store.upsert({ flight_no: 'UA2245', flight_date: '2026-06-24', user_id: 'jasper' }, base.toISOString());
  check('upsert idempotent (same id)', u2.already && u2.row.id === u1.row.id);
  store.apply_snapshot(u1.row.id, snapshot_columns(parsed.flights[0]!), base.toISOString());
  check('apply_snapshot persists gate', store.get(u1.row.id)?.dep_gate === '71B');
  check('list_for_user sees it', store.list_for_user('jasper').length === 1);
  check('cordon: other user sees none', store.list_for_user('sam').length === 0);
  store.retire(u1.row.id, base.toISOString());
  check('retire removes from active', store.list_for_user('jasper').length === 0);

  // ── G. tools via a fake ToolContext ──────────────────────────────────────
  section('G. tools');
  const tdb = new Database(':memory:');
  const tools = create_flight_tools({ db: tdb } as unknown as Parameters<typeof create_flight_tools>[0]);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const ctx = {
    memory: { log_action: () => 'audit_x' },
    now: base,
    intent_id: 'test',
    specialist_id: 'kate',
    user: { id: 'jasper', tier: 'owner', timezone: 'America/Denver' },
  } as unknown as Parameters<(typeof tools)[0]['execute']>[1];
  const tracked = (await byName.track_flight!.execute({ flight_no: 'UA2245', label: 'Sam home' }, ctx)) as { tracked: boolean; found: boolean };
  check('track_flight tracks + found', tracked.tracked && tracked.found);
  const listed = (await byName.list_tracked_flights!.execute({}, ctx)) as { flights: TrackedFlight[] };
  check('list_tracked_flights returns seeded row', listed.flights.length === 1 && listed.flights[0]?.dep_gate === '71B');
  const status = (await byName.flight_status!.execute({ flight_no: 'UA2245', date: '2026-06-24' }, ctx)) as { found: boolean };
  check('flight_status found', status.found);
  const untracked = (await byName.untrack_flight!.execute({ flight_no: 'UA2245', date: '2026-06-24' }, ctx)) as { untracked: boolean };
  check('untrack_flight untracks', untracked.untracked);
  const afterList = (await byName.list_tracked_flights!.execute({}, ctx)) as { flights: TrackedFlight[] };
  check('list empty after untrack', afterList.flights.length === 0);

  // ── H. driver tick end-to-end (poll → diff → snapshot → retire) ──────────
  section('H. FlightTrackingDriver.tick');
  const ddb = new Database(':memory:');
  const dstore = new TrackedFlightsStore(ddb);
  const dtools = Object.fromEntries(create_flight_tools({ db: ddb } as unknown as Parameters<typeof create_flight_tools>[0]).map((t) => [t.name, t]));
  // Fixture starts active (Departed), arrival within 25m, no belt yet.
  payload = [adb_flight({ arrival: { airport: { iata: 'DEN', name: 'Denver' }, scheduledTime: { utc: new Date(base.getTime() + 25 * 60_000).toISOString() }, revisedTime: { utc: new Date(base.getTime() + 25 * 60_000).toISOString() }, terminal: 'B', gate: 'B40', baggageBelt: null } })];
  const dctx = { ...(ctx as object), now: base } as typeof ctx;
  await dtools.track_flight!.execute({ flight_no: 'UA2245' }, dctx);
  const seeded = dstore.list_for_user('jasper')[0]!;
  check('driver: seeded active, no belt', seeded.phase === 'active' && !seeded.baggage_belt);
  // Flight lands: status Arrived, gate moved, belt assigned.
  payload = [adb_flight({ status: 'Arrived', arrival: { airport: { iata: 'DEN', name: 'Denver' }, scheduledTime: { utc: new Date(base.getTime() + 25 * 60_000).toISOString() }, revisedTime: { utc: new Date(base.getTime() + 25 * 60_000).toISOString() }, terminal: 'B', gate: 'B47', baggageBelt: '12' } })];
  const driver = new FlightTrackingDriver({ db: ddb }, { poll_gap_ms: 0 });
  await driver.tick(new Date(base.getTime() + 2 * 60_000)); // is_due (arr<30m → 1m cadence)
  const after = dstore.get(seeded.id);
  check('driver: snapshot updated to Arrived', after?.status === 'Arrived' && after?.phase === 'landed');
  check('driver: belt captured', after?.baggage_belt === '12');
  check('driver: retired after landed+belt', !!after?.retired_at);

  // ── I. transient error (429) must NOT wipe a known snapshot ──────────────
  section('I. rate-limit / transient error preserves state');
  const idb = new Database(':memory:');
  const istore = new TrackedFlightsStore(idb);
  const itools = Object.fromEntries(create_flight_tools({ db: idb } as unknown as Parameters<typeof create_flight_tools>[0]).map((t) => [t.name, t]));
  force_status = 200;
  payload = [adb_flight({ status: 'Departed', arrival: { airport: { iata: 'DEN' }, scheduledTime: { utc: new Date(base.getTime() + 25 * 60_000).toISOString() }, revisedTime: { utc: new Date(base.getTime() + 25 * 60_000).toISOString() }, terminal: 'B', gate: 'B40', baggageBelt: null } })];
  await itools.track_flight!.execute({ flight_no: 'UA2245' }, dctx);
  const iseed = istore.list_for_user('jasper')[0]!;
  check('seeded with real status', iseed.status === 'Departed' && iseed.phase === 'active');
  force_status = 429; // provider now rate-limits
  const idriver = new FlightTrackingDriver({ db: idb }, { poll_gap_ms: 0 });
  await idriver.tick(new Date(base.getTime() + 2 * 60_000));
  const ipost = istore.get(iseed.id);
  check('429: snapshot NOT wiped (status preserved)', ipost?.status === 'Departed' && ipost?.phase === 'active');
  check('429: poll clock advanced', !!ipost?.last_polled_at && ipost!.last_polled_at !== iseed.last_polled_at);
  check('429: not retired', !ipost?.retired_at);

  server.stop(true);
  console.log(`\n${fail === 0 ? '✅' : '❌'} flights smoke: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  server.stop(true);
  process.exit(1);
});
