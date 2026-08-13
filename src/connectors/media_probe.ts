/**
 * Media probe connector — metadata-ONLY (never downloads a byte).
 *
 * Shells `yt-dlp --dump-single-json` (and `gallery-dl -j` as the fallback for
 * sites yt-dlp can't extract) and normalizes the raw info-json into the shared
 * `MediaProbeResult`. This is the DERIVED metric source for the whole Media
 * Archive pipeline: every number here is copied verbatim from the extractor,
 * NEVER authored by a model (LAW #1 — metrics are measured, not judged).
 *
 * Stub-aware like the OCR/VL connectors: a test transport
 * (`_test_set_probe_transport`) short-circuits the shell-out so smokes inject a
 * fixture info-json with no yt-dlp on the box.
 *
 * Fail-soft everywhere — a leaf NEVER throws up the stack. Every failure path
 * returns a well-formed `{ ok:false, error, candidates, extra:{} }` the caller
 * can route on. Env:
 *   HEARTH_YTDLP_BIN            (default "yt-dlp")
 *   HEARTH_GALLERYDL_BIN       (default "gallery-dl")
 *   HEARTH_MEDIA_PROBE_TIMEOUT_MS (default 60000)
 */

import type {
  MediaProbeResult,
  MediaProbeSource,
  MediaFormat,
  MediaChapter,
  GalleryImage,
} from '@core/media/types';

const YTDLP_BIN = process.env.HEARTH_YTDLP_BIN ?? 'yt-dlp';
const GALLERYDL_BIN = process.env.HEARTH_GALLERYDL_BIN ?? 'gallery-dl';
const PROBE_TIMEOUT_MS = Number(process.env.HEARTH_MEDIA_PROBE_TIMEOUT_MS ?? '60000');
/** Browser to impersonate (via yt-dlp's curl_cffi backend) when a site blocks
 *  the default extractor with a 403/bot wall. Requires curl_cffi in the image. */
const YTDLP_IMPERSONATE_TARGET = process.env.HEARTH_YTDLP_IMPERSONATE ?? 'chrome';

/** A site-level block (bot wall / Cloudflare / 403) — the class of failure that
 *  browser impersonation (or, ultimately, cookies) can get past, as opposed to a
 *  genuinely unavailable / unsupported URL. */
export function looks_blocked(err: string): boolean {
  return /\b403\b|forbidden|not a bot|sign in to confirm|unable to download webpage|blocked|cloudflare|access denied|captcha/i.test(
    err,
  );
}

/** Info-json keys that are big/noisy and never belong in `extra` (they're the
 *  raw source of the typed fields, or per-request junk). */
const NOISY_EXTRA_KEYS: ReadonlySet<string> = new Set([
  'formats',
  'thumbnails',
  'automatic_captions',
  'subtitles',
  'requested_formats',
  'requested_downloads',
  'http_headers',
  // NOTE: 'heatmap' is intentionally NOT dropped — it's the source site's
  // "most replayed" curve (grey scrubber overlay). The item-detail route lifts
  // it to a top-level `heatmap` field and strips it from the served `metrics`.
  '_format_sort_fields',
]);

// ── narrowing helpers — NEVER trust untyped JSON ─────────────────────────────

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

const strArr = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return out.length > 0 ? out : undefined;
};

const is_obj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** JSON.parse that never throws — `undefined` uniquely signals a parse failure
 *  (JSON can never produce `undefined`). */
