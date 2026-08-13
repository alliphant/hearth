// src/roicalc/bench.ts — measure prefill + generation tokens/second against
// any OpenAI-compatible chat-completions endpoint (llama.cpp, vLLM, Ollama).
//
// Methodology: one short warmup request (on Ollama the warmup is also what
// pulls the model into VRAM — "temporarily load a model" is just benching it
// on an Ollama base URL), then one measured streaming run with a
// nonce-prefixed filler prompt. The nonce defeats llama.cpp/vLLM prefix
// caching, which would otherwise serve the second prefill from KV cache and
// make the number meaningless.
//
//   prefill_tps ≈ prompt_tokens / TTFT        (TTFT includes one decode step
//                                              + LAN round-trip — slightly
//                                              conservative)
//   gen_tps     = (completion_tokens − 1) / (last_token_t − first_token_t)
//
// Token counts come from streaming `usage` (stream_options.include_usage);
// when a server rejects that param the run retries without it and falls back
// to chunk-count / chars-per-token estimates, flagged in `notes`. llama.cpp's
// exact server-side `timings` are reported alongside when present.

import { z } from 'zod';

export const BenchInputSchema = z.object({
  /** OpenAI-compat base, e.g. http://your-llm-host.local:8088/v1 — also accepts a
   *  bare host:port (…/v1 is appended) or a full …/chat/completions path. */
  base_url: z.string().url(),
  api_key: z.string().min(1).optional(),
  model: z.string().min(1),
  prompt_tokens: z.number().int().min(64).max(65_536).default(2048),
  max_output_tokens: z.number().int().min(16).max(4096).default(256),
  warmup: z.boolean().default(true),
  /** Ollama only: free the VRAM when done (native keep_alive: 0). */
  unload_after: z.boolean().default(false),
  /** Per-request deadline; the first request on Ollama includes model load. */
  timeout_ms: z.number().int().min(10_000).max(1_800_000).default(300_000),
});
export type BenchInput = z.infer<typeof BenchInputSchema>;

export interface ServerTimings {
  prompt_n: number;
  prefill_tps: number;
  predicted_n: number | null;
  gen_tps: number | null;
}

export interface BenchResult {
  ok: true;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  ttft_ms: number;
  gen_ms: number;
  total_ms: number;
  prefill_tps: number;
  gen_tps: number;
  warmup_ms: number | null;
  usage_source: 'usage' | 'estimated';
  /** Exact server-side timings (llama.cpp volunteers these), when present. */
  server_timings: ServerTimings | null;
  notes: string[];
}

export interface BenchError {
  ok: false;
  error: string;
  status?: number;
  body_snippet?: string;
}

/** Trim trailing slashes; pass …/chat/completions through; ensure /v1 otherwise. */
export function normalize_base(raw: string): string {
  let base = raw.trim().replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  if (!base.endsWith('/v1')) base = `${base}/v1`;
  return base;
}

interface StreamOutcome {
  status: number; // 0 = network error / abort
  error_body: string | null;
  ttft_ms: number | null; // offset from request start
  last_ms: number | null; // offset from request start
  delta_count: number;
  usage: { prompt_tokens: number | null; completion_tokens: number | null } | null;
  timings: {
    prompt_n: number | null;
    prompt_ms: number | null;
    predicted_n: number | null;
    predicted_ms: number | null;
  } | null;
}

