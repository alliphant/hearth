/**
 * smoke:trust-xp — the Trust Ladder (RPG XP/levels) safety spine (Phase 1a).
 *
 * Self-contained: temp db, no orchestrator, no LLM. Exercises:
 *   - the pure XP math (risk class × effect multiplier; deny subtracts)
 *   - level derivation from accumulated XP
 *   - accrual through ProposalsStore.decide (accept = +, deny = −, clamp ≥ 0)
 *   - the XP graduation gate COMPOSES with the approval-count gate: enough
 *     approvals but not enough XP → held; XP cleared → graduates
 *   - the kill switch (HEARTH_TRUST_XP off → no XP, graduation byte-identical)
 *
 *   bun run smoke:trust-xp
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { ProposalsStore, type AutonomyConfig } from '@core/proposals';
import {
  risk_class_for,
  xp_for,
  level_for,
  compute_specialist_rank,
  xp_to_reach_level,
  TRUST_XP_DEFAULTS,
} from '@core/trust_xp';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

// A fast-graduating config so the smoke needs few approvals.
const CFG: AutonomyConfig = {
  amount_cap_cents: 1_000_000,
  min_approvals_for_tier2b: 3,
  min_approvals_for_tier2c: 10,
  min_approvals_for_tier3: 20,
  min_authenticity_score_for_tier2b: 0,
  min_authenticity_score_for_tier2c: 0,
  min_authenticity_score_for_tier3: 0,
  require_eval_health_for_graduation: false,
  eval_health_window_days: 14,
  excluded_signatures: [],
  web_action_graduation_enabled: false,
  hard_excluded_categories: [],
  trust_xp: { ...TRUST_XP_DEFAULTS, level_xp_thresholds: { tier2a: 10, tier2b: 30, tier2c: 80 } },
};

let nonce = 0;
function file_and_decide(
  store: ProposalsStore,
  anchor: string,
  payload: Record<string, unknown>,
  verdict: 'approve' | 'deny',
): string {
  // Distinct payload + rationale each call so the re-fire idempotency-collapse
  // (identical payload within the open window → same proposal) doesn't merge
  // what are, in the real world, separate reorder events.
  const n = nonce++;
  const id = store.create({
    specialist_id: 'kate',
    kind: 'action_proposal',
    user_id: 'jasper',
    execution_kind: 'dispatch',
    payload: { ...payload, _n: n },
    rationale: `reorder ${anchor} #${n}`,
    signature: { specialist_id: 'kate', kind: 'action_proposal', category: 'reorder', anchor },
  });
  store.decide(id, verdict);
  return id;
}

function sig_hash(store: ProposalsStore, anchor: string): string {
  // Re-create with the same signature to read back the hash via trust_level_for.
  // create() is idempotent on the signature row (no count change), so this is
  // safe — but we instead read the hash off a freshly filed proposal's row.
  const id = store.create({
    specialist_id: 'kate',
    kind: 'action_proposal',
    user_id: 'jasper',
    execution_kind: 'dispatch',
    payload: {},
    rationale: 'probe',
    signature: { specialist_id: 'kate', kind: 'action_proposal', category: 'reorder', anchor },
  });
  const row = store.get(id)!;
  return row.category_signature_hash!;
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-trustxp-'));
  const db = open_db(join(tmp, 'hearth.db'));

  // ── 1. Pure XP math ──────────────────────────────────────────────────────
  check('risk: money → high', risk_class_for({ amount_cents: 5000 }) === 'high');
  check('risk: step-up → high', risk_class_for({ requires_step_up: true }) === 'high');
  check('risk: dispatch → medium', risk_class_for({ execution_kind: 'dispatch' }) === 'medium');
  check('risk: draft → low', risk_class_for({ execution_kind: 'manual' }) === 'low');
  check('xp: high accept = 8', xp_for({ effect: 'approve', risk: 'high' }) === 8);
  check('xp: medium accept = 3', xp_for({ effect: 'approve', risk: 'medium' }) === 3);
  check('xp: edited accept partial', xp_for({ effect: 'approve_modified', risk: 'high' }) === 8 * 0.4);
  check('xp: deny subtracts', xp_for({ effect: 'deny', risk: 'high' }) === -8);
  check('level: 0 below first threshold', level_for(5) === 0);
  check('level: 1 at threshold', level_for(8) === 1);
  check('level: 3 at top', level_for(80) === 3);

  // ── 2. Accrual through decide() — XP ON ───────────────────────────────────
  process.env.HEARTH_TRUST_XP = '1';
  const store = new ProposalsStore(db, CFG);

  // Three clean medium-risk accepts → 3 × 3 = 9 XP (under tier2a→2b XP gate of 10).
  for (let i = 0; i < 3; i++) {
    file_and_decide(store, 'dogfood', { dispatch_tool: 'reorder' }, 'approve');
  }
  const h = sig_hash(store, 'dogfood');
  let tl = store.trust_level_for(h)!;
  check('accrued XP after 3 medium accepts = 9', tl.xp === 9);
  check('level still 0 (XP < 10)', tl.level === 0);

  // Approvals (3) MEET the count gate, but XP (9) is under the 10 XP gate → HELD.
  const held = store.check_graduation_candidates().find((c) => c.signature_hash === h);
  check('graduation HELD by XP gate despite enough approvals', held === undefined);

  // One more accept → 12 XP, clears the gate.
  file_and_decide(store, 'dogfood', { dispatch_tool: 'reorder' }, 'approve');
  tl = store.trust_level_for(h)!;
  check('XP now 12', tl.xp === 12);
  check('level now 1', tl.level === 1);
  const ready = store.check_graduation_candidates().find((c) => c.signature_hash === h);
  check('graduation now a candidate (approvals + XP both met)', ready !== undefined);

  // ── 3. Deny subtracts + clamps ────────────────────────────────────────────
  const before = store.trust_level_for(h)!.xp;
  file_and_decide(store, 'dogfood', { dispatch_tool: 'reorder' }, 'deny');
  const after = store.trust_level_for(h)!.xp;
  check('deny subtracted XP', after === before - 3);
  // A denial also poisons the existing approval gate (denial_count>0) → no longer a candidate.
  check('denied signature no longer graduates', !store.check_graduation_candidates().some((c) => c.signature_hash === h));

  // Clamp ≥ 0: a fresh signature, one deny → floor at 0.
  file_and_decide(store, 'clamp', { dispatch_tool: 'x' }, 'deny');
  const ch = sig_hash(store, 'clamp');
  check('XP clamped at 0 (never negative)', store.trust_level_for(ch)!.xp === 0);

  // ── 4. Kill switch OFF → no XP, graduation byte-identical to today ────────
  delete process.env.HEARTH_TRUST_XP;
  const db2 = open_db(join(tmp, 'hearth2.db'));
  const store2 = new ProposalsStore(db2, CFG);
  for (let i = 0; i < 3; i++) file_and_decide(store2, 'off', { dispatch_tool: 'x' }, 'approve');
  const h2 = sig_hash(store2, 'off');
  check('XP OFF → no XP accrued', store2.trust_level_for(h2)!.xp === 0);
  check('XP OFF → graduates on approvals alone', store2.check_graduation_candidates().some((c) => c.signature_hash === h2));

  // ── 5. Specialist rank badges ─────────────────────────────────────────────
  // Pure rank math.
  const r0 = compute_specialist_rank(0);
  check('rank: 0 XP → Copper level 1', r0.tier === 'copper' && r0.level === 1);
  check('rank: bar empty-ish at level start', r0.xp_into_level === 0 && r0.xp_to_next > 0);
  check('rank: level 3 is Silver', compute_specialist_rank(xp_to_reach_level(3)).tier === 'silver');
  check('rank: level 6 is Gold', compute_specialist_rank(xp_to_reach_level(6)).tier === 'gold');
  check('rank: level 10 is Platinum', compute_specialist_rank(xp_to_reach_level(10)).tier === 'platinum');
  check('rank: level 15 is Diamond', compute_specialist_rank(xp_to_reach_level(15)).tier === 'diamond');
  const mid = compute_specialist_rank(xp_to_reach_level(4) + 5);
  check('rank: mid-level bar fraction in (0,1)', mid.pct > 0 && mid.pct < 1 && mid.next_tier !== null);

  // Accrual into the per-specialist total via decide() (XP ON).
  process.env.HEARTH_TRUST_XP = '1';
  const db3 = open_db(join(tmp, 'hearth3.db'));
  const store3 = new ProposalsStore(db3, CFG);
  const base0 = store3.specialist_rank('kate');
  check('rank: fresh specialist starts Copper L1 0xp', base0.xp === 0 && base0.tier === 'copper');
  // Several high-risk accepts to climb.
  for (let i = 0; i < 4; i++) {
    const id = store3.create({
      specialist_id: 'kate', kind: 'action_proposal', user_id: 'jasper', execution_kind: 'dispatch',
      payload: { amount_cents: 9000, requires_step_up: true, _n: i },
      rationale: `high-risk action #${i}`,
      signature: { specialist_id: 'kate', kind: 'action_proposal', category: 'spend', anchor: `x${i}` },
    });
    store3.decide(id, 'approve');
  }
  const climbed = store3.specialist_rank('kate');
  check('rank: per-specialist XP accrued from decides', climbed.xp === 32); // 4 × high(8) × approve(1)
  check('rank: climbed past level 1', climbed.level > 1);
  check('rank: a different specialist is independent', store3.specialist_rank('vivian').xp === 0);
  delete process.env.HEARTH_TRUST_XP;
  db3.close();

  db.close();
  db2.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n✅ smoke:trust-xp — ${passed} checks passed`);
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
