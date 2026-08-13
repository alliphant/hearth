import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { PersonLookup } from '@memory/client';
import { PersonFrontmatter } from '@memory/schemas/person';
import { stamp_private_to_if_needed, type Caller } from '@memory/private_to';
import { resolve_person_for_write } from '@core/entity_hydration';
import { create_person, coerce_address, fold_contact_fields } from './_person_record';
import { recover_scalar_shapes } from '@core/scalar_recovery';

// The small model reliably GARBLES the discriminated-union identifier + the
// object `patch` — the live arg-spiral that lost Ceci's itinerary (2026-06-22):
// it sent identifier as the bare string "Ceci" or the stringified "{name: …}",
// patch as the string "{}", or omitted patch entirely → 3× INPUT_VALIDATION_FAILED.
// Coerce the shapes it actually emits rather than rejecting (the arg-spiral rule).
function lenient_obj(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    /* tolerate unquoted keys + single quotes: {name: 'Ceci'} / {name: "Ceci"} */
  }
  try {
    return JSON.parse(s.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":').replace(/'/g, '"'));
  } catch {
    return null;
  }
}
function coerce_identifier(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (s.startsWith('{')) {
    const o = lenient_obj(s);
    if (o && typeof o === 'object') return o;
  }
  return /^p_[a-z0-9]{6}$/.test(s) ? { id: s } : { name: s };
}
// The model also objectifies SCALAR person-fields inside the patch — a birthday
// as {year:1994,month:4,day:16}/{date:"1994-04-16"}, a relationship as
// {type:"friend"} — where PersonFrontmatter wants a string (YYYY-MM-DD/MM-DD)
// or the relationship enum. Unfixed, the merged patch fails the record schema,
// the model re-sends the identical object, and the turn dies on
// DUPLICATE_TOOL_CALL (the live 2026-06-22 Ceci spiral while saving her
// birthday/address — 4 turns, every one "couldn't get my tool calls to land").
//
// `recover_scalar_shapes` is the SHARED, schema-driven primitive — NOT a
// per-field carve-out: it walks PersonFrontmatter to each failing field and
// extracts type-aware (a date string assembles, the relationship enum option
// matches), so ANY scalar field the model objectifies is recovered, current and
// future, under the invariant that a STRUCTURED field is never blind-stringified
// into garbage. An unrecognizable shape falls through to the honest schema error
// in execute(). The SAME primitive runs at the registry boundary for every other
// tool; see [scalar_recovery.ts](src/core/scalar_recovery.ts).
export function coerce_patch(v: unknown): Record<string, unknown> {
  // Container parsing first — the model emits the patch as a stringified object
  // ("{}" / "{work: 'HP'}") or an object; normalize to a plain record.
  let obj: Record<string, unknown> = {};
  if (v !== undefined && v !== null) {
    if (typeof v === 'string') {
      const s = v.trim();
      if (s && s !== '{}') {
        const o = lenient_obj(s);
        if (o && typeof o === 'object') obj = o as Record<string, unknown>;
      }
    } else if (typeof v === 'object') {
      obj = v as Record<string, unknown>;
    }
  }
  // Then schema-driven scalar recovery (the general mechanism that replaced the
  // birthday/relationship carve-out). Validates against the destination record's
  // schema and extracts each objectified scalar by its leaf type.
  const { value, changes } = recover_scalar_shapes(PersonFrontmatter, obj);
  const out = value as Record<string, unknown>;
  // address is a union(string|object), not a pure scalar the recovery flattens —
  // flatten the nested {street:{value:…}} / {value:…} shape the model emits to a
  // clean string here, else a malformed known field breaks the note's projection.
  if ('address' in out) out.address = coerce_address(out.address) ?? out.address;
  // Fold flat email/phone/preferred_channel (the model emits them top-level) under
  // `contact`, else they land as junk passthrough and the Friends card shows nothing.
  fold_contact_fields(out);
  if (changes.length > 0) {
    console.warn(`[tool-recovery] upsert_person_note patch: ${changes.join('; ')}`);
  }
  return out;
}

// NOTE: no `.regex()` on `id` — a tool input_schema becomes a GBNF grammar on
// the interactive 9B, and llama.cpp's converter mistranslates a regex `pattern`
// and SILENTLY disables the whole tool grammar. The id is only a lookup key:
// a malformed id finds no person and execute() throws a clean "Person not
// found" error, which is better guidance than an opaque union-validation dump.
const Identifier = z.preprocess(
  coerce_identifier,
  z.union([
    z.object({ id: z.string().min(1) }),
    z.object({ name: z.string().min(1) }),
  ]),
);

