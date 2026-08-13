/**
 * person_resolve — smart resolution of a person named in a string, for the
 * model-driven `who_is` lookup tool (2026-06-22).
 *
 * The model drives it: who_is is the ONE tool the model calls for any question
 * about a person ("when's Kim's flight", "what's Sam into", "who's Kim's
 * hairdresser"); this resolves the `name` arg GENEROUSLY so the model can pass a
 * bare "Kim" and still reach "Kim Reyes" — no flight numbers, no exact strings.
 *
 *   - GENEROUS — full name, preferred name, AND bare first name; case-insensitive;
 *     possessive-safe (\b so "Kim's" matches "Kim").
 *   - SALIENCE-ranked, NEVER skip-on-ambiguity — if a name matches several people,
 *     rank by tie-closeness + managed status and return the top; never bail. The
 *     original bug was REFUSING to resolve an obvious entity; that's the failure.
 *   - CORDONED — only people the caller can see (`visible_people`).
 *   - Deterministic, no LLM. (The model's intelligence is in DECIDING to call
 *     who_is + reading its result; resolution is a cheap, reliable match.)
 */
import type { MemoryClient, PersonRow, PersonLookup } from '@memory/client';
import { note_visible_to_caller, parse_private_to, type Caller } from '@memory/private_to';
import { parse_fm, is_non_contact } from '@core/relationship_signals';

function escape_re(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The visible, contact-eligible people for this caller (cordon + no self/genealogy). */
export function visible_people(memory: Pick<MemoryClient, 'query_people'>, caller: Caller): PersonRow[] {
  return memory
    .query_people({})
    .filter((p) => !is_non_contact(p))
    .filter((p) => note_visible_to_caller(parse_private_to(parse_fm(p.frontmatter_json).private_to), caller));
}

interface Scored {
  row: PersonRow;
  score: number;
}

/**
 * Resolve the people named in `text` — generous + salience-ranked, never
 * skip-on-ambiguity. A full-name hit scores highest; preferred name next; a bare
 * first name still counts (this is the point — "Kim" must resolve). Ties broken
 * toward closer relationships + managed contacts. Returns the top-N.
 */
export function resolve_mentioned_people(text: string, people: PersonRow[], max: number): PersonRow[] {
  const scored: Scored[] = [];
  for (const p of people) {
    const full = p.name.trim();
    const pref = (p.preferred_name ?? '').trim();
    const first = full.split(/\s+/)[0] ?? '';
    let score = 0;
    if (full && new RegExp(`\\b${escape_re(full)}\\b`, 'i').test(text)) score = 3;
    else if (pref && new RegExp(`\\b${escape_re(pref)}\\b`, 'i').test(text)) score = 2;
    else if (first.length >= 2 && new RegExp(`\\b${escape_re(first)}\\b`, 'i').test(text)) score = 1;
    if (score === 0) continue;
    // Salience tiebreak — closer ties + managed contacts surface first when a
    // common first name matches several people; never used to EXCLUDE a match.
    if (p.relationship === 'family' || p.relationship === 'friend') score += 0.5;
    if (p.friday_managed) score += 0.3;
    scored.push({ row: p, score });
  }
  scored.sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name));
  return scored.slice(0, max).map((s) => s.row);
}

/**
 * Resolve a person for a WRITE (find-or-create) — exact id/name first, then the
 * SAME smart resolver, so "Kim" lands on the existing "Kim Reyes" instead of
 * spawning a near-duplicate note. Returns the matched person, or null when there
 * is genuinely no match (the caller then creates). Cordon-filtered.
 *
 * This is what stops the duplicate-person class: every create path (find_or_create_
 * person / record_person_pref / upsert_person_note) routes its name through here
 * before minting a new note. Determinism lives INSIDE the tool the model called —
 * the model still decided to record about "Kim"; this just resolves WHO that is.
 */
export function resolve_person_for_write(
  memory: Pick<MemoryClient, 'query_people' | 'find_person'>,
  name_or_id: string,
  caller: Caller,
): PersonLookup | null {
  const s = (name_or_id ?? '').trim();
  if (!s) return null;
  const exact = /^p_[a-z0-9]{6}$/.test(s)
    ? memory.find_person({ id: s })
    : memory.find_person({ name: s });
  if (exact) return exact;
  const m = resolve_mentioned_people(s, visible_people(memory, caller), 1)[0];
  return m ? { id: m.id, note_path: m.note_path, frontmatter: parse_fm(m.frontmatter_json) } : null;
}
