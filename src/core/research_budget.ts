/**
 * research_budget — "no time limit, within reason" made precise
 * (Deep Research v2 phase 5, 2026-07-31).
 *
 * ## The problem with a clock
 *
 * v1 stopped on wall-clock: a 5-minute slice, at most 8 detached slices, ~18
 * sources. That is a briefing, not an investigation, and worse, it is the wrong
 * KIND of limit — it cannot tell a run that is working hard from a run that is
 * stuck. Both look like "still going".
 *
 * The owner's ask was *"no time limit (within reason — Kate can determine if
 * something has hanged?)"*. The precise version of that is two separate ideas
 * that a clock conflates:
 *
 *   - **A budget** bounds how much WORK an investigation may do — sources read,
 *     investigator rounds spent. It is chosen by `depth`, and `exhaustive`
 *     should be measured in hundreds of sources rather than eighteen.
 *   - **Progress** is the liveness signal. An exhaustive run legitimately
 *     grinding for hours while its counters climb is HEALTHY and must never be
 *     killed. Only a *stationary* run is hung.
 *
 * **stalled ≠ slow.** That distinction is the whole module. Encode it here, in
 * pure functions, so the runner cannot accidentally reintroduce a timer.
 *
 * ## What counts as progress
 *
 * A signature over the counters that only ever climbs: sources read, rounds
 * spent, facets resolved, claims verified. A slice that ends with the signature
 * unchanged did nothing, whatever its phase transitions say — which is why
 * progress is measured HERE and not from the runner's `progressed` flag, which
 * flips true on a bare status change.
 */

export type ResearchDepth = 'quick' | 'standard' | 'exhaustive';

export const RESEARCH_DEPTHS: readonly ResearchDepth[] = ['quick', 'standard', 'exhaustive'];

export interface ResearchBudget {
  depth: ResearchDepth;
  /** Total sources READ across the whole investigation. */
  max_sources: number;
  /** Total agentic investigator rounds across all facets. */
  max_rounds: number;
  /**
   * Absolute backstop on detached slices. NOT the stop condition — the budget
   * above is. This exists only so a bug cannot spin forever; it is set well
   * clear of what the source/round budgets allow.
   */
  max_slices: number;
  /** Extra agentic rounds a single facet may spend before it must conclude. */
  rounds_per_facet: number;
  /**
   * How long ONE resumable slice may run.
   *
   * The slice is a resumability unit, not the investigation's stop condition —
   * but it still has to be long enough to contain the work, and government
   * record portals are slow. Measured on the live Daniel Torres re-run:
   * a single Texas county portal took **287 seconds**, which ate the entire
   * 5-minute standard slice and caused all six facets to be recorded
   * `not_attempted` even though the fetches were in flight and landed moments
   * later. An exhaustive run can afford much longer slices; that is most of
   * what "no time limit, within reason" buys in practice.
   */
  slice_ms: number;
  /**
   * How many times an `incomplete` run may be resumed to retry facets it never
   * got to attempt.
   *
   * This was a single hard-coded 2 in the runner, which quietly made both the
   * exhaustive budget AND the stall watchdog dead: a run converges to `done`
   * after at most three slices regardless of how many sources it was
   * authorised to read, and `no_progress_slices` therefore tops out at 2
   * against a threshold of 3. Scaling it with depth is what makes "exhaustive
   * keeps going" true, and it is what gives the watchdog slices to observe.
   */
  max_resume_attempts: number;
  label: string;
}

/**
 * The three budgets.
 *
 * `standard` is deliberately close to v1's real ceiling (~18 sources) so the
 * default behaviour is familiar; the point of the phase is that `exhaustive`
 * now EXISTS and is worth asking for.
 */
export const BUDGETS: Record<ResearchDepth, ResearchBudget> = {
  quick: {
    depth: 'quick',
    max_sources: 10,
    max_rounds: 8,
    max_slices: 6,
    rounds_per_facet: 1,
    slice_ms: 3 * 60_000,
    max_resume_attempts: 1,
    label: 'quick — a fast read, one pass per facet',
  },
  standard: {
    depth: 'standard',
    max_sources: 30,
    max_rounds: 24,
    max_slices: 16,
    rounds_per_facet: 2,
    // Unchanged from v1, so `standard` behaves exactly as before.
    slice_ms: 5 * 60_000,
    // Unchanged from the old hard-coded constant.
    max_resume_attempts: 2,
    label: 'standard — the default workup',
  },
  exhaustive: {
    depth: 'exhaustive',
    max_sources: 250,
    max_rounds: 160,
    max_slices: 120,
    rounds_per_facet: 5,
    // Long enough that one 287-second county portal cannot strand a facet.
    slice_ms: 20 * 60_000,
    // High enough that the run keeps going, and that a genuinely stuck one
    // accumulates the stationary slices the watchdog needs to see.
    max_resume_attempts: 25,
    label: 'exhaustive — keeps going until the facets are answered or the budget is spent',
  },
};

