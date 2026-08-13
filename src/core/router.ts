import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type {
  LLMProvider,
  LLMRequest,
  LLMRole,
  LLMRouter,
  RoleResolution,
} from './llm';
import { OllamaProvider } from './providers/ollama';
import { OpenAIProvider } from './providers/openai';
import { HostMutex, SerializedProvider } from './llm_serializer';

interface RoleConfig {
  provider: 'ollama' | 'openai';
  model: string;
  temperature?: number;
  max_tokens?: number;
  preserve_thinking?: boolean;
  think?: boolean;
  /** Override the provider's fetch timeout for THIS role. Default
   *  is 120s in the provider. Deliberation roles often need more
   *  (long persona + tool schemas + JSON output) so this lets us
   *  bump per-role without affecting chat-path latency budgets. */
  timeout_ms?: number;
  /** Override the OpenAI-compat endpoint URL for THIS role only.
   *  Existing chat/deliberation/depth roles all share the global
   *  OPENAI_BASE_URL (the 27B on :8088). The voice_realtime role
   *  points at a second beellama instance (the 9B on :8089) running
   *  on the A4000 alongside parakeet + cosyvoice. The endpoint
   *  mutex is keyed by the actual chosen URL so 9B and 27B requests
   *  run concurrently — distinct llama-server processes, distinct
   *  GPUs. */
  base_url?: string;
  /** Allow concurrent in-flight requests against this role's endpoint.
   *  Default (false) keeps the strict single-tenant mutex used by the
   *  27B beellama server (one inference at a time). Set true for an
   *  endpoint running `--parallel N` continuous batching (the LIVE
   *  tier on the A4000), so the per-endpoint mutex admits up to
   *  `max_concurrency` requests at once instead of serializing them.
   *  Roles sharing one endpoint (e.g. `live` + `librarian` both on
   *  :8089) share its mutex — set the same concurrency on each; the
   *  first role to resolve the endpoint fixes the slot count. */
  concurrent?: boolean;
  /** Slot count when `concurrent` is true. SHOULD match the server's
   *  `--parallel N` so client-side backpressure lines up with the
   *  server's batch width. Ignored when `concurrent` is false. */
  max_concurrency?: number;
  /** Context window (tokens) of the server backing this role. Used ONLY
   *  to size the runtime's cumulative tool-result budget (a research loop
   *  can't grow the prompt past the window) — never sent to the provider.
   *  SHOULD match the llama-server `--ctx-size` for this endpoint. The
   *  LIVE tier (:8089) is the small one and the overflow-prone chat path,
   *  so keep it in sync with that unit's `--ctx-size`. Unset → the runtime
   *  assumes a conservative default. */
  context_window_tokens?: number;
  /** Hard per-request ceiling (tokens) the backing server will accept — the
   *  per-slot window, ctx-size / np. Distinct from the COHERENCE number above:
   *  exceeding this is a 400, exceeding that one is a quality regression.
   *  Unset → falls back to context_window_tokens (pre-2026-08-03 behaviour). */
  max_prompt_tokens?: number;
}

interface RolesFile {
  roles: Record<string, RoleConfig>;
}

/**
 * A sync source of active per-role overrides (2026-08-01).
 *
 * `for_role()` is sync and sits on the hot path of every LLM request, so this
 * must be sync too — which `bun:sqlite` is. The router CACHES the result for
 * `OVERRIDE_CACHE_MS` so a per-request DB read never becomes the bottleneck;
 * the cache is why a revert lands within ~2s rather than literally instantly,
 * which is the right trade against querying on every completion.
 */
export type RoleOverrideSource = () => Map<string, Partial<RoleConfig>>;

export function role_overrides_enabled(): boolean {
  return process.env.HEARTH_LLM_ROLE_OVERRIDES !== '0';
}

const OVERRIDE_CACHE_MS = 2000;

/** Fields whose change moves a role to a DIFFERENT endpoint mutex. */
export interface EndpointConflict {
  reason: string;
  endpoint: string;
  existing_slots: number;
  requested_slots: number;
}

export interface RouterEnv {
  ollama_base_url: string;
  openai_base_url?: string;
  openai_api_key?: string;
}

export class ConfigLLMRouter implements LLMRouter {
  private providers = new Map<string, LLMProvider>();
  private roles: Record<string, RoleConfig>;
  /**
   * One mutex per LLM endpoint (base URL). Shared by every provider
   * pointing at that endpoint so concurrent inference requests against
   * a single-tenant host (beellama on the LLM host serves one Qwen3.6-27B
   * at a time) serialize cleanly instead of preempting each other
   * mid-stream. See `src/core/llm_serializer.ts` for the why.
   */
  private endpoint_mutexes = new Map<string, HostMutex>();
  /** Hot override layer over the YAML (2026-08-01) — see RoleOverrideSource. */
  private override_source: RoleOverrideSource | undefined;
  private override_cache = new Map<string, Partial<RoleConfig>>();
  private override_cache_until = 0;

