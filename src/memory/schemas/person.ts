import { z } from 'zod';

// Specialists (Kate especially) naturally emit an address as a structured
// object — `{ street, city, state, zip, community }` — rather than a flat
// string. The old `z.string()` rejected that with a bare ZodError, the model
// retried the identical call, and the runtime killed it with DUPLICATE_TOOL_CALL
// — which is exactly how the 2026-06-01 home-address correction failed to
// persist (23 failed upsert_person_note calls in 7d). Accept both shapes; the
// maps connector that geocodes this field already string-coerces its input.
const AddressValue = z.union([
  z.string(),
  z
    .object({
      street: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      zip: z.string().optional(),
      country: z.string().optional(),
      community: z.string().optional(),
    })
    .passthrough(),
]);

// `birthday` is read back out of the people-table column as a string by
// `upcoming_dates` (days_until). YAML/JSON commonly hands us a Date or a full
// ISO datetime — coerce both down to the YYYY-MM-DD the column expects rather
// than rejecting (another DUPLICATE_TOOL_CALL trigger).
function coerce_ymd(v: unknown): unknown {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10); // time-guard-ok: coerce a gray-matter Date back to YYYY-MM-DD for the column
  }
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4}-\d{2}-\d{2})T/);
    if (m) return m[1];
  }
  return v;
}

