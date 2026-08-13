/**
 * Mail ingest — the shared parse → thread → triage → store pipeline.
 *
 * Used by BOTH the always-on IMAP IDLE driver (src/core/mail_idle.ts, on each
 * pushed message) and the on-demand `mail_sync` tool. One pipeline so the
 * push path and the manual pull path can never diverge.
 *
 * The live IMAP fetch is behind a transport SEAM (`_test_set_fetcher`) so the
 * whole pipeline — header parsing, RFC reply-threading, triage, idempotent
 * store — is unit-testable with canned MIME and no network (the smoke feeds
 * raw messages through the seam; only the thin default imapflow fetcher needs
 * a live server, validated by the spike + the live step).
 *
 * Fail-open + isolated: a message that throws is logged and skipped, never
 * aborting the rest of the sync; a connection failure marks the account's
 * status and returns, never crashes the driver/turn.
 *
 * Library/RAG shelving of significant mail is a deferred follow-up (see the
 * SHELVING TODO below) — `MailStore.search` already gives in-app search; this
 * keeps the v1 dependency surface small.
 */
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { Database } from 'bun:sqlite';
import type { LLMRouter } from '@core/llm';
import type { AppEventBus } from '@app/events';
import type { UserRegistry } from '@core/users';
import { MailStore, type MailMessage, type MailMessageInput, type MailDirection } from '@memory/stores/mail';
import type { MailAccount, MailAccounts } from '@memory/stores/mail_accounts';
import {
  derive_structural,
  triage_message,
  has_preheader_padding,
  type StructuralHeaders,
} from '@core/mail_triage';
import { MailOrders } from '@memory/stores/mail_orders';
import { extract_order, build_order_upsert } from '@core/mail_orders_extract';
import { resolve_user_model } from '@core/user_model';
import { UserProfileStore } from '@memory/stores/user_profile';
import {
  household_services_enabled,
  domain_of_addr,
  services_matching_domain,
  render_service_triage_lines,
} from '@core/household_services';
import type { Caller } from '@memory/private_to';

export interface MailIngestDeps {
  db: Database;
  /** Triage judge. Absent ⇒ triage fails open to the safe default. */
  llm?: LLMRouter;
  /** SSE bus — a `mail_message_triaged` is emitted per new inbound message. */
  events?: AppEventBus;
  /** Identity store — resolves the account owner's name(s) so triage can flag
   *  misdirected mail (a notice for a different person → 'not_me'). Optional;
   *  absent ⇒ no misdirected detection (existing behavior). */
  users?: UserRegistry;
}

/** A raw message as the fetcher yields it. */
export interface RawMessage {
  uid: number;
  source: Buffer | string;
}

/** The transport seam: pull new INBOX + recent SENT raw messages for an
 *  account. The default impl uses imapflow; the smoke overrides it. */
export type MailFetcher = (
  account: MailAccount,
  opts: { since_uid: number; inbox_limit: number; sent_days: number },
) => Promise<{ inbox: RawMessage[]; sent: RawMessage[] }>;

// ── header helpers ────────────────────────────────────────────────────

function hdr(parsed: ParsedMail, name: string): string | null {
  const v = parsed.headers.get(name);
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
  }
  // The transport/auth headers we read (Authentication-Results, List-Id,
  // Precedence, …) are plain strings; a structured value coerces best-effort.
  const text = (v as { text?: unknown }).text;
  return typeof text === 'string' ? text : String(v);
}

/** Normalize In-Reply-To / References into a token list of `<id@host>`. */
function id_tokens(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const text = Array.isArray(raw) ? raw.join(' ') : raw;
  return (text.match(/<[^>]+>/g) ?? []).map((s) => s.trim());
}

/** The https one-click-unsubscribe URL from a List-Unsubscribe header
 *  (`<https://…>, <mailto:…>`), if any — backs the unsubscribe action. */
function list_unsub_url(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/<(https?:\/\/[^>]+)>/i);
  return m ? m[1]! : null;
}

const BODY_CAP = 32_000;

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

