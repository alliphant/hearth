/**
 * Grounding precedence — authority-tiered conflict resolution for person facts
 * (Person-record grounding integrity #2, 2026-06-14).
 *
 * The 2026-06-03 address-fabrication loop: Ruby seeded a derived clipping
 * (Knowledge/Ruby/library/2026-05-31-jasper.md) with "2450 Parkfield Drive" — the
 * the clinic vet-LAB's own letterhead address off a pet lab report, mistaken for
 * Jasper's home. That stale `reviewed:false` clipping then OUTRANKED both Jasper's
 * direct correction ("3215 Westwood Ct") AND the master
 * vault/People/Jasper-Doe.md record in the turn's grounding checks: turn-RAG
 * surfaced the clipping (Ruby's own library, in her knowledge_scope), the master
 * People record sat OUTSIDE that scope so nothing pulled it into the evidence,
 * and the fact critic — seeing only the wrong address — branded the CORRECT one
 * a "fabrication" for two days.
 *
 * The rule this module enforces: a direct USER STATEMENT and the master
 * People/<name>.md RECORD outrank any specialist's derived/cache library
 * clipping for the SAME person fact. A clipping address (especially
 * reviewed:false) that conflicts with an authoritative address for the same
 * person is EXCLUDED from the grounding evidence — so a wrong clipping can
 * neither ground a mistaken reply nor flag the correct one as ungrounded.
 *
 * Two surfaces:
 *   - `apply_grounding_precedence(sources, opts)` — the PURE engine. No DB, no
 *     LLM. Classifies evidence by authority tier, associates address facts to a
 *     person subject, and scrubs a lower-tier (clipping) address that conflicts
 *     with a higher-tier (user / master) one for that subject.
 *   - `gather_person_precedence(deps, input)` — the runtime bridge. Builds the
 *     evidence sources from the turn's retrieved chunks + a cheap person roster,
 *     runs the engine, and returns the authoritative master block(s) to inject
 *     plus the RAG section with the conflicting clipping address scrubbed out.
 *     FAIL-OPEN and address-gated — zero work on a turn that names no address.
 *
 * Fix #1 (the `upsert_person_note` schema mismatch that let the wrong write
 * persist) shipped 2026-06-05; this is fix #2, the recurrence-prevention.
 */

/**
 * Authority tiers, highest to lowest. The contract: AUTHORITATIVE sources (the
 * user's own words this turn, the master vault People record) beat CLIPPING
 * sources (a specialist's library item — a derived/cache note) on the same
 * fact. `tool_result` sits in the middle (a fresh this-turn fetch, generally
 * trustworthy) and is never scrubbed by this rule.
 */
export type AuthorityTier =
  | 'user_statement'
  | 'master_record'
  | 'tool_result'
  | 'reviewed_clipping'
  | 'derived_clipping';

export const AUTHORITY_RANK: Record<AuthorityTier, number> = {
  user_statement: 100,
  master_record: 90,
  tool_result: 60,
  reviewed_clipping: 40,
  derived_clipping: 10,
};

/** Tiers that WIN a person-fact conflict. */
const AUTHORITATIVE_TIERS: ReadonlySet<AuthorityTier> = new Set<AuthorityTier>([
  'user_statement',
  'master_record',
]);
/** Tiers whose conflicting fact is scrubbed (a derived/cache library note). */
const CLIPPING_TIERS: ReadonlySet<AuthorityTier> = new Set<AuthorityTier>([
  'reviewed_clipping',
  'derived_clipping',
]);

/** One piece of evidence, tagged by where it came from. */
export interface EvidenceSource {
  tier: AuthorityTier;
  /** The readable text. Conflicting facts are scrubbed from the RETURNED copy. */
  text: string;
  /** Provenance label for the audit (note_path / "user message" / tool name). */
  ref?: string;
  /** Explicit person subject when known (master_record carries the name). */
  subject?: string;
}

/** Audit record of one fact the precedence rule removed. */
export interface ExcludedFact {
  kind: 'address';
  /** The exact lower-authority value that was scrubbed. */
  value: string;
  /** The person it was attributed to. */
  subject: string;
  /** Source it was scrubbed from. */
  from_ref: string;
  /** The higher tier that won. */
  beaten_by: AuthorityTier;
  /** The winning (authoritative) value. */
  winning_value: string;
}

export interface PrecedenceResult {
  /** Cloned sources with conflicting lower-tier facts scrubbed from `text`. */
  sources: EvidenceSource[];
  excluded: ExcludedFact[];
}

/** Replaces a scrubbed address; transparent to the model + the grounding check. */
export const PRECEDENCE_SCRUB_MARKER =
  '[address removed — superseded by your master People record]';

// ── Address extraction + canonicalization ───────────────────────────────────

