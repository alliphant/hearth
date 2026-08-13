/**
 * /api/specialists/:id/friends — Kate's Friends office tab (2026-06-22).
 *
 * A relationship dossier over the People/ person notes (the shared household
 * contact graph — NOT Cordelia-owned, NOT genealogy). Per friend it assembles
 * a CRM-grade view: identity + how-we-met, a STAY-IN-TOUCH read (cadence vs
 * last-contacted → overdue), DATES THAT MATTER (birthday + anniversaries +
 * arbitrary tracked dates, soonest-first), structured PEOPLE & PETS, gifting
 * cues (interests/dislikes/sizes/gift history) + DIETARY for hosting, linked
 * flight watches, and the interaction note body (drill-in).
 *
 * Reads + writes are PER-REQUESTER cordoned via note_visible_to_caller (owner
 * has NO god-view). Genealogy (GEDCOM) imports are excluded — they're an
 * ancestry DB, not contacts. Structured edits go through generic list add/remove
 * + a contacted stamp; all writes reuse the real person tools so stamping +
 * schema validation + audit apply. The "intelligence" actions (reach out, gift
 * ideas, deep-research, Kate's read) are client-side chat prompts that run on
 * Kate's full tool surface — no new endpoints.
 *
 * Mounted at app.route('/api/specialists', …) — EXISTING namespace, no nginx
 * edit. read_vault-gated (generic by capability — today Kate).
 */
import { Hono } from 'hono';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { LLMRouter } from '@core/llm';
import type { ToolContext } from '@core/tool';
import type { MemoryClient, PersonRow } from '@memory/client';
import type { SpecialistRegistry } from '@core/specialist';
import { local_iso_date } from '@core/time';
import { CADENCE_DAYS, parse_fm, is_genealogy, is_public_figure, days_until, days_since } from '@core/relationship_signals';
import {
  RELATES_TO,
  assemble_relationships,
  display_for_ref,
  type RelationshipView,
  type EntityKind,
} from '@core/person_relations';
import type { KnowledgeEdges } from '@memory/stores/knowledge_edges';
import {
  note_visible_to_caller,
  parse_private_to,
  type Caller,
} from '@memory/private_to';
import { TrackedFlightsStore, type TrackedFlight } from '@memory/stores/flights';
import { PersonObservations, type PersonObservation } from '@memory/stores/person_observations';
import { PersonSynthesisStore, type PersonSynthesis } from '@memory/stores/person_synthesis';
import { ImessageOptIn } from '@memory/stores/imessage_staging';
import { purge_person } from '@core/person_delete';
import { find_or_create_person } from '@agents/scribe/tools/find_or_create_person';
import { upsert_person_note } from '@agents/scribe/tools/upsert_person_note';
import { create as create_flight_tools } from '@connectors/flights';

export interface UpcomingEvent {
  kind: 'birthday' | 'anniversary' | 'date';
  person_id: string;
  name: string;
  note_path: string;
  date: string;
  days_until: number;
  what?: string;
}

export interface FriendsRouterDeps {
  db: Database;
  memory: MemoryClient;
  specialists: SpecialistRegistry;
  llm: LLMRouter;
}

// Structured frontmatter keys that get their own dossier sections — NOT dumped
// as generic "facts". (The free-form catch-all is the note body + any leftover.)
const STRUCTURED_KEYS = new Set([
  'type', 'id', 'name', 'preferred_name', 'pronouns', 'relationship', 'birthday',
  'anniversaries', 'contact', 'tone', 'contact_cadence', 'last_contacted',
  'sensitive', 'friday_managed', 'do_not_contact', 'gift_history', 'address',
  'coords', 'travel_notes', 'private_to', 'likes', 'dislikes', 'sizes', 'pets',
  'important_dates', 'relations', 'dietary', 'how_we_met', 'gedcom_xref',
]);

// The array fields the structured forms add to / remove from.
const LIST_FIELDS = new Set(['pets', 'relations', 'important_dates', 'likes', 'dislikes', 'dietary']);

