/**
 * smoke:data-denial — the data-denial guard ("query before you say it's
 * not there", 2026-06-12), self-contained.
 *
 * Part A drives the module's pure surface (src/core/data_denial.ts) with a
 * mock judge: the candidate-extraction matrix (denial shapes in, noise and
 * questions out), the judge wiring (mapping back to OUR candidates only,
 * tool-hint sanitization, fence-stripping), every fail-open path, the
 * retry-nudge contract, and the data-map prompt section.
 *
 * Part B proves the END-TO-END wiring through the REAL eval harness: a
 * scripted "denier" model replays the Astrid no-HR incident against the
 * `astrid-ride-hr-exists-no-false-denial` golden task. With the guard ON,
 * the denial triggers the judge → nudge → the model queries → grounded
 * answer → the task PASSES. With HEARTH_DATA_DENIAL_GUARD=0 the identical
 * script ships the denial unchallenged and the task FAILS — the guard is
 * the difference-maker, which is exactly the regression the nightly gate
 * now watches.
 */
// NOT HEARTH_TEST_MODE: the guard (like the eval harness) exists to run
// REAL turns; TEST_MODE would short-circuit them with canned replies.
process.env.HEARTH_FACT_CRITIC = '0';
process.env.HEARTH_RAG_VECTOR = '0';

import { resolve } from 'node:path';
import { load_extra_capabilities } from '../src/core/capabilities';
import type { LLMRequest, LLMRouter, LLMResponse, RoleResolution } from '../src/core/llm';
import {
  extract_denial_candidates,
  assess_data_denial,
  data_denial_retry_nudge,
  render_data_map_section,
} from '../src/core/data_denial';
import { GOLDEN_TASKS } from '../src/core/evals/golden_tasks';
import { run_golden_task } from '../src/core/evals/harness';

let checks = 0;
function check(name: string, ok: boolean): void {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) process.exitCode = 1;
}

