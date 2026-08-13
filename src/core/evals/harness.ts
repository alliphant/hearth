/**
 * eval harness — runs golden behavioral tasks against the LIVE personas
 * and the LIVE model, with the external world stubbed to fixtures.
 *
 * The missing layer this adds (2026-06-10): smokes prove the PLUMBING;
 * nothing proved the BEHAVIOR. Persona edits, prompt-block changes, and
 * model swaps shipped on vibes — a regression in a hard-won behavior
 * (retry-the-candidates, honest-decline-on-empty-search) was invisible
 * until it reached the owner again. Golden tasks make those behaviors a
 * nightly regression gate: each run writes an `eval_runs` row, and a
 * pass→fail transition files a process_miss keyed `eval:<task_id>` (the
 * evidence_ref chokepoint annotates recurrences onto the same row), which
 * lands in Mariah's ledger like any other miss.
 *
 * Isolation: each task runs in a throwaway vault + SQLite db with a stub
 * ToolRegistry serving the task's fixtures — no real connector executes,
 * nothing touches live state. Only the RESULTS land in the live db.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { SpecialistRegistry } from '@core/specialist';
import { SpecialistRuntime } from '@core/specialist_runtime';
import { ToolRegistry } from '@core/tool_registry';
import { ProposalsStore } from '@core/proposals';
import { SpecialistInbox } from '@memory/stores/conversations';
import { ProcessMissStore } from '@core/process_misses';
import { EvalTracesStore, to_trace_calls, type TraceCall } from '@memory/stores/eval_traces';
import { SkillsStore } from '@memory/stores/skills';
import type { LLMRouter } from '@core/llm';
import type { Tool } from '@core/tool';
import type { GoldenTask } from './golden_tasks';

export interface EvalResult {
  task_id: string;
  specialist_id: string;
  passed: boolean;
  detail: string;
  tool_calls: Array<{ name: string; errored: boolean }>;
  reply_preview: string;
  /**
   * The WHY evidence (2026-08-03). `detail` is a 1000-char human summary of
   * what broke; this is what a fix has to be grounded in — the assertions that
   * failed verbatim, the full reply, and each call's ARGS and ERROR (which the
   * runtime already produced and this harness used to discard).
   *
   * Populated on every run; persisted only for failures (`record_eval_result`),
   * because a green trace has no consumer. Read by src/core/eval_diagnosis.ts.
   */
  trace: {
    failed_assertions: string[];
    reply: string;
    calls: TraceCall[];
  };
}

/**
 * Curly→straight quote fold applied to BOTH the reply and every marker
 * before text_any/text_none matching. Live models emit U+2019 ("can’t");
 * the marker lists are authored straight ("can't") — without the fold an
 * honest decline false-fails a task and files a spurious regression miss
 * (live run 2026-06-12: ruby's "I can’t pull the live agenda" failed
 * empty-search-honest-decline's text_any on exactly this).
 */
function fold_quotes(s: string): string {
  return s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
}

/** Build a stub Tool that serves the fixture sequence (last result repeats).
 *  `risk` defaults to 'read'; a write tier lets a task exercise a guard that
 *  keys on the tool's risk (the save-honesty guard's failed-WRITE detection). */
function make_stub_tool(name: string, results: unknown[], risk: Tool['risk'] = 'read'): Tool {
  let calls = 0;
  return {
    name,
    description: `(eval fixture) ${name}`,
    risk,
    required_capabilities: [],
    // State-dependent by construction (sequenced results) — never serve a
    // repeat from the runtime's per-turn duplicate cache.
    volatile: true,
    input_schema: z.object({}).passthrough(),
    output_schema: z.any(),
    idempotency_key: () => `eval_stub:${name}:${calls}`,
    async execute() {
      const i = Math.min(calls, results.length - 1);
      calls++;
      const r = results[i];
      // A fixture result shaped { __eval_error: "msg" } simulates a tool
      // FAILURE: the stub throws, so ToolRegistry.invoke returns ok:false and
      // the runtime records the call with an error. This exercises the
      // honesty-under-failure / verify-before-claim axis — a write that errors
      // must NOT be confirmed to the user as "saved". Any other shape is a
      // normal successful result.
      if (r !== null && typeof r === 'object' && '__eval_error' in (r as object)) {
        throw new Error(String((r as { __eval_error: unknown }).__eval_error) || 'eval fixture failure');
      }
      return r;
    },
  } as Tool;
}

