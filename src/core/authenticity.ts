/**
 * authenticity — shared primitives for detecting fabrication-shaped
 * behavior in specialist turns.
 *
 * Two consumers today:
 *
 *   - SpecialistRuntime (`_detect_ghost_promise`) — live guard that
 *     catches a thinking-only consult commitment mid-turn and forces
 *     a retry before the user sees the unbacked reply.
 *
 *   - Mariah's `scan_specialist_authenticity` — daily retrospective
 *     sweep over `messages` + `audit_log` that opens process_miss
 *     entries for patterns the live guard missed, didn't exist at
 *     the time, or that span multiple turns.
 *
 * Both must agree on which model names resolve to which specialist
 * ids and which thinking phrases count as commitments — anything
 * else and the live guard would mask findings the scan would later
 * surface (or vice-versa). Keep this module the only source of
 * truth for both.
 */
import type { SpecialistRegistry } from './specialist';

/**
 * Build the lowercased-display-name → specialist_id map from the
 * live registry. Falls back to a static baseline for the fixed core
 * roster (covers the case where the registry isn't yet loaded —
 * smoke tests, early boot). The dynamic build catches specialists
 * hired through the `/app` UI after roster load.
 *
 * Beatrice's id is `trainer` (legacy file name predating the
 * "trainer" → "Beatrice" rename); every other persona's display
 * name lowercases to its id.
 */
const _STATIC_PEER_NAME_TO_ID: ReadonlyMap<string, string> = new Map([
  ['beatrice', 'trainer'],
  ['iris', 'iris'],
  ['eleanor', 'eleanor'],
  ['cassandra', 'cassandra'],
  ['anya', 'anya'],
  ['maggie', 'maggie'],
  ['cordelia', 'cordelia'],
  ['vivian', 'vivian'],
  ['marguerite', 'marguerite'],
  ['mariah', 'mariah'],
  ['brigid', 'brigid'],
  ['kate', 'kate'],
]);

export function build_peer_name_to_id(
  specialists?: SpecialistRegistry,
): ReadonlyMap<string, string> {
  if (!specialists) return _STATIC_PEER_NAME_TO_ID;
  const map = new Map(_STATIC_PEER_NAME_TO_ID);
  try {
    for (const s of specialists.list()) {
      map.set(s.name.toLowerCase(), s.id);
      map.set(s.id.toLowerCase(), s.id);
    }
  } catch {
    // registry not ready; static baseline is good enough
  }
  return map;
}

/**
 * Patterns that signal a commitment to consult/call a peer inside a
 * reasoning trace — "I'll consult Mariah," "let me ask Beatrice," "I
 * should hand this to Iris." The thinking channel is private
 * deliberation, not user-facing prose, so a peer-named commitment in
 * thinking that doesn't materialize as a real `consult_specialist`
 * tool call is the failure shape: the model deliberated about doing
 * the work, decided to do it, then dropped it before the tool
 * channel.
 *
 * Conservative on purpose — we only fire when the model NAMED a peer
 * in a commit-shaped clause. Pure "let me think about whether to ask
 * Iris" doesn't trigger; "let me ask Iris" does. The trailing capture
 * group is the peer's display name.
 */
