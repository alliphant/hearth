/**
 * Media-archival category connector — the planner LLM judges category / genre /
 * creator from the probe metadata; the folder path is then DERIVED from that
 * judgment by `@core/media/taxonomy`.
 *
 * LAW #1: the MODEL decides from the REAL signals the extractor measured (title,
 * channel, description, tags, categories, duration, extractor). There is NO
 * hard-coded genre list, NO channel→artist table, NO `if (looks like X)` carve-out.
 * The creator/artist is pulled FROM METADATA ONLY (uploader / channel / title) —
 * NEVER a vision model, which fabricates identity (see the
 * `project-vl-camera-capability-envelope` memory).
 *
 * The MODEL DOES NOT AUTHOR THE PATH (2026-07-29). It used to: the prompt asked
 * for `folder_segments` with loose examples and no vocabulary, and separately
 * told the model to make the first segment `Private` for a non-SFW verdict —
 * which `apply_nsfw_cordon` does deterministically anyway. Both halves of that
 * were defects. Free-text segments grew `Videos` next to `Video`; the redundant
 * Private instruction made an obedient model surrender its KIND slot, so the next
 * value it emitted landed in the kind position and a SITE (`PornHub`) became a
 * top-level folder. The model now classifies and `media_folder_segments` derives
 * the path from the structured result + the measured probe — see the header of
 * `@core/media/taxonomy` for the full diagnosis.
 *
 * And the kind the path is derived FROM is the measurement-reconciled one:
 * `media_measured_kind` (@core/media/types) is the single producer of that rule,
 * applied ONCE here so the decision, the path, and the note all carry the same
 * value. This module used to own half the rule and `@connectors/media_note` the
 * other half, which is how an item could be filed under `Images/` while its own
 * note said `other` — see that function's header.
 *
 * The NSFW verdict is an INPUT here (judged upstream by the dedicated classifier
 * in `@connectors/nsfw`). This module only CONSEQUENCES it: a not-confirmed-safe
 * item is deterministically foldered under a private top-level segment (fail
 * CLOSED — a missed-NSFW-into-the-household is the unacceptable failure), and
 * `apply_nsfw_cordon` is now the ONLY producer of that prefix.
 *
 * Fail-open everywhere: any LLM / parse failure returns a deterministic default
 * derived from the probe — this leaf NEVER throws up the stack.
 */

import type { MediaProbeResult, CategoryDecision, MediaKind } from '@core/media/types';
import {
  MEDIA_KINDS,
  is_media_kind,
  media_measured_kind,
  type MediaGalleryEvidence,
} from '@core/media/types';
import {
  media_folder_segments,
  MEDIA_PRIVATE_SEGMENT,
  type MediaTaxonomyInput,
} from '@core/media/taxonomy';
import type { LLMRouter, LLMMessage } from '@core/llm';
import { nsfw_flag_for, type NsfwVerdict } from '@connectors/nsfw';

// ── local coercion helpers — never trust untyped JSON ────────────────────────

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const str = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
};

const strArr = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  return out.length > 0 ? out : undefined;
};

// ── the taxonomy seam ────────────────────────────────────────────────────────

/**
 * The MEASURED gallery evidence this phase can see. Pre-download, so the probe
 * is all there is — which is enough: `media_measured_kind`'s agreement proof
 * turns on `probe.source`, the one field the download cannot change.
 */
function probe_gallery_evidence(probe: MediaProbeResult): MediaGalleryEvidence {
  return {
    ...(probe.source !== undefined ? { source: probe.source } : {}),
    ...(probe.images !== undefined ? { images: probe.images } : {}),
    ...(num(probe.image_count) !== undefined ? { image_count: num(probe.image_count) } : {}),
  };
}

/**
 * The model's kind, reconciled with the measurement — applied ONCE, here, so
 * `CategoryDecision.media_kind` and the `folder_segments` derived from it are
 * the same value, and `build_media_note` re-applying the same shared rule at
 * filing time is a no-op rather than a second opinion (it was a second opinion:
 * see `media_measured_kind`'s header for the divergence this closes).
 */
function reconciled_kind(probe: MediaProbeResult, model_kind: string | undefined): MediaKind {
  return media_measured_kind(model_kind, probe_gallery_evidence(probe));
}

