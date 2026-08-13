/**
 * Kate's Post Office office tab — data feed + account setup.
 *
 *   GET  /api/specialists/:id/postoffice            — pane data (accounts
 *        redacted + cordon-filtered, triaged buckets, presets for the gear)
 *   POST /api/specialists/:id/postoffice/accounts            — create (owner)
 *   POST /api/specialists/:id/postoffice/accounts/:aid       — patch / delete (owner)
 *   POST /api/specialists/:id/postoffice/accounts/:aid/test  — connect + sync (owner)
 *   POST /api/specialists/:id/postoffice/sync                — refresh all (owner)
 *
 * Mounted at app.route('/api/specialists', …) — the EXISTING /api namespace,
 * so NO nginx alternation change (unlike /api/news). Capability-gated per
 * specialist (read_mail) so any future mail-reading front inherits it.
 *
 * Cordon: the READ surface is household — every account + message is filtered
 * through `note_visible_to_caller` (the owner has NO god-view of a household
 * member's inbox). Account SETUP is owner-only (Jasper configures the inboxes).
 * Credentials never leave the secret store: the GET returns the redacted view
 * (`*_password_set` booleans), the POST audits changed KEY NAMES not values.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import type { LLMRouter } from '@core/llm';
import type { AppEventBus } from '@app/events';
import type { SpecialistRegistry } from '@core/specialist';
import type { MemoryClient } from '@memory/client';
import type { Tier, UserRegistry } from '@core/users';
import { note_visible_to_caller } from '@memory/private_to';
import {
  MailAccounts,
  MAIL_PRESETS,
  type MailProvider,
  type RedactedMailAccount,
} from '@memory/stores/mail_accounts';
import { MailStore, MAIL_BUCKETS, type MailBucket, type MailMessage } from '@memory/stores/mail';
import { MailOrders } from '@memory/stores/mail_orders';
import { sync_all, retriage_all } from '@core/mail_ingest';
import { ulid } from 'ulid';

export interface PostOfficeRouterDeps {
  db: Database;
  memory: MemoryClient;
  specialists: SpecialistRegistry;
  llm: LLMRouter;
  events?: AppEventBus;
  /** Identity store — lets retriage flag misdirected mail (owner-name mismatch
   *  → not_me), matching the live ingest path. Optional; absent ⇒ no detection. */
  users?: UserRegistry;
}

const BUCKET_LABELS: Record<MailBucket, string> = {
  needs_you: 'Needs you',
  replies: 'Replies to your threads',
  new_mail: 'New mail',
  fyi: 'FYI / subscriptions',
  junk: 'Filtered junk',
};

const PROVIDERS = ['gmail', 'icloud', 'outlook', 'fastmail', 'manual'] as const;

const AccountCreate = z.object({
  display_name: z.string().min(1).max(120),
  provider: z.enum(PROVIDERS),
  private_to: z.enum(['owner', 'household']).default('owner'),
  imap_host: z.string().max(255).optional(),
  imap_port: z.number().int().min(1).max(65535).optional(),
  imap_user: z.string().max(320).optional(),
  imap_password: z.string().max(512).optional(),
  smtp_host: z.string().max(255).optional(),
  smtp_port: z.number().int().min(1).max(65535).optional(),
  smtp_user: z.string().max(320).optional(),
  smtp_password: z.string().max(512).optional(),
  enabled: z.boolean().optional(),
});

const AccountPatch = AccountCreate.partial().extend({
  delete: z.boolean().optional(),
  clear_imap_password: z.boolean().optional(),
  clear_smtp_password: z.boolean().optional(),
});

function card(m: MailMessage) {
  return {
    id: m.id,
    account_id: m.account_id,
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
    summary: m.summary,
    suggested_action: m.suggested_action,
    list_unsubscribe: m.list_unsubscribe,
    // The REAL action behind the suggestion, when one is web-actionable today:
    // reply → a mailto: that opens the user's mail client (Re: prefilled);
    // confirm/schedule → the confirmation/RSVP link extracted from the body.
    // Null ⇒ the card falls back to expand-and-read. (Add-to-calendar as an
    // EventKit writeback is the iOS-closure layer, separate.)
    action: action_for(m),
  };
}

