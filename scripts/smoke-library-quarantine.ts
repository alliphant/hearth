/**
 * smoke:library-quarantine — proof that pulling a note out of circulation
 * actually pulls it out of circulation (2026-07-31).
 *
 * Replays the live failure. Four research dossiers about the WRONG Chris Barrett
 * (a CU Fairview alum, a financial planner — same name, different men) were
 * quarantined off Ruby's shelf, and the removal only half-worked twice over:
 *
 *   1. The mechanics dropped `clippings` + `chunks_fts` but NOT
 *      `chunk_embeddings`. Retrieval is HYBRID, so the notes stayed reachable
 *      through the vector half — 15 vector chunks still live after a
 *      "successful" quarantine.
 *   2. The files stay on disk (deliberately — quarantine is reversible), so the
 *      ingestor immediately RE-PROJECTED them at their `_quarantine/` path and
 *      the clippings rows came straight back.
 *
 * Self-contained: temp vault + temp SQLite, real projector, no LLM, no network.
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import matter from 'gray-matter';
import { MemoryClient } from '../src/memory/client';
import { open_db } from '../src/memory/stores/structured';
import { quarantine_note, quarantine_dir_for } from '../src/core/library_quarantine';
import { project_note } from '../apps/ingestor/project';
import { VaultIndex } from '../apps/ingestor/vault_index';

let pass = 0, fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); }
}
function section(s: string): void { console.log(`\n${s}`); }

const root = mkdtempSync(resolve(tmpdir(), 'hearth-quar-'));
const vault = resolve(root, 'vault');
const LIB = 'Knowledge/Ruby/library';
mkdirSync(resolve(vault, LIB), { recursive: true });
const db = open_db(resolve(root, 'hearth.db'));
const memory = new MemoryClient({ vault_root: vault, db });

/** Shelve a note the way save_library_item does: file + clipping + BOTH indexes. */
function shelve(id: string, name: string, title: string, body: string): string {
  const note_path = `${LIB}/${name}.md`;
  writeFileSync(
    resolve(vault, note_path),
    matter.stringify(body, { type: 'clipping', id, kind: 'text', source: 'file', title, captured_at: '2026-07-29T18:00:00.000Z', reviewed: false, private_to: 'household' }),
    'utf8',
  );
  db.prepare(
    `INSERT OR REPLACE INTO clippings (id, kind, source, title, captured_at, reviewed, note_path, frontmatter_json, mtime, private_to)
     VALUES (@id,'text','file',@t,'2026-07-29T18:00:00.000Z',0,@p,'{}',@m,'household')`,
  ).run({ '@id': id, '@t': title, '@p': note_path, '@m': new Date().toISOString() });
  const chunks = body.split('\n\n').filter(Boolean);
  chunks.forEach((c, i) => {
    db.prepare(`INSERT INTO chunks_fts (note_path, chunk_idx, chunk_text) VALUES (@p,@i,@c)`)
      .run({ '@p': note_path, '@i': i, '@c': c });
  });
  memory.upsert_chunk_embeddings(
    note_path,
    chunks.map((_, i) => ({ chunk_idx: i, embedding: new Float32Array([1, 0, 0, 0]) })),
    'test-model',
  );
  return note_path;
}

const wrong = shelve(
  'c_wrong01', '2026-07-29-chris-conway-cu-boulder-1983-alumni-profile',
  'Chris Barrett CU Fairview 1983 alumni profile',
  'Chris Barrett is a 1983 English graduate.\n\nHe is president of Spring Back Colorado, which recycles mattresses.\n\nThe organization employs people facing barriers to work.',
);
const right = shelve(
  'c_right01', '2026-07-29-chris-conway-fort-collins-council-flock-vote',
  'Chris Barrett Pleasantville Council record and Flock Safety vote',
  'Chris Barrett represents District 1 on the Pleasantville City Council.\n\nHe cast the lone dissenting vote on the Flock Safety contract.',
);