function extract_facts(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (!STRUCTURED_KEYS.has(k) && v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

interface FriendView {
  id: string;
  name: string;
  preferred_name: string | null;
  pronouns: string | null;
  relationship: string;
  how_we_met: unknown;
  birthday: string | null;
  contact: unknown;
  address: unknown;
  travel_notes: unknown;
  tone: unknown;
  // stay-in-touch
  contact_cadence: string | null;
  last_contacted: string | null;
  days_since_contact: number | null;
  overdue: boolean;
  // dates
  upcoming: UpcomingEvent[];
  next_in_days: number | null;
  // structured entities
  pets: unknown[];
  relations: unknown[];
  // gifting + hosting
  interests: string[];
  dislikes: string[];
  dietary: string[];
  sizes: unknown;
  gift_history: unknown[];
  // relationship graph (Phase 0) — typed ties to people/places, with provenance
  relationships: RelationshipView[];
  // observational engine (A+D) — what Hearth has NOTICED, each with provenance
  observations: ObservationView[];
  // synthesis pass — the durable relationship narrative distilled from the stream
  // (cordon-filtered; null when none yet, or siloed to another viewer).
  synthesis: SynthesisView | null;
  // iMessage observer — per-contact opt-in (default OFF); the card toggle state.
  imessage_opt_in: boolean;
  // misc + linked
  facts: Record<string, unknown>;
  flights: TrackedFlight[];
  note_path: string;
}

/** Client-safe projection of an observation (drops user_id / private_to). */
interface ObservationView {
  id: string;
  kind: string;
  summary: string;
  source_type: string;
  confidence: number;
  observed_at: string;
}
function to_observation_view(o: PersonObservation): ObservationView {
  return { id: o.id, kind: o.kind, summary: o.summary, source_type: o.source_type, confidence: o.confidence, observed_at: o.observed_at };
}

/** Client-safe projection of the synthesis narrative (drops user_id / private_to /
 *  the internal cursor). */
interface SynthesisView {
  summary: string;
  themes: string[];
  /** How they communicate — '' until the synthesis has evidence of their voice. */
  communication: string;
  source_observation_count: number;
  /** Refinement depth: rev 1 is a first impression, rev 20 a portrait. */
  revision: number;
  updated_at: string;
}
function to_synthesis_view(s: PersonSynthesis): SynthesisView {
  return {
    summary: s.summary,
    themes: s.themes,
    communication: s.communication,
    source_observation_count: s.source_observation_count,
    revision: s.revision,
    updated_at: s.updated_at,
  };
}

/** Build a ref→display resolver from the current people list (places fall back
 *  to their note basename — Phase 0). Shared by the list + drill routes. */
function make_display(people: PersonRow[]): (ref: string) => { name: string; kind: EntityKind } {
  const people_by_path = new Map<string, string>();
  for (const p of people) people_by_path.set(p.note_path, p.name);
  const places_by_path = new Map<string, string>();
  return (ref: string) => display_for_ref(ref, people_by_path, places_by_path);
}

function as_str_array(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function as_array(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function assemble(
  row: PersonRow,
  caller: Caller,
  flights: TrackedFlightsStore,
  birthday_anniv: UpcomingEvent[],
  today_iso: string,
  edges: KnowledgeEdges,
  display: (ref: string) => { name: string; kind: EntityKind },
  observations: PersonObservation[],
  synthesis: PersonSynthesis | null,
  imessage_opt_in: boolean,
): FriendView | null {
  const fm = parse_fm(row.frontmatter_json);
  // Ancestry DB and public figures are not contacts (self IS shown, as the "You"
  // rung — hence the composed class checks rather than `is_non_contact`).
  if (is_genealogy(fm, row.note_path) || is_public_figure(row)) return null;
  if (!note_visible_to_caller(parse_private_to(fm.private_to), caller)) return null; // cordon

  // Merge tracked important_dates into the birthday/anniversary stream.
  const tracked: UpcomingEvent[] = [];
  for (const it of as_array(fm.important_dates)) {
    if (!it || typeof it !== 'object') continue;
    const o = it as { date?: unknown; what?: unknown; recurring?: unknown };
    if (typeof o.date !== 'string') continue;
    const du = days_until(o.date, today_iso, Boolean(o.recurring));
    if (du === null || du < 0) continue; // drop past one-offs
    tracked.push({ kind: 'date', person_id: row.id, name: row.name, note_path: row.note_path, date: o.date, days_until: du, what: typeof o.what === 'string' ? o.what : 'date' });
  }
  const upcoming = [...birthday_anniv, ...tracked].sort((a, b) => a.days_until - b.days_until);

  const cadence = row.contact_cadence;
  const since = days_since(row.last_contacted, today_iso);
  const overdue = Boolean(cadence && cadence in CADENCE_DAYS && since !== null && since > CADENCE_DAYS[cadence]!);

  return {
    id: row.id,
    name: row.name,
    preferred_name: row.preferred_name,
    pronouns: typeof fm.pronouns === 'string' && fm.pronouns.trim() ? fm.pronouns.trim() : null,
    relationship: row.relationship,
    how_we_met: fm.how_we_met ?? null,
    birthday: row.birthday,
    contact: fm.contact ?? null,
    address: fm.address ?? null,
    travel_notes: fm.travel_notes ?? null,
    tone: fm.tone,
    contact_cadence: cadence,
    last_contacted: row.last_contacted,
    days_since_contact: since,
    overdue,
    upcoming,
    next_in_days: upcoming.length ? upcoming[0]!.days_until : null,
    pets: as_array(fm.pets),
    relations: as_array(fm.relations),
    interests: as_str_array(fm.likes),
    dislikes: as_str_array(fm.dislikes),
    dietary: as_str_array(fm.dietary),
    sizes: fm.sizes ?? null,
    gift_history: as_array(fm.gift_history),
    relationships: assemble_relationships(
      row.note_path,
      edges.touching(row.note_path, caller, RELATES_TO),
      display,
    ),
    observations: observations.map(to_observation_view),
    synthesis: synthesis ? to_synthesis_view(synthesis) : null,
    imessage_opt_in,
    facts: extract_facts(fm),
    flights: caller.user_id ? flights.list_for_person(caller.user_id, row.id) : [],
    note_path: row.note_path,
  };
}

export function create_friends_router(deps: FriendsRouterDeps): Hono {
  const r = new Hono();
  const flights = new TrackedFlightsStore(deps.db);
  const observations = new PersonObservations(deps.db);
  const synthesis = new PersonSynthesisStore(deps.db);
  const imessage_opt_in = new ImessageOptIn(deps.db);
  const flight_tools = create_flight_tools({ db: deps.db } as never);
  const track_flight = flight_tools.find((t) => t.name === 'track_flight')!;
  const untrack_flight = flight_tools.find((t) => t.name === 'untrack_flight')!;

  const caller_of = (
    c: { get: (k: 'user') => { id?: string; tier?: string } | undefined },
  ): Caller | null => {
    const user = c.get('user');
    if (!user) return null;
    return { user_id: user.id, tier: (user.tier ?? 'friend') as Caller['tier'] };
  };
  const office_or_404 = (id: string): boolean => {
    const s = deps.specialists.get(id);
    return !!s && s.granted.has('read_vault');
  };
  const make_ctx = (caller: Caller): ToolContext => ({
    memory: deps.memory,
    llm: deps.llm,
    now: new Date(),
    intent_id: ulid(),
    ...(caller.user_id ? { user: { id: caller.user_id, tier: caller.tier } } : {}),
  });
  const birthday_anniv_map = (): Map<string, UpcomingEvent[]> => {
    const m = new Map<string, UpcomingEvent[]>();
    for (const e of deps.memory.upcoming_dates(366) as UpcomingEvent[]) {
      const arr = m.get(e.person_id) ?? [];
      arr.push(e);
      m.set(e.person_id, arr);
    }
    return m;
  };
  const visible_person = (caller: Caller, pid: string): PersonRow | null => {
    const row = deps.memory.query_people({}).find((p) => p.id === pid);
    if (!row) return null;
    const fm = parse_fm(row.frontmatter_json);
    if (is_genealogy(fm, row.note_path) || is_public_figure(row)) return null;
    return note_visible_to_caller(parse_private_to(fm.private_to), caller) ? row : null;
  };
  async function body_of(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
    try { const v = await c.req.json(); return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}; }
    catch { return {}; }
  }

  // ── READ: list ────────────────────────────────────────────────────────────
  r.get('/:id/friends', async (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'unauthenticated' }, 401);
    if (!office_or_404(c.req.param('id'))) return c.json({ error: 'no friends office for this specialist' }, 404);
    const today_iso = local_iso_date(new Date(), undefined);
    const bam = birthday_anniv_map();
    const all = deps.memory.query_people({});
    const display = make_display(all);
    const obs_by_person = observations.by_person(all.map((p) => p.id), caller, 5);
    const syn_by_person = synthesis.by_person(all.map((p) => p.id), caller);
    const im_enabled = imessage_opt_in.enabled_set(caller);
    const friends = all
      .map((row) => assemble(row, caller, flights, bam.get(row.id) ?? [], today_iso, deps.memory.knowledge_edges, display, obs_by_person.get(row.id) ?? [], syn_by_person.get(row.id) ?? null, im_enabled.has(row.id)))
      .filter((f): f is FriendView => f !== null)
      .sort((a, b) => {
        // Overdue-to-reconnect first, then soonest upcoming date, then name.
        if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
        const an = a.next_in_days ?? Number.POSITIVE_INFINITY;
        const bn = b.next_in_days ?? Number.POSITIVE_INFINITY;
        return an !== bn ? an - bn : a.name.localeCompare(b.name);
      });
    return c.json({ generated_at: new Date().toISOString(), friends });
  });

  // ── READ: drill-in (+ note body; 404 on hidden/genealogy/unknown) ─────────
  r.get('/:id/friends/:pid', async (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'unauthenticated' }, 401);
    if (!office_or_404(c.req.param('id'))) return c.json({ error: 'no friends office for this specialist' }, 404);
    const row = visible_person(caller, c.req.param('pid'));
    const today_iso = local_iso_date(new Date(), undefined);
    const ba = row ? deps.memory.upcoming_dates(366).filter((e) => e.person_id === row.id) as UpcomingEvent[] : [];
    const display = make_display(deps.memory.query_people({}));
    const obs = row ? observations.list_for_person(row.id, caller, { limit: 20 }) : [];
    const syn = row ? synthesis.get_for_person(row.id, caller) : null;
    const friend = row ? assemble(row, caller, flights, ba, today_iso, deps.memory.knowledge_edges, display, obs, syn, imessage_opt_in.is_enabled(row.id)) : null;
    if (!friend) return c.json({ error: 'not found' }, 404);
    const note = deps.memory.read_note(row!.note_path);
    return c.json({ generated_at: new Date().toISOString(), friend: { ...friend, note_body: note?.body ?? '' } });
  });

  // ── OBSERVATIONS: dismiss one (the D trust action — "that's wrong/noise") ──
  r.post('/:id/friends/:pid/observation/:oid/dismiss', async (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'unauthenticated' }, 401);
    if (!office_or_404(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
    if (!visible_person(caller, c.req.param('pid'))) return c.json({ error: 'not found' }, 404);
    const ok = observations.dismiss(c.req.param('oid'), caller);
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  // ── iMESSAGE OPT-IN: toggle observing this contact's iMessage (default OFF) ──
  // Hearth owns + ENFORCES the registry (the ingest route gates on it); this is
  // the human surface. Owner-cordoned (private_to = the opting user). The macOS
  // app reads the resulting allowlist from GET /api/imessage/opt_in.
  r.post('/:id/friends/:pid/imessage_opt_in', async (c) => {
    const caller = caller_of(c);
    if (!caller || !caller.user_id) return c.json({ error: 'unauthenticated' }, 401);
    if (!office_or_404(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
    const pid = c.req.param('pid');
    if (!visible_person(caller, pid)) return c.json({ error: 'not found' }, 404);
    const body = await body_of(c);
    const enabled = body.enabled === true;
    imessage_opt_in.set(pid, caller.user_id, caller.user_id, enabled);
    return c.json({ ok: true, enabled });
  });

  // ── DELETE: remove a contact entirely (note + relationships + flights + observations) ──
  r.delete('/:id/friends/:pid', async (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'unauthenticated' }, 401);
    if (!office_or_404(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
    const row = visible_person(caller, c.req.param('pid'));
    if (!row) return c.json({ error: 'not found' }, 404); // cordon: only what you can see
    const res = purge_person(deps.db, deps.memory, { id: row.id, note_path: row.note_path });
    return c.json({ ok: true, removed: res.note_removed, rows: res.rows });
  });

  // ── CREATE: a new person ───────────────────────────────────────────────────
  r.post('/:id/friends', async (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'unauthenticated' }, 401);
    if (!office_or_404(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
    const body = await body_of(c);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return c.json({ error: 'name is required' }, 400);
    const hints = typeof body.relationship === 'string' ? { relationship: body.relationship } : undefined;
    try {
      const out = await find_or_create_person.execute({ name, hints }, make_ctx(caller));
      return c.json(out, out.created ? 201 : 200);
    } catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });

  // ── UPDATE: patch frontmatter and/or append a note line (interaction log) ──
  r.post('/:id/friends/:pid', async (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'unauthenticated' }, 401);
    if (!office_or_404(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
    const pid = c.req.param('pid');
    if (!visible_person(caller, pid)) return c.json({ error: 'not found' }, 404);
    const body = await body_of(c);
    const patch = body.patch && typeof body.patch === 'object' ? (body.patch as Record<string, unknown>) : {};
    const body_append = typeof body.body_append === 'string' ? body.body_append : undefined;
    if (Object.keys(patch).length === 0 && !body_append) return c.json({ error: 'nothing to update' }, 400);
    try {
      const out = await upsert_person_note.execute({ identifier: { id: pid }, patch, body_append }, make_ctx(caller));
      return c.json(out);
    } catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });

  // ── STRUCTURED: append to a list field (pets/relations/dates/interests/…) ──
  r.post('/:id/friends/:pid/list', async (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'unauthenticated' }, 401);
    if (!office_or_404(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
    const pid = c.req.param('pid');
    const row = visible_person(caller, pid);
    if (!row) return c.json({ error: 'not found' }, 404);
    const body = await body_of(c);
    const field = String(body.field ?? '');
    if (!LIST_FIELDS.has(field)) return c.json({ error: `unknown list field: ${field}` }, 400);
    if (body.item === undefined || body.item === null || body.item === '') return c.json({ error: 'item is required' }, 400);
    const current = as_array(parse_fm(row.frontmatter_json)[field]);
    try {
      const out = await upsert_person_note.execute(
        { identifier: { id: pid }, patch: { [field]: [...current, body.item] } },
        make_ctx(caller),
      );
      return c.json(out);
    } catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });

  // ── STRUCTURED: remove a list item by index ───────────────────────────────
  r.post('/:id/friends/:pid/list/remove', async (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'unauthenticated' }, 401);
    if (!office_or_404(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
    const pid = c.req.param('pid');
    const row = visible_person(caller, pid);
    if (!row) return c.json({ error: 'not found' }, 404);
    const body = await body_of(c);
    const field = String(body.field ?? '');
    const index = Number(body.index);
    if (!LIST_FIELDS.has(field)) return c.json({ error: `unknown list field: ${field}` }, 400);
    const current = as_array(parse_fm(row.frontmatter_json)[field]);
    if (!Number.isInteger(index) || index < 0 || index >= current.length) return c.json({ error: 'bad index' }, 400);
    const next = current.slice(0, index).concat(current.slice(index + 1));
    try {
      const out = await upsert_person_note.execute({ identifier: { id: pid }, patch: { [field]: next } }, make_ctx(caller));
      return c.json(out);
    } catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });

  // ── STAY-IN-TOUCH: log that you reached out today (resets the nudge) ───────
  r.post('/:id/friends/:pid/contacted', async (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'unauthenticated' }, 401);
    if (!office_or_404(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
    const pid = c.req.param('pid');
    if (!visible_person(caller, pid)) return c.json({ error: 'not found' }, 404);
    try {
      const out = await upsert_person_note.execute(
        { identifier: { id: pid }, patch: { last_contacted: local_iso_date(new Date(), undefined) } },
        make_ctx(caller),
      );
      return c.json(out);
    } catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });

  // ── FLIGHTS: track / untrack ──────────────────────────────────────────────
  r.post('/:id/friends/:pid/flight', async (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'unauthenticated' }, 401);
    if (!office_or_404(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
    const pid = c.req.param('pid');
    if (!visible_person(caller, pid)) return c.json({ error: 'not found' }, 404);
    const body = await body_of(c);
    const flight_no = typeof body.flight_no === 'string' ? body.flight_no.trim() : '';
    if (!flight_no) return c.json({ error: 'flight_no is required' }, 400);
    const date = typeof body.date === 'string' ? body.date : undefined;
    const label = typeof body.label === 'string' ? body.label : undefined;
    try {
      const out = await track_flight.execute({ flight_no, date, person_id: pid, label }, make_ctx(caller));
      return c.json(out as Record<string, unknown>);
    } catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });

  r.delete('/:id/friends/:pid/flight/:fid', async (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'unauthenticated' }, 401);
    if (!office_or_404(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
    try {
      const out = await untrack_flight.execute({ id: c.req.param('fid') }, make_ctx(caller));
      return c.json(out as Record<string, unknown>);
    } catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });

  return r;
}
