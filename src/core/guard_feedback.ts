/**
 * guard_feedback — instant feedback from a quality/honesty miss to the
 * meta-agents (2026-06-22).
 *
 * The finalize reply-guards (fabricated-save / ghost-promise / read-failure /
 * data-denial / provenance / citation / fact-critic) and the tool-arg path
 * (input-validation failure that survived central recovery, same-tool spiral)
 * already CATCH the miss in-turn and re-roll once. But the catch only wrote an
 * audit row — it never reached Beatrice (who fixes) or Mariah's ledger (who
 * program-manages). A recurring fabrication or a recurring tool-contract failure
 * sat in the audit log until a NIGHTLY scan happened to mine it. This driver
 * closes that gap: a guard catch becomes an instant `quality_signal`
 * (specialist_runtime.ts), and on a RECURRENCE edge this driver files a
 * process_miss (Mariah's ledger) + wakes Beatrice with a scoped diagnostic task.
 *
 * It is the EVENT-DRIVEN sibling of Kate's `scan_system_health` ("file a miss for
 * trainer + flag Beatrice on a fresh down-edge") and is built on the SAME wake
 * spine as the reactive triggers (`wake_deliberation_scoped` → debounce +
 * per-key min-interval + the deep tier, never the interactive tier).
 *
 * Non-negotiables (mirror the reactive-trigger / live-synthesis contracts):
 *  - EDGE-ONLY: a single catch is NOT an incident (the in-turn re-roll handled
 *    it). Only a RECURRENCE — N catches of the same (class, guard, tool/
 *    specialist) inside a rolling window — escalates. The window is counted
 *    in-memory: this is the INSTANT layer for an ACTIVE recurrence (a live
 *    spiral, a specialist fabricating repeatedly this session); the slow-drip
 *    "3 in 14 days" case stays the nightly scan's job, which still reads the
 *    same durable audit rows.
 *  - DEBOUNCED + RATE-LIMITED: the per-evidence_ref re-escalation guard + the
 *    wake spine's min-interval collapse a noisy class to one miss + one wake.
 *  - FAIL-OPEN: a throwing miss-file or wake is logged and swallowed, never
 *    propagated to the bus (a quality-feedback bug must never break a turn).
 *  - DEEP-TIER ONLY: the wake routes through `deliberate()` → the deep tier.
 *  - NO USER-FACING NOISE: the woken pass surfaces nothing unless it ships a
 *    real fix; everything still flows through the normal proposal/push gate.
 *  - KILL-SWITCHED: HEARTH_GUARD_FEEDBACK=0 → `attach` is a no-op, byte-identical
 *    to before.
 *
 * The meta-agents themselves (trainer / mariah / orchestrator) are SKIPPED as
 * signal PRODUCERS — a guard catch on a Beatrice/Mariah pass must not wake
 * Beatrice to diagnose herself (the 2026-06-09 meta-loop noise audit: ~⅔ of
 * misses were detector noise about Beatrice/Kate themselves). Their misses are
 * still covered by the existing scans + ledger.
 */
import type { AppEvent, AppEventBus } from '@app/events';
import type { MemoryClient } from '@memory/client';
import type { SpecialistRegistry } from './specialist';
import type { ProcessMissSeverity, ProcessMissStore } from './process_misses';
import type { ScopedWaker } from './reactive_triggers';
import { yield_evidence_ref } from './capability_yield';

export function guard_feedback_enabled(): boolean {
  return process.env.HEARTH_GUARD_FEEDBACK !== '0';
}

/** Meta-agents whose OWN guard catches must not feed back (avoid the
 *  self-diagnosis loop). Kept local + tiny — mirrors deliberation.ts's set. */
const META_SPECIALISTS: ReadonlySet<string> = new Set(['trainer', 'mariah', 'orchestrator']);

/** Beatrice — the fixer the recurrence wakes. */
const FIXER_ID = 'trainer';

function int_env(name: string, dflt: number, lo: number, hi: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  const v = Number.isFinite(raw) && raw > 0 ? raw : dflt;
  return Math.max(lo, Math.min(v, hi));
}

/** Catches of one evidence_ref inside this window count toward the threshold. */
function window_ms(): number {
  return int_env('HEARTH_GUARD_FEEDBACK_WINDOW_H', 24, 1, 720) * 3600_000;
}
/** Catches needed inside the window before a recurrence escalates. */
function threshold(): number {
  return int_env('HEARTH_GUARD_FEEDBACK_THRESHOLD', 3, 2, 50);
}
/** Min gap between escalations of the SAME evidence_ref — also passed to the
 *  wake spine so a class already in Beatrice's queue isn't re-woken. */
