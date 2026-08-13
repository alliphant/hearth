/**
 * smoke:tool-contracts — guards the "arg-spiral class" drain.
 *
 * A persona that advertises a narrower call contract than a tool's zod
 * input_schema actually requires sends a small open model into
 * INPUT_VALIDATION_FAILED → identical-retry → DUPLICATE_TOOL_CALL →
 * same_tool_spiral_exhaust. The fix is on the TOOL: honor the advertised
 * minimal contract and derive/fill the rest internally (Anna's
 * assess_protest_case was the exemplar). This smoke asserts each reconciled
 * tool's schema accepts the contract its persona advertises, and that the
 * registry recovers from the most common enum fat-finger centrally.
 *
 * Pure schema + registry assertions — no orchestrator, no network. The only
 * dependency is a throwaway SQLite file (track_listing builds a store at
 * construction).
 *
 *   bun run smoke:tool-contracts
 */
import { z } from 'zod';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { ToolRegistry } from '@core/tool_registry';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { Capability } from '@core/capabilities';
import { create as create_assess } from '@specialists/anna/tools/assess_protest_case';
import { create as create_track } from '@specialists/linda/tools/track_listing';
import { create as create_push } from '@specialists/astrid/tools/push_coaching_note';
import { create as create_workout_state } from '@specialists/astrid/tools/get_workout_state';
import { create as create_personal_records } from '@specialists/astrid/tools/get_personal_records';
import { create as create_kristi_facts } from '@specialists/kristi/tools/record_facts';
import { getKristiWorkstationsStore } from '@memory/stores/kristi_workstations';
import { upsert_person_note, coerce_patch } from '@agents/scribe/tools/upsert_person_note';
import { make_schedule_calendar_event } from '@specialists/kate/tools/schedule_calendar_event';
import { make_propose_action, effective_rationale } from '@specialists/kate/tools/propose_action';
import { make_flag_beatrice } from '@specialists/kate/tools/flag_beatrice';
import { recover_scalar_shapes, safe_parse_with_recovery } from '@core/scalar_recovery';
import type { ProposalsStore } from '@core/proposals';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}
const parses = (t: Tool, input: unknown): boolean => t.input_schema.safeParse(input).success;
const rejects = (t: Tool, input: unknown): boolean => !t.input_schema.safeParse(input).success;

const dir = mkdtempSync(join(tmpdir(), 'hearth-contracts-'));
// Point Kristi's process-singleton store at a throwaway db BEFORE any execute
// triggers it (the getter is lazy + reads this env at first construction).
process.env.HEARTH_KRISTI_DB_PATH = join(dir, 'kristi.db');
const db = open_db(join(dir, 'contracts.db'));
const deps = { db, memory: { log_action: () => undefined } } as unknown as ToolDeps;

