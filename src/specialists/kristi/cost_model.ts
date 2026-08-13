/**
 * cost_model — Kristi's commodity-cost UNDERSTANDING layer (the pricing sibling
 * of `spec_metrics.ts`).
 *
 * Three jobs, all pure functions so the smoke can pin the math:
 *
 *  1. PRICE PLAUSIBILITY (write-side gate). `record_spec` has had a
 *     plausibility gate since the 4.2M-GB era; prices had NONE — a "$4" RTX PRO
 *     6000 (a misread "$4,xxx"), a decimal-shifted $85,000 DIMM, or a
 *     financing-per-month figure entered `commodity_prices` unchallenged and
 *     poisoned every downstream read (commodity_compare, premium_view, the
 *     base-unit backout, trends). Two layers, mirroring validateSpec's
 *     philosophy (catch the ABSOLUTE-garbage class; leave judgment to the
 *     analyst):
 *       - an absolute per-commodity-class USD window (deliberately generous —
 *         the DRAM squeeze makes big DDR5 kits genuinely expensive), and
 *       - a history-relative gate: a new point >4× or <¼× the recent median of
 *         its own series is almost certainly a misread/decimal shift, never a
 *         real one-day move in this market. Needs ≥2 prior points so a single
 *         bad seed can't lock a series shut.
 *
 *  2. TREND FIT. A log-linear OLS over a commodity's daily street-price series
 *     → a compounding **monthly drift %** (log-space, so +10%/mo means ×1.1
 *     each month) with r², point count, span, and residual dispersion. This is
 *     what turns "RAM feels expensive lately" into "DDR5 ECC street +8.2%/mo
 *     over 60 days, r²=0.91" — a falsifiable, sourced rate.
 *
 *  3. FORWARD PROJECTION. Compound the latest observed price by the fitted
 *     drift to a horizon, with an HONEST widening uncertainty band (residual
 *     noise scaled by √months + a third of the projected move). A projection
 *     is a labeled extrapolation of the observed series, never a fact — the
 *     callers (cost_outlook) carry that label all the way to the surface.
 */

import type { CommodityClass } from '@memory/stores/kristi_workstations';

// ── price plausibility windows ───────────────────────────────────────────────

/**
 * Absolute USD sanity windows per commodity class — wide on purpose. These
 * catch only the can't-be-true class (a $4 pro GPU, a $200k SSD); the
 * history-relative gate below catches the subtler decimal shifts. OEM
 * configurator deltas for max-capacity memory legitimately run to five
 * figures under the DRAM squeeze, hence the high ceilings.
 */
export const COMMODITY_PRICE_WINDOWS: Record<CommodityClass, [number, number]> = {
  gpu: [50, 30_000],
  cpu: [40, 25_000],
  memory: [10, 120_000],
  storage: [15, 40_000],
  psu: [20, 3_000],
  cooling: [10, 3_000],
  other: [5, 120_000],
};

/** Whole-system (SKU configuration) price window. A workstation under $300 or
 *  over $250k is a misread, not a price. */
export const SYSTEM_PRICE_WINDOW: [number, number] = [300, 250_000];

/** How far a new point may sit from its series' recent median before it reads
 *  as a misread (4× either way — bigger than any real day-over-day move for
 *  these commodities, smaller than a decimal shift's 10×). */
export const OUTLIER_RATIO = 4;

export interface PriceVerdict {
  ok: boolean;
  reason?: string;
}

/** Recent-history reference for the relative gate: the median of the series'
 *  recent points and how many points back it. */
export interface PriceReference {
  median: number;
  n: number;
}

/**
 * Per-GB price FLOORS for capacity-bearing classes — the first-observation
 * defense the relative gate can't provide (it needs history). A "32GB DDR5
 * ECC RDIMM" at $32 (~$1/GB amid a DRAM squeeze) is a misread, not a deal;
 * same for multi-TB SSDs at pennies/GB. Floors only — ceilings stay with the
 * absolute window (OEM markups make per-GB ceilings unreliable). The capacity
 * is parsed from the canonical name; no capacity in the name → no floor.
 */
export const PER_GB_FLOORS: Partial<Record<CommodityClass, number>> = {
  memory: 1.5, // $/GB — DDR5 ECC street has not been below ~$2/GB in years
  storage: 0.015, // $/GB — ~$15/TB is below any NVMe street price
};

