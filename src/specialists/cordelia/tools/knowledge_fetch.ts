/**
 * knowledge_fetch — the self-FETCH pass as a job-only tool (autonomous, 2026-06-15).
 *
 * Thin wrapper over `fetch_for_gaps()` in ../knowledge_fetch.ts, wired like
 * synthesize_shelves / refresh_subscriptions: it runs as the
 * `nightly_knowledge_fetch` background job (config/specialists/cordelia.yaml,
 * 03:50 — after the 03:40 source refresh and BEFORE the 04:20 distill, so the
 * freshly-fetched material is consolidated the same night) and is OFF every
 * LLM chat/deliberation surface. Manual catch-up:
 *   POST /api/specialists/cordelia/fire_background_job?name=nightly_knowledge_fetch&wait=1
 *
 * It builds its own (unregistered) acquire_knowledge instance from the shared
 * dep bag and drives it in SILENT mode, so a background sprint never files an
 * owner proposal. Kill switch: HEARTH_SYNTHESIS_FETCH=0.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { fetch_for_gaps, type FetchDeps } from '../knowledge_fetch';
import { make_acquire_knowledge } from './acquire_knowledge';

const InputSchema = z.object({
  max_topics: z
    .number()
    .int()
    .min(1)
    .max(8)
    .default(3)
    .describe('Strongest evidence-backed gaps acquired per run (acquisition is expensive).'),
});

const OutputSchema = z.object({
  enabled: z.boolean(),
  gaps_considered: z.number(),
  topics_fetched: z.number(),
  items_shelved: z.number(),
  notes: z.array(z.string()),
  skipped_reason: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_knowledge_fetch(deps: FetchDeps & { owner_id?: string }): Tool<Input, Output> {
  return {
    name: 'knowledge_fetch',
    description:
      'Autonomous self-fetch: read the demand ledger, rank the strongest evidence-backed knowledge gaps that map to a shelf, and run a SILENT in-roster acquisition sprint on each (no owner proposals). Background job only; the distill pass consolidates what it shelves.',
    risk: 'write_internal',
    required_capabilities: ['write_vault_any_library'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    // Result depends on the demand ledger + shelf state the run mutates — a
    // repeat must re-run, not re-serve the per-turn duplicate cache.
    volatile: true,

    idempotency_key(input) {
      return `knowledge_fetch:${input.max_topics}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      return fetch_for_gaps(deps, {
        now: ctx.now ?? new Date(),
        max_topics: input.max_topics,
        owner_id: deps.owner_id,
      });
    },
  };
}

export function create(deps: ToolDeps): Tool {
  const library_deps = {
    db: deps.db,
    vault_root: deps.vault_root,
    memory: deps.memory,
    specialists: deps.specialists,
    runtime: deps.runtime,
    conversations: deps.conversations,
    llm: deps.llm,
    embedder: deps.embedder,
    events: deps.events,
  };
  // An unregistered acquire_knowledge instance for internal, silent use.
  const acquire = make_acquire_knowledge({
    specialists: deps.specialists,
    proposals: deps.proposals,
    library_deps,
    users: deps.users,
  });
  const owner_id = deps.users?.list().find((u) => u.tier === 'owner')?.id;
  return make_knowledge_fetch({
    db: deps.db,
    memory: deps.memory,
    llm: deps.llm,
    acquire: (input, ctx) =>
      acquire.execute(input as never, ctx) as Promise<{ shelved: unknown[]; proposed?: unknown[] } | null>,
    ...(owner_id ? { owner_id } : {}),
  }) as Tool;
}