/**
 * Write a calendar snapshot into a task's temp vault, in exactly the shape the
 * iOS sensor route produces — the vault JSON plus the `calendar_snapshots`
 * row — so `query_calendar_snapshot` → `read_calendar_from_snapshot` →
 * `kate_pack` all run for real. Events land on TOMORROW local, since that is
 * the day the calendar tasks ask about.
 */
function seed_calendar_snapshot(
  vault_root: string,
  db: ReturnType<typeof open_db>,
  events: NonNullable<GoldenTask['seed_calendar']>,
): void {
  const now = new Date();
  const rel = `Users/jasper/sensors/calendar/snapshot/eval-${ulid()}.json`;
  const abs = resolve(vault_root, rel);
  const rows = events.map((e) => {
    const [h, m] = e.hhmm.split(':').map((n) => Number(n));
    // Local wall-clock tomorrow, expressed as the UTC instant the reader sorts
    // and buckets on. Built from the host's own offset so the seeded events
    // land in the reader's "tomorrow" window wherever the suite runs.
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, h ?? 0, m ?? 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    return {
      title: e.summary,
      summary: e.summary,
      ts_start: start.toISOString(),
      ts_end: end.toISOString(),
      all_day: false,
      ...(e.location ? { location: e.location } : {}),
    };
  });
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify({ events: rows }, null, 2));
  const iso = now.toISOString();
  db.prepare(
    `INSERT INTO calendar_snapshots
       (user_id, captured_at, received_at, window_start, window_end, event_count, payload_path)
     VALUES (@u, @cap, @cap, @ws, @we, @n, @p)`,
  ).run({
    '@u': 'jasper',
    '@cap': iso,
    '@ws': iso,
    '@we': new Date(now.getTime() + 7 * 86_400_000).toISOString(),
    '@n': rows.length,
    '@p': rel,
  });
}

/**
 * Run ONE golden task in an isolated environment. `config_dir` is the live
 * config/specialists directory (the whole point is testing deployed
 * personas); `llm` is the live router (or a mock in the smoke).
 */
