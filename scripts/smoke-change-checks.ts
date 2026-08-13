/**
 * smoke:change-checks — the deterministic check gate on Beatrice's pipeline.
 *
 * Proves the missing layer of Beatrice's self-modification loop: a change that
 * doesn't COMPILE never becomes a PR, and Kate (an LLM reading the diff) cannot
 * approve a change that failed automated checks.
 *
 * Two halves, both self-contained (no orchestrator, no network, no remotes):
 *   A. `run_checks` directly — a deliberately-broken .ts → FAIL carrying the tsc
 *      output; a valid .ts → PASS; a config-only change skips tsc but runs
 *      guard; a guard failure fails the gate.
 *   B. The store + Kate-review gate — a `checks_passed=false` change is
 *      un-approvable (deny still works); a green change persists its verdict and
 *      is approvable.
 *
 *   bun run smoke:change-checks
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { ChangeRecordsStore } from '@memory/stores/change_records';
import { ProposalsStore } from '@core/proposals';
import { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';
import type { ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  run_checks,
  run_tsc_noEmit,
  ChecksFailedError,
} from '@specialists/trainer/change_pipeline';
import { create as create_review } from '@specialists/kate/tools/review_change';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const MINIMAL_TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    module: 'ESNext',
    target: 'ES2022',
    moduleResolution: 'bundler',
    isolatedModules: true,
  },
  include: ['*.ts'],
});

/** Scaffold a worktree-like temp dir: package.json (guard script), tsconfig,
 *  and the given source files. `run_checks` symlinks node_modules itself. */
function scaffold(guard_cmd: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'hearth-checks-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 't', version: '0.0.0', scripts: { guard: guard_cmd } }));
  writeFileSync(join(dir, 'tsconfig.json'), MINIMAL_TSCONFIG);
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
  return dir;
}

const temp_dirs: string[] = [];
function mk(guard_cmd: string, files: Record<string, string>): string {
  const d = scaffold(guard_cmd, files);
  temp_dirs.push(d);
  return d;
}

const dbdir = mkdtempSync(join(tmpdir(), 'hearth-checks-db-'));
const db = open_db(join(dbdir, 'checks.db'));

