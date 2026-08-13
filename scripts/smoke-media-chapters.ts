/**
 * smoke:media-chapters — chapter mining (media_chapter_mining) + the
 * `chapters` facet of Kate's rescan_media_metadata tool.
 *
 * Hermetic: the comment transport is STUBBED (no yt-dlp, no network), temp
 * vault + db + archive root, real MemoryClient + ingestor projector.
 *
 *   - the parser: leading / trailing / inline forms, h:mm:ss, end_s chaining
 *   - the rejections that matter (too few, out of range, non-monotonic,
 *     early-only, untitled) — no chapters beats WRONG chapters on a scrubber
 *   - ranking: the most-thumbed-up valid comment wins; a pin breaks a tie
 *   - description beats comments (the uploader's own list is more trustworthy)
 *   - the LIVE fixture: the real top comment from the South Arcade K! Pit set
 *     (the video that motivated this — no chapter bar, setlist in a comment)
 *   - the tool: mines onto the note, idempotent, refetch re-derives, honest
 *     when nothing is found, cordon-checked, captions facet left alone
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { rebuild } from '@ingestor/rebuild';
import type { ToolContext } from '@core/tool';
import type { MediaChapter, ChapterProvenance } from '@core/media/types';
import {
  parse_chapter_index,
  timestamp_to_seconds,
  pick_comment_chapters,
  mine_chapters,
  chapter_credit,
  _test_set_comment_transport,
  type MinedComment,
} from '@connectors/media_chapter_mining';
import { _test_set_subtitle_transport } from '@connectors/media_download';
import { make_rescan_media_metadata } from '../src/specialists/kate/tools/rescan_media_metadata';

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

/**
 * CAPTURED LIVE, 2026-07-31 — the real top comment on
 * https://www.youtube.com/watch?v=dUGf-I_nq-E (SOUTH ARCADE live in The K! Pit,
 * duration 1698s, ZERO official chapters, 151 comments). 101 thumbs-up.
 * Do not hand-edit to make a test pass — recapture it.
 */
const SOUTH_ARCADE_COMMENT = `0:59 HOW 2 GET AWAY WITH MURDER
4:17 FEAR OF HEIGHTS
7:38 Supermodels
11:01 Drive Myself Home
15:26 SUPERMAN
20:37 2005
24:45 stone cold summer`;
const SOUTH_ARCADE_DURATION = 1698;