  constructor(
    roles_yaml_path: string,
    private env: RouterEnv,
  ) {
    const raw = readFileSync(roles_yaml_path, 'utf8');
    const parsed = parse(raw) as RolesFile;
    this.roles = parsed.roles ?? {};
  }

  /**
   * The YAML config for a role, with any active override merged over it.
   *
   * Fail-open at every step: no source wired, the kill switch set, or a
   * throwing source all resolve to the base config — an override layer must
   * never be able to take inference down.
   */
  private effective_config(role: LLMRole): RoleConfig | undefined {
    const base = this.roles[role];
    if (!base || !this.override_source || !role_overrides_enabled()) return base;
    const now = Date.now();
    if (now >= this.override_cache_until) {
      try {
        this.override_cache = this.override_source();
      } catch {
        this.override_cache = new Map();
      }
      this.override_cache_until = now + OVERRIDE_CACHE_MS;
    }
    const patch = this.override_cache.get(role);
    if (!patch) return base;
    return { ...base, ...patch };
  }

  /** Wire the override source. Idempotent; pass undefined to detach. */
  set_override_source(source: RoleOverrideSource | undefined): void {
    this.override_source = source;
    this.override_cache = new Map();
    this.override_cache_until = 0;
  }

  /** Drop the cache so the next `for_role` re-reads — called by the write path
   *  so an apply/revert takes effect on the next request, not up to 2s later. */
  invalidate_override_cache(): void {
    this.override_cache_until = 0;
  }

  /**
   * Would this patch land `role` on an endpoint whose mutex is ALREADY built
   * with a different slot count? Returns the conflict, or null when safe.
   *
   * THIS IS THE ONE REAL HAZARD in hot-swapping a role. The endpoint mutex is
   * created once per `provider::base_url` by the FIRST role to resolve it, and
   * a Semaphore's slot count is fixed at construction — there is no resize. So:
   *
   *  - Changing `model` alone keeps the same base_url, therefore the same
   *    endpoint_key, therefore the same mutex. Always safe, and it is the
   *    overwhelmingly common case (swap which model serves a role).
   *  - Changing `base_url` moves the role onto a different mutex. If that
   *    endpoint has no mutex yet, this role's own concurrency builds it —
   *    fine. If it already has one with a DIFFERENT width, the role would
   *    silently inherit the wrong backpressure: too few slots serializes the
   *    batch away, too many stampedes past the server's `--parallel N`.
   *
   * We REFUSE that case rather than papering over it, and name both numbers so
   * the caller can set `max_concurrency` to match and retry.
   */
  check_endpoint_conflict(role: LLMRole, patch: Partial<RoleConfig>): EndpointConflict | null {
    const base = this.roles[role];
    if (!base) return null;
    const merged = { ...base, ...patch } as RoleConfig;
    if (merged.provider !== 'openai') return null;
    const next_url = merged.base_url ?? this.env.openai_base_url;
    const cur_url = base.base_url ?? this.env.openai_base_url;
    if (!next_url || next_url === cur_url) return null; // same endpoint → same mutex

    const endpoint_key = `openai::${next_url}`;
    const existing = this.endpoint_mutexes.get(endpoint_key);
    if (!existing) return null; // first resolver of this endpoint fixes the width

    const requested = merged.concurrent ? Math.max(1, merged.max_concurrency ?? 4) : 1;
    const existing_slots = existing.max_slots();
    if (existing_slots === requested) return null;
    return {
      reason:
        `Endpoint ${next_url} already has a ${existing_slots}-slot mutex (fixed by the first role ` +
        `to resolve it and not resizable), but this override asks for ${requested}. Landing the role ` +
        `there would give it the wrong backpressure — too few slots serializes the batch away, too ` +
        `many stampedes past the server's --parallel N. Set max_concurrency: ${existing_slots} to ` +
        `match, or point at an endpoint no role is using yet.`,
      endpoint: next_url,
      existing_slots,
      requested_slots: requested,
    };
  }