function min_interval_ms(): number {
  return int_env('HEARTH_GUARD_FEEDBACK_MIN_INTERVAL_MS', 6 * 3600_000, 60_000, 72 * 3600_000);
}

/** High-trust-impact honesty guards (a wrong save/denial the user acted on) →
 *  high; the grounding-critic family → medium. */
const HIGH_HONESTY_GUARDS: ReadonlySet<string> = new Set([
  'fabricated_save_guard',
  'fabricated_action_guard',
  'read_failure_guard',
  'data_denial_guard',
]);

interface Escalation {
  evidence_ref: string;
  subject_specialist_id: string;
  severity: ProcessMissSeverity;
  task_summary: string;
  gap: string;
  /** The scoped-wake task (Beatrice's directed diagnostic framing). */
  wake_task: string;
  /** The wake "what happened" line. */
  reason: string;
}

export interface GuardFeedbackDriverDeps {
  specialists: SpecialistRegistry;
  waker: ScopedWaker;
  process_misses: ProcessMissStore;
  /** Optional — writes a `guard_feedback_escalated` audit row so "did the
   *  instant loop fire?" is one query. Fail-open if absent/throwing. */
  memory?: MemoryClient;
  /** Test seam for the rolling window; defaults to wall-clock. */
  now?: () => number;
}

export class GuardFeedbackDriver {
  /** evidence_ref → catch timestamps inside the window (pruned on touch). */
  private readonly hits = new Map<string, number[]>();
  /** evidence_ref → last escalation ms (the re-escalation rate-limit). */
  private readonly last_escalated = new Map<string, number>();

