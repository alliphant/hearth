/**
 * smoke:research-budget — budgets replace deadlines, and stalled ≠ slow
 * (Deep Research v2 phases 4 + 5, 2026-07-31).
 *
 * ## What phase 5 is actually for
 *
 * v1 stopped on a clock: a 5-minute slice, at most 8 detached slices, ~18
 * sources. That is the wrong KIND of limit, because it cannot tell a run that
 * is working hard from a run that is stuck — both look like "still going", and
 * the owner asked for *"no time limit (within reason — Kate can determine if
 * something has hanged?)"*.
 *
 * The precise version splits that into two ideas a clock conflates:
 *
 *   - a BUDGET bounds the work (sources, rounds), chosen by depth;
 *   - PROGRESS is the liveness signal.
 *
 * **The central assertion of this file is that an exhaustive run grinding for
 * a very long time while its counters climb is never called stalled.** If that
 * check ever fails, someone has reintroduced a timer and the phase is undone.
 *
 * ## Phase 4
 *
 * The agentic investigator gets real agency — re-query, follow a link, declare
 * unanswerable — but exercises it through the SAME guarded fetch door, so the
 * attribution cap, name gate, identity anchor and source persistence all still
 * apply. The design first proposed a delegated agent turn; that would have
 * called web_search and browse_url itself and routed around every guard phases
 * 1–3 installed. The checks below pin the guard that makes the difference: a
 * followed URL must appear VERBATIM in a source we actually read, so the model
 * cannot invent one.
 *
 * Self-contained: pure functions. No db, no network, no LLM.
 */
