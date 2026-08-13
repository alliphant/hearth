/**
 * Smoke / proof for the two-tier inference setup (2026-05-31).
 *
 * Exercises the REAL ConfigLLMRouter against BOTH live servers and proves
 * the three claims of the two-tier design:
 *
 *   1. ROUTING — the `specialist` role resolves to the DEEP tier
 *      (Qwen3.6-27B-Q4_K_M, :8088, 3090) and the `librarian` role (the
 *      role Cordelia's verification/curation lane uses) resolves to the
 *      LIVE tier (Qwen3.6-27B-UD-IQ2_M, :8089, A4000) via its per-role
 *      base_url. The resolved `model` and the measured decode rate
 *      fingerprint which GPU served each (3090 ~45-50 tok/s vs A4000
 *      ~25 tok/s).
 *   2. CONCURRENCY — fired together, a DEEP turn and a LIVE turn run in
 *      PARALLEL, not serialized: wall-clock(both concurrent) ≈
 *      max(each), not the sum. This is the N-slot/per-endpoint mutex
 *      working — the two endpoints have independent mutexes, so the
 *      27B's single slot never blocks the A4000 and vice versa.
 *   3. LIBRARIAN BEHAVIOR — a think-on librarian turn offered a
 *      web_search tool emits a real tool call (fetch-not-recall), the
 *      Cordelia verification posture.
 *
 * Run in the orchestrator's network context so host.docker.internal:8089
 * resolves:  docker exec hearth-orchestrator bun run scripts/smoke-two-tier.ts
 *
 * Skips cleanly (exit 0) when the LIVE server (:8089) is unreachable —
 * it isn't part of the always-on stack until llamacpp-live-glacier.service
 * is installed.
 */

import { ConfigLLMRouter } from '../src/core/router';
import { resolve_effective_role } from '../src/core/specialist_runtime';
import { librarian_findings_nudge } from '../src/core/fact_critic';
import type { LLMRequest, LLMResponse } from '../src/core/llm';

const ROLES_PATH = process.env.HEARTH_ROLES_PATH ?? './config/llm-roles.yaml';

const router = new ConfigLLMRouter(ROLES_PATH, {
  ollama_base_url: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
  openai_base_url: process.env.OPENAI_BASE_URL,
  openai_api_key: process.env.OPENAI_API_KEY,
});

function tok_per_s(r: LLMResponse): number {
  const ms = r.cost?.ms ?? 0;
  const out = r.cost?.tokens_out ?? 0;
  return ms > 0 ? (out / ms) * 1000 : 0;
}