// Street-type token → canonical short form. Two spellings of the same address
// ("Westwood Ct" vs "Westwood Court") must canonicalize equal so they
// AGREE (and are NOT scrubbed); two different streets ("Parkfield Drive") differ.
const STREET_TYPES: Record<string, string> = {
  st: 'st', street: 'st',
  ave: 'ave', avenue: 'ave', av: 'ave',
  rd: 'rd', road: 'rd',
  dr: 'dr', drive: 'dr', drv: 'dr',
  ln: 'ln', lane: 'ln',
  ct: 'ct', court: 'ct',
  blvd: 'blvd', boulevard: 'blvd',
  way: 'way',
  cir: 'cir', circle: 'cir',
  pl: 'pl', place: 'pl',
  ter: 'ter', terrace: 'ter',
  trl: 'trl', trail: 'trl',
  loop: 'loop',
  pkwy: 'pkwy', parkway: 'pkwy',
  hwy: 'hwy', highway: 'hwy',
};

const STREET_TYPE_ALT = Object.keys(STREET_TYPES).join('|');
// A US-style street address: house number, street words, a street-type token.
// Mirrors the grounding_packs ADDRESS_RE but global + capturing, so we collect
// every address in a block and canonicalize each.
const ADDRESS_RE = new RegExp(
  `\\b(\\d{1,6}\\s+[A-Za-z0-9.'\\-\\s]{2,40}?\\b(?:${STREET_TYPE_ALT})\\b)`,
  'gi',
);

/** True if `text` contains anything address-shaped. Cheap turn-level gate. */
export function has_address(text: string): boolean {
  ADDRESS_RE.lastIndex = 0;
  return ADDRESS_RE.test(text);
}

/**
 * Canonical comparison core of an address: `<number> <street words> <type>`,
 * lowercased, street-type normalized, everything after the type (unit, city,
 * state, zip) dropped. Used only for EQUALITY — two addresses conflict when
 * their cores differ.
 */
export function canonical_address(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = cleaned.split(' ').filter(Boolean);
  // First street-type token AFTER the house number is the address boundary.
  for (let i = 1; i < tokens.length; i++) {
    const canon = STREET_TYPES[tokens[i]!];
    if (canon) return [...tokens.slice(0, i), canon].join(' ');
  }
  return cleaned;
}

interface AddrOcc {
  /** Exact substring as it appeared (for scrubbing). */
  raw: string;
  /** Canonical comparison core. */
  core: string;
}

function extract_addresses(text: string): AddrOcc[] {
  const out: AddrOcc[] = [];
  const seen = new Set<string>();
  ADDRESS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ADDRESS_RE.exec(text)) !== null) {
    const raw = (m[1] ?? '').replace(/[\s.,]+$/, '').trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw, core: canonical_address(raw) });
  }
  return out;
}

// ── Subject (person) association ─────────────────────────────────────────────

// Name connectors/honorifics that are not distinctive subject tokens.
const NAME_STOPWORDS = new Set([
  'the', 'and', 'von', 'van', 'der', 'del', 'de', 'la', 'el',
  'jr', 'sr', 'ii', 'iii', 'mr', 'mrs', 'ms', 'dr', 'st',
]);

function name_tokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 3 && !NAME_STOPWORDS.has(t));
}

