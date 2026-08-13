/**
 * advance_research_investigations — the sweep that finishes deep-research
 * investigations the detached kick couldn't (2026-06-19).
 *
 * Runs as Kate's nightly background job: walks OPEN investigations
 * oldest-first and advances each in bounded slices until it closes or
 * stops progressing (search/fetch backend down, deep tier saturated). This
 * is the crash-recovery + retry path — the interactive path is the detached
 * run deep_research kicks at filing time.
 *
 * Deliberately NOT on Kate's LLM tool surfaces (the job is the intended
 * trigger; manual catch-up goes through
 * POST /api/specialists/kate/fire_background_job?name=research_investigation_sweep).
 * Volatile: the result depends on store + remote state the run itself
 * mutates.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  ResearchInvestigationStore,
  OPEN_INVESTIGATION_STATUSES,
  type InvestigationStatus,
} from '@memory/stores/research_investigations';
import {
  advance_investigation_chained,
  deep_research_enabled,
  investigation_runner_deps_from,
  type InvestigationRunnerDeps,
} from '../research_investigation_runner';

/** Slices per investigation per sweep — generous enough to close one,
 *  bounded so one stuck job can't eat the night. */
const MAX_SLICES_PER_SWEEP = 6;

const InputSchema = z.object({
  max_investigations: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(2)
    .describe('Open investigations advanced per sweep, oldest first.'),
});

const AdvancedSchema = z.object({
  investigation_id: z.string(),
  subject: z.string(),
  status: z.string(),
  progressed: z.boolean(),
  error: z.string().optional(),
});

const OutputSchema = z.object({
  enabled: z.boolean(),
  advanced: z.array(AdvancedSchema),
  open_remaining: z.number(),
  skipped_reason: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_advance_research_investigations(
  deps: InvestigationRunnerDeps,
): Tool<Input, Output> {
  return {
    name: 'advance_research_investigations',
    description:
      'Advance the open deep-research investigations (oldest first): each gets bounded runner slices until it completes or stops progressing. The nightly background job is the intended caller — invoke manually only for a catch-up after an outage. Filing new investigations is deep_research; reading status is list_research_investigations.',
    risk: 'write_internal',
    required_capabilities: ['deep_research'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,

    idempotency_key(input) {
      return `advance_research_investigations:${input.max_investigations}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const store = new ResearchInvestigationStore(deps.library_deps.db);
      if (!deep_research_enabled()) {
        return {
          enabled: false,
          advanced: [],
          open_remaining: store.list({ statuses: OPEN_INVESTIGATION_STATUSES, limit: 200 }).length,
          skipped_reason: 'HEARTH_DEEP_RESEARCH=0 — runner disabled by kill switch',
        };
      }
      const open = store.list({ statuses: OPEN_INVESTIGATION_STATUSES, limit: 200 });
      const batch = open.slice(0, input.max_investigations);
      const advanced: z.infer<typeof AdvancedSchema>[] = [];
      for (const row of batch) {
        let status: InvestigationStatus | 'missing' = row.status;
        let progressed = false;
        let error: string | undefined;
        for (let i = 0; i < MAX_SLICES_PER_SWEEP; i++) {
          const res = await advance_investigation_chained(deps, ctx, row.id);
          status = res.status;
          progressed = res.progressed;
          error = res.error;
          if (!OPEN_INVESTIGATION_STATUSES.includes(res.status as InvestigationStatus)) break;
          if (!res.progressed) break;
        }
        advanced.push({
          investigation_id: row.id,
          subject: row.subject,
          status: String(status),
          progressed,
          ...(error ? { error } : {}),
        });
      }
      return {
        enabled: true,
        advanced,
        open_remaining: store.list({ statuses: OPEN_INVESTIGATION_STATUSES, limit: 200 }).length,
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_advance_research_investigations(investigation_runner_deps_from(deps)) as Tool;
}
