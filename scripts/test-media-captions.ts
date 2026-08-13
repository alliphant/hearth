/**
 * smoke:media-captions — Kate's rescan_media_metadata tool + the subtitle
 * connector + the SRT→VTT serve conversion (Media Archive captions, 2026-07-13).
 *
 * Self-contained (temp vault + db + archive root, real MemoryClient + ingestor
 * projector, subtitle transport STUBBED — no yt-dlp, no network):
 *   - owner rescans by id → captions land on the note frontmatter
 *   - resolve by TITLE too
 *   - idempotent: a second run with captions present + no refetch is a no-op
 *   - refetch:true re-pulls
 *   - empty transport result → note untouched + honest "no captions"
 *   - a throwing transport → note untouched + honest failure
 *   - cordon: a member resolving an owner-only item gets nothing (404-shape)
 *   - gallery / missing-source guards
 *   - kill switch (HEARTH_MEDIA_ARCHIVE=0) → enabled:false
 *   - scan_subtitle_tracks filename→lang parse (real files)
 *   - srt_to_vtt conversion
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { rebuild } from '@ingestor/rebuild';
import type { ToolContext } from '@core/tool';
import {
  _test_set_subtitle_transport,
  scan_subtitle_tracks,
  type SubtitleFetchArgs,
} from '@connectors/media_download';
import { media_canonical_stem } from '@core/media/taxonomy';
import { _test_set_comment_transport } from '@connectors/media_chapter_mining';
import { srt_to_vtt } from '@app/routes/media';
import { make_rescan_media_metadata } from '../src/specialists/kate/tools/rescan_media_metadata';

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

async function main() {
  process.env.HEARTH_MEDIA_ARCHIVE = '1';
  // Chapter mining is seamed off here — this smoke is about captions and must
  // stay hermetic (chapters have their own smoke).
  _test_set_comment_transport(async () => []);
  const tmp = mkdtempSync(join(tmpdir(), 'smoke-media-captions-'));
  const vault = join(tmp, 'vault');
  const archive_root = join(tmp, 'archive');
  mkdirSync(vault, { recursive: true });
  mkdirSync(archive_root, { recursive: true });
  process.env.HEARTH_MEDIA_ARCHIVE_ROOT = archive_root;
  const db = open_db(join(tmp, 'hearth.db'));
  const memory = new MemoryClient({ vault_root: vault, db });

  function write_note(
    id: string,
    name: string,
    opts: { nas_path?: string; private_to: string; nsfw?: boolean; media_kind?: string; source_url?: string | null },
  ): void {
    const fm: Record<string, unknown> = {
      type: 'media_item',
      id,
      name,
      media_kind: opts.media_kind ?? 'clip',
      source_site: 'youtube',
      ...(opts.source_url === null ? {} : { source_url: opts.source_url ?? `https://youtu.be/${id}` }),
      nsfw: opts.nsfw ?? false,
      duration_s: 100,
      container: 'mp4',
      archived_at: '2026-07-13T00:00:00Z',
      ...(opts.nas_path ? { nas_path: opts.nas_path } : {}),
      private_to: opts.private_to,
      tags: [],
    };
    memory.upsert_note(`MediaArchive/2026-07-13-${id}.md`, fm, `## Summary\n${name}.`);
  }

  // A household clip, an owner-only NSFW clip, a gallery, and a clip with no source.
  write_note('mi_house1', 'The Big Talk', { nas_path: 'Video/YouTube/Ch/mi_house1.mp4', private_to: 'household' });
  write_note('mi_priv01', 'Private Reel', { nas_path: 'Private/adult/mi_priv01.mp4', private_to: 'jasper', nsfw: true });
  write_note('mi_gal001', 'A Photoset', { nas_path: 'Images/x/mi_gal001', private_to: 'household', media_kind: 'image_gallery' });
  write_note('mi_nosrc0', 'Sourceless', { nas_path: 'Video/YouTube/Ch/mi_nosrc0.mp4', private_to: 'household', source_url: null });
  await rebuild(vault, memory, db);

  const tool = make_rescan_media_metadata(archive_root);
  type U = { id: string; tier: 'owner' | 'household' };
  const owner: U = { id: 'jasper', tier: 'owner' };
  const member: U = { id: 'sam', tier: 'household' };
  const ctx_for = (user: U) =>
    ({ memory, llm: null, now: new Date(), intent_id: 'cap-smoke', specialist_id: 'kate', user }) as unknown as ToolContext;
  const run = (input: Record<string, unknown>, user: U = owner) =>
    tool.execute(tool.input_schema.parse(input), ctx_for(user));

  // A transport stub that records its args (in a ref so control-flow doesn't
  // narrow it to null) and returns configurable tracks.
  const cap: { args: SubtitleFetchArgs | null } = { args: null };
  const stub = (tracks: Array<{ lang: string; auto?: boolean }>) =>
    _test_set_subtitle_transport(async (args) => {
      cap.args = args;
      return {
        captions: tracks.map((t) => ({
          lang: t.lang,
          path: `${args.dir_abs.replace(resolve(archive_root) + '/', '')}/${args.stem}.${t.lang}.srt`,
          format: 'srt',
          ...(t.auto !== undefined ? { auto: t.auto } : {}),
        })),
      };
    });

  const captions_on = (id: string): Array<{ lang: string }> => {
    const note = memory.read_note(`MediaArchive/2026-07-13-${id}.md`);
    const caps = (note?.frontmatter as { captions?: unknown } | undefined)?.captions;
    return Array.isArray(caps) ? (caps as Array<{ lang: string }>) : [];
  };

  // ── A. owner rescans by id → captions land, correct args ─────────────────
  stub([{ lang: 'en' }, { lang: 'es', auto: true }]);
  const r1 = await run({ item: 'mi_house1' });
  assert(r1.found && !r1.skipped && r1.fetched_langs.join(',') === 'en,es', 'owner rescan by id fetches en+es');
  assert(cap.args?.langs === 'en.*', 'default langs = en.*');
  assert(cap.args?.url === 'https://youtu.be/mi_house1', 'passes the item source_url');
  assert(cap.args?.stem === 'mi_house1' && !!cap.args?.dir_abs.endsWith('/Video/YouTube/Ch'), 'derives stem + dir from nas_path');
  assert(captions_on('mi_house1').map((c) => c.lang).join(',') === 'en,es', 'captions written to the note frontmatter');

  // ── B. resolve by TITLE ──────────────────────────────────────────────────
  stub([{ lang: 'en' }]);
  const r2 = await run({ item: 'the big talk' });
  assert(r2.found && r2.item_id === 'mi_house1', 'resolves by title (case-insensitive)');

  // ── C. idempotent: present + no refetch = skip ───────────────────────────
  cap.args = null;
  const r3 = await run({ item: 'mi_house1' });
  assert(r3.found && r3.skipped && cap.args === null, 'already-captioned + no refetch = skip, no fetch');

  // ── D. refetch:true re-pulls (and merges a new lang) ─────────────────────
  stub([{ lang: 'fr' }]);
  const r4 = await run({ item: 'mi_house1', refetch: true });
  assert(r4.fetched_langs.join(',') === 'fr' && captions_on('mi_house1').map((c) => c.lang).join(',') === 'en,es,fr', 'refetch merges a new lang (en,es,fr)');

  // ── E. empty transport → untouched + honest ──────────────────────────────
  stub([]);
  const r5 = await run({ item: 'mi_priv01' });
  assert(r5.found && r5.fetched_langs.length === 0 && /no captions/i.test(r5.message), 'no source captions → honest, note untouched');
  assert(captions_on('mi_priv01').length === 0, 'empty result leaves the note without captions');

  // ── F. throwing transport → untouched + honest failure ───────────────────
  _test_set_subtitle_transport(async () => { throw new Error('network boom'); });
  const r6 = await run({ item: 'mi_priv01' });
  assert(r6.found && r6.fetched_langs.length === 0 && /fail/i.test(r6.message), 'a fetch error is reported, note untouched');
  assert(captions_on('mi_priv01').length === 0, 'failed fetch never writes captions');

  // ── G. cordon: a member can't resolve an owner-only item ─────────────────
  stub([{ lang: 'en' }]);
  const r7 = await run({ item: 'mi_priv01' }, member);
  assert(!r7.found && /couldn.t find/i.test(r7.message), 'member resolving an owner-only item → not found (cordon)');
  const r7b = await run({ item: 'mi_house1' }, member);
  assert(r7b.found, 'member CAN resolve a household item');

  // ── H. guards: gallery + missing source ──────────────────────────────────
  const r8 = await run({ item: 'mi_gal001' });
  assert(r8.found && !r8.skipped && r8.fetched_langs.length === 0 && /gallery/i.test(r8.message), 'image gallery is rejected honestly');
  const r9 = await run({ item: 'mi_nosrc0' });
  assert(r9.found && /source url/i.test(r9.message), 'missing source_url is refused honestly');

  // ── I. kill switch ───────────────────────────────────────────────────────
  process.env.HEARTH_MEDIA_ARCHIVE = '0';
  const r10 = await run({ item: 'mi_house1' });
  assert(!r10.enabled && !r10.found, 'HEARTH_MEDIA_ARCHIVE=0 → disabled, no work');
  process.env.HEARTH_MEDIA_ARCHIVE = '1';

  // ── J. scan_subtitle_tracks filename→lang parse (real files) ─────────────
  const sdir = join(archive_root, 'Video/YouTube/Ch');
  mkdirSync(sdir, { recursive: true });
  writeFileSync(join(sdir, 'mi_scan01.en.srt'), 'x');
  writeFileSync(join(sdir, 'mi_scan01.en-US.srt'), 'x');
  writeFileSync(join(sdir, 'mi_scan01.mp4'), 'x'); // must be ignored
  writeFileSync(join(sdir, 'mi_other.en.srt'), 'x'); // different stem, ignored
  const scanned = scan_subtitle_tracks(sdir, 'mi_scan01', archive_root);
  assert(scanned.map((t) => t.lang).join(',') === 'en,en-US', 'scan parses en + en-US, ignores mp4 + other stems');
  assert(scanned[0]!.path === 'Video/YouTube/Ch/mi_scan01.en.srt', 'scan returns archive-relative path');

  // ── J2. the canonical `<title> [<id>]` stem (2026-07-29) ──────────────────
  // Archived files are named after the item now, not the bare id. This facet is
  // indifferent to that BY CONSTRUCTION — `dir_and_stem` reads the stem off the
  // item's stored `nas_path` rather than rebuilding it from the id — but the stem
  // it then hands to yt-dlp goes into a `-o` template and a filename regex, so the
  // brackets and spaces are worth pinning rather than assuming.
  const titled = media_canonical_stem('mi_scan02', 'The Big Talk');
  assert(titled === 'The Big Talk [mi_scan02]', 'the canonical stem is <title> [<id>]');
  writeFileSync(join(sdir, `${titled}.en.srt`), 'x');
  writeFileSync(join(sdir, `${titled}.en-orig.srt`), 'x');
  writeFileSync(join(sdir, `${titled}.mp4`), 'x'); // must be ignored
  writeFileSync(join(sdir, 'The Big Talk [mi_other2].en.srt'), 'x'); // same title, other id
  const scanned2 = scan_subtitle_tracks(sdir, titled, archive_root);
  assert(
    scanned2.map((t) => t.lang).join(',') === 'en,en-orig',
    'scan parses a bracketed titled stem (en + en-orig), ignoring the mp4 and a same-title different-id file',
  );
  assert(
    scanned2[0]!.path === `Video/YouTube/Ch/${titled}.en.srt`,
    'and returns the archive-relative path with the title intact',
  );
  // The stem is regex-escaped before it becomes a filename pattern — `[`/`]` in a
  // raw RegExp would be a character CLASS and match the wrong files (or throw).
  assert(scan_subtitle_tracks(sdir, 'The Big Talk [mi_scan02]', archive_root).length === 2, 'the bracketed stem is regex-escaped, not treated as a character class');

  // ── K. srt_to_vtt conversion ─────────────────────────────────────────────
  const srt = '1\n00:00:01,000 --> 00:00:04,500\nHello world\n';
  const vtt = srt_to_vtt(srt);
  assert(vtt.startsWith('WEBVTT\n\n'), 'VTT carries the WEBVTT header');
  assert(vtt.includes('00:00:01.000 --> 00:00:04.500'), 'SRT comma cue-times → VTT dots');
  assert(vtt.includes('Hello world'), 'cue text preserved');

  _test_set_subtitle_transport(null);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }

  console.log('─'.repeat(50));
  if (failures) { console.error(`  ✗ smoke:media-captions FAILED (${failures})`); process.exit(1); }
  console.log('  ✓ smoke:media-captions PASSED');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
