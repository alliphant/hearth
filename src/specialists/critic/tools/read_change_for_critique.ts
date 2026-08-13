/**
 * read_change_for_critique — Vera (the code critic)'s read path into one
 * Beatrice change record.
 *
 * The critic half of the author/critic review pair (2026-07-14): Kate
 * delegates a pending change to Vera (`delegate to:'critic'`), Vera pulls the
 * FULL embedded record with this tool — diff, rationale, files, deterministic
 * check results — critiques it adversarially (verifying claims against the
 * real repo via her read_codebase tools), and her digest returns to Kate.
 *
 * Deliberately READ-ONLY and verdict-free: Vera holds no review_beatrice_change
 * and no write capability of any kind, so she structurally cannot move a
 * change's status, file a proposal, or touch the repo. Kate weighs the
 * critique and rules via review_change; the owner still merges. Any status is
 * readable (not just pending_kate_review) so Kate can also commission a
 * post-mortem critique of a merged change.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { ChangeRecordsStore } from '@memory/stores/change_records';

const InputSchema = z.object({
  change_id: z.string().min(1).describe('The bchg_* id of the change to critique.'),
});

const OutputSchema = z.object({
  found: z.boolean(),
  change_id: z.string(),
  status: z.string().optional(),
  origin: z.string().optional(),
  change_kind: z.string().optional(),
  target_specialist_id: z.string().nullable().optional(),
  branch: z.string().optional(),
  pr_url: z.string().nullable().optional(),
  files: z.array(z.string()).optional(),
  lines_added: z.number().optional(),
  lines_removed: z.number().optional(),
  languages: z.array(z.string()).optional(),
  checks_passed: z.boolean().nullable().optional(),
  checks_summary: z.string().nullable().optional(),
  rationale_md: z.string().optional(),
  diff_truncated: z.boolean().optional(),
  diff_summary: z.string().optional(),
  next_action: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function create(deps: ToolDeps): Tool {
  const store = new ChangeRecordsStore(deps.db);
  const tool: Tool<Input, Output> = {
    name: 'read_change_for_critique',
    description:
      'Read ONE Beatrice change record in full — embedded diff, rationale, files, ' +
      'code metrics, and the deterministic check results — so you can critique it. ' +
      'Verify what the diff claims against the REAL repo with grep_codebase / ' +
      'read_codebase_file (does the edited shape exist? does the change break a ' +
      'caller the diff never shows?). You render findings, never verdicts — Kate ' +
      'weighs your critique and rules; you cannot move the change.',
    risk: 'read',
    required_capabilities: ['critique_code_change'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    // The embedded diff is the tool's entire value — don't let default
    // truncation clip it (same rationale as delegate's digest budget).
    llm_budget: 12_000,

    idempotency_key: (i) => `read_change_for_critique:${i.change_id}`,

    async execute(input, _ctx: ToolContext): Promise<Output> {
      const r = store.get(input.change_id);
      if (!r) {
        return {
          found: false,
          change_id: input.change_id,
          next_action:
            'No change record with that id — report back that the id was not found; do not invent a critique.',
        };
      }
      return {
        found: true,
        change_id: r.id,
        status: r.status,
        origin: r.origin,
        change_kind: r.change_kind,
        target_specialist_id: r.target_specialist_id,
        branch: r.branch,
        pr_url: r.pr_url,
        files: r.files,
        lines_added: r.lines_added,
        lines_removed: r.lines_removed,
        languages: r.languages,
        checks_passed: r.checks_passed,
        checks_summary: r.checks_summary,
        rationale_md: r.rationale_md,
        diff_truncated: r.diff_truncated,
        diff_summary: r.diff_summary,
        next_action:
          'Critique adversarially: try to REFUTE the change against its stated rationale. ' +
          'Check the diff against the real repo (grep_codebase / read_codebase_file) for ' +
          'broken callers, scope creep, and unverifiable claims. Report concrete findings ' +
          'each with severity (blocker / concern / nit) and file:line anchors — or state ' +
          'plainly that you found nothing to refute. No verdict; Kate rules.',
      };
    },
  };
  return tool as Tool;
}
