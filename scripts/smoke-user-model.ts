/**
 * smoke:user-model — the unified per-user model substrate (src/core/user_model.ts).
 *
 * Self-contained: temp db, mock LLM, no network. Exercises:
 *   - gate dark by default (HEARTH_USER_MODEL).
 *   - record_observation: stub-create, append, cap/rotate.
 *   - synthesize_facet (observations source): first-pass distill, below-threshold
 *     SKIP, threshold-cross re-distill, fail-open (llm error / empty / no signal).
 *   - synthesize_facet (messages source): style distill + dual-write to the legacy
 *     detail.style_profile (live house-voice path).
 *   - resolve_user_model: universal + domain-scoped, empty-summary excluded,
 *     CORDON (another user sees nothing), stale flag.
 *   - run_user_model_sweep: gate dark → [], walks users×facets, isolates a
 *     per-facet failure (one throw never aborts the sweep).
 *   - UserModelObserverDriver: capture_received+routed → interests obs (cordoned
 *     to the capturing user, triage/cache-miss → none), message_added(user) →
 *     debounced routines obs, role/gate guards.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { UserProfileStore } from '../src/memory/stores/user_profile';
import {
  user_model_enabled,
  record_observation,
  synthesize_facet,
  resolve_user_model,
  run_user_model_sweep,
  type ModelDeps,
} from '../src/core/user_model';
import { UserModelObserverDriver } from '../src/core/user_model_observers';
import { AppEventBus } from '../src/app/events';
import type { StyleLLM, StyleMessage } from '../src/core/user_style';

let pass = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  pass++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-um-'));
const prev = process.env.HEARTH_USER_MODEL;
const NOW = new Date('2026-06-19T12:00:00Z');

let llm_mode: 'ok' | 'throw' | 'empty' = 'ok';
let llm_calls = 0;
const llm: StyleLLM = {
  for_role() {
    return {
      defaults: { temperature: 0.4 },
      provider: {
        async complete() {
          llm_calls++;
          if (llm_mode === 'throw') throw new Error('boom');
          if (llm_mode === 'empty') return { content: '   ', cost: { model: 'mock' } };
          return { content: 'DISTILLED SUMMARY', cost: { model: 'mock' } };
        },
      },
    };
  },
};

try {
  const db = open_db(join(dir, 'hearth.db'));
  const store = new UserProfileStore(db);
  let msgs: StyleMessage[] = [];
  const deps: ModelDeps = {
    facets: store,
    llm,
    recent_user_messages: (_uid, since, max) => msgs.filter((m) => m.ts >= since).slice(0, max),
  };

  // 1. gate
  delete process.env.HEARTH_USER_MODEL;
  assert(user_model_enabled() === false, 'gate: dark by default');
  process.env.HEARTH_USER_MODEL = '1';
  assert(user_model_enabled() === true, 'gate: =1 on');

  // 2. record_observation — stub create + cap
  record_observation(store, 'jasper', 'interests', 'keeps tinkering with home automation', NOW);
  const f0 = store.get_facet('jasper', 'interests');
  assert(f0 !== null && f0!.observations?.length === 1, 'obs: recorded');
  assert(f0!.summary === '', 'obs: stub summary empty until synthesized');
  for (let i = 0; i < 70; i++) record_observation(store, 'jasper', 'interests', `obs ${i}`, NOW);
  assert((store.get_facet('jasper', 'interests')!.observations?.length ?? 99) <= 60, 'obs: capped at 60');

  // 3. synthesize interests (observations) — fires (no prior summary)
  llm_mode = 'ok';
  llm_calls = 0;
  const r1 = await synthesize_facet('jasper', 'interests', deps, { now: NOW });
  assert(r1.updated === true, 'synth: interests distilled');
  assert(store.get_facet('jasper', 'interests')!.summary === 'DISTILLED SUMMARY', 'synth: summary set');
  assert(llm_calls === 1, 'synth: one llm call');

  // 4. below-threshold SKIP (no new obs since refresh)
  const r2 = await synthesize_facet('jasper', 'interests', deps, { now: NOW });
  assert(r2.updated === false && r2.reason === 'below_threshold', 'gate: below threshold skips (no LLM)');

  // 5. cross threshold → re-distill
  for (let i = 0; i < 30; i++)
    record_observation(store, 'jasper', 'interests', `fresh ${i}`, new Date('2026-06-20T00:00:00Z'));
  const r3 = await synthesize_facet('jasper', 'interests', deps, { now: new Date('2026-06-20T12:00:00Z') });
  assert(r3.updated === true, 'gate: re-distills after enough new obs');

  // 6. style (messages source) + dual-write to legacy style_profile
  msgs = Array.from({ length: 40 }, (_, i) => ({ ts: '2026-06-18T10:00:00Z', content_md: `msg ${i} some real text` }));
  const rs = await synthesize_facet('jasper', 'style', deps, { now: NOW });
  assert(rs.updated === true, 'synth: style distilled from messages');
  assert(store.get_facet('jasper', 'style')!.summary === 'DISTILLED SUMMARY', 'synth: style facet set');
  assert(store.get('jasper')!.detail['style_profile'] === 'DISTILLED SUMMARY', 'synth: style DUAL-WRITTEN to legacy style_profile');

  // 7. fail-open
  llm_mode = 'throw';
  record_observation(store, 'failu', 'interests', 'one interest', NOW);
  const re = await synthesize_facet('failu', 'interests', deps, { now: NOW });
  assert(re.updated === false && re.reason === 'llm_error', 'fail-open: llm error');
  assert(store.get_facet('failu', 'interests')!.summary === '', 'fail-open: no summary on error');
  llm_mode = 'empty';
  record_observation(store, 'emptyu', 'interests', 'one interest', NOW);
  const rem = await synthesize_facet('emptyu', 'interests', deps, { now: NOW });
  assert(rem.updated === false && rem.reason === 'empty', 'fail-open: empty distill');
  llm_mode = 'ok';
  const rn = await synthesize_facet('ghost', 'interests', deps, { now: NOW });
  assert(rn.updated === false && rn.reason === 'no_signal', 'fail-open: no signal');

  // 8. resolve_user_model — universal + domain-scoped, cordon, stale
  const rk = resolve_user_model(store, 'jasper', 'kate', NOW);
  const kkeys = rk.facets.map((f) => f.key);
  assert(kkeys.includes('style'), 'resolve: universal style present');
  assert(kkeys.includes('interests'), 'resolve: kate domain interests present');
  assert(!kkeys.includes('routines'), 'resolve: routines excluded (no summary)');
  const ri = resolve_user_model(store, 'jasper', 'iris', NOW);
  const ikeys = ri.facets.map((f) => f.key);
  assert(ikeys.includes('style') && !ikeys.includes('interests'), 'resolve: iris is domain-scoped (style, not interests)');
  const rother = resolve_user_model(store, 'sam', 'kate', NOW);
  assert(rother.facets.length === 0, 'resolve: CORDON — sam sees none of jasper\'s facets');
  store.set_facet('staleu', 'style', { summary: 'old', confidence: 'low', last_refreshed: '2026-01-01T00:00:00Z' });
  const rstale = resolve_user_model(store, 'staleu', 'kate', NOW);
  assert(rstale.facets.find((f) => f.key === 'style')?.stale === true, 'resolve: stale flag on old facet');

  // 9. run_user_model_sweep — gate, walk, isolate failures
  llm_mode = 'ok';
  delete process.env.HEARTH_USER_MODEL;
  const sw_off = await run_user_model_sweep(['jasper'], deps, { now: NOW });
  assert(sw_off.length === 0, 'sweep: dark by default → no-op []');
  process.env.HEARTH_USER_MODEL = '1';
  // seed two users with enough fresh interests obs to cross threshold
  for (const uid of ['sweep1', 'sweep2'])
    for (let i = 0; i < 30; i++) record_observation(store, uid, 'interests', `${uid} obs ${i}`, NOW);
  const sw = await run_user_model_sweep(['sweep1', 'sweep2'], deps, { now: NOW });
  const interests_updated = sw.filter((r) => r.facet === 'interests' && r.updated).map((r) => r.user_id);
  assert(interests_updated.includes('sweep1') && interests_updated.includes('sweep2'), 'sweep: both users\' interests refreshed');
  assert(sw.some((r) => r.facet === 'routines' && !r.updated), 'sweep: a facet with no signal is skipped, not synthesized');
  // isolation: a throwing LLM yields llm_error reasons, never aborts the sweep
  llm_mode = 'throw';
  for (let i = 0; i < 30; i++) record_observation(store, 'sweepfail', 'interests', `x ${i}`, NOW);
  const swf = await run_user_model_sweep(['sweepfail'], deps, { now: NOW });
  assert(swf.length > 0 && swf.every((r) => r.updated === false), 'sweep: per-facet failure isolated (no throw, no update)');
  assert(swf.some((r) => r.facet === 'interests' && r.reason === 'llm_error'), 'sweep: failure surfaces llm_error reason');
  llm_mode = 'ok';

  // 10. UserModelObserverDriver — afferent feed off the AppEventBus
  let clock = new Date('2026-06-19T20:00:00Z');
  const bus = new AppEventBus();
  const obs_driver = new UserModelObserverDriver({
    facets: store,
    conversation_owner: (id) => (id === 'conv-routu' ? 'routu' : id === 'conv-none' ? null : null),
    timezone_for: () => 'America/Denver',
    now: () => clock,
  });
  obs_driver.attach(bus);

  // interests: capture_received caches the user, capture_routed records the obs
  bus.emit({ type: 'capture_received', capture_id: 'cap1', user_id: 'capu', kind: 'photo', note_path: 'n', attachment_path: null, captured_at: clock.toISOString() });
  bus.emit({ type: 'capture_routed', capture_id: 'cap1', specialist_ids: ['maggie'], confidence: 0.9, route_reason: 'a concert poster', clustered_with: [] });
  const ci = store.get_facet('capu', 'interests');
  assert((ci?.observations?.length ?? 0) === 1, 'observer: capture_routed → one interest obs for the capturing user');
  assert((ci?.observations?.[0]?.text ?? '').includes('maggie'), 'observer: interest obs carries the routed domain');
  assert(store.get_facet('other', 'interests') === null, 'observer: CORDON — interest landed only on the capturing user');

  // triage (no specialist) records nothing
  bus.emit({ type: 'capture_received', capture_id: 'cap2', user_id: 'capu2', kind: 'photo', note_path: 'n', attachment_path: null, captured_at: clock.toISOString() });
  bus.emit({ type: 'capture_routed', capture_id: 'cap2', specialist_ids: [], confidence: 0, route_reason: 'triage', clustered_with: [] });
  assert(store.get_facet('capu2', 'interests') === null, 'observer: triage capture (no specialist) records no interest');

  // cache miss (routed before received in this process) records nothing
  bus.emit({ type: 'capture_routed', capture_id: 'ghostcap', specialist_ids: ['vivian'], confidence: 0.9, route_reason: 'r', clustered_with: [] });
  assert(store.get_facet('vivian', 'interests') === null, 'observer: unattributable capture (cache miss) records nothing');

  // routines: a user message records one debounced obs; a same-window repeat doesn't
  bus.emit({ type: 'message_added', conversation_id: 'conv-routu', message_id: 'm1', role: 'user', content_preview: 'hi' });
  const r_after1 = store.get_facet('routu', 'routines')?.observations?.length ?? 0;
  assert(r_after1 === 1, 'observer: user message → one routines obs');
  assert((store.get_facet('routu', 'routines')?.observations?.[0]?.text ?? '').startsWith('active '), 'observer: routines obs is a derived activity stamp');
  bus.emit({ type: 'message_added', conversation_id: 'conv-routu', message_id: 'm2', role: 'user', content_preview: 'still here' });
  assert((store.get_facet('routu', 'routines')?.observations?.length ?? 0) === 1, 'observer: a same-window repeat is debounced (no 2nd obs)');
  // past the debounce window → a new obs
  clock = new Date('2026-06-19T21:00:00Z');
  bus.emit({ type: 'message_added', conversation_id: 'conv-routu', message_id: 'm3', role: 'user', content_preview: 'back' });
  assert((store.get_facet('routu', 'routines')?.observations?.length ?? 0) === 2, 'observer: past the debounce window a new routines obs is recorded');

  // a specialist-role message records nothing; an unattributable conversation records nothing
  bus.emit({ type: 'message_added', conversation_id: 'conv-routu', message_id: 'm4', role: 'specialist', specialist_id: 'kate', content_preview: 'hello' });
  assert((store.get_facet('routu', 'routines')?.observations?.length ?? 0) === 2, 'observer: a specialist-role message records no routine');
  bus.emit({ type: 'message_added', conversation_id: 'conv-none', message_id: 'm5', role: 'user', content_preview: 'who am i' });
  assert(store.get_facet('null', 'routines') === null, 'observer: unattributable conversation records nothing');

  // gate dark → a pure no-op
  delete process.env.HEARTH_USER_MODEL;
  bus.emit({ type: 'capture_received', capture_id: 'cap9', user_id: 'darku', kind: 'photo', note_path: 'n', attachment_path: null, captured_at: clock.toISOString() });
  bus.emit({ type: 'capture_routed', capture_id: 'cap9', specialist_ids: ['maggie'], confidence: 0.9, route_reason: 'r', clustered_with: [] });
  assert(store.get_facet('darku', 'interests') === null, 'observer: DARK by default → no observations recorded');
  process.env.HEARTH_USER_MODEL = '1';

  db.close();
  console.log(`\n✅ smoke:user-model — ${pass} checks passed`);
} catch (e) {
  console.error(`\n❌ smoke:user-model FAILED after ${pass} checks`);
  console.error(e);
  process.exitCode = 1;
} finally {
  if (prev === undefined) delete process.env.HEARTH_USER_MODEL;
  else process.env.HEARTH_USER_MODEL = prev;
  rmSync(dir, { recursive: true, force: true });
}
