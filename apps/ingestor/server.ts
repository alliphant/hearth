/**
 * Hearth Ingestor — long-running structured-projection service.
 *
 * Watches the vault for .md file events and projects each file's
 * frontmatter into the matching SQLite table. Maintains a running
 * VaultIndex so wikilinks resolve against current basenames.
 *
 * Runs as an independent process from the orchestrator; both share
 * the same SQLite file via WAL mode (one writer at a time, many
 * concurrent readers — set in @memory/stores/structured.open_db).
 *
 * Configuration via env vars matches the orchestrator:
 *   HEARTH_VAULT_ROOT  vault directory (default ~/vault-friday)
 *   HEARTH_DB_PATH     SQLite path (default ./data/hearth.db)
 */

import { resolve } from 'node:path';
import chokidar from 'chokidar';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { project_note, unproject_note } from './project';
import { VaultIndex } from './vault_index';
import { rebuild, format_summary } from './rebuild';

const VAULT_ROOT =
  process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`;
const DB_PATH = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
const DEBOUNCE_MS = parseInt(process.env.HEARTH_INGESTOR_DEBOUNCE_MS ?? '500', 10);

const db = open_db(DB_PATH);
const memory = new MemoryClient({ vault_root: VAULT_ROOT, db });

console.log('hearth-ingestor starting');
console.log(`  vault:   ${VAULT_ROOT}`);
console.log(`  db:      ${DB_PATH}`);
console.log(`  debounce: ${DEBOUNCE_MS}ms`);

// On startup, do a full rebuild so the projection tables match the
// current vault state. Catches any edits made while the ingestor was
// down. Cheap for a personal vault (~hundreds of files).
const start_summary = await rebuild(VAULT_ROOT, memory, db);
console.log('initial rebuild:');
console.log(format_summary(start_summary));

const index = await VaultIndex.build(VAULT_ROOT);

// POLLING, not inotify — the vault is a Docker bind mount watched from a
// DIFFERENT container than the orchestrator that writes it. inotify events for a
// cross-container write are unreliable: under the audit log's constant writes the
// inotify queue coalesces/overflows and a People/*.md `add` is silently dropped,
// so a correctly-saved contact never projects and the Friends card stays blank
// (the 2026-06-23 Wren email/phone miss — file perfect, no projection until a
// manual touch). Polling stats the tree on an interval — reliable across the
// bind mount. Cheap at vault scale (~1700 notes); tune via the env knobs, or set
// HEARTH_INGEST_POLL=0 to revert to inotify. awaitWriteFinish still debounces.
const USE_POLLING = process.env.HEARTH_INGEST_POLL !== '0';
const watcher = chokidar.watch('**/*.md', {
  cwd: VAULT_ROOT,
  ignoreInitial: true, // initial state captured by the rebuild above
  usePolling: USE_POLLING,
  interval: Number(process.env.HEARTH_INGEST_POLL_INTERVAL_MS ?? 1500),
  binaryInterval: 3000,
  awaitWriteFinish: {
    stabilityThreshold: DEBOUNCE_MS,
    pollInterval: 100,
  },
});

watcher.on('add', (rel_path) => {
  const abs = resolve(VAULT_ROOT, rel_path);
  index.add(rel_path);
  const outcome = project_note(abs, { vault_root: VAULT_ROOT, db, memory, index });
  log_outcome('add', outcome);
});

watcher.on('change', (rel_path) => {
  const abs = resolve(VAULT_ROOT, rel_path);
  // index already knows this rel_path; add() is a no-op for unchanged
  // basenames but handles the rename-via-edit case.
  index.add(rel_path);
  const outcome = project_note(abs, { vault_root: VAULT_ROOT, db, memory, index });
  log_outcome('change', outcome);
});

watcher.on('unlink', (rel_path) => {
  const abs = resolve(VAULT_ROOT, rel_path);
  index.remove(rel_path);
  const result = unproject_note(abs, { vault_root: VAULT_ROOT, db, memory });
  console.log(
    `[unlink] ${rel_path} → table=${result.removed_from ?? 'none'}, ` +
      `edges_removed=${result.edges_removed}, ` +
      `chunks_removed=${result.chunks_removed}, ` +
      `embeddings_removed=${result.embeddings_removed}`,
  );
});

watcher.on('error', (err) => {
  console.error('[watcher] error:', err);
});

watcher.on('ready', () => {
  console.log(`watching ${VAULT_ROOT} (${index.size()} notes indexed)`);
});

function log_outcome(
  event: string,
  outcome: ReturnType<typeof project_note>,
): void {
  if (outcome.kind === 'projected') {
    const tail =
      outcome.ambiguous_links.length > 0
        ? `, ambiguous=[${outcome.ambiguous_links.join(', ')}]`
        : '';
    console.log(`[${event}] ${outcome.note_path} → ${outcome.type}${tail}`);
  } else if (outcome.kind === 'skipped') {
    console.log(`[${event}] ${outcome.note_path} skipped: ${outcome.reason}`);
  } else {
    console.warn(`[${event}] ${outcome.note_path} FAILED: ${outcome.error}`);
  }
}

// Clean shutdown on SIGTERM / SIGINT (so systemd stop is graceful).
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`received ${signal}; closing watcher and db`);
  try {
    await watcher.close();
  } catch (err) {
    console.error('watcher close error:', err);
  }
  try {
    db.close();
  } catch (err) {
    console.error('db close error:', err);
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
