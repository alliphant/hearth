/**
 * Live-workout insight detection (Live Ride Companion Phase 1 —
 * docs/design-astrid-live-companion.md §6.1).
 *
 * A per-session rolling window over heartbeat samples + deterministic
 * detectors for the moments worth speaking about. NO LLM here — this
 * module decides WHEN something is worth saying and computes the FACTS;
 * cue_render.ts decides HOW to say it (and falls back to each hit's
 * deterministic template when the render fails).
 *
 * Detector vocabulary (priority order inside detect_insight):
 *
 *   longest_this_month  — elapsed just passed the longest comparable
 *                         session in 30 days (narrative; once)
 *   zone_shift          — sustained (≥2 min) move into a different HR
 *                         zone after a zone was established (effort;
 *                         8-min internal cooldown)
 *   distance_milestone  — each N display-units crossed (default 5 mi /
 *                         10 km; progress; once per milestone — NOT
 *                         consumed when the caller suppresses, so a
 *                         throttled milestone re-offers next packet)
 *   hr_drift            — HR climbing ≥8 bpm at steady pace, ≥25 min
 *                         in (care; once)
 *   cooldown_detected   — HR well off peak + pace eased ≥20%,
 *                         sustained 4 min, ≥20 min in (wrap_up; once)
 *   pace_change         — rolling pace ≥12% off session average in
 *                         both the 5-min and 2.5-min windows (effort;
 *                         10-min internal cooldown, ≥10 min in)
 *   climbing            — sustained barometric climb: gain rate ≥6 m/min
 *                         over the trailing 4 min with ≥40 m banked this
 *                         segment (effort; once per climb segment)
 *   climb_crested       — a ≥60 m climb segment leveled off (gain rate
 *                         flat ≥2 min) (narrative; once per segment).
 *                         Elevation also SUPPRESSES hr_drift while a
 *                         climb is in progress — rising HR on a grade is
 *                         the grade, not dehydration; "take a drink"
 *                         mid-climb is a wrong cue.
 *
 * negative_split_possible from the design doc is deliberately NOT
 * implemented: without a known planned distance/duration the "half"
 * anchor is a guess, and a wrong "you can negative-split this" is the
 * same embarrassment class as the 30-second "Halfway through" bug.
 * Revisit when planned_duration_min adoption is real.
 *
 * Conservatism rule for every detector: when a needed signal is absent
 * (no HR, no distance), the detector stays silent. A missed cue is
 * fine; a wrong cue mid-ride is the failure mode this design exists
 * to kill.
 */

import {
  type Units,
  dist_from_m,
  dist_unit,
  dist_unit_spoken,
  speed_from_pace_s_per_km,
  elev_from_m,
  elev_unit_spoken,
  M_PER_MI,
} from '@core/units';

export interface InsightSample {
  at_ms: number;
  elapsed_s: number;
  active_kcal: number;
  distance_m: number | null;
  current_hr: number | null;
  current_hr_zone: number | null;
  /** Cumulative (monotonic) barometric elevation gain in meters —
   *  iOS accumulates positive altimeter deltas, so descent reads as
   *  a flat gain rate, never a negative one. Null when the device
   *  doesn't report elevation. */
  elevation_gain_m: number | null;
  /** Live position when the device ships it (route recognition).
   *  Memory-only — live coordinates are never persisted or audited. */
  lat?: number | null;
  lon?: number | null;
}

export type InsightClass = 'effort' | 'progress' | 'care' | 'narrative' | 'wrap_up';

export type InsightTriggerId =
  | 'zone_shift'
  | 'distance_milestone'
  | 'pace_change'
  | 'hr_drift'
  | 'longest_this_month'
  | 'cooldown_detected'
  | 'climbing'
  | 'climb_crested'
  | 'back_rolling'
  | 'long_stop'
  | 'fastest_split'
  | 'steady_state'
  | 'route_recognized';

export interface InsightHit {
  trigger: InsightTriggerId;
  cls: InsightClass;
  /** Deterministic computed facts — feeds the render evidence AND the
   *  numeric grounding check. Numbers only as numbers. */
  facts: Record<string, number | string | null>;
  /** Deterministic fallback text (no sign-off; delivery appends it). */
  fallback: string;
}

export interface InsightConfig {
  /** Distance milestone interval in METERS — the caller converts the
   *  user's display-units knob (e.g. "every 5 miles") via dist_to_m. */
  milestone_m: number;
  /** Display units for facts + fallback text. Detector thresholds stay
   *  metric internally; only what the user sees/hears converts. */
  units: Units;
}

