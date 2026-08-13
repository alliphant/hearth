/**
 * review_change — Kate's skeptic verdict on one Beatrice change.
 *
 * The first specialist-as-reviewer gate in Hearth. Kate reads the embedded diff
 * (via list_changes_for_review), then rules:
 *   - deny → the change goes back to Beatrice (inbox flag with reasons); she
 *     revises and re-files, which supersedes this one.
 *   - approve / approve_with_concerns → the change advances to
 *     pending_owner_merge AND an owner-facing `recommendation` proposal is filed
 *     whose dispatch payload runs `merge_approved_change` (as trainer) when the
 *     owner approves the merge from the Code Shop office.
 *
 * Kate APPROVING is necessary but not sufficient: only the owner can decide the
 * resulting proposal (owner-tier cordon), and only then does Beatrice merge.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { ProposalsStore } from '@core/proposals';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';
import { ChangeRecordsStore } from '@memory/stores/change_records';
import { CodeShopSettings } from '@memory/stores/codeshop_settings';
import { append_to_memory } from '@core/memory_files';
import { arm_trust_autoexec } from '@core/trust_teeth';
import {
  code_teeth_enabled,
  code_undo_minutes,
  is_protected_code_change,
} from '@specialists/trainer/code_teeth';

/** How long a still-`running` swarm review may hold Kate's verdict. Past this
 *  the interlock fails OPEN so a hung or crashed swarm can never freeze the
 *  review pipeline. A bench + a higher-court appeal fits well inside it. */
const SWARM_WAIT_CEILING_MS = 15 * 60_000;

const InputSchema = z.object({
  change_id: z.string().min(1),
  verdict: z.enum(['approve', 'approve_with_concerns', 'deny']),
  reasons_md: z
    .string()
    .min(20)
    .max(2000)
    .describe('Your skeptic justification — what you verified, and (on deny/concerns) exactly what is wrong or unverifiable. A bare "looks fine" is not a review.'),
});

