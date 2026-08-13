/**
 * Media download + keyframe sampling for the archival runner.
 *
 * Shells the yt-dlp ENGINE directly (the same engine MeTube wraps) so the runner
 * gets a deterministic output path + the .info.json sidecar + a post-download
 * recode — control MeTube's queue UI can't express. MeTube stays Maggie's manual
 * surface; this is the pipeline's programmatic path. Image galleries (gallery-dl)
 * are a Phase-2 feature — the download path rejects them cleanly for now.
 *
 * AVPlayer-compat is paid HERE, once, in the background: prefer H.264/AAC MP4
 * (cheap remux); `--recode-video mp4` when the source is VP9/AV1 >1080p. The
 * stream endpoint is then pure direct-play.
 *
 * Both entry points are test-seamable (mirrors ocr/nsfw) so smokes run with no
 * shell-out, no yt-dlp, no ffmpeg, no NAS. The one deliberate exception is
 * `smoke:media-taxonomy` section G3, which must exercise the REAL `download_media`
 * to prove the path it writes is the path the taxonomy predicts — it points
 * `HEARTH_YTDLP_BIN`/`HEARTH_GALLERYDL_BIN` at a local stub script, still with no
 * network and no NAS.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type {
  MediaDownloadResult,
  QualityDecision,
  MediaProbeSource,
  SubtitleTrack,
  SubtitleFetchResult,
} from '@core/media/types';
import { media_canonical_stem, media_entry_belongs_to, media_safe_segment } from '@core/media/taxonomy';

/**
 * The external binaries, resolved at CALL time rather than at import (same shape
 * as `gallery_max()` below). Reading env lazily is what lets a smoke point the
 * download path at a stub `yt-dlp` and exercise the REAL `download_media` —
 * including the `-o` template, the `mkdir` and `locate_result` — instead of the
 * test seam, which is what section G3 of `smoke:media-taxonomy` needs to prove
 * the path on disk equals `media_canonical_path`.
 */
const ytdlp_bin = (): string => process.env.HEARTH_YTDLP_BIN ?? 'yt-dlp';
const gallerydl_bin = (): string => process.env.HEARTH_GALLERYDL_BIN ?? 'gallery-dl';
const ffmpeg_bin = (): string => process.env.HEARTH_FFMPEG_BIN ?? 'ffmpeg';
const DOWNLOAD_TIMEOUT_MS = Number(process.env.HEARTH_MEDIA_DOWNLOAD_TIMEOUT_MS ?? '1800000'); // 30 min
/** Safety cap on gallery size (a booru tag page can be thousands of images). */
function gallery_max(): number {
  const n = Number(process.env.HEARTH_MEDIA_GALLERY_MAX ?? '500');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
}

export interface DownloadArgs {
  url: string;
  source: MediaProbeSource;
  quality: QualityDecision;
  /** taxonomy path segments under the archive root (already category-decided) */
  folder_segments: string[];
  /** absolute NAS archive root */
  archive_root: string;
  /** media id (mi_…) — the sidecar key, and the id half of the filename stem */
  id: string;
  /**
   * The item's human title (the decision's `title_clean`) — the NAME half of the
   * filename stem, `<title> [<id>]`. Optional and tolerant: an item with no title
   * falls back to the bare `<id>` stem, which is exactly what every pre-2026-07-29
   * archive already uses.
   */
  title?: string | null;
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Browser to impersonate (yt-dlp curl_cffi) when a site 403s the download. */
const YTDLP_IMPERSONATE_TARGET = process.env.HEARTH_YTDLP_IMPERSONATE ?? 'chrome';

/**
 * yt-dlp's "you asked for a format I do not have" exit. It is the one download
 * failure whose CAUSE is absent from its own message: the line names neither the
 * selector we asked for nor the formats that existed, so a ledger row reading
 * `Requested format is not available` is unactionable on its face — which is
 * exactly how the sickjunk.com pair (2026-08-11) sat as "other / retry once".
 */
const FORMAT_UNAVAILABLE = /requested format is not available/i;
/** `-F` is metadata-only (no media); it gets a short leash, not the download one. */
const LIST_FORMATS_TIMEOUT_MS = 60_000;

/**
 * yt-dlp's OWN diagnosis line, whole.
 *
 * The failure paths used to record `stderr.slice(0, 300)` — an arbitrary HEAD cut
 * that severed the sentence carrying the answer (`… (caused by <HTTPError 403:
 * For` is what job ma_wdrffz2vkp0b actually stored). yt-dlp prints its verdict on
 * one `ERROR:` line, so take THAT line.
 */
function ytdlp_error_line(stderr: string, max = 400): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const err = lines.find((l) => l.startsWith('ERROR:')) ?? lines[lines.length - 1] ?? '(no stderr)';
  return err.slice(0, max);
}