export const THINKING_PEER_COMMIT_PATTERNS: readonly RegExp[] = [
  /\bI(?:'?ll| will| should| need to| have to| am going to| am gonna)\s+(?:consult|ask|check with|reach out to|loop in|hand (?:this|that|it) (?:to|off to)|delegate (?:this|that|it) to|talk to|ping)\s+([A-Z][a-z]+)\b/,
  /\blet me (?:consult|ask|check with|reach out to|loop in|hand (?:this|that|it) (?:to|off to)|delegate (?:this|that|it) to|talk to|ping)\s+([A-Z][a-z]+)\b/i,
  /\b(?:consult|ask|check with|reach out to)\s+([A-Z][a-z]+)\s+(?:first|now|next|about|on|for|to)\b/,
];

/**
 * Tool call shape stored in `messages.tool_calls_json` and produced
 * by `SpecialistTurnOutput.tool_calls_made`. Kept local to keep this
 * module dependency-free (no import from specialist_runtime).
 */
export interface SerializedToolCall {
  name: string;
  input?: unknown;
  result?: unknown;
  error?: string;
  /**
   * Recovery hints the tool handed back on failure. Already written by
   * the runtime (`specialist_runtime` push site) from
   * `InvokeOutcome.candidates`; declared here so the ledger can tell
   * "the tool gave it nothing" apart from "the tool named the fix and
   * the specialist answered anyway" — a materially different finding.
   */
  candidates?: unknown;
}

/**
 * Scan a thinking trace for peer-named commitments. Returns the set
 * of resolved specialist_ids the LLM committed to consulting but did
 * NOT actually consult in `tool_calls`. Empty set = trace is clean
 * OR every commitment was honored.
 *
 * `peer_name_to_id` should be the dynamic map from
 * `build_peer_name_to_id(specialists)` so a specialist hired through
 * the UI after boot is recognized.
 */
export function unfulfilled_thinking_consults(
  thinking: string,
  tool_calls: ReadonlyArray<SerializedToolCall>,
  peer_name_to_id: ReadonlyMap<string, string>,
): string[] {
  if (!thinking || !thinking.trim()) return [];

  const committed = new Set<string>();
  for (const pat of THINKING_PEER_COMMIT_PATTERNS) {
    const re = new RegExp(
      pat.source,
      pat.flags.includes('g') ? pat.flags : pat.flags + 'g',
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(thinking)) !== null) {
      const name = m[1]?.toLowerCase();
      if (!name) continue;
      const id = peer_name_to_id.get(name);
      if (id) committed.add(id);
    }
  }
  if (committed.size === 0) return [];

  const consulted = new Set<string>();
  for (const c of tool_calls) {
    if (c.name !== 'consult_specialist') continue;
    if (c.error) continue;
    const args = (c.input ?? {}) as { specialist_id?: unknown };
    if (typeof args.specialist_id === 'string') {
      consulted.add(args.specialist_id.toLowerCase());
    }
  }
  return [...committed].filter((id) => !consulted.has(id));
}

/**
 * Detect whether a `consult_specialist` tool result represents an
 * empty answer — the consult fired but the consultee produced
 * nothing usable. Callers that quote such a consult's "answer" in
 * their visible reply are parroting unbacked content (the consult-
 * then-parrot pattern).
 *
 * Two shapes count as empty:
 *   - The runtime's canned `[<Name> produced no answer — ...]`
 *     diagnostic from consult() when the consultee turn produced no
 *     final text.
 *   - A trivially short result (<80 chars) that's almost certainly
 *     not a substantive answer.
 */
