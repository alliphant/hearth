/**
 * research_identity — is this source actually ABOUT the subject?
 * (Deep Research v2, name anchoring — 2026-07-30.)
 *
 * The failure. The owner asked Kate to research a friend, "Josie Kim Reyes".
 * The dossier came back a confident professional biography: Project Manager II
 * at CLEANFLEET, Director of the Triangle Clean Cities Coalition, degrees from
 * Campbell University and Gardner-Webb, an MIT certificate. Every sentence was
 * true, correctly cited, and about a COMPLETELY DIFFERENT WOMAN. It then wrote
 * that stranger's career into the friend's People note.
 *
 * The mechanism, visible only because v2 phase 1 persisted the source bodies:
 * across all FOURTEEN sources the investigation read, the string "Josie Kim
 * Reyes" appeared **zero times**. The name had fragmented. Six sources
 * matched "Josie" with no "Reyes" anywhere in them (a CLEANFLEET staff page, an
 * OpenAI employee's LinkedIn, a New York lawyer, a healthcare board member);
 * the rest matched "Reyes" with no "Josie" (surname genealogy tables, a barrel
 * racer named Katie Jo Reyes). Search engines happily drop tokens from a
 * three-part name, and NOTHING in the pipeline ever required a source to
 * mention the person it was being used to describe.
 *
 * Why the existing guards all passed:
 *   - the coverage ledger correctly said "1 of 5 facets answered" — but
 *     coverage is orthogonal to identity, and a facet answered from the wrong
 *     person still reads `answered`;
 *   - `verify_investigation` is self-referential (claims_checked: 8,
 *     verdicts: []) — the known phase-3 gap;
 *   - `identity_conflicts` only fires on explicit LOCATION phrasing ("lists her
 *     location as …"). A staff bio reading "Josie Kim is Project Manager II"
 *     trips nothing, so the person-note writeback gate let it through.
 *
 * The check this module adds is the cheapest possible one and it needs no LLM,
 * no evidence corpus and no judgement: **if the subject's name does not appear
 * in the source, the source is not about the subject.** That was unknowable
 * before the bodies were on disk; now it is a string search.
 *
 * It is deliberately a NECESSARY condition, not a sufficient one — passing it
 * means "this page at least names this person", not "this page is about the
 * right person of that name". A genealogy table listing some other, long-dead
 * "Josie Reyes" still passes here; separating same-NAME from same-PERSON is
 * the identity-anchor phase (design §3.3) and wants attributes, not strings.
 * This module's job is the blatant class — the fragment match — which is what
 * actually shipped a stranger's biography.
 *
 * Everything here is PURE, so the smoke pins it against the real bodies from
 * the investigation that failed.
 */

/** Name tokens too generic to carry identity on their own. */
const NAME_NOISE = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'professor', 'sir', 'dame',
  'jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md', 'esq', 'the',
]);

/**
 * Characters apart that two name tokens may sit and still read as one name.
 * Wide enough for "Reyes, Josie Kim" and "Josie L. Reyes", far too narrow
 * for a surname in a genealogy table and a stray "Josie" 400 lines away.
 */
const PROXIMITY_CHARS = 60;

export function name_anchor_enabled(): boolean {
  return process.env.HEARTH_RESEARCH_NAME_ANCHOR !== '0';
}

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function normalize_for_match(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SubjectName {
  /** All meaningful tokens, in order. */
  tokens: string[];
  /** Last meaningful token — the one a source about a person almost always
   *  carries, and the one search engines drop first when it is rare. */
  surname: string | null;
  /** Everything before the surname. */
  others: string[];
}

/** Split a subject string into matchable name parts. */
export function subject_name(subject: string): SubjectName {
  const tokens = normalize_for_match(subject)
    .split(' ')
    .filter((t) => t.length >= 2 && !NAME_NOISE.has(t));
  if (tokens.length === 0) return { tokens: [], surname: null, others: [] };
  const surname = tokens[tokens.length - 1]!;
  return { tokens, surname, others: tokens.slice(0, -1) };
}

/** Every index at which `needle` occurs in `haystack` (both normalized). */
function occurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
}

/** Whole-word occurrences, so "kim" does not match inside "sleeve". */
function word_occurrences(haystack: string, needle: string): number[] {
  // haystack is normalized to space-separated words, so a match is a whole word
  // when both neighbours are a space or a boundary.
  return occurrences(haystack, needle).filter((i) => {
    const before = i === 0 ? ' ' : haystack[i - 1]!;
    const after_idx = i + needle.length;
    const after = after_idx >= haystack.length ? ' ' : haystack[after_idx]!;
    return before === ' ' && after === ' ';
  });
}

