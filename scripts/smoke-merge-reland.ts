/**
 * smoke:merge-reland — staged merge recovery for owner-approved changes.
 *
 * Proves the self-heal ladder behind `merge_approved_change`: a Kate-approved +
 * owner-approved change whose PR went stale against a moved main no longer
 * parks silently at `merge_failed`. Self-contained: a FAKE Gitea API (Bun.serve,
 * scripted per-PR responses) + a REAL temp git fixture (bare origin + clone as
 * HEARTH_REPO_ROOT; YAML-only changes so the checks gate runs guard but skips
 * tsc). No orchestrator, no live Gitea, no HEARTH_TEST_MODE (TEST_MODE would
 * short-circuit the very merge calls under test).
 *
 * Matrix:
 *   A. direct merge succeeds                      → merged via 'direct'
 *   B. 405 then update-branch resolves            → merged via 'branch_update'
 *   C. conflict but content already on main       → merged via 'already_applied'
 *   D. conflict, stored edits still apply         → re-land: fresh branch + PR,
 *      old row superseded, Kate verdict carried, new row merged via 'reland'
 *   E. conflict, edits no longer apply            → merge_failed + waking flag
 *   F. conflict, legacy row without stored inputs → merge_failed + waking flag
 *   G. non-mergeability error (HTTP 500)          → merge_failed + waking flag
 *
 *   bun run smoke:merge-reland
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { open_db } from '@memory/stores/structured';
import { ChangeRecordsStore, type StoredChangeInputs } from '@memory/stores/change_records';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  [${detail}]` : ''}`);
  if (!ok) failures++;
}

// ── Fixture: bare origin + clone (becomes HEARTH_REPO_ROOT) ─────────────────
const root = mkdtempSync(join(tmpdir(), 'hearth-reland-'));
const origin = join(root, 'origin.git');
const clone = join(root, 'clone');
const GIT_ID = ['-c', 'user.name=smoke', '-c', 'user.email=smoke@test.local'];

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const SEED_YAML = ['tools:', '  - alpha', '  - beta', 'applied_marker: present', ''].join('\n');

spawnSync('git', ['init', '--bare', '-b', 'main', origin], { encoding: 'utf-8' });
mkdirSync(clone, { recursive: true });
git(clone, 'init', '-b', 'main');
mkdirSync(join(clone, 'config'), { recursive: true });
writeFileSync(join(clone, 'config', 'seed.yaml'), SEED_YAML);
// `bun run guard` must exist in the worktree checkout — commit a no-op script.
writeFileSync(
  join(clone, 'package.json'),
  JSON.stringify({ name: 'fixture', version: '0.0.0', scripts: { guard: 'exit 0' } }),
);
git(clone, 'add', '-A');
git(clone, 'commit', '-m', 'seed');
git(clone, 'remote', 'add', 'origin', origin);
git(clone, 'push', '-u', 'origin', 'main');

// Module-load-time constants in change_pipeline read these — set BEFORE import.
process.env.HEARTH_REPO_ROOT = clone;
process.env.HEARTH_WORKTREE_ROOT = join(root, 'worktrees');
delete process.env.HEARTH_TEST_MODE;

const { PrNotMergeableError, plan_reland } = await import('@specialists/trainer/change_pipeline');
const { merge_with_recovery } = await import('@specialists/trainer/merge_recovery');
type GitConfig = import('@specialists/trainer/change_pipeline').GitConfig;

// ── Fake Gitea: scripted per-PR response queues ──────────────────────────────
const fake = {
  next_pr: 70,
  merge_q: new Map<number, number[]>(), // HTTP status per merge attempt; default 200
  update_q: new Map<number, number[]>(), // HTTP status per update attempt; default 200
  merged: new Map<number, { merged: boolean; sha: string | null }>(),
  created: [] as Array<{ number: number; head: string }>,
};
const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    const m = url.pathname.match(
      /^\/api\/v1\/repos\/jasper\/fixrepo\/pulls(?:\/(\d+))?(?:\/(merge|update))?$/,
    );
    if (!m) return new Response('not found', { status: 404 });
    const n = m[1] ? Number.parseInt(m[1], 10) : null;
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

    if (req.method === 'POST' && n === null) {
      // PR create (re-land path)
      const body = (await req.json()) as { head?: string };
      const num = fake.next_pr++;
      fake.created.push({ number: num, head: body.head ?? '' });
      return json({ html_url: `http://fake/pr/${num}`, number: num });
    }
    if (req.method === 'POST' && n !== null && m[2] === 'merge') {
      const code = fake.merge_q.get(n)?.shift() ?? 200;
      if (code === 200) fake.merged.set(n, { merged: true, sha: `sha_${n}` });
      return code === 200 ? json({}) : new Response('nope', { status: code });
    }
    if (req.method === 'POST' && n !== null && m[2] === 'update') {
      const code = fake.update_q.get(n)?.shift() ?? 200;
      return code === 200 ? json({}) : new Response('conflict', { status: code });
    }
    if (req.method === 'GET' && n !== null && !m[2]) {
      const s = fake.merged.get(n) ?? { merged: false, sha: null };
      return json({ merged: s.merged, merged_commit_sha: s.sha });
    }
    return new Response('bad request', { status: 400 });
  },
});

const GIT_CFG: GitConfig = {
  gitea_base_url: `http://localhost:${server.port}`,
  gitea_owner: 'jasper',
  gitea_repo: 'fixrepo',
  gitea_token: 'testtok',
  base_branch: 'main',
  github_url: '',
  github_token: '',
  github_required: false,
  merge_method: 'merge',
};

// ── Store + stubs ────────────────────────────────────────────────────────────
const db = open_db(join(root, 'reland.db'));
const store = new ChangeRecordsStore(db);
const pushed: Array<{ to: string; body: string }> = [];
const inbox = {
  push: (msg: { to_specialist_id: string; body_md: string }) => {
    pushed.push({ to: msg.to_specialist_id, body: msg.body_md });
    return `msg_${pushed.length}`;
  },
} as unknown as SpecialistInbox;
const emitted: Array<{ type: string }> = [];
const events = { emit: (e: { type: string }) => emitted.push(e) } as unknown as AppEventBus;

/** Seed an owner-approved change row (pending_owner_merge) pointing at a fake PR. */
function seed_change(opts: {
  pr: number;
  inputs?: StoredChangeInputs | null;
  verdict?: 'approve' | 'approve_with_concerns';
}): string {
  const row = store.create({
    origin: 'propose_code_edit',
    change_kind: 'code',
    target_specialist_id: 'maggie',
    branch: `beatrice/test-${opts.pr}`,
    pr_number: opts.pr,
    pr_url: `http://fake/pr/${opts.pr}`,
    commit_sha: 'deadbeef',
    files: ['config/seed.yaml'],
    rationale_md: 'test change',
    checks_passed: true,
    checks_summary: 'tsc: skipped / guard: PASS',
    change_inputs: opts.inputs ?? null,
  });
  store.set_kate_verdict(row.id, opts.verdict ?? 'approve', 'looks right');
  return row.id;
}

