/**
 * Per-note visibility scope (Phase 2b layer 3 — data filtering).
 *
 * Note frontmatter may carry a `private_to` field that constrains who
 * can see the note during RAG retrieval. The values:
 *
 *   - `undefined` / unset  — owner-only (fail-CLOSED, 2026-06-04). After
 *                            the backfill stamped the legacy population,
 *                            the unset default was flipped from
 *                            visible-to-everyone to owner-only: a writer
 *                            that forgets to stamp now hides its note
 *                            rather than leaking it to every user. The
 *                            residual unstamped files are system/no-type
 *                            (Trainer, memory.md), which are owner/system
 *                            context anyway.
 *
 *   - `'owner'`            — owner-tier callers only. Use for sensitive
 *                            captain-only state (finance, security)
 *                            written into shared specialist namespaces.
 *
 *   - `'household'`        — owner + household callers. Hides from
 *                            friends without naming each household
 *                            member individually.
 *
 *   - `<user_id>`          — that specific user only (e.g. `'sam'`,
 *                            `'caleb'`). Used by Brigid for Sam's diet
 *                            plan, Marguerite for Sam's family-tree
 *                            research, etc. Auto-stamped by Commit 4.
 *
 * A note may ALSO carry `shared_with: [<user_id>, …]` — an explicit,
 * per-note, named grant on top of the cordon (media sharing, 2026-07-29).
 * It never widens a tier: it names individual users, one note at a time,
 * and only the note's own owner can write it (see the share verb in
 * src/app/routes/media.ts).
 *
 * Architectural principle: this is the third layer of defense in the
 * Phase 2b stack:
 *   1. Hard refusal (`allowed_tiers`) — runtime never calls the LLM.
 *   2. Soft visibility (per-tier discretion block) — the LLM is told
 *      how to behave.
 *   3. Data filtering (this file) — even if the LLM misbehaves, the
 *      retrieved chunks were already filtered for the caller's scope.
 *
 * Each layer alone is insufficient; together they cover misuse,
 * jailbreaks, prompt injection from inbox content, and accidental
 * leaks from over-broad retrieval scopes.
 */

import type { Tier } from '@core/users';

export type PrivateToValue = 'owner' | 'household' | string;

export interface Caller {
  user_id: string | undefined;
  tier: Tier;
}

/**
 * Returns true if a caller of the given tier + user_id may see a note
 * with the given `private_to` value. Centralized so RAG retrieval,
 * direct-note-read tools, and the audit-redaction layer all agree on
 * the rules.
 *
 * This is a **pure cordon — the owner has NO blanket bypass.** A user's
 * personal note never bleeds into another user's default surfaces (RAG,
 * search, library, captures), not even the owner's. The rules:
 *
 *   - `private_to` unset: owner-only (fail-closed; the post-backfill
 *     default — a forgotten stamp hides the note rather than leaking it).
 *   - `private_to === 'owner'`: owner tier only (sensitive captain state).
 *   - `private_to === 'household'`: owner + household (the shared family
 *     graph); friends excluded.
 *   - `private_to === <user_id>`: visible only if caller.user_id matches,
 *     STRICTLY — even the owner does not see another user's personal note
 *     this way.
 *
 * The owner's "what has <user> been up to" reach is NOT here: it is the
 * explicit, audited `review_user_activity` oversight tool, which bypasses
 * the cordon for that one logged query. There is no passive cross-user
 * read anywhere in this function. Internal/system reads that legitimately
 * need to ignore scoping (e.g. Kristi's product-catalog shelf) use the
 * separate `bypass_private` flag on `retrieve_scoped_chunks`, not this.
 *
 * Caller with no `user_id` (deliberation / scheduler / internal HTTP)
 * sees only unset + tier-matched (`owner`/`household`) notes — never a
 * `<user_id>`-scoped personal note, which is the safe default for a
 * user-less system pass.
 *
 * `shared_with` (optional, media sharing 2026-07-29) is the note's
 * explicit named-grant list. A caller named in it sees the note even
 * though the cordon alone would hide it — that is the whole point of an
 * explicit share, and it is why this stays the ONE visibility function
 * (RAG, browse, item, stream all inherit it). The grant is per-user and
 * per-note: it never turns into a tier, never covers a sibling note, and
 * a user-less system caller can never match it. WHICH notes may acquire a
 * grant is a write-side policy decision (only the note's own owner, only
 * onto their own `private_to: <their id>` item — see the share verb in
 * src/app/routes/media.ts), deliberately not re-litigated here.
 */
