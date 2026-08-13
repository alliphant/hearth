/**
 * Deliberation pass (Prompt 6c).
 *
 * One LLM-driven thinking pass per specialist at each of their scheduled
 * deliberation_at slots. The pass:
 *
 *   1. Gathers recent awareness observations, unactioned inbox messages,
 *      vault deltas in the specialist's knowledge_scope since last
 *      pass, and the tail of their memory.md.
 *   2. Builds a structured JSON-output prompt.
 *   3. Runs the LLM through SpecialistRuntime.turn().
 *   4. Parses the structured envelope, then:
 *        - appends summary_for_self to the memory file,
 *        - creates inbox flags via SpecialistInbox,
 *        - creates proposals via ProposalsStore,
 *        - raises interrupts via the loop driver's fire_interrupt,
 *        - for Kate at "report time" slots, persists a brief row.
 *   5. Marks consumed inbox messages as actioned.
 *
 * In HEARTH_TEST_MODE=1, the LLM is short-circuited by a fixture loader
 * (test/fixtures/deliberation.ts) that returns deterministic envelopes
 * for known prompt shapes so smokes are reproducible.
 */

import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { LoadedSpecialist } from './specialist';
import type { SpecialistRuntime, SpecialistTurnInput } from './specialist_runtime';
import type { ProposalsStore, ProposalKind, ProposalExecutionKind, CategorySignature } from './proposals';
import type { InterruptStore, SpecialistInbox } from '@memory/stores/conversations';
import type { MemoryClient } from '@memory/client';
import type { AppEventBus } from '../app/events';
import type { Severity, AwarenessObservation } from './loops';
import { capitalize } from './loops';
import { append_to_memory, read_memory_tail } from './memory_files';
import { emit_for_proposal_created } from './proposal_events';
import { try_load_fixture } from './deliberation_fixtures';
import { format_short_datetime, format_now_anchor, local_iso_date } from './time';
import { render_standing_duties } from './standing_duties';
import { apply_miss_action, MISS_ACTIONS } from './process_misses';
import type { ProcessMissStore, ProcessMissAction } from './process_misses';
import type { UserRegistry } from './users';
import { get_current_location, spatial_context_summary } from './location_awareness';
import { location_specialist_allowed } from './privacy';
import { pull_brief_context, type VerifiedLifeContext } from './domain_packs';
import { working_memory_blocks } from './working_memory';
import { render_own_watchlist } from './kate_reflection';
import { build_grounding_context, build_grounding_evidence } from './provenance';
import { critique_and_correct_brief } from './brief_critic';
import {
  known_hire_packets,
  mine_roster_gaps,
  render_roster_gap_section,
  roster_gap_min_evidence,
  roster_gap_window_days,
  roster_gaps_enabled,
} from './roster_gaps';

export type BriefKind = 'morning' | 'midday' | 'evening' | 'overnight' | 'ad_hoc';

export const SLOT_TO_BRIEF_KIND: Record<string, BriefKind> = {
  '07:00': 'morning',
  '12:30': 'midday',
  '18:00': 'evening',
  '22:00': 'overnight',
};

export interface DeliberationEnvelope {
  summary_for_self: string;
  flags: Array<{
    to_specialist_id: string;
    severity: Severity;
    body_md: string;
    related_proposal_id?: string;
  }>;
  proposals: Array<{
    kind: ProposalKind;
    execution_kind: ProposalExecutionKind;
    payload: Record<string, unknown>;
    rationale_md: string;
    category_signature: CategorySignature;
  }>;
  interrupts: Array<{
    severity: Severity;
    summary: string;
    details_md: string;
  }>;
  /**
   * Mariah's autonomous miss-drive — present for specialists granted
   * `drive_process_misses` (the meta-agents). Each entry advances one open
   * process miss along its lifecycle; the applier routes through `apply_miss_action`,
   * so the side effects (lifecycle transition + redo/escalate inbox
   * flags) match the `advance_process_miss` tool exactly.
   */
  miss_actions?: Array<{
    miss_id: string;
    action: ProcessMissAction;
    note: string;
  }>;
  /** Kate-only: present when the slot is a "report time" (07:00 etc.). */
  morning_brief?: {
    generated_at: string;
    sections: {
      noticed: string;
      attention_today: Array<{
        title: string;
        body: string;
        urgency: 'now' | 'today' | 'this_week';
        source_specialist_id?: string;
      }>;
      ready_for_review: Array<{
        proposal_id: string;
        one_line_summary: string;
      }>;
      watching: string;
    };
    mood: 'calm' | 'attentive' | 'concerned';
  };
}

/**
 * A specific task handed to a specialist's deliberation channel to execute on
 * the strong model THIS pass, overriding the standing audit/grooming work.
 * This is the "owner-directed build" mechanism: the owner (or an approved
 * proposal dispatch) hands Beatrice a directive — "author tool X", "tune Y" —
 * and her deliberation runs it on the 80B with a focused tool surface instead
 * of defaulting to her audit sweep. Still routes through propose_code_change →
 * Kate skeptic review → owner merge; nothing auto-merges.
 */
export interface DirectedTask {
  /** The directive, in prose. Substituted into the deliberation prompt verbatim. */
  instruction: string;
  /**
   * Focused per-turn tool surface for the pass (overrides the specialist's
   * standing `tools_for_deliberation`). Lets a directive surface a GRANTED tool
   * that's curated off the standing list — `propose_code_change` is the canonical
   * case. Omit to keep the standing deliberation surface.
   */
  tools?: readonly string[];
  /** Output ceiling for the pass; authoring a full file needs headroom. Default 8000. */
  max_tokens?: number;
  /**
   * Tool-round budget for the pass (2026-08-11, directed-build postmortem).
   * Directed builds used to inherit the specialist's CHAT-sized
   * `max_tool_rounds` and died at exactly 15/15 then 20/20 mid-build. When
   * omitted, a directed pass gets `directed_tool_rounds_default()` (env
   * HEARTH_DIRECTED_TOOL_ROUNDS, default 30) — sized for read→design→edit→
   * re-file chains, independent of chat. Clamped to TOOL_ROUNDS_OVERRIDE_CAP
   * (60) by the runtime's resolver.
   */
  max_tool_rounds?: number;
  /**
   * Per-pass thinking override (S4 scrutiny, 2026-07-02). Explicit true/false
   * wins over every default. When omitted, a DIRECTED pass defaults think-ON
   * only under HEARTH_SCRUTINY_THINK=1 — which the 2026-07-02 bench says to
   * LEAVE UNSET: on the live 35B-A3B, think-ON showed NO accuracy gain on the
   * scrutiny task family (review verdicts / surgical edits / diagnosis:
   * 30/33 vs think-OFF's 31/33) at 14× latency and 22× output tokens
   * (scripts/bench-think-scrutiny.ts). The knob exists for per-pass judgment
   * calls and future re-benching on harder tasks, not as a default.
   */
  think?: boolean;
}

/**
 * Scoped framing for a REACTIVE-TRIGGER pass (2026-06-18). When set, the
 * specialist was woken off-schedule by `LoopDriver.wake_deliberation_scoped`
 * because a real-world event occurred (a location flip, a routed capture, a
 * domain threshold). The deliberation prompt replaces the standing "scheduled
 * reflection / be conservative" prelude with neutral system-trigger framing
 * pointed at `task`, but keeps the normal envelope shape, inbox, and trust-tier
 * guidance. Distinct from `DirectedTask` (the owner-authored build path, which
 * forces tools + framing "FROM {{user_name}}"): a trigger is a plain
 * deliberation, just refocused — no tool forcing, no max_tokens change.
 */
export interface TriggerContext {
  /** Why the pass fired — the edge that occurred. Becomes "What happened: …". */
  reason: string;
  /** What to focus on — the subscription's `task`. Becomes "Focus this pass on: …". */
  task: string;
  /**
   * Per-wake thinking override (S4 scrutiny, 2026-07-02). Set by callers whose
   * scoped wake is a heavy-scrutiny workout (the Case Driver's diagnostic /
   * verify wakes). Omitted → the standing think resolution applies.
   */
  think?: boolean;
}

/**
 * Master gate for defaulting DIRECTED passes to think-ON (S4). Read at call
 * time so smokes can flip it. Explicit per-pass `think` always wins over this.
 *
 * ⚠ Bench verdict (2026-07-02, scripts/bench-think-scrutiny.ts, live 35B):
 * think-ON gave NO accuracy gain on the scrutiny family (30/33 vs 31/33
 * think-OFF) at 14× latency / 22× tokens — so this DEFAULTS OFF and should
 * stay off until a harder task set shows a win. At ~1s per think-OFF review,
 * MULTIPLE INDEPENDENT passes are the cheaper scrutiny multiplier (three
 * independent reviews < one thinking pass) — that's the follow-up mechanism,
 * not this flag.
 */
export function scrutiny_think_enabled(): boolean {
  return process.env.HEARTH_SCRUTINY_THINK === '1';
}

/**
 * Default tool-round budget for a DIRECTED pass when the task doesn't set its
 * own `max_tool_rounds` (2026-08-11). 30 covers the observed shape of a real
 * build — existence-check greps, several file reads, one or two authoring
 * calls, a checks-failed fix + re-file — with slack; the three 2026-08-10/11
 * builds died at chat-sized 15 and 20. Env-tunable, read at call time so
 * smokes can flip it; the runtime clamps whatever this returns to
 * TOOL_ROUNDS_OVERRIDE_CAP.
 */
