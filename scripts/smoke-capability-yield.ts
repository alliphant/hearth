/**
 * smoke:capability-yield — the closed loop for capabilities that succeed their
 * way to zero output.
 *
 * Self-contained: temp SQLite, no LLM, no network, no live orchestrator.
 *
 * PINNED TO REAL PAYLOADS. Every fixture in section B is a VERBATIM
 * `execution_result` captured off the live the LLM host box on 2026-08-01, because
 * the whole failure this closes was a detector agreeing with a shape nobody had
 * actually looked at. A synthetic `{produced: 0}` fixture would have passed on
 * day one and proved nothing — the same way `smoke:reactive-triggers` passed for
 * five weeks while both home triggers were structurally dead, because every
 * fixture set a `place_id` that real payloads never carry.
 *
 * Coverage:
 *   A. read_yield — declared beats convention; ambiguous keys declined; arrays
 *      counted by length; MAX not SUM; a declared-but-absent field falls back
 *      rather than reporting a false zero.
 *   B. the real payloads — barren jobs flagged, honest-idle jobs NOT flagged,
 *      partially-productive jobs NOT flagged (precision over recall).
 *   C. assess_yield — the min-active-runs floor, one good run rescues a window,
 *      gated runs don't count, uncovered ≠ zero.
 *   D. scan_capability_yield end-to-end over a temp audit_log → emits the
 *      EXISTING quality_signal, and its refs feed verify_fix_landed.
 *   E. the guard_feedback branch — evidence_ref shape (3 segments, so
 *      verify_fix_landed's pattern_of finds it), Beatrice woken once, the
 *      fixer's OWN barren job never wakes her about herself.
 *   F. kill switch — HEARTH_CAPABILITY_YIELD=0 is a byte-identical no-op.
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { AppEventBus, type AppEvent } from '@app/events';
import type { MemoryClient } from '@memory/client';
import type { SpecialistRegistry } from '@core/specialist';
import type { ScopedWaker } from '@core/reactive_triggers';
import type { NewProcessMiss, ProcessMissStore } from '@core/process_misses';
import { GuardFeedbackDriver } from '@core/guard_feedback';
import {
  assess_yield,
  read_yield,
  run_is_active,
  yield_evidence_ref,
  type YieldRun,
} from '@core/capability_yield';
import { make_scan_capability_yield } from '../src/specialists/kate/tools/scan_capability_yield';

process.env.HEARTH_YIELD_WINDOW_RUNS = '10';
process.env.HEARTH_YIELD_MIN_ACTIVE_RUNS = '3';
delete process.env.HEARTH_CAPABILITY_YIELD;

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

/* ================================================================== */
/* A. read_yield                                                       */
/* ================================================================== */
console.log('\nA. read_yield — declaration, convention, and refusing to guess');

{
  const r = read_yield(
    { docs_fetched: 2, votes_recorded: 0, members_added: 0 },
    { produced: ['votes_recorded'], considered: ['docs_fetched'] },
  );
  assert(r.basis === 'declared', 'a declared contract wins over the convention');
  assert(r.produced === 0 && r.considered === 2, 'declared fields read the right numbers');
}

{
  const r = read_yield({ docs_fetched: 2, votes_recorded: 0, members_added: 3 });
  assert(r.basis === 'convention', 'no declaration → convention reader');
  assert(
    r.produced === 3,
    'produced is the MAX across matched fields, not the sum — "did ANYTHING come out?"',
  );
}

{
  // The declared field is missing from THIS result (a shape change or an early
  // gate return). Reporting 0 would raise a false alarm; fall back instead.
  const r = read_yield({ filed: 4, due: 9 }, { produced: ['rows_written'] });
  assert(r.basis === 'convention', 'a declared-but-absent field falls back to convention');
  assert(r.produced === 4, 'the fallback still finds real output (no false zero)');
}

