/**
 * Order → typed household-good enrichment (2026-06-20) — the "inference" half
 * of the Household Knowledge Graph's first slice.
 *
 * Takes a persisted order (the mail_orders projection) and derives a typed
 * `household_good` node + its implications (return window, warranty horizon)
 * + the typed inference edges (owned-by, purchased-from). DETERMINISTIC and
 * PURE — category is a documented keyword classifier; the implication windows
 * are documented per-category defaults (the email rarely states them, so Kate
 * proposes the derived date as an *estimate* the owner confirms). No LLM on
 * this path → the smoke is deterministic and the enrichment can never stall a
 * mail-ingest pass. An optional planner-LLM refinement of category/name is a
 * future hook (kept out of P1 for determinism + fail-safety).
 *
 * The good NODE is the source of truth (a vault note, projected to
 * household_goods for date-scans); the EDGES are typed/inferred (knowledge_edges).
 * Idempotent: the note path + id are derived from the order_key, so re-running
 * on a later shipment/delivery email updates the same good.
 */
import { createHash } from 'node:crypto';
import { local_iso_date } from '@core/time';
import type { HouseholdGood } from '@memory/schemas/household_good';
import type { EdgeUpsert } from '@memory/stores/knowledge_edges';
import type { Fulfillment } from '@memory/stores/mail_orders';

export interface OrderForEnrich {
  order_key: string;
  merchant: string;
  items: string | null;
  order_total: string | null; // "$284.50" — currency-as-text
  order_date: string | null; // ISO
  status: string;
  /** What the buyer ends up holding — decides whether return/warranty windows
   *  are derived at all. Null/absent = unjudged → no windows. */
  fulfillment?: Fulfillment | null;
  source_message_id?: string | null;
}

export interface EnrichContext {
  /** Display name of the buyer/owner (becomes a [[wikilink]] + owned-by edge). */
  buyer_display_name?: string;
  /** Cordon value to stamp on the good + its edges (from the order's private_to). */
  private_to: string;
  now: Date;
  tz?: string;
}

export interface EnrichedGood {
  id: string;
  note_path: string;
  frontmatter: HouseholdGood;
  body: string;
  edges: EdgeUpsert[];
}

/** category → { warranty_days, return_days }. Documented, tunable defaults;
 *  0 = not applicable. The email seldom states these, so they're ESTIMATES the
 *  owner confirms via the reactive-trigger proposal — never asserted as fact.
 *
 *  These say how LONG a window runs for a kind of thing. They do NOT decide
 *  WHETHER the purchase has one — `order.fulfillment` does (see below). The
 *  `other` bucket used to carry `return_days: 30`, which meant the keyword
 *  classifier's catch-all fabricated a 30-day return window on every purchase
 *  it couldn't name: McDonald's, Taco Bell, a Twitch subscription and a
 *  90-minute massage all got one, and Kate dutifully offered to start a return
 *  on a cheeseburger. Narrowing the keyword list was NOT the fix — a Logitech
 *  mouse, a portable AC and an Ioniq screen protector land in `other` too, so
 *  any allowlist drops real windows while still guessing at the rest. */
const CATEGORY_DEFAULTS: Record<string, { warranty_days: number; return_days: number }> = {
  electronics: { warranty_days: 365, return_days: 30 },
  appliance: { warranty_days: 365, return_days: 30 },
  tool: { warranty_days: 365, return_days: 30 },
  clothing: { warranty_days: 0, return_days: 30 },
  home: { warranty_days: 0, return_days: 30 },
  grocery: { warranty_days: 0, return_days: 0 },
  other: { warranty_days: 0, return_days: 30 },
};

/**
 * Does this purchase have a return window at all? The model that read the
 * receipt already answered — anything that isn't a durable object can't be
 * boxed up and sent back, and an unjudged order (pre-2026-07 row, or an LLM
 * outage) is UNKNOWN, which derives nothing rather than guessing. Same
 * honest-absence discipline as a missing purchase date below.
 *
 * Warranties ride the same judgment: a service has no warranty period to track
 * either, and the category defaults already zero it for the soft goods.
 */
function is_returnable(fulfillment: Fulfillment | null | undefined): boolean {
  return fulfillment === 'durable_goods';
}

/** Keyword category classifier over the items summary + merchant. Heuristic,
 *  tunable; a miss only changes the DEFAULT implication windows, which the
 *  owner confirms — never a correctness-critical decision. */
function classify_category(items: string | null, merchant: string): string {
  const hay = `${items ?? ''} ${merchant}`.toLowerCase();
  const has = (...words: string[]) => words.some((w) => hay.includes(w));
  if (has('laptop', 'monitor', 'phone', 'headphone', 'earbud', 'camera', 'tv', 'console', 'tablet', 'charger', 'ssd', 'gpu', 'router', 'speaker')) {
    return 'electronics';
  }
  if (has('washer', 'dryer', 'fridge', 'refrigerator', 'dishwasher', 'microwave', 'vacuum', 'blender', 'oven', 'air fryer', 'coffee maker', 'appliance')) {
    return 'appliance';
  }
  if (has('drill', 'saw', 'wrench', 'tool', 'hammer', 'sander')) return 'tool';
  if (has('shirt', 'pants', 'jacket', 'shoe', 'dress', 'sock', 'coat', 'apparel', 'clothing')) {
    return 'clothing';
  }
  if (has('grocery', 'food', 'snack', 'produce', 'coffee beans', 'pantry')) return 'grocery';
  if (has('furniture', 'lamp', 'rug', 'bedding', 'pillow', 'curtain', 'decor', 'kitchenware')) {
    return 'home';
  }
  return 'other';
}

