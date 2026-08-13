/**
 * list_research_commissions — status read over Cordelia's deep-research
 * commissions (2026-06-11).
 *
 * The chat/deliberation companion to commission_research: "how's the
 * bike-repair repository coming?" reads here. Volatile because a
 * detached runner advances commissions WHILE a turn is open — a
 * re-check must re-read, not re-serve the per-turn duplicate cache.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { Database } from 'bun:sqlite';
import {
  ResearchCommissionStore,
  OPEN_STATUSES,
} from '@memory/stores/research_commissions';

const InputSchema = z.object({
  status: z
    .enum(['open', 'done', 'all'])
    .default('open')
    .describe("Filter: 'open' = still running (default), 'done' = completed, 'all' = everything recent."),
  limit: z.number().int().min(1).max(20).default(5),
});

const CommissionSummarySchema = z.object({
  commission_id: z.string(),
  title: z.string(),
  target_specialist_id: z.string(),
  status: z.string(),
  depth: z.string(),
  shelved: z.number(),
  proposed: z.number(),
  skipped: z.number(),
  subtopics_total: z.number(),
  subtopics_done: z.number(),
  index_note_path: z.string().nullable(),
  error: z.string().nullable(),
  recent_log: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
});

const OutputSchema = z.object({
  commissions: z.array(CommissionSummarySchema),
  open_count: z.number(),
  /** Set when there is nothing to report — the grounded reply to give. */
  next_action: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_list_research_commissions(db: Database): Tool<Input, Output> {
  return {
    name: 'list_research_commissions',
    description:
      "Read the research-commission ledger: open (running) commissions with per-subtopic progress, shelved/proposed/skipped counts, the latest progress log lines, and — once done — the repository-guide note path. Use when the user asks how a commissioned repository build is coming, or during deliberation to decide whether an open commission needs another advance before filing a new one.",
    risk: 'read',
    required_capabilities: ['run_research_commissions'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,

    idempotency_key(input) {
      return `list_research_commissions:${input.status}:${input.limit}`;
    },

    async execute(input, _ctx: ToolContext): Promise<Output> {
      const store = new ResearchCommissionStore(db);
      const rows =
        input.status === 'open'
          ? store.list({ statuses: OPEN_STATUSES, limit: input.limit })
          : input.status === 'done'
            ? store.list({ statuses: ['done'], limit: input.limit })
            : store.list({ limit: input.limit });
      const open_count = store.list({ statuses: OPEN_STATUSES, limit: 100 }).length;
      const commissions = rows.map((row) => ({
        commission_id: row.id,
        title: row.title,
        target_specialist_id: row.target_specialist_id,
        status: row.status,
        depth: row.depth,
        shelved: row.shelved.length,
        proposed: row.proposed.length,
        skipped: row.skipped.length,
        subtopics_total: row.plan?.subtopics.length ?? 0,
        subtopics_done: Math.min(
          row.state.subtopic_cursor ?? 0,
          row.plan?.subtopics.length ?? 0,
        ),
        index_note_path: row.index_note_path,
        error: row.error,
        recent_log: (row.state.log ?? []).slice(-5),
        created_at: row.created_at,
        updated_at: row.updated_at,
      }));
      return {
        commissions,
        open_count,
        ...(commissions.length === 0
          ? {
              next_action:
                input.status === 'open'
                  ? 'No commissions are running — nothing in flight to report. File one with commission_research if the user asked for a repository build.'
                  : 'No commissions match this filter.',
            }
          : {}),
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_list_research_commissions(deps.db) as Tool;
}
