/**
 * scan_good_followups — Kate's reactive followup on the EDGE of a good's
 * lifecycle (Phase 1d, 2026-06-20).
 *
 * The probe-path twin of scan_system_health: a deterministic background job
 * (no LLM) that date-scans the Household Knowledge Graph for goods whose RETURN
 * window or WARRANTY is closing, and — on the edge (once per good+kind) — files
 * an `action_proposal` so Kate ACTS: "the return window for X closes Sat — want
 * me to start a return / remind you?". The proposal is the action; the owner's
 * tap (the draft→tap→PIN floor) is the gate, and deciding it accrues Trust-
 * Ladder XP. Each proposal is scoped to its good's OWN cordon (a household good
 * → the owner; a member's personal good → that member; the owner has no
 * god-view).
 *
 * Edge detection = `exists_for_signature` (surface a good+kind ONCE, not every
 * daily run). DARK behind HEARTH_HOUSEHOLD_GRAPH. NOT on Kate's LLM surfaces —
 * the background_jobs runner invokes it by name; manual catch-up via
 * POST /api/specialists/kate/fire_background_job?name=good_followups.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { MemoryClient } from '@memory/client';
import type { ProposalsStore } from '@core/proposals';
import { household_graph_enabled } from '@core/household_knowledge/driver';

const InputSchema = z.object({
  /** Lookback horizon in days (return/warranty closing within N). */
  within_days: z.number().int().positive().max(120).default(14),
});
const OutputSchema = z.object({
  enabled: z.boolean(),
  due: z.number(),
  filed: z.number(),
  proposal_ids: z.array(z.string()),
});
type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/** household/owner goods → owner-global proposal (null); a member's good → that member. */
function cordon_user(private_to: string | null): string | null {
  if (!private_to || private_to === 'household' || private_to === 'owner') return null;
  return private_to;
}

export interface ScanGoodFollowupsDeps {
  memory: MemoryClient;
  proposals: ProposalsStore;
}

export function make_scan_good_followups(deps: ScanGoodFollowupsDeps): Tool<Input, Output> {
  return {
    name: 'scan_good_followups',
    description:
      'Scan household goods for closing return windows / expiring warranties and, on the edge (once per good), file a followup action_proposal so Kate offers to act. Background job; not a chat tool.',
    risk: 'write_internal',
    required_capabilities: ['monitor_household_goods'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,

    idempotency_key() {
      return `scan_good_followups:${Math.floor(Date.now() / 60_000)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      if (!household_graph_enabled()) {
        return { enabled: false, due: 0, filed: 0, proposal_ids: [] };
      }
      const due = deps.memory.goods_needing_followup(input.within_days, ctx.now);
      const proposal_ids: string[] = [];

      for (const { good, kind, due_date } of due) {
        const signature = {
          specialist_id: 'kate',
          kind: 'action_proposal',
          category: 'good_followup',
          anchor: `${good.id}:${kind}`,
        };
        // Edge: surface a given good+kind ONCE (not on every daily run).
        if (deps.proposals.exists_for_signature(signature)) continue;

        const is_return = kind === 'return_window';
        const verb = is_return
          ? `The return window for **${good.name}** closes ${due_date}`
          : `The warranty on **${good.name}** ends ${due_date}`;
        const offer = is_return
          ? `Want me to start a return or set a reminder?`
          : `Want me to file the warranty details or note it before it lapses?`;

        try {
          const pid = deps.proposals.create({
            specialist_id: 'kate',
            kind: 'action_proposal',
            user_id: cordon_user(good.private_to),
            execution_kind: 'none',
            payload: {
              followup_kind: kind,
              good_id: good.id,
              good_name: good.name,
              merchant: good.merchant,
              note_path: good.note_path,
              due_date,
              verb: 'review',
            },
            rationale: `${verb}${good.merchant ? ` (from ${good.merchant})` : ''}. ${offer}`,
            signature,
          });
          proposal_ids.push(pid);
        } catch {
          /* fail-open — one bad good never aborts the sweep */
        }
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kate',
        tool_name: 'good_followups_scan',
        tool_input: { within_days: input.within_days },
        execution_result: { due: due.length, filed: proposal_ids.length },
      });

      return { enabled: true, due: due.length, filed: proposal_ids.length, proposal_ids };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_scan_good_followups({ memory: deps.memory, proposals: deps.proposals }) as Tool;
}