function parsed_capacity_gb(commodity: string): number | null {
  const m = commodity.match(/(\d+(?:\.\d+)?)\s*(TB|GB)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return /tb/i.test(m[2]!) ? n * 1024 : n;
}

/**
 * Write-side gate for one commodity price observation. `reference` is the
 * recent median of the SAME series (commodity + vendor + price_kind) when the
 * store has one; the relative gate only engages at n ≥ 2 so one bad seed point
 * can't reject every correct write that follows. `commodity` (the canonical
 * name) enables the per-GB floor for capacity-bearing classes.
 */
export function validate_commodity_price(
  commodity_class: CommodityClass,
  price: number,
  reference?: PriceReference | null,
  commodity?: string,
): PriceVerdict {
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, reason: `price ${price} is not a positive number` };
  }
  const [lo, hi] = COMMODITY_PRICE_WINDOWS[commodity_class] ?? COMMODITY_PRICE_WINDOWS.other;
  if (price < lo || price > hi) {
    return {
      ok: false,
      reason: `$${price} is implausible for a ${commodity_class} (expected $${lo}–$${hi}) — likely a misread; re-read the source`,
    };
  }
  const floor = PER_GB_FLOORS[commodity_class];
  if (floor && commodity) {
    const gb = parsed_capacity_gb(commodity);
    if (gb && price / gb < floor) {
      return {
        ok: false,
        reason:
          `$${price} for ${gb}GB is $${(price / gb).toFixed(2)}/GB — below the $${floor}/GB plausibility floor for ${commodity_class}; ` +
          `likely a misread (accessory price? per-month figure?); re-read the source`,
      };
    }
  }
  if (reference && reference.n >= 2 && reference.median > 0) {
    const ratio = price / reference.median;
    if (ratio > OUTLIER_RATIO || ratio < 1 / OUTLIER_RATIO) {
      return {
        ok: false,
        reason:
          `$${price} is ${ratio > 1 ? `${ratio.toFixed(1)}×` : `1/${(1 / ratio).toFixed(1)} of`} this series' recent median ` +
          `($${reference.median} over ${reference.n} points) — suspected misread/decimal shift; re-read the source ` +
          `(a real move this large would show up gradually across days)`,
      };
    }
  }
  return { ok: true };
}

/** Write-side gate for a whole-system price observation (list or sale). */
export function validate_system_price(price: number): PriceVerdict {
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, reason: `price ${price} is not a positive number` };
  }
  const [lo, hi] = SYSTEM_PRICE_WINDOW;
  if (price < lo || price > hi) {
    return {
      ok: false,
      reason: `$${price} is implausible for a whole workstation configuration (expected $${lo}–$${hi}) — likely a misread (component price? financing/month?); re-read the source`,
    };
  }
  return { ok: true };
}

// ── trend fit (log-linear drift) ─────────────────────────────────────────────

export interface SeriesPoint {
  date: string; // YYYY-MM-DD
  price: number;
}

export interface DriftFit {
  /** Compounding monthly drift, % (+8.2 = ×1.082 per month). */
  monthly_pct: number;
  /** Goodness of fit in log space, 0–1. */
  r2: number;
  /** Distinct daily points the fit used. */
  n: number;
  /** Days between first and last point. */
  span_days: number;
  /** Residual dispersion as a % of price (log-space sigma, converted). */
  sigma_pct: number;
  first_date: string;
  last_date: string;
  latest_price: number;
}

/** Minimum history for a fit: 3 distinct days spanning ≥ 14 days. Below that a
 *  "trend" is two points and a prayer — callers fall back to class drift or
 *  hold the price flat, and say so. */
export const MIN_FIT_POINTS = 3;
export const MIN_FIT_SPAN_DAYS = 14;

const DAYS_PER_MONTH = 30.44;

/**
 * Log-linear OLS over a daily price series → compounding monthly drift.
 * Returns null when the history can't support a fit (too few points / span /
 * non-positive prices). Series may arrive unsorted; one point per date is
 * assumed (the store's series read guarantees it).
 */
export function fit_drift(series: SeriesPoint[]): DriftFit | null {
  const pts = series
    .filter((p) => p && Number.isFinite(p.price) && p.price > 0 && !Number.isNaN(Date.parse(p.date)))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (pts.length < MIN_FIT_POINTS) return null;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const t0 = Date.parse(first.date);
  const span_days = Math.round((Date.parse(last.date) - t0) / 86_400_000);
  if (span_days < MIN_FIT_SPAN_DAYS) return null;

  const xs = pts.map((p) => (Date.parse(p.date) - t0) / 86_400_000);
  const ys = pts.map((p) => Math.log(p.price));
  const n = pts.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return null; // all same day (shouldn't happen post-span check)
  const slope = sxy / sxx; // ln-price per day
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  // Residual sigma in log space → % dispersion.
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const yhat = my + slope * (xs[i]! - mx);
    const r = ys[i]! - yhat;
    sse += r * r;
  }
  const sigma = n > 2 ? Math.sqrt(sse / (n - 2)) : 0;
  return {
    monthly_pct: round1((Math.exp(slope * DAYS_PER_MONTH) - 1) * 100),
    r2: Math.round(r2 * 100) / 100,
    n,
    span_days,
    sigma_pct: round1((Math.exp(sigma) - 1) * 100),
    first_date: first.date,
    last_date: last.date,
    latest_price: last.price,
  };
}

