export {};
/**
 * Seal the WHOLE audit_log into one genesis-anchored hash-chain (Phase 1b),
 * bringing pre-feature rows (NULL hashes) into the chain so the full history
 * is tamper-evident — not just rows written after deploy.
 *
 *   bun run backfill:audit-chain            # dry-run (counts only)
 *   bun run backfill:audit-chain --apply    # re-chain every row
 *
 * ⚠ Run with the orchestrator + ingestor STOPPED (they write audit rows; a
 * row inserted mid-reseal chains from a head this is rewriting). Re-running
 * is safe — the reseal is deterministic and idempotent. Honors HEARTH_DB_PATH
 * + HEARTH_AUDIT_CHAIN_KEY (must be the key new rows will be written with).
 */

import { resolve } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { reseal_audit_chain } from '@core/audit_chain';

const DB_PATH = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
const APPLY = process.argv.includes('--apply');

const db = open_db(resolve(DB_PATH));
const total = (db.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get() as { n: number }).n;
const chained = (
  db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE row_hash IS NOT NULL`).get() as { n: number }
).n;

console.log(`audit-chain backfill`);
console.log(`  db:            ${DB_PATH}`);
console.log(`  HMAC key:      ${process.env.HEARTH_AUDIT_CHAIN_KEY ? 'set (sealed)' : 'DEFAULT — set HEARTH_AUDIT_CHAIN_KEY first'}`);
console.log(`  total rows:    ${total}`);
console.log(`  chained now:   ${chained}`);
console.log(`  will reseal:   ${total} (whole ledger, genesis-anchored)`);

if (!APPLY) {
  console.log(`\nDRY-RUN — nothing written. Re-run with --apply (orchestrator + ingestor stopped).`);
  process.exit(0);
}

const r = reseal_audit_chain(db);
console.log(`\n✓ Sealed ${r.sealed} rows. Head: ${r.head ?? '(none)'}`);
