/**
 * MailOrders — the Orders / Trackables projection for Kate's Post Office.
 *
 * One row per ORDER (a commerce event), keyed per user by merchant+order# (or
 * by tracking number when there's no order#). Later shipping + delivery emails
 * for the SAME order MERGE into the row: their shipment(s) are added and the
 * order's status advances (ordered → shipped → in_transit → out_for_delivery →
 * delivered). So a confirmation, a "your package shipped", and a "delivered"
 * email collapse into one trackable with a carrier + tracking link.
 *
 * Fed by the ingest pipeline: a message triaged as `transactional` (authentic
 * by the triage gate — a phishing "your order shipped" lands in junk, never
 * here) is run through `extract_order`; a real order upserts here. Self-
 * contained additive table (no SCHEMA_SQL edit, no SCHEMA_VERSION bump);
 * named-sigil binds. Cordon: every row carries `private_to`.
 */
import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';

export type OrderStatus =
  | 'ordered'
  | 'shipped'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'unknown';

/** Linear delivery progress; the row keeps the highest reached (delivered is
 *  terminal). A delayed/exception email sets `flagged` rather than regressing. */
const STATUS_RANK: Record<OrderStatus, number> = {
  unknown: -1,
  ordered: 0,
  shipped: 1,
  in_transit: 2,
  out_for_delivery: 3,
  delivered: 4,
};

export function advance_status(prev: OrderStatus, next: OrderStatus): OrderStatus {
  return STATUS_RANK[next] > STATUS_RANK[prev] ? next : prev;
}

/**
 * What the buyer ends up holding once the order completes — the judgment that
 * decides whether a return window is a real thing to track. Set by the order
 * extractor (the model already reading the receipt), never derived from the
 * merchant or a keyword list: the same store sells across these, and a
 * cheeseburger and a wireless mouse are indistinguishable to a classifier that
 * only sees text.
 */
export type Fulfillment = 'durable_goods' | 'consumable' | 'service' | 'subscription';

export interface Shipment {
  carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  status: OrderStatus;
  expected_delivery: string | null;
  seen_at: string;
}

