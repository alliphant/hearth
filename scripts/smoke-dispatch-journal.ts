/**
 * smoke:dispatch-journal — the directed-dispatch journal contract (2026-08-10).
 *
 * A directed build fires fire-and-forget in-process while its upstream records
 * are already terminal (acknowledged proposal, "do NOT re-file" FYI), so an
 * orchestrator restart mid-build used to lose the work invisibly. The fix is a
 * durable journal written at the ONE door every directed fire passes through
 * (`LoopDriver.fire_deliberation_now`) + boot reconciliation that re-fires
 * unfinished rows. This smoke asserts the contract at that seam:
 *
 *   - a directed fire journals BEFORE the pass and stamps 'ok' after
 *   - a failing pass stamps 'failed' + the error, and still rethrows
 *   - a pass killed mid-flight (never settles) leaves finished_at NULL —
 *     the exact signature boot reconciliation looks for
 *   - a reconciliation re-fire ADOPTS the existing row (journal_id), so one
 *     logical build stays one row across boots
 *   - non-directed passes and unknown specialists journal NOTHING
 *   - store primitives the reconciler leans on: bump_attempt, the
 *     MAX_DISPATCH_ATTEMPTS cap value, abandon, finish idempotency, and
 *     corrupt-task_json hydration (task: null → abandon path)
 *
 * Self-contained: temp SQLite, stub specialists, deliberate() overridden — no
 * LLM, no network, no orchestrator.
 *
 *   bun run smoke:dispatch-journal
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { open_db } from '@memory/stores/structured';
import {
  DirectedDispatchStore,
  MAX_DISPATCH_ATTEMPTS,
} from '@memory/stores/directed_dispatches';
import { LoopDriver, type LoopDriverDeps } from '@core/loops';
import type { LoadedSpecialist } from '@core/specialist';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

// deliberate() is the pass runner; the journal wiring under test lives in
// fire_deliberation_now AROUND it, so the override is the whole harness.
class StubDriver extends LoopDriver {
  behavior: 'ok' | 'fail' | 'hang' = 'ok';
  passes = 0;
  override async deliberate(): Promise<void> {
    this.passes++;
    if (this.behavior === 'fail') throw new Error('model exploded');
    if (this.behavior === 'hang') return new Promise<void>(() => {});
  }
}

const dir = mkdtempSync(resolve(tmpdir(), 'hearth-dispatch-journal-'));
const db = open_db(resolve(dir, 'hearth.db'));

try {
  const journal = new DirectedDispatchStore(db);
  const specialists = {
    get: (id: string) => (id === 'kate' ? ({ id: 'kate' } as unknown as LoadedSpecialist) : undefined),
  };
  const driver = new StubDriver({
    db,
    specialists,
    dispatch_journal: journal,
  } as unknown as LoopDriverDeps);

  const task = { instruction: 'author the frobnicator tool', tools: ['propose_code_change'] };

  // ── 1. happy path: journal before, 'ok' after ───────────────────────────
  await driver.fire_deliberation_now('kate', 'build', task, undefined, {
    source: 'decide',
    proposal_id: 'prop_123',
  });
  const [ok_row] = journal.recent(1);
  check('directed fire journals a row', ok_row != null);
  check('row carries source + proposal attribution', ok_row?.source === 'decide' && ok_row?.proposal_id === 'prop_123');
  check('row round-trips the DirectedTask', ok_row?.task?.instruction === task.instruction && ok_row?.task?.tools?.[0] === 'propose_code_change');
  check('settled pass stamps outcome ok', ok_row?.outcome === 'ok' && ok_row?.finished_at != null);

  // ── 2. failing pass: 'failed' + error, and the caller still sees the throw ─
  driver.behavior = 'fail';
  let threw = false;
  await driver.fire_deliberation_now('kate', 'build', task, undefined, { source: 'court' }).catch(() => {
    threw = true;
  });
  // recent() orders by fired_at, which can tie at millisecond resolution —
  // find the row by its attribution instead.
  const fail_row = journal.recent(10).find((r) => r.source === 'court');
  check('failing pass stamps outcome failed + error', fail_row?.outcome === 'failed' && fail_row?.error === 'model exploded');
  check('the rejection still reaches the caller', threw);

  // ── 3. the restart signature: a hung pass leaves finished_at NULL ───────
  driver.behavior = 'hang';
  void driver.fire_deliberation_now('kate', 'build', task, undefined, { source: 'scrum' });
  await new Promise((r) => setTimeout(r, 10)); // let the journal write land
  const stale = journal.unfinished();
  check('a never-settling pass is visible as unfinished', stale.length === 1 && stale[0]?.source === 'scrum');

  // ── 4. reconciliation re-fire adopts the row instead of opening a second ─
  const before = journal.recent(200).length;
  const casualty = stale[0]!;
  journal.bump_attempt(casualty.id);
  driver.behavior = 'ok';
  await driver.fire_deliberation_now('kate', casualty.slot, casualty.task!, undefined, {
    source: casualty.source,
    journal_id: casualty.id,
  });
  const adopted = journal.get(casualty.id);
  check('re-fire with journal_id finishes the SAME row', adopted?.outcome === 'ok' && adopted?.attempts === 2);
  check('no second row was opened for the re-fire', journal.recent(200).length === before);
  check('nothing is left unfinished after reconciliation', journal.unfinished().length === 0);

  // ── 5. non-directed passes and unknown specialists journal nothing ──────
  const count_before = journal.recent(200).length;
  await driver.fire_deliberation_now('kate', '07:00');
  await driver.fire_deliberation_now('nobody', 'build', task, undefined, { source: 'decide' });
  check('a plain (non-directed) pass journals nothing', journal.recent(200).length === count_before);
  check('an unknown specialist journals nothing (fire no-ops)', journal.recent(200).length === count_before);

  // ── 6. reconciler store primitives ──────────────────────────────────────
  check(`attempt cap is ${MAX_DISPATCH_ATTEMPTS}`, MAX_DISPATCH_ATTEMPTS === 3);

  const ab_id = journal.open({ source: 'decide', specialist_id: 'kate', slot: 'build', task });
  journal.abandon(ab_id, 'died in 3 attempt(s)');
  const abandoned = journal.get(ab_id);
  check('abandon stamps a terminal abandoned outcome', abandoned?.outcome === 'abandoned' && abandoned?.finished_at != null);

  journal.finish(ab_id, true); // must NOT overwrite the terminal stamp
  check('finish is a no-op on an already-terminal row', journal.get(ab_id)?.outcome === 'abandoned');

  db.prepare(
    `INSERT INTO directed_dispatches (id, source, specialist_id, slot, task_json, fired_at)
     VALUES ('dd_corrupt', 'decide', 'kate', 'build', 'not json', '2026-08-10T00:00:00.000Z')`,
  ).run();
  const corrupt = journal.get('dd_corrupt');
  check('corrupt task_json hydrates as task: null (abandon path)', corrupt != null && corrupt.task === null);
  check('corrupt row still shows up as unfinished for the reconciler', journal.unfinished().some((r) => r.id === 'dd_corrupt'));
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? '\nsmoke:dispatch-journal OK'
    : `\nsmoke:dispatch-journal FAILED (${failures} check(s))`,
);
process.exit(failures === 0 ? 0 : 1);
