/**
 * Claim-provenance enforcement (Durable Truth — Phase 1, 2026-05-30).
 *
 * Phase 0 *asked* the model to ground every specific in a real source
 * (the source-not-category grounding rule in build_system_prompt). This
 * module *enforces* it at the boundary: after a reply is generated, we
 * extract its load-bearing claims (identifiers, verbatim quotes, dates,
 * numbers, named entities) and check each against the GROUNDING CONTEXT
 * — the union of everything the specialist legitimately had access to
 * this turn (tool results, conversation history, the user's own message,
 * retrieved library material). A claim whose token doesn't resolve to a
 * fresh entry in that context is *ungrounded*: the model produced it from
 * parametric memory, which for a specific identifier or quote means it
 * fabricated it.
 *
 * The worked example this exists to kill: Ruby asked who owns the power
 * line that caused the Ponds Fire invented "PUC Order E-23734" and a
 * verbatim DFPC quote — fluent, specific, both wrong. A grounding check
 * sees that "E-23734" appears in NO tool result, NO history entry, NO
 * retrieved note, and strips it before it reaches the user.
 *
 * Enforcement is tiered by extraction precision (see PROVENANCE_POLICY):
 *   - `identifier` / `quote` — ENFORCED. These essentially never appear
 *     unless retrieved, so an ungrounded one is by definition a
 *     fabrication. They drive a one-retry nudge in the chat path and are
 *     hard-redacted as a structural backstop if they survive.
 *   - `date` / `number` / `named_entity` — FLAG only. Higher false-
 *     positive rate (a rounded "~30 min", a sentence-initial capital),
 *     so they're detected, audit-logged, and named in the nudge, but
 *     never auto-removed. Promoting one of these to ENFORCED is a one-
 *     line policy change once extraction precision warrants it — the
 *     mechanism generalizes; it is not a per-kind carve-out.
 *
 * This is the layer that holds when the model is confidently wrong.
 */

import { z } from 'zod';

export type ClaimKind = 'identifier' | 'quote' | 'date' | 'number' | 'named_entity';

export interface Claim {
  kind: ClaimKind;
  /** The exact substring as it appears in the reply (used for redaction). */
  text: string;
  /**
   * The load-bearing token checked against grounding. For identifiers
   * this is the id alone ("E-23734"); for quotes the inner phrase; for
   * dates/numbers the value. May equal `text`.
   */
  token: string;
  /** Character offset of `text` in the source reply. */
  index: number;
}

/**
 * Structured claim-provenance record — the schema form of a Claim plus
 * its resolution verdict. Not required to drive the extraction path
 * (which works on free text), but exported so callers that want the
 * model to emit claims explicitly, or that persist provenance verdicts,
 * share one validated shape. `source_ref` is the grounding entry that
 * resolved the claim (null when ungrounded).
 */
export const ClaimProvenanceSchema = z.object({
  kind: z.enum(['identifier', 'quote', 'date', 'number', 'named_entity']),
  text: z.string().min(1),
  token: z.string().min(1),
  grounded: z.boolean(),
  source_ref: z.string().nullable().default(null),
});
export type ClaimProvenance = z.infer<typeof ClaimProvenanceSchema>;

/** Per-kind enforcement policy. ENFORCED kinds drive retry + redaction;
 *  FLAG kinds are detected and surfaced but never alter output. */
export const PROVENANCE_POLICY: Record<ClaimKind, 'enforce' | 'flag'> = {
  identifier: 'enforce',
  quote: 'enforce',
  date: 'flag',
  number: 'flag',
  named_entity: 'flag',
};

export const ENFORCED_KINDS: ReadonlyArray<ClaimKind> = (
  Object.keys(PROVENANCE_POLICY) as ClaimKind[]
).filter((k) => PROVENANCE_POLICY[k] === 'enforce');

/**
 * The grounding context — the corpus of everything the specialist
 * legitimately had access to this turn. Two normalized forms:
 *   - `text` : lowercased, whitespace-collapsed. For phrase/quote and
 *     date/number substring checks.
 *   - `squashed` : all non-alphanumerics stripped, lowercased. For
 *     identifier checks, so "E-23734", "E‑23734" (en-dash), "E 23734"
 *     and "E23734" all resolve to the same "e23734" needle.
 */
export interface GroundingContext {
  text: string;
  squashed: string;
}