interface ParsedFields {
  message_id: string | null;
  in_reply_to: string | null;
  references: string[];
  from_addr: string;
  from_name: string;
  to: string[];
  subject: string;
  date_utc: string;
  snippet: string;
  body_text: string;
  structural: ReturnType<typeof derive_structural>;
  /** The https List-Unsubscribe URL, when present (the unsubscribe action). */
  list_unsubscribe: string | null;
  /** Preheader/zero-width padding in the body — a mass-marketing tell. */
  looks_templated: boolean;
}

async function parse_fields(raw: Buffer | string, now: Date): Promise<ParsedFields> {
  const parsed = await simpleParser(raw);
  const from0 = parsed.from?.value?.[0];
  const refs = id_tokens(parsed.references);
  const in_reply_to = id_tokens(parsed.inReplyTo)[0] ?? null;
  // mailparser: `html` is `string | false`; `text` is `string | undefined`.
  const html = typeof parsed.html === 'string' ? parsed.html : '';
  const body_text = clip(parsed.text || html || '', BODY_CAP);
  const to: string[] = [];
  const to_addrs = parsed.to;
  const to_list = Array.isArray(to_addrs) ? to_addrs : to_addrs ? [to_addrs] : [];
  for (const a of to_list) for (const v of a.value ?? []) if (v.address) to.push(v.address);
  const list_unsub_hdr = hdr(parsed, 'list-unsubscribe');
  const structural = derive_structural({
    authentication_results: hdr(parsed, 'authentication-results'),
    list_id: hdr(parsed, 'list-id'),
    list_unsubscribe: list_unsub_hdr,
    precedence: hdr(parsed, 'precedence'),
    auto_submitted: hdr(parsed, 'auto-submitted'),
    from_addr: from0?.address ?? '',
    return_path: hdr(parsed, 'return-path'),
  });
  return {
    message_id: parsed.messageId ?? null,
    in_reply_to,
    references: refs,
    from_addr: from0?.address ?? '',
    from_name: from0?.name ?? '',
    to,
    subject: parsed.subject ?? '',
    date_utc: (parsed.date ?? now).toISOString(),
    snippet: clip(body_text.replace(/\s+/g, ' ').trim(), 240),
    body_text,
    structural,
    list_unsubscribe: list_unsub_url(list_unsub_hdr),
    looks_templated: has_preheader_padding(body_text),
  };
}

/** Build the short "about the recipient" string the triage judge weighs for
 *  pertinence. Best-effort: any error → undefined (triage still runs). */
function user_context(db: Database, user_id: string, now: Date): string | undefined {
  try {
    const store = new UserProfileStore(db);
    const { facets } = resolve_user_model(store, user_id, 'kate', now);
    const lines = facets
      .filter((f) => f.summary.trim().length > 0)
      .map((f) => `${f.key}: ${f.summary.trim()}`);
    return lines.length > 0 ? clip(lines.join(' | '), 1200) : undefined;
  } catch {
    return undefined;
  }
}

/** The account owner's identifying name(s) for misdirected-mail detection —
 *  display name + the user's email + THE MAILBOX ADDRESS (imap_user). The
 *  mailbox address is the most reliable surname source (jasperdoe@… → "law"), so
 *  a notice for "Jasper Fenwick" reads as misdirected while "Jasper Doe" doesn't.
 *  Best-effort; absent → []. */
function owner_names_for(users: UserRegistry | undefined, account: MailAccount): string[] {
  const out: string[] = [];
  if (account.imap_user) out.push(account.imap_user);
  if (users) {
    try {
      const u = users.get(account.user_id);
      if (u?.display_name) out.push(u.display_name);
      if (u?.email) out.push(u.email);
    } catch {
      /* ignore */
    }
  }
  return [...new Set(out.filter((x) => x && x.trim().length > 0))];
}

/**
 * Standing-facts grounding for the triage judge (Services & Bills ledger,
 * 2026-07-04): candidate service matches for the SENDER's domain + the
 * household's member names. Evidence-shaping in a system pipeline — the
 * judge still decides legitimacy/pertinence; the code only fetches. Gated
 * behind HEARTH_HOUSEHOLD_SERVICES (off ⇒ byte-identical triage input) and
 * best-effort: any error → {} (triage still runs).
 */