function num_or_null(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function handle_sse_event(event: string, t0: number, out: StreamOutcome): void {
  for (const line of event.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const choices = obj.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0] as Record<string, unknown> | undefined;
      const delta = (first?.delta ?? null) as Record<string, unknown> | null;
      const content = typeof delta?.content === 'string' ? delta.content : '';
      const reasoning =
        typeof delta?.reasoning_content === 'string' ? delta.reasoning_content : '';
      // Role-only / empty deltas don't count as tokens; thinking deltas do —
      // they're generated tokens for throughput purposes.
      if (content.length > 0 || reasoning.length > 0) {
        const now = performance.now();
        if (out.ttft_ms === null) out.ttft_ms = now - t0;
        out.last_ms = now - t0;
        out.delta_count += 1;
      }
    }
    const usage = obj.usage;
    if (usage && typeof usage === 'object') {
      const u = usage as Record<string, unknown>;
      out.usage = {
        prompt_tokens: num_or_null(u.prompt_tokens),
        completion_tokens: num_or_null(u.completion_tokens),
      };
    }
    const timings = obj.timings;
    if (timings && typeof timings === 'object') {
      const t = timings as Record<string, unknown>;
      out.timings = {
        prompt_n: num_or_null(t.prompt_n),
        prompt_ms: num_or_null(t.prompt_ms),
        predicted_n: num_or_null(t.predicted_n),
        predicted_ms: num_or_null(t.predicted_ms),
      };
    }
  }
}

async function stream_once(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  timeout_ms: number,
): Promise<StreamOutcome> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout_ms);
  const t0 = performance.now();
  const out: StreamOutcome = {
    status: 0,
    error_body: null,
    ttft_ms: null,
    last_ms: null,
    delta_count: 0,
    usage: null,
    timings: null,
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    out.status = res.status;
    if (!res.ok) {
      out.error_body = (await res.text().catch(() => '')).slice(0, 500) || null;
      return out;
    }
    if (!res.body) {
      out.status = 0;
      out.error_body = 'no response body';
      return out;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r/g, '');
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        handle_sse_event(event, t0, out);
      }
    }
    return out;
  } catch (err) {
    out.status = 0;
    out.error_body = ctrl.signal.aborted
      ? `timed out after ${timeout_ms}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

function build_prompt(target_tokens: number, nonce: string): string {
  // ~17 tokens per filler line on typical BPE vocabularies (measured 17.6 on
  // Qwen3.5); the actual count comes back in `usage`, this only needs to be
  // ballpark.
  const sentences = Math.max(1, Math.round((target_tokens - 40) / 17));
  const parts: string[] = [
    `Benchmark session ${nonce}. The text below is filler; read it, then follow the final instruction.`,
  ];
  for (let i = 0; i < sentences; i++) {
    parts.push(`Filler ${i}: the quick brown fox jumps over the lazy dog.`);
  }
  parts.push(
    'Final instruction: count upward from 1, one number per line, for as long as you can.',
  );
  return parts.join('\n');
}

function make_body(
  model: string,
  prompt: string,
  max_tokens: number,
  include_usage: boolean,
): Record<string, unknown> {
  return {
    model,
    stream: true,
    max_tokens,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
    ...(include_usage ? { stream_options: { include_usage: true } } : {}),
  };
}

async function try_ollama_unload(
  origin: string,
  model: string,
): Promise<'unloaded' | 'not_ollama' | 'failed'> {
  try {
    const v = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(5_000) });
    if (!v.ok) return 'not_ollama';
  } catch {
    return 'not_ollama';
  }
  try {
    const r = await fetch(`${origin}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(15_000),
    });
    return r.ok ? 'unloaded' : 'failed';
  } catch {
    return 'failed';
  }
}

