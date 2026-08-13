import type {
  LLMCapabilities,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  ToolCallSpec,
} from '../llm';
import { ensure_jpeg_for_vl, data_url_for } from '../image_transcode';

/**
 * Recover tool calls a model emitted as plain CONTENT instead of via the
 * structured tool-call channel.
 *
 * Claude-distilled finetunes (notably `Qwen3.5-9B-Heretic` with thinking
 * OFF) sometimes express a tool call in a hybrid XML dialect that no
 * backend parser catches — it opens with `<tool_code>` where llama.cpp's
 * Qwen parser expects `<tool_call>`, so the whole thing falls through
 * into `content`:
 *
 *   <tool_code>
 *   <tool_name>web_search</tool_name>
 *   <parameter=query>Bitcoin price today USD</parameter>
 *   <parameter=max_results>5</parameter>
 *   </function>
 *   </tool_call>
 *
 * `_parse_tool_code_dialect` turns that back into real ToolCallSpecs;
 * `_strip_tool_code` removes the dialect (and bare `<tool_code>`
 * narration blocks) from the visible reply. Same spirit as
 * tool_registry's `_normalize_qwen_tool_args` — meet the model where it
 * is rather than let a fixable quirk read as a broken turn.
 */
function _coerce_param(raw: string): unknown {
  // Valid JSON (number, bool, object, array, quoted string) is parsed so
  // `5` arrives as a number; bare prose stays a string.
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function _parse_tool_code_dialect(content: string): ToolCallSpec[] {
  if (!content.includes('<tool_name>')) return [];
  const name_re = /<tool_name>\s*([\s\S]*?)\s*<\/tool_name>/g;
  const names: Array<{ name: string; from: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = name_re.exec(content)) !== null) {
    names.push({ name: (m[1] ?? '').trim(), from: name_re.lastIndex });
  }
  const calls: ToolCallSpec[] = [];
  for (let i = 0; i < names.length; i++) {
    const cur = names[i]!;
    if (!cur.name) continue;
    const to = i + 1 < names.length ? names[i + 1]!.from : content.length;
    const segment = content.slice(cur.from, to);
    const args: Record<string, unknown> = {};
    const param_re = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;
    let p: RegExpExecArray | null;
    while ((p = param_re.exec(segment)) !== null) {
      const key = (p[1] ?? '').trim();
      if (key) args[key] = _coerce_param((p[2] ?? '').trim());
    }
    calls.push({
      id: `tc_${Math.random().toString(36).slice(2, 14)}`,
      name: cur.name,
      arguments: args,
    });
  }
  return calls;
}

