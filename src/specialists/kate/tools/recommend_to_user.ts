import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ProposalsStore, ProposalAction, ProposalExecutionKind } from '@core/proposals';

const InputSchema = z.object({
  // The concern, in a few words — becomes the card's title.
  concern: z.string().min(3).max(160),
  // What you already TRIED before bringing this to the user. This is the
  // "I didn't just punt it" line — be specific ("had Brigid re-run it twice;
  // still failing"). Shown on the card under "What I tried".
  attempt: z.string().min(3).max(600),
  // Your recommendation, in your own first-person voice — what you think the
  // user should do and why. 1–4 sentences. Becomes the card's main text.
  recommendation: z.string().min(3).max(900),
  // The label for the primary action button — what tapping it does, in the
  // user's terms ("Loop in Beatrice", "Switch to last week's plan", "Approve").
  action_label: z.string().min(1).max(40).default('Do it'),
  // When the primary action is a concrete tool you should run on approval,
  // name it + its args here (e.g. flag_beatrice). The card's button then
  // EXECUTES it (as you) when the user approves — and the same call is what
  // graduates to autonomous once the user keeps approving this class. Omit
  // for a recommendation the user carries out themselves.
  dispatch_tool: z.string().optional(),
  dispatch_input: z.record(z.string(), z.unknown()).optional(),
  // Who raised this with you (the specialist id), if it came from a peer.
  source_specialist: z.string().max(40).optional(),
  // The originating inbox-flag / process-miss id, if any — provenance + the
  // dedup key so re-raising the same concern supersedes the older card.
  source_ref: z.string().max(80).optional(),
  // A short, STABLE slug for the class of concern (e.g. "meal_plan_stall",
  // "vet_bill_routing"). This anchors the autonomy signature, so the SAME
  // class of recommendation accumulates toward you handling it yourself.
  // Keep it coarse + reusable across instances; default derives from concern.
  concern_key: z.string().max(80).optional(),
  // High-stakes action (spends money / irreversible)? Forces a PIN step-up on
  // approval regardless of amount.
  requires_step_up: z.boolean().optional(),
});

const OutputSchema = z.object({ proposal_id: z.string() });

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'concern';
}

export function make_recommend_to_user(proposals: ProposalsStore): Tool<Input, Output> {
  return {
    name: 'recommend_to_user',
    description:
      "Escalate to the user a concern you couldn't resolve YOURSELF, with your recommendation. Use this during deliberation for the things you tried to handle but can't close without the user — a stuck peer, a decision only they can make, a spend you won't auto-approve. It files a card in the user's office (Kate's room): your `concern` as the title, what you already `tried`, your `recommendation` in your voice, and a primary action button labelled `action_label` (the card auto-adds 'Not now' and 'Dismiss', plus the user can ask you a question back inline). Provide a `concern_key` so the SAME class of recommendation trains your autonomy — keep approving it and you graduate to handling it without asking. If the action is a concrete tool, pass `dispatch_tool`/`dispatch_input` and approval runs it as you. Do NOT use this for things you already handled (those go in the brief's 'landed today') or routine FYIs — only genuine 'I need you' items.",
    risk: 'write_internal',
    required_capabilities: ['write_proposals'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.concern_key ?? input.source_ref ?? input.concern);
      return `recommend_to_user:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const has_dispatch =
        typeof input.dispatch_tool === 'string' && input.dispatch_tool.length > 0;

      // The card's buttons. The primary 'do_it' carries the user's chosen
      // label; 'Not now' (defer) and 'Dismiss' (reject) are always offered so
      // the user has a complete, honest set. compute_proposal_actions reads
      // these back from the payload at create time.
      const actions: ProposalAction[] = [
        {
          id: 'do_it',
          label: input.action_label,
          style: 'primary',
          effect: 'execute',
          ...(has_dispatch ? { description: `Runs ${input.dispatch_tool} on approval.` } : {}),
        },
        { id: 'later', label: 'Not now', style: 'secondary', effect: 'defer', description: 'Reappears tomorrow.' },
        { id: 'dismiss', label: 'Dismiss', style: 'destructive', effect: 'reject', description: 'Clear it — I’ll let it go.' },
      ];

      const concern_key = input.concern_key ?? input.source_ref ?? slugify(input.concern);

      const payload: Record<string, unknown> = {
        headline: input.concern,
        attempt_md: input.attempt,
        actions,
        concern_key,
        ...(input.source_specialist ? { source_specialist: input.source_specialist } : {}),
        ...(input.source_ref ? { source_ref: input.source_ref } : {}),
        ...(input.requires_step_up ? { requires_step_up: true } : {}),
        ...(has_dispatch
          ? { dispatch_tool: input.dispatch_tool, dispatch_input: input.dispatch_input ?? {} }
          : {}),
      };

      const id = proposals.create({
        specialist_id: 'kate',
        kind: 'recommendation',
        // create() forces user_id NULL for the system 'recommendation' kind
        // (owner-global), so this is a no-op — passed for symmetry.
        user_id: ctx.user?.id ?? null,
        execution_kind: (has_dispatch ? 'dispatch' : 'manual') as ProposalExecutionKind,
        payload,
        rationale: input.recommendation,
        signature: {
          specialist_id: 'kate',
          kind: 'recommendation',
          category: concern_key,
          ...(input.source_specialist ? { anchor: input.source_specialist } : {}),
        },
      });
      return { proposal_id: id };
    },
  };
}
