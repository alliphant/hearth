/**
 * OpenAI-compatible chat-completions shim → Kate (and any specialist).
 *
 * Lets any OpenAI chat-completions client talk to Kate's FULL specialist
 * runtime (tools, consult, grounding, audit, discretion). It runs no
 * model itself — it bridges the OpenAI shape onto Hearth's conversation
 * API + in-process event bus:
 *
 *   POST /v1/chat/completions            (OpenAI shape, stream or not)
 *     → POST /api/conversations          {specialist_id:"kate", reuse:true}
 *     → POST /api/conversations/{id}/messages {content, surface:"voice"}  (fire-and-forget)
 *     → subscribe in-process to AppEventBus, filtered by conversation_id:
 *          message_token.delta              → chat.completion.chunk
 *          message_added(role=specialist)   → finish (stop / [DONE])
 *
 * The voice path (Home Assistant's OpenAI Conversation agent for the
 * FutureProof Satellite1; future iOS / web voice) points its base_url at
 * `<hearth>/v1` and its api_key at a `mint:service-bearer` token. The
 * global `create_auth_middleware` validates that bearer; this shim
 * forwards the same `Authorization` header to the localhost
 * `/api/conversations` calls so the turn runs as the authenticated user.
 *
 * Mirrors the proven flow in /docker/pipecat/hearth_llm_service.py, but
 * in-process (no self-SSE-HTTP hop): the event bus is subscribed directly.
 */
import { Hono } from 'hono';
import type { AppEventBus, AppEvent } from '@app/events';
import { strip_markdown_for_speech } from '@core/voice_text';

export interface OpenAiShimDeps {
  events: AppEventBus;
  /** Base URL of this orchestrator for the localhost conversation calls. */
  self_url?: string;
  /** Specialist the shim routes to. */
  specialist_id?: string;
  /** Hard cap so a stuck turn never hangs the HTTP response. */
  turn_timeout_ms?: number;
}

const DONE = Symbol('done');

/** Soft ceiling on a buffered voice chunk — flush a run-on clause here so a
 *  long span without terminal punctuation never stalls first audio. */
const VOICE_CHUNK_SOFT_MAX = 240;

/**
 * Index just past the first COMPLETE sentence in `s`, or -1 if `s` holds no
 * terminated sentence yet. "Complete" = a terminator (`. ! ? …` or a newline)
 * that is ALREADY followed by whitespace in the buffer — so a decimal
 * ("3.14") or a still-arriving token never splits mid-word; the trailing
 * partial stays buffered until its own terminator lands (or the stream ends
 * and the caller flushes the remainder). Run-on terminators ("?!") and
 * trailing closing quotes/brackets are absorbed into the sentence.
 */
function next_sentence_boundary(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\n') return i + 1;
    if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
      let j = i + 1;
      while (j < s.length && '.!?…'.includes(s[j]!)) j++;
      while (j < s.length && '"\'”’)]'.includes(s[j]!)) j++;
      if (j < s.length && /\s/.test(s[j]!)) return j;
    }
  }
  return -1;
}

