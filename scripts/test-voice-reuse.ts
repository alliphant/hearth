export {}; // module scope
/**
 * Self-contained test for the voice conversation-reuse fix.
 *
 * Proves ConversationStore.resolve_for_user honors the new `max_age_ms`
 * window so a WebRTC reconnect mid-call rejoins the same thread (keeping
 * context, suppressing the spurious "Hey Jasper, what's up" re-greeting),
 * while a genuinely new call falls outside the window and gets a fresh
 * conversation. Mirrors the temp-db pattern of test-ingestor.
 *
 *   bun run scripts/test-voice-reuse.ts
 */
import { open_db } from '../src/memory/stores/structured';
import { ConversationStore } from '../src/memory/stores/conversations';

const tmp = `/tmp/hearth-voice-reuse-${process.pid}.db`;
const db = open_db(tmp);
const store = new ConversationStore(db);

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures++;
}

const USER = 'jasper';
const SPEC = 'kate';
const WINDOW = 30 * 60 * 1000; // matches HEARTH_VOICE_REUSE_MS default

// 1. First connect → no prior thread → creates fresh.
const first = store.resolve_for_user(USER, SPEC, WINDOW);
check('first connect creates a conversation', first.created === true);

// Simulate an in-call message so ts_last_message_at is "now".
store.append_message({
  conversation_id: first.conversation.id,
  role: 'user',
  content_md: 'hey kate',
  surface: 'voice',
});

// 2. Reconnect seconds later → rejoins the SAME thread (no re-greeting).
const reconnect = store.resolve_for_user(USER, SPEC, WINDOW);
check('reconnect reuses the same conversation', reconnect.created === false);
check('reconnect returns the same conversation id', reconnect.conversation.id === first.conversation.id);

// 3. Make the thread stale (last message older than the window) → fresh call.
db.prepare(`UPDATE conversations SET ts_last_message_at = @ts WHERE id = @id`).run({
  '@ts': new Date(Date.now() - WINDOW - 60_000).toISOString(),
  '@id': first.conversation.id,
});
const newCall = store.resolve_for_user(USER, SPEC, WINDOW);
check('a call past the window starts a fresh conversation', newCall.created === true);
check('fresh call has a different conversation id', newCall.conversation.id !== first.conversation.id);

// 4. Default window (no third arg) is unchanged for chat callers — a
//    thread within 24h still reuses.
db.prepare(`UPDATE conversations SET ts_last_message_at = @ts WHERE id = @id`).run({
  '@ts': new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
  '@id': newCall.conversation.id,
});
const chatDefault = store.resolve_for_user(USER, SPEC);
check('default (chat) window still reuses a 1h-old thread', chatDefault.created === false);

db.close();
try { require('node:fs').unlinkSync(tmp); } catch {}

if (failures) {
  console.error(`\n✗ VOICE REUSE TEST FAILED (${failures})`);
  process.exit(1);
}
console.log('\n✓ VOICE REUSE TEST PASSED');