export async function run_bench(input: BenchInput): Promise<BenchResult | BenchError> {
  const base = normalize_base(input.base_url);
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
  const origin = base.replace(/\/chat\/completions$/, '').replace(/\/v1$/, '');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(input.api_key ? { authorization: `Bearer ${input.api_key}` } : {}),
  };
  const notes: string[] = [];
  const bench_t0 = performance.now();

  let warmup_ms: number | null = null;
  if (input.warmup) {
    const w0 = performance.now();
    const w = await stream_once(
      url,
      make_body(input.model, 'Warmup. Reply with the single word: ready.', 16, false),
      headers,
      input.timeout_ms,
    );
    if (w.status !== 200) {
      return {
        ok: false,
        error:
          w.status === 0
            ? `endpoint unreachable: ${w.error_body ?? 'unknown error'}`
            : `warmup request failed (HTTP ${w.status})`,
        status: w.status,
        ...(w.status !== 0 && w.error_body ? { body_snippet: w.error_body } : {}),
      };
    }
    warmup_ms = performance.now() - w0;
    if (warmup_ms > 15_000) {
      notes.push(`warmup took ${(warmup_ms / 1000).toFixed(1)}s — likely included the model load`);
    }
  }

  const prompt = build_prompt(input.prompt_tokens, crypto.randomUUID());
  let outcome = await stream_once(
    url,
    make_body(input.model, prompt, input.max_output_tokens, true),
    headers,
    input.timeout_ms,
  );
  if (outcome.status === 400) {
    notes.push('endpoint rejected stream_options.include_usage; token counts may be estimated');
    outcome = await stream_once(
      url,
      make_body(input.model, prompt, input.max_output_tokens, false),
      headers,
      input.timeout_ms,
    );
  }
  if (outcome.status !== 200) {
    return {
      ok: false,
      error:
        outcome.status === 0
          ? `endpoint unreachable: ${outcome.error_body ?? 'unknown error'}`
          : `endpoint returned HTTP ${outcome.status}`,
      status: outcome.status,
      ...(outcome.status !== 0 && outcome.error_body
        ? { body_snippet: outcome.error_body }
        : {}),
    };
  }
  if (outcome.ttft_ms === null || outcome.last_ms === null || outcome.delta_count === 0) {
    return {
      ok: false,
      error: 'no tokens streamed back — is `model` right for this endpoint?',
    };
  }

  const usage_prompt = outcome.usage?.prompt_tokens ?? null;
  const usage_completion = outcome.usage?.completion_tokens ?? null;
  const prompt_tokens = usage_prompt ?? Math.round(prompt.length / 4);
  const completion_tokens = usage_completion ?? outcome.delta_count;
  const usage_source: 'usage' | 'estimated' =
    usage_prompt !== null && usage_completion !== null ? 'usage' : 'estimated';
  if (usage_source === 'estimated') {
    notes.push(
      'server did not report usage: prompt tokens ≈ chars/4, completion tokens = streamed chunk count',
    );
  }

  const ttft_ms = outcome.ttft_ms;
  const gen_ms = outcome.last_ms - outcome.ttft_ms;
  if (completion_tokens < 2 || gen_ms <= 0) {
    return {
      ok: false,
      error: `too few output tokens (${completion_tokens}) to measure a generation rate — raise max_output_tokens`,
    };
  }

  let server_timings: ServerTimings | null = null;
  const t = outcome.timings;
  if (t && t.prompt_n !== null && t.prompt_ms !== null && t.prompt_ms > 0) {
    server_timings = {
      prompt_n: t.prompt_n,
      prefill_tps: (t.prompt_n / t.prompt_ms) * 1000,
      predicted_n: t.predicted_n,
      gen_tps:
        t.predicted_n !== null && t.predicted_ms !== null && t.predicted_ms > 0
          ? (t.predicted_n / t.predicted_ms) * 1000
          : null,
    };
  }

  if (input.unload_after) {
    const u = await try_ollama_unload(origin, input.model);
    notes.push(
      u === 'unloaded'
        ? 'model unloaded from VRAM (Ollama keep_alive: 0)'
        : u === 'not_ollama'
          ? 'unload skipped: endpoint is not Ollama (llama.cpp/vLLM hold their model until the server stops)'
          : 'Ollama unload request failed (non-fatal)',
    );
  }

  return {
    ok: true,
    model: input.model,
    prompt_tokens,
    completion_tokens,
    ttft_ms,
    gen_ms,
    total_ms: performance.now() - bench_t0,
    prefill_tps: prompt_tokens / (ttft_ms / 1000),
    gen_tps: (completion_tokens - 1) / (gen_ms / 1000),
    warmup_ms,
    usage_source,
    server_timings,
    notes,
  };
}
