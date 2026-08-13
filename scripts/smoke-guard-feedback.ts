/**
 * smoke:guard-feedback — the instant guard-catch → miss + Beatrice-wake spine.
 *
 * Self-contained (no DB, no LLM, no network): fake registry + spy waker + fake
 * ProcessMissStore + an injected clock. Asserts the GuardFeedbackDriver:
 *
 *   1. EDGE-ONLY: catches below the threshold escalate NOTHING; the threshold-th
 *      catch within the window files ONE miss + ONE scoped Beatrice wake.
 *   2. evidence_ref + subject + severity shapes (honesty vs arg_mismatch).
 *   3. RE-ESCALATION rate-limit: more catches inside min_interval don't re-file
 *      / re-wake; a catch after min_interval does.
 *   4. WINDOW pruning: catches spaced beyond the window never reach threshold.
 *   5. META-SKIP: a meta-agent's OWN catch (trainer/mariah/orchestrator) is
 *      never escalated (no Beatrice-diagnoses-Beatrice loop).
 *   6. FAIL-OPEN: a throwing store / waker never makes on_event throw.
 *   7. KILL SWITCH: HEARTH_GUARD_FEEDBACK=0 ⇒ attach() is a no-op.
 */
import { AppEventBus, type AppEvent } from '@app/events';
import type { MemoryClient } from '@memory/client';
import type { SpecialistRegistry } from '@core/specialist';
import type { ScopedWaker } from '@core/reactive_triggers';
import type { NewProcessMiss, ProcessMissStore } from '@core/process_misses';
import { GuardFeedbackDriver } from '@core/guard_feedback';

// Deterministic knobs (read at call-time by the driver).
process.env.HEARTH_GUARD_FEEDBACK_THRESHOLD = '3';
process.env.HEARTH_GUARD_FEEDBACK_WINDOW_H = '24';
process.env.HEARTH_GUARD_FEEDBACK_MIN_INTERVAL_MS = '3600000'; // 1h
delete process.env.HEARTH_GUARD_FEEDBACK; // ensure enabled

const HOUR = 3600_000;

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

// ── Fakes ────────────────────────────────────────────────────────────────────

function make_registry(names: Record<string, string>): SpecialistRegistry {
  return {
    get: (id: string) => (names[id] ? { id, name: names[id] } : null),
  } as unknown as SpecialistRegistry;
}

function make_spy_waker(throws = false): { waker: ScopedWaker; calls: Array<{ id: string; opts: any }> } {
  const calls: Array<{ id: string; opts: any }> = [];
  return {
    waker: {
      wake_deliberation_scoped: (id, opts) => {
        if (throws) throw new Error('waker boom');
        calls.push({ id, opts });
      },
    },
    calls,
  };
}

function make_store(throws = false): { store: ProcessMissStore; created: NewProcessMiss[] } {
  const created: NewProcessMiss[] = [];
  return {
    store: {
      create: (m: NewProcessMiss) => {
        if (throws) throw new Error('store boom');
        created.push(m);
        return `pm_${created.length}`;
      },
    } as unknown as ProcessMissStore,
    created,
  };
}

function make_memory(): { memory: MemoryClient; audits: any[] } {
  const audits: any[] = [];
  return {
    memory: { log_action: (rec: any) => (audits.push(rec), 'aud_x') } as unknown as MemoryClient,
    audits,
  };
}

function honesty_sig(
  specialist_id: string,
  guard = 'fabricated_save_guard',
): Extract<AppEvent, { type: 'quality_signal' }> {
  return {
    type: 'quality_signal',
    specialist_id,
    signal_class: 'honesty',
    guard,
    detail: 'Got it — saved to your notes.',
    conversation_id: 'c1',
  };
}

function arg_sig(
  tool: string,
  guard = 'tool_arg_unrecovered',
  field?: string,
): Extract<AppEvent, { type: 'quality_signal' }> {
  return {
    type: 'quality_signal',
    specialist_id: 'kristi',
    signal_class: 'arg_mismatch',
    guard,
    tool,
    ...(field ? { field } : {}),
    detail: 'INPUT_VALIDATION_FAILED: note_path required',
  };
}

function make_driver(opts: {
  registry?: SpecialistRegistry;
  waker?: ScopedWaker;
  store?: ProcessMissStore;
  memory?: MemoryClient;
  clock: { t: number };
}): GuardFeedbackDriver {
  return new GuardFeedbackDriver({
    specialists: opts.registry ?? make_registry({ kate: 'Kate', kristi: 'Kristi' }),
    waker: opts.waker ?? make_spy_waker().waker,
    process_misses: opts.store ?? make_store().store,
    ...(opts.memory ? { memory: opts.memory } : {}),
    now: () => opts.clock.t,
  });
}

