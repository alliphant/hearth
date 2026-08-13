/**
 * MediaArchiveRunner — the detached pipeline behind Kate's archive_url tool.
 *
 * Mirrors the research_investigation_runner: a resumable one-slice driver over a
 * media_archive_jobs row, a per-id serialization chain, and a fire-and-forget
 * detached kick. Each phase persists its output so a crash resumes from the last
 * committed phase; the whole phase body is one try/catch that bumps error_streak
 * and only fails the row at MAX_ERROR_STREAK.
 *
 *   pending      → PROBE (metadata) → classifying
 *   classifying  → NSFW pre-gate (thumbnail) + CATEGORIZE + QUALITY → downloading
 *   downloading  → DOWNLOAD + NSFW keyframe re-check → filing
 *   filing       → final-verdict Private/ fold + context .md + cordon-stamp +
 *                  upsert + index + report → done
 *
 * LAW #1: probe metrics are measured; category is the model's judgment; NSFW is a
 * dedicated classifier; the download + file are deterministic.
 *
 * Cordon (`private_to`): every item silos to its REQUESTER — see
 * @core/media/cordon, the single source of that rule. The final NSFW verdict no
 * longer picks the audience; it drives the storage folder (`Private/…`) and the
 * `nsfw` flag, and an unclassifiable item still fails closed to `uncertain`.
 * The folder now FOLLOWS the final verdict: the download lands where the
 * thumbnail pre-verdict pointed, and the filing phase folds the files under
 * `Private/` when the keyframes flipped the flag (`apply_final_cordon`) — the
 * flag and the shelf can no longer disagree on a fresh item.
 */
import { ulid } from 'ulid';
import { resolve } from 'node:path';
import type { LLMRouter } from '@core/llm';
import type { MemoryClient } from '@memory/client';
import type { Embedder } from '@core/embeddings';
import type { Database } from 'bun:sqlite';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';
import type { ToolDeps } from '@core/tool_deps';
import { local_iso_date } from '@core/time';
import {
  OPEN_MEDIA_JOB_STATUSES,
  push_media_log,
  type MediaJobStatus,
  type MediaJobRunState,
} from '@memory/stores/media_jobs';
import type {
  MediaProbeResult,
  CategoryDecision,
  QualityDecision,
  MediaDownloadResult,
} from '@core/media/types';
import { media_cordon_for } from '@core/media/cordon';
import { media_dir_of, media_is_private_path } from '@core/media/taxonomy';
import { apply_final_cordon, cordoned_segments } from '@core/media/refile';
import { probe_media } from '@connectors/media_probe';
import { categorize_media } from '@connectors/media_category';
import { decide_quality, default_quality_policy } from '@connectors/media_quality';
import { build_media_note } from '@connectors/media_note';
import {
  classify_image,
  aggregate_verdict,
  nsfw_flag_for,
  type NsfwAggregate,
  type NsfwClasses,
} from '@connectors/nsfw';
import { download_media, sample_keyframes, sample_gallery_images } from '@connectors/media_download';
import { judge_metadata, review_frames, verdict_for_rating, REVIEW_FRAME_COUNT } from '@connectors/media_review';
import { mine_chapters, chapter_credit } from '@connectors/media_chapter_mining';
import { index_chunks, embed_chunks_best_effort, type LibraryRoutesDeps } from '@app/routes/library';
import { push_text_to_user } from '@policy/push';
import { emit_job_progress, job_from_media_row } from '@core/jobs';

const MAX_ERROR_STREAK = 3;

function int_env(name: string, dflt: number, lo: number, hi: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.floor(n) : dflt;
}

const MAX_DETACHED_SLICES = int_env('HEARTH_MEDIA_MAX_SLICES', 10, 4, 40);
const KEYFRAME_COUNT = int_env('HEARTH_MEDIA_NSFW_FRAMES', 4, 1, 12);
/** Frames sampled per video — one set feeds BOTH readers (sidecar + VL review),
 *  so the wider of the two knobs wins. */
