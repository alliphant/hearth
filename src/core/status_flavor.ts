/**
 * Contextual "thinking" line — the live status phrase shown under the typing
 * bubble while a specialist works ("Kate is reconciling thermal shock concerns
 * with consistent cold brew methods…").
 *
 * This is a GENERATOR swap, not a new surface. Every GUI already renders the
 * `specialist_status` SSE event verbatim (web `apply_specialist_status`, iOS
 * `thread.liveStatus`, macOS via the shared HearthAPI/Chat layer). Today the
 * runtime emits a deterministic tool→label line (`_tool_status_phrase`); this
 * module produces a richer, message-relevant gerund phrase from the WORK in
 * flight (the latest user message + this round's tool calls + any deep-consult
 * question) and emits it as a SECOND, upgrading `specialist_status`.
 *
 * Design contracts (match the repo's fact_critic / data_denial pattern):
 *  - NON-BLOCKING. `maybe_upgrade_status_flavor` is never awaited by the turn;
 *    the deterministic line shows instantly, this upgrades it ~100-300ms later.
 *  - FAIL-OPEN, always. Disabled / endpoint down / malformed / denylisted /
 *    slow → returns null and the deterministic line stays. Never throws into
 *    the turn.
 *  - SAFETY in CODE, not the prompt. The prompt points at what TO write (calm,
 *    delightful, specific); the alarming/destructive never-list is a code
 *    denylist here — a 1B model can't be trusted to remember one, and a status
 *    notification reading "Terminating…" is the failure we must structurally
 *    prevent.
 *  - DARK by default. Gated on HEARTH_STATUS_FLAVOR=1 AND a live `status_flavor`
 *    role endpoint (a tiny CPU model — see config/llm-roles.yaml +
 *    ops/status-flavor/README.md). Kill switch = unset the env.
 */

import type { LLMMessage, LLMRouter, ToolCallSpec } from './llm';
import type { AppEvent } from '../app/events';

/** Reads env at call time so the kill switch flips without a redeploy. */
export function status_flavor_enabled(): boolean {
  return process.env.HEARTH_STATUS_FLAVOR === '1';
}

/**
 * Alarming / destructive / inappropriate leading gerunds. A phrase whose first
 * word matches one of these is rejected (→ deterministic line stays). This is
 * the hard never-list from Jasper's original spec — Connecting/Retrying/
 * Terminating/Penetrating/… — enforced where it belongs (code), so the prompt
 * can stay purely positive. Compared against the lowercased first token.
 */
const DENY_GERUND_STEMS = new Set<string>([
  // connectivity anxiety
  'connecting', 'disconnecting', 'reconnecting', 'retrying', 'rerouting',
  'lagging', 'freezing', 'hanging', 'stalling', 'buffering', 'waiting',
  'timing', 'pinging', 'polling',
  // destructive
  'terminating', 'killing', 'deleting', 'destroying', 'dropping', 'stopping',
  'halting', 'aborting', 'exiting', 'crashing', 'failing', 'erroring',
  'wiping', 'erasing', 'purging', 'nuking', 'corrupting', 'breaking',
  'shredding', 'overwriting',
  // security-charged / inappropriate in a non-coding context
  'penetrating', 'probing', 'exploiting', 'attacking', 'hacking', 'injecting',
  'breaching', 'spying', 'surveilling', 'tracking', 'snooping',
]);

const MAX_PHRASE_CHARS = 84;
/** Leading capitalized gerund, hyphens allowed ("Cross-referencing"). */
const GERUND_LEAD_RE = /^[A-Z][a-zA-Z-]*ing\b/;

/**
 * Clean + gate a raw model line into a safe status phrase, or null if it fails
 * any rule (caller falls back to the deterministic line). Pure + total.
 */
export function validate_status_phrase(raw: string): string | null {
  if (!raw) return null;
  // First line only.
  let s = (raw.split('\n')[0] ?? '').trim();
  // Strip surrounding quotes / backticks / markdown emphasis.
  s = s.replace(/^["'`*_]+/, '').replace(/["'`*_]+$/, '').trim();
  // Strip trailing ellipsis/period — the renderer re-adds the ellipsis.
  s = s.replace(/[.…]+$/, '').trim();
  if (!s) return null;
  if (s.length > MAX_PHRASE_CHARS) return null;
  if (!GERUND_LEAD_RE.test(s)) return null;
  const first = (s.split(/\s+/)[0] ?? '').toLowerCase();
  if (DENY_GERUND_STEMS.has(first)) return null;
  // Collapse any internal whitespace runs.
  return s.replace(/\s+/g, ' ');
}

function pick_str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

function latest_user_text(messages: LLMMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      return m.content;
    }
  }
  return '';
}