function service_grounding(
  db: Database,
  from_addr: string,
  account: MailAccount,
  users: UserRegistry | undefined,
): { known_services?: string[]; household_names?: string[] } {
  if (!household_services_enabled()) return {};
  const out: { known_services?: string[]; household_names?: string[] } = {};
  try {
    // The ledger is household-shared; the account owner's tier gates the read
    // (a friend-tier account sees none of it).
    const tier = users?.get(account.user_id)?.tier ?? 'household';
    const caller: Caller = { user_id: account.user_id, tier };
    const rows = services_matching_domain(db, domain_of_addr(from_addr), caller);
    if (rows.length > 0) out.known_services = render_service_triage_lines(rows);
  } catch {
    /* best-effort */
  }
  try {
    const names = (users?.list() ?? [])
      .map((u) => u.display_name)
      .filter((n): n is string => typeof n === 'string' && n.trim().length > 0);
    if (names.length > 0) out.household_names = [...new Set(names)];
  } catch {
    /* best-effort */
  }
  return out;
}

/**
 * Ingest one raw message for an account. Parses, threads, triages (inbound
 * only — a sent message is stored for threading + the style corpus, not
 * triaged), upserts idempotently, and emits the SSE event for a new inbound.
 * Returns the store result; never throws (errors bubble to the caller's
 * per-message try/catch).
 */
