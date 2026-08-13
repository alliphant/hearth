/**
 * Proposals, category signatures, and the autonomy graduation framework
 * (Tier 2a → 2b → 2c → 3).
 *
 * A "proposal" is something a specialist wants the user to look at:
 * a drafted message, a recommended action, a synthesized briefing.
 * Every proposal carries a category_signature_hash — a canonical-JSON
 * sha256 of the proposal's "shape" (who it's for, what kind of thing
 * it is). Approvals accumulate on the signature; over time, signatures
 * that earn a track record of approvals-without-edits become candidates
 * for graduation to lower-friction tiers.
 *
 * See architecture.md "Tiered autonomy" for the design reasoning.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import { parse as parseYaml } from 'yaml';
import { ulid } from 'ulid';
import { z } from 'zod';
import {
  compute_dedup_key,
  compute_proposal_actions,
  compute_proposal_title,
  compute_proposal_summary,
} from './proposal_render';
import type { Database } from 'bun:sqlite';
import type { Tier } from '@core/users';
import {
  type TrustXpConfig,
  type TrustEffect,
  type SpecialistRank,
  TRUST_XP_DEFAULTS,
  trust_xp_enabled,
  risk_class_for,
  xp_for,
  level_for,
  xp_threshold_for,
  specialist_level_for,
  compute_specialist_rank,
} from '@core/trust_xp';
import { precedent_enabled, match_precedent_text } from '@core/precedent';

export type ProposalKind =
  | 'draft_message'
  | 'action_proposal'
  | 'briefing'
  | 'recommendation'
  // Persona / tool tuning proposed by Beatrice in response to user
  // UX feedback flagged by a peer specialist. Payload shape is
  // documented in src/specialists/trainer/tools/propose_persona_tuning.ts.
  | 'persona_tuning'
  // Beatrice's canonical structural-gap response — a markdown spec
  // written to Knowledge/Trainer/binding-proposals/<slug>.md with the
  // rationale (cited audit rows), affected files, capability name,
  // tool name + Zod schema sketch, YAML grant diff. On Jasper's
  // approval, Beatrice translates the binding proposal into a
  // propose_code_change PR. Persona at config/specialists/trainer.yaml
  // prescribes this kind for structural-gap consults and Mariah
  // miss-escalations.
  | 'binding_proposal'
  // iOS-mediated calendar event write-back per BACKEND_SENSORS_BRIEF
  // "Calendar write-back — iOS as the CalDAV adapter." A specialist
  // wants to add an event to the user's calendar; instead of going
  // through a server-side CalDAV connector, the runtime creates a
  // proposal of this kind and the backend emits a `calendar_event_proposed`
  // AppEvent. iOS picks it up, surfaces (or auto-applies for
  // low-stakes), calls EKEventStore.save against the right account,
  // and POSTs /api/proposals/:id/decide. execution_kind for this kind
  // is 'none' — the server-side decide-handler is a pure state
  // transition because iOS already did the write client-side.
  // Payload shape: see CalendarEventPayloadSchema below.
  | 'calendar_event'
  // Cordelia's `intake_book` files a queue note at
  // `Knowledge/Cordelia/queue/<slug>.md` when a book cover lands in
  // the visual pipeline, then surfaces a proposal of this kind with
  // three actions (Acquire / File only / Skip). The kind's resolver
  // mutates the queue note's `status` field directly — no LLM turn,
  // no chat surface, no fabrication risk. Payload shape:
  // `{ queue_note_path: string, title_candidate: string | null,
  //    author_candidate: string | null, source_capture_id: string }`.
  | 'book_candidate'
  // Slice B (2026-05-30). Cordelia's `curate_for_specialist` tool
  // proposes a new domain be added to a specialist's `trusted_sources`
  // (tier_1 or tier_2). Filed when a high-quality candidate URL falls
  // outside the existing manifest and Cordelia can't classify it
  // confidently on her own — Jasper (or Beatrice on his behalf) reviews
  // and approves. On approval the kind's resolver patches the
  // specialist's YAML in-place via the YAML Document API (comment-
  // preserving). On denial the candidate is recorded as rejected so
  // Cordelia doesn't re-propose it. Payload shape:
  //   `{ target_specialist_id: string, domain: string,
  //      tier: 1 | 2, candidate_url: string,
  //      candidate_title: string, justification: string }`
  | 'trusted_source_addition'
  // Beatrice's scrum/dev-board blocking judgment call — the blueprint's
  // "decision queue" expressed as a Hearth proposal so it lands in the one
  // "awaiting you" inbox (push + step-up) rather than a parallel queue. Two
  // shapes: (a) a multi-option judgment ("reuse cache cluster or dedicated?")
  // carrying `options: [{id,label,description?}]` — execution_kind 'none', the
  // pick is recorded in action_taken and Beatrice reads it next grooming pass;
  // (b) a sprint-commit gate ("commit these N epics?") filed with a
  // `dispatch_tool: scrum_sprint_write` so approval runs the commit. Payload:
  // `{ question: string, options?: [...], recommendation?: string,
  //    sprint_label?: string, epic_ids?: string[] }`.
  | 'scrum_decision'
  // Conversational face enrollment (2026-07-15). The face-candidate sweep
  // files one of these when a recurring UNKNOWN face cluster's sightings
  // correlate almost exclusively with one household member's presence —
  // "Enroll this recurring face as Sam?". Approving runs the kind's
  // resolver (the same deterministic enroll flow as the People-room assign:
  // crops → CPAI register → roster upsert → cluster labeled); rejecting
  // dismisses the cluster so it is never re-asked. A human confirms every
  // name — the sweep only asks. Payload shape: FaceEnrollmentPayload in
  // src/core/face_candidates.ts.
  | 'face_enrollment';

/**
 * The semantic class of a `ProposalAction`. The decide handler routes
 * dispatch on this:
 *
 *   - `execute`  → flip status to `approved`; run the kind's resolver
 *                  (or the legacy `dispatch_tool` path) to produce the
 *                  side effect. e.g. Send the draft, Add the event,
 *                  Apply the persona tuning, Acquire the book.
 *   - `modify`   → flip status to `approved`; the kind's resolver
 *                  records the user's intent to revise and may
 *                  re-open the proposal for the author specialist
 *                  ("edit time" on a calendar event, "lower amount"
 *                  on a spend). Stubs in v0.1 where the modify-then-
 *                  resubmit flow isn't yet wired.
 *   - `defer`    → snooze the proposal for 24h; reappears in the
 *                  queue tomorrow. No side effect.
 *   - `reject`   → flip status to `denied`. No side effect. Trains
 *                  the autonomy graduation signature negatively.
 *   - `noop`     → flip status to `approved` (the user acknowledged
 *                  it) with no side effect — for briefing-class
 *                  proposals where "Got it" is the user's signal.
 */
export type ActionEffect = 'execute' | 'modify' | 'defer' | 'reject' | 'noop';

/**
 * A single tappable action on a proposal. iOS / web render these as
 * buttons. Each kind's helper in `proposal_render.ts` declares its
 * action set at proposal-creation time; the array persists in
 * `actions_json` so clients always render exactly what the author
 * intended, even if the kind's renderer changes later. Legacy
 * proposals (`actions_json IS NULL`) fall back to a default
 * Approve/Deny set.
 */
export interface ProposalAction {
  /** Stable token — `'send' | 'edit' | 'discard' | 'apply' | 'acquire' | …`.
   *  The decide handler dispatches on (kind, id). Snake_case
   *  conventional; short. */
  id: string;
  /** What the user sees on the button. 1-3 words. */
  label: string;
  /** Optional one-line description under the label (the trade-off,
   *  the consequence). */
  description?: string;
  /** UI hint for rendering: `primary` (filled, accent color),
   *  `secondary` (bordered, neutral), `destructive` (red tint). */
  style: 'primary' | 'secondary' | 'destructive';
  /** Semantic class the decide handler routes on. */
  effect: ActionEffect;
}

/**
 * Zod schema for `kind: 'calendar_event'` payloads. Specialists that
 * want to propose an event to a user's calendar should build payloads
 * matching this shape — title + start/end ISO strings minimum, plus
 * optional location/notes/calendar_hint/rationale. iOS reads the same
 * shape on the SSE side to surface the confirmation.
 */
export const CalendarEventPayloadSchema = z
  .object({
    title: z.string().min(1).max(200),
    ts_start: z.string().min(1),
    ts_end: z.string().min(1),
    location: z.string().max(200).optional(),
    notes: z.string().max(2000).optional(),
    /** Routes the EKEventStore write to the right account on iOS. iOS
     *  maps these tokens to its currently-configured calendar sources
     *  (work → Exchange, personal → iCloud default, household → shared
     *  family); unknown / null falls back to the user's default
     *  writable calendar. */
    calendar_hint: z
      .enum(['work', 'personal', 'household'])
      .nullable()
      .optional(),
    /** When set, this is a MOVE/reschedule, not a fresh add: the iOS
     *  snapshot `event_id` (== `EKEvent.eventIdentifier`) of the event to
     *  relocate. iOS fetches it via `event(withIdentifier:)` and updates
     *  it in place (preserving attendees / RSVPs), falling back to a
     *  create if the event is gone. Absent ⇒ a new event. */
    replaces_event_id: z.string().min(1).optional(),
    /** All-day event (birthday/anniversary/"block the day"). iOS sets
     *  `EKEvent.isAllDay`; ts_start/ts_end carry the local-midnight day
     *  boundaries. Absent/false ⇒ a timed event. */
    is_all_day: z.boolean().optional(),
    rationale_md: z.string().min(1).max(2000),
  })
  .strict();

export type CalendarEventPayload = z.infer<typeof CalendarEventPayloadSchema>;

export type ProposalExecutionKind =
  | 'manual'
  | 'dispatch'
  | 'web_action'
  | 'composite'
  | 'none';

export type ProposalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'snoozed'
  | 'executed'
  | 'failed'
  | 'expired'
  | 'graduated'
  /**
   * Terminal state for an APPROVED proposal that has no system execution to
   * run — a manual/advisory kind (recommendation, persona_tuning, briefing
   * FYI, a draft the user sends themselves) or a modify/noop acknowledgment.
   * Approving such a proposal IS its final action; before this status existed
   * they sat at `approved` with `ts_executed` NULL forever (181 of them by
   * 2026-06-14), indistinguishable from a genuinely-pending execution. The
   * Beatrice build fan-out (and any other on-approval side effect) still fires;
   * the proposal itself is done. Stamped with `ts_executed` like `executed`.
   */
  | 'acknowledged'
  /**
   * A newer proposal targeting the same subject (computed via
   * `compute_dedup_key`) landed while this one was still open;
   * the older row gets stamped `superseded` with `superseded_by`
   * pointing at the newer id, and queue listings hide it by default.
   * Same lifecycle as a terminal status — won't be re-opened.
   */
  | 'superseded'
  /**
   * Holding state for a Beatrice self-improvement SPEC (KATE_REVIEW_KINDS)
   * awaiting Kate's pre-review (2026-06-15). NOT owner-visible — `list()`
   * hides it from the default queue exactly like `superseded`, and the owner
   * `?status=pending` query never matches it. Kate's `list_proposals_for_review`
   * surfaces them; `review_trainer_proposal` either `promote`s (→ `pending`,
   * owner-visible) or sends it back to Beatrice (→ `denied` + a flag). Mirrors
   * the code-change gate's `pending_kate_review` on `beatrice_changes`.
   */
  | 'pending_kate_review';

export type AutonomyStatus =
  | 'tier2a'
  | 'tier2b_proposed'
  | 'tier2b'
  | 'tier2c_proposed'
  | 'tier2c'
  | 'tier3_proposed'
  | 'tier3'
  | 'revoked';

