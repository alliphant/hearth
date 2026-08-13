/**
 * VL content review — the DISCERNMENT layer of the media archive's NSFW axis
 * (owner directive 2026-08-10: *"I don't want things auto private. I want
 * classification and video review to discern contents"*).
 *
 * The MobileNetV2 sidecar (@connectors/nsfw) is a fast threshold: cheap enough
 * to gate every download, but its middle band (`uncertain`) used to fail
 * closed straight into `Private/` — which made the archive's shelf a record of
 * the classifier's confidence, not of the content. This connector is the model
 * that actually LOOKS: frames sampled across the whole video (or gallery, or a
 * cover image) go to the `vision` role (Qwen-VL, the same endpoint vl.ts
 * drives), each frame is rated `explicit | suggestive | safe` with a one-line
 * scene description, and the aggregate — worst frame wins — becomes the final
 * verdict with provenance (`MediaReview` on the job's aggregate and the note).
 *
 * ── the capability envelope is load-bearing (project-vl-camera-capability-envelope)
 * The VL is describe-not-recognize: trusted for scene/object/activity, and
 * NEVER asked who anyone is — it fabricates fine identities at high
 * confidence. The prompt forbids naming or identifying people and the summary
 * carries activities, not identities. The artist/creator always comes from
 * metadata (media_category), never from here.
 *
 * ── the no-visual case
 * A bare audio rip (no cover art) has nothing to look at, and used to be
 * auto-`uncertain` → `Private/` forever. `judge_metadata` gives it an honest
 * read instead: a planner-role call over the item's own title / uploader /
 * site / tags / description, conservative in the explicit direction (an adult
 * site or an explicit title is `nsfw` regardless of missing pixels; a plain
 * music rip is `safe`). Its provenance says `source: 'metadata'`, so the note
 * records that nobody looked at pixels — there were none to look at.
 *
 * Fail-soft throughout: VL unconfigured / down / unparseable → `available:
 * false`, and every caller keeps the sidecar verdict (fail-closed uncertain
 * where nothing could look). This connector never fabricates a rating.
 */
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import type { LLMRouter, LLMMessage } from '@core/llm';
import type { MediaContentRating, MediaReview } from '@core/media/types';
import type { NsfwVerdict } from '@connectors/nsfw';

/** Frames sampled for review — spread across the FULL duration. Env-tunable. */
export const REVIEW_FRAME_COUNT = Number(process.env.HEARTH_MEDIA_REVIEW_FRAMES ?? '8');

export interface MediaReviewResult {
  available: boolean;
  review?: MediaReview;
  error?: string;
}

/** The one rating → verdict mapping. Suggestive IS nsfw here — the owner
 *  shelves thirst-traps private; the distinction survives on `rating`. */
export function verdict_for_rating(rating: MediaContentRating): NsfwVerdict {
  return rating === 'safe' ? 'sfw' : 'nsfw';
}

const RATINGS: readonly MediaContentRating[] = ['explicit', 'suggestive', 'safe'];

const FRAME_SYSTEM_PROMPT = `You review a single frame from a media file being archived to a private home NAS, so the archive can be organized correctly. Rate the frame and describe it.

Ratings (choose exactly one):
- "explicit": nudity, sexual acts, or pornographic content.
- "suggestive": sexualized but not explicit — lingerie/underwear focus, sexualized posing or framing, strip-tease context.
- "safe": neither of the above.

Rules:
- NEVER identify, name, or guess the identity of any person. Describe activities and scenes, not identities.
- Describe what is actually visible; do not speculate beyond the frame.

Answer with STRICT JSON only, no prose: {"rating":"explicit|suggestive|safe","scene":"<one short sentence>"}`;

interface FrameRead {
  rating: MediaContentRating;
  scene: string;
}

/**
 * Tolerant parse of one model answer; null = unusable (skip it, never default).
 * Accepts `scene` (frame prompt) or `reason` (metadata prompt) as the text —
 * one parser for both callers, so a refusal is judged the same way everywhere.
 */
export function parse_frame_read(content: string): FrameRead | null {
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  const rating = rec.rating;
  if (typeof rating !== 'string' || !RATINGS.includes(rating as MediaContentRating)) return null;
  const text = typeof rec.scene === 'string' ? rec.scene : typeof rec.reason === 'string' ? rec.reason : '';
  return {
    rating: rating as MediaContentRating,
    scene: text.trim().slice(0, 200),
  };
}

/** Worst frame wins — one explicit frame anywhere rates the whole item. */
export function aggregate_ratings(reads: FrameRead[]): MediaContentRating {
  if (reads.some((r) => r.rating === 'explicit')) return 'explicit';
  if (reads.some((r) => r.rating === 'suggestive')) return 'suggestive';
  return 'safe';
}

/** Distinct scene lines → a compact summary for the note (identity-free). */
export function summarize_scenes(reads: FrameRead[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const r of reads) {
    const s = r.scene.replace(/\.\s*$/, '');
    const key = s.toLowerCase();
    if (s.length === 0 || seen.has(key)) continue;
    seen.add(key);
    parts.push(s);
    if (parts.length >= 4) break;
  }
  return parts.join('. ') + (parts.length > 0 ? '.' : '');
}

