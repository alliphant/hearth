/**
 * Self-contained smoke for the Live Ride Companion Phase 1 backend
 * (no orchestrator, no live LLM, no live TTS, no APNs).
 *
 * Covers:
 *   1. Insight detector matrix (insight.ts) on synthetic packet
 *      streams — zone_shift, distance_milestone (incl. rehydrate
 *      collapse + custom interval), longest_this_month, hr_drift,
 *      cooldown_detected, pace_change, and the conservatism rule
 *      (no HR / no distance ⇒ silence).
 *   2. Numeric grounding (cue_render.ts) — evidence-derived numbers
 *      pass (incl. m→km, s→min, pace→km/h derivations), fabricated
 *      figures reject, small ints exempt.
 *   3. render_cue fail-open — good reply sanitized + returned;
 *      fabricated-number reply → null; throwing provider → null;
 *      over-length → null.
 *   4. synthesize_cue_clip with mocked TTS transport + transcoder —
 *      clip written + duration parsed from the WAV header; transport
 *      failure → null (text-only degrade).
 *   5. WorkoutCueStore round-trip + TTL sweep (row AND file).
 *   6. The /api/workout/cues routes in-process — per-user cordon on
 *      clip serving (owner 200 / other user 404 / etag 304) and the
 *      mute lifecycle (flag set, scoped to caller's sessions, 404 on
 *      someone else's session).
 *
 * Run: bun run smoke:astrid-insight
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import {
  SessionInsightState,
  detect_insight,
  type InsightHit,
  type InsightSample,
} from '../src/specialists/astrid/insight';
import { render_cue, numbers_grounded } from '../src/specialists/astrid/cue_render';
import {
  generate_ride_name,
  fallback_ride_name,
  power_band_label,
  time_of_day_label,
} from '../src/specialists/astrid/ride_name';
import {
  synthesize_cue_clip,
  wav_duration_s,
  speechify,
  _test_set_tts_transport,
  _test_set_transcoder,
} from '../src/specialists/astrid/cue_voice';
import { WorkoutCueStore, CLIP_TTL_MS } from '../src/memory/stores/workout_cues';
import { WorkoutRouteStore } from '../src/memory/stores/workout_routes';
import { open_db } from '../src/memory/stores/structured';
import { create_workout_router, WorkoutSessionTracker, reap_stale_active_sessions } from '../src/app/routes/workout';
import { UserConfigSchema } from '../src/core/users';
import { MemoryClient } from '../src/memory/client';
import type { MemoryClient as MemoryClientType } from '../src/memory/client';
import type { AppEventBus } from '../src/app/events';
import type { LLMRouter } from '../src/core/llm';

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: string): void {
  checks += 1;
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── Detector helpers ─────────────────────────────────────────────────

const T0 = 1_750_000_000_000; // fixed wall-clock origin for determinism

interface StreamSpec {
  /** seconds between samples */
  step_s?: number;
  /** total samples */
  n: number;
  hr?: (i: number, elapsed_s: number) => number | null;
  zone?: (i: number, elapsed_s: number) => number | null;
  /** cumulative distance in meters */
  dist?: (i: number, elapsed_s: number) => number | null;
  /** cumulative (monotonic) elevation gain in meters */
  gain?: (i: number, elapsed_s: number) => number | null;
}

function run_stream(
  spec: StreamSpec,
  opts?: { milestone?: number; units?: 'imperial' | 'metric'; workout_type?: string; history_longest_s?: number | null },
): { hits: InsightHit[]; state: SessionInsightState } {
  const state = new SessionInsightState();
  if (opts?.history_longest_s !== undefined) {
    state.history_longest_s = opts.history_longest_s;
    state.history_loaded = true;
  }
  const step = spec.step_s ?? 30;
  const hits: InsightHit[] = [];
  for (let i = 0; i < spec.n; i += 1) {
    const elapsed_s = (i + 1) * step;
    const sample: InsightSample = {
      at_ms: T0 + elapsed_s * 1000,
      elapsed_s,
      active_kcal: elapsed_s * 0.16,
      distance_m: spec.dist ? spec.dist(i, elapsed_s) : null,
      current_hr: spec.hr ? spec.hr(i, elapsed_s) : null,
      current_hr_zone: spec.zone ? spec.zone(i, elapsed_s) : null,
      elevation_gain_m: spec.gain ? spec.gain(i, elapsed_s) : null,
    };
    state.append(sample);
    const hit = detect_insight(
      state,
      {
        milestone_m: (opts?.milestone ?? 10) * (opts?.units === 'imperial' ? 1609.344 : 1000),
        units: opts?.units ?? 'metric',
      },
      opts?.workout_type ?? 'cycling',
    );
    if (hit) hits.push(hit);
  }
  return { hits, state };
}

console.log('— detector: conservatism (no signals ⇒ silence)');
{
  const { hits } = run_stream({ n: 60 });
  check('bare elapsed/kcal stream fires nothing', hits.length === 0, `got ${hits.map((h) => h.trigger).join(',')}`);
}

console.log('— detector: zone_shift');
{
  const { hits } = run_stream({
    n: 12,
    hr: () => 150,
    zone: (i) => (i < 5 ? 2 : 3),
  });
  const shifts = hits.filter((h) => h.trigger === 'zone_shift');
  check('sustained z2→z3 fires exactly once', shifts.length === 1, `got ${shifts.length}`);
  check('shift direction is up', shifts[0]?.facts.direction === 'up');
}
{
  // A 30-second zone blip never establishes — no cue.
  const { hits } = run_stream({
    n: 12,
    hr: () => 150,
    zone: (i) => (i === 6 ? 4 : 2),
  });
  check('a one-sample zone blip stays silent', hits.filter((h) => h.trigger === 'zone_shift').length === 0);
}

