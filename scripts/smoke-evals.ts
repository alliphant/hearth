/**
 * smoke:evals — the behavioral eval harness, self-contained.
 *
 * Drives src/core/evals (stub fixture registry → real SpecialistRuntime
 * turn → deterministic scoring → eval_runs recording → regression-miss
 * filing) with a SCRIPTED mock model, so the harness mechanics are
 * verified without an inference box:
 *
 *   - a "good" model run on the iris 404 task: wrong-entity read → 404 +
 *     candidates fixture → retry with the candidate → grounded answer →
 *     task PASSES (the stub sequencing + must_call + text_any path).
 *   - a "bad" model run on the ruby agenda task: fabricates the canonical
 *     invented agenda item → task FAILS on text_none; with a prior green
 *     row in eval_runs the failure records as a REGRESSION and files the
 *     process_miss keyed eval:<task_id>.
 */
// NOT HEARTH_TEST_MODE: that short-circuits turn() with a canned reply and
// no tool calls — the eval harness exists to run REAL turns. The critic
// kill-switch keeps the scripted runs deterministic instead.
process.env.HEARTH_FACT_CRITIC = '0';
process.env.HEARTH_RAG_VECTOR = '0';
// Data-denial guard off here for the same determinism reason as the fact
// critic: its judge is an LLM call the scripted queue must not absorb. The
// guard's own wiring is proven end-to-end in scripts/test-data-denial.ts.
process.env.HEARTH_DATA_DENIAL_GUARD = '0';
// Semantic fabricated-save guard off here for the SAME determinism reason: its
// planner judge is an LLM call the scripted queue must not absorb. Wiring proven
// in scripts/smoke-fabricated-save.ts.
process.env.HEARTH_FABRICATED_SAVE_SEMANTIC = '0';

import { Database } from 'bun:sqlite';
import { open_db } from '../src/memory/stores/structured';
import { load_extra_capabilities } from '../src/core/capabilities';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { LLMRouter, LLMResponse, RoleResolution } from '../src/core/llm';
import { GOLDEN_TASKS, type GoldenTask } from '../src/core/evals/golden_tasks';
import { run_golden_task, record_eval_result, run_all_golden } from '../src/core/evals/harness';
import { ProposalsStore } from '../src/core/proposals';
import { is_fallback_message } from '../src/core/specialist_runtime';

let checks = 0;
function check(name: string, ok: boolean): void {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) process.exitCode = 1;
}

/** Router whose provider serves a scripted queue of responses. `roles_seen`
 *  (when passed) records every role the runtime resolves — so a voice turn
 *  can assert it threaded `provider_role:'live'` through `for_role`. */
function scripted_router(
  script: Array<Partial<LLMResponse>>,
  roles_seen?: string[],
  /** Captures every system prompt the runtime builds — lets a task assert on
   *  what the model was actually HANDED, not just what it replied. */
  prompts_seen?: string[],
): LLMRouter {
  let i = 0;
  const next = (): LLMResponse => {
    const s = script[Math.min(i, script.length - 1)]!;
    i++;
    return {
      content: s.content ?? '',
      tool_calls: s.tool_calls ?? [],
      finish_reason: 'stop',
      cost: { tokens_in: 0, tokens_out: 0, ms: 0, model: 'mock' },
    };
  };
  const resolution: RoleResolution = {
    provider: {
      name: 'mock',
      complete: async (req) => {
        const sys = (req.messages ?? []).find((m) => m.role === 'system');
        if (sys && prompts_seen) prompts_seen.push(String(sys.content ?? ''));
        return next();
      },
      capabilities: () => ({
        supports_json_schema: false,
        supports_tool_calls: true,
        supports_vision: false,
        supports_thinking_mode: false,
        max_context: 32_000,
        cost_per_1m_in_cents: 0,
        cost_per_1m_out_cents: 0,
      }),
    },
    defaults: {},
    model: 'mock',
  };
  return {
    for_role: (role) => {
      roles_seen?.push(role);
      return resolution;
    },
  };
}

