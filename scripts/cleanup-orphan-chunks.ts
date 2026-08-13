export {};
/**
 * One-shot cleanup for retrieval-index rows whose vault note is GONE.
 *
 * Before 2026-07-30 the ingestor's `unproject_note` tore down the projection
 * row + graph edges on an unlink but left `chunks_fts` and `chunk_embeddings`
 * behind, so a note deleted from the vault (Obsidian, `delete_note`, a sweep)
 * kept being returned by FTS and by vector RAG. That leak is fixed at the
 * source; this drains whatever it already left in the db.
 *
 *   bun run cleanup:orphan-chunks            # dry run (default) — lists only
 *   bun run cleanup:orphan-chunks -- --apply # delete the orphan rows
 *
 * THE ORPHAN TEST IS FILE EXISTENCE, not "has no projected row". Do NOT use
 *   SELECT ... FROM chunk_embeddings e
 *    WHERE NOT EXISTS (SELECT 1 FROM clippings c WHERE c.note_path = e.note_path)
 * as the definition: plenty of indexed notes legitimately never project a
 * clippings row — every AUXILIARY type (`_synthesis/` syntheses, memory files)
 * by design, plus any note whose frontmatter failed clipping validation. On
 * the live vault that query matched 41,540 rows across 2,843 notes while the
 * real orphan count (no file on disk) was ONE. The file is the source of
 * truth; the tables are projections of it.
 *
 * Safe to re-run: deleting rows for a path with no file is idempotent, and a
 * note that comes BACK is re-indexed by the ingestor's add/change handler.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ulid } from 'ulid';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';

function main(): void {
  const apply = process.argv.includes('--apply');
  const DB_PATH = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
  const VAULT_ROOT = process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`;

  const db = open_db(resolve(DB_PATH));
  const memory = new MemoryClient({ vault_root: VAULT_ROOT, db });

  console.log(`db=${resolve(DB_PATH)}`);
  console.log(`vault=${VAULT_ROOT}`);
  console.log(apply ? 'mode=APPLY (rows will be deleted)' : 'mode=dry-run (use --apply to delete)');

  // Union of every note_path carrying retrieval rows in either table — the
  // two can disagree (an embed that landed after its chunks were replaced,
  // a pre-fix unlink), and both halves have to be swept.
  const paths = new Set<string>();
  for (const table of ['chunks_fts', 'chunk_embeddings'] as const) {
    try {
      const rows = db
        .prepare(`SELECT DISTINCT note_path FROM ${table}`)
        .all() as Array<{ note_path: string }>;
      for (const r of rows) paths.add(r.note_path);
    } catch (err) {
      console.error(`  ! could not read ${table}:`, err);
    }
  }
  console.log(`${paths.size} indexed note_path(s) across chunks_fts + chunk_embeddings`);

  const count_fts = db.prepare(`SELECT COUNT(*) AS n FROM chunks_fts WHERE note_path = @p`);
  const count_emb = db.prepare(`SELECT COUNT(*) AS n FROM chunk_embeddings WHERE note_path = @p`);
  const del_fts = db.prepare(`DELETE FROM chunks_fts WHERE note_path = @p`);
  const del_emb = db.prepare(`DELETE FROM chunk_embeddings WHERE note_path = @p`);

  const orphans: Array<{ note_path: string; chunks: number; embeddings: number }> = [];
  for (const note_path of [...paths].sort()) {
    // resolve() guards a note_path that is somehow absolute or escaping —
    // an unresolvable path is not a file, so it counts as an orphan either way.
    if (existsSync(resolve(VAULT_ROOT, note_path))) continue;
    const chunks = (count_fts.get({ '@p': note_path }) as { n: number } | null)?.n ?? 0;
    const embeddings = (count_emb.get({ '@p': note_path }) as { n: number } | null)?.n ?? 0;
    orphans.push({ note_path, chunks, embeddings });
  }

  let chunks_total = 0;
  let embeddings_total = 0;
  for (const o of orphans) {
    chunks_total += o.chunks;
    embeddings_total += o.embeddings;
    console.log(`  ${apply ? 'DELETE' : 'orphan'}  ${o.note_path}  (fts=${o.chunks}, emb=${o.embeddings})`);
    if (apply) {
      del_fts.run({ '@p': o.note_path });
      del_emb.run({ '@p': o.note_path });
    }
  }

  console.log(
    `\n${orphans.length} orphan note(s): ${chunks_total} chunks_fts row(s), ` +
      `${embeddings_total} chunk_embeddings row(s)` +
      (apply ? ' — DELETED' : ' — dry run, nothing changed'),
  );

  if (apply && orphans.length > 0) {
    memory.log_action({
      intent_id: ulid(),
      agent: 'orchestrator',
      tool_name: 'cleanup_orphan_chunks',
      tool_input: { vault_root: VAULT_ROOT, notes: orphans.length },
      execution_result: {
        notes_cleaned: orphans.length,
        chunks_removed: chunks_total,
        embeddings_removed: embeddings_total,
        note_paths: orphans.slice(0, 50).map((o) => o.note_path),
      },
    });
  }

  db.close();
}

main();
