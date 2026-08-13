/**
 * The three loops: awareness, deliberation, interrupt.
 *
 * See architecture.md "The three-loop model" for the design.
 *
 * - Awareness loop (LoopDriver.start_awareness): runs at each active
 *   specialist's awareness_hz. Calls the registered handler — no LLM —
 *   and appends the result to the specialist's rolling buffer.
 *
 * - Deliberation loop (LoopDriver.start_deliberation): cron-style. At each
 *   HH:MM in `deliberation_at`, fires a structured `deliberate` turn for
 *   the specialist. The LLM is asked to return a JSON envelope:
 *     { interrupt: bool, interrupt_reason?, proposals_to_create?,
 *       state_to_record? }
 *   Proposals are inserted, state appended to memory.md, and
 *   interrupt=true is fanned out via the interrupt loop.
 *
 * - Interrupt loop (LoopDriver.fire_interrupt): records the interrupt,
 *   pushes through Kate (unless the originator IS Kate), and audits a
 *   `would_have_pushed` event for the user-facing push channel (Prompt 4
 *   wires the real push).
 *
 * The deliberation cron is in-process (no separate service). We keep the
 * scheduling simple: a 60-second tick that checks every specialist's
 * deliberation_at array against the current local time (rounded to the
 * minute). DST is handled by Date's local-time methods.
 */

import { ulid } from 'ulid';
import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { LoadedSpecialist, SpecialistRegistry } from './specialist';
import type { SpecialistRuntime } from './specialist_runtime';
import type { ProposalsStore } from './proposals';
import type { ConversationStore, InterruptStore, SpecialistInbox } from '@memory/stores/conversations';
import type { MemoryClient } from '@memory/client';
import type { ProcessMissStore } from './process_misses';
import type { DirectedDispatchStore } from '@memory/stores/directed_dispatches';
import type { AppEventBus } from '../app/events';
import type { UserRegistry } from './users';
import { local_dow, local_hhmm } from './time';
import {
  deliberation_pass,
  SLOT_TO_BRIEF_KIND,
  type DirectedTask,
  type TriggerContext,
} from './deliberation';
import { raise_interrupt as raise_interrupt_via } from './interrupts';
import type { ToolRegistry } from './tool_registry';
import type { ToolContext } from './tool';
import type { LLMRouter } from './llm';

export type Severity = 'low' | 'medium' | 'medium-high' | 'high';
const SEVERITY_RANK: Record<Severity, number> = {
  low: 1,
  medium: 2,
  'medium-high': 3,
  high: 4,
};