{
  // `topics_skipped_unchanged` has no verb in either set; `items_found` is
  // considered-only. A key carrying BOTH kinds must be declined, not guessed.
  const r = read_yield({ recorded_candidates: 7, filed: 0 });
  assert(
    !r.produced_fields.includes('recorded_candidates'),
    'a key with BOTH a produced and a considered token is declined, never guessed',
  );
}

{
  const r = read_yield({ misses_opened: ['pm_1', 'pm_2'], due: 5 });
  assert(r.produced === 2, 'array-valued produced fields are counted by LENGTH');
  assert(r.considered === 5, 'and the paired considered field still reads');
}

{
  // Documenting a real edge the convention does NOT cover, on purpose.
  // `proposal_ids` carries no produced verb, so alone it reads as uncovered
  // rather than zero — the honest outcome. Every live scan pairs it with
  // `filed: N`, which IS matched, so the real tools are covered; a future tool
  // returning only ids would be REPORTED as uncovered, which is the whole point
  // of having an uncovered verdict instead of a silent zero.
  const ids_only = read_yield({ proposal_ids: ['a', 'b'] });
  assert(ids_only.basis === 'unmatched', '`proposal_ids` alone is uncovered, NOT a false zero');
  const real_pairing = read_yield({ enabled: true, due: 19, filed: 1, proposal_ids: ['x'] });
  assert(
    real_pairing.produced === 1,
    'the real payload shape (filed + proposal_ids) is covered via `filed`',
  );
}

{
  assert(read_yield({ note: 'nothing countable' }).basis === 'unmatched', 'no match → unmatched');
  assert(read_yield(null).basis === 'unmatched', 'a null result is unmatched, never a zero');
}

{
  // `{none:true}` is a DECISION, and it is not the same as leaving `yield` off.
  // Absence means "nobody has looked yet" — which is what the coverage lint
  // hunts. `none` means "somebody looked; this writes nothing by design."
  const none_decl = { none: true as const, reason: 'a pure read — returns rows, writes none' };
  const r = read_yield({ rows: [1, 2, 3], filed: 0 }, none_decl);
  assert(r.basis === 'declared_none', 'an explicit exemption short-circuits the reader');
  assert(
    r.produced === null && r.considered === null,
    'and takes NO reading — the convention must not invent one for an exempt tool',
  );
  const a = assess_yield('query_audit_log', Array.from({ length: 6 }, (_, i) => ({
    ts: new Date(Date.UTC(2026, 6, 20 + i)).toISOString(),
    active: true,
    reading: read_yield({ rows: [1, 2, 3] }, none_decl),
  })));
  assert(a.verdict === 'exempt', 'an exempt tool lands in its OWN state');
  assert(a.basis === 'declared_none', 'with the declared_none basis');
  assert(
    !['barren', 'suspected_barren', 'uncovered', 'idle'].includes(a.verdict),
    'never in barren / suspected / uncovered / idle — putting it in a bucket would make the coverage numbers lie',
  );
}

{
  // The THIRD state, surfaced by the adversarial triage pass: a tool whose
  // counts ARE meaningful but whose zero is a quiet night, not a defect. Before
  // `armed: false` existed there was nowhere for these to land — you had to
  // either arm a routinely-idle scan (a nightly false alarm) or exempt it
  // (throwing away counts worth watching). Most scans are this shape.
  const unarmed = { produced: ['filed'], considered: ['due'], armed: false as const };
  const r = read_yield({ due: 9, filed: 0 }, unarmed);
  assert(r.basis === 'declared_unarmed', 'armed:false yields its own basis');
  assert(
    r.produced === 0 && r.considered === 9,
    'and the DECLARED fields still read — the numbers stay authoritative, only the escalation is withheld',
  );
  const runs = Array.from({ length: 6 }, (_, i) => ({
    ts: new Date(Date.UTC(2026, 6, 20 + i)).toISOString(),
    active: true,
    reading: read_yield({ due: 9, filed: 0 }, unarmed),
  }));
  const a = assess_yield('some_quiet_scan', runs);
  assert(a.verdict === 'suspected_barren', 'a sustained zero on an unarmed contract REPORTS, never escalates');
  assert(
    a.summary.includes('armed: false') && !a.summary.includes('wrong field'),
    'and says WHY honestly — not the convention caveat, which would be false here',
  );
  const armed_same = assess_yield('some_armed_scan', runs.map((x) => ({
    ...x,
    reading: read_yield({ due: 9, filed: 0 }, { produced: ['filed'], considered: ['due'] }),
  })));
  assert(
    armed_same.verdict === 'barren',
    'the SAME payload with armed defaulting to true DOES escalate — armed is the only difference',
  );
}

