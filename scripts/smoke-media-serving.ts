/**
 * smoke:media-serving — the /api/media/* serving surface (design §7).
 *
 * Self-contained: temp vault + db + archive dir, the real create_media_router
 * mounted in-process with a fake auth middleware. No orchestrator, no network.
 * Exercises:
 *   - HTTP range: 206 + Content-Range for `bytes=start-end`, 200 + Accept-Ranges
 *     for a full GET, 416 for an unsatisfiable range, correct partial bytes
 *   - the cordon matrix: a household member gets a 404-shape (never 403-leak) on
 *     an owner-only (NSFW) item's item/stream; the owner gets it
 *   - browse (taxonomy folders, cordon-filtered), search (RAG join → cards),
 *     thumb bytes, and 401 without a user
 *
 * These are ROUTE-layer cordon tests: the fixtures below stamp `private_to`
 * directly (incl. `'household'`, the widest scope `note_visible_to_caller`
 * admits) to prove the serving layer honours whatever scope a note carries,
 * legacy rows included. The archive PIPELINE no longer assigns `'household'` to
 * anything — every item silos to its requester (owner directive 2026-07-29, see
 * @core/media/cordon and smoke:media-archive). Don't read these fixtures as
 * evidence that a shared household shelf still exists.
 *
 *   bun run smoke:media-serving
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Hono } from 'hono';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { rebuild } from '@ingestor/rebuild';
import { index_chunks } from '@app/routes/library';
import { create_media_router } from '@app/routes/media';
import type { UserConfig } from '@core/users';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

type TestUser = { id: string; tier: 'owner' | 'household' | 'friend' } | null;

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-mediasrv-'));
  const vault = join(tmp, 'vault');
  const archive_root = join(tmp, 'archive');
  mkdirSync(vault, { recursive: true });
  mkdirSync(archive_root, { recursive: true });
  const db = open_db(join(tmp, 'hearth.db'));
  const memory = new MemoryClient({ vault_root: vault, db });

  // Write a media file of known bytes under the archive so /stream can range it.
  function write_media_file(nas_path: string, size: number): void {
    const abs = resolve(archive_root, nas_path);
    mkdirSync(dirname(abs), { recursive: true });
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i++) buf[i] = i % 251;
    writeFileSync(abs, buf);
  }

  function write_media_note(
    id: string,
    name: string,
    opts: { nas_path: string; private_to: string; nsfw?: boolean; thumbnail_path?: string; body?: string },
  ): void {
    const fm: Record<string, unknown> = {
      type: 'media_item',
      id,
      name,
      media_kind: 'clip',
      source_site: 'youtube',
      source_url: `https://x/${id}`,
      creator: 'Tester',
      nsfw: opts.nsfw ?? false,
      duration_s: 120,
      container: 'mp4',
      archived_at: '2026-07-11T00:00:00Z',
      nas_path: opts.nas_path,
      private_to: opts.private_to,
      tags: [],
      metrics: { chapters: [{ start_s: 0, title: 'Intro' }] },
      ...(opts.thumbnail_path ? { thumbnail_path: opts.thumbnail_path } : {}),
    };
    const body = opts.body ?? `## Summary\nA test ${name}.\n\n## Description\n${name} synthwave archive clip.`;
    const path = `MediaArchive/2026-07-11-${id}.md`;
    memory.upsert_note(path, fm, body);
    index_chunks(db, path, body);
  }

  // Seed an image gallery: a media_item whose nas_path is a DIRECTORY + a real
  // set of image files under it + the per-image list in the frontmatter.
  function write_gallery_note(
    id: string,
    name: string,
    opts: { dir: string; private_to: string; files: string[]; nsfw?: boolean },
  ): void {
    const images = opts.files.map((file, idx) => ({ idx, file }));
    const fm: Record<string, unknown> = {
      type: 'media_item',
      id,
      name,
      media_kind: 'image_gallery',
      source_site: 'reddit',
      source_url: `https://x/${id}`,
      creator: 'Tester',
      nsfw: opts.nsfw ?? false,
      archived_at: '2026-07-11T00:00:00Z',
      nas_path: opts.dir,
      thumbnail_path: `${opts.dir}/${opts.files[0]}`,
      image_count: images.length,
      images,
      private_to: opts.private_to,
      tags: [],
    };
    const body = `## Summary\nA test gallery ${name}.\n\n## Description\n${name} photoset archive.`;
    const path = `MediaArchive/2026-07-11-${id}.md`;
    memory.upsert_note(path, fm, body);
    index_chunks(db, path, body);
    opts.files.forEach((file, i) => {
      const abs = resolve(archive_root, `${opts.dir}/${file}`);
      mkdirSync(dirname(abs), { recursive: true });
      const buf = Buffer.alloc(32);
      for (let b = 0; b < 32; b++) buf[b] = (i * 7 + b) % 251;
      writeFileSync(abs, buf);
    });
  }

  // A SFW household clip (+ a real file + thumb) and an NSFW owner-only clip.
  write_media_note('mi_sfwvid', 'Neon Drive', {
    nas_path: 'Video/YouTube/Test/mi_sfwvid.mp4',
    private_to: 'household',
    thumbnail_path: 'Video/YouTube/Test/mi_sfwvid.jpg',
    body: '## Summary\nNeon Drive.\n\n## Description\nsynthwave night drive, sfw archive clip.',
  });
  write_media_file('Video/YouTube/Test/mi_sfwvid.mp4', 1000);
  write_media_file('Video/YouTube/Test/mi_sfwvid.jpg', 64);

  write_media_note('mi_prvvid', 'Private Reel', {
    nas_path: 'Private/adult/mi_prvvid.mp4',
    private_to: 'jasper',
    nsfw: true,
    body: '## Summary\nPrivate.\n\n## Description\nsynthwave but private owner-only clip.',
  });
  write_media_file('Private/adult/mi_prvvid.mp4', 500);

  // A SFW household gallery (3 images) + a private owner-only gallery.
  write_gallery_note('mi_galset', 'Neon Set', {
    dir: 'Images/reddit/mi_galset',
    private_to: 'household',
    files: ['001.jpg', '002.jpg', '003.jpg'],
  });
  write_gallery_note('mi_prvgal', 'Private Set', {
    dir: 'Private/Images/mi_prvgal',
    private_to: 'jasper',
    nsfw: true,
    files: ['001.jpg', '002.jpg'],
  });

  await rebuild(vault, memory, db);

  // ── mount the real router behind a fake auth middleware ──────────────────
  let user: TestUser = { id: 'jasper', tier: 'owner' };
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (user) c.set('user', user as unknown as UserConfig);
    await next();
  });
  app.route('/api/media', create_media_router({ db, memory, archive_root }));
  const req = (path: string, init?: RequestInit) => app.request(path, init);

  // ── 1. auth gate ─────────────────────────────────────────────────────────
  user = null;
  check('401 without a user', (await req('/api/media/browse')).status === 401);
  user = { id: 'jasper', tier: 'owner' };

  // ── 2. browse cordon ─────────────────────────────────────────────────────
  const browse_owner = (await (await req('/api/media/browse')).json()) as {
    folders: { name: string }[];
  };
  const owner_folders = new Set(browse_owner.folders.map((f) => f.name));
  check('owner browse sees the Video folder', owner_folders.has('Video'));
  check('owner browse sees the Private folder', owner_folders.has('Private'));
  user = { id: 'sam', tier: 'household' };
  const browse_member = (await (await req('/api/media/browse')).json()) as {
    folders: { name: string }[];
  };
  const member_folders = new Set(browse_member.folders.map((f) => f.name));
  check('member browse sees Video', member_folders.has('Video'));
  check('member browse does NOT see Private (owner-only items)', !member_folders.has('Private'));

  // ── 3. item cordon (404-shape, not 403) ──────────────────────────────────
  user = { id: 'sam', tier: 'household' };
  check('member gets 404 on the NSFW item', (await req('/api/media/item/mi_prvvid')).status === 404);
  const sfw_item_res = await req('/api/media/item/mi_sfwvid');
  check('member gets 200 on the SFW item', sfw_item_res.status === 200);
  const sfw_item = (await sfw_item_res.json()) as { chapters: unknown[]; creator: string };
  check('item detail carries chapters', Array.isArray(sfw_item.chapters) && sfw_item.chapters.length === 1);
  check('item detail carries the measured creator', sfw_item.creator === 'Tester');
  user = { id: 'jasper', tier: 'owner' };
  check('owner gets 200 on the NSFW item', (await req('/api/media/item/mi_prvvid')).status === 200);

  // ── 4. HTTP range / 206 ──────────────────────────────────────────────────
  user = { id: 'jasper', tier: 'owner' };
  const full = await req('/api/media/stream/mi_sfwvid');
  check('full stream is 200', full.status === 200);
  check('full stream advertises ranges', full.headers.get('accept-ranges') === 'bytes');
  check('full stream content-length is the whole file', full.headers.get('content-length') === '1000');

  const ranged = await req('/api/media/stream/mi_sfwvid', { headers: { Range: 'bytes=0-99' } });
  check('range request is 206', ranged.status === 206);
  check('range content-range is correct', ranged.headers.get('content-range') === 'bytes 0-99/1000');
  check('range content-length is 100', ranged.headers.get('content-length') === '100');
  const body = new Uint8Array(await ranged.arrayBuffer());
  check('range returns exactly 100 bytes', body.length === 100);
  check('range bytes are the head of the file', body[0] === 0 && body[99] === 99);

  const suffix = await req('/api/media/stream/mi_sfwvid', { headers: { Range: 'bytes=-50' } });
  check('suffix range is 206', suffix.status === 206);
  check('suffix range covers the tail', suffix.headers.get('content-range') === 'bytes 950-999/1000');

  const bad = await req('/api/media/stream/mi_sfwvid', { headers: { Range: 'bytes=5000-6000' } });
  check('unsatisfiable range is 416', bad.status === 416);

  // ── 5. stream cordon ─────────────────────────────────────────────────────
  user = { id: 'sam', tier: 'household' };
  check('member gets 404 streaming the NSFW item', (await req('/api/media/stream/mi_prvvid')).status === 404);
  user = { id: 'jasper', tier: 'owner' };
  const prv = await req('/api/media/stream/mi_prvvid', { headers: { Range: 'bytes=0-9' } });
  check('owner can range-stream the NSFW item (206)', prv.status === 206);

  // ── 6. thumb ─────────────────────────────────────────────────────────────
  const thumb = await req('/api/media/thumb/mi_sfwvid');
  check('thumb serves bytes (200)', thumb.status === 200);
  check('thumb has an etag', !!thumb.headers.get('etag'));
  check('thumb 404s when none exists', (await req('/api/media/thumb/mi_prvvid')).status === 404);

  // ── 6b. gallery: /image/:id/:idx + stream guard + item detail + cordon ───
  user = { id: 'jasper', tier: 'owner' };
  const g0 = await req('/api/media/image/mi_galset/0');
  check('gallery image 0 serves bytes (200)', g0.status === 200);
  check('gallery image has an etag', !!g0.headers.get('etag'));
  check('gallery image returns the file bytes', new Uint8Array(await g0.arrayBuffer()).length === 32);
  check('gallery image out-of-range idx → 404', (await req('/api/media/image/mi_galset/99')).status === 404);
  check('gallery image negative idx → 404', (await req('/api/media/image/mi_galset/-1')).status === 404);
  check('gallery /stream is 404 (a directory, not a streamable file)', (await req('/api/media/stream/mi_galset')).status === 404);
  const gitem = (await (await req('/api/media/item/mi_galset')).json()) as {
    image_count?: number;
    images?: unknown[];
    media_kind?: string;
  };
  check('gallery item detail carries image_count', gitem.image_count === 3);
  check('gallery item detail carries images[]', Array.isArray(gitem.images) && gitem.images.length === 3);
  check('gallery item detail media_kind image_gallery', gitem.media_kind === 'image_gallery');
  // cordon: a member reads the household gallery but NOT the private one (404-shape)
  user = { id: 'sam', tier: 'household' };
  check('member sees the household gallery image (200)', (await req('/api/media/image/mi_galset/0')).status === 200);
  check('member gets 404 on the private gallery image', (await req('/api/media/image/mi_prvgal/0')).status === 404);
  check('member gets 404 on the private gallery item', (await req('/api/media/item/mi_prvgal')).status === 404);
  user = { id: 'jasper', tier: 'owner' };
  check('owner reads the private gallery image (200)', (await req('/api/media/image/mi_prvgal/0')).status === 200);

  // ── 7. inference search (FTS join → cards, cordoned) ─────────────────────
  user = { id: 'jasper', tier: 'owner' };
  const search_owner = (await (await req('/api/media/search?q=synthwave')).json()) as {
    results: { id: string }[];
  };
  const owner_hits = new Set(search_owner.results.map((r) => r.id));
  check('owner search finds the SFW clip', owner_hits.has('mi_sfwvid'));
  check('owner search finds the NSFW clip', owner_hits.has('mi_prvvid'));
  user = { id: 'sam', tier: 'household' };
  const search_member = (await (await req('/api/media/search?q=synthwave')).json()) as {
    results: { id: string }[];
  };
  const member_hits = new Set(search_member.results.map((r) => r.id));
  check('member search finds the SFW clip', member_hits.has('mi_sfwvid'));
  check('member search does NOT surface the NSFW clip', !member_hits.has('mi_prvvid'));

  // ── 8. a trailing-slash / non-canonical archive_root still serves ────────
  // (regression: the containment clamp must normalize the root, or every
  // stream/thumb 404s under the common './data/media-archive' or trailing-slash
  // configs.)
  user = { id: 'jasper', tier: 'owner' };
  const app2 = new Hono();
  app2.use('*', async (c, next) => {
    if (user) c.set('user', user as unknown as UserConfig);
    await next();
  });
  app2.route('/api/media', create_media_router({ db, memory, archive_root: archive_root + '/' }));
  const trailing = await app2.request('/api/media/stream/mi_sfwvid', { headers: { Range: 'bytes=0-9' } });
  check('trailing-slash archive_root still range-streams (root normalized)', trailing.status === 206);

  db.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n✅ smoke:media-serving — ${passed} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