console.log('— detector: distance_milestone');
{
  const { hits } = run_stream({
    n: 125,
    dist: (i, e) => e * 5.6, // crosses 10 km at ~30 min, 20 km at ~60 min
  });
  const miles = hits.filter((h) => h.trigger === 'distance_milestone');
  check('10 km + 20 km milestones fire once each', miles.length === 2, `got ${miles.length}`);
  check('first milestone facts carry 10 km', miles[0]?.facts.milestone_km === 10);
}
{
  // Rehydrated mid-ride at ~32 km: one celebration, not three.
  const state = new SessionInsightState();
  state.append({ at_ms: T0, elapsed_s: 5400, active_kcal: 800, distance_m: 32_000, current_hr: null, current_hr_zone: null, elevation_gain_m: null });
  const hit = detect_insight(state, { milestone_m: 10_000, units: 'metric' }, 'cycling');
  check('rehydrate at 32 km fires one milestone (30 km)', hit?.trigger === 'distance_milestone' && hit.facts.milestone_km === 30);
  const again = detect_insight(state, { milestone_m: 10_000, units: 'metric' }, 'cycling');
  check('…and never re-fires for crossed milestones', again?.trigger !== 'distance_milestone');
}
{
  const { hits } = run_stream({ n: 30, dist: (i, e) => e * 5.6 }, { milestone: 5 });
  check('custom 5 km interval honored', hits.filter((h) => h.trigger === 'distance_milestone').length >= 1);
}
{
  // Imperial: default-5-mile milestone, facts keyed in miles, spoken
  // fallback says "miles".
  const { hits } = run_stream({ n: 50, dist: (i, e) => e * 5.6 }, { milestone: 5, units: 'imperial' });
  const mi = hits.filter((h) => h.trigger === 'distance_milestone');
  check('imperial milestone fires once at 5 mi (8047 m)', mi.length === 1, `got ${mi.length}`);
  check('imperial facts keyed in miles', mi[0]?.facts.milestone_mi === 5, JSON.stringify(mi[0]?.facts));
  check('imperial fallback speaks miles', mi[0]?.fallback.includes('5 miles down') === true, mi[0]?.fallback);
}

console.log('— detector: longest_this_month');
{
  const { hits } = run_stream(
    { n: 50, step_s: 30 }, // crosses 1200s at sample 40
    { history_longest_s: 1200 },
  );
  const longest = hits.filter((h) => h.trigger === 'longest_this_month');
  check('fires once when elapsed passes the 30-day longest', longest.length === 1, `got ${longest.length}`);
  check('facts carry the prior baseline (20 min)', longest[0]?.facts.prior_longest_min === 20);
}
{
  const { hits } = run_stream({ n: 50 }, { history_longest_s: 300 });
  check('a sub-10-min history baseline never fires', hits.filter((h) => h.trigger === 'longest_this_month').length === 0);
}

console.log('— detector: hr_drift');
{
  // 35 min steady pace; HR 140 for 20 min then ramping to ~154.
  const { hits } = run_stream({
    n: 70,
    dist: (i, e) => e * 5.5,
    hr: (i, e) => (e < 1200 ? 140 : 140 + Math.min(14, (e - 1200) / 40)),
    zone: () => 3,
  });
  const drift = hits.filter((h) => h.trigger === 'hr_drift');
  check('steady-pace HR climb fires drift exactly once', drift.length === 1, `got ${drift.length}`);
  const d = drift[0];
  check('drift facts are plausible (≥8 bpm)', typeof d?.facts.drift_bpm === 'number' && (d.facts.drift_bpm as number) >= 8);
}

console.log('— detector: cooldown_detected');
{
  // 25 min hard (HR 160, 5.5 m/s) then 8 min easy (HR 130, 3.0 m/s).
  const hard_end = 1500;
  const { hits } = run_stream({
    n: 66,
    dist: (i, e) => (e <= hard_end ? e * 5.5 : hard_end * 5.5 + (e - hard_end) * 3.0),
    hr: (i, e) => (e <= hard_end ? 160 : 130),
    zone: () => 3,
  });
  const cool = hits.filter((h) => h.trigger === 'cooldown_detected');
  check('sustained ease-off fires cooldown exactly once', cool.length === 1, `got ${cool.length}`);
}

console.log('— detector: pace_change');
{
  // 15 min at 5 m/s then 6 min at 7 m/s.
  const { hits } = run_stream({
    n: 42,
    dist: (i, e) => (e <= 900 ? e * 5.0 : 900 * 5.0 + (e - 900) * 7.0),
  });
  const pace = hits.filter((h) => h.trigger === 'pace_change');
  check('sustained surge fires pace_change', pace.length >= 1, `got ${pace.length}`);
  check('direction is faster', pace[0]?.facts.direction === 'faster');
  check('internal cooldown holds it to one in 6 min', pace.length === 1, `got ${pace.length}`);
}

