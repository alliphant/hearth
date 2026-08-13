/**
 * Persistence for Linda's resale sales ledger — the outcome layer that
 * sits over `listing_drafts`.
 *
 * `draft_listing` composes the three platform drafts; this store tracks
 * what the seller ACTUALLY did with one: which marketplace she ran it on,
 * when she listed it, at what price, any markdowns, and the final sale
 * price. One row per tracked item, lifecycle `active → sold | unsold |
 * archived`. Linda's `resale` office pane (`compose_resale_pane`) reads
 * the active/recently-sold lists + the aggregate `sales_metrics` from
 * here; `track_listing` writes it and `query_sales_history` reads it.
 *
 * Per-user scoped (`user_id`): a friend-tier seller's ledger never collides
 * with the owner's or another seller's — the same isolation `listing_drafts`
 * uses. Idempotent on `(user_id, dedup_key)` so a lifecycle update (price
 * drop, sale) upserts the existing card in place instead of forking it.
 *
 * Metrics are computed in JS over the per-user rows rather than in SQL:
 * household-scale volume is tiny, and the discount / days-to-sell / drop-
 * count math reads far clearer as plain TypeScript than as nested SQL.
 */

import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import { local_iso_date } from '@core/time';
import { estimate_platform_fee } from '@connectors/marketplace_fees';

export type ResalePlatform = 'ebay' | 'poshmark' | 'facebook' | 'other';
export type ResaleStatus = 'active' | 'sold' | 'unsold' | 'archived';

/** One markdown event on an item — when the seller dropped the price and to what. */
export interface PriceDrop {
  /** ISO date (or datetime) the price was dropped. */
  at: string;
  /** The new price after the drop, USD. */
  price: number;
}

export interface ResaleItemRow {
  id: string;
  ts_created: string;
  ts_updated: string;
  user_id: string;
  specialist_id: string;
  listing_draft_id: string | null;
  source_capture_id: string | null;
  item_title: string;
  category: string | null;
  platform: ResalePlatform | null;
  status: ResaleStatus;
  list_price: number | null;
  listed_at: string | null;
  price_drops: PriceDrop[];
  sold_price: number | null;
  sold_at: string | null;
  cost_basis: number | null;
  fees: number | null;
  notes: string | null;
}

interface RawRow {
  id: string;
  ts_created: string;
  ts_updated: string;
  user_id: string;
  specialist_id: string;
  listing_draft_id: string | null;
  source_capture_id: string | null;
  item_title: string;
  category: string | null;
  platform: ResalePlatform | null;
  status: ResaleStatus;
  list_price: number | null;
  listed_at: string | null;
  price_drops_json: string | null;
  sold_price: number | null;
  sold_at: string | null;
  cost_basis: number | null;
  fees: number | null;
  notes: string | null;
}

function parse_drops(json: string | null): PriceDrop[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (d): d is PriceDrop =>
        !!d && typeof d === 'object' && typeof (d as PriceDrop).price === 'number',
    );
  } catch {
    return [];
  }
}

function hydrate(row: RawRow): ResaleItemRow {
  return {
    id: row.id,
    ts_created: row.ts_created,
    ts_updated: row.ts_updated,
    user_id: row.user_id,
    specialist_id: row.specialist_id,
    listing_draft_id: row.listing_draft_id,
    source_capture_id: row.source_capture_id,
    item_title: row.item_title,
    category: row.category,
    platform: row.platform,
    status: row.status,
    list_price: row.list_price,
    listed_at: row.listed_at,
    price_drops: parse_drops(row.price_drops_json),
    sold_price: row.sold_price,
    sold_at: row.sold_at,
    cost_basis: row.cost_basis,
    fees: row.fees,
    notes: row.notes,
  };
}

/** Per-platform rollup for the office's stacked strip + breakdown. */
export interface PlatformStat {
  platform: ResalePlatform;
  revenue: number;
  sold_count: number;
}

/** One zero-filled weekly bucket of realized revenue, oldest first. */
export interface RevenueWeek {
  /** ISO date of the bucket's start (the Monday-agnostic 7-day window start). */
  week_start: string;
  revenue: number;
}

