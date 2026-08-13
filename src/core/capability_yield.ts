/**
 * capability_yield — "this ran 59 times and produced 3 rows; is that right?"
 * (2026-08-01)
 *
 * THE GAP THIS CLOSES. Every quality signal Hearth had before this keyed on
 * something going WRONG: `system_health` on error rate, `guard_feedback` on a
 * finalize-guard catch, the process-miss ledger on something failing. A
 * capability that runs cleanly and writes nothing trips none of them.
 * `extract_meeting_votes` ran 59 times over two months, fetched 82 documents,
 * recorded 3 votes, returned `ok: true` every time, and was reported healthy by
 * every detector — each for a defensible reason. It was reading the meeting of
 * October 2023 and correctly finding no votes in it.
 *
 * That is a CLASS, not a bug. On the live box today the latest run of each
 * background job shows the same shape in at least six more places:
 *
 *   acquire_pricing           fetched:8 → prices_recorded:0, commodity_recorded:0
 *   acquire_campaign_finance  fetched:3 → donations_recorded:0, filings_recorded:0
 *   knowledge_fetch           fetched:3 → items_shelved:0
 *   distill_jasper_style       corpus_files_read:0 → profile_chars:12675  (!)
 *
 * WHAT THIS MODULE IS. Pure, deterministic, no LLM, no I/O — the yield reader
 * plus the edge detector. `scan_capability_yield` supplies the runs (SQL over
 * audit_log rows that ALREADY EXIST, so this works retroactively) and emits the
 * `quality_signal`; the EXISTING GuardFeedbackDriver does the escalation. There
 * is deliberately no second closed loop here.
 *
 * THE LOAD-BEARING DISTINCTION. `considered: 0, produced: 0` is HONEST IDLE —
 * `scan_life_events` with no candidates has nothing to do and must never be a
 * miss. `considered: 8, produced: 0` is the pathology: work arrived and nothing
 * came out. Every rule below exists to keep those two apart, because a detector
 * that conflates them fires on half the roster every night and gets muted.
 *
 * PRECISION OVER RECALL, everywhere. The edge needs EVERY run in the window to
 * be barren with work available. A partially-productive job (`worklist: 8 →
 * recorded: 1`) does NOT escalate — its ratio is reported so a human can see it,
 * but a ratio threshold is a tuning knob and a false-positive machine, and the
 * `multi_part` complexity-signal lesson (a signal that fires on everything is
 * worse than no signal) is recent enough to still hurt. Report the low-yield
 * ones; escalate only the dead ones.
 *
 * WHY A CONVENTION READER IS NOT A LAW #1 VIOLATION. LAW #1 bans hard-coding
 * AROUND the model — pre-injection, per-case carve-outs, an `if (tool === 'x')`.
 * This is the opposite shape: ONE uniform rule applied to every tool with no
 * name list anywhere, in the same family as `miss_class_key`'s normalization or
 * `is_non_contact`. A tool that wants to be explicit declares `Tool.yield` and
 * the declaration wins; a tool matched by neither is REPORTED as uncovered
 * rather than silently skipped, because an invisible gap is the exact thing
 * this module exists to make visible.
 */

/** Where a run's yield reading came from — declaration beats convention, and
 *  `unmatched` is an honest "we could not tell", never a zero. */
export type YieldBasis =
  | 'declared'
  /**
   * A declared contract the author marked `armed: false` — the FIELDS are
   * authoritative (better than the convention's guess) but a zero is a quiet
   * night, not a defect. Reports; never escalates.
   */
  | 'declared_unarmed'
  /** The author declared this capability writes nothing by design. */
  | 'declared_none'
  | 'convention'
  | 'unmatched';

/** The declaration shape, mirroring `Tool.yield`. */
export type YieldDeclaration =
  | { produced: readonly string[]; considered?: readonly string[]; armed?: boolean }
  | { none: true; reason: string };

/**
 * Narrow the union. `none` is a deliberate exemption recorded by a human, NOT
 * an empty contract and NOT the same as leaving the field off — absence means
 * "nobody has looked at this yet", which is what the coverage lint hunts for.
 */