console.log('— detector: climbing / climb_crested');
{
  // 8 min flat, then a 12-min climb at 10 m/min, then flat to the end.
  const climb_start = 480;
  const climb_end = 1200;
  const gain = (e: number) =>
    e <= climb_start ? 2 : e <= climb_end ? 2 + ((e - climb_start) / 60) * 10 : 2 + ((climb_end - climb_start) / 60) * 10;
  const { hits } = run_stream({
    n: 60,
    dist: (i, e) => e * 4.0,
    gain: (i, e) => gain(e),
  });
  const climbs = hits.filter((h) => h.trigger === 'climbing');
  const crests = hits.filter((h) => h.trigger === 'climb_crested');
  check('sustained 10 m/min grade fires climbing exactly once', climbs.length === 1, `got ${climbs.length}`);
  check('climbing facts carry segment gain ≥40 m', typeof climbs[0]?.facts.segment_gain_m === 'number' && (climbs[0]?.facts.segment_gain_m as number) >= 40);
  check('leveling off fires climb_crested exactly once', crests.length === 1, `got ${crests.length}`);
  check('crest segment gain ≈ the 120 m climbed', typeof crests[0]?.facts.segment_gain_m === 'number' && Math.abs((crests[0]?.facts.segment_gain_m as number) - 120) <= 25, `got ${String(crests[0]?.facts.segment_gain_m)}`);
}
{
  // Rolling terrain that never sustains the rate ⇒ silence.
  const { hits } = run_stream({
    n: 60,
    dist: (i, e) => e * 4.0,
    gain: (i, e) => Math.floor(e / 300) * 8, // ~1.6 m/min long-run average
  });
  const noise = hits.filter((h) => h.trigger === 'climbing' || h.trigger === 'climb_crested');
  check('gentle rollers stay silent', noise.length === 0, `got ${noise.map((h) => h.trigger).join(',')}`);
}
{
  // No elevation signal at all ⇒ the machine never engages (conservatism).
  const { hits, state } = run_stream({ n: 60, dist: (i, e) => e * 4.0 });
  check('no elevation ⇒ no climb cues', hits.every((h) => h.trigger !== 'climbing' && h.trigger !== 'climb_crested'));
  check('climb machine stays idle without signal', state.climb_phase === 'idle');
}
{
  // hr_drift suppression mid-climb: same drift-shaped HR ramp as the
  // hr_drift case, but with a sustained climb under it — the care cue
  // must NOT fire while the machine says climbing (the grade explains
  // the HR), and the climb cues fire instead.
  const { hits } = run_stream({
    n: 70,
    dist: (i, e) => e * 5.5,
    hr: (i, e) => (e < 1200 ? 140 : 140 + Math.min(14, (e - 1200) / 40)),
    zone: () => 3,
    gain: (i, e) => (e / 60) * 8, // climbing the whole ride
  });
  const drift = hits.filter((h) => h.trigger === 'hr_drift');
  check('hr_drift suppressed while climbing', drift.length === 0, `got ${drift.length}`);
  check('climbing fired instead', hits.some((h) => h.trigger === 'climbing'));
}

console.log('— ride naming (fallback + grounding)');
{
  const base = {
    user_display: 'Jasper',
    workout_type: 'cycling',
    local_start: 'Tuesday 18:42',
    time_of_day: time_of_day_label(18),
    duration_min: 106,
    distance: 36.9,
    distance_unit: 'km' as const,
    avg_speed: 20.9,
    speed_unit: 'km/h' as const,
    active_kcal: 995,
    avg_hr: 148,
    max_hr: 171,
    elevation_gain: 412,
    elevation_unit: 'm' as const,
    avg_power_w: 165,
    power_band: power_band_label(165),
    hr_zone_minutes: { z2: 30, z3: 55, z4: 21 },
    weather: { current_temperature_f: 78, current_condition: 'Clear', forecast_summary: null },
    route_notes: ['Lookout Mountain Rd'],
    records_broken: [],
  };
  check('time_of_day buckets: 18h is golden hour', time_of_day_label(18) === 'golden hour');
  check('time_of_day buckets: 5h is dawn', time_of_day_label(5) === 'dawn');
  check('power bands: 165 W reads tempo', power_band_label(165) === 'tempo');
  check('power bands: null power ⇒ null band', power_band_label(null) === null);
  const fb = fallback_ride_name(base);
  check('fallback name carries distance + gain + kcal', fb.includes('36.9 km') && fb.includes('412 m up') && fb.includes('995 kcal'), fb);
  // No LLM ⇒ deterministic fallback, rendered=false.
  const named = await generate_ride_name(undefined, base);
  check('no-LLM naming falls back deterministically', named.rendered === false && named.name === fb);
  // Grounding sanity on the naming evidence: a fabricated 42 km must
  // fail; the real numbers must pass.
  check('naming evidence grounds its own numbers', numbers_grounded('36.9 km at golden hour, 412 meters climbed', base));
  check('fabricated distance is rejected', !numbers_grounded('A 42 km epic into the night', base));
}

console.log('— motion: stop/resume + suppression (the stoplight class)');
{
  // 21 min riding hard, 4 min stopped (HR drops — pre-fix this is a
  // textbook cooldown false-fire), then rolling again.
  const stop_from = 1260;
  const resume_at = 1500;
  const { hits, state } = run_stream({
    n: 58,
    dist: (i, e) => (e <= stop_from ? e * 5 : e <= resume_at ? stop_from * 5 : stop_from * 5 + (e - resume_at) * 5),
    hr: (i, e) => (e <= stop_from ? 150 : e <= resume_at ? 120 : 140),
    zone: (i, e) => (e <= stop_from ? 3 : e <= resume_at ? 2 : 3),
  });
  check('a 4-min stop never reads as cooldown', hits.every((h) => h.trigger !== 'cooldown_detected'), hits.map((h) => h.trigger).join(','));
  check('no pace/zone cues while parked', hits.every((h) => h.trigger !== 'pace_change' && h.trigger !== 'zone_shift'), hits.map((h) => h.trigger).join(','));
  const rolling = hits.filter((h) => h.trigger === 'back_rolling');
  check('back_rolling fires once on the resume edge', rolling.length === 1, `got ${rolling.length}`);
  check('back_rolling knows the stop length (~4 min)', typeof rolling[0]?.facts.stopped_min === 'number' && (rolling[0].facts.stopped_min as number) >= 3 && (rolling[0].facts.stopped_min as number) <= 5, JSON.stringify(rolling[0]?.facts));
  check('stop bookkeeping: one stop counted', state.stops_count === 1, `got ${state.stops_count}`);
}
{
  // A long stop (11 min, no resume) earns exactly one care beat.
  const stop_from = 1260;
  const { hits } = run_stream({
    n: 64,
    dist: (i, e) => (e <= stop_from ? e * 5 : stop_from * 5),
    hr: (i, e) => (e <= stop_from ? 150 : 110),
    zone: (i, e) => (e <= stop_from ? 3 : 1),
  });
  const long = hits.filter((h) => h.trigger === 'long_stop');
  check('long stop earns exactly one care beat', long.length === 1 && long[0]?.cls === 'care', hits.map((h) => h.trigger).join(','));
  check('nothing else speaks while parked', hits.every((h) => h.trigger === 'long_stop'), hits.map((h) => h.trigger).join(','));
}