export interface SalesMetrics {
  total_revenue: number;
  total_sales: number;
  active_count: number;
  /** Net profit over sold rows that carry a cost_basis; null when none do. */
  net_profit: number | null;
  /** Margin % of that same cost-bearing revenue; null when no cost data. */
  margin_pct: number | null;
  /** Sold ÷ (items ever listed). null until at least one item was listed. */
  sell_through_pct: number | null;
  /** Mean days from listed_at to sold_at over sold rows that have both. */
  avg_days_to_sell: number | null;
  /** Mean (list−sold)/list % over sold rows with a list price. */
  avg_discount_pct: number | null;
  /** Mean number of price drops before a sale. */
  avg_drops: number | null;
  by_platform: PlatformStat[];
  revenue_by_week: RevenueWeek[];
}

const PLATFORM_ORDER: ResalePlatform[] = ['ebay', 'poshmark', 'facebook', 'other'];

function day_diff(from_iso: string, to_iso: string): number | null {
  const a = Date.parse(from_iso);
  const b = Date.parse(to_iso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / (24 * 60 * 60 * 1000)));
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

export class ResaleItemsStore {
  constructor(private db: Database) {}

  /**
   * Upsert a tracked resale item. Idempotent on `(user_id, dedup_key)`:
   * re-tracking the same item (price drop, sale, status change) overwrites
   * the prior row in place. Fields left `undefined` on the input are NOT
   * touched on an existing row (a price-drop turn carries only the drop +
   * the dedup key, not the whole item), so the lifecycle accretes rather
   * than clobbering. Returns the persisted row.
   */
  upsert(input: {
    user_id: string;
    specialist_id: string;
    dedup_key: string;
    item_title?: string;
    listing_draft_id?: string | null;
    source_capture_id?: string | null;
    category?: string | null;
    platform?: ResalePlatform | null;
    status?: ResaleStatus;
    list_price?: number | null;
    listed_at?: string | null;
    /** Replace the whole drops array (rare — prefer add_price_drop). */
    price_drops?: PriceDrop[];
    /** Append a single markdown event to the existing drops array. */
    add_price_drop?: PriceDrop;
    sold_price?: number | null;
    sold_at?: string | null;
    cost_basis?: number | null;
    fees?: number | null;
    notes?: string | null;
  }): ResaleItemRow {
    const ts = new Date().toISOString();
    const existing = this.db
      .prepare(`SELECT * FROM resale_items WHERE user_id = @uid AND dedup_key = @dk`)
      .get({ '@uid': input.user_id, '@dk': input.dedup_key }) as RawRow | undefined;
    const prev = existing ? hydrate(existing) : null;

    const id = prev?.id ?? `rsl_${ulid().toLowerCase().slice(-12)}`;
    const ts_created = prev?.ts_created ?? ts;

    // Field-level merge: an undefined input field keeps the prior value.
    const pick = <T>(next: T | undefined, prior: T): T => (next === undefined ? prior : next);

    let drops: PriceDrop[] = pick(input.price_drops, prev?.price_drops ?? []);
    if (input.add_price_drop) drops = [...drops, input.add_price_drop];

    const merged = {
      item_title: pick(input.item_title, prev?.item_title ?? input.item_title ?? 'item'),
      listing_draft_id: pick(input.listing_draft_id, prev?.listing_draft_id ?? null),
      source_capture_id: pick(input.source_capture_id, prev?.source_capture_id ?? null),
      category: pick(input.category, prev?.category ?? null),
      platform: pick(input.platform, prev?.platform ?? null),
      status: pick(input.status, prev?.status ?? 'active'),
      list_price: pick(input.list_price, prev?.list_price ?? null),
      listed_at: pick(input.listed_at, prev?.listed_at ?? null),
      sold_price: pick(input.sold_price, prev?.sold_price ?? null),
      sold_at: pick(input.sold_at, prev?.sold_at ?? null),
      cost_basis: pick(input.cost_basis, prev?.cost_basis ?? null),
      fees: pick(input.fees, prev?.fees ?? null),
      notes: pick(input.notes, prev?.notes ?? null),
    };

    this.db
      .prepare(
        `INSERT INTO resale_items
           (id, user_id, specialist_id, listing_draft_id, source_capture_id,
            item_title, category, platform, status, list_price, listed_at,
            price_drops_json, sold_price, sold_at, cost_basis, fees, notes,
            dedup_key, ts_created, ts_updated)
         VALUES (@id, @uid, @sid, @ldid, @scid,
                 @title, @cat, @plat, @status, @lp, @lat,
                 @drops, @sp, @sat, @cb, @fees, @notes,
                 @dk, @tc, @tu)
         ON CONFLICT(user_id, dedup_key) DO UPDATE SET
           listing_draft_id  = excluded.listing_draft_id,
           source_capture_id = excluded.source_capture_id,
           item_title        = excluded.item_title,
           category          = excluded.category,
           platform          = excluded.platform,
           status            = excluded.status,
           list_price        = excluded.list_price,
           listed_at         = excluded.listed_at,
           price_drops_json  = excluded.price_drops_json,
           sold_price        = excluded.sold_price,
           sold_at           = excluded.sold_at,
           cost_basis        = excluded.cost_basis,
           fees              = excluded.fees,
           notes             = excluded.notes,
           ts_updated        = excluded.ts_updated`,
      )
      .run({
        '@id': id,
        '@uid': input.user_id,
        '@sid': input.specialist_id,
        '@ldid': merged.listing_draft_id,
        '@scid': merged.source_capture_id,
        '@title': merged.item_title,
        '@cat': merged.category,
        '@plat': merged.platform,
        '@status': merged.status,
        '@lp': merged.list_price,
        '@lat': merged.listed_at,
        '@drops': drops.length > 0 ? JSON.stringify(drops) : null,
        '@sp': merged.sold_price,
        '@sat': merged.sold_at,
        '@cb': merged.cost_basis,
        '@fees': merged.fees,
        '@notes': merged.notes,
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
      price_drops: drops,
      ...merged,
    };
  }

  get(id: string, user_id?: string): ResaleItemRow | null {
    const r = this.db
      .prepare(`SELECT * FROM resale_items WHERE id = @id`)
      .get({ '@id': id }) as RawRow | undefined;
    if (!r) return null;
    if (user_id && r.user_id !== user_id) return null;
    return hydrate(r);
  }

  /** Active (still-listed) items, newest activity first. */
  list_active(user_id: string, limit = 50): ResaleItemRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM resale_items
          WHERE user_id = @uid AND status = 'active'
          ORDER BY ts_updated DESC LIMIT @lim`,
      )
      .all({ '@uid': user_id, '@lim': limit }) as RawRow[];
    return rows.map(hydrate);
  }

  /** Recently sold items, most-recent sale first. */
  list_recent_sold(user_id: string, limit = 10): ResaleItemRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM resale_items
          WHERE user_id = @uid AND status = 'sold'
          ORDER BY COALESCE(sold_at, ts_updated) DESC LIMIT @lim`,
      )
      .all({ '@uid': user_id, '@lim': limit }) as RawRow[];
    return rows.map(hydrate);
  }

  list_for_user(user_id: string, limit = 200): ResaleItemRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM resale_items
          WHERE user_id = @uid
          ORDER BY ts_updated DESC LIMIT @lim`,
      )
      .all({ '@uid': user_id, '@lim': limit }) as RawRow[];
    return rows.map(hydrate);
  }

  /**
   * Aggregate sales metrics for the office hero + performance block.
   * Pure read; computed in JS over the user's rows.
   */
  sales_metrics(user_id: string, now: Date = new Date()): SalesMetrics {
    const rows = this.list_for_user(user_id, 1000);
    const sold = rows.filter((r) => r.status === 'sold' && r.sold_price != null);

    const total_revenue = sold.reduce((s, r) => s + (r.sold_price ?? 0), 0);
    const total_sales = sold.length;
    const active_count = rows.filter((r) => r.status === 'active').length;

    // Profit only over sold rows that actually carry a cost basis. Fees
    // fall back to a platform estimate when the seller didn't record an
    // exact number, so profit reflects real take-home rather than pretending
    // the marketplace took nothing.
    const cost_rows = sold.filter((r) => r.cost_basis != null);
    const cost_revenue = cost_rows.reduce((s, r) => s + (r.sold_price ?? 0), 0);
    const net_profit =
      cost_rows.length > 0
        ? cost_rows.reduce((s, r) => {
            const fee =
              r.fees ?? estimate_platform_fee(r.platform, r.sold_price ?? 0, { category: r.category }).fee;
            return s + (r.sold_price ?? 0) - (r.cost_basis ?? 0) - fee;
          }, 0)
        : null;
    const margin_pct =
      net_profit != null && cost_revenue > 0 ? (net_profit / cost_revenue) * 100 : null;

    // Sell-through: sold ÷ everything that was ever genuinely listed
    // (listed_at set, or already concluded as sold/unsold).
    const ever_listed = rows.filter(
      (r) => r.listed_at != null || r.status === 'sold' || r.status === 'unsold',
    ).length;
    const sell_through_pct = ever_listed > 0 ? (total_sales / ever_listed) * 100 : null;

    const days = sold
      .map((r) => (r.listed_at && r.sold_at ? day_diff(r.listed_at, r.sold_at) : null))
      .filter((d): d is number => d != null);
    const avg_days_to_sell = mean(days);

    const discounts = sold
      .filter((r) => r.list_price != null && r.list_price > 0 && r.sold_price != null)
      .map((r) => ((r.list_price! - r.sold_price!) / r.list_price!) * 100);
    const avg_discount_pct = mean(discounts);

    const avg_drops = mean(sold.map((r) => r.price_drops.length));

    // Per-platform revenue + count, in a stable order, dropping empties.
    const by_platform: PlatformStat[] = PLATFORM_ORDER.map((platform) => {
      const ps = sold.filter((r) => r.platform === platform);
      return {
        platform,
        revenue: ps.reduce((s, r) => s + (r.sold_price ?? 0), 0),
        sold_count: ps.length,
      };
    }).filter((s) => s.sold_count > 0);

    const revenue_by_week = this.build_revenue_by_week(sold, now);

    return {
      total_revenue,
      total_sales,
      active_count,
      net_profit,
      margin_pct,
      sell_through_pct,
      avg_days_to_sell,
      avg_discount_pct,
      avg_drops,
      by_platform,
      revenue_by_week,
    };
  }

  /**
   * Days-to-sell benchmarks for the aging radar: overall average + a
   * per-category breakdown (avg + sample count), over sold rows that have
   * both `listed_at` and `sold_at`. The radar prefers a category benchmark
   * when the sample is big enough, else overall, else a sensible default.
   */
  days_to_sell_benchmarks(user_id: string): {
    overall: number | null;
    by_category: Record<string, { avg: number; n: number }>;
  } {
    const rows = this.list_for_user(user_id, 1000).filter(
      (r) => r.status === 'sold' && r.listed_at && r.sold_at,
    );
    const all: number[] = [];
    const cat = new Map<string, number[]>();
    for (const r of rows) {
      const d = day_diff(r.listed_at!, r.sold_at!);
      if (d == null) continue;
      all.push(d);
      const key = (r.category ?? '').trim().toLowerCase();
      if (key) {
        const arr = cat.get(key) ?? [];
        arr.push(d);
        cat.set(key, arr);
      }
    }
    const by_category: Record<string, { avg: number; n: number }> = {};
    for (const [k, ds] of cat) {
      const m = mean(ds);
      if (m != null) by_category[k] = { avg: m, n: ds.length };
    }
    return { overall: mean(all), by_category };
  }

  /**
   * Last 8 weeks of realized revenue, zero-filled, oldest first. Buckets
   * are trailing 7-day windows ending today; a sold row falls into the
   * window its `sold_at` lands in.
   */
  private build_revenue_by_week(sold: ResaleItemRow[], now: Date): RevenueWeek[] {
    const WEEKS = 8;
    const day_ms = 24 * 60 * 60 * 1000;
    const buckets: RevenueWeek[] = [];
    // Bucket i covers [now - (i+1)*7d, now - i*7d); oldest first.
    for (let i = WEEKS - 1; i >= 0; i--) {
      const start = new Date(now.getTime() - (i + 1) * 7 * day_ms);
      buckets.push({ week_start: local_iso_date(start), revenue: 0 });
    }
    const oldest_ms = now.getTime() - WEEKS * 7 * day_ms;
    for (const r of sold) {
      if (!r.sold_at) continue;
      const t = Date.parse(r.sold_at);
      if (!Number.isFinite(t) || t < oldest_ms || t > now.getTime()) continue;
      const idx = Math.min(
        WEEKS - 1,
        Math.floor((now.getTime() - t) / (7 * day_ms)),
      );
      // idx 0 = most recent window = last bucket.
      const bucket = buckets[WEEKS - 1 - idx];
      if (bucket) bucket.revenue += r.sold_price ?? 0;
    }
    return buckets;
  }
}

// ── aging radar ───────────────────────────────────────────────────────────
//
// Flags active listings that have been live too long relative to how fast
// the seller's comparable items actually sell, and suggests a charm-priced
// markdown. The whole point of tracking the ledger: turn "is this working"
// hindsight into "do this now" foresight. Pure functions over the rows so
// the pane and the chat tool share one definition.

/** Live ≥ this × the benchmark → "aging"; ≥ STALE_FACTOR → "stale". */
export const AGING_FACTOR = 1.5;
export const STALE_FACTOR = 2.5;
/** A category benchmark needs at least this many sales to be trusted. */
export const MIN_CATEGORY_SALES = 2;
/** Fallback when the seller has no sales history yet. */
export const DEFAULT_BENCHMARK_DAYS = 21;
/** Suggested markdown depth by severity. */
const AGING_DROP = 0.12;
const STALE_DROP = 0.2;

export interface AgingEntry {
  item: ResaleItemRow;
  days_live: number;
  benchmark_days: number;
  benchmark_source: 'category' | 'overall' | 'default';
  severity: 'aging' | 'stale';
  /** Effective current price (last markdown, else the original list price). */
  current_price: number | null;
  /** Charm-priced markdown suggestion, when a current price is known. */
  suggested_price: number | null;
}

/** Effective price = the most recent markdown if any, else the list price. */
export function effective_price(r: ResaleItemRow): number | null {
  if (r.price_drops.length > 0) {
    const last = r.price_drops[r.price_drops.length - 1];
    if (last && typeof last.price === 'number') return last.price;
  }
  return r.list_price;
}

/** Charm-price a number: whole dollars, never ending in 0 ($40 → $39). */
export function charm_price(n: number): number {
  const w = Math.max(1, Math.round(n));
  return w % 10 === 0 ? w - 1 : w;
}

interface Benchmarks {
  overall: number | null;
  by_category: Record<string, { avg: number; n: number }>;
}

/**
 * Compute the aging radar over a set of active items against the seller's
 * days-to-sell benchmarks. Newest-overdue first (most over its benchmark at
 * the top). Items with no `listed_at` can't be aged and are skipped.
 */
export function compute_aging(
  active: ResaleItemRow[],
  benchmarks: Benchmarks,
  now: Date = new Date(),
): AgingEntry[] {
  const out: AgingEntry[] = [];
  for (const item of active) {
    if (!item.listed_at) continue;
    const listed = Date.parse(item.listed_at);
    if (!Number.isFinite(listed)) continue;
    const days_live = Math.max(0, Math.floor((now.getTime() - listed) / (24 * 60 * 60 * 1000)));

    // Prefer a category benchmark with enough sales, then overall, then default.
    const cat_key = (item.category ?? '').trim().toLowerCase();
    const cat = cat_key ? benchmarks.by_category[cat_key] : undefined;
    let benchmark_days: number;
    let benchmark_source: AgingEntry['benchmark_source'];
    if (cat && cat.n >= MIN_CATEGORY_SALES) {
      benchmark_days = cat.avg;
      benchmark_source = 'category';
    } else if (benchmarks.overall != null) {
      benchmark_days = benchmarks.overall;
      benchmark_source = 'overall';
    } else {
      benchmark_days = DEFAULT_BENCHMARK_DAYS;
      benchmark_source = 'default';
    }
    // Guard a degenerate ~0 benchmark (everything sold same-day) so we don't
    // flag a one-day-old listing.
    const bench = Math.max(3, benchmark_days);
    if (days_live < AGING_FACTOR * bench) continue;

    const severity: AgingEntry['severity'] = days_live >= STALE_FACTOR * bench ? 'stale' : 'aging';
    const current_price = effective_price(item);
    const drop = severity === 'stale' ? STALE_DROP : AGING_DROP;
    const suggested_price =
      current_price != null && current_price > 1 ? charm_price(current_price * (1 - drop)) : null;

    out.push({
      item,
      days_live,
      benchmark_days: Math.round(bench),
      benchmark_source,
      severity,
      current_price,
      suggested_price,
    });
  }
  // Most overdue first (largest days_live / benchmark ratio).
  out.sort((a, b) => b.days_live / b.benchmark_days - a.days_live / a.benchmark_days);
  return out;
}
