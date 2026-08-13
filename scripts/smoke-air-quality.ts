/**
 * Smoke for the indoor air-quality stack (connector + alert driver).
 *
 * Self-contained + device-free: no HA, no APNs, no coordinator. The connector's
 * HA state provider is the injected test seam; the driver's SOURCES (air-quality
 * snapshot + alarms) and DELIVERY (push + speak) are injected spies with a
 * controllable clock + quiet-hours flag.
 *
 * Asserts:
 *   - airthings_conditions resolves rooms → per-room readings + the worst-room
 *     digest; degrades to candidates when nothing resolves.
 *   - CO₂ is the ACUTE tier: chime (notice/medium) at ≥1500, EBS klaxon
 *     (critical/high, pierces) escalating into 2500 → 5000, re-reminding while
 *     elevated. Steady CO₂ does NOT re-fire (once per episode + relief valve).
 *   - radon / VOC / PM2.5 are gentle chimes (notice/medium), never critical.
 *   - a camera-detected CO / smoke alarm is a critical/high klaxon.
 *   - tier → severity: critical = 'high' (pierces quiet hours), notice = 'medium'.
 *   - quiet-hours SPEAK gate: a notice chime is silent overnight; critical speaks.
 *   - episode cadence: re-alert only after a full clear-gap; band math; fail-open;
 *     kill switch.
 */
import { Database } from 'bun:sqlite';
import {
  IndoorAirQualityDriver,
  air_band,
  alarm_location,
  type AirQualitySnapshot,
  type AlarmHit,
} from '../src/core/indoor_air_quality';
import {
  airthings_conditions,
  worst_room,
  _test_set_states_provider,
  _test_reset_states_provider,
} from '../src/connectors/airthings';
import type { HAEntityState } from '../src/connectors/home_assistant';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}

// Construction-time knobs (read by the driver constructor). Thresholds use the
// real defaults (1500/2500/5000 etc.) so the smoke tests shipped behavior.
process.env.HEARTH_AIR_CLEAR_GAP_MS = '1000';
process.env.HEARTH_AIR_CRITICAL_MIN_INTERVAL_MS = '500';
delete process.env.HEARTH_AIR_CRITICAL_REMIND; // default ON

const NO_AIR: AirQualitySnapshot = { co2: null, radon: null, voc: null, pm25: null };
const hit = (room: string, value: number, unit: string) => ({ room, value, unit });

interface Harness {
  driver: IndoorAirQualityDriver;
  pushes: Array<{ user_id: string; text: string; severity: string }>;
  speaks: Array<{ text: string; summary: string; tone: string }>;
  set_air(s: AirQualitySnapshot): void;
  set_alarms(a: AlarmHit[]): void;
  set_quiet(q: boolean): void;
  advance(ms: number): void;
}

function make(
  opts: { home?: string[]; source_throws?: boolean; db?: Database; start_ms?: number } = {},
): Harness {
  const pushes: Array<{ user_id: string; text: string; severity: string }> = [];
  const speaks: Array<{ text: string; summary: string; tone: string }> = [];
  let air: AirQualitySnapshot = NO_AIR;
  let alarms: AlarmHit[] = [];
  let quiet = false;
  const clock = { ms: opts.start_ms ?? 0 };
  const driver = new IndoorAirQualityDriver({
    // `db` is injectable so a test can build a SECOND driver over the SAME
    // ledger — i.e. simulate a process restart. Default: an isolated one.
    db: opts.db ?? new Database(':memory:'),
    memory: { log_action: () => 'audit' } as never,
    home_user_ids: () => opts.home ?? ['jasper', 'sam'],
    now: () => clock.ms,
    quiet_now: () => quiet,
    sources: {
      read_air_quality: async () => {
        if (opts.source_throws) throw new Error('boom');
        return air;
      },
      read_alarms: async () => alarms,
    },
    delivery: {
      push: async (user_id, text, severity) => { pushes.push({ user_id, text, severity }); },
      speak: async (text, summary, tone) => { speaks.push({ text, summary, tone }); },
    },
  });
  return {
    driver, pushes, speaks,
    set_air: (s) => { air = s; },
    set_alarms: (a) => { alarms = a; },
    set_quiet: (q) => { quiet = q; },
    advance: (ms) => { clock.ms += ms; },
  };
}

const co2 = (ppm: number): AirQualitySnapshot => ({ ...NO_AIR, co2: hit('Basement', ppm, 'ppm') });