/**
 * The model frequently emits `body_append` as a structured object (e.g.
 * `{ address: '...' }`) rather than a markdown string — the live audit error
 * `body_append: expected string, received object`, which it then re-sent
 * verbatim until DUPLICATE_TOOL_CALL killed the turn (the 2026-06-01 address
 * loop). Rather than reject a semantically-fine append, coerce any non-string
 * into a readable markdown block. The note body is the honest landing place
 * for it; the human can always see what was appended.
 */
function coerce_body_append(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v.map((x) => (typeof x === 'string' ? x : coerce_body_append(x))).join('\n');
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    const all_scalar = entries.every(
      ([, val]) => val === null || ['string', 'number', 'boolean'].includes(typeof val),
    );
    if (all_scalar) return entries.map(([k, val]) => `- **${k}**: ${val ?? ''}`).join('\n');
    return '```json\n' + JSON.stringify(v, null, 2) + '\n```';
  }
  return String(v);
}

/**
 * An IDEMPOTENT named body section (2026-07-29) — the alternative to
 * `body_append` for a writer that re-runs over the same person and would
 * otherwise accumulate near-duplicates. Every prior section whose heading line
 * begins with `heading` is removed before the new one is written, so N runs
 * leave exactly ONE section and a note that already accreted several collapses
 * on the next write.
 *
 * Chris Barrett's note held FOUR "## Deep research (…)" sections repeating the
 * same four facts, because each research pass appended blindly. `body_append`
 * stays the right tool for a human's or a distiller's genuinely-additive line;
 * a periodic regenerated block wants this.
 */
const BodySection = z.object({
  heading: z
    .string()
    .min(3)
    .max(120)
    .describe(
      'The section heading INCLUDING its markdown hashes, e.g. "## Deep research". ' +
        'Matched as a PREFIX of the heading line, so a dated variant ' +
        '("## Deep research (2026-07-29)") replaces the previous dated one.',
    ),
  /** Heading suffix appended after `heading` on the written line (e.g. a date). */
  heading_suffix: z.string().max(120).optional(),
  body: z.string().min(1).max(20_000),
});

const InputSchema = z.object({
  identifier: Identifier,
  patch: z.preprocess(coerce_patch, z.record(z.string(), z.unknown())).default({}),
  body_append: z.preprocess(
    (v) => (v === undefined || v === null ? undefined : coerce_body_append(v)),
    z.string().optional(),
  ),
  body_section: BodySection.optional(),
});

/**
 * Drop every markdown section whose heading line starts with `heading`, up to
 * the next heading of the SAME OR SHALLOWER depth (so a `###` subsection inside
 * a replaced `##` block goes with it). Pure; returns the surviving body.
 */