/**
 * Coerce a stored or model-supplied depth.
 *
 * `'deep'` is the LEGACY value every row written before this phase carries; it
 * maps to `standard` so old rows keep behaving as they did. Anything
 * unrecognised also lands on `standard` — the middle budget is the safe default
 * in both directions (an accidental `exhaustive` is expensive, an accidental
 * `quick` silently under-researches).
 */
export function normalize_depth(raw: string | null | undefined): ResearchDepth {
  const v = (raw ?? '').trim().toLowerCase();
  return (RESEARCH_DEPTHS as readonly string[]).includes(v) ? (v as ResearchDepth) : 'standard';
}

export function budget_for(depth: string | null | undefined): ResearchBudget {
  return BUDGETS[normalize_depth(depth)];
}

/** Monotonic work counters, persisted on the row's `state`. */
export interface BudgetCounters {
  /** Sources actually READ (not refused, not dropped). */
  sources_read: number;
  /** Agentic investigator rounds spent. */
  rounds_spent: number;
  /** Detached slices run. */
  slices_run: number;
  /** Consecutive slices that moved nothing. */
  no_progress_slices: number;
  /** Signature at the end of the previous slice. */
  last_progress_signature: number;
}

export const EMPTY_COUNTERS: BudgetCounters = {
  sources_read: 0,
  rounds_spent: 0,
  slices_run: 0,
  no_progress_slices: 0,
  last_progress_signature: 0,
};

export function counters_from(raw: Partial<BudgetCounters> | undefined): BudgetCounters {
  return { ...EMPTY_COUNTERS, ...(raw ?? {}) };
}

/**
 * A number that only climbs while real work happens.
 *
 * Deliberately NOT the runner's `progressed` flag: that flips true on a bare
 * status transition, so a run ping-ponging between phases without reading
 * anything would look alive forever. Facets resolved and claims verified are
 * included so a slice that spends its time verifying rather than fetching still
 * counts as working.
 */
export function progress_signature(input: {
  sources_read: number;
  rounds_spent: number;
  facets_resolved: number;
  claims_verified: number;
}): number {
  return (
    input.sources_read + input.rounds_spent + input.facets_resolved * 10 + input.claims_verified
  );
}

export interface BudgetVerdict {
  exhausted: boolean;
  /** Which limit bound, for the honest report. */
  which: 'sources' | 'rounds' | 'slices' | null;
  detail: string;
}

export function budget_status(c: BudgetCounters, b: ResearchBudget): BudgetVerdict {
  if (c.sources_read >= b.max_sources) {
    return {
      exhausted: true,
      which: 'sources',
      detail: `read ${c.sources_read} sources, the ${b.depth} limit`,
    };
  }
  if (c.rounds_spent >= b.max_rounds) {
    return {
      exhausted: true,
      which: 'rounds',
      detail: `spent ${c.rounds_spent} investigator rounds, the ${b.depth} limit`,
    };
  }
  if (c.slices_run >= b.max_slices) {
    return {
      exhausted: true,
      which: 'slices',
      detail: `ran ${c.slices_run} slices, the ${b.depth} backstop`,
    };
  }
  return { exhausted: false, which: null, detail: '' };
}

/** Sources this facet may still read, given what the investigation has spent. */
export function sources_remaining(c: BudgetCounters, b: ResearchBudget): number {
  return Math.max(0, b.max_sources - c.sources_read);
}

export function rounds_remaining(c: BudgetCounters, b: ResearchBudget): number {
  return Math.max(0, b.max_rounds - c.rounds_spent);
}

/**
 * How many consecutive stationary slices before a run is declared stalled.
 *
 * Two is too twitchy — a slice can legitimately spend itself on a phase that
 * moves no counter (a synthesis retry). Three consecutive slices doing NOTHING
 * is not slowness.
 */
