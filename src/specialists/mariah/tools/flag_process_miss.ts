/**
 * flag_process_miss — opens a process-miss record (Part B closed loop).
 *
 * Mariah (and Kate) call this when a specialist's work fell short of what
 * the program needed. Typed flat-string args, one per call — the shape
 * Qwen3.6 fills reliably (see propose_persona_tuning for the same
 * lesson). The miss enters the ledger at status 'open' for routing,
 * redo, and verification.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { ProcessMissStore } from '@core/process_misses';

const InputSchema = z.object({
  /** Lowercase id of the specialist whose work fell short. */
  subject_specialist_id: z.string().min(1).max(80),
  /** What the subject was supposed to do. */
  task_summary: z.string().min(1).max(2_000),
  /** What was missing or wrong. */
  gap: z.string().min(1).max(2_000),
  severity: z.enum(['low', 'medium', 'high']),
  /** Optional pointer to the work — a conversation id, proposal id, or note. */
  evidence_ref: z.string().min(1).max(500).optional(),
});

const OutputSchema = z.object({
  miss_id: z.string(),
  status: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function make_flag_process_miss(
  misses: ProcessMissStore,
): Tool<Input, Output> {
  return {
    name: 'flag_process_miss',
    description:
      "Open a process-miss record — log that a specialist's work fell short of what the program needed (a failed proposal, an undelivered follow-up, a re-asked consult). Call this ONCE per miss with flat string args, no nested objects. `subject_specialist_id` is the lowercase id of the specialist whose work missed (e.g. 'vivian'). `task_summary` is what they were supposed to do. `gap` is what was missing or wrong. `severity` is one of low | medium | high. `evidence_ref` (optional) points at the work — a conversation id, proposal id, or a short note. Returns the new miss id; it enters the closed loop at status 'open' for routing, redo, and verification.",
    risk: 'write_internal',
    required_capabilities: ['write_process_miss'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.subject_specialist_id);
      h.update('\n');
      h.update(input.task_summary);
      h.update('\n');
      h.update(input.gap);
      return `flag_process_miss:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const miss_id = misses.create({
        subject_specialist_id: input.subject_specialist_id,
        reporter: ctx.specialist_id ?? 'mariah',
        task_summary: input.task_summary,
        gap: input.gap,
        severity: input.severity,
        evidence_ref: input.evidence_ref,
      });
      return { miss_id, status: 'open' };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_flag_process_miss(deps.process_misses) as Tool;
}
