/**
 * list_changes_for_review — Kate's read path into Beatrice's change records.
 *
 * Two jobs, one tool:
 *   1. The review queue (default): every change in `pending_kate_review`
 *      with its EMBEDDED diff, so Kate can skeptic-review without any
 *      repo-read access. She then calls `review_change` to rule.
 *   2. Conversational review (2026-07-18): the owner discusses a change in
 *      chat — including one already sitting in HIS merge queue
 *      (`pending_owner_merge`) or already merged — so `change_id` fetches
 *      one specific record at ANY status, and `status` widens the listing.
 *      This is what lets Kate walk him through a PR in text: the row
 *      carries the diff, rationale, checks verdict, and her own recorded
 *      review.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { ChangeRecordsStore, type ChangeStatus } from '@memory/stores/change_records';

const InputSchema = z.object({
  limit: z.number().int().min(1).max(50).default(10),
  /** Fetch ONE specific change (any status) — the conversational-review read. */
  change_id: z.string().optional(),
  /** Listing filter. Default stays the review queue; 'any' lists recent
   *  records regardless of lifecycle stage. */
  status: z
    .enum([
      'pending_kate_review',
      'pending_owner_merge',
      'merged',
      'denied_by_kate',
      'any',
    ])
    .default('pending_kate_review'),
});

const ChangeView = z.object({
  change_id: z.string(),
  status: z.string(),
  origin: z.string(),
  change_kind: z.string(),
  target_specialist_id: z.string().nullable(),
  branch: z.string(),
  pr_url: z.string().nullable(),
  lines_added: z.number(),
  lines_removed: z.number(),
  languages: z.array(z.string()),
  files: z.array(z.string()),
  diff_truncated: z.boolean(),
  diff_summary: z.string(),
  rationale_md: z.string(),
  checks_passed: z.boolean().nullable(),
  checks_summary: z.string().nullable(),
  kate_verdict: z.string().nullable(),
  kate_reasons_md: z.string().nullable(),
});

const OutputSchema = z.object({
  count: z.number(),
  changes: z.array(ChangeView),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function create(deps: ToolDeps): Tool {
  const store = new ChangeRecordsStore(deps.db);
  const tool: Tool<Input, Output> = {
    name: 'list_changes_for_review',
    description:
      "Read Beatrice's change records with their full embedded diffs, rationale, check results, and your recorded verdict. Default lists changes awaiting your skeptic review (pending_kate_review) — review the diff here, then call review_change to rule. For CONVERSATIONAL review — the owner asks about a change, wants a walkthrough, or is deciding a merge card — pass change_id to fetch that one change at ANY status, or status:'pending_owner_merge' to see what's sitting in his merge queue. You don't need repo access; everything to discuss the change is in diff_summary + rationale_md (delegate to the critic for repo-verified questions).",
    risk: 'read',
    required_capabilities: ['review_beatrice_change'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key: (i) =>
      `list_changes_for_review:${i.change_id ?? ''}:${i.status}:${i.limit}`,

    async execute(input, _ctx: ToolContext): Promise<Output> {
      const to_view = (r: NonNullable<ReturnType<typeof store.get>>) => ({
        change_id: r.id,
        status: r.status,
        origin: r.origin,
        change_kind: r.change_kind,
        target_specialist_id: r.target_specialist_id,
        branch: r.branch,
        pr_url: r.pr_url,
        lines_added: r.lines_added,
        lines_removed: r.lines_removed,
        languages: r.languages,
        files: r.files,
        diff_truncated: r.diff_truncated,
        diff_summary: r.diff_summary,
        rationale_md: r.rationale_md,
        checks_passed: r.checks_passed,
        checks_summary: r.checks_summary,
        kate_verdict: r.kate_verdict,
        kate_reasons_md: r.kate_reasons_md,
      });
      if (input.change_id) {
        const row = store.get(input.change_id);
        return { count: row ? 1 : 0, changes: row ? [to_view(row)] : [] };
      }
      const rows = store.list({
        ...(input.status === 'any' ? {} : { status: input.status as ChangeStatus }),
        limit: input.limit,
      });
      return { count: rows.length, changes: rows.map(to_view) };
    },
  };
  return tool as Tool;
}
