/**
 * workbench — Beatrice's edit–compile–test loop.
 *
 * The change pipeline (`open_change_pr`) is ONE-SHOT: author everything,
 * submit, and a red check bounces the whole attempt back as an error blob.
 * World-class coding is not one-shot generation — it is ITERATION against
 * deterministic feedback. The workbench gives Beatrice a persistent worktree
 * she can write/edit/read/check in across multiple tool calls within a build
 * session, with STRUCTURED compiler feedback (file, line, code frame — the
 * shape small models act on reliably; a raw tsc dump is the shape they
 * flail on).
 *
 * Safety model — identical authority to `propose_code_change`, NOT a new
 * privilege tier:
 *   - Everything happens in an isolated git worktree off origin/main under
 *     WORKTREE_ROOT. The live tree is never written. Same path allowlist,
 *     same byte caps (`validate_path` from change_pipeline).
 *   - `submit` routes the accumulated files through the UNCHANGED gated
 *     pipeline: `open_change_pr` (fresh worktree, tsc+guard gate, push, PR)
 *     + `route_change_for_review` (Kate skeptic gate → owner merge). The
 *     four non-bypassable gates are untouched; the workbench is merely
 *     where iteration happens BEFORE submission.
 *   - One session at a time, process-local. A session left open is cleaned
 *     up by the next open() (worktrees are disposable by design).
 *
 * Like change_pipeline.ts this is NOT a tool (no `create` export) and lives
 * outside `tools/` so the ToolLoader never registers it — the tool surface
 * is `tools/workbench.ts`. Module-level session state deliberately lives
 * HERE: the ToolLoader cache-busts tool entries on hot reload but caches
 * their dependencies, so the session survives a tools reload mid-build.
 *
 * HEARTH_TEST_MODE=1: no git — open() uses a temp directory (or
 * HEARTH_WORKBENCH_TEST_ROOT, letting the smoke seed a tiny fixture
 * project), check() runs tsc only when the root carries a tsconfig.json,
 * and submit() flows into open_change_pr's existing synthetic path.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ulid } from 'ulid';
import {
  BASE_BRANCH,
  REPO_ROOT,
  WORKTREE_ROOT,
  apply_edits_to_content,
  run_git,
  run_repo_guard,
  run_tsc_noEmit,
  validate_path,
  type FileEdit,
} from './change_pipeline';

const TEST_MODE = (): boolean => process.env.HEARTH_TEST_MODE === '1';

const MAX_FILE_BYTES = 256 * 1024;
const READ_LINE_CAP = 400;
const READ_CHAR_CAP = 16_000;
const DIFF_CHAR_CAP = 12_000;
const TSC_ERROR_CAP = 10;
const SMOKE_OUTPUT_CAP = 4_000;
const SMOKE_TIMEOUT_MS = 180_000;

// ── Structured compiler feedback ───────────────────────────────────────────

export interface TscErrorItem {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
  /** ±2 lines of source around the error, with a `>` marker on the line. */
  frame: string;
}

/**
 * Parse `tsc --noEmit` output into per-error items with code frames read
 * from the worktree. The localized, formatted shape is the whole point:
 * a model that ignores a 3KB raw dump fixes a "src/x.ts:12 — Cannot find
 * name 'foo'" with the offending line in front of it.
 */
export function parse_tsc_errors(raw: string, root: string): TscErrorItem[] {
  const out: TscErrorItem[] = [];
  const re = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
  for (const line of raw.split('\n')) {
    const m = line.match(re);
    if (!m) {
      // Continuation lines (indented elaboration) extend the prior message.
      const last = out[out.length - 1];
      if (last && /^\s+\S/.test(line)) last.message += ' ' + line.trim();
      continue;
    }
    if (out.length >= TSC_ERROR_CAP) break;
    const file = m[1]!;
    const line_no = Number.parseInt(m[2]!, 10);
    const col = Number.parseInt(m[3]!, 10);
    let frame = '';
    try {
      const src = readFileSync(resolve(root, file), 'utf-8').split('\n');
      const from = Math.max(0, line_no - 3);
      const to = Math.min(src.length, line_no + 2);
      frame = src
        .slice(from, to)
        .map((l, i) => {
          const n = from + i + 1;
          return `${n === line_no ? '>' : ' '} ${String(n).padStart(4)} | ${l}`;
        })
        .join('\n');
    } catch {
      // File unreadable (deleted, path quirk) — error item still useful.
    }
    out.push({ file, line: line_no, col, code: m[4]!, message: m[5]!, frame });
  }
  return out;
}