export function create_openai_shim_router(deps: OpenAiShimDeps): Hono {
  const self = (deps.self_url ?? process.env.HEARTH_SELF_URL ?? 'http://127.0.0.1:7700').replace(/\/$/, '');
  const specialist = deps.specialist_id ?? 'kate';
  const turn_timeout_ms = deps.turn_timeout_ms ?? 180_000;

  const r = new Hono();

  // Some clients probe /v1/models before /chat/completions.
  r.get('/models', (c) =>
    c.json({ object: 'list', data: [{ id: specialist, object: 'model', owned_by: 'hearth' }] }),
  );

  r.post('/chat/completions', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { message: 'invalid JSON body' } }, 400);
    }

    const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
    const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
    const raw = lastUser?.content;
    const content = (typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? raw.map((p: any) => (typeof p === 'string' ? p : (p?.text ?? ''))).join(' ')
        : ''
    ).trim();
    if (!content) return c.json({ error: { message: 'no user message content' } }, 400);

    const want_stream = body?.stream === true;
    const model = typeof body?.model === 'string' ? body.model : specialist;
    // Forward the bearer (iOS/HA) AND the cookie (browser web voice chat) so the
    // internal /api/conversations call authenticates as the caller either way —
    // the PWA voice UI is cookie-session'd, not bearer.
    const cookie = c.req.header('cookie');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(auth ? { authorization: auth } : {}),
      ...(cookie ? { cookie } : {}),
    };

    // 1. create/reuse the specialist's voice conversation
    let conv_id: string;
    try {
      const cr = await fetch(`${self}/api/conversations`, {
        method: 'POST',
        headers,
        // surface:'voice' → resolve_for_user gives a DEDICATED voice thread
        // (never rejoins a recent typed-chat conv, whose markdown a quantized
        // model would parrot into TTS). See specialists.ts NewConvSchema.
        body: JSON.stringify({ specialist_id: specialist, user_id: 'jasper', title: 'Voice', reuse: true, surface: 'voice' }),
      });
      if (!cr.ok) return c.json({ error: { message: `conversation create failed (${cr.status})` } }, 502);
      conv_id = ((await cr.json()) as any).id;
      if (!conv_id) return c.json({ error: { message: 'conversation create returned no id' } }, 502);
    } catch (e) {
      return c.json({ error: { message: `conversation create error: ${String(e)}` } }, 502);
    }

    // 2. subscribe to the in-process bus BEFORE firing the turn (no missed tokens)
    const queue: Array<string | typeof DONE> = [];
    let waker: (() => void) | null = null;
    const wake = () => {
      if (waker) {
        const w = waker;
        waker = null;
        w();
      }
    };
    const unsub = deps.events.subscribe((ev: AppEvent) => {
      if ((ev as any).conversation_id !== conv_id) return;
      if (ev.type === 'message_token' && ev.delta) {
        queue.push(ev.delta);
        wake();
      } else if (ev.type === 'message_added' && (ev as any).role === 'specialist') {
        queue.push(DONE);
        wake();
      }
    });
    const timeout = setTimeout(() => {
      queue.push(DONE);
      wake();
    }, turn_timeout_ms);

    // 3. fire the turn — deltas arrive via the bus (don't await the full turn)
    void fetch(`${self}/api/conversations/${conv_id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content, surface: 'voice' }),
    }).catch(() => {
      queue.push(DONE);
      wake();
    });

    async function* drain(): AsyncGenerator<string> {
      try {
        while (true) {
          if (queue.length === 0) await new Promise<void>((res) => { waker = res; });
          while (queue.length > 0) {
            const item = queue.shift()!;
            if (item === DONE) return;
            yield item;
          }
        }
      } finally {
        unsub();
        clearTimeout(timeout);
      }
    }

    const id = `chatcmpl-${conv_id}`;
    const created = Math.floor(Date.now() / 1000);

    if (want_stream) {
      // Mirror the codebase's /app/api/events SSE style: manual TransformStream.
      const { readable, writable } = new TransformStream<string, string>();
      const writer = writable.getWriter();
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      void (async () => {
        // Buffer token deltas into whole sentences and emit one
        // chat.completion.chunk per sentence. Home Assistant's streaming
        // TTS can then start speaking sentence 1 while Kate is still
        // generating sentence 2 — the dominant first-audio win — and TTS
        // prosody is far better on a whole sentence than on word fragments.
        // A soft length cap flushes a run-on clause so a long unpunctuated
        // span never stalls audio. Concatenation is unchanged for a non-TTS
        // client; chunk size is free in the OpenAI SSE shape.
        let buf = '';
        // Drop a sentence that's byte-identical (normalized) to the one just
        // emitted. The small voice models pad a one-line forced answer by
        // repeating it ("The EV is at 100% charge. The EV is at 100% charge."),
        // which the TTS bridge then synthesizes + SPEAKS 2-3x AND pays double
        // synthesis latency for. Consecutive identical sentences are never
        // intended in speech, so this is a safe deterministic backstop on the
        // spoken path — same role as strip_markdown_for_speech. (Stored
        // transcript keeps the raw text; this only shapes what reaches TTS.)
        let last_spoken_norm = '';
        const _norm_sentence = (s: string) =>
          s.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?…,;:'"”’)\]]+$/g, '').trim();
        const flush = (text: string) => {
          const speech = strip_markdown_for_speech(text);
          if (!speech.trim()) return Promise.resolve();
          const n = _norm_sentence(speech);
          if (n && n === last_spoken_norm) return Promise.resolve();
          last_spoken_norm = n;
          return writer.write(chunk({ content: speech }, null));
        };
        try {
          for await (const d of drain()) {
            buf += d;
            for (;;) {
              const cut = next_sentence_boundary(buf);
              if (cut !== -1) {
                await flush(buf.slice(0, cut));
                buf = buf.slice(cut);
                continue;
              }
              if (buf.length > VOICE_CHUNK_SOFT_MAX) {
                const sp = buf.lastIndexOf(' ', VOICE_CHUNK_SOFT_MAX);
                const at = sp > 40 ? sp + 1 : VOICE_CHUNK_SOFT_MAX;
                await flush(buf.slice(0, at));
                buf = buf.slice(at);
                continue;
              }
              break;
            }
          }
          await flush(buf);
          await writer.write(chunk({}, 'stop'));
          await writer.write('data: [DONE]\n\n');
        } catch {
          /* client hung up — drain()'s finally still unsubscribes */
        } finally {
          await writer.close().catch(() => {});
        }
      })();
      return new Response(readable, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        },
      });
    }

    // non-streaming: accumulate the deltas into one completion
    let full = '';
    for await (const d of drain()) full += d;
    return c.json({
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: strip_markdown_for_speech(full) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  });

  return r;
}