const OutputSchema = z.object({
  change_id: z.string(),
  new_status: z.string(),
  routed_to: z.enum(['trainer', 'owner', 'none']),
  proposal_id: z.string().nullable(),
  reason: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

interface ReviewDeps {
  db: ToolDeps['db'];
  proposals: ProposalsStore;
  inbox: SpecialistInbox;
  events: AppEventBus;
  /** Code-teeth arm path (2026-07-05) — arm_trust_autoexec audits + pushes
   *  through the same gated pipeline everything else uses. */
  memory: ToolDeps['memory'];
}

export function make_review_change(deps: ReviewDeps): Tool<Input, Output> {
  const store = new ChangeRecordsStore(deps.db);
  return {
    name: 'review_change',
    description:
      "Record your skeptic verdict on one of Beatrice's pending changes. deny → it returns to Beatrice with your reasons. approve / approve_with_concerns → it advances to the owner's merge-approval queue. Be a skeptic: deny anything that could harm HEARTH, isn't justified by the rationale, exceeds the stated scope, or you can't verify from the diff. Your approval is required but never auto-merges — the owner still approves the merge. ALSO the owner's send-back path: when he reviews a change in chat that is already in his merge queue and requests changes, verdict:'deny' with his feedback in reasons_md returns it to Beatrice and withdraws the merge card.",
    risk: 'write_internal',
    required_capabilities: ['review_beatrice_change'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key: (i) => `review_change:${i.change_id}:${i.verdict}`,

    async execute(input, ctx: ToolContext): Promise<Output> {
      const change = store.get(input.change_id);
      if (!change) {
        return {
          change_id: input.change_id, new_status: '', routed_to: 'none', proposal_id: null,
          reason: `no change record ${input.change_id}`,
        };
      }
      // Conversational-review send-back (2026-07-18): the owner discussed
      // this change in chat AFTER your approval and requested changes. A
      // `deny` on a pending_owner_merge row returns it to Beatrice carrying
      // his feedback and WITHDRAWS the merge card (denied with the same
      // reasons) so a stale approval can never be tapped. Re-approving from
      // this state stays impossible — the owner's tap is the only way
      // forward for an approved change.
      if (change.status === 'pending_owner_merge') {
        if (input.verdict !== 'deny') {
          return {
            change_id: change.id, new_status: change.status, routed_to: 'none', proposal_id: null,
            reason:
              "change is already in the owner's merge queue — you cannot re-approve it. To send it " +
              "back for revision with the owner's requested changes, call review_change with " +
              "verdict:'deny' and his feedback in reasons_md; otherwise the owner decides the merge card.",
          };
        }
        const sent = store.send_back(change.id, input.reasons_md);
        if (!sent) {
          const cur = store.get(change.id);
          return {
            change_id: change.id, new_status: cur?.status ?? '', routed_to: 'none', proposal_id: null,
            reason: 'change left the merge queue concurrently (merged or already sent back) — no action taken',
          };
        }
        if (change.related_proposal_id) {
          try {
            deps.proposals.decide(
              change.related_proposal_id,
              'deny',
              undefined,
              `owner requested changes during conversational review: ${input.reasons_md.slice(0, 400)}`,
              'withdraw_merge_card',
            );
          } catch {
            // Even if the withdraw misses, merge_approved_change's
            // pending_owner_merge guard refuses the stale card at dispatch.
          }
        }
        const sb_target = change.target_specialist_id ? ` on ${change.target_specialist_id}` : '';
        try {
          append_to_memory(
            ctx.memory,
            'trainer',
            `BUILD LESSON (owner send-back, change \`${change.id}\`, ` +
              `${change.change_kind}${sb_target}): ${input.reasons_md.slice(0, 600)}`,
            'owner review',
          );
        } catch {
          /* lesson capture is opportunistic */
        }
        const inbox_id = deps.inbox.push({
          from_specialist_id: 'kate',
          to_specialist_id: 'trainer',
          kind: 'flag',
          body_md:
            `**The owner reviewed your change** \`${change.id}\` (${change.change_kind}${sb_target}) ` +
            'in chat and requested changes — it is back with you. Revise per the notes below and ' +
            're-file; the same approach supersedes this one.\n\n' +
            `**Requested changes:**\n${input.reasons_md}`,
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
          tool_name: 'review_change',
          tool_input: { change_id: change.id, verdict: 'deny', from_status: 'pending_owner_merge' },
          execution_result: {
            new_status: 'denied_by_kate',
            withdrew_proposal: change.related_proposal_id,
          },
        });
        return {
          change_id: change.id,
          new_status: 'denied_by_kate',
          routed_to: 'trainer',
          proposal_id: null,
        };
      }
      if (change.status !== 'pending_kate_review') {
        return {
          change_id: change.id, new_status: change.status, routed_to: 'none', proposal_id: null,
          reason: `change is already '${change.status}' — nothing to review`,
        };
      }

      // Compile-correctness is the MACHINE's gate, not yours. A change that
      // failed automated checks (tsc --noEmit / guard) does not compile and must
      // never advance to the owner's merge queue — hard-refuse an approve here.
      // `deny` stays available (route it back to Beatrice). `null` (legacy /
      // not-recorded) is allowed through — only an explicit failure blocks.
      // In practice a red change throws before a record exists, so this is a
      // defense-in-depth backstop.
      if (change.checks_passed === false && input.verdict !== 'deny') {
        return {
          change_id: change.id, new_status: change.status, routed_to: 'none', proposal_id: null,
          reason:
            `cannot ${input.verdict}: this change FAILED automated checks (tsc --noEmit / guard) — it does not ` +
            'compile. Compile-correctness is verified by the machine, not your review. Deny it so Beatrice ' +
            'fixes and re-files; your judgment is reserved for design-correctness of changes that already build.',
        };
      }

      // SWARM INTERLOCK (2026-07-21). The review swarm is detached and takes
      // ~2-5 min (longer when a block escalates to the higher court), while a
      // wake-on-flag review lands in ~60s. On the first live run Kate approved a
      // change 97 SECONDS BEFORE the bench returned its blocker — "inform-only"
      // that arrives after the decision informs nobody. So: while a bench is
      // still sitting on THIS change, refuse to rule and tell her to wait; the
      // swarm flags her the moment it rules. Bounded by SWARM_WAIT_CEILING_MS so
      // a hung/crashed swarm can never freeze the review pipeline (fail-open).
      const sitting = (() => {
        try {
          const row = deps.db
            .prepare(
              `SELECT started_at FROM swarm_reviews
                WHERE change_id = @cid AND status = 'running'
                ORDER BY started_at DESC LIMIT 1`,
            )
            .get({ '@cid': change.id }) as { started_at?: string } | undefined;
          if (!row?.started_at) return false;
          const age = Date.now() - new Date(row.started_at).getTime();
          return Number.isFinite(age) && age >= 0 && age < SWARM_WAIT_CEILING_MS;
        } catch {
          return false; // no table / bad row ⇒ never block the pipeline
        }
      })();
      if (sitting) {
        return {
          change_id: change.id, new_status: change.status, routed_to: 'none', proposal_id: null,
          reason:
            'the review swarm is still sitting on this change — hold your verdict. It will flag you the ' +
            'moment it rules (a block escalates to the higher court first). Ruling now would decide ' +
            'without the findings, which is exactly what the bench is for.',
        };
      }

      // Guarded transition — null means a concurrent review already moved it.
      // Bail before filing a (duplicate) merge proposal.
      const updated = store.set_kate_verdict(change.id, input.verdict, input.reasons_md);
      if (!updated) {
        const cur = store.get(change.id);
        return {
          change_id: change.id, new_status: cur?.status ?? '', routed_to: 'none', proposal_id: null,
          reason: 'change was already reviewed (no longer pending) — skipped',
        };
      }
      const target = change.target_specialist_id ? ` on ${change.target_specialist_id}` : '';

      // Post-review learning: Kate's verdicts are Beatrice's training data.
      // A deny (and concerns on an approve) lands as a BUILD LESSON in
      // trainer's memory.md — whose tail the deliberation builder ALREADY
      // injects, so the next build sees what the reviewer rejected/flagged
      // last time with zero new plumbing. Best-effort; never blocks the
      // verdict.
      if (input.verdict !== 'approve') {
        try {
          append_to_memory(
            ctx.memory,
            'trainer',
            `BUILD LESSON (${input.verdict} by Kate, change \`${change.id}\`, ` +
              `${change.change_kind}${target}): ${input.reasons_md.slice(0, 600)}`,
            'kate review',
          );
        } catch {
          /* lesson capture is opportunistic */
        }
      }

      if (input.verdict === 'deny') {
        const body_md =
          `**Kate denied your change** \`${change.id}\` (${change.change_kind}${target}). ` +
          'Revise per the concerns below and re-file — using the same approach supersedes this one.\n\n' +
          `**Concerns:**\n${input.reasons_md}`;
        const inbox_id = deps.inbox.push({
          from_specialist_id: 'kate',
          to_specialist_id: 'trainer',
          kind: 'flag',
          body_md,
        });
        deps.events.emit({
          type: 'inbox_message_added',
          message_id: inbox_id,
          from_specialist_id: 'kate',
          to_specialist_id: 'trainer',
          kind: 'flag',
          severity: 'high',
        });
        return { change_id: change.id, new_status: 'denied_by_kate', routed_to: 'trainer', proposal_id: null };
      }

      // approve / approve_with_concerns → owner merge-approval proposal.
      //
      // Code teeth (2026-07-05, owner-decided): a CLEAN Kate approve on a
      // checks-green change whose files all clear the protected-path floor
      // files WITHOUT step-up and ARMS for auto-merge after the code undo
      // window (push names the change; deny in the queue cancels; the
      // trust_autoexec sweep merges survivors through the SAME dispatch the
      // owner tap uses). Protected paths / concerns-verdicts / red checks
      // keep the classic owner + PIN flow. DARK behind HEARTH_CODE_TEETH.
      const protected_change =
        change.change_kind !== 'code' ? false : is_protected_code_change(change.files);
      // Commissioner ≠ sole reviewer (2026-07-20, owner-decided): teeth only
      // arm when an INDEPENDENT context reviewed the change — a completed
      // Vera critique (a done 'critic' delegation naming this bchg_* id).
      // Kate both commissions builds and reviews them now, so her clean
      // approve alone is one context grading its own pipeline; Vera's
      // recorded digest is the structural second set of eyes. No critique →
      // the classic owner-tap flow (never a block, just no auto-merge).
      const vera_reviewed = (() => {
        try {
          const row = deps.db
            .prepare(
              `SELECT 1 FROM delegations
                WHERE profile_id = 'critic' AND status = 'done'
                  AND task LIKE '%' || @cid || '%' LIMIT 1`,
            )
            .get({ '@cid': change.id });
          return row != null;
        } catch {
          return false; // fail-closed: no evidence of review → no teeth
        }
      })();
      const teeth_eligible =
        code_teeth_enabled() &&
        change.change_kind === 'code' &&
        !protected_change &&
        input.verdict === 'approve' &&
        change.checks_passed === true &&
        vera_reviewed;
      const summary = `${change.change_kind}${target} (+${change.lines_added}/−${change.lines_removed})`;
      const proposal_id = deps.proposals.create({
        specialist_id: 'trainer',
        kind: 'recommendation',
        execution_kind: 'dispatch',
        user_id: null, // owner-global self-improvement proposal
        // This merge-card is filed AFTER Kate already reviewed the code — it
        // goes straight to the owner's merge queue, NOT back through her
        // proposal pre-review gate (which would loop on a trainer
        // `recommendation`). See KATE_REVIEW_KINDS in proposals.ts.
        skip_kate_review: true,
        payload: {
          dispatch_tool: 'merge_approved_change',
          dispatch_input: { change_id: change.id },
          change_id: change.id,
          summary,
          kate_verdict: input.verdict,
          kate_concerns: input.reasons_md,
          pr_url: change.pr_url,
          lines_added: change.lines_added,
          lines_removed: change.lines_removed,
          languages: change.languages,
          code_teeth_armed: teeth_eligible,
          // PIN step-up: ALWAYS for a protected-path code change; otherwise
          // the owner's toggle governs — except a teeth-armed change, whose
          // undo-window deny IS the control (a step-up card can't auto-run).
          requires_step_up:
            change.change_kind === 'code' &&
            (protected_change ||
              (!teeth_eligible && new CodeShopSettings(deps.db).get().require_pin_code_merge)),
        },
        rationale: `Kate (skeptic review) ${input.verdict.replace(/_/g, ' ')}: ${input.reasons_md}`,
        signature: {
          specialist_id: 'trainer',
          kind: 'beatrice_merge',
          category: 'self_improvement',
          anchor: change.id,
        },
      });
      store.attach_proposal(change.id, proposal_id);

      if (teeth_eligible) {
        try {
          const p = deps.proposals.get(proposal_id);
          if (p) {
            await arm_trust_autoexec(
              { db: deps.db, proposals: deps.proposals, memory: deps.memory },
              p,
              'code-trust',
              [{ seat: 'kate', vote: 'approve', reason: input.reasons_md.slice(0, 200) }],
              new Date(),
              code_undo_minutes(),
            );
          }
        } catch (err) {
          // Fail-SAFE: an arm failure leaves the classic owner-tap flow
          // intact — the card is pending either way.
          console.error('[code-teeth] arm failed (owner tap still works):', err);
        }
      }

      ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kate',
        tool_name: 'review_change',
        tool_input: { change_id: change.id, verdict: input.verdict },
        execution_result: { new_status: 'pending_owner_merge', proposal_id },
      });

      return {
        change_id: change.id,
        new_status: 'pending_owner_merge',
        routed_to: 'owner',
        proposal_id,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_review_change({
    db: deps.db,
    proposals: deps.proposals,
    inbox: deps.inbox,
    events: deps.events,
    memory: deps.memory,
  }) as Tool;
}
