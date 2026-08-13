/**
 * advance_research_commissions — the sweep that finishes what the
 * detached kick couldn't (2026-06-11).
 *
 * Runs as Cordelia's nightly background job (03:20, before the 03:40
 * source refresh and her 04:00 deliberation): walks OPEN commissions
 * oldest-first and advances each in bounded slices until it closes or
 * stops progressing (search backend down, judge down with pending
 * candidates, browser deferred). This is the crash-recovery and retry
 * path — the interactive path is the detached run commission_research
 * kicks at filing time.
 *
 * Deliberately NOT on Cordelia's LLM tool surfaces (the job is the
 * intended trigger; manual catch-up goes through
 * POST /api/specialists/cordelia/fire_background_job?name=research_commission_sweep).
 * Volatile: the result depends on store + remote state the run itself
 * mutates.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  ResearchCommissionStore,
  OPEN_STATUSES,
  type CommissionStatus,
} from '@memory/stores/research_commissions';
import {
  advance_commission_chained,
  research_enabled,
  runner_deps_from,
  type ResearchRunnerDeps,
} from '../research_runner';

/** Slices per commission per sweep — generous enough to close a
 *  standard commission, bounded so one stuck job can't eat the night. */
const MAX_SLICES_PER_SWEEP = 6;

const InputSchema = z.object({
  max_commissions: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(2)
    .describe('Open commissions advanced per sweep, oldest first.'),
});

const AdvancedSchema = z.object({
  commission_id: z.string(),
  title: z.string(),
  status: z.string(),
  shelved_total: z.number(),
  proposed_total: z.number(),
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

export function make_advance_research_commissions(
  deps: ResearchRunnerDeps,
): Tool<Input, Output> {
  return {
    name: 'advance_research_commissions',
    description:
      'Advance the open research commissions (oldest first): each gets bounded runner slices until it completes or stops progressing. The nightly background job is the intended caller — invoke manually only for a catch-up after an outage. Filing new commissions is commission_research; reading status is list_research_commissions.',
    risk: 'write_internal',
    required_capabilities: ['run_research_commissions', 'write_vault_any_library', 'query_web'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,

    idempotency_key(input) {
      return `advance_research_commissions:${input.max_commissions}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const store = new ResearchCommissionStore(deps.library_deps.db);
      if (!research_enabled()) {
        return {
          enabled: false,
          advanced: [],
          open_remaining: store.list({ statuses: OPEN_STATUSES, limit: 100 }).length,
          skipped_reason:
            'HEARTH_RESEARCH_COMMISSIONS=0 — runner disabled by kill switch',
        };
      }
      const open = store.list({ statuses: OPEN_STATUSES, limit: 100 });
      const batch = open.slice(0, input.max_commissions);
      const advanced: z.infer<typeof AdvancedSchema>[] = [];
      for (const row of batch) {
        let last = {
          commission_id: row.id,
          status: row.status as CommissionStatus | 'missing',
          progressed: false,
          shelved_total: row.shelved.length,
          proposed_total: row.proposed.length,
          error: undefined as string | undefined,
        };
        for (let i = 0; i < MAX_SLICES_PER_SWEEP; i++) {
          const res = await advance_commission_chained(deps, ctx, row.id);
          last = { ...res, error: res.error };
          if (!OPEN_STATUSES.includes(res.status as CommissionStatus)) break;
          if (!res.progressed) break;
        }
        advanced.push({
          commission_id: row.id,
          title: row.title,
          status: String(last.status),
          shelved_total: last.shelved_total,
          proposed_total: last.proposed_total,
          progressed: last.progressed,
          ...(last.error ? { error: last.error } : {}),
        });
      }
      return {
        enabled: true,
        advanced,
        open_remaining: store.list({ statuses: OPEN_STATUSES, limit: 100 }).length,
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_advance_research_commissions(runner_deps_from(deps)) as Tool;
}
