/**
 * rescan_media_metadata — Kate re-scans an already-archived item for missing
 * metadata and pulls it down. All-encompassing by design (the all-encompassing-
 * tools rule): captions/subtitles were the FIRST facet; further facets (re-pull
 * chapters, refresh a thumbnail, refresh view/like counts) extend it via named
 * slots on `facet`, never new sibling tools.
 *
 * facet:'captions' (default) — locate the item (by id or title, cordon-checked),
 * read its source_url, and run a LIGHTWEIGHT yt-dlp subtitle fetch
 * (--skip-download — the video already exists) that writes `<id>.<lang>.srt` next
 * to the media file and records the tracks on the item's frontmatter
 * (`captions: [{lang, path, …}]`). Idempotent (skips if captions are already
 * present unless refetch).
 *
 * facet:'nsfw' — the REMEDIATION sweep. It re-files an already-
 * archived item for any of three independent reasons (`needs_refile`):
 *   1. the classifier never actually ran (the archive job recorded
 *      `frames_scored: 0` and no review, which is the proof) — the 2026-07-15
 *      fail-open, where an `audio_only → sfw` early return fabricated a safe
 *      verdict from zero evidence and filed an explicit clip household-visible;
 *   2. the row is still household-scoped, i.e. off the 2026-07-29 requester-silo
 *      cordon (@core/media/cordon) that the runner's filing phase now writes; or
 *   3. the verdict is a fail-closed `uncertain` nobody has DISCERNED — the
 *      pre-2026-08-10 auto-private backlog.
 * Evidence comes off the ARCHIVE ITSELF, nothing re-downloaded: frames sampled
 * across the on-disk video (when the note's measured `vcodec` says there is a
 * video track), else the thumbnail, else the metadata judge. The sidecar scores
 * the frames and the VL CONTENT REVIEW (@connectors/media_review) discerns them —
 * a real review replaces the threshold verdict in either direction, with
 * provenance (`content_rating` + `review`) written to the note; no reviewer
 * reachable → the sidecar verdict stands, fail-closed included. The cordon
 * repair does not depend on any of that succeeding. With no `item`
 * it sweeps the rows the caller can see, a BOUNDED BATCH per run (`sweep_bounds` —
 * every item is a real classifier round trip in an in-turn tool) and reports the
 * remainder as `deferred`; with one `item` it does just that item.
 *
 * facet:'taxonomy' — the FILING MIGRATION. It re-files items whose on-disk path
 * is not the one `@core/media/taxonomy` derives for them — the archive the owner
 * reported on 2026-07-29, where `Private/` held `PornHub`, `Video` and `Videos`
 * side by side because the path used to be a model output. It MOVES and RENAMES:
 * the same owner report's second half — *"you're not trimming the important part
 * of the files right? The names???"* — made the filename part of the taxonomy
 * (`<title> [<id>]`), and a stored path is a directory plus a filename, so both
 * axes are one transaction rather than two passes that could half-run. DRY RUN BY
 * DEFAULT: it reports every planned before→after PATH (filename included) and
 * touches nothing until `apply: true`, because this is the one facet that moves
 * bytes on the NAS. Idempotent (a canonical item is skipped), prunes the
 * directories it empties, never overwrites an existing destination, and it can
 * never widen a cordon — the `Private/` prefix is tighten-only: an item's
 * CURRENT prefix is always carried forward, and an item whose stored `nsfw`
 * flag is set GAINS the prefix if the open tree still holds it (the write path
 * chose its folder from the pre-download thumbnail verdict; when the final
 * keyframe verdict flipped the flag, this sweep is what re-shelves the bytes —
 * see `media_canonical_path`).
 *
 * The two repair facets are ORTHOGONAL and neither subsumes the other: 'nsfw'
 * repairs WHO an item belongs to (`private_to`) and its verdict, writing only
 * frontmatter; 'taxonomy' repairs WHERE its bytes live, moving files. An item can
 * need one, the other, or both, so they stay separate slots rather than one
 * "repair everything" pass whose failures would be impossible to attribute.
 *
 * facet:'move' — the DIRECTED move (owner 2026-08-10: "can you allow me to talk
 * to Kate and ask her to move things elsewhere?"). One named item, one `to`
 * destination: the destination is pinned as the note's `placement` (which the
 * canonical-path derivation ranks above everything — see taxonomy.ts), then the
 * item re-files through the SAME machinery as 'taxonomy'. The pin is what makes
 * a hand-placed item stick: without it the next tidy sweep would "repair" the
 * move right back. `to:'auto'` un-pins. Applied immediately — one item, named,
 * with an explicit destination is the owner's word, not a sweep.
 *
 * All three facets are in-turn + fail-open, and cordon-gated exactly like the rest
 * of the archive: a member who can't see an item simply can't resolve it (the
 * 404-shape). facet:'nsfw' and facet:'taxonomy' additionally hard-gate the caller
 * tier to owner/household — a mass `private_to` mutation and a filesystem
 * migration across a whole visible set are not friend-tier work.
 *
 * Fail-open is STRUCTURAL for the taxonomy sweep, and load-bearing because it
 * moves bytes: every item goes through `refile_item_safe`, so one unreadable
 * note or one failed write cannot abort the pass, and the audit row is emitted
 * in a `finally`, so the record of what already moved survives an abnormal exit.
 * A partially-completed migration is always reportable and always idempotent —
 * a re-run finds the files at the target and finishes the frontmatter.
 */