console.log('— steady_state');
{
  const { hits } = run_stream({
    n: 66,
    dist: (i, e) => e * 4,
    hr: () => 130,
    zone: () => 2,
  });
  const steady = hits.filter((h) => h.trigger === 'steady_state');
  check('30 unbroken zone-2 minutes fire once', steady.length === 1, hits.map((h) => h.trigger).join(','));
  check('steady facts carry the zone + minutes', steady[0]?.facts.zone === 2 && typeof steady[0]?.facts.minutes_at_zone === 'number', JSON.stringify(steady[0]?.facts));
}

console.log('— fastest_split');
{
  // km 1–3 at 250 s/km, km 4 at 180 s/km — a clear session-best split.
  const { hits } = run_stream(
    {
      n: 36,
      dist: (i, e) => (e <= 750 ? e * 4 : 3000 + (e - 750) * (1000 / 180)),
    },
    { units: 'metric' },
  );
  const splits = hits.filter((h) => h.trigger === 'fastest_split');
  check('a clear best split fires', splits.length === 1, hits.map((h) => h.trigger).join(','));
  check('split facts: km 4 at 20 km/h', splits[0]?.facts.split_index === 4 && splits[0]?.facts.split_speed_kmh === 20, JSON.stringify(splits[0]?.facts));
}

console.log('— numeric grounding');
{
  const evidence = {
    live: { elapsed_min: 91, active_kcal: 869, distance_km: 31.4, current_hr: 142, pace_s_per_km: 180 },
    why_now: { distance_m: 31_400 },
  };
  check('evidence numbers pass', numbers_grounded('91 minutes in, 869 kcal, HR 142.', evidence));
  check('derived km from meters passes', numbers_grounded('31.4 k down — about 31 k of work.', evidence));
  check('derived km/h from pace passes', numbers_grounded('Holding 20 km an hour.', evidence));
  check('derived mph from pace passes', numbers_grounded('Holding 12.4 mph.', evidence));
  // The 2026-06-12 incident: a fabricated number SPELLED OUT IN WORDS
  // carried no digits, so grounding passed trivially. Words are
  // first-class now.
  check('word-number fabrication rejects ("one hundred seventy point five")',
    !numbers_grounded('I pushed one hundred seventy-point-five miles across the map', evidence));
  check('word-number that matches evidence passes ("thirty-one point four")',
    numbers_grounded('thirty-one point four k of work', evidence));
  check('derived miles from meters passes', numbers_grounded('19.5 down so far.', evidence));
  check('fabricated figure rejects', !numbers_grounded('That beats your record of 1500 kcal.', evidence));
  check('small ints exempt (zones, counts)', numbers_grounded('Zone 4 for 5 more minutes.', evidence));
  check('no numbers always passes', numbers_grounded('Strong and steady. Keep it rolling.', evidence));
}

console.log('— render_cue fail-open');
{
  const mock_llm = (reply: string | Error): LLMRouter =>
    ({
      for_role: () => ({
        provider: {
          complete: async () => {
            if (reply instanceof Error) throw reply;
            return { content: reply };
          },
        },
        defaults: {},
        model: 'mock',
      }),
    }) as unknown as LLMRouter;

  const input = {
    trigger: 'distance_milestone',
    user_display: 'Jasper',
    workout_type: 'cycling',
    snapshot: { elapsed_min: 33, active_kcal: 310, distance_km: 10.2, current_hr: 138, current_hr_zone: 2 },
    facts: { milestone_km: 10, elapsed_min: 33 },
  };
  const good = await render_cue(mock_llm('**10 k down** in 33 minutes — "smooth riding."'), input);
  check('good reply returned + sanitized (markdown/quotes stripped)', good === '10 k down in 33 minutes — smooth riding.', JSON.stringify(good));
  const fabricated = await render_cue(mock_llm('10 k down — faster than your 95 minute record!'), input);
  check('fabricated-number reply → null (fallback)', fabricated === null, JSON.stringify(fabricated));
  const thrown = await render_cue(mock_llm(new Error('boom')), input);
  check('throwing provider → null (fallback)', thrown === null);
  const long = await render_cue(mock_llm('word '.repeat(120)), input);
  check('over-length reply → null (fallback)', long === null);
}

