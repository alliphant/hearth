/**
 * Tool-output compression — Phase 1.
 *
 * Bounds the LLM-facing copy of each tool result. The full payload
 * stays in the audit log (uncompressed, for debug + replay + the
 * "show details" UI). Only the next-round prompt sees a compacted
 * view, which is what was driving prompt-eval cost on research-heavy
 * turns (the 2026-05-24 Maggie / South-Arcade 107s synthesis lag was
 * dominated by accumulated `web_fetch_clean` markdown).
 *
 * Strategy:
 *   1. If serialized length ≤ budget, pass through verbatim.
 *   2. Otherwise, preserve the first ~30% of the budget (head — where
 *      tools put `url`, `title`, top hits, error messages).
 *   3. Walk the rest line-by-line and keep lines matching a high-
 *      signal regex (years, month names, times, money, ticket / venue /
 *      tour keywords) up to the remaining budget.
 *   4. Append a marker that quotes the elided char count so the LLM
 *      knows context was trimmed, not lost.
 *
 * Per-tool override lives on the `Tool.llm_budget` field — `'full'`
 * skips this path entirely; a number overrides the default cap. See
 * docs/design-tool-output-compression.md for the broader plan.
 */

import type { Tool } from './tool';

export const TOOL_RESULT_DEFAULT_BUDGET = 4000;

/**
 * Lines containing any of these patterns are treated as high-signal
 * and retained through truncation:
 *
 *   - 4-digit years (1900-2099) — dates, releases, vintages
 *   - month names (3+ chars, any case)
 *   - clock times (H:MM, HH:MM)
 *   - dollar amounts ($X, $ X)
 *   - ticket / event / commerce keywords
 *
 * False positives are cheap (an extra retained line); false negatives
 * lose user-relevant signal, so the regex errs toward inclusive.
 */
const HIGH_SIGNAL_RE =
  /\b(?:19|20)\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b\d{1,2}:\d{2}\b|\$\s?\d|\b(?:ticket|sold[- ]?out|festival|venue|tour|presale|on[- ]sale|headlin|admission|capacity|address|phone|email|rsvp)/i;

/**
 * Compact a serialized tool result for re-injection into the LLM's
 * next-round prompt. `budget` defaults to TOOL_RESULT_DEFAULT_BUDGET.
 *
 * Pure string transform — doesn't worry about JSON validity, since
 * the LLM reads tool results as text not parsed JSON.
 */
export function compact_tool_result(
  serialized: string,
  budget: number = TOOL_RESULT_DEFAULT_BUDGET,
): string {
  if (serialized.length <= budget) return serialized;

  // Reserve room for the trailing truncation marker so it never pushes
  // us past the budget — the marker is what tells the LLM the body was
  // elided, dropping it would be worse than dropping payload lines.
  const MARKER_RESERVE = 280;
  const effective = Math.max(budget - MARKER_RESERVE, 200);
  const head_budget = Math.floor(effective * 0.3);

  const head = serialized.slice(0, head_budget);
  const tail = serialized.slice(head_budget);

  const kept: string[] = [];
  let used = head.length;
  // Split on JSON-ESCAPED newlines as well as real ones.
  //
  // THE BUG THIS FIXES (2026-07-28): the only production caller is
  // `project_tool_result_for_llm`, which passes `JSON.stringify(result)` —
  // compact, no indent. In that string every newline inside a text field is the
  // two-character escape `\` + `n`, and there is not a single real newline
  // anywhere. So `split('\n')` returned ONE element containing the whole tail:
  // the regex matched it (any year/price/time anywhere in the page), its cost
  // exceeded the budget, the loop broke on the first iteration, and `kept` was
  // always empty. The salvage pass — 70% of the budget and the entire point of
  // this function — contributed NOTHING to any tool result, ever. Compaction
  // silently degraded to a blind head-slice.
  //
  // Measured on a realistic browse_url payload (11.9 KB venue calendar,
  // llm_budget 2000): 0 of 3 real show listings survived, 738 chars delivered,
  // no salvage block. The same content with real newlines kept all 3.
  //
  // The smoke tests never caught it because they call `compact_tool_result`
  // directly with real newlines — a shape production never produces. The
  // regression test added alongside this fix goes through
  // `project_tool_result_for_llm` for exactly that reason.
  for (const line of tail.split(/\\n|\r?\n/)) {
    if (!HIGH_SIGNAL_RE.test(line)) continue;
    const cost = line.length + 1;
    if (used + cost > effective) break;
    kept.push(line);
    used += cost;
  }

  const elided = serialized.length - used;
  const signal_block = kept.length > 0 ? `\n\n…\n${kept.join('\n')}` : '';
  const marker =
    `\n\n[...truncated ${elided} chars from this tool result; full body ` +
    `is in the audit log. If you need detail not shown above, narrow ` +
    `your tool input or call a more targeted tool — don't ask the user ` +
    `to repaste the elided content.]`;

  return head + signal_block + marker;
}

