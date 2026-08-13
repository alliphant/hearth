/**
 * query_sales_history — Linda's read into the seller's resale ledger.
 *
 * Before she advises a price, Linda can ground it in what THIS seller's items
 * have actually done: recent sales (final price, days-to-sell, platform),
 * optionally filtered to a category, plus the aggregate metrics that back her
 * office. This is the seed of the longer-term goal — narrowing pricing
 * recommendations from real outcomes rather than comps alone ("your last two
 * jackets sold around $40, both inside a week").
 *
 * Read-only (`read_vault`, risk `read`). Per-user scoped via ctx.user.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { ResaleItemsStore, compute_aging } from '@memory/stores/resale_items';

const InputSchema = z.object({
  category: z
    .string()
    .max(80)
    .optional()
    .describe('Optional case-insensitive substring to filter sold items by category (e.g. "jacket", "footwear").'),
  limit: z.number().int().positive().max(50).optional().describe('How many recent sold items to return (default 10).'),
});

const SoldItemSchema = z.object({
  item_title: z.string(),
  category: z.string().nullable(),
  platform: z.string().nullable(),
  list_price: z.number().nullable(),
  sold_price: z.number().nullable(),
  days_to_sell: z.number().nullable(),
  price_drops: z.number(),
  sold_at: z.string().nullable(),
});

const MetricsSchema = z.object({
  total_revenue: z.number(),
  total_sales: z.number(),
  active_count: z.number(),
  net_profit: z.number().nullable(),
  margin_pct: z.number().nullable(),
  sell_through_pct: z.number().nullable(),
  avg_days_to_sell: z.number().nullable(),
  avg_discount_pct: z.number().nullable(),
  avg_drops: z.number().nullable(),
});

const AgingItemSchema = z.object({
  item_title: z.string(),
  days_live: z.number(),
  benchmark_days: z.number(),
  severity: z.enum(['aging', 'stale']),
  current_price: z.number().nullable(),
  suggested_price: z.number().nullable(),
});

const OutputSchema = z.object({
  recent_sold: z.array(SoldItemSchema),
  metrics: MetricsSchema,
  /** Active listings overdue vs how fast comparable items sell — the
   *  markdown nudges Linda can raise proactively. Newest-overdue first. */
  aging: z.array(AgingItemSchema),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const DESCRIPTION =
  "Read this seller's resale history — recent sales (final price, days to sell, platform), overall metrics, AND an `aging` list of active items sitting longer than comparable items take to sell (each with a suggested markdown). Use it to ground a price recommendation in what their items have actually done, and to proactively raise a markdown when something's gone stale (\"your X has been up 19 days — these usually move in 8; want to drop it to $39?\"). Optionally filter sold history by category.";

function days_to_sell(listed_at: string | null, sold_at: string | null): number | null {
  if (!listed_at || !sold_at) return null;
  const a = Date.parse(listed_at);
  const b = Date.parse(sold_at);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / (24 * 60 * 60 * 1000)));
}

export function create(deps: ToolDeps): Tool<Input, Output> {
  const store = new ResaleItemsStore(deps.db);

  return {
    name: 'query_sales_history',
    description: DESCRIPTION,
    risk: 'read',
    required_capabilities: ['read_vault'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `query_sales_history:${(input.category ?? '*').toLowerCase()}:${input.limit ?? 10}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const user_id = ctx.user?.id;
      if (!user_id) {
        throw new Error('query_sales_history requires a user on ToolContext.');
      }
      const limit = input.limit ?? 10;
      const needle = input.category?.trim().toLowerCase();

      let sold = store.list_recent_sold(user_id, needle ? 50 : limit);
      if (needle) {
        sold = sold.filter((r) => (r.category ?? '').toLowerCase().includes(needle)).slice(0, limit);
      }

      const recent_sold = sold.map((r) => ({
        item_title: r.item_title,
        category: r.category,
        platform: r.platform,
        list_price: r.list_price,
        sold_price: r.sold_price,
        days_to_sell: days_to_sell(r.listed_at, r.sold_at),
        price_drops: r.price_drops.length,
        sold_at: r.sold_at,
      }));

      const now = ctx.now ?? new Date();
      const aging = compute_aging(
        store.list_active(user_id, 50),
        store.days_to_sell_benchmarks(user_id),
        now,
      ).map((e) => ({
        item_title: e.item.item_title,
        days_live: e.days_live,
        benchmark_days: e.benchmark_days,
        severity: e.severity,
        current_price: e.current_price,
        suggested_price: e.suggested_price,
      }));

      const m = store.sales_metrics(user_id, now);
      return {
        aging,
        recent_sold,
        metrics: {
          total_revenue: m.total_revenue,
          total_sales: m.total_sales,
          active_count: m.active_count,
          net_profit: m.net_profit,
          margin_pct: m.margin_pct,
          sell_through_pct: m.sell_through_pct,
          avg_days_to_sell: m.avg_days_to_sell,
          avg_discount_pct: m.avg_discount_pct,
          avg_drops: m.avg_drops,
        },
      };
    },
  };
}
