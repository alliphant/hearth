import { z } from 'zod';

/**
 * household_good — a purchased physical good the household tracks, the first
 * node type of the Household Knowledge Graph (2026-06-20). A PROJECTED note
 * type (Zod schema here + a `household_goods` SQLite table in structured.ts +
 * a projector in apps/ingestor/project.ts), so it is BOTH RAG-searchable
 * (chunks_fts, via the vault note) AND date-scannable (the projected table,
 * for the warranty/return-window reactive triggers).
 *
 * Derived from an order signal (mail_orders → enrich) today; manual / capture
 * sources later. Shared across specialists who each read their slice — Vivian
 * (cost), Luna (warranty/manual), Kate (the running picture) — so it stamps
 * `private_to: 'household'` for owner+household goods (the shared-entity
 * cordon, mirroring People/Places), or the buyer's user_id for a personal good.
 *
 * The note body carries `[[owner]]` / `[[merchant]]` wikilinks → graph_edges
 * for free; the TYPED inference edges (owned-by / purchased-from / implies)
 * live in the knowledge_edges store.
 */
export const HouseholdGoodFrontmatter = z
  .object({
    type: z.literal('household_good'),
    id: z.string().regex(/^hg_[a-z0-9]{6,}$/),
    name: z.string().min(1),
    /** electronics | appliance | clothing | home | grocery | tool | other — free text, classifier-assigned. */
    category: z.string().optional(),
    merchant: z.string().optional(),
    /** Stable link back to the originating order (mail_orders.order_key) for idempotent re-projection. */
    order_key: z.string().optional(),
    /** Display name of the household member who owns/bought it (rendered as a [[wikilink]] in the body). */
    owner: z.string().optional(),
    purchase_date: z.string().optional(), // ISO date or datetime
    cost: z.number().nonnegative().optional(),
    currency: z.string().default('USD'),
    /** Implication dates the enricher derives — drive the reactive triggers. */
    warranty_until: z.string().optional(), // ISO date
    return_window_until: z.string().optional(), // ISO date
    manual_url: z.string().optional(),
    condition: z.enum(['new', 'like-new', 'good', 'fair', 'poor']).default('new'),
    status: z.enum(['active', 'returned', 'retired']).default('active'),
    /** Where this record came from. */
    source: z.enum(['mail', 'capture', 'manual']).default('manual'),
    source_message_id: z.string().optional(),
    source_capture_id: z.string().optional(),
    notes: z.string().optional(),
    // Phase 2b — per-note visibility scope (see src/memory/private_to.ts).
    private_to: z.string().optional(),
  })
  .passthrough();

export type HouseholdGood = z.infer<typeof HouseholdGoodFrontmatter>;
