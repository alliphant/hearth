/**
 * Semantic fact critic — Durable Truth Phase 1.5 (2026-05-31).
 *
 * Phase 1 (provenance.ts) catches load-bearing claims by TOKEN SHAPE:
 * docket-style identifiers (E-23734) and quoted strings. That closed the
 * Ponds Fire class — but only because Ruby invented an *identifier*. The
 * dominant civic-fabrication shape carries no identifier and no quote: a
 * confidently-invented council agenda ("Budget Work Session: FY2027
 * Budget"), a plan name carrying invented details, an invented trail, a
 * made-up address. The regex extractor produces NO `named_entity` claims (it
 * never had an extractor for the kind), and FLAG-tier dates/numbers never
 * trigger the retry — so that whole class reached the user unguarded.
 *
 * IMPORTANT: "ungrounded" means NOT RETRIEVED THIS TURN — not "nonexistent."
 * The model can't tell its own memory from a tool result, so even a REAL
 * entity asserted without fetching it is a violation: the surrounding
 * specifics (dates, priorities, outcomes) get filled from memory and are
 * routinely wrong. Worked case: Pleasantville's "Strategic Trails Plan" IS a
 * real, Council-adopted-2025 plan — yet Ruby asserted it with invented
 * priority details after a failed read (verified 2026-06-05: real noun,
 * fabricated specifics). The critic must flag it all the same. (Do NOT cite
 * "Strategic Trails Plan" as an example of a made-up name — it isn't one.)
 *
 * You cannot close it with more regex shapes: hallucination is "a claim
 * never retrieved," not a token pattern, and enumerating shapes is the
 * exact anti-pattern the repo bans (the private dev log). The generalizing layer is
 * SEMANTIC — an LLM that, given the reply and the EVIDENCE the specialist
 * actually had this turn, judges which specifics assert volatile/current
 * state that was never retrieved.
 *
 * Mirrors the blessed two-layer shape of src/connectors/capture_quality.ts:
 *
 *   Layer 1 — structural pre-filter (deterministic, no LLM): generate
 *     candidate specifics from the reply (proper-noun phrases, acronyms,
 *     dates, magnitudes) and drop the ones already present in the
 *     evidence. Replies that used their tools well leave few/no ungrounded
 *     candidates and skip the model call entirely — the common, low-
 *     latency path. The pre-filter is a CANDIDATE GENERATOR, never the
 *     decider (so it's not a blacklist); the judge decides.
 *
 *   Layer 2 — LLM judge (the dynamic core, ungrounded candidates only):
 *     a cheap planner-role call that separates (a) supported-by-evidence
 *     and (b) stable general knowledge from (c) UNSUPPORTED VOLATILE
 *     CLAIMS — the fabrications. Only (c) is returned.
 *
 * FAIL-OPEN, always. Judge error / unparseable output / absent router /
 * empty candidate set → no findings. A critic outage must never block a
 * reply; it is only ever stricter on a CONFIDENT flag. The enforcement
 * ACTION (per Jasper's 2026-05-30 direction: nudge, not hard-redact) is the
 * one-retry nudge — the same mechanism provenance.ts uses, generalized to
 * this class via fact_critic_retry_nudge().
 */

import { z } from 'zod';
import { judgment_role, type LLMRouter } from '@core/llm';
import {
  extract_claims,
  squash,
  normalize_text,
  type GroundingContext,
  type ClaimKind,
} from './provenance';

/** One claim the critic judged unsupported by the turn's evidence. */
export interface FactFinding {
  /** The exact specific as it appears in the reply. */
  claim: string;
  /** Coarse kind, for the audit log + the nudge wording. */
  kind: 'named_entity' | 'date' | 'number';
  /** Why the judge flagged it (one short clause). */
  reason: string;
}

export interface FactCriticResult {
  /** True when the LLM judge actually ran (false = skipped by pre-filter). */
  checked: boolean;
  /** Unsupported volatile claims. Empty on the fail-open paths. */
  unsupported: FactFinding[];
}

// ── Layer 1: candidate generation (recall-biased; the judge filters) ────