/* ================================================================== */
/* B. the REAL payloads (captured from the LLM host, 2026-08-01)            */
/* ================================================================== */
console.log('\nB. real live payloads — barren vs honest-idle vs partially-productive');

/** Verbatim `result` objects from `audit_log` on the live box. */
const REAL = {
  // --- genuinely barren: work arrived, nothing came out ---
  extract_meeting_votes: { ok: true, docs_fetched: 2, items_found: 1, votes_recorded: 0, members_added: 0, skipped: 5, failed: [] },
  acquire_pricing: { ok: true, searched: 4, fetched: 8, prices_extracted: 0, prices_recorded: 0, prices_unmapped: 0, commodity_recorded: 0 },
  acquire_campaign_finance: { ok: true, searched: 2, fetched: 3, donations_extracted: 0, donations_recorded: 0, rejected: 0, filings_recorded: 0, failed: [] },
  knowledge_fetch: { enabled: true, gaps_considered: 3, topics_fetched: 3, items_shelved: 0 },
  // --- honest idle: nothing upstream to act on. MUST NOT flag. ---
  scan_life_events: { enabled: true, candidates: 0, filed: 0, proposal_ids: [] },
  scan_cross_signals: { enabled: true, coincidences: 0, filed: 0, proposal_ids: [] },
  scan_calendar_followups: { enabled: true, due: 0, filed: 0, proposal_ids: [] },
  // --- productive, including LOW-yield. MUST NOT flag. ---
  scan_good_followups: { enabled: true, due: 19, filed: 1, proposal_ids: ['01KYW8GWRWDTGTZ10RGMBPD0MT'] },
  lookup_benchmark_scores: { ok: true, worklist: 8, recorded: 1, fails: 7, rejected: 0 },
  synthesize_shelves: { enabled: true, shelves_scanned: 5, shelves_synthesized: 5, syntheses_written: 40, topics_skipped_unchanged: 15 },
} as const;

function series(result: unknown, n = 5): YieldRun[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: new Date(Date.UTC(2026, 6, 20 + i)).toISOString(),
    active: run_is_active(result),
    reading: read_yield(result),
  }));
}

for (const tool of ['extract_meeting_votes', 'acquire_pricing', 'acquire_campaign_finance', 'knowledge_fetch'] as const) {
  const a = assess_yield(tool, series(REAL[tool]));
  assert(
    a.verdict === 'suspected_barren',
    `REAL ${tool} → suspected_barren by CONVENTION (reported, not escalated)`,
  );
}

{
  // The SAME payload, read through a DECLARED contract, escalates. This is the
  // whole precision fix: a declaration is the author asserting that zero output
  // here is a defect, and that assertion is what earns a wake.
  const declared = { produced: ['votes_recorded'], considered: ['docs_fetched'] };
  const runs = Array.from({ length: 5 }, (_, i) => ({
    ts: new Date(Date.UTC(2026, 6, 20 + i)).toISOString(),
    active: run_is_active(REAL.extract_meeting_votes),
    reading: read_yield(REAL.extract_meeting_votes, declared),
  }));
  assert(
    assess_yield('extract_meeting_votes', runs).verdict === 'barren',
    'the same payload read through a DECLARED contract IS barren — declaration earns escalation',
  );
}