export interface MentionVerdict {
  /** Does the source name the subject at all? */
  mentions: boolean;
  /** How it matched — for the audit trail and the reader. */
  basis:
    | 'full_name'
    | 'surname_with_given_nearby'
    | 'single_token_subject'
    | 'no_surname_match'
    | 'surname_without_given_name'
    | 'no_match'
    | 'skipped';
  /** Human-readable reason, surfaced verbatim when a source is dropped. */
  reason: string;
  /** Diagnostic counts (also what the smoke asserts on). */
  surname_hits: number;
  other_hits: number;
}

/**
 * Does `body` actually name `subject`?
 *
 * The rule, in order:
 *   1. the full name appearing verbatim is an immediate pass;
 *   2. otherwise the SURNAME must appear, and at least one given-name token
 *      must appear WITHIN `PROXIMITY_CHARS` of one of those surname hits —
 *      which is what separates "Josie Reyes" from a page that says "Reyes"
 *      1,236 times and "Josie" once, unrelatedly;
 *   3. a single-token subject can only be checked for that token.
 *
 * Proximity is the load-bearing part. Requiring both tokens ANYWHERE in the
 * document would have passed the genealogy tables that helped sink the
 * investigation this exists for.
 */
export function source_mentions_subject(body: string, subject: string): MentionVerdict {
  const name = subject_name(subject);
  const hay = normalize_for_match(body);

  if (name.tokens.length === 0 || hay.length === 0) {
    return {
      mentions: true, // nothing to check against — never drop on our own gap
      basis: 'skipped',
      reason: 'no usable subject name or empty body — check skipped (fail-open)',
      surname_hits: 0,
      other_hits: 0,
    };
  }

  // 1. verbatim full name
  const full = name.tokens.join(' ');
  if (name.tokens.length > 1 && hay.includes(full)) {
    return {
      mentions: true,
      basis: 'full_name',
      reason: `names "${subject}" in full`,
      surname_hits: word_occurrences(hay, name.surname!).length,
      other_hits: 0,
    };
  }

  const surname_at = word_occurrences(hay, name.surname!);

  // 3. single-token subject — the token IS the whole test
  if (name.others.length === 0) {
    return surname_at.length > 0
      ? {
          mentions: true,
          basis: 'single_token_subject',
          reason: `names "${name.surname}"`,
          surname_hits: surname_at.length,
          other_hits: 0,
        }
      : {
          mentions: false,
          basis: 'no_match',
          reason: `never mentions "${name.surname}"`,
          surname_hits: 0,
          other_hits: 0,
        };
  }

  const other_hits = name.others.reduce((n, t) => n + word_occurrences(hay, t).length, 0);

  if (surname_at.length === 0) {
    return {
      mentions: false,
      basis: 'no_surname_match',
      reason:
        `never mentions the surname "${name.surname}" (the other name part(s) appear ` +
        `${other_hits} time(s), which is a partial-name match on a different person, ` +
        `not a match on the subject)`,
      surname_hits: 0,
      other_hits,
    };
  }

  // 2. surname + a given name close enough to read as one name
  for (const at of surname_at) {
    const lo = Math.max(0, at - PROXIMITY_CHARS);
    const hi = Math.min(hay.length, at + name.surname!.length + PROXIMITY_CHARS);
    const window = hay.slice(lo, hi);
    for (const other of name.others) {
      if (word_occurrences(window, other).length > 0) {
        return {
          mentions: true,
          basis: 'surname_with_given_nearby',
          reason: `names "${other} … ${name.surname}" together`,
          surname_hits: surname_at.length,
          other_hits,
        };
      }
    }
  }

  return {
    mentions: false,
    basis: 'surname_without_given_name',
    reason:
      `mentions "${name.surname}" ${surname_at.length} time(s) but never next to ` +
      `${name.others.map((o) => `"${o}"`).join(' or ')} — a surname-only match ` +
      `(a family/namesake listing), not this person`,
    surname_hits: surname_at.length,
    other_hits,
  };
}

/**
 * Should the name gate run for this subject at all?
 *
 * PERSON subjects only — the caller passes person-ness (the runner uses
 * PERSON_SUBJECT_KINDS, so `public_figure` is covered too; a public figure with
 * a common name is precisely the same-name-conflation risk). This module stays
 * free of store imports so it can be unit-tested as a pure function.
 *
 * A product or place is routinely written about by description ("Hyundai's
 * electric SUV") without ever spelling out the queried name, so gating those
 * would drop good sources. Also needs ≥2 name tokens: a mononym has no surname
 * to anchor on and the check degrades to a single-token search that a common
 * word would pass anyway.
 */