/** The salient free-text arg + a flag for whether a deep consult is in flight. */
function summarize_calls(tool_calls: ToolCallSpec[]): {
  lines: string;
  consult_question: string | null;
} {
  const lines: string[] = [];
  let consult_question: string | null = null;
  for (const tc of tool_calls) {
    const args = (tc.arguments ?? {}) as Record<string, unknown>;
    const salient =
      pick_str(args, 'question') ||
      pick_str(args, 'query') ||
      pick_str(args, 'prompt') ||
      pick_str(args, 'topic') ||
      pick_str(args, 'url');
    lines.push(salient ? `${tc.name}: ${salient.slice(0, 200)}` : tc.name);
    if (
      (tc.name === 'consult_deep_model' || tc.name === 'consult_specialist') &&
      salient
    ) {
      consult_question = salient;
    }
  }
  return { lines: lines.join('\n'), consult_question };
}

const SYSTEM = [
  'You write the single status line a user sees while an assistant works in the',
  'background — e.g. "Reconciling thermal shock concerns with consistent cold brew',
  'methods". Read the WORK and describe what is being worked through RIGHT NOW.',
  'Rules:',
  '- Output ONE phrase, 3 to 9 words. No preamble, no quotes, no trailing punctuation.',
  '- Begin with a capitalized gerund (a verb ending in -ing): Reconciling, Weighing,',
  '  Charting, Distilling, Cross-referencing, Untangling, Foraging.',
  '- Ground it ONLY in the work shown. Be specific to the actual subject — never generic.',
  '- Tone: calm, quietly delightful, a touch of wit. Never alarming, never about errors,',
  '  waiting, or connectivity, never raw technical jargon.',
  'Reply with ONLY the phrase.',
].join('\n');

export function build_status_messages(ctx: {
  user_message: string;
  tool_calls: ToolCallSpec[];
}): LLMMessage[] {
  const { lines, consult_question } = summarize_calls(ctx.tool_calls);
  const work =
    (ctx.user_message ? `User asked: ${ctx.user_message.slice(0, 400)}\n\n` : '') +
    (consult_question
      ? `Deep question being reasoned through: ${consult_question.slice(0, 300)}\n\n`
      : '') +
    `Actions in flight:\n${lines || '(thinking)'}`;
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `WORK:\n${work}\n\nThe status phrase:` },
  ];
}

/**
 * One tight call to the `status_flavor` role → a validated phrase, or null on
 * ANY failure (disabled, role unresolved, endpoint down, malformed, denylisted,
 * timeout). Never throws.
 */
export async function compose_status_flavor(
  ctx: { user_message: string; tool_calls: ToolCallSpec[] },
  llm: LLMRouter,
): Promise<string | null> {
  if (!status_flavor_enabled()) return null;
  if (!ctx.tool_calls || ctx.tool_calls.length === 0) return null;

  let role;
  try {
    role = llm.for_role('status_flavor');
  } catch {
    return null;
  }

  let resp;
  try {
    resp = await role.provider.complete({
      messages: build_status_messages(ctx),
      temperature: 0.85,
      max_tokens: 32,
      think: false,
      signal: AbortSignal.timeout(3000),
      ...role.defaults,
    });
  } catch {
    return null;
  }

  return validate_status_phrase(resp?.content ?? '');
}

function lower_first(s: string): string {
  return s.length > 0 ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/**
 * Fire-and-forget contextual upgrade of the live status line. Composes a richer
 * phrase and, on success, emits a SECOND `specialist_status` (wrapped in the
 * same "<Name> is …" shape the deterministic line uses, so no client change).
 * On any miss it silently leaves the deterministic line in place.
 *
 * Returns a promise so tests can await it; PRODUCTION CALLERS DO NOT AWAIT
 * (prefix `void`) — this must never delay the turn.
 */
export async function maybe_upgrade_status_flavor(args: {
  llm: LLMRouter;
  events: { emit: (e: AppEvent) => void } | undefined;
  specialist_id: string;
  specialist_name: string;
  conversation_id: string;
  messages: LLMMessage[];
  tool_calls: ToolCallSpec[];
  ttl_seconds: number;
}): Promise<void> {
  if (!args.events) return;
  if (!status_flavor_enabled()) return;

  let phrase: string | null = null;
  try {
    phrase = await compose_status_flavor(
      { user_message: latest_user_text(args.messages), tool_calls: args.tool_calls },
      args.llm,
    );
  } catch {
    return;
  }
  if (!phrase) return;

  args.events.emit({
    type: 'specialist_status',
    specialist_id: args.specialist_id,
    conversation_id: args.conversation_id,
    status: `${args.specialist_name} is ${lower_first(phrase)}…`,
    ttl_seconds: args.ttl_seconds,
  });
}