export function is_none_declaration(
  d: YieldDeclaration | undefined,
): d is { none: true; reason: string } {
  return !!d && 'none' in d && d.none === true;
}

export interface YieldReading {
  basis: YieldBasis;
  /** Max across matched produced fields — "did ANYTHING come out?". Null when unmatched. */
  produced: number | null;
  /** Max across matched considered fields. Null when nothing upstream was matched. */
  considered: number | null;
  /** The result keys that produced the two numbers (for the evidence pack). */
  produced_fields: string[];
  considered_fields: string[];
}

/** One classified run, as the scan hands it to the detector. */
export interface YieldRun {
  ts: string;
  /** False when the tool reported a gate/kill-switch no-op or an explicit skip. */
  active: boolean;
  reading: YieldReading;
}

export type YieldVerdict =
  /** Work arrived every run and nothing was written, on a tool that DECLARED
   *  what its output is. Escalates. */
  | 'barren'
  /**
   * The same reading, but derived from the name convention rather than a
   * declaration. REPORTED, never escalated.
   *
   * This distinction was paid for on the first live run, which flagged 15 of 54
   * capabilities and was wrong about most of them — in two different ways the
   * curated smoke fixtures could not show:
   *
   *  1. A DETECTOR's correct output is zero. `scan_system_health` returning
   *     `unhealthy: []` after checking 80 things is the GOOD outcome, not a
   *     defect. Same for `scan_program_health`, `audit_connector_affordances`,
   *     `drive_open_cases` — a scan that finds nothing wrong is healthy.
   *  2. Worse, the convention can find a produced field and still be reading
   *     the WRONG one. `refresh_subscriptions` returns `refreshed: [...]` with
   *     real entries, `scan_sources` returns `ingested: [...]`,
   *     `convene_proposal_court` returns `approved: [...]` — none of those
   *     words were in the token set, so the reader latched onto some other
   *     zero-valued field and called a productive job barren. A convention that
   *     matches nothing is honest (`uncovered`); a convention that matches the
   *     wrong field is confidently wrong.
   *
   * So a convention reading may INFORM a human and may never wake an agent. A
   * `Tool.yield` declaration is the author saying "zero output here is a
   * defect" — that assertion is what earns an escalation.
   */
  | 'suspected_barren'
  /** Produced something at least once — healthy, whatever the ratio. */
  | 'productive'
  /** Nothing upstream to act on. NOT a miss; the honest-idle case. */
  | 'idle'
  /** Neither a declaration nor the convention matched — coverage gap, reported. */
  | 'uncovered'
  /** Declared `{ none: true }` — a human judged it writes nothing by design. */
  | 'exempt'
  /** Fewer runs than the floor. Says nothing yet. */
  | 'insufficient_data';

export interface YieldAssessment {
  tool: string;
  verdict: YieldVerdict;
  runs_examined: number;
  /** Runs that actually did work (active + considered > 0). */
  active_runs: number;
  total_considered: number;
  total_produced: number;
  /** produced/considered across the window — OBSERVABILITY ONLY; never gates
   *  the verdict. A low ratio is worth a human's eye, not a wake. */
  yield_ratio: number | null;
  basis: YieldBasis;
  first_seen: string | null;
  last_seen: string | null;
  /** Human-readable one-liner for the miss gap / report. */
  summary: string;
}

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

export function capability_yield_enabled(): boolean {
  return process.env.HEARTH_CAPABILITY_YIELD !== '0';
}

function int_env(name: string, dflt: number, lo: number, hi: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  const v = Number.isFinite(raw) && raw > 0 ? raw : dflt;
  return Math.max(lo, Math.min(v, hi));
}

/** How many recent runs of a tool the verdict looks at. */
export function yield_window_runs(): number {
  return int_env('HEARTH_YIELD_WINDOW_RUNS', 10, 2, 200);
}

/** Minimum ACTIVE runs (work available) before `barren` can be returned. A
 *  daily job needs days to prove itself dead; one idle Tuesday proves nothing. */