export interface CategorySignature {
  /** which specialist this kind of action belongs to */
  specialist_id: string;
  /** what tool/effect family (e.g. "draft_message", "ha_set_state") */
  kind: string;
  /** intent category (legal/medical/social/etc) — string token */
  category: string;
  /** optional anchor — recipient id, entity_id, hashed amount-bucket */
  anchor?: string;
  /** anything else that should make this signature distinct */
  extras?: Record<string, string | number | boolean>;
}

export interface NewProposal {
  specialist_id: string;
  kind: ProposalKind;
  execution_kind: ProposalExecutionKind;
  payload: unknown;
  rationale: string;
  signature: CategorySignature;
  /** Originating user for the per-user cordon. Callers pass
   *  `ctx.user?.id` for action proposals; `create()` forces NULL for
   *  the system kinds in `SYSTEM_PROPOSAL_KINDS` regardless, so a
   *  self-improvement proposal is always owner-global. */
  user_id?: string | null;
  /** Opt OUT of the Kate pre-review gate (2026-06-15). By default a
   *  trainer-authored self-improvement spec (KATE_REVIEW_KINDS) is born
   *  `pending_kate_review` so Kate critiques it before it reaches the
   *  owner. `review_change`'s own merge-card (a trainer `recommendation`
   *  filed AFTER Kate already reviewed the code) sets this so it goes
   *  straight to the owner instead of looping back through Kate. */
  skip_kate_review?: boolean;
}

/**
 * Beatrice's self-improvement SPEC kinds that route through Kate's pre-review
 * gate before the owner sees them (2026-06-15). She is the critic + final
 * reviewer for what Beatrice proposes: a trainer-authored proposal of one of
 * these kinds is born `pending_kate_review` (hidden from the owner queue) and
 * only `promote_after_kate_review` flips it to owner-visible `pending`. Mirrors
 * the code-change review gate (`review_change`), which already gates Beatrice's
 * implementations. `skip_kate_review` on NewProposal opts a single create out
 * (the review_change merge-card).
 */
export const KATE_REVIEW_KINDS: ReadonlySet<ProposalKind> = new Set([
  'binding_proposal',
  'persona_tuning',
  'recommendation',
]);

/**
 * Self-improvement / "Hearth improving itself" proposal kinds. These are
 * ALWAYS owner-global (user_id forced to NULL at create time) so a
 * Beatrice/Mariah recommendation surfaces to the owner regardless of
 * which user's session triggered it. Everything else (draft_message,
 * action_proposal, calendar_event, book_candidate, briefing) is a
 * user-action proposal and cordons to the originating user.
 */
export const SYSTEM_PROPOSAL_KINDS: ReadonlySet<ProposalKind> = new Set([
  'recommendation',
  'persona_tuning',
  'binding_proposal',
  'trusted_source_addition',
  // Beatrice's scrum board is owner-only internal dev work — a decision
  // surfaces to the owner regardless of which session triggered the groom.
  'scrum_decision',
]);

/** One (specialist, kind) filing record — see `ProposalsStore.filing_yield`. */
export interface FilingYieldRow {
  specialist_id: string;
  kind: string;
  filed: number;
  acted: number;
  denied: number;
  lapsed: number;
  open: number;
  /** acted / (acted + denied + lapsed); null until something terminal. */
  yield_rate: number | null;
}

export interface ProposalRow {
  id: string;
  ts_created: string;
  ts_surfaced: string | null;
  ts_decided: string | null;
  ts_executed: string | null;
  specialist_id: string;
  kind: ProposalKind;
  execution_kind: ProposalExecutionKind;
  payload_json: string;
  rationale_md: string;
  category_signature_hash: string | null;
  status: ProposalStatus;
  snoozed_until: string | null;
  modifications_json: string | null;
  execution_result_json: string | null;
  user_feedback: string | null;
  /** Per-user cordon (2026-06-04). NULL = system / self-improvement
   *  proposal (recommendation, binding_proposal, persona_tuning,
   *  trusted_source_addition) — owner-global, surfaces to the owner
   *  regardless of which user's session triggered it. Otherwise the
   *  originating user's id — a user-action proposal cordoned to them. */
  user_id: string | null;
  /** One-line headline computed at create time from (kind, payload).
   *  Drives the iOS Proposal list row and any push-payload alert
   *  title. Backfillable for rows that pre-date this column. */
  title: string | null;
  /** 1–2 sentence row subtitle. */
  summary: string | null;
  /** Subject-identity discriminator. Two open proposals with the
   *  same `dedup_key` are talking about the same subject — the
   *  older gets superseded by the newer. NULL means the kind has
   *  no safe subject (action_proposal, draft_message) — never
   *  supersedes. */
  dedup_key: string | null;
  /** Id of the newer proposal that superseded this one, if any. */
  superseded_by: string | null;
  /** When the supersession happened. */
  superseded_at: string | null;
  /** Proposal Court split memory (2026-07-04): when the bench SPLIT on this
   *  case it became the owner's decision — the stamp keeps it out of future
   *  dockets so the court never re-litigates + re-digests it. NULL = never
   *  split (legacy rows + the normal case). */
  court_split_at: string | null;
  /** Court PARK (2026-08-02), the general form of the stamp above: the bench
   *  has taken this case as far as its authority goes and future dockets skip
   *  it. Set for BOTH ways that happens — a split, and the `owner_class`
   *  permanent floor, which previously stamped nothing and was therefore
   *  re-litigated nightly forever. NULL = still seatable. The row stays
   *  `pending`: parking removes it from the BENCH rotation only, never from
   *  the owner's queue. */
  court_parked_at?: string | null;
  /** Why it was parked — 'split' | 'step_up' | 'packet' | 'floor_tool'.
   *  Diagnostic + digest copy; never a decision rule — EXCEPT that 'split'
   *  parks are a cooldown rather than a grave (see `rehear_split`). */
  court_parked_reason?: string | null;
  /** Times the bench has re-heard this parked split (drain fix, 2026-08-02). */
  court_rehear_count?: number;
  /** Precedent memory (C3, 2026-07-05): the decided history's nearest cases,
   *  stamped at create() as EVIDENCE for the court/owner surfaces —
   *  `{ matched_at, matches: PrecedentAttachment[] }`. Optional (hand-built
   *  fixture rows omit it); NULL = filed dark / no matches. Never a decision
   *  rule. */
  precedent_json?: string | null;
  /** Action set the user can choose from, computed at create time
   *  per `compute_proposal_actions(kind, payload)`. Persisted as JSON
   *  in `actions_json`; null on legacy rows that pre-date this
   *  column, in which case the read layer falls back to the
   *  default Approve/Deny set. */
  actions: ProposalAction[];
  /** Which action the user picked when deciding — `'approve'` /
   *  `'reject'` on the legacy path; kind-specific tokens (`'send'`,
   *  `'edit'`, `'file_only'`, …) on the dynamic path. Null until
   *  decided. Persists in `action_taken` column for audit + dashboards
   *  ("how often does Jasper pick 'edit time' on calendar events?"). */
  action_taken: string | null;
}

/**
 * Default action set when `actions_json` is null on a legacy row or
 * when a kind's renderer doesn't have a switch arm yet. Keeps the
 * pre-dynamic-actions UI working unchanged.
 */
export const DEFAULT_ACTIONS: ProposalAction[] = [
  { id: 'approve', label: 'Approve', style: 'primary', effect: 'execute' },
  { id: 'reject', label: 'Deny', style: 'destructive', effect: 'reject' },
];

/**
 * Raw SQL row shape — the literal columns SELECT * returns. The
 * `actions_json` column is parsed into `actions: ProposalAction[]`
 * inside `hydrate_proposal_row` below; consumers get the rich
 * `ProposalRow` shape, never the raw form.
 */
interface ProposalRowRaw extends Omit<ProposalRow, 'actions' | 'action_taken'> {
  actions_json: string | null;
  action_taken: string | null;
}

/**
 * Turn a raw row from `SELECT * FROM proposals` into the hydrated
 * `ProposalRow` consumers expect. Centralises the `actions_json`
 * parse + default fallback so a malformed / null column never reaches
 * client code as a missing field.
 */
function hydrate_proposal_row(raw: ProposalRowRaw): ProposalRow {
  let actions: ProposalAction[] = DEFAULT_ACTIONS;
  if (raw.actions_json) {
    try {
      const parsed = JSON.parse(raw.actions_json) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) {
        actions = parsed as ProposalAction[];
      }
    } catch {
      // Malformed actions_json shouldn't crash the read — fall back
      // to the default set so the client still renders something
      // actionable.
    }
  }
  const { actions_json: _ignored, ...rest } = raw;
  return { ...rest, actions, action_taken: raw.action_taken };
}

export interface DecideResult {
  status: ProposalStatus;
  execution_kind: ProposalExecutionKind;
  /** When approved + dispatch/web_action, the runtime should execute. */
  should_execute: boolean;
  signature_hash: string | null;
  autonomy_status: AutonomyStatus | null;
}

export interface GraduationCandidate {
  signature_hash: string;
  signature: CategorySignature;
  current_status: AutonomyStatus;
  proposed_status: AutonomyStatus;
  approval_count: number;
  edit_count: number;
  denial_count: number;
  reason: string;
}

/**
 * Per-specialist behavioral-eval health over the graduation gate's lookback
 * window. The eval-health gate and Mariah's program_dashboard both read this
 * (one computation, one window) so the dashboard shows exactly the health the
 * gate enforces. A specialist with NO runs in the window is ABSENT from the
 * map — the gate reads absence as "unknown → pass" (new-hire fail-open).
 */
export interface SpecialistEvalHealth {
  specialist_id: string;
  /** Distinct golden tasks with at least one run in the window. */
  tasks_total: number;
  /** Tasks whose LATEST run in the window passed. */
  tasks_passing: number;
  /** Tasks whose LATEST run in the window failed — the gate blocks on >0. */
  tasks_failing: number;
  /** tasks_passing / tasks_total, 0..1 (1 when no tasks, by construction). */
  pass_rate: number;
  /** The failing tasks' ids — the `eval:<id>` misses Beatrice must close. */
  failing_task_ids: string[];
  window_days: number;
}

export interface AutonomyConfig {
  amount_cap_cents: number;
  min_approvals_for_tier2b: number;
  min_approvals_for_tier2c: number;
  min_approvals_for_tier3: number;
  /**
   * Minimum authenticity score (0-100, from Mariah's daily
   * scan_specialist_authenticity) a specialist must hold to earn
   * graduation to the named tier. Below the threshold, graduation
   * candidates for any signature OWNED by that specialist are held —
   * approvals still accumulate, but the recommendation isn't surfaced.
   *
   * Default thresholds are conservative: a specialist who's been
   * fabricating doesn't earn more autonomy until the fabrication rate
   * comes down. Beatrice's persona/tool/config fixes shipped from
   * authenticity findings are the path back up.
   *
   * A specialist with no scan history yet (new hire, never scanned)
   * is treated as "unknown" — graduation continues to depend only on
   * approvals, so a fresh specialist isn't permanently blocked by
   * a never-computed score.
   */
  min_authenticity_score_for_tier2b: number;
  min_authenticity_score_for_tier2c: number;
  min_authenticity_score_for_tier3: number;
  /**
   * Eval-health gate (2026-06-14). When true, a signature does NOT
   * graduate while its owning specialist has a behavioral regression
   * standing — i.e. the most recent run, within `eval_health_window_days`,
   * of ANY golden eval task owned by that specialist FAILED. A specialist
   * fabricating/denying in the regression suite shouldn't earn more
   * autonomy until the behavior is fixed and the eval goes green again.
   *
   * Fail-open, mirroring the authenticity floor's new-hire pass-through:
   * a specialist with NO eval runs in the window is "unknown" and passes
   * the gate — a brand-new specialist isn't blocked before the first
   * nightly eval run has ever scored it.
   *
   * Path back up: the pass→fail transition already files an
   * `eval:<task_id>` process_miss into Mariah's ledger; Beatrice ships the
   * fix; the next nightly run flips the task green; the gate opens.
   */
  require_eval_health_for_graduation: boolean;
  /** Lookback for the eval-health gate (and the dashboard's pass-rate
   *  lens, which reads the same value so Mariah sees the window the gate
   *  uses). Days. */
  eval_health_window_days: number;
  excluded_signatures: string[]; // hashes
  web_action_graduation_enabled: boolean;
  hard_excluded_categories: string[];
  /**
   * Trust Ladder (RPG XP, 2026-06-20). When HEARTH_TRUST_XP is on, each
   * decided proposal accrues XP on its signature (accept=+ / deny=−, weighted
   * by action×risk) and a signature must hold the XP threshold for its tier —
   * ANDed with the approval-count gate — to graduate. YAML-overridable as a
   * whole block (shallow-merged like hard_excluded_categories); defaults in
   * src/core/trust_xp.ts. Off → no XP written, graduation byte-identical.
   */
  trust_xp: TrustXpConfig;
}

