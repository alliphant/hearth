/**
 * smoke:good-followups — Kate's reactive goods-followup edge detector (Phase 1d)
 * AND the learning loop it closes with the Trust Ladder (Phase 1a/1e).
 *
 * Self-contained: temp db + vault, no orchestrator, no LLM. Exercises:
 *   - scan_good_followups: goods with a closing return window / expiring
 *     warranty → one action_proposal each
 *   - edge dedup: a second run files nothing (exists_for_signature)
 *   - cordon scoping: a household good → owner-global proposal (user_id null);
 *     a member's personal good → that member's proposal (user_id = them)
 *   - the kill switch (HEARTH_HOUSEHOLD_GRAPH off → no-op)
 *   - the LOOP: deciding a followup proposal accrues Trust-Ladder XP
 *
 *   bun run smoke:good-followups
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { rebuild } from '@ingestor/rebuild';
import { ProposalsStore } from '@core/proposals';
import { enrich_order_to_good } from '@core/household_knowledge/enrich';
import { make_scan_good_followups } from '@specialists/kate/tools/scan_good_followups';
import type { ToolContext } from '@core/tool';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

function write_good(
  memory: MemoryClient,
  order: { order_key: string; merchant: string; items: string; order_date: string },
  private_to: string,
  buyer: string,
): void {
  const e = enrich_order_to_good(
    {
      order_key: order.order_key,
      merchant: order.merchant,
      items: order.items,
      order_total: '$200.00',
      order_date: order.order_date,
      status: 'delivered',
      // Durable — the followup scan is *about* returnable goods; a consumable
      // has no window to close, so it never reaches this tool at all.
      fulfillment: 'durable_goods',
    },
    { buyer_display_name: buyer, private_to, now: new Date('2026-06-20T12:00:00Z') },
  );
  memory.upsert_note(e.note_path, e.frontmatter as Record<string, unknown>, e.body);
}

async function main(): Promise<void> {
  process.env.HEARTH_HOUSEHOLD_GRAPH = '1';
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-followups-'));
  const vault = join(tmp, 'vault');
  mkdirSync(vault, { recursive: true });
  const db = open_db(join(tmp, 'hearth.db'));
  const memory = new MemoryClient({ vault_root: vault, db });
  const proposals = new ProposalsStore(db);
  const now = new Date('2026-06-20T12:00:00Z');

  // Good A — household electronics ordered 2026-05-25 → return window closes
  // 2026-06-24 (within 14d). Warranty 2027-05-25 (far off).
  write_good(memory, { order_key: 'sony:a', merchant: 'Sony', items: 'soundbar speaker', order_date: '2026-05-25T00:00:00Z' }, 'household', 'Jasper');
  // Good B — Sam's personal electronics ordered 2025-06-25 → warranty expires
  // 2026-06-25 (within 14d). Return window long past.
  write_good(memory, { order_key: 'dell:b', merchant: 'Dell', items: 'laptop charger', order_date: '2025-06-25T00:00:00Z' }, 'sam', 'Sam');
  // Good C — household groceries, no warranty/return signal in window → no followup.
  write_good(memory, { order_key: 'wf:c', merchant: 'Whole Foods', items: 'grocery food', order_date: '2026-06-19T00:00:00Z' }, 'household', 'Jasper');
  await rebuild(vault, memory, db);

  const tool = make_scan_good_followups({ memory, proposals });
  const ctx: ToolContext = { memory, now, intent_id: 'i1' } as ToolContext;

  // ── 1. First run files the due followups ─────────────────────────────────
  const r1 = await tool.execute({ within_days: 14 }, ctx);
  check('first run is enabled', r1.enabled === true);
  check('two goods are due (A return, B warranty)', r1.due === 2);
  check('two followup proposals filed', r1.filed === 2);

  // ── 2. Cordon scoping of the filed proposals ─────────────────────────────
  const user_of = (pid: string) =>
    (db.prepare(`SELECT user_id FROM proposals WHERE id = @id`).get({ '@id': pid }) as { user_id: string | null }).user_id;
  const kinds = r1.proposal_ids.map((pid) => ({
    pid,
    user_id: user_of(pid),
    payload: JSON.parse((db.prepare(`SELECT payload_json FROM proposals WHERE id = @id`).get({ '@id': pid }) as { payload_json: string }).payload_json) as { followup_kind: string; good_name: string },
  }));
  const a = kinds.find((k) => k.payload.followup_kind === 'return_window')!;
  const b = kinds.find((k) => k.payload.followup_kind === 'warranty')!;
  check('household good’s return followup is owner-global (user_id null)', a.user_id === null);
  check('Sam’s warranty followup is scoped to Sam', b.user_id === 'sam');

  // ── 3. Edge dedup: a second run files nothing new ────────────────────────
  const r2 = await tool.execute({ within_days: 14 }, ctx);
  check('second run still sees both due', r2.due === 2);
  check('second run files NOTHING new (edge dedup)', r2.filed === 0);

  // ── 4. The loop: deciding a followup accrues Trust-Ladder XP ──────────────
  process.env.HEARTH_TRUST_XP = '1';
  const before = (() => {
    const h = proposals.get(a.pid)!.category_signature_hash!;
    return proposals.trust_level_for(h)!.xp;
  })();
  proposals.decide(a.pid, 'approve');
  const after_h = proposals.get(a.pid)!.category_signature_hash!;
  const after = proposals.trust_level_for(after_h)!.xp;
  check('deciding the followup accrued XP (the closed loop)', after > before);
  delete process.env.HEARTH_TRUST_XP;

  // ── 5. Kill switch ───────────────────────────────────────────────────────
  delete process.env.HEARTH_HOUSEHOLD_GRAPH;
  const r3 = await tool.execute({ within_days: 14 }, ctx);
  check('kill switch OFF → tool no-ops', r3.enabled === false && r3.filed === 0);

  db.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n✅ smoke:good-followups — ${passed} checks passed`);
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