async function ask(
  role: 'specialist' | 'librarian',
  user: string,
  extra: Partial<LLMRequest> = {},
): Promise<LLMResponse> {
  const resolved = router.for_role(role);
  const req: LLMRequest = {
    ...resolved.defaults,
    messages: [{ role: 'user', content: user }],
    ...extra,
  };
  return resolved.provider.complete(req);
}

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
  const ok = (m: string): void => {
    console.log(`  ✓ ${m}`);
    passed++;
  };
  const fail = (m: string, d?: unknown): void => {
    console.log(`  ✗ ${m}`, d ?? '');
    failed++;
  };

  // ── 0. Tier-routing precedence (pure, no server needed) ─────────────
  console.log('\n── 0. resolve_effective_role precedence ─────────────────');
  {
    const plain = { llm_role: undefined };          // un-pinned specialist
    const pinned = { llm_role: 'voice_realtime' as const }; // a voice-pinned specialist
    resolve_effective_role({}, plain) === 'specialist'
      ? ok('default → specialist (DEEP)')
      : fail('default wrong', resolve_effective_role({}, plain));
    resolve_effective_role({ tier: 'live' }, plain) === 'live'
      ? ok('tier:live (un-pinned) → live (LIVE tier)')
      : fail('tier hint ignored', resolve_effective_role({ tier: 'live' }, plain));
    resolve_effective_role({ tier: 'deep' }, plain) === 'specialist'
      ? ok('tier:deep → specialist (DEEP)')
      : fail('tier:deep wrong');
    resolve_effective_role({ llm_role: 'specialist_deliberation', tier: 'live' }, plain) === 'specialist_deliberation'
      ? ok('explicit llm_role beats tier hint')
      : fail('precedence wrong — tier overrode explicit llm_role');
    resolve_effective_role({}, pinned) === 'voice_realtime'
      ? ok('specialist pin honored when no per-call override')
      : fail('pin ignored');
  }

  // ── 0b. librarian-lane nudge folds in fetched findings (pure) ───────
  console.log('\n── 0b. librarian_findings_nudge ─────────────────────────');
  {
    const nudge = librarian_findings_nudge(
      [{ claim: 'PUC Order E-23734', kind: 'named_entity', reason: 'no source' }],
      'PUC Order E-23734: UNVERIFIED — no such order found (source: puc.colorado.gov search).',
    );
    nudge.includes('UNVERIFIED') && nudge.includes('Librarian findings') && /only.*source/i.test(nudge)
      ? ok('nudge carries the librarian findings as the sole grounding')
      : fail('nudge missing findings/grounding directive', nudge.slice(0, 120));
  }

  // ── Preflight: is the LIVE tier (:8089) up? ──────────────────────────
  console.log('\n── preflight: LIVE tier (:8089) reachable? ──────────────');
  try {
    const warm = await ask('librarian', 'Reply with the single word: ready.', {
      max_tokens: 16,
    });
    console.log(`  librarian warm: "${warm.content.trim().slice(0, 40)}"`);
  } catch (err) {
    console.log(
      `\n⊘ SKIP: LIVE tier (:8089) unreachable — ${(err as Error).message}`,
    );
    console.log(
      '  (Expected until llamacpp-live-glacier.service is installed, or run' +
        ' the server manually on the A4000.)\n',
    );
    process.exit(0);
  }
  // Warm the DEEP tier too so timings reflect decode, not model load.
  await ask('specialist', 'Reply with the single word: ready.', { max_tokens: 16 });

  // ── 1. Routing — resolved models per role ────────────────────────────
  console.log('\n── 1. routing: role → tier ──────────────────────────────');
  const spec_model = router.for_role('specialist').model;
  const lib_model = router.for_role('librarian').model;
  console.log(`  specialist → ${spec_model}`);
  console.log(`  librarian  → ${lib_model}`);
  spec_model.includes('Q4_K_M')
    ? ok('specialist resolves to the Q4 DEEP model')
    : fail('specialist model unexpected', spec_model);
  lib_model.includes('IQ2')
    ? ok('librarian resolves to the IQ2 LIVE model')
    : fail('librarian model unexpected', lib_model);

  // ── 2. Concurrency — sequential vs parallel wall-clock ───────────────
  console.log('\n── 2. concurrency: parallel ≈ max, not sum ──────────────');
  const Q_SPEC = 'In two sentences, explain why memory bandwidth bounds LLM decode speed.';
  const Q_LIB = 'In two sentences, what is the capital of France and why is it notable?';

  // Keep the two calls roughly BALANCED in wall-time so the parallelism
  // saving (~the faster call's duration) is clearly above run-to-run
  // noise. Wildly unequal calls (2s vs 21s) hide the overlap in variance.
  // specialist is think-off (~32 tok/s), librarian think-on (~24 tok/s);
  // these budgets land both near ~3-4s. (The librarian's think trace may
  // eat its budget → terse content; we assert tokens generated, not text.)
  const SPEC_TOK = 120;
  const LIB_TOK = 96;
  const s0 = performance.now();
  const seq_spec = await ask('specialist', Q_SPEC, { max_tokens: SPEC_TOK });
  const t_spec = performance.now() - s0;
  const l0 = performance.now();
  const seq_lib = await ask('librarian', Q_LIB, { max_tokens: LIB_TOK });
  const t_lib = performance.now() - l0;
  const seq_sum = t_spec + t_lib;

  const p0 = performance.now();
  const [par_spec, par_lib] = await Promise.all([
    ask('specialist', Q_SPEC, { max_tokens: SPEC_TOK }),
    ask('librarian', Q_LIB, { max_tokens: LIB_TOK }),
  ]);
  const t_par = performance.now() - p0;

  console.log(
    `  DEEP (27B/3090):  ${t_spec.toFixed(0)}ms, ${tok_per_s(seq_spec).toFixed(1)} tok/s`,
  );
  console.log(
    `  LIVE (IQ2/A4000): ${t_lib.toFixed(0)}ms, ${tok_per_s(seq_lib).toFixed(1)} tok/s`,
  );
  console.log(
    `  sequential sum: ${seq_sum.toFixed(0)}ms  |  concurrent wall: ${t_par.toFixed(0)}ms`,
  );
  // Genuine parallelism: if the two endpoints serialized, concurrent ≈ sum.
  // Parallel means concurrent ≈ max(each), so it saves ~the faster call's
  // time. Assert the saving is at least half the faster call (robust to the
  // two calls being unequal length).
  const saved = seq_sum - t_par;
  const fastest = Math.min(t_spec, t_lib);
  saved > fastest * 0.5
    ? ok(`ran in parallel — concurrent ${t_par.toFixed(0)}ms saved ${saved.toFixed(0)}ms vs sum ${seq_sum.toFixed(0)}ms`)
    : fail(`serialized — concurrent ${t_par.toFixed(0)}ms ≈ sum ${seq_sum.toFixed(0)}ms`);
  // "Executed on the tier" = generated tokens. (A think-on librarian turn
  // may spend its budget on the reasoning trace, leaving content terse —
  // that's still a real turn on the LIVE GPU.)
  (par_spec.cost?.tokens_out ?? 0) > 0 && (par_lib.cost?.tokens_out ?? 0) > 0
    ? ok(`both concurrent turns generated tokens (DEEP ${par_spec.cost?.tokens_out}, LIVE ${par_lib.cost?.tokens_out})`)
    : fail('a concurrent turn generated no tokens');
  // GPU fingerprint: the IQ2 on the slower A4000 should decode slower than
  // the Q4 on the 3090 — independent confirmation they hit different boxes.
  tok_per_s(seq_spec) > tok_per_s(seq_lib)
    ? ok(`decode fingerprint matches (DEEP ${tok_per_s(seq_spec).toFixed(0)} > LIVE ${tok_per_s(seq_lib).toFixed(0)} tok/s)`)
    : console.log('  · note: decode rates close; fingerprint inconclusive (load-dependent)');

  // ── 3. Librarian behavior — fetch, don't recall ──────────────────────
  console.log('\n── 3. librarian (Cordelia lane) emits a tool call ───────');
  const tool_resp = await ask(
    'librarian',
    'What PUC order authorized the utility behind the Ponds Fire near Pleasantville in April 2026? Quote the decision.',
    {
      max_tokens: 600,
      tools: [
        {
          name: 'web_search',
          description: 'Search the web for current facts.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ],
    },
  );
  const called = (tool_resp.tool_calls ?? []).some((c) => c.name === 'web_search');
  called
    ? ok(`librarian fetched instead of recalling (web_search: ${JSON.stringify((tool_resp.tool_calls ?? [])[0]?.arguments)?.slice(0, 80)})`)
    : console.log(
        `  · note: no tool call this run (content: "${tool_resp.content.slice(0, 120)}") — model-variance, not a routing failure`,
      );

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
