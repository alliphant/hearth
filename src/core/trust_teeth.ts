/**
 * Trust teeth — graduated-signature user-action proposals auto-execute on
 * Proposal Court consensus (2026-07-02, the trust ladder's first actual
 * unlock; built DARK, armed only after the court scorecard proves ≥ a week
 * of court–owner agreement — see src/core/court_scorecard.ts).
 *
 * The contract:
 *   - A USER-ACTION proposal (TEETH_KINDS — never a system kind; those are
 *     the Court's own envelope) whose category signature has EARNED
 *     tier2c/tier3 autonomy (the full graduation ladder: approvals + XP +
 *     authenticity + eval health) AND draws a unanimous court approve is
 *     ARMED, not executed: a `trust_autoexec` row schedules the execution
 *     after an UNDO WINDOW (HEARTH_TRUST_UNDO_MINUTES, default 30), and the
 *     owner is notified (push_text through the existing quiet-hours /
 *     delivery-window gate) what will run and how to stop it.
 *   - The undo affordance IS the existing queue: the proposal stays
 *     `pending` through the window, so denying it cancels the execution AND
 *     carries the negative XP signal through the normal decide() path (an
 *     undo counts as a reject for the signature). A snooze (explicit owner
 *     defer) also cancels — auto-executing over a "show me later" would
 *     contradict the owner's touch. An owner approve simply beats the sweep.
 *   - When the window passes untouched, the sweep runs decide('approve') +
 *     `execute_approved_proposal` — the SAME store transition and effects
 *     machinery an owner tap runs (XP flows at decide(), the dispatch/
 *     resolver audit rows are identical). Never a parallel execution path.
 *
 * THE PERMANENT FLOOR IS UNCHANGED and enforced upstream in the court
 * (`is_owner_only`): requires_step_up, hiring packets, and send_/spend_/
 * merge-shaped dispatches are never court-touchable, teeth or no teeth.
 * `draft_message` is deliberately NOT in TEETH_KINDS — a draft's approve
 * means "send", and sends stay behind the human tap forever.
 *
 * Kill switch: HEARTH_TRUST_TEETH (separate from HEARTH_PROPOSAL_COURT).
 * Off → the court never arms, the sweep never executes (armed rows freeze,
 * harmlessly — the proposals under them are still ordinary pending cards).
 *
 * Known edge (accepted, documented): the arm notification rides the normal
 * push gates, so a quiet-hours convening could defer the push past the
 * window. In practice the court convenes daily at 08:40 local; the floor
 * bounds the blast radius of the theoretical miss.
 */

import type { Database } from 'bun:sqlite';
import type { MemoryClient } from '@memory/client';
import type { SpecialistRegistry } from './specialist';
import type { ToolRegistry } from './tool_registry';
import type { LLMRouter } from './llm';
import type { AppEvent } from '../app/events';
import { TrustAutoexecStore, type TrustAutoexecRow } from '@memory/stores/trust_autoexec';
import { code_teeth_enabled } from '../specialists/trainer/code_teeth';
import { execute_approved_proposal } from '../app/routes/specialists';
import type { ProposalsStore, ProposalRow } from './proposals';
import type { CourtVote } from './proposal_court';
import { format_short_datetime } from './time';
import { ulid } from 'ulid';

export function trust_teeth_enabled(): boolean {
  return process.env.HEARTH_TRUST_TEETH === '1';
}

