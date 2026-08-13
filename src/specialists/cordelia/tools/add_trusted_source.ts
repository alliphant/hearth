/**
 * add_trusted_source — Cordelia's curated-URL list, write side.
 *
 * Jasper hands her a URL ("add this to your list") and she files it into
 * Knowledge/Cordelia/sources.md. The list is the first place she looks
 * when picking candidates for any open-web search — Jasper-pre-blessed
 * domains beat unknown SEO chum.
 *
 * Storage lives in sources_store.ts (the one shared definition since
 * 2026-06-10): a single markdown file with a `sources:` array in
 * frontmatter. No `type:` field, so the ingestor leaves it alone. Hand-
 * editable in Obsidian.
 *
 * Subscription extension (2026-06-10): passing `specialist_id` +
 * `cadence` (and optionally `tier`) turns the entry into a SOURCE
 * SUBSCRIPTION — Cordelia's nightly `refresh_subscriptions` job
 * re-fetches it on cadence, hash-diffs, and shelves changed content onto
 * that specialist's library. All optional; a plain add is unchanged.
 *
 * Dedup: same URL is updated in place rather than duplicated, and a
 * plain re-add never wipes an existing subscription's fields.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { MemoryClient } from '@memory/client';
import { upsert_source } from '../sources_store';

const InputSchema = z.object({
  url: z
    .string()
    .url()
    .describe(
      'The URL to remember. Use the canonical landing URL, not a deep ' +
        'link into a specific document — e.g. https://standardebooks.org ' +
        'not https://standardebooks.org/ebooks/jane-austen/emma.',
    ),
  description: z
    .string()
    .max(500)
    .optional()
    .describe(
      'A one-line note on what this source is good for. Shown back when ' +
        'list_trusted_sources is called.',
    ),
  tags: z
    .array(z.string().max(60))
    .max(20)
    .optional()
    .describe(
      'Optional tags to group sources, e.g. ["ebooks", "oa"] or ' +
        '["ev", "hyundai"]. Used as a filter in list_trusted_sources.',
    ),
  specialist_id: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe(
      'Subscribe a specialist to this source: refreshed content shelves ' +
        "onto this specialist's library (lowercase id, e.g. 'iris'). " +
        'Requires `cadence` to take effect.',
    ),
  cadence: z
    .enum(['daily', 'weekly', 'monthly', 'quarterly'])
    .optional()
    .describe(
      'Refresh cadence for a subscription. Use daily for news/wire feeds, ' +
        'weekly for calendar pages, monthly for evolving reference, ' +
        'quarterly for stable docs.',
    ),
  tier: z
    .union([z.literal(1), z.literal(2)])
    .optional()
    .describe(
      'Trust tier stamped on shelved refreshes (1 = peer-reviewed/gov/' +
        "professional body, 2 = high-quality with attribution). Omit to " +
        "resolve from the target specialist's trusted_sources manifest.",
    ),
  fetch_via: z
    .enum(['browser'])
    .optional()
    .describe(
      "Fetch strategy override: 'browser' fetches through the workstation's " +
        'signed-in Firefox from the start — for paywalled/login-gated ' +
        'sources (e.g. NYT with the household subscription). Omit for ' +
        'the normal fetch path.',
    ),
});

const OutputSchema = z.object({
  url: z.string(),
  domain: z.string(),
  action: z.enum(['added', 'updated']),
  total_sources: z.number(),
  is_subscription: z.boolean(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_add_trusted_source(memory: MemoryClient): Tool<Input, Output> {
  return {
    name: 'add_trusted_source',
    description:
      'Add a URL to your curated trusted-sources list. Use this when ' +
      'Jasper says "add this to your list", "remember this source", or ' +
      'similar. Stored in Knowledge/Cordelia/sources.md and consulted ' +
      'before any open-web search via list_trusted_sources. Idempotent ' +
      'on URL — re-adding the same URL refreshes its description/tags ' +
      'rather than duplicating. Pass `specialist_id` + `cadence` to make ' +
      'it a SOURCE SUBSCRIPTION: the nightly refresh re-fetches it on ' +
      "cadence and shelves changed content onto that specialist's library.",
    risk: 'write_internal',
    required_capabilities: ['write_vault_librarian'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `add_trusted_source:${input.url}`;
    },

    async execute(input, _ctx: ToolContext): Promise<Output> {
      const { action, total, entry } = upsert_source(memory, {
        url: input.url,
        description: input.description ?? null,
        tags: input.tags ?? [],
        specialist_id: input.specialist_id,
        cadence: input.cadence,
        tier: input.tier,
        fetch_via: input.fetch_via,
      });
      return {
        url: entry.url,
        domain: entry.domain,
        action,
        total_sources: total,
        is_subscription: entry.specialist_id !== undefined && entry.cadence !== undefined,
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_add_trusted_source(deps.memory) as Tool;
}