export type TrendDirection = 'up' | 'down' | 'flat';
export type TrendConfidence = 'low' | 'medium' | 'high';

/** Direction with a dead band: under ±1.5%/mo is noise, not a trend. */
export function trend_direction(fit: DriftFit): TrendDirection {
  if (fit.monthly_pct >= 1.5) return 'up';
  if (fit.monthly_pct <= -1.5) return 'down';
  return 'flat';
}

/** Confidence from history depth + fit quality. Conservative on purpose — a
 *  projection inherits this and Kristi must label low-confidence outlooks. */
export function trend_confidence(fit: DriftFit): TrendConfidence {
  if (fit.n >= 6 && fit.span_days >= 45 && fit.r2 >= 0.5) return 'high';
  if (fit.n >= 4 && fit.span_days >= 21 && fit.r2 >= 0.25) return 'medium';
  return 'low';
}

// ── forward projection ───────────────────────────────────────────────────────

export interface PriceProjection {
  months: number;
  /** Point estimate: latest × (1 + drift)^months. */
  projected: number;
  /** Honest band, ±%: residual noise scaled by √months plus a third of the
   *  projected move (drift uncertainty grows with the lever arm). Capped at
   *  60% — past that the number is "we don't know", and the cap says so. */
  band_pct: number;
  low: number;
  high: number;
}

export function project_price(latest: number, monthly_pct: number, months: number, sigma_pct = 0): PriceProjection {
  const factor = Math.pow(1 + monthly_pct / 100, months);
  const projected = latest * factor;
  const move_pct = Math.abs(factor - 1) * 100;
  const band_pct = Math.min(60, Math.max(5, sigma_pct * Math.sqrt(months) + move_pct / 3));
  return {
    months,
    projected: round2(projected),
    band_pct: round1(band_pct),
    low: round2(projected * (1 - band_pct / 100)),
    high: round2(projected * (1 + band_pct / 100)),
  };
}

/** Median of an array (null on empty) — the class-drift fallback aggregator. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// ── benchmark scores (the performance axis of price-per-performance) ────────

/**
 * The CANONICAL benchmark keys Kristi records — a closed set on purpose.
 * Scores are only comparable WITHIN one benchmark, so a free-text benchmark
 * name would silently mix scales ("PassMark" vs "Passmark CPU Mark" vs
 * "cpubenchmark") and corrupt every perf-per-dollar ranking. Each carries a
 * plausibility window (same philosophy as the price windows: catch the
 * can't-be-true class — a CPU Mark of 47 is a misread, not a slow chip).
 */
export const KNOWN_BENCHMARKS: Record<
  string,
  { label: string; component_class: 'cpu' | 'gpu'; range: [number, number] }
> = {
  passmark_cpu: { label: 'PassMark CPU Mark', component_class: 'cpu', range: [1_000, 250_000] },
  passmark_g3d: { label: 'PassMark G3D Mark', component_class: 'gpu', range: [500, 80_000] },
  geekbench6_single: { label: 'Geekbench 6 single-core', component_class: 'cpu', range: [500, 6_000] },
  geekbench6_multi: { label: 'Geekbench 6 multi-core', component_class: 'cpu', range: [1_000, 60_000] },
};

/** Write-side gate for a benchmark score: the benchmark key must be canonical,
 *  match the component's class, and the score must sit in its window. */
export function validate_benchmark_score(
  benchmark: string,
  component_class: 'cpu' | 'gpu',
  score: number,
): PriceVerdict {
  const b = KNOWN_BENCHMARKS[benchmark];
  if (!b) {
    return { ok: false, reason: `unknown benchmark '${benchmark}' — use one of: ${Object.keys(KNOWN_BENCHMARKS).join(', ')}` };
  }
  if (b.component_class !== component_class) {
    return { ok: false, reason: `${b.label} is a ${b.component_class} benchmark — not valid for a ${component_class}` };
  }
  if (!Number.isFinite(score) || score < b.range[0] || score > b.range[1]) {
    return {
      ok: false,
      reason: `${b.label} score ${score} is implausible (expected ${b.range[0]}–${b.range[1]}) — likely a misread`,
    };
  }
  return { ok: true };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
