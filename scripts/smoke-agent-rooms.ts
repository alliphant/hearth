export {};
/**
 * Smoke for src/core/agent_rooms.run_room_turn — the multi-specialist room
 * turn-taking orchestrator, focused on the design that keeps each speaker in
 * its OWN persona (the 2026-07-27 "Kate talks as Mariah" bleed / echo / loop).
 *
 * The design under test: a group chat does NOT reuse turn()'s 1:1
 * user/assistant history (which maps a specialist-role entry to an assistant
 * message → other agents' lines read as the model's own → bleed). Instead each
 * speaker gets EMPTY conversation_history and ONE user message that is the whole
 * room rendered as a labeled transcript + a "write <Name>'s next line" cue; the
 * persona is the system prompt; a room-framing tail rides extra_system.
 *
 * Fully self-contained: fake conversations store (in-memory), fake rooms, fake
 * specialists, a fake arbiter llm, and a CAPTURING fake runtime whose turn()
 * records its input. Asserts:
 *   1. Both picked speakers run as themselves; replies persist + emit an event.
 *   2. conversation_history is EMPTY (no 1:1 hack to bleed from).
 *   3. The message is the room as a labeled transcript (owner + every agent,
 *      each "Name: …"), consecutive duplicates collapsed, ending with a
 *      "write <Name>'s next message" cue for THIS speaker.
 *   4. extra_system frames the speaker as one voice in the group, scoped to
 *      speak only as itself.
 *   5. A reply that still carries a "<Name>:" label (own/bled, incl. bold) or a
 *      trailing handoff is cleaned before persist.
 *   6. tier:'live' + surface:'web' (fast conversational path).
 *
 * Run via `bun run smoke:agent-rooms`.
 */

import { run_room_turn, type RoomTurnDeps } from '@core/agent_rooms';
import type { AppEvent } from '@app/events';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

interface Row {
  id: string;
  ts: string;
  role: 'user' | 'specialist' | 'system';
  specialist_id: string | null;
  content_md: string;
}

