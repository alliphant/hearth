import type {
  LLMCapabilities,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
} from '../llm';

export interface OllamaConfig {
  base_url: string; // e.g. 'http://localhost:11434'
  model: string; // e.g. 'qwen3.6:35b-a3b-q5'
  timeout_ms?: number;
}

export class OllamaProvider implements LLMProvider {
  public name = 'ollama';

  constructor(private config: OllamaConfig) {}

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const t0 = performance.now();

    const options: Record<string, unknown> = {};
    if (request.temperature !== undefined) options.temperature = request.temperature;
    if (request.max_tokens !== undefined) options.num_predict = request.max_tokens;

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      stream: false,
      options,
    };

    // Ollama accepts a top-level `think` boolean on /api/chat to gate
    // the model's <think>...</think> reasoning. We default to ON for
    // backwards compatibility; routes that want a fast chat reply pass
    // `think: false` and avoid 30-60s of hidden reasoning per turn.
    if (request.think === false) body.think = false;
    if (request.think === true) body.think = true;

    // Qwen 3.6 thinking-trace preservation across turns
    if (request.preserve_thinking) {
      body.template_kwargs = { preserve_thinking: true };
    }

    // JSON-schema constrained output (Ollama recent versions accept a JSON
    // schema object directly in the `format` field).
    if (request.response_format?.type === 'json_schema') {
      body.format = request.response_format.schema;
    }

    // Tool calling
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    // Per-call timeout: explicit config wins; otherwise honor
    // OLLAMA_TIMEOUT_MS env (lets long-context out-of-band scripts —
    // e.g. style-loop — extend the deadline without affecting interactive
    // orchestrator turns). Default 120s.
    const env_timeout = parseInt(process.env.OLLAMA_TIMEOUT_MS ?? '', 10);
    // 600s default: the integrated AI accelerator gfx1151 has large VRAM but modest
    // tokens/sec — multi-round chat turns with growing context (each
    // round re-evaluates the accumulated prompt) can take 60-180s of
    // prompt eval alone before generation begins. 300s was tripping
    // on legitimate slow rounds; 600s is comfortable headroom. Tool
    // result truncation (see tool_result_compaction.ts) keeps context
    // bounded so even 600s is rarely needed. Override per-deploy via
    // OLLAMA_TIMEOUT_MS env var or config.timeout_ms.
    const timeout_ms =
      this.config.timeout_ms ??
      (Number.isFinite(env_timeout) && env_timeout > 0 ? env_timeout : 600_000);
    const signal = _compose_signal(request.signal, timeout_ms);
    const res = await fetch(`${this.config.base_url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      throw new Error(`Ollama API error ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as {
      message: {
        content: string;
        tool_calls?: Array<{
          function: { name: string; arguments: Record<string, unknown> };
        }>;
      };
      done_reason?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };

    // Extract leading <think>...</think> block if present
    let content = json.message.content ?? '';
    let thinking: string | undefined;
    const think_match = content.match(/^<think>([\s\S]*?)<\/think>\s*/);
    if (think_match) {
      const [full, inner] = think_match;
      if (full !== undefined && inner !== undefined) {
        thinking = inner.trim();
        content = content.slice(full.length);
      }
    }

    const tool_calls = (json.message.tool_calls ?? []).map((tc, i) => ({
      id: `call_${i}`,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));

    return {
      content,
      tool_calls,
      thinking,
      finish_reason: json.done_reason ?? 'stop',
      cost: {
        tokens_in: json.prompt_eval_count ?? 0,
        tokens_out: json.eval_count ?? 0,
        ms: Math.round(performance.now() - t0),
        model: this.config.model,
      },
    };
  }

  /**
   * Streaming completion. Uses Ollama's NDJSON streaming output —
   * each line is a JSON object with a `message.content` delta and
   * optional `message.tool_calls` on the final line. We accumulate
   * the full text and tool_calls and emit a `done` event when the
   * stream closes.
   *
   * Qwen's `<think>...</think>` block streams as ordinary content;
   * we detect the boundary and route the inner content to
   * `thinking_delta` events. Consumers wanting only user-visible
   * text can ignore thinking_delta entirely.
   */
  async *complete_stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const t0 = performance.now();
    const options: Record<string, unknown> = {};
    if (request.temperature !== undefined) options.temperature = request.temperature;
    if (request.max_tokens !== undefined) options.num_predict = request.max_tokens;

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      stream: true,
      options,
    };
    if (request.think === false) body.think = false;
    if (request.think === true) body.think = true;
    if (request.preserve_thinking) body.template_kwargs = { preserve_thinking: true };
    if (request.response_format?.type === 'json_schema') {
      body.format = request.response_format.schema;
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const env_timeout = parseInt(process.env.OLLAMA_TIMEOUT_MS ?? '', 10);
    // 600s default: the integrated AI accelerator gfx1151 has large VRAM but modest
    // tokens/sec — multi-round chat turns with growing context (each
    // round re-evaluates the accumulated prompt) can take 60-180s of
    // prompt eval alone before generation begins. 300s was tripping
    // on legitimate slow rounds; 600s is comfortable headroom. Tool
    // result truncation (see tool_result_compaction.ts) keeps context
    // bounded so even 600s is rarely needed. Override per-deploy via
    // OLLAMA_TIMEOUT_MS env var or config.timeout_ms.
    const timeout_ms =
      this.config.timeout_ms ??
      (Number.isFinite(env_timeout) && env_timeout > 0 ? env_timeout : 600_000);
    // Idle-stream timeout: if no token arrives for this long, abort
    // the request. Streaming Ollama can stall mid-generation (model
    // crash, ROCm hang, queued behind another request) and the user
    // is left staring at a frozen bubble. Catches the hang within
    // 45s instead of the full total timeout. Override via
    // OLLAMA_IDLE_TIMEOUT_MS env var.
    const idle_env = parseInt(process.env.OLLAMA_IDLE_TIMEOUT_MS ?? '', 10);
    const idle_timeout_ms =
      Number.isFinite(idle_env) && idle_env > 0 ? idle_env : 45_000;
    const idle_controller = new AbortController();
    let idle_timer: ReturnType<typeof setTimeout> | null = null;
    const reset_idle = (): void => {
      if (idle_timer) clearTimeout(idle_timer);
      idle_timer = setTimeout(() => {
        idle_controller.abort(
          new Error(
            `Ollama stream idle for ${idle_timeout_ms}ms (no tokens) — aborting`,
          ),
        );
      }, idle_timeout_ms);
    };
    const total_signal = _compose_signal(request.signal, timeout_ms);
    if (total_signal.aborted) idle_controller.abort(total_signal.reason);
    else total_signal.addEventListener('abort', () => idle_controller.abort(total_signal.reason));
    const signal = idle_controller.signal;
    reset_idle();
    const res = await fetch(`${this.config.base_url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      if (idle_timer) clearTimeout(idle_timer);
      throw new Error(`Ollama API error ${res.status}: ${await res.text()}`);
    }

    // Accumulators.
    let raw_content = '';
    let emitted_content_len = 0;
    let emitted_thinking_len = 0;
    let prompt_eval_count = 0;
    let eval_count = 0;
    let done_reason = 'stop';
    let tool_calls: NonNullable<LLMResponse['tool_calls']> = [];

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
    while (true) {
      const { value, done } = await reader.read();
      // Any read activity (including the eventual `done` close) resets
      // the idle timer; only true mid-stream silence triggers abort.
      reset_idle();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl_idx: number;
      while ((nl_idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl_idx).trim();
        buffer = buffer.slice(nl_idx + 1);
        if (!line) continue;
        let frame: {
          message?: {
            content?: string;
            tool_calls?: Array<{
              function: { name: string; arguments: Record<string, unknown> };
            }>;
          };
          done?: boolean;
          done_reason?: string;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        const chunk = frame.message?.content ?? '';
        if (chunk) {
          raw_content += chunk;
          // Re-derive current content + thinking from the full
          // accumulated string. Diff against what we've already
          // emitted; yield only the new tail.
          const split = _split_content_thinking(raw_content);
          if (split.thinking.length > emitted_thinking_len) {
            const delta = split.thinking.slice(emitted_thinking_len);
            emitted_thinking_len = split.thinking.length;
            yield { type: 'thinking_delta', delta };
          }
          if (split.content.length > emitted_content_len) {
            const delta = split.content.slice(emitted_content_len);
            emitted_content_len = split.content.length;
            yield { type: 'content_delta', delta };
          }
        }
        if (frame.message?.tool_calls) {
          tool_calls = frame.message.tool_calls.map((tc, i) => ({
            id: `call_${i}`,
            name: tc.function.name,
            arguments: tc.function.arguments,
          }));
        }
        if (frame.done) {
          if (frame.done_reason) done_reason = frame.done_reason;
          if (frame.prompt_eval_count !== undefined)
            prompt_eval_count = frame.prompt_eval_count;
          if (frame.eval_count !== undefined) eval_count = frame.eval_count;
        }
      }
    }
    } finally {
      // Stream ended (success, error, or idle-abort) — stop the timer
      // so the controller doesn't fire spuriously after we're done.
      if (idle_timer) clearTimeout(idle_timer);
    }

    // Final split for the done event.
    const final_split = _split_content_thinking(raw_content);
    const content = final_split.content;
    const thinking = final_split.thinking || undefined;

    const final: LLMResponse = {
      content,
      tool_calls,
      thinking: thinking || undefined,
      finish_reason: done_reason,
      cost: {
        tokens_in: prompt_eval_count,
        tokens_out: eval_count,
        ms: Math.round(performance.now() - t0),
        model: this.config.model,
      },
    };
    yield { type: 'done', response: final };
  }

  capabilities(): LLMCapabilities {
    return {
      supports_json_schema: true,
      supports_tool_calls: true,
      supports_thinking_mode: this.config.model.startsWith('qwen3.6'),
      // The Ollama path is text-only today; vision routes go through
      // the OpenAI provider (the LLM host's mmproj-enabled endpoint).
      supports_vision: false,
      max_context: 262_144,
      cost_per_1m_in_cents: 0,
      cost_per_1m_out_cents: 0,
    };
  }
}

/**
 * Compose an external cancel signal with the per-call timeout. Either
 * firing aborts the fetch — caller's `AbortError` flows up so the
 * runtime can write a "(stopped)" message instead of a stack trace.
 */
function _compose_signal(
  external: AbortSignal | undefined,
  timeout_ms: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeout_ms);
  if (!external) return timeout;
  return AbortSignal.any([external, timeout]);
}

/**
 * Split the accumulated raw streaming output into user-visible content
 * and the `<think>...</think>` reasoning block. Pure / stateless — the
 * caller diffs the result against what they've already emitted.
 *
 * Cases:
 *   - No <think> at all → all content.
 *   - <think>...</think> at the start → split cleanly.
 *   - Mid-stream, inside <think> with no closing tag yet → everything
 *     after the open tag is thinking-in-progress; content is just
 *     whatever was before the tag (usually empty).
 *
 * Qwen 3.6 always emits <think> first, then the closer, then content.
 * If a model emits multiple think blocks we only honor the first.
 */
function _split_content_thinking(raw: string): {
  content: string;
  thinking: string;
} {
  const open = raw.indexOf('<think>');
  if (open === -1) return { content: raw, thinking: '' };
  const pre = raw.slice(0, open);
  const after_open = raw.slice(open + '<think>'.length);
  const close = after_open.indexOf('</think>');
  if (close === -1) return { content: pre, thinking: after_open };
  const thinking = after_open.slice(0, close);
  const tail = after_open.slice(close + '</think>'.length).replace(/^\s+/, '');
  return { content: pre + tail, thinking };
}
