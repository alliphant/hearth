import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { InterruptStore } from '@memory/stores/conversations';
import { acknowledge_interrupt } from '@core/interrupts';

const InputSchema = z.object({
  interrupt_id: z.string(),
  action_taken: z.string().min(1),
});

const OutputSchema = z.object({
  acknowledged: z.boolean(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_absorb_interrupt(
  interrupts: InterruptStore,
): Tool<Input, Output> {
  return {
    name: 'absorb_interrupt',
    description:
      "Kate-only: acknowledge an interrupt without escalating it to the user. action_taken describes what you did instead — drafted a proposal, flagged to another specialist, decided no action. Every absorption is auditable and informs your calibration over time.",
    risk: 'write_internal',
    required_capabilities: ['write_proposals'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `absorb_interrupt:${input.interrupt_id}`;
    },

    async execute(input, ctx: ToolContext) {
      const ok = acknowledge_interrupt({
        interrupts,
        id: input.interrupt_id,
        by: 'kate',
        memory: ctx.memory,
      });
      ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: 'kate',
        tool_name: 'absorb_interrupt_action',
        tool_input: { interrupt_id: input.interrupt_id, action_taken: input.action_taken },
        execution_result: { acknowledged: ok },
      });
      return { acknowledged: ok };
    },
  };
}
