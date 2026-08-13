/**
 * NSFW classifier connector — the SFW/NSFW axis of the media-archival cordon.
 *
 * Talks to the dedicated MobileNetV2 sidecar (GantMan/nsfw_model, 5-class) at
 * `HEARTH_NSFW_URL`; spec + Dockerfile live at `ops/nsfw/`. Purpose-built and
 * fast (CPU, ~tens of ms/image), it is the pipeline's THRESHOLD tier: cheap
 * enough to gate every download and score every frame. The DISCERNMENT tier
 * above it is the VL content review (@connectors/media_review, 2026-08-10),
 * whose per-frame rating replaces this model's verdict when it actually ran —
 * in either direction. Neither tier names anyone (the artist/creator always
 * comes from metadata, never a vision model — see the
 * `project-vl-camera-capability-envelope` memory).
 *
 * Stub-aware like the OCR/VL connectors: if `HEARTH_NSFW_URL` is unset the
 * sidecar is `available:false` and the runner fails NSFW-classification CLOSED —
 * `uncertain`, which shelves the item under `Private/` and flags it `nsfw` rather
 * than presenting unlooked-at content as safe. (Who may SEE an item is a separate
 * axis the verdict no longer touches: its requester, see @core/media/cordon.)
 *
 * The sidecar returns the raw five classes; the SFW/NSFW/uncertain verdict +
 * thresholds live here (`aggregate_verdict`), so the sidecar stays a dumb, fast
 * classifier.
 */

import type { MediaReview } from '@core/media/types';

const NSFW_BASE_URL = (process.env.HEARTH_NSFW_URL ?? '').replace(/\/$/, '');
const NSFW_TIMEOUT_MS = Number(process.env.HEARTH_NSFW_TIMEOUT_MS ?? '15000');

/** Aggregation thresholds — tune from real data, never to rescue one item. */
const NSFW_HIGH = Number(process.env.HEARTH_NSFW_HIGH ?? '0.5');
const NSFW_LOW = Number(process.env.HEARTH_NSFW_LOW ?? '0.2');
/** `sexy` is suggestive-not-explicit, so it counts less toward the NSFW score. */
const NSFW_SEXY_WEIGHT = Number(process.env.HEARTH_NSFW_SEXY_WEIGHT ?? '0.35');
/**
 * Floor on the summed class probabilities. The five classes are a softmax and so
 * sum to ~1; an all-zeros (or near-zero) vector from five present, numeric keys
 * means a warmed-but-broken model, not a confidently-safe image. Deliberately
 * loose — a sanity floor, not a threshold to tune. It is the SECOND of the two
 * shape checks; `parse_classify_response` rejects key drift before this, because
 * a sum cannot see it (a half-renamed response still sums to ~1).
 */
const MIN_CLASS_SUM = 0.5;

/** The five raw classes GantMan's MobileNetV2 emits (probabilities, ~sum 1). */
export interface NsfwClasses {
  drawings: number;
  hentai: number;
  neutral: number;
  porn: number;
  sexy: number;
}

/** The five keys, as the wire must carry them. Drift here is refused, not coerced. */
const NSFW_CLASS_KEYS = ['drawings', 'hentai', 'neutral', 'porn', 'sexy'] as const;

export type NsfwVerdict = 'sfw' | 'nsfw' | 'uncertain';

export interface NsfwClassifyResult {
  available: boolean;
  classes?: NsfwClasses;
  error?: string;
}

export interface NsfwAggregate {
  verdict: NsfwVerdict;
  /** max over frames of (porn + hentai + w·sexy), 0..~1 */
  score: number;
  frames_scored: number;
  reason: string;
  /**
   * Present when a VL content review (or the metadata judge) produced this
   * verdict — see @core/media/types MediaReview. Its presence is what marks the
   * verdict DISCERNED rather than thresholded, which the remediation sweep's
   * never-classified test honors alongside `frames_scored`.
   */
  review?: MediaReview;
}

export function nsfw_available(): boolean {
  return NSFW_BASE_URL.length > 0;
}