/** Parse a currency-bearing total ("$284.50", "USD 1,299.00") → number | undefined. */
export function parse_cost(total: string | null): number | undefined {
  if (!total) return undefined;
  const cleaned = total.replace(/[^0-9.]/g, '');
  if (!cleaned) return undefined;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Add `days` calendar days to a purchase instant, returning a YYYY-MM-DD
 * calendar date. Warranty/return windows are tz-NEUTRAL calendar estimates
 * (the owner confirms them), so the math runs in UTC calendar space, anchored
 * at noon to immunize against DST/boundary drift. `local_iso_date(_, 'UTC')`
 * is the sanctioned (guard-clean) formatter; UTC is deliberate here, not the
 * user's tz — a one-day boundary ambiguity is immaterial for an estimate.
 */
function add_calendar_days(purchase_iso: string, days: number): string {
  const cal = local_iso_date(new Date(purchase_iso), 'UTC'); // YYYY-MM-DD as written
  const anchor = new Date(`${cal}T12:00:00Z`);
  return local_iso_date(new Date(anchor.getTime() + days * 86_400_000), 'UTC');
}

function good_id_for(order_key: string): string {
  return `hg_${createHash('sha256').update(order_key).digest('hex').slice(0, 8)}`;
}

function good_slug_for(merchant: string, order_key: string): string {
  const m = merchant.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'order';
  const suffix = createHash('sha256').update(order_key).digest('hex').slice(0, 6);
  return `${m}-${suffix}`;
}

/**
 * Derive the typed good + edges from an order. Pure + deterministic. The good's
 * `purchase_date` anchors the implication windows; with no purchase_date the
 * windows are omitted (no fabricated dates).
 */
export function enrich_order_to_good(order: OrderForEnrich, ctx: EnrichContext): EnrichedGood {
  const id = good_id_for(order.order_key);
  const note_path = `Household/Goods/${good_slug_for(order.merchant, order.order_key)}.md`;
  const category = classify_category(order.items, order.merchant);
  const defaults = CATEGORY_DEFAULTS[category] ?? CATEGORY_DEFAULTS.other!;
  const cost = parse_cost(order.order_total);

  // Implication windows are anchored on the purchase date when known, and only
  // exist for something you could actually hand back (see is_returnable).
  const returnable = is_returnable(order.fulfillment);
  const warranty_until =
    order.order_date && returnable && defaults.warranty_days > 0
      ? add_calendar_days(order.order_date, defaults.warranty_days)
      : undefined;
  const return_window_until =
    order.order_date && returnable && defaults.return_days > 0
      ? add_calendar_days(order.order_date, defaults.return_days)
      : undefined;

  const name = (order.items && order.items.trim()) || `${order.merchant} order`;
  const owner = ctx.buyer_display_name?.trim() || undefined;

  const frontmatter: HouseholdGood = {
    type: 'household_good',
    id,
    name,
    category,
    merchant: order.merchant,
    order_key: order.order_key,
    ...(owner ? { owner } : {}),
    ...(order.order_date ? { purchase_date: order.order_date } : {}),
    ...(cost !== undefined ? { cost } : {}),
    currency: 'USD',
    ...(warranty_until ? { warranty_until } : {}),
    ...(return_window_until ? { return_window_until } : {}),
    condition: 'new',
    status: 'active',
    source: 'mail',
    ...(order.source_message_id ? { source_message_id: order.source_message_id } : {}),
    private_to: ctx.private_to,
  };

  const body_lines = [
    `# ${name}`,
    '',
    `Purchased from [[${order.merchant}]]${owner ? ` for [[${owner}]]` : ''}.`,
    order.order_total ? `\n- **Cost:** ${order.order_total}` : '',
    order.order_date ? `- **Ordered:** ${order.order_date.slice(0, 10)}` : '',
    return_window_until ? `- **Return window (est.):** ${return_window_until}` : '',
    warranty_until ? `- **Warranty (est.):** ${warranty_until}` : '',
  ].filter(Boolean);

  const edges: EdgeUpsert[] = [
    {
      from_ref: note_path,
      to_ref: order.merchant,
      kind: 'purchased-from',
      confidence: 1.0,
      source: 'order_enrich',
      private_to: ctx.private_to,
    },
  ];
  if (owner) {
    edges.push({
      from_ref: note_path,
      to_ref: owner,
      kind: 'owned-by',
      confidence: 0.9,
      source: 'order_enrich',
      private_to: ctx.private_to,
    });
  }

  return { id, note_path, frontmatter, body: body_lines.join('\n'), edges };
}
