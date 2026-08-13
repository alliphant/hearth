/**
 * list_research_investigations — Kate's read of the deep-research jobs she
 * has running or finished for the current user (2026-06-19).
 *
 * Lets her answer "how's that research going?" and surface a finished
 * dossier. Cordon-respecting: a caller sees only their own investigations
 * (the owner has NO god-view of a household member's). Read-only.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { Caller } from '@memory/private_to';
import { coverage_summary_line } from '@core/research_coverage';
import { ResearchInvestigationStore } from '@memory/stores/research_investigations';
import {
  investigation_runner_deps_from,
  type InvestigationRunnerDeps,
} from '../research_investigation_runner';

const InputSchema = z.object({
  include_done: z
    .boolean()
    .default(true)
    .describe('Include finished/failed investigations (default true). False = only in-flight.'),
  limit: z.number().int().min(1).max(50).default(15),
});

const ItemSchema = z.object({
  investigation_id: z.string(),
  subject: z.string(),
  subject_kind: z.string(),
  status: z.string(),
  sub_questions: z.number(),
  findings: z.number(),
  dossier_ready: z.boolean(),
  /** "4 of 6 facet(s) answered (1 not attempted)" — so "how's it going" can be
   *  answered with coverage, not just a status word. */
  coverage: z.string().optional(),
  created_at: z.string(),
});

const OutputSchema = z.object({
  investigations: z.array(ItemSchema),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const OPEN = new Set([
  'pending',
  'planning',
  'investigating',
  'verifying',
  'synthesizing',
  // A partial dossier whose unattempted facets are still being retried is
  // in-flight, not finished (v2 phase 2).
  'incomplete',
]);

export function make_list_research_investigations(
  deps: InvestigationRunnerDeps,
): Tool<Input, Output> {
  return {
    name: 'list_research_investigations',
    description:
      'List the deep-research investigations you have running or finished for this user — subject, status, and whether the dossier is ready. Use it to answer "how\'s that research going?" before reading one back with get_research_investigation.',
    risk: 'read',
    required_capabilities: ['deep_research'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `list_research_investigations:${input.include_done}:${input.limit}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const store = new ResearchInvestigationStore(deps.library_deps.db);
      const caller: Caller = { user_id: ctx.user?.id, tier: ctx.user?.tier ?? 'friend' };
      const rows = store
        .list_for_user(caller, { limit: input.limit })
        .filter((r) => (input.include_done ? true : OPEN.has(r.status)))
        .slice(0, input.limit);
      return {
        investigations: rows.map((r) => ({
          investigation_id: r.id,
          subject: r.subject,
          subject_kind: r.subject_kind,
          status: r.status,
          sub_questions: r.plan?.sub_questions.length ?? 0,
          findings: r.findings.reduce((n, f) => n + f.findings.length, 0),
          dossier_ready: r.status === 'done' && r.dossier_md !== null,
          ...(r.coverage && r.coverage.facets.length > 0
            ? { coverage: coverage_summary_line(r.coverage) }
            : {}),
          created_at: r.created_at,
        })),
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_list_research_investigations(investigation_runner_deps_from(deps)) as Tool;
}
