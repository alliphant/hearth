export {};
/**
 * Smoke: a multi-specialist ROOM must stay SEPARATE from the individual agent's
 * 1:1 chat. A room is a `conversations` row whose specialist_id is a placeholder
 * ('kate'), so any query filtering by specialist_id would wrongly include it —
 * bleeding the room's messages into Kate's individual history. The store excludes
 * conversations that have room_participants from list() / resolve_for_user() /
 * search_messages(). This asserts that invariant against the REAL stores.
 *
 * Self-contained: temp SQLite via open_db (which creates room_participants).
 * Run via `bun run smoke:room-separation`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { ConversationStore } from '@memory/stores/conversations';
import { RoomsStore } from '@memory/stores/rooms';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function main(): void {
  const root = mkdtempSync(resolve(tmpdir(), 'hearth-roomsep-'));
  const db = open_db(resolve(root, 'hearth.db'));
  let pass = 0;
  try {
    const conversations = new ConversationStore(db);
    const rooms = new RoomsStore(db, conversations);

    // Kate's 1:1 chat.
    const solo = conversations.create('kate', 'Kate 1:1', 'jasper');
    conversations.append_message({ conversation_id: solo.id, role: 'user', content_md: 'hey kate, private thing', surface: 'web' });
    conversations.append_message({ conversation_id: solo.id, role: 'specialist', specialist_id: 'kate', content_md: 'noted, just between us', surface: 'web' });

    // A room with Kate + Mariah (created AFTER, so it's the most-recent 'kate' conv).
    const room = rooms.create_room('jasper', 'The Room', ['kate', 'mariah']);
    conversations.append_message({ conversation_id: room.id, role: 'user', content_md: 'roomonly banter secretword', surface: 'web' });
    conversations.append_message({ conversation_id: room.id, role: 'specialist', specialist_id: 'kate', content_md: 'kate in the room secretword', surface: 'web' });
    conversations.append_message({ conversation_id: room.id, role: 'specialist', specialist_id: 'mariah', content_md: 'mariah in the room secretword', surface: 'web' });

    // ── list(specialist_id: kate) must NOT include the room ──────────────────
    console.log('→ list(kate) excludes the room');
    const kate_list = conversations.list({ specialist_id: 'kate', user_id: 'jasper' });
    assert(kate_list.some((c) => c.id === solo.id), "Kate's 1:1 conversation must be listed");
    assert(!kate_list.some((c) => c.id === room.id), 'the room must NOT appear in Kate\'s 1:1 conversation list');
    pass++;

    // ── resolve_for_user(kate) must land on the 1:1, not the (newer) room ────
    console.log('→ resolve_for_user(kate) lands on the 1:1 thread, not the room');
    const resolved = conversations.resolve_for_user('jasper', 'kate');
    assert(resolved.conversation.id === solo.id, `resolve must pick the 1:1 (${solo.id}), got ${resolved.conversation.id}`);
    assert(resolved.created === false, 'the existing 1:1 should be reused, not a fresh conv');
    pass++;

    // ── generic list (no specialist filter) also excludes rooms ──────────────
    console.log('→ generic conversation list excludes rooms');
    const all = conversations.list({ user_id: 'jasper' });
    assert(!all.some((c) => c.id === room.id), 'a room must never appear in the generic conversation list');
    pass++;

    // ── chat search must NOT surface room messages ───────────────────────────
    console.log('→ chat search excludes room messages');
    const hits = conversations.search_messages('secretword', 20);
    assert(hits.length === 0 || hits.every((m) => m.conversation_id === solo.id), 'search must not return any room message');
    assert(!hits.some((m) => m.conversation_id === room.id), 'no room message may surface in 1:1 chat search');
    pass++;

    // ── the room IS still reachable through the rooms surface ────────────────
    console.log('→ the room is still listed on the rooms surface');
    const room_list = rooms.list_rooms('jasper');
    assert(room_list.some((r) => r.conversation_id === room.id), 'the room must still be reachable via list_rooms');
    assert(rooms.is_room(room.id) && !rooms.is_room(solo.id), 'is_room distinguishes room from 1:1');
    pass++;

    console.log(`\nAll ${pass} room-separation smoke checks passed.`);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

main();
