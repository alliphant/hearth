/**
 * spec_metrics — Kristi's comparable-spec UNDERSTANDING layer.
 *
 * The HP-leads / HP-gaps view (and swimlane sanity) compares scalar specs across
 * SKUs. Doing that on free-text EAV with "grab the first number" produced
 * nonsense — e.g. "4096 GB (4 TB)" parsed to 4096 then ×1024 = 4.2M GB; "16GB
 * base, up to 512GB" parsed to 16 not 512; "up to 60 cores (Xeon w9-3595X)"
 * parsed to 3595; "Memory Slots: 4x DDR5" leaked in as 4 GB of memory.
 *
 * This module is the single source of truth for which specs are comparable and
 * how to read them ACCURATELY:
 *   - `match` / `reject` map a messy spec_key to ONE canonical metric (and keep
 *     near-misses like "Memory Slots" / "GPU memory" OUT of "system memory").
 *   - `parse(value, unit)` is UNIT-ANCHORED: it reads the number attached to the
 *     metric's own unit (the digits before "GB"/"cores"/"W"…), takes the MAX
 *     when a range/list is given, converts TB→GB, and falls back to the EAV
 *     `unit` column when the value is a bare number. A CPU model number sitting
 *     in the value can't masquerade as the core count.
 *   - `range` is a plausibility gate — a value outside it is rejected as a
 *     mis-read (this is what stops a 4.2M-GB or a 3595-core figure).
 *   - `meaning` is the workload significance, so Kristi's view can say what a
 *     delta MEANS (which workload it helps), not just print two numbers.
 *   - `outlier_guard` marks the high-cardinality metrics where a same-lane value
 *     wildly below its peers is almost certainly bad data (a mid/expert tower
 *     with "8 max cores"), to be dropped rather than printed as a fake lead.
 *
 * Higher is better for every metric here (the gap view's lead = hp − rival
 * assumes it), so non-monotonic specs (memory TYPE, CPU model) are deliberately
 * NOT comparable metrics — they're context, surfaced elsewhere, never "led" on.
 */

export interface ComparableMetric {
  key: string; // canonical id
  label: string; // display label (also the gap view's spec_key)
  unit: string;
  /** spec_key must match this to be considered for the metric. */
  match: RegExp;
  /** …and must NOT match this (rejects near-miss keys for the metric). */
  reject?: RegExp;
  /** Unit-anchored value parser → the comparable number, or null. */
  parse: (value: string, unit?: string) => number | null;
  /** Plausibility window; a parsed value outside it is treated as a mis-read. */
  range: [number, number];
  /** What a delta in this metric MEANS for a buyer/workload. */
  meaning: string;
  /** Drop a same-lane value far below its peers as suspect bad data (only for
   *  high-cardinality metrics where that's a reliable signal). */
  outlier_guard: boolean;
}

// ── value parsers (unit-anchored, MAX-picking) ──────────────────────────────

/** Largest number that appears immediately before any of `units` (word-boundary
 *  matched), e.g. anchored(v, ['gb','tb']) on "16GB base up to 4 TB" → 4096. */
function anchoredMaxGB(value: string): number | null {
  let best: number | null = null;
  for (const m of value.replace(/,/g, '').matchAll(/(\d+(?:\.\d+)?)\s*(tb|gb)\b/gi)) {
    const gb = Number(m[1]) * (/tb/i.test(m[2]!) ? 1024 : 1);
    if (Number.isFinite(gb) && (best === null || gb > best)) best = gb;
  }
  return best;
}

/** Largest integer immediately before a keyword (e.g. /cores?/), max over all. */
function anchoredMaxInt(value: string, kw: RegExp): number | null {
  const re = new RegExp(`(\\d+)\\s*-?\\s*(?:${kw.source})`, 'gi');
  let best: number | null = null;
  for (const m of value.replace(/,/g, '').matchAll(re)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && (best === null || n > best)) best = n;
  }
  return best;
}

