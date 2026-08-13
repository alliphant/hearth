/**
 * quarantine-notes — pull SPECIFIC library notes out of circulation by path or
 * clipping id (2026-07-31). DRY-RUN BY DEFAULT.
 *
 * The sibling of `quarantine-library-trash.ts`. That one decides what to remove
 * with the structural quality gate; this one takes an explicit list, because
 * the case it exists for is invisible to any quality gate: a note that is a
 * perfectly good capture of a perfectly real page, shelved under the WRONG
 * SUBJECT.
 *
 * The motivating case: deep research on Pleasantville councilmember Chris Barrett
 * fanned out, hit pages about two OTHER men of the same name — a CU Fairview
 * English '83 who runs a mattress-recycling nonprofit, and a Prato Capital
 * Management financial planner — and shelved all of them onto Ruby's Barrett
 * rack, chunked and embedded. Every honesty guard passes a claim drawn from
 * those pages, because the claim genuinely IS in a retrieved source; the fact
 * critic verifies support, not identity binding. So "Chris Barrett is the
 * president of Spring Back Colorado" was live, grounded, and wrong.
 *
 * Both share `quarantine_note` (src/core/library_quarantine.ts): the note moves
 * to `_quarantine/` with a recorded reason and is dropped from BOTH halves of
 * hybrid retrieval. NOTHING is deleted.
 *
 * Usage (on the LLM host):
 *   docker exec -w /app -e HEARTH_DB_PATH=/data/db/hearth.db \
 *     -e HEARTH_VAULT_ROOT=/data/vault hearth-orchestrator \
 *     bun run scripts/quarantine-notes.ts --ids=c_v1yztnspqc,c_p8czd51vqh --reason="..."
 *   …then re-run with --apply.
 *
 * Select with --ids=<clipping ids> and/or --paths=<vault-relative note paths>.
 */
import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { quarantine_note, quarantine_dir_for } from '../src/core/library_quarantine';

function arg(name: string): string | null {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}
const list = (v: string | null): string[] =>
  v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
const VAULT_ROOT =
  process.env.HEARTH_VAULT_ROOT ?? resolve(process.env.HOME ?? '.', 'vault-friday');
const REASON = arg('reason') ?? 'quarantined by operator (no reason given)';

const db = APPLY ? new Database(DB_PATH) : new Database(DB_PATH, { readonly: true });

// Resolve ids → note paths, and keep explicit paths as given.
const targets = new Map<string, string>(); // note_path -> title
for (const id of list(arg('ids'))) {
  const row = db
    .prepare(`SELECT note_path, title FROM clippings WHERE id = ?`)
    .get(id) as { note_path: string; title: string } | null;
  if (!row) {
    console.error(`  ! no clipping with id ${id}`);
    continue;
  }
  targets.set(row.note_path, row.title);
}
for (const p of list(arg('paths'))) {
  const row = db
    .prepare(`SELECT title FROM clippings WHERE note_path = ?`)
    .get(p) as { title: string } | null;
  targets.set(p, row?.title ?? '(not in clippings)');
}

console.log(
  `quarantine-notes — ${APPLY ? 'APPLY' : 'DRY RUN'}\n` +
    `  db:     ${DB_PATH}\n  vault:  ${VAULT_ROOT}\n  reason: ${REASON}\n`,
);
if (targets.size === 0) {
  console.log('  nothing selected — pass --ids= and/or --paths=');
  db.close();
  process.exit(0);
}

let fts = 0;
let vec = 0;
for (const [note_path, title] of targets) {
  const f = (
    db.prepare(`SELECT COUNT(*) n FROM chunks_fts WHERE note_path = ?`).get(note_path) as {
      n: number;
    }
  ).n;
  const e = (
    db.prepare(`SELECT COUNT(*) n FROM chunk_embeddings WHERE note_path = ?`).get(note_path) as {
      n: number;
    }
  ).n;
  fts += f;
  vec += e;
  console.log(`  ${title.slice(0, 62)}\n     ${note_path}\n     fts=${f} vector=${e}`);
  if (APPLY) {
    const r = quarantine_note(db, VAULT_ROOT, note_path, REASON);
    console.log(
      `     → moved=${r.moved} attachment=${r.attachment_moved} ` +
        `dropped clippings=${r.rows.clippings} fts=${r.rows.chunks_fts} ` +
        `vector=${r.rows.chunk_embeddings}` +
        (r.error ? ` (move error: ${r.error})` : ''),
    );
  }
}

if (!APPLY) {
  console.log(
    `\nDry run — nothing moved. ${targets.size} note(s), ${fts} FTS + ${vec} vector ` +
      `chunk(s) would leave the retrieval index.\n` +
      `Re-run with --apply. Files move to ${quarantine_dir_for([...targets.keys()][0]!)}/ ` +
      `and are recorded in its MANIFEST.md — nothing is deleted.`,
  );
} else {
  console.log(`\nQuarantined ${targets.size} note(s). Review the MANIFEST.md to reverse.`);
}
db.close();