const FRAME_SAMPLE_COUNT = Math.max(KEYFRAME_COUNT, REVIEW_FRAME_COUNT);
// Upper bound on images NSFW-classified per gallery. Default 500 = the download
// cap (gallery_max), so EVERY downloaded image is checked — the cordon invariant
// ("any explicit image → owner-only") can't tolerate a sparse sample that skips
// the one explicit image. A pathological >500 set is capped here as a backstop.
const GALLERY_NSFW_MAX = int_env('HEARTH_MEDIA_GALLERY_NSFW_MAX', 500, 1, 5000);
const THUMB_FETCH_TIMEOUT_MS = int_env('HEARTH_MEDIA_THUMB_TIMEOUT_MS', 15000, 2000, 60000);

/** Default-ON kill switch (mirrors deep_research_enabled). */
export function media_archive_enabled(): boolean {
  return process.env.HEARTH_MEDIA_ARCHIVE !== '0';
}

export interface MediaArchiveRunnerDeps {
  memory: MemoryClient;
  llm: LLMRouter;
  db: Database;
  vault_root: string;
  archive_root: string;
  embedder?: Embedder;
  inbox?: SpecialistInbox;
  events?: AppEventBus;
}

/** Lift a MediaArchiveRunnerDeps off the standard ToolDeps bag (conditional-spread the optionals). */
export function media_archive_deps_from(deps: ToolDeps): MediaArchiveRunnerDeps {
  const archive_root = process.env.HEARTH_MEDIA_ARCHIVE_ROOT ?? './data/media-archive';
  return {
    memory: deps.memory,
    llm: deps.llm,
    db: deps.db,
    vault_root: deps.vault_root,
    archive_root,
    ...(deps.embedder !== undefined ? { embedder: deps.embedder } : {}),
    ...(deps.inbox !== undefined ? { inbox: deps.inbox } : {}),
    ...(deps.events !== undefined ? { events: deps.events } : {}),
  };
}

export interface AdvanceMediaResult {
  job_id: string;
  status: MediaJobStatus | 'missing';
  progressed: boolean;
  error?: string;
}

// ── NSFW helpers ─────────────────────────────────────────────────────────────

async function fetch_image_bytes(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(THUMB_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > 20 * 1024 * 1024) return null;
    return buf;
  } catch {
    return null;
  }
}

/**
 * Pre-download gate on the thumbnail.
 *
 * INVARIANT (the load-bearing one): any visual artifact this archive will SERVE
 * must be CLASSIFIED, and a `sfw` verdict may only ever be asserted from an
 * actual classifier result. Nothing in this pipeline gets to infer "safe" from
 * metadata — so `frames_scored: 0` always means "unclassified", which fails
 * closed to `uncertain` → owner-only.
 *
 * Which is exactly why this gate does NOT consult `audio_only`. That flag is a
 * DOWNLOAD hint derived from the extractor's format list (see
 * `derive_audio_only` in media_probe.ts); on a generic/HTML5-embed extractor it
 * read TRUE for a plain MP4 video, and the old `audio_only → sfw` early return
 * fabricated an affirmative safe verdict from zero evidence — labelling an
 * explicit clip household-visible (2026-07-15). If a thumbnail exists we
 * classify it, full stop. A genuine m4a simply has no thumbnail to gate on and
 * lands on `uncertain` (owner-only) — the honest answer for content nobody,
 * human or classifier, has looked at.
 */
async function nsfw_pregate(probe: MediaProbeResult): Promise<NsfwAggregate> {
  if (!probe.thumbnail) {
    return { verdict: 'uncertain', score: 0, frames_scored: 0, reason: 'no thumbnail to classify' };
  }
  const bytes = await fetch_image_bytes(probe.thumbnail);
  if (!bytes) return { verdict: 'uncertain', score: 0, frames_scored: 0, reason: 'thumbnail fetch failed' };
  const r = await classify_image(bytes);
  if (!r.available || !r.classes) {
    return { verdict: 'uncertain', score: 0, frames_scored: 0, reason: `nsfw sidecar: ${r.error ?? 'unavailable'}` };
  }
  return aggregate_verdict([r.classes]);
}

