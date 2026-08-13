/**
 * opencode_build — Beatrice authors through a REAL coding harness (2026-07-18).
 *
 * Phase 1 of the owner's "stop hand-rolling the authoring loop" directive:
 * OpenCode (opencode-ai, exact-pinned devDependency) runs HEADLESS against
 * the local 35B in a scratch git worktree, does the explore→edit→iterate
 * loop with its own tooling, and whatever it produced is then submitted
 * through the EXACT same gate as every Beatrice change —
 * `open_change_pr` (path allowlist → tsc/guard checks → PR) →
 * `route_change_for_review` (Vera critique → Kate verdict → owner merge).
 * The harness replaces the workbench's authoring mechanics, never the
 * governance.
 *
 * Containment (Phase-1 posture, deliberate):
 *   - The harness gets NO shell and NO web: the generated opencode.json
 *     denies `bash` + `webfetch`; its native read/grep/glob/edit tools are
 *     the whole surface. Verification is OURS: a deterministic
 *     `run_tsc_noEmit` pre-check in the scratch tree, ONE repair round with
 *     the errors, then the pipeline's own checks gate again at PR-open.
 *   - The child env is SCRUBBED — an explicit minimal env (PATH + a HOME
 *     jailed inside the scratch dir), never process.env, so orchestrator
 *     secrets don't ride into the harness process.
 *   - The scratch worktree's the private dev log is OVERWRITTEN with the distilled
 *     AGENTS.md content before the run (the real the private dev log is ~90k tokens —
 *     the Phase-0 eval showed OpenCode auto-ingests it and blows the 49k
 *     slot into an unrecoverable compaction loop). Injected files
 *     (opencode.json / the private dev log / the .home jail) are excluded from
 *     collection; non-allowlisted paths (package.json, AGENTS.md, …) are
 *     SKIPPED with a note in the PR body rather than failing the submit;
 *     deletions are not collectable (noted honestly).
 *   - Kill switch HEARTH_OPENCODE=0; a missing binary degrades to an
 *     honest "harness unavailable — use the workbench" result.
 *
 * Phase-0 eval (2026-07-18, vs the same 35B): full agentic run in ~3 min,
 * repo-convention-correct output, clean tsc — and one silently dropped
 * hard sub-requirement, which is why the review chain stays mandatory.
 */
import { z } from 'zod';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';
import type { Database } from 'bun:sqlite';
import {
  open_change_pr,
  resolve_git_config,
  run_git,
  run_tsc_noEmit,
  validate_path,
  REPO_ROOT,
  WORKTREE_ROOT,
  ChecksFailedError,
} from '../change_pipeline';
import { route_change_for_review } from '../review_routing';
import { CodeShopSettings } from '@memory/stores/codeshop_settings';

const MAX_FILES = 30;
const HARNESS_TIMEOUT_MS_DEFAULT = 15 * 60_000;

export function opencode_enabled(): boolean {
  return process.env.HEARTH_OPENCODE !== '0';
}

function opencode_bin(): string {
  return process.env.HEARTH_OPENCODE_BIN ?? resolve(REPO_ROOT, 'node_modules/.bin/opencode');
}

function base_url(): string {
  return process.env.HEARTH_OPENCODE_BASEURL ?? 'http://host.docker.internal:8200/v1';
}

function model_id(): string {
  return process.env.HEARTH_OPENCODE_MODEL ?? 'qwen36-35b-a3b';
}

function harness_timeout_ms(): number {
  const raw = Number(process.env.HEARTH_OPENCODE_TIMEOUT_MS ?? String(HARNESS_TIMEOUT_MS_DEFAULT));
  return Number.isFinite(raw) && raw > 60_000 ? raw : HARNESS_TIMEOUT_MS_DEFAULT;
}

/** Paths this tool injects into the scratch worktree — never collected. */
export const INJECTED_PATHS = ['opencode.json', 'the private dev log', 'CLAUDE.md'] as const;

/**
 * Parse `git status --porcelain` output into collectable / skipped /
 * deleted buckets. Pure — exported for the smoke. Injected paths and
 * anything under the .home jail are dropped silently; deletions and
 * non-allowlisted paths are surfaced so the PR body can say so honestly.
 */
