/**
 * smoke:house-voice — the per-user warm/economical communication-style block.
 *
 * Self-contained: temp db, no network, no LLM. Exercises:
 *   - render_house_voice_section: the base register, the per-user style layer,
 *     the interests line, name handling, interests filtering + cap.
 *   - house_voice_enabled(): DARK by default; =1 on, =0 off.
 *   - UserProfileStore.set_style_profile: merges into detail, PRESERVES facets +
 *     other detail (so the house-voice read path picks it up next turn) and
 *     creates the row if absent.
 *   - cordon-by-construction: the section reflects ONLY its input.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { UserProfileStore } from '../src/memory/stores/user_profile';
import { render_house_voice_section, house_voice_enabled } from '../src/core/house_voice';

let pass = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  pass++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-hv-'));
const prev_flag = process.env.HEARTH_HOUSE_VOICE;

try {
  // ── 1. Base register (no per-user data) ──────────────────────────────────
  {
    const s = render_house_voice_section({});
    assert(s.includes('How you talk'), 'base: heading present');
    assert(s.includes('not a help desk'), 'base: member-not-helpdesk');
    assert(s.includes('earned, not performed'), 'base: earned-warmth guardrail');
    assert(/brevity is respect/i.test(s), 'base: brevity rule');
    assert(s.includes('not a document'), 'base: no-lists-in-chat rule');
    assert(s.includes('This is family') && s.includes('roast'), 'base: playful/edgy sanction');
    assert(s.includes('no numbered list') && /sourdough/i.test(s), 'base: prose-not-list few-shot exemplars');
    assert(!s.includes('likes to be talked to'), 'base: no per-user header without data');
  }

  // ── 2. Per-user style layer ──────────────────────────────────────────────
  {
    const s = render_house_voice_section({
      display_name: 'Jasper',
      style_profile: 'Dry wit; hates filler; wants the bottom line first.',
    });
    assert(s.includes('How you talk'), 'style: base still present');
    assert(s.includes('How **Jasper** likes to be talked to'), 'style: per-user header w/ name');
    assert(s.includes('bottom line first'), 'style: profile text injected');
    assert(s.includes('NOT a') && s.includes('recite back'), 'style: register-only guardrail wording');
  }

  // ── 3. Register-only — no facts/interests shoehorn (the A/B fix) ──────────
  {
    const s = render_house_voice_section({ display_name: 'Sam', style_profile: 'Warm, brief, no jargon.' });
    assert(s.includes('How **Sam** likes to be talked to'), 'register: per-user header');
    assert(!s.includes('cares about') && !/interests/i.test(s), 'register: no interests line at all');
    assert(s.includes('Warm, brief, no jargon.'), 'register: style profile present');
  }

  // ── 3b. Domain context facets (per-user model wiring) ────────────────────
  {
    const s = render_house_voice_section({
      display_name: 'Jasper',
      style_profile: 'Blunt, dry.',
      context_facets: [
        { key: 'interests', summary: 'Deep in home-automation projects.' },
        { key: 'routines', summary: 'Rides the EV most mornings.' },
      ],
    });
    assert(s.includes("What you've learned about Jasper"), 'context: header present');
    assert(s.includes('home-automation') && s.includes('Rides the EV'), 'context: facet summaries injected');
    assert(/never recite it back/i.test(s), 'context: don\'t-recite discipline');
    assert(!/^[-*] Deep in/m.test(s), 'context: not a bulleted list');
  }
  {
    const s = render_house_voice_section({ display_name: 'X', style_profile: 'Terse.' });
    assert(!/what you've learned about/i.test(s), 'context: absent when no facets (backward compatible)');
  }

  // ── 4. Env gate — DARK by default ────────────────────────────────────────
  {
    delete process.env.HEARTH_HOUSE_VOICE;
    assert(house_voice_enabled() === false, 'gate: dark by default');
    process.env.HEARTH_HOUSE_VOICE = '1';
    assert(house_voice_enabled() === true, 'gate: =1 enables');
    process.env.HEARTH_HOUSE_VOICE = '0';
    assert(house_voice_enabled() === false, 'gate: =0 disables');
  }

  // ── 5. set_style_profile — merge, preserve facets + other detail ─────────
  {
    const db = open_db(join(dir, 'hearth.db'));
    const store = new UserProfileStore(db);
    store.set_facets('jasper', ['ev', 'pets'], { interests: ['cycling'], partner_name: 'Sam' });
    store.set_style_profile('jasper', 'Bottom line first, dry humor welcome.');
    const p = store.get('jasper');
    assert(p !== null, 'store: row exists');
    assert(p!.facets.includes('ev') && p!.facets.includes('pets'), 'store: facets PRESERVED');
    assert(p!.detail['style_profile'] === 'Bottom line first, dry humor welcome.', 'store: style_profile set');
    assert((p!.detail['interests'] as string[])[0] === 'cycling', 'store: other detail PRESERVED (interests)');
    assert(p!.detail['partner_name'] === 'Sam', 'store: other detail PRESERVED (partner)');

    store.set_style_profile('jasper', 'Updated style.');
    const p2 = store.get('jasper');
    assert(p2!.detail['style_profile'] === 'Updated style.', 'store: style updated');
    assert(p2!.facets.includes('ev'), 'store: facets still preserved after 2nd set');
    assert((p2!.detail['interests'] as string[])[0] === 'cycling', 'store: interests still preserved');

    store.set_style_profile('newbie', 'Fresh.');
    const np = store.get('newbie');
    assert(np !== null && np!.detail['style_profile'] === 'Fresh.', 'store: creates row if absent');
    db.close();
  }

  console.log(`\n✅ smoke:house-voice — ${pass} checks passed`);
} catch (e) {
  console.error(`\n❌ smoke:house-voice FAILED after ${pass} checks`);
  console.error(e);
  process.exitCode = 1;
} finally {
  if (prev_flag === undefined) delete process.env.HEARTH_HOUSE_VOICE;
  else process.env.HEARTH_HOUSE_VOICE = prev_flag;
  rmSync(dir, { recursive: true, force: true });
}
