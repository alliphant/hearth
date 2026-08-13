/**
 * RoomsStore — the participant roster for multi-specialist "agent rooms".
 *
 * A room is just a `conversations` row (its THREAD) plus a set of participant
 * specialists recorded here. Messages, FTS, append/list all reuse
 * ConversationStore unchanged — every message already carries the speaker's
 * `specialist_id`, so a room thread is a normal conversation with more than one
 * specialist speaking into it. A conversation is a room iff it has rows here.
 *
 * Owner-scoped: rooms belong to a user (the conversation's user_id); the routes
 * cordon on that. This store is pure membership + lookup — the turn-taking lives
 * in src/core/agent_rooms.ts.
 */
import type { Database } from 'bun:sqlite';
import type { ConversationRow, ConversationStore } from './conversations';

export interface RoomSummary {
  conversation_id: string;
  title: string | null;
  user_id: string | null;
  ts_last_message_at: string;
  participant_ids: string[];
}

export class RoomsStore {
  constructor(
    private db: Database,
    private conversations: ConversationStore,
  ) {}

  /** Create a room thread owned by `user_id` with the given participants. */
  create_room(user_id: string, title: string | undefined, participant_ids: string[]): ConversationRow {
    // The conversation's own specialist_id is a placeholder — participants are
    // the source of truth. 'kate' keeps id→name resolution + hue sane for the
    // thread header without implying she's the only speaker.
    const conv = this.conversations.create('kate', title, user_id);
    const unique = [...new Set(participant_ids)];
    for (const sid of unique) this.add_participant(conv.id, sid);
    return conv;
  }

  add_participant(conversation_id: string, specialist_id: string): void {
    this.db
      .prepare(
        `INSERT INTO room_participants (conversation_id, specialist_id, added_at)
         VALUES (@cid, @sid, @ts)
         ON CONFLICT(conversation_id, specialist_id) DO NOTHING`,
      )
      .run({ '@cid': conversation_id, '@sid': specialist_id, '@ts': new Date().toISOString() });
  }

  remove_participant(conversation_id: string, specialist_id: string): void {
    this.db
      .prepare(`DELETE FROM room_participants WHERE conversation_id = @cid AND specialist_id = @sid`)
      .run({ '@cid': conversation_id, '@sid': specialist_id });
  }

  list_participants(conversation_id: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT specialist_id FROM room_participants WHERE conversation_id = @cid ORDER BY added_at ASC`,
        )
        .all({ '@cid': conversation_id }) as Array<{ specialist_id: string }>
    ).map((r) => r.specialist_id);
  }

  is_room(conversation_id: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM room_participants WHERE conversation_id = @cid LIMIT 1`)
        .get({ '@cid': conversation_id }) != null
    );
  }

  /** All rooms owned by a user, newest activity first. */
  list_rooms(user_id: string): RoomSummary[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT c.id, c.title, c.user_id, c.ts_last_message_at
           FROM conversations c
           JOIN room_participants rp ON rp.conversation_id = c.id
          WHERE (c.user_id = @uid OR (@uid = 'jasper' AND c.user_id IS NULL))
          ORDER BY c.ts_last_message_at DESC`,
      )
      .all({ '@uid': user_id }) as Array<{
      id: string;
      title: string | null;
      user_id: string | null;
      ts_last_message_at: string;
    }>;
    return rows.map((r) => ({
      conversation_id: r.id,
      title: r.title,
      user_id: r.user_id,
      ts_last_message_at: r.ts_last_message_at,
      participant_ids: this.list_participants(r.id),
    }));
  }
}
