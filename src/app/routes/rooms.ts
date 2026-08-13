/**
 * /api/rooms — multi-specialist "agent rooms".
 *
 * Owner-only (single-owner surface for now). Cordoned: every read/write checks
 * the room's conversation belongs to the calling user. The turn-taking lives in
 * src/core/agent_rooms.run_room_turn; these routes are thin CRUD + a post-message
 * endpoint that drives one orchestrated turn and returns the replies.
 *
 * v1 is NON-streamed: POST a message, get back the ordered agent replies. Token
 * streaming (per-speaker SSE) is a follow-on; the thread is already persisted so
 * a streamed client can hydrate from GET /:id.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ConversationStore } from '@memory/stores/conversations';
import type { RoomsStore } from '@memory/stores/rooms';
import type { SpecialistRegistry } from '@core/specialist';
import type { SpecialistRuntime } from '@core/specialist_runtime';
import type { LLMRouter } from '@core/llm';
import type { AppEventBus } from '@app/events';
import { run_room_turn } from '@core/agent_rooms';

export interface RoomsRoutesDeps {
  conversations: ConversationStore;
  rooms: RoomsStore;
  specialists: SpecialistRegistry;
  runtime: SpecialistRuntime;
  llm: LLMRouter;
  /** SSE bus — the Rooms view is push-driven (owner message, per-agent reply,
   *  and turn started/done all fan out here; never polled). */
  events?: AppEventBus;
}

function _owner(c: Context): { id: string; tier: string; timezone?: string } | Response {
  const u = c.get('user');
  if (!u || u.tier !== 'owner') return c.json({ error: 'owner tier required' }, 403);
  return u;
}

/** True if a room conversation is owned by this user (NULL user_id folds to jasper). */
function _owns(deps: RoomsRoutesDeps, conversation_id: string, user_id: string): boolean {
  const conv = deps.conversations.get(conversation_id);
  if (!conv) return false;
  return conv.user_id === user_id || (user_id === 'jasper' && conv.user_id === null);
}

/** Rooms with a turn currently running — one turn per room at a time, and the
 *  GET flag lets the client show a spinner + keep polling. In-memory is fine:
 *  a restart clears it, which is correct (no turn survives a restart anyway). */
const roomsInFlight = new Set<string>();

