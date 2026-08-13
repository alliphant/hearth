/**
 * propose_code_edit — Beatrice's SURGICAL code-edit surface (the best-practice
 * authoring primitive: search/replace, not whole-file rewrites).
 *
 * `propose_code_change` hands back FULL file contents — correct for CREATING a
 * file, but it forces a whole-file rewrite to change three lines, and the local
 * model chokes on re-emitting a 480-line file (it reads, then bails). This tool
 * is what every serious coding agent uses instead: the model emits small
 * `{ old_string, new_string }` blocks whose size is proportional to the CHANGE,
 * not the file. A deterministic applier (`apply_edits_to_content`) requires each
 * `old_string` to match the file EXACTLY and UNIQUELY (or it errors so the model
 * retries with more context — never a silent mis-application). The edits are
 * applied inside the same isolated worktree, git computes the real diff, and the
 * change flows through the IDENTICAL Kate-review → owner-merge gate as a full
 * `propose_code_change`. Only the authoring step differs.
 *
 * Use propose_code_edit to MODIFY an existing file; use propose_code_change to
 * CREATE a new file (or a wholesale rewrite). Both NEVER merge — review + owner
 * approval is the permanent gate.
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

const DEFAULT_MAX_EDITS = 50;

const EditSchema = z.object({
  path: z.string().min(1).describe('Repo-relative path of the EXISTING file to edit (src/, config/, scripts/, apps/).'),
  old_string: z
    .string()
    .min(1)
    .describe(
      'The exact text to find — must match the file byte-for-byte, including ' +
        'indentation. Include enough surrounding context that it occurs EXACTLY ' +
        'ONCE in the file (otherwise the edit is rejected as ambiguous).',
    ),
  new_string: z.string().describe('The replacement text (may be empty to delete). Must differ from old_string.'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace every occurrence (global rename). Default false = require a single unique match.'),
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
  edits: z.array(EditSchema).min(1).max(DEFAULT_MAX_EDITS),
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

export function make_propose_code_edit(deps: ProposeDeps): Tool<Input, Output> {
  return {
    name: 'propose_code_edit',
    description:
      "Open a Pull Request that EDITS one or more EXISTING files via surgical " +
      'search/replace — the right tool for MODIFYING code (use propose_code_change ' +
      'only to CREATE a new file or do a wholesale rewrite). Each edit is ' +
      '`{ path, old_string, new_string }`: old_string must match the file exactly ' +
      'and occur ONCE (add surrounding context to disambiguate, or set replace_all ' +
      'for a global rename). Your output is proportional to the CHANGE, not the file ' +
      '— a one-line fix is a one-line edit, so you never rewrite a whole file. The ' +
      'edits apply in an isolated worktree off origin/main; git computes the diff; ' +
      'Kate skeptic-reviews and the owner approves the merge in the Code Shop. Path ' +
      'allowlist: src/, config/, scripts/, apps/. NEVER merges — review + owner ' +
      'approval is the permanent gate. Use when implementing an approved proposal or ' +
      'a direct instruction to change specific code.',
    risk: 'write_internal',
    required_capabilities: ['write_codebase_pr'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `propose_code_edit:${input.branch_name}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      if (new CodeShopSettings(deps.db).get().paused) {
        throw new Error('Beatrice is paused by the owner — no changes are being opened. Un-pause in the Code Shop gear.');
      }
      // Pre-validate paths for an early, tool-named error (open_change_pr re-checks).
      for (const e of input.edits) validate_path(e.path);

      const result = await open_change_pr({
        branch_name: input.branch_name,
        pr_title: input.pr_title,
        pr_body: input.pr_body,
        edits: input.edits,
        related_proposal_id: input.related_proposal_id,
        triggered_by: input.triggered_by,
        git: resolve_git_config(deps.db),
        db: deps.db,
      });

      const audit_id = ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'trainer',
        tool_name: 'propose_code_edit',
        tool_input: {
          branch: input.branch_name,
          edit_count: input.edits.length,
          files: result.files_changed,
          related_proposal_id: input.related_proposal_id,
        },
        execution_result: {
          pr_url: result.pr_url,
          pr_number: result.pr_number,
          commit_sha: result.commit_sha,
        },
      });

      // Same Kate-review → owner-merge gate as propose_code_change.
      const { change } = route_change_for_review({
        db: deps.db,
        inbox: deps.inbox,
        events: deps.events,
        result,
        origin: 'propose_code_edit',
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
  return make_propose_code_edit({
    db: deps.db,
    inbox: deps.inbox,
    events: deps.events,
  }) as Tool;
}