/**
 * Turn a decoded sidecar response body into a classification, or refuse it.
 *
 * Pure + exported so the refusals are directly testable — the smoke's classifier
 * seam replaces `classify_image` wholesale, so a guard living inline in the fetch
 * path would have no reachable test at all.
 *
 * Two independent checks, in this order, and the ORDER is the point:
 *
 *  1. **Shape** — all five keys present and finite numbers. Anything else is
 *     refused BEFORE any coercion. The predecessor of this function clamped
 *     missing/renamed/non-numeric keys to `0` and then checked the SUM, which
 *     cannot see the drift that actually matters: rename `porn` → `porn_prob`
 *     while `neutral` keeps parsing and the vector is `{neutral: 0.97, porn: 0}`
 *     — sums to ~1, clears any floor, scores 0.0, and lands a CONFIDENT `sfw` on
 *     explicit content. Exactly the fail-open the guard was added to prevent.
 *     Only total collapse (all five zero) was ever caught, which is the least
 *     likely drift.
 *  2. **Sanity** — the surviving five sum to ~1 (`MIN_CLASS_SUM`), which catches
 *     a well-shaped but dead model.
 *
 * A refusal returns NO `classes`, which every caller reads as unclassified and
 * fails closed to owner-only. Values are clamped to [0,1] only AFTER the shape
 * check, so clamping can no longer hide anything.
 */
export function parse_classify_response(body: unknown): NsfwClassifyResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { available: false, error: 'nsfw_shape_drift: response body is not a JSON object' };
  }
  const raw = body as Record<string, unknown>;
  const bad = NSFW_CLASS_KEYS.filter((k) => {
    const v = raw[k];
    return typeof v !== 'number' || !Number.isFinite(v);
  });
  if (bad.length > 0) {
    return {
      available: false,
      error: `nsfw_shape_drift: ${bad.join(', ')} missing or not a finite number (got keys: ${Object.keys(raw).slice(0, 8).join(', ')})`,
    };
  }
  const clamp = (v: number): number => Math.max(0, Math.min(1, v));
  const classes: NsfwClasses = {
    drawings: clamp(raw.drawings as number),
    hentai: clamp(raw.hentai as number),
    neutral: clamp(raw.neutral as number),
    porn: clamp(raw.porn as number),
    sexy: clamp(raw.sexy as number),
  };
  const total = NSFW_CLASS_KEYS.reduce((s, k) => s + classes[k], 0);
  if (!(total >= MIN_CLASS_SUM)) {
    return {
      available: false,
      error: `nsfw_degenerate_output: class probabilities sum to ${total.toFixed(3)} (expected ~1)`,
    };
  }
  return { available: true, classes };
}

/**
 * Direct single-image classify. Fail-soft: never throws, and on ANY failure
 * (sidecar unconfigured, fetch/HTTP/parse error, shape drift, degenerate output)
 * returns `available: false` with NO `classes` — which every caller reads as
 * unclassified and fails closed. It never returns a fabricated class vector.
 *
 * `available` means exactly "we have a usable classification of these bytes", and
 * nothing else. It used to be `true` on fetch/HTTP/parse errors and `false` on
 * unconfigured/degenerate, which read as a claim about the sidecar's liveness
 * that no caller made — every call site is `if (!r.available || !r.classes)`, so
 * unifying it is behaviour-preserving and leaves one meaning to reason about.
 * Diagnosis lives in `error`, which names the layer that failed.
 */