async function recover(change_id: string) {
  const change = store.get(change_id)!;
  return merge_with_recovery({ db, store, change, git: GIT_CFG, inbox, events });
}

// ── A: direct merge ──────────────────────────────────────────────────────────
{
  const id = seed_change({ pr: 11 });
  const out = await recover(id);
  check('A: direct merge succeeds', out.merged === true && out.merged && out.via === 'direct');
  check('A: row marked merged with sha', store.get(id)!.status === 'merged' && store.get(id)!.merged_sha === 'sha_11');
}

// ── B: stale branch, update-branch resolves ──────────────────────────────────
{
  fake.merge_q.set(12, [405, 200]);
  fake.update_q.set(12, [200]);
  const id = seed_change({ pr: 12 });
  const out = await recover(id);
  check('B: merged via branch_update', out.merged === true && out.merged && out.via === 'branch_update');
  check('B: row marked merged', store.get(id)!.status === 'merged');
}

// ── C: conflicted PR but content already on main ─────────────────────────────
{
  fake.merge_q.set(13, [405]);
  fake.update_q.set(13, [409]);
  const id = seed_change({
    pr: 13,
    inputs: {
      files: [],
      edits: [{ path: 'config/seed.yaml', old_string: 'applied_marker: pending', new_string: 'applied_marker: present' }],
    },
  });
  const out = await recover(id);
  const main_sha = git(origin, 'rev-parse', 'main');
  check('C: merged via already_applied', out.merged === true && out.merged && out.via === 'already_applied');
  check('C: row records the real origin/main sha', store.get(id)!.merged_sha === main_sha);
}