/**
 * Gather the visual evidence for one downloaded item, ONCE — both readers (the
 * sidecar's per-frame scoring and the VL content review) consume the same set,
 * so they can never disagree about which frames were looked at.
 *
 *  - video → frames sampled at even marks across the FULL duration
 *  - gallery → the downloaded images themselves (bounded by GALLERY_NSFW_MAX —
 *    one explicit image anywhere must cordon the set, so no sparse sampling)
 *  - audio with cover art → the cover image (the only visual there is)
 *  - audio with nothing → [] (the metadata judge is the reader of last resort)
 *
 * The `audio_only` skip is a work optimization, not a verdict: the audio
 * quality branch produced a real m4a with no video track, so there are
 * genuinely no frames for ffmpeg to sample.
 */
async function gather_frames(
  archive_root: string,
  probe: MediaProbeResult,
  download: MediaDownloadResult,
  audio_only: boolean,
  is_gallery: boolean,
): Promise<Uint8Array[]> {
  if (is_gallery) {
    const files = (download.images ?? []).map((im) => im.file);
    if (files.length === 0) return [];
    const dir_abs = resolve(archive_root, download.nas_path);
    return sample_gallery_images(dir_abs, files, Math.min(files.length, GALLERY_NSFW_MAX));
  }
  if (!audio_only) {
    const abs = resolve(archive_root, download.nas_path);
    return sample_keyframes(abs, FRAME_SAMPLE_COUNT, download.duration_s ?? probe.duration_s);
  }
  if (probe.thumbnail) {
    const cover = await fetch_image_bytes(probe.thumbnail);
    if (cover) return [cover];
  }
  return [];
}

/** Sidecar read over the gathered frames; no classifiable frame → keep `pre`
 *  (uncertain → fail-closed), never a verdict from zero evidence. */
async function classify_frames(frames: Uint8Array[], pre: NsfwAggregate): Promise<NsfwAggregate> {
  if (frames.length === 0) return pre;
  const classes: NsfwClasses[] = [];
  for (const f of frames) {
    const r = await classify_image(f);
    if (r.available && r.classes) classes.push(r.classes);
  }
  if (classes.length === 0) return pre;
  return aggregate_verdict(classes);
}

/**
 * Combine the thumbnail pre-gate with the frame post-check. NSFW from EITHER
 * wins (fail-closed on explicit content); otherwise the frame-based post is the
 * authoritative visual read when it actually scored frames; else fall back to the
 * pre-gate. So a thumbnail that couldn't be classified (uncertain) never forces
 * owner-only when the keyframes clearly read SFW — yet any explicit signal always
 * cordons, and a video that could NOT be frame-checked stays at the pre verdict
 * (uncertain → owner-only, the fail-closed default).
 */
function combine_nsfw(pre: NsfwAggregate, post: NsfwAggregate): NsfwAggregate {
  if (pre.verdict === 'nsfw') return pre;
  if (post.verdict === 'nsfw') return post;
  if (post.frames_scored > 0) return post;
  return pre;
}

/**
 * The DISCERNMENT step (owner directive 2026-08-10: *"I don't want things auto
 * private — I want classification and video review to discern contents"*): run
 * the VL content review over the gathered frames (or the metadata judge when
 * the item has no visual artifact) and let a real read REPLACE the sidecar's
 * threshold verdict — in both directions. The sidecar's score and verdict stay
 * on the aggregate (`score`, and named in `reason`) as the corroborating
 * signal; `review` carries the provenance that marks this verdict discerned.
 *
 * When no reviewer can look (VL down, judge down, nothing to read), the
 * sidecar verdict stands exactly as before — fail-closed `uncertain` included.
 * The review layer only ever ADDS discernment; it never fabricates one.
 */
async function discern_content(
  sidecar: NsfwAggregate,
  frames: Uint8Array[],
  probe: MediaProbeResult,
  llm: LLMRouter,
): Promise<NsfwAggregate> {
  const rv =
    frames.length > 0
      ? await review_frames(frames, llm)
      : await judge_metadata(
          {
            title: probe.title,
            uploader: probe.uploader ?? probe.channel,
            site: probe.extractor,
            url: probe.webpage_url,
            description: probe.description,
            tags: probe.tags,
          },
          llm,
        );
  if (!rv.available || !rv.review) return sidecar;
  const r = rv.review;
  return {
    verdict: verdict_for_rating(r.rating),
    score: sidecar.score,
    frames_scored: sidecar.frames_scored,
    reason:
      `${r.source}_review: ${r.rating} over ${r.frames_reviewed} frame(s); ` +
      `sidecar said ${sidecar.verdict} (${sidecar.reason})`,
    review: r,
  };
}