{
  // The two false-positive shapes the first live run produced, both of which
  // must stay OUT of `barren`. A detector reporting nothing-wrong is healthy.
  const healthy_detector = { ok: true, checked: 8, unhealthy: [], new_incidents: [], escalated: 0 };
  assert(
    assess_yield('scan_system_health', series(healthy_detector)).verdict !== 'barren',
    'a DETECTOR reporting nothing-wrong (checked:8, unhealthy:[]) is never `barren`',
  );
  // And the convention reading the WRONG field: real output under a name the
  // token set missed. Adding those tokens is the fix; the guard is the backstop.
  const wrong_field = { enabled: true, checked: 37, refreshed: ['a', 'b'], filed: 0 };
  const r = read_yield(wrong_field);
  assert(
    r.produced === 2,
    '`refreshed: [...]` is now matched — the live run proved the reader was latching onto the wrong field',
  );
}

for (const tool of ['scan_life_events', 'scan_cross_signals', 'scan_calendar_followups'] as const) {
  const a = assess_yield(tool, series(REAL[tool]));
  assert(
    a.verdict === 'idle',
    `REAL ${tool} → idle, NOT barren (no upstream work — flagging it would be the false-positive machine)`,
  );
}

for (const tool of ['scan_good_followups', 'lookup_benchmark_scores', 'synthesize_shelves'] as const) {
  const a = assess_yield(tool, series(REAL[tool]));
  assert(a.verdict === 'productive', `REAL ${tool} → productive (never escalated)`);
}

{
  // The low-yield case is REPORTED but not escalated — precision over recall.
  const a = assess_yield('lookup_benchmark_scores', series(REAL.lookup_benchmark_scores));
  assert(
    a.yield_ratio !== null && a.yield_ratio < 0.2,
    'a poor yield_ratio is still computed and visible for a human, just not escalated',
  );
}

/* ================================================================== */
/* C. assess_yield edges                                               */
/* ================================================================== */
console.log('\nC. assess_yield — floors, rescues, gated runs, uncovered');

{
  const a = assess_yield('t', series(REAL.acquire_pricing, 2));
  assert(
    a.verdict === 'insufficient_data',
    'below the min-active-runs floor → insufficient_data (one bad night proves nothing)',
  );
}

{
  const runs = series(REAL.acquire_pricing, 5);
  runs[2] = { ts: runs[2]!.ts, active: true, reading: read_yield({ fetched: 4, prices_recorded: 2 }) };
  const a = assess_yield('t', runs);
  assert(a.verdict === 'productive', 'ONE productive run anywhere in the window rescues the verdict');
}

{
  const gated = { enabled: false, fetched: 9, recorded: 0 };
  const a = assess_yield('t', series(gated, 5));
  assert(run_is_active(gated) === false, 'a gate-disabled run is detected as inactive');
  assert(
    a.verdict !== 'barren',
    'a kill-switched capability is never barren — flipping a flag off must not read as a defect',
  );
}

{
  const a = assess_yield('t', series({ note: 'no countable fields' }, 5));
  assert(a.verdict === 'uncovered', 'unreadable results → uncovered');
  assert(
    a.summary.includes('unknown, not zero'),
    'the uncovered summary says unknown, NOT zero — an invisible gap is what this exists to prevent',
  );
}

/* ================================================================== */
/* D. scan_capability_yield end-to-end                                 */
/* ================================================================== */
console.log('\nD. scan_capability_yield over a temp audit_log');

const dir = mkdtempSync(join(tmpdir(), 'yield-smoke-'));
const db = new Database(join(dir, 'test.db'));
db.exec(`CREATE TABLE audit_log (
  id TEXT PRIMARY KEY, ts TEXT NOT NULL, agent TEXT NOT NULL,
  tool_name TEXT NOT NULL, tool_input TEXT, execution_result TEXT, error TEXT
);`);

function seed(agent: string, tool: string, result: unknown, n: number): void {
  for (let i = 0; i < n; i++) {
    db.prepare(
      `INSERT INTO audit_log (id, ts, agent, tool_name, tool_input, execution_result)
       VALUES (?, ?, ?, 'background_job', ?, ?)`,
    ).run(
      ulid(),
      new Date(Date.now() - (i + 1) * 86_400_000).toISOString(),
      agent,
      JSON.stringify({ name: `${tool}_job`, tool }),
      // The loop's real envelope shape — the scan must unwrap `.result`.
      JSON.stringify({ ok: true, tool, result }),
    );
  }
}

