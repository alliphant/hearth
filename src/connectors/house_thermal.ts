/**
 * House-thermal-history connector — HVAC utilization + heat-loss analysis
 * over Home Assistant recorder history (house-fusion Phase 1, 2026-07-13).
 *
 * `house_climate` answers "what is the house doing NOW"; this answers "how
 * has the house BEHAVED over the last N hours, and how efficiently does it
 * hold temperature". From HA's `/api/history/period` it pulls:
 *   - the thermostat's history (hvac_action + setpoint + current temp per
 *     recorded point) → RUN segments (each heating/cooling run with start /
 *     end / minutes / setpoint / boundary temps) + duty cycle + cycle counts;
 *   - each zone's temperature series + the on-property outdoor temperature
 *     and humidity series (Tempest).
 *
 * The efficiency math is DETERMINISTIC and runs inside the tool (Law #1:
 * determinism inside a tool the model chose to call). For every HVAC-IDLE
 * segment ≥ 30 min, each zone's drift is fit against the indoor-outdoor
 * delta using Newton's law of cooling, dT/dt = k·(T_out − T_in):
 *
 *     k = drift_rate ÷ (outdoor_mean − zone_mean)      [fraction per hour]
 *     τ = 1/k                                          [hours, time constant]
 *
 * A LOWER k (higher τ) means the envelope holds temperature better. Segments
 * with |ΔT| < 5° are skipped (noise dominates), non-physical fits (k ≤ 0 —
 * internal gains / solar load overpowering envelope loss) are reported but
 * excluded from the median, and the per-zone result is the MEDIAN k over
 * usable segments so one weird segment can't skew the story. The tool never
 * editorializes — it reports numbers, counts, and honest `caveats`; reading
 * "the en suite leaks" out of them is the specialist's job.
 *
 * Data honesty: the ecobee entities began recording 2026-07-13, and HA's
 * recorder purges (default ~10 days) — a window with thin coverage degrades
 * to `quality: 'partial'` / `'insufficient'` with the reason in `caveats`,
 * never a fabricated coefficient. Longitudinal baselines beyond recorder
 * retention are Phase 3 (the nightly vault ledger), not this tool.
 *
 * Entity resolution reuses `house_climate`'s zone map + outdoor reference
 * (one source of truth — the now-read and the trend-read can never disagree
 * about what a zone is). NOTE: importing those helpers makes this module a
 * restart-class change relative to house_climate.ts edits (the ToolLoader's
 * shared-helper boundary, see tool_loader.ts).
 */

import { z } from 'zod';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import { require_caller_tier } from '@core/tool_gates';
import { fetch_ha_history, type HAHistoryPoint } from './home_assistant';
import {
  house_zones,
  hvac_climate_entity,
  normalize_hvac_action,
  outdoor_temp_entity,
  outdoor_humidity_entity,
  outdoor_wind_entity,
  outdoor_gust_entity,
  outdoor_irradiance_entity,
} from './house_climate';
import { load_power_entity } from './house_energy';

// ── Tunables ───────────────────────────────────────────────────────────────

/** An idle segment shorter than this can't separate drift from sensor noise. */
const MIN_IDLE_MS = 30 * 60 * 1000;
/** Max gap when interpolating a series value at a boundary instant. */
const MAX_INTERP_GAP_MS = 30 * 60 * 1000;
/** |indoor − outdoor| below this (degrees) → the segment is skipped as noise. */
const MIN_DELTA_T = 5;
/** Cap on reported HVAC runs (most recent kept). */
const MAX_RUNS = 20;
/** Cap on reported drift samples per zone (longest kept). */
const MAX_DRIFT_SAMPLES = 6;

// ── Series helpers (pure; exported for the smoke) ──────────────────────────

export interface SeriesPoint {
  /** epoch ms */
  t: number;
  v: number;
}

export function to_series(points: HAHistoryPoint[]): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (const p of points) {
    const t = Date.parse(p.last_changed);
    const v = Number.parseFloat(p.state);
    if (Number.isFinite(t) && Number.isFinite(v)) out.push({ t, v });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Linear interpolation at instant `t`; null when the nearest bracketing
 *  points are farther than `max_gap_ms` (extrapolation is fabrication). */
export function interp_at(
  series: SeriesPoint[],
  t: number,
  max_gap_ms: number = MAX_INTERP_GAP_MS,
): number | null {
  if (series.length === 0) return null;
  let lo: SeriesPoint | null = null;
  let hi: SeriesPoint | null = null;
  for (const p of series) {
    if (p.t <= t) lo = p;
    if (p.t >= t) {
      hi = p;
      break;
    }
  }
  if (lo && hi) {
    if (lo.t === hi.t) return lo.v;
    if (t - lo.t > max_gap_ms || hi.t - t > max_gap_ms) {
      // bracketed, but by points too far away to trust a line between them
      if (t - lo.t <= max_gap_ms) return lo.v;
      if (hi.t - t <= max_gap_ms) return hi.v;
      return null;
    }
    const frac = (t - lo.t) / (hi.t - lo.t);
    return lo.v + frac * (hi.v - lo.v);
  }
  const nearest = lo ?? hi;
  if (nearest && Math.abs(nearest.t - t) <= max_gap_ms) return nearest.v;
  return null;
}

/** Time-weighted mean over [t0, t1] (trapezoidal over interior points +
 *  interpolated boundaries). Null when the window has no usable coverage. */
export function mean_between(series: SeriesPoint[], t0: number, t1: number): number | null {
  if (t1 <= t0) return null;
  const v0 = interp_at(series, t0);
  const v1 = interp_at(series, t1);
  const inner = series.filter((p) => p.t > t0 && p.t < t1);
  const pts: SeriesPoint[] = [];
  if (v0 !== null) pts.push({ t: t0, v: v0 });
  pts.push(...inner);
  if (v1 !== null) pts.push({ t: t1, v: v1 });
  if (pts.length === 0) return null;
  if (pts.length === 1) return pts[0]?.v ?? null;
  let area = 0;
  let span = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (!a || !b) continue;
    area += ((a.v + b.v) / 2) * (b.t - a.t);
    span += b.t - a.t;
  }
  return span > 0 ? area / span : null;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid] ?? null;
  const a = s[mid - 1];
  const b = s[mid];
  return a !== undefined && b !== undefined ? (a + b) / 2 : null;
}

