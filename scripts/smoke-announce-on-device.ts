/**
 * Smoke for Kate's announce_on_device tool (no live Satellite1 / coordinator).
 *
 * Injects a spy delivery so the tool's logic is exercised without the device:
 *   - speaks the caller's ARBITRARY text on the speaker (the Kyle case);
 *   - strips markdown before it reaches the TTS voice;
 *   - `chime` flows through (gentle attention tone); default is no tone, and it
 *     can never fire the critical EAS alarm (structurally — it only ever passes
 *     a boolean chime, never 'critical');
 *   - speaker-ONLY: when no one's near, it reports honestly and does NOT push;
 *   - empty-after-strip is refused honestly (never speaks garbage);
 *   - owner/household tier-gate refuses a friend.
 */
import {
  make_announce_on_device,
  type AnnounceDelivery,
} from '../src/specialists/kate/tools/announce_on_device';
import type { ToolContext } from '../src/core/tool';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}

function ctx(tier: 'owner' | 'household' | 'friend' = 'owner'): ToolContext {
  return {
    now: new Date(),
    intent_id: 'smoke-announce',
    conversation_id: 'smoke-conv',
    specialist_id: 'kate',
    user: { id: 'jasper', tier },
    memory: { log_action: () => 'audit' },
  } as unknown as ToolContext;
}

interface Harness {
  tool: ReturnType<typeof make_announce_on_device>;
  speaks: Array<{ text: string; summary: string; chime: boolean }>;
  set_speak(result: { spoken: boolean; reason: string }): void;
}

function make(): Harness {
  const speaks: Array<{ text: string; summary: string; chime: boolean }> = [];
  let speak_result = { spoken: true, reason: 'present' };
  const delivery: AnnounceDelivery = {
    speak: async (text, summary, chime) => { speaks.push({ text, summary, chime }); return speak_result; },
  };
  return {
    tool: make_announce_on_device(delivery),
    speaks,
    set_speak: (r) => { speak_result = r; },
  };
}

async function main(): Promise<void> {
  // ── the Kyle case: arbitrary text spoken aloud ───────────────────────────
  console.log('→ speaks arbitrary text aloud on the Satellite1 (the Kyle case)');
  {
    const h = make();
    const out = await h.tool.execute({ text: 'Hi Kyle!' }, ctx());
    check('ok', out.ok === true);
    check('spoken', out.spoken === true);
    check('delivered exactly the text', h.speaks.length === 1 && h.speaks[0]?.text === 'Hi Kyle!', h.speaks[0]?.text);
    check('no chime by default', h.speaks[0]?.chime === false);
    check('next_action confirms the speaker', /speaker|Satellite1/i.test(out.next_action));
  }

  // ── markdown is stripped before it hits the voice ────────────────────────
  console.log('\n→ strips markdown before speaking');
  {
    const h = make();
    await h.tool.execute({ text: '**Dinner** is *ready*!' }, ctx());
    check('bold/italic markers removed', h.speaks[0]?.text === 'Dinner is ready!', h.speaks[0]?.text);
  }

  // ── chime flows through (never the critical alarm) ───────────────────────
  console.log('\n→ chime flag flows through as a gentle tone');
  {
    const h = make();
    await h.tool.execute({ text: 'Heads up, everyone.', chime: true }, ctx());
    check('chime=true reached delivery', h.speaks[0]?.chime === true);
  }

  // ── away: speaker-only, honest, NO push ──────────────────────────────────
  console.log('\n→ no one near the device → honest report, speaker-only (no push)');
  {
    const h = make();
    h.set_speak({ spoken: false, reason: 'away' });
    const out = await h.tool.execute({ text: 'Hi Kyle!' }, ctx());
    check('did not speak', out.spoken === false);
    check('ok=false when it did not play', out.ok === false);
    check('next_action is honest + offers message_user', /no one|didn.?t play|message_user/i.test(out.next_action), out.next_action);
  }

  // ── empty-after-strip is refused honestly (no garbage spoken) ────────────
  console.log('\n→ empty-after-strip is refused, nothing spoken');
  {
    const h = make();
    const out = await h.tool.execute({ text: '```just code```' }, ctx());
    check('refused with empty_after_strip', out.spoken === false && out.reason === 'empty_after_strip', out.reason);
    check('delivery never called', h.speaks.length === 0);
  }

  // ── tier gate ────────────────────────────────────────────────────────────
  console.log('\n→ owner/household tier gate refuses a friend');
  {
    const h = make();
    let threw = '';
    try { await h.tool.execute({ text: 'Hi Kyle!' }, ctx('friend')); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    check('friend caller throws TIER_FORBIDDEN', threw.includes('TIER_FORBIDDEN'), threw);
    check('nothing spoken on refusal', h.speaks.length === 0);
    const out = await h.tool.execute({ text: 'Hi Kyle!' }, ctx('household'));
    check('household caller allowed', out.ok === true);
  }

  console.log(`\n  passed=${passed}  failed=${failed}`);
  if (failed > 0) { console.error('\n✗ ANNOUNCE-ON-DEVICE SMOKE FAILED'); process.exit(1); }
  console.log('\n✓ ANNOUNCE-ON-DEVICE SMOKE OK');
}

main().catch((err: unknown) => {
  console.error('\n✗ ANNOUNCE-ON-DEVICE SMOKE CRASHED:', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