try {
  // ── Anna: assess_protest_case (the exemplar — one-arg contract) ─────────
  const assess = create_assess(deps);
  check('assess_protest_case accepts {account_no} only', parses(assess, { account_no: '1234567' }));
  check('assess_protest_case accepts {address} only', parses(assess, { address: '123 Main St, Pleasantville' }));
  check('assess_protest_case still rejects {} (needs account_no|address)', rejects(assess, {}));

  // ── Linda: track_listing (item_title optional on item_ref updates) ──────
  const track = create_track(deps);
  check(
    'track_listing accepts a title-less follow-up update (item_ref + sale)',
    parses(track, { item_ref: 'rsl_abc123', status: 'sold', sold_price: 38, sold_at: '2026-06-14' }),
  );
  check(
    'track_listing accepts a title-less price drop (item_ref + add_price_drop)',
    parses(track, { item_ref: 'rsl_abc123', add_price_drop: { at: '2026-06-10', price: 40 } }),
  );
  check(
    'track_listing accepts a new card (item_title, no item_ref)',
    parses(track, { item_title: 'Patagonia down jacket, M', platform: 'ebay', list_price: 80 }),
  );
  check('track_listing rejects {} (needs item_ref or item_title)', rejects(track, {}));

  // ── Astrid: user_id is ambient (ctx), never a required model arg ────────
  const push = create_push(deps);
  check(
    'push_coaching_note accepts the persona 2-arg call (no user_id)',
    parses(push, { trigger: 'manual', message: 'Twelve minutes in — cadence is steady.' }),
  );
  const ws = create_workout_state(deps);
  check('get_workout_state accepts {} (user_id from ctx)', parses(ws, {}));
  const pr = create_personal_records(deps);
  check(
    'get_personal_records accepts {workout_type} only (user_id from ctx)',
    parses(pr, { workout_type: 'cycling' }),
  );
  check('get_personal_records still rejects {} (workout_type irreducible)', rejects(pr, {}));

  // ── Kate: schedule_calendar_event — a timed event needs only a START ────
  // The original "moved appt landed all-day at the wrong time" bug: the
  // schema REQUIRED end_date_time for a timed event, so "4pm" (a start, no
  // duration) failed validation and the model fell back to the all-day
  // shape. end_date_time is now optional (defaults to +1h).
  const cal = make_schedule_calendar_event({} as unknown as ProposalsStore);
  check(
    'schedule_calendar_event accepts a TIMED event with NO end_date_time (the 4pm→all-day bug)',
    parses(cal, { summary: 'Dog nails', start_date_time: '2026-06-13T16:00:00', rationale: 'move it' }),
  );
  check(
    'schedule_calendar_event accepts a MOVE (replaces_event_id + new start, no end)',
    parses(cal, { summary: 'Dog nails', start_date_time: '2026-06-13T16:00:00', replaces_event_id: 'EK-ABC-123', rationale: 'reschedule' }),
  );
  check(
    'schedule_calendar_event accepts an all-day event (start_date only)',
    parses(cal, { summary: "Sam's birthday", start_date: '2027-02-20', rationale: 'annual' }),
  );
  check(
    'schedule_calendar_event rejects a body with no start at all (needs start_date_time|start_date)',
    rejects(cal, { summary: 'x', rationale: 'y' }),
  );

  // ── Scribe: upsert_person_note coerces an object body_append to string ──
  const obj_append = upsert_person_note.input_schema.safeParse({
    identifier: { name: 'Jasper' },
    patch: {},
    body_append: { address: '3215 Westwood CT' },
  });
  check(
    'upsert_person_note accepts an object body_append (was: expected string)',
    obj_append.success,
  );
  check(
    'upsert_person_note coerces the object to a readable string carrying the value',
    obj_append.success &&
      typeof (obj_append.data as { body_append?: unknown }).body_append === 'string' &&
      String((obj_append.data as { body_append?: unknown }).body_append).includes('Westwood'),
  );
  const str_append = upsert_person_note.input_schema.safeParse({
    identifier: { name: 'Jasper' },
    patch: {},
    body_append: 'Plain markdown line.',
  });
  check(
    'upsert_person_note still accepts a plain string body_append (back-compat)',
    str_append.success &&
      (str_append.data as { body_append?: unknown }).body_append === 'Plain markdown line.',
  );

  // ── Scribe: the 2026-06-22 arg-spiral that lost Ceci's itinerary ──────────
  // Replays the THREE exact shapes Kate's 9B emitted (all INPUT_VALIDATION_FAILED
  // pre-fix): bare-string identifier, stringified-object identifier, string/omitted
  // patch. All must now coerce + parse.
  const id_bare = upsert_person_note.input_schema.safeParse({
    identifier: 'Ceci',
    patch: '{}',
    body_append: '## Hiking',
  });
  check(
    'upsert_person_note coerces bare-string identifier "Ceci" → {name}',
    id_bare.success &&
      (id_bare.data as { identifier: { name?: string } }).identifier.name === 'Ceci',
  );
  const id_strobj = upsert_person_note.input_schema.safeParse({
    identifier: '{name: "Ceci"}',
    body_append: '## Hiking',
  });
  check(
    'upsert_person_note coerces stringified-object identifier + omitted patch',
    id_strobj.success &&
      (id_strobj.data as { identifier: { name?: string }; patch: object }).identifier.name === 'Ceci' &&
      typeof (id_strobj.data as { patch: object }).patch === 'object',
  );
  const id_pid = upsert_person_note.input_schema.safeParse({ identifier: 'p_84hbow', patch: '{"work":"HP"}' });
  check(
    'upsert_person_note coerces a p_ id string → {id} and a stringified patch → object',
    id_pid.success &&
      (id_pid.data as { identifier: { id?: string } }).identifier.id === 'p_84hbow' &&
      (id_pid.data as { patch: { work?: string } }).patch.work === 'HP',
  );

  // ── Scribe: upsert_person_note CREATES a never-seen person in ONE call ───
  // The remaining "Dr. Alba Moreno" failure: pre-fix, upsert THREW "Person not
  // found — call find_or_create_person first," a two-step the 9B can't do
  // reliably (it retried → DUPLICATE_TOOL_CALL → the itinerary was lost). Now a
  // never-seen NAME is created + patched in the same call; the cordon/stamp must
  // hold, and a bare {id}-not-found stays a clean error (can't seed from an id).
  const pvault = join(dir, 'people-vault');
  mkdirSync(pvault, { recursive: true });
  const pmemory = new MemoryClient({ vault_root: pvault, db });
  const owner_ctx = {
    memory: pmemory,
    intent_id: 'smoke-contracts',
    now: new Date('2026-06-22T12:00:00Z'),
    user: { id: 'jasper', tier: 'owner' },
  } as unknown as ToolContext;

  check('upsert: never-seen person not present before the call', pmemory.find_person({ name: 'Dr. Alba Moreno' }) === null);
  const created_out = (await upsert_person_note.execute(
    {
      identifier: { name: 'Dr. Alba Moreno' },
      patch: { relationship: 'service', address: '1230 E Ashgrove Ave, Pleasantville' },
      body_append: 'New dermatologist — wants a skin check in six months.',
    } as never,
    owner_ctx,
  )) as { id: string; note_path: string };
  check('upsert create-or-update returned a p_ id', /^p_[a-z0-9]{6}$/.test(created_out.id));
  check('upsert filed the note under People/', created_out.note_path.startsWith('People/'));
  const looked = pmemory.find_person({ name: 'Dr. Alba Moreno' });
  check('upsert: person is now findable by name (CREATED in one call)', looked !== null && looked.id === created_out.id);
  check(
    'upsert: the patch landed on the new record (relationship + address)',
    looked?.frontmatter.relationship === 'service' &&
      String(looked?.frontmatter.address ?? '').includes('Ashgrove'),
  );
  check(
    'upsert: a created Person is stamped household (shared entity, owner write)',
    looked?.frontmatter.private_to === 'household',
  );
  const body = pmemory.read_note(created_out.note_path)?.body ?? '';
  check('upsert: body_append landed on the new note', body.includes('skin check in six months'));

  // A FRIEND creating a contact silos it to them (the cordon), not household.
  const friend_ctx = {
    memory: pmemory,
    intent_id: 'smoke-contracts',
    now: new Date('2026-06-22T12:00:00Z'),
    user: { id: 'kim', tier: 'friend' },
  } as unknown as ToolContext;
  await upsert_person_note.execute(
    { identifier: { name: 'Marcus from the climbing gym' }, patch: { relationship: 'friend' } } as never,
    friend_ctx,
  );
  const friend_person = pmemory.find_person({ name: 'Marcus from the climbing gym' });
  check(
    'upsert: a FRIEND-created contact is siloed private_to the friend (cordon holds)',
    friend_person?.frontmatter.private_to === 'kim',
  );

  // A bare {id} that doesn't resolve can't be created (no name to seed) — the
  // one case that stays a clean, actionable error rather than create-or-update.
  let id_threw = false;
  try {
    await upsert_person_note.execute({ identifier: { id: 'p_zzzzzz' }, patch: {} } as never, owner_ctx);
  } catch {
    id_threw = true;
  }
  check('upsert: an unresolved bare {id} throws a clean error (no silent create)', id_threw);

  // ── Kate: propose_action tolerates an omitted rationale (the spiral fix) ──
  // A hard-required `rationale` was the dominant arg-spiral seed: under a heavy
  // deliberation pass the 35B omits it → INPUT_VALIDATION_FAILED → identical
  // retry → same_tool_spiral_exhaust → blank_turn_fallback, killing the whole
  // pass (and Kate's brief). The schema now accepts the omission and derives a
  // rationale in execute(); the rest of the contract stays required.
  const pa = make_propose_action({} as unknown as ProposalsStore);
  const pa_full = {
    action_spec: { summary: 'Route the vet bill to Vivian' },
    rationale: 'You mentioned the vet bill — I want to push it to Vivian.',
    kind: 'action_proposal',
    category_signature: { kind: 'route', category: 'finance' },
  };
  check('propose_action accepts a full call with rationale (baseline)', parses(pa, pa_full));
  const { rationale: _drop, ...pa_no_rationale } = pa_full;
  check(
    'propose_action accepts a call with NO rationale (the arg-spiral fix)',
    parses(pa, pa_no_rationale),
  );
  check(
    'propose_action still requires action_spec + category_signature',
    rejects(pa, { kind: 'action_proposal' }),
  );
  check(
    'effective_rationale derives a non-empty rationale from action_spec when omitted',
    effective_rationale({ action_spec: { summary: 'Route the vet bill' }, kind: 'action_proposal' }) ===
      'Route the vet bill',
  );
  check(
    'effective_rationale falls back to a kind-derived line when action_spec has no text',
    effective_rationale({ action_spec: {}, kind: 'action_proposal' }).startsWith('Proposed action proposal'),
  );
  check(
    'effective_rationale prefers the provided rationale verbatim',
    effective_rationale({ rationale: '  real why  ', action_spec: { summary: 'x' }, kind: 'action_proposal' }) ===
      'real why',
  );

  // ── Kate: flag_beatrice coerces a prose suspected_class (the bigger spiral) ─
  // The model writes a whole sentence into the `suspected_class` enum (37
  // INPUT_VALIDATION_FAILED in 14 days) instead of picking a token. Coerce to
  // the best-matching class rather than rejecting → no spiral.
  const fb_tool = make_flag_beatrice({} as never, {} as never);
  const fb_valid = fb_tool.input_schema.safeParse({
    what_went_wrong: 'Maggie over-prescribes the music tools and burns rounds on duplicates.',
    subject: 'maggie',
    suspected_class: 'persona-gap',
  });
  check('flag_beatrice accepts a valid enum suspected_class (baseline)', fb_valid.success);
  const fb_prose = fb_tool.input_schema.safeParse({
    what_went_wrong:
      'The wake reflection escalate_to_kate payload omits interrupt IDs, so Kate cannot absorb them.',
    subject: 'tool:escalate_to_kate',
    suspected_class:
      'connector/observation handler — the wake reflection payload omits interrupt IDs',
  });
  check(
    'flag_beatrice coerces a prose suspected_class to a valid token (the arg-spiral fix)',
    fb_prose.success &&
      (fb_prose.data as { suspected_class: string }).suspected_class === 'connector-affordance-gap',
  );
  const fb_unknown = fb_tool.input_schema.safeParse({
    what_went_wrong: 'Something felt off about how this landed but I cannot pin the layer.',
    subject: 'kate',
    suspected_class: 'no idea honestly',
  });
  check(
    "flag_beatrice coerces an unclassifiable suspected_class to 'other'",
    fb_unknown.success &&
      (fb_unknown.data as { suspected_class: string }).suspected_class === 'other',
  );
  // The model routinely sends only a free-text flag (no subject, no class) —
  // that must NOT arg-spiral. subject is optional; suspected_class defaults to
  // 'other'; the central alias layer maps flag/body_md/etc → what_went_wrong.
  const fb_minimal = fb_tool.input_schema.safeParse({
    what_went_wrong: 'Maggie over-prescribes the music tools and burns rounds on duplicates.',
  });
  check(
    'flag_beatrice accepts only what_went_wrong (subject + suspected_class now optional)',
    fb_minimal.success &&
      (fb_minimal.data as { suspected_class: string }).suspected_class === 'other' &&
      (fb_minimal.data as { subject?: string }).subject === undefined,
  );

  // ── Kristi: update_sku patches one field without re-supplying the SKU ────
  const kristiTools = create_kristi_facts(deps);
  const recordSku = kristiTools.find((t) => t.name === 'record_sku')!;
  const updateSku = kristiTools.find((t) => t.name === 'update_sku')!;
  check('update_sku is registered', !!updateSku);
  check(
    'update_sku accepts model_id + just form_factor (minimal patch contract)',
    parses(updateSku, { model_id: 'lenovo-thinkstation-pgx', form_factor: 'edge' }),
  );
  check(
    'update_sku accepts a multi-field correction (form_factor + cpu_platform)',
    parses(updateSku, { model_id: 'lenovo-thinkstation-pgx', form_factor: 'edge', cpu_platform: 'grace' }),
  );
  check('update_sku rejects model_id with no field to change (no-op)', rejects(updateSku, { model_id: 'x' }));
  check('update_sku rejects {} (model_id required)', rejects(updateSku, {}));
  // End-to-end: record a misfiled SKU, patch two fields, verify the patch
  // landed AND the untouched fields survived.
  const kristiCtx = { intent_id: 'smoke', specialist_id: 'kristi' } as unknown as ToolContext;
  await recordSku.execute(
    {
      model_id: 'lenovo-thinkstation-pgx',
      vendor: 'lenovo',
      family: 'ThinkStation PGX',
      model_name: 'Lenovo ThinkStation PGX',
      form_factor: 'sff',
      cpu_platform: 'core_ultra',
      status: 'announced',
      source_url: 'https://www.lenovo.com/pgx',
    },
    kristiCtx,
  );
  const upd = (await updateSku.execute(
    { model_id: 'lenovo-thinkstation-pgx', form_factor: 'edge', cpu_platform: 'grace' },
    kristiCtx,
  )) as { ok: boolean; changed: string[] };
  check('update_sku reports the two changed fields', upd.ok && upd.changed.includes('form_factor') && upd.changed.includes('cpu_platform'));
  const patched = getKristiWorkstationsStore().get_sku('lenovo-thinkstation-pgx');
  check('update_sku patched form_factor sff → edge', patched?.form_factor === 'edge');
  check('update_sku patched cpu_platform core_ultra → grace', patched?.cpu_platform === 'grace');
  check(
    'update_sku left untouched fields intact (model_name, vendor)',
    patched?.model_name === 'Lenovo ThinkStation PGX' && patched?.vendor === 'lenovo',
  );

  // ── Registry: central enum-whitespace recovery (covers every enum tool) ─
  const registry = new ToolRegistry();
  const enum_tool: Tool<{ action: 'route' | 'close' }, { ok: boolean }> = {
    name: 'smoke_enum',
    description: 'enum recovery probe',
    risk: 'read',
    required_capabilities: [],
    input_schema: z.object({ action: z.enum(['route', 'close']) }),
    output_schema: z.object({ ok: z.boolean() }),
    idempotency_key: () => 'smoke_enum',
    execute: async () => ({ ok: true }),
  };
  registry.register(enum_tool);
  const granted = new Set<Capability>();
  const ctx = {} as ToolContext;
  const clean = await registry.invoke('smoke_enum', { action: 'route' }, ctx, granted, 'tester');
  check('registry: clean enum value invokes', clean.ok === true);
  const dirty = await registry.invoke('smoke_enum', { action: 'route\n ' }, ctx, granted, 'tester');
  check('registry: whitespace-padded enum value recovered ("route\\n " → "route")', dirty.ok === true);
  const wrong = await registry.invoke('smoke_enum', { action: 'teleport' }, ctx, granted, 'tester');
  check('registry: genuinely invalid enum still rejected (no false recovery)', wrong.ok === false && wrong.reason === 'input');

  // ── Registry: central recovery (Layer 1) — alias / coerce / clamp / strip ─
  // The arg-spiral classes measured in the audit log (2026-06-22), recovered
  // centrally so every tool (and every future tool) is covered.
  const alias_tool: Tool<{ note_path: string }, { ok: boolean }> = {
    name: 'smoke_alias',
    description: 'field-alias probe',
    risk: 'read',
    required_capabilities: [],
    input_schema: z.object({ note_path: z.string() }),
    output_schema: z.object({ ok: z.boolean() }),
    idempotency_key: () => 'smoke_alias',
    execute: async () => ({ ok: true }),
  };
  registry.register(alias_tool);
  const aliased = await registry.invoke('smoke_alias', { path: 'Notes/Sam.md' }, ctx, granted, 'tester');
  check('registry: field-name alias recovered (path → note_path)', aliased.ok === true);
  const no_alias = await registry.invoke('smoke_alias', { totally_unrelated: 'y' }, ctx, granted, 'tester');
  check(
    'registry: a missing field with no known synonym still fails honestly',
    no_alias.ok === false && no_alias.reason === 'input',
  );

  const coerce_tool: Tool<{ example_payload: string }, { ok: boolean }> = {
    name: 'smoke_coerce',
    description: 'object→string probe',
    risk: 'read',
    required_capabilities: [],
    input_schema: z.object({ example_payload: z.string() }),
    output_schema: z.object({ ok: z.boolean() }),
    idempotency_key: () => 'smoke_coerce',
    execute: async () => ({ ok: true }),
  };
  registry.register(coerce_tool);
  const coerced = await registry.invoke(
    'smoke_coerce',
    { example_payload: { a: 1, b: 2 } },
    ctx,
    granted,
    'tester',
  );
  check('registry: object→string coercion recovered (example_payload)', coerced.ok === true);

  const clamp_tool: Tool<{ limit: number }, { got: number }> = {
    name: 'smoke_clamp',
    description: 'number-clamp probe',
    risk: 'read',
    required_capabilities: [],
    input_schema: z.object({ limit: z.number().int().max(20) }),
    output_schema: z.object({ got: z.number() }),
    idempotency_key: () => 'smoke_clamp',
    execute: async (i) => ({ got: i.limit }),
  };
  registry.register(clamp_tool);
  const clamped = await registry.invoke('smoke_clamp', { limit: 50 }, ctx, granted, 'tester');
  check(
    'registry: over-cap number clamped to the schema max (50 → 20)',
    clamped.ok === true && (clamped.result as { got: number }).got === 20,
  );

  const strict_tool: Tool<{ name: string }, { ok: boolean }> = {
    name: 'smoke_strict',
    description: 'unrecognized-key probe',
    risk: 'read',
    required_capabilities: [],
    input_schema: z.object({ name: z.string() }).strict(),
    output_schema: z.object({ ok: z.boolean() }),
    idempotency_key: () => 'smoke_strict',
    execute: async () => ({ ok: true }),
  };
  registry.register(strict_tool);
  const stripped = await registry.invoke(
    'smoke_strict',
    { name: 'x', ws_class: 'junk' },
    ctx,
    granted,
    'tester',
  );
  check('registry: spurious strict-schema key stripped (ws_class)', stripped.ok === true);

  // ── Registry: schema-driven scalar-as-object recovery (the general mechanism) ─
  // THE CLASS: the small model emits a scalar field (string/number/enum/date) as
  // a nested OBJECT or ARRAY. Recovered centrally for EVERY tool, type-aware by
  // the field's leaf schema — the general mechanism that replaced the per-field
  // birthday/relationship carve-out in upsert_person_note. Fixtures echo the
  // recovered value in their output so we assert what was STORED, not just `ok`.
  const enum_obj_tool: Tool<{ rel: 'friend' | 'family' | 'colleague' }, { got: string }> = {
    name: 'smoke_enum_obj',
    description: 'enum-from-object probe',
    risk: 'read',
    required_capabilities: [],
    input_schema: z.object({ rel: z.enum(['friend', 'family', 'colleague']) }),
    output_schema: z.object({ got: z.string() }),
    idempotency_key: () => 'smoke_enum_obj',
    execute: async (i) => ({ got: i.rel }),
  };
  registry.register(enum_obj_tool);
  const eo1 = await registry.invoke('smoke_enum_obj', { rel: { type: 'friend' } }, ctx, granted, 'tester');
  check(
    'registry: enum-from-object {type:"friend"} → "friend"',
    eo1.ok === true && (eo1.result as { got: string }).got === 'friend',
  );
  const eo2 = await registry.invoke('smoke_enum_obj', { rel: ['family'] }, ctx, granted, 'tester');
  check(
    'registry: enum-from-array ["family"] → "family"',
    eo2.ok === true && (eo2.result as { got: string }).got === 'family',
  );
  const eo3 = await registry.invoke('smoke_enum_obj', { rel: { type: 'stranger' } }, ctx, granted, 'tester');
  check(
    'registry: enum-from-object with NO matching option fails honestly',
    eo3.ok === false && eo3.reason === 'input',
  );

  const str_tool: Tool<{ s: string }, { got: string }> = {
    name: 'smoke_scalar',
    description: 'string scalar probe',
    risk: 'read',
    required_capabilities: [],
    input_schema: z.object({ s: z.string() }),
    output_schema: z.object({ got: z.string() }),
    idempotency_key: () => 'smoke_scalar',
    execute: async (i) => ({ got: i.s }),
  };
  registry.register(str_tool);
  const sc1 = await registry.invoke('smoke_scalar', { s: { year: 2026, month: 1, day: 2 } }, ctx, granted, 'tester');
  check(
    'registry: date object {year,month,day} → "2026-01-02" on a string field',
    sc1.ok === true && (sc1.result as { got: string }).got === '2026-01-02',
  );
  const sc2 = await registry.invoke('smoke_scalar', { s: { value: 'hello' } }, ctx, granted, 'tester');
  check(
    'registry: single-scalar {value:"hello"} → "hello" (extracted, not stringified)',
    sc2.ok === true && (sc2.result as { got: string }).got === 'hello',
  );
  const sc3 = await registry.invoke('smoke_scalar', { s: { a: 1, b: 2 } }, ctx, granted, 'tester');
  check(
    'registry: an UNCONSTRAINED (free-text) string stringifies an opaque object dump',
    sc3.ok === true && (sc3.result as { got: string }).got === '{"a":1,"b":2}',
  );

  const num_tool: Tool<{ n: number }, { got: number }> = {
    name: 'smoke_num',
    description: 'number coercion probe',
    risk: 'read',
    required_capabilities: [],
    input_schema: z.object({ n: z.number() }),
    output_schema: z.object({ got: z.number() }),
    idempotency_key: () => 'smoke_num',
    execute: async (i) => ({ got: i.n }),
  };
  registry.register(num_tool);
  const nm1 = await registry.invoke('smoke_num', { n: { value: 42 } }, ctx, granted, 'tester');
  check('registry: number-from-object {value:42} → 42', nm1.ok === true && (nm1.result as { got: number }).got === 42);
  const nm2 = await registry.invoke('smoke_num', { n: '42' }, ctx, granted, 'tester');
  check('registry: number-from-numeric-string "42" → 42', nm2.ok === true && (nm2.result as { got: number }).got === 42);
  const nm3 = await registry.invoke('smoke_num', { n: [7] }, ctx, granted, 'tester');
  check('registry: number-from-array [7] → 7', nm3.ok === true && (nm3.result as { got: number }).got === 7);
  const nm4 = await registry.invoke('smoke_num', { n: { a: 1, b: 2 } }, ctx, granted, 'tester');
  check('registry: ambiguous multi-number object fails honestly', nm4.ok === false && nm4.reason === 'input');

  // THE LOAD-BEARING INVARIANT — a STRUCTURED (format-constrained) string is
  // NEVER blind-stringified into garbage. A date-shaped object assembles; an
  // unassemblable one fails honestly so birthday never persists as '{"year":1994}'.
  const dob_tool: Tool<{ dob: string }, { got: string }> = {
    name: 'smoke_dob',
    description: 'constrained-string invariant probe',
    risk: 'read',
    required_capabilities: [],
    input_schema: z.object({ dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    output_schema: z.object({ got: z.string() }),
    idempotency_key: () => 'smoke_dob',
    execute: async (i) => ({ got: i.dob }),
  };
  registry.register(dob_tool);
  const db1 = await registry.invoke('smoke_dob', { dob: { year: 1994, month: 4, day: 16 } }, ctx, granted, 'tester');
  check(
    'registry: a CONSTRAINED date field still assembles {y,m,d} → "1994-04-16"',
    db1.ok === true && (db1.result as { got: string }).got === '1994-04-16',
  );
  const db2 = await registry.invoke('smoke_dob', { dob: { year: 1994 } }, ctx, granted, 'tester');
  check(
    'INVARIANT: an unassemblable object on a structured field fails honestly (NO garbage stored)',
    db2.ok === false && db2.reason === 'input',
  );
  const db3 = await registry.invoke('smoke_dob', { dob: { foo: 'bar' } }, ctx, granted, 'tester');
  check(
    'INVARIANT: a structured field is NOT blind-stringified ({foo:"bar"} → honest fail, not a stored \'{"foo":"bar"}\')',
    db3.ok === false && db3.reason === 'input',
  );

  // ── Registry: schema lint (Layer 3 — the born-aligned gate) ─────────────
  const pattern_tool: Tool<{ order_id: string }, { ok: boolean }> = {
    name: 'smoke_pattern',
    description: 'regex-pattern lint probe',
    risk: 'read',
    required_capabilities: [],
    input_schema: z.object({ order_id: z.string().regex(/^[A-Z]\d{5}$/) }),
    output_schema: z.object({ ok: z.boolean() }),
    idempotency_key: () => 'smoke_pattern',
    execute: async () => ({ ok: true }),
  };
  registry.register(pattern_tool);
  const lint = registry.lint();
  const pat = lint.find((w) => w.tool === 'smoke_pattern');
  check(
    'lint flags a regex `pattern` field (the GBNF silent-fail-open trap)',
    !!pat && pat.warnings.some((w) => /pattern|GBNF/.test(w)),
  );
  check(
    'lint leaves a clean tool unflagged (smoke_enum: enum, no pattern, 1 required)',
    !lint.some((w) => w.tool === 'smoke_enum'),
  );

  // coerce_patch — the model objectifies scalar person-fields (the live
  // 2026-06-22 Ceci spiral: birthday sent as {year,month,day} → "Expected
  // string, received object" → DUPLICATE_TOOL_CALL, 4 turns). Coerce, don't
  // reject, mirroring body_append/address. Integrated into the tool's existing
  // container-coercing coerce_patch (tool-internal validation, below the registry).
  check(
    'coerce_patch: birthday {year,month,day} → YYYY-MM-DD',
    coerce_patch({ birthday: { year: 1994, month: 4, day: 16 } }).birthday === '1994-04-16',
  );
  check(
    'coerce_patch: birthday {date:"..."} → that string',
    coerce_patch({ birthday: { date: '1994-04-16' } }).birthday === '1994-04-16',
  );
  check(
    'coerce_patch: birthday {month,day} (no year) → MM-DD',
    coerce_patch({ birthday: { month: 4, day: 16 } }).birthday === '04-16',
  );
  check(
    'coerce_patch: relationship {type:"friend"} → "friend"',
    coerce_patch({ relationship: { type: 'friend' } }).relationship === 'friend',
  );
  check(
    'coerce_patch: a plain string birthday is untouched',
    coerce_patch({ birthday: '1994-04-16' }).birthday === '1994-04-16',
  );
  check(
    'coerce_patch: still parses a stringified patch container (back-compat)',
    coerce_patch("{name: 'Ceci'}").name === 'Ceci',
  );
  check(
    'coerce_patch: an unrecognizable birthday object falls through (honest error preserved)',
    typeof coerce_patch({ birthday: { foo: 'bar' } }).birthday === 'object',
  );

  // ── Shared primitive: the same mechanism on a NON-person schema ─────────────
  // Proves it's general (not person-specific) and is the drop-in wrapper for any
  // tool-INTERNAL safeParse site (upsert_person_note's coerce_patch is the live
  // one; record_*/place writers validate at the registry boundary above).
  const SyntheticSchema = z.object({
    rel: z.enum(['friend', 'family']),
    born: z.string().regex(/^(\d{4}-)?\d{2}-\d{2}$/),
    n: z.number(),
  });
  const good = safe_parse_with_recovery(SyntheticSchema, {
    rel: { type: 'friend' },
    born: { year: 1994, month: 4, day: 16 },
    n: { value: 7 },
  });
  check(
    'safe_parse_with_recovery: enum + date + number objects all recovered in one pass',
    good.parsed.success &&
      good.parsed.data.rel === 'friend' &&
      good.parsed.data.born === '1994-04-16' &&
      good.parsed.data.n === 7 &&
      good.changes.length === 3,
  );
  const bad = safe_parse_with_recovery(SyntheticSchema, {
    rel: { type: 'stranger' }, // matches no enum option → unrecoverable
    born: { year: 1994, month: 4, day: 16 },
    n: 7,
  });
  check(
    'safe_parse_with_recovery: an unrecoverable field returns the ORIGINAL honest error (no partial/garbage data)',
    bad.parsed.success === false && bad.changes.length === 0,
  );
  const noop = recover_scalar_shapes(SyntheticSchema, { rel: 'friend', born: '04-16', n: 3 });
  check(
    'recover_scalar_shapes: a fully-valid value is untouched (no false recovery)',
    noop.changes.length === 0,
  );
  // A non-scalar target (array / tuple) is NEVER mined for a scalar — a
  // date-shaped object on an array field must fail honestly, not silently become
  // a date string (coords / anniversaries class).
  const ArrSchema = z.object({
    tags: z.array(z.string()),
    pt: z.tuple([z.number(), z.number()]),
  });
  const arr = safe_parse_with_recovery(ArrSchema, {
    tags: { date: '2020-06-01', what: 'wedding' },
    pt: { lat: 1, lon: 2 },
  });
  check(
    'safe_parse_with_recovery: array/tuple fields are not scalar targets (no date/scalar mined → honest fail)',
    arr.parsed.success === false && arr.changes.length === 0,
  );
} finally {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} contract assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nAll tool-contract assertions passed.');