// Proper-noun phrases: runs of TitleCase tokens, optionally joined by
// lowercase connectors. Catches "Budget Work Session", "Strategic Trails
// Plan", "Mill Creek Trail", "City Council".
const CONNECTOR = '(?:of|the|and|for|to|in|on|at|de|del|la|el|von|van)';
// No '.' in the token class — a trailing period is a sentence boundary,
// and including it lets a phrase greedily span "Work Session. Agenda
// Highlights" into one bogus candidate.
const TITLE_TOKEN = "[A-Z][\\w&'’\\-]*";
const PROPER_PHRASE_RE = new RegExp(
  `\\b(${TITLE_TOKEN}(?:\\s+(?:${CONNECTOR}\\s+)?${TITLE_TOKEN}){0,7})\\b`,
  'g',
);
// Acronyms / alnum codes: FY2027, the clinic, P&Z, HB24, I-25, IECC. An
// uppercase-led token carrying a second uppercase letter or a digit.
const ACRONYM_RE = /\b([A-Z][A-Z0-9][\w&'’\-]*)\b/g;

// Sentence-initial single capitals and pure determiners/pronouns that the
// proper-phrase regex sweeps up as one-token "phrases" — pure noise.
const SOLO_STOPWORDS = new Set([
  'The', 'A', 'An', 'This', 'That', 'These', 'Those', 'It', 'He', 'She',
  'They', 'We', 'You', 'I', 'His', 'Her', 'Their', 'Our', 'My', 'Your',
  'And', 'But', 'Or', 'So', 'If', 'When', 'While', 'Here', 'There', 'Then',
  'Yes', 'No', 'From', 'For', 'To', 'In', 'On', 'At', 'As', 'Of', 'By',
  'Per', 'Re', 'Also', 'Now', 'Next',
]);

/** A single-token candidate is worth keeping only if it's a real
 *  code/acronym — has a digit (FY2027), a connector char (P&Z, I-25), or
 *  ≥3 uppercase letters (the clinic, FCPD). Drops AM/PM/US/TV/OK-class noise and
 *  bare TitleCase words ("Tuesday", "June" — weekdays/months are handled
 *  as date claims, not entities). */
function keep_solo_token(tok: string): boolean {
  if (SOLO_STOPWORDS.has(tok)) return false;
  if (/\d/.test(tok)) return true;
  if (/[&\-]/.test(tok)) return true;
  return (tok.match(/[A-Z]/g)?.length ?? 0) >= 3;
}

// Leading determiners/possessives are not part of the entity — strip
// them so "The Mill Creek Trail" → "Mill Creek Trail" (and grounds /
// matches the same way the source document spells it).
const LEADING_DET = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those',
  'its', 'his', 'her', 'their', 'our', 'my', 'your',
]);

// Date/time function words are date claims, not entity material — the
// date extractor owns them. Left in, they glue onto neighbors and mint
// bogus entities: "1:00 PM Friday" → "PM Friday", "Tuesday Winds up to
// 30 mph" → "Tuesday Winds" (both live false positives, 2026-06-09).
// Stripped from phrase EDGES only, so "Friday Night Lights" the show
// would lose its edge token but interior structure survives — a recall
// trade we take for never flagging a time-of-day fragment as an entity.
const DATETIME_TOKENS = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct',
  'nov', 'dec', 'am', 'pm', 'today', 'tomorrow', 'tonight', 'yesterday',
  'noon', 'midnight', 'morning', 'afternoon', 'evening', 'week', 'weekend',
]);

/** Walk back over inline whitespace: is `idx` the first content of a
 *  sentence/line/list item? */
function at_sentence_start(text: string, idx: number): boolean {
  let i = idx - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--;
  if (i < 0) return true;
  const ch = text[i]!;
  return (
    ch === '\n' || ch === '.' || ch === '!' || ch === '?' || ch === ':' ||
    ch === ';' || ch === '*' || ch === '-' || ch === '–' || ch === '—'
  );
}

/**
 * Capitalized tokens that appear somewhere OTHER than a sentence start —
 * the document's own evidence that the token is TitleCase by nature
 * ("Beatrice" in "to Beatrice") rather than by position ("Flagged" in
 * "Flagged to Beatrice", a live false positive 2026-06-09). Used to
 * decide whether a phrase's sentence-initial first word is entity
 * material or just a capitalized common word.
 */
function mid_sentence_capitalized_tokens(text: string): ReadonlySet<string> {
  const out = new Set<string>();
  const re = /[A-Z][\w&'’\-]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!at_sentence_start(text, m.index)) out.add(m[0]);
  }
  return out;
}