function parse_json(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// ── test transport (mirrors ocr.ts `_test_set_ocr_transport`) ────────────────

let _test_transport: ((url: string) => Promise<MediaProbeResult>) | null = null;

export function _test_set_probe_transport(
  fn: ((url: string) => Promise<MediaProbeResult>) | null,
): void {
  _test_transport = fn;
}

/** True when a test transport is set OR a probe bin is configured. */
export function probe_reachable(): boolean {
  return _test_transport !== null || YTDLP_BIN.length > 0 || GALLERYDL_BIN.length > 0;
}

// ── failure shape ────────────────────────────────────────────────────────────

function fail_result(error: string, source: MediaProbeSource = 'yt-dlp'): MediaProbeResult {
  return {
    source,
    ok: false,
    error: error.slice(0, 500),
    candidates: [{ why: 'try the canonical page/watch URL' }],
    extra: {},
  };
}

// ── shell-out ────────────────────────────────────────────────────────────────

interface ShellOut {
  exit: number;
  stdout: string;
  stderr: string;
  spawn_error?: string;
}

/** Run a command with a hard timeout; fully fail-soft (a missing binary /
 *  timeout / read error all resolve to a structured `ShellOut`, never throw). */
async function run_command(cmd: string[], timeout_ms: number): Promise<ShellOut> {
  try {
    const proc = Bun.spawn(cmd, {
      stdout: 'pipe',
      stderr: 'pipe',
      // The extractor binaries live in /usr/local/bin. Bun.spawn inherits
      // process.env by default, but the gallery-dl fallback has been seen to
      // "Executable not found in $PATH" — pin the standard bin dirs so both
      // yt-dlp and gallery-dl always resolve regardless of the parent PATH.
      env: { ...process.env, PATH: `/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ''}` },
      signal: AbortSignal.timeout(timeout_ms),
    });
    let stdout = '';
    let stderr = '';
    try {
      stdout = await new Response(proc.stdout).text();
    } catch {
      /* ignore — partial/no stdout */
    }
    try {
      stderr = await new Response(proc.stderr).text();
    } catch {
      /* ignore — partial/no stderr */
    }
    let exit = -1;
    try {
      exit = await proc.exited;
    } catch {
      /* AbortSignal timeout / kill — leave exit at -1 */
    }
    return { exit, stdout, stderr };
  } catch (err) {
    // Synchronous spawn failure (binary not found, etc.).
    return { exit: -1, stdout: '', stderr: '', spawn_error: (err as Error).message };
  }
}

// ── yt-dlp normalization ─────────────────────────────────────────────────────

function build_extra(raw: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (NOISY_EXTRA_KEYS.has(k)) continue;
    extra[k] = v;
  }
  return extra;
}