seed('kristi', 'acquire_pricing', REAL.acquire_pricing, 6);
seed('kate', 'scan_life_events', REAL.scan_life_events, 6);
seed('kate', 'scan_good_followups', REAL.scan_good_followups, 6);
seed('trainer', 'some_trainer_job', REAL.acquire_pricing, 6);

const emitted: AppEvent[] = [];
const events = new AppEventBus();
events.subscribe((e) => emitted.push(e));
const audit: Array<Record<string, unknown>> = [];
const memory = { log_action: (r: Record<string, unknown>) => { audit.push(r); return 'aud_1'; } } as unknown as MemoryClient;

// A fake registry that DECLARES acquire_pricing's contract — so it escalates —
// while every other seeded tool stays convention-read and therefore `suspected`.
const tool_registry = {
  get: (name: string) =>
    name === 'acquire_pricing'
      ? ({ yield: { produced: ['prices_recorded'], considered: ['fetched'] } } as never)
      : undefined,
} as never;
const scan = make_scan_capability_yield({ db, memory, events, tool_registry });
const out = await scan.execute({}, { memory, now: new Date(), intent_id: 'i1' } as never);

assert(out.enabled === true, 'scan runs enabled');
assert(out.jobs_examined === 4, 'grouped all four seeded capabilities');
assert(
  out.barren.some((b) => b.tool === 'acquire_pricing'),
  'the DECLARED barren capability is flagged out of a mixed real-world audit log',
);
assert(
  out.suspected.some((b) => b.tool === 'some_trainer_job'),
  'a convention-read zero lands in `suspected` (reported), never in `barren`',
);
assert(
  !out.barren.some((b) => b.tool === 'some_trainer_job'),
  'and therefore never escalates on convention alone — the first live run flagged 15 of 54 that way',
);
assert(
  !out.barren.some((b) => b.tool === 'scan_life_events' || b.tool === 'scan_good_followups'),
  'the idle and productive capabilities are NOT flagged',
);
assert(
  out.current_findings_refs.includes('capability:yield:acquire_pricing'),
  'current_findings_refs carries the ref verify_fix_landed closes on',
);
{
  const sigs = emitted.filter((e) => e.type === 'quality_signal');
  assert(sigs.length === out.signals_emitted, 'signals_emitted matches what actually reached the bus');
  assert(
    sigs.every((s) => s.type === 'quality_signal' && s.signal_class === 'yield'),
    'the scan emits the EXISTING quality_signal — no second event type, no second loop',
  );
}
assert(
  audit.some((r) => r.tool_name === 'capability_yield_scan'),
  'the scan writes its own audit row',
);

{
  const narrowed = await scan.execute({ tool: 'acquire_pricing' }, { memory, now: new Date(), intent_id: 'i2' } as never);
  assert(narrowed.jobs_examined === 1, 'the `tool` filter narrows to one capability (verify_fix_landed path)');
}

/* ================================================================== */
/* E. the guard_feedback branch                                        */
/* ================================================================== */
console.log('\nE. guard_feedback — evidence_ref shape, one wake, no self-diagnosis');

function make_driver(): {
  driver: GuardFeedbackDriver;
  wakes: Array<{ id: string; opts: { dedupe_key: string; task: string } }>;
  misses: NewProcessMiss[];
} {
  const wakes: Array<{ id: string; opts: { dedupe_key: string; task: string } }> = [];
  const misses: NewProcessMiss[] = [];
  const driver = new GuardFeedbackDriver({
    specialists: { get: (id: string) => ({ id, name: id }) } as unknown as SpecialistRegistry,
    waker: {
      wake_deliberation_scoped: (id: string, opts: never) => {
        wakes.push({ id, opts: opts as never });
      },
    } as unknown as ScopedWaker,
    process_misses: { create: (m: NewProcessMiss) => { misses.push(m); return 'pm_1'; } } as unknown as ProcessMissStore,
  });
  return { driver, wakes, misses };
}

