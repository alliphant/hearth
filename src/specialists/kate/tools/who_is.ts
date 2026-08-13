import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import { note_visible_to_caller, parse_private_to, type Caller } from '@memory/private_to';
import {
  RELATES_TO,
  assemble_relationships,
  display_for_ref,
  type RelationshipView,
} from '@core/person_relations';
import { parse_fm, CADENCE_DAYS, days_since } from '@core/relationship_signals';
import { resolve_mentioned_people, visible_people } from '@core/entity_hydration';
import { TrackedFlightsStore } from '@memory/stores/flights';
import { PersonObservations } from '@memory/stores/person_observations';
import { PersonSynthesisStore } from '@memory/stores/person_synthesis';

/**
 * who_is — the model-driven, one-stop PERSON LOOKUP (People reasoning substrate,
 * 2026-06-22). The model calls this for ANY question about a specific person; it
 * resolves the name GENEROUSLY (a bare "Kim" finds "Kim Reyes") and returns
 * EVERYTHING in one call — tracked flights, dates, how to reach them, who they
 * know (relationships/roles), what they like, recent activity. So a read like
 * "when's Kim's flight back?" is one `who_is("Kim")` call, NOT the model trying to
 * pick a literal flight tool and manufacture a flight number ("Kim" jammed into
 * flight_status — the bug this fixes).
 *
 * Cordon-safe (the owner has no god-view of a person siloed to another user).
 * Read-only; fail-soft to `found:false`.
 */
const InputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(200)
    .describe('Who to look up — just their name; a first name like "Kim" is fine.'),
});

const RelationshipSchema = z.object({
  with: z.string(),
  with_kind: z.enum(['person', 'place']),
  role: z.string(),
  direction: z.enum(['outgoing', 'incoming']),
  provenance: z.enum(['told', 'observed', 'inferred']),
  confidence: z.number(),
});

const FlightSchema = z.object({
  flight_no: z.string(),
  route: z.string().nullable(),
  date: z.string(),
  status: z.string().nullable(),
  gate: z.string().nullable(),
  label: z.string().nullable(),
});