/**
 * Markdown structure (fenced code, ATX/setext headers) is reply SCAFFOLDING,
 * not factual prose — but its TitleCase content ("### Summary of Actions
 * Taken", "**New Form Factor**", "### Dell Precision Naming Structure") gets
 * swept up as bogus named-entity candidates, flooding the judge with non-
 * claims and tripping the retry on nearly every reply for a markdown-heavy,
 * acronym-dense specialist (the Kristi Recon-Desk false-positive cascade,
 * 2026-06-08). Drop headers + code fences before NAMED-ENTITY extraction
 * ONLY. A real entity introduced in a header is virtually always restated in
 * the prose below (where it stays a candidate), so recall is preserved; and
 * dates/numbers — a genuine fabrication risk even inside a header — still run
 * on the RAW reply via extract_claims(), so this never softens those.
 */
function strip_markdown_structure(reply: string): string {
  return (
    reply
      // fenced code blocks (``` … ``` / ~~~ … ~~~), including an unclosed
      // trailing fence ("…I ran: ```python" with no closer) — code is not a
      // factual claim, and the spiral's hallucinated code blocks land here.
      .replace(/(?:^|\n)[ \t]*(?:```|~~~)[\s\S]*?(?:(?:```|~~~)[ \t]*(?=\n|$)|$)/g, ' ')
      // ATX header lines: the whole "#…### Heading Text" line is a label.
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+.*$/gm, ' ')
      // Bold spans — "**Previous Form Factor**", "**Action Required**". These
      // are the reply's labels/emphasis, not factual entities; a genuinely
      // novel entity that's also bolded recurs in the prose. (Single-`*`
      // italic + `_` are left alone — too entangled with lists/math to strip
      // safely, and rarely the label carrier.)
      .replace(/\*\*[^*\n]+\*\*/g, ' ')
      .replace(/__[^_\n]+__/g, ' ')
  );
}