function escape_re(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word presence of `token` (already lowercased) in `text_lower`. */
function word_present(text_lower: string, token: string): boolean {
  return new RegExp(`\\b${escape_re(token)}\\b`).test(text_lower);
}

// "my home is …", "our address …" — a self-referential address statement.
const FIRST_PERSON_ADDR_RE =
  /\b(?:my|our)\b[^.\n]{0,40}\b(?:address|home|house|residence|place|live|living)\b/i;

interface SubjectInfo {
  display: string;
  tokens: string[];
}

interface SubjectFact {
  core: string;
  raw: string;
  tier: AuthorityTier;
  src_idx: number;
  ref: string;
}

/**
 * Resolve grounding precedence over a turn's evidence sources. PURE: clones the
 * sources, never mutates the input. For each person subject, if an authoritative
 * (user/master) address exists, any conflicting clipping address attributed to
 * that subject is scrubbed from its source text and recorded in `excluded`.
 *
 * Subject association:
 *   - a `master_record` source carries its `subject` explicitly;
 *   - any other source is attributed to a known subject whose name token appears
 *     in its text (so a clipping that NAMES "Jasper" links to Jasper's record);
 *   - a `user_statement` with a first-person address ("my home is …") also links
 *     to `opts.self_subject` (the household owner) when provided.
 */
export function apply_grounding_precedence(
  sources: EvidenceSource[],
  opts: { subjects?: string[]; self_subject?: string } = {},
): PrecedenceResult {
  // Work on clones — the engine is pure; callers compare before/after.
  const out: EvidenceSource[] = sources.map((s) => ({ ...s }));

  // Subject registry: every name we might attribute an address to.
  const subjects = new Map<string, SubjectInfo>();
  const register = (name: string | undefined): void => {
    const key = name?.toLowerCase().trim();
    if (!key || subjects.has(key)) return;
    subjects.set(key, { display: name!.trim(), tokens: name_tokens(name!) });
  };
  for (const s of opts.subjects ?? []) register(s);
  for (const s of out) register(s.subject);
  register(opts.self_subject);

  const self_key = opts.self_subject?.toLowerCase().trim();

  // Collect every address fact, bucketed by subject.
  const facts = new Map<string, SubjectFact[]>();
  const add_fact = (subject_key: string, f: SubjectFact): void => {
    const arr = facts.get(subject_key) ?? [];
    arr.push(f);
    facts.set(subject_key, arr);
  };

  for (let i = 0; i < out.length; i++) {
    const src = out[i]!;
    const addrs = extract_addresses(src.text);
    if (addrs.length === 0) continue;
    const text_lower = src.text.toLowerCase();

    // Which subject(s) does this source's address belong to?
    const keys: string[] = [];
    if (src.subject) {
      keys.push(src.subject.toLowerCase().trim());
    } else {
      for (const [key, info] of subjects) {
        if (info.tokens.length > 0 && info.tokens.some((t) => word_present(text_lower, t))) {
          keys.push(key);
        }
      }
      if (
        src.tier === 'user_statement' &&
        self_key &&
        !keys.includes(self_key) &&
        FIRST_PERSON_ADDR_RE.test(src.text)
      ) {
        keys.push(self_key);
      }
    }
    if (keys.length === 0) continue;

    for (const key of keys) {
      for (const a of addrs) {
        add_fact(key, { core: a.core, raw: a.raw, tier: src.tier, src_idx: i, ref: src.ref ?? '' });
      }
    }
  }

  // Resolve each subject: authoritative cores win; conflicting clippings lose.
  // A person can register under more than one subject key (e.g. "Jasper" and
  // "Jasper Doe"), so dedupe the scrub of one physical fact by (source,
  // value) — it must scrub + audit exactly once.
  const excluded: ExcludedFact[] = [];
  const scrubbed = new Set<string>();
  for (const [key, subject_facts] of facts) {
    const authoritative = subject_facts.filter((f) => AUTHORITATIVE_TIERS.has(f.tier));
    if (authoritative.length === 0) continue; // nothing authoritative — leave as-is.

    const auth_cores = new Set(authoritative.map((f) => f.core));
    const winner = authoritative
      .slice()
      .sort((a, b) => AUTHORITY_RANK[b.tier] - AUTHORITY_RANK[a.tier])[0]!;

    for (const f of subject_facts) {
      if (!CLIPPING_TIERS.has(f.tier)) continue; // never scrub user/master/tool.
      if (auth_cores.has(f.core)) continue; // clipping AGREES — keep it.
      const dedupe_key = `${f.src_idx}|${f.raw.toLowerCase()}`;
      if (scrubbed.has(dedupe_key)) continue; // already handled under another subject key.
      scrubbed.add(dedupe_key);
      const src = out[f.src_idx]!;
      if (src.text.includes(f.raw)) {
        src.text = src.text.split(f.raw).join(PRECEDENCE_SCRUB_MARKER);
      }
      excluded.push({
        kind: 'address',
        value: f.raw,
        subject: subjects.get(key)?.display ?? key,
        from_ref: f.ref || src.ref || '(clipping)',
        beaten_by: winner.tier,
        winning_value: winner.raw,
      });
    }
  }

  return { sources: out, excluded };
}

// ── Runtime bridge ──────────────────────────────────────────────────────────

/** A cheap person-roster row — name + master address, materialized by the caller. */
export interface PersonRosterEntry {
  name: string;
  preferred_name?: string | null;
  /** Stringified master address from the People note frontmatter; null if none. */
  address: string | null;
  note_path: string;
  /** True for the household owner's own `self`-relationship note. */
  is_self?: boolean;
}

/** Classification of a retrieved chunk's source note. */
export interface ClippingMeta {
  is_clipping: boolean;
  reviewed: boolean;
}

export interface PersonPrecedenceDeps {
  /**
   * All known people (name + master address). A THUNK, not a value — it's
   * invoked only AFTER the cheap address gate passes, so the (SQLite) roster
   * fetch never runs on the common no-address turn.
   */
  roster: () => PersonRosterEntry[];
  /** Classify a retrieved chunk's note: is it a (reviewed?) library clipping? */
  clipping_meta: (note_path: string) => ClippingMeta | null;
}

export interface PersonPrecedenceInput {
  /** The turn's retrieved chunks (RAG hits). */
  retrieved: ReadonlyArray<{ note_path: string; chunk_text: string }>;
  /** The rendered "Relevant material from your library" section. */
  rag_section: string;
  /** The user's current message. */
  message: string;
  /** Conversation history (role + content). */
  history: ReadonlyArray<{ role: string; content: string }>;
}

export interface PersonPrecedenceOutput {
  /** RAG section with conflicting clipping addresses scrubbed. */
  rag_section: string;
  /** Authoritative master-record blocks to inject as `verified` grounding. */
  master_blocks: string[];
  excluded: ExcludedFact[];
  applied: boolean;
}

function render_master_block(e: PersonRosterEntry): string {
  return (
    `### ${e.name} — your vault master record (authoritative for their details)\n` +
    `- Address: ${e.address}  (source: ${e.note_path})\n` +
    'Use THIS address. A library clipping that says otherwise is a derived/cache ' +
    'note and is superseded by this master record.'
  );
}

/**
 * Build the turn's evidence sources, run the precedence engine, and return the
 * authoritative master block(s) to inject plus the RAG section with any
 * conflicting clipping address scrubbed. FAIL-OPEN and address-gated: a turn
 * that names no address (or has no roster) returns the input unchanged.
 */
export function gather_person_precedence(
  deps: PersonPrecedenceDeps,
  input: PersonPrecedenceInput,
): PersonPrecedenceOutput {
  const noop: PersonPrecedenceOutput = {
    rag_section: input.rag_section,
    master_blocks: [],
    excluded: [],
    applied: false,
  };

  // Cheap gate — only engage when the turn actually carries an address. The
  // roster fetch is deferred behind this so a no-address turn does zero work.
  const history_text = input.history.map((h) => h.content).join('\n');
  const haystack = `${input.message}\n${input.rag_section}\n${history_text}`;
  if (!has_address(haystack)) return noop;
  const roster = deps.roster();
  if (roster.length === 0) return noop;

  const haystack_lower = haystack.toLowerCase();
  const referenced = roster.filter((e) => {
    const toks = [...name_tokens(e.name), ...name_tokens(e.preferred_name ?? '')];
    return toks.some((t) => word_present(haystack_lower, t));
  });
  if (referenced.length === 0) return noop;

  // Assemble sources.
  const sources: EvidenceSource[] = [];
  const user_text = [input.message, ...input.history.filter((h) => h.role === 'user').map((h) => h.content)]
    .filter((s) => s && s.trim())
    .join('\n');
  if (user_text.trim()) sources.push({ tier: 'user_statement', text: user_text, ref: 'user message' });
  for (const e of referenced) {
    if (e.address && e.address.trim()) {
      sources.push({ tier: 'master_record', subject: e.name, text: `${e.name} — address: ${e.address}`, ref: e.note_path });
    }
  }
  for (const h of input.retrieved) {
    const meta = deps.clipping_meta(h.note_path);
    if (!meta || !meta.is_clipping) continue;
    sources.push({
      tier: meta.reviewed ? 'reviewed_clipping' : 'derived_clipping',
      text: h.chunk_text,
      ref: h.note_path,
    });
  }
  if (sources.length === 0) return noop;

  const self = referenced.find((e) => e.is_self) ?? roster.find((e) => e.is_self);
  const result = apply_grounding_precedence(sources, {
    subjects: referenced.map((e) => e.name),
    ...(self ? { self_subject: self.name } : {}),
  });

  // Inject master blocks for every referenced person with a master address — so
  // a correct master-address answer ALWAYS grounds, conflict or not.
  const master_blocks = referenced
    .filter((e) => e.address && e.address.trim())
    .slice(0, 3)
    .map(render_master_block);

  // Scrub conflicting clipping addresses out of the rendered RAG section (the
  // single representation injected into both the prompt and the grounding check).
  let rag_section = input.rag_section;
  const clip_refs = new Set(input.retrieved.map((h) => h.note_path));
  for (const ex of result.excluded) {
    if (ex.from_ref && clip_refs.has(ex.from_ref) && rag_section.includes(ex.value)) {
      rag_section = rag_section.split(ex.value).join(PRECEDENCE_SCRUB_MARKER);
    }
  }

  return {
    rag_section,
    master_blocks,
    excluded: result.excluded,
    applied: master_blocks.length > 0 || result.excluded.length > 0,
  };
}

/**
 * Coerce a People-note `address` frontmatter value (string OR the structured
 * `{ street, city, state, zip, … }` object the person schema accepts) into a
 * single comparable string. Returns null when nothing usable is present.
 */
export function stringify_address(value: unknown): string | null {
  if (typeof value === 'string') {
    const t = value.trim();
    return t.length > 0 ? t : null;
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const parts = ['street', 'city', 'state', 'zip', 'country']
      .map((k) => o[k])
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    return parts.length > 0 ? parts.join(', ') : null;
  }
  return null;
}
