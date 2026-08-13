/**
 * Thin SQLite wrappers for the conversation/message/interrupt/inbox tables
 * created in structured.ts. The shape mirrors the table columns — keep this
 * layer intentionally dumb; richer query logic lives on top.
 */

import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';

export interface ConversationRow {
  id: string;
  specialist_id: string;
  ts_created: string;
  ts_last_message_at: string;
  title: string | null;
  user_id: string | null;
  active_surface: 'web' | 'telegram' | 'voice' | null;
  ts_last_telegram_message: string | null;
  ts_last_web_message: string | null;
  ts_last_voice_message: string | null;
}

export type MessageSurface = 'web' | 'telegram' | 'voice';
const STALE_THREAD_MS = 24 * 60 * 60 * 1000;

export interface MessageRow {
  id: string;
  conversation_id: string;
  ts: string;
  role: 'user' | 'specialist' | 'system';
  specialist_id: string | null;
  content_md: string;
  tool_calls_json: string | null;
  proposals_created_json: string | null;
  reasoning_trace_md: string | null;
  surface: MessageSurface | null;
}

export interface InterruptRow {
  id: string;
  ts: string;
  originating_specialist_id: string;
  severity: 'low' | 'medium' | 'medium-high' | 'high';
  summary: string;
  details_md: string | null;
  routed_to: string;
  status: 'pending' | 'acknowledged' | 'superseded' | 'dismissed';
  /** Per-user cordon: the user whose session/capture produced this, or
   *  NULL = household/system-shared. */
  originating_user_id: string | null;
}

export interface SpecialistInboxRow {
  id: string;
  ts: string;
  from_specialist_id: string;
  to_specialist_id: string;
  kind: 'flag' | 'question' | 'fyi' | 'consult_response';
  body_md: string;
  related_proposal_id: string | null;
  related_interrupt_id: string | null;
  read_at: string | null;
  actioned_at: string | null;
  /** Per-user cordon: the user whose session/capture produced this flag,
   *  or NULL = household/system-shared (visible in every user's brief). */
  originating_user_id: string | null;
}

export class ConversationStore {
  constructor(private db: Database) {}