// ── 1: edge-only threshold + honesty shape ───────────────────────────────────

function test_honesty_threshold(): void {
  console.log('\n[1] honesty: edge-only threshold + shape');
  const clock = { t: 1_000_000 };
  const { waker, calls } = make_spy_waker();
  const { store, created } = make_store();
  const { memory, audits } = make_memory();
  const driver = make_driver({ waker, store, memory, registry: make_registry({ kate: 'Kate' }), clock });

  driver.on_event(honesty_sig('kate'));
  driver.on_event(honesty_sig('kate'));
  assert(created.length === 0 && calls.length === 0, 'two catches (< threshold 3) escalate nothing');

  driver.on_event(honesty_sig('kate'));
  assert(created.length === 1, 'the 3rd catch within the window files exactly one miss');
  assert(calls.length === 1 && calls[0]!.id === 'trainer', 'and scoped-wakes Beatrice (trainer)');

  const m = created[0]!;
  assert(m.evidence_ref === 'honesty:fabricated_save_guard:kate', 'evidence_ref is honesty:<guard>:<specialist>');
  assert(m.subject_specialist_id === 'kate', 'honesty miss subject is the fabricating specialist');
  assert(m.severity === 'high', 'fabricated_save_guard is high severity');
  assert(/Kate/.test(m.task_summary) && /3×/.test(m.gap), 'gap names the specialist + the recurrence count');

  const wake = calls[0]!.opts;
  assert(wake.dedupe_key === 'honesty:fabricated_save_guard:kate', 'wake dedupe_key == evidence_ref');
  assert(/PATTERN/.test(wake.task) && /diagnose_tool_failure|analyze_tool_sequence/.test(wake.task), 'wake task steers Beatrice to diagnose the structural layer');
  assert(wake.min_interval_ms === HOUR, 'wake carries the configured min_interval');
  assert(audits.some((a) => a.tool_name === 'guard_feedback_escalated'), 'a guard_feedback_escalated audit row is written');
}

// ── 2: re-escalation rate-limit ──────────────────────────────────────────────

function test_reescalation_guard(): void {
  console.log('\n[2] re-escalation rate-limit');
  const clock = { t: 1_000_000 };
  const { waker, calls } = make_spy_waker();
  const { store, created } = make_store();
  const driver = make_driver({ waker, store, registry: make_registry({ kate: 'Kate' }), clock });

  for (let i = 0; i < 3; i++) driver.on_event(honesty_sig('kate'));
  assert(created.length === 1 && calls.length === 1, 'first recurrence escalates once');

  // More catches immediately — still inside min_interval (1h).
  clock.t += 10 * 60_000; // +10 min
  for (let i = 0; i < 5; i++) driver.on_event(honesty_sig('kate'));
  assert(created.length === 1 && calls.length === 1, 'further catches inside min_interval do not re-file / re-wake');

  // Past min_interval — the next catch re-escalates (still ≥ threshold in window).
  clock.t += 61 * 60_000; // now > 1h since first escalation
  driver.on_event(honesty_sig('kate'));
  assert(created.length === 2 && calls.length === 2, 'a catch after min_interval re-escalates');
}

// ── 3: window pruning ────────────────────────────────────────────────────────

function test_window_pruning(): void {
  console.log('\n[3] window pruning');
  const clock = { t: 1_000_000 };
  const { store, created } = make_store();
  const driver = make_driver({ store, registry: make_registry({ kate: 'Kate' }), clock });

  // Three catches spaced 25h apart — never 3 inside the 24h window.
  driver.on_event(honesty_sig('kate'));
  clock.t += 25 * HOUR;
  driver.on_event(honesty_sig('kate'));
  clock.t += 25 * HOUR;
  driver.on_event(honesty_sig('kate'));
  assert(created.length === 0, 'catches spaced beyond the window never reach threshold');
}

// ── 4: arg_mismatch shape ────────────────────────────────────────────────────