/**
 * Resolve the budget for a given Tool descriptor. Returns `null` for
 * `llm_budget: 'full'` (caller should pass the serialized result
 * through unmodified); otherwise returns a number suitable for
 * `compact_tool_result`. Unknown tools fall back to the default budget.
 */
export function resolve_tool_budget(tool: Tool | undefined): number | null {
  if (!tool || tool.llm_budget === undefined) return TOOL_RESULT_DEFAULT_BUDGET;
  if (tool.llm_budget === 'full') return null;
  return tool.llm_budget;
}

/**
 * One-shot helper for the runtime: serialize, then either pass-through
 * (`'full'`) or compact. Keeps the call site at the tool-execution
 * boundary readable.
 */
export function project_tool_result_for_llm(
  result: unknown,
  tool: Tool | undefined,
): string {
  const serialized = JSON.stringify(result);
  const budget = resolve_tool_budget(tool);
  if (budget === null) return serialized;
  return compact_tool_result(serialized, budget);
}

// ── Cumulative (turn-level) tool-result budget ──────────────────────────
//
// `compact_tool_result` bounds each result INDIVIDUALLY. That's not
// enough on a research-heavy turn: every prior round's (already-compacted)
// result stays in the message array for the whole turn, so a loop that
// fans out across many rounds grows the prompt without bound. On a tier
// with a small context window this overflows — the 2026-06-01 Ruby civic
// turn hit `request (25187 tokens) exceeds the available context size`
// on the 24,576-token LIVE tier after 13 web fetches across one turn.
//
// `enforce_cumulative_tool_budget` caps the SUM of tool-result content in
// an in-flight message list. It's the structural backstop: called right
// before each completion request, it guarantees the payload fits the
// window regardless of how greedy the tool loop got — independent of the
// per-tool caps above.

/**
 * Fraction of the model's context window we allow tool RESULTS to
 * occupy. The rest is reserved for the system prompt, persona, grounding
 * block, conversation history, and the generation budget. 0.4 leaves
 * comfortable room for all of those on the constrained LIVE tier while
 * still permitting genuinely deep multi-source research.
 */
export const TOOL_CONTEXT_BUDGET_FRACTION = 0.4;

/**
 * Conservative chars-per-token for serialized tool output on the
 * Qwen3.6 tokenizer. Deliberately LOW: a low estimate yields a SMALLER
 * char budget, i.e. errs toward keeping the real token count under the
 * fraction — the safe direction for avoiding overflow.
 */
export const TOOL_CONTEXT_CHARS_PER_TOKEN = 3.6;

/**
 * Default context window (tokens) assumed when a role doesn't declare
 * one. Matches the smallest tier in service (the LIVE / A4000 tier) so
 * an unconfigured role gets the most conservative budget rather than an
 * over-generous one.
 */
export const TOOL_CONTEXT_DEFAULT_WINDOW_TOKENS = 24_576;

/** Char budget for cumulative tool results given a context window. */
export function tool_budget_chars_for_window(window_tokens: number): number {
  return Math.floor(
    window_tokens * TOOL_CONTEXT_BUDGET_FRACTION * TOOL_CONTEXT_CHARS_PER_TOKEN,
  );
}

interface CompressibleMessage {
  role: string;
  content?: string | null;
  /**
   * Assistant tool calls. Declared here because they are REAL prompt payload:
   * an assistant turn that calls a tool has `content: null` and every one of
   * its bytes in this field, so a size estimate reading only `content` scores
   * it as ZERO. See `estimate_prompt_tokens`.
   */
  tool_calls?: unknown;
}

export interface CumulativeBudgetResult {
  /** Number of tool messages whose content was compressed. */
  compressed: number;
  /** Total tool-result chars before enforcement. */
  before: number;
  /** Total tool-result chars after enforcement. */
  after: number;
}