// ── what formats does this URL actually have? (metadata-only) ────────────────
let _test_list_formats: ((url: string) => Promise<string | null>) | null = null;
export function _test_set_list_formats_transport(
  fn: ((url: string) => Promise<string | null>) | null,
): void {
  _test_list_formats = fn;
}

/**
 * `yt-dlp -F` — the format table a URL offers RIGHT NOW. Metadata only; it
 * downloads no media (same posture as `fetch_subtitles`' `--skip-download`).
 *
 * ONE producer, two readers, because they are the same question asked at two
 * moments: `download_error` asks it at the instant of failure (so the ledger row
 * carries the evidence forever), and `media_archive_status(diagnose:true)` asks
 * it live (so Kate can diagnose a row that FAILED BEFORE this evidence was being
 * recorded — including the two sickjunk jobs that motivated all of this — and so
 * she sees what the site offers today rather than what it offered then).
 *
 * Fail-soft: returns null on any failure. A diagnosis is never worth throwing over.
 */
export async function list_formats(url: string): Promise<string | null> {
  if (_test_list_formats) return _test_list_formats(url);
  try {
    const res = await run(
      [ytdlp_bin(), '-F', '--no-playlist', '--no-warnings', url],
      LIST_FORMATS_TIMEOUT_MS,
    );
    const table = res.stdout.trim();
    return table.length > 0 ? table.slice(0, 1200) : null;
  } catch {
    return null;
  }
}

/**
 * The error a failed download throws — i.e. the text that lands in the job's
 * `error` column and is read back by `media_archive_status`.
 *
 * For the format-selection failure it appends BOTH facts yt-dlp's own line omits,
 * in a shape that tool parses (`selector:` / `formats offered:`), so Kate reports
 * what was wanted against what existed instead of "try again". One extra metadata
 * call, only on that error class.
 */
async function download_error(
  args: DownloadArgs,
  res: SpawnResult,
  selector: string,
  note = '',
): Promise<Error> {
  const head = `${args.source} download failed (exit ${res.code}${note}): ${ytdlp_error_line(res.stderr)}`;
  if (!FORMAT_UNAVAILABLE.test(res.stderr)) return new Error(head);
  const offered = await list_formats(args.url);
  return new Error(
    `${head}\nselector: ${selector}\nformats offered: ${offered ? `\n${offered}` : '(--list-formats returned nothing)'}`,
  );
}