/** First bare number in the value (fallback when the value is just "512"). */
function bareNum(value: string): number | null {
  const m = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function memoryGB(value: string, unit?: string): number | null {
  const anchored = anchoredMaxGB(value);
  if (anchored !== null) return anchored;
  // Bare number — interpret via the EAV unit column (default GB).
  const n = bareNum(value);
  if (n === null) return null;
  return /tb/i.test(unit ?? '') ? n * 1024 : n;
}

/** Integer metric: prefer a keyword-anchored figure (so a CPU model number in
 *  the string can't win), else the bare number. */
function anchoredInt(kw: RegExp): (value: string, unit?: string) => number | null {
  return (value) => anchoredMaxInt(value, kw) ?? bareNum(value);
}

// ── the canonical comparable-metric registry ────────────────────────────────

export const COMPARABLE_METRICS: ComparableMetric[] = [
  {
    key: 'max_cores',
    label: 'Max cores',
    unit: 'cores',
    match: /\b(max\s*)?cores?\b|core count/i,
    reject: /gpu|cuda|tensor|\brt\b|graphics|memory/i, // not GPU/CUDA/RT cores
    parse: anchoredInt(/cores?|c\b/),
    range: [4, 256],
    meaning: 'Multi-core throughput — FEA/CFD solvers, simulation, batch render; gains flatten past ~12-16 for implicit FEA and clock-bound CAD modeling.',
    outlier_guard: true,
  },
  {
    key: 'max_threads',
    label: 'Max threads',
    unit: 'threads',
    match: /\b(max\s*)?threads?\b/i,
    reject: /gpu/i,
    parse: anchoredInt(/threads?|t\b/),
    range: [8, 512],
    meaning: 'Concurrency for embarrassingly-parallel batch work (render, multi-job EDA/sim); secondary to physical cores for licensed solvers.',
    outlier_guard: true,
  },
  {
    key: 'max_gpu_count',
    label: 'Max GPUs',
    unit: 'GPUs',
    match: /\b(max\s*)?gpus?\b|gpu count|graphics cards?|gpu slots?/i,
    reject: /memory|vram|video memory|tdp|cuda|tensor/i,
    parse: anchoredInt(/gpus?|graphics cards?|cards?/),
    range: [1, 8],
    meaning: 'Parallel GPU render / multi-GPU compute. Viewport needs one; render scales near-linearly (engine-dependent, no VRAM pooling); >4 usually means a server, not a workstation.',
    outlier_guard: false, // small integers — a large ratio can be legitimate
  },
  {
    key: 'max_memory_gb',
    label: 'Max memory (GB)',
    unit: 'GB',
    match: /\b(max\s*)?(system\s*)?(memory|ram)\b/i,
    reject: /slot|type|speed|channel|bandwidth|gpu|vram|video|interface|form|ddr\d/i,
    parse: memoryGB,
    range: [16, 8192],
    meaning: 'In-core capacity — large CAE solves (CPU sparse-direct wants 128-512GB+), big M&E scenes, reality-capture point clouds, many VMs / large datasets.',
    outlier_guard: true,
  },
  {
    key: 'pcie_lanes',
    label: 'PCIe lanes',
    unit: 'lanes',
    match: /pcie[\s-]*lanes?|express\s*lanes?/i, // NOT a bare "lanes"
    reject: /memory/i,
    parse: anchoredInt(/lanes?/),
    range: [16, 160],
    meaning: 'Total usable expansion bandwidth — multi-GPU + NVMe + 100GbE NICs without contention; the platform tax consumer boards pay.',
    outlier_guard: true,
  },
  {
    key: 'pcie_gen',
    label: 'PCIe generation',
    unit: 'gen',
    match: /pcie\s*(gen|generation)|pci.?express\s*gen/i,
    parse: anchoredInt(/gen|generation/),
    range: [3, 6],
    meaning: 'Per-lane I/O bandwidth ceiling — GPU↔host and NVMe throughput; Gen5→Gen6 doubles it.',
    outlier_guard: false,
  },
  {
    key: 'max_psu_w',
    label: 'PSU (W)',
    unit: 'W',
    match: /\bpsu\b|power supply|wattage|\bwatts?\b/i,
    reject: /tdp|gpu tdp|cpu tdp/i,
    parse: anchoredInt(/w(?:atts?)?/),
    range: [200, 3000],
    meaning: 'Total power headroom — caps how many GPUs + CPU TDP the chassis can actually feed; the real multi-GPU ceiling alongside the wall circuit.',
    outlier_guard: true,
  },
  {
    key: 'cpu_sockets',
    label: 'Sockets',
    unit: 'sockets',
    match: /\bsockets?\b/i,
    parse: anchoredInt(/sockets?/),
    range: [1, 4],
    meaning: 'Single vs dual socket — dual doubles core count + memory channels for the heaviest CAE, at cost and clock.',
    outlier_guard: false,
  },
  {
    key: 'memory_channels',
    label: 'Memory channels',
    unit: 'channels',
    match: /memory channels?|\bchannels?\b/i,
    reject: /storage|pcie/i,
    parse: anchoredInt(/channels?/),
    range: [2, 16],
    meaning: 'Memory bandwidth — bandwidth-bound CFD, particle sim, and GPU-out-of-core feeding scale with channel count.',
    outlier_guard: false,
  },
];

export interface NormalizedSpec {
  key: string;
  label: string;
  unit: string;
  value: number;
  higher_better: true;
  meaning: string;
}

/**
 * Map one EAV spec (key + value + optional unit column) to a validated,
 * comparable metric — or null if it isn't comparable or the value is
 * implausible. This replaces the old regex+first-number normalize_metric.
 */
export function normalizeSpec(spec_key: string, spec_value: string, unit?: string): NormalizedSpec | null {
  if (!spec_key || !spec_value) return null;
  for (const m of COMPARABLE_METRICS) {
    if (!m.match.test(spec_key)) continue;
    if (m.reject && m.reject.test(spec_key)) continue;
    const v = m.parse(spec_value, unit);
    if (v === null) return null;
    if (v < m.range[0] || v > m.range[1]) return null; // implausible → mis-read, drop
    return { key: m.key, label: m.label, unit: m.unit, value: v, higher_better: true, meaning: m.meaning };
  }
  return null;
}

/** Look up a metric's meaning by canonical key (for the gap view's annotation). */
export function metricByKey(key: string): ComparableMetric | undefined {
  return COMPARABLE_METRICS.find((m) => m.key === key);
}

/**
 * WRITE-side gate: should this EAV spec be allowed into `sku_specs`?
 *
 * The companion to `normalizeSpec` (the READ side). It answers a narrower
 * question — "is this value safe to STORE" — and is deliberately PERMISSIVE
 * about everything that isn't a comparable scalar:
 *   - A `spec_key` that matches NO comparable metric is CONTEXT (Memory Type,
 *     Form Factor, Supported CPUs, Chassis…) — always store it; there's no
 *     plausibility window to violate, and these never feed the gap view's
 *     subtraction. → { ok: true }.
 *   - A `spec_key` that DOES match a comparable metric but whose value can't be
 *     parsed to its unit, or parses to a figure outside the metric's
 *     plausibility `range`, is an ABSOLUTE mis-read (a 4.2M-GB memory figure, a
 *     3595-"core" CPU model number, "512 cores") — reject it so the garbage
 *     never enters the store. → { ok: false, metric, reason }.
 *   - A comparable value that parses AND sits in range is stored. → { ok: true, metric }.
 *
 * This catches the ABSOLUTE-garbage class only. A lane-relatively-low value (8
 * cores for an expert tower) is plausible in absolute terms and passes here by
 * design — it's caught downstream by the read-time `dropSuspectOutliers` and the
 * extractor's accuracy discipline, not by this gate.
 */
export function validateSpec(
  spec_key: string,
  spec_value: string,
  unit?: string,
): { ok: boolean; metric?: string; reason?: string } {
  if (!spec_key) return { ok: true };
  for (const m of COMPARABLE_METRICS) {
    if (!m.match.test(spec_key)) continue;
    if (m.reject && m.reject.test(spec_key)) continue;
    // It's a comparable metric — the value must be readable AND plausible.
    const v = m.parse(spec_value, unit);
    if (v === null) {
      return { ok: false, metric: m.key, reason: `unparseable value for ${m.label} (${m.unit})` };
    }
    if (v < m.range[0] || v > m.range[1]) {
      return {
        ok: false,
        metric: m.key,
        reason: `${m.label} ${v} ${m.unit} is implausible (expected ${m.range[0]}–${m.range[1]}) — mis-read`,
      };
    }
    return { ok: true, metric: m.key };
  }
  // No comparable metric matched → context spec, always storable.
  return { ok: true };
}

/** Within one (lane, metric) group of values, flag entries that are almost
 *  certainly bad data: for an outlier-guarded metric, a value below
 *  `frac` × the group max is treated as a mis-read and dropped from the
 *  comparison (so "Dell T4 = 8 cores" can't print "HP leads by 40"). Returns
 *  the surviving values + whether anything was dropped as suspect. */
export function dropSuspectOutliers<T extends { value: number }>(
  entries: T[],
  metricKey: string,
  frac = 0.35,
): { kept: T[]; suspect: boolean } {
  const m = metricByKey(metricKey);
  if (!m || !m.outlier_guard || entries.length < 2) return { kept: entries, suspect: false };
  const max = Math.max(...entries.map((e) => e.value));
  const floor = max * frac;
  const kept = entries.filter((e) => e.value >= floor);
  return { kept, suspect: kept.length < entries.length };
}
