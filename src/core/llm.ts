// Provider-agnostic LLM interface. Every call site requests by ROLE; the router
// resolves to the right provider+model+defaults per the config in llm-roles.yaml.

export type LLMRole =
  | 'planner'              // Light structured-JSON parse (fast tier)
  | 'arbiter'              // Agent-room "who speaks next" pick (tiny JSON; see llm-roles.yaml)
  | 'reflector'
  | 'scribe_writer'
  | 'concierge_drafter'
  | 'specialist'           // Conversational chat turn (fast tier, think OFF)
  | 'specialist_thinking'  // Same fast tier as `specialist` but think ON (per-specialist opt-in)
  | 'specialist_deliberation' // Scheduled reflective pass (depth tier, think ON)
  | 'specialist_drafter'   // Voice-imitation drafts (depth tier, think ON)
  | 'deep_consult'         // Escalation target for consult_deep_model — the 122B big judge on forza :8090 (natively VL)
  | 'court_judge_deep'     // The measured-swap court seat (HEARTH_COURT_DEEP_SEAT) — same forza 122B endpoint
  | 'voice_realtime'       // Voice prompt-SHAPE profile; the endpoint rides provider_role:'live' (see llm-roles.yaml)
  | 'live'                 // Interactive chat/voice tier — 35B-A3B on the LLM host :8200, think OFF, 4 slots
  | 'librarian'            // Deep lane :8201, think ON (Cordelia curation + async-verify lane)
  // DEPTH tier — accuracy-critical background extraction (Kristi's spec/price/
  // leak/swimlane passes, the deep-research sub-investigators + synthesis).
  // think OFF, and that is LOAD-BEARING, not a tuning preference: every caller
  // JSON.parse()s the reply, and the 35B-A3B is a hybrid-thinking checkpoint
  // that puts its trace in `reasoning_content` and exhausts max_tokens —
  // leaving `content` EMPTY. llm-roles.yaml sets `think: false` here; do NOT
  // "tidy" it out. Call sites additionally force it AFTER the `...role.defaults`
  // spread so a config regression can't detonate them.
  | 'research_extract'
  | 'judgment'             // LLM-judge guards (fact_critic + siblings) — deep lane; resolve via judgment_role()
  | 'embeddings'
  | 'reranker'
  // Roles are ultimately config-defined in llm-roles.yaml; the literals
  // above are the first-party set, kept for autocomplete. The open tail
  // lets a config-defined role — or a per-specialist `llm_role` — resolve
  // without a cast; the router validates the role exists at call time.
  | (string & {});

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCallSpec[];
  tool_call_id?: string;
}

export interface ToolCallSpec {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: object; // JSON schema
}

export interface LLMRequest {
  messages: LLMMessage[];
  temperature?: number;
  max_tokens?: number;
  tools?: ToolDef[];
  /**
   * Force/suppress tool invocation. `'required'` makes the model emit a tool
   * call via the backend's guided decoding (token masking) — verified on both
   * our backends (beellama + vLLM) with think-OFF; IGNORED when thinking is on.
   * Used to GUARANTEE a fetch on a lookup turn so a stochastic model can't
   * answer a weather/status/price query from memory. Force only the FIRST
   * round — once a tool has run, leave it auto so the model can answer from the
   * result. Omitted ≡ `'auto'` (model decides).
   */
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
  response_format?: { type: 'json_schema'; schema: object };
  preserve_thinking?: boolean; // Qwen 3.6 specific; ignored by other providers
  /**
   * Whether the model should emit a `<think>...</think>` reasoning block
   * before its answer. Qwen 3.6 / DeepSeek-R1 / etc. burn 1-5k hidden
   * tokens per turn when enabled — worth it for deliberation passes and
   * voice-drafting; pure latency tax for routine chat turns. Defaults to
   * `true` to preserve historical behavior; set `false` in llm-roles.yaml
   * for fast-path roles or pass per-call.
   */
  think?: boolean;
  /**
   * External cancellation. Providers MUST forward this to their HTTP
   * fetch so an in-flight generation is aborted at the runner — not
   * just discarded after it finishes. Combined with the provider's own
   * timeout via `AbortSignal.any([signal, AbortSignal.timeout(...)])`.
   */
  signal?: AbortSignal;
  /**
   * Attach an image to the LAST user message in `messages`. The
   * provider transcodes if needed (HEIC → JPEG via ffmpeg) and
   * rebuilds that message's `content` as the standard OpenAI vision
   * shape — `[{type:'text'},{type:'image_url',image_url:{url:'data:...'}}]`.
   *
   * Providers whose `capabilities().supports_vision` is false will
   * silently drop the attachment so a non-vision-capable role still
   * runs (text-only). Callers that need to KNOW whether the image
   * was forwarded should check capabilities first.
   *
   * Active on the LLM host's Qwen3.6 + mmproj (2026-05-26+) — every role
   * resolved to the OpenAI provider becomes vision-bearing for free.
   */
  vision?: {
    /** Absolute filesystem path on the orchestrator host. */
    image_path: string;
  };
}

