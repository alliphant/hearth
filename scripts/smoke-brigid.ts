/**
 * smoke:brigid — end-to-end exercise of Brigid's two main flows.
 *
 *   1. URL flow: import a public recipe URL into Mealie via
 *      mealie_import_recipe_url, then save the slug to the backlog via
 *      update_brigid_vault, then clean up.
 *   2. /plan flow: pick today's date as the week start; gather diets,
 *      pull last-28-days history, classify a handful of ingredients,
 *      publish a 7-day dinner plan via mealie_set_meal_plan with one
 *      real recipe + freeform takeout entries, write the plan summary
 *      to the vault, then clean up.
 *
 * Self-contained — stands up its own temp vault, SQLite, memory client,
 * specialist registry, tool registry, AppEventBus. Does NOT run the
 * specialist LLM turn (that needs the LLM host + the full /relay stack and
 * is exercised by smoke:proactive / smoke:app). The tools themselves
 * are the contract we're testing here.
 *
 * Requires the local Mealie at http://localhost:9925 with the env
 * MEALIE_TOKEN set (the long-lived kiosk token). Skips cleanly when
 * MEALIE_TOKEN is missing OR the API is unreachable.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { SpecialistRegistry } from '@core/specialist';
import { ToolRegistry } from '@core/tool_registry';
import { ProposalsStore } from '@core/proposals';
import { ProcessMissStore } from '@core/process_misses';
import { ConversationStore, InterruptStore, SpecialistInbox } from '@memory/stores/conversations';
import { ConfigLLMRouter } from '@core/router';
import { LibraryStore } from '@library/store';
import { load_extra_capabilities } from '@core/capabilities';
import { AppEventBus } from '@app/events';
import type { ToolContext } from '@core/tool';

import {
  mealie_search_recipes,
  mealie_get_recipe,
  mealie_get_meal_plan_history,
  mealie_set_meal_plan,
  mealie_import_recipe_url,
} from '@connectors/mealie';
import { get_household_diets } from '../src/specialists/brigid/tools/get_household_diets';
import { get_ingredient_class } from '../src/specialists/brigid/tools/get_ingredient_class';
import { update_household_diet } from '../src/specialists/brigid/tools/update_household_diet';
import { create as create_update_brigid_vault } from '../src/specialists/brigid/tools/update_brigid_vault';

const MEALIE_BASE_URL = (process.env.MEALIE_BASE_URL ?? 'http://localhost:9925').replace(/\/+$/, '');
const MEALIE_TOKEN = process.env.MEALIE_TOKEN ?? '';

// Default to a BBC Good Food URL that Mealie's recipe_scrapers handles
// reliably. Override with HEARTH_BRIGID_SMOKE_RECIPE_URL for local testing.
// Note: many big recipe sites (Allrecipes, sometimes Serious Eats) anti-
// bot the scraper and return 400; BBC's classic spaghetti bolognese is a
// known-good fixture as of 2026-05.
const SMOKE_RECIPE_URL =
  process.env.HEARTH_BRIGID_SMOKE_RECIPE_URL ??
  'https://www.bbcgoodfood.com/recipes/best-spaghetti-bolognese-recipe';

process.env.HEARTH_TEST_MODE = '1';
process.env.HEARTH_DISABLE_LOOPS = '1';

// Redirect users.yaml reads/writes to a temp copy so the writer test
// doesn't clobber the source. Set BEFORE the diet tools resolve their
// lazy users_path() lookup on first execute().
//
// Sources the FIXTURE household, not `config/users.yaml`. That file is
// untracked (the orchestrator rewrites it and it holds credentials), so in
// CI's fresh checkout it does not exist — and this copy runs at module load,
// BEFORE the MEALIE_TOKEN skip, so its absence crashed the whole smoke rather
// than skipping it. The dietary values asserted below live in the fixture;
// change them together.
const REAL_USERS_YAML = resolve(import.meta.dir, 'fixtures', 'users.yaml');
const TMP_USERS_YAML = resolve(tmpdir(), `hearth-brigid-users-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yaml`);
copyFileSync(REAL_USERS_YAML, TMP_USERS_YAML);
process.env.HEARTH_USERS_PATH = TMP_USERS_YAML;

let failures = 0;
function check(label: string, ok: boolean, hint?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    if (hint) console.log(`      ${hint}`);
  }
}
function skip_all(reason: string): void {
  console.log(`SKIP  ${reason}`);
  process.exit(0);
}

function setup() {
  const root = mkdtempSync(resolve(tmpdir(), 'hearth-brigid-smoke-'));
  const vault = resolve(root, 'vault');
  mkdirSync(vault, { recursive: true });
  const db_path = resolve(root, 'hearth.db');
  const db = open_db(db_path);
  const memory = new MemoryClient({ vault_root: vault, db });

  // Specialist registry — copy Brigid's YAML (and Kate's, since the
  // registry's compile() touches the auto-include logic uniformly).
  const specialists_dir = resolve(root, 'specialists');
  mkdirSync(specialists_dir, { recursive: true });
  const seed_dir = resolve(import.meta.dir, '..', 'config', 'specialists');
  for (const id of ['kate', 'brigid']) {
    const src = resolve(seed_dir, `${id}.yaml`);
    if (existsSync(src)) {
      writeFileSync(resolve(specialists_dir, `${id}.yaml`), readFileSync(src, 'utf8'), 'utf8');
    }
  }
  // Load the capability extensions before the registry compiles.
  load_extra_capabilities(resolve(import.meta.dir, '..', 'config', 'capabilities.yaml'));
  const specialists = new SpecialistRegistry(specialists_dir);

  const proposals = new ProposalsStore(db);
  const interrupts = new InterruptStore(db);
  const conversations = new ConversationStore(db);
  const inbox = new SpecialistInbox(db);
  const process_misses = new ProcessMissStore(db);
  const tool_registry = new ToolRegistry();
  const events = new AppEventBus();

  const roles_path = resolve(root, 'roles.yaml');
  writeFileSync(
    roles_path,
    `roles:\n  specialist:\n    provider: ollama\n    model: test\n    temperature: 0.7\n`,
    'utf8',
  );
  const llm = new ConfigLLMRouter(roles_path, { ollama_base_url: 'http://localhost:11434' });

  const library_root = resolve(root, 'library');
  mkdirSync(library_root, { recursive: true });
  const library = new LibraryStore({ root: library_root, db });

  const update_vault_tool = create_update_brigid_vault({
    db,
    vault_root: vault,
    memory,
    llm,
    proposals,
    inbox,
    interrupts,
    conversations,
    specialists,
    runtime: undefined as never,
    events,
    process_misses,
    tool_registry,
    library,
  });

  // Register every tool Brigid uses, so list_for_capabilities can verify
  // the curated chat surface resolves.
  for (const t of [
    mealie_search_recipes,
    mealie_get_recipe,
    mealie_get_meal_plan_history,
    mealie_set_meal_plan,
    mealie_import_recipe_url,
    get_household_diets,
    update_household_diet,
    get_ingredient_class,
    update_vault_tool,
  ]) {
    tool_registry.register(t);
  }

  return { root, db, memory, specialists, tool_registry, vault, update_vault_tool };
}

async function mealie_alive(): Promise<boolean> {
  try {
    const r = await fetch(`${MEALIE_BASE_URL}/api/app/about`, {
      headers: { Authorization: `Bearer ${MEALIE_TOKEN}` },
      signal: AbortSignal.timeout(3000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function delete_recipe(slug: string): Promise<void> {
  try {
    await fetch(`${MEALIE_BASE_URL}/api/recipes/${encodeURIComponent(slug)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${MEALIE_TOKEN}` },
    });
  } catch {
    /* best-effort */
  }
}

