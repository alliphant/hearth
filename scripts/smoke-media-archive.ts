/**
 * smoke:media-archive — the Media Archive pipeline (design-media-archival.md).
 *
 * Self-contained: temp vault + temp db, a scripted mock LLM, and ALL four
 * external calls test-seamed (probe / nsfw-classify / download / keyframes) — no
 * network, no yt-dlp, no ffmpeg, no NAS, no orchestrator. Thumbnails are `data:`
 * URLs, which Bun's fetch resolves locally, so the pre-gate's REAL fetch →
 * classify path runs with no network either. Exercises:
 *   - the phase machine pending→classifying→downloading→filing→done
 *   - the cordon matrix: EVERY item silos to its requester (owner directive
 *     2026-07-29 — nothing archived is household-searchable by default);
 *     NSFW → owner-only (member does NOT); an uncertain thumbnail overridden by
 *     a confident SFW keyframe read → still the requester, not household
 *   - THE INVARIANT: `sfw` is only ever asserted from a real classifier result.
 *     A generic-extractor item that LOOKS audio-only still gets its thumbnail
 *     classified (the 2026-07-15 fail-open), and an item with no visual artifact
 *     at all fails closed to `uncertain` → owner-only.
 *   - rescan_media_metadata facet:'nsfw' — the remediation sweep, over BOTH
 *     reasons a row needs re-filing: the old fail-open verdict, and a row merely
 *     left household-scoped by the retired cordon (incl. one whose thumbnail
 *     can't be read, where the cordon repair must still happen). Plus its tier
 *     gate.
 *   - `parse_classify_response` — the sidecar response-shape guard, tested
 *     directly (the classifier seam below replaces `classify_image` wholesale, so
 *     a guard inside the fetch path has no other reachable test)
 *   - `media_cordon_for` / `tighten_media_cordon` — the ONE cordon rule both the
 *     filing phase and the repair pass read
 *   - measured metrics projected onto the media_items row + FTS indexing
 *   - report-back (inbox FYI + media_archived SSE), probe-fail → failed,
 *     the HEARTH_MEDIA_ARCHIVE kill switch, and the archive_url tool (files a
 *     job + next_action + re-file collapse)
 *
 *   bun run smoke:media-archive
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { rebuild } from '@ingestor/rebuild';
import type { Caller } from '@memory/private_to';
import type { LLMRouter } from '@core/llm';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEvent, AppEventBus } from '@app/events';
import type { ToolContext } from '@core/tool';
import {
  OPEN_MEDIA_JOB_STATUSES,
  type MediaJobRow,
  type MediaJobStatus,
} from '@memory/stores/media_jobs';
import type { MediaFormat, MediaProbeResult } from '@core/media/types';
import { media_canonical_stem } from '@core/media/taxonomy';
import { apply_final_cordon } from '@core/media/refile';
import {
  _test_set_review_transport,
  _test_set_metadata_judge_transport,
  type MediaReviewResult,
} from '@connectors/media_review';
import type { MediaContentRating } from '@core/media/types';
import { _test_set_probe_transport, derive_audio_only } from '@connectors/media_probe';
import { _test_set_comment_transport } from '@connectors/media_chapter_mining';
import {
  _test_set_nsfw_transport,
  parse_classify_response,
  type NsfwAggregate,
  type NsfwClasses,
} from '@connectors/nsfw';
import {
  media_cordon_for,
  tighten_media_cordon,
  is_off_policy_media_cordon,
} from '@core/media/cordon';
import {
  _test_set_download_transport,
  _test_set_keyframe_sampler,
  _test_set_gallery_sampler,
} from '@connectors/media_download';
import {
  advance_media_job as advance,
  type MediaArchiveRunnerDeps,
} from '../src/specialists/kate/media_archive_runner';
import { make_archive_url } from '../src/specialists/kate/tools/archive_url';
import { make_rescan_media_metadata } from '../src/specialists/kate/tools/rescan_media_metadata';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

const OWNER: Caller = { user_id: 'jasper', tier: 'owner' };
const HOUSEHOLD: Caller = { user_id: 'sam', tier: 'household' };
const FRIEND: Caller = { user_id: 'kim', tier: 'friend' };

// scenario-controlled NSFW verdict for the seamed classifier. 'flip' is the
// deviation-retirement case: the FIRST classify call of the job (the pre-gate's
// thumbnail) reads SFW, every later one (the keyframes) reads NSFW — the exact
// shape that used to strand an explicit-flagged item in the open tree.
let nsfw_mode: 'sfw' | 'nsfw' | 'flip' | 'uncertain' = 'sfw';
let nsfw_calls = 0; // reset alongside each nsfw_mode = 'flip' assignment
const SFW_CLASSES: NsfwClasses = { drawings: 0, hentai: 0, neutral: 0.95, porn: 0.02, sexy: 0.03 };
const NSFW_CLASSES: NsfwClasses = { drawings: 0, hentai: 0, neutral: 0.03, porn: 0.92, sexy: 0.05 };
// sexy-dominant: weighted score 0.35 — inside the sidecar's uncertain band.
const UNCERTAIN_CLASSES: NsfwClasses = { drawings: 0, hentai: 0, neutral: 0, porn: 0, sexy: 1 };

// A 1×1 PNG as a `data:` URL. Bun's fetch resolves `data:` locally, so a fixture
// thumbnail exercises the pre-gate's REAL fetch_image_bytes → classify path
// without a network hop. (The fixtures used to omit the thumbnail ENTIRELY, which
// meant the pre-gate could never fire — and the audio fail-open it hid was
// therefore untestable.)
const COVER_ART =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

async function main(): Promise<void> {
  process.env.HEARTH_MEDIA_ARCHIVE = '1';

  // Regression guard: archive_url MUST be registered in Kate's tool PACK
  // (index.ts). The loader loads a pack dir's create() list, NOT sibling files,
  // so a tool file alone never registers (the box-boot lesson). This smoke
  // imports make_archive_url directly, so only a source check catches the gap.
  const kate_index = readFileSync(
    resolve(import.meta.dir, '../src/specialists/kate/tools/index.ts'),
    'utf8',
  );
  check(
    'archive_url is wired into Kate tool pack index.ts',
    /from '\.\/archive_url'/.test(kate_index) && /create_archive_url\(deps\)/.test(kate_index),
  );
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-media-'));
  const vault = join(tmp, 'vault');
  const archive_root = join(tmp, 'archive');
  mkdirSync(vault, { recursive: true });
  mkdirSync(archive_root, { recursive: true });
  const db = open_db(join(tmp, 'hearth.db'));
  const memory = new MemoryClient({ vault_root: vault, db });

  // ── seams (no network / yt-dlp / ffmpeg / nas) ───────────────────────────
  // The PROBE phase mines chapters when the source ships none — seam it, or a
  // fixture whose duration crosses the mining floor would shell out to yt-dlp.
  _test_set_comment_transport(async () => [
    { id: 'noise', text: 'first', like_count: 5000, author: '@hype' },
    {
      id: 'setlist',
      text: '0:59 HOW 2 GET AWAY WITH MURDER\n4:17 FEAR OF HEIGHTS\n7:38 Supermodels\n11:01 Drive Myself Home\n15:26 SUPERMAN\n20:37 2005\n24:45 stone cold summer',
      like_count: 101,
      author: '@chandraabudiman',
    },
  ]);
  _test_set_probe_transport(async (url): Promise<MediaProbeResult> => {
    if (url.includes('fail')) {
      return { source: 'yt-dlp', ok: false, error: 'Unsupported URL', extra: {} };
    }
    if (url.includes('gallery')) {
      return {
        source: 'gallery-dl',
        ok: true,
        extractor: 'reddit',
        id: 'g1',
        webpage_url: url,
        title: 'Test Gallery',
        uploader: 'Test User',
        image_count: 3,
        images: [{ idx: 0 }, { idx: 1 }, { idx: 2 }],
        extra: {},
      };
    }
    if (url.includes('generic')) {
      // A generic / HTML5-embed extractor: yt-dlp emits `vcodec: null` (which the
      // probe's `str()` narrowing drops) on a format that IS video, so
      // `is_audio_only` derives TRUE for a real video. This fixture carries that
      // WRONG flag on purpose — it is the exact shape of the row that leaked on
      // 2026-07-15 (extractor 'html5', formats [{format_id:'0', ext:'mp4'}],
      // is_audio_only:1, thumbnail present). The pre-gate must classify the
      // thumbnail anyway and cordon on what the classifier actually says.
      return {
        source: 'yt-dlp',
        ok: true,
        extractor: 'html5',
        id: 'gen',
        webpage_url: url,
        title: 'Generic Embed Clip',
        duration_s: 300,
        thumbnail: COVER_ART,
        is_audio_only: true,
        formats: [{ format_id: '0', ext: 'mp4' }],
        extra: {},
      };
    }
    if (url.includes('flip')) {
      // A video WITH a thumbnail, for the 'flip' classifier mode: the pre-gate
      // reads that thumbnail SFW (call 1) and files the download in the open
      // tree; the keyframes then read NSFW (call 2+). The filing phase must fold
      // the files under Private/ — the deviation-retirement case.
      return {
        source: 'yt-dlp',
        ok: true,
        extractor: 'youtube',
        id: 'flip',
        webpage_url: url,
        title: 'Innocent Thumbnail Clip',
        channel: 'Test Artist',
        uploader: 'Test Artist',
        upload_date: '20260518',
        duration_s: 200,
        thumbnail: COVER_ART,
        is_audio_only: false,
        formats: [{ format_id: '137', vcodec: 'avc1', acodec: 'none', height: 1080, width: 1920 }],
        extra: {},
      };
    }
    const audio = url.includes('audio');
    // Real music carries cover art, so the audio fixture does too — and that
    // classified thumbnail is the ONLY thing allowed to assert `sfw`. Two
    // deliberate exceptions: the VIDEO fixture has no thumbnail (keeping case 3
    // honest — an unclassifiable pre-gate overridden by a confident SFW keyframe
    // read), and `audio-nocover` has none either, which is how case 3e proves an
    // item with nothing to classify fails CLOSED instead of being waved through.
    const cover = audio && !url.includes('nocover');
    // A long set with NO official chapters — the shape the chapter miner exists
    // for (the setlist only lives in a top comment).
    const longset = url.includes('longset');
    return {
      source: 'yt-dlp',
      ok: true,
      extractor: 'youtube',
      id: 'vid',
      webpage_url: url,
      title: 'Test Song',
      channel: 'Test Artist',
      uploader: 'Test Artist',
      upload_date: '20260518',
      duration_s: longset ? 1698 : 200,
      view_count: 1000,
      like_count: 50,
      tags: ['synthwave'],
      description: 'a test clip about the archive pipeline',
      is_audio_only: audio,
      ...(cover ? { thumbnail: COVER_ART } : {}),
      formats: audio
        ? [{ format_id: '140', vcodec: 'none', acodec: 'mp4a' }]
        : [{ format_id: '137', vcodec: 'avc1', acodec: 'none', height: 1080, width: 1920 }],
      extra: {},
    };
  });
  _test_set_nsfw_transport(async () => {
    nsfw_calls += 1;
    if (nsfw_mode === 'uncertain') return { available: true, classes: UNCERTAIN_CLASSES };
    const explicit = nsfw_mode === 'nsfw' || (nsfw_mode === 'flip' && nsfw_calls > 1);
    return { available: true, classes: explicit ? NSFW_CLASSES : SFW_CLASSES };
  });
  // VL review + metadata judge seams. Default = UNAVAILABLE, so every case not
  // explicitly about the review layer exercises the sidecar-verdict-stands path
  // (the exact pre-review pipeline) — including its fail-closed uncertain.
  // A case that wants the review sets `review_mode` to a rating.
  let review_mode: MediaContentRating | null = null;
  let judge_mode: MediaContentRating | null = null;
  const scripted = (rating: MediaContentRating | null, source: 'vl' | 'metadata', frames: number): Promise<MediaReviewResult> =>
    Promise.resolve(
      rating === null
        ? { available: false, error: 'seam: review off' }
        : {
            available: true,
            review: {
              rating,
              frames_reviewed: frames,
              summary: `seam: a ${rating} scene`,
              source,
              at: '2026-08-10T00:00:00.000Z',
            },
          },
    );
  _test_set_review_transport(async (frames) => scripted(review_mode, 'vl', frames.length));
  _test_set_metadata_judge_transport(async () => scripted(judge_mode, 'metadata', 0));
  _test_set_download_transport(async (args) => {
    // Mirror the real `download_media` stem — `<title> [<id>]`, or the bare id when
    // there is no title — so every downstream phase in this smoke (the note, the
    // projection, the serve routes) sees the shape the writer actually produces.
    // Fixture BYTES land on disk too: the filing phase's final-verdict fold
    // physically moves an item's files, so a download that only returned paths
    // would make every fold look like the nothing-to-re-shelve degrade.
    const stem = media_canonical_stem(args.id, args.title);
    const land = (rel: string): void => {
      const abs = join(args.archive_root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, 'fixture-bytes');
    };
    if (args.source === 'gallery-dl') {
      // gallery: nas_path is the DIRECTORY; images[] carries the on-disk names.
      const dir = `${args.folder_segments.join('/')}/${stem}`;
      for (const f of ['001.jpg', '002.jpg', '003.jpg']) land(`${dir}/${f}`);
      return {
        nas_path: dir,
        container: 'gallery',
        image_count: 3,
        images: [
          { idx: 0, file: '001.jpg' },
          { idx: 1, file: '002.jpg' },
          { idx: 2, file: '003.jpg' },
        ],
        thumbnail_path: `${dir}/001.jpg`,
      };
    }
    const ext = args.quality.audio_only ? 'm4a' : 'mp4';
    const nas_path = `${args.folder_segments.join('/')}/${stem}.${ext}`;
    land(nas_path);
    return {
      nas_path,
      container: ext,
      acodec: 'mp4a.40.2',
      duration_s: 200,
      filesize: 50_000_000,
      ...(args.quality.audio_only ? {} : { vcodec: 'hvc1', width: 1920, height: 1080, resolution_label: '1080p' }),
    };
  });
  _test_set_keyframe_sampler(async () => [new Uint8Array([1, 2, 3])]);
  // gallery NSFW read: return N fixture image bytes → classified via the nsfw seam.
  _test_set_gallery_sampler(async () => [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]);

  // scripted planner LLM — returns a fixed category JSON (the leaf prepends
  // 'Private' for a non-sfw pre-verdict on its own).
  const mock_llm = {
    for_role: () => ({
      provider: {
        complete: async () => ({
          content: JSON.stringify({
            media_kind: 'music_video',
            genre: 'synthwave',
            creator: 'Test Artist',
            title_clean: 'Test Song',
            folder_segments: ['Music', 'Test Artist', '2026'],
            confidence: 0.9,
            rationale: 'test',
          }),
        }),
      },
      defaults: {},
    }),
  } as unknown as LLMRouter;

  const inbox_calls: unknown[] = [];
  const events: AppEvent[] = [];
  const spy_inbox = {
    push: (m: unknown) => {
      inbox_calls.push(m);
      return `inbox_${inbox_calls.length}`;
    },
  } as unknown as SpecialistInbox;
  const spy_events = { emit: (e: AppEvent) => void events.push(e) } as unknown as AppEventBus;

  const deps: MediaArchiveRunnerDeps = {
    memory,
    llm: mock_llm,
    db,
    vault_root: vault,
    archive_root,
    inbox: spy_inbox,
    events: spy_events,
  };

  async function run_job(
    url: string,
    opts: { audio_only?: boolean; requested_by?: string } = {},
  ): Promise<MediaJobRow> {
    const rb = opts.requested_by ?? 'jasper';
    const row = memory.media_jobs.create({
      url,
      requested_by: rb,
      private_to: rb,
      audio_only: opts.audio_only ?? false,
    });
    for (let i = 0; i < 12; i++) {
      const res = await advance(deps, row.id, 'kate');
      if (!OPEN_MEDIA_JOB_STATUSES.includes(res.status as MediaJobStatus)) break;
      if (!res.progressed) break;
    }
    const done = memory.media_jobs.get(row.id);
    if (!done) throw new Error('job vanished');
    return done;
  }

  const archived_event = (job: MediaJobRow) =>
    events.find((e) => e.type === 'media_archived' && e.media_item_id === job.media_item_id) as
      | Extract<AppEvent, { type: 'media_archived' }>
      | undefined;

  // ── 1. audio SFW → the requester (from CLASSIFIED cover art, not a guess) ─
  nsfw_mode = 'sfw';
  const audio_job = await run_job('https://x/audio-song', { audio_only: true });
  check('audio job reaches done', audio_job.status === 'done');
  check('audio job has a note_path + media id', !!audio_job.note_path && !!audio_job.media_item_id);
  check('audio job fired a media_archived event', events.some((e) => e.type === 'media_archived'));
  check('audio job pushed an inbox FYI', inbox_calls.length === 1);
  const audio_nsfw = audio_job.nsfw as NsfwAggregate;
  check(
    'audio sfw verdict came from an ACTUAL classification (frames_scored > 0)',
    audio_nsfw.verdict === 'sfw' && audio_nsfw.frames_scored > 0,
  );
  check('classified-sfw audio still silos to the requester', archived_event(audio_job)?.private_to === 'jasper');

  // ── 2. video NSFW → owner-only ───────────────────────────────────────────
  nsfw_mode = 'nsfw';
  const nsfw_job = await run_job('https://x/video-porn');
  check('nsfw job reaches done', nsfw_job.status === 'done');
  const nsfw_event = events.find(
    (e) => e.type === 'media_archived' && e.media_item_id === nsfw_job.media_item_id,
  ) as Extract<AppEvent, { type: 'media_archived' }> | undefined;
  check('nsfw event carries nsfw:true', nsfw_event?.nsfw === true);
  check('nsfw event cordons private_to the owner', nsfw_event?.private_to === 'jasper');

  // ── 3. video SFW → the requester (keyframes override the uncertain thumbnail)
  nsfw_mode = 'sfw';
  const clean_job = await run_job('https://x/video-clean');
  check('clean video job reaches done', clean_job.status === 'done');
  const clean_event = events.find(
    (e) => e.type === 'media_archived' && e.media_item_id === clean_job.media_item_id,
  ) as Extract<AppEvent, { type: 'media_archived' }> | undefined;
  check('clean video silos to the requester (keyframe SFW beats uncertain pre)', clean_event?.private_to === 'jasper');
  check('clean video event nsfw:false', clean_event?.nsfw === false);

  // ── 3a. a long set with no official chapters → mined from the top comment ─
  nsfw_mode = 'sfw';
  const set_job = await run_job('https://x/video-longset');
  check('longset job reaches done', set_job.status === 'done');
  const set_fm = (set_job.note_path ? memory.read_note(set_job.note_path)?.frontmatter : undefined) as
    | { chapters?: unknown[]; chapter_source?: { from?: string; like_count?: number; author?: string } }
    | undefined;
  check('runner mined chapters onto the note (7 songs)', set_fm?.chapters?.length === 7);
  check('chapter_source credits the comment, not the uploader', set_fm?.chapter_source?.from === 'comment');
  check('chapter_source keeps the corroborating thumbs-up', set_fm?.chapter_source?.like_count === 101);
  const short_fm = (clean_job.note_path ? memory.read_note(clean_job.note_path)?.frontmatter : undefined) as
    | { chapters?: unknown[] }
    | undefined;
  check('a 200s clip is under the mining floor → no chapters', short_fm?.chapters === undefined);

  // ── 3b. friend-tier: a friend's item silos to the FRIEND, not the owner ───
  nsfw_mode = 'sfw';
  const friend_job = await run_job('https://x/friend-clip', { requested_by: 'kim' });
  check('friend job reaches done', friend_job.status === 'done');
  const friend_event = events.find(
    (e) => e.type === 'media_archived' && e.media_item_id === friend_job.media_item_id,
  ) as Extract<AppEvent, { type: 'media_archived' }> | undefined;
  check('friend SFW item silos private_to the friend, not the owner', friend_event?.private_to === 'kim');

  // ── 3c. image gallery: SFW → requester; any explicit image → owner-only ──
  nsfw_mode = 'sfw';
  const gallery_job = await run_job('https://x/gallery-clean');
  check('gallery job reaches done', gallery_job.status === 'done');
  const gallery_event = events.find(
    (e) => e.type === 'media_archived' && e.media_item_id === gallery_job.media_item_id,
  ) as Extract<AppEvent, { type: 'media_archived' }> | undefined;
  check('sfw gallery silos to the requester', gallery_event?.private_to === 'jasper');
  check('sfw gallery event nsfw:false', gallery_event?.nsfw === false);

  nsfw_mode = 'nsfw';
  const nsfw_gallery_job = await run_job('https://x/gallery-explicit');
  check('nsfw gallery reaches done', nsfw_gallery_job.status === 'done');
  const nsfw_gallery_event = events.find(
    (e) => e.type === 'media_archived' && e.media_item_id === nsfw_gallery_job.media_item_id,
  ) as Extract<AppEvent, { type: 'media_archived' }> | undefined;
  check('nsfw gallery cordons owner-only (any explicit image)', nsfw_gallery_event?.private_to === 'jasper');

  // ── 3d. REGRESSION (the 2026-07-15 fail-open) ────────────────────────────
  // A generic-extractor item whose formats omit `vcodec` LOOKS audio-only to the
  // probe, but it's a real video and its thumbnail is explicit. The pre-gate must
  // classify that thumbnail regardless of the audio_only flag. Pre-fix this path
  // returned a fabricated `{verdict:'sfw', frames_scored:0}` from zero evidence
  // and filed the item household-visible.
  nsfw_mode = 'nsfw';
  const generic_job = await run_job('https://x/generic-embed-explicit');
  check('generic-extractor job reaches done', generic_job.status === 'done');
  const generic_nsfw = generic_job.nsfw as NsfwAggregate;
  check(
    'a mislabelled-audio_only item is CLASSIFIED, never waived (frames_scored > 0)',
    generic_nsfw.frames_scored > 0,
  );
  check('its explicit thumbnail reads nsfw', generic_nsfw.verdict === 'nsfw');
  check(
    'mislabelled-audio_only explicit item cordons the OWNER, not household',
    archived_event(generic_job)?.private_to === 'jasper',
  );
  check('mislabelled-audio_only explicit item event carries nsfw:true', archived_event(generic_job)?.nsfw === true);

  // ── 3e. the other half of the invariant: nothing to classify → fail CLOSED ─
  // A genuine audio item with no cover art has no visual artifact at all. That is
  // `uncertain` (→ the requester's own scope), never a safe-by-default `sfw`.
  nsfw_mode = 'sfw';
  const bare_job = await run_job('https://x/audio-nocover', { audio_only: true });
  check('cover-art-less audio job reaches done', bare_job.status === 'done');
  const bare_nsfw = bare_job.nsfw as NsfwAggregate;
  check(
    'nothing to classify → uncertain with 0 frames, never a fabricated sfw',
    bare_nsfw.verdict === 'uncertain' && bare_nsfw.frames_scored === 0,
  );
  check(
    'an unclassifiable item fails CLOSED to the requester (not household)',
    archived_event(bare_job)?.private_to === 'jasper',
  );

  // ── 3f. folder ← FINAL verdict (the retired deviation) ───────────────────
  // Thumbnail reads SFW → the download lands in the open tree; keyframes read
  // NSFW → the filing phase must FOLD the files under Private/ before the note
  // freezes any path. Pre-fix, this item shipped `nsfw: true` over bytes sitting
  // outside Private/ forever (the mi_nxphtmm4 shape).
  nsfw_mode = 'flip';
  nsfw_calls = 0;
  const flip_job = await run_job('https://x/video-flip');
  check('flip job reaches done', flip_job.status === 'done');
  const flip_nsfw = flip_job.nsfw as NsfwAggregate;
  check('flip final verdict is nsfw (keyframes beat the innocent thumbnail)', flip_nsfw.verdict === 'nsfw');
  check('flip event carries nsfw:true', archived_event(flip_job)?.nsfw === true);
  const flip_fm = (flip_job.note_path ? memory.read_note(flip_job.note_path)?.frontmatter : undefined) as
    | { nas_path?: string }
    | undefined;
  check('flip note nas_path is under Private/', typeof flip_fm?.nas_path === 'string' && flip_fm.nas_path.startsWith('Private/'));
  const flip_private_abs = join(archive_root, flip_fm?.nas_path ?? '');
  const flip_open_rel = (flip_fm?.nas_path ?? '').replace(/^Private\//, '');
  check('flip file physically moved under Private/', existsSync(flip_private_abs));
  // (No prune assertion: other fixture items legitimately share the open-tree
  // dir, so it stays. Prune-on-emptied is pinned by smoke:media-taxonomy.)
  check('…and the open-tree copy is gone', !existsSync(join(archive_root, flip_open_rel)));
  // Resume-after-crash shape: the bytes already moved but the job row still holds
  // the open-tree path. The fold must ADOPT (paths rewritten, zero moves).
  const adopt = apply_final_cordon({
    archive_root,
    id: flip_job.media_item_id!,
    title: 'Innocent Thumbnail Clip',
    download: { nas_path: flip_open_rel, container: 'mp4' },
    is_nsfw: true,
  });
  check('crash-resume fold adopts the moved files (aligned, zero moves)', adopt.aligned && adopt.moved === 0);
  check('…and repoints nas_path at the Private/ copy', adopt.download.nas_path === flip_fm?.nas_path);

  // ── 3g. the VL review CLEARS an uncertain item → open tree (no auto-private)
  // The 2026-08-10 owner directive case: sidecar lands in its uncertain band
  // (suggestive-ish score), which used to mean Private/ forever. The VL looks at
  // the frames, rates them safe → the item files sfw, in the OPEN tree, with
  // review provenance on the note.
  nsfw_mode = 'uncertain';
  review_mode = 'safe';
  const cleared_job = await run_job('https://x/video-cleared');
  review_mode = null;
  check('review-cleared job reaches done', cleared_job.status === 'done');
  const cleared_agg = cleared_job.nsfw as NsfwAggregate;
  check('VL safe verdict replaces the sidecar uncertain', cleared_agg.verdict === 'sfw');
  check('…with review provenance on the aggregate', cleared_agg.review?.source === 'vl' && (cleared_agg.review?.frames_reviewed ?? 0) > 0);
  check('review-cleared event carries nsfw:false', archived_event(cleared_job)?.nsfw === false);
  const cleared_fm = (cleared_job.note_path ? memory.read_note(cleared_job.note_path)?.frontmatter : undefined) as
    | { nas_path?: string; content_rating?: string; review?: { source?: string } }
    | undefined;
  check('review-cleared item is NOT under Private/ (unfolded)', typeof cleared_fm?.nas_path === 'string' && !cleared_fm.nas_path.startsWith('Private/'));
  check('…and its bytes are really in the open tree', existsSync(join(archive_root, cleared_fm?.nas_path ?? '')));
  check('note records content_rating: safe + review provenance', cleared_fm?.content_rating === 'safe' && cleared_fm?.review?.source === 'vl');

  // ── 3h. the VL review CATCHES what the sidecar waved through ─────────────
  // Confident-sfw sidecar over frames the VL rates explicit → the review wins
  // in the explicit direction too, and the item folds under Private/.
  nsfw_mode = 'sfw';
  review_mode = 'explicit';
  const caught_job = await run_job('https://x/video-caught');
  review_mode = null;
  check('review-caught job reaches done', caught_job.status === 'done');
  check('VL explicit verdict replaces the sidecar sfw', (caught_job.nsfw as NsfwAggregate).verdict === 'nsfw');
  check('review-caught event carries nsfw:true', archived_event(caught_job)?.nsfw === true);
  const caught_fm = (caught_job.note_path ? memory.read_note(caught_job.note_path)?.frontmatter : undefined) as
    | { nas_path?: string; content_rating?: string }
    | undefined;
  check('review-caught item folded under Private/', typeof caught_fm?.nas_path === 'string' && caught_fm.nas_path.startsWith('Private/'));
  check('note records content_rating: explicit', caught_fm?.content_rating === 'explicit');

  // ── 3i. suggestive is nsfw for the shelf, and keeps its own rating ───────
  nsfw_mode = 'sfw';
  review_mode = 'suggestive';
  const sugg_job = await run_job('https://x/video-thirsttrap');
  review_mode = null;
  check('suggestive rating flags nsfw (owner shelves thirst-traps private)', archived_event(sugg_job)?.nsfw === true);
  const sugg_fm = (sugg_job.note_path ? memory.read_note(sugg_job.note_path)?.frontmatter : undefined) as
    | { content_rating?: string }
    | undefined;
  check('…while the note keeps the finer rating: suggestive', sugg_fm?.content_rating === 'suggestive');

  // ── 3j. a bare audio rip gets a metadata judgment, not auto-Private ──────
  // Same no-visual shape as 3e — but with the judge reachable, a plain music
  // rip files sfw in the open tree, provenance source:'metadata'. (3e above
  // stays the judge-down control: fail-closed uncertain, exactly as before.)
  nsfw_mode = 'sfw';
  judge_mode = 'safe';
  const judged_job = await run_job('https://x/audio-nocover-judged', { audio_only: true });
  judge_mode = null;
  check('judged bare-audio job reaches done', judged_job.status === 'done');
  const judged_agg = judged_job.nsfw as NsfwAggregate;
  check('metadata judge verdict is sfw with metadata provenance', judged_agg.verdict === 'sfw' && judged_agg.review?.source === 'metadata');
  check('judged bare-audio event carries nsfw:false', archived_event(judged_job)?.nsfw === false);
  const judged_fm = (judged_job.note_path ? memory.read_note(judged_job.note_path)?.frontmatter : undefined) as
    | { nas_path?: string }
    | undefined;
  check('judged bare-audio filed in the OPEN tree', typeof judged_fm?.nas_path === 'string' && !judged_fm.nas_path.startsWith('Private/'));

  // ── 4. project + cordon matrix ───────────────────────────────────────────
  await rebuild(vault, memory, db);
  const owner_items = memory.query_media_items({ caller: OWNER });
  const member_items = memory.query_media_items({ caller: HOUSEHOLD });
  const owner_ids = new Set(owner_items.map((r) => r.id));
  const member_ids = new Set(member_items.map((r) => r.id));

  check('owner sees the SFW audio item', owner_ids.has(audio_job.media_item_id!));
  check('owner sees the NSFW item', owner_ids.has(nsfw_job.media_item_id!));
  check('member does NOT see the NSFW item (owner-only cordon)', !member_ids.has(nsfw_job.media_item_id!));

  // The owner directive, stated as behaviour: a household member sees NOTHING
  // another user archived, however innocuous the classifier judged it. These
  // two assertions were the inverse before 2026-07-29 — SFW items were
  // household-searchable, which is what put a mis-classified explicit item in
  // front of every member. Keeping them inverted is what stops that class of
  // exposure from depending on the classifier being right.
  check(
    'member does NOT see the SFW audio item (siloed to its requester)',
    !member_ids.has(audio_job.media_item_id!),
  );
  check(
    'member does NOT see the clean SFW video (siloed to its requester)',
    !member_ids.has(clean_job.media_item_id!),
  );
  const friend_items = memory.query_media_items({ caller: FRIEND });
  check('friend sees their own siloed item', friend_items.some((r) => r.id === friend_job.media_item_id));
  check('household member does NOT see the friend’s item', !member_ids.has(friend_job.media_item_id!));
  check('owner does NOT see the friend’s siloed item (no god-view)', !owner_ids.has(friend_job.media_item_id!));

  const audio_row = owner_items.find((r) => r.id === audio_job.media_item_id)!;
  check('projection kept the measured creator', audio_row.creator === 'Test Artist');
  check('projection kept media_kind', audio_row.media_kind === 'music_video');
  check('projection kept duration', audio_row.duration_s === 200);
  check('audio item nsfw flag is 0 (because the classifier said so)', audio_row.nsfw === 0);
  const nsfw_row = owner_items.find((r) => r.id === nsfw_job.media_item_id)!;
  check('nsfw item nsfw flag is 1', nsfw_row.nsfw === 1);
  const generic_row = owner_items.find((r) => r.id === generic_job.media_item_id)!;
  check('mislabelled-audio_only explicit item projects nsfw=1', generic_row.nsfw === 1);
  check(
    'member does NOT see the mislabelled-audio_only explicit item',
    !member_ids.has(generic_job.media_item_id!),
  );
  check('member does NOT see the unclassifiable item', !member_ids.has(bare_job.media_item_id!));

  // ── the `nsfw` flag agrees on every surface it lands on ──────────────────
  // Three projections of ONE verdict: the SSE event, the note's frontmatter, and
  // the row the ingestor projects from it (the `Private/` folder is the fourth,
  // via the same predicate). They must never be able to disagree about the same
  // item — the retired `force_owner_only` slot OR-ed itself into the EVENT alone,
  // so an item could ship `nsfw: true` on the wire over a note and a row that both
  // said `false`. `nsfw_flag_for` is the single derivation that makes that
  // unrepresentable.
  const flag_agrees = (job: MediaJobRow, label: string): void => {
    const row = owner_items.find((r) => r.id === job.media_item_id);
    const fm = row ? (JSON.parse(row.frontmatter_json) as { nsfw?: unknown }) : undefined;
    const ev = archived_event(job);
    check(
      `${label}: event, note frontmatter and projected row agree on nsfw`,
      !!row && !!ev && !!fm && ev.nsfw === (fm.nsfw === true) && ev.nsfw === (row.nsfw === 1),
    );
  };
  flag_agrees(audio_job, 'classified-SFW audio');
  flag_agrees(nsfw_job, 'explicit video');
  flag_agrees(bare_job, 'unclassifiable item');

  // gallery projection: media_kind forced to image_gallery (measured, not the
  // model's label), images[] + image_count ride the frontmatter passthrough.
  const gallery_row = owner_items.find((r) => r.id === gallery_job.media_item_id)!;
  check('gallery projected media_kind=image_gallery', gallery_row.media_kind === 'image_gallery');
  check(
    'member does NOT see the SFW gallery (siloed to its requester)',
    !member_ids.has(gallery_job.media_item_id!),
  );
  check('member does NOT see the NSFW gallery', !member_ids.has(nsfw_gallery_job.media_item_id!));
  const gfm = JSON.parse(gallery_row.frontmatter_json) as { images?: unknown[]; image_count?: number };
  check('gallery frontmatter carries the 3-image list', Array.isArray(gfm.images) && gfm.images.length === 3);
  check('gallery frontmatter carries image_count=3', gfm.image_count === 3);

  // FTS indexed → the context .md body is searchable
  const fts = db
    .prepare('SELECT count(*) AS c FROM chunks_fts WHERE note_path = @p')
    .get({ '@p': audio_job.note_path }) as { c: number };
  check('context .md was chunk-indexed', fts.c > 0);

  // get_media_item cordon (404-shape): member can't fetch the NSFW item
  check('get_media_item cordons the NSFW item from a member', memory.get_media_item(nsfw_job.media_item_id!, HOUSEHOLD) === null);
  check('get_media_item returns the NSFW item to the owner', memory.get_media_item(nsfw_job.media_item_id!, OWNER) !== null);

  // ── 4b. rescan_media_metadata facet:'nsfw' — the REMEDIATION sweep ────────
  // Hand-craft rows in the shapes the old policy actually left on disk. Each is an
  // archive job + the projected household-visible note the ingestor made from it.
  mkdirSync(resolve(archive_root, 'Video/Legacy'), { recursive: true });
  const seed_legacy = (opts: {
    id: string;
    name: string;
    /** the job's recorded verdict — frames_scored 0 is the "never classified" proof */
    frames_scored: number;
    /** false = the note points at a thumbnail that isn't on disk */
    thumb_on_disk: boolean;
  }): MediaJobRow => {
    const note_path = `MediaArchive/2026-07-15-${opts.id}.md`;
    const thumb_rel = `Video/Legacy/${opts.id}.png`;
    if (opts.thumb_on_disk) {
      writeFileSync(resolve(archive_root, thumb_rel), Buffer.from([137, 80, 78, 71]));
    }
    const job = memory.media_jobs.create({
      url: `https://x/legacy-${opts.id}`,
      requested_by: 'jasper',
      private_to: 'jasper',
    });
    memory.media_jobs.update(job.id, {
      status: 'done',
      media_item_id: opts.id,
      note_path,
      nsfw: {
        verdict: 'sfw',
        score: 0,
        frames_scored: opts.frames_scored,
        reason: opts.frames_scored === 0 ? 'audio-only (no visual content)' : 'max_frame_score=0.020',
      },
    });
    memory.upsert_note(
      note_path,
      {
        type: 'media_item',
        id: opts.id,
        name: opts.name,
        media_kind: 'clip',
        nsfw: false,
        duration_s: 120,
        container: 'mp4',
        nas_path: `Video/Legacy/${opts.id}.mp4`,
        thumbnail_path: thumb_rel,
        archived_at: '2026-07-15T00:00:00Z',
        private_to: 'household', // ← what the retired policy wrote for a SFW item
        tags: [],
      },
      '## Summary\n\nA clip filed under the pre-2026-07-29 policy.',
    );
    return memory.media_jobs.get(job.id)!;
  };

  // (i) the fail-open leak: a verdict recorded with frames_scored:0.
  const LEGACY_ID = 'mi_legacy1';
  const legacy_job = seed_legacy({
    id: LEGACY_ID,
    name: 'Mislabelled Legacy Clip',
    frames_scored: 0,
    thumb_on_disk: true,
  });
  void legacy_job;
  // (ii) THE CASE THE SWEEP USED TO MISS ENTIRELY: honestly classified (frames
  // were really scored), verdict really `sfw` — and therefore filed `household` by
  // the retired cordon. `frames_scored: 0` targeting never sees it, so before this
  // fix the remediation tool left the archive half on the policy the runner had
  // just abandoned. It must be re-filed onto its requester.
  const HONEST_ID = 'mi_legacy2';
  seed_legacy({ id: HONEST_ID, name: 'Honestly Clean Legacy Clip', frames_scored: 1, thumb_on_disk: true });
  // (iii) household-scoped AND unreadable: the note names a thumbnail that isn't on
  // disk. The cordon repair must not depend on the classification succeeding —
  // coupling them left exactly the rows most likely to be wrong un-repaired.
  const NOTHUMB_ID = 'mi_legacy3';
  seed_legacy({ id: NOTHUMB_ID, name: 'Unreadable Legacy Clip', frames_scored: 1, thumb_on_disk: false });

  await rebuild(vault, memory, db);
  check('legacy leak starts household-visible (the pre-fix state)', memory.get_media_item(LEGACY_ID, HOUSEHOLD) !== null);
  check(
    'the honestly-classified SFW legacy row is household-visible too (off the new policy)',
    memory.get_media_item(HONEST_ID, HOUSEHOLD) !== null,
  );
  check(
    'the thumbnail-less legacy row is household-visible too',
    memory.get_media_item(NOTHUMB_ID, HOUSEHOLD) !== null,
  );

  nsfw_mode = 'nsfw';
  const rescan = make_rescan_media_metadata(archive_root);
  const rescan_ctx = {
    memory,
    llm: mock_llm,
    now: new Date(),
    intent_id: 'nsfw-rescan',
    user: { id: 'jasper', tier: 'owner' as const },
  } as unknown as ToolContext;
  const swept = await rescan.execute(rescan.input_schema.parse({ facet: 'nsfw' }), rescan_ctx);
  const legacy_res = swept.reclassified?.find((r) => r.item_id === LEGACY_ID);
  check('facet:nsfw targets the never-classified row', !!legacy_res);
  check(
    'facet:nsfw re-classified it explicit off the ON-DISK thumbnail',
    legacy_res?.verdict === 'nsfw' && legacy_res?.frames_scored === 1,
  );
  check(
    'facet:nsfw tightened the cordon to the owner',
    legacy_res?.private_to === 'jasper' && legacy_res?.cordon_tightened === true,
  );
  // The cover-art-less item (case 3e) is also never-classified, but it has nothing
  // on disk to look at — the sweep must say so and leave it exactly as it was.
  const bare_res = swept.reclassified?.find((r) => r.item_id === bare_job.media_item_id);
  check(
    'facet:nsfw reports an item with no on-disk thumbnail honestly, unchanged',
    !!bare_res && bare_res.cordon_tightened === false && /no thumbnail/i.test(bare_res.note ?? ''),
  );

  // The two cordon-only repairs. Neither is reachable from `frames_scored: 0`.
  const honest_res = swept.reclassified?.find((r) => r.item_id === HONEST_ID);
  check(
    'facet:nsfw ALSO targets an honestly-classified row that is merely off-policy',
    !!honest_res,
  );
  check(
    'it re-files that row onto its requester and says the cordon moved',
    honest_res?.private_to === 'jasper' && honest_res?.cordon_tightened === true,
  );
  const nothumb_res = swept.reclassified?.find((r) => r.item_id === NOTHUMB_ID);
  check(
    'an unreadable thumbnail does NOT block the cordon repair',
    nothumb_res?.private_to === 'jasper' && nothumb_res?.cordon_tightened === true,
  );
  check(
    'and it reports the classification failure honestly rather than a verdict',
    !!nothumb_res && nothumb_res.verdict === 'uncertain' && /unreadable/i.test(nothumb_res.note ?? ''),
  );

  await rebuild(vault, memory, db);
  check('remediated item is no longer household-visible', memory.get_media_item(LEGACY_ID, HOUSEHOLD) === null);
  check('remediated item projects nsfw=1', memory.get_media_item(LEGACY_ID, OWNER)?.nsfw === 1);
  check(
    'the off-policy SFW row is no longer household-visible either',
    memory.get_media_item(HONEST_ID, HOUSEHOLD) === null && memory.get_media_item(HONEST_ID, OWNER) !== null,
  );
  check(
    'the unreadable row was re-filed too, and kept its old nsfw flag (no verdict invented)',
    memory.get_media_item(NOTHUMB_ID, HOUSEHOLD) === null &&
      memory.get_media_item(NOTHUMB_ID, OWNER)?.nsfw === 0,
  );
  const swept_again = await rescan.execute(rescan.input_schema.parse({ facet: 'nsfw' }), rescan_ctx);
  check(
    'facet:nsfw drained the remediated row (idempotent)',
    !swept_again.reclassified?.some((r) => r.item_id === LEGACY_ID),
  );
  check(
    'and drained the two cordon-only repairs (both now on-policy)',
    !swept_again.reclassified?.some((r) => r.item_id === HONEST_ID || r.item_id === NOTHUMB_ID),
  );
  // Friend tier is refused outright — a mass private_to mutation is not friend work.
  let friend_refused = '';
  try {
    await rescan.execute(rescan.input_schema.parse({ facet: 'nsfw' }), {
      ...(rescan_ctx as unknown as Record<string, unknown>),
      user: { id: 'kim', tier: 'friend' },
    } as unknown as ToolContext);
  } catch (err) {
    friend_refused = (err as Error).message;
  }
  check('facet:nsfw refuses a friend-tier caller', /TIER_FORBIDDEN/.test(friend_refused));
  const member_sweep = await rescan.execute(rescan.input_schema.parse({ facet: 'nsfw' }), {
    ...(rescan_ctx as unknown as Record<string, unknown>),
    user: { id: 'sam', tier: 'household' },
  } as unknown as ToolContext);
  // A member passes the gate (they must be able to re-file their OWN legacy rows)
  // but the cordon still bounds what they can reach — nothing of Jasper's is left
  // household-visible for them to touch by this point.
  check('a household-tier caller passes the gate', member_sweep.facet === 'nsfw');
  check(
    'but sees nothing of another user’s to re-file',
    (member_sweep.reclassified ?? []).length === 0,
  );

  // ── the auto-private DRAIN pipeline (owner 2026-08-10), end to end ────────
  // The bare-audio item (3e) sits fail-closed: uncertain verdict, Private/
  // shelf, no review. facet:'nsfw' with the judge reachable re-judges it safe
  // (metadata provenance) → facet:'taxonomy' is then licensed to move the bytes
  // OUT of Private/. Two facets, one drain.
  judge_mode = 'safe';
  const drained = await rescan.execute(
    rescan.input_schema.parse({ facet: 'nsfw', item: bare_job.media_item_id }),
    rescan_ctx,
  );
  judge_mode = null;
  const drained_res = drained.reclassified?.find((r) => r.item_id === bare_job.media_item_id);
  check(
    'the judge re-verdicts the fail-closed audio rip safe, provenance recorded',
    drained_res?.verdict === 'sfw' && drained_res?.rating === 'safe',
  );
  const bare_fm_after = (bare_job.note_path ? memory.read_note(bare_job.note_path)?.frontmatter : undefined) as
    | { nsfw?: boolean; content_rating?: string; review?: { source?: string }; nas_path?: string }
    | undefined;
  check(
    'the note now says nsfw:false + content_rating safe + metadata provenance',
    bare_fm_after?.nsfw === false && bare_fm_after?.content_rating === 'safe' && bare_fm_after?.review?.source === 'metadata',
  );
  check(
    '…while the bytes still sit under Private/ (the nsfw facet moves no files)',
    typeof bare_fm_after?.nas_path === 'string' && bare_fm_after.nas_path.startsWith('Private/'),
  );
  await rebuild(vault, memory, db);
  const unshelved = await rescan.execute(
    rescan.input_schema.parse({ facet: 'taxonomy', item: bare_job.media_item_id, apply: true }),
    rescan_ctx,
  );
  const unshelved_move = unshelved.taxonomy?.[0];
  check(
    'facet:taxonomy is licensed by the review to move it OUT of Private/',
    unshelved_move?.moved === true && !unshelved_move.to.startsWith('Private/'),
  );
  const bare_fm_final = (bare_job.note_path ? memory.read_note(bare_job.note_path)?.frontmatter : undefined) as
    | { nas_path?: string }
    | undefined;
  check(
    'the drained item lives in the open tree, note repointed, bytes present',
    typeof bare_fm_final?.nas_path === 'string' &&
      !bare_fm_final.nas_path.startsWith('Private/') &&
      existsSync(join(archive_root, bare_fm_final.nas_path)),
  );

  // The captions facet still works untouched through the new named slot.
  const cap_default = await rescan.execute(rescan.input_schema.parse({ item: LEGACY_ID }), rescan_ctx);
  check('facet defaults to captions', cap_default.facet === 'captions' && cap_default.found);

  // ── 4b-ii. a sweep is BOUNDED WORK, and says what it didn't get to ────────
  // MAX_JOB_SCAN only ever bounded the ledger WALK; the work behind it (one
  // classifier round trip + an upsert_note per item) was unbounded in an in-turn
  // tool. `refetch` re-targets every visible row, so with the batch pinned to 1
  // the bound has to bind — and the leftovers must be REPORTED rather than
  // silently truncated, which is the whole difference between a slow audit and a
  // false clean bill of health.
  process.env.HEARTH_MEDIA_RESCAN_MAX = '1';
  const bounded = await rescan.execute(
    rescan.input_schema.parse({ facet: 'nsfw', refetch: true }),
    rescan_ctx,
  );
  delete process.env.HEARTH_MEDIA_RESCAN_MAX;
  check('a sweep stops at the batch cap', bounded.scanned === 1 && bounded.reclassified?.length === 1);
  check('and reports the remainder as deferred', (bounded.deferred ?? 0) > 0);
  check(
    'and says so in the message rather than reading as finished',
    /still need|still needs/i.test(bounded.message) && /ask me again/i.test(bounded.message),
  );
  const unbounded = await rescan.execute(
    rescan.input_schema.parse({ facet: 'nsfw', refetch: true }),
    rescan_ctx,
  );
  check(
    'an unbounded sweep finishes the set and defers nothing',
    (unbounded.scanned ?? 0) > 1 && unbounded.deferred === 0 && !/ask me again/i.test(unbounded.message),
  );

  // ── 4c. derive_audio_only — the DOWNLOAD hint, pinned to real formats ─────
  // Every row below was captured from live yt-dlp (2026-07-29) rather than
  // hand-invented, because the leak turned on a semantic nobody had checked:
  // `audio_ext: 'none'` means "not an audio-only format", so it appears on the
  // MUXED avc1+mp4a format 18 as well as on video-only ones. Defense in depth —
  // the pre-gate no longer trusts this flag either way.
  const fmt = (o: MediaFormat): MediaFormat => o;
  check(
    'audio-only: a real m4a/opus set (vcodec none, video_ext none) → true',
    derive_audio_only([
      fmt({ format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', video_ext: 'none', audio_ext: 'm4a' }),
      fmt({ format_id: '249', ext: 'webm', vcodec: 'none', acodec: 'opus', video_ext: 'none', audio_ext: 'webm' }),
    ]) === true,
  );
  // The ACTUAL stored probe for the leaked item (`mi_arxnmccn`) was
  // `{format_id:'0', ext:'mp4'}` — no vcodec, no audio_ext, no video_ext, because
  // the generic extractor emitted `vcodec: null` and `str()` dropped it. That
  // shape STILL derives audio_only true, and that is correct rather than the bug:
  // the flag is a download hint and nothing consults it for a verdict any more
  // (cases 3d/3e are the assertions that close the leak). Pinned as `true` so
  // nobody "fixes" the hint and mistakes that for fixing the exposure.
  check(
    'the ACTUAL leaked probe shape (bare {format_id, ext}) still derives audio_only → true, by design',
    derive_audio_only([fmt({ format_id: '0', ext: 'mp4' })]) === true,
  );
  check(
    'a generic-extractor format that DOES carry audio_ext:none → false (no vcodec needed)',
    derive_audio_only([fmt({ format_id: '0', ext: 'mp4', audio_ext: 'none', video_ext: 'mp4' })]) === false,
  );
  check(
    'a MUXED avc1+mp4a format also reports audio_ext none → false',
    derive_audio_only([
      fmt({ format_id: '18', ext: 'mp4', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', video_ext: 'mp4', audio_ext: 'none' }),
    ]) === false,
  );
  check(
    'a declared vcodec still disqualifies audio-only (the original rule)',
    derive_audio_only([fmt({ format_id: '137', ext: 'mp4', vcodec: 'avc1', acodec: 'none' })]) === false,
  );
  check('no formats at all → false (never guess audio-only)', derive_audio_only([]) === false);

  // ── 4d. the classifier's response-shape guard ─────────────────────────────
  // `parse_classify_response` is the one place a sidecar response becomes evidence,
  // and its failure mode is silent: coerce a drifted key to 0 and the item reads
  // CONFIDENTLY SAFE. Tested directly because the smoke's classifier seam replaces
  // `classify_image` wholesale, so a guard living inline in the fetch path would
  // have no reachable test at all.
  const real_body = { drawings: 0.01, hentai: 0.0, neutral: 0.95, porn: 0.02, sexy: 0.02 };
  const parsed_ok = parse_classify_response(real_body);
  check(
    'a real 5-class body parses to classes',
    parsed_ok.available === true && parsed_ok.classes?.neutral === 0.95,
  );
  check(
    'extra keys are ignored (the sidecar may add fields)',
    parse_classify_response({ ...real_body, model: 'mobilenet_v2', ms: 31 }).available === true,
  );
  // THE ONE THAT MATTERS: a PARTIAL rename in the fail-open direction. `porn` →
  // `porn_prob` while `neutral` keeps parsing sums to ~1.0, so it clears any
  // sum-based floor, scores 0.0, and lands a confident `sfw` on explicit content.
  const renamed = { drawings: 0.01, hentai: 0.0, neutral: 0.95, porn_prob: 0.92, sexy: 0.02 };
  const parsed_renamed = parse_classify_response(renamed);
  check(
    'a PARTIAL key rename is refused, not coerced to a safe 0',
    parsed_renamed.available === false && parsed_renamed.classes === undefined,
  );
  check('…and names the drifted key', /shape_drift/.test(parsed_renamed.error ?? '') && /porn/.test(parsed_renamed.error ?? ''));
  check(
    'a sum-only check would NOT have caught it (this is why the check is per-key)',
    Object.values(renamed).reduce((s, v) => s + v, 0) > 0.5,
  );
  check(
    'a non-numeric class is refused (an error body served with a 200)',
    parse_classify_response({ ...real_body, porn: 'high' }).available === false,
  );
  check(
    'NaN is refused',
    parse_classify_response({ ...real_body, sexy: Number.NaN }).available === false,
  );
  check(
    'an all-zeros vector with the right keys is refused as degenerate',
    parse_classify_response({ drawings: 0, hentai: 0, neutral: 0, porn: 0, sexy: 0 }).available === false,
  );
  check('a non-object body is refused', parse_classify_response('nope').available === false);
  check('a null body is refused', parse_classify_response(null).available === false);

  // ── 4e. the cordon rule itself (ONE definition, two call sites) ───────────
  check('every item silos to its requester', media_cordon_for('sam') === 'sam');
  check(
    'no requester → the fail-closed owner-tier fallback',
    media_cordon_for(null) === 'owner' && media_cordon_for('  ') === 'owner',
  );
  check(
    'tighten: household → the requester (the repair)',
    tighten_media_cordon('household', 'sam') === 'sam',
  );
  check(
    'tighten: NEVER hands an already-scoped item back to the household',
    tighten_media_cordon('sam', 'jasper') === 'sam' && tighten_media_cordon('owner', 'sam') === 'owner',
  );
  check(
    'tighten: unset resolves to the explicit owner-tier scope (same audience)',
    tighten_media_cordon(null, 'sam') === 'owner',
  );
  check(
    'off-policy detection is exactly "still household"',
    is_off_policy_media_cordon('household') &&
      !is_off_policy_media_cordon('jasper') &&
      !is_off_policy_media_cordon(null),
  );

  // ── 5. probe fail → failed ───────────────────────────────────────────────
  const fail_job = await run_job('https://x/fail-video');
  check('a probe failure fails the job', fail_job.status === 'failed');
  check('failed job records an error', !!fail_job.error);

  // ── 6. kill switch → no-op, job stays open ───────────────────────────────
  process.env.HEARTH_MEDIA_ARCHIVE = '0';
  const off_row = memory.media_jobs.create({ url: 'https://x/killed', requested_by: 'jasper', private_to: 'jasper' });
  const off_res = await advance(deps, off_row.id, 'kate');
  check('kill switch no-ops advance', off_res.progressed === false && off_res.status === 'pending');
  check('kill switch leaves the job open', memory.media_jobs.get(off_row.id)?.status === 'pending');
  process.env.HEARTH_MEDIA_ARCHIVE = '1';

  // ── 7. the archive_url tool: files a job + re-file collapse ───────────────
  const tool = make_archive_url(deps);
  const ctx = {
    memory,
    llm: mock_llm,
    now: new Date(),
    intent_id: 'test-intent',
    user: { id: 'jasper', tier: 'owner' as const },
  } as unknown as ToolContext;

  // pre-seed an OPEN job so the collapse is deterministic (no async kick timing)
  memory.media_jobs.create({ url: 'https://x/collapse', requested_by: 'jasper', private_to: 'jasper' });
  const collapse = await tool.execute({ url: 'https://x/collapse' }, ctx);
  check('tool re-file-collapses onto the open job', collapse.already_running === true && !!collapse.job_id);

  const filed = await tool.execute({ url: 'https://x/tool-fresh' }, ctx);
  check('tool files a fresh job', filed.already_running === false && !!filed.job_id);
  check('tool returns the "on it" steer', filed.enabled && /on it/i.test(filed.next_action));
  check('tool created the job row', memory.media_jobs.get(filed.job_id!) != null);

  db.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n✅ smoke:media-archive — ${passed} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