const DEFAULT_AUTONOMY_CONFIG: AutonomyConfig = {
  amount_cap_cents: 20_000,
  min_approvals_for_tier2b: 5,
  min_approvals_for_tier2c: 10,
  min_approvals_for_tier3: 20,
  min_authenticity_score_for_tier2b: 70,
  min_authenticity_score_for_tier2c: 85,
  min_authenticity_score_for_tier3: 90,
  require_eval_health_for_graduation: true,
  eval_health_window_days: 14,
  excluded_signatures: [],
  web_action_graduation_enabled: false,
  hard_excluded_categories: [
    'legal',
    'medical_prescription',
    'first_time_contact',
    'sensitive_recipient',
  ],
  trust_xp: TRUST_XP_DEFAULTS,
};

/**
 * Canonical-JSON sha256 of a CategorySignature. The hash is stable across
 * key ordering — `JSON.stringify` is not, so we sort recursively.
 */
export function hash_signature(sig: CategorySignature): string {
  const h = createHash('sha256');
  h.update(canonical_json(sig));
  return h.digest('hex');
}

/**
 * Whitespace/case-insensitive equality basis for the re-fire collapse in
 * `create()`. Deliberately NOT a similarity measure — two proposals collapse
 * only when their stated rationale is the same text (a fuzzy match would
 * have wrongly eaten the 2026-06-10 scout pair, two distinct source
 * candidates whose rationales differed only by domain).
 */
function norm_refire_text(text: string | null | undefined): string {
  // Coerce a nullish value rather than throwing: this pure helper is on the
  // re-fire-collapse hot path and must never be the thing that crashes a
  // proposal write. `create()` already defends its rationale contract, but a
  // backstop here keeps any future caller (or `row.rationale_md` read of a
  // legacy NULL) safe too.
  return (text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Strict shape of a real process-miss id: `pm_` + the last 12 chars of a
 * lowercased ULID (see ProcessMissStore.create). A model-composed id like
 * "pm_14_of_35" — the documented fabrication shape — can never match.
 */
const MISS_REF_RE = /\bpm_[0-9a-z]{12}\b/g;

/** How long a declined subject stays declined for re-file purposes. Long
 *  enough to break a daily sweep, short enough that a genuinely revived
 *  concern isn't gagged for a quarter. */
const REFILE_COOLDOWN_DAYS = 14;

/**
 * The count of process misses a proposal CLAIMS it closes, as stated by the
 * filer — `blast_radius` when structured, else the leading number in prose
 * like "Closes 5 open process_misses" / "four open misses trace to …".
 *
 * Read only to compare against what the ledger can actually verify (see
 * `grounding_note`). Returns null when the filing makes no numeric claim,
 * which is not a fault — an honest proposal need not quantify.
 */
export function claimed_miss_count(payload: unknown, rationale: string): number | null {
  const p = payload as Record<string, unknown> | null;
  const blast = p?.blast_radius;
  if (typeof blast === 'number' && Number.isFinite(blast) && blast >= 0) return Math.floor(blast);
  const WORDS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10,
  };
  const m = rationale.match(
    /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\b[^.\n]{0,40}?\b(?:open\s+)?(?:process[_ ]?)?miss(?:es)?\b/i,
  );
  if (!m || !m[1]) return null;
  const raw = m[1].toLowerCase();
  return /^\d+$/.test(raw) ? Number(raw) : (WORDS[raw] ?? null);
}

/**
 * A system-stamped grounding line appended to a systemic proposal's stored
 * rationale, or null when there is nothing to correct.
 *
 * This exists because the court demonstrably rewarded confabulation. The
 * 2026-05-25 connector-recovery batch was terse and honest — one reads
 * "Closes 0 open process_misses" — and got skipped. By 2026-05-30 the same
 * template had grown checkable-sounding narrative ("Closes 5 open misses
 * across Brigid, Maggie, and me") and got approved and fired builds. The
 * story-shaped rationale outcompeted the honest one, because nothing on the
 * path from filing to verdict ever checked whether the numbers were real.
 *
 * It corrects rather than blocks, on purpose: the filer's own words are kept
 * verbatim, and the ledger's count is stated next to them so the court reads
 * both. A specialist that cites accurately is never touched.
 */
export function grounding_note(
  refs_cited: readonly string[],
  refs_validated: ReadonlySet<string>,
  claimed: number | null,
): string | null {
  const cited = refs_cited.length;
  const valid = refs_validated.size;
  const overclaims = claimed !== null && claimed > valid;
  const fabricated = cited > valid;
  if (!overclaims && !fabricated) return null;
  const parts: string[] = [];
  if (claimed !== null) parts.push(`claims to close ${claimed}`);
  parts.push(
    cited === 0
      ? 'cites no pm_* miss ids'
      : `cites ${cited} pm_* id${cited === 1 ? '' : 's'}, ${valid} of which exist in the ledger`,
  );
  return (
    `\n\n[GROUNDING — system-verified at filing] This proposal ${parts.join('; ')}. ` +
    `Treat the unverified portion as unsupported: weigh the argument on what ` +
    `the ledger confirms, not on the stated count.`
  );
}

/**
 * Collect the pm_* refs a proposal cites. The regex runs over the
 * serialized payload AND the rationale, so a structured field
 * (`closes_miss_ids`, `cited_miss_ids`) and an inline prose mention are
 * collected alike — the filer doesn't have to know which channel counts.
 */
function extract_miss_refs(payload_json: string, rationale: string): string[] {
  const refs = new Set<string>();
  for (const m of `${payload_json}\n${rationale}`.matchAll(MISS_REF_RE)) {
    refs.add(m[0]);
  }
  return [...refs];
}

function canonical_json(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonical_json(v)).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map((k) => {
    const v = (value as Record<string, unknown>)[k];
    return JSON.stringify(k) + ':' + canonical_json(v);
  });
  return '{' + parts.join(',') + '}';
}

/**
 * Maps a specialist *reference* (id, display name, or alias) to the
 * canonical registered id, or null when nothing matches. Wired by the
 * orchestrator to `SpecialistRegistry.resolve_id` so the store stays
 * registry-agnostic (self-contained smokes construct it without one).
 */
export type SpecialistIdResolver = (candidate: string) => string | null;

/**
 * Thrown by `create()` when a resolver is wired and the proposal's
 * `specialist_id` resolves to nothing on the roster. A row filed under
 * an id no registered specialist owns is invisible to per-specialist
 * queue filters and corrupts category-signature/autonomy attribution
 * (the live 2026-06-10 'beatrice'/'maggia'/'all' rows) — better to
 * reject loudly at the chokepoint than to land an unfilterable row.
 */
export class UnknownSpecialistError extends Error {
  constructor(public readonly candidate: string) {
    super(
      `no registered specialist matches '${candidate}' (not an id, display ` +
        `name, or alias). Proposals must be filed under a registered ` +
        `specialist id.`,
    );
    this.name = 'UnknownSpecialistError';
  }
}

export class ProposalsStore {
  private resolve_specialist: SpecialistIdResolver | null = null;

  constructor(
    private db: Database,
    private cfg: AutonomyConfig = DEFAULT_AUTONOMY_CONFIG,
  ) {}

  /** Wire the registry-backed id resolver (orchestrator boot). Absent —
   *  self-contained smokes, read-only pane construction — `create()`
   *  accepts ids as-is, preserving pre-resolver behavior. */
  set_specialist_resolver(fn: SpecialistIdResolver): void {
    this.resolve_specialist = fn;
  }

  /**
   * Canonicalize the filer + signature attribution before anything is
   * hashed or persisted. Display names and aliases normalize to the
   * registered id ('Beatrice' → 'trainer'); an unresolvable filer
   * throws `UnknownSpecialistError`; an unresolvable SIGNATURE owner
   * falls back to the (already-validated) filer — the signature's
   * specialist_id gates autonomy graduation against that specialist's
   * authenticity score, so garbage there silently detaches a signature
   * from any real specialist. No-op when no resolver is wired.
   */
  private _canonical_attribution(p: NewProposal): NewProposal {
    if (!this.resolve_specialist) return p;
    const filer = this.resolve_specialist(p.specialist_id);
    if (!filer) throw new UnknownSpecialistError(p.specialist_id);
    const sig_candidate = p.signature.specialist_id;
    const sig_owner = this.resolve_specialist(sig_candidate) ?? filer;
    if (filer === p.specialist_id && sig_owner === sig_candidate) return p;
    console.warn(
      `[proposals] specialist_id normalized at create(): ` +
        `filer '${p.specialist_id}' → '${filer}', ` +
        `signature '${sig_candidate}' → '${sig_owner}'`,
    );
    return {
      ...p,
      specialist_id: filer,
      signature: { ...p.signature, specialist_id: sig_owner },
    };
  }

  /** Replace the autonomy config in memory (called by chokidar reload). */
  set_config(cfg: AutonomyConfig): void {
    this.cfg = cfg;
  }

  config(): AutonomyConfig {
    return this.cfg;
  }

