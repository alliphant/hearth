/**
 * ops:taxonomy-migrate — run the `taxonomy` facet against the LIVE archive.
 *
 * Not a smoke: this points at the real vault, the real db and the real NAS.
 * It exists because the facet is a Kate tool, and a filesystem migration wants
 * a scripted, auditable invocation with the plan printed before anything moves —
 * not a chat turn.
 *
 * DRY RUN unless `--apply` is passed. The facet is itself dry-run-by-default, so
 * this flag is the second of two locks.
 *
 *   docker exec -w /app hearth-orchestrator bun run scripts/ops-taxonomy-migrate.ts
 *   docker exec -w /app hearth-orchestrator bun run scripts/ops-taxonomy-migrate.ts --apply
 *
 * Owner-approved 2026-07-29 (Jasper: "run the migration"). ⚠ The first run of this
 * script is already DONE, and the owner then corrected the shape twice — the
 * Music/Audio third slot is `<Album-or-Title-or-Year>` (not `<Album-or-Year>`),
 * and every file is now named `<title> [<id>]` rather than the bare id. So THIS
 * run is a second migration over an already-migrated archive: mostly renames, plus
 * the two Music items whose folder moves off the year onto the title. Print the
 * plan, get the go-ahead on the FILENAMES as well as the folders, then --apply.
 */
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import type { ToolContext } from '@core/tool';
import { make_rescan_media_metadata } from '../src/specialists/kate/tools/rescan_media_metadata';

const APPLY = process.argv.includes('--apply');

const VAULT = process.env.HEARTH_VAULT_ROOT ?? '/data/vault';
const DB = process.env.HEARTH_DB_PATH ?? '/data/db/hearth.db';
const ARCHIVE = process.env.HEARTH_MEDIA_ARCHIVE_ROOT ?? '/data/archive';

async function main(): Promise<void> {
  console.log(`mode      : ${APPLY ? 'APPLY (files will move)' : 'DRY RUN (nothing moves)'}`);
  console.log(`vault     : ${VAULT}`);
  console.log(`db        : ${DB}`);
  console.log(`archive   : ${ARCHIVE}\n`);

  const db = open_db(DB);
  const memory = new MemoryClient({ vault_root: VAULT, db });
  const tool = make_rescan_media_metadata(ARCHIVE);

  // The owner, since the facet gates on ['owner','household'] and this migration
  // is owner-approved. Mirrors the smoke's context shape.
  const ctx = {
    memory,
    llm: null,
    now: new Date(),
    intent_id: 'ops-taxonomy-migrate',
    specialist_id: 'kate',
    // ⚠ The Caller key is `id`, NOT `user_id`. Getting this wrong does not
    // error — `list_for_user`'s cordon filter simply matches nothing and the
    // facet reports `scanned: 0, moves: 0` with the cheerful message "every one
    // is filed in the folder it belongs in". A silent empty sweep is exactly
    // what an `--apply` run must never be built on, which is why the dry run
    // is compared against a known-expected plan rather than merely eyeballed.
    user: { id: 'jasper', tier: 'owner' },
  } as unknown as ToolContext;

  const input = tool.input_schema.parse({ facet: 'taxonomy', ...(APPLY ? { apply: true } : {}) });
  const out = (await tool.execute(input, ctx)) as Record<string, unknown>;

  const moves = (out.taxonomy ?? []) as Array<Record<string, unknown>>;
  console.log(`scanned   : ${String(out.scanned ?? '?')}`);
  console.log(`applied   : ${String(out.applied ?? false)}`);
  console.log(`moves     : ${moves.length}\n`);

  for (const m of moves) {
    const flag = m.unresolved === true ? '  ⚠ UNRESOLVED' : '';
    const kind =
      m.from === m.to ? 'RENAME' : m.renamed === true ? 'MOVE + RENAME' : 'MOVE';
    console.log(`${String(m.item_id)}  ${String(m.title ?? '')}  [${kind}]${flag}`);
    // FULL paths: the filename is part of the taxonomy, so a folder-only
    // before→after would hide half of what --apply is about to do. `from`/`to`
    // (the directories) are printed underneath only when they actually differ.
    console.log(`  from: ${String(m.from_path ?? m.from)}`);
    console.log(`  to  : ${String(m.to_path ?? m.to)}`);
    if (m.from !== m.to) console.log(`  dir : ${String(m.from)} → ${String(m.to)}`);
    if (m.moved !== undefined) console.log(`  moved: ${String(m.moved)}`);
    if (m.note) console.log(`  note : ${String(m.note)}`);
  }

  if (out.message) console.log(`\nmessage   : ${String(out.message)}`);
  const unresolved = moves.filter((m) => m.unresolved === true).length;
  if (unresolved > 0) {
    console.log(`\n⚠ ${unresolved} item(s) UNRESOLVED — re-run to finish (the facet is idempotent).`);
    process.exitCode = 1;
  }
}

await main();
