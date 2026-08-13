/**
 * smoke:media-quality — `decide_quality`, the pure format-selection decision
 * (design-media-archival.md), and the download path's failure DIAGNOSTICS.
 *
 * This module had NO test at all, which is how a selector that could match zero
 * formats shipped and stayed shipped. Hermetic: pure functions plus one stubbed
 * yt-dlp (a shell script written to a temp dir) — no network, no NAS, no real
 * yt-dlp, no ffmpeg.
 *
 *   - THE REGRESSION (2026-08-11): a generic/HTML5-embed page yields ONE format
 *     with no height (`0  mp4  unknown | https | unknown unknown`). yt-dlp's
 *     numeric filters DROP a format whose field is unknown, so the old
 *     `[height<=2160]` matched nothing and the download died "Requested format is
 *     not available" — on a plain, directly fetchable MP4. Pinned as the LIVE
 *     format shape captured off the failing job.
 *   - the cap is a preference, never a precondition: every video selector this
 *     module can emit ends in an uncapped clause, so no cap can make a
 *     downloadable item undownloadable.
 *   - the cap still BINDS when heights are known (a 2160p rep is not chosen for
 *     a 1080p cap), overrides parse ('best'/'audio'/'720p'), >1080p VP9/AV1
 *     recodes and ≤1080p H.264 does not, and the size cap flags rather than refuses
 *   - the reason line names WHICH blind spot it hit — Kate reads it verbatim
 *   - download_media's diagnostics: a format-selection failure records the
 *     selector we asked for AND the table yt-dlp offered; other failures record
 *     yt-dlp's ERROR line WHOLE (it used to be head-sliced mid-sentence)
 *
 *   bun run smoke:media-quality
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaFormat, MediaProbeResult } from '@core/media/types';
import type { ToolContext } from '@core/tool';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { decide_quality } from '@connectors/media_quality';
import { download_media, _test_set_list_formats_transport } from '@connectors/media_download';
import { make_media_archive_status } from '../src/specialists/kate/tools/media_archive_status';

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

function probe(formats: MediaFormat[], extra: Partial<MediaProbeResult> = {}): MediaProbeResult {
  return {
    source: 'yt-dlp',
    ok: true,
    id: 'x',
    title: 't',
    formats,
    ...extra,
  } as MediaProbeResult;
}

/**
 * CAPTURED LIVE, 2026-08-11 — the entire `formats[]` of job ma_cchh1m7avb6e
 * (sickjunk.com, extractor `html5`/HTML5MediaEmbed). One format, no height, no
 * width, no vcodec, no acodec, no tbr. `audio_ext: 'none'` + `video_ext: 'mp4'`
 * are the only surviving video evidence (see derive_audio_only).
 * Do not hand-edit to make a test pass — recapture it.
 */
const HTML5_EMBED_FORMATS: MediaFormat[] = [
  { format_id: '0', ext: 'mp4', audio_ext: 'none', video_ext: 'mp4' },
];

/**
 * A normal, fully-measured YouTube-shaped ladder — every rung REAL, because the
 * rungs decide which branch runs: a cap with no rep at or under it takes the
 * `fallback` path (uncapped, exercised in section 2), not the capped one.
 */