  for_role(role: LLMRole): RoleResolution {
    const config = this.effective_config(role);
    if (!config) throw new Error(`No config for LLM role: ${role}`);

    const provider = this.get_or_create_provider(config);
    const defaults: Partial<LLMRequest> = {};
    if (config.temperature !== undefined) defaults.temperature = config.temperature;
    if (config.max_tokens !== undefined) defaults.max_tokens = config.max_tokens;
    if (config.preserve_thinking !== undefined)
      defaults.preserve_thinking = config.preserve_thinking;
    if (config.think !== undefined) defaults.think = config.think;

    return {
      provider,
      defaults,
      model: config.model,
      ...(config.context_window_tokens !== undefined
        ? { context_window_tokens: config.context_window_tokens }
        : {}),
      // Fall back to the coherence number so a role that declares only one
      // value keeps today's exact behaviour.
      ...(config.max_prompt_tokens !== undefined || config.context_window_tokens !== undefined
        ? { max_prompt_tokens: config.max_prompt_tokens ?? config.context_window_tokens }
        : {}),
    };
  }

  /**
   * Resolve the raw HTTP endpoint (base_url + model + api_key) for an
   * OpenAI-provider role, WITHOUT going through the chat `complete()`
   * provider. Used by the RAG embeddings/rerank client, whose wire shape
   * (`/v1/embeddings`, `/rerank`) isn't a chat completion. Returns null
   * when the role is undefined, isn't an `openai` role, or has no resolvable
   * base_url — so the caller wires a NoopEmbedder and stays FTS-only.
   */
  endpoint_for_role(
    role: LLMRole,
  ): { base_url: string; model: string; api_key?: string } | null {
    // Override-aware too: an embeddings/rerank role swapped hot must not leave
    // this raw-endpoint path pointing at the pre-override model.
    const config = this.effective_config(role);
    if (!config || config.provider !== 'openai') return null;
    const base_url = config.base_url ?? this.env.openai_base_url;
    if (!base_url) return null;
    return {
      base_url,
      model: config.model,
      ...(this.env.openai_api_key ? { api_key: this.env.openai_api_key } : {}),
    };
  }

  private get_or_create_provider(cfg: RoleConfig): LLMProvider {
    // Cache key includes timeout AND base_url override — two roles pointing
    // at the same model/provider but with different timeout budgets or
    // different endpoint URLs get distinct provider instances. Each
    // endpoint also gets its own mutex so 9B (voice path) and 27B (chat +
    // deliberation) run concurrently against distinct llama-server
    // processes on distinct GPUs.
    const key = `${cfg.provider}::${cfg.model}::${cfg.timeout_ms ?? 'default'}::${cfg.base_url ?? 'env'}`;
    const existing = this.providers.get(key);
    if (existing) return existing;

    let inner: LLMProvider;
    let endpoint_key: string;
    if (cfg.provider === 'ollama') {
      endpoint_key = `ollama::${this.env.ollama_base_url}`;
      inner = new OllamaProvider({
        base_url: this.env.ollama_base_url,
        model: cfg.model,
      });
    } else if (cfg.provider === 'openai') {
      const base_url = cfg.base_url ?? this.env.openai_base_url;
      if (!base_url || !this.env.openai_api_key) {
        throw new Error(
          `OpenAI provider requested for model ${cfg.model} but base_url (per-role or OPENAI_BASE_URL) / OPENAI_API_KEY not configured`,
        );
      }
      endpoint_key = `openai::${base_url}`;
      inner = new OpenAIProvider({
        base_url,
        api_key: this.env.openai_api_key,
        model: cfg.model,
        timeout_ms: cfg.timeout_ms,
      });
    } else {
      throw new Error(`Unknown provider: ${(cfg as RoleConfig).provider}`);
    }

    // Wrap every provider with the per-endpoint serializer. Concurrent
    // calls against the same host queue at the LLM layer so beellama's
    // single-tenant inference loop never sees overlapping requests.
    // Mutex is keyed by `provider::base_url` so Ollama and OpenAI at
    // the same hostname stay independent (they're different processes
    // on the same box), but two OpenAI providers at the same base
    // share one queue.
    let mutex = this.endpoint_mutexes.get(endpoint_key);
    if (!mutex) {
      // A `concurrent` role's endpoint admits N requests at once
      // (continuous batching on the A4000 LIVE tier); everything else
      // stays strictly single-tenant (the 27B). First role to resolve
      // an endpoint fixes its slot count — co-located roles set the
      // same `max_concurrency`.
      const slots = cfg.concurrent ? Math.max(1, cfg.max_concurrency ?? 4) : 1;
      mutex = new HostMutex(slots);
      this.endpoint_mutexes.set(endpoint_key, mutex);
    }
    const wrapped: LLMProvider = new SerializedProvider(inner, mutex);

    this.providers.set(key, wrapped);
    return wrapped;
  }
}
