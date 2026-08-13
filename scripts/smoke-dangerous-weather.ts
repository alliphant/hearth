/**
 * Smoke for the DangerousWeatherDriver (proactive danger alerts).
 *
 * Fully self-contained + device-free: no HA, no Pirate, no APNs, no coordinator.
 * The driver's danger SOURCES (tempest + alerts) and DELIVERY (push + speak) are
 * injected spies, with a controllable clock, so this exercises the detection /
 * episode-cadence / relief-valve / recipient / fail-open / kill-switch logic
 * deterministically.
 *
 * Cadence under test (redesigned 2026-06-24):
 *   - GENTLE = ONCE PER EPISODE. A notice-tier danger alerts ONCE and stays
 *     SILENT the whole time it's ongoing — NO clock-based re-alert, no matter how
 *     long (this replaces the old "re-fire every 30 min" the prior smoke wrongly
 *     asserted). It re-alerts only after the danger has been ABSENT for a full
 *     clear-gap AND a new occurrence begins. An intermittent signal (lightning
 *     between strikes) stays ONE episode as long as strikes are < clear-gap apart.
 *   - RELIEF VALVE = release on genuine INTENSIFICATION. A monotonic "worst band
 *     seen" valve: re-alerts only when intensity crosses STRICTLY into a more-
 *     dangerous band (lightning closing in ≤3 mi, then "right overhead" ≤2 mi;
 *     wind ≥70/≥90 mph), then re-seats. Each strictly-worse crossing releases ONCE.
 *   - INVARIANT: steady-state / oscillation (the real 6→5→6 mi grounding storm)
 *     must NOT release — only a strictly-worse band does.
 *   - CRITICAL keeps a periodic reminder while ongoing; NOTICE never does.
 *   - the NWS WARNING taxonomy fires, TIERED by urgency (classify_alert); the
 *     distance/wind gates; owner+household recipients (never friend/synthetic);
 *     fail-open; kill switch.
 */
import { Database } from 'bun:sqlite';
import {
  DangerousWeatherDriver,
  classify_alert,
  is_synthetic_account,
  lightning_escalation_band,
  wind_escalation_band,
  type DangerReadings,
} from '../src/core/dangerous_weather';
import type { ActiveWeatherAlert } from '../src/connectors/weather';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}

// Fixed thresholds for determinism (driver reads these AT CONSTRUCTION, so each
// make() picks up whatever env is set when it's called).
process.env.HEARTH_DANGER_LIGHTNING_MI = '10';
process.env.HEARTH_DANGER_WIND_GUST_MPH = '50';
process.env.HEARTH_DANGER_LIGHTNING_ESCALATION_MI = '3,2'; // ≤3 "closing in" + ≤2 "overhead"
process.env.HEARTH_DANGER_WIND_ESCALATION_MPH = '70,90'; // two gust bands
process.env.HEARTH_DANGER_CLEAR_GAP_MS = '1000'; // episode ends after 1s absent
process.env.HEARTH_DANGER_CRITICAL_MIN_INTERVAL_MS = '500'; // critical reminder cadence
delete process.env.HEARTH_DANGER_CRITICAL_REMIND; // default ON

const NO_LIGHTNING: DangerReadings = { ok: true, lightning_active: false, lightning_distance: null, wind_gust: 5 };

interface Harness {
  driver: DangerousWeatherDriver;
  pushes: Array<{ user_id: string; text: string }>;
  speaks: Array<{ text: string; summary: string; tone?: string }>;
  set_tempest(r: DangerReadings): void;
  set_alerts(a: ActiveWeatherAlert[]): void;
  advance(ms: number): void;
}

