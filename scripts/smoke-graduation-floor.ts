/**
 * smoke:graduation-floor — the graduation rung's floor (2026-07-21).
 *
 * The court's graduation rung promotes a signature family toward the tiers
 * where trust teeth auto-execute. Its only floor was `is_floor_name(category)`
 * — but a category is an EFFECT FAMILY label, not a registry tool name, so it
 * resolves to null risk and MUST fail open (flooring every unknown would
 * nullify graduation). That left the real question unasked: what would this
 * family actually EXECUTE once it auto-executes?
 *
 * The rung now also floors on the family's real `dispatch_tool` names, which
 * ARE registry names — so there the fail direction is CLOSED, matching
 * `is_owner_only`. An unregistered actuation tool (update_pet_medication,
 * write_home_assistant, set_irrigation_schedule) keeps its family owner-only
 * instead of riding a benign-looking category into teeth.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { ProposalsStore } from '../src/core/proposals';
import { is_floor_name } from '../src/core/proposal_court';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}

const dir = mkdtempSync(join(tmpdir(), 'grad-floor-'));
try {
  const db = open_db(join(dir, 'h.db'));
  const proposals = new ProposalsStore(db);
  const sig = (category: string, anchor: string) =>
    ({ specialist_id: 'kate', kind: 'action_proposal', category, anchor }) as const;

  const mk = (category: string, anchor: string, payload: Record<string, unknown>) => {
    const id = proposals.create({
      specialist_id: 'kate',
      kind: 'action_proposal',
      execution_kind: 'none',
      payload,
      rationale: `fixture for ${category}/${anchor}`,
      signature: sig(category, anchor),
    });
    return proposals.get(id)!.category_signature_hash!;
  };

  console.log('→ dispatch_tools_for_signature surfaces what a family would execute');
  {
    const h_none = mk('good_followup', 'a1', { followup_kind: 'return_window', verb: 'review' });
    check('a family with no dispatch tool → [] (nothing to execute)', proposals.dispatch_tools_for_signature(h_none).length === 0);

    const h_str = mk('pets', 'b1', { dispatch_tool: 'update_pet_medication' });
    check('string dispatch_tool shape is read', proposals.dispatch_tools_for_signature(h_str).includes('update_pet_medication'));

    const h_obj = mk('home', 'c1', { dispatch_tool: { name: 'write_home_assistant' } });
    check('object dispatch_tool shape is read', proposals.dispatch_tools_for_signature(h_obj).includes('write_home_assistant'));

    check('an unknown signature hash → []', proposals.dispatch_tools_for_signature('nope').length === 0);
  }

  console.log('→ the floor decision: category fails OPEN, dispatch tools fail CLOSED');
  {
    // A benign-looking category resolves to null risk and is NOT floored —
    // this is the fail-open the rung deliberately relies on.
    check("category 'pets' is NOT floored by the category test", !is_floor_name('pets', () => null, { unknown_is_floor: false }));
    check("category 'home' is NOT floored by the category test", !is_floor_name('home', () => null, { unknown_is_floor: false }));

    // …but its actual dispatch tool IS floored, because unknown fails closed.
    for (const t of ['update_pet_medication', 'write_home_assistant', 'set_irrigation_schedule', 'cassandra_check_camera']) {
      check(`unregistered actuation tool '${t}' floors its family`, is_floor_name(t, () => null, { unknown_is_floor: true }));
    }

    // A registered read-only tool does NOT floor the family.
    check('a registered read-risk tool does not floor', !is_floor_name('read_weather', () => 'read', { unknown_is_floor: true }));

    // The pre-existing regex + declared-risk cases still floor (no regression).
    check('send_-shaped name still floors', is_floor_name('send_message', () => null, { unknown_is_floor: false }));
    check("declared 'spend_money' risk still floors", is_floor_name('buy_thing', () => 'spend_money', { unknown_is_floor: false }));
  }

  console.log('→ end to end: which families the rung would refuse');
  {
    const h_med = mk('pets', 'd1', { dispatch_tool: 'update_pet_medication' });
    const refused = proposals
      .dispatch_tools_for_signature(h_med)
      .some((t) => is_floor_name(t, () => null, { unknown_is_floor: true }));
    check('a medication family is REFUSED graduation', refused);

    const h_safe = mk('good_followup', 'e1', { followup_kind: 'return_window', verb: 'review' });
    const allowed = !proposals
      .dispatch_tools_for_signature(h_safe)
      .some((t) => is_floor_name(t, () => null, { unknown_is_floor: true }));
    check('an execute-nothing followup family is still ALLOWED', allowed);
  }

  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  passed=${passed}  failed=${failed}`);
if (failed > 0) { console.error('\n✗ GRADUATION-FLOOR SMOKE FAILED'); process.exit(1); }
console.log('\n✓ GRADUATION-FLOOR SMOKE OK');