/** Render structured errors as the model-facing text block. */
export function render_tsc_errors(items: TscErrorItem[], total_hint: string): string {
  if (items.length === 0) return '';
  const blocks = items.map(
    (e, i) =>
      `[${i + 1}] ${e.file}:${e.line}:${e.col} ${e.code}: ${e.message}` +
      (e.frame ? `\n${e.frame}` : ''),
  );
  return `${total_hint}\n\n${blocks.join('\n\n')}`;
}

// ── Session state ──────────────────────────────────────────────────────────

export interface WorkbenchSession {
  id: string;
  task_summary: string;
  /** Absolute path of the working directory (git worktree, or temp dir in test mode). */
  root: string;
  /** Temp branch backing the worktree (deleted on discard/submit). Empty in test mode. */
  temp_branch: string;
  opened_at: string;
  /** Repo-relative paths written or edited this session. */
  touched: Set<string>;
  /** True when `root` was provided by the caller (HEARTH_WORKBENCH_TEST_ROOT) —
   *  cleanup must never delete a directory the workbench didn't create. */
  caller_owned_root: boolean;
}

let _session: WorkbenchSession | null = null;

export function active_session(): WorkbenchSession | null {
  return _session;
}

function require_session(): WorkbenchSession {
  if (!_session) {
    throw new Error(
      'workbench: no open session. Call workbench_open first — it creates the ' +
        'isolated worktree your edits and checks run in.',
    );
  }
  return _session;
}

