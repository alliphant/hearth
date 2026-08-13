/**
 * read_miss — read a process miss record by ID.
 *
 * The process_miss table is the single source of truth for miss lifecycle,
 * but only advance_process_miss and batch_advance_misses can act on it.
 * This tool lets specialists read the full stored fields for audit or
 * verification purposes.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { ProcessMissStore } from '@core/process_misses';

const InputSchema = z.object({
  miss_id: z.string().min(1),
});

const OutputSchema = z.object({
  miss_id: z.string(),
  status: z.enum(['open', 'routed', 'redo_dispatched', 'verified', 'closed', 'escalated']),
  subject_specialist_id: z.string(),
  task_summary: z.string(),
  gap: z.string(),
  severity: z.string(),
  evidence_ref: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  notes_md: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function make_read_miss(misses: ProcessMissStore): Tool<Input, Output> {
  return {
    name: 'read_miss',
    description:
      'Read a process miss record by ID. Returns the full stored fields including status, subject specialist, task summary, gap, severity, evidence reference, timestamps, and notes. Useful for auditing closed misses or verifying fix details.',
    risk: 'read',
    required_capabilities: ['read_process_miss'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    idempotency_key(input) {
      return `read_miss:${input.miss_id}`;
    },
    async execute(input, ctx: ToolContext): Promise<Output> {
      const miss = misses.get(input.miss_id);
      if (!miss) {
        throw new Error(`Miss ${input.miss_id} not found.`);
      }
      return {
        miss_id: miss.id,
        status: miss.status,
        subject_specialist_id: miss.subject_specialist_id,
        task_summary: miss.task_summary,
        gap: miss.gap,
        severity: miss.severity,
        evidence_ref: miss.evidence_ref,
        created_at: miss.ts_created,
        updated_at: miss.ts_updated,
        notes_md: miss.notes_md,
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_read_miss(deps.process_misses) as Tool;
}
