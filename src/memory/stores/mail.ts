/**
 * MailStore — the triaged-mail projection for Kate's Post Office.
 *
 * One row per message (inbound or sent). The driver parses an IMAP message,
 * threads it, triages it, and upserts here; routes + the pane read from here.
 * Self-contained additive table in the constructor (CREATE TABLE IF NOT
 * EXISTS), no central SCHEMA_SQL edit, no SCHEMA_VERSION bump — the same
 * pattern as UserProfileStore / CodeShopSettings / MailAccounts.
 *
 * Idempotent on `(account_id, uid)`: an IMAP UID is stable within a mailbox,
 * so re-ingest after a reconnect/refetch updates the triage verdict in place
 * rather than duplicating. Named-sigil binds only (the open_db bind guard).
 *
 * Reply-threading (feature A) is RFC-correct: an inbound message is an
 * authentic reply to the user iff any id in its In-Reply-To / References set
 * matches a Message-ID the user SENT. We persist sent messages here too
 * (direction='sent') — which doubles as the writing-style corpus
 * (`recent_sent_bodies`) for the per-user 'style' facet.
 *
 * Cordon: every row carries `private_to`; read routes filter via
 * `note_visible_to_caller`. The owner has no god-view.
 */
import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';

export type MailDirection = 'inbound' | 'sent';

/** Triage buckets the pane groups by — emergent categories collapse into
 *  these five UI lanes. See src/core/mail_triage.ts for category → bucket. */
export type MailBucket = 'needs_you' | 'replies' | 'new_mail' | 'fyi' | 'junk';
export const MAIL_BUCKETS: readonly MailBucket[] = [
  'needs_you',
  'replies',
  'new_mail',
  'fyi',
  'junk',
];

/** Three-state header auth verdicts (from Authentication-Results). */
export type AuthVerdict = 'pass' | 'fail' | 'none';

/** The shape the driver hands `upsert` — everything it computed for a msg. */
export interface MailMessageInput {
  direction: MailDirection;
  account_id: string;
  user_id: string;
  private_to: string;
  uid: number;
  message_id: string | null;
  in_reply_to: string | null;
  references: string[];
  thread_key: string;
  from_addr: string;
  from_name: string;
  to: string[];
  subject: string;
  date_utc: string;
  snippet: string;
  body_text: string;
  auth_spf: AuthVerdict;
  auth_dkim: AuthVerdict;
  auth_dmarc: AuthVerdict;
  is_bulk: boolean;
  aligned: boolean;
  triage_category: string;
  triage_importance: number;
  triage_reasons: string[];
  triage_bucket: MailBucket;
  is_reply_to_me: boolean;
  /** Kate's one-line take (the digest line). */
  summary: string;
  /** reply | review | schedule | confirm | unsubscribe | dismiss */
  suggested_action: string;
  /** The List-Unsubscribe URL (http), when present — backs the unsubscribe action. */
  list_unsubscribe: string | null;
}

export interface MailMessage extends Omit<MailMessageInput, 'references' | 'to' | 'triage_reasons'> {
  id: string;
  references: string[];
  to: string[];
  triage_reasons: string[];
  /** User dismissed it from the digest (handled). */
  handled: boolean;
  ts: string;
}

interface Row {
  id: string;
  direction: string;
  account_id: string;
  user_id: string;
  private_to: string;
  uid: number;
  message_id: string | null;
  in_reply_to: string | null;
  references_json: string;
  thread_key: string;
  from_addr: string;
  from_name: string;
  to_json: string;
  subject: string;
  date_utc: string;
  snippet: string;
  body_text: string;
  auth_spf: string;
  auth_dkim: string;
  auth_dmarc: string;
  is_bulk: number;
  aligned: number;
  triage_category: string;
  triage_importance: number;
  triage_reasons_json: string;
  triage_bucket: string;
  is_reply_to_me: number;
  summary: string;
  suggested_action: string;
  list_unsubscribe: string | null;
  handled: number;
  ts: string;
}

