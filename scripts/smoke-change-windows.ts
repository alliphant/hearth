/**
 * smoke:change-windows — apply → measure → flag (→ revert, opt-in).
 *
 * Self-contained: temp SQLite, no LLM, no network.
 *
 * The behaviour under test is the one that did not exist: nothing ever measured
 * whether an automated change made things better or worse. A change landed and
 * the system moved on.
 *
 * Coverage:
 *   A. measure_delta — SAME-TASK delta, not an absolute rate (the live suite is
 *      a standing ~110/151 mix, so a rate threshold is meaningless); tasks
 *      present on only one side are EXCLUDED, not counted; mixed is neutral;
 *      the min-comparable floor.
 *   B. store — the baseline snapshot, pending/verdict lifecycle, corrupt
 *      baseline degrades to inconclusive rather than to a false verdict.
 *   C. the tool, FLAG-ONLY by default — a regression files a miss, wakes
 *      Beatrice, names the undo call, and LEAVES THE CHANGE LIVE.
 *   D. HEARTH_AUTO_REVERT=1 — a clean regression on a machine-revertible change
 *      is undone; a MIXED result never is; a non-machine-revertible kind never
 *      is, even armed.
 *   E. an improved / neutral window is scored and closed without noise.
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryClient } from '@memory/client';
import type { ToolContext } from '@core/tool';
import type { NewProcessMiss, ProcessMissStore } from '@core/process_misses';
import type { ScopedWaker } from '@core/reactive_triggers';
import { measure_delta, is_machine_revertible, type TaskOutcomes } from '@core/change_measurement';
import { ChangeWindowStore } from '@memory/stores/change_windows';
import { LlmRoleOverrideStore } from '@memory/stores/llm_role_overrides';
import { make_review_change_windows } from '../src/specialists/kate/tools/review_change_windows';

process.env.HEARTH_CHANGE_MIN_TASKS = '3';
delete process.env.HEARTH_AUTO_REVERT;

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

const m = (o: Record<string, boolean>): TaskOutcomes => new Map(Object.entries(o));

/* ================================================================== */
console.log('\nA. measure_delta — same-task delta, exclusions, mixed is a trade-off');
/* ================================================================== */

{
  // The live shape: a standing mix where most tasks fail and stay failing.
  // An absolute rate would scream; the delta correctly says nothing changed.
  const base = m({ a: true, b: false, c: false, d: true, e: false });
  const d = measure_delta(base, m({ a: true, b: false, c: false, d: true, e: false }));
  assert(d.verdict === 'neutral', 'a suite that is 2/5 before and after is NEUTRAL, not "failing"');
  assert(d.compared === 5 && d.unchanged === 5, 'all five compared, none changed');
}

{
  const d = measure_delta(m({ a: true, b: true, c: false }), m({ a: false, b: true, c: false }));
  assert(d.verdict === 'regressed', 'a PASS → FAIL with no improvement is a regression');
  assert(d.regressed_tasks.join() === 'a', 'the regressed task is named');
}

{
  const d = measure_delta(m({ a: false, b: true, c: false }), m({ a: true, b: true, c: false }));
  assert(d.verdict === 'improved', 'a FAIL → PASS with no regression is an improvement');
}

{
  const d = measure_delta(m({ a: true, b: false, c: true }), m({ a: false, b: true, c: true }));
  assert(
    d.verdict === 'neutral',
    'MIXED is neutral, never regressed — a change that fixes one and breaks one is the owner\'s call',
  );
  assert(d.regressed_tasks.length === 1 && d.improved_tasks.length === 1, 'both directions are still reported');
}

{
  // A golden task added after the change is not evidence about the change.
  const d = measure_delta(m({ a: true, b: true, c: true }), m({ a: true, b: true, c: true, brand_new: false }));
  assert(d.compared === 3, 'a task present on only ONE side is excluded from the comparison');
  assert(d.skipped_tasks.join() === 'brand_new', 'and is reported as skipped, not silently dropped');
  assert(d.verdict === 'neutral', 'the new failing task does NOT read as a regression');
}

{
  const d = measure_delta(m({ a: true, b: true }), m({ a: false, b: true }));
  assert(d.verdict === 'inconclusive', 'below the min-comparable floor → inconclusive, even with a regression');
  assert(d.summary.includes('not enough'), 'and says so honestly');
}

assert(is_machine_revertible('llm_role_override'), 'a role override is machine-revertible');
assert(!is_machine_revertible('code_merge'), 'a code merge is NOT — git revert against shared main is a human call');
assert(!is_machine_revertible('low_risk_fix'), 'nor a config fix — its inverse routes through review + merge');

/* ================================================================== */
console.log('\nB. store — baseline snapshot + lifecycle');
/* ================================================================== */