/** Extract the genuinely-actionable target for a suggestion, web-native + safe.
 *  Conservative on confirm: only a link clearly associated with confirming (by
 *  surrounding text or its own path), never a random/unsub link. */
function action_for(m: MailMessage): { url: string; label: string; kind: string } | null {
  const sa = m.suggested_action;
  if (sa === 'reply' && m.from_addr) {
    const base = (m.subject || '').replace(/^\s*(re|fwd?):\s*/i, '').trim();
    return { kind: 'reply', label: 'Reply', url: `mailto:${m.from_addr}?subject=${encodeURIComponent(`Re: ${base}`)}` };
  }
  if (sa === 'confirm' || sa === 'schedule') {
    const url = confirm_link(m.body_text || '');
    if (url) return { kind: sa, label: sa === 'confirm' ? 'Confirm' : 'Open invite', url };
  }
  return null;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/;
function confirm_link(body: string): string | null {
  if (!body) return null;
  const kw = /(confirm|verif|rsvp|approve|activate|accept|reservation|appointment|booking)/i;
  for (const line of body.split(/\n+/)) {
    if (!kw.test(line)) continue;
    const u = line.match(URL_RE);
    if (u && !/unsub|optout|opt-out|list-manage/i.test(u[0])) return u[0];
  }
  const all = [...body.matchAll(new RegExp(URL_RE, 'g'))].map((x) => x[0]).filter((u) => !/unsub|optout|opt-out|list-manage/i.test(u));
  return all.find((u) => kw.test(u)) ?? null;
}

/** What earns a place in the digest ("what needs you"): real human mail
 *  (replies / personal), the fail-open unknowns, and transactional ONLY when
 *  it's actionable (confirm/schedule/reply or high importance). Everything
 *  else — subscriptions, promos, platform notifications, junk — is filtered
 *  (counted, not shown). */
function in_digest(m: MailMessage): boolean {
  // Misdirected ("not me") surfaces ONCE so the user can confirm + suppress the
  // sender — even though the judge may have categorized it junk_spam.
  if (m.suggested_action === 'not_me') return true;
  if (m.is_reply_to_me) return true;
  if (m.triage_category === 'authentic_personal' || m.triage_category === 'authentic_reply') return true;
  if (m.triage_category === 'unknown') return true;
  if (m.triage_category === 'transactional') {
    return ['confirm', 'schedule', 'reply'].includes(m.suggested_action) || m.triage_importance >= 0.6;
  }
  return false;
}

export function create_postoffice_router(deps: PostOfficeRouterDeps): Hono {
  const r = new Hono();
  const accounts = new MailAccounts(deps.db);
  const store = new MailStore(deps.db);
  const orders = new MailOrders(deps.db);

  /** Resolve specialist + authenticated user; 404 when the specialist can't
   *  serve a Post Office, 401 when unauthenticated. */
  function gate(c: Context):
    | { ok: true; user: { id: string; tier: Tier }; sid: string }
    | { ok: false; res: Response } {
    const user = c.get('user') as { id: string; tier: Tier } | undefined;
    if (!user) return { ok: false, res: c.json({ error: 'unauthenticated' }, 401) };
    const sid = c.req.param('id');
    if (!sid) return { ok: false, res: c.json({ error: 'missing specialist id' }, 400) };
    const specialist = deps.specialists.get(sid);
    if (!specialist || !specialist.granted.has('read_mail')) {
      return { ok: false, res: c.json({ error: 'no post office for this specialist' }, 404) };
    }
    return { ok: true, user, sid };
  }

  // ── GET pane data ────────────────────────────────────────────────────
  r.get('/:id/postoffice', (c) => {
    const g = gate(c);
    if (!g.ok) return g.res;
    const caller = { user_id: g.user.id, tier: g.user.tier };

    const visible_accounts: RedactedMailAccount[] = accounts
      .list_redacted()
      .filter((a) => note_visible_to_caller(a.private_to, caller));
    const visible_ids = new Set(visible_accounts.map((a) => a.id));

    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const caller_can_see = (m: MailMessage) =>
      visible_ids.has(m.account_id) && note_visible_to_caller(m.private_to, caller);

    // The DIGEST — only what actually needs you, importance-ranked. Not a mail
    // dump: subscriptions / promos / platform notifications / junk are filtered
    // (counted, not listed). Each item carries Kate's one-line summary + a
    // recommended action; the client renders cards with act controls.
    // Drop senders the user has marked "Not me" (learned suppression) — counted
    // in filtered_count, never surfaced. Generic; reversible by deleting the row.
    const suppressed = store.suppressed_addrs([...visible_ids]);
    const recent = store
      .recent_inbound({ since, limit: 300 })
      .filter(caller_can_see)
      .filter((m) => !suppressed.has((m.from_addr || '').toLowerCase()));
    const surfaced = recent.filter(in_digest);
    surfaced.sort(
      (a, b) => b.triage_importance - a.triage_importance || (a.date_utc < b.date_utc ? 1 : -1),
    );
    const digest = surfaced.slice(0, 40).map(card);
    const filtered_count = recent.length - surfaced.length;

    // Buckets retained for the iOS surface + the cordon smoke; the web client
    // renders the digest, not these.
    const counts: Record<string, number> = {};
    const buckets = MAIL_BUCKETS.map((bucket) => {
      const rows = store
        .list({ buckets: [bucket], since, limit: 60 })
        .filter(caller_can_see);
      counts[bucket] = rows.length;
      return { bucket, label: BUCKET_LABELS[bucket], count: rows.length, messages: rows.slice(0, 12).map(card) };
    });

    // Orders / Trackables subtab — order confirmations threaded with their
    // shipping + tracking, cordon-filtered. active_only keeps it "what's coming"
    // (recently-delivered stays for confirmation).
    const order_rows = orders
      .list({ active_only: true, limit: 100 })
      .filter((o) => note_visible_to_caller(o.private_to, caller))
      .map((o) => ({
        id: o.id,
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
      }));

    return c.json({
      accounts: visible_accounts,
      presets: MAIL_PRESETS,
      // The digest is the primary surface: what needs you, ranked, each with
      // Kate's summary + a recommended action. `filtered_count` is the noise
      // she kept out (count only — no readout). buckets/counts are legacy.
      digest,
      filtered_count,
      counts,
      buckets,
      orders: order_rows,
      // Every authenticated user may configure THEIR OWN inboxes (self-service);
      // the owner may additionally share an inbox household-wide. The client
      // shows the setup gear to all; the POST routes enforce per-account
      // ownership (a user can only touch accounts they own; owner touches any).
      can_configure: true,
      can_share_household: g.user.tier === 'owner',
      generated_at: new Date().toISOString(),
    });
  });

  /** May this caller manage (edit/delete/test/sync) this account? The owner
   *  manages any; everyone else only their OWN accounts. */
  function can_manage(user: { id: string; tier: Tier }, account: { user_id: string }): boolean {
    return user.tier === 'owner' || account.user_id === user.id;
  }

  async function body<S extends z.ZodTypeAny>(c: Context, schema: S):
    Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      return { ok: false, res: c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400) };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return { ok: false, res: c.json({ error: parsed.error.message }, 400) };
    return { ok: true, data: parsed.data };
  }

  // ── create account (self-service: any user adds their OWN inbox) ──────
  r.post('/:id/postoffice/accounts', async (c) => {
    const g = gate(c);
    if (!g.ok) return g.res;
    const b = await body(c, AccountCreate);
    if (!b.ok) return b.res;
    // The owner may share an inbox household-wide (owner|household); everyone
    // else gets their OWN silo (private_to = their user id) — the owner has no
    // god-view of a member's personal inbox.
    const private_to = g.user.tier === 'owner' ? b.data.private_to : g.user.id;
    const id = accounts.create({
      user_id: g.user.id,
      private_to,
      display_name: b.data.display_name,
      provider: b.data.provider as MailProvider,
      imap_host: b.data.imap_host,
      imap_port: b.data.imap_port,
      imap_user: b.data.imap_user,
      imap_password: b.data.imap_password,
      smtp_host: b.data.smtp_host,
      smtp_port: b.data.smtp_port,
      smtp_user: b.data.smtp_user,
      smtp_password: b.data.smtp_password,
      enabled: b.data.enabled,
    });
    deps.memory.log_action({
      intent_id: ulid(),
      agent: 'orchestrator',
      tool_name: 'postoffice_account_create',
      tool_input: { account_id: id, provider: b.data.provider, private_to, owner: g.user.id },
    });
    deps.events?.emit({ type: 'mail_account_updated', account_id: id, specialist_id: g.sid, user_id: g.user.id, status: 'untested' });
    return c.json({ ok: true, account: accounts.get_redacted(id) });
  });

  // ── patch / delete account (only your own; owner any) ────────────────
  r.post('/:id/postoffice/accounts/:aid', async (c) => {
    const g = gate(c);
    if (!g.ok) return g.res;
    const aid = c.req.param('aid');
    const existing = accounts.get(aid);
    if (!existing) return c.json({ error: 'account not found' }, 404);
    if (!can_manage(g.user, existing)) return c.json({ error: 'not your account' }, 403);
    const b = await body(c, AccountPatch);
    if (!b.ok) return b.res;

    if (b.data.delete) {
      accounts.delete(aid);
      deps.memory.log_action({
        intent_id: ulid(),
        agent: 'orchestrator',
        tool_name: 'postoffice_account_delete',
        tool_input: { account_id: aid },
      });
      deps.events?.emit({ type: 'mail_account_updated', account_id: aid, specialist_id: g.sid, user_id: g.user.id, status: 'deleted' });
      return c.json({ ok: true, deleted: true });
    }

    if (b.data.clear_imap_password) accounts.clear_secret(aid, 'imap_password');
    if (b.data.clear_smtp_password) accounts.clear_secret(aid, 'smtp_password');

    const { delete: _d, clear_imap_password: _c1, clear_smtp_password: _c2, ...patch } = b.data;
    const changed = accounts.set(aid, patch);
    deps.memory.log_action({
      intent_id: ulid(),
      agent: 'orchestrator',
      tool_name: 'postoffice_account_update',
      // Audit the changed KEY NAMES, never the values (secret-safe).
      tool_input: { account_id: aid, changed },
    });
    deps.events?.emit({ type: 'mail_account_updated', account_id: aid, specialist_id: g.sid, user_id: g.user.id, status: accounts.get(aid)?.connection_status ?? 'untested' });
    return c.json({ ok: true, account: accounts.get_redacted(aid), changed });
  });

  // ── test connection (connect + a real sync) ──────────────────────────
  r.post('/:id/postoffice/accounts/:aid/test', async (c) => {
    const g = gate(c);
    if (!g.ok) return g.res;
    const aid = c.req.param('aid');
    const existing = accounts.get(aid);
    if (!existing) return c.json({ error: 'account not found' }, 404);
    if (!can_manage(g.user, existing)) return c.json({ error: 'not your account' }, 403);
    const [result] = await sync_all(
      accounts,
      { db: deps.db, llm: deps.llm, events: deps.events },
      { only_account_id: aid },
    );
    deps.events?.emit({ type: 'mail_account_updated', account_id: aid, specialist_id: g.sid, user_id: g.user.id, status: result?.status ?? 'untested' });
    return c.json({ ok: result?.status === 'ok', result });
  });

  // ── sync (manual refresh — scoped to the caller's own accounts) ──────
  r.post('/:id/postoffice/sync', async (c) => {
    const g = gate(c);
    if (!g.ok) return g.res;
    const mine = accounts.list({ enabled_only: true }).filter((a) => can_manage(g.user, a));
    const deps_bag = { db: deps.db, llm: deps.llm, events: deps.events, users: deps.users };
    const results = [];
    for (const a of mine) {
      const [r0] = await sync_all(accounts, deps_bag, { only_account_id: a.id });
      if (r0) results.push(r0);
    }
    return c.json({ ok: true, results });
  });

  // ── read one message in full (the "Open" action — read + act on it) ──
  r.get('/:id/postoffice/messages/:mid', (c) => {
    const g = gate(c);
    if (!g.ok) return g.res;
    const mid = c.req.param('mid');
    const m = store.get(mid ?? '');
    if (!m) return c.json({ error: 'message not found' }, 404);
    if (!note_visible_to_caller(m.private_to, { user_id: g.user.id, tier: g.user.tier })) {
      return c.json({ error: 'not your message' }, 403);
    }
    return c.json({
      id: m.id,
      from: m.from_addr,
      from_name: m.from_name,
      to: m.to,
      subject: m.subject,
      date: m.date_utc,
      body: m.body_text,
      summary: m.summary,
      suggested_action: m.suggested_action,
      category: m.triage_category,
      list_unsubscribe: m.list_unsubscribe,
      thread_key: m.thread_key,
    });
  });

  // ── dismiss a message from the digest (handled) ──────────────────────
  r.post('/:id/postoffice/messages/:mid/handled', async (c) => {
    const g = gate(c);
    if (!g.ok) return g.res;
    const mid = c.req.param('mid');
    const msg = store.get(mid ?? '');
    if (!msg) return c.json({ error: 'message not found' }, 404);
    if (!note_visible_to_caller(msg.private_to, { user_id: g.user.id, tier: g.user.tier })) {
      return c.json({ error: 'not your message' }, 403);
    }
    let handled = true;
    let reason: string | undefined;
    try {
      const b = (await c.req.json()) as { handled?: boolean; reason?: string };
      if (typeof b.handled === 'boolean') handled = b.handled;
      if (typeof b.reason === 'string') reason = b.reason;
    } catch { /* default true */ }
    store.set_handled(mid!, handled);
    // "Not me" — the message is misdirected (a notice for someone else). Learn
    // it: suppress this sender so future mail from them is filtered from the
    // digest. Generic + reversible (delete the row), never a hardcoded block.
    let suppressed = false;
    if (reason === 'not_me' && msg.from_addr) {
      store.suppress(msg.account_id, msg.from_addr, 'not_me');
      suppressed = true;
      deps.memory.log_action({
        intent_id: ulid(),
        agent: g.sid,
        user_id: msg.user_id,
        tool_name: 'mail_sender_suppressed',
        tool_input: { account_id: msg.account_id, from_addr: msg.from_addr, message_id: mid },
      });
    }
    deps.events?.emit({ type: 'mail_message_triaged', account_id: msg.account_id, message_id: mid!, bucket: msg.triage_bucket, specialist_id: g.sid, user_id: msg.user_id });
    return c.json({ ok: true, handled, suppressed });
  });

  // ── re-triage stored mail (apply a triage-logic upgrade to existing) ─
  r.post('/:id/postoffice/retriage', async (c) => {
    const g = gate(c);
    if (!g.ok) return g.res;
    const mine = accounts.list({ enabled_only: true }).filter((a) => can_manage(g.user, a));
    const deps_bag = { db: deps.db, llm: deps.llm, events: deps.events, users: deps.users };
    const results: { account_id: string; retriaged: number }[] = [];
    for (const a of mine) {
      const [r0] = await retriage_all(accounts, deps_bag, { only_account_id: a.id });
      if (r0) results.push(r0);
    }
    deps.events?.emit({ type: 'mail_account_updated', account_id: mine[0]?.id ?? '', specialist_id: g.sid, user_id: g.user.id, status: 'ok' });
    return c.json({ ok: true, results });
  });

  return r;
}