export function name_anchor_applies(is_person_subject: boolean, subject: string): boolean {
  if (!name_anchor_enabled()) return false;
  if (!is_person_subject) return false;
  return subject_name(subject).tokens.length >= 2;
}

/* ==================================================================== */
/* Identity ANCHOR — same name is not same person (design §3.3)          */
/* ==================================================================== */

/**
 * The name gate above is a NECESSARY condition and says so. This is the
 * sufficient half, and it is the difference between the two live failures:
 *
 *   - "Josie Kim Reyes" failed the name gate — no source named her at all.
 *   - "Daniel Torres" is a common name. Sources DO name him. The Spokeo page
 *     names 412 of him, in Virginia, while the subject lives in Georgetown,
 *     Texas. A name gate passes that page; only an attribute check refuses it.
 *
 * An anchor is the set of distinguishing attributes we believe about the
 * subject. The highest-quality ones come from the OWNER (`known_facts` on
 * `deep_research` — "she works at BrightCase", "he lives in Georgetown TX"),
 * which is why they need no LLM and no search: the owner already knows.
 *
 * Everything here stays PURE, so the smoke pins it against the real persisted
 * bodies from both failed investigations.
 */

/** US states — the one geographic table, shared with research_jurisdiction. */
export const US_STATES: ReadonlyArray<readonly [string, string]> = [
  ['alabama', 'AL'], ['alaska', 'AK'], ['arizona', 'AZ'], ['arkansas', 'AR'],
  ['california', 'CA'], ['colorado', 'CO'], ['connecticut', 'CT'], ['delaware', 'DE'],
  ['florida', 'FL'], ['georgia', 'GA'], ['hawaii', 'HI'], ['idaho', 'ID'],
  ['illinois', 'IL'], ['indiana', 'IN'], ['iowa', 'IA'], ['kansas', 'KS'],
  ['kentucky', 'KY'], ['louisiana', 'LA'], ['maine', 'ME'], ['maryland', 'MD'],
  ['massachusetts', 'MA'], ['michigan', 'MI'], ['minnesota', 'MN'], ['mississippi', 'MS'],
  ['missouri', 'MO'], ['montana', 'MT'], ['nebraska', 'NE'], ['nevada', 'NV'],
  ['new hampshire', 'NH'], ['new jersey', 'NJ'], ['new mexico', 'NM'], ['new york', 'NY'],
  ['north carolina', 'NC'], ['north dakota', 'ND'], ['ohio', 'OH'], ['oklahoma', 'OK'],
  ['oregon', 'OR'], ['pennsylvania', 'PA'], ['rhode island', 'RI'], ['south carolina', 'SC'],
  ['south dakota', 'SD'], ['tennessee', 'TN'], ['texas', 'TX'], ['utah', 'UT'],
  ['vermont', 'VT'], ['virginia', 'VA'], ['washington', 'WA'], ['west virginia', 'WV'],
  ['wisconsin', 'WI'], ['wyoming', 'WY'], ['district of columbia', 'DC'],
];

export interface AnchorAttribute {
  /** `place` participates in contradiction detection; the rest only corroborate. */
  kind: 'place' | 'other';
  /** The matchable text, normalized. */
  value: string;
  /** Where the belief came from. `owner` is authoritative. */
  source: 'owner' | 'established';
}

export interface IdentityAnchor {
  attributes: AnchorAttribute[];
  /** State codes the subject IS associated with — drives contradiction. */
  states: string[];
}

/**
 * Count mentions of each US state in `text`.
 *
 * ⚠ A postal code MUST be matched case-SENSITIVELY against the raw text.
 * Sixteen of them are ordinary English words — IN, OR, OK, ME, HI, DE, LA, MA,
 * PA, MD, MT, MS, MO, ID, AL, AR — so lowercasing first makes "he lives **in**
 * Georgetown" register as Indiana. That is not hypothetical: it is what this
 * function did on its first run, and the consequence would have been a
 * *false conflict* — the anchor deciding a correct source was about the wrong
 * person and refusing it. Under-detecting only costs us a conflict we do not
 * flag; over-detecting silently discards true evidence, so the bias goes here.
 *
 * Full state NAMES are matched on the normalized text, where case and
 * punctuation genuinely do not matter.
 */
