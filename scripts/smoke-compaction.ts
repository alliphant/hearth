/**
 * Smoke for tool-output compression Phase 1.
 *
 * Exercises `compact_tool_result` + `resolve_tool_budget` +
 * `project_tool_result_for_llm` without spinning up the orchestrator
 * or hitting any LLM. Purely a pure-function test surface so
 * regressions in the truncator (default cap, head preservation,
 * high-signal line retention, truncation marker, 'full' opt-out, per-
 * tool numeric override) are caught fast.
 *
 *   bun run smoke:compaction
 */

import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import {
  TOOL_RESULT_DEFAULT_BUDGET,
  TOOL_CONTEXT_BUDGET_FRACTION,
  TOOL_CONTEXT_CHARS_PER_TOKEN,
  compact_tool_result,
  project_tool_result_for_llm,
  resolve_tool_budget,
  enforce_cumulative_tool_budget,
  enforce_prompt_window,
  estimate_prompt_tokens,
  prompt_window_slack_for,
  tool_budget_chars_for_window,
} from '@core/tool_result_compaction';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assert: ${message}`);
}

function assert_eq<T>(label: string, actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(
      `assert ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function make_tool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'fake',
    description: 'fake tool for tests',
    risk: 'read',
    input_schema: z.object({}),
    output_schema: z.object({}),
    idempotency_key: () => 'fake',
    execute: async (_input: unknown, _ctx: ToolContext) => ({}),
    ...overrides,
  };
}

