/**
 * /api/voice — Kate's spoken-voice HTTP surface.
 *
 * Two routes, both live:
 *   - POST /tts     — browser path to Kate's real voice: proxies a sentence to
 *                     Qwen3-TTS and streams the WAV back. The synth is LAN-only
 *                     either way, so the orchestrator is the only
 *                     browser-reachable hop.
 *   - POST /emotion — classify a reply's spoken tone → the `instruct` word for
 *                     the Laur fine-tune (used by the Satellite1 coordinator,
 *                     which synthesizes against the same TTS host directly).
 *
 * WHERE TTS RUNS (re-verified 2026-07-31): **on the LLM host**, `:8023`, a local
 * `custom_voice_server.py` holding ~5.3 GB on an Ada — co-located with parakeet
 * STT `:8093`. forza's `192.168.0.188:8023` ALSO still answers 200, so both are
 * live and the old cross-LAN default worked; it was just needlessly crossing the
 * network for the most latency-critical loop in the system. Deployment sets
 * `HEARTH_VOICE_TTS_URL=http://host.docker.internal:8023`; the default below now
 * matches that instead of contradicting it.
 *
 * History: this file used to also carry the WebRTC SDP offer/answer proxy to
 * the Pipecat container (`/sdp`, `/status`). Pipecat was retired 2026-06-08
 * (never wired to a live client; see the private dev log "Pipecat real-time voice loop")
 * and the proxy was deleted in the Hearth 2.0 P0 pass — live voice is the
 * direct-client contract (Satellite1 coordinator + iOS/web hitting STT/TTS
 * endpoints directly).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { LLMRouter } from '@core/llm';
import type { KvSettings } from '@core/users';
import {
  infer_voice_emotion,
  instruct_for_mode,
  resolve_voice_emotion_mode,
  set_voice_emotion_mode,
  voice_stream_emotion_enabled,
  voice_emotion_options,
  is_voice_emotion_mode,
  VOICE_EMOTION_INTIMATE,
} from '@core/voice_emotion';

interface VoiceDeps {
  /** Qwen3-TTS base URL for the /tts proxy. Defaults to the the LLM host-local synth
   *  (`host.docker.internal:8023`), which is where it actually runs. The browser
   *  can't reach the synth directly (LAN-only), so the orchestrator proxies
   *  Kate's real voice. */
  tts_url?: string;
  /** LLM router — used to classify the spoken-emotion `instruct` for the Laur
   *  fine-tune (infer_voice_emotion → the live status_flavor tiny model). Absent
   *  ⇒ neutral synthesis (the pre-2026-06-16 behavior). */
  llm?: LLMRouter;
  /** kv_settings — persists the per-user SETTABLE voice register the /stream path
   *  reads. Absent ⇒ /stream stays neutral (the setting has nowhere to live). */
  kv?: KvSettings;
}

