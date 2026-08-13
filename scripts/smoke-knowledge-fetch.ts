/**
 * smoke:knowledge-fetch — self-contained test of the self-FETCH pass (#fetch).
 * Temp db; seeds demand-ledger signals (rag_low_confidence audit rows) across
 * shelves + users, injects a MOCK acquire, and asserts the orchestration:
 *   - strongest evidence-backed gaps that map to a real shelf are selected
 *   - the evidence floor excludes thin gaps
 *   - acquire is called SILENT (the no-noise contract — no owner proposals)
 *   - the per-user cordon threads sole_user_id → private_to_user_id
 *   - the per-run topic cap holds; items_shelved aggregates; audit rows land
 *   - the kill switch
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { fetch_for_gaps, type AcquireFn } from '../src/specialists/cordelia/knowledge_fetch';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-fetch-'));
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root: join(dir, 'vault'), db });
const NOW = new Date('2026-06-15T12:00:00Z');

// Seed demand: rag_low_confidence rows clustered per shelf. Identical query text
// per shelf so the deterministic miner groups them into one topic.
function seed_demand(agent: string, query: string, user_id: string, n: number): void {
  for (let i = 0; i < n; i++) {
    memory.log_action({
      intent_id: `d-${agent}-${i}`,
      agent: agent as never,
      tool_name: 'rag_low_confidence',
      tool_input: { query_preview: query },
      user_id,
    });
  }
}
// Eleanor: strong owner gap (evidence 3). Vivian: a sam-only gap (evidence 2 →
// cordon). Anya: a thin gap (evidence 1 → below the floor, excluded).
seed_demand('eleanor', 'rare orchid root rot fungal treatment options', 'jasper', 3);
seed_demand('vivian', 'municipal bond tax strategy laddering', 'sam', 2);
seed_demand('anya', 'feline dental cleaning frequency', 'jasper', 1);

// ── mock acquire ────────────────────────────────────────────────────────────
const calls: Array<{ topic: string; specialist_id: string; silent: boolean; private_to_user_id?: string }> = [];
const mock_acquire: AcquireFn = async (input) => {
  calls.push({ topic: input.topic, specialist_id: input.specialist_id, silent: input.silent, private_to_user_id: input.private_to_user_id });
  return { shelved: [{ note_path: `Knowledge/${input.specialist_id}/library/fetched.md` }] };
};

const deps = { db, memory, acquire: mock_acquire };

// ── kill switch ─────────────────────────────────────────────────────────────
process.env.HEARTH_SYNTHESIS_FETCH = '0';
const off = await fetch_for_gaps(deps, { now: NOW });
delete process.env.HEARTH_SYNTHESIS_FETCH;
check('kill switch: disabled, no acquire calls', !off.enabled && calls.length === 0);

// ── the real pass ───────────────────────────────────────────────────────────
const r = await fetch_for_gaps(deps, { now: NOW, owner_id: 'jasper' });

check('selected the 2 evidence-backed shelf gaps (thin one excluded)', r.gaps_considered === 2 && r.topics_fetched === 2);
check('acquire called once per gap', calls.length === 2);
check('EVERY acquire call is SILENT (no owner proposals)', calls.every((c) => c.silent === true));
check('acquired onto the right shelves', calls.some((c) => c.specialist_id === 'eleanor') && calls.some((c) => c.specialist_id === 'vivian'));
{
  const viv = calls.find((c) => c.specialist_id === 'vivian')!;
  const ele = calls.find((c) => c.specialist_id === 'eleanor')!;
  check('cordon: a sam-only gap threads private_to_user_id=sam', viv.private_to_user_id === 'sam');
  check('cordon: an owner gap stays unstamped (shelf-wide)', ele.private_to_user_id === undefined);
}
check('items_shelved aggregates the sprint survivors', r.items_shelved === 2);
check('thin gap (evidence 1) was NOT fetched', !calls.some((c) => c.specialist_id === 'anya'));
{
  const rows = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE tool_name = 'knowledge_fetch'`).get() as { n: number };
  check('every fetch writes an audit row', rows.n === 2);
}

// ── per-run cap ─────────────────────────────────────────────────────────────
calls.length = 0;
const capped = await fetch_for_gaps(deps, { now: NOW, max_topics: 1, owner_id: 'jasper' });
check('per-run cap: only the strongest gap fetched', capped.topics_fetched === 1 && calls.length === 1 && calls[0]!.specialist_id === 'eleanor');

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nsmoke:knowledge-fetch OK' : `\nsmoke:knowledge-fetch FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