export interface MailOrder {
  id: string;
  user_id: string;
  private_to: string;
  order_key: string;
  merchant: string;
  order_number: string | null;
  items: string | null;
  order_total: string | null;
  order_date: string | null;
  status: OrderStatus;
  /** A delayed / exception signal was seen — needs attention. */
  flagged: boolean;
  /** What the buyer ends up holding — see ExtractedOrderSchema.fulfillment.
   *  Null = unjudged (pre-2026-07 row or an LLM outage); downstream must treat
   *  it as "unknown", never as "returnable". */
  fulfillment: Fulfillment | null;
  shipments: Shipment[];
  source_message_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface OrderUpsert {
  user_id: string;
  private_to: string;
  order_key: string;
  merchant: string;
  order_number: string | null;
  items?: string | null;
  order_total?: string | null;
  order_date?: string | null;
  status: OrderStatus;
  flagged?: boolean;
  fulfillment?: Fulfillment | null;
  shipment?: Shipment;
  source_message_id?: string;
}

interface Row {
  id: string;
  user_id: string;
  private_to: string;
  order_key: string;
  merchant: string;
  order_number: string | null;
  items: string | null;
  order_total: string | null;
  order_date: string | null;
  status: string;
  flagged: number;
  fulfillment: string | null;
  shipments_json: string;
  source_message_ids_json: string;
  created_at: string;
  updated_at: string;
}

function parse_arr<T>(json: string): T[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function hydrate(r: Row): MailOrder {
  return {
    id: r.id,
    user_id: r.user_id,
    private_to: r.private_to,
    order_key: r.order_key,
    merchant: r.merchant,
    order_number: r.order_number,
    items: r.items,
    order_total: r.order_total,
    order_date: r.order_date,
    status: r.status as OrderStatus,
    flagged: r.flagged === 1,
    fulfillment: (r.fulfillment as Fulfillment | null) ?? null,
    shipments: parse_arr<Shipment>(r.shipments_json),
    source_message_ids: parse_arr<string>(r.source_message_ids_json),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** Same tracking number = same shipment (case/space-insensitive). */
function same_shipment(a: Shipment, b: Shipment): boolean {
  const norm = (s: string | null) => (s ?? '').replace(/\s+/g, '').toLowerCase();
  if (a.tracking_number && b.tracking_number) return norm(a.tracking_number) === norm(b.tracking_number);
  return false;
}

export interface OrderListOpts {
  user_ids?: string[];
  active_only?: boolean;
  delivered_within_days?: number;
  limit?: number;
}

export class MailOrders {
  constructor(private db: Database) {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS mail_orders (
         id TEXT PRIMARY KEY,
         user_id TEXT NOT NULL,
         private_to TEXT NOT NULL,
         order_key TEXT NOT NULL,
         merchant TEXT NOT NULL DEFAULT '',
         order_number TEXT,
         items TEXT,
         order_total TEXT,
         order_date TEXT,
         status TEXT NOT NULL DEFAULT 'unknown',
         flagged INTEGER NOT NULL DEFAULT 0,
         fulfillment TEXT,
         shipments_json TEXT NOT NULL DEFAULT '[]',
         source_message_ids_json TEXT NOT NULL DEFAULT '[]',
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         UNIQUE(user_id, order_key)
       )`,
    );
    // Additive migration for tables created before `fulfillment` existed
    // (2026-07-20). Deliberately NO backfill: an existing row's fulfillment is
    // genuinely unknown — the receipt that could have answered it is already
    // consumed — and "unknown" must stay distinct from "durable_goods", or the
    // guessed value re-fabricates the exact return windows this column exists
    // to stop. Unknown → no derived window, same as a missing purchase date.
    try {
      this.db.exec(`ALTER TABLE mail_orders ADD COLUMN fulfillment TEXT`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column name')) throw err;
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mail_orders_user ON mail_orders(user_id, updated_at)`);
  }

  get_by_key(user_id: string, order_key: string): MailOrder | undefined {
    const r = this.db
      .prepare(`SELECT * FROM mail_orders WHERE user_id = @u AND order_key = @k`)
      .get({ '@u': user_id, '@k': order_key }) as Row | undefined;
    return r ? hydrate(r) : undefined;
  }

  /** Insert a new order, or merge a later shipping/delivery email into the
   *  existing one (status advances; shipment deduped by tracking number).
   *  Returns the row + whether it was newly created. */
  upsert(u: OrderUpsert): { order: MailOrder; is_new: boolean } {
    const now = new Date().toISOString();
    const existing = this.get_by_key(u.user_id, u.order_key);
    if (existing) {
      const status = advance_status(existing.status, u.status);
      const shipments = existing.shipments.slice();
      if (u.shipment && (u.shipment.tracking_number || u.shipment.carrier)) {
        const idx = shipments.findIndex((s) => same_shipment(s, u.shipment!));
        if (idx >= 0) shipments[idx] = { ...shipments[idx]!, ...u.shipment };
        else shipments.push(u.shipment);
      }
      const source_ids = existing.source_message_ids.slice();
      if (u.source_message_id && !source_ids.includes(u.source_message_id)) source_ids.push(u.source_message_id);
      this.db
        .prepare(
          `UPDATE mail_orders SET
             merchant = @merchant, order_number = COALESCE(@order_number, order_number),
             items = COALESCE(@items, items), order_total = COALESCE(@order_total, order_total),
             order_date = COALESCE(@order_date, order_date), status = @status,
             flagged = @flagged, fulfillment = COALESCE(@fulfillment, fulfillment),
             shipments_json = @shipments, source_message_ids_json = @sources,
             updated_at = @now
           WHERE id = @id`,
        )
        .run({
          '@id': existing.id,
          '@merchant': u.merchant || existing.merchant,
          '@order_number': u.order_number,
          '@items': u.items ?? null,
          '@order_total': u.order_total ?? null,
          '@order_date': u.order_date ?? null,
          '@status': status,
          '@flagged': u.flagged || existing.flagged ? 1 : 0,
          '@fulfillment': u.fulfillment ?? null,
          '@shipments': JSON.stringify(shipments),
          '@sources': JSON.stringify(source_ids),
          '@now': now,
        });
      return { order: this.get_by_key(u.user_id, u.order_key)!, is_new: false };
    }
    const id = `mo_${ulid().toLowerCase().slice(-12)}`;
    this.db
      .prepare(
        `INSERT INTO mail_orders
           (id, user_id, private_to, order_key, merchant, order_number, items, order_total,
            order_date, status, flagged, fulfillment, shipments_json, source_message_ids_json, created_at, updated_at)
         VALUES
           (@id, @user_id, @private_to, @order_key, @merchant, @order_number, @items, @order_total,
            @order_date, @status, @flagged, @fulfillment, @shipments, @sources, @now, @now)`,
      )
      .run({
        '@id': id,
        '@user_id': u.user_id,
        '@private_to': u.private_to,
        '@order_key': u.order_key,
        '@merchant': u.merchant,
        '@order_number': u.order_number,
        '@items': u.items ?? null,
        '@order_total': u.order_total ?? null,
        '@order_date': u.order_date ?? null,
        '@status': u.status,
        '@fulfillment': u.fulfillment ?? null,
        '@flagged': u.flagged ? 1 : 0,
        '@shipments': JSON.stringify(u.shipment ? [u.shipment] : []),
        '@sources': JSON.stringify(u.source_message_id ? [u.source_message_id] : []),
        '@now': now,
      });
    return { order: this.get_by_key(u.user_id, u.order_key)!, is_new: true };
  }

  /** Orders newest-update first. `active_only` hides delivered orders older
   *  than `delivered_within_days` (default 7) so the trackables view stays the
   *  "what's coming" list, keeping recently-delivered for confirmation. */
  list(opts: OrderListOpts = {}): MailOrder[] {
    const rows = (this.db.prepare(`SELECT * FROM mail_orders ORDER BY updated_at DESC`).all() as Row[]).map(hydrate);
    const within = (opts.delivered_within_days ?? 7) * 86_400_000;
    const now = Date.now();
    let out = rows;
    if (opts.user_ids && opts.user_ids.length > 0) {
      const set = new Set(opts.user_ids);
      out = out.filter((o) => set.has(o.user_id));
    }
    if (opts.active_only) {
      out = out.filter(
        (o) => o.status !== 'delivered' || now - new Date(o.updated_at).getTime() <= within,
      );
    }
    return out.slice(0, opts.limit ?? 100);
  }
}