export async function ingest_one(
  raw: Buffer | string,
  account: MailAccount,
  uid: number,
  direction: MailDirection,
  deps: MailIngestDeps,
  now: Date,
): Promise<{ id: string; is_new: boolean; bucket: string }> {
  const store = new MailStore(deps.db);
  const f = await parse_fields(raw, now);
  const thread_key = f.references[0] ?? f.in_reply_to ?? f.message_id ?? `uid:${account.id}:${uid}`;

  if (direction === 'sent') {
    // Stored for reply-threading (its Message-ID anchors future replies) and
    // for the writing-style corpus (recent_sent_bodies). No triage.
    const res = store.upsert({
      direction: 'sent',
      account_id: account.id,
      user_id: account.user_id,
      private_to: account.private_to,
      uid,
      message_id: f.message_id,
      in_reply_to: f.in_reply_to,
      references: f.references,
      thread_key,
      from_addr: f.from_addr,
      from_name: f.from_name,
      to: f.to,
      subject: f.subject,
      date_utc: f.date_utc,
      snippet: f.snippet,
      body_text: f.body_text,
      auth_spf: 'none',
      auth_dkim: 'none',
      auth_dmarc: 'none',
      is_bulk: false,
      aligned: true,
      triage_category: 'sent',
      triage_importance: 0,
      triage_reasons: [],
      triage_bucket: 'new_mail',
      is_reply_to_me: false,
      summary: '',
      suggested_action: 'dismiss',
      list_unsubscribe: null,
    });
    return { id: res.id, is_new: res.is_new, bucket: 'new_mail' };
  }

  // Inbound: thread against the user's sent message-ids, then triage.
  const refs = [...f.references, ...(f.in_reply_to ? [f.in_reply_to] : [])];
  const is_reply_to_me = store.sent_ids_matching(account.user_id, refs).length > 0;
  const owner_names = owner_names_for(deps.users, account);
  const verdict = await triage_message(
    {
      from_addr: f.from_addr,
      from_name: f.from_name,
      subject: f.subject,
      snippet: f.snippet,
      body_text: f.body_text,
      structural: f.structural,
      is_reply_to_me,
      looks_templated: f.looks_templated,
      user_context: user_context(deps.db, account.user_id, now),
      ...(owner_names.length ? { owner_names } : {}),
      ...service_grounding(deps.db, f.from_addr, account, deps.users),
    },
    deps.llm,
  );

  const input: MailMessageInput = {
    direction: 'inbound',
    account_id: account.id,
    user_id: account.user_id,
    private_to: account.private_to,
    uid,
    message_id: f.message_id,
    in_reply_to: f.in_reply_to,
    references: f.references,
    thread_key,
    from_addr: f.from_addr,
    from_name: f.from_name,
    to: f.to,
    subject: f.subject,
    date_utc: f.date_utc,
    snippet: f.snippet,
    body_text: f.body_text,
    auth_spf: f.structural.spf,
    auth_dkim: f.structural.dkim,
    auth_dmarc: f.structural.dmarc,
    is_bulk: f.structural.is_bulk,
    aligned: f.structural.aligned,
    triage_category: verdict.category,
    triage_importance: verdict.importance,
    triage_reasons: verdict.reasons,
    triage_bucket: verdict.bucket,
    is_reply_to_me,
    summary: verdict.summary,
    suggested_action: verdict.suggested_action,
    list_unsubscribe: f.list_unsubscribe,
  };
  const res = store.upsert(input);

  // Orders / Trackables: a transactional message (authentic by the triage
  // gate) may be an order confirmation / shipping notice / delivery update.
  // Extract its structured fields and merge into the per-order trackable —
  // a confirmation, its shipment, and its delivery collapse into one row with
  // a carrier + tracking link. Fail-open: not an order / extractor down → skip.
  if (verdict.category === 'transactional') {
    try {
      const extracted = await extract_order(
        { from_addr: f.from_addr, from_name: f.from_name, subject: f.subject, body_text: f.body_text },
        deps.llm,
      );
      if (extracted) {
        const up = build_order_upsert(extracted, {
          user_id: account.user_id,
          private_to: account.private_to,
          message_id: res.id,
          from_addr: f.from_addr,
          date_utc: f.date_utc,
        });
        if (up) {
          const { is_new } = new MailOrders(deps.db).upsert(up);
          // Signal the Household-Knowledge driver to fan this order into the
          // graph (enrich → good node + edges → specialist slices). Thin
          // (user_id, order_key) signal — the driver reads the merged order
          // back. Gated + fail-open on the consumer side.
          deps.events?.emit({
            type: 'order_upserted',
            user_id: up.user_id,
            order_key: up.order_key,
            is_new,
          });
        }
      }
    } catch (err) {
      console.error(`[mail] order extract skip (acct ${account.id} uid ${uid}):`, err);
    }
  }

  // Second-brain shelving (2026-06-20): significant non-bulk mail is shelved to
  // the library via save_library_item (vault note + chunks_fts + embeddings,
  // RAG-searchable + feeding the knowledge graph) by the event-driven
  // MailShelfDriver (src/core/mail_shelf.ts), which subscribes to the
  // `mail_message_triaged` emit below. Decoupled so a shelve failure never
  // blocks ingest; gated by HEARTH_MAIL_SHELVE; idempotent via the shelved_at
  // stamp. Sent mail still feeds only the distilled 'style' facet, not RAG.

  if (res.is_new) {
    deps.events?.emit({
      type: 'mail_message_triaged',
      account_id: account.id,
      message_id: res.id,
      bucket: verdict.bucket,
      specialist_id: 'kate',
      user_id: account.user_id,
    });
  }
  return { id: res.id, is_new: res.is_new, bucket: verdict.bucket };
}

// ── live IMAP fetcher (the seam-default) ──────────────────────────────