export function yield_min_active_runs(): number {
  return int_env('HEARTH_YIELD_MIN_ACTIVE_RUNS', 3, 2, 100);
}

/* ------------------------------------------------------------------ */
/* 1. The yield reader                                                 */
/* ------------------------------------------------------------------ */

/**
 * Verb tokens that mark a result field as counting artifacts WRITTEN.
 * Matched as whole `_`-separated tokens, never as substrings — substring
 * matching is how `x.com` comes to match `netflix.com`.
 */
const PRODUCED_TOKENS: ReadonlySet<string> = new Set([
  'recorded', 'filed', 'written', 'wrote', 'shelved', 'added', 'created',
  'inserted', 'upserted', 'indexed', 'emitted', 'appended', 'saved',
  'opened', 'derived', 'synthesized', 'produced', 'stored', 'enrolled',
  'promoted', 'published', 'dispatched', 'graduated', 'applied',
  // Added after the first live run read the WRONG field on four real jobs and
  // called them barren: refresh_subscriptions reports `refreshed: [...]`,
  // scan_sources `ingested: [...]`, convene_proposal_court `approved: [...]`,
  // assess_competitive_items `assessed: 6`. Each had real output the reader
  // could not see. Grow this list from observed payloads, never from guesses.
  'refreshed', 'ingested', 'approved', 'assessed', 'advanced', 'nudged',
  'escalated', 'restarted', 'closed', 'resolved', 'archived', 'sent',
]);

/**
 * Verb/noun tokens that mark a field as counting upstream work AVAILABLE.
 * A run with zero of these had nothing to do and is idle, not barren.
 */
const CONSIDERED_TOKENS: ReadonlySet<string> = new Set([
  'considered', 'fetched', 'searched', 'scanned', 'read', 'due',
  'candidates', 'worklist', 'examined', 'checked', 'targeted', 'found',
  'needing', 'seen', 'available', 'pending', 'queued', 'eligible',
  'discovered', 'matched', 'inspected',
]);

/** A key carrying BOTH kinds of token is ambiguous; we decline to guess. */
function classify_key(key: string): 'produced' | 'considered' | null {
  const tokens = key.toLowerCase().split(/[_\s]+/).filter(Boolean);
  let produced = false;
  let considered = false;
  for (const t of tokens) {
    if (PRODUCED_TOKENS.has(t)) produced = true;
    if (CONSIDERED_TOKENS.has(t)) considered = true;
  }
  if (produced && considered) return null;
  if (produced) return 'produced';
  if (considered) return 'considered';
  return null;
}

/** A countable result value: a finite non-negative number, or an array's length. */
function count_of(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (Array.isArray(value)) return value.length;
  return null;
}

/** First declared field actually present in the result, with its count. */
function read_declared(
  result: Record<string, unknown>,
  fields: readonly string[] | undefined,
): { value: number; field: string } | null {
  if (!fields) return null;
  for (const f of fields) {
    if (!(f in result)) continue;
    const n = count_of(result[f]);
    if (n !== null) return { value: n, field: f };
  }
  return null;
}

/**
 * Read a run's yield out of its result object.
 *
 * `declared` (the tool's own `Tool.yield`) WINS when it matches — an explicit
 * contract is never second-guessed. Otherwise the convention reader scans
 * top-level fields only: no recursion, because a nested `per_model[].specs`
 * array is detail, not yield, and counting it would manufacture a productive
 * verdict out of noise.
 *
 * `produced`/`considered` are the MAX across matched fields, not the sum:
 * the question is "did anything come out?", so a run that recorded 0 votes but
 * added 3 members has produced something.
 */