/**
 * The deriver's input, assembled from the model's structured judgment + the
 * MEASURED probe. One place, so the fallback path and the parsed path cannot
 * derive different trees.
 *
 * `probe.extra.album` is the only untyped field read: it is the one measured
 * album source (yt-dlp surfaces it for music tracks) and the Music shape's
 * second slot is literally `<Album-or-Title-or-Year>`, so ignoring it would put a
 * title or a year where a real album name exists. Coerced through `str`, so a
 * non-string is simply absent.
 *
 * `title` is the SAME resolved `title_clean` both callers below put on the
 * decision (and that `build_media_note` then writes as the note's `name`), which
 * is what makes the repair path — deriving from that note — land on byte-identical
 * segments AND a byte-identical filename stem. Passing anything else here (the
 * raw `probe.title`, say) would reintroduce a writer/migration disagreement, and
 * the migration would re-move the same files every sweep.
 */
function taxonomy_input(
  probe: MediaProbeResult,
  media_kind: MediaKind,
  creator: string | undefined,
  title: string | undefined,
): MediaTaxonomyInput {
  return {
    media_kind,
    ...(creator !== undefined ? { creator } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(str(probe.extractor) !== undefined ? { extractor: str(probe.extractor) } : {}),
    ...(str(probe.webpage_url) !== undefined ? { webpage_url: str(probe.webpage_url) } : {}),
    ...(str(probe.channel) !== undefined ? { channel: str(probe.channel) } : {}),
    ...(str(probe.uploader) !== undefined ? { uploader: str(probe.uploader) } : {}),
    ...(str(probe.upload_date) !== undefined ? { upload_date: str(probe.upload_date) } : {}),
    ...(str(probe.extra?.album) !== undefined ? { album: str(probe.extra?.album) } : {}),
  };
}

// ── prompts ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the archival cataloguer of a household media library. Given the \
metadata a downloader (yt-dlp / gallery-dl) probed off ONE media item, decide WHAT IT IS: its \
kind, genre, creator, a clean title, and its mood.

Respond with ONLY a JSON object of this EXACT shape — no prose, no code fence:

{
  "media_kind": "<one of: ${MEDIA_KINDS.join(' | ')}>",
  "genre": "<short genre, e.g. 'indie rock', 'documentary', 'stand-up' — omit if unknown>",
  "creator": "<the artist / channel / performer, FROM THE METADATA ONLY>",
  "title_clean": "<the human title with junk stripped (no ' (Official Video)', track numbers, etc.)>",
  "mood_tags": ["<0-4 short mood/vibe tags>"],
  "confidence": 0.0,
  "rationale": "<one sentence: what in the metadata drove the call>"
}

Rules:
- media_kind MUST be exactly one of the listed values. Use "other" when nothing fits. It is the
  most load-bearing field you return: the archive DERIVES the item's folder path from it, so a
  song labelled "clip" is filed as video.
- **creator comes FROM METADATA ONLY** — the uploader, channel, or a clearly-attributed name in
  the title. NEVER invent or guess a performer's name. If the metadata does not name a creator,
  omit "creator" rather than fabricate one.
- Set "confidence" honestly (0..1). Thin or ambiguous metadata → a LOW confidence.
- Do NOT return a folder path, and do NOT try to mark the item private — the archive decides
  where the file lands and enforces privacy itself, from your kind + creator and the measured
  metadata.
- Omit any string field you cannot fill from the metadata — do not emit an empty string or a
  placeholder.`;

/** The USER content: the probe fields that actually drive the judgment + the NSFW verdict + note. */
function build_user_content(
  probe: MediaProbeResult,
  nsfw: NsfwVerdict,
  user_note: string | undefined,
): string {
  const lines: string[] = [];
  lines.push('# Media item metadata (measured by the extractor probe — not authored by any model)');

  const title = str(probe.title);
  if (title) lines.push(`Title: ${title}`);

  const channel = str(probe.channel);
  const uploader = str(probe.uploader);
  if (channel) lines.push(`Channel: ${channel}`);
  if (uploader && uploader !== channel) lines.push(`Uploader: ${uploader}`);

  const extractor = str(probe.extractor);
  if (extractor) lines.push(`Source / extractor: ${extractor}`);

  const dur = num(probe.duration_s);
  if (dur !== undefined) lines.push(`Duration: ${Math.round(dur)}s`);

  if (probe.is_audio_only === true) {
    lines.push('Audio-only: yes (no video-bearing format present — likely music / podcast)');
  }

  const age = num(probe.age_limit);
  if (age !== undefined && age > 0) lines.push(`Age limit: ${age}`);

  const imgCount = num(probe.image_count);
  if (imgCount !== undefined) lines.push(`Image count: ${imgCount} (image gallery / photoset)`);

  const tags = strArr(probe.tags);
  if (tags) lines.push(`Tags: ${tags.slice(0, 30).join(', ')}`);

  const cats = strArr(probe.categories);
  if (cats) lines.push(`Categories: ${cats.join(', ')}`);

  const desc = str(probe.description);
  if (desc) {
    const truncated = desc.length > 1500 ? `${desc.slice(0, 1500)} …[truncated]` : desc;
    lines.push(`Description:\n${truncated}`);
  }

  lines.push('');
  // The verdict is CONTEXT for the classification (an explicit clip is rarely a
  // 'tutorial'), NOT an instruction about filing. The old prompt told the model
  // to make the first folder segment "Private" here; that duplicated
  // `apply_nsfw_cordon` and cost the model its kind slot. Never re-add it.
  lines.push(`# NSFW verdict (from the dedicated classifier, for context only): ${nsfw}`);

  const note = str(user_note);
  if (note) {
    lines.push('');
    lines.push(`# User note (highest-signal — why they saved it): ${note}`);
  }

  lines.push('');
  lines.push('Reply with ONLY the JSON object described in the system message.');
  return lines.join('\n');
}