// HA-entity helper for the connector test.
function ent(entity_id: string, state: string, unit: string | null, fn: string): HAEntityState {
  return {
    entity_id,
    state,
    attributes: { unit_of_measurement: unit ?? undefined, friendly_name: fn },
    last_changed: '2026-06-25T12:00:00Z',
  } as unknown as HAEntityState;
}

async function main(): Promise<void> {
  // ── connector: resolves rooms + worst-room digest ─────────────────────────
  console.log('→ airthings_conditions: rooms + worst-room digest');
  {
    const states: HAEntityState[] = [
      ent('sensor.basement_view_plus_carbon_dioxide', '900', 'ppm', 'Basement CO2'),
      ent('sensor.basement_view_plus_radon', '55', 'Bq/m³', 'Basement Radon'),
      ent('sensor.basement_view_plus_volatile_organic_compounds_parts', '300', 'ppb', 'Basement VOC'),
      ent('sensor.basement_view_plus_pm2_5', '2', 'µg/m³', 'Basement PM2.5'),
      ent('sensor.en_suite_airthings_carbon_dioxide', '620', 'ppm', 'En Suite CO2'),
      ent('sensor.en_suite_airthings_radon', '73', 'Bq/m³', 'En Suite Radon'),
      ent('sensor.living_room_carbon_dioxide', '600', 'ppm', 'Living room CO2'),
      ent('sensor.living_room_radon', '65', 'Bq/m³', 'Living room Radon'),
    ];
    _test_set_states_provider(async () => ({ ok: true, states }));
    const ctx = { memory: { log_action: () => 'a' }, now: new Date(), intent_id: 'x' } as never;
    const out = await airthings_conditions.execute({}, ctx);
    check('connector ok', out.ok === true);
    check('reads the basement CO₂', out.rooms?.['Basement']?.co2?.value === 900);
    check('carries HA unit', out.rooms?.['Basement']?.radon?.unit === 'Bq/m³');
    check('worst CO₂ is the basement (900)', out.signals?.worst.co2?.room === 'Basement' && out.signals?.worst.co2?.value === 900);
    check('worst radon is the en suite (73)', out.signals?.worst.radon?.room === 'En Suite' && out.signals?.worst.radon?.value === 73);
    check('an absent pollutant in a room → null worst (voc only in basement here)', out.signals?.worst.voc?.room === 'Basement');
    _test_reset_states_provider();
  }
  console.log('\n→ airthings_conditions: no entities → candidates recovery');
  {
    _test_set_states_provider(async () => ({ ok: true, states: [ent('sensor.kitchen_airthings_radon', '40', 'Bq/m³', 'Kitchen Radon')] }));
    const ctx = { memory: { log_action: () => 'a' }, now: new Date(), intent_id: 'x' } as never;
    const out = await airthings_conditions.execute({}, ctx);
    check('no default-room match → ok:false', out.ok === false);
    check('offers candidates (the air-quality-shaped sensor it does have)', (out.candidates?.length ?? 0) >= 1);
    _test_reset_states_provider();
  }
  // worst_room pure
  check('worst_room picks the max across rooms',
    worst_room({ A: { x: { entity_id: '', available: true, value: 10, raw: '10', unit: null, as_of: null } }, B: { x: { entity_id: '', available: true, value: 40, raw: '40', unit: null, as_of: null } } }, 'x')?.value === 40);

  // ── CO₂: the ACUTE tier — chime → klaxon → stronger klaxon ────────────────
  console.log('\n→ CO₂: chime (≥1500) → EBS klaxon (≥2500) → stronger (≥5000)');
  {
    const h = make();
    h.set_air(co2(1700)); // band 1 (≥1500), notice
    await h.driver.tick();
    check('1700 ppm fires a CHIME', h.pushes.length === 2, `pushes=${h.pushes.length}`);
    check('chime severity is medium (does NOT pierce quiet hours)', h.pushes[0]?.severity === 'medium', h.pushes[0]?.severity);
    check('chime tone is notice', h.speaks[0]?.tone === 'notice');
    check('chime text says elevated/ventilate, not leak', /elevated|ventilat/i.test(h.pushes[0]?.text ?? '') && !/leak/i.test(h.pushes[0]?.text ?? ''));

    // steady at 1800 (still band 1) → no re-fire (once per episode)
    h.advance(100);
    h.set_air(co2(1800));
    await h.driver.tick();
    check('steady CO₂ in the same band does NOT re-fire', h.pushes.length === 2);

    // climbs to 2600 → band 2 → EBS klaxon (critical/high), escalation copy
    h.advance(100);
    h.set_air(co2(2600));
    await h.driver.tick();
    check('climbing to 2600 RELEASES the klaxon', h.pushes.length === 4, `pushes=${h.pushes.length}`);
    check('klaxon severity is HIGH (pierces quiet hours)', h.pushes[2]?.severity === 'high', h.pushes[2]?.severity);
    check('klaxon tone is critical', h.speaks.at(-1)?.tone === 'critical');
    check('klaxon text warns of a leak + the kegerator + pets', /leak/i.test(h.pushes[2]?.text ?? '') && /kegerator/i.test(h.pushes[2]?.text ?? ''));
    check('escalation copy says climbing', /climbing/i.test(h.pushes[2]?.text ?? ''));

    // critical reminder: still ≥2500 after the interval → re-klaxon
    h.advance(600); // > 500ms critical interval
    h.set_air(co2(2700));
    await h.driver.tick();
    check('a sustained CO₂ leak RE-REMINDS on the clock', h.pushes.length === 6, `pushes=${h.pushes.length}`);

    // climbs into the danger band ≥5000 → escalation again, stronger copy
    h.advance(100);
    h.set_air(co2(5200));
    await h.driver.tick();
    check('crossing ≥5000 releases AGAIN (danger band)', h.pushes.length === 8, `pushes=${h.pushes.length}`);
    check('danger copy says leave the area now', /leave the area/i.test(h.pushes[6]?.text ?? ''));
  }

  // ── radon: chronic — gentle chime only, never critical ────────────────────
  console.log('\n→ radon: gentle chime only (never the klaxon)');
  {
    const h = make();
    h.set_air({ ...NO_AIR, radon: hit('Basement', 160, 'Bq/m³') }); // band 1 (≥148, EPA action level)
    await h.driver.tick();
    check('radon ≥100 fires a chime', h.pushes.length === 2);
    check('radon severity is medium (chronic — does not wake you)', h.pushes[0]?.severity === 'medium');
    check('radon tone is notice', h.speaks[0]?.tone === 'notice');
    // climbs to the EPA action level (≥148) → escalation, STILL notice
    h.advance(100);
    h.set_air({ ...NO_AIR, radon: hit('Basement', 320, 'Bq/m³') });
    await h.driver.tick();
    check('radon well above action level re-alerts (new band)', h.pushes.length === 4);
    check('radon at 2x action level is STILL a chime, never critical', h.pushes[2]?.severity === 'medium' && h.speaks.at(-1)?.tone === 'notice');
    check('band-1 copy names the EPA action level', /action level/i.test(h.pushes[0]?.text ?? ''));
    check('band-2 copy says WELL above', /well above/i.test(h.pushes[2]?.text ?? ''));
    // The owner policy: sub-action-level radon must never reach a phone.
    const q = make();
    q.set_air({ ...NO_AIR, radon: hit('Basement', 122, 'Bq/m³') }); // the live basement reading
    await q.driver.tick();
    check('POLICY: 122 Bq/m³ (below the 148 action level) pushes NOTHING', q.pushes.length === 0, `pushes=${q.pushes.length}`);
    check('POLICY: …and says nothing over the speaker either', q.speaks.length === 0);
  }

  // ── REGRESSION: the episode ledger must SURVIVE A RESTART ─────────────────
  //
  // This is the test whose absence let the radon storm ship. The engine's
  // contract is "once per episode", but the ledger lived in a process-local
  // Map, so every restart re-decided an ONGOING danger as `fresh`. For a
  // chronic condition (basement radon parked above its band) that meant one
  // push per deploy — 41 radon pushes on the live box, every one `fresh`,
  // clustered entirely on deploy-heavy days.
  //
  // Every previous cadence assertion here drove ONE long-lived driver, so the
  // process boundary — the only place the bug lives — was never crossed.
  console.log('\n→ REGRESSION: a restart must NOT re-fire an ongoing episode');
  {
    const ledger = new Database(':memory:'); // the durable ledger, shared across "boots"
    const chronic = { ...NO_AIR, radon: hit('Basement', 160, 'Bq/m³') }; // parked above band 1 (148)

    const boot1 = make({ db: ledger });
    boot1.set_air(chronic);
    await boot1.driver.tick();
    check('boot 1: chronic radon alerts once', boot1.pushes.length === 2, `pushes=${boot1.pushes.length}`);
    await boot1.driver.tick();
    check('boot 1: same process, steady level does not re-fire', boot1.pushes.length === 2);

    // ── process restart: a brand-new driver over the SAME ledger ──
    const boot2 = make({ db: ledger, start_ms: 5_000 });
    boot2.set_air(chronic);
    await boot2.driver.tick();
    check(
      'boot 2 (RESTART): the ongoing episode is remembered — ZERO new pushes',
      boot2.pushes.length === 0,
      `pushes=${boot2.pushes.length}`,
    );
    // Hammer it: a deploy-heavy day is many restarts in a row.
    for (let i = 0; i < 5; i += 1) {
      const b = make({ db: ledger, start_ms: 6_000 + i * 1_000 });
      b.set_air(chronic);
      await b.driver.tick();
      check(`boot ${3 + i} (RESTART): still silent`, b.pushes.length === 0, `pushes=${b.pushes.length}`);
    }

    // A genuine INTENSIFICATION still gets through across a restart — the
    // relief valve must not be muted by persistence.
    const boot8 = make({ db: ledger, start_ms: 12_000 });
    boot8.set_air({ ...NO_AIR, radon: hit('Basement', 320, 'Bq/m³') }); // band 2 (≥296)
    await boot8.driver.tick();
    check('a real escalation still fires across a restart', boot8.pushes.length === 2, `pushes=${boot8.pushes.length}`);

    // And once the danger genuinely CLEARS for a full gap, the ledger row is
    // dropped so the next occurrence is a fresh episode again.
    const boot9 = make({ db: ledger, start_ms: 12_000 + 60 * 60 * 1000 + 1000 });
    boot9.set_air(NO_AIR); // absent — longer than the clear gap
    await boot9.driver.tick();
    check('clearing for a full gap ends the episode (no push)', boot9.pushes.length === 0);
    const boot10 = make({ db: ledger, start_ms: 12_000 + 60 * 60 * 1000 + 2000 });
    boot10.set_air(chronic);
    await boot10.driver.tick();
    check('after a real clear, radon alerts FRESH again', boot10.pushes.length === 2, `pushes=${boot10.pushes.length}`);
  }

  // ── VOC / PM2.5: gentle chimes only ───────────────────────────────────────
  console.log('\n→ VOC + PM2.5: gentle chimes, never critical');
  {
    const h = make();
    h.set_air({ ...NO_AIR, voc: hit('En Suite', 1200, 'ppb'), pm25: hit('Living Room', 40, 'µg/m³') });
    await h.driver.tick();
    check('VOC + PM2.5 both fire (2 dangers × 2 recipients = 4 pushes)', h.pushes.length === 4, `pushes=${h.pushes.length}`);
    check('all VOC/PM pushes are medium severity', h.pushes.every((p) => p.severity === 'medium'));
    check('all VOC/PM speaks are notice tone', h.speaks.every((s) => s.tone === 'notice'));
  }

  // ── CO / smoke alarm: the acute evacuate-now klaxon ───────────────────────
  console.log('\n→ camera CO/smoke alarm: critical klaxon (pierces quiet hours)');
  {
    const h = make();
    h.set_alarms([{ kind: 'co', location: 'Garage' }]);
    await h.driver.tick();
    check('a CO alarm fires', h.pushes.length === 2);
    check('CO alarm is HIGH severity', h.pushes[0]?.severity === 'high');
    check('CO alarm is critical tone', h.speaks[0]?.tone === 'critical');
    check('CO alarm text says call 911 + get out', /911/.test(h.pushes[0]?.text ?? '') && /outside|out\b/i.test(h.pushes[0]?.text ?? ''));
    check('CO alarm names the location', /Garage/.test(h.pushes[0]?.text ?? ''));
    // smoke alarm in a different location = a distinct key
    h.advance(100);
    h.set_alarms([{ kind: 'co', location: 'Garage' }, { kind: 'smoke', location: 'Kitchen' }]);
    await h.driver.tick();
    check('a smoke alarm in another room is its own alert', h.pushes.length === 4);
  }

  // ── quiet-hours SPEAK gate: notice silent overnight; critical speaks ──────
  console.log('\n→ quiet hours: notice chime stays silent aloud; critical still speaks');
  {
    const h = make();
    h.set_quiet(true);
    h.set_air({ ...NO_AIR, radon: hit('Basement', 160, 'Bq/m³') }); // notice
    await h.driver.tick();
    check('during quiet hours a notice chime still PUSHES (queued by the gate)', h.pushes.length === 2);
    check('but does NOT speak aloud at 3am', h.speaks.length === 0, `speaks=${h.speaks.length}`);
    // a CO₂ klaxon during quiet hours DOES speak
    h.advance(100);
    h.set_air(co2(2600));
    await h.driver.tick();
    check('a critical klaxon SPEAKS even during quiet hours', h.speaks.length === 1 && h.speaks[0]?.tone === 'critical');
  }

  // ── episode cadence: re-alert only after a full clear-gap ─────────────────
  console.log('\n→ episode cadence: re-alert only after the level clears for the gap');
  {
    const h = make();
    h.set_air(co2(1700));
    await h.driver.tick();
    check('episode 1 chime', h.pushes.length === 2);
    // level returns to normal, past the clear-gap
    h.set_air(NO_AIR);
    h.advance(1500); // > 1000ms clear-gap
    await h.driver.tick();
    check('quiet tick past the gap does not fire', h.pushes.length === 2);
    // elevated again → fresh episode
    h.set_air(co2(1700));
    await h.driver.tick();
    check('re-alerts as a fresh episode after the clear-gap', h.pushes.length === 4);
  }

  // ── band math + alarm-location parsing (pure) ─────────────────────────────
  console.log('\n→ pure: air_band + alarm_location');
  check('air_band: 900 vs [1500,2500,5000] → 0', air_band(900, [1500, 2500, 5000]) === 0);
  check('air_band: 1700 → 1', air_band(1700, [1500, 2500, 5000]) === 1);
  check('air_band: 2600 → 2', air_band(2600, [1500, 2500, 5000]) === 2);
  check('air_band: 5200 → 3', air_band(5200, [1500, 2500, 5000]) === 3);
  check('alarm_location strips the alarm words', alarm_location('Garage CO alarm detected', 'garage') === 'Garage');
  check('alarm_location handles smoke', alarm_location('Driveway Right Smoke alarm detected', 'driveway_right') === 'Driveway Right');
  check('alarm_location falls back to the entity stem', alarm_location('', 'rear_door') === 'Rear Door');

  // ── recipients: owner + household, never friend / synthetic ───────────────
  console.log('\n→ recipients = owner + household (default resolver)');
  {
    const fakeUsers = { list: () => [
      { id: 'jasper', tier: 'owner', email: 'jasper@gmail.com' },
      { id: 'sam', tier: 'household', email: 'sam@gmail.com' },
      { id: 'kim', tier: 'friend', email: 'kim@gmail.com' },
      { id: 'bot', tier: 'household', email: 'bot@hearth.local' },
    ] } as never;
    const pushes: Array<{ user_id: string }> = [];
    const clock = { ms: 0 };
    const d = new IndoorAirQualityDriver({
      db: new Database(':memory:'),
      memory: { log_action: () => 'a' } as never,
      users: fakeUsers, now: () => clock.ms, quiet_now: () => false,
      sources: { read_air_quality: async () => co2(2600), read_alarms: async () => [] },
      delivery: { push: async (u) => { pushes.push({ user_id: u }); }, speak: async () => {} },
    });
    await d.tick();
    check('owner + household only (friend + synthetic excluded)', pushes.map((p) => p.user_id).sort().join(',') === 'jasper,sam', pushes.map((p) => p.user_id).join(','));
  }

  // ── fail-open + kill switch ───────────────────────────────────────────────
  console.log('\n→ fail-open + kill switch');
  {
    const h = make({ source_throws: true });
    let threw = false;
    try { await h.driver.tick(); } catch { threw = true; }
    check('tick does not throw on a source failure', !threw);
    check('no delivery on source failure', h.pushes.length === 0 && h.speaks.length === 0);
  }
  {
    delete process.env.HEARTH_AIR_QUALITY_ALERTS;
    const h = make();
    h.driver.attach();
    check('disabled: no timer scheduled', (h.driver as unknown as { timer: unknown }).timer === null);
    h.driver.stop();
  }

  console.log(`\n  passed=${passed}  failed=${failed}`);
  if (failed > 0) { console.error('\n✗ AIR-QUALITY SMOKE FAILED'); process.exit(1); }
  console.log('\n✓ AIR-QUALITY SMOKE OK');
}

main().catch((err: unknown) => {
  console.error('\n✗ AIR-QUALITY SMOKE CRASHED:', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