// ── D: conflicted PR, stored edits still apply → re-land ────────────────────
{
  fake.merge_q.set(14, [405]);
  fake.update_q.set(14, [409]);
  const id = seed_change({
    pr: 14,
    verdict: 'approve_with_concerns',
    inputs: {
      files: [],
      edits: [{ path: 'config/seed.yaml', old_string: '  - beta', new_string: '  - beta\n  - gamma' }],
    },
  });
  const out = await recover(id);
  check('D: merged via reland', out.merged === true && out.merged && out.via === 'reland');
  if (out.merged) {
    const old_row = store.get(id)!;
    const new_row = store.get(out.change_id)!;
    check('D: re-land is a NEW change row', out.change_id !== id);
    check('D: old row superseded by the re-land', old_row.status === 'superseded' && old_row.superseded_by === out.change_id);
    check('D: new row merged on the fresh PR', new_row.status === 'merged' && new_row.pr_number === out.pr_number && out.pr_number! >= 70);
    check('D: Kate verdict carried forward', new_row.kate_verdict === 'approve_with_concerns' && (new_row.kate_reasons_md ?? '').includes('Carried forward'));
    check('D: re-land row persists its own inputs', (new_row.change_inputs?.edits.length ?? 0) === 1);
    check('D: re-land branch actually pushed to origin', git(origin, 'branch', '--list', new_row.branch).includes('reland'));
    check('D: re-land PR created against the fake Gitea', fake.created.some((p) => p.number === new_row.pr_number));
  }
}

// ── E: true conflict — inputs no longer apply ────────────────────────────────
{
  fake.merge_q.set(15, [405]);
  fake.update_q.set(15, [409]);
  const flags_before = pushed.length;
  const id = seed_change({
    pr: 15,
    inputs: {
      files: [],
      edits: [{ path: 'config/seed.yaml', old_string: 'nonexistent-context', new_string: 'replacement' }],
    },
  });
  const out = await recover(id);
  check('E: not merged on a true conflict', out.merged === false);
  check('E: row parked merge_failed', store.get(id)!.status === 'merge_failed');
  check('E: Beatrice flagged (waking, not silent)', out.merged === false && out.flagged && pushed.length === flags_before + 1 && pushed.at(-1)!.to === 'trainer' && pushed.at(-1)!.body.includes(id));
  check('E: inbox event emitted', emitted.some((e) => e.type === 'inbox_message_added'));
}

// ── F: legacy row with no stored inputs ──────────────────────────────────────
{
  fake.merge_q.set(16, [405]);
  fake.update_q.set(16, [409]);
  const id = seed_change({ pr: 16, inputs: null });
  const out = await recover(id);
  check('F: not merged without stored inputs', out.merged === false);
  check('F: reason names the missing inputs', out.merged === false && out.reason.includes('no stored authoring inputs'));
  check('F: row parked merge_failed', store.get(id)!.status === 'merge_failed');
}

// ── G: non-recoverable merge error (HTTP 500) parks with a flag ──────────────
{
  fake.merge_q.set(17, [500]);
  const flags_before = pushed.length;
  const id = seed_change({ pr: 17 });
  const out = await recover(id);
  check('G: 500 is not treated as recoverable', out.merged === false && out.merged === false && out.reason.startsWith('merge failed:'));
  check('G: still flags Beatrice', pushed.length === flags_before + 1);
}

// ── Unit: plan_reland verdicts + PrNotMergeableError shape ───────────────────
{
  const plan = plan_reland(
    { files: [{ path: 'config/seed.yaml', contents: SEED_YAML }], edits: [] },
    GIT_CFG,
  );
  check('unit: byte-identical full file classifies already_applied', plan.verdict === 'already_applied');
  const plan2 = plan_reland(
    { files: [{ path: 'config/seed.yaml', contents: 'totally: different\n' }], edits: [] },
    GIT_CFG,
  );
  check('unit: diverged full file classifies conflict (never clobber)', plan2.verdict === 'conflict');
  const plan3 = plan_reland(
    { files: [{ path: 'config/brand-new.yaml', contents: 'fresh: true\n' }], edits: [] },
    GIT_CFG,
  );
  check('unit: absent full file is re-creatable', plan3.verdict === 'relandable' && plan3.needed.files.length === 1);
  const err = new PrNotMergeableError(99, 405);
  check('unit: PrNotMergeableError carries pr + status', err.pr_number === 99 && err.http_status === 405 && err.name === 'PrNotMergeableError');
}

server.stop(true);
rmSync(root, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nsmoke:merge-reland — all checks passed');
