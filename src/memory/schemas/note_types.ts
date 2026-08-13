/**
 * note_types — the ONE registry of frontmatter `type:` values the vault
 * contract recognizes, shared by the WRITE side (MemoryClient.upsert_note)
 * and the PROJECTION side (apps/ingestor/project.ts).
 *
 * Why this exists (2026-06-09): the two sides had drifted into a contract
 * break. Specialist intake tools wrote perfectly legitimate domain notes
 * (`pet_record`, `receipt`, `trainer_profile`, `marketplace_item`, …) that
 * the ingestor had never heard of — so it filed an `unknown frontmatter
 * type` validation_failed audit row for each, EVERY projection pass:
 * 2,501 audit rows in one week from 36 notes, drowning the audit trail
 * the meta-loop scans read. The write layer accepted what the projection
 * layer rejected, and nothing owned the list.
 *
 * Three tiers:
 *
 *   - PROJECTED_NOTE_TYPES — have a Zod schema + a SQLite table; the
 *     ingestor validates and projects them. Adding one means adding a
 *     schema in src/memory/schemas/ + a projector in project.ts.
 *
 *   - AUXILIARY_NOTE_TYPES — legitimate vault notes owned and read by
 *     their specialist's own tools (Astrid's trainer_profile, Anya's
 *     pet_record, Kate's mail intake, …). NOT structured-projected; the
 *     ingestor skips them SILENTLY, exactly like a note with no `type`
 *     at all. Promote one to PROJECTED when a workflow needs structured
 *     queries over it.
 *
 *   - anything else — a contract violation worth ONE audit row (the
 *     write side warns once per path; the ingestor logs once per
 *     content-hash), after which it's a registry decision, not noise.
 */

export const PROJECTED_NOTE_TYPES = [
  'person',
  'journal_entry',
  'decision',
  'clipping',
  'place',
  'household_good', // Household Knowledge Graph node (2026-06-20) — projected to household_goods for date-scans
  'household_service', // Services & Bills ledger node (2026-07-04) — projected to household_services for due-window scans + triage grounding
  'life_event', // Calendar Knowledge Graph node (Phase 3, 2026-06-20) — projected to life_events for date-scan triggers (birthday/vacation/appointment)
  'media_item', // Media Archive node (2026-07-11) — projected to media_items for browse/search of downloaded media
] as const;

export const AUXILIARY_NOTE_TYPES = [
  'animal',
  'audit_finding',
  'book_candidate',
  'food_capture',
  'genealogy_import',
  'house_cadence', // Luna's forward maintenance calendar (Knowledge/Luna/maintenance-cadence.md)
  'house_inventory', // Luna's home-systems registry (Knowledge/Luna/home-systems-inventory.md)
  'household',
  'knowledge',
  'mail',
  'marketplace_item',
  'person_tracker',
  'pet_record',
  'receipt',
  'reference',
  'service_mode_export', // Kate's owner-only service-mode reveals (Knowledge/Kate/service-mode/<part>.md) — her REAL loaded persona/prompt/config/yaml exported for the owner; private_to the owner, deliberately unprojected
  'synthesis_note', // Cordelia's distilled evergreen shelf syntheses (Knowledge/<Target>/library/_synthesis/) — searchable via chunks_fts, deliberately unprojected so a re-synthesis never re-ingests its own output
  'trainer_pr_shelf', // Astrid (fitness trainer) PR shelf — not Beatrice
  'trainer_profile',
  'user_profile', // Kate-written per-user profile/seed (users/<id>/profile.md, users/<id>/<specialist>/profile.md) — onboarding facets narrative, private_to the user, deliberately unprojected
] as const;

export type ProjectedNoteType = (typeof PROJECTED_NOTE_TYPES)[number];
export type AuxiliaryNoteType = (typeof AUXILIARY_NOTE_TYPES)[number];

const PROJECTED_SET: ReadonlySet<string> = new Set(PROJECTED_NOTE_TYPES);
const AUXILIARY_SET: ReadonlySet<string> = new Set(AUXILIARY_NOTE_TYPES);

export function is_projected_note_type(t: unknown): t is ProjectedNoteType {
  return typeof t === 'string' && PROJECTED_SET.has(t);
}

export function is_auxiliary_note_type(t: unknown): t is AuxiliaryNoteType {
  return typeof t === 'string' && AUXILIARY_SET.has(t);
}

export function is_known_note_type(t: unknown): boolean {
  return is_projected_note_type(t) || is_auxiliary_note_type(t);
}

/** For warnings/recovery hints — the full sorted contract, readable. */
export function known_note_types(): string[] {
  return [...PROJECTED_NOTE_TYPES, ...AUXILIARY_NOTE_TYPES].sort();
}