function make(opts: { home?: string[]; tempest_throws?: boolean } = {}): Harness {
  const pushes: Array<{ user_id: string; text: string }> = [];
  const speaks: Array<{ text: string; summary: string; tone?: string }> = [];
  let tempest: DangerReadings = NO_LIGHTNING;
  let alerts: ActiveWeatherAlert[] = [];
  const clock = { ms: 0 };
  const driver = new DangerousWeatherDriver({
    db: new Database(':memory:'),
    memory: { log_action: () => 'audit' } as never,
    home_user_ids: () => opts.home ?? ['jasper', 'sam'],
    now: () => clock.ms,
    sources: {
      read_tempest: async () => {
        if (opts.tempest_throws) throw new Error('boom');
        return tempest;
      },
      read_alerts: async () => alerts,
    },
    delivery: {
      push: async (user_id, text) => { pushes.push({ user_id, text }); },
      speak: async (text, summary, tone) => { speaks.push({ text, summary, tone }); },
    },
  });
  return {
    driver, pushes, speaks,
    set_tempest: (r) => { tempest = r; },
    set_alerts: (a) => { alerts = a; },
    advance: (ms) => { clock.ms += ms; },
  };
}

const lightning = (dist: number | null): DangerReadings => ({ ok: true, lightning_active: true, lightning_distance: dist, wind_gust: 5 });
const gust = (mph: number): DangerReadings => ({ ok: true, lightning_active: false, lightning_distance: null, wind_gust: mph });
const tornado: ActiveWeatherAlert = { title: 'Tornado Warning', severity: 'warning', ts_expires: '2026-06-23T20:00:00Z', description: 'Take cover now.' };
const winter: ActiveWeatherAlert = { title: 'Winter Storm Warning', severity: 'warning', ts_expires: null, description: 'Heavy snow, 8 to 14 inches.' };