function test_arg_mismatch(): void {
  console.log('\n[4] arg_mismatch shape + spiral severity');
  const clock = { t: 1_000_000 };
  const { store, created } = make_store();
  const { waker, calls } = make_spy_waker();
  const driver = make_driver({ store, waker, registry: make_registry({ kristi: 'Kristi' }), clock });

  for (let i = 0; i < 3; i++) driver.on_event(arg_sig('read_note'));
  assert(created.length === 1, 'recurring arg failure on a tool escalates once');
  const m = created[0]!;
  assert(m.evidence_ref === 'arg-mismatch:read_note', 'arg evidence_ref is arg-mismatch:<tool>');
  assert(m.subject_specialist_id === 'trainer', 'arg miss subject is trainer (she owns the tool contract)');
  assert(m.severity === 'medium', 'a plain arg-validation failure is medium');
  assert(/diagnose_tool_failure\('read_note'\)/.test(calls[0]!.opts.task), 'wake task names diagnose_tool_failure(<tool>)');

  // A field-scoped evidence_ref is distinct.
  const clock2 = { t: 2_000_000 };
  const { store: s2, created: c2 } = make_store();
  const d2 = make_driver({ store: s2, registry: make_registry({ kristi: 'Kristi' }), clock: clock2 });
  for (let i = 0; i < 3; i++) d2.on_event(arg_sig('edgar_read_filing', 'tool_arg_unrecovered', 'filing_url'));
  assert(c2[0]!.evidence_ref === 'arg-mismatch:edgar_read_filing:filing_url', 'a field-scoped arg evidence_ref includes :<field>');

  // A same-tool spiral is high severity.
  const clock3 = { t: 3_000_000 };
  const { store: s3, created: c3 } = make_store();
  const d3 = make_driver({ store: s3, registry: make_registry({ kristi: 'Kristi' }), clock: clock3 });
  for (let i = 0; i < 3; i++) d3.on_event(arg_sig('record_sku', 'same_tool_spiral_exhaust'));
  assert(c3[0]!.severity === 'high', 'a same_tool_spiral_exhaust recurrence is high severity');
}

// ── 5: meta-agent self-skip ──────────────────────────────────────────────────

function test_meta_skip(): void {
  console.log('\n[5] meta-agent self-skip');
  const clock = { t: 1_000_000 };
  const { store, created } = make_store();
  const { waker, calls } = make_spy_waker();
  const driver = make_driver({ store, waker, registry: make_registry({ trainer: 'Beatrice', mariah: 'Mariah' }), clock });

  for (let i = 0; i < 6; i++) driver.on_event(honesty_sig('trainer'));
  for (let i = 0; i < 6; i++) driver.on_event(honesty_sig('mariah'));
  for (let i = 0; i < 6; i++) driver.on_event(honesty_sig('orchestrator'));
  assert(created.length === 0 && calls.length === 0, "a meta-agent's own catches never escalate (no self-diagnosis loop)");
}

// ── 6: fail-open ─────────────────────────────────────────────────────────────

function test_fail_open(): void {
  console.log('\n[6] fail-open against throwing store / waker');
  const clock = { t: 1_000_000 };
  const throwing_store = make_store(true).store;
  const throwing_waker = make_spy_waker(true).waker;
  const driver = make_driver({ store: throwing_store, waker: throwing_waker, registry: make_registry({ kate: 'Kate' }), clock });
  let threw = false;
  try {
    for (let i = 0; i < 3; i++) driver.on_event(honesty_sig('kate'));
  } catch {
    threw = true;
  }
  assert(!threw, 'a throwing store and waker never make on_event throw (the turn is never broken)');
}

// ── 7: kill switch ───────────────────────────────────────────────────────────

function test_kill_switch(): void {
  console.log('\n[7] kill switch');
  process.env.HEARTH_GUARD_FEEDBACK = '0';
  const clock = { t: 1_000_000 };
  const { store, created } = make_store();
  const driver = make_driver({ store, registry: make_registry({ kate: 'Kate' }), clock });
  const bus = new AppEventBus();
  driver.attach(bus); // no-op under the kill switch
  for (let i = 0; i < 5; i++) bus.emit(honesty_sig('kate'));
  assert(created.length === 0, 'HEARTH_GUARD_FEEDBACK=0 ⇒ attach is a no-op, zero escalations via the bus');
  delete process.env.HEARTH_GUARD_FEEDBACK;
}

function main(): void {
  console.log('=== smoke:guard-feedback ===');
  test_honesty_threshold();
  test_reescalation_guard();
  test_window_pruning();
  test_arg_mismatch();
  test_meta_skip();
  test_fail_open();
  test_kill_switch();
  console.log('');
  if (failures > 0) {
    console.error(`✗ ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('✓ all guard-feedback checks passed');
  process.exit(0);
}

main();