const dir = mkdtempSync(join(tmpdir(), 'change-win-'));
const db = new Database(join(dir, 'test.db'));
db.exec(`
CREATE TABLE eval_runs (id TEXT PRIMARY KEY, ts TEXT NOT NULL, task_id TEXT NOT NULL,
  specialist_id TEXT NOT NULL, passed INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '', model TEXT);
CREATE TABLE change_windows (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', applied_by TEXT NOT NULL,
  applied_at TEXT NOT NULL, baseline_json TEXT NOT NULL, verdict TEXT, measured_at TEXT,
  delta_summary TEXT, action_taken TEXT);
CREATE TABLE llm_role_overrides (id TEXT PRIMARY KEY, role TEXT NOT NULL, patch_json TEXT NOT NULL,
  prev_json TEXT, reason TEXT NOT NULL DEFAULT '', applied_by TEXT NOT NULL, applied_at TEXT NOT NULL,
  reverted_at TEXT, reverted_by TEXT);
`);

let ev = 0;
function eval_row(task: string, passed: boolean, ts: string): void {
  db.prepare(`INSERT INTO eval_runs (id, ts, task_id, specialist_id, passed) VALUES (?,?,?,?,?)`).run(
    `ev${ev++}`,
    ts,
    task,
    'kate',
    passed ? 1 : 0,
  );
}

const windows = new ChangeWindowStore(db);
for (const t of ['t1', 't2', 't3', 't4']) eval_row(t, true, '2026-08-01T00:00:00Z');

{
  const outcomes = windows.current_outcomes();
  assert(outcomes.size === 4 && outcomes.get('t1') === true, 'current_outcomes reads the latest run per task');
  const id = windows.open({
    kind: 'llm_role_override',
    ref: 'lro_x',
    target: 'specialist',
    reason: 'trial',
    applied_by: 'jasper',
    baseline: outcomes,
  });
  assert(windows.pending().some((w) => w.id === id), 'a fresh window is pending');
  assert(windows.get(id)?.baseline.size === 4, 'the baseline is snapshotted AT APPLY TIME — later it is gone');
}

{
  db.prepare(
    `INSERT INTO change_windows (id,kind,ref,target,reason,applied_by,applied_at,baseline_json)
     VALUES ('cw_bad','other','r','t','x','y','2026-08-01T00:00:00Z','{BROKEN')`,
  ).run();
  assert(windows.get('cw_bad')?.baseline.size === 0, 'a corrupt baseline reads EMPTY → inconclusive, not a false verdict');
  db.prepare(`DELETE FROM change_windows WHERE id='cw_bad'`).run();
}

/* ================================================================== */
console.log('\nC. the tool — FLAG-ONLY by default');
/* ================================================================== */

const audit: Array<Record<string, unknown>> = [];
const memory = { log_action: (r: Record<string, unknown>) => { audit.push(r); return 'a1'; } } as unknown as MemoryClient;
const misses: NewProcessMiss[] = [];
const wakes: Array<{ id: string; opts: { task: string } }> = [];
const deps = {
  db,
  memory,
  process_misses: { create: (x: NewProcessMiss) => { misses.push(x); return 'pm1'; } } as unknown as ProcessMissStore,
  waker: { wake_deliberation_scoped: (id: string, opts: never) => { wakes.push({ id, opts: opts as never }); } } as unknown as ScopedWaker,
};
const tool = make_review_change_windows(deps);
const ctx = { intent_id: 'i1', now: new Date(), memory } as unknown as ToolContext;

const overrides = new LlmRoleOverrideStore(db);
overrides.apply({ role: 'specialist', patch: { model: 'trial' }, reason: 'trial', applied_by: 'jasper' });

{
  // Two tasks regress after the change.
  for (const t of ['t1', 't2']) eval_row(t, false, '2026-08-02T00:00:00Z');
  for (const t of ['t3', 't4']) eval_row(t, true, '2026-08-02T00:00:00Z');

  const out = await tool.execute({}, ctx);
  assert(out.auto_revert_armed === false, 'auto-revert is OFF by default — it flags before it reverts');
  assert(out.scored[0]?.verdict === 'regressed', 'the regression is detected');
  assert(out.scored[0]?.regressed_tasks.join() === 't1,t2', 'the specific regressed tasks are named');
  assert(out.flagged === 1 && out.reverted === 0, 'flagged, NOT reverted');
  assert(
    overrides.active_for('specialist') !== null,
    'the change is STILL LIVE — a default-on reverter would have undone it on an unmeasured verdict',
  );
  assert(misses.length === 1 && misses[0]!.severity === 'high', 'one high-severity miss filed');
  assert(
    (misses[0]!.gap ?? '').includes('manage_llm_role{action:"revert"'),
    'the miss names the ONE call that undoes it',
  );
  assert(
    (misses[0]!.gap ?? '').includes('STILL LIVE'),
    'and says plainly that the change has not been undone',
  );
  assert(wakes.length === 1 && wakes[0]!.id === 'trainer', 'Beatrice is woken to diagnose why it regressed');
  assert(audit.some((a) => a.tool_name === 'change_windows_reviewed'), 'the review is audited');
  assert(windows.pending().length === 0, 'the window is closed with its verdict recorded');
}