// ── HVAC timeline → runs + idle segments (pure; exported for the smoke) ────

export interface ClimatePoint {
  t: number;
  /** hvac_action at this instant: heating | cooling | idle | fan | off | null */
  action: string | null;
  setpoint: number | null;
  current: number | null;
}

export function to_climate_points(points: HAHistoryPoint[]): ClimatePoint[] {
  const out: ClimatePoint[] = [];
  for (const p of points) {
    const t = Date.parse(p.last_changed);
    if (!Number.isFinite(t)) continue;
    const attrs = p.attributes ?? {};
    // equipment_running outranks the label — see normalize_hvac_action (the
    // ecobee fork recorded compressor intervals as `fan` for five days).
    const action = normalize_hvac_action(
      typeof attrs['hvac_action'] === 'string' ? (attrs['hvac_action'] as string) : null,
      typeof attrs['equipment_running'] === 'string' ? (attrs['equipment_running'] as string) : null,
    );
    const setpoint =
      typeof attrs['temperature'] === 'number' && Number.isFinite(attrs['temperature'])
        ? (attrs['temperature'] as number)
        : null;
    const current =
      typeof attrs['current_temperature'] === 'number' &&
      Number.isFinite(attrs['current_temperature'])
        ? (attrs['current_temperature'] as number)
        : null;
    out.push({ t, action, setpoint, current });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

export interface HvacRun {
  action: 'heating' | 'cooling';
  start: number;
  end: number;
  minutes: number;
  setpoint: number | null;
  temp_start: number | null;
  temp_end: number | null;
}

export interface Segment {
  start: number;
  end: number;
}

const RUNNING = new Set(['heating', 'cooling']);

/**
 * Step-hold walk of the climate timeline over [start, end]: each point's
 * hvac_action holds until the next point. Returns the heating/cooling RUNS
 * and the IDLE segments between them (idle = a known non-running action;
 * stretches with UNKNOWN action are neither runs nor idle — honesty over
 * coverage).
 */
export function build_hvac_segments(
  points: ClimatePoint[],
  start: number,
  end: number,
): { runs: HvacRun[]; idle: Segment[]; known_ms: number } {
  const runs: HvacRun[] = [];
  const idle: Segment[] = [];
  let known_ms = 0;

  const bounded = points.filter((p) => p.t <= end);
  for (let i = 0; i < bounded.length; i++) {
    const p = bounded[i];
    if (!p) continue;
    const next = bounded[i + 1];
    const seg_start = Math.max(p.t, start);
    const seg_end = Math.min(next ? next.t : end, end);
    if (seg_end <= seg_start || p.action === null) continue;
    known_ms += seg_end - seg_start;

    if (RUNNING.has(p.action)) {
      const last = runs[runs.length - 1];
      if (last && last.action === p.action && last.end === seg_start) {
        last.end = seg_end;
        last.minutes = Math.round((last.end - last.start) / 60000);
        last.temp_end = p.current ?? last.temp_end;
      } else {
        runs.push({
          action: p.action as 'heating' | 'cooling',
          start: seg_start,
          end: seg_end,
          minutes: Math.round((seg_end - seg_start) / 60000),
          setpoint: p.setpoint,
          temp_start: p.current,
          temp_end: p.current,
        });
      }
    } else {
      // A run that ends HERE gets its closing temperature from this point —
      // the reading at the instant the equipment stopped.
      const last_run = runs[runs.length - 1];
      if (last_run && last_run.end === seg_start && p.current !== null) last_run.temp_end = p.current;
      const last = idle[idle.length - 1];
      if (last && last.end === seg_start) last.end = seg_end;
      else idle.push({ start: seg_start, end: seg_end });
    }
  }
  return { runs, idle, known_ms };
}

// ── Output shapes ──────────────────────────────────────────────────────────

const iso = (t: number): string => new Date(t).toISOString();

// ── Zone heat-loss fit (pure; shared with the nightly house ledger) ────────

export interface ZoneLossFit {
  samples: Array<{
    start: string;
    end: string;
    minutes: number;
    drift_per_hour: number;
    delta_t: number;
    k_per_hour: number;
    /** Mean wind over the segment (station unit) — null when no wind history. */
    wind_mean: number | null;
  }>;
  skipped_small: number;
  skipped_sparse: number;
  nonphysical: number;
  physical_ks: number[];
  /** MEDIAN Newton coefficient over physical segments; null = not enough data. */
  k_median: number | null;
  /** MEDIAN k over CALM physical segments (wind ≤ HEARTH_HOUSE_WIND_CALM_MAX,
   *  default 4) — the conduction/insulation baseline. */
  k_calm: number | null;
  calm_count: number;
  /** MEDIAN k over WINDY physical segments (wind ≥ HEARTH_HOUSE_WIND_WINDY_MIN,
   *  default 8). k_windy ≫ k_calm = wind-driven INFILTRATION (gaps, loose
   *  seals); k_windy ≈ k_calm = conduction (insulation), not leaks. */
  k_windy: number | null;
  windy_count: number;
}

function wind_calm_max(): number {
  const n = Number.parseFloat(process.env.HEARTH_HOUSE_WIND_CALM_MAX ?? '4');
  return Number.isFinite(n) ? n : 4;
}
function wind_windy_min(): number {
  const n = Number.parseFloat(process.env.HEARTH_HOUSE_WIND_WINDY_MIN ?? '8');
  return Number.isFinite(n) ? n : 8;
}

/**
 * Fit Newton's-law loss coefficients for one zone across the HVAC-idle
 * segments: k = drift ÷ (outdoor_mean − zone_mean) per segment ≥ 30 min,
 * |ΔT| ≥ 5° (else noise), non-physical fits (k ≤ 0) counted but excluded
 * from the median. Interpolation refuses to extrapolate — a segment whose
 * boundary can't be read within the gap window is skipped as sparse.
 *
 * When a wind series is provided, each physical segment is also bucketed
 * calm/windy (fixed thresholds so days stay comparable) — the calm median is
 * the conduction baseline, the windy excess is the infiltration signature.
 */
export function fit_zone_loss(
  series: SeriesPoint[],
  outdoor_series: SeriesPoint[],
  idle: Segment[],
  wind_series: SeriesPoint[] = [],
): ZoneLossFit {
  const samples: ZoneLossFit['samples'] = [];
  let skipped_small = 0;
  let skipped_sparse = 0;
  let nonphysical = 0;
  const physical_ks: number[] = [];
  const calm_ks: number[] = [];
  const windy_ks: number[] = [];
  const calm_max = wind_calm_max();
  const windy_min = wind_windy_min();

  if (outdoor_series.length > 0 && series.length >= 2) {
    for (const seg of idle) {
      if (seg.end - seg.start < MIN_IDLE_MS) continue;
      const v0 = interp_at(series, seg.start);
      const v1 = interp_at(series, seg.end);
      const outdoor_mean = mean_between(outdoor_series, seg.start, seg.end);
      if (v0 === null || v1 === null || outdoor_mean === null) {
        skipped_sparse++;
        continue;
      }
      const hours_seg = (seg.end - seg.start) / 3600_000;
      const zone_mean = (v0 + v1) / 2;
      const delta_t = outdoor_mean - zone_mean;
      if (Math.abs(delta_t) < MIN_DELTA_T) {
        skipped_small++;
        continue;
      }
      const drift = (v1 - v0) / hours_seg;
      const k = drift / delta_t;
      const seg_wind =
        wind_series.length > 0 ? mean_between(wind_series, seg.start, seg.end) : null;
      if (k <= 0) nonphysical++;
      else {
        physical_ks.push(k);
        if (seg_wind !== null && seg_wind <= calm_max) calm_ks.push(k);
        else if (seg_wind !== null && seg_wind >= windy_min) windy_ks.push(k);
      }
      samples.push({
        start: iso(seg.start),
        end: iso(seg.end),
        minutes: Math.round((seg.end - seg.start) / 60000),
        drift_per_hour: Number(drift.toFixed(3)),
        delta_t: Number(delta_t.toFixed(1)),
        k_per_hour: Number(k.toFixed(4)),
        wind_mean: seg_wind !== null ? Number(seg_wind.toFixed(1)) : null,
      });
    }
  }

  const round4 = (x: number | null): number | null => (x === null ? null : Number(x.toFixed(4)));
  return {
    samples,
    skipped_small,
    skipped_sparse,
    nonphysical,
    physical_ks,
    k_median: median(physical_ks),
    k_calm: round4(median(calm_ks)),
    calm_count: calm_ks.length,
    k_windy: round4(median(windy_ks)),
    windy_count: windy_ks.length,
  };
}

// ── HVAC electrical signature + degree-hours (pure; shared with the ledger) ─

const MIN_MS = 60_000;

export interface StepEstimate {
  /** Median load-power step across run edges (kW). Null when < 3 usable edges. */
  kw: number | null;
  edges_used: number;
}

/**
 * Estimate the equipment's electrical draw from whole-home load-power steps
 * at hvac_action edges: at each run START the load jumps by the equipment's
 * draw; at each END it drops. pre = mean load [edge−6m, edge−1m], post =
 * [edge+1m, edge+6m]; the signed step is collected across every edge and the
 * MEDIAN taken (robust to a coinciding oven or car charger on single edges).
 * Steps under 0.2 kW are ignored as noise — a gas furnace shows only its
 * blower here, which is the honest ELECTRIC share.
 */
export function estimate_step_kw(
  load_series: SeriesPoint[],
  runs: HvacRun[],
  action: 'heating' | 'cooling',
  exclude_near: number[] = [],
  exclude_radius_ms: number = 8 * MIN_MS,
): StepEstimate {
  return estimate_window_step_kw(
    load_series,
    runs.filter((r) => r.action === action),
    exclude_near,
    exclude_radius_ms,
  );
}

/**
 * The action-agnostic core of `estimate_step_kw`: signed load steps at
 * window edges → median. `exclude_near` drops any edge within
 * `exclude_radius_ms` of the given instants — used to keep another
 * appliance's own transitions (the EV charger starting mid-compressor-run)
 * from contaminating an estimate. Also reused directly for the EV charger's
 * measured-draw cross-check, where the windows are charger-state sessions.
 */
export function estimate_window_step_kw(
  load_series: SeriesPoint[],
  windows: Array<{ start: number; end: number }>,
  exclude_near: number[] = [],
  exclude_radius_ms: number = 8 * MIN_MS,
): StepEstimate {
  const steps: number[] = [];
  for (const r of windows) {
    const edges: Array<[number, 1 | -1]> = [
      [r.start, 1],
      [r.end, -1],
    ];
    for (const [edge, sign] of edges) {
      if (exclude_near.some((t) => Math.abs(t - edge) <= exclude_radius_ms)) continue;
      const pre = mean_between(load_series, edge - 6 * MIN_MS, edge - 1 * MIN_MS);
      const post = mean_between(load_series, edge + 1 * MIN_MS, edge + 6 * MIN_MS);
      if (pre === null || post === null) continue;
      const step = sign * (post - pre);
      if (step > 0.2) steps.push(step);
    }
  }
  if (steps.length < 3) return { kw: null, edges_used: steps.length };
  const kw = median(steps);
  return { kw: kw !== null ? Number(kw.toFixed(2)) : null, edges_used: steps.length };
}

/**
 * Within the given windows, count the time the load sits in the appliance's
 * HIGH state: sample ≥ (day-baseline + 0.75 × step_kw), where the baseline is
 * the 10th percentile of the WHOLE series (the house's idle floor — a window
 * that is fully-high would poison a window-local baseline). Time-weighted by
 * the previous sample's classification, like the duty walk. Built for the EV
 * charger, whose "In Use" state means PLUGGED IN, not charging — the load
 * series is what says the car was actually drawing. Returns null when the
 * windows hold too few samples to classify (thin data must not read as zero).
 */
export function classify_high_state_ms(
  load_series: SeriesPoint[],
  windows: Array<{ start: number; end: number }>,
  step_kw: number,
): { high_ms: number; sub_windows: Array<{ start: number; end: number }> } | null {
  if (windows.length === 0) return { high_ms: 0, sub_windows: [] };
  const all_vals = load_series.map((p) => p.v).sort((a, b) => a - b);
  if (all_vals.length < 10) return null;
  const baseline = all_vals[Math.floor(all_vals.length * 0.1)] ?? all_vals[0]!;
  const threshold = baseline + 0.75 * step_kw;

  let high_ms = 0;
  const sub_windows: Array<{ start: number; end: number }> = [];
  let in_window_samples = 0;
  for (const w of windows) {
    const pts = load_series.filter((p) => p.t >= w.start && p.t <= w.end);
    in_window_samples += pts.length;
    let open: number | null = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      const next_t = i + 1 < pts.length ? pts[i + 1]!.t : w.end;
      const high = p.v >= threshold;
      if (high) {
        high_ms += next_t - p.t;
        if (open === null) open = p.t;
      } else if (open !== null) {
        sub_windows.push({ start: open, end: p.t });
        open = null;
      }
    }
    if (open !== null) sub_windows.push({ start: open, end: w.end });
  }
  if (in_window_samples < 6) return null;
  return { high_ms, sub_windows };
}

/**
 * Degree-hours over [start, end): the positive part of (outdoor − indoor)
 * for cooling / (indoor − outdoor) for heating, sampled every 15 min and
 * integrated (°·h). The thermostat's indoor series moves slowly, so its
 * interpolation gap is relaxed to 3 h. Null when under half the samples
 * resolve — a thin day must not masquerade as a mild one.
 */
export function degree_hours(
  outdoor_series: SeriesPoint[],
  indoor_series: SeriesPoint[],
  start: number,
  end: number,
  mode: 'cooling' | 'heating',
): { value: number | null; coverage: number } {
  const STEP = 15 * MIN_MS;
  let sum = 0;
  let resolved = 0;
  let total = 0;
  for (let t = start; t < end; t += STEP) {
    total++;
    const o = interp_at(outdoor_series, t);
    const i = interp_at(indoor_series, t, 3 * 3600_000);
    if (o === null || i === null) continue;
    resolved++;
    const d = mode === 'cooling' ? o - i : i - o;
    if (d > 0) sum += d * (STEP / 3600_000);
  }
  const coverage = total > 0 ? resolved / total : 0;
  return {
    value: coverage >= 0.5 ? Number(sum.toFixed(1)) : null,
    coverage: Number(coverage.toFixed(3)),
  };
}

const RunOut = z.object({
  action: z.string(),
  start: z.string(),
  end: z.string(),
  minutes: z.number(),
  setpoint: z.number().nullable(),
  temp_start: z.number().nullable(),
  temp_end: z.number().nullable(),
  outdoor_start: z.number().nullable(),
});

const DriftSample = z.object({
  start: z.string(),
  end: z.string(),
  minutes: z.number(),
  /** Signed zone-temperature drift over the idle segment (degrees/hour). */
  drift_per_hour: z.number(),
  /** outdoor_mean − zone_mean over the segment (signed, degrees). */
  delta_t: z.number(),
  /** Newton coefficient k = drift ÷ ΔT (fraction/hour). Positive = physical. */
  k_per_hour: z.number(),
  /** Mean wind over the segment — null when no wind history resolved. */
  wind_mean: z.number().nullable(),
});

const ZoneAnalysis = z.object({
  unit: z.string().nullable(),
  temp_points: z.number().int(),
  idle_segments_usable: z.number().int(),
  skipped_small_delta_t: z.number().int(),
  skipped_sparse_data: z.number().int(),
  excluded_nonphysical: z.number().int(),
  /** MEDIAN Newton coefficient over usable segments (fraction/hour).
   *  LOWER = the zone holds temperature better. Null = not enough data. */
  loss_rate_per_hour: z.number().nullable(),
  /** τ = 1/k (hours): time for ~63% of the indoor-outdoor gap to close with
   *  HVAC off. HIGHER = better envelope. Null when loss rate is null. */
  time_constant_hours: z.number().nullable(),
  /** MEDIAN k over CALM idle segments (wind ≤ 4 by default) — the
   *  conduction/insulation baseline. Null until calm segments accumulate. */
  loss_rate_calm: z.number().nullable(),
  calm_segments: z.number().int(),
  /** MEDIAN k over WINDY segments (wind ≥ 8 by default). Windy ≫ calm =
   *  wind-driven INFILTRATION (gaps, loose seals); ≈ calm = conduction. */
  loss_rate_windy: z.number().nullable(),
  windy_segments: z.number().int(),
  samples: z.array(DriftSample),
});

const HouseThermalInput = z
  .object({
    hours: z.coerce
      .number()
      .int()
      .min(6)
      .max(168)
      .default(24)
      .describe('Analysis window in hours ending now (default 24; max 168 = 7 days).'),
    zone: z
      .string()
      .optional()
      .describe('Optional single zone label to analyze (e.g. "Basement"). Default: all zones.'),
  })
  .strict();

const HouseThermalOutput = z.object({
  ok: z.boolean(),
  source: z.literal('home_assistant'),
  error: z.string().optional(),
  recovery_hint: z.string().optional(),
  window: z.object({ start: z.string(), end: z.string(), hours: z.number() }).optional(),
  /** good = duty + ≥1 zone with a usable loss rate; partial = some analyses
   *  ran; insufficient = history too thin for any conclusion. */
  quality: z.enum(['good', 'partial', 'insufficient']).optional(),
  caveats: z.array(z.string()).optional(),
  hvac: z
    .object({
      entity_id: z.string(),
      history_points: z.number().int(),
      /** Fraction of the window where hvac_action was known (0..1). */
      coverage: z.number(),
      heating_minutes: z.number(),
      cooling_minutes: z.number(),
      heating_duty_pct: z.number(),
      cooling_duty_pct: z.number(),
      heating_cycles: z.number().int(),
      cooling_cycles: z.number().int(),
      runs: z.array(RunOut),
      setpoints_seen: z.array(z.object({ setpoint: z.number(), first_seen: z.string() })),
    })
    .optional(),
  hvac_energy: z
    .object({
      /** Median whole-home load step across cooling run edges (kW). */
      estimated_cooling_kw: z.number().nullable(),
      /** Estimated kW × runtime — the window's cooling energy (kWh). */
      cooling_kwh: z.number().nullable(),
      cooling_edges: z.number().int(),
      /** ELECTRIC share only — a gas furnace shows just its blower here. */
      estimated_heating_kw_electric: z.number().nullable(),
      heating_kwh_electric: z.number().nullable(),
      heating_edges: z.number().int(),
    })
    .optional(),
  envelope: z
    .object({
      cooling_degree_hours: z.number().nullable(),
      heating_degree_hours: z.number().nullable(),
      degree_hour_coverage: z.number(),
      /** Estimated HVAC kWh ÷ degree-DAYS — the trendable envelope-cost
       *  number. ASSUMES openings are closed when not needed and folds in
       *  solar/internal gains — compare across days, never read as absolute
       *  physics. Falling index after a re-seal = money saved. */
      leakage_index_cooling: z.number().nullable(),
      leakage_index_heating: z.number().nullable(),
    })
    .optional(),
  outdoor: z
    .object({
      temp_mean: z.number().nullable(),
      temp_min: z.number().nullable(),
      temp_max: z.number().nullable(),
      humidity_mean: z.number().nullable(),
      /** Mean wind over the window (Tempest rolling-average sensor's unit,
       *  mph on a US station) — infiltration context: the same ΔT loses more
       *  heat on a windy night, so compare loss rates at like wind. */
      wind_mean: z.number().nullable(),
      /** Highest gust seen in the window. */
      gust_max: z.number().nullable(),
      /** Mean solar irradiance (W/m²) — the honest denominator for solar
       *  yield ("was it actually sunny"). */
      irradiance_mean: z.number().nullable(),
    })
    .optional(),
  zones: z.record(z.string(), ZoneAnalysis).optional(),
});

type HouseThermalOut = z.infer<typeof HouseThermalOutput>;
type Input = z.infer<typeof HouseThermalInput>;

// ── Test seams ─────────────────────────────────────────────────────────────

type HistoryResult =
  | { ok: true; history: Record<string, HAHistoryPoint[]> }
  | { ok: false; reason: string };
type HistoryProvider = (
  entity_ids: string[],
  start_iso: string,
  opts?: { end_iso?: string; minimal?: boolean; significant_only?: boolean },
) => Promise<HistoryResult>;

let _history_provider: HistoryProvider = fetch_ha_history;
let _now: () => number = () => Date.now();

/** Test-only: swap the HA history provider for canned series. */
export function _test_set_history_provider(fn: HistoryProvider): void {
  _history_provider = fn;
}
/** Test-only: restore the live history provider. */
export function _test_reset_history_provider(): void {
  _history_provider = fetch_ha_history;
}
/** Test-only: pin "now" for deterministic windows. */
export function _test_set_now(fn: (() => number) | null): void {
  _now = fn ?? (() => Date.now());
}

// ── Audit ──────────────────────────────────────────────────────────────────

function audit(ctx: ToolContext, input: unknown, out: HouseThermalOut): void {
  ctx.memory?.log_action?.({
    intent_id: ctx.intent_id || ulid(),
    agent: ctx.specialist_id || 'house_thermal_connector',
    tool_name: 'house_thermal_history',
    tool_input: input as Record<string, unknown>,
    execution_result: {
      ok: out.ok,
      quality: out.quality ?? null,
      heating_minutes: out.hvac?.heating_minutes ?? 0,
      cooling_minutes: out.hvac?.cooling_minutes ?? 0,
      zones_analyzed: out.zones ? Object.keys(out.zones).length : 0,
    },
    error: out.error,
  });
}

// ── Tool ────────────────────────────────────────────────────────────────────

export const house_thermal_history: Tool<Input, HouseThermalOut> = {
  name: 'house_thermal_history',
  description:
    "Analyze the house's THERMAL BEHAVIOR over the last N hours (default 24, max 168) from Home Assistant history: HVAC utilization — every heating/cooling RUN with start/end/minutes/setpoint and boundary temps, duty-cycle percentages, cycle counts, setpoint changes — plus, for each zone, the heat-loss fit from HVAC-idle periods: drift rate vs the indoor-outdoor delta (Newton's law), reported as loss_rate_per_hour (LOWER = holds temperature better) and time_constant_hours (τ, HIGHER = better envelope; time for ~63% of the gap to outside to close with HVAC off). Outdoor context (Tempest temp mean/min/max + humidity mean) rides along. Use this for 'how much did the AC run', 'how fast does the house lose heat overnight', 'which zone leaks', and efficiency comparisons ('worse than last week' = call twice with different windows). Honesty: quality/caveats flag thin history (ecobee data starts 2026-07-13; recorder keeps ~10 days) — a null loss rate means not enough usable idle time, never zero loss. Also returns hvac_energy — the equipment's estimated electrical draw + kWh, recovered from whole-home load-power steps at run edges (electric share only; a gas furnace shows just its blower) — and envelope: degree-hours plus the LEAKAGE INDEX (estimated HVAC kWh ÷ degree-days), the trendable 'what is the envelope costing us' number (assumes openings closed when not needed). Per-zone calm-vs-windy loss rates separate INSULATION problems (high on calm nights too) from INFILTRATION/seal problems (only windy nights are bad).",
  risk: 'read',
  required_capabilities: ['read_house_climate'],
  // Bounded, structured output — every field carries weight; don't truncate.
  llm_budget: 'full',
  input_schema: HouseThermalInput,
  output_schema: HouseThermalOutput,

  idempotency_key(input) {
    return `house_thermal_history:${input.hours ?? 24}:${(input.zone ?? '*').toLowerCase()}`;
  },

  async execute(input, ctx: ToolContext): Promise<HouseThermalOut> {
    // Same household-data tier policy as house_climate.
    require_caller_tier(ctx, ['owner', 'household']);

    const hours = input.hours ?? 24;
    const end_ms = _now();
    const start_ms = end_ms - hours * 3600_000;
    const start_iso_s = new Date(start_ms).toISOString();
    const end_iso_s = new Date(end_ms).toISOString();

    const climate_id = hvac_climate_entity();
    const zone_defs = house_zones().filter(
      (zd) => !input.zone || zd.label.toLowerCase() === input.zone.toLowerCase(),
    );
    const outdoor_temp_id = outdoor_temp_entity();
    const outdoor_hum_id = outdoor_humidity_entity();
    const outdoor_wind_id = outdoor_wind_entity();
    const outdoor_gust_id = outdoor_gust_entity();
    const outdoor_irr_id = outdoor_irradiance_entity();
    const load_id = load_power_entity();

    if (zone_defs.length === 0) {
      const out: HouseThermalOut = {
        ok: false,
        source: 'home_assistant',
        error: `No zone matches "${input.zone}". Known zones: ${house_zones()
          .map((zd) => zd.label)
          .join(', ')}.`,
        recovery_hint: 'Re-call with one of the known zone labels, or omit `zone` for all.',
      };
      audit(ctx, input, out);
      return out;
    }

    // Two fetches: the climate entity needs FULL attributes (hvac_action is
    // an attribute) and unfiltered changes; the numeric series are cheap in
    // minimal mode.
    const climate_fetch = await _history_provider([climate_id], start_iso_s, {
      end_iso: end_iso_s,
      significant_only: false,
    });
    const series_fetch = await _history_provider(
      [
        ...zone_defs.map((zd) => zd.temp),
        outdoor_temp_id,
        outdoor_hum_id,
        outdoor_wind_id,
        outdoor_gust_id,
        outdoor_irr_id,
        load_id,
      ],
      start_iso_s,
      { end_iso: end_iso_s, minimal: true },
    );

    if (!climate_fetch.ok && !series_fetch.ok) {
      const out: HouseThermalOut = {
        ok: false,
        source: 'home_assistant',
        error: `Could not read HA history: ${climate_fetch.reason}`,
        recovery_hint: climate_fetch.reason.includes('HA_TOKEN')
          ? 'HA_TOKEN not configured on the orchestrator — set HA_BASE_URL + HA_TOKEN in hearth.env.'
          : 'Home Assistant history API was unreachable. Check HA_BASE_URL + the recorder integration; retry shortly.',
      };
      audit(ctx, input, out);
      return out;
    }

    const caveats: string[] = [];

    // ── HVAC timeline ──
    const climate_points = climate_fetch.ok
      ? to_climate_points(climate_fetch.history[climate_id] ?? [])
      : [];
    if (!climate_fetch.ok) caveats.push(`thermostat history unavailable: ${climate_fetch.reason}`);
    else if (climate_points.length === 0)
      caveats.push(
        `no recorder history for ${climate_id} in this window (the ecobee integration began recording 2026-07-13; the recorder purges after ~10 days)`,
      );

    const { runs, idle, known_ms } = build_hvac_segments(climate_points, start_ms, end_ms);
    const window_ms = end_ms - start_ms;
    const coverage = Number((known_ms / window_ms).toFixed(3));
    if (climate_points.length > 0 && coverage < 0.5)
      caveats.push(
        `hvac_action known for only ${Math.round(coverage * 100)}% of the window — duty figures undercount`,
      );

    const heating_ms = runs.filter((r) => r.action === 'heating').reduce((s, r) => s + (r.end - r.start), 0);
    const cooling_ms = runs.filter((r) => r.action === 'cooling').reduce((s, r) => s + (r.end - r.start), 0);

    const setpoints_seen: Array<{ setpoint: number; first_seen: string }> = [];
    for (const p of climate_points) {
      if (p.setpoint === null) continue;
      if (!setpoints_seen.some((s) => s.setpoint === p.setpoint)) {
        setpoints_seen.push({ setpoint: p.setpoint, first_seen: iso(p.t) });
        if (setpoints_seen.length >= 10) break;
      }
    }

    // ── numeric series ──
    const hist = series_fetch.ok ? series_fetch.history : {};
    if (!series_fetch.ok) caveats.push(`sensor history unavailable: ${series_fetch.reason}`);
    const outdoor_series = to_series(hist[outdoor_temp_id] ?? []);
    const humidity_series = to_series(hist[outdoor_hum_id] ?? []);
    const wind_series = to_series(hist[outdoor_wind_id] ?? []);
    const gust_series = to_series(hist[outdoor_gust_id] ?? []);
    const irradiance_series = to_series(hist[outdoor_irr_id] ?? []);
    const load_series = to_series(hist[load_id] ?? []);
    // The thermostat's own reading is the whole-house indoor reference for
    // degree-hours (slow-moving; its interpolation gap is relaxed in there).
    const indoor_series: SeriesPoint[] = climate_points
      .filter((p) => p.current !== null)
      .map((p) => ({ t: p.t, v: p.current as number }));
    if (outdoor_series.length === 0)
      caveats.push(`no outdoor (Tempest) history — loss rates need the outdoor reference and were skipped`);

    // ── per-zone idle-drift analysis ──
    const zones_out: Record<string, z.infer<typeof ZoneAnalysis>> = {};
    let usable_zone_count = 0;

    for (const zd of zone_defs) {
      const raw = hist[zd.temp] ?? [];
      const series = to_series(raw);
      const unit =
        raw.length > 0 && typeof raw[0]?.attributes?.['unit_of_measurement'] === 'string'
          ? (raw[0].attributes['unit_of_measurement'] as string)
          : null;

      const fit = fit_zone_loss(series, outdoor_series, idle, wind_series);
      const { samples, skipped_small, skipped_sparse, nonphysical } = fit;
      const k_median = fit.k_median;
      if (k_median !== null) usable_zone_count++;
      samples.sort((a, b) => b.minutes - a.minutes);

      zones_out[zd.label] = {
        unit,
        temp_points: series.length,
        idle_segments_usable: fit.physical_ks.length,
        skipped_small_delta_t: skipped_small,
        skipped_sparse_data: skipped_sparse,
        excluded_nonphysical: nonphysical,
        loss_rate_per_hour: k_median !== null ? Number(k_median.toFixed(4)) : null,
        time_constant_hours: k_median !== null && k_median > 0.001 ? Number((1 / k_median).toFixed(1)) : null,
        loss_rate_calm: fit.k_calm,
        calm_segments: fit.calm_count,
        loss_rate_windy: fit.k_windy,
        windy_segments: fit.windy_count,
        samples: samples.slice(0, MAX_DRIFT_SAMPLES),
      };
      if (series.length < 2)
        caveats.push(`zone "${zd.label}": no usable temperature history in this window`);
    }

    // ── outdoor summary ──
    const outdoor_vals = outdoor_series.filter((p) => p.t >= start_ms && p.t <= end_ms).map((p) => p.v);
    const gust_vals = gust_series.filter((p) => p.t >= start_ms && p.t <= end_ms).map((p) => p.v);
    const outdoor_summary = {
      temp_mean: mean_between(outdoor_series, start_ms, end_ms),
      temp_min: outdoor_vals.length ? Math.min(...outdoor_vals) : null,
      temp_max: outdoor_vals.length ? Math.max(...outdoor_vals) : null,
      humidity_mean: mean_between(humidity_series, start_ms, end_ms),
      wind_mean: mean_between(wind_series, start_ms, end_ms),
      gust_max: gust_vals.length ? Math.max(...gust_vals) : null,
      irradiance_mean: mean_between(irradiance_series, start_ms, end_ms),
    };
    const round1 = (x: number | null): number | null => (x === null ? null : Number(x.toFixed(1)));

    const has_duty = climate_points.length > 0;
    // 'good' requires REAL hvac coverage, not just any fit — a window where
    // hvac_action is known for 3% of the time can carry a valid zone fit and
    // still not support duty conclusions (the day-one ecobee case, live
    // 2026-07-13: coverage 0.027 read as 'good' pre-threshold).
    const quality: 'good' | 'partial' | 'insufficient' =
      has_duty && usable_zone_count > 0 && coverage >= 0.5
        ? 'good'
        : has_duty || usable_zone_count > 0
          ? 'partial'
          : 'insufficient';
    if (quality === 'insufficient')
      caveats.push('not enough recorder history for any analysis — retry after the sensors have accumulated a night of data');

    // ── HVAC electrical signature + envelope cost ──
    const cool_est = estimate_step_kw(load_series, runs, 'cooling');
    const heat_est = estimate_step_kw(load_series, runs, 'heating');
    const cooling_kwh =
      cool_est.kw !== null ? Number((cool_est.kw * (cooling_ms / 3600_000)).toFixed(1)) : null;
    const heating_kwh =
      heat_est.kw !== null ? Number((heat_est.kw * (heating_ms / 3600_000)).toFixed(1)) : null;
    const cdh = degree_hours(outdoor_series, indoor_series, start_ms, end_ms, 'cooling');
    const hdh = degree_hours(outdoor_series, indoor_series, start_ms, end_ms, 'heating');
    const leak = (kwh: number | null, dh: number | null): number | null =>
      kwh !== null && dh !== null && dh > 12 ? Number((kwh / (dh / 24)).toFixed(2)) : null;

    const recent_runs = runs.slice(-MAX_RUNS).map((r) => ({
      action: r.action,
      start: iso(r.start),
      end: iso(r.end),
      minutes: r.minutes,
      setpoint: r.setpoint,
      temp_start: r.temp_start,
      temp_end: r.temp_end,
      outdoor_start: round1(interp_at(outdoor_series, r.start)),
    }));

    const out: HouseThermalOut = {
      ok: true,
      source: 'home_assistant',
      window: { start: start_iso_s, end: end_iso_s, hours },
      quality,
      ...(caveats.length ? { caveats } : {}),
      hvac: {
        entity_id: climate_id,
        history_points: climate_points.length,
        coverage,
        heating_minutes: Math.round(heating_ms / 60000),
        cooling_minutes: Math.round(cooling_ms / 60000),
        heating_duty_pct: Number(((heating_ms / window_ms) * 100).toFixed(1)),
        cooling_duty_pct: Number(((cooling_ms / window_ms) * 100).toFixed(1)),
        heating_cycles: runs.filter((r) => r.action === 'heating').length,
        cooling_cycles: runs.filter((r) => r.action === 'cooling').length,
        runs: recent_runs,
        setpoints_seen,
      },
      outdoor: {
        temp_mean: round1(outdoor_summary.temp_mean),
        temp_min: round1(outdoor_summary.temp_min),
        temp_max: round1(outdoor_summary.temp_max),
        humidity_mean: round1(outdoor_summary.humidity_mean),
        wind_mean: round1(outdoor_summary.wind_mean),
        gust_max: round1(outdoor_summary.gust_max),
        irradiance_mean: round1(outdoor_summary.irradiance_mean),
      },
      hvac_energy: {
        estimated_cooling_kw: cool_est.kw,
        cooling_kwh,
        cooling_edges: cool_est.edges_used,
        estimated_heating_kw_electric: heat_est.kw,
        heating_kwh_electric: heating_kwh,
        heating_edges: heat_est.edges_used,
      },
      envelope: {
        cooling_degree_hours: cdh.value,
        heating_degree_hours: hdh.value,
        degree_hour_coverage: cdh.coverage,
        leakage_index_cooling: leak(cooling_kwh, cdh.value),
        leakage_index_heating: leak(heating_kwh, hdh.value),
      },
      zones: zones_out,
    };
    audit(ctx, input, out);
    return out;
  },
};
