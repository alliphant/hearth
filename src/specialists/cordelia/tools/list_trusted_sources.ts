/**
 * list_trusted_sources — Cordelia's curated-URL list, read side.
 *
 * Returns Jasper's pre-blessed sources so Cordelia can prefer them when
 * picking candidates for a web_search. Optional `domain` / `tag` filters
 * narrow the result when the list grows. Empty list is a valid result —
 * her behavior in that case is the same as before this list existed
 * (fall back to general searching).
 *
 * Since 2026-06-10 entries may be SOURCE SUBSCRIPTIONS (see
 * sources_store.ts) — those surface their owning specialist, cadence,
 * and last-crawl state so Cordelia can see at a glance what the nightly
 * refresh covers.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { SpecialistRegistry } from '@core/specialist';
import { SOURCES_PATH, read_sources } from '../sources_store';

const InputSchema = z.object({
  domain: z
    .string()
    .max(253)
    .optional()
    .describe(
      'Optional substring filter on the source domain, case-insensitive. ' +
        'e.g. "edu" matches all .edu sources; "hyundai" matches Hyundai ones.',
    ),
  tag: z
    .string()
    .max(60)
    .optional()
    .describe(
      'Optional exact-match filter on a single tag. e.g. "ebooks" returns ' +
        'only sources tagged "ebooks".',
    ),
  specialist_id: z
    .string()
    .max(40)
    .optional()
    .describe(
      "Optional filter to one specialist's subscriptions (lowercase id). " +
        'Returns only entries subscribed for that shelf.',
    ),
});

const SourceSchema = z.object({
  url: z.string(),
  domain: z.string(),
  description: z.string().nullable(),
  tags: z.array(z.string()),
  added: z.string(),
  specialist_id: z.string().optional(),
  cadence: z.enum(['daily', 'weekly', 'monthly', 'quarterly']).optional(),
  tier: z.union([z.literal(1), z.literal(2)]).optional(),
  seeded_by: z.string().optional(),
  last_crawled_at: z.string().optional(),
  fetch_via: z.enum(['browser']).optional(),
});

const OutputSchema = z.object({
  sources: z.array(SourceSchema),
  total: z.number(),
  filtered: z.boolean(),
  error: z.string().optional().describe('Error message if the sources store failed to read.'),
  candidates: z.array(z.string()).optional().describe('Fallback candidate sources when the store is unavailable.'),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_list_trusted_sources(
  specialists: SpecialistRegistry,
): Tool<Input, Output> {
  return {
    name: 'list_trusted_sources',
    description:
      'Return the curated list of source URLs Jasper has pre-blessed. ' +
      "Call this BEFORE web_search when you're acquiring a document, " +
      'ebook, or reference — a match in this list is a stronger signal ' +
      'than any open-web result. Optional `domain` substring, `tag` ' +
      'exact-match, or `specialist_id` (subscriptions for one shelf) ' +
      'filters narrow the result. Subscription entries also show their ' +
      'cadence and last-crawl state. Empty list is normal early ' +
      "on; fall back to web_search and the persona's trusted-source " +
      'guidance.',
    risk: 'read',
    required_capabilities: ['read_vault'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `list_trusted_sources:${input.domain ?? ''}:${input.tag ?? ''}:${input.specialist_id ?? ''}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      if (!ctx.specialist_id) {
        throw new Error('list_trusted_sources requires specialist_id on ToolContext');
      }
      const spec = specialists.get(ctx.specialist_id);
      if (!spec) {
        throw new Error(
          `list_trusted_sources: unknown caller specialist_id "${ctx.specialist_id}"`,
        );
      }
      if (!ctx.memory.path_in_scope(SOURCES_PATH, spec.knowledge_scope)) {
        throw new Error(
          "list_trusted_sources: Cordelia's curated list is outside your " +
            'knowledge_scope. This tool is for the Librarian; ask her to ' +
            'recommend a source instead.',
        );
      }

      try {
        const all = read_sources(ctx.memory);
        const domain_q = input.domain?.toLowerCase();
        const tag_q = input.tag;
        const spec_q = input.specialist_id;
        const filtered = all.filter((s) => {
          if (domain_q && !s.domain.toLowerCase().includes(domain_q)) return false;
          if (tag_q && !s.tags.includes(tag_q)) return false;
          if (spec_q && s.specialist_id !== spec_q) return false;
          return true;
        });

        return {
          sources: filtered.map((s) => ({
            url: s.url,
            domain: s.domain,
            description: s.description,
            tags: s.tags,
            added: s.added,
            ...(s.specialist_id !== undefined ? { specialist_id: s.specialist_id } : {}),
            ...(s.cadence !== undefined ? { cadence: s.cadence } : {}),
            ...(s.tier !== undefined ? { tier: s.tier } : {}),
            ...(s.seeded_by !== undefined ? { seeded_by: s.seeded_by } : {}),
            ...(s.last_crawled_at !== undefined
              ? { last_crawled_at: s.last_crawled_at }
              : {}),
            ...(s.fetch_via !== undefined ? { fetch_via: s.fetch_via } : {}),
          })),
          total: all.length,
          filtered: Boolean(domain_q || tag_q || spec_q),
        };
      } catch (err) {
        return {
          sources: [],
          total: 0,
          filtered: false,
          error: String(err),
          candidates: [],
        };
      }
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_list_trusted_sources(deps.specialists) as Tool;
}
