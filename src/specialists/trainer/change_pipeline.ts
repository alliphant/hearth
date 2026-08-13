/**
 * change_pipeline — the shared worktree→branch→PR primitive behind every
 * change Beatrice (the `trainer` meta-agent) makes to the system.
 *
 * This is the SPINE of the safe self-modification pipeline: code changes
 * (`propose_code_change`) AND config tunings (`apply_low_risk_fix`) both flow
 * through `open_change_pr`, so NOTHING Beatrice does writes the live working
 * tree. Every change becomes one commit on an isolated `beatrice/*` branch off
 * `origin/main` + a PR — trivially revertible (delete the branch / revert the
 * merge commit) and incapable of breaking the next `git pull --ff-only` deploy.
 *
 * It is deliberately NOT a tool (no `create` export) and lives OUTSIDE a
 * `tools/` directory so the ToolLoader's `/tools/` scan never tries to register
 * it — same reasoning as `codebase_fs.ts`.
 *
 * `git` IS available in the orchestrator container (the repo is bind-mounted and
 * `propose_code_change` already shells out to it). The old `apply_low_risk_fix`
 * comment claiming otherwise was stale.
 *
 * HEARTH_TEST_MODE=1 short-circuits all git + Gitea I/O and returns synthetic
 * results, so the whole pipeline + state machine is exercisable offline.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve, dirname, isAbsolute, normalize } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Database } from 'bun:sqlite';
import { CodeShopSettings } from '@memory/stores/codeshop_settings';
import { GUARD_CHANGE_CHECKS_FAILED, bump_guard_counter } from '@memory/stores/guard_counters';

// Repo root the app runs from (`/app` in the container). Matches tool_loader.ts.
export const REPO_ROOT = process.env.HEARTH_REPO_ROOT ?? process.cwd();
export const WORKTREE_ROOT = process.env.HEARTH_WORKTREE_ROOT ?? '/tmp/hearth-worktrees';
const GITEA_BASE = process.env.HEARTH_GITEA_BASE_URL ?? 'http://localhost:3010';
const GITEA_OWNER = process.env.HEARTH_GITEA_OWNER ?? 'jasper';
const GITEA_REPO = process.env.HEARTH_GITEA_REPO ?? 'hearth-private';
export const BASE_BRANCH = process.env.HEARTH_BASE_BRANCH ?? 'main';

const TEST_MODE = (): boolean => process.env.HEARTH_TEST_MODE === '1';

/**
 * Resolved git/Gitea/GitHub config for a change operation. Sourced
 * CodeShopSettings (the owner's gear) → env → hardcoded default, so the owner
 * can make merge work at runtime without a redeploy. The gitea_token is UNSET in
 * env today, so without the gear-provided token, create/merge throw (by design —
 * surfaces "configure the Gitea token in the Code Shop gear").
 */
export interface GitConfig {
  gitea_base_url: string;
  gitea_owner: string;
  gitea_repo: string;
  gitea_token: string;
  base_branch: string;
  github_url: string;
  github_token: string;
  github_required: boolean;
  merge_method: 'merge' | 'squash' | 'rebase';
}

function git_defaults(): GitConfig {
  return {
    gitea_base_url: GITEA_BASE,
    gitea_owner: GITEA_OWNER,
    gitea_repo: GITEA_REPO,
    gitea_token: process.env.HEARTH_GITEA_TOKEN ?? '',
    base_branch: BASE_BRANCH,
    github_url: '',
    github_token: process.env.HEARTH_GITHUB_TOKEN ?? '',
    github_required: false,
    merge_method: 'merge',
  };
}

/** Resolve git config from the owner's gear settings, falling back to env/defaults. */
export function resolve_git_config(db: Database): GitConfig {
  const d = git_defaults();
  try {
    const c = new CodeShopSettings(db).get();
    return {
      gitea_base_url: c.gitea_base_url || d.gitea_base_url,
      gitea_owner: c.gitea_owner || d.gitea_owner,
      gitea_repo: c.gitea_repo || d.gitea_repo,
      gitea_token: c.gitea_token || d.gitea_token,
      base_branch: c.base_branch || d.base_branch,
      github_url: c.github_url || d.github_url,
      github_token: c.github_token || d.github_token,
      github_required: c.github_required,
      merge_method: c.merge_method,
    };
  } catch {
    return d;
  }
}

export const PATH_ALLOWLIST = ['src/', 'config/', 'scripts/', 'apps/'];
const PATH_DENYLIST = ['.git/', '.env', 'node_modules/', 'data/', 'bun.lock', 'package-lock.json'];
const SECRET_FILE_PATTERNS = [/\.key$/, /\.pem$/, /\.secret$/, /secrets?\./];

const DEFAULT_MAX_BYTES_PER_FILE = 256 * 1024;
/** Cap on the embedded unified diff stored on the change record (Kate reads this). */
export const DIFF_SUMMARY_CAP = 32 * 1024;

export interface FileChange {
  path: string;
  contents: string;
}

/**
 * A surgical search/replace edit to an EXISTING file — the best-practice
 * authoring primitive (what Claude Code's Edit, Aider, Cursor all use). The
 * model emits a small block proportional to the CHANGE, not the whole file, so
 * a one-line fix to a 480-line file is a one-line output — no whole-file-rewrite
 * wall. Applied deterministically with exact-match validation (see
 * `apply_edits_to_content`); git computes the real diff; the change flows
 * through the same review/PR gates as a full-file `propose_code_change`.
 */
export interface FileEdit {
  path: string;
  /** Exact substring to find. Must match the file byte-for-byte. */
  old_string: string;
  /** Replacement. Must differ from old_string. */
  new_string: string;
  /**
   * Replace EVERY occurrence (default false = require a single unique match).
   * Use only when you intend a global rename and have confirmed every hit is
   * the same change; otherwise add surrounding context to make old_string unique.
   */
  replace_all?: boolean;
}

