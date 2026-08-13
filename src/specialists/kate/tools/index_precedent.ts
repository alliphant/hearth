/**
 * index_precedent_cases — the nightly precedent indexer (Kate self-direction
 * C3, 2026-07-05; engine: src/core/precedent.ts).
 *
 * Renders the decided history — decided proposals, Proposal-Court verdicts,
 * closed/verified process misses — into compact CASE docs in precedent_cases,
 * then back-fills embeddings when the RAG embedder is live (text-only rows
 * still match via deterministic token overlap, so a dark embedder degrades
 * recall quality, never availability). Idempotent per source id; only
 * new/changed sources re-render.
 *
 * NOT on Kate's LLM surfaces — the 04:50 background job is the trigger;
 * manual catch-up via POST /api/specialists/kate/fire_background_job?name=precedent_index&wait=1.
 * DARK behind HEARTH_PRECEDENT=1.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { run_precedent_index, precedent_enabled } from '@core/precedent';
import { PrecedentStore } from '@memory/stores/precedent_cases';
import { ulid } from 'ulid';

const InputSchema = z.object({});
const OutputSchema = z.object({
  enabled: z.boolean(),
  scanned: z.number(),
  indexed_new: z.number(),
  updated: z.number(),
  embedded: z.number(),
  embed_pending: z.number(),
  total_cases: z.number(),
  source_errors: z.array(z.string()),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function create(deps: ToolDeps): Tool {
  const store = new PrecedentStore(deps.db);
  const tool: Tool<Input, Output> = {
    name: 'index_precedent_cases',
    description:
      'Nightly indexer: render the decided history (decided proposals, court verdicts, closed ' +
      'process misses) into the precedent-case index and embed new cases. Job-only.',
    risk: 'write_internal',
    required_capabilities: ['index_precedent'],
    volatile: true, // ledger-dependent mutation each run; never serve a cached tick
    input_schema: InputSchema,
    output_schema: OutputSchema,
    idempotency_key() {
      return `index_precedent_cases:${ulid()}`;
    },
    async execute(_input, ctx: ToolContext): Promise<Output> {
      const r = await run_precedent_index({
        db: deps.db,
        store,
        embedder: deps.embedder,
      });
      ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: 'kate',
        tool_name: 'precedent_index',
        tool_input: { enabled: precedent_enabled() },
        execution_result: {
          scanned: r.scanned,
          indexed_new: r.indexed_new,
          updated: r.updated,
          embedded: r.embedded,
          embed_pending: r.embed_pending,
          total_cases: r.total_cases,
          source_errors: r.source_errors,
        },
      });
      return r;
    },
  };
  return tool as Tool;
}
