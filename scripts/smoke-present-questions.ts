export {};
/**
 * Smoke test for the `present_questions` tool + answer-resume HTTP path.
 *
 * Self-contained: stands up its own temp vault, SQLite, memory client,
 * specialists registry, tool registry, runtime, conversation store, and
 * AppEventBus, then exercises the full round-trip:
 *
 *   1. Tool factory wires into ToolRegistry.
 *   2. Conversation-attached invoke → row persisted, SSE fired,
 *      GET /api/conversations/:id/pending-questions returns it.
 *   3. POST /api/present-questions/:id/answer → resume turn fires
 *      (test-mode canned reply), specialist message lands in the conv.
 *   4. Deliberation-attached invoke → row stored with conversation_id
 *      and brief_id BOTH null; the deliberation_pass-style post-patch
 *      UPDATE attaches brief_id; list_for_brief surfaces the row.
 *   5. Tool schema validates the {intro, questions: [...]} shape and
 *      rejects malformed input (zero questions, too many options).
 *
 * the LLM host check (#5 of the acceptance criteria) is gated on
 * HEARTH_PQ_SMOKE_HIT_GLACIER=1 because the LLM host may not be reachable
 * from every dev environment; the rest of the smoke runs without it.
 * Run via `bun run smoke:present-questions`.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { SpecialistRegistry } from '@core/specialist';
import { SpecialistRuntime } from '@core/specialist_runtime';
import { ToolRegistry } from '@core/tool_registry';
import { ProposalsStore } from '@core/proposals';
import { ProcessMissStore } from '@core/process_misses';
import { ConversationStore, InterruptStore, SpecialistInbox } from '@memory/stores/conversations';
import { ConfigLLMRouter } from '@core/router';
import { LibraryStore } from '@library/store';
import { load_extra_capabilities } from '@core/capabilities';
import { AppEventBus, type AppEvent } from '@app/events';
import { PendingQuestionsStore } from '@memory/stores/pending_questions';
import { create as create_present_questions } from '../src/tools/present_questions';
import { create_specialists_router } from '@app/routes/specialists';
import { create_briefs_router } from '@app/routes/briefs';

process.env.HEARTH_TEST_MODE = '1';
process.env.HEARTH_DISABLE_LOOPS = '1';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

interface ApiResp<T = unknown> {
  status: number;
  body: T;
}

async function call(router: Hono, method: string, path: string, body?: unknown): Promise<ApiResp> {
  const req = new Request(`http://test.local${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await router.fetch(req);
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep as text */
  }
  return { status: res.status, body: parsed };
}