{
  const { driver, wakes, misses } = make_driver();
  driver.on_event({
    type: 'quality_signal',
    specialist_id: 'kristi',
    signal_class: 'yield',
    guard: 'capability_yield_barren',
    tool: 'acquire_pricing',
    detail: 'ran 6× with work available and wrote nothing',
  });
  assert(misses.length === 1, 'a yield signal escalates on the FIRST emit (the run-series IS the edge)');
  assert(
    misses[0]!.evidence_ref === 'capability:yield:acquire_pricing',
    'evidence_ref matches yield_evidence_ref()',
  );
  assert(
    misses[0]!.evidence_ref!.split(':')[1] === 'yield',
    'segment 1 is the PATTERN — verify_fix_landed.pattern_of() reads index 1, so a ' +
      '2-segment ref would orphan these misses forever',
  );
  assert(misses[0]!.subject_specialist_id === 'trainer', 'the fix owner is Beatrice, like arg_mismatch');
  assert(misses[0]!.severity === 'high', 'severity high — the defining property of this class is invisibility');
  assert(wakes.length === 1 && wakes[0]!.id === 'trainer', 'Beatrice is woken exactly once');
  assert(
    wakes[0]!.opts.task.includes('diagnose_capability_yield'),
    'the wake task steers her to the diagnoser FIRST, not to guessing',
  );
  assert(
    wakes[0]!.opts.dedupe_key === 'capability:yield:acquire_pricing',
    'the wake dedupe_key is the same ref, so the debounce and the ledger agree',
  );
}

{
  const { driver, wakes, misses } = make_driver();
  driver.on_event({
    type: 'quality_signal',
    specialist_id: 'trainer',
    signal_class: 'yield',
    guard: 'capability_yield_barren',
    tool: 'some_trainer_job',
    detail: 'barren',
  });
  assert(misses.length === 0 && wakes.length === 0, "the FIXER's own barren job never wakes her to diagnose herself");
}

{
  // Deliberately NARROWER than the honesty skip: a barren Mariah scan is a real
  // defect and Beatrice diagnosing Mariah is not a self-loop.
  const { driver, wakes } = make_driver();
  driver.on_event({
    type: 'quality_signal',
    specialist_id: 'mariah',
    signal_class: 'yield',
    guard: 'capability_yield_barren',
    tool: 'scan_program_health',
    detail: 'barren',
  });
  assert(wakes.length === 1, "a barren META-agent (non-fixer) job DOES escalate — it's a real defect");
}

{
  const { driver, misses } = make_driver();
  for (let i = 0; i < 2; i++) {
    driver.on_event({
      type: 'quality_signal',
      specialist_id: 'kate',
      signal_class: 'honesty',
      guard: 'fabricated_save_guard',
      detail: 'x',
    });
  }
  assert(misses.length === 0, 'the honesty class still needs its full recurrence threshold (unchanged)');
}

/* ================================================================== */
/* F. kill switch                                                      */
/* ================================================================== */
console.log('\nF. kill switch');

{
  process.env.HEARTH_CAPABILITY_YIELD = '0';
  const before = emitted.length;
  const off = await scan.execute({}, { memory, now: new Date(), intent_id: 'i3' } as never);
  assert(off.enabled === false && off.barren.length === 0, 'HEARTH_CAPABILITY_YIELD=0 → the scan is a no-op');
  assert(emitted.length === before, 'nothing is emitted while disabled');
  delete process.env.HEARTH_CAPABILITY_YIELD;
  const on = await scan.execute({}, { memory, now: new Date(), intent_id: 'i4' } as never);
  assert(on.enabled === true && on.barren.length > 0, 're-arms cleanly when the switch is removed');
}

assert(yield_evidence_ref('x') === 'capability:yield:x', 'yield_evidence_ref is the single ref builder');

db.close();
rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\nsmoke:capability-yield OK' : `\nsmoke:capability-yield FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
