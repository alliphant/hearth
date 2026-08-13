/**
 * agent_rooms — the turn-taking orchestrator for a multi-specialist room.
 *
 * A room is a shared conversation thread (RoomsStore) that several specialists
 * speak into. Per owner message:
 *   1. append the owner's message to the room thread,
 *   2. pick who speaks — the owner's @-address if given, else the ARBITER (a
 *      tiny 9B-class JSON pick) chooses 1-2 participants,
 *   3. run each picked speaker as an ephemeral `runtime.turn` with the WHOLE
 *      room thread passed as conversation_history (the review_swarm pattern —
 *      we persist ourselves, so we never depend on turn()'s own persistence),
 *   4. append each reply back to the room thread so LATER speakers in the same
 *      turn see it → that is the "riff": agents responding to each other.
 *
 * Design decisions (owner-set):
 *  - NO tool suppression. Participants run their normal surface; the existing
 *    effect-gates (court / step-up / owner-tap / protected floor) gate any
 *    irreversible action exactly as in a 1:1 chat. A room un-gates nothing.
 *  - Bounded: at most MAX_SPEAKERS_PER_TURN agent replies per owner message, so
 *    a room can never fan out into an unbounded agent-to-agent loop. The riff
 *    comes from multiple speakers seeing each other WITHIN the cap, then the
 *    turn yields back to the owner.
 */
import type { SpecialistRuntime } from './specialist_runtime';
import type { SpecialistRegistry } from './specialist';
import type { LLMRouter } from './llm';
import type { ConversationStore } from '@memory/stores/conversations';
import type { RoomsStore } from '@memory/stores/rooms';
import type { AppEventBus } from '@app/events';
import type { Tier } from './users';

/** Hard ceiling on agent replies produced by ONE owner message. */
const MAX_SPEAKERS_PER_TURN = 3;
/** How much room history each speaker sees (recent messages). */
const HISTORY_LIMIT = 40;

export interface RoomTurnDeps {
  runtime: SpecialistRuntime;
  specialists: SpecialistRegistry;
  llm: LLMRouter;
  conversations: ConversationStore;
  rooms: RoomsStore;
  /** Optional SSE bus — emit `room_message_added` as each reply persists so
   *  the web Rooms view streams the riff in live instead of polling. */
  events?: AppEventBus;
}

export interface RoomTurnResult {
  /** Ordered replies produced this turn. */
  replies: Array<{ specialist_id: string; name: string; content_md: string }>;
  /** Who the arbiter (or @-address) picked, for observability. */
  speakers: string[];
}