function severity_max(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

export interface AwarenessObservation {
  ts: string;
  summary: string;
  severity: Severity;
  /** Structured evidence backing the observation (kept as `details` for 6a compat). */
  details: Record<string, unknown>;
  /** Legacy escape hatch: if set, fire_interrupt immediately. */
  interrupt?: { reason: string };
  /** 6c: handler suggests this observation should be routed to another specialist's inbox. */
  suggests_inbox_to?: string;
  /** 6c: handler suggests this observation warrants an interrupt (not just a flag). */
  suggests_interrupt?: boolean;
  /**
   * Force the interrupt's triage route (2026-07-26). Set `'kate'` when the
   * observation is a raw SUBSYSTEM detection rather than a considered
   * judgment — a monitor running inside Kate's own awareness tick, say. Without
   * it the default rule ("Kate originated → straight to the user") would push
   * an unfiltered detection to the owner's phone. See `route_override` in
   * core/interrupts.ts.
   */
  interrupt_route?: 'user' | 'kate';
  /**
   * Urgent escalation to Kate (Chief of Staff). Specialists set this
   * when their cheap awareness check sees something that shouldn't
   * wait for their next scheduled deliberation — e.g. Anya seeing a
   * clinical signal mid-day, Iris seeing a charging session fail
   * silently overnight. Kate decides what to do with it (wake the
   * originator, alert Jasper, defer, drop) instead of the specialist
   * firing their own off-schedule turn. Keeps the escalation DAG a
   * star with Kate at the center; no cascading specialist-fires-
   * specialist loops.
   *
   * The LoopDriver pushes a `flag` inbox row to Kate (debounced by
   * `dedupe_key` per `escalation_debounce_ms`) and fires Kate's
   * deliberation off-schedule (debounced by Kate's own cooldown).
   * Kate's deliberation prompt receives the slot label
   * `escalation:<originator>:<dedupe_key>` so the LLM understands
   * this is a triggered pass, not a scheduled one.
   */
  escalate_to_kate?: {
    /** Human-readable explanation, used as the inbox body. */
    reason: string;
    /**
     * Idempotency key — same key from the same originator within the
     * debounce window won't re-fire. Use something stable like
     * `bailey-hct-low` or `ioniq5-charge-failed-overnight`, not
     * a timestamp.
     */
    dedupe_key: string;
    /** Optional one-liner the specialist thinks Kate should consider. */
    suggested_action?: string;
    /**
     * The actual interrupt row IDs behind this escalation, when it's about
     * pending interrupts. Surfaced verbatim in Kate's flag body so she can
     * call absorb_interrupt / promote_interrupt on REAL ids — without these
     * she escalated "N pending interrupt(s)" with no ids and looped guessing.
     */
    interrupt_ids?: string[];
    /**
     * What to call the ORIGIN of this escalation in Kate's inbox body
     * (2026-07-26). Kate reads the flag body and relays it to the owner in
     * her own voice — so whatever names the origin here is what the owner
     * hears. Name the SUBSYSTEM ("the away-from-home camera monitor"), never
     * a persona: a folded specialist's name leaking through this field is
     * exactly how "Cassandra flagged a visitor at the front door" reached the
     * owner months after the security fold made the perimeter Kate's.
     *
     * Omit for a real, owner-known peer (Vivian, Cordelia) — the default
     * resolves to their id, which Kate may legitimately attribute. Folded
     * (`subagent_only`) originators are collapsed to a neutral label even
     * when this is unset; see `origin_label_for`.
     */
    source_label?: string;
  };
  /**
   * Reactive-trigger PROBE path (2026-06-18): the awareness handler detected a
   * domain condition that has NO push event (a refill date crossing its window,
   * a market level crossing a threshold) and edged true THIS tick. Wakes the
   * SAME specialist's deliberation off-schedule via `wake_deliberation_scoped`
   * — the probe-path twin of the push-driven `triggers` subscriptions. The
   * cheap awareness tick is the edge detector; the expensive deliberation fires
   * only on the edge. The handler must edge-detect itself (emit `wake_self`
   * only on false→true); `wake_deliberation_scoped`'s debounce + per-key
   * min-interval are the backstop.
   */
  wake_self?: {
    /** Scoped framing for the woken pass — what to focus on. */
    task: string;
    /** Stable idempotency key (e.g. `refill-bailey-apoquel`); never a timestamp. */
    dedupe_key: string;
    /** Optional human-readable reason; defaults to the observation summary. */
    reason?: string;
  };
}

export interface AwarenessHandlerDeps {
  specialist_id: string;
  config: LoadedSpecialist;
  db: Database;
  memory: MemoryClient;
  specialists: SpecialistRegistry;
  last_run_at: Date | null;
  state_buffer: AwarenessObservation[];
  /**
   * Per-user identity store (config/users.yaml). Threaded through so
   * handlers that key off per-user state (Astrid's recovery-snack
   * threshold per `users.<id>.training.recovery_snack_threshold_kcal`)
   * can resolve without reaching for module-level singletons. Optional
   * for legacy boots and self-contained smokes.
   */
  users?: UserRegistry;
  /**
   * LLM router — threaded so a handler that needs inference (Cassandra's
   * away-from-home camera monitor runs the vision role on a Protect
   * snapshot) can resolve a role without a module singleton. Optional;
   * absent in self-contained smokes, where the vision-dependent path
   * no-ops.
   */
  llm?: LLMRouter;
  /**
   * Proposals store — threaded so an awareness pass can file a card the
   * owner decides (Cassandra's face-candidate sweep files `face_enrollment`
   * asks). Optional; absent in self-contained smokes, where proposal-filing
   * paths no-op.
   */
  proposals?: ProposalsStore;
  /**
   * Conversation store + event bus — threaded so an awareness pass can land
   * a proactive specialist message in a user's chat thread (Cassandra's
   * visitor ask-back delivers Kate's "who was that?" in chat, not a card).
   * Optional; absent, chat-delivering paths no-op.
   */
  conversations?: ConversationStore;
  events?: AppEventBus;
}

export interface AwarenessHandler {
  specialist_id: string;
  run(deps: AwarenessHandlerDeps): Promise<AwarenessObservation | null>;
}

export { severity_max };

export interface LoopDriverDeps {
  db: Database;
  memory: MemoryClient;
  specialists: SpecialistRegistry;
  runtime: SpecialistRuntime;
  proposals: ProposalsStore;
  interrupts: InterruptStore;
  inbox: SpecialistInbox;
  /**
   * Tool registry for firing per-specialist background jobs declared
   * in YAML (`proactive.background_jobs`). Optional so existing call
   * sites that don't wire it remain working — the only consequence is
   * background jobs silently no-op.
   */
  tools?: ToolRegistry;
  /** Required when `tools` is set; provides the LLMRouter for ToolContext. */
  llm?: LLMRouter;
  /**
   * The process-miss ledger. Optional so call sites that predate the
   * miss-drive still compile; when set, it is threaded into every
   * deliberation pass so a miss-driving specialist (Mariah) can review
   * and advance her open misses autonomously.
   */
  process_misses?: ProcessMissStore;
  events?: AppEventBus;
  /**
   * Per-user identity store, threaded through to deliberation so the
   * brief context puller can resolve per-user home coords (each
   * household member's weather reads from THEIR home in
   * config/users.yaml). Optional for legacy boots.
   */
  users?: UserRegistry;
  /**
   * Conversation store, threaded into awareness handlers so a sweep can
   * deliver a proactive specialist chat message (the visitor ask-back).
   * Optional for legacy boots and self-contained smokes.
   */
  conversations?: ConversationStore;
  /**
   * Durable journal for DIRECTED deliberations (2026-08-10). A directed build
   * is fire-and-forget in-process while every upstream record is already
   * terminal, so a restart mid-build used to lose the work invisibly. When
   * wired, `fire_deliberation_now` journals each directed task before running
   * it and stamps the outcome when it settles; boot reconciliation in
   * server.ts re-fires unfinished rows. Optional so self-contained smokes
   * that construct a LoopDriver without it still compile — the orchestrator
   * boot MUST wire it (the whole point is surviving ITS restarts).
   */
  dispatch_journal?: DirectedDispatchStore;
}

interface AwarenessBuffer {
  observations: AwarenessObservation[];
  last_flushed: number;
}

const BUFFER_MAX = 50;
const BUFFER_FLUSH_MS = 5 * 60 * 1000;
// Wake-on-flag debounce: collapse a burst of inbox flags into one
// deliberation pass. The timer resets on each new flag so the wake
// runs ~30s after the LAST flag arrives, ensuring the latest is
// included in the unread queue when deliberation reads it.
const WAKE_DEBOUNCE_MS = 30_000;
// Scoped reactive-trigger wakes (wake_deliberation_scoped). The same
// (specialist, dedupe_key) edge can't re-fire a deliberation inside this
// window — the backstop that keeps a still-true condition or a rapid
// re-edge from thrashing the deep tier. Per-subscription overridable via
// the YAML `min_interval_ms`.
const SCOPED_WAKE_MIN_INTERVAL_MS = 15 * 60 * 1000;

// Backstop so a slow/hung deliberation pass can't sit on the per-specialist
// chain forever and STARVE the passes queued behind it. The chain (deliberate)
// SERIALIZES passes on purpose — the inbox read+mark_actioned race it prevents
// is real — but a non-resolving owner pass (chained first) was jamming the
// whole queue, which is how Sam's per-user brief sat stuck for 9 days while
// Jasper's ran. After this timeout the chain ADVANCES so the next per-user brief
// runs; the timed-out pass keeps running in the background and logs its own
// outcome. Directed builds (Beatrice authoring on the strong model) legitimately
// run minutes and are exempt. Tunable via env.
const DELIBERATION_PASS_TIMEOUT_MS = Number(
  process.env.HEARTH_DELIBERATION_TIMEOUT_MS ?? 300_000,
);

export class LoopDriver {
  private awareness_handlers = new Map<string, AwarenessHandler>();
  private awareness_timers = new Map<string, ReturnType<typeof setInterval>>();
  private deliberation_tick: ReturnType<typeof setInterval> | null = null;
  private last_minute_fired = new Map<string, string>(); // sid → 'HH:MM' last fired
  // Per-(sid, job.name) — track the last 'HH:MM' when we ran this job,
  // so wildcard specs (e.g. "*:15") don't re-fire repeatedly inside the
  // same minute window.
  private last_bg_fired = new Map<string, string>();
  private buffers = new Map<string, AwarenessBuffer>();
  private last_awareness_run = new Map<string, Date>();

  // Escalation bookkeeping. Keyed `${originator_id}:${dedupe_key}` →
  // last-fired epoch_ms. Prevents the same specialist re-flagging the
  // same logical condition more often than ESCALATION_DEBOUNCE_MS.
  private last_escalations = new Map<string, number>();
  private static readonly ESCALATION_DEBOUNCE_MS = 15 * 60 * 1000;
  // wake_deliberation: collapse a burst of inbox flags into one
  // deliberation pass. Pending timer per-specialist; reset on each
  // new flag, so the wake fires WAKE_DEBOUNCE_MS after the LAST flag.
  private wake_timers = new Map<string, ReturnType<typeof setTimeout>>();
  // wake_deliberation_scoped (reactive triggers): pending debounce timers
  // and last-fired epochs, both keyed `${specialist_id}:${dedupe_key}` so a
  // burst of the same edge collapses to one pass and a re-fire inside the
  // per-key min-interval is dropped.
  private scoped_wake_timers = new Map<string, ReturnType<typeof setTimeout>>();
  private last_scoped_fire = new Map<string, number>();

  // Per-specialist deliberation chain. A specialist never runs two
  // deliberation passes at once: an escalation-triggered off-schedule
  // pass and a scheduled pass would otherwise race — both call
  // inbox.unactioned_for then mark_actioned, double-consuming (or
  // orphaning) the same flags. `deliberate` chains each pass after the
  // prior one for that specialist.
  private deliberation_chains = new Map<string, Promise<void>>();

  // Kate's off-schedule deliberation throttle. Even if many
  // escalations arrive in a burst, Kate's deliberation fires at most
  // once per KATE_OFF_SCHEDULE_DEBOUNCE_MS — she reads ALL the unread
  // inbox flags in that single pass, no need to fire per escalation.
  private kate_deliberation_in_flight = false;
  private last_kate_off_schedule_at = 0;
  private static readonly KATE_OFF_SCHEDULE_DEBOUNCE_MS = 5 * 60 * 1000;

  constructor(private deps: LoopDriverDeps) {}

  register_awareness(handler: AwarenessHandler): void {
    this.awareness_handlers.set(handler.specialist_id, handler);
  }

  /** Test-only: invoke a specialist's awareness handler once, synchronously. */
  async fire_awareness_now(specialist_id: string): Promise<AwarenessObservation | null> {
    const handler = this.awareness_handlers.get(specialist_id);
    const specialist = this.deps.specialists.get(specialist_id);
    if (!handler || !specialist) return null;
    return this.tick_awareness(specialist, handler);
  }

  /**
   * Invoke a specialist's deliberation pass synchronously, off-schedule.
   * `directed_task`, when passed, makes the pass execute that one directive on
   * the strong model (owner-directed build) instead of the standing work — see
   * DirectedTask. Without it this is the plain off-schedule fire.
   */
  async fire_deliberation_now(
    specialist_id: string,
    slot = '00:00',
    directed_task?: DirectedTask,
    /** Run the pass FOR a specific user (Kate's per-user brief) — the same
     *  per-user fan-out the scheduled slot does, but on demand. Owner-gated at
     *  the route. Omit for a household-level / owner-fallback pass. */
    user_id?: string,
    /** Journal attribution for a DIRECTED fire: which door dispatched it
     *  ('decide' | 'court' | 'scrum' | 'fire_deliberation') and, when the
     *  dispatch executes an approved proposal, which one. `journal_id` is
     *  reconciliation-only — a boot re-fire adopts the existing row instead
     *  of opening a second one. Ignored for non-directed passes. */
    dispatch?: { source?: string; proposal_id?: string; journal_id?: string },
  ): Promise<void> {
    const specialist = this.deps.specialists.get(specialist_id);
    if (!specialist) return;

    // Directed work is journaled BEFORE it runs (2026-08-10). Fire-and-forget
    // callers + terminal upstream records (acknowledged proposal, "do NOT
    // re-file" FYI) mean this row is the ONLY thing that lets a restart-killed
    // build be re-fired instead of lost invisibly. The row is stamped when the
    // pass settles; a process death in between leaves finished_at NULL — the
    // exact signature boot reconciliation looks for.
    const journal = directed_task ? this.deps.dispatch_journal : undefined;
    const journal_id = journal
      ? (dispatch?.journal_id ??
        journal.open({
          source: dispatch?.source ?? 'direct',
          specialist_id,
          slot,
          task: directed_task!,
          ...(dispatch?.proposal_id ? { proposal_id: dispatch.proposal_id } : {}),
          ...(user_id ? { user_id } : {}),
        }))
      : undefined;

    try {
      await this.deliberate(specialist, slot, user_id, directed_task);
      if (journal && journal_id) journal.finish(journal_id, true);
    } catch (err) {
      const err_text = err instanceof Error ? err.message : String(err);
      if (journal && journal_id) {
        journal.finish(journal_id, false, err_text);
      }
      // Loud directed failures (2026-08-11): a directed pass that THREW is a
      // failed build, and its upstream records are already terminal — without
      // this, the journal row was the only trace and Mariah's ledger never
      // saw it. Same evidence key family as the runtime's in-pass failure
      // shapes (blank turn / ceiling / dup cut), so however the build died,
      // its failures fold onto one per-directive ledger row. Fail-open.
      if (directed_task && this.deps.process_misses) {
        try {
          const preview = directed_task.instruction.slice(0, 240);
          const directive_key = createHash('sha256').update(preview).digest('hex').slice(0, 12);
          this.deps.process_misses.create({
            subject_specialist_id: specialist_id,
            reporter: 'orchestrator',
            task_summary: `Directed build pass: "${preview.slice(0, 200)}"`,
            gap:
              `directed-build-failure (pass_error): the pass threw instead of ` +
              `completing — ${err_text.slice(0, 400)}` +
              (dispatch?.proposal_id ? ` (proposal ${dispatch.proposal_id}, via ${dispatch.source ?? 'direct'})` : '') +
              `. The upstream proposal is already terminal, so nothing re-files ` +
              `this work by itself — re-dispatch it deliberately once the error ` +
              `is understood.`,
            severity: 'high',
            evidence_ref: `directed-build-fail:${specialist_id}:${directive_key}`,
          });
        } catch (miss_err) {
          console.error('[loops] failed to file directed-failure miss:', miss_err);
        }
      }
      throw err;
    }
  }

  /**
   * Wake a specialist's deliberation off-schedule, debounced.
   * Called by the orchestrator when an inbox flag arrives for a
   * specialist whose YAML has `proactive.wake_on_flag: true`.
   *
   * Debounce window collapses a burst of flags into one wake — if a
   * peer fires three flags in 10 seconds (say, Cassandra + Vivian +
   * Eleanor all hit Beatrice at the same moment), only one
   * deliberation pass runs, and it sees all three unread in its
   * context.
   *
   * The actual deliberation fires after the debounce window settles
   * so the last-in flag is included. Slot is labeled 'wake' so the
   * deliberation prompt knows this is an off-schedule fire.
   */
  wake_deliberation(specialist_id: string, reason: string): void {
    const specialist = this.deps.specialists.get(specialist_id);
    if (!specialist) return;
    if (!specialist.proactive.wake_on_flag) return;
    const existing = this.wake_timers.get(specialist_id);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.wake_timers.delete(specialist_id);
      console.log(`[loops] wake_deliberation firing for ${specialist_id} (${reason})`);
      void this.deliberate(specialist, 'wake').catch((err) => {
        console.error(`[loops] wake_deliberation failed for ${specialist_id}:`, err);
      });
    }, WAKE_DEBOUNCE_MS);
    this.wake_timers.set(specialist_id, t);
  }

  /**
   * Wake a specialist's deliberation off-schedule with a SCOPED task — the
   * event-driven counterpart of `wake_deliberation` (which is inbox-flag-driven
   * and task-less). Called by the ReactiveTriggerDriver (push events off the
   * AppEventBus) and by `tick_awareness` when a handler emits `wake_self`
   * (probed conditions). Generalizes the existing wake machinery; `wake_on_flag`
   * is unaffected.
   *
   * Three guards keep "live" from becoming "noisy / expensive":
   *  - DEBOUNCE per (specialist, dedupe_key): a burst of the same edge collapses
   *    to one pass (the timer resets on each call, firing after the last settles).
   *  - per-(specialist, key) MIN-INTERVAL: a re-fire inside the window is dropped,
   *    so a condition that stays true — or re-edges quickly — can't thrash.
   *  - the pass routes through `deliberate()` → the per-specialist serialization
   *    chain + the deep tier (`specialist_deliberation` role), NEVER the
   *    interactive tier. So a flood of triggers can't starve chat/voice.
   *
   * The CALLER must only invoke on a real false→true edge; the min-interval map
   * is the backstop. The pass runs at slot `trigger:<dedupe_key>` so the
   * deliberation prompt (and the HEARTH_TEST_MODE fixture) can frame it; the
   * `task` + `reason` ride into the prompt as TriggerContext. Surfacing still
   * flows through the normal proposal/interrupt → push quiet-hours gate, so a
   * pass that finds nothing pushes nothing — live ≠ noisy.
   */
  wake_deliberation_scoped(
    specialist_id: string,
    opts: {
      task: string;
      reason: string;
      dedupe_key: string;
      debounce_ms?: number;
      min_interval_ms?: number;
      /** Per-wake thinking override (S4 scrutiny) — set true for heavy-
       *  scrutiny wakes (Case Driver diagnostics/verification). Omitted →
       *  the standing think resolution applies (see deliberation.ts). */
      think?: boolean;
    },
  ): void {
    const specialist = this.deps.specialists.get(specialist_id);
    if (!specialist) return;
    const key = `${specialist_id}:${opts.dedupe_key}`;
    const min_interval = opts.min_interval_ms ?? SCOPED_WAKE_MIN_INTERVAL_MS;
    const since = Date.now() - (this.last_scoped_fire.get(key) ?? 0);
    if (since < min_interval) {
      // Rate-limited: this scoped edge fired too recently. Drop it (the
      // condition staying true must not re-spend a deep-tier pass).
      return;
    }
    const debounce = opts.debounce_ms ?? WAKE_DEBOUNCE_MS;
    const slot = `trigger:${opts.dedupe_key}`;
    const trigger_context: TriggerContext = {
      reason: opts.reason,
      task: opts.task,
      ...(typeof opts.think === 'boolean' ? { think: opts.think } : {}),
    };
    const existing = this.scoped_wake_timers.get(key);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.scoped_wake_timers.delete(key);
      this.last_scoped_fire.set(key, Date.now());
      console.log(
        `[loops] wake_deliberation_scoped firing for ${specialist_id} (${opts.dedupe_key})`,
      );
      // Self-evidencing audit: every scoped wake (reactive trigger or wake_self
      // probe) records a row, so "did a trigger fire?" is one query
      // (`tool_name='reactive_trigger_fired'`) instead of log-archaeology +
      // cross-referencing the deliberation slot. Best-effort — never let an
      // audit failure (or a stub-deps test) block the wake.
      try {
        this.deps.memory.log_action({
          intent_id: ulid(),
          agent: specialist_id,
          tool_name: 'reactive_trigger_fired',
          tool_input: { dedupe_key: opts.dedupe_key, slot },
          execution_result: { reason: opts.reason, task: opts.task },
        });
      } catch {
        /* audit is best-effort */
      }
      void this.deliberate(specialist, slot, undefined, undefined, trigger_context).catch(
        (err) => {
          console.error(
            `[loops] wake_deliberation_scoped failed for ${specialist_id}:`,
            err,
          );
        },
      );
    }, debounce);
    this.scoped_wake_timers.set(key, t);
  }

  /** Most recent observations for a specialist (used by deliberation prompts). */
  recent_observations(specialist_id: string, limit = 20): AwarenessObservation[] {
    const buf = this.buffers.get(specialist_id);
    if (!buf) return [];
    return buf.observations.slice(-limit);
  }

  start(): void {
    this.start_awareness();
    this.start_deliberation();
  }

  stop(): void {
    for (const t of this.awareness_timers.values()) clearInterval(t);
    this.awareness_timers.clear();
    if (this.deliberation_tick) {
      clearInterval(this.deliberation_tick);
      this.deliberation_tick = null;
    }
    // Pending wake-on-flag timers keep the event loop alive — clear them
    // so stop() fully releases the driver's handles.
    for (const t of this.wake_timers.values()) clearTimeout(t);
    this.wake_timers.clear();
    for (const t of this.scoped_wake_timers.values()) clearTimeout(t);
    this.scoped_wake_timers.clear();
  }

  private start_awareness(): void {
    for (const s of this.deps.specialists.list()) {
      if (s.proactive.mode !== 'active') continue;
      const hz = s.proactive.awareness_hz ?? 1 / 60; // default 1 per minute
      const interval_ms = Math.max(5_000, Math.round(1_000 / hz));
      const handler = this.awareness_handlers.get(s.id);
      if (!handler) {
        console.log(`[loops] no awareness handler for ${s.id}; skipping awareness loop`);
        continue;
      }
      const timer = setInterval(() => {
        void this.tick_awareness(s, handler);
      }, interval_ms);
      this.awareness_timers.set(s.id, timer);
      console.log(`[loops] awareness loop for ${s.id} every ${Math.round(interval_ms / 1000)}s`);
    }
  }

  private async tick_awareness(
    specialist: LoadedSpecialist,
    handler: AwarenessHandler,
  ): Promise<AwarenessObservation | null> {
    try {
      const buf = this.get_buffer(specialist.id);
      const last_run = this.last_awareness_run.get(specialist.id) ?? null;
      this.last_awareness_run.set(specialist.id, new Date());

      // Location data is pushed by Hearth iOS (signal=location), not
      // polled — the awareness tick used to refresh the HA-backed
      // cache here, but with the iOS CoreLocation source the cache
      // is read-through on demand. No tick-driven refresh needed.

      const obs = await handler.run({
        specialist_id: specialist.id,
        config: specialist,
        db: this.deps.db,
        memory: this.deps.memory,
        specialists: this.deps.specialists,
        last_run_at: last_run,
        state_buffer: buf.observations.slice(),
        users: this.deps.users,
        llm: this.deps.llm,
        proposals: this.deps.proposals,
        conversations: this.deps.conversations,
        events: this.deps.events,
      });
      if (!obs) return null;

      buf.observations.push(obs);
      if (buf.observations.length > BUFFER_MAX) {
        buf.observations.splice(0, buf.observations.length - BUFFER_MAX);
      }

      // Audit every observation (cheap, but the trail matters for calibration).
      this.deps.memory.log_action({
        intent_id: ulid(),
        agent: specialist.id,
        tool_name: 'awareness_observation',
        tool_input: { specialist_id: specialist.id, severity: obs.severity },
        execution_result: { summary: obs.summary, details: obs.details },
      });

      // Periodic flush to specialist's memory.md (light touch).
      const now = Date.now();
      if (now - buf.last_flushed > BUFFER_FLUSH_MS) {
        this.flush_buffer(specialist, buf);
        buf.last_flushed = now;
      }

      // 6c: signaling paths from the observation itself.
      if (obs.suggests_inbox_to) {
        const kind = obs.severity === 'medium-high' || obs.severity === 'high' ? 'flag' : 'fyi';
        const inbox_id = this.deps.inbox.push({
          from_specialist_id: specialist.id,
          to_specialist_id: obs.suggests_inbox_to,
          kind,
          body_md: obs.summary,
        });
        this.deps.events?.emit({
          type: 'inbox_message_added',
          message_id: inbox_id,
          from_specialist_id: specialist.id,
          to_specialist_id: obs.suggests_inbox_to,
          kind,
          severity: obs.severity,
        });
        // The recipient (usually Kate) gets a brief status pulse.
        this.emit_status(obs.suggests_inbox_to, `noting flag from ${specialist.name}`, 10);
      }

      if (obs.suggests_interrupt || obs.interrupt) {
        const reason = obs.interrupt?.reason ?? obs.summary;
        await this.fire_interrupt(
          specialist,
          obs.severity,
          reason,
          obs.summary,
          obs.interrupt_route,
        );
      }

      // Urgent escalation to Kate. Specialists set this when their
      // cheap awareness pass finds something that shouldn't wait for
      // their next scheduled deliberation. Kate handles triage.
      if (obs.escalate_to_kate) {
        await this.handle_escalation(specialist, obs);
      }

      // Reactive-trigger PROBE path: the handler detected a no-push domain
      // condition that edged true this tick and asked to wake its OWN
      // deliberation, scoped to the task (the probe-path twin of the
      // event-bus `triggers` subscriptions). Debounce + per-key min-interval
      // live in wake_deliberation_scoped.
      if (obs.wake_self) {
        this.wake_deliberation_scoped(specialist.id, {
          task: obs.wake_self.task,
          reason: obs.wake_self.reason ?? obs.summary,
          dedupe_key: obs.wake_self.dedupe_key,
        });
      }

      return obs;
    } catch (err) {
      console.error(`[loops] awareness error for ${specialist.id}:`, err);
      return null;
    }
  }

  private emit_status(specialist_id: string, status: string | null, ttl_seconds = 60): void {
    this.deps.events?.emit({
      type: 'specialist_status',
      specialist_id,
      status,
      ttl_seconds,
    });
  }

  private get_buffer(sid: string): AwarenessBuffer {
    let buf = this.buffers.get(sid);
    if (!buf) {
      buf = { observations: [], last_flushed: Date.now() };
      this.buffers.set(sid, buf);
    }
    return buf;
  }

  private flush_buffer(specialist: LoadedSpecialist, buf: AwarenessBuffer): void {
    if (buf.observations.length === 0) return;
    // Light touch: only the most recent observation gets flushed. Detailed
    // accumulation belongs to the deliberation pass.
    const last = buf.observations[buf.observations.length - 1]!;
    const note_rel = `Knowledge/${capitalize(specialist.id)}/memory.md`;
    const line = `- **${last.ts}** _(awareness, ${last.severity})_ ${last.summary}`;
    try {
      this.deps.memory.append_to_note(note_rel, line);
    } catch (err) {
      console.error(`[loops] flush buffer for ${specialist.id}:`, err);
    }
  }

  private start_deliberation(): void {
    // Tick every 60s; if any specialist's deliberation_at HH:MM matches
    // the current minute and we haven't fired for them this minute, fire.
    this.deliberation_tick = setInterval(() => {
      void this.tick_deliberation();
    }, 60_000);
    console.log(`[loops] deliberation tick every 60s (in-process scheduler)`);
  }

  private async tick_deliberation(): Promise<void> {
    // Slot strings in specialist YAML (`07:00`, `12:30`) are wall-clock
    // in the user's local zone. Reading `now.getHours()` would pick up
    // the *host* clock — fine when the orchestrator is `TZ=America/Denver`
    // but silently 6h off in a UTC container.
    const now = new Date();
    const slot = local_hhmm(now);
    // Same local wall clock as the slot match — a deliberation_dow gate
    // read off the host clock would disagree with `slot` across the
    // local-midnight boundary in a UTC container.
    const today_dow = local_dow(now);
    for (const s of this.deps.specialists.list()) {
      const slots = s.proactive.deliberation_at ?? [];
      const dow_gate = s.proactive.deliberation_dow;
      if (dow_gate && !dow_gate.includes(today_dow)) continue;
      if (slots.includes(slot) && this.last_minute_fired.get(s.id) !== slot) {
        this.last_minute_fired.set(s.id, slot);
        // Per-user fan-out for Kate's brief slots — every household
        // member whose `allowed_specialists` includes Kate gets their
        // own brief generated against their own sensors / calendar /
        // location / weather. Non-brief deliberations (Mariah scanning
        // misses, Cassandra security sweeps, etc.) stay household-
        // level: a single call with no user_id, fallback to env owner
        // inside deliberation_pass.
        const is_kate_brief_slot = s.id === 'kate' && slot in SLOT_TO_BRIEF_KIND;
        const brief_user_ids = is_kate_brief_slot
          ? this.brief_user_ids_for(s.id)
          : [undefined];
        if (is_kate_brief_slot) {
          // Observability: which household members are getting a brief THIS
          // slot. Makes "is Sam being attempted?" answerable from the logs.
          console.log(
            `[loops] kate brief slot ${slot} → users: ${brief_user_ids
              .map((u) => u ?? '(owner-fallback)')
              .join(', ')}`,
          );
        }
        for (const uid of brief_user_ids) {
          try {
            await this.deliberate(s, slot, uid);
          } catch (err) {
            console.error(
              `[loops] deliberation error for ${s.id} at ${slot}` +
                (uid ? ` (user=${uid})` : '') + ':',
              err,
            );
          }
        }
      }
      // Per-specialist background jobs (Pass 7.5+) — declared in YAML
      // as { name, at: "HH:MM" or "*:MM" or "HH:*", tool, input? }.
      // Fired through the tool registry so they audit natively.
      await this.tick_background_jobs(s, now, slot);
    }
  }

  /**
   * Household members eligible for a brief from this specialist —
   * everyone whose `allowed_specialists` permits them to interact
   * with that specialist AND (for non-owners) whose iOS app has
   * actually posted device data to ground the brief on. Returns a
   * non-empty array; falls back to `[env owner]` when the users
   * registry isn't wired (test mode, pre-Phase-2 startup) or when no
   * one qualifies. Iteration order matches `users.list()` (YAML
   * order), so brief generation is deterministic.
   *
   * Device-active gate (2026-06-07): a NON-OWNER gets a brief only once
   * their iOS app has posted a calendar snapshot or a location packet —
   * otherwise the brief is contentless (nothing to ground "their day").
   * The owner is always included: their brief carries household/system
   * context independent of device data, and the admin must never go
   * dark. As the household grows, the iOS app is the per-user signal
   * source, so "has the app sent anything yet" is the right enrollment
   * test.
   */
  private brief_user_ids_for(specialist_id: string): string[] {
    const users = this.deps.users;
    if (!users) {
      return [process.env.HEARTH_OWNER_USER_ID ?? 'jasper'];
    }
    const selected = users
      .list()
      .filter((u) => {
        const allowed = u.allowed_specialists;
        const permitted = allowed === '*' || allowed.includes(specialist_id);
        if (!permitted) return false;
        // Owner always; non-owners only once their device is reporting.
        return u.tier === 'owner' || this._user_is_device_active(u.id);
      })
      .map((u) => u.id);
    if (selected.length === 0) {
      return [process.env.HEARTH_OWNER_USER_ID ?? 'jasper'];
    }
    return selected;
  }

  /**
   * True when the user's iOS app has posted device data a brief can be
   * grounded on — a calendar snapshot or at least one location packet.
   * Fail-OPEN: any read error counts as active, so a transient DB hiccup
   * never silently drops a real user's brief (the owner is included
   * regardless, so the worst case is one occasionally-thin guest brief).
   */
  private _user_is_device_active(user_id: string): boolean {
    try {
      if (this.deps.memory.query_calendar_snapshot(user_id)) return true;
      if (this.deps.memory.query_latest_location_packet(user_id)) return true;
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Does a ClockSpec like "03:00" / "*:15" / "*:*" match the current
   * HH and MM (zero-padded strings)?
   */
  private _clock_matches(spec: string, hh: string, mm: string): boolean {
    const m = /^(\*|\d{1,2}):(\*|\d{1,2})$/.exec(spec);
    if (!m) return false;
    const [, h, mi] = m as unknown as [string, string, string];
    if (h !== '*' && h.padStart(2, '0') !== hh) return false;
    if (mi !== '*' && mi.padStart(2, '0') !== mm) return false;
    return true;
  }

  private async tick_background_jobs(
    specialist: LoadedSpecialist,
    now: Date,
    slot: string,
  ): Promise<void> {
    const jobs = specialist.proactive.background_jobs ?? [];
    if (jobs.length === 0) return;
    if (!this.deps.tools || !this.deps.llm) return;
    const hh = String(now.getHours()).padStart(2, '0'); // time-guard-ok: host-clock background-job slot — correct under TZ=America/Denver container (see dow comment below); candidate to align with local_hhmm at line 442
    const mm = String(now.getMinutes()).padStart(2, '0'); // time-guard-ok: host-clock background-job slot (see above)
    // Weekday index off the SAME host clock as hh/mm above, so a `dow` gate
    // and the `at` match can't disagree about which day it is at the firing
    // minute (mixing a local-zone weekday with a host-clock hour would split
    // across midnight in a UTC container).
    const today_dow = (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const)[now.getDay()] ?? 'sun';
    for (const job of jobs) {
      if (!this._clock_matches(job.at, hh, mm)) continue;
      if (job.dow && !job.dow.includes(today_dow)) continue;
      // Day-of-month ceiling — off the SAME host clock as hh/mm/dow above (so a
      // "first Monday" gate can't disagree about which day it is at the firing
      // minute). dow:["mon"] + dom_max:7 = the first Monday of the month.
      if (job.dom_max && now.getDate() > job.dom_max) continue; // time-guard-ok: host-clock day-of-month (TZ=America/Denver container; matches the hh/mm slot rationale above)
      const key = `${specialist.id}:${job.name}`;
      if (this.last_bg_fired.get(key) === slot) continue;
      this.last_bg_fired.set(key, slot);
      const intent_id = ulid();
      this.emit_status(specialist.id, `running ${job.name}`, 120);
      const ctx: ToolContext = {
        memory: this.deps.memory,
        llm: this.deps.llm,
        now: new Date(),
        intent_id,
      };
      try {
        const outcome = await this.deps.tools.invoke(
          job.tool,
          job.input ?? {},
          ctx,
          specialist.granted,
          specialist.id,
        );
        this.deps.memory.log_action({
          intent_id,
          agent: specialist.id,
          tool_name: 'background_job',
          tool_input: { name: job.name, at: job.at, tool: job.tool, slot },
          execution_result: outcome.ok
            ? { ok: true, tool: job.tool, result: outcome.result }
            : undefined,
          error: outcome.ok ? undefined : `${outcome.reason}: ${outcome.error}`,
        });
        if (!outcome.ok) {
          console.error(
            `[loops] background_job ${specialist.id}/${job.name} failed (${outcome.reason}): ${outcome.error}`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[loops] background_job ${specialist.id}/${job.name} crashed:`, msg);
        this.deps.memory.log_action({
          intent_id,
          agent: specialist.id,
          tool_name: 'background_job',
          tool_input: { name: job.name, at: job.at, tool: job.tool, slot },
          error: msg,
        });
      } finally {
        this.emit_status(specialist.id, null, 1);
      }
    }
  }

  /**
   * Synchronously run a single named background job for a specialist —
   * off-schedule, on demand. Used by tests AND by the operator route
   * (`POST /api/specialists/:id/fire_background_job`) so the morning sweeps
   * can be kicked manually (e.g. a first-run populate) without waiting for the
   * clock. Returns the tool outcome (or null when the specialist / job /
   * runtime deps are missing) so the caller can report per-job results. The
   * invoked tool logs its own audit action, same as the scheduled path.
   */
  async fire_background_job_now(
    specialist_id: string,
    job_name: string,
  ): Promise<{ ok: boolean; result?: unknown; reason?: string; error?: string } | null> {
    const s = this.deps.specialists.get(specialist_id);
    if (!s) return null;
    const now = new Date();
    const job = (s.proactive.background_jobs ?? []).find((j) => j.name === job_name);
    if (!job) return null;
    if (!this.deps.tools || !this.deps.llm) return null;
    const ctx: ToolContext = {
      memory: this.deps.memory,
      llm: this.deps.llm,
      now,
      intent_id: ulid(),
    };
    return this.deps.tools.invoke(job.tool, job.input ?? {}, ctx, s.granted, s.id);
  }

  /**
   * Run one deliberation turn for a specialist. Serialized per specialist:
   * if a pass is already running (or queued) for this specialist, this one
   * waits its turn before starting. Two concurrent passes for the same
   * specialist would race on the inbox (each reads `unactioned_for` then
   * `mark_actioned`), so a scheduled pass and an escalation-triggered
   * off-schedule pass must not overlap.
   */
  async deliberate(
    specialist: LoadedSpecialist,
    slot: string,
    user_id?: string,
    directed_task?: DirectedTask,
    trigger_context?: TriggerContext,
  ): Promise<void> {
    // Directed builds get their OWN chain key. They run long on purpose and are
    // deliberately NOT time-boxed (see run_deliberation_guarded below), so
    // chaining them on the specialist's main key lets one multi-minute build
    // starve every scheduled pass queued behind it. That was harmless while
    // builds ran as 'trainer' (no brief slots); once builds run as the build
    // agent (Kate — 2026-07-21 Beatrice consolidation) it would block her brief
    // slots AND the per-user brief fan-out — the exact starvation the timeout
    // below exists to prevent. A separate key preserves build serialization (one
    // build at a time) without coupling builds to the specialist's own schedule.
    const chain_key = directed_task ? `${specialist.id}:build` : specialist.id;
    const prior = this.deliberation_chains.get(chain_key) ?? Promise.resolve();
    const run = prior.then(() =>
      this.run_deliberation_guarded(specialist, slot, user_id, directed_task, trigger_context),
    );
    // The chain handle swallows rejections so one failed pass doesn't
    // poison the queue; run_deliberation logs its own errors and the
    // direct caller still observes any rejection through `run`.
    this.deliberation_chains.set(
      chain_key,
      run.then(
        () => {},
        () => {},
      ),
    );
    return run;
  }

  /**
   * Time-boxed wrapper around `run_deliberation` so a single pass can't jam the
   * per-specialist chain and starve the passes queued behind it (the Sam
   * per-user-brief starvation). On timeout the chain ADVANCES — the next
   * per-user pass runs — while the slow pass keeps running in the background
   * (it logs its own outcome via run_deliberation's try/catch). Directed builds
   * run long on purpose and are NOT time-boxed.
   */
  private async run_deliberation_guarded(
    specialist: LoadedSpecialist,
    slot: string,
    user_id?: string,
    directed_task?: DirectedTask,
    trigger_context?: TriggerContext,
  ): Promise<void> {
    const pass = this.run_deliberation(specialist, slot, user_id, directed_task, trigger_context);
    if (directed_task) return pass;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.error(
          `[loops] deliberation pass for ${specialist.id}` +
            (user_id ? ` (user=${user_id})` : '') +
            ` exceeded ${DELIBERATION_PASS_TIMEOUT_MS}ms — advancing the chain so ` +
            `the next per-user brief isn't starved (the slow pass keeps running)`,
        );
        resolve();
      }, DELIBERATION_PASS_TIMEOUT_MS);
    });
    try {
      await Promise.race([pass, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    // If the real pass settles after we've already advanced, swallow any
    // rejection so it doesn't surface as an unhandled rejection.
    pass.catch(() => {});
  }

  /** Run one deliberation turn for a specialist. Delegated to `deliberation.ts`. */
  private async run_deliberation(
    specialist: LoadedSpecialist,
    slot: string,
    user_id?: string,
    directed_task?: DirectedTask,
    trigger_context?: TriggerContext,
  ): Promise<void> {
    this.emit_status(specialist.id, 'deliberating', 60);
    // Fire one awareness pass first so the deliberation has fresh observations
    // even for batched-mode specialists (whose continuous loop is off).
    const handler = this.awareness_handlers.get(specialist.id);
    if (handler) {
      await this.tick_awareness(specialist, handler);
    }
    try {
      await deliberation_pass({
        specialist,
        slot,
        observations: this.recent_observations(specialist.id),
        db: this.deps.db,
        memory: this.deps.memory,
        runtime: this.deps.runtime,
        proposals: this.deps.proposals,
        inbox: this.deps.inbox,
        interrupts: this.deps.interrupts,
        process_misses: this.deps.process_misses,
        events: this.deps.events,
        users: this.deps.users,
        ...(user_id ? { user_id } : {}),
        ...(directed_task ? { directed_task } : {}),
        ...(trigger_context ? { trigger_context } : {}),
        fire_interrupt: (sev, reason, summary) =>
          this.fire_interrupt(specialist, sev, reason, summary),
      });
    } catch (err) {
      console.error(`[loops] deliberation error for ${specialist.id}:`, err);
      this.emit_status(specialist.id, null, 1);
      // DIRECTED passes rethrow (2026-08-11): swallowing here stamped the
      // dispatch journal 'ok' for a pass that threw — fire_deliberation_now
      // never saw the failure, so the row read as a finished build and the
      // failure vanished. Scheduled/wake passes keep the swallow (their loop
      // must survive one bad pass; they have no journal to stamp).
      if (directed_task) throw err;
    }
  }

  /**
   * Record an interrupt and route it. Honors the specialist's
   * interrupt_threshold — signal must be >= threshold to proceed.
   * Delegates the heavy lifting to `interrupts.ts` (PART 4).
   */
  async fire_interrupt(
    originating: LoadedSpecialist,
    severity: Severity,
    reason: string,
    summary: string,
    route_override?: 'user' | 'kate',
  ): Promise<string | null> {
    return raise_interrupt_via({
      originating_specialist_id: originating.id,
      threshold: originating.proactive.interrupt_threshold ?? 'medium',
      ...(route_override ? { route_override } : {}),
      severity,
      summary,
      details_md: reason,
      memory: this.deps.memory,
      interrupts: this.deps.interrupts,
      inbox: this.deps.inbox,
      events: this.deps.events,
    });
  }

  /**
   * Handle a specialist's `escalate_to_kate` flag from their awareness
   * pass. Debounces by (originator, dedupe_key) so the same logical
   * condition doesn't spam Kate's inbox. On a non-duplicate, pushes a
   * `flag` inbox row to Kate and asks the LoopDriver to fire her
   * deliberation off-schedule (also debounced — bursts collapse to
   * a single triggered pass that reads every unread flag).
   *
   * Kate self-escalating (originator === 'kate') is supported and
   * routes the same way; her deliberation gets the same triggered slot
   * label so the LLM prompt can frame the pass correctly.
   */
  private async handle_escalation(
    originating: LoadedSpecialist,
    obs: AwarenessObservation,
  ): Promise<void> {
    const escalation = obs.escalate_to_kate;
    if (!escalation) return;
    const key = `${originating.id}:${escalation.dedupe_key}`;
    const now_ms = Date.now();
    const last = this.last_escalations.get(key) ?? 0;
    if (now_ms - last < LoopDriver.ESCALATION_DEBOUNCE_MS) {
      // Suppress duplicate — same originator, same condition,
      // already pinged Kate recently. The trail still shows up in
      // awareness_observation audit rows above.
      return;
    }
    this.last_escalations.set(key, now_ms);

    const body =
      `[ESCALATION from ${origin_label_for(originating, escalation.source_label)}] ${escalation.reason}` +
      (escalation.suggested_action
        ? `\n\nSuggested action: ${escalation.suggested_action}`
        : '') +
      (escalation.interrupt_ids?.length
        ? `\n\nInterrupt IDs (call absorb_interrupt / promote_interrupt on these): ${escalation.interrupt_ids.join(', ')}`
        : '') +
      `\n\nDedup key: \`${escalation.dedupe_key}\` · Severity: ${obs.severity}`;

    const inbox_id = this.deps.inbox.push({
      from_specialist_id: originating.id,
      to_specialist_id: 'kate',
      kind: 'flag',
      body_md: body,
    });
    this.deps.events?.emit({
      type: 'inbox_message_added',
      message_id: inbox_id,
      from_specialist_id: originating.id,
      to_specialist_id: 'kate',
      kind: 'flag',
      severity: obs.severity,
    });

    this.deps.memory.log_action({
      intent_id: ulid(),
      agent: originating.id,
      tool_name: 'escalation_to_kate',
      tool_input: {
        originator: originating.id,
        dedupe_key: escalation.dedupe_key,
        severity: obs.severity,
      },
      execution_result: {
        inbox_id,
        suggested_action: escalation.suggested_action ?? null,
      },
    });

    // Fire Kate's deliberation off-schedule (debounced). Don't await —
    // her deliberation can take a while; we don't want to block the
    // originator's awareness loop. Errors are logged inside.
    void this.maybe_fire_kate_off_schedule(originating.id, escalation.dedupe_key);
  }

  /**
   * Trigger Kate's deliberation outside her scheduled slots, debounced
   * so a burst of escalations collapses to one pass. The pass reads
   * every unread inbox flag, so single-fire-per-burst is correct.
   */
  private async maybe_fire_kate_off_schedule(
    originator_id: string,
    dedupe_key: string,
  ): Promise<void> {
    if (this.kate_deliberation_in_flight) return;
    const now_ms = Date.now();
    if (
      now_ms - this.last_kate_off_schedule_at <
      LoopDriver.KATE_OFF_SCHEDULE_DEBOUNCE_MS
    ) {
      return;
    }
    const kate = this.deps.specialists.get('kate');
    if (!kate) return;

    this.last_kate_off_schedule_at = now_ms;
    this.kate_deliberation_in_flight = true;
    try {
      // Slot label encodes the trigger so Kate's deliberation prompt
      // can frame the pass as a response to escalation rather than a
      // regular scheduled review. `deliberate()` already accepts an
      // arbitrary string here; downstream prompt assembly uses it as
      // context.
      const slot = `escalation:${originator_id}:${dedupe_key}`;
      await this.deliberate(kate, slot);
    } catch (err) {
      console.error('[loops] kate off-schedule deliberation failed:', err);
    } finally {
      this.kate_deliberation_in_flight = false;
    }
  }
}

export function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}

/**
 * What Kate's inbox should call the origin of an escalation (2026-07-26).
 *
 * Kate relays flag bodies to the owner in her own voice, so this string is
 * effectively owner-facing. Two rules:
 *
 *   1. An explicit `source_label` always wins — name the subsystem that
 *      actually detected the condition ("the away-from-home camera monitor").
 *   2. A `subagent_only` originator is INTERNAL by definition (it's hidden
 *      from every roster), so its id must never surface. It collapses to a
 *      neutral label rather than handing Kate a retired persona's name to
 *      attribute out loud.
 *
 * A real, owner-known peer keeps its id — "Vivian's flagging that bill forty
 * percent high" is correct attribution the owner can act on.
 */
export function origin_label_for(
  originating: { id: string; subagent_only?: boolean },
  source_label?: string,
): string {
  if (source_label) return source_label;
  return originating.subagent_only ? 'an internal subsystem' : originating.id;
}