function cleanup_worktree(s: WorkbenchSession): void {
  if (TEST_MODE()) {
    if (!s.caller_owned_root) {
      try {
        rmSync(s.root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    return;
  }
  try {
    run_git(REPO_ROOT, ['worktree', 'remove', '--force', s.root]);
  } catch {
    try {
      rmSync(s.root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  try {
    run_git(REPO_ROOT, ['branch', '-D', s.temp_branch]);
  } catch {
    /* temp branch may not exist; fine */
  }
}

// ── Operations (the tool surface calls these) ──────────────────────────────

export function wb_open(task_summary: string): {
  workbench_id: string;
  root: string;
  reused_existing: boolean;
} {
  if (_session) {
    // One session at a time. Re-opening returns the live session so a model
    // that lost track resumes instead of clobbering its own work.
    return { workbench_id: _session.id, root: _session.root, reused_existing: true };
  }
  const id = `wb_${ulid().toLowerCase().slice(-10)}`;
  if (TEST_MODE()) {
    const test_root = process.env.HEARTH_WORKBENCH_TEST_ROOT;
    const root = test_root ?? resolve('/tmp/hearth-workbench-test', id);
    mkdirSync(root, { recursive: true });
    _session = {
      id,
      task_summary,
      root,
      temp_branch: '',
      opened_at: new Date().toISOString(),
      touched: new Set(),
      caller_owned_root: test_root !== undefined,
    };
    return { workbench_id: id, root, reused_existing: false };
  }
  const temp_branch = `wb/${id}`;
  run_git(REPO_ROOT, ['fetch', 'origin', BASE_BRANCH]);
  mkdirSync(WORKTREE_ROOT, { recursive: true });
  const root = resolve(WORKTREE_ROOT, `wb_${id}`);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  run_git(REPO_ROOT, ['worktree', 'add', '-b', temp_branch, root, `origin/${BASE_BRANCH}`]);
  _session = {
    id,
    task_summary,
    root,
    temp_branch,
    opened_at: new Date().toISOString(),
    touched: new Set(),
    caller_owned_root: false,
  };
  return { workbench_id: id, root, reused_existing: false };
}

export function wb_write(path: string, contents: string): { path: string; bytes: number } {
  const s = require_session();
  validate_path(path);
  const bytes = Buffer.byteLength(contents, 'utf-8');
  if (bytes > MAX_FILE_BYTES) {
    throw new Error(`workbench: "${path}" is ${bytes} bytes — over the ${MAX_FILE_BYTES}-byte cap.`);
  }
  const abs = resolve(s.root, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents, 'utf-8');
  s.touched.add(path);
  return { path, bytes };
}

export function wb_edit(edits: FileEdit[]): { files_edited: string[] } {
  const s = require_session();
  const by_path = new Map<string, FileEdit[]>();
  for (const e of edits) {
    validate_path(e.path);
    const arr = by_path.get(e.path) ?? [];
    arr.push(e);
    by_path.set(e.path, arr);
  }
  for (const [path, fedits] of by_path) {
    const abs = resolve(s.root, path);
    if (!existsSync(abs)) {
      throw new Error(
        `workbench: edit target "${path}" does not exist in the worktree — ` +
          `use workbench_write_file to CREATE a file.`,
      );
    }
    // Applied against the CURRENT worktree state — this is what makes the
    // loop iterative (each round edits the result of the prior round, not
    // the origin/main baseline the one-shot pipeline is stuck with).
    const next = apply_edits_to_content(readFileSync(abs, 'utf-8'), fedits);
    const bytes = Buffer.byteLength(next, 'utf-8');
    if (bytes > MAX_FILE_BYTES) {
      throw new Error(`workbench: edited "${path}" is ${bytes} bytes — over the ${MAX_FILE_BYTES}-byte cap.`);
    }
    writeFileSync(abs, next, 'utf-8');
    s.touched.add(path);
  }
  return { files_edited: [...by_path.keys()] };
}

export function wb_read(
  path: string,
  start_line?: number,
  end_line?: number,
): { path: string; content: string; total_lines: number; truncated: boolean } {
  const s = require_session();
  validate_path(path);
  const abs = resolve(s.root, path);
  if (!existsSync(abs)) {
    throw new Error(`workbench: "${path}" not found in the worktree.`);
  }
  const lines = readFileSync(abs, 'utf-8').split('\n');
  const from = Math.max(1, start_line ?? 1);
  const to = Math.min(lines.length, end_line ?? from + READ_LINE_CAP - 1);
  let body = lines
    .slice(from - 1, to)
    .map((l, i) => `${String(from + i).padStart(4)} | ${l}`)
    .join('\n');
  let truncated = to < lines.length || from > 1;
  if (body.length > READ_CHAR_CAP) {
    body = body.slice(0, READ_CHAR_CAP) + '\n…[char cap — request a narrower range]';
    truncated = true;
  }
  return { path, content: body, total_lines: lines.length, truncated };
}

export interface WbCheckResult {
  ok: boolean;
  tsc_ok: boolean | null;
  tsc_errors: TscErrorItem[];
  tsc_rendered: string;
  guard_ok: boolean | null;
  guard_output: string;
  smoke_name: string | null;
  smoke_ok: boolean | null;
  smoke_tail: string;
}

/**
 * The developer-loop feedback step: tsc (structured) + repo guard +
 * optionally one named self-contained smoke, all inside the worktree.
 * This is FEEDBACK, not the gate — `wb_submit` re-runs the full
 * non-bypassable `run_checks` inside `open_change_pr` regardless.
 */
export function wb_check(run_smoke?: string): WbCheckResult {
  const s = require_session();
  const result: WbCheckResult = {
    ok: true,
    tsc_ok: null,
    tsc_errors: [],
    tsc_rendered: '',
    guard_ok: null,
    guard_output: '',
    smoke_name: run_smoke ?? null,
    smoke_ok: null,
    smoke_tail: '',
  };

  const has_tsconfig = existsSync(resolve(s.root, 'tsconfig.json'));
  if (has_tsconfig) {
    const tsc = run_tsc_noEmit(s.root);
    result.tsc_ok = tsc.ok;
    if (!tsc.ok) {
      result.ok = false;
      result.tsc_errors = parse_tsc_errors(tsc.output, s.root);
      const shown = result.tsc_errors.length;
      const total = (tsc.output.match(/: error TS\d+:/g) ?? []).length;
      result.tsc_rendered = render_tsc_errors(
        result.tsc_errors,
        `tsc --noEmit: ${total} error(s)${total > shown ? ` (showing first ${shown})` : ''}. Fix these, then run workbench_check again:`,
      );
    }
  }

  // Guard needs the repo's package.json scripts; skip in fixture roots.
  if (!TEST_MODE() && existsSync(resolve(s.root, 'package.json'))) {
    const guard = run_repo_guard(s.root);
    result.guard_ok = guard.ok;
    if (!guard.ok) {
      result.ok = false;
      result.guard_output = guard.output;
    }
  }

  if (run_smoke) {
    if (!/^smoke:[a-z0-9:-]+$/.test(run_smoke)) {
      throw new Error(
        `workbench: invalid smoke name "${run_smoke}" — pass a package.json script like "smoke:tool-contracts".`,
      );
    }
    const nm = resolve(s.root, 'node_modules');
    let linked = false;
    try {
      if (!existsSync(nm) && existsSync(resolve(REPO_ROOT, 'node_modules'))) {
        symlinkSync(resolve(REPO_ROOT, 'node_modules'), nm, 'dir');
        linked = true;
      }
      const r = spawnSync('bun', ['run', run_smoke], {
        cwd: s.root,
        encoding: 'utf-8',
        timeout: SMOKE_TIMEOUT_MS,
        env: { ...process.env, HEARTH_TEST_MODE: '1' },
      });
      const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
      result.smoke_ok = r.status === 0;
      result.smoke_tail = out.length > SMOKE_OUTPUT_CAP ? '…' + out.slice(-SMOKE_OUTPUT_CAP) : out;
      if (r.status !== 0) result.ok = false;
    } finally {
      if (linked) {
        try {
          rmSync(nm);
        } catch {
          /* best-effort */
        }
      }
    }
  }

  return result;
}

export function wb_diff(): { files: string[]; stat: string; patch: string; truncated: boolean } {
  const s = require_session();
  const files = [...s.touched];
  if (TEST_MODE()) {
    return { files, stat: files.map((f) => `M ${f}`).join('\n'), patch: '', truncated: false };
  }
  const stat = run_git(s.root, ['diff', '--stat']).stdout;
  let patch = run_git(s.root, ['diff']).stdout;
  const truncated = patch.length > DIFF_CHAR_CAP;
  if (truncated) patch = patch.slice(0, DIFF_CHAR_CAP) + '\n…[diff truncated — use workbench_read_file for detail]';
  return { files, stat, patch, truncated };
}

/**
 * Collect the session's touched files (current worktree contents) for
 * submission through the unchanged gated pipeline, then dispose the
 * session. The caller (tools/workbench.ts submit tool) feeds these to
 * `open_change_pr` + `route_change_for_review` exactly as
 * propose_code_change does — same gates, same record, same review.
 */
export function wb_collect_for_submit(): {
  files: Array<{ path: string; contents: string }>;
  task_summary: string;
} {
  const s = require_session();
  if (s.touched.size === 0) {
    throw new Error('workbench: nothing to submit — no files were written or edited this session.');
  }
  const files = [...s.touched].map((path) => ({
    path,
    contents: readFileSync(resolve(s.root, path), 'utf-8'),
  }));
  return { files, task_summary: s.task_summary };
}

export function wb_discard(): { discarded: boolean; workbench_id: string | null } {
  if (!_session) return { discarded: false, workbench_id: null };
  const id = _session.id;
  cleanup_worktree(_session);
  _session = null;
  return { discarded: true, workbench_id: id };
}

/** Test seam — reset module state between smoke cases. */
export function _test_reset(): void {
  if (_session) cleanup_worktree(_session);
  _session = null;
}