const fts_for = (p: string) => (db.prepare(`SELECT COUNT(*) n FROM chunks_fts WHERE note_path=?`).get(p) as { n: number }).n;
const vec_for = (p: string) => (db.prepare(`SELECT COUNT(*) n FROM chunk_embeddings WHERE note_path=?`).get(p) as { n: number }).n;
const clip_for = (p: string) => (db.prepare(`SELECT COUNT(*) n FROM clippings WHERE note_path=?`).get(p) as { n: number }).n;
const fts_match = (q: string) => (db.prepare(`SELECT COUNT(*) n FROM chunks_fts WHERE chunks_fts MATCH ?`).get(q) as { n: number }).n;

section('A. the shelved state both halves of hybrid retrieval see');
check('the wrong-subject note is FTS-indexed', fts_for(wrong) === 3);
check('the wrong-subject note is VECTOR-indexed', vec_for(wrong) === 3);
check('it is retrievable by its distinctive claim', fts_match('"Spring Back Colorado"') === 1);

section('B. quarantine removes it from EVERY index, not just FTS');
const res = quarantine_note(db, vault, wrong, 'same-name conflation — a different Chris Barrett');
check('reports the move', res.moved);
check('dropped the clipping row', res.rows.clippings === 1);
check('dropped the vector rows — the half that used to survive', res.rows.chunk_embeddings === 3);
check('clippings now 0', clip_for(wrong) === 0);
check('chunks_fts now 0', fts_for(wrong) === 0);
check('chunk_embeddings now 0', vec_for(wrong) === 0);
check('the claim is no longer retrievable at all', fts_match('"Spring Back Colorado"') === 0);

section('C. nothing is deleted — the removal is reversible and recorded');
const q_dir = resolve(vault, quarantine_dir_for(wrong));
check('the file moved into _quarantine/, it was not unlinked',
  existsSync(resolve(q_dir, '2026-07-29-chris-conway-cu-boulder-1983-alumni-profile.md')));
check('the original path is empty', !existsSync(resolve(vault, wrong)));
const manifest = readFileSync(resolve(q_dir, 'MANIFEST.md'), 'utf8');
check('the manifest records the file', manifest.includes('cu-boulder-1983-alumni-profile'));
check('the manifest records WHY', manifest.includes('same-name conflation'));
check('the manifest states nothing was deleted', /NOTHING here was deleted/i.test(manifest));

section('D. the correctly-bound note is untouched');
check('the right note keeps its clipping', clip_for(right) === 1);
check('the right note keeps its FTS chunks', fts_for(right) === 2);
check('the right note keeps its vectors', vec_for(right) === 2);
check('its evidence still retrieves', fts_match('"Flock Safety"') === 1);

section('E. the ingestor must NOT re-project a quarantined note');
const index = { add: () => {}, remove: () => {}, resolve: () => null } as unknown as VaultIndex;
const q_note = `${quarantine_dir_for(wrong)}/2026-07-29-chris-conway-cu-boulder-1983-alumni-profile.md`;
const outcome = project_note(resolve(vault, q_note), { vault_root: vault, db, memory, index });
check('projection is SKIPPED for a _quarantine path', outcome.kind === 'skipped');
check('and says why', outcome.kind === 'skipped' && /quarantin/i.test(outcome.reason));
check('no clipping row came back', clip_for(q_note) === 0);
// The same file OUTSIDE _quarantine still projects — the skip is path-scoped,
// not a blanket refusal to project clippings.
const normal = shelve('c_ok02', 'a-normal-capture', 'A normal capture', 'body text here');
db.prepare(`DELETE FROM clippings WHERE note_path=?`).run(normal);
const ok = project_note(resolve(vault, normal), { vault_root: vault, db, memory, index });
check('a NON-quarantined clipping still projects normally', ok.kind !== 'skipped');

section('F. idempotent — quarantining twice is not an error');
const again = quarantine_note(db, vault, wrong, 'second call');
check('second call reports no rows dropped', again.rows.clippings === 0 && again.rows.chunk_embeddings === 0);
check('second call does not throw and reports no move', !again.moved);

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
db.close();
rmSync(root, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
