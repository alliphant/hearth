/**
 * media_note — PURE builder of a media item's context `.md`.
 *
 * Two clearly-separated blocks, per LAW #1:
 *   1. the MEASURED block — every metric copied VERBATIM from the probe /
 *      download result (views, likes, duration, resolution, codec, upload date,
 *      tags, the per-site `extra` passthrough). NEVER authored by an LLM, never
 *      fabricated. A field that isn't present is simply omitted.
 *   2. the DERIVED-JUDGMENT block — the category model's read (kind / genre /
 *      creator / rationale), which is a judgment over those real signals.
 *
 * This module fabricates NO metric and NEVER throws — it's a leaf. Every probe
 * field is optional and defensively narrowed; on any internal error it returns
 * a minimal-but-valid note rather than propagating.
 */

import type {
  MediaProbeResult,
  CategoryDecision,
  MediaDownloadResult,
  MediaGalleryEvidence,
} from '@core/media/types';
import { media_is_gallery, media_measured_kind } from '@core/media/types';
import { MEDIA_UNTITLED_NAME } from '@core/media/taxonomy';
import { nsfw_flag_for, type NsfwAggregate } from '@connectors/nsfw';
import { ulid } from 'ulid';

// ── local coercion helpers (never trust untyped JSON) ───────────────────────

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 ? v : undefined;

const strArr = (v: unknown): string[] | undefined =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : undefined;