export function strip_body_sections(body: string, heading: string): string {
  const depth = /^(#+)/.exec(heading.trim())?.[1]?.length ?? 2;
  const lines = body.split('\n');
  const out: string[] = [];
  let dropping = false;
  for (const line of lines) {
    const h = /^(#+)\s/.exec(line);
    if (h) {
      const line_depth = h[1]!.length;
      if (line.startsWith(heading)) {
        dropping = true;
        continue;
      }
      // A heading at the same or shallower depth ends the dropped block; a
      // deeper one belongs to it.
      if (dropping && line_depth <= depth) dropping = false;
    }
    if (!dropping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

const OutputSchema = z.object({
  id: z.string(),
  note_path: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export const upsert_person_note: Tool<Input, Output> = {
  name: 'upsert_person_note',
  description:
    'Add or update a CONTACT in ONE call: patches frontmatter (and optionally appends body text) on a person under People/, CREATING the record when the name is new — no need to call find_or_create_person first. This is the tool for adding any person to the contacts (a friend, colleague, or a service contact you just met — plumber, contractor, realtor, doctor) and recording their relationship, employer, work address, phone, birthday, or gift ideas. A person who works at a business, or whose only address is a workplace, is still a contact: record them HERE, not as a Place (upsert_place is for a venue/destination you visit, not a person who works there). Identify by { name } (preferred — creates if missing) or { id }.',
  risk: 'write_internal',
  // Specialist invocation path requires the capability; Scribe's
  // /scribe/* HTTP route bypasses the registry and ignores this field.
  required_capabilities: ['write_vault_general'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256');
    const id_key =
      'id' in input.identifier
        ? `id:${input.identifier.id}`
        : `name:${input.identifier.name.toLowerCase().trim()}`;
    h.update(id_key);
    h.update('\n');
    h.update(JSON.stringify(input.patch));
    h.update('\n');
    h.update(input.body_append ?? '');
    h.update('\n');
    h.update(input.body_section ? JSON.stringify(input.body_section) : '');
    return `upsert_person_note:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx): Promise<Output> {
    // A { name } resolves SMARTLY (exact, then the salient existing person) so a
    // bare "Kim" updates "Kim Reyes" instead of creating a duplicate; an
    // explicit { id } stays exact. Create only when there's genuinely no match.
    const caller: Caller = { user_id: ctx.user?.id, tier: (ctx.user?.tier ?? 'friend') as Caller['tier'] };
    let lookup: PersonLookup | null =
      'id' in input.identifier
        ? ctx.memory.find_person({ id: input.identifier.id })
        : resolve_person_for_write(ctx.memory, input.identifier.name, caller);

    // Create-or-update: a never-seen NAME is created in the SAME call rather
    // than thrown back for a find_or_create_person two-step the small model
    // can't reliably do (the live "Dr. Alba Moreno" arg-spiral died exactly
    // there → retry → DUPLICATE_TOOL_CALL). A bare { id } can't seed a record
    // (no name to file under) — that stays a clean, actionable error.
    if (!lookup) {
      if ('id' in input.identifier) {
        throw new Error(
          `Person not found for id ${input.identifier.id}, and an id alone can't ` +
            `create a new record. Re-call with { name: "<their name>" } to ` +
            `create-or-update, or use a valid existing id.`,
        );
      }
      // A relationship hint in the patch seeds the new record's frontmatter.
      const rel =
        typeof input.patch.relationship === 'string' ? input.patch.relationship : undefined;
      const created = create_person(ctx, input.identifier.name, rel);
      // Use the just-written frontmatter directly — find_person reads the
      // filesystem synchronously so a read-back would also work, but the helper
      // already hands us the exact record, no second scan needed.
      lookup = {
        id: created.id,
        note_path: created.note_path,
        frontmatter: created.frontmatter,
      };
    }

    // Phase 2b/4 — frontmatter merge preserves the existing `private_to`
    // stamp set by find_or_create_person. Sam patching Alex's birthday
    // doesn't change the visibility scope of Alex's note; the first
    // writer's discretion stands. No auto-stamp needed here.
    const merged = { ...lookup.frontmatter, ...input.patch };
    const parsed = PersonFrontmatter.safeParse(merged);
    if (!parsed.success) {
      // Return an ACTIONABLE recovery hint, not the raw ZodError dump. The
      // bare dump is opaque, so the model re-sent the identical call and the
      // runtime killed it with DUPLICATE_TOOL_CALL — the loop that lost the
      // 2026-06-01 address correction. Name each bad field + the accepted
      // shapes so the next call differs.
      const issues = parsed.error.issues
        .map((i) => `\`${i.path.join('.') || '(root)'}\`: ${i.message}`)
        .join('; ');
      throw new Error(
        `Patch didn't fit the person-record schema: ${issues}. ` +
          'Accepted shapes: `address` may be a plain string OR an object ' +
          '(street/city/state/zip/community); `birthday` must be YYYY-MM-DD ' +
          'or MM-DD; other biographical facts (work, commute, pets, …) are ' +
          'kept as written. Re-call with the corrected field(s) — do NOT ' +
          'resend the same arguments.',
      );
    }
    const validated = parsed.data;

    // A Person is a shared household entity. The merge above preserves any
    // existing `private_to` (explicit scope wins in the helper); a legacy
    // person note with no scope gets stamped `household` so it stops being
    // friend-visible. Friend callers silo their own contacts.
    const stamped = stamp_private_to_if_needed(
      validated as unknown as Record<string, unknown>,
      ctx.user ? { user_id: ctx.user.id, tier: ctx.user.tier } : undefined,
      'shared_entity',
    );

    // An idempotent section rewrites the body in the SAME write as the
    // frontmatter (upsert_note treats an empty body as "keep what's there", so
    // the plain path is unchanged). Reconcile-then-write, never append.
    let next_body = '';
    if (input.body_section) {
      const { heading, heading_suffix, body } = input.body_section;
      const existing = ctx.memory.read_note(lookup.note_path)?.body ?? '';
      const kept = strip_body_sections(existing, heading);
      const heading_line = heading_suffix ? `${heading} ${heading_suffix}` : heading;
      next_body = `${kept ? `${kept}\n\n` : ''}${heading_line}\n\n${body.trim()}\n`;
    }

    ctx.memory.upsert_note(lookup.note_path, stamped, next_body);

    if (input.body_append !== undefined && input.body_append.length > 0) {
      ctx.memory.append_to_note(lookup.note_path, input.body_append);
    }

    return { id: lookup.id, note_path: lookup.note_path };
  },
};