/**
 * Bound the cumulative size of `role: 'tool'` messages in an in-flight
 * message list, mutating their content in place.
 *
 * Strategy — summarize-on-eviction, oldest-first:
 *   - The newest `keep_newest` tool results are protected (they drove the
 *     current round's reasoning; the model still needs them verbatim).
 *   - Older results are compressed to a high-signal `stub_budget` stub via
 *     `compact_tool_result` — they already informed the later searches, so
 *     a breadcrumb is enough. This reuses the deterministic high-signal
 *     extractor: NO extra LLM round-trip, so research stays snappy.
 *   - If the protected newest results alone still bust the budget, they're
 *     compressed too as a last resort (better a trimmed newest than a 400).
 *
 * Idempotent: a list already under budget is returned untouched, and
 * stubs at/under `stub_budget` are skipped, so calling it every round is
 * cheap and stable.
 */
export function enforce_cumulative_tool_budget(
  messages: CompressibleMessage[],
  budget_chars: number,
  opts: { keep_newest?: number; stub_budget?: number } = {},
): CumulativeBudgetResult {
  const keep_newest = opts.keep_newest ?? 2;
  const stub_budget = opts.stub_budget ?? 600;

  const tool_idx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'tool') tool_idx.push(i);
  }

  const total = () =>
    tool_idx.reduce((s, i) => s + (messages[i]?.content?.length ?? 0), 0);

  const before = total();
  if (before <= budget_chars) return { compressed: 0, before, after: before };

  let compressed = 0;
  const compress_at = (i: number): void => {
    const msg = messages[i];
    if (!msg || typeof msg.content !== 'string') return;
    if (msg.content.length <= stub_budget) return; // already small
    msg.content = compact_tool_result(msg.content, stub_budget);
    compressed++;
  };

  // Oldest-first, protecting the newest `keep_newest`.
  const older = tool_idx.slice(0, Math.max(0, tool_idx.length - keep_newest));
  for (const i of older) {
    if (total() <= budget_chars) break;
    compress_at(i);
  }
  // Last resort: the protected newest results are themselves oversized.
  if (total() > budget_chars) {
    for (const i of tool_idx.slice(-keep_newest)) {
      if (total() <= budget_chars) break;
      compress_at(i);
    }
  }

  return { compressed, before, after: total() };
}

// ---------------------------------------------------------------------------
// Prompt-window budget (2026-07-31)
// ---------------------------------------------------------------------------
// The budget above bounds what the TOOL LOOP adds. Nothing bounded what the
// CONVERSATION added: the chat route hands the runtime the last 20 messages by
// COUNT, never by size, so twenty long turns are twenty long turns. Three
// context-overflow 400s in one week traced to that gap — Kate at 28,117 tokens
// against a 16,384-token slot (a complexity-gate escalation onto a
// smaller-window provider), plus a 62,537-token request and Ruby at 49,733
// against 49,152 (plain long threads on the normal lane). Every one surfaced to
// the user as "I ran into a problem responding (…exceeds the available context
// size…)".
//
// This is the structural backstop: before each completion, evict oldest
// conversation history until the assembled payload fits the window the RESOLVED
// provider actually serves. A guard would have caught none of these — the
// resource envelope is the fix (see the 2026-07-29 stale-window lesson).

/**
 * Slack (tokens) held back beyond the generation budget and tool schemas.
 * Covers chat-template scaffolding and the tokenizer running hotter than
 * {@link TOOL_CONTEXT_CHARS_PER_TOKEN} on dense JSON or code.
 *
 * FLOOR, not the whole story — see {@link prompt_window_slack_for}. A flat
 * 1024 is ~6% of a 16k window but only ~1.6% of a 64k one, and the estimate it
 * protects is a chars-per-token heuristic whose error scales WITH the payload.
 * The deep roles declare their entire per-slot window, so at the top of a 49k
 * slot that 1.6% was the only thing standing between an estimate and a 400 —
 * and on 2026-08-02 Kristi's prompt landed at 49393 against a 49152 slot,
 * missing by 0.5%.
 */
export const PROMPT_WINDOW_SLACK_TOKENS = 1024;

/** Fraction of the window held back for estimator drift. */
const PROMPT_WINDOW_SLACK_FRACTION = 0.03;

/**
 * Slack for a given window: the flat floor, or 3% of the window, whichever is
 * larger. Proportional because the thing it absorbs — the gap between a
 * chars-per-token estimate and the real tokenizer — grows with the payload,
 * while a constant does not.
 */