// ── the one-slice driver ─────────────────────────────────────────────────────

/**
 * Close out one slice: audit it, and emit the live `job_progress` patch that the
 * web dock / iOS ledger / in-chat job card render from ("On the Fire",
 * core/jobs.ts). Both are best-effort — a phase must never fail because nobody
 * was listening.
 *
 * The row is RE-READ rather than threaded in, deliberately: the phase's
 * `store.update` has already committed, so a fresh read is the authoritative
 * state (title from probe_json, folder from category_json, the log tail), and it
 * projects through the SAME mapper `GET /api/jobs` uses — so a phase label can
 * never disagree between the list and the live patch. Before this existed a
 * media job was invisible for its entire run and announced only once, terminally.
 */
function record_slice(
  deps: MediaArchiveRunnerDeps,
  agent: string,
  job_id: string,
  from_status: string,
  result: AdvanceMediaResult,
): void {
  try {
    deps.memory.log_action({
      intent_id: ulid(),
      agent,
      tool_name: 'media_archive_advance',
      tool_input: { job_id, from_status },
      execution_result: { status: result.status, progressed: result.progressed },
      ...(result.error ? { error: result.error } : {}),
    });
  } catch {
    /* audit is best-effort */
  }
  try {
    const fresh = deps.memory.media_jobs.get(job_id);
    if (fresh) emit_job_progress(deps.events, job_from_media_row(fresh));
  } catch {
    /* the live patch is best-effort too */
  }
}

/**
 * Advance one media job by ONE phase. Re-reads the row fresh, no-ops when
 * disabled or terminal, runs the phase behind an `if (status === X)` guard, and
 * wraps the whole body in one try/catch → error_streak (fail at MAX). The
 * detached loop calls this back-to-back for the next phase.
 */
