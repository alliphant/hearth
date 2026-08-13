import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ProposalsStore } from '@core/proposals';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { SpecialistRegistry } from '@core/specialist';

const InputSchema = z.object({
  specialist_id: z.string(),
  proposal_id: z.string(),
  note: z.string().optional(),
});

const OutputSchema = z.object({
  inbox_message_id: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_delegate_proposal(
  proposals: ProposalsStore,
  inbox: SpecialistInbox,
  specialists: SpecialistRegistry,
): Tool<Input, Output> {
  return {
    name: 'delegate_proposal',
    description:
      "Hand a proposal off to another specialist for their refinement or final decision. Sends them an inbox message referencing the proposal. The proposal's owning specialist remains in the row unless they explicitly reassign.",
    risk: 'write_internal',
    required_capabilities: ['write_proposals'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `delegate:${input.specialist_id}:${input.proposal_id}`;
    },

    async execute(input, _ctx: ToolContext) {
      const p = proposals.get(input.proposal_id);
      if (!p) throw new Error(`unknown proposal: ${input.proposal_id}`);
      if (!specialists.has(input.specialist_id)) {
        throw new Error(`unknown specialist: ${input.specialist_id}`);
      }

      const body =
        (input.note ? `${input.note}\n\n` : '') +
        `Delegated proposal **${p.id}** (${p.kind}). ` +
        `Original rationale: ${p.rationale_md}`;

      const id = inbox.push({
        from_specialist_id: 'kate',
        to_specialist_id: input.specialist_id,
        kind: 'flag',
        body_md: body,
        related_proposal_id: p.id,
      });
      return { inbox_message_id: id };
    },
  };
}