async function imapflow_fetch(
  account: MailAccount,
  opts: { since_uid: number; inbox_limit: number; sent_days: number },
): Promise<{ inbox: RawMessage[]; sent: RawMessage[] }> {
  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: true,
    auth: { user: account.imap_user, pass: account.imap_password },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
  const inbox: RawMessage[] = [];
  const sent: RawMessage[] = [];
  await client.connect();
  try {
    // INBOX — new UIDs since the last sync (or recent on a cold start).
    {
      const lock = await client.getMailboxLock('INBOX', { readOnly: true });
      try {
        const since = new Date(Date.now() - 14 * 86_400_000);
        const uids =
          ((await client.search(
            opts.since_uid > 0 ? { uid: `${opts.since_uid + 1}:*` } : { since },
            { uid: true },
          )) || []) as number[];
        const fresh = uids.filter((u) => u > opts.since_uid).slice(-opts.inbox_limit);
        if (fresh.length > 0) {
          for await (const msg of client.fetch(fresh, { source: true }, { uid: true })) {
            if (msg.source) inbox.push({ uid: msg.uid, source: msg.source });
          }
        }
      } finally {
        lock.release();
      }
    }
    // SENT — recent, for threading + the writing-style corpus.
    {
      const sent_path = await find_sent_mailbox(client);
      if (sent_path) {
        const lock = await client.getMailboxLock(sent_path, { readOnly: true });
        try {
          const since = new Date(Date.now() - opts.sent_days * 86_400_000);
          const uids = ((await client.search({ since }, { uid: true })) || []) as number[];
          const recent = uids.slice(-opts.inbox_limit);
          if (recent.length > 0) {
            for await (const msg of client.fetch(recent, { source: true }, { uid: true })) {
              if (msg.source) sent.push({ uid: msg.uid, source: msg.source });
            }
          }
        } finally {
          lock.release();
        }
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return { inbox, sent };
}

async function find_sent_mailbox(client: ImapFlow): Promise<string | null> {
  try {
    for (const mb of await client.list()) {
      if (mb.specialUse === '\\Sent') return mb.path;
    }
    // Fallback to common names if no special-use flag.
    for (const name of ['Sent', 'Sent Messages', 'Sent Mail', '[Gmail]/Sent Mail']) {
      // best-effort existence check
      try {
        const lock = await client.getMailboxLock(name, { readOnly: true });
        lock.release();
        return name;
      } catch {
        /* not this one */
      }
    }
  } catch {
    /* list failed */
  }
  return null;
}

let _fetcher: MailFetcher = imapflow_fetch;
/** Test seam — override the IMAP transport with canned messages. */
export function _test_set_fetcher(fn: MailFetcher | null): void {
  _fetcher = fn ?? imapflow_fetch;
}

/**
 * Re-judge already-stored inbound mail (no re-fetch — the body is stored), so
 * a triage-logic change applies to existing messages. Reconstructs the
 * structural verdict from the stored row + recomputes the preheader signal,
 * re-runs the judge, and updates the verdict + summary + suggested_action in
 * place. Used after a triage upgrade (e.g. the v2 bulk/platform rules).
 */
export async function retriage_account(
  account: MailAccount,
  deps: MailIngestDeps,
  opts: { now?: Date; since_days?: number; limit?: number } = {},
): Promise<{ account_id: string; retriaged: number }> {
  const now = opts.now ?? new Date();
  const store = new MailStore(deps.db);
  const since = new Date(now.getTime() - (opts.since_days ?? 45) * 86_400_000).toISOString();
  const rows = store.recent_inbound({
    account_ids: [account.id],
    since,
    limit: opts.limit ?? 500,
    include_handled: true,
  });
  const ctx = user_context(deps.db, account.user_id, now);
  const owner_names = owner_names_for(deps.users, account);
  let retriaged = 0;
  for (const r of rows) {
    try {
      const verdict = await triage_message(
        {
          from_addr: r.from_addr,
          from_name: r.from_name,
          subject: r.subject,
          snippet: r.snippet,
          body_text: r.body_text,
          structural: {
            spf: r.auth_spf,
            dkim: r.auth_dkim,
            dmarc: r.auth_dmarc,
            is_bulk: r.is_bulk,
            aligned: r.aligned,
            has_list_unsub: !!r.list_unsubscribe,
          },
          is_reply_to_me: r.is_reply_to_me,
          looks_templated: has_preheader_padding(r.body_text),
          user_context: ctx,
          ...(owner_names.length ? { owner_names } : {}),
          ...service_grounding(deps.db, r.from_addr, account, deps.users),
        },
        deps.llm,
      );
      const updated: MailMessageInput = {
        ...r,
        triage_category: verdict.category,
        triage_importance: verdict.importance,
        triage_reasons: verdict.reasons,
        triage_bucket: verdict.bucket,
        summary: verdict.summary,
        suggested_action: verdict.suggested_action,
      };
      store.upsert(updated);
      retriaged++;
    } catch (err) {
      console.error(`[mail] retriage skip (acct ${account.id} msg ${r.id}):`, err);
    }
  }
  return { account_id: account.id, retriaged };
}

/** Re-triage every enabled account (or one), for a triage-logic upgrade. */
export async function retriage_all(
  accounts: MailAccounts,
  deps: MailIngestDeps,
  opts: { now?: Date; only_account_id?: string } = {},
): Promise<{ account_id: string; retriaged: number }[]> {
  const list = accounts
    .list({ enabled_only: true })
    .filter((a) => !opts.only_account_id || a.id === opts.only_account_id);
  const out: { account_id: string; retriaged: number }[] = [];
  for (const a of list) {
    try {
      out.push(await retriage_account(a, deps, { now: opts.now }));
    } catch (err) {
      console.error('[mail] retriage_all skip', a.id, err);
    }
  }
  return out;
}

export interface SyncResult {
  account_id: string;
  inbox_new: number;
  sent_new: number;
  status: MailAccount['connection_status'];
  error?: string;
}

/**
 * Pull + ingest one account. Connects via the (seam-able) fetcher, ingests
 * SENT first (so a same-batch inbound reply can thread against it), then
 * INBOX, updates the account's status. Fail-soft: a connection error marks
 * the account and returns; a single bad message is skipped.
 */
export async function sync_account(
  account: MailAccount,
  accounts: MailAccounts,
  deps: MailIngestDeps,
  opts: { now?: Date; inbox_limit?: number; sent_days?: number } = {},
): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  const store = new MailStore(deps.db);
  const since_uid = store.max_uid(account.id);
  let fetched: { inbox: RawMessage[]; sent: RawMessage[] };
  try {
    fetched = await _fetcher(account, {
      since_uid,
      inbox_limit: opts.inbox_limit ?? 100,
      sent_days: opts.sent_days ?? 60,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status: MailAccount['connection_status'] = /auth|credential|login|invalid/i.test(msg)
      ? 'auth_failed'
      : 'unreachable';
    accounts.set_status(account.id, { connection_status: status, last_error: msg });
    return { account_id: account.id, inbox_new: 0, sent_new: 0, status, error: msg };
  }

  let sent_new = 0;
  for (const m of fetched.sent) {
    try {
      const r = await ingest_one(m.source, account, m.uid, 'sent', deps, now);
      if (r.is_new) sent_new++;
    } catch (err) {
      console.error(`[mail] sent ingest skip (acct ${account.id} uid ${m.uid}):`, err);
    }
  }
  let inbox_new = 0;
  for (const m of fetched.inbox) {
    try {
      const r = await ingest_one(m.source, account, m.uid, 'inbound', deps, now);
      if (r.is_new) inbox_new++;
    } catch (err) {
      console.error(`[mail] inbox ingest skip (acct ${account.id} uid ${m.uid}):`, err);
    }
  }
  accounts.set_status(account.id, {
    connection_status: 'ok',
    last_synced_at: now.toISOString(),
    last_error: null,
  });
  return { account_id: account.id, inbox_new, sent_new, status: 'ok' };
}

/** Sync every enabled account (the mail_sync tool's default + the driver's
 *  periodic reconcile). Isolated per account. */
export async function sync_all(
  accounts: MailAccounts,
  deps: MailIngestDeps,
  opts: { now?: Date; only_account_id?: string } = {},
): Promise<SyncResult[]> {
  const list = accounts
    .list({ enabled_only: true })
    .filter((a) => !opts.only_account_id || a.id === opts.only_account_id);
  const out: SyncResult[] = [];
  for (const account of list) {
    try {
      out.push(await sync_account(account, accounts, deps, { now: opts.now }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      out.push({
        account_id: account.id,
        inbox_new: 0,
        sent_new: 0,
        status: 'unreachable',
        error: msg,
      });
    }
  }
  return out;
}