export function directed_tool_rounds_default(): number {
  const raw = Number.parseInt(process.env.HEARTH_DIRECTED_TOOL_ROUNDS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

/**
 * Resolve the per-turn think override for a deliberation pass. Precedence:
 *   1. explicit `directed_task.think` / `trigger_context.think` (caller knows)
 *   2. a DIRECTED or TRIGGER-SCOPED pass under HEARTH_SCRUTINY_THINK=1 → true
 *      (these are the heavy-scrutiny workouts: authoring, review verdicts,
 *      diagnosis — bench-validated; scheduled envelope passes are untouched)
 *   3. the specialist's YAML `think_in_deliberation` — honored BOTH ways now.
 *      (Pre-S4 only the `false` branch was wired; a YAML `true` was silently
 *      ignored once the deep tier's role default flipped to think-OFF at the
 *      2026-06-07 35B swap. trainer.yaml carried exactly that dead `true`.)
 *   4. undefined → the role default (think-OFF on specialist_deliberation).
 */
export function resolve_deliberation_think(
  specialist: LoadedSpecialist,
  directed_task?: DirectedTask,
  trigger_context?: TriggerContext,
): boolean | undefined {
  if (typeof directed_task?.think === 'boolean') return directed_task.think;
  if (typeof trigger_context?.think === 'boolean') return trigger_context.think;
  if ((directed_task || trigger_context) && scrutiny_think_enabled()) return true;
  if (typeof specialist.proactive.think_in_deliberation === 'boolean') {
    return specialist.proactive.think_in_deliberation;
  }
  return undefined;
}

export interface DeliberationInput {
  specialist: LoadedSpecialist;
  slot: string;
  observations: AwarenessObservation[];
  db: Database;
  memory: MemoryClient;
  runtime: SpecialistRuntime;
  proposals: ProposalsStore;
  inbox: SpecialistInbox;
  interrupts: InterruptStore;
  /**
   * The process-miss ledger. Optional so call sites that don't drive
   * misses still compile; when absent, `miss_actions` are skipped and
   * no open-misses context is surfaced.
   */
  process_misses?: ProcessMissStore;
  events?: AppEventBus;
  /**
   * Per-user identity store. Threaded through so the brief context
   * puller can resolve per-user home coords (each household member's
   * weather reads from THEIR home, not the captain's). Optional for
   * legacy callers that pre-date per-user briefs.
   */
  users?: UserRegistry;
  /**
   * The user this pass is being run for. **Required** for Kate's
   * brief-producing slots — the brief gets stamped with this id,
   * `pull_brief_context` resolves THIS user's home / calendar /
   * location / weather, and the routes serve it scoped to the
   * caller. Optional for non-brief slots and non-Kate specialists
   * (their deliberations are household-level); falls back to
   * `HEARTH_OWNER_USER_ID ?? 'jasper'` when omitted.
   */
  user_id?: string;
  /**
   * When present, this pass runs the directed task instead of the standing
   * audit/grooming work (see DirectedTask). Skipped under HEARTH_TEST_MODE
   * (fixtures don't model directives). Never set on scheduled passes.
   */
  directed_task?: DirectedTask;
  /**
   * When present, this pass was woken off-schedule by a reactive trigger
   * (see TriggerContext). Mutually exclusive with `directed_task`. Threaded
   * into the deliberation prompt's prelude so the woken specialist focuses on
   * the trigger's task. Honored on the LLM path; under HEARTH_TEST_MODE the
   * fixture keys on the `trigger:<key>` slot instead.
   */
  trigger_context?: TriggerContext;
  fire_interrupt: (sev: Severity, reason: string, summary: string) => Promise<string | null>;
}

const TEST_MODE = () => process.env.HEARTH_TEST_MODE === '1';

export async function deliberation_pass(input: DeliberationInput): Promise<DeliberationEnvelope | null> {
  const { specialist, slot, observations, db, memory, runtime, proposals, inbox, events } = input;
  // Memory exposes the vault root via its private cfg; the Kate filter
  // needs it to read derived sensor signals during proposal scoring.
  const vault_root = (memory as unknown as { cfg: { vault_root: string } }).cfg.vault_root;
  // Gather everything not yet ACTIONED, not just unread. A pass that
  // reads a message but crashes before marking it actioned would
  // otherwise orphan it: read_at is set so unread_for never re-surfaces
  // it, and the UI has no human dismiss. Gating on actioned_at means a
  // crashed pass's messages are simply retried on the next pass.
  // Per-user cordon (2026-06-05): when this is a per-user pass (Kate's
  // brief carries input.user_id), restrict the inbox to household/system-
  // shared flags + that user's own, so a household member's personal flag
  // never lands in another user's brief. A user-less pass (a specialist's
  // own domain deliberation) gets the unfiltered queue.
  let unread = inbox.unactioned_for(specialist.id, 50, input.user_id);
  // Non-owner brief scoping (2026-06-16): a household member's brief is THEIRS,
  // not the admin's ops report. The per-user cordon above already drops other
  // users' PERSONAL flags, but it KEEPS every household/system-shared flag
  // (originating_user_id NULL) — the garden/market/EV/program-scan/Hearth-
  // internal stream that legitimately fills the OWNER's brief. That's why
  // Sam's brief read like Jasper's. Drop it at the DATA layer (the non-owner
  // framing block was a prompt the small model didn't reliably obey), keeping
  // only her own flags + flags from specialists she actually works with.
  // input.user_id is set only on Kate's per-user brief fan-out.
  const brief_recipient = input.user_id ? input.users?.get(input.user_id) : undefined;
  const brief_for_member = Boolean(brief_recipient && brief_recipient.tier !== 'owner');
  if (brief_recipient && brief_for_member) {
    unread = scope_member_brief_inbox(unread, brief_recipient);
  }
  const vault_deltas = scan_vault_deltas(memory, specialist, db);
  // Every pass reads THIS user's own memory tail (2026-07-29). This used to
  // be `brief_for_member ? [] : read_memory_tail(...)`: a member got nothing
  // because the single file was the admin's world, and the owner got all of
  // it — including the member-pass summaries written into that same file, so
  // a member's private facts came back to the owner as recall. `memory_path`
  // now resolves per user, so a member reads her own accumulated recall and
  // the owner reads his. Neither reads the other's.
  // 50 entries (was 20 pre-2026-07-17): with the universal `remember`
  // tool every specialist now writes far more than one deliberation
  // summary per day, and a 20-entry tail aged out same-week notes.
  const memory_tail = read_memory_tail(memory, specialist.id, 50, input.user_id);

  // Open process misses — surfaced only to specialists who MANAGE the
  // ledger (`drive_process_misses`: the meta-agents Mariah + Beatrice).
  // This is deliberately NOT `write_process_miss`: that capability only
  // authorizes FILING a miss (Kristi's acquire_quickspecs rejecting an
  // implausible spec), and surfacing the whole system-wide ledger to a
  // domain specialist who merely files misses bloated her deliberation
  // prompt by ~16k tokens — the Kristi 49k-context overflow (2026-06-08).
  // Mariah reviews these every pass and moves each one forward via the
  // envelope's `miss_actions`.
  const can_drive_misses = specialist.granted.has('drive_process_misses');
  const open_misses =
    can_drive_misses && input.process_misses
      ? input.process_misses.list({ open_only: true })
      : [];
  const open_misses_ctx = open_misses.map((m) => ({
    id: m.id,
    subject_specialist_id: m.subject_specialist_id,
    status: m.status,
    severity: m.severity,
    task_summary: m.task_summary,
    gap: m.gap,
    routed_to: m.routed_to,
  }));

  // Roster-gap report — staffing oversight only (`drive_roster_gaps`:
  // Kate). Deterministic mining over Cordelia's triage interrupts +
  // unattributed knowledge demand; renders a prompt section instructing
  // her to convert above-bar clusters into propose_hire packets. Most
  // passes mine nothing above the evidence floor and render no section.
  // Fail-open: a mining error never breaks the pass.
  let roster_gap_section = '';
  if (roster_gaps_enabled() && specialist.granted.has('drive_roster_gaps')) {
    try {
      const window_days = roster_gap_window_days();
      const gap_now = new Date();
      const gap_report = mine_roster_gaps(db, { window_days, now: gap_now, max_topics: 5 });
      if (gap_report.topics.length > 0) {
        const packets = known_hire_packets(db, { window_days, now: gap_now });
        roster_gap_section = render_roster_gap_section(gap_report, packets, { window_days });
        memory.log_action({
          intent_id: ulid(),
          agent: specialist.id,
          tool_name: 'roster_gap_report',
          tool_input: { window_days, min_evidence: roster_gap_min_evidence(), slot },
          execution_result: {
            signals_scanned: gap_report.signals_scanned,
            topics: gap_report.topics.map((t) => ({
              label: t.label,
              evidence: t.evidence_count,
            })),
            known_packets: packets.length,
          },
        });
      }
    } catch (err) {
      console.error('[deliberation] roster-gap mining failed (fail-open):', err);
    }
  }

  // Spatial context: only available to specialists with read_my_location
  // AND in the privacy allowlist. The snapshot is per-user — backed
  // by the latest iOS /api/sensors/location packet for this user.
  // Render as a one-line summary; the prompt builder threads it into
  // the system prompt below.
  let spatial_context: string | null = null;
  if (
    specialist.granted.has('read_my_location') &&
    location_specialist_allowed(specialist.id)
  ) {
    const spatial_user_id = input.user_id ?? process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
    const snap = await get_current_location(spatial_user_id);
    spatial_context = spatial_context_summary(snap);
  }

  // Verified life-context — pre-pumped for Kate at report-time slots
  // so the brief renders live HA/calendar state instead of values
  // recalled from memory. Unconfigured entities surface explicit
  // `unavailable` markers (with reasons), which the brief prompt
  // forbids Kate from filling in. See src/core/brief_context.ts.
  const is_kate_report_pull = specialist.id === 'kate' && slot in SLOT_TO_BRIEF_KIND;
  // The user this pass is being run for. Required for Kate's brief
  // slots (the loop driver iterates household members and passes
  // each id in); falls back to the legacy single-owner env for
  // non-brief slots and non-Kate specialists whose deliberations
  // are household-level. `pull_brief_context` resolves this user's
  // home_location → weather, their calendar snapshot, their
  // location packet — so Sam's 07:00 brief reads Sam's data and
  // Jasper's reads Jasper's.
  const brief_user_id = input.user_id ?? process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
  // HA-sourced life-context (EV SoC/range, indoor temp) is read from the
  // single admin-home Home Assistant, so it is OWNER-ONLY — a household
  // member's brief must not carry the admin's device readings. Resolve the
  // recipient's tier here; pull_brief_context suppresses the HA pump
  // (emitting `unavailable` markers) for non-owners while weather + calendar
  // stay per-user. Falls back to owner for an unknown user / no registry,
  // preserving legacy single-user behavior. This is the data-layer fix for
  // the leak the 2026-06-07 non-owner framing block only mitigated.
  const brief_is_owner = (input.users?.get(brief_user_id)?.tier ?? 'owner') === 'owner';
  const verified_life_context: VerifiedLifeContext | null = is_kate_report_pull
    ? await pull_brief_context({
        memory,
        user_id: brief_user_id,
        users: input.users,
        is_owner: brief_is_owner,
      })
    : null;

  // Inbox messages get rendered as readable markdown in the user
  // prompt (see llm_deliberation), NOT embedded in this JSON context.
  // Qwen reliably extracts fields from prose ("call X with verbatim
  // 'foo'") but fails to extract from nested JSON arrays inside a
  // larger envelope — bench 2026-05-19 showed empty-args tool calls
  // when the data lived inside ctx.unread_inbox[N].body_md. Inbox
  // ids are kept here for cross-reference but the body is rendered
  // separately as the primary surface the LLM acts on.
  // Ground the LLM's sense of "now" in the recipient's wall clock, not
  // the server's UTC. The zone is the iOS device's (X-User-Timezone →
  // users.yaml → users.get_timezone); falls back to America/Denver for
  // an unknown user. `now` is the human anchor the brief/deliberation
  // prose reasons from ("2026-05-30 Sat 2:00 PM (America/Denver)").
  // The raw UTC instant is DELIBERATELY kept OUT of this model-facing ctx:
  // a sibling `now_utc` field sitting next to `now` was the footgun behind
  // the 2026-06-24 overnight brief reading "2026-06-25T04:00Z" and
  // announcing "It's 4 AM Thursday" when it was 10 PM Wednesday Denver. The
  // sortable UTC instant lives in `now_d` (used for storage/ordering keys in
  // code) and is handed to the TEST_MODE fixture loader explicitly below —
  // it never reaches the LLM. The prominent local anchor the model reasons
  // from is rendered by `format_now_anchor` at the top of the prompt
  // (see llm_deliberation).
  const brief_tz = input.users?.get_timezone(brief_user_id) ?? 'America/Denver';
  const now_d = new Date();
  // Working memory — the fused household situational block (working_memory.ts),
  // composed for THIS pass's recipient (cordoned to their tier, so Sam's brief
  // fuses Sam's mail + the household graph, never Jasper's mail). YAML opt-in
  // (proactive.situational_context) + HEARTH_WORKING_MEMORY gate; fail-open to
  // '' inside the helper. Rendered markdown (not nested JSON) — Qwen extracts
  // from prose, not from arrays inside a larger envelope (bench 2026-05-19).
  const situational_signals =
    specialist.proactive.situational_context === true
      ? working_memory_blocks(
          { memory, db },
          {
            user_id: brief_user_id,
            tier: input.users?.get(brief_user_id)?.tier ?? 'owner',
            now: now_d,
            timezone: brief_tz,
          },
        ).join('\n\n')
      : '';
  // Kate's own watch ledger (the walk-the-house reflection pass,
  // kate_reflection.ts) — feeds the brief's `watching` section from her
  // durable ledger instead of a fresh re-derivation each morning. '' unless
  // HEARTH_KATE_REFLECTION is on AND the specialist holds the capability
  // (Kate only today), so every other pass is byte-identical.
  const own_watchlist = specialist.granted.has('reflect_household')
    ? render_own_watchlist(db, brief_user_id)
    : '';
  // Standing duties (2026-08-03) — the scheduled rota, resolved against THIS
  // pass's slot and local date rather than left as prose for the model to work
  // out. Only the duties actually due render, with every day-window already an
  // absolute date. '' when the specialist declares none, so a specialist that
  // hasn't migrated is byte-identical. See src/core/standing_duties.ts.
  const standing_duties = render_standing_duties(
    specialist.proactive.standing_duties ?? [],
    slot,
    now_d,
    brief_tz,
  );
  const ctx = {
    now: `${local_iso_date(now_d, brief_tz)} ${format_short_datetime(now_d.toISOString(), brief_tz)} (${brief_tz})`,
    timezone: brief_tz,
    slot,
    observations: observations.slice(-15),
    spatial_context,
    unread_inbox_ids: unread.map((m) => m.id),
    open_process_misses: open_misses_ctx,
    vault_deltas,
    recent_memory_excerpts: memory_tail,
    ...(verified_life_context ? { verified_life_context } : {}),
    ...(situational_signals ? { situational_signals } : {}),
    ...(own_watchlist ? { own_watchlist } : {}),
  };

  // Wall-clock cut at deliberation start so we can attribute any
  // `present_questions` rows the specialist creates DURING the pass to
  // the brief that gets persisted at the end (the brief id doesn't
  // exist yet at tool-call time — pass 6c orders brief-write after the
  // LLM turn returns). See the patch block after the brief is INSERTed.
  const deliberation_started_at = new Date().toISOString();

  let envelope: DeliberationEnvelope | null;
  // Successful tool results from the LLM pass — evidence for the brief
  // critic (empty on the fixture path, which makes no tool calls).
  let pass_tool_results: string[] = [];
  // Raw model output — kept so an unparseable envelope can be repaired by
  // one tool-free reformat pass (see the `if (!envelope)` block). Empty on
  // the fixture path.
  let pass_raw_text = '';
  if (TEST_MODE()) {
    // try_load_fixture inspects message senders and bodies, so it needs
    // the inbox objects — not the id-only `unread_inbox_ids` the LLM
    // JSON context carries. Hand it the full rows in the fixture shape;
    // the LLM path gets the same data via the `unread` parameter.
    envelope = try_load_fixture(specialist.id, slot, {
      ...ctx,
      // now_utc rides into the fixture loader only (it stamps a fixture
      // brief's generated_at); it is intentionally absent from the
      // model-facing ctx above.
      now_utc: now_d.toISOString(),
      unread_inbox: unread.map((m) => ({
        from: m.from_specialist_id,
        kind: m.kind,
        body_md: m.body_md,
        related_proposal_id: m.related_proposal_id ?? undefined,
        related_interrupt_id: m.related_interrupt_id ?? undefined,
      })),
    });
  } else {
    // Resolve the brief recipient's display name so prompt
    // placeholders ({{user_name}}) render with a real name instead
    // of the env-default `jasper`. Falls back to capitalizing the
    // user_id when the users registry isn't wired or doesn't have
    // the user; falls back to `Jasper` as a final safety net so
    // legacy single-user prompts still read naturally.
    const recipient = input.users?.get(brief_user_id) ?? null;
    const user_display_name =
      recipient?.display_name ??
      (brief_user_id ? brief_user_id.charAt(0).toUpperCase() + brief_user_id.slice(1) : 'Jasper');
    // Identity for the deliberation turn's ToolContext. Without this the
    // turn ran user-less, so every user-scoped tool a specialist calls in
    // a pass — record_civic_item (Ruby's office), record_decision, etc. —
    // failed with "no user in context" and silently no-op'd. That left
    // Ruby's civic pane permanently empty: she recorded items every pass
    // and every write was rejected. Resolve the recipient as the turn user
    // so deliberation-time writes land under the right user_id.
    const turn_user: SpecialistTurnInput['user'] = {
      id: brief_user_id,
      display_name: user_display_name,
      tier: recipient?.tier ?? 'owner',
      timezone: brief_tz,
    };
    const llm_out = await llm_deliberation(
      specialist,
      slot,
      ctx,
      runtime,
      spatial_context,
      unread,
      open_misses_ctx,
      user_display_name,
      turn_user,
      input.directed_task,
      roster_gap_section,
      standing_duties,
      // Facet signal: pull_brief_context omits the `ev` block for a user
      // without the `ev` facet (2026-06-15), so its presence IS "this
      // recipient has an EV." Drives the brief prompt to drop all EV mentions
      // for a no-EV user (Sam) while keeping the owner's brief unchanged.
      Boolean(verified_life_context?.ev),
      input.trigger_context,
    );
    envelope = llm_out.envelope;
    pass_tool_results = llm_out.tool_results;
    pass_raw_text = llm_out.raw_text;
  }

  if (!envelope) {
    // Fixture path: a null fixture is an intentional test shape — preserve
    // the original silent return so the proactive smoke's audit counts stay
    // byte-identical. The recovery + observability below is for the live
    // LLM path only.
    if (TEST_MODE()) return null;
    // The model produced output (tokens_out was logged) but it didn't parse
    // into an envelope — fence/format drift on the deep tier, worst on the
    // owner's larger brief prompt and under load. One tool-free reformat
    // pass recovers the common case; either way this path is now AUDITED
    // instead of evaporating silently (the 2026-06-17 missing-owner-brief
    // class: tokens_out logged, no brief, no audit row, no trace).
    if (pass_raw_text.trim()) {
      envelope = await reformat_envelope(runtime, pass_raw_text);
    }
    if (envelope) {
      memory.log_action({
        intent_id: ulid(),
        agent: specialist.id,
        user_id: brief_user_id,
        tool_name: 'deliberation_envelope_reformatted',
        tool_input: { slot },
        execution_result: { recovered: true },
      });
    } else {
      memory.log_action({
        intent_id: ulid(),
        agent: specialist.id,
        user_id: brief_user_id,
        tool_name: 'deliberation_envelope_unparsed',
        tool_input: { slot, raw_len: pass_raw_text.length },
        execution_result: { recovered: false, raw_preview: pass_raw_text.slice(0, 500) },
      });
      console.error(
        `[deliberation] ${specialist.id} ${slot} (user=${brief_user_id}) produced an ` +
          `unparseable envelope (${pass_raw_text.length} chars)`,
      );
      // A Kate brief slot still owes the dashboard a brief — don't give up.
      // Fall through with an empty envelope shell so the guaranteed-brief
      // step below regenerates it from the gathered context. Non-brief
      // passes have nothing else to do.
      if (!is_kate_report_pull) return null;
      envelope = { summary_for_self: '', flags: [], proposals: [], interrupts: [], miss_actions: [] };
    }
  }

  // 1. Append summary to THIS user's memory file. Passing `input.user_id`
  //    (2026-07-29) is what makes the per-user split real: the argument had
  //    been omitted since Phase 2b, so every per-user pass — every specialist,
  //    not just Kate — wrote its summary into the canonical `memory.md`. No
  //    `memory_<user_id>.md` had ever been created. Symmetric with the tail
  //    read above: a user-less domain pass still writes `memory.md`.
  if (envelope.summary_for_self && envelope.summary_for_self.length > 0) {
    append_to_memory(
      memory,
      specialist.id,
      envelope.summary_for_self,
      `deliberation ${slot}`,
      input.user_id,
    );
  }

  // 2. Create proposals (so we know their IDs for ready_for_review / flags).
  const created_proposal_ids: string[] = [];
  for (const p of envelope.proposals ?? []) {
    // Validate before create — `extract_envelope` casts the parsed JSON
    // without checking each proposal's fields, so an LLM that emits the
    // Qwen-empty-args family (the same one that produces the malformed flags
    // dropped below) can hand us a proposal missing its required fields. Drop
    // the un-fileable ones here as a known recoverable failure rather than
    // throwing inside create() (which would lose later proposals in the same
    // envelope to the catch) or crashing `title_preview` on a nullish
    // rationale. `kind` (what to do) and `payload` (the parameters) are
    // structurally required — they are the proposal analogue of a flag's
    // `to_specialist_id` + `body_md`. `rationale_md` is explanatory: default
    // it so an otherwise-valid proposal still files (create() coerces it too,
    // but `title_preview` below reads it directly).
    if (!p || typeof p !== 'object' || typeof p.kind !== 'string' || !p.kind.trim()) {
      console.warn(
        `[deliberation] dropped proposal from ${specialist.id}: missing/empty kind`,
      );
      continue;
    }
    if (!p.payload || typeof p.payload !== 'object') {
      console.warn(
        `[deliberation] dropped proposal from ${specialist.id} (${p.kind}): missing/empty payload`,
      );
      continue;
    }
    const rationale_md = typeof p.rationale_md === 'string' ? p.rationale_md : '';
    try {
      const id = proposals.create({
        specialist_id: specialist.id,
        kind: p.kind,
        // Cordon action proposals to the brief's recipient; create()
        // forces NULL for system/self-improvement kinds regardless.
        user_id: brief_user_id,
        execution_kind: p.execution_kind,
        payload: p.payload,
        rationale: rationale_md,
        signature: { ...p.category_signature, specialist_id: specialist.id },
      });
      created_proposal_ids.push(id);
      emit_for_proposal_created(events, {
        proposal_id: id,
        specialist_id: specialist.id,
        kind: p.kind,
        title_preview: rationale_md.slice(0, 80),
        payload: p.payload,
        filter_ctx: {
          db,
          vault_root,
          // v0.1: deliberation runs without a logged-in user; treat
          // owner-tier proposals as the owner's. Multi-user routing
          // lands when deliberation gains per-user context.
          user_id: process.env.HEARTH_FILTER_DEFAULT_USER_ID ?? 'jasper',
        },
      });
    } catch (err) {
      console.error(`[deliberation] proposal create failed for ${specialist.id}:`, err);
    }
  }

  // 3. Flags to other specialists. Validate before push so an LLM
  // that produces a malformed flag (null/empty required fields, the
  // same Qwen-empty-args family) doesn't trip the SQLite NOT NULL
  // constraint at the storage layer — the storage error is a noisy
  // stack trace and the deliberation pass loses subsequent flags
  // in the same envelope; validating here logs it as a known
  // recoverable failure and keeps the pass going.
  for (const f of envelope.flags ?? []) {
    if (
      !f.to_specialist_id ||
      typeof f.to_specialist_id !== 'string' ||
      !f.to_specialist_id.trim()
    ) {
      console.warn(
        `[deliberation] dropped flag from ${specialist.id}: missing/empty to_specialist_id`,
      );
      continue;
    }
    if (!f.body_md || typeof f.body_md !== 'string' || !f.body_md.trim()) {
      console.warn(
        `[deliberation] dropped flag from ${specialist.id} to ${f.to_specialist_id}: ` +
          `missing/empty body_md`,
      );
      continue;
    }
    try {
      const kind = f.severity === 'medium-high' || f.severity === 'high' ? 'flag' : 'fyi';
      const id = inbox.push({
        from_specialist_id: specialist.id,
        to_specialist_id: f.to_specialist_id,
        kind,
        body_md: f.body_md,
        related_proposal_id: f.related_proposal_id,
        // Cordon: a flag emitted during a per-user (Kate brief) pass scopes
        // to that user; a user-less domain pass leaves it NULL (shared).
        originating_user_id: input.user_id ?? null,
      });
      events?.emit({
        type: 'inbox_message_added',
        message_id: id,
        from_specialist_id: specialist.id,
        to_specialist_id: f.to_specialist_id,
        kind,
        severity: f.severity,
      });
    } catch (err) {
      console.error(`[deliberation] flag create failed for ${specialist.id}:`, err);
    }
  }

  // 4. Interrupts.
  for (const i of envelope.interrupts ?? []) {
    try {
      await input.fire_interrupt(i.severity, i.details_md, i.summary);
    } catch (err) {
      console.error(`[deliberation] interrupt failed for ${specialist.id}:`, err);
    }
  }

  // 5. Process-miss actions — Mariah's autonomous miss-drive. Gated on
  // `drive_process_misses` (the meta-agents Mariah + Beatrice), so a
  // domain specialist that merely FILES misses (write_process_miss) never
  // drives the ledger via the envelope. `apply_miss_action` runs the
  // lifecycle transition and the redo/escalate inbox side effects. A
  // bad action (unknown id, illegal transition, missing note) is logged
  // and skipped — same defensive posture as the flag validation above —
  // so the rest of the envelope still applies.
  let miss_actions_applied = 0;
  if (input.process_misses && can_drive_misses) {
    for (const ma of envelope.miss_actions ?? []) {
      if (!ma || typeof ma.miss_id !== 'string' || !ma.miss_id.trim()) {
        console.warn(
          `[deliberation] dropped miss_action from ${specialist.id}: missing/empty miss_id`,
        );
        continue;
      }
      if (!MISS_ACTIONS.includes(ma.action)) {
        console.warn(
          `[deliberation] dropped miss_action from ${specialist.id} on ${ma.miss_id}: ` +
            `unknown action "${ma.action}"`,
        );
        continue;
      }
      if (!ma.note || typeof ma.note !== 'string' || !ma.note.trim()) {
        console.warn(
          `[deliberation] dropped miss_action ${ma.action} from ${specialist.id} ` +
            `on ${ma.miss_id}: missing/empty note`,
        );
        continue;
      }
      try {
        apply_miss_action({
          misses: input.process_misses,
          inbox,
          miss_id: ma.miss_id,
          action: ma.action,
          note: ma.note,
          reporter: specialist.id,
          events,
        });
        miss_actions_applied++;
      } catch (err) {
        console.error(
          `[deliberation] miss_action ${ma.action} on ${ma.miss_id} ` +
            `failed for ${specialist.id}:`,
          err,
        );
      }
    }
  }

  // 5.4. Guaranteed brief (2026-06-18). The brief is a first-class
  // deliverable, not an optional envelope field — but the 35B intermittently
  // ends a brief-slot pass with NO morning_brief: the envelope drifted
  // unparseable, parsed without a brief, or the turn spiraled into a
  // blank_turn_fallback (taking the brief down with it). When that happens,
  // regenerate the brief with a dedicated TOOL-FREE call grounded in the
  // context this pass already gathered (verified life-context + the pass's
  // tool results + the inbox). A single tool-free call can't spiral, so it's
  // far more reliable than the 15-tool turn that dropped the brief. Fail-open:
  // a null result just leaves the brief absent, exactly as before. Runs
  // BEFORE the critic so a regenerated brief is still grounding-checked.
  if (is_kate_report_pull && !envelope.morning_brief && !TEST_MODE()) {
    const fb = await generate_brief_fallback({
      runtime,
      specialist,
      slot,
      brief_kind: SLOT_TO_BRIEF_KIND[slot] ?? 'ad_hoc',
      user_display_name:
        input.users?.get(brief_user_id)?.display_name ??
        (brief_user_id ? brief_user_id.charAt(0).toUpperCase() + brief_user_id.slice(1) : 'Jasper'),
      now_local: format_now_anchor(brief_tz, now_d),
      verified_life_context,
      tool_results: pass_tool_results,
      unread,
    });
    if (fb) {
      envelope.morning_brief = {
        generated_at: now_d.toISOString(),
        sections: fb.sections,
        mood: fb.mood,
      };
    }
    memory.log_action({
      intent_id: ulid(),
      agent: 'kate',
      user_id: brief_user_id,
      tool_name: 'brief_fallback_generated',
      tool_input: { slot },
      execution_result: { recovered: Boolean(fb) },
    });
  }

  // 5.5. Brief fact critic (Durable Truth Phase 1.5 — deliberation arm).
  // Kate's brief is the dashboard hero card; deliberation had no Phase-1
  // enforcement, so a recalled date / invented agenda item / stale figure
  // that slipped past the prompt-level HARD RULE shipped straight to the
  // user. Run the semantic critic against the same verified context the
  // brief was generated from; on findings, re-prompt TOOL-FREE to ground
  // or drop the specifics (no tool calls → no proposal double-creation —
  // why this lives here, not in a deliberation re-run). Fixture passes
  // (TEST_MODE) and the HEARTH_FACT_CRITIC kill switch skip it; fail-open
  // throughout. See src/core/brief_critic.ts.
  if (
    specialist.id === 'kate' &&
    envelope.morning_brief &&
    !TEST_MODE() &&
    process.env.HEARTH_FACT_CRITIC !== '0'
  ) {
    try {
      const brief_parts = {
        verified: [JSON.stringify(ctx)],
        retrieved: unread.map((m) => m.body_md).filter(Boolean),
        // What Kate fetched DURING the pass (weather, calendar, …) is
        // the evidence the brief was actually written from — without it
        // the critic false-flags correctly-retrieved specifics.
        tool_results: pass_tool_results,
      };
      const critique = await critique_and_correct_brief({
        sections: envelope.morning_brief.sections,
        grounding: build_grounding_context(brief_parts),
        evidence_text: build_grounding_evidence(brief_parts),
        llm: runtime.llm,
        // Kate + her staff roster: "Beatrice flagged X" in a brief is
        // routing, never a fabrication (live false positive 2026-06-09).
        self_identity:
          `You are ${specialist.name}, ${specialist.role}. Your colleagues ` +
          `(referring to them is never a fabrication): ` +
          runtime
            .list()
            .map((s) => `${s.name} (${s.id})`)
            .join(', ') +
          '.',
      });
      if (critique.findings.length > 0) {
        if (critique.corrected) {
          envelope.morning_brief.sections = critique.sections;
        }
        memory.log_action({
          intent_id: ulid(),
          agent: 'kate',
          user_id: brief_user_id,
          tool_name: 'fact_critic',
          tool_input: {
            surface: 'deliberation_brief',
            slot,
            unsupported: critique.findings
              .map((f) => `${f.kind}:${f.claim}`)
              .slice(0, 10),
          },
          execution_result: { corrected: critique.corrected },
        });
      }
    } catch {
      // Fail-open: a critic error must never block the brief.
    }
  }

  // 6. Brief, if Kate at a report-time slot.
  if (specialist.id === 'kate' && envelope.morning_brief) {
    const brief_kind = SLOT_TO_BRIEF_KIND[slot] ?? 'ad_hoc';
    const brief_id = ulid();
    db.prepare(
      `INSERT INTO briefs
       (id, ts_generated, generated_by_specialist_id, kind, sections_json, mood, user_id)
       VALUES (@id, @ts, @sid, @k, @sec, @mood, @uid)`,
    ).run({
      '@id': brief_id,
      // Stamp the generation instant server-side (UTC ISO, per the
      // store-UTC convention so `ORDER BY ts_generated DESC` stays
      // monotonic). The envelope's LLM-produced `generated_at` is
      // advisory only — never trust a model to author a timestamp.
      '@ts': deliberation_started_at,
      '@sid': 'kate',
      '@k': brief_kind,
      '@sec': JSON.stringify(envelope.morning_brief.sections),
      '@mood': envelope.morning_brief.mood,
      // Same brief_user_id resolved above for verified_life_context —
      // the brief content was generated against THIS user's signals,
      // so it must be stamped to them. The routes filter on this column.
      '@uid': brief_user_id,
    });
    // Attribute any present_questions rows Kate created during this
    // deliberation pass to the brief that just landed. Scoped to the
    // specialist + the wall-clock window so we never sweep a row from
    // an earlier pass or a chat turn that happened to land during the
    // deliberation window into the wrong brief.
    db.prepare(
      `UPDATE pending_questions
          SET brief_id = @bid
        WHERE specialist_id = @sid
          AND brief_id IS NULL
          AND conversation_id IS NULL
          AND ts_created >= @since`,
    ).run({
      '@bid': brief_id,
      '@sid': specialist.id,
      '@since': deliberation_started_at,
    });

    events?.emit({
      type: 'brief_generated',
      brief_id,
      kind: brief_kind,
      mood: envelope.morning_brief.mood,
      user_id: brief_user_id,
    });
  }

  // 7. Mark consumed inbox messages as actioned.
  for (const m of unread) {
    inbox.mark_actioned(m.id);
  }

  // 8. Audit the deliberation.
  memory.log_action({
    intent_id: ulid(),
    agent: specialist.id,
    tool_name: 'deliberation_pass',
    tool_input: {
      slot,
      observations_count: observations.length,
      unread_count: unread.length,
      ...(input.directed_task ? { directed: true } : {}),
    },
    execution_result: {
      flags_count: (envelope.flags ?? []).length,
      proposals_count: created_proposal_ids.length,
      interrupts_count: (envelope.interrupts ?? []).length,
      miss_actions_count: miss_actions_applied,
      brief_generated: Boolean(envelope.morning_brief),
    },
  });

  // 9. Status pulse: "ready: ..." if there was output, else clear.
  const status_msg = (() => {
    const parts: string[] = [];
    if (created_proposal_ids.length > 0) parts.push(`${created_proposal_ids.length} proposal`);
    if ((envelope.flags ?? []).length > 0) parts.push(`${(envelope.flags ?? []).length} flag`);
    if ((envelope.interrupts ?? []).length > 0) parts.push(`${(envelope.interrupts ?? []).length} interrupt`);
    if (miss_actions_applied > 0) parts.push(`${miss_actions_applied} miss`);
    return parts.length === 0 ? null : `ready: ${parts.join(', ')}`;
  })();
  if (status_msg) {
    events?.emit({
      type: 'specialist_status',
      specialist_id: specialist.id,
      status: status_msg,
      ttl_seconds: 60,
    });
  } else {
    events?.emit({
      type: 'specialist_status',
      specialist_id: specialist.id,
      status: null,
      ttl_seconds: 1,
    });
  }

  return envelope;
}

// Specialists whose flags are owner-ops / Hearth-internal — never a household
// member's personal brief, even for a member granted '*' specialists.
const HEARTH_META_SPECIALISTS: ReadonlySet<string> = new Set([
  'trainer', // Beatrice — self-modification proposals, code review
  'mariah', // program-management scans, miss-driving
  'orchestrator', // system bootstraps + meta flags
]);

/**
 * Scope a household member's brief inbox to flags that are actually THEIRS:
 * their own (originating_user_id = them) plus flags from specialists they
 * actually work with (allowed_specialists). Drops the household/system-shared
 * (originating_user_id NULL) ops + Hearth-internal stream that legitimately
 * fills the OWNER's brief — the data-level enforcement of the non-owner brief
 * framing, after the prompt-only version let Jasper's noise into Sam's brief
 * (2026-06-16). Owner briefs never call this (they want the full stream).
 */
export function scope_member_brief_inbox<
  T extends { from_specialist_id: string; originating_user_id: string | null },
>(rows: T[], recipient: { id: string; allowed_specialists: '*' | string[] }): T[] {
  const allow_all = recipient.allowed_specialists === '*';
  const allowed = Array.isArray(recipient.allowed_specialists)
    ? new Set(recipient.allowed_specialists)
    : null;
  return rows.filter((m) => {
    if (m.originating_user_id === recipient.id) return true; // their own flag
    if (m.originating_user_id !== null) return false; // another user's personal flag — never theirs
    if (HEARTH_META_SPECIALISTS.has(m.from_specialist_id)) return false; // owner-ops / Hearth-internal
    // Remaining are household/system-shared (NULL) — keep only from specialists
    // they actually work with.
    return allow_all || (allowed?.has(m.from_specialist_id) ?? false);
  });
}

interface InboxRenderItem {
  id: string;
  ts: string;
  from_specialist_id: string;
  kind: string;
  body_md: string;
  related_proposal_id: string | null;
  related_interrupt_id: string | null;
}

/**
 * Render the unread inbox as readable markdown sections, NOT JSON.
 * Qwen and similar models extract fields ("verbatim feedback was 'foo'")
 * from prose far more reliably than from nested JSON inside a larger
 * context envelope. The body is reproduced verbatim with a header that
 * names the sender, kind, and any related proposal/interrupt id so the
 * LLM can cross-reference.
 */
/**
 * Cumulative char budget for the WHOLE rendered inbox section. The per-item
 * 4,000 cap alone let 50 gathered items render ~69,500 chars (~19k tokens) —
 * measured on Ruby's 2026-08-05 06:15 pass after a peer's consult spiral
 * filed 256 messages in a day, and it was the dominant term in every one of
 * her round-0 `static_prompt` context-overflow deaths. Items past the budget
 * still appear (id + sender + a one-line preview) so nothing is invisible;
 * only the BODIES stop being verbatim. Full content stays at the inbox row.
 */
const INBOX_RENDER_BUDGET_CHARS = 12_000;

function render_inbox_section(unread: InboxRenderItem[]): string {
  if (unread.length === 0) return '';
  // Collapse exact duplicates (same sender, kind, body) into one rendered
  // item. A spiralling peer sends the same question dozens of times — the
  // 2026-08-04 trainer consult loop landed near-identical bodies 250+ times —
  // and each copy carries zero new information but full prompt cost.
  const groups = new Map<string, { first: InboxRenderItem; dup_ids: string[] }>();
  for (const m of unread) {
    const key = `${m.from_specialist_id}\0${m.kind}\0${m.body_md}`;
    const g = groups.get(key);
    if (g) g.dup_ids.push(m.id);
    else groups.set(key, { first: m, dup_ids: [] });
  }
  const items = [...groups.values()];
  const out: string[] = [];
  out.push('\n');
  out.push('## Unread inbox — read each FULLY, the bodies often contain the verbatim text and structured fields you need for your next tool call. Process each one and act on it (flag onward, draft a proposal, etc.) rather than letting it sit.\n');
  let spent = 0;
  for (let i = 0; i < items.length; i++) {
    const { first: m, dup_ids } = items[i]!;
    const refs: string[] = [];
    if (m.related_proposal_id) refs.push(`related proposal: ${m.related_proposal_id}`);
    if (m.related_interrupt_id) refs.push(`related interrupt: ${m.related_interrupt_id}`);
    if (dup_ids.length > 0) refs.push(`+${dup_ids.length} identical cop${dup_ids.length === 1 ? 'y' : 'ies'} (collapsed)`);
    const refs_clause = refs.length ? ` — ${refs.join(', ')}` : '';
    out.push(`### Inbox item ${i + 1} of ${items.length}`);
    out.push(`From: \`${m.from_specialist_id}\`  ·  Kind: \`${m.kind}\`  ·  ID: \`${m.id}\`  ·  ts: ${m.ts}${refs_clause}`);
    out.push('');
    // Per-item cap, then the section-wide budget: once cumulative bodies
    // hit it, remaining items render as one-line stubs instead of bodies.
    const capped =
      m.body_md.length > 4000
        ? m.body_md.slice(0, 4000) +
          `\n\n[…full ${m.body_md.length}-char body truncated for prompt budget; full content at inbox row ${m.id}]`
        : m.body_md;
    if (spent >= INBOX_RENDER_BUDGET_CHARS) {
      out.push(
        `_[body withheld for prompt budget — ${m.body_md.length} chars; read it at inbox row ${m.id}]_ ` +
          m.body_md.slice(0, 160).replace(/\s+/g, ' '),
      );
    } else {
      out.push(capped);
      spent += capped.length;
    }
    out.push('');
    out.push('---');
    out.push('');
  }
  return out.join('\n');
}

interface OpenMissItem {
  id: string;
  subject_specialist_id: string;
  status: string;
  severity: string;
  task_summary: string;
  gap: string;
  routed_to: string | null;
}

/**
 * Render Mariah's open process misses as a readable markdown checklist.
 * The next legal lifecycle step is named per miss so the model emits a
 * valid `miss_actions` entry without having to recall the lifecycle.
 */
function render_miss_section(open_misses: OpenMissItem[]): string {
  if (open_misses.length === 0) return '';
  const next_step: Record<string, string> = {
    open: 'route — take ownership',
    routed: 'dispatch_redo — send the subject a redo (or escalate if it keeps recurring)',
    redo_dispatched: 'verify — confirm the redo closed the gap',
    verified: 'close — the gap is closed',
    escalated: 'with Beatrice now — usually nothing left for you to drive',
  };
  const out: string[] = [];
  out.push('\n');
  out.push(
    `## Open process misses (${open_misses.length}) — your ledger. Drive each one forward this pass; do not let an open miss sit untouched.\n`,
  );
  out.push(
    'A miss is addressed by its exact backtick-quoted id below (the `pm_…` ' +
      'string). Copy it verbatim into `miss_actions` / miss tools — never ' +
      'compose or abbreviate an id.\n',
  );
  // The id is the ONLY salient token in the heading on purpose. An
  // earlier rendering led with "Miss 14 of 35 — `pm_xxx`" and the model
  // pattern-completed the ordinal into fabricated ids (`pm_14_of_35`),
  // which landed as junk batch-action proposals in the owner's queue
  // (2026-06-08). Counts live in the section header; per-miss headings
  // carry nothing but the real id.
  for (const m of open_misses) {
    out.push(`### \`${m.id}\``);
    out.push(
      `Subject: \`${m.subject_specialist_id}\`  ·  Status: \`${m.status}\`  ·  Severity: ${m.severity}`,
    );
    out.push(`Task: ${m.task_summary}`);
    out.push(`Gap: ${m.gap}`);
    out.push(`Next step: ${next_step[m.status] ?? 'review'}`);
    out.push('');
  }
  return out.join('\n');
}

async function llm_deliberation(
  specialist: LoadedSpecialist,
  slot: string,
  ctx: unknown,
  runtime: SpecialistRuntime,
  spatial_context: string | null,
  unread: InboxRenderItem[],
  open_misses: OpenMissItem[],
  /** Display name of the brief's recipient — substituted into
   *  `{{user_name}}` placeholders in the prompt template so Kate's
   *  brief reads "Sam, should we…" in Sam's brief and "Jasper,
   *  should we…" in Jasper's. Defaults to "Jasper" for legacy
   *  callers; the brief template falls through naturally. */
  user_display_name: string = 'Jasper',
  /** Full turn-user identity for the deliberation's ToolContext. When
   *  absent (legacy callers), user-scoped tools run user-less and reject
   *  their writes — see the call site in deliberation_pass. */
  turn_user?: SpecialistTurnInput['user'],
  /** Owner-directed task — when set, this pass executes the directive on the
   *  strong model with a focused tool surface instead of the standing work. */
  directed_task?: DirectedTask,
  /** Pre-rendered roster-gap section (drive_roster_gaps holders only;
   *  empty for everyone else and on most passes). Rendered upstream in
   *  deliberation_pass so the mining is computed once and audited. */
  roster_gap_section: string = '',
  /** Pre-rendered standing-duty rota for THIS slot and local date (2026-08-03),
   *  same upstream-render pattern as `roster_gap_section` — the resolution
   *  needs `now` and the recipient's timezone, both of which live in
   *  deliberation_pass. Empty for a specialist that declares no duties, and on
   *  a slot where none are due. Deliberately a PROSE section rather than a
   *  `ctx` field: the rota is imperative (what to do now), not evidence, and
   *  ctx is serialized into a ```json block where an instruction list would
   *  arrive as escaped newlines inside a string. */
  standing_duties_section: string = '',
  /** Does the brief recipient have the `ev` facet? When false, the brief
   *  prompt drops every EV mention (legend, priority, forbidden-pattern,
   *  device-owner hint) so a no-EV user's brief never references one.
   *  Defaults true → legacy/owner behavior is byte-identical. */
  brief_has_ev: boolean = true,
  /** Reactive-trigger framing (see TriggerContext). When set, the prompt's
   *  standing "scheduled reflection" prelude is replaced with scoped
   *  system-trigger framing pointed at the task. Omitted on scheduled passes. */
  trigger_context?: TriggerContext,
): Promise<{ envelope: DeliberationEnvelope | null; tool_results: string[]; raw_text: string }> {
  const is_kate_report = specialist.id === 'kate' && slot in SLOT_TO_BRIEF_KIND;
  const brief_kind = SLOT_TO_BRIEF_KIND[slot] ?? 'ad_hoc';
  const can_drive_misses = specialist.granted.has('drive_process_misses');
  // Non-owner briefs are personal, not the admin's ops report — keep them
  // to the recipient's own day + the specialists they actually work with
  // (2026-06-07). Data is already cordoned per-user upstream; this scopes
  // the FRAMING so a household member's brief doesn't read like Jasper's COO.
  const is_owner_brief = (turn_user?.tier ?? 'owner') === 'owner';

  const brief_section = is_kate_report
    ? `

You are preparing your **${brief_kind} brief** for {{user_name}}. The
morning_brief section is REQUIRED. This is the hero card on
{{user_name}}'s dashboard — the first thing they read on every
cold launch. It must read as "what matters in my life today," NOT
"what's happening inside the specialist autonomy machinery."
${is_owner_brief ? '' : `
THIS IS A HOUSEHOLD-MEMBER BRIEF, not the admin's operations report.
Keep it to {{user_name}}'s OWN day — their calendar, their
commitments, the weather where THEY are. Mention another specialist's
item only when it's about {{user_name}} specifically AND comes from a
specialist they actually work with. Skip household-ops coordination,
other people's business, and ALL Hearth-internal / autonomy content.
`}

VERIFIED LIFE CONTEXT — your canonical source for any number,
percentage, state descriptor, or named entity in the brief. The
Context above includes a \`verified_life_context\` block that was
just pre-pumped this pass:${brief_has_ev ? `
  - ev.soc_percent / ev.range_miles — Home Assistant entities` : ''}
  - weather.forecast / .precip_probability_today /
    .temperature_high_today / .temperature_low_today /
    .active_alert_count — Pirate Weather API at the user's home coords
  - weather.indoor_temp — Home Assistant room sensor
  - calendar.today / .tomorrow — iOS-sourced calendar snapshot
    (POST /api/sensors/calendar — replaces the deprecated HA-CalDAV
    path; aggregates iCloud + Google + Exchange via EventKit)
  - relationships.overdue — people {{user_name}} is overdue to reconnect
    with (their contact cadence vs when they were last in touch);
    relationships.occasions — upcoming birthdays / anniversaries / tracked
    dates from {{user_name}}'s people. When something here is timely,
    surface it in attention_today with a concrete, warm next step (a quick
    note, a gift idea with lead time) — the chief-of-staff touch, not a
    nag. Use ONLY the names/dates in this block; never invent one.

Each reading carries:
  - status: 'fresh' (real value from the named source) or
    'unavailable' (source not configured / not reachable / no data
    yet — the reason is in the \`reason\` field)
  - source_entity: the HA entity_id, the provider name, or null
  - value: the raw reading
  - unit: when known
  - ts_read: when this puller ran

When the Context carries a \`situational_signals\` block (the fused
household pulse: mail needing attention, live people signals, upcoming
life events, purchase follow-ups, pending decisions), treat it as the
SAME class of verified evidence as verified_life_context — real
cordoned reads pulled this pass. Weave what's timely into the brief;
it is CAPPED, so absence there is not proof of absence.

When the Context carries an \`own_watchlist\` block, those are YOUR OWN
open watch items from your nightly walk of the house — things you
decided to keep an eye on, with how long you've been watching. Fold
the ones still worth the owner's awareness into the brief's
\`watching\` section IN YOUR OWN WORDS (they are already yours); drop
any the picture has since resolved.

**HARD RULE — VALUES COME FROM verified_life_context, NOT FROM
RECALL.** If a reading is marked status='unavailable', YOU DO NOT
STATE A VALUE FOR IT. Period. Don't paraphrase, don't infer,
don't pull from recent_memory_excerpts, don't make up a plausible
number. Either cite the verified value, omit the claim entirely,
or say "I don't have a current reading on X."${brief_has_ev ? ` This is the rule
that prevents "Ioniq 5 at 97%" when the SoC entity isn't even
configured.` : ''}

For signals NOT in verified_life_context (pet medical, garden,
finance, family) read fresh THIS pass:
  - Recent inbox flags from Anya / Eleanor / Brigid / Vivian
    appear in the unread_inbox prose section — those are MEDIUM
    trust (peer LLM narrative); pointers worth following but not
    citations.
  - For anything in the vault, call search_library / read_note
    THIS pass before stating a value. If you can't get a fresh
    read, omit the claim.

When you need a value not yet in verified_life_context, you may
still call read tools (sensor_calendar_upcoming, weather_now,
weather_forecast, weather_alerts, search_library, web_search) —
those tool returns are HIGH trust the same way verified_life_context
is. You no longer read Home Assistant directly: smart-home / device
values (${brief_has_ev ? 'EV charge, ' : ''}indoor temp) arrive PRE-PUMPED in
verified_life_context, and for anything more you consult the
specialist who owns the device (${brief_has_ev ? 'Iris for the EV, ' : ''}Eleanor for the
garden) rather than reading HA yourself. The perimeter is the exception —
it folded into Kate on 2026-07-15, so cameras, network posture, faces and
occupancy are read with her OWN tools, not consulted out.

SECTIONS — priority ordering. Every section follows the same
priority for what goes first. **Life first, Hearth-meta last or
omitted.**

  Priority 1 — Weather worth acting on. Precip windows, temperature
    extremes, air-quality changes, sunset times when relevant. One
    sentence with the action implication baked in
    ("Storms late afternoon — morning's the window for the deck
    repair.").
  Priority 2 — Household state. Pet medical (Anya), household
    systems flagged by Iris (CO2, indoor temp, security${brief_has_ev ? `, EV charge
    when it constrains plans` : ''}), appliance/delivery events.
  Priority 3 — Life-side calendar events. What's scheduled today +
    tomorrow, conflicts, anything Brigid or Vivian noticed that he
    should know.
  Priority 4 — Promised follow-ups landing today. Things Hearth
    committed to surface back when ready (promise_followup payloads).
  Priority 5 (LAST OR OMITTED) — Hearth-internal autonomy events.
    Trainer binding proposals, Mariah program-management scans,
    signature-graduation candidates, authenticity scores, persona
    tuning suggestions, connector affordance audits. These live in
    \`watching\` or in \`ready_for_review\` as proposal entries —
    NOT in \`noticed\` or \`attention_today\`.

Sections:
  - noticed: 2-4 short sentences leading with Priority 1-3 signals.
    The lead sentence is life-side. **Never list Hearth-internal
    proposal_ids in noticed.** A single line "queued N for your
    review" is fine; enumerating them is not.
  - attention_today: HARD CAP 4 items. Each {title (≤60 chars),
    body (≤200 chars), urgency: now|today|this_week,
    source_specialist_id?}. Use the priority order above. If a 5th
    life item exists, push it to \`watching\`; if a 5th
    specialist-internal item exists, OMIT it.
  - ready_for_review: list pending proposals as {proposal_id,
    one_line_summary}. Full one-line summaries — this section is
    consumed by the Proposals sheet and benefits from completeness.
  - watching: 1-3 short sentences for Hearth-internal autonomy
    signals (Trainer/Mariah/Beatrice observations) and any
    life-side item that didn't fit the 4-item attention_today cap.
  - mood: 'calm' | 'attentive' | 'concerned' — set to 'concerned'
    only when something is genuinely worth a slight worry; default
    'calm'.

**LENGTH BUDGET.** Total body content across all sections targets
~600 chars; hard cap ~1000. If you're over, cut Hearth-meta first,
then prose padding. Brevity beats completeness — the dashboard is
read at arm's length.

EXCEPTIONS — when Hearth-meta DOES belong in attention_today:
  (a) A proposal that requires {{user_name}}'s approval AND has a
      real-world side effect on their life (Vivian approving a
      charge, Brigid booking an actual reservation, Iris toggling
      home automation in a meaningful way). Surface as Priority 2
      or 3. Pure Hearth-meta proposals (Trainer persona tuning,
      Beatrice connector improvements, Mariah roster alignment) DO
      NOT qualify — they go to ready_for_review or watching.
  (b) A specialist's authenticity score crossing a threshold
      DOWNWARD (signal-strength bar going amber/red). Brief mention
      — {{user_name}} needs to know if Vivian or Anya is drifting.
      Routine score updates don't qualify.

**Decisions go through present_questions, not prose.** If an
attention_today item is shaped like "{{user_name}}, should we A or
B" — water the yard or skip; reply to so-and-so today or tomorrow;
book the appointment now or wait — call \`present_questions\`
BEFORE you produce the JSON envelope. 1-4 tappable questions with
2-4 options each beat a paragraph that asks {{user_name}} to type
back. The tool persists a form attached to this brief; the
right-rail card renders it inline, and {{user_name}} taps. Then
describe the situation in attention_today in TWO short lines
without re-narrating the options — they appear as buttons under
the brief. Skip the tool entirely on a quiet pass where nothing
needs {{user_name}}'s explicit nod — empty is the right brief when
there's no signal.

GROUNDING RULES — restated, because this is where briefs fail.

  HIGH trust (cite freely):
    - verified_life_context.* with status='fresh'
    - tool returns from calls you made THIS pass
    - observations[] entries from your awareness handler this cycle
    - vault_deltas[] (filesystem mtimes)

  MEDIUM trust (pointer, not citation):
    - unread_inbox prose — another LLM's narrative; use as a
      pointer to follow up, not a number to quote

  LOW trust (do NOT cite):
    - recent_memory_excerpts[] — your own mutable past prose;
      may be stale, may have been written during a contaminated
      cycle, may have been edited externally
    - verified_life_context.* with status='unavailable' — these
      are explicit "no data" markers; do NOT fill the gap from
      memory

**Forbidden patterns — never emit these unless backed by a fresh
HIGH-trust source:**${brief_has_ev ? `
  - "<vehicle> is at N%" — requires verified_life_context.ev
    .soc_percent.status='fresh' OR a fresh ha_get_state call on
    the SoC entity THIS pass` : ''}
  - "<weather descriptor>" / "N% chance of <precip>" — requires
    verified_life_context.weather.* status='fresh' OR a fresh
    weather_now / weather_forecast / weather_alerts call THIS pass
  - "<sensor> reads N" / "indoor temp is N" — same rule
  - "<calendar item> at T" — requires verified_life_context
    .calendar status='fresh' OR fresh sensor_calendar_upcoming
    THIS pass
  - "<person> said" / "<vendor> told us" — requires a fresh
    vault read or inbox reference

If a verified_life_context reading is 'unavailable', you can
mention the gap explicitly (${brief_has_ev ? `"no current EV reading this pass"` : `"no current reading on that this pass"`})
or omit the line entirely. The right brief sometimes says less.
"A quiet night; nothing pending" is the right brief when there's
no signal.

Never name a specific entity, person, place, or vendor that
doesn't appear in the HIGH-trust sources above.
`
    : '';

  const spatial_section = spatial_context
    ? `\nCurrent spatial context:\n${spatial_context}\n`
    : '';

  const miss_section =
    can_drive_misses && open_misses.length > 0
      ? `

You own the **process-miss ledger** — the open misses are listed above.
For each one, decide the single next move and emit it in \`miss_actions\`:
  - route        : take ownership of an \`open\` miss
  - dispatch_redo: send the subject specialist a redo request
  - verify       : a \`redo_dispatched\` miss's redo closed the gap
  - close        : a \`verified\` miss is done
  - escalate     : the same miss keeps recurring — hand it to Beatrice
                   for a structural fix instead of another redo
Each action MUST be the legal next step for that miss's current status
(open → routed → redo_dispatched → verified → closed). Each entry is
{ miss_id, action, note } with a one-or-two-sentence note. \`miss_id\`
is the exact backtick-quoted \`pm_…\` string from the ledger above —
copy it verbatim; a composed or abbreviated id targets nothing. Leave
\`miss_actions\` empty only when there are genuinely no open misses to move.
`
      : '';

  // Per-specialist prelude override (proactive.deliberation_prelude_override).
  // Default prelude is "be conservative, most of the time it's nothing" —
  // correct for passive reflective specialists; wrong for active-research
  // specialists whose deliberation is supposed to always do work. When
  // set, replaces the default opening framing entirely.
  const default_prelude =
    `This is your scheduled ${slot} reflection. Review what's accumulated and decide:\n` +
    `  (a) what (if anything) is worth flagging to Kate or another specialist,\n` +
    `  (b) what proposals you should prepare for Jasper's review,\n` +
    `  (c) what observations you should commit to memory.\n\n` +
    `Be conservative. Most of the time the answer is 'nothing needs attention'.\n\n`;
  // Reactive-trigger prelude (2026-06-18): this pass was woken off-schedule
  // by a real-world event, not the clock. Replace the standing "scheduled
  // reflection / be conservative" framing with scoped trigger framing pointed
  // at the task — but keep the rest of the prompt body (trust tiers, inbox,
  // context, envelope shape). Takes precedence over a prelude_override since a
  // triggered pass is, by definition, not the standing scheduled work.
  const trigger_prelude = trigger_context
    ? `# ⚡ You were woken off-schedule — a triggered pass, NOT your scheduled ${slot} review.\n\n` +
      `What happened: ${trigger_context.reason.trim()}\n\n` +
      `Focus this pass on: ${trigger_context.task.trim()}\n\n` +
      `Check the CURRENT state with your tools before asserting anything — do not\n` +
      `recall from memory. Be useful but restrained: if nothing actually needs\n` +
      `attention right now, say so in summary_for_self and surface nothing.\n\n`
    : null;
  // Slot-keyed beat (2026-08-05): a multi-slot specialist keeps the shared
  // framing in `deliberation_prelude_override` and files each slot's workflow
  // under `deliberation_beats[slot]` — only THIS pass's beat ships, instead
  // of the whole rota riding every pass (Ruby's six beats were ~3.9k tokens
  // of which one pass ever runs one). Trigger passes take the trigger
  // prelude and no beat, as before — a woken pass runs the trigger's task,
  // not the slot rota.
  const slot_beat = trigger_prelude
    ? null
    : (specialist.proactive.deliberation_beats?.[slot] ?? null);
  const prelude = trigger_prelude
    ? trigger_prelude
    : specialist.proactive.deliberation_prelude_override
      ? `This is your scheduled ${slot} deliberation pass.\n\n` +
        specialist.proactive.deliberation_prelude_override.trim() +
        '\n\n' +
        (slot_beat ? `## THIS pass's beat — ${slot}\n\n${slot_beat.trim()}\n\n` : '')
      : default_prelude;

  // The current-time anchor the specialist reasons from — the SAME rich
  // moment + 8-day weekday table the chat turn renders (format_now_anchor),
  // in the recipient's zone. Rendered PROMINENTLY at the top of the prompt so
  // the model grounds "now" / "today" / weekday from it instead of digging a
  // time field out of the Context JSON (which carries a concise `now` string
  // they agree with, but NO raw UTC instant — the 2026-06-24 overnight brief
  // read that UTC field and announced "It's 4 AM Thursday" at 10 PM Wednesday).
  const now_tz = (ctx as { timezone?: string }).timezone ?? 'America/Denver';
  const now_anchor_block =
    `**Right now**: ${format_now_anchor(now_tz)}\n\n` +
    `This block is your SOLE source of truth for the current date, time, ` +
    `weekday, and what "today" / "tomorrow" mean. Never state a clock time ` +
    `or day that disagrees with it, never read the time from any other field, ` +
    `and do not say you don't know what day it is. (This pass may have been ` +
    `generated late in the evening to be read in the morning — anchor "now" ` +
    `to the moment above and refer to the day ahead as "tomorrow" or by its ` +
    `weekday from the table; don't invent a clock time.)\n\n`;

  const prompt =
    prelude +
    now_anchor_block +
    `TRUST TIERS for the Context below — treat sources differently:\n` +
    `  - observations[] : HIGH trust. Emitted by your own awareness handler\n` +
    `    from real DB/HA reads this cycle.\n` +
    `  - vault_deltas[] : HIGH trust. Filesystem reality (file paths and mtimes).\n` +
    `  - unread_inbox[] : MEDIUM trust. Peer specialists' narrative; another LLM\n` +
    `    wrote it. Useful as a pointer, not a citation.\n` +
    `  - recent_memory_excerpts : LOW trust. Your own past prose. The markdown\n` +
    `    file is mutable, may be stale, may have been written during a\n` +
    `    contaminated cycle, may have been edited externally. DO NOT treat\n` +
    `    excerpts as verified facts. Use them as priors that hint where to\n` +
    `    look — then re-derive the underlying claim from a current tool call\n` +
    `    or a HIGH-trust source THIS pass before asserting anything.\n\n` +
    `Specifically: if you want to claim a sensor's value, its threshold\n` +
    `crossing, its existence, or its non-existence — call ha_get_state /\n` +
    `ha_list_entities now. Don't recall from prior excerpts. Same for any\n` +
    `numeric, count, ETA, or status descriptor: derive it this cycle or\n` +
    `omit it.\n` +
    spatial_section +
    render_inbox_section(unread) +
    render_miss_section(open_misses) +
    roster_gap_section +
    (standing_duties_section ? `\n${standing_duties_section}\n` : '') +
    `\nContext:\n` +
    '```json\n' +
    (() => {
      // Mark the outer cap when it actually clips so the LLM doesn't
      // read a hard JSON cut as upstream truncation. Bumped from
      // 12000 → 16000 with the per-message marker change above —
      // typical contexts fit, and the explicit marker covers spikes.
      const full = JSON.stringify(ctx, null, 2);
      return full.length > 16000
        ? full.slice(0, 16000) +
            `\n…[${full.length - 16000} chars of context elided here for prompt budget; full data is in SQLite]`
        : full;
    })() +
    '\n```\n' +
    brief_section +
    miss_section +
    (specialist.proactive.deliberation_outro_override
      ? `\n` + specialist.proactive.deliberation_outro_override.trim() + '\n'
      : `\nProposals are created via tool calls (\`propose_*\` tools), not via ` +
        `this envelope. The envelope carries summary / flags / interrupts` +
        (can_drive_misses ? ' / miss_actions' : '') +
        (is_kate_report ? ' / morning_brief' : '') +
        `.\n\n` +
        `Reply with a SINGLE JSON code block of this shape (omit fields you ` +
        `don't need; arrays may be empty):\n` +
        '```json\n' +
        JSON.stringify(
          {
            summary_for_self: '',
            flags: [],
            interrupts: [],
            ...(can_drive_misses ? { miss_actions: [] } : {}),
            ...(is_kate_report
              ? {
                  morning_brief: {
                    generated_at: new Date().toISOString(),
                    sections: {
                      noticed: '',
                      attention_today: [],
                      ready_for_review: [],
                      watching: '',
                    },
                    mood: 'calm',
                  },
                }
              : {}),
          },
          null,
          2,
        ) +
        '\n```\n');

  // Directed-task pass: replace the standing prompt with a strong directive.
  // The owner handed this specialist ONE task to execute on the strong model;
  // drop the "review what's accumulated / be conservative" framing, the
  // miss-driving section, and the brief section, and instead point the model
  // squarely at the directive + its execution tools. The inbox is still
  // rendered (the directive may reference a flag), but the standing audit
  // scaffolding is suppressed so the 80B focuses on the one task.
  const directed_prompt = directed_task
    ? `# ⚡ DIRECTED TASK FROM {{user_name}}\n\n` +
      now_anchor_block +
      `{{user_name}} has handed you ONE specific task to execute in THIS deliberation pass. ` +
      `It OVERRIDES your standing ${slot} work — do NOT run your usual audit/grooming sweep. ` +
      `Do exactly what is asked, using your tools, then report what you did in summary_for_self.\n\n` +
      `## The task\n\n${directed_task.instruction.trim()}\n\n` +
      `## How to execute\n` +
      `- Your deliverable is a COMPLETED TOOL CALL, not a summary. Identify the tool the task names ` +
      `(or clearly implies) and CALL it THIS turn. Emitting the JSON envelope WITHOUT first making ` +
      `that call is a FAILURE — the task stays undone. The turn is complete only AFTER the named ` +
      `tool returns; reading or acknowledging is preparation, never the deliverable.\n` +
      `- Use ONLY the tools available to you; the surface has been narrowed to exactly what this ` +
      `task needs. Don't stop after a read.\n` +
      `- Work in YOUR domain with YOUR tools. This directive replaces your standing sweep, not ` +
      `your expertise — the writers, ledgers and offices your role owns are still where the ` +
      `deliverable lands. A task that names no tool still has an obvious one; pick it.\n` +
      `- If a task is too big for one turn — a full workup, a whole record, "everything about X" — ` +
      `and you hold a tool that hands work to a background researcher, USE IT rather than ` +
      `half-doing it inside this pass.\n` +
      `- If a tool fails, adapt: take the alternate it suggests, try a different source, or move ` +
      `on. If a tool is RETIRED mid-turn, stop calling it and finish with what you have. Ending ` +
      `the pass with nothing recorded is the one outright failure — partial findings, honestly ` +
      `labelled, always beat silence.\n` +
      `- Before asserting how a piece of code behaves, \`read_codebase_file\`/\`grep_codebase\` it ` +
      `this pass and cite file:line — an unread claim about code is a fabrication. If such a read ` +
      `returns DUPLICATE_TOOL_CALL you ALREADY have it earlier this turn; use it, don't re-call ` +
      `(re-calling spirals and burns your round budget).\n` +
      `- If the task is to author or change CODE (only if you actually hold these tools): ` +
      `\`propose_code_change\` (FULL file contents, no ` +
      `diff syntax, branch \`beatrice/<slug>\`, clear pr_title + pr_body) — opens an isolated PR for ` +
      `Kate's skeptic review and {{user_name}}'s merge approval; you do NOT merge. Adding a new tool? ` +
      `Include BOTH the tool file and the \`config/specialists/<id>.yaml\` surface edit. For a narrow ` +
      `config tuning: \`apply_low_risk_fix\`.\n` +
      `- When done, put a one-line account of the tool's REAL return (PR url / change_id / proposal ` +
      `id / verdict) in summary_for_self — never invent one.\n` +
      render_inbox_section(unread) +
      `\nReply with a SINGLE JSON code block of this shape AFTER you've made your tool calls ` +
      `(arrays may be empty):\n` +
      '```json\n' +
      JSON.stringify({ summary_for_self: '', flags: [], interrupts: [] }, null, 2) +
      '\n```\n'
    : '';

  // Substitute the recipient's display name into every `{{user_name}}`
  // placeholder in the brief template. Done at the very end so any
  // future references picked up from persona overrides / outros also
  // resolve. Non-brief prompts have zero matches, so this is a no-op
  // for non-Kate-brief deliberations.
  const final_prompt = (directed_task ? directed_prompt : prompt).replace(
    /\{\{user_name\}\}/g,
    user_display_name,
  );

  const out = await runtime.turn({
    specialist_id: specialist.id,
    conversation_id: `deliberation:${specialist.id}:${slot}`,
    message: { role: 'user', content: final_prompt },
    conversation_history: [],
    // Directed pass: focus the tool surface on what the directive needs
    // (surfaces GRANTED-but-curated-out tools like propose_code_change) and
    // give the turn headroom to author a full file.
    ...(directed_task?.tools && directed_task.tools.length > 0
      ? { tools_override: directed_task.tools }
      : {}),
    // The directed contract is "the deliverable is a completed tool call,"
    // and the prompt says so — but two directed passes at Mariah
    // (2026-06-10) still produced 62-token envelopes with ZERO tool calls.
    // When the surface was explicitly narrowed to the task's tools, force
    // the round-0 call mechanically (tool_choice: 'required').
    ...(directed_task?.tools && directed_task.tools.length > 0
      ? { require_tool_call: true }
      : {}),
    ...(directed_task ? { max_tokens_override: directed_task.max_tokens ?? 8000 } : {}),
    // Per-pass round budget (2026-08-11): a directed pass sizes its own tool
    // budget — the task's explicit rounds, else the directed default (30) —
    // instead of inheriting the specialist's chat-sized ceiling (builds died
    // at exactly 15/15 then 20/20 on 2026-08-10/11). The runtime clamps.
    ...(directed_task
      ? {
          tool_rounds_override:
            directed_task.max_tool_rounds ?? directed_tool_rounds_default(),
          // Marks the turn as a directed pass so its failures are LOUD:
          // blank_turn_fallback / ceiling exhaustion / the duplicate-failure
          // cut each file a high-severity process_miss keyed to this preview.
          directed_context: {
            instruction_preview: directed_task.instruction.slice(0, 240),
          },
        }
      : {}),
    // Carry the recipient's identity into the turn so user-scoped tools
    // (record_civic_item, record_decision, …) write under the right
    // user_id instead of rejecting with "no user in context."
    ...(turn_user ? { user: turn_user } : {}),
    // Deliberation is the canonical "reasoning matters" case — Kate
    // synthesizing across observations, Anya weighing a clinical
    // picture. Use the thinking-enabled role.
    llm_role: 'specialist_deliberation',
    // Endpoint-only override: the behavior stays `specialist_deliberation`
    // (structured-JSON prompt + tools_for_deliberation curation); only the
    // provider/model/window/timeout move.
    //
    // `deliberate_on_role` is the named form and wins when set — it can reach
    // ANY endpoint profile in llm-roles.yaml (kristi → `specialist_
    // deliberation_deep` on forza, for the 65536/slot window the deep lane
    // cannot give her). `deliberate_on_live` is the older boolean, kept
    // working: opted-in specialists drain onto the live tier's `librarian`.
    ...(specialist.proactive.deliberate_on_role
      ? {
          provider_role: specialist.proactive
            .deliberate_on_role as import('./llm').LLMRole,
        }
      : specialist.proactive.deliberate_on_live
        ? { provider_role: 'librarian' as const }
        : {}),
    // Think resolution (S4 scrutiny, 2026-07-02): explicit per-pass think →
    // scrutiny default for directed/trigger passes → YAML (now honored BOTH
    // ways; a `true` was silently dead once the role default flipped to
    // think-OFF at the 35B swap) → role default. See resolve_deliberation_think.
    ...((): { think_override?: boolean } => {
      const t = resolve_deliberation_think(specialist, directed_task, trigger_context);
      return t === undefined ? {} : { think_override: t };
    })(),
  });

  // Deliberation prompt-size observability. The prompt grows with the
  // specialist's persona + curated tool surface + (for ledger-drivers) the
  // open-miss ledger; unbounded growth silently 400s at the model's context
  // ceiling with NO prior signal — Kristi hit 45,153/49,152 on 2026-06-08
  // because the system-wide miss ledger was being surfaced to her. Logging
  // tokens_in per pass makes the approach to the ceiling visible BEFORE it
  // overflows, so the next case is caught from the logs, not a failed pass.
  console.log(
    `[deliberation] ${specialist.id} ${slot} tokens_in=${out.cost.tokens_in} ` +
      `tokens_out=${out.cost.tokens_out} model=${out.cost.model}`,
  );

  // Successful tool results from THE PASS ITSELF — the evidence the
  // envelope (and Kate's brief) was actually written from. The brief
  // critic checks the brief against its evidence; before this was
  // threaded out, a brief stating "73°F, Fire Weather Watch" from a
  // weather tool Kate called DURING the pass was judged against only
  // the pre-turn context and false-flagged as fabrication (2026-06-09).
  const tool_results = out.tool_calls_made
    .filter((c) => !c.error && c.result !== undefined)
    .map((c) =>
      typeof c.result === 'string' ? c.result : JSON.stringify(c.result),
    );

  return { envelope: extract_envelope(out.message_text), tool_results, raw_text: out.message_text };
}

/**
 * Pull the JSON envelope object out of the model's raw output.
 *
 * The deep tier (qwen36-35b-a3b) is asked for a ```json-fenced envelope,
 * but under load — and worst on the OWNER's larger brief prompt — it drifts:
 * it drops the `json` tag, omits the closing fence, or emits the bare object
 * with surrounding prose. The original strict-fence regex returned null for
 * every one of those, and `deliberation_pass` then silently produced no
 * brief and no audit row (the 2026-06-17 missing-owner-brief class:
 * tokens_out logged, nothing stored, no trace). We try, in order:
 *   1. a strict ```json fence (fast path — unchanged behavior),
 *   2. any ``` fence (json/jsonc-tagged or untagged),
 *   3. the first balanced top-level {…} object anywhere in the text.
 * Each candidate is JSON.parsed; the first that yields a plain object wins.
 * Exported for `scripts/smoke-deliberation-envelope.ts`.
 */
function parse_envelope_object(text: string): Partial<DeliberationEnvelope> | null {
  const candidates: string[] = [];
  const strict = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (strict?.[1] !== undefined) candidates.push(strict[1]);
  const loose = text.match(/```(?:json\w*)?\s*([\s\S]*?)```/i);
  if (loose?.[1] !== undefined) candidates.push(loose[1]);
  const bare = extract_first_json_object(text);
  if (bare !== null) candidates.push(bare);
  for (const c of candidates) {
    try {
      const parsed: unknown = JSON.parse(c.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Partial<DeliberationEnvelope>;
      }
    } catch {
      // malformed candidate — fall through to the next strategy
    }
  }
  return null;
}

/**
 * First balanced `{…}` block in `text`, brace-counted with string/escape
 * awareness so a `}` inside a JSON string value can't close the object
 * early. Returns null when there's no balanced object.
 */
function extract_first_json_object(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let in_str = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (in_str) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') in_str = false;
      continue;
    }
    if (ch === '"') in_str = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function extract_envelope(text: string): DeliberationEnvelope | null {
  const parsed = parse_envelope_object(text);
  if (!parsed) return null;
  return {
    summary_for_self: typeof parsed.summary_for_self === 'string' ? parsed.summary_for_self : '',
    flags: Array.isArray(parsed.flags) ? parsed.flags : [],
    proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
    interrupts: Array.isArray(parsed.interrupts) ? parsed.interrupts : [],
    miss_actions: Array.isArray(parsed.miss_actions) ? parsed.miss_actions : [],
    morning_brief: parsed.morning_brief,
  };
}

/**
 * Last-ditch recovery when `extract_envelope` still can't parse the model's
 * output (genuinely malformed JSON, not just fence drift). One TOOL-FREE
 * planner call re-emits the prior output as a clean fenced envelope —
 * mirrors the brief-critic's tool-free correction pass, so it can't re-run
 * tools or double-create proposals. Fail-open: any error → null.
 */
async function reformat_envelope(
  runtime: SpecialistRuntime,
  raw_text: string,
): Promise<DeliberationEnvelope | null> {
  let role;
  try {
    role = runtime.llm.for_role('planner');
  } catch {
    return null;
  }
  try {
    const resp = await role.provider.complete({
      messages: [
        {
          role: 'system',
          content:
            'You repair malformed structured output. The user message is a ' +
            'specialist deliberation envelope that failed to parse. Re-emit it ' +
            'as ONE ```json fenced block containing a single JSON object with ' +
            'keys summary_for_self, flags, proposals, interrupts, miss_actions, ' +
            'and (only if present in the input) morning_brief. Preserve all ' +
            'content verbatim — only fix the JSON/fence structure. Output ONLY ' +
            'the fenced block.',
        },
        { role: 'user', content: raw_text.slice(0, 12000) },
      ],
      temperature: 0,
      max_tokens: 4000,
      think: false,
      ...role.defaults,
    });
    return extract_envelope(resp.content);
  } catch {
    return null;
  }
}

type BriefMorning = NonNullable<DeliberationEnvelope['morning_brief']>;

/**
 * Dedicated, TOOL-FREE brief generation — the guaranteed-brief fallback.
 *
 * Called when a Kate brief-slot pass ended WITHOUT a morning_brief (the
 * envelope was unparseable, parsed brief-less, or the turn spiraled into a
 * blank_turn_fallback). It re-asks the model for ONLY the brief JSON, grounded
 * in the context the pass already gathered — verified life-context + the pass's
 * successful tool results + the unread inbox. No tools are offered, so it
 * cannot spiral the way the full deliberation turn did; a single fenced JSON
 * reply is all it needs. Reuses the robust `extract_envelope` parser. Fail-open
 * at every step → null leaves the brief absent (no worse than before).
 */
async function generate_brief_fallback(args: {
  runtime: SpecialistRuntime;
  specialist: LoadedSpecialist;
  slot: string;
  brief_kind: string;
  user_display_name: string;
  now_local: string;
  verified_life_context: VerifiedLifeContext | null;
  tool_results: string[];
  unread: InboxRenderItem[];
}): Promise<{ sections: BriefMorning['sections']; mood: BriefMorning['mood'] } | null> {
  let role;
  try {
    role = args.runtime.llm.for_role('specialist_deliberation');
  } catch {
    return null;
  }
  const evidence = build_grounding_evidence({
    verified: args.verified_life_context ? [JSON.stringify(args.verified_life_context)] : [],
    retrieved: args.unread.map((m) => m.body_md).filter((b): b is string => Boolean(b)),
    tool_results: args.tool_results,
  });
  const skeleton = JSON.stringify(
    {
      morning_brief: {
        sections: { noticed: '', attention_today: [], ready_for_review: [], watching: '' },
        mood: 'calm',
      },
    },
    null,
    2,
  );
  const system =
    `You are ${args.specialist.name}, ${args.specialist.role}. Write ${args.user_display_name}'s ` +
    `${args.brief_kind} brief as a warm, first-person life report. GROUND every specific ` +
    `(weather, events, figures, names) in the provided context — if a fact is not there, omit it. ` +
    `Never invent. Output ONLY the JSON envelope.`;
  const prompt =
    `It is ${args.now_local}. Write ${args.user_display_name}'s ${args.brief_kind} brief.\n\n` +
    `## Verified context — the ONLY source for specifics\n` +
    `${evidence || '(no readings were available this pass)'}\n\n` +
    '## Output — ONLY this JSON shape, inside a ```json fence\n' +
    '```json\n' +
    skeleton +
    '\n```\n' +
    `- noticed: 1-3 sentences on the state of things.\n` +
    `- attention_today: array of {title, body, urgency:"now"|"today"|"this_week"}; [] if nothing.\n` +
    `- ready_for_review: leave [] (never invent proposal ids).\n` +
    `- watching: one sentence on what you're keeping an eye on; "" if nothing.\n` +
    `- mood: "calm" | "attentive" | "concerned".\n`;
  let resp;
  try {
    resp = await role.provider.complete({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 1500,
      think: false,
      ...role.defaults,
    });
  } catch {
    return null;
  }
  const env = extract_envelope(resp.content);
  if (!env?.morning_brief) return null;
  return { sections: env.morning_brief.sections, mood: env.morning_brief.mood ?? 'calm' };
}

/**
 * Vault-delta scan: file paths under the specialist's knowledge_scope
 * whose mtimes are newer than the prior deliberation pass for this
 * specialist (or 24h ago, whichever is more recent). Best-effort,
 * filesystem-only.
 *
 * The scope globs are simplified to their roots (everything up to the
 * first wildcard) and we walk the resulting directories on disk. We
 * cap at 30 entries — beyond that the LLM context becomes the
 * bottleneck and we'd be packing noise.
 *
 * Each delta includes a short title — preferring frontmatter `title`,
 * falling back to filename. This is what gets surfaced to the
 * deliberation prompt so the specialist actually knows what arrived.
 */
function scan_vault_deltas(
  memory: MemoryClient,
  specialist: LoadedSpecialist,
  db: Database,
): Array<{ path: string; mtime: string; title?: string }> {
  const prior = db
    .prepare(
      `SELECT ts FROM audit_log
       WHERE agent = @sid AND tool_name = 'deliberation_pass'
       ORDER BY ts DESC LIMIT 1`,
    )
    .get({ '@sid': specialist.id }) as { ts: string } | undefined;
  const since = prior ? new Date(prior.ts) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since_ms = since.getTime();

  const vault_root = (memory as unknown as { cfg: { vault_root: string } }).cfg.vault_root;
  const seen = new Set<string>();
  const out: Array<{ path: string; mtime: string; title?: string }> = [];

  // Resolve each glob in knowledge_scope to a root dir to walk.
  for (const glob of specialist.knowledge_scope) {
    if (out.length >= 30) break;
    // Reject the everything-glob — too large to walk usefully.
    if (glob === '**' || glob === '**/*') continue;
    const root_rel = glob.split(/[*?{]/, 1)[0]!.replace(/\/+$/, '');
    if (!root_rel) continue;
    const root_abs = `${vault_root}/${root_rel}`;
    walk_dir_for_deltas(root_abs, root_rel, since_ms, seen, out, 30);
  }
  return out;
}

function walk_dir_for_deltas(
  abs_dir: string,
  rel_dir: string,
  since_ms: number,
  seen: Set<string>,
  out: Array<{ path: string; mtime: string; title?: string }>,
  cap: number,
): void {
  if (out.length >= cap) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = require('node:fs').readdirSync(abs_dir, { withFileTypes: true }) as import('node:fs').Dirent[];
  } catch {
    return;
  }
  for (const ent of entries) {
    if (out.length >= cap) return;
    if (ent.name.startsWith('.') || ent.name === '_attachments' || ent.name === 'node_modules') continue;
    const child_abs = `${abs_dir}/${ent.name}`;
    const child_rel = rel_dir ? `${rel_dir}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      walk_dir_for_deltas(child_abs, child_rel, since_ms, seen, out, cap);
      continue;
    }
    if (!ent.name.endsWith('.md')) continue;
    if (seen.has(child_rel)) continue;
    let st: import('node:fs').Stats;
    try {
      st = require('node:fs').statSync(child_abs) as import('node:fs').Stats;
    } catch {
      continue;
    }
    if (st.mtimeMs < since_ms) continue;
    seen.add(child_rel);
    let title: string | undefined;
    try {
      const raw = require('node:fs').readFileSync(child_abs, 'utf8') as string;
      const m = /^---\s*\n([\s\S]*?)\n---/.exec(raw);
      if (m) {
        const tm = /(^|\n)title:\s*['"]?([^'"\n]+)['"]?/.exec(m[1] ?? '');
        if (tm) title = tm[2]?.trim();
      }
    } catch {
      /* ignore */
    }
    out.push({
      path: child_rel,
      mtime: st.mtime.toISOString(),
      title,
    });
  }
}

// Re-export for tests that want to drive the parser directly.
export { extract_envelope, parse_envelope_object, generate_brief_fallback };
