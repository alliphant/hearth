export {};
/**
 * smoke:kate-proposal-gate — Kate's pre-review gate for Beatrice's specs.
 *
 * Self-contained: temp SQLite, ProposalsStore + SpecialistInbox + the
 * list_proposals_for_review / review_trainer_proposal tools. Asserts:
 *   - a trainer-authored binding_proposal / persona_tuning / recommendation is
 *     born `pending_kate_review` — hidden from the owner queue (status=pending)
 *     AND the default owner list, surfaced only by list_for_kate_review
 *   - promote → `pending` (now owner-visible); send_back → `denied` + a flag to
 *     trainer, WITHOUT bumping the category-signature denial_count
 *   - skip_kate_review (the review_change merge-card) lands `pending` directly
 *   - a NON-trainer recommendation is never gated
 *   - re-review of an already-decided row is a guarded no-op
 *
 *   bun run smoke:kate-proposal-gate
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { open_db } from '@memory/stores/structured';
import { ProposalsStore, type CategorySignature, hash_signature } from '@core/proposals';
import { SpecialistInbox } from '@memory/stores/conversations';
import { AppEventBus } from '@app/events';
import {
  make_list_proposals_for_review,
  make_review_trainer_proposal,
} from '../src/specialists/kate/tools/review_trainer_proposal';
import type { ToolContext } from '@core/tool';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(resolve(tmpdir(), 'hearth-kate-gate-'));
const db = open_db(resolve(dir, 'hearth.db'));

try {
  const proposals = new ProposalsStore(db);
  const inbox = new SpecialistInbox(db);
  const events = new AppEventBus();
  const ctx = {
    intent_id: 'smoke-gate',
    specialist_id: 'kate',
    memory: { log_action: () => 'audit' },
  } as unknown as ToolContext;

  const list_tool = make_list_proposals_for_review(proposals);
  const review_tool = make_review_trainer_proposal({ proposals, inbox, events });

  const sig = (kind: string): CategorySignature => ({
    specialist_id: 'trainer',
    kind,
    category: 'self_improvement',
  });

  // ── 1. trainer binding_proposal is born pending_kate_review ──────────────
  const bp = proposals.create({
    specialist_id: 'trainer',
    kind: 'binding_proposal',
    execution_kind: 'manual',
    payload: { slug: 'fix-foo', summary: 'Add a recovery hint to foo connector' },
    rationale: 'foo returns a bare error; add candidates on the error path.',
    signature: sig('binding_proposal'),
  });
  check('trainer binding_proposal → pending_kate_review', proposals.get(bp)?.status === 'pending_kate_review');

  // hidden from the owner queue (explicit status=pending) AND the default list
  const owner_pending = proposals.list({ status: 'pending', visible_to: { user_id: 'jasper', tier: 'owner' } });
  check('not in owner status=pending queue', !owner_pending.some((p) => p.id === bp));
  const owner_default = proposals.list({ visible_to: { user_id: 'jasper', tier: 'owner' } });
  check('not in owner default (no-status) list', !owner_default.some((p) => p.id === bp));

  // surfaced only to Kate's review queue
  const review_list = (await list_tool.execute({}, ctx)).proposals;
  check('list_proposals_for_review surfaces it', review_list.some((p) => p.proposal_id === bp));

  // ── 2. promote → pending, owner-visible ─────────────────────────────────
  const promoted = await review_tool.execute({ proposal_id: bp, verdict: 'promote', reasons_md: 'Justified — foo has fabricated after 404 three times. Worth Jasper approving.' }, ctx);
  check('promote routes to owner', promoted.routed_to === 'owner' && promoted.new_status === 'pending');
  check('promoted proposal now pending', proposals.get(bp)?.status === 'pending');
  const owner_pending2 = proposals.list({ status: 'pending', visible_to: { user_id: 'jasper', tier: 'owner' } });
  check('promoted proposal now in owner queue', owner_pending2.some((p) => p.id === bp));

  // ── 3. send_back → denied + flag to trainer, no denial_count bump ────────
  const pt = proposals.create({
    specialist_id: 'trainer',
    kind: 'persona_tuning',
    execution_kind: 'manual',
    payload: { target_specialist_id: 'maggie', proposed_change: '...' },
    rationale: 'Tweak Maggie tone.',
    signature: sig('persona_tuning'),
  });
  check('trainer persona_tuning → pending_kate_review', proposals.get(pt)?.status === 'pending_kate_review');
  const sig_hash = hash_signature(sig('persona_tuning'));
  const denial_before = (db.prepare('SELECT denial_count FROM category_signatures WHERE hash=?').get(sig_hash) as { denial_count: number } | undefined)?.denial_count ?? 0;

  const sent = await review_tool.execute({ proposal_id: pt, verdict: 'send_back', reasons_md: 'Not worth Jasper\'s time — no user feedback behind it. Drop or bring evidence.' }, ctx);
  check('send_back routes to trainer', sent.routed_to === 'trainer' && sent.new_status === 'denied');
  check('sent-back proposal is denied', proposals.get(pt)?.status === 'denied');
  const flag = db.prepare("SELECT count(*) n FROM specialist_inboxes WHERE to_specialist_id='trainer' AND related_proposal_id=?").get(pt) as { n: number };
  check('a flag was pushed to trainer', flag.n === 1);
  const denial_after = (db.prepare('SELECT denial_count FROM category_signatures WHERE hash=?').get(sig_hash) as { denial_count: number } | undefined)?.denial_count ?? 0;
  check('send_back does NOT bump autonomy denial_count', denial_after === denial_before);

  // ── 4. skip_kate_review (merge-card) lands pending directly ──────────────
  const merge = proposals.create({
    specialist_id: 'trainer',
    kind: 'recommendation',
    execution_kind: 'dispatch',
    skip_kate_review: true,
    payload: { dispatch_tool: 'merge_approved_change', change_id: 'c1' },
    rationale: 'Kate approved the code; merge it.',
    signature: { specialist_id: 'trainer', kind: 'beatrice_merge', category: 'self_improvement', anchor: 'c1' },
  });
  check('skip_kate_review → pending (no gate)', proposals.get(merge)?.status === 'pending');

  // ── 5. a non-trainer recommendation is never gated ──────────────────────
  const kate_rec = proposals.create({
    specialist_id: 'kate',
    kind: 'recommendation',
    execution_kind: 'manual',
    payload: { summary: 'Hire packet' },
    rationale: 'A roster gap.',
    signature: { specialist_id: 'kate', kind: 'recommendation', category: 'staffing' },
  });
  check('non-trainer recommendation → pending (ungated)', proposals.get(kate_rec)?.status === 'pending');

  // ── 6. re-review of a decided row is a guarded no-op ─────────────────────
  const again = await review_tool.execute({ proposal_id: bp, verdict: 'promote', reasons_md: 'Trying to re-review an already-promoted proposal.' }, ctx);
  check('re-review of a non-pending-review row is a no-op', again.routed_to === 'none');

  console.log(failures === 0 ? '\nsmoke:kate-proposal-gate OK' : `\nsmoke:kate-proposal-gate FAILED (${failures})`);
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