export function note_visible_to_caller(
  private_to: string | undefined,
  caller: Caller,
  shared_with?: readonly string[],
): boolean {
  // An explicit named grant is authoritative — it is the owner of the note
  // saying "this one, this person". Checked first so the rule reads the way
  // it is meant: cordon OR named share.
  if (caller.user_id && shared_with && shared_with.includes(caller.user_id)) return true;

  // Fail-CLOSED (2026-06-04): an unstamped note resolves owner-only, not
  // visible-to-everyone. After the backfill stamped legacy notes, the only
  // remaining unstamped files are system/no-type (Trainer artifacts,
  // memory.md, scratch) which are owner/system context anyway. A writer
  // that forgets to stamp now hides its note (owner-only) instead of
  // leaking it to every user. User-less internal callers (deliberation,
  // scheduler) default to owner tier upstream, so they still see unstamped
  // system notes.
  if (!private_to) return caller.tier === 'owner';
  const value = private_to.trim();
  if (!value) return caller.tier === 'owner';

  if (value === 'owner') return caller.tier === 'owner';
  if (value === 'household') return caller.tier === 'owner' || caller.tier === 'household';

  // Treat as a user_id. Match strictly — Sam can't see Kim's notes, and
  // the owner can't see Sam's or Kim's through this path either.
  return value === caller.user_id;
}

/**
 * THE rule, applied to a note's own frontmatter: the `private_to` cordon OR an
 * explicit `shared_with` named grant, both parsed from the same object so the
 * two halves can never come from different reads of the note.
 *
 * Use this wherever a caller already holds a note's frontmatter (a live
 * `read_note`, a projected `frontmatter_json`). It exists because the rule was
 * drifting: three read paths called `note_visible_to_caller` with only
 * `private_to` while the RAG chunk gate passed `shared_with` too, so a grantee's
 * `search_library` returned a chunk from a shared item and the `read_note` that
 * followed answered "note not found… Try search_library" — pointed straight back
 * at the tool that produced the path. Fail-closed, but a loop: an item was
 * discoverable-but-unreadable by the very person it was shared with. One
 * function, one rule, no third spelling.
 *
 * Missing/unreadable frontmatter resolves exactly as an unstamped note does
 * (owner-only, fail-closed) — never wider.
 */
export function note_frontmatter_visible_to_caller(
  frontmatter: Record<string, unknown> | null | undefined,
  caller: Caller,
): boolean {
  return note_visible_to_caller(
    parse_private_to(frontmatter?.private_to),
    caller,
    parse_shared_with(frontmatter?.shared_with),
  );
}

/**
 * Parses a `private_to` value from frontmatter, returning the trimmed
 * string or `undefined` for unset/empty. Robust against the various
 * shapes YAML may emit (null, number, undefined, whitespace string).
 */
export function parse_private_to(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parses a `shared_with` value from frontmatter into a de-duplicated list
 * of user ids. Tolerant of every shape YAML/JSON may emit (absent, null, a
 * bare string, a list with blanks) because the field is hand-editable in
 * the vault — an unparseable value degrades to "no grants", never to a
 * wider grant.
 */
export function parse_shared_with(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const id = v.trim();
    if (id.length > 0 && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Caller-driven auto-stamp helper for vault writes. Returns the
 * frontmatter object with `private_to` set according to the caller's
 * tier and the note's `scope_hint`.
 *
 * Tool authors call this immediately before `MemoryClient.upsert_note`:
 *
 *   ```ts
 *   // a personal note (journal, receipt, capture):
 *   ctx.memory.upsert_note(path,
 *     stamp_private_to_if_needed({ type: 'journal_entry', ... }, ctx.user),
 *     body);
 *
 *   // a shared household entity (Person, Place):
 *   ctx.memory.upsert_note(path,
 *     stamp_private_to_if_needed({ type: 'person', ... }, ctx.user, 'shared_entity'),
 *     body);
 *   ```
 *
 * Behavior matrix (under the pure cordon — the owner is NOT exempt; an
 * unstamped note is visible to everyone, so the owner's personal notes
 * must be stamped too or they leak):
 *
 *   | caller.tier | scope_hint='personal' | scope_hint='shared_entity' |
 *   |-------------|-----------------------|----------------------------|
 *   | owner       | `private_to: <id>`    | `private_to: household`     |
 *   | household   | `private_to: <id>`    | `private_to: household`     |
 *   | friend      | `private_to: <id>`    | `private_to: <id>` (silo)   |
 *
 *   - frontmatter already has `private_to` → unchanged (explicit
 *     declarations win; an author may set a wider/narrower scope on
 *     purpose, e.g. `'owner'` for sensitive captain state).
 *   - caller absent OR caller.user_id absent → unchanged. System/internal
 *     writes (Trainer artifacts, scheduler passes) stay unscoped =
 *     owner-global by intent.
 *
 * `scope_hint` defaults to `'personal'` — the safe cordon default. Pass
 * `'shared_entity'` only for the communal household graph (People/Places),
 * so the family shares one contact list while a friend's entries silo to
 * themselves.
 */
export function stamp_private_to_if_needed(
  frontmatter: Record<string, unknown>,
  caller: Caller | undefined,
  scope_hint: 'personal' | 'shared_entity' = 'personal',
): Record<string, unknown> {
  if (!caller) return frontmatter;
  if (parse_private_to(frontmatter.private_to)) return frontmatter;
  if (!caller.user_id) return frontmatter;

  // Shared household entities are communal for owner + household; a
  // friend's entries still silo to the friend (they don't contribute to
  // the household graph).
  if (scope_hint === 'shared_entity' && caller.tier !== 'friend') {
    return { ...frontmatter, private_to: 'household' };
  }
  return { ...frontmatter, private_to: caller.user_id };
}
