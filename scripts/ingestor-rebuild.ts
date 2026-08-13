/**
 * CLI wrapper around the ingestor's rebuild() driver.
 *
 * Truncates the projection tables and re-projects every .md file in
 * the vault. Safe to run while the orchestrator and ingestor are
 * up — bun:sqlite WAL mode handles concurrent access — but it's
 * usually cleaner to stop the ingestor first so its watcher events
 * don't race with the rebuild's inserts.
 *
 *   bun run ingestor:rebuild
 *
 * Honors HEARTH_VAULT_ROOT / HEARTH_DB_PATH like the long-running
 * service does.
 */

import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { rebuild, format_summary } from '@ingestor/rebuild';

const VAULT_ROOT =
  process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`;
const DB_PATH = process.env.HEARTH_DB_PATH ?? './data/hearth.db';

console.log(`rebuilding projections`);
console.log(`  vault: ${VAULT_ROOT}`);
console.log(`  db:    ${DB_PATH}`);

const db = open_db(DB_PATH);
const memory = new MemoryClient({ vault_root: VAULT_ROOT, db });

const summary = await rebuild(VAULT_ROOT, memory, db);
console.log(format_summary(summary));

db.close();