/** Mock router whose single provider returns `fn(req)` (or throws). */
function judge_router(fn: (req: LLMRequest) => string): {
  router: LLMRouter;
  calls: () => number;
} {
  let n = 0;
  const resolution: RoleResolution = {
    provider: {
      name: 'mock-judge',
      complete: async (req: LLMRequest): Promise<LLMResponse> => {
        n++;
        return {
          content: fn(req),
          tool_calls: [],
          finish_reason: 'stop',
          cost: { tokens_in: 0, tokens_out: 0, ms: 0, model: 'mock' },
        };
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
  return { router: { for_role: () => resolution } as LLMRouter, calls: () => n };
}

/** Scripted multi-role router for the harness runs (smoke-evals idiom). */
function scripted_router(script: Array<Partial<LLMResponse>>): LLMRouter {
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
      complete: async () => next(),
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
  return { for_role: () => resolution } as LLMRouter;
}

const READ_TOOLS = [
  { name: 'get_health_summary', description: 'Read HealthKit aggregates over a window.' },
  { name: 'get_workout_state', description: 'Live workout session state.' },
  { name: 'search_library', description: 'Search the vault library.' },
];

async function part_a(): Promise<void> {
  // ── extraction matrix ──────────────────────────────────────────────────
  const positives = [
    'Your ride this morning only logged distance and duration — no heart rate, no calories.',
    'Nothing was recorded for yesterday.',
    "The HR data didn't come through from the Watch.",
    "There's no record of that upload.",
    "I don't see any data for last week.",
    "Your sleep numbers aren't showing up for Tuesday.",
    // Live-shakeout shapes (2026-06-12): CURLY apostrophes (U+2019, what
    // the live model actually emits) + the possession-of-recorded-data
    // denial that names a domain noun no DATA_NOUN list can enumerate.
    'Jasper, fair question, but I don’t have the Dell entry tower base-unit teardowns recorded yet — so the comparison is off.',
    'I can’t see any data for that ride.',
  ];
  for (const p of positives) {
    check(`extracts: "${p.slice(0, 48)}…"`, extract_denial_candidates(p).length >= 1);
  }
  const negatives = [
    'No worries — take your time.',
    'Did the data not sync?',
    'Great ride! Your average HR was 142 and you burned 386 kcal.',
    '',
  ];
  for (const n of negatives) {
    check(
      `ignores: "${(n || '(empty)').slice(0, 48)}"`,
      extract_denial_candidates(n).length === 0,
    );
  }
  const many = Array.from({ length: 9 }, (_, i) => `Day ${i} has no data recorded.`).join(' ');
  check('candidate cap holds at 6', extract_denial_candidates(many).length === 6);

  // ── assess: pre-filter skip (no judge on the happy path) ───────────────
  const happy = judge_router(() => '{"flagged": []}');
  const r1 = await assess_data_denial({
    reply: 'All good — avg HR 142, 386 kcal burned. Nice work.',
    tool_calls: [],
    read_tools: READ_TOOLS,
    llm: happy.router,
  });
  check('clean reply: judge never invoked', r1.checked === false && happy.calls() === 0);

  // ── assess: zero reads → judge flags → defensive mapping ──────────────
  const denial =
    'Your ride only logged distance and duration — no heart rate, no calories. ' +
    'The Watch may have had a sensor issue.';
  const cand = extract_denial_candidates(denial)[0]!;
  const flagging = judge_router(() =>
    JSON.stringify({
      flagged: [
        { claim: cand, tool_hint: 'get_health_summary', reason: 'never queried' },
        { claim: 'the moon data is gone', tool_hint: 'get_health_summary', reason: 'invented' },
      ],
    }),
  );
  const r2 = await assess_data_denial({
    reply: denial,
    tool_calls: [],
    read_tools: READ_TOOLS,
    llm: flagging.router,
  });
  check('zero-read denial: judge ran once', r2.checked === true && flagging.calls() === 1);
  check('valid finding mapped back verbatim', r2.unverified.length === 1 && r2.unverified[0]!.claim === cand);
  check('judge-invented claim dropped', !r2.unverified.some((f) => /moon/.test(f.claim)));
  check('tool hint preserved when real', r2.unverified[0]!.tool_hint === 'get_health_summary');

  // bogus tool hint sanitized to ''
  const bogus_hint = judge_router(() =>
    JSON.stringify({ flagged: [{ claim: cand, tool_hint: 'warp_drive', reason: 'x' }] }),
  );
  const r3 = await assess_data_denial({
    reply: denial,
    tool_calls: [],
    read_tools: READ_TOOLS,
    llm: bogus_hint.router,
  });
  check('bogus tool hint sanitized', r3.unverified.length === 1 && r3.unverified[0]!.tool_hint === '');

  // fenced JSON still parses
  const fenced = judge_router(
    () =>
      '```json\n' +
      JSON.stringify({ flagged: [{ claim: cand, tool_hint: '', reason: 'y' }] }) +
      '\n```',
  );
  const r4 = await assess_data_denial({
    reply: denial,
    tool_calls: [],
    read_tools: READ_TOOLS,
    llm: fenced.router,
  });
  check('fenced judge JSON parsed', r4.unverified.length === 1);

  // ── fail-open paths ────────────────────────────────────────────────────
  const thrower = judge_router(() => {
    throw new Error('judge down');
  });
  const r5 = await assess_data_denial({
    reply: denial,
    tool_calls: [],
    read_tools: READ_TOOLS,
    llm: thrower.router,
  });
  check('judge error fails OPEN', r5.checked === true && r5.unverified.length === 0);

  const garbage = judge_router(() => 'hmm, probably fine I guess?');
  const r6 = await assess_data_denial({
    reply: denial,
    tool_calls: [],
    read_tools: READ_TOOLS,
    llm: garbage.router,
  });
  check('unparseable judge fails OPEN', r6.checked === true && r6.unverified.length === 0);

  const no_reads = judge_router(() => '{"flagged": []}');
  const r7 = await assess_data_denial({
    reply: denial,
    tool_calls: [],
    read_tools: [],
    llm: no_reads.router,
  });
  check('no read tools on surface → skip', r7.checked === false && no_reads.calls() === 0);

  const r8 = await assess_data_denial({
    reply: denial,
    tool_calls: [],
    read_tools: READ_TOOLS,
    llm: undefined,
  });
  check('absent router → skip (fail-open)', r8.checked === false && r8.unverified.length === 0);

  // ── nudge contract ─────────────────────────────────────────────────────
  const nudge = data_denial_retry_nudge(
    [{ claim: cand, tool_hint: 'get_health_summary', reason: 'never queried' }],
    READ_TOOLS,
  );
  check('nudge carries the guard banner', nudge.startsWith('[DATA-DENIAL GUARD'));
  check('nudge names the claim', nudge.includes(cand));
  check('nudge names the tool hint', nudge.includes('`get_health_summary`'));
  check('nudge is a one-retry contract', /one retry/i.test(nudge));
  check('nudge forbids meta-narration', /do NOT apologize/i.test(nudge));

  // ── data-map prompt section ────────────────────────────────────────────
  const map = render_data_map_section(READ_TOOLS);
  check(
    'data map names the read tools',
    map.includes('`get_health_summary`') && map.includes('`search_library`'),
  );
  check('data map is the look-first contract', /look before you say/i.test(map));
  check('data map empty when no read tools', render_data_map_section([]) === '');
  const big = Array.from({ length: 30 }, (_, i) => ({ name: `tool_${i}` }));
  const capped = render_data_map_section(big);
  check(
    'data map caps at 24 names',
    capped.includes('`tool_23`') && !capped.includes('`tool_24`'),
  );
}

async function part_b(): Promise<void> {
  load_extra_capabilities(resolve(__dirname, '..', 'config', 'capabilities.yaml'));
  const config_dir = resolve(__dirname, '..', 'config', 'specialists');
  const task = GOLDEN_TASKS.find((t) => t.id === 'astrid-ride-hr-exists-no-false-denial');
  check('astrid golden task present', Boolean(task));
  if (!task) return;

  const denial_reply =
    'Looks like your ride this morning only logged distance and duration — no heart rate, no calories. ' +
    'The Watch may have had a sensor issue.';
  const cand = extract_denial_candidates(denial_reply)[0]!;
  check('denier reply yields a candidate', Boolean(cand));

  // The script serves BOTH roles in call order: (1) the specialist's denial,
  // (2) the planner judge's verdict, (3) the corrected specialist round that
  // actually queries, (4) the grounded final reply.
  const denier_script: Array<Partial<LLMResponse>> = [
    { content: denial_reply },
    {
      content: JSON.stringify({
        flagged: [{ claim: cand, tool_hint: 'get_health_summary', reason: 'no query this turn' }],
      }),
    },
    {
      tool_calls: [{ id: 't1', name: 'get_health_summary', arguments: { window: '7d' } }],
    },
    {
      content:
        'Strong ride this morning! 47 minutes, 14.8 km — average heart rate 142 bpm ' +
        '(max 167), and you burned 386 active calories. The Watch caught all of it.',
    },
  ];

  delete process.env.HEARTH_DATA_DENIAL_GUARD;
  const guarded = await run_golden_task(task, {
    llm: scripted_router(denier_script),
    config_dir,
  });
  check(
    'guard ON: denier model is caught, queries, task PASSES',
    guarded.passed === true,
  );
  check(
    'guard ON: the health read actually ran',
    guarded.tool_calls.some((c) => c.name === 'get_health_summary'),
  );

  process.env.HEARTH_DATA_DENIAL_GUARD = '0';
  const unguarded = await run_golden_task(task, {
    llm: scripted_router(denier_script),
    config_dir,
  });
  delete process.env.HEARTH_DATA_DENIAL_GUARD;
  check(
    'guard OFF (kill switch): same denier ships the denial, task FAILS',
    unguarded.passed === false,
  );
  check(
    'guard OFF: no read ever ran',
    !unguarded.tool_calls.some((c) => c.name === 'get_health_summary'),
  );
}

async function main(): Promise<void> {
  await part_a();
  await part_b();
  if (process.exitCode === 1) {
    console.log('\nsmoke:data-denial FAILED');
    process.exit(1);
  }
  console.log(`\n✓ smoke:data-denial — ${checks} checks passed`);
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  process.exit(1);
});