export function undo_window_minutes(): number {
  const n = Number(process.env.HEARTH_TRUST_UNDO_MINUTES ?? 30);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/**
 * User-action kinds eligible for consensus auto-execution. A positive
 * allowlist on purpose: `draft_message` (send-shaped — permanent floor) and
 * every system/self-improvement kind (the Court's own decide envelope) are
 * excluded by construction, not by filter.
 */
export const TEETH_KINDS: ReadonlySet<string> = new Set([
  'action_proposal',
  'calendar_event',
  'book_candidate',
]);

/**
 * Per-kind arming — the ratchet (2026-08-02).
 *
 * `HEARTH_TRUST_TEETH` is all-or-nothing, and its documented gate is one
 * BLENDED agreement rate across every kind at once. That gate has never
 * opened: a strong record on calendar events is averaged against a weak one
 * on action proposals, so no amount of proven trust in a narrow class unlocks
 * anything, and the ladder has no rung between "nothing" and "everything".
 *
 * `HEARTH_TRUST_TEETH_KINDS` is a comma-separated allowlist arming teeth for
 * exactly those kinds. The owner still flips it by hand — this widens the
 * granularity of his decision, it does not automate it — but he can now grant
 * trust where the scorecard shows it was earned (`armable_kinds`, scored on
 * that kind's OWN record) and withhold it everywhere else. The global flag
 * still means every teeth-eligible kind.
 *
 * Composes with every existing gate rather than replacing any: the kind must
 * still be in TEETH_KINDS, the signature must still hold a graduated tier,
 * and the undo window is untouched. This changes only the outermost on/off.
 */
export function teeth_armed_kinds(): ReadonlySet<string> {
  return new Set(
    (process.env.HEARTH_TRUST_TEETH_KINDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && TEETH_KINDS.has(s)),
  );
}

/** Are teeth armed for THIS kind — globally, or on its own earned record? */
export function teeth_armed_for_kind(kind: string): boolean {
  if (!TEETH_KINDS.has(kind)) return false;
  if (trust_teeth_enabled()) return true;
  return teeth_armed_kinds().has(kind);
}

/** Autonomy tiers whose signatures have earned consensus auto-execution. */
const TEETH_TIERS = new Set(['tier2c', 'tier3']);

/**
 * The graduated-trust gate: does this proposal's signature hold a tier that
 * unlocks auto-execution? Returns the tier string when it does, null when
 * not (no signature, unknown signature, or a lower tier).
 */
export function teeth_tier_for(proposals: ProposalsStore, p: ProposalRow): string | null {
  if (!p.category_signature_hash) return null;
  const trust = proposals.trust_level_for(p.category_signature_hash);
  if (!trust) return null;
  return TEETH_TIERS.has(trust.autonomy_status) ? trust.autonomy_status : null;
}

export interface ArmDeps {
  db: Database;
  proposals: ProposalsStore;
  memory: MemoryClient;
  /** Notification seam. Default (wired at the call site) is push_text /
   *  push_text_to_user — the quiet-hours + delivery-window gated path. */
  push_fn?: (user_id: string | null, text: string, related_id: string) => Promise<unknown>;
}

export interface ArmResult {
  row: TrustAutoexecRow;
  already_armed: boolean;
}

/**
 * Arm a court-approved, graduated proposal for auto-execution after the
 * undo window. Inserts the durable ledger row (idempotent per proposal),
 * notifies the proposal's user (falling back to the default/owner user)
 * with what will run and how to stop it, and audits. The proposal itself is
 * NOT decided here — it stays pending so the queue's Deny remains the undo.
 */
export async function arm_trust_autoexec(
  deps: ArmDeps,
  p: ProposalRow,
  tier: string,
  votes: CourtVote[],
  now: Date = new Date(),
  /** Per-class undo window override (minutes). Default = the proposal
   *  teeth window; code teeth passes its longer HEARTH_CODE_UNDO_MINUTES. */
  window_minutes?: number,
): Promise<ArmResult> {
  const store = new TrustAutoexecStore(deps.db);
  const existing = store.get_by_proposal(p.id);
  if (existing) return { row: existing, already_armed: true };

  const window = window_minutes ?? undo_window_minutes();
  const execute_after = new Date(now.getTime() + window * 60_000).toISOString();
  const row = store.arm({
    proposal_id: p.id,
    signature_hash: p.category_signature_hash,
    tier,
    execute_after,
    votes_json: JSON.stringify(votes.map((v) => `${v.seat}=${v.vote}`)),
    now,
  });

  const when = format_short_datetime(execute_after);
  const title = p.title ?? p.summary ?? p.kind;
  const text =
    `Kate's court cleared "${title}" for auto-execution (earned ${tier} trust). ` +
    `It runs at ${when} — deny it in the proposal queue to cancel.`;
  // Default notification path: the quiet-hours + delivery-window gated push
  // pipeline. Lazy import keeps this module constructible in smokes that
  // inject their own push_fn and never touch APNs config.
  const push_fn =
    deps.push_fn ??
    (async (user_id: string | null, body: string, related_id: string): Promise<unknown> => {
      const push = await import('@policy/push');
      if (user_id) {
        return push.push_text_to_user(user_id, body, {
          kind: 'ad_hoc',
          severity: 'medium',
          related_id,
        });
      }
      // System-filed user-action proposal (no cordon user) → the default user.
      return push.push_text(body, deps.memory, related_id, 'trust-teeth undo window');
    });
  try {
    await push_fn(p.user_id, text, p.id);
  } catch (err) {
    // Notification is best-effort; the queue card + digest still surface it.
    console.error(`[trust-teeth] arm notification failed for ${p.id}:`, err);
  }

  deps.memory.log_action({
    intent_id: ulid(),
    agent: 'kate',
    tool_name: 'trust_autoexec_armed',
    tool_input: { proposal_id: p.id, kind: p.kind, tier },
    execution_result: {
      execute_after,
      undo_minutes: undo_window_minutes(),
      votes: votes.map((v) => `${v.seat}=${v.vote}`),
    },
  });

  return { row, already_armed: false };
}

// ── the sweep (60s orchestrator tick) ──────────────────────────────────────

export interface TrustTeethSweepDeps {
  db: Database;
  proposals: ProposalsStore;
  memory: MemoryClient;
  specialists: SpecialistRegistry;
  tools: ToolRegistry;
  llm: LLMRouter;
  events?: { emit: (e: AppEvent) => void };
}

export interface TrustTeethSweepResult {
  enabled: boolean;
  due: number;
  executed: string[];
  canceled: string[];
  failed: string[];
}

/**
 * Resolve every armed row whose undo window has passed. Runs on the
 * orchestrator's 60s sweep tick; each row fail-open (one bad row never
 * blocks the rest). Gated at tick time on HEARTH_TRUST_TEETH so flipping
 * the kill switch freezes execution immediately.
 */
export async function sweep_trust_autoexec(
  deps: TrustTeethSweepDeps,
  now: Date = new Date(),
): Promise<TrustTeethSweepResult> {
  const result: TrustTeethSweepResult = {
    // The sweep serves BOTH teeth classes: proposal teeth (HEARTH_TRUST_TEETH,
    // court-armed) and code teeth (HEARTH_CODE_TEETH, review_change-armed).
    // Rows only exist if an enabled armer created them, so either flag being
    // on makes the sweep live; both off freezes armed rows exactly as before.
    enabled: trust_teeth_enabled() || code_teeth_enabled(),
    due: 0,
    executed: [],
    canceled: [],
    failed: [],
  };
  if (!result.enabled) return result;

  const store = new TrustAutoexecStore(deps.db);
  const due = store.due(now);
  result.due = due.length;

  for (const row of due) {
    try {
      const p = deps.proposals.get(row.proposal_id);

      // The owner touched it first — their decision stands, ours cancels.
      // A deny already carried the negative XP through decide(); a snooze
      // is an explicit defer the sweep must respect (no XP either way — the
      // owner didn't reject the action, they rejected the automation).
      if (!p) {
        store.cancel(row.id, 'proposal no longer exists');
        result.canceled.push(row.proposal_id);
        continue;
      }
      if (p.status === 'snoozed') {
        store.cancel(row.id, 'owner deferred (snoozed) during the undo window');
        result.canceled.push(row.proposal_id);
        continue;
      }
      if (p.status !== 'pending') {
        store.cancel(row.id, `owner resolved it first (status ${p.status})`);
        result.canceled.push(row.proposal_id);
        continue;
      }

      // Window passed untouched → execute through the owner-tap path:
      // decide('approve') (XP flows here) + the shared effects machinery.
      const primary = p.actions.find((a) => a.effect === 'execute');
      const action_id = primary?.id ?? 'approve';
      const decided = deps.proposals.decide(
        p.id,
        'approve',
        undefined,
        `trust teeth: auto-executed on court consensus (${row.tier})`,
        action_id,
      );
      let summary = `decided (${decided?.status ?? 'unknown'})`;
      if (decided?.should_execute) {
        const exec = await execute_approved_proposal(
          {
            proposals: deps.proposals,
            memory: deps.memory,
            specialists: deps.specialists,
            tools: deps.tools,
            llm: deps.llm,
            db: deps.db,
          },
          p.id,
          action_id,
        );
        summary = `executed via ${exec.path}${'ok' in exec && exec.ok === false ? ` (error: ${exec.error ?? 'unknown'})` : ''}`;
      }
      // Terminal stamp for non-executing kinds — mirrors the decide route's
      // catch-all so an approved-with-nothing-to-run card doesn't stall.
      const post = deps.proposals.get(p.id);
      if (post?.status === 'approved') {
        deps.proposals.mark_acknowledged(p.id);
        summary += ' → acknowledged';
      }

      store.mark_executed(row.id, summary);
      deps.memory.log_action({
        intent_id: ulid(),
        agent: 'kate',
        tool_name: 'trust_autoexec_executed',
        tool_input: { proposal_id: p.id, kind: p.kind, tier: row.tier, action_id },
        execution_result: { summary, final_status: deps.proposals.get(p.id)?.status },
      });
      deps.events?.emit({
        type: 'proposal_decided',
        proposal_id: p.id,
        verdict: 'approve',
      });
      result.executed.push(p.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[trust-teeth] auto-exec failed for ${row.proposal_id} (fail-open):`, msg);
      store.mark_failed(row.id, msg);
      deps.memory.log_action({
        intent_id: ulid(),
        agent: 'kate',
        tool_name: 'trust_autoexec_executed',
        tool_input: { proposal_id: row.proposal_id, tier: row.tier },
        error: msg,
      });
      result.failed.push(row.proposal_id);
    }
  }

  return result;
}
