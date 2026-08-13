/**
 * Smoke for proposal supersession + readable title/summary.
 *
 *   bun run scripts/smoke-proposal-dedup.ts
 *
 * Self-contained: in-memory DB, no live deps. Verifies the two
 * load-bearing behaviors the user asked for:
 *
 *   1. A newer proposal sharing dedup_key with an open older one
 *      marks the older `superseded` and pointer it at the new id.
 *   2. The queue (`list()`) hides superseded rows by default;
 *      `include_superseded: true` brings them back for diagnostics.
 *   3. Kinds without a clean subject (action_proposal, draft_message)
 *      stay independent — no false-positive supersession.
 *   4. title / summary are populated for known kinds.
 *   5. backfill_titles() is idempotent — second call sees zero NULLs.
 */

import { Database } from 'bun:sqlite';
import { ProposalsStore } from '../src/core/proposals';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

function make_db(): Database {
  const db = new Database(':memory:');
  // Minimal schema for the smoke — proposals + category_signatures +
  // proposals_fts. Matches the columns ProposalsStore.create() writes.
  db.exec(`
    CREATE TABLE proposals (
      id TEXT PRIMARY KEY,
      ts_created TEXT NOT NULL,
      ts_surfaced TEXT,
      ts_decided TEXT,
      ts_executed TEXT,
      specialist_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      execution_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      rationale_md TEXT NOT NULL,
      category_signature_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      snoozed_until TEXT,
      modifications_json TEXT,
      execution_result_json TEXT,
      user_feedback TEXT,
      title TEXT,
      summary TEXT,
      dedup_key TEXT,
      superseded_by TEXT,
      superseded_at TEXT,
      actions_json TEXT,
      action_taken TEXT,
      user_id TEXT
    );
    CREATE INDEX idx_proposals_dedup_open
      ON proposals (dedup_key, status)
      WHERE dedup_key IS NOT NULL;
    CREATE TABLE category_signatures (
      hash TEXT PRIMARY KEY,
      signature_json TEXT NOT NULL,
      approval_count INTEGER NOT NULL DEFAULT 0,
      edit_count INTEGER NOT NULL DEFAULT 0,
      denial_count INTEGER NOT NULL DEFAULT 0,
      autonomy_status TEXT NOT NULL DEFAULT 'tier2a'
    );
    CREATE VIRTUAL TABLE proposals_fts USING fts5(
      body, proposal_id UNINDEXED, specialist_id UNINDEXED
    );
  `);
  return db;
}