function setup() {
  const root = mkdtempSync(resolve(tmpdir(), 'hearth-pq-smoke-'));
  const vault = resolve(root, 'vault');
  mkdirSync(vault, { recursive: true });
  const db_path = resolve(root, 'hearth.db');
  const db = open_db(db_path);
  const memory = new MemoryClient({ vault_root: vault, db });

  // Specialist registry needs Kate's YAML (and any peer she might
  // consult). Copy the seed configs into a temp dir.
  const specialists_dir = resolve(root, 'specialists');
  mkdirSync(specialists_dir, { recursive: true });
  const seed_dir = resolve(import.meta.dir, '..', 'config', 'specialists');
  for (const id of ['kate', 'eleanor']) {
    const src = resolve(seed_dir, `${id}.yaml`);
    if (existsSync(src)) {
      writeFileSync(
        resolve(specialists_dir, `${id}.yaml`),
        readFileSync(src, 'utf8'),
        'utf8',
      );
    }
  }
  // Config-extended capability tokens load before the registry compiles
  // its grants (parses every YAML file).
  load_extra_capabilities(resolve(import.meta.dir, '..', 'config', 'capabilities.yaml'));

  const specialists = new SpecialistRegistry(specialists_dir);

  const proposals = new ProposalsStore(db);
  const interrupts = new InterruptStore(db);
  const conversations = new ConversationStore(db);
  const inbox = new SpecialistInbox(db);
  const process_misses = new ProcessMissStore(db);
  const tool_registry = new ToolRegistry();
  const events = new AppEventBus();

  // The LLM router is required by the runtime; in TEST_MODE the runtime
  // never reaches it (canned_turn produces a deterministic reply).
  const roles_path = resolve(root, 'roles.yaml');
  writeFileSync(
    roles_path,
    `roles:\n  specialist:\n    provider: ollama\n    model: test\n    temperature: 0.7\n`,
    'utf8',
  );
  const llm = new ConfigLLMRouter(roles_path, {
    ollama_base_url: 'http://localhost:11434',
  });

  const library_root = resolve(root, 'library');
  mkdirSync(library_root, { recursive: true });
  const library = new LibraryStore({ root: library_root, db });

  const runtime = new SpecialistRuntime({
    specialists,
    llm,
    memory,
    tools: tool_registry,
    proposals,
    inbox,
    events,
  });

  const pq_tool = create_present_questions({
    db,
    vault_root: vault,
    memory,
    llm,
    proposals,
    inbox,
    interrupts,
    conversations,
    specialists,
    runtime,
    events,
    process_misses,
    tool_registry,
    library,
  });
  tool_registry.register(pq_tool);

  // Router exercises the same HTTP surface the orchestrator mounts.
  const router = new Hono({ strict: false });
  router.route(
    '/api',
    create_specialists_router({
      db,
      memory,
      specialists,
      runtime,
      proposals,
      conversations,
      interrupts,
      inbox,
      tools: tool_registry,
      llm,
      events,
    }),
  );
  // The briefs router filters every query by the session user (c.get('user').id),
  // set by the orchestrator's auth middleware in production. This smoke has no
  // auth layer, so stand in a test owner for the briefs surface only (the
  // specialists router already tolerates an absent user → '*').
  router.use('/api/briefs/*', async (c, next) => {
    // The briefs router only reads user.id; cast the minimal stub past the full
    // UserConfig shape the Hono context variable is typed to.
    c.set('user', { id: 'jasper', tier: 'owner', allowed_specialists: '*' } as never);
    await next();
  });
  router.route('/api/briefs', create_briefs_router({ db }));

  return {
    root,
    db,
    memory,
    specialists,
    runtime,
    tool_registry,
    conversations,
    events,
    pq_tool,
    router,
  };
}