function state_mentions(text: string): Map<string, number> {
  const normalized = normalize_for_match(text);
  const counts = new Map<string, number>();
  const bump = (code: string, n: number): void => {
    if (n > 0) counts.set(code, (counts.get(code) ?? 0) + n);
  };
  for (const [name, code] of US_STATES) {
    bump(code, (normalized.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length);
    // Uppercase, word-bounded, against the RAW text — "Georgetown, TX" counts,
    // "lives in" does not.
    bump(code, (text.match(new RegExp(`\\b${code}\\b`, 'g')) ?? []).length);
  }
  return counts;
}

/** Does this fact name a US state? Returns the most-mentioned code. */
function state_in(text: string): string | null {
  const counts = [...state_mentions(text).entries()].sort((a, b) => b[1] - a[1]);
  return counts[0]?.[0] ?? null;
}

/**
 * Build an anchor from the owner's supplied facts.
 *
 * Deterministic and cheap: each fact becomes an attribute, and any fact naming
 * a US state also registers that state. No LLM — the owner already did the
 * knowing, and a model re-deriving it could only add error.
 */
export function anchor_from_facts(facts: readonly string[]): IdentityAnchor {
  const attributes: AnchorAttribute[] = [];
  const states: string[] = [];
  for (const raw of facts) {
    const value = raw.trim();
    if (value.length < 2) continue;
    const code = state_in(value);
    if (code && !states.includes(code)) states.push(code);
    attributes.push({ kind: code ? 'place' : 'other', value, source: 'owner' });
  }
  return { attributes, states };
}

export type AnchorVerdict = 'confirmed' | 'unconfirmed' | 'conflicting';

export interface AnchorAssessment {
  verdict: AnchorVerdict;
  /** Anchor attributes the source corroborates. */
  corroborated: string[];
  /** Why it conflicts, when it does — surfaced verbatim. */
  reason: string;
}

/** Content words of a fact, for corroboration matching. */
function content_tokens(value: string): string[] {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'his', 'her', 'their', 'they', 'she', 'from',
    'that', 'this', 'has', 'have', 'was', 'were', 'are', 'lives', 'live', 'in',
    'at', 'of', 'on', 'a', 'an', 'is', 'works', 'work', 'near',
  ]);
  return normalize_for_match(value)
    .split(' ')
    .filter((t) => t.length >= 3 && !stop.has(t));
}

/**
 * Does this source's body support that it is about the ANCHORED person?
 *
 * Three outcomes, and the middle one is load-bearing:
 *
 *   `confirmed`    — corroborates at least one anchor attribute.
 *   `unconfirmed`  — names the person but corroborates nothing. Common and
 *                    often fine (a thin directory entry). KEPT, flagged.
 *   `conflicting`  — places the person in a state the anchor excludes, while
 *                    corroborating nothing. This is the Spokeo-Virginia shape.
 *
 * Note what this deliberately does NOT do: drop anything. Per design §7 the
 * rule while precision is unproven is FLAG, DON'T DROP — the verdict rides
 * with the source and the synthesiser is told, rather than the evidence being
 * deleted out from under a reader.
 */
export function source_corroborates_anchor(body: string, anchor: IdentityAnchor): AnchorAssessment {
  if (anchor.attributes.length === 0) {
    return {
      verdict: 'unconfirmed',
      corroborated: [],
      reason: 'no anchor facts were supplied, so identity could not be corroborated',
    };
  }
  const hay = normalize_for_match(body);
  const corroborated: string[] = [];
  for (const attr of anchor.attributes) {
    const tokens = content_tokens(attr.value);
    if (tokens.length === 0) continue;
    // Every content token present = this fact is echoed by the source.
    if (tokens.every((t) => new RegExp(`\\b${t}\\b`).test(hay))) corroborated.push(attr.value);
  }
  if (corroborated.length > 0) {
    return {
      verdict: 'confirmed',
      corroborated,
      reason: `corroborates: ${corroborated.join('; ')}`,
    };
  }

  // Contradiction: the source is emphatic about a DIFFERENT state and silent
  // about ours. "Emphatic" matters — a passing mention of another state in a
  // long page is not a conflict, so we require the foreign state to be the
  // most-repeated one and the anchor's own states to be absent entirely.
  if (anchor.states.length > 0) {
    // Same counter as the anchor builder, so the two can never disagree about
    // what counts as a state mention — and so the case-sensitivity rule that
    // keeps "lives in" from meaning Indiana is enforced in exactly one place.
    const counts = state_mentions(body);
    const ours = anchor.states.reduce((n, s) => n + (counts.get(s) ?? 0), 0);
    if (ours === 0 && counts.size > 0) {
      const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      if (top && top[1] >= 2) {
        const label = US_STATES.find(([, c]) => c === top[0])?.[0] ?? top[0];
        return {
          verdict: 'conflicting',
          corroborated: [],
          reason:
            `places this person in ${label} (${top[1]} mentions) and never mentions ` +
            `${anchor.states.join('/')}, which is where the subject is anchored — ` +
            `likely a different person with the same name`,
        };
      }
    }
  }

  return {
    verdict: 'unconfirmed',
    corroborated: [],
    reason: 'names the subject but corroborates none of the known facts about them',
  };
}
