/**
 * Kate's Post Office tools — the read surface over the triaged mail
 * projection, plus the on-demand sync.
 *
 *   mail_list   — the triaged inbox, grouped into the five buckets
 *                 (replies to your threads / needs you / real new mail /
 *                 FYI subscriptions / filtered junk).
 *   mail_thread — one conversation, oldest first.
 *   mail_search — find a message by sender/subject/body substring.
 *   mail_sync   — pull + triage on demand (the IMAP IDLE driver does this
 *                 continuously; this is the manual refresh).
 *
 * Reads go through the per-user cordon (`note_visible_to_caller`): the owner
 * has NO god-view of a household member's mail; an 'owner' account is the
 * owner's alone, a 'household' account is shared. send is NOT here — it is
 * dispatch-only + PIN-approved (Phase C).
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { Tier } from '@core/users';
import { note_visible_to_caller } from '@memory/private_to';
import { MailStore, MAIL_BUCKETS, type MailBucket, type MailMessage } from '@memory/stores/mail';
import { MailAccounts } from '@memory/stores/mail_accounts';
import { MailOrders } from '@memory/stores/mail_orders';
import { sync_all } from '@core/mail_ingest';

function caller_of(ctx: ToolContext): { user_id: string | undefined; tier: Tier } {
  // A user-less call (deliberation/scheduler) defaults to owner tier, the
  // safe internal default — it sees owner+household mail, never a personal silo.
  return { user_id: ctx.user?.id, tier: ctx.user?.tier ?? 'owner' };
}

function visible(ctx: ToolContext, m: { private_to: string }): boolean {
  return note_visible_to_caller(m.private_to, caller_of(ctx));
}

const MsgCard = z.object({
  id: z.string(),
  from: z.string(),
  from_name: z.string(),
  subject: z.string(),
  snippet: z.string(),
  date: z.string(),
  category: z.string(),
  importance: z.number(),
  bucket: z.string(),
  reasons: z.array(z.string()),
  is_reply_to_me: z.boolean(),
  thread_key: z.string(),
});

function to_card(m: MailMessage): z.infer<typeof MsgCard> {
  return {
    id: m.id,
    from: m.from_addr,
    from_name: m.from_name,
    subject: m.subject,
    snippet: m.snippet,
    date: m.date_utc,
    category: m.triage_category,
    importance: m.triage_importance,
    bucket: m.triage_bucket,
    reasons: m.triage_reasons,
    is_reply_to_me: m.is_reply_to_me,
    thread_key: m.thread_key,
  };
}

// ── mail_list ─────────────────────────────────────────────────────────

const ListInput = z.object({
  buckets: z
    .array(z.enum(['needs_you', 'replies', 'new_mail', 'fyi', 'junk']))
    .optional()
    .describe('Limit to these lanes. Omit for all but junk; pass ["junk"] to see filtered mail.'),
  window_hours: z.number().int().min(1).max(720).default(168).describe('How far back to read. Default 7 days.'),
  per_bucket: z.number().int().min(1).max(25).default(10),
});
const ListOutput = z.object({
  counts: z.record(z.string(), z.number()),
  buckets: z.array(z.object({ bucket: z.string(), count: z.number(), messages: z.array(MsgCard) })),
  note: z.string().optional(),
});

function make_mail_list(db: import('bun:sqlite').Database): Tool<z.infer<typeof ListInput>, z.infer<typeof ListOutput>> {
  return {
    name: 'mail_list',
    description:
      "Read Jasper's triaged inbox, grouped into lanes: replies (to threads he " +
      'sent), needs_you (real mail wanting attention), new_mail, fyi ' +
      '(subscriptions/announcements), junk (filtered). Use for "any replies?", ' +
      '"what needs me?", "did X email back?". Junk is excluded unless asked for.',
    risk: 'read',
    required_capabilities: ['read_mail'],
    input_schema: ListInput,
    output_schema: ListOutput,
    idempotency_key: (i) => `mail_list:${(i.buckets ?? []).join(',')}:${i.window_hours}:${i.per_bucket}`,
    async execute(input, ctx) {
      const store = new MailStore(db);
      const since = new Date(Date.now() - input.window_hours * 3_600_000).toISOString();
      const want: MailBucket[] = input.buckets ?? MAIL_BUCKETS.filter((b) => b !== 'junk');
      const counts: Record<string, number> = {};
      const buckets = want.map((bucket) => {
        const rows = store
          .list({ buckets: [bucket], since, limit: input.per_bucket * 4 })
          .filter((m) => visible(ctx, m));
        counts[bucket] = rows.length;
        return { bucket, count: rows.length, messages: rows.slice(0, input.per_bucket).map(to_card) };
      });
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      return {
        counts,
        buckets,
        ...(total === 0
          ? { note: 'No triaged mail in the window. If accounts were just configured, run mail_sync — the push driver fills this continuously.' }
          : {}),
      };
    },
  };
}

// ── mail_thread ───────────────────────────────────────────────────────

const ThreadInput = z.object({
  thread_key: z.string().min(1).optional(),
  message_id: z.string().min(1).optional().describe('A message id to resolve its thread.'),
});
const ThreadOutput = z.object({
  thread_key: z.string(),
  messages: z.array(MsgCard.extend({ direction: z.string(), body: z.string() })),
  note: z.string().optional(),
});

function make_mail_thread(db: import('bun:sqlite').Database): Tool<z.infer<typeof ThreadInput>, z.infer<typeof ThreadOutput>> {
  return {
    name: 'mail_thread',
    description:
      'Read one email conversation, oldest first (both sides of the thread). ' +
      'Pass thread_key (from mail_list) or a message_id to resolve its thread.',
    risk: 'read',
    required_capabilities: ['read_mail'],
    input_schema: ThreadInput,
    output_schema: ThreadOutput,
    idempotency_key: (i) => `mail_thread:${i.thread_key ?? i.message_id ?? ''}`,
    async execute(input, ctx) {
      const store = new MailStore(db);
      let key = input.thread_key;
      if (!key && input.message_id) key = store.get(input.message_id)?.thread_key;
      if (!key) return { thread_key: '', messages: [], note: 'Provide a thread_key or a valid message_id.' };
      const rows = store.thread(key).filter((m) => visible(ctx, m));
      return {
        thread_key: key,
        messages: rows.map((m) => ({ ...to_card(m), direction: m.direction, body: m.body_text })),
        ...(rows.length === 0 ? { note: 'No visible messages in that thread.' } : {}),
      };
    },
  };
}

// ── mail_search ───────────────────────────────────────────────────────

const SearchInput = z.object({
  query: z.string().min(1).max(200).describe('Substring over sender, subject, and body.'),
  limit: z.number().int().min(1).max(50).default(20),
});
const SearchOutput = z.object({ query: z.string(), matches: z.array(MsgCard), note: z.string().optional() });

function make_mail_search(db: import('bun:sqlite').Database): Tool<z.infer<typeof SearchInput>, z.infer<typeof SearchOutput>> {
  return {
    name: 'mail_search',
    description:
      "Find a message in Jasper's inbox by sender, subject, or body text. " +
      'Quick structured lookup over the mail store; for a topic search across ' +
      'everything use search_library.',
    risk: 'read',
    required_capabilities: ['read_mail'],
    input_schema: SearchInput,
    output_schema: SearchOutput,
    idempotency_key: (i) => `mail_search:${i.query}:${i.limit}`,
    async execute(input, ctx) {
      const store = new MailStore(db);
      const matches = store.search(input.query, { limit: input.limit }).filter((m) => visible(ctx, m));
      return {
        query: input.query,
        matches: matches.map(to_card),
        ...(matches.length === 0 ? { note: 'No matching mail.' } : {}),
      };
    },
  };
}

// ── mail_sync ─────────────────────────────────────────────────────────

const SyncInput = z.object({
  account_id: z.string().optional().describe('Sync one account; omit to sync all enabled.'),
});
const SyncOutput = z.object({
  results: z.array(
    z.object({
      account_id: z.string(),
      inbox_new: z.number(),
      sent_new: z.number(),
      status: z.string(),
      error: z.string().optional(),
    }),
  ),
  note: z.string().optional(),
});

function make_mail_sync(deps: ToolDeps): Tool<z.infer<typeof SyncInput>, z.infer<typeof SyncOutput>> {
  return {
    name: 'mail_sync',
    description:
      'Pull + triage new mail from the configured accounts on demand. The ' +
      'always-on push driver does this continuously; use this to force an ' +
      'immediate refresh (e.g. right after adding an account). Returns the ' +
      'new-message count per account.',
    risk: 'write_internal',
    required_capabilities: ['ingest_mail'],
    input_schema: SyncInput,
    output_schema: SyncOutput,
    idempotency_key: (i) => `mail_sync:${i.account_id ?? 'all'}`,
    async execute(input, ctx: ToolContext) {
      const accounts = new MailAccounts(deps.db);
      const all = accounts.list({ enabled_only: true });
      if (all.length === 0) {
        return { results: [], note: 'No mail accounts configured. Add one in the Post Office setup gear.' };
      }
      const results = await sync_all(
        accounts,
        { db: deps.db, llm: ctx.llm, events: deps.events },
        input.account_id ? { only_account_id: input.account_id } : {},
      );
      return { results };
    },
  };
}

// ── mail_orders ───────────────────────────────────────────────────────

const OrdersInput = z.object({
  include_delivered: z.boolean().default(false).describe('Include recently-delivered orders (default: only what is still coming).'),
  limit: z.number().int().min(1).max(50).default(25),
});
const ShipmentCard = z.object({
  carrier: z.string().nullable(),
  tracking_number: z.string().nullable(),
  tracking_url: z.string().nullable(),
  status: z.string(),
  expected_delivery: z.string().nullable(),
});
const OrderCard = z.object({
  merchant: z.string(),
  order_number: z.string().nullable(),
  items: z.string().nullable(),
  total: z.string().nullable(),
  status: z.string(),
  flagged: z.boolean(),
  order_date: z.string().nullable(),
  updated_at: z.string(),
  shipments: z.array(ShipmentCard),
});
const OrdersOutput = z.object({ orders: z.array(OrderCard), note: z.string().optional() });

function make_mail_orders(db: import('bun:sqlite').Database): Tool<z.infer<typeof OrdersInput>, z.infer<typeof OrdersOutput>> {
  return {
    name: 'mail_orders',
    description:
      "Read the Orders / Trackables view — Jasper's order confirmations + their " +
      'shipping/tracking, threaded per order (merchant, order #, carrier, ' +
      'tracking link, status, expected delivery). Use for "where\'s my package?", ' +
      '"did X ship?", "what\'s arriving this week?". Defaults to what\'s still in ' +
      'transit; pass include_delivered for recently-delivered too.',
    risk: 'read',
    required_capabilities: ['read_mail'],
    input_schema: OrdersInput,
    output_schema: OrdersOutput,
    idempotency_key: (i) => `mail_orders:${i.include_delivered}:${i.limit}`,
    async execute(input, ctx) {
      const orders = new MailOrders(db)
        .list({ active_only: !input.include_delivered, limit: input.limit * 2 })
        .filter((o) => visible(ctx, o))
        .slice(0, input.limit);
      return {
        orders: orders.map((o) => ({
          merchant: o.merchant,
          order_number: o.order_number,
          items: o.items,
          total: o.order_total,
          status: o.status,
          flagged: o.flagged,
          order_date: o.order_date,
          updated_at: o.updated_at,
          shipments: o.shipments.map((s) => ({
            carrier: s.carrier,
            tracking_number: s.tracking_number,
            tracking_url: s.tracking_url,
            status: s.status,
            expected_delivery: s.expected_delivery,
          })),
        })),
        ...(orders.length === 0 ? { note: 'No tracked orders right now.' } : {}),
      };
    },
  };
}

export function create_mail_tools(deps: ToolDeps): Tool[] {
  return [
    make_mail_list(deps.db) as Tool,
    make_mail_thread(deps.db) as Tool,
    make_mail_search(deps.db) as Tool,
    make_mail_orders(deps.db) as Tool,
    make_mail_sync(deps) as Tool,
  ];
}