export function read_yield(result: unknown, declared?: YieldDeclaration): YieldReading {
  const empty: YieldReading = {
    basis: 'unmatched',
    produced: null,
    considered: null,
    produced_fields: [],
    considered_fields: [],
  };
  // An explicit "writes nothing by design" short-circuits everything. There is
  // no reading to take, and the convention must not be allowed to invent one —
  // that is precisely how a healthy detector gets called barren.
  if (is_none_declaration(declared)) {
    return { ...empty, basis: 'declared_none' };
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return empty;
  const obj = result as Record<string, unknown>;

  // --- declared contract wins ---
  if (declared) {
    const p = read_declared(obj, declared.produced);
    if (p) {
      const c = read_declared(obj, declared.considered);
      return {
        // `armed` defaults to true — declaring fields without saying otherwise
        // means "a sustained zero here is a defect".
        basis: declared.armed === false ? 'declared_unarmed' : 'declared',
        produced: p.value,
        considered: c ? c.value : null,
        produced_fields: [p.field],
        considered_fields: c ? [c.field] : [],
      };
    }
    // Declared but absent from THIS result (a shape change, or an early
    // gate-return). Fall through to convention rather than reporting a
    // false zero — a wrong zero is exactly the alarm we must not raise.
  }

  // --- convention fallback ---
  let produced: number | null = null;
  let considered: number | null = null;
  const produced_fields: string[] = [];
  const considered_fields: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const kind = classify_key(key);
    if (!kind) continue;
    const n = count_of(value);
    if (n === null) continue;
    if (kind === 'produced') {
      produced_fields.push(key);
      produced = produced === null ? n : Math.max(produced, n);
    } else {
      considered_fields.push(key);
      considered = considered === null ? n : Math.max(considered, n);
    }
  }

  if (produced === null && considered === null) return empty;
  return {
    basis: 'convention',
    produced,
    considered,
    produced_fields: produced_fields.sort(),
    considered_fields: considered_fields.sort(),
  };
}

/**
 * Was this run gated off rather than genuinely executed? A kill-switched or
 * explicitly-skipped run says nothing about yield and must not count toward a
 * barren verdict — otherwise flipping a feature flag off looks like a defect.
 */