  create(p: NewProposal): string {
    // Attribution first — everything below (signature hash, dedup
    // lookups, the INSERT) must see canonical ids, never a display
    // name, alias, or typo an LLM authored.
    p = this._canonical_attribution(p);
    // Defend the NewProposal contract. `rationale` is typed `string`, but a
    // proposal lifted out of an LLM-authored deliberation envelope can omit
    // `rationale_md` and reach here as undefined — crashing `norm_refire_text`
    // on the re-fire-collapse path and (had it gotten that far) binding NULL
    // into the NOT NULL `rationale_md` column. Coerce once so EVERY downstream
    // read (collapse, miss-ref extraction, title/summary, the INSERT, the FTS
    // body) sees a real string. An empty rationale is graceful, not fatal: the
    // collapse check already guards `rationale_norm.length > 0`, and title /
    // summary derive from kind + payload — so an otherwise-valid proposal still
    // files instead of being silently lost.
    if (typeof p.rationale !== 'string') {
      p = { ...p, rationale: '' };
    }
    const id = ulid();
    const ts = new Date().toISOString();
    const hash = hash_signature(p.signature);
    const payload_json = JSON.stringify(p.payload);

    // Idempotency check — Beatrice (and others) sometimes re-fire the
    // same proposal seconds apart when an LLM round didn't visibly
    // commit. If we already hold an open proposal with the same
    // specialist + category_signature and the same STATED CONTENT —
    // byte-equal payload, or the same normalized rationale — return
    // its id and skip the insert. The byte-payload match alone was not
    // enough: a re-fire whose payload carries an LLM-synthesized field
    // (briefing `body_md`) differs every call even when the signature
    // AND the rationale are identical (the 2026-06-10 "Kate pending
    // interrupts escalation" twins). The rationale is the stable
    // statement of the thinking; the volatile payload is exactly the
    // wrong thing to key on. Window matches "this is a re-fire of the
    // same thinking" rather than a deliberate re-file later: 24h.
    // Denied, failed, and executed proposals don't block — a
    // specialist may legitimately re-attempt after one of those
    // terminals.
    const cutoff = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const rationale_norm = norm_refire_text(p.rationale);
    const dup_candidates = this.db
      .prepare(
        // `acknowledged` joins `pending` + approved-not-executed as a
        // re-fire BLOCKER: it's the terminal state a manual/advisory approval
        // now lands in (it used to sit at `approved` with ts_executed NULL,
        // which this clause already caught), so a same-signature re-fire
        // within the window still collapses exactly as before. Hard terminals
        // (executed/denied/failed/…) still allow a legitimate re-attempt.
        `SELECT id, status, payload_json, rationale_md FROM proposals
         WHERE specialist_id = @sid
           AND category_signature_hash = @h
           AND status IN ('pending', 'approved', 'acknowledged', 'pending_kate_review')
           AND (status IN ('pending', 'acknowledged', 'pending_kate_review') OR ts_executed IS NULL)
           AND ts_created >= @cutoff
         ORDER BY ts_created DESC`,
      )
      .all({
        '@sid': p.specialist_id,
        '@h': hash,
        '@cutoff': cutoff,
      }) as Array<{ id: string; status: string; payload_json: string; rationale_md: string }>;
    const dup = dup_candidates.find(
      (row) =>
        row.payload_json === payload_json ||
        (rationale_norm.length > 0 && norm_refire_text(row.rationale_md) === rationale_norm),
    );
    if (dup) {
      // Log via console — the audit_log entry for the *tool* (e.g.
      // propose_action) will still record the call; this surfaces
      // why no new row landed for follow-up debugging.
      console.log(
        `[proposals] idempotency-collapse: ${p.specialist_id} re-filed ` +
          `signature ${hash.slice(0, 12)} matching existing ${dup.status} ` +
          `proposal ${dup.id} — returning existing id instead of creating new`,
      );
      return dup.id;
    }

    // Supersession check — a different payload that shares the
    // proposal's *subject* (e.g. another persona-tuning for the same
    // specialist, another connector-recovery for the same tool, etc.)
    // marks the older open row `superseded` and pointers it at the
    // new id. The byte-exact idempotency above can't catch this case;
    // Beatrice refining a proposal almost always changes the payload
    // (verbatim_feedback, proposed_change, etc.) even when the
    // subject is identical.
    //
    // Only kinds whose subject can be cleanly derived from payload
    // opt in (see `compute_dedup_key`). Returning null = no
    // supersession; the row lives as an independent entry.
    const dedup_key = compute_dedup_key(p.kind, p.payload);

    // Re-file cooldown — supersession only ever looked at OPEN rows, so a
    // subject that was DECLINED simply freed its slot and came straight
    // back. `read_note` connector-recovery recurred 6+ times on an
    // identical category_signature_hash that way, and the wider sweep ran
    // 79 filings deep over nine weeks.
    //
    // The rule is narrow on purpose: suppress only when the same subject
    // was already declined recently AND the filer brings no new validated
    // evidence. A re-file that cites a pm_* miss the declined one didn't
    // is real news and files normally, however recently the last one lost.
    // That keeps this from becoming a gag on legitimate re-escalation —
    // the failure mode we'd be trading for.
    if (dedup_key) {
      const refs_now = this._validated_miss_refs(
        extract_miss_refs(payload_json, p.rationale),
      );
      const blocker = this._recently_declined_same_subject(dedup_key, refs_now);
      if (blocker) {
        console.log(
          `[proposals] refile-cooldown: ${p.specialist_id}'s ${p.kind} for ` +
            `dedup_key ${dedup_key} was already declined as ${blocker.id} ` +
            `(${blocker.status}, ${blocker.ts_decided}) and cites no new ` +
            `validated misses — returning that id instead of re-filing`,
        );
        return blocker.id;
      }
    }

    if (dedup_key) {
      const open_with_same_key = this.db
        .prepare(
          `SELECT id FROM proposals
           WHERE dedup_key = @dk
             AND status IN ('pending', 'snoozed', 'pending_kate_review')
           ORDER BY ts_created DESC`,
        )
        .all({ '@dk': dedup_key }) as Array<{ id: string }>;
      if (open_with_same_key.length > 0) {
        // bun:sqlite rejects mixed named + positional bindings in one
        // .run(), so iterate. N is bounded by the number of open
        // proposals with the same subject — usually 1, rarely > 3.
        const stmt = this.db.prepare(
          `UPDATE proposals
           SET status = 'superseded',
               superseded_by = @new_id,
               superseded_at = @ts
           WHERE id = @id`,
        );
        for (const row of open_with_same_key) {
          stmt.run({ '@new_id': id, '@ts': ts, '@id': row.id });
        }
        console.log(
          `[proposals] supersession: ${p.specialist_id}'s new ${p.kind} ` +
            `(${id}) supersedes ${open_with_same_key.length} earlier row` +
            `(s) with dedup_key ${dedup_key}: ` +
            open_with_same_key.map((r) => r.id).join(', '),
        );
      }
    }

    // Root-cause supersession — a systemic proposal (SYSTEM_PROPOSAL_KINDS)
    // names the open process misses its fix closes, and those pm_* ids are
    // the DURABLE subject where the LLM-authored dedup_key slug drifts
    // ("research-efficiency-injection" vs "runtime-research-efficiency-
    // injection" filed the same fix twice on 2026-06-10, plus a third
    // cross-kind recommendation restating it). When the new proposal's
    // VALIDATED refs cover ≥60% of an open systemic row's refs, the new
    // filing supersedes it — across kinds on purpose. New-side refs are
    // validated against the process_misses ledger, so a fabricated id can
    // never TRIGGER supersession; old-side refs stay unvalidated, which
    // only raises the coverage denominator and fails safe (less
    // supersession, never more). A narrow fix citing one miss of a broad
    // cluster does NOT displace the cluster proposal (coverage stays low).
    if (SYSTEM_PROPOSAL_KINDS.has(p.kind)) {
      const refs_new = this._validated_miss_refs(
        extract_miss_refs(payload_json, p.rationale),
      );
      if (refs_new.size > 0) {
        const kind_list = [...SYSTEM_PROPOSAL_KINDS];
        const open_rows = this.db
          .prepare(
            `SELECT id, kind, payload_json, rationale_md FROM proposals
             WHERE status IN ('pending', 'snoozed', 'pending_kate_review')
               AND kind IN (${kind_list.map(() => '?').join(', ')})`,
          )
          .all(...kind_list) as Array<{
          id: string;
          kind: string;
          payload_json: string;
          rationale_md: string;
        }>;
        const supersede_stmt = this.db.prepare(
          `UPDATE proposals
           SET status = 'superseded',
               superseded_by = @new_id,
               superseded_at = @ts
           WHERE id = @id`,
        );
        for (const row of open_rows) {
          const refs_old = extract_miss_refs(row.payload_json, row.rationale_md);
          if (refs_old.length === 0) continue;
          const shared = refs_old.filter((r) => refs_new.has(r)).length;
          if (shared / refs_old.length < 0.6) continue;
          supersede_stmt.run({ '@new_id': id, '@ts': ts, '@id': row.id });
          console.log(
            `[proposals] miss-ref supersession: ${p.specialist_id}'s new ` +
              `${p.kind} (${id}) supersedes ${row.kind} ${row.id} — ` +
              `shares ${shared}/${refs_old.length} pm_* refs`,
          );
        }
      }
    }

    const title = compute_proposal_title(p.kind, p.payload, p.rationale);
    const summary = compute_proposal_summary(p.kind, p.payload, p.rationale);
    // The action set is computed at create time — clients render
    // exactly what the author intended even if the kind's renderer
    // changes later. compute_proposal_actions falls back to DEFAULT_ACTIONS
    // for kinds that haven't been customized yet.
    const actions = compute_proposal_actions(p.kind, p.payload);
    const actions_json = JSON.stringify(actions);

    // Upsert signature row (insert if new; no count change here).
    const existing = this.db
      .prepare(`SELECT hash FROM category_signatures WHERE hash = @h`)
      .get({ '@h': hash }) as { hash: string } | undefined;
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO category_signatures
           (hash, signature_json, approval_count, edit_count,
            denial_count, autonomy_status)
           VALUES (@h, @sig, 0, 0, 0, 'tier2a')`,
        )
        .run({
          '@h': hash,
          '@sig': JSON.stringify(p.signature),
        });
    }

    // Per-user cordon: a self-improvement kind is always owner-global
    // (NULL); any other kind carries the originating user's id (or NULL
    // when none was threaded — e.g. an internal/system caller).
    const scoped_user = SYSTEM_PROPOSAL_KINDS.has(p.kind)
      ? null
      : p.user_id ?? null;

    // Kate pre-review gate (2026-06-15): a trainer-authored self-improvement
    // SPEC is born `pending_kate_review` — hidden from the owner queue until
    // Kate promotes it — so she is the critic + final reviewer before it
    // reaches him. `skip_kate_review` (the review_change merge-card, filed
    // AFTER Kate already reviewed the code) opts straight to `pending`.
    const initial_status: ProposalStatus =
      !p.skip_kate_review &&
      p.specialist_id === 'trainer' &&
      KATE_REVIEW_KINDS.has(p.kind)
        ? 'pending_kate_review'
        : 'pending';

    // Grounding stamp — computed HERE, after every hash/dedup/idempotency
    // read above has already seen the filer's original words, so appending
    // it can never perturb collapse or supersession behaviour.
    //
    // Systemic kinds only: those are the ones whose rationale argues from a
    // miss count ("closes 5 open misses") to a court that had no way to
    // check it. Fail-open — a grounding read that throws must never cost us
    // the proposal.
    let rationale_stored = p.rationale;
    if (SYSTEM_PROPOSAL_KINDS.has(p.kind)) {
      try {
        const cited = extract_miss_refs(payload_json, p.rationale);
        const note = grounding_note(
          cited,
          this._validated_miss_refs(cited),
          claimed_miss_count(p.payload, p.rationale),
        );
        if (note) {
          rationale_stored += note;
          console.log(
            `[proposals] grounding-stamp: ${p.specialist_id}'s ${p.kind} (${id}) ` +
              `cites ${cited.length} pm_* ref(s) — stamped for the court`,
          );
        }
      } catch {
        /* grounding is evidence, not control flow */
      }
    }

    this.db
      .prepare(
        `INSERT INTO proposals
         (id, ts_created, specialist_id, kind, execution_kind,
          payload_json, rationale_md, category_signature_hash, status,
          title, summary, dedup_key, actions_json, user_id)
         VALUES (@id, @ts, @sid, @kind, @ek, @pl, @rat, @h, @status,
                 @title, @summary, @dk, @actions, @user_id)`,
      )
      .run({
        '@id': id,
        '@ts': ts,
        '@sid': p.specialist_id,
        '@kind': p.kind,
        '@ek': p.execution_kind,
        '@pl': payload_json,
        '@rat': rationale_stored,
        '@h': hash,
        '@status': initial_status,
        '@title': title,
        '@summary': summary,
        '@dk': dedup_key,
        '@actions': actions_json,
        '@user_id': scoped_user,
      });

    // Index searchable text into proposals_fts.
    this.db
      .prepare(
        `INSERT INTO proposals_fts (body, proposal_id, specialist_id)
         VALUES (@body, @id, @sid)`,
      )
      .run({
        '@body': `${p.rationale}\n\n${JSON.stringify(p.payload)}`,
        '@id': id,
        '@sid': p.specialist_id,
      });

    // Precedent memory (C3, 2026-07-05): stamp the decided history's nearest
    // cases onto the row the court/owner reads. Deterministic text match —
    // create() is sync; the vector path lives in the async reads (the court
    // gather + recall_precedent). Its OWN column, never the payload: payload
    // contracts are strict (CalendarEventPayloadSchema etc.) and belong to
    // the author. EVIDENCE only, never a decision rule; fail-open — a dark
    // flag / missing table / any error leaves the column NULL.
    if (precedent_enabled()) {
      try {
        const matches = match_precedent_text(
          this.db,
          `${p.kind} ${title ?? ''} ${summary ?? ''} ${p.rationale}`.trim(),
          { proposal_user_id: scoped_user, k: 3, exclude_proposal_id: id },
        );
        if (matches.length > 0) {
          this.db
            .prepare(`UPDATE proposals SET precedent_json = @pj WHERE id = @id`)
            .run({ '@pj': JSON.stringify({ matched_at: ts, matches }), '@id': id });
        }
      } catch {
        /* precedent is evidence, never load-bearing for a filing */
      }
    }

    return id;
  }

  get(id: string): ProposalRow | null {
    const row = this.db
      .prepare(`SELECT * FROM proposals WHERE id = @id`)
      .get({ '@id': id }) as ProposalRowRaw | undefined;
    return row ? hydrate_proposal_row(row) : null;
  }

  /**
   * Of `refs`, the ids that actually exist in the process_misses ledger —
   * the anti-fabrication gate for root-cause supersession. Fails dark
   * (empty set) when the table is absent: a db without the miss ledger
   * simply has no miss-ref supersession.
   */
  /**
   * A recently-DECLINED proposal on the same subject that the new filing
   * adds no evidence to — the re-file cooldown's blocker, or null to let
   * the filing through.
   *
   * "Declined" is deliberately the soft terminals: `denied`, `expired`,
   * `superseded`, and `acknowledged` (the state a card lands in when it is
   * read and dropped rather than acted on — which is where 54 of the 79
   * connector-recovery filings went). `executed` and `failed` are NOT
   * blockers: work that ran, or tried to run and broke, may legitimately
   * need re-filing.
   *
   * The evidence escape hatch is what keeps this honest. If the new filing
   * validates even one pm_* miss the declined one never cited, the subject
   * has genuinely moved and it files normally.
   */
  private _recently_declined_same_subject(
    dedup_key: string,
    refs_now: ReadonlySet<string>,
  ): { id: string; status: string; ts_decided: string | null } | null {
    const cutoff = new Date(Date.now() - REFILE_COOLDOWN_DAYS * 86_400_000).toISOString();
    let rows: Array<{
      id: string;
      status: string;
      ts_decided: string | null;
      payload_json: string;
      rationale_md: string;
    }>;
    try {
      rows = this.db
        .prepare(
          `SELECT id, status, ts_decided, payload_json, rationale_md FROM proposals
           WHERE dedup_key = @dk
             AND status IN ('denied', 'expired', 'superseded', 'acknowledged')
             AND COALESCE(ts_decided, ts_created) >= @cutoff
           ORDER BY COALESCE(ts_decided, ts_created) DESC
           LIMIT 25`,
        )
        .all({ '@dk': dedup_key, '@cutoff': cutoff }) as typeof rows;
    } catch {
      return null; // never let the cooldown break a filing
    }
    if (rows.length === 0) return null;
    // Everything the declined filings already cited. New evidence means a
    // validated ref outside that union.
    const already = new Set<string>();
    for (const r of rows) {
      for (const ref of extract_miss_refs(r.payload_json, r.rationale_md)) already.add(ref);
    }
    for (const ref of refs_now) {
      if (!already.has(ref)) return null; // genuinely new evidence — let it file
    }
    const first = rows[0];
    return first ? { id: first.id, status: first.status, ts_decided: first.ts_decided } : null;
  }

  private _validated_miss_refs(refs: string[]): Set<string> {
    if (refs.length === 0) return new Set();
    try {
      const rows = this.db
        .prepare(
          `SELECT id FROM process_misses WHERE id IN (${refs.map(() => '?').join(', ')})`,
        )
        .all(...refs) as Array<{ id: string }>;
      return new Set(rows.map((r) => r.id));
    } catch {
      return new Set();
    }
  }

  /**
   * Expire stale FYI cards. A proposal whose own action set offers no
   * decision — no 'execute' and no 'reject' effect, e.g. a briefing's
   * Got-it/Discuss/Snooze — is a read item, not a decision, and used to sit
   * 'pending' forever when unacknowledged. The test is per-row from the
   * stored `actions_json` (the author's intended action set), never a kind
   * list. Rows the user has snoozed are exempt — an explicit defer means
   * "show me later", which expiry would contradict. Legacy rows without
   * actions_json hydrate to DEFAULT_ACTIONS (decision actions) and are
   * never expired here. Returns the expired ids for audit.
   */
  /**
   * Expire ONE pending/snoozed proposal without a decide() — the Proposal
   * Court's lapse action (2026-07-02). No XP effect on purpose: a lapsed
   * offer is not a rejected one; the filer isn't punished for silence.
   */
  expire_one(id: string, reason: string): boolean {
    const row = this.get(id);
    if (!row || (row.status !== 'pending' && row.status !== 'snoozed')) return false;
    this.db
      .prepare(
        `UPDATE proposals SET status = 'expired', ts_decided = @ts, user_feedback = @why WHERE id = @id`,
      )
      .run({ '@ts': new Date().toISOString(), '@why': reason.slice(0, 500), '@id': id });
    return true;
  }

  /**
   * Park a case: the bench has taken it as far as its authority goes, so
   * future dockets skip it.
   *
   * Generalizes the 2026-07-04 split stamp. A split was only one of the two
   * ways a case becomes the owner's — the other, `owner_class` (the permanent
   * send_/spend_/step-up floor), stamped nothing, so the court re-seated and
   * re-digested it every convening forever. `is_owner_only` reads only the
   * row's own payload, so re-examining such a case cannot produce a different
   * verdict; the one genuinely unstable branch (an unknown dispatch tool that
   * may later be registered) is deliberately NOT parked by the caller.
   *
   * Parking is a BENCH-rotation stamp only: the row stays `pending` and keeps
   * its place in the owner's queue. Idempotent — the first stamp wins, so the
   * digest announces a parked case exactly once.
   */
  park_for_owner(id: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE proposals
            SET court_parked_at = @ts,
                court_parked_reason = @reason,
                -- legacy mirror: the 07-04 column, still written for splits so
                -- a rollback to the previous build keeps its docket exclusion.
                court_split_at = CASE WHEN @reason = 'split'
                                      THEN COALESCE(court_split_at, @ts)
                                      ELSE court_split_at END
          WHERE id = @id AND court_parked_at IS NULL`,
      )
      .run({ '@ts': new Date().toISOString(), '@reason': reason.slice(0, 40), '@id': id });
  }

  /**
   * Re-seat a parked SPLIT after its cooldown — the drain fix (2026-08-02).
   *
   * Parking is right for a case the bench has no authority over: the
   * `step_up` / `packet` / `floor_tool` reasons are pure functions of the
   * row's payload, so re-examining one cannot change the answer. A SPLIT is
   * categorically different — the bench HAD authority and merely disagreed,
   * on evidence that was current that day. Parking it under the same rule
   * made the disagreement permanent, and since the owner's tap is then the
   * only exit, every split he never got to simply accreted. Live proof: all
   * 28 pending proposals carried outcome `split`, each judged exactly ONCE,
   * the oldest sitting 41 days.
   *
   * So a split park is a COOLDOWN. Bumping `court_parked_at` rather than
   * clearing it is what makes the cooldown recur, instead of the case being
   * re-seated at every convening forever once its first cooldown expires;
   * the counter bounds the retries so a genuinely undecidable case lapses
   * rather than cycling.
   *
   * Returns false when the row moved on (decided, superseded) meanwhile.
   */
  rehear_split(id: string, now: Date = new Date()): boolean {
    const res = this.db
      .prepare(
        `UPDATE proposals
            SET court_parked_at = @ts,
                court_rehear_count = court_rehear_count + 1
          WHERE id = @id
            AND status IN ('pending','snoozed')
            AND court_parked_reason = 'split'`,
      )
      .run({ '@ts': now.toISOString(), '@id': id });
    return res.changes > 0;
  }

  /**
   * Parked splits whose cooldown has elapsed, oldest park first. A row whose
   * `court_rehear_count` has reached the caller's budget is its cue to lapse
   * the case deterministically rather than seat it again.
   */
  splits_due_for_rehearing(opts: { cooldown_days: number; limit?: number }): ProposalRow[] {
    const cutoff = new Date(Date.now() - opts.cooldown_days * 86_400_000).toISOString();
    return this.db
      .prepare(
        `SELECT * FROM proposals
          WHERE status = 'pending'
            AND court_parked_reason = 'split'
            AND court_parked_at IS NOT NULL
            AND court_parked_at <= @cut
          ORDER BY court_parked_at ASC
          LIMIT @lim`,
      )
      .all({ '@cut': cutoff, '@lim': opts.limit ?? 50 }) as ProposalRow[];
  }

  /**
   * What actually became of what each specialist filed — the drain read as a
   * LEARNING signal rather than a queue statistic.
   *
   * A single lapse teaches nothing and is deliberately unpunished: the filer
   * is not answerable for the owner's silence. A PATTERN of lapses is
   * different information — it says this class of filing does not land in
   * this household, which is exactly what the system should notice on its own
   * instead of re-filing forever. Grouped by (specialist, kind) because that
   * is the unit a filing budget can act on.
   */
  filing_yield(opts: { window_days: number }): FilingYieldRow[] {
    const cutoff = new Date(Date.now() - opts.window_days * 86_400_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT specialist_id, kind, status, COUNT(*) n
           FROM proposals WHERE ts_created >= @cut
          GROUP BY specialist_id, kind, status`,
      )
      .all({ '@cut': cutoff }) as Array<{
      specialist_id: string;
      kind: string;
      status: string;
      n: number;
    }>;
    const acc = new Map<string, FilingYieldRow>();
    for (const r of rows) {
      const key = `${r.specialist_id} ${r.kind}`;
      let g = acc.get(key);
      if (!g) {
        g = {
          specialist_id: r.specialist_id,
          kind: r.kind,
          filed: 0,
          acted: 0,
          denied: 0,
          lapsed: 0,
          open: 0,
          yield_rate: null,
        };
        acc.set(key, g);
      }
      g.filed += r.n;
      // The same verdict axis the court scorecard and the reflection throttle
      // use, so "landed" means one thing across all three.
      if (['approved', 'acknowledged', 'executed', 'failed'].includes(r.status)) g.acted += r.n;
      else if (r.status === 'denied') g.denied += r.n;
      else if (r.status === 'expired') g.lapsed += r.n;
      else g.open += r.n; // pending / snoozed / superseded — not yet evidence
    }
    const out = [...acc.values()];
    for (const g of out) {
      const terminal = g.acted + g.denied + g.lapsed;
      g.yield_rate = terminal > 0 ? g.acted / terminal : null;
    }
    return out.sort((a, b) => b.filed - a.filed);
  }

  /**
   * Supersede a set of OPEN rows into a consolidated successor — the Court's
   * theme rollup (2026-07-04). Same semantics as dedup supersession: members
   * flip to 'superseded' with a pointer at the successor (still readable via
   * superseded_by, hidden from the default queue); only pending/snoozed rows
   * flip, and never the successor itself. No XP effect — a rolled-up card is
   * neither approved nor rejected. Returns how many rows actually flipped.
   */
  supersede_into(member_ids: string[], new_id: string): number {
    const ts = new Date().toISOString();
    const stmt = this.db.prepare(
      `UPDATE proposals
       SET status = 'superseded', superseded_by = @new_id, superseded_at = @ts
       WHERE id = @id AND id != @new_id AND status IN ('pending', 'snoozed')`,
    );
    let flipped = 0;
    for (const id of member_ids) {
      const res = stmt.run({ '@new_id': new_id, '@ts': ts, '@id': id });
      if (res.changes && res.changes > 0) flipped++;
    }
    return flipped;
  }

  /**
   * Wake snoozed proposals whose defer window has passed — the other half of
   * `snooze()`, which had no counterpart until 2026-07-18.
   *
   * `snoozed_until` was WRITTEN by snooze() and by the `defer` action, and read
   * everywhere ONLY as `IS NULL` (to exclude a deferred card): the FYI sweep
   * exempts snoozed rows, `rollup_eligible` requires a null, and the Court
   * lists `status: 'pending'` so it never sees them at all. Nothing anywhere
   * compared it to the clock. So "Snooze" was a one-way door — the card left
   * the queue permanently, never woke, never expired, never reached the bench —
   * while `compute_proposal_actions` documents the effect as "snooze 24h,
   * reappears tomorrow" and the button says Decide later. Two live rows had sat
   * deferred since 2026-05-26 and 2026-06-23.
   *
   * Waking restores the row to the queue exactly as it was (status 'pending',
   * window cleared) so it re-enters every normal path — owner queue, TTL sweep,
   * and the Court — rather than getting a second special state. Returns the
   * woken ids for audit.
   */
  wake_snoozed(): string[] {
    const now = new Date().toISOString();
    const rows = this.db
      .prepare(
        `SELECT id FROM proposals
         WHERE status = 'snoozed'
           AND snoozed_until IS NOT NULL
           AND snoozed_until <= @now`,
      )
      .all({ '@now': now }) as Array<{ id: string }>;
    if (rows.length === 0) return [];
    const stmt = this.db.prepare(
      `UPDATE proposals SET status = 'pending', snoozed_until = NULL
       WHERE id = @id AND status = 'snoozed'`,
    );
    const woken: string[] = [];
    for (const row of rows) {
      const res = stmt.run({ '@id': row.id });
      if (res.changes && res.changes > 0) woken.push(row.id);
    }
    return woken;
  }

  expire_stale_fyi(ttl_hours: number): string[] {
    const cutoff = new Date(Date.now() - ttl_hours * 3_600_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT id, actions_json FROM proposals
         WHERE status = 'pending'
           AND snoozed_until IS NULL
           AND ts_created < @cutoff`,
      )
      .all({ '@cutoff': cutoff }) as Array<{ id: string; actions_json: string | null }>;
    if (rows.length === 0) return [];
    const ts = new Date().toISOString();
    const stmt = this.db.prepare(
      `UPDATE proposals
       SET status = 'expired', ts_decided = @ts
       WHERE id = @id AND status = 'pending'`,
    );
    const expired: string[] = [];
    for (const row of rows) {
      if (!row.actions_json) continue;
      let actions: ProposalAction[];
      try {
        const parsed = JSON.parse(row.actions_json) as unknown;
        if (!Array.isArray(parsed) || parsed.length === 0) continue;
        actions = parsed as ProposalAction[];
      } catch {
        continue;
      }
      const is_decision = actions.some(
        (a) => a.effect === 'execute' || a.effect === 'reject',
      );
      if (is_decision) continue;
      stmt.run({ '@ts': ts, '@id': row.id });
      expired.push(row.id);
    }
    return expired;
  }

  list(filter: {
    status?: ProposalStatus;
    specialist_id?: string;
    /** Restrict to one proposal kind (SQL-side — lets kind-scoped sweeps
     *  like the face-card retirement scan avoid paging the whole queue). */
    kind?: string;
    limit?: number;
    /** Include rows where status == 'superseded'. Off by default —
     *  the queue hides superseded proposals so a user can't approve
     *  a stale version of something a newer proposal refined. Turn
     *  on for diagnostics / history views. */
    include_superseded?: boolean;
    /** Per-user cordon. When set, restricts the queue to what this
     *  caller may see: an OWNER sees system proposals (user_id NULL)
     *  plus their own; a non-owner sees ONLY their own user-action
     *  proposals (never system/self-improvement ones — those are the
     *  owner's). Omit for internal/diagnostic callers that want the
     *  unfiltered set. */
    visible_to?: { user_id: string; tier: Tier };
  } = {}): ProposalRow[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.status) {
      clauses.push('status = @status');
      params['@status'] = filter.status;
    } else if (!filter.include_superseded) {
      // No explicit status filter + not asking for superseded —
      // hide them by default. Mirrors the queue user-experience:
      // "if Beatrice replaced an earlier proposal, I want the
      // newer one front and center, not both in my queue."
      // `pending_kate_review` is hidden the same way — it's a holding
      // state awaiting Kate's gate, not an owner-facing card. Only an
      // explicit `status:'pending_kate_review'` query (Kate's review
      // tool) surfaces them.
      clauses.push("status NOT IN ('superseded', 'pending_kate_review')");
    }
    if (filter.specialist_id) {
      clauses.push('specialist_id = @sid');
      params['@sid'] = filter.specialist_id;
    }
    if (filter.kind) {
      clauses.push('kind = @kind');
      params['@kind'] = filter.kind;
    }
    if (filter.visible_to) {
      params['@vuid'] = filter.visible_to.user_id;
      if (filter.visible_to.tier === 'owner') {
        clauses.push('(user_id IS NULL OR user_id = @vuid)');
      } else {
        clauses.push('user_id = @vuid');
      }
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filter.limit ?? 100;
    const raw = this.db
      .prepare(`SELECT * FROM proposals ${where} ORDER BY ts_created DESC LIMIT @lim`)
      .all({ ...params, '@lim': limit }) as ProposalRowRaw[];
    return raw.map(hydrate_proposal_row);
  }

  /**
   * Backfill `title` / `summary` / `dedup_key` for rows that pre-date
   * the supersession columns. Idempotent — only touches rows where
   * the field is NULL. Safe to run at boot or via a script.
   *
   * Returns counts so the caller can log "backfilled N proposals."
   * Does NOT retro-supersede across pre-existing rows: superseding
   * an already-approved proposal would invalidate prior audit. Only
   * NEW writes after this code lands trigger supersession.
   */
  backfill_titles(): { rows_seen: number; rows_updated: number } {
    // Note: we deliberately do NOT match on `dedup_key IS NULL` —
    // kinds without a clean subject (action_proposal, draft_message)
    // are SUPPOSED to have null dedup_key. Matching on it would
    // re-touch those rows on every boot. Title + summary are the
    // signals we backfill; dedup_key gets recomputed in the same
    // pass for genuinely-legacy rows (which also have null title).
    const rows = this.db
      .prepare(
        `SELECT id, kind, payload_json, rationale_md, dedup_key, title, summary
         FROM proposals
         WHERE title IS NULL OR summary IS NULL`,
      )
      .all() as Array<{
      id: string;
      kind: ProposalKind;
      payload_json: string;
      rationale_md: string;
      dedup_key: string | null;
      title: string | null;
      summary: string | null;
    }>;
    let updated = 0;
    const stmt = this.db.prepare(
      `UPDATE proposals SET title = @t, summary = @s, dedup_key = @dk WHERE id = @id`,
    );
    for (const row of rows) {
      let payload: unknown = null;
      try { payload = JSON.parse(row.payload_json); } catch { payload = null; }
      const title = row.title ?? compute_proposal_title(row.kind, payload, row.rationale_md);
      const summary = row.summary ?? compute_proposal_summary(row.kind, payload, row.rationale_md);
      const dedup_key = row.dedup_key ?? compute_dedup_key(row.kind, payload);
      stmt.run({ '@t': title, '@s': summary, '@dk': dedup_key, '@id': row.id });
      updated++;
    }
    return { rows_seen: rows.length, rows_updated: updated };
  }

  /**
   * Move an APPROVED proposal that had no system execution to the terminal
   * `acknowledged` state — the user adopted/acknowledged it and there's
   * nothing for the system to run. Idempotent + guarded on `status =
   * 'approved'` so it never clobbers an `executed`/`failed`/`denied` row (a
   * dispatch that already ran) and re-calls are no-ops. Stamps `ts_executed`
   * so the row reads as resolved on `ORDER BY ts_executed` + the dashboard.
   */
  mark_acknowledged(id: string): void {
    const ts = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE proposals
         SET status = 'acknowledged', ts_executed = @ts
         WHERE id = @id AND status = 'approved'`,
      )
      .run({ '@id': id, '@ts': ts });
  }

  /**
   * Retire a proposal the filing-critic (proposal_critic.ts) judged a
   * semantic duplicate of an open one. The canonical `winner_id` row is
   * untouched — this only flips the redundant `loser_id`, recording the
   * critic's reason in `user_feedback`. Idempotent: only acts on a row still
   * open (pending/snoozed/pending_kate_review), so a re-run is a no-op.
   * Returns true iff it flipped a row. Mirrors create()'s supersession write;
   * the new id semantics are reversed (here the OLDER survives).
   */
  supersede_duplicate(loser_id: string, winner_id: string, reason: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE proposals
         SET status = 'superseded',
             superseded_by = @win,
             superseded_at = @ts,
             user_feedback = @fb
         WHERE id = @id
           AND status IN ('pending', 'snoozed', 'pending_kate_review')`,
      )
      .run({
        '@win': winner_id,
        '@ts': new Date().toISOString(),
        '@fb': reason.slice(0, 500),
        '@id': loser_id,
      });
    return res.changes > 0;
  }

  /**
   * One-time triage: stamp every legacy `approved` row that never executed
   * (`ts_executed IS NULL`) as `acknowledged`, using its decision time as the
   * resolution instant. These accumulated before the decide route marked
   * non-executing approvals terminal (181 by 2026-06-14). Idempotent — after
   * it runs, no rows match. Runs once at boot, like `backfill_titles`.
   */
  backfill_acknowledge_stuck(): { rows_updated: number } {
    const res = this.db
      .prepare(
        `UPDATE proposals
         SET status = 'acknowledged',
             ts_executed = COALESCE(ts_executed, ts_decided, ts_created)
         WHERE status = 'approved' AND ts_executed IS NULL`,
      )
      .run();
    return { rows_updated: res.changes };
  }

  /**
   * Kate's pre-review queue: Beatrice's self-improvement specs awaiting her
   * gate (status `pending_kate_review`), oldest first so she clears the
   * backlog in order. Read by `list_proposals_for_review`.
   */
  list_for_kate_review(): ProposalRow[] {
    const raw = this.db
      .prepare(
        `SELECT * FROM proposals WHERE status = 'pending_kate_review'
         ORDER BY ts_created ASC`,
      )
      .all() as ProposalRowRaw[];
    return raw.map(hydrate_proposal_row);
  }

  /**
   * Kate promotes a reviewed spec to the owner: `pending_kate_review` →
   * `pending` (now owner-visible in the queue + her brief). Guarded on the
   * holding status so a double-review or a concurrent send-back can't flip a
   * row that already moved. Returns true when it transitioned. Signature
   * counts are untouched — graduation only moves on the OWNER's decide.
   */
  promote_after_kate_review(id: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE proposals SET status = 'pending'
         WHERE id = @id AND status = 'pending_kate_review'`,
      )
      .run({ '@id': id });
    return res.changes > 0;
  }

  /**
   * Kate sends a spec back to Beatrice instead of promoting it:
   * `pending_kate_review` → `denied`, stamping her note in `user_feedback`.
   * Deliberately does NOT touch the category-signature denial_count — this is
   * Kate's editorial gate, not the owner denying the action, so it must not
   * poison autonomy graduation. The caller (review_trainer_proposal) pushes
   * the flag to Beatrice. Guarded + returns whether it transitioned.
   */
  return_after_kate_review(id: string, note: string): boolean {
    const ts = new Date().toISOString();
    const res = this.db
      .prepare(
        `UPDATE proposals
         SET status = 'denied', ts_decided = @ts, user_feedback = @fb,
             action_taken = 'kate_returned'
         WHERE id = @id AND status = 'pending_kate_review'`,
      )
      .run({ '@id': id, '@ts': ts, '@fb': note });
    return res.changes > 0;
  }

  /** Mark a proposal as surfaced (first time the user saw it). */
  mark_surfaced(id: string): void {
    const ts = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE proposals
         SET ts_surfaced = COALESCE(ts_surfaced, @ts)
         WHERE id = @id`,
      )
      .run({ '@id': id, '@ts': ts });
  }

  decide(
    id: string,
    verdict: 'approve' | 'deny',
    modifications?: object,
    user_feedback?: string,
    /** Which `ProposalAction.id` the user picked. Recorded in
     *  `action_taken` for audit + dashboards. Defaults to
     *  `'approve'` / `'reject'` so legacy callers (the verdict-only
     *  path) still produce a non-null trail. */
    action_taken?: string,
  ): DecideResult | null {
    const row = this.get(id);
    if (!row) return null;
    if (row.status !== 'pending' && row.status !== 'snoozed') {
      // Idempotent: re-deciding a closed proposal returns its current state.
      return {
        status: row.status,
        execution_kind: row.execution_kind,
        should_execute: false,
        signature_hash: row.category_signature_hash,
        autonomy_status: null,
      };
    }

    const ts = new Date().toISOString();
    const status: ProposalStatus = verdict === 'approve' ? 'approved' : 'denied';
    const mods_json = modifications ? JSON.stringify(modifications) : null;
    const resolved_action = action_taken ?? (verdict === 'approve' ? 'approve' : 'reject');

    this.db
      .prepare(
        `UPDATE proposals
         SET status = @s,
             ts_decided = @ts,
             modifications_json = @mods,
             user_feedback = @fb,
             action_taken = @action
         WHERE id = @id`,
      )
      .run({
        '@id': id,
        '@s': status,
        '@ts': ts,
        '@mods': mods_json,
        '@fb': user_feedback ?? null,
        '@action': resolved_action,
      });

    // Update signature counts.
    if (row.category_signature_hash) {
      if (verdict === 'approve' && !modifications) {
        this.db
          .prepare(
            `UPDATE category_signatures
             SET approval_count = approval_count + 1,
                 last_action_at = @ts
             WHERE hash = @h`,
          )
          .run({ '@h': row.category_signature_hash, '@ts': ts });
      } else if (verdict === 'approve' && modifications) {
        this.db
          .prepare(
            `UPDATE category_signatures
             SET edit_count = edit_count + 1,
                 last_action_at = @ts
             WHERE hash = @h`,
          )
          .run({ '@h': row.category_signature_hash, '@ts': ts });
      } else {
        this.db
          .prepare(
            `UPDATE category_signatures
             SET denial_count = denial_count + 1,
                 last_action_at = @ts
             WHERE hash = @h`,
          )
          .run({ '@h': row.category_signature_hash, '@ts': ts });
      }

      // Trust Ladder (RPG XP) — accrue XP on the signature, weighted by the
      // action's risk × the decision effect. Clamped at 0 (you can't drop
      // below "untrusted"); level re-derived. DARK behind HEARTH_TRUST_XP →
      // off = no write, graduation unchanged. Never blocks the decide.
      if (trust_xp_enabled()) {
        try {
          this._award_trust_xp(row, verdict, Boolean(modifications));
        } catch {
          /* XP is a reinforcement signal, never load-bearing for the decide. */
        }
      }
    }

    const sig_row = row.category_signature_hash
      ? (this.db
          .prepare(`SELECT autonomy_status FROM category_signatures WHERE hash = @h`)
          .get({ '@h': row.category_signature_hash }) as
          | { autonomy_status: AutonomyStatus }
          | undefined)
      : undefined;

    // 'composite' = the kind's registered resolver produces the side effect
    // at decide-time (book_candidate's queue-note mutation,
    // trusted_source_addition's YAML patch). The decide route's resolver /
    // dispatch block keys on this flag, so composite must be included —
    // without it an approve flips the row terminal with the effect never run.
    const should_execute =
      verdict === 'approve' &&
      (row.execution_kind === 'dispatch' ||
        row.execution_kind === 'web_action' ||
        row.execution_kind === 'composite');

    return {
      status,
      execution_kind: row.execution_kind,
      should_execute,
      signature_hash: row.category_signature_hash,
      autonomy_status: sig_row?.autonomy_status ?? null,
    };
  }

  /**
   * Accrue Trust-Ladder XP on a decided proposal's signature. Risk class comes
   * from the proposal's own risk-bearing payload (amount/step-up/execution
   * kind); the effect is approve / approve_modified / deny. XP is clamped at 0
   * and the level re-derived. Called only when HEARTH_TRUST_XP is on.
   */
  private _award_trust_xp(
    row: ProposalRow,
    verdict: 'approve' | 'deny',
    modified: boolean,
  ): void {
    if (!row.category_signature_hash) return;
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch {
      /* unparseable payload → treat as no risk-bearing fields */
    }
    const risk = risk_class_for({
      amount_cents: typeof payload.amount_cents === 'number' ? payload.amount_cents : null,
      requires_step_up: payload.requires_step_up === true,
      execution_kind: row.execution_kind,
    });
    const effect: TrustEffect =
      verdict === 'deny' ? 'deny' : modified ? 'approve_modified' : 'approve';
    const delta = xp_for({ effect, risk }, this.cfg.trust_xp);

    const cur = this.db
      .prepare(`SELECT xp FROM category_signatures WHERE hash = @h`)
      .get({ '@h': row.category_signature_hash }) as { xp: number } | null;
    const next_xp = Math.max(0, (cur?.xp ?? 0) + delta);
    const next_level = level_for(next_xp, this.cfg.trust_xp);
    this.db
      .prepare(`UPDATE category_signatures SET xp = @xp, level = @lvl WHERE hash = @h`)
      .run({ '@h': row.category_signature_hash, '@xp': next_xp, '@lvl': next_level });

    // Also accrue to the specialist's OVERALL XP (the Hearth rank badge). Same
    // delta; the per-specialist total = sum across all their signatures.
    this._bump_specialist_xp(row.specialist_id, delta);
  }

  /** Bump a specialist's total Trust-Ladder XP (clamped ≥ 0) + re-derive their
   *  badge level. Upserts the specialist_xp row. */
  private _bump_specialist_xp(specialist_id: string, delta: number): void {
    const cur = this.db
      .prepare(`SELECT xp FROM specialist_xp WHERE specialist_id = @s`)
      .get({ '@s': specialist_id }) as { xp: number } | null;
    const next_xp = Math.max(0, (cur?.xp ?? 0) + delta);
    const lvl = specialist_level_for(next_xp);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO specialist_xp (specialist_id, xp, level, updated_at)
         VALUES (@s, @xp, @lvl, @now)
         ON CONFLICT(specialist_id) DO UPDATE SET xp = @xp, level = @lvl, updated_at = @now`,
      )
      .run({ '@s': specialist_id, '@xp': next_xp, '@lvl': lvl, '@now': now });
  }

  /** The specialist's Hearth rank badge (copper→diamond + level + XP bar).
   *  Pure read; returns the level-1 / 0-XP base when the specialist has no row
   *  yet. The read surface for the chat-header + office badge. */
  specialist_rank(specialist_id: string): SpecialistRank {
    const row = this.db
      .prepare(`SELECT xp FROM specialist_xp WHERE specialist_id = @s`)
      .get({ '@s': specialist_id }) as { xp: number } | null;
    return compute_specialist_rank(row?.xp ?? 0);
  }

  /** True if ANY proposal (any status) already exists for this signature.
   *  Used by edge-detecting background jobs (e.g. goods followups) to surface
   *  a subject ONCE — distinct from the 24h re-fire collapse, which only spans
   *  OPEN proposals. The signature's `anchor` is the per-subject key. */
  exists_for_signature(sig: CategorySignature): boolean {
    const hash = hash_signature(sig);
    // bun:sqlite .get() returns null (NOT undefined) when no row matches.
    const row = this.db
      .prepare(`SELECT 1 AS one FROM proposals WHERE category_signature_hash = @h LIMIT 1`)
      .get({ '@h': hash }) as { one: number } | null;
    return row != null;
  }

  /**
   * Is this signature covered RIGHT NOW — an open proposal, or a terminal one
   * still inside the re-file cooldown? (2026-08-04)
   *
   * `exists_for_signature` above answers "has one EVER existed", with no status
   * filter at all, so a proposal denied three months ago still returns true
   * forever. That is the correct semantics for its callers (never re-propose
   * the same idea unprompted), and the wrong semantics for a recurring signal:
   * the eval-evolution pass used it and thereby gagged a failing task
   * permanently after the very first filing — even when the fix was denied, or
   * applied and DIDN'T WORK, which is exactly the case where refiling is the
   * point. The log line even claimed "an open proposal already covers this",
   * which was untrue.
   *
   * Cooldown rather than a grave, matching `REFILE_COOLDOWN_DAYS` as used by
   * the declined-subject path: an open proposal blocks; a terminal one blocks
   * for 14 days and then lets a still-live signal speak again.
   */
  covered_for_signature(sig: CategorySignature, now = new Date()): boolean {
    const hash = hash_signature(sig);
    const open = this.db
      .prepare(
        `SELECT 1 AS one FROM proposals
          WHERE category_signature_hash = @h
            AND status IN ('pending', 'snoozed', 'pending_kate_review')
          LIMIT 1`,
      )
      .get({ '@h': hash }) as { one: number } | null;
    if (open != null) return true;
    const cutoff = new Date(now.getTime() - REFILE_COOLDOWN_DAYS * 86_400_000).toISOString();
    const recent = this.db
      .prepare(
        `SELECT 1 AS one FROM proposals
          WHERE category_signature_hash = @h AND ts_created > @cut
          LIMIT 1`,
      )
      .get({ '@h': hash, '@cut': cutoff }) as { one: number } | null;
    return recent != null;
  }

  /** Trust-Ladder state for a signature — XP, derived level, autonomy tier.
   *  Read surface for the eventual "Kate's Growth" office + smokes. */
  trust_level_for(
    hash: string,
  ): { xp: number; level: number; autonomy_status: AutonomyStatus } | null {
    const r = this.db
      .prepare(`SELECT xp, level, autonomy_status FROM category_signatures WHERE hash = @h`)
      .get({ '@h': hash }) as
      | { xp: number; level: number; autonomy_status: AutonomyStatus }
      | undefined;
    return r ?? null;
  }

  snooze(id: string, until: string): boolean {
    const row = this.get(id);
    if (!row || (row.status !== 'pending' && row.status !== 'snoozed')) {
      return false;
    }
    this.db
      .prepare(
        `UPDATE proposals
         SET status = 'snoozed', snoozed_until = @u
         WHERE id = @id`,
      )
      .run({ '@id': id, '@u': until });
    return true;
  }

  record_execution(id: string, result: unknown, error?: string): void {
    const ts = new Date().toISOString();
    const final_status: ProposalStatus = error ? 'failed' : 'executed';
    this.db
      .prepare(
        `UPDATE proposals
         SET status = @s, ts_executed = @ts, execution_result_json = @res
         WHERE id = @id`,
      )
      .run({
        '@id': id,
        '@s': final_status,
        '@ts': ts,
        '@res': JSON.stringify(error ? { error, result } : result),
      });
  }

  /**
   * Per-specialist behavioral-eval health over `eval_health_window_days`.
   * For each golden task with a run in the window, the LATEST run decides the
   * task's current state (rows pulled ts DESC, first-wins per task). A
   * specialist is unhealthy iff any of its tasks' latest run failed. Read by
   * both the graduation gate (`check_graduation_candidates`) and Mariah's
   * `program_dashboard` so the surfaced pass-rate is exactly what the gate
   * enforces. Specialists with no runs in the window are absent (unknown).
   */
  eval_health_by_specialist(now: Date = new Date()): Map<string, SpecialistEvalHealth> {
    const window_days = this.cfg.eval_health_window_days;
    const since = new Date(now.getTime() - window_days * 86_400_000).toISOString();
    const out = new Map<string, SpecialistEvalHealth>();
    let rows: Array<{ specialist_id: string; task_id: string; passed: number }>;
    try {
      rows = this.db
        .prepare(
          `SELECT specialist_id, task_id, passed FROM eval_runs
            WHERE ts >= @since ORDER BY ts DESC`,
        )
        .all({ '@since': since }) as Array<{
        specialist_id: string;
        task_id: string;
        passed: number;
      }>;
    } catch {
      // eval_runs table absent (pre-eval db) — behave as if no history.
      return out;
    }
    const seen_task = new Set<string>();
    for (const r of rows) {
      if (seen_task.has(r.task_id)) continue; // ts DESC → first row is latest
      seen_task.add(r.task_id);
      let h = out.get(r.specialist_id);
      if (!h) {
        h = {
          specialist_id: r.specialist_id,
          tasks_total: 0,
          tasks_passing: 0,
          tasks_failing: 0,
          pass_rate: 1,
          failing_task_ids: [],
          window_days,
        };
        out.set(r.specialist_id, h);
      }
      h.tasks_total++;
      if (r.passed === 1) h.tasks_passing++;
      else {
        h.tasks_failing++;
        h.failing_task_ids.push(r.task_id);
      }
    }
    for (const h of out.values()) {
      h.pass_rate = h.tasks_total > 0 ? h.tasks_passing / h.tasks_total : 1;
    }
    return out;
  }

  /**
   * Walks signatures and returns those that look ready to be proposed for
   * graduation. The runtime should turn each candidate into a proposal of
   * kind=recommendation for the user to approve.
   */
  check_graduation_candidates(): GraduationCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT hash, signature_json, approval_count, edit_count,
                denial_count, autonomy_status, xp
         FROM category_signatures
         WHERE autonomy_status IN ('tier2a','tier2b','tier2c')`,
      )
      .all() as Array<{
      hash: string;
      signature_json: string;
      approval_count: number;
      edit_count: number;
      denial_count: number;
      autonomy_status: AutonomyStatus;
      xp: number;
    }>;

    // Trust Ladder XP gate (2026-06-20): when on, a signature must also hold
    // the XP threshold for its tier — ANDed with the approval-count gate. Off
    // → never holds (graduation byte-identical to pre-Trust-Ladder).
    const xp_gate_on = trust_xp_enabled();

    // Authenticity gate: pull the current score for every specialist
    // up front so the inner loop is cheap. Missing row = unknown =
    // pass the gate (don't permanently block new hires before
    // Mariah's first scan).
    const auth_scores = new Map<string, number>();
    try {
      const score_rows = this.db
        .prepare(`SELECT specialist_id, score FROM authenticity_scores`)
        .all() as Array<{ specialist_id: string; score: number }>;
      for (const r of score_rows) auth_scores.set(r.specialist_id, r.score);
    } catch {
      // Table missing (pre-Pass-B db). Behave as if all unknown.
    }

    // Eval-health gate: pull per-specialist behavioral-eval health up front.
    // Absent specialist = no runs in the window = unknown = pass (new-hire
    // fail-open). Disabled by config → empty map → never holds.
    const eval_health = this.cfg.require_eval_health_for_graduation
      ? this.eval_health_by_specialist()
      : new Map<string, SpecialistEvalHealth>();

    const out: GraduationCandidate[] = [];
    for (const r of rows) {
      if (this.cfg.excluded_signatures.includes(r.hash)) continue;
      let sig: CategorySignature;
      try {
        sig = JSON.parse(r.signature_json) as CategorySignature;
      } catch {
        continue;
      }
      if (this.cfg.hard_excluded_categories.includes(sig.category)) continue;

      // Amount cap — if signature carries an amount_cents, skip when over cap.
      const extras = sig.extras ?? {};
      const amount = typeof extras.amount_cents === 'number' ? extras.amount_cents : null;
      if (amount !== null && amount > this.cfg.amount_cap_cents) continue;

      // Sensitive-recipient flag.
      if (extras.recipient_sensitive === true) continue;

      // Web actions don't graduate unless explicitly enabled.
      if (extras.execution_kind === 'web_action' && !this.cfg.web_action_graduation_enabled) {
        continue;
      }

      const needed = this.threshold_for(r.autonomy_status);
      if (needed === null) continue;
      const ok =
        r.approval_count >= needed &&
        r.edit_count <= Math.max(1, Math.floor(needed / 5)) &&
        r.denial_count === 0;
      if (!ok) continue;

      // Trust Ladder XP gate — Kate must have EARNED the level (XP), not just
      // collected approvals. Held silently (keeps accruing) until she clears it.
      if (xp_gate_on) {
        const xp_needed = xp_threshold_for(r.autonomy_status, this.cfg.trust_xp);
        if (xp_needed !== null && (r.xp ?? 0) < xp_needed) continue;
      }

      // Authenticity gate. Specialists fabricating in their daily
      // turns don't earn more autonomy until the fabrication rate
      // comes down. Approvals still accumulate against the signature
      // — the user can keep approving — but the recommendation isn't
      // surfaced until the score recovers. New hires (no score row)
      // pass through; this is the path back up.
      const auth_needed = this.authenticity_threshold_for(r.autonomy_status);
      if (auth_needed !== null) {
        const score = auth_scores.get(sig.specialist_id);
        if (typeof score === 'number' && score < auth_needed) {
          // Don't push to `out` — silently hold. The reason is
          // queryable via the audit-log entry for this scan if
          // anyone wonders why the recommendation isn't surfacing.
          continue;
        }
      }

      // Eval-health gate. A standing behavioral regression (the latest run
      // of one of this specialist's golden tasks failed in the window) holds
      // graduation until the eval goes green again — the same pass→fail miss
      // Beatrice is already working is the path back up. Absent from the map
      // = no eval history in the window = unknown = pass (new-hire fail-open,
      // mirroring the authenticity floor above).
      const eh = eval_health.get(sig.specialist_id);
      if (eh && eh.tasks_failing > 0) continue;

      out.push({
        signature_hash: r.hash,
        signature: sig,
        current_status: r.autonomy_status,
        proposed_status: this.next_status_for(r.autonomy_status),
        approval_count: r.approval_count,
        edit_count: r.edit_count,
        denial_count: r.denial_count,
        reason:
          `${r.approval_count} approvals (edits ${r.edit_count}, denials ${r.denial_count}) — ` +
          `eligible to advance from ${r.autonomy_status} to ${this.next_status_for(r.autonomy_status)}`,
      });
    }
    return out;
  }

  /** Apply a graduation decision after the user approves a graduation proposal. */
  /**
   * Every distinct `dispatch_tool` name the proposals in ONE signature family
   * have ever carried. This is what a family would actually EXECUTE if it
   * graduated into an auto-executing tier — so it, not the family's category
   * label, is the honest input to the graduation floor (2026-07-21).
   *
   * A family whose proposals carry no dispatch tool at all (the
   * `execution_kind:'none'` followup families) returns [] — nothing to
   * execute, nothing to floor. Tolerates both payload shapes the codebase
   * uses: a bare string, or an object with name/tool/action.
   */
  dispatch_tools_for_signature(hash: string): string[] {
    let rows: Array<{ payload_json: string }>;
    try {
      rows = this.db
        .prepare(
          `SELECT payload_json FROM proposals WHERE category_signature_hash = @h`,
        )
        .all({ '@h': hash }) as Array<{ payload_json: string }>;
    } catch {
      return [];
    }
    const out = new Set<string>();
    for (const r of rows) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(r.payload_json) as Record<string, unknown>;
      } catch {
        continue;
      }
      const d = payload.dispatch_tool;
      const name =
        typeof d === 'string'
          ? d
          : ((d as { name?: string; tool?: string; action?: string } | undefined)?.name ??
            (d as { tool?: string } | undefined)?.tool ??
            (d as { action?: string } | undefined)?.action);
      if (typeof name === 'string' && name.length > 0) out.add(name);
    }
    return [...out];
  }

  graduate(hash: string, target: AutonomyStatus): void {
    this.db
      .prepare(
        `UPDATE category_signatures
         SET autonomy_status = @s
         WHERE hash = @h`,
      )
      .run({ '@h': hash, '@s': target });
  }

  /** Revoke an automation tier (e.g. after a bad outcome). */
  revoke(hash: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE category_signatures
         SET autonomy_status = 'revoked',
             autonomy_revoked_reason = @r
         WHERE hash = @h`,
      )
      .run({ '@h': hash, '@r': reason });
  }

  private threshold_for(status: AutonomyStatus): number | null {
    switch (status) {
      case 'tier2a':
        return this.cfg.min_approvals_for_tier2b;
      case 'tier2b':
        return this.cfg.min_approvals_for_tier2c;
      case 'tier2c':
        return this.cfg.min_approvals_for_tier3;
      default:
        return null;
    }
  }

  /**
   * Authenticity score the specialist must hold for a signature to
   * graduate from `status` to the next tier. Mirrors threshold_for() —
   * sibling gate, not a replacement.
   */
  private authenticity_threshold_for(status: AutonomyStatus): number | null {
    switch (status) {
      case 'tier2a':
        return this.cfg.min_authenticity_score_for_tier2b;
      case 'tier2b':
        return this.cfg.min_authenticity_score_for_tier2c;
      case 'tier2c':
        return this.cfg.min_authenticity_score_for_tier3;
      default:
        return null;
    }
  }

  private next_status_for(status: AutonomyStatus): AutonomyStatus {
    switch (status) {
      case 'tier2a':
        return 'tier2b_proposed';
      case 'tier2b':
        return 'tier2c_proposed';
      case 'tier2c':
        return 'tier3_proposed';
      default:
        return status;
    }
  }
}

