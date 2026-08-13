export {};
/**
 * Verify the tamper-evident audit ledger end to end (Phase 1b).
 *
 *   bun run verify:audit-chain                # genesis-anchored, whole ledger
 *   bun run verify:audit-chain --limit=5000   # only the most recent N
 *
 * Honors HEARTH_DB_PATH + HEARTH_AUDIT_CHAIN_KEY (the key MUST match the one
 * the orchestrator wrote with, or every row reads as 'edited'). Exit 1 on a
 * detected break.
 */

import { resolve } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { verify_audit_chain } from '@core/audit_chain';

const DB_PATH = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
const limit = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1]) || 0;

const db = open_db(resolve(DB_PATH));
const r = verify_audit_chain(db, { limit });

console.log(`Audit ledger — ${r.scope} verification`);
console.log(`  HMAC key:       ${process.env.HEARTH_AUDIT_CHAIN_KEY ? 'set (sealed)' : 'DEFAULT — set HEARTH_AUDIT_CHAIN_KEY for backup-tamper-resistance'}`);
console.log(`  status:         ${r.status}`);
console.log(`  chained rows:   ${r.total_chained}`);
console.log(`  verified:       ${r.rows_checked}`);
console.log(`  unchained rows: ${r.unchained_rows}`);
console.log(`  head hash:      ${r.head_hash ?? '(none)'}`);
if (r.status === 'broken') {
  console.error(`  ✗ BREAK at audit_log id ${r.first_break_id} (${r.first_break_reason})`);
  process.exit(1);
}
console.log(`  ✓ ${r.status}`);