// ── parsing + fallback ────────────────────────────────────────────────────────

/** Parse the planner's JSON reply into a CategoryDecision, narrowing every field. */
function parse_decision(content: string, probe: MediaProbeResult): CategoryDecision | null {
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let j: unknown;
  try {
    j = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (typeof j !== 'object' || j === null) return null;
  const o = j as Record<string, unknown>;

  const kind_raw = str(o.media_kind);
  // The model's label first (when it is in the vocabulary), else the coarse
  // audio-only read — then reconciled with the measurement by the ONE rule.
  const media_kind: MediaKind = reconciled_kind(
    probe,
    is_media_kind(kind_raw) ? kind_raw : probe.is_audio_only === true ? 'song' : 'other',
  );

  const genre = str(o.genre);
  // creator: model's metadata-derived pick, else fall back to channel/uploader (still metadata).
  const creator = str(o.creator) ?? str(probe.channel) ?? str(probe.uploader);
  const title_clean = str(o.title_clean) ?? str(probe.title);
  const mood_tags = strArr(o.mood_tags);
  const rationale = str(o.rationale);

  const conf_raw = num(o.confidence);
  const confidence = conf_raw !== undefined ? Math.max(0, Math.min(1, conf_raw)) : 0.5;

  // The path is DERIVED, never read from the reply. A model that emits
  // `folder_segments` anyway (an older prompt cached, a hallucinated field) is
  // ignored outright rather than normalised: a hint that can only ever be
  // rewritten into the canonical path adds a code path with no reachable effect,
  // and keeping the field alive invites the next author to trust it. Dropping it
  // makes "the archive's tree is the archive's own" unfalsifiable.
  const folder_segments = media_folder_segments(taxonomy_input(probe, media_kind, creator, title_clean));

  return {
    media_kind,
    folder_segments,
    confidence,
    ...(genre !== undefined ? { genre } : {}),
    ...(creator !== undefined ? { creator } : {}),
    ...(title_clean !== undefined ? { title_clean } : {}),
    ...(mood_tags !== undefined ? { mood_tags } : {}),
    ...(rationale !== undefined ? { rationale } : {}),
  };
}

/**
 * Fail-open default: deterministic, derived purely from the probe metadata.
 * Uses the SAME deriver as the parsed path, so an LLM outage files an item in a
 * canonical location (with a coarser kind) rather than into a parallel tree —
 * the old fallback had its own segment recipe (`'web'` / `'unknown'` sentinels),
 * which was a second taxonomy nobody was maintaining.
 */
function fallback_decision(probe: MediaProbeResult, reason: string): CategoryDecision {
  const audio = probe.is_audio_only === true;
  const creator = str(probe.channel) ?? str(probe.uploader);
  const title_clean = str(probe.title);
  const media_kind: MediaKind = reconciled_kind(probe, audio ? 'song' : 'other');
  return {
    media_kind,
    folder_segments: media_folder_segments(taxonomy_input(probe, media_kind, creator, title_clean)),
    confidence: 0.3,
    rationale: `fallback: ${reason}`,
    ...(creator !== undefined ? { creator } : {}),
    ...(title_clean !== undefined ? { title_clean } : {}),
  };
}

/**
 * Fold a not-confirmed-safe item under the private top segment, deterministically.
 * This is the STORAGE consequence of the upstream classifier's judgment, never a
 * substitute for it. `uncertain` and a missing verdict fail closed (owner-only).
 *
 * The trigger is `nsfw_flag_for`, the same function that sets the note's `nsfw`
 * frontmatter and the `media_archived` event's flag — one rule, so "filed under
 * Private/" and "flagged explicit" are the same JUDGMENT. This runs at classify
 * time off the pre-download thumbnail verdict (the download has to know where to
 * write), while the flag surfaces read the final discerned one — and when the
 * two disagree, the runner's filing phase folds the files across
 * (`apply_final_cordon`, @core/media/refile) before the note freezes any path,
 * so the shelf ends up agreeing with the flag in BOTH directions. The one
 * asymmetry: folding OUT of `Private/` requires a verdict with real provenance
 * (a review or scored frames); a fail-closed `uncertain` shelves in and stays
 * until something actually looks (the rescan facet's job).
 *
 * This is also the SOLE producer of the `Private/` prefix. It used to be described
 * as "belt-and-braces over the model prompt" — but the prompt was the problem, not
 * a second belt: an obedient model spent its kind slot on `Private` and shifted
 * every other value one position, which is how `Private/PornHub/MewSlut` came to
 * exist. The prompt instruction is gone, and so is the idempotence guard that
 * used to sit here.
 *
 * That guard tested whether slot 0 was already `Private`, justified as "a creator
 * or a site could be called that". For slot 0 that is FALSE: slot 0 is always a
 * member of the closed `MEDIA_TOP_LEVELS` vocabulary
 * (`Music | Audio | Video | Talks | Images | Other`), `Private` is not in it, and
 * a creator or site actually named "Private" lands in slot 1 or 2. The branch was
 * unreachable — and a dead branch carrying a false reason is an invitation to
 * "restore" the prompt instruction it appeared to be covering for.
 *
 * What actually makes a double prefix impossible is structural, and worth saying
 * plainly instead: this function has exactly ONE caller (`categorize_media`, once,
 * at the end), and the segments it receives are always freshly derived by
 * `media_folder_segments` — never a stored path that has already been cordoned.
 *
 * Who may SEE the item is not decided here or by the verdict at all — it is the
 * requester (@core/media/cordon).
 */
function apply_nsfw_cordon(decision: CategoryDecision, nsfw: NsfwVerdict): CategoryDecision {
  if (!nsfw_flag_for(nsfw)) return decision;
  return { ...decision, folder_segments: [MEDIA_PRIVATE_SEGMENT, ...decision.folder_segments] };
}

// ── entry point ────────────────────────────────────────────────────────────

export async function categorize_media(args: {
  probe: MediaProbeResult;
  nsfw: NsfwVerdict;
  user_note?: string;
  llm: LLMRouter;
}): Promise<CategoryDecision> {
  const { probe, nsfw, user_note, llm } = args;

  let base: CategoryDecision;
  try {
    const messages: LLMMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: build_user_content(probe, nsfw, user_note) },
    ];
    const role = llm.for_role('planner');
    const resp = await role.provider.complete({
      messages,
      temperature: 0.2,
      max_tokens: 500,
      ...role.defaults,
      think: false, // AFTER the spread — force think OFF even if the role defaults it on
    });
    base =
      parse_decision(resp.content, probe) ??
      fallback_decision(probe, `unparseable planner output: ${resp.content.slice(0, 160)}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    base = fallback_decision(probe, reason.length > 0 ? reason : 'planner error');
  }

  // Cordon is applied to BOTH the parsed and the fallback path — a fail-open
  // default for an NSFW item must still land private.
  return apply_nsfw_cordon(base, nsfw);
}
