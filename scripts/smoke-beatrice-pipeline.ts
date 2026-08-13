/**
 * smoke:beatrice-pipeline — the safe self-modification pipeline, offline.
 *
 * Exercises the change-control state machine + the NON-BYPASSABLE merge gate +
 * Kate's skeptic verdict routing, with HEARTH_TEST_MODE stubbing all git/Gitea
 * I/O. No orchestrator, no network, no real repo writes.
 *
 *   bun run smoke:beatrice-pipeline
 */
process.env.HEARTH_TEST_MODE = '1';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { ChangeRecordsStore } from '@memory/stores/change_records';
import { ProposalsStore } from '@core/proposals';
import { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';
import type { ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { create as create_merge } from '@specialists/trainer/tools/merge_approved_change';
import { create as create_review } from '@specialists/kate/tools/review_change';
import { create as create_list } from '@specialists/kate/tools/list_changes_for_review';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-beatrice-'));
const db = open_db(join(dir, 'pipeline.db'));

const events = { emit: () => undefined } as unknown as AppEventBus;
const ctx = { memory: { log_action: () => 'audit_smoke' }, intent_id: 'smoke', specialist_id: 'kate', now: new Date() } as unknown as ToolContext;

try {
  const store = new ChangeRecordsStore(db);
  const proposals = new ProposalsStore(db);
  const inbox = new SpecialistInbox(db);

  const mergeTool = create_merge({ db } as unknown as ToolDeps);
  const reviewTool = create_review({ db, proposals, inbox, events } as unknown as ToolDeps);
  const listTool = create_list({ db } as unknown as ToolDeps);

  const mkchange = (dedup: string) =>
    store.create({
      origin: 'apply_low_risk_fix',
      change_kind: 'add_tool_to_chat_surface',
      target_specialist_id: 'kristi',
      branch: `beatrice/test-${dedup}`,
      pr_number: 42,
      pr_url: 'http://gitea/test/pr/42',
      commit_sha: 'abc',
      files: ['config/specialists/kristi.yaml'],
      lines_added: 1,
      lines_removed: 0,
      languages: ['YAML'],
      diff_summary: '+    - update_sku',
      rationale_md: 'surface update_sku to chat',
      dedup_key: dedup,
    });

  // ── 1. Create → pending_kate_review ──────────────────────────────────────
  const c1 = mkchange('d1');
  check('new change starts pending_kate_review', c1.status === 'pending_kate_review');
  check('change carries the embedded diff for Kate', c1.diff_summary.includes('update_sku'));

  // ── 2. THE GATE: merge refuses a change Kate hasn't approved ─────────────
  const blocked = (await mergeTool.execute({ change_id: c1.id }, ctx)) as { merged: boolean; reason?: string };
  check('merge_approved_change REFUSES a pending_kate_review change', blocked.merged === false);
  check('  …refusal names the gate', !!blocked.reason && blocked.reason.includes('pending_owner_merge'));
  check('  …and the change is still NOT merged', store.get(c1.id)?.status === 'pending_kate_review');

  // ── 3. list_changes_for_review surfaces it to Kate ───────────────────────
  const listed = (await listTool.execute({ limit: 10 }, ctx)) as { count: number; changes: Array<{ change_id: string; diff_summary: string }> };
  check('list_changes_for_review surfaces the pending change', listed.changes.some((c) => c.change_id === c1.id));

  // ── 4. Kate DENY → denied_by_kate, routed back to Beatrice ───────────────
  const denied = (await reviewTool.execute(
    { change_id: c1.id, verdict: 'deny', reasons_md: 'Adds a tool that is not justified by the rationale.' },
    ctx,
  )) as { new_status: string; routed_to: string };
  check('Kate deny → denied_by_kate', denied.new_status === 'denied_by_kate' && denied.routed_to === 'trainer');
  const deniedMerge = (await mergeTool.execute({ change_id: c1.id }, ctx)) as { merged: boolean };
  check('a Kate-denied change still cannot be merged', deniedMerge.merged === false);

  // ── 5. Kate APPROVE → pending_owner_merge + owner proposal ───────────────
  const c2 = mkchange('d2');
  const approved = (await reviewTool.execute(
    { change_id: c2.id, verdict: 'approve', reasons_md: 'Verified: update_sku is registered and grant is satisfied.' },
    ctx,
  )) as { new_status: string; routed_to: string; proposal_id: string | null };
  check('Kate approve → pending_owner_merge', approved.new_status === 'pending_owner_merge' && approved.routed_to === 'owner');
  check('Kate approve files an owner merge proposal', !!approved.proposal_id);
  const prop = approved.proposal_id ? proposals.get(approved.proposal_id) : null;
  const payload = prop ? (JSON.parse((prop as { payload_json: string }).payload_json) as { dispatch_tool?: string; change_id?: string }) : null;
  check('  …proposal dispatches merge_approved_change for this change', payload?.dispatch_tool === 'merge_approved_change' && payload?.change_id === c2.id);
  check('  …change record links back to the proposal', store.get(c2.id)?.related_proposal_id === approved.proposal_id);

  // ── 6. Owner approval (simulated) → Beatrice merges ──────────────────────
  const merged = (await mergeTool.execute({ change_id: c2.id }, ctx)) as { merged: boolean; deploy_class: string };
  check('owner-approved change merges', merged.merged === true);
  check('  …config-only change classified config_hot_reload', merged.deploy_class === 'config_hot_reload');
  check('  …status is now merged', store.get(c2.id)?.status === 'merged');

  // ── 7. Merge is idempotent ───────────────────────────────────────────────
  const again = (await mergeTool.execute({ change_id: c2.id }, ctx)) as { merged: boolean; reason?: string };
  check('re-merge is an idempotent no-op', again.merged === true && (again.reason ?? '').includes('idempotent'));

  // ── 8. A re-filed change (same dedup_key) supersedes the prior ───────────
  const c3a = mkchange('dsup');
  const c3b = mkchange('dsup');
  check('re-filing the same dedup_key supersedes the prior row', store.get(c3a.id)?.status === 'superseded');
  check('  …and points superseded_by at the new row', store.get(c3a.id)?.superseded_by === c3b.id);
  check('  …new row is live for review', store.get(c3b.id)?.status === 'pending_kate_review');
} finally {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} pipeline assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nAll Beatrice-pipeline assertions passed.');