function map_formats(v: unknown): MediaFormat[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: MediaFormat[] = [];
  for (const item of v) {
    if (!is_obj(item)) continue;
    const format_id =
      str(item.format_id) ??
      (typeof item.format_id === 'number' && Number.isFinite(item.format_id)
        ? String(item.format_id)
        : undefined);
    if (format_id === undefined) continue;
    const mf: MediaFormat = { format_id };
    const ext = str(item.ext);
    if (ext !== undefined) mf.ext = ext;
    const vcodec = str(item.vcodec);
    if (vcodec !== undefined) mf.vcodec = vcodec;
    const acodec = str(item.acodec);
    if (acodec !== undefined) mf.acodec = acodec;
    // Preserved deliberately: yt-dlp computes these even when the extractor left
    // vcodec/acodec null (which `str()` drops), so they're the only surviving
    // video/audio evidence on a generic-extractor format. See derive_audio_only.
    const audio_ext = str(item.audio_ext);
    if (audio_ext !== undefined) mf.audio_ext = audio_ext;
    const video_ext = str(item.video_ext);
    if (video_ext !== undefined) mf.video_ext = video_ext;
    const width = num(item.width);
    if (width !== undefined) mf.width = width;
    const height = num(item.height);
    if (height !== undefined) mf.height = height;
    const fps = num(item.fps);
    if (fps !== undefined) mf.fps = fps;
    const filesize = num(item.filesize);
    if (filesize !== undefined) mf.filesize = filesize;
    const filesize_approx = num(item.filesize_approx);
    if (filesize_approx !== undefined) mf.filesize_approx = filesize_approx;
    const tbr = num(item.tbr);
    if (tbr !== undefined) mf.tbr = tbr;
    out.push(mf);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * `is_audio_only` — a DOWNLOAD HINT, and nothing more.
 *
 * It means "every format looks audio-bearing and none looks video-bearing", and
 * its only legitimate use is picking yt-dlp's audio-only selector / the M4A
 * quality branch. It is NOT evidence about visual content and must NEVER waive
 * NSFW classification: a generic (HTML5-embed) extractor emits `vcodec: null`,
 * `str()` drops it, and so "no format declared a video codec" was silently TRUE
 * for a plain MP4 video — the inverted signal that let an explicit clip be filed
 * household-visible (2026-07-15). The NSFW pre-gate no longer consults this flag
 * at all; the tightening below is defense in depth, not the fix.
 *
 * A format that declares `audio_ext: 'none'` — or a `video_ext` other than
 * 'none' — BEARS VIDEO (verified against live yt-dlp: even the muxed avc1+mp4a
 * format 18 reports `audio_ext: 'none'`, while a real m4a reports
 * `video_ext: 'none'`). Either declaration therefore disqualifies audio-only no
 * matter what `vcodec` says or omits.
 *
 * Exported for the smoke (mirrors `srt_to_vtt`): a pure derivation over the exact
 * shape that leaked is worth pinning against real captured yt-dlp formats.
 */
export function derive_audio_only(formats: MediaFormat[]): boolean {
  if (formats.length === 0) return false;
  const bears_video = (f: MediaFormat): boolean =>
    (f.vcodec !== undefined && f.vcodec !== 'none') ||
    f.audio_ext === 'none' ||
    (f.video_ext !== undefined && f.video_ext !== 'none');
  return !formats.some(bears_video);
}

function map_chapters(v: unknown): MediaChapter[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: MediaChapter[] = [];
  for (const item of v) {
    if (!is_obj(item)) continue;
    const start_s = num(item.start_time);
    if (start_s === undefined) continue;
    const ch: MediaChapter = { start_s, title: str(item.title) ?? '' };
    const end_s = num(item.end_time);
    if (end_s !== undefined) ch.end_s = end_s;
    out.push(ch);
  }
  return out.length > 0 ? out : undefined;
}

/** Normalize a yt-dlp `--dump-single-json` single-video object. */
function normalize_ytdlp(raw: Record<string, unknown>): MediaProbeResult {
  const out: MediaProbeResult = { source: 'yt-dlp', ok: true, extra: build_extra(raw) };

  const extractor = str(raw.extractor);
  if (extractor !== undefined) out.extractor = extractor;
  const id = str(raw.id);
  if (id !== undefined) out.id = id;
  const webpage_url = str(raw.webpage_url);
  if (webpage_url !== undefined) out.webpage_url = webpage_url;
  const title = str(raw.title);
  if (title !== undefined) out.title = title;
  const uploader = str(raw.uploader);
  if (uploader !== undefined) out.uploader = uploader;
  const uploader_id = str(raw.uploader_id);
  if (uploader_id !== undefined) out.uploader_id = uploader_id;
  const channel = str(raw.channel);
  if (channel !== undefined) out.channel = channel;
  const channel_id = str(raw.channel_id);
  if (channel_id !== undefined) out.channel_id = channel_id;
  const channel_url = str(raw.channel_url);
  if (channel_url !== undefined) out.channel_url = channel_url;
  const upload_date = str(raw.upload_date);
  if (upload_date !== undefined) out.upload_date = upload_date;
  const timestamp = num(raw.timestamp);
  if (timestamp !== undefined) out.timestamp = timestamp;
  const duration_s = num(raw.duration);
  if (duration_s !== undefined) out.duration_s = duration_s;
  const view_count = num(raw.view_count);
  if (view_count !== undefined) out.view_count = view_count;
  const like_count = num(raw.like_count);
  if (like_count !== undefined) out.like_count = like_count;
  const comment_count = num(raw.comment_count);
  if (comment_count !== undefined) out.comment_count = comment_count;
  const age_limit = num(raw.age_limit);
  if (age_limit !== undefined) out.age_limit = age_limit;
  const availability = str(raw.availability);
  if (availability !== undefined) out.availability = availability;
  const language = str(raw.language);
  if (language !== undefined) out.language = language;
  const description = str(raw.description);
  if (description !== undefined) out.description = description;
  const tags = strArr(raw.tags);
  if (tags !== undefined) out.tags = tags;
  const categories = strArr(raw.categories);
  if (categories !== undefined) out.categories = categories;
  const thumbnail = str(raw.thumbnail);
  if (thumbnail !== undefined) out.thumbnail = thumbnail;

  const chapters = map_chapters(raw.chapters);
  if (chapters !== undefined) out.chapters = chapters;

  const formats = map_formats(raw.formats);
  if (formats !== undefined) {
    out.formats = formats;
    // derived DOWNLOAD HINT: no video-bearing format present (music / podcast).
    // Never a substitute for classifying a visual artifact — see derive_audio_only.
    out.is_audio_only = derive_audio_only(formats);
  }

  return out;
}

// ── gallery-dl normalization ─────────────────────────────────────────────────

function build_gallery_image(
  idx: number,
  url: string,
  meta: Record<string, unknown> | undefined,
): GalleryImage {
  const img: GalleryImage = { idx };
  const u = str(url);
  if (u !== undefined) img.url = u;
  if (meta !== undefined) {
    const ext = str(meta.extension) ?? str(meta.ext);
    if (ext !== undefined) img.ext = ext;
    const width = num(meta.width);
    if (width !== undefined) img.width = width;
    const height = num(meta.height);
    if (height !== undefined) img.height = height;
    img.extra = meta;
  }
  return img;
}

/**
 * Normalize `gallery-dl -j` output. It emits an ARRAY of messages: a Url
 * message is a tuple `[type, url, metadata]`; a Directory message carries
 * gallery-level metadata. Some builds emit plain objects. Be defensive about
 * both — collect image entries into `images[]`, fold gallery metadata into
 * `extra`, and set `image_count` as the kind hint.
 */
function normalize_gallerydl(parsed: unknown): MediaProbeResult {
  const images: GalleryImage[] = [];
  let gallery_meta: Record<string, unknown> = {};
  let idx = 0;

  const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  for (const entry of entries) {
    if (Array.isArray(entry)) {
      // tuple message — pick the first string (the url) and the first object
      // (the metadata), position-agnostic across gallery-dl versions.
      const url_part = entry.find((x): x is string => typeof x === 'string');
      const meta_part = entry.find((x): x is Record<string, unknown> => is_obj(x));
      if (url_part !== undefined) {
        images.push(build_gallery_image(idx++, url_part, meta_part));
      } else if (meta_part !== undefined) {
        gallery_meta = { ...gallery_meta, ...meta_part };
      }
    } else if (is_obj(entry)) {
      const u = str(entry.url);
      if (u !== undefined) {
        images.push(build_gallery_image(idx++, u, entry));
      } else {
        gallery_meta = { ...gallery_meta, ...entry };
      }
    }
  }

  const out: MediaProbeResult = { source: 'gallery-dl', ok: true, extra: gallery_meta };

  if (images.length > 0) {
    out.images = images;
    out.image_count = images.length; // the media_kind hint (gallery/photoset)
  }

  // Lift a few common typed fields when the gallery metadata carries them —
  // cheap, harmless, and useful to the downstream category model.
  const extractor = str(gallery_meta.category) ?? str(gallery_meta.extractor);
  if (extractor !== undefined) out.extractor = extractor;
  const title = str(gallery_meta.title);
  if (title !== undefined) out.title = title;
  const webpage_url = str(gallery_meta.webpage_url) ?? str(gallery_meta.gallery_url);
  if (webpage_url !== undefined) out.webpage_url = webpage_url;
  const uploader = str(gallery_meta.artist) ?? str(gallery_meta.username) ?? str(gallery_meta.user);
  if (uploader !== undefined) out.uploader = uploader;

  return out;
}

// ── attempt orchestration ────────────────────────────────────────────────────

type Attempt = { ok: true; result: MediaProbeResult } | { ok: false; error: string };

async function try_ytdlp(url: string, opts?: { impersonate?: boolean }): Promise<Attempt> {
  const cmd = [YTDLP_BIN, '--dump-single-json', '--no-playlist', '--no-warnings'];
  if (opts?.impersonate) cmd.push('--impersonate', YTDLP_IMPERSONATE_TARGET);
  cmd.push(url);
  const out = await run_command(cmd, PROBE_TIMEOUT_MS);
  if (out.spawn_error !== undefined) {
    return { ok: false, error: `yt-dlp not runnable: ${out.spawn_error}` };
  }
  if (out.exit !== 0 || out.stdout.trim().length === 0) {
    return {
      ok: false,
      error: `yt-dlp exit ${out.exit}: ${(out.stderr || out.stdout).slice(0, 300).trim()}`,
    };
  }
  const parsed = parse_json(out.stdout);
  if (!is_obj(parsed)) {
    return {
      ok: false,
      error: `yt-dlp JSON unparseable: ${(out.stderr || out.stdout).slice(0, 300).trim()}`,
    };
  }
  return { ok: true, result: normalize_ytdlp(parsed) };
}

async function try_gallerydl(url: string): Promise<Attempt> {
  const out = await run_command([GALLERYDL_BIN, '-j', url], PROBE_TIMEOUT_MS);
  if (out.spawn_error !== undefined) {
    return { ok: false, error: `gallery-dl not runnable: ${out.spawn_error}` };
  }
  if (out.exit !== 0 || out.stdout.trim().length === 0) {
    return {
      ok: false,
      error: `gallery-dl exit ${out.exit}: ${(out.stderr || out.stdout).slice(0, 300).trim()}`,
    };
  }
  const parsed = parse_json(out.stdout);
  if (parsed === undefined) {
    return {
      ok: false,
      error: `gallery-dl JSON unparseable: ${out.stderr.slice(0, 300).trim()}`,
    };
  }
  return { ok: true, result: normalize_gallerydl(parsed) };
}

// ── public entry ─────────────────────────────────────────────────────────────

/**
 * Metadata-only probe of a media URL. Tries yt-dlp first; on any failure
 * (non-zero exit, "Unsupported URL", unparseable JSON) falls back to
 * gallery-dl. Returns a fail-soft `{ ok:false, … }` when both fail — NEVER
 * throws.
 */
// yt-dlp only fills `heatmap` for YouTube. PornHub embeds an equivalent —
// a per-segment view-weight array in the watch page flashvars (`hotspots`).
// extract_hotspots.py fetches it (curl_cffi impersonation, beats the 403) and
// returns yt-dlp-shaped {start_time,end_time,value} segments. Fail-soft.
const HOTSPOTS_SCRIPT = ((import.meta as unknown as { dir: string }).dir) + '/extract_hotspots.py';

async function fetch_hotspots_heatmap(url: string): Promise<unknown[] | null> {
  const out = await run_command(['python3', HOTSPOTS_SCRIPT, url], PROBE_TIMEOUT_MS);
  if (out.exit !== 0 || out.stdout.trim().length === 0) return null;
  const parsed = parse_json(out.stdout.trim());
  return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
}

/** Populate `heatmap` for sites yt-dlp doesn't (PornHub) by scraping the page's
 *  popularity array. Mutates result.extra.heatmap so it flows into metrics. */
async function maybe_enrich_heatmap(url: string, result: MediaProbeResult): Promise<void> {
  const extra = result.extra as Record<string, unknown> | undefined;
  if (!extra || Array.isArray(extra.heatmap)) return; // YouTube already carries one
  if (!/pornhub\.com/i.test(url)) return; // gated to sites we know embed hotspots
  const heat = await fetch_hotspots_heatmap(url);
  if (heat) extra.heatmap = heat;
}

export async function probe_media(url: string): Promise<MediaProbeResult> {
  // Test transport first (smoke injection — no shell-out).
  if (_test_transport !== null) {
    try {
      return await _test_transport(url);
    } catch (err) {
      return fail_result(`probe_transport_error: ${(err as Error).message}`);
    }
  }

  if (typeof url !== 'string' || url.trim().length === 0) {
    return fail_result('empty url');
  }

  let yt_err = 'yt-dlp: no result';
  try {
    const yt = await try_ytdlp(url);
    if (yt.ok) {
      await maybe_enrich_heatmap(url, yt.result);
      return yt.result;
    }
    yt_err = yt.error;
    // Site-level block (403 / bot wall) → retry with browser impersonation
    // (yt-dlp's curl_cffi backend). Only on a blocked-class error so working
    // sites never pay for it; degrades gracefully to the same error when
    // curl_cffi isn't in the image.
    if (looks_blocked(yt.error)) {
      const imp = await try_ytdlp(url, { impersonate: true });
      if (imp.ok) {
        await maybe_enrich_heatmap(url, imp.result);
        return imp.result;
      }
      yt_err = `${yt.error} | impersonate(${YTDLP_IMPERSONATE_TARGET}): ${imp.error}`;
    }
  } catch (err) {
    yt_err = `yt-dlp threw: ${(err as Error).message}`;
  }

  let gd_err = 'gallery-dl: no result';
  try {
    const gd = await try_gallerydl(url);
    if (gd.ok) return gd.result;
    gd_err = gd.error;
  } catch (err) {
    gd_err = `gallery-dl threw: ${(err as Error).message}`;
  }

  return fail_result(`probe failed — ${yt_err} | ${gd_err}`);
}
