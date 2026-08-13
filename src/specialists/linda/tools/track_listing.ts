/**
 * track_listing — Linda's outcome tracker, the write side of her resale
 * office. After she drafts the three platform listings and the seller picks
 * one (the post-draft multiple-choice), Linda calls this to open a tracked
 * card in her office: which marketplace, when it was listed, the list price,
 * and (optionally) what the seller paid for it. As the item's life unfolds —
 * a price drop, a sale — she calls it again with just the new fact and the
 * same `item_ref`, and the card updates in place.
 *
 * One flexible lifecycle tool rather than three narrow ones: every field is
 * optional, the store merges field-by-field (an undefined field keeps its
 * prior value), and `add_price_drop` appends a single markdown event. So a
 * "she dropped it to $40" turn is `track_listing({ item_ref, add_price_drop:
 * {...} })` and a "it sold for $38" turn is `track_listing({ item_ref,
 * status: 'sold', sold_price: 38, sold_at })`.
 *
 * Reuses Linda's existing `write_vault_linda` capability (same durable
 * per-user write family as `draft_listing`); risk `write_internal`. The
 * tracked items are per-user CARDS, never proposals — same isolation that
 * keeps a friend-tier seller (Kim) out of the owner's proposal queue.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { ResaleItemsStore } from '@memory/stores/resale_items';

const PriceDropSchema = z.object({
  at: z
    .string()
    .min(4)
    .max(40)
    .describe('ISO date the price was dropped, e.g. "2026-06-10". If the seller gives a vague day, resolve it to a date.'),
  price: z.number().positive().describe('The NEW price after the drop, USD.'),
});

const InputSchema = z.object({
  item_title: z
    .string()
    .min(2)
    .max(120)
    .optional()
    .describe('Short label for the item (e.g. "Patagonia down jacket, M") — the card heading. REQUIRED on the FIRST call for a new card; OMIT it on follow-up turns that pass item_ref (a price drop / sale) — the existing card keeps its title.'),
  item_ref: z
    .string()
    .max(120)
    .optional()
    .describe('STRONGLY PREFERRED: a stable reference for THIS item so follow-up turns (price drop, sale) update the same card instead of forking. Pass the listing_draft_id when the item came from draft_listing, else the source capture id. Omit only for a one-off item with no draft.'),
  listing_draft_id: z
    .string()
    .max(120)
    .optional()
    .describe('The draft_listing id this tracked item came from, if any — links the card back to the composed listings.'),
  source_capture_id: z
    .string()
    .max(120)
    .optional()
    .describe('The Cordelia capture id of the item photo, if the item came from a routed photo. Drives the card thumbnail in the office.'),
  category: z.string().max(80).optional().describe('Loose category for the per-category view, e.g. "outerwear", "homeware", "footwear".'),
  platform: z
    .enum(['ebay', 'poshmark', 'facebook', 'other'])
    .optional()
    .describe('The marketplace the seller actually listed on — the answer to the post-draft "which one did you go with?" choice.'),
  status: z
    .enum(['active', 'sold', 'unsold', 'archived'])
    .optional()
    .describe('Lifecycle state. Defaults to "active" on a new card. Set "sold" when the seller reports a sale (with sold_price + sold_at), "unsold" if she pulled it without selling, "archived" to hide it.'),
  list_price: z.number().positive().optional().describe('The price she listed it at, USD.'),
  listed_at: z
    .string()
    .max(40)
    .optional()
    .describe('ISO date she listed it, e.g. "2026-06-03". Needed for days-to-sell + sell-through.'),
  add_price_drop: PriceDropSchema.optional().describe('Append a single markdown event when the seller reports she dropped the price.'),
  sold_price: z.number().positive().optional().describe('The final sale price, USD — set together with status "sold".'),
  sold_at: z.string().max(40).optional().describe('ISO date it sold, e.g. "2026-06-14".'),
  cost_basis: z.number().nonnegative().optional().describe('What the seller PAID for the item, USD — optional, enables profit/margin in the office.'),
  fees: z.number().nonnegative().optional().describe('Platform/shipping fees on the sale, USD — optional, refines profit.'),
  notes: z.string().max(500).optional().describe('Any short note worth keeping on the card.'),
}).refine((v) => v.item_ref !== undefined || v.item_title !== undefined, {
  message:
    'Provide item_ref (to update an existing tracked card — a price drop or sale) or item_title (to open a new card).',
});

const OutputSchema = z.object({
  resale_item_id: z.string().describe('Stable id for this tracked item; appears in the SSE event and the office pane.'),
  status: z.enum(['active', 'sold', 'unsold', 'archived']),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const DESCRIPTION =
  'Track one resale item through its life so it shows as a card in your office and feeds your sales metrics. Call it FIRST when the seller tells you which marketplace she listed on (after you draft + she picks one) — pass item_title, platform, list_price, listed_at, and item_ref (the draft id) so future updates hit the same card. Call it AGAIN with just item_ref + the new fact when she reports a price drop (add_price_drop) or a sale (status:"sold", sold_price, sold_at). Optionally record cost_basis (what she paid) to unlock profit. This is a quiet bookkeeping action — acknowledge it in one short line ("Tracked — that\'s on your resale board now."), do not re-list the item back to her.';

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
  const store = new ResaleItemsStore(deps.db);

  return {
    name: 'track_listing',
    description: DESCRIPTION,
    risk: 'write_internal',
    required_capabilities: ['write_vault_linda'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.item_ref ?? input.item_title ?? '');
      h.update('\n');
      // The mutating facts of THIS turn — so a re-send of the identical
      // lifecycle update dedups, but a genuine new fact (drop, sale) doesn't.
      h.update(
        JSON.stringify({
          status: input.status ?? null,
          list_price: input.list_price ?? null,
          listed_at: input.listed_at ?? null,
          add_price_drop: input.add_price_drop ?? null,
          sold_price: input.sold_price ?? null,
          sold_at: input.sold_at ?? null,
        }),
      );
      return `track_listing:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      if (!ctx.specialist_id) {
        throw new Error(
          'track_listing requires specialist_id on ToolContext — it can only be called from inside a specialist turn.',
        );
      }
      const user_id = ctx.user?.id;
      if (!user_id) {
        throw new Error(
          'track_listing requires a user on ToolContext — a tracked item is always owned by the seller.',
        );
      }

      const row = store.upsert({
        user_id,
        specialist_id: ctx.specialist_id,
        dedup_key: input.item_ref ?? dedup_slug(input.item_title ?? ''),
        ...(input.item_title !== undefined ? { item_title: input.item_title } : {}),
        ...(input.listing_draft_id !== undefined ? { listing_draft_id: input.listing_draft_id } : {}),
        ...(input.source_capture_id !== undefined ? { source_capture_id: input.source_capture_id } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.platform !== undefined ? { platform: input.platform } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.list_price !== undefined ? { list_price: input.list_price } : {}),
        ...(input.listed_at !== undefined ? { listed_at: input.listed_at } : {}),
        ...(input.add_price_drop !== undefined ? { add_price_drop: input.add_price_drop } : {}),
        ...(input.sold_price !== undefined ? { sold_price: input.sold_price } : {}),
        ...(input.sold_at !== undefined ? { sold_at: input.sold_at } : {}),
        ...(input.cost_basis !== undefined ? { cost_basis: input.cost_basis } : {}),
        ...(input.fees !== undefined ? { fees: input.fees } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      });

      deps.events.emit({
        type: 'resale_item_updated',
        resale_item_id: row.id,
        specialist_id: ctx.specialist_id,
        user_id,
      });

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id,
        tool_name: 'track_listing',
        tool_input: {
          item_title: input.item_title ?? row.item_title,
          platform: input.platform ?? row.platform,
          status: row.status,
          list_price: input.list_price ?? null,
          sold_price: input.sold_price ?? null,
          dropped: input.add_price_drop ? input.add_price_drop.price : null,
        },
        execution_result: { resale_item_id: row.id, status: row.status },
        user_id,
      });

      return { resale_item_id: row.id, status: row.status };
    },
  };
}