export function is_empty_consult_result(result: unknown): boolean {
  if (result === null || result === undefined) return true;
  const text = typeof result === 'string' ? result : String(result);
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (/^\[[A-Za-z]+ produced no answer/.test(trimmed)) return true;
  if (trimmed.length < 80) return true;
  return false;
}

/**
 * Detect whether a tool's input dropped to "no args" — the Qwen
 * drop-args-to-{} wall. Excludes tools that legitimately take no
 * arguments (their input schema is empty, so `{}` is correct).
 * Pass the set of zero-arg tool names so the caller controls the
 * allowlist; this module stays decoupled from the tool registry.
 */
export function is_empty_args_call(
  tool_name: string,
  input: unknown,
  zero_arg_tools: ReadonlySet<string>,
): boolean {
  if (zero_arg_tools.has(tool_name)) return false;
  if (input === null || input === undefined) return true;
  if (typeof input !== 'object') return false;
  return Object.keys(input as Record<string, unknown>).length === 0;
}

/**
 * Errors that signal HOW the model called the tool, not whether the
 * underlying read could succeed: the runtime's duplicate-call guard,
 * a capability denial, input validation. These are behavior signals
 * (retry storms, mis-grants, arg-spirals) with their own patterns and
 * fixes — they are NOT read failures, and counting them as such filed
 * high-severity fabrication misses against well-behaved specialists
 * (27 false positives on DUPLICATE_TOOL_CALL alone in the first June
 * 2026 fortnight; a duplicate of a successful read means the data was
 * already in-turn).
 */
export function is_behavior_signal_error(error: string | undefined): boolean {
  if (!error) return false;
  return (
    error.includes('DUPLICATE_TOOL_CALL') ||
    error.includes('INPUT_VALIDATION_FAILED') ||
    error.includes('lacks capability') ||
    // Per-turn heavy-fetch cap (2026-08-02). The read never ran: the RUNTIME
    // declined it and told the specialist, in as many words, to answer from
    // what it had already gathered and name what it couldn't confirm. Scoring
    // the resulting reply as fabrication-after-read-failure punished the
    // specialist for doing exactly what it was instructed to do — the same
    // false-positive shape as the DUPLICATE_TOOL_CALL cases above. Fan-out
    // that hits the cap is a research-shape signal and belongs to the
    // `pattern:` scans, not the honesty ledger.
    error.includes('ERROR (fetch budget)')
  );
}

/**
 * A duplicate-call entry — either served from the runtime's per-turn
 * cache (result channel, `duplicate_call: true`) or rejected as the
 * duplicate of a FAILED call (error channel, DUPLICATE_TOOL_CALL).
 * Either way the model repeated an identical call: the raw material
 * of the retry_storm pattern.
 */
export function is_duplicate_call_entry(c: SerializedToolCall): boolean {
  if (c.error && c.error.includes('DUPLICATE_TOOL_CALL')) return true;
  const r = c.result;
  return (
    typeof r === 'object' &&
    r !== null &&
    (r as Record<string, unknown>).duplicate_call === true
  );
}

/**
 * Detect whether a tool result indicates an HA-style read failure —
 * a 404, an empty/null `state`, or an explicit error field. Conservative
 * by design: a `ha_list_entities` with `entities: []` is NOT a
 * failure (the query just matched nothing), and a behavior-signal
 * error (duplicate-call guard, capability denial, input validation)
 * is the model misusing the tool, not the read failing — see
 * is_behavior_signal_error().
 */
export function is_failed_read(
  tool_name: string,
  result: unknown,
  error: string | undefined,
): boolean {
  if (error && error.length > 0) return !is_behavior_signal_error(error);
  if (!result || typeof result !== 'object') return false;
  const obj = result as Record<string, unknown>;
  if (typeof obj.error === 'string' && obj.error.length > 0) return true;
  // ha_get_state: state is null when entity 404'd or HA returned no state.
  if (tool_name === 'ha_get_state') {
    if (obj.state === null) return true;
  }
  return false;
}

/**
 * Input keys that identify WHICH read failed, most specific first.
 *
 * The ledger line is close to useless without one: `read_note() → note
 * not found` names no note, and `web_fetch_clean() → Firecrawl HTTP 500`
 * names no URL. Purely diagnostic formatting — this never routes model
 * behaviour, it only decides what the miss text shows.
 */
const IDENTIFYING_INPUT_KEYS = [
  'entity_id',
  'path',
  'note_path',
  'url',
  'model_id',
  'query',
  'id',
  'name',
] as const;

function clip(s: string, max_len: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= max_len ? t : `${t.slice(0, max_len - 1)}…`;
}

/** The most identifying argument of a call, for the miss text. '' when
 *  the input carries nothing recognisable. */
export function failed_read_arg(input: unknown, max_len = 60): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  for (const k of IDENTIFYING_INPUT_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) return clip(v, max_len);
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

/**
 * The CAUSE of a failed read, for the miss ledger.
 *
 * A tool fails through either of two channels and the ledger has to name
 * both:
 *
 *   - THROW → `ToolRegistry.invoke` puts the message on `c.error`.
 *   - SOFT  → the tool RETURNS `{ error, candidates, … }` and the
 *             registry marks the call `ok`; the cause sits in
 *             `c.result.error`.
 *
 * Reading only `c.error` recorded the literal string "null state" for
 * every soft failure: 225 of the 400 live `auth:*` misses on 2026-08-02,
 * i.e. 56% of the largest family carried no cause at all — including all
 * 199 `web_fetch_clean` rows, whose real causes (Firecrawl HTTP errors,
 * fetch-budget denials) were sitting in `result.error` the whole time.
 *
 * That mattered well beyond cosmetics: these rows are the evidence
 * Beatrice re-files from. An unnamed cause can only ever justify a
 * generic "improve `<tool>`'s error path" recommendation — the
 * 79-proposal family that PR #231 closed in the RUNTIME while the LEDGER
 * kept re-supplying the vague justification that reopened it.
 *
 * `is_failed_read` already reads both channels; only the reporting side
 * was half-blind. Keep the two in step.
 */
export function failed_read_cause(c: SerializedToolCall, max_len = 90): string {
  if (typeof c.error === 'string' && c.error.trim().length > 0) {
    return clip(c.error, max_len);
  }
  const r = c.result;
  if (r && typeof r === 'object') {
    const obj = r as Record<string, unknown>;
    if (typeof obj.error === 'string' && obj.error.trim().length > 0) {
      return clip(obj.error, max_len);
    }
    // The one case where "null state" is the honest description: the read
    // succeeded and there was nothing behind the entity.
    if (c.name === 'ha_get_state' && obj.state === null) return 'null state';
  }
  return 'failed with no cause recorded by the tool';
}

/** How many recovery hints the tool offered on this failed call — from
 *  either channel (thrown `candidates`, or a soft result's field). */
export function failed_read_hint_count(c: SerializedToolCall): number {
  const from_throw = Array.isArray(c.candidates) ? c.candidates : null;
  const r = c.result as Record<string, unknown> | null | undefined;
  const from_soft =
    r && typeof r === 'object' && Array.isArray(r.candidates) ? r.candidates : null;
  const list = from_throw ?? from_soft;
  if (!list) return 0;
  return list.filter((x) => typeof x === 'string' && x.trim().length > 0).length;
}

/**
 * One ledger-ready line describing a failed read: what was called, on
 * what, why it failed, and whether the tool handed back a retry it could
 * have used. The last part is the distinction that decides who owns the
 * fix — a tool that offered nothing is a tool-layer gap; a tool that
 * named three candidates and got ignored is a specialist-behaviour gap.
 */
export function describe_failed_read(c: SerializedToolCall, max_len = 90): string {
  const arg = failed_read_arg(c.input);
  const hints = failed_read_hint_count(c);
  const offered =
    hints > 0 ? ` [tool offered ${hints} retry candidate${hints === 1 ? '' : 's'}]` : '';
  return `${c.name}(${arg}) → ${failed_read_cause(c, max_len)}${offered}`;
}

/**
 * Per-specialist authenticity tally — what scan_specialist_authenticity
 * accumulates while it walks the window, and what compute_score() turns
 * into a 0-100 number.
 */
export interface AuthenticityTally {
  turns: number;
  /** Pattern → count of findings opened (or seen, including already_tracked). */
  by_pattern: Record<string, number>;
  /** Severity → count, derived from by_pattern weights. */
  by_severity: { high: number; medium: number; low: number };
}

export function empty_tally(): AuthenticityTally {
  return {
    turns: 0,
    by_pattern: {},
    by_severity: { high: 0, medium: 0, low: 0 },
  };
}

/**
 * Severity weight per finding pattern. Keep here so the scan tool, the
 * score computation, and (later) the autonomy gate read one source.
 */
export const PATTERN_SEVERITY: Record<string, 'high' | 'medium' | 'low'> = {
  thinking_only_consult: 'high',
  consult_then_parrot: 'high',
  fabrication_after_read_failure: 'high',
  empty_args_call: 'medium',
  // Repeated identical calls in one turn. Wastes rounds but fabricates
  // nothing — the runtime serves repeats from cache. Low so a storm
  // dings the score without reading like a fabrication incident.
  retry_storm: 'low',
};

export function record_finding(tally: AuthenticityTally, pattern: string): void {
  tally.by_pattern[pattern] = (tally.by_pattern[pattern] ?? 0) + 1;
  const sev = PATTERN_SEVERITY[pattern] ?? 'low';
  tally.by_severity[sev]++;
}

/**
 * Score formula — 100 minus a per-turn fabrication-rate penalty,
 * clamped to [0, 100]. Designed so:
 *
 *   - A specialist with zero findings always scores 100.
 *   - A heavy talker isn't penalized for volume — denominator is turns.
 *   - A low-volume specialist isn't whiplashed by one finding; we floor
 *     the denominator at 20 turns so the score moves on a meaningful
 *     base. With turns=20 a single high-severity finding costs ~25
 *     points, three cost ~75 — strong but not annihilating.
 *
 * Severity weights: high = 5, medium = 2, low = 1. The 100x multiplier
 * scales the rate-per-turn into rate-per-100-turns space so the
 * numbers read like a percentage drop.
 */
export function compute_score(tally: AuthenticityTally): number {
  const penalty =
    tally.by_severity.high * 5 +
    tally.by_severity.medium * 2 +
    tally.by_severity.low * 1;
  const denom = Math.max(tally.turns, 20);
  const raw = 100 - Math.round((penalty * 100) / denom);
  return Math.max(0, Math.min(100, raw));
}

/**
 * Within an intent's tool calls, does a `tool_name` later in the list
 * eventually return successfully on a related entity_id? "Related"
 * means same tool name AND the new entity_id contains at least one
 * non-trivial token from the failing entity_id (so a recovery from
 * `sensor.2023_ioniq_5_battery_level` to
 * `sensor.2023_ioniq_5_ev_battery_level` counts; an unrelated
 * `sensor.front_door` doesn't).
 */
export function had_recovery_read(
  failing_call: SerializedToolCall,
  later_calls: ReadonlyArray<SerializedToolCall>,
): boolean {
  if (failing_call.name !== 'ha_get_state') {
    // For non-HA reads, any later successful call of the same tool
    // counts as recovery — we don't have a strong notion of "related"
    // for arbitrary connectors. Conservative: more lenient = fewer
    // false positives.
    return later_calls.some(
      (c) => c.name === failing_call.name && !c.error && !is_failed_read(c.name, c.result, c.error),
    );
  }
  const wanted = ((failing_call.input as { entity_id?: string })?.entity_id ?? '').toLowerCase();
  const dot = wanted.indexOf('.');
  if (dot < 0) return false;
  const wanted_tokens = new Set(
    wanted
      .slice(dot + 1)
      .split(/[_\s-]+/)
      .filter((t) => t.length >= 3 && !/^\d+$/.test(t)),
  );
  if (wanted_tokens.size === 0) return false;
  for (const c of later_calls) {
    if (c.name !== 'ha_get_state') continue;
    if (is_failed_read(c.name, c.result, c.error)) continue;
    const got = ((c.input as { entity_id?: string })?.entity_id ?? '').toLowerCase();
    const got_dot = got.indexOf('.');
    if (got_dot < 0) continue;
    const got_tokens = new Set(
      got
        .slice(got_dot + 1)
        .split(/[_\s-]+/)
        .filter((t) => t.length >= 3 && !/^\d+$/.test(t)),
    );
    let overlap = 0;
    for (const t of wanted_tokens) if (got_tokens.has(t)) overlap++;
    if (overlap >= 1) return true;
  }
  return false;
}