export async function advance_media_job(
  deps: MediaArchiveRunnerDeps,
  job_id: string,
  agent = 'kate',
): Promise<AdvanceMediaResult> {
  const store = deps.memory.media_jobs;
  const row = store.get(job_id);
  if (!row) return { job_id, status: 'missing', progressed: false };
  if (!media_archive_enabled()) return { job_id, status: row.status, progressed: false };
  if (!OPEN_MEDIA_JOB_STATUSES.includes(row.status)) {
    return { job_id, status: row.status, progressed: false };
  }
  const from_status = row.status;
  const state: MediaJobRunState = { ...row.state };
  // error_streak counts CONSECUTIVE erroring slices: clear it when a phase
  // completes, re-accumulate in the catch from the incoming value.
  const incoming_streak = state.error_streak ?? 0;
  state.error_streak = 0;

  try {
    // ── PROBE ────────────────────────────────────────────────────────────────
    if (row.status === 'pending') {
      const probe = await probe_media(row.url);
      if (!probe.ok) {
        push_media_log(state, `probe failed: ${probe.error ?? 'unknown'}`);
        store.update(job_id, { probe, state, status: 'failed', error: `probe failed: ${probe.error ?? 'unknown'}` });
        const res: AdvanceMediaResult = { job_id, status: 'failed', progressed: true, error: probe.error ?? 'probe failed' };
        record_slice(deps, agent, job_id, from_status, res);
        return res;
      }
      push_media_log(state, `probed ${probe.extractor ?? probe.source}: ${probe.title ?? row.url}`);
      if (probe.chapters?.length) {
        probe.chapter_source = { from: 'official' };
      } else {
        // No chapter bar on the source — mine the description, then the top
        // comments (a viewer-written setlist, corroborated by its thumbs-up).
        // Fail-soft and never fatal: chapters are a bonus, not the job.
        const mined = await mine_chapters({
          url: row.url,
          ...(probe.duration_s !== undefined ? { duration_s: probe.duration_s } : {}),
          ...(probe.description !== undefined ? { description: probe.description } : {}),
        });
        if (mined) {
          probe.chapters = mined.chapters;
          probe.chapter_source = mined.provenance;
          push_media_log(state, `chapters: ${mined.chapters.length} mined from ${chapter_credit(mined.provenance)}`);
        }
      }
      store.update(job_id, { probe, state, status: 'classifying', error: null });
      const res: AdvanceMediaResult = { job_id, status: 'classifying', progressed: true };
      record_slice(deps, agent, job_id, from_status, res);
      return res;
    }

    // ── CLASSIFY (nsfw pre-gate + category + quality) ─────────────────────────
    if (row.status === 'classifying') {
      const probe = row.probe as MediaProbeResult;
      // DOWNLOAD/CATEGORY hint only — what to fetch and how to label it. It is
      // deliberately NOT passed to the NSFW pre-gate: classification is never
      // waived by a metadata guess (see nsfw_pregate's invariant).
      const audio_only = row.audio_only !== 0 || probe.is_audio_only === true;
      const media_id = row.media_item_id ?? `mi_${ulid().toLowerCase().slice(-8)}`;
      const nsfw_pre = await nsfw_pregate(probe);
      const category = await categorize_media({
        probe,
        nsfw: nsfw_pre.verdict,
        ...(row.user_note ? { user_note: row.user_note } : {}),
        llm: deps.llm,
      });
      const quality = decide_quality(probe, {
        ...default_quality_policy(),
        audio_only,
        ...(row.quality_override ? { quality_override: row.quality_override } : {}),
      });
      push_media_log(state, `categorized ${category.media_kind} (${category.folder_segments.join('/')}) · nsfw_pre=${nsfw_pre.verdict}`);
      store.update(job_id, {
        category,
        quality,
        nsfw: nsfw_pre,
        media_item_id: media_id,
        state,
        status: 'downloading',
        error: null,
      });
      const res: AdvanceMediaResult = { job_id, status: 'downloading', progressed: true };
      record_slice(deps, agent, job_id, from_status, res);
      return res;
    }

    // ── DOWNLOAD (+ nsfw keyframe re-check) ───────────────────────────────────
    if (row.status === 'downloading') {
      const probe = row.probe as MediaProbeResult;
      const category = row.category as CategoryDecision;
      const quality = row.quality as QualityDecision;
      const nsfw_pre = (row.nsfw as NsfwAggregate | null) ?? { verdict: 'uncertain', score: 0, frames_scored: 0, reason: 'no pre-verdict' };
      const media_id = row.media_item_id ?? `mi_${ulid().toLowerCase().slice(-8)}`;
      const download = await download_media({
        url: row.url,
        source: probe.source,
        quality,
        folder_segments: category.folder_segments,
        archive_root: deps.archive_root,
        id: media_id,
        // The item's NAME goes on the FILE, not just in the DB (owner, 2026-07-29).
        // Same `title_clean` the folder's album slot and the note's `name` read, so
        // the folder, the filename and the note cannot disagree about it.
        ...(category.title_clean !== undefined ? { title: category.title_clean } : {}),
      });
      // One gathered frame set feeds BOTH readers: the sidecar threshold and the
      // VL content review. The review — a model that actually looked (or, for a
      // no-visual item, honestly read the metadata) — REPLACES the threshold
      // verdict in either direction; with no reviewer reachable the sidecar
      // verdict stands, fail-closed `uncertain` included.
      const is_gallery = probe.source === 'gallery-dl';
      const frames = await gather_frames(
        deps.archive_root,
        probe,
        download,
        quality.audio_only,
        is_gallery,
      );
      const nsfw_post = await classify_frames(frames, nsfw_pre);
      const nsfw_sidecar = combine_nsfw(nsfw_pre, nsfw_post);
      const nsfw_final = await discern_content(nsfw_sidecar, frames, probe, deps.llm);
      // Persist the note_path NOW (stable media_id + today's date, computed once)
      // so a cross-day filing resume reuses it instead of writing a second note.
      const note_path = `MediaArchive/${local_iso_date(new Date())}-${media_id}.md`;
      push_media_log(state, `downloaded ${download.nas_path} (${download.container}) · nsfw_final=${nsfw_final.verdict}`);
      store.update(job_id, { download, nsfw: nsfw_final, media_item_id: media_id, note_path, state, status: 'filing', error: null });
      const res: AdvanceMediaResult = { job_id, status: 'filing', progressed: true };
      record_slice(deps, agent, job_id, from_status, res);
      return res;
    }

    // ── FILE (context .md + cordon + upsert + index + report) ─────────────────
    if (row.status === 'filing') {
      const probe = row.probe as MediaProbeResult;
      let category = row.category as CategoryDecision;
      let download = row.download as MediaDownloadResult;
      const nsfw_final = (row.nsfw as NsfwAggregate | null) ?? { verdict: 'uncertain', score: 0, frames_scored: 0, reason: 'no verdict' };
      const media_id = row.media_item_id ?? `mi_${ulid().toLowerCase().slice(-8)}`;

      // The `nsfw` FLAG — one derivation (`nsfw_flag_for`) over the FINAL verdict,
      // shared with the note's frontmatter and the row the ingestor projects from
      // it, so those three agree about this item. The retired `force_owner_only` job
      // flag used to be OR-ed in here and NOWHERE else, which is precisely how the
      // event could claim `nsfw: true` over a note and row that said `false`.
      const is_nsfw = nsfw_flag_for(nsfw_final.verdict);

      // Folder ← FINAL verdict, in EITHER direction. The download wrote into
      // the folder the pre-download thumbnail verdict chose (it had to — the
      // download must know where to write); when the discerned verdict lands on
      // the other side, fold the files across NOW, before the note freezes any
      // path, so the note, the row and the shelf agree from the item's first
      // appearance. The un-private direction is licensed only by a REAL read —
      // a review, or a sidecar verdict that scored actual frames; an absent/
      // fail-closed verdict can shelve INTO Private/, never out of it (owner
      // directive 2026-08-10: no auto-private — but unlooked-at is not "safe").
      const discerned = nsfw_final.review != null || nsfw_final.frames_scored > 0;
      if (
        media_is_private_path(download.nas_path) !== is_nsfw &&
        (is_nsfw || discerned)
      ) {
        const folded = apply_final_cordon({
          archive_root: deps.archive_root,
          id: media_id,
          title: category.title_clean ?? null,
          download,
          is_nsfw,
        });
        if (folded.aligned) {
          download = folded.download;
          category = {
            ...category,
            folder_segments: cordoned_segments(category.folder_segments, is_nsfw),
          };
          push_media_log(
            state,
            `final verdict ${nsfw_final.verdict} → re-shelved ${folded.moved} file(s) into ${media_dir_of(download.nas_path)}`,
          );
          // Persist BEFORE the note write: a crash after this line resumes with
          // the moved paths; a crash before it resumes via the adopt path
          // (source gone, target present → paths rewritten, zero moves).
          store.update(job_id, { download, category, state });
        } else {
          // Files weren't where the job said (nothing at source or target) — the
          // flag still speaks for itself and the taxonomy sweep repairs the shelf
          // later; failing the whole job here would strand a finished download
          // over a folder label.
          push_media_log(state, `final verdict ${nsfw_final.verdict} but found nothing to re-shelve — taxonomy sweep will finish it`);
        }
      }

      const note = build_media_note({
        probe,
        category,
        nsfw: nsfw_final,
        download,
        ...(probe.extractor ? { source_site: probe.extractor } : {}),
        archived_at: new Date().toISOString(),
        id: media_id,
      });

      // Cordon (the load-bearing layer): every item silos to its requester.
      // The rule and the reasoning live in ONE place — @core/media/cordon —
      // because the remediation sweep (rescan_media_metadata facet:'nsfw') has
      // to enforce the same policy this phase writes. The owner has NO god-view
      // of a member's item.
      const private_to = media_cordon_for(row.requested_by);
      note.frontmatter.private_to = private_to;

      // Reuse the note_path persisted at the download phase (stable across a
      // cross-day resume); only synthesize if a legacy row lacks it.
      const note_path = row.note_path ?? `MediaArchive/${local_iso_date(new Date())}-${media_id}.md`;
      deps.memory.upsert_note(note_path, note.frontmatter, note.body);

      // Make it searchable NOW (the ingestor projects the media_items row async;
      // the frontmatter private_to cordons the chunks via _chunk_gates).
      try {
        const chunks = index_chunks(deps.db, note_path, note.body);
        const lib_deps = {
          db: deps.db,
          vault_root: deps.vault_root,
          memory: deps.memory,
          ...(deps.embedder ? { embedder: deps.embedder } : {}),
          ...(deps.events ? { events: deps.events } : {}),
        } as LibraryRoutesDeps;
        await embed_chunks_best_effort(lib_deps, note_path, chunks);
      } catch (err) {
        push_media_log(state, `index failed (non-fatal): ${(err as Error).message}`);
      }

      store.update(job_id, { note_path, media_item_id: media_id, state, status: 'done', error: null });
      report_back(deps, {
        media_id,
        note_path,
        name: typeof note.frontmatter.name === 'string' ? note.frontmatter.name : row.url,
        folder: category.folder_segments.join(' / '),
        nsfw: is_nsfw,
        private_to,
        requested_by: row.requested_by,
        requested_at: row.created_at,
      });
      const res: AdvanceMediaResult = { job_id, status: 'done', progressed: true };
      record_slice(deps, agent, job_id, from_status, res);
      return res;
    }

    return { job_id, status: row.status, progressed: false };
  } catch (err) {
    const streak = incoming_streak + 1;
    state.error_streak = streak;
    push_media_log(state, `error in ${from_status}: ${(err as Error).message}`);
    if (streak >= MAX_ERROR_STREAK) {
      store.update(job_id, { state, status: 'failed', error: `${from_status} failed ×${streak}: ${(err as Error).message}` });
      const res: AdvanceMediaResult = { job_id, status: 'failed', progressed: true, error: (err as Error).message };
      record_slice(deps, agent, job_id, from_status, res);
      return res;
    }
    store.update(job_id, { state, error: (err as Error).message });
    const res: AdvanceMediaResult = { job_id, status: from_status, progressed: false, error: (err as Error).message };
    record_slice(deps, agent, job_id, from_status, res);
    return res;
  }
}