export function run_is_active(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return true;
  const obj = result as Record<string, unknown>;
  if (obj.enabled === false) return false;
  if (obj.skipped === true) return false;
  if (obj.ok === false) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* 2. The edge detector                                                */
/* ------------------------------------------------------------------ */

/**
 * Classify a tool's recent run series.
 *
 * `barren` requires EVERY active run in the window to have had work available
 * and written nothing — the strict reading, on purpose. One productive run
 * anywhere in the window makes the verdict `productive` no matter how poor the
 * ratio, because the alternative is a threshold that has to be tuned against
 * every job's natural hit rate and will be wrong for most of them.
 *
 * Runs arrive newest-first or oldest-first; order does not matter.
 */
export function assess_yield(tool: string, runs: readonly YieldRun[]): YieldAssessment {
  const window = runs.slice(0, yield_window_runs());
  const stamps = window.map((r) => r.ts).sort();
  const base = {
    tool,
    runs_examined: window.length,
    first_seen: stamps[0] ?? null,
    last_seen: stamps[stamps.length - 1] ?? null,
  };

  // Declared-exempt short-circuits before anything else. A tool a human has
  // judged to write nothing by design is not idle, not uncovered and not
  // barren — it is out of scope, and putting it in any bucket would make the
  // roster's coverage numbers lie about how much is actually triaged.
  if (window.length > 0 && window.every((r) => r.reading.basis === 'declared_none')) {
    return {
      ...base,
      verdict: 'exempt',
      active_runs: 0,
      total_considered: 0,
      total_produced: 0,
      yield_ratio: null,
      basis: 'declared_none',
      summary: `\`${tool}\` declares \`yield: { none: true }\` — it writes nothing by design.`,
    };
  }

  const covered = window.filter((r) => r.reading.basis !== 'unmatched');
  if (window.length > 0 && covered.length === 0) {
    return {
      ...base,
      verdict: 'uncovered',
      active_runs: 0,
      total_considered: 0,
      total_produced: 0,
      yield_ratio: null,
      basis: 'unmatched',
      summary:
        `\`${tool}\` ran ${window.length}× but neither a \`Tool.yield\` declaration nor the ` +
        `field-name convention matched its result — its yield is unknown, not zero. ` +
        `Declare \`yield: { produced: [...], considered: [...] }\` on the tool to cover it.`,
    };
  }

  // Most-authoritative basis in the window wins: an armed declaration beats an
  // unarmed one beats the convention's guess.
  const basis: YieldBasis = covered.some((r) => r.reading.basis === 'declared')
    ? 'declared'
    : covered.some((r) => r.reading.basis === 'declared_unarmed')
      ? 'declared_unarmed'
      : covered.length > 0
        ? 'convention'
        : 'unmatched';

  let total_considered = 0;
  let total_produced = 0;
  let active_runs = 0;
  let any_produced = false;

  for (const r of covered) {
    const { produced, considered } = r.reading;
    total_produced += produced ?? 0;
    total_considered += considered ?? 0;
    if ((produced ?? 0) > 0) any_produced = true;
    // "Active" = genuinely executed AND had upstream work. Both halves matter:
    // a gated run isn't evidence, and neither is a run with an empty inbox.
    if (r.active && (considered ?? 0) > 0) active_runs += 1;
  }

  const yield_ratio = total_considered > 0 ? total_produced / total_considered : null;
  const common = { ...base, active_runs, total_considered, total_produced, yield_ratio, basis };

  if (any_produced) {
    const ratio_note =
      yield_ratio !== null ? ` (${total_produced}/${total_considered} = ${(yield_ratio * 100).toFixed(0)}%)` : '';
    return {
      ...common,
      verdict: 'productive',
      summary: `\`${tool}\` produced ${total_produced} across ${window.length} run(s)${ratio_note}.`,
    };
  }

  if (active_runs < yield_min_active_runs()) {
    return {
      ...common,
      verdict: active_runs === 0 ? 'idle' : 'insufficient_data',
      summary:
        active_runs === 0
          ? `\`${tool}\` had no upstream work in ${window.length} run(s) — idle, not barren.`
          : `\`${tool}\` produced nothing in ${active_runs} working run(s) — below the ` +
            `${yield_min_active_runs()}-run floor to call it barren.`,
    };
  }

  const body =
    `\`${tool}\` ran ${window.length}× with work available on ${active_runs} of them ` +
    `(${total_considered} item(s) upstream) and wrote NOTHING — every run returned success. ` +
    `Error rate is clean; the capability is producing no output.`;

  // Only an ARMED declaration escalates.
  if (basis === 'declared_unarmed') {
    // The fields are authoritative here — the author named them — so the
    // numbers are trustworthy and only the ESCALATION is withheld. Say that,
    // rather than repeating the convention's "might be reading the wrong
    // field" caveat, which would be false and would erode the report.
    return {
      ...common,
      verdict: 'suspected_barren',
      summary:
        `${body} NOTE: the tool DECLARES these fields but is marked \`armed: false\` — a zero ` +
        `here is a normal quiet night, not a defect. Reported for a human; never escalated. ` +
        `Flip to \`armed: true\` only if a sustained zero would genuinely mean something broke.`,
    };
  }
  if (basis !== 'declared') {
    return {
      ...common,
      verdict: 'suspected_barren',
      summary:
        `${body} NOTE: read by field-name CONVENTION, not a declared contract — this may be a ` +
        `detector whose correct output is zero, or the convention may be reading the wrong ` +
        `field. Confirm by hand, then add \`yield: { produced: [...], considered: [...] }\` to ` +
        `the tool to arm it.`,
    };
  }

  return { ...common, verdict: 'barren', summary: body };
}

/**
 * The stable evidence_ref the miss chokepoint, the wake debounce and
 * `verify_fix_landed` all share.
 *
 * The `<subject>:<pattern>:<detail>` shape is load-bearing, not cosmetic:
 * `verify_fix_landed`'s `pattern_of()` reads segment INDEX 1 to pick which scan
 * owns a miss. A two-segment `yield:<tool>` would make the tool name look like
 * the pattern, the lookup would miss, and these misses would accumulate forever
 * — which is precisely the failure the ledger's verify step exists to prevent.
 */
export function yield_evidence_ref(tool: string): string {
  return `capability:yield:${tool}`;
}
