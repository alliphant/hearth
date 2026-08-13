/**
 * smoke:library — self-contained test of the library / file-manager
 * subsystem: LibraryStore, the /files router, and Cordelia's
 * download_to_library tool.
 *
 * Own temp library root, own temp vault + SQLite. No orchestrator, no
 * network beyond a throwaway localhost server the download test fetches
 * from.
 *
 *   bun run smoke:library
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import {
  LibraryStore,
  LIBRARY_CATEGORIES,
  kind_of,
} from '@library/store';
import { create_library_router } from '@library/router';
import { make_download_to_library } from '@specialists/cordelia/tools/download_to_library';
import type { ToolContext } from '@core/tool';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}
async function throws_async(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-library-'));
const lib_root = join(dir, 'hearth-library');
const vault_root = join(dir, 'vault');
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root, db });
const library = new LibraryStore({ root: lib_root, db });

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
let server: ReturnType<typeof Bun.serve> | null = null;

try {
  // 1 — layout: the seven category directories exist.
  check(
    'ensure_layout created all category directories',
    LIBRARY_CATEGORIES.every((c) => existsSync(join(lib_root, c))),
  );

  // 2 — write_file indexes a file under a category.
  const f1 = library.write_file({
    dir: 'Documents',
    filename: 'tax-return-2025.pdf',
    bytes: bytes('PDF-A'),
    source_url: 'https://irs.gov/forms/return.pdf',
    description: 'The 2025 federal return',
    tags: ['tax', 'irs'],
    downloaded_by: 'jasper',
  });
  check('write_file returns a lib_ id', f1.id.startsWith('lib_'));
  check('write_file landed the file on disk', existsSync(join(lib_root, f1.rel_path)));
  check('write_file set the category', f1.category === 'Documents');
  check('write_file recorded kind from extension', f1.kind === 'document');

  // 3 — name collision is de-duplicated, never overwritten.
  const f1b = library.write_file({
    dir: 'Documents',
    filename: 'tax-return-2025.pdf',
    bytes: bytes('PDF-B'),
    downloaded_by: 'jasper',
  });
  check('duplicate filename is suffixed', f1b.filename === 'tax-return-2025 (2).pdf');

  // 4 — write into a sub-folder of a category.
  const f2 = library.write_file({
    dir: 'Reference/Ioniq-5',
    filename: 'owners-manual.pdf',
    bytes: bytes('MANUAL'),
    downloaded_by: 'cordelia',
  });
  check('sub-folder write keeps the top-level category', f2.category === 'Reference');
  check(
    'sub-folder write nests the rel_path',
    f2.rel_path === 'Reference/Ioniq-5/owners-manual.pdf',
  );

  // 5 — tree() exposes categories and nested folders.
  const tree = library.tree();
  check('tree() returns all seven categories', tree.length === 7);
  const ref = tree.find((n) => n.name === 'Reference');
  check(
    'tree() shows the Ioniq-5 sub-folder',
    !!ref && ref.children.some((c) => c.name === 'Ioniq-5'),
  );

  // 6 — list() returns folders + files for a directory.
  const docs = library.list('Documents');
  check('list(Documents) returns both written files', docs.files.length === 2);
  const refList = library.list('Reference');
  check('list(Reference) returns the Ioniq-5 folder', refList.folders.some((f) => f.name === 'Ioniq-5'));

  // 7 — reconcile: a file dropped straight onto disk is indexed on list().
  writeFileSync(join(lib_root, 'Media', 'hand-dropped.png'), bytes('PNG'));
  const media = library.list('Media');
  const dropped = media.files.find((f) => f.filename === 'hand-dropped.png');
  check('list() reconciles a hand-dropped file into the index', !!dropped);
  check(
    'reconciled file is attributed to the filesystem',
    !!dropped && dropped.downloaded_by === 'filesystem',
  );

  // 8 — search by filename and by tag.
  check(
    'search matches a filename substring',
    library.search('owners-manual').some((f) => f.id === f2.id),
  );
  check(
    'search matches a tag',
    library.search('irs').some((f) => f.id === f1.id),
  );
  check('search with no hits returns empty', library.search('zzz-nope-zzz').length === 0);

  // 9 — mkdir.
  library.mkdir('Software/ROCm');
  check('mkdir created the folder', existsSync(join(lib_root, 'Software', 'ROCm')));

  // 10 — move a file to another category; index follows.
  const moved = library.move(f1.rel_path, 'Archives');
  check('move() returns the new path', moved.rel_path === 'Archives/tax-return-2025.pdf');
  check('move() left nothing at the old path', !existsSync(join(lib_root, f1.rel_path)));
  const reFetched = library.get_by_id(f1.id);
  check(
    'move() rewrote the index row category + path',
    !!reFetched && reFetched.category === 'Archives' &&
      reFetched.rel_path === 'Archives/tax-return-2025.pdf',
  );

  // 11 — rename.
  const renamed = library.rename('Archives/tax-return-2025.pdf', 'federal-2025.pdf');
  check('rename() returns the new path', renamed.rel_path === 'Archives/federal-2025.pdf');
  check(
    'rename() updated the index filename',
    library.get_by_id(f1.id)?.filename === 'federal-2025.pdf',
  );

  // 12 — delete.
  library.remove('Archives/federal-2025.pdf');
  check('delete() removed the file', !existsSync(join(lib_root, 'Archives/federal-2025.pdf')));
  check('delete() removed the index row', library.get_by_id(f1.id) === undefined);

  // 13 — path-safety: traversal is refused.
  check('list() rejects a traversal path', throws(() => library.list('../../etc')));
  check(
    'write_file rejects a traversal directory',
    throws(() =>
      library.write_file({
        dir: 'Documents/../../etc',
        filename: 'x',
        bytes: bytes('x'),
        downloaded_by: 'jasper',
      }),
    ),
  );

  // 14 — invalid category is refused.
  check(
    'write_file rejects an unknown category',
    throws(() =>
      library.write_file({
        dir: 'Nonsense',
        filename: 'x',
        bytes: bytes('x'),
        downloaded_by: 'jasper',
      }),
    ),
  );
  check('a category root cannot be deleted', throws(() => library.remove('Documents')));

  // 15 — kind_of helper.
  check('kind_of classifies an archive', kind_of('rocm.tar.gz') === 'archive');
  check('kind_of classifies an image', kind_of('photo.JPG') === 'image');

  // 16 — the /files router.
  const router = create_library_router({ library, memory });
  const tree_res = await router.request('/api/tree');
  const tree_json = (await tree_res.json()) as { categories: unknown[] };
  check('GET /api/tree → 200 with 7 categories',
    tree_res.status === 200 && tree_json.categories.length === 7);

  const list_res = await router.request('/api/list?path=Reference');
  check('GET /api/list → 200', list_res.status === 200);

  // upload through the router
  const fd = new FormData();
  fd.append('file', new File(['UPLOADED'], 'router-upload.txt', { type: 'text/plain' }));
  fd.append('path', 'Other');
  const up_res = await router.request('/api/upload', { method: 'POST', body: fd });
  const up_json = (await up_res.json()) as { id?: string; rel_path?: string };
  check('POST /api/upload → 200 with an id', up_res.status === 200 && !!up_json.id);

  // download it back by id
  const dl_res = await router.request(`/api/file/${up_json.id}`);
  const dl_text = await dl_res.text();
  check('GET /api/file/:id serves the bytes', dl_res.status === 200 && dl_text === 'UPLOADED');

  // mkdir / move / rename / delete through the router
  const mk_res = await router.request('/api/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'Other/sub' }),
  });
  check('POST /api/mkdir → 200', mk_res.status === 200);

  const mv_res = await router.request('/api/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: up_json.rel_path, to: 'Other/sub' }),
  });
  check('POST /api/move → 200', mv_res.status === 200);

  const del_res = await router.request('/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'Other/sub/router-upload.txt' }),
  });
  check('POST /api/delete → 200', del_res.status === 200);

  const bad_res = await router.request('/api/list?path=../../etc');
  check('GET /api/list rejects traversal with 400', bad_res.status === 400);

  // 17 — download_to_library tool against a throwaway localhost server.
  server = Bun.serve({
    port: 0,
    fetch() {
      return new Response('DATASET-CONTENT', {
        headers: { 'Content-Type': 'text/csv' },
      });
    },
  });
  const tool = make_download_to_library(library);
  const out = await tool.execute(
    {
      url: `http://localhost:${server.port}/colorado-evictions.csv`,
      category: 'Datasets',
      subfolder: 'Housing',
      description: 'Eviction filings dataset',
      tags: ['housing', 'colorado'],
    },
    {} as ToolContext,
  );
  check('download_to_library returned a lib_ id', out.id.startsWith('lib_'));
  check('download_to_library filed under the category', out.category === 'Datasets');
  check(
    'download_to_library nested under the sub-folder',
    out.rel_path === 'Datasets/Housing/colorado-evictions.csv',
  );
  check('download_to_library recorded the source URL', !!out.source_url);
  check(
    'download_to_library wrote the bytes',
    existsSync(join(lib_root, out.rel_path)),
  );
  const after = library.list('Datasets/Housing');
  check(
    'downloaded file is searchable by tag',
    library.search('colorado').some((f) => f.id === out.id) && after.files.length === 1,
  );

  // 18 — download_to_library refuses a non-http scheme.
  check(
    'download_to_library rejects a non-http URL',
    await throws_async(() =>
      tool.execute(
        { url: 'ftp://example.com/x', category: 'Other' },
        {} as ToolContext,
      ),
    ),
  );

  // 19 — the Recents view: newest-added first, across categories.
  const recents = library.recents(10);
  check('recents() returns files across categories', recents.length >= 3);
  check(
    'recents() is ordered newest-first',
    recents.every(
      (r, i) => i === 0 || recents[i - 1]!.downloaded_at >= r.downloaded_at,
    ),
  );
  check(
    'recents() leads with the most recent download',
    recents[0]?.id === out.id,
  );
  const rec_res = await router.request('/api/recents?limit=5');
  const rec_json = (await rec_res.json()) as { files: unknown[] };
  check(
    'GET /api/recents → 200, capped to the limit',
    rec_res.status === 200 && rec_json.files.length <= 5 && rec_json.files.length > 0,
  );
} finally {
  if (server) server.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? '\nsmoke:library OK'
    : `\nsmoke:library FAILED (${failures} check(s))`,
);
process.exit(failures === 0 ? 0 : 1);
