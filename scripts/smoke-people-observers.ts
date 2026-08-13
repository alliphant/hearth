/**
 * smoke:people-observers — the People observational engine (A+D, 2026-06-22).
 *
 * Self-contained: a temp on-disk SQLite, a REAL PersonObservations store, the
 * REAL PersonObserverDriver over a stub AppEventBus + a fake people source. No
 * orchestrator, no LLM. Exercises:
 *   - the store: idempotent record, cordoned reads, dismiss, by_person
 *   - the driver: message_added → mention (name-match, debounce, cordon,
 *     self/genealogy excluded), capture_routed → capture (+ correlation,
 *     triage-skip, cache-miss-skip), and the HEARTH_PERSON_OBSERVERS kill switch
 *
 *   bun run smoke:people-observers
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { AppEventBus, AppEvent } from '@app/events';
import type { MemoryClient, PersonRow } from '@memory/client';
import type { Caller } from '@memory/private_to';
import { PersonObservations } from '@memory/stores/person_observations';
import { PersonObserverDriver, mention_snippet } from '@core/person_observers';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); }
}

const OWNER: Caller = { user_id: 'jasper', tier: 'owner' };
const LEE: Caller = { user_id: 'kim', tier: 'friend' };

function person(id: string, name: string, relationship: string, private_to: string, preferred_name: string | null = null): PersonRow {
  const fm = { type: 'person', id, name, relationship, private_to };
  return {
    id, name, preferred_name, relationship,
    birthday: null, contact_cadence: null, last_contacted: null,
    note_path: `People/${name.replace(/\s+/g, '-')}.md`,
    frontmatter_json: JSON.stringify(fm), mtime: '2026-06-22T00:00:00Z',
  } as unknown as PersonRow;
}

// Seeded people: Dana + Sam are household (owner sees), Kim is siloed to 'kim'
// (owner does NOT see), Owner's own 'self' note must never self-observe.
const PEOPLE: PersonRow[] = [
  person('p_becca1', 'Dana', 'friend', 'household'),
  person('p_sara01', 'Sam', 'family', 'household'),
  person('p_lee001', 'Kim', 'friend', 'kim'),
  person('p_self01', 'Jasper', 'self', 'household'),
];

function main(): void {
  process.env.HEARTH_PERSON_OBSERVERS = '1';
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-people-obs-'));
  const db = new Database(join(tmp, 't.db'));
  const store = new PersonObservations(db);

  // ── 1. store: record / idempotency / read ────────────────────────────────
  console.log('\n1. store record + idempotency');
  const a = store.record({ person_id: 'p_becca1', user_id: 'jasper', kind: 'mention', summary: 'mentioned in conversation', source_type: 'chat', source_ref: 'c1', private_to: 'household' });
  check('first record is_new', a.is_new);
  const b = store.record({ person_id: 'p_becca1', user_id: 'jasper', kind: 'mention', summary: 'mentioned again', source_type: 'chat', source_ref: 'c1', private_to: 'household' });
  check('same (person+source+ref+kind) → not new (idempotent)', !b.is_new && b.id === a.id);
  check('owner sees 1 obs for Dana', store.list_for_person('p_becca1', OWNER).length === 1);
  check('idempotent update refreshed summary', store.list_for_person('p_becca1', OWNER)[0]?.summary === 'mentioned again');
  store.record({ person_id: 'p_becca1', user_id: 'jasper', kind: 'capture', summary: 'photo', source_type: 'capture', source_ref: 'cap1', private_to: 'household' });
  check('different kind/source → a 2nd obs', store.list_for_person('p_becca1', OWNER).length === 2);

  // ── 2. cordon ─────────────────────────────────────────────────────────────
  console.log('\n2. cordon (owner has no god-view)');
  store.record({ person_id: 'p_lee001', user_id: 'kim', kind: 'mention', summary: 'kim-private', source_type: 'chat', source_ref: 'cl', private_to: 'kim' });
  check('owner cannot see a kim-siloed obs', store.list_for_person('p_lee001', OWNER).length === 0);
  check('kim sees his own obs', store.list_for_person('p_lee001', LEE).length === 1);

  // ── 3. dismiss ────────────────────────────────────────────────────────────
  console.log('\n3. dismiss (the D trust action)');
  const becca = store.list_for_person('p_becca1', OWNER);
  check('dismiss returns true', store.dismiss(becca[0]!.id, OWNER));
  check('dismissed obs drops from default list', store.list_for_person('p_becca1', OWNER).length === 1);
  check('include_dismissed still shows it', store.list_for_person('p_becca1', OWNER, { include_dismissed: true }).length === 2);
  check('cross-user dismiss refused', !store.dismiss(store.list_for_person('p_lee001', LEE)[0]!.id, OWNER));

  // ── 4. driver: mention observer ───────────────────────────────────────────
  console.log('\n4. driver — message_added → mention');
  let now_ms = Date.parse('2026-06-22T18:00:00Z');
  const listeners: Array<(e: AppEvent) => void> = [];
  const bus = { subscribe: (fn: (e: AppEvent) => void) => { listeners.push(fn); return () => {}; } } as unknown as AppEventBus;
  const emit = (e: AppEvent): void => listeners.forEach((fn) => fn(e));
  const memory = { query_people: () => PEOPLE } as unknown as Pick<MemoryClient, 'query_people'>;
  const store2 = new PersonObservations(new Database(join(tmp, 't2.db')));
  const driver = new PersonObserverDriver({
    observations: store2,
    memory,
    conversation_owner: (id) => (id === 'cJ' ? 'jasper' : id === 'cL' ? 'kim' : null),
    tier_for: (uid) => (uid === 'jasper' ? 'owner' : 'friend'),
    now: () => new Date(now_ms),
  });
  driver.attach(bus);

  emit({ type: 'message_added', conversation_id: 'cJ', message_id: 'm1', role: 'user', content_preview: 'had coffee with Dana and talked about Sam' } as AppEvent);
  check('mention → obs for Dana', store2.list_for_person('p_becca1', OWNER).length === 1);
  check('mention → obs for Sam (2 people in one message)', store2.list_for_person('p_sara01', OWNER).length === 1);
  check('mention source is chat', store2.list_for_person('p_becca1', OWNER)[0]?.source_type === 'chat');
  const becca_ts0 = store2.list_for_person('p_becca1', OWNER)[0]!.observed_at;

  // A mention must CARRY something: the summary is the (capped) sentence the name
  // appeared in, and a name with no context records nothing at all. Before this,
  // every hit wrote the literal "mentioned in conversation" — 40% of the live
  // observation table, contentless, and pure noise in the synthesis prompt.
  check('mention summary quotes the sentence, not a contentless placeholder', /Came up in conversation: "had coffee with Dana and talked about Sam"/.test(store2.list_for_person('p_becca1', OWNER)[0]!.summary));
  check('mention is cordoned to the SPEAKER (it quotes their words)', store2.list_for_person('p_becca1', OWNER)[0]!.private_to === 'jasper');

  // A mention is idempotent PER CONVERSATION (one row, time-refreshed) — not a
  // row per message. Debounce skips the refresh churn.
  emit({ type: 'message_added', conversation_id: 'cJ', message_id: 'm2', role: 'user', content_preview: 'Dana again right away, we should really call her back soon' } as AppEvent);
  check('debounced within window → still 1 row, ts NOT refreshed', store2.list_for_person('p_becca1', OWNER).length === 1 && store2.list_for_person('p_becca1', OWNER)[0]!.observed_at === becca_ts0);
  now_ms += 31 * 60_000; // past the 30-min debounce
  emit({ type: 'message_added', conversation_id: 'cJ', message_id: 'm3', role: 'user', content_preview: 'Dana is moving to Denver in the fall for the new job' } as AppEvent);
  check('after debounce window → still 1 row (idempotent per conv), ts refreshed', store2.list_for_person('p_becca1', OWNER).length === 1 && store2.list_for_person('p_becca1', OWNER)[0]!.observed_at > becca_ts0);
  check('the refreshed row carries the NEW sentence', /moving to Denver/.test(store2.list_for_person('p_becca1', OWNER)[0]!.summary));

  // The noise gate: a bare name with no context is not a signal.
  const thin_db = new PersonObservations(new Database(join(tmp, 't2b.db')));
  const thin_driver = new PersonObserverDriver({ observations: thin_db, memory, conversation_owner: () => 'jasper', tier_for: () => 'owner', now: () => new Date(now_ms) });
  const thin_bus_listeners: Array<(e: AppEvent) => void> = [];
  thin_driver.attach({ subscribe: (fn: (e: AppEvent) => void) => { thin_bus_listeners.push(fn); return () => {}; } } as unknown as AppEventBus);
  thin_bus_listeners.forEach((fn) => fn({ type: 'message_added', conversation_id: 'cT', message_id: 'mt', role: 'user', content_preview: 'Dana?' } as AppEvent));
  check('NOISE GATE: a contentless mention records NOTHING', thin_db.list_for_person('p_becca1', OWNER).length === 0);
  thin_bus_listeners.forEach((fn) => fn({ type: 'message_added', conversation_id: 'cT2', message_id: 'mt2', role: 'user', content_preview: 'Dana just got promoted to lead the whole platform team' } as AppEvent));
  check('NOISE GATE: a substantive mention still lands', thin_db.list_for_person('p_becca1', OWNER).length === 1);

  // The snippet is the name's own sentence, capped — a derived signal, not the message.
  const becca_re = /\bDana\b/i;
  check('snippet picks the sentence containing the name', mention_snippet('Totally unrelated opener here. Dana is starting her residency in June.', becca_re) === 'Dana is starting her residency in June.');
  check('snippet returns null when nothing substantive surrounds the name', mention_snippet('ok. Dana?', becca_re) === null);
  check('snippet is capped and ellipsized', (mention_snippet(`Dana ${'x'.repeat(400)}`, becca_re) ?? '').length <= 200);
  check('snippet collapses whitespace', mention_snippet('Dana   said\n\nshe would bring the whole crew along', becca_re) === 'Dana said she would bring the whole crew along');

  check('owner does NOT observe kim-siloed person (cordon on match set)', store2.list_for_person('p_lee001', OWNER).length === 0 && store2.list_for_person('p_lee001', LEE).length === 0);
  emit({ type: 'message_added', conversation_id: 'cJ', message_id: 'm4', role: 'user', content_preview: 'I (Jasper) went for a run' } as AppEvent);
  check('self note never self-observes', store2.list_for_person('p_self01', OWNER).length === 0);
  const becca_n = store2.list_for_person('p_becca1', OWNER).length;
  emit({ type: 'message_added', conversation_id: 'cUnknown', message_id: 'm5', role: 'user', content_preview: 'coffee with Dana' } as AppEvent);
  check('unattributable conversation → no observation', store2.list_for_person('p_becca1', OWNER).length === becca_n);
  const sara_n = store2.list_for_person('p_sara01', OWNER).length;
  emit({ type: 'message_added', conversation_id: 'cJ', message_id: 'm6', role: 'specialist', content_preview: 'Sam is great' } as AppEvent);
  check('specialist message → not observed (user role only)', store2.list_for_person('p_sara01', OWNER).length === sara_n);

  // ── 5. driver: capture observer ───────────────────────────────────────────
  console.log('\n5. driver — capture_routed → capture');
  const routed = (capture_id: string, specialist_ids: string[], route_reason: string): AppEvent =>
    ({ type: 'capture_routed', capture_id, specialist_ids, confidence: 0.9, route_reason, clustered_with: [] } as AppEvent);
  emit({ type: 'capture_received', capture_id: 'cap_x', user_id: 'jasper' } as AppEvent);
  emit(routed('cap_x', ['anya'], 'vet bill for Dana'));
  check('routed capture naming Dana → capture obs', store2.list_for_person('p_becca1', OWNER).some((o) => o.source_type === 'capture'));
  emit({ type: 'capture_received', capture_id: 'cap_t', user_id: 'jasper' } as AppEvent);
  emit(routed('cap_t', [], 'about Sam'));
  check('triage capture (no specialist) → skipped', store2.list_for_person('p_sara01', OWNER).every((o) => o.source_type !== 'capture'));
  emit(routed('cap_missing', ['anya'], 'Sam photo'));
  check('capture with no prior capture_received (cache miss) → skipped', store2.list_for_person('p_sara01', OWNER).every((o) => o.source_type !== 'capture'));

  // ── 6. kill switch ────────────────────────────────────────────────────────
  console.log('\n6. kill switch (HEARTH_PERSON_OBSERVERS=0)');
  process.env.HEARTH_PERSON_OBSERVERS = '0';
  const sara_before = store2.list_for_person('p_sara01', OWNER).length;
  now_ms += 60 * 60_000;
  emit({ type: 'message_added', conversation_id: 'cJ', message_id: 'm9', role: 'user', content_preview: 'dinner with Sam' } as AppEvent);
  check('flag off → no new observation', store2.list_for_person('p_sara01', OWNER).length === sara_before);

  db.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? '✓' : '✗'} people-observers: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