  create(specialist_id: string, title?: string, user_id?: string): ConversationRow {
    const id = ulid();
    const ts = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO conversations
         (id, specialist_id, ts_created, ts_last_message_at, title, user_id)
         VALUES (@id, @sid, @ts, @ts, @title, @uid)`,
      )
      .run({
        '@id': id,
        '@sid': specialist_id,
        '@ts': ts,
        '@title': title ?? null,
        '@uid': user_id ?? null,
      });
    return {
      id,
      specialist_id,
      ts_created: ts,
      ts_last_message_at: ts,
      title: title ?? null,
      user_id: user_id ?? null,
      active_surface: null,
      ts_last_telegram_message: null,
      ts_last_web_message: null,
      ts_last_voice_message: null,
    };
  }

  /**
   * Find or create the active conversation for a (user, specialist) pair,
   * routing through cross-surface heuristics:
   *   - if the most recent conversation is younger than `max_age_ms` AND
   *     specialist matches → reuse
   *   - otherwise → create a new conversation
   *
   * `max_age_ms` defaults to the 24h cross-surface window. The voice path
   * passes a much tighter live-session window so a WebRTC reconnect mid-call
   * rejoins the same thread (keeping context, suppressing a spurious
   * re-greeting) without merging a brand-new call into a day-old thread.
   *
   * Returns the conversation row and a boolean indicating whether a new
   * conversation was created (so the caller can emit conversation_created).
   */
  resolve_for_user(
    user_id: string,
    specialist_id: string,
    max_age_ms: number = STALE_THREAD_MS,
    surface?: MessageSurface,
  ): { conversation: ConversationRow; created: boolean } {
    // Surface-scoped reuse (2026-06-06): when a surface is given, only rejoin a
    // conversation whose ACTIVE surface matches — voice gets a DEDICATED voice
    // thread and never resumes (and parrots the markdown of) a recent typed
    // conversation. A conv flips active_surface on every message (see touch),
    // so a single typed turn removes it from voice's reuse pool. Omitted →
    // legacy cross-surface behavior.
    // A multi-specialist ROOM is a conversation row whose specialist_id is a
    // placeholder ('kate'); it must NEVER be resolved as that specialist's 1:1
    // thread, or the room's messages bleed into the individual chat. Exclude any
    // conversation that has room_participants.
    const recent = (
      surface
        ? this.db
            .prepare(
              `SELECT * FROM conversations
               WHERE user_id = @uid AND specialist_id = @sid AND active_surface = @surf
                 AND id NOT IN (SELECT conversation_id FROM room_participants)
               ORDER BY ts_last_message_at DESC LIMIT 1`,
            )
            .get({ '@uid': user_id, '@sid': specialist_id, '@surf': surface })
        : this.db
            .prepare(
              `SELECT * FROM conversations
               WHERE user_id = @uid AND specialist_id = @sid
                 AND id NOT IN (SELECT conversation_id FROM room_participants)
               ORDER BY ts_last_message_at DESC LIMIT 1`,
            )
            .get({ '@uid': user_id, '@sid': specialist_id })
    ) as ConversationRow | undefined;

    if (recent) {
      const last_ms = new Date(recent.ts_last_message_at).getTime();
      if (Date.now() - last_ms < max_age_ms) {
        return { conversation: recent, created: false };
      }
    }
    return { conversation: this.create(specialist_id, undefined, user_id), created: true };
  }

  get(id: string): ConversationRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM conversations WHERE id = @id`)
        .get({ '@id': id }) as ConversationRow | undefined) ?? null
    );
  }

  list(filter: {
    specialist_id?: string;
    user_id?: string;
    limit?: number;
    /** Hide threads with zero messages — abandoned "new chat" rows that
     *  otherwise clutter the thread list (2026-06-15). */
    exclude_empty?: boolean;
    /** Allowlist of currently-registered specialist ids. When set, threads
     *  whose specialist is no longer on the roster (a FIRED specialist like
     *  Hazel) are excluded from the list — their history stays in the db,
     *  it just doesn't clutter the list. Applied IN SQL so `limit` counts
     *  only live threads. */
    known_specialist_ids?: string[];
  } = {}): ConversationRow[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    // Multi-specialist rooms are their OWN surface (GET /api/rooms) — never list
    // them among a specialist's 1:1 threads (they'd otherwise show as e.g. Kate
    // conversations, since a room's placeholder specialist_id is 'kate').
    clauses.push('id NOT IN (SELECT conversation_id FROM room_participants)');
    if (filter.specialist_id) {
      clauses.push('specialist_id = @sid');
      params['@sid'] = filter.specialist_id;
    }
    if (filter.user_id) {
      // Phase 2a multi-user: scope conv listings to the calling user.
      // Legacy rows pre-multi-user have user_id NULL (single-user
      // assumption was "you are jasper"); fold those into jasper's list
      // so existing history stays visible after the migration.
      if (filter.user_id === 'jasper') {
        clauses.push('(user_id = @uid OR user_id IS NULL)');
      } else {
        clauses.push('user_id = @uid');
      }
      params['@uid'] = filter.user_id;
    }
    if (filter.exclude_empty) {
      clauses.push(
        'EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id)',
      );
    }
    if (filter.known_specialist_ids && filter.known_specialist_ids.length > 0) {
      const ph = filter.known_specialist_ids.map((_, i) => `@k${i}`);
      clauses.push(`specialist_id IN (${ph.join(', ')})`);
      filter.known_specialist_ids.forEach((id, i) => {
        params[`@k${i}`] = id;
      });
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filter.limit ?? 50;
    return this.db
      .prepare(
        `SELECT * FROM conversations ${where}
         ORDER BY ts_last_message_at DESC LIMIT @lim`,
      )
      .all({ ...params, '@lim': limit }) as ConversationRow[];
  }

  set_specialist(id: string, specialist_id: string): boolean {
    const res = this.db
      .prepare(`UPDATE conversations SET specialist_id = @sid WHERE id = @id`)
      .run({ '@id': id, '@sid': specialist_id });
    return res.changes > 0;
  }

  set_title(id: string, title: string): void {
    this.db
      .prepare(`UPDATE conversations SET title = @t WHERE id = @id`)
      .run({ '@id': id, '@t': title });
  }

  touch(id: string, surface?: MessageSurface): void {
    const ts = new Date().toISOString();
    if (!surface) {
      this.db
        .prepare(`UPDATE conversations SET ts_last_message_at = @ts WHERE id = @id`)
        .run({ '@id': id, '@ts': ts });
      return;
    }
    const col =
      surface === 'telegram'
        ? 'ts_last_telegram_message'
        : surface === 'voice'
          ? 'ts_last_voice_message'
          : 'ts_last_web_message';
    this.db
      .prepare(
        `UPDATE conversations
         SET ts_last_message_at = @ts,
             active_surface = @surf,
             ${col} = @ts
         WHERE id = @id`,
      )
      .run({ '@id': id, '@ts': ts, '@surf': surface });
  }

  set_user(id: string, user_id: string): void {
    this.db
      .prepare(`UPDATE conversations SET user_id = @uid WHERE id = @id`)
      .run({ '@id': id, '@uid': user_id });
  }

  append_message(m: {
    conversation_id: string;
    role: 'user' | 'specialist' | 'system';
    specialist_id?: string;
    content_md: string;
    tool_calls?: unknown[];
    proposals_created?: string[];
    reasoning_trace?: string;
    surface?: MessageSurface;
  }): MessageRow {
    const id = ulid();
    const ts = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO messages
         (id, conversation_id, ts, role, specialist_id,
          content_md, tool_calls_json, proposals_created_json, reasoning_trace_md, surface)
         VALUES (@id, @cid, @ts, @r, @sid, @c, @tc, @pc, @rt, @surf)`,
      )
      .run({
        '@id': id,
        '@cid': m.conversation_id,
        '@ts': ts,
        '@r': m.role,
        '@sid': m.specialist_id ?? null,
        '@c': m.content_md,
        '@tc': m.tool_calls ? JSON.stringify(m.tool_calls) : null,
        '@pc': m.proposals_created ? JSON.stringify(m.proposals_created) : null,
        '@rt': m.reasoning_trace ?? null,
        '@surf': m.surface ?? null,
      });

    // Update conversation last-message timestamp and index FTS.
    this.touch(m.conversation_id, m.surface);
    this.db
      .prepare(
        `INSERT INTO messages_fts (rowid, content_md, conversation_id, message_id)
         VALUES ((SELECT rowid FROM messages WHERE id = @id), @c, @cid, @id)`,
      )
      .run({
        '@id': id,
        '@c': m.content_md,
        '@cid': m.conversation_id,
      });

    return {
      id,
      conversation_id: m.conversation_id,
      ts,
      role: m.role,
      specialist_id: m.specialist_id ?? null,
      content_md: m.content_md,
      tool_calls_json: m.tool_calls ? JSON.stringify(m.tool_calls) : null,
      proposals_created_json: m.proposals_created
        ? JSON.stringify(m.proposals_created)
        : null,
      reasoning_trace_md: m.reasoning_trace ?? null,
      surface: m.surface ?? null,
    };
  }

  list_messages(conversation_id: string, opts: { limit?: number; before?: string } = {}): MessageRow[] {
    const limit = opts.limit ?? 50;
    if (opts.before) {
      return this.db
        .prepare(
          `SELECT * FROM messages
           WHERE conversation_id = @cid AND ts < @before
           ORDER BY ts DESC LIMIT @lim`,
        )
        .all({ '@cid': conversation_id, '@before': opts.before, '@lim': limit })
        .reverse() as MessageRow[];
    }
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE conversation_id = @cid
         ORDER BY ts DESC LIMIT @lim`,
      )
      .all({ '@cid': conversation_id, '@lim': limit })
      .reverse() as MessageRow[];
  }

  /**
   * Return user-role messages across all conversations with ts >= since_iso,
   * oldest first. Used by Kate's passive voice-observer to scan recent Jasper
   * turns for style signal without needing to enumerate conversations.
   */
  list_user_messages_since(
    since_iso: string,
    opts: { limit?: number; min_chars?: number; user_id?: string } = {},
  ): MessageRow[] {
    const limit = opts.limit ?? 200;
    const min_chars = opts.min_chars ?? 0;
    // Per-user variant (2026-06-19): when user_id is given, scope to messages in
    // that user's conversations via the conversation join. Mirrors the legacy
    // jasper->NULL handling (pre-multi-user rows carry user_id NULL). Omitting
    // user_id keeps the original all-users behavior byte-identical.
    if (opts.user_id !== undefined) {
      const owner_legacy = opts.user_id === 'jasper' ? ' OR c.user_id IS NULL' : '';
      return this.db
        .prepare(
          `SELECT m.* FROM messages m JOIN conversations c ON m.conversation_id = c.id
           WHERE m.role = 'user' AND m.ts >= @since AND length(m.content_md) >= @minc
             AND (c.user_id = @uid${owner_legacy})
           ORDER BY m.ts ASC LIMIT @lim`,
        )
        .all({ '@since': since_iso, '@minc': min_chars, '@lim': limit, '@uid': opts.user_id }) as MessageRow[];
    }
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE role = 'user' AND ts >= @since AND length(content_md) >= @minc
         ORDER BY ts ASC LIMIT @lim`,
      )
      .all({ '@since': since_iso, '@minc': min_chars, '@lim': limit }) as MessageRow[];
  }

  search_messages(query: string, limit = 20): MessageRow[] {
    // FTS5 quoting: wrap in double-quotes to neutralize syntax chars.
    const escaped = query.replace(/"/g, '""');
    const hits = this.db
      .prepare(
        `SELECT message_id FROM messages_fts WHERE messages_fts MATCH @q
         ORDER BY rank LIMIT @lim`,
      )
      .all({ '@q': `"${escaped}"`, '@lim': limit }) as Array<{ message_id: string }>;
    if (hits.length === 0) return [];
    const ids = hits.map((h) => h.message_id);
    // bun:sqlite doesn't expand arrays — fetch one-by-one for simplicity.
    // Exclude messages that belong to a multi-specialist ROOM — those are a
    // separate surface and must not surface in 1:1 chat search.
    const rows: MessageRow[] = [];
    const stmt = this.db.prepare(
      `SELECT * FROM messages WHERE id = @id
         AND conversation_id NOT IN (SELECT conversation_id FROM room_participants)`,
    );
    for (const id of ids) {
      const r = stmt.get({ '@id': id }) as MessageRow | undefined;
      if (r) rows.push(r);
    }
    return rows;
  }
}

export class InterruptStore {
  constructor(private db: Database) {}

  create(i: {
    originating_specialist_id: string;
    severity: 'low' | 'medium' | 'medium-high' | 'high';
    summary: string;
    details_md?: string;
    routed_to: string;
    /** Per-user cordon: the user whose session/capture raised this, or
     *  null/undefined = household/system-shared. */
    originating_user_id?: string | null;
  }): InterruptRow {
    const id = ulid();
    const ts = new Date().toISOString();
    const originating_user_id = i.originating_user_id ?? null;
    this.db
      .prepare(
        `INSERT INTO interrupts
         (id, ts, originating_specialist_id, severity, summary, details_md, routed_to, status, originating_user_id)
         VALUES (@id, @ts, @osid, @sev, @sum, @det, @rt, 'pending', @ouid)`,
      )
      .run({
        '@id': id,
        '@ts': ts,
        '@osid': i.originating_specialist_id,
        '@sev': i.severity,
        '@sum': i.summary,
        '@det': i.details_md ?? null,
        '@rt': i.routed_to,
        '@ouid': originating_user_id,
      });
    return {
      id,
      ts,
      originating_specialist_id: i.originating_specialist_id,
      severity: i.severity,
      summary: i.summary,
      details_md: i.details_md ?? null,
      routed_to: i.routed_to,
      status: 'pending',
      originating_user_id,
    };
  }

  list(filter: { status?: 'pending' | 'acknowledged' | 'superseded' | 'dismissed' } = {}): InterruptRow[] {
    if (filter.status) {
      return this.db
        .prepare(`SELECT * FROM interrupts WHERE status = @s ORDER BY ts DESC`)
        .all({ '@s': filter.status }) as InterruptRow[];
    }
    return this.db
      .prepare(`SELECT * FROM interrupts ORDER BY ts DESC LIMIT 100`)
      .all() as InterruptRow[];
  }

  acknowledge(id: string): boolean {
    // absorb_interrupt is a catch-all acknowledgment, so accept an interrupt in
    // ANY non-acknowledged status (pending / escalated / routed / dismissed) —
    // restricting to status='pending' silently returned 0 changes for the other
    // states, surfacing as {acknowledged:false} with no error and driving Kate's
    // 100+ cycle retry loop (119 silent failures/24h). Already-acknowledged is
    // treated as SUCCESS (it IS acknowledged) so a re-call doesn't loop; only a
    // genuinely missing id returns false.
    const res = this.db
      .prepare(`UPDATE interrupts SET status = 'acknowledged' WHERE id = @id AND status != 'acknowledged'`)
      .run({ '@id': id });
    if (res.changes > 0) return true;
    const row = this.db
      .prepare(`SELECT status FROM interrupts WHERE id = @id`)
      .get({ '@id': id }) as { status: string } | undefined;
    return row?.status === 'acknowledged';
  }

  /**
   * Close out interrupts nobody ever actioned (2026-07-26). An interrupt is a
   * "look at this NOW" signal; one that has sat pending for weeks is not a
   * signal any more, it's a queue that makes the real ones harder to see. The
   * live case: 141 Cassandra interrupts raised 06-15 → 07-01 and never
   * resolved, ~30× everything else in the queue combined.
   *
   * Marks them `dismissed` — the honest status (nobody acted) as opposed to
   * `acknowledged` (which would claim someone did). Optionally scoped to one
   * originating specialist so a single noisy source can be drained without
   * touching everyone else's. Returns the ids it closed, for the audit row.
   */
  expire_stale(opts: { older_than_days: number; originating_specialist_id?: string }): string[] {
    const cutoff = new Date(Date.now() - opts.older_than_days * 86_400_000).toISOString();
    const where = opts.originating_specialist_id
      ? `status = 'pending' AND ts < @cutoff AND originating_specialist_id = @orig`
      : `status = 'pending' AND ts < @cutoff`;
    const binds: Record<string, string> = { '@cutoff': cutoff };
    if (opts.originating_specialist_id) binds['@orig'] = opts.originating_specialist_id;
    const ids = (
      this.db.prepare(`SELECT id FROM interrupts WHERE ${where}`).all(binds) as Array<{ id: string }>
    ).map((r) => r.id);
    if (ids.length === 0) return [];
    this.db.prepare(`UPDATE interrupts SET status = 'dismissed' WHERE ${where}`).run(binds);
    return ids;
  }
}

export class SpecialistInbox {
  constructor(private db: Database) {}

  push(m: {
    from_specialist_id: string;
    to_specialist_id: string;
    kind: 'flag' | 'question' | 'fyi' | 'consult_response';
    body_md: string;
    related_proposal_id?: string;
    related_interrupt_id?: string;
    /** Per-user cordon: the user whose session/capture produced this flag,
     *  or null/undefined = household/system-shared. Pass `ctx.user?.id` /
     *  the capture's `user_id` wherever a flag carries that user's personal
     *  content, so it can't surface in a different user's brief. */
    originating_user_id?: string | null;
  }): string {
    // Duplicate-storm backstop (2026-08-05): an EXACT (from, to, kind,
    // body) repeat inside a short window collapses onto the existing row —
    // return its id, insert nothing. The 2026-08-04 trainer→Ruby consult
    // spiral filed 256 near-identical rows in a day (an eight-minute
    // burst of ~250); the consult path now guards its own loop
    // (consult_guard.ts), and this is the content-agnostic floor under
    // every OTHER push site — redo/escalate flags, loops, delegation —
    // so no generating loop, present or future, can flood a recipient
    // with verbatim copies. A repeat with ANY textual difference still
    // inserts; a deliberate re-send lands once the window lapses.
    // HEARTH_INBOX_DUP_WINDOW_MIN tunes the window; 0 disables.
    const dup_window_min = (() => {
      const raw = process.env.HEARTH_INBOX_DUP_WINDOW_MIN;
      if (raw === undefined || raw.trim() === '') return 10;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) && n >= 0 ? n : 10;
    })();
    if (dup_window_min > 0) {
      const cutoff = new Date(Date.now() - dup_window_min * 60_000).toISOString();
      const dup = this.db
        .prepare(
          `SELECT id FROM specialist_inboxes
           WHERE from_specialist_id = @fs AND to_specialist_id = @ts2
             AND kind = @k AND body_md = @b AND ts > @cutoff
           ORDER BY ts DESC LIMIT 1`,
        )
        .get({
          '@fs': m.from_specialist_id,
          '@ts2': m.to_specialist_id,
          '@k': m.kind,
          '@b': m.body_md,
          '@cutoff': cutoff,
        }) as { id: string } | undefined;
      if (dup) return dup.id;
    }
    const id = ulid();
    const ts = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO specialist_inboxes
         (id, ts, from_specialist_id, to_specialist_id, kind, body_md,
          related_proposal_id, related_interrupt_id, originating_user_id)
         VALUES (@id, @ts, @fs, @ts2, @k, @b, @rp, @ri, @ouid)`,
      )
      .run({
        '@id': id,
        '@ts': ts,
        '@fs': m.from_specialist_id,
        '@ts2': m.to_specialist_id,
        '@k': m.kind,
        '@b': m.body_md,
        '@rp': m.related_proposal_id ?? null,
        '@ri': m.related_interrupt_id ?? null,
        '@ouid': m.originating_user_id ?? null,
      });
    return id;
  }

  unread_for(specialist_id: string, limit = 20): SpecialistInboxRow[] {
    return this.db
      .prepare(
        `SELECT * FROM specialist_inboxes
         WHERE to_specialist_id = @sid AND read_at IS NULL
         ORDER BY ts DESC LIMIT @lim`,
      )
      .all({ '@sid': specialist_id, '@lim': limit }) as SpecialistInboxRow[];
  }

  /**
   * Messages still awaiting action (actioned_at IS NULL), regardless of
   * read state. The deliberation loop gathers on THIS, not unread_for:
   * a pass that reads a message but crashes before marking it actioned
   * would otherwise orphan it forever — read_at is set so unread_for
   * never re-surfaces it, and the UI exposes no human dismiss.
   */
  unactioned_for(
    specialist_id: string,
    limit = 20,
    /** Per-user cordon. When set, restricts to flags the given viewer may
     *  see: household/system-shared (originating_user_id IS NULL) PLUS that
     *  viewer's own (= viewer_user_id). Used by Kate's per-user brief and
     *  the chat-turn inbox floor so a household member's personal flag
     *  never lands in another user's brief. Omit (undefined) for a
     *  domain-coordination read that wants the unfiltered queue. */
    viewer_user_id?: string,
  ): SpecialistInboxRow[] {
    const cordon = viewer_user_id
      ? 'AND (originating_user_id IS NULL OR originating_user_id = @vuid)'
      : '';
    return this.db
      .prepare(
        `SELECT * FROM specialist_inboxes
         WHERE to_specialist_id = @sid AND actioned_at IS NULL ${cordon}
         ORDER BY ts DESC LIMIT @lim`,
      )
      .all({
        '@sid': specialist_id,
        '@lim': limit,
        ...(viewer_user_id ? { '@vuid': viewer_user_id } : {}),
      }) as SpecialistInboxRow[];
  }

  list_for(specialist_id: string, limit = 50): SpecialistInboxRow[] {
    return this.db
      .prepare(
        `SELECT * FROM specialist_inboxes
         WHERE to_specialist_id = @sid OR from_specialist_id = @sid
         ORDER BY ts DESC LIMIT @lim`,
      )
      .all({ '@sid': specialist_id, '@lim': limit }) as SpecialistInboxRow[];
  }

  get(id: string): SpecialistInboxRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM specialist_inboxes WHERE id = @id`)
        .get({ '@id': id }) as SpecialistInboxRow | undefined) ?? null
    );
  }

  list_all(filter: { unread_only?: boolean; from?: string; to?: string; limit?: number } = {}): SpecialistInboxRow[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.unread_only) clauses.push('read_at IS NULL');
    if (filter.from) {
      clauses.push('from_specialist_id = @from');
      params['@from'] = filter.from;
    }
    if (filter.to) {
      clauses.push('to_specialist_id = @to');
      params['@to'] = filter.to;
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filter.limit ?? 100;
    return this.db
      .prepare(
        `SELECT * FROM specialist_inboxes ${where}
         ORDER BY ts DESC LIMIT @lim`,
      )
      .all({ ...params, '@lim': limit }) as SpecialistInboxRow[];
  }

  mark_read(ids: string[]): void {
    if (ids.length === 0) return;
    const ts = new Date().toISOString();
    const stmt = this.db.prepare(
      `UPDATE specialist_inboxes SET read_at = @ts WHERE id = @id AND read_at IS NULL`,
    );
    for (const id of ids) stmt.run({ '@id': id, '@ts': ts });
  }

  mark_actioned(id: string): void {
    const ts = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE specialist_inboxes
         SET actioned_at = @ts,
             read_at = COALESCE(read_at, @ts)
         WHERE id = @id`,
      )
      .run({ '@id': id, '@ts': ts });
  }

  /**
   * Action every escalation/redo flag raised for a process miss — called when
   * the miss is closed so its inbox flag never outlives it. The close path
   * pushes no flag of its own, so before this a resolved miss left a permanent
   * ghost in the escalation target's inbox (145 such stale flags had accrued by
   * 2026-06-04, the bulk of the "insane inbox" volume). Returns rows actioned.
   *
   * Matched on the miss ULID embedded in the flag body. The tidier form is a
   * `related_miss_id` FK column (mirroring `related_proposal_id`), deferred only
   * because its migration sits in a concurrently-edited file; the body match is
   * reliable (ULIDs are unique and only escalation/redo flags carry one) and, as
   * a bonus, also retires legacy flags that predate any such column.
   */
  mark_actioned_for_miss(miss_id: string): number {
    const ts = new Date().toISOString();
    const res = this.db
      .prepare(
        `UPDATE specialist_inboxes
            SET actioned_at = COALESCE(actioned_at, @ts),
                read_at     = COALESCE(read_at, @ts)
          WHERE kind = 'flag'
            AND actioned_at IS NULL
            AND body_md LIKE '%' || @mid || '%'`,
      )
      .run({ '@ts': ts, '@mid': miss_id });
    return res.changes;
  }
}