async function run(cmd: string[], timeout_ms: number): Promise<SpawnResult> {
  const proc = Bun.spawn(cmd, {
    stdout: 'pipe',
    stderr: 'pipe',
    // Pin the standard bin dirs so yt-dlp/ffmpeg resolve regardless of the
    // orchestrator process's PATH (they live in /usr/local/bin).
    env: { ...process.env, PATH: `/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ''}` },
    signal: AbortSignal.timeout(timeout_ms),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

/**
 * Resolve `archive_root / seg / seg / …` clamped under the (NORMALIZED) root.
 *
 * ── ONE producer of a folder name (review 2026-07-29) ─────────────────────────
 * This used to map its OWN sanitiser over the segments — `SEG_UNSAFE`, an ASCII
 * allowlist that replaced everything else with `_`. So the taxonomy derived
 * `Music/Rebecca Black/Don't Stop`, this wrote `Music/Rebecca Black/Don_t Stop`,
 * `nas_path` stored the taxonomy's spelling, and the item was `is_off_schema` the
 * moment it finished downloading. Harmless while a folder segment was always a
 * vocabulary word or a channel handle; the title rung in the Music/Audio third
 * slot made it "any single with an apostrophe".
 *
 * The cleaner is now `media_safe_segment` — the taxonomy's own, the ONE producer
 * — so what lands on disk IS what `media_canonical_path` predicts, byte for byte
 * (pinned end-to-end through this function by `smoke:media-taxonomy` section G3).
 *
 * It is still APPLIED here rather than trusted, and that is not a second rule:
 * the same function twice is one rule (`clean_component` is idempotent, asserted
 * in G3), whereas a different function downstream was the defect. It has to be
 * applied, because `folder_segments` reaches the download slice as untyped JSON
 * off a persisted `media_archive_jobs` row — possibly written by a build that
 * predates the deriver, when the model still authored the path — and the
 * containment clamp below is the only other thing standing between that row and
 * an arbitrary write location.
 */
function dest_dir(archive_root: string, segments: string[]): string | null {
  // Normalize the root FIRST so a relative ('./data/…') or trailing-slash root
  // still clamps correctly (resolve() strips the trailing slash + makes it
  // absolute against cwd) — otherwise the containment check rejects everything.
  const root = resolve(archive_root);
  // `media_safe_segment` never returns '' (a segment that cleans away becomes the
  // `Unknown` placeholder), which is deliberate: dropping an empty segment here
  // would left-shift the rest and re-open the very slot-slide the taxonomy's
  // constant depth exists to prevent.
  const rel = segments.map(media_safe_segment).join('/');
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

/**
 * The archive-relative directory a download will write into — `dest_dir`'s answer,
 * expressed the way `nas_path` and `media_canonical_dir` express a path.
 *
 * Exported for ONE reason: so a test can compare the path this module builds
 * against `media_canonical_path` without reimplementing either. That agreement
 * was untested, which is how the two sanitisers drifted apart unnoticed.
 */
export function _writer_dest_dir_rel(archive_root: string, segments: string[]): string | null {
  const abs = dest_dir(archive_root, segments);
  if (abs === null) return null;
  return relative(resolve(archive_root), abs).split(sep).join('/');
}

/** Real playable containers — the media file MUST be one of these (never a thumbnail image). */
const VIDEO_AUDIO_EXTS = new Set(['mp4', 'm4v', 'mkv', 'webm', 'mov', 'm4a', 'mp3', 'opus']);
const THUMB_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']);
/** Gallery image containers (gallery-dl output — the gallery viewer renders these). */
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'jfif']);

function ext_of(f: string): string {
  return f.slice(f.lastIndexOf('.') + 1).toLowerCase();
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

// ── test seam ────────────────────────────────────────────────────────────────
let _test_download: ((args: DownloadArgs) => Promise<MediaDownloadResult>) | null = null;
export function _test_set_download_transport(
  fn: ((args: DownloadArgs) => Promise<MediaDownloadResult>) | null,
): void {
  _test_download = fn;
}

// ── subtitle / caption rescan (metadata-only; the video already exists) ───────
// A LIGHTWEIGHT re-scan of an already-archived item for its caption tracks. NO
// video re-download (`--skip-download` is load-bearing — omit it and yt-dlp
// re-pulls the whole video). Writes `<stem>.<lang>.srt` next to the media file
// and returns the tracks found. Reuses run()/ytdlp_bin() + the same 403 → browser-
// impersonate retry as download_media. Fail-soft: a source with no captions
// exits 0 and writes nothing → { captions: [] }.
export interface SubtitleFetchArgs {
  /** the origin URL to re-fetch captions from (the item's source_url). */
  url: string;
  /** absolute directory the media file lives in (subs land beside it). */
  dir_abs: string;
  /**
   * The media file's basename sans extension — derived from the item's stored
   * `nas_path` by `dir_and_stem`, NOT rebuilt from the id. That is what makes this
   * facet indifferent to the stem shape: it writes `<stem>.<lang>.srt` beside
   * whatever the media file is actually called, so it works unchanged for a
   * legacy `<id>` stem and a canonical `<title> [<id>]` one.
   */
  stem: string;
  /** yt-dlp --sub-langs value, e.g. 'en.*' or 'en.*,es.*'. */
  langs: string;
  /** absolute archive root — to relativize the returned track paths. */
  archive_root: string;
}

let _test_subtitles: ((args: SubtitleFetchArgs) => Promise<SubtitleFetchResult>) | null = null;
export function _test_set_subtitle_transport(
  fn: ((args: SubtitleFetchArgs) => Promise<SubtitleFetchResult>) | null,
): void {
  _test_subtitles = fn;
}

function escape_regex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Scan `dir_abs` for `<stem>.<lang>.srt` → SubtitleTrack[] (sorted by lang). */
export function scan_subtitle_tracks(dir_abs: string, stem: string, archive_root: string): SubtitleTrack[] {
  const re = new RegExp(`^${escape_regex(stem)}\\.([A-Za-z0-9_-]+)\\.srt$`);
  const out: SubtitleTrack[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir_abs);
  } catch {
    return out;
  }
  for (const f of files) {
    const m = re.exec(f);
    if (!m) continue;
    out.push({ lang: m[1]!, path: relative(resolve(archive_root), join(dir_abs, f)), format: 'srt' });
  }
  out.sort((a, b) => a.lang.localeCompare(b.lang));
  return out;
}

export async function fetch_subtitles(args: SubtitleFetchArgs): Promise<SubtitleFetchResult> {
  if (_test_subtitles) return _test_subtitles(args);
  const out_tmpl = join(args.dir_abs, `${args.stem}.%(ext)s`);
  const cmd: string[] = [
    ytdlp_bin(),
    '-o', out_tmpl,
    '--skip-download', // NEVER re-download the video — captions only
    '--write-subs', '--write-auto-subs',
    '--sub-langs', args.langs,
    '--sub-format', 'srt/best',
    '--convert-subs', 'srt',
    '--no-playlist', '--no-warnings',
    args.url,
  ];
  let res = await run(cmd, DOWNLOAD_TIMEOUT_MS);
  if (
    res.code !== 0 &&
    /\b403\b|forbidden|not a bot|sign in to confirm|blocked|cloudflare|captcha/i.test(res.stderr)
  ) {
    const imp = [cmd[0]!, '--impersonate', YTDLP_IMPERSONATE_TARGET, ...cmd.slice(1)];
    res = await run(imp, DOWNLOAD_TIMEOUT_MS);
  }
  if (res.code !== 0) {
    throw new Error(`subtitle fetch failed (exit ${res.code}): ${ytdlp_error_line(res.stderr)}`);
  }
  return { captions: scan_subtitle_tracks(args.dir_abs, args.stem, args.archive_root) };
}

/**
 * Download the media to its categorized folder + write the .info.json /
 * thumbnail sidecars, then return the FINAL file's measured facts. Throws on a
 * real failure (the runner's slice try/catch converts it to error_streak).
 */
export async function download_media(args: DownloadArgs): Promise<MediaDownloadResult> {
  if (_test_download) return _test_download(args);

  // Image galleries are a SET of files under a per-item directory — a different
  // shape from the single A/V container, so they get their own download path.
  if (args.source === 'gallery-dl') {
    return download_gallery(args);
  }

  const dir = dest_dir(args.archive_root, args.folder_segments);
  if (!dir) throw new Error(`unsafe folder segments: ${args.folder_segments.join('/')}`);
  mkdirSync(dir, { recursive: true });
  // `<title> [<id>]` — the item's NAME on disk, id retained so every artefact is
  // still resolvable BY ID (see `media_canonical_stem`). Safe inside yt-dlp's
  // %-format output template because the stem's sanitiser strips `%` — a literal
  // one here would be read as a field spec and the file would land unpredictably.
  const stem = media_canonical_stem(args.id, args.title);
  const out_tmpl = join(dir, `${stem}.%(ext)s`);

  // What we ASKED yt-dlp for, in the words the diagnosis needs. The audio branch
  // deliberately passes no `-f` (`-x` extracts from yt-dlp's own default pick),
  // so quoting `quality.format_selector` there would name a selector that was
  // never sent.
  const selector = args.quality.audio_only
    ? '-x --audio-format m4a (yt-dlp default pick, no -f)'
    : args.quality.format_selector;

  const cmd: string[] = args.quality.audio_only
    ? [
        ytdlp_bin(), '-o', out_tmpl, '-x', '--audio-format', 'm4a',
        '--write-info-json', '--write-thumbnail', '--no-playlist', '--no-warnings', args.url,
      ]
    : [
        ytdlp_bin(), '-o', out_tmpl,
        '-f', args.quality.format_selector, '--merge-output-format', 'mp4',
        // remux is cheap when the container just needs rewrapping; recode
        // re-encodes (>1080p VP9/AV1 → an AVPlayer-native codec) once at download.
        args.quality.needs_recode ? '--recode-video' : '--remux-video', 'mp4',
        '--write-info-json', '--write-thumbnail', '--no-playlist', '--no-warnings', args.url,
      ];

  const res = await run(cmd, DOWNLOAD_TIMEOUT_MS);
  if (res.code !== 0) {
    // Site-level block (403 / bot wall) → retry once with browser impersonation
    // (curl_cffi). Insert `--impersonate <target>` right after the binary.
    if (/\b403\b|forbidden|not a bot|sign in to confirm|blocked|cloudflare|captcha/i.test(res.stderr)) {
      const imp = [cmd[0]!, '--impersonate', YTDLP_IMPERSONATE_TARGET, ...cmd.slice(1)];
      const res2 = await run(imp, DOWNLOAD_TIMEOUT_MS);
      if (res2.code === 0) return locate_result(args, dir, stem);
      throw await download_error(args, res2, selector, ', impersonate');
    }
    throw await download_error(args, res, selector);
  }
  return locate_result(args, dir, stem);
}

/**
 * Find the produced media file + sidecars in `dir` and read the measured facts.
 *
 * Ownership is decided by `media_entry_belongs_to`, the SAME id-recogniser the
 * repair sweep's `item_entries` uses — not by a `<id>.` prefix test. It has to be:
 * a taxonomy directory legitimately holds several items (that is what grouping
 * means), so "which of these files are mine" is a real question, and with the stem
 * now `<title> [<id>]` the id is no longer at the front. One recogniser, so the
 * writer and the migration can never disagree about which files an item owns.
 */
function locate_result(args: DownloadArgs, dir: string, stem: string): MediaDownloadResult {
  const mine = readdirSync(dir).filter((f) => media_entry_belongs_to(f, args.id));
  // The media file is a real playable CONTAINER — never the same-stem thumbnail
  // image (--write-thumbnail writes `<stem>.jpg/.webp` alongside `<stem>.mp4`; both
  // used to match the old MEDIA_EXTS predicate and readdir order decided which).
  const media_file = mine.find((f) => VIDEO_AUDIO_EXTS.has(ext_of(f)));
  if (!media_file) {
    throw new Error(`download produced no recognizable media container for ${args.id} in ${dir}`);
  }
  const media_abs = join(dir, media_file);
  const ext = ext_of(media_file);

  // Read the .info.json for measured metrics (verbatim — never authored).
  let info: Record<string, unknown> = {};
  const info_path = join(dir, `${stem}.info.json`);
  if (existsSync(info_path)) {
    try {
      info = JSON.parse(readFileSync(info_path, 'utf8')) as Record<string, unknown>;
    } catch {
      /* fall through with empty info */
    }
  }
  const thumb = mine.find((f) => THUMB_EXTS.has(ext_of(f)));

  let filesize: number | undefined;
  try {
    filesize = statSync(media_abs).size;
  } catch {
    filesize = num(info.filesize) ?? num(info.filesize_approx);
  }
  const height = num(info.height);
  return {
    nas_path: relative(resolve(args.archive_root), media_abs),
    container: ext,
    vcodec: str(info.vcodec),
    acodec: str(info.acodec),
    width: num(info.width),
    height,
    fps: num(info.fps),
    duration_s: num(info.duration),
    filesize,
    resolution_label: height ? `${height}p` : undefined,
    ...(thumb ? { thumbnail_path: relative(resolve(args.archive_root), join(dir, thumb)) } : {}),
  };
}

// ── image gallery (gallery-dl) ────────────────────────────────────────────────

/**
 * Download an image gallery via gallery-dl into a per-item DIRECTORY, then list
 * the images. `-D <dir>` forces gallery-dl's EXACT output location (overriding
 * its per-site subtree template), so every file lands flat in the item's folder;
 * `--range 1-<cap>` bounds a runaway booru tag page. The result's `nas_path` is
 * that DIRECTORY (relative to the archive root); each image is later addressed by
 * /api/media/image/:id/:idx → `<nas_path>/<images[idx].file>`. `thumbnail_path`
 * is the first image (the poster). gallery-dl can exit non-zero when SOME files
 * fail while others land, so "no images at all" — not the exit code — is the
 * real failure.
 */
async function download_gallery(args: DownloadArgs): Promise<MediaDownloadResult> {
  const base = dest_dir(args.archive_root, args.folder_segments);
  if (!base) throw new Error(`unsafe folder segments: ${args.folder_segments.join('/')}`);
  // The per-item directory carries the item's NAME for the same reason a media
  // file does — it is what a human sees browsing the archive — and the same
  // `<title> [<id>]` stem, so `media_entry_belongs_to` resolves it by id too.
  const gallery_dir = join(base, media_canonical_stem(args.id, args.title));
  mkdirSync(gallery_dir, { recursive: true });

  const res = await run(
    [gallerydl_bin(), '-D', gallery_dir, '--range', `1-${gallery_max()}`, args.url],
    DOWNLOAD_TIMEOUT_MS,
  );

  const files = readdirSync(gallery_dir)
    .filter((f) => IMAGE_EXTS.has(ext_of(f)))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  if (files.length === 0) {
    throw new Error(
      `gallery-dl produced no images for ${args.id} (exit ${res.code}): ${ytdlp_error_line(res.stderr)}`,
    );
  }
  const images = files.map((file, idx) => ({ idx, file }));
  const first = images[0]!;
  let filesize = 0;
  for (const f of files) {
    try {
      filesize += statSync(join(gallery_dir, f)).size;
    } catch {
      /* skip an unreadable file's size */
    }
  }
  return {
    nas_path: relative(resolve(args.archive_root), gallery_dir),
    container: 'gallery',
    image_count: images.length,
    images,
    thumbnail_path: relative(resolve(args.archive_root), join(gallery_dir, first.file)),
    ...(filesize > 0 ? { filesize } : {}),
  };
}

// ── keyframe sampling (for the video NSFW re-check) ───────────────────────────
let _test_keyframes: ((abs: string, n: number) => Promise<Uint8Array[]>) | null = null;
export function _test_set_keyframe_sampler(
  fn: ((abs: string, n: number) => Promise<Uint8Array[]>) | null,
): void {
  _test_keyframes = fn;
}

/**
 * Extract up to `n` JPEG keyframes at even marks across the video for the NSFW
 * classifier. `duration_s` is REQUIRED to seek (ffmpeg `-ss` takes a timestamp,
 * NOT a percentage — a `%` is rejected and yields nothing). Fail-soft: returns []
 * when duration is unknown or ffmpeg errors (the runner treats an empty set as
 * "couldn't verify" → owner-only, the fail-closed default). Each invocation uses
 * a UNIQUE temp path (concurrent jobs must not collide + cross-contaminate the
 * NSFW verdict) and cleans up after itself.
 */
export async function sample_keyframes(abs: string, n = 4, duration_s?: number): Promise<Uint8Array[]> {
  if (_test_keyframes) return _test_keyframes(abs, n);
  if (!existsSync(abs)) return [];
  if (!duration_s || !Number.isFinite(duration_s) || duration_s <= 0) return [];
  const out: Uint8Array[] = [];
  const token = randomUUID();
  // Sample at even fractional marks (avoid the very edges); seek to real seconds.
  for (let i = 0; i < n; i++) {
    const secs = (((i + 0.5) / n) * duration_s).toFixed(2);
    const tmp = join(tmpdir(), `hearth-nsfw-${token}-${i}.jpg`);
    try {
      const res = await run(
        [
          ffmpeg_bin(), '-hide_banner', '-loglevel', 'error', '-y',
          '-ss', secs, '-i', abs, '-frames:v', '1',
          '-vf', "scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease",
          tmp,
        ],
        60_000,
      );
      if (res.code === 0 && existsSync(tmp)) {
        out.push(new Uint8Array(readFileSync(tmp)));
      }
    } catch {
      /* skip this frame */
    } finally {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

// ── gallery image sampling (the NSFW read for image galleries) ────────────────
let _test_gallery_sampler: ((dir_abs: string, files: string[], n: number) => Promise<Uint8Array[]>) | null = null;
export function _test_set_gallery_sampler(
  fn: ((dir_abs: string, files: string[], n: number) => Promise<Uint8Array[]>) | null,
): void {
  _test_gallery_sampler = fn;
}

/**
 * Read up to `n` gallery image files (evenly spaced across the set) for the NSFW
 * classifier — the gallery analog of `sample_keyframes`. Sampling (not all-N)
 * bounds the cost on a large set while still catching an explicit image anywhere
 * in it. Fail-soft: skips an unreadable/oversized file and returns [] on total
 * failure (the runner treats an empty set as "couldn't verify" → owner-only).
 */
export async function sample_gallery_images(
  dir_abs: string,
  files: string[],
  n = 6,
): Promise<Uint8Array[]> {
  if (_test_gallery_sampler) return _test_gallery_sampler(dir_abs, files, n);
  const list = files.filter((f) => typeof f === 'string' && f.length > 0);
  if (list.length === 0) return [];
  const count = Math.min(n, list.length);
  const out: Uint8Array[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const pick = list[Math.min(list.length - 1, Math.floor(((i + 0.5) / count) * list.length))];
    if (!pick || seen.has(pick)) continue;
    seen.add(pick);
    try {
      const abs = join(dir_abs, pick);
      if (!existsSync(abs)) continue;
      const buf = readFileSync(abs);
      if (buf.byteLength > 0 && buf.byteLength <= 20 * 1024 * 1024) out.push(new Uint8Array(buf));
    } catch {
      /* skip this image */
    }
  }
  return out;
}