function _strip_tool_code(content: string): string {
  let s = content;
  // Well-formed <tool_code>...</tool_code> blocks (a tool call the model
  // wrapped, OR a bare deliberation block) — drop whole.
  s = s.replace(/<tool_code>[\s\S]*?<\/tool_code>/g, '');
  // An unclosed dialect run is always the message tail — cut from its
  // first tag to the end.
  const tail = s.search(/<tool_code>|<tool_call>|<tool_name>|<function[ =>]/);
  if (tail >= 0) s = s.slice(0, tail);
  // Orphan stray tags.
  s = s.replace(/<\/?(tool_code|tool_call|function)[^>]*>/g, '');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

export interface OpenAIConfig {
  base_url: string; // e.g. 'https://api.openai.com/v1'
  api_key: string;
  model: string;
  timeout_ms?: number;
}

// Works with any OpenAI-compatible /chat/completions endpoint:
// OpenAI, Anthropic via litellm/openrouter proxies, Nous-hosted Hermes,
// vLLM/llama.cpp servers with --api-key.
export class OpenAIProvider implements LLMProvider {
  public name = 'openai';

  constructor(private config: OpenAIConfig) {}

  /**
   * Rebuild the LAST user message's `content` to attach a vision image,
   * if `request.vision` is set AND the provider advertises vision
   * capability. Returns:
   *   - the (possibly-mutated) messages array
   *   - a `cleanup` to call after the request completes (removes a
   *     HEIC→JPEG temp file when one was created); no-op when no
   *     image was attached.
   *
   * Failure to transcode throws — the caller asked for vision and the
   * model can't read the file we have. Falling through to text-only
   * would silently degrade the call, which is the wrong default for
   * "I just paid 100ms of latency to send you this photo."
   */
  private async _attach_vision(
    messages: unknown[],
    request: LLMRequest,
  ): Promise<{ messages: unknown[]; cleanup: () => void }> {
    if (!request.vision) {
      return { messages, cleanup: () => {} };
    }
    if (!this.capabilities().supports_vision) {
      // Provider isn't vision-capable; drop attachment silently so a
      // non-vision endpoint still runs the text portion.
      return { messages, cleanup: () => {} };
    }
    const img = await ensure_jpeg_for_vl(request.vision.image_path);
    const data_url = data_url_for(img);
    // Find the LAST user message (where the image semantically belongs).
    let last_user_idx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { role?: string };
      if (m.role === 'user') {
        last_user_idx = i;
        break;
      }
    }
    if (last_user_idx === -1) {
      // No user message — synthesize one. This shouldn't happen in
      // practice but keeps the contract explicit.
      const next = messages.slice();
      next.push({
        role: 'user',
        content: [
          { type: 'text', text: '(see attached image)' },
          { type: 'image_url', image_url: { url: data_url } },
        ],
      });
      return { messages: next, cleanup: img.cleanup ?? (() => {}) };
    }
    const next = messages.slice();
    const orig = messages[last_user_idx] as { role: string; content: unknown };
    const text =
      typeof orig.content === 'string' && orig.content.length > 0
        ? orig.content
        : '(see attached image)';
    next[last_user_idx] = {
      ...orig,
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: data_url } },
      ],
    };
    return { messages: next, cleanup: img.cleanup ?? (() => {}) };
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const t0 = performance.now();

    // Transform assistant tool_calls from Hearth's canonical flat
    // shape ({id, name, arguments: object}) into the OpenAI shape
    // that llama-server / Lemonade strictly require on replay:
    // {id, type:"function", function:{name, arguments: stringified}}.
    // Without this, a multi-turn tool-using conversation crashes on
    // the second round because the model's prior tool_calls come
    // back unrecognized. Done here (not upstream in specialist_runtime)
    // so the rest of the codebase keeps one shape.
    const messages_pre = request.messages.map((m) => {
      const msg = m as { role: string; tool_calls?: unknown };
      if (
        msg.role === 'assistant' &&
        Array.isArray(msg.tool_calls) &&
        msg.tool_calls.length > 0
      ) {
        const normalized_tool_calls = (msg.tool_calls as Array<Record<string, unknown>>).map((tc) => {
          // Already in OpenAI shape? pass through.
          if (tc.type === 'function' && tc.function) return tc;
          const args = tc.arguments;
          return {
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
            },
          };
        });
        return { ...m, tool_calls: normalized_tool_calls };
      }
      return m;
    });

    // Attach vision image to the LAST user message if request.vision
    // is set. HEIC → JPEG transcoding via ffmpeg lives in the helper;
    // the temp file is cleaned up in a finally-style block at the end.
    const { messages, cleanup: vision_cleanup } = await this._attach_vision(
      messages_pre,
      request,
    );
    try {
    const body = this._build_body(messages, request, false);

    type CompletionBody = {
      choices?: Array<{
        message: {
          content: string | null;
          // Lemonade / llama-server with `--reasoning-format auto`
          // returns the model's thinking trace in a separate field
          // instead of leaving it embedded in content as
          // `<think>...</think>`. Surface it back to callers via
          // LLMResponse.thinking the same way the embedded form is.
          reasoning_content?: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    // Lemonade / llama.cpp intermittently fails a well-formed request —
    // most visibly a 200 carrying `{error:{...}}` with "Failed to parse
    // input ... <tool_call>" (the backend mis-parsing the model's own
    // generated tool call). A plain retry re-rolls the generation and
    // often clears it. Retry transient backend failures a few times
    // before surfacing the error to the caller.
    const MAX_ATTEMPTS = 3;
    let json: CompletionBody | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const res = await fetch(`${this.config.base_url}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.api_key}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeout_ms ?? 120_000),
      });

      if (!res.ok) {
        const text = await res.text();
        if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
          console.warn(
            `[openai] backend ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS}); retrying`,
          );
          await new Promise((r) => setTimeout(r, 400 * attempt));
          continue;
        }
        throw new Error(`OpenAI-compatible API error ${res.status}: ${text}`);
      }

      const parsed = (await res.json()) as CompletionBody;
      if (!parsed.choices?.[0]) {
        // A 200 with no choices is Lemonade/llama.cpp surfacing a
        // backend error in the body — transient on this stack.
        if (attempt < MAX_ATTEMPTS) {
          console.warn(
            `[openai] response without choices (attempt ${attempt}/${MAX_ATTEMPTS}); ` +
              `retrying. body=` + JSON.stringify(parsed).slice(0, 300),
          );
          await new Promise((r) => setTimeout(r, 400 * attempt));
          continue;
        }
        console.error('[openai] response without choices[0]. body=', JSON.stringify(parsed).slice(0, 800),
          '\n  request was: model=' + this.config.model + ' messages.len=' + request.messages.length +
          ' tools.len=' + (request.tools?.length ?? 0) + ' think=' + request.think);
        throw new Error('No choices returned from OpenAI-compatible API: ' + JSON.stringify(parsed).slice(0, 200));
      }

      json = parsed;
      break;
    }

    // The loop either assigned `json` or threw; this satisfies the type
    // narrowing and guards against an unforeseen fall-through.
    if (!json || !json.choices?.[0]) {
      throw new Error('No choices returned from OpenAI-compatible API (retries exhausted)');
    }
    const choice = json.choices[0];

    // Reasoning trace can arrive two ways depending on backend:
    //   1) Embedded in content as `<think>...</think>` (older llama.cpp,
    //      Ollama without reasoning-format separation).
    //   2) A separate `reasoning_content` field (Lemonade / llama-server
    //      with `--reasoning-format auto`, modern OpenAI-compat servers).
    // Normalize both into LLMResponse.thinking so callers see a single
    // shape regardless of which backend produced the response.
    let content = choice.message.content ?? '';
    let thinking: string | undefined;
    const rc = choice.message.reasoning_content;
    if (typeof rc === 'string' && rc.length > 0) {
      thinking = rc.trim();
    } else {
      const think_match = content.match(/^<think>([\s\S]*?)<\/think>\s*/);
      if (think_match) {
        const [full, inner] = think_match;
        if (full !== undefined && inner !== undefined) {
          thinking = inner.trim();
          content = content.slice(full.length);
        }
      }
    }

    let tool_calls: ToolCallSpec[] = (choice.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));
    let finish_reason = choice.finish_reason;

    // The backend returned no structured tool_calls but the content
    // carries the `<tool_code>` dialect — recover the call(s) and scrub
    // the dialect out of the visible reply. See _parse_tool_code_dialect.
    if (tool_calls.length === 0 && /<tool_name>|<tool_code>/.test(content)) {
      const recovered = _parse_tool_code_dialect(content);
      content = _strip_tool_code(content);
      if (recovered.length > 0) {
        tool_calls = recovered;
        finish_reason = 'tool_calls';
      }
    }

    return {
      content,
      thinking,
      tool_calls,
      finish_reason,
      cost: {
        tokens_in: json.usage?.prompt_tokens ?? 0,
        tokens_out: json.usage?.completion_tokens ?? 0,
        ms: Math.round(performance.now() - t0),
        model: this.config.model,
      },
    };
    } finally {
      vision_cleanup();
    }
  }

  /**
   * Shared request-body assembly for complete() and complete_stream().
   * The only delta between the two is the `stream` flag plus
   * `stream_options` for usage piggybacking on the final SSE frame.
   */
  private _build_body(
    messages: unknown[],
    request: LLMRequest,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream,
    };
    if (stream) {
      // Ask the server to emit a final usage frame so we can populate
      // LLMResponse.cost.tokens_in/out without a second round-trip.
      body.stream_options = { include_usage: true };
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          strict: true,
        },
      }));
      // Opt into the OpenAI parallel-tool-call response shape. The
      // documented contract: when set true, the model may emit multiple
      // tool_calls in a single response that the runtime collapses into
      // one outer-loop round via Promise.all. Defense-in-depth — audit
      // log evidence (2026-05-30) shows Qwen 3.6 on beellama already
      // parallelizes without the flag, but upstream models (OpenAI
      // proper, future provider swaps) respect it and we want the
      // research-efficiency behavior to be the default contract, not
      // an emergent property of one specific model.
      body.parallel_tool_calls = true;
    }
    // Forced/suppressed tool invocation. `'required'` is guided-decoded by the
    // backend (token masking) so it GUARANTEES a call regardless of sampling —
    // the deterministic backstop for a stochastic skip-the-tool turn. Verified
    // on beellama (think-OFF) + vLLM; a backend that doesn't support it ignores
    // the field. Only emitted when set, so default-auto behavior is unchanged.
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;
    if (request.response_format?.type === 'json_schema') {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          schema: request.response_format.schema,
          name: 'response',
          strict: true,
        },
      };
    }
    const template_kwargs: Record<string, unknown> = {};
    if (request.think === false) template_kwargs.enable_thinking = false;
    if (request.think === true) template_kwargs.enable_thinking = true;
    if (request.preserve_thinking) template_kwargs.preserve_thinking = true;
    if (Object.keys(template_kwargs).length > 0) {
      body.chat_template_kwargs = template_kwargs;
    }
    return body;
  }

  /**
   * Streaming completion against an OpenAI-compatible `/chat/completions`
   * SSE endpoint (beellama.cpp, llama-server, Lemonade, OpenAI proper).
   *
   * Emits `content_delta` / `thinking_delta` chunks as they arrive and
   * a final `done` event carrying the assembled LLMResponse. Tool calls
   * are reassembled by streaming `index` since arguments arrive as a
   * sequence of JSON-string fragments per the OpenAI streaming spec.
   *
   * Two thinking-trace shapes are supported:
   *   1) `delta.reasoning_content` chunks (modern llama-server with
   *      `--reasoning-format auto`, beellama with reasoning split out).
   *   2) `<think>...</think>` embedded in `delta.content` (Qwen 3.6
   *      with reasoning-in-content, default beellama today).
   * Both normalize into `thinking_delta` events.
   *
   * Idle-stream timeout aborts if no SSE frame lands for
   * `OPENAI_IDLE_TIMEOUT_MS` (default 45s) — catches model crashes /
   * backend hangs mid-generation so the user doesn't stare at a
   * frozen "Kate is typing…" bubble. Overall timeout still applies.
   *
   * NOTE: streaming is single-attempt by design. Mid-stream failures
   * surface to the runtime instead of silently re-rolling — the
   * runtime's outer fallback to `complete()` handles recovery.
   */
  async *complete_stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const t0 = performance.now();

    // Same assistant-tool_calls normalization as complete(): Lemonade /
    // llama-server require the OpenAI canonical shape on replay or
    // multi-round tool turns 500.
    const messages_pre = request.messages.map((m) => {
      const msg = m as { role: string; tool_calls?: unknown };
      if (
        msg.role === 'assistant' &&
        Array.isArray(msg.tool_calls) &&
        msg.tool_calls.length > 0
      ) {
        const normalized_tool_calls = (msg.tool_calls as Array<Record<string, unknown>>).map((tc) => {
          if (tc.type === 'function' && tc.function) return tc;
          const args = tc.arguments;
          return {
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
            },
          };
        });
        return { ...m, tool_calls: normalized_tool_calls };
      }
      return m;
    });

    // Same vision attachment as complete(). Streaming + vision are
    // compatible — the model emits SSE deltas the same way, regardless
    // of whether the prompt carried an image.
    const { messages, cleanup: vision_cleanup } = await this._attach_vision(
      messages_pre,
      request,
    );
    try {
    const body = this._build_body(messages, request, true);

    const env_idle = parseInt(process.env.OPENAI_IDLE_TIMEOUT_MS ?? '', 10);
    const idle_timeout_ms =
      Number.isFinite(env_idle) && env_idle > 0 ? env_idle : 45_000;
    const total_timeout_ms = this.config.timeout_ms ?? 240_000;
    const idle_controller = new AbortController();
    let idle_timer: ReturnType<typeof setTimeout> | null = null;
    const reset_idle = (): void => {
      if (idle_timer) clearTimeout(idle_timer);
      idle_timer = setTimeout(() => {
        idle_controller.abort(
          new Error(
            `OpenAI-compat stream idle for ${idle_timeout_ms}ms (no SSE frames) — aborting`,
          ),
        );
      }, idle_timeout_ms);
    };
    const total_signal = _compose_signal(request.signal, total_timeout_ms);
    if (total_signal.aborted) idle_controller.abort(total_signal.reason);
    else
      total_signal.addEventListener('abort', () =>
        idle_controller.abort(total_signal.reason),
      );
    const signal = idle_controller.signal;
    reset_idle();

    const res = await fetch(`${this.config.base_url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.api_key}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok || !res.body) {
      if (idle_timer) clearTimeout(idle_timer);
      const text = await (res.text().catch(() => '<no body>'));
      throw new Error(`OpenAI-compatible API error ${res.status}: ${text}`);
    }

    // Accumulators. Content is buffered raw so the <think> splitter can
    // re-derive thinking vs visible from the full string each frame —
    // we yield only the new tail since last emit, mirroring ollama.ts.
    let raw_content = '';
    let emitted_content_len = 0;
    let emitted_thinking_len = 0;
    let raw_reasoning = ''; // OpenAI-style separated reasoning channel
    let emitted_reasoning_len = 0;
    let prompt_tokens = 0;
    let completion_tokens = 0;
    let finish_reason = 'stop';
    // Tool calls assemble by index — arguments arrive as a sequence of
    // JSON-string fragments per the OpenAI streaming spec.
    const tool_call_slots: Array<{
      id: string;
      name: string;
      arguments_str: string;
    }> = [];

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    type StreamingDelta = {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    type StreamingFrame = {
      choices?: Array<{
        delta?: StreamingDelta;
        finish_reason?: string | null;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        reset_idle();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by blank lines (\n\n). Each frame
        // is one or more `field: value\n` lines; we only need `data:`.
        let sep_idx: number;
        while ((sep_idx = buffer.indexOf('\n\n')) !== -1) {
          const frame_text = buffer.slice(0, sep_idx);
          buffer = buffer.slice(sep_idx + 2);
          // A frame may carry multiple data: lines (rare); concatenate.
          const data_lines = frame_text
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart());
          if (data_lines.length === 0) continue;
          const data = data_lines.join('\n');
          if (data === '[DONE]') continue; // OpenAI sentinel — final usage already arrived in the prior frame
          let frame: StreamingFrame;
          try {
            frame = JSON.parse(data) as StreamingFrame;
          } catch {
            continue;
          }
          if (frame.usage) {
            if (typeof frame.usage.prompt_tokens === 'number')
              prompt_tokens = frame.usage.prompt_tokens;
            if (typeof frame.usage.completion_tokens === 'number')
              completion_tokens = frame.usage.completion_tokens;
          }
          const choice = frame.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finish_reason = choice.finish_reason;
          const delta = choice.delta;
          if (!delta) continue;

          // Channel 1: separated reasoning_content. Emit deltas directly.
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
            raw_reasoning += delta.reasoning_content;
            const tail = raw_reasoning.slice(emitted_reasoning_len);
            emitted_reasoning_len = raw_reasoning.length;
            if (tail) yield { type: 'thinking_delta', delta: tail };
          }

          // Channel 2: content (may contain embedded <think>...</think>).
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            raw_content += delta.content;
            const split = _split_content_thinking(raw_content);
            if (split.thinking.length > emitted_thinking_len) {
              const tail = split.thinking.slice(emitted_thinking_len);
              emitted_thinking_len = split.thinking.length;
              yield { type: 'thinking_delta', delta: tail };
            }
            if (split.content.length > emitted_content_len) {
              const tail = split.content.slice(emitted_content_len);
              emitted_content_len = split.content.length;
              yield { type: 'content_delta', delta: tail };
            }
          }

          // Channel 3: tool calls. Each delta carries one or more
          // partial calls keyed by `index`. id + function.name arrive
          // once; function.arguments arrives as a sequence of JSON
          // string fragments that must be concatenated then parsed.
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (typeof idx !== 'number') continue;
              let slot = tool_call_slots[idx];
              if (!slot) {
                slot = { id: '', name: '', arguments_str: '' };
                tool_call_slots[idx] = slot;
              }
              if (typeof tc.id === 'string' && tc.id) slot.id = tc.id;
              if (typeof tc.function?.name === 'string' && tc.function.name)
                slot.name = tc.function.name;
              if (typeof tc.function?.arguments === 'string')
                slot.arguments_str += tc.function.arguments;
            }
          }
        }
      }
    } finally {
      if (idle_timer) clearTimeout(idle_timer);
    }

    // Assemble tool_calls. Parse each accumulated arguments_str; an
    // unparseable fragment becomes an empty object so the downstream
    // tool_registry's normalization can flag it cleanly instead of
    // crashing this loop.
    let tool_calls: ToolCallSpec[] = tool_call_slots
      .filter((s): s is { id: string; name: string; arguments_str: string } => !!s && !!s.name)
      .map((s) => {
        let args: Record<string, unknown> = {};
        if (s.arguments_str) {
          try {
            args = JSON.parse(s.arguments_str) as Record<string, unknown>;
          } catch {
            args = {};
          }
        }
        return {
          id: s.id || `tc_${Math.random().toString(36).slice(2, 14)}`,
          name: s.name,
          arguments: args,
        };
      });

    // Final content normalization. Re-split to strip the <think> block
    // and recover any <tool_code> dialect calls the same way complete()
    // does. The streamed `content_delta` events already showed the user
    // the post-</think> tail incrementally; this is the assembled
    // canonical form for LLMResponse.content.
    const final_split = _split_content_thinking(raw_content);
    let content = final_split.content;
    const thinking_combined = (raw_reasoning + (final_split.thinking || '')).trim() || undefined;

    if (tool_calls.length === 0 && /<tool_name>|<tool_code>/.test(content)) {
      const recovered = _parse_tool_code_dialect(content);
      content = _strip_tool_code(content);
      if (recovered.length > 0) {
        tool_calls = recovered;
        finish_reason = 'tool_calls';
      }
    }

    const response: LLMResponse = {
      content,
      tool_calls,
      thinking: thinking_combined,
      finish_reason,
      cost: {
        tokens_in: prompt_tokens,
        tokens_out: completion_tokens,
        ms: Math.round(performance.now() - t0),
        model: this.config.model,
      },
    };
    yield { type: 'done', response };
    } finally {
      vision_cleanup();
    }
  }

  capabilities(): LLMCapabilities {
    return {
      supports_json_schema: true,
      supports_tool_calls: true,
      // Thinking is enabled when the backing endpoint honors
      // `chat_template_kwargs.enable_thinking` (llama.cpp / lemonade with
      // a Qwen-3.x style chat template). Real OpenAI / OpenRouter etc. will
      // ignore the field, which is fine — they just won't emit <think>.
      supports_thinking_mode: true,
      // Vision is announced via the env knob below — the LLM host's
      // Qwen3.6 + mmproj endpoint accepts the OpenAI vision content
      // shape (2026-05-26+). If the backing endpoint is text-only,
      // unset OPENAI_VISION_AVAILABLE so requests with `vision` set
      // strip the attachment instead of erroring.
      supports_vision: process.env.OPENAI_VISION_AVAILABLE !== '0',
      max_context: 128_000,
      cost_per_1m_in_cents: 0,
      cost_per_1m_out_cents: 0,
    };
  }
}

// ── Shared helpers (duplicated from ollama.ts to avoid coupling two
// providers through a `providers/_shared.ts` file; both copies are
// small and stable). If a third provider ever needs them, lift to a
// shared module.

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
 * and the `<think>...</think>` reasoning block — see ollama.ts for the
 * full rationale (Qwen 3.6 emits think first, then content; mid-stream
 * with no closing tag yet means everything after the open is in-progress
 * thinking).
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