async function delete_mealplan(id: number): Promise<void> {
  try {
    await fetch(`${MEALIE_BASE_URL}/api/households/mealplans/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${MEALIE_TOKEN}` },
    });
  } catch {
    /* best-effort */
  }
}

function plan_iso(offset_days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset_days);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  if (!MEALIE_TOKEN) {
    skip_all('MEALIE_TOKEN env var not set — Brigid smoke needs Mealie reachable.');
  }
  if (!(await mealie_alive())) {
    skip_all(`Mealie at ${MEALIE_BASE_URL} not reachable.`);
  }

  const ctx_runtime = setup();
  const tool_ctx: ToolContext = {
    memory: ctx_runtime.memory,
    llm: null as never,
    now: new Date(),
    intent_id: 'smoke-brigid',
    specialist_id: 'brigid',
  };

  // ── 0. Brigid is registered, has the curated tool surface ───────────
  console.log('\n→ Brigid registered + her curated tool surface resolves');
  const brigid = ctx_runtime.specialists.get('brigid');
  check('brigid.yaml loaded into the registry', Boolean(brigid));
  if (brigid) {
    const visible = ctx_runtime.tool_registry.list_for_capabilities(brigid.granted).map((t) => t.name);
    const required = [
      'mealie_search_recipes',
      'mealie_get_recipe',
      'mealie_get_meal_plan_history',
      'mealie_set_meal_plan',
      'mealie_import_recipe_url',
      'get_household_diets',
      'update_household_diet',
      'get_ingredient_class',
      'update_brigid_vault',
    ];
    for (const name of required) {
      check(`brigid sees ${name}`, visible.includes(name));
    }
  }

  // ── 1. URL flow: import a recipe + save to backlog ───────────────────
  console.log('\n→ URL flow: mealie_import_recipe_url + update_brigid_vault(backlog)');
  const import_result = await mealie_import_recipe_url.execute(
    { url: SMOKE_RECIPE_URL, include_tags: false, generate_thumb: false },
    tool_ctx,
  );
  check(
    `imported a recipe from ${SMOKE_RECIPE_URL}`,
    import_result.ok && Boolean(import_result.slug),
    import_result.error ?? import_result.message,
  );
  const imported_slug = import_result.slug;

  if (imported_slug) {
    const backlog_result = await ctx_runtime.update_vault_tool.execute(
      {
        kind: 'backlog',
        title: imported_slug,
        source_url: SMOKE_RECIPE_URL,
        body: `Smoke-test save — Jasper hasn't actually picked this. Slug: ${imported_slug}.`,
      },
      tool_ctx,
    );
    check(
      'backlog write returned the right path',
      backlog_result.rel_path === 'users/jasper/brigid/backlog.md' && backlog_result.kind === 'backlog',
    );
    const backlog_abs = resolve(ctx_runtime.vault, backlog_result.rel_path);
    const backlog_text = existsSync(backlog_abs) ? readFileSync(backlog_abs, 'utf8') : '';
    check(
      'backlog file contains the saved URL',
      backlog_text.includes(SMOKE_RECIPE_URL),
      `backlog content was:\n${backlog_text.slice(0, 200)}`,
    );

    // Verify mealie_get_recipe round-trips the slug.
    const detail = await mealie_get_recipe.execute({ slug: imported_slug }, tool_ctx);
    check(
      'mealie_get_recipe returns body for the imported slug',
      !detail.error && detail.slug === imported_slug && detail.name.length > 0,
      detail.error,
    );
  }

  // ── 2. Diets + ingredient class lookups ──────────────────────────────
  console.log('\n→ Diet intersection (users.yaml) + ingredient class lookup');
  const diets = await get_household_diets.execute({}, tool_ctx);
  check('found at least one household member with a dietary block', diets.members.length >= 1);
  const sam = diets.members.find((m) => m.id === 'sam');
  const jasper = diets.members.find((m) => m.id === 'jasper');
  check('Sam is present in users.yaml as a household member', Boolean(sam));
  check('Jasper is present with a dietary block', Boolean(jasper));
  check(
    "Sam's shellfish restriction made it into the intersection",
    diets.intersection.restrictions.includes('shellfish'),
    `intersection.restrictions = ${JSON.stringify(diets.intersection.restrictions)}`,
  );
  check(
    "Sam's cilantro dislike made it into the intersection",
    diets.intersection.dislikes.includes('cilantro'),
    `intersection.dislikes = ${JSON.stringify(diets.intersection.dislikes)}`,
  );

  // Seeded values from scripts/fixtures/users.yaml.
  check(
    "Jasper's daily_calorie_target is 2000",
    jasper?.dietary.daily_calorie_target === 2000,
    `got ${jasper?.dietary.daily_calorie_target}`,
  );
  check(
    "Jasper's daily_calorie_max is 2000",
    jasper?.dietary.daily_calorie_max === 2000,
    `got ${jasper?.dietary.daily_calorie_max}`,
  );
  check(
    "Jasper's macro_priority is protein_high",
    jasper?.dietary.macro_priority === 'protein_high',
    `got ${jasper?.dietary.macro_priority}`,
  );
  check(
    "Jasper's portion_factor is 1.4",
    jasper?.dietary.portion_factor === 1.4,
    `got ${jasper?.dietary.portion_factor}`,
  );
  check(
    "Jasper carries vegetable-forward as a favorite",
    jasper?.dietary.favorites.includes('vegetable-forward') === true,
    `jasper.favorites = ${JSON.stringify(jasper?.dietary.favorites)}`,
  );
  check('Jasper is flagged is_sender=true', jasper?.is_sender === true);

  check(
    "Sam's daily_calorie_target is 1650",
    sam?.dietary.daily_calorie_target === 1650,
    `got ${sam?.dietary.daily_calorie_target}`,
  );
  check(
    "Sam's daily_calorie_max is 1650",
    sam?.dietary.daily_calorie_max === 1650,
    `got ${sam?.dietary.daily_calorie_max}`,
  );
  check(
    "Sam's macro_priority is balanced",
    sam?.dietary.macro_priority === 'balanced',
    `got ${sam?.dietary.macro_priority}`,
  );
  check(
    "Sam's portion_factor is 1.0",
    sam?.dietary.portion_factor === 1.0,
    `got ${sam?.dietary.portion_factor}`,
  );
  check('Sam is flagged is_sender=false', sam?.is_sender === false);

  // Sam's gram-level macro targets (the new sub-block).
  check(
    "Sam's macro_targets.protein_g is 80",
    sam?.dietary.macro_targets?.protein_g === 80,
    `got ${JSON.stringify(sam?.dietary.macro_targets)}`,
  );
  check(
    "Sam's macro_targets.carbs_g is 160",
    sam?.dietary.macro_targets?.carbs_g === 160,
  );
  check("Sam's macro_targets.fat_g is 55", sam?.dietary.macro_targets?.fat_g === 55);
  check("Sam's macro_targets.fiber_g is 25", sam?.dietary.macro_targets?.fiber_g === 25);
  check("Sam's macro_targets.net_carbs_g is 130", sam?.dietary.macro_targets?.net_carbs_g === 130);

  check(
    "intersection.macro_priority bias = Jasper's (protein_high)",
    diets.intersection.macro_priority === 'protein_high',
    `got ${diets.intersection.macro_priority}`,
  );
  check(
    'intersection.total_calorie_target sums the two targets (3650)',
    diets.intersection.total_calorie_target === 3650,
    `got ${diets.intersection.total_calorie_target}`,
  );
  check(
    'intersection.total_calorie_max sums the two ceilings (3650)',
    diets.intersection.total_calorie_max === 3650,
    `got ${diets.intersection.total_calorie_max}`,
  );

  // member_id scoping returns just that person.
  const sara_only = await get_household_diets.execute({ member_id: 'sam' }, tool_ctx);
  check('member_id scoping returns only the requested member', sara_only.members.length === 1 && sara_only.members[0]?.id === 'sam');

  // ── update_household_diet round-trip ──────────────────────────────────
  console.log('\n→ update_household_diet — round-trip a calorie change + a macro patch + an array add');
  const initial_text = readFileSync(TMP_USERS_YAML, 'utf8');
  check('users.yaml contains the schema comment block (proof of preservation pre-write)', initial_text.includes('Schema validated by src/core/users.ts'));

  const upd1 = await update_household_diet.execute(
    {
      member_id: 'sam',
      daily_calorie_target: 1500,
      macro_targets: { protein_g: 90, fiber_g: 30 },
      add_dislikes: ['raw onion'],
      reason: 'smoke test — adjust Sam protein up + fiber up, lower target',
    },
    tool_ctx,
  );
  check('writer reported changed=true', upd1.changed);
  check('writer diff includes daily_calorie_target', upd1.diff_summary.some((s) => s.startsWith('daily_calorie_target:')));
  check('writer diff includes macro_targets', upd1.diff_summary.some((s) => s.startsWith('macro_targets:')));
  check("writer diff notes 'dislikes +: raw onion'", upd1.diff_summary.some((s) => s.includes('raw onion')));
  check('after.daily_calorie_target is 1500', upd1.after.daily_calorie_target === 1500);
  check('after.daily_calorie_max stayed at 1650 (omitted = unchanged)', upd1.after.daily_calorie_max === 1650);
  check('after.macro_targets.protein_g is 90', upd1.after.macro_targets?.protein_g === 90);
  check('after.macro_targets.fiber_g is 30', upd1.after.macro_targets?.fiber_g === 30);
  check('after.macro_targets.carbs_g preserved at 160 (partial merge)', upd1.after.macro_targets?.carbs_g === 160);
  check("after.dislikes includes 'raw onion'", upd1.after.dislikes.includes('raw onion'));
  check("after.dislikes still includes 'cilantro' (add doesn't wipe)", upd1.after.dislikes.includes('cilantro'));

  // Verify the file on disk matches and comments were preserved.
  const after_text = readFileSync(TMP_USERS_YAML, 'utf8');
  check('comment block preserved through round-trip', after_text.includes('Schema validated by src/core/users.ts'));
  check('PLACEHOLDER-style comments on Sam survive', after_text.includes('Jasper confirmed') || after_text.includes('PLACEHOLDER'));
  check('disk has the new protein_g: 90', after_text.includes('protein_g: 90'));

  // Re-read through get_household_diets to confirm the writer's output
  // parses cleanly through the Zod schema.
  const after_diets = await get_household_diets.execute({ member_id: 'sam' }, tool_ctx);
  check('reread shows daily_calorie_target=1500', after_diets.members[0]?.dietary.daily_calorie_target === 1500);
  check('reread shows macro_targets.protein_g=90', after_diets.members[0]?.dietary.macro_targets?.protein_g === 90);

  // Idempotent no-op — passing the same payload that's already on disk
  // should yield changed=false.
  const upd2 = await update_household_diet.execute(
    {
      member_id: 'sam',
      daily_calorie_target: 1500,
      macro_targets: { protein_g: 90, fiber_g: 30 },
      reason: 'smoke test — no-op call',
    },
    tool_ctx,
  );
  check('no-op call reports changed=false', upd2.changed === false);

  // Unknown member fails loudly (writer is strict).
  let threw = false;
  try {
    await update_household_diet.execute(
      { member_id: 'nonexistent', daily_calorie_target: 1000, reason: 'should throw' },
      tool_ctx,
    );
  } catch {
    threw = true;
  }
  check('writer throws on unknown member_id', threw);

  // remove_dislikes works.
  const upd3 = await update_household_diet.execute(
    { member_id: 'sam', remove_dislikes: ['raw onion'], reason: 'smoke test — remove' },
    tool_ctx,
  );
  check('remove_dislikes round-trips', upd3.changed && !upd3.after.dislikes.includes('raw onion') && upd3.after.dislikes.includes('cilantro'));

  // Capability gate: a specialist WITHOUT write_household_diets must not see this tool.
  const kate = ctx_runtime.specialists.get('kate');
  if (kate) {
    const kate_visible = ctx_runtime.tool_registry.list_for_capabilities(kate.granted).map((t) => t.name);
    check('Kate does NOT see update_household_diet (capability gate)', !kate_visible.includes('update_household_diet'));
  }

  const classes = await get_ingredient_class.execute(
    { ingredients: ['salmon', 'ground beef', 'chicken thigh', 'onions', 'rice', 'fancyobscurespice'] },
    tool_ctx,
  );
  const by_ing = Object.fromEntries(classes.results.map((r) => [r.ingredient, r]));
  check('salmon classified as class 1 (fish)', by_ing.salmon?.class_num === 1);
  check('ground beef classified as class 2', by_ing['ground beef']?.class_num === 2);
  check('chicken thigh classified as class 3', by_ing['chicken thigh']?.class_num === 3);
  check('onions classified as class 4 (root/hardy)', by_ing.onions?.class_num === 4);
  check('rice classified as class 5 (pantry)', by_ing.rice?.class_num === 5);
  check(
    'fancyobscurespice miss returns judged=false',
    by_ing.fancyobscurespice?.judged === false && by_ing.fancyobscurespice?.class_num === null,
  );

  // ── 3. /plan flow: history + set_meal_plan + plan summary ─────────────
  console.log('\n→ /plan flow: history + 7-day publish + vault summary');
  const history = await mealie_get_meal_plan_history.execute({ days: 28, future_days: 0 }, tool_ctx);
  check('history call succeeded', !history.error, history.error);
  check('history window covers 28 days', history.window.start.length === 10 && history.window.end.length === 10);

  const start_date = plan_iso(7); // a week from today, so we don't clobber any real plan
  const meals = [
    { date: plan_iso(7), slot: 'dinner' as const, recipe_slug: imported_slug ?? undefined, note: 'doubled, planned leftovers' },
    { date: plan_iso(8), slot: 'dinner' as const, title: 'Takeout — Thai (Sam: no shellfish)' },
    { date: plan_iso(9), slot: 'dinner' as const, title: 'Leftovers — Mon\'s soup' },
    { date: plan_iso(10), slot: 'dinner' as const, title: 'Pantry pasta night' },
    { date: plan_iso(11), slot: 'dinner' as const, title: 'Sheet-pan chicken thighs' },
    { date: plan_iso(12), slot: 'dinner' as const, title: 'Saturday cook day — TBD' },
    { date: plan_iso(13), slot: 'dinner' as const, title: 'Sunday roast' },
  ];

  const publish = await mealie_set_meal_plan.execute(
    { start_date, meals, replace_existing: true },
    tool_ctx,
  );
  check(
    'mealie_set_meal_plan created all 7 entries',
    publish.total_created === 7,
    `created=${publish.total_created}, results=${JSON.stringify(publish.results.filter((r) => !r.ok).map((r) => r.error))}`,
  );

  // Verify Mealie sees the 7 entries — the published week is in the
  // future, so we widen the window with future_days.
  const after = await mealie_get_meal_plan_history.execute({ days: 1, future_days: 21 }, tool_ctx);
  const after_dates = new Set(after.entries.filter((e) => e.slot === 'dinner').map((e) => e.date));
  const expected_dates = meals.map((m) => m.date);
  const all_present = expected_dates.every((d) => after_dates.has(d));
  check('all 7 published dates are visible in mealplan history', all_present);

  // Re-publish to verify replace_existing wipes prior entries cleanly.
  const republish = await mealie_set_meal_plan.execute(
    { start_date, meals, replace_existing: true },
    tool_ctx,
  );
  check(
    'replace_existing=true cleaned up previous draft (no duplicates)',
    republish.total_replaced === 7 && republish.total_created === 7,
    `replaced=${republish.total_replaced}, created=${republish.total_created}`,
  );

  // Plan summary in the vault.
  const summary_body =
    `Quick week — Tuesday is takeout (Sam out late), Wed is leftovers from Mon's soup.\n\n` +
    meals
      .map((m, i) => {
        const label = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i] ?? '?';
        const what = m.recipe_slug ? `(slug: ${m.recipe_slug})` : m.title;
        return `- **${label}** (${m.date}): ${what}`;
      })
      .join('\n') +
    `\n\n## Notes\n\n- Monday's pot is doubled — Wed lunch covered.\n- Sam: no shellfish (Thai pad see ew, no shrimp pad thai).\n`;
  const plan_result = await ctx_runtime.update_vault_tool.execute(
    { kind: 'plan', date: start_date, body: summary_body },
    tool_ctx,
  );
  const plan_abs = resolve(ctx_runtime.vault, plan_result.rel_path);
  check('plan summary file landed in the vault', existsSync(plan_abs));
  check(
    `plan summary path is users/jasper/brigid/plans/${start_date}.md`,
    plan_result.rel_path === `users/jasper/brigid/plans/${start_date}.md`,
  );
  const plan_text = existsSync(plan_abs) ? readFileSync(plan_abs, 'utf8') : '';
  check('plan summary mentions Sam restriction', plan_text.includes('no shellfish'));

  // ── 4. Cleanup ────────────────────────────────────────────────────────
  console.log('\n→ Cleanup');
  for (const r of publish.results) {
    if (r.mealie_id) await delete_mealplan(r.mealie_id);
  }
  for (const r of republish.results) {
    if (r.mealie_id) await delete_mealplan(r.mealie_id);
  }
  if (imported_slug) {
    await delete_recipe(imported_slug);
    console.log(`      deleted test recipe ${imported_slug}`);
  }

  console.log(`\n${failures === 0 ? '✓ smoke:brigid passed' : `✗ smoke:brigid: ${failures} failure(s)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke:brigid threw:', err);
  process.exit(1);
});