console.log('— voice clip synthesis (mocked TTS + transcode)');
const work_dir = mkdtempSync(resolve(tmpdir(), 'astrid-insight-'));
{
  // Minimal valid WAV: RIFF/WAVE + fmt (byte_rate 128) + a 256-byte
  // data chunk ⇒ 2.0 s. Padded past synthesize's 128-byte junk floor.
  const wav = new Uint8Array(44 + 256);
  const dv = new DataView(wav.buffer);
  const put = (off: number, s: string) => { for (let i = 0; i < s.length; i += 1) wav[off + i] = s.charCodeAt(i); };
  put(0, 'RIFF'); dv.setUint32(4, 36 + 256, true); put(8, 'WAVE');
  put(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 24_000, true); dv.setUint32(28, 128, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  put(36, 'data'); dv.setUint32(40, 256, true);

  check('wav_duration_s parses the header (2.0 s)', wav_duration_s(wav) === 2);

  // Streamed WAV (the live forza shape): data size 0xFFFFFFFF —
  // duration must come from the bytes actually received, never the
  // placeholder (pre-fix this read as 89478.5 s).
  const streamed = new Uint8Array(wav);
  new DataView(streamed.buffer).setUint32(40, 0xffffffff, true);
  check('streamed-WAV placeholder size falls back to real bytes (2.0 s)', wav_duration_s(streamed) === 2);
  check('speechify strips markdown + degrees', speechify('**Nice!** 72 °F out') === 'Nice! 72 degrees out');

  _test_set_tts_transport(async () => wav.buffer as ArrayBuffer);
  _test_set_transcoder(async (_wav_path, out_base) => {
    const path = `${out_base}.caf`;
    writeFileSync(path, new Uint8Array(2048));
    return { path, format: 'opus_caf' };
  });
  const clip = await synthesize_cue_clip({
    text: 'Ten k down. Keep it rolling.',
    clip_id: 'wc_testclip0001',
    out_dir: join(work_dir, 'jasper'),
    tts_base_url: 'http://mock-tts',
  });
  check('clip synthesized (opus_caf, 2048 bytes, 2.0 s)',
    clip?.format === 'opus_caf' && clip.bytes === 2048 && clip.duration_s === 2 && existsSync(clip.file_path),
    JSON.stringify(clip));

  _test_set_tts_transport(async () => { throw new Error('tts down'); });
  const failed = await synthesize_cue_clip({
    text: 'x',
    clip_id: 'wc_testclip0002',
    out_dir: join(work_dir, 'jasper'),
    tts_base_url: 'http://mock-tts',
  });
  check('TTS failure → null (text-only degrade)', failed === null);
}

console.log('— cue store + TTL sweep + routes');
{
  const db_path = join(work_dir, 'test.db');
  const db = open_db(db_path);
  const store = new WorkoutCueStore(db);

  const fresh_file = join(work_dir, 'jasper', 'wc_fresh.caf');
  mkdirSync(join(work_dir, 'jasper'), { recursive: true });
  writeFileSync(fresh_file, new Uint8Array(64));
  const old_file = join(work_dir, 'jasper', 'wc_old.caf');
  writeFileSync(old_file, new Uint8Array(64));

  store.insert({
    clip_id: 'wc_fresh', session_id: 'S1', user_id: 'jasper',
    ts: new Date().toISOString(), trigger_id: 'distance_milestone',
    text: 'fresh', format: 'opus_caf', duration_s: 2, bytes: 64, file_path: fresh_file,
  });
  store.insert({
    clip_id: 'wc_old', session_id: 'S0', user_id: 'jasper',
    ts: new Date(Date.now() - CLIP_TTL_MS - 60_000).toISOString(), trigger_id: 'check_in',
    text: 'old', format: 'opus_caf', duration_s: 2, bytes: 64, file_path: old_file,
  });
  check('store round-trips a record', store.get('wc_fresh')?.text === 'fresh');
  const swept = store.sweep();
  check('sweep deletes only the expired clip (row + file)',
    swept === 1 && store.get('wc_old') === null && !existsSync(old_file) && existsSync(fresh_file) && store.get('wc_fresh') !== null);

  // In-process router with a stubbed auth layer.
  const memory_stub = { log_action: () => 'audit_stub' } as unknown as MemoryClientType;
  const events_stub = { emit: () => {}, subscribe: () => () => {} } as unknown as AppEventBus;
  const tracker = new WorkoutSessionTracker();
  const router = create_workout_router({
    db, vault_root: work_dir, memory: memory_stub, events: events_stub, tracker,
  });
  const as_user = (id: string, display: string) => {
    const app = new Hono();
    const user = UserConfigSchema.parse({
      id, display_name: display, allowed_specialists: '*',
      timezone: 'America/Denver', notification_config_ref: 'default',
    });
    app.use('*', async (c, next) => {
      c.set('user', user);
      await next();
    });
    app.route('/', router);
    return app;
  };
  const jasper = as_user('jasper', 'Jasper');
  const sam = as_user('sam', 'Sam');

  const owner_get = await jasper.request('/cues/wc_fresh');
  check('owner fetches their clip (200, audio/x-caf)',
    owner_get.status === 200 && owner_get.headers.get('content-type') === 'audio/x-caf',
    `status ${owner_get.status}`);
  const etag = owner_get.headers.get('etag') ?? '';
  const cached = await jasper.request('/cues/wc_fresh', { headers: { 'if-none-match': etag } });
  check('etag revalidation → 304', cached.status === 304, `status ${cached.status}`);
  const cross = await sam.request('/cues/wc_fresh');
  check('another user gets 404 (cordon, no existence leak)', cross.status === 404, `status ${cross.status}`);
  const missing = await jasper.request('/cues/wc_nope');
  check('unknown clip → 404', missing.status === 404);

  // Mute lifecycle.
  db.prepare(
    `INSERT INTO workout_sessions (session_id, user_id, workout_type, started_at, status)
     VALUES ('S1', 'jasper', 'cycling', @t, 'active'), ('S2', 'sam', 'cycling', @t, 'active')`,
  ).run({ '@t': new Date().toISOString() });

  const mute = await jasper.request('/cues/mute', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  });
  const mute_body = (await mute.json()) as { muted: boolean; sessions: number };
  check('mute (no session_id) hits caller active sessions only',
    mute.status === 200 && mute_body.muted === true && mute_body.sessions === 1,
    JSON.stringify(mute_body));
  const flags = db.prepare('SELECT session_id, cues_muted FROM workout_sessions ORDER BY session_id').all() as Array<{ session_id: string; cues_muted: number | null }>;
  check('cues_muted set on S1, untouched on S2',
    flags.find((f) => f.session_id === 'S1')?.cues_muted === 1 &&
      (flags.find((f) => f.session_id === 'S2')?.cues_muted ?? null) === null,
    JSON.stringify(flags));

  const unmute = await jasper.request('/cues/mute', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'S1', muted: false }),
  });
  check('unmute by session_id', unmute.status === 200 &&
    (db.prepare("SELECT cues_muted FROM workout_sessions WHERE session_id = 'S1'").get() as { cues_muted: number }).cues_muted === 0);

  const foreign = await jasper.request('/cues/mute', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'S2' }),
  });
  check('muting someone else\'s session → 404', foreign.status === 404, `status ${foreign.status}`);

  console.log('— ride log: heartbeat series + sessions API');

  // Full packet flow with elevation + power + route descriptors.
  const t_start = new Date('2026-06-10T18:30:00.000Z');
  const post = (body: unknown) =>
    jasper.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  const started = await post({
    session_id: 'RIDE1', kind: 'start', captured_at: t_start.toISOString(),
    payload: { workout_type: 'cycling' },
  });
  check('start packet accepted', started.status === 200, `status ${started.status}`);
  for (let i = 1; i <= 4; i += 1) {
    const hb = await post({
      session_id: 'RIDE1', kind: 'heartbeat',
      captured_at: new Date(t_start.getTime() + i * 30_000).toISOString(),
      payload: {
        elapsed_s: i * 30, active_kcal: i * 8, distance_m: i * 180,
        current_hr: 140 + i, current_hr_zone: 3, elevation_gain_m: i * 12,
      },
    });
    check(`heartbeat ${i} accepted (with elevation)`, hb.status === 200, `status ${hb.status}`);
  }
  const dup = await post({
    session_id: 'RIDE1', kind: 'heartbeat',
    captured_at: new Date(t_start.getTime() + 4 * 30_000).toISOString(),
    payload: { elapsed_s: 120, active_kcal: 32, distance_m: 720, current_hr: 144, current_hr_zone: 3, elevation_gain_m: 48 },
  });
  check('duplicate heartbeat replaces, not duplicates', dup.status === 200);
  // Device autopause: a paused heartbeat (frozen elapsed) must warm the
  // row's paused flag — the pane + throttle read it.
  const paused_hb = await post({
    session_id: 'RIDE1', kind: 'heartbeat',
    captured_at: new Date(t_start.getTime() + 5 * 30_000).toISOString(),
    payload: {
      elapsed_s: 4 * 30, active_kcal: 4 * 8, distance_m: 4 * 180,
      current_hr: 144, current_hr_zone: 3, elevation_gain_m: 4 * 12, paused: true,
    },
  });
  check('paused heartbeat accepted', paused_hb.status === 200, `status ${paused_hb.status}`);
  const paused_row = db.prepare("SELECT paused FROM workout_sessions WHERE session_id = 'RIDE1'").get() as { paused: number | null };
  check('paused flag warmed on the session row', paused_row.paused === 1, JSON.stringify(paused_row));

  const ended = await post({
    session_id: 'RIDE1', kind: 'end',
    captured_at: new Date(t_start.getTime() + 150_000).toISOString(),
    payload: {
      workout_type: 'cycling', duration_s: 150, active_kcal: 41,
      total_distance_m: 900, avg_hr: 142, max_hr: 151,
      elevation_gain_m: 55, avg_power_w: 168, route_notes: ['Lookout Mountain Rd'],
    },
  });
  check('end packet with elevation/power/route accepted', ended.status === 200, `status ${ended.status}`);

  const hb_rows = db.prepare("SELECT COUNT(*) AS n FROM workout_heartbeats WHERE session_id = 'RIDE1'").get() as { n: number };
  check('heartbeat series persisted (4 rows, dedup on elapsed_s)', hb_rows.n === 4, `got ${hb_rows.n}`);

  // duration floor: RIDE1 is 150s ≥ default 120s, so it lists; the
  // sub-floor phantom must not.
  db.prepare(
    `INSERT INTO workout_sessions (session_id, user_id, workout_type, started_at, ended_at, total_duration_s, status)
     VALUES ('PHANTOM', 'jasper', 'walking', @t, @t, 40, 'completed')`,
  ).run({ '@t': t_start.toISOString() });

  const list = await jasper.request('/sessions');
  const list_body = (await list.json()) as { sessions: Array<{ session_id: string; elevation_gain_m: number | null; avg_power_w: number | null; avg_speed_kmh: number | null; route_notes: string[] | null }> };
  const ride = list_body.sessions.find((s) => s.session_id === 'RIDE1');
  check('sessions list returns the completed ride', list.status === 200 && !!ride, JSON.stringify(list_body).slice(0, 200));
  check('list excludes sub-floor phantom sessions', !list_body.sessions.some((s) => s.session_id === 'PHANTOM'));
  check('list carries elevation + power + derived speed + route',
    ride?.elevation_gain_m === 55 && ride?.avg_power_w === 168 && ride?.avg_speed_kmh != null && ride?.route_notes?.[0] === 'Lookout Mountain Rd',
    JSON.stringify(ride));

  const detail = await jasper.request('/sessions/RIDE1');
  const detail_body = (await detail.json()) as { session: { session_id: string }; series: Array<{ elapsed_s: number; elevation_gain_m: number | null }>; cues: unknown[] };
  check('session detail returns the series in order',
    detail.status === 200 && detail_body.series.length === 4 && detail_body.series[0]?.elapsed_s === 30 && detail_body.series[3]?.elevation_gain_m === 48,
    JSON.stringify(detail_body.series ?? []).slice(0, 160));
  const detail_cross = await sam.request('/sessions/RIDE1');
  check('someone else\'s session detail → 404 (cordon)', detail_cross.status === 404, `status ${detail_cross.status}`);
}