export async function classify_image_direct(bytes: Uint8Array): Promise<NsfwClassifyResult> {
  if (!nsfw_available()) return { available: false, error: 'nsfw_unavailable' };
  // Copy into a fresh ArrayBuffer so the Blob ctor narrows cleanly under strict TS.
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  const form = new FormData();
  form.append('image', new Blob([buf], { type: 'application/octet-stream' }), 'frame');

  let res: Response;
  try {
    res = await fetch(`${NSFW_BASE_URL}/classify`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(NSFW_TIMEOUT_MS),
    });
  } catch (err) {
    return { available: false, error: `nsfw_fetch_failed: ${(err as Error).message}` };
  }
  if (!res.ok) return { available: false, error: `nsfw_http_${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return { available: false, error: `nsfw_parse_failed: ${(err as Error).message}` };
  }
  return parse_classify_response(body);
}

/**
 * The ONE derivation of the `nsfw` FLAG from a verdict.
 *
 * Anything not CONFIRMED `sfw` is flagged — `uncertain` and a missing verdict
 * both fail closed, because nothing in this pipeline may present unlooked-at
 * content as safe.
 *
 * It lives here, exported, because THREE surfaces carry the flag and they must
 * agree: the context note's `nsfw` frontmatter (media_note.ts), the `media_items`
 * row the ingestor projects from that frontmatter, and the `media_archived` event
 * the runner emits. All three read the SAME verdict — the final, post-keyframe one
 * — so one function over one verdict means they cannot drift. Each used to inline
 * its own `verdict !== 'sfw'`, and the runner's copy additionally OR-ed in the
 * retired `force_owner_only` job flag, so an item could ship an event saying
 * `nsfw: true` over a note and a row saying `false`.
 *
 * The STORAGE FOLDER is the fourth surface, one moment later: `apply_nsfw_cordon`
 * (media_category.ts) calls this function at CLASSIFY time off the pre-download
 * THUMBNAIL verdict — the download has to know where to write before a keyframe
 * exists — and when the FINAL verdict lands on the other side, the runner's
 * filing phase folds the files across (`apply_final_cordon`, @core/media/refile)
 * before the note freezes any path. Both directions, with one asymmetry: folding
 * INTO `Private/` needs only the flag, folding OUT needs a verdict with real
 * provenance (a review, or scored frames) — unlooked-at is never "safe". Items
 * filed before the fold existed are repaired by the taxonomy sweep, whose
 * canonical path derives the prefix from this same flag + the note's review
 * provenance (media/taxonomy.ts).
 *
 * Who may SEE an item is a different axis entirely and this is not it — that is
 * the requester, always (@core/media/cordon).
 */
export function nsfw_flag_for(verdict: NsfwVerdict | undefined): boolean {
  return verdict !== 'sfw';
}

/** Per-frame NSFW score: explicit (porn+hentai) + weighted suggestive (sexy). */
export function frame_score(c: NsfwClasses): number {
  return Math.min(1, c.porn + c.hentai + NSFW_SEXY_WEIGHT * c.sexy);
}

/**
 * Aggregate a video/gallery's sampled frames into one verdict.
 *
 * `frames` are the SUCCESSFULLY-classified frames only, so an empty array is
 * ALWAYS a classification failure → `uncertain` (fails closed to owner-only).
 * There is no "no visual content" case to distinguish: nothing in the pipeline
 * may assert `sfw` without a classifier result, so an item with no visual
 * artifact to score is `uncertain` too, never safe-by-default.
 */
export function aggregate_verdict(frames: NsfwClasses[]): NsfwAggregate {
  if (frames.length === 0) {
    return { verdict: 'uncertain', score: 0, frames_scored: 0, reason: 'no_frames_scored' };
  }
  const score = Math.max(...frames.map(frame_score));
  const verdict: NsfwVerdict = score >= NSFW_HIGH ? 'nsfw' : score <= NSFW_LOW ? 'sfw' : 'uncertain';
  return {
    verdict,
    score,
    frames_scored: frames.length,
    reason: `max_frame_score=${score.toFixed(3)} (high=${NSFW_HIGH} low=${NSFW_LOW})`,
  };
}

// ── test seam ──────────────────────────────────────────────────────────────
// Smokes inject a fake classifier so they run without the sidecar (no network).
let _test_transport: ((bytes: Uint8Array) => Promise<NsfwClassifyResult>) | null = null;
export function _test_set_nsfw_transport(
  fn: ((bytes: Uint8Array) => Promise<NsfwClassifyResult>) | null,
): void {
  _test_transport = fn;
}
export function nsfw_reachable(): boolean {
  return nsfw_available() || _test_transport !== null;
}
export async function classify_image(bytes: Uint8Array): Promise<NsfwClassifyResult> {
  if (_test_transport) return _test_transport(bytes);
  return classify_image_direct(bytes);
}