export interface LLMResponse {
  content: string;
  tool_calls: ToolCallSpec[];
  thinking?: string; // <think> trace if present
  finish_reason: string;
  cost: {
    tokens_in: number;
    tokens_out: number;
    ms: number;
    model: string;
  };
}

export interface LLMCapabilities {
  supports_json_schema: boolean;
  supports_tool_calls: boolean;
  supports_thinking_mode: boolean;
  /**
   * The provider accepts an `LLMRequest.vision` attachment and
   * forwards an image to the model. True for OpenAI-compat providers
   * pointed at a vision-capable endpoint (Qwen3.6 + mmproj on
   * the LLM host as of 2026-05-26); false for text-only inference.
   */
  supports_vision: boolean;
  max_context: number;
  cost_per_1m_in_cents: number;
  cost_per_1m_out_cents: number;
}

/**
 * Incremental output from a streaming completion. Providers emit a
 * sequence of these; each contains either a content delta (token chunk)
 * OR a thinking delta OR the final response (with full text + tool
 * calls + cost). Consumers should accumulate `content_delta` strings
 * for the user-visible body, ignore `thinking_delta` unless they want
 * to surface reasoning, and finalize on the `done` event.
 */
export type LLMStreamEvent =
  | { type: 'content_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'done'; response: LLMResponse };

export interface LLMProvider {
  name: string;
  complete(request: LLMRequest): Promise<LLMResponse>;
  /**
   * Streaming variant. Yields token chunks as they arrive from the
   * provider. Implementations should accumulate content + tool_calls
   * and emit a final `done` event with the assembled LLMResponse.
   * Optional — callers that need streaming should check for it; if
   * the provider can't stream, fall back to complete().
   */
  complete_stream?(request: LLMRequest): AsyncIterable<LLMStreamEvent>;
  capabilities(): LLMCapabilities;
}

export interface RoleResolution {
  provider: LLMProvider;
  defaults: Partial<LLMRequest>;
  model: string;
  /**
   * The COHERENCE target (tokens): how much context this model still reasons
   * well over. An empirical QUALITY number, not a hardware one — Kate's 16384
   * exists because at 49152 the 35B-A3B degenerated into a repetition loop
   * while the server itself reported `truncated=0`.
   *
   * Drives the cumulative tool-result budget. Exceeding it is a quality signal,
   * not an error: a sparse-MoE model loses the thread long before the slot
   * fills, and eviction cannot fix a STATIC prompt that already exceeds it.
   */
  context_window_tokens?: number;
  /**
   * The HARD bound (tokens): what the backing server will physically accept in
   * one request — the per-slot window (ctx-size ÷ np). Exceeding THIS is a 400,
   * not a quality regression.
   *
   * Split out from `context_window_tokens` on 2026-08-03, because one field was
   * doing both jobs and the two numbers differ by 3x on the interactive lane
   * (16384 coherence vs 49152 slot). The prompt trimmer is a safety mechanism
   * for the HARD bound; feeding it the coherence number made it believe every
   * ordinary Kate turn was 2x over. 351 of 353 audited turns logged
   * `still_over`, and 288 of those had evicted NOTHING — the overflow was never
   * in the evictable region. An alarm that fires on every turn is not an alarm.
   *
   * Falls back to `context_window_tokens` when a role declares only one number,
   * so an un-migrated role behaves exactly as it does today.
   */
  max_prompt_tokens?: number;
}

export interface LLMRouter {
  for_role(role: LLMRole): RoleResolution;
}

/**
 * Role resolution for the LLM-judge guards (fact_critic, brief_critic,
 * proposal_critic, data_denial, fabricated_save). Prefers the dedicated
 * `judgment` role (deep lane — no interactive-slot contention, no chat
 * KV-prefix eviction); degrades to the guards' historical `planner` routing
 * if the role is ever dropped from llm-roles.yaml, so a config regression
 * changes WHERE the judges run, never WHETHER they run. (Each guard's own
 * for_role try/catch still fails open if both are missing.)
 */
export function judgment_role(router: LLMRouter): RoleResolution {
  try {
    return router.for_role('judgment');
  } catch {
    return router.for_role('planner');
  }
}