function parse_arr(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function hydrate(r: Row): MailMessage {
  return {
    id: r.id,
    direction: r.direction as MailDirection,
    account_id: r.account_id,
    user_id: r.user_id,
    private_to: r.private_to,
    uid: r.uid,
    message_id: r.message_id,
    in_reply_to: r.in_reply_to,
    references: parse_arr(r.references_json),
    thread_key: r.thread_key,
    from_addr: r.from_addr,
    from_name: r.from_name,
    to: parse_arr(r.to_json),
    subject: r.subject,
    date_utc: r.date_utc,
    snippet: r.snippet,
    body_text: r.body_text,
    auth_spf: r.auth_spf as AuthVerdict,
    auth_dkim: r.auth_dkim as AuthVerdict,
    auth_dmarc: r.auth_dmarc as AuthVerdict,
    is_bulk: r.is_bulk === 1,
    aligned: r.aligned === 1,
    triage_category: r.triage_category,
    triage_importance: r.triage_importance,
    triage_reasons: parse_arr(r.triage_reasons_json),
    triage_bucket: r.triage_bucket as MailBucket,
    is_reply_to_me: r.is_reply_to_me === 1,
    summary: r.summary ?? '',
    suggested_action: r.suggested_action || 'review',
    list_unsubscribe: r.list_unsubscribe ?? null,
    handled: r.handled === 1,
    ts: r.ts,
  };
}

export interface MailListOpts {
  account_ids?: string[];
  buckets?: MailBucket[];
  direction?: MailDirection;
  since?: string;
  limit?: number;
}

export class MailStore {
  constructor(private db: Database) {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS mail_messages (
         id TEXT PRIMARY KEY,
         direction TEXT NOT NULL,
         account_id TEXT NOT NULL,
         user_id TEXT NOT NULL,
         private_to TEXT NOT NULL,
         uid INTEGER NOT NULL,
         message_id TEXT,
         in_reply_to TEXT,
         references_json TEXT NOT NULL DEFAULT '[]',
         thread_key TEXT NOT NULL DEFAULT '',
         from_addr TEXT NOT NULL DEFAULT '',
         from_name TEXT NOT NULL DEFAULT '',
         to_json TEXT NOT NULL DEFAULT '[]',
         subject TEXT NOT NULL DEFAULT '',
         date_utc TEXT NOT NULL,
         snippet TEXT NOT NULL DEFAULT '',
         body_text TEXT NOT NULL DEFAULT '',
         auth_spf TEXT NOT NULL DEFAULT 'none',
         auth_dkim TEXT NOT NULL DEFAULT 'none',
         auth_dmarc TEXT NOT NULL DEFAULT 'none',
         is_bulk INTEGER NOT NULL DEFAULT 0,
         aligned INTEGER NOT NULL DEFAULT 0,
         triage_category TEXT NOT NULL DEFAULT 'unknown',
         triage_importance REAL NOT NULL DEFAULT 0,
         triage_reasons_json TEXT NOT NULL DEFAULT '[]',
         triage_bucket TEXT NOT NULL DEFAULT 'new_mail',
         is_reply_to_me INTEGER NOT NULL DEFAULT 0,
         summary TEXT NOT NULL DEFAULT '',
         suggested_action TEXT NOT NULL DEFAULT 'review',
         list_unsubscribe TEXT,
         handled INTEGER NOT NULL DEFAULT 0,
         ts TEXT NOT NULL,
         UNIQUE(account_id, uid)
       )`,
    );
    // Additive columns for an already-created table (Post Office v2 digest).
    const cols = (this.db.prepare(`PRAGMA table_info(mail_messages)`).all() as { name: string }[]).map((c) => c.name);
    const ensure = (name: string, decl: string) => {
      if (!cols.includes(name)) this.db.exec(`ALTER TABLE mail_messages ADD COLUMN ${name} ${decl}`);
    };
    ensure('summary', "TEXT NOT NULL DEFAULT ''");
    ensure('suggested_action', "TEXT NOT NULL DEFAULT 'review'");
    ensure('list_unsubscribe', 'TEXT');
    ensure('handled', 'INTEGER NOT NULL DEFAULT 0');
    // 2026-06-20 — set once significant mail is shelved to the library/second
    // brain (the MailShelfDriver), so re-triage / re-ingest never re-shelves.
    ensure('shelved_at', 'TEXT');
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mail_thread ON mail_messages(thread_key)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mail_msgid ON mail_messages(message_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mail_inreplyto ON mail_messages(in_reply_to)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mail_account_date ON mail_messages(account_id, date_utc)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mail_sent ON mail_messages(direction, user_id, date_utc)`);
    // LEARNED sender suppression (2026-06-21) — a "Not me" tap records the
    // sender so future mail from that address is filtered from the digest. The
    // alternative to a hardcoded block list: the household teaches it which
    // senders are misdirected (debt collectors for someone else, etc.). Additive
    // table; cordoned by account_id (which carries the owner cordon).
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS mail_suppressions (
         account_id TEXT NOT NULL,
         from_addr TEXT NOT NULL,
         reason TEXT NOT NULL DEFAULT 'not_me',
         created_at TEXT NOT NULL,
         PRIMARY KEY (account_id, from_addr)
       )`,
    );
  }

  /** Insert a new message, or update the triage verdict of an existing one
   *  (idempotent on account_id+uid). Returns whether the row was new. */
  upsert(m: MailMessageInput): { id: string; is_new: boolean } {
    const existing = this.db
      .prepare(`SELECT id FROM mail_messages WHERE account_id = @a AND uid = @u`)
      .get({ '@a': m.account_id, '@u': m.uid }) as { id: string } | undefined;
    const now = new Date().toISOString();
    if (existing) {
      this.db
        .prepare(
          `UPDATE mail_messages SET
             thread_key = @thread_key, is_reply_to_me = @is_reply_to_me,
             auth_spf = @auth_spf, auth_dkim = @auth_dkim, auth_dmarc = @auth_dmarc,
             is_bulk = @is_bulk, aligned = @aligned,
             triage_category = @triage_category, triage_importance = @triage_importance,
             triage_reasons_json = @triage_reasons_json, triage_bucket = @triage_bucket,
             summary = @summary, suggested_action = @suggested_action,
             list_unsubscribe = @list_unsubscribe
           WHERE id = @id`,
        )
        .run({
          '@id': existing.id,
          '@thread_key': m.thread_key,
          '@is_reply_to_me': m.is_reply_to_me ? 1 : 0,
          '@auth_spf': m.auth_spf,
          '@auth_dkim': m.auth_dkim,
          '@auth_dmarc': m.auth_dmarc,
          '@is_bulk': m.is_bulk ? 1 : 0,
          '@aligned': m.aligned ? 1 : 0,
          '@triage_category': m.triage_category,
          '@triage_importance': m.triage_importance,
          '@triage_reasons_json': JSON.stringify(m.triage_reasons),
          '@triage_bucket': m.triage_bucket,
          '@summary': m.summary,
          '@suggested_action': m.suggested_action,
          '@list_unsubscribe': m.list_unsubscribe,
        });
      return { id: existing.id, is_new: false };
    }
    const id = `mm_${ulid().toLowerCase().slice(-14)}`;
    this.db
      .prepare(
        `INSERT INTO mail_messages
           (id, direction, account_id, user_id, private_to, uid, message_id,
            in_reply_to, references_json, thread_key, from_addr, from_name,
            to_json, subject, date_utc, snippet, body_text,
            auth_spf, auth_dkim, auth_dmarc, is_bulk, aligned,
            triage_category, triage_importance, triage_reasons_json,
            triage_bucket, is_reply_to_me, summary, suggested_action,
            list_unsubscribe, ts)
         VALUES
           (@id, @direction, @account_id, @user_id, @private_to, @uid, @message_id,
            @in_reply_to, @references_json, @thread_key, @from_addr, @from_name,
            @to_json, @subject, @date_utc, @snippet, @body_text,
            @auth_spf, @auth_dkim, @auth_dmarc, @is_bulk, @aligned,
            @triage_category, @triage_importance, @triage_reasons_json,
            @triage_bucket, @is_reply_to_me, @summary, @suggested_action,
            @list_unsubscribe, @ts)`,
      )
      .run({
        '@id': id,
        '@direction': m.direction,
        '@account_id': m.account_id,
        '@user_id': m.user_id,
        '@private_to': m.private_to,
        '@uid': m.uid,
        '@message_id': m.message_id,
        '@in_reply_to': m.in_reply_to,
        '@references_json': JSON.stringify(m.references),
        '@thread_key': m.thread_key,
        '@from_addr': m.from_addr,
        '@from_name': m.from_name,
        '@to_json': JSON.stringify(m.to),
        '@subject': m.subject,
        '@date_utc': m.date_utc,
        '@snippet': m.snippet,
        '@body_text': m.body_text,
        '@auth_spf': m.auth_spf,
        '@auth_dkim': m.auth_dkim,
        '@auth_dmarc': m.auth_dmarc,
        '@is_bulk': m.is_bulk ? 1 : 0,
        '@aligned': m.aligned ? 1 : 0,
        '@triage_category': m.triage_category,
        '@triage_importance': m.triage_importance,
        '@triage_reasons_json': JSON.stringify(m.triage_reasons),
        '@triage_bucket': m.triage_bucket,
        '@is_reply_to_me': m.is_reply_to_me ? 1 : 0,
        '@summary': m.summary,
        '@suggested_action': m.suggested_action,
        '@list_unsubscribe': m.list_unsubscribe,
        '@ts': now,
      });
    return { id, is_new: true };
  }

  /** Dismiss (or un-dismiss) a message from the digest. */
  set_handled(id: string, handled = true): void {
    this.db
      .prepare(`UPDATE mail_messages SET handled = @h WHERE id = @id`)
      .run({ '@h': handled ? 1 : 0, '@id': id });
  }

  /** Record a sender as suppressed for an account ("Not me" / not-for-me). */
  suppress(account_id: string, from_addr: string, reason = 'not_me'): void {
    const addr = (from_addr || '').trim().toLowerCase();
    if (!addr) return;
    this.db
      .prepare(
        `INSERT INTO mail_suppressions (account_id, from_addr, reason, created_at)
         VALUES (@a, @f, @r, @now)
         ON CONFLICT(account_id, from_addr) DO UPDATE SET reason = @r, created_at = @now`,
      )
      .run({ '@a': account_id, '@f': addr, '@r': reason, '@now': new Date().toISOString() });
  }

  /** Lowercased suppressed from-addresses for the given accounts (digest filter). */
  suppressed_addrs(account_ids: string[]): Set<string> {
    if (account_ids.length === 0) return new Set();
    const ph = account_ids.map((_, i) => `@a${i}`);
    const bind: Record<string, string> = {};
    account_ids.forEach((a, i) => (bind[`@a${i}`] = a));
    const rows = this.db
      .prepare(`SELECT from_addr FROM mail_suppressions WHERE account_id IN (${ph.join(',')})`)
      .all(bind) as Array<{ from_addr: string }>;
    return new Set(rows.map((r) => r.from_addr.toLowerCase()));
  }

  /** Recent INBOUND messages (no bucket filter), newest first, excluding
   *  handled by default. The route partitions these into the digest (what
   *  needs you) vs the filtered count. */
  recent_inbound(opts: { account_ids?: string[]; since?: string; limit?: number; include_handled?: boolean } = {}): MailMessage[] {
    const where: string[] = [`direction = 'inbound'`];
    const bind: Record<string, string | number> = {};
    if (!opts.include_handled) where.push(`handled = 0`);
    if (opts.since) { where.push(`date_utc >= @since`); bind['@since'] = opts.since; }
    if (opts.account_ids && opts.account_ids.length > 0) {
      const ph = opts.account_ids.map((_, i) => `@acc${i}`);
      where.push(`account_id IN (${ph.join(',')})`);
      opts.account_ids.forEach((a, i) => (bind[`@acc${i}`] = a));
    }
    bind['@limit'] = opts.limit ?? 300;
    const rows = this.db
      .prepare(`SELECT * FROM mail_messages WHERE ${where.join(' AND ')} ORDER BY date_utc DESC LIMIT @limit`)
      .all(bind) as Row[];
    return rows.map(hydrate);
  }

  /** Has this account+uid already been ingested? (cheap pre-fetch skip) */
  has(account_id: string, uid: number): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM mail_messages WHERE account_id = @a AND uid = @u`)
      .get({ '@a': account_id, '@u': uid });
  }

  /** Highest UID already ingested for an account (resume point for a fetch). */
  max_uid(account_id: string): number {
    const r = this.db
      .prepare(`SELECT MAX(uid) AS m FROM mail_messages WHERE account_id = @a`)
      .get({ '@a': account_id }) as { m: number | null } | undefined;
    return r?.m ?? 0;
  }

  /** Given a candidate ref set, return the subset that the user actually SENT
   *  — i.e. the message_ids present as direction='sent' rows. Non-empty ⇒
   *  the inbound message is a reply to the user. */
  sent_ids_matching(user_id: string, refs: string[]): string[] {
    const ids = refs.filter((r) => r && r.length > 0);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT DISTINCT message_id FROM mail_messages
           WHERE direction = 'sent' AND user_id = ? AND message_id IN (${placeholders})`,
      )
      .all(user_id, ...ids) as { message_id: string }[];
    return rows.map((r) => r.message_id);
  }

  /** Style-corpus source: recent SENT message bodies for a user, shaped for
   *  the per-user 'style' facet learner (`{ts, content_md}`). */
  recent_sent_bodies(
    user_id: string,
    since_iso: string,
    max: number,
  ): { ts: string; content_md: string }[] {
    const rows = this.db
      .prepare(
        `SELECT date_utc, body_text FROM mail_messages
           WHERE direction = 'sent' AND user_id = @u AND date_utc >= @since
             AND length(body_text) >= 30
           ORDER BY date_utc DESC LIMIT @max`,
      )
      .all({ '@u': user_id, '@since': since_iso, '@max': max }) as {
      date_utc: string;
      body_text: string;
    }[];
    return rows.map((r) => ({ ts: r.date_utc, content_md: r.body_text }));
  }

  /** Newest inbound message date per sender address since `since_iso` — the
   *  expected-bills probe reduces these to per-root-domain vendor recency. */
  latest_inbound_by_sender(since_iso: string): Array<{ from_addr: string; last_date: string }> {
    return this.db
      .prepare(
        `SELECT from_addr, MAX(date_utc) AS last_date FROM mail_messages
          WHERE direction = 'inbound' AND date_utc >= @since
          GROUP BY from_addr`,
      )
      .all({ '@since': since_iso }) as Array<{ from_addr: string; last_date: string }>;
  }

  list(opts: MailListOpts = {}): MailMessage[] {
    const where: string[] = [`direction = @direction`];
    const bind: Record<string, string | number> = { '@direction': opts.direction ?? 'inbound' };
    if (opts.since) {
      where.push(`date_utc >= @since`);
      bind['@since'] = opts.since;
    }
    if (opts.account_ids && opts.account_ids.length > 0) {
      const ph = opts.account_ids.map((_, i) => `@acc${i}`);
      where.push(`account_id IN (${ph.join(',')})`);
      opts.account_ids.forEach((a, i) => (bind[`@acc${i}`] = a));
    }
    if (opts.buckets && opts.buckets.length > 0) {
      const ph = opts.buckets.map((_, i) => `@b${i}`);
      where.push(`triage_bucket IN (${ph.join(',')})`);
      opts.buckets.forEach((b, i) => (bind[`@b${i}`] = b));
    }
    bind['@limit'] = opts.limit ?? 200;
    const rows = this.db
      .prepare(
        `SELECT * FROM mail_messages WHERE ${where.join(' AND ')}
           ORDER BY date_utc DESC LIMIT @limit`,
      )
      .all(bind) as Row[];
    return rows.map(hydrate);
  }

  /** All messages in a thread, oldest first (for mail_thread). */
  thread(thread_key: string): MailMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM mail_messages WHERE thread_key = @t ORDER BY date_utc ASC`)
      .all({ '@t': thread_key }) as Row[];
    return rows.map(hydrate);
  }

  get(id: string): MailMessage | undefined {
    const r = this.db.prepare(`SELECT * FROM mail_messages WHERE id = @id`).get({ '@id': id }) as
      | Row
      | undefined;
    return r ? hydrate(r) : undefined;
  }

  /** True if this message has already been shelved to the library. The
   *  MailShelfDriver's idempotency guard — re-triage / re-ingest won't
   *  re-shelve. (bun:sqlite .get() returns null for no row.) */
  is_shelved(id: string): boolean {
    const r = this.db
      .prepare(`SELECT shelved_at FROM mail_messages WHERE id = @id`)
      .get({ '@id': id }) as { shelved_at: string | null } | null;
    return r != null && r.shelved_at != null;
  }

  /** Stamp a message shelved (set once the library note is written). */
  mark_shelved(id: string, at: string): void {
    this.db.prepare(`UPDATE mail_messages SET shelved_at = @at WHERE id = @id`).run({ '@id': id, '@at': at });
  }

  /** Simple substring search over from/subject/body for the mail_search tool.
   *  Deep semantic search rides the library shelf (search_library); this is
   *  the quick structured lookup. */
  search(query: string, opts: { limit?: number } = {}): MailMessage[] {
    const q = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM mail_messages
           WHERE direction = 'inbound'
             AND (from_addr LIKE @q ESCAPE '\\' OR from_name LIKE @q ESCAPE '\\'
                  OR subject LIKE @q ESCAPE '\\' OR body_text LIKE @q ESCAPE '\\')
           ORDER BY date_utc DESC LIMIT @limit`,
      )
      .all({ '@q': q, '@limit': opts.limit ?? 40 }) as Row[];
    return rows.map(hydrate);
  }

  /** Per-bucket counts for the inbound stream (the pane header strip). */
  bucket_counts(account_ids?: string[]): Record<MailBucket, number> {
    const out: Record<MailBucket, number> = {
      needs_you: 0,
      replies: 0,
      new_mail: 0,
      fyi: 0,
      junk: 0,
    };
    const bind: Record<string, string | number> = {};
    let filter = '';
    if (account_ids && account_ids.length > 0) {
      const ph = account_ids.map((_, i) => `@acc${i}`);
      filter = ` AND account_id IN (${ph.join(',')})`;
      account_ids.forEach((a, i) => (bind[`@acc${i}`] = a));
    }
    const rows = this.db
      .prepare(
        `SELECT triage_bucket AS b, COUNT(*) AS n FROM mail_messages
           WHERE direction = 'inbound'${filter} GROUP BY triage_bucket`,
      )
      .all(bind) as { b: string; n: number }[];
    for (const r of rows) {
      if (r.b in out) out[r.b as MailBucket] = r.n;
    }
    return out;
  }
}