// ── report-back (all guarded + fail-open) ────────────────────────────────────

/**
 * The notification body for a finished archive.
 *
 * A push renders on the LOCK SCREEN, where anyone standing near the phone can
 * read it — so a CORDONED item's title never goes in the body. Stamping an item
 * owner-only is pointless if its name is printed on the outside of the device;
 * on 2026-07-30 a push read `Archived "Stepsister gets a hardcore throatfuck
 * PT 2"` in full. The title is still one tap away, behind the app's own auth.
 *
 * `owner_only` is the SAME flag that drove the cordon at filing time, so the
 * two decisions cannot drift apart. Pure + exported so the smoke can drive it.
 */
export function archive_push_body(name: string, owner_only: boolean): string {
  return owner_only
    ? "I archived the video you asked for, it's in your library."
    : `Archived "${name}" — it's in your library.`;
}


function report_back(
  deps: MediaArchiveRunnerDeps,
  info: {
    media_id: string;
    note_path: string;
    name: string;
    folder: string;
    /** The explicit flag — `nsfw_flag_for(final verdict)`, the same value the note
     *  and the projected row carry. It is NOT an audience: see `private_to`. */
    nsfw: boolean;
    private_to: string;
    requested_by: string | null;
    /** When the user asked (the job row's created_at) — the awaited freshness clock. */
    requested_at: string;
  },
): void {
  if (deps.inbox) {
    try {
      const mid = deps.inbox.push({
        from_specialist_id: 'kate',
        to_specialist_id: 'kate',
        kind: 'fyi',
        // "(explicit)", not "(private)": EVERY item is private to its requester
        // now, so a privacy marker on some of them would read as a claim that the
        // others are shared. The flag marks the explicit ones.
        body_md: `Archived **${info.name}** → ${info.folder}${info.nsfw ? ' _(explicit)_' : ''}.`,
        // Route the FYI to the requester (a real user_id, or NULL = household-
        // shared) — NOT private_to, which may be the tier keyword 'household'/
        // 'owner' and would match no per-user inbox read.
        originating_user_id: info.requested_by,
      });
      deps.events?.emit({
        type: 'inbox_message_added',
        message_id: mid,
        from_specialist_id: 'kate',
        to_specialist_id: 'kate',
        kind: 'fyi',
        severity: 'low',
      });
    } catch {
      /* fail-open */
    }
  }
  if (info.requested_by) {
    // AWAITED (2026-07-29): the user asked for this download and Kate promised to
    // report back, so this notice is the second half of THEIR turn — it must not
    // be deferred by the read-the-room gate. Without this flag, job
    // ma_qqwrhh1a4gcg's 17-second completion was queued to 05:59:59Z the next
    // morning for `in_meeting` while the owner sat in the thread asking whether
    // she was going to say anything. Quiet hours still holds it once the request
    // has gone cold (see delivery_window.ts `is_awaited_bypass`), which is what
    // `awaited_age_ms` is for — a long dive that lands at 02:00 waits for morning.
    const age_ms = Math.max(0, Date.now() - new Date(info.requested_at).getTime());
    void push_text_to_user(
      info.requested_by,
      archive_push_body(info.name, info.nsfw),
      {
        kind: 'ad_hoc',
        severity: 'medium',
        originating_specialist_id: 'kate',
        is_awaited: true,
        awaited_age_ms: age_ms,
      },
    ).catch(() => {
      /* a push miss auto-queues */
    });
  }
  deps.events?.emit({
    type: 'media_archived',
    media_item_id: info.media_id,
    note_path: info.note_path,
    nsfw: info.nsfw,
    private_to: info.private_to,
    user_id: info.requested_by,
  });
}