async function main(): Promise<void> {
  const ctx = setup();
  let pass = 0;

  const seen_events: AppEvent[] = [];
  ctx.events.subscribe((e) => seen_events.push(e));

  try {
    // ── 1. Tool factory wires up cleanly ────────────────────────────────
    console.log('→ Tool registered + visible to Kate');
    const kate = ctx.specialists.get('kate');
    assert(kate, 'Kate must be present in the registry');
    const visible = ctx.tool_registry.list_for_capabilities(kate!.granted);
    assert(
      visible.some((t) => t.name === 'present_questions'),
      'present_questions must appear in Kate\'s capability-filtered tool list (it has no required_capabilities)',
    );
    pass++;

    // ── 2. Conversation-attached invoke + GET + answer ──────────────────
    console.log('→ Conversation-attached invoke');
    const conv = ctx.conversations.create('kate');
    const conv_id = conv.id;
    // Seed a specialist reply so the resume turn has something to anchor on.
    ctx.conversations.append_message({
      conversation_id: conv_id,
      role: 'specialist',
      specialist_id: 'kate',
      content_md: 'Two small decisions below — pick when you have a second.',
    });

    const tool_ctx = {
      memory: ctx.memory,
      llm: (ctx.runtime as unknown as { deps: { llm: unknown } }).deps.llm as never,
      now: new Date(),
      intent_id: 'test-intent-1',
      conversation_id: conv_id,
      specialist_id: 'kate',
    };
    const tool_result = await ctx.pq_tool.execute(
      {
        intro: 'Two small calls before the morning brief settles —',
        questions: [
          {
            id: 'water_yard',
            text: 'Water the front yard before tonight\'s storm?',
            options: [
              { value: 'water_now', label: 'Water tonight' },
              { value: 'skip', label: 'Let the storm do it' },
              { value: 'eleanor_decides', label: 'Defer to Eleanor', description: 'She\'s tracking soil moisture' },
            ],
          },
          {
            id: 'lunch_window',
            text: 'Where do you want the lunch slot?',
            multi_select: false,
            options: [
              { value: 'noon', label: '12:00' },
              { value: 'one', label: '13:00' },
            ],
          },
        ],
      },
      tool_ctx,
    );

    assert(tool_result.status === 'pending', 'tool result must be status=pending');
    assert(tool_result.conversation_id === conv_id, 'conversation_id should flow through ctx');
    assert(tool_result.brief_id === null, 'brief_id should be null on chat-turn invoke');
    assert(
      seen_events.some(
        (e) => e.type === 'questions_presented' && e.question_set_id === tool_result.question_set_id,
      ),
      'questions_presented SSE event must fire',
    );
    pass++;

    console.log('→ Output schema accepts execute() result');
    const output_check = ctx.pq_tool.output_schema.safeParse(tool_result);
    assert(output_check.success, `output schema rejected execute() result: ${output_check.success ? '' : output_check.error.message}`);
    pass++;

    console.log('→ GET /api/conversations/:id/pending-questions');
    const get_pending = await call(ctx.router, 'GET', `/api/conversations/${conv_id}/pending-questions`);
    assert(get_pending.status === 200, `GET pending failed: ${get_pending.status} ${JSON.stringify(get_pending.body)}`);
    const get_pending_body = get_pending.body as { pending_questions: Array<{ id: string; intro_md: string | null; questions: unknown[]; status: string }> };
    assert(get_pending_body.pending_questions.length === 1, 'should have exactly one pending question set');
    assert(get_pending_body.pending_questions[0]!.id === tool_result.question_set_id, 'id should round-trip');
    assert(get_pending_body.pending_questions[0]!.status === 'pending', 'status should be pending');
    assert(get_pending_body.pending_questions[0]!.questions.length === 2, 'questions should round-trip');
    pass++;

    console.log('→ POST /api/present-questions/:id/answer fires resume turn');
    const answer_resp = await call(
      ctx.router,
      'POST',
      `/api/present-questions/${tool_result.question_set_id}/answer`,
      { answers: { water_yard: 'water_now', lunch_window: 'I really want noon-ish.' } },
    );
    assert(answer_resp.status === 200, `answer route failed: ${answer_resp.status} ${JSON.stringify(answer_resp.body)}`);
    const answer_body = answer_resp.body as {
      ok: boolean;
      question_set_id: string;
      conversation_id: string;
      resume: { user_message_id: string; specialist_message_id: string };
    };
    assert(answer_body.ok === true, 'answer body must include ok: true');
    assert(answer_body.conversation_id === conv_id, 'resume turn should land in the original conversation');
    assert(answer_body.resume.user_message_id, 'user message must be persisted on resume');
    assert(answer_body.resume.specialist_message_id, 'specialist message must be persisted on resume');
    assert(
      seen_events.some(
        (e) => e.type === 'questions_answered' && e.question_set_id === tool_result.question_set_id,
      ),
      'questions_answered SSE event must fire',
    );

    // The set should now show as answered.
    const after_pending = await call(ctx.router, 'GET', `/api/conversations/${conv_id}/pending-questions`);
    const after_body = after_pending.body as { pending_questions: unknown[] };
    assert(after_body.pending_questions.length === 0, 'no pending questions after answer');
    const get_one = await call(ctx.router, 'GET', `/api/present-questions/${tool_result.question_set_id}`);
    const get_one_body = get_one.body as { status: string; answers: Record<string, unknown> | null };
    assert(get_one_body.status === 'answered', 'individual fetch should show status=answered');
    assert(
      get_one_body.answers && get_one_body.answers.water_yard === 'water_now',
      'persisted answers must match what we POSTed',
    );
    pass++;

    console.log('→ Double-answer is rejected with 409');
    const second_answer = await call(
      ctx.router,
      'POST',
      `/api/present-questions/${tool_result.question_set_id}/answer`,
      { answers: { water_yard: 'skip' } },
    );
    assert(second_answer.status === 409, `expected 409 on double-answer, got ${second_answer.status}`);
    pass++;

    // ── 3. Deliberation-attached invoke + brief patch ───────────────────
    console.log('→ Deliberation-attached invoke (synthetic conv id)');
    const delib_result = await ctx.pq_tool.execute(
      {
        questions: [
          {
            id: 'storm_priority',
            text: 'How tightly should I track tonight\'s storm window?',
            options: [
              { value: 'hourly', label: 'Hourly pings until landfall' },
              { value: 'one_shot', label: 'One forecast at 6pm' },
            ],
            multi_select: false,
          },
        ],
      },
      {
        ...tool_ctx,
        intent_id: 'test-intent-delib',
        conversation_id: 'deliberation:kate:07:00',
      },
    );
    assert(delib_result.conversation_id === null, 'deliberation invoke must null conversation_id');
    assert(delib_result.brief_id === null, 'deliberation invoke leaves brief_id null pre-patch');

    // Simulate what deliberation_pass does after the brief is persisted.
    const brief_id = 'brf_test_001';
    ctx.db.prepare(
      `INSERT INTO briefs (id, ts_generated, generated_by_specialist_id, kind, sections_json, mood, user_id)
       VALUES (@id, @ts, 'kate', 'morning', @sec, 'calm', 'jasper')`,
    ).run({
      '@id': brief_id,
      '@ts': new Date().toISOString(),
      '@sec': JSON.stringify({
        noticed: 'Quiet morning.',
        attention_today: [],
        ready_for_review: [],
        watching: 'Storm window.',
      }),
    });
    ctx.db
      .prepare(
        `UPDATE pending_questions
            SET brief_id = @bid
          WHERE specialist_id = 'kate' AND brief_id IS NULL AND conversation_id IS NULL
            AND id = @qid`,
      )
      .run({ '@bid': brief_id, '@qid': delib_result.question_set_id });

    const store = new PendingQuestionsStore(ctx.db);
    const for_brief = store.list_for_brief(brief_id);
    assert(for_brief.length === 1, 'brief patch should attach exactly one question set');
    assert(for_brief[0]!.id === delib_result.question_set_id, 'attached set must match');
    pass++;

    console.log('→ /api/briefs/latest surfaces pending_question_sets');
    const briefs_latest = await call(ctx.router, 'GET', '/api/briefs/latest');
    const briefs_body = briefs_latest.body as { brief: { id: string; pending_question_sets: Array<{ id: string; status: string }> } | null };
    assert(briefs_body.brief, 'latest brief must come back');
    assert(briefs_body.brief!.id === brief_id, 'latest brief id should match what we inserted');
    assert(
      briefs_body.brief!.pending_question_sets.some((s) => s.id === delib_result.question_set_id),
      'brief response must surface the attached question set',
    );
    pass++;

    console.log('→ Brief-attached answer falls back to a fresh conv');
    const brief_answer = await call(
      ctx.router,
      'POST',
      `/api/present-questions/${delib_result.question_set_id}/answer`,
      { answers: { storm_priority: 'one_shot' } },
    );
    assert(brief_answer.status === 200, `brief answer route failed: ${brief_answer.status} ${JSON.stringify(brief_answer.body)}`);
    const brief_answer_body = brief_answer.body as {
      ok: boolean;
      conversation_id: string;
      resume: { specialist_message_id: string };
    };
    assert(brief_answer_body.ok, 'brief answer must succeed');
    assert(brief_answer_body.conversation_id, 'brief answer must select a conversation');
    pass++;

    // ── 3b. Consult sub-turn is refused — "Relay through Kate" ──────────
    // A form raised inside a consult_specialist sub-turn runs against an
    // ephemeral `consult:<ulid>` conversation the user never sees; persisting
    // it would orphan (its conversation_id can't match the user's chat). The
    // tool refuses with an actionable message so the consultee returns its
    // options to the consultor, who asks the user on the user-facing turn.
    console.log('→ Consult-attached invoke is refused (no orphaned row)');
    let consult_threw = false;
    try {
      await ctx.pq_tool.execute(
        {
          questions: [
            { id: 'x', text: 'pick', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
          ],
        },
        { ...tool_ctx, intent_id: 'test-intent-consult', conversation_id: 'consult:01testconsultulid00' },
      );
    } catch (e) {
      consult_threw = true;
      assert(/consult/i.test(String((e as Error).message)), 'consult refusal message must mention the consult');
    }
    assert(consult_threw, 'present_questions must refuse a consult sub-turn (Relay through Kate)');
    const consult_rows = ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM pending_questions WHERE conversation_id LIKE 'consult:%'`)
      .get() as { n: number };
    assert(consult_rows.n === 0, 'no pending_questions row should be persisted for a consult sub-turn');
    // And no SSE fired for the refused call.
    assert(
      !seen_events.some((e) => e.type === 'questions_presented' && (e as { conversation_id?: string | null }).conversation_id === 'consult:01testconsultulid00'),
      'no questions_presented SSE should fire for a refused consult invoke',
    );
    pass++;

    // ── 4. Input-schema discipline ──────────────────────────────────────
    console.log('→ Input schema rejects zero questions');
    const empty = ctx.pq_tool.input_schema.safeParse({ questions: [] });
    assert(!empty.success, 'empty questions[] must fail validation');
    console.log('→ Input schema rejects 5 options');
    const too_many = ctx.pq_tool.input_schema.safeParse({
      questions: [
        {
          id: 'x',
          text: 'pick one',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
            { value: 'c', label: 'C' },
            { value: 'd', label: 'D' },
            { value: 'e', label: 'E' },
          ],
        },
      ],
    });
    assert(!too_many.success, 'more than 4 options must fail validation');
    pass++;

    // ── 5. the LLM host schema parse check (optional) ────────────────────────
    if (process.env.HEARTH_PQ_SMOKE_HIT_GLACIER === '1') {
      console.log('→ the LLM host chat-completions accepts tool schema (HEARTH_PQ_SMOKE_HIT_GLACIER=1)');
      const ok = await glacier_schema_check(ctx.pq_tool);
      assert(ok, 'the LLM host rejected the present_questions tool schema');
      pass++;
    } else {
      console.log('  (skipping the LLM host reachability check — set HEARTH_PQ_SMOKE_HIT_GLACIER=1 to enable)');
    }

    console.log(`\nAll ${pass} present_questions smoke checks passed.`);
  } finally {
    try {
      ctx.db.close();
    } catch {
      /* ignore */
    }
    rmSync(ctx.root, { recursive: true, force: true });
  }
}

/**
 * Direct chat-completions call against the the LLM host endpoint to confirm
 * the tool's JSON-Schema compiles cleanly through llama.cpp's GBNF
 * tool-call path. We don't care about the reply content — we care that
 * the server returns a 200 without a grammar-parse error. The check is
 * opt-in so devs without LAN access to the LLM host can still run the smoke.
 */
async function glacier_schema_check(pq_tool: {
  name: string;
  description: string;
  input_schema: import('zod').ZodType;
}): Promise<boolean> {
  const { zodToJsonSchema } = await import('zod-to-json-schema');
  const parameters = zodToJsonSchema(pq_tool.input_schema, {
    $refStrategy: 'none',
  }) as Record<string, unknown>;
  delete parameters.$schema;

  const endpoint =
    process.env.GLACIER_LLM_URL ??
    process.env.OPENAI_BASE_URL ??
    'http://<your-llm-host-ip>:8088/v1';
  const url = endpoint.replace(/\/$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.GLACIER_MODEL ?? 'qwen3.6-27b',
      messages: [
        {
          role: 'user',
          content:
            "Don't actually call any tool — just acknowledge you saw the tool definition. Reply 'ack' and stop.",
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: pq_tool.name,
            description: pq_tool.description,
            parameters,
          },
        },
      ],
      max_tokens: 16,
      temperature: 0.1,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`the LLM host returned ${res.status}: ${body.slice(0, 400)}`);
  }
  const reply = (await res.json()) as { error?: unknown };
  if (reply.error) {
    throw new Error(`the LLM host error envelope: ${JSON.stringify(reply.error).slice(0, 400)}`);
  }
  return true;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