export function normalize_text(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Build a GroundingContext from the evidence sources of a turn.
 *
 * IMPORTANT: the system prompt is deliberately NOT a source. Its
 * grounding-rule block contains the literal "PUC Order E-23734" worked
 * example; including it would ground the very fabrication we exist to
 * catch. Grounding is *evidence the model retrieved*, never the
 * instructions. Tool *inputs* are likewise excluded — a fabricated id
 * the model passed as a search argument must not ground itself; only
 * what came BACK counts.
 */
export interface GroundingParts {
  /** Raw text/JSON of each tool result the model received this turn. */
  tool_results?: string[];
  /** Prior conversation turns (both roles). */
  history?: string[];
  /** The user's current message. */
  user_message?: string;
  /** Retrieved library / RAG material rendered for the prompt. */
  retrieved?: string[];
  /** Any additional verified-context blocks (e.g. domain-pack readings). */
  verified?: string[];
}

/**
 * The raw, READABLE evidence text for a turn — the same source selection
 * as build_grounding_context (tool results, history, retrieved, verified,
 * user message) but joined WITHOUT normalization, so casing/punctuation
 * survive. The regex grounding check wants the normalized/squashed forms;
 * a semantic judge (src/core/fact_critic.ts) wants this readable form so
 * it can reason about whether a named entity is actually supported.
 *
 * Single source of truth for "what counts as evidence this turn" — both
 * the structural check (build_grounding_context) and the semantic check
 * (fact_critic) derive from the same parts, so a source added here is
 * seen by both layers.
 */
export function build_grounding_evidence(parts: GroundingParts): string {
  const chunks: string[] = [];
  for (const arr of [parts.tool_results, parts.history, parts.retrieved, parts.verified]) {
    if (arr) for (const s of arr) if (s) chunks.push(s);
  }
  if (parts.user_message) chunks.push(parts.user_message);
  return chunks.join('\n');
}

export function build_grounding_context(parts: GroundingParts): GroundingContext {
  const joined = build_grounding_evidence(parts);
  return { text: normalize_text(joined), squashed: squash(joined) };
}

// ── Extractors ────────────────────────────────────────────────────────

// Identifiers: high-specificity alphanumeric tokens that signal a
// retrieved document/order/case/docket/statute. Two shapes:
//   (A) a label ("Order", "Case No.", "Docket #") followed by an id, and
//   (B) standalone code-shaped tokens (E-23734, 21-CV-1234, § 40-2-108).
const ID_LABEL =
  '(?:order|case|docket|file|ruling|decision|proceeding|permit|ordinance|resolution|citation|invoice|policy|tracking|confirmation|reference|ref|claim)';
const ID_LABELED_RE = new RegExp(
  `\\b${ID_LABEL}\\b\\.?\\s*(?:no\\.?|number|#)?\\s*([A-Za-z0-9][A-Za-z0-9.\\-\\/]*\\d[A-Za-z0-9.\\-\\/]*)`,
  'gi',
);
// Code-shaped standalone identifiers. Each alternative must carry a
// letter+digit mix or a section sign so plain numbers/dates don't match.
// The leading-letters form requires a >=4-digit run: that catches order/
// docket numbers (E-23734, CC-100482) while NOT matching highway and
// route designations (US-287, CO-14, I-25 — all <=3 digits) or product
// names, which are stable general knowledge, not fabrication-prone
// retrieved facts. Sub-4-digit real identifiers ("Order 12-345") are
// still caught by the LABELED pattern above.
const ID_CODE_RES: RegExp[] = [
  /\b([A-Z]{1,4}[-–][0-9]{4,}[A-Z0-9\-]*)\b/g, // E-23734, CC-100482
  /\b([0-9]{1,4}-[A-Z]{2,5}-[0-9]{2,}[A-Z0-9\-]*)\b/gi, // 21-CV-1234
  /§\s?([0-9][0-9A-Za-z().\-]+)/g, // § 40-2-108
];

function extract_identifiers(text: string): Claim[] {
  const out: Claim[] = [];
  const seen = new Set<number>();
  let m: RegExpExecArray | null;

  // Trailing `.`/`-`/`/` on a captured id is almost always sentence
  // punctuation the greedy char class swept in ("E-23734." at clause
  // end) — trim it so redaction doesn't eat the period.
  const trim_id = (s: string): string => s.replace(/[.\-\/]+$/, '');

  ID_LABELED_RE.lastIndex = 0;
  while ((m = ID_LABELED_RE.exec(text)) !== null) {
    const raw = m[1];
    if (!raw) continue;
    const token = trim_id(raw);
    // Must contain a digit and be substantial — skip "Order form", "Case 5".
    if (!/\d/.test(token) || squash(token).length < 4) continue;
    const idx = m.index + m[0].indexOf(token);
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push({ kind: 'identifier', text: token, token, index: idx });
  }

  for (const re of ID_CODE_RES) {
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1];
      if (!raw) continue;
      const token = trim_id(raw);
      if (squash(token).length < 4) continue;
      const idx = m.index + m[0].indexOf(token);
      if (seen.has(idx)) continue;
      seen.add(idx);
      out.push({ kind: 'identifier', text: token, token, index: idx });
    }
  }
  return out;
}