async function main() {
  process.env.HEARTH_MEDIA_ARCHIVE = '1';
  delete process.env.HEARTH_MEDIA_CHAPTER_MINING;

  // ── A. timestamp parsing ────────────────────────────────────────────────
  console.log('\nA. timestamp_to_seconds');
  assert(timestamp_to_seconds('0:59') === 59, 'm:ss');
  assert(timestamp_to_seconds('24:45') === 1485, 'mm:ss');
  assert(timestamp_to_seconds('1:02:03') === 3723, 'h:mm:ss');
  assert(timestamp_to_seconds('1:75') === null, 'rejects seconds > 59');
  assert(timestamp_to_seconds('1:99:00') === null, 'rejects minutes > 59 in h:mm:ss');
  assert(timestamp_to_seconds('45') === null, 'rejects a bare number');

  // ── B. the live fixture ─────────────────────────────────────────────────
  console.log('\nB. the South Arcade live fixture');
  const sa = parse_chapter_index(SOUTH_ARCADE_COMMENT, SOUTH_ARCADE_DURATION);
  assert(sa?.length === 7, 'parses all 7 songs from the real top comment');
  assert(sa?.[0]?.start_s === 59 && sa?.[0]?.title === 'HOW 2 GET AWAY WITH MURDER', 'first entry (does NOT need to start at 0:00 — which is why YouTube never made it a chapter bar)');
  assert(sa?.[0]?.end_s === 257, 'end_s chains to the next start');
  assert(sa?.[6]?.start_s === 1485 && sa?.[6]?.end_s === 1698, 'last chapter ends at the duration');
  assert(sa?.[3]?.title === 'Drive Myself Home', 'titles survive intact');

  // ── C. formats ──────────────────────────────────────────────────────────
  console.log('\nC. parse formats');
  const dashed = parse_chapter_index('0:00 - Intro\n5:00 – Middle bit\n9:30 — The end', 600);
  assert(dashed?.length === 3 && dashed[1]?.title === 'Middle bit', 'leading form, separators stripped');
  const bracketed = parse_chapter_index('[0:00] Intro\n[5:00] Middle\n[9:30] End', 600);
  assert(bracketed?.length === 3 && bracketed[0]?.title === 'Intro', 'bracketed timestamps');
  const trailing = parse_chapter_index('Intro 0:00\nMiddle 5:00\nThe end 9:30', 600);
  assert(trailing?.length === 3 && trailing[2]?.title === 'The end', 'trailing form (title first)');
  const inline = parse_chapter_index('setlist: 0:00 Intro 5:00 Middle 9:30 End', 600);
  assert(inline?.length === 3 && inline[1]?.title === 'Middle', 'run-on single-paragraph form');
  const longform = parse_chapter_index('0:00 Cold open\n1:05:00 Act two\n1:50:00 Wrap', 7200);
  assert(longform?.length === 3 && longform[1]?.start_s === 3900, 'h:mm:ss in a long talk');

  // ── D. the rejections ───────────────────────────────────────────────────
  console.log('\nD. rejections (no chapters beats wrong chapters)');
  assert(parse_chapter_index('0:00 Intro\n5:00 Outro', 600) === null, 'fewer than 3 entries');
  assert(parse_chapter_index('0:00 a\n5:00 b\n99:00 c', 600) === null, 'a timestamp past the duration');
  assert(parse_chapter_index('0:00 a\n5:00 b\n2:00 c', 600) === null, 'non-monotonic (commentary, not an index)');
  assert(parse_chapter_index('0:10 a\n0:20 b\n0:30 c', 3600) === null, 'all entries in the first third — not an index of the whole thing');
  assert(parse_chapter_index('0:00\n5:00\n9:30', 600) === null, 'bare times with no titles');
  assert(parse_chapter_index('', 600) === null, 'empty text');
  assert(parse_chapter_index('0:00 a\n5:00 b\n9:30 c', 0) === null, 'unknown duration → cannot validate');
  assert(
    parse_chapter_index('this song at 3:20 is unreal, and 3:20 again later, plus 1:10', 600) === null,
    'a chatty comment quoting moments is not a setlist',
  );

  // ── E. ranking by corroboration ─────────────────────────────────────────
  console.log('\nE. ranking');
  const valid_a = '0:00 Alpha\n5:00 Bravo\n9:00 Charlie';
  const valid_b = '0:00 One\n5:00 Two\n9:00 Three';
  const pool: MinedComment[] = [
    { id: 'c1', text: 'first!', like_count: 9000, author: '@noise' },
    { id: 'c2', text: valid_a, like_count: 12, author: '@few' },
    { id: 'c3', text: valid_b, like_count: 340, author: '@many' },
  ];
  const picked = pick_comment_chapters(pool, 600);
  assert(picked?.provenance.author === '@many', 'the most thumbed-up VALID index wins (a popular non-index is ignored)');
  assert(picked?.provenance.like_count === 340 && picked?.provenance.from === 'comment', 'provenance carries the corroboration');
  assert(picked?.chapters[0]?.title === 'One', 'the winning comment supplies the chapters');
  const tie = pick_comment_chapters(
    [
      { id: 'p1', text: valid_a, like_count: 50, author: '@plain' },
      { id: 'p2', text: valid_b, like_count: 50, author: '@pinned', is_pinned: true },
    ],
    600,
  );
  assert(tie?.provenance.author === '@pinned' && tie?.provenance.pinned === true, 'an uploader pin breaks a like tie');
  const by_up = pick_comment_chapters(
    [
      { id: 'v', text: valid_a, like_count: 9999, author: '@viewer' },
      { id: 'u', text: valid_b, like_count: 3, author: '@theband', by_uploader: true },
    ],
    600,
  );
  assert(by_up?.provenance.by_uploader === true && by_up.provenance.author === '@theband', 'the UPLOADER’s own list outranks a far more upvoted viewer list');
  assert(pick_comment_chapters([{ text: 'nice' }, { text: 'cool' }], 600) === null, 'no valid index → null, never a guess');
  assert(/101 👍/.test(chapter_credit({ from: 'comment', author: '@a', like_count: 101 })), 'credit line names the thumbs-up');
  assert(chapter_credit({ from: 'description' }) === 'the video description', 'credit line for a description list');

  // ── F. mine_chapters source order + gates ───────────────────────────────
  console.log('\nF. mine_chapters');
  _test_set_comment_transport(async () => [{ id: 'x', text: valid_b, like_count: 999, author: '@cmt' }]);
  const both = await mine_chapters({ url: 'u', duration_s: 600, description: valid_a });
  assert(both?.provenance.from === 'description' && both.chapters[0]?.title === 'Alpha', 'the description beats a comment (uploader > viewer)');
  const cmt_only = await mine_chapters({ url: 'u', duration_s: 600, description: 'just a normal description' });
  assert(cmt_only?.provenance.from === 'comment' && cmt_only.provenance.author === '@cmt', 'falls through to comments when the description has no index');
  assert((await mine_chapters({ url: 'u', duration_s: 120 })) === null, 'below the duration floor → skipped (short clips are not mined)');
  // A 9-minute index can't validate against a 2-minute clip, so force needs an
  // index that actually fits — which is the range check doing its job.
  _test_set_comment_transport(async () => [{ id: 's', text: '0:00 One\n0:40 Two\n1:30 Three', like_count: 7, author: '@short' }]);
  assert((await mine_chapters({ url: 'u', duration_s: 120, force: true }))?.provenance.from === 'comment', 'force bypasses the floor (an explicit ask)');
  assert((await mine_chapters({ url: 'u' })) === null, 'no duration → skipped');
  _test_set_comment_transport(async () => { throw new Error('yt-dlp exploded'); });
  assert((await mine_chapters({ url: 'u', duration_s: 600 })) === null, 'a throwing fetch is fail-soft (never fails the archive job)');
  process.env.HEARTH_MEDIA_CHAPTER_MINING = '0';
  _test_set_comment_transport(async () => [{ text: valid_b, like_count: 5 }]);
  assert((await mine_chapters({ url: 'u', duration_s: 600 })) === null, 'kill switch HEARTH_MEDIA_CHAPTER_MINING=0');
  delete process.env.HEARTH_MEDIA_CHAPTER_MINING;

  // ── G. the tool facet ───────────────────────────────────────────────────
  console.log('\nG. rescan_media_metadata facet:chapters');
  const tmp = mkdtempSync(join(tmpdir(), 'smoke-media-chapters-'));
  const vault = join(tmp, 'vault');
  const archive_root = join(tmp, 'archive');
  mkdirSync(vault, { recursive: true });
  mkdirSync(archive_root, { recursive: true });
  process.env.HEARTH_MEDIA_ARCHIVE_ROOT = archive_root;
  const db = open_db(join(tmp, 'hearth.db'));
  const memory = new MemoryClient({ vault_root: vault, db });

  const note_path = (id: string) => `MediaArchive/2026-07-31-${id}.md`;
  function write_note(id: string, name: string, opts: { private_to: string; duration_s?: number; description?: string }): void {
    memory.upsert_note(
      note_path(id),
      {
        type: 'media_item',
        id,
        name,
        media_kind: 'live_set',
        source_site: 'youtube',
        source_url: `https://youtu.be/${id}`,
        nsfw: false,
        duration_s: opts.duration_s ?? SOUTH_ARCADE_DURATION,
        container: 'mp4',
        archived_at: '2026-07-31T00:00:00Z',
        nas_path: `Video/YouTube/Ch/${id}.mp4`,
        private_to: opts.private_to,
        tags: [],
        ...(opts.description !== undefined ? { metrics: { description: opts.description } } : {}),
      },
      `## Summary\n${name}.`,
    );
  }
  write_note('mi_arcade', 'SOUTH ARCADE live in The K! Pit', { private_to: 'household' });
  write_note('mi_ownset', 'A Private Mix', { private_to: 'jasper' });
  write_note('mi_hasdsc', 'Talk With An Index', { private_to: 'household', description: 'A chat.\n0:00 Hello\n10:00 Middle\n20:00 Goodbye', duration_s: 1500 });
  write_note('mi_nodur0', 'Unknown Length', { private_to: 'household', duration_s: 0 });
  await rebuild(vault, memory, db);

  const tool = make_rescan_media_metadata(archive_root);
  type U = { id: string; tier: 'owner' | 'household' };
  const owner: U = { id: 'jasper', tier: 'owner' };
  const member: U = { id: 'sam', tier: 'household' };
  const run = (input: Record<string, unknown>, user: U = owner) =>
    tool.execute(
      tool.input_schema.parse(input),
      ({ memory, llm: null, now: new Date(), intent_id: 'chap-smoke', specialist_id: 'kate', user }) as unknown as ToolContext,
    );
  const chapters_on = (id: string): MediaChapter[] => {
    const fm = memory.read_note(note_path(id))?.frontmatter as { chapters?: unknown } | undefined;
    return Array.isArray(fm?.chapters) ? (fm.chapters as MediaChapter[]) : [];
  };
  const source_on = (id: string): ChapterProvenance | undefined =>
    (memory.read_note(note_path(id))?.frontmatter as { chapter_source?: ChapterProvenance } | undefined)?.chapter_source;

  // Captions are a different facet — stub it so `all` stays hermetic here too.
  _test_set_subtitle_transport(async () => ({ captions: [] }));
  let fetch_calls = 0;
  _test_set_comment_transport(async () => {
    fetch_calls++;
    return [
      { id: 'noise', text: 'banger', like_count: 4000, author: '@hype' },
      { id: 'setlist', text: SOUTH_ARCADE_COMMENT, like_count: 101, author: '@chandraabudiman' },
    ];
  });

  const t1 = await run({ item: 'mi_arcade', facet: 'chapters' });
  assert(t1.found && t1.chapters === 7, 'mines the 7-song setlist onto the real-world item');
  assert(t1.chapter_source?.from === 'comment' && t1.chapter_source.like_count === 101, 'reports the comment + its thumbs-up so Kate credits it honestly');
  assert(chapters_on('mi_arcade').length === 7, 'chapters written to the note frontmatter');
  assert(source_on('mi_arcade')?.author === '@chandraabudiman', 'chapter_source persisted alongside');
  assert(/comment by @chandraabudiman/.test(t1.message) && /101/.test(t1.message), 'the message credits the commenter, not the uploader');

  const t2 = await run({ item: 'south arcade live in the k! pit', facet: 'chapters' });
  assert(t2.found && t2.item_id === 'mi_arcade', 'resolves by title');

  fetch_calls = 0;
  const t3 = await run({ item: 'mi_arcade', facet: 'chapters' });
  assert(t3.chapters === 7 && fetch_calls === 0 && /already has 7 chapters/.test(t3.message), 'idempotent: present + no refetch = no fetch');
  const t4 = await run({ item: 'mi_arcade', facet: 'chapters', refetch: true });
  assert(t4.chapters === 7 && fetch_calls === 1, 'refetch re-derives');

  const t5 = await run({ item: 'mi_hasdsc', facet: 'chapters' });
  assert(t5.chapters === 3 && t5.chapter_source?.from === 'description', 'uses the archived description when it carries an index');

  const t6 = await run({ item: 'mi_nodur0', facet: 'chapters' });
  assert(t6.found && t6.chapters === 0 && /duration/i.test(t6.message), 'no duration → honest refusal, nothing written');
  assert(chapters_on('mi_nodur0').length === 0, 'nothing written without a duration');

  _test_set_comment_transport(async () => [{ text: 'no timestamps here', like_count: 2 }]);
  const t7 = await run({ item: 'mi_ownset', facet: 'chapters' });
  assert(t7.found && t7.chapters === 0 && /couldn’t find a chapter list/i.test(t7.message), 'nothing usable → honest, never invents one');
  assert(chapters_on('mi_ownset').length === 0, 'a failed mine writes nothing');

  const t8 = await run({ item: 'mi_ownset', facet: 'chapters' }, member);
  assert(!t8.found, 'cordon: a member cannot resolve an owner-only item');

  // facet isolation both ways
  _test_set_comment_transport(async () => { fetch_calls++; return []; });
  fetch_calls = 0;
  const t9 = await run({ item: 'mi_hasdsc', facet: 'captions' });
  assert(fetch_calls === 0 && t9.facet === 'captions' && t9.chapters === undefined, 'facet:captions never mines chapters');

  process.env.HEARTH_MEDIA_ARCHIVE = '0';
  const t10 = await run({ item: 'mi_arcade', facet: 'chapters' });
  assert(!t10.enabled && !t10.found, 'kill switch: HEARTH_MEDIA_ARCHIVE=0');
  process.env.HEARTH_MEDIA_ARCHIVE = '1';

  _test_set_comment_transport(null);
  _test_set_subtitle_transport(null);
  rmSync(tmp, { recursive: true, force: true });

  console.log(failures === 0 ? '\n✅ smoke:media-chapters passed' : `\n❌ ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