console.log('— route learning: fingerprints, groups, cue ledger, ingest');
{
  const db_path = join(work_dir, 'routes.db');
  const db = open_db(db_path);
  const routes = new WorkoutRouteStore(db);

  const line = (lat0: number, n: number, lat_step = 0.001, lon = -104.97) =>
    Array.from({ length: n }, (_, i) => ({
      t: new Date(T0 + i * 60_000).toISOString(),
      lat: lat0 + i * lat_step,
      lon,
    }));

  // Sessions to join routes against (group_stats reads durations + names).
  db.prepare(
    `INSERT INTO workout_sessions (session_id, user_id, workout_type, started_at, status, total_duration_s, ride_name)
     VALUES ('R_A', 'jasper', 'cycling', '2026-06-01T01:00:00Z', 'completed', 3000, 'Foothills out-and-back'),
            ('R_B', 'jasper', 'cycling', '2026-06-05T01:00:00Z', 'completed', 2880, NULL),
            ('R_C', 'jasper', 'cycling', '2026-06-08T01:00:00Z', 'completed', 1500, NULL)`,
  ).run();

  const a = routes.upsert({ session_id: 'R_A', user_id: 'jasper', points: line(39.72, 30) });
  const b = routes.upsert({ session_id: 'R_B', user_id: 'jasper', points: line(39.7201, 30) });
  const c = routes.upsert({ session_id: 'R_C', user_id: 'jasper', points: line(40.7, 18) });
  check('same path groups together', b.route_group_id === a.route_group_id, `${a.route_group_id} vs ${b.route_group_id}`);
  check('different path starts its own group', c.route_group_id !== a.route_group_id);
  const stats = routes.group_stats('jasper', a.route_group_id);
  check('group stats: 2 rides, best 48 min, named', stats.times_ridden === 2 && stats.best_duration_s === 2880 && stats.name === 'Foothills out-and-back', JSON.stringify(stats));

  // Partial (live) match: the first 40% of the same path recognizes the group.
  const partial = routes.match_group(
    'jasper',
    { points: line(39.72, 12).map(({ lat, lon }) => ({ lat, lon })), length_m: 1300 },
    { partial: true },
  );
  check('partial live track recognizes the route group', partial === a.route_group_id, JSON.stringify(partial));

  // Cue ledger roundtrip.
  routes.record_cue({
    cue_id: 'cue_test1', session_id: 'R_A', user_id: 'jasper',
    ts: '2026-06-01T01:20:00Z', elapsed_s: 1200, trigger_id: 'zone_shift', cls: 'effort',
    text: 'Zone 3 now. Hold it.', reason: 'auto-trigger at elapsed=1200s', clip_id: null,
  });
  const ledger = routes.cues_for_session('R_A');
  check('cue ledger roundtrips with the WHY', ledger.length === 1 && ledger[0]?.reason === 'auto-trigger at elapsed=1200s', JSON.stringify(ledger));

  // Ingest through the real router: route POST + cordon + detail payload.
  const memory_stub2 = { log_action: () => 'audit_stub' } as unknown as MemoryClientType;
  const events_stub2 = { emit: () => {}, subscribe: () => () => {} } as unknown as AppEventBus;
  const tracker2 = new WorkoutSessionTracker();
  const router2 = create_workout_router({ db, vault_root: work_dir, memory: memory_stub2, events: events_stub2, tracker: tracker2 });
  const as_user2 = (id: string) => {
    const app = new Hono();
    const user = UserConfigSchema.parse({ id, display_name: id, allowed_specialists: '*', timezone: 'America/Denver', notification_config_ref: 'default' });
    app.use('*', async (c, next) => { c.set('user', user); await next(); });
    app.route('/', router2);
    return app;
  };
  const jason2 = as_user2('jasper');
  const sara2 = as_user2('sam');
  const route_post = await jason2.request('/', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'R_C', kind: 'route', captured_at: new Date(T0).toISOString(), payload: { points: line(40.7, 18) } }),
  });
  const route_body = (await route_post.json()) as { route_group_id?: string; point_count?: number };
  check('route ingest via the router (200, grouped)', route_post.status === 200 && route_body.route_group_id === c.route_group_id, JSON.stringify(route_body));
  const cross_route = await sara2.request('/', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'R_C', kind: 'route', captured_at: new Date(T0).toISOString(), payload: { points: line(40.7, 18) } }),
  });
  check('route upload for someone else\'s session → 404', cross_route.status === 404, `status ${cross_route.status}`);
  const detail2 = await jason2.request('/sessions/R_A');
  const detail2_body = (await detail2.json()) as { route: { points: unknown[]; route_group_id: string } | null; cues: Array<{ reason?: string | null }> };
  check('session detail carries the route + ledger cues with WHY',
    detail2.status === 200 && (detail2_body.route?.points.length ?? 0) === 30 && detail2_body.cues.length === 1 && detail2_body.cues[0]?.reason != null,
    JSON.stringify({ pts: detail2_body.route?.points.length, cues: detail2_body.cues.length }).slice(0, 120));
}