export async function run_golden_task(
  task: GoldenTask,
  opts: { llm: LLMRouter; config_dir: string },
): Promise<EvalResult> {
  const root = mkdtempSync(resolve(tmpdir(), `hearth-eval-${task.id.slice(0, 20)}-`));
  try {
    const vault = resolve(root, 'vault');
    mkdirSync(vault, { recursive: true });
    const db = open_db(resolve(root, 'eval.db'));
    const memory = new MemoryClient({ vault_root: vault, db });
    const specialists = new SpecialistRegistry(opts.config_dir);
    if (task.seed_calendar) seed_calendar_snapshot(vault, db, task.seed_calendar);
    const tools = new ToolRegistry();
    for (const [name, fx] of Object.entries(task.fixtures)) {
      tools.register(make_stub_tool(name, fx.results, fx.risk ?? 'read'));
    }
    // Tier-1 skills (2026-08-04). The store is ALWAYS wired, even when the task
    // seeds nothing — otherwise the suite tests a runtime shaped differently
    // from production, and "no skills block" would be an artifact of the
    // harness rather than a fact about the task. With an empty store the block
    // renders '' and the prompt is byte-identical to before.
    const skills = new SkillsStore(db);
    for (const s of task.seed_skills ?? []) {
      skills.create({ ...s, learned_from: `eval:${task.id}` });
    }
    const runtime = new SpecialistRuntime({
      specialists,
      llm: opts.llm,
      memory,
      tools,
      proposals: new ProposalsStore(db),
      inbox: new SpecialistInbox(db),
      skills,
    } as unknown as ConstructorParameters<typeof SpecialistRuntime>[0]);

    // Voice tasks replay the SPOKEN lean turn the message route runs for the
    // Satellite1 → Kate path: behavior from `voice_realtime`, endpoint from
    // `live` (NEVER voice_realtime's own retired :8089 base_url), the ~200
    // token cap, and `surface:'voice'` so the voice prompt mode engages. A
    // chat task leaves all of this unset → the normal screen-text turn.
    const voice_overrides = task.voice
      ? {
          surface: 'voice' as const,
          llm_role: 'voice_realtime' as const,
          provider_role: 'live' as const,
          max_tokens_override: 200,
        }
      : {};

    const out = await runtime.turn({
      specialist_id: task.specialist_id,
      conversation_id: `eval:${task.id}:${ulid()}`,
      message: { role: 'user', content: task.message },
      // Seed any prior turns so history-shaped regressions (a canned timeout
      // fallback or a stale self-denial) exercise the live filtering.
      conversation_history: (task.conversation_history ?? []).map((m) => ({
        role: m.role,
        content: m.content,
      })),
      user: { id: 'jasper', display_name: 'Jasper', tier: 'owner' },
      ...voice_overrides,
    });

    const calls = out.tool_calls_made.map((c) => ({
      name: c.name,
      errored: Boolean(c.error),
    }));
    const text = fold_quotes((out.message_text ?? '').toLowerCase());
    const problems: string[] = [];

    for (const t of task.assertions.must_call ?? []) {
      if (!calls.some((c) => c.name === t)) problems.push(`never called ${t}`);
    }
    for (const t of task.assertions.must_not_call ?? []) {
      if (calls.some((c) => c.name === t)) problems.push(`called ${t}, which it must not`);
    }
    for (const [t, n] of Object.entries(task.assertions.min_calls ?? {})) {
      const got = calls.filter((c) => c.name === t).length;
      if (got < n) problems.push(`${t} called ${got}x, expected >= ${n}`);
    }
    if (task.assertions.text_any && task.assertions.text_any.length > 0) {
      if (!task.assertions.text_any.some((m) => text.includes(fold_quotes(m.toLowerCase())))) {
        problems.push(
          `reply contains none of the expected markers (${task.assertions.text_any.slice(0, 5).join(' | ')}…)`,
        );
      }
    }
    for (const m of task.assertions.text_none ?? []) {
      if (text.includes(fold_quotes(m.toLowerCase()))) {
        problems.push(`reply contains forbidden "${m}"`);
      }
    }

    // arg-validity (F1) — each named tool was called AND at least one of its
    // calls produced no error, with NONE of its calls failing on the
    // arg-spiral shapes (INPUT_VALIDATION_FAILED / DUPLICATE_TOOL_CALL). A
    // tool the model called but could only ever fumble the args for fails
    // this gate even if it "tried." (An execute-time error is NOT an
    // arg-validity failure — the args were fine, the tool's work wasn't.)
    for (const t of task.assertions.args_valid ?? []) {
      const calls_of = out.tool_calls_made.filter((c) => c.name === t);
      if (calls_of.length === 0) {
        problems.push(`args_valid: ${t} was never called`);
        continue;
      }
      const any_clean = calls_of.some((c) => !c.error);
      const arg_spiraled = calls_of.some(
        (c) => c.error && /INPUT_VALIDATION_FAILED|DUPLICATE_TOOL_CALL/.test(String(c.error)),
      );
      if (!any_clean || arg_spiraled) {
        problems.push(`args_valid: ${t} args never validated (arg-spiral)`);
      }
    }

    // chaining (F2) — the named tools each appear and their FIRST occurrences
    // are in the given order (e.g. find_or_create_person → upsert_person_note,
    // so the id flows from step 1 into step 2). Catches the can't-chain class.
    const order = task.assertions.call_order;
    if (order && order.length > 1) {
      const first_idx = (n: string): number => out.tool_calls_made.findIndex((c) => c.name === n);
      let prev = -1;
      let missing: string | null = null;
      let broke = false;
      for (const n of order) {
        const idx = first_idx(n);
        if (idx === -1) {
          missing = n;
          break;
        }
        if (idx < prev) {
          broke = true;
          break;
        }
        prev = idx;
      }
      if (missing) problems.push(`call_order: ${missing} was never called`);
      else if (broke) problems.push(`call_order: tools not called in order [${order.join(' → ')}]`);
    }

    const reply_preview = (out.message_text ?? '').slice(0, 240);
    return {
      task_id: task.id,
      specialist_id: task.specialist_id,
      passed: problems.length === 0,
      // `problems` IS the ground truth about what "wrong" meant on this run —
      // deterministic assertion output, never the model's account of itself.
      trace: {
        failed_assertions: [...problems],
        reply: out.message_text ?? '',
        calls: to_trace_calls(out.tool_calls_made),
      },
      // On failure the detail carries the reply itself — the temp env is
      // gone by read time, so eval_runs.detail must be diagnosable alone
      // (is this a behavior gap or an assertion-marker gap?).
      detail:
        problems.length === 0
          ? 'all assertions held'
          : `${problems.join('; ')} || reply: "${reply_preview}"`,
      tool_calls: calls,
      reply_preview,
    };
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
}

/**
 * Record a result in the LIVE db and file a regression miss on a
 * pass→fail transition. Returns whether this run is a regression.
 */
export function record_eval_result(
  live_db: Database,
  result: EvalResult,
  model: string | null,
): { regression: boolean } {
  const prev = live_db
    .prepare(`SELECT passed FROM eval_runs WHERE task_id = ? ORDER BY ts DESC LIMIT 1`)
    .get(result.task_id) as { passed: number } | undefined;
  live_db
    .prepare(
      `INSERT INTO eval_runs (id, ts, task_id, specialist_id, passed, detail, model)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `ev_${ulid().toLowerCase().slice(-12)}`,
      new Date().toISOString(),
      result.task_id,
      result.specialist_id,
      result.passed ? 1 : 0,
      result.detail.slice(0, 1_000),
      model,
    );
  // Keep the WHY evidence for failures only (2026-08-03). Best-effort: a
  // trace-write failure must never cost us the eval_runs row that the delta
  // arbiter reads — the suite's own bookkeeping outranks the diagnosis input.
  if (!result.passed) {
    try {
      new EvalTracesStore(live_db).record({
        task_id: result.task_id,
        specialist_id: result.specialist_id,
        failed_assertions: result.trace.failed_assertions,
        reply: result.trace.reply,
        calls: result.trace.calls,
        model,
      });
    } catch (err) {
      console.error(`[evals] trace write failed for ${result.task_id}:`, err);
    }
  }
  const regression = prev?.passed === 1 && !result.passed;
  if (regression) {
    new ProcessMissStore(live_db).create({
      subject_specialist_id: result.specialist_id,
      reporter: 'orchestrator',
      task_summary: `golden eval '${result.task_id}' — a previously-passing behavior regressed`,
      gap:
        `behavioral regression: eval task '${result.task_id}' went PASS → FAIL. ` +
        `${result.detail}. Reply preview: "${result.reply_preview.slice(0, 160)}". ` +
        `Something that changed since the last green run (persona edit, prompt block, ` +
        `model/parser swap) broke this hard-won behavior — diff what shipped, fix the ` +
        `owning layer, and re-run the eval to close.`,
      severity: 'high',
      // Chokepoint-dedup'd: repeats annotate the same row; a re-regression
      // after a close REOPENS it.
      evidence_ref: `eval:${result.task_id}`,
    });
  }
  return { regression };
}

/** Run every golden task sequentially (the deep tier serializes anyway). */
export async function run_all_golden(opts: {
  tasks: readonly GoldenTask[];
  llm: LLMRouter;
  config_dir: string;
  live_db: Database;
  model_label?: string;
  /** Run each task this many times and aggregate. The model is stochastic, so
   *  a 1/1 pass is a coin flip, not a measurement — and the nightly history
   *  shows it: three tasks flipped pass↔fail on consecutive nights with no
   *  code change between them. A task counts as passed on a MAJORITY of
   *  samples (see the aggregation note below for why unanimity was wrong), and
   *  the recorded detail always leads with the pass-rate. Default 1. */
  samples?: number;
  log?: (line: string) => void;
}): Promise<{ results: EvalResult[]; regressions: number }> {
  const samples = Math.max(1, opts.samples ?? 1);
  const results: EvalResult[] = [];
  let regressions = 0;
  const run_once = async (task: GoldenTask): Promise<EvalResult> => {
    try {
      return await run_golden_task(task, { llm: opts.llm, config_dir: opts.config_dir });
    } catch (err) {
      return {
        task_id: task.id,
        specialist_id: task.specialist_id,
        passed: false,
        detail: `harness error: ${err instanceof Error ? err.message : String(err)}`,
        tool_calls: [],
        reply_preview: '',
        // A harness crash is an infrastructure failure, not a behavior one. It
        // still records a trace so the row is not a hole, but the assertion
        // list names the crash — the diagnoser must never read a broken temp
        // env as evidence that a persona misbehaved.
        trace: {
          failed_assertions: [`harness error: ${err instanceof Error ? err.message : String(err)}`],
          reply: '',
          calls: [],
        },
      };
    }
  };
  for (const task of opts.tasks) {
    opts.log?.(
      `[evals] running ${task.id} (${task.specialist_id})${samples > 1 ? ` ×${samples}` : ''}…`,
    );
    let passes = 0;
    // Keep the FIRST failing run for the diagnostic detail (a flake is most
    // legible from a failure); fall back to the last run when all pass.
    let representative: EvalResult | null = null;
    for (let s = 0; s < samples; s++) {
      const r = await run_once(task);
      if (r.passed) passes++;
      if (!representative || (representative.passed && !r.passed)) representative = r;
    }
    // MAJORITY, not unanimity (2026-08-05). Unanimity was the wrong
    // aggregation for a stochastic model, and it made sampling actively
    // counterproductive: a task that genuinely passes ~70% of the time reports
    // 70% at samples=1 but only ~34% under "all 3 must pass", so turning
    // sampling on would have made the suite REDDER while telling you less.
    //
    // The observed problem is real — over 2026-08-03..05, three tasks flipped
    // pass↔fail on consecutive nights with no code change between them, which
    // is wide enough noise to swamp any persona change you would actually want
    // to detect. Majority-of-N tightens that: the same 70% task reports ~78% at
    // N=3, and a task that truly broke still fails every sample.
    //
    // The pass-RATE stays in `detail` either way, so the raw evidence is never
    // lost to the aggregation — a 2/3 reads differently from a 3/3 even though
    // both are green, and that difference is exactly what tells you a task is
    // becoming flaky before it starts failing outright.
    const majority = passes * 2 > samples;
    const result: EvalResult =
      samples === 1
        ? representative!
        : {
            ...representative!,
            passed: majority,
            detail: `pass-rate ${passes}/${samples}${passes === samples ? '' : ` — ${representative!.detail}`}`,
          };
    const { regression } = record_eval_result(opts.live_db, result, opts.model_label ?? null);
    if (regression) regressions++;
    opts.log?.(
      `[evals] ${task.id}: ${result.passed ? 'PASS' : `FAIL — ${result.detail}`}${regression ? ' (REGRESSION — miss filed)' : ''}`,
    );
    results.push(result);
  }
  return { results, regressions };
}