export function partition_porcelain(porcelain: string): {
  collect: string[];
  skipped_outside_allowlist: string[];
  deletions: string[];
} {
  const collect: string[] = [];
  const skipped: string[] = [];
  const deletions: string[] = [];
  for (const raw_line of porcelain.split('\n')) {
    const line = raw_line.trimEnd();
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    // Renames render as "R  old -> new" — treat as delete+add.
    let path = line.slice(3).trim();
    if (path.includes(' -> ')) {
      const [from, to] = path.split(' -> ');
      deletions.push(from!.trim());
      path = to!.trim();
    }
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if ((INJECTED_PATHS as readonly string[]).includes(path)) continue;
    if (path.startsWith('.home/') || path.startsWith('.opencode/')) continue;
    if (status.includes('D')) {
      deletions.push(path);
      continue;
    }
    try {
      validate_path(path);
      collect.push(path);
    } catch {
      skipped.push(path);
    }
  }
  return { collect, skipped_outside_allowlist: skipped, deletions };
}

const DISTILLED_RULES = `# hearth-backend — harness working notes

Bun + TypeScript orchestrator. Conventions that matter:

- Typecheck: \`bunx tsc --noEmit\` (run by the pipeline after you finish —
  you have no shell; write code that compiles).
- Path aliases: \`@core/*\`→src/core, \`@memory/*\`→src/memory,
  \`@app/*\`→src/app, \`@library/*\`→src/library, \`@specialists/*\`→src/specialists.
- bun:sqlite named binds MUST carry their sigil: \`stmt.run({ '@id': x })\`,
  never \`{ id: x }\` (bare keys silently bind NULL).
- Timestamps are ISO-8601 TEXT; lexicographic compare IS chronological.
- Smoke scripts: scripts/smoke-*.ts with a local assert() failure counter,
  ✓/✗ lines, a final PASSED/FAILED line, and explicit process.exit.
- ONLY edit under src/, config/, scripts/, apps/ — root files
  (package.json, AGENTS.md), .env, data/, node_modules are NOT collected
  from your workspace and must not be part of your plan.
- Do not delete or rename files (deletions are not collected) — edit in
  place or add new files.
- Your finished workspace is submitted through a review pipeline (checks →
  adversarial critique → Kate review → owner merge). Keep the change
  scoped exactly to the task; a correct minimal change beats a broad one.
`;

const InputSchema = z.object({
  /** The build task, self-contained — the harness cannot see any conversation. */
  task: z.string().min(20).max(8_000),
  /** Extra context worth handing over (spec notes, file hints, prior findings). */
  context: z.string().max(8_000).optional(),
  branch_name: z
    .string()
    .min(3)
    .max(80)
    .optional()
    .describe('Branch name (default beatrice/oc-<id>): letters/numbers/hyphens/underscores/slashes.'),
  pr_title: z.string().min(8).max(140).optional(),
  related_proposal_id: z.string().optional(),
  triggered_by: z.string().optional(),
});

