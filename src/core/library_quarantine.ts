/**
 * library_quarantine — the ONE way a library note is pulled out of circulation
 * without being destroyed (2026-07-31).
 *
 * Extracted from `scripts/quarantine-library-trash.ts`, which was the only
 * implementation and had already drifted: it de-indexed `clippings` +
 * `chunks_fts` but NOT `chunk_embeddings`. Retrieval is HYBRID (FTS ∪ vector,
 * RRF-fused in src/core/retrieval.ts), so a note quarantined that way stayed
 * reachable through the vector half — quarantine silently doing half its job.
 * Found while pulling four same-name-conflated research dossiers off Ruby's
 * shelf; each had 3-6 rows in BOTH tables.
 *
 * The contract:
 *   - NOTHING IS DELETED. The wrapper note (and its attachment) MOVE to
 *     `<library>/_quarantine/`, and the move is recorded in that folder's
 *     MANIFEST.md with a reason. Reversal is a `mv` back plus a re-index.
 *   - BOTH indexes are dropped, always. If you add a third retrieval index,
 *     add it HERE — that is the whole point of this module existing.
 *   - Best-effort per step: a failed move still de-indexes (better a
 *     hidden-but-present file than a live one), and a missing table is a no-op
 *     rather than a throw.
 *
 * Callers decide WHAT to quarantine; this decides HOW. Today: the quality-gate
 * sweep (structural trash) and targeted operator cleanups (a note that is
 * accurate but bound to the wrong subject — which no quality gate can catch,
 * because the page itself is fine).
 */
import type { Database } from 'bun:sqlite';
import { renameSync, mkdirSync, existsSync, appendFileSync, readFileSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import matter from 'gray-matter';

export interface QuarantineResult {
  note_path: string;
  moved: boolean;
  attachment_moved: boolean;
  rows: { clippings: number; chunks_fts: number; chunk_embeddings: number };
  error?: string;
}

/** The `_quarantine` folder for a `Knowledge/<Ns>/library/<file>.md` note. */
export function quarantine_dir_for(note_rel: string): string {
  return join(dirname(note_rel), '_quarantine');
}

/**
 * Move `note_rel` (vault-relative) into its library's `_quarantine/` and drop
 * it from EVERY retrieval index. Idempotent: a note already quarantined (file
 * absent, rows gone) returns zeroed counts rather than throwing.
 */
export function quarantine_note(
  db: Database,
  vault_root: string,
  note_rel: string,
  reason: string,
): QuarantineResult {
  const res: QuarantineResult = {
    note_path: note_rel,
    moved: false,
    attachment_moved: false,
    rows: { clippings: 0, chunks_fts: 0, chunk_embeddings: 0 },
  };
  const note_abs = resolve(vault_root, note_rel);
  const q_rel = quarantine_dir_for(note_rel);
  const q_abs = resolve(vault_root, q_rel);
  const name = basename(note_rel);

  let fm: Record<string, unknown> = {};
  if (existsSync(note_abs)) {
    try {
      fm = matter(readFileSync(note_abs, 'utf8')).data as Record<string, unknown>;
    } catch {
      /* unparseable frontmatter — still quarantine the file */
    }
    try {
      mkdirSync(q_abs, { recursive: true });
      renameSync(note_abs, join(q_abs, name));
      res.moved = true;
    } catch (err) {
      res.error = (err as Error).message;
    }
    // The binary rides along, or the quarantined wrapper points at nothing.
    const att = typeof fm.attachment_path === 'string' ? fm.attachment_path : null;
    if (att) {
      const att_abs = resolve(vault_root, att);
      if (existsSync(att_abs)) {
        try {
          const q_att = join(q_abs, '_attachments');
          mkdirSync(q_att, { recursive: true });
          renameSync(att_abs, join(q_att, basename(att)));
          res.attachment_moved = true;
        } catch {
          /* best-effort */
        }
      }
    }
  }

  // De-index from BOTH halves of hybrid retrieval, plus the projection row.
  const del = (sql: string): number => {
    try {
      return db.prepare(sql).run({ '@p': note_rel }).changes ?? 0;
    } catch {
      return 0; // missing table / legacy db — never block a quarantine
    }
  };
  res.rows.clippings = del('DELETE FROM clippings WHERE note_path = @p');
  res.rows.chunks_fts = del('DELETE FROM chunks_fts WHERE note_path = @p');
  res.rows.chunk_embeddings = del('DELETE FROM chunk_embeddings WHERE note_path = @p');

  // The manifest is the reversal instructions — without a recorded reason a
  // quarantined file is indistinguishable from a lost one.
  try {
    mkdirSync(q_abs, { recursive: true });
    const manifest = join(q_abs, 'MANIFEST.md');
    if (!existsSync(manifest)) {
      appendFileSync(
        manifest,
        `# Quarantine manifest — ${dirname(note_rel)}\n\n` +
          `Notes moved out of circulation and de-indexed from search (FTS +\n` +
          `vector). NOTHING here was deleted — review and remove by hand if you\n` +
          `agree, or move a file back and re-index to restore it.\n\n`,
      );
    }
    appendFileSync(manifest, `- \`${name}\` — ${reason}\n`);
  } catch {
    /* best-effort — the de-index already happened */
  }
  return res;
}
