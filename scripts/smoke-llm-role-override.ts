/**
 * smoke:llm-role-override — the hot role layer + one-call instant revert.
 *
 * Self-contained: temp SQLite, a temp llm-roles.yaml, no network, no LLM.
 *
 * The property under test is the one that was structurally impossible before:
 * changing which model serves a role, and UNDOING it, without a restart.
 * `ConfigLLMRouter` `readFileSync`s the YAML once in its constructor and has no
 * watcher, so every "instant model revert" story ran through
 * `docker compose restart hearth-orchestrator`.
 *
 * Coverage:
 *   A. store — one active override per role, apply supersedes, revert lifts,
 *      history keeps the trail, a corrupt patch reads as empty (fail toward base).
 *   B. router — the override wins over the YAML, revert restores it WITHOUT
 *      reconstructing the router, and a model-only swap keeps the SAME endpoint
 *      mutex (no desync).
 *   C. the mutex-conflict refusal — the one real hazard, refused with both slot
 *      counts rather than silently mis-sizing the role's backpressure.
 *   D. fail-open + kill switch — a throwing source, no source, and
 *      HEARTH_LLM_ROLE_OVERRIDES=0 all resolve to the base YAML.
 *   E. the tool — owner gate, inspect/set/revert/history, cache invalidation.
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigLLMRouter, role_overrides_enabled } from '@core/router';
import { LlmRoleOverrideStore } from '@memory/stores/llm_role_overrides';
import { make_manage_llm_role } from '../src/specialists/kate/tools/manage_llm_role';
import type { MemoryClient } from '@memory/client';
import type { ToolContext } from '@core/tool';

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'role-override-'));
const ROLES = join(dir, 'llm-roles.yaml');
writeFileSync(
  ROLES,
  `roles:
  specialist:
    provider: openai
    model: base-9b
    base_url: http://box:8088
    concurrent: true
    max_concurrency: 4
  deep_consult:
    provider: openai
    model: base-35b
    base_url: http://box:8200
    concurrent: true
    max_concurrency: 2
  lonely:
    provider: openai
    model: base-lonely
    base_url: http://unused:9999
    concurrent: true
    max_concurrency: 3
`,
);

const db = new Database(join(dir, 'test.db'));
db.exec(`CREATE TABLE llm_role_overrides (
  id TEXT PRIMARY KEY, role TEXT NOT NULL, patch_json TEXT NOT NULL, prev_json TEXT,
  reason TEXT NOT NULL DEFAULT '', applied_by TEXT NOT NULL, applied_at TEXT NOT NULL,
  reverted_at TEXT, reverted_by TEXT
);`);

const store = new LlmRoleOverrideStore(db);
const env = { ollama_base_url: 'http://ollama', openai_base_url: 'http://box:8088', openai_api_key: 'k' };

/* ================================================================== */
console.log('\nA. store — one active per role, supersede, revert, history');
/* ================================================================== */

{
  const a = store.apply({ role: 'specialist', patch: { model: 'candidate-v1' }, reason: 'trial', applied_by: 'jasper' });
  assert(a.role === 'specialist' && a.patch.model === 'candidate-v1', 'apply records the patch');
  assert(store.active_for('specialist')?.id === a.id, 'it reads back as active');

  const b = store.apply({ role: 'specialist', patch: { model: 'candidate-v2' }, reason: 'trial 2', applied_by: 'jasper' });
  assert(store.active_for('specialist')?.id === b.id, 'a second apply becomes the active one');
  assert(
    store.history({ role: 'specialist' }).filter((r) => !r.reverted_at).length === 1,
    'the first is auto-reverted — the layer is exactly one deep, never a stack',
  );

  const reverted = store.revert('specialist', 'jasper');
  assert(reverted?.id === b.id, 'revert lifts the active override and returns it');
  assert(store.active_for('specialist') === null, 'nothing active afterwards');
  assert(store.revert('specialist', 'jasper') === null, 'reverting again is a clean no-op');
  assert(store.history({ role: 'specialist' }).length === 2, 'history keeps the full trail');
}