const OutputSchema = z.object({
  ok: z.boolean(),
  change_id: z.string().optional(),
  branch: z.string().optional(),
  pr_url: z.string().optional(),
  files_changed: z.array(z.string()).optional(),
  skipped_outside_allowlist: z.array(z.string()).optional(),
  deletions_not_collected: z.array(z.string()).optional(),
  /** 1 = first pass green; 2 = repair round used. */
  rounds: z.number().optional(),
  error: z.string().optional(),
  next_action: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

interface BuildDeps {
  db: Database;
  inbox: SpecialistInbox;
  events: AppEventBus;
}

async function run_harness(
  scratch: string,
  prompt: string,
  timeout_ms: number,
): Promise<{ ok: boolean; output: string }> {
  const home = resolve(scratch, '.home');
  mkdirSync(home, { recursive: true });
  const proc = Bun.spawn([opencode_bin(), 'run', prompt], {
    cwd: scratch,
    // SCRUBBED env — never process.env: no orchestrator secrets ride along.
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: home,
      XDG_CONFIG_HOME: resolve(home, '.config'),
      XDG_DATA_HOME: resolve(home, '.data'),
      XDG_CACHE_HOME: resolve(home, '.cache'),
      NO_COLOR: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }, timeout_ms);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const tail = (s: string) => (s.length > 4_000 ? `…${s.slice(-4_000)}` : s);
    return { ok: code === 0, output: `${tail(out)}\n${tail(err)}`.trim() };
  } finally {
    clearTimeout(timer);
  }
}

export function make_opencode_build(deps: BuildDeps): Tool<Input, Output> {
  return {
    name: 'opencode_build',
    description:
      'Author a code change through the OpenCode harness: it runs headless in an isolated ' +
      'scratch worktree against the local model, explores the repo and edits files with its ' +
      'own tools (no shell, no web), gets a deterministic tsc pre-check plus ONE repair ' +
      'round, and the result is submitted through the normal pipeline — path allowlist, ' +
      'checks, your PR, Vera critique, Kate review, owner merge. PREFER this over the ' +
      'workbench for multi-file or exploratory builds (build requests, directed builds); ' +
      'keep the workbench for surgical single-file work you can author directly. The task ' +
      'must be self-contained with concrete acceptance criteria — the harness sees only ' +
      'what you pass. This tool NEVER merges.',
    risk: 'write_internal',
    required_capabilities: ['write_codebase_pr'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key: (i) => `opencode_build:${i.branch_name ?? i.task.slice(0, 60)}`,

    async execute(input, ctx: ToolContext): Promise<Output> {
      if (!opencode_enabled()) {
        return {
          ok: false,
          error: 'the OpenCode harness is disabled (HEARTH_OPENCODE=0)',
          next_action: 'Author via the workbench flow instead (scaffold_code → workbench_* → submit).',
        };
      }
      if (!existsSync(opencode_bin())) {
        return {
          ok: false,
          error: `harness unavailable — no opencode binary at ${opencode_bin()}`,
          next_action:
            'Author via the workbench flow instead; flag the missing binary (bun install on the deploy box installs the pinned opencode-ai devDependency).',
        };
      }
      if (new CodeShopSettings(deps.db).get().paused) {
        throw new Error('Beatrice is paused by the owner — no changes are being opened.');
      }

      const id = ulid().toLowerCase().slice(-10);
      const branch = input.branch_name ?? `beatrice/oc-${id}`;
      const scratch = resolve(WORKTREE_ROOT, `oc-${id}`);
      mkdirSync(WORKTREE_ROOT, { recursive: true });

      try {
        run_git(REPO_ROOT, ['fetch', 'origin']);
        run_git(REPO_ROOT, ['worktree', 'add', '--detach', scratch, 'origin/main']);

        // Inject the harness config + distilled rules (Phase-0 lesson: the
        // real the private dev log is ~90k tokens and puts OpenCode into a fatal
        // compaction loop on the 49k slot).
        writeFileSync(
          resolve(scratch, 'opencode.json'),
          JSON.stringify(
            {
              $schema: 'https://opencode.ai/config.json',
              provider: {
                glacier: {
                  npm: '@ai-sdk/openai-compatible',
                  name: 'the LLM host 35B',
                  options: { baseURL: base_url() },
                  models: {
                    [model_id()]: {
                      name: 'local build model',
                      limit: { context: 49_152, output: 8_192 },
                    },
                  },
                },
              },
              model: `glacier/${model_id()}`,
              permission: { edit: 'allow', bash: 'deny', webfetch: 'deny' },
            },
            null,
            2,
          ),
        );
        for (const rules_name of ['the private dev log', 'CLAUDE.md']) {
          const p = resolve(scratch, rules_name);
          if (existsSync(p)) writeFileSync(p, DISTILLED_RULES);
        }
        writeFileSync(resolve(scratch, 'AGENTS.md'), DISTILLED_RULES);
        // node_modules for the tsc pre-check (and the harness's own reads).
        const nm = resolve(scratch, 'node_modules');
        if (!existsSync(nm)) symlinkSync(resolve(REPO_ROOT, 'node_modules'), nm, 'dir');

        const prompt =
          `${input.task.trim()}\n\n` +
          (input.context ? `## Context\n${input.context.trim()}\n\n` : '') +
          `Read AGENTS.md first — it carries the repo conventions and the hard ` +
          `boundaries (allowlisted directories, no deletions/renames). You have no ` +
          `shell and no web; use your read/grep/edit tools. Write code that ` +
          `compiles — a typecheck runs after you finish.`;

        // Round 1.
        const timeout = harness_timeout_ms();
        const first = await run_harness(scratch, prompt, timeout);
        let rounds = 1;
        let collected = partition_porcelain(
          run_git(scratch, ['status', '--porcelain']).stdout,
        );
        if (collected.collect.length === 0) {
          return {
            ok: false,
            rounds,
            error:
              'the harness produced no collectable changes' +
              (collected.skipped_outside_allowlist.length
                ? ` (it only touched non-allowlisted paths: ${collected.skipped_outside_allowlist.join(', ')})`
                : '') +
              ` — harness output tail: ${first.output.slice(-1_500)}`,
            next_action:
              'Re-call with a sharper, more self-contained task (name the target files/dirs under src/, config/, scripts/, or apps/), or author via the workbench.',
          };
        }

        // Deterministic pre-check + ONE repair round.
        let check = run_tsc_noEmit(scratch);
        if (!check.ok) {
          const repair =
            `The typecheck failed on your changes. Fix ONLY these errors — do not ` +
            `expand scope:\n\n${check.output.slice(-4_000)}`;
          await run_harness(scratch, repair, timeout);
          rounds = 2;
          collected = partition_porcelain(run_git(scratch, ['status', '--porcelain']).stdout);
          check = run_tsc_noEmit(scratch);
          if (!check.ok) {
            return {
              ok: false,
              rounds,
              error: `typecheck still red after the repair round: ${check.output.slice(-1_500)}`,
              next_action:
                'Narrow the task (smaller scope, name the exact files) and re-call, or author via the workbench with this error output in hand.',
            };
          }
        }

        if (collected.collect.length > MAX_FILES) {
          return {
            ok: false,
            rounds,
            error: `harness touched ${collected.collect.length} files — over the ${MAX_FILES}-file cap; a change this broad needs decomposition`,
            next_action: 'Split the task into smaller opencode_build calls, one concern each.',
          };
        }
        const files = collected.collect.map((p) => ({
          path: p,
          contents: readFileSync(resolve(scratch, p), 'utf-8'),
        }));

        const notes: string[] = [];
        if (collected.skipped_outside_allowlist.length)
          notes.push(
            `Skipped (outside the pipeline allowlist): ${collected.skipped_outside_allowlist.join(', ')}.`,
          );
        if (collected.deletions.length)
          notes.push(
            `NOT collected (deletions are unsupported): ${collected.deletions.join(', ')}.`,
          );
        const pr_title = input.pr_title ?? `harness build: ${input.task.slice(0, 110)}`;
        const pr_body =
          `Authored via the OpenCode harness (headless, local model, no shell/web), ` +
          `${rounds === 1 ? 'clean on the first pass' : 'one repair round used'}; tsc green ` +
          `in the scratch tree before submission.\n\n## Task\n${input.task.trim()}\n` +
          (notes.length ? `\n## Collection notes\n${notes.map((n) => `- ${n}`).join('\n')}\n` : '') +
          `\n## Harness output (tail)\n\n\`\`\`\n${first.output.slice(-2_000)}\n\`\`\``;

        const result = await open_change_pr({
          branch_name: branch,
          pr_title,
          pr_body,
          files,
          related_proposal_id: input.related_proposal_id,
          triggered_by: input.triggered_by ?? 'opencode_build',
          git: resolve_git_config(deps.db),
        });

        const audit_id = ctx.memory.log_action({
          intent_id: ctx.intent_id,
          agent: ctx.specialist_id ?? 'trainer',
          tool_name: 'opencode_build',
          tool_input: { branch, task: input.task.slice(0, 300), rounds },
          execution_result: { pr_url: result.pr_url, files: result.files_changed.length },
        });

        const { change } = route_change_for_review({
          db: deps.db,
          inbox: deps.inbox,
          events: deps.events,
          result,
          origin: 'opencode_build',
          change_kind: 'code',
          rationale_md: pr_title,
          dedup_key: input.related_proposal_id
            ? `code:${input.related_proposal_id}`
            : `code:${branch.replace(/-v\d+$/, '')}`,
          related_proposal_id: input.related_proposal_id,
          audit_id,
        });

        return {
          ok: true,
          change_id: change.id,
          branch: result.branch,
          pr_url: result.pr_url,
          files_changed: result.files_changed,
          skipped_outside_allowlist: collected.skipped_outside_allowlist,
          deletions_not_collected: collected.deletions,
          rounds,
        };
      } catch (err) {
        if (err instanceof ChecksFailedError) {
          return {
            ok: false,
            error: `pipeline checks failed at PR-open: ${err.message.slice(0, 1_500)}`,
            next_action:
              'The scratch tsc passed but the full gate (guard / test-first / boot-check) did not — read the failure, then re-call with the fix folded into the task.',
          };
        }
        throw err;
      } finally {
        try {
          run_git(REPO_ROOT, ['worktree', 'remove', '--force', scratch]);
        } catch {
          try {
            rmSync(scratch, { recursive: true, force: true });
            run_git(REPO_ROOT, ['worktree', 'prune']);
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_opencode_build({
    db: deps.db,
    inbox: deps.inbox,
    events: deps.events,
  }) as Tool;
}
