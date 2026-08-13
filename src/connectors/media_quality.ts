/**
 * src/connectors/media_quality.ts
 *
 * PURE, deterministic QUALITY decision for the Media Archive pipeline
 * (design-media-archival.md). No I/O, no LLM, no fabrication — every number is
 * read straight off the probe's real `formats[]`. LAW #1: metrics are measured
 * (the probe), the format selection is deterministic (this module).
 *
 * AVPlayer-compat is paid at DOWNLOAD time, decided HERE:
 *   - audio                 → AAC / M4A (recode only if the source is opus/vorbis)
 *   - video ≤1080p H.264    → cheap MP4 remux (no recode)
 *   - video >1080p VP9/AV1  → HEVC / MP4 recode (YouTube has no >1080p H.264)
 * Default cap 4K (2160p) / ~20 GB; a rep over the size cap flags an ask — the
 * runner downloads the capped rep and files the ask, this only sets the flag.
 *
 * Fail-soft: a malformed / empty / codec-unknown probe returns a sensible
 * best≤cap MP4 default with needs_recode=false. This leaf never throws.
 */

import type { MediaProbeResult, MediaFormat, QualityDecision } from '@core/media/types';

const BYTES_PER_GB = 1024 * 1024 * 1024;
/** sentinel "no height cap" (the "best"/"source" override) */
const NO_HEIGHT_CAP = Number.MAX_SAFE_INTEGER;

// ---- untyped-JSON narrowing helpers (never trust probe fields blindly) ----
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

