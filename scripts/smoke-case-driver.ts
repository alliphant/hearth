/**
 * smoke:case-driver — the Case Driver (Incident→Immunity S1) + the S4
 * deliberation-think resolution.
 *
 * Self-contained: temp db, spy waker, no LLM, no orchestrator. Exercises:
 *   - kill switch (HEARTH_CASE_DRIVER unset → enabled:false, zero action)
 *   - NUDGE: a stale open miss → ONE wake at trainer naming the pm_id, a
 *     durable [case-driver] marker; a FRESH miss is untouched
 *   - cooldown: an immediate re-run does NOT re-nudge
 *   - VERIFY: a stale redo_dispatched miss → wake at mariah
 *   - META-LOOP guard: a trainer-reported miss about trainer is skipped
 *   - ESCALATE-ONCE: past the nudge budget → status 'escalated' + ONE
 *     aggregate owner recommendation; the next run does nothing more
 *   - FAIL-OPEN: a throwing waker never breaks the walk
 *   - S4: resolve_deliberation_think precedence matrix (explicit per-pass >
 *     HEARTH_SCRUTINY_THINK for directed/trigger passes > two-way YAML flag
 *     — the previously-dead `true` branch — > role default) and the scoped-
 *     wake think threading via TriggerContext.
 *
 *   bun run smoke:case-driver
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { ProcessMissStore } from '@core/process_misses';
import { ProposalsStore } from '@core/proposals';
import { run_case_driver, type ScopedWake } from '@core/case_driver';
import { resolve_deliberation_think } from '@core/deliberation';
import type { LoadedSpecialist } from '@core/specialist';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

function backdate(db: ReturnType<typeof open_db>, id: string, days: number): void {
  const ts = new Date(Date.now() - days * 86_400_000).toISOString();
  db.prepare(`UPDATE process_misses SET ts_updated = @ts WHERE id = @id`).run({ '@ts': ts, '@id': id });
}

function plant_marker(db: ReturnType<typeof open_db>, id: string, marker: string, days_ago: number): void {
  const ts = new Date(Date.now() - days_ago * 86_400_000).toISOString();
  const row = db.prepare(`SELECT notes_md FROM process_misses WHERE id = @id`).get({ '@id': id }) as { notes_md: string };
  db.prepare(`UPDATE process_misses SET notes_md = @n WHERE id = @id`).run({
    '@n': `${row.notes_md}\n- [${ts}] open -> open: ${marker}`,
    '@id': id,
  });
}

async function main(): Promise<void> {
  delete process.env.HEARTH_CASE_DRIVER;
  delete process.env.HEARTH_SCRUTINY_THINK;
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-case-driver-'));
  const db = open_db(join(tmp, 'h.db'));
  const misses = new ProcessMissStore(db);
  const proposals = new ProposalsStore(db);
  const wakes: Array<{ id: string; opts: ScopedWake }> = [];
  const deps = { misses, proposals, wake: (id: string, opts: ScopedWake) => wakes.push({ id, opts }) };

  // ── seed ────────────────────────────────────────────────────────────────
  const stale_open = misses.create({ subject_specialist_id: 'maggie', reporter: 'mariah', task_summary: 'venue scrape', gap: 'browse_url defer-storm on venue calendars', severity: 'high', evidence_ref: 'browse:maggie:venues' });
  const fresh_open = misses.create({ subject_specialist_id: 'vivian', reporter: 'mariah', task_summary: 'ledger', gap: 'fresh miss — should be untouched', severity: 'low', evidence_ref: 'fresh:vivian' });
  const stale_redo = misses.create({ subject_specialist_id: 'iris', reporter: 'mariah', task_summary: 'ev tool', gap: 'fix dispatched, never verified', severity: 'medium', evidence_ref: 'tool:iris:ev' });
  misses.update_status(stale_redo, 'routed', 'routing', 'trainer');
  misses.update_status(stale_redo, 'redo_dispatched', 'fix dispatched');
  const meta_self = misses.create({ subject_specialist_id: 'trainer', reporter: 'trainer', task_summary: 'self', gap: 'trainer about trainer by trainer', severity: 'low', evidence_ref: 'meta:self' });
  backdate(db, stale_open, 5);
  backdate(db, stale_redo, 5);
  backdate(db, meta_self, 9);

  // ── 1. kill switch ──────────────────────────────────────────────────────
  const off = run_case_driver(deps);
  check('kill switch: disabled → no examination, no wakes', off.enabled === false && off.examined === 0 && wakes.length === 0);
  process.env.HEARTH_CASE_DRIVER = '1';

  // ── 2. first pass: nudge + verify + meta-skip ───────────────────────────
  const r1 = run_case_driver(deps);
  check('stale open miss nudged', r1.nudged.includes(stale_open));
  check('fresh miss untouched', !r1.nudged.includes(fresh_open) && !r1.verify_swept.includes(fresh_open));
  check('stale redo_dispatched swept to verification', r1.verify_swept.includes(stale_redo));
  check('meta self-report skipped', r1.skipped_meta === 1);
  const trainer_wake = wakes.find((w) => w.id === 'trainer');
  const mariah_wake = wakes.find((w) => w.id === 'mariah');
  check('trainer wake names the pm_id + a diagnostic next step', Boolean(trainer_wake && trainer_wake.opts.task.includes(stale_open) && /diagnose/i.test(trainer_wake.opts.task)));
  check('mariah wake names verify_fix_landed', Boolean(mariah_wake && mariah_wake.opts.task.includes(stale_redo) && mariah_wake.opts.task.includes('verify_fix_landed')));
  check('driver does not force think (bench verdict — env owns the dial)', trainer_wake?.opts.think === undefined);
  check('durable nudge marker recorded', (misses.get(stale_open)?.notes_md ?? '').includes('[case-driver] nudge'));

  // ── 3. cooldown: immediate re-run does nothing ──────────────────────────
  const before = wakes.length;
  const r2 = run_case_driver(deps);
  check('cooldown holds: no re-nudge on immediate re-run', r2.nudged.length === 0 && r2.verify_swept.length === 0 && wakes.length === before);

  // ── 4. escalate-once past the nudge budget ──────────────────────────────
  plant_marker(db, stale_open, '[case-driver] nudge #1', 6);
  plant_marker(db, stale_open, '[case-driver] nudge #2', 3);
  const r3 = run_case_driver(deps);
  check('past the budget → escalated', r3.escalated.includes(stale_open));
  check('status machine moved to escalated', misses.get(stale_open)?.status === 'escalated');
  const esc = proposals.list({ status: 'pending', limit: 10 }).filter((p) => p.kind === 'recommendation');
  check('ONE aggregate owner recommendation filed', esc.length === 1 && (esc[0]!.rationale_md ?? '').includes('stall escalation'));
  const r4 = run_case_driver(deps);
  check('escalate-once: nothing further on the next run', r4.escalated.length === 0 && r4.nudged.length === 0);

  // ── 5. fail-open waker ──────────────────────────────────────────────────
  const boom = misses.create({ subject_specialist_id: 'anna', reporter: 'mariah', task_summary: 'comps', gap: 'stale for the throwing-waker case', severity: 'low', evidence_ref: 'boom:anna' });
  backdate(db, boom, 5);
  const r5 = run_case_driver({ ...deps, wake: () => { throw new Error('waker down'); } });
  check('throwing waker never breaks the walk', r5.enabled === true && r5.examined > 0);

  // ── 5b. RECURRENCE: promptly-closed misses that keep coming back ────────
  // The live failure this pass exists for: 934 misses, 933 closed, ZERO ever
  // escalated — because every staleness bucket above only reads live misses,
  // while the same defect re-opened 13 times in 18 days and closed same-day
  // each time. Perfect throughput, no learning.
  wakes.length = 0;
  const consult_gap = (n: number, note: string) =>
    `Mariah answered a consult with ${n} unrecovered read failure(s) in the same turn: read_note() → "${note}"`;
  const recur_ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const id = misses.create({
      subject_specialist_id: 'mariah',
      reporter: 'orchestrator',
      task_summary: `consult ${i}`,
      gap: consult_gap(i + 1, `Knowledge/Mariah/note-${i}.md`),
      severity: 'medium',
      evidence_ref: `consult:mariah:${i}`,
    });
    recur_ids.push(id);
    misses.update_status(id, 'routed', 'routing', 'trainer');
    misses.update_status(id, 'redo_dispatched', 'redo');
    misses.update_status(id, 'verified', 'redo delivered');
    misses.update_status(id, 'closed', 'closed same day');
  }
  const r6 = run_case_driver(deps);
  const repair = wakes.find((w) => w.opts.dedupe_key.startsWith('case-driver:repair:'));
  check('recurrence: a CLOSED-but-recurring class is caught', r6.repairs_requested.length === 1);
  check('recurrence: the wake goes to the fix owner', repair?.id === 'trainer');
  check('recurrence: it asks for a repair, not another redo',
    (repair?.opts.task ?? '').includes('stop redoing and repair the cause'));
  check('recurrence: the ask carries the count and the evidence',
    (repair?.opts.reason ?? '').includes('x4') && (repair?.opts.task ?? '').includes(recur_ids[0]!));
  const r7 = run_case_driver(deps);
  check('recurrence: once per class — the next pass is silent',
    r7.repairs_requested.length === 0);
  // A one-off is not a pattern.
  const lone = misses.create({ subject_specialist_id: 'linda', reporter: 'mariah', task_summary: 'listing', gap: 'a single unrepeated listing-draft failure occurred here', severity: 'low', evidence_ref: 'lone:linda' });
  misses.update_status(lone, 'closed', 'done');
  const r8 = run_case_driver(deps);
  check('recurrence: a one-off never escalates', r8.repairs_requested.length === 0);

  // ── 6. S4 think resolution matrix ───────────────────────────────────────
  const spec = (yaml_think: boolean | undefined): LoadedSpecialist =>
    ({ proactive: { think_in_deliberation: yaml_think } }) as unknown as LoadedSpecialist;
  check('explicit directed think:false wins over everything',
    resolve_deliberation_think(spec(true), { instruction: 'x', think: false }) === false);
  check('explicit trigger think:true wins',
    resolve_deliberation_think(spec(false), undefined, { reason: 'r', task: 't', think: true }) === true);
  check('env unset: directed pass → no override (role default rules)',
    resolve_deliberation_think(spec(undefined), { instruction: 'x' }) === undefined);
  process.env.HEARTH_SCRUTINY_THINK = '1';
  check('env=1: directed pass defaults think-ON',
    resolve_deliberation_think(spec(undefined), { instruction: 'x' }) === true);
  check('env=1: trigger pass defaults think-ON',
    resolve_deliberation_think(spec(undefined), undefined, { reason: 'r', task: 't' }) === true);
  check('env=1 does NOT touch scheduled passes',
    resolve_deliberation_think(spec(undefined)) === undefined);
  delete process.env.HEARTH_SCRUTINY_THINK;
  check('YAML true is honored (the previously-dead branch)',
    resolve_deliberation_think(spec(true)) === true);
  check('YAML false is honored',
    resolve_deliberation_think(spec(false)) === false);

  delete process.env.HEARTH_CASE_DRIVER;
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\nsmoke:case-driver — ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
