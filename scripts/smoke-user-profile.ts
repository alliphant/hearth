/**
 * smoke:user-profile — per-user profile/facets + onboarding (2026-06-15).
 *
 * Self-contained: temp db + temp vault, no network, no LLM. Exercises:
 *   - the facet POLICY (default_facets_for, effective_facets) — owner seeds
 *     EV from the household, a household member does NOT (the "no EV for Sam"
 *     default), universals always on, stored facets win.
 *   - resolve_household_for_user — per-speaker token resolution + the
 *     substitute(defer) / strip_deferred_tokens persona de-leak primitives.
 *   - pull_brief_context — owner brief carries the ev block, a household
 *     member without the ev facet has NO ev block at all.
 *   - update_user_profile — user_id resolved from ctx.user (never an arg),
 *     facets set, profile note written + stamped private_to the user, a
 *     per-specialist seed, onboarding completion; the owner cannot see a
 *     household member's profile note (cordon holds).
 *   - the onboarding gate (is_onboarded) + the injected playbook section.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import matter from 'gray-matter';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import {
  UserProfileStore,
  default_facets_for,
  effective_facets,
  resolve_household_for_user,
  UNIVERSAL_FACETS,
} from '../src/memory/stores/user_profile';
import {
  build_context,
  set_household_context,
  substitute,
  strip_deferred_tokens,
  DEFERRED_PERSONA_TOKENS,
  HouseholdSchema,
} from '../src/core/household';
import { pull_brief_context, life_context_grounding_corpus } from '../src/core/domain_packs/life_context';
import { note_visible_to_caller } from '../src/memory/private_to';
import { make_update_user_profile } from '../src/specialists/kate/tools/update_user_profile';
import { render_onboarding_section } from '../src/core/specialist_runtime';
import { scope_member_brief_inbox } from '../src/core/deliberation';
import type { ToolContext } from '../src/core/tool';

let pass = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  pass++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-up-'));
const vault_root = join(dir, 'vault');

// A household with a vehicle + pets + garden zone — so owner defaults seed
// ev/pets/garden, and the de-leak has something to blank for a non-owner.
const household = HouseholdSchema.parse({
  brand: 'FRIDAY',
  primary_city: 'Pleasantville',
  usda_growing_zone: '5b',
  partner_name: 'Sam',
  pets: [{ name: 'Bailey', species: 'dog' }],
  vehicles: [{ make: 'Hyundai', model: 'Ioniq 5' }],
});
const ctx0 = build_context(household, 'Jasper');
set_household_context(ctx0);

try {
  // ── 1. Facet policy ─────────────────────────────────────────────────────
  {
    const owner_def = default_facets_for('owner', ctx0);
    assert(owner_def.has('ev'), 'owner default facets include ev (household has a vehicle)');
    assert(owner_def.has('pets'), 'owner default facets include pets');
    assert(owner_def.has('garden'), 'owner default facets include garden (growing zone set)');

    const hh_def = default_facets_for('household', ctx0);
    assert(!hh_def.has('ev'), 'household-member default facets EXCLUDE ev (not their vehicle) — the no-EV-for-Sam default');
    assert(hh_def.has('pets'), 'household member shares pets');
    assert(!hh_def.has('finance'), 'household member does not get personal opt-in facets by default');

    const friend_def = default_facets_for('friend', ctx0);
    for (const u of UNIVERSAL_FACETS) assert(friend_def.has(u), `friend has universal ${u}`);
    assert(!friend_def.has('pets') && !friend_def.has('ev'), 'friend gets universals only');

    // Stored facets win; universals always unioned in.
    const eff = effective_facets(
      { user_id: 'sam', facets: ['ev', 'music'], detail: {}, onboarded_at: null, updated_at: '' },
      'household',
      ctx0,
    );
    assert(eff.has('ev') && eff.has('music'), 'explicitly-set facets win (Sam got an EV after onboarding)');
    assert(eff.has('weather') && eff.has('calendar'), 'universals are always present even with a stored set');
    assert(!eff.has('pets'), 'a set facet list is authoritative — unlisted facets are off');
    console.log('  ✓ facet policy: owner seeds EV, household member does not, stored wins, universals always on');
  }

  // ── 2. Per-user household resolution (persona de-leak primitives) ────────
  {
    // Owner → global household unchanged.
    const owner_h = resolve_household_for_user({ base: ctx0, tier: 'owner', stored: null, display_name: 'Jasper' });
    assert(owner_h.primary_vehicle === 'Hyundai Ioniq 5', 'owner keeps the household vehicle');
    assert(owner_h.pet_names === 'Bailey', 'owner keeps the household pets');

    // Household member with no ev facet → vehicle blanked; pets kept (shared).
    const sara_h = resolve_household_for_user({ base: ctx0, tier: 'household', stored: null, display_name: 'Sam' });
    assert(sara_h.primary_vehicle === undefined, 'Sam (no ev facet) has NO primary_vehicle — no Ioniq leak');
    assert(sara_h.pet_names === 'Bailey', 'Sam shares the household pets (pets facet on by default)');
    assert(sara_h.partner_name === undefined, "Sam's partner_name is not the owner-centric global value");
    assert(sara_h.user_name === 'Sam', 'display_name overrides user_name per speaker');

    // The substitute(defer) + strip primitives: a persona snippet resolves
    // per-speaker, Iris's {{primary_vehicle:EV}} falling to its default for Sam.
    const snippet = 'Remind {{user_name}} about the {{primary_vehicle:EV}} and {{pet_names:the animals}}.';
    const deferred = substitute(snippet, ctx0, DEFERRED_PERSONA_TOKENS);
    assert(deferred.includes('{{primary_vehicle:EV}}'), 'defer set leaves the per-user token literal in the template');

    const owner_render = strip_deferred_tokens(substitute(deferred, owner_h));
    assert(owner_render.includes('Hyundai Ioniq 5'), 'owner render resolves the real vehicle');

    const sara_render = strip_deferred_tokens(substitute(deferred, sara_h));
    assert(!/Ioniq/.test(sara_render), 'Sam render NEVER mentions the Ioniq');
    assert(sara_render.includes('the EV'), "Sam render falls to the persona's own generic default");
    assert(sara_render.includes('Sam'), 'Sam render addresses Sam');
    console.log('  ✓ persona de-leak: owner keeps the Ioniq, Sam gets the generic default — no leak');
  }

  // ── 3. pull_brief_context EV gating ─────────────────────────────────────
  {
    for (const v of ['IONIQ5_SOC_ENTITY', 'IONIQ5_RANGE_ENTITY', 'HEARTH_BRIEF_INDOOR_TEMP_ENTITY']) {
      delete process.env[v];
    }
    const db = open_db(join(dir, 'brief.db'));
    const memory = new MemoryClient({ vault_root, db });

    const owner_ctx = await pull_brief_context({ memory, user_id: 'jasper', users: undefined, is_owner: true });
    assert(owner_ctx.ev !== undefined, 'owner brief carries the ev block');

    const sara_ctx = await pull_brief_context({ memory, user_id: 'sam', users: undefined, is_owner: false });
    assert(sara_ctx.ev === undefined, 'household-member brief has NO ev block (the "no mention of EV" fix)');
    assert(
      !/ev\.soc_percent|ev\.range_miles/.test(life_context_grounding_corpus(sara_ctx)),
      'Sam grounding corpus surfaces no EV readings',
    );

    // After Sam is given the ev facet (dynamic), her brief gains the block.
    memory.user_profiles.set_facets('sam', ['ev']);
    const sara_ev_ctx = await pull_brief_context({ memory, user_id: 'sam', users: undefined, is_owner: false });
    assert(sara_ev_ctx.ev !== undefined, 'once Sam has the ev facet, her brief gains the ev block (dynamic ever after)');
    db.close();
    console.log('  ✓ brief faceting: owner has EV, Sam does not — until she gains the facet');
  }

  // ── 4. update_user_profile tool — cordon, facets, note, seed, complete ──
  {
    const db = open_db(join(dir, 'tool.db'));
    const memory = new MemoryClient({ vault_root, db });
    const tool = make_update_user_profile(vault_root);
    const mk_ctx = (user?: { id: string; tier: 'owner' | 'household' | 'friend' }): ToolContext =>
      ({
        memory,
        llm: {} as never,
        now: new Date(),
        intent_id: 'test_intent',
        specialist_id: 'kate',
        ...(user ? { user } : {}),
      }) as ToolContext;

    // No user in context → rejects (user-scoped; never writes a personal note system-side).
    let threw = false;
    try {
      await tool.execute({ complete: true }, mk_ctx());
    } catch {
      threw = true;
    }
    assert(threw, 'update_user_profile rejects when there is no user in context');

    // Sam onboards: set facets + narrative + a fact + seed Brigid + complete.
    const out = await tool.execute(
      {
        facets: ['pets', 'finance'],
        detail: { interests: ['hiking'] },
        profile_md: 'Sam is a teacher who bikes to work and loves Thai food.',
        note: 'Allergic to shellfish.',
        seed_specialist_id: 'brigid',
        seed_body: 'Sam avoids shellfish; favors vegetable-forward dinners.',
        complete: true,
      },
      mk_ctx({ id: 'sam', tier: 'household' }),
    );
    assert(out.user_id === 'sam', 'tool resolved the target from ctx.user, not an arg');
    assert(out.onboarded === true, 'complete:true marked Sam onboarded');
    assert(out.facets.includes('pets') && out.facets.includes('finance'), 'facets were set');
    assert(memory.user_profiles.is_onboarded('sam'), 'store reflects onboarding');

    // Profile note written + stamped private_to sam.
    const profile_abs = resolve(vault_root, 'users/sam/profile.md');
    assert(existsSync(profile_abs), 'profile note written at users/sam/profile.md');
    const fm = matter(readFileSync(profile_abs, 'utf8'));
    assert(fm.data.private_to === 'sam', `profile note stamped private_to sam (got ${fm.data.private_to})`);
    assert(fm.data.type === 'user_profile', 'profile note carries the user_profile type');
    assert(/bikes to work/.test(fm.content) && /shellfish/i.test(fm.content), 'narrative + appended fact both present');

    // Per-specialist seed written + stamped.
    const seed_abs = resolve(vault_root, 'users/sam/brigid/profile.md');
    assert(existsSync(seed_abs), 'per-specialist seed written at users/sam/brigid/profile.md');
    assert(matter(readFileSync(seed_abs, 'utf8')).data.private_to === 'sam', 'seed stamped private_to sam');

    // ── 5. Cordon: the owner cannot see Sam's profile note via the cordon ──
    assert(
      note_visible_to_caller('sam', { user_id: 'sam', tier: 'household' }),
      'Sam sees her own profile note',
    );
    assert(
      !note_visible_to_caller('sam', { user_id: 'jasper', tier: 'owner' }),
      'the OWNER does NOT see Sam’s profile note (no god-view)',
    );
    db.close();
    console.log('  ✓ update_user_profile: ctx-cordoned, facets+note+seed written, private_to stamped, owner has no god-view');
  }

  // ── 6. Onboarding gate + injected playbook ──────────────────────────────
  {
    const db = open_db(join(dir, 'onb.db'));
    const store = new UserProfileStore(db);
    assert(!store.is_onboarded('newuser'), 'a fresh user is not onboarded → playbook would inject');
    const section = render_onboarding_section('Sam');
    assert(/FIRST-TIME SETUP/.test(section) && /Sam/.test(section), 'onboarding section is the named setup playbook');
    assert(/update_user_profile/.test(section) && /facets/i.test(section), 'playbook points Kate at the tool + facets');
    store.mark_onboarded('newuser');
    assert(store.is_onboarded('newuser'), 'after completion the user is onboarded → playbook stops injecting');

    // ── Reset re-opens onboarding (for users who never went through it, or a redo) ──
    store.set_facets('newuser', ['ev', 'pets']);
    const cleared = store.reset_onboarding('newuser');
    assert(cleared === true, 'reset reports it cleared a prior onboarding stamp');
    assert(!store.is_onboarded('newuser'), 'after reset the user is NOT onboarded → the playbook injects again');
    assert(
      new Set(store.get('newuser')!.facets).has('ev'),
      'reset PRESERVES facets by default — re-run the interview from the current baseline',
    );
    store.mark_onboarded('newuser');
    store.reset_onboarding('newuser', { clear_facets: true });
    assert(store.get('newuser')!.facets.length === 0, 'reset with clear_facets wipes the facet set (full fresh start)');
    assert(store.reset_onboarding('ghost') === false, 'reset on a never-onboarded user is a harmless no-op');
    assert(!store.is_onboarded('ghost'), 'a never-seen user stays not-onboarded');
    db.close();
    console.log('  ✓ onboarding gate flips on completion; reset re-opens it (facets preserved, or cleared on request)');
  }

  // ── 7. Non-owner brief inbox scoping (Sam's brief is HERS, not Jasper's noise) ──
  {
    type Flag = { from_specialist_id: string; originating_user_id: string | null };
    const flags: Flag[] = [
      { from_specialist_id: 'eleanor', originating_user_id: null }, // household garden flag
      { from_specialist_id: 'vivian', originating_user_id: null }, // household market flag
      { from_specialist_id: 'iris', originating_user_id: null }, // household EV flag
      { from_specialist_id: 'trainer', originating_user_id: null }, // Hearth-internal (Beatrice)
      { from_specialist_id: 'mariah', originating_user_id: null }, // Hearth-internal (program scan)
      { from_specialist_id: 'brigid', originating_user_id: 'sam' }, // Sam's OWN
      { from_specialist_id: 'brigid', originating_user_id: 'jasper' }, // someone else's (already cordoned out upstream, belt-and-suspenders)
    ];
    // Sam works with kate/brigid/eleanor/cordelia/anya/vivian/marguerite/astrid (NOT iris/mariah/trainer).
    const sam = { id: 'sam', allowed_specialists: ['kate', 'brigid', 'eleanor', 'vivian', 'astrid'] as string[] };
    const scoped = scope_member_brief_inbox(flags, sam);
    const froms = scoped.map((f) => `${f.from_specialist_id}:${f.originating_user_id ?? 'null'}`);

    assert(froms.includes('eleanor:null'), 'keeps a household flag from a specialist she works with (garden)');
    assert(froms.includes('vivian:null'), 'keeps a household flag from a specialist she works with (market)');
    assert(froms.includes('brigid:sam'), 'always keeps her OWN flag');
    assert(!froms.includes('iris:null'), 'DROPS a household flag from a specialist she does NOT work with (EV/Iris)');
    assert(!froms.some((f) => f.startsWith('trainer')), 'DROPS Hearth-internal (Beatrice/trainer) — owner-ops, not her brief');
    assert(!froms.some((f) => f.startsWith('mariah')), 'DROPS Hearth-internal (Mariah program scans)');
    assert(!froms.includes('brigid:jasper'), "never keeps another user's personal flag");

    // The OWNER brief never calls this — but a member granted '*' still loses
    // the Hearth-internal stream (the one floor that holds regardless).
    const star_member = { id: 'guest', allowed_specialists: '*' as const };
    const star_scoped = scope_member_brief_inbox(flags, star_member).map((f) => f.from_specialist_id);
    assert(star_scoped.includes('eleanor') && !star_scoped.includes('trainer'), "'*' member keeps domain flags but never Hearth-internal");
    console.log('  ✓ non-owner brief inbox: her own + her specialists only; household-ops/Hearth-internal noise dropped');
  }

  console.log(`\n✓ ${pass} checks passed. smoke-user-profile done.`);
} catch (err) {
  console.error(`\n✗ smoke-user-profile failed (${pass} passed):`, err);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