/**
 * Apply an ordered list of search/replace edits to a file's content, in
 * sequence (each edit sees the result of the prior one). PURE + deterministic —
 * the core of `propose_code_edit`, testable without git.
 *
 * Validation (this is what makes it rigorous, not a fuzzy line-munger):
 *   - new_string must differ from old_string.
 *   - default: old_string must occur EXACTLY ONCE. Zero → "not found"; more
 *     than one → "ambiguous, add surrounding context". Never a silent
 *     mis-application to the wrong place.
 *   - replace_all: replaces every occurrence; still errors if zero.
 * Throws a clear, model-actionable Error on any failure so the caller retries.
 */
export function apply_edits_to_content(
  content: string,
  edits: ReadonlyArray<Omit<FileEdit, 'path'>>,
): string {
  const preview = (s: string): string =>
    JSON.stringify(s.length > 80 ? s.slice(0, 77) + '…' : s);
  let out = content;
  for (const e of edits) {
    if (e.old_string === e.new_string) {
      throw new Error(`code_edit: old_string and new_string are identical (${preview(e.old_string)}) — no-op edit.`);
    }
    if (e.replace_all) {
      if (!out.includes(e.old_string)) {
        throw new Error(`code_edit: old_string not found (${preview(e.old_string)}).`);
      }
      out = out.split(e.old_string).join(e.new_string);
      continue;
    }
    const first = out.indexOf(e.old_string);
    if (first === -1) {
      throw new Error(`code_edit: old_string not found (${preview(e.old_string)}). It must match the file byte-for-byte; widen the context.`);
    }
    const second = out.indexOf(e.old_string, first + e.old_string.length);
    if (second !== -1) {
      throw new Error(`code_edit: old_string is AMBIGUOUS (matches >1 place) (${preview(e.old_string)}). Add more surrounding lines to make it unique, or set replace_all if every occurrence should change.`);
    }
    out = out.slice(0, first) + e.new_string + out.slice(first + e.old_string.length);
  }
  return out;
}

export interface ChangeDiff {
  diff_summary: string;
  diff_truncated: boolean;
  lines_added: number;
  lines_removed: number;
  languages: string[];
}

/**
 * The verbatim inputs a change was authored from — persisted on the change
 * record (`change_inputs_json`) so merge recovery can re-land an approved
 * change whose PR went stale against a moved main. See `plan_reland`.
 */
export interface ChangeInputs {
  files: FileChange[];
  edits: FileEdit[];
}

export interface OpenChangeResult extends ChangeDiff {
  branch: string;
  commit_sha: string;
  pr_url: string;
  pr_number: number;
  files_changed: string[];
  /** Deterministic-gate verdict (tsc + guard), run inside the worktree before
   *  the push. Always true on a returned result — a RED change throws
   *  `ChecksFailedError` and never returns / opens a PR. */
  checks_passed: boolean;
  /** Per-check pass/fail summary (+ truncated failing output). Stored on the
   *  change record so the Code Shop card can surface the verdict. */
  checks_summary: string;
  /** Verbatim authoring inputs, for the change record (merge re-land). */
  change_inputs: ChangeInputs;
}

/** Reject absolute/traversal/denylisted/secret paths and anything outside the allowlist. */
export function validate_path(rel_path: string): void {
  if (isAbsolute(rel_path)) {
    throw new Error(`change_pipeline: file path must be relative (got "${rel_path}")`);
  }
  const normalized = normalize(rel_path);
  if (normalized.startsWith('..') || normalized.includes('/../')) {
    throw new Error(`change_pipeline: path traversal forbidden (got "${rel_path}")`);
  }
  for (const deny of PATH_DENYLIST) {
    if (normalized === deny || normalized.startsWith(deny)) {
      throw new Error(`change_pipeline: path "${rel_path}" is on the denylist (${deny})`);
    }
  }
  for (const re of SECRET_FILE_PATTERNS) {
    if (re.test(normalized)) {
      throw new Error(`change_pipeline: path "${rel_path}" looks like a secret/key file — refusing`);
    }
  }
  if (!PATH_ALLOWLIST.some((p) => normalized.startsWith(p))) {
    throw new Error(
      `change_pipeline: path "${rel_path}" must start with one of: ${PATH_ALLOWLIST.join(', ')}`,
    );
  }
}

/**
 * Branch-name safety gate — enforced HERE (the layer that owns the problem)
 * rather than on each caller's tool input_schema. `branch_name` flows straight
 * into `git worktree add -b <branch>` argv AND into a worktree path
 * (`resolve(WORKTREE_ROOT, branch.replace(/\//g, '_'))`), so a value like `..`
 * or one with shell/path metacharacters would be a traversal/own-goal. The
 * shape is also too tight for a regex `pattern` on the input_schema — that
 * would compile to a GBNF grammar on the interactive 9B and llama.cpp's
 * converter silently disables the whole tool grammar — so the regex lives off
 * the schema and every `open_change_pr` caller is validated through this.
 */
const BRANCH_NAME_RE = /^[a-z][a-z0-9_/-]+$/i;
export function validate_branch_name(branch_name: string): void {
  if (
    branch_name.length < 3 ||
    branch_name.length > 80 ||
    !BRANCH_NAME_RE.test(branch_name)
  ) {
    throw new Error(
      `change_pipeline: branch_name "${branch_name}" must be 3-80 characters of ` +
        `letters/numbers/hyphens/underscores/slashes, starting with a letter ` +
        `(e.g. "beatrice/fix-thing").`,
    );
  }
}

/**
 * Dedup key for a code change — the supersession discriminator on
 * `beatrice_changes`. Two open changes sharing this key are REVISIONS of one
 * logical change; the newer retires the older (`superseded`).
 *
 * Keyed on the BRANCH BASE (the `-vN` retry suffix stripped, so the
 * branch-collision "add a -v2 suffix" re-file still supersedes its twin), with
 * the related proposal id as a prefix when present. The proposal id ALONE was
 * the 2026-08-11 bug: sibling changes implementing one proposal — the read_miss
 * tool (PR #268) and its capability grants (PR #269) — shared bare
 * `code:<proposal_id>`, so filing the grants wrongly superseded the tool and
 * its open PR vanished from the review queue. Supersession requires
 * same-branch intent, not merely same parent proposal.
 */
