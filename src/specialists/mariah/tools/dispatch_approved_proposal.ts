/**
 * dispatch_approved_proposal — execute an approved-but-stalled proposal.
 *
 * The proposal-decide route auto-runs `dispatch` proposals on approval.
 * But a proposal filed as `manual` (or filed before that path existed)
 * can be approved and then just sit — approved, `ts_executed` null,
 * nothing wired to run it. Mariah's `scan_program_health` now flags
 * those as process misses; this tool is how she (or Jasper, asking her)
 * actually pushes one through.
 *
 * It runs the named tool **as the proposal's owning specialist** — with
 * that specialist's capabilities, not Mariah's — so it can't escalate
 * privilege, and the proposal is already Jasper-approved, so approval is
 * the gate. Success/failure is recorded on the proposal via
 * `record_execution`, so a failed dispatch surfaces as a failed
 * proposal on the next health scan.
 */
import { z } from 'zod';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { ProposalsStore } from '@core/proposals';
import type { SpecialistRegistry } from '@core/specialist';
import type { ToolRegistry } from '@core/tool_registry';

const InputSchema = z.object({
  proposal_id: z
    .string()
    .min(1)
    .describe('Id of the approved proposal to execute.'),
  tool_name: z
    .string()
    .optional()
    .describe(
      'The tool to run. Omit only when the proposal payload already carries `dispatch_tool`.',
    ),
  tool_input: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Arguments for the tool, derived from the proposal. Omit only when the payload carries `dispatch_input`.',
    ),
});

