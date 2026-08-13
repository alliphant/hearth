/**
 * review_trainer_proposal + list_proposals_for_review — Kate's pre-review gate
 * for Beatrice's self-improvement SPEC proposals (2026-06-15).
 *
 * The sibling of the code-change gate (`review_change`). Beatrice's authored
 * specs — `binding_proposal` / `persona_tuning` / `recommendation` — are born
 * `pending_kate_review` (hidden from the owner queue; see
 * proposals.ts KATE_REVIEW_KINDS). Kate reads them via
 * `list_proposals_for_review`, then rules:
 *   - promote   → the spec advances to `pending` and becomes owner-visible.
 *                 Only the OWNER then decides it; promotion is necessary, not
 *                 sufficient. Kate is the critic + final reviewer before him.
 *   - send_back → the spec returns to Beatrice with Kate's reasons (inbox flag);
 *                 status → `denied` WITHOUT touching the autonomy signature.
 *                 Beatrice revises and re-files (a fresh pending_kate_review).
 *
 * This keeps process-miss work INSIDE the loop: Mariah drives the miss →
 * Beatrice authors the fix → Kate vets it → the owner sees only the vetted set.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { ProposalsStore } from '@core/proposals';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';
import { append_to_memory } from '@core/memory_files';

// ── list_proposals_for_review ────────────────────────────────────────────────

const ListInputSchema = z.object({}).strict();
const ListOutputSchema = z.object({
  proposals: z.array(
    z.object({
      proposal_id: z.string(),
      kind: z.string(),
      title: z.string().nullable(),
      summary: z.string().nullable(),
      rationale_md: z.string(),
      ts_created: z.string(),
    }),
  ),
  count: z.number(),
});
type ListInput = z.infer<typeof ListInputSchema>;
type ListOutput = z.infer<typeof ListOutputSchema>;

export function make_list_proposals_for_review(
  proposals: ProposalsStore,
): Tool<ListInput, ListOutput> {
  return {
    name: 'list_proposals_for_review',
    description:
      "List Beatrice's self-improvement proposals awaiting YOUR review (binding_proposal / persona_tuning / recommendation). Each is held back from Jasper's queue until you promote it. Read the rationale, then call review_trainer_proposal to promote (he sees it) or send it back to Beatrice. Returns [] when the review queue is empty.",
    risk: 'read',
    required_capabilities: ['review_beatrice_change'],
    input_schema: ListInputSchema,
    output_schema: ListOutputSchema,
    // The review queue mutates as Kate promotes/sends-back within the turn —
    // a re-call must recompute, not serve the per-turn duplicate-call cache.
    volatile: true,
    idempotency_key: () => 'list_proposals_for_review',
    async execute(): Promise<ListOutput> {
      const rows = proposals.list_for_kate_review();
      return {
        proposals: rows.map((p) => ({
          proposal_id: p.id,
          kind: p.kind,
          title: p.title,
          summary: p.summary,
          rationale_md: p.rationale_md,
          ts_created: p.ts_created,
        })),
        count: rows.length,
      };
    },
  };
}

// ── review_trainer_proposal ──────────────────────────────────────────────────

const ReviewInputSchema = z.object({
  proposal_id: z.string().min(1),
  verdict: z.enum(['promote', 'send_back']),
  reasons_md: z
    .string()
    .min(20)
    .max(2000)
    .describe(
      'Your skeptic justification — what you verified and why it is (or is not) worth Jasper\'s attention. On send_back, exactly what Beatrice should change. A bare "looks fine" is not a review.',
    ),
});
const ReviewOutputSchema = z.object({
  proposal_id: z.string(),
  new_status: z.string(),
  routed_to: z.enum(['owner', 'trainer', 'none']),
  reason: z.string().optional(),
});
type ReviewInput = z.infer<typeof ReviewInputSchema>;
type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

interface ReviewDeps {
  proposals: ProposalsStore;
  inbox: SpecialistInbox;
  events: AppEventBus;
}

export function make_review_trainer_proposal(
  deps: ReviewDeps,
): Tool<ReviewInput, ReviewOutput> {
  return {
    name: 'review_trainer_proposal',
    description:
      "Record your verdict on one of Beatrice's pending self-improvement specs. promote → it advances to Jasper's queue (he decides). send_back → it returns to Beatrice with your reasons; she revises and re-files. Be a skeptic: promote only what genuinely needs Jasper's decision and is justified by the rationale; send back the rest. Your promotion is required but never auto-applies — only Jasper decides the action.",
    risk: 'write_internal',
    required_capabilities: ['review_beatrice_change'],
    input_schema: ReviewInputSchema,
    output_schema: ReviewOutputSchema,
    idempotency_key: (i) => `review_trainer_proposal:${i.proposal_id}:${i.verdict}`,
    async execute(input, ctx: ToolContext): Promise<ReviewOutput> {
      const p = deps.proposals.get(input.proposal_id);
      if (!p) {
        return {
          proposal_id: input.proposal_id,
          new_status: '',
          routed_to: 'none',
          reason: `no proposal ${input.proposal_id}`,
        };
      }
      if (p.status !== 'pending_kate_review') {
        return {
          proposal_id: p.id,
          new_status: p.status,
          routed_to: 'none',
          reason: `proposal is already '${p.status}' — nothing to review`,
        };
      }

      if (input.verdict === 'promote') {
        const ok = deps.proposals.promote_after_kate_review(p.id);
        if (!ok) {
          const cur = deps.proposals.get(p.id);
          return {
            proposal_id: p.id,
            new_status: cur?.status ?? '',
            routed_to: 'none',
            reason: 'proposal was already reviewed (no longer pending review)',
          };
        }
        ctx.memory.log_action({
          intent_id: ctx.intent_id,
          agent: ctx.specialist_id ?? 'kate',
          tool_name: 'review_trainer_proposal',
          tool_input: { proposal_id: p.id, verdict: 'promote' },
          execution_result: { new_status: 'pending', routed_to: 'owner' },
        });
        return { proposal_id: p.id, new_status: 'pending', routed_to: 'owner' };
      }

      // send_back
      const ok = deps.proposals.return_after_kate_review(p.id, input.reasons_md);
      if (!ok) {
        const cur = deps.proposals.get(p.id);
        return {
          proposal_id: p.id,
          new_status: cur?.status ?? '',
          routed_to: 'none',
          reason: 'proposal was already reviewed (no longer pending review)',
        };
      }

      // Beatrice's training data: a send-back lands as a BUILD LESSON in
      // trainer's memory.md (the deliberation builder injects its tail), so
      // her next attempt sees what Kate rejected last time. Best-effort.
      try {
        append_to_memory(
          ctx.memory,
          'trainer',
          `BUILD LESSON (sent back by Kate, proposal \`${p.id}\`, ${p.kind}): ` +
            input.reasons_md.slice(0, 600),
          'kate review',
        );
      } catch {
        /* lesson capture is opportunistic */
      }

      const body_md =
        `**Kate sent your ${p.kind} back** \`${p.id}\`` +
        (p.title ? `: "${p.title}".` : '.') +
        ' Revise per the reasons below and re-file — the same approach supersedes this one.\n\n' +
        `**Reasons:**\n${input.reasons_md}`;
      const inbox_id = deps.inbox.push({
        from_specialist_id: 'kate',
        to_specialist_id: 'trainer',
        kind: 'flag',
        body_md,
        related_proposal_id: p.id,
      });
      deps.events.emit({
        type: 'inbox_message_added',
        message_id: inbox_id,
        from_specialist_id: 'kate',
        to_specialist_id: 'trainer',
        kind: 'flag',
        severity: 'high',
      });
      ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kate',
        tool_name: 'review_trainer_proposal',
        tool_input: { proposal_id: p.id, verdict: 'send_back' },
        execution_result: { new_status: 'denied', routed_to: 'trainer', inbox_id },
      });
      return { proposal_id: p.id, new_status: 'denied', routed_to: 'trainer' };
    },
  };
}

/** ToolLoader entry points. */
export function create(deps: ToolDeps): Tool[] {
  return [
    make_list_proposals_for_review(deps.proposals) as Tool,
    make_review_trainer_proposal({
      proposals: deps.proposals,
      inbox: deps.inbox,
      events: deps.events,
    }) as Tool,
  ];
}
