/**
 * read_proposal_by_id — read ONE proposal's full stored record by id.
 *
 * Lands the spec at Knowledge/Trainer/binding-proposals/read-proposal-by-id.md
 * (2026-08-11, directed-build postmortem). The execution blocker it closes:
 * when an approved proposal needs implementing, the specialist doing the work
 * could not read it back — `read_my_proposals` scopes to the CALLER's own
 * non-terminal rows, the audit log truncates payloads to previews, and
 * `program_dashboard` truncates its approval queue — so builds burned rounds
 * hunting for a record no tool could reach (the Ruby persona-tuning
 * re-authoring, and every stock directed build on 2026-08-10/11). The
 * directed-build instruction now inlines the payload; this tool is the general
 * read — any visible proposal, any status, full fields.
 *
 * Visibility: owner-global rows (`user_id` NULL — recommendations, binding
 * proposals, persona tunings, self-improvement) are readable by any holder of
 * `read_proposals`. A user-cordoned row (`user_id` set) is readable only by
 * its authoring specialist — the same cordon the proposal surfaces enforce.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { ProposalsStore } from '@core/proposals';

const InputSchema = z.object({
  proposal_id: z.string().min(1).describe('The proposal id, e.g. from an approval flag or a directed-build instruction.'),
});

const OutputSchema = z.object({
  proposal_id: z.string(),
  kind: z.string(),
  status: z.string(),
  specialist_id: z.string(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  /** Parsed payload when it parses; the raw JSON string otherwise. */
  payload: z.unknown(),
  rationale_md: z.string(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
  executed_at: z.string().nullable(),
  execution_result: z.unknown().nullable(),
  user_feedback: z.string().nullable(),
  superseded_by: z.string().nullable(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function make_read_proposal_by_id(proposals: ProposalsStore): Tool<Input, Output> {
  return {
    name: 'read_proposal_by_id',
    description:
      'Read one proposal record by id — full payload, rationale, status, decision/execution timestamps, and execution result, regardless of status (approved/acknowledged/executed rows included). Use when implementing or auditing an approved proposal whose id you hold: read_my_proposals only shows your own open rows, and audit-log previews truncate. User-cordoned proposals are readable only by their author.',
    risk: 'read',
    required_capabilities: ['read_proposals'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `read_proposal_by_id:${input.proposal_id}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const row = proposals.get(input.proposal_id);
      if (!row) {
        throw new Error(
          `Proposal ${input.proposal_id} not found. Check the id — approval flags and ` +
            `directed-build instructions carry it verbatim.`,
        );
      }
      // Per-user cordon: a user-scoped proposal is its author's business only.
      if (row.user_id && ctx.specialist_id && row.specialist_id !== ctx.specialist_id) {
        throw new Error(
          `Proposal ${input.proposal_id} is user-cordoned to its author (${row.specialist_id}) — ` +
            `not readable from here. If you need its content, consult that specialist.`,
        );
      }
      let payload: unknown = row.payload_json;
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        /* raw string stands */
      }
      let execution_result: unknown = row.execution_result_json;
      if (row.execution_result_json) {
        try {
          execution_result = JSON.parse(row.execution_result_json);
        } catch {
          /* raw string stands */
        }
      }
      return {
        proposal_id: row.id,
        kind: row.kind,
        status: row.status,
        specialist_id: row.specialist_id,
        title: row.title,
        summary: row.summary,
        payload,
        rationale_md: row.rationale_md,
        created_at: row.ts_created,
        decided_at: row.ts_decided,
        executed_at: row.ts_executed,
        execution_result: execution_result ?? null,
        user_feedback: row.user_feedback,
        superseded_by: row.superseded_by,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_read_proposal_by_id(deps.proposals) as Tool;
}
