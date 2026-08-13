/**
 * Sensor packet retention pruner — drops files + DB index rows older
 * than the retention window. Per BACKEND_SENSORS_BRIEF "Retention: 90
 * days raw on disk, indefinite derived computation results."
 *
 *   bun run scripts/prune-sensor-packets.ts
 *
 * Env:
 *   HEARTH_DB_PATH                    default ./data/hearth.db
 *   HEARTH_VAULT_ROOT                 default ~/vault-friday
 *   HEARTH_SENSOR_RETENTION_DAYS      default 90
 *   HEARTH_SENSOR_PRUNE_DRY_RUN=1     list what would be deleted, don't delete
 *
 * Wire it into cron (or the existing scheduler) for a daily run; the
 * script is idempotent and cheap to re-run.
 */

import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { Database } from 'bun:sqlite';

const DB_PATH = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
const VAULT_ROOT = process.env.HEARTH_VAULT_ROOT ?? resolve(homedir(), 'vault-friday');
const RETENTION_DAYS = parseInt(process.env.HEARTH_SENSOR_RETENTION_DAYS ?? '90', 10);
const DRY_RUN = process.env.HEARTH_SENSOR_PRUNE_DRY_RUN === '1';

interface PacketRow {
  id: string;
  payload_path: string;
}

function main(): void {
  const db = new Database(DB_PATH);
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
  console.log(`pruning sensor_packets received before ${cutoff}` + (DRY_RUN ? ' (dry run)' : ''));

  const rows = db
    .prepare(
      `SELECT id, payload_path FROM sensor_packets WHERE received_at < @cutoff`,
    )
    .all({ '@cutoff': cutoff }) as PacketRow[];

  let files_removed = 0;
  let files_missing = 0;
  let rows_removed = 0;

  const delete_row = db.prepare(`DELETE FROM sensor_packets WHERE id = @id`);

  for (const row of rows) {
    const abs = resolve(VAULT_ROOT, row.payload_path);
    if (DRY_RUN) {
      console.log(`  would delete ${abs}`);
      continue;
    }
    if (existsSync(abs)) {
      try {
        rmSync(abs);
        files_removed++;
      } catch (err) {
        console.warn(`  failed to remove ${abs}: ${(err as Error).message}`);
        continue;
      }
    } else {
      files_missing++;
    }
    delete_row.run({ '@id': row.id });
    rows_removed++;
  }

  console.log(
    `done. rows seen ${rows.length}; files removed ${files_removed}; ` +
      `rows removed ${rows_removed}; files already missing ${files_missing}.`,
  );
  db.close();
}

main();