const OutputSchema = z.object({
  proposal_id: z.string(),
  dispatched_tool: z.string(),
  ok: z.boolean(),
  proposal_status: z.string(),
  detail: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/**
 * Internal helper — the actual "run an approved proposal" mechanics,
 * factored out so callers like `scan_program_health` can auto-dispatch
 * without going through the LLM-facing tool wrapper. Records execution
 * on the proposal; returns a flat result.
 */
export interface DispatchProposalDeps {
  proposals: ProposalsStore;
  specialists: SpecialistRegistry;
  tool_registry: ToolRegistry;
  /** Carries memory + llm so the dispatched tool can audit + use the LLM. */
  ctx: Pick<ToolContext, 'memory' | 'llm'>;
}
export interface DispatchProposalResult {
  ok: boolean;
  proposal_id: string;
  dispatched_tool: string | null;
  detail: string;
}

export async function dispatch_proposal_now(
  proposal_id: string,
  deps: DispatchProposalDeps,
  override_tool_name?: string,
  override_tool_input?: Record<string, unknown>,
): Promise<DispatchProposalResult> {
  const p = deps.proposals.get(proposal_id);
  if (!p) {
    return {
      ok: false,
      proposal_id,
      dispatched_tool: null,
      detail: `no proposal with id "${proposal_id}"`,
    };
  }
  if (p.status !== 'approved') {
    return {
      ok: false,
      proposal_id: p.id,
      dispatched_tool: null,
      detail: `status is "${p.status}", not "approved"`,
    };
  }
  if (p.ts_executed) {
    return {
      ok: false,
      proposal_id: p.id,
      dispatched_tool: null,
      detail: `already executed at ${p.ts_executed}`,
    };
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(p.payload_json) as Record<string, unknown>;
  } catch {
    /* freeform / unreadable payload — rely on explicit args */
  }
  const tool_name =
    override_tool_name ??
    (typeof payload.dispatch_tool === 'string' ? payload.dispatch_tool : undefined);
  const tool_input: Record<string, unknown> =
    override_tool_input ??
    (payload.dispatch_input as Record<string, unknown> | undefined) ??
    {};
  if (!tool_name) {
    return {
      ok: false,
      proposal_id: p.id,
      dispatched_tool: null,
      detail:
        `no dispatch_tool in payload — proposal needs explicit tool_name + ` +
        `tool_input, or a re-file with dispatch_tool set`,
    };
  }

  const owner = deps.specialists.get(p.specialist_id);
  if (!owner) {
    return {
      ok: false,
      proposal_id: p.id,
      dispatched_tool: tool_name,
      detail: `owning specialist "${p.specialist_id}" is not loaded`,
    };
  }

  const intent_id = ulid();
  const inner_ctx: ToolContext = {
    memory: deps.ctx.memory,
    llm: deps.ctx.llm,
    now: new Date(),
    intent_id,
    specialist_id: owner.id,
  };
  const outcome = await deps.tool_registry.invoke(
    tool_name,
    tool_input,
    inner_ctx,
    owner.granted,
    owner.id,
  );

  if (outcome.ok) {
    deps.proposals.record_execution(p.id, outcome.result);
    return {
      ok: true,
      proposal_id: p.id,
      dispatched_tool: tool_name,
      detail: `ran \`${tool_name}\` as ${owner.id}; marked executed`,
    };
  }
  deps.proposals.record_execution(
    p.id,
    { error: outcome.error, reason: outcome.reason },
    outcome.error ?? 'dispatch failed',
  );
  return {
    ok: false,
    proposal_id: p.id,
    dispatched_tool: tool_name,
    detail: `\`${tool_name}\` failed (${outcome.reason ?? 'execute'}): ${outcome.error ?? 'unknown error'}`,
  };
}

function make_dispatch_approved_proposal(
  proposals: ProposalsStore,
  specialists: SpecialistRegistry,
  tool_registry: ToolRegistry,
): Tool<Input, Output> {
  return {
    name: 'dispatch_approved_proposal',
    description:
      "Execute a proposal that Jasper already approved but that was never run (status 'approved', never executed). Runs the proposal's action as its owning specialist — that specialist's capabilities, audited — and records the result on the proposal. Pass `proposal_id`; also pass `tool_name` and `tool_input` (the exact tool call, derived from the proposal's action) unless the proposal's payload already carries `dispatch_tool`/`dispatch_input`. Use this to clear a stalled approval flagged by scan_program_health.",
    risk: 'write_internal',
    required_capabilities: ['dispatch_proposal'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `dispatch_approved_proposal:${input.proposal_id}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      // Pre-flight: surface "not approved" / "already executed" / "no
      // proposal" as the LLM-facing tool errors they were before the
      // shared helper existed. The helper itself returns a flat result;
      // these throws keep the tool's contract.
      const p = proposals.get(input.proposal_id);
      if (!p) {
        throw new Error(`no proposal with id "${input.proposal_id}"`);
      }
      if (p.status !== 'approved') {
        throw new Error(
          `proposal ${p.id} is "${p.status}", not "approved" — only an ` +
            `approved proposal can be dispatched`,
        );
      }
      if (p.ts_executed) {
        throw new Error(
          `proposal ${p.id} was already executed at ${p.ts_executed}`,
        );
      }
      const result = await dispatch_proposal_now(
        input.proposal_id,
        {
          proposals,
          specialists,
          tool_registry,
          ctx: { memory: ctx.memory, llm: ctx.llm },
        },
        input.tool_name,
        input.tool_input,
      );
      if (!result.dispatched_tool && !result.ok) {
        // Preserve the original "missing dispatch_tool" exception so
        // callers see the same error shape as before.
        throw new Error(
          `proposal ${p.id} has no dispatch_tool in its payload — pass ` +
            `tool_name and tool_input explicitly, derived from the ` +
            `proposal's action (${snippet(p.rationale_md, 160)}).`,
        );
      }
      return {
        proposal_id: result.proposal_id,
        dispatched_tool: result.dispatched_tool ?? '',
        ok: result.ok,
        proposal_status: result.ok ? 'executed' : 'failed',
        detail: result.detail,
      };
    },
  };
}

function snippet(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_dispatch_approved_proposal(
    deps.proposals,
    deps.specialists,
    deps.tool_registry,
  ) as Tool;
}