try {
  // ── A. run_checks / run_tsc_noEmit against real tsc + guard ───────────────

  // A1. A type error is caught, and the failing tsc output is carried.
  const broken_dir = mk('exit 0', { 'broken.ts': 'export const x: number = "not a number";\n' });
  const broken = run_checks(broken_dir, ['broken.ts']);
  check('a non-compiling .ts FAILS the gate', broken.passed === false);
  check('  …the summary carries the tsc output (error TS / tsc)', /error TS\d+|tsc --noEmit: FAIL/.test(broken.summary));
  check('  …and ran_tsc is true for a .ts change', broken.ran_tsc === true);

  // A2. A valid .ts passes.
  const ok_dir = mk('exit 0', { 'valid.ts': 'export const x: number = 1;\n' });
  const ok = run_checks(ok_dir, ['valid.ts']);
  check('a valid .ts PASSES the gate', ok.passed === true);
  check('  …summary records both checks passing', ok.summary.includes('tsc --noEmit: PASS') && ok.summary.includes('guard'));

  // A3. A config-only change skips tsc but still runs guard.
  const cfg_dir = mk('exit 0', { 'broken.ts': 'export const x: number = "still broken";\n' });
  const cfg = run_checks(cfg_dir, ['config/specialists/kristi.yaml']);
  check('a config-only change SKIPS tsc (irrelevant) but still passes guard', cfg.passed === true && cfg.ran_tsc === false);
  check('  …summary notes tsc was skipped', cfg.summary.includes('tsc --noEmit: skipped'));

  // A4. A guard failure fails the gate even when tsc would pass.
  const guard_fail_dir = mk('exit 1', { 'valid.ts': 'export const x: number = 1;\n' });
  const guard_fail = run_checks(guard_fail_dir, ['valid.ts']);
  check('a guard failure FAILS the gate', guard_fail.passed === false);
  check('  …the summary names the guard failure', guard_fail.summary.includes('guard (time + encoding): FAIL'));

  // A5. run_tsc_noEmit is independently usable and self-cleans its symlink.
  const tsc_dir = mk('exit 0', { 'broken.ts': 'export const y: string = 42;\n' });
  const tsc_only = run_tsc_noEmit(tsc_dir);
  check('run_tsc_noEmit detects a type error directly', tsc_only.ok === false && /error TS\d+/.test(tsc_only.output));

  // A6. ChecksFailedError carries the summary verbatim (what open_change_pr throws).
  const err = new ChecksFailedError(broken.summary);
  check('ChecksFailedError carries the check summary (returned to Beatrice)', err.message.includes(broken.summary) && err.name === 'ChecksFailedError');

  // ── B. The store + Kate-review gate ───────────────────────────────────────
  const store = new ChangeRecordsStore(db);
  const proposals = new ProposalsStore(db);
  const inbox = new SpecialistInbox(db);
  const events = { emit: () => undefined } as unknown as AppEventBus;
  const ctx = { memory: { log_action: () => 'audit_smoke' }, intent_id: 'smoke', specialist_id: 'kate', now: new Date() } as unknown as ToolContext;
  const reviewTool = create_review({ db, proposals, inbox, events } as unknown as ToolDeps);

  const mkchange = (dedup: string, checks_passed: boolean | null, checks_summary: string) =>
    store.create({
      origin: 'propose_code_change',
      change_kind: 'code',
      branch: `beatrice/checks-${dedup}`,
      pr_number: 7,
      pr_url: 'http://gitea/test/pr/7',
      commit_sha: 'abc',
      files: ['src/core/foo.ts'],
      lines_added: 3,
      lines_removed: 1,
      languages: ['TypeScript'],
      diff_summary: '+ const x = 1;',
      rationale_md: 'a code change',
      dedup_key: dedup,
      checks_passed,
      checks_summary,
    });

  // B1. The check verdict round-trips through the store (schema threading).
  const green = mkchange('green', true, 'guard: PASS\n\ntsc --noEmit: PASS');
  check('a green change persists checks_passed=true', store.get(green.id)?.checks_passed === true);
  check('  …and the checks_summary', store.get(green.id)?.checks_summary?.includes('tsc --noEmit: PASS') === true);

  const red = mkchange('red', false, 'tsc --noEmit: FAIL\nfoo.ts(1,7): error TS2322: ...');
  check('a red change persists checks_passed=false', store.get(red.id)?.checks_passed === false);

  // B2. Kate CANNOT approve a red change — but deny still works.
  const refused = (await reviewTool.execute(
    { change_id: red.id, verdict: 'approve', reasons_md: 'Looks reasonable from the diff, approving.' },
    ctx,
  )) as { new_status: string; routed_to: string; proposal_id: string | null; reason?: string };
  check('Kate cannot APPROVE a checks_passed=false change', refused.routed_to === 'none' && refused.proposal_id === null);
  check('  …refusal names the automated-check failure', !!refused.reason && /automated checks|does not\s+compile/i.test(refused.reason));
  check('  …and the red change did NOT advance', store.get(red.id)?.status === 'pending_kate_review');

  const refused_concerns = (await reviewTool.execute(
    { change_id: red.id, verdict: 'approve_with_concerns', reasons_md: 'Minor concerns but okay overall.' },
    ctx,
  )) as { routed_to: string };
  check('Kate cannot approve_with_concerns a red change either', refused_concerns.routed_to === 'none');

  const denied = (await reviewTool.execute(
    { change_id: red.id, verdict: 'deny', reasons_md: 'It failed automated checks and does not compile.' },
    ctx,
  )) as { new_status: string; routed_to: string };
  check('Kate CAN still deny a red change (routes back to Beatrice)', denied.new_status === 'denied_by_kate' && denied.routed_to === 'trainer');

  // B3. A green change is approvable — the gate only blocks failures.
  const approved = (await reviewTool.execute(
    { change_id: green.id, verdict: 'approve', reasons_md: 'Verified the diff is in-scope and correct; checks are green.' },
    ctx,
  )) as { new_status: string; routed_to: string; proposal_id: string | null };
  check('Kate CAN approve a green change → pending_owner_merge', approved.new_status === 'pending_owner_merge' && approved.routed_to === 'owner');
  check('  …filing an owner merge proposal', !!approved.proposal_id);

  // B4. A legacy/unrecorded (null) change is NOT retroactively blocked.
  const legacy = mkchange('legacy', null, '');
  const legacy_ok = (await reviewTool.execute(
    { change_id: legacy.id, verdict: 'approve', reasons_md: 'Pre-gate change with no recorded checks; reviewing on the diff.' },
    ctx,
  )) as { new_status: string; routed_to: string };
  check('a null-checks (legacy) change is still reviewable', legacy_ok.new_status === 'pending_owner_merge' && legacy_ok.routed_to === 'owner');
} finally {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  rmSync(dbdir, { recursive: true, force: true });
  for (const d of temp_dirs) rmSync(d, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} change-checks assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nAll change-checks assertions passed.');