export function change_dedup_key(branch_name: string, related_proposal_id?: string): string {
  const branch_base = branch_name.replace(/-v\d+$/, '');
  return related_proposal_id
    ? `code:${related_proposal_id}:${branch_base}`
    : `code:${branch_base}`;
}

/** Scrub any credential that could ride along in git output/argv before it is
 *  thrown, logged, or surfaced to an LLM. Defense-in-depth on top of keeping
 *  tokens out of argv entirely (we pass them via env, not the URL). */
function redact_secrets(s: string): string {
  return s
    .replace(/x-access-token:[^@\s]+@/gi, 'x-access-token:***@')
    .replace(/(Authorization:\s*Basic\s+)\S+/gi, '$1***')
    .replace(/:\/\/[^/@\s]+:[^@\s]+@/g, '://***:***@');
}

/**
 * Git HTTP auth-header env for the Gitea `origin` remote. The orchestrator
 * container has NO ambient git credentials (the host's `~/.git-credentials`
 * isn't mounted) and `hearth-private` is a PRIVATE repo, so an unauthenticated
 * fetch/push to `origin` fails — which is why no Beatrice change had ever opened
 * a live PR. Inject the gear's Gitea token as HTTP Basic (`owner:token`) via
 * GIT_CONFIG `http.extraHeader` — the same mechanism the GitHub mirror push
 * already uses, and never in argv or the remote URL so it can't land in the
 * process table, git's echoed remote string, or logs. Returns `undefined` when
 * no token is configured, so the call falls back to the ambient credential
 * (preserves prior behavior; TEST_MODE never reaches these git calls anyway).
 */
export function gitea_auth_env(git: GitConfig): Record<string, string> | undefined {
  if (!git.gitea_token) return undefined;
  const basic = Buffer.from(`${git.gitea_owner}:${git.gitea_token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

export function run_git(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): { stdout: string; stderr: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  if (result.error) {
    throw new Error(redact_secrets(`git ${args.join(' ')}: ${result.error.message}`));
  }
  if (result.status !== 0) {
    throw new Error(
      redact_secrets(
        `git ${args.slice(0, 2).join(' ')}: exit ${result.status}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
      ),
    );
  }
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
  swift: 'Swift', py: 'Python', yaml: 'YAML', yml: 'YAML', json: 'JSON',
  md: 'Markdown', sh: 'Shell', css: 'CSS', html: 'HTML', sql: 'SQL',
};

function language_of(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return LANG_BY_EXT[ext] ?? (ext ? ext.toUpperCase() : 'other');
}

function languages_for(paths: string[]): string[] {
  return Array.from(new Set(paths.map(language_of)));
}

/** Compute the committed diff vs origin/<base> inside a worktree, capped. */
export function compute_diff_summary(
  worktree_path: string,
  files_changed: string[],
  base_branch: string = BASE_BRANCH,
): ChangeDiff {
  const languages = languages_for(files_changed);
  let lines_added = 0;
  let lines_removed = 0;
  try {
    const numstat = run_git(worktree_path, ['diff', '--numstat', `origin/${base_branch}`, 'HEAD']).stdout;
    for (const line of numstat.split('\n').filter(Boolean)) {
      const [add, del] = line.split('\t');
      lines_added += Number.parseInt(add ?? '0', 10) || 0;
      lines_removed += Number.parseInt(del ?? '0', 10) || 0;
    }
  } catch {
    /* numstat best-effort */
  }
  let raw = '';
  try {
    raw = run_git(worktree_path, ['diff', `origin/${base_branch}`, 'HEAD']).stdout;
  } catch {
    /* diff best-effort */
  }
  const diff_truncated = raw.length > DIFF_SUMMARY_CAP;
  const diff_summary = diff_truncated
    ? raw.slice(0, DIFF_SUMMARY_CAP) + '\n…[diff truncated — review the full PR]'
    : raw;
  return { diff_summary, diff_truncated, lines_added, lines_removed, languages };
}

// ── The deterministic check gate ─────────────────────────────────────────────
// A change that doesn't COMPILE (or trips a source-hygiene guard) must never
// become a PR. Until now a human running `tsc` was the only thing catching it —
// Kate is an LLM reading the diff and can approve uncompilable code. These run
// inside the worktree BEFORE the push, so a red change is rejected entirely.
//
// NOTE: bun RUNS TypeScript by stripping types, so a tsc error does NOT crash
// the orchestrator at boot — tsc here is a correctness/standard gate, not
// crash-prevention. (The real crash class — a dup capability token, a CREATE
// INDEX before its ALTER — is a boot-only error tsc can't see; a TEST_MODE boot
// check / smoke subset would be the stronger gate. Tracked as Layer 1.5.)

const PER_CMD_OUTPUT_CAP = 8 * 1024;
const CHECK_SUMMARY_CAP = 12 * 1024;

function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '\n…[output truncated]' : s;
}

export interface CheckResult {
  passed: boolean;
  /** Per-check PASS/FAIL lines + truncated failing output — model-actionable. */
  summary: string;
  ran_tsc: boolean;
  ran_guard: boolean;
}

/**
 * Thrown by `open_change_pr` when `run_checks` fails. Carries the tsc/guard
 * output so the calling tool (propose_code_change / propose_code_edit /
 * apply_low_risk_fix) returns it to Beatrice, who fixes + re-files — cheaply via
 * `propose_code_edit` (output ∝ the change, not the whole file).
 */
export class ChecksFailedError extends Error {
  constructor(public readonly summary: string) {
    super(
      'change_pipeline: automated checks FAILED — the change was NOT pushed and no PR was opened. ' +
        'Fix the errors below and re-file (use propose_code_edit for a cheap surgical retry):\n\n' +
        summary,
    );
    this.name = 'ChecksFailedError';
  }
}

