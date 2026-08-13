/**
 * Data-denial guard — "query before you say it's not there" (2026-06-12).
 *
 * The incident class: a specialist makes a DEFINITIVE absence claim about
 * user data — "no heart rate, no calories, distance and duration only",
 * "nothing was recorded", "I don't have a record of that" — without having
 * run (or exhausted) the reads available to it THAT TURN. Astrid told the
 * owner a ride had no HR/kcal and speculated about Watch sensor problems
 * while the data sat in her own stores. A wrong denial is the same failure
 * mode as a fabricated assertion: an unverified claim dressed up as fact
 * (the knowledge-floor snippet already says so for vault reads; this guard
 * makes it ENFORCED, for every store, for every current and future
 * specialist, with zero persona edits).
 *
 * Complementary to the read-failure guard (specialist_runtime 1b): that one
 * fires when a read FAILED and the reply answers over it; this one fires
 * when the reply claims ABSENCE and no read that could verify the claim ever
 * ran. Between them: failed-read → recover-or-surface, no-read-denial →
 * query-before-concluding.
 *
 * Two-layer shape (mirrors fact_critic.ts / capture_quality.ts):
 *
 *   Layer 1 — deterministic candidate generator (no LLM): recall-biased
 *     sentence matcher for absence-claim shapes. Replies with no denial-
 *     shaped sentence skip everything — the common path costs nothing.
 *     The pre-filter is a CANDIDATE GENERATOR, never the decider.
 *
 *   Layer 2 — cheap planner-role judge, candidates only: given the turn's
 *     COMPLETE tool ledger and the read tools available, buckets each
 *     candidate (not-an-absence-claim / verified-absence / unverified-
 *     absence) and returns only the violations — denials with no backing
 *     query. The verified-vs-unverified line lives in the judge prompt,
 *     not in code, so it generalizes past any phrase list.
 *
 * FAIL-OPEN, always. Judge error / unparseable output / absent router /
 * empty candidate set → no findings. The enforcement action is the same
 * one-retry nudge the provenance/fact-critic guards use; the runtime owns
 * the latch, the shared re-roll budget, the voice/TEST_MODE skips, and the
 * HEARTH_DATA_DENIAL_GUARD kill switch.
 */

import { z } from 'zod';
import { judgment_role, type LLMRouter } from '@core/llm';

/** One absence claim the judge deemed unbacked by any query this turn. */
export interface DenialFinding {
  /** The candidate sentence, as extracted from the reply. */
  claim: string;
  /** The available read tool most likely to verify it ('' if unclear). */
  tool_hint: string;
  /** Why the judge flagged it (one short clause). */
  reason: string;
}

export interface DataDenialResult {
  /** True when the LLM judge actually ran (false = pre-filter skip). */
  checked: boolean;
  /** Absence claims with no backing query. Empty on fail-open paths. */
  unverified: DenialFinding[];
}

// ── Layer 1: denial-claim candidate generation ──────────────────────────
//
// Recall-biased by design — the judge is the decider. Each pattern names a
// SHAPE a definitive data-absence claim takes; sentences matching any one
// become candidates. Conversational negation ("no worries") and questions
// are filtered cheaply because they're never absence CLAIMS, but everything
// else ambiguous rides through to the judge.

const DATA_NOUN =
  '(?:data|records?|entr(?:y|ies)|logs?|readings?|measurements?|history|' +
  'metrics?|results?|sessions?|workouts?|rides?|captures?|notes?|files?|' +
  'documents?|receipts?|photos?|messages?|events?|appointments?|signal|' +
  'samples?|packets?|info(?:rmation)?|details?|trace|heart[- ]?rate|hr|' +
  'calories?|kcal|stats?|numbers?)';