async function main(): Promise<void> {
  // ── EPISODE: lightning fires ONCE, stays silent the whole time ongoing ─────
  console.log('→ episode: one alert, SILENT while ongoing no matter how long');
  {
    const h = make();
    h.set_tempest(lightning(8)); // 8 mi, within 10, band 0
    await h.driver.tick();
    check('fires on first close strike', h.pushes.length === 2 && h.speaks.length === 1, `pushes=${h.pushes.length} speaks=${h.speaks.length}`);
    check('first alert mentions lightning', /lightning/i.test(h.pushes[0]?.text ?? ''));
    check('first alert is the FRESH text, not the closing-in variant', !/closing in/i.test(h.pushes[0]?.text ?? ''));
    check('lightning speak uses the soft notice tone', h.speaks[0]?.tone === 'notice', h.speaks[0]?.tone);

    // still active next tick → no re-fire
    await h.driver.tick();
    check('does NOT re-fire while still active', h.pushes.length === 2);

    // THE ANTI-NUISANCE: advance FAR past the old 30-min window while STILL
    // ACTIVE (continuously present) → must STAY silent. The prior smoke wrongly
    // asserted a re-fire here; that was the bug this redesign removes.
    h.advance(10_000); // 10× the clear-gap
    await h.driver.tick();
    check('still silent 10× the clear-gap later (still active) — once per episode', h.pushes.length === 2, `pushes=${h.pushes.length}`);
    h.advance(10_000);
    await h.driver.tick();
    check('still silent after a SECOND long ongoing stretch', h.pushes.length === 2);
  }

  // ── EPISODE: intermittent lightning (between strikes) stays ONE episode ────
  console.log('\n→ intermittent: clear→reappear within the clear-gap does NOT re-fire');
  {
    const h = make();
    h.set_tempest(lightning(6));
    await h.driver.tick();
    check('fires on first strike', h.pushes.length === 2);
    // clear (no strike this minute) — episode stays alive (within clear-gap)
    h.set_tempest(NO_LIGHTNING);
    await h.driver.tick();
    check('no fire when momentarily clear', h.pushes.length === 2);
    h.advance(400); // < 1000ms clear-gap
    h.set_tempest(lightning(5)); // reappears, still band 0
    await h.driver.tick();
    check('reappearance within the clear-gap does NOT re-fire (intermittent fix)', h.pushes.length === 2, `pushes=${h.pushes.length}`);
    h.advance(400);
    h.set_tempest(lightning(6));
    await h.driver.tick();
    check('still one episode across several flickers', h.pushes.length === 2);
  }

  // ── EPISODE: re-alert only after a full clear-gap of absence + new strike ──
  console.log('\n→ new episode: re-alerts after the danger clears for the full gap');
  {
    const h = make();
    h.set_tempest(lightning(6));
    await h.driver.tick();
    check('episode 1 alert', h.pushes.length === 2);
    // danger goes fully quiet PAST the clear-gap (a quiet tick crosses the gap)
    h.set_tempest(NO_LIGHTNING);
    h.advance(1500); // > 1000ms clear-gap
    await h.driver.tick();
    check('quiet tick past the gap does not fire', h.pushes.length === 2);
    // a NEW strike now is a fresh episode → re-alerts
    h.set_tempest(lightning(6));
    await h.driver.tick();
    check('a new occurrence AFTER the clear-gap re-alerts (fresh episode)', h.pushes.length === 4, `pushes=${h.pushes.length}`);
  }

  // ── RELIEF VALVE: closing-in (≤3) then overhead (≤2) each release ONCE ──────
  console.log('\n→ relief valve: closing-in (≤3 mi) then overhead (≤2 mi) each release once');
  {
    const h = make();
    h.set_tempest(lightning(8)); // band 0 (>3 mi)
    await h.driver.tick();
    check('episode opens at 8 mi (band 0)', h.pushes.length === 2);
    check('opening alert is the fresh text (not closing-in/overhead)', !/closing in|overhead/i.test(h.pushes[0]?.text ?? ''));

    // closes in to ~2.8 mi → band 1 (≤3, >2) → "closing in" release
    h.advance(100);
    h.set_tempest(lightning(2.8));
    await h.driver.tick();
    check('crossing ≤3 mi RELEASES (closing in)', h.pushes.length === 4, `pushes=${h.pushes.length}`);
    check('the ≤3 release uses the closing-in text', /closing in/i.test(h.pushes[3]?.text ?? ''), h.pushes[3]?.text);
    check('not yet the overhead text', !/overhead/i.test(h.pushes[3]?.text ?? ''));

    // hovering at 2.5 mi (still band 1) → no re-release
    h.advance(100);
    h.set_tempest(lightning(2.5));
    await h.driver.tick();
    check('hovering in the ≤3 band does NOT re-release', h.pushes.length === 4);

    // closes further to ~1.5 mi → band 2 (≤2) → SECOND release, the OVERHEAD alert
    h.advance(100);
    h.set_tempest(lightning(1.5));
    await h.driver.tick();
    check('crossing ≤2 mi RELEASES AGAIN — the closer-proximity (overhead) alert', h.pushes.length === 6, `pushes=${h.pushes.length}`);
    check('the ≤2 release uses the OVERHEAD text', /overhead/i.test(h.pushes[5]?.text ?? ''), h.pushes[5]?.text);
    check('overhead speak still carries the notice tone', h.speaks.at(-1)?.tone === 'notice');

    // even closer / same band → no re-nag (monotonic)
    h.advance(100);
    h.set_tempest(lightning(1));
    await h.driver.tick();
    check('1 mi (same ≤2 overhead band) does NOT re-release — monotonic', h.pushes.length === 6);
    h.advance(100);
    h.set_tempest(lightning(0)); // "very close by", still band 2
    await h.driver.tick();
    check('a 0 mi (very close by) strike in the same band does NOT re-release', h.pushes.length === 6);

    // easing back out and back in → no re-release (worst_band stays 2)
    h.advance(100);
    h.set_tempest(lightning(7)); // band 0
    await h.driver.tick();
    check('easing back out does not fire', h.pushes.length === 6);
    h.advance(100);
    h.set_tempest(lightning(1.5)); // band 2 again, but worst_band already 2
    await h.driver.tick();
    check('re-entering the overhead band does NOT re-release (already alerted there)', h.pushes.length === 6);

    check('a fully-marching storm = exactly 3 alerts (fresh + closing-in + overhead)', h.pushes.length === 6);
  }
  // a DIRECT jump 8 → 1.5 mi (skipping the ≤3 tier) releases ONCE, at overhead
  {
    const h = make();
    h.set_tempest(lightning(8));
    await h.driver.tick();
    check('direct-jump episode opens at 8 mi', h.pushes.length === 2);
    h.advance(100);
    h.set_tempest(lightning(1.5)); // straight to band 2
    await h.driver.tick();
    check('a direct jump to ≤2 mi releases once (band 0→2)', h.pushes.length === 4, `pushes=${h.pushes.length}`);
    check('the direct-jump release is the overhead text', /overhead/i.test(h.pushes[3]?.text ?? ''), h.pushes[3]?.text);
  }

  // ── INVARIANT: the real 6→5→6 grounding storm releases EXACTLY ONCE ────────
  console.log('\n→ invariant: steady-state (6→5→6 mi, clustered) does NOT re-nag');
  {
    const h = make();
    // Replay the grounding storm: readings over ~1 hour, distance drifting
    // 6→5→6 (NOT a clean close-in), strikes clustered + intermittent.
    const replay: Array<DangerReadings> = [
      lightning(6),       // 00:13 — opens the episode
      NO_LIGHTNING,       // lull
      lightning(6),       // 00:27 (clustered)
      lightning(6),       // 00:29
      NO_LIGHTNING,       // lull
      lightning(5),       // 00:52 (clustered)
      lightning(5),       // 00:56
      lightning(5),       // 00:58
      NO_LIGHTNING,       // lull
      lightning(6),       // 01:13
    ];
    for (const r of replay) {
      h.advance(200); // each step well within the clear-gap (1000ms)
      h.set_tempest(r);
      await h.driver.tick();
    }
    check('the whole 6→5→6 storm is EXACTLY ONE alert (the invariant)', h.pushes.length === 2, `pushes=${h.pushes.length}`);
    check('and exactly one spoken announcement', h.speaks.length === 1, `speaks=${h.speaks.length}`);
  }

  // ── RELIEF VALVE: wind strengthening crosses gust bands ────────────────────
  console.log('\n→ relief valve: wind strengthening across 70 / 90 mph bands');
  {
    const h = make();
    h.set_tempest(gust(55)); // band 0 (≥50, <70)
    await h.driver.tick();
    check('wind episode opens at 55 mph', h.pushes.length === 2 && /55 mph/.test(h.pushes[0]?.text ?? ''));
    check('wind speak uses the soft notice tone', h.speaks.at(-1)?.tone === 'notice');
    h.advance(100);
    h.set_tempest(gust(58)); // still band 0
    await h.driver.tick();
    check('a steady 58 mph does NOT re-fire (same band)', h.pushes.length === 2);
    h.advance(100);
    h.set_tempest(gust(75)); // band 1 (≥70)
    await h.driver.tick();
    check('strengthening to 75 mph RELEASES', h.pushes.length === 4, `pushes=${h.pushes.length}`);
    check('the wind release uses the picking-up text', /picking up/i.test(h.pushes[3]?.text ?? ''));
    h.advance(100);
    h.set_tempest(gust(78)); // still band 1
    await h.driver.tick();
    check('78 mph (same band) does NOT re-release', h.pushes.length === 4);
    h.advance(100);
    h.set_tempest(gust(95)); // band 2 (≥90)
    await h.driver.tick();
    check('strengthening to 95 mph releases AGAIN (next band)', h.pushes.length === 6, `pushes=${h.pushes.length}`);
  }

  // ── band-math units (pure) ─────────────────────────────────────────────────
  console.log('\n→ escalation band math (pure functions)');
  check('lightning: 6 mi → band 0 (>3)', lightning_escalation_band(6, [3]) === 0);
  check('lightning: 3 mi → band 1 (≤3)', lightning_escalation_band(3, [3]) === 1);
  check('lightning: 2 mi → band 1', lightning_escalation_band(2, [3]) === 1);
  check('lightning: unknown distance → band 0 (cannot escalate)', lightning_escalation_band(null, [3]) === 0);
  // the live default — closing-in (≤3) + overhead (≤2)
  check('lightning: [3,2] — 4 mi → band 0', lightning_escalation_band(4, [3, 2]) === 0);
  check('lightning: [3,2] — 2.8 mi → band 1 (closing in)', lightning_escalation_band(2.8, [3, 2]) === 1);
  check('lightning: [3,2] — 2 mi → band 2 (overhead)', lightning_escalation_band(2, [3, 2]) === 2);
  check('lightning: [3,2] — 0 mi → band 2', lightning_escalation_band(0, [3, 2]) === 2);
  check('lightning: graduated [4,1.5] — 5 mi → 0', lightning_escalation_band(5, [4, 1.5]) === 0);
  check('lightning: graduated [4,1.5] — 3 mi → 1', lightning_escalation_band(3, [4, 1.5]) === 1);
  check('lightning: graduated [4,1.5] — 1 mi → 2', lightning_escalation_band(1, [4, 1.5]) === 2);
  check('wind: 55 → band 0', wind_escalation_band(55, [70, 90]) === 0);
  check('wind: 75 → band 1', wind_escalation_band(75, [70, 90]) === 1);
  check('wind: 95 → band 2', wind_escalation_band(95, [70, 90]) === 2);
  check('wind: null → band 0', wind_escalation_band(null, [70, 90]) === 0);

  // ── CRITICAL: keeps a periodic reminder while ongoing; NOTICE never does ───
  console.log('\n→ critical keeps a reminder while ongoing; notice does not');
  {
    const h = make();
    h.set_alerts([tornado]);
    await h.driver.tick();
    check('tornado warning fires (critical)', h.pushes.length === 2 && h.speaks[0]?.tone === 'critical');
    await h.driver.tick();
    check('does not re-remind within the reminder interval', h.pushes.length === 2);
    h.advance(600); // > 500ms critical reminder interval, still active
    await h.driver.tick();
    check('a sustained tornado warning RE-REMINDS on the clock', h.pushes.length === 4, `pushes=${h.pushes.length}`);
    check('the reminder is the same critical tone', h.speaks.at(-1)?.tone === 'critical');
  }
  {
    const h = make();
    h.set_alerts([winter]); // notice tier, long-duration
    await h.driver.tick();
    check('winter storm warning fires (notice)', h.pushes.length === 2 && h.speaks[0]?.tone === 'notice');
    check('notice push says take precautions (not take cover now)',
      / take precautions\./i.test(h.pushes[0]?.text ?? '') && !/take cover now/i.test(h.pushes[0]?.text ?? ''));
    // advance FAR past the critical reminder interval, still active → notice
    // must NOT remind (once per episode, no clock re-fire).
    h.advance(5000);
    await h.driver.tick();
    check('a long-duration NOTICE warning NEVER reminds on the clock', h.pushes.length === 2, `pushes=${h.pushes.length}`);
  }
  {
    // CRITICAL_REMIND=0 → critical also goes once-per-episode
    process.env.HEARTH_DANGER_CRITICAL_REMIND = '0';
    const h = make();
    h.set_alerts([tornado]);
    await h.driver.tick();
    check('tornado fires with reminders disabled', h.pushes.length === 2);
    h.advance(5000); // far past the interval, still active
    await h.driver.tick();
    check('CRITICAL_REMIND=0 → no clock reminder (once per episode)', h.pushes.length === 2, `pushes=${h.pushes.length}`);
    delete process.env.HEARTH_DANGER_CRITICAL_REMIND; // restore default
  }

  // ── distance gate ──────────────────────────────────────────────────────────
  console.log('\n→ distant lightning does not fire; unknown-distance active does');
  {
    const h = make();
    h.set_tempest(lightning(25)); // beyond 10 mi
    await h.driver.tick();
    check('distant strike (25mi) does not fire', h.pushes.length === 0);
    h.set_tempest(lightning(null)); // active but distance unknown → treat as close
    await h.driver.tick();
    check('active strike with unknown distance fires', h.pushes.length === 2);
  }

  // ── wind gate ──────────────────────────────────────────────────────────────
  console.log('\n→ extreme wind fires; sub-threshold does not');
  {
    const h = make();
    h.set_tempest(gust(40));
    await h.driver.tick();
    check('40 mph gust does not fire (< 50)', h.pushes.length === 0);
    h.set_tempest(gust(58));
    await h.driver.tick();
    check('58 mph gust fires', h.pushes.length === 2 && /58 mph/.test(h.pushes[0]?.text ?? ''));
  }

  // ── severe-weather alerts: full NWS taxonomy, tiered by urgency ───────────
  console.log('\n→ NWS taxonomy: critical reserved for true take-cover-now urgency');
  check('Tornado Warning → critical', classify_alert('Tornado Warning') === 'critical');
  check('Tornado Emergency → critical', classify_alert('Tornado Emergency') === 'critical');
  check('Flash Flood Warning → critical', classify_alert('Flash Flood Warning') === 'critical');
  check('Flash Flood Emergency → critical', classify_alert('Flash Flood Emergency') === 'critical');
  check('Extreme Wind Warning → critical', classify_alert('Extreme Wind Warning') === 'critical');
  check('Severe Thunderstorm Warning (destructive) → critical',
    classify_alert('Severe Thunderstorm Warning', 'Damage threat: DESTRUCTIVE. 80 mph winds.') === 'critical');
  check('Fire Warning → critical', classify_alert('Fire Warning') === 'critical');
  check('Severe Thunderstorm Warning (plain) → notice', classify_alert('Severe Thunderstorm Warning') === 'notice');
  check('Winter Storm Warning → notice', classify_alert('Winter Storm Warning') === 'notice');
  check('Blizzard Warning → notice', classify_alert('Blizzard Warning') === 'notice');
  check('High Wind Warning → notice', classify_alert('High Wind Warning') === 'notice');
  check('Extreme Cold Warning → notice', classify_alert('Extreme Cold Warning') === 'notice');
  check('Excessive Heat Warning → notice', classify_alert('Excessive Heat Warning') === 'notice');
  check('Flood Warning (non-flash) → notice', classify_alert('Flood Warning') === 'notice');
  check('Red Flag Warning → notice', classify_alert('Red Flag Warning') === 'notice');
  check('an unrecognized "* Warning" → notice (never wrongly critical)', classify_alert('Lakeshore Flood Warning') === 'notice');
  check('Tornado Watch → no alert', classify_alert('Tornado Watch') === null);
  check('Winter Weather Advisory → no alert', classify_alert('Winter Weather Advisory') === null);
  check('Heat Advisory → no alert', classify_alert('Heat Advisory') === null);
  check('Air Quality Alert → no alert', classify_alert('Air Quality Alert') === null);
  check('Special Weather Statement → no alert', classify_alert('Special Weather Statement') === null);
  {
    const h = make();
    h.set_alerts([{ ...tornado, description: 'A tornado was spotted near Pleasantville. Take cover immediately.' }]);
    await h.driver.tick();
    check('tornado warning fires push + speak', h.pushes.length === 2 && h.speaks.length === 1);
    check('alert text carries the title', /Tornado Warning/.test(h.pushes[0]?.text ?? ''));
    check('spoken text is Kate-framed', /This is Kate/.test(h.speaks[0]?.text ?? ''));
    check('critical push says take cover now', / take cover now\./i.test(h.pushes[0]?.text ?? ''));
    // a watch alongside is ignored; the warning does not re-fire (same tick)
    h.set_alerts([tornado, { title: 'Flood Watch', severity: 'watch', ts_expires: null, description: null }]);
    await h.driver.tick();
    check('warning does not re-fire immediately; watch ignored', h.pushes.length === 2);
  }
  {
    // an UPGRADE (Tornado Warning → Tornado Emergency) is a NEW key → fresh alert
    const h = make();
    h.set_alerts([tornado]);
    await h.driver.tick();
    check('tornado warning episode opens', h.pushes.length === 2);
    h.advance(100);
    h.set_alerts([{ title: 'Tornado Emergency', severity: 'warning', ts_expires: null, description: 'Confirmed large tornado.' }]);
    await h.driver.tick();
    check('an UPGRADE to Tornado Emergency alerts on its own key', h.pushes.length === 4, `pushes=${h.pushes.length}`);
  }

  // ── recipients: owner+household, never friend, never synthetic ───────────
  console.log('\n→ recipients = real owner + household; friend AND test account excluded');
  check('synthetic @hearth.local is flagged', is_synthetic_account({ email: 'testuser@hearth.local' }));
  check('real provider email is not synthetic', !is_synthetic_account({ email: 'jasper@gmail.com' }));
  check('null email is not synthetic (do not exclude a real device-less user)', !is_synthetic_account({ email: null }));
  {
    const fakeUsers = { list: () => [
      { id: 'jasper', tier: 'owner', email: 'jasper@gmail.com' },
      { id: 'sam', tier: 'household', email: 'sam@gmail.com' },
      { id: 'kim', tier: 'friend', email: 'kim@gmail.com' },
      { id: 'testuser_validate', tier: 'household', email: 'testuser@hearth.local' },
    ] } as never;
    const pushes: Array<{ user_id: string; text: string }> = [];
    const clock = { ms: 0 };
    const d = new DangerousWeatherDriver({
      db: new Database(':memory:'),
      memory: { log_action: () => 'a' } as never,
      users: fakeUsers, now: () => clock.ms,
      sources: { read_tempest: async () => lightning(3), read_alerts: async () => [] },
      delivery: { push: async (u, t) => { pushes.push({ user_id: u, text: t }); }, speak: async () => {} },
    });
    await d.tick();
    const ids = pushes.map((p) => p.user_id).sort();
    check('pushes real owner + household only (friend + test excluded)', ids.join(',') === 'jasper,sam', ids.join(','));
  }

  // ── fail-open ──────────────────────────────────────────────────────────────
  console.log('\n→ fail-open: a throwing source neither crashes nor delivers');
  {
    const h = make({ tempest_throws: true });
    let threw = false;
    try { await h.driver.tick(); } catch { threw = true; }
    check('tick does not throw', !threw);
    check('no delivery on source failure', h.pushes.length === 0 && h.speaks.length === 0);
  }

  // ── kill switch ────────────────────────────────────────────────────────────
  console.log('\n→ kill switch: attach() is a no-op unless HEARTH_DANGEROUS_WEATHER=1');
  {
    delete process.env.HEARTH_DANGEROUS_WEATHER;
    const h = make();
    h.driver.attach();
    check('disabled: no timer scheduled', (h.driver as unknown as { timer: unknown }).timer === null);
    h.driver.stop();
  }

  console.log(`\n  passed=${passed}  failed=${failed}`);
  if (failed > 0) { console.error('\n✗ DANGEROUS-WEATHER SMOKE FAILED'); process.exit(1); }
  console.log('\n✓ DANGEROUS-WEATHER SMOKE OK');
}

main().catch((err: unknown) => {
  console.error('\n✗ DANGEROUS-WEATHER SMOKE CRASHED:', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
