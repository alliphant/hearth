import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import { run_search } from './search_router';

const InputSchema = z.object({
  query: z.string().min(1).max(500),
  max_results: z.number().int().positive().max(50).default(10),
  /**
   * How stale a cached answer this caller accepts, in ms. Omitted ⇒ the
   * router's 30-minute default, i.e. unchanged behavior.
   *
   * NOT exposed to the LLM (stripped from the schema the model sees would be
   * ideal, but keeping it optional + undocumented in `description` is enough:
   * models set what the description tells them to set). It exists for the
   * SCHEDULED BACKGROUND SWEEPS that call `web_search.execute()` directly and
   * re-run identical hand-written seed queries daily — they pass
   * BACKGROUND_MAX_AGE_MS so the second and later sweeps of the same list cost
   * nothing.
   */
  max_age_ms: z.number().int().positive().optional(),
});

const SearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
});

const OutputSchema = z.object({
  query: z.string(),
  results: z.array(SearchResultSchema),
  error: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export const web_search: Tool<Input, Output> = {
  name: 'web_search',
  description:
    'Search the web via the local SearXNG instance and return up to N results (title, URL, snippet). Use to find pages worth fetching with web_fetch_clean.',
  risk: 'read',
  required_capabilities: ['query_web'],
  // Counts against the per-turn heavy-call cap (external fetch).
  weight: 'heavy',
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    return `web_search:${createHash('sha256')
      .update(input.query)
      .update('\n')
      .update(String(input.max_results))
      .digest('hex')
      .slice(0, 16)}`;
  },

  // Thin delegate to the SearchRouter (cache → SearXNG/Brave → bge-rerank).
  // The SearXNG fetch itself now lives in SearxngProvider; this keeps the tool
  // contract (name/schemas/risk/weight/idempotency) byte-identical for all 74
  // callers while every call gets caching + reranking for free.
  async execute(input: Input, _ctx: ToolContext): Promise<Output> {
    return run_search(input.query, input.max_results, { max_age_ms: input.max_age_ms });
  },
};
