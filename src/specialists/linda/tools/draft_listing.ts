/**
 * draft_listing — Linda's deliverable. She composes three marketplace
 * listings for one item (eBay / Poshmark / Facebook Marketplace) in her
 * turn, then calls this tool with the listings as structured args. The
 * tool persists a `listing_drafts` row (per-user, idempotent on the item)
 * and emits `listing_draft_created` so the web client renders a copy-ready
 * listing card. It returns immediately with the draft id so Linda's
 * closing prose stays tight ("Three drafts below — copy each into its
 * marketplace.").
 *
 * Linda authors the listing COPY (that's her craft — SEO titles, boutique
 * voice, charm pricing); this tool is the persistence + render primitive,
 * mirroring how `present_questions` renders an LLM-authored form. Listings
 * are CARDS, never proposals — that's what keeps a friend-tier seller out
 * of the owner's global proposal queue.
 *
 * Requires `write_vault_linda` (a durable per-user write); risk
 * `write_internal`.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { ListingDraftsStore } from '@memory/stores/listing_drafts';

const ItemSpecificSchema = z.object({
  key: z.string().min(1).max(60).describe('eBay item-specific field name, e.g. "Brand", "Size", "Material", "Color", "Department".'),
  value: z.string().min(1).max(120).describe('The value for that field, e.g. "Patagonia", "M", "Merino Wool".'),
});

const EbaySchema = z.object({
  title: z
    .string()
    .min(3)
    .max(80)
    .describe('SEO title, up to 80 chars, keywords FIRST (Brand + Model/Type + Key Attributes + Size + Condition). No filler adjectives. This is the single biggest search-ranking factor.'),
  category: z.string().max(120).optional().describe('eBay category path if known, e.g. "Clothing > Men > Coats & Jackets".'),
  condition: z.string().min(1).max(60).describe('eBay condition, e.g. "Pre-owned - Excellent", "New with tags".'),
  item_specifics: z
    .array(ItemSpecificSchema)
    .min(1)
    .max(20)
    .describe('Fill as many item specifics as the seller-provided facts support — unfilled specifics drop the listing out of filtered search.'),
  description: z.string().min(10).max(4000).describe('Full description: benefits + concrete details, flaws stated plainly, scannable.'),
  price: z.number().positive().describe('Suggested price in USD, comp-anchored. Use charm pricing where it fits.'),
  format: z.enum(['fixed_price', 'auction']).describe('"auction" only for hot/identifiable items; otherwise "fixed_price".'),
  price_rationale: z.string().min(3).max(300).describe('One line on WHY this price (the comps + the psychology), so the seller learns it.'),
});

const PoshmarkSchema = z.object({
  title: z.string().min(3).max(80).describe('Brand + Item Type + Model + Key Attributes + Size. Keywords front; skip filler like "gorgeous".'),
  brand: z.string().max(80).optional(),
  size: z.string().max(40).optional(),
  category: z.string().min(1).max(120).describe('Poshmark category, e.g. "Women > Jackets & Coats > Puffers".'),
  condition: z.string().min(1).max(40).describe('NWT / EUC / GUC / Fair — state it plainly.'),
  description: z.string().min(10).max(2000).describe('Boutique voice: styling/occasion, fit notes, condition, flaws disclosed.'),
  hashtags: z
    .array(z.string().min(1).max(40))
    .max(3)
    .describe('Up to 3 hashtags. Use them for trends/aesthetics, NOT brand or size (those belong in the title).'),
  price: z.number().positive().describe('List with deliberate room for an offer — a touch high so the "make an offer" buyer feels like they won.'),
  price_rationale: z.string().min(3).max(300),
});

const FacebookSchema = z.object({
  title: z.string().min(3).max(120).describe('Clear, keyword-front, plain-English. e.g. "Patagonia Down Jacket Men\'s M Black – Excellent".'),
  category: z.string().max(120).optional(),
  condition: z.string().min(1).max(60),
  description: z.string().min(10).max(2000).describe('Honest plain-English, scannable. Spell out pickup vs. shipping.'),
  price: z.number().positive().describe('Price slightly relative to local comps; charm pricing helps ($49 not $50).'),
  delivery: z.literal('local').describe('Always "local". Facebook Marketplace listings are LOCAL PICKUP ONLY — never offer shipping here.'),
  price_rationale: z.string().min(3).max(300),
});

const InputSchema = z.object({
  item_title: z
    .string()
    .min(2)
    .max(120)
    .describe('A short internal label for the item (e.g. "Patagonia down jacket, M"). Used as the card heading and to dedup re-drafts.'),
  item_ref: z
    .string()
    .max(120)
    .optional()
    .describe('Stable reference for THIS item so a re-draft updates in place instead of duplicating — pass the source capture id when the item came from a routed photo, else omit and the item_title is used.'),
  comps_summary: z
    .string()
    .max(1000)
    .optional()
    .describe('One short paragraph on what the comp research found (sold-price range, hot keywords) — shown on the card so the seller sees the pricing basis.'),
  ebay: EbaySchema,
  poshmark: PoshmarkSchema,
  facebook: FacebookSchema,
});

const OutputSchema = z.object({
  listing_draft_id: z.string().describe('Stable id for this draft; appears in the SSE event and the listing-drafts route.'),
  status: z.literal('draft'),
  conversation_id: z.string().nullable(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const DESCRIPTION =
  'Publish the three marketplace listings you composed for ONE item as a copy-ready card (eBay + Poshmark + Facebook Marketplace). Call this ONLY after you have the seller-provided facts (brand, size, condition, flaws) AND have checked sold-comp pricing — never draft from a photo alone. You author the listing copy; this tool renders + saves it as a card the seller copies into each marketplace. Keep your closing prose tight ("Three drafts below — copy each into its marketplace, and tell me if you want the price nudged."); the card is the substance, so do NOT re-narrate the listings in prose.';

function dedup_slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'item'
  );
}

export function create(deps: ToolDeps): Tool<Input, Output> {
  const store = new ListingDraftsStore(deps.db);

  return {
    name: 'draft_listing',
    description: DESCRIPTION,
    risk: 'write_internal',
    required_capabilities: ['write_vault_linda'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.item_ref ?? input.item_title);
      h.update('\n');
      h.update(JSON.stringify(input.ebay));
      h.update(JSON.stringify(input.poshmark));
      h.update(JSON.stringify(input.facebook));
      return `draft_listing:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      if (!ctx.specialist_id) {
        throw new Error(
          'draft_listing requires specialist_id on ToolContext — it can only be called from inside a specialist turn.',
        );
      }
      const user_id = ctx.user?.id;
      if (!user_id) {
        throw new Error(
          'draft_listing requires a user on ToolContext — a listing draft is always owned by the seller who requested it.',
        );
      }

      // Deliberation uses synthetic conversation ids (`deliberation:<sid>:<slot>`)
      // not backed by a conversations row — persist with null in that case,
      // exactly like present_questions.
      const is_deliberation = (ctx.conversation_id ?? '').startsWith('deliberation:');
      const conversation_id: string | null = is_deliberation
        ? null
        : (ctx.conversation_id ?? null);

      const row = store.upsert({
        user_id,
        specialist_id: ctx.specialist_id,
        conversation_id,
        item_title: input.item_title,
        listings: {
          ebay: input.ebay,
          poshmark: input.poshmark,
          facebook: input.facebook,
        },
        comps_summary: input.comps_summary ?? null,
        source_capture_id: input.item_ref ?? null,
        dedup_key: input.item_ref ?? dedup_slug(input.item_title),
      });

      deps.events.emit({
        type: 'listing_draft_created',
        listing_draft_id: row.id,
        specialist_id: ctx.specialist_id,
        conversation_id,
        user_id,
      });

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id,
        tool_name: 'draft_listing',
        tool_input: {
          conversation_id,
          item_title: input.item_title,
          ebay_price: input.ebay.price,
          poshmark_price: input.poshmark.price,
          facebook_price: input.facebook.price,
        },
        execution_result: { listing_draft_id: row.id },
        user_id,
      });

      return {
        listing_draft_id: row.id,
        status: 'draft',
        conversation_id,
      };
    },
  };
}