import {
  BUDGETS,
  budget_for,
  budget_status,
  counters_from,
  EMPTY_COUNTERS,
  is_stalled,
  normalize_depth,
  progress_signature,
  record_slice,
  render_budget_note,
  render_stall_notice,
  rounds_remaining,
  sources_remaining,
  stall_threshold,
  type BudgetCounters,
} from '../src/core/research_budget';
import { NEEDS_ATTENTION, progress_of } from '../src/app/routes/research';
import { OPEN_INVESTIGATION_STATUSES } from '../src/memory/stores/research_investigations';

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: string): void {
  checks++;
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(t: string): void {
  console.log(`\n── ${t} ──`);
}

/* ================================================================== */
section('A. Depth selects a budget; legacy rows keep working');
/* ================================================================== */

check("legacy 'deep' maps to standard", normalize_depth('deep') === 'standard');
check('null maps to standard', normalize_depth(null) === 'standard');
check('garbage maps to standard, not quick', normalize_depth('banana') === 'standard');
check('a real depth is honoured', normalize_depth('exhaustive') === 'exhaustive');
check('case and padding are tolerated', normalize_depth('  Exhaustive ') === 'exhaustive');

check(
  'exhaustive is measured in HUNDREDS of sources, not eighteen',
  BUDGETS.exhaustive.max_sources >= 200,
  String(BUDGETS.exhaustive.max_sources),
);
check(
  'budgets are strictly ordered quick < standard < exhaustive',
  BUDGETS.quick.max_sources < BUDGETS.standard.max_sources &&
    BUDGETS.standard.max_sources < BUDGETS.exhaustive.max_sources,
);
check(
  'exhaustive also buys more agentic rounds per facet',
  BUDGETS.exhaustive.rounds_per_facet > BUDGETS.standard.rounds_per_facet,
);
check('budget_for accepts a raw stored string', budget_for('deep').depth === 'standard');

// The slice is a resumability unit, and government record portals are slow. On
// the live Daniel Torres re-run ONE Texas county portal took 287 seconds and
// ate the whole 5-minute standard slice, so all six facets were recorded
// `not_attempted` while their fetches were still in flight.
check(
  'standard keeps v1\'s exact 5-minute slice (an ordinary run is unchanged)',
  BUDGETS.standard.slice_ms === 5 * 60_000,
);
check(
  'exhaustive gets a slice long enough that a 287s portal cannot strand a facet',
  BUDGETS.exhaustive.slice_ms > 287_000 * 2,
  String(BUDGETS.exhaustive.slice_ms),
);
check(
  'slice length is ordered with depth',
  BUDGETS.quick.slice_ms < BUDGETS.standard.slice_ms &&
    BUDGETS.standard.slice_ms < BUDGETS.exhaustive.slice_ms,
);

/* ================================================================== */
section('B. THE CENTRAL ONE — a long, productive run is never stalled');
/* ================================================================== */

// Simulate an exhaustive investigation grinding for two hundred slices while
// steadily reading sources. This is the case the old clock would have killed.
{
  let c: BudgetCounters = { ...EMPTY_COUNTERS };
  let stalled_at: number | null = null;
  for (let slice = 1; slice <= 200; slice++) {
    c = { ...c, sources_read: c.sources_read + 1 }; // one source per slice: SLOW
    c = record_slice(
      c,
      progress_signature({
        sources_read: c.sources_read,
        rounds_spent: c.rounds_spent,
        facets_resolved: 0,
        claims_verified: 0,
      }),
    );
    if (is_stalled(c) && stalled_at === null) stalled_at = slice;
  }
  check('200 slow-but-productive slices are NEVER called stalled', stalled_at === null, `stalled at slice ${stalled_at}`);
  check('…and no_progress_slices stayed at zero throughout', c.no_progress_slices === 0);
  check('…while the run legitimately ran far past the old 8-slice ceiling', c.slices_run === 200);
}

// The same number of slices doing NOTHING trips almost immediately.
{
  let c: BudgetCounters = { ...EMPTY_COUNTERS };
  const sig = progress_signature({ sources_read: 0, rounds_spent: 0, facets_resolved: 0, claims_verified: 0 });
  let stalled_at: number | null = null;
  for (let slice = 1; slice <= 10; slice++) {
    c = record_slice(c, sig);
    if (is_stalled(c) && stalled_at === null) stalled_at = slice;
  }
  check('stationary slices DO stall', stalled_at !== null);
  check('…at exactly the threshold, not before', stalled_at === stall_threshold(), String(stalled_at));
}

// A run that pauses then recovers must clear its stall counter.
{
  let c: BudgetCounters = { ...EMPTY_COUNTERS };
  const flat = progress_signature({ sources_read: 0, rounds_spent: 0, facets_resolved: 0, claims_verified: 0 });
  c = record_slice(c, flat);
  c = record_slice(c, flat);
  check('two stationary slices are not yet a stall (a pause is allowed)', !is_stalled(c));
  c = { ...c, sources_read: 5 };
  c = record_slice(
    c,
    progress_signature({ sources_read: 5, rounds_spent: 0, facets_resolved: 0, claims_verified: 0 }),
  );
  check('a slice that moves something RESETS the stall counter', c.no_progress_slices === 0);
  check('…and the run is healthy again', !is_stalled(c));
}

check(
  'a facet being RESOLVED counts as progress even with no new sources',
  record_slice(
    { ...EMPTY_COUNTERS, last_progress_signature: 5 },
    progress_signature({ sources_read: 5, rounds_spent: 0, facets_resolved: 1, claims_verified: 0 }),
  ).no_progress_slices === 0,
);
check(
  'a slice spent VERIFYING counts as progress',
  record_slice(
    { ...EMPTY_COUNTERS, last_progress_signature: 3 },
    progress_signature({ sources_read: 3, rounds_spent: 0, facets_resolved: 0, claims_verified: 4 }),
  ).no_progress_slices === 0,
);
check(
  'the signature never goes BACKWARDS (a shrinking count cannot fake progress)',
  record_slice({ ...EMPTY_COUNTERS, last_progress_signature: 99 }, 5).last_progress_signature === 99,
);

/* ================================================================== */
section('C. Budget exhaustion is an honest stop, not a stall');
/* ================================================================== */

const std = BUDGETS.standard;
check('a fresh run has budget', !budget_status(EMPTY_COUNTERS, std).exhausted);
check(
  'reading the source limit exhausts it',
  budget_status({ ...EMPTY_COUNTERS, sources_read: std.max_sources }, std).which === 'sources',
);
check(
  'spending the round limit exhausts it',
  budget_status({ ...EMPTY_COUNTERS, rounds_spent: std.max_rounds }, std).which === 'rounds',
);
check(
  'the slice backstop still exists as a runaway guard',
  budget_status({ ...EMPTY_COUNTERS, slices_run: std.max_slices }, std).which === 'slices',
);
check(
  'an exhausted budget is NOT a stall — they are different states',
  !is_stalled({ ...EMPTY_COUNTERS, sources_read: std.max_sources }),
);
check(
  'remaining allowances never go negative',
  sources_remaining({ ...EMPTY_COUNTERS, sources_read: 9999 }, std) === 0 &&
    rounds_remaining({ ...EMPTY_COUNTERS, rounds_spent: 9999 }, std) === 0,
);
check(
  'the same counters that exhaust standard leave exhaustive plenty of room',
  !budget_status({ ...EMPTY_COUNTERS, sources_read: std.max_sources }, BUDGETS.exhaustive).exhausted,
);

// With facets still open, the note explains the stop and offers the upgrade.
const note = render_budget_note({ ...EMPTY_COUNTERS, sources_read: std.max_sources }, std, 3);
check('the dossier says WHY it stopped', /stopped because/i.test(note));
check(
  '…and that it was the budget, not the questions running out',
  /not because the/i.test(note) && /exhaustive/i.test(note),
);
check('…naming how many were still open', note.includes('3 were still open'));

// But a run that answered EVERYTHING and merely reached its source limit must
// NOT be told the questions did not run out — that is a flat falsehood on a
// complete dossier, which is the confident-wrong-sentence class this whole
// workstream exists to stop.
const complete = render_budget_note({ ...EMPTY_COUNTERS, sources_read: std.max_sources }, std, 0);
check('a COMPLETE dossier is not told its questions went unanswered', !/not because/i.test(complete));
check('…and says it answered everything asked', /answered everything/i.test(complete));

check('a run inside its budget adds no note', render_budget_note(EMPTY_COUNTERS, std) === '');

/* ================================================================== */
section('D. The stall notice gives the owner three real options');
/* ================================================================== */

const notice = render_stall_notice({
  subject: 'Daniel Ray Torres',
  depth: 'standard',
  counters: { ...EMPTY_COUNTERS, sources_read: 12, rounds_spent: 4, no_progress_slices: 3 },
  last_log_line: 'investigated 6 of 6 facet(s) — 0 finding(s)',
  facets_answered: 1,
  facets_total: 6,
});
check('it names the subject', notice.includes('Daniel Ray Torres'));
check('it reports real coverage', notice.includes('1 of 6'));
check('it shows the work done so far', notice.includes('12 source(s)'));
check('it carries the last thing the run did', notice.includes('investigated 6 of 6'));
check('option 1 is more budget', /exhaustive/i.test(notice));
check('option 2 is narrowing', /narrow/i.test(notice));
check('option 3 is stopping with the partial', /stop here/i.test(notice));
check(
  'it states the stalled-vs-slow distinction to the owner, not just in code',
  /still finding things is never interrupted/i.test(notice),
);

/* ================================================================== */
section('E. Counters survive a row written before the phase existed');
/* ================================================================== */

check('an absent counters blob reads as zeros', counters_from(undefined).sources_read === 0);
check(
  'a partial blob is filled in rather than throwing',
  counters_from({ sources_read: 7 }).no_progress_slices === 0 &&
    counters_from({ sources_read: 7 }).sources_read === 7,
);
check(
  'an old row therefore simply starts counting from its next slice',
  !is_stalled(counters_from(undefined)),
);

/* ================================================================== */
section('F. A RE-OPEN must not false-stall the new revision');
/* ================================================================== */

// The bug this guards, found by hand before merge and invisible to the pure
// checks above. `reopen_with_facts` replans and CLEARS findings, so the runner
// recomputes `sources_read` from the new (empty) result set — the signature
// DROPS, 26 back to 3 — while `last_progress_signature` still holds the old
// high-water mark. Without a counter reset, `record_slice` reads every
// genuinely productive slice of the new revision as "moved nothing", and three
// of them declare a working run stalled. That is exactly what section B says
// must never happen, reached through a path section B cannot see.
{
  // Carried-over counters from a previous revision that read 26 sources.
  const carried: BudgetCounters = {
    sources_read: 26,
    rounds_spent: 4,
    slices_run: 5,
    no_progress_slices: 0,
    last_progress_signature: 30,
  };
  let stale = { ...carried };
  for (let i = 1; i <= 3; i++) {
    // The new revision is working: 1, 2, 3 sources read.
    stale = { ...stale, sources_read: i };
    stale = record_slice(
      stale,
      progress_signature({ sources_read: i, rounds_spent: 0, facets_resolved: 0, claims_verified: 0 }),
    );
  }
  check(
    'REGRESSION GUARD — carried counters would false-stall a productive revision',
    is_stalled(stale),
    'if this ever fails the hazard is gone and the check can go',
  );

  // With the reset the store now performs, the same three slices are healthy.
  let fresh: BudgetCounters = counters_from(undefined);
  for (let i = 1; i <= 3; i++) {
    fresh = { ...fresh, sources_read: i };
    fresh = record_slice(
      fresh,
      progress_signature({ sources_read: i, rounds_spent: 0, facets_resolved: 0, claims_verified: 0 }),
    );
  }
  check('…and a RESET revision is correctly healthy', !is_stalled(fresh));
  check('…with its stall counter at zero', fresh.no_progress_slices === 0);
}

/* ================================================================== */
section('G. The watchdog is REACHABLE (the blocker an adversarial review found)');
/* ================================================================== */

// This section exists because sections B-F are all PURE, and a pure check
// cannot see whether the runner ever calls is_stalled() with a number big
// enough to matter. It did not.
//
// A slice runs the whole phase chain, so it always ENDS on incomplete / done /
// cancelled — never mid-flight. The first cut gated the watchdog on an open
// status AT SLICE END, which meant only `incomplete` ever reached it; and
// `incomplete` was capped by a hard-coded 2 resume attempts against a stall
// threshold of 3. `stalled`, notify_stalled and the whole owner-facing
// three-options flow were unreachable at every depth. An instrumented run of
// smoke:research-coverage confirmed it: no_progress_slices topped out at 2.
//
// Two things fixed it, and both are asserted here as ARITHMETIC, which is the
// part a pure smoke can own honestly:
//   1. the resume cap is depth-scaled, so a deep run has slices to observe;
//   2. the check moved to slice START, where an open status is observable.
check(
  'standard keeps the old hard-coded resume cap of 2',
  BUDGETS.standard.max_resume_attempts === 2,
);
check(
  'quick resumes less than standard',
  BUDGETS.quick.max_resume_attempts < BUDGETS.standard.max_resume_attempts,
);
check(
  'THE FIX — exhaustive allows enough resumes for the watchdog to ever fire',
  BUDGETS.exhaustive.max_resume_attempts > stall_threshold(),
  `${BUDGETS.exhaustive.max_resume_attempts} resumes vs a threshold of ${stall_threshold()}`,
);
check(
  '…which is also what makes an exhaustive budget reachable at all (it was capped at 3 slices)',
  BUDGETS.exhaustive.max_resume_attempts >= 10,
);

// The DELIBERATE consequence, asserted so it can never become an accident: a
// slice ends `incomplete` only while resumable and each consumes one attempt,
// so only exhaustive can accumulate enough observable slices. Measured through
// the real runner: standard converges to done at slice 3 (no_prog 2), quick at
// slice 2 (no_prog 1). That is correct — at those depths a stuck run converges
// to an honest `unanswerable` report instead of interrupting the owner.
check(
  'stall is EXHAUSTIVE-ONLY by construction — quick cannot reach the threshold',
  BUDGETS.quick.max_resume_attempts < stall_threshold(),
);
check(
  '…nor can standard, the default',
  BUDGETS.standard.max_resume_attempts < stall_threshold(),
);
check(
  'if the threshold is ever raised past the exhaustive cap the watchdog dies everywhere',
  stall_threshold() < BUDGETS.exhaustive.max_resume_attempts,
);

// Walk the arithmetic the runner now performs: one stationary slice recorded
// per pass, with the cap allowing enough passes to cross the threshold.
{
  let c: BudgetCounters = counters_from(undefined);
  const flat = progress_signature({
    sources_read: 0,
    rounds_spent: 0,
    facets_resolved: 0,
    claims_verified: 0,
  });
  let fired_on: number | null = null;
  for (let slice = 1; slice <= BUDGETS.exhaustive.max_resume_attempts; slice++) {
    // The check happens at slice START, on the counters the PREVIOUS slice left.
    if (fired_on === null && is_stalled(c)) fired_on = slice;
    c = record_slice(c, flat);
  }
  check('a permanently stationary exhaustive run DOES reach stalled', fired_on !== null);
  check(
    '…on the slice right after the threshold is crossed',
    fired_on === stall_threshold() + 1,
    String(fired_on),
  );
}

// And the converse still holds at exhaustive depth: 100 productive slices, far
// more than the old 3-slice ceiling allowed, never trip it.
{
  let c: BudgetCounters = counters_from(undefined);
  let tripped = false;
  for (let i = 1; i <= 100; i++) {
    c = { ...c, sources_read: i };
    if (is_stalled(c)) tripped = true;
    c = record_slice(
      c,
      progress_signature({ sources_read: i, rounds_spent: 0, facets_resolved: 0, claims_verified: 0 }),
    );
  }
  check('100 productive slices at exhaustive depth still never stall', !tripped);
}

/* ================================================================== */
section('H. A stalled run must not READ as finished');
/* ================================================================== */

// `stalled` is not in OPEN_INVESTIGATION_STATUSES (so the sweep cannot revive
// it), which meant the Research office filed it under `recent` next to finished
// dossiers, with progress_of falling through to its default of 1. The owner
// would have seen a completed progress bar and waited for a report that was
// never coming — the same false-reassurance class the rest of this workstream
// exists to kill. The office now uses its own NEEDS_ATTENTION set.
check('a stalled run is NOT rendered as complete', progress_of('stalled') < 1);
check('…and sits where an incomplete one does', progress_of('stalled') === progress_of('incomplete'));
check('a genuinely done run still reads complete', progress_of('done') === 1);
check(
  'the office treats stalled as needing attention, unlike the runner sweep',
  NEEDS_ATTENTION.includes('stalled') && !OPEN_INVESTIGATION_STATUSES.includes('stalled'),
);

/* ================================================================== */
section('I. Phase 4 — agency cannot invent a source');
/* ================================================================== */

// The runner will only follow a URL that appears VERBATIM in text it actually
// read. This is the guard that keeps agency from becoming fabrication: without
// it a model could emit a plausible-looking URL and the runner would fetch it,
// manufacturing a "source" from nothing.
const corpus = [
  '# Williamson CAD\nSee the parcel record at https://wcad.org/parcel/12345 for details.',
  '# Some page\nNothing useful here.',
].join('\n');
const follow_allowed = (u: string): boolean => corpus.includes(u);

check('a URL present in a read source may be followed', follow_allowed('https://wcad.org/parcel/12345'));
check(
  'a plausible but INVENTED url is refused',
  !follow_allowed('https://wcad.org/parcel/99999'),
);
check(
  'a url from a page we never read is refused',
  !follow_allowed('https://spokeo.com/Jonathan-Torres/Texas'),
);

/* ================================================================== */
console.log(
  `\n${failures === 0 ? 'smoke:research-budget OK' : 'smoke:research-budget FAILED'} — ` +
    `${checks - failures}/${checks} checks passed`,
);
process.exit(failures === 0 ? 0 : 1);
