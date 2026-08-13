/**
 * smoke:workbench — Beatrice's edit–compile–test loop, self-contained.
 *
 * Exercises the workbench manager (src/specialists/trainer/workbench.ts)
 * against a tiny fixture TypeScript project in a temp dir
 * (HEARTH_WORKBENCH_TEST_ROOT), so a REAL `bunx tsc --noEmit` runs without
 * touching the repo: open/reopen semantics, write → red check with
 * STRUCTURED errors (file/line/code frame), surgical edit → green check,
 * ranged reads, diff, collect-for-submit, path-safety, and the submit
 * tool's TEST_MODE flow through open_change_pr + route_change_for_review
 * (temp db). Also asserts every workbench tool is `volatile` so the
 * runtime's per-turn duplicate-call cache never serves a stale check
 * verdict mid-loop.
 */
process.env.HEARTH_TEST_MODE = '1';

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

const fixture_root = mkdtempSync(join(tmpdir(), 'hearth-workbench-smoke-'));
process.env.HEARTH_WORKBENCH_TEST_ROOT = fixture_root;

// Import AFTER env is set — TEST_MODE and the fixture root are read at call time,
// but keeping the order explicit mirrors the other smokes.
import {
  _test_reset,
  parse_tsc_errors,
  wb_check,
  wb_collect_for_submit,
  wb_diff,
  wb_edit,
  wb_open,
  wb_read,
  wb_write,
} from '../src/specialists/trainer/workbench';
import { create as create_workbench_tools } from '../src/specialists/trainer/tools/workbench';
import { open_db } from '../src/memory/stores/structured';
import type { ToolDeps } from '../src/core/tool_deps';
import type { ToolContext } from '../src/core/tool';
import { SpecialistInbox } from '../src/memory/stores/conversations';