const DENIAL_PATTERNS: readonly RegExp[] = [
  // "no heart rate data", "there's no record of", "there are no entries"
  new RegExp(
    `\\b(?:there(?:'s| is| are| was| were)\\s+no|no)\\s+(?:[\\w'-]+\\s+){0,3}?${DATA_NOUN}\\b`,
    'i',
  ),
  // "there's nothing …" — calendar/log/store emptiness claims
  /\bthere(?:'s| is| was)\s+nothing\b/i,
  // "wasn't recorded", "isn't synced", "weren't captured"
  /\b(?:was|were|is|are)(?:n't| not)\s+(?:recorded|logged|captured|saved|stored|synced|tracked|measured|uploaded|received|registered)\b/i,
  // "didn't record", "never synced", "didn't come through", "didn't make it"
  /\b(?:did(?:n't| not)|never)\s+(?:record|log|capture|save|store|sync|track|measure|upload|register|come\s+through|make\s+it|show\s+up|arrive|transfer)\b/i,
  // "nothing was recorded", "nothing in your log", "nothing on file"
  /\bnothing\s+(?:was\s+|got\s+)?(?:recorded|logged|captured|saved|stored|synced|tracked|on\s+file|in\s+(?:the|your|my|her|his))\b/i,
  // "I don't have any record of", "I can't see any data on"
  new RegExp(
    `\\bI\\s+(?:don't|do\\s+not|can't|cannot)\\s+(?:have|see|find)\\b[^.!?\\n]{0,40}?\\b${DATA_NOUN}\\b`,
    'i',
  ),
  // "the HR data is missing / absent / blank / unavailable / not there"
  new RegExp(
    `\\b${DATA_NOUN}[^.!?\\n]{0,50}\\b(?:missing|absent|empty|blank|unavailable|not\\s+(?:there|present|available|showing))\\b`,
    'i',
  ),
  // "only distance and duration were recorded", "shows only steps"
  /\bonly\s+(?:[\w'-]+\s+){0,4}?(?:was|were|got|came|made|is|are)?\s*(?:recorded|logged|captured|synced|available|came\s+through|made\s+it|tracked)\b/i,
  /\b(?:shows?|recorded|logged|captured|tracked|synced|came\s+through\s+with|have|has|got)\s+only\b/i,
  // "isn't showing up", "not showing in your data"
  /\b(?:isn't|aren't|not)\s+showing(?:\s+up)?\b/i,
  // "I don't have X recorded (yet)" — possession-of-recorded-data denial.
  // The live Kristi shape (2026-06-12 shakeout): "I don't have the Dell
  // entry tower base-unit teardowns recorded yet" names a domain noun the
  // DATA_NOUN list can't enumerate, so the recorded-participle is the
  // anchor instead.
  /\b(?:don't|do\s+not|doesn't|does\s+not|haven't|have\s+not)\s+have\b[^.!?\n]{0,60}\b(?:recorded|logged|captured|tracked|saved|stored|on\s+file)\b/i,
];

/**
 * Curly→straight quote fold applied to the reply before pattern matching.
 * Live models emit U+2019 ("don't" as "don’t"); the patterns are authored
 * straight — without the fold a real denial sails past every pattern (the
 * 2026-06-12 live shakeout caught Kristi's "I don’t have the teardowns
 * recorded yet" doing exactly that, the same class the eval harness's
 * fold_quotes closed the same evening). Candidates are emitted in FOLDED
 * form; the judge maps its flags back against them, so the flow stays
 * internally consistent.
 */
function fold_quotes(s: string): string {
  return s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
}

// Pure conversational negation — never a data claim, drop without a judge
// call. Deliberately tiny: this trims OBVIOUS noise from the candidate
// stream, it is not the decider (the judge handles everything ambiguous).
const CONVERSATIONAL_NOISE =
  /\bno\s+(?:worries|problem|rush|hurry|pressure|big\s+deal|judgment|judgement|shame|stress|need\s+to|obligation|wrong\s+answer)\b/i;

/** Split a reply into sentence-ish units (newlines and ./!/? boundaries). */
function split_sentences(reply: string): string[] {
  const out: string[] = [];
  const re = /[^.!?\n]+[.!?]?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(reply)) !== null) {
    const s = m[0].trim();
    if (s.length > 0) out.push(s);
  }
  return out;
}

/**
 * Layer 1: the denial-shaped sentences in a reply. Recall-biased; capped.
 * An empty return means the guard costs this turn nothing further.
 */
export function extract_denial_candidates(reply: string, cap = 6): string[] {
  const text = fold_quotes((reply || '').trim());
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const sentence of split_sentences(text)) {
    // Questions aren't claims ("did the Watch not sync?").
    if (sentence.endsWith('?')) continue;
    if (!DENIAL_PATTERNS.some((re) => re.test(sentence))) continue;
    // A sentence whose ONLY negation is conversational noise is not a
    // candidate — but if it also matches a data shape elsewhere, the
    // stripped form decides.
    if (
      CONVERSATIONAL_NOISE.test(sentence) &&
      !DENIAL_PATTERNS.some((re) => re.test(sentence.replace(CONVERSATIONAL_NOISE, '')))
    ) {
      continue;
    }
    const trimmed = sentence.length > 240 ? sentence.slice(0, 240) + '…' : sentence;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= cap) break;
  }
  return out;
}

// ── Layer 2: the LLM judge ──────────────────────────────────────────────

const JUDGE_SYSTEM =
  'You are a data-grounding auditor for a household assistant that holds ' +
  'READ TOOLS backed by real data stores (health metrics, workout sessions, ' +
  'vault notes, library files, calendars, device states, ledgers). You are ' +
  'given (1) CANDIDATE sentences from its finished reply that appear to ' +
  'claim data is absent, missing, unrecorded, or invisible, (2) the ' +
  'COMPLETE ledger of tool calls it actually made this turn, and (3) the ' +
  'read tools available to it.\n\n' +
  'For each candidate, decide which bucket it falls in:\n' +
  '  (a) NOT A DATA-ABSENCE CLAIM — conversational negation, an opinion or ' +
  'hedge about its own reasoning, a statement about its own capabilities, ' +
  'a promise to check, a quote of the user, or absence of something none ' +
  'of its read tools could plausibly hold. Not a violation.\n' +
  '  (b) VERIFIED ABSENCE — a call in the ledger plausibly queried for the ' +
  'claimed data this turn AND its result is consistent with the claim: it ' +
  'came back empty, errored, or explicitly without that data. The claim ' +
  'honestly reports what a real query returned. Not a violation.\n' +
  '  (c) UNVERIFIED ABSENCE — the claim asserts data does not exist / was ' +
  'never recorded / did not come through / cannot be seen, AND one of the ' +
  'available read tools could plausibly hold that data, AND either (i) no ' +
  'call in the ledger actually queried for it, or (ii) a call DID query ' +
  'and its result CONTRADICTS the claim — the ledger shows the data ' +
  'present while the reply says there is none. The assistant concluded ' +
  'absence without looking, or looked and misread the result. These are ' +
  'the violations.\n\n' +
  'Default to (c) when a definitive absence claim about user data has no ' +
  'backing query or contradicts a result in the ledger — "I checked ' +
  'nothing, but it is not there" and "the query returned it, but I say ' +
  'there is none" are both never acceptable. Return ONLY bucket (c). Do ' +
  'not invent candidates that were not given to you.\n\n' +
  'Reply with ONLY this JSON, nothing else:\n' +
  '{"flagged": [{"claim": "<candidate text, verbatim>", "tool_hint": ' +
  '"<the one available read tool most likely to verify it>", "reason": ' +
  '"<short why>"}]}';

const JudgeSchema = z.object({
  flagged: z
    .array(
      z.object({
        claim: z.string().min(1),
        tool_hint: z.string().default(''),
        reason: z.string().default(''),
      }),
    )
    .default([]),
});

function strip_fence(s: string): string {
  const m = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  return (m ? m[1]! : s).trim();
}

/** The minimal tool-call shape the guard needs from the runtime ledger. */
export interface LedgerCall {
  name: string;
  input: unknown;
  result?: unknown;
  error?: string;
}

const LEDGER_CALL_CAP = 20;
const LEDGER_RESULT_PREVIEW_CHARS = 280;
const LEDGER_INPUT_PREVIEW_CHARS = 160;

/** Render the turn's complete tool ledger for the judge. Chronological —
 *  "did a query cover the claim" reads forward; the LAST calls are kept
 *  when over the cap because they're the ones the reply most reflects. */
function render_ledger(calls: ReadonlyArray<LedgerCall>): string {
  if (calls.length === 0) {
    return 'NONE — the assistant made no tool calls at all this turn.';
  }
  const shown = calls.slice(-LEDGER_CALL_CAP);
  const skipped = calls.length - shown.length;
  const lines = shown.map((c, i) => {
    const args = JSON.stringify(c.input ?? {}).slice(0, LEDGER_INPUT_PREVIEW_CHARS);
    const status = c.error
      ? `ERROR: ${c.error.slice(0, 120)}`
      : `ok: ${(typeof c.result === 'string' ? c.result : JSON.stringify(c.result ?? null)).slice(0, LEDGER_RESULT_PREVIEW_CHARS)}`;
    return `  ${i + 1}. ${c.name}(${args}) → ${status}`;
  });
  return (skipped > 0 ? `  (… ${skipped} earlier calls omitted)\n` : '') + lines.join('\n');
}

/**
 * Assess whether a finished reply makes absence claims no query this turn
 * can back. The single entry point; wired into the chat finalize path in
 * specialist_runtime.ts. Fail-open on every error path.
 */
export async function assess_data_denial(args: {
  reply: string;
  /** The turn's COMPLETE tool ledger (tool_calls_made). */
  tool_calls: ReadonlyArray<LedgerCall>;
  /** Read-tier tools on the specialist's surface — the "could have
   *  called" set the judge weighs claims against. */
  read_tools: ReadonlyArray<{ name: string; description: string }>;
  llm?: LLMRouter;
}): Promise<DataDenialResult> {
  const { reply, tool_calls, read_tools, llm } = args;
  // No reads to point at → nothing to enforce; no router → fail open.
  if (!reply || !llm || read_tools.length === 0) {
    return { checked: false, unverified: [] };
  }
  const candidates = extract_denial_candidates(reply);
  if (candidates.length === 0) return { checked: false, unverified: [] };

  let role;
  try {
    role = judgment_role(llm);
  } catch {
    return { checked: false, unverified: [] };
  }

  const candidate_list = candidates.map((c, i) => `${i + 1}. "${c}"`).join('\n');
  const tools_list = read_tools
    .slice(0, 40)
    .map((t) => `  - ${t.name}: ${t.description.slice(0, 140)}`)
    .join('\n');

  let resp;
  try {
    resp = await role.provider.complete({
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        {
          role: 'user',
          content:
            `CANDIDATE ABSENCE CLAIMS (from the reply):\n${candidate_list}\n\n` +
            `REPLY (context):\n${reply.slice(0, 3000)}\n\n` +
            `TOOL CALLS THIS TURN (complete ledger):\n${render_ledger(tool_calls)}\n\n` +
            `READ TOOLS AVAILABLE TO THE ASSISTANT:\n${tools_list}\n\n` +
            `Reply with ONLY the JSON.`,
        },
      ],
      ...role.defaults,
      // pins AFTER the spread so a yaml regression can't flip them (llm.ts depth-tier note)
      temperature: 0.1,
      max_tokens: 500,
      think: false,
    });
  } catch {
    return { checked: true, unverified: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(strip_fence(resp.content));
  } catch {
    return { checked: true, unverified: [] };
  }
  const r = JudgeSchema.safeParse(parsed);
  if (!r.success) return { checked: true, unverified: [] };

  // Defensive: only trust flags that map back to a candidate WE produced;
  // sanitize tool hints to tools that actually exist on the surface.
  const cand_keys = new Map(candidates.map((c) => [c.toLowerCase(), c] as const));
  const tool_names = new Set(read_tools.map((t) => t.name));
  const unverified: DenialFinding[] = [];
  const emitted = new Set<string>();
  for (const f of r.data.flagged) {
    const key = f.claim.trim().toLowerCase();
    const original = cand_keys.get(key);
    if (!original || emitted.has(key)) continue;
    emitted.add(key);
    unverified.push({
      claim: original,
      tool_hint: tool_names.has(f.tool_hint.trim()) ? f.tool_hint.trim() : '',
      reason: f.reason || 'absence asserted with no backing query this turn',
    });
  }
  return { checked: true, unverified };
}

/**
 * The one-retry nudge. Injected as a user message so the model gets exactly
 * one chance to actually query its stores before concluding absence.
 * Mirrors fact_critic_retry_nudge's contract: never user-visible, no
 * apologies, no meta-narration, write the corrected reply directly.
 */
export function data_denial_retry_nudge(
  findings: ReadonlyArray<DenialFinding>,
  read_tools: ReadonlyArray<{ name: string }>,
): string {
  const list = findings
    .map((f) => `  - "${f.claim}"${f.tool_hint ? ` — try \`${f.tool_hint}\`` : ''}`)
    .join('\n');
  const tool_names = read_tools
    .slice(0, 12)
    .map((t) => `\`${t.name}\``)
    .join(', ');
  return (
    `[DATA-DENIAL GUARD — internal system note, not from the user]\n\n` +
    `Your reply tells the user that data is missing, unrecorded, or ` +
    `unavailable — but no read you ran this turn actually checked for it. ` +
    `Concluding "the data isn't there" without querying is the same failure ` +
    `as fabricating data: an unverified claim stated as fact. Your stores ` +
    `often DO hold what was just denied (this exact failure has shipped: a ` +
    `ride's heart-rate data existed while the reply said it didn't).\n\n` +
    `Unverified absence claims in your reply:\n${list}\n\n` +
    `Re-roll this turn. For each claim, exactly one of:\n` +
    `  (a) If a tool result ALREADY in this conversation contains the ` +
    `data, answer from that result — re-read it carefully; the denial ` +
    `was wrong.\n` +
    `  (b) Otherwise CALL the read tool that covers it NOW (you hold: ` +
    `${tool_names}) and answer from what it actually returns.\n` +
    `  (c) Only if your query comes back empty or errors may you state ` +
    `the data is absent — and say what you checked, plainly ("I queried ` +
    `your workout sessions; nothing recorded for this morning").\n\n` +
    `Write the corrected reply DIRECTLY, in your normal voice. The user ` +
    `never sees this note, so do NOT apologize, do NOT mention any check ` +
    `or guard, and do NOT announce a correction. This is your one retry.`
  );
}

/**
 * The per-specialist "data map" — a one-paragraph structural injection for
 * chat system prompts enumerating the specialist's data-bearing read tools
 * BY NAME (names only — the tool block above it already carries each
 * tool's full description; repeating them would re-spend the prompt budget
 * the voice work fought to reclaim). Generated from the live surface, so
 * every future specialist and every future read tool is covered with zero
 * persona edits. Empty string when there are no data reads to point at.
 */
export function render_data_map_section(
  read_tools: ReadonlyArray<{ name: string }>,
  cap = 24,
): string {
  if (read_tools.length === 0) return '';
  const names = read_tools
    .slice(0, cap)
    .map((t) => `\`${t.name}\``)
    .join(', ');
  return (
    `**Your data stores are queryable — look before you say "it's not ` +
    `there."** You hold read tools backed by real stores: ${names}. ` +
    `A statement like "there's no heart-rate data", "nothing was recorded", ` +
    `or "it didn't sync" is a DATA claim — it requires a query that came ` +
    `back empty THIS turn, not a hunch. If a first read looks incomplete, ` +
    `query the next-most-specific store before concluding the data doesn't ` +
    `exist. State absence only after you've looked, and say what you ` +
    `checked.\n\n`
  );
}