{
  db.prepare(
    `INSERT INTO llm_role_overrides (id,role,patch_json,reason,applied_by,applied_at)
     VALUES ('bad','deep_consult','{NOT JSON','x','t','2026-08-01T00:00:00Z')`,
  ).run();
  const m = store.active_map();
  assert(
    JSON.stringify(m.get('deep_consult')) === '{}',
    'a corrupt patch reads as EMPTY — fail toward the base config, never toward garbage',
  );
  db.prepare(`DELETE FROM llm_role_overrides WHERE id='bad'`).run();
}

/* ================================================================== */
console.log('\nB. router — override wins, revert restores, no restart, mutex shared');
/* ================================================================== */

const router = new ConfigLLMRouter(ROLES, env);
router.set_override_source(() => store.active_map());

assert(role_overrides_enabled(), 'the layer is enabled by default');
assert(router.for_role('specialist' as never).model === 'base-9b', 'base YAML model before any override');

{
  // Resolve deep_consult first so its endpoint mutex exists (used in C).
  router.for_role('deep_consult' as never);
  store.apply({ role: 'specialist', patch: { model: 'hot-swapped' }, reason: 'live swap', applied_by: 'jasper' });
  router.invalidate_override_cache();
  assert(
    router.for_role('specialist' as never).model === 'hot-swapped',
    'the override wins over the YAML on the SAME router instance — no restart',
  );
  assert(
    router.for_role('deep_consult' as never).model === 'base-35b',
    'an untouched role is unaffected',
  );

  store.revert('specialist', 'jasper');
  router.invalidate_override_cache();
  assert(
    router.for_role('specialist' as never).model === 'base-9b',
    'REVERT restores the YAML config on the same router — the whole point',
  );
}

{
  // A model-only swap keeps base_url, so the endpoint key is unchanged and the
  // role stays on the SAME mutex. This is why the common case is always safe.
  const conflict = router.check_endpoint_conflict('specialist' as never, { model: 'anything' });
  assert(conflict === null, 'a MODEL-only override never conflicts (same endpoint → same mutex)');
}

/* ================================================================== */
console.log('\nC. the mutex-conflict refusal — the one real hazard');
/* ================================================================== */

{
  // specialist declares 4 slots; deep_consult's endpoint mutex was built with 2.
  const c = router.check_endpoint_conflict('specialist' as never, { base_url: 'http://box:8200' });
  assert(c !== null, 'moving a role onto an endpoint with an EXISTING different-width mutex is refused');
  assert(c?.existing_slots === 2 && c?.requested_slots === 4, 'both slot counts are reported, not just "no"');
  assert(
    (c?.reason ?? '').includes('max_concurrency: 2'),
    'the refusal names the fix (match the width) rather than dead-ending',
  );

  const matched = router.check_endpoint_conflict('specialist' as never, {
    base_url: 'http://box:8200',
    max_concurrency: 2,
  });
  assert(matched === null, 'declaring the matching width is accepted');

  const virgin = router.check_endpoint_conflict('specialist' as never, { base_url: 'http://brand-new:1234' });
  assert(virgin === null, 'an endpoint with no mutex yet is fine — this role fixes its width');
}

/* ================================================================== */
console.log('\nD. fail-open + kill switch');
/* ================================================================== */

