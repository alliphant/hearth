/**
 * Shared types for the Media Archive pipeline (design-media-archival.md).
 *
 * The inter-module contracts: the normalized probe result (the DERIVED metric
 * source — every number here is copied verbatim from yt-dlp/gallery-dl, NEVER
 * authored by an LLM), the category decision (the planner model's judgment),
 * and the quality decision (deterministic format selection from the probe).
 *
 * LAW #1: metrics are measured (probe); category/genre/creator + NSFW are model
 * judgments over real signals; the download + file move are deterministic.
 */

export type MediaProbeSource = 'yt-dlp' | 'gallery-dl';

/**
 * What the item IS, as judged by the category model. Load-bearing: it is the
 * kind slot the folder path is DERIVED from — see `KIND_TO_TOP_LEVEL` in
 * `@core/media/taxonomy`, which is total over this union (add a kind here and
 * the compiler makes you place it).
 *
 * The model's label is not the last word: `media_measured_kind` below forces it
 * to agree with what the extractor MEASURED, and that reconciled value is what
 * both the path and the note carry.
 */
export type MediaKind =
  | 'music_video'
  | 'song'
  | 'album'
  | 'live_set'
  | 'talk'
  | 'interview'
  | 'lecture'
  | 'film'
  | 'episode'
  | 'trailer'
  | 'clip'
  | 'tutorial'
  | 'gameplay'
  | 'podcast'
  | 'image_gallery'
  | 'photoset'
  | 'other';

export const MEDIA_KINDS: readonly MediaKind[] = [
  'music_video', 'song', 'album', 'live_set', 'talk', 'interview', 'lecture',
  'film', 'episode', 'trailer', 'clip', 'tutorial', 'gameplay', 'podcast',
  'image_gallery', 'photoset', 'other',
] as const;

/** Is this string one of the kinds the archive knows? (narrows untyped input) */
export function is_media_kind(v: string | null | undefined): v is MediaKind {
  return typeof v === 'string' && (MEDIA_KINDS as readonly string[]).includes(v);
}

// ── the kind ⇄ measurement rule (ONE producer, two consumers) ────────────────

/**
 * The MEASURED evidence that an item is an image SET rather than a timed A/V
 * stream. Every field is optional and tolerantly typed because the two
 * consumers see the pipeline at different moments: the classify phase has only
 * the PROBE, the filing phase has the probe AND the actual DOWNLOAD result.
 *
 * ⚠ This interface is the ONLY place a new gallery signal may be added, and the
 * agreement proof in `media_measured_kind` is what a new field has to preserve.
 */
export interface MediaGalleryEvidence {
  /** the extractor family that produced it — `gallery-dl` only ever yields sets */
  source?: MediaProbeSource | string | null;
  /** the image list: the probe's (pre-download) or the download's (post-download) */
  images?: readonly unknown[] | null;
  /** the image count: the probe's (pre-download) or the download's (post-download) */
  image_count?: number | null;
}