async function main(): Promise<void> {
  // 1. Below-budget passthrough — no truncation, no marker.
  {
    const small = 'hello world';
    const out = compact_tool_result(small, 100);
    assert_eq('passthrough', out, small);
    assert(!out.includes('[...truncated'), 'no marker on passthrough');
  }

  // 2. Over-budget: head preserved verbatim.
  {
    const head = 'TITLE: South-Arcade announces fall tour\nURL: https://example.com/post\n';
    const filler =
      'lorem ipsum '.repeat(2000) + 'and additional boring content '.repeat(800);
    const big = head + filler;
    const out = compact_tool_result(big, 2000);
    assert(
      out.startsWith('TITLE: South-Arcade announces fall tour\nURL: https://example.com/post'),
      'head preserved verbatim',
    );
    assert(out.includes('[...truncated'), 'marker appended');
    assert(out.length <= 2000, `compact length ${out.length} <= 2000`);
  }

  // 3. High-signal lines retained from the body.
  {
    const head =
      'TITLE: Fall tour dates\nURL: https://example.com/tour\n' +
      'nav: home | about | contact\n'.repeat(20);
    const filler = 'cookie banner ipsum '.repeat(150);
    const signal_lines = [
      'October 14 2026 — Midtown Theatre, Pleasantville, $35 tickets on sale',
      'November 02 2026 — Mission Ballroom, Denver, $48 presale Friday',
      'December 09 2026 — Ogden Theatre, Denver, sold out',
    ];
    const big =
      head +
      filler +
      '\n' +
      signal_lines.join('\n') +
      '\n' +
      'footer chrome — all rights reserved — privacy — terms\n'.repeat(40);

    const out = compact_tool_result(big, 2200);
    for (const line of signal_lines) {
      assert(
        out.includes(line),
        `high-signal line retained: "${line.slice(0, 40)}…"`,
      );
    }
    // Low-signal filler ("cookie banner ipsum ") has no year, no month,
    // no time, no money, no event keyword — it must NOT be retained
    // through the tail scan. (A partial occurrence at the head/tail
    // boundary is fine; what we're catching is the truncator failing
    // to discriminate and keeping the whole filler block.)
    const cookie_count = (out.match(/cookie banner ipsum/g) ?? []).length;
    assert(
      cookie_count <= 2,
      `low-signal filler dropped (saw ${cookie_count} occurrences, expected ≤2 from head)`,
    );
    // Likewise the footer (low-signal repeated copyright) shouldn't dominate.
    const footer_count = (out.match(/footer chrome/g) ?? []).length;
    assert(
      footer_count <= 2,
      `low-signal footer dropped (saw ${footer_count})`,
    );
    assert(out.includes('[...truncated'), 'marker present');
    assert(out.length <= 2200, `total length ${out.length} <= 2200`);
  }

  // 4. Truncation marker quotes the elided char count.
  {
    const big = 'x'.repeat(20_000);
    const out = compact_tool_result(big, 2000);
    const match = out.match(/\[\.\.\.truncated (\d+) chars/);
    assert(match !== null, 'marker quotes char count');
    const reported = parseInt(match![1]!, 10);
    assert(reported > 10_000, `reported ${reported} should reflect ~18k elided`);
  }

  // 5. resolve_tool_budget — defaults, numbers, 'full'.
  assert_eq('default budget', resolve_tool_budget(undefined), TOOL_RESULT_DEFAULT_BUDGET);
  assert_eq('default for tool with no llm_budget', resolve_tool_budget(make_tool()), TOOL_RESULT_DEFAULT_BUDGET);
  assert_eq('numeric override', resolve_tool_budget(make_tool({ llm_budget: 1500 })), 1500);
  assert_eq("'full' returns null", resolve_tool_budget(make_tool({ llm_budget: 'full' })), null);

  // 6. project_tool_result_for_llm — full opt-out passes serialized
  //    JSON through unmodified even when oversized.
  {
    const big_obj = { blob: 'y'.repeat(50_000) };
    const full_tool = make_tool({ llm_budget: 'full' });
    const out = project_tool_result_for_llm(big_obj, full_tool);
    assert_eq('full opt-out length', out.length, JSON.stringify(big_obj).length);
    assert(!out.includes('[...truncated'), 'full opt-out has no marker');
  }

  // 7. project_tool_result_for_llm — numeric override respected end-to-end.
  {
    const big_obj = { blob: 'z'.repeat(10_000) };
    const tight = make_tool({ llm_budget: 800 });
    const out = project_tool_result_for_llm(big_obj, tight);
    assert(out.length <= 800, `tight budget ${out.length} <= 800`);
    assert(out.includes('[...truncated'), 'tight budget triggers marker');
  }

  // 8. Default budget kicks in for an unconfigured tool when oversized.
  {
    const obj = { content: 'a'.repeat(8_000) };
    const out = project_tool_result_for_llm(obj, make_tool());
    assert(out.length <= TOOL_RESULT_DEFAULT_BUDGET, 'default budget cap honored');
    assert(out.includes('[...truncated'), 'default budget triggers marker');
  }

  // 9. tool_budget_chars_for_window — fraction × cpt × window, floored.
  {
    const w = 36_864;
    const expected = Math.floor(
      w * TOOL_CONTEXT_BUDGET_FRACTION * TOOL_CONTEXT_CHARS_PER_TOKEN,
    );
    assert_eq('window budget', tool_budget_chars_for_window(w), expected);
    // Bigger window → strictly bigger budget (per-tier scaling).
    assert(
      tool_budget_chars_for_window(98_304) > tool_budget_chars_for_window(24_576),
      'larger window yields larger budget',
    );
  }

  // 10. enforce_cumulative_tool_budget — under budget is an untouched no-op.
  {
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'tool', content: 'short result A' },
      { role: 'tool', content: 'short result B' },
    ];
    const before = msgs.map((m) => m.content);
    const r = enforce_cumulative_tool_budget(msgs, 10_000);
    assert_eq('no-op compressed count', r.compressed, 0);
    assert_eq('no-op before==after', r.before, r.after);
    assert(
      msgs.every((m, i) => m.content === before[i]),
      'no-op leaves every message untouched',
    );
  }

  // 11. Over budget — compresses OLDEST first, protects the newest, and
  //     leaves non-tool messages alone.
  {
    const big = (tag: string) =>
      `RESULT ${tag}\n` + `${tag} filler line of boring content\n`.repeat(400);
    const msgs = [
      { role: 'system', content: 'persona block — must never be touched' },
      { role: 'tool', content: big('OLD1') }, // oldest
      { role: 'tool', content: big('OLD2') },
      { role: 'user', content: 'a user message in the middle — untouched' },
      { role: 'tool', content: big('NEW1') },
      { role: 'tool', content: big('NEW2') }, // newest
    ];
    const sys_before = msgs[0]!.content;
    const user_before = msgs[3]!.content;
    const newest_before = msgs[5]!.content;

    const budget = big('OLD1').length * 2; // room for ~2 full results
    const r = enforce_cumulative_tool_budget(msgs, budget, { keep_newest: 2 });

    assert(r.compressed >= 1, 'compressed at least one old result');
    assert(r.after <= budget, `after ${r.after} <= budget ${budget}`);
    assert(r.after < r.before, 'shrank the cumulative total');
    // Oldest got stubbed.
    assert(
      msgs[1]!.content.includes('[...truncated'),
      'oldest tool result was compressed',
    );
    // Newest protected (keep_newest=2 → NEW1+NEW2 verbatim).
    assert_eq('newest untouched', msgs[5]!.content, newest_before);
    // Non-tool messages never touched.
    assert_eq('system untouched', msgs[0]!.content, sys_before);
    assert_eq('user untouched', msgs[3]!.content, user_before);
  }

  // 12. Last resort — when the protected newest alone bust the budget,
  //     they get compressed too rather than overflowing.
  {
    const big = 'RESULT\n' + 'filler boring line\n'.repeat(400);
    const msgs = [
      { role: 'tool', content: big },
      { role: 'tool', content: big },
    ];
    // Budget smaller than a single result, keep_newest covers both.
    const r = enforce_cumulative_tool_budget(msgs, 1200, { keep_newest: 2, stub_budget: 600 });
    assert(r.after <= 1200, `last-resort after ${r.after} <= 1200`);
    assert(
      msgs.every((m) => m.content.length <= 600 || m.content.includes('[...truncated')),
      'newest compressed as last resort',
    );
  }

  // ── High-signal salvage survives JSON SERIALIZATION (regression, 2026-07-28)
  //
  // Every other check in this file calls `compact_tool_result` directly with
  // REAL newlines — a shape production never produces. The only production
  // caller is `project_tool_result_for_llm`, which passes
  // `JSON.stringify(result)`, where newlines inside text fields are the
  // two-character escape `\` + `n`. Splitting on '\n' therefore saw ONE line,
  // the loop broke immediately, and the salvage pass contributed nothing to any
  // tool result in the system — compaction silently degraded to a head-slice.
  //
  // These assertions MUST go through project_tool_result_for_llm. Testing
  // compact_tool_result directly is exactly how the bug hid.
  {
    const nav = Array.from(
      { length: 200 },
      (_, i) => `filler nav line ${i} lorem ipsum dolor sit amet consectetur`,
    );
    const listings = [
      'Aug 14 2026 — The National — tickets $45 — on sale Friday',
      'Sep 02 2026 — Khruangbin — SOLD OUT — 8:00 pm',
      'Oct 19 2026 — Big Thief — presale $38 — venue capacity 1200',
    ];
    // Nav junk first, real signal deep in the body — the shape of a venue page.
    const text = ['[Shows](/shows)[Visit](/visit)', ...nav, ...listings].join('\n');
    const budget = 2000;
    const out = project_tool_result_for_llm(
      { url: 'https://ex.example/calendar', title: 'Calendar', text },
      make_tool({ llm_budget: budget }),
    );

    assert(
      out.length <= budget,
      `serialized salvage stays within budget (got ${out.length} > ${budget})`,
    );
    for (const act of ['The National', 'Khruangbin', 'Big Thief']) {
      assert(
        out.includes(act),
        `high-signal line "${act}" survives JSON-serialized compaction (the salvage pass must run)`,
      );
    }
    assert(
      out.includes('…'),
      'salvage block is present for a JSON-serialized payload',
    );
    assert(
      out.includes('[...truncated'),
      'truncation marker still emitted alongside the salvage block',
    );
  }

  // ── enforce_prompt_window ────────────────────────────────────────────────
  // The backstop for context-overflow 400s: history is capped by COUNT at the
  // route, so long turns overflow the window on conversation alone.
  {
    // 3600 chars = 1000 tokens at TOOL_CONTEXT_CHARS_PER_TOKEN (3.6).
    const tok = (n: number): string => 'x'.repeat(Math.round(n * TOOL_CONTEXT_CHARS_PER_TOKEN));
    const build = () => [
      { role: 'system', content: tok(1000) },
      ...Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: tok(1000),
      })),
      { role: 'user', content: tok(100) }, // the live turn
      { role: 'assistant', content: tok(50) }, // carries this round's tool_calls
      { role: 'tool', content: tok(200) },
    ];
    const span = { start: 1, end: 11 }; // the 10 replayed history turns

    // Under budget → untouched.
    const roomy = build();
    const noop = enforce_prompt_window(roomy, {
      window_tokens: 64_000,
      reserve_tokens: 4000,
      evictable: span,
    });
    assert_eq('under budget evicts nothing', noop.dropped, 0);
    assert_eq('under budget keeps every message', roomy.length, 14);
    assert_eq('under budget is not flagged over', noop.still_over, false);

    // Over budget → evicts oldest history until it fits.
    const tight = build();
    const fitted = enforce_prompt_window(tight, {
      window_tokens: 4000,
      reserve_tokens: 500,
      evictable: span,
    });
    assert_eq('evicts exactly the oldest history needed', fitted.dropped, 8);
    assert(
      fitted.after_tokens <= fitted.budget_tokens,
      `fitted payload is under budget (${fitted.after_tokens} > ${fitted.budget_tokens})`,
    );
    assert_eq('never flagged over when it fits', fitted.still_over, false);
    assert_eq('the system prompt survives', tight[0]?.role, 'system');
    assert_eq(
      'the persona is untouched, not truncated',
      tight[0]?.content?.length,
      Math.round(1000 * TOOL_CONTEXT_CHARS_PER_TOKEN),
    );
    // Everything from the live user turn onward must be intact — dropping half
    // of a tool_call/tool_result pair is a malformed request, worse than a 400.
    assert_eq('the tool message survives eviction', tight.at(-1)?.role, 'tool');
    assert_eq('the assistant tool_call turn survives', tight.at(-2)?.role, 'assistant');
    assert_eq(
      'the live user turn survives',
      tight.at(-3)?.content?.length,
      Math.round(100 * TOOL_CONTEXT_CHARS_PER_TOKEN),
    );

    // Idempotent: re-running on an already-fitted payload is a no-op.
    const again = enforce_prompt_window(tight, {
      window_tokens: 4000,
      reserve_tokens: 500,
      evictable: { start: 1, end: 11 - fitted.dropped },
    });
    assert_eq('second pass is a no-op', again.dropped, 0);

    // Nothing left to cut → reported honestly rather than mangling the persona.
    const hopeless = build();
    const over = enforce_prompt_window(hopeless, {
      window_tokens: 500,
      reserve_tokens: 400,
      evictable: span,
    });
    assert_eq('drains all evictable history as a last resort', over.dropped, 10);
    assert_eq('reports still_over when the persona alone busts it', over.still_over, true);
    assert_eq('and still refuses to drop the system prompt', hopeless[0]?.role, 'system');
  }

  // ── tool_calls are REAL payload (2026-08-03) ────────────────────────────
  // The estimator summed `content.length` only. An assistant turn that calls a
  // tool has content:null and every byte in `tool_calls`, so it scored ZERO —
  // an UNDER-count, the unsafe direction, worst on exactly the multi-round
  // deep turns that run closest to the slot ceiling. Kristi's prompt reached
  // 49393 against a 49152 slot on 2026-08-02 and 400'd.
  {
    const big_args = JSON.stringify({ query: 'x'.repeat(8000) });
    const withCalls = [
      { role: 'system', content: 'persona' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: big_args } }],
      },
      { role: 'user', content: 'now?' },
    ];
    const seen = estimate_prompt_tokens(withCalls);
    const content_only = Math.ceil(
      withCalls.reduce((n, m) => n + (m.content?.length ?? 0), 0) / TOOL_CONTEXT_CHARS_PER_TOKEN,
    );
    assert(seen > content_only + 1500, 'estimator counts tool_call arguments as payload');
    assert(content_only < 100, '…and content-only would have scored it near zero');
    assert(
      estimate_prompt_tokens([{ role: 'user', content: '' }]) > 0,
      'estimator adds per-message chat-template scaffolding',
    );
  }

  // ── slack scales with the window ────────────────────────────────────────
  // A flat 1024 is ~6% of a 16k window but ~1.6% of a 64k one, while the error
  // it absorbs (chars-per-token drift) grows WITH the payload. Every deep role
  // declares its entire per-slot size, so that 1.6% was the whole margin.
  {
    assert_eq('small window keeps the flat floor', prompt_window_slack_for(16384), 1024);
    assert(prompt_window_slack_for(65536) > 1024, 'large window scales up');
    assert_eq('…to 3% of the window', prompt_window_slack_for(65536), Math.ceil(65536 * 0.03));
    assert(prompt_window_slack_for(1000) === 1024, 'slack never shrinks below the floor');
  }

  console.log('✓ smoke:compaction — 38 checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