/**
 * Review sampled frames with the VL — one call per frame (the vision role is a
 * short-answer "glance" tier; a grid collage would shrink each frame below
 * what the rating needs). Frames the VL fails on are SKIPPED, not defaulted:
 * `frames_reviewed` counts only real reads, and zero real reads is
 * `available: false`, never a fabricated `safe`.
 */
export async function review_frames(
  frames: Uint8Array[],
  llm: LLMRouter,
): Promise<MediaReviewResult> {
  if (_test_review) return _test_review(frames);
  if (frames.length === 0) return { available: false, error: 'no frames to review' };
  const role = llm.for_role('vision');
  if (!role.provider.capabilities().supports_vision) {
    return { available: false, error: 'vision role has no vision capability' };
  }
  const token = randomUUID();
  const reads: FrameRead[] = [];
  for (let i = 0; i < frames.length; i++) {
    // The provider's vision attachment takes a PATH (it transcodes and inlines
    // as a data URL), so each frame touches disk for the duration of one call.
    const tmp = join(tmpdir(), `hearth-review-${token}-${i}.jpg`);
    try {
      const buf = frames[i]!;
      const copy = new Uint8Array(buf.length);
      copy.set(buf);
      writeFileSync(tmp, copy);
      const messages: LLMMessage[] = [
        { role: 'system', content: FRAME_SYSTEM_PROMPT },
        { role: 'user', content: `Frame ${i + 1} of ${frames.length}.` },
      ];
      const resp = await role.provider.complete({
        messages,
        temperature: 0.1,
        max_tokens: 200,
        ...role.defaults,
        think: false,
        vision: { image_path: tmp },
      });
      const read = parse_frame_read(resp.content);
      if (read) reads.push(read);
    } catch {
      // One failed frame must not sink the review — the aggregate says how many
      // frames actually got read.
    } finally {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  if (reads.length === 0) return { available: false, error: 'vl returned no usable frame reads' };
  return {
    available: true,
    review: {
      rating: aggregate_ratings(reads),
      frames_reviewed: reads.length,
      summary: summarize_scenes(reads),
      source: 'vl',
      at: new Date().toISOString(),
    },
  };
}

const METADATA_SYSTEM_PROMPT = `You judge whether a media item is sexual content, from its METADATA ONLY — there is no image or video to look at (it is an audio file with no cover art, or similar). This decides how a private home archive shelves the file.

Ratings (choose exactly one):
- "explicit": the source site is an adult site, or the title/description/tags plainly describe pornographic content.
- "suggestive": the metadata clearly signals sexualized-but-not-explicit content.
- "safe": an ordinary song, talk, podcast, mix, or video with nothing sexual in its metadata.

Be conservative in the explicit direction: any adult-site domain rates "explicit" whatever the title says. But an ordinary music or talk rip is "safe" — do not invent doubt the metadata doesn't contain.

Answer with STRICT JSON only: {"rating":"explicit|suggestive|safe","reason":"<one short sentence>"}`;

export interface MetadataJudgeInput {
  title?: string | null;
  uploader?: string | null;
  site?: string | null;
  url?: string | null;
  description?: string | null;
  tags?: string[] | null;
}

/**
 * The no-visual judge: an honest metadata read instead of an automatic
 * `uncertain → Private/`. Same fail-soft contract as `review_frames` — an
 * unavailable or unparseable judge returns `available: false` and the caller
 * keeps the fail-closed verdict.
 */
export async function judge_metadata(
  input: MetadataJudgeInput,
  llm: LLMRouter,
): Promise<MediaReviewResult> {
  if (_test_judge) return _test_judge(input);
  const lines = [
    input.title ? `title: ${input.title}` : null,
    input.uploader ? `uploader: ${input.uploader}` : null,
    input.site ? `site: ${input.site}` : null,
    input.url ? `url: ${input.url}` : null,
    (input.tags ?? []).length > 0 ? `tags: ${(input.tags ?? []).join(', ')}` : null,
    input.description ? `description: ${input.description.slice(0, 500)}` : null,
  ].filter((l): l is string => l !== null);
  if (lines.length === 0) return { available: false, error: 'no metadata to judge' };
  try {
    const role = llm.for_role('planner');
    const resp = await role.provider.complete({
      messages: [
        { role: 'system', content: METADATA_SYSTEM_PROMPT },
        { role: 'user', content: lines.join('\n') },
      ] as LLMMessage[],
      temperature: 0.1,
      max_tokens: 200,
      ...role.defaults,
      think: false,
    });
    const read = parse_frame_read(resp.content);
    if (!read) return { available: false, error: 'metadata judge returned no usable rating' };
    return {
      available: true,
      review: {
        rating: read.rating,
        frames_reviewed: 0,
        summary: read.scene,
        source: 'metadata',
        at: new Date().toISOString(),
      },
    };
  } catch (err) {
    return { available: false, error: `metadata judge failed: ${(err as Error).message}` };
  }
}

// ── test seams ───────────────────────────────────────────────────────────────
let _test_review: ((frames: Uint8Array[]) => Promise<MediaReviewResult>) | null = null;
export function _test_set_review_transport(
  fn: ((frames: Uint8Array[]) => Promise<MediaReviewResult>) | null,
): void {
  _test_review = fn;
}
let _test_judge: ((input: MetadataJudgeInput) => Promise<MediaReviewResult>) | null = null;
export function _test_set_metadata_judge_transport(
  fn: ((input: MetadataJudgeInput) => Promise<MediaReviewResult>) | null,
): void {
  _test_judge = fn;
}
