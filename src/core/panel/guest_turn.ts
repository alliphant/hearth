/**
 * Kate, answering whoever is holding the guest panel.
 *
 * ⚠ THE CALLER IS SYNTHESISED ON PURPOSE, AND ITS TIER IS THE WHOLE SAFETY
 * STORY. `require_caller_tier` resolves `ctx.user?.tier ?? 'owner'` — so an
 * unauthenticated surface that simply omits the user is treated as the OWNER
 * and every owner-gated tool opens up. The panel therefore passes an explicit
 * friend-tier caller, the lowest tier Hearth defines, and never `undefined`.
 *
 * Kate is the discretion layer by design (her spec: "she talks to all tiers and
 * uses her persona's judgment to decide what to share"), so the display name
 * says plainly that this is a visitor rather than a household member — she can
 * only exercise that judgment if she knows who she is talking to.
 *
 * Turns are NOT written to the conversation store. A guest asking where the
 * bathroom is should not land in the household's chat surface, and the store is
 * the household's record, not a visitor log. History lives in memory for the
 * length of a visit and then evaporates — same reasoning as the doorbell
 * camera: keep only what the moment needs.
 */
import type { SpecialistRuntime } from '@core/specialist_runtime';
import type { TurnUser } from '@core/users';
import { ROOM_ORDER } from './rooms';

/** How much of a conversation a guest session carries between turns. */
const HISTORY_TURNS = 6;
/** A visit that has gone quiet for this long starts fresh. */
const SESSION_TTL_MS = 30 * 60_000;
/** Hard cap so a busy party cannot grow this without bound. */
const MAX_SESSIONS = 64;
/**
 * Someone is standing in a hallway holding a phone. Past this they have
 * concluded it is broken, so say something rather than leave them waiting —
 * the turn itself cannot be cancelled, so it is simply abandoned and its answer
 * is not remembered.
 */
const ANSWER_DEADLINE_MS = 45_000;

export const GUEST_SPECIALIST = 'kate';

type Turn = { role: 'user' | 'specialist'; content: string; specialist_id?: string };
type Session = { turns: Turn[]; touched: number };

const sessions = new Map<string, Session>();

function reap(now: number): void {
  for (const [id, s] of sessions) if (now - s.touched > SESSION_TTL_MS) sessions.delete(id);
  while (sessions.size > MAX_SESSIONS) {
    // Oldest-touched first; Map preserves insertion order, and every touch
    // re-inserts, so the first key is the least recently used.
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

function history_for(session_id: string): Turn[] {
  const now = Date.now();
  reap(now);
  const s = sessions.get(session_id);
  if (!s) return [];
  return s.turns;
}

function remember(session_id: string, asked: string, replied: string): void {
  const now = Date.now();
  const s = sessions.get(session_id) ?? { turns: [], touched: now };
  s.turns.push({ role: 'user', content: asked });
  s.turns.push({ role: 'specialist', content: replied, specialist_id: GUEST_SPECIALIST });
  s.turns = s.turns.slice(-HISTORY_TURNS * 2);
  s.touched = now;
  sessions.delete(session_id); // re-insert so Map order tracks recency
  sessions.set(session_id, s);
  reap(now);
}

/** The visitor Kate is talking to. Never an owner, never `undefined`. */
export function guest_caller(timezone: string): TurnUser {
  return {
    id: 'guest-panel',
    display_name: 'a guest in the house',
    tier: 'friend',
    timezone,
  };
}

export type GuestAnswer = { ok: true; reply: string } | { ok: false; reason: string };

export async function ask_kate(opts: {
  runtime: SpecialistRuntime;
  session_id: string;
  room: string;
  question: string;
  timezone: string;
}): Promise<GuestAnswer> {
  const { runtime, session_id, room, question, timezone } = opts;

  // The room is context Kate cannot otherwise have — "turn the light off" means
  // a different switch in the Loft than in the Half Bath.
  //
  // The floor-plan paragraph is load-bearing. On the first live guest turns,
  // asked "where is the bathroom?", Kate answered "down the hall to your left,
  // past the kitchen, frosted glass door" and "past the landing — knock first":
  // fluent, confident and entirely invented. NOTHING in Hearth carries house
  // geometry. HA areas give room NAMES with no adjacency; house_data.json has
  // wi-fi, trash day and shutoffs but no floor plan. Directions are the single
  // most likely question a guest asks, which makes this the panel's most likely
  // lie — the same failure shape as the voice grounding void (2026-08-03), and
  // worse here because the person asking cannot tell she is guessing.
  const framed =
    `(System: this is the household's GUEST PANEL, a phone handed to a visitor. ` +
    `They are in the ${room}. They are not a household member — answer as the ` +
    `host's chief of staff would answer a guest standing in the hallway: warm, ` +
    `brief, spoken aloud. Use your own judgment about anything personal to the ` +
    `household.\n` +
    `You do NOT have a floor plan of this house. You know these room names and ` +
    `nothing whatever about how they connect: ${ROOM_ORDER.join(', ')}. You do ` +
    `not know which floor a room is on, what is next to what, or what any door ` +
    `looks like. If they ask how to get somewhere, say plainly that you can't ` +
    `give directions and they should ask their host — do NOT describe a route, ` +
    `a hallway, a staircase, a landing or a door. Saying which rooms exist is ` +
    `fine; describing the way there is not.)\n\n` +
    question;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((res) => {
    timer = setTimeout(() => res(null), ANSWER_DEADLINE_MS);
  });

  try {
    const turn = runtime.turn({
      specialist_id: GUEST_SPECIALIST,
      // Not a stored conversation — a stable label for the turn's provenance,
      // the same way the relay names its switch-greeting turn.
      conversation_id: 'guest-panel',
      message: { role: 'user', content: framed },
      conversation_history: history_for(session_id).map((t) => ({
        role: t.role,
        content: t.content,
        specialist_id: t.specialist_id,
      })),
      user: guest_caller(timezone),
      // Someone is standing there holding a phone. The LIVE tier is the
      // concurrent endpoint; the default DEEP path is single-slot and queues
      // behind background deliberation — a guest turn measured over 180s that
      // way. Same reasoning, and the same hint, as interactive chat.
      tier: 'live',
      // A hallway answer IS a voice turn, whether it arrived as speech or as
      // typing: Kate's slim `voice_persona` in place of the ~4.5K-token chat
      // persona, `voice_style` for speakable output, and none of the research
      // scaffolding a chat turn carries. On the full chat path a guest question
      // ran past the 45s deadline 3 times in 4 — the model itself answers in
      // 0.33s, so the cost was all in the turn around it. Grounding still
      // applies: the voice packs have been topic-gated since the grounding-void
      // fix, so this no longer means "no calendar block".
      surface: 'voice',
    });

    const out = await Promise.race([turn, deadline]);
    if (out === null) return { ok: false, reason: 'kate is taking a while — try again' };

    const reply = (out.message_text ?? '').trim();
    if (!reply) return { ok: false, reason: 'no answer' };
    remember(session_id, question, reply);
    return { ok: true, reply };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam — drops all in-memory guest sessions. */
export function _reset_guest_sessions(): void {
  sessions.clear();
}