/** Parse the arbiter's fenced-or-bare JSON string array of specialist ids. */
function parse_speaker_ids(content: string, valid: Set<string>): string[] {
  if (!content) return [];
  // Tolerate a ```json fence or bare array.
  const m = content.match(/\[[\s\S]*?\]/);
  if (!m) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const raw of arr) {
    const id = typeof raw === 'string' ? raw : String((raw as { id?: unknown })?.id ?? '');
    if (valid.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Clean a room reply of speaker-label artifacts the small live model emits
 * despite the group-chat directive: a LEADING "<Name>:" label (its own or, in
 * the bleed case, a peer's — with or without markdown bold), and a TRAILING
 * dangling "<OtherName>," / "<OtherName>:" where it began handing off to the
 * next speaker. Only labels matching a KNOWN room participant are touched, so
 * genuine content like "Note: …" survives.
 */
function clean_room_reply(text: string, names: string[]): string {
  let out = text.replace(/^\s+/, '');
  for (const n of names) {
    if (!n) continue;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Matches "Name:", "**Name:**", "**Name**:", "Name :" — bold marks can sit
    // on either side of the colon, and there must be whitespace/bold before the
    // content so a genuine "Kate: …" line-of-content isn't mistaken mid-word.
    const lead = new RegExp(`^\\*{0,2}\\s*${esc}\\s*\\*{0,2}\\s*:\\s*\\*{0,2}\\s+`, 'i');
    if (lead.test(out)) {
      out = out.replace(lead, '');
      break;
    }
  }
  for (const n of names) {
    if (!n) continue;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tail = new RegExp(`\\n+\\*{0,2}${esc}\\*{0,2}\\s*[,:]?\\s*$`, 'i');
    if (tail.test(out)) {
      out = out.replace(tail, '');
      break;
    }
  }
  // Collapse a degenerate run of the same character down to three — the live
  // model sometimes gets stuck spamming one token (classically an emoji
  // variation-selector U+FE0F after a heart, repeated hundreds of times).
  out = out.replace(/(.)\1{6,}/gu, '$1$1$1');
  return out.trim();
}

/** Ask the arbiter which participant(s) should speak next. Fail-safe: on any
 *  error or empty pick, fall back to the first participant so the room never
 *  goes silent. */
async function pick_speakers(
  deps: RoomTurnDeps,
  participant_ids: string[],
  history: Array<{ role: string; who: string; content: string }>,
  last_owner_message: string,
): Promise<string[]> {
  const valid = new Set(participant_ids);
  const roster = participant_ids
    .map((id) => `- ${id} (${deps.specialists.get(id)?.name ?? id})`)
    .join('\n');
  const recent = history
    .slice(-8)
    .map((h) => `${h.who}: ${h.content.slice(0, 200)}`)
    .join('\n');
  const system =
    `You are the turn-taking moderator of a live group chat between the owner and several ` +
    `AI companions. Pick who should speak NEXT so the conversation feels alive — favor whoever ` +
    `the owner addressed or whose personality most wants to jump in, and let a SECOND one chime ` +
    `in when a back-and-forth between them would be fun or useful. Do NOT pick everyone by ` +
    `default. Reply with ONE json array of 1-2 participant ids only, most-eager first, no prose. ` +
    `Valid ids:\n${roster}`;
  const user = `Recent messages:\n${recent}\n\nThe owner just said:\n${last_owner_message}\n\nWho speaks next?`;
  try {
    const resolved = deps.llm.for_role('arbiter');
    const resp = await resolved.provider.complete({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
      max_tokens: 120,
      think: false,
    });
    const picked = parse_speaker_ids(resp.content ?? '', valid).slice(0, 2);
    return picked.length > 0 ? picked : [participant_ids[0]!];
  } catch (err) {
    console.error('[agent_rooms] arbiter failed, falling back to first participant:', err);
    return [participant_ids[0]!];
  }
}

/**
 * Run one owner message through the room. Appends the owner message and each
 * reply to the shared thread and returns the ordered replies.
 */
export async function run_room_turn(
  deps: RoomTurnDeps,
  args: {
    room_conversation_id: string;
    owner_message: string;
    user: { id: string; display_name: string; tier: Tier; timezone?: string };
    /** Optional @-addressed participant id — bypasses the arbiter. */
    addressed_specialist_id?: string;
  },
): Promise<RoomTurnResult> {
  const { room_conversation_id: cid } = args;
  const participants = deps.rooms.list_participants(cid);
  if (participants.length === 0) {
    return { replies: [], speakers: [] };
  }

  // The owner's message is appended by the CALLER (the route) BEFORE this runs,
  // so it is already the newest row in the thread and the 202 ack + the client's
  // first poll both see it immediately. This orchestrator only produces replies.
  const name_of = (id: string): string => deps.specialists.get(id)?.name ?? id;

  // 2. Pick speakers — @-address wins, else the arbiter.
  let speakers: string[];
  if (args.addressed_specialist_id && participants.includes(args.addressed_specialist_id)) {
    speakers = [args.addressed_specialist_id];
  } else {
    const hist_rows = deps.conversations.list_messages(cid, { limit: HISTORY_LIMIT }).slice().reverse();
    const hist = hist_rows.map((r) => ({
      role: r.role,
      who: r.role === 'user' ? 'Owner' : name_of(r.specialist_id ?? ''),
      content: r.content_md ?? '',
    }));
    speakers = await pick_speakers(deps, participants, hist, args.owner_message);
  }
  speakers = speakers.slice(0, MAX_SPEAKERS_PER_TURN);

  // 3+4. Each speaker runs against the CURRENT thread (including earlier
  // speakers' just-appended replies), then we append its reply so the next
  // speaker sees it — the riff.
  const replies: RoomTurnResult['replies'] = [];
  for (const sid of speakers) {
    if (!deps.specialists.get(sid)) continue; // demoted/unknown → skip, never crash
    const thread = deps.conversations.list_messages(cid, { limit: HISTORY_LIMIT }).slice().reverse();
    const self_name = name_of(sid);
    // Multi-agent turn = "write your character's next line in this script." A
    // group chat does NOT fit turn()'s 1:1 user/assistant history (the runtime
    // maps every specialist-role entry to an ASSISTANT message, so another
    // agent's reply reads as this model's own prior output -> bleed/echo).
    // Instead: EMPTY history + ONE user message that is the whole room rendered
    // as a labeled transcript + a "write <Name>'s next line" cue. The persona
    // stays the system prompt (that is what makes each voice distinct); the
    // transcript is pure context, so there is nothing to echo and no assistant
    // history to bleed from. Consecutive duplicate lines are collapsed so a
    // looped reply can't prime more looping.
    const lines: string[] = [];
    let prev_key = '';
    for (const r of thread) {
      const body = (r.content_md ?? '').trim();
      if (!body) continue;
      const who = r.role === 'user' ? args.user.display_name : name_of(r.specialist_id ?? '');
      const key = `${who}::${body}`;
      if (key === prev_key) continue; // collapse an exact consecutive duplicate
      prev_key = key;
      lines.push(`${who}: ${body}`);
    }
    const transcript = lines.join('\n');
    const others = participants.filter((p) => p !== sid).map(name_of);
    const roster =
      others.length === 0
        ? args.user.display_name
        : others.length === 1
          ? `${others[0]} and ${args.user.display_name}`
          : `${others.join(', ')}, and ${args.user.display_name}`;
    const room_framing =
      `You are ${self_name}, one voice in a live group chat with ${roster}. In the conversation ` +
      `you're shown, each line is labeled "Name:"; lines with a name OTHER than ${self_name} are ` +
      `other people speaking, never you. Stay fully in character as ${self_name} (your own voice, ` +
      `your own personality) and speak ONLY as ${self_name}: never write, quote, echo, or continue ` +
      `anyone else's line, and never start another person's turn.`;
    const prompt =
      `The group chat so far (most recent last):\n\n${transcript}\n\n` +
      `Write ${self_name}'s next message now — your own reply, in your voice, reacting to what was ` +
      `just said and adding something new. Reply with ONLY the message text (no "${self_name}:" ` +
      `prefix, no narration), and don't repeat anything already said above.`;

    // Live "who's talking" — <Name> is typing… until this speaker's reply lands.
    deps.events?.emit({
      type: 'room_speaker',
      room_id: cid,
      user_id: args.user.id,
      specialist_id: sid,
      name: self_name,
      state: 'typing',
    });
    let text = '';
    try {
      const out = await deps.runtime.turn({
        specialist_id: sid,
        // Ephemeral id per speaker-turn — we own the room thread's persistence;
        // turn() must not append into the shared room conversation itself.
        conversation_id: `room:${cid}:${sid}:${Date.now()}`,
        message: { role: 'user', content: prompt },
        conversation_history: [],
        extra_system: room_framing,
        user: args.user,
        // Route to the fast LIVE tier — the same knob the chat route sets. Without
        // it a room turn defaults to the DEEP path: an unbounded deliberation-grade
        // loop that spins to the tool-round ceiling (~300s) and emits the blank-turn
        // fallback instead of a quick conversational reply. A room reply is chat,
        // not a deliberation. (Verified: a raw deep turn took 298s + blank-folded.)
        tier: 'live',
        surface: 'web',
      });
      text = (out.message_text ?? '').trim();
      // Backstop the directive: drop a leading "<participant>:" label (own or a
      // bled peer, incl. markdown bold) and any trailing dangling handoff, so the
      // persisted line is the specialist's own clean message.
      text = clean_room_reply(text, participants.map(name_of));
    } catch (err) {
      // Surface the real cause — a swallowed turn error is invisible and looks
      // like "the agent just didn't reply".
      console.error(`[agent_rooms] participant turn failed for ${sid} in room ${cid}:`, err);
      text = '';
    }
    // Generation done — clear this speaker's "typing…" (the reply, if any,
    // lands via room_message_added right below).
    deps.events?.emit({
      type: 'room_speaker',
      room_id: cid,
      user_id: args.user.id,
      specialist_id: sid,
      name: self_name,
      state: 'done',
    });
    if (!text) {
      console.warn(`[agent_rooms] ${sid} produced no text in room ${cid} (skipped)`);
      continue;
    }

    const row = deps.conversations.append_message({
      conversation_id: cid,
      role: 'specialist',
      specialist_id: sid,
      content_md: text,
      surface: 'web',
    });
    replies.push({ specialist_id: sid, name: name_of(sid), content_md: text });

    // Push the reply the instant it persists — the web Rooms view appends it
    // to the open thread (sorted by ts) so agents' turns stream in live. The
    // shape mirrors GET /api/rooms/:id's message so the client reuses one path.
    deps.events?.emit({
      type: 'room_message_added',
      room_id: cid,
      user_id: args.user.id,
      message: {
        id: row.id,
        ts: row.ts,
        role: 'specialist',
        specialist_id: sid,
        name: name_of(sid),
        content_md: text,
      },
    });
  }

  return { replies, speakers };
}