const OutputSchema = z.object({
  found: z.boolean(),
  kind: z.enum(['person', 'place']).optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  summary: z.string(),
  relationships: z.array(RelationshipSchema),
  flights: z.array(FlightSchema),
  upcoming: z.array(z.object({ what: z.string(), in_days: z.number(), date: z.string() })),
  observations: z.array(z.object({ summary: z.string(), source: z.string(), at: z.string() })),
  stay_in_touch: z
    .object({ days_since_contact: z.number().nullable(), cadence: z.string().nullable(), overdue: z.boolean() })
    .optional(),
  facts: z.record(z.string(), z.unknown()),
  /** The nightly-synthesis portrait (owner-cordoned) — the richest artifact the
   *  04:00 dossier pass produces, previously invisible to chat. */
  synthesis: z
    .object({ summary: z.string(), themes: z.array(z.string()), communication: z.string() })
    .optional(),
  /** Durable camera-appearance descriptors ("gray hoodie — seen 4× on camera").
   *  Derived counts from face-anchored sightings, never a judgment. */
  appearance: z.array(z.string()),
  /** When face recognition last positively saw this person (enrolled roster). */
  last_recognized_at: z.string().nullable(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

interface Resolved {
  id: string;
  note_path: string;
  fm: Record<string, unknown>;
}

function pick<T extends Record<string, unknown>>(o: T, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') out[k] = o[k];
  return out;
}
function db_of(memory: ToolContext['memory']): Database {
  return (memory as unknown as { cfg: { db: Database } }).cfg.db;
}
const NOT_FOUND = (name: string): Output => ({
  found: false,
  summary: `No person or place named "${name}" is on record yet.`,
  relationships: [],
  flights: [],
  upcoming: [],
  observations: [],
  facts: {},
  appearance: [],
  last_recognized_at: null,
});

export const who_is: Tool<Input, Output> = {
  name: 'who_is',
  description:
    'Look up a person (or place) and EVERYTHING you know about them in ONE call — their tracked ' +
    'flights, important dates, how to reach them, who they know (relationships/roles), what they ' +
    'like, recent activity. Use this for ANY question about a specific person: "when\'s Kim\'s flight ' +
    'back?", "what\'s Sam into?", "who\'s Kim\'s hairdresser?", "how do I reach Dana?". Pass just ' +
    'their name — a first name like "Kim" is fine; do NOT make the user give IDs or flight numbers.',
  risk: 'read',
  required_capabilities: ['read_vault'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256').update(input.name.toLowerCase().trim());
    return `who_is:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    const caller: Caller = {
      user_id: ctx.user?.id,
      tier: (ctx.user?.tier ?? 'friend') as Caller['tier'],
    };

    // ── Resolve the subject — SMART. Exact (id/full name) first; if that misses
    // (or is cordoned), fall back to the generous resolver over the caller's
    // VISIBLE people so a bare "Kim" reaches "Kim Reyes". Never leak a siloed
    // person: a cordoned exact hit just routes to the visible-people fallback.
    let resolved: Resolved | null = null;
    let kind: 'person' | 'place' | undefined;
    const exact = ctx.memory.find_person({ name: input.name });
    if (exact && note_visible_to_caller(parse_private_to((exact.frontmatter as Record<string, unknown>)?.private_to), caller)) {
      resolved = { id: exact.id, note_path: exact.note_path, fm: (exact.frontmatter ?? {}) as Record<string, unknown> };
      kind = 'person';
    } else {
      const m = resolve_mentioned_people(input.name, visible_people(ctx.memory, caller), 1)[0];
      if (m) {
        resolved = { id: m.id, note_path: m.note_path, fm: parse_fm(m.frontmatter_json) };
        kind = 'person';
      }
    }

    let self_ref: string | null = resolved?.note_path ?? null;
    let id = resolved?.id;
    let display_name = resolved && typeof resolved.fm.name === 'string' ? (resolved.fm.name as string) : input.name;
    let pronouns: string | null = null;
    let facts: Record<string, unknown> = {};
    let flights: Output['flights'] = [];
    let upcoming: Output['upcoming'] = [];
    let observations: Output['observations'] = [];
    let stay_in_touch: Output['stay_in_touch'];
    let synthesis: Output['synthesis'];
    let appearance: string[] = [];
    let last_recognized_at: string | null = null;

    if (resolved) {
      const fm = resolved.fm;
      pronouns = typeof fm.pronouns === 'string' && fm.pronouns.trim() ? fm.pronouns.trim() : null;
      facts = pick(fm, [
        'pronouns', 'relationship', 'preferred_name', 'birthday', 'likes', 'dislikes',
        'dietary', 'contact', 'last_contacted', 'contact_cadence', 'address', 'how_we_met',
      ]);
      const db = db_of(ctx.memory);

      // ✈️ Tracked flights — the signal the "Kim's flights" bug couldn't reach.
      if (caller.user_id) {
        flights = new TrackedFlightsStore(db).list_for_person(caller.user_id, resolved.id).map((f) => ({
          flight_no: f.flight_no,
          route: [f.dep_iata, f.arr_iata].filter(Boolean).join('→') || null,
          date: f.flight_date,
          status: f.status,
          gate: f.arr_gate,
          label: f.label ?? null,
        }));
      }

      // Dates that matter (birthday + tracked), recent observations, stay-in-touch.
      upcoming = ctx.memory
        .upcoming_dates(366)
        .filter((e) => e.person_id === resolved!.id)
        .slice(0, 3)
        .map((e) => ({ what: e.what ?? e.kind, in_days: e.days_until, date: e.date }));
      const obs_store = new PersonObservations(db);
      const all_obs = obs_store.list_for_person(resolved.id, caller, { limit: 24 });
      // Appearance descriptors get their own field (they'd crowd the noticed
      // list); stable traits (`appearance`: build/hair) lead, current clothing
      // (`appearance_wear`) follows. Everything else stays the activity glance.
      const traits = all_obs.filter((o) => o.kind === 'appearance').slice(0, 4);
      const wear = all_obs.filter((o) => o.kind === 'appearance_wear').slice(0, 3);
      appearance = [...traits, ...wear].map((o) => o.summary);
      observations = all_obs
        .filter((o) => !o.kind.startsWith('appearance'))
        .slice(0, 5)
        .map((o) => ({ summary: o.summary, source: o.source_type, at: o.observed_at }));

      // The nightly dossier portrait (owner-cordoned; get_for_person enforces it).
      const synth = new PersonSynthesisStore(db).get_for_person(resolved.id, caller);
      if (synth && (synth.summary || synth.themes.length || synth.communication)) {
        synthesis = { summary: synth.summary, themes: synth.themes, communication: synth.communication };
      }

      // Face-recognition roster join (person_ref bond, 2026-07-24) — when this
      // dossier is an enrolled face, say when the cameras last positively saw them.
      if (caller.user_id) {
        try {
          const enrolled = ctx.memory
            .list_enrolled_persons(caller.user_id)
            .find((p) => p.person_ref === resolved!.id);
          last_recognized_at = enrolled?.last_recognized_at ?? null;
        } catch {
          last_recognized_at = null;
        }
      }
      const cadence = typeof fm.contact_cadence === 'string' ? fm.contact_cadence : null;
      const last = typeof fm.last_contacted === 'string' ? fm.last_contacted : null;
      const since = days_since(last, new Date().toISOString().slice(0, 10)); // who_is: N-day delta, UTC ok — time-guard-ok
      stay_in_touch = {
        days_since_contact: since,
        cadence,
        overdue: Boolean(cadence && cadence in CADENCE_DAYS && since !== null && since > CADENCE_DAYS[cadence]!),
      };
    } else {
      // Not a known person → try a place by name.
      const place = ctx.memory.find_place_by_name(input.name);
      if (place) {
        self_ref = place.note_path;
        id = place.id;
        kind = 'place';
        display_name = place.name;
        facts = pick(place as unknown as Record<string, unknown>, ['category', 'address', 'phone']);
      }
    }

    if (!self_ref) return NOT_FOUND(input.name);

    // Relationships touching the subject (both directions, with provenance).
    const people_by_path = new Map<string, string>();
    for (const p of ctx.memory.query_people({})) people_by_path.set(p.note_path, p.name);
    const edges = ctx.memory.knowledge_edges.touching(self_ref, caller, RELATES_TO);
    const relationships: RelationshipView[] = assemble_relationships(self_ref, edges, (ref) =>
      display_for_ref(ref, people_by_path, new Map()),
    );

    // A one-line summary the model can lead with.
    const bits: string[] = [];
    if (flights.length) bits.push(`${flights.length} tracked flight${flights.length === 1 ? '' : 's'}`);
    if (relationships.length) {
      bits.push(
        relationships
          .slice(0, 3)
          .map((r) => (r.direction === 'outgoing' ? `${r.role}: ${r.with}` : `${r.with}'s ${r.role}`))
          .join('; '),
      );
    }
    const summary = `${display_name}${pronouns ? ` (${pronouns})` : ''} — ${kind}.${bits.length ? ' ' + bits.join('. ') + '.' : ''}`;

    return {
      found: true, kind, id, name: display_name, summary, relationships, flights,
      upcoming, observations, stay_in_touch, facts, synthesis, appearance, last_recognized_at,
    };
  },
};
