/**
 * lookup_benchmark_scores — the PERFORMANCE half of price-per-performance.
 *
 * Kristi's store knows what parts COST (street prices, OEM deltas) but not what
 * they DO — so "the T6's GPU step-up costs 12% more per unit of render
 * throughput than the Z8's" was unanswerable. This job fills the
 * `benchmark_scores` table: for every CPU/GPU commodity she tracks that has no
 * score yet, run one bounded lookup (search → fetch → one LLM number-extract)
 * against the Tier-2 benchmark sites already in her trust manifest
 * (cpubenchmark.net / videocardbenchmark.net — PassMark), and record the score
 * under a CANONICAL benchmark key (cost_model KNOWN_BENCHMARKS — scores only
 * compare within one benchmark).
 *
 * Silicon doesn't drift: a recorded score is permanent (no staleness loop),
 * so the worklist only ever shrinks toward full coverage. Street-priced parts
 * are looked up first — each one yields a perf-per-dollar row the moment its
 * score lands. Bounded per run; backfills over runs; mirrors
 * lookup_commodity_market_prices' shape so it can't spiral.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { getKristiWorkstationsStore } from '@memory/stores/kristi_workstations';
import { KNOWN_BENCHMARKS } from '../cost_model';
import { fetch_with_browser_fallback } from '@connectors/fetch_with_browser_fallback';
import { web_search } from '@connectors/searxng';

const DEFAULT_MAX = 8; // components scored per run (bounded; backfills over runs)

/** Which canonical benchmark each class is looked up under, and where. */
const CLASS_LOOKUP: Record<'cpu' | 'gpu', { benchmark: string; site_hint: string }> = {
  cpu: { benchmark: 'passmark_cpu', site_hint: 'cpubenchmark.net' },
  gpu: { benchmark: 'passmark_g3d', site_hint: 'videocardbenchmark.net' },
};

const InputSchema = z
  .object({
    max: z.number().int().min(1).max(20).optional().describe('Cap components scored per run.'),
  })
  .strict();
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
  ok: z.boolean(),
  worklist: z.number(),
  recorded: z.number(),
  fails: z.number(),
  /** Scores the plausibility gate refused (misread class). */
  rejected: z.number(),
  scored: z.array(z.object({ component: z.string(), benchmark: z.string(), score: z.number() })),
});
type Output = z.infer<typeof OutputSchema>;

function extract_score(s: string): number | null {
  const t = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const n = Number((t.match(/-?\d[\d,]*\.?\d*/)?.[0] ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'lookup_benchmark_scores',
    description:
      "BACKGROUND JOB. For each CPU/GPU commodity with no benchmark score yet, look up its PassMark score (cpubenchmark.net / videocardbenchmark.net) and record it under a canonical benchmark key — the PERFORMANCE axis the perf_per_dollar view joins against street prices. Street-priced parts first. Scores are permanent (silicon doesn't drift); bounded per run; backfills toward full coverage.",
    risk: 'write_internal',
    required_capabilities: ['write_workstation_intel', 'query_web', 'browse_web'],
    weight: 'heavy',
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `lookup_benchmark_scores:${input.max ?? DEFAULT_MAX}:${new Date().toISOString().slice(0, 13)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const store = getKristiWorkstationsStore();
      const worklist = store.unbenchmarked_components(input.max ?? DEFAULT_MAX);
      const scored: Array<{ component: string; benchmark: string; score: number }> = [];
      let recorded = 0;
      let fails = 0;
      let rejected = 0;
      let ok = true;

      for (const item of worklist) {
        const lookup = CLASS_LOOKUP[item.component_class];
        const range = KNOWN_BENCHMARKS[lookup.benchmark]!.range;
        let found: { score: number; url: string } | null = null;
        try {
          const sr = await web_search.execute(
            { query: `${item.component} passmark ${lookup.site_hint}`, max_results: 3 },
            ctx,
          );
          for (const r of (sr.results ?? []).slice(0, 2)) {
            if (!r.url) continue;
            const outcome = await fetch_with_browser_fallback(r.url, ctx, { title_fallback: r.title || undefined });
            if (outcome.kind !== 'firecrawl' && outcome.kind !== 'browser') continue;
            const role = deps.llm.for_role('research_extract');
            const resp = await role.provider.complete({
              messages: [
                {
                  role: 'system',
                  content:
                    `Extract the ${KNOWN_BENCHMARKS[lookup.benchmark]!.label} score for EXACTLY this part — the same model ` +
                    'and generation (an RTX 6000 Ada and an RTX PRO 6000 Blackwell are DIFFERENT parts; a w7-3565X is not a ' +
                    'w7-3465X). If the page scores a different variant, or shows only a rank/percentile/price, return 0. ' +
                    'Reply with ONLY the score number (no commas), or 0 if THIS EXACT part is not clearly scored.',
                },
                { role: 'user', content: `PART: ${item.component}\n\nPAGE:\n${outcome.markdown.slice(0, 12_000)}` },
              ],
              max_tokens: 30,
              think: false,
            });
            const score = extract_score(resp.content);
            if (score !== null && score >= range[0] && score <= range[1]) {
              found = { score, url: r.url };
              break;
            }
          }
        } catch {
          fails++;
          ok = false;
          continue;
        }
        if (!found) { fails++; continue; }
        const verdict = store.record_benchmark_score({
          component: item.component,
          component_class: item.component_class,
          benchmark: lookup.benchmark,
          score: found.score,
          source_url: found.url,
        });
        if (!verdict.stored) { rejected++; continue; }
        recorded++;
        scored.push({ component: item.component, benchmark: lookup.benchmark, score: found.score });
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kristi',
        tool_name: 'lookup_benchmark_scores',
        tool_input: { max: input.max ?? DEFAULT_MAX },
        execution_result: { ok, worklist: worklist.length, recorded, fails, rejected },
      });

      return { ok, worklist: worklist.length, recorded, fails, rejected, scored };
    },
  };
}