import { z } from 'zod';
import { basename, dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { parse_private_to, type Caller } from '@memory/private_to';
import type { MediaItemRow } from '@memory/client';
import type { MediaJobRow } from '@memory/stores/media_jobs';
import type { SubtitleTrack, MediaChapter, ChapterProvenance } from '@core/media/types';
import {
  is_off_policy_media_cordon,
  tighten_media_cordon,
  MEDIA_CORDON_FALLBACK,
} from '@core/media/cordon';
import {
  item_entries,
  move_entry,
  prune_empty_dirs,
  repoint,
  safe_archive_abs,
  under,
} from '@core/media/refile';
import {
  is_off_schema,
  media_canonical_entry_name,
  media_canonical_path,
  media_dir_of,
  media_normalize_path,
  type MediaTaxonomyInput,
} from '@core/media/taxonomy';
import { require_caller_tier } from '@core/tool_gates';
import { fetch_subtitles, sample_keyframes } from '@connectors/media_download';
import {
  aggregate_verdict,
  classify_image,
  nsfw_flag_for,
  type NsfwAggregate,
  type NsfwClasses,
} from '@connectors/nsfw';
import {
  judge_metadata,
  review_frames,
  verdict_for_rating,
  REVIEW_FRAME_COUNT,
} from '@connectors/media_review';
import { mine_chapters, chapter_credit } from '@connectors/media_chapter_mining';
import { media_archive_enabled } from '../media_archive_runner';

const InputSchema = z.object({
  facet: z
    .enum(['captions', 'chapters', 'nsfw', 'taxonomy', 'move'])
    .optional()
    .default('captions')
    .describe(
      "Which metadata facet to re-scan. 'captions' (default) re-pulls subtitle tracks. " +
        "'chapters' recovers a chapter/setlist index for an item the source never chaptered, " +
        'by reading the video description and then the TOP COMMENTS — on a live set, DJ mix, ' +
        'full-album upload or long talk the tracklist very often exists only in a comment that ' +
        'a lot of viewers upvoted. Use it when Jasper asks what songs/tracks/sections are in an ' +
        'archived video, or why it has no chapters. Requires `item`. ' +
        "'nsfw' re-checks and re-files what may be filed wrong: it REVIEWS the actual content " +
        '— frames sampled across the archived video go to the vision model, which rates them ' +
        'explicit/suggestive/safe and describes what it saw (a bare audio rip is judged from ' +
        'its own metadata instead) — and re-files anything still shared with the household ' +
        'onto the person who asked for it. It targets items that were never really looked at: ' +
        'fabricated old verdicts, and the fail-closed "uncertain → private by default" backlog. ' +
        "Use it when Jasper asks you to re-check what got mislabelled, says something's rated " +
        'wrong, or asks you to audit the archive. A sweep does a BATCH per ' +
        'run (not the whole archive in one turn) and reports how many are left in ' +
        '`deferred` — tell him that number and offer to carry on. A changed verdict updates ' +
        "the flag and rating only; run facet:'taxonomy' after to move the files. " +
        "'taxonomy' is the other repair: it checks whether items are filed in the right " +
        'FOLDERS with filenames that carry their titles, and re-files/renames the ones that ' +
        'are not — including moving an explicit-flagged item into Private/ if it is still ' +
        'shelved in the open tree, and a reviewed-safe item back OUT of Private/ (only a ' +
        'real content review licenses un-privating; unreviewed items stay put or move in). ' +
        "Use it when Jasper complains about the archive's folder structure or file names, " +
        'says something is shelved on the wrong side of Private/, or asks you to audit the ' +
        'archive. It only REPORTS the changes unless you also pass ' +
        "apply:true. 'move' is the DIRECTED move: Jasper (or a household member, for their own " +
        'items) names an item and a destination folder — pass it as `to` — and the item moves ' +
        'there NOW and STAYS there: the placement is pinned on the item, so later tidy sweeps ' +
        "respect it instead of re-filing it back. `to:'auto'` un-pins and returns the item to " +
        'its derived home. Moving a flagged item out of Private/ is allowed — it is the ' +
        "owner's archive — but say plainly that it is explicit/suggestive-rated when you do " +
        'it. Who can SEE an item never changes on any move. ' +
        "Neither repair facet nor 'move' is for friend-tier callers.",
    ),
  to: z
    .string()
    .optional()
    .describe(
      "facet:'move' only — the destination FOLDER, archive-relative (e.g. 'Music/Concerts' " +
        "or 'Private/Video/Saved'), or 'auto' to un-pin and return the item to its derived " +
        'home. The filename is not yours to choose: it stays `<title> [<id>]`.',
    ),
  item: z
    .string()
    .optional()
    .describe(
      "Which archived item — its id ('mi_…') OR a title to match (e.g. 'the Linkin Park livestream'). " +
        'Resolved against what YOU can see, so a private item is only reachable by its owner. ' +
        "Required for facet:'captions'; optional for facet:'nsfw' and facet:'taxonomy', which " +
        'each sweep every item they can see when it is omitted.',
    ),
  langs: z
    .string()
    .optional()
    .describe(
      "facet:'captions' only. Subtitle languages to pull (yt-dlp --sub-langs). Default 'en.*' " +
        "(all English variants). e.g. 'en.*,es.*' for English + Spanish. Only widen when Jasper " +
        'asks — auto-captions get noisy.',
    ),
  refetch: z
    .boolean()
    .optional()
    .describe(
      "Re-do the work even if it's already on record. facet:'captions': re-pull the tracks. " +
        "facet:'nsfw': re-classify items that DID score frames too, not only the never-classified " +
        "ones. Ignored by facet:'taxonomy', which always skips an item already filed correctly. " +
        'Default false.',
    ),
  apply: z
    .boolean()
    .optional()
    .describe(
      "facet:'taxonomy' only. Actually MOVE and RENAME the files on disk. Default false = a " +
        'dry run that reports every before→after path (filenames included) and changes nothing. ' +
        'Show Jasper the dry run and get his go-ahead before you pass true — this moves bytes on ' +
        'the NAS.',
    ),
});

const TrackSchema = z.object({
  lang: z.string(),
  format: z.string(),
  auto: z.boolean().optional(),
});
/** One item the 'nsfw' facet re-classified (or tried to). */
const NsfwRescanSchema = z.object({
  item_id: z.string(),
  title: z.string(),
  verdict: z.enum(['sfw', 'nsfw', 'uncertain']),
  score: z.number(),
  frames_scored: z.number(),
  /** the DISCERNED rating when a review produced this verdict (VL frames or
   *  the metadata judge) — absent means the sidecar threshold spoke alone. */
  rating: z.enum(['explicit', 'suggestive', 'safe']).optional(),
  /** the cordon AFTER the rescan (tighten-only — see reclassify_item) */
  private_to: z.string(),
  cordon_tightened: z.boolean(),
  note: z.string().optional(),
});
/** One item the 'taxonomy' facet examined: where it is, where it belongs. */
const TaxonomyMoveSchema = z.object({
  item_id: z.string(),
  title: z.string(),
  /** the directory the item is filed in now (archive-relative) */
  from: z.string(),
  /** the directory the taxonomy derives for it (archive-relative) */
  to: z.string(),
  /**
   * The item's FULL stored path now, and the full path the taxonomy derives —
   * `from`/`to` plus the filename. Both carried because the filename is part of
   * the taxonomy since 2026-07-29 (`<title> [<id>]`), and a dry run the owner is
   * expected to approve has to show him the name a file will end up with, not
   * only the folder it lands in. Absent on an item that could not be planned at
   * all (no readable note).
   */
  from_path: z.string().optional(),
  to_path: z.string().optional(),
  /** the filename changes (not only the folder) — so Kate can say "renamed" */
  renamed: z.boolean().optional(),
  off_schema: z.boolean(),
  /** true only when files actually moved (never in a dry run) */
  moved: z.boolean(),
  /**
   * The item was left INCONSISTENT and needs a second look — its stored path
   * still doesn't point at its files. Separate from `note`, which is also used
   * for benign outcomes (an interrupted earlier run whose frontmatter this pass
   * healed reports "no files found at the old path" and is a SUCCESS): keying
   * "couldn't handle it" on the presence of a note made a healthy sweep tell
   * Jasper it had failed.
   */
  unresolved: z.boolean().optional(),
  note: z.string().optional(),
});
/** Provenance of a recovered chapter list — who to credit, and how strongly. */
const ChapterSourceSchema = z.object({
  from: z.enum(['official', 'description', 'comment']),
  author: z.string().optional(),
  like_count: z.number().optional(),
  pinned: z.boolean().optional(),
  by_uploader: z.boolean().optional(),
  comment_id: z.string().optional(),
});
const OutputSchema = z.object({
  facet: z.enum(['captions', 'chapters', 'nsfw', 'taxonomy', 'move']),
  found: z.boolean(),
  item_id: z.string().optional(),
  title: z.string().optional(),
  enabled: z.boolean(),
  skipped: z.boolean(), // already had captions (and not refetch)
  captions: z.array(TrackSchema),
  fetched_langs: z.array(z.string()),
  /** facet:'chapters' — how many chapters are on record after this run. */
  chapters: z.number().optional(),
  /** facet:'chapters' — set when THIS run recovered them; tells Kate who to credit. */
  chapter_source: ChapterSourceSchema.optional(),
  /** facet:'nsfw' — one entry per item examined this run. */
  reclassified: z.array(NsfwRescanSchema).optional(),
  /** facet:'taxonomy' — one entry per off-schema item found this run. */
  taxonomy: z.array(TaxonomyMoveSchema).optional(),
  scanned: z.number().optional(),
  /** facet:'nsfw' sweep — items that needed re-filing but did NOT fit this run's
   *  work bound (see `sweep_bounds`). 0 means the sweep finished the whole set. */
  deferred: z.number().optional(),
  /** facet:'taxonomy' — false for a dry run (the default). */
  applied: z.boolean().optional(),
  message: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;
type NsfwRescanRow = z.infer<typeof NsfwRescanSchema>;
type TaxonomyMove = z.infer<typeof TaxonomyMoveSchema>;

const IMAGE_KINDS = new Set(['image_gallery', 'photoset']);

/** Existing caption tracks off a note's (live) frontmatter — tolerant. */
function existing_captions(frontmatter: Record<string, unknown>): SubtitleTrack[] {
  const caps = frontmatter.captions;
  if (!Array.isArray(caps)) return [];
  return caps.filter(
    (c): c is SubtitleTrack =>
      !!c && typeof c === 'object' && typeof (c as SubtitleTrack).lang === 'string',
  );
}

/** Resolve the media file's directory + stem, clamped inside the archive root. */
function dir_and_stem(archive_root: string, nas_path: string): { dir_abs: string; stem: string } | null {
  const abs = safe_archive_abs(archive_root, nas_path);
  if (abs === null) return null;
  const base = basename(abs);
  const dot = base.lastIndexOf('.');
  return { dir_abs: dirname(abs), stem: dot > 0 ? base.slice(0, dot) : base };
}

/** Resolve an archived item by id or (fuzzy) title — cordon-checked both ways, so
 *  an item the caller can't see simply doesn't resolve (the honest "not found"). */
function resolve_item(ctx: ToolContext, caller: Caller, q: string): MediaItemRow | null {
  const by_id = /^mi_[a-z0-9]{6,}$/.test(q) ? ctx.memory.get_media_item(q, caller) : null;
  if (by_id) return by_id;
  const rows = ctx.memory.query_media_items({ caller, limit: 5000 });
  const lc = q.toLowerCase();
  return (
    rows.find((r) => r.name.toLowerCase() === lc) ??
    rows.find((r) => r.name.toLowerCase().includes(lc)) ??
    rows.find((r) => lc.includes(r.name.toLowerCase())) ??
    null
  );
}

// ── facet: nsfw ──────────────────────────────────────────────────────────────

/**
 * Upper bound on archive jobs this sweep RECEIVES from the ledger.
 *
 * It bounds exactly one thing: the length of the array `list_for_user` hands back.
 * Not the work (see `sweep_bounds` below), and — a second earlier version of this
 * comment got this wrong too — not the SQLite walk either. `list_for_user`
 * (memory/stores/media_jobs.ts) has no SQL LIMIT: it reads every
 * `media_archive_jobs` row newest-first, hydrates each one, applies the cordon, and
 * slices last. So the read is O(all jobs) regardless of what is passed here.
 *
 * That is left as-is deliberately. The slice can only come after the cordon filter,
 * because deciding whether a row is visible needs the hydrated `private_to`; a real
 * SQL LIMIT would bound rows BEFORE the filter, so a caller whose jobs are sparse
 * among other people's would get fewer than their own newest `limit` — under-
 * reporting their archive to hit a bound. Pushing the cordon into SQL instead would
 * mean a second copy of a privacy rule (the thing @core/media/cordon exists to
 * prevent) for a table that holds one row per archive request. If that table ever
 * grows enough for the walk to matter, the honest fix is a `requested_by` index
 * plus a cordon-aware query, not a LIMIT bolted in front of the filter.
 */
const MAX_JOB_SCAN = 5000;

/**
 * Bounds on the WORK one sweep does, which `MAX_JOB_SCAN` never did.
 *
 * Each re-filed item is an HTTP round trip to the classifier sidecar plus an
 * `upsert_note`, and this facet runs IN-TURN inside a chat turn. Walking 5000
 * ledger rows is microseconds; re-classifying 5000 items is an unbounded stall
 * behind Kate's reply, and the tool description explicitly invites "sweep the whole
 * archive". So a sweep does at most `max_items`, and stops early once `budget_ms`
 * has elapsed — whichever binds first.
 *
 * The leftovers are REPORTED (`deferred` on the result, and a sentence in the
 * message telling him to run it again), never silently truncated: a remediation
 * pass that quietly stops halfway would leave the caller believing the archive is
 * clean. The sweep is idempotent and its target set drains, so a re-run resumes.
 *
 * Read per call rather than at module load so a smoke can pin them (and so an
 * operator can widen the budget for a one-off backfill without a redeploy).
 */
function sweep_bounds(): { max_items: number; budget_ms: number } {
  const n = Number(process.env.HEARTH_MEDIA_RESCAN_MAX);
  const ms = Number(process.env.HEARTH_MEDIA_RESCAN_BUDGET_MS);
  return {
    max_items: Number.isFinite(n) && n >= 1 ? Math.floor(n) : 25,
    budget_ms: Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : 20_000,
  };
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * The classifier NEVER RAN for this job — whatever verdict got written down.
 * `frames_scored: 0` is the proof: every path that reaches the classifier records
 * at least one scored frame, so a zero means the verdict came from somewhere other
 * than a look at the image (the 2026-07-15 `audio_only → sfw` early return).
 */
function never_classified(job: MediaJobRow): boolean {
  const agg = job.nsfw as Partial<NsfwAggregate> | null;
  if (agg == null) return true;
  // A recorded review IS a real look (or an honest metadata read, marked as
  // such) — a VL-reviewed item whose sidecar was down is discerned, not
  // fabricated.
  if (agg.review != null) return false;
  return typeof agg.frames_scored !== 'number' || agg.frames_scored === 0;
}

/** Fail-closed verdict nobody has DISCERNED yet — the auto-private backlog the
 *  2026-08-10 owner directive exists to drain. */
function undiscerned_uncertain(job: MediaJobRow): boolean {
  const agg = job.nsfw as Partial<NsfwAggregate> | null;
  return agg != null && agg.verdict === 'uncertain' && agg.review == null;
}

/**
 * Does this row need re-filing? THREE independent reasons, and the sweep must
 * catch all of them — a repair pass that only fixes one leaves the archive half
 * on a retired policy:
 *
 *  1. the classifier never ran (the 2026-07-15 fail-open verdict), or
 *  2. the row is still household-scoped (off the 2026-07-29 requester-silo
 *     policy) — true for every item filed before that date whose verdict was
 *     perfectly honest, which is exactly the class a `frames_scored`-only target
 *     set misses, or
 *  3. the verdict is a fail-closed `uncertain` no reviewer has discerned (the
 *     pre-2026-08-10 auto-private class — cover-art-less audio especially).
 *
 * Reason 2 reads the PROJECTED row rather than the note. A lagging projection can
 * only mis-target (harmless — the re-file is idempotent) or miss a row the next
 * sweep then catches; `reclassify_item` re-reads the note before writing either way.
 */
function needs_refile(job: MediaJobRow, row: MediaItemRow): boolean {
  return (
    never_classified(job) ||
    is_off_policy_media_cordon(row.private_to) ||
    undiscerned_uncertain(job)
  );
}

/**
 * Re-file ONE archived item: repair its cordon, and re-run the classifier over
 * the thumbnail ALREADY ON DISK (nothing is re-downloaded). Both halves persist
 * through `upsert_note` — the note is the source of truth and the ingestor owns
 * the `media_items` projection, so this NEVER writes that table directly.
 *
 * The two halves are deliberately INDEPENDENT, and that independence is the fix
 * for the case that matters most: an item still shelved to the household whose
 * thumbnail is missing or unreadable. Its cordon is off-policy regardless of what
 * any classifier would have said, so the re-file happens anyway; only the
 * verdict is left alone, and the row says why. Coupling them (the pre-2026-07-29
 * shape, which returned early on an unreadable thumbnail) meant the rows most
 * likely to be wrong were the ones the sweep silently skipped.
 *
 * The cordon rule itself is NOT restated here — `tighten_media_cordon` is the
 * same module the runner's filing phase writes through, so the repair path and
 * the write path cannot drift apart again.
 */
async function reclassify_item(
  ctx: ToolContext,
  archive_root: string,
  row: MediaItemRow,
  job: MediaJobRow,
): Promise<NsfwRescanRow> {
  // Read the cordon off the NOTE (source of truth), not the projected row: the
  // ingestor reprojects async, so `row.private_to` can lag a hand re-stamp — the
  // same projection-lag hazard the captions facet reads around.
  const note = ctx.memory.read_note(row.note_path);
  if (!note) {
    // No note = nothing to re-file. Writing one here would FABRICATE the archive's
    // source of truth from a projected row, so refuse and say so.
    return {
      item_id: row.id,
      title: row.name,
      verdict: 'uncertain',
      score: 0,
      frames_scored: 0,
      private_to: row.private_to ?? MEDIA_CORDON_FALLBACK,
      cordon_tightened: false,
      note: 'no context note on disk to re-file',
    };
  }
  const fm = note.frontmatter;
  const current = parse_private_to(fm.private_to);
  const next = tighten_media_cordon(current, job.requested_by);
  // An unset cordon already resolves owner-tier-only, so stamping it explicitly
  // changes nothing about who can see the item — that is not a tightening.
  const cordon_tightened = current !== undefined && next !== current;

  /** Commit the re-file: the cordon when it moves, the verdict when we got one. */
  const settle = (agg: NsfwAggregate | null, why?: string): NsfwRescanRow => {
    // Nothing to persist when there is no verdict AND the cordon is already
    // on-policy — an unreadable row is re-visited every sweep, so a blind write
    // would rewrite the note each time for no change.
    if (agg !== null || next !== current) {
      const patch: Record<string, unknown> = { private_to: next };
      if (agg) {
        // Same derivation the runner's filing phase and the note builder use, so a
        // repaired row's flag can't come out meaning something different from a
        // freshly-archived one's — review provenance included.
        patch.nsfw = nsfw_flag_for(agg.verdict);
        patch.nsfw_score = round3(agg.score);
        if (agg.review) {
          patch.content_rating = agg.review.rating;
          patch.review = {
            source: agg.review.source,
            frames_reviewed: agg.review.frames_reviewed,
            at: agg.review.at,
          };
        }
      }
      ctx.memory.upsert_note(row.note_path, patch, '');
    }
    // Record the real read on the runner ledger, so the never-classified target
    // set drains for the rows we could actually look at. A row we could NOT read
    // stays targeted on purpose: writing a verdict we never obtained is exactly
    // the fail-open this facet exists to remediate.
    if (agg) ctx.memory.media_jobs.update(job.id, { nsfw: agg });
    return {
      item_id: row.id,
      title: row.name,
      verdict: agg?.verdict ?? 'uncertain',
      score: agg ? round3(agg.score) : 0,
      frames_scored: agg?.frames_scored ?? 0,
      ...(agg?.review ? { rating: agg.review.rating } : {}),
      private_to: next,
      cordon_tightened,
      ...(why !== undefined ? { note: why } : {}),
    };
  };

  // ── gather the visual evidence (frames > thumbnail > nothing) ─────────────
  // Frames come from the archived file ALREADY ON DISK — nothing is
  // re-downloaded. A video yields frames across its full duration (the same
  // sampler the write path uses); anything without sampleable frames falls back
  // to its thumbnail; a bare audio rip yields nothing and goes to the judge.
  const fm_kind = str(fm.media_kind) ?? '';
  const is_gallery = IMAGE_KINDS.has(fm_kind) || typeof fm.image_count === 'number';
  // A video TRACK is what makes frames sampleable, and `vcodec` is the measured
  // record of one (an audio rip's note carries only `acodec`) — so the gate is
  // a fact off the note, not a guess off the kind label.
  const has_video_track = str(fm.vcodec) !== undefined;
  let frames: Uint8Array[] = [];
  const media_rel = str(fm.nas_path);
  if (media_rel !== undefined && !is_gallery && has_video_track) {
    const media_abs = safe_archive_abs(archive_root, media_rel);
    const duration = typeof fm.duration_s === 'number' ? fm.duration_s : undefined;
    if (media_abs !== null) {
      frames = await sample_keyframes(media_abs, REVIEW_FRAME_COUNT, duration);
    }
  }
  let evidence_note: string | undefined;
  if (frames.length === 0 && row.thumbnail_path) {
    const thumb_abs = safe_archive_abs(archive_root, row.thumbnail_path);
    if (thumb_abs === null) {
      evidence_note = 'thumbnail path escapes the archive root';
    } else {
      try {
        frames = [new Uint8Array(readFileSync(thumb_abs))];
      } catch (err) {
        // fall through to the judge — but keep the honest reason for the report
        evidence_note = `thumbnail unreadable (${(err as Error).message.slice(0, 100)})`;
      }
    }
  }

  // ── sidecar threshold over the same frames ────────────────────────────────
  let sidecar: NsfwAggregate | null = null;
  if (frames.length > 0) {
    const classes: NsfwClasses[] = [];
    for (const f of frames) {
      const r = await classify_image(f);
      if (r.available && r.classes) classes.push(r.classes);
    }
    if (classes.length > 0) sidecar = aggregate_verdict(classes);
  }

  // ── discernment: the review replaces the threshold, in either direction ───
  // (same ensemble as the runner's `discern_content` — VL over frames, or the
  // metadata judge when there is nothing to look at; no reviewer reachable →
  // the sidecar verdict stands, fail-closed included.)
  const rv = ctx.llm
    ? frames.length > 0
      ? await review_frames(frames, ctx.llm)
      : await judge_metadata(
          {
            title: str(fm.name) ?? row.name,
            uploader: str(fm.creator),
            site: str(fm.source_site),
            url: str(fm.source_url),
            tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : undefined,
          },
          ctx.llm,
        )
    : { available: false as const, error: 'no llm in tool context' };
  let final: NsfwAggregate | null = sidecar;
  if (rv.available && rv.review) {
    final = {
      verdict: verdict_for_rating(rv.review.rating),
      score: sidecar?.score ?? 0,
      frames_scored: sidecar?.frames_scored ?? 0,
      reason:
        `${rv.review.source}_review: ${rv.review.rating} over ${rv.review.frames_reviewed} frame(s); ` +
        `sidecar said ${sidecar?.verdict ?? 'nothing'}`,
      review: rv.review,
    };
  }
  if (final === null) {
    return settle(
      null,
      evidence_note ??
        (frames.length === 0
          ? 'nothing to look at (no frames, no thumbnail) and no reviewer reachable'
          : 'classifier and reviewer both unavailable'),
    );
  }
  return settle(final);
}

/**
 * facet:'nsfw' — re-file already-archived items that `needs_refile` flags (never
 * actually classified, and/or still household-scoped under the retired cordon):
 * re-run the safe/explicit classifier off the on-disk thumbnail and re-apply the
 * requester-silo cordon. With no `item` it sweeps the rows the caller can see, up
 * to this run's work bound, and reports the rest as `deferred`; with one `item` it
 * does just that item. No re-download.
 */
async function run_nsfw_facet(
  input: Input,
  ctx: ToolContext,
  caller: Caller,
  archive_root: string,
): Promise<Output> {
  const empty: Pick<Output, 'facet' | 'skipped' | 'captions' | 'fetched_langs'> = {
    facet: 'nsfw',
    skipped: false,
    captions: [],
    fetched_langs: [],
  };
  // The job ledger is cordoned the same way the items are, so a member can only
  // ever rescan what they can already see.
  // Only settled jobs: an open one is still the runner's to classify.
  const ledger = ctx.memory.media_jobs.list_for_user(caller, { limit: MAX_JOB_SCAN });
  // The ledger read is newest-first and capped at MAX_JOB_SCAN VISIBLE jobs, so a
  // saturated result means older ones were dropped from the slice before this sweep
  // ever saw them — `deferred` can't speak for those, and "nothing to re-check"
  // would be a claim about rows this tool never looked at.
  const unread_ledger = ledger.length >= MAX_JOB_SCAN;
  const ledger_note = unread_ledger
    ? ` I only got through the newest ${MAX_JOB_SCAN} archive jobs, so there may be older ones I haven't looked at.`
    : '';
  const jobs = ledger.filter((j) => j.status === 'done');

  // ── one named item ──────────────────────────────────────────────────────────
  const q = (input.item ?? '').trim();
  if (q.length > 0) {
    const row = resolve_item(ctx, caller, q);
    if (!row) {
      return {
        ...empty,
        found: false,
        enabled: true,
        message: `I couldn’t find an archived item matching “${q}”. Give me its exact title or id (mi_…).`,
      };
    }
    const base: Pick<Output, 'facet' | 'found' | 'enabled' | 'item_id' | 'title'> = {
      facet: 'nsfw',
      found: true,
      enabled: true,
      item_id: row.id,
      title: row.name,
    };
    const job = jobs.find((j) => j.media_item_id === row.id);
    if (!job) {
      return {
        ...base,
        skipped: false,
        captions: [],
        fetched_langs: [],
        scanned: 0,
        message: `I have no archive job on record for “${row.name}”, so I can’t tell whether its safe/explicit check ever ran. Leaving it alone.`,
        reclassified: [],
      };
    }
    if (!needs_refile(job, row) && !input.refetch) {
      return {
        ...base,
        skipped: true,
        captions: [],
        fetched_langs: [],
        scanned: 0,
        message: `“${row.name}” was already properly classified and is filed to the right person. Say refetch if you want me to re-check it anyway.`,
        reclassified: [],
      };
    }
    const res = await reclassify_item(ctx, archive_root, row, job);
    audit_nsfw_rescan(ctx, input, [res], 0);
    return {
      ...base,
      skipped: false,
      captions: [],
      fetched_langs: [],
      scanned: 1,
      deferred: 0, // one named item is never over the sweep's work bound
      message: describe_nsfw_rescan([res], 0),
      reclassified: [res],
    };
  }

  // ── sweep every item that needs re-filing ───────────────────────────────────
  const targets: Array<{ row: MediaItemRow; job: MediaJobRow }> = [];
  for (const job of jobs) {
    const item_id = job.media_item_id;
    if (item_id == null) continue; // never filed an item — nothing to re-cordon
    const row = ctx.memory.get_media_item(item_id, caller); // cordon-checked again
    if (!row) continue;
    if (!input.refetch && !needs_refile(job, row)) continue;
    targets.push({ row, job });
  }
  if (targets.length === 0) {
    return {
      ...empty,
      found: false,
      enabled: true,
      scanned: 0,
      deferred: 0,
      message:
        'Nothing to re-check — every archived item I can see was properly classified and is filed to the person who asked for it.' +
        ledger_note,
      reclassified: [],
    };
  }
  // Bounded work (see `sweep_bounds`): at most `max_items`, and no new item once
  // the time budget is spent. ALWAYS do at least one — a stingy budget must slow
  // the sweep down, never turn it into a no-op that defers forever.
  const { max_items, budget_ms } = sweep_bounds();
  const deadline = Date.now() + budget_ms;
  const results: NsfwRescanRow[] = [];
  let deferred = 0;
  for (const [i, t] of targets.entries()) {
    if (results.length >= max_items || (results.length > 0 && Date.now() >= deadline)) {
      deferred = targets.length - i;
      break;
    }
    results.push(await reclassify_item(ctx, archive_root, t.row, t.job));
  }
  audit_nsfw_rescan(ctx, input, results, deferred);
  return {
    ...empty,
    found: true,
    enabled: true,
    scanned: results.length,
    deferred,
    message: describe_nsfw_rescan(results, deferred) + ledger_note,
    // LAST on purpose: the LLM-facing copy of a tool result is head-biased
    // (compact_tool_result keeps the first ~30% of the budget), so the summary
    // `message` must precede the unbounded per-item detail — a big sweep should
    // lose row detail, never Kate's read of what happened.
    reclassified: results,
  };
}

/** One audit row per RUN carrying every item's before/after — the forensic record
 *  for a cordon-changing sweep. Best-effort like the captions facet's. */
function audit_nsfw_rescan(
  ctx: ToolContext,
  input: Input,
  results: NsfwRescanRow[],
  deferred: number,
): void {
  try {
    ctx.memory.log_action({
      intent_id: ctx.intent_id ?? ulid(),
      agent: 'orchestrator',
      tool_name: 'media_nsfw_rescan',
      tool_input: { item: input.item ?? '(sweep)', refetch: !!input.refetch },
      execution_result: {
        scanned: results.length,
        tightened: results.filter((r) => r.cordon_tightened).length,
        // On the record too: an audit that showed only what a bounded sweep DID
        // would read as a completed audit of the whole archive.
        deferred,
        items: results,
      },
    });
  } catch {
    /* audit is best-effort */
  }
}

function describe_nsfw_rescan(results: NsfwRescanRow[], deferred: number): string {
  const tightened = results.filter((r) => r.cordon_tightened);
  const flagged = results.filter((r) => r.verdict === 'nsfw');
  const cleared = results.filter((r) => r.verdict === 'sfw' && r.rating !== undefined);
  const failed = results.filter((r) => r.note !== undefined);
  const parts = [`Re-checked ${results.length} item${results.length === 1 ? '' : 's'}.`];
  if (flagged.length > 0) {
    // Say the DISCERNED rating, not a blanket "explicit" — suggestive items are
    // shelved private too, but calling them explicit misreports what was seen.
    const label = (r: NsfwRescanRow): string => `“${r.title}” (${r.rating ?? 'not confirmed safe'})`;
    parts.push(`${flagged.length} stay${flagged.length === 1 ? 's' : ''} private: ${flagged.map(label).join(', ')}.`);
  }
  if (cleared.length > 0) {
    parts.push(
      `${cleared.length} came back safe on review: ${cleared.map((r) => `“${r.title}”`).join(', ')} — ` +
        `run the taxonomy re-file (apply:true) to move ${cleared.length === 1 ? 'it' : 'them'} out of Private/.`,
    );
  }
  if (tightened.length > 0) {
    // The only scope the retired policy handed out that is broader than one
    // person was 'household', so a tightening is always that re-file.
    parts.push(
      `Re-filed ${tightened.length} onto the person who asked for ${tightened.length === 1 ? 'it' : 'them'} (they were shared with the whole household).`,
    );
  } else {
    parts.push('No privacy changes were needed.');
  }
  if (failed.length > 0) {
    // These may still have been re-filed — only the classifier read failed.
    parts.push(
      `Couldn’t look at ${failed.length}: ${failed.map((r) => `“${r.title}” (${r.note})`).join('; ')}.`,
    );
  }
  if (deferred > 0) {
    // Say it plainly: an unreported truncation would leave him thinking the audit
    // covered everything. The target set drains, so a re-run picks up the rest.
    parts.push(
      `That's as many as I can do in one go — ${deferred} more still ${deferred === 1 ? 'needs' : 'need'} re-checking, so ask me again and I'll carry on.`,
    );
  }
  return parts.join(' ');
}

// ── facet: taxonomy ─────────────────────────────────────────────────────────

/** Upper bound on items walked per sweep (the archive is small; a backstop so it
 *  can't turn one turn into a long scan). */
const MAX_ITEM_SCAN = 5000;

const str = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
};

/**
 * The deriver's input, read off the item's NOTE — the source of truth, and the
 * only place a re-derivation can honestly come from (the ingestor owns the
 * `media_items` projection and lags it).
 *
 * The note carries `creator` (already resolved from channel/uploader at write
 * time), `source_site` (the extractor), `source_url`, `published_at`, `name` (the
 * title), and the per-site `metrics` passthrough where a measured album lives. It
 * deliberately has no `channel`/`uploader` of its own — those are typed probe
 * fields that never reach the note — which is exactly why `media_folder_segments`
 * prefers `creator`: it makes the write path's derivation and this one identical,
 * and a migration that disagreed with the writer would re-move the same files
 * forever.
 *
 * `name` is the note's spelling of the write path's `title_clean` — the same value
 * `build_media_note` wrote from the same decision — so the title rung of the album
 * slot and the `<title> [<id>]` filename stem both re-derive byte-identically
 * here. The one place they spell "absent" differently is `MEDIA_UNTITLED_NAME`,
 * which the taxonomy module recognises and maps back to no title.
 */
function taxonomy_input_from_note(frontmatter: Record<string, unknown>): MediaTaxonomyInput {
  const metrics =
    frontmatter.metrics && typeof frontmatter.metrics === 'object'
      ? (frontmatter.metrics as Record<string, unknown>)
      : {};
  const out: MediaTaxonomyInput = {};
  const kind = str(frontmatter.media_kind);
  if (kind !== undefined) out.media_kind = kind;
  const creator = str(frontmatter.creator);
  if (creator !== undefined) out.creator = creator;
  const title = str(frontmatter.name);
  if (title !== undefined) out.title = title;
  const site = str(frontmatter.source_site);
  if (site !== undefined) out.extractor = site;
  const url = str(frontmatter.source_url);
  if (url !== undefined) out.webpage_url = url;
  const published = str(frontmatter.published_at);
  if (published !== undefined) out.published_at = published;
  const album = str(metrics.album);
  if (album !== undefined) out.album = album;
  // The stored FLAG + review provenance, the two inputs of the canonical
  // Private/ rule (see media_canonical_path). Strictly `=== true` / shape-checked:
  // absent or malformed frontmatter must not conjure a cordon the note never
  // carried — nor a review that never ran.
  if (frontmatter.nsfw === true) out.nsfw = true;
  if (frontmatter.review !== null && typeof frontmatter.review === 'object') out.reviewed = true;
  // The owner's directed-move pin (facet:'move'), which outranks both rules
  // above. `str()` guards: an un-pin writes `placement: null`, which must read
  // as absent, never as a directory called "null".
  const placement = str(frontmatter.placement);
  if (placement !== undefined) out.placement = placement;
  return out;
}

/**
 * The deriver's input read off the PROJECTED row's typed columns.
 *
 * Used for exactly ONE question, and never to move anything: *does this item
 * even look misfiled?* — asked only when the note is gone, so a perfectly
 * canonical item whose note went missing isn't reported as a problem on every
 * sweep forever. Re-filing still refuses without the note: the ingestor owns
 * this projection and lags it, so letting a stale row author the archive's shape
 * is exactly the fabrication `refile_item` exists to refuse.
 *
 * No `album` (it lives in the note's `metrics` passthrough), so for a Music item
 * with a real album this leans toward "looks off-schema" — reported, never
 * moved, which is the safe direction for a read-only plausibility check.
 *
 * `name` IS projected, so the title rung of the album slot and the `<title> [<id>]`
 * filename both re-derive the same here as from the note. That narrows the
 * album-only gap above rather than widening it: the two inputs now differ in one
 * field, not two.
 */
function taxonomy_input_from_row(row: MediaItemRow): MediaTaxonomyInput {
  const out: MediaTaxonomyInput = {};
  const kind = str(row.media_kind);
  if (kind !== undefined) out.media_kind = kind;
  const creator = str(row.creator);
  if (creator !== undefined) out.creator = creator;
  const title = str(row.name);
  if (title !== undefined) out.title = title;
  const site = str(row.source_site);
  if (site !== undefined) out.extractor = site;
  const url = str(row.source_url);
  if (url !== undefined) out.webpage_url = url;
  const published = str(row.published_at);
  if (published !== undefined) out.published_at = published;
  // Projected flag, same tighten-only consumer as the note path. The row can
  // only LAG the note (the ingestor reprojects async), and a lagging flag makes
  // this plausibility check read "looks fine" — reported nothing, moved nothing —
  // which the next sweep after reprojection then catches.
  if (row.nsfw !== 0) out.nsfw = true;
  return out;
}

/**
 * The top-level ENTRY under the taxonomy directory that a stored path belongs to.
 *
 * Not the basename: an image gallery's poster is `<dir>/<id>/001.jpg`, whose
 * basename says nothing about which item owns it. The entry (the item's stem) is
 * the thing the move loop actually renames, so it is what ownership must be judged
 * on — and it is why `repoint` applies the rename to this component and no other.
 */
function entry_of(path: string | undefined, from_dir: string): string | undefined {
  return under(path, from_dir)?.split('/')[0];
}

/**
 * Plan — and, when `apply`, perform — the re-file of ONE item.
 *
 * The stored paths are read from the NOTE, and only the note is written back
 * (`upsert_note` merges frontmatter and preserves the body). `UPDATE media_items`
 * is never issued: the ingestor owns that projection, and writing it directly
 * would leave the row disagreeing with its own source of truth the moment the
 * next reprojection ran.
 *
 * TOTAL: every vault read/write is guarded, so this returns a report for ANY
 * outcome instead of throwing. A throw here used to abort the whole sweep AFTER
 * files had already moved on the NAS, and the audit row (written once, after the
 * loop) never landed — so Kate got a raw tool error and could not tell Jasper what
 * had moved. Each guard reports precisely, because only the code that failed
 * knows whether bytes had already moved.
 */
function refile_item(
  ctx: ToolContext,
  archive_root: string,
  row: MediaItemRow,
  apply: boolean,
): TaxonomyMove | null {
  const base = { item_id: row.id, title: row.name };
  const unreadable = (why: string): TaxonomyMove => ({
    ...base,
    from: media_dir_of(row.nas_path),
    to: '',
    from_path: media_normalize_path(row.nas_path),
    off_schema: false,
    moved: false,
    unresolved: true,
    note: why,
  });

  let note: { frontmatter: Record<string, unknown>; body: string } | null;
  try {
    note = ctx.memory.read_note(row.note_path);
  } catch (err) {
    // A note we cannot READ is not a note we may act on — same refusal as a
    // missing one, but named differently so Jasper can tell a broken file from
    // an absent one.
    return unreadable(`couldn’t read the context note (${(err as Error).message.slice(0, 140)})`);
  }
  if (!note) {
    // No note = no source of truth. Writing one from a projected row would
    // FABRICATE the archive's authority, so refuse and say so — but only when
    // the row's own columns suggest it is misfiled at all, so a canonical item
    // with a missing note isn't reported as a problem on every sweep forever.
    if (!is_off_schema(row.nas_path, taxonomy_input_from_row(row), row.id)) return null;
    return unreadable('no context note on disk to re-file');
  }
  const fm = note.frontmatter;
  const nas_path = str(fm.nas_path) ?? str(row.nas_path);
  if (nas_path === undefined) return null; // never filed a media file — nothing to move

  const input = taxonomy_input_from_note(fm);
  const from_dir = media_dir_of(nas_path);
  const from_path = media_normalize_path(nas_path);
  const to_path = media_canonical_path(nas_path, input, row.id);
  // ONE derivation: the target dir is the canonical path's dir, so the cordon
  // rule (current-Private OR flag, tighten-only) is never restated here.
  const to_dir = media_dir_of(to_path);
  if (!is_off_schema(nas_path, input, row.id)) return null; // already canonical — idempotent skip

  const plan: TaxonomyMove = {
    ...base,
    from: from_dir,
    to: to_dir,
    from_path,
    to_path,
    // A rename with no move is a real outcome now (an item already in the right
    // folder whose file doesn't carry its name), so the two axes are reported
    // separately rather than folded into one "off_schema" the owner can't read.
    renamed: basename(from_path) !== basename(to_path),
    off_schema: true,
    moved: false,
  };
  if (!apply) return plan;

  const root_abs = resolve(archive_root);
  const from_abs = safe_archive_abs(archive_root, from_dir);
  const to_abs = safe_archive_abs(archive_root, to_dir);
  if (from_abs === null || to_abs === null) {
    return { ...plan, unresolved: true, note: 'path escapes the archive root — left untouched' };
  }

  const entries = item_entries(from_abs, row.id, input.title);
  const renames = new Map(entries.map((e) => [e.from, e.to]));
  const source_names = new Set(entries.map((e) => e.from));
  /** The name an entry ends up with — the map for entries we found on disk, the
   *  same derivation for one we didn't (a stored path whose file is missing). */
  const rename_entry = (entry: string): string =>
    renames.get(entry) ?? media_canonical_entry_name(entry, row.id, input.title);
  const conflicts = new Set<string>();
  let moved_count = 0;
  try {
    if (entries.length > 0) mkdirSync(to_abs, { recursive: true });
    for (const { from, to } of entries) {
      const src = join(from_abs, from);
      const dest = join(to_abs, to);
      // Already exactly where it belongs — a no-op rename in the same directory,
      // or an artefact an interrupted earlier run already finished. Not a move,
      // and emphatically not a conflict with itself.
      if (src === dest) continue;
      // Never overwrite. A destination that already exists is either an
      // interrupted earlier run or — pathologically — a duplicate id or two items
      // with the same title AND id; the safe read is "leave both alone".
      if (existsSync(dest)) {
        conflicts.add(from);
        continue;
      }
      move_entry(src, dest);
      moved_count += 1;
    }
  } catch (err) {
    return { ...plan, moved: moved_count > 0, unresolved: true, note: `move failed after ${moved_count} file(s): ${(err as Error).message.slice(0, 140)}` };
  }

  /**
   * Is the entry now at the target OURS to point the note at?
   *
   * Not "does something exist there" — that was a real hazard: in the clash case
   * the target is occupied by a file we did NOT move, and re-pointing the note at
   * it would aim this item's `nas_path` at someone else's bytes. Ownership is:
   * we moved it, or it is already there and gone from the source (an earlier
   * interrupted run finished it). A name we skipped as a conflict is never ours.
   *
   * `name` is the entry as the STORED path spells it; the entry it becomes is
   * `rename_entry(name)`, so ownership is judged on the destination we actually
   * wrote. The `src === dest` guard matters for an artefact that needed no rename
   * and no move: it is at the destination and still at the source because they are
   * the same file, which the "still at the source ⇒ never moved" test would
   * otherwise read as a failure.
   */
  const owns = (name: string | undefined): boolean => {
    if (name === undefined || conflicts.has(name)) return false;
    const src = join(from_abs, name);
    const dest = join(to_abs, rename_entry(name));
    if (src !== dest && source_names.has(name) && existsSync(src)) return false; // never moved
    return existsSync(dest);
  };

  // Re-point only the paths we own. That keeps a partial move honest (a stored
  // path is never aimed at a file that isn't this item's) and lets a re-run
  // finish the job: the next sweep sees the same off-schema row, finds the files
  // already at the target, and fixes the frontmatter.
  const patch: Record<string, unknown> = {};
  const next_nas = repoint(nas_path, from_dir, to_dir, rename_entry);
  if (next_nas !== undefined && owns(entry_of(nas_path, from_dir))) patch.nas_path = next_nas;
  const thumb = str(fm.thumbnail_path);
  const next_thumb = repoint(thumb, from_dir, to_dir, rename_entry);
  if (next_thumb !== undefined && owns(entry_of(thumb, from_dir))) patch.thumbnail_path = next_thumb;
  const caps = existing_captions(fm);
  if (caps.length > 0) {
    const next_caps = caps.map((c) => {
      const p = repoint(c.path, from_dir, to_dir, rename_entry);
      return p !== undefined && owns(entry_of(c.path, from_dir)) ? { ...c, path: p } : c;
    });
    if (next_caps.some((c, i) => c.path !== caps[i]!.path)) patch.captions = next_caps;
  }
  const notes: string[] = [];
  let note_written = true;
  if (Object.keys(patch).length > 0) {
    try {
      ctx.memory.upsert_note(row.note_path, patch, '');
    } catch (err) {
      // The BYTES have already moved. Losing this write is recoverable — the next
      // sweep sees the same off-schema row, finds the files already at the
      // target, and `owns()` lets it fix the frontmatter — so report it and let
      // the sweep continue rather than throwing the whole migration away.
      note_written = false;
      notes.push(
        `moved the files but couldn’t update the note (${(err as Error).message.slice(0, 140)}) — a re-run will finish it`,
      );
    }
  }

  if (moved_count > 0) prune_empty_dirs(root_abs, from_abs);

  // The item is settled when its stored media path now points at its files.
  // `entries.length === 0` on its own is NOT a failure: that is the shape of an
  // interrupted earlier run whose frontmatter this pass just healed.
  const repointed = patch.nas_path !== undefined && note_written;
  if (entries.length === 0) notes.push('no files found at the old path');
  if (conflicts.size > 0) notes.push(`${conflicts.size} already present at the target, left alone`);
  if (!repointed) notes.push('media path left as-is (file not at the new location)');
  return {
    ...plan,
    moved: moved_count > 0,
    ...(repointed ? {} : { unresolved: true }),
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
  };
}

/**
 * `refile_item`, with the structural guarantee that ONE bad item cannot abort a
 * sweep. `refile_item` is total by construction (every vault read/write inside it
 * is guarded, and each guard reports precisely because only it knows whether
 * bytes had already moved); this is the backstop that makes "total" hold for
 * anything unforeseen too — a migration that has already moved files must never
 * exit through an exception, because the report IS how Jasper learns what moved.
 */
function refile_item_safe(
  ctx: ToolContext,
  archive_root: string,
  row: MediaItemRow,
  apply: boolean,
): TaxonomyMove | null {
  try {
    return refile_item(ctx, archive_root, row, apply);
  } catch (err) {
    return {
      item_id: row.id,
      title: row.name,
      from: media_dir_of(row.nas_path),
      to: '',
      off_schema: false,
      moved: false,
      unresolved: true,
      note: `unexpected failure, item skipped: ${(err as Error).message.slice(0, 140)}`,
    };
  }
}

/**
 * facet:'taxonomy' — report (and optionally perform) the re-file of every item
 * whose folder is not the one the taxonomy derives. DRY RUN unless `apply`.
 */
function run_taxonomy_facet(
  input: Input,
  ctx: ToolContext,
  caller: Caller,
  archive_root: string,
): Output {
  const apply = input.apply === true;
  const empty: Pick<Output, 'facet' | 'skipped' | 'captions' | 'fetched_langs'> = {
    facet: 'taxonomy',
    skipped: false,
    captions: [],
    fetched_langs: [],
  };

  // ── one named item ─────────────────────────────────────────────────────────
  const q = (input.item ?? '').trim();
  if (q.length > 0) {
    const row = resolve_item(ctx, caller, q);
    if (!row) {
      return {
        ...empty,
        found: false,
        enabled: true,
        applied: apply,
        message: `I couldn’t find an archived item matching “${q}”. Give me its exact title or id (mi_…).`,
      };
    }
    const base: Pick<Output, 'facet' | 'found' | 'enabled' | 'item_id' | 'title'> = {
      facet: 'taxonomy',
      found: true,
      enabled: true,
      item_id: row.id,
      title: row.name,
    };
    const res = refile_item_safe(ctx, archive_root, row, apply);
    if (res === null) {
      return {
        ...base,
        skipped: true,
        captions: [],
        fetched_langs: [],
        scanned: 1,
        applied: apply,
        taxonomy: [],
        message: `“${row.name}” is already filed correctly (${media_normalize_path(row.nas_path)}). Nothing to move or rename.`,
      };
    }
    audit_taxonomy_rescan(ctx, input, apply, [res]);
    return {
      ...base,
      skipped: false,
      captions: [],
      fetched_langs: [],
      scanned: 1,
      applied: apply,
      message: describe_taxonomy_rescan([res], apply),
      taxonomy: [res],
    };
  }

  // ── sweep every item the caller can see ────────────────────────────────────
  const rows = ctx.memory.query_media_items({ caller, limit: MAX_ITEM_SCAN });
  const results: TaxonomyMove[] = [];
  // The audit is emitted in a `finally`, so the forensic record of what moved on
  // the NAS survives even if the sweep exits abnormally. It used to run only
  // after the loop: a single poisoned note write threw, ZERO audit rows landed,
  // and three files had already moved with nothing anywhere saying so.
  try {
    for (const row of rows) {
      const res = refile_item_safe(ctx, archive_root, row, apply);
      if (res !== null) results.push(res);
    }
  } finally {
    if (results.length > 0) audit_taxonomy_rescan(ctx, input, apply, results);
  }
  if (results.length === 0) {
    return {
      ...empty,
      found: false,
      enabled: true,
      scanned: rows.length,
      applied: apply,
      taxonomy: [],
      message: `Checked ${rows.length} archived item${rows.length === 1 ? '' : 's'} — every one is filed in the folder it belongs in. Nothing to move.`,
    };
  }
  return {
    ...empty,
    found: true,
    enabled: true,
    scanned: rows.length,
    applied: apply,
    message: describe_taxonomy_rescan(results, apply),
    // LAST on purpose: the LLM-facing copy of a tool result is head-biased
    // (compact_tool_result keeps the first ~30% of the budget), so the summary
    // `message` must precede the unbounded per-item detail — a big sweep should
    // lose row detail, never Kate's read of what happened.
    taxonomy: results,
  };
}

/**
 * facet:'move' — the DIRECTED move: "Kate, put this under Music/Concerts."
 *
 * Two steps, and the second is the taxonomy machinery unchanged — that is the
 * design: stamp the owner's destination as the item's `placement` pin (which
 * `media_canonical_path` ranks above every derivation), then run the SAME
 * `refile_item` the tidy sweep uses. One mover, one honesty rule (`owns()`),
 * one audit shape — and the pin is exactly why the next sweep leaves the item
 * where the owner put it instead of "repairing" it back.
 *
 * `to: 'auto'` clears the pin (writes `placement: null`, which the reader
 * treats as absent) and re-files to the derived home — the undo.
 *
 * The move is applied IMMEDIATELY (no dry-run default): it is one item, named,
 * with an explicit destination — the owner already said the word. The
 * destination is containment-checked against the archive root; the filename
 * stays `<title> [<id>]` (a move places an item, it never renames one); and
 * `private_to` — who can SEE it — never changes on any move.
 */
function run_move_facet(
  input: Input,
  ctx: ToolContext,
  caller: Caller,
  archive_root: string,
): Output {
  const empty: Pick<Output, 'facet' | 'skipped' | 'captions' | 'fetched_langs'> = {
    facet: 'move',
    skipped: false,
    captions: [],
    fetched_langs: [],
  };
  const q = (input.item ?? '').trim();
  if (q.length === 0) {
    return {
      ...empty,
      found: false,
      enabled: true,
      message: "A directed move needs the item — tell me which one (its title or mi_… id) via `item`.",
    };
  }
  const to_raw = (input.to ?? '').trim();
  if (to_raw.length === 0) {
    return {
      ...empty,
      found: false,
      enabled: true,
      message: "A directed move needs a destination — pass `to` (a folder like 'Music/Concerts', or 'auto' to return the item to its derived home).",
    };
  }
  const row = resolve_item(ctx, caller, q);
  if (!row) {
    return {
      ...empty,
      found: false,
      enabled: true,
      message: `I couldn’t find an archived item matching “${q}”. Give me its exact title or id (mi_…).`,
    };
  }
  const base: Pick<Output, 'facet' | 'found' | 'enabled' | 'item_id' | 'title'> = {
    facet: 'move',
    found: true,
    enabled: true,
    item_id: row.id,
    title: row.name,
  };

  const unpin = to_raw.toLowerCase() === 'auto';
  const pin = unpin ? undefined : media_normalize_path(to_raw);
  if (pin !== undefined) {
    if (pin.length === 0 || safe_archive_abs(archive_root, pin) === null) {
      return {
        ...base,
        skipped: true,
        captions: [],
        fetched_langs: [],
        message: `“${to_raw}” isn’t a usable destination — give me a folder inside the archive, like 'Music/Concerts'.`,
      };
    }
  }

  // Stamp (or clear) the pin FIRST: the refile below reads the note fresh, and
  // if the file move then fails partway, the pin already records the owner's
  // intent — the next sweep or re-run finishes the job instead of undoing it.
  ctx.memory.upsert_note(row.note_path, { placement: pin ?? null }, '');

  const res = refile_item_safe(ctx, archive_root, row, true);
  if (res !== null) audit_taxonomy_rescan(ctx, input, true, [res]);
  if (res === null) {
    // Already exactly where the pin (or the derived home, for 'auto') says.
    return {
      ...base,
      skipped: true,
      captions: [],
      fetched_langs: [],
      applied: true,
      taxonomy: [],
      message: unpin
        ? `“${row.name}” is already in its derived home (${media_normalize_path(row.nas_path)}); the pin is cleared.`
        : `“${row.name}” is already at ${media_normalize_path(row.nas_path)} — pinned there now, so tidy sweeps will leave it alone.`,
    };
  }
  const moved_note = res.moved
    ? `Moved “${row.name}” → ${res.to_path}.`
    : `Couldn’t finish the move (${res.note ?? 'files were not where the record said'}) — the destination is pinned, so a re-run or the next tidy sweep will finish it.`;
  const pin_note = unpin
    ? 'The pin is cleared — it lives at its derived home again.'
    : 'It will STAY there: tidy sweeps respect the pin.';
  return {
    ...base,
    skipped: false,
    captions: [],
    fetched_langs: [],
    applied: true,
    scanned: 1,
    message: `${moved_note} ${pin_note}`,
    taxonomy: [res],
  };
}

/** One audit row per RUN carrying every planned/performed move — the forensic
 *  record for a filesystem migration. Best-effort like the captions facet's, and
 *  called from a `finally` so it lands even when the sweep exits abnormally: a
 *  migration whose moves went unrecorded is worse than one that failed. */
function audit_taxonomy_rescan(
  ctx: ToolContext,
  input: Input,
  apply: boolean,
  results: TaxonomyMove[],
): void {
  try {
    ctx.memory.log_action({
      intent_id: ctx.intent_id ?? ulid(),
      agent: 'orchestrator',
      tool_name: 'media_taxonomy_rescan',
      tool_input: { item: input.item ?? '(sweep)', apply },
      execution_result: {
        off_schema: results.filter((r) => r.off_schema).length,
        moved: results.filter((r) => r.moved).length,
        items: results,
      },
    });
  } catch {
    /* audit is best-effort */
  }
}

function describe_taxonomy_rescan(results: TaxonomyMove[], apply: boolean): string {
  const off = results.filter((r) => r.off_schema);
  const moved = results.filter((r) => r.moved);
  // Only genuinely UNRESOLVED items — see `TaxonomyMoveSchema.unresolved`. Keying
  // this on "has a note" made a healthy run (an item whose frontmatter this pass
  // healed) report itself as a failure.
  const failed = results.filter((r) => r.unresolved === true);
  const parts: string[] = [];
  if (apply) {
    parts.push(`Re-filed ${moved.length} of ${off.length} misfiled item${off.length === 1 ? '' : 's'}.`);
  } else {
    // "filed wrong" spans both axes now — a wrong folder, a filename that doesn't
    // carry the item's name, or both — so the count is not described as a folder
    // problem when some of it isn't one.
    parts.push(
      `${off.length} item${off.length === 1 ? ' is' : 's are'} filed wrong (folder and/or filename). This was a DRY RUN — nothing moved.`,
    );
    // FULL paths, not directories: the filename is part of the taxonomy now, and
    // this preview is what the owner approves before any bytes move — a
    // folder-only before→after would hide half of what an apply is going to do.
    const preview = off
      .slice(0, 8)
      .map((r) => `“${r.title}”: ${r.from_path ?? r.from} → ${r.to_path ?? r.to}`);
    if (preview.length > 0) parts.push(preview.join('; ') + '.');
    if (off.length > preview.length) parts.push(`(+${off.length - preview.length} more.)`);
    parts.push('Say the word and I’ll move them.');
  }
  if (failed.length > 0) {
    parts.push(`Couldn’t fully handle ${failed.length}: ${failed.map((r) => `“${r.title}” (${r.note})`).join('; ')}.`);
  }
  return parts.join(' ');
}

// ── facet: captions ─────────────────────────────────────────────────────────

/** facet:'captions' — re-pull subtitle tracks for ONE item (the original facet). */
async function run_captions_facet(
  input: Input,
  ctx: ToolContext,
  caller: Caller,
  archive_root: string,
): Promise<Output> {
  const langs = (input.langs ?? 'en.*').trim() || 'en.*';
  const q = (input.item ?? '').trim();
  const empty: Pick<Output, 'facet' | 'skipped' | 'captions' | 'fetched_langs'> = {
    facet: 'captions',
    skipped: false,
    captions: [],
    fetched_langs: [],
  };

  if (q.length === 0) {
    return {
      ...empty,
      found: false,
      enabled: true,
      message: 'Which item? Give me its title or id (mi_…) and I’ll pull its captions.',
    };
  }

  const row = resolve_item(ctx, caller, q);
  if (!row) {
    return {
      ...empty,
      found: false,
      enabled: true,
      message: `I couldn’t find an archived item matching “${q}”. Give me its exact title or id (mi_…).`,
    };
  }

  const base: Pick<Output, 'facet' | 'found' | 'enabled' | 'item_id' | 'title'> = {
    facet: 'captions',
    found: true,
    enabled: true,
    item_id: row.id,
    title: row.name,
  };

  if (row.media_kind && IMAGE_KINDS.has(row.media_kind)) {
    return { ...base, skipped: false, captions: [], fetched_langs: [], message: `“${row.name}” is an image gallery — no captions to pull.` };
  }
  if (!row.nas_path) {
    return { ...base, skipped: false, captions: [], fetched_langs: [], message: `“${row.name}” has no media file on record yet, so there’s nothing to attach captions to.` };
  }
  if (!row.source_url) {
    return { ...base, skipped: false, captions: [], fetched_langs: [], message: `I don’t have a source URL for “${row.name}”, so I can’t re-fetch its captions.` };
  }

  // Idempotency + the merge base read the NOTE (source of truth), not the
  // projected row's frontmatter_json — the ingestor reprojects async, so a
  // just-written caption isn't on the row yet (the projection-lag hazard).
  const note = ctx.memory.read_note(row.note_path);
  const prior = existing_captions(note?.frontmatter ?? {});
  if (prior.length && !input.refetch) {
    return {
      ...base,
      skipped: true,
      captions: prior.map((c) => ({ lang: c.lang, format: c.format, auto: c.auto })),
      fetched_langs: [],
      message: `“${row.name}” already has captions (${prior.map((c) => c.lang).join(', ')}). Say refetch if you want me to re-pull them.`,
    };
  }

  const loc = dir_and_stem(archive_root, row.nas_path);
  if (!loc) {
    return { ...base, skipped: false, captions: [], fetched_langs: [], message: `I couldn’t safely locate the file for “${row.name}”.` };
  }

  let fetched: SubtitleTrack[] = [];
  try {
    const res = await fetch_subtitles({ url: row.source_url, dir_abs: loc.dir_abs, stem: loc.stem, langs, archive_root });
    fetched = res.captions;
  } catch (err) {
    return {
      ...base,
      skipped: false,
      captions: prior.map((c) => ({ lang: c.lang, format: c.format, auto: c.auto })),
      fetched_langs: [],
      message: `I tried to pull captions for “${row.name}” but the fetch failed (${(err as Error).message.slice(0, 140)}). The item is untouched.`,
    };
  }

  if (fetched.length === 0) {
    return {
      ...base,
      skipped: false,
      captions: prior.map((c) => ({ lang: c.lang, format: c.format, auto: c.auto })),
      fetched_langs: [],
      message: `No captions available for “${row.name}” — the source doesn’t offer any for ${langs}.`,
    };
  }

  // Merge (union by lang, freshly-fetched wins) and record on the note.
  // upsert_note MERGES frontmatter over the existing note + preserves the
  // body, so a `{ captions }` patch is safe.
  const byLang = new Map<string, SubtitleTrack>(prior.map((c) => [c.lang, c]));
  for (const c of fetched) byLang.set(c.lang, c);
  const merged = [...byLang.values()].sort((a, b) => a.lang.localeCompare(b.lang));
  ctx.memory.upsert_note(row.note_path, { captions: merged }, '');

  try {
    ctx.memory.log_action({
      intent_id: ctx.intent_id ?? ulid(),
      agent: 'orchestrator',
      tool_name: 'media_captions_rescan',
      tool_input: { item_id: row.id, langs, refetch: !!input.refetch },
      execution_result: { fetched_langs: fetched.map((c) => c.lang), total: merged.length },
    });
  } catch {
    /* audit is best-effort */
  }

  return {
    ...base,
    skipped: false,
    captions: merged.map((c) => ({ lang: c.lang, format: c.format, auto: c.auto })),
    fetched_langs: fetched.map((c) => c.lang),
    message: `Pulled captions for “${row.name}”: ${fetched.map((c) => c.lang).join(', ')}. They’ll show on the player.`,
  };
}

// ── facet: chapters ─────────────────────────────────────────────────────────

/** Existing chapters off a note's (live) frontmatter — tolerant. */
function existing_chapters(frontmatter: Record<string, unknown>): MediaChapter[] {
  const chs = frontmatter.chapters;
  if (!Array.isArray(chs)) return [];
  return chs.filter(
    (c): c is MediaChapter =>
      !!c && typeof c === 'object' && typeof (c as MediaChapter).start_s === 'number',
  );
}

/**
 * facet:'chapters' — recover a chapter index for ONE item the source never
 * chaptered, by mining the description and then the top comments. Writes
 * `chapters` + `chapter_source` to the note; the item route serves both, so the
 * player gets a scrubber index AND the credit that goes with it.
 *
 * Never invents one: when nothing convincing is found it says so and writes
 * nothing (a wrong setlist on a scrubber is worse than no setlist).
 */
async function run_chapters_facet(input: Input, ctx: ToolContext, caller: Caller): Promise<Output> {
  const q = (input.item ?? '').trim();
  const empty: Pick<Output, 'facet' | 'skipped' | 'captions' | 'fetched_langs'> = {
    facet: 'chapters',
    skipped: false,
    captions: [],
    fetched_langs: [],
  };

  if (q.length === 0) {
    return {
      ...empty,
      found: false,
      enabled: true,
      message: 'Which item? Give me its title or id (mi_…) and I’ll go looking for its chapters.',
    };
  }
  const row = resolve_item(ctx, caller, q);
  if (!row) {
    return {
      ...empty,
      found: false,
      enabled: true,
      message: `I couldn’t find an archived item matching “${q}”. Give me its exact title or id (mi_…).`,
    };
  }

  const base: Pick<Output, 'facet' | 'found' | 'enabled' | 'item_id' | 'title'> = {
    facet: 'chapters',
    found: true,
    enabled: true,
    item_id: row.id,
    title: row.name,
  };
  const done = (chapters: number, message: string, chapter_source?: ChapterProvenance): Output => ({
    ...base,
    skipped: false,
    captions: [],
    fetched_langs: [],
    chapters,
    ...(chapter_source ? { chapter_source } : {}),
    message,
  });

  if (row.media_kind && IMAGE_KINDS.has(row.media_kind)) {
    return done(0, `“${row.name}” is an image gallery — there’s nothing to chapter.`);
  }
  if (!row.source_url) {
    return done(0, `I don’t have a source URL for “${row.name}”, so I can’t go looking for its chapters.`);
  }
  if (!row.duration_s || row.duration_s <= 0) {
    return done(0, `I don’t have a duration on record for “${row.name}”, so I can’t check a chapter list against it.`);
  }

  // Read the NOTE, not the projected row — the ingestor reprojects async.
  const frontmatter = ctx.memory.read_note(row.note_path)?.frontmatter ?? {};
  const prior = existing_chapters(frontmatter);
  if (prior.length > 0 && !input.refetch) {
    return {
      ...done(prior.length, `“${row.name}” already has ${prior.length} chapters. Say refetch if you want me to look again.`),
      skipped: true,
    };
  }

  // The archived description rides the metrics passthrough — searching it first
  // is free, and the uploader's own list beats a viewer's.
  const metrics = frontmatter.metrics as Record<string, unknown> | undefined;
  const description = typeof metrics?.description === 'string' ? metrics.description : undefined;
  // force: Jasper asked for THIS item by name, so the duration floor that keeps
  // the pipeline from mining every short clip doesn't apply.
  const mined = await mine_chapters({
    url: row.source_url,
    duration_s: row.duration_s,
    force: true,
    ...(description !== undefined ? { description } : {}),
  });
  if (!mined) {
    return done(
      prior.length,
      `I couldn’t find a chapter list for “${row.name}” — nothing usable in the description or the top comments.`,
    );
  }

  // upsert_note MERGES frontmatter + preserves the body, so this patch is safe.
  ctx.memory.upsert_note(row.note_path, { chapters: mined.chapters, chapter_source: mined.provenance }, '');

  try {
    ctx.memory.log_action({
      intent_id: ctx.intent_id ?? ulid(),
      agent: 'orchestrator',
      tool_name: 'media_chapters_rescan',
      tool_input: { item_id: row.id, refetch: !!input.refetch },
      execution_result: { chapters: mined.chapters.length, chapter_source: mined.provenance },
    });
  } catch {
    /* audit is best-effort */
  }

  return done(
    mined.chapters.length,
    `Found ${mined.chapters.length} chapters for “${row.name}”, from ${chapter_credit(mined.provenance)}. They’ll show on the player’s scrubber.`,
    mined.provenance,
  );
}

export function make_rescan_media_metadata(archive_root: string): Tool<Input, Output> {
  return {
    name: 'rescan_media_metadata',
    description:
      "Re-scan an already-archived media item for metadata you're missing, via the `facet` slot. facet:'captions' (default) finds the item (by id or title) and re-fetches ONLY its subtitle tracks (not the video), recording them so the player can show them — idempotent, skips if it already has captions unless refetch. facet:'nsfw' re-checks and re-files what may be filed wrong: it REVIEWS the actual content — frames sampled across the archived video go to the vision model, which rates them explicit/suggestive/safe and writes a short identity-free description onto the note; a bare audio rip is judged from its own metadata instead — and re-files anything still shared with the whole household onto the person who asked for it. It targets what was never really looked at: fabricated old verdicts and the fail-closed 'uncertain → private by default' backlog; omit `item` to sweep, pass one (add refetch:true to force a re-review) to do just that item. A sweep works through a BATCH per run rather than the whole archive in one turn (each item is real classifier + vision work) — the result's `deferred` count is how many still need it, so report that and offer to run it again. A changed verdict updates the flag and rating only; run facet:'taxonomy' apply:true afterwards to move the files to match. facet:'taxonomy' audits the archive's FOLDER STRUCTURE instead: it reports every item filed somewhere other than where the archive's taxonomy says it belongs (before → after) — including moving an explicit-flagged item still in the open tree INTO Private/, and a reviewed-safe item still under Private/ back OUT (un-privating requires that a real review cleared it; an unreviewed item only ever stays or moves in) — and re-files them on disk only when you also pass apply:true; omit `item` to check everything. facet:'move' relocates ONE named item to a folder Jasper names — pass the destination as `to` (e.g. 'Music/Concerts'); it moves immediately and the placement is PINNED so later tidy sweeps leave it where he put it ('auto' un-pins and returns it to its derived home). Who can see an item never changes on any move. Use captions when Jasper asks for subtitles on something already archived; use nsfw when he asks you to re-check or audit what may have been mislabelled; use move when he tells you to put a specific item somewhere ('move the Metric concert into Music/Concerts'); use taxonomy when he says the folders are wrong, says something is shelved on the wrong side of Private/, or asks you to tidy the archive — show him the dry run first, then apply once he says go. Report what you got, or that there was nothing to fix.",
    risk: 'write_internal',
    required_capabilities: ['manage_media_archive'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    idempotency_key(input) {
      return `rescan_media:${input.facet}:${input.item ?? '(sweep)'}:${input.to ?? '-'}:${input.langs ?? 'en.*'}:${input.refetch ? '1' : '0'}:${input.apply ? 'apply' : 'dry'}`;
    },
    async execute(input: Input, ctx: ToolContext): Promise<Output> {
      const caller: Caller = { user_id: ctx.user?.id, tier: ctx.user?.tier ?? 'friend' };

      if (!media_archive_enabled()) {
        return {
          facet: input.facet,
          found: false,
          enabled: false,
          skipped: false,
          captions: [],
          fetched_langs: [],
          message: 'Media archiving is turned off (HEARTH_MEDIA_ARCHIVE=0), so I can’t rescan right now.',
        };
      }

      if (input.facet === 'chapters') {
        // No tier gate: this reads public page text and writes a display-only
        // field on ONE item the caller can already see — the same blast radius
        // as pulling its captions, not the mass re-filing the repair facets do.
        return run_chapters_facet(input, ctx, caller);
      }
      if (input.facet === 'nsfw') {
        // Tier gate, defense in depth over the cordon (which already limits the
        // sweep to rows the caller can see). This facet is a MASS `private_to`
        // mutation across a whole visible set, so one over-broad `manage_media_
        // archive` grant should not be enough for a FRIEND to re-file the
        // household's archive. The captions facet stays open — pulling subtitles
        // for an item you can already see is ordinary use.
        //
        // Household tier is deliberately INSIDE the gate rather than owner-only:
        // the job ledger has no owner god-view either (`list_for_user` cordons on
        // requester/private_to), so a household-filed row that a MEMBER requested
        // is outside the owner's sweep entirely — owner-only here would make those
        // rows unrepairable by anyone. Every write remains tighten-only and moves
        // the row TOWARD the declared policy, so a member sweeping can only
        // enforce the cordon, never widen it or hide something that policy says
        // they should share. Absent caller (deliberation / scheduler) defaults to
        // owner tier, so internal passes are unaffected.
        require_caller_tier(ctx, ['owner', 'household'], 'Jasper');
        return run_nsfw_facet(input, ctx, caller, archive_root);
      }
      if (input.facet === 'move') {
        // Same gate as the repair facets: a directed move relocates files on
        // the NAS. Household tier may move their OWN items (the cordon bounds
        // what resolves); a friend may not move anything.
        require_caller_tier(ctx, ['owner', 'household'], 'Jasper');
        return run_move_facet(input, ctx, caller, archive_root);
      }
      if (input.facet === 'taxonomy') {
        // Same gate, same reasoning, different blast radius: this facet MOVES
        // FILES across a whole visible set, so one over-broad `manage_media_
        // archive` grant should not be enough for a FRIEND to reorganise the
        // household's NAS.
        //
        // Household tier is deliberately inside the gate rather than owner-only:
        // `query_media_items` cordons on `private_to` with no owner god-view, so
        // a member's own items are outside the owner's sweep entirely and
        // owner-only here would make them permanently unrepairable. Every move
        // stays within the item's existing `Private/` cordon, so a member
        // sweeping can only tidy what they can already see. Absent caller
        // (deliberation / scheduler) defaults to owner tier, so internal passes
        // are unaffected.
        require_caller_tier(ctx, ['owner', 'household'], 'Jasper');
        return run_taxonomy_facet(input, ctx, caller, archive_root);
      }
      return run_captions_facet(input, ctx, caller, archive_root);
    },
  };
}

export function create(deps: ToolDeps): Tool {
  const archive_root = process.env.HEARTH_MEDIA_ARCHIVE_ROOT ?? './data/media-archive';
  void deps; // reads/writes go through ctx.memory; only the archive root is needed here
  return make_rescan_media_metadata(archive_root) as Tool;
}