/* ================================================================== */
console.log('\nD. HEARTH_AUTO_REVERT=1 — armed, and still refusing the mixed case');
/* ================================================================== */

{
  process.env.HEARTH_AUTO_REVERT = '1';
  misses.length = 0;
  wakes.length = 0;

  // Clean regression on a machine-revertible change.
  const id = windows.open({
    kind: 'llm_role_override',
    ref: 'lro_y',
    target: 'specialist',
    reason: 'second trial',
    applied_by: 'jasper',
    baseline: m({ t1: true, t2: true, t3: true, t4: true }),
  });
  for (const t of ['t1', 't2']) eval_row(t, false, '2026-08-03T00:00:00Z');
  for (const t of ['t3', 't4']) eval_row(t, true, '2026-08-03T00:00:00Z');

  const out = await tool.execute({ window_id: id }, ctx);
  assert(out.auto_revert_armed === true, 'armed when HEARTH_AUTO_REVERT=1');
  assert(out.reverted === 1 && out.scored[0]?.action_taken === 'reverted', 'a clean regression is auto-reverted');
  assert(overrides.active_for('specialist') === null, 'the override is actually lifted');
  assert(
    (misses[0]!.gap ?? '').includes('AUTO-REVERTED'),
    'the miss still files — a revert starts the investigation, it does not end it',
  );
  assert(wakes.length === 1, 'and Beatrice is still woken to find out why');
}

{
  // MIXED must never auto-revert, even armed.
  overrides.apply({ role: 'deep_consult', patch: { model: 'mixed-trial' }, reason: 'x', applied_by: 'jasper' });
  const id = windows.open({
    kind: 'llm_role_override',
    ref: 'lro_z',
    target: 'deep_consult',
    reason: 'mixed',
    applied_by: 'jasper',
    baseline: m({ t1: true, t2: false, t3: true, t4: true }),
  });
  eval_row('t1', false, '2026-08-04T00:00:00Z');
  eval_row('t2', true, '2026-08-04T00:00:00Z');
  for (const t of ['t3', 't4']) eval_row(t, true, '2026-08-04T00:00:00Z');

  const out = await tool.execute({ window_id: id }, ctx);
  assert(out.scored[0]?.verdict === 'neutral', 'a mixed result scores neutral');
  assert(out.reverted === 0, 'and is NEVER auto-reverted, even armed — that trade-off is the owner\'s call');
  assert(overrides.active_for('deep_consult') !== null, 'the mixed change stays live');
}

{
  // A non-machine-revertible kind escalates with the right next step, armed.
  const id = windows.open({
    kind: 'code_merge',
    ref: 'abc1234',
    target: 'src/core/thing.ts',
    reason: 'merged PR',
    applied_by: 'trainer',
    baseline: m({ t1: true, t2: true, t3: true, t4: true }),
  });
  misses.length = 0;
  for (const t of ['t1', 't2']) eval_row(t, false, '2026-08-05T00:00:00Z');
  for (const t of ['t3', 't4']) eval_row(t, true, '2026-08-05T00:00:00Z');

  const out = await tool.execute({ window_id: id }, ctx);
  assert(out.reverted === 0 && out.flagged === 1, 'a code merge is flagged, never auto-reverted, even armed');
  assert((misses[0]!.gap ?? '').includes('git revert abc1234'), 'and the escalation names the exact human step');
  delete process.env.HEARTH_AUTO_REVERT;
}

/* ================================================================== */
console.log('\nE. improved / not-yet-measurable windows');
/* ================================================================== */

{
  const id = windows.open({
    kind: 'llm_role_override',
    ref: 'lro_good',
    target: 'specialist',
    reason: 'a good change',
    applied_by: 'jasper',
    baseline: m({ t1: false, t2: false, t3: true, t4: true }),
  });
  for (const t of ['t1', 't2', 't3', 't4']) eval_row(t, true, '2026-08-06T00:00:00Z');
  misses.length = 0;
  const out = await tool.execute({ window_id: id }, ctx);
  assert(out.scored[0]?.verdict === 'improved', 'an improvement is scored as such');
  assert(misses.length === 0 && out.flagged === 0, 'and makes no noise');
}

{
  const id = windows.open({
    kind: 'llm_role_override',
    ref: 'lro_new',
    target: 'specialist',
    reason: 'too new',
    applied_by: 'jasper',
    baseline: m({ never_ran_a: true, never_ran_b: true }),
  });
  const out = await tool.execute({ window_id: id }, ctx);
  assert(out.still_pending === 1 && out.scored.length === 0, 'an unmeasurable window stays PENDING for the next run');
  assert(windows.get(id)?.verdict === null, 'it is not burned on a verdict that says nothing');
}

db.close();
rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\nsmoke:change-windows OK' : `\nsmoke:change-windows FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
