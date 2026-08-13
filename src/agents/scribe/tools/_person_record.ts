import { randomBytes } from 'node:crypto';
import type { ToolContext } from '@core/tool';
import { PersonFrontmatter } from '@memory/schemas/person';
import { stamp_private_to_if_needed } from '@memory/private_to';

/**
 * The ONE creation path for a Person note, shared by find_or_create_person
 * and upsert_person_note's create-or-update branch. Extracting it keeps the
 * id-generation, filename-sanitization, frontmatter shape, and the
 * shared-household `private_to` stamp identical across both callers — so a
 * person created mid-upsert is byte-for-byte what find_or_create_person would
 * have produced. (Before this, upsert THREW "Person not found — call
 * find_or_create_person first," a two-step the small model can't reliably do:
 * the live "Dr. Alba Moreno" arg-spiral died exactly there → DUPLICATE_TOOL_CALL.)
 */

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function generate_person_id(): string {
  const bytes = randomBytes(6);
  let id = '';
  for (const b of bytes) id += ID_ALPHABET[b % 36];
  return `p_${id}`;
}

export function sanitize_filename(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return cleaned || 'unnamed';
}

/**
 * Coerce ANY address shape the small model emits into a clean flat STRING, so a
 * known typed field is never stored malformed. A malformed `address` (e.g. the
 * nested `{street:{value:…},city:{value:…}}` the 9B produced) fails
 * PersonFrontmatter validation, so the ingestor can't project the note and the
 * Friends card freezes on stale data — the 2026-06-23 Casey bug. Handles a
 * plain string, a stringified-JSON object, a `{value:…}` wrapper, and a nested
 * structured address. Returns undefined when there's nothing usable (the caller
 * then leaves the original so the schema can reject it honestly).
 */
export function coerce_address(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return undefined;
    if (s.startsWith('{') || s.startsWith('[')) {
      try {
        return coerce_address(JSON.parse(s));
      } catch {
        return s; // a normal free-text address that happens to start oddly
      }
    }
    return s;
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const unwrap = (x: unknown): unknown =>
      x && typeof x === 'object' && 'value' in (x as Record<string, unknown>)
        ? (x as Record<string, unknown>).value
        : x;
    if ('value' in o && Object.keys(o).length === 1) return coerce_address(o.value);
    const scalar = (val: unknown): string | null =>
      typeof val === 'string' && val.trim() ? val.trim() : typeof val === 'number' ? String(val) : null;
    // Structured address parts in postal order (each possibly {value:…}).
    const order = ['street', 'street2', 'line1', 'line2', 'city', 'state', 'province', 'zip', 'postal_code', 'country', 'community'];
    const parts: string[] = [];
    for (const key of order) {
      if (key in o) {
        const s = scalar(unwrap(o[key]));
        if (s) parts.push(s);
      }
    }
    if (parts.length) return parts.join(', ');
    // Fallback: any scalar (or {value:scalar}) values in insertion order.
    const rest: string[] = [];
    for (const val of Object.values(o)) {
      const s = scalar(unwrap(val));
      if (s) rest.push(s);
    }
    if (rest.length) return rest.join(', ');
  }
  return undefined;
}

// ── shared model-garble coercion for person writes ───────────────────────────
// The 9B emits list fields as a single value or a `{value:…}` wrapper, and emits
// CONTACT fields FLAT (top-level `email`/`phone`) where the canonical shape nests
// them under `contact`. These helpers are the ONE place both person writers
// (record_person_pref + upsert_person_note) normalize that, so every field lands
// correctly no matter which tool the model picks.

/** Strip a single-key `{value: X}` wrapper, else return the value untouched. */
export function unwrap_value(x: unknown): unknown {
  return x !== null &&
    typeof x === 'object' &&
    !Array.isArray(x) &&
    'value' in (x as Record<string, unknown>) &&
    Object.keys(x as object).length === 1
    ? (x as Record<string, unknown>).value
    : x;
}
/** Coerce → array of strings: `"x"` / `{value:"x"}` / `["x"]` / `[{value:"x"}]` → `["x"]`. */
export function to_str_array(v: unknown): unknown {
  if (v == null) return v;
  const x = unwrap_value(v);
  const arr = Array.isArray(x) ? x : [x];
  return arr.map(unwrap_value); // non-strings fall through to an honest schema error
}
/** Coerce → array of objects: a single object / `{value:obj}` / array → `[obj]`. */
export function to_obj_array(v: unknown): unknown {
  if (v == null) return v;
  const x = unwrap_value(v);
  return Array.isArray(x) ? x : [x];
}
/**
 * Fold FLAT contact fields the model emits — top-level `email` / `phone` /
 * `preferred_channel` (the natural shape, and record_person_pref's slots) — under
 * `contact`, coerced to arrays. Without this the 9B's `upsert_person_note` patch
 * lands them as junk passthrough fields while `contact.email` stays `[]`, so the
 * Friends card shows nothing (the 2026-06-23 email/phone bug). Mutates `patch`.
 */
export function fold_contact_fields(patch: Record<string, unknown>): void {
  const has = (k: string): boolean => k in patch && patch[k] != null;
  if (!has('email') && !has('phone') && !has('preferred_channel')) return;
  const contact: Record<string, unknown> =
    patch.contact && typeof patch.contact === 'object'
      ? { ...(patch.contact as Record<string, unknown>) }
      : {};
  if (has('email')) contact.email = to_str_array(patch.email);
  if (has('phone')) contact.phone = to_str_array(patch.phone);
  if (has('preferred_channel')) {
    const c = unwrap_value(patch.preferred_channel);
    if (typeof c === 'string') contact.preferred_channel = c;
  }
  delete patch.email;
  delete patch.phone;
  delete patch.preferred_channel;
  patch.contact = contact;
}

export const ALLOWED_RELATIONSHIPS = new Set([
  'self',
  'family',
  'friend',
  'colleague',
  'acquaintance',
  'service',
  // Not a relationship — a person in the public record (see person.ts). The
  // research writeback seeds it so an official never defaults to
  // `acquaintance`, which is what put a councilmember in the contact graph.
  'public_figure',
]);

export interface CreatedPerson {
  id: string;
  note_path: string;
  /** The frontmatter that was written — lets a caller skip a read-back. */
  frontmatter: Record<string, unknown>;
  created: true;
}

/**
 * Create a minimal Person note under `People/<name>.md`, stamped as a shared
 * household entity. Callers MUST look up an existing record first — this always
 * creates. `relationship_hint` seeds the record when it's one of the allowed
 * values (else 'acquaintance').
 */
export function create_person(
  ctx: ToolContext,
  name: string,
  relationship_hint?: string,
): CreatedPerson {
  const id = generate_person_id();
  const note_path = `People/${sanitize_filename(name)}.md`;

  const relationship =
    relationship_hint && ALLOWED_RELATIONSHIPS.has(relationship_hint)
      ? relationship_hint
      : 'acquaintance';

  const fm = PersonFrontmatter.parse({
    type: 'person',
    id,
    name,
    relationship,
    friday_managed: false,
  });

  // A Person is a SHARED household entity: the family keeps one contact graph,
  // so owner/household writes stamp `private_to: household`. A FRIEND's contacts
  // silo to the friend — `stamp_private_to_if_needed` derives that from the tier.
  const stamped = stamp_private_to_if_needed(
    fm as unknown as Record<string, unknown>,
    ctx.user ? { user_id: ctx.user.id, tier: ctx.user.tier } : undefined,
    'shared_entity',
  );

  ctx.memory.upsert_note(note_path, stamped, '');

  return { id, note_path, frontmatter: stamped, created: true };
}
