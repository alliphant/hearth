/**
 * Speech-to-text.
 *
 * the LLM host runs an OpenAI-compatible whisper server on :8093
 * (`faster-whisper-large-v3-turbo`). The relay route has forwarded to it since
 * the voice work; this lifts that call into one helper so every surface that
 * needs a transcript uses the same endpoint, timeout and response shape —
 * `/app/api/chat/transcribe` returned a hardcoded 501 for months while a
 * working STT sat one port away.
 *
 * Audio never leaves the house: the model runs on the LLM host, not at a vendor.
 */
export const SPEACHES_URL = process.env.SPEACHES_URL ?? 'http://localhost:8093';
export const STT_MODEL = process.env.STT_MODEL ?? 'deepdml/faster-whisper-large-v3-turbo-ct2';

/** `status` is a literal so route handlers can hand it straight to Hono's
 *  `c.json(body, status)`, which rejects a plain `number`. */
export type Transcript = { ok: true; text: string } | { ok: false; reason: string; status: 502 };

/**
 * Transcribe one audio blob. `language` is worth passing when known — it skips
 * whisper's detection pass and stops short utterances being read as the wrong
 * language ("okay" is a word in a lot of them).
 */
export async function transcribe_audio(
  file: File,
  language?: string,
  timeout_ms = 120_000,
): Promise<Transcript> {
  const forward = new FormData();
  forward.append('file', file, file.name || 'audio.webm');
  forward.append('model', STT_MODEL);
  if (language) forward.append('language', language);

  try {
    const res = await fetch(`${SPEACHES_URL.replace(/\/$/, '')}/v1/audio/transcriptions`, {
      method: 'POST',
      body: forward,
      signal: AbortSignal.timeout(timeout_ms),
    });
    if (!res.ok) {
      return { ok: false, reason: `stt ${res.status}: ${await res.text()}`, status: 502 };
    }
    const j = (await res.json().catch(() => ({}))) as { text?: string; transcript?: string };
    return { ok: true, text: (j.transcript ?? j.text ?? '').trim() };
  } catch (err) {
    return { ok: false, reason: (err as Error).message, status: 502 };
  }
}

/** Is the STT server answering? Used by the panel to explain itself when not. */
export async function stt_healthy(timeout_ms = 4_000): Promise<boolean> {
  try {
    const res = await fetch(`${SPEACHES_URL.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(timeout_ms),
    });
    return res.ok;
  } catch {
    return false;
  }
}