function extract_named_candidates(reply: string): string[] {
  const out = new Set<string>();
  const prose = strip_markdown_structure(reply);
  const mid_caps = mid_sentence_capitalized_tokens(prose);
  for (const re of [PROPER_PHRASE_RE, ACRONYM_RE]) {
    re.lastIndex = 0;
    const is_phrase_re = re === PROPER_PHRASE_RE;
    let m: RegExpExecArray | null;
    while ((m = re.exec(prose)) !== null) {
      const raw = (m[1] ?? '').trim().replace(/[.'’\-&]+$/, '');
      if (!raw) continue;
      let words = raw.split(/\s+/).filter(Boolean);
      while (words.length > 1 && LEADING_DET.has(words[0]!.toLowerCase())) {
        words = words.slice(1);
      }
      // Sentence-initial first word that is capitalized ONLY by position
      // (never seen mid-sentence, not acronym-shaped) is a common word,
      // not entity material — "Flagged to Beatrice" → "Beatrice".
      // Phrases only: a solo acronym at sentence start ("NWS issued…")
      // already proves itself via keep_solo_token.
      if (
        is_phrase_re &&
        words.length > 1 &&
        at_sentence_start(prose, m.index) &&
        !mid_caps.has(words[0]!) &&
        !keep_solo_token(words[0]!)
      ) {
        words = words.slice(1);
        // The stripped word may expose a lowercase connector ("to
        // Beatrice") — connectors aren't entity material either.
        while (words.length > 0 && /^[a-z]/.test(words[0]!)) {
          words = words.slice(1);
        }
      }
      // Date/time edge tokens belong to the date extractor, not entities.
      while (words.length > 0 && DATETIME_TOKENS.has(words[0]!.toLowerCase())) {
        words = words.slice(1);
      }
      while (
        words.length > 0 &&
        DATETIME_TOKENS.has(words[words.length - 1]!.toLowerCase())
      ) {
        words = words.slice(0, -1);
      }
      if (words.length === 0) continue;
      const phrase = words.join(' ');
      const cap_words = words.filter((w) => /^[A-Z]/.test(w)).length;
      // Multi-capital phrases are real entities; single tokens must clear
      // the code/acronym bar.
      if (cap_words >= 2) out.add(phrase);
      else if (words.length === 1 && keep_solo_token(phrase)) out.add(phrase);
    }
  }
  return [...out];
}

/** Is this specific present in the evidence (either normalized substring
 *  or squashed substring)? Mirrors provenance's two-form grounding check
 *  so "FY2027" matches evidence "FY 2027" and "Mill Creek Trail" matches
 *  regardless of spacing. */
function present_in_evidence(specific: string, grounding: GroundingContext): boolean {
  const sq = squash(specific);
  if (sq.length >= 4 && grounding.squashed.includes(sq)) return true;
  const nt = normalize_text(specific);
  return nt.length > 0 && grounding.text.includes(nt);
}

interface Candidate {
  text: string;
  kind: FactFinding['kind'];
}

/** All ungrounded specifics worth asking the judge about: named-entity
 *  phrases plus FLAG-tier dates/numbers from the provenance extractors
 *  (identifiers + quotes are handled by provenance's enforced path, so we
 *  leave them out here). Deduped, capped, grounded ones removed. */
function ungrounded_candidates(
  reply: string,
  grounding: GroundingContext,
  cap = 24,
): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  const push = (text: string, kind: FactFinding['kind']) => {
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (present_in_evidence(text, grounding)) return;
    out.push({ text, kind });
  };
  for (const name of extract_named_candidates(reply)) push(name, 'named_entity');
  const FLAG_KINDS: ReadonlyArray<ClaimKind> = ['date', 'number'];
  for (const c of extract_claims(reply)) {
    if (FLAG_KINDS.includes(c.kind)) push(c.text, c.kind as FactFinding['kind']);
  }
  return out.slice(0, cap);
}

/**
 * Deterministic Layer-1 only (no LLM judge): the unsourced specific phrases
 * in `text` given the turn's grounding. Used to gate durable-knowledge WRITES
 * — a `record_*`/`upsert_*` whose content carries specifics that appear in no
 * successful tool result this turn is likely a fabrication being laundered
 * into the vault (where it would then "ground" future turns). Recall-biased
 * by design; the caller pairs it with a read-failure precondition to keep the
 * gate narrow.
 */
export function unsourced_specifics(text: string, grounding: GroundingContext): string[] {
  return ungrounded_candidates(text, grounding).map((c) => c.text);
}

// ── Layer 2: the LLM judge ──────────────────────────────────────────────

const JUDGE_SYSTEM =
  'You are a fact-grounding auditor. You are given (1) an assistant REPLY, ' +
  '(2) the EVIDENCE the assistant actually had access to this turn (tool ' +
  'results, conversation history, retrieved notes, the user message), and ' +
  '(3) a list of CANDIDATE specifics extracted from the reply that do not ' +
  'literally appear in the evidence.\n\n' +
  'For each candidate, decide which bucket it falls in:\n' +
  '  (a) SUPPORTED — the evidence backs it (maybe paraphrased/reformatted).\n' +
  '  (b) STABLE KNOWLEDGE or NON-CLAIM — a real durable fact that does NOT ' +
  'depend on this-turn retrieval, OR a candidate that is not a factual ' +
  'assertion at all: a geographic place name; a well-known institution used ' +
  'generically; a unit; common world knowledge; a STANDARD domain acronym or ' +
  'abbreviation (e.g. CAD, ISV, GPU, CPU, SKU, PSU, ECC); a product LINE or ' +
  'category named generically (e.g. "HP ZBook", "Dell Precision") without an ' +
  'invented current-state detail; a formatting/section heading or label the ' +
  'reply uses to organize itself ("Summary of Actions Taken", "Next Steps", ' +
  '"New Form Factor"); the assistant’s OWN name, a tool it holds, or ' +
  'its office/pane name; or a TEAMMATE/colleague the assistant works with ' +
  '— but ONLY when that name actually appears in the staff list in the WHO ' +
  'YOU ARE block of the evidence. A colleague name that is NOT in that ' +
  'list is bucket (c): attributing work or awareness to a staff member who ' +
  'does not exist is a fabrication, however routine it sounds. None of the ' +
  'rest are fabrications.\n' +
  '  (c) UNSUPPORTED SPECIFIC — the candidate asserts a VOLATILE or ' +
  'CURRENT-STATE fact that REQUIRED retrieval and was NOT in the evidence: ' +
  'a specific meeting date/time, an agenda item, a vote or its outcome, a ' +
  'price/figure, a named document’s contents, a person’s current ' +
  'role/position, an event that is claimed to have happened or be scheduled, ' +
  'a specific named project/plan presented as real. These are fabrications ' +
  'however fluent they read.\n\n' +
  'Return ONLY bucket (c) — the unsupported specifics. When in doubt ' +
  'between (b) and (c), prefer (c) if the reply presents the candidate as a ' +
  'specific factual claim the user would act on. Do not invent candidates ' +
  'that were not given to you.\n\n' +
  'Reply with ONLY this JSON, nothing else:\n' +
  '{"flagged": [{"claim": "<exact candidate text>", "kind": "named_entity"|' +
  '"date"|"number", "reason": "<short why>"}]}';

const JudgeSchema = z.object({
  flagged: z
    .array(
      z.object({
        claim: z.string().min(1),
        kind: z.enum(['named_entity', 'date', 'number']).default('named_entity'),
        reason: z.string().default(''),
      }),
    )
    .default([]),
});

// Evidence budget for the judge prompt. Read at call time (matches the
// HEARTH_FACT_CRITIC kill-switch idiom). Was a hardcoded 6000 — far too
// small for heavy multi-fetch research turns (Kristi/Ruby run 20-40 tool
// calls), so correctly-retrieved facts fell outside the window and were
// flagged "ungrounded" → false-positive re-roll of a CORRECT answer (the
// visible-rewrite trust bug). The runtime feeds evidence newest-first so the
// latest findings survive this cut. Tune via HEARTH_FACT_CRITIC_EVIDENCE_CHARS
// (dial back if the planner's shared :8088 slot contends); ~30k chars ≈ 7.5k
// tokens of evidence.
function evidence_char_budget(): number {
  const raw = Number.parseInt(
    process.env.HEARTH_FACT_CRITIC_EVIDENCE_CHARS ?? '',
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

function strip_fence(s: string): string {
  const m = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  return (m ? m[1]! : s).trim();
}

/**
 * Assess whether a finished reply contains volatile specifics the
 * specialist never retrieved this turn. The single entry point; wired into
 * the chat finalize path in specialist_runtime.ts. Fail-open on every
 * error path.
 */
export async function assess_factual_grounding(args: {
  reply: string;
  grounding: GroundingContext;
  /** Readable evidence (build_grounding_evidence) — the judge's source. */
  evidence_text: string;
  llm?: LLMRouter;
  /**
   * The specialist's own structural identity — its name, role, the tools it
   * holds, its office/pane name. Folded into the grounding so SELF-REFERENCES
   * ("Recon Desk", `update_sku`, its own name) are never flagged as
   * fabrications. The system prompt that carries these is deliberately
   * EXCLUDED from turn evidence (it contains the grounding-rule worked
   * example), so without this a specialist naming its own office reads as
   * ungrounded and the critic spirals (2026-06-08). Optional → unchanged when
   * omitted.
   */
  self_identity?: string;
}): Promise<FactCriticResult> {
  const { reply, llm, self_identity } = args;
  if (!reply || !llm) return { checked: false, unsupported: [] };

  // Augment the grounding + evidence with the specialist's self-identity, so
  // a candidate that IS the specialist's own name/tool/office grounds against
  // it (present_in_evidence) and the judge sees who the assistant is.
  const grounding: GroundingContext = self_identity
    ? {
        text: args.grounding.text + ' ' + normalize_text(self_identity),
        squashed: args.grounding.squashed + squash(self_identity),
      }
    : args.grounding;
  const evidence_text = self_identity
    ? `WHO YOU ARE (names/tools/office you may use freely — not fabrications):\n${self_identity}\n\n${args.evidence_text}`
    : args.evidence_text;

  const candidates = ungrounded_candidates(reply, grounding);
  if (candidates.length === 0) return { checked: false, unsupported: [] };

  let role;
  try {
    role = judgment_role(llm);
  } catch {
    return { checked: false, unsupported: [] };
  }

  const budget = evidence_char_budget();
  const evidence =
    evidence_text.length > budget
      ? evidence_text.slice(0, budget) + '\n\n[...truncated]'
      : evidence_text || '(no evidence was retrieved this turn)';
  const candidate_list = candidates
    .map((c, i) => `${i + 1}. [${c.kind}] ${c.text}`)
    .join('\n');

  let resp;
  try {
    resp = await role.provider.complete({
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        {
          role: 'user',
          content:
            `EVIDENCE:\n${evidence}\n\n` +
            `REPLY:\n${reply.slice(0, 4000)}\n\n` +
            `CANDIDATES (not literally in evidence):\n${candidate_list}\n\n` +
            `Reply with ONLY the JSON.`,
        },
      ],
      ...role.defaults,
      // pins AFTER the spread so a yaml regression can't flip them (llm.ts depth-tier note)
      temperature: 0.1,
      max_tokens: 600,
      think: false,
    });
  } catch {
    return { checked: true, unsupported: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(strip_fence(resp.content));
  } catch {
    return { checked: true, unsupported: [] };
  }
  const r = JudgeSchema.safeParse(parsed);
  if (!r.success) return { checked: true, unsupported: [] };

  // Defensive: only trust flags that map back to a candidate WE produced
  // and that are genuinely ungrounded — never let the judge introduce a
  // new string or re-flag something the evidence supports.
  const cand_keys = new Set(candidates.map((c) => c.text.toLowerCase()));
  const unsupported: FactFinding[] = [];
  const emitted = new Set<string>();
  for (const f of r.data.flagged) {
    const claim = f.claim.trim();
    const key = claim.toLowerCase();
    if (!cand_keys.has(key)) continue;
    if (emitted.has(key)) continue;
    if (present_in_evidence(claim, grounding)) continue;
    emitted.add(key);
    unsupported.push({ claim, kind: f.kind, reason: f.reason || 'not supported by retrieved evidence' });
  }
  return { checked: true, unsupported };
}

/**
 * The one-retry nudge for the semantic-critic class — the named-entity /
 * date / figure fabrications provenance.ts can't see. Injected as a user
 * message so the model gets exactly one chance to fetch or drop the
 * unsourced specifics. Mirrors provenance_retry_nudge's idiom; shares the
 * same per-turn retry latch in the runtime.
 */
export function fact_critic_retry_nudge(findings: FactFinding[]): string {
  const list = findings
    .map((f) => `${f.kind} \`${f.claim}\`${f.reason ? ` — ${f.reason}` : ''}`)
    .join('; ');
  return (
    `[GROUNDING CHECK — internal system note, not from the user]\n\n` +
    `Your reply states specifics that don't trace to anything you ` +
    `retrieved this turn — no tool result, no conversation history, no ` +
    `retrieved note contains them. For a meeting date, an agenda item, a ` +
    `vote, a figure, a named plan/place/project, or any current-state ` +
    `fact, that means it came from training memory, which is a ` +
    `fabrication however confidently it reads.\n\n` +
    `Unsupported by anything you retrieved: ${list || '(none)'}.\n\n` +
    `Re-roll this turn. For each one, exactly one of:\n` +
    `  (a) If you hold a tool that resolves it (web_search, ` +
    `web_fetch_clean, browse_url, search_library, read_note, a teammate ` +
    `consult), CALL IT now and state only what the result actually says.\n` +
    `  (b) If you can't fetch it this turn, DROP the specific and say what ` +
    `you'd need to confirm it — "I don't have the agenda in front of me; ` +
    `want me to pull it from citygov.com?" A grounded, less-specific answer ` +
    `beats a fabricated precise one every time.\n\n` +
    `Write the corrected answer DIRECTLY, in your normal voice. The user ` +
    `never sees this note, so do NOT apologize, do NOT say you "fabricated" ` +
    `or "made up" anything, do NOT announce that you're "resetting" or ` +
    `"being honest," and do NOT mention this grounding check. Just give the ` +
    `grounded reply as if it were your first one.\n\n` +
    `Do not restate the unsourced specific as fact. This is your one retry.`
  );
}

/**
 * Phase-3 librarian-lane retry nudge. When the async librarian lane is on
 * and a librarian (Cordelia, on the A4000) has just FETCHED the questioned
 * claims, hand the primary model her cited findings to ground against —
 * instead of only telling it "you're ungrounded" (which invites a
 * re-fabrication). The librarian fetched on a separate GPU concurrently
 * with the rest of the system; this is the join.
 */
export function librarian_findings_nudge(
  findings: FactFinding[],
  librarian_findings: string,
): string {
  const list = findings.map((f) => `${f.kind} \`${f.claim}\``).join('; ');
  return (
    `[GROUNDING CHECK — internal system note, not from the user]\n\n` +
    `Your reply stated specifics that weren't grounded in anything you ` +
    `retrieved: ${list || '(none)'}. A librarian fetched them for you. ` +
    `Use ONLY these verified findings — quote what they confirm, and for ` +
    `anything they mark "unverified" or don't cover, DROP the specific and ` +
    `say you couldn't confirm it. Do not reintroduce a claim the findings ` +
    `don't support.\n\n` +
    `## Librarian findings (your only source for these specifics)\n\n` +
    `${librarian_findings}\n\n` +
    `Re-roll this turn grounded in the above. This is your one retry.`
  );
}