/** Is this item MEASURABLY an image set? Never the model's label — LAW #1. */
export function media_is_gallery(evidence: MediaGalleryEvidence): boolean {
  if ((evidence.source ?? '') === 'gallery-dl') return true;
  if (Array.isArray(evidence.images) && evidence.images.length > 0) return true;
  const n = evidence.image_count;
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * The item's kind, FORCED to agree with the measurement — the ONE rule, shared
 * by everything that consequences a kind.
 *
 * Two consumers used to own half of it each, and the halves disagreed:
 * `taxonomy_input` (@connectors/media_category, classify time) only upgraded a
 * measured gallery to `image_gallery`, while `build_media_note`
 * (@connectors/media_note, filing time) ALSO stripped a spurious
 * `image_gallery`/`photoset` off a non-gallery down to `other`. So a planner
 * that called a YouTube video an `image_gallery` wrote the bytes into
 * `Images/YouTube/<Chan>` while the note recorded `media_kind: other` — and the
 * repair sweep then wanted `Other/YouTube/<Chan>`, reporting every freshly
 * archived item of that shape as off-schema forever while `Images/` filled with
 * video. Two producers of one filing rule is the defect the canonical taxonomy
 * exists to abolish; this is the one producer.
 *
 * Both directions matter. Upgrading keeps a mislabelled gallery out of `Music/`;
 * stripping keeps a real video out of `Images/` (and off the `/stream` guard's
 * 404 path, which branches on this field).
 *
 * ── why the two call sites provably agree ──────────────────────────────────
 * The path is still derived PRE-download (the runner needs a destination before
 * it can fetch) while the note is written POST-download, so agreement is a
 * property that has to be argued, not assumed. It holds because the only
 * evidence this rule reads reduces to ONE value on both sides:
 *
 *   • `probe.images` / `probe.image_count` are set by `normalize_gallerydl`
 *     alone, i.e. only when `probe.source === 'gallery-dl'`.
 *   • `download.images` / `download.image_count` are set by `download_gallery`
 *     alone, which `download_media` enters iff its `source` (= `probe.source`)
 *     is `'gallery-dl'`, and which throws when the set comes back empty.
 *
 * so `media_is_gallery(...)` ≡ `probe.source === 'gallery-dl'` at BOTH moments —
 * and `probe.source` is measured once, at probe time, and persisted on the job
 * row. The download cannot change it. The rule is also idempotent, so applying
 * it again at filing time over an already-reconciled kind is a no-op.
 *
 * That equivalence is exactly what a new field on `MediaGalleryEvidence` could
 * break: a signal only the DOWNLOAD can measure (say "the bytes that landed are
 * a single still") would make the pre-download path and the post-download note
 * disagree again, and the honest fix would then be to move the filing decision
 * after the download rather than to re-split this rule in two.
 */
export function media_measured_kind(
  model_kind: string | null | undefined,
  evidence: MediaGalleryEvidence,
): MediaKind {
  const raw = typeof model_kind === 'string' ? model_kind.trim() : '';
  if (media_is_gallery(evidence)) {
    // A set it is. Keep the model's finer read of WHICH kind of set.
    return raw === 'photoset' ? 'photoset' : 'image_gallery';
  }
  if (raw === 'image_gallery' || raw === 'photoset') return 'other'; // spurious set label
  return is_media_kind(raw) ? raw : 'other';
}

/** One selectable format from the probe's `formats[]` (yt-dlp shape). */
export interface MediaFormat {
  format_id: string;
  ext?: string;
  vcodec?: string; // 'avc1…' | 'vp9' | 'av01…' | 'none'
  acodec?: string; // 'mp4a…' | 'opus' | 'none'
  /**
   * yt-dlp's own computed ext pair, preserved DELIBERATELY: it survives when an
   * extractor leaves `vcodec`/`acodec` null (the generic / HTML5-embed case).
   * `audio_ext: 'none'` means "this format is not audio-only" — verified against
   * live yt-dlp, where even a muxed avc1+mp4a format reports audio_ext 'none' —
   * so it is positive evidence the format BEARS VIDEO. `video_ext: 'none'` is the
   * mirror image (a genuine audio-only format). See `derive_audio_only`.
   */
  audio_ext?: string;
  video_ext?: string;
  width?: number;
  height?: number;
  fps?: number;
  filesize?: number; // bytes (exact)
  filesize_approx?: number; // bytes (estimate)
  tbr?: number; // total bitrate kbps
}

export interface MediaChapter {
  start_s: number;
  end_s?: number;
  title: string;
}

/**
 * Where a chapter list came from. `official` = the extractor's own `chapters[]`
 * (YouTube's own chapter bar). The other two are DERIVED by Hearth when the
 * source ships none — parsed deterministically from text, NEVER authored by a
 * model (LAW #1) — and carry their evidence so a player can attribute them and
 * a reader can weigh them. A viewer-written setlist is corroborated by its
 * thumbs-up, which is exactly what `like_count` is for.
 */
export interface ChapterProvenance {
  from: 'official' | 'description' | 'comment';
  /** comment only — who wrote the index */
  author?: string;
  /** comment only — the thumbs-up corroborating it */
  like_count?: number;
  /** comment only — pinned by the uploader (strong corroboration) */
  pinned?: boolean;
  /** comment only — the uploader wrote it (their own list, posted as a comment) */
  by_uploader?: boolean;
  comment_id?: string;
}

export interface GalleryImage {
  idx: number;
  url?: string;
  ext?: string;
  width?: number;
  height?: number;
  extra?: Record<string, unknown>;
}

/**
 * Normalized probe result. Typed common core + `extra` passthrough of every
 * info-json field we did NOT explicitly type (the per-site metric schema is
 * driven by what the extractor returned, not a hard-coded per-site enum —
 * LAW #1). On failure `ok:false` + `error` + optional recovery `candidates`.
 */
export interface MediaProbeResult {
  source: MediaProbeSource;
  ok: boolean;
  error?: string;
  candidates?: Array<{ url?: string; why?: string }>;
  extractor?: string;
  id?: string;
  webpage_url?: string;
  title?: string;
  uploader?: string;
  uploader_id?: string;
  channel?: string;
  channel_id?: string;
  channel_url?: string;
  upload_date?: string; // raw yyyymmdd
  timestamp?: number; // epoch seconds
  duration_s?: number;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  age_limit?: number;
  availability?: string;
  language?: string;
  description?: string;
  tags?: string[];
  categories?: string[];
  chapters?: MediaChapter[];
  /** how `chapters` was obtained — absent when there are none */
  chapter_source?: ChapterProvenance;
  thumbnail?: string; // url
  formats?: MediaFormat[];
  /** derived: no video-bearing format present (music / podcast) */
  is_audio_only?: boolean;
  // gallery-dl shape
  image_count?: number;
  images?: GalleryImage[];
  /** every info-json field not typed above — verbatim, for the metric schema */
  extra: Record<string, unknown>;
}

/** The planner model's judgment over the probe (+ NSFW verdict). */
export interface CategoryDecision {
  media_kind: MediaKind;
  genre?: string;
  /** creator/artist — FROM METADATA ONLY, never a vision model (it fabricates identity) */
  creator?: string;
  title_clean?: string;
  mood_tags?: string[];
  /**
   * The taxonomy path under the archive root — DERIVED by
   * `media_folder_segments` (@core/media/taxonomy) from the fields above plus the
   * measured probe, then optionally `Private/`-prefixed by the NSFW cordon. The
   * model does NOT author it; see that module's header for why.
   */
  folder_segments: string[];
  confidence: number; // 0..1
  rationale?: string;
}

export type MediaContainer = 'mp4' | 'm4a';

/**
 * Deterministic quality decision derived from the probe's real `formats[]` +
 * the cap policy. AVPlayer-compat is paid at DOWNLOAD time: prefer H.264/AAC
 * MP4 ≤1080p (cheap remux); recode >1080p VP9/AV1 → HEVC MP4; audio → AAC M4A.
 */
export interface QualityDecision {
  /** yt-dlp -S/-f selection expression the download should apply */
  format_selector: string;
  target_height: number; // capped
  container: MediaContainer;
  /** true when the chosen source is VP9/AV1 >1080p → HEVC recode at download */
  needs_recode: boolean;
  audio_only: boolean;
  est_filesize_bytes?: number;
  /** the best rep exceeds the size cap → download the capped rep + file an ask */
  over_cap: boolean;
  reason: string;
}

/** What the download+recode step produced — the FINAL, actual media file. */
export interface MediaDownloadResult {
  /** media file path RELATIVE to the archive root, e.g. 'Video/YouTube/<Ch>/<t>.mp4' */
  nas_path: string;
  container: string; // 'mp4' | 'm4a' | …
  vcodec?: string;
  acodec?: string;
  width?: number;
  height?: number;
  fps?: number;
  duration_s?: number;
  filesize?: number; // bytes, actual
  resolution_label?: string; // e.g. '2160p'
  /** thumbnail/poster path relative to the archive root, if a sidecar landed */
  thumbnail_path?: string;
  /** image-gallery (gallery-dl): nas_path is then the item DIRECTORY, and each
   *  image is addressed by /api/media/image/:id/:idx → <nas_path>/<images[idx].file> */
  image_count?: number;
  images?: Array<{ idx: number; file: string; width?: number; height?: number }>;
}

/**
 * The VL content review's rating axis — three values, and the third is earned:
 * `safe` is only ever asserted after a model actually LOOKED (frames) or read
 * the item's own metadata and said so. `suggestive` is sexualized-not-explicit
 * (the thirst-trap band the sidecar's `sexy` class approximates); both it and
 * `explicit` map to the `nsfw` flag — the owner treats suggestive as private.
 */
export type MediaContentRating = 'explicit' | 'suggestive' | 'safe';

/**
 * Provenance of a real content review — the record that a MODEL DISCERNED this
 * item rather than a threshold defaulting. Persisted on the job's verdict
 * aggregate and (source/frames/at) on the note's frontmatter, where it is the
 * license for two things a bare verdict never grants: `never_classified` stops
 * targeting the item, and the taxonomy sweep may move a `safe` item OUT of
 * `Private/` (the un-private direction requires provenance, always).
 */
export interface MediaReview {
  rating: MediaContentRating;
  /** frames the VL returned a parseable rating for (0 for source 'metadata'). */
  frames_reviewed: number;
  /** 1-2 sentence content description for the note. Never names a person. */
  summary: string;
  /** 'vl' = frames were looked at; 'metadata' = judged from title/site/tags
   *  because the item has no visual artifact (a bare audio rip). */
  source: 'vl' | 'metadata';
  /** ISO instant. */
  at: string;
}

/** One subtitle/caption track fetched for an already-archived item (rescan). */
export interface SubtitleTrack {
  /** BCP-47-ish tag parsed from the yt-dlp filename ('en', 'en-US', 'es'). */
  lang: string;
  /** file path RELATIVE to the archive root, e.g. 'Video/YouTube/<Ch>/<id>.en.srt' */
  path: string;
  /** container format — always 'srt' (we --convert-subs srt). */
  format: string;
  /** auto-generated vs human — best-effort; usually unknown from the filename. */
  auto?: boolean;
}

/** Result of a subtitle rescan (yt-dlp --skip-download subtitle fetch). */
export interface SubtitleFetchResult {
  captions: SubtitleTrack[];
}