const WINDOW_MS = 25 * 60 * 1000;
const ZONE_SUSTAIN_MS = 2 * 60 * 1000;
const ZONE_CUE_COOLDOWN_MS = 12 * 60 * 1000;
const PACE_CUE_COOLDOWN_MS = 10 * 60 * 1000;
const PACE_MIN_ELAPSED_S = 10 * 60;
const PACE_DELTA_PCT = 0.12;
const HR_DRIFT_BPM = 8;
const HR_DRIFT_MIN_ELAPSED_S = 25 * 60;
const HR_DRIFT_PACE_TOLERANCE = 0.06;
const COOLDOWN_MIN_ELAPSED_S = 20 * 60;
const COOLDOWN_SUSTAIN_MS = 4 * 60 * 1000;
const COOLDOWN_HR_DROP_BPM = 15;
const COOLDOWN_PACE_SLOWDOWN = 1.2;
const HISTORY_MIN_BASELINE_S = 600;
const CLIMB_WINDOW_MS = 4 * 60 * 1000;
const CLIMB_RATE_M_PER_MIN = 6;
const CLIMB_FIRE_SEGMENT_GAIN_M = 40;
const CREST_FLAT_RATE_M_PER_MIN = 1.5;
const CREST_FLAT_SUSTAIN_MS = 2 * 60 * 1000;
const CREST_FIRE_SEGMENT_GAIN_M = 60;

// ── Motion / stop detection (2026-06-12 — the stoplight class) ───────
// Today's ride fired pace_change at stoplights ("1.9 mph, relax your
// shoulders") and zone cues on recovery dips at stops. A stopped rider
// gets SILENCE (plus one care beat on a long stop, and a back-rolling
// beat on resume) — never effort coaching.
const STOP_SPEED_M_S = 0.9;          // below ~2 mph reads as stopped
const RESUME_SPEED_M_S = 1.8;        // ~4 mph reads as rolling again
const STOP_CONFIRM_MS = 60 * 1000;   // two quiet packets confirm a stop
const BACK_ROLLING_MIN_STOP_S = 120; // shorter stops resume silently
const LONG_STOP_S = 600;             // 10 min parked → one care beat
const PACE_SLOWER_FLOOR_M_S = 2.0;   // 'slower' below this is a stop, not a pace
const ZONE_CUE_SESSION_CAP = 3;      // zone oscillation burned 4 cues on 2026-06-12
const SPLIT_MIN_INDEX = 3;           // no fastest-split talk before mile/km 3
const SPLIT_IMPROVE_PCT = 0.97;      // ≥3% quicker to count as a new best
const SPLIT_CUE_CAP = 2;
const STEADY_STATE_S = 30 * 60;      // 30 unbroken minutes in one zone
const CURVE_CHUNK_S = 600;           // 10-min session-curve chunks
const CURVE_CHUNK_CAP = 12;

export class SessionInsightState {
  samples: InsightSample[] = [];
  established_zone: number | null = null;
  zone_candidate: { zone: number; since_ms: number } | null = null;
  last_zone_cue_at_ms: number | null = null;
  last_pace_cue_at_ms: number | null = null;
  /** One-shot triggers + per-milestone keys that already fired. */
  fired: Set<string> = new Set();
  cooldown_candidate_since_ms: number | null = null;
  /** Peak rolling-5-min average HR seen this session (cooldown anchor). */
  peak_hr_5min: number | null = null;
  /** Longest comparable (same workout_type) session in the last 30 days,
   *  seconds. Loaded ONCE by the caller (IO stays out of the detector);
   *  null = none / not comparable. */
  history_longest_s: number | null = null;
  history_loaded = false;
  /** A cue is mid-render/synthesis — skip evaluation until it lands. */
  inflight = false;
  /** First mute suppression already logged (keeps the log terse). */
  mute_logged = false;
  /** Climb segment state machine. `idle` until a sustained gain rate
   *  opens a segment; back to `idle` when the rate flattens long
   *  enough to call the climb over. */
  climb_phase: 'idle' | 'climbing' = 'idle';
  /** Cumulative gain (m) when the current segment opened. */
  climb_segment_start_gain = 0;
  /** The `climbing` cue already fired for this segment. */
  climb_fired = false;
  /** Gain rate has been flat since this timestamp (crest candidate). */
  climb_flat_since_ms: number | null = null;
  // ── Motion / stops ──
  motion_phase: 'unknown' | 'moving' | 'stopped' = 'unknown';
  stop_candidate_since_ms: number | null = null;
  stopped_since_ms: number | null = null;
  stops_count = 0;
  stopped_total_s = 0;
  long_stop_fired = false;
  // ── Zone-cue damping ──
  zone_cue_count = 0;
  // ── Fastest split ──
  last_split_index = 0;
  last_split_elapsed_s = 0;
  best_split_s: number | null = null;
  split_cue_count = 0;
  // ── Steady-state zone block ──
  zone_block_zone: number | null = null;
  zone_block_since_s: number | null = null;
  // ── Session curve (10-min chunks, capped — render evidence) ──
  chunk_anchor: { elapsed_s: number; distance_m: number; gain_m: number } | null = null;
  chunk_hr_sum = 0;
  chunk_hr_n = 0;
  chunks: Array<{ start_min: number; end_min: number; avg_hr: number | null; distance_m: number; gain_m: number }> = [];
  // ── 30-day comparables (loaded once by the caller) ──
  history_rides_30d: number | null = null;
  history_distance_m_30d: number | null = null;
  /** Live route recognition result (set by the caller once matched) —
   *  rides into every subsequent render's evidence. */
  recognized_route: { name: string | null; times_ridden: number; best_min: number | null; group_id: string } | null = null;

