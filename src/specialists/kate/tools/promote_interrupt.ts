import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { InterruptStore } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';
import { promote_interrupt } from '@core/interrupts';

const InputSchema = z.object({
  interrupt_id: z.string(),
  rationale: z.string().min(1),
});

const OutputSchema = z.object({
  promoted_interrupt_id: z.string().nullable(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_promote_interrupt(
  interrupts: InterruptStore,
  events: AppEventBus | undefined,
): Tool<Input, Output> {
  return {
    name: 'promote_interrupt',
    description:
      "Kate-only: re-raise an inbox-routed interrupt to the user. Use sparingly — most interrupts to Kate should be absorbed. Promotion creates an audit-trailed 'this matters' record with your rationale.",
    risk: 'write_internal',
    required_capabilities: ['write_proposals'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `promote_interrupt:${input.interrupt_id}`;
    },

    async execute(input, ctx: ToolContext) {
      const id = promote_interrupt({
        interrupts,
        source_id: input.interrupt_id,
        rationale: input.rationale,
        memory: ctx.memory,
        events,
      });
      return { promoted_interrupt_id: id };
    },
  };
}