// Quotes: a span in straight or curly quotes of >= MIN_QUOTE_WORDS words.
// Short quotes (a single emphasized word, an idiom) are skipped — they're
// rarely fabricated specifics and frequently echo the user.
const MIN_QUOTE_WORDS = 5;
const QUOTE_RE = /["“”]([^"“”]{8,400})["“”]|‘([^‘’]{8,400})’|'([^']{12,400})'/g;

function extract_quotes(text: string): Claim[] {
  const out: Claim[] = [];
  let m: RegExpExecArray | null;
  QUOTE_RE.lastIndex = 0;
  while ((m = QUOTE_RE.exec(text)) !== null) {
    const inner = m[1] ?? m[2] ?? m[3];
    if (!inner) continue;
    const words = inner.trim().split(/\s+/).filter(Boolean);
    if (words.length < MIN_QUOTE_WORDS) continue;
    out.push({
      kind: 'quote',
      text: m[0], // includes the quote marks, for clean redaction
      token: inner,
      index: m.index,
    });
  }
  return out;
}

// Dates (FLAG): explicit calendar dates the model might invent.
const MONTHS =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_RES: RegExp[] = [
  new RegExp(`\\b${MONTHS}\\s+[0-9]{1,2}(?:st|nd|rd|th)?(?:,?\\s*[0-9]{4})?\\b`, 'gi'),
  /\b[0-9]{4}-[0-9]{2}-[0-9]{2}\b/g,
  /\b[0-9]{1,2}\/[0-9]{1,2}(?:\/[0-9]{2,4})?\b/g,
];

function extract_dates(text: string): Claim[] {
  const out: Claim[] = [];
  const seen = new Set<number>();
  for (const re of DATE_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (seen.has(m.index)) continue;
      seen.add(m.index);
      out.push({ kind: 'date', text: m[0], token: m[0], index: m.index });
    }
  }
  return out;
}

// Numbers (FLAG): only meaningful magnitudes — currency, percentages,
// and unit-bearing quantities. Bare integers are too noisy to track.
const NUMBER_RE =
  /(\$\s?[0-9][0-9,]*(?:\.[0-9]+)?|\b[0-9][0-9,]*(?:\.[0-9]+)?\s?(?:%|percent|dollars?|cents?|miles?|mi|km|kwh|kw|mph|gb|tb|°[fc]?|degrees?)\b)/gi;

function extract_numbers(text: string): Claim[] {
  const out: Claim[] = [];
  let m: RegExpExecArray | null;
  NUMBER_RE.lastIndex = 0;
  while ((m = NUMBER_RE.exec(text)) !== null) {
    const tok = m[1];
    if (!tok) continue;
    out.push({ kind: 'number', text: tok, token: tok, index: m.index });
  }
  return out;
}

/** Extract every candidate load-bearing claim from a reply. */
export function extract_claims(text: string): Claim[] {
  if (!text) return [];
  return [
    ...extract_identifiers(text),
    ...extract_quotes(text),
    ...extract_dates(text),
    ...extract_numbers(text),
  ];
}

// ── Grounding check ───────────────────────────────────────────────────

