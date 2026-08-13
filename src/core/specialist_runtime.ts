/**
 * SpecialistRuntime — runs a conversation turn for a specialist.
 *
 * Each `turn()` call:
 *   1. Resolves the specialist's config (persona, granted capabilities,
 *      knowledge_scope) from the registry.
 *   2. Builds the LLM messages from the conversation history plus the new
 *      message, with the persona as system prompt and a compact summary
 *      of the tools the specialist can invoke.
 *   3. Runs an LLM round; if the model returns tool_calls, invokes each
 *      via the tool registry (capability-checked), feeds results back,
 *      and loops up to MAX_TOOL_ROUNDS times.
 *   4. Parses any <think>…</think> reasoning trace out of the content
 *      and audits the turn.
 *
 * The `consult_specialist` meta-tool is always available — every specialist
 * can consult any other for a quick scoped answer. Kate uses this to defer
 * to SMEs without making the user switch conversations.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { sanitize_tool_schema_for_grammar } from './tool_schema_grammar';
import { ulid } from 'ulid';
import { createHash } from 'node:crypto';
import {
  GUARD_DIRECTED_DUP_FAILURE_CUT,
  GUARD_ROUND_CEILING_EXHAUST,
  bump_guard_counter,
} from '@memory/stores/guard_counters';
import type { LLMMessage, LLMRole, LLMRouter, ToolDef } from './llm';
import type { Tool, ToolContext } from './tool';
import type { ToolRegistry } from './tool_registry';
import {
  project_tool_result_for_llm,
  enforce_cumulative_tool_budget,
  enforce_prompt_window,
  estimate_prompt_tokens,
  tool_budget_chars_for_window,
  TOOL_CONTEXT_CHARS_PER_TOKEN,
  TOOL_CONTEXT_DEFAULT_WINDOW_TOKENS,
  prompt_window_slack_for,
} from './tool_result_compaction';
import { format_now_anchor, format_short_date, format_short_datetime, local_iso_week } from './time';
import { maybe_upgrade_status_flavor } from './status_flavor';
import { is_recovery_hint } from './connector_affordances';
import { exemplar_for, exemplars_enabled } from './tool_exemplars';
import { assess_complexity, complexity_gate_enabled } from './complexity';
import {
  ESCALATION_TOOL,
  detect_escalation_evidence,
  escalation_budget_ms,
  escalation_decision,
  escalation_mode,
  escalation_nudge,
  type CarriedFinding,
} from './escalation';
import {
  CITATION_PROMPT_RULE,
  citation_retry_nudge,
  citations_enabled,
  verify_citations,
  type CitationSource,
} from './citations';
import {
  is_caller_allowed,
  canned_refusal,
  render_discretion_block,
  caller_tier,
} from './discretion';
import type { SpecialistRegistry, LoadedSpecialist } from './specialist';
import { get_household_context, substitute, strip_deferred_tokens } from './household';
import {
  all_persona_names,
  render_peer_directory,
  render_staff_roster,
  unattributable_names,
} from './staff_roster';
import { resolve_household_for_user } from '@memory/stores/user_profile';
import type { ProposalsStore } from './proposals';
import { emit_for_proposal_created } from './proposal_events';
import type { MemoryClient, ScopedChunkHit } from '@memory/client';
import { retrieve_hybrid } from './retrieval';
import {
  CALENDAR_INTENT_RE,
  gather_grounding_packs,
  render_verified_section,
} from './grounding_packs';
import {
  gather_person_precedence,
  stringify_address,
  type PersonPrecedenceDeps,
  type PersonRosterEntry,
  type ClippingMeta,
} from './grounding_precedence';
import { type Embedder, NOOP_EMBEDDER } from './embeddings';
import {
  rank_tools_for_message,
  compose_hot_set,
  partition_awareness,
  compact_catalog_lines,
  apply_load_tools,
  format_load_tools_result,
  LoadToolsInputSchema,
  LOAD_TOOLS_NAME,
  FLOOR_TOOL_NAMES,
  MAX_HOT_TOOLS,
  MAX_HOT_TOOLS_DELIBERATION,
  DELIBERATION_FLOOR_TOOL_NAMES,
  type CachedVec,
} from './dynamic_tools';
import { render_skill_awareness, skills_enabled } from './skills';
import { SpecialistInbox } from '@memory/stores/conversations';
import {
  ConsultGuard,
  consult_guard_enabled,
  consult_verdict_message,
} from './consult_guard';
import {
  build_peer_name_to_id,
  unfulfilled_thinking_consults,
} from './authenticity';
import {
  build_grounding_context,
  build_grounding_evidence,
  find_ungrounded_claims,
  provenance_retry_nudge,
  PROVENANCE_POLICY,
  type GroundingContext,
} from './provenance';
import {
  assess_factual_grounding,
  fact_critic_retry_nudge,
  librarian_findings_nudge,
  unsourced_specifics,
  type FactFinding,
} from './fact_critic';
import {
  assess_data_denial,
  data_denial_retry_nudge,
  render_data_map_section,
} from './data_denial';
import {
  assess_shell_safety,
  shell_safety_guard_enabled,
  shell_safety_retry_nudge,
} from './shell_safety';
import {
  assess_fabricated_save,
  fabricated_save_retry_nudge,
  fabricated_save_semantic_enabled,
  looks_like_save_claim,
} from './fabricated_save';
import { detect_actionable_intent, intent_force_enabled_for } from './record_intent';
import { house_voice_enabled, render_house_voice_section } from './house_voice';
import { resolve_user_model, user_model_enabled } from './user_model';

const MAX_TOOL_ROUNDS = 15;

/**
 * Per-turn cap on `weight: 'heavy'` tool calls (external web fetches:
 * web_search / web_fetch_clean / browse_url). Past this, the runtime
 * short-circuits further heavy calls with a synthesize-now nudge so a
 * research loop can't fan out into 13 fetches for one question (the
 * 2026-06-01 Ruby civic turn). Light tools (civic DB reads, lookups)
 * stay uncapped; the model keeps everything it already gathered. Sits
 * UNDER the round ceiling — a turn can still take many rounds, just not
 * many *fetches*.
 */
const HEAVY_FETCH_CAP_PER_TURN = 8;

/**
 * Semantic fact critic (Durable Truth Phase 1.5) gate. On by default;
 * `HEARTH_FACT_CRITIC=0` disables it (a kill switch for latency triage).
 * Skipped under HEARTH_TEST_MODE so the fixture-driven smokes — which run
 * against mock LLMs — keep their deterministic tool-call/audit shape; the
 * critic is proven directly in scripts/test-fact-critic.ts instead. Read
 * at call time, not module load, because smokes set the env after import. */
function fact_critic_enabled(): boolean {
  return (
    process.env.HEARTH_FACT_CRITIC !== '0' &&
    process.env.HEARTH_TEST_MODE !== '1'
  );
}

/**
 * Read-failure honesty guard gate (1b — the demand-side complement to the
 * 1a connector recovery hints). ON by default; kill with
 * HEARTH_READ_FAILURE_GUARD=0. Safer than the semantic fact critic — its
 * trigger is deterministic (a tool errored/soft-failed this turn and no
 * same-tool retry succeeded), not an LLM judgment — so it can't false-
 * positive on a clean reply the way the regex provenance guard did. Never
 * runs in test mode.
 */
function read_failure_guard_enabled(): boolean {
  return (
    process.env.HEARTH_READ_FAILURE_GUARD !== '0' &&
    process.env.HEARTH_TEST_MODE !== '1'
  );
}

/**
 * Data-denial guard gate (2026-06-12 — the Astrid no-HR incident class:
 * a definitive "there is no data" claim with no backing query that turn).
 * ON by default; kill with HEARTH_DATA_DENIAL_GUARD=0 (also drops the
 * data-map prompt section, so the env is a full-feature rollback). Never
 * in test mode — the judge is an LLM call the fixture smokes can't serve;
 * the module is proven directly in scripts/test-data-denial.ts. Read at
 * call time because smokes set the env after import.
 */
function data_denial_guard_enabled(): boolean {
  return (
    process.env.HEARTH_DATA_DENIAL_GUARD !== '0' &&
    process.env.HEARTH_TEST_MODE !== '1'
  );
}

/**
 * Save-honesty guard gate (2026-06-22 — the "person-write silently failed
 * while Kate said 'noted'" class). Fires when a WRITE-tier tool was attempted
 * and FAILED (hard error / soft {error} result / DUPLICATE / validation), no
 * other durable write landed, and the reply still claims a completed save.
 * Deterministic (no LLM), so unlike the data-denial / fact critics it is safe
 * to leave ON in test mode — but `run_reply_guards` never runs under TEST_MODE
 * (the canned-turn path returns first), so the env is the only live control.
 * Kill with HEARTH_SAVE_HONESTY_GUARD=0; default ON.
 */
function save_honesty_guard_enabled(): boolean {
  return process.env.HEARTH_SAVE_HONESTY_GUARD !== '0';
}

/**
 * The data-bearing read tools on a turn surface — what the data-denial
 * judge weighs absence claims against, and what the data-map prompt
 * section enumerates. Read-tier per the registry (the source of truth on
 * risk), minus the structural interaction tools that reach no store.
 */
const DATA_MAP_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  'present_questions',
  'promise_followup',
  LOAD_TOOLS_NAME,
]);
function data_read_tools(
  surface: ReadonlyArray<{ name: string; description: string }>,
  registry: ToolRegistry,
): Array<{ name: string; description: string }> {
  return surface.filter(
    (t) =>
      !DATA_MAP_EXCLUDED_TOOLS.has(t.name) &&
      registry.get(t.name)?.risk === 'read',
  );
}

/**
 * Unified per-turn content-re-roll budget. The grounding/honesty guards
 * (ghost-promise, fabricated-save, read-failure, provenance, fact-critic)
 * and the synthesis nudge each used to carry an INDEPENDENT one-shot latch,
 * so a single turn could re-roll the visible reply up to ~4 separate times —
 * the user watches the message get rewritten "over and over." This caps the
 * TOTAL content re-rolls per turn across ALL of those mechanisms. The first
 * guard to fire spends the budget; once spent, later guards in the same turn
 * skip their re-roll (the post-loop provenance redaction still scrubs
 * ENFORCED-tier fabrications without needing a re-roll, so the highest-risk
 * class stays covered). Default 1 — one self-correction, never a pile-up.
 * Raise with HEARTH_MAX_REROLLS_PER_TURN=2 for a second grounding pass at the
 * cost of one more possible visible rewrite; 0 disables in-loop re-rolls
 * entirely. Read at call time so smokes/env can toggle it post-import.
 */
export function max_content_rerolls_per_turn(): number {
  const raw = process.env.HEARTH_MAX_REROLLS_PER_TURN;
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 1;
}

/**
 * This turn's content re-roll budget — the single decision behind every
 * finalize guard. Two structural zeroes, both for the SAME reason: the guards
 * check each specific against evidence retrieved this turn, so a surface whose
 * turns have no such evidence by construction gets false positives at any
 * threshold, and re-rolling makes the user watch (or hear) the reply change.
 *
 *   - VOICE: the user HEARS the first reply then the rewrite, and ghost-promise
 *     fires on exactly the voice persona's intended acknowledgment ("let me
 *     check"). Voice grounding is the pre-injection + the round-0 forced tool.
 *   - NARRATIVE CHAT (`narrative: true`, 2026-07-27): invented fiction has no
 *     retrieved evidence, so ghost-promise matches present-tense narration and
 *     the fact critic flags in-fiction nouns as fabrications. Chat-only —
 *     a narrative specialist's DELIBERATION turns are real work making real
 *     assertions and keep the full stack.
 *
 * Everything else gets `max_content_rerolls_per_turn()` (default 1). Pure so
 * the policy is testable without a runtime: `bun run smoke:narrative-guards`.
 */
export function content_reroll_budget(
  mode: 'conversation' | 'deliberation' | 'voice',
  narrative: boolean,
): number {
  if (mode === 'voice') return 0;
  if (mode === 'conversation' && narrative) return 0;
  return max_content_rerolls_per_turn();
}

/**
 * Budget for the TOOL-CHANNEL guards — fabricated-image, unplaced-image,
 * narrated-tool-call. Deliberately NOT narrative-suppressed (2026-07-28).
 *
 * The narrative zero above exists because the evidence-grounding guards
 * compare PROSE against what a turn retrieved, and invented fiction has no
 * such evidence — so ghost-promise matches in-character narration and the
 * fact critic reads in-fiction nouns as fabrications. That reasoning does
 * not reach these three: they compare a server-minted filename, or a
 * registered tool name, against the turn's actual tool calls. Fiction
 * cannot produce a false positive, because no amount of storytelling mints
 * a ULID or populates `tool_calls_json`.
 *
 * And the failure they catch is not a fiction problem. "The tool call
 * fires. The image generates." is not a character doing something — it is
 * a false claim about MACHINE state, indistinguishable to the user from a
 * real one, and it yields no image. Mariah (`narrative: true`) spent
 * 2026-07-28 producing exactly that, immune to all three guards because
 * the shared budget was zero.
 *
 * Voice keeps its zero: the user hears the first reply, and a rewrite
 * mid-speech is worse than the miss.
 */
export function tool_channel_reroll_budget(
  mode: 'conversation' | 'deliberation' | 'voice',
): number {
  if (mode === 'voice') return 0;
  return max_content_rerolls_per_turn();
}

/**
 * Persisted-fabrication guard gate. ON by default; kill with
 * HEARTH_PERSIST_GUARD=0. Never in test mode (fixtures don't ground).
 */
function persist_guard_enabled(): boolean {
  return (
    process.env.HEARTH_PERSIST_GUARD !== '0' && process.env.HEARTH_TEST_MODE !== '1'
  );
}

/**
 * Returns a block reason if `tc` is a durable-knowledge WRITE that would
 * persist specifics grounded in NO successful tool result this turn, WHEN a
 * read/fetch tool also failed this turn — the fabricate-after-read-failure →
 * record → self-ground laundering loop (Ruby recording an invented "Strategic
 * Trails Plan" after browse_url spiraled). Null = allow.
 *
 * Narrow by construction: fires only when BOTH a read-tier tool errored this
 * turn AND the write's args carry specifics absent from the turn's grounding
 * (which is built from SUCCESSFUL tool results). A write grounded in a read
 * that DID succeed (even if a sibling read failed) passes — so it doesn't
 * over-block the "browse_url failed but web_fetch_clean succeeded" case.
 * Deterministic (no LLM); the grounding check is the same Layer-1 the fact
 * critic uses, applied to the tool arguments instead of the reply.
 */
function persisted_fabrication_block(
  tc: { name: string; arguments?: unknown },
  tools: ToolRegistry,
  tool_calls_made: ReadonlyArray<{ name: string; error?: string }>,
  grounding_fn: () => GroundingContext,
): string | null {
  if (!persist_guard_enabled()) return null;
  const tool = tools.get(tc.name);
  if (!tool || tool.risk === 'read') return null;
  const read_failed = tool_calls_made.some(
    (c) => c.error && tools.get(c.name)?.risk === 'read',
  );
  if (!read_failed) return null;
  // Grounding is built lazily — only computed once we know this is a durable
  // write in a turn that had a read failure (rare), never on the hot path.
  const unsourced = unsourced_specifics(JSON.stringify(tc.arguments ?? {}), grounding_fn());
  if (unsourced.length === 0) return null;
  return (
    `[PERSISTENCE BLOCKED — internal system note] A read/fetch failed this turn, ` +
    `and this \`${tc.name}\` call would record specifics that appear in NO ` +
    `successful tool result you ran: ${unsourced.slice(0, 6).join(', ')}. Do not ` +
    `persist unverified data — once recorded it grounds future turns as if it ` +
    `were fact. Re-fetch the real source and record only what it actually says, ` +
    `or skip this write and say what you couldn't confirm.`
  );
}

/**
 * Phase-3 async-consult lane (the "librarian lane") toggle. When on, a
 * fact-critic-flagged turn dispatches a librarian (Cordelia) verification
 * on the LIVE tier's A4000 endpoint to FETCH the questioned claims, then
 * grounds the primary's retry against her findings — fetch-not-re-fabricate.
 * Opt-in (default OFF) because it adds a librarian sub-turn's latency to a
 * flagged turn; enable with HEARTH_ASYNC_LIBRARIAN=1 in the orchestrator
 * env. Never runs in test mode. See docs/design-two-tier-inference.md §4.
 */
function async_librarian_enabled(): boolean {
  return (
    process.env.HEARTH_ASYNC_LIBRARIAN === '1' &&
    process.env.HEARTH_TEST_MODE !== '1'
  );
}

/** The specialist that runs the librarian-lane verification (default
 *  Cordelia — the household curator with web/search/curation tools). */
function librarian_specialist_id(): string {
  return process.env.HEARTH_LIBRARIAN_SPECIALIST ?? 'cordelia';
}

/**
 * Regex provenance guard gate. **OFF by default (2026-05-31).** The
 * regex extractor's straight-single-quote rule matches contraction
 * apostrophes (`I'm … who's` → a bogus "quote"), so it fired one-retry
 * nudges on ordinary conversational replies — ~21% of turns, ~100%
 * false positives in the audit sample, and worst on think-ON specialists
 * where each false retry is a second long-reasoning turn. It also
 * *preempted* the semantic `fact_critic` (it was the `if`, critic the
 * `else if`), so disabling it lets the critic — which is the real
 * grounding verifier — actually run on those turns. Re-enable only after
 * the extractor is replaced (set `HEARTH_PROVENANCE_GUARD=1`). Read at
 * call time so smokes can toggle it post-import. */
function provenance_guard_enabled(): boolean {
  return (
    process.env.HEARTH_PROVENANCE_GUARD === '1' &&
    process.env.HEARTH_TEST_MODE !== '1'
  );
}

/**
 * Hard cap on any per-turn round override — the backstop that keeps a fat-
 * fingered override (or a directed task authored with `max_tool_rounds: 900`)
 * from running a single pass for hours. Well above every legitimate build.
 */
export const TOOL_ROUNDS_OVERRIDE_CAP = 60;

/**
 * The sequential tool-call ceiling for this specialist's turn (2026-08-11:
 * extracted + slot-scoped after the directed-build postmortem — builds were
 * dying at exactly their chat-sized caps). Read once at method entry; passed
 * down to the loop so the ceiling can't shift mid-turn under a hot-reload
 * race. Precedence:
 *   1. a per-turn `override` (directed builds size their own passes) —
 *      clamped to [1, TOOL_ROUNDS_OVERRIDE_CAP]
 *   2. on DELIBERATION turns, the specialist's `max_tool_rounds_deliberation`
 *      (a research pass legitimately runs deeper than chat; Ruby exhausted
 *      18/18 on a chat-sized ceiling, pm_24nap9a5pfm1)
 *   3. the specialist's `max_tool_rounds` (chat and fallback)
 *   4. the global default.
 * Exported for the deliberation channel and the budget-line renderer so the
 * number the prompt promises is the number the loop enforces.
 */
export function resolve_tool_round_ceiling(
  specialist: Pick<LoadedSpecialist, 'max_tool_rounds' | 'max_tool_rounds_deliberation'>,
  opts: { mode?: 'chat' | 'deliberation'; override?: number } = {},
): number {
  if (typeof opts.override === 'number' && Number.isFinite(opts.override)) {
    return Math.max(1, Math.min(Math.floor(opts.override), TOOL_ROUNDS_OVERRIDE_CAP));
  }
  if (opts.mode === 'deliberation' && specialist.max_tool_rounds_deliberation != null) {
    return specialist.max_tool_rounds_deliberation;
  }
  return specialist.max_tool_rounds ?? MAX_TOOL_ROUNDS;
}

/**
 * The output-token ceiling for this specialist's turn. Precedence: a
 * per-turn `override` (the VOICE surface caps spoken replies low) → the
 * specialist's per-config `max_tokens` (a research specialist like Kristi
 * writes longer multi-section answers) → the role's default. Output length
 * is the dominant latency cost, so `live`/`specialist` cap general chat at
 * 2000 on purpose and voice caps far tighter. `undefined` when none is set
 * → the provider uses its own default.
 */
function _effective_max_tokens(
  specialist: LoadedSpecialist,
  resolved: ReturnType<LLMRouter['for_role']>,
  override?: number,
): number | undefined {
  return override ?? specialist.max_tokens ?? resolved.defaults.max_tokens;
}

/**
 * Which activity-LED channel (if any) a tool call lights while it runs.
 * `consult_deep_model` → the Spark deep-think light; `search_library` →
 * the RAG light (turn-start auto-RAG lights RAG directly, not via here).
 * Everything else → no LED. Keep this list tight — the lights must mean
 * something specific, not blink on every tool.
 */
function _activity_channel(tool_name: string): 'rag' | 'deep' | null {
  if (tool_name === 'consult_deep_model') return 'deep';
  if (tool_name === 'search_library') return 'rag';
  return null;
}

/**
 * The LLM role a turn actually resolves to (2026-05-31). Precedence:
 *   1. explicit per-call `input.llm_role` (deliberation / drafter / a
 *      background worker passing `'librarian'`) — always wins.
 *   2. the `tier` situation hint — `tier: 'live'` routes the turn to the
 *      LIVE/CONCURRENT tier (the `live` role on the A4000) WITHOUT the
 *      specialist pinning it, so the SAME persona runs on DEEP for normal
 *      chat and on LIVE when the surface declares a live session (Astrid
 *      mid-workout; any turn that must run while the 27B is busy).
 *   3. the specialist's pinned `llm_role` (e.g. a pinned `voice_realtime`).
 *   4. the default `specialist` (DEEP, think off).
 * Callers declare the SITUATION (tier); the runtime owns
 * situation→role→GPU. Load is never an input — tier selection is
 * declarative, not load-based (see docs/design-two-tier-inference.md §3).
 */
export function resolve_effective_role(
  input: { llm_role?: import('./llm').LLMRole; tier?: 'deep' | 'live' },
  specialist: Pick<LoadedSpecialist, 'llm_role'>,
): import('./llm').LLMRole {
  if (input.llm_role) return input.llm_role;
  if (input.tier === 'live') return 'live';
  return specialist.llm_role ?? 'specialist';
}

/**
 * Which system-prompt shape this turn gets (2026-05-30). Deliberation
 * passes get the slim structured-JSON prompt; `voice_realtime` (the voice
 * surface) gets the slim voice prompt; everything else — including `live` and
 * `librarian` — is a full chat turn (a live turn is still the specialist's
 * real persona, just RAG-skipped for latency; see the RAG guard). Keyed on
 * the already-resolved EFFECTIVE role.
 */
function _prompt_mode(
  effective_role: import('./llm').LLMRole,
): 'conversation' | 'deliberation' | 'voice' {
  if (effective_role === 'specialist_deliberation') return 'deliberation';
  if (effective_role === 'voice_realtime') return 'voice';
  return 'conversation';
}

/**
 * Heuristic: does this message clearly ask for LIVE/DYNAMIC data that must be
 * fetched? Gates a forced tool call — `tool_choice:'required'` GUARANTEES a
 * fetch so a stochastic model can't answer from memory (the omission-fabrication
 * backstop). Forcing is CONDITIONAL for every always-on signal: skipped when
 * kate_pack already pre-injected the matching verified block this turn, forced
 * when it didn't — see _PREINJECTED_LOOKUPS / _lookup_preinjected just below.
 * That kills the redundant 2nd llm round (the real lookup latency) and the
 * double-grounding repeat on warm turns, while keeping the backstop whenever
 * the data is genuinely absent.
 *
 * ⚠ A signal that kate_pack pre-injects MUST still appear here, paired with a
 * _PREINJECTED_LOOKUPS row. Removing a term on the grounds that "the pack
 * covers it" is what opened the 2026-08 voice grounding void: calendar and
 * weather terms were dropped from this regex because kate_pack injected them,
 * then the pack learned to skip those blocks on voice — and each guard's
 * comment named the OTHER as the live safety net. On voice both were off, and
 * Kate spoke invented times, venues and temperatures with total confidence.
 * The pairing below is the invariant that makes that combination impossible:
 * absent block ⇒ forced fetch, present block ⇒ no redundant round.
 *
 * Kept tight otherwise: chit-chat / opinion ("what do you think", "how are
 * you") must NOT match, or a forced call fires with no relevant tool.
 */
const _LOOKUP_INTENT_RE =
  /\b(traffic|commute|how (?:far|long)|battery|charge|price|cost|how much|stock|market|news\b|headline|what time|time is it|calendar|schedule|agenda|appointment|meeting|weather|forecast|temperature|raining|snowing)\b/i;
function _looks_like_lookup(message: string): boolean {
  return _LOOKUP_INTENT_RE.test(message);
}

/**
 * Lookup intents whose data kate_pack ALSO pre-injects when the warm life-context
 * cache is fresh. When the matching verified block is ALREADY in the prompt,
 * force-fetching the same value is a redundant SECOND llm round (the dominant
 * lookup-query voice latency — the HA call itself is ~3ms) AND the double-grounding
 * (pre-injected reading + tool result) makes the small voice model pad/repeat the
 * one-line answer. So when the pack already covered the intent THIS turn, we DON'T
 * force — the model answers in ONE round from the pre-injected reading. Cold cache
 * (no block) → the forced tool stays as the backstop. Add a row when a new lookup
 * signal becomes both forced AND pre-injected.
 */
const _PREINJECTED_LOOKUPS: ReadonlyArray<{ intent: RegExp; block_marker: RegExp }> = [
  // EV: the "EV battery: N%" / range lines in kate_pack's "Home & EV status" block.
  { intent: /\b(battery|charge|range|state of charge|soc)\b/i, block_marker: /EV battery|Home & EV status/i },
  // CALENDAR: the intent regex is IMPORTED from grounding_packs — the same one
  // the pack gates its voice injection on — so "what the pack considers a
  // calendar question" and "what the backstop considers one" are the same
  // sentence, not two lists that drift. Matches BOTH pack outcomes:
  // `Calendar — UNAVAILABLE` counts as covered on purpose, since that block is
  // itself an explicit do-not-guess instruction and forcing a tool whose
  // snapshot the pack just reported missing would only re-derive the emptiness.
  { intent: CALENDAR_INTENT_RE, block_marker: /Calendar — (?:VERIFIED|UNAVAILABLE)/i },
  // WEATHER: pre-injected only when the warm life-context cache is hot, and the
  // pack skips it entirely on voice — so on a cold cache or any voice turn the
  // block is absent and the fetch is forced, which is exactly the intent.
  {
    intent: /\b(weather|forecast|temperature|temp|degrees|raining|snowing|humidity|wind)\b/i,
    block_marker: /### Weather/i,
  },
];
function _lookup_preinjected(message: string, verified_blocks: readonly string[]): boolean {
  return _PREINJECTED_LOOKUPS.some(
    (p) => p.intent.test(message) && verified_blocks.some((b) => p.block_marker.test(b)),
  );
}

/**
 * Prefix a history message's content with its local datetime so the
 * model can temporally locate what was said (2026-05-30). Without this,
 * a past message's relative time words ("today", "tomorrow", "this
 * week") are read against the CURRENT clock — a haircut Jasper mentioned
 * "today" yesterday gets reported as today's event in today's brief, and
 * the specialist "admits making it up" because it genuinely couldn't
 * distinguish yesterday's "today" from now. The `[Thu May 29, 9:02 AM]`
 * stamp is conventional metadata the model reads. tz resolves per-user
 * (falls back to the time util default). No-op when ts is absent or
 * unparseable.
 *
 * IMPORTANT: callers apply this to USER-role history ONLY. Stamping the
 * specialist's own prior replies turned out to teach the model to open
 * its output with "[Mon 8:38 PM]" (parroting the convention); the
 * grounding need is about dating what the USER said, so user-only both
 * fixes the original bug and kills the parroting.
 */
function _stamp_history_content(
  content: string,
  ts: string | undefined,
  tz: string | undefined,
): string {
  if (!ts) return content;
  const local = tz ? format_short_datetime(ts, tz) : format_short_datetime(ts);
  return local ? `[${local}] ${content}` : content;
}

/**
 * Defensive net for the above: if a model still parrots the grounding stamp
 * into its own reply ("[Mon 8:38 PM] Here's the bottom line…"), strip the
 * leading bracket. Anchored on a weekday abbreviation so it can NEVER eat a
 * legitimate leading markdown link like "[text](url)". Applied to the model's
 * captured reply only (not fallback/exhaustion strings).
 */
function strip_leading_stamp(s: string): string {
  return s.replace(/^\s*\[(?:mon|tue|wed|thu|fri|sat|sun)\b[^\]\n]{0,40}\]\s*/i, '');
}

export interface SpecialistTurnInput {
  specialist_id: string;
  conversation_id: string;
  message: {
    role: 'user' | 'specialist';
    content: string;
    from_specialist_id?: string;
  };
  conversation_history: Array<{
    role: 'user' | 'specialist' | 'system';
    content: string;
    specialist_id?: string;
    /**
     * ISO-8601 UTC timestamp of when this message was sent. Threaded
     * from the message row so the runtime can stamp each history line
     * with its LOCAL datetime — without it the model reads a past
     * message's "today"/"tomorrow"/"this week" against the CURRENT
     * clock and mis-dates events (e.g. a haircut mentioned yesterday
     * reported as "today" in today's brief). Optional for back-compat
     * with callers that don't pass it (consult path sends []).
     */
    ts?: string;
  }>;
  /**
   * Calling user. Threaded through from the auth-gated route handler
   * (`c.get('user')`). When set, the runtime:
   *   - injects "You are talking to <User>" into the system prompt
   *   - swaps each specialist's `memory.md` for `memory_<user_id>.md`
   *     (Kate exempt — she always loads the canonical memory.md and
   *     uses persona discretion to filter)
   *   - applies the `private_to: <user_id>` frontmatter filter to
   *     RAG retrieval (Kate bypasses)
   * Defaults to `{ id: 'jasper', display_name: 'Jasper' }` when absent
   * so deliberation passes, schedulers, and the legacy single-user
   * code paths keep working without explicit caller updates.
   */
  user?: { id: string; display_name: string; tier?: import('./users').Tier; timezone?: string };
  /**
   * Override the LLM role this turn resolves to. Defaults to
   * `'specialist'` — the fast-path chat role with think OFF.
   * Deliberation passes use `'specialist_deliberation'` (think ON);
   * voice-imitation drafters use `'specialist_drafter'`.
   */
  llm_role?: LLMRole;
  /**
   * Situation hint for tier selection (2026-05-31). `'live'` routes this
   * turn to the LIVE/CONCURRENT tier (the `live` role on the A4000) when
   * no explicit `llm_role` is set — for a turn that must run WHILE the
   * user is mid-conversation on the 27B (Astrid coaching mid-workout) or
   * any latency-sensitive concurrent turn. The caller declares the
   * situation; `resolve_effective_role` maps it to the role/GPU. `'deep'`
   * (or omitted) keeps the normal DEEP path. Never set from load — tier
   * selection is declarative (see docs/design-two-tier-inference.md §3).
   */
  tier?: 'deep' | 'live';
  /**
   * Origin surface of this turn (2026-06-05), threaded from the message
   * route. `'voice'` means the reply will be SPOKEN ALOUD by TTS (today: the
   * Satellite1 → Kate stack via openai_shim). When set to `'voice'` AND the
   * specialist has a `voice_style` block, build-prompt appends that block as
   * the recency-weighted tail so the OUTPUT is speakable (no markdown, units
   * as words). Omitted/`'web'`/`'telegram'` ≡ unchanged screen-text behavior.
   * Distinct from `llm_role: 'voice_realtime'` (the voice surface) — that swaps the whole
   * prompt; this only overlays output rules onto the normal persona.
   */
  surface?: 'web' | 'telegram' | 'voice';
  /**
   * Extra system-prompt context appended AFTER the persona (2026-07-27), for
   * per-turn framing the persona itself shouldn't carry. Used by agent rooms to
   * tell a specialist it's in a multi-party group chat and must speak strictly
   * as itself. Appended as the recency-weighted tail of the system message, so
   * it wins attention. Omitted ≡ unchanged.
   */
  extra_system?: string;
  /**
   * Decouple the inference ENDPOINT from the turn's BEHAVIOR (2026-05-31).
   * When set, the provider/model is resolved from `provider_role` while
   * the prompt shape + tool curation stay keyed on the behavior role
   * (`llm_role`). This is what lets a deliberation pass keep its
   * structured-JSON prompt + `tools_for_deliberation` curation
   * (`llm_role: 'specialist_deliberation'`) while running on the LIVE
   * tier's A4000 server (`provider_role: 'librarian'`) to drain off the
   * 3090 — and is the seam the Phase-3 async-consult lane uses to run a
   * `librarian` verification concurrently with a DEEP primary turn.
   * Defaults to the behavior role's own endpoint.
   */
  provider_role?: LLMRole;
  /**
   * Per-call override of the role's `think` setting. When undefined,
   * the role default from llm-roles.yaml applies. Used by
   * deliberation passes to honor a specialist's
   * `proactive.think_in_deliberation` YAML field — Beatrice runs her
   * deliberation think-off even though the role default is think-on,
   * because the think tax pushes her past the LLM timeout under
   * typical persona + context size.
   */
  think_override?: boolean;
  /**
   * Per-call hard ceiling on output tokens, overriding the role default
   * (and a specialist's own `max_tokens`). The VOICE surface sets a low
   * cap (~200) so a spoken reply stays a sentence or two — you can't skim
   * audio, and output length is the dominant turn-latency cost. Precedence:
   * this override → the specialist's `max_tokens` → the role default.
   * Mirrors `think_override`: a per-turn behavior knob, not a role/endpoint
   * change.
   */
  max_tokens_override?: number;
  /**
   * Whether to stream reply tokens to the client (message_token SSE) during
   * this turn. Defaults to streaming. The non-streaming `turn()` shim sets
   * this to `false`: the turn runs a single complete() per round and emits no
   * token events, but materialises the identical SpecialistTurnOutput. Used by
   * the internal/background callers (consult, async librarian, deliberation,
   * the eval harness, intake turns) that read the result synchronously and
   * have no live token consumer.
   */
  stream?: boolean;
  /**
   * Per-turn explicit tool surface, overriding the YAML-curated
   * `tools_for_chat` / `tools_for_deliberation` list for THIS turn only.
   * Used by directed-task deliberation (loops.ts → deliberation.ts): a
   * focused architect set (`propose_code_change`, `read_codebase_file`,
   * `grep_codebase`, …) surfaces tools that are GRANTED but curated out of
   * the standing list — `propose_code_change` is the canonical case (Beatrice
   * holds `write_codebase_pr` but it's on neither curated surface, so it was
   * invisible). Still capability-gated: `available` is pre-filtered to the
   * specialist's granted tools, so an override naming a tool they can't
   * invoke is simply absent. Undefined → the normal curated list applies.
   */
  tools_override?: readonly string[];
  /**
   * Force a tool call on ROUND 0 (`tool_choice: 'required'`). Set by the
   * directed-task deliberation channel when the directive's tool surface
   * was explicitly narrowed: the directed contract is "the deliverable is
   * a completed tool call," but instruction text alone demonstrably
   * doesn't enforce it — two directed passes at Mariah on 2026-06-10
   * produced 62-token envelopes with ZERO tool calls. Round 0 only; once
   * a tool has run the model proceeds normally. Guided-decoded on both
   * backends (the voice forced-fetch gate verified this); a no-op if a
   * backend ignores it.
   */
  require_tool_call?: boolean;
  /**
   * External cancellation for the whole turn. The route handler that
   * triggered this turn passes its registered AbortController's
   * signal so the user can stop a runaway specialist mid-flight.
   * Forwarded into every provider.complete() call and checked
   * between tool-call rounds.
   */
  signal?: AbortSignal;
  /**
   * Consult-chain nesting depth (2026-08-05). 0 (or absent) = a normal
   * chat/deliberation turn; `consult()` runs the consultee's sub-turn at
   * depth+1. The dispatch loop threads this back into `consult()` so the
   * ConsultGuard can cut A→B→A ping-pong at HEARTH_CONSULT_MAX_DEPTH —
   * the 2026-08-04 trainer↔Ruby spiral (256 inbox rows in a day, an
   * eight-minute 21:31–21:39Z burst) had no depth signal to cut on.
   * Never set by external callers.
   */
  consult_depth?: number;
  /**
   * Per-turn override of the tool-round ceiling (2026-08-11, directed-build
   * postmortem). Set by the deliberation channel for DIRECTED passes: a build
   * authoring a PR needs read→design→edit→re-file chains that chat-sized caps
   * guillotine (three builds died at exactly 15/15 then 20/20 on 2026-08-10/11).
   * Clamped to [1, TOOL_ROUNDS_OVERRIDE_CAP] in resolve_tool_round_ceiling.
   * Precedence: this → the YAML deliberation-slot ceiling → `max_tool_rounds`
   * → the global default.
   */
  tool_rounds_override?: number;
  /**
   * Marks this turn as a DIRECTED pass (owner-approved build) and carries the
   * context a failure report needs (2026-08-11). When set, two failure shapes
   * stop being silent: a `blank_turn_fallback` files a process_miss (an
   * approved build producing nothing is a ledger event, not an audit
   * footnote), and the SECOND identical failed tool call ends the pass with a
   * filed miss instead of burning the remaining rounds (the propose_code_edit
   * ×5 retry loop). Never set on chat/voice turns.
   */
  directed_context?: { instruction_preview: string };
}

export interface SpecialistTurnOutput {
  message_text: string;
  tool_calls_made: Array<{
    name: string;
    input: unknown;
    result?: unknown;
    error?: string;
    /** Recovery hints carried out of a failed call (`InvokeOutcome.candidates`).
     *  Serialized into `messages.tool_calls_json` so the honesty audit can
     *  distinguish "the tool offered nothing" from "the tool named the fix". */
    candidates?: string[];
  }>;
  proposals_created: string[];
  consulted_specialists: string[];
  reasoning_trace: string;
  cost: { tokens_in: number; tokens_out: number; ms: number; model: string };
}

export interface SpecialistRuntimeDeps {
  specialists: SpecialistRegistry;
  llm: LLMRouter;
  memory: MemoryClient;
  tools: ToolRegistry;
  proposals: ProposalsStore;
  inbox: SpecialistInbox;
  /** UserRegistry for the grounding-pack household-presence join (who's-home
   *  block, 2026-07-28). Optional + fail-open: absent → occupancy degrades to
   *  the sighting-only view, exactly like the household_occupancy tool. */
  users?: import('./users').UserRegistry;
  /** Optional event bus; if present, the runtime emits thinking/proposal events. */
  events?: { emit: (e: import('../app/events').AppEvent) => void };
  /**
   * Process-miss ledger (2026-05-30). Optional so existing boots and
   * smoke tests that don't wire it remain working; when present, the
   * runtime files a miss on tool-round-ceiling exhaustion so Beatrice's
   * `analyze_systemic_pattern` can detect research-efficiency gaps as a
   * structural pattern instead of as individual blank-turn rows. Closes
   * the loop on the Vivian 2026-05-30 incident where ceiling exhaustion
   * was being treated as a one-off runtime error rather than the
   * affordance gap it actually is.
   */
  /**
   * Tier-1 procedural memory (2026-08-03). Optional + fail-open, exactly like
   * `process_misses` / `users` above: absent → the procedures block renders as
   * '' and every turn is byte-identical to the pre-skills prompt. Present →
   * the specialist sees a one-line-per-skill awareness list and can pull a
   * body with `recall_skill`. The runtime NEVER executes a skill; see
   * src/core/skills.ts for why that single fact is the whole safety story.
   */
  skills?: import('@memory/stores/skills').SkillsStore;
  process_misses?: import('./process_misses').ProcessMissStore;
  /**
   * Guard-telemetry handle (2026-08-11, directed-build postmortem). When
   * present, tool-round-ceiling exhaustion and the directed duplicate-failure
   * cut increment their `guard_counters` rows (fail-open) so Mariah's
   * recurrence sweep sees a gate that repeatedly blocks work. Optional —
   * absent boots/smokes are byte-identical.
   */
  db?: import('bun:sqlite').Database;
  /**
   * RAG embedder (Pass 7). When `.enabled`, turn-start auto-retrieval fuses
   * vector search with FTS (see `retrieve_hybrid`). Optional — absent boots
   * (and smokes) get a NoopEmbedder via the runtime's `embedder` getter, so
   * retrieval stays FTS-only, identical to pre-RAG behavior.
   */
  embedder?: import('./embeddings').Embedder;
}

/**
 * Compact one-line description per tool, given to the LLM in the system
 * prompt so it knows what's available without re-reading every Tool def.
 */
function tool_summary(tools: { name: string; description: string }[]): string {
  return tools
    .map((t) => `  - ${t.name}: ${t.description}`)
    .join('\n');
}

function to_tooldef(
  tool: { name: string; description: string; input_schema: z.ZodType },
  /** Sanitized worked-example args (tool_exemplars) — appended to the
   *  description. One real example beats a schema alone for small models. */
  exemplar?: string | null,
): ToolDef {
  // Convert the tool's Zod input_schema to a real JSON Schema so the model
  // sees every parameter — name, type, enum, required. A property-less
  // schema makes Qwen3.6 emit tool calls with empty `{}` args: it fills
  // <parameter> blocks from the schema's `properties`, not from prose in
  // the description. `$refStrategy: 'none'` inlines enums/nested objects
  // so there are no `$ref`s for llama.cpp's tool-call parser to choke on.
  // `sanitize_tool_schema_for_grammar` then drops the grammar-hostile keyword
  // class (minLength/maxLength/pattern/format/numeric+item bounds) that
  // llama.cpp's `--jinja` GBNF compiler mistranslates or collides on — the
  // 2026-07-13 "failed to parse grammar" 400 — while the Zod schema keeps
  // enforcing those bounds at execute() time. See tool_schema_grammar.ts.
  let parameters: object;
  try {
    const schema = zodToJsonSchema(tool.input_schema, {
      $refStrategy: 'none',
    }) as Record<string, unknown>;
    delete schema.$schema;
    parameters = sanitize_tool_schema_for_grammar(schema) as object;
  } catch (err) {
    console.warn(
      `[to_tooldef] zod→json-schema conversion failed for "${tool.name}"; ` +
        `falling back to permissive schema`,
      err,
    );
    parameters = { type: 'object', additionalProperties: true };
  }
  return {
    name: tool.name,
    description: exemplar
      ? `${tool.description}\nExample call (sanitized from real usage): ${exemplar}`
      : tool.description,
    parameters,
  };
}

/** The runtime-synthesized teammate-consult meta-tool. Exported because skill
 *  validation must count it as callable — it is real, just not registry-backed. */
export const CONSULT_TOOL_NAME = 'consult_specialist';

/**
 * One-line, user-readable summary of a tool invocation for the SSE
 * `tool_invoked` event. Picks the most informative field for common
 * tools and falls back to a short JSON preview. Never raw input
 * dump — the live status line stays short and human-friendly.
 */
function _summarize_tool_input(tool_name: string, input: unknown): string {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  switch (tool_name) {
    case 'web_fetch_clean':
      return String(obj.url ?? '');
    case 'web_search':
      return typeof obj.query === 'string' ? `"${obj.query}"` : '';
    case 'search_library':
      return typeof obj.query === 'string' ? `"${obj.query}"` : '';
    case 'query_audit_log':
      return obj.agent ? `agent=${obj.agent}` : 'recent activity';
    case 'sensor_calendar_upcoming':
      return typeof obj.until === 'string' ? `until ${obj.until}` : 'calendar';
    case 'ha_get_state':
      return typeof obj.entity_id === 'string' ? obj.entity_id : '';
    case 'ha_list_entities': {
      const parts: string[] = [];
      if (typeof obj.domain === 'string') parts.push(obj.domain);
      if (typeof obj.name_contains === 'string') parts.push(`"${obj.name_contains}"`);
      return parts.join(' · ');
    }
    case 'route':
      return `${obj.from_name ?? '?'} → ${obj.to_name ?? '?'}`;
    case 'geocode':
      return typeof obj.address === 'string' ? obj.address : '';
    case 'nearby':
      return typeof obj.amenity === 'string' ? obj.amenity : '';
    case 'promise_followup':
      return typeof obj.summary === 'string' ? `"${obj.summary}"` : 'follow-up';
    case 'import_gedcom':
      return typeof obj.path === 'string' ? obj.path : '';
    case 'consult_specialist':
      return typeof obj.specialist_id === 'string' ? `→ ${obj.specialist_id}` : '';
    case 'propose_code_change':
    case 'propose_code_edit':
      return typeof obj.pr_title === 'string' ? obj.pr_title : 'code change';
    case 'read_codebase_file':
      return typeof obj.path === 'string' ? obj.path : '';
    case 'grep_codebase':
      return typeof obj.pattern === 'string' ? `"${obj.pattern}"` : '';
    default: {
      const json = JSON.stringify(input);
      return json && json.length <= 60 ? json : '';
    }
  }
}

/**
 * Multi-line "what is this tool producing" snippet for the code tools — the PR
 * title + file path(s) + a capped head of the actual code being written/added.
 * Returned on `tool_invoked.preview` so a UI can show a live "code in progress"
 * peek during a directed build. Capped here so the SSE frame stays small;
 * undefined for any non-code tool. Code only — never user-private data.
 */
function _code_preview(tool_name: string, input: unknown): string | undefined {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const cap = (s: string): string => {
    const lines = String(s ?? '').split('\n').slice(0, 20).join('\n');
    return lines.length > 1400 ? `${lines.slice(0, 1400)}\n…` : lines;
  };
  if (tool_name === 'propose_code_change') {
    const files = Array.isArray(o.files)
      ? (o.files as Array<{ path?: string; contents?: string }>)
      : [];
    if (files.length === 0) return undefined;
    const paths = files.map((f) => f?.path).filter(Boolean).join(', ');
    const head = [typeof o.pr_title === 'string' ? o.pr_title : 'new file', paths].filter(Boolean).join('\n');
    const body = cap(files[0]?.contents ?? '');
    return `${head}\n\n${body}${files.length > 1 ? `\n\n…+${files.length - 1} more file(s)` : ''}`;
  }
  if (tool_name === 'propose_code_edit') {
    const edits = Array.isArray(o.edits)
      ? (o.edits as Array<{ path?: string; new_string?: string }>)
      : [];
    if (edits.length === 0) return undefined;
    const paths = [...new Set(edits.map((e) => e?.path).filter(Boolean))].join(', ');
    const head = [typeof o.pr_title === 'string' ? o.pr_title : 'edit', paths].filter(Boolean).join('\n');
    const body = cap(edits[0]?.new_string ?? '');
    return `${head}\n\n${body}${edits.length > 1 ? `\n\n…+${edits.length - 1} more edit(s)` : ''}`;
  }
  return undefined;
}

/**
 * Maximum characters of a tool's serialized result that we feed back
 * into the LLM context on subsequent rounds. The FULL result is still
 * captured in the audit log AND in the persisted message's
 * tool_calls_json (so the user can inspect and `search_library` can
 * still pick it up if it was stashed to vault). What we truncate is
 * specifically the next-round prompt — because every accumulated
 * web_fetch markdown blob compounds quadratically into prompt-eval
 * cost. On the integrated AI accelerator at 35B-MoE q8, an un-truncated 6-fetch
 * conversation produces 100KB+ prompts that take 60-180s of prompt
 * eval per round, before generation. 4000 chars per tool result
 * keeps the head + key fields readable while bounding context bloat.
 */
/* Tool-result compaction (head + high-signal lines + truncation marker)
 * lives in `./tool_result_compaction.ts` so it can be smoke-tested
 * independently and per-tool budget can be plumbed through a single
 * call site. Phase 1 of the design at
 * docs/design-tool-output-compression.md. */

/**
 * Within-turn tool-call signature for dedup. Hashes (tool_name +
 * canonicalized input) so a literal retry of the same call is caught.
 * Canonicalization is cheap: JSON.stringify with sorted keys. This
 * doesn't dedup semantically-equivalent calls (e.g. two web_fetch
 * URLs that redirect to the same place), which is fine — the goal
 * is to catch the "definition of insanity" pattern where the LLM
 * retries the exact same call expecting different results.
 */
function _call_signature(tool_name: string, input: unknown): string {
  let canon: string;
  try {
    canon = JSON.stringify(input, Object.keys(input ?? {}).sort());
  } catch {
    canon = String(input);
  }
  return `${tool_name}::${canon}`;
}

/**
 * Format the error the LLM sees when it retries an identical tool
 * call within the same turn. Crafted to be actionable — names the
 * tool, points at the no-op nature of the retry, and offers two
 * productive next moves.
 */
/**
 * Narrow the tools shown to the LLM per turn type. Deliberation
 * passes use `specialist.proactive.tools_for_deliberation`;
 * conversation turns (`llm_role === 'specialist'`) use
 * `tools_for_chat`. When the relevant list is empty/omitted, that
 * turn type gets every tool the specialist's capabilities grant
 * (legacy behavior). Other roles always see the full set.
 *
 * Why this exists: bench 2026-05-19 showed Qwen3.6 reliably fills
 * tool args when 1-3 tools are in scope, but drops args to `{}`
 * when 15+ tools' schemas are competing for the decision surface.
 * Curating per workflow gives the model the focused choice surface
 * it can actually act on, without removing capabilities globally.
 *
 * If the curated list contains a name the specialist doesn't have
 * capability for (or doesn't exist in the registry), the entry is
 * silently dropped — capability check is the source of truth, the
 * curation list is purely a UX-shaping filter on top.
 */
/**
 * Tools every specialist gets in chat AND deliberation turns IF they
 * hold the relevant capability — independent of whether
 * `tools_for_chat` / `tools_for_deliberation` lists them.
 *
 * The principle: knowledge-of-your-own-knowledge is structural, not
 * an opt-in. Pre-2026-05-27 every specialist had to remember to list
 * `search_library` + `read_note` + `read_inbox` in their
 * `tools_for_chat`, and most didn't (8 of 12 weren't even curated;
 * Brigid HAD `read_inbox` but no library tools; etc.). The result
 * was Brigid receiving a routed Dunkin'-cup capture, writing it to
 * her own `Knowledge/Brigid/labels/` directory, and then being
 * unable to find it when Jasper asked because she literally had no
 * tool in her chat surface to read it.
 *
 * 2026-07-17 (owner directive — "remove the restriction, make them
 * actually autonomous"): the floor now also applies to DELIBERATION
 * turns. Previously a curated `tools_for_deliberation` list silently
 * excluded the read floor, so a specialist's autonomous passes — the
 * turns where it most needs to verify before acting — couldn't
 * search or read at all (10 of 14 had no library tools there). The
 * floor also grew the memory notebook (`remember` / `read_memory`),
 * distilled recall (`recall_brain`), and `read_my_proposals` — the
 * gap that had Mariah hallucinating a filed note's content because
 * she could see only a truncated audit preview of her own proposal.
 *
 * Curated `tools_for_chat` lists stay valuable — they narrow the
 * DOMAIN tool surface Qwen sees per turn (mealie tools for Brigid,
 * HA tools for Iris) so args don't fumble on a wide grant. But the
 * structural read floor (search the vault, read notes, see your own
 * inbox and proposals, remember, ask the user a question) is always
 * present.
 *
 * Capability gate still applies: a specialist without `read_vault`
 * doesn't get `search_library` even though it's listed here. The
 * filter at the bottom of `_curate_tools_for_turn` removes any base
 * entry the specialist's granted set doesn't cover.
 */
const BASE_TOOLSET: ReadonlyArray<{
  tool_name: string;
  /** Required capability — null means "always available". */
  required_capability: string | null;
}> = [
  { tool_name: 'search_library', required_capability: 'read_vault' },
  { tool_name: 'read_note', required_capability: 'read_vault' },
  // Distilled syntheses (the "brain") — the high-signal complement to
  // raw chunk search. Part of the read floor since 2026-07-17.
  { tool_name: 'recall_brain', required_capability: 'read_vault' },
  { tool_name: 'read_inbox', required_capability: 'read_inbox' },
  // The memory notebook (src/tools/memory_notebook.ts) — every
  // specialist can durably remember and re-read their own
  // Knowledge/<Name>/memory.md without a proposal round-trip. Both
  // are hard-scoped to the caller's own notebook, so no capability
  // token is needed.
  { tool_name: 'remember', required_capability: null },
  { tool_name: 'read_memory', required_capability: null },
  // Own-proposal visibility (src/tools/read_my_proposals.ts) — a
  // specialist can read back the full body of proposals THEY filed
  // instead of guessing from truncated audit-log previews.
  { tool_name: 'read_my_proposals', required_capability: null },
  { tool_name: 'present_questions', required_capability: null },
  // Every specialist should be able to say "I've only skimmed this — let me
  // keep digging and come back" instead of forcing a shallow answer at the
  // budget ceiling. promise_followup is a universal, ungated tool
  // (src/tools/promise_followup.ts); putting it in the chat floor means the
  // budget-signal "schedule a follow-up" path works for ALL specialists, not
  // just the 9 that happened to list it in tools_for_chat.
  { tool_name: 'promise_followup', required_capability: null },
  // The durable-grounding floor (2026-05-30). When a specialist hits a
  // knowledge gap mid-turn — search_library came up thin on a fact they
  // need — the grounding rule tells them to flag Cordelia so the source
  // gets curated for next time. That path only works if flag_cordelia is
  // actually in their chat surface; pre-2026-05-30 only Cordelia + Ruby
  // listed it. write_proposals is granted to all 14 specialists, so this
  // makes the "fill the shelf instead of fabricating" move universal.
  { tool_name: 'flag_cordelia', required_capability: 'write_proposals' },
];

function _curate_tools_for_turn<T extends { name: string }>(
  available: T[],
  specialist: LoadedSpecialist,
  llm_role: import('./llm').LLMRole | undefined,
  override?: readonly string[],
): T[] {
  // `live` is a chat turn on the LIVE tier — curate it exactly like the
  // default `specialist` chat role (curated tools_for_chat + the base
  // knowledge toolset), so a live Astrid coaching turn keeps her chat
  // tools rather than falling through to the uncurated full surface.
  // `voice_realtime` (the lean voice surface) also curates as chat UNLESS
  // it has its own `tools_for_voice` list (below).
  const is_chat =
    llm_role === 'specialist' || llm_role === 'live' || llm_role === 'voice_realtime';
  // The VOICE surface gets its OWN tight list when configured. Each tool's
  // serialized JSON schema is prefill the small/fast voice model pays EVERY
  // turn: Kate's 37-tool chat surface is ~9.8K+ tokens of tool defs, the
  // bulk of an 18.7K-token voice prompt (measured 2026-06-07). A spoken
  // receptionist needs a handful of read/escalate tools, not the research
  // surface — so `tools_for_voice` (when set) REPLACES tools_for_chat AND
  // suppresses the base-toolset union below (voice has no knowledge-first
  // snippet, so list any reads explicitly). consult_specialist is appended
  // by the runtime regardless, so depth stays one consult away. Unset →
  // voice falls back to tools_for_chat (legacy; a specialist with no voice surface is unchanged).
  const is_voice_curated =
    llm_role === 'voice_realtime' &&
    (!override || override.length === 0) &&
    specialist.proactive.tools_for_voice.length > 0;
  let allow: readonly string[] | undefined;
  if (override && override.length > 0) {
    // Per-turn explicit surface (directed-task deliberation). Replaces the
    // YAML-curated list — `available` is already capability-filtered, so a
    // name the specialist can't invoke is simply dropped by the filter below.
    allow = override;
  } else if (llm_role === 'specialist_deliberation') {
    allow = specialist.proactive.tools_for_deliberation;
  } else if (is_voice_curated) {
    allow = specialist.proactive.tools_for_voice;
  } else if (is_chat) {
    allow = specialist.proactive.tools_for_chat;
  } else {
    return available;
  }
  if (!allow || allow.length === 0) return available;
  const allow_set = new Set(allow);
  // Chat AND deliberation: union the curated list with the base
  // toolset (filtered by capability). Deliberation used to keep the
  // curated list as-is on the theory that the injected inbox +
  // observations + memory-tail context covered knowledge access —
  // but that context is a fixed snapshot; a deliberating specialist
  // that needs to verify a fact mid-pass had NO read path
  // (2026-07-17 owner directive: autonomous passes get the same read
  // floor as chat). A voice turn on its own `tools_for_voice` list
  // still skips the union — keep voice prefill minimal; the list is
  // the exact surface.
  if ((is_chat || llm_role === 'specialist_deliberation') && !is_voice_curated) {
    for (const base of BASE_TOOLSET) {
      if (allow_set.has(base.tool_name)) continue;
      if (
        base.required_capability !== null &&
        !specialist.granted.has(base.required_capability)
      ) {
        continue;
      }
      // Only add when the tool is actually in `available` (registered
      // + capability-gated for the specialist by the upstream filter).
      // Adding a name that isn't in `available` would be invisible to
      // the LLM anyway — skip it silently to avoid bloating the list.
      if (available.some((t) => t.name === base.tool_name)) {
        allow_set.add(base.tool_name);
      }
    }
  }
  const filtered = available.filter((t) => allow_set.has(t.name));
  return filtered.length > 0 ? filtered : available;
}

/**
 * Note served when the model repeats a tool call whose first run
 * SUCCEEDED. Served on the RESULT channel (cache semantics), not as an
 * error. The error-channel version of this guard fed three downstream
 * pathologies (2026-06-09 meta-loop audit): the model read the error
 * and retried into a spiral, the burned rounds filed
 * runtime-affordance-gap misses, and Mariah's authenticity scan read
 * the error as an unrecovered read failure and opened fabrication
 * misses against well-behaved specialists. Idempotent reads ARE a
 * cache, so re-serving the first result is semantically honest; the
 * `duplicate_call: true` marker on the recorded call keeps the
 * behavior observable for the spiral guard, the exhaustion message,
 * and the authenticity scan's retry_storm pattern.
 */
function _dedup_cached_note(tool_name: string): string {
  return (
    `DUPLICATE_CALL_SERVED_FROM_CACHE: you already called \`${tool_name}\` with ` +
    `these exact arguments this turn — below is the SAME result again, not a ` +
    `fresh read. Do not repeat this call. Act on the result, call ` +
    `${tool_name} with DIFFERENT arguments, or write your reply from what ` +
    `you have.`
  );
}

/**
 * Error served when the model repeats a tool call whose first run
 * FAILED. Stays on the ERROR channel on purpose — an identical retry
 * of a failed call is still a failure, and the authenticity scan's
 * recovery detection must not mistake it for a successful later read.
 * Keeps the DUPLICATE_TOOL_CALL token so existing detectors match.
 */
function _dedup_failed_error_for(
  tool_name: string,
  original_error: string | undefined,
): string {
  return (
    `DUPLICATE_TOOL_CALL: you already called \`${tool_name}\` with these exact ` +
    `arguments this turn and it FAILED. An identical retry cannot succeed — ` +
    `the tool is telling you THAT input doesn't work. Change the input (a ` +
    `different URL, a different query, a different path) or report back what ` +
    `you couldn't retrieve. Do not retry this call.` +
    (original_error ? ` Original error: ${original_error.slice(0, 300)}` : '')
  );
}

/**
 * Cap on re-served cached content so a duplicate of a huge read (a 5 KB
 * codebase file) doesn't double its prompt cost. The full text is still
 * in the earlier tool message; this re-emission exists so a model whose
 * attention slipped (or whose earlier result was compacted) can act
 * without a third call.
 */
const DUP_CACHE_REEMIT_CAP = 2_000;
function _render_dup_cached(content: string): string {
  if (content.length <= DUP_CACHE_REEMIT_CAP) return content;
  return (
    content.slice(0, DUP_CACHE_REEMIT_CAP) +
    `\n…[duplicate re-serve truncated — the full result is in your earlier tool message above]`
  );
}

/** The recorded-call marker for a duplicate served from cache. */
function _is_duplicate_call_result(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as Record<string, unknown>).duplicate_call === true
  );
}

/**
 * Detect a same-tool spiral at the TAIL of the call list: N consecutive calls on
 * ONE tool that each either threw (`c.error`), came back as a cache-served
 * duplicate, or returned a SOFT failure (the call didn't throw but its own
 * payload says `{ok:false}`/`{error}` — e.g. browse_url's agentd 503s). Returns
 * the streak or null. Exported so the guard is unit-testable.
 *
 * The soft-failure arm (2026-07-20) is the fix for the connector-storm blind
 * spot: soft failures set no `c.error`, so the streak used to break on the first
 * one and the guard never fired — a browse_url 503 storm ran the whole turn out
 * (62 of 67 events on one 2026-07-09 intent shared a single intent_id). Reuses
 * the canonical `_result_indicates_failure` classifier — general to any tool
 * that reports its own failure, never a browse_url carve-out.
 */
export function same_tool_spiral(
  tool_calls_made: ReadonlyArray<{
    name: string;
    input?: unknown;
    result?: unknown;
    error?: string;
    candidates?: readonly string[];
  }>,
): { tool: string; streak: number; dups: number; distinct_args: number; distinct_errors: number } | null {
  let streak = 0;
  let dups = 0;
  let tool: string | null = null;
  const arg_keys = new Set<string>();
  const err_sigs = new Set<string>();
  for (let i = tool_calls_made.length - 1; i >= 0; i--) {
    const c = tool_calls_made[i];
    if (!c) break;
    const is_dup = _is_duplicate_call_result(c.result);
    const is_soft_fail = _result_indicates_failure(c.result);
    if (!c.error && !is_dup && !is_soft_fail) break;
    // A failure that hands the model its next move is not spiral fuel — see
    // _failure_offers_recovery. Treat it as a break in the streak: the model
    // has somewhere to go, and following that path is progress.
    if (!is_dup && _failure_offers_recovery(c.result, c.candidates)) break;
    if (tool === null) {
      tool = c.name;
      streak = 1;
      dups = is_dup ? 1 : 0;
    } else if (c.name === tool) {
      streak++;
      if (is_dup) dups++;
    } else {
      break;
    }
    arg_keys.add(_args_key(c.input));
    err_sigs.add(_failure_signature(c));
  }
  return tool
    ? { tool, streak, dups, distinct_args: arg_keys.size, distinct_errors: err_sigs.size }
    : null;
}

/**
 * Is this streak actually a SPIRAL — the model stuck — or is it progressing
 * work that keeps hitting different walls?
 *
 * The 2026-07-29 civic pass is the case that forced this apart. Ruby called
 * `browse_url` on three DIFFERENT urls, each a legitimate next step (one of
 * them handed to her by a failing `web_fetch_clean`'s own `candidates` list),
 * and the argument-blind guard scored it identically to three retries of one
 * dead call — exhausting a turn that had 14 of 18 rounds left and 50k chars
 * of the municipal code already in hand. The runtime's own DUPLICATE_TOOL_CALL
 * message tells the model to "change the input (a different URL)"; punishing
 * it for complying is the contradiction this closes.
 *
 * Two honest shapes, two thresholds:
 *
 *   - **Repetition** (the model can't fill args or can't stop): the same
 *     arguments come back around. 3 strikes, unchanged.
 *   - **Connector storm** (the tool itself is down): distinct arguments but
 *     ONE repeated error signature — the 2026-07-20 browse_url 503 case. Still
 *     caught, at a slightly higher bar so genuine exploration survives.
 *
 * Distinct arguments AND distinct errors is neither — that's a researcher
 * working a list. Let it run.
 */
export function spiral_is_stuck(
  s: { streak: number; distinct_args: number; distinct_errors: number },
): boolean {
  const REPETITION_LIMIT = 3;
  const STORM_LIMIT = 5;
  if (s.distinct_args <= 1) return s.streak >= REPETITION_LIMIT;
  if (s.distinct_errors <= 1) return s.streak >= STORM_LIMIT;
  return false;
}

/** Stable key for a call's arguments, so "same call again" is distinguishable
 *  from "next candidate in a list". Key order is normalized; unserializable
 *  input degrades to a constant (treated as repetition — the conservative
 *  direction, since that's the shape the old guard already caught). */
function _args_key(input: unknown): string {
  if (input === null || input === undefined) return '∅';
  try {
    if (typeof input !== 'object') return String(input);
    const r = input as Record<string, unknown>;
    return JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]));
  } catch {
    return '∅';
  }
}

/** Coarse signature of WHY a call failed, so a dead connector (one error,
 *  over and over) reads differently from varied per-target failures. Numbers
 *  and quoted specifics are stripped so "404 for /a" and "404 for /b" match. */
function _failure_signature(c: { result?: unknown; error?: string }): string {
  let raw = c.error ?? '';
  if (!raw && c.result !== null && typeof c.result === 'object') {
    const r = c.result as Record<string, unknown>;
    if (typeof r.error === 'string') raw = r.error;
    else if (r.ok === false) raw = 'ok:false';
  }
  return raw.toLowerCase().replace(/\d+/g, '#').replace(/["'`].*?["'`]/g, '·').slice(0, 80);
}

/**
 * Does this failure ship the model a concrete way forward? `web_fetch_clean`
 * returns `candidates` (alternate urls with why_relevant) and many connectors
 * return a `recovery_hint`. Following one is exactly the adaptation we want,
 * so such a failure must never count toward a spiral.
 */
function _failure_offers_recovery(result: unknown, candidates?: readonly string[]): boolean {
  // A THROWN failure has no result object at all — its hints ride the
  // invoke envelope (`InvokeOutcome.candidates`). Without this arm, a
  // specialist that correctly follows a thrown-error hint would still
  // accrue spiral streak and get cut off for adapting.
  if (candidates !== undefined && candidates.length > 0) return true;
  if (result === null || typeof result !== 'object') return false;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.candidates) && r.candidates.length > 0) return true;
  if (typeof r.recovery_hint === 'string' && r.recovery_hint.trim().length > 0) return true;
  return false;
}

/**
 * The THROW-path sibling of `_recovery_nudge_for`. A tool that returns
 * `{error, candidates}` gets its nudge from that function; a tool that
 * THROWS renders as a bare `ERROR (execute): …` line, so its candidates —
 * which now survive the catch via `InvokeOutcome.candidates` — need the
 * same use-it-or-admit-it framing. Same voice on purpose: the model should
 * not be able to tell soft-fail from hard-throw when deciding what to do.
 */
function _recovery_nudge_for_thrown(candidates: readonly string[]): string | null {
  if (candidates.length === 0) return null;
  const shown = candidates.slice(0, 8);
  const more = candidates.length - shown.length;
  return (
    `\n\n[RECOVERY — internal system note] This call FAILED, but these are ` +
    `real values you can retry with:\n` +
    shown.map((c) => `  - ${c}`).join('\n') +
    (more > 0 ? `\n  …and ${more} more.` : '') +
    `\nYour next move is exactly one of: (a) retry the tool with one of ` +
    `those values, or (b) tell the user plainly what you couldn't retrieve. ` +
    `Do NOT answer from memory and do NOT invent the value this call was ` +
    `supposed to provide.`
  );
}

/**
 * When a tool result carries an error AND a populated recovery field
 * (candidates / suggestions / recovery_hint / …), append a one-line
 * use-it-or-admit-it instruction to the rendered result. The connector
 * affordance pattern puts the hint IN the result, but specialists were
 * reading `{state: null, error: '404', candidates: [...]}` and still
 * answering from memory — 49 ha_get_state and 27 web_fetch_clean
 * fab-after-read-failure misses in the first June 2026 fortnight, on
 * connectors that ALREADY shipped candidates. One mechanism at the
 * runtime layer, every connector covered, zero persona lines.
 */
function _recovery_nudge_for(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const obj = result as Record<string, unknown>;
  const errored = typeof obj.error === 'string' && obj.error.length > 0;
  if (!errored) return null;
  const populated = Object.entries(obj)
    .filter(
      ([k, v]) =>
        is_recovery_hint(k) &&
        v !== null &&
        v !== undefined &&
        v !== '' &&
        (!Array.isArray(v) || v.length > 0),
    )
    .map(([k]) => `\`${k}\``);
  if (populated.length === 0) return null;
  return (
    `\n\n[RECOVERY — internal system note] This read FAILED, but the result ` +
    `above includes ${populated.join(', ')}. Your next move is exactly one ` +
    `of: (a) retry the tool with one of those values, or (b) tell the user ` +
    `plainly what you couldn't retrieve. Do NOT answer from memory and do ` +
    `NOT invent the value this read was supposed to provide.`
  );
}

/**
 * Patterns that strongly suggest the reply is promising imminent or
 * future work — "I'll check…", "let me look…", "give me a moment",
 * "running the numbers", etc. Used by the ghost-promise guard to
 * detect the failure mode where a specialist verbally commits to
 * doing something but invokes zero tools and doesn't schedule a
 * follow-up, leaving the user waiting on a reply that will never
 * come. False positives are cheap (one extra round of generation);
 * false negatives waste the user's trust.
 */
/**
 * Detects "meta-intent" replies — content that states what the
 * specialist is *about to* do (or just did, in a procedural sense)
 * without actually delivering the substantive answer.
 *
 * Distinct from PROMISE_PATTERNS below: PROMISE_PATTERNS is verb-
 * specific ("I'll check", "let me look") and is used by the ghost-
 * promise guard for "specialist promised work that never landed."
 * META_INTENT_PATTERN is broader — anything that looks like a
 * declaration of intent or stalling phrase, used at the empty-
 * content fallback point to trigger ONE synthesis retry round.
 *
 * Diagnostic: brigid 2026-05-27T13:33:55Z "Let me read the capture
 * Cordelia routed to me." didn't match PROMISE_PATTERNS (`read` not
 * in the verb list) and the turn exited with that meta-statement
 * as final_text — the user nudged with "??" and the next turn
 * finally produced the substantive reply. META_INTENT_PATTERN
 * catches that shape so the recovery round fires before the
 * meta-only content ships.
 */
const META_INTENT_PATTERN =
  /^(?:let me\b|i['’]?ll\b|i am going to\b|i['’]?m going to\b|i['’]?m gonna\b|i will\b|let['’]?s\b|going to\b|gonna\b|about to\b|checking\b|searching\b|looking\b|reading\b|pulling\b|grabbing\b|fetching\b|getting\b|one (?:sec|moment|minute)\b|hold on\b|hang on\b|give me\b|sec\b|moment\b)/i;

const PROMISE_PATTERNS: RegExp[] = [
  /\bI'?ll\s+(check|look|fetch|find|get|grab|pull|dig|search|see|verify|confirm|run|ask|consult|email|message|text|send|update|review|reach\s+out|flag|alert|notify|tell|escalate|route|ping|loop\s+in|hand\s+off|raise)\b/i,
  /\bI\s+will\s+(check|look|fetch|find|get|grab|pull|dig|search|see|verify|confirm|run|ask|consult|email|message|text|send|update|review|reach\s+out|flag|alert|notify|tell|escalate|route|ping|loop\s+in|hand\s+off|raise)\b/i,
  /\bI'?m\s+going\s+to\s+(check|look|fetch|find|get|grab|pull|dig|search|see|verify|confirm|run|ask|consult|try|flag|alert|notify|tell|escalate|route|ping|loop\s+in|hand\s+off)\b/i,
  /\bI'?m\s+gonna\s+(check|look|fetch|find|get|grab|pull|dig|search|see|verify|confirm|run|ask|consult|try|flag|alert|notify|tell|escalate|route|ping|loop\s+in|hand\s+off)\b/i,
  /\blet\s+me\s+(check|look|see|fetch|find|get|grab|pull|dig|search|verify|confirm|run|ask|consult|try|peek|review|chase|flag|alert|notify|tell|escalate|loop\s+in)\b/i,
  /\bgive\s+me\s+a\s+(moment|sec(ond)?|minute|few|tick)\b/i,
  /\bone\s+(moment|sec(ond)?|minute)\b/i,
  /\bhold\s+on\b/i,
  /\bhang\s+on\b/i,
  /\brunning\s+the\s+numbers\b/i,
  /\bdigging\s+into\b/i,
  /\blooking\s+into\b/i,
  /\bchecking\s+on\b/i,
  /\bgetting?\s+back\s+to\s+you\b/i,
  /\bget\s+back\s+to\s+you\b/i,
  /\bcircle\s+back\b/i,
  /\bfollow\s+up\s+(on|with|in|shortly|later|soon|in\s+a)\b/i,
];

/**
 * Did this turn's tool_calls_made list contain a successful
 * promise_followup? If so, the specialist has properly scheduled a
 * continuation — their reply may legitimately use promise language
 * ("I'll be back in a couple minutes with the numbers") and the
 * guard should not retry.
 */
function _scheduled_followup(
  tool_calls_made: SpecialistTurnOutput['tool_calls_made'],
): boolean {
  return tool_calls_made.some((c) => c.name === 'promise_followup' && !c.error);
}

/**
 * Patterns where the reply CLAIMS a durable write/file/save/record
 * happened — "I've filed this to X.md", "I saved that to your notes",
 * "I've updated the record", "filing this now", "I've recorded it".
 * (2026-05-30) Ruby narrated "I am filing this to
 * `Knowledge/Pleasantville/.../xcel-ponds-fire.md`" FIVE times in one
 * conversation — none of those files exist; she has no write tool that
 * fired. Maggie did the same (process-misses pm_grpq560nb56c et al).
 * This is a fabrication-of-action distinct from the ghost-promise
 * (which is FUTURE work, "I'll check"); here the model asserts a
 * COMPLETED write that never touched the tool channel.
 */
const SAVE_CLAIM_PATTERNS: RegExp[] = [
  /\bI(?:'ve| have)?\s+(?:filed|saved|stored|recorded|logged|written|wrote|added|updated|noted|committed|captured)\b[^.]{0,80}\b(?:to|in|under|into)\b/i,
  /\b(?:filing|saving|storing|recording|logging|writing|adding|updating|noting)\b[^.]{0,40}\b(?:to|in|under|into)\b[^.]{0,60}(?:\.md|note|record|file|vault|library|watchlist|memory)\b/i,
  /\bI(?:'ve| have)?\s+(?:filed|saved|stored|recorded|logged|updated|noted)\s+(?:this|that|it|the\s+\w+)\b/i,
  /\b(?:added|saved|filed|recorded)\s+(?:this|that|it)\s+to\s+(?:your|the|my)\b/i,
];

/**
 * Tool names whose execution legitimately backs a "I saved/filed/
 * updated" claim. Any non-errored write-tier tool call that landed
 * this turn satisfies the claim — we don't need to match the specific
 * path, just confirm a real durable write happened. The registry's
 * own risk tier is the source of truth (write_internal / send_external
 * / spend_money all mutate state); `tools` is passed so we can resolve
 * each call's risk. consult_specialist is excluded — a consult isn't a
 * durable write the user can later read back.
 */
/**
 * Soft-failure signal in a tool's OUTPUT — the registry said ok (the call
 * didn't throw and passed output validation) but the tool's own payload
 * reports it didn't persist: `{ok:false}` / `{saved:false}` / `{persisted:false}`
 * / a populated `{error}`. This is the silent-write-failure class (the trust
 * killer): without this check a write that returned `{ok:false, error:"…"}`
 * reads as a durable write and the model's "saved!" passes. Deterministic —
 * derived from the ACTUAL outcome, not the model's optimism.
 */
function _result_indicates_failure(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false;
  const r = result as Record<string, unknown>;
  return (
    r.ok === false ||
    r.saved === false ||
    r.persisted === false ||
    (typeof r.error === 'string' && r.error.length > 0)
  );
}

function _had_durable_write(
  tool_calls_made: SpecialistTurnOutput['tool_calls_made'],
  tools: ToolRegistry,
): boolean {
  return tool_calls_made.some((c) => {
    if (c.error) return false;
    if (_result_indicates_failure(c.result)) return false; // wrote-but-not-persisted
    if (c.name === CONSULT_TOOL_NAME) return false;
    const t = tools.get(c.name);
    return t ? t.risk !== 'read' : false;
  });
}

/**
 * The first write-tier tool call this turn that FAILED — the registry errored
 * it, or its output reported a soft-failure (_result_indicates_failure). Drives
 * the accurate "your write FAILED — don't claim it saved" nudge, distinct from
 * the plain "no write tool fired at all" case. consult is never a durable write.
 */
function _failed_write_call(
  tool_calls_made: SpecialistTurnOutput['tool_calls_made'],
  tools: ToolRegistry,
): { name: string; reason: string } | null {
  for (const c of tool_calls_made) {
    if (c.name === CONSULT_TOOL_NAME) continue;
    const t = tools.get(c.name);
    if (!t || t.risk === 'read') continue;
    if (c.error) return { name: c.name, reason: `failed (${String(c.error).slice(0, 100)})` };
    if (_result_indicates_failure(c.result)) return { name: c.name, reason: 'reported it did not persist' };
  }
  return null;
}

/**
 * Detect a fabricated-save: the reply asserts a completed durable write
 * but no write-tier tool actually executed this turn. Returns a
 * one-retry nudge (same channel as the ghost-promise guard) telling the
 * model to either ACTUALLY call the write tool or rewrite the reply
 * without the false claim. `already_retried` shares the ghost-promise
 * latch at the call site so the turn can't oscillate. Null when the
 * reply makes no save-claim, or a real write did land.
 */
export function _detect_fabricated_save(
  final_text: string,
  tool_calls_made: SpecialistTurnOutput['tool_calls_made'],
  tools: ToolRegistry,
): string | null {
  const text = (final_text || '').trim();
  if (!text) return null;
  if (!SAVE_CLAIM_PATTERNS.some((re) => re.test(text))) return null;
  // A real durable write this turn makes the claim honest — let it pass.
  if (_had_durable_write(tool_calls_made, tools)) return null;
  // verify-before-claim: a write tool DID fire but errored or reported it
  // didn't persist (soft-failure). Give an accurate, actionable nudge naming
  // the tool — NOT the "nothing fired" message (which confuses a model that
  // did call the tool). This is the trust-guarantee case: the model cannot
  // confirm a save the runtime KNOWS failed.
  const failed = _failed_write_call(tool_calls_made, tools);
  if (failed) {
    return (
      `[UNSAVED-CLAIM GUARD — internal system note, not from the user]\n\n` +
      `Your reply confirms a save/update, but your \`${failed.name}\` call ` +
      `${failed.reason} — the data was NOT persisted. Confirming a save that ` +
      `didn't happen is a real, trust-breaking failure: the user will later look ` +
      `for a record that isn't there.\n\n` +
      `Re-roll. Exactly one of:\n` +
      `  (a) Retry \`${failed.name}\` CORRECTLY (fix the arguments and call it ` +
      `again). Only if it succeeds may your reply say it's saved.\n` +
      `  (b) If it can't be made to work, tell the user HONESTLY that you ` +
      `couldn't save it (and why). Do NOT confirm a save that failed.\n\n` +
      `This is your one retry.`
    );
  }
  return (
    `[FABRICATED-SAVE GUARD — internal system note, not from the user]\n\n` +
    `Your reply claims you filed / saved / recorded / updated something to ` +
    `a note, file, record, or the vault — but NO write tool executed this ` +
    `turn. That makes the claim false: nothing was actually saved, and the ` +
    `user will later look for a record that doesn't exist (this is a real, ` +
    `repeated trust-breaking failure). Narrating an action is not the same ` +
    `as taking it; only a tool call writes anything.\n\n` +
    `Re-roll this turn. Exactly one of:\n` +
    `  (a) If you DO have a write tool for this (e.g. a memory/note/library ` +
    `write your capabilities grant) and the save is worth doing, CALL IT ` +
    `now — then your reply may say it's saved.\n` +
    `  (b) If you have no such tool, or the save isn't needed, REWRITE your ` +
    `reply WITHOUT the save claim. Just give the answer; drop "I've filed ` +
    `this to …". Don't promise a save you can't perform.\n` +
    `  (c) If the knowledge should be curated durably for later, ` +
    `\`flag_cordelia\` (if granted) — and say "I've queued this to be filed ` +
    `to the library," which is true because the flag actually fired. Say it ` +
    `by FUNCTION like that; the tool's name is internal plumbing and the ` +
    `curator it routes to is not a colleague the user knows.\n\n` +
    `This is your one retry. Either make the write real or remove the claim.`
  );
}

/**
 * A write-tier tool call that DID NOT land — either it errored at the
 * registry/tool layer (`c.error`: a thrown execute, INPUT_VALIDATION_FAILED,
 * a capability denial, a DUPLICATE_TOOL_CALL of a prior failure, a blocked
 * persisted-fabrication write) OR it returned the SOFT-failure shape
 * (`result.error` truthy — a connector that reports failure in its OUTPUT
 * rather than throwing; this is the shape `_had_durable_write` is blind to,
 * which is how a failed write was read as a successful one). Reads are ignored;
 * a consult is not a durable write.
 */
function _write_call_failed(
  c: SpecialistTurnOutput['tool_calls_made'][number],
  tools: ToolRegistry,
): boolean {
  if (c.name === CONSULT_TOOL_NAME) return false;
  const t = tools.get(c.name);
  if (!t || t.risk === 'read') return false;
  if (c.error) return true;
  const r = c.result as Record<string, unknown> | undefined;
  return !!(r && typeof r === 'object' && typeof r.error === 'string' && r.error.length > 0);
}

/**
 * A write-tier tool call that genuinely LANDED — non-errored, and no soft
 * `{error}` in its result. This is the honest backing for a save-claim.
 * Stricter than `_had_durable_write` (which predates the soft-error shape and
 * treats a `{error}`-returning write as a success) — used by the save-honesty
 * guard so a soft-failed write can't masquerade as a real one.
 */
function _write_call_succeeded(
  c: SpecialistTurnOutput['tool_calls_made'][number],
  tools: ToolRegistry,
): boolean {
  if (c.error) return false;
  if (c.name === CONSULT_TOOL_NAME) return false;
  const t = tools.get(c.name);
  if (!t || t.risk === 'read') return false;
  const r = c.result as Record<string, unknown> | undefined;
  if (r && typeof r === 'object' && typeof r.error === 'string' && r.error.length > 0) return false;
  return true;
}

/**
 * Completion-claim shapes for the save-honesty guard. BROADER than the shared
 * SAVE_CLAIM_PATTERNS (which require a clean "…to/in <target>" and so MISS the
 * real incident wording: "I've noted Dr. Alba Moreno in your records" — the
 * period in "Dr." breaks the `[^.]` run and the proper noun isn't this/that/it).
 * The breadth is safe HERE because this guard only runs once a write has
 * already FAILED this turn — given that precondition, a first-person past-tense
 * save verb is almost certainly a false confirmation. Past-tense / completed
 * only (a future "I'll save it" is ghost-promise's job, not this).
 */
const SAVE_COMPLETION_PATTERNS: RegExp[] = [
  // First-person past-tense save/record verb, target OPTIONAL.
  /\bI(?:'ve| have| had)?\s+(?:just\s+|already\s+)?(?:filed|saved|stored|recorded|logged|noted|added|updated|captured|created)\b/i,
  // "(it|that|she|he|they)('s/'re) (now) saved/noted/recorded/filed/added/on file/in your …"
  /\b(?:it'?s|that'?s|she'?s|he'?s|they'?re)\s+(?:now\s+)?(?:saved|noted|recorded|filed|added|stored|logged|on\s+file|in\s+(?:your|the|my))\b/i,
  // "saved/added/noted (it|her|him|them|this|that) to your/the/my …"
  /\b(?:added|saved|noted|recorded|filed|logged)\s+(?:it|her|him|them|this|that)\s+to\s+(?:your|the|my)\b/i,
  // Terse confirmations.
  /\ball set\b/i,
  /^\s*(?:done|saved|noted|recorded|filed|added)[\s!.,—-]/i,
  // Bare ACKNOWLEDGEMENT of the thing the user asked to be saved. "Got it —
  // Dr. Alba Moreno, new dermatologist, on Ashgrove…" carries no save verb at all,
  // so every pattern above misses it; that is how a false confirm slipped the
  // live guard on 2026-08-02. Against a FAILED write it reads to the user as
  // confirmation either way — they asked for it to be recorded and the reply
  // comes back sounding like it was. Safe only in THIS list: the caller has
  // already established that a write was attempted and failed, and a reply
  // that owns the failure is released by FAILURE_ACK_PATTERNS.
  /^\s*(?:got it|gotcha|will do|okay|ok)\b[\s!.,—:-]/i,
];

/**
 * Save-honesty guard (2026-06-22). The complement of `_detect_fabricated_save`:
 * there NO write tool ran at all (pure narration); here the model DID reach for
 * a write tool, it FAILED (hard error / soft `{error}` / DUPLICATE / validation),
 * NO other durable write landed to back the claim, yet the reply asserts a
 * completed save — "Got it, I've noted it," the exact class Jasper kept hitting
 * (a person-write silently failing while Kate confirmed it). The user later
 * looks for a record that doesn't exist. One retry (shares the ghost latch +
 * re-roll budget at the call site): fix the call, or tell the user it failed.
 * Returns the nudge, or null when there's no save-claim, no failed write, a
 * real write backed it, or the reply already owns the failure honestly.
 *
 * Exported as a smoke seam (scripts/test-save-honesty.ts) — the guard's value
 * is deterministic detection precision, so the matrix is unit-tested directly.
 */
export function _detect_failed_save(
  final_text: string,
  tool_calls_made: SpecialistTurnOutput['tool_calls_made'],
  tools: ToolRegistry,
): string | null {
  const text = (final_text || '').trim();
  if (!text) return null;
  // Either the shared save-claim shapes OR the broader completion shapes that
  // only this guard's failed-write precondition makes safe to act on.
  if (
    !SAVE_CLAIM_PATTERNS.some((re) => re.test(text)) &&
    !SAVE_COMPLETION_PATTERNS.some((re) => re.test(text))
  ) {
    return null;
  }
  // No write was even attempted → that's the fabricated-save guard's job.
  if (!tool_calls_made.some((c) => _write_call_failed(c, tools))) return null;
  // A real durable write landed this turn — the claim is honest, let it pass
  // (a turn that failed one write but succeeded another isn't lying).
  if (tool_calls_made.some((c) => _write_call_succeeded(c, tools))) return null;
  // Already hedged honestly ("the save didn't go through") — don't nag a reply
  // that's owning the failure.
  if (FAILURE_ACK_PATTERNS.some((re) => re.test(text))) return null;

  const failed_names = [
    ...new Set(
      tool_calls_made.filter((c) => _write_call_failed(c, tools)).map((c) => c.name),
    ),
  ].slice(0, 4);
  return (
    `[SAVE-HONESTY GUARD — internal system note, not from the user]\n\n` +
    `Your reply says you saved / filed / recorded / noted / updated something — ` +
    `but the write tool you called this turn FAILED and nothing was persisted ` +
    `(${failed_names.map((n) => '`' + n + '`').join(', ')}). The save did NOT ` +
    `land: the user will later look for a record that isn't there (a real, ` +
    `repeated trust-breaking failure). A failed tool call writes nothing, no ` +
    `matter how the reply reads.\n\n` +
    `Re-roll this turn. Exactly one of:\n` +
    `  (a) CALL the write tool again CORRECTLY now — read the error it returned ` +
    `and fix the arguments (a missing/garbled field, the wrong identifier, a ` +
    `name that needs creating). Only when it SUCCEEDS may your reply say it's ` +
    `saved.\n` +
    `  (b) If you can't make it land this turn, TELL THE USER plainly that the ` +
    `save didn't go through and what you'll do next — don't claim success. An ` +
    `honest "I couldn't save that" beats a false "saved."\n\n` +
    `Never report a failed write as done. This is your one retry.`
  );
}

/**
 * Patterns where the reply CLAIMS a completed ACTION on a teammate or an
 * external recipient — "I've flagged this to Beatrice", "Message sent to
 * Kim", "I've delegated / escalated / routed / pinged it", or a peer is
 * now-acting-on-it ("Mariah will audit my tool usage", "Beatrice is
 * reviewing her playbook") — but no tool performed it this turn. Distinct
 * from _detect_fabricated_save (a durable WRITE) and _detect_ghost_promise
 * (a FUTURE "I'll …"): here the model asserts a COMPLETED peer/external
 * effect that never touched the tool channel. This is the 2026-06-16 Kate
 * spiral — she narrated "I've flagged Beatrice" / "Message sent to Kim"
 * across a dozen tool_calls_count:0 turns while nothing fired, and twice
 * claimed "sent" before draft_message ran at all. It is the structural
 * answer to "prose wins over calling tools, across every specialist."
 */
const ACTION_CLAIM_PATTERNS: RegExp[] = [
  // Past-tense "I('ve) <peer/external effect verb>".
  /\bI(?:'ve| have)?\s+(?:flagged|escalated|delegated|routed|dispatched|notified|alerted|pinged|messaged|emailed|texted|contacted|queued|forwarded|looped\s+(?:in|her|him|them)|handed\s+(?:this|it|that)\s+off|reached\s+out\s+to)\b/i,
  // "<artifact> sent / delivered / queued / dispatched" — "Message sent to Kim".
  /\b(?:message|note|draft|request|flag|alert|ping|hand-?off|inquiry)\s+(?:sent|delivered|queued|dispatched|fired|filed)\b/i,
];

/** Verbs that turn a bare name into an ATTRIBUTION — "<Name> is reviewing it". */
const ATTRIBUTION_VERBS =
  `(?:will|is\\s+(?:now\\s+)?(?:reviewing|fixing|auditing|handling|looking|working|on\\s+it|going\\s+to)` +
  `|has\\s+(?:been\\s+(?:flagged|notified|asked|looped\\s+in)|already\\s+\\w+ed)` +
  `|found|flagged|says|said|recommends|recommended|handled|reviewed|confirmed|reported|suggests)`;

/**
 * Consulting phrases that attribute to whatever name FOLLOWS them, so the
 * claim itself can land on a pronoun ("I checked with Astrid and SHE
 * recommends backing off"). Matching the preposition sidesteps pronoun
 * resolution entirely.
 *
 * Deliberately excludes a bare "asked" / "told": "I asked Anna about the baby
 * shower" is an ordinary sentence about a real contact, and these names are
 * ordinary human names. The phrases kept here are work-shaped — they read as
 * a hand-off to a colleague, which is the thing being guarded.
 */
const CONSULT_PREPOSITIONS =
  `(?:checked\\s+with|consulted(?:\\s+with)?|spoke\\s+(?:to|with)|heard\\s+back\\s+from` +
  `|according\\s+to|per|looped\\s+in|handed\\s+(?:this|it|that)\\s+to|ran\\s+(?:this|it|that)\\s+by)`;

/**
 * "<Name> is reviewing it" / "<Name>'s analysis" / "I checked with <Name>" — a
 * persona described as doing work. Built from a name list rather than
 * hardcoded (2026-08-03): the old inline alternation had rotted in both
 * directions at once — it still listed Iris, Cassandra, Anya and Marguerite,
 * whose configs are gone, and it had no entry for Vera, so a claim that the
 * code critic was reviewing something was never checked at all.
 */
function _attribution_pattern(names: readonly string[]): RegExp | null {
  if (names.length === 0) return null;
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(
    `\\b(?:${alt})(?:'s\\b|\\s+${ATTRIBUTION_VERBS}\\b)` + `|\\b${CONSULT_PREPOSITIONS}\\s+(?:${alt})\\b`,
    'i',
  );
}

/**
 * Tool names that legitimately back an action-claim even though their
 * registry risk is `read` — a consult IS "I asked X"; a present_questions
 * form IS "I asked you to pick". Any non-read effect tool (flag_* /
 * draft_message / delegate_proposal / raise_interrupt / …) is caught by
 * the risk-tier check below; these two must be enumerated.
 */
const ACTION_BACKING_READ_TOOLS = new Set([CONSULT_TOOL_NAME, 'present_questions']);

function _had_action_call(
  tool_calls_made: SpecialistTurnOutput['tool_calls_made'],
  tools: ToolRegistry,
): boolean {
  return tool_calls_made.some((c) => {
    if (c.error) return false; // an errored flag/consult/delegate didn't land
    if (c.name.startsWith('flag_')) return true;
    if (ACTION_BACKING_READ_TOOLS.has(c.name)) return true;
    if (c.name === 'promise_followup') return true; // genuinely scheduled
    const t = tools.get(c.name);
    return t ? t.risk !== 'read' : false; // any landed write/effect tool
  });
}

// Exported as a smoke seam (scripts/test-fabricated-action.ts) — the
// guard's value is regex precision, so the patterns are unit-tested.
export function _detect_fabricated_action(
  final_text: string,
  tool_calls_made: SpecialistTurnOutput['tool_calls_made'],
  tools: ToolRegistry,
  /** Live persona names (folded + visible + retired) for the attribution
   *  pattern. Omitted ⇒ only the two name-free patterns run. */
  persona_names: readonly string[] = [],
): string | null {
  const text = (final_text || '').trim();
  if (!text) return null;
  const attribution = _attribution_pattern(persona_names);
  const claimed =
    ACTION_CLAIM_PATTERNS.some((re) => re.test(text)) || (attribution?.test(text) ?? false);
  if (!claimed) return null;
  // A real peer/effect action this turn makes the claim honest.
  if (_had_action_call(tool_calls_made, tools)) return null;
  // Already hedged honestly ("I tried but couldn't get my tool calls to
  // land") — don't nag a reply that's owning the failure.
  if (FAILURE_ACK_PATTERNS.some((re) => re.test(text))) return null;
  return (
    `[FABRICATED-ACTION GUARD — internal system note, not from the user]\n\n` +
    `Your reply claims you flagged / sent / delegated / escalated / routed / ` +
    `messaged something to a teammate or recipient (or that a teammate is now ` +
    `acting on it) — but NO tool performed that action this turn. Narrating an ` +
    `action is not taking it: a flag, a consult, a delegation, a draft, an ` +
    `interrupt, or a scheduled follow-up only becomes real when its TOOL CALL ` +
    `lands. The user believes the work is in motion when nothing fired — a ` +
    `repeated, trust-breaking failure (the "Message sent to Kim" / "I've ` +
    `flagged Beatrice" spiral).\n\n` +
    `Re-roll this turn. Exactly one of:\n` +
    `  (a) CALL the tool now — \`flag_beatrice\` / \`consult_specialist\` / ` +
    `\`draft_message\` / \`delegate_proposal\` / \`raise_interrupt\` / ` +
    `\`promise_followup\` (whichever you actually hold and the claim refers ` +
    `to) — then your reply may say it's done.\n` +
    `  (b) If you can't or shouldn't, REWRITE the reply WITHOUT the action ` +
    `claim — say what you CAN do, or ask the user, but don't assert an action ` +
    `that didn't happen.\n\n` +
    `This is your one retry. Make the action real or drop the claim.`
  );
}

/**
 * Folded-name guard (2026-08-03) — the egress half of the fold.
 *
 * `render_peer_directory` stopped the PROMPT handing the model a folded
 * persona's name. This catches the model saying one anyway, from any of the
 * routes prose-scrubbing can't reach: a retrieved note, a vault folder path, a
 * historical audit row, an inbox label, or plain training-shaped confabulation.
 *
 * ── Why it is separate from the fabricated-action guard ─────────────────────
 * That guard asks "did a tool back this claim?" and stays silent when one did.
 * But a folded name is wrong EVEN WHEN THE ACTION IS REAL: Kate genuinely
 * calling `delegate to:'critic'` and then reporting "Vera's found a blocker"
 * is an honest action with a leaked name. To the owner there is no Vera — no
 * room to open, no person to follow up with — so the sentence is a dead end
 * dressed as a hand-off. Hence: no tool-call exemption here.
 *
 * ── Why it nudges instead of blocking ──────────────────────────────────────
 * These are ordinary human names. A household contact really can be called
 * Anna or Astrid, and a reply about a real person named Vivian is correct. A
 * hard block would corrupt those replies. So the guard costs one re-roll and
 * the nudge carries an explicit escape clause — if the name is a real person,
 * keep it and say which. A false positive is then self-correcting and cheap;
 * a false negative is a persona re-introduced to the owner as staff.
 *
 * Requires an ATTRIBUTION shape (possessive, or name + an acting verb), not a
 * bare mention, which is what keeps the false-positive rate low enough for a
 * nudge to be the right instrument.
 */
export function _detect_folded_name(
  final_text: string,
  /** From `unattributable_names(specialists.list())` — folded + retired. */
  unattributable: readonly string[],
): string | null {
  const text = (final_text || '').trim();
  if (!text) return null;
  const re = _attribution_pattern(unattributable);
  if (!re) return null;
  const hit = re.exec(text);
  if (!hit) return null;
  // Which name was matched. The hit may be name-led ("Vera's found…") or
  // preposition-led ("I checked with Astrid"), so pick whichever
  // unattributable name actually appears in the matched span.
  const named =
    unattributable.find((n) => new RegExp(`\\b${n}\\b`, 'i').test(hit[0])) ??
    /^[A-Za-z]+/.exec(hit[0])?.[0] ??
    hit[0];
  return (
    `[FOLDED-NAME GUARD — internal system note, not from the user]\n\n` +
    `Your reply attributes work to "${named}". That is not a colleague the ` +
    `user has: there is no room they can open, no person they can follow up ` +
    `with, and the name means nothing to them. It is either INTERNAL ` +
    `machinery of yours that used to be staff, or a persona that was retired ` +
    `outright. Either way the work is YOURS.\n\n` +
    `Re-roll this turn:\n` +
    `  (a) Rewrite the sentence in the FIRST PERSON. The finding is yours to ` +
    `report — "I found a blocker in that change", not "${named} found a ` +
    `blocker". If it helps to name the SOURCE, name it by FUNCTION ("the ` +
    `camera monitor picked up…", "the capture intake filed…", "the critique ` +
    `came back with…"), never by a persona name.\n` +
    `  (b) If you only know that name because you READ it — in a retrieved ` +
    `note, a shelf path, a folder name, an old audit row, an inbox label — ` +
    `that is a filing label, not a colleague. Use the content and drop the ` +
    `name.\n` +
    `  (c) EXCEPTION: if "${named}" is a real PERSON in this household's life ` +
    `— a friend, a contact, a family member you looked up this turn — then ` +
    `the name is correct. Keep it, and make the sentence make clear who they ` +
    `are, so it can't be read as a member of your staff.\n\n` +
    `This is your one retry.`
  );
}

/** Every `/api/media/generated/<file>` reference in a reply. The filename is
 *  a server-minted ULID, so membership — not a regex heuristic — decides
 *  whether the image is real. */
const GENERATED_IMAGE_REF = /\/api\/media\/generated\/([A-Za-z0-9._-]+)/g;

/**
 * Fabricated-image guard. A reply renders `![…](/api/media/generated/img-*.png)`
 * for a file no `generate_image` call minted this turn — the model wrote a
 * plausible ULID instead of calling the tool. Unlike the save/action guards
 * this needs no pattern matching: the tool returns the exact filename, so a
 * referenced-minus-minted set difference is exact.
 *
 * The route 404s an unknown filename, so the user sees a broken tile where a
 * picture was promised — worse than an honest "I couldn't make that,"
 * because the reply reads as though the image exists.
 *
 * Deliberate edge: re-embedding an image from an EARLIER turn also fires
 * (this turn minted nothing). That's rare — the tool's contract is
 * generate-then-post-once — and the nudge names the case, so the re-roll
 * gets correct guidance rather than a confusing nag.
 */
export function _detect_fabricated_image(
  final_text: string,
  tool_calls_made: SpecialistTurnOutput['tool_calls_made'],
): string | null {
  const text = (final_text || '').trim();
  if (!text) return null;
  const referenced = new Set<string>();
  for (const m of text.matchAll(GENERATED_IMAGE_REF)) referenced.add(m[1]!);
  if (referenced.size === 0) return null;

  const minted = new Set<string>();
  for (const c of tool_calls_made) {
    if (c.name !== 'generate_image' || c.error) continue;
    const url = (c.result as { image_url?: unknown } | undefined)?.image_url;
    if (typeof url !== 'string') continue;
    const file = url.split('/').pop();
    if (file) minted.add(file);
  }

  const ghosts = [...referenced].filter((f) => !minted.has(f));
  if (ghosts.length === 0) return null;
  return (
    `[FABRICATED-IMAGE GUARD — internal system note, not from the user]\n\n` +
    `Your reply embeds a generated-image link that no \`generate_image\` call ` +
    `produced this turn: ${ghosts.slice(0, 3).join(', ')}. Those filenames are ` +
    `minted by the tool — one cannot be written from memory or guessed. The ` +
    `link will 404 and the user will see a broken image where you promised a ` +
    `picture.\n\n` +
    `Re-roll this turn. Exactly one of:\n` +
    `  (a) CALL \`generate_image\` now and paste the \`markdown\` line it ` +
    `returns, verbatim.\n` +
    `  (b) If you meant an image from an EARLIER turn, describe it in words — ` +
    `do not re-embed the link.\n` +
    `  (c) If you can't make the image, say so plainly and drop the link.\n\n` +
    `This is your one retry. Never write an image link the tool didn't return.`
  );
}

/**
 * Unplaced-image guard — the exact inverse of `_detect_fabricated_image`.
 * `generate_image` LANDED (the PNG is on disk and served) but the reply
 * never carries the `markdown` line, so nothing renders and the user sees
 * only prose. The failure mode is specific and recurring: the model
 * NARRATES the image instead of embedding it — "The image renders in the
 * chat", "here's what I made" — and then, because its own history says the
 * picture is there, it argues with the user about a blank space.
 *
 * The tool hands back the exact line and tells the model to paste it
 * verbatim; this catches the turn where it didn't.
 *
 * Placement counts anywhere the filename reaches the user: the reply body
 * OR a `message_user` (or any other) tool call this turn — the tool's own
 * contract offers both, so a proactive send is a legitimate placement and
 * must not fire.
 */
export function _detect_unplaced_image(
  final_text: string,
  tool_calls_made: SpecialistTurnOutput['tool_calls_made'],
): string | null {
  const minted: string[] = [];
  for (const c of tool_calls_made) {
    if (c.name !== 'generate_image' || c.error) continue;
    const url = (c.result as { image_url?: unknown } | undefined)?.image_url;
    if (typeof url !== 'string') continue;
    const file = url.split('/').pop();
    if (file) minted.push(file);
  }
  if (minted.length === 0) return null;

  // Everywhere a filename could legitimately have been placed this turn.
  let placed = final_text || '';
  for (const c of tool_calls_made) {
    if (c.name === 'generate_image') continue; // its own result isn't a placement
    try {
      placed += `\n${JSON.stringify(c.input ?? '')}`;
    } catch {
      // un-serializable input can't contain the link; skip it
    }
  }

  const unplaced = minted.filter((f) => !placed.includes(f));
  if (unplaced.length === 0) return null;
  return (
    `[UNPLACED-IMAGE GUARD — internal system note, not from the user]\n\n` +
    `You called \`generate_image\` and it SUCCEEDED — the picture exists and ` +
    `is ready to show. But your reply does not contain the \`markdown\` line ` +
    `the tool returned, so the user sees NO IMAGE: only your text. Describing ` +
    `the picture, or saying it "renders in the chat", does not display it — ` +
    `the markdown line is the only thing that does.\n\n` +
    `Re-roll this turn: write your reply again and include the returned line ` +
    `verbatim, on its own paragraph, exactly once:\n` +
    unplaced.map((f) => `    ![…](/api/media/generated/${f})`).join('\n') +
    `\n\nKeep the rest of your reply in your own voice — just make sure that ` +
    `line is in it. This is your one retry.`
  );
}

/** Fenced blocks and inline code — a tool name discussed INSIDE code is
 *  being talked about, not claimed as invoked. Stripped before scanning. */
function _strip_code(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/** `tool_name(` followed by argument-shaped content — an `=` or a quote
 *  before the closing paren. Prose like "use generate_image (the house
 *  model)" has neither, so it does not match. */
const TOOL_CALL_LITERAL = /\b([a-z][a-z0-9_]{2,})\s*\(\s*(?=[^)]*["'=])/g;

/**
 * Narration of tool EXECUTION with no tool channel behind it — "the tool
 * call fires", "the image loads", "calling the tool now". Only consulted
 * when the turn made ZERO tool calls, which is what makes these safe: the
 * same sentence after a real call is legitimate flavor text.
 */
const TOOL_EXECUTION_NARRATION: RegExp[] = [
  /\bthe\s+(?:tool|function)(?:\s+call)?\s+(?:fires?|fired|executes?|executed|runs?|ran|lands?|landed|goes?\s+through|went\s+through)\b/i,
  /\b(?:calling|invoking|running|firing|executing)\s+(?:the\s+)?(?:tool|function)\b/i,
  /\bthe\s+(?:image|picture|photo)\s+(?:loads?|loaded|renders?|rendered|appears?|appeared|generates?|generated)\b/i,
  /\bI(?:'m| am)\s+(?:now\s+)?(?:calling|invoking|running|firing)\s+\w+\(/i,
];

/**
 * Narrated-tool-call guard. The reply TYPES a tool invocation instead of
 * emitting one — `generate_image(prompt="…")` as message text — or asserts
 * the tool fired, while `tool_calls_json` is empty. The user reads a
 * transcript of work that never happened, and the model's own history then
 * carries the false premise into later turns.
 *
 * Observed 2026-07-28 23:42 with Mariah, twice in twelve seconds: the
 * literal call printed into prose, then "The tool call fires." Zero calls
 * either turn; the last real generate_image was fifteen minutes earlier.
 *
 * Distinct from the image guards, which both need a real signal to anchor
 * on — `_detect_fabricated_image` needs a /api/media/generated/ link,
 * `_detect_unplaced_image` needs a landed call. This one has neither, which
 * is exactly why it slipped both.
 *
 * Precision comes from the registry: only a name the runtime actually
 * serves counts, and only in call syntax with argument-shaped content,
 * outside code fences.
 */
export function _detect_narrated_tool_call(
  final_text: string,
  tool_calls_made: SpecialistTurnOutput['tool_calls_made'],
  tools: ToolRegistry,
): string | null {
  const text = (final_text || '').trim();
  if (!text) return null;
  const prose = _strip_code(text);
  const called = new Set(tool_calls_made.map((c) => c.name));

  // (1) A real tool name written as a call literal, never actually called.
  const narrated = new Set<string>();
  for (const m of prose.matchAll(TOOL_CALL_LITERAL)) {
    const name = m[1]!;
    if (called.has(name)) continue;
    try {
      if (tools.get(name)) narrated.add(name);
    } catch {
      // registry miss is not a finding
    }
  }
  if (narrated.size > 0) {
    const names = [...narrated].slice(0, 3).map((n) => `\`${n}\``).join(', ');
    return (
      `[NARRATED-TOOL-CALL GUARD — internal system note, not from the user]\n\n` +
      `Your reply WRITES OUT a tool call as text — ${names} — but no such ` +
      `call was made. Typing a call into your message does not run it: the ` +
      `user sees a transcript of work that never happened, and nothing was ` +
      `produced. Tool calls travel on their own channel, not in your prose.\n\n` +
      `Re-roll this turn. Exactly one of:\n` +
      `  (a) ACTUALLY CALL the tool — emit it as a real tool call, then write ` +
      `your reply around the result it returns.\n` +
      `  (b) If you can't or shouldn't call it, say so plainly and REMOVE the ` +
      `written-out call from your reply.\n\n` +
      `Never print a tool invocation as message text. This is your one retry.`
    );
  }

  // (2) Asserting a tool ran on a turn that made no calls at all.
  if (tool_calls_made.length > 0) return null;
  if (!TOOL_EXECUTION_NARRATION.some((re) => re.test(prose))) return null;
  return (
    `[NARRATED-TOOL-CALL GUARD — internal system note, not from the user]\n\n` +
    `Your reply says a tool ran (or that an image loaded/rendered) but you ` +
    `made NO tool calls this turn — nothing fired and nothing was produced. ` +
    `Describing execution is not executing.\n\n` +
    `Re-roll this turn. Exactly one of:\n` +
    `  (a) CALL the tool for real, then write your reply around what it ` +
    `returns — and if it returns something to display, include that verbatim.\n` +
    `  (b) If you can't, say so plainly and drop the claim that it ran.\n\n` +
    `This is your one retry.`
  );
}

/**
 * Acknowledgment language — if the reply ALREADY honestly surfaces a read/
 * tool failure ("I couldn't reach X", "it returned nothing", "rate-limited"),
 * the honesty guard should not fire. Keeps the guard off replies that are
 * already doing the right thing. Deliberately broad on the honest side: a
 * false *skip* just means we trust an already-hedged reply.
 */
const FAILURE_ACK_PATTERNS: RegExp[] = [
  /\b(?:could\s?n[o']?t|can[’']?t|cannot|was\s?n[o']?t\s+able|were\s?n[o']?t\s+able|unable|failed)\s+(?:to\s+)?(?:reach|fetch|pull|find|access|confirm|verify|retrieve|load|connect|get|locate|look\s+up)\b/i,
  /\b(?:no|couldn[’']?t\s+find\s+any)\s+(?:data|results?|record|info(?:rmation)?|response|details?|matches?)\b/i,
  /\b(?:not|isn[’']?t|was\s?n[o']?t)\s+(?:available|reachable|responding|accessible)\b/i,
  /\b(?:I|we)\s+do\s?n[’']?t\s+have\b/i,
  /\b(?:rate[- ]?limited|timed\s+out|a\s+timeout|returned\s+(?:nothing|no\s+\w+|an?\s+error|empty))\b/i,
  /\b(?:ran\s+into|hit)\s+(?:an?\s+)?(?:error|issue|problem)\b/i,
  /\bI\s+(?:can[’']?t|cannot)\s+confirm\b/i,
  // Save-specific admissions. The list above is shaped around READ failures
  // ("couldn't reach", "no data"), so a reply owning a failed WRITE in plain
  // language — "the person note didn't stick", "that didn't go through" —
  // matched nothing and got nudged for being honest (observed 2026-08-02).
  // This also keeps the new "Got it —" completion pattern safe: "Got it, that
  // didn't stick" is released here rather than treated as a false confirm.
  /\b(?:did\s?n[o']?t|has\s?n[o']?t|would\s?n[o']?t)\s+(?:go\s+through|stick|save|persist|land|take|write)\b/i,
  /\b(?:was\s?n[o']?t|is\s?n[o']?t)\s+(?:saved|recorded|written|persisted|stored)\b/i,
];

/**
 * Read-failure honesty guard (1b). The demand-side complement to the 1a
 * connector recovery hints: a turn that hit an unrecovered read/tool
 * failure and then answered *over* it — as if the data were in hand — is
 * the "consult-then-parrot" failure Mariah keeps flagging (Anya over a
 * dead read_friday_pets, Kate over failed writes, Linda/Ruby over null
 * web_fetch_clean). The requester can't tell the reply isn't backed by
 * live data, so a plausible guess reads as fact.
 *
 * Fires when ALL hold: (1) ≥1 tool call failed this turn — the registry
 * errored it, OR it returned the soft-failure shape (a result carrying a
 * truthy `error`, e.g. web_fetch_clean's empty-body+error+candidates);
 * (2) that failure is UNRECOVERED — no later call of the SAME tool
 * succeeded (a retried candidate URL that landed counts as recovery);
 * (3) the reply does NOT already surface the failure honestly. One retry
 * (own latch), nudging the model to retry against the returned candidates
 * or say plainly what it couldn't get. Returns the nudge, or null if clean.
 */
function _detect_unrecovered_read_failure(
  final_text: string,
  tool_calls_made: SpecialistTurnOutput['tool_calls_made'],
): string | null {
  const text = (final_text || '').trim();
  if (!text) return null;

  const soft_error = (c: { result?: unknown; error?: string }): string | null => {
    if (c.error) return c.error;
    const r = c.result as Record<string, unknown> | undefined;
    if (r && typeof r === 'object' && typeof r.error === 'string' && r.error.length > 0) {
      return r.error;
    }
    return null;
  };
  const failures = tool_calls_made.filter((c) => soft_error(c) !== null);
  if (failures.length === 0) return null;

  // A failure is "recovered" if a LATER call of the same tool succeeded
  // (web_fetch_clean failed → retried a candidate URL → ok ⇒ recovered).
  const recovered_names = new Set(
    tool_calls_made.filter((c) => soft_error(c) === null).map((c) => c.name),
  );
  const unrecovered = failures.filter((f) => !recovered_names.has(f.name));
  if (unrecovered.length === 0) return null;

  // Already hedged honestly? Don't nag a reply that's doing the right thing.
  if (FAILURE_ACK_PATTERNS.some((re) => re.test(text))) return null;

  const lines = unrecovered.slice(0, 6).map((f) => {
    const why = (soft_error(f) ?? 'no usable result').slice(0, 120);
    const r = f.result as Record<string, unknown> | undefined;
    const cands = r && Array.isArray(r.candidates) ? (r.candidates as unknown[]) : [];
    let line = `  - \`${f.name}\` failed (${why})`;
    if (cands.length > 0) {
      const shown = cands
        .slice(0, 3)
        .map((c) => {
          const o = (c ?? {}) as Record<string, unknown>;
          return String(o.url ?? o.entity_id ?? o.note_path ?? o.id ?? JSON.stringify(o));
        })
        .join(', ');
      line += ` — it handed you candidates to retry: ${shown}`;
    }
    return line;
  });

  return (
    `[READ-FAILURE GUARD — internal system note, not from the user]\n\n` +
    `One or more reads FAILED this turn and never recovered, yet your reply ` +
    `answers as if the data is in hand. Answering over an unrecovered read ` +
    `is how a confident-but-fabricated reply happens — whoever asked can't ` +
    `tell your answer isn't backed by live data.\n\n` +
    `Failed and unrecovered this turn:\n${lines.join('\n')}\n\n` +
    `Re-roll. For each failure, exactly one of:\n` +
    `  (a) RECOVER it: if the tool returned candidates (or you can try a ` +
    `different argument or source), CALL IT AGAIN now against one of them ` +
    `and answer from the real result.\n` +
    `  (b) SURFACE it: if you can't recover it this turn, say so plainly — ` +
    `"I couldn't reach X / it came back empty" — and give only what you can ` +
    `actually back. An honest "I couldn't confirm that" beats a confident ` +
    `guess.\n\n` +
    `Do not restate the unbacked claim as fact. This is your one retry.`
  );
}

/**
 * Detect ghost-promise replies: specialist's final text contains
 * promise language but the work isn't on the rails — either zero tool
 * calls happened, or tools did run but the final text still promises
 * MORE work that never got executed (the "I called ha_list_entities,
 * now let me search for the specific Bed 2 sensor" → silence pattern).
 * Also catches commitments made only in the thinking trace — a
 * `<think>I'll consult Mariah</think>` that produces a user reply
 * with no `consult_specialist` call is the same failure shape: the
 * model deliberated about the consult, asserted it, then dropped it
 * before the tool channel. Returns the nudge to inject as a user
 * message for the retry round, or null if the reply is clean.
 *
 * A successful `promise_followup` is the only legitimate way to make
 * a promise-shaped reply — the work is genuinely scheduled and a
 * later turn will deliver. Without one, promise language without
 * follow-through is a bug.
 *
 * Only retries once per turn (`already_retried` guard) so the loop
 * can't oscillate between two ghost replies.
 */
function _detect_ghost_promise(
  final_text: string,
  tool_calls_made: SpecialistTurnOutput['tool_calls_made'],
  already_retried: boolean,
  thinking_trace = '',
  // Live roster (2026-08-03). The retry prose used to hardcode a peer list —
  // and it rotted: it still named Iris, Cassandra, Anya and Marguerite, whose
  // configs no longer exist, and Beatrice/Cordelia, who are folded. A retry
  // is the exact moment the model is most suggestible about who to hand work
  // to, so a stale name here becomes a `consult_specialist` at an id that
  // isn't there, or a user-facing "I've routed it to <someone who is gone>".
  // Derived from the registry instead; omitted (tests, older call sites) ⇒
  // the name-specific hints simply don't render.
  roster: readonly { id: string; name?: string; role?: string; subagent_only?: boolean }[] = [],
): string | null {
  if (already_retried) return null;
  if (_scheduled_followup(tool_calls_made)) return null;
  const text = (final_text || '').trim();

  // Thinking-only commitments: the model named a peer in a commit
  // clause inside `<think>` but never actually called consult_specialist
  // for them. Fire the guard even when the visible reply is otherwise
  // clean — the user gets an answer that silently dropped the
  // deliberated consults, and the answer's confidence is unearned.
  // Uses the static peer map (registry-aware lookups happen in the
  // retrospective scan, where late-hired specialists matter); the live
  // guard runs on the next turn anyway so a brand-new peer's name
  // misses one cycle at most.
  const thinking_orphans = unfulfilled_thinking_consults(
    thinking_trace,
    tool_calls_made,
    build_peer_name_to_id(),
  );
  if (thinking_orphans.length > 0) {
    const peers_list = thinking_orphans
      .map((id) => `\`consult_specialist({ specialist_id: "${id}", question: "..." })\``)
      .join(', ');
    return (
      `[THINKING-COMMITMENT GUARD — internal system note, not from the user]\n\n` +
      `Your private thinking this turn committed to consulting ` +
      `${thinking_orphans.length === 1 ? 'a teammate' : 'teammates'} ` +
      `(${thinking_orphans.join(', ')}) but no matching ` +
      `consult_specialist call landed in the tool channel. The user ` +
      `received your reply with the consult's value asserted as if it ` +
      `had happened. Re-roll this turn and either:\n` +
      `  (a) Make the consult(s) you committed to: ${peers_list}, then ` +
      `      paraphrase the result in your reply.\n` +
      `  (b) If on reflection the consult isn't needed, rewrite the ` +
      `      reply without the unverified claim it was meant to back.\n\n` +
      `Thinking is private deliberation; the tool channel is where ` +
      `commitments become real. If your thinking decides "I'll ask X," ` +
      `the same turn must emit consult_specialist for X. This is your ` +
      `one retry.`
    );
  }

  if (!text) return null;
  const matched = PROMISE_PATTERNS.some((re) => re.test(text));
  if (!matched) return null;
  const had_tools = tool_calls_made.length > 0;
  const tool_summary = had_tools
    ? tool_calls_made
        .map((c) => `${c.name}${c.error ? ' (errored)' : ''}`)
        .join(', ')
    : '';

  // Detect "I'll [verb] <PeerName>" — when the LLM named a teammate in the
  // promise, the retry hands it that teammate's exact consult_specialist call
  // shape rather than a vague "delegate to someone."
  //
  // VISIBLE peers only. A folded specialist's name appearing in a reply is a
  // separate bug (it has no room the owner can open, so "I'll ask <name>" is
  // meaningless to him); handing the model a call shape for it would teach
  // the leak rather than close it. The routing directory in the system prompt
  // carries folded ids for genuine routing.
  const named_peer = roster
    .filter((s) => !s.subagent_only && s.name)
    .find((s) => new RegExp(`\\b${s.name!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
  // Detect a "broken integration" hint in the tool results that the LLM
  // saw before writing the punt. If a connector tool returned a "not
  // configured" style error, this almost always means the right action
  // is consult_specialist(trainer) with the verbatim error quoted.
  const config_error_tool = tool_calls_made.find((c) => {
    const blob = JSON.stringify((c as { result?: unknown }).result ?? c.error ?? '').toLowerCase();
    return /\b(not configured|set .{0,40}_token|missing token|missing credentials|unconfigured|integration is not|no credentials|set .{0,40}_url)\b/.test(blob);
  });
  const opener = had_tools
    ? `Your previous reply contained promise language ("let me search", ` +
      `"I'll check", "I'll flag X", "give me a moment", or similar) AFTER ` +
      `you already ran tools this turn (${tool_summary}). You started the ` +
      `work, got partial data back, then verbally committed to MORE work ` +
      `but emitted no further tool call — so the turn ended on a promise. ` +
      `The user reads your reply, waits, and the follow-through never comes.`
    : `Your previous reply contained promise language ("I'll", "let me", ` +
      `"give me a moment", "running the numbers", or similar) but you made ` +
      `zero tool calls this turn. That means the work isn't done and isn't ` +
      `scheduled — the user reads your reply, waits, and nothing comes back.`;

  // Specialized addendum: if the LLM named a peer in their punt OR a
  // prior tool result was a "not configured / missing token" config
  // error, the right action is a same-turn consult_specialist call,
  // and we can hand the LLM the exact shape.
  let escalation_hint = '';
  if (config_error_tool) {
    const err_blob = JSON.stringify(
      (config_error_tool as { result?: unknown }).result ??
        config_error_tool.error ??
        '',
    ).slice(0, 240);
    escalation_hint +=
      `\n\nBROKEN INTEGRATION DETECTED. Your tool \`${config_error_tool.name}\` returned ` +
      `a configuration error (${err_blob}). That is a HARD GAP — resolve it ` +
      `THIS round on whichever path your system prompt gives you: if you hold ` +
      `the build/config tools, open the fix yourself; otherwise route it with ` +
      `a same-turn ` +
      `\`consult_specialist({ specialist_id: "trainer", question: "..." })\`, ` +
      `quoting the verbatim error. Either way tell the user what YOU did ` +
      `("I hit a config error and opened the fix" / "…and put it on the build ` +
      `queue") — describe the path by function, never by a persona name. ` +
      `"I'll flag it later" is not acceptable; it's one call away.`;
  }
  if (named_peer) {
    const display = named_peer.name!;
    escalation_hint +=
      `\n\nYou named ${display} in your reply as someone you'd contact. ` +
      `That counts as a binding promise. To honor it THIS round, call ` +
      `\`consult_specialist({ specialist_id: "${named_peer.id}", question: "..." })\` ` +
      `with a tight, specific question. The consult result comes back in this ` +
      `same turn so you can paraphrase the answer in your reply. "I'll loop ` +
      `${display} in later" is not acceptable — they're one tool call away.`;
  }

  return (
    `[GHOST-PROMISE GUARD — internal system note, not from the user]\n\n` +
    opener +
    escalation_hint +
    `\n\n` +
    `You MUST take action this round. Exactly one of the following:\n` +
    `  (a) DO THE WORK NOW. Call the tool(s) that would answer the ask — ` +
    `web_search / nearby / route for facts, plan_ev_day for EV routing, ` +
    `sensor_calendar_upcoming for the calendar, ha_get_state for HA state, ` +
    `search_library for vault facts, etc. Then write your reply from the results.` +
    (had_tools
      ? ` If a prior tool result was truncated or too broad, call a more ` +
        `targeted variant (e.g. ha_get_state on the specific entity_id, ` +
        `ha_list_entities with a name_contains filter, web_fetch_clean ` +
        `on the most promising URL from a search result).`
      : '') +
    `\n` +
    `  (b) DELEGATE NOW. If the domain belongs to a teammate, call ` +
    `consult_specialist with their id and a tight scoped question. Their ` +
    `answer comes back inside this same turn — quote / paraphrase it in ` +
    `your reply. Broken integrations / "not configured" tool errors route ` +
    `to id \`trainer\` — quote the verbatim error in your question.\n` +
    `  (c) SCHEDULE A FOLLOW-UP. Call promise_followup with a one-line ` +
    `summary and the scope to remember. due_in_minutes MUST be a number ` +
    `(2, not "2"). At fire time you get a fresh turn — that turn can ` +
    `consult teammates, do tool calls, whatever the work needs. After ` +
    `the call, your reply can legitimately say "I'll be back in a ` +
    `couple minutes with X."\n\n` +
    `IMPORTANT: "I don't know" / "I don't have a way to check that" is ` +
    `NOT an acceptable reply unless you have first considered (b) and ` +
    `(c) and BOTH genuinely fail — i.e., no teammate's persona covers ` +
    `this domain AND there is no tool path that would resolve it on a ` +
    `later turn. Promised work to the user is binding even when it has ` +
    `to flow through your staff. The routing directory in your system ` +
    `prompt is the CURRENT list of who exists and what each one owns — ` +
    `read it there, never from memory, and call the right id via ` +
    `consult_specialist or schedule a follow-up whose scope names it. ` +
    `Do not decline what a teammate could handle.\n\n` +
    `This is your one retry. Re-roll now with a tool call attached.`
  );
}

/**
 * Build the smart canned message for a turn that exhausted
 * MAX_TOOL_ROUNDS without landing on a final answer. Summarizes
 * what she actually did so the user gets a useful signal, not the
 * generic "couldn't land" line that hides what happened.
 */
function _exhaustion_message(
  tool_calls_made: SpecialistTurnOutput['tool_calls_made'],
  specialist_name: string,
): string {
  // Group by tool name for the count.
  const by_tool = new Map<string, number>();
  const dup_count = tool_calls_made.filter(
    (c) =>
      (c.error && /DUPLICATE_TOOL_CALL/.test(String(c.error))) ||
      _is_duplicate_call_result(c.result),
  ).length;
  for (const c of tool_calls_made) {
    by_tool.set(c.name, (by_tool.get(c.name) ?? 0) + 1);
  }
  const top = [...by_tool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const summary = top
    .map(([name, n]) => `${name}×${n}`)
    .join(', ');

  if (dup_count >= 3) {
    return (
      `I caught myself retrying the same tool call repeatedly without ` +
      `getting anywhere (${dup_count} duplicate attempts among ${tool_calls_made.length} total). ` +
      `That usually means the input is wrong — a 404 URL, a misspelled ` +
      `path, a query that returns nothing — and the right move is to ` +
      `tell you so you can correct it. Can you double-check the URL or ` +
      `give me a different angle?`
    );
  }
  return (
    `I worked through ${tool_calls_made.length} steps (${summary}) without ` +
    `landing on something I'd want to send you. Can you rephrase or narrow ` +
    `the question? If you point me at a specific page or person, I can ` +
    `focus rather than search.`
  );
}

/**
 * Per-round research-budget nudge (2026-05-30). Injected into the
 * message stream at the end of a tool round once the turn is past the
 * broad-exploration phase, so the model gets a felt sense of remaining
 * runway and converges to an answer BEFORE the ceiling instead of
 * burning it and hitting the canned exhaustion punt. The early rounds
 * are deliberately NOT nudged — fan out, find the specifics — then this
 * boomerangs the model back toward synthesis as the budget tightens.
 */
function _budget_signal(rounds_used: number, ceiling: number): string {
  const left = ceiling - rounds_used;
  if (left <= 2) {
    return (
      `[RESEARCH BUDGET — internal system note, not from the user]\n` +
      `You have ${left} tool round${left === 1 ? '' : 's'} left of ${ceiling}, so ` +
      `don't open a broad new line of search. Take an honest read of where you ` +
      `actually are:\n` +
      `- If you have enough to be genuinely useful, answer now — findings first, ` +
      `then a clear recommendation, then anything you couldn't confirm.\n` +
      `- If you've only skimmed the surface and this needs real digging, do NOT ` +
      `force a shallow answer. Say so plainly: tell the user what you've covered ` +
      `so far and what's still open, and (if you have promise_followup) schedule ` +
      `a follow-up so you get a fresh turn with a full budget to keep researching.\n` +
      `Either way, never present a partial look as the whole picture. If one ` +
      `tightly-scoped call would close the single biggest gap, make THAT one ` +
      `call first, then answer.`
    );
  }
  return (
    `[RESEARCH BUDGET — internal system note, not from the user]\n` +
    `You've used ${rounds_used} of ${ceiling} tool rounds (${left} left). Start ` +
    `converging: if you already have enough, move to your answer; otherwise spend ` +
    `what's left on the highest-value gaps and batch independent lookups into a ` +
    `single round. If the question genuinely needs more depth than the budget ` +
    `allows, it's better to say so and schedule a follow-up than to pad out a ` +
    `thin answer.`
  );
}

/**
 * The synthesis instruction used when a turn hits the tool-round
 * ceiling (see _synthesize_on_exhaustion). Tools are disabled for this
 * final pass; the model must answer from what it already gathered.
 */
const _EXHAUSTION_SYNTH_PROMPT =
  `[RESEARCH BUDGET EXHAUSTED — internal system note, not from the user]\n\n` +
  `You've used your full tool-round budget for this turn. Do NOT call any more ` +
  `tools. Be honest about how far you actually got:\n` +
  `- If what you gathered is genuinely enough to be useful, answer now — lead ` +
  `with your findings and recommendation, then state plainly what you could NOT ` +
  `confirm.\n` +
  `- If you only skimmed the surface, SAY THAT directly: tell the user what you ` +
  `did and didn't get to and what you'd dig into next. Do not dress up a partial ` +
  `look as the whole picture.\n` +
  `A short, honest "here's what I have so far and here's what's still open" beats ` +
  `both a fabricated-complete answer and asking the user to rephrase. Use your ` +
  `normal voice; don't mention rounds or budgets.`;

/**
 * File a `runtime-affordance-gap` process_miss when a specialist's
 * turn hits the tool-round ceiling without landing a final answer
 * (2026-05-30). Closes the closed loop: ceiling exhaustion stops
 * being a one-off `blank_turn_fallback` audit row and becomes a
 * miss Beatrice's `analyze_systemic_pattern` can cluster across
 * specialists.
 *
 * The gap text is deliberately uniform across specialists so
 * recurrence accumulates as a single class. Beatrice's job, when
 * she sees N+ of these clustered, is to ship the structural fix —
 * probably a `proactive.research_workload: true` archetype that
 * the runtime auto-injects research-efficiency guidance at
 * turn-start instead of per-persona carve-outs.
 *
 * Optional store — runtime is forward-compatible with boots that
 * don't wire it (smokes, isolated tests). The miss is filed at
 * severity 'medium' — high enough to surface in Mariah's open
 * queue, not so high that it spams interrupts.
 */
function _file_runtime_affordance_miss(
  store: import('./process_misses').ProcessMissStore | undefined,
  args: {
    specialist_id: string;
    conversation_id: string;
    rounds_used: number;
    tool_round_ceiling: number;
    tool_calls_count: number;
    user_question_preview: string;
    tool_call_shape: string[];
  },
): void {
  if (!store) return;
  try {
    store.create({
      subject_specialist_id: args.specialist_id,
      reporter: 'orchestrator',
      task_summary:
        `User question: "${args.user_question_preview}". Specialist had ` +
        `${args.tool_round_ceiling} rounds; needed more.`,
      gap:
        `runtime-affordance-gap: tool-round-ceiling exhaustion. ` +
        `${args.specialist_id} used all ${args.rounds_used}/${args.tool_round_ceiling} ` +
        `rounds (${args.tool_calls_count} total tool calls) without landing a ` +
        `final answer (conversation ${args.conversation_id}). ` +
        `Tool-call shape: ${args.tool_call_shape.join(' → ').slice(0, 200)}. ` +
        `When this class recurs across specialists, the right fix is a ` +
        `runtime-side research-efficiency injection (parallel fan-out hint, ` +
        `don't re-fetch in turn context, plan-before-call, scope cap on broad ` +
        `questions, surface what couldn't confirm on exhaust), not ` +
        `per-persona carve-outs. Beatrice: scan for ` +
        `"runtime-affordance-gap" recurrence — propose the structural fix once you have N≥3.`,
      severity: 'medium',
      // ONE ledger row per (specialist, local week): every exhaustion in
      // the week lands as a recurrence note on the same row via the
      // store's evidence_ref chokepoint dedup, instead of one row per
      // occurrence (35 rows against trainer alone in the first June 2026
      // fortnight — the per-conversation ref made each one "distinct").
      // The conversation id stays in the gap text for traceability.
      evidence_ref: `round-ceiling:${args.specialist_id}:${local_iso_week()}`,
    });
  } catch (err) {
    console.error('[runtime] failed to file affordance-gap miss:', err);
  }
}

/**
 * File a process_miss when a DIRECTED pass (owner-approved build) fails
 * (2026-08-11, directed-build postmortem). Three builds died silently on
 * 2026-08-10/11 — blank_turn_fallback rows in audit_log were the ONLY trace,
 * and nothing ever reached Mariah's ledger, so approved work vanished until a
 * human read the logs. A failed build is a ledger event: severity HIGH (an
 * approved directive produced nothing), keyed per-directive so the SAME build
 * re-failing folds onto one row (recurrence notes) while distinct builds get
 * distinct rows. Exported for the directed-build-guards smoke.
 */
export function file_directed_build_miss(
  store: import('./process_misses').ProcessMissStore | undefined,
  args: {
    specialist_id: string;
    conversation_id: string;
    /** 'blank_turn' | 'ceiling_exhausted' | 'dup_failure_cut' */
    shape: string;
    instruction_preview: string;
    rounds_used: number;
    tool_round_ceiling: number;
    tool_calls_count: number;
    tool_errors: number;
    detail?: string;
  },
): void {
  if (!store) return;
  try {
    const directive_key = createHash('sha256')
      .update(args.instruction_preview)
      .digest('hex')
      .slice(0, 12);
    store.create({
      subject_specialist_id: args.specialist_id,
      reporter: 'orchestrator',
      task_summary: `Directed build pass: "${args.instruction_preview.slice(0, 200)}"`,
      gap:
        `directed-build-failure (${args.shape}): the pass ended with no deliverable. ` +
        `${args.rounds_used}/${args.tool_round_ceiling} rounds used, ` +
        `${args.tool_calls_count} tool calls, ${args.tool_errors} tool errors ` +
        `(conversation ${args.conversation_id}).` +
        (args.detail ? ` ${args.detail}` : '') +
        ` The upstream proposal is already terminal (acknowledged), so nothing ` +
        `re-files this work by itself — it must be re-dispatched deliberately ` +
        `once the blocker named above is fixed.`,
      severity: 'high',
      evidence_ref: `directed-build-fail:${args.specialist_id}:${directive_key}`,
    });
  } catch (err) {
    console.error('[runtime] failed to file directed-build miss:', err);
  }
}

/**
 * Canned error/fallback replies the runtime emits when a turn fails —
 * the timeout notice, the generic-error notice, the stop notice, the
 * MAX_TOOL_ROUNDS exhaustion summaries. They are persisted so the user
 * sees what happened, but they MUST be filtered out of
 * conversation_history on later turns. Left in, the model reads them as
 * exemplar assistant replies and parrots them verbatim — observed: one
 * real timeout seeded the timeout string into a conversation and Iris
 * then reproduced it (byte-identical, no actual LLM error) on every
 * hard follow-up, looking exactly like a recurring timeout that was in
 * fact poisoned history. Filtering here keeps the conversation itself
 * intact — the rows still display, the thread still continues; only
 * the model's view of history is cleaned, so no new conversation is
 * ever needed to escape the poison.
 *
 * The prefixes must track the literal strings emitted at the catch
 * sites in turn() / turn_streaming() and by _exhaustion_message().
 */
const _FALLBACK_PREFIXES: readonly string[] = [
  "I'm sorry — I lost my train of thought",
  'I lost my train of thought mid-reply',
  'I ran into a problem responding (',
  'I caught myself retrying the same tool call',
];
const _FALLBACK_EXHAUSTION_RE = /^I worked through \d+ steps? \(/;

/**
 * Render a single auto-retrieved library chunk for inclusion in the
 * system prompt's RAG section. Stamps the trust tier inline so the
 * specialist can see at a glance whether to cite without ceremony
 * (Tier 1), cite by name (Tier 2), or treat as user context (no
 * stamp). Title is shown when present because cited-by-name needs a
 * human-readable handle, not the slug-y filename.
 */
function render_rag_chunk(
  i: number,
  h: {
    note_path: string;
    chunk_text: string;
    trust_tier: 1 | 2 | null;
    title: string | null;
    as_of?: string | null;
  },
): string {
  const trust_marker =
    h.trust_tier === 1 ? ' · **Tier 1**'
    : h.trust_tier === 2 ? ' · **Tier 2**'
    : '';
  const title_part = h.title ? ` — ${h.title}` : '';
  return `### ${i + 1}. ${h.note_path}${title_part}${trust_marker}${_age_label(h.as_of)}\n\n${h.chunk_text.trim()}`;
}

/**
 * Age label for a retrieved excerpt — "· as of Sep 12 (40d old)". Stale
 * library facts presented without their age get spoken as CURRENT state
 * ("the battery is at 78%" from a month-old note); with the label the
 * model qualifies ("as of mid-May…"). Day math is UTC arithmetic on
 * instants (not wall-clock display); the date renders via time.ts.
 */
function _age_label(as_of: string | null | undefined): string {
  if (!as_of) return '';
  const then = new Date(as_of).getTime();
  if (Number.isNaN(then)) return '';
  const days = Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
  const date = format_short_date(as_of) ?? as_of.slice(0, 10);
  if (days <= 1) return ` · as of ${date} (current)`;
  return ` · as of ${date} (${days}d old)`;
}

/**
 * Low-confidence retrieval gate. When the rerank step ran (scores exist)
 * and even the BEST hit is below the relevance bar, the retrieval is
 * noise — injecting it invites the model to blend marginal excerpts with
 * parametric memory into something plausible (a quiet fabrication
 * vector). Suppress instead, and SAY so in the prompt, so the model
 * searches with different terms or answers honestly rather than citing
 * mush. FTS-only hits (no scores) pass through untouched — BM25 rank
 * isn't calibrated, and fail-open is the retrieval contract.
 */
function _rag_min_rerank(): number {
  const raw = Number.parseFloat(process.env.HEARTH_RAG_MIN_RERANK ?? '');
  return Number.isFinite(raw) ? raw : 0.15;
}
export function gate_low_confidence_rag(retrieved: ScopedChunkHit[]): {
  hits: ScopedChunkHit[];
  suppressed: boolean;
  top_score: number | null;
} {
  if (retrieved.length === 0) return { hits: retrieved, suppressed: false, top_score: null };
  const scored = retrieved.filter((h) => typeof h.rerank_score === 'number');
  if (scored.length !== retrieved.length) {
    return { hits: retrieved, suppressed: false, top_score: null };
  }
  const top = Math.max(...scored.map((h) => h.rerank_score!));
  if (top >= _rag_min_rerank()) return { hits: retrieved, suppressed: false, top_score: top };
  return { hits: [], suppressed: true, top_score: top };
}

const RAG_SUPPRESSED_SECTION =
  '\n\n## Library retrieval came back EMPTY for this question\n\n' +
  'Your library was searched automatically and nothing relevant was found ' +
  '(best match scored below the relevance bar). Do NOT answer as if your ' +
  'library covered this: either call `search_library` with different terms, ' +
  'use a live tool, or say plainly that you don\'t have material on it. ' +
  'Never blend weak excerpts or memory into a confident answer.';

export function is_fallback_message(text: string): boolean {
  const t = text.trimStart();
  return (
    t === '(stopped)' ||
    _FALLBACK_EXHAUSTION_RE.test(t) ||
    _FALLBACK_PREFIXES.some((p) => t.startsWith(p))
  );
}

/**
 * Detect a specialist's own recent "I can't / I don't have access" replies
 * in conversation history. These are NOT runtime fallbacks (those are caught
 * by is_fallback_message); they are the model's own substantive denials —
 * and Claude-distilled finetunes especially tend to parrot them forward
 * even after the tool surface has changed (a tool added, a capability
 * granted, a description corrected). The buried "THIS SYSTEM PROMPT IS THE
 * TRUTH" instruction in the persona scaffold loses out to recency.
 *
 * Returns a short callout the runtime appends to the END of the system
 * prompt: it quotes the stale denial and instructs the model to verify
 * against the *current* tool list before re-asserting. Conservative regex
 * patterns target capability-denials specifically (not "I don't know" or
 * "I disagree" content). Conversation mode only; deliberation has its own
 * JSON envelope and isn't subject to this failure.
 */
const _STALE_DENIAL_PATTERNS: readonly RegExp[] = [
  /\bI\s+(?:don'?t|do\s+not)\s+have\s+(?:direct\s+)?(?:read|write|file)?\s*(?:access|a\s+tool|the\s+(?:tool|ability|capability))/i,
  /\bI\s+(?:can'?t|cannot|can\s+not)\s+(?:directly\s+)?(?:access|read|fetch|retrieve|reach|see|open|load)\b/i,
  /\bnot\s+(?:in|part\s+of)\s+my\s+(?:toolkit|tools|capabilities|capability\s+set)\b/i,
  /\bI\s+lack\s+(?:the\s+)?(?:tool|access|capability|ability)\b/i,
  /\bI'?m\s+unable\s+to\s+(?:access|read|fetch|retrieve|reach|see|open|load)\b/i,
  // WRITE / MODIFY capability denials. The read/access patterns above missed
  // these, so a false "my tools are insert-only — I can't patch an existing
  // SKU" denial (Kristi DOES hold update_sku, with the exact pgx→edge recipe
  // in her persona) poisoned the thread and she parroted it for 3 turns
  // (2026-06-08). "insert-only" + "can't patch/modify/update/change/edit/
  // reclassify/overwrite/re-record" are the shapes.
  /\binsert[\s-]?only\b/i,
  /\b(?:can'?t|cannot|can\s+not|unable\s+to|don'?t\s+have\s+(?:a|the)\s+(?:way|tool|ability)\s+to)\s+(?:directly\s+)?(?:patch|modify|update|change|edit|alter|reclassify|overwrite|re-?record|re-?classify)\b/i,
];

/**
 * Office/pane display names by `pane_kind`. Mirrors the per-pane `title:`
 * literals in specialist_pane.ts — the only consumer is self-identity
 * grounding (so a specialist naming its own office, e.g. "Recon Desk", isn't
 * flagged as a fabrication by the fact critic). If you add or rename a pane
 * there, mirror it here; a missing entry just means that office name isn't
 * pre-grounded (the critic's judge still bins it as a non-claim).
 */
const PANE_TITLES: Readonly<Record<string, string>> = {
  activity: 'Activity', briefing: 'Briefing', civic: 'City Desk',
  codeshop: 'Code Shop', competitive: 'Recon Desk', fuel: 'Finances',
  library: 'Library', listening: 'Listening', presence: 'Presence',
  program: 'Program', property: 'Property',
  resale: 'Resale Desk', security: 'Watch Desk', today: 'Today',
};

/**
 * The specialist's own structural identity, as a short evidence string for
 * the fact critic — its name, role, aliases, office/pane name, and the tools
 * it holds. These live in the system prompt, which is deliberately excluded
 * from turn evidence, so without this a specialist's self-reference ("I
 * updated it in the Recon Desk", "I can use `update_sku`") reads as
 * ungrounded. Grounding it kills that whole false-positive class. (2026-06-08.)
 */
function build_self_identity(
  specialist: LoadedSpecialist,
  tool_names: readonly string[],
  roster?: ReadonlyArray<{ id: string; name: string }>,
): string {
  const parts: string[] = [`You are ${specialist.name}, ${specialist.role}.`];
  if (specialist.aliases && specialist.aliases.length > 0) {
    parts.push(`Also called: ${specialist.aliases.join(', ')}.`);
  }
  const office = specialist.pane_kind ? PANE_TITLES[specialist.pane_kind] : undefined;
  if (office) parts.push(`Your office/workspace is called "${office}".`);
  if (tool_names.length > 0) {
    parts.push(`Tools you hold: ${[...new Set(tool_names)].join(', ')}.`);
  }
  // The staff roster is structural identity too: "Flagged to Beatrice —
  // she'll come back with a proposal" was critic-flagged as an
  // ungrounded named entity because nothing in the turn's evidence
  // carried the colleague's name (2026-06-09). Naming teammates is
  // never a fabrication.
  if (roster && roster.length > 0) {
    parts.push(
      `Your colleagues (referring to them is never a fabrication): ` +
        `${roster.map((s) => `${s.name} (${s.id})`).join(', ')}.`,
    );
  }
  return parts.join(' ');
}

export function detect_stale_self_denials(
  history: ReadonlyArray<{ role: string; content: string }>,
): string | null {
  // Only flag when the IMMEDIATELY-PREVIOUS specialist reply was a
  // denial. Looking deeper into history (originally `.slice(-8)`)
  // over-fired badly: stale old denials kept triggering the callout
  // even after Kate had moved on to correct retrievals, and combined
  // with think-ON the broad "verify, don't recall" guidance primed
  // her to doubt her own correct prior outputs — observed 2026-05-22
  // when she "admitted" to fabricating verbatim text she had in fact
  // retrieved correctly. Narrow scope: if the *last* specialist
  // message was a denial, this turn risks repeating it — pre-empt.
  // If it wasn't, the conversation has already moved past whatever
  // older denials might be in history; don't keep re-priming.
  let last_spec: { role: string; content: string } | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role === 'specialist') { last_spec = m; break; }
  }
  if (!last_spec) return null;
  if (!_STALE_DENIAL_PATTERNS.some((re) => re.test(last_spec!.content))) return null;
  const text = last_spec.content.replace(/\s+/g, ' ').trim();
  const dot = text.indexOf('. ');
  const cut = dot > 0 && dot < 200 ? dot + 1 : Math.min(180, text.length);
  const snippet = text.slice(0, cut).trim();
  return (
    '\n\n**Stale-denial check.** Your *immediately previous* reply expressed ' +
    'inability:\n  - "' + snippet + (text.length > cut ? '…' : '') + '"' +
    '\n\nThat was a CLAIM about an older state of your tool surface, not a ' +
    "fact about THIS turn. Before re-asserting \"I can't\" or \"I don't have,\" " +
    'check the tool list above — if the right tool is now there, call it. ' +
    'This guidance applies ONLY to that specific prior denial; it is NOT a ' +
    'reason to second-guess other correct content you have already delivered ' +
    'in this conversation.'
  );
}

/**
 * One-line label for the tool itself, used by the status line. Maps
 * internal tool names to short user-readable verbs.
 */
function _tool_label(tool_name: string): string {
  switch (tool_name) {
    case 'web_fetch_clean': return 'reading the web';
    case 'web_search': return 'searching the web';
    case 'search_library': return 'checking her library';
    case 'query_audit_log': return 'reviewing the audit log';
    case 'sensor_calendar_upcoming':
    case 'sensor_in_meeting':
    case 'sensor_free_blocks': return 'checking the calendar';
    case 'ha_get_state':
    case 'ha_list_entities': return 'checking Home Assistant';
    case 'friday_status': return 'pulling FRIDAY status';
    case 'route': return 'computing a route';
    case 'geocode': return 'geocoding';
    case 'distance_matrix': return 'computing distances';
    case 'nearby': return 'searching nearby places';
    case 'plan_ev_day': return 'planning the EV day';
    case 'upsert_place': return 'updating a place note';
    case 'import_gedcom': return 'importing the GEDCOM';
    case 'append_journal_entry':
    case 'upsert_person_note':
    case 'record_decision':
    case 'find_or_create_person':
    case 'link_notes': return 'updating the vault';
    case 'draft_message': return 'drafting a message';
    case 'propose_action': return 'proposing an action';
    case 'promise_followup': return 'scheduling a follow-up';
    case 'consult_specialist': return 'consulting a teammate';
    default: return `running ${tool_name}`;
  }
}

/**
 * Content-aware status phrase for the live "what they're doing" line.
 * Combines the generic `_tool_label` verb with the call's actual subject
 * from `_summarize_tool_input` (query / url / calendar / entity), so the
 * status reads "searching the web for 'gastric sensitive recipes'"
 * instead of the bare "searching the web". Deterministic — no model call.
 */
function _tool_status_phrase(tool_name: string, input: unknown): string {
  const label = _tool_label(tool_name);
  const detail = _summarize_tool_input(tool_name, input);
  if (!detail) return label;
  switch (tool_name) {
    case 'web_search':
    case 'search_library':
      return `${label} for ${detail}`; // detail is already quoted
    case 'web_fetch_clean':
    case 'geocode':
    case 'consult_specialist':
      return `${label} ${detail}`;
    default:
      return `${label} (${detail})`;
  }
}

const ConsultInputSchema = z.object({
  specialist_id: z.string(),
  question: z.string().min(1),
});

/**
 * Kate's conversational onboarding playbook (2026-06-15). Injected once into
 * her CHAT system prompt while the speaker hasn't completed setup. Points her
 * at what TO do (the "enable success, don't enumerate failures" house rule):
 * learn the user's FACETS, record them via update_user_profile, finish with
 * complete:true. Generalizes Astrid's cold-start interview to every facet,
 * per-user.
 */
export function render_onboarding_section(name: string): string {
  return (
    `**FIRST-TIME SETUP — get to know ${name}.** ${name} hasn't been onboarded ` +
    `yet, so part of your job this conversation is a brief, warm "getting to ` +
    `know you" so their Hearth reflects THEM. This is ${name}'s Hearth — carry ` +
    `over no assumptions from anyone else's setup (don't assume they drive the ` +
    `household EV, share specific pets, etc.).\n\n` +
    `Weave these in naturally over the next few turns — a couple of questions ` +
    `at a time, conversational, never all at once:\n` +
    `  - Which parts of life they want help with: do they drive or charge an ` +
    `EV? care for pets? tend a garden? want finance, fitness, civic, or music ` +
    `threads? These are their FACETS — what's actually theirs.\n` +
    `  - Where home is for them (so weather and the daily read are where THEY are).\n` +
    `  - What they want in their daily brief, and what to leave out.\n` +
    `  - Anything else that helps the staff serve them well.\n\n` +
    `As you learn each thing, record it right away with update_user_profile:\n` +
    `  - kind:"facets" — set the facets that apply to ${name} (plus any detail, ` +
    `e.g. their own vehicle or pets). Include only facets they actually have; ` +
    `omit the rest. This is what makes their brief drop what isn't theirs.\n` +
    `  - kind:"note" — a one-line fact worth remembering.\n` +
    `  - kind:"profile" — a short narrative summary once you have the picture.\n\n` +
    `When you've captured the essentials, call update_user_profile with ` +
    `complete:true — that finishes onboarding (this setup prompt stops showing) ` +
    `and seeds the rest of the staff so every specialist starts knowing ${name}. ` +
    `They can always refine later; facets are theirs to change.\n\n`
  );
}

export class SpecialistRuntime {
  constructor(private deps: SpecialistRuntimeDeps) {}

  /** Consult-spiral guard (2026-08-05): depth + repeat + rate bounds on
   *  `consult()`. In-process by design — see consult_guard.ts. */
  private consult_guard = new ConsultGuard();

  /** The LLM router. Exposed so non-turn callers (the deliberation
   *  brief critic) can make a tool-free planner-role call without
   *  reaching through a full turn(). Read-only accessor; the runtime
   *  still owns the deps. */
  get llm(): LLMRouter {
    return this.deps.llm;
  }

  /** RAG embedder; a NoopEmbedder (FTS-only) when none is wired. */
  private get embedder(): Embedder {
    return this.deps.embedder ?? NOOP_EMBEDDER;
  }

  /**
   * The shared SQLite handle, via MemoryClient's config — the same
   * established reach-through memory_files.ts uses (the runtime's deps
   * deliberately don't carry a raw db). Used for read-only exemplar
   * mining (tool_exemplars).
   */
  private _audit_db(): import('bun:sqlite').Database {
    return (this.deps.memory as unknown as { cfg: { db: import('bun:sqlite').Database } }).cfg.db;
  }

  /**
   * Tool-description embedding cache for the dynamic tool surface (keyed by
   * tool name; re-embedded when a tool's description changes via hot-reload).
   * Lazy — only opted-in specialists ever populate it. See dynamic_tools.ts.
   */
  private readonly _tool_vec_cache = new Map<string, CachedVec>();

  /**
   * Build the per-turn tool surface (2026-06-08). Returns the full
   * capability-granted `catalog` (cheap awareness, rendered as name+desc) and
   * the small `hot` set whose JSON schemas ship in `tool_defs`. DYNAMIC mode
   * (chat turn + embeddings live + `dynamic_tools` opted-in + not a directed
   * override) message-ranks the catalog into the hot set; a `load_tools`
   * meta-tool then pulls any other catalog tool's schema on demand. Otherwise —
   * and on ANY embed error / empty rank — returns today's curated surface
   * (`catalog === hot`, `dynamic_on === false`), byte-identical to the legacy
   * path. Fail-open is the contract: dynamic never reduces reach below today.
   */
  private async _build_turn_surface(
    specialist: LoadedSpecialist,
    role: import('./llm').LLMRole | undefined,
    message: string,
    override: readonly string[] | undefined,
  ): Promise<{ catalog: Tool[]; hot: Tool[]; dynamic_on: boolean }> {
    const full = this.deps.tools.list_for_capabilities(specialist.granted);
    const mode = _prompt_mode(role ?? 'specialist');
    // Opted into the two-tier surface at all — everything except the embedder,
    // which is the one condition that can fail transiently at runtime.
    const wants_dynamic =
      specialist.proactive.dynamic_tools === true &&
      process.env.HEARTH_DYNAMIC_TOOLS !== '0' &&
      // Chat, voice AND — since 2026-08-05 — the scheduled deliberation pass.
      // Deliberation was excluded when the two-tier surface shipped, and that
      // left the one surface that needed it most paying full freight: Kate's
      // 44 deliberation tools serialize to ~14,595 tokens, 43% of a static
      // prompt that was itself busting the window. The runtime said so on every
      // pass — "STATIC PROMPT TOO BIG — nothing was evictable ... trim the
      // persona/tool surface, not the thread" — 20 overflows in 48h across
      // kate, ruby and trainer, with ruby over budget for 8 consecutive rounds
      // and trainer reaching 73,651 tokens. No amount of thread compaction
      // touches that: the mass is static, and on a `trigger:` pass there is no
      // thread to compact at all.
      !(override && override.length > 0);
    const curated = (): { catalog: Tool[]; hot: Tool[]; dynamic_on: boolean } => {
      const c = _curate_tools_for_turn(full, specialist, role, override);
      return { catalog: c, hot: c, dynamic_on: false };
    };
    if (!wants_dynamic) return curated();

    const deliberating = mode === 'deliberation';
    // A deliberation pass's AWARENESS is its curated surface, not the whole
    // granted catalog — the one place this differs from chat, and the
    // difference is the entire win.
    //
    // Chat renders full-catalog awareness because a conversation can go
    // anywhere and `load_tools` is what buys back the reach that curation used
    // to hide. A scheduled pass is the opposite: it runs a known rota, and
    // rendering all 236 of Kate's granted tools as catalog lines costs 4,729
    // tokens — which measured MORE than the 4,777 the shrunken hot set saved,
    // for a net of −48. Mariah, whose curated surface is only 12 tools, came
    // out 1,980 tokens WORSE.
    //
    // Scoping awareness to `tools_for_deliberation` keeps reach exactly where
    // it is today (that list IS the pass's surface right now, so nothing
    // becomes unreachable) while letting the hot set shrink underneath it. A
    // specialist whose curated list already fits under the cap then renders no
    // awareness block at all and is byte-identical to before.
    const delib_surface = deliberating
      ? _curate_tools_for_turn(full, specialist, role, undefined)
      : full;
    // The specialist's curated picks, in author order. Under ranking these are
    // a +0.05 cosine prior; with no ranking available they ARE the order.
    const prior_list = [
      ...(deliberating
        ? specialist.proactive.tools_for_deliberation
        : specialist.proactive.tools_for_chat),
      ...(mode === 'voice' ? specialist.proactive.tools_for_voice : []),
    ];
    // Floor = global knowledge floor + the specialist's own can't-miss tools
    // (dynamic_tools_floor) — a ranking miss on a terse message must never
    // strand a core-domain tool (compose_hot_set skips ungranted names, so the
    // YAML can't escalate capability).
    //
    // A deliberation pass adds its STANDING DUTIES to that floor. The rota is
    // the one part of a pass whose tool needs are known in advance and are not
    // negotiable — a duty that is due and whose tool is not loaded is a duty
    // that silently does not happen, which is the exact failure standing_duties
    // exists to end. Pinning the union across all duties (rather than only the
    // ones due at this slot) keeps this a pure function of the config: the
    // surface builder has no slot, and a union of ~13 names is a cheap price
    // for never needing one.
    const duty_tools = deliberating
      ? (specialist.proactive.standing_duties ?? []).flatMap((d) => d.steps.map((s) => s.tool))
      : [];
    // The slot's BEAT is the other part of a pass whose tool needs are known
    // in advance (2026-08-06): `deliberation_beats` renders the slot's
    // workflow into the pass prompt, and a tool the script names in backticks
    // that isn't hot is a deliverable that silently doesn't happen. The first
    // surviving 19:00 pass proved it — its beat names `record_politics_item`,
    // but the politics tools sit past the author-order cap (a six-slot rota
    // shares ONE curated order, so positions 21+ never shipped on ANY slot)
    // and the model substituted `record_watch_event` rather than load_tools.
    // `message` here IS the fully rendered pass prompt, so its backticked
    // names are the script's tool needs — pin the ones on the pass surface.
    // Deliberation-only: a chat message quoting a tool name is conversation,
    // not a script.
    const beat_named = deliberating
      ? [...new Set([...message.matchAll(/`([a-z][a-z0-9_]{2,60})`/g)].map((m) => m[1]!))]
      : [];
    const floor = [
      ...FLOOR_TOOL_NAMES,
      ...(specialist.proactive.dynamic_tools_floor ?? []),
      ...(deliberating ? DELIBERATION_FLOOR_TOOL_NAMES : []),
      ...duty_tools,
      ...beat_named,
    ];
    const cap = deliberating ? MAX_HOT_TOOLS_DELIBERATION : MAX_HOT_TOOLS;

    /**
     * DEGRADED two-tier surface (2026-08-03) — used when the specialist is
     * opted into dynamic tools but the embedder can't rank (down, or a
     * transport blip mid-turn).
     *
     * The old behaviour here was `curated()`: catalog === hot, so EVERY tool on
     * `tools_for_chat` shipped its full JSON schema. For Kate that is 98
     * schemas — roughly the 9.8K tokens of prefill the dynamic surface was
     * built to remove. And it landed at the worst possible moment: embeddings
     * also gate turn-start RAG, so the same outage that inflates the prompt
     * strips the retrieval grounding out of it. Less grounded and three times
     * heavier, simultaneously, for as long as the outage lasts.
     *
     * Degraded mode keeps the two-tier shape instead. Awareness is the full
     * catalog (cheap name+description lines) and `load_tools` still resolves
     * any of them by name — that path is a pure registry lookup with no
     * embedder involvement, so it works fine during exactly this outage. Only
     * the pre-loaded slice shrinks, taken deterministically from the floor plus
     * the curated list in author order.
     *
     * So the fail-open contract holds where it matters: REACH is unchanged,
     * only how much ships pre-loaded. What is genuinely lost is ranking
     * QUALITY — the hot set stops tracking the message — which is a real
     * degradation, and the honest one to accept, because the alternative
     * degrades grounding and latency at the same time.
     */
    const degraded = (): { catalog: Tool[]; hot: Tool[]; dynamic_on: boolean } => {
      const hot = compose_hot_set(delib_surface, prior_list, floor, cap);
      if (hot.length === 0) return curated();
      // Nothing left to load on demand ⇒ don't render an awareness block or
      // advertise load_tools; the curated path already IS the whole surface.
      if (deliberating && hot.length >= delib_surface.length) return curated();
      return { catalog: delib_surface, hot, dynamic_on: true };
    };

    // A deliberation pass takes the DETERMINISTIC slice, never the ranked one.
    // Ranking needs a message to rank against, and this surface has no user
    // message — its "message" is the pass envelope, thousands of tokens of
    // context JSON whose cosine against a tool description means nothing. The
    // floor (knowledge floor + the pass's standing duties) plus
    // tools_for_deliberation in author order is a better-founded ordering than
    // a similarity score computed from noise, and it has the property a
    // scheduled pass actually wants: the same slot gets the same surface every
    // night, so a brief that worked yesterday is not reshuffled today.
    if (deliberating || !this.embedder.enabled) return degraded();
    try {
      const ranked = await rank_tools_for_message({
        message,
        catalog: full,
        embedder: this.embedder,
        cache: this._tool_vec_cache,
        priors: new Set(prior_list),
      });
      const hot = compose_hot_set(full, ranked, floor, cap);
      if (hot.length === 0) return degraded();
      return { catalog: full, hot, dynamic_on: true };
    } catch {
      // Embed transport blip mid-turn — same degraded surface as a cold
      // embedder, rather than falling all the way back to 98 schemas.
      return degraded();
    }
  }

  /**
   * Light an activity LED for the exact duration of `fn` — emit `on` before
   * it starts and `off` in a finally, so the UI indicator is faithful to the
   * live operation (HDD-blink). In-process emit on the existing SSE bus;
   * no-op when no event bus is wired. Never alters `fn`'s result or errors.
   */
  private async _with_activity<T>(
    channel: 'rag' | 'deep',
    specialist_id: string,
    conversation_id: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const ev = this.deps.events;
    if (!ev) return fn();
    ev.emit({ type: 'specialist_activity', specialist_id, conversation_id, channel, state: 'on' });
    try {
      return await fn();
    } finally {
      ev.emit({ type: 'specialist_activity', specialist_id, conversation_id, channel, state: 'off' });
    }
  }

  list(): LoadedSpecialist[] {
    return this.deps.specialists.list();
  }

  get(id: string): LoadedSpecialist | null {
    return this.deps.specialists.get(id);
  }

  /**
   * Synchronous side-call: one specialist asks another a question and gets
   * a brief text answer back. The consultee runs through turn() with a
   * one-shot conversation (no persisted history). The exchange is recorded
   * in both specialists' inboxes.
   */
  /**
   * Phase 2b hard-refusal short-circuit. When a specialist's
   * `discretion.allowed_tiers` excludes the caller's tier, the runtime
   * returns a canned refusal without ever building messages or
   * invoking the LLM. The audit row records the refusal so an
   * operator can later see what was attempted.
   *
   * Defense-in-depth purpose: the persona + soft-discretion block
   * mostly do the right thing, but a jailbroken LLM is still an LLM.
   * The only way to guarantee a sensitive specialist (Cassandra,
   * Vivian) never leaks owner state to a non-owner is to never call
   * the model.
   */
  private _hard_refusal_output(
    specialist: LoadedSpecialist,
    input: SpecialistTurnInput,
  ): SpecialistTurnOutput {
    const tier = caller_tier(input.user);
    const text = canned_refusal(specialist, input.user);
    this.deps.memory.log_action({
      intent_id: ulid(),
      agent: specialist.id,
      user_id: input.user?.id,
      tool_name: 'discretion_refusal',
      tool_input: {
        conversation_id: input.conversation_id,
        caller_id: input.user?.id ?? null,
        caller_tier: tier,
        allowed_tiers: specialist.discretion.allowed_tiers ?? null,
      },
      execution_result: { refused: true, defer_to: specialist.discretion.defer_to },
    });
    return {
      message_text: text,
      tool_calls_made: [],
      proposals_created: [],
      consulted_specialists: [],
      reasoning_trace: '',
      cost: {
        tokens_in: 0,
        tokens_out: 0,
        ms: 0,
        model: 'short-circuit:discretion',
      },
    };
  }

  /**
   * Catch-all for any uncaught error inside the turn body. Used by
   * the public turn() and turn_streaming() wrappers so callers can
   * rely on "the runtime always returns a user-facing message" as a
   * hard contract. Without this, a thrown error inside (memory I/O,
   * proposal-store write, unexpected bookkeeping failure) would
   * propagate to the route handler and 500 the HTTP response — the
   * user sees nothing in chat, the typing indicator stays pinned,
   * and they conclude the specialist ignored them.
   *
   * The recovery message names the failure mode without leaking the
   * full stack. The audit row carries the error message for ops to
   * diagnose. A `specialist_thinking finished` event is emitted to
   * mirror the `started` that fired before the failing inner body,
   * so the UI's thinking lifecycle stays symmetric.
   */
  private _uncaught_turn_error(
    input: SpecialistTurnInput,
    err: unknown,
    mode: 'streaming' | 'non_streaming',
  ): SpecialistTurnOutput {
    const err_msg = err instanceof Error ? err.message : String(err);
    const err_stack = err instanceof Error ? err.stack : undefined;
    console.error(
      `[runtime/${mode}] uncaught turn error for ${input.specialist_id}:`,
      err_msg,
      err_stack ?? '',
    );
    try {
      this.deps.memory.log_action({
        intent_id: ulid(),
        agent: input.specialist_id,
        user_id: input.user?.id,
        tool_name: 'specialist_turn_uncaught',
        tool_input: {
          conversation_id: input.conversation_id,
          mode,
          message_summary: input.message.content.slice(0, 200),
        },
        error: err_msg,
      });
    } catch (audit_err) {
      console.error(
        `[runtime/${mode}] audit log failed alongside uncaught turn error:`,
        audit_err,
      );
    }
    // `specialist_thinking started` fired before the inner body ran
    // (both turn() and turn_streaming() emit it before delegating to
    // _turn_*_inner). Emit `finished` here so the lifecycle is
    // symmetric — otherwise non-chat surfaces that depend on the SSE
    // event would stay pinned on the typing indicator.
    this.deps.events?.emit({
      type: 'specialist_thinking',
      specialist_id: input.specialist_id,
      conversation_id: input.conversation_id,
      state: 'finished',
    });
    return {
      message_text:
        `I hit an unexpected error mid-reply (${err_msg.slice(0, 120)}). ` +
        `Try again, or rephrase if this keeps happening.`,
      tool_calls_made: [],
      proposals_created: [],
      consulted_specialists: [],
      reasoning_trace: '',
      cost: { tokens_in: 0, tokens_out: 0, ms: 0, model: `uncaught:${mode}` },
    };
  }

  /**
   * Last-resort synthesis when a turn exhausts its tool-round ceiling
   * without producing a final answer (2026-05-30). Instead of punting
   * with the canned "I worked through N steps" message, make ONE more
   * model call with tools DISABLED, instructing the specialist to answer
   * from what it already gathered. Streams the result via `message_token`
   * so it appears live in the chat bubble, and returns the synthesized
   * text (or '' if synthesis is unavailable/empty, so the caller falls
   * back to the canned message).
   *
   * Uses `complete_stream` only — when the provider doesn't support it
   * (test mode, non-streaming providers) we return '' and the caller
   * keeps the canned fallback rather than guessing at a second API shape.
   */
  private async _synthesize_on_exhaustion(args: {
    specialist: LoadedSpecialist;
    resolved: ReturnType<LLMRouter['for_role']>;
    messages: LLMMessage[];
    input: SpecialistTurnInput;
  }): Promise<string> {
    const { specialist, resolved, messages, input } = args;
    if (typeof resolved.provider.complete_stream !== 'function') return '';
    const synth_messages: LLMMessage[] = [
      ...messages,
      { role: 'user', content: _EXHAUSTION_SYNTH_PROMPT },
    ];
    const stream_id = `stream:synth:${ulid()}`;
    let out = '';
    try {
      const stream = resolved.provider.complete_stream!({
        messages: synth_messages,
        tools: [],
        temperature: resolved.defaults.temperature ?? 0.7,
        ...(input.think_override !== undefined
          ? { think: input.think_override }
          : resolved.defaults.think !== undefined
          ? { think: resolved.defaults.think }
          : {}),
        ...(_effective_max_tokens(specialist, resolved, input.max_tokens_override) !== undefined
          ? { max_tokens: _effective_max_tokens(specialist, resolved, input.max_tokens_override) }
          : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      for await (const ev of stream) {
        if (ev.type === 'content_delta') {
          out += ev.delta;
          this.deps.events?.emit({
            type: 'message_token',
            conversation_id: input.conversation_id,
            specialist_id: specialist.id,
            stream_id,
            delta: ev.delta,
          });
        }
      }
    } catch (err) {
      console.error(
        `[runtime] forced exhaustion synthesis failed for ${specialist.id}:`,
        err instanceof Error ? err.message : String(err),
      );
      return '';
    }
    return out.trim();
  }

  async consult(
    consultor_id: string,
    consultee_id: string,
    question: string,
    /** Consult-chain depth of the CALLING turn — see
     *  SpecialistTurnInput.consult_depth. External callers omit it (0). */
    depth = 0,
  ): Promise<string> {
    // Resolve display names / aliases / wrong case to the real id BEFORE
    // lookup — the LLM naturally says "beatrice" (id is `trainer`) or
    // "Ruby" (id is `ruby`), and a bare `.get()` 404'd both, making the
    // chief-of-staff look broken ("I don't have a specialist named
    // Beatrice"). resolve_id matches id → name → alias, case-insensitive.
    const resolved_id = this.deps.specialists.resolve_id(consultee_id) ?? consultee_id;
    const consultee = this.deps.specialists.get(resolved_id);
    if (!consultee) {
      // Affordance (connector-recovery pattern): hand the model the real
      // roster so it retries with a valid id instead of looping on the miss.
      const known = this.deps.specialists
        .list()
        .map((s) => (s.name.toLowerCase() === s.id ? s.id : `${s.id} (${s.name})`))
        .join(', ');
      return `[consult error: no specialist "${consultee_id}" — known specialists: ${known}]`;
    }
    if (consultor_id === resolved_id) {
      return `[consult error: cannot consult yourself]`;
    }

    // Consult-spiral guard (2026-08-05): depth cap + identical-question
    // repeat suppression + per-pair rate cap, checked BEFORE any inbox row
    // lands or any sub-turn runs. A blocked consult costs zero rows and
    // zero GPU — the verdict string is the tool result the calling model
    // reads, and every variant steers it to finish from what it has.
    if (consult_guard_enabled()) {
      const verdict = this.consult_guard.check({
        consultor_id,
        consultee_id: resolved_id,
        question,
        depth,
      });
      if (verdict.kind !== 'proceed') {
        return consult_verdict_message(verdict, consultee.name);
      }
    }

    // Record the question in the consultee's inbox.
    const q_id = this.deps.inbox.push({
      from_specialist_id: consultor_id,
      to_specialist_id: resolved_id,
      kind: 'question',
      body_md: question,
    });

    // Run a one-shot turn against an ephemeral conversation. We pass a
    // conversation_id of 'consult:<ulid>' which will not exist in the
    // conversations table — the runtime treats history empty when missing.
    // consult_depth marks the sub-turn's own consults as one level deeper,
    // which is what lets the guard cut recursion.
    const ephemeral_conv = `consult:${ulid()}`;
    const out = await this.turn({
      specialist_id: resolved_id,
      conversation_id: ephemeral_conv,
      message: {
        role: 'specialist',
        content: question,
        from_specialist_id: consultor_id,
      },
      conversation_history: [],
      consult_depth: depth + 1,
    });

    // When a consult turn produces no final text — usually the LLM kept
    // calling tools until MAX_TOOL_ROUNDS exhausted and never wrote a
    // closing message — we record a diagnostic so the inbox row is
    // meaningful (rather than blank) and the consultor sees a useful
    // failure string instead of empty content masquerading as an answer.
    let response_body = out.message_text.trim();
    if (response_body.length > 0) {
      // Cache REAL answers only — a cached failure diagnostic would turn
      // one transient sub-turn failure into a repeat-window-long outage
      // for that question (retries of failures stay bounded by the rate
      // cap instead).
      this.consult_guard.record_answer({
        consultor_id,
        consultee_id: resolved_id,
        question,
        answer: response_body,
      });
    }
    if (response_body.length === 0) {
      const last_calls = out.tool_calls_made.slice(-3);
      const last_errs = last_calls
        .filter((c) => c.error)
        .map((c) => `${c.name}: ${String(c.error).split('\n')[0]?.slice(0, 120)}`)
        .join('; ');
      const tool_count = out.tool_calls_made.length;
      response_body =
        `[${consultee.name} produced no answer — ${tool_count} tool call${tool_count === 1 ? '' : 's'} ` +
        `during the turn but no final reply` +
        (last_errs ? `. Recent errors: ${last_errs}` : `. (no tool errors logged)`) +
        `]`;
    }

    this.deps.inbox.push({
      from_specialist_id: resolved_id,
      to_specialist_id: consultor_id,
      kind: 'consult_response',
      body_md: response_body,
      related_proposal_id: out.proposals_created[0],
    });
    void q_id;

    return response_body;
  }

  /**
   * Phase-3 async-consult lane (the "librarian lane", 2026-05-31). When the
   * fact critic flags unsupported load-bearing claims in a primary (DEEP)
   * turn, dispatch a verification turn to the librarian specialist
   * (Cordelia) on the LIVE tier's A4000 endpoint (`provider_role:
   * 'librarian'`) so it FETCHES the questioned facts with her web/search
   * tools rather than the DEEP model re-deriving — and likely
   * re-fabricating — them. Runs off the 3090, so it doesn't compete with
   * the interactive turn; the join is the caller grounding its retry round
   * in the returned (cited) findings.
   *
   * Returns the librarian's findings text, or null on any failure / empty
   * answer (FAIL-OPEN — a librarian outage must never block the primary
   * turn). Recursion is impossible: the sub-turn runs with
   * `provider_role: 'librarian'`, and the callers gate the lane on
   * `!input.provider_role`, so the librarian's own fact-critic pass can't
   * re-enter the lane.
   */
  private async _librarian_verify(
    unsupported: FactFinding[],
    input: SpecialistTurnInput,
  ): Promise<string | null> {
    try {
      const claims = unsupported
        .map((u) => `- (${u.kind}) ${u.claim}`)
        .join('\n');
      const question =
        `A teammate's draft reply contains these load-bearing claims that ` +
        `are NOT grounded in any retrieved source. Verify each by FETCHING ` +
        `(web_search / web_fetch_clean / search_library) — do not answer ` +
        `from memory. For each claim return: the verified fact (or the word ` +
        `"unverified" if you can't confirm it) and the source URL or title. ` +
        `Be terse — this feeds another assistant, not the user.\n\n${claims}`;
      const out = await this.turn({
        specialist_id: librarian_specialist_id(),
        conversation_id: `librarian-verify:${input.conversation_id}`,
        message: { role: 'user', content: question },
        conversation_history: [],
        // Endpoint → LIVE tier A4000; this is also the recursion guard
        // (the sub-turn's own fact-critic gate sees provider_role set and
        // skips the lane).
        provider_role: 'librarian',
        user: input.user,
        signal: input.signal,
      });
      const text = out.message_text?.trim();
      return text && text.length > 0 ? text : null;
    } catch {
      return null;
    }
  }

  /**
   * Build the deps for the person-record grounding-precedence pass
   * (src/core/grounding_precedence.ts) from the live memory client: a cheap
   * person roster (name + master address from the People notes) plus a clipping
   * classifier (is a retrieved chunk a — reviewed? — library clipping). All
   * fail-open; a throw degrades to an empty roster (the precedence pass then
   * no-ops). See the address-fabrication-loop note in grounding_precedence.ts.
   */
  private _person_precedence_deps(): PersonPrecedenceDeps {
    // Lazy — the bridge invokes this only after its cheap address gate passes,
    // so query_people never runs on the common no-address turn.
    const roster = (): PersonRosterEntry[] => {
      try {
        return this.deps.memory.query_people({}).map((r) => {
          let address: string | null = null;
          try {
            const fm = JSON.parse(r.frontmatter_json) as Record<string, unknown>;
            address = stringify_address(fm.address);
          } catch {
            /* malformed frontmatter — no address */
          }
          return {
            name: r.name,
            preferred_name: r.preferred_name,
            address,
            note_path: r.note_path,
            is_self: r.relationship === 'self',
          };
        });
      } catch {
        return [];
      }
    };
    const clipping_meta = (note_path: string): ClippingMeta | null => {
      try {
        const note = this.deps.memory.read_note(note_path);
        if (!note) return null;
        return {
          is_clipping: note.frontmatter?.type === 'clipping',
          reviewed: note.frontmatter?.reviewed === true,
        };
      } catch {
        return null;
      }
    };
    return { roster, clipping_meta };
  }

  /**
   * Streaming variant of turn(). Same return shape, but emits
   * `message_token` events on the event bus as tokens arrive from the
   * model — UI can show the reply taking shape in real time.
   *
   * Tool-call interleave: streaming completes one round, runs any
   * tool calls non-streamingly, then streams the next round. The
   * user sees progress on each round.
   *
   * Falls back to non-streaming turn() if the provider doesn't
   * support complete_stream() OR if HEARTH_TEST_MODE is set.
   *
   * Postcondition: ALWAYS returns a SpecialistTurnOutput with a
   * non-empty user-facing `message_text`. Never throws past input
   * validation. Any uncaught error inside the turn body becomes a
   * recovery message via `_uncaught_turn_error` so the route handler
   * can persist a real reply for the user instead of 500-ing.
   */
  async turn_streaming(input: SpecialistTurnInput): Promise<SpecialistTurnOutput> {
    try {
      return await this._turn_streaming_inner(input);
    } catch (err) {
      return this._uncaught_turn_error(input, err, 'streaming');
    }
  }

  private async _turn_streaming_inner(input: SpecialistTurnInput): Promise<SpecialistTurnOutput> {
    // Wall-clock the USER has been waiting. Escalate-on-evidence spends it:
    // a turn that has already burned HEARTH_ESCALATE_MAX_TURN_MS never starts a
    // deep leg, because someone who has waited that long wants an answer, not a
    // better one. See escalation.ts.
    const turn_started_ms = Date.now();
    const specialist = this.deps.specialists.get(input.specialist_id);
    if (!specialist) throw new Error(`unknown specialist: ${input.specialist_id}`);
    // Phase 2b hard refusal — runs BEFORE any LLM/RAG/tool work. If
    // the caller's tier is outside the specialist's allowed_tiers, the
    // model never sees the request.
    if (!is_caller_allowed(specialist, input.user)) {
      return this._hard_refusal_output(specialist, input);
    }
    // Per-specialist model override: a specialist may pin its chat turns
    // to a different llm-role (e.g. an uncensored model) via YAML
    // `llm_role`. An explicit per-call role (deliberation/drafter) still
    // wins; the specialist override only fills the chat-turn default.
    const effective_role = resolve_effective_role(input, specialist);

    // Test mode short-circuits LLM calls with canned responses so smokes can
    // run without a live model. Ported from the former non-streaming turn()
    // (now a thin shim over this method); runs BEFORE the complexity gate and
    // surface build, exactly as turn() did, so TEST_MODE behaviour is
    // byte-identical to the pre-merge path the smokes assert.
    if (process.env.HEARTH_TEST_MODE === '1') {
      const canned_tools = _curate_tools_for_turn(
        this.deps.tools.list_for_capabilities(specialist.granted),
        specialist,
        effective_role,
        input.tools_override,
      );
      this.deps.events?.emit({
        type: 'specialist_thinking',
        specialist_id: specialist.id,
        conversation_id: input.conversation_id,
        state: 'started',
      });
      const out = this.canned_turn(specialist, input, canned_tools);
      for (const pid of out.proposals_created) {
        this.deps.events?.emit({
          type: 'proposal_created',
          proposal_id: pid,
          specialist_id: specialist.id,
          kind: 'recommendation',
          title_preview: out.message_text.slice(0, 80),
        });
      }
      this.deps.events?.emit({
        type: 'specialist_thinking',
        specialist_id: specialist.id,
        conversation_id: input.conversation_id,
        state: 'finished',
      });
      return out;
    }
    // Complexity gate (2026-06-10, DEMOTED 2026-08-05): the up-front route to
    // the deep tier. It now fires only on an EXPLICIT request for depth ("think
    // hard about this") — an instruction, not a guess — while the full
    // heuristic still runs and is still recorded. `escalation.ts` handles the
    // rest by escalating on what the turn DEMONSTRATES. Never voice, never
    // directed/tools_override turns (they pin their surface deliberately).
    if (
      complexity_gate_enabled() &&
      input.surface !== 'voice' &&
      _prompt_mode(effective_role) === 'conversation' &&
      !input.tools_override &&
      input.think_override === undefined
    ) {
      const floor = specialist.complexity_floor ?? 2;
      const verdict = assess_complexity(input.message.content, floor);
      if (verdict.hard) {
        input = { ...input, provider_role: 'deep_consult', think_override: true };
      }
      // Audit EVERY assessment, not just the routes (2026-08-05). The old row
      // was written only when the gate fired, so the corpus recorded the
      // predictor's hits and was blind to everything it passed on — you could
      // measure what escalation cost but never what it missed. Now
      // `would_have_escalated` sits on every turn beside `routed_to`, and joins
      // to that turn's `escalate_on_evidence` row on `intent_id`: prediction
      // and demonstration, same key, gradeable against each other. A row on
      // every conversational turn is a few hundred bytes against the ~184
      // escalations per fortnight this replaced.
      const skipped = !verdict.hard && verdict.would_have_escalated;
      if (verdict.hard || verdict.would_have_escalated || verdict.signals.length > 0) {
        this.deps.memory.log_action({
          intent_id: ulid(),
          agent: specialist.id,
          user_id: input.user?.id,
          tool_name: 'complexity_route',
          tool_input: {
            signals: verdict.signals.slice(0, 6),
            floor,
            message_preview: input.message.content.slice(0, 120),
          },
          execution_result: {
            routed_to: verdict.hard ? 'deep_consult' : 'fast',
            think: verdict.hard,
            explicit: verdict.explicit,
            would_have_escalated: verdict.would_have_escalated,
            // The demotion's actual cost, countable: turns the old gate would
            // have sent to the 122B and this one leaves on the fast tier.
            ...(skipped ? { demoted: true } : {}),
          },
        });
      }
    }
    // Endpoint may differ from behavior (e.g. a deliberation pass on the
    // A4000): provider from `provider_role`, prompt/tools from effective.
    const resolved = this.deps.llm.for_role(input.provider_role ?? effective_role);
    // Stream the reply tokens to the client only when the provider supports it
    // AND the caller wants it. Non-streaming callers (consult, the async
    // librarian, deliberation, the eval harness, intake turns) come in via
    // turn() with `stream:false` — they materialise the same
    // SpecialistTurnOutput but emit no token events and run a single
    // complete() per round. A provider with no complete_stream silently falls
    // back to a non-streamed completion. The TEST_MODE canned path already
    // returned above, so it never reaches here.
    const use_stream =
      input.stream !== false && typeof resolved.provider.complete_stream === 'function';

    const { catalog, hot, dynamic_on } = await this._build_turn_surface(
      specialist,
      effective_role,
      input.message.content,
      input.tools_override,
    );
    const available_tools = hot;
    // Dynamic-surface per-turn state (no-ops when dynamic_on is false).
    const hotNames = new Set(hot.map((t) => t.name));
    let dynamic_loaded = 0;
    const intent_id = ulid();
    // Observability for the dynamic tool surface: one audit row per dynamic
    // turn recording how much the hot set narrowed the catalog (and which
    // tools the message-RAG surfaced). Cheap (counts + names), dynamic-only.
    if (dynamic_on) {
      this.deps.memory.log_action({
        intent_id,
        agent: specialist.id,
        user_id: input.user?.id,
        tool_name: 'dynamic_tool_surface',
        tool_input: { message_preview: input.message.content.slice(0, 80) },
        execution_result: {
          catalog_n: catalog.length,
          hot_n: hot.length,
          hot: hot.map((t) => t.name),
        },
      });
    }
    // Per-round stream_id: when a turn spans multiple tool-call rounds,
    // each round's content streams under its own id so the client's
    // `state.streaming_text` (keyed on stream_id) resets between rounds.
    // Without this, content from rounds 1..N-1 accumulates in the live
    // bubble but only round N's content is persisted — the user sees a
    // long stream then a much shorter saved message. The reset makes
    // the live view match what will be saved.

    this.deps.events?.emit({
      type: 'specialist_thinking',
      specialist_id: specialist.id,
      conversation_id: input.conversation_id,
      state: 'started',
    });

    const _mode_a = _prompt_mode(effective_role);
    // Citation mode (2026-06-10): research specialists in conversation get
    // [S#]-labeled tool results + the inline-citation contract; the
    // deterministic claim→source check runs at finalize. See citations.ts.
    const cite_mode =
      _mode_a === 'conversation' &&
      specialist.proactive.research_workload === true &&
      citations_enabled();
    let source_n = 0;
    const turn_sources: CitationSource[] = [];

    // Turn-time RAG (same as turn()). Pure-cordon privacy filter: drops
    // chunks from notes whose frontmatter `private_to` doesn't match the
    // calling user. No specialist bypasses this — not even Kate. A user's
    // personal note never reaches another user's turn context; the owner's
    // cross-user reach is the explicit, audited `review_user_activity`
    // oversight tool, never passive RAG.
    //
    // SKIPPED for voice turns (2026-05-30): the voice_realtime path
    // lives or dies on TTFB, and turn-time RAG runs synchronously
    // before the first token. On the voice surface auto-RAG buys little
    // and costs the latency budget; the turn reads the vault on demand
    // via `search_library` instead.
    // Turn-start auto-RAG. Grounds the turn in retrieved library material
    // BEFORE the first token rather than hoping the model calls
    // search_library (which it frequently forgets). Skip only when:
    //   - voice: TTFB-critical; reads the vault on demand;
    //   - the specialist has no knowledge_scope to retrieve from;
    //   - the specialist opted out via `auto_rag: false` (latency-critical
    //     and library-grounding adds no value, e.g. Astrid mid-workout).
    // The `live` TIER is deliberately NOT a skip reason: `live` is an
    // ENDPOINT choice (the forza 80B interactive chat runs on), not a
    // signal to leave the specialist ungrounded. The old `effective_role
    // === 'live'` skip silently disabled auto-RAG for ALL interactive chat
    // when chat moved onto the live tier — leaving the grounding-rule prompt
    // pointing at an always-empty "retrieved library section" and the
    // fact-critic with no retrieved evidence to verify against (a primary
    // false-positive-re-roll / visible-rewrite source). Retrieval is local
    // FTS + the dedicated A4000 RAG box (:8091), never the 80B inference
    // slot — a few ms (FTS) to a few hundred ms (vector) of TTFB.
    const skip_rag =
      _mode_a === 'voice' ||
      specialist.knowledge_scope.length === 0 ||
      specialist.auto_rag === false;
    const retrieved_raw = skip_rag
      ? []
      : await this._with_activity('rag', specialist.id, input.conversation_id, () =>
          retrieve_hybrid({
            memory: this.deps.memory,
            embedder: this.embedder,
            query: input.message.content,
            knowledge_scope: specialist.knowledge_scope,
            k: 5,
            user_id: input.user?.id,
            user_tier: input.user?.tier ?? 'owner',
          }),
        );
    // Low-confidence gate: a reranked retrieval whose BEST hit is below the
    // bar is suppressed (weak evidence invites blend-with-memory
    // fabrication) and the prompt says so explicitly.
    const { hits: retrieved, suppressed: rag_suppressed, top_score: rag_top_score } =
      gate_low_confidence_rag(retrieved_raw);
    if (rag_suppressed) {
      this.deps.memory.log_action({
        intent_id,
        agent: specialist.id,
        user_id: input.user?.id,
        tool_name: 'rag_low_confidence',
        tool_input: { query_preview: input.message.content.slice(0, 120) },
        execution_result: { candidates: retrieved_raw.length, top_score: rag_top_score },
      });
    }
    let rag_section =
      retrieved.length === 0
        ? (rag_suppressed ? RAG_SUPPRESSED_SECTION : '')
        : '\n\n## Relevant material from your library\n\n' +
          retrieved
            .map((h, i) => render_rag_chunk(i, h))
            .join('\n\n---\n\n') +
          '\n\nThe excerpts above were retrieved automatically based on ' +
          "the user's question.\n" +
          '- **Tier 1 sources** (peer-reviewed, professional bodies, ' +
          'non-captured government) — cite without ceremony; the trust ' +
          "is in the manifest. Drop a [[note_path]] when you draw on them.\n" +
          '- **Tier 2 sources** (clinical lay synthesis, evidence-based ' +
          'practitioners) — cite by source name in prose ("Per Mayo' +
          ' Clinic\'s exercise guidance…", "Examine.com\'s creatine ' +
          'monograph…"). The reader needs to know the trust level you\'re ' +
          'drawing from.\n' +
          '- **No trust stamp** — older notes or non-library content; ' +
          'treat as the user\'s own context, not external authority.\n' +
          'If the excerpts do not answer the question, say so plainly ' +
          'instead of inventing details.';
    if (retrieved.length > 0) {
      this.deps.memory.log_action({
        intent_id,
        agent: specialist.id,
        user_id: input.user?.id,
        tool_name: 'rag_retrieval',
        tool_input: {
          query_preview: input.message.content.slice(0, 120),
          scope: specialist.knowledge_scope,
        },
        execution_result: {
          k: retrieved.length,
          paths: retrieved.map((r) => r.note_path),
          trust_tiers: retrieved.map((r) => r.trust_tier),
        },
      });
    }

    // Phase 1b — per-specialist structured grounding packs. A cheap, read-only,
    // fail-open pre-turn fetch of the specialist's AUTHORITATIVE structured data
    // (Ruby civic ledger, Anna parcel records, Kristi SKU registry) — the rows
    // RAG-over-prose can't reach. Injected as `verified` evidence so the model
    // sees them in-prompt AND the fact-critic counts them as grounding.
    // Conversation turns ONLY (2026-06-07). Voice was briefly given grounding
    // packs (2026-06-06) to pre-inject the calendar against omission-
    // fabrication — but the pack is a small slice of voice prefill, while the
    // dominant cost is the system prompt + curated tools; and Kate's
    // voice_style already commands "GROUND FIRST — call sensor_calendar_upcoming
    // for the schedule," so on voice the pack was redundant with a tool call
    // she makes anyway. Voice now SKIPS the always-on pack blocks for latency
    // (the fact-critic + provenance retry are already voice-skipped, so voice
    // is the lean-grounding surface by design); the round-0 forced-fetch
    // backstop below still guarantees a lookup tool runs. Deliberation has its
    // own life-context packs.
    //
    // 2026-07-28 amendment: voice DOES run the pack now, in LEAN mode
    // (surface:'voice') — the pack itself skips every always-on block and only
    // the topic-gated household/person/security blocks can fire. Those questions
    // ("who's home?", "check on Sam") are precisely where an ungrounded voice
    // turn used to answer from vibes; the blocks are local ms-reads and appear
    // only when asked for, so the latency rationale above still holds.
    // Working memory stays conversation-only (situational gated below).
    const _packs_on = _mode_a === 'conversation' || _mode_a === 'voice';
    let verified_blocks = _packs_on
      ? await gather_grounding_packs(specialist.id, {
          message: input.message.content,
          memory: this.deps.memory,
          user_id: input.user?.id ?? process.env.HEARTH_OWNER_USER_ID ?? 'jasper',
          now: new Date(),
          timezone: input.user?.timezone,
          // Working-memory opt-in (proactive.situational_context +
          // HEARTH_WORKING_MEMORY): the fused household block rides the
          // same verified channel. Tier drives the cordon; an absent user
          // (internal turn) reads at the most-restrictive 'friend' tier.
          situational: _mode_a === 'conversation' && specialist.proactive.situational_context === true,
          tier: input.user?.tier,
          surface: _mode_a === 'voice' ? 'voice' : 'chat',
          users: this.deps.users,
        })
      : [];
    let verified_section = render_verified_section(verified_blocks);
    // Audit EVERY packs-on turn, including the zero-block one. Logging only the
    // non-empty case made "the pack ran and produced nothing" indistinguishable
    // from "the pack never ran" — so the voice surface silently shipping NO
    // calendar grounding for two months left no trace anyone could grep for.
    // The absence IS the signal worth recording; `surface` is on the row so the
    // chat/voice split is visible without re-deriving it.
    if (_packs_on) {
      this.deps.memory.log_action({
        intent_id,
        agent: specialist.id,
        user_id: input.user?.id,
        tool_name: 'grounding_pack',
        tool_input: {
          query_preview: input.message.content.slice(0, 120),
          surface: _mode_a === 'voice' ? 'voice' : 'chat',
        },
        execution_result: { blocks: verified_blocks.length },
      });
    }

    // Person-record grounding precedence (Person-record grounding integrity #2,
    // 2026-06-14): a derived/cache library clipping (esp. reviewed:false) must
    // NOT outrank the master People/<name>.md record or the user's own statement
    // for the same person fact (the 2026-06-03 address-fabrication loop — a stale
    // the clinic-vet-lab address branded the correct home address a "fabrication" for
    // two days). Inject the master record as authoritative grounding and scrub
    // the conflicting clipping address out of the retrieved section, so it can
    // neither anchor the model nor pass the grounding check. Conversation only;
    // address-gated (zero work otherwise); fail-open.
    if (_mode_a === 'conversation') {
      try {
        const pp = gather_person_precedence(this._person_precedence_deps(), {
          retrieved,
          rag_section,
          message: input.message.content,
          history: input.conversation_history,
        });
        if (pp.applied) {
          rag_section = pp.rag_section;
          if (pp.master_blocks.length > 0) {
            verified_blocks = [...verified_blocks, ...pp.master_blocks];
            verified_section = render_verified_section(verified_blocks);
          }
          this.deps.memory.log_action({
            intent_id,
            agent: specialist.id,
            user_id: input.user?.id,
            tool_name: 'grounding_precedence',
            tool_input: { query_preview: input.message.content.slice(0, 120) },
            execution_result: {
              master_records: pp.master_blocks.length,
              excluded: pp.excluded
                .map((e) => ({
                  subject: e.subject,
                  value: e.value,
                  from: e.from_ref,
                  beaten_by: e.beaten_by,
                }))
                .slice(0, 10),
            },
          });
        }
      } catch (err) {
        console.error(`[grounding-precedence] ${specialist.id} (fail-open):`, err);
      }
    }

    let system_prompt =
      this.build_system_prompt(specialist, catalog, _mode_a, input.user, hot, dynamic_on) +
      rag_section +
      verified_section;
    if (_mode_a === 'conversation') {
      const stale = detect_stale_self_denials(input.conversation_history);
      if (stale) {
        console.log(`[stale-denial] ${specialist.id}: pre-empting prior self-denial in system prompt`);
        system_prompt += stale;
      }
    }
    // Voice-surface output overlay (2026-06-05). A spoken turn for a
    // specialist that opted in via `voice_style` appends those speakable-
    // output rules as the recency-weighted TAIL — the persona + tools above
    // are untouched, only the OUTPUT shaping changes (no markdown, units as
    // words). Gated on voice_style presence → Kate only today. See
    // SpecialistTurnInput.surface + build_system_prompt for the rationale.
    if (input.surface === 'voice' && specialist.voice_style) {
      system_prompt += `\n\n---\n${specialist.voice_style.trim()}`;
    }
    // Per-turn framing (agent rooms group-chat directive) as the tail — after
    // the persona + any voice_style, so it's the most recency-weighted context.
    if (input.extra_system && input.extra_system.trim()) {
      system_prompt += `\n\n---\n${input.extra_system.trim()}`;
    }
    const messages: LLMMessage[] = [{ role: 'system', content: system_prompt }];
    for (const m of input.conversation_history) {
      // A failed turn persists a canned fallback reply so the user sees
      // what happened — but feeding it back as history teaches the model
      // to parrot it. Drop fallbacks here; the conversation row itself
      // is untouched. See is_fallback_message().
      if (m.role === 'specialist' && is_fallback_message(m.content)) continue;
      const role = m.role === 'specialist' || m.role === 'system' ? 'assistant' : 'user';
      messages.push({
        role,
        // Stamp ONLY user-role history. Stamping the specialist's OWN prior
        // replies taught the model to open its output with "[Mon 8:38 PM]"
        // (parroting); the temporal-grounding need (a past "today"/"tomorrow"
        // read against the current clock) is about what the USER said.
        content: role === 'user'
          ? _stamp_history_content(m.content, m.ts, input.user?.timezone)
          : m.content,
      });
    }
    // The half-open [1, history_end) span of replayed conversation history —
    // the ONLY region enforce_prompt_window() may evict. Captured here rather
    // than re-derived later so it can't drift as the tool loop appends: index 0
    // is the system prompt, and everything from `history_end` on is the live
    // user turn plus this turn's tool_call/tool_result pairs, none of which can
    // be dropped without malforming the request. Decremented by whatever the
    // enforcer evicts, so the span stays accurate across rounds.
    let history_end = messages.length;
    // ── KV-PREFIX ORDERING (2026-07-30) ──────────────────────────────────
    // The "**Right now**" anchor lives HERE, on the final user turn, and NOT
    // anywhere in the system prompt. format_now_anchor()/_format_voice_now()
    // include the MINUTE, so any placement inside the system message makes the
    // whole ~11K-token prefix change every 60s and forces a full re-eval.
    //
    // Measured on live Kate turns (2026-07-30), identical question each time:
    //   40s apart, SAME minute      -> 1.09s   (cache hit)
    //    3s apart, ACROSS a minute  -> 3.24s   (10,873 tokens re-evaluated)
    // A captured wire diff confirmed the ONLY difference between the cheap and
    // expensive requests was "1:50 PM" vs "1:51 PM". Moving it late-but-still-
    // inside the system prompt was NOT enough (llama.cpp did not do partial
    // reuse across the edit even at 89.8% common prefix). On the user turn the
    // divergence sits past every cacheable token, so the prefix always hits.
    //
    // Keep this invariant: the system prompt must contain NOTHING that varies
    // turn to turn. Volatile per-turn context goes on the user turn.
    const _now_anchor =
      input.surface === 'voice'
        ? `**Right now** (for your own awareness — do NOT say the time, date, or ` +
          `any timestamp out loud unless ${input.user?.display_name ?? 'they'} ` +
          `actually ask): ${_format_voice_now(input.user?.timezone)}.`
        : `**Right now**: ${format_now_anchor(input.user?.timezone)}. ` +
          `Use this as your source of truth for "today", "tomorrow", weekday, ` +
          `time of day, etc. Do not say you don't know what day it is.`;
    messages.push({
      role: 'user',
      content:
        _mode_a === 'deliberation'
          ? input.message.content
          : `${_now_anchor}\n\n${input.message.content}`,
    });

    const tool_defs: ToolDef[] = available_tools.map((t) =>
      to_tooldef(t, exemplars_enabled() ? exemplar_for(this._audit_db(), t.name) : null),
    );
    tool_defs.push({
      name: CONSULT_TOOL_NAME,
      description:
        'Ask another specialist a brief scoped question and receive their answer in their voice.',
      parameters: {
        type: 'object',
        properties: {
          specialist_id: { type: 'string' },
          question: { type: 'string' },
        },
        required: ['specialist_id', 'question'],
      },
    });
    // Dynamic tool surface: advertise the load_tools meta-tool so the model can
    // pull any catalog tool's schema on demand (the escape hatch for a tool the
    // message-RAG pre-pass didn't surface). Handled inline in the dispatch loop.
    if (dynamic_on) {
      tool_defs.push({
        name: LOAD_TOOLS_NAME,
        description:
          'Load the full call schema for one or more tools from your catalog so ' +
          'you can use them this turn. Pass the exact tool name(s); they become ' +
          'callable on your next step.',
        parameters: {
          type: 'object',
          properties: { names: { type: 'array', items: { type: 'string' } } },
          required: ['names'],
        },
      });
    }

    const tool_calls_made: SpecialistTurnOutput['tool_calls_made'] = [];
    const proposals_created: string[] = [];
    const consulted = new Set<string>();
    let reasoning_trace = '';
    let final_text = '';
    let last_cost = { tokens_in: 0, tokens_out: 0, ms: 0, model: resolved.model };
    let llm_error: string | null = null;

    const ctx: ToolContext = {
      memory: this.deps.memory,
      llm: this.deps.llm,
      embedder: this.embedder,
      now: new Date(),
      intent_id,
      // Plumbed for tools that need to know who's calling and where —
      // promise_followup needs both to enqueue a deliver-followup row,
      // cleanup_library_trash needs specialist_id to scope its sweep
      // to the caller's own library. Historically only the
      // non-streaming turn() set these, so any tool requiring them
      // would throw "requires X on ToolContext" through the chat path
      // (which is streaming by default). Symptom Anya hit:
      // "I can't call cleanup_library_trash directly — it requires a
      // specialist context I don't have in this conversation."
      conversation_id: input.conversation_id,
      specialist_id: specialist.id,
      // Cancellation for tools that make their own long-running calls. Before
      // this, pressing Stop left an in-flight `consult_deep_model` holding a
      // 300s deep_consult slot the user could no longer reach.
      ...(input.signal ? { signal: input.signal } : {}),
      // Phase 2b — caller identity for vault-write and audit attribution.
      // Tools auto-stamp `private_to: <user_id>` on user-scoped writes
      // and forward `user_id` into log_action calls.
      ...(input.user ? { user: { id: input.user.id, tier: input.user.tier ?? 'owner', timezone: input.user.timezone } } : {}),
    };

    // Per-turn dedup cache. Catches the "definition of insanity" pattern
    // where the LLM retries an identical tool call expecting a
    // different result (e.g. the same 404 URL fetched 7×). Signature
    // is (tool_name + sorted JSON of input). A duplicate of a
    // SUCCESSFUL call is re-served from this cache as a RESULT
    // (duplicate_call marker, capped re-emission); a duplicate of a
    // FAILED call stays a DUPLICATE_TOOL_CALL error. See
    // _dedup_cached_note() / _dedup_failed_error_for() / _call_signature().
    const seen_results = new Map<string, { ok: boolean; content: string; error?: string }>();
    // Per-turn heavy (external-fetch) call counter — see
    // HEAVY_FETCH_CAP_PER_TURN. Distinct from rounds: caps fetches, not
    // reasoning steps.
    let heavy_calls_made = 0;

    // Directed fast-fail latch (2026-08-11): on a DIRECTED pass, the tool
    // whose identical FAILED call came back around (the second identical
    // failure). Set in the dedup-serve branch, acted on after the round's
    // calls settle — the pass ends with a filed miss instead of burning the
    // remaining rounds rediscovering the same wall (the propose_code_edit
    // ×5 retry loop, 2026-08-10/11 postmortem).
    let directed_dup_cut: string | null = null;
    // Ghost-promise guard fires at most once per turn — see
    // _detect_ghost_promise(). Without this latch the loop could
    // oscillate between two equally-promisey replies.
    let ghost_promise_retried = false;
    // Synthesis-nudge latch — fires at most once per turn when the
    // tool-call loop exits with empty content OR a meta-only intent
    // statement ("Let me read…") despite tools having executed. See
    // META_INTENT_PATTERN. Distinct from ghost-promise because that
    // mechanism is verb-specific and missed wordings like "read"
    // and "pull"; this is the catchall.
    let synthesis_nudged = false;
    // Provenance guard latch (Durable-Truth Phase 1) — independent of the
    // ghost/save latch. Fires at most once per turn when the final reply
    // carries ENFORCED-tier specifics (order numbers, verbatim quotes)
    // that don't trace to anything retrieved this turn. The in-loop retry
    // is a quality move (let the model ground-or-drop cleanly); the
    // post-loop redaction is the structural backstop if it survives.
    let provenance_retried = false;
    // 1b read-failure honesty guard latch — at most one retry per turn.
    let read_failure_retried = false;
    // Data-denial guard latch (2026-06-12) — at most one retry per turn.
    let data_denial_retried = false;
    // Shell-safety guard latch (2026-07-25) — at most one retry per turn.
    let shell_safety_retried = false;
    // ── escalate-on-evidence state (2026-08-05) ─────────────────────────────
    // Claims a grounding guard flagged, carried ACROSS the re-roll. They are
    // the whole evidentiary basis of an escalation: the fast tier was told
    // exactly what it couldn't support and got a fresh round to fix it, so a
    // claim still standing afterwards is the turn demonstrating — in its own
    // output — that it is out of road. Empty on the common path.
    let carried_findings: CarriedFinding[] = [];
    // At most one escalation per turn. Its own latch and its own one-shot
    // budget, NOT the shared content budget — by construction it only ever
    // fires after a guard has already spent that budget (same reasoning as the
    // synthesis nudge and the tool-channel guards).
    let escalated_once = false;
    // Held while a deep leg is in flight; released after the loop. The gate's
    // lazy expiry sweep covers the uncaught-throw path (see escalation.ts).
    let escalation_release: (() => void) | null = null;
    // Narrows the forced `consult_deep_model` call to the escalation budget
    // instead of `deep_consult`'s 300s timeout. Null on every other turn.
    let escalation_signal: AbortSignal | null = null;
    // Both of the above are written inside `run_reply_guards` and read out
    // here, and TypeScript's flow analysis doesn't follow a closure write — it
    // narrows the captured `let` to its initializer and calls the release
    // uncallable. Reading them through these helpers is what makes the
    // narrowing correct rather than casting it away.
    const release_escalation = (): void => {
      if (escalation_release) {
        escalation_release();
        escalation_release = null;
      }
    };
    const escalation_signal_for = (tool_name: string): AbortSignal | null =>
      escalation_signal !== null && tool_name === ESCALATION_TOOL ? escalation_signal : null;
    // Unified content-re-roll budget shared across the grounding/honesty
    // guards below (ghost-promise, fabricated-save, read-failure, provenance,
    // fact-critic) so one turn can't rewrite the already-streamed reply over
    // and over. The synthesis nudge is deliberately NOT counted — it fills a
    // blank/meta turn rather than churning visible content. Default 1.
    // VOICE turns get ZERO content re-rolls: every guard below (ghost-promise,
    // fabricated-save, read-failure, provenance, fact-critic) re-streams a fresh
    // reply when it fires, so on the spoken path the user HEARS the first reply
    // then the rewrite ("regenerates multiple times"). Worse, the ghost-promise
    // guard fires on exactly the voice persona's intended acknowledgment ("let me
    // check") — a false positive every turn. Voice grounding is the pre-injection
    // + the round-0 forced tool, not post-hoc rewrites; re-rolls are also
    // latency-prohibitive spoken. (provenance/fact-critic were already voice-gated
    // via _mode_a==='conversation'; this also covers ghost/save/read in one place.)
    //
    // NARRATIVE chat turns get ZERO for the same structural reason (2026-07-27,
    // `narrative: true` in the persona). The policy — including why it's chat-
    // only — lives in content_reroll_budget above. Zeroing the budget is also
    // what makes this cheap rather than merely quiet: data-denial, semantic
    // fabricated-save and fact-critic each gate on `rerolls_used < max_rerolls`
    // BEFORE calling their LLM judge, so a suppressed turn skips those calls
    // entirely. The synthesis nudge never consumed the budget, so a blank or
    // meta-only turn after tool calls is still recovered.
    const max_rerolls = content_reroll_budget(_mode_a, specialist.narrative === true);
    // Tool-channel guards run on their own budget + latch so a narrative
    // specialist (whose content budget is 0 by design) still gets caught
    // claiming a tool ran. See tool_channel_reroll_budget().
    const max_tool_channel_rerolls = tool_channel_reroll_budget(_mode_a);
    let tool_channel_retried = false;
    let rerolls_used = 0;
    // Build the turn's grounding corpus on demand — the union of every
    // tool result so far, the conversation history, the user's message,
    // and the retrieved library section. Recomputed at each use because
    // tool_calls_made grows during the loop. Deliberately excludes the
    // system prompt (whose grounding-rule block literally contains the
    // "E-23734" worked example) and tool INPUTS (a fabricated id passed
    // as a search arg must not ground itself).
    const compute_turn_grounding = (): GroundingContext =>
      build_grounding_context({
        tool_results: tool_calls_made.map((c) =>
          typeof c.result === 'string'
            ? c.result
            : c.result !== undefined
              ? JSON.stringify(c.result)
              : '',
        ),
        history: input.conversation_history.map((m) => m.content),
        user_message: input.message.content,
        retrieved: rag_section ? [rag_section] : [],
        verified: verified_blocks,
      });
    // Readable evidence (same sources, un-normalized) for the semantic
    // fact critic — it reasons over casing/punctuation the squashed
    // grounding form discards. See src/core/fact_critic.ts.
    // Evidence for the semantic fact critic. Tool results are ordered
    // NEWEST-FIRST (reverse of chronological append) because the critic
    // truncates evidence to a char budget — on a heavy multi-fetch turn
    // (Kristi/Ruby run 20-40 tool calls) the model most likely cited its
    // LATEST findings, so those must survive the cut, not the stalest first
    // fetch. Order doesn't affect correctness (it's a containment check),
    // only what survives truncation. Paired with the raised
    // HEARTH_FACT_CRITIC_EVIDENCE_CHARS budget in fact_critic.ts.
    const compute_turn_evidence = (): string =>
      build_grounding_evidence({
        tool_results: tool_calls_made
          .slice()
          .reverse()
          .map((c) =>
            typeof c.result === 'string'
              ? c.result
              : c.result !== undefined
                ? JSON.stringify(c.result)
                : '',
          ),
        history: input.conversation_history.map((m) => m.content),
        user_message: input.message.content,
        retrieved: rag_section ? [rag_section] : [],
        verified: verified_blocks,
      });

    const tool_round_ceiling = resolve_tool_round_ceiling(specialist, {
      mode: input.llm_role === 'specialist_deliberation' ? 'deliberation' : 'chat',
      ...(input.tool_rounds_override != null ? { override: input.tool_rounds_override } : {}),
    });
    // Actual outer-loop iterations executed. Distinct from
    // tool_calls_made.length, which counts individual tool calls (one
    // round can emit several parallel tool calls). The exhaustion
    // classifier and the blank-turn audit must compare ROUNDS against
    // the round ceiling, never tool-call count — otherwise a turn that
    // ran 4 rounds with broad parallel fan-out gets misreported as
    // "burned the whole budget."
    let rounds_used = 0;
    // Cumulative tool-result budget for this turn. Bounds the SUM of
    // accumulated tool output so a multi-round research loop can't grow
    // the prompt past the backing server's context window (per-tool
    // compaction caps each result; this caps the total). Sized from the
    // role's declared window, falling back to the conservative default.
    // The COHERENCE target — how much context the model still reasons well
    // over. Sizes the cumulative tool-result budget, which is a quality knob:
    // it decides how much tool output is worth carrying, not what the server
    // will accept.
    const coherence_target_tokens =
      resolved.context_window_tokens ?? TOOL_CONTEXT_DEFAULT_WINDOW_TOKENS;
    // The HARD bound the prompt trimmer enforces — what the server physically
    // takes. These are the same number only when a role declares one; on the
    // interactive lane they differ 3x (16384 coherence vs a 49152 slot), and
    // trimming against the coherence number is what made 351 of 353 audited
    // turns cry `still_over` while 288 of them had nothing to evict.
    const prompt_window_tokens =
      resolved.max_prompt_tokens ?? coherence_target_tokens;
    // Room the payload must LEAVE inside that window: the generation budget the
    // server has to have space to emit, the tool SCHEMAS (they ride the request
    // but live in `tool_defs`, not in `messages`), and fixed slack for the chat
    // template. Computed once — `tool_defs` is fully assembled by here, and the
    // per-round `narrowed_tools` only ever filters it down.
    const prompt_reserve_tokens =
      (resolved.defaults.max_tokens ?? 1024) +
      Math.ceil(JSON.stringify(tool_defs).length / TOOL_CONTEXT_CHARS_PER_TOKEN) +
      // Slack scales with the window (2026-08-03). Every deep role declares its
      // ENTIRE per-slot size, so at the top of a 49k slot a flat 1024 left 1.6%
      // of cover for a chars-per-token estimate whose error grows with the
      // payload. Kristi's prompt reached 49393 against a 49152 slot on
      // 2026-08-02 and 400'd — missing by 0.5%.
      prompt_window_slack_for(prompt_window_tokens);
    // The cumulative tool-result budget must fit UNDER what the non-evictable
    // payload already occupies (2026-08-05). Sizing it from the coherence
    // window alone let a history-less deliberation turn accumulate ~70k chars
    // of tool results on top of a ~20k-token static payload — the trimmer has
    // NOTHING to evict on those turns (no conversation history), so rounds
    // 6-17 marched straight through `still_over` into a server 400 (Ruby, six
    // slots a day, 2026-08-04/05). The system prompt + non-evictable tail are
    // known exactly here; give tool results only the room that actually
    // remains, floored so a research turn can still function at all (when the
    // floor binds, the static payload is the problem and the OVER BUDGET log
    // already names it).
    const _non_evictable_est = estimate_prompt_tokens([
      messages[0]!,
      ...messages.slice(history_end),
    ]);
    const tool_budget_chars = Math.max(
      8_000,
      Math.min(
        tool_budget_chars_for_window(coherence_target_tokens),
        Math.floor(
          (Math.max(0, prompt_window_tokens - prompt_reserve_tokens) - _non_evictable_est) *
            TOOL_CONTEXT_CHARS_PER_TOKEN,
        ),
      ),
    );
    // Forced-fetch gate (2026-06): on a VOICE lookup turn, force a tool call on
    // the FIRST round so a stochastic model can't answer a weather/traffic/
    // status/price query from memory — the omission-fabrication backstop for the
    // dynamic data we don't pre-inject (calendar is already pre-injected via
    // kate_pack). Round 0 only; once a tool runs the model answers from the
    // result. `tool_choice:'required'` is guided-decoded on both backends with
    // think-OFF (verified); a no-op if a backend ignores it.
    const force_first_tool =
      (input.require_tool_call === true && tool_defs.length > 0) ||
      (use_stream &&
        input.surface === 'voice' &&
        tool_defs.length > 0 &&
        _looks_like_lookup(input.message.content) &&
        // ...but NOT when kate_pack already pre-injected this signal's reading this
        // turn (e.g. EV charge). Forcing then is a redundant 2nd llm round + the
        // double-grounding repeat — the model answers in one round from the prompt.
        !_lookup_preinjected(input.message.content, verified_blocks));

    // Actionable-intent forcing (2026-06-20 record/attribute; 2026-06-21 extended
    // to schedule + remind; 2026-06-26 extended to VOICE + the emergency self-test):
    // a chat OR VOICE turn whose message is a CLEAR "act on this" instruction
    // (detect_actionable_intent) forces the matching tool — a stochastic model
    // otherwise acknowledges ("Noted" / "Test fired") and never calls it (the
    // fabricated-save / dropped-promise / fabricated-action class). Reuses the
    // proven tool_choice:'required' mechanism, narrowed to that one tool on the
    // round. CRITICAL on voice: the reply streams to TTS as it generates and voice
    // gets 0 re-rolls, so a post-hoc fabricated-action guard CANNOT catch it (Kate
    // already SPOKE the fabrication) — round-0 forcing is the only place to
    // PREVENT it. Gated PER GROUP + fail-open: record/attribute honors
    // HEARTH_RECORD_INTENT_FORCE (live), schedule + remind HEARTH_INTENT_FORCE
    // (dark), the emergency self-test HEARTH_EMERGENCY_INTENT_FORCE (guard family,
    // default-ON) — intent_force_enabled_for(tool) resolves which. Only when the
    // tool is already on this turn's surface (or injectable from the catalog); an
    // unarmed group → byte-identical. Round 0 forces it; the #4 intent-miss guard
    // can re-arm `pending_force_tool` for a later round (chat only — voice has no
    // re-roll budget, so its single shot is the round-0 force).
    let intent_force_tool: string | null = null;
    if ((_mode_a === 'conversation' || _mode_a === 'voice') && !input.tools_override) {
      const ri = detect_actionable_intent(input.message.content);
      if (ri && intent_force_enabled_for(ri.tool)) {
        // The target tool must be on THIS turn's surface for the round-0 force to
        // emit it. With dynamic_tools the message-RAG often doesn't rank a write
        // tool into the hot set (verified live: a "schedule X Thursday" turn left
        // schedule_calendar_event off the surface), which would make forcing
        // silently fall open. Inject its schema from the granted catalog (the
        // load_tools path) so a detected intent reliably forces.
        let on_surface = tool_defs.some((t) => t.name === ri.tool);
        if (!on_surface) {
          const t = catalog.find((c) => c.name === ri.tool);
          if (t) {
            tool_defs.push(to_tooldef(t));
            hotNames.add(t.name);
            on_surface = true;
          }
        }
        if (on_surface) {
          intent_force_tool = ri.tool;
          this.deps.memory.log_action({
            intent_id,
            agent: specialist.id,
            user_id: input.user?.id,
            tool_name: 'intent_force',
            tool_input: { tool: ri.tool, reason: ri.reason, preview: input.message.content.slice(0, 160) },
          });
        }
      }
    }
    let pending_force_tool: string | null = null;

    // Whether this turn streams its reply tokens to the client live. Voice
    // MUST stream (the openai_shim consumes message_token to feed streaming
    // TTS) — and voice gets 0 re-rolls, so it never rewrites. Research turns
    // stream live (buffering a 4000-token reply would kill the streaming win)
    // and absorb the rare re-roll via a clean message_superseded swap. Every
    // OTHER chat turn HOLDS BACK: its reply is withheld from the live stream
    // and delivered via message_added once the finalize guards pass, so a
    // guard re-roll never re-types a visible draft (the "mid-message rewrite"
    // class). The per-round `emit_content_live` gate below applies this.
    const stream_live =
      input.surface === 'voice' || specialist.proactive.research_workload === true;

    // Unified finalize-guard pipeline. Collapses the ghost-promise /
    // fabricated-save / fabricated-action / read-failure / data-denial /
    // citation / provenance / fact-critic / synthesis guards into ONE ordered
    // pass with a SINGLE re-roll path: push the rejected reply + the nudge,
    // audit, optionally tell the client the shown draft is superseded, and
    // re-enter the loop. Returns true when a guard fired (caller continues),
    // false when the reply passed (caller finalizes). brief_critic (envelope
    // level), status_flavor (cosmetic), persisted_fabrication_block (vetoes a
    // write) and detect_stale_self_denials (prompt setup) are deliberately NOT
    // here — different lifecycle. Adding a guard is one block in this function.
    const run_reply_guards = async (
      reply: string,
      thinking: string,
      round: number,
      // Non-null when a live draft under this stream_id was shown this round;
      // on a re-roll we tell the client to drop it (the graceful swap) rather
      // than letting the next round wipe-and-retype it.
      superseded_stream_id: string | null,
    ): Promise<boolean> => {
      const audit = (
        tool_name: string,
        extra_input: Record<string, unknown> = {},
        extra_result: Record<string, unknown> = {},
      ) => {
        const audit_id = this.deps.memory.log_action({
          intent_id,
          agent: specialist.id,
          user_id: input.user?.id,
          tool_name,
          tool_input: { round, reply_preview: reply.slice(0, 240), streaming: use_stream, ...extra_input },
          execution_result: { retry_triggered: true, ...extra_result },
        });
        // Instant-feedback edge signal (Workstream A). Every finalize-guard catch
        // here is an honesty/quality miss; emit a fail-open quality_signal so the
        // GuardFeedbackDriver can aggregate recurrences → process_miss + a scoped
        // Beatrice wake. The audit row above is the durable count source; this
        // event only makes the feedback INSTANT. Never let it perturb the turn.
        try {
          this.deps.events?.emit({
            type: 'quality_signal',
            specialist_id: specialist.id,
            signal_class: 'honesty',
            guard: tool_name,
            detail: reply.slice(0, 240),
            conversation_id: input.conversation_id,
            ...(input.user?.id ? { user_id: input.user.id } : {}),
          });
        } catch {
          /* fail-open — the signal is best-effort, the audit row is authoritative */
        }
        return audit_id;
      };
      const reroll = (nudge: string, assistant: string = reply) => {
        messages.push({ role: 'assistant', content: assistant });
        messages.push({ role: 'user', content: nudge });
        if (superseded_stream_id) {
          this.deps.events?.emit({
            type: 'message_superseded',
            conversation_id: input.conversation_id,
            specialist_id: specialist.id,
            stream_id: superseded_stream_id,
          });
        }
      };

      // Shell safety (2026-07-25) — a shell command handed to the owner is an
      // EFFECT with no approval gate: he pastes it and it runs as root. Runs
      // FIRST because the harm is the largest in the pipeline and it must not be
      // preempted by a guard that spends the shared re-roll budget. Trips on a
      // destructive verb that isn't both targeted AND blast-radius-stated, or on
      // an absolute path in a command block that appears nowhere in the turn's
      // tool evidence (the invented `/opt/plex` class). Deterministic, cheap
      // (no-op when the reply has no command block), own latch, kill-switchable.
      if (!shell_safety_retried && rerolls_used < max_rerolls && shell_safety_guard_enabled()) {
        const shell = assess_shell_safety({ reply, evidence: compute_turn_evidence() });
        if (shell.needs_retry) {
          shell_safety_retried = true;
          rerolls_used++;
          reroll(shell_safety_retry_nudge(shell.findings));
          audit('shell_safety_guard', {
            findings: shell.findings.map((f) => `${f.kind}:${f.command}`).slice(0, 8),
            blast_radius_stated: shell.blast_radius_stated,
          });
          return true;
        }
      }
      // Ghost-promise — promise language with no backing tool / scheduled
      // followup. Shares the ghost latch with the two fabrication guards
      // below so the turn retries at most once across all three.
      const ghost_nudge = _detect_ghost_promise(
        reply,
        tool_calls_made,
        ghost_promise_retried || rerolls_used >= max_rerolls,
        thinking,
        this.deps.specialists.list(),
      );
      if (ghost_nudge) {
        ghost_promise_retried = true;
        rerolls_used++;
        reroll(ghost_nudge);
        audit('ghost_promise_guard');
        return true;
      }
      // Intent miss (#4) — a clear "act on this" instruction was detected
      // (intent_force_tool) but the matching tool never fired this turn. Re-roll
      // FORCING the tool (pending_force_tool narrows + 'required' next round) — a
      // text nudge alone is exactly what the small model ignored. Backstops #3
      // when a backend ignores round-0 'required'. Shares the latch.
      if (
        intent_force_tool != null &&
        !ghost_promise_retried &&
        rerolls_used < max_rerolls &&
        !tool_calls_made.some((c) => c.name === intent_force_tool) &&
        tool_defs.some((t) => t.name === intent_force_tool)
      ) {
        ghost_promise_retried = true;
        rerolls_used++;
        pending_force_tool = intent_force_tool;
        reroll(
          `[INTENT GUARD — internal system note, not from the user]\n\n` +
            `You were asked to act on this, but the \`${intent_force_tool}\` tool never ` +
            `ran — so nothing happened. Call \`${intent_force_tool}\` now with the ` +
            `details from the conversation. Don't just acknowledge; the action only ` +
            `happens through the tool.`,
        );
        audit('intent_miss_guard', { tool: intent_force_tool });
        return true;
      }
      // Save-honesty — a write tool was ATTEMPTED but FAILED (hard error /
      // soft {error} result / DUPLICATE / validation) with nothing durable
      // landing, yet the reply claims the save completed ("Got it, I've noted
      // it"). Runs BEFORE fabricated-save so the attempted-but-failed case gets
      // the right nudge ("your save didn't land"), not the nothing-ran one.
      // Shares the ghost latch + re-roll budget; own kill switch.
      const failed_save_nudge =
        ghost_promise_retried || rerolls_used >= max_rerolls || !save_honesty_guard_enabled()
          ? null
          : _detect_failed_save(reply, tool_calls_made, this.deps.tools);
      if (failed_save_nudge) {
        ghost_promise_retried = true;
        rerolls_used++;
        reroll(failed_save_nudge);
        audit('save_honesty_guard');
        return true;
      }
      // Fabricated-save — claims a durable write but no write-tier tool fired.
      const save_nudge =
        ghost_promise_retried || rerolls_used >= max_rerolls
          ? null
          : _detect_fabricated_save(reply, tool_calls_made, this.deps.tools);
      if (save_nudge) {
        ghost_promise_retried = true;
        rerolls_used++;
        reroll(save_nudge);
        audit('fabricated_save_guard');
        return true;
      }
      // Fabricated-action — claims a completed peer/external action with no
      // tool behind it. Shares the ghost latch.
      const action_nudge =
        ghost_promise_retried || rerolls_used >= max_rerolls
          ? null
          : _detect_fabricated_action(
              reply,
              tool_calls_made,
              this.deps.tools,
              all_persona_names(this.deps.specialists.list()),
            );
      if (action_nudge) {
        ghost_promise_retried = true;
        rerolls_used++;
        reroll(action_nudge);
        audit('fabricated_action_guard');
        return true;
      }
      // Folded-name — attributes work to a persona the owner has no room for.
      // Deliberately AFTER fabricated-action (a claim with no tool behind it is
      // the bigger failure and its nudge is more specific) and deliberately NOT
      // exempted by a real tool call: an honest delegation reported under a
      // folded name is still a dead end to the owner. Shares the ghost latch.
      const folded_nudge =
        ghost_promise_retried || rerolls_used >= max_rerolls
          ? null
          : _detect_folded_name(reply, unattributable_names(this.deps.specialists.list()));
      if (folded_nudge) {
        ghost_promise_retried = true;
        rerolls_used++;
        reroll(folded_nudge);
        audit('folded_name_guard');
        return true;
      }
      // ── Tool-channel guards ────────────────────────────────────────────
      // These three run on `tool_channel_retried` / `max_tool_channel_rerolls`
      // rather than the shared content budget, because that budget is 0 for a
      // narrative specialist and these checks carry no fiction false-positive
      // risk — they compare a minted filename or a registered tool name
      // against the turn's actual calls. One re-roll per turn across all three.
      const tool_channel_spent = tool_channel_retried || max_tool_channel_rerolls <= 0;
      // Fabricated-image — embeds a generated-image link the tool never minted.
      const image_nudge = tool_channel_spent
        ? null
        : _detect_fabricated_image(reply, tool_calls_made);
      if (image_nudge) {
        tool_channel_retried = true;
        reroll(image_nudge);
        audit('fabricated_image_guard');
        return true;
      }
      // Unplaced-image — generate_image landed but the markdown line never
      // made it into the reply, so nothing renders.
      const unplaced_nudge = tool_channel_spent
        ? null
        : _detect_unplaced_image(reply, tool_calls_made);
      if (unplaced_nudge) {
        tool_channel_retried = true;
        reroll(unplaced_nudge);
        audit('unplaced_image_guard');
        return true;
      }
      // Narrated-tool-call — the reply TYPES an invocation, or claims a tool
      // ran, with nothing on the tool channel.
      const narrated_nudge = tool_channel_spent
        ? null
        : _detect_narrated_tool_call(reply, tool_calls_made, this.deps.tools);
      if (narrated_nudge) {
        tool_channel_retried = true;
        reroll(narrated_nudge);
        audit('narrated_tool_call_guard');
        return true;
      }
      // Read-failure honesty (1b) — a read failed this turn and never
      // recovered, but the reply answers over it. Own latch, kill-switchable.
      const read_failure_nudge =
        read_failure_retried || rerolls_used >= max_rerolls || !read_failure_guard_enabled()
          ? null
          : _detect_unrecovered_read_failure(reply, tool_calls_made);
      if (read_failure_nudge) {
        read_failure_retried = true;
        rerolls_used++;
        reroll(read_failure_nudge);
        audit('read_failure_guard');
        return true;
      }
      // Data-denial — claims data is absent with no query to back it. LLM
      // judge on candidates only; conversation-only; own latch; fail-open.
      if (
        _mode_a === 'conversation' &&
        data_denial_guard_enabled() &&
        !data_denial_retried &&
        rerolls_used < max_rerolls
      ) {
        const denial_read_tools = data_read_tools(catalog, this.deps.tools);
        const { unverified } = await assess_data_denial({
          reply,
          tool_calls: tool_calls_made,
          read_tools: denial_read_tools,
          llm: this.deps.llm,
        });
        if (unverified.length > 0) {
          data_denial_retried = true;
          rerolls_used++;
          reroll(data_denial_retry_nudge(unverified, denial_read_tools));
          audit('data_denial_guard', {
            unverified: unverified.map((f) => f.claim.slice(0, 120)).slice(0, 6),
          });
          return true;
        }
      }
      // Fabricated-save (SEMANTIC) — the LLM-judge backstop for the save-claims
      // the strict regex `_detect_fabricated_save` MISSES ("Noted — X is Y", "her
      // phone is recorded" — no "…to/in <target>" tail). Conversation-only; shares
      // the ghost latch; runs only when a save verb is present AND no write fired;
      // fail-open. NOT a forced tool_choice — the SAME plain re-prompt, so the
      // model catches its own claim and (being capable) usually calls the tool.
      if (
        _mode_a === 'conversation' &&
        fabricated_save_semantic_enabled() &&
        !ghost_promise_retried &&
        rerolls_used < max_rerolls &&
        looks_like_save_claim(reply) &&
        !_had_durable_write(tool_calls_made, this.deps.tools)
      ) {
        const verdict = await assess_fabricated_save({
          reply,
          ledger: tool_calls_made.map((c) => c.name).join(', ') || '(none)',
          llm: this.deps.llm,
        });
        if (verdict.fabricated) {
          ghost_promise_retried = true;
          rerolls_used++;
          reroll(fabricated_save_retry_nudge(verdict.item));
          audit('fabricated_save_guard', { semantic: true, item: verdict.item.slice(0, 120) });
          return true;
        }
      }
      // Provenance / citation / fact-critic — share the provenance latch and
      // the conversation-only gate; at most one of the three fires per turn.
      // Citation is deterministic + cheap so it runs first; provenance is the
      // regex layer; the semantic fact-critic catches the named-entity / date
      // / figure fabrications the regex is blind to (else-if: only when the
      // regex pass found nothing enforced). All fail-open.
      if (_mode_a === 'conversation' && !provenance_retried && rerolls_used < max_rerolls) {
        if (cite_mode && turn_sources.length > 0) {
          const cite_findings = verify_citations(reply, turn_sources);
          if (cite_findings.length > 0) {
            provenance_retried = true;
            rerolls_used++;
            carried_findings = cite_findings.map((f) => ({
              claim: f.claim,
              kind: f.kind,
              from: 'citation' as const,
            }));
            reroll(citation_retry_nudge(cite_findings));
            audit('citation_guard', {
              findings: cite_findings.map((f) => `${f.kind}:${f.claim}`).slice(0, 8),
            });
            return true;
          }
        }
        const grounding = compute_turn_grounding();
        const all_ungrounded = find_ungrounded_claims(reply, grounding);
        const enforced = all_ungrounded.filter((c) => PROVENANCE_POLICY[c.kind] === 'enforce');
        if (provenance_guard_enabled() && enforced.length > 0) {
          provenance_retried = true;
          rerolls_used++;
          carried_findings = enforced.map((c) => ({
            claim: c.text,
            kind: c.kind,
            from: 'provenance' as const,
          }));
          reroll(provenance_retry_nudge(all_ungrounded));
          audit('provenance_guard', {
            ungrounded: enforced.map((c) => `${c.kind}:${c.text}`).slice(0, 10),
          });
          return true;
        } else if (fact_critic_enabled()) {
          const { unsupported } = await assess_factual_grounding({
            reply,
            grounding,
            evidence_text: compute_turn_evidence(),
            llm: this.deps.llm,
            // Ground the specialist's OWN identity (name, role, office/pane,
            // held tools) so self-references aren't flagged as fabrications.
            self_identity: build_self_identity(
              specialist,
              this.deps.tools.list_for_capabilities(specialist.granted).map((t) => t.name),
              this.deps.specialists.list().map((s) => ({ id: s.id, name: s.name })),
            ),
          });
          if (unsupported.length > 0) {
            provenance_retried = true;
            rerolls_used++;
            carried_findings = unsupported.map((f) => ({
              claim: f.claim,
              kind: f.kind,
              from: 'fact_critic' as const,
            }));
            // Phase-3 async librarian lane: fetch the questioned claims on the
            // A4000 and ground the retry in real sources rather than only
            // flagging them ungrounded. Gated + fail-open + recursion-guarded.
            let critic_nudge = fact_critic_retry_nudge(unsupported);
            let librarian_used = false;
            if (async_librarian_enabled() && !input.provider_role) {
              const findings = await this._librarian_verify(unsupported, input);
              if (findings) {
                critic_nudge = librarian_findings_nudge(unsupported, findings);
                librarian_used = true;
              }
            }
            reroll(critic_nudge);
            audit(
              'fact_critic',
              { unsupported: unsupported.map((f) => `${f.kind}:${f.claim}`).slice(0, 10) },
              { librarian_lane: librarian_used },
            );
            return true;
          }
        }
      }
      const _text = reply.trim();
      const meta_only = _text.length > 0 && _text.length < 200 && META_INTENT_PATTERN.test(_text);

      // ── ESCALATE ON EVIDENCE (2026-08-05) ──────────────────────────────
      // Every guard above has now had its say, and — critically — has had its
      // say TWICE on any reply that reaches here with `carried_findings`
      // populated or `synthesis_nudged` set. This is the only place in the
      // pipeline that can see a correction FAIL, because the guards that would
      // fire again are gated on `rerolls_used < max_rerolls` and stood down.
      //
      // Deliberately sits AFTER the grounding guards (a first-time finding
      // deserves the cheap fast-tier correction before anything expensive) and
      // BEFORE the synthesis nudge (whose latch would otherwise swallow the
      // second blank reply and finalize it). Costs nothing on a turn with no
      // carried findings: one array-length check.
      //
      // What it does NOT escalate is documented at length in escalation.ts —
      // tool spirals, denials, missed tool calls and shell-safety catches all
      // reach this line and all fall through, because none of them is evidence
      // that more reasoning was the missing ingredient.
      if (
        _mode_a === 'conversation' &&
        escalation_mode() !== 'off' &&
        !input.tools_override &&
        (carried_findings.length > 0 || synthesis_nudged)
      ) {
        const evidence = detect_escalation_evidence({
          reply,
          carried: carried_findings,
          grounding: compute_turn_grounding(),
          synthesis_nudged,
          reply_blank_or_meta: _text.length === 0 || meta_only,
          had_tool_calls: tool_calls_made.length > 0,
        });
        // The tool has to be REACHABLE, not merely granted: with dynamic tool
        // surfaces the message-RAG routinely leaves consult_deep_model out of
        // the hot set, so check the catalog and inject the schema the same way
        // the intent-force path does below.
        const on_surface = tool_defs.some((t) => t.name === ESCALATION_TOOL);
        const injectable = catalog.find((c) => c.name === ESCALATION_TOOL);
        const verdict = escalation_decision({
          evidence,
          mode: escalation_mode(),
          turn_elapsed_ms: Date.now() - turn_started_ms,
          tool_available: on_surface || injectable !== undefined,
          already_escalated: escalated_once,
        });
        if (evidence) {
          this.deps.memory.log_action({
            intent_id,
            agent: specialist.id,
            user_id: input.user?.id,
            tool_name: 'escalate_on_evidence',
            tool_input: {
              round,
              trigger: evidence.trigger,
              unresolved: evidence.unresolved,
              carried_from: evidence.carried_from,
              rounds_used,
              tool_calls: tool_calls_made.map((c) => c.name).slice(0, 12),
              turn_elapsed_ms: Date.now() - turn_started_ms,
              message_preview: input.message.content.slice(0, 160),
              reply_preview: reply.slice(0, 240),
            },
            execution_result: {
              mode: escalation_mode(),
              escalated: verdict.escalate,
              declined_reason: verdict.declined_reason,
              inflight: verdict.inflight,
              budget_ms: escalation_budget_ms(),
            },
          });
        }
        if (verdict.escalate) {
          escalated_once = true;
          escalation_release = verdict.release;
          if (!on_surface && injectable) {
            tool_defs.push(to_tooldef(injectable));
            hotNames.add(injectable.name);
          }
          // Bound the deep leg by the escalation budget, not by deep_consult's
          // 300s. Cancelling the turn still cancels it — whichever fires first.
          escalation_signal = input.signal
            ? AbortSignal.any([input.signal, AbortSignal.timeout(escalation_budget_ms())])
            : AbortSignal.timeout(escalation_budget_ms());
          pending_force_tool = ESCALATION_TOOL;
          // The user is about to wait again. Chat holds its draft back
          // (`stream_live` false), so nothing they've seen changes — but the
          // indicator must stop claiming the turn is nearly done.
          this.deps.events?.emit({
            type: 'specialist_status',
            specialist_id: specialist.id,
            conversation_id: input.conversation_id,
            status: `${specialist.name} is thinking this one through on the deep model…`,
            ttl_seconds: Math.ceil(escalation_budget_ms() / 1000),
          });
          reroll(escalation_nudge(evidence!));
          return true;
        }
      }

      // Synthesis nudge — the loop exited with empty / meta-only content but
      // tools DID run; the results are in `messages` and the user is still
      // waiting on the substance. NOT a fabrication guard: own latch, does
      // NOT consume the re-roll budget (it fills a blank turn rather than
      // churning visible content). Fires at most once per turn.
      if ((_text.length === 0 || meta_only) && tool_calls_made.length > 0 && !synthesis_nudged) {
        synthesis_nudged = true;
        reroll(
          `[SYNTHESIS NUDGE — internal system note, not from the user]\n\n` +
            `Your previous reply ${
              _text.length === 0
                ? 'was empty'
                : `only stated intent ("${_text.slice(0, 80)}${_text.length > 80 ? '…' : ''}")`
            }. You executed ${tool_calls_made.length} tool ` +
            `call${tool_calls_made.length === 1 ? '' : 's'} above; the ` +
            `results are in this conversation. The user is still ` +
            `waiting on the actual answer. Write the substantive reply ` +
            `now — what did you find, what do you recommend, what's the ` +
            `answer? Use your normal voice. If you truly don't have ` +
            `enough information after the tools you ran, say what you ` +
            `tried and ask the user a specific clarifying question. ` +
            `Don't restate intent; deliver the substance.`,
          reply || '...',
        );
        this.deps.memory.log_action({
          intent_id,
          agent: specialist.id,
          user_id: input.user?.id,
          tool_name: 'synthesis_nudge_fired',
          tool_input: {
            round,
            streaming: use_stream,
            reason: _text.length === 0 ? 'empty_content' : 'meta_only',
            meta_preview: _text.slice(0, 240),
            tool_count: tool_calls_made.length,
          },
          execution_result: { retry_triggered: true },
        });
        return true;
      }
      return false;
    };

    /** Tools retired by the spiral guard for the remainder of THIS turn. A
     *  retired tool is refused at dispatch instead of ending the pass, so the
     *  model keeps its remaining rounds and everything it already retrieved. */
    const disabled_tools = new Set<string>();

    outer: for (let round = 0; round < tool_round_ceiling; round++) {
      if (input.signal?.aborted) {
        // Pre-call cancel: the signal fired before we issued this round's
        // completion. Record a clean cancel (ported from the non-streaming
        // path) and stop with a stopped-message rather than a noisy fallback.
        this.deps.memory.log_action({
          intent_id,
          agent: specialist.id,
          user_id: input.user?.id,
          tool_name: 'turn_cancelled',
          tool_input: { round, conversation_id: input.conversation_id, streaming: use_stream, pre_call: true },
        });
        final_text = '(stopped)';
        break outer;
      }
      rounds_used = round + 1;
      const stream_id = `stream:${intent_id}:r${round}`;
      // Hold-back gate: stream this round's reply tokens live only when the
      // turn streams at all (use_stream), on a streaming surface (stream_live),
      // AND before any re-roll. Once a guard re-rolls (rerolls_used > 0) the
      // redo is withheld and delivered via the route's message_added, so the
      // client never wipe-and-retypes a draft. Hold-back turns (stream_live
      // false) and non-streaming shim turns (use_stream false) never emit live
      // and never emit message_superseded; their reply arrives once via
      // message_added when the guards pass.
      const emit_content_live = use_stream && stream_live && rerolls_used === 0;
      let resp_done: import('./llm').LLMResponse | null = null;
      // Keep the accumulated tool results under budget before every
      // completion call — the exact point the payload is sent, so it's
      // bounded no matter how the loop grew. Cheap no-op when under.
      {
        const trimmed = enforce_cumulative_tool_budget(messages, tool_budget_chars);
        if (trimmed.compressed > 0) {
          this.deps.memory.log_action({
            intent_id,
            agent: specialist.id,
            user_id: input.user?.id,
            tool_name: 'tool_context_trimmed',
            tool_input: {
              round,
              compressed: trimmed.compressed,
              before_chars: trimmed.before,
              after_chars: trimmed.after,
              budget_chars: tool_budget_chars,
            },
          });
        }
      }
      // ...and keep the WHOLE payload inside the resolved provider's window.
      // The budget above only bounds tool output; a long thread (or a
      // complexity-gate escalation onto a smaller-window provider) overflows on
      // conversation history alone. Evicts oldest history only — never the
      // persona, the live user turn, or a tool_call/tool_result pair.
      {
        const fitted = enforce_prompt_window(messages, {
          window_tokens: prompt_window_tokens,
          reserve_tokens: prompt_reserve_tokens,
          evictable: { start: 1, end: history_end },
        });
        history_end -= fitted.dropped;
        if (fitted.dropped > 0 || fitted.still_over) {
          this.deps.memory.log_action({
            intent_id,
            agent: specialist.id,
            user_id: input.user?.id,
            tool_name: 'prompt_window_trimmed',
            tool_input: {
              round,
              dropped: fitted.dropped,
              before_tokens: fitted.before_tokens,
              after_tokens: fitted.after_tokens,
              budget_tokens: fitted.budget_tokens,
              window_tokens: prompt_window_tokens,
              provider_role: input.provider_role ?? effective_role,
              still_over: fitted.still_over,
              // The COHERENCE view, recorded alongside the hard-bound one.
              // Kate runs ~19k against a 16384 coherence target on ordinary
              // turns — already past the number, nowhere near the 49152 slot.
              // Logging both is what turns "we are over" into a question with
              // an answer: over WHAT, and does it mean a 400 or a worse reply?
              coherence_target_tokens,
              over_coherence: fitted.after_tokens > coherence_target_tokens,
              // WHY it's over — the field that makes these rows triageable.
              // `static_prompt` = nothing was evictable, the floor itself busts
              // the budget. `history` = the thread genuinely no longer fits.
              // `fitted` = trimming worked.
              over_reason: !fitted.still_over
                ? 'fitted'
                : fitted.dropped === 0
                  ? 'static_prompt'
                  : 'history',
            },
          });
        }
        // Over budget with nothing left to cut — but there are TWO ways to land
        // here and they call for opposite responses, so name which one it is.
        //
        // `dropped: 0` means the trimmer was IMPOTENT, not exhausted: the
        // non-evictable payload (persona + tool schemas + this turn) exceeds the
        // budget on its own, so no amount of history eviction could ever have
        // helped. That is an architecture signal — the STATIC prompt is too big
        // — and it is what 288 of 351 rows over 2026-08-01..03 actually were,
        // every one logged under a message reading "history exhausted". The old
        // wording sent a reader hunting for a long thread that did not exist.
        if (fitted.still_over) {
          const impotent = fitted.dropped === 0;
          console.error(
            `[prompt-window] ${specialist.id} round${round} OVER BUDGET ` +
              `(${impotent ? 'STATIC PROMPT TOO BIG — nothing was evictable' : 'history exhausted'}): ` +
              `~${fitted.after_tokens} tok vs budget ${fitted.budget_tokens} ` +
              `(window ${prompt_window_tokens}, reserve ${prompt_reserve_tokens}, ` +
              `dropped ${fitted.dropped}, role ${input.provider_role ?? effective_role})` +
              (impotent
                ? ' — trim the persona/tool surface, not the thread'
                : ' — the thread itself no longer fits'),
          );
        }
      }
      // Per-round forced intent tool: round 0 from the detector, a later round
      // re-armed by the #4 intent-miss guard. Narrow the round to just that tool
      // so tool_choice:'required' forces EXACTLY it (not some other hot tool).
      // Consumed once; falls back to the full surface if the tool isn't present.
      const force_record_round = round === 0 ? intent_force_tool : pending_force_tool;
      pending_force_tool = null;
      const narrowed_tools = force_record_round
        ? tool_defs.filter((t) => t.name === force_record_round)
        : null;
      const tools_for_req = narrowed_tools && narrowed_tools.length ? narrowed_tools : tool_defs;
      // Shared request shape for both the streaming and non-streaming paths.
      const req: import('./llm').LLMRequest = {
        messages,
        tools: tools_for_req,
        temperature: resolved.defaults.temperature ?? 0.7,
        // Streaming chat defaults to think-OFF preservation; non-streaming
        // callers (consult / deliberation / librarian via the turn() shim)
        // keep the historical `?? true` so their reasoning trace survives.
        // Preserves the pre-merge per-path behaviour.
        preserve_thinking: resolved.defaults.preserve_thinking ?? (use_stream ? false : true),
        ...(input.think_override !== undefined
          ? { think: input.think_override }
          : resolved.defaults.think !== undefined
          ? { think: resolved.defaults.think }
          : {}),
        // max_tokens — per-specialist override else the role default.
        ...(_effective_max_tokens(specialist, resolved, input.max_tokens_override) !== undefined
          ? { max_tokens: _effective_max_tokens(specialist, resolved, input.max_tokens_override) }
          : {}),
        // Round-0 forced fetch: directed require_tool_call, or the voice
        // lookup-grounding backstop (use_stream-gated in force_first_tool); OR an
        // actionable-intent force (round 0 or a guard re-arm), narrowed above.
        ...(((round === 0 && force_first_tool) || force_record_round)
          ? { tool_choice: 'required' as const }
          : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      };
      try {
        if (use_stream) {
          const stream = resolved.provider.complete_stream!(req);
          for await (const ev of stream) {
            if (ev.type === 'content_delta') {
              // Hold-back: suppress live tokens unless this round streams (see
              // emit_content_live). resp_done still carries the full content,
              // so finalize/guards/persist are unaffected.
              if (emit_content_live) {
                this.deps.events?.emit({
                  type: 'message_token',
                  conversation_id: input.conversation_id,
                  specialist_id: specialist.id,
                  stream_id,
                  delta: ev.delta,
                });
              }
            } else if (ev.type === 'thinking_delta') {
              // Surface reasoning trace to the UI so the dead time before
              // the visible reply starts feels productive. Client renders
              // it as a collapsible pill above the streaming bubble; the
              // pill auto-collapses when content_delta starts arriving.
              this.deps.events?.emit({
                type: 'message_thinking_token',
                conversation_id: input.conversation_id,
                specialist_id: specialist.id,
                stream_id,
                delta: ev.delta,
              });
            } else if (ev.type === 'done') {
              resp_done = ev.response;
            }
          }
        } else {
          // Non-streaming path (turn() shim callers, or a provider with no
          // complete_stream): one completion per round, no token events.
          resp_done = await resolved.provider.complete(req);
        }
      } catch (err) {
        llm_error = err instanceof Error ? err.message : String(err);
        // User-cancellation path: signal fired externally. Don't log
        // as an LLM error — record a clean cancel and produce a
        // stopped-message instead of a noisy fallback.
        if (input.signal?.aborted) {
          this.deps.memory.log_action({
            intent_id,
            agent: specialist.id,
            user_id: input.user?.id,
            tool_name: 'turn_cancelled',
            tool_input: { round, conversation_id: input.conversation_id, streaming: use_stream },
          });
          final_text = '(stopped)';
          llm_error = null;
          break outer;
        }
        console.error(`[runtime] LLM failed for ${specialist.id}:`, llm_error);
        this.deps.memory.log_action({
          intent_id,
          agent: specialist.id,
          user_id: input.user?.id,
          tool_name: 'llm_error',
          tool_input: { round, conversation_id: input.conversation_id, streaming: use_stream },
          error: llm_error,
        });
        final_text =
          llm_error.includes('timed out') || llm_error.includes('AbortError')
            ? "I'm sorry — I lost my train of thought (the model timed out mid-response). Try asking again."
            : `I ran into a problem responding (${llm_error.slice(0, 120)}). Try again, or rephrase.`;
        break outer;
      }
      if (!resp_done) {
        llm_error = 'stream ended without done event';
        final_text = 'I lost my train of thought mid-reply. Try again.';
        break outer;
      }
      last_cost = resp_done.cost;
      // Base-prompt observability (ported from turn()): round-0 token count
      // BEFORE any tool output accumulates — the figure that decides whether a
      // deliberation pass can even START (a too-large base 400s here). Pairs
      // with the llm_deliberation peak log to bracket the pass.
      if (round === 0 && _mode_a === 'deliberation') {
        console.log(
          `[deliberation-base] ${specialist.id} round0 tokens_in=${resp_done.cost.tokens_in} ` +
            `(ceiling ${resolved.context_window_tokens ?? '?'} tok)`,
        );
      }
      if (resp_done.thinking) {
        reasoning_trace +=
          (reasoning_trace ? '\n\n---\n\n' : '') + resp_done.thinking;
      }
      if (resp_done.tool_calls.length === 0) {
        // Unified finalize-guard pipeline (see run_reply_guards above). On a
        // fire it pushes the rejected reply + nudge, audits, and — for a draft
        // that was shown live this round — emits message_superseded so the
        // client drops it (the graceful swap) instead of wipe-and-retyping the
        // redo; we just re-enter the loop.
        const superseded_sid = emit_content_live ? stream_id : null;
        if (
          await run_reply_guards(
            resp_done.content,
            resp_done.thinking ?? '',
            round,
            superseded_sid,
          )
        ) {
          continue;
        }
        final_text = strip_leading_stamp(resp_done.content);
        break outer;
      }
      // Tool-call round — append the assistant message + execute each
      // tool sequentially (non-streaming), then loop for the next
      // streaming round.
      messages.push({
        role: 'assistant',
        content: resp_done.content,
        tool_calls: resp_done.tool_calls,
      });
      // Per-round live status — a human "what they're doing right now"
      // line that (a) drives the iOS chat indicator so it shows the work
      // instead of a bare "…" that vanishes mid-turn, and (b) keeps the
      // SSE stream warm through a long tool batch. Reuses the same
      // `_tool_label` humanization as the live tool strip; deduped so
      // "reading the web" ×3 reads once.
      {
        const phrases = Array.from(
          new Set(
            resp_done.tool_calls.map((tc) =>
              _tool_status_phrase(tc.name, tc.arguments),
            ),
          ),
        );
        if (phrases.length > 0) {
          const base_status = `${specialist.name} is ${phrases.join(', ')}…`;
          const status_ttl = Math.max(15, resp_done.tool_calls.length * 8);
          this.deps.events?.emit({
            type: 'specialist_status',
            specialist_id: specialist.id,
            conversation_id: input.conversation_id,
            status: base_status,
            ttl_seconds: status_ttl,
          });
          // Non-blocking contextual upgrade of the line (fail-open to
          // base_status; env-gated; never awaited). See status_flavor.ts.
          void maybe_upgrade_status_flavor({
            llm: this.deps.llm,
            events: this.deps.events,
            specialist_id: specialist.id,
            specialist_name: specialist.name,
            conversation_id: input.conversation_id,
            messages,
            tool_calls: resp_done.tool_calls,
            ttl_seconds: status_ttl,
          });
        }
      }
      for (const tc of resp_done.tool_calls) {
        // A tool retired by the spiral guard is refused here rather than
        // re-run. Cheap, and it keeps the refusal in the model's own
        // transcript so the next round sees WHY the call didn't happen.
        if (disabled_tools.has(tc.name)) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content:
              `TOOL_RETIRED: \`${tc.name}\` was retired earlier this turn after repeated ` +
              `failures. This call was not executed. Use another tool, or report what you ` +
              `have and name what you could not retrieve.`,
          });
          this.deps.events?.emit({
            type: 'tool_completed',
            conversation_id: input.conversation_id,
            specialist_id: specialist.id,
            tool_call_id: tc.id,
            tool_name: tc.name,
            ok: false,
          });
          continue;
        }
        // Emit tool_invoked before the tool runs so the UI status
        // line updates even if the tool is slow (Firecrawl, big web
        // pages, etc.).
        this.deps.events?.emit({
          type: 'tool_invoked',
          conversation_id: input.conversation_id,
          specialist_id: specialist.id,
          tool_call_id: tc.id,
          tool_name: tc.name,
          input_summary: _summarize_tool_input(tc.name, tc.arguments),
          ...((): { preview?: string } => {
            const preview = _code_preview(tc.name, tc.arguments);
            return preview ? { preview } : {};
          })(),
        });
        // Dynamic tool surface: load_tools is a meta-tool handled inline (like
        // consult) — it mutates tool_defs for the next round and is recorded as
        // a RESULT, never an error, so it never trips the dedup / heavy-fetch /
        // same-tool-error-spiral guards below.
        if (dynamic_on && tc.name === LOAD_TOOLS_NAME) {
          const parsed = LoadToolsInputSchema.safeParse(tc.arguments);
          if (!parsed.success) {
            const emsg = `load_tools needs {"names":[...]} — ${parsed.error.message}`;
            tool_calls_made.push({ name: LOAD_TOOLS_NAME, input: tc.arguments, result: emsg });
            messages.push({ role: 'tool', tool_call_id: tc.id, content: emsg });
            this.deps.events?.emit({
              type: 'tool_completed',
              conversation_id: input.conversation_id,
              specialist_id: specialist.id,
              tool_call_id: tc.id,
              tool_name: tc.name,
              ok: true,
            });
            continue;
          }
          const res = apply_load_tools({
            names: parsed.data.names,
            catalog,
            hotNames,
            total_loaded: dynamic_loaded,
          });
          for (const t of res.newly) {
            tool_defs.push(to_tooldef(t));
            hotNames.add(t.name);
          }
          dynamic_loaded += res.newly.length;
          // Capability-demand ledger: a load_tools name outside the granted
          // catalog is live evidence of an ability the specialist wanted and
          // lacks. Content-free; best-effort — never breaks the turn.
          // Meta-tools are EXCLUDED (2026-07-20): consult_specialist and
          // load_tools are runtime-appended and never live in the catalog,
          // so their "misses" are false positives by construction — the
          // ledger's first live rows were exactly this noise.
          for (const miss of res.missing) {
            if (miss === CONSULT_TOOL_NAME || miss === LOAD_TOOLS_NAME) continue;
            try {
              this.deps.memory.capability_demand.record({
                specialist_id: specialist.id,
                kind: 'load_miss',
                tool_name: miss,
                surface: input.llm_role ?? 'specialist',
              });
            } catch {
              /* the ledger is observability, not control flow */
            }
          }
          const summary = format_load_tools_result(res);
          tool_calls_made.push({ name: LOAD_TOOLS_NAME, input: parsed.data, result: summary });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: summary });
          this.deps.events?.emit({
            type: 'tool_completed',
            conversation_id: input.conversation_id,
            specialist_id: specialist.id,
            tool_call_id: tc.id,
            tool_name: tc.name,
            ok: true,
          });
          continue;
        }
        if (tc.name === CONSULT_TOOL_NAME) {
          const parsed = ConsultInputSchema.safeParse(tc.arguments);
          if (!parsed.success) {
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: `consult_specialist input invalid: ${parsed.error.message}`,
            });
            tool_calls_made.push({
              name: CONSULT_TOOL_NAME,
              input: tc.arguments,
              error: parsed.error.message,
            });
            this.deps.events?.emit({
              type: 'tool_completed',
              conversation_id: input.conversation_id,
              specialist_id: specialist.id,
              tool_call_id: tc.id,
              tool_name: tc.name,
              ok: false,
            });
            continue;
          }
          const reply = await this.consult(
            specialist.id,
            parsed.data.specialist_id,
            parsed.data.question,
            input.consult_depth ?? 0,
          );
          consulted.add(parsed.data.specialist_id);
          tool_calls_made.push({
            name: CONSULT_TOOL_NAME,
            input: parsed.data,
            result: reply,
          });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: reply });
          this.deps.events?.emit({
            type: 'tool_completed',
            conversation_id: input.conversation_id,
            specialist_id: specialist.id,
            tool_call_id: tc.id,
            tool_name: tc.name,
            ok: true,
          });
          continue;
        }
        // Dedup: same tool + same input twice in one turn returns the
        // same result — serve the FIRST call's outcome from the
        // per-turn cache. Success → result channel (cache semantics; no
        // error for the model to spiral on, no false "read failure" for
        // the authenticity scan). Failure → error channel (an identical
        // retry of a failed call is still a failure).
        const sig = _call_signature(tc.name, tc.arguments);
        // Volatile tools (workbench check/edit family) mutate or read
        // session state the turn itself is changing — identical re-calls
        // are the LOOP working, not a retry storm. Never cache them.
        const _volatile = this.deps.tools.get(tc.name)?.volatile === true;
        const cached = _volatile ? undefined : seen_results.get(sig);
        if (cached) {
          if (cached.ok) {
            const note = _dedup_cached_note(tc.name);
            tool_calls_made.push({
              name: tc.name,
              input: tc.arguments,
              result: { duplicate_call: true, note },
            });
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: `${note}\n\n${_render_dup_cached(cached.content)}`,
            });
            this.deps.memory.log_action({
              intent_id,
              agent: specialist.id,
              user_id: input.user?.id,
              tool_name: tc.name,
              tool_input: tc.arguments,
              execution_result: { duplicate_call: true },
            });
            this.deps.events?.emit({
              type: 'tool_completed',
              conversation_id: input.conversation_id,
              specialist_id: specialist.id,
              tool_call_id: tc.id,
              tool_name: tc.name,
              ok: true,
            });
          } else {
            const dup_err = _dedup_failed_error_for(tc.name, cached.error);
            tool_calls_made.push({
              name: tc.name,
              input: tc.arguments,
              error: dup_err,
            });
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: `ERROR (dedup): ${dup_err}`,
            });
            this.deps.memory.log_action({
              intent_id,
              agent: specialist.id,
              user_id: input.user?.id,
              tool_name: tc.name,
              tool_input: tc.arguments,
              error: dup_err,
            });
            this.deps.events?.emit({
              type: 'tool_completed',
              conversation_id: input.conversation_id,
              specialist_id: specialist.id,
              tool_call_id: tc.id,
              tool_name: tc.name,
              ok: false,
            });
            // DIRECTED FAST-FAIL (2026-08-11): on an owner-directed build, an
            // identical retry of a FAILED call is deterministic — same input,
            // same gate, same refusal (checks re-run byte-identical). Latch the
            // second identical failure; the pass ends after this round's calls
            // settle. Chat turns keep the retire-the-tool behavior (2026-07-29)
            // — a chat surface has other tools and other work; a directed pass
            // whose deliverable call can't land has nothing left to do.
            if (input.directed_context && !directed_dup_cut) {
              directed_dup_cut = tc.name;
            }
          }
          continue;
        }

        // Per-turn heavy-fetch cap. Past the budget, short-circuit further
        // external fetches with a synthesize-now nudge instead of running
        // them — keeps a research loop from fanning into a dozen fetches
        // (lag + context bloat). Light tools are unaffected.
        if (this.deps.tools.get(tc.name)?.weight === 'heavy') {
          if (heavy_calls_made >= HEAVY_FETCH_CAP_PER_TURN) {
            const cap_msg =
              `ERROR (fetch budget): you've already made ${heavy_calls_made} web ` +
              `fetches this turn (cap ${HEAVY_FETCH_CAP_PER_TURN}). Stop fetching ` +
              `and answer from what you've gathered: findings first, then a clear ` +
              `recommendation, then anything you couldn't confirm. If a single ` +
              `gap genuinely blocks the answer, say so and schedule a follow-up ` +
              `rather than fetching more now.`;
            tool_calls_made.push({ name: tc.name, input: tc.arguments, error: cap_msg });
            messages.push({ role: 'tool', tool_call_id: tc.id, content: cap_msg });
            this.deps.events?.emit({
              type: 'tool_completed',
              conversation_id: input.conversation_id,
              specialist_id: specialist.id,
              tool_call_id: tc.id,
              tool_name: tc.name,
              ok: false,
            });
            continue;
          }
          heavy_calls_made++;
        }

        // Persisted-fabrication guard: don't let a durable write record
        // specifics that no successful tool result this turn supports when a
        // read/fetch also failed — the fabricate-after-read-failure → record →
        // self-ground loop. Deterministic + narrow; HEARTH_PERSIST_GUARD=0 off.
        const _persist_block = persisted_fabrication_block(
          tc,
          this.deps.tools,
          tool_calls_made,
          compute_turn_grounding,
        );
        if (_persist_block) {
          tool_calls_made.push({ name: tc.name, input: tc.arguments, error: _persist_block });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: _persist_block });
          this.deps.memory.log_action({
            intent_id,
            agent: specialist.id,
            user_id: input.user?.id,
            tool_name: 'persisted_fabrication_guard',
            tool_input: { blocked_tool: tc.name },
            execution_result: { blocked: true, reason: _persist_block.slice(0, 200) },
          });
          this.deps.events?.emit({
            type: 'tool_completed',
            conversation_id: input.conversation_id,
            specialist_id: specialist.id,
            tool_call_id: tc.id,
            tool_name: tc.name,
            ok: false,
          });
          continue;
        }
        const _act_ch = _activity_channel(tc.name);
        // An ESCALATION's forced consult runs under the escalation budget
        // rather than the role's 300s timeout — the user has already waited
        // once for this turn. Every other call gets the shared ctx unchanged.
        const esc_signal = escalation_signal_for(tc.name);
        const call_ctx = esc_signal ? { ...ctx, signal: esc_signal } : ctx;
        const outcome = _act_ch
          ? await this._with_activity(_act_ch, specialist.id, input.conversation_id, () =>
              this.deps.tools.invoke(
                tc.name,
                tc.arguments,
                call_ctx,
                specialist.granted,
                specialist.id,
              ),
            )
          : await this.deps.tools.invoke(
              tc.name,
              tc.arguments,
              call_ctx,
              specialist.granted,
              specialist.id,
            );
        tool_calls_made.push({
          name: tc.name,
          input: tc.arguments,
          result: outcome.result,
          error: outcome.error,
          ...(outcome.candidates ? { candidates: outcome.candidates } : {}),
        });
        // Capability-demand ledger: record the two invoke-layer miss shapes —
        // 'forbidden' (real tool, ungranted capability) and 'unknown_tool' (a
        // name that exists nowhere — the model wanted an ability the system
        // doesn't have). Content-free; best-effort — never breaks the turn.
        if (
          !outcome.ok &&
          (outcome.reason === 'forbidden' ||
            outcome.error?.startsWith('unknown tool:') === true)
        ) {
          try {
            this.deps.memory.capability_demand.record({
              specialist_id: specialist.id,
              kind: outcome.reason === 'forbidden' ? 'forbidden' : 'unknown_tool',
              tool_name: tc.name,
              missing_capability: outcome.missing_capability ?? null,
              surface: input.llm_role ?? 'specialist',
            });
          } catch {
            /* the ledger is observability, not control flow */
          }
        }
        if (
          outcome.ok &&
          outcome.result &&
          typeof outcome.result === 'object' &&
          'proposal_id' in (outcome.result as Record<string, unknown>) &&
          typeof (outcome.result as Record<string, unknown>).proposal_id === 'string'
        ) {
          proposals_created.push(
            (outcome.result as { proposal_id: string }).proposal_id,
          );
        }
        // followup_scheduled: when promise_followup lands, surface it
        // so the UI can render a pending pill anchored to this turn.
        if (
          outcome.ok &&
          tc.name === 'promise_followup' &&
          outcome.result &&
          typeof outcome.result === 'object'
        ) {
          const r = outcome.result as Record<string, unknown>;
          if (typeof r.followup_id === 'string' && typeof r.fire_at_iso === 'string') {
            const fu_args = (tc.arguments ?? {}) as Record<string, unknown>;
            this.deps.events?.emit({
              type: 'followup_scheduled',
              conversation_id: input.conversation_id,
              specialist_id: specialist.id,
              followup_id: r.followup_id,
              summary: typeof fu_args.summary === 'string' ? fu_args.summary : '',
              fire_at_iso: r.fire_at_iso,
            });
          }
        }
        const tool_result_text = outcome.ok
          ? project_tool_result_for_llm(
              outcome.result,
              this.deps.tools.get(tc.name),
            ) + (_recovery_nudge_for(outcome.result) ?? '')
          : `ERROR (${outcome.reason ?? 'execute'}): ${outcome.error}` +
            (_recovery_nudge_for_thrown(outcome.candidates ?? []) ?? '');
        // Cache the rendered outcome so an identical repeat this turn is
        // served from here instead of re-executing (see the dedup branch).
        // Volatile tools are exempt — their next identical call must run.
        if (!_volatile) {
          seen_results.set(sig, {
            ok: outcome.ok,
            content: tool_result_text,
            ...(outcome.error ? { error: outcome.error } : {}),
          });
        }

        // Citation labeling: successful results on a cite-mode turn get a
        // stable [S#] tag the model cites inline; the finalize gate checks
        // claims against exactly these sources. Duplicates and errors are
        // not new sources.
        let tool_message_content = tool_result_text;
        if (cite_mode && outcome.ok) {
          source_n++;
          const sid = `S${source_n}`;
          turn_sources.push({ id: sid, tool: tc.name, content: tool_result_text });
          tool_message_content = `[${sid}] source: ${tc.name}\n${tool_result_text}`;
        }
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: tool_message_content,
        });
        this.deps.memory.log_action({
          intent_id,
          agent: specialist.id,
          user_id: input.user?.id,
          tool_name: tc.name,
          tool_input: tc.arguments,
          execution_result: outcome.ok ? outcome.result : undefined,
          error: outcome.error,
        });
        // Instant-feedback edge signal (Workstream A), arg-mismatch class: an
        // INPUT validation failure that survived central arg-recovery
        // (_recover_tool_args already ran inside invoke). A single one is noise —
        // the GuardFeedbackDriver aggregates per (tool) over a window and only
        // escalates a recurrence. Strictly `reason==='input'`: a 'forbidden'
        // (capability) or 'execute' (connector 404/error) failure is a different
        // class owned elsewhere. Fail-open.
        if (!outcome.ok && outcome.reason === 'input') {
          try {
            this.deps.events?.emit({
              type: 'quality_signal',
              specialist_id: specialist.id,
              signal_class: 'arg_mismatch',
              guard: 'tool_arg_unrecovered',
              tool: tc.name,
              detail: (outcome.error ?? '').slice(0, 240),
              conversation_id: input.conversation_id,
              ...(input.user?.id ? { user_id: input.user.id } : {}),
            });
          } catch {
            /* fail-open */
          }
        }
        this.deps.events?.emit({
          type: 'tool_completed',
          conversation_id: input.conversation_id,
          specialist_id: specialist.id,
          tool_call_id: tc.id,
          tool_name: tc.name,
          ok: outcome.ok,
        });
      }

      // Directed fast-fail cut (2026-08-11): the second identical FAILED call
      // on a directed pass ends it NOW — miss filed, counter bumped, honest
      // account in final_text. See the latch in the dedup-serve branch.
      if (directed_dup_cut) {
        const cut_tool = directed_dup_cut;
        const tool_errors_so_far = tool_calls_made.filter((c) => c.error).length;
        console.warn(
          `[runtime/streaming] ${specialist.id}: directed pass cut — second identical ` +
            `failed \`${cut_tool}\` call (round ${round + 1}/${tool_round_ceiling})`,
        );
        this.deps.memory.log_action({
          intent_id,
          agent: specialist.id,
          user_id: input.user?.id,
          tool_name: 'directed_dup_failure_cut',
          tool_input: {
            tool: cut_tool,
            round: round + 1,
            tool_round_ceiling,
            tool_calls_count: tool_calls_made.length,
          },
        });
        bump_guard_counter(
          this.deps.db,
          GUARD_DIRECTED_DUP_FAILURE_CUT,
          `${specialist.id}:${cut_tool}`,
          input.directed_context?.instruction_preview.slice(0, 200),
        );
        file_directed_build_miss(this.deps.process_misses, {
          specialist_id: specialist.id,
          conversation_id: input.conversation_id,
          shape: 'dup_failure_cut',
          instruction_preview: input.directed_context?.instruction_preview ?? '',
          rounds_used: round + 1,
          tool_round_ceiling,
          tool_calls_count: tool_calls_made.length,
          tool_errors: tool_errors_so_far,
          detail:
            `\`${cut_tool}\` failed and was retried with byte-identical input — a ` +
            `deterministic re-refusal, so the pass was ended at the second identical ` +
            `failure instead of burning the remaining rounds. The tool's first error is ` +
            `in this pass's audit rows; the fix is revised input, not a retry.`,
        });
        final_text =
          `Directed pass ended early: \`${cut_tool}\` failed and my retry used identical ` +
          `input, which cannot succeed. I filed a process miss with the details — this ` +
          `build needs revised input for \`${cut_tool}\`, not more attempts.`;
        break outer;
      }

      // Same-tool-error spiral guard. 3 consecutive failed calls on the same
      // tool means the model can't fill args OR can't stop calling it. A
      // "failed" call is a throw, a cache-served duplicate, OR a soft failure
      // (a payload that reports its own {ok:false}/{error} without throwing —
      // e.g. a connector 503). Break out. (Detection extracted to
      // `same_tool_spiral` so it is unit-tested.)
      const _spiral = same_tool_spiral(tool_calls_made);
      const streak = _spiral?.streak ?? 0;
      const streak_dups = _spiral?.dups ?? 0;
      const streak_tool = _spiral?.tool ?? null;
      if (_spiral && streak_tool && spiral_is_stuck(_spiral) && !disabled_tools.has(streak_tool)) {
        // Name the streak honestly — a spiral of cache-served duplicate
        // calls has ZERO tool errors (the tool may be working perfectly),
        // and "consecutive errors" sent the 2026-07-15 investigation
        // chasing healthy infra. The audit row keeps the
        // `consecutive_errors` key (downstream scans key on it) and adds
        // the duplicate count.
        const streak_kind =
          streak_dups === streak
            ? 'duplicate calls (served from cache — no tool errors)'
            : streak_dups === 0
              ? 'errors'
              : `failed or duplicate calls (${streak - streak_dups} errors, ${streak_dups} duplicates)`;
        console.warn(
          `[runtime/streaming] same-tool spiral for ${specialist.id}: ` +
            `${streak} consecutive ${streak_kind} on \`${streak_tool}\` — exhausting turn early`,
        );
        this.deps.memory.log_action({
          intent_id,
          agent: specialist.id,
          user_id: input.user?.id,
          tool_name: 'same_tool_spiral_exhaust',
          tool_input: {
            tool: streak_tool,
            consecutive_errors: streak,
            duplicate_calls: streak_dups,
            round,
          },
        });
        // Instant-feedback edge signal (Workstream A): a same-tool spiral is the
        // strongest single arg-mismatch tell (the model can't fill args AND can't
        // stop). Emit so a recurring spiral on one tool wakes Beatrice. Fail-open.
        try {
          this.deps.events?.emit({
            type: 'quality_signal',
            specialist_id: specialist.id,
            signal_class: 'arg_mismatch',
            guard: 'same_tool_spiral_exhaust',
            tool: streak_tool,
            detail: `${streak} consecutive ${streak_kind} on \`${streak_tool}\` exhausted the turn`,
            conversation_id: input.conversation_id,
            ...(input.user?.id ? { user_id: input.user.id } : {}),
          });
        } catch {
          /* fail-open */
        }
        // RETIRE THE TOOL, DON'T KILL THE TURN (2026-07-29). Exhausting the
        // whole pass threw away every round and every result the model had
        // already earned — Ruby's civic pass died at round 4 of 18 holding
        // the municipal code and confirmed search results, and wrote one
        // line. The waste this guard exists to stop is the RETRY LOOP, not
        // the turn: bar the offending tool, tell the model plainly, and let
        // it finish with what it has. Only a model whose whole surface is
        // failing (3 distinct tools retired) has nothing left to do.
        disabled_tools.add(streak_tool);
        messages.push({
          role: 'user',
          content:
            `TOOL_RETIRED: \`${streak_tool}\` failed ${streak} times in a row and is now ` +
            `unavailable for the rest of this turn. Do NOT call it again — the call will be ` +
            `refused. You have ${tool_round_ceiling - round - 1} round(s) left. Work with what ` +
            `you already retrieved: finish the task with a different tool, or record/report what ` +
            `you DO have and name what you couldn't retrieve. Producing nothing is the only ` +
            `wrong answer here.`,
        });
        if (disabled_tools.size >= 3) {
          console.warn(
            `[runtime/streaming] ${specialist.id}: 3 tools retired this turn — exhausting`,
          );
          break outer;
        }
        continue;
      }

      // Per-round research-budget signal (2026-05-30). Once past the
      // halfway mark — or with ≤2 rounds left — nudge the model to
      // converge and synthesize rather than burning the ceiling and
      // hitting the canned punt. Same user-note channel as the
      // ghost-promise / synthesis nudges above.
      const _rounds_left_stream = tool_round_ceiling - rounds_used;
      if (
        _rounds_left_stream <= 2 ||
        rounds_used >= Math.ceil(tool_round_ceiling / 2)
      ) {
        messages.push({
          role: 'user',
          content: _budget_signal(rounds_used, tool_round_ceiling),
        });
      }
    }

    // Hand the deep-tier slot back. Reached by every `break outer` and by loop
    // exhaustion; the only escape past it is a throw, which `turn_streaming`
    // turns into a recovery message and which the gate's lazy expiry sweep
    // covers so a lost release can never wedge escalation for the process.
    release_escalation();

    if (!final_text.trim() && !llm_error) {
      // Capture the (blank) raw content + reasoning BEFORE the recovery
      // message overwrites final_text — for the blank_turn_fallback row below.
      const tool_errors = tool_calls_made.filter((tc) => tc.error).length;
      const raw_content_preview = final_text.slice(0, 500);
      const reasoning_preview = reasoning_trace.slice(0, 1500);
      if (rounds_used >= tool_round_ceiling) {
        // Ceiling hit. Rather than punt with the canned "I worked through
        // N steps" message, make ONE tools-disabled synthesis pass so the
        // user gets a real answer from what was already gathered. The
        // affordance miss is still filed — the closed-loop signal to
        // Beatrice stays valuable even when the user got a good reply.
        final_text = await this._synthesize_on_exhaustion({
          specialist,
          resolved,
          messages,
          input,
        });
        if (!final_text.trim()) {
          final_text = _exhaustion_message(tool_calls_made, specialist.name);
        }
        // Guard telemetry (2026-08-11): every ceiling exhaustion counts, per
        // specialist — a ceiling that keeps guillotining one specialist's
        // work is a sizing gap Mariah's sweep should see as a trend.
        bump_guard_counter(
          this.deps.db,
          GUARD_ROUND_CEILING_EXHAUST,
          specialist.id,
          `${rounds_used}/${tool_round_ceiling} rounds (${input.conversation_id})`,
        );
        if (input.directed_context) {
          // A DIRECTED pass exhausting its budget is a failed build (severity
          // high, per-directive key), not a research-efficiency gap — the
          // affordance miss's remedy (efficiency injection) is the wrong fix
          // for an under-budgeted or stuck build.
          file_directed_build_miss(this.deps.process_misses, {
            specialist_id: specialist.id,
            conversation_id: input.conversation_id,
            shape: 'ceiling_exhausted',
            instruction_preview: input.directed_context.instruction_preview,
            rounds_used,
            tool_round_ceiling,
            tool_calls_count: tool_calls_made.length,
            tool_errors,
          });
        } else {
          _file_runtime_affordance_miss(this.deps.process_misses, {
            specialist_id: specialist.id,
            conversation_id: input.conversation_id,
            rounds_used,
            tool_round_ceiling,
            tool_calls_count: tool_calls_made.length,
            user_question_preview: input.message.content.slice(0, 240),
            tool_call_shape: tool_calls_made.map((t) => t.name).slice(0, 20),
          });
        }
      } else if (tool_errors > 0) {
        final_text = `I tried but couldn't get my tool calls to land cleanly. Try again or rephrase if this is repeatable.`;
      } else {
        final_text = `(I didn't have anything to add this turn — try asking again.)`;
      }
      // Loud directed failures (2026-08-11): a build pass that blanks WITHOUT
      // hitting the ceiling (LLM produced nothing / every call errored) was
      // the silent shape of 2026-08-10 — a blank_turn_fallback audit row and
      // nothing else. File the high-severity miss so Mariah's ledger sees it.
      if (input.directed_context && rounds_used < tool_round_ceiling) {
        file_directed_build_miss(this.deps.process_misses, {
          specialist_id: specialist.id,
          conversation_id: input.conversation_id,
          shape: 'blank_turn',
          instruction_preview: input.directed_context.instruction_preview,
          rounds_used,
          tool_round_ceiling,
          tool_calls_count: tool_calls_made.length,
          tool_errors,
        });
      }
      // blank_turn_fallback (ported from turn()): Mariah's
      // turn_health.ceiling_hits reads this row; the streaming path silently
      // omitted it pre-merge. rounds_used / tool_round_ceiling are the
      // per-row ceiling judgement; tool_calls_count is the parallel-call sum.
      this.deps.memory.log_action({
        intent_id,
        agent: specialist.id,
        user_id: input.user?.id,
        tool_name: 'blank_turn_fallback',
        tool_input: {
          rounds_used,
          tool_calls_count: tool_calls_made.length,
          tool_round_ceiling,
          tool_errors,
        },
        execution_result: {
          recovery_message_chars: final_text.length,
          raw_content_preview,
          raw_content_chars: raw_content_preview.length,
          reasoning_preview,
          reasoning_chars: reasoning_trace.length,
        },
      });
    }

    this.deps.memory.log_action({
      intent_id,
      agent: specialist.id,
      user_id: input.user?.id,
      tool_name: 'specialist_turn',
      tool_input: {
        conversation_id: input.conversation_id,
        message_summary: input.message.content.slice(0, 200),
        streaming: use_stream,
      },
      execution_result: {
        tool_calls_count: tool_calls_made.length,
        proposals_count: proposals_created.length,
        consulted: Array.from(consulted),
        cost: last_cost,
      },
    });

    for (const pid of proposals_created) {
      this._emit_proposal_created(pid, specialist.id, final_text.slice(0, 80));
    }

    this.deps.events?.emit({
      type: 'specialist_thinking',
      specialist_id: specialist.id,
      conversation_id: input.conversation_id,
      state: 'finished',
    });

    return {
      message_text: final_text,
      tool_calls_made,
      proposals_created,
      consulted_specialists: Array.from(consulted),
      reasoning_trace,
      cost: last_cost,
    };
  }

  /**
   * Emit the SSE fan-out for a freshly-created proposal. Routes through
   * `emit_for_proposal_created` so PER-KIND sibling events fire — most
   * importantly `calendar_event_proposed`, which the iOS EventKit
   * write-back coordinator subscribes to. The caller only has the
   * proposal id, so we look the row up to recover its real `kind` +
   * payload (the old inline emit hardcoded `kind: 'action_proposal'`,
   * which both mislabeled every other kind and never fired the calendar
   * sibling). Falls back to a bare `proposal_created` if the row can't
   * be read.
   */
  private _emit_proposal_created(
    pid: string,
    specialist_id: string,
    fallback_title: string,
  ): void {
    const events = this.deps.events;
    if (!events) return;
    const row = this.deps.proposals.get(pid);
    if (!row) {
      events.emit({
        type: 'proposal_created',
        proposal_id: pid,
        specialist_id,
        kind: 'action_proposal',
        title_preview: fallback_title,
      });
      return;
    }
    let payload: unknown = {};
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      /* keep {} — the sibling-emit validators safeParse and skip on miss */
    }
    emit_for_proposal_created(events, {
      proposal_id: pid,
      specialist_id,
      kind: row.kind,
      title_preview: fallback_title,
      payload,
    });
  }

  /**
   * Non-streaming turn. Same postcondition as turn_streaming: ALWAYS
   * returns a SpecialistTurnOutput with a non-empty message_text;
   * never throws past input validation. Uncaught errors inside the
   * turn body are caught and turned into a recovery message.
   */
  /**
   * Non-streaming entry point. Thin shim over turn_streaming() with
   * `stream:false`: the merged body runs a single complete() per round and
   * emits no token events, materialising the SAME SpecialistTurnOutput. Kept
   * as a named method so the non-streaming callers (consult, the async
   * librarian, deliberation, hire, library, the eval harness, intake turns)
   * and the test seams don't have to change. TEST_MODE / no-complete_stream
   * are handled inside the merged body.
   */
  async turn(input: SpecialistTurnInput): Promise<SpecialistTurnOutput> {
    return this.turn_streaming({ ...input, stream: false });
  }

  /**
   * Render up to N unactioned inbox items as prose for the chat
   * system prompt. Mirrors the deliberation pattern in
   * deliberation.ts but bounded tighter for chat turns: 5 items max,
   * 500 chars per body. Pre-2026-05-27 chat turns rendered no inbox
   * content at all, which is how Brigid received a Cordelia-routed
   * Dunkin' cup at 02:55 (audit_log row, inbox flag, file written
   * under her knowledge_scope) and then 13 minutes later told Jasper
   * "I don't have a record of an uploaded drink recipe" — she
   * literally had no way to know the flag existed.
   *
   * Returned string is empty when the specialist has no `read_inbox`
   * capability or no unactioned items. Caller concatenates
   * unconditionally; an empty string is a clean no-op in the prompt.
   */
  private render_chat_inbox_section(
    specialist: LoadedSpecialist,
    viewer_user_id?: string,
  ): string {
    if (!specialist.granted.has('read_inbox')) return '';
    // Per-user cordon: a flag scoped to another user (a household member's
    // personal capture) must not surface in this user's chat turn. Pass
    // the speaking user; household/system-shared flags (NULL) still show.
    const items = this.deps.inbox.unactioned_for(specialist.id, 5, viewer_user_id);
    if (items.length === 0) return '';
    const out: string[] = [];
    out.push('');
    out.push(
      `## Your recent inbox (${items.length} unactioned item${items.length === 1 ? '' : 's'})`,
    );
    out.push('');
    out.push(
      `These are routed items peers / the runtime dropped in your queue ` +
        `since you last cleared it. When the user references "something I ` +
        `sent", "the photo I uploaded", "what I just shared", or asks a ` +
        `question your domain would have received an intake on, READ THESE ` +
        `FIRST — the answer is often the most recent flag below. Each item ` +
        `cites the source capture / note path you can pull via ` +
        `\`read_note\` or \`search_library\` for the full record.`,
    );
    out.push('');
    for (let i = 0; i < items.length; i++) {
      const m = items[i]!;
      const refs: string[] = [];
      if (m.related_proposal_id) refs.push(`proposal ${m.related_proposal_id}`);
      if (m.related_interrupt_id) refs.push(`interrupt ${m.related_interrupt_id}`);
      const refs_clause = refs.length ? ` — ${refs.join(', ')}` : '';
      out.push(`### Inbox ${i + 1} of ${items.length}`);
      out.push(
        `From \`${m.from_specialist_id}\` · kind \`${m.kind}\` · id \`${m.id}\` · ${m.ts}${refs_clause}`,
      );
      out.push('');
      const body =
        m.body_md.length > 500
          ? m.body_md.slice(0, 500) +
            `\n[truncated; ${m.body_md.length} chars total — read full via inbox row \`${m.id}\`]`
          : m.body_md;
      out.push(body);
      out.push('');
    }
    return out.join('\n');
  }

  /**
   * Research-efficiency block — structural injection for specialists
   * with `proactive.research_workload: true` (2026-05-30). Lifts the
   * per-persona carve-out pattern ("Research efficiency — don't burn
   * rounds" sections written inline in YAML) into a runtime affordance
   * every research-heavy specialist gets for free.
   *
   * Six behaviors, each derived from an observed audit-log failure:
   *   1. Plan tool calls before firing — counters the "one-tool-per-
   *      round sequential exhaustion" Vivian hit on her first Dell turn
   *      (2026-05-30T05:04, 10 sequential 5s-gap calls).
   *   2. Batch parallel fan-outs — the same fix-class, surfaced as the
   *      affordance.
   *   3. Every call in a fan-out must be DIFFERENT — counters the
   *      observed duplicate-within-fan-out failure (2026-05-30T05:09,
   *      six web_searches = three queries each emitted twice, tripped
   *      `same_tool_spiral_exhaust` at round 7).
   *   4. Don't re-fetch documents already in turn context — refer back,
   *      don't re-call edgar_read_filing on the same URL.
   *   5. Cap scope on broad questions — "tell me everything about X"
   *      is a tar pit; pick the 3-4 decision-relevant angles.
   *   6. On exhaust, surface what couldn't confirm — don't silently
   *      truncate; tell the user explicitly what's missing.
   *
   * Injected in BOTH chat and deliberation modes — research workloads
   * run in both surfaces (Vivian's 07:30 deliberation is equity-research
   * shaped; Maggie's concert deliberation is web-research shaped).
   * Empty string when the specialist doesn't opt in, so callers
   * concatenate unconditionally.
   */
  /**
   * What to do when the turn hits a STRUCTURAL gap — no tool exists, the tool
   * exists but its integration is broken, or an ad-hoc answer worked this time
   * and deserves a real integration.
   *
   * Two shapes, chosen by capability rather than by id (2026-08-03):
   *
   *  - **A specialist who can AUTHOR** (`write_codebase_pr`) opens the fix
   *    itself. This block used to be a single unconditional essay routing
   *    every gap to `trainer` and scripting the user-facing line "I've asked
   *    Beatrice to draft a proper integration" — which, after the Beatrice
   *    dissolution gave Kate the build tools, contradicted her own persona
   *    ("structural work is YOURS to author"; `trainer` is a build ledger, not
   *    a colleague with a room) from the recency-strong slot BELOW it. Worse,
   *    the essay's closing line armed the ghost-promise guard against a reply
   *    that named Beatrice, so the prompt pushed her toward a sentence the
   *    runtime then punished her for. The author variant states the ladder she
   *    actually holds and never names a persona.
   *  - **Everyone else** keeps the original routing essay verbatim — for a
   *    specialist with no build tools, `consult_specialist(trainer, …)` really
   *    is the only path, and the detailed error-shape guidance is what makes
   *    the consult actionable.
   *
   * Both variants end in the same invariant: the gap is closed THIS turn, by a
   * real tool call, not by a promise.
   */
  /**
   * The reflex table — `tool_reflexes` rendered as one compact block in the
   * recency-strong zone of the chat prompt, immediately above `chat_style`.
   *
   * Placement is the point. The grounding essay directly above says "if you
   * can't point at where this came from THIS turn, go get it" — correct, and
   * useless on its own, because the model still has to guess WHICH tool gets
   * it. That guess is where the recurring failures live: a roster answered
   * from memory, a container's health read off a cached ledger, a person's
   * details recalled instead of looked up. The table closes the gap between
   * the rule and the call, one line per reflex, in the region the decoder
   * weights most heavily.
   *
   * Chat only, deliberately. A deliberation pass is told the verified-context
   * block is its ONLY fact source and that it should not improvise tool calls
   * to fill gaps; a reflex table would argue with that. Standing duties for
   * that surface belong in `deliberation_addendum`. Voice keeps its own lean
   * GROUND-FIRST rule in `voice_style`, where every token is latency.
   *
   * Empty when the specialist declares none, so callers concatenate
   * unconditionally and an un-migrated persona's prompt is byte-identical.
   */
  private render_tool_reflexes(specialist: LoadedSpecialist): string {
    const reflexes = specialist.tool_reflexes ?? [];
    if (reflexes.length === 0) return '';
    const rows = reflexes
      .map((r) => `  - ${r.when} → \`${r.tool}\`${r.note ? ` — ${r.note}` : ''}`)
      .join('\n');
    return (
      `**REFLEXES — the ask on the left is ALWAYS the tool on the right, ` +
      `called THIS turn, before you answer.**\n\n` +
      `These are the asks where what you remember is stale by construction: ` +
      `the roster changes, people change, the house changes, the machines ` +
      `change. So a confident answer from memory is not a shortcut, it is the ` +
      `failure mode — and it fails in the worst direction, sounding certain. ` +
      `When a turn matches a row below, make that call FIRST and answer only ` +
      `from what it returns. Feeling sure you already know it is not a reason ` +
      `to skip the call; it is the exact feeling that precedes an invented ` +
      `answer. If the call fails, say you couldn't read it — never fall back ` +
      `to recall.\n\n` +
      `${rows}\n\n`
    );
  }

  private render_structural_gap_block(specialist: LoadedSpecialist): string {
    const authors_own_changes = specialist.capabilities?.write_codebase_pr === true;

    if (authors_own_changes) {
      return (
        `**A STRUCTURAL GAP IS WORK YOU OPEN THIS TURN, NOT AN APOLOGY.** ` +
        `Three shapes qualify, and you hold the tools for all three — so "I ` +
        `can't do that" is almost always really "not yet; here's the change I ` +
        `just opened."\n\n` +
        `  1. **Hard gap (no tool exists)** — nothing you hold resolves it. ` +
        `Read the real code first (\`grep_codebase\` / \`read_codebase_file\` ` +
        `/ \`repo_map\` — never author from memory), then build it: ` +
        `\`propose_code_edit\` for a surgical single-file change, ` +
        `\`opencode_build\` for a multi-file or exploratory one, or ` +
        `\`file_build_request\` when it is genuinely too large to scope from ` +
        `this conversation.\n` +
        `  2. **Broken integration (the tool exists but isn't usable)** — a ` +
        `tool returned an error meaning the integration is misconfigured, ` +
        `unreachable, or missing credentials: "not configured", "missing ` +
        `token", "set XXX_TOKEN in .env", "not reachable", "no credentials", ` +
        `"401 Unauthorized" on a service that should be live. The user ` +
        `experiences this as BROKEN. Quote the error verbatim into the fix you ` +
        `open — the verbatim text is what makes it actionable — and record the ` +
        `recurrence with \`flag_beatrice\`, which is a LEDGER ENTRY on the ` +
        `build queue, not a colleague you escalated to. Never narrate it as a ` +
        `hand-off to a person.\n` +
        `  3. **Soft gap (ad-hoc worked, deserves a real integration)** — you ` +
        `answered this time by patching it together (a web_search plus ` +
        `interpretation, reasoning over partial data), but your domain will be ` +
        `asked this AGAIN and a dedicated tool would do it dramatically ` +
        `better. Do BOTH: give the ad-hoc answer now AND open the durable fix ` +
        `in the same turn.\n\n` +
        `A capability the gap needs but a specialist lacks is a GRANT — one ` +
        `line in that specialist's YAML, authored the same way. ` +
        `\`config/specialists/\` is a protected path, so it can never ` +
        `auto-merge: it lands in the owner's merge queue behind his PIN. Say ` +
        `that plainly ("I've opened the change; it's waiting on your merge") ` +
        `and never say you lack the permission — you don't, and a gate is not ` +
        `a wall.\n\n` +
        `Whatever you do, report what YOU did, in the first person, this turn. ` +
        `Do not tell the user someone else is handling it, and do not name a ` +
        `persona as the one doing the work: a reply that says a teammate is on ` +
        `it, with no tool call behind it, is a ghost promise the runtime will ` +
        `catch and retry.\n\n`
      );
    }

    return (
      `**STRUCTURAL GAPS GO TO THE BUILD DESK (id: trainer).** Three flavors ` +
      `of gap qualify, and all three route there via ` +
      `\`consult_specialist({ specialist_id: "trainer", question: ... })\` ` +
      `**in the same turn** — not "I'll flag it later," not "I'll ask ` +
      `tomorrow." It is one tool call away; the right time to call is RIGHT ` +
      `NOW.\n\n` +
      `  1. **Hard gap (no tool exists)** — you tried and there's literally ` +
      `no tool / capability / data path. You cannot answer at all.\n` +
      `  2. **Broken integration (the tool exists but isn't usable)** — a ` +
      `tool returned an error that means the integration is misconfigured, ` +
      `unreachable, missing credentials, or otherwise non-functional. ` +
      `Look for error text containing phrases like "not configured", ` +
      `"missing token", "set XXX_TOKEN in .env", "not reachable", ` +
      `"unconfigured", "no credentials", "401 Unauthorized" on a service ` +
      `that should be live. THIS IS A HARD GAP for the user — they see ` +
      `it as "broken" — and your job is to route it immediately, ` +
      `quoting the exact error text so the env / .service / connector can be ` +
      `fixed. Do NOT say "Mealie isn't hooked up yet, I'll flag it"; ` +
      `instead, in the same turn call ` +
      `consult_specialist(trainer, "mealie_search_recipes returned: ` +
      `'Mealie is not configured — set MEALIE_TOKEN in .env'. Can you ` +
      `wire it up?") and then tell the user "I hit a config error and ` +
      `routed it to the build desk — the wiring will get fixed." Quote the ` +
      `error verbatim; that's what makes the consult actionable.\n` +
      `  3. **Soft gap (works ad-hoc, deserves a real integration)** — ` +
      `you CAN answer this time by patching it together (web_search + ` +
      `interpretation, manual reasoning over partial data, telling the ` +
      `user "check this URL yourself"), but the question is the kind your ` +
      `domain will get asked AGAIN, and a dedicated tool / integration ` +
      `would do it dramatically better. Examples: "any new HACS ` +
      `integrations for my Ioniq?" — you can web_search but a ` +
      `hacs_watcher tool with device-relevance filtering is the real ` +
      `fix. "What did I spend at the vet last month?" — you can guess, ` +
      `but a Plaid integration is the real fix.\n\n` +
      `For hard gaps AND broken integrations, your reply MUST include the ` +
      `consult_specialist(trainer, ...) call in this same turn. For soft ` +
      `gaps, do BOTH: give the user your best ad-hoc answer this time AND ` +
      `route it in the same turn so the integration gets proposed. ` +
      `Say to the user: "Here's what I found this time via search. I've ` +
      `also put a proper integration on the build queue so this stops ` +
      `being ad-hoc." Do not silently work around a missing integration ` +
      `without routing it; that's how the team's gap list stays ` +
      `invisible to the owner and never gets fixed. **Saying you routed ` +
      `something without calling \`consult_specialist\` this turn is a ghost ` +
      `promise** — the runtime will catch it and retry you.\n\n`
    );
  }

  private render_research_workload_block(
    specialist: LoadedSpecialist,
    /** Conversation turns add the inline-citation contract (tool results
     *  are [S#]-labeled there; deliberation's JSON envelope is not a
     *  citable prose surface). */
    mode: 'conversation' | 'deliberation' = 'deliberation',
  ): string {
    if (!specialist.proactive.research_workload) return '';
    const cite_rule =
      mode === 'conversation' && citations_enabled()
        ? `  7. ${CITATION_PROMPT_RULE}\n\n`
        : '\n';
    // Same resolution as the loop's enforcement (slot-scoped 2026-08-11) so
    // the budget this block PROMISES is the budget the ceiling enforces.
    const budget = resolve_tool_round_ceiling(specialist, {
      mode: mode === 'deliberation' ? 'deliberation' : 'chat',
    });
    // Recall-before-research pointer — only when recall_brain is actually on
    // this specialist's chat surface (so the meta-agents who don't carry it
    // aren't told to use a tool they lack) and only in conversation mode (the
    // surface it rides). The Second Brain's read path leads RAG implicitly;
    // this is the explicit nudge to consult the distilled layer first.
    const recall_rule =
      mode === 'conversation' && specialist.proactive.tools_for_chat?.includes('recall_brain')
        ? `  • **Recall before you research.** On a topic you may already have a ` +
          `view on, call \`recall_brain\` FIRST — your own distilled syntheses ` +
          `are the cheapest, highest-confidence source, and they show you what's ` +
          `genuinely new to go find.\n`
        : '';
    return (
      `**Research efficiency — your tool budget is ${budget} rounds per turn, ` +
      `make every round count.**\n\n` +
      `Research-heavy work (multi-source confirmation, cross-document ` +
      `synthesis, deep catalog drills) burns rounds fast. Six rules keep ` +
      `you in budget without the answer suffering:\n\n` +
      `  1. **Plan before you call.** On a multi-leg question, name the ` +
      `four or five calls you'll make in your head BEFORE the first tool ` +
      `emission. Avoid the "let me search again to be sure" reflex — ` +
      `that's how a budget evaporates without new signal.\n` +
      `  2. **Batch parallel fan-outs.** When you need three independent ` +
      `reads (different tickers, different series, different URLs), emit ` +
      `ALL the tool calls in ONE response. The runtime collapses them ` +
      `into a single round via Promise.all — three calls cost you one ` +
      `round, not three.\n` +
      `  3. **Every call in a fan-out must be DIFFERENT.** Don't emit the ` +
      `same query / URL / ticker twice in one parallel response hoping ` +
      `for variance. The runtime catches duplicates and the spiral guard ` +
      `will end your turn; emitting the same call twice in one round is ` +
      `the worst-of-both outcome.\n` +
      `  4. **Don't re-fetch what's already in context.** Once you've ` +
      `pulled a document via web_fetch_clean / edgar_read_filing / ` +
      `read_note, its content is in your turn context — refer back to it ` +
      `in synthesis, don't call the same fetcher again on the same URL.\n` +
      `  5. **Cap scope on broad questions.** "Tell me everything about ` +
      `X" is a tar pit. Pick the 3-4 most-decision-relevant angles and ` +
      `answer those well. The user can always ask a follow-up; a focused ` +
      `partial beats an unbounded marathon every time.\n` +
      `  6. **On exhaust, name what's missing.** If you run out of budget ` +
      `before confirming everything, say so explicitly in your synthesis: ` +
      `"I confirmed A, B, C but didn't get to D — flag if you want me to ` +
      `follow up on that next turn." Silent truncation reads as a ` +
      `confident-but-incomplete answer; the explicit gap gives the user a ` +
      `clean way to steer.\n` +
      recall_rule +
      cite_rule
    );
  }

  /**
   * "Read the vault before denying knowledge" — a single shared
   * snippet appended to every chat system prompt when the specialist
   * holds `read_vault`. Was previously expected to live in each
   * persona, but only Kate's persona ever got the instruction (and
   * only after the 2026-05-26 VTH-parking fabrication). Lifting it
   * to the runtime makes it structural: every specialist with read
   * access gets the floor without per-yaml drift.
   *
   * 2026-07-17: extended for the universal-read + memory-notebook
   * floor — reads are whole-vault now (read_note unscoped), and the
   * snippet teaches `remember` / `read_memory` / `read_my_proposals`
   * so the new floor tools don't sit granted-but-unused (the
   * capability-visibility rule: surfaced but never mentioned =
   * chronically under-used).
   */
  /**
   * Tier-1 procedures (2026-08-03) — the awareness half of skills-as-data.
   *
   * One line per live skill (name + when-to-use), plus the pointer to
   * `recall_skill` for the body. This is deliberately the SAME split
   * `dynamic_tools.ts` uses for tool schemas: carrying every body in every
   * prompt is the bloat that module exists to kill, and a trigger sentence is
   * all the model needs to decide whether to pull the rest.
   *
   * Lives in the KV-STABLE region of the prompt (below `tool_block`, above the
   * tail time-anchor) and changes only when a skill is learned, graduated, or
   * retired — so it costs a prefix invalidation on those events and nothing on
   * an ordinary turn. See the KV-PREFIX ORDERING note at the chat return.
   *
   * Fail-open at every step: no store wired, capability not granted, kill
   * switch off, store throws → ''. A procedures list is an optimization; a
   * turn that loses it is a slower turn, never a broken one.
   */
  private render_skills_section(
    specialist: LoadedSpecialist,
    user?: SpecialistTurnInput['user'],
  ): string {
    if (!this.deps.skills) return '';
    if (!specialist.granted.has('learn_skills')) return '';
    if (!skills_enabled()) return '';
    // OWNER ONLY, for now (2026-08-04). Skills are keyed per-SPECIALIST with no
    // `private_to` scoping, unlike the inbox block immediately above — so a
    // procedure Kate worked out on the owner's business would render into a
    // household member's or a guest's turn verbatim. Until skills carry a
    // viewer scope, the conservative read is the correct one: a non-owner turn
    // simply does not see them. A user-less pass (deliberation, jobs) keeps
    // them, since that is the owner's own machinery.
    if (user && user.tier !== 'owner') return '';
    try {
      const block = render_skill_awareness(this.deps.skills.live_for(specialist.id));
      return block ? `${block}\n\n` : '';
    } catch {
      return '';
    }
  }

  private render_chat_knowledge_first_snippet(
    specialist: LoadedSpecialist,
  ): string {
    if (!specialist.granted.has('read_vault')) return '';
    return (
      `**The whole vault is yours to read — check it before denying ` +
      `knowledge.** When the user references something they sent, ` +
      `uploaded, photographed, or asked about earlier — "the photo I just ` +
      `shared", "the calories on that drink", "what did you say last ` +
      `Tuesday", "the receipt from Whole Foods" — your FIRST move is ` +
      `\`search_library\` or \`read_note\`. Reads are NOT limited to your ` +
      `own shelf: any note search_library surfaces, read_note can open — ` +
      `another specialist's library, People/, Decisions/, anywhere. ` +
      `\`recall_brain\` returns the distilled syntheses when you want ` +
      `conclusions rather than raw passages. Your "Your recent inbox" ` +
      `section above is the pointer; the vault files it cites are the ` +
      `record. Cordelia routes captures into specialist namespaces through ` +
      `intake handlers (food labels, receipts, pet records, plant photos, ` +
      `mail, etc.) — those files are already there when the user asks. ` +
      `Don't say "I don't have a record" before you've called the read ` +
      `tool. A wrong denial is the same failure mode as a fabricated ` +
      `assertion; both are unverified claims dressed up as fact.\n\n` +
      `**Your memory notebook is a tool, not a hope.** When you learn ` +
      `something durable — a preference, a decision, a lesson, an open ` +
      `loop — call \`remember\` right then; it appends to your own ` +
      `memory file with no approval round-trip. When past context might ` +
      `matter ("didn't we decide this?", "what did I promise?"), call ` +
      `\`read_memory\` before answering from vibes. And when you need to ` +
      `quote or check something YOU previously filed as a proposal, call ` +
      `\`read_my_proposals\` — never reconstruct your own filing from ` +
      `memory or audit-log previews.\n\n`
    );
  }

  /**
   * Browser-failover snippet (2026-06-26) — the "if web_fetch_clean can't
   * get the page, escalate to browse_url on the SAME url" rule, for any
   * specialist holding `browse_web`. Lifts the per-persona YAML comment
   * ("browse_url is the escape hatch") into the runtime so EVERY holder
   * gets it structurally, instead of a handful having it buried in a
   * tools_for_chat comment the model never reads (the gap behind "Kate
   * keeps saying Firecrawl is down" with the workstation sitting idle).
   *
   * Two failover cases the model otherwise gives up on:
   *   - Firecrawl OUTAGE — web_fetch_clean times out because the local
   *     Firecrawl service is down; browse_url is a SEPARATE host that
   *     reaches the page independently. (The ingest/research helper
   *     fetch_with_browser_fallback now escalates this automatically;
   *     this covers the IN-TURN web_fetch_clean the model calls itself.)
   *   - Bot wall — 403 / Cloudflare / JS-only shell; the warmed,
   *     signed-in Firefox renders what Firecrawl can't.
   *
   * Gated on the capability AND web_fetch_clean being on this surface (no
   * point telling a specialist to escalate a tool it can't call). Empty
   * string otherwise so callers concatenate unconditionally.
   */
  private render_browser_escalation_snippet(
    specialist: LoadedSpecialist,
    tools: Array<{ name: string; description: string }>,
  ): string {
    if (!specialist.granted.has('browse_web')) return '';
    if (!tools.some((t) => t.name === 'web_fetch_clean')) return '';
    return (
      `**When \`web_fetch_clean\` can't get a page, escalate — don't give ` +
      `up.** If a fetch errors, times out, or comes back thin/blocked, call ` +
      `\`browse_url\` on the SAME url ONCE before telling the user you ` +
      `can't read it. browse_url drives a real warmed browser on a separate ` +
      `host, so it reaches pages Firecrawl can't: a Firecrawl OUTAGE (every ` +
      `fetch "timed out" — the browser still gets the page) AND bot walls ` +
      `(403, Cloudflare, login/JS-only shells). It's the slower path, so ` +
      `it's the escalation, not the default — but "I can't read that / ` +
      `Firecrawl is down" is never the answer while \`browse_url\` is on ` +
      `your surface.\n\n`
    );
  }

  /**
   * Self-appearance snippet (2026-07-21) — for generate_image holders with
   * a canonical `appearance:` descriptor, tell the specialist what THEY
   * look like on camera and how to evolve it. The canonical descriptor is
   * a DEFAULT, not a constraint: if the conversation changes their look
   * (an outfit, hair down, a scene), the model carries the current look
   * in-context and passes it as `self_appearance` — continuity lives in
   * the conversation, not in stored state. Injected structurally (like
   * the browser-failover snippet) so the model can compose deltas from
   * the same text the tool would otherwise prepend — without duplicating
   * the descriptor into every persona. Empty string when the capability
   * or descriptor is absent so callers concatenate unconditionally.
   */
  private render_self_appearance_snippet(specialist: LoadedSpecialist): string {
    if (!specialist.granted.has('generate_image')) return '';
    const appearance = specialist.appearance?.trim();
    if (!appearance) return '';
    return (
      `**Your on-camera appearance** — when you depict yourself with ` +
      `\`generate_image\` (\`depict_self\`), this canonical look fills in ` +
      `by default:\n${appearance}\n` +
      `If your look CHANGES in this conversation — an outfit you changed ` +
      `into, your hair worn differently, a scene you're in — keep ` +
      `continuity: pass \`self_appearance\` with your full CURRENT look ` +
      `(start from the description above and change only what changed), ` +
      `and keep using it for as long as it holds. Omit \`self_appearance\` ` +
      `to return to your canonical look.\n\n`
    );
  }

  /**
   * The per-specialist data map (2026-06-12) — names the data-bearing
   * read tools on this turn's surface so "is there data?" questions
   * route to a query instead of a hunch (the Astrid no-HR incident:
   * data existed in her stores while the reply said it didn't). The
   * knowledge-first snippet above covers VAULT reads; this generalizes
   * the same floor to every store-backed read tool (health, workouts,
   * calendars, ledgers, device state). Structural like the knowledge
   * floor: generated from the live surface via the registry's risk
   * tiers, zero persona edits, covers every future specialist and tool
   * automatically. Names only — the tool block above already carries
   * full descriptions; repeating them would re-spend the prompt budget
   * the voice work reclaimed. Chat path only (voice keeps its lean
   * prompt; deliberation injects its own context). Rides the
   * data-denial kill switch so HEARTH_DATA_DENIAL_GUARD=0 rolls back
   * the whole feature; deliberately NOT test-mode-gated (deterministic
   * text, and the runtime guard is what fixture smokes must not trip).
   */
  private render_data_map(
    tools: Array<{ name: string; description: string }>,
  ): string {
    if (process.env.HEARTH_DATA_DENIAL_GUARD === '0') return '';
    return render_data_map_section(data_read_tools(tools, this.deps.tools));
  }

  /**
   * House voice — a warm, personable, ECONOMICAL communication-style block,
   * curated per user. Dark by default (HEARTH_HOUSE_VOICE=1 to enable).
   * Conversation mode only; the per-user layer reads the SPEAKER's own profile
   * detail (style_profile), so it is cordoned by construction. The
   * register itself carries the "warm but earned, never gratuitous" guardrail —
   * see house_voice.ts for the two-layer design.
   */
  private render_house_voice_block(
    specialist_id: string,
    user: SpecialistTurnInput['user'] | undefined,
    stored: { detail: Record<string, unknown> } | null,
  ): string {
    if (!house_voice_enabled()) return '';
    const sp = stored?.detail?.['style_profile'];
    const legacy_style = typeof sp === 'string' ? sp : undefined;

    // Per-user model path (HEARTH_USER_MODEL): resolve the style facet + this
    // specialist's domain facets. Style falls back to the legacy style_profile
    // so it can't regress before the style FACET is populated. Fail-open to
    // legacy style-only on any error.
    if (user?.id && user_model_enabled() && this.deps.memory?.user_profiles) {
      try {
        const resolved = resolve_user_model(
          this.deps.memory.user_profiles,
          user.id,
          specialist_id,
          new Date(),
        );
        const style = resolved.facets.find((f) => f.key === 'style')?.summary || legacy_style;
        const context_facets = resolved.facets
          .filter((f) => f.key !== 'style')
          .map((f) => ({ key: f.key, summary: f.summary }));
        return render_house_voice_section({
          display_name: user.display_name,
          style_profile: style,
          context_facets,
        });
      } catch {
        /* fall through to legacy style-only */
      }
    }

    return render_house_voice_section({
      display_name: user?.display_name,
      style_profile: legacy_style,
    });
  }

  private build_system_prompt(
    specialist: LoadedSpecialist,
    tools: Array<{ name: string; description: string }>,
    mode: 'conversation' | 'deliberation' | 'voice' = 'conversation',
    user?: SpecialistTurnInput['user'],
    // Dynamic tool surface (chat only): when `dynamic`, `tools` is the FULL
    // catalog (awareness) and `ready_tools` is the hot set whose schemas are
    // loaded; the chat block renders a two-tier "ready now / load on demand"
    // view. Omitted/false → the flat block from `tools`, byte-identical to before.
    ready_tools?: Array<{ name: string; description: string }>,
    dynamic?: boolean,
  ): string {
    // Routing directory (2026-08-03). Was an inline unfiltered map over
    // specialists.list(), which rendered every FOLDED persona as a named
    // teammate ("- trainer: Beatrice, Enterprise Trainer") in the
    // recency-strong slot after the persona — contradicting the
    // {{staff_roster}} paragraph the same prompt had just rendered. Now built
    // by render_peer_directory: visible peers keep id+name+role, folded ones
    // keep the routing id and lose the name. See staff_roster.ts.
    const peers = render_peer_directory(this.deps.specialists.list(), specialist.id);
    // Phase 2b: per-tier discretion guidance. Empty string for owner
    // callers (the legacy single-user default) so existing behavior is
    // preserved bit-for-bit; non-owner callers get a guidance block
    // pointing the model at the right per-tier behavior. Persona text
    // stays untouched — discretion is configuration, not prose.
    const discretion_block = render_discretion_block(specialist, user);
    const discretion_section = discretion_block
      ? `\n\n${discretion_block}\n\n`
      : '';

    // Per-turn identity resolution (2026-05-31). {{user_name}} is left as a
    // literal token at load (persona_template) so it resolves to the CURRENT
    // turn's speaker here — not the admin baked in at config-load. A persona
    // that reads "what {{user_name}} should know" thus says "Sam" when Sam
    // is the one talking. Falls back to the admin-bound persona for configs
    // with no template (e.g. a hire-generated persona), where the .replace
    // is a harmless no-op.
    // Per-turn household resolution (2026-06-15). The per-user persona tokens
    // ({{user_name}}, {{primary_vehicle}}, {{pet_names}}, {{partner_name}}) were
    // left as literals in the `_template` copies at load; resolve them now from
    // the SPEAKER's profile so Sam's persona reflects Sam (no Ioniq, her own
    // pets), falling back to the global household for the owner and any
    // user-less pass — keeping the owner byte-identical. `strip_deferred_tokens`
    // clears any still-literal deferred token (a bare token a user lacks, no
    // `:default`) so it never reaches the model.
    const stored_profile =
      user?.id && typeof this.deps.memory?.get_user_profile === 'function'
        ? this.deps.memory.get_user_profile(user.id)
        : null;
    const per_user_household = user
      ? resolve_household_for_user({
          base: get_household_context(),
          tier: user.tier ?? 'owner',
          stored: stored_profile,
          display_name: user.display_name,
        })
      : get_household_context();
    // Registry-derived staff paragraph (2026-07-26). Composed HERE rather than
    // written into the YAML because hardcoded staff prose drifts the moment a
    // specialist is folded — which is how Kate kept naming Cassandra for camera
    // alerts, and Anya and Iris after their configs were deleted outright.
    // Generated from the live list, so a fold self-applies on reload.
    const per_turn_context = {
      ...per_user_household,
      staff_roster: render_staff_roster(this.deps.specialists.list(), specialist.id),
    };
    const resolve_name = (t: string): string =>
      strip_deferred_tokens(substitute(t, per_turn_context));
    const persona_text = resolve_name(
      (specialist.persona_template ?? specialist.persona).trim(),
    );
    // Slim voice persona (opt-in). The voice branch prefills THIS instead of the
    // full persona to cut cold-turn TTFT (~1.47s → ~0.37s on the 9B for Kate).
    // Undefined when not configured → voice falls back to the full persona_text.
    const voice_persona_src = specialist.voice_persona_template ?? specialist.voice_persona;
    const voice_persona_text = voice_persona_src
      ? resolve_name(voice_persona_src.trim())
      : undefined;
    const chat_addendum_src = specialist.chat_addendum_template ?? specialist.chat_addendum;
    const chat_addendum_text = chat_addendum_src
      ? resolve_name(chat_addendum_src.trim())
      : undefined;
    const deliberation_addendum_src =
      specialist.deliberation_addendum_template ?? specialist.deliberation_addendum;
    const deliberation_addendum_text = deliberation_addendum_src
      ? resolve_name(deliberation_addendum_src.trim())
      : undefined;

    // Authoritative current-speaker block (conversation + voice surfaces,
    // where a live user is present). Identity comes from login, never
    // inference — this is the fix for a specialist guessing who it's talking
    // to from greeting/tone (Ruby inferred "Sam" from an "Oh hi!").
    const speaker_identity_block = user
      ? `**You are speaking with ${user.display_name}${
          user.tier ? ` (${user.tier})` : ''
        }.** Their identity is established by their login — not by how they ` +
        `greet you, their tone, or their writing style. Never infer or guess ` +
        `who you are talking to; the person named here is who it is. Address ` +
        `them as ${user.display_name}.\n\n`
      : '';

    // Onboarding playbook (2026-06-15) — Kate-led, conversational. Injected
    // once into Kate's CHAT prompt when this speaker has not completed setup,
    // so she runs the "get to know you" interview and writes their per-user
    // profile/facets. Disappears the moment update_user_profile marks them
    // onboarded. Guarded for a mock memory in tests.
    let needs_onboarding = false;
    if (mode === 'conversation' && specialist.id === 'kate' && user?.id) {
      try {
        needs_onboarding = !this.deps.memory.user_profiles.is_onboarded(user.id);
      } catch {
        needs_onboarding = false;
      }
    }
    const onboarding_section = needs_onboarding
      ? render_onboarding_section(user!.display_name)
      : '';

    // Deliberation prompts skip most chat-turn scaffolding — the LLM
    // produces a structured JSON envelope, not user-facing prose, so
    // calendar/weekday/anti-hallucination/promise-followup/scope-
    // discipline blocks are irrelevant and burn prefill budget.
    // Measured 2026-05-19: full prompt at 32K chars / 8K tokens →
    // deliberation timeouts. Slimmed deliberation prompt targets
    // <8K chars / 2K tokens for the system half.
    if (mode === 'deliberation') {
      // Persona-addendum split (added 2026-05-29): scheduled-pass
      // workflow scripts live in `deliberation_addendum` so they don't
      // bloat chat-turn prefill. If unset, behavior is unchanged.
      return (
        persona_text +
        (deliberation_addendum_text ? '\n\n' + deliberation_addendum_text : '') +
        '\n\n' +
        `**THIS SYSTEM PROMPT IS THE TRUTH. INBOX + OBSERVATIONS IN THE USER MESSAGE ARE THE EVIDENCE.**\n\n` +
        `You are running a scheduled deliberation pass. Your output is a structured ` +
        `JSON envelope (shape specified in the user message below), not free-form ` +
        `chat. Tool calls if any should be minimal and direct — the JSON envelope is ` +
        `the work product.\n\n` +
        // Two-tier awareness (2026-08-05). This branch rendered NO tool block at
        // all — the surface was communicated purely through the API's tool_defs
        // array, which is exactly why shrinking that array needs a prose
        // counterpart: without it, a tool moved out of the hot set becomes
        // invisible rather than load-on-demand. Empty unless the pass is running
        // dynamic, so a specialist that hasn't opted in is byte-identical.
        (dynamic && ready_tools
          ? (() => {
              const { rest } = partition_awareness(tools, ready_tools);
              if (rest.length === 0) return '';
              return (
                `Your full toolkit — these exist and you may use them, but their ` +
                `call forms are NOT loaded. To use one, call \`${LOAD_TOOLS_NAME}\` ` +
                `with its exact name and it becomes callable on your next step. ` +
                `The tools already loaded cover this pass's standing duties, so ` +
                `most passes need nothing from this list:\n${compact_catalog_lines(rest)}\n\n`
              );
            })()
          : '') +
        `${peers}\n\n` +
        `Your knowledge scope (vault paths you may read from): ${
          specialist.knowledge_scope.length === 0 ? '(none)' : specialist.knowledge_scope.join(', ')
        }\n\n` +
        discretion_section +
        // Research-efficiency block — structural injection for
        // specialists with proactive.research_workload: true. Empty
        // string when not opted-in, so legacy behavior is unchanged.
        // Deliberation passes for research specialists (Maggie's
        // concert recon, Vivian's morning macro brief) burn rounds
        // the same way chat turns do, so the block injects here too.
        this.render_research_workload_block(specialist) +
        `**Never retry an identical tool call.** If a tool returns empty, errors, or ` +
        `signals "didn't work", do NOT call the same tool with the same arguments — ` +
        `the runtime serves the SAME outcome from cache and the repeat wastes a ` +
        `round. Try a different input, a different tool, or stop calling tools and ` +
        `produce the JSON envelope from what you have.\n\n` +
        `**Loop awareness.** If you've already gathered enough to produce the JSON, ` +
        `stop calling tools and write the envelope. Repeated tool calls past that ` +
        `point burn prefill budget on every round and risk timing out.\n\n` +
        // Grounding rule for the deliberation/brief surface (2026-05-30).
        // This surface previously had NO anti-hallucination guidance at
        // all — Kate's brief is a deliberation pass, so it could state
        // invented dates/events with nothing checking it (the "Bailey's
        // drop-off was today" / fabricated-fact class). The verified
        // context block in the user message is the ONLY fact source here;
        // unlike chat turns this surface should NOT improvise tool calls
        // to fill gaps — it omits or marks-unconfirmed instead.
        `**GROUNDING — the verified context is your ONLY fact source.** ` +
        `Every specific you put in the envelope — a date, a time, an event, ` +
        `a name, a number, a who-said-what — must trace to the verified ` +
        `context block, the inbox/observations, or your memory excerpts in ` +
        `the user message. Do NOT invent dates, times, order numbers, ` +
        `quotes, sources, or events, and do NOT compute a relative date ` +
        `("today", "tomorrow") from anything but the \`now\` value you were ` +
        `given. If a fact isn't in the provided context, it does not go in ` +
        `the envelope — omit it, or mark it explicitly unconfirmed. A brief ` +
        `that states a fabricated event as real is worse than a shorter, ` +
        `fully-grounded one. The verified-context markers (\`fresh\` / ` +
        `\`stale\` / \`unavailable\`) are authoritative: never fill an ` +
        `\`unavailable\` reading with a plausible guess.`
      );
    }

    // Voice-turn path (2026-05-30). A `voice_realtime` turn (the voice surface)
    // runs on the small/fast 9B whose entire value is sub-second
    // time-to-first-token. The full chat scaffold — the "THIS SYSTEM
    // PROMPT IS THE TRUTH" essay, the structural-gaps-to-Beatrice block,
    // the scope-discipline marathon, the weekday-discipline essay, the
    // anti-hallucination decision tree — is multiple thousand tokens of
    // prefill written for heavy 27B research turns. On the 9B that prefill
    // is the dominant latency cost AND, because decoders weight the LAST
    // sections most, it buries the warm persona under cold compliance
    // rules (the "clinical and cold" symptom). The slim voice prompt keeps
    // the persona (warm, recency-weighted as the tail), the chat addendum
    // (the voice specialist's routing table), discretion, the current-time anchor, and a
    // ONE-LINE escalate-don't-guess rule. Everything heavy is dropped —
    // a voice relay escalates rather than reasons, so it doesn't
    // need the research-turn scaffolding.
    if (mode === 'voice') {
      // Two-tier tool block (mirrors the chat prompt): dynamic → hot set + full
      // catalog as load-on-demand; else flat. Voice runs the dynamic surface too
      // now (tool parity, 2026-07-08), so it must render catalog awareness, not
      // just the hot list. Inlined to keep the hot chat path below byte-identical.
      let voice_tool_block: string;
      if (dynamic && ready_tools) {
        const { rest } = partition_awareness(tools, ready_tools);
        const rest_block =
          rest.length === 0
            ? ''
            : `Your full toolkit — these are available to you but their call ` +
              `forms are NOT loaded yet. To use one, first call \`${LOAD_TOOLS_NAME}\` ` +
              `with its exact name (it returns ready immediately; call the tool on ` +
              `your next step). Don't call any of these without loading it first; ` +
              `most turns you won't need to:\n${compact_catalog_lines(rest)}\n\n`;
        voice_tool_block =
          `Tools you can use right now (call these directly):\n${tool_summary(ready_tools)}\n  - ${CONSULT_TOOL_NAME}: ` +
          `consult one of your teammates by id and get a brief answer.\n  - ${LOAD_TOOLS_NAME}: ` +
          `load the call schema for any tool in your full toolkit below.\n\n` +
          rest_block;
      } else {
        voice_tool_block =
          `Tools available to you:\n${tool_summary(tools)}\n  - ${CONSULT_TOOL_NAME}: ` +
          `consult one of your teammates by id and get a brief answer.\n\n`;
      }
      return (
        // Slim voice persona when configured (cuts cold-turn prefill); else the
        // full persona. chat_addendum is dropped under a voice_persona (the slim
        // persona already carries the voice posture; the addendum is chat-turn
        // scaffold) but preserved when falling back to the full persona.
        (voice_persona_text ?? persona_text) +
        (voice_persona_text ? '' : chat_addendum_text ? '\n\n' + chat_addendum_text : '') +
        '\n\n' +
        speaker_identity_block +
        discretion_section +
        // Voice gets a LEAN, speakable time — just the moment, NOT the full
        // format_now_anchor() block (which appends an 8-day weekday→date
        // table + "don't compute day-of-week from ISO dates yourself"). That
        // scaffold is silent reasoning aid for the 27B chat/deliberation
        // models; the realtime 9B reads it ALOUD — the voice path was literally
        // speaking the timestamp + date table (2026-05-30). Plus an explicit
        // "don't announce it unprompted" so she stops volunteering the time.
        // Moved to the tail — see the KV-PREFIX ORDERING note in the chat
        // branch. Same per-minute cache invalidation applied to the voice
        // path, where the latency cost is felt most.
        voice_tool_block +
        `**Don't fabricate.** If a real-world fact (hours, a price, an event ` +
        `time, anything specific to ${user?.display_name ?? 'the household'}) ` +
        `isn't already in front of you, don't guess — call the tool that ` +
        `resolves it, or escalate to the teammate who owns it, or say you'll ` +
        `check. A warm "give me a sec, let me check" beats a confident wrong ` +
        `answer every time.`      );
    }

    // Chat-turn path. The chat addendum carries turn-taking patterns,
    // conversational tone rules, response-shape hints. If unset,
    // behavior is unchanged (persona is the entire scaffold).
    //
    // Dynamic tool surface (2026-06-08): when `dynamic`, render a two-tier tool
    // block — the hot set callable right now, plus the rest of the catalog as
    // load-on-demand via `load_tools` — so the model is AWARE of every tool it
    // can use while only the hot set's schemas ship. Else the flat block (today).
    let tool_block: string;
    if (dynamic && ready_tools) {
      const { rest } = partition_awareness(tools, ready_tools);
      const rest_block =
        rest.length === 0
          ? ''
          : `Your full toolkit — these are available to you but their call ` +
            `forms are NOT loaded yet. To use one, first call \`${LOAD_TOOLS_NAME}\` ` +
            `with its exact name (it returns ready immediately; call the tool on ` +
            `your next step). Don't call any of these without loading it first; ` +
            `most turns you won't need to:\n${compact_catalog_lines(rest)}\n\n`;
      tool_block =
        `Tools you can use right now (call these directly):\n${tool_summary(ready_tools)}\n  - ${CONSULT_TOOL_NAME}: ` +
        `consult one of your teammates by id and get a brief answer.\n  - ${LOAD_TOOLS_NAME}: ` +
        `load the call schema for any tool in your full toolkit below.\n\n` +
        rest_block;
    } else {
      tool_block =
        `Tools available to you:\n${tool_summary(tools)}\n  - ${CONSULT_TOOL_NAME}: ` +
        `consult one of your teammates by id and get a brief answer.\n\n`;
    }
    return (
      persona_text +
      (chat_addendum_text ? '\n\n' + chat_addendum_text : '') +
      '\n\n' +
      speaker_identity_block +
      onboarding_section +
      discretion_section +
      // ── KV-PREFIX ORDERING (2026-07-30) ────────────────────────────────
      // The "**Right now**" anchor used to sit HERE, ahead of tool_block and
      // every instruction block below. format_now_anchor() includes hour AND
      // minute, so the string changed every minute — invalidating the ~8-9K
      // tokens behind it and forcing a FULL prompt re-eval on the first turn
      // of each new minute. Measured on live Kate turns: a same-minute turn
      // re-evaluated ~500 tokens and took ~1.0s; the identical turn one minute
      // later re-evaluated 11,063 tokens and took 3.6s (slot LCP similarity
      // 0.95 -> 0.36). The anchor now lives at the TAIL instead (see below),
      // so a minute tick invalidates a few hundred tokens, not the prompt.
      // Everything from here down is stable across turns and stays cached.
      tool_block +
      `**THIS SYSTEM PROMPT IS THE TRUTH. CONVERSATION HISTORY IS THE RECORD.**\n\n` +
      `Your tool list, knowledge scope, teammate roster, capabilities, and ` +
      `the household facts in this system prompt are REBUILT FRESH every ` +
      `turn from the current state of the system. The conversation below ` +
      `is the record of what was SAID earlier — it does NOT define what ` +
      `is TRUE now. If anything in the conversation history conflicts ` +
      `with this system prompt — a prior reply of yours that said "I ` +
      `don't have a tool to X", a stated fact about Jasper that's been ` +
      `since updated, a teammate's name or domain that's changed, the ` +
      `presumed state of a project — THIS prompt wins. Do not preserve ` +
      `old beliefs out of consistency with what you said before. The ` +
      `model's natural pull is to stay coherent with its prior messages; ` +
      `resist that pull when the live prompt has moved on. Re-derive ` +
      `truth from above each turn; don't carry it forward from below.\n\n` +
      `${peers}\n\n` +
      `Your knowledge scope (vault paths you may read from): ${
        specialist.knowledge_scope.length === 0 ? '(none)' : specialist.knowledge_scope.join(', ')
      }\n\n` +
      // Inbox + knowledge-first snippet: surfaces routed intake items
      // before the LLM commits to "I don't have that." See
      // render_chat_inbox_section() and
      // render_chat_knowledge_first_snippet() for the design notes
      // and the Brigid Dunkin'-cup failure they close.
      this.render_chat_inbox_section(specialist, user?.id) +
      this.render_chat_knowledge_first_snippet(specialist) +
      // Procedures she worked out before (Tier-1 skills). Sits next to the
      // knowledge-first snippet on purpose: both are "check what you already
      // have before you re-derive it" — that one for facts, this one for
      // method. Reading a skill executes nothing; she still makes every call.
      this.render_skills_section(specialist, user) +
      // Browser-failover snippet — for browse_web holders, the "if
      // web_fetch_clean fails/thins, escalate to browse_url on the same
      // URL" rule, lifted from per-persona YAML comments into the runtime
      // (2026-06-26). Covers Firecrawl OUTAGES + bot walls.
      this.render_browser_escalation_snippet(specialist, tools) +
      // Self-appearance — for generate_image holders, what they look like
      // on camera + how to evolve that look mid-conversation via the
      // tool's `self_appearance` override. See
      // render_self_appearance_snippet().
      this.render_self_appearance_snippet(specialist) +
      // Data map — the store-backed read tools on this surface, by name.
      // See render_data_map() for the design notes and the Astrid no-HR
      // incident it closes alongside the data-denial guard.
      this.render_data_map(tools) +
      // Research-efficiency block — structural injection for
      // specialists with proactive.research_workload: true (2026-05-30).
      // Conversation mode adds rule 7, the inline-citation contract
      // (tool results are [S#]-labeled on this surface).
      // Replaces the per-persona "Research efficiency — don't burn
      // rounds" carve-outs. See render_research_workload_block() for
      // the six behaviors and the audit-log failures each one closes.
      this.render_research_workload_block(
        specialist,
        mode === 'conversation' ? 'conversation' : 'deliberation',
      ) +
      // House voice — warm/personable/economical register + this user's learned
      // comm-style + (HEARTH_USER_MODEL) this specialist's domain facets. Dark by
      // default (HEARTH_HOUSE_VOICE=1). Chat path only.
      this.render_house_voice_block(specialist.id, user, stored_profile) +
      `When you respond, write directly to the user in your voice. Use tools ` +
      `when they would actually help; do not narrate the tool call. If you ` +
      `lack a capability needed to complete the request, say so plainly and ` +
      `either delegate (via consult_specialist or delegate_proposal) or ` +
      `explain what the user would need to do.\n\n` +
      this.render_structural_gap_block(specialist) +
      `**Promised follow-ups are binding.** ANY statement in your reply ` +
      `that promises imminent or future work — future tense ("I'll look ` +
      `into that", "I'll get back to you", "I'll send the email") OR ` +
      `present-tense framings of the same intent ("let me fetch X", "let ` +
      `me check Y", "now let me grab Z", "I'm going to look up Q") — is ` +
      `a binding promise. For each such statement in your reply, exactly ` +
      `one of these must be true by the time you stop writing:\n` +
      `  (a) you actually DID the work via a tool_call in this same ` +
      `      response (the tool_call is attached to this turn, not just ` +
      `      narrated as intent), OR\n` +
      `  (b) you called \`promise_followup\` to schedule a continuation ` +
      `      turn (default 2 minutes; you'll get a fresh turn with your ` +
      `      tools to do the work and reply).\n` +
      `A reply that SAYS "let me fetch the next page" but contains no ` +
      `actual fetch tool_call and no promise_followup IS the ghost-promise ` +
      `bug. The user never hears back, and your message reads like a ` +
      `dropped sentence. If you find yourself about to write "let me X" ` +
      `as your closing line — stop and ask: did I actually call the X tool ` +
      `in this response? If no, attach the tool_call NOW or replace the ` +
      `sentence with promise_followup + a clean summary like "I've grabbed ` +
      `2 of the pages so far and want to keep going on the rest — I'll ` +
      `come back in a couple minutes with the full picture."\n\n` +
      // ── Scope discipline / loop awareness ───────────────────────────
      // Added after a real spiral incident (Marguerite, 2026-05-17):
      // user said "review all the pages here, this is my family tree"
      // pointing at a genealogy site with hundreds of cross-linked
      // pages. The LLM read "review all" literally and started
      // enumerating Rioux-1..Rioux-167. Two follow-up "hi" messages
      // resumed the spiral via conversation-history retrieval. The
      // rule: bound the FIRST slice, deliver something, ask for
      // direction. Don't try to do "all of it" against an unknown
      // surface in one turn.
      `**Scope discipline on open-ended asks.** When the user gives you a ` +
      `task whose scope you can't bound from their words alone — "review ` +
      `all the pages here", "check every X", "get all of Y", "look at this ` +
      `site", "research this thoroughly" — DO NOT launch an unbounded ` +
      `tool-call march. Real professionals never just "do all of it" ` +
      `against an unknown surface; they bound the first slice, deliver, ` +
      `and ask. Your first response to such an ask should:\n` +
      `  1. Pick a sensible first slice — the most informative 2-3 ` +
      `     fetches, the first 5 items, the highest-signal entry point. ` +
      `     Not all of it.\n` +
      `  2. Do that work in ONE round of focused tool calls, not a ` +
      `     marathon.\n` +
      `  3. Reply with what you found AND a specific question that lets ` +
      `     the user steer the next slice. Example: "I grabbed the index ` +
      `     and the two direct ancestor pages — there are ~300 family ` +
      `     pages on this site. Do you want the full direct line, all ` +
      `     French-Canadian branches, or one specific generation?"\n\n` +
      `Tool calls have costs: yours (latency), the user's (waiting), and ` +
      `the conversation's (history bloat that primes you into loops on ` +
      `future turns). A 5-page first pass that ends with a good question ` +
      `is better than a 100-page deluge. If the user genuinely wants all ` +
      `of it, they'll say so — and at that point use \`promise_followup\` ` +
      `to schedule continuation turns instead of trying to finish in one.\n\n` +
      `**Loop awareness.** Before each new tool call, glance at this ` +
      `turn's prior tool results in the conversation above. If you've ` +
      `already fetched several pages from the same domain, or run similar ` +
      `searches with diminishing yield, or are working through an ` +
      `enumeration (Rioux-1, Rioux-2, ...) — STOP. Summarize what you ` +
      `have, surface the pattern to the user, ask for direction. ` +
      `Repeating yourself is the most expensive thing you can do; the ` +
      `user can't see your tool calls in real time and will think you're ` +
      `stuck. Better to land a clean partial answer with "want me to keep ` +
      `going?" than to silently grind for 90 seconds.\n\n` +
      `**Never retry an identical tool call.** If a tool call returns an ` +
      `empty body, a "no markdown" / "no results" error, a 404, or any ` +
      `signal that THAT input didn't work — DO NOT call the same tool ` +
      `again with the same arguments. The result will be identical. The ` +
      `correct moves are: (1) try a different input (a different URL, ` +
      `the .html variant instead of .htm, a broader/narrower query), ` +
      `(2) reach for a different tool, or (3) tell the user the lookup ` +
      `failed and ask for the correct value. The runtime catches exact ` +
      `retries and serves the SAME outcome from cache — the repeat ` +
      `costs you a round and surfaces in the audit log as poor ` +
      `judgment.\n\n` +
      // ── Final / recency-biased section ──────────────────────────────
      // This block intentionally lives LAST in the system prompt so it
      // gets the model's strongest attention (Qwen and most decoders
      // weight recent system content most heavily). Earlier sections
      // were being ignored when this lived in the middle.
      `**WEEKDAY DISCIPLINE — READ EVERY TURN.**\n\n` +
      `Before you write ANY weekday name in your reply — "tomorrow", ` +
      `"this Friday", "on Saturday", "the weekend", "next Tuesday" — ` +
      `find that weekday in the 8-day anchor table at the top of this ` +
      `prompt (the "**The next 8 days**" block). The anchor table is ` +
      `the SOLE source of truth for what day of the week today is and ` +
      `what date each upcoming weekday maps to. Do not derive ` +
      `day-of-week from ISO dates yourself; do not assume from your ` +
      `training data; do not extrapolate.\n\n` +
      `Concrete failure mode to NEVER repeat:\n` +
      `  Today is Sunday. User asks about an event on Friday.\n` +
      `  WRONG: "That's tomorrow." (No — tomorrow is Monday.)\n` +
      `  RIGHT: Look at the anchor table. "Friday" is 5 rows down. ` +
      `Reply: "That's this Friday, May 22 — five days out."\n\n` +
      `If a weekday the user mentions isn't in the visible 8-day window, ` +
      `they mean a date >7 days away — ASK which one ("This Friday or ` +
      `next?"). Don't guess.\n\n` +
      `Similarly for "tomorrow": "tomorrow" is whatever the table's ` +
      `Tomorrow: row says, no matter what other context suggests. If ` +
      `you're about to write "tomorrow is <weekday>", verify the ` +
      `weekday matches the Tomorrow: row literally.\n\n` +
      `**GROUNDING RULE — READ EVERY TURN. The test is SOURCE, not topic.**\n\n` +
      `Before you state any specific real-world fact — a name, a date, a ` +
      `who-holds-what-office, a number, a price, an address, a status, a ` +
      `quote, a document/order/case identifier, a "what happened" — ask ONE ` +
      `question: **can I point to where this came from THIS turn?** A valid ` +
      `source is exactly one of:\n` +
      `  (a) a tool result you got this turn,\n` +
      `  (b) the conversation history above,\n` +
      `  (c) the retrieved library section, or\n` +
      `  (d) the current-time block.\n\n` +
      `If YES → state it, drawing from that source.\n` +
      `If NO → you do NOT know it. It does not matter how confident it ` +
      `feels or how plausible it sounds. A fluent, specific, well-formed ` +
      `answer that you generated from memory is STILL a fabrication — the ` +
      `more specific and confident it sounds (an exact order number, a ` +
      `verbatim quote, a precise date), the MORE dangerous it is, because ` +
      `it's the most believable. Your training data is stale and was never ` +
      `a reliable source for specifics; treat anything not in (a)-(d) as ` +
      `something you have to GO GET, not recall.\n\n` +
      `When the answer isn't already in (a)-(d), do exactly one of:\n` +
      `  1. **Fetch it.** If you hold a tool that resolves it — \`web_search\` ` +
      `for anything public (officeholders, current events, named incidents, ` +
      `regulations, hours, prices, news), \`web_fetch_clean\`/\`browse_url\` to ` +
      `read a specific page, \`route\` for travel, \`sensor_calendar_upcoming\` ` +
      `for calendar events, \`search_library\` for vault facts — CALL IT, wait, and answer ` +
      `from the result. Do not also state a guess alongside it.\n` +
      `  2. **Delegate it.** If a teammate owns the domain, ` +
      `\`consult_specialist\` them; relay their answer.\n` +
      `  3. **Say you'll check.** If no tool and no teammate can resolve it ` +
      `this turn: "I don't have that confirmed — want me to look it up?" and ` +
      `STOP. Do not emit the specific fact in the same message. Hedges ("I ` +
      `think", "probably", "if I recall") do NOT license a guess — they just ` +
      `label one.\n\n` +
      `If your shelf is thin on a topic you'll need again, also \`flag_cordelia\` ` +
      `so the source gets curated for next time — but that's durable ` +
      `enrichment, NOT a substitute for grounding THIS answer, and if you ` +
      `mention it at all, say it by function ("I've queued that to be filed"), ` +
      `never by naming the curator.\n\n` +
      `Worked example (a real failure to never repeat): asked who owns the ` +
      `power line that caused a local fire, the WRONG move is to assert ` +
      `"Xcel Energy, per PUC Order E-23734" from memory — that order number ` +
      `and that ownership were both invented and both wrong. The RIGHT move ` +
      `is \`web_search({query: "<fire name> cause utility owner"})\`, read the ` +
      `result, and report what it actually says — including "the source ` +
      `doesn't say" when it doesn't.\n\n` +
      `One fabricated specific costs you the user's trust in everything ` +
      `else you say. The latency of one tool call is always the cheaper price.\n\n` +
      // The reflex table lands HERE on purpose: right after the grounding rule
      // that says "go get it", so the very next thing read is which tool gets
      // it, and right before chat_style so the register tail still owns the
      // final word. See render_tool_reflexes().
      this.render_tool_reflexes(specialist).replace(/\n\n$/, '') +
      // ── chat_style — the character tail (2026-07-03) ──────────────────
      // The compliance essays above are deliberately last-loaded (recency),
      // which leaves HOW the specialist talks — the persona's warmth, tens
      // of thousands of tokens back — in the weakest-attention zone: the
      // exact "clinical and cold" symptom the voice path documented and
      // solved with voice_style as its tail. chat_style is the conversation
      // sibling: an optional per-YAML register block appended LAST so the
      // freshest instruction in the model's head is who it sounds like.
      // Register only — the grounding/honesty essays above stay absolute
      // (a well-authored block says so itself). Opt-in: omitted ≡
      // byte-identical prompt (Kate only today).
      (mode === 'conversation' && specialist.chat_style
        ? `\n\n---\n${specialist.chat_style.trim()}`
        : '')
    );
  }

  /**
   * Test seam — exposes the private system-prompt builder so smokes
   * can assert on its content without standing up a live LLM. Used by
   * smoke-proactive (chat-turn inbox + knowledge-first injection) and
   * future runtime tests that inspect prompt-level behavior. Not part
   * of the runtime's surface for any caller other than tests; the
   * underscore prefix follows the convention used by
   * `_test_set_vl_transport`, `_test_set_ocr_transport`, etc.
   */
  _test_build_system_prompt(
    specialist: LoadedSpecialist,
    tools: Array<{ name: string; description: string }>,
    mode: 'conversation' | 'deliberation' | 'voice' = 'conversation',
    user?: SpecialistTurnInput['user'],
  ): string {
    return this.build_system_prompt(specialist, tools, mode, user);
  }

  /**
   * Test seam — exposes `_curate_tools_for_turn` so smokes can assert
   * the BASE_TOOLSET union behavior without spinning up a turn.
   */
  _test_curate_tools_for_turn<T extends { name: string }>(
    available: T[],
    specialist: LoadedSpecialist,
    llm_role: import('./llm').LLMRole | undefined,
    override?: readonly string[],
  ): T[] {
    return _curate_tools_for_turn(available, specialist, llm_role, override);
  }

  /**
   * Test seam — exposes `_build_turn_surface` so the dynamic-tools smoke can
   * assert catalog/hot composition + the fail-open equivalence with a fake
   * embedder + tools registry wired through deps.
   */
  async _test_build_turn_surface(
    specialist: LoadedSpecialist,
    role: import('./llm').LLMRole | undefined,
    message: string,
    override?: readonly string[],
  ): Promise<{ catalog: Tool[]; hot: Tool[]; dynamic_on: boolean }> {
    return this._build_turn_surface(specialist, role, message, override);
  }

  /**
   * HEARTH_TEST_MODE=1: hand back deterministic responses for known smoke
   * inputs. This lets `bun run smoke:specialists` succeed without a live
   * LLM, since CI / first-run installs may not have Qwen pulled yet.
   */
  private canned_turn(
    specialist: LoadedSpecialist,
    input: SpecialistTurnInput,
    available_tools: Array<{ name: string }>,
  ): SpecialistTurnOutput {
    const intent_id = ulid();
    const text = input.message.content.toLowerCase();
    const tool_calls_made: SpecialistTurnOutput['tool_calls_made'] = [];
    const proposals_created: string[] = [];
    const consulted: string[] = [];
    let message_text = '';

    if (specialist.id === 'kate') {
      if (text.includes('weather') && text.includes('garden')) {
        // Kate consults Eleanor.
        message_text =
          `I'll check with Eleanor — she watches the garden conditions ` +
          `here in Pleasantville. Eleanor (the Master Gardener) ` +
          `pulls the Ecowitt and HA sensors for soil moisture, recent ` +
          `rainfall, and overnight lows; if you want the current ` +
          `numbers, that's her department.`;
        consulted.push('eleanor');
      } else if (text.includes('watered') || text.includes('watering')) {
        // Create a proposal noting the user watered the yard.
        if (available_tools.some((t) => t.name === 'propose_action')) {
          const pid = this.deps.proposals.create({
            specialist_id: 'kate',
            kind: 'recommendation',
            execution_kind: 'none',
            payload: {
              note: 'User watered the front yard today',
              suggested_followup: 'Update Eleanor\'s irrigation log.',
            },
            rationale:
              'Recording an event Eleanor should know about for her next garden pass.',
            signature: {
              specialist_id: 'kate',
              kind: 'yard_event_note',
              category: 'garden',
              anchor: 'front_yard',
            },
          });
          proposals_created.push(pid);
          tool_calls_made.push({
            name: 'propose_action',
            input: { note: 'watered front yard' },
            result: { proposal_id: pid },
          });
        }
        // Quietly consult Eleanor so the smoke can confirm cross-specialist work.
        consulted.push('eleanor');
        this.deps.inbox.push({
          from_specialist_id: 'kate',
          to_specialist_id: 'eleanor',
          kind: 'fyi',
          body_md: 'Jasper watered the front yard today.',
        });
        message_text =
          `Noted — I logged that the front yard got water today and flagged ` +
          `it for Eleanor's next garden pass.`;
      } else {
        message_text = `(test-mode Kate) ${input.message.content.slice(0, 200)}`;
      }
    } else if (
      text.includes('send') &&
      (text.includes('email') || text.includes('message')) &&
      !specialist.granted.has('send_email') &&
      !specialist.granted.has('send_sms')
    ) {
      // Capability-denial smoke: a non-send-capable specialist gets a
      // "send an email" request; respond with delegation.
      message_text =
        `I can't send messages from this seat — that's outside my ` +
        `capabilities. Kate (Chief of Staff) is the one who drafts and ` +
        `sends; I'll flag this for her.`;
    } else if (specialist.id === 'eleanor') {
      message_text =
        `(test-mode Eleanor) The Pleasantville forecast and the Ecowitt ` +
        `soil moisture are both fine right now; nothing in the garden ` +
        `needs your attention today.`;
    } else {
      message_text = `(test-mode ${specialist.name}) ${input.message.content.slice(0, 200)}`;
    }

    this.deps.memory.log_action({
      intent_id,
      agent: specialist.id,
      user_id: input.user?.id,
      tool_name: 'specialist_turn',
      tool_input: {
        conversation_id: input.conversation_id,
        message_summary: input.message.content.slice(0, 200),
        test_mode: true,
      },
      execution_result: {
        tool_calls_count: tool_calls_made.length,
        proposals_count: proposals_created.length,
        consulted,
      },
    });

    return {
      message_text,
      tool_calls_made,
      proposals_created,
      consulted_specialists: consulted,
      reasoning_trace: '',
      cost: { tokens_in: 0, tokens_out: 0, ms: 0, model: 'test-mode' },
    };
  }
}

/**
 * Render the current instant in the user's local timezone, in a shape the
 * LLM can read fluently. "Saturday, May 16, 2026 at 6:42 PM MDT" — full
 * weekday name (so "what day is it?" works) + 12-hour time + zone abbrev
 * (so "is it morning or evening?" works). The zone comes from the iOS
 * device (X-User-Timezone → users.yaml → SpecialistTurnInput.user.timezone);
 * `America/Denver` is only the fallback when no per-user zone is resolved.
 *
 * Intl formatters are non-trivial to construct, so one set is memoized
 * per timezone — threading per-user tz through doesn't rebuild them on
 * every turn, and the household is small so the caches stay tiny.
 */
const _LOCAL_NOW_TZ_FALLBACK = 'America/Denver';

const _now_fmt_cache = new Map<string, Intl.DateTimeFormat>();

function _now_fmt(tz: string): Intl.DateTimeFormat {
  let f = _now_fmt_cache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { // time-guard-ok: per-user-tz "right now" anchor, cached by resolved zone
      timeZone: tz,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
    _now_fmt_cache.set(tz, f);
  }
  return f;
}

/**
 * Lean spoken-time anchor for the voice path: just the current moment in
 * the user's zone — NO 8-day weekday table, NO "don't compute from ISO"
 * meta-instructions. The full `format_now_anchor()` scaffold is silent
 * reasoning aid for the 27B chat/deliberation models; a realtime 9B reads
 * it ALOUD (the voice path was literally speaking the timestamp + the date table).
 * Date-heavy questions escalate to the 27B, which still gets the full anchor.
 */
function _format_voice_now(tz: string = _LOCAL_NOW_TZ_FALLBACK): string {
  return _now_fmt(tz).format(new Date());
}
