/**
 * Laur voice clips for live workout cues (Live Ride Companion Phase 1 —
 * docs/design-astrid-live-companion.md §6.3).
 *
 * cue text → forza qwen3-tts (`EN_F_Laur`, WAV out) → ffmpeg → Opus in
 * a CAF container (iOS-native decode, ~60 KB per 10 s at 48 kbps mono).
 * If the container's ffmpeg lacks libopus (or the caf+opus mux fails),
 * we fall back to AAC-LC 64 kbps in .m4a — the clip record carries
 * `format` so the client just plays whatever arrived.
 *
 * FAIL-OPEN: synthesize_cue_clip never throws — any TTS/transcode
 * failure returns null and the cue ships text-only.
 *
 * Clips are user data: rows in workout_cue_clips carry user_id and the
 * serving route enforces caller == owner (no owner god-view — a clip
 * narrates someone's workout). Files live under
 * <clip_dir>/<user_id>/<clip_id>.<ext>; a 48 h sweep deletes rows +
 * files together.
 */

import { mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CueClipFormat } from '@memory/stores/workout_cues';

// ── TTS transport (test seam) ────────────────────────────────────────

type TtsTransport = (url: string, body: unknown) => Promise<ArrayBuffer>;

let tts_transport: TtsTransport = async (url, body) => {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    throw new Error(`TTS ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  return resp.arrayBuffer();
};

export function _test_set_tts_transport(fn: TtsTransport | null): void {
  tts_transport = fn ?? tts_transport;
}

// ── Transcode (test seam) ────────────────────────────────────────────

type Transcoder = (wav_path: string, out_base: string) => Promise<{ path: string; format: CueClipFormat }>;

async function run_ffmpeg(args: string[]): Promise<boolean> {
  const proc = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const exit_code = await proc.exited;
  return exit_code === 0;
}

const real_transcoder: Transcoder = async (wav_path, out_base) => {
  // Opus-in-CAF first (iOS-native, ~60 KB / 10 s), AAC-LC fallback.
  const caf = `${out_base}.caf`;
  if (await run_ffmpeg(['-i', wav_path, '-c:a', 'libopus', '-b:a', '48k', '-ac', '1', caf])) {
    return { path: caf, format: 'opus_caf' };
  }
  const m4a = `${out_base}.m4a`;
  if (await run_ffmpeg(['-i', wav_path, '-c:a', 'aac', '-b:a', '64k', '-ac', '1', m4a])) {
    return { path: m4a, format: 'aac_m4a' };
  }
  throw new Error('ffmpeg transcode failed for both libopus/caf and aac/m4a');
};

let transcoder: Transcoder = real_transcoder;

export function _test_set_transcoder(fn: Transcoder | null): void {
  transcoder = fn ?? real_transcoder;
}

// ── WAV duration ─────────────────────────────────────────────────────

/** Parse a RIFF/WAVE header for duration. Null on anything unexpected. */
export function wav_duration_s(bytes: Uint8Array): number | null {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (off: number) => String.fromCharCode(bytes[off]!, bytes[off + 1]!, bytes[off + 2]!, bytes[off + 3]!);
    if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
    let off = 12;
    let byte_rate: number | null = null;
    while (off + 8 <= bytes.length) {
      const id = tag(off);
      const size = dv.getUint32(off + 4, true);
      if (id === 'fmt ' && off + 16 <= bytes.length) {
        byte_rate = dv.getUint32(off + 16, true);
      }
      if (id === 'data' && byte_rate != null && byte_rate > 0) {
        // Streamed WAV (forza's TTS) declares 0xFFFFFFFF / an oversize
        // data length — fall back to the bytes actually received.
        const remaining = bytes.length - (off + 8);
        const data_bytes = size === 0xffffffff || size > remaining ? remaining : size;
        if (data_bytes <= 0) return null;
        return Math.round((data_bytes / byte_rate) * 10) / 10;
      }
      off += 8 + size + (size % 2);
    }
    return null;
  } catch {
    return null;
  }
}

// ── Synthesis ────────────────────────────────────────────────────────

export interface SynthesizedClip {
  file_path: string;
  format: CueClipFormat;
  duration_s: number | null;
  bytes: number;
}

export interface SynthesizeArgs {
  text: string;
  clip_id: string;
  /** Directory clips for THIS USER land in (caller appends user_id). */
  out_dir: string;
  tts_base_url: string;
  voice?: string;
}

/** Speech-safety pass — the render prompt already forbids markdown, but
 *  a stray symbol must never reach the TTS. */
export function speechify(text: string): string {
  return text
    .replace(/[*_#`~]/g, '')
    .replace(/\s*(?:°\s*F\b|℉)/g, ' degrees')
    .replace(/\s*(?:°\s*C\b|℃)/g, ' degrees')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function synthesize_cue_clip(args: SynthesizeArgs): Promise<SynthesizedClip | null> {
  const tmp_wav = resolve(tmpdir(), `hearth-cue-${args.clip_id}.wav`);
  try {
    const wav = await tts_transport(`${args.tts_base_url.replace(/\/+$/, '')}/v1/audio/speech`, {
      model: 'tts-1',
      voice: args.voice ?? 'EN_F_Laur',
      input: speechify(args.text),
      response_format: 'wav',
    });
    const wav_bytes = new Uint8Array(wav);
    if (wav_bytes.length < 128) return null;
    await Bun.write(tmp_wav, wav_bytes);
    mkdirSync(args.out_dir, { recursive: true });
    const out_base = join(args.out_dir, args.clip_id);
    const { path, format } = await transcoder(tmp_wav, out_base);
    if (!existsSync(path)) return null;
    const bytes = statSync(path).size;
    if (bytes === 0) return null;
    return {
      file_path: path,
      format,
      duration_s: wav_duration_s(wav_bytes),
      bytes,
    };
  } catch (err) {
    console.warn(`[astrid_cue_voice] clip synthesis failed (text ships without voice): ${(err as Error).message}`);
    return null;
  } finally {
    try {
      rmSync(tmp_wav, { force: true });
    } catch {
      // tmp cleanup is best-effort
    }
  }
}
