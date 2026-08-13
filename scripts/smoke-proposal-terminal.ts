export {};
/**
 * smoke:proposal-terminal — the `acknowledged` terminal state for approvals
 * that have no system execution (the stuck-`approved` fix).
 *
 * Self-contained (temp db). Covers `mark_acknowledged` (guarded + idempotent),
 * the boot triage `backfill_acknowledge_stuck`, the re-fire-collapse regression
 * guard (a re-fire still collapses against an `acknowledged` row, exactly as it
 * did against the old stuck-`approved`), and Mariah's `stalled_approved`
 * dashboard signal.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { ProposalsStore } from '../src/core/proposals';
import { make_program_dashboard } from '../src/specialists/mariah/tools/program_dashboard';
import type { ToolContext } from '../src/core/tool';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-prop-terminal-'));
const db = open_db(join(dir, 'smoke.db'));
const proposals = new ProposalsStore(db);
const sig = (anchor: string) => ({ specialist_id: 'kate', kind: 'test', category: 'test', anchor });
const mk = (anchor: string, rationale: string): string =>
  proposals.create({
    specialist_id: 'kate',
    kind: 'briefing',
    execution_kind: 'manual',
    payload: { anchor },
    rationale,
    signature: sig(anchor),
  });

async function main(): Promise<void> {
  // ── 1. mark_acknowledged: approved → acknowledged + ts_executed ──────────
  const a = mk('a', 'a rationale');
  proposals.decide(a, 'approve');
  check('a decided approved, ts_executed null (the stuck shape)', proposals.get(a)?.status === 'approved' && proposals.get(a)?.ts_executed == null);
  proposals.mark_acknowledged(a);
  check('mark_acknowledged → acknowledged', proposals.get(a)?.status === 'acknowledged');
  check('mark_acknowledged stamps ts_executed', proposals.get(a)?.ts_executed != null);
  const ts1 = proposals.get(a)?.ts_executed;
  proposals.mark_acknowledged(a); // idempotent: guard on status='approved'
  check('mark_acknowledged is idempotent', proposals.get(a)?.ts_executed === ts1);

  // guard: a denied row is never acknowledged.
  const d = mk('d', 'd rationale');
  proposals.decide(d, 'deny');
  proposals.mark_acknowledged(d);
  check('denied row untouched by mark_acknowledged', proposals.get(d)?.status === 'denied');

  // ── 2. backfill triage of the legacy stuck pile ─────────────────────────
  const s1 = mk('s1', 's1');
  const s2 = mk('s2', 's2');
  proposals.decide(s1, 'approve'); // stuck approved
  proposals.decide(s2, 'approve'); // stuck approved
  const denied = mk('dn', 'dn');
  proposals.decide(denied, 'deny');
  const res = proposals.backfill_acknowledge_stuck();
  check('backfill stamps exactly the 2 stuck rows', res.rows_updated === 2);
  check('s1 → acknowledged', proposals.get(s1)?.status === 'acknowledged' && proposals.get(s1)?.ts_executed != null);
  check('s2 → acknowledged', proposals.get(s2)?.status === 'acknowledged');
  check('denied row not touched by backfill', proposals.get(denied)?.status === 'denied');
  check('backfill is idempotent (0 on re-run)', proposals.backfill_acknowledge_stuck().rows_updated === 0);

  // ── 3. re-fire collapse STILL blocks against an acknowledged row ─────────
  const p1 = mk('refire', 'same stable rationale');
  proposals.decide(p1, 'approve');
  proposals.mark_acknowledged(p1);
  const p2 = mk('refire', 'same stable rationale'); // same sig + rationale, within 24h
  check('re-fire collapses against the acknowledged row (no dup)', p2 === p1);
  // a HARD terminal (denied) still allows a re-attempt.
  const q1 = mk('reattempt', 'q rationale');
  proposals.decide(q1, 'deny');
  const q2 = mk('reattempt', 'q rationale');
  check('re-fire after a denial creates a fresh row', q2 !== q1);

  // ── 4. dashboard stalled_approved signal ────────────────────────────────
  const dash = make_program_dashboard(db, proposals);
  const ctx = { now: new Date() } as unknown as ToolContext;
  const before = (await dash.execute({}, ctx)) as { stalled_approved: number };
  check('stalled_approved is 0 after everything is acknowledged/denied', before.stalled_approved === 0);
  // create a fresh stuck-approved row and confirm the dashboard catches it.
  const stuck = mk('stuck', 'stuck');
  proposals.decide(stuck, 'approve');
  const during = (await dash.execute({}, ctx)) as { stalled_approved: number };
  check('stalled_approved counts a fresh stuck row', during.stalled_approved === 1);
  proposals.backfill_acknowledge_stuck();
  const after = (await dash.execute({}, ctx)) as { stalled_approved: number };
  check('stalled_approved back to 0 after triage', after.stalled_approved === 0);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    console.log(failures === 0 ? '\nsmoke:proposal-terminal OK' : `\nsmoke:proposal-terminal FAILED (${failures})`);
    process.exit(failures === 0 ? 0 : 1);
  });