  constructor(private readonly deps: GuardFeedbackDriverDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * Subscribe to the bus. No-op (returns a no-op unsubscribe) under the kill
   * switch, so the system is byte-identical to pre-feedback behavior.
   */
  attach(events: AppEventBus): () => void {
    if (!guard_feedback_enabled()) {
      console.log('[guard-feedback] disabled (HEARTH_GUARD_FEEDBACK=0) — not attached');
      return () => {};
    }
    console.log(
      `[guard-feedback] attached: recurrence threshold ${threshold()} within ` +
        `${Math.round(window_ms() / 3600_000)}h → process_miss + scoped Beatrice wake`,
    );
    return events.subscribe((e) => this.on_event(e));
  }

  /** Public for the smoke (drive a signal without a real bus). Fail-open. */
  on_event(event: AppEvent): void {
    if (event.type !== 'quality_signal') return;
    try {
      this.handle(event);
    } catch (err) {
      console.error('[guard-feedback] handler threw (swallowed):', err);
    }
  }

  private handle(sig: Extract<AppEvent, { type: 'quality_signal' }>): void {
    // Skip a meta-agent's OWN catch — never wake Beatrice to diagnose Beatrice.
    //
    // The 'yield' class narrows this deliberately to the FIXER alone. The
    // 2026-06-09 lesson was about a NOISY DETECTOR generating misses about the
    // meta-agents themselves; a yield verdict is deterministic SQL over run
    // counts, and a barren Mariah scan (`scan_program_health` writing nothing
    // while misses pile up) is a concrete defect somebody has to fix. Beatrice
    // diagnosing Mariah is not a self-loop — Beatrice diagnosing Beatrice is,
    // and that is exactly what stays excluded.
    const skip = sig.signal_class === 'yield'
      ? sig.specialist_id === FIXER_ID
      : META_SPECIALISTS.has(sig.specialist_id);
    if (skip) return;

    const evidence_ref = this.evidence_ref(sig);
    const now = this.now();
    const win = window_ms();

    // Record + prune the rolling window for this evidence_ref.
    const arr = this.hits.get(evidence_ref) ?? [];
    arr.push(now);
    const pruned = arr.filter((t) => now - t < win);
    this.hits.set(evidence_ref, pruned);

    // A 'yield' signal is ALREADY a multi-run verdict when it arrives —
    // `assess_yield` only says `barren` after N active runs produced nothing.
    // Re-counting it here would double-apply the gate and push a daily job's
    // escalation out by days. The recurrence gate lives where the run data is.
    const needed = sig.signal_class === 'yield' ? 1 : threshold();
    if (pruned.length < needed) return; // not a recurrence yet

    // Re-escalation guard: one miss-file + wake per evidence_ref per interval.
    // Sentinel is -Infinity ("never escalated = infinitely long ago") so the
    // FIRST recurrence always passes regardless of the absolute clock value.
    const last = this.last_escalated.get(evidence_ref) ?? Number.NEGATIVE_INFINITY;
    const interval = min_interval_ms();
    if (now - last < interval) return;
    this.last_escalated.set(evidence_ref, now);

    const esc = this.build_escalation(sig, evidence_ref, pruned.length, win);

    // 1) File the miss — Mariah's ledger sees it (chokepoint dedups by ref).
    try {
      this.deps.process_misses.create({
        subject_specialist_id: esc.subject_specialist_id,
        reporter: 'orchestrator',
        task_summary: esc.task_summary,
        gap: esc.gap,
        severity: esc.severity,
        evidence_ref: esc.evidence_ref,
      });
    } catch (err) {
      console.error('[guard-feedback] miss-file failed (continuing):', err);
    }

    // 2) Wake Beatrice with the scoped diagnostic task — she fixes. The wake
    //    spine's debounce + min-interval (keyed on the evidence_ref) is the
    //    second rate-limit backstop; the deep tier is never the interactive one.
    try {
      this.deps.waker.wake_deliberation_scoped(FIXER_ID, {
        task: esc.wake_task,
        reason: esc.reason,
        dedupe_key: esc.evidence_ref,
        min_interval_ms: interval,
      });
    } catch (err) {
      console.error('[guard-feedback] scoped wake failed (continuing):', err);
    }

    // 3) Self-evidencing audit row (best-effort).
    try {
      this.deps.memory?.log_action({
        intent_id: `gf_${now.toString(36)}`,
        agent: 'orchestrator',
        tool_name: 'guard_feedback_escalated',
        tool_input: {
          evidence_ref: esc.evidence_ref,
          signal_class: sig.signal_class,
          guard: sig.guard,
          specialist_id: sig.specialist_id,
          ...(sig.tool ? { tool: sig.tool } : {}),
          count: pruned.length,
        },
        execution_result: { subject: esc.subject_specialist_id, severity: esc.severity, woke: FIXER_ID },
      });
    } catch {
      /* audit is best-effort */
    }

    console.log(
      `[guard-feedback] escalated ${esc.evidence_ref} (${pruned.length}× in ` +
        `${Math.round(win / 3600_000)}h) → miss + woke ${FIXER_ID}`,
    );
  }

  /** The stable key both the miss chokepoint and the wake debounce share. */
  private evidence_ref(sig: Extract<AppEvent, { type: 'quality_signal' }>): string {
    if (sig.signal_class === 'yield') {
      // Keyed on the TOOL, not the specialist: a barren capability is a
      // property of the capability. `verify_fix_landed` re-runs the owning
      // scan and closes on this exact ref disappearing from fresh findings.
      return yield_evidence_ref(sig.tool ?? 'unknown');
    }
    if (sig.signal_class === 'arg_mismatch') {
      const tool = sig.tool ?? 'unknown';
      return sig.field ? `arg-mismatch:${tool}:${sig.field}` : `arg-mismatch:${tool}`;
    }
    return `honesty:${sig.guard}:${sig.specialist_id}`;
  }

  private build_escalation(
    sig: Extract<AppEvent, { type: 'quality_signal' }>,
    evidence_ref: string,
    count: number,
    win: number,
  ): Escalation {
    const hours = Math.round(win / 3600_000);
    const name = this.deps.specialists.get(sig.specialist_id)?.name ?? sig.specialist_id;

    if (sig.signal_class === 'yield') {
      const tool = sig.tool ?? 'unknown';
      return {
        evidence_ref,
        // The fix lives in the capability's own code/config → Beatrice, the
        // same routing arg_mismatch uses. `sig.specialist_id` (the job's owner)
        // is carried in the prose so she knows whose schedule it runs on.
        subject_specialist_id: FIXER_ID,
        // HIGH on purpose: the defining property of this class is that it is
        // INVISIBLE. `extract_meeting_votes` ran clean for two months.
        severity: 'high',
        task_summary: `\`${tool}\` runs clean and produces nothing`,
        gap:
          `Zero-yield capability: ${sig.detail} Owned by ${name} (${sig.specialist_id}). ` +
          `NOTE the shape of this miss — there is no error to read. Every run returned ` +
          `success, so error rate, \`system_health\` and the guard family are all ` +
          `structurally blind to it; the only signal is that rows stopped coming out. ` +
          `Beatrice: run \`diagnose_capability_yield('${tool}')\` — it assembles the run ` +
          `series, the considered-vs-produced trend, the job config and the tool source, ` +
          `then scores typed fixes. Two causes dominate and both LOOK healthy: the ` +
          `capability is reading the wrong thing (a stale document, a search result ranked ` +
          `by relevance rather than recency, an index page instead of the document), or a ` +
          `downstream filter/contract silently rejects everything it extracts. ` +
          `"Retire the job" is a legitimate verdict — say so rather than inventing work.`,
        wake_task:
          `\`${tool}\` has been running successfully and writing NOTHING (${sig.detail}). ` +
          `This is the class no other detector can see: no errors, no guard catches, ` +
          `nothing to fail — just no output. Run \`diagnose_capability_yield('${tool}')\` ` +
          `FIRST; don't guess. Ground the root cause in the evidence it returns (the ` +
          `considered-vs-produced series tells you whether input is arriving and being ` +
          `dropped, or never arriving at all), then ship the fix through your change ` +
          `pipeline (propose_code_edit → Kate review → owner merge). If the capability ` +
          `genuinely has no purpose any more, propose RETIRING it — a job that cannot ` +
          `produce is worse than absent, because it reads as coverage.`,
        reason: `\`${tool}\` produced no output across its recent runs despite available work.`,
      };
    }

    if (sig.signal_class === 'arg_mismatch') {
      const tool = sig.tool ?? 'unknown';
      const severity: ProcessMissSeverity = sig.guard === 'same_tool_spiral_exhaust' ? 'high' : 'medium';
      return {
        evidence_ref,
        // The fix owner is the tool contract → Beatrice (mirrors scan_system_health
        // filing a dependency miss against 'trainer', not a specialist).
        subject_specialist_id: FIXER_ID,
        severity,
        task_summary: `Tool \`${tool}\` keeps failing argument validation`,
        gap:
          `Recurring tool-arg failure on \`${tool}\` (${sig.guard}) — fired ${count}× in ${hours}h, ` +
          `surviving central _recover_tool_args. ${name} emitted args the schema rejected. ` +
          `Likely a gratuitously-specific required field (a synonym the model naturally emits) ` +
          `or a bad/over-wide contract. Beatrice: \`diagnose_tool_failure('${tool}')\` — it reads ` +
          `the audit error text + the provided-vs-required extraction + the live :8088 probe + the ` +
          `schema — then ship the schema-rename / alias / contract fix through propose_code_edit. ` +
          `Last error: ${sig.detail.slice(0, 200)}`,
        wake_task:
          `Tool \`${tool}\` keeps failing argument validation past central recovery ` +
          `(${sig.guard}, ${count}× in ${hours}h). Run \`diagnose_tool_failure('${tool}')\` FIRST — ` +
          `it assembles the evidence a human would (the audit error strings, the provided-vs-required ` +
          `field extraction, a live tool-call probe to the interactive endpoint, and the tool's schema) ` +
          `and scores typed fixes. Confirm the root cause (a synonym/over-specific field, a bad ` +
          `contract, or a \`pattern\` fail-open), then ship the fix through your change pipeline ` +
          `(propose_code_edit → Kate review → owner merge). Don't guess the cause — ground it in the probe.`,
        reason: `\`${tool}\` failed arg-validation ${count}× within ${hours}h (${sig.guard}).`,
      };
    }

    // honesty class
    const severity: ProcessMissSeverity = HIGH_HONESTY_GUARDS.has(sig.guard) ? 'high' : 'medium';
    return {
      evidence_ref,
      subject_specialist_id: sig.specialist_id,
      severity,
      task_summary: `${name} keeps tripping the ${sig.guard} honesty guard`,
      gap:
        `Recurring honesty-guard catch (${sig.guard}) on ${name} — fired ${count}× in ${hours}h. ` +
        `The runtime re-rolled each in-turn, so the user didn't see the fabrication — but the ` +
        `PATTERN recurs, which means a structural layer (grounding / a connector returning bare ` +
        `errors / a persona over-promising) owns it, not this one turn. Beatrice: diagnose the ` +
        `owning layer — \`analyze_tool_sequence\`/\`query_audit_log\` on ${sig.specialist_id}, and ` +
        `\`diagnose_tool_failure\` if a specific tool is implicated — then ship the fix through your ` +
        `change pipeline. Last reply preview: ${sig.detail.slice(0, 200)}`,
      wake_task:
        `A recurring honesty-guard miss (${sig.guard}) on ${name} just crossed the escalation ` +
        `threshold (${count}× in ${hours}h). A single re-rolled catch is fine — this is a PATTERN, ` +
        `so the fix lives in a STRUCTURAL layer, never a persona "always ground first" line. ` +
        `Diagnose which layer owns it: \`analyze_tool_sequence\`/\`query_audit_log\` on ` +
        `${sig.specialist_id} to see the shape, and \`diagnose_tool_failure\` if a tool keeps ` +
        `returning bare errors the model fabricates over. Ship the grounding/connector/contract ` +
        `fix through your change pipeline (Kate review → owner merge); don't prescribe prose.`,
      reason: `${name} tripped ${sig.guard} ${count}× within ${hours}h.`,
    };
  }
}
