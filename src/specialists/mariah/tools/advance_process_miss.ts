/**
 * advance_process_miss — move a process miss through the closed loop.
 *
 * Mariah (or Kate) routes a miss, dispatches a redo, verifies it, closes
 * it, or escalates it. ProcessMissStore enforces which transitions are
 * legal; this tool adds the side effects — a redo dispatch drops a flag
 * in the subject specialist's inbox, an escalation flags Beatrice.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { apply_miss_action } from '@core/process_misses';
import type { ProcessMissStore } from '@core/process_misses';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';

const ActionEnum = z.enum([
  'route',
  'dispatch_redo',
  'verify',
  'close',
  'escalate',
]);

const InputSchema = z.object({
  miss_id: z.string().min(1),
  action: ActionEnum,
  note: z.string().min(1).max(2_000),
});

const OutputSchema = z.object({
  miss_id: z.string(),
  status: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function make_advance_process_miss(
  misses: ProcessMissStore,
  inbox: SpecialistInbox,
  events: AppEventBus | undefined,
): Tool<Input, Output> {
  return {
    name: 'advance_process_miss',
    description:
      "Move a process miss through the closed loop. `miss_id` is the pm_ id. `action` is one of: route (take it on for handling), dispatch_redo (send the subject specialist a redo request — drops a flag in their inbox), verify (the redo closed the gap), close (done), escalate (recurring — hand it to Beatrice for a structural fix, flags her inbox). `note` records why, in one or two sentences. Transitions must follow the lifecycle: open -> routed -> redo_dispatched -> verified -> closed; calling out of order returns an error. Call once per step with flat string args.",
    risk: 'write_internal',
    required_capabilities: ['write_process_miss'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `advance_process_miss:${input.miss_id}:${input.action}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const reporter = ctx.specialist_id ?? 'mariah';
      const after = apply_miss_action({
        misses,
        inbox,
        miss_id: input.miss_id,
        action: input.action,
        note: input.note,
        reporter,
        events,
      });
      return { miss_id: after.id, status: after.status };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_advance_process_miss(deps.process_misses, deps.inbox, deps.events) as Tool;
}