/**
 * ⚠ THE STALL WATCHDOG IS AN EXHAUSTIVE-DEPTH MECHANISM. State it, because it
 * is a consequence of arithmetic rather than a choice anyone typed.
 *
 * A slice ends `incomplete` only while the run is still resumable, and each
 * such slice consumes exactly one resume attempt — so the number of slices that
 * BEGIN with an open status, and can therefore be observed by the check, is
 * bounded by `max_resume_attempts`. With quick=1 and standard=2 against a
 * threshold of 3, neither can ever reach it. Measured through the real runner:
 * standard converges to `done` at slice 3 with no_progress_slices at 2; quick
 * at slice 2 with 1.
 *
 * That is the RIGHT behaviour, not a gap. At quick and standard a stuck run
 * converges in two or three slices to an honest report whose facets are marked
 * `unanswerable` — the owner gets an answer, not an interruption. Asking them
 * to choose between "keep going / narrow / stop" over a run that was already
 * finishing would be noise. The watchdog exists for the case where a run could
 * otherwise grind for HOURS without moving, and only `exhaustive` can do that.
 *
 * So: if you raise `stall_threshold`, raise the exhaustive resume cap with it,
 * or you will silently switch the watchdog off everywhere.
 */
export function stall_threshold(): number {
  const raw = parseInt(process.env.HEARTH_RESEARCH_STALL_SLICES ?? '3', 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 3;
}

export function is_stalled(c: BudgetCounters): boolean {
  return c.no_progress_slices >= stall_threshold();
}

/**
 * Fold this slice's outcome into the counters.
 *
 * Pure, so the smoke can walk a whole lifecycle without a runner: hand it
 * signatures and watch `no_progress_slices` climb only when the signature
 * genuinely froze.
 */
export function record_slice(c: BudgetCounters, signature: number): BudgetCounters {
  const moved = signature > c.last_progress_signature;
  return {
    ...c,
    slices_run: c.slices_run + 1,
    no_progress_slices: moved ? 0 : c.no_progress_slices + 1,
    last_progress_signature: Math.max(signature, c.last_progress_signature),
  };
}

/**
 * The message Kate relays when a run stalls.
 *
 * Names the three things the owner can actually do, because "your research
 * stalled" with no next move is just an interruption. Written in her voice —
 * it goes out as an inbox flag and a push, not into a log.
 */
export function render_stall_notice(input: {
  subject: string;
  depth: ResearchDepth;
  counters: BudgetCounters;
  last_log_line: string | null;
  facets_answered: number;
  facets_total: number;
}): string {
  const { counters: c } = input;
  return (
    `The research on **${input.subject}** has stopped making progress — ` +
    `${input.facets_answered} of ${input.facets_total} questions answered after ` +
    `${c.sources_read} source(s) and ${c.rounds_spent} round(s), and the last ` +
    `${c.no_progress_slices} passes moved nothing.` +
    (input.last_log_line ? `\n\nLast thing it did: ${input.last_log_line}` : '') +
    `\n\nThree ways forward, whichever you prefer:\n` +
    `1. **Keep going with more budget** — ask me to research ${input.subject} again at ` +
    `exhaustive depth and I'll resume this same investigation with a much larger ` +
    `allowance.\n` +
    // "Narrow it" files a NEW, tighter investigation rather than editing this
    // one: `reopen_with_facts` deliberately does not rewrite `brief` (the
    // dossier and evidence trail belong to the question that was asked). Say
    // that, so the offer matches what actually happens.
    `2. **Narrow it** — tell me which one question matters most and I'll start a ` +
    `tighter investigation aimed just at that.\n` +
    `3. **Stop here** — I'll keep the partial report, which is honest about what it ` +
    `could and could not establish.\n\n` +
    `It is worth knowing this is a stall, not slowness: a run that is still finding ` +
    `things is never interrupted.`
  );
}

/** One line for the dossier so a budget-bounded report says so. */
export function render_budget_note(
  c: BudgetCounters,
  b: ResearchBudget,
  /** Facets still unresolved. Omitted/0 means everything was answered. */
  unresolved_facets = 0,
): string {
  const v = budget_status(c, b);
  if (!v.exhausted) return '';
  // Only claim the questions did NOT run out when some genuinely did not. A run
  // that answered every facet AND happened to hit its source limit was
  // otherwise told "this stopped because it read N sources, not because the
  // questions ran out" — a flat falsehood on a complete dossier, and exactly
  // the kind of confident wrong sentence this subsystem exists to stop.
  if (unresolved_facets === 0) {
    return (
      `### Budget\n\nThis investigation reached its ${b.depth} limit (${v.detail}), ` +
      `having answered everything that was asked.\n`
    );
  }
  return (
    `### Budget\n\nThis investigation stopped because it ${v.detail}, not because the ` +
    `questions ran out — ${unresolved_facets} were still open. Asking for it again at ` +
    `**exhaustive** depth resumes it with a larger allowance.\n`
  );
}