  append(s: InsightSample): void {
    this.samples.push(s);
    const cutoff = s.at_ms - WINDOW_MS;
    while (this.samples.length > 0 && this.samples[0]!.at_ms < cutoff) {
      this.samples.shift();
    }
  }
}

function latest(state: SessionInsightState): InsightSample | null {
  return state.samples[state.samples.length - 1] ?? null;
}

/** Average HR over samples whose at_ms falls in [now-from_ago, now-to_ago].
 *  Needs ≥2 HR-bearing samples; null otherwise. */
function avg_hr_window(state: SessionInsightState, now_ms: number, from_ago_ms: number, to_ago_ms: number): number | null {
  const lo = now_ms - from_ago_ms;
  const hi = now_ms - to_ago_ms;
  let sum = 0;
  let n = 0;
  for (const s of state.samples) {
    if (s.at_ms >= lo && s.at_ms <= hi && s.current_hr != null) {
      sum += s.current_hr;
      n += 1;
    }
  }
  return n >= 2 ? sum / n : null;
}

/** Rolling pace (s/km) over the trailing window. Needs ≥200 m and ≥60 s
 *  of movement inside the window; null otherwise. */
function pace_over_window(state: SessionInsightState, now_ms: number, window_ms: number): number | null {
  const last = latest(state);
  if (!last || last.distance_m == null) return null;
  const cutoff = now_ms - window_ms;
  let first: InsightSample | null = null;
  for (const s of state.samples) {
    if (s.at_ms >= cutoff && s.distance_m != null) {
      first = s;
      break;
    }
  }
  if (!first || first === last) return null;
  const dd_m = last.distance_m - (first.distance_m ?? 0);
  const dt_s = last.elapsed_s - first.elapsed_s;
  if (dd_m < 200 || dt_s < 60) return null;
  return dt_s / (dd_m / 1000);
}

function session_pace(last: InsightSample): number | null {
  if (last.distance_m == null || last.distance_m < 1000 || last.elapsed_s < 60) return null;
  return last.elapsed_s / (last.distance_m / 1000);
}

/** Gain-accumulation rate (m/min) over the trailing window. Needs
 *  elevation-bearing samples spanning at least half the window; null
 *  otherwise. The input is monotonic (positive-delta accumulation on
 *  the device), so descent reads as ~0, never negative. */