export function create_voice_router(deps: VoiceDeps): Hono {
  const router = new Hono();
  const tts_url = (
    deps.tts_url ??
    process.env.HEARTH_VOICE_TTS_URL ??
    'http://host.docker.internal:8023'
  ).replace(/\/+$/, '');

  // ── /api/voice/tts — Kate's real voice (Qwen3-TTS, the LLM host-local :8023) ───
  // The web voice chat POSTs a sentence of Kate's reply; we proxy to Qwen3-TTS
  // (voice EN_F_Laur — the one tuned for the Satellite1 + iOS) and stream the
  // WAV back. Auth is the shared /api middleware (browser cookie or bearer).
  // The synth is LAN-only, so this proxy is the only browser path to her real
  // voice.
  const TtsSchema = z.object({
    text: z.string().min(1).max(4000),
    voice: z.string().min(1).max(64).optional(),
  });
  router.post('/tts', async (c) => {
    const trace_id = Math.random().toString(36).slice(2, 8);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = TtsSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const voice = parsed.data.voice ?? 'EN_F_Laur';
    // Inferred spoken emotion for the Laur fine-tune (forza custom_voice_server
    // accepts `instruct`). Fails open to '' (neutral) when disabled / no router /
    // any classify error — only included when non-empty.
    const instruct = deps.llm ? await infer_voice_emotion(parsed.data.text, deps.llm) : '';
    let upstream: Response;
    try {
      upstream = await fetch(`${tts_url}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'tts-1',
          voice,
          input: parsed.data.text,
          response_format: 'wav',
          ...(instruct ? { instruct } : {}),
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      console.error(`[voice/tts ${trace_id}] fetch threw: ${(err as Error).message}`);
      return c.json({ error: `tts unreachable: ${(err as Error).message}` }, 502);
    }
    if (!upstream.ok || !upstream.body) {
      const t = await upstream.text().catch(() => '');
      console.error(`[voice/tts ${trace_id}] tts ${upstream.status}: ${t.slice(0, 200)}`);
      return c.json({ error: `tts ${upstream.status}` }, 502);
    }
    return new Response(upstream.body, {
      status: 200,
      headers: { 'content-type': 'audio/wav', 'cache-control': 'no-store' },
    });
  });

  // ── /api/voice/stream — Kate's real voice, GAPLESS whole-reply timeline ───
  // The web voice orb POSTs the WHOLE reply, already split into clean spoken
  // SENTENCES by the openai_shim (one per SSE chunk). We proxy to the Laur
  // server's gapless /v1/audio/stream: ONE continuous audio timeline for the
  // reply — each sentence's inconsistent (40-360ms) leading/trailing model
  // silence trimmed and a single, even ~140ms breath inserted between them —
  // streamed straight back as raw int16 / mono / 24 kHz PCM, which the client
  // schedules sample-accurately into the AudioContext.
  //
  // THIS is the fix for the web orb's audible inter-sentence pause. The old
  // /tts path synthesized ONE SENTENCE PER REQUEST and the client chained the
  // clips (each carrying its own silence pad) via `onended`, so every boundary
  // cost a full request round-trip + pad. Here the boundaries live INSIDE one
  // stream, so there is nothing to chain.
  //
  // Emotion here is the SETTABLE register (default neutral — the owner's
  // 2026-07-10 A/B baseline). When HEARTH_VOICE_STREAM_EMOTION is on, we read the
  // caller's pinned mode from kv_settings and apply ONE instruct to EVERY segment:
  //   - a pinned tone → its rich descriptive instruct
  //   - `auto`        → classify the WHOLE reply ONCE (the joined sentences)
  //   - `neutral`     → no instruct (byte-identical to today)
  // The single-instruct-for-the-whole-reply shape is the documented anti-jitter
  // fix: the thing the A/B rejected was classified-PER-SENTENCE instruct, not
  // emotion itself. Off (flag or kv absent) ⇒ neutral, unchanged. The Satellite1
  // coordinator keeps its own per-sentence emotion via /api/voice/emotion.
  const StreamSchema = z.object({
    sentences: z.array(z.string().min(1).max(600)).min(1).max(80),
    voice: z.string().min(1).max(64).optional(),
  });
  router.post('/stream', async (c) => {
    const trace_id = Math.random().toString(36).slice(2, 8);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = StreamSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const voice = parsed.data.voice ?? 'EN_F_Laur';
    const texts = parsed.data.sentences.map((t) => t.trim()).filter(Boolean);
    if (texts.length === 0) return c.json({ error: 'no non-empty sentences' }, 400);

    // Resolve the owner-chosen register → one instruct for the whole reply.
    let instruct = '';
    if (voice_stream_emotion_enabled() && deps.kv) {
      const user = c.get('user') as { id?: string } | undefined;
      const mode = resolve_voice_emotion_mode(deps.kv, user?.id);
      try {
        instruct = await instruct_for_mode(mode, texts.join(' '), deps.llm);
      } catch {
        instruct = ''; // fail-open to neutral — never break synthesis over emotion
      }
    }
    const segments = texts.map((text) => (instruct ? { text, instruct } : { text }));

    // The client can abort this PCM download mid-reply (iOS/web barge-in, a
    // closed tab). The upstream request must die with it, or the Laur server
    // keeps synthesizing the rest of the reply for nobody — wasted GPU. The
    // disconnect reaches us as cancel() on the body we return below, which
    // aborts this controller; the 60s ceiling rides the same combined signal.
    const upstream_abort = new AbortController();

    let upstream: Response;
    try {
      upstream = await fetch(`${tts_url}/v1/audio/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          voice,
          response_format: 'pcm', // raw int16 LE / mono / 24 kHz — client schedules it sample-accurate
          segments,
          trim_silence: true,
          inter_segment_ms: 140,
        }),
        signal: AbortSignal.any([upstream_abort.signal, AbortSignal.timeout(60_000)]),
      });
    } catch (err) {
      console.error(`[voice/stream ${trace_id}] fetch threw: ${(err as Error).message}`);
      return c.json({ error: `tts unreachable: ${(err as Error).message}` }, 502);
    }
    if (!upstream.ok || !upstream.body) {
      const t = await upstream.text().catch(() => '');
      console.error(`[voice/stream ${trace_id}] tts ${upstream.status}: ${t.slice(0, 200)}`);
      return c.json({ error: `tts ${upstream.status}` }, 502);
    }
    const tts = upstream.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await tts.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel(reason) {
        // client disconnected / barged in / navigated away — stop synthesizing
        upstream_abort.abort(reason);
        void tts.cancel(reason).catch(() => {});
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'x-sample-rate': '24000',
        'cache-control': 'no-store',
      },
    });
  });

  // ── /api/voice/emotion — classify a reply's spoken tone → `instruct` ─────
  // The Satellite1 voice coordinator (which synthesizes via forza directly, with
  // no LLM router of its own) POSTs the reply's first sentence here once per turn
  // to get the `instruct` word for the Laur fine-tune. Auth is the shared /api
  // middleware (the coordinator sends HEARTH_INTERNAL_BEARER). Fails open to '' .
  // `context` (optional) = the full spoken reply, so a single sentence is
  // classified IN CONTEXT (context-aware per-sentence emotion, 2026-07-08). The
  // Satellite1 coordinator sends it per sentence; absent ⇒ whole-reply classify.
  const EmotionSchema = z.object({
    text: z.string().min(1).max(4000),
    context: z.string().max(6000).optional(),
  });
  router.post('/emotion', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = EmotionSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const instruct = deps.llm
      ? await infer_voice_emotion(parsed.data.text, deps.llm, parsed.data.context)
      : '';
    return c.json({ instruct });
  });

  // ── /api/voice/emotion_setting — the owner-chosen spoken register ─────────
  // GET returns the caller's current mode + the picker options (intimate tones
  // filtered out for a non-owner). POST persists it (intimate tones owner-only).
  // The same setting the Kate service-mode `set_voice_emotion` tool writes. This
  // is the Settings-picker surface; both feed the /stream read above.
  router.get('/emotion_setting', (c) => {
    const user = c.get('user') as { id?: string; tier?: string } | undefined;
    const is_owner = user?.tier === 'owner';
    const mode = deps.kv ? resolve_voice_emotion_mode(deps.kv, user?.id) : 'neutral';
    return c.json({
      mode,
      enabled: voice_stream_emotion_enabled(),
      can_set: Boolean(deps.kv && user?.id),
      options: voice_emotion_options(is_owner),
    });
  });

  const EmotionSettingSchema = z.object({ mode: z.string().min(1).max(32) });
  router.post('/emotion_setting', async (c) => {
    const user = c.get('user') as { id?: string; tier?: string } | undefined;
    if (!deps.kv) return c.json({ error: 'voice settings unavailable' }, 503);
    if (!user?.id) return c.json({ error: 'no user' }, 401);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = EmotionSettingSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const mode = parsed.data.mode;
    if (!is_voice_emotion_mode(mode)) return c.json({ error: `unknown mode: ${mode}` }, 400);
    // Intimate/character tones are owner-only, mirroring the service-mode cordon.
    if (VOICE_EMOTION_INTIMATE.has(mode) && user.tier !== 'owner') {
      return c.json({ error: 'that register is owner-only' }, 403);
    }
    set_voice_emotion_mode(deps.kv, user.id, mode);
    return c.json({ mode });
  });

  return router;
}
