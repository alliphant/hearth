/**
 * search_library — explicit retrieval tool for specialists who need a
 * follow-up search beyond the auto-retrieval that happens at turn-start.
 *
 * The runtime injects top-K chunks based on the user's message before
 * every turn (see SpecialistRuntime.turn → retrieve_scoped_chunks). That
 * handles the common case. This tool exists for the cases where:
 *   - The user's question is too broad to retrieve well from
 *   - The specialist realizes mid-turn they need a different lookup
 *     ("the meds doc must mention an alternative — let me check")
 *   - A consult chain wants to search the consultee's library
 *
 * Capability-gated by `read_vault`. Scope-filtered to the calling
 * specialist's knowledge_scope at the registry level via ToolContext —
 * actually, ctx doesn't carry the specialist's scope today, so we
 * accept an optional scope filter and the runtime passes specialist
 * scope explicitly when it surfaces this tool. For now the tool is
 * unscoped — same FTS index, results may include any specialist's
 * library. That's fine for v0; in practice queries are specific.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import { retrieve_hybrid } from '@core/retrieval';
import { NOOP_EMBEDDER } from '@core/embeddings';

const InputSchema = z.object({
  query: z.string().min(2).max(500),
  k: z.coerce.number().int().min(1).max(20).default(5),
});

const HitSchema = z.object({
  note_path: z.string(),
  chunk_text: z.string(),
  score: z.number(),
  // Knowledge-trust surface (2026-05-30). Tier 1 = peer-reviewed /
  // professional body / non-captured govt (auto-ingested by Cordelia
  // — cite without ceremony); Tier 2 = clinical-grade lay synthesis
  // or evidence-based practitioner (cite by source name when used);
  // null = no trust stamp on the wrapper (legacy note or
  // non-library content).
  trust_tier: z.union([z.literal(1), z.literal(2), z.null()]),
  title: z.string().nullable(),
});

const OutputSchema = z.object({
  hits: z.array(HitSchema),
  query_used: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export const search_library: Tool<Input, Output> = {
  name: 'search_library',
  description:
    "Search across the vault's indexed library (FTS5 over chunks_fts) for passages matching a query. Use this for explicit follow-up searches beyond the auto-retrieval that already happens at turn-start. Example: {query: \"prednisolone interactions\", k: 3}. Returns ranked hits with note_path + chunk_text. The auto-retrieval handles the common case for the user's primary question; use this when you realize mid-turn you need a different angle.",
  risk: 'read',
  required_capabilities: ['read_vault'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.query.toLowerCase().trim());
    h.update(String(input.k));
    return `search_library:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    // Phase 2b — propagate caller tier + id so private_to filtering
    // matches the chat-turn RAG path. Owner default preserves legacy
    // single-user behavior when ctx.user is absent.
    const hits = await retrieve_hybrid({
      memory: ctx.memory,
      embedder: ctx.embedder ?? NOOP_EMBEDDER,
      query: input.query,
      knowledge_scope: ['**'],
      k: input.k,
      user_id: ctx.user?.id,
      user_tier: ctx.user?.tier ?? 'owner',
    });
    ctx.memory.log_action({
      intent_id: ctx.intent_id || ulid(),
      // Attribute to the calling specialist (2026-06-10) so the demand
      // ledger (knowledge_demand.ts) and scan_shelf_quality can group
      // empty results by shelf — 'orchestrator' rows are unattributable.
      agent: ctx.specialist_id ?? 'orchestrator',
      tool_name: 'search_library',
      tool_input: { query_preview: input.query.slice(0, 120), k: input.k },
      execution_result: { hits: hits.length, paths: hits.map((h) => h.note_path) },
      user_id: ctx.user?.id,
    });
    return { hits, query_used: input.query };
  },
};
