/**
 * Persistence for the `draft_listing` tool.
 *
 * Linda (Resale & Marketplace Strategist) composes three platform
 * listings for an item the seller handed her — eBay, Poshmark, Facebook
 * Marketplace — then calls `draft_listing` with the listings as structured
 * args. Each call upserts a row here (idempotent on user + item via
 * dedup_key); the web client renders the listing card; the seller copies
 * each platform's fields straight into the marketplace. See
 * `src/specialists/linda/tools/draft_listing.ts` for the tool and the
 * `/api/listing-drafts/...` routes in `routes/specialists.ts`.
 *
 * Per-user scoped (`user_id`): a friend-tier seller's drafts never collide
 * with the owner's or another seller's — the cards-not-proposals design
 * that keeps Kim out of the (not-yet-user-scoped) proposal queue.
 */

import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';

/** One eBay listing — SEO title + complete item specifics + comp price. */
export interface EbayListing {
  title: string; // <= 80 chars, keyword-front
  category?: string;
  condition: string;
  item_specifics: { key: string; value: string }[];
  description: string;
  price: number;
  format: 'fixed_price' | 'auction';
  price_rationale: string;
}

/** One Poshmark listing — boutique voice + <=3 hashtags + offer room. */
export interface PoshmarkListing {
  title: string;
  brand?: string;
  size?: string;
  category: string;
  condition: string; // NWT / EUC / GUC / Fair
  description: string;
  hashtags: string[]; // <= 3, trends not brand/size
  price: number;
  price_rationale: string;
}

/** One Facebook Marketplace listing — local, plain-spoken, firm/OBO. */
export interface FacebookListing {
  title: string;
  category?: string;
  condition: string;
  description: string;
  price: number;
  delivery: 'local' | 'shipping' | 'both';
  price_rationale: string;
}

export interface ListingSet {
  ebay: EbayListing;
  poshmark: PoshmarkListing;
  facebook: FacebookListing;
}

export interface ListingDraftRow {
  id: string;
  ts_created: string;
  ts_updated: string;
  user_id: string;
  specialist_id: string;
  conversation_id: string | null;
  item_title: string;
  listings: ListingSet;
  comps_summary: string | null;
  source_capture_id: string | null;
  status: 'draft' | 'published' | 'archived';
}

interface RawRow {
  id: string;
  ts_created: string;
  ts_updated: string;
  user_id: string;
  specialist_id: string;
  conversation_id: string | null;
  item_title: string;
  listings_json: string;
  comps_summary: string | null;
  source_capture_id: string | null;
  status: 'draft' | 'published' | 'archived';
}

function hydrate(row: RawRow): ListingDraftRow {
  let listings: ListingSet;
  try {
    listings = JSON.parse(row.listings_json) as ListingSet;
  } catch {
    // A corrupt blob shouldn't take down the card render — surface an
    // empty set the client can show as "draft unavailable".
    listings = {} as ListingSet;
  }
  return {
    id: row.id,
    ts_created: row.ts_created,
    ts_updated: row.ts_updated,
    user_id: row.user_id,
    specialist_id: row.specialist_id,
    conversation_id: row.conversation_id,
    item_title: row.item_title,
    listings,
    comps_summary: row.comps_summary,
    source_capture_id: row.source_capture_id,
    status: row.status,
  };
}

export class ListingDraftsStore {
  constructor(private db: Database) {}

  /**
   * Upsert a listing draft. Idempotent on (user_id, dedup_key): re-drafting
   * the same item (same source capture / item ref) overwrites the prior
   * draft in place rather than creating a duplicate card. Returns the
   * persisted row.
   */
  upsert(input: {
    user_id: string;
    specialist_id: string;
    conversation_id?: string | null;
    item_title: string;
    listings: ListingSet;
    comps_summary?: string | null;
    source_capture_id?: string | null;
    dedup_key: string;
  }): ListingDraftRow {
    const ts = new Date().toISOString();
    const listings_json = JSON.stringify(input.listings);
    // Reuse the existing id when this (user, item) already has a draft so
    // the card the seller is looking at updates in place.
    const existing = this.db
      .prepare(
        `SELECT id, ts_created FROM listing_drafts
          WHERE user_id = @uid AND dedup_key = @dk`,
      )
      .get({ '@uid': input.user_id, '@dk': input.dedup_key }) as
      | { id: string; ts_created: string }
      | undefined;
    const id = existing?.id ?? `lst_${ulid().toLowerCase().slice(-12)}`;
    const ts_created = existing?.ts_created ?? ts;
    this.db
      .prepare(
        `INSERT INTO listing_drafts
           (id, user_id, specialist_id, conversation_id, item_title,
            listings_json, comps_summary, source_capture_id, status,
            dedup_key, ts_created, ts_updated)
         VALUES (@id, @uid, @sid, @cid, @title, @lj, @cs, @scid, 'draft',
                 @dk, @tc, @tu)
         ON CONFLICT(user_id, dedup_key) DO UPDATE SET
           conversation_id = excluded.conversation_id,
           item_title      = excluded.item_title,
           listings_json   = excluded.listings_json,
           comps_summary   = excluded.comps_summary,
           source_capture_id = excluded.source_capture_id,
           ts_updated      = excluded.ts_updated`,
      )
      .run({
        '@id': id,
        '@uid': input.user_id,
        '@sid': input.specialist_id,
        '@cid': input.conversation_id ?? null,
        '@title': input.item_title,
        '@lj': listings_json,
        '@cs': input.comps_summary ?? null,
        '@scid': input.source_capture_id ?? null,
        '@dk': input.dedup_key,
        '@tc': ts_created,
        '@tu': ts,
      });
    return {
      id,
      ts_created,
      ts_updated: ts,
      user_id: input.user_id,
      specialist_id: input.specialist_id,
      conversation_id: input.conversation_id ?? null,
      item_title: input.item_title,
      listings: input.listings,
      comps_summary: input.comps_summary ?? null,
      source_capture_id: input.source_capture_id ?? null,
      status: 'draft',
    };
  }

  /** Fetch one draft by id, scoped to a user (cross-user reads return null). */
  get(id: string, user_id?: string): ListingDraftRow | null {
    const r = this.db
      .prepare(`SELECT * FROM listing_drafts WHERE id = @id`)
      .get({ '@id': id }) as RawRow | undefined;
    if (!r) return null;
    if (user_id && r.user_id !== user_id) return null;
    return hydrate(r);
  }

  list_for_conversation(conversation_id: string): ListingDraftRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM listing_drafts
          WHERE conversation_id = @cid
          ORDER BY ts_created ASC`,
      )
      .all({ '@cid': conversation_id }) as RawRow[];
    return rows.map(hydrate);
  }

  list_for_user(user_id: string, limit = 50): ListingDraftRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM listing_drafts
          WHERE user_id = @uid
          ORDER BY ts_updated DESC LIMIT @lim`,
      )
      .all({ '@uid': user_id, '@lim': limit }) as RawRow[];
    return rows.map(hydrate);
  }
}