function gain_rate_m_per_min(state: SessionInsightState, now_ms: number, window_ms: number): number | null {
  const cutoff = now_ms - window_ms;
  let first: InsightSample | null = null;
  let last: InsightSample | null = null;
  for (const s of state.samples) {
    if (s.elevation_gain_m == null || s.at_ms < cutoff) continue;
    if (!first) first = s;
    last = s;
  }
  if (!first || !last || first === last) return null;
  const dt_min = (last.at_ms - first.at_ms) / 60_000;
  if (dt_min < window_ms / 60_000 / 2) return null;
  return ((last.elevation_gain_m ?? 0) - (first.elevation_gain_m ?? 0)) / dt_min;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Speed (m/s) from the trailing two distance-bearing samples. Falls
 *  back to wall-clock dt when elapsed is frozen (device autopause). */
function recent_speed_m_s(state: SessionInsightState): number | null {
  const with_dist = state.samples.filter((x) => x.distance_m != null);
  if (with_dist.length < 2) return null;
  const a = with_dist[with_dist.length - 2]!;
  const b = with_dist[with_dist.length - 1]!;
  const dt_elapsed = b.elapsed_s - a.elapsed_s;
  const dt = dt_elapsed > 0 ? dt_elapsed : (b.at_ms - a.at_ms) / 1000;
  if (dt <= 0) return null;
  return Math.max(0, ((b.distance_m ?? 0) - (a.distance_m ?? 0)) / dt);
}

/**
 * The stop/resume machine. Returns a hit at exactly two moments:
 * `long_stop` (once per session, 10 min parked — a care beat) and
 * `back_rolling` (on the resume edge after a ≥2-min stop). Everything
 * else about a stop is bookkeeping the caller + evidence read.
 */
function update_motion(state: SessionInsightState, last: InsightSample, elapsed_min: number): InsightHit | null {
  if (last.distance_m == null) return null;
  const speed = recent_speed_m_s(state);
  if (speed == null) return null;
  const now_ms = last.at_ms;

  if (state.motion_phase !== 'stopped') {
    if (speed < STOP_SPEED_M_S) {
      if (state.stop_candidate_since_ms == null) {
        state.stop_candidate_since_ms = now_ms;
      } else if (now_ms - state.stop_candidate_since_ms >= STOP_CONFIRM_MS) {
        state.motion_phase = 'stopped';
        state.stopped_since_ms = state.stop_candidate_since_ms;
        state.stop_candidate_since_ms = null;
        state.stops_count += 1;
        // A stop kills in-flight crest/cooldown candidates — a parked
        // bike must not read as "crested" or "winding down".
        state.climb_flat_since_ms = null;
        state.cooldown_candidate_since_ms = null;
      }
    } else {
      state.stop_candidate_since_ms = null;
      if (state.motion_phase === 'unknown' && speed >= RESUME_SPEED_M_S) {
        state.motion_phase = 'moving';
      }
    }
    return null;
  }

  // Currently stopped.
  const stopped_s = (now_ms - (state.stopped_since_ms ?? now_ms)) / 1000;
  if (speed >= RESUME_SPEED_M_S) {
    state.motion_phase = 'moving';
    state.stopped_since_ms = null;
    state.stopped_total_s += stopped_s;
    if (stopped_s >= BACK_ROLLING_MIN_STOP_S) {
      const stopped_min = Math.round(stopped_s / 60);
      return {
        trigger: 'back_rolling',
        cls: 'progress',
        facts: { stopped_min, elapsed_min, stops_count: state.stops_count },
        fallback: `Back rolling — ${stopped_min} minute${stopped_min === 1 ? '' : 's'} stopped. Ease back up to speed.`,
      };
    }
    return null;
  }
  if (!state.long_stop_fired && stopped_s >= LONG_STOP_S) {
    state.long_stop_fired = true;
    return {
      trigger: 'long_stop',
      cls: 'care',
      facts: { stopped_min: Math.round(stopped_s / 60), elapsed_min },
      fallback: `You've been stopped a while — no rush. I'm here when you roll.`,
    };
  }
  return null;
}

/** Accumulate the 10-min session-curve chunks (render evidence). */
function update_curve(state: SessionInsightState, last: InsightSample): void {
  if (!state.chunk_anchor) {
    state.chunk_anchor = { elapsed_s: last.elapsed_s, distance_m: last.distance_m ?? 0, gain_m: last.elevation_gain_m ?? 0 };
    state.chunk_hr_sum = 0;
    state.chunk_hr_n = 0;
    return;
  }
  if (last.current_hr != null) {
    state.chunk_hr_sum += last.current_hr;
    state.chunk_hr_n += 1;
  }
  if (last.elapsed_s - state.chunk_anchor.elapsed_s >= CURVE_CHUNK_S) {
    state.chunks.push({
      start_min: Math.round(state.chunk_anchor.elapsed_s / 60),
      end_min: Math.round(last.elapsed_s / 60),
      avg_hr: state.chunk_hr_n > 0 ? Math.round(state.chunk_hr_sum / state.chunk_hr_n) : null,
      distance_m: Math.max(0, (last.distance_m ?? 0) - state.chunk_anchor.distance_m),
      gain_m: Math.max(0, (last.elevation_gain_m ?? 0) - state.chunk_anchor.gain_m),
    });
    if (state.chunks.length > CURVE_CHUNK_CAP) state.chunks.shift();
    state.chunk_anchor = { elapsed_s: last.elapsed_s, distance_m: last.distance_m ?? 0, gain_m: last.elevation_gain_m ?? 0 };
    state.chunk_hr_sum = 0;
    state.chunk_hr_n = 0;
  }
}

/**
 * Evaluate the insight detectors against the session's rolling state.
 * Mutates detector state (candidates, fired sets) — call once per
 * packet, AFTER append(), and only when a cue could actually send
 * (the caller gates on throttle/mute first so a suppressed packet
 * doesn't consume a one-shot).
 */
export function detect_insight(
  state: SessionInsightState,
  cfg: InsightConfig,
  workout_type: string,
): InsightHit | null {
  const last = latest(state);
  if (!last) return null;
  const now_ms = last.at_ms;
  const elapsed_min = Math.round(last.elapsed_s / 60);
  const u = cfg.units;

  // Maintain the cooldown anchor every pass regardless of which
  // detector fires.
  const hr5 = avg_hr_window(state, now_ms, 5 * 60 * 1000, 0);
  if (hr5 != null && (state.peak_hr_5min == null || hr5 > state.peak_hr_5min)) {
    state.peak_hr_5min = hr5;
  }

  // 0. Motion machine + session curve run every pass. A STOPPED rider
  //    gets silence (long_stop excepted) — a stoplight must never read
  //    as cooldown, drift, a zone drop, or a pace change.
  const motion_hit = update_motion(state, last, elapsed_min);
  update_curve(state, last);
  if (state.motion_phase === 'stopped') return motion_hit;
  if (motion_hit) return motion_hit; // the back_rolling resume edge

  // 1. longest_this_month — narrative, once.
  if (
    !state.fired.has('longest_this_month') &&
    state.history_longest_s != null &&
    state.history_longest_s >= HISTORY_MIN_BASELINE_S &&
    last.elapsed_s > state.history_longest_s
  ) {
    state.fired.add('longest_this_month');
    const prior_min = Math.round(state.history_longest_s / 60);
    return {
      trigger: 'longest_this_month',
      cls: 'narrative',
      facts: { prior_longest_min: prior_min, elapsed_min, workout_type },
      fallback: `That makes this your longest ${workout_type} in the last month — past ${prior_min} minutes and still rolling.`,
    };
  }

  // 2. climbing / climb_crested — barometric climb segment machine.
  //    Runs every pass (it must observe flat stretches to close a
  //    segment); returns a hit only at the two transition moments.
  if (last.elevation_gain_m != null) {
    const rate = gain_rate_m_per_min(state, now_ms, CLIMB_WINDOW_MS);
    if (state.climb_phase === 'idle') {
      if (rate != null && rate >= CLIMB_RATE_M_PER_MIN) {
        state.climb_phase = 'climbing';
        // Anchor at the gain when the rate window opened, so segment
        // gain counts the whole grade, not just the part after the
        // 4-min confirmation lag.
        const window_start = now_ms - CLIMB_WINDOW_MS;
        const anchor = state.samples.find((s) => s.elevation_gain_m != null && s.at_ms >= window_start);
        state.climb_segment_start_gain = anchor?.elevation_gain_m ?? last.elevation_gain_m;
        state.climb_fired = false;
        state.climb_flat_since_ms = null;
      }
    } else {
      const segment_gain = Math.max(0, last.elevation_gain_m - state.climb_segment_start_gain);
      if (rate != null && rate >= CLIMB_RATE_M_PER_MIN) {
        state.climb_flat_since_ms = null;
        if (!state.climb_fired && segment_gain >= CLIMB_FIRE_SEGMENT_GAIN_M) {
          state.climb_fired = true;
          return {
            trigger: 'climbing',
            cls: 'effort',
            facts: {
              [`segment_gain_${u === 'imperial' ? 'ft' : 'm'}`]: elev_from_m(segment_gain, u),
              [`climb_rate_${u === 'imperial' ? 'ft' : 'm'}_per_min`]: elev_from_m(rate, u),
              [`total_gain_${u === 'imperial' ? 'ft' : 'm'}`]: elev_from_m(last.elevation_gain_m, u),
              current_hr: last.current_hr,
              elapsed_min,
            },
            fallback: `This climb is real — ${elev_from_m(segment_gain, u)} ${elev_unit_spoken(u)} up and still going. Smooth circles, steady breathing.`,
          };
        }
      } else if (rate != null && rate <= CREST_FLAT_RATE_M_PER_MIN) {
        if (state.climb_flat_since_ms == null) {
          state.climb_flat_since_ms = now_ms;
        } else if (now_ms - state.climb_flat_since_ms >= CREST_FLAT_SUSTAIN_MS) {
          state.climb_phase = 'idle';
          state.climb_flat_since_ms = null;
          if (segment_gain >= CREST_FIRE_SEGMENT_GAIN_M) {
            return {
              trigger: 'climb_crested',
              cls: 'narrative',
              facts: {
                [`segment_gain_${u === 'imperial' ? 'ft' : 'm'}`]: elev_from_m(segment_gain, u),
                [`total_gain_${u === 'imperial' ? 'ft' : 'm'}`]: elev_from_m(last.elevation_gain_m, u),
                elapsed_min,
              },
              fallback: `Climb crested — about ${elev_from_m(segment_gain, u)} ${elev_unit_spoken(u)} banked on that one. Take the descent; you earned it.`,
            };
          }
        }
      } else {
        // Indeterminate rate (sparse elevation samples) — hold the
        // segment open but don't run the crest clock on bad data.
        state.climb_flat_since_ms = null;
      }
    }
  }

  // 3. zone_shift — sustained move into a different zone.
  const zone = last.current_hr_zone;
  if (zone != null) {
    if (state.established_zone == null) {
      if (!state.zone_candidate || state.zone_candidate.zone !== zone) {
        state.zone_candidate = { zone, since_ms: now_ms };
      } else if (now_ms - state.zone_candidate.since_ms >= ZONE_SUSTAIN_MS) {
        state.established_zone = zone;
        state.zone_candidate = null;
      }
    } else if (zone !== state.established_zone) {
      if (!state.zone_candidate || state.zone_candidate.zone !== zone) {
        state.zone_candidate = { zone, since_ms: now_ms };
      } else if (now_ms - state.zone_candidate.since_ms >= ZONE_SUSTAIN_MS) {
        const from_zone = state.established_zone;
        state.established_zone = zone;
        state.zone_candidate = null;
        // Damping (2026-06-12): a session gets at most 3 zone cues, and
        // arrivals at zone 1 are never worth a voice note — recovery
        // dips near stops were burning the session cap.
        const cooled =
          state.last_zone_cue_at_ms == null || now_ms - state.last_zone_cue_at_ms >= ZONE_CUE_COOLDOWN_MS;
        if (cooled && zone !== 1 && state.zone_cue_count < ZONE_CUE_SESSION_CAP) {
          state.last_zone_cue_at_ms = now_ms;
          state.zone_cue_count += 1;
          const up = zone > from_zone;
          return {
            trigger: 'zone_shift',
            cls: 'effort',
            facts: {
              from_zone,
              to_zone: zone,
              direction: up ? 'up' : 'down',
              current_hr: last.current_hr,
              elapsed_min,
            },
            fallback: up
              ? `You've pushed into zone ${zone}${last.current_hr != null ? ` — HR ${Math.round(last.current_hr)}` : ''}. That's real work. Hold it if you mean it.`
              : `Settling back into zone ${zone}. Smooth — keep it easy.`,
          };
        }
      }
    } else {
      state.zone_candidate = null;
    }
  }

  // 3.5 steady_state — 30 unbroken minutes in one zone (z2+) is a
  //     story worth one line. Continuity resets on any zone change or
  //     HR dropout, so only true blocks qualify.
  if (zone != null) {
    if (state.zone_block_zone !== zone) {
      state.zone_block_zone = zone;
      state.zone_block_since_s = last.elapsed_s;
    } else if (
      !state.fired.has('steady_state') &&
      zone >= 2 &&
      state.zone_block_since_s != null &&
      last.elapsed_s - state.zone_block_since_s >= STEADY_STATE_S
    ) {
      state.fired.add('steady_state');
      const mins = Math.round((last.elapsed_s - state.zone_block_since_s) / 60);
      return {
        trigger: 'steady_state',
        cls: 'narrative',
        facts: { zone, minutes_at_zone: mins, elapsed_min },
        fallback: `That's ${mins} straight minutes in zone ${zone}${zone === 2 ? ' — textbook base building' : ' — serious steady work'}.`,
      };
    }
  } else {
    state.zone_block_zone = null;
    state.zone_block_since_s = null;
  }

  // 4. distance_milestone — once per crossed milestone. The fired key
  //    is only added here, so a caller that gates BEFORE detect (the
  //    contract) never consumes a milestone it didn't deliver.
  if (last.distance_m != null && cfg.milestone_m > 0) {
    const idx = Math.floor(last.distance_m / cfg.milestone_m);
    if (idx >= 1 && !state.fired.has(`milestone:${idx}`)) {
      // Mark every index up to the current one — a session that
      // rehydrated mid-ride celebrates once, not three times.
      for (let i = 1; i <= idx; i += 1) state.fired.add(`milestone:${i}`);
      const ps = session_pace(last);
      // The interval is exact in display units by construction
      // ("every 5 miles"), so the crossed value renders clean.
      const milestone_display = Math.round((idx * cfg.milestone_m) / (u === 'imperial' ? M_PER_MI : 1000));
      const du = dist_unit(u);
      return {
        trigger: 'distance_milestone',
        cls: 'progress',
        facts: {
          [`milestone_${du}`]: milestone_display,
          [`distance_${du}`]: dist_from_m(last.distance_m, u),
          elapsed_min,
          [`avg_speed_${u === 'imperial' ? 'mph' : 'kmh'}`]: ps != null ? speed_from_pace_s_per_km(ps, u) : null,
        },
        fallback: `${milestone_display} ${dist_unit_spoken(u)} down, ${elapsed_min} minutes in. Keep it rolling.`,
      };
    }
  }

  // 4.5 fastest_split — per-mile (or per-km) splits; a new session-best
  //     past split 3 earns a cue, at most twice a ride. Splits spanning
  //     stops are slow by construction and never best.
  if (last.distance_m != null) {
    const split_m = u === 'imperial' ? M_PER_MI : 1000;
    const idx = Math.floor(last.distance_m / split_m);
    if (idx > state.last_split_index) {
      const advanced_one = idx === state.last_split_index + 1;
      // Interpolate the true boundary-crossing time between the two
      // samples that straddle it — at 30 s packets, sample-quantized
      // splits alias by ±30 s, which minted fake "bests" on perfectly
      // steady rides (caught by the smoke 2026-06-12).
      const boundary_m = idx * split_m;
      let crossing_elapsed = last.elapsed_s;
      const prev = state.samples.length >= 2 ? state.samples[state.samples.length - 2] : null;
      if (
        prev &&
        prev.distance_m != null &&
        last.distance_m > prev.distance_m &&
        boundary_m >= prev.distance_m &&
        boundary_m <= last.distance_m
      ) {
        const f = (boundary_m - prev.distance_m) / (last.distance_m - prev.distance_m);
        crossing_elapsed = prev.elapsed_s + f * (last.elapsed_s - prev.elapsed_s);
      }
      const split_s = crossing_elapsed - state.last_split_elapsed_s;
      const prev_index = state.last_split_index;
      state.last_split_index = idx;
      state.last_split_elapsed_s = crossing_elapsed;
      if (advanced_one && prev_index >= 1 && split_s > 60) {
        const is_best = state.best_split_s != null && split_s < state.best_split_s * SPLIT_IMPROVE_PCT;
        if (is_best && idx >= SPLIT_MIN_INDEX && state.split_cue_count < SPLIT_CUE_CAP) {
          state.best_split_s = split_s;
          state.split_cue_count += 1;
          // The split is exactly one display unit, so speed is 3600/s.
          const speed_disp = round1(3600 / split_s);
          const unit_word = u === 'imperial' ? 'Mile' : 'Kilometer';
          return {
            trigger: 'fastest_split',
            cls: 'effort',
            facts: {
              split_index: idx,
              [`split_speed_${u === 'imperial' ? 'mph' : 'kmh'}`]: speed_disp,
              split_minutes: Math.floor(split_s / 60),
              split_seconds: Math.round(split_s % 60),
              elapsed_min,
            },
            fallback: `${unit_word} ${idx} was your quickest of the ride — about ${speed_disp} ${u === 'imperial' ? 'mph' : 'km/h'}.`,
          };
        }
        if (state.best_split_s == null || split_s < state.best_split_s) state.best_split_s = split_s;
      }
    }
  }

  // 5. hr_drift — once, care class. Suppressed mid-climb: rising HR on
  //    a sustained grade is the grade talking, not hydration.
  if (!state.fired.has('hr_drift') && last.elapsed_s >= HR_DRIFT_MIN_ELAPSED_S && state.climb_phase !== 'climbing') {
    const hr_now = avg_hr_window(state, now_ms, 5 * 60 * 1000, 0);
    const hr_then = avg_hr_window(state, now_ms, 15 * 60 * 1000, 10 * 60 * 1000);
    const p5 = pace_over_window(state, now_ms, 5 * 60 * 1000);
    const p15 = pace_over_window(state, now_ms, 15 * 60 * 1000);
    if (
      hr_now != null &&
      hr_then != null &&
      p5 != null &&
      p15 != null &&
      Math.abs(p5 - p15) / p15 <= HR_DRIFT_PACE_TOLERANCE &&
      hr_now - hr_then >= HR_DRIFT_BPM
    ) {
      state.fired.add('hr_drift');
      return {
        trigger: 'hr_drift',
        cls: 'care',
        facts: {
          hr_then: Math.round(hr_then),
          hr_now: Math.round(hr_now),
          drift_bpm: Math.round(hr_now - hr_then),
          elapsed_min,
        },
        fallback: `Heart rate's crept up about ${Math.round(hr_now - hr_then)} beats at the same pace — that's drift. Take a drink when it's safe.`,
      };
    }
  }

  // 6. cooldown_detected — once, both signals required, 4-min sustain
  //    so a stoplight doesn't read as a wind-down.
  if (!state.fired.has('cooldown_detected') && last.elapsed_s >= COOLDOWN_MIN_ELAPSED_S) {
    const hr_now = avg_hr_window(state, now_ms, 2 * 60 * 1000, 0);
    const p5 = pace_over_window(state, now_ms, 5 * 60 * 1000);
    const ps = session_pace(last);
    const cond =
      hr_now != null &&
      state.peak_hr_5min != null &&
      hr_now <= state.peak_hr_5min - COOLDOWN_HR_DROP_BPM &&
      p5 != null &&
      ps != null &&
      p5 >= ps * COOLDOWN_PACE_SLOWDOWN;
    if (cond) {
      if (state.cooldown_candidate_since_ms == null) {
        state.cooldown_candidate_since_ms = now_ms;
      } else if (now_ms - state.cooldown_candidate_since_ms >= COOLDOWN_SUSTAIN_MS) {
        state.fired.add('cooldown_detected');
        return {
          trigger: 'cooldown_detected',
          cls: 'wrap_up',
          facts: {
            hr_drop_bpm: Math.round((state.peak_hr_5min ?? 0) - (hr_now ?? 0)),
            elapsed_min,
          },
          fallback: `Looks like you're winding it down. Good session — I'll have the full picture when you stop.`,
        };
      }
    } else {
      state.cooldown_candidate_since_ms = null;
    }
  }

  // 7. pace_change — both rolling windows must agree on direction.
  if (last.elapsed_s >= PACE_MIN_ELAPSED_S) {
    const cooled =
      state.last_pace_cue_at_ms == null || now_ms - state.last_pace_cue_at_ms >= PACE_CUE_COOLDOWN_MS;
    if (cooled) {
      const p5 = pace_over_window(state, now_ms, 5 * 60 * 1000);
      const p2 = pace_over_window(state, now_ms, 150 * 1000);
      const ps = session_pace(last);
      if (p5 != null && p2 != null && ps != null) {
        const faster = p5 <= ps * (1 - PACE_DELTA_PCT) && p2 <= ps * (1 - PACE_DELTA_PCT);
        // The 'slower' floor (2026-06-12): "you're rolling at 1.9 mph"
        // is a stop in progress, not a pace to coach. Below the floor
        // the motion machine owns the moment.
        const slower =
          p5 >= ps * (1 + PACE_DELTA_PCT) &&
          p2 >= ps * (1 + PACE_DELTA_PCT) &&
          1000 / p5 >= PACE_SLOWER_FLOOR_M_S &&
          state.stop_candidate_since_ms == null;
        if (faster || slower) {
          state.last_pace_cue_at_ms = now_ms;
          const pct = Math.round(Math.abs(p5 - ps) / ps * 100);
          return {
            trigger: 'pace_change',
            cls: 'effort',
            facts: {
              direction: faster ? 'faster' : 'slower',
              [`rolling_speed_${u === 'imperial' ? 'mph' : 'kmh'}`]: speed_from_pace_s_per_km(p5, u),
              [`session_speed_${u === 'imperial' ? 'mph' : 'kmh'}`]: speed_from_pace_s_per_km(ps, u),
              pct_change: pct,
              elapsed_min,
            },
            fallback: faster
              ? `Pace is up — you're moving about ${pct} percent quicker than your session average.`
              : `Pace has eased about ${pct} percent off your average. If that's on purpose, take it; if not, reel it back.`,
          };
        }
      }
    }
  }

  return null;
}
