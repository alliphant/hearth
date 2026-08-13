/**
 * Order / trackable extraction — the structured layer over `transactional`
 * mail (order confirmations, shipping notices, delivery updates).
 *
 * Same shape as the triage judge / Cordelia's extractors: a planner-role LLM
 * call with a strict JSON schema, deterministic (temp 0.1), FAIL-OPEN (any
 * error / unparseable / not-an-order → null → no order row; the message still
 * sits in its triage bucket). Only ever run on mail already triaged
 * `transactional` (authentic), so a phishing "your order shipped" — which
 * triages as phishing → junk — is never extracted.
 *
 * Carrier → public tracking-URL is DATA (a small template map, like the
 * provider presets), not hard-coded behavior; the merchant's own tracking
 * link from the email is preferred when present.
 */
import { z } from 'zod';
import type { LLMRouter } from '@core/llm';
import type { OrderStatus, OrderUpsert, Shipment } from '@memory/stores/mail_orders';

const ExtractedOrderSchema = z.object({
  is_order: z.boolean(),
  kind: z.enum(['confirmation', 'shipment', 'delivery', 'update', 'other']).default('other'),
  merchant: z.string().nullable().default(null),
  order_number: z.string().nullable().default(null),
  order_total: z.string().nullable().default(null),
  items: z.string().nullable().default(null),
  carrier: z.string().nullable().default(null),
  tracking_number: z.string().nullable().default(null),
  tracking_url: z.string().nullable().default(null),
  status: z
    .enum(['ordered', 'shipped', 'in_transit', 'out_for_delivery', 'delivered', 'delayed', 'unknown'])
    .default('unknown'),
  expected_delivery: z.string().nullable().default(null),
  /**
   * What the purchase actually IS — the judgment that decides whether a return
   * window is a real thing to track. Rendered by the model that is already
   * reading the receipt (no extra call), because nothing downstream can
   * recover it: a keyword classifier lands a cheeseburger and a Logitech mouse
   * in the same bucket, so a category default either fabricates a return
   * window on consumed food or drops it on genuinely returnable hardware.
   * Null = the model didn't judge (old row / LLM outage) → downstream derives
   * NO window, the same honest-absence rule as a missing purchase date.
   */
  fulfillment: z
    .enum(['durable_goods', 'consumable', 'service', 'subscription'])
    .nullable()
    .default(null),
});
export type ExtractedOrder = z.infer<typeof ExtractedOrderSchema>;

/** Carrier → public tracking-URL template ({n} = the tracking number). Data,
 *  extensible; an unknown carrier just yields no synthesized link. */
const CARRIER_URLS: Record<string, string> = {
  ups: 'https://www.ups.com/track?loc=en_US&tracknum={n}',
  usps: 'https://tools.usps.com/go/TrackConfirmAction?tLabels={n}',
  fedex: 'https://www.fedex.com/fedextrack/?trknbr={n}',
  dhl: 'https://www.dhl.com/us-en/home/tracking.html?tracking-id={n}',
  ontrac: 'https://www.ontrac.com/tracking/?number={n}',
  lasership: 'https://www.lasership.com/track/{n}',
};

/** Normalize a free-text carrier name to a CARRIER_URLS key. */
export function normalize_carrier(raw: string | null): string | null {
  if (!raw) return null;
  const c = raw.toLowerCase();
  if (/\bups\b/.test(c)) return 'ups';
  if (/usps|postal/.test(c)) return 'usps';
  if (/fedex/.test(c)) return 'fedex';
  if (/dhl/.test(c)) return 'dhl';
  if (/ontrac/.test(c)) return 'ontrac';
  if (/lasership/.test(c)) return 'lasership';
  return null; // includes "Amazon Logistics" etc. — no public template
}