function env_int(raw: string | undefined, dflt: number): number {
  if (raw == null) return dflt;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
function env_float(raw: string | undefined, dflt: number): number {
  if (raw == null) return dflt;
  const n = Number.parseFloat(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * The cap policy from env. This is the ONLY place env is read; `decide_quality`
 * stays pure by seeding its defaults from here and taking overrides via `opts`.
 * HEARTH_MEDIA_MAX_HEIGHT (default 2160) + HEARTH_MEDIA_MAX_GB (default 20).
 */
export function default_quality_policy(): { max_height: number; max_bytes: number } {
  const max_height = env_int(process.env.HEARTH_MEDIA_MAX_HEIGHT, 2160);
  const max_gb = env_float(process.env.HEARTH_MEDIA_MAX_GB, 20);
  return { max_height, max_bytes: Math.round(max_gb * BYTES_PER_GB) };
}

// ---- codec classification (base token of 'avc1.640028', 'vp9', 'none', …) ----
function codec_base(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const first = s.toLowerCase().split(/[.\s]/)[0];
  return first && first.length > 0 ? first : undefined;
}
function is_h264(v: unknown): boolean {
  const b = codec_base(v);
  return b === 'avc1' || b === 'avc' || b === 'h264';
}
/** codecs that must be recoded to HEVC when >1080p (no native H.264 at that height) */
function is_recode_vcodec(b: string | undefined): boolean {
  return b === 'vp9' || b === 'vp09' || b === 'av01' || b === 'av1';
}
function is_video_fmt(f: MediaFormat): boolean {
  const vb = codec_base(f.vcodec);
  return vb != null && vb !== 'none';
}
function is_audio_only_fmt(f: MediaFormat): boolean {
  const ab = codec_base(f.acodec);
  const vb = codec_base(f.vcodec);
  return ab != null && ab !== 'none' && (vb == null || vb === 'none');
}
function is_m4a_audio(f: MediaFormat): boolean {
  const ext = str(f.ext)?.toLowerCase();
  const ab = codec_base(f.acodec);
  return ext === 'm4a' || ab === 'mp4a' || ab === 'aac';
}

function pick_max<T>(list: readonly T[], cmp: (a: T, b: T) => number): T | undefined {
  let best: T | undefined;
  for (const item of list) {
    if (best === undefined || cmp(item, best) > 0) best = item;
  }
  return best;
}
/** highest resolution wins; ties prefer H.264 (compat), then fps, bitrate, size */
function cmp_video(a: MediaFormat, b: MediaFormat): number {
  const ha = num(a.height) ?? 0;
  const hb = num(b.height) ?? 0;
  if (ha !== hb) return ha - hb;
  const ca = is_h264(a.vcodec) ? 1 : 0;
  const cb = is_h264(b.vcodec) ? 1 : 0;
  if (ca !== cb) return ca - cb;
  const fa = num(a.fps) ?? 0;
  const fb = num(b.fps) ?? 0;
  if (fa !== fb) return fa - fb;
  const ta = num(a.tbr) ?? 0;
  const tb = num(b.tbr) ?? 0;
  if (ta !== tb) return ta - tb;
  const sa = num(a.filesize) ?? num(a.filesize_approx) ?? 0;
  const sb = num(b.filesize) ?? num(b.filesize_approx) ?? 0;
  return sa - sb;
}
/** highest bitrate wins, then size */
function cmp_audio(a: MediaFormat, b: MediaFormat): number {
  const ta = num(a.tbr) ?? 0;
  const tb = num(b.tbr) ?? 0;
  if (ta !== tb) return ta - tb;
  const sa = num(a.filesize) ?? num(a.filesize_approx) ?? 0;
  const sb = num(b.filesize) ?? num(b.filesize_approx) ?? 0;
  return sa - sb;
}

/** exact filesize → approx → bitrate×duration (tbr kbps ×1000/8 = bytes/s) */
function est_size(f: MediaFormat, duration_s: number | undefined): number | undefined {
  const exact = num(f.filesize) ?? num(f.filesize_approx);
  if (exact != null) return exact;
  const tbr = num(f.tbr);
  const dur = num(duration_s);
  if (tbr != null && tbr > 0 && dur != null && dur > 0) {
    return Math.round((tbr * 1000 / 8) * dur);
  }
  return undefined;
}

function gb(n: number): string {
  return (n / BYTES_PER_GB).toFixed(1);
}

/**
 * yt-dlp -f selection expression; undefined cap → uncapped best.
 *
 * ── The cap is a PREFERENCE, never a precondition ─────────────────────────────
 * This module's stated policy is "take the capped rep and flag it" (see the
 * `fallback` branch and the `over_cap` ask) — never "refuse the item". A
 * selector that can match NOTHING breaks that policy, because yt-dlp then exits
 * 1 with "Requested format is not available" and the runner burns its three
 * retries on a deterministic failure. Two clauses keep the expression total:
 *
 *   • `height<=?N` — note the `?`. yt-dlp's numeric filters EXCLUDE a format
 *     whose field is unknown unless the operator carries that suffix. A generic
 *     / HTML5-embed extractor emits exactly one format with no height at all
 *     (`0  mp4  unknown  | https | unknown unknown`), so the unsuffixed filter
 *     matched zero formats and killed the download of a plain, directly
 *     fetchable MP4 (sickjunk.com, jobs ma_ry9gxgxvaz57 + ma_cchh1m7avb6e,
 *     2026-08-11). A height nobody measured cannot be over the cap; filtering it
 *     out asserts the opposite.
 *   • the terminal uncapped clause — if every rep IS measured and every one is
 *     over the cap, download the best one rather than fail. `decide_quality`
 *     already reaches that outcome when the PROBE reported heights; this makes
 *     it hold when the probe reported none and yt-dlp saw them anyway.
 */
function video_selector(cap: number | undefined): string {
  if (cap == null || !Number.isFinite(cap) || cap >= NO_HEIGHT_CAP) {
    return 'bestvideo+bestaudio/best';
  }
  return `bestvideo[height<=?${cap}]+bestaudio/best[height<=?${cap}]/bestvideo+bestaudio/best`;
}

interface Override {
  force_audio: boolean;
  uncapped: boolean;
  height_cap?: number;
}
/** lenient parse of e.g. "2160", "1080p", "audio", "best" */
function parse_override(o: string | undefined): Override {
  const s = str(o)?.trim().toLowerCase();
  if (!s) return { force_audio: false, uncapped: false };
  if (s === 'audio') return { force_audio: true, uncapped: false };
  if (s === 'best' || s === 'max' || s === 'source' || s === 'highest') {
    return { force_audio: false, uncapped: true };
  }
  const digits = s.replace(/[^\d]/g, '');
  if (digits.length > 0) {
    const n = Number.parseInt(digits, 10);
    if (Number.isFinite(n) && n > 0) return { force_audio: false, uncapped: false, height_cap: n };
  }
  return { force_audio: false, uncapped: false };
}

/**
 * Deterministic quality decision from the probe's real formats + the cap policy.
 * Pure: env is read only via the seeded `default_quality_policy()` default;
 * `opts` overrides win. Always returns a valid QualityDecision (fail-soft).
 */
export function decide_quality(
  probe: MediaProbeResult,
  opts?: { max_height?: number; max_bytes?: number; audio_only?: boolean; quality_override?: string },
): QualityDecision {
  const policy = { ...default_quality_policy(), ...(opts ?? {}) };
  const max_height = num(policy.max_height) ?? 2160;
  const max_bytes = num(policy.max_bytes) ?? Math.round(20 * BYTES_PER_GB);

  const ov = parse_override(opts?.quality_override);
  const raw_formats: MediaFormat[] = Array.isArray(probe.formats) ? probe.formats : [];
  const audio_only = ov.force_audio || opts?.audio_only === true || probe.is_audio_only === true;

  // ---------------------------------------------------------------- AUDIO ----
  if (audio_only) {
    const audio_fmts = raw_formats.filter(is_audio_only_fmt);
    const best_m4a = pick_max(audio_fmts.filter(is_m4a_audio), cmp_audio);
    const best_any = pick_max(audio_fmts, cmp_audio);
    const chosen = best_m4a ?? best_any;

    // the `bestaudio[ext=m4a]/bestaudio` selector prefers a native M4A; a recode
    // is only needed when the best available audio is opus/vorbis and no M4A exists.
    let needs_recode = false;
    if (!best_m4a && best_any) {
      const ab = codec_base(best_any.acodec);
      needs_recode = ab === 'opus' || ab === 'vorbis';
    }

    const est = chosen ? est_size(chosen, probe.duration_s) : undefined;
    const over_cap = est != null && est > max_bytes;

    let reason = needs_recode
      ? `audio-only: best source is ${codec_base(best_any?.acodec) ?? 'opus/vorbis'} → AAC/M4A recode`
      : chosen
        ? 'audio-only: AAC/M4A, no recode'
        : 'audio-only: formats unknown — bestaudio → M4A, no recode';
    if (over_cap && est != null) {
      reason += ` — est ${gb(est)}GB over ${gb(max_bytes)}GB cap; capped rep + ask`;
    }

    return {
      format_selector: 'bestaudio[ext=m4a]/bestaudio',
      target_height: 0,
      container: 'm4a',
      needs_recode,
      audio_only: true,
      ...(est != null ? { est_filesize_bytes: est } : {}),
      over_cap,
      reason,
    };
  }

  // ---------------------------------------------------------------- VIDEO ----
  const effective_cap = ov.uncapped ? NO_HEIGHT_CAP : (ov.height_cap ?? max_height);
  const sel_cap = ov.uncapped ? undefined : effective_cap;

  const videos = raw_formats.filter((f) => is_video_fmt(f) && num(f.height) != null);
  const under = videos.filter((f) => {
    const h = num(f.height);
    return h != null && h <= effective_cap;
  });

  let chosen: MediaFormat | undefined;
  let fallback = false;
  if (under.length > 0) {
    chosen = pick_max(under, cmp_video);
  } else if (videos.length > 0) {
    // nothing at/under the cap — take the max available (runner caps + flags)
    chosen = pick_max(videos, cmp_video);
    fallback = true;
  }

  // formats unknown / no height-bearing video rep → sensible best≤cap MP4 default
  if (!chosen) {
    const target_height = ov.uncapped ? 0 : effective_cap;
    const cap_label = ov.uncapped ? 'source' : `${effective_cap}p`;
    // Say WHICH of the three blind spots this is — Kate reads this line verbatim
    // out of `quality_json` when she explains a download. "formats unknown/absent"
    // was told even when the probe DID return a format that simply carried no
    // height, which is the one case where the selector's `?` operator is doing the
    // work, and the one a human needs to recognise on sight.
    const blind =
      raw_formats.length === 0
        ? 'probe returned no formats'
        : raw_formats.some(is_video_fmt)
          ? `${raw_formats.length} format(s), none carrying a height`
          : `${raw_formats.length} format(s), none declaring a video codec (generic/HTML5 extractor)`;
    return {
      format_selector: video_selector(sel_cap),
      target_height,
      container: 'mp4',
      needs_recode: false,
      audio_only: false,
      over_cap: false,
      reason: `no measurable video rep — ${blind}; default best≤${cap_label} H.264/MP4, no recode (unknown heights pass the cap, resolved at download)`,
    };
  }

  const chosen_h = num(chosen.height) ?? effective_cap;
  // On fallback (every rep exceeds the cap) the target IS the chosen rep, and the
  // selector must be UNCAPPED (below) — a `height<=cap` selector would match no
  // format and yt-dlp would exit "Requested format is not available".
  const target_height = fallback ? chosen_h : Math.min(chosen_h, effective_cap);
  const vbase = codec_base(chosen.vcodec);
  const needs_recode = target_height > 1080 && is_recode_vcodec(vbase);
  const est = est_size(chosen, probe.duration_s);
  const over_cap = est != null && est > max_bytes;

  const codec_label = vbase ?? 'unknown';
  let reason = needs_recode
    ? `video ${target_height}p ${codec_label} → HEVC/MP4 recode (>1080p is not AVPlayer-native)`
    : `video ${target_height}p ${is_h264(chosen.vcodec) ? 'H.264' : codec_label}/MP4, remux only (no recode)`;
  if (fallback) reason += `; all reps exceed ${effective_cap}p cap — capped to ${target_height}p`;
  if (over_cap && est != null) reason += `; est ${gb(est)}GB over ${gb(max_bytes)}GB cap — capped rep + ask`;

  return {
    format_selector: fallback ? video_selector(undefined) : video_selector(sel_cap),
    target_height,
    container: 'mp4',
    needs_recode,
    audio_only: false,
    ...(est != null ? { est_filesize_bytes: est } : {}),
    over_cap,
    reason,
  };
}