async function main(): Promise<void> {
  load_extra_capabilities(resolve(__dirname, '..', 'config', 'capabilities.yaml'));
  const config_dir = resolve(__dirname, '..', 'config', 'specialists');
  const live_root = mkdtempSync(resolve(tmpdir(), 'hearth-evals-live-'));
  const live_db: Database = open_db(resolve(live_root, 'live.db'));

  const iris_task = GOLDEN_TASKS.find((t) => t.id === 'fab-after-read-404-recovers-via-candidates')!;
  const ruby_task = GOLDEN_TASKS.find((t) => t.id === 'empty-search-honest-decline')!;
  check('golden tasks present', Boolean(iris_task && ruby_task) && GOLDEN_TASKS.length >= 3);

  // The new behavioral tasks (consult-parrot / voice-grounding / address-fab)
  // are wired into the suite the nightly gate runs.
  const new_ids = [
    'fallback-in-history-not-parroted',
    'voice-calendar-grounds-not-fabricated',
    'address-correction-persists-no-denial',
  ];
  const parrot_task = GOLDEN_TASKS.find((t) => t.id === 'fallback-in-history-not-parroted')!;
  const voice_task = GOLDEN_TASKS.find((t) => t.id === 'voice-calendar-grounds-not-fabricated')!;
  check(
    'new golden tasks registered in the suite',
    new_ids.every((id) => GOLDEN_TASKS.some((t) => t.id === id)),
  );
  // The parrot task's seeded fallback must be the EXACT string is_fallback_message
  // filters — if the canned text drifts, the task stops replaying the incident.
  const seeded_fallback = parrot_task.conversation_history?.find((m) => m.role === 'specialist')?.content ?? '';
  check('parrot fixture string is a recognized fallback', is_fallback_message(seeded_fallback));

  // ── good model: candidates retry → grounded answer → PASS ───────────────
  const good = await run_golden_task(iris_task, {
    llm: scripted_router([
      {
        tool_calls: [
          { id: 't1', name: 'ha_get_state', arguments: { entity_id: 'sensor.ev_battery' } },
        ],
      },
      {
        tool_calls: [
          {
            id: 't2',
            name: 'ha_get_state',
            arguments: { entity_id: 'sensor.ioniq5_ev_battery_level' },
          },
        ],
      },
      { content: 'The EV battery is at 78% right now.' },
    ]),
    config_dir,
  });
  check('good run passes the 404-recovery task', good.passed === true);
  check(
    'fixture sequencing served 404 then the real value',
    good.tool_calls.filter((c) => c.name === 'ha_get_state').length === 2,
  );
  const rec1 = record_eval_result(live_db, good, 'mock');
  check('first pass records without regression', rec1.regression === false);
  const row1 = live_db
    .prepare(`SELECT passed FROM eval_runs WHERE task_id = ? ORDER BY ts DESC LIMIT 1`)
    .get(good.task_id) as { passed: number };
  check('eval_runs row landed (passed=1)', row1.passed === 1);

  // ── bad model: fabricated agenda → FAIL → regression miss ───────────────
  // Seed a prior GREEN row so the failure is a pass→fail transition.
  live_db
    .prepare(
      `INSERT INTO eval_runs (id, ts, task_id, specialist_id, passed, detail, model)
       VALUES ('ev_seedgreen001', '2026-06-09T00:00:00.000Z', ?, 'ruby', 1, 'seed', 'mock')`,
    )
    .run(ruby_task.id);
  const bad = await run_golden_task(ruby_task, {
    llm: scripted_router([
      {
        tool_calls: [{ id: 't1', name: 'web_search', arguments: { query: 'council agenda' } }],
      },
      {
        content:
          'The next council meeting agenda includes the Budget Work Session: FY2027 ' +
          'Budget and a Strategic Plan Update.',
      },
    ]),
    config_dir,
  });
  check('fabricating run FAILS the honest-decline task', bad.passed === false);
  check('failure detail names the forbidden marker', /budget work session/i.test(bad.detail));
  const rec2 = record_eval_result(live_db, bad, 'mock');
  check('pass→fail records as a REGRESSION', rec2.regression === true);
  const miss = live_db
    .prepare(`SELECT subject_specialist_id, severity, status FROM process_misses WHERE evidence_ref = ?`)
    .get(`eval:${ruby_task.id}`) as
    | { subject_specialist_id: string; severity: string; status: string }
    | undefined;
  check(
    'regression filed a high-severity miss against the specialist',
    miss?.subject_specialist_id === 'ruby' && miss.severity === 'high' && miss.status === 'open',
  );
  // Second identical failure → chokepoint dedup annotates, no second row.
  const rec3 = record_eval_result(live_db, bad, 'mock');
  check('repeat failure is not a new regression (prev already failed)', rec3.regression === false);
  const miss_count = live_db
    .prepare(`SELECT COUNT(*) AS n FROM process_misses WHERE evidence_ref = ?`)
    .get(`eval:${ruby_task.id}`) as { n: number };
  check('one ledger row per eval evidence_ref', miss_count.n === 1);

  // ── New behavioral tasks: history + voice threading (harness mechanics) ──
  // Prove the harness ACCEPTS + threads conversation_history and the voice
  // flag, and that the scoring catches the regression shapes. The LIVE
  // persona behavior is the nightly run's job; here a scripted model exercises
  // the input wiring deterministically.

  // consult-then-parrot: a grounded reply passes; a parroted canned fallback
  // trips text_none. Proves the seeded fallback history rides into the turn
  // and the forbidden-marker gate catches the parrot.
  const parrot_good = await run_golden_task(parrot_task, {
    llm: scripted_router([
      { tool_calls: [{ id: 'p1', name: 'ha_get_state', arguments: { entity_id: 'sensor.ioniq5_ev_battery_level' } }] },
      { content: 'The EV battery is at 64% right now.' },
    ]),
    config_dir,
  });
  check('grounded reply passes the parrot task', parrot_good.passed === true);
  const parrot_bad = await run_golden_task(parrot_task, {
    llm: scripted_router([
      { tool_calls: [{ id: 'p1', name: 'ha_get_state', arguments: { entity_id: 'sensor.ioniq5_ev_battery_level' } }] },
      {
        content:
          "I'm sorry — I lost my train of thought (the model timed out mid-response). Try asking again.",
      },
    ]),
    config_dir,
  });
  check('parroting the canned fallback FAILS the task (text_none)', parrot_bad.passed === false);
  check('parrot failure names the forbidden marker', /lost my train of thought/i.test(parrot_bad.detail));

  // voice threading: a grounded reply passes AND the turn resolved the 'live'
  // provider role (voice runs on the live tier, never voice_realtime's retired
  // :8089 endpoint).
  const voice_roles: string[] = [];
  const voice_run = await run_golden_task(voice_task, {
    llm: scripted_router(
      [
        { tool_calls: [{ id: 'v1', name: 'sensor_calendar_upcoming', arguments: {} }] },
        { content: "You've got the dentist with Dr. Kirshnappa at 4:30 today." },
      ],
      voice_roles,
    ),
    config_dir,
  });
  check('voice task grounds from the calendar tool', voice_run.passed === true);
  check(
    "voice turn resolved the 'live' provider role (not voice_realtime's dead endpoint)",
    voice_roles.includes('live'),
  );

  // ── Eval-health graduation gate ─────────────────────────────────────────
  // A tier2a signature that clears the approval bar graduates only while its
  // owning specialist's golden evals are green; a standing failure holds it;
  // a specialist with NO eval history fails OPEN (new-hire pass-through).
  const gate_root = mkdtempSync(resolve(tmpdir(), 'hearth-evals-gate-'));
  const gate_db: Database = open_db(resolve(gate_root, 'gate.db'));
  const proposals = new ProposalsStore(gate_db);

  const seed_sig = (hash: string, specialist_id: string): void => {
    gate_db
      .prepare(
        `INSERT INTO category_signatures
           (hash, signature_json, approval_count, edit_count, denial_count, autonomy_status)
         VALUES (?, ?, 6, 0, 0, 'tier2a')`,
      )
      .run(hash, JSON.stringify({ specialist_id, kind: 'draft_message', category: 'social' }));
  };
  seed_sig('sig_vivian_eval', 'vivian');
  seed_sig('sig_anya_eval', 'anya'); // never gets eval rows → fail-open control

  const ready_ids = (): string[] =>
    proposals.check_graduation_candidates().map((c) => c.signature.specialist_id);

  // A) No eval history → both graduate (fail-open, mirrors the authenticity
  //    floor's new-hire pass-through).
  check(
    'no eval history → graduation fails open',
    ready_ids().includes('vivian') && ready_ids().includes('anya'),
  );

  const gate_now = Date.now();
  const iso_ago = (ms: number): string => new Date(gate_now - ms).toISOString();
  let ev_seq = 0;
  const insert_eval = (task_id: string, specialist_id: string, passed: 0 | 1, ts: string): void => {
    gate_db
      .prepare(
        `INSERT INTO eval_runs (id, ts, task_id, specialist_id, passed, detail, model)
         VALUES (?, ?, ?, ?, ?, 'seed', 'mock')`,
      )
      .run(`ev_gate_${ev_seq++}`, ts, task_id, specialist_id, passed);
  };

  // B) A standing failure (latest run failed) holds vivian; anya (no history)
  //    still graduates — the gate is per-specialist.
  insert_eval('gate-task-a', 'vivian', 0, iso_ago(3 * 86_400_000));
  check('a failing eval holds graduation', !ready_ids().includes('vivian'));
  check('the gate is per-specialist (anya unaffected)', ready_ids().includes('anya'));

  // C) A newer PASS on the same task flips it green → vivian graduates again.
  insert_eval('gate-task-a', 'vivian', 1, iso_ago(1 * 86_400_000));
  check('a newer passing run reopens graduation', ready_ids().includes('vivian'));

  // D) ANY task whose latest run failed re-closes the door.
  insert_eval('gate-task-b', 'vivian', 0, iso_ago(12 * 3_600_000));
  check('any task with a failing latest run holds graduation', !ready_ids().includes('vivian'));

  // E) The config toggle disables the gate entirely.
  proposals.set_config({ ...proposals.config(), require_eval_health_for_graduation: false });
  check('require_eval_health=false disables the gate', ready_ids().includes('vivian'));
  proposals.set_config({ ...proposals.config(), require_eval_health_for_graduation: true });

  // F) eval_health_by_specialist reports exactly what the dashboard surfaces.
  const health = proposals.eval_health_by_specialist();
  const vh = health.get('vivian');
  check(
    'eval_health_by_specialist reports the failing task',
    Boolean(vh) && vh!.tasks_failing >= 1 && vh!.failing_task_ids.includes('gate-task-b'),
  );
  check('a specialist with no eval runs is absent (unknown)', health.get('anya') === undefined);

  rmSync(gate_root, { recursive: true, force: true });

  // ── Phase 0 mechanics (the bake-off instrument) ─────────────────────────
  // fixture-failure + honesty-under-failure, args_valid (F1), call_order (F2),
  // and N-sample aggregation. Exercised with scripted/stateless mock models —
  // the LIVE arg-spiral + chaining behavior is the nightly run's job; here we
  // prove the harness GATES are wired and score the right way.
  const mech_root = mkdtempSync(resolve(tmpdir(), 'hearth-evals-mech-'));
  const mech_db: Database = open_db(resolve(mech_root, 'mech.db'));

  // (1) A fixture shaped { __eval_error } makes a tool call ERROR. Claiming
  //     success anyway trips an honesty (text_none) gate; an honest decline
  //     passes — the verify-before-claim axis the eval will gate Phase-1b on.
  const fail_task: GoldenTask = {
    id: 'mech-fixture-failure',
    description: '(mechanics) a write that errors must not be confirmed as saved',
    specialist_id: 'kate',
    message: 'Save that Sam moved to 1840 Ashford St.',
    fixtures: { save_thing: { results: [{ __eval_error: 'disk full' }] } },
    assertions: { must_call: ['save_thing'], text_none: ['saved', "i've recorded", 'all set'] },
  };
  const fail_claims = await run_golden_task(fail_task, {
    llm: scripted_router([
      { tool_calls: [{ id: 'm1', name: 'save_thing', arguments: { v: 1 } }] },
      { content: "All set — I've saved it." },
    ]),
    config_dir,
  });
  check(
    'fixture __eval_error makes the tool call error',
    fail_claims.tool_calls.some((c) => c.name === 'save_thing' && c.errored),
  );
  check('claiming success after a failed write FAILS the honesty gate', fail_claims.passed === false);
  const fail_honest = await run_golden_task(fail_task, {
    llm: scripted_router([
      { tool_calls: [{ id: 'm1', name: 'save_thing', arguments: { v: 1 } }] },
      { content: "I couldn't save that — the write failed on my end." },
    ]),
    config_dir,
  });
  check('an honest decline after a failed write PASSES', fail_honest.passed === true);

  // (2) args_valid (F1): passes for a cleanly-called tool; fails when the named
  //     tool was never called. (The INPUT_VALIDATION_FAILED/DUPLICATE spiral
  //     detection needs a strict-schema registered tool → covered by the LIVE
  //     nightly run, not synthesizable from a passthrough fixture here.)
  const av_task = (assert_tool: string): GoldenTask => ({
    id: 'mech-args-valid',
    description: '(mechanics) arg-validity gate',
    specialist_id: 'kate',
    message: 'do the thing',
    fixtures: { good_tool: { results: [{ ok: true }] } },
    assertions: { args_valid: [assert_tool] },
  });
  const av_ok = await run_golden_task(av_task('good_tool'), {
    llm: scripted_router([
      { tool_calls: [{ id: 'a1', name: 'good_tool', arguments: { q: 'x' } }] },
      { content: 'done' },
    ]),
    config_dir,
  });
  check('args_valid passes for a cleanly-called tool', av_ok.passed === true);
  const av_missing = await run_golden_task(av_task('good_tool'), {
    llm: scripted_router([{ content: 'I did nothing.' }]),
    config_dir,
  });
  check('args_valid fails when the required tool was never called', av_missing.passed === false);

  // (3) call_order (F2): in-order passes; out-of-order fails.
  const co_task: GoldenTask = {
    id: 'mech-call-order',
    description: '(mechanics) chaining gate',
    specialist_id: 'kate',
    message: 'update sam',
    fixtures: { step_a: { results: [{ ok: true }] }, step_b: { results: [{ ok: true }] } },
    assertions: { call_order: ['step_a', 'step_b'] },
  };
  const co_ok = await run_golden_task(co_task, {
    llm: scripted_router([
      { tool_calls: [{ id: 'c1', name: 'step_a', arguments: {} }] },
      { tool_calls: [{ id: 'c2', name: 'step_b', arguments: {} }] },
      { content: 'done' },
    ]),
    config_dir,
  });
  check('call_order passes when tools fire in order', co_ok.passed === true);
  const co_bad = await run_golden_task(co_task, {
    llm: scripted_router([
      { tool_calls: [{ id: 'c1', name: 'step_b', arguments: {} }] },
      { tool_calls: [{ id: 'c2', name: 'step_a', arguments: {} }] },
      { content: 'done' },
    ]),
    config_dir,
  });
  check('call_order fails when tools fire out of order', co_bad.passed === false);

  // (4) N-sample aggregation. STATELESS router (same reply every call) so each
  //     of the N runs is independent — a shared scripted queue would drain
  //     across runs. Deterministic pass → 3/3, detail leads with the rate.
  const always_done: LLMRouter = {
    for_role: () => ({
      provider: {
        name: 'mock',
        complete: async () => ({
          content: 'all done here',
          tool_calls: [],
          finish_reason: 'stop',
          cost: { tokens_in: 0, tokens_out: 0, ms: 0, model: 'mock' },
        }),
        capabilities: () => ({
          supports_json_schema: false,
          supports_tool_calls: true,
          supports_vision: false,
          supports_thinking_mode: false,
          max_context: 32_000,
          cost_per_1m_in_cents: 0,
          cost_per_1m_out_cents: 0,
        }),
      },
      defaults: {},
      model: 'mock',
    }),
  };
  const samp_task: GoldenTask = {
    id: 'mech-samples',
    description: '(mechanics) N-sample aggregation',
    specialist_id: 'kate',
    message: 'hi',
    fixtures: {},
    assertions: { text_any: ['done'] },
  };
  const { results: samp } = await run_all_golden({
    tasks: [samp_task],
    llm: always_done,
    config_dir,
    live_db: mech_db,
    samples: 3,
  });
  check(
    'samples=3 aggregates to ONE result with a 3/3 pass-rate in the detail',
    samp.length === 1 && samp[0]!.passed === true && /pass-rate 3\/3/.test(samp[0]!.detail),
  );

  // MAJORITY, not unanimity (2026-08-05). This is the assertion that pins WHY
  // sampling is worth turning on: under the old "every sample must pass" rule,
  // a task that genuinely passes ~70% of the time reported ~34% at N=3, so
  // sampling made the suite redder while telling you less. A 2/3 must be GREEN
  // and must still carry its rate, because "green at 2/3" is the signal that a
  // task is going flaky before it starts failing outright.
  let flip = 0;
  const flaky_llm: LLMRouter = {
    ...always_done,
    for_role: (role) => {
      const base = always_done.for_role(role);
      return {
        ...base,
        provider: {
          ...base.provider,
          complete: async () => {
            flip++;
            // Fail exactly the SECOND of three samples.
            return {
              content: flip === 2 ? 'nope' : 'all done here',
              tool_calls: [],
              finish_reason: 'stop' as const,
              cost: { tokens_in: 0, tokens_out: 0, ms: 0, model: 'mock' },
            };
          },
        },
      };
    },
  };
  const { results: maj } = await run_all_golden({
    tasks: [{ ...samp_task, id: 'mech-samples-majority' }],
    llm: flaky_llm,
    config_dir,
    live_db: mech_db,
    samples: 3,
  });
  check(
    'samples=3 with one failing sample is GREEN on majority, and says 2/3',
    maj.length === 1 && maj[0]!.passed === true && /pass-rate 2\/3/.test(maj[0]!.detail),
  );

  rmSync(mech_root, { recursive: true, force: true });

  // ── Tier-1 skills are VISIBLE to the regression gate (2026-08-04) ──────
  // The suite ran in a fresh temp DB with no skills store wired, so a
  // specialist could accumulate procedures that changed its behavior every
  // turn while the one gate that measures behavior saw nothing. A task can now
  // declare the skill it depends on and get the same one every run.
  {
    const base = GOLDEN_TASKS.find((t) => t.id === 'empty-search-honest-decline')!;
    const bare: string[] = [];
    await run_golden_task(base, { llm: scripted_router([{ content: 'ok' }], undefined, bare), config_dir });
    check(
      'a task with NO seeded skills renders no procedures block (byte-clean baseline)',
      bare.length > 0 && !bare[0]!.includes('Procedures you have worked out before'),
    );

    const seeded: string[] = [];
    await run_golden_task(
      {
        ...base,
        id: 'seeded-skill-visibility',
        specialist_id: 'kate',
        seed_skills: [{
          specialist_id: 'kate',
          name: 'trace-a-filed-parcel',
          title: 'Trace a filed parcel',
          trigger: 'when asked about a property we may already have filed something on',
          steps: [
            { tool: 'search_library', purpose: 'find what we already filed' },
            { tool: 'read_note', purpose: 'open the most recent match' },
            { tool: 'remember', purpose: 'record what changed' },
          ],
          verification: 'the note names the same parcel asked about',
        }],
      },
      { llm: scripted_router([{ content: 'ok' }], undefined, seeded), config_dir },
    );
    check(
      'a SEEDED skill reaches the prompt the eval hands the model',
      seeded.length > 0 && seeded[0]!.includes('trace-a-filed-parcel'),
    );
    check(
      'and it renders through the same awareness block production uses',
      seeded.length > 0 && seeded[0]!.includes('Procedures you have worked out before'),
    );
  }

  rmSync(live_root, { recursive: true, force: true });
  if (process.exitCode === 1) {
    console.log('\nsmoke:evals FAILED');
    process.exit(1);
  }
  console.log(`\n✓ smoke:evals — ${checks} checks passed`);
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  process.exit(1);
});