async function main() {
  const db = make_db();
  const store = new ProposalsStore(db);
  const checks: string[] = [];

  // ── 1. Persona-tuning supersession ─────────────────────────────────
  // First persona-tuning for kate. Then a refined one ten seconds
  // later — older should flip to 'superseded' with superseded_by
  // pointing at the new id.
  const oldKateID = store.create({
    specialist_id: 'trainer',
    kind: 'persona_tuning',
    execution_kind: 'manual',
    payload: {
      target_specialist_id: 'kate',
      diagnosis: 'silent-on-posture',
      verbatim_feedback: 'first version',
      proposed_change: 'Old text — superseded.',
    },
    rationale: 'First persona-tuning for kate; will be superseded.',
    signature: { specialist_id: 'trainer', kind: 'persona_tuning', category: 'persona', anchor: 'kate' },
  });
  assert(oldKateID, 'old proposal id returned');

  await new Promise((r) => setTimeout(r, 5));
  const newKateID = store.create({
    specialist_id: 'trainer',
    kind: 'persona_tuning',
    execution_kind: 'manual',
    payload: {
      target_specialist_id: 'kate',
      diagnosis: 'silent-on-posture',
      verbatim_feedback: 'second version, refined',
      proposed_change: 'New, sharper guidance for kate.',
    },
    rationale: 'Refined persona-tuning for kate.',
    signature: { specialist_id: 'trainer', kind: 'persona_tuning', category: 'persona', anchor: 'kate' },
  });
  assert(newKateID && newKateID !== oldKateID, 'new proposal landed as a distinct row');

  const oldRow = store.get(oldKateID)!;
  const newRow = store.get(newKateID)!;
  assert(oldRow.status === 'superseded', `old status expected superseded, got ${oldRow.status}`);
  assert(oldRow.superseded_by === newKateID, `superseded_by points at new id`);
  assert(oldRow.superseded_at != null, 'superseded_at stamped');
  // Trainer self-improvement specs are born `pending_kate_review` (2026-06-15
  // gate) — Kate critiques before the owner sees it. Supersession still fires
  // (its open-row scan includes the gate state), so the surviving row keeps
  // that holding status rather than `pending`.
  assert(newRow.status === 'pending_kate_review', 'new row held for Kate pre-review');
  checks.push('persona_tuning supersession marks older superseded + sets pointer');

  // ── 2. list() hides superseded (and pending_kate_review) by default ─
  const defaultList = store.list({});
  const oldInDefault = defaultList.find((r) => r.id === oldKateID);
  assert(!oldInDefault, 'default list hides superseded row');
  // The surviving trainer persona_tuning is pending_kate_review — also hidden
  // from the owner's default queue; Kate reaches it via an explicit status query.
  assert(!defaultList.find((r) => r.id === newKateID), 'default list hides the pending_kate_review row too');
  assert(
    store.list({ status: 'pending_kate_review' }).find((r) => r.id === newKateID),
    'Kate review surface shows the new row',
  );

  const fullList = store.list({ include_superseded: true });
  assert(fullList.find((r) => r.id === oldKateID), 'include_superseded surfaces the old row');
  checks.push('list() filter — superseded + pending_kate_review hidden by default, surfaceable on opt-in');

  // ── 3. Different subject = independent rows ─────────────────────────
  const maggieID = store.create({
    specialist_id: 'trainer',
    kind: 'persona_tuning',
    execution_kind: 'manual',
    payload: {
      target_specialist_id: 'maggie',
      diagnosis: 'silent-on-posture',
      proposed_change: 'Maggie-specific change.',
    },
    rationale: 'Persona tuning for maggie, distinct subject from kate.',
    signature: { specialist_id: 'trainer', kind: 'persona_tuning', category: 'persona', anchor: 'maggie' },
  });
  assert(store.get(maggieID)!.status === 'pending_kate_review', 'maggie tuning held for Kate pre-review');
  assert(store.get(newKateID)!.status === 'pending_kate_review', 'kate tuning unaffected by maggie ship');
  checks.push('different dedup_key = independent rows (no false supersession)');

  // ── 4. Kinds without dedup_key never supersede ──────────────────────
  const action1 = store.create({
    specialist_id: 'kate',
    kind: 'action_proposal',
    execution_kind: 'dispatch',
    payload: { summary: 'First action' },
    rationale: 'First action proposal',
    signature: { specialist_id: 'kate', kind: 'action_proposal', category: 'general' },
  });
  const action2 = store.create({
    specialist_id: 'kate',
    kind: 'action_proposal',
    execution_kind: 'dispatch',
    payload: { summary: 'Second action — different content' },
    rationale: 'Second action proposal — should NOT supersede the first',
    signature: { specialist_id: 'kate', kind: 'action_proposal', category: 'general' },
  });
  assert(store.get(action1)!.status === 'pending', 'first action_proposal stays pending');
  assert(store.get(action2)!.status === 'pending', 'second action_proposal also pending');
  assert(store.get(action1)!.dedup_key === null, 'action_proposal has null dedup_key');
  checks.push('action_proposal stays independent — no false supersession');

  // ── 5. Connector recovery supersession (same tool) ─────────────────
  const recA = store.create({
    specialist_id: 'trainer',
    kind: 'recommendation',
    execution_kind: 'manual',
    payload: {
      tool_name: 'read_note',
      recovery_field_name: 'candidates',
      blast_radius: 4,
      summary: 'First version of the read_note recovery hint.',
    },
    rationale: 'Add candidates to read_note, first attempt.',
    signature: { specialist_id: 'trainer', kind: 'recommendation', category: 'connector_recovery', anchor: 'read_note' },
  });
  const recB = store.create({
    specialist_id: 'trainer',
    kind: 'recommendation',
    execution_kind: 'manual',
    payload: {
      tool_name: 'read_note',
      recovery_field_name: 'candidates',
      blast_radius: 6,
      summary: 'Refined: with explicit derive_url_candidates helper.',
    },
    rationale: 'Refined connector-recovery hint for read_note.',
    signature: { specialist_id: 'trainer', kind: 'recommendation', category: 'connector_recovery', anchor: 'read_note' },
  });
  assert(store.get(recA)!.status === 'superseded', 'older recommendation superseded');
  assert(store.get(recA)!.superseded_by === recB, 'older points at newer');
  checks.push('connector-recovery supersession works (keyed on tool_name)');

  // ── 6. Title + summary present and meaningful ──────────────────────
  const newKate = store.get(newKateID)!;
  assert(
    typeof newKate.title === 'string' && newKate.title.includes('Kate'),
    `title populated with target — got "${newKate.title}"`,
  );
  assert(
    typeof newKate.summary === 'string' && (newKate.summary?.length ?? 0) > 0,
    'summary populated',
  );
  const recBRow = store.get(recB)!;
  assert(
    typeof recBRow.title === 'string' && recBRow.title.includes('read_note'),
    `recommendation title mentions tool — got "${recBRow.title}"`,
  );
  checks.push('title/summary computed and surface the right details');

  // ── 7. backfill is idempotent ───────────────────────────────────────
  const firstBackfill = store.backfill_titles();
  assert(firstBackfill.rows_updated === 0, `first backfill should be no-op (all writes covered new path), saw ${firstBackfill.rows_updated} updates`);
  // Insert a row directly (bypassing store) with NULLs, then verify
  // backfill picks it up.
  db.prepare(
    `INSERT INTO proposals
       (id, ts_created, specialist_id, kind, execution_kind, payload_json, rationale_md, status)
     VALUES ('legacy_01', '2026-05-20T00:00:00Z', 'trainer', 'persona_tuning', 'manual',
             '{"target_specialist_id":"vivian","diagnosis":"test"}',
             'Legacy persona-tuning for vivian.', 'pending')`,
  ).run();
  const second = store.backfill_titles();
  assert(second.rows_updated === 1, `second backfill should pick up legacy row, saw ${second.rows_updated}`);
  const legacy = store.get('legacy_01')!;
  assert(legacy.title?.includes('Vivian') === true, `legacy title backfilled — got "${legacy.title}"`);
  assert(legacy.dedup_key === 'persona_tuning:vivian', `legacy dedup_key backfilled — got "${legacy.dedup_key}"`);
  // Third call should be no-op again.
  const third = store.backfill_titles();
  assert(third.rows_updated === 0, 'third backfill is idempotent');
  checks.push('backfill_titles is idempotent + populates legacy rows');

  console.log(`OK — ${checks.length} checks passed`);
  for (const c of checks) console.log(`  ✓ ${c}`);
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  process.exit(1);
});