export const PersonFrontmatter = z.object({
  type: z.literal('person'),
  id: z.string().regex(/^p_[a-z0-9]{6}$/),
  name: z.string(),
  preferred_name: z.string().optional(),
  // Pronouns — a first-class identity fact (2026-06-22) so Kate doesn't misgender.
  // FREE string on purpose ("she/her", "they/them", "he/him", "she/they",
  // neopronouns) — never an enum (that would exclude valid pronouns). Surfaced
  // prominently by who_is so it's in context whenever Kate reasons about a person.
  pronouns: z.string().optional(),
  relationship: z.enum([
    // 'self' is the household member's OWN Person note — the
    // biographical baseline every specialist reads to know who
    // they're working with (age, lifestyle, goals, location).
    // Added 2026-05-30 for the Slice A pilot (Astrid reading
    // Jasper's Person note for sedentary-40yo-gamer context).
    'self',
    'family',
    'friend',
    'colleague',
    'acquaintance',
    'service',
    // Someone in the PUBLIC record, not in the household's life — an elected
    // official, a candidate, an executive, an author (2026-07-29). Research
    // (Ruby's civic work, any specialist's deep_research) files person-shaped
    // notes for people the household will never contact; filing them as
    // `acquaintance` put a councilmember Jasper had never met into the personal
    // relationship graph, where the brief surfaced him as someone he knows.
    // EXCLUDED from every relationship surface via `is_non_contact` — the same
    // treatment genealogy ancestors get, for the same reason.
    'public_figure',
  ]),
  birthday: z
    .preprocess(coerce_ymd, z.string().regex(/^(\d{4}-)?\d{2}-\d{2}$/))
    .optional(),
  anniversaries: z
    .array(
      z.object({
        date: z.string(),
        what: z.string(),
        with: z.string().optional(),
      }),
    )
    .default([]),
  contact: z
    .object({
      email: z.array(z.string().email()).default([]),
      phone: z.array(z.string()).default([]),
      preferred_channel: z
        .enum(['email', 'sms', 'imessage', 'card', 'call'])
        .optional(),
      card_address: z.string().optional(),
    })
    .default({}),
  tone: z.enum(['warm', 'formal', 'playful', 'dry']).default('warm'),
  contact_cadence: z
    .enum(['weekly', 'monthly', 'quarterly', 'annually', 'event_only'])
    .optional(),
  last_contacted: z.string().optional(),
  sensitive: z.boolean().default(false),
  friday_managed: z.boolean().default(false),
  do_not_contact: z.boolean().default(false),
  gift_history: z
    .array(
      z.object({
        date: z.string(),
        what: z.string(),
        // Phase 3 (2026-06-20): structured amount + occasion, so the learned
        // per-person gift budget can be derived from past spend (never
        // hard-coded). Optional/additive — legacy entries lack them.
        cost: z.number().nonnegative().optional(),
        occasion: z.string().optional(),
        reception: z.string().optional(),
      }),
    )
    .default([]),
  // ── Phase 3 accretion (2026-06-20) ──────────────────────────────────────
  // What this person is into / avoids / wears — accreted from signals
  // (mentions, captures, purchases) so Kate's gift loop can draw real ideas.
  // Additive + optional; People stay household-stamped shared entities.
  likes: z.array(z.string()).default([]),
  dislikes: z.array(z.string()).default([]),
  sizes: z.record(z.string(), z.string()).optional(),
  // ── Relationship dossier (2026-06-22) — first-class so the Friends tab can
  // enter them as structured forms (not generic chips) and Kate's brief +
  // Anya (pets) + Brigid (dietary/hosting) can read them. All additive/optional.
  pets: z
    .array(
      z.object({
        name: z.string(),
        species: z.string().optional(),
        breed: z.string().optional(),
        notes: z.string().optional(),
      }),
    )
    .default([]),
  // Arbitrary dates to track beyond birthday/anniversary (surgery, new job,
  // graduation, a move) — surfaced ahead of Kate's briefs. `recurring` marks a
  // yearly one (vs a one-off future date).
  important_dates: z
    .array(
      z.object({
        date: z.string(), // YYYY-MM-DD or MM-DD
        what: z.string(),
        recurring: z.boolean().optional(),
      }),
    )
    .default([]),
  // People (and places) connected to this person — the relationship-and-role
  // graph (Phase 0, 2026-06-22). Two compatible shapes, both projected into
  // typed `relates-to` edges (src/core/person_relations.ts):
  //   - legacy/family:  { name, relation, birthday?, person_id? }
  //   - role/place tie: { to, to_kind, predicate, provenance, confidence?, … }
  //                     e.g. "Rosa is the hairdresser"; "works at Salon &
  //                     Studio" (to_kind: place). `provenance` is told|observed
  //                     |inferred so the owner can see what's stated vs guessed.
  // Permissive (all-optional + passthrough, coerce-don't-reject): a targetless
  // entry simply produces no edge. normalize_relation owns the semantics.
  relations: z
    .array(
      z
        .object({
          name: z.string().optional(),
          relation: z.string().optional(), // partner | child | parent | sibling | …
          birthday: z.string().optional(),
          person_id: z.string().optional(),
          to: z.string().optional(),
          to_kind: z.enum(['person', 'place']).optional(),
          predicate: z.string().optional(), // hairdresser | dentist | works at | my salon
          provenance: z.enum(['told', 'observed', 'inferred']).optional(),
          confidence: z.number().min(0).max(1).optional(),
          source_ref: z.string().optional(),
          asserted_by: z.string().optional(),
          asserted_at: z.string().optional(),
        })
        .passthrough(),
    )
    .default([]),
  // Dietary restrictions / allergies — drives what Brigid cooks when they visit.
  dietary: z.array(z.string()).default([]),
  how_we_met: z.string().optional(),
  // ── Spatial fields (Prompt 7.5) ─────────────────────────────────────────
  // Optional — backwards compatible. Kate fills these in when Jasper
  // mentions where someone lives, and the maps connector geocodes the
  // address on first resolve, caching the result back to the file.
  address: AddressValue.optional(),
  coords: z.tuple([z.number(), z.number()]).optional(),
  travel_notes: z.string().optional(),
  // Phase 2b — per-note visibility scope (see src/memory/private_to.ts).
  // Optional/unset preserves legacy broad visibility on existing notes.
  private_to: z.string().optional(),
})
  // Preserve open-ended biographical facts the specialists write (work,
  // commute, pets, …) instead of silently stripping them. A person note is the
  // user's own vault; losing structured facts the model bothered to record is
  // the worse failure. Typed fields above still validate; extras pass through.
  .passthrough();

export type Person = z.infer<typeof PersonFrontmatter>;