/** Does this claim's token resolve to a fresh entry in the grounding? */
export function is_grounded(claim: Claim, grounding: GroundingContext): boolean {
  if (claim.kind === 'identifier') {
    const needle = squash(claim.token);
    if (needle.length < 4) return true; // too short to judge — don't strip
    return grounding.squashed.includes(needle);
  }
  // quote / date / number: phrase substring against normalized text.
  const needle = normalize_text(claim.token).replace(/^["'“”‘’\s]+|["'“”‘’\s.,;:!?]+$/g, '');
  if (!needle) return true;
  return grounding.text.includes(needle);
}

/** All claims (any kind) that don't resolve to the grounding context. */
export function find_ungrounded_claims(
  text: string,
  grounding: GroundingContext,
): Claim[] {
  return extract_claims(text).filter((c) => !is_grounded(c, grounding));
}

const REDACTION_MARKER: Record<ClaimKind, string> = {
  identifier: '[unverified — removed]',
  quote: '[unverified quote — removed]',
  date: '[unverified date]',
  number: '[unverified figure]',
  named_entity: '[unverified]',
};

/**
 * Surgically remove the ENFORCED-tier ungrounded claims from a reply,
 * replacing each with a transparency marker. FLAG-tier claims are left
 * untouched (they were never enforced). Returns the rewritten text and
 * the list of claims actually redacted.
 */
export function redact_ungrounded(
  text: string,
  ungrounded: Claim[],
): { text: string; redacted: Claim[] } {
  const enforce = ungrounded.filter((c) => PROVENANCE_POLICY[c.kind] === 'enforce');
  let out = text;
  const redacted: Claim[] = [];
  for (const c of enforce) {
    if (!out.includes(c.text)) continue;
    out = out.split(c.text).join(REDACTION_MARKER[c.kind]);
    redacted.push(c);
  }
  return { text: out, redacted };
}

/**
 * One-shot enforcement: extract → check → redact ENFORCED-tier claims.
 * `redacted` is the structural backstop (what was removed); `all_ungrounded`
 * (including FLAG-tier) is for the audit log and the retry nudge.
 */
export function enforce_provenance(
  text: string,
  grounding: GroundingContext,
): { text: string; redacted: Claim[]; all_ungrounded: Claim[] } {
  const all_ungrounded = find_ungrounded_claims(text, grounding);
  const { text: redacted_text, redacted } = redact_ungrounded(text, all_ungrounded);
  return { text: redacted_text, redacted, all_ungrounded };
}

function fmt_claim(c: Claim): string {
  return c.kind === 'quote' ? `quote ${c.text}` : `${c.kind} \`${c.text}\``;
}

/**
 * The chat-path retry nudge — injected as a user message so the model
 * gets one chance to ground or drop the unsourced specifics cleanly
 * before they're hard-redacted. Names every ungrounded claim (enforced
 * first, since those WILL be removed) so the model knows exactly what to
 * fix. Mirrors the ghost-promise / fabricated-save nudge idiom.
 */
export function provenance_retry_nudge(ungrounded: Claim[]): string {
  const enforce = ungrounded.filter((c) => PROVENANCE_POLICY[c.kind] === 'enforce');
  const flag = ungrounded.filter((c) => PROVENANCE_POLICY[c.kind] === 'flag');
  const enforce_list = enforce.map(fmt_claim).join('; ');
  const flag_list = flag.map(fmt_claim).join('; ');
  return (
    `[PROVENANCE GUARD — internal system note, not from the user]\n\n` +
    `Your reply states specifics that don't trace to anything you ` +
    `retrieved this turn — no tool result, no conversation history, no ` +
    `retrieved note contains them. That means they came from memory, ` +
    `which for a specific identifier, quote, date, or figure is a ` +
    `fabrication, however plausible it reads.\n\n` +
    `Unsourced and WILL BE REMOVED if you keep them: ${enforce_list || '(none)'}.\n` +
    (flag_list ? `Also unverified — double-check or drop: ${flag_list}.\n` : '') +
    `\nRe-roll this turn. For each one, exactly one of:\n` +
    `  (a) If you hold a tool that resolves it (web_search, ` +
    `web_fetch_clean, search_library, a teammate consult), CALL IT now ` +
    `and quote the real value from the result.\n` +
    `  (b) If you can't fetch it this turn, REMOVE the specific and say ` +
    `what you'd need to confirm it — "I don't have the order number ` +
    `confirmed; want me to look it up?" A grounded, less-specific answer ` +
    `beats a fabricated precise one.\n\n` +
    `Write the corrected answer DIRECTLY, in your normal voice. The user ` +
    `never sees this note, so do NOT apologize, do NOT say you "fabricated" ` +
    `anything, do NOT announce that you're "resetting" or "being honest," ` +
    `and do NOT mention this guard. Just give the grounded reply.\n\n` +
    `Do not restate the unsourced specific. This is your one retry.`
  );
}