// ── per-id serialization + detached kick ─────────────────────────────────────

const _chains = new Map<string, Promise<unknown>>();

/** Serialize advances per job id so two slices never interleave the same row's state. */
export function advance_media_job_chained(
  deps: MediaArchiveRunnerDeps,
  job_id: string,
  agent = 'kate',
): Promise<AdvanceMediaResult> {
  const prev = _chains.get(job_id) ?? Promise.resolve();
  const next = prev.then(
    () => advance_media_job(deps, job_id, agent),
    () => advance_media_job(deps, job_id, agent),
  );
  _chains.set(
    job_id,
    next.catch(() => undefined),
  );
  return next;
}

/** Fire-and-forget back-to-back slice loop (nothing awaits; errors land in logs). */
export function kick_media_archive_detached(
  deps: MediaArchiveRunnerDeps,
  job_id: string,
  agent = 'kate',
): void {
  void (async () => {
    try {
      for (let i = 0; i < MAX_DETACHED_SLICES; i++) {
        const res = await advance_media_job_chained(deps, job_id, agent);
        if (!OPEN_MEDIA_JOB_STATUSES.includes(res.status as MediaJobStatus)) break;
        // A retryable error (progressed:false WITH an error) keeps the loop going
        // so error_streak can reach MAX_ERROR_STREAK and fail the job; a true
        // no-op (no error) means nothing more to do this run → break.
        if (!res.progressed && !res.error) break;
      }
    } catch (err) {
      console.error(`[media-archive] detached run failed for ${job_id}:`, err);
    }
  })();
}

/**
 * Crash-recovery / liveness sweep: re-kick every OPEN job. Call at orchestrator
 * boot and on a periodic tick so a job stranded by a transient error or a mid-run
 * restart gets re-driven (the detached kick otherwise fires only at creation).
 */
export function sweep_media_archive_jobs(deps: MediaArchiveRunnerDeps, agent = 'kate'): void {
  if (!media_archive_enabled()) return;
  try {
    const jobs = deps.memory.media_jobs.list({ statuses: OPEN_MEDIA_JOB_STATUSES });
    for (const job of jobs) kick_media_archive_detached(deps, job.id, agent);
  } catch (err) {
    console.error('[media-archive] sweep failed:', err);
  }
}