/** Run a command, capturing combined stdout+stderr without throwing on non-zero. */
function run_capture(
  cwd: string,
  cmd: string,
  args: string[],
  timeout_ms: number,
): { ok: boolean; output: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf-8', timeout: timeout_ms });
  if (r.error) {
    const timed_out = (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    return {
      ok: false,
      output: `${cmd} ${args.join(' ')}: ${timed_out ? `timed out after ${timeout_ms}ms` : r.error.message}`,
    };
  }
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
  return { ok: r.status === 0, output: cap(out, PER_CMD_OUTPUT_CAP) };
}

/**
 * `bunx tsc --noEmit` in `dir`. A git worktree has NO node_modules (it's
 * gitignored), so symlink the main repo's node_modules in first — Beatrice can't
 * change deps (package.json is outside the path allowlist), so the main repo's
 * tree is always the valid one. The committed tsconfig.json type-checks the
 * whole project, so a change that breaks a consumer anywhere is caught. Exported
 * for the smoke. Symlink is removed afterward so the worktree stays clean.
 */
export function run_tsc_noEmit(dir: string): { ok: boolean; output: string } {
  const nm = resolve(dir, 'node_modules');
  let linked = false;
  try {
    if (!existsSync(nm)) {
      symlinkSync(resolve(REPO_ROOT, 'node_modules'), nm, 'dir');
      linked = true;
    }
    return run_capture(dir, 'bunx', ['tsc', '--noEmit'], 240_000);
  } catch (err) {
    return { ok: false, output: `tsc setup failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (linked) {
      try {
        rmSync(nm);
      } catch {
        /* best-effort symlink cleanup */
      }
    }
  }
}

/** `bun run guard` (guard:time + guard:encoding) in `dir`. Guard reads source
 *  + `git ls-files` only (no deps), so no node_modules symlink is needed.
 *  Exported for the smoke. */
export function run_repo_guard(dir: string): { ok: boolean; output: string } {
  return run_capture(dir, 'bun', ['run', 'guard'], 60_000);
}

/**
 * Boot-crash check in a committed worktree — spawns `smoke:boot-check`
 * (cwd = worktree) so it loads the WORKTREE's schema + config and catches the
 * boot-only crash class tsc can't see: a SQLite migration that CREATE-INDEXes
 * before its ALTER, a capabilities.yaml token that collides with a built-in, a
 * specialist YAML that won't load (dup id, second default_landing, undefined
 * capability grant). Needs node_modules (yaml/zod), symlinked like tsc.
 * Plumbing failures (can't spawn / symlink) fail-OPEN — the gate only blocks on
 * a boot error it actually observed, never on infrastructure. Exported for the
 * smoke. */
export function run_boot_check_in_worktree(dir: string): { ok: boolean; output: string } {
  // The smoke script must exist in the worktree to run. A real Beatrice
  // worktree is a full checkout off origin/main (it always will, once this
  // ships); a partial/fixture worktree without it can't be boot-checked, so
  // skip (fail-open) rather than block.
  if (!existsSync(resolve(dir, 'scripts/smoke-boot-check.ts'))) {
    return { ok: true, output: 'boot-check skipped (no scripts/smoke-boot-check.ts in worktree)' };
  }
  const nm = resolve(dir, 'node_modules');
  let linked = false;
  try {
    if (!existsSync(nm)) {
      symlinkSync(resolve(REPO_ROOT, 'node_modules'), nm, 'dir');
      linked = true;
    }
    return run_capture(dir, 'bun', ['run', 'scripts/smoke-boot-check.ts'], 120_000);
  } catch (err) {
    return {
      ok: true,
      output: `boot-check setup skipped (fail-open): ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (linked) {
      try {
        rmSync(nm);
      } catch {
        /* best-effort symlink cleanup */
      }
    }
  }
}

/**
 * Run the deterministic gate inside a committed worktree. `bun run guard`
 * ALWAYS (cheap byte/grep scans, relevant to config + code alike); `bunx tsc
 * --noEmit` only when a .ts/.tsx file changed (a config-only YAML edit skips
 * tsc — it's irrelevant there). Returns a structured pass/fail + summary;
 * `open_change_pr` throws `ChecksFailedError` on failure before pushing.
 */
/** Paths whose ADDITION constitutes a new tool — the test-first gate's scope. */
const NEW_TOOL_PATH_RE = /^src\/(specialists\/[^/]+\/tools|connectors)\/[^/]+\.ts$/;
const SMOKE_FILE_RE = /^scripts\/(smoke|test)-[^/]+\.ts$/;

/**
 * Files ADDED by the worktree's single change commit (vs its origin/base
 * parent). Best-effort: any git hiccup returns [] so the gate degrades to
 * a no-op rather than blocking a legitimate change on plumbing.
 */
function added_files(worktree_path: string): string[] {
  try {
    const out = run_git(worktree_path, ['diff', '--name-status', 'HEAD~1..HEAD']).stdout;
    return out
      .split('\n')
      .filter((l) => l.startsWith('A\t'))
      .map((l) => l.slice(2).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function run_checks(worktree_path: string, files_changed: string[]): CheckResult {
  const has_ts = files_changed.some((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  const parts: string[] = [];
  let passed = true;

  const guard = run_repo_guard(worktree_path);
  parts.push(guard.ok ? 'guard (time + encoding): PASS' : `guard (time + encoding): FAIL\n${guard.output}`);
  if (!guard.ok) passed = false;

  if (has_ts) {
    const tsc = run_tsc_noEmit(worktree_path);
    parts.push(tsc.ok ? 'tsc --noEmit: PASS' : `tsc --noEmit: FAIL\n${tsc.output}`);
    if (!tsc.ok) passed = false;
  } else {
    parts.push('tsc --noEmit: skipped (no .ts/.tsx files changed)');
  }

  // Test-first gate (2026-06-10): a change that ADDS a tool/connector file
  // must also touch a smoke — "checks green" has to mean more than "it
  // compiles" before merge autonomy can rise. Repo rule made mechanical
  // (the private dev log "Update the smoke that exercises this category... don't
  // skip"). Edits to existing files are exempt; only new tool surface
  // pays the toll.
  const new_tools = added_files(worktree_path).filter((f) => NEW_TOOL_PATH_RE.test(f));
  if (new_tools.length > 0) {
    const touched_smoke = files_changed.some((f) => SMOKE_FILE_RE.test(f));
    if (touched_smoke) {
      parts.push(`test-first gate: PASS (new tool ${new_tools.join(', ')} ships with a smoke change)`);
    } else {
      passed = false;
      parts.push(
        `test-first gate: FAIL\nThis change ADDS ${new_tools.join(', ')} but touches no ` +
          `scripts/smoke-*.ts or scripts/test-*.ts. A new tool ships WITH its smoke ` +
          `coverage — extend the owning smoke (or add a case file) in the same change ` +
          `and re-submit.`,
      );
    }
  }

  // Boot-crash check (2026-06-14): the boot-only crash class tsc + offline
  // smokes miss (CREATE-INDEX-before-ALTER, dup capability token, a specialist
  // YAML that won't load). Gated to changes that can actually break boot —
  // any config/ edit, the schema, or the capability/specialist loaders. Runs
  // in the worktree so it loads the CHANGED code + config, not the live tree.
  const boot_relevant = files_changed.some(
    (f) =>
      f.startsWith('config/') ||
      f === 'src/memory/stores/structured.ts' ||
      f === 'src/core/capabilities.ts' ||
      f === 'src/core/specialist.ts',
  );
  if (boot_relevant) {
    const boot = run_boot_check_in_worktree(worktree_path);
    parts.push(boot.ok ? 'boot-check: PASS' : `boot-check: FAIL\n${boot.output}`);
    if (!boot.ok) passed = false;
  } else {
    parts.push('boot-check: skipped (no config / schema / capability files changed)');
  }

  // Deterministic review notes for Kate — observations, never failures.
  // Her skeptic review is for design intent; these point her checklist at
  // what the diff actually touched.
  const review_notes: string[] = [];
  if (files_changed.some((f) => /^config\/specialists\/[^/]+\.yaml$/.test(f))) {
    review_notes.push(
      'specialist YAML changed — run the capability-visibility checklist: granted? ' +
        'surfaced (curated lists are allowlists)? mentioned in the persona? right surface ' +
        '(chat vs deliberation vs voice)?',
    );
  }
  if (new_tools.length > 0) {
    review_notes.push(
      `new tool file(s): ${new_tools.join(', ')} — check required_capabilities exist + are ` +
        'granted, the output schema carries a recovery field if it can error, and the ' +
        'description tells the model WHEN to reach for it.',
    );
  }
  if (review_notes.length > 0) {
    parts.push(`review notes (for Kate):\n- ${review_notes.join('\n- ')}`);
  }

  return { passed, summary: cap(parts.join('\n\n'), CHECK_SUMMARY_CAP), ran_tsc: has_ts, ran_guard: true };
}

export async function create_gitea_pr(
  input: { branch: string; title: string; body: string },
  git: GitConfig = git_defaults(),
): Promise<{ url: string; number: number }> {
  const token = git.gitea_token;
  if (!token) {
    throw new Error(
      'change_pipeline: Gitea token not configured — set it in the Code Shop gear (or HEARTH_GITEA_TOKEN) to create a PR',
    );
  }
  const url = `${git.gitea_base_url}/api/v1/repos/${git.gitea_owner}/${git.gitea_repo}/pulls`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `token ${token}` },
    body: JSON.stringify({ title: input.title, body: input.body, base: git.base_branch, head: input.branch }),
  });
  if (!resp.ok) {
    const body_text = await resp.text().catch(() => '');
    throw new Error(`Gitea PR create failed: HTTP ${resp.status}: ${body_text.slice(0, 400)}`);
  }
  const json = (await resp.json()) as { html_url?: string; number?: number };
  if (!json.html_url || typeof json.number !== 'number') {
    throw new Error(`Gitea PR create: unexpected response shape: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return { url: json.html_url, number: json.number };
}

/**
 * Mirror the BASE BRANCH to GitHub after a merge.
 *
 * The mirror push in `open_change` covers feature BRANCHES only. Nothing ever
 * pushed the merge commit, so `main` on GitHub drifted behind Gitea silently
 * and indefinitely — measured 2026-08-02 at 6 commits / 3 whole PRs, with
 * `github_required: true` set the entire time. That flag only ever guarded the
 * branch push, which made it read as an assurance about `main` that it never
 * was.
 *
 * Fetch-then-push from the server's own checkout: Gitea did the merge, so the
 * local clone has to learn the new base commit before it can forward it. The
 * push is a plain fast-forward — never `--force`, so a GitHub-side commit that
 * Gitea does not have makes this fail loudly instead of destroying it.
 *
 * Best-effort by construction: a mirror is a convenience copy, and a GitHub
 * outage must never make a completed, already-merged change report failure.
 * Failures log; the caller's result is unchanged.
 */
function mirror_base_to_github(git: GitConfig): void {
  if (TEST_MODE()) return;
  try {
    run_git(REPO_ROOT, ['fetch', 'origin', git.base_branch], gitea_auth_env(git));
    const refspec = `FETCH_HEAD:${git.base_branch}`;
    if (git.github_url && git.github_token) {
      const basic = Buffer.from(`x-access-token:${git.github_token}`).toString('base64');
      run_git(REPO_ROOT, ['push', git.github_url, refspec], {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      });
    } else {
      run_git(REPO_ROOT, ['push', 'github', refspec]);
    }
  } catch (err) {
    // run_git already redacts secrets from the message.
    console.error('[change_pipeline] github base mirror failed (non-fatal):', err);
  }
}

/**
 * Mark a PR ready (no-op for our non-WIP PRs) and merge it via the Gitea API.
 * Used only by `merge_approved_change` AFTER Kate-approval + owner-approval.
 */
export async function set_pr_ready_and_merge(
  pr_number: number,
  git: GitConfig = git_defaults(),
): Promise<{ merged: boolean; sha: string | null }> {
  if (TEST_MODE()) {
    return { merged: true, sha: `testsha_${pr_number}` };
  }
  const token = git.gitea_token;
  if (!token) {
    throw new Error(
      'change_pipeline: Gitea token not configured — set it in the Code Shop gear (or HEARTH_GITEA_TOKEN) to merge',
    );
  }
  const base = `${git.gitea_base_url}/api/v1/repos/${git.gitea_owner}/${git.gitea_repo}/pulls/${pr_number}`;
  const fetch_pr = async (): Promise<{ merged?: boolean; merged_commit_sha?: string } | null> => {
    try {
      return (await (await fetch(base, { headers: { Authorization: `token ${token}` } })).json()) as {
        merged?: boolean;
        merged_commit_sha?: string;
      };
    } catch {
      return null;
    }
  };

  const resp = await fetch(`${base}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `token ${token}` },
    body: JSON.stringify({ Do: git.merge_method }),
  });

  if (resp.ok) {
    const sha = (await fetch_pr())?.merged_commit_sha ?? null;
    mirror_base_to_github(git);
    return { merged: true, sha };
  }
  // 405/409 can mean "already merged" OR "not mergeable" (conflict/draft).
  // Only treat it as success if the PR is ACTUALLY merged — never mark a
  // conflicted PR merged in the ledger.
  if (resp.status === 405 || resp.status === 409) {
    const pr = await fetch_pr();
    if (pr?.merged === true) {
      mirror_base_to_github(git);
      return { merged: true, sha: pr.merged_commit_sha ?? null };
    }
    throw new PrNotMergeableError(pr_number, resp.status);
  }
  const body_text = await resp.text().catch(() => '');
  throw new Error(`Gitea PR merge failed: HTTP ${resp.status}: ${body_text.slice(0, 400)}`);
}

/**
 * Typed "the PR itself can't merge" error (conflict / draft), distinct from
 * auth/config/network failures — `merge_recovery` routes on it: a not-mergeable
 * PR is recoverable (update branch / re-land); a missing token is not.
 */
export class PrNotMergeableError extends Error {
  constructor(
    public readonly pr_number: number,
    public readonly http_status: number,
  ) {
    super(
      `Gitea PR #${pr_number} is not mergeable (HTTP ${http_status}; merged=false). Resolve conflicts / ready state and retry.`,
    );
    this.name = 'PrNotMergeableError';
  }
}

/**
 * Ask Gitea to update the PR's head branch from base (its "Update branch"
 * button: merges base INTO head). Resolves the stale-but-not-conflicting
 * class — when the branch merely fell behind main, this makes the PR
 * mergeable again with git's own 3-way merge as the correctness proof.
 * Returns `updated: false` on a real conflict (409) so the caller can fall
 * through to a re-land; throws on auth/config/network errors.
 */
export async function update_pr_branch(
  pr_number: number,
  git: GitConfig = git_defaults(),
): Promise<{ updated: boolean }> {
  if (TEST_MODE()) return { updated: true };
  const token = git.gitea_token;
  if (!token) {
    throw new Error(
      'change_pipeline: Gitea token not configured — set it in the Code Shop gear (or HEARTH_GITEA_TOKEN) to update a PR branch',
    );
  }
  const url = `${git.gitea_base_url}/api/v1/repos/${git.gitea_owner}/${git.gitea_repo}/pulls/${pr_number}/update?style=merge`;
  const resp = await fetch(url, { method: 'POST', headers: { Authorization: `token ${token}` } });
  if (resp.ok) return { updated: true };
  if (resp.status === 409) return { updated: false }; // real merge conflict
  const body_text = await resp.text().catch(() => '');
  throw new Error(`Gitea PR branch update failed: HTTP ${resp.status}: ${body_text.slice(0, 400)}`);
}

/** What `plan_reland` decided about an approved change vs CURRENT origin/base. */
export interface RelandPlan {
  verdict: 'relandable' | 'already_applied' | 'conflict';
  /** The subset of inputs still needed (already-applied pieces filtered out). */
  needed: ChangeInputs;
  /** Human/model-readable per-piece classification. */
  detail: string;
}

/**
 * Deterministically classify whether a change's verbatim inputs can be
 * re-applied onto CURRENT origin/<base> — the semantic re-land check behind
 * merge recovery, strictly stronger than git's textual 3-way merge for
 * `edits` (an exact-unique old_string match proves the context the edit
 * needs is intact, wherever the file moved around it).
 *
 *   - edit whose old_string still matches uniquely        → needed (re-land)
 *   - edit whose old_string is gone but new_string present → already applied
 *   - full file that doesn't exist on base                 → needed (creation)
 *   - full file byte-identical to stored contents          → already applied
 *   - anything else                                        → conflict (a full
 *     file that moved CANNOT be re-applied — it would clobber the moves; and
 *     an edit whose context vanished needs a human/Beatrice re-author)
 *
 * verdict: every piece applied → 'already_applied' (the content is on main —
 * landed externally); any conflict → 'conflict'; else 'relandable' with the
 * needed subset. Reads `origin/<base>` after a fetch; mutates nothing.
 */
export function plan_reland(inputs: ChangeInputs, git: GitConfig = git_defaults()): RelandPlan {
  run_git(REPO_ROOT, ['fetch', 'origin', git.base_branch], gitea_auth_env(git));
  const base_content = (path: string): string | null => {
    try {
      return run_git(REPO_ROOT, ['show', `origin/${git.base_branch}:${path}`]).stdout;
    } catch {
      return null; // path absent on base
    }
  };

  const detail: string[] = [];
  let conflict = false;
  const needed: ChangeInputs = { files: [], edits: [] };

  for (const file of inputs.files) {
    const cur = base_content(file.path);
    if (cur === null) {
      needed.files.push(file);
      detail.push(`${file.path}: absent on base — re-creatable`);
    } else if (cur === file.contents.trim() || cur === file.contents.trimEnd() || cur === file.contents) {
      // `git show` trims the trailing newline; compare tolerantly.
      detail.push(`${file.path}: already on base (byte-identical)`);
    } else {
      conflict = true;
      detail.push(
        `${file.path}: exists on base and DIFFERS from the approved full-file contents — ` +
          `re-applying would clobber later changes; needs a re-author`,
      );
    }
  }

  // Edits apply sequentially per file: classify each against the file as the
  // PRIOR needed edits would leave it, so multi-edit changes stay coherent.
  const by_path = new Map<string, FileEdit[]>();
  for (const e of inputs.edits) {
    const arr = by_path.get(e.path) ?? [];
    arr.push(e);
    by_path.set(e.path, arr);
  }
  for (const [path, fedits] of by_path) {
    const base = base_content(path);
    if (base === null) {
      conflict = true;
      detail.push(`${path}: edit target absent on base — needs a re-author`);
      continue;
    }
    let cur = base;
    for (const e of fedits) {
      const occurrences = cur.split(e.old_string).length - 1;
      if (occurrences === 1 || (e.replace_all && occurrences > 0)) {
        cur = apply_edits_to_content(cur, [e]);
        needed.edits.push(e);
        detail.push(`${path}: edit still applies (${occurrences} match)`);
      } else if (occurrences === 0 && cur.includes(e.new_string)) {
        detail.push(`${path}: edit already applied (new_string present)`);
      } else {
        conflict = true;
        detail.push(
          `${path}: edit ${occurrences === 0 ? 'context vanished' : `is ambiguous (${occurrences} matches)`} — needs a re-author`,
        );
      }
    }
  }

  const verdict: RelandPlan['verdict'] = conflict
    ? 'conflict'
    : needed.files.length + needed.edits.length === 0
      ? 'already_applied'
      : 'relandable';
  return { verdict, needed, detail: detail.join('\n') };
}

/**
 * The one isolated-change primitive: branch off origin/main in a temp worktree,
 * apply the mutations (full-file `files` and/or surgical `edits`), commit, push
 * both remotes, capture the diff, open a PR. Callers (propose_code_change,
 * propose_code_edit, apply_low_risk_fix) pre-validate domain rules; this also
 * re-runs `validate_path` + byte caps as a safety net.
 *
 * `files` (full contents) is for CREATING files or wholesale rewrites; `edits`
 * (search/replace, applied inside the worktree against origin/base) is for
 * surgical changes to EXISTING files — output proportional to the change, not
 * the file. A change may carry both.
 */
export async function open_change_pr(input: {
  branch_name: string;
  pr_title: string;
  pr_body: string;
  files?: FileChange[];
  edits?: FileEdit[];
  related_proposal_id?: string;
  triggered_by?: string;
  max_bytes_per_file?: number;
  git?: GitConfig;
  /** Guard-telemetry handle (2026-08-11). When present, a red deterministic
   *  gate (ChecksFailedError) increments the `change_checks_failed` counter —
   *  fail-open, read by Mariah's recurrence sweep. Optional so callers without
   *  a db (tests, ad-hoc scripts) are unchanged. */
  db?: Database;
}): Promise<OpenChangeResult> {
  const git = input.git ?? git_defaults();
  const max_bytes = input.max_bytes_per_file ?? DEFAULT_MAX_BYTES_PER_FILE;
  const files = input.files ?? [];
  const edits = input.edits ?? [];
  // Branch-name shape is validated HERE (not on each tool's schema — see
  // validate_branch_name) so every caller, including the merge-recovery
  // re-land path, is guarded before branch_name reaches git argv / a path.
  validate_branch_name(input.branch_name);
  if (files.length === 0 && edits.length === 0) {
    throw new Error('change_pipeline: open_change_pr requires at least one file or edit.');
  }
  for (const file of files) {
    validate_path(file.path);
    const bytes = Buffer.byteLength(file.contents, 'utf-8');
    if (bytes > max_bytes) {
      throw new Error(
        `change_pipeline: file "${file.path}" is ${bytes} bytes — over the ${max_bytes}-byte cap.`,
      );
    }
  }
  // Group edits by path — multiple edits to one file apply in order.
  const edits_by_path = new Map<string, FileEdit[]>();
  for (const e of edits) {
    validate_path(e.path);
    const arr = edits_by_path.get(e.path) ?? [];
    arr.push(e);
    edits_by_path.set(e.path, arr);
  }
  const files_changed = Array.from(
    new Set([...files.map((f) => f.path), ...edits_by_path.keys()]),
  );

  // Offline/test path: skip all git + Gitea, synthesize a reviewable result.
  // Edits are resolved against the live working tree (no worktree exists in
  // test mode) so the synthetic diff reflects the real applied result.
  if (TEST_MODE()) {
    const resolved: FileChange[] = [...files];
    for (const [path, fedits] of edits_by_path) {
      const abs = resolve(REPO_ROOT, path);
      const base = existsSync(abs) ? readFileSync(abs, 'utf-8') : '';
      resolved.push({ path, contents: apply_edits_to_content(base, fedits) });
    }
    const added = resolved.reduce((n, f) => n + f.contents.split('\n').length, 0);
    const diff_summary = resolved
      .map((f) => `--- a/${f.path}\n+++ b/${f.path}\n` + f.contents.split('\n').map((l) => `+${l}`).join('\n'))
      .join('\n');
    const truncated = diff_summary.length > DIFF_SUMMARY_CAP;
    return {
      branch: input.branch_name,
      commit_sha: `testsha_${input.branch_name.replace(/\W/g, '')}`,
      pr_url: `${GITEA_BASE}/${GITEA_OWNER}/${GITEA_REPO}/pulls/test`,
      pr_number: 0,
      files_changed,
      diff_summary: truncated ? diff_summary.slice(0, DIFF_SUMMARY_CAP) + '\n…[truncated]' : diff_summary,
      diff_truncated: truncated,
      lines_added: added,
      lines_removed: 0,
      languages: languages_for(files_changed),
      checks_passed: true,
      checks_summary: '(checks skipped: HEARTH_TEST_MODE)',
      change_inputs: { files, edits },
    };
  }

  // Refuse to overwrite an existing branch — pick a new name, never force-push.
  try {
    const existing = run_git(REPO_ROOT, ['rev-parse', '--verify', `refs/heads/${input.branch_name}`]);
    if (existing.stdout) {
      throw new Error(
        `change_pipeline: branch "${input.branch_name}" already exists locally. Pick a new name (e.g. add a -v2 suffix).`,
      );
    }
  } catch (err) {
    if (err instanceof Error && !err.message.includes('exit 128')) throw err;
  }

  run_git(REPO_ROOT, ['fetch', 'origin', git.base_branch], gitea_auth_env(git));

  mkdirSync(WORKTREE_ROOT, { recursive: true });
  const worktree_path = resolve(WORKTREE_ROOT, input.branch_name.replace(/\//g, '_'));
  if (existsSync(worktree_path)) {
    try {
      run_git(REPO_ROOT, ['worktree', 'remove', '--force', worktree_path]);
    } catch {
      rmSync(worktree_path, { recursive: true, force: true });
    }
  }
  run_git(REPO_ROOT, ['worktree', 'add', '-b', input.branch_name, worktree_path, `origin/${git.base_branch}`]);

  let commit_sha = '';
  let diff: ChangeDiff = { diff_summary: '', diff_truncated: false, lines_added: 0, lines_removed: 0, languages: languages_for(files_changed) };
  let checks: CheckResult = { passed: true, summary: '', ran_tsc: false, ran_guard: false };
  try {
    for (const file of files) {
      const abs = resolve(worktree_path, file.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, file.contents, 'utf-8');
    }
    // Apply surgical edits against the files as checked out from origin/base.
    for (const [path, fedits] of edits_by_path) {
      const abs = resolve(worktree_path, path);
      if (!existsSync(abs)) {
        throw new Error(
          `change_pipeline: edit target "${path}" does not exist on origin/${git.base_branch} — ` +
            `use propose_code_change (full file contents) to CREATE a new file.`,
        );
      }
      const next = apply_edits_to_content(readFileSync(abs, 'utf-8'), fedits);
      const bytes = Buffer.byteLength(next, 'utf-8');
      if (bytes > max_bytes) {
        throw new Error(
          `change_pipeline: edited file "${path}" is ${bytes} bytes — over the ${max_bytes}-byte cap.`,
        );
      }
      writeFileSync(abs, next, 'utf-8');
    }
    run_git(worktree_path, ['add', '--', ...files_changed]);

    const trailers: string[] = [];
    if (input.related_proposal_id) trailers.push(`Related-Proposal: ${input.related_proposal_id}`);
    if (input.triggered_by) trailers.push(`Triggered-By: ${input.triggered_by}`);
    trailers.push('Co-Authored-By: Beatrice (Hearth Trainer) <trainer@hearth.local>');
    const commit_message = `${input.pr_title}\n\n${input.pr_body}\n\n${trailers.join('\n')}`;
    // The orchestrator container has no global git identity (runs as a bare
    // UID with no ~/.gitconfig), so `git commit` would fail "Author identity
    // unknown". Stamp Beatrice's identity for the commit via env — self-
    // contained, no image/container config dependency.
    run_git(worktree_path, ['commit', '-m', commit_message], {
      GIT_AUTHOR_NAME: 'Beatrice (Hearth Trainer)',
      GIT_AUTHOR_EMAIL: 'trainer@hearth.local',
      GIT_COMMITTER_NAME: 'Beatrice (Hearth Trainer)',
      GIT_COMMITTER_EMAIL: 'trainer@hearth.local',
    });
    commit_sha = run_git(worktree_path, ['rev-parse', 'HEAD']).stdout;

    diff = compute_diff_summary(worktree_path, files_changed, git.base_branch);

    // Deterministic gate BEFORE the push — `bunx tsc --noEmit` (when .ts/.tsx
    // changed) + `bun run guard`, run in the worktree. A RED change throws here,
    // so it never reaches the push / PR-create below; the calling tool surfaces
    // the output to Beatrice to fix + re-file. GREEN result rides on the
    // returned OpenChangeResult → onto the change record.
    checks = run_checks(worktree_path, files_changed);
    if (!checks.passed) {
      // Guard telemetry (2026-08-11): a branch whose checks repeatedly reject
      // it is approved work being blocked — count per branch base so Mariah's
      // sweep sees the recurrence, then refuse as before.
      bump_guard_counter(
        input.db,
        GUARD_CHANGE_CHECKS_FAILED,
        change_dedup_key(input.branch_name, input.related_proposal_id),
        checks.summary.slice(0, 400),
      );
      throw new ChecksFailedError(checks.summary);
    }

    run_git(worktree_path, ['push', '--set-upstream', 'origin', input.branch_name], gitea_auth_env(git));
    // GitHub mirror push. When a github_url + token are configured, pass the
    // token via an env-injected http.extraHeader (GIT_CONFIG_* env, NOT argv and
    // NOT the remote URL) so it never lands in the process table, git's echoed
    // remote string, error output, or logs. Else fall back to the preconfigured
    // `github` remote. Non-fatal unless the owner set github_required.
    try {
      if (git.github_url && git.github_token) {
        const basic = Buffer.from(`x-access-token:${git.github_token}`).toString('base64');
        run_git(worktree_path, ['push', git.github_url, input.branch_name], {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.extraHeader',
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
        });
      } else {
        run_git(worktree_path, ['push', 'github', input.branch_name]);
      }
    } catch (err) {
      // err is already secret-redacted by run_git; safe to rethrow/log.
      if (git.github_required) throw err;
      console.error('[change_pipeline] github push failed (non-fatal):', err);
    }
  } finally {
    try {
      run_git(REPO_ROOT, ['worktree', 'remove', '--force', worktree_path]);
    } catch (err) {
      console.error('[change_pipeline] worktree cleanup failed:', err);
    }
  }

  const pr_body_full =
    input.pr_body +
    '\n\n---\n' +
    '_Authored by **Beatrice** (Hearth Trainer) via the change pipeline._\n' +
    (input.related_proposal_id ? `_Related proposal: \`${input.related_proposal_id}\`._\n` : '') +
    (input.triggered_by ? `_Triggered by: ${input.triggered_by}._\n` : '');
  const pr = await create_gitea_pr({ branch: input.branch_name, title: input.pr_title, body: pr_body_full }, git);

  return {
    branch: input.branch_name,
    commit_sha,
    pr_url: pr.url,
    pr_number: pr.number,
    files_changed,
    ...diff,
    checks_passed: checks.passed,
    checks_summary: checks.summary,
    change_inputs: { files, edits },
  };
}
