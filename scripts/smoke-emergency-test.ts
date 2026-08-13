/**
 * Smoke for Kate's test_emergency_alert drill tool (no device, no APNs).
 *
 * Injects a spy delivery (speak + push) so the tool's logic is exercised
 * without the live Satellite1 / APNs:
 *   - fires BOTH channels on one call (the model only calls one tool);
 *   - default tone is 'critical' (the EAS alarm), 'notice' respected;
 *   - pushes every REAL household member (owner + household), never friend
 *     or a synthetic/test account — same rule as a real alert;
 *   - reports spoke-vs-away honestly;
 *   - owner/household tier-gate refuses a friend.
 */
import {
  make_test_emergency_alert,
  type EmergencyTestDelivery,
} from '../src/specialists/kate/tools/test_emergency_alert';
import type { ToolContext } from '../src/core/tool';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}

const fakeUsers = {
  list: () => [
    { id: 'jasper', tier: 'owner', email: 'jasper@gmail.com' },
    { id: 'sam', tier: 'household', email: 'sam@gmail.com' },
    { id: 'kim', tier: 'friend', email: 'kim@gmail.com' },
    { id: 'testuser_validate', tier: 'household', email: 'testuser@hearth.local' },
  ],
} as never;

function ctx(tier: 'owner' | 'household' | 'friend' = 'owner'): ToolContext {
  return {
    now: new Date(),
    intent_id: 'smoke-emergency-test',
    user: { id: 'jasper', tier },
    memory: { log_action: () => 'audit' },
  } as unknown as ToolContext;
}

interface Harness {
  tool: ReturnType<typeof make_test_emergency_alert>;
  speaks: Array<{ text: string; summary: string; tone: string }>;
  pushes: Array<{ user_id: string; text: string }>;
  set_speak(result: { spoken: boolean; reason: string }): void;
}

function make(): Harness {
  const speaks: Array<{ text: string; summary: string; tone: string }> = [];
  const pushes: Array<{ user_id: string; text: string }> = [];
  let speak_result = { spoken: true, reason: 'present' };
  const delivery: EmergencyTestDelivery = {
    speak: async (text, summary, tone) => { speaks.push({ text, summary, tone }); return speak_result; },
    push: async (user_id, text) => { pushes.push({ user_id, text }); return true; },
  };
  return {
    tool: make_test_emergency_alert(fakeUsers, delivery),
    speaks, pushes,
    set_speak: (r) => { speak_result = r; },
  };
}

async function main(): Promise<void> {
  // ── default: both channels, critical tone, real household only ───────────
  console.log('→ default test fires BOTH channels (critical tone) to the household');
  {
    const h = make();
    const out = await h.tool.execute({}, ctx());
    check('ok', out.ok === true);
    check('default tone is critical (the EAS alarm)', out.tone === 'critical');
    check('spoke on the Satellite1', out.spoke === true && h.speaks.length === 1);
    check('speak used the critical tone', h.speaks[0]?.tone === 'critical', h.speaks[0]?.tone);
    check('spoken text is a labeled TEST', /this is only a test/i.test(h.speaks[0]?.text ?? ''));
    check('pushed to real household (jasper + sam)', h.pushes.map((p) => p.user_id).sort().join(',') === 'jasper,sam',
      h.pushes.map((p) => p.user_id).join(','));
    check('friend (kim) NOT pushed', !h.pushes.some((p) => p.user_id === 'kim'));
    check('synthetic test account NOT pushed', !h.pushes.some((p) => p.user_id === 'testuser_validate'));
    check('push text is a labeled TEST', /TEST/.test(h.pushes[0]?.text ?? ''));
    check('pushed_to reports both', (out.pushed_to ?? []).slice().sort().join(',') === 'jasper,sam');
    check('next_action says both channels', /both channels/i.test(out.next_action));
  }

  // ── tone override ────────────────────────────────────────────────────────
  console.log('\n→ notice tone respected');
  {
    const h = make();
    const out = await h.tool.execute({ tone: 'notice' }, ctx());
    check('tone is notice', out.tone === 'notice' && h.speaks[0]?.tone === 'notice');
  }

  // ── away: spoke=false → push-only, honest report ─────────────────────────
  console.log('\n→ away from the device → push-only, reported honestly');
  {
    const h = make();
    h.set_speak({ spoken: false, reason: 'away' });
    const out = await h.tool.execute({}, ctx());
    check('did not speak', out.spoke === false);
    check('still pushed the household', (out.pushed_to ?? []).length === 2);
    check('next_action explains push-only', /push/i.test(out.next_action) && /near the device/i.test(out.next_action));
  }

  // ── tier gate ──────────────────────────────────────────────────────────────
  console.log('\n→ owner/household tier gate refuses a friend');
  {
    const h = make();
    let threw = '';
    try { await h.tool.execute({}, ctx('friend')); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    check('friend caller throws TIER_FORBIDDEN', threw.includes('TIER_FORBIDDEN'), threw);
    check('nothing delivered on refusal', h.speaks.length === 0 && h.pushes.length === 0);
    const out = await h.tool.execute({}, ctx('household'));
    check('household caller allowed', out.ok === true);
  }

  console.log(`\n  passed=${passed}  failed=${failed}`);
  if (failed > 0) { console.error('\n✗ EMERGENCY-TEST SMOKE FAILED'); process.exit(1); }
  console.log('\n✓ EMERGENCY-TEST SMOKE OK');
}

main().catch((err: unknown) => {
  console.error('\n✗ EMERGENCY-TEST SMOKE CRASHED:', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