/** Round to `dp` decimals; undefined for non-finite input. */
function round(v: unknown, dp: number): number | undefined {
  const n = num(v);
  if (n === undefined) return undefined;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** yt-dlp `upload_date` (raw yyyymmdd) → ISO "YYYY-MM-DD"; undefined if not 8 digits. */
function ytdlp_date_to_iso(v: unknown): string | undefined {
  const s = str(v);
  if (!s || !/^\d{8}$/.test(s)) return undefined;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** seconds → "H:MM:SS" | "M:SS"; undefined for missing/negative. */
function fmt_duration(v: unknown): string | undefined {
  const n = num(v);
  if (n === undefined || n < 0) return undefined;
  const total = Math.floor(n);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (x: number): string => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** bytes → human string; undefined for missing/negative. */
function fmt_bytes(v: unknown): string | undefined {
  const n = num(v);
  if (n === undefined || n < 0) return undefined;
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = n / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x.toFixed(x >= 100 ? 0 : 1)} ${units[i] ?? 'B'}`;
}

/** Integers with thousands grouping (readability only; never a time value). */
function fmt_count(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

// ── the builder ─────────────────────────────────────────────────────────────

/**
 * Build the `media_item` note. Pure + defensive; the caller (runner) stamps
 * `private_to` — we deliberately do NOT, so the cordon stays owned by the one
 * place that resolves it.
 */
export function build_media_note(args: {
  probe: MediaProbeResult;
  category: CategoryDecision;
  nsfw: NsfwAggregate;
  download: MediaDownloadResult;
  source_site?: string;
  archived_at: string;
  tz?: string;
  /** stable id (from the runner) so the note id, download filename, and job agree */
  id?: string;
}): { id: string; frontmatter: Record<string, unknown>; body: string } {
  // ulid base32 is lowercase [a-z0-9]; last-8 satisfies /^mi_[a-z0-9]{6,}$/.
  const id = args.id ?? `mi_${ulid().toLowerCase().slice(-8)}`;

  try {
    const p = args.probe;
    const cat = args.category;
    const dl = args.download;

    // Resolved measured values (download = the ACTUAL file, probe = the source).
    const name = str(cat.title_clean) ?? str(p.title) ?? MEDIA_UNTITLED_NAME;
    const creator = str(cat.creator);
    const genre = str(cat.genre);
    const model_kind = typeof cat.media_kind === 'string' ? cat.media_kind : 'other';

    const width = num(dl.width);
    const height = num(dl.height);
    const fps = num(dl.fps);
    const vcodec = str(dl.vcodec);
    const acodec = str(dl.acodec);
    const container = str(dl.container);
    const filesize = num(dl.filesize);
    const resolution_label = str(dl.resolution_label);
    const duration_s = num(dl.duration_s) ?? num(p.duration_s);
    const nas_path = str(dl.nas_path);
    const thumbnail_path = str(dl.thumbnail_path);

    const view_count = num(p.view_count);
    const like_count = num(p.like_count);
    const language = str(p.language);
    const age_limit = num(p.age_limit);
    const published_at = ytdlp_date_to_iso(p.upload_date);
    const tags = strArr(p.tags) ?? [];
    const source_site = str(args.source_site) ?? str(p.extractor);
    const source_url = str(p.webpage_url);
    const archived_at = str(args.archived_at) ?? args.archived_at;

    // The flag derivation is `nsfw_flag_for` and NOWHERE else — the folder, this
    // frontmatter, the projected row, and the `media_archived` event all read that
    // one function so they cannot disagree about the same item.
    const is_nsfw = nsfw_flag_for(args.nsfw?.verdict); // fail-closed: missing verdict ⇒ nsfw
    const nsfw_score = round(args.nsfw?.score, 3);

    // Is this an image gallery? Decide from MEASURED signal only — the actual
    // downloaded files or the gallery-dl extractor source — NEVER the category
    // model's label (LAW #1). This phase sees the richest evidence there is (the
    // probe AND the files that actually landed), so it assembles the evidence and
    // hands it to the SHARED rule — `media_measured_kind` (@core/media/types),
    // the one producer, which the classify phase already applied to derive the
    // folder path. Owning half the rule here is what let a note say `other` about
    // an item filed under `Images/`; the rule is idempotent, so re-applying it
    // over the reconciled kind on the decision is a no-op that keeps this leaf
    // correct for any caller.
    const dl_images = Array.isArray(dl.images) ? dl.images : undefined;
    const gallery_evidence: MediaGalleryEvidence = {
      source: p.source,
      images: dl_images ?? (Array.isArray(p.images) ? p.images : undefined),
      image_count: num(dl.image_count) ?? num(p.image_count),
    };
    const is_gallery = media_is_gallery(gallery_evidence);
    const image_count = is_gallery
      ? (dl_images ? dl_images.length : undefined) ??
        num(dl.image_count) ??
        num(p.image_count) ??
        (Array.isArray(p.images) ? p.images.length : undefined)
      : undefined;
    const media_kind = media_measured_kind(model_kind, gallery_evidence);

    // ── frontmatter (typed columns) + `metrics` passthrough ──────────────────
    // Build with everything, then prune undefined so the note stays clean.
    const fm: Record<string, unknown> = {
      type: 'media_item',
      id,
      name,
      media_kind,
      source_site,
      source_url,
      creator,
      genre,
      nsfw: is_nsfw,
      nsfw_score,
      // The DISCERNED rating + its provenance, when a review actually ran.
      // `review` (source/frames/at, never the summary — that's body prose) is
      // the taxonomy sweep's license to move a safe item OUT of Private/;
      // without it the sweep can only ever tighten. See @core/media/types.
      content_rating: args.nsfw.review?.rating,
      review: args.nsfw.review
        ? {
            source: args.nsfw.review.source,
            frames_reviewed: args.nsfw.review.frames_reviewed,
            at: args.nsfw.review.at,
          }
        : undefined,
      duration_s,
      width,
      height,
      fps,
      vcodec,
      acodec,
      container,
      filesize,
      resolution_label,
      language,
      age_limit,
      view_count,
      like_count,
      published_at,
      archived_at,
      nas_path,
      thumbnail_path,
      // gallery: the per-image list + count ride the passthrough so the serve
      // route (/api/media/image/:id/:idx) + the web viewer can page the set.
      image_count: is_gallery ? image_count : undefined,
      images: dl_images,
      tags,
      // Chapters are a first-class frontmatter field (the item route prefers it
      // over the metrics passthrough) because they can be MINED from the
      // description or a top comment when the source ships none —
      // `chapter_source` records which, so a player can attribute a
      // viewer-written setlist rather than passing it off as official.
      chapters: p.chapters && p.chapters.length > 0 ? p.chapters : undefined,
      chapter_source: p.chapters && p.chapters.length > 0 ? p.chapter_source : undefined,
      quality_policy: undefined,
      // A shallow copy of the per-site passthrough — every present metric
      // survives, nothing is fabricated. Not a typed column (rides passthrough).
      metrics:
        p.extra && typeof p.extra === 'object' ? { ...(p.extra as Record<string, unknown>) } : {},
    };
    for (const k of Object.keys(fm)) {
      if (fm[k] === undefined) delete fm[k];
    }

    // ── body markdown ────────────────────────────────────────────────────────
    const kind_label = media_kind.replace(/_/g, ' ');
    const synth = (() => {
      const parts: string[] = [`"${name}"`];
      if (creator) parts.push(`by ${creator}`);
      const tail = genre ? `${kind_label}, ${genre}` : kind_label;
      return `${parts.join(' ')} — ${tail}.`;
    })();
    const summary = str(cat.rationale) ?? synth;

    const lines: string[] = [];
    lines.push('## Summary', '', summary, '');

    // What the reviewer actually SAW (scene/activity prose, identity-free by
    // the VL envelope) — indexed for search, so "find that beach clip" works
    // off the content, not just the uploader's title.
    const review_summary = str(args.nsfw.review?.summary);
    if (review_summary) {
      lines.push('## Content review', '', review_summary, '');
    }

    const description = str(p.description);
    if (description) {
      lines.push('## Description', '', description.trim(), '');
    }

    lines.push('## Metrics', '');
    if (is_gallery) {
      if (image_count !== undefined) lines.push(`- **Images:** ${fmt_count(image_count)}`);
      lines.push('- **Type:** image gallery (no video track)');
      if (source_site) lines.push(`- **Source:** ${source_site}`);
      if (published_at) lines.push(`- **Uploaded:** ${published_at}`);
      if (language) lines.push(`- **Language:** ${language}`);
      if (age_limit !== undefined) lines.push(`- **Age limit:** ${age_limit}`);
      if (tags.length > 0) lines.push(`- **Tags:** ${tags.join(', ')}`);
    } else {
      const rows: Array<[string, string]> = [];
      if (view_count !== undefined) rows.push(['Views', fmt_count(view_count)]);
      if (like_count !== undefined) rows.push(['Likes', fmt_count(like_count)]);
      const dur = fmt_duration(duration_s);
      if (dur) rows.push(['Duration', dur]);
      if (width !== undefined && height !== undefined) {
        rows.push([
          'Resolution',
          resolution_label ? `${width}×${height} (${resolution_label})` : `${width}×${height}`,
        ]);
      } else if (resolution_label) {
        rows.push(['Resolution', resolution_label]);
      }
      if (fps !== undefined) rows.push(['FPS', String(fps)]);
      if (vcodec || acodec) {
        const codecs = [vcodec, acodec].filter((x): x is string => !!x).join(' / ');
        if (codecs) rows.push(['Codec', codecs]);
      }
      if (container) rows.push(['Container', container]);
      const fb = fmt_bytes(filesize);
      if (fb) rows.push(['Filesize', fb]);
      if (published_at) rows.push(['Uploaded', published_at]);
      if (language) rows.push(['Language', language]);
      if (age_limit !== undefined) rows.push(['Age limit', String(age_limit)]);
      if (tags.length > 0) rows.push(['Tags', tags.join(', ')]);

      if (rows.length === 0) {
        lines.push('- _(no measured metrics available)_');
      } else {
        for (const [label, value] of rows) lines.push(`- **${label}:** ${value}`);
      }
    }
    lines.push('');

    return { id, frontmatter: fm, body: lines.join('\n') };
  } catch {
    // Leaf contract: never throw. Emit a minimal, schema-valid note.
    const safe_name =
      str(args.category?.title_clean) ?? str(args.probe?.title) ?? MEDIA_UNTITLED_NAME;
    const frontmatter: Record<string, unknown> = {
      type: 'media_item',
      id,
      name: safe_name,
      nsfw: nsfw_flag_for(args.nsfw?.verdict),
      tags: [],
    };
    const na = str(args.download?.nas_path);
    if (na) frontmatter.nas_path = na;
    const archived = str(args.archived_at);
    if (archived) frontmatter.archived_at = archived;
    return {
      id,
      frontmatter,
      body: `## Summary\n\n"${safe_name}".\n\n## Metrics\n\n- _(note assembly failed; metrics unavailable)_\n`,
    };
  }
}