console.log('— query_workouts merge-dedup (the duplicate-rides bug)');
{
  const vault2 = join(work_dir, 'vault2');
  const db2 = open_db(join(work_dir, 'dedup.db'));
  const memory2 = new MemoryClient({ vault_root: vault2, db: db2 });
  const write_packet = (id: string, captured: string, ts_end: string, value: Record<string, unknown>) => {
    const rel = `_payloads/${id}.json`;
    mkdirSync(join(vault2, '_payloads'), { recursive: true });
    writeFileSync(join(vault2, rel), JSON.stringify({ sample_type: 'workout', ts_end, value }));
    db2.prepare(
      `INSERT INTO sensor_packets (id, user_id, device_id, signal, captured_at, received_at, payload_path)
       VALUES (@id, 'jasper', 'dev', 'healthkit', @cap, @cap, @rel)`,
    ).run({ '@id': id, '@cap': captured, '@rel': rel });
  };
  const now = new Date();
  const end_iso = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const end_iso2 = new Date(now.getTime() - 2 * 60 * 60 * 1000 + 80_000).toISOString();
  // The live path's dual-write: real kcal, no zone detail.
  write_packet('pk1', end_iso, end_iso, { workout_type: 'cycling', duration_s: 7299, active_kcal: 749.1, total_distance_m: 28130, avg_hr: 132.3, max_hr: 154 });
  // The HK post-hoc sync twin: kcal ZERO, richer HR fields.
  write_packet('pk2', end_iso2, end_iso2, { workout_type: 'cycling', duration_s: 7299.9, active_kcal: 0, total_distance_m: 28130, avg_hr: 132.3, max_hr: 154, min_hr: 105, elevation_gain_m: 320, recovery_hr_drop_1min_bpm: 18.4 });
  // A genuinely different ride the same day.
  const other_end = new Date(now.getTime() - 8 * 60 * 60 * 1000).toISOString();
  write_packet('pk3', other_end, other_end, { workout_type: 'cycling', duration_s: 3939, active_kcal: 521.2, total_distance_m: 20024, avg_hr: 139.5, max_hr: 161 });
  const rides2 = memory2.query_workouts('jasper', '7d', 20);
  check('twin rows merge to ONE ride', rides2.length === 2, `got ${rides2.length}: ${JSON.stringify(rides2.map((r) => r.duration_min))}`);
  const merged_ride = rides2.find((r) => r.duration_min === 122);
  check('merged ride keeps the REAL kcal (not the HK twin\'s zero)', merged_ride?.active_kcal === 749, JSON.stringify(merged_ride));
  check('merged ride carries the HK twin\'s elevation + recovery HR',
    merged_ride?.elevation_gain_m === 320 && merged_ride?.recovery_hr_drop_1min_bpm === 18.4 && merged_ride?.min_hr === 105,
    JSON.stringify(merged_ride));
  check('the distinct same-day ride survives', rides2.some((r) => r.duration_min === 66));
}

