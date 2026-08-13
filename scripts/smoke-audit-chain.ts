export {};
/**
 * Smoke for the tamper-evident audit ledger (Phase 1b of the provable cordon).
 *
 * Self-contained: temp vault + temp SQLite, a REAL MemoryClient so the actual
 * `log_action` chaining path is exercised. Asserts:
 *   1. Consecutive log_action calls form a chain (genesis → linked row_hashes).
 *   2. verify_audit_chain → intact over the real rows.
 *   3. Editing a row's field is DETECTED (status broken, reason 'edited', at
 *      the right row).
 *   4. Deleting a middle row is DETECTED (reason 'deleted_or_reordered').
 *   5. The HMAC key matters (different key → recompute mismatch) + canonical
 *      determinism.
 *   6. subject_user_id is stored.
 *   7. Kill switch (HEARTH_AUDIT_CHAIN=0) writes an UNCHAINED row, and
 *      re-enabling resumes the chain from the prior head.
 *   8. reseal_audit_chain seals a mixed (some-NULL) ledger → full verify intact.
 *   9. recent-window scope verifies internal linkage.
 *
 *   bun run smoke:audit-chain
 */

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import {
  verify_audit_chain,
  reseal_audit_chain,
  chain_row_hash,
  canonical_row,
  GENESIS_HASH,
  type AuditChainFields,
} from '@core/audit_chain';
import type { Database } from 'bun:sqlite';

process.env.HEARTH_AUDIT_CHAIN = '1';
process.env.HEARTH_AUDIT_CHAIN_KEY = 'smoke-test-key';

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean): void {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.error(`  ✗ ${label}`); }
}

function rows_of(db: Database) {
  return db
    .prepare(
      `SELECT id, tool_name, prev_hash, row_hash FROM audit_log ORDER BY rowid ASC`,
    )
    .all() as Array<{ id: string; tool_name: string; prev_hash: string | null; row_hash: string | null }>;
}

function log(memory: MemoryClient, tool_name: string, extra: Record<string, unknown> = {}): string {
  return memory.log_action({
    intent_id: `i_${tool_name}`,
    agent: 'orchestrator',
    tool_name,
    tool_input: { x: tool_name },
    ...extra,
  });
}

function main(): void {
  const root = mkdtempSync(resolve(tmpdir(), 'hearth-auditchain-'));
  const vault = resolve(root, 'vault');
  mkdirSync(vault, { recursive: true });

  try {
    const db = open_db(resolve(root, 'hearth.db'));
    const memory = new MemoryClient({ vault_root: vault, db });

    // ── 1+2. Chain forms over real log_action calls ─────────────────────
    console.log('→ chain forms over log_action');
    log(memory, 'a');
    log(memory, 'b', { subject_user_id: 'sam' });
    log(memory, 'c');
    let r = rows_of(db);
    check('3 rows written', r.length === 3);
    check('row 0 prev = genesis', r[0]!.prev_hash === GENESIS_HASH);
    check('all rows have a row_hash', r.every((x) => !!x.row_hash));
    check('row 1 links to row 0', r[1]!.prev_hash === r[0]!.row_hash);
    check('row 2 links to row 1', r[2]!.prev_hash === r[1]!.row_hash);
    let v = verify_audit_chain(db);
    check('verify intact', v.status === 'intact');
    check('verify counts 3 chained', v.total_chained === 3 && v.rows_checked === 3);
    check('verify head = last row_hash', v.head_hash === r[2]!.row_hash);

    // ── 6. subject_user_id stored ───────────────────────────────────────
    const subj = db.prepare(`SELECT subject_user_id FROM audit_log WHERE tool_name='b'`).get() as { subject_user_id: string | null };
    check('subject_user_id stored', subj.subject_user_id === 'sam');

    // ── 5. HMAC key matters + canonical determinism ─────────────────────
    const f: AuditChainFields = {
      id: 'x', ts: 't', intent_id: 'i', agent: 'a', tool_name: 'n',
      tool_input: '{}', gate_decision: null, execution_result: null,
      human_verdict: null, cost: null, error: null, user_id: null, subject_user_id: null,
    };
    check('canonical deterministic', canonical_row(f) === canonical_row({ ...f }));
    const h1 = (() => { process.env.HEARTH_AUDIT_CHAIN_KEY = 'k1'; return chain_row_hash(GENESIS_HASH, f); })();
    const h2 = (() => { process.env.HEARTH_AUDIT_CHAIN_KEY = 'k2'; return chain_row_hash(GENESIS_HASH, f); })();
    check('different key → different hash', h1 !== h2);
    process.env.HEARTH_AUDIT_CHAIN_KEY = 'smoke-test-key';

    // ── 3. Edit detection ───────────────────────────────────────────────
    console.log('→ tamper detection');
    db.prepare(`UPDATE audit_log SET tool_input = @t WHERE tool_name = 'b'`).run({ '@t': '{"x":"TAMPERED"}' });
    v = verify_audit_chain(db);
    check('edit detected (broken)', v.status === 'broken');
    check('edit break reason = edited', v.first_break_reason === 'edited');
    check('edit break at row b', v.first_break_id === r[1]!.id);

    // restore (re-seal so the rest of the smoke runs on a clean chain)
    db.prepare(`UPDATE audit_log SET tool_input = @t WHERE tool_name = 'b'`).run({ '@t': '{"x":"b"}' });
    reseal_audit_chain(db);
    check('reseal restores intact', verify_audit_chain(db).status === 'intact');

    // ── 4. Delete detection ─────────────────────────────────────────────
    r = rows_of(db);
    db.prepare(`DELETE FROM audit_log WHERE tool_name = 'b'`).run();
    v = verify_audit_chain(db);
    check('delete detected (broken)', v.status === 'broken');
    check('delete reason = deleted_or_reordered', v.first_break_reason === 'deleted_or_reordered');

    // ── 7. Kill switch ──────────────────────────────────────────────────
    console.log('→ kill switch + resume');
    reseal_audit_chain(db); // clean baseline (2 rows: a, c)
    process.env.HEARTH_AUDIT_CHAIN = '0';
    log(memory, 'd_unchained');
    process.env.HEARTH_AUDIT_CHAIN = '1';
    const d = db.prepare(`SELECT row_hash FROM audit_log WHERE tool_name='d_unchained'`).get() as { row_hash: string | null };
    check('kill switch → row written UNCHAINED (null hash)', d.row_hash === null);
    v = verify_audit_chain(db);
    check('unchained row counted, chain still intact', v.status === 'intact' && v.unchained_rows === 1);
    log(memory, 'e'); // resumes chaining from the prior chained head
    check('chaining resumes after kill switch', verify_audit_chain(db).status === 'intact');

    // ── 8. Reseal a mixed ledger ────────────────────────────────────────
    console.log('→ reseal mixed ledger');
    const res = reseal_audit_chain(db);
    check('reseal sealed all rows', res.sealed === rows_of(db).length);
    v = verify_audit_chain(db);
    check('post-reseal full verify intact', v.status === 'intact' && v.unchained_rows === 0);

    // ── 9. Recent-window scope ──────────────────────────────────────────
    for (let i = 0; i < 10; i++) log(memory, `bulk_${i}`);
    v = verify_audit_chain(db, { limit: 3 });
    check('recent-window scope', v.scope === 'recent' && v.rows_checked === 3 && v.status === 'intact');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