{
  const r2 = new ConfigLLMRouter(ROLES, env);
  assert(r2.for_role('specialist' as never).model === 'base-9b', 'NO source wired → base config');

  r2.set_override_source(() => {
    throw new Error('store exploded');
  });
  assert(
    r2.for_role('specialist' as never).model === 'base-9b',
    'a THROWING source → base config (an override layer can never take inference down)',
  );

  store.apply({ role: 'specialist', patch: { model: 'should-not-apply' }, reason: 'x', applied_by: 'jasper' });
  const r3 = new ConfigLLMRouter(ROLES, env);
  r3.set_override_source(() => store.active_map());
  process.env.HEARTH_LLM_ROLE_OVERRIDES = '0';
  assert(
    r3.for_role('specialist' as never).model === 'base-9b',
    'HEARTH_LLM_ROLE_OVERRIDES=0 → byte-identical to pre-override behaviour',
  );
  delete process.env.HEARTH_LLM_ROLE_OVERRIDES;
  r3.invalidate_override_cache();
  assert(r3.for_role('specialist' as never).model === 'should-not-apply', 're-arms when the switch is removed');
  store.revert('specialist', 'jasper');
}

/* ================================================================== */
console.log('\nE. manage_llm_role — owner gate, the four actions, cache bust');
/* ================================================================== */

const audit: Array<Record<string, unknown>> = [];
const memory = { log_action: (r: Record<string, unknown>) => { audit.push(r); return 'a1'; } } as unknown as MemoryClient;
const tool = make_manage_llm_role({ db, memory, router });
const owner = { intent_id: 'i1', now: new Date(), memory, user: { id: 'jasper', tier: 'owner' } } as unknown as ToolContext;
const member = { intent_id: 'i2', now: new Date(), memory, user: { id: 'sam', tier: 'household' } } as unknown as ToolContext;

{
  const r = await tool.execute({ action: 'inspect', role: 'specialist' }, member);
  assert(r.ok === false && r.next_action.includes('owner-only'), 'a non-owner is refused');
}

{
  const r = await tool.execute({ action: 'inspect', role: 'specialist' }, owner);
  assert(r.ok === true && r.override_active === false, 'inspect: no override active');
}

{
  const r = await tool.execute({ action: 'set', role: 'specialist' }, owner);
  assert(r.ok === false && r.next_action.includes('needs a `patch`'), 'set with no patch is refused, not silently applied');
}

{
  const r = await tool.execute(
    { action: 'set', role: 'specialist', patch: { model: 'trial-model' }, reason: 'A/B' },
    owner,
  );
  assert(r.ok === true && r.override_active === true, 'set applies');
  assert(
    router.for_role('specialist' as never).model === 'trial-model',
    'the tool BUSTS the router cache — live on the next request, no restart and no 2s wait',
  );
  assert(audit.some((a) => a.tool_name === 'llm_role_overridden'), 'the swap is audited');
}

{
  const r = await tool.execute(
    { action: 'set', role: 'specialist', patch: { base_url: 'http://box:8200' } },
    owner,
  );
  assert(r.ok === false && !!r.refused_reason, 'the tool refuses a mutex-conflicting base_url move');
  assert(
    router.for_role('specialist' as never).model === 'trial-model',
    'a refused set changes nothing — the prior override still stands',
  );
}

{
  const r = await tool.execute({ action: 'revert', role: 'specialist' }, owner);
  assert(r.ok === true, 'revert succeeds');
  assert(
    router.for_role('specialist' as never).model === 'base-9b',
    'ONE CALL restores the YAML model, live — the capability that did not exist before',
  );
  assert(audit.some((a) => a.tool_name === 'llm_role_reverted'), 'the revert is audited');

  const again = await tool.execute({ action: 'revert', role: 'specialist' }, owner);
  assert(again.ok === true && again.override === null, 'reverting with nothing active is a clean no-op');
}

{
  const r = await tool.execute({ action: 'history' }, owner);
  assert(r.ok === true && (r.history?.length ?? 0) > 0, 'history returns the trail');
}

{
  const r = await tool.execute({ action: 'set', patch: { model: 'x' } }, owner);
  assert(r.ok === false && r.next_action.includes('needs a `role`'), 'set without a role is refused');
}

db.close();
rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\nsmoke:llm-role-override OK' : `\nsmoke:llm-role-override FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