const YOUTUBE_FORMATS: MediaFormat[] = [
  { format_id: '140', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', tbr: 129 },
  { format_id: '136', ext: 'mp4', vcodec: 'avc1.4d401f', acodec: 'none', height: 720, fps: 30, tbr: 1800 },
  { format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080, fps: 30, tbr: 4400 },
  { format_id: '313', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 2160, fps: 30, tbr: 20000 },
];

async function main(): Promise<void> {
  console.log('smoke:media-quality\n');

  // ── 1. THE REGRESSION: unknown height must not be filtered out ─────────────
  console.log('1. generic/HTML5 embed — one format, no height');
  const d1 = decide_quality(probe(HTML5_EMBED_FORMATS), { max_height: 2160 });
  assert(!d1.audio_only, 'stays a VIDEO decision (audio_ext:none bears video)');
  assert(
    /height<=\?2160/.test(d1.format_selector),
    `height filter is unknown-tolerant (\`?\`) — got: ${d1.format_selector}`,
  );
  assert(
    !/height<=2160/.test(d1.format_selector),
    'no bare `height<=N` clause survives (that is the clause that matched nothing)',
  );
  assert(
    /no measurable video rep/.test(d1.reason) && /none carrying a height|none declaring a video codec/.test(d1.reason),
    `reason names the blind spot — got: ${d1.reason}`,
  );

  // ── 2. the cap is a preference: every selector ends uncapped ───────────────
  console.log('\n2. the cap can never make an item undownloadable');
  for (const cap of [720, 1080, 2160]) {
    const sel = decide_quality(probe(HTML5_EMBED_FORMATS), { max_height: cap }).format_selector;
    assert(
      sel.endsWith('/bestvideo+bestaudio/best'),
      `cap ${cap}p selector ends in an uncapped clause — got: ${sel}`,
    );
  }
  const all_over = decide_quality(
    probe([{ format_id: '313', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 4320, tbr: 40000 }]),
    { max_height: 1080 },
  );
  assert(
    all_over.format_selector === 'bestvideo+bestaudio/best',
    `every rep over the cap → uncapped selector — got: ${all_over.format_selector}`,
  );
  assert(all_over.target_height === 4320, 'and the target is the rep it will actually get');

  // ── 3. the cap still BINDS when the heights are real ───────────────────────
  console.log('\n3. a known height is still capped');
  const d3 = decide_quality(probe(YOUTUBE_FORMATS), { max_height: 1080 });
  assert(d3.target_height === 1080, `1080p cap picks the 1080p rep, not 2160p — got ${d3.target_height}`);
  assert(!d3.needs_recode, 'H.264 at 1080p → remux only, no recode');
  assert(/height<=\?1080/.test(d3.format_selector), 'and the cap is in the selector');

  const d3b = decide_quality(probe(YOUTUBE_FORMATS), { max_height: 2160 });
  assert(d3b.target_height === 2160 && d3b.needs_recode, '2160p VP9 → HEVC recode (not AVPlayer-native)');

  // ── 4. overrides ───────────────────────────────────────────────────────────
  console.log('\n4. quality overrides');
  const best = decide_quality(probe(YOUTUBE_FORMATS), { max_height: 1080, quality_override: 'best' });
  assert(best.format_selector === 'bestvideo+bestaudio/best', 'override "best" drops the cap');
  assert(best.target_height === 2160, 'and takes the top rep');
  const p720 = decide_quality(probe(YOUTUBE_FORMATS), { max_height: 2160, quality_override: '720p' });
  assert(/height<=\?720/.test(p720.format_selector), 'override "720p" caps at 720');
  assert(p720.target_height === 720, 'and targets the 720p rung, not the 4K one');
  const aud = decide_quality(probe(YOUTUBE_FORMATS), { quality_override: 'audio' });
  assert(aud.audio_only && aud.container === 'm4a', 'override "audio" → audio-only M4A');

  // ── 5. empty / malformed probe never throws ────────────────────────────────
  console.log('\n5. fail-soft');
  const empty = decide_quality(probe([]), { max_height: 2160 });
  assert(/probe returned no formats/.test(empty.reason), `empty formats says so — got: ${empty.reason}`);
  assert(empty.format_selector.includes('height<=?2160'), 'and still emits a usable selector');

  // ── 6. size cap flags, never refuses ───────────────────────────────────────
  console.log('\n6. size cap');
  const big = decide_quality(
    probe([{ format_id: '1', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 1080, filesize: 40e9 }]),
    { max_height: 2160, max_bytes: 20 * 1024 ** 3 },
  );
  assert(big.over_cap && /over/.test(big.reason), 'a 40GB rep flags over_cap');
  assert(big.format_selector.length > 0, 'and is still downloadable (flag, not refusal)');

  // ── 7. download diagnostics — what Kate reads off the ledger ───────────────
  console.log('\n7. download failure diagnostics');
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-mq-'));
  const stub = join(tmp, 'yt-dlp-stub');
  // A fake yt-dlp: exits 1 with the real message on a download, and prints a
  // format table for `-F`. Proves download_media re-asks and attaches BOTH facts.
  writeFileSync(
    stub,
    `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "-F" ]; then
    echo "ID EXT RESOLUTION | PROTO | VCODEC  ACODEC"
    echo "0  mp4 unknown    | https | unknown unknown"
    exit 0
  fi
done
echo "ERROR: [html5] stub-1: Requested format is not available. Use --list-formats for a list of available formats" >&2
exit 1
`,
    'utf8',
  );
  chmodSync(stub, 0o755);
  const prev = process.env.HEARTH_YTDLP_BIN;
  process.env.HEARTH_YTDLP_BIN = stub;

  let msg = '';
  try {
    await download_media({
      url: 'https://example.invalid/x',
      source: 'yt-dlp',
      quality: d1,
      folder_segments: ['Video', 'Stub'],
      archive_root: tmp,
      id: 'mi_stub0001',
      title: 'Stub',
    });
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  assert(/Requested format is not available/.test(msg), 'the verdict line survives whole');
  assert(msg.includes(`selector: ${d1.format_selector}`), `records the selector we asked for — got: ${msg}`);
  assert(/formats offered:[\s\S]*unknown unknown/.test(msg), 'records the table yt-dlp actually offered');

  // A non-format failure must NOT pay for the extra -F call, and must still keep
  // yt-dlp's ERROR line whole rather than head-slicing it mid-sentence.
  writeFileSync(
    stub,
    `#!/bin/sh
echo "[generic] Extracting URL: https://example.invalid/x" >&2
echo "ERROR: unable to download video data: HTTP Error 403: Forbidden (caused by <HTTPError 403: Forbidden>); please report this issue on https://github.com/yt-dlp/yt-dlp/issues" >&2
exit 1
`,
    'utf8',
  );
  chmodSync(stub, 0o755);
  let msg2 = '';
  try {
    await download_media({
      url: 'https://example.invalid/x',
      source: 'yt-dlp',
      quality: d1,
      folder_segments: ['Video', 'Stub'],
      archive_root: tmp,
      id: 'mi_stub0002',
      title: 'Stub',
    });
  } catch (err) {
    msg2 = err instanceof Error ? err.message : String(err);
  }
  assert(/caused by <HTTPError 403: Forbidden>/.test(msg2), 'the 403 line is kept whole, not cut mid-sentence');
  assert(!/formats offered/.test(msg2), 'and a non-format failure pays for no --list-formats call');

  if (prev === undefined) delete process.env.HEARTH_YTDLP_BIN;
  else process.env.HEARTH_YTDLP_BIN = prev;

  // ── 8. media_archive_status(diagnose:true) — Kate's read of all of it ──────
  // Also previously untested. The `-F` read is seamed (no network, no yt-dlp);
  // `scan_page`'s fetch of an .invalid host fails closed to [] on its own.
  console.log('\n8. media_archive_status diagnose');
  const LIVE_TABLE =
    'ID EXT RESOLUTION | PROTO | VCODEC  ACODEC\n0  mp4 unknown    | https | unknown unknown';
  _test_set_list_formats_transport(async () => LIVE_TABLE);

  const dbdir = mkdtempSync(join(tmpdir(), 'hearth-mq-db-'));
  const db = open_db(join(dbdir, 'test.db'));
  const vault = join(dbdir, 'vault');
  mkdirSync(vault, { recursive: true });
  const memory = new MemoryClient({ vault_root: vault, db });
  const status = make_media_archive_status();
  const ctx = {
    memory,
    now: new Date(),
    user: { id: 'jasper', tier: 'owner' as const },
  } as unknown as ToolContext;

  // (a) a row carrying the NEW diagnostics — the selector + table are quoted back.
  const rich = memory.media_jobs.create({
    url: 'https://example.invalid/rich',
    requested_by: 'jasper',
    private_to: 'jasper',
  });
  memory.media_jobs.update(rich.id, {
    status: 'failed',
    error: `yt-dlp download failed (exit 1): ERROR: [html5] x-1: Requested format is not available. Use --list-formats for a list of available formats\nselector: ${d1.format_selector}\nformats offered: \n${LIVE_TABLE}`,
  });
  const dx = await status.execute({ job_id: rich.id, diagnose: true }, ctx);
  assert(
    /format-selection/.test(dx.diagnosis?.classification ?? ''),
    `classified as format-selection — got: ${dx.diagnosis?.classification}`,
  );
  assert(
    (dx.diagnosis?.why ?? '').includes(d1.format_selector),
    'the why quotes the selector we actually asked for',
  );
  assert(dx.diagnosis?.formats_now === LIVE_TABLE, 'formats_now carries the live table');
  assert(/height<=\?/.test(dx.diagnosis?.next_step ?? ''), 'next step names the actual fix');
  assert(!/\n/.test(dx.report), 'the one-job report stays one line despite the multi-line error');

  // (b) a row that failed BEFORE the diagnostics existed — the live read is the
  //     only evidence, and the diagnosis has to say so rather than bluff.
  const old = memory.media_jobs.create({
    url: 'https://example.invalid/old',
    requested_by: 'jasper',
    private_to: 'jasper',
  });
  memory.media_jobs.update(old.id, {
    status: 'failed',
    error:
      'downloading failed ×3: yt-dlp download failed (exit 1): ERROR: [html5] y-1: Requested format is not available. Use --list',
  });
  const dx_old = await status.execute({ job_id: old.id, diagnose: true }, ctx);
  assert(
    /format-selection/.test(dx_old.diagnosis?.classification ?? ''),
    'a truncated legacy error still classifies correctly',
  );
  assert(dx_old.diagnosis?.formats_now === LIVE_TABLE, 'and still gets a live format table');
  assert(
    /formats_now/.test(dx_old.diagnosis?.why ?? ''),
    'the why admits the stored selector is lost and points at the live read',
  );

  // (c) the gate detector must not fire on ordinary words containing "age".
  const notgate = memory.media_jobs.create({
    url: 'https://example.invalid/page',
    requested_by: 'jasper',
    private_to: 'jasper',
  });
  memory.media_jobs.update(notgate.id, {
    status: 'failed',
    error: 'probe failed: could not find a usable image on the page; storage message unavailable',
  });
  const dx_ng = await status.execute({ job_id: notgate.id, diagnose: true }, ctx);
  assert(
    !/gated/.test(dx_ng.diagnosis?.classification ?? ''),
    `"page"/"image"/"storage"/"message" is not an age gate — got: ${dx_ng.diagnosis?.classification}`,
  );
  const dx_gate = memory.media_jobs.create({
    url: 'https://example.invalid/gate',
    requested_by: 'jasper',
    private_to: 'jasper',
  });
  memory.media_jobs.update(dx_gate.id, {
    status: 'failed',
    error: 'probe failed: this video is members-only — sign in to continue',
  });
  const dx_g = await status.execute({ job_id: dx_gate.id, diagnose: true }, ctx);
  assert(/gated/.test(dx_g.diagnosis?.classification ?? ''), 'but a real gate still reads as gated');

  _test_set_list_formats_transport(null);
  db.close();
  rmSync(dbdir, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });

  console.log(failures === 0 ? '\n✅ smoke:media-quality passed' : `\n❌ ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
