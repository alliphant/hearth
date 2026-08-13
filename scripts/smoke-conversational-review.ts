/**
 * smoke:conversational-review — the text-first PR review loop (2026-07-18).
 *
 * Covers the three pieces that let the owner review a Beatrice change in
 * CHAT instead of a GUI:
 *   A. ChangeRecordsStore.send_back — the guarded pending_owner_merge →
 *      denied_by_kate transition (and ONLY from that status).
 *   B. list_changes_for_review — change_id fetch at any status + the
 *      status filter (his merge queue is readable mid-conversation).
 *   C. review_change deny-from-owner-queue — sends the change back with
 *      the owner's feedback, WITHDRAWS the merge card (proposal denied),
 *      flags Beatrice, and refuses re-approval from that state.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { ChangeRecordsStore } from '@memory/stores/change_records';
import { SpecialistInbox } from '@memory/stores/conversations';
import { ProposalsStore } from '@core/proposals';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { make_review_change } from '../src/specialists/kate/tools/review_change';
import { create as create_list_changes } from '../src/specialists/kate/tools/list_changes_for_review';

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'smoke-conv-review-'));
const db = open_db(join(tmp, 'test.db'));
const changes = new ChangeRecordsStore(db);
const proposals = new ProposalsStore(db);
const inbox = new SpecialistInbox(db);

const memory_fake = {
  log_action: () => 'audit_fake',
  upsert_note: () => undefined,
  read_note: () => null,
} as unknown as ToolDeps['memory'];
const events_fake = { emit: () => undefined } as unknown as ToolDeps['events'];

const review_tool = make_review_change({
  db,
  proposals,
  inbox,
  events: events_fake,
  memory: memory_fake,
});
const list_tool = create_list_changes({ db } as unknown as ToolDeps) as Tool;

const ctx = {
  memory: memory_fake,
  llm: null,
  now: new Date(),
  intent_id: 'i1',
  specialist_id: 'kate',
  conversation_id: 'conv_1',
  user: { id: 'jasper', tier: 'owner' },
} as unknown as ToolContext;

const mk_change = () =>
  changes.create({
    origin: 'propose_code_change',
    change_kind: 'code',
    target_specialist_id: 'kate',
    branch: 'beatrice/test',
    files: ['src/core/example.ts'],
    lines_added: 12,
    lines_removed: 3,
    languages: ['ts'],
    diff_summary: '--- a/src/core/example.ts\n+++ b/src/core/example.ts\n+// example hunk',
    rationale_md: 'Test rationale.',
    checks_passed: true,
    checks_summary: 'tsc clean; guard clean',
  });

// ── A. send_back store guard ────────────────────────────────────────────────
console.log('A. ChangeRecordsStore.send_back');
{
  const fresh = mk_change();
  assert(changes.send_back(fresh.id, 'nope') === null, 'send_back refuses pending_kate_review');

  changes.set_kate_verdict(fresh.id, 'approve', 'looks structurally sound to me');
  const sent = changes.send_back(fresh.id, 'owner wants stricter input validation');
  assert(sent?.status === 'denied_by_kate', 'send_back moves pending_owner_merge → denied_by_kate');
  assert(
    sent?.kate_verdict === 'deny' &&
      (sent?.kate_reasons_md ?? '').includes('stricter input validation'),
    'send_back records the owner feedback as the deny reasons',
  );
  assert(changes.send_back(fresh.id, 'again') === null, 'send_back is single-shot (already denied)');
}

// ── B. list_changes_for_review filters ─────────────────────────────────────
console.log('B. list_changes_for_review — change_id + status filter');
{
  const pending = mk_change();
  const approved = mk_change();
  changes.set_kate_verdict(approved.id, 'approve', 'fine by my review — over to the owner');

  const run = (input: Record<string, unknown>) =>
    list_tool.execute(list_tool.input_schema.parse(input), ctx) as Promise<{
      count: number;
      changes: Array<Record<string, unknown>>;
    }>;

  const default_view = await run({});
  assert(
    default_view.changes.some((c) => c.change_id === pending.id) &&
      !default_view.changes.some((c) => c.change_id === approved.id),
    'default listing stays the pending_kate_review queue',
  );

  const owner_queue = await run({ status: 'pending_owner_merge' });
  assert(
    owner_queue.changes.some((c) => c.change_id === approved.id) &&
      owner_queue.changes.every((c) => c.status === 'pending_owner_merge'),
    "status:'pending_owner_merge' reads his merge queue",
  );

  const by_id = await run({ change_id: approved.id });
  assert(
    by_id.count === 1 &&
      by_id.changes[0]!.status === 'pending_owner_merge' &&
      by_id.changes[0]!.kate_verdict === 'approve' &&
      typeof by_id.changes[0]!.diff_summary === 'string',
    'change_id fetches one change at any status with verdict + diff',
  );

  const missing = await run({ change_id: 'bchg_nope' });
  assert(missing.count === 0, 'unknown change_id returns empty, not an error');
}

// ── C. review_change deny-from-owner-queue ──────────────────────────────────
console.log('C. review_change — the owner send-back');
{
  const row = mk_change();
  const run = (input: Record<string, unknown>) =>
    review_tool.execute(review_tool.input_schema.parse(input), ctx) as Promise<
      Record<string, unknown>
    >;

  const approved = await run({
    change_id: row.id,
    verdict: 'approve',
    reasons_md: 'Scope matches the rationale; checks green; no blast-radius concerns.',
  });
  const merge_proposal_id = approved.proposal_id as string;
  assert(
    approved.new_status === 'pending_owner_merge' && typeof merge_proposal_id === 'string',
    'approve files the merge card and advances the change',
  );
  assert(proposals.get(merge_proposal_id)?.status === 'pending', 'merge card is pending');

  const reapprove = await run({
    change_id: row.id,
    verdict: 'approve',
    reasons_md: 'trying to re-approve from the owner queue — must be refused',
  });
  assert(
    reapprove.routed_to === 'none' && String(reapprove.reason).includes('merge queue'),
    're-approve from pending_owner_merge is refused with guidance',
  );

  const before_flags = inbox.list_for('trainer').length;
  const sent_back = await run({
    change_id: row.id,
    verdict: 'deny',
    reasons_md: 'Owner in chat — please split the migration out and add a rollback path.',
  });
  assert(
    sent_back.new_status === 'denied_by_kate' && sent_back.routed_to === 'trainer',
    'deny from the owner queue sends the change back to Beatrice',
  );
  assert(
    proposals.get(merge_proposal_id)?.status === 'denied',
    'the merge card is WITHDRAWN (denied) — a stale card cannot be approved',
  );
  const flags = inbox.list_for('trainer');
  assert(
    flags.length === before_flags + 1 &&
      (flags[0]?.body_md ?? '').includes('rollback path'),
    "Beatrice's flag carries the owner's requested changes",
  );
  assert(changes.get(row.id)?.status === 'denied_by_kate', 'change record landed denied_by_kate');
}

db.close();
rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\nsmoke:conversational-review FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log('\nsmoke:conversational-review PASSED');
process.exit(0);
