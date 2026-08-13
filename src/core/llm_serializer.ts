/**
 * Per-endpoint LLM serializer — wraps an LLMProvider so all calls
 * targeting the same backend (beellama, Ollama, OpenAI host) serialize
 * through a shared FIFO queue.
 *
 * Why
 * ---
 * Beellama on the LLM host serves a SINGLE Qwen3.6-27B model and is
 * single-tenant: when a second inference request arrives mid-stream, it
 * aborts the first. Before this wrapper, two specialists chatting with
 * the user in parallel — Kate on conversation A, Anya on B — would
 * collide at the beellama layer; Kate's stream would silently drop and
 * the iOS typing indicator would dangle until the OpenAI provider's
 * idle timeout fired (default 120s on the LLM host; up to several minutes
 * for synthesis-heavy roles). The user saw "Kate stopped responding"
 * with no actual reply landing for a long time.
 *
 * The per-CONVERSATION queue in `routes/specialists.ts`
 * (`serialize_per_conversation`) handles concurrent turns inside ONE
 * conversation but intentionally lets different conversations run in
 * parallel — a contract that's only valid when the underlying model
 * host can serve them in parallel. Beellama can't. The serializer
 * closes that gap at the right layer (the LLM provider) so the route's
 * intent — concurrent conversations — still expresses correctly, with
 * actual queueing happening transparently at the model host.
 *
 * Shape
 * -----
 * Mirrors the Promise-chain mutex pattern from
 * `serialize_per_conversation` — each acquirer awaits the prior chain
 * tail then registers its own. Errors in earlier turns DO NOT block
 * later ones (`prior.catch(() => {})`). For streaming providers, the
 * lock is held for the full lifetime of the stream — from before the
 * inner provider sees the request until the AsyncIterable is exhausted
 * or errors. Cross-specialist parallelism at the model layer is
 * sacrificed because beellama can't deliver it anyway; specialists
 * still execute concurrently above the model call (tool dispatch,
 * vault reads, etc.).
 *
 * One `HostMutex` instance is shared across every `SerializedProvider`
 * pointing at the same endpoint base URL. The router owns the
 * `Map<endpoint_key, HostMutex>` and threads the same mutex into each
 * provider it constructs for that endpoint.
 *
 * Failure modes that this DOESN'T close (kept honest):
 *   - Beellama crashing mid-stream is still a stream-error path; the
 *     runtime's existing fallback ("I lost my train of thought…") and
 *     `specialist_thinking: finished` emit handle that.
 *   - A specialist holding the lock indefinitely (a hung HTTP request)
 *     blocks the next acquirer. The provider's own `timeout_ms` is the
 *     ceiling — 120s default; deliberation roles bumped to 240s. If a
 *     longer ceiling is ever needed, raise it at the provider, not
 *     here.
 */

import type {
  LLMCapabilities,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
} from './llm';
import { Semaphore } from './semaphore';

/**
 * The per-endpoint inference mutex IS the shared {@link Semaphore} (extracted to
 * [semaphore.ts](./semaphore.ts) so the Firecrawl scrape limiter reuses the same
 * battle-tested FIFO/idempotent-release algorithm). `HostMutex` is kept as the
 * name the router + smoke import.
 *
 * `max_concurrency = 1` is a strict mutex — the single-tenant 27B beellama
 * endpoint (one inference at a time; a second request mid-stream aborts the
 * first). The LIVE tier's server runs `--parallel N` continuous batching, so its
 * endpoint gets `max_concurrency = N`: up to N turns generate at once, the
 * (N+1)th queues client-side instead of stampeding the server. Backpressure
 * preserved, concurrency unlocked.
 */
export { Semaphore as HostMutex };

/**
 * LLMProvider wrapper that serializes complete() + complete_stream()
 * through a shared mutex. Use one mutex per endpoint URL; share across
 * every provider pointed at the same host.
 *
 * `complete_stream` is assigned conditionally in the constructor so a
 * SerializedProvider over a non-streaming inner provider correctly
 * reports `complete_stream === undefined` (callers do
 * `provider.complete_stream?.(req)` to feature-detect).
 */
export class SerializedProvider implements LLMProvider {
  readonly name: string;
  readonly complete_stream?: (
    request: LLMRequest,
  ) => AsyncIterable<LLMStreamEvent>;

  constructor(
    private readonly inner: LLMProvider,
    private readonly mutex: Semaphore,
  ) {
    this.name = `${inner.name}<serialized>`;
    if (inner.complete_stream) {
      const inner_fn = inner.complete_stream.bind(inner);
      const mutex_ref = this.mutex;
      this.complete_stream = (request: LLMRequest) =>
        (async function* () {
          const release = await mutex_ref.acquire();
          try {
            for await (const ev of inner_fn(request)) {
              yield ev;
            }
          } finally {
            release();
          }
        })();
    }
  }

  capabilities(): LLMCapabilities {
    return this.inner.capabilities();
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const release = await this.mutex.acquire();
    try {
      return await this.inner.complete(request);
    } finally {
      release();
    }
  }

  /** Exposed for the smoke test only. */
  _mutex_for_test(): Semaphore {
    return this.mutex;
  }
}