export function prompt_window_slack_for(window_tokens: number): number {
  return Math.max(
    PROMPT_WINDOW_SLACK_TOKENS,
    Math.ceil(window_tokens * PROMPT_WINDOW_SLACK_FRACTION),
  );
}

/**
 * Estimated tokens for one message, counting everything that actually ships.
 *
 * `content` is the obvious part. `tool_calls` is the part that was missing: an
 * assistant turn that calls a tool carries `content: null` and puts the whole
 * function name + JSON arguments in `tool_calls`, so summing `content.length`
 * alone scored those messages as ZERO. That under-counts, which is the UNSAFE
 * direction — the module's own contract is to over-estimate and trim early —
 * and it under-counts hardest on exactly the multi-round research and
 * deliberation turns that run closest to the slot ceiling.
 *
 * `MESSAGE_SCAFFOLD_TOKENS` is the per-message chat-template overhead (role
 * markers, delimiters) that no content-length sum can see.
 */
const MESSAGE_SCAFFOLD_TOKENS = 4;

export function estimate_prompt_tokens(messages: readonly CompressibleMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content?.length ?? 0;
    if (m.tool_calls != null) {
      try {
        chars += JSON.stringify(m.tool_calls).length;
      } catch {
        /* unserializable → fall through; content already counted */
      }
    }
  }
  return Math.ceil(chars / TOOL_CONTEXT_CHARS_PER_TOKEN) + messages.length * MESSAGE_SCAFFOLD_TOKENS;
}

export interface PromptWindowResult {
  /** Conversation-history messages evicted. */
  dropped: number;
  /** Estimated prompt tokens before eviction. */
  before_tokens: number;
  /** Estimated prompt tokens after eviction. */
  after_tokens: number;
  /** Tokens the payload was fitted to (window minus reserve). */
  budget_tokens: number;
  /** True when even a fully-evicted payload is still over — nothing left to cut. */
  still_over: boolean;
}

/**
 * Bound the whole in-flight message list to the backing server's context
 * window, mutating `messages` in place by evicting oldest conversation history.
 *
 * Only the half-open `evictable` span — the plain user/assistant turns replayed
 * from conversation history — is ever removed. The system prompt, the live user
 * turn, every `role: 'tool'` message and the assistant turns carrying their
 * `tool_calls` all sit outside it by construction. That exclusion is
 * load-bearing: dropping half of a tool_call/tool_result pair is a malformed
 * request on every OpenAI-compatible server, i.e. a worse failure than the
 * overflow it was trying to avoid.
 *
 * Estimation deliberately uses the same conservative low chars-per-token as the
 * tool budget. A low ratio OVER-estimates the token count here, so the payload
 * is trimmed slightly early — the safe direction.
 *
 * Idempotent and cheap: a payload already under budget returns untouched.
 */
export function enforce_prompt_window(
  messages: CompressibleMessage[],
  opts: {
    window_tokens: number;
    reserve_tokens: number;
    /** Half-open [start, end) index range of plain conversation history. */
    evictable: { start: number; end: number };
    /** Most recent history turns to protect from eviction. Default 2. */
    keep_newest?: number;
  },
): PromptWindowResult {
  const keep_newest = opts.keep_newest ?? 2;
  const budget_tokens = Math.max(0, opts.window_tokens - opts.reserve_tokens);
  const est = (): number => estimate_prompt_tokens(messages);

  const before_tokens = est();
  if (before_tokens <= budget_tokens) {
    return {
      dropped: 0,
      before_tokens,
      after_tokens: before_tokens,
      budget_tokens,
      still_over: false,
    };
  }

  const span = Math.max(0, opts.evictable.end - opts.evictable.start);
  let dropped = 0;
  const evict_up_to = (limit: number): void => {
    while (dropped < limit && est() > budget_tokens) {
      messages.splice(opts.evictable.start, 1);
      dropped++;
    }
  };

  // Oldest-first, protecting the most recent exchange...
  evict_up_to(Math.max(0, span - keep_newest));
  // ...but a still-oversized payload gets a 400 either way, so the protected
  // turns go too rather than lose the whole reply (same last-resort posture as
  // the tool budget above).
  evict_up_to(span);

  const after_tokens = est();
  return {
    dropped,
    before_tokens,
    after_tokens,
    budget_tokens,
    still_over: after_tokens > budget_tokens,
  };
}