export function create_rooms_router(deps: RoomsRoutesDeps): Hono {
  const r = new Hono();

  // List the owner's rooms.
  r.get('/', (c) => {
    const u = _owner(c);
    if (u instanceof Response) return u;
    return c.json({ rooms: deps.rooms.list_rooms(u.id) });
  });

  // Create a room. Body: { title?, participant_ids: string[] }.
  r.post('/', async (c) => {
    const u = _owner(c);
    if (u instanceof Response) return u;
    const b = (await c.req.json().catch(() => null)) as
      | { title?: string; participant_ids?: unknown }
      | null;
    const ids = Array.isArray(b?.participant_ids) ? b!.participant_ids.map(String) : [];
    const resolved = ids
      .map((x) => deps.specialists.resolve_id(x))
      .filter((x): x is string => !!x);
    if (resolved.length < 2) {
      return c.json({ error: 'a room needs at least 2 valid participants' }, 400);
    }
    const conv = deps.rooms.create_room(u.id, b?.title?.trim() || undefined, resolved);
    return c.json(
      { room_id: conv.id, title: conv.title, participant_ids: deps.rooms.list_participants(conv.id) },
      201,
    );
  });

  // Room detail: participants + message thread.
  r.get('/:id', (c) => {
    const u = _owner(c);
    if (u instanceof Response) return u;
    const id = c.req.param('id');
    if (!deps.rooms.is_room(id)) return c.json({ error: 'not a room' }, 404);
    if (!_owns(deps, id, u.id)) return c.json({ error: 'not found' }, 404);
    const conv = deps.conversations.get(id);
    const messages = deps.conversations
      .list_messages(id, { limit: 200 })
      .slice()
      .reverse()
      .map((m) => ({
        id: m.id,
        ts: m.ts,
        role: m.role,
        specialist_id: m.specialist_id,
        name: m.role === 'user' ? 'You' : deps.specialists.get(m.specialist_id ?? '')?.name ?? m.specialist_id,
        content_md: m.content_md,
      }));
    return c.json({
      room_id: id,
      title: conv?.title ?? null,
      participant_ids: deps.rooms.list_participants(id),
      turn_in_flight: roomsInFlight.has(id),
      messages,
    });
  });

  // Add / remove a participant.
  r.post('/:id/participants', async (c) => {
    const u = _owner(c);
    if (u instanceof Response) return u;
    const id = c.req.param('id');
    if (!deps.rooms.is_room(id) || !_owns(deps, id, u.id)) return c.json({ error: 'not found' }, 404);
    const b = (await c.req.json().catch(() => null)) as { specialist_id?: string } | null;
    const sid = b?.specialist_id ? deps.specialists.resolve_id(b.specialist_id) : null;
    if (!sid) return c.json({ error: 'unknown specialist' }, 400);
    deps.rooms.add_participant(id, sid);
    return c.json({ participant_ids: deps.rooms.list_participants(id) });
  });

  r.delete('/:id/participants/:sid', (c) => {
    const u = _owner(c);
    if (u instanceof Response) return u;
    const id = c.req.param('id');
    if (!deps.rooms.is_room(id) || !_owns(deps, id, u.id)) return c.json({ error: 'not found' }, 404);
    deps.rooms.remove_participant(id, c.req.param('sid'));
    return c.json({ participant_ids: deps.rooms.list_participants(id) });
  });

  // Post an owner message → run one orchestrated turn → return the replies.
  // Body: { content: string, addressed_specialist_id?: string }.
  r.post('/:id/messages', async (c) => {
    const u = _owner(c);
    if (u instanceof Response) return u;
    const id = c.req.param('id');
    if (!deps.rooms.is_room(id) || !_owns(deps, id, u.id)) return c.json({ error: 'not found' }, 404);
    const b = (await c.req.json().catch(() => null)) as
      | { content?: string; addressed_specialist_id?: string }
      | null;
    const content = (b?.content ?? '').trim();
    if (!content) return c.json({ error: 'content required' }, 400);
    // One turn per room at a time — reject a new message while one is running so
    // replies don't interleave. The client disables send while turn_in_flight.
    if (roomsInFlight.has(id)) return c.json({ status: 'busy' }, 409);
    const addressed = b?.addressed_specialist_id
      ? deps.specialists.resolve_id(b.addressed_specialist_id) ?? undefined
      : undefined;
    // Persist the owner message NOW so the 202 ack + the client's next poll see
    // it immediately, then run the (multi-second) turn DETACHED — a room turn is
    // far too long to hold an HTTP request open (a client disconnect used to
    // abort it mid-way). Replies persist to the thread as each speaker lands; the
    // client hydrates via GET /:id and stops polling when turn_in_flight clears.
    const owner_row = deps.conversations.append_message({ conversation_id: id, role: 'user', content_md: content, surface: 'web' });
    roomsInFlight.add(id);
    // Push the owner's own message + the "turn started" signal so the Rooms
    // view renders the message and shows its thinking indicator immediately —
    // no poll. Replies then stream in as `room_message_added` events, and
    // `room_turn_done` clears the indicator + re-enables the composer.
    deps.events?.emit({
      type: 'room_message_added',
      room_id: id,
      user_id: u.id,
      message: {
        id: owner_row.id,
        ts: owner_row.ts,
        role: 'user',
        specialist_id: null,
        name: 'You',
        content_md: content,
      },
    });
    deps.events?.emit({ type: 'room_turn_started', room_id: id, user_id: u.id });
    void run_room_turn(
      { runtime: deps.runtime, specialists: deps.specialists, llm: deps.llm, conversations: deps.conversations, rooms: deps.rooms, events: deps.events },
      {
        room_conversation_id: id,
        owner_message: content,
        user: {
          id: u.id,
          display_name: (u as { display_name?: string }).display_name ?? u.id,
          tier: u.tier as never,
          timezone: u.timezone,
        },
        addressed_specialist_id: addressed,
      },
    )
      .then((result) => {
        deps.events?.emit({ type: 'room_turn_done', room_id: id, user_id: u.id, speakers: result.speakers });
      })
      .catch((err) => {
        console.error(`[rooms] turn failed for ${id}:`, err);
        // Always signal done so the client never sticks in the disabled state.
        deps.events?.emit({ type: 'room_turn_done', room_id: id, user_id: u.id, speakers: [] });
      })
      .finally(() => roomsInFlight.delete(id));
    return c.json({ status: 'running' }, 202);
  });

  return r;
}
