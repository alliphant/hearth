/**
 * smoke:proposal-critic — the proposal-filing quality critic.
 *
 * Self-contained: temp SQLite + a scripted mock LLM (no live model). Exercises
 * the deterministic candidate grouping (#2), the fail-open LLM judge (#3), the
 * supersede_duplicate store write (canonical survives), and every fail-open /
 * kill-switch path.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { open_db } from '@memory/stores/structured';
import { ProposalsStore, type CategorySignature, type ProposalRow } from '@core/proposals';
import {
  assess_proposal,
  duplicate_candidates,
  proposal_critic_enabled,
} from '@core/proposal_critic';
import type { LLMRouter } from '@core/llm';

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.error(`  ✗ ${label}`);
  }
}

// A scripted mock router: for_role(...) returns a provider whose complete()
// yields whatever the current `responder` produces (a string, or throws).
let responder: () => string = () => '{"verdict":"keep","duplicate_index":null,"reason":"x"}';
const mock_llm: LLMRouter = {
  for_role: () => ({
    provider: {
      complete: async () => ({ content: responder() }),
    },
    defaults: {},
  }),
} as unknown as LLMRouter;

const dir = mkdtempSync(resolve(tmpdir(), 'hearth-propcritic-'));
const db = open_db(resolve(dir, 'hearth.db'));

async function main(): Promise<void> {
  process.env.HEARTH_PROPOSAL_CRITIC = '1'; // enable for the judge tests
  const proposals = new ProposalsStore(db);

  const sig = (category: string): CategorySignature => ({
    specialist_id: 'cassandra',
    kind: 'action_proposal',
    category,
  });

  // Two near-identical Cassandra cards (the real stale-presence cluster shape).
  // Distinct signature category + rationale wording so create()'s equality
  // idempotency does NOT collapse them — that's exactly the gap the critic fills.
  const a_id = proposals.create({
    specialist_id: 'cassandra',
    kind: 'action_proposal',
    execution_kind: 'manual',
    payload: { summary: 'Stale presence false-alarm: house-empty signal triggered camera concerns while Jasper home' },
    rationale: 'Presence sensor reported house empty while Jasper was at the property; thirteen false camera concerns. Same stale presence pattern.',
    signature: sig('security_a'),
    user_id: 'jasper',
  });
  const b_id = proposals.create({
    specialist_id: 'cassandra',
    kind: 'action_proposal',
    execution_kind: 'manual',
    payload: { summary: 'Confirm stale presence pattern: house-empty premise caused false camera concerns, Jasper was home' },
    rationale: 'The presence house empty signal was stale and wrong; it caused false camera concerns while Jasper was at the property. Recurring presence pattern.',
    signature: sig('security_b'),
    user_id: 'jasper',
  });
  // A distinct, unrelated proposal (different specialist + kind, low overlap).
  const c_id = proposals.create({
    specialist_id: 'iris',
    kind: 'recommendation',
    execution_kind: 'manual',
    payload: { summary: 'Ioniq 5 entity_id format changed in Home Assistant' },
    rationale: 'The EV battery sensor entity ids changed format after a Home Assistant update; the dashboard query needs updating.',
    signature: { specialist_id: 'iris', kind: 'recommendation', category: 'ev' },
    user_id: 'jasper',
  });
  check('two near-identical cassandra cards filed as distinct rows', a_id !== b_id);

  const a = proposals.get(a_id) as ProposalRow;
  const b = proposals.get(b_id) as ProposalRow;
  const c = proposals.get(c_id) as ProposalRow;
  const open = [a, b, c];

  // ── #2: deterministic candidate grouping ──────────────────────────────────
  const cands_for_b = duplicate_candidates(b, open);
  check('candidate-gen: the twin (a) is a candidate for b', cands_for_b.some((p) => p.id === a_id));
  check('candidate-gen: the unrelated iris card is NOT a candidate for b', !cands_for_b.some((p) => p.id === c_id));
  check('candidate-gen: never includes self', !cands_for_b.some((p) => p.id === b_id));

  // ── #3: judge → duplicate → supersede (canonical survives) ────────────────
  responder = () => '{"verdict":"duplicate","duplicate_index":1,"reason":"same stale-presence root cause + same close action"}';
  const v_dup = await assess_proposal({ proposal: b, open, llm: mock_llm });
  check('judge: duplicate verdict returned', v_dup.action === 'duplicate');
  check('judge: duplicate_of maps to OUR candidate (a)', v_dup.duplicate_of === cands_for_b[0]?.id);

  const flipped = proposals.supersede_duplicate(b_id, v_dup.duplicate_of!, `proposal-critic: ${v_dup.reason}`);
  check('supersede: the newer duplicate (b) flipped', flipped === true);
  check('supersede: b is now superseded', proposals.get(b_id)?.status === 'superseded');
  check('supersede: b points at the canonical winner', proposals.get(b_id)?.superseded_by === v_dup.duplicate_of);
  check('supersede: the canonical (a) SURVIVES as pending', proposals.get(a_id)?.status === 'pending');
  check('supersede: reason recorded on the loser', (proposals.get(b_id)?.user_feedback ?? '').includes('stale-presence'));
  check('supersede: idempotent — re-run flips nothing', proposals.supersede_duplicate(b_id, a_id, 'again') === false);

  // ── #3: judge → fix_mismatch → flag only, never auto-deny ─────────────────
  responder = () => '{"verdict":"fix_mismatch","duplicate_index":null,"reason":"granting a read capability does not fix an entity-id mismatch"}';
  const v_mis = await assess_proposal({ proposal: c, open, llm: mock_llm });
  check('judge: fix_mismatch verdict returned', v_mis.action === 'fix_mismatch');
  check('judge: fix_mismatch carries no duplicate_of', v_mis.duplicate_of === undefined);

  // ── fail-open matrix ──────────────────────────────────────────────────────
  responder = () => '{"verdict":"keep","duplicate_index":null,"reason":"distinct"}';
  check('judge: keep verdict → action keep', (await assess_proposal({ proposal: a, open, llm: mock_llm })).action === 'keep');

  check('fail-open: no llm → keep, unchecked', (await assess_proposal({ proposal: a, open, llm: undefined })).checked === false);

  responder = () => { throw new Error('judge boom'); };
  const v_throw = await assess_proposal({ proposal: b, open, llm: mock_llm });
  check('fail-open: judge throw → keep', v_throw.action === 'keep');

  responder = () => 'not json at all {{{';
  check('fail-open: unparseable → keep', (await assess_proposal({ proposal: a, open, llm: mock_llm })).action === 'keep');

  // defensive: duplicate verdict with an out-of-range index must NOT supersede
  responder = () => '{"verdict":"duplicate","duplicate_index":99,"reason":"hallucinated index"}';
  const v_badidx = await assess_proposal({ proposal: b, open, llm: mock_llm });
  check('defensive: duplicate with bad index → keep (no false supersede)', v_badidx.action === 'keep');

  // ── kill switch ───────────────────────────────────────────────────────────
  process.env.HEARTH_PROPOSAL_CRITIC = '0';
  check('kill switch: proposal_critic_enabled() false', proposal_critic_enabled() === false);
  responder = () => '{"verdict":"duplicate","duplicate_index":1,"reason":"would supersede if enabled"}';
  const v_off = await assess_proposal({ proposal: b, open, llm: mock_llm });
  check('kill switch: disabled → keep regardless of candidates/judge', v_off.action === 'keep' && v_off.checked === false);
  process.env.HEARTH_PROPOSAL_CRITIC = '1';

  console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} checks passed, ${fail} failed. smoke-proposal-critic done.`);
}

main()
  .catch((err) => {
    console.error(err);
    fail++;
  })
  .finally(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    process.exit(fail === 0 ? 0 : 1);
  });
