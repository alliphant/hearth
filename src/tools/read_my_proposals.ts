/**
 * read_my_proposals — let a specialist read back the FULL content of
 * proposals they themselves filed (2026-07-17).
 *
 * Before this tool, a specialist's only view of their own filings was
 * the truncated `tool_input_preview` in the audit log. Observed
 * 2026-07-17 in Mariah's chat: asked to read back a memory note she'd
 * proposed minutes earlier, she reconstructed it from the audit
 * preview, presented the guess as verbatim text, and had to walk it
 * back ("I was hallucinating that it was already there"). A specialist
 * that can file a proposal must be able to re-read it.
 *
 * Scope is hard: the query pins `specialist_id` to the caller from
 * ctx.specialist_id — there is no way to read another specialist's
 * filings through this tool (cross-specialist visibility remains
 * `query_audit_log`, gated on `read_audit_log`). Because the caller
 * authored everything returned, no capability token is needed.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { ProposalStatus } from '@core/proposals';

const STATUSES = [
  'pending',
  'approved',
  'denied',
  'snoozed',
  'executed',
  'failed',
  'expired',
  'graduated',
  'acknowledged',
  'superseded',
  'pending_kate_review',
] as const;

const InputSchema = z.object({
  /** Filter to one lifecycle status. Omit for all (incl. superseded). */
  status: z.enum(STATUSES).optional(),
  /** Read one specific proposal by id (from a prior filing or list). */
  proposal_id: z.string().min(1).max(40).optional(),
  /** Newest first. Default 5, max 25. */
  limit: z.coerce.number().int().positive().max(25).default(5),
});

const Row = z.object({
  id: z.string(),
  ts_created: z.string(),
  status: z.string(),
  kind: z.string(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  rationale_md: z.string(),
  /** Full payload JSON (the action spec / body you filed), truncated
   *  at 12k chars for very large payloads. */
  payload_json: z.string(),
  execution_result_json: z.string().nullable(),
  user_feedback: z.string().nullable(),
  superseded_by: z.string().nullable(),
});

const OutputSchema = z.object({
  rows: z.array(Row),
  total_returned: z.number(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const PAYLOAD_CAP = 12_000;

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'read_my_proposals',
    description:
      "Read back the FULL content of proposals YOU filed — payload, rationale, status, decision feedback — instead of guessing from audit-log previews. Use it to (a) quote your own filing verbatim when the user asks what you proposed, (b) check whether something you filed was approved/denied/superseded before filing again, (c) learn from user_feedback on past decisions. Filters: proposal_id (one specific filing), status ('pending'|'approved'|'denied'|'executed'|'failed'|'acknowledged'|'superseded'|...), limit (default 5, max 25, newest first). Only ever returns proposals you authored.",
    risk: 'read',
    required_capabilities: [],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(JSON.stringify(input));
      return `read_my_proposals:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      // Hard scope: pin specialist_id from ctx. No specialist context
      // (dispatch/smoke) → silent empty, mirroring read_inbox.
      const sid = ctx.specialist_id;
      if (!sid) {
        return { rows: [], total_returned: 0 };
      }

      const listed = deps.proposals.list({
        specialist_id: sid,
        status: input.status as ProposalStatus | undefined,
        // Own-history view: superseded + holding states are exactly
        // what a re-filing specialist needs to see, so don't apply
        // the owner-queue default hiding.
        include_superseded: true,
        limit: input.proposal_id ? 100 : input.limit,
      });
      const rows = (
        input.proposal_id
          ? listed.filter((p) => p.id === input.proposal_id)
          : listed
      )
        .slice(0, input.limit)
        .map((p) => ({
          id: p.id,
          ts_created: p.ts_created,
          status: p.status as string,
          kind: p.kind as string,
          title: p.title,
          summary: p.summary,
          rationale_md: p.rationale_md,
          payload_json:
            p.payload_json.length > PAYLOAD_CAP
              ? p.payload_json.slice(0, PAYLOAD_CAP) +
                `\n[...truncated at ${PAYLOAD_CAP} chars]`
              : p.payload_json,
          execution_result_json: p.execution_result_json,
          user_feedback: p.user_feedback,
          superseded_by: p.superseded_by,
        }));

      ctx.memory.log_action({
        intent_id: ctx.intent_id || ulid(),
        agent: sid,
        user_id: ctx.user?.id,
        tool_name: 'read_my_proposals',
        tool_input: {
          status: input.status,
          proposal_id: input.proposal_id,
          limit: input.limit,
        },
        execution_result: { returned: rows.length },
      });

      return { rows, total_returned: rows.length };
    },
  };
}