export function tracking_url_for(
  carrier: string | null,
  tracking_number: string | null,
  from_email: string | null,
): string | null {
  if (from_email && /^https?:\/\//i.test(from_email)) return from_email; // a link the email gave us
  if (!tracking_number) return null;
  const key = normalize_carrier(carrier);
  if (!key) return null;
  return CARRIER_URLS[key]!.replace('{n}', encodeURIComponent(tracking_number.replace(/\s+/g, '')));
}

function status_of(s: ExtractedOrder['status']): OrderStatus {
  // 'delayed' isn't a linear stage — clamp to in_transit and flag separately.
  if (s === 'delayed') return 'in_transit';
  return s;
}

/** Merchant fallback from a sender address ("ship@amazon.com" → "Amazon"). */
function merchant_from_sender(from_addr: string): string {
  const dom = from_addr.match(/@([^@>\s]+)/)?.[1] ?? '';
  const sld = dom.split('.').slice(-2, -1)[0] ?? dom;
  return sld ? sld.charAt(0).toUpperCase() + sld.slice(1) : 'Unknown';
}

const SYSTEM =
  'Extract order / shipment details from ONE transactional email (an order ' +
  'confirmation, a shipping notice, or a delivery update). If the email is NOT ' +
  'about a specific purchase/shipment, set is_order=false.\n\n' +
  'kind: confirmation (order placed), shipment (it shipped / is in transit), ' +
  'delivery (delivered), update (other status), other.\n' +
  'status: ordered | shipped | in_transit | out_for_delivery | delivered | ' +
  'delayed | unknown.\n' +
  'Pull merchant, order_number, order_total (keep the currency symbol as text), ' +
  'a SHORT items summary, carrier, tracking_number, and any tracking_url present ' +
  'in the email. expected_delivery as the email states it (free text is fine).\n' +
  'fulfillment: what the buyer actually ends up holding once this is complete.\n' +
  '  durable_goods — a physical item that keeps existing after delivery, so it ' +
  'could be boxed up and sent back;\n' +
  '  consumable — food, drink, or anything used up in the using;\n' +
  '  service — labor, an appointment, or work performed for the buyer;\n' +
  '  subscription — recurring or time-boxed access rather than an object.\n' +
  'Judge it from what was bought, not from the merchant\'s name — the same ' +
  'store can sell across these. Use null only when the email genuinely does not ' +
  'say what was bought.\n' +
  'Use ONLY what the email says; never invent a tracking number or order id. ' +
  'Reply with ONLY this JSON:\n' +
  '{"is_order":<bool>,"kind":"...","merchant":<str|null>,"order_number":<str|null>,' +
  '"order_total":<str|null>,"items":<str|null>,"carrier":<str|null>,' +
  '"tracking_number":<str|null>,"tracking_url":<str|null>,"status":"...",' +
  '"expected_delivery":<str|null>,"fulfillment":<"durable_goods"|"consumable"|' +
  '"service"|"subscription"|null>}';

function strip_fence(s: string): string {
  const m = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  return (m ? m[1]! : s).trim();
}

/** Extract order fields from a transactional message. Fail-open → null. */
export async function extract_order(
  input: { from_addr: string; from_name: string; subject: string; body_text: string },
  llm?: LLMRouter,
): Promise<ExtractedOrder | null> {
  if (!llm) return null;
  let role;
  try {
    role = llm.for_role('planner');
  } catch {
    return null;
  }
  let resp;
  try {
    resp = await role.provider.complete({
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content:
            `From: ${input.from_name} <${input.from_addr}>\nSubject: ${input.subject}\n\n` +
            `${input.body_text.slice(0, 3000)}\n\nReply with ONLY the JSON.`,
        },
      ],
      temperature: 0.1,
      max_tokens: 400,
      think: false,
      ...role.defaults,
    });
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(strip_fence(resp.content));
  } catch {
    return null;
  }
  const r = ExtractedOrderSchema.safeParse(parsed);
  if (!r.success || !r.data.is_order) return null;
  return r.data;
}

/** Turn an extracted order into a store upsert, deriving the merge key,
 *  merchant fallback, shipment, and tracking URL. Null when there's nothing
 *  to key on (no order# AND no tracking#). */
export function build_order_upsert(
  e: ExtractedOrder,
  ctx: {
    user_id: string;
    private_to: string;
    message_id: string;
    from_addr: string;
    date_utc: string;
  },
): OrderUpsert | null {
  const merchant = (e.merchant && e.merchant.trim()) || merchant_from_sender(ctx.from_addr);
  const order_number = e.order_number?.trim() || null;
  const tracking = e.tracking_number?.replace(/\s+/g, '') || null;

  // Merge key: prefer the merchant+order#, else the tracking#, else nothing.
  let order_key: string;
  if (order_number) order_key = `${merchant.toLowerCase()}:${order_number.toLowerCase()}`;
  else if (tracking) order_key = `track:${tracking.toLowerCase()}`;
  else return null;

  const status = status_of(e.status);
  const flagged = e.status === 'delayed';
  const shipment: Shipment | undefined =
    tracking || e.carrier
      ? {
          carrier: e.carrier ?? null,
          tracking_number: e.tracking_number ?? null,
          tracking_url: tracking_url_for(e.carrier, e.tracking_number, e.tracking_url),
          status,
          expected_delivery: e.expected_delivery ?? null,
          seen_at: ctx.date_utc,
        }
      : undefined;

  return {
    user_id: ctx.user_id,
    private_to: ctx.private_to,
    order_key,
    merchant,
    order_number,
    items: e.items ?? null,
    order_total: e.order_total ?? null,
    order_date: e.kind === 'confirmation' ? ctx.date_utc : null,
    status,
    flagged,
    fulfillment: e.fulfillment ?? null,
    shipment,
    source_message_id: ctx.message_id,
  };
}
