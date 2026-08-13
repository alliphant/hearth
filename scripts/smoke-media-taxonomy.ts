/**
 * smoke:media-taxonomy — the canonical folder taxonomy (@core/media/taxonomy)
 * and the `rescan_media_metadata` facet:'taxonomy' migration.
 *
 * Two owner reports on 2026-07-29 are the acceptance bar, and section G pins ALL
 * SEVEN REAL live `nas_path`s (read read-only off the LLM host) against their canonical
 * targets:
 *
 *   1. *"Private has 'Porn Hub', 'Video' and 'Videos'"* — the FOLDER shape, fixed
 *      by deriving the path in code with a closed vocabulary at constant depth.
 *   2. *"'Hot Wet Delirious' is what should be seen. From Zero Livestream."* and
 *      *"you're not trimming the important part of the files right? The names???"*
 *      — the item's NAME, which the first shape put nowhere on disk. Fixed by a
 *      title rung in the Music/Audio third slot and a `<title> [<id>]` FILENAME.
 *
 * If a shape changes, that table is what has to be re-approved. ⚠ It is a SNAPSHOT
 * and it has already shrunk once — nine rows became seven when the two "Me at the
 * zoo" items were deleted — so re-derive the dry run against live data immediately
 * before any `apply: true` rather than trusting this table's count.
 *
 * Self-contained: temp vault + temp db + temp archive root with REAL files, a
 * scripted mock LLM for the category leaf. No network, no yt-dlp, no NAS.
 *
 *   A. the deriver, one case per top level + the constant-depth contract
 *   A2. the title reaches ONLY the album slot, over every MediaKind
 *   B. every alias in the vocabulary (and nothing outside it)
 *   C. totality over MEDIA_KINDS + unknown-kind fallback
 *   D. the missing-creator case — placeholder, never a left-shift
 *   E. the site slot: casing, sub-extractors, generic → page host
 *   F. the Private-prefix interaction + the model no longer authors the path
 *   F2. ONE forced-kind rule: the path AND the filename cannot disagree with the note
 *   G. the 7 live off-schema paths → their canonical targets (folders + filenames)
 *   G2. the filename stem + id resolution (both stem shapes, and the near-misses)
 *   G3. ONE producer: the path the real `download_media` writes IS the canonical
 *       path, for hostile titles that reach a FOLDER name — plus the SMB-reserved
 *       class on a directory segment (a stub yt-dlp/gallery-dl, no network)
 *   H. the tool: dry-run default, apply, rename-in-place, idempotence, cordon,
 *      collisions, prune
 *   I. the repair path's hostile cases: messy legacy spellings, fail-open
 *
 *   bun run smoke:media-taxonomy
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { rebuild } from '@ingestor/rebuild';
import type { ToolContext } from '@core/tool';
import type { LLMRouter } from '@core/llm';
import type { MediaDownloadResult, MediaProbeResult, QualityDecision } from '@core/media/types';
import { MEDIA_KINDS } from '@core/media/types';
import {
  MEDIA_PRIVATE_SEGMENT,
  MEDIA_TOP_LEVELS,
  MEDIA_TOP_LEVEL_ALIASES,
  MEDIA_UNKNOWN_SEGMENT,
  MEDIA_UNTITLED_NAME,
  is_off_schema,
  media_canonical_dir,
  media_canonical_entry_name,
  media_canonical_path,
  media_canonical_stem,
  media_dir_of,
  media_entry_belongs_to,
  media_folder_segments,
  media_is_private_path,
  media_normalize_path,
  media_safe_segment,
  media_site_label,
  media_split_entry_name,
  media_top_level_of_kind,
  media_top_level_of_segment,
  type MediaTaxonomyInput,
} from '@core/media/taxonomy';
import { media_measured_kind } from '@core/media/types';
import { categorize_media } from '@connectors/media_category';
import { _writer_dest_dir_rel, download_media } from '@connectors/media_download';
import { build_media_note } from '@connectors/media_note';
import { make_rescan_media_metadata } from '../src/specialists/kate/tools/rescan_media_metadata';

let failures = 0;
let passed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}
const eq = (actual: unknown, expected: unknown, msg: string): void =>
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${msg}${JSON.stringify(actual) === JSON.stringify(expected) ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`,
  );

const dir = (input: MediaTaxonomyInput, is_private = false): string =>
  media_canonical_dir(input, is_private);

async function main(): Promise<void> {
  // ══ A. the deriver, per top level ═════════════════════════════════════════
  console.log('\nA. canonical shapes per top level');

  eq(
    media_folder_segments({
      media_kind: 'song',
      creator: 'Linkin Park',
      extractor: 'youtube',
      upload_date: '20240905',
    }),
    ['Music', 'Linkin Park', '2024'],
    'Music → Music/<Artist>/<Year> (no site segment: an artist is a global identity)',
  );
  eq(
    media_folder_segments({
      media_kind: 'song',
      creator: 'Linkin Park',
      extractor: 'youtube',
      upload_date: '20240905',
      album: 'From Zero',
      title: 'Heavy Is The Crown',
    }),
    ['Music', 'Linkin Park', 'From Zero'],
    'Music prefers a MEASURED album over both the title and the year',
  );
  // ── the 2026-07-29 owner correction: album → TITLE → year ──────────────────
  eq(
    media_folder_segments({
      media_kind: 'music_video',
      creator: 'Rebecca Black',
      extractor: 'youtube',
      published_at: '2026-07-10',
      title: 'Hot Wet Delirious',
    }),
    ['Music', 'Rebecca Black', 'Hot Wet Delirious'],
    'with no measured album the TITLE takes the slot, not the year (owner: “what should be seen”)',
  );
  eq(
    media_folder_segments({
      media_kind: 'song',
      creator: 'Someone',
      extractor: 'youtube',
      upload_date: '20240905',
      title: MEDIA_UNTITLED_NAME,
    }),
    ['Music', 'Someone', '2024'],
    'the untitled SENTINEL is not a title — it falls through to the year',
  );
  eq(
    media_folder_segments({ media_kind: 'song', creator: 'Someone', extractor: 'youtube' }),
    ['Music', 'Someone', MEDIA_UNKNOWN_SEGMENT],
    'no album, no title, no date → the placeholder (constant depth holds)',
  );
  eq(
    media_folder_segments({ media_kind: 'podcast', creator: 'Hard Fork', published_at: '2026-02-01' }),
    ['Audio', 'Hard Fork', '2026'],
    'Audio → Audio/<Show>/<Year> (creator-first like Music)',
  );
  eq(
    media_folder_segments({ media_kind: 'clip', creator: 'jawed', extractor: 'youtube' }),
    ['Video', 'YouTube', 'jawed'],
    'Video → Video/<Site>/<Creator> (a channel handle is platform-scoped)',
  );
  eq(
    media_folder_segments({ media_kind: 'lecture', creator: 'Feynman', extractor: 'vimeo' }),
    ['Talks', 'Vimeo', 'Feynman'],
    'Talks → Talks/<Site>/<Speaker> (site-first: no probe field carries a series/venue)',
  );
  eq(
    media_folder_segments({ media_kind: 'image_gallery', creator: 'someuser', extractor: 'reddit' }),
    ['Images', 'Reddit', 'someuser'],
    'Images → Images/<Site>/<Uploader>',
  );
  eq(
    media_folder_segments({ media_kind: 'other', creator: 'MewSlut', extractor: 'PornHub' }),
    ['Other', 'PornHub', 'MewSlut'],
    'other → Other/<Site>/<Creator>',
  );
  assert(
    MEDIA_KINDS.every((k) => media_folder_segments({ media_kind: k, creator: 'C' }).length === 3),
    'CONSTANT DEPTH: every kind derives exactly 3 segments',
  );
  assert(
    MEDIA_TOP_LEVELS.every((t) => MEDIA_TOP_LEVELS.filter((x) => x === t).length === 1),
    'the top-level vocabulary has no duplicates',
  );

  // ── A2. the title is CONSTRAINED TO THE ALBUM SLOT, for every kind ─────────
  // Admitting the title into the deriver is only safe because it cannot reach any
  // other slot. That is enforced by the TYPE of each slot function's parameter
  // (`creator_segment` takes `Pick<…, 'creator'|'channel'|'uploader'>`,
  // `media_site_label` takes `{extractor?, webpage_url?}`), so this is the runtime
  // pin on the same claim: exhaustive over MEDIA_KINDS, with every OTHER field
  // populated so a title could only appear by displacing a real value.
  const SENTINEL = 'ZZTITLESENTINELZZ';
  let slot_ok = 0;
  for (const k of MEDIA_KINDS) {
    const segs = media_folder_segments({
      media_kind: k,
      creator: 'RealCreator',
      channel: 'RealChannel',
      uploader: 'RealUploader',
      extractor: 'youtube',
      webpage_url: 'https://example.com/x',
      upload_date: '20240905',
      title: SENTINEL,
    });
    const top = media_top_level_of_kind(k);
    const creator_first = top === 'Music' || top === 'Audio';
    // Slot 0 and slot 1 can NEVER be the title, whatever the kind.
    const positions_ok = segs[0] !== SENTINEL && segs[1] !== SENTINEL;
    // Slot 2 is the album slot for creator-first kinds (title allowed) and the
    // CREATOR slot for site-first kinds (title forbidden).
    const slot2_ok = creator_first ? segs[2] === SENTINEL : segs[2] !== SENTINEL;
    if (positions_ok && slot2_ok) slot_ok += 1;
    else console.error(`  ✗ ${k}: ${JSON.stringify(segs)}`);
  }
  assert(
    slot_ok === MEDIA_KINDS.length,
    `the title reaches ONLY the album slot, never slot 0 / site / creator — all ${MEDIA_KINDS.length} kinds`,
  );
  // …and with an album present it reaches NO slot at all, for any kind.
  assert(
    MEDIA_KINDS.every((k) =>
      media_folder_segments({
        media_kind: k,
        creator: 'RealCreator',
        extractor: 'youtube',
        album: 'RealAlbum',
        title: SENTINEL,
      }).every((s) => s !== SENTINEL),
    ),
    'with a measured album the title appears in NO position, for every kind',
  );

  // ══ B. every alias ════════════════════════════════════════════════════════
  console.log('\nB. the alias vocabulary (every entry, and nothing outside it)');

  const expected_aliases: Record<string, string> = {
    music: 'Music', song: 'Music', songs: 'Music', album: 'Music', albums: 'Music',
    track: 'Music', tracks: 'Music', artist: 'Music', artists: 'Music',
    audio: 'Audio', podcast: 'Audio', podcasts: 'Audio', audiobook: 'Audio', audiobooks: 'Audio',
    video: 'Video', videos: 'Video', movie: 'Video', movies: 'Video', film: 'Video', films: 'Video',
    tv: 'Video', show: 'Video', shows: 'Video', episode: 'Video', episodes: 'Video',
    clip: 'Video', clips: 'Video',
    talk: 'Talks', talks: 'Talks', lecture: 'Talks', lectures: 'Talks',
    interview: 'Talks', interviews: 'Talks', conference: 'Talks', conferences: 'Talks',
    image: 'Images', images: 'Images', picture: 'Images', pictures: 'Images',
    pic: 'Images', pics: 'Images', photo: 'Images', photos: 'Images',
    photoset: 'Images', photosets: 'Images', gallery: 'Images', galleries: 'Images',
    other: 'Other', misc: 'Other', miscellaneous: 'Other', unsorted: 'Other', unknown: 'Other',
  };
  let alias_ok = 0;
  for (const [seg, want] of Object.entries(expected_aliases)) {
    if (media_top_level_of_segment(seg) === want) alias_ok++;
    else console.error(`    ✗ alias ${seg} → ${media_top_level_of_segment(seg)}, want ${want}`);
    // Case- and whitespace-insensitive: on-disk folders are Title Case.
    if (media_top_level_of_segment(`  ${seg.toUpperCase()} `) !== want) {
      console.error(`    ✗ alias ${seg} is case/space sensitive`);
      alias_ok = -1;
    }
  }
  assert(
    alias_ok === Object.keys(expected_aliases).length,
    `all ${Object.keys(expected_aliases).length} aliases resolve (case/space-insensitively)`,
  );
  eq(
    Object.keys(MEDIA_TOP_LEVEL_ALIASES).sort().join(','),
    Object.keys(expected_aliases).sort().join(','),
    'the module\'s alias map is exactly the tested set (nothing untested crept in)',
  );
  // The whole point of the map: 'Videos' is Video spelled wrong; 'PornHub' is
  // not a kind at ALL, which is the corrupted-kind-slot signature.
  assert(media_top_level_of_segment('Videos') === 'Video', "'Videos' (the live defect) reads as Video");
  assert(media_top_level_of_segment('PornHub') === null, "'PornHub' is NOT a top level (corrupted slot)");
  assert(media_top_level_of_segment('MewSlut') === null, 'a creator name is NOT a top level');
  assert(media_top_level_of_segment('Private') === null, "'Private' is a cordon prefix, not a top level");
  assert(media_top_level_of_segment('') === null && media_top_level_of_segment(null) === null, 'empty/null segment → null');

  // ══ C. totality over MEDIA_KINDS ══════════════════════════════════════════
  console.log('\nC. kind → top level is total');

  const unplaced = MEDIA_KINDS.filter(
    (k) => !(MEDIA_TOP_LEVELS as readonly string[]).includes(media_top_level_of_kind(k)),
  );
  eq(unplaced, [], 'every MediaKind maps into the closed vocabulary');
  assert(media_top_level_of_kind('music_video') === 'Music', 'music_video → Music (not Video)');
  assert(media_top_level_of_kind('live_set') === 'Music', 'live_set → Music');
  assert(media_top_level_of_kind('gameplay') === 'Video', 'gameplay → Video');
  assert(media_top_level_of_kind('photoset') === 'Images', 'photoset → Images');
  assert(media_top_level_of_kind('nonsense_kind') === 'Other', 'an unknown kind → Other');
  assert(media_top_level_of_kind('videos') === 'Video', 'a kind that is really a folder word still resolves');
  assert(media_top_level_of_kind(undefined) === 'Other', 'a missing kind → Other');

  // ══ D. the missing-creator case ═══════════════════════════════════════════
  console.log('\nD. missing values fill their slot — never a left-shift');

  eq(
    media_folder_segments({ media_kind: 'clip', extractor: 'youtube' }),
    ['Video', 'YouTube', MEDIA_UNKNOWN_SEGMENT],
    'no creator → placeholder in the creator slot (nothing slides left)',
  );
  eq(
    media_folder_segments({ media_kind: 'song' }),
    ['Music', MEDIA_UNKNOWN_SEGMENT, MEDIA_UNKNOWN_SEGMENT],
    'no artist + no album/year → two placeholders, still 3 deep',
  );
  eq(
    media_folder_segments({ media_kind: 'clip', creator: '   ', extractor: 'youtube' }),
    ['Video', 'YouTube', MEDIA_UNKNOWN_SEGMENT],
    'a whitespace-only creator is treated as absent',
  );
  eq(
    media_folder_segments({ media_kind: 'clip', channel: 'ChanName', extractor: 'youtube' }),
    ['Video', 'YouTube', 'ChanName'],
    'creator falls back to the measured channel',
  );
  eq(
    media_folder_segments({ media_kind: 'clip', uploader: 'UpName', extractor: 'youtube' }),
    ['Video', 'YouTube', 'UpName'],
    'then to the measured uploader',
  );
  eq(
    media_folder_segments({ media_kind: 'clip', creator: 'a/b\\c', extractor: 'youtube' }),
    ['Video', 'YouTube', 'a b c'],
    'path separators in a creator are neutralised (no directory escape)',
  );
  // Traversal safety is structural: separators become spaces, so whatever
  // survives is ONE path component and can never be the parent-dir component.
  // A residual literal '..' inside a name is cosmetic, not an escape.
  const traversal = media_folder_segments({ media_kind: 'clip', creator: '../../etc', extractor: 'youtube' });
  assert(
    traversal.length === 3 && !traversal.some((s) => s === '..' || s.includes('/') || s.includes('\\')),
    `a traversal attempt yields one inert segment (${JSON.stringify(traversal[2])})`,
  );
  eq(
    media_folder_segments({ media_kind: 'clip', creator: '..', extractor: 'youtube' }),
    ['Video', 'YouTube', MEDIA_UNKNOWN_SEGMENT],
    "a creator of exactly '..' collapses to the placeholder",
  );

  // ══ E. the site slot ══════════════════════════════════════════════════════
  console.log('\nE. the site slot');

  assert(media_site_label({ extractor: 'youtube' }) === 'YouTube', 'youtube → YouTube (the one casing fix)');
  assert(media_site_label({ extractor: 'youtube:shorts' }) === 'YouTube', 'a sub-extractor collapses onto its site');
  assert(media_site_label({ extractor: 'PornHub' }) === 'PornHub', "yt-dlp's own brand casing is preserved");
  assert(media_site_label({ extractor: 'XHamster' }) === 'XHamster', 'XHamster preserved');
  assert(media_site_label({ extractor: 'reddit' }) === 'Reddit', 'a lowercase extractor gets a leading capital');
  assert(
    media_site_label({ extractor: 'html5', webpage_url: 'https://www.sickjunk.com/x/y/' }) === 'sickjunk.com',
    'a generic extractor falls back to the page host (www stripped)',
  );
  assert(
    media_site_label({ extractor: 'generic', webpage_url: 'https://Example.ORG/a' }) === 'example.org',
    "'generic' too, lower-cased",
  );
  assert(
    media_site_label({ extractor: 'html5' }) === MEDIA_UNKNOWN_SEGMENT,
    'generic extractor with no usable URL → placeholder',
  );
  assert(
    media_site_label({ extractor: 'html5', webpage_url: 'not a url' }) === MEDIA_UNKNOWN_SEGMENT,
    'an unparseable URL → placeholder (never a throw)',
  );
  assert(media_site_label({}) === MEDIA_UNKNOWN_SEGMENT, 'no extractor at all → placeholder');

  // ══ F. the Private prefix + the model no longer authors the path ═══════════
  console.log('\nF. the cordon prefix, and the model no longer authors the path');

  const probe = (over: Partial<MediaProbeResult> = {}): MediaProbeResult => ({
    source: 'yt-dlp',
    ok: true,
    extractor: 'PornHub',
    webpage_url: 'https://www.pornhub.com/view_video.php?viewkey=abc',
    title: 'A Title',
    uploader: 'MewSlut',
    extra: {},
    ...over,
  });
  /** A planner that returns a path AND a Private instruction — both must be ignored. */
  const hostile_llm = {
    for_role: () => ({
      provider: {
        complete: async () => ({
          content: JSON.stringify({
            media_kind: 'clip',
            creator: 'MewSlut',
            title_clean: 'A Title',
            folder_segments: ['Private', 'Porn Hub', 'MewSlut', 'deep', 'deeper'],
            confidence: 0.9,
            rationale: 'test',
          }),
        }),
      },
      defaults: {},
    }),
  } as unknown as LLMRouter;

  const sfw = await categorize_media({ probe: probe(), nsfw: 'sfw', llm: hostile_llm });
  eq(
    sfw.folder_segments,
    ['Video', 'PornHub', 'MewSlut'],
    "a model-authored folder_segments is IGNORED (no 'Porn Hub', no 5-deep path)",
  );
  const explicit = await categorize_media({ probe: probe(), nsfw: 'nsfw', llm: hostile_llm });
  eq(
    explicit.folder_segments,
    ['Private', 'Video', 'PornHub', 'MewSlut'],
    'nsfw → the cordon prepends Private ONCE, on top of the intact 3-slot path',
  );
  const uncertain = await categorize_media({ probe: probe(), nsfw: 'uncertain', llm: hostile_llm });
  assert(uncertain.folder_segments[0] === 'Private', "'uncertain' fails closed to Private too");
  assert(
    explicit.folder_segments.filter((s) => s === 'Private').length === 1,
    'the Private prefix is never doubled',
  );
  // THE invariant the cordon's correctness actually rests on: the first derived
  // segment is always a member of the CLOSED top-level vocabulary, and the
  // private prefix is not in it — so `apply_nsfw_cordon` can never double-prefix
  // and needs no idempotence guard. (An earlier draft carried one, justified by
  // "a creator or a site could be called Private"; at constant depth a creator or
  // a site can only land in slot 1 or 2, so the guard was unreachable and its
  // test passed with the block deleted. This assertion is the honest replacement.)
  assert(
    !(MEDIA_TOP_LEVELS as readonly string[]).includes(MEDIA_PRIVATE_SEGMENT),
    'the private prefix is NOT a member of the closed top-level vocabulary',
  );
  assert(
    MEDIA_KINDS.every((k) =>
      (MEDIA_TOP_LEVELS as readonly string[]).includes(
        media_folder_segments({ media_kind: k, creator: MEDIA_PRIVATE_SEGMENT, extractor: MEDIA_PRIVATE_SEGMENT })[0]!,
      ),
    ),
    "slot 0 is always a top level — even when the creator AND the site are named 'Private'",
  );
  // So a model whose CREATOR is literally 'Private' cannot create a second
  // private tree: the name lands in a later slot, below the derived kind.
  const private_named = {
    for_role: () => ({
      provider: {
        complete: async () => ({
          content: JSON.stringify({ media_kind: 'song', creator: 'Private', confidence: 0.9 }),
        }),
      },
      defaults: {},
    }),
  } as unknown as LLMRouter;
  const collide = await categorize_media({
    probe: probe({ extractor: 'youtube', upload_date: '20260101' }),
    nsfw: 'nsfw',
    llm: private_named,
  });
  // Slot 3 is the probe title via the album rung (the model returned no
  // `title_clean`, so `probe.title` resolves it) — the point here is slot 2.
  eq(collide.folder_segments, ['Private', 'Music', 'Private', 'A Title'], 'a creator named "Private" lands in slot 2, so the prefix is never doubled');

  // A gallery-dl source is an image set whatever the planner labelled it — the
  // MEASURED source wins for the path, as it already does for the note's kind.
  const mislabelled_gallery = await categorize_media({
    probe: probe({ source: 'gallery-dl', extractor: 'reddit', uploader: 'someuser' }),
    nsfw: 'sfw',
    llm: hostile_llm,
  });
  eq(
    mislabelled_gallery.folder_segments,
    ['Images', 'Reddit', 'MewSlut'],
    'a gallery-dl item the model called a "clip" is still filed under Images',
  );

  // A planner FAILURE must still land in the canonical tree (no parallel tree).
  const broken_llm = {
    for_role: () => ({ provider: { complete: async () => ({ content: 'not json at all' }) }, defaults: {} }),
  } as unknown as LLMRouter;
  const fell_back = await categorize_media({
    probe: probe({ extractor: 'youtube', channel: 'Chan', is_audio_only: true, upload_date: '20260401' }),
    nsfw: 'sfw',
    llm: broken_llm,
  });
  eq(
    fell_back.folder_segments,
    ['Music', 'Chan', 'A Title'],
    'the fail-open fallback uses the SAME deriver (no "web"/"unknown" parallel tree)',
  );
  // …including the title rung: an LLM outage still names the folder after the item,
  // because the fallback resolves `title_clean` from the MEASURED `probe.title`.
  const fell_back_untitled = await categorize_media({
    probe: probe({ extractor: 'youtube', channel: 'Chan', is_audio_only: true, upload_date: '20260401', title: undefined }),
    nsfw: 'sfw',
    llm: broken_llm,
  });
  eq(
    fell_back_untitled.folder_segments,
    ['Music', 'Chan', '2026'],
    '…and with no measured title at all it falls through to the year, as before',
  );

  // ══ F2. ONE forced-kind rule ══════════════════════════════════════════════
  // The path is derived PRE-download and the note written POST-download, so the
  // two must agree by construction or every freshly archived item of the
  // disagreeing shape is reported off-schema forever. They used to own half the
  // rule each: the write path only UPGRADED a measured gallery, while the note
  // ALSO stripped a spurious gallery label down to 'other' — so a planner that
  // called a YouTube video an 'image_gallery' wrote into Images/ while its own
  // note said 'other'. `media_measured_kind` is now the single producer.
  console.log('\nF2. the forced-kind rule: the path and the note cannot disagree');

  const kind_of = (model_kind: string, gallery: boolean): string =>
    media_measured_kind(model_kind, gallery ? { source: 'gallery-dl', image_count: 2 } : { source: 'yt-dlp' });
  assert(kind_of('clip', true) === 'image_gallery', 'a measured gallery the model called a clip → image_gallery');
  assert(kind_of('photoset', true) === 'photoset', "a measured gallery keeps the model's finer 'photoset' read");
  assert(kind_of('image_gallery', false) === 'other', "a NON-gallery labelled 'image_gallery' is stripped to other");
  assert(kind_of('photoset', false) === 'other', "a NON-gallery labelled 'photoset' is stripped to other");
  assert(kind_of('tutorial', false) === 'tutorial', 'an honest label is left alone');
  assert(kind_of('nonsense', false) === 'other', 'a kind outside the vocabulary → other');
  assert(kind_of('', false) === 'other' && kind_of(undefined as unknown as string, false) === 'other', 'missing kind → other');
  assert(
    MEDIA_KINDS.every((k) => kind_of(kind_of(k, true), true) === kind_of(k, true) && kind_of(kind_of(k, false), false) === kind_of(k, false)),
    'the rule is IDEMPOTENT for every kind (so re-applying it at filing time is a no-op)',
  );
  assert(
    media_measured_kind('clip', {}) === 'clip' && media_measured_kind('clip', { image_count: 0 }) === 'clip',
    'no gallery evidence (or an EMPTY set) is not a gallery',
  );

  // The end-to-end proof: run the real classify → real note builder and check the
  // directory the bytes went to against the one the migration derives from the
  // note that was written. This is the exact disagreement the reviewer measured.
  const kind_llm = (kind: string): LLMRouter =>
    ({
      for_role: () => ({
        provider: {
          complete: async () => ({
            content: JSON.stringify({ media_kind: kind, creator: 'SomeChan', title_clean: 'Some Video', confidence: 0.9 }),
          }),
        },
        defaults: {},
      }),
    }) as unknown as LLMRouter;
  const av_probe = probe({
    source: 'yt-dlp',
    extractor: 'youtube',
    webpage_url: 'https://www.youtube.com/watch?v=abc',
    channel: 'SomeChan',
    uploader: 'SomeChan',
    upload_date: '20260101',
  });
  /**
   * The migration's view of an item, read off the NOTE exactly as
   * `taxonomy_input_from_note` reads it — including `name`, which is the note's
   * spelling of the write path's `title_clean` and therefore the value both the
   * album slot and the filename stem re-derive from.
   */
  const from_note = (fm: Record<string, unknown>): MediaTaxonomyInput => ({
    media_kind: String(fm.media_kind),
    creator: String(fm.creator),
    title: String(fm.name),
    extractor: String(fm.source_site),
    webpage_url: String(fm.source_url),
    ...(fm.published_at !== undefined ? { published_at: String(fm.published_at) } : {}),
  });
  for (const model_kind of ['image_gallery', 'photoset', 'clip', 'song', 'tutorial']) {
    const cat = await categorize_media({ probe: av_probe, nsfw: 'sfw', llm: kind_llm(model_kind) });
    const wrote = cat.folder_segments.join('/'); // where download_media puts the bytes
    // …and what it CALLS them: the same stem `download_media` builds from the id +
    // the decision's title. Spelling it out here is what makes this an end-to-end
    // proof of the filename half, not only the folder half.
    const wrote_stem = media_canonical_stem('mi_agree01', cat.title_clean);
    const download: MediaDownloadResult = { nas_path: `${wrote}/${wrote_stem}.mp4`, container: 'mp4' };
    const note = build_media_note({
      probe: av_probe,
      category: cat,
      nsfw: { verdict: 'sfw', score: 0, frames_scored: 1, reason: 'smoke' },
      download,
      source_site: av_probe.extractor,
      archived_at: '2026-07-29T00:00:00Z',
      id: 'mi_agree01',
    });
    const fm = note.frontmatter;
    const migration_wants = media_canonical_dir(from_note(fm), media_is_private_path(download.nas_path));
    eq(migration_wants, wrote, `model="${model_kind}": the note's own re-derivation matches where the bytes went`);
    eq(
      media_canonical_path(download.nas_path, from_note(fm), 'mi_agree01'),
      download.nas_path,
      `model="${model_kind}": …and the FILENAME the migration derives is the one the writer used`,
    );
    assert(
      !is_off_schema(download.nas_path, from_note(fm), 'mi_agree01'),
      `model="${model_kind}": a freshly archived item is NOT reported off-schema`,
    );
  }
  // …and the same for a real gallery, where the forcing runs the other way.
  const gal_probe = probe({ source: 'gallery-dl', extractor: 'reddit', uploader: 'someuser', images: [{ idx: 0 }, { idx: 1 }], image_count: 2 });
  const gal_cat = await categorize_media({ probe: gal_probe, nsfw: 'sfw', llm: kind_llm('clip') });
  // A gallery's nas_path is the per-item DIRECTORY, named with the same stem.
  const gal_nas = `${gal_cat.folder_segments.join('/')}/${media_canonical_stem('mi_agree02', gal_cat.title_clean)}`;
  const gal_note = build_media_note({
    probe: gal_probe,
    category: gal_cat,
    nsfw: { verdict: 'sfw', score: 0, frames_scored: 1, reason: 'smoke' },
    download: {
      nas_path: gal_nas,
      container: 'gallery',
      image_count: 2,
      images: [{ idx: 0, file: '001.jpg' }, { idx: 1, file: '002.jpg' }],
    },
    source_site: gal_probe.extractor,
    archived_at: '2026-07-29T00:00:00Z',
    id: 'mi_agree02',
  });
  eq(gal_cat.media_kind, 'image_gallery', 'a gallery-dl item the model called a clip is image_gallery on the DECISION too');
  eq(gal_note.frontmatter.media_kind, 'image_gallery', 'and on the note — one value end to end');
  eq(gal_cat.folder_segments.join('/'), 'Images/Reddit/SomeChan', 'and the bytes go under Images/');
  eq(gal_nas, 'Images/Reddit/SomeChan/Some Video [mi_agree02]', "…in a per-item directory that carries the set's name");
  assert(
    !is_off_schema(gal_nas, from_note(gal_note.frontmatter), 'mi_agree02'),
    'a freshly archived GALLERY is not reported off-schema either (directory-shaped path, same rule)',
  );

  // ══ G. the 7 live off-schema paths ════════════════════════════════════════
  console.log('\nG. the seven live items (read read-only off the LLM host 2026-07-29)');

  /**
   * Every row in `media_items` on the LLM host, with the `nas_path` each one ACTUALLY
   * has right now (i.e. AFTER the first migration ran) and the full path the
   * corrected taxonomy derives for it. `title` is the live `name` column — which
   * is also the note's `name`, the value the repair path re-derives from.
   *
   * ⚠ SNAPSHOT, and it has already moved once: this table held NINE rows when the
   * first shape shipped. The two "Me at the zoo" items (mi_zqm9jy90, mi_8ww9n0qw)
   * were DELETED at the owner's request — notes and RAG chunks gone — so seven is
   * the live count. An eighth can land at any time: re-derive the dry run against
   * live data immediately before any `apply: true` rather than trusting this count.
   *
   * The two Music rows are the owner's actual complaint. Neither has a measured
   * `metrics.album` (verified in the live notes — only `release_year`), which is
   * exactly why the album slot fell through to the year, and exactly why the title
   * rung now catches it.
   */
  const LIVE: Array<{
    id: string;
    from: string;
    to_dir: string;
    to: string;
    /** sidecars the live note actually records, as extension tails off the stem */
    sidecars: string[];
    input: MediaTaxonomyInput;
  }> = [
    {
      id: 'mi_72x12cb5',
      from: 'Music/Rebecca Black/2026/mi_72x12cb5.mp4',
      to_dir: 'Music/Rebecca Black/Hot Wet Delirious',
      to: 'Music/Rebecca Black/Hot Wet Delirious/Hot Wet Delirious [mi_72x12cb5].mp4',
      sidecars: ['.webp', '.info.json'],
      input: {
        media_kind: 'music_video',
        creator: 'Rebecca Black',
        title: 'Hot Wet Delirious',
        extractor: 'youtube',
        webpage_url: 'https://www.youtube.com/watch?v=MX6ZbnN0z6E',
        published_at: '2026-07-10',
      },
    },
    {
      id: 'mi_qk97e6kw',
      from: 'Music/Linkin Park/2024/mi_qk97e6kw.mp4',
      to_dir: 'Music/Linkin Park/From Zero Livestream',
      to: 'Music/Linkin Park/From Zero Livestream/From Zero Livestream [mi_qk97e6kw].mp4',
      // The only live item with caption tracks — and `en-orig` is why the stem is
      // split at the FIRST dot rather than the last.
      sidecars: ['.webp', '.info.json', '.en.srt', '.en-orig.srt'],
      input: {
        media_kind: 'live_set',
        creator: 'Linkin Park',
        title: 'From Zero Livestream',
        extractor: 'youtube',
        webpage_url: 'https://www.youtube.com/watch?v=IL1nlWOciL0',
        published_at: '2024-09-05',
      },
    },
    {
      // The FOLDER is already canonical; only the filename is wrong. This row is
      // why `is_off_schema` had to widen from the directory to the whole path —
      // under the old rule it was "correctly filed" with its name nowhere on disk.
      // Also the one live title carrying a non-ASCII character (`è`), kept verbatim.
      id: 'mi_ngpbn5mk',
      from: 'Video/YouTube/Eurosport/mi_ngpbn5mk.mp4',
      to_dir: 'Video/YouTube/Eurosport',
      to: 'Video/YouTube/Eurosport/Nightcall - Kavinsky, Angèle and Phoenix at Stade de France [mi_ngpbn5mk].mp4',
      sidecars: ['.webp', '.info.json'],
      input: {
        media_kind: 'clip',
        creator: 'Eurosport',
        title: 'Nightcall - Kavinsky, Angèle and Phoenix at Stade de France',
        extractor: 'youtube',
        webpage_url: 'https://www.youtube.com/watch?v=OSayp2tArqA',
        published_at: '2024-08-11',
      },
    },
    {
      id: 'mi_4tfdeefd',
      from: 'Video/YouTube/Xtine Cardenas/mi_4tfdeefd.mp4',
      to_dir: 'Video/YouTube/Xtine Cardenas',
      to: 'Video/YouTube/Xtine Cardenas/Lower back pain mobility routine [mi_4tfdeefd].mp4',
      sidecars: ['.webp', '.info.json'],
      input: {
        media_kind: 'tutorial',
        creator: 'Xtine Cardenas',
        title: 'Lower back pain mobility routine',
        extractor: 'youtube',
        webpage_url: 'https://www.youtube.com/watch?v=Z1wVV0DYTiM',
        published_at: '2026-06-13',
      },
    },
    {
      id: 'mi_kjfxj9qs',
      from: 'Private/Other/PornHub/MewSlut/mi_kjfxj9qs.mp4',
      to_dir: 'Private/Other/PornHub/MewSlut',
      to: 'Private/Other/PornHub/MewSlut/You told me you were going to leave him alone [mi_kjfxj9qs].mp4',
      sidecars: ['.jpg', '.info.json'],
      input: {
        media_kind: 'other',
        creator: 'MewSlut',
        title: 'You told me you were going to leave him alone',
        extractor: 'PornHub',
        webpage_url: 'https://www.pornhub.com/view_video.php?viewkey=652ba8f9738a7',
        published_at: '2023-10-15',
      },
    },
    {
      id: 'mi_r05qpbnv',
      from: 'Private/Video/XHamster/luke49/mi_r05qpbnv.mp4',
      to_dir: 'Private/Video/XHamster/luke49',
      to: 'Private/Video/XHamster/luke49/Brutal facefuck [mi_r05qpbnv].mp4',
      sidecars: ['.webp', '.info.json'],
      input: {
        media_kind: 'clip',
        creator: 'luke49',
        title: 'Brutal facefuck',
        extractor: 'XHamster',
        webpage_url: 'https://xhamster.com/videos/brutal-facefuck-13141253',
        published_at: '2019-12-19',
      },
    },
    {
      // No `published_at` at all (the generic/html5 extractor measured none), so
      // this row proves the title rung is not standing in for a missing date: it
      // is site-first, its third slot is the CREATOR, and the title only ever
      // reaches the filename.
      id: 'mi_arxnmccn',
      from: 'Private/Video/sickjunk.com/SickJunk/mi_arxnmccn.m4a',
      to_dir: 'Private/Video/sickjunk.com/SickJunk',
      to: 'Private/Video/sickjunk.com/SickJunk/Leaked Video Of Step Mom Wanting Sons Big Dick [mi_arxnmccn].m4a',
      sidecars: ['.png', '.info.json'],
      input: {
        media_kind: 'clip',
        creator: 'SickJunk',
        title: 'Leaked Video Of Step Mom Wanting Sons Big Dick',
        extractor: 'html5',
        webpage_url: 'https://sickjunk.com/leaked-video-of-step-mom-wanting-sons-big-dick/',
      },
    },
  ];
  eq(LIVE.length, 7, 'the pinned live table covers all SEVEN rows in MediaArchive/');

  for (const f of LIVE) {
    const to_dir = media_canonical_dir(f.input, media_is_private_path(f.from));
    eq(to_dir, f.to_dir, `${f.id}: folder ${media_dir_of(f.from)} → ${f.to_dir}`);
    eq(media_canonical_path(f.from, f.input, f.id), f.to, `${f.id}: full path → ${f.to}`);
    assert(is_off_schema(f.from, f.input, f.id), `${f.id} is detected as off-schema`);
    // The NAME is on the file — the whole point of the correction.
    assert(
      media_split_entry_name(f.to.split('/').pop() ?? '').stem === `${f.input.title} [${f.id}]`,
      `${f.id}: the filename carries the item's name`,
    );
    // Cordon safety, per item: a private item can only ever move within Private/.
    assert(
      media_is_private_path(f.from) === media_is_private_path(f.to),
      `${f.id} keeps its cordon (private ${media_is_private_path(f.from)})`,
    );
    // Every sidecar the live note records lands beside the media file, renamed
    // onto the same stem and keeping its own extension tail.
    const stem = media_canonical_stem(f.id, f.input.title);
    assert(
      f.sidecars.every(
        (tail) =>
          media_canonical_path(`${media_dir_of(f.from)}/${f.id}${tail}`, f.input, f.id) ===
          `${f.to_dir}/${stem}${tail}`,
      ),
      `${f.id}: its ${f.sidecars.length} sidecars follow onto the same stem`,
    );
  }
  // The two Music rows are the owner's literal words, so pin them as such.
  eq(
    LIVE.filter((f) => f.to_dir.startsWith('Music/')).map((f) => f.to_dir).sort(),
    ['Music/Linkin Park/From Zero Livestream', 'Music/Rebecca Black/Hot Wet Delirious'],
    'the owner’s two named items land in folders named after them, not the year',
  );
  // Three rows are pure RENAMES — the folder was already right. That distinction
  // did not exist before the filename joined the taxonomy.
  eq(
    LIVE.filter((f) => media_dir_of(f.from) === f.to_dir).map((f) => f.id).sort(),
    ['mi_4tfdeefd', 'mi_arxnmccn', 'mi_kjfxj9qs', 'mi_ngpbn5mk', 'mi_r05qpbnv'],
    'five live rows are rename-only (right folder, nameless file)',
  );

  // Idempotence of the RULE: a canonical path is not off-schema, and re-deriving
  // from a canonical path is a fixed point.
  for (const f of LIVE) {
    assert(!is_off_schema(f.to, f.input, f.id), `${f.id}: the canonical path is a fixed point`);
  }
  assert(!is_off_schema(undefined, { media_kind: 'clip' }, 'mi_x'), 'no stored path → not off-schema (nothing to move)');

  // ══ G2. the filename stem: the id survives, the title decorates ═══════════
  console.log('\nG2. the filename stem + id resolution');

  eq(media_canonical_stem('mi_x', 'Hot Wet Delirious'), 'Hot Wet Delirious [mi_x]', 'stem = <title> [<id>]');
  eq(media_canonical_stem('mi_x', undefined), 'mi_x', 'no title → the bare id (exactly the legacy shape)');
  eq(media_canonical_stem('mi_x', '   '), 'mi_x', 'a blank title → the bare id');
  eq(media_canonical_stem('mi_x', MEDIA_UNTITLED_NAME), 'mi_x', 'the untitled sentinel → the bare id');
  eq(media_canonical_stem('mi_x', '...'), 'mi_x', 'a title that sanitises to NOTHING → the bare id, never an empty stem');
  eq(media_canonical_stem('mi_x', 'a/b\\c'), 'a b c [mi_x]', 'path separators can never appear in a stem');
  eq(media_canonical_stem('mi_x', 'Vol. 2'), 'Vol 2 [mi_x]', 'dots are removed — the stem/extension split must stay unambiguous');
  eq(media_canonical_stem('mi_x', '100% Real [live]'), '100 Real live [mi_x]', "yt-dlp's %-template char and the id delimiter are removed");
  eq(media_canonical_stem('mi_x', 'a:b|c?d*e"f<g>h'), 'a b c d e f g h [mi_x]', 'the Windows/SMB reserved set is removed (the NAS is browsed over SMB)');
  assert(
    Array.from(media_canonical_stem('mi_x', 'x'.repeat(300))).length <= 80 + ` [mi_x]`.length,
    'a runaway title is capped, and the id is never the part that gets cut',
  );
  assert(
    new TextEncoder().encode(media_canonical_stem('mi_x', '😀'.repeat(200))).length <= 200,
    'an all-emoji title honours the byte cap too',
  );
  assert(
    media_canonical_stem('mi_x', '😀'.repeat(200)).endsWith('[mi_x]') &&
      new TextDecoder().decode(new TextEncoder().encode(media_canonical_stem('mi_x', '😀'.repeat(200)))) ===
        media_canonical_stem('mi_x', '😀'.repeat(200)),
    'a truncated emoji title still round-trips through UTF-8 (no lone surrogate) and keeps its id',
  );

  eq(media_split_entry_name('Title [mi_x].en-orig.srt'), { stem: 'Title [mi_x]', suffix: '.en-orig.srt' }, 'an entry splits at the FIRST dot');
  eq(media_split_entry_name('mi_x'), { stem: 'mi_x', suffix: '' }, 'an extensionless entry (a gallery dir) is all stem');
  eq(media_split_entry_name('.DS_Store'), { stem: '', suffix: '.DS_Store' }, 'a dotfile is all suffix — never an item artefact');

  // The resolution contract: BOTH stem shapes resolve by id, and nothing else does.
  const belongs: Array<[string, string, boolean]> = [
    ['mi_x.mp4', 'mi_x', true],
    ['mi_x', 'mi_x', true],
    ['mi_x.info.json', 'mi_x', true],
    ['mi_x.en-orig.srt', 'mi_x', true],
    ['Title [mi_x].mp4', 'mi_x', true],
    ['Title [mi_x]', 'mi_x', true],
    ['Title [mi_x].info.json', 'mi_x', true],
    ['Title [mi_x].en-orig.srt', 'mi_x', true],
    // …and NOT these.
    ['mi_y.mp4', 'mi_x', false],
    ['Title [mi_y].mp4', 'mi_x', false],
    ['mi_xtra.mp4', 'mi_x', false], // the old prefix test's near-miss
    ['.DS_Store', 'mi_x', false],
    ['Title mi_x.mp4', 'mi_x', false], // undelimited — not our name
    // The spoof the "id anywhere in the stem" alternative would have admitted: a
    // title that itself ends in a bracketed id. `FILENAME_HOSTILE` strips brackets
    // from titles, so this can only arrive from a hand-made file — and it still
    // must not resolve, because the LAST bracket group is the one we own.
    ['Fake [mi_x] tail [mi_y].mp4', 'mi_x', false],
    ['Fake [mi_x] tail [mi_y].mp4', 'mi_y', true],
  ];
  // A title that itself LOOKS like a media id must not let another id claim it —
  // the id is the bracketed tail, never bare text in the stem.
  eq(media_canonical_stem('mi_x', 'mi_decoy1'), 'mi_decoy1 [mi_x]', 'a title shaped like an id is still just a title');
  belongs.push(
    ['mi_decoy1 [mi_x].mp4', 'mi_decoy1', false],
    ['mi_decoy1 [mi_x].mp4', 'mi_x', true],
  );
  let belongs_ok = 0;
  for (const [name, id, want] of belongs) {
    if (media_entry_belongs_to(name, id) === want) belongs_ok += 1;
    else console.error(`  ✗ media_entry_belongs_to(${JSON.stringify(name)}, ${id}) !== ${want}`);
  }
  assert(belongs_ok === belongs.length, `id resolution: all ${belongs.length} cases (legacy + canonical stems, and the near-misses)`);
  assert(
    !media_entry_belongs_to('Title [mi_x].mp4', '') && !media_entry_belongs_to('mi_x.mp4', undefined),
    'an empty/absent id resolves NOTHING (never "everything")',
  );

  // The renamer preserves the extension chain, and is idempotent.
  eq(media_canonical_entry_name('mi_x.mp4', 'mi_x', 'Title'), 'Title [mi_x].mp4', 'rename keeps the container extension');
  eq(media_canonical_entry_name('mi_x.en-orig.srt', 'mi_x', 'Title'), 'Title [mi_x].en-orig.srt', 'rename keeps a multi-part sidecar tail');
  eq(media_canonical_entry_name('mi_x', 'mi_x', 'Title'), 'Title [mi_x]', 'rename of a gallery DIRECTORY has no extension to keep');
  eq(
    media_canonical_entry_name(media_canonical_entry_name('mi_x.mp4', 'mi_x', 'Title'), 'mi_x', 'Title'),
    'Title [mi_x].mp4',
    'renaming an already-canonical entry is a NO-OP (the migration is a fixed point, not a treadmill)',
  );

  // ══ G3. ONE producer: the path the WRITER builds IS the canonical path ═════
  //
  // The agreement that was UNTESTED, which is how it drifted: `media_download`
  // used to map its own second sanitiser (`SEG_UNSAFE`, an ASCII allowlist → `_`)
  // over the taxonomy's segments, so a title with an apostrophe was stored as
  // `Music/Rebecca Black/Don't Stop/…` and written to
  // `Music/Rebecca Black/Don_t Stop/…` — a fresh download reported off-schema on
  // the spot. Section F2 above compares the note's re-derivation against
  // `folder_segments`, which cannot see that: the divergence was DOWNSTREAM of
  // the segments. So this section goes through the real writer, twice over:
  //
  //   • `_writer_dest_dir_rel` — the exact directory `dest_dir` resolves;
  //   • the REAL `download_media` / `download_gallery`, with a stub `yt-dlp` /
  //     `gallery-dl` on `HEARTH_YTDLP_BIN` / `HEARTH_GALLERYDL_BIN`, so the
  //     `-o` template, the `mkdir` and `locate_result`'s `nas_path` are all
  //     genuinely exercised on a real filesystem.
  console.log('\nG3. the writer and the taxonomy build the SAME path (one producer)');

  const g3_tmp = mkdtempSync(join(tmpdir(), 'smoke-media-writer-'));
  const g3_root = join(g3_tmp, 'archive');
  mkdirSync(g3_root, { recursive: true });
  /** A stub yt-dlp: expand the `-o` template's `%(ext)s` and touch the artefacts. */
  const stub = (rel: string, script: string): string => {
    const abs = join(g3_tmp, rel);
    writeFileSync(abs, script, { mode: 0o755 });
    return abs;
  };
  const ytdlp_stub = stub(
    'stub-yt-dlp',
    [
      '#!/bin/sh',
      'tmpl=""',
      'while [ $# -gt 0 ]; do',
      '  if [ "$1" = "-o" ]; then shift; tmpl="$1"; fi',
      '  shift',
      'done',
      '[ -n "$tmpl" ] || exit 9',
      'd=$(dirname "$tmpl")',
      'b=$(basename "$tmpl")',
      'stem=${b%".%(ext)s"}',
      ': > "$d/$stem.mp4"',
      `printf '%s' '{"width":640,"height":360,"vcodec":"h264","acodec":"aac","duration":12}' > "$d/$stem.info.json"`,
      ': > "$d/$stem.webp"',
      'exit 0',
      '',
    ].join('\n'),
  );
  const gallerydl_stub = stub(
    'stub-gallery-dl',
    [
      '#!/bin/sh',
      'd=""',
      'while [ $# -gt 0 ]; do',
      '  if [ "$1" = "-D" ]; then shift; d="$1"; fi',
      '  shift',
      'done',
      '[ -n "$d" ] || exit 9',
      'mkdir -p "$d"',
      ': > "$d/001.jpg"',
      ': > "$d/002.jpg"',
      'exit 0',
      '',
    ].join('\n'),
  );
  process.env.HEARTH_YTDLP_BIN = ytdlp_stub;
  process.env.HEARTH_GALLERYDL_BIN = gallerydl_stub;
  const g3_quality: QualityDecision = {
    format_selector: 'best',
    target_height: 1080,
    container: 'mp4',
    needs_recode: false,
    audio_only: false,
    over_cap: false,
    reason: 'smoke',
  };

  /**
   * Hostile titles that all reach a FOLDER name, because the Music/Audio album
   * slot falls to the title: an apostrophe (the reported case), a non-ASCII
   * letter, yt-dlp's `%` template char, the SMB-reserved `?` `:` `"` `|` `*`
   * `<` `>`, the characters the old allowlist happened to keep (`&`) and the ones
   * it silently ate (`+`, `!`), emoji, CJK, the `[]` id delimiter, a dot, and a
   * title that sanitises away entirely.
   */
  const HOSTILE: Array<{ id: string; title: string }> = [
    { id: 'mi_g3aa01', title: "Don't Stop" },
    { id: 'mi_g3aa02', title: 'Café Del Mar' },
    { id: 'mi_g3aa03', title: '100% Pure' },
    { id: 'mi_g3aa04', title: 'Who? What!' },
    { id: 'mi_g3aa05', title: 'Album: The Return' },
    { id: 'mi_g3aa06', title: 'Rock & Roll + More' },
    { id: 'mi_g3aa07', title: 'a"b|c*d<e>f' },
    { id: 'mi_g3aa08', title: '😀 emoji 😀' },
    { id: 'mi_g3aa09', title: '千と千尋の神隠し' },
    { id: 'mi_g3aa10', title: 'Nine [Deluxe]' },
    { id: 'mi_g3aa11', title: 'Vol. 2' },
    { id: 'mi_g3aa12', title: '. . .' },
    { id: 'mi_g3aa13', title: 'x'.repeat(300) },
  ];

  let g3_off_schema = 0;
  let g3_idempotent = 0;
  let g3_e2e = 0;
  let g3_on_disk = 0;
  for (const { id, title } of HOSTILE) {
    // A Music item, so the title reaches the FOLDER as well as the filename —
    // the case the second sanitiser mangled.
    const input: MediaTaxonomyInput = { media_kind: 'song', creator: 'Rebecca Black', title };
    const segs = media_folder_segments(input);
    const canonical_dir = media_canonical_dir(input, false);
    // 1. the directory `dest_dir` resolves, archive-relative.
    const writer_dir = _writer_dest_dir_rel(g3_root, segs);
    eq(writer_dir, canonical_dir, `writer dir === taxonomy dir for ${JSON.stringify(title.slice(0, 24))}`);
    // 2. the same segments cleaned TWICE are the same segments — the writer
    //    re-applies `media_safe_segment`, so non-idempotence would reintroduce
    //    the divergence with a single rule instead of two.
    if (JSON.stringify(segs.map(media_safe_segment)) === JSON.stringify(segs)) g3_idempotent += 1;
    // 3. …and the whole path, through the REAL download_media.
    const res = await download_media({
      url: 'https://example.invalid/x',
      source: 'yt-dlp',
      quality: g3_quality,
      folder_segments: segs,
      archive_root: g3_root,
      id,
      title,
    });
    if (res.nas_path === media_canonical_path(res.nas_path, input, id)) g3_e2e += 1;
    else console.error(`  ✗ writer wrote ${JSON.stringify(res.nas_path)}, taxonomy wants ${JSON.stringify(media_canonical_path(res.nas_path, input, id))}`);
    if (!is_off_schema(res.nas_path, input, id)) g3_off_schema += 1;
    else console.error(`  ✗ freshly downloaded ${id} is reported off-schema`);
    // The bytes are really there, under a name the kernel accepted verbatim —
    // this is what makes the comparison about the FILESYSTEM and not two string
    // builders agreeing with each other.
    if (existsSync(join(g3_root, res.nas_path))) g3_on_disk += 1;
  }
  assert(g3_e2e === HOSTILE.length, `all ${HOSTILE.length} hostile titles: download_media's nas_path === media_canonical_path`);
  assert(g3_off_schema === HOSTILE.length, `all ${HOSTILE.length}: a FRESHLY archived item is NOT off-schema (the bug: a new download reported misfiled)`);
  assert(g3_on_disk === HOSTILE.length, `all ${HOSTILE.length}: the file exists on disk at exactly the stored path`);
  assert(g3_idempotent === HOSTILE.length, `all ${HOSTILE.length}: media_safe_segment is idempotent (applying the ONE rule twice is still one rule)`);

  // A cordoned item, since `Private/` is prepended to the segments the writer gets.
  const g3_priv_input: MediaTaxonomyInput = { media_kind: 'song', creator: 'MewSlut', title: "Don't Stop" };
  const g3_priv_segs = [MEDIA_PRIVATE_SEGMENT, ...media_folder_segments(g3_priv_input)];
  const g3_priv = await download_media({
    url: 'https://example.invalid/p',
    source: 'yt-dlp',
    quality: g3_quality,
    folder_segments: g3_priv_segs,
    archive_root: g3_root,
    id: 'mi_g3priv1',
    title: g3_priv_input.title,
  });
  eq(
    g3_priv.nas_path,
    media_canonical_path(g3_priv.nas_path, g3_priv_input, 'mi_g3priv1'),
    'a CORDONED download agrees too (the Private/ prefix is part of the path both build)',
  );
  assert(media_is_private_path(g3_priv.nas_path), '…and it really landed under Private/');

  // A gallery, whose nas_path is the per-item DIRECTORY — same rule, other shape.
  const g3_gal_input: MediaTaxonomyInput = { media_kind: 'image_gallery', creator: "Ann's Pics", extractor: 'reddit', title: 'Set: 100% good' };
  const g3_gal = await download_media({
    url: 'https://example.invalid/g',
    source: 'gallery-dl',
    quality: g3_quality, // unused by the gallery path — gallery-dl takes no format selector
    folder_segments: media_folder_segments(g3_gal_input),
    archive_root: g3_root,
    id: 'mi_g3gal01',
    title: g3_gal_input.title,
  });
  eq(
    g3_gal.nas_path,
    media_canonical_path(g3_gal.nas_path, g3_gal_input, 'mi_g3gal01'),
    'a GALLERY download agrees too (a directory-shaped nas_path, and an apostrophe in the CREATOR slot)',
  );
  assert(!is_off_schema(g3_gal.nas_path, g3_gal_input, 'mi_g3gal01'), '…and is not reported off-schema either');

  // ── the hostile class, applied to a DIRECTORY segment ─────────────────────
  // Defect 2: `<>:"|?*` were stripped from a filename for the stated SMB reason
  // and NOT from a folder, on a live CIFS mount where `mapposix` makes a reserved
  // character in a folder name silently unreadable to every other client. One
  // class for both components now, so each character is pinned in BOTH.
  let dir_reserved = 0;
  let stem_reserved = 0;
  for (const c of ['<', '>', ':', '"', '|', '?', '*', '%']) {
    const seg = media_safe_segment(`Album${c}Two`);
    const stem = media_canonical_stem('mi_x', `Album${c}Two`);
    if (!seg.includes(c) && seg.length > 0) dir_reserved += 1;
    else console.error(`  ✗ a directory segment kept the reserved ${JSON.stringify(c)}: ${JSON.stringify(seg)}`);
    if (!stem.includes(c)) stem_reserved += 1;
  }
  assert(dir_reserved === 8, 'every Windows/SMB-reserved char + the yt-dlp %-template char is stripped from a DIRECTORY segment');
  assert(stem_reserved === 8, '…and from a filename stem — one hostile class, both components');
  // The documented asymmetry, pinned in BOTH directions so it stays deliberate:
  // a filename loses `.` `[` `]` for NAME-PARSING reasons that do not apply to a
  // directory, and a directory keeps them because stripping them would corrupt a
  // measured hostname (`sickjunk.com`) and mangle a real album name.
  eq(media_safe_segment('sickjunk.com'), 'sickjunk.com', 'a directory KEEPS its dots — the site slot is a measured hostname');
  eq(media_safe_segment('Nine [Deluxe]'), 'Nine [Deluxe]', 'a directory KEEPS brackets — there is no id to delimit in a folder name');
  eq(media_canonical_stem('mi_x', 'sickjunk.com'), 'sickjunk com [mi_x]', '…while a STEM loses dots (the stem/extension split must stay unambiguous)');
  eq(media_canonical_stem('mi_x', 'Nine [Deluxe]'), 'Nine Deluxe [mi_x]', '…and brackets (the id delimiter is ours alone)');
  eq(media_safe_segment('. . .'), MEDIA_UNKNOWN_SEGMENT, "a segment of only dots+spaces is the placeholder, never '.' (which resolve() would collapse — a permanent off-schema)");
  eq(media_safe_segment('Trailing dot. '), 'Trailing dot', 'a trailing dot AND a trailing space are dropped (both illegal in an SMB name)');

  delete process.env.HEARTH_YTDLP_BIN;
  delete process.env.HEARTH_GALLERYDL_BIN;
  rmSync(g3_tmp, { recursive: true, force: true });

  // ══ H. the tool: dry-run default, apply, idempotence, prune ═══════════════
  console.log('\nH. rescan_media_metadata facet:\'taxonomy\'');

  process.env.HEARTH_MEDIA_ARCHIVE = '1';
  const tmp = mkdtempSync(join(tmpdir(), 'smoke-media-taxonomy-'));
  const vault = join(tmp, 'vault');
  const archive_root = join(tmp, 'archive');
  mkdirSync(vault, { recursive: true });
  mkdirSync(archive_root, { recursive: true });
  const db = open_db(join(tmp, 'hearth.db'));
  const memory = new MemoryClient({ vault_root: vault, db });

  const note_path = (id: string): string => `MediaArchive/2026-07-29-${id}.md`;
  const touch = (rel: string, body = 'x'): void => {
    const abs = join(archive_root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };

  /** Write a media_item note + its on-disk artefacts at the (mis)filed path. */
  function seed(args: {
    id: string;
    name: string;
    nas_path: string;
    media_kind: string;
    creator?: string;
    source_site: string;
    source_url?: string;
    published_at?: string;
    private_to: string;
    nsfw?: boolean;
    /** stamp review provenance (the un-private license) on the note */
    reviewed?: boolean;
    thumb_ext?: string;
    captions?: string[];
    gallery?: number;
  }): void {
    const fm: Record<string, unknown> = {
      type: 'media_item',
      id: args.id,
      name: args.name,
      media_kind: args.media_kind,
      source_site: args.source_site,
      nsfw: args.nsfw ?? false,
      nas_path: args.nas_path,
      private_to: args.private_to,
      tags: [],
      archived_at: '2026-07-29T00:00:00Z',
      ...(args.creator !== undefined ? { creator: args.creator } : {}),
      ...(args.source_url !== undefined ? { source_url: args.source_url } : {}),
      ...(args.published_at !== undefined ? { published_at: args.published_at } : {}),
      ...(args.reviewed
        ? { review: { source: 'vl', frames_reviewed: 8, at: '2026-08-10T00:00:00Z' } }
        : {}),
    };
    // Sidecars share the media file's STEM, whatever it is — derived from the
    // seeded `nas_path` rather than rebuilt from the id, so a fixture can be
    // seeded in either shape (legacy `<id>` or canonical `<title> [<id>]`) just by
    // writing the path it should have. That is what lets the already-canonical
    // controls below stay canonical on BOTH axes.
    const seg = media_normalize_path(args.nas_path).split('/');
    const stem = media_split_entry_name(seg[seg.length - 1] ?? '').stem;
    if (args.gallery !== undefined) {
      // gallery: nas_path IS the per-item directory
      for (let i = 1; i <= args.gallery; i++) touch(`${args.nas_path}/00${i}.jpg`);
      fm.thumbnail_path = `${args.nas_path}/001.jpg`;
      fm.image_count = args.gallery;
    } else {
      touch(args.nas_path);
      touch(`${media_dir_of(args.nas_path)}/${stem}.info.json`, '{}');
      if (args.thumb_ext) {
        const t = `${media_dir_of(args.nas_path)}/${stem}.${args.thumb_ext}`;
        touch(t);
        fm.thumbnail_path = t;
      }
      if (args.captions) {
        fm.captions = args.captions.map((lang) => {
          const p = `${media_dir_of(args.nas_path)}/${stem}.${lang}.srt`;
          touch(p, 'WEBVTT');
          return { lang, path: p, format: 'srt' };
        });
      }
    }
    memory.upsert_note(note_path(args.id), fm, `## Summary\n\n${args.name}.\n`);
  }

  // Three real defect shapes + one already-canonical control + a gallery.
  seed({
    id: 'mi_pluralv',
    name: 'Brutal facefuck',
    nas_path: 'Private/Videos/XHamster/luke49/mi_pluralv.mp4',
    media_kind: 'clip',
    creator: 'luke49',
    source_site: 'XHamster',
    source_url: 'https://xhamster.com/videos/brutal-facefuck-13141253',
    private_to: 'jasper',
    nsfw: true,
    thumb_ext: 'webp',
    captions: ['en'],
  });
  seed({
    id: 'mi_sitekid',
    name: 'You told me',
    nas_path: 'Private/PornHub/MewSlut/mi_sitekid.mp4',
    media_kind: 'other',
    creator: 'MewSlut',
    source_site: 'PornHub',
    source_url: 'https://www.pornhub.com/view_video.php?viewkey=652ba8f9738a7',
    private_to: 'jasper',
    nsfw: true,
    thumb_ext: 'jpg',
  });
  seed({
    id: 'mi_deeptit',
    name: 'Me at the zoo',
    nas_path: 'Video/YouTube/jawed/2005/mi_deeptit.mp4',
    media_kind: 'clip',
    creator: 'jawed',
    source_site: 'youtube',
    published_at: '2005-04-24',
    private_to: 'household',
    thumb_ext: 'webp',
  });
  // The two controls are canonical on BOTH axes — right folder AND a filename that
  // carries the name — so they must stay untouched. Seeded at the derived stem
  // rather than a hand-typed one, so this stays true if the stem shape ever moves.
  seed({
    id: 'mi_canonic',
    name: 'Lower back pain',
    nas_path: `Video/YouTube/Xtine Cardenas/${media_canonical_stem('mi_canonic', 'Lower back pain')}.mp4`,
    media_kind: 'tutorial',
    creator: 'Xtine Cardenas',
    source_site: 'youtube',
    published_at: '2026-06-13',
    private_to: 'household',
  });
  seed({
    id: 'mi_gallery',
    name: 'A photoset',
    nas_path: `Images/Reddit/someuser/${media_canonical_stem('mi_gallery', 'A photoset')}`,
    media_kind: 'image_gallery',
    creator: 'someuser',
    source_site: 'reddit',
    private_to: 'household',
    gallery: 3,
  });
  await rebuild(vault, memory, db);

  const tool = make_rescan_media_metadata(archive_root);
  type U = { id: string; tier: 'owner' | 'household' | 'friend' };
  const owner: U = { id: 'jasper', tier: 'owner' };
  const friend: U = { id: 'kim', tier: 'friend' };
  const ctx_for = (user: U): ToolContext =>
    ({ memory, llm: null, now: new Date(), intent_id: 'tax-smoke', specialist_id: 'kate', user }) as unknown as ToolContext;
  const run = (input: Record<string, unknown>, user: U = owner) =>
    tool.execute(tool.input_schema.parse(input), ctx_for(user));
  const fm_of = (id: string): Record<string, unknown> =>
    (memory.read_note(note_path(id))?.frontmatter ?? {}) as Record<string, unknown>;

  // ── H1. dry run is the DEFAULT ─────────────────────────────────────────────
  const dry = await run({ facet: 'taxonomy' });
  assert(dry.applied === false, 'apply defaults to FALSE — a filesystem migration is opt-in');
  assert(dry.scanned === 5, `sweep scanned all 5 items (got ${dry.scanned})`);
  eq(
    (dry.taxonomy ?? []).map((m) => m.item_id).sort(),
    ['mi_deeptit', 'mi_pluralv', 'mi_sitekid'],
    'the 3 misfiled items are reported; the canonical item + gallery are not',
  );
  assert((dry.taxonomy ?? []).every((m) => m.moved === false), 'dry run moved nothing');
  assert(/DRY RUN/.test(dry.message), 'the message says it was a dry run');
  const plan = new Map((dry.taxonomy ?? []).map((m) => [m.item_id, m]));
  eq(plan.get('mi_pluralv')?.to, 'Private/Video/XHamster/luke49', 'plural Videos → Video, inside Private');
  eq(plan.get('mi_sitekid')?.to, 'Private/Other/PornHub/MewSlut', 'the site regains its slot below the kind');
  eq(plan.get('mi_deeptit')?.to, 'Video/YouTube/jawed', 'the extra depth is dropped');
  // The plan carries the FULL before→after path, because the filename is part of
  // the taxonomy now and this report is what the owner approves.
  eq(
    plan.get('mi_pluralv')?.to_path,
    'Private/Video/XHamster/luke49/Brutal facefuck [mi_pluralv].mp4',
    'the plan names the FILE the item will become, not just its folder',
  );
  eq(
    plan.get('mi_pluralv')?.from_path,
    'Private/Videos/XHamster/luke49/mi_pluralv.mp4',
    '…alongside the path it has now',
  );
  assert(
    [...plan.values()].every((m) => m.renamed === true),
    'all three are renames as well as moves (their files carried no name)',
  );
  assert(
    /Brutal facefuck \[mi_pluralv\]\.mp4/.test(dry.message),
    "Kate's own dry-run copy shows the new filename, so the owner can approve it",
  );
  assert(
    existsSync(join(archive_root, 'Private/Videos/XHamster/luke49/mi_pluralv.mp4')),
    'dry run left every file exactly where it was',
  );

  // ── H2. the tier gate ──────────────────────────────────────────────────────
  let refused = false;
  try {
    await run({ facet: 'taxonomy' }, friend);
  } catch (err) {
    refused = /TIER_FORBIDDEN/.test((err as Error).message);
  }
  assert(refused, 'a friend-tier caller is refused (mass filesystem mutation)');

  // ── H3. apply ──────────────────────────────────────────────────────────────
  const applied = await run({ facet: 'taxonomy', apply: true });
  assert(applied.applied === true, 'apply:true reports applied');
  assert((applied.taxonomy ?? []).length === 3 && (applied.taxonomy ?? []).every((m) => m.moved), 'all 3 items moved');
  const pluralv_dir = 'Private/Video/XHamster/luke49';
  const pluralv_stem = 'Brutal facefuck [mi_pluralv]';
  assert(
    existsSync(join(archive_root, `${pluralv_dir}/${pluralv_stem}.mp4`)),
    'the media file is at its canonical path, under its canonical NAME',
  );
  assert(
    existsSync(join(archive_root, `${pluralv_dir}/${pluralv_stem}.webp`)) &&
      existsSync(join(archive_root, `${pluralv_dir}/${pluralv_stem}.info.json`)) &&
      existsSync(join(archive_root, `${pluralv_dir}/${pluralv_stem}.en.srt`)),
    'every sidecar (thumb / info.json / .srt) moved with it AND was renamed onto the same stem',
  );
  assert(
    !existsSync(join(archive_root, `${pluralv_dir}/mi_pluralv.mp4`)) &&
      !existsSync(join(archive_root, `${pluralv_dir}/mi_pluralv.info.json`)),
    'and nothing was left behind under the old id-only name',
  );
  eq(fm_of('mi_pluralv').nas_path, `${pluralv_dir}/${pluralv_stem}.mp4`, 'nas_path rewritten on the NOTE');
  eq(fm_of('mi_pluralv').thumbnail_path, `${pluralv_dir}/${pluralv_stem}.webp`, 'thumbnail_path rewritten');
  eq(
    (fm_of('mi_pluralv').captions as Array<{ path: string }>)[0]?.path,
    `${pluralv_dir}/${pluralv_stem}.en.srt`,
    'caption track paths rewritten',
  );
  assert(!existsSync(join(archive_root, 'Private/Videos')), 'the emptied `Private/Videos` tree was pruned');
  assert(!existsSync(join(archive_root, 'Video/YouTube/jawed/2005')), 'the emptied `2005` directory was pruned');
  assert(
    existsSync(join(archive_root, 'Video/YouTube/jawed/Me at the zoo [mi_deeptit].mp4')),
    'the item survived one level up',
  );
  assert(existsSync(join(archive_root, 'Private')), 'the surviving `Private` root was NOT pruned');
  assert(
    existsSync(join(archive_root, 'Video/YouTube/Xtine Cardenas/Lower back pain [mi_canonic].mp4')),
    'the already-canonical item was never touched',
  );
  assert(
    existsSync(join(archive_root, 'Images/Reddit/someuser/A photoset [mi_gallery]/001.jpg')),
    'the gallery (canonical on both axes) was never touched',
  );
  // Cordon: nothing escaped Private/, and nothing entered it.
  assert(
    media_is_private_path(String(fm_of('mi_pluralv').nas_path)) &&
      media_is_private_path(String(fm_of('mi_sitekid').nas_path)) &&
      !media_is_private_path(String(fm_of('mi_deeptit').nas_path)),
    'every item kept the cordon it had — no widening, no accidental hiding',
  );

  // ── H4. idempotence ────────────────────────────────────────────────────────
  await rebuild(vault, memory, db); // reproject so the rows carry the new paths
  const again = await run({ facet: 'taxonomy', apply: true });
  eq(again.taxonomy ?? [], [], 'a second apply finds nothing to do (idempotent)');
  assert(/every one is filed in the folder it belongs in/.test(again.message), 'and says so plainly');

  // ── H5. a single named item, and a gallery re-file ──────────────────────────
  seed({
    id: 'mi_galmove',
    name: 'A misfiled set',
    nas_path: 'Photos/reddit/otheruser/mi_galmove',
    media_kind: 'photoset',
    creator: 'otheruser',
    source_site: 'reddit',
    private_to: 'household',
    gallery: 2,
  });
  await rebuild(vault, memory, db);
  const one_dry = await run({ facet: 'taxonomy', item: 'mi_galmove' });
  eq(one_dry.taxonomy?.[0]?.to, 'Images/Reddit/otheruser', "'Photos' → the canonical 'Images', site re-cased");
  assert(one_dry.applied === false && one_dry.taxonomy?.[0]?.moved === false, 'a single-item run is a dry run too');
  const one_apply = await run({ facet: 'taxonomy', item: 'mi_galmove', apply: true });
  assert(one_apply.taxonomy?.[0]?.moved === true, 'the named gallery moved');
  const galmove_dir = 'Images/Reddit/otheruser/A misfiled set [mi_galmove]';
  assert(
    existsSync(join(archive_root, `${galmove_dir}/001.jpg`)) &&
      existsSync(join(archive_root, `${galmove_dir}/002.jpg`)),
    'the whole per-item gallery DIRECTORY moved with its images, and the DIRECTORY was renamed',
  );
  eq(fm_of('mi_galmove').nas_path, galmove_dir, 'the gallery nas_path (a directory) was rewritten');
  eq(
    fm_of('mi_galmove').thumbnail_path,
    `${galmove_dir}/001.jpg`,
    "the gallery poster path was rewritten — the DIRECTORY renamed, gallery-dl's own image name untouched",
  );
  assert(!existsSync(join(archive_root, 'Photos')), "the emptied 'Photos' tree was pruned");
  await rebuild(vault, memory, db);
  const one_again = await run({ facet: 'taxonomy', item: 'mi_galmove', apply: true });
  assert(one_again.skipped === true, 'a named already-canonical item reports skipped');

  // ── H5b. the explicit FLAG folds an open-tree item into Private/ ───────────
  // The mi_nxphtmm4 shape (2026-08-10): thumbnail read SFW at classify time so
  // the download landed in the open tree; the final keyframe verdict flipped the
  // flag. The write path now folds at filing time; THIS is the repair for items
  // filed before that existed — the flag alone makes the row off-schema, and the
  // sweep is what moves the bytes in. Tighten-only: the two controls right after
  // pin that the prefix is only ever ADDED.
  const fbflip_stem = media_canonical_stem('mi_fbflip1', 'what kind of breakfast');
  seed({
    id: 'mi_fbflip1',
    name: 'what kind of breakfast',
    // Canonical FOLDER and canonical NAME — the missing cordon is the only
    // off-schema axis, so this pins that the flag alone triggers the move.
    nas_path: `Video/Facebook/Amelias Matrix/${fbflip_stem}.mp4`,
    media_kind: 'clip',
    creator: 'Amelias Matrix',
    source_site: 'facebook',
    private_to: 'jasper',
    nsfw: true,
    thumb_ext: 'jpg',
  });
  await rebuild(vault, memory, db);
  const fold_dry = await run({ facet: 'taxonomy', item: 'mi_fbflip1' });
  eq(
    fold_dry.taxonomy?.[0]?.to,
    'Private/Video/Facebook/Amelias Matrix',
    'a flag-true open-tree item derives its home under Private/ (same folder, cordoned)',
  );
  const fold_apply = await run({ facet: 'taxonomy', item: 'mi_fbflip1', apply: true });
  assert(fold_apply.taxonomy?.[0]?.moved === true, 'the explicit item moved into Private/');
  const fbflip_dir = 'Private/Video/Facebook/Amelias Matrix';
  assert(
    existsSync(join(archive_root, `${fbflip_dir}/${fbflip_stem}.mp4`)) &&
      existsSync(join(archive_root, `${fbflip_dir}/${fbflip_stem}.jpg`)),
    'the media file AND its thumbnail are under Private/',
  );
  assert(
    !existsSync(join(archive_root, 'Video/Facebook')),
    'the emptied open-tree Facebook dir was pruned',
  );
  eq(fm_of('mi_fbflip1').nas_path, `${fbflip_dir}/${fbflip_stem}.mp4`, 'nas_path rewritten under Private/');
  await rebuild(vault, memory, db);
  const fold_again = await run({ facet: 'taxonomy', item: 'mi_fbflip1', apply: true });
  assert(fold_again.skipped === true, 'the folded item is canonical now (idempotent, no Private/Private)');
  // Tighten-only, stated as derivation: an already-Private flag-true path gains
  // nothing (no double prefix)…
  eq(
    media_canonical_path(
      `${fbflip_dir}/${fbflip_stem}.mp4`,
      { media_kind: 'clip', creator: 'Amelias Matrix', extractor: 'facebook', title: 'what kind of breakfast', nsfw: true },
      'mi_fbflip1',
    ),
    `${fbflip_dir}/${fbflip_stem}.mp4`,
    'flag-true + already Private → the same path (never Private/Private)',
  );
  // …and a flag-FALSE item that sits under Private/ STAYS there — the flag can
  // add the prefix, never remove it (an uncertain thumbnail an SFW keyframe
  // later cleared is the accepted fail-closed shape).
  const sfwpriv_stem = media_canonical_stem('mi_sfwpriv', 'Harmless clip');
  seed({
    id: 'mi_sfwpriv',
    name: 'Harmless clip',
    nas_path: `Private/Video/YouTube/someone/${sfwpriv_stem}.mp4`,
    media_kind: 'clip',
    creator: 'someone',
    source_site: 'youtube',
    private_to: 'jasper',
  });
  await rebuild(vault, memory, db);
  const keep_priv = await run({ facet: 'taxonomy', item: 'mi_sfwpriv' });
  assert(
    keep_priv.skipped === true,
    'a flag-false UNREVIEWED item under Private/ is NOT reported — no provenance, no un-private',
  );
  // …but the same shape WITH review provenance is licensed out (owner
  // 2026-08-10: no auto-private — a discerned-safe item belongs in the open).
  const unfold_stem = media_canonical_stem('mi_unfold1', 'Cleared clip');
  seed({
    id: 'mi_unfold1',
    name: 'Cleared clip',
    nas_path: `Private/Video/YouTube/someone/${unfold_stem}.mp4`,
    media_kind: 'clip',
    creator: 'someone',
    source_site: 'youtube',
    private_to: 'jasper',
    reviewed: true,
  });
  await rebuild(vault, memory, db);
  const unfold_dry = await run({ facet: 'taxonomy', item: 'mi_unfold1' });
  eq(
    unfold_dry.taxonomy?.[0]?.to,
    'Video/YouTube/someone',
    'a reviewed flag-false item under Private/ derives its home in the OPEN tree',
  );
  const unfold_apply = await run({ facet: 'taxonomy', item: 'mi_unfold1', apply: true });
  assert(unfold_apply.taxonomy?.[0]?.moved === true, 'the reviewed-safe item moved out of Private/');
  assert(
    existsSync(join(archive_root, `Video/YouTube/someone/${unfold_stem}.mp4`)),
    '…and its bytes really live in the open tree now',
  );
  eq(
    fm_of('mi_unfold1').nas_path,
    `Video/YouTube/someone/${unfold_stem}.mp4`,
    'nas_path repointed out of Private/',
  );

  // ── H5c. the DIRECTED move: "put this under X" sticks ─────────────────────
  // Owner 2026-08-10: "can you allow me to talk to Kate and ask her to move
  // things elsewhere?" facet:'move' pins the destination and re-files through
  // the same machinery; the pin is what stops the next tidy sweep from
  // "repairing" the move right back.
  const dirmove_stem = media_canonical_stem('mi_dirmov1', 'Directed move clip');
  seed({
    id: 'mi_dirmov1',
    name: 'Directed move clip',
    nas_path: `Video/YouTube/mover/${dirmove_stem}.mp4`,
    media_kind: 'clip',
    creator: 'mover',
    source_site: 'youtube',
    private_to: 'jasper',
    thumb_ext: 'webp',
  });
  await rebuild(vault, memory, db);
  const move_noto = await run({ facet: 'move', item: 'mi_dirmov1' });
  assert(
    move_noto.found === false && /destination/.test(move_noto.message),
    'a move without a destination asks for one instead of guessing',
  );
  const move_escape = await run({ facet: 'move', item: 'mi_dirmov1', to: '../outside' });
  assert(
    move_escape.skipped === true && /usable destination/.test(move_escape.message),
    'a destination escaping the archive root is refused',
  );
  const move_done = await run({ facet: 'move', item: 'mi_dirmov1', to: 'Video/Concerts' });
  assert(move_done.taxonomy?.[0]?.moved === true, 'the directed move happened immediately');
  assert(
    existsSync(join(archive_root, `Video/Concerts/${dirmove_stem}.mp4`)) &&
      existsSync(join(archive_root, `Video/Concerts/${dirmove_stem}.webp`)),
    'media + sidecars live at the directed destination',
  );
  eq(fm_of('mi_dirmov1').placement, 'Video/Concerts', 'the destination is pinned on the note');
  eq(fm_of('mi_dirmov1').nas_path, `Video/Concerts/${dirmove_stem}.mp4`, 'nas_path repointed');
  await rebuild(vault, memory, db);
  const sweep_after_move = await run({ facet: 'taxonomy', apply: true });
  assert(
    !(sweep_after_move.taxonomy ?? []).some((m) => m.item_id === 'mi_dirmov1'),
    'the tidy sweep RESPECTS the pin — a hand-placed item is not "repaired" back',
  );
  // A flagged item pinned OUTSIDE Private/: the owner's word outranks the
  // cordon-prefix rule (his archive), and the sweep still leaves it alone.
  const move_out = await run({ facet: 'move', item: 'mi_fbflip1', to: 'Video/Kept' });
  assert(move_out.taxonomy?.[0]?.moved === true, 'an nsfw-flagged item moves out of Private/ on a directed pin');
  assert(
    existsSync(join(archive_root, `Video/Kept/${fbflip_stem}.mp4`)),
    '…and its bytes really left Private/',
  );
  await rebuild(vault, memory, db);
  const sweep_after_out = await run({ facet: 'taxonomy', apply: true });
  assert(
    !(sweep_after_out.taxonomy ?? []).some((m) => m.item_id === 'mi_fbflip1'),
    'the sweep leaves the pinned flagged item where the owner put it',
  );
  // to:'auto' un-pins — the flag takes over again and it re-files to Private/.
  const move_auto = await run({ facet: 'move', item: 'mi_fbflip1', to: 'auto' });
  assert(move_auto.taxonomy?.[0]?.moved === true, "to:'auto' un-pins and re-files to the derived home");
  assert(
    existsSync(join(archive_root, `${fbflip_dir}/${fbflip_stem}.mp4`)),
    '…which for a flagged item is back under Private/',
  );
  assert(fm_of('mi_fbflip1').placement === null, 'the pin is cleared on the note');
  let move_refused = false;
  try {
    await run({ facet: 'move', item: 'mi_dirmov1', to: 'Video/Elsewhere' }, friend);
  } catch (err) {
    move_refused = /TIER_FORBIDDEN/.test((err as Error).message);
  }
  assert(move_refused, 'a friend-tier caller cannot direct moves');

  // ── H6. two items into ONE directory is normal; a name clash is not ────────
  seed({
    id: 'mi_twin001',
    name: 'Me at the zoo (audio)',
    nas_path: 'Video/YouTube/jawed/Me at the zoo/mi_twin001.m4a',
    media_kind: 'clip',
    creator: 'jawed',
    source_site: 'youtube',
    published_at: '2005-04-24',
    private_to: 'household',
  });
  await rebuild(vault, memory, db);
  const twin = await run({ facet: 'taxonomy', item: 'mi_twin001', apply: true });
  assert(twin.taxonomy?.[0]?.moved === true, 'a second item files into the SAME canonical directory');
  assert(
    existsSync(join(archive_root, 'Video/YouTube/jawed/Me at the zoo (audio) [mi_twin001].m4a')) &&
      existsSync(join(archive_root, 'Video/YouTube/jawed/Me at the zoo [mi_deeptit].mp4')),
    'both items now share Video/YouTube/jawed — no collision, that is the grouping',
  );

  // A genuine clash: the same id already present at the target. Never overwrite.
  seed({
    id: 'mi_clash01',
    name: 'Clasher',
    nas_path: 'Videos/YouTube/clashchan/mi_clash01.mp4',
    media_kind: 'clip',
    creator: 'clashchan',
    source_site: 'youtube',
    private_to: 'household',
  });
  // The clash has to occupy the name the migration is going to WRITE, which is the
  // canonical stem — not the old id-only one, which nothing wants any more.
  touch('Video/YouTube/clashchan/Clasher [mi_clash01].mp4', 'PRE-EXISTING');
  await rebuild(vault, memory, db);
  const clash = await run({ facet: 'taxonomy', item: 'mi_clash01', apply: true });
  assert(
    /already present at the target/.test(clash.taxonomy?.[0]?.note ?? ''),
    'a name clash at the target is reported, not silently overwritten',
  );
  assert(
    existsSync(join(archive_root, 'Videos/YouTube/clashchan/mi_clash01.mp4')),
    'the clashing source file is left in place (no data loss)',
  );
  eq(
    fm_of('mi_clash01').nas_path,
    'Videos/YouTube/clashchan/mi_clash01.mp4',
    'and its nas_path still points at the file that actually exists',
  );
  assert(
    readFileSync(join(archive_root, 'Video/YouTube/clashchan/Clasher [mi_clash01].mp4'), 'utf8') === 'PRE-EXISTING',
    "…and the occupant's bytes were never overwritten",
  );

  // ── H7. an item with no note is refused, not fabricated ────────────────────
  const orphan_note = note_path('mi_orphan1');
  seed({
    id: 'mi_orphan1',
    name: 'Orphan',
    nas_path: 'Videos/YouTube/orphanch/mi_orphan1.mp4',
    media_kind: 'clip',
    creator: 'orphanch',
    source_site: 'youtube',
    private_to: 'household',
  });
  await rebuild(vault, memory, db);
  rmSync(join(vault, orphan_note), { force: true });
  const orphan = await run({ facet: 'taxonomy', item: 'mi_orphan1', apply: true });
  assert(
    /no context note/.test(orphan.taxonomy?.[0]?.note ?? ''),
    'an item whose note is gone is refused (the note is the source of truth)',
  );
  assert(
    existsSync(join(archive_root, 'Videos/YouTube/orphanch/mi_orphan1.mp4')),
    'and its files are untouched',
  );

  // ── H7b. RENAME IN PLACE: the right folder, a nameless file ────────────────
  // This is the DOMINANT live case — five of the seven rows on the LLM host are in the
  // folder they belong in and simply don't carry their own name, which the old
  // directory-only off-schema rule called "correctly filed" forever. A rename with
  // no move has to work with no source directory to prune and no move to make.
  seed({
    id: 'mi_rename1',
    name: 'Nightcall at Stade de France',
    nas_path: 'Video/YouTube/renamechan/mi_rename1.mp4',
    media_kind: 'clip',
    creator: 'renamechan',
    source_site: 'youtube',
    published_at: '2024-08-11',
    private_to: 'jasper',
    thumb_ext: 'webp',
    captions: ['en', 'en-orig'],
  });
  await rebuild(vault, memory, db);
  const ren_dry = await run({ facet: 'taxonomy', item: 'mi_rename1' });
  const ren_plan = ren_dry.taxonomy?.[0];
  eq(ren_plan?.from, 'Video/YouTube/renamechan', 'a rename-only item reports the same from-directory…');
  eq(ren_plan?.to, 'Video/YouTube/renamechan', '…and the same to-directory');
  assert(ren_plan?.renamed === true, '…and is flagged as a RENAME');
  eq(
    ren_plan?.to_path,
    'Video/YouTube/renamechan/Nightcall at Stade de France [mi_rename1].mp4',
    '…with the full new path, which is the only thing that actually changes',
  );
  const ren = await run({ facet: 'taxonomy', item: 'mi_rename1', apply: true });
  assert(ren.taxonomy?.[0]?.moved === true, 'the rename is performed');
  const ren_stem = 'Nightcall at Stade de France [mi_rename1]';
  assert(
    existsSync(join(archive_root, `Video/YouTube/renamechan/${ren_stem}.mp4`)) &&
      existsSync(join(archive_root, `Video/YouTube/renamechan/${ren_stem}.webp`)) &&
      existsSync(join(archive_root, `Video/YouTube/renamechan/${ren_stem}.info.json`)) &&
      existsSync(join(archive_root, `Video/YouTube/renamechan/${ren_stem}.en.srt`)) &&
      existsSync(join(archive_root, `Video/YouTube/renamechan/${ren_stem}.en-orig.srt`)),
    'every artefact was renamed in place — including BOTH caption tracks (`en` and `en-orig`)',
  );
  assert(
    existsSync(join(archive_root, 'Video/YouTube/renamechan')),
    'the directory it renamed inside was NOT pruned (it is the target as well as the source)',
  );
  eq(fm_of('mi_rename1').nas_path, `Video/YouTube/renamechan/${ren_stem}.mp4`, 'nas_path repointed');
  eq(
    (fm_of('mi_rename1').captions as Array<{ lang: string; path: string }>).map((c) => c.path),
    [
      `Video/YouTube/renamechan/${ren_stem}.en.srt`,
      `Video/YouTube/renamechan/${ren_stem}.en-orig.srt`,
    ],
    'both caption paths repointed (the `en-orig` tail is why the stem splits at the FIRST dot)',
  );
  await rebuild(vault, memory, db);
  const ren_again = await run({ facet: 'taxonomy', item: 'mi_rename1', apply: true });
  assert(ren_again.skipped === true, 'a re-run finds nothing to do — the rename is idempotent');

  // ── H8. the captions facet still works (the facet slot is additive) ─────────
  const caps = await run({ facet: 'captions' });
  assert(/Which item/.test(caps.message) && caps.facet === 'captions', "facet defaults + 'captions' still routes");
  const killed = await (async () => {
    process.env.HEARTH_MEDIA_ARCHIVE = '0';
    const r = await run({ facet: 'taxonomy' });
    process.env.HEARTH_MEDIA_ARCHIVE = '1';
    return r;
  })();
  assert(killed.enabled === false, 'the HEARTH_MEDIA_ARCHIVE kill switch no-ops the taxonomy facet');

  // Nothing stranded outside the closed vocabulary (bar the cordon prefix).
  const tops = readdirSync(archive_root).sort();
  const stray = tops.filter(
    (t) => t !== 'Private' && !(MEDIA_TOP_LEVELS as readonly string[]).includes(t),
  );
  eq(stray, ['Videos'], 'the only off-vocabulary top level left is the deliberate clash/orphan fixture');

  // ══ I. the repair path's hostile cases ════════════════════════════════════
  // This facet exists to repair MESSY LEGACY state, so its inputs are exactly the
  // ones the current writer cannot produce. Each case below was a silent failure.
  console.log('\nI. messy legacy paths, the archive root, and fail-open');

  // ── I1. a stored path spelled differently from its own derived directory ────
  // `under()` used to collapse only backslashes, so a `./x` or `x//y` nas_path
  // moved its files and then failed to match its own `from_dir`: the frontmatter
  // was never rewritten and NO later sweep could repair it (permanent DB/disk
  // divergence, reported forever as "no files found at the old path").
  seed({
    id: 'mi_dotslas',
    name: 'Dot slash',
    nas_path: './Videos/YouTube/dotchan/mi_dotslas.mp4',
    media_kind: 'clip',
    creator: 'dotchan',
    source_site: 'youtube',
    private_to: 'household',
    thumb_ext: 'webp',
  });
  seed({
    id: 'mi_dblslas',
    name: 'Double slash',
    nas_path: 'Videos/YouTube//dblchan/mi_dblslas.mp4',
    media_kind: 'clip',
    creator: 'dblchan',
    source_site: 'youtube',
    private_to: 'household',
  });
  await rebuild(vault, memory, db);
  for (const [id, chan, name] of [
    ['mi_dotslas', 'dotchan', 'Dot slash'],
    ['mi_dblslas', 'dblchan', 'Double slash'],
  ] as const) {
    const r = await run({ facet: 'taxonomy', item: id, apply: true });
    const m = r.taxonomy?.[0];
    assert(m?.moved === true, `${id}: a messy legacy spelling still moves`);
    const want = `Video/YouTube/${chan}/${name} [${id}].mp4`;
    eq(fm_of(id).nas_path, want, `${id}: nas_path is REWRITTEN (and normalised)`);
    assert(existsSync(join(archive_root, want)), `${id}: the file is at the new path`);
    assert(m?.unresolved === undefined, `${id}: and the item is not reported as a problem`);
  }
  eq(
    fm_of('mi_dotslas').thumbnail_path,
    'Video/YouTube/dotchan/Dot slash [mi_dotslas].webp',
    'the sidecar path is normalised too',
  );
  assert(
    media_normalize_path('./a//b\\c/') === 'a/b/c' && media_normalize_path(undefined) === '',
    'media_normalize_path is the one spelling: forward slashes, no doubles, no dot segments',
  );

  // ── I2. an item filed at the archive ROOT is re-filed ──────────────────────
  // `media_dir_of` is '' for BOTH an absent path and a root-filed one, so the
  // off-schema rule used to declare `mi_x.mp4` canonical forever.
  seed({
    id: 'mi_rootfil',
    name: 'At the root',
    nas_path: 'mi_rootfil.mp4',
    media_kind: 'clip',
    creator: 'rootchan',
    source_site: 'youtube',
    private_to: 'household',
  });
  await rebuild(vault, memory, db);
  const rooted = await run({ facet: 'taxonomy', item: 'mi_rootfil', apply: true });
  eq(rooted.taxonomy?.[0]?.from, '', 'a root-filed item reports an empty from-directory');
  eq(rooted.taxonomy?.[0]?.to, 'Video/YouTube/rootchan', '…and the directory it belongs in');
  eq(
    fm_of('mi_rootfil').nas_path,
    'Video/YouTube/rootchan/At the root [mi_rootfil].mp4',
    'the root-filed item was re-filed',
  );
  assert(existsSync(archive_root), 'and the archive ROOT itself was never pruned');
  assert(
    !is_off_schema(undefined, { media_kind: 'clip' }, 'mi_x') &&
      !is_off_schema('   ', { media_kind: 'clip' }, 'mi_x'),
    'an ABSENT stored path is still exempt (nothing to move)',
  );

  // ── I3. fail-open: a poisoned note write cannot abort the sweep ────────────
  // Before: `upsert_note` threw, the whole sweep threw, ZERO audit rows were
  // written, and files had already moved — Kate got a raw tool error and could
  // not tell Jasper what had moved.
  const real_upsert = memory.upsert_note.bind(memory);
  let poison: string | null = null;
  (memory as unknown as { upsert_note: typeof real_upsert }).upsert_note = (p, fm, body) => {
    if (poison !== null && p === poison) throw new Error('EROFS: vault read-only');
    return real_upsert(p, fm, body);
  };
  for (const id of ['mi_poison1', 'mi_healthy1', 'mi_healthy2']) {
    seed({
      id,
      name: `Sweep ${id}`,
      nas_path: `Videos/YouTube/sweepchan/${id}.mp4`,
      media_kind: 'clip',
      creator: 'sweepchan',
      source_site: 'youtube',
      private_to: 'household',
    });
  }
  await rebuild(vault, memory, db);
  const audit_count = (): number =>
    (db.query("SELECT COUNT(*) AS n FROM audit_log WHERE tool_name = 'media_taxonomy_rescan'").get() as { n: number }).n;
  const audit_before = audit_count();
  poison = note_path('mi_poison1');
  let swept: Awaited<ReturnType<typeof run>> | null = null;
  let threw = false;
  try {
    swept = await run({ facet: 'taxonomy', apply: true });
  } catch {
    threw = true;
  }
  poison = null;
  assert(!threw, 'a poisoned note write does NOT throw the sweep away');
  const by_id = new Map((swept?.taxonomy ?? []).map((m) => [m.item_id, m]));
  assert(by_id.get('mi_poison1')?.moved === true, 'the poisoned item’s files DID move (reported honestly)');
  assert(by_id.get('mi_poison1')?.unresolved === true, '…and it is flagged unresolved');
  assert(
    /couldn’t update the note/.test(by_id.get('mi_poison1')?.note ?? ''),
    '…with a note saying the frontmatter write failed and a re-run will finish it',
  );
  for (const ok of ['mi_healthy1', 'mi_healthy2']) {
    assert(by_id.get(ok)?.moved === true, `${ok}: the other items in the sweep still completed`);
    eq(
      fm_of(ok).nas_path,
      `Video/YouTube/sweepchan/Sweep ${ok} [${ok}].mp4`,
      `${ok}: its nas_path was rewritten`,
    );
  }
  assert(audit_count() === audit_before + 1, 'the audit row of what moved was written despite the failure');
  eq(fm_of('mi_poison1').nas_path, 'Videos/YouTube/sweepchan/mi_poison1.mp4', 'the poisoned note still holds the OLD path (honest, not silently patched)');
  // …and the migration stays idempotent: a re-run heals it.
  await rebuild(vault, memory, db);
  const healed = await run({ facet: 'taxonomy', item: 'mi_poison1', apply: true });
  eq(
    fm_of('mi_poison1').nas_path,
    'Video/YouTube/sweepchan/Sweep mi_poison1 [mi_poison1].mp4',
    'a re-run HEALS the interrupted item',
  );
  assert(healed.taxonomy?.[0]?.unresolved === undefined, '…and stops reporting it as a problem');
  assert(
    !/Couldn’t fully handle/.test(healed.message),
    'a heal is not reported as a failure (the "no files found at the old path" case is a SUCCESS)',
  );

  // ── I4. an unreadable / missing note is refused, but only when it matters ───
  seed({
    id: 'mi_nonote1',
    name: 'Canonical but noteless',
    nas_path: `Video/YouTube/notechan/${media_canonical_stem('mi_nonote1', 'Canonical but noteless')}.mp4`,
    media_kind: 'clip',
    creator: 'notechan',
    source_site: 'youtube',
    private_to: 'household',
  });
  await rebuild(vault, memory, db);
  rmSync(join(vault, note_path('mi_nonote1')), { force: true });
  const noteless = await run({ facet: 'taxonomy', item: 'mi_nonote1', apply: true });
  assert(
    noteless.skipped === true && (noteless.taxonomy ?? []).length === 0,
    'a CANONICAL item whose note vanished is not reported as a problem every sweep',
  );

  // ── I5. segment truncation never emits a lone surrogate ───────────────────
  const round_trips = (s: string): boolean => new TextDecoder().decode(new TextEncoder().encode(s)) === s;
  // Pre-fix this sliced 80 UTF-16 CODE UNITS, keeping only the emoji's HIGH
  // surrogate — a deterministic string that is not valid UTF-8, so the stored
  // `nas_path` and the name the kernel receives (U+FFFD substituted) differed.
  const kept = media_safe_segment(`${'x'.repeat(79)}😀`);
  assert(round_trips(kept), 'a 79-char name + emoji is valid UTF-8 (no lone surrogate)');
  assert(Array.from(kept).length === 80 && Array.from(kept).pop() === '😀', '…and the emoji survives WHOLE at the 80-character cap');
  const dropped = media_safe_segment(`${'x'.repeat(80)}😀`);
  assert(round_trips(dropped) && dropped === 'x'.repeat(80), 'a name cut ON the emoji drops the whole character, never half of it');
  const emoji = media_safe_segment('😀'.repeat(100));
  assert(round_trips(emoji), 'an all-emoji name round-trips through UTF-8');
  assert(
    new TextEncoder().encode(emoji).length <= 200 && Array.from(emoji).length <= 80,
    `an all-emoji name honours BOTH the char and the byte cap (${new TextEncoder().encode(emoji).length} bytes)`,
  );
  assert(media_safe_segment('a‮b') === 'ab', 'a bidi override is stripped, not carried into a folder name');
  assert(media_safe_segment('a​b﻿') === 'ab', 'zero-width space + BOM are stripped');

  db.close();
  rmSync(tmp, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n❌ smoke:media-taxonomy — ${failures} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`\n✅ smoke:media-taxonomy — ${passed} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