async function main(): Promise<void> {
  let pass = 0;
  const PARTICIPANTS = ['kate', 'mariah'];

  // Fake conversations store (chronological; list_messages returns newest-first).
  const rows: Row[] = [];
  let seq = 0;
  const conversations = {
    append_message(m: { conversation_id: string; role: Row['role']; specialist_id?: string; content_md: string }): Row {
      const row: Row = {
        id: `m${++seq}`,
        ts: new Date(2026, 6, 27, 12, 0, seq).toISOString(),
        role: m.role,
        specialist_id: m.specialist_id ?? null,
        content_md: m.content_md,
      };
      rows.push(row);
      return row;
    },
    list_messages(_cid: string, _opts?: { limit?: number }): Row[] {
      return [...rows].reverse();
    },
    get(cid: string) {
      return { id: cid, title: 'RP room', user_id: 'jasper' };
    },
  };

  const rooms = { list_participants: (_cid: string) => [...PARTICIPANTS] };
  const specialists = {
    get: (id: string) => (PARTICIPANTS.includes(id) ? { id, name: cap(id) } : undefined),
  };
  const llm = {
    for_role: (_role: string) => ({
      provider: { complete: async () => ({ content: '["kate","mariah"]' }) },
    }),
  };

  // Capturing runtime — returns replies with the label artifacts the live model
  // emits (bold leading label; leading label + trailing handoff), to prove cleanup.
  const captured: Array<Record<string, unknown>> = [];
  const runtime = {
    turn: async (input: Record<string, unknown>) => {
      captured.push(input);
      const sid = String(input.specialist_id);
      const raw = sid === 'kate'
        ? `**Kate:** hello from kate 🖤${'️'.repeat(30)}` // bold label + emoji token-spam
        : `Mariah: hello from mariah\n\nKate,`;
      return { message_text: raw };
    },
  };

  const events_seen: AppEvent[] = [];
  const events = { emit: (e: AppEvent) => events_seen.push(e) };

  const deps = { runtime, specialists, llm, conversations, rooms, events } as unknown as RoomTurnDeps;

  // Seed a prior exchange + a looped duplicate (mariah repeated herself).
  conversations.append_message({ conversation_id: 'room1', role: 'user', content_md: 'hi all' });
  conversations.append_message({ conversation_id: 'room1', role: 'specialist', specialist_id: 'kate', content_md: 'hey from kate' });
  conversations.append_message({ conversation_id: 'room1', role: 'specialist', specialist_id: 'mariah', content_md: 'yo from mariah' });
  conversations.append_message({ conversation_id: 'room1', role: 'specialist', specialist_id: 'mariah', content_md: 'yo from mariah' });
  conversations.append_message({ conversation_id: 'room1', role: 'user', content_md: 'round two, you two' });

  const result = await run_room_turn(deps, {
    room_conversation_id: 'room1',
    owner_message: 'round two, you two',
    user: { id: 'jasper', display_name: 'Jasper', tier: 'owner' },
  });

  // ── 1. Both spoke as themselves; replies persisted + emitted. ──────────────
  console.log('→ Both picked speakers ran as themselves');
  assert(result.speakers.join(',') === 'kate,mariah', `speakers should be kate,mariah, got ${result.speakers}`);
  assert(result.replies.length === 2, `expected 2 replies, got ${result.replies.length}`);
  assert(result.replies[0]!.specialist_id === 'kate' && result.replies[1]!.specialist_id === 'mariah', 'replies attributed to the right specialists');
  pass++;

  // ── 5. Label artifacts cleaned (bold leading + trailing handoff). ──────────
  console.log('→ Speaker-label artifacts + degenerate emoji-spam cleaned from replies');
  assert(result.replies[0]!.content_md.startsWith('hello from kate'), `kate reply should drop the **bold** label, got "${result.replies[0]!.content_md}"`);
  assert(!/(.)\1{4,}/u.test(result.replies[0]!.content_md), `degenerate character run must collapse, got "${result.replies[0]!.content_md}"`);
  assert(result.replies[1]!.content_md === 'hello from mariah', `mariah reply should drop the leading label + trailing handoff, got "${result.replies[1]!.content_md}"`);
  pass++;

  const kate_turn = captured.find((c) => c.specialist_id === 'kate')!;
  const mariah_turn = captured.find((c) => c.specialist_id === 'mariah')!;

  // ── 2. Empty history (no 1:1 assistant-history to bleed from). ─────────────
  console.log('→ conversation_history is EMPTY for every speaker');
  assert(Array.isArray(kate_turn.conversation_history) && (kate_turn.conversation_history as unknown[]).length === 0, "kate's history must be empty");
  assert(Array.isArray(mariah_turn.conversation_history) && (mariah_turn.conversation_history as unknown[]).length === 0, "mariah's history must be empty");
  pass++;

  // ── 3. The message = the room as a labeled transcript + a write-your-line cue.
  console.log('→ Message is the labeled transcript (owner + all agents), deduped, with a self cue');
  const kate_msg = String((kate_turn.message as { content: string }).content);
  assert(/(^|\n)Jasper: hi all/.test(kate_msg), 'transcript labels the owner ("Jasper:")');
  assert(/(^|\n)Kate: hey from kate/.test(kate_msg), "transcript includes the speaker's OWN prior line, labeled");
  assert(/(^|\n)Mariah: yo from mariah/.test(kate_msg), 'transcript includes the OTHER agent, labeled');
  assert(/write kate's next message/i.test(kate_msg), 'cue asks THIS speaker to write its own next line');
  // Dedup — the looped duplicate appears exactly once.
  assert((kate_msg.match(/Mariah: yo from mariah/g) || []).length === 1, 'consecutive duplicate lines collapse to one in the transcript');
  // Mariah's turn sees Kate's just-appended reply in her transcript, labeled.
  const mariah_msg = String((mariah_turn.message as { content: string }).content);
  assert(/(^|\n)Kate: hello from kate/.test(mariah_msg), "mariah's transcript includes kate's just-landed reply, labeled");
  assert(/write mariah's next message/i.test(mariah_msg), "mariah's cue is scoped to Mariah");
  pass++;

  // ── 4. Room framing (extra_system) scopes each speaker to itself. ──────────
  console.log('→ Room framing scopes each speaker to speak only as itself');
  const kate_fr = String(kate_turn.extra_system ?? '');
  assert(/you are kate\b/i.test(kate_fr) && /speak only as kate/i.test(kate_fr), "kate's framing scopes to Kate");
  assert(/group chat/i.test(kate_fr) && /mariah/i.test(kate_fr) && /jasper/i.test(kate_fr), 'framing names the group + the other participant + owner');
  assert(/you are mariah\b/i.test(String(mariah_turn.extra_system ?? '')), "mariah's framing scopes to Mariah");
  pass++;

  // ── 6. Fast conversational path + per-reply event. ─────────────────────────
  console.log('→ tier:live + surface:web, room_message_added per reply');
  assert(kate_turn.tier === 'live' && kate_turn.surface === 'web', 'kate turn must be tier:live surface:web');
  assert(mariah_turn.tier === 'live' && mariah_turn.surface === 'web', 'mariah turn must be tier:live surface:web');
  const added = events_seen.filter((e) => e.type === 'room_message_added');
  assert(added.length === 2, `expected 2 room_message_added events, got ${added.length}`);
  assert(added.every((e) => (e as { user_id: string }).user_id === 'jasper'), 'room events cordoned to the owner');
  pass++;

  console.log(`\nAll ${pass} agent-rooms smoke checks passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