console.log('— stale-active guard + reaper (the stuck-overnight session)');
{
  const db3 = open_db(join(work_dir, 'stale.db'));
  const vault3 = join(work_dir, 'vault3');
  mkdirSync(vault3, { recursive: true });
  const memory3 = new MemoryClient({ vault_root: vault3, db: db3 });
  const ins = (sid: string, started: string, last: string | null) =>
    db3.prepare(
      `INSERT INTO workout_sessions (session_id, user_id, workout_type, started_at, last_packet_at, status, elapsed_s, distance_m)
       VALUES (@s, 'jasper', 'cycling', @start, @last, 'active', 30, 55)`,
    ).run({ '@s': sid, '@start': started, '@last': last });

  const fresh = new Date(Date.now() - 60_000).toISOString();        // 1 min ago — live
  const stuck = new Date(Date.now() - 932 * 60_000).toISOString();  // the real incident (15.5h)
  ins('LIVE1', new Date(Date.now() - 90_000).toISOString(), fresh);
  ins('STUCK1', stuck, stuck);

  // Read guard: query_active_workout returns newest first → STUCK1 is
  // older, but with both active LIVE1 is newest. Test each in isolation.
  db3.prepare("UPDATE workout_sessions SET status='completed' WHERE session_id='LIVE1'").run();
  const only_stuck = memory3.query_active_workout('jasper');
  check('stuck session surfaces but is flagged stale', only_stuck?.session_id === 'STUCK1' && only_stuck?.stale === true, JSON.stringify({ id: only_stuck?.session_id, stale: only_stuck?.stale }));
  db3.prepare("UPDATE workout_sessions SET status='active' WHERE session_id='LIVE1'").run();
  // LIVE1 is newest + fresh → not stale.
  const newest = memory3.query_active_workout('jasper');
  check('a fresh active session is not stale', newest?.session_id === 'LIVE1' && newest?.stale === false, JSON.stringify({ id: newest?.session_id, stale: newest?.stale }));

  // Reaper: finalizes STUCK1 (15.5h silent) but spares LIVE1 (1 min).
  const tracker3 = new WorkoutSessionTracker();
  const reaped = reap_stale_active_sessions(db3, memory3, tracker3);
  check('reaper finalizes exactly the stale session', reaped === 1, `reaped ${reaped}`);
  const after_stuck = db3.prepare("SELECT status FROM workout_sessions WHERE session_id='STUCK1'").get() as { status: string };
  const after_live = db3.prepare("SELECT status FROM workout_sessions WHERE session_id='LIVE1'").get() as { status: string };
  check('stuck session → abandoned', after_stuck.status === 'abandoned', after_stuck.status);
  check('live session untouched (still active)', after_live.status === 'active', after_live.status);
  check('reaped session no longer surfaces as active', memory3.query_active_workout('jasper')?.session_id === 'LIVE1');
  const audit = db3.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE tool_name='workout_session_reaped'").get() as { n: number };
  check('reaper logged an audit row', audit.n === 1, `got ${audit.n}`);
}

rmSync(work_dir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  process.exit(1);
}