export function load_autonomy_config(yaml_path: string): AutonomyConfig {
  try {
    const text = readFileSync(yaml_path, 'utf8');
    const parsed = parseYaml(text) as Partial<AutonomyConfig> | null;
    return { ...DEFAULT_AUTONOMY_CONFIG, ...(parsed ?? {}) };
  } catch (err) {
    console.warn(
      `[proposals] autonomy config not loaded (${(err as Error).message}); using defaults`,
    );
    return DEFAULT_AUTONOMY_CONFIG;
  }
}

/**
 * Watch the autonomy config file and re-load it on change, handing the
 * fresh config to `on_reload` (typically `ProposalsStore.set_config`). A
 * graduation-threshold edit is live on the next graduation check — no
 * orchestrator restart. Mirrors `watch_extra_capabilities` /
 * `Gateway.watch`; `load_autonomy_config` itself never throws (it falls
 * back to defaults), so a malformed mid-write file can't break the
 * running process. Returns the watcher so the caller can `close()` it.
 */
export function watch_autonomy_config(
  yaml_path: string,
  on_reload: (cfg: AutonomyConfig) => void,
): FSWatcher {
  const watcher = chokidar.watch(yaml_path, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
  const handler = (): void => {
    const cfg = load_autonomy_config(yaml_path);
    on_reload(cfg);
    console.log(`[proposals] autonomy config reloaded from ${yaml_path}`);
  };
  watcher.on('add', handler);
  watcher.on('change', handler);
  watcher.on('unlink', handler);
  return watcher;
}
