/**
 * propose_code_change — Beatrice's code-execution surface.
 *
 * Turns a design into a reviewable Pull Request. The worktree→branch→push→PR
 * mechanics now live in the shared `change_pipeline.ts` (`open_change_pr`), which
 * BOTH this tool and `apply_low_risk_fix` use so every Beatrice change is an
 * isolated branch off origin/main — never a live-tree write.
 *
 * Why no auto-merge: the PR is the review gate. Beatrice writes the code; the
 * Kate skeptic review + owner approval (the Code Shop office) gate the merge,
 * which Beatrice then performs via `merge_approved_change`. This tool NEVER
 * merges.
 *
 * Safety (enforced in change_pipeline): path allowlist src/, config/, scripts/,
 * apps/ (no .git/, .env, node_modules, data/, secrets); per-file byte cap; file
 * count cap (schema); refuses to overwrite an existing branch.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';
import type { Database } from 'bun:sqlite';
import { change_dedup_key, open_change_pr, validate_path, resolve_git_config } from '../change_pipeline';
import { route_change_for_review } from '../review_routing';
import { CodeShopSettings } from '@memory/stores/codeshop_settings';

const DEFAULT_MAX_FILES = 30;

const FileChangeSchema = z.object({
  path: z.string().min(1),
  // Full file contents — Beatrice provides complete files, not diffs.
  contents: z.string(),
});

const InputSchema = z.object({
  // NOTE: no `.regex()` — a tool input_schema becomes a GBNF grammar on the
  // interactive 9B, and llama.cpp's converter mistranslates a regex `pattern`
  // and SILENTLY disables the whole tool grammar. The branch-name shape is
  // validated (and is security-load-bearing) in change_pipeline's
  // `validate_branch_name`, called by `open_change_pr`.
  branch_name: z
    .string()
    .min(3)
    .max(80)
    .describe('Branch name: letters/numbers/hyphens/underscores/slashes, starting with a letter (e.g. "beatrice/fix-thing").'),
  pr_title: z.string().min(8).max(140),
  pr_body: z.string().min(20).max(20_000),
  files: z.array(FileChangeSchema).min(1).max(DEFAULT_MAX_FILES),
  related_proposal_id: z.string().optional(),
  triggered_by: z.string().optional(),
});

const OutputSchema = z.object({
  change_id: z.string(),
  branch: z.string(),
  commit_sha: z.string(),
  pr_url: z.string(),
  pr_number: z.number(),
  files_changed: z.array(z.string()),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

interface ProposeDeps {
  db: Database;
  inbox: SpecialistInbox;
  events: AppEventBus;
}

export function make_propose_code_change(deps: ProposeDeps): Tool<Input, Output> {
  return {
    name: 'propose_code_change',
    description:
      "Open a Pull Request with one or more file changes. Beatrice's primary execution surface — turns design proposals into reviewable code. Branches from origin/main in an isolated git worktree, writes the proposed files (full contents — no diff syntax), commits with rationale, pushes to both remotes (Gitea + GitHub), and creates a PR via Gitea API. Returns the PR URL. The change is then skeptic-reviewed by Kate and merge-approved by the owner in the Code Shop office. Path allowlist: src/, config/, scripts/, apps/ — secrets, .git/, node_modules, data/ are blocked. This tool NEVER merges; review + owner approval is the permanent gate. Use ONLY when implementing an approved proposal or executing a direct user instruction to implement specific code — do not call autonomously from your audit-log scan.",
    risk: 'write_internal',
    required_capabilities: ['write_codebase_pr'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      // Branch names are unique per work-unit; same branch = same op.
      return `propose_code_change:${input.branch_name}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      if (new CodeShopSettings(deps.db).get().paused) {
        throw new Error('Beatrice is paused by the owner — no changes are being opened. Un-pause in the Code Shop gear.');
      }
      // Pre-validate paths for an early, tool-named error (open_change_pr re-checks).
      for (const file of input.files) validate_path(file.path);

      const result = await open_change_pr({
        branch_name: input.branch_name,
        pr_title: input.pr_title,
        pr_body: input.pr_body,
        files: input.files,
        related_proposal_id: input.related_proposal_id,
        triggered_by: input.triggered_by,
        git: resolve_git_config(deps.db),
        db: deps.db,
      });

      const audit_id = ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'trainer',
        tool_name: 'propose_code_change',
        tool_input: {
          branch: input.branch_name,
          file_count: input.files.length,
          related_proposal_id: input.related_proposal_id,
        },
        execution_result: {
          pr_url: result.pr_url,
          pr_number: result.pr_number,
          commit_sha: result.commit_sha,
        },
      });

      // Route through the Kate skeptic gate + Code Shop office, like every
      // Beatrice change. The PR is opened, but it does NOT merge until Kate
      // approves and the owner approves the merge.
      const { change } = route_change_for_review({
        db: deps.db,
        inbox: deps.inbox,
        events: deps.events,
        result,
        origin: 'propose_code_change',
        change_kind: 'code',
        rationale_md: input.pr_title,
        // Same-branch supersession only — see change_dedup_key for why the
        // bare proposal-id key wrongly retired sibling PRs (#268/#269).
        dedup_key: change_dedup_key(input.branch_name, input.related_proposal_id),
        related_proposal_id: input.related_proposal_id,
        audit_id,
      });

      return {
        change_id: change.id,
        branch: result.branch,
        commit_sha: result.commit_sha,
        pr_url: result.pr_url,
        pr_number: result.pr_number,
        files_changed: result.files_changed,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_propose_code_change({
    db: deps.db,
    inbox: deps.inbox,
    events: deps.events,
  }) as Tool;
}