let checks = 0;
function check(name: string, ok: boolean): void {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  // ── fixture project ─────────────────────────────────────────────────────
  writeFileSync(
    join(fixture_root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler' },
      include: ['src/**/*.ts'],
    }),
  );
  mkdirSync(join(fixture_root, 'src'), { recursive: true });

  // ── parse_tsc_errors (pure) ─────────────────────────────────────────────
  writeFileSync(join(fixture_root, 'src', 'frame.ts'), 'const a = 1;\nconst b: string = a;\nexport { b };\n');
  const parsed = parse_tsc_errors(
    `src/frame.ts(2,7): error TS2322: Type 'number' is not assignable to type 'string'.\n` +
      `  Some elaboration line.\n`,
    fixture_root,
  );
  check('parse_tsc_errors extracts file/line/code', parsed.length === 1 && parsed[0]!.file === 'src/frame.ts' && parsed[0]!.line === 2 && parsed[0]!.code === 'TS2322');
  check('continuation lines fold into the message', /elaboration/.test(parsed[0]!.message));
  check('code frame marks the offending line', /^>\s+2 \|/m.test(parsed[0]!.frame));
  rmSync(join(fixture_root, 'src', 'frame.ts'));

  // ── open / reopen ───────────────────────────────────────────────────────
  const opened = wb_open('add a typed greeting module');
  check('open returns a wb_ id', opened.workbench_id.startsWith('wb_') && !opened.reused_existing);
  const reopened = wb_open('something else');
  check('reopen returns the SAME live session', reopened.workbench_id === opened.workbench_id && reopened.reused_existing);

  // ── write (broken) → structured red check ───────────────────────────────
  wb_write('src/greet.ts', `export function greet(name: string): string {\n  return 'hello ' + nam;\n}\n`);
  const red = wb_check();
  check('broken file → check not ok', !red.ok && red.tsc_ok === false);
  check('red check carries structured errors', red.tsc_errors.length >= 1 && red.tsc_errors[0]!.file === 'src/greet.ts');
  check('rendered errors include a code frame', /> +2 \|/.test(red.tsc_rendered));

  // ── surgical edit → green check ─────────────────────────────────────────
  wb_edit([{ path: 'src/greet.ts', old_string: `'hello ' + nam;`, new_string: `'hello ' + name;` }]);
  const green = wb_check();
  check('after the fix → check ok (the loop works)', green.ok && green.tsc_ok === true);

  // ── edits apply against CURRENT state, not baseline ─────────────────────
  wb_edit([{ path: 'src/greet.ts', old_string: `'hello ' + name;`, new_string: `'hi ' + name;` }]);
  const reread = wb_read('src/greet.ts');
  check('second edit saw the first edit’s result', /'hi ' \+ name/.test(reread.content));
  check('read is line-numbered with total_lines', reread.total_lines >= 3 && /1 \|/.test(reread.content));

  // ── ranged read ─────────────────────────────────────────────────────────
  const ranged = wb_read('src/greet.ts', 2, 2);
  check('ranged read returns only the slice (truncated=true)', /2 \|/.test(ranged.content) && !/1 \|/.test(ranged.content) && ranged.truncated);

  // ── path safety ─────────────────────────────────────────────────────────
  let threw = false;
  try {
    wb_write('../evil.ts', 'x');
  } catch {
    threw = true;
  }
  check('path traversal refused', threw);
  threw = false;
  try {
    wb_write('data/hearth.db', 'x');
  } catch {
    threw = true;
  }
  check('denylisted path refused', threw);

  // ── diff + collect ──────────────────────────────────────────────────────
  const diff = wb_diff();
  check('diff lists the touched file', diff.files.includes('src/greet.ts'));
  const collected = wb_collect_for_submit();
  check('collect returns current worktree contents', collected.files.some((f) => f.path === 'src/greet.ts' && /'hi ' \+ name/.test(f.contents)));

  // ── tools surface: all 8, all volatile, capability-gated ────────────────
  const db = open_db(join(fixture_root, 'smoke.db'));
  const inbox = new SpecialistInbox(db);
  const tools = create_workbench_tools({ db, inbox, events: { emit: () => {} } } as unknown as ToolDeps);
  check('eight workbench tools registered', tools.length === 8);
  check('every workbench tool is volatile (no stale cache verdicts)', tools.every((t) => t.volatile === true));
  check(
    'every workbench tool gates on write_codebase_pr',
    tools.every((t) => (t.required_capabilities ?? []).includes('write_codebase_pr')),
  );

  // ── submit (TEST_MODE synthetic git, real review routing + db) ──────────
  const submit = tools.find((t) => t.name === 'workbench_submit')!;
  const ctx = { intent_id: 'smoke', specialist_id: 'trainer', memory: { log_action: () => 'a' } } as unknown as ToolContext;
  const sub = (await submit.execute(
    {
      branch_name: 'beatrice/smoke-greet',
      pr_title: 'feat(smoke): typed greeting module',
      pr_body: 'Adds the greeting module exercised by smoke:workbench end to end.',
    },
    ctx,
  )) as { change_id: string; files_changed: string[] };
  check('submit returns a change record id', sub.change_id.length > 0);
  check('submit carries the session files', sub.files_changed.includes('src/greet.ts'));
  const row = db.prepare(`SELECT status FROM beatrice_changes WHERE id = ?`).get(sub.change_id) as
    | { status: string }
    | undefined;
  check('change row lands pending Kate review', row?.status === 'pending_kate_review');

  // Session was consumed by the successful submit.
  threw = false;
  try {
    wb_diff();
  } catch {
    threw = true;
  }
  check('session closed after successful submit', threw);

  // ── build-context tooling: repo_map / outline reads / scaffolder ────────
  // These run against the REAL repo (read-only) — cwd is the repo root when
  // invoked via `bun run`.
  const { create: create_repo_map } = await import('../src/specialists/trainer/tools/repo_map');
  const repo_map = create_repo_map({} as ToolDeps) as { execute: (i: unknown, c: ToolContext) => Promise<unknown> };
  const map = (await repo_map.execute({ dir: 'src/specialists/trainer' }, ctx)) as {
    file_count: number;
    map: string;
  };
  check('repo_map indexes the trainer dir', map.file_count > 5);
  check('repo_map lists exported symbols', /fn build_repo_map/.test(map.map) && /workbench\.ts/.test(map.map));

  const { create: create_read } = await import('../src/specialists/trainer/tools/read_codebase_file');
  const read_tool = create_read({} as ToolDeps) as { execute: (i: unknown, c: ToolContext) => Promise<unknown> };
  const outline = (await read_tool.execute({ path: 'src/core/time.ts', mode: 'outline' }, ctx)) as {
    contents: string;
    total_lines: number;
  };
  check('outline mode lists exports with line numbers', /local_iso_week/.test(outline.contents) && /\d+ \|/.test(outline.contents));
  const ranged_read = (await read_tool.execute({ path: 'src/core/time.ts', start_line: 1, end_line: 5 }, ctx)) as {
    contents: string;
    truncated: boolean;
  };
  check('ranged read returns the numbered slice', /1 \|/.test(ranged_read.contents) && ranged_read.truncated);
  const missing = (await read_tool.execute({ path: 'src/core/tiem.ts' }, ctx)) as {
    exists: boolean;
    candidates?: string[];
  };
  check('missing path returns nearest-path candidates', missing.exists === false && (missing.candidates ?? []).includes('src/core/time.ts'));
  const dir_read = (await read_tool.execute({ path: 'src/connectors' }, ctx)) as { candidates?: string[] };
  // Assert on ANY child of the directory, not a specific file: the candidate
  // list is capped (slice(0, 40)) and connectors/ has outgrown that, so keying
  // on a late-alphabetical file (weather.ts, now entry 50) fell off the end.
  check('directory path returns children as candidates', (dir_read.candidates ?? []).some((c) => c.startsWith('src/connectors/')));

  const { create: create_scaffold } = await import('../src/specialists/trainer/tools/scaffold_code');
  const scaffold = create_scaffold({} as ToolDeps) as { execute: (i: unknown, c: ToolContext) => Promise<unknown> };
  const sk = (await scaffold.execute({ kind: 'specialist_tool', name: 'track_thing', specialist_id: 'ruby' }, ctx)) as {
    path_suggestion: string;
    skeleton: string;
    registration_steps: string[];
    exemplar: string;
  };
  check('scaffold emits the Tool contract skeleton', /export function create\(deps: ToolDeps\): Tool/.test(sk.skeleton) && /required_capabilities/.test(sk.skeleton));
  check('scaffold carries the recovery-hint field', /candidates: z\.array/.test(sk.skeleton));
  check('scaffold path + checklist target the owning specialist', sk.path_suggestion === 'src/specialists/ruby/tools/track_thing.ts' && sk.registration_steps.some((s) => /capability-visibility/.test(s)));
  check('scaffold names a live exemplar', sk.exemplar.startsWith('src/'));

  _test_reset();
  rmSync(fixture_root, { recursive: true, force: true });

  if (process.exitCode === 1) {
    console.log(`\nsmoke:workbench FAILED`);
    process.exit(1);
  }
  console.log(`\n✓ smoke:workbench — ${checks} checks passed`);
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  process.exit(1);
});
