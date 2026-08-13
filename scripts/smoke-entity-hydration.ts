/**
 * smoke:entity-hydration — model-driven person lookup (2026-06-22).
 *
 * The fix for the "Kim's flights" bug: who_is is the ONE tool the model calls for
 * any question about a person — it smart-resolves the name ("Kim" → "Kim Reyes")
 * and returns the full dossier INCLUDING tracked flights, so no literal flight tool
 * / flight number is needed. Self-contained (temp vault + db, real MemoryClient).
 *
 *   bun run smoke:entity-hydration
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient, type PersonRow } from '@memory/client';
import { rebuild } from '@ingestor/rebuild';
import type { ToolContext } from '@core/tool';
import type { LLMRouter } from '@core/llm';
import { TrackedFlightsStore } from '@memory/stores/flights';
import { PersonObservations } from '@memory/stores/person_observations';
import { create as create_flight_tools } from '@connectors/flights';
import { resolve_mentioned_people, resolve_person_for_write } from '@core/entity_hydration';
import { who_is } from '../src/specialists/kate/tools/who_is';
import { record_person_pref } from '../src/specialists/kate/tools/record_person_pref';
import { delete_person } from '../src/specialists/kate/tools/delete_person';
import { coerce_address } from '../src/agents/scribe/tools/_person_record';
import { upsert_person_note } from '../src/agents/scribe/tools/upsert_person_note';
import { recover_scalar_shapes } from '@core/scalar_recovery';
import { z as zod } from 'zod';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); }
}

function prow(id: string, name: string, relationship: string): PersonRow {
  return {
    id, name, preferred_name: null, relationship,
    birthday: null, contact_cadence: null, last_contacted: null,
    note_path: `People/${name}.md`,
    frontmatter_json: JSON.stringify({ type: 'person', id, name, relationship }),
    mtime: '2026-06-22T00:00:00Z', friday_managed: false,
  } as unknown as PersonRow;
}

async function main(): Promise<void> {
  // ── 1. resolve_mentioned_people (the SMART resolver) ──────────────────────
  console.log('\n1. resolve_mentioned_people (smart, generous, no skip-on-ambiguity)');
  const kim = prow('p_lee001', 'Kim Reyes', 'friend');
  const adeline = prow('p_adel01', 'Adeline Kim', 'acquaintance'); // "Kim" = LAST name
  const sam = prow('p_sara01', 'Sam Reed', 'family');
  const base = [kim, adeline, sam];
  check('THE BUG: bare "Kim" resolves Kim Reyes (first name)', resolve_mentioned_people('Kim', base, 4)[0]?.id === 'p_lee001');
  check('case-insensitive "kim" resolves', resolve_mentioned_people('kim', base, 4).some((p) => p.id === 'p_lee001'));
  check('last-name-only NOT matched (Adeline Kim excluded)', !resolve_mentioned_people('Kim', base, 4).some((p) => p.id === 'p_adel01'));
  const lee2 = prow('p_lee002', 'Kim Carver', 'acquaintance');
  check('ambiguous first name → BOTH (never skip)', resolve_mentioned_people('Kim', [kim, lee2], 2).length === 2);
  check('salience ranks friend over acquaintance', resolve_mentioned_people('Kim', [kim, lee2], 1)[0]?.id === 'p_lee001');
  check('no name → empty', resolve_mentioned_people('what is the weather', base, 4).length === 0);

  // ── 2. who_is end-to-end (model-driven; the dossier incl. the flight) ──────
  console.log('\n2. who_is — smart resolve + full dossier (incl. the flight that was missing)');
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-whois-'));
  const vault = join(tmp, 'vault');
  mkdirSync(join(vault, 'People'), { recursive: true });
  writeFileSync(
    join(vault, 'People', 'Kim Reyes.md'),
    `---\ntype: person\nid: p_lee001\nname: Kim Reyes\nrelationship: friend\nprivate_to: household\ncontact:\n  preferred_channel: imessage\n  phone: ['555-0101']\nlikes: [hiking, jazz]\n---\n\nBody.\n`,
  );
  writeFileSync(
    join(vault, 'People', 'Quincy Vale.md'),
    `---\ntype: person\nid: p_quin01\nname: Quincy Vale\nrelationship: friend\nprivate_to: quincy\n---\n\nBody.\n`,
  );
  const db = open_db(join(tmp, 't.db'));
  const memory = new MemoryClient({ vault_root: vault, db });
  await rebuild(vault, memory, db);

  new TrackedFlightsStore(db).upsert({ flight_no: 'UA123', flight_date: '2026-06-27', user_id: 'jasper', person_id: 'p_lee001', label: 'Kim home' }, new Date().toISOString());
  memory.knowledge_edges.upsert({ from_ref: 'People/Kim Reyes.md', to_ref: 'Rosa', kind: 'relates-to', context: 'hairdresser', confidence: 1, source: 'told', private_to: 'household' });
  new PersonObservations(db).record({ person_id: 'p_lee001', user_id: 'jasper', kind: 'mention', summary: "asked about Kim's trip", source_type: 'chat', source_ref: 'c0', private_to: 'household' });

  const ctx = (id: string, tier: string): ToolContext =>
    ({ memory, llm: null as unknown as LLMRouter, now: new Date(), intent_id: `i_${id}`, user: { id, tier } } as ToolContext);

  const r = await who_is.execute({ name: 'Kim' }, ctx('jasper', 'owner'));
  check('who_is("Kim") smart-resolves → Kim Reyes', r.found && r.name === 'Kim Reyes');
  check('★ flights in the dossier (the bug fix) — UA123', r.flights.some((f) => f.flight_no === 'UA123'));
  check('relationship surfaced (hairdresser → Rosa)', r.relationships.some((x) => x.role === 'hairdresser' && x.with === 'Rosa'));
  check('observation surfaced', r.observations.some((o) => /Kim's trip/.test(o.summary)));
  check('contact in facts', !!(r.facts as Record<string, unknown>).contact);
  check('summary leads with the flight count', /tracked flight/.test(r.summary));

  // cordon: owner cannot reach a person siloed to another user
  check('cordon: owner → Quincy not found', !(await who_is.execute({ name: 'Quincy' }, ctx('jasper', 'owner'))).found);
  check('cordon: quincy → Quincy found', (await who_is.execute({ name: 'Quincy' }, ctx('quincy', 'friend'))).found);
  check('unknown name → found:false', !(await who_is.execute({ name: 'Nobody Atall' }, ctx('jasper', 'owner'))).found);

  // ── pronouns: record → project → surface (first-class, anti-misgender) ────
  console.log('\n   pronouns (first-class identity fact)');
  const rec = await record_person_pref.execute({ person: 'Kim Reyes', pronouns: 'she/her' }, ctx('jasper', 'owner'));
  check('record_person_pref records pronouns', rec.ok && rec.applied.includes('pronouns'));
  check('pronouns persisted to the note', (memory.find_person({ name: 'Kim Reyes' })?.frontmatter as Record<string, unknown>)?.pronouns === 'she/her');
  await rebuild(vault, memory, db); // project the new pronouns into the table the resolver reads
  const rp = await who_is.execute({ name: 'Kim' }, ctx('jasper', 'owner'));
  check('who_is surfaces pronouns in facts', (rp.facts as Record<string, unknown>).pronouns === 'she/her');
  check('who_is summary leads with pronouns (so she won\'t misgender)', /\(she\/her\)/.test(rp.summary));

  // ── 3. flight_status recovery hint (belt + suspenders for the misfire) ─────
  console.log('\n3. flight_status non-number → recovery hint to who_is');
  const fs = create_flight_tools({ db } as never).find((t) => t.name === 'flight_status')!;
  const fsres = (await fs.execute({ flight_no: 'Kim' }, ctx('jasper', 'owner'))) as { found: boolean; candidates?: string[] };
  check('flight_status("Kim") → not found + points to who_is', fsres.found === false && (fsres.candidates ?? []).some((c) => /who_is/.test(c)));

  // ── 4. root fix: smart-resolve on WRITE (no duplicate-person spawning) ─────
  console.log('\n4. write-path smart resolve (the duplicate-Kim root fix)');
  const ownerCaller = { user_id: 'jasper', tier: 'owner' as const };
  check('resolve_person_for_write("Kim") → existing Kim Reyes', resolve_person_for_write(memory, 'Kim', ownerCaller)?.id === 'p_lee001');
  check('resolve_person_for_write(unknown) → null (caller would create)', resolve_person_for_write(memory, 'Totally Newperson', ownerCaller) === null);
  const before_n = memory.query_people({}).length;
  await record_person_pref.execute({ person: 'Kim', likes: ['surfing'] }, ctx('jasper', 'owner'));
  check('recording about bare "Kim" did NOT create a duplicate note', memory.find_person({ name: 'Kim' }) === null);
  check('it updated the existing Kim Reyes', ((memory.find_person({ name: 'Kim Reyes' })?.frontmatter as Record<string, unknown>)?.likes as string[] | undefined)?.includes('surfing') === true);
  await rebuild(vault, memory, db);
  check('people count unchanged (no new person row)', memory.query_people({}).length === before_n);

  // all-encompassing: ONE call lands birthday + address + pets + dietary + note
  // ON THE PERSON NOTE (the Casey bug: these had scattered to user_profile/Places)
  const big = await record_person_pref.execute({
    person: 'Kim',
    birthday: '1985-02-26',
    address: '10 Example Lane, Exeter NH 03833',
    pets: [{ name: 'Halo', species: 'horse', notes: 'colic June 2026; lipoma removed' }, { name: 'Jade', species: 'dog' }],
    dietary: ['gluten-free'],
    note: 'Met at a conference in 2019.',
  }, ctx('jasper', 'owner'));
  check('one call applies many fields', big.ok && big.applied.length >= 5);
  await rebuild(vault, memory, db);
  const lf = memory.find_person({ name: 'Kim Reyes' })?.frontmatter as Record<string, unknown>;
  check('birthday landed on the PERSON note', lf?.birthday === '1985-02-26');
  check('address landed on the PERSON note (plain string, not a Place)', typeof lf?.address === 'string' && /Oak Hill/.test(lf.address as string));
  check('pets landed on the PERSON note (not a Place)', Array.isArray(lf?.pets) && (lf.pets as Array<{ name: string }>).some((p) => p.name === 'Halo'));
  check('dietary landed', Array.isArray(lf?.dietary) && (lf.dietary as string[]).includes('gluten-free'));
  check('free-text note appended to the body', /Met at a conference/.test(readFileSync(join(vault, 'People', 'Kim Reyes.md'), 'utf8')));
  check('no Place note was created for a pet/home', !memory.find_place_by_name('Halo') && !memory.find_place_by_name("Kim's House"));
  // accrete: re-stating the same pet does NOT duplicate it
  await record_person_pref.execute({ person: 'Kim', pets: [{ name: 'Halo', notes: 'doing much better now' }] }, ctx('jasper', 'owner'));
  await rebuild(vault, memory, db);
  const halos = ((memory.find_person({ name: 'Kim Reyes' })?.frontmatter as Record<string, unknown>)?.pets as Array<{ name: string }> | undefined)?.filter((p) => p.name === 'Halo') ?? [];
  check('re-stating a pet accretes (no duplicate Halo)', halos.length === 1);

  // address coercion — the Casey projection-break fix: a garbled nested /
  // {value} address must become a CLEAN STRING so the note still validates+projects
  check('coerce_address: nested {value} → flat string', coerce_address({ street: { value: '1 A St' }, city: { value: 'Denver' }, state: { value: 'CO' } }) === '1 A St, Denver, CO');
  check('coerce_address: {value} unwrap', coerce_address({ value: '5 B Rd' }) === '5 B Rd');
  check('coerce_address: plain string passthrough', coerce_address('7 C Ave, Aspen') === '7 C Ave, Aspen');
  check('coerce_address: stringified JSON object', coerce_address('{"street":{"value":"9 D Way"}}') === '9 D Way');
  // end-to-end through the tool's schema preprocess → execute → projects clean
  const parsed = record_person_pref.input_schema.parse({ person: 'Kim', address: { street: { value: '99 Pine St' }, city: { value: 'Fairview' }, state: { value: 'CO' }, zip: { value: '80000' } } }) as { address?: unknown };
  check('schema preprocess coerces the garbled address to a string', typeof parsed.address === 'string');
  await record_person_pref.execute(parsed as never, ctx('jasper', 'owner'));
  await rebuild(vault, memory, db);
  const addr = (memory.find_person({ name: 'Kim Reyes' })?.frontmatter as Record<string, unknown>)?.address;
  check('coerced address persisted as a clean string (not {value}/nested)', typeof addr === 'string' && /99 Pine St/.test(addr as string) && /Fairview/.test(addr as string));
  check('note still PROJECTS after a garbled-address write (no schema break)', !!memory.find_person({ name: 'Kim Reyes' }));

  // email/phone are FLAT slots now (the nested-contact garble + no-call fix), and
  // coerce from ANY shape the model emits — the "do it to EVERY field" fix.
  await record_person_pref.execute(record_person_pref.input_schema.parse({ person: 'Kim', email: 'kim@example.com', phone: '(512) 555-0000', preferred_channel: 'imessage' }) as never, ctx('jasper', 'owner'));
  await rebuild(vault, memory, db);
  const contact = (memory.find_person({ name: 'Kim Reyes' })?.frontmatter as Record<string, unknown>)?.contact as { email?: string[]; phone?: string[]; preferred_channel?: string } | undefined;
  check('flat email landed in contact.email', !!contact?.email?.includes('kim@example.com'));
  check('flat phone landed in contact.phone', !!contact?.phone?.includes('(512) 555-0000'));
  check('preferred_channel landed', contact?.preferred_channel === 'imessage');
  const pE = record_person_pref.input_schema.parse({ person: 'Kim', email: { value: 'wrap@example.com' } }) as { email?: unknown };
  check('email as {value:…} coerces to ["…"]', Array.isArray(pE.email) && (pE.email as string[])[0] === 'wrap@example.com');
  const pA = record_person_pref.input_schema.parse({ person: 'Kim', email: [{ value: 'arr@example.com' }] }) as { email?: unknown };
  check('email as [{value:…}] coerces to ["…"]', Array.isArray(pA.email) && (pA.email as string[])[0] === 'arr@example.com');

  // GENERAL array recovery in the shared primitive (every tool, every array field)
  const ArrS = zod.object({ tags: zod.array(zod.string()) });
  check('recover_scalar_shapes: scalar → array', JSON.stringify(recover_scalar_shapes(ArrS, { tags: 'x' }).value) === JSON.stringify({ tags: ['x'] }));
  check('recover_scalar_shapes: {value} → array', JSON.stringify(recover_scalar_shapes(ArrS, { tags: { value: 'y' } }).value) === JSON.stringify({ tags: ['y'] }));
  check('recover_scalar_shapes: [{value}] → array', JSON.stringify(recover_scalar_shapes(ArrS, { tags: [{ value: 'z' }] }).value) === JSON.stringify({ tags: ['z'] }));

  // upsert_person_note: the OTHER writer the model picks — flat top-level email/phone
  // (the exact shape the 9B emitted for "Quill's email is …") must fold into contact,
  // not land as junk passthrough that the Friends card can't read.
  await upsert_person_note.execute(upsert_person_note.input_schema.parse({ identifier: { name: 'Flatcontact Tester' }, patch: { relationship: 'friend', email: { value: 'flat@example.com' }, phone: '555-9999' } }) as never, ctx('jasper', 'owner'));
  await rebuild(vault, memory, db);
  const fc = memory.find_person({ name: 'Flatcontact Tester' })?.frontmatter as Record<string, unknown> | undefined;
  const fcc = fc?.contact as { email?: string[]; phone?: string[] } | undefined;
  check('upsert flat {value} email folded → contact.email', !!fcc?.email?.includes('flat@example.com'));
  check('upsert flat phone folded → contact.phone', !!fcc?.phone?.includes('555-9999'));
  check('no junk top-level email/phone passthrough', fc?.email === undefined && fc?.phone === undefined);
  check('the contact note PROJECTS (valid frontmatter)', !!fc);

  // ── 5. delete affordance (purge a contact everywhere, cordon-checked) ──────
  console.log('\n5. delete_person (the "can\'t remove it" fix)');
  writeFileSync(join(vault, 'People', 'Puck Stray.md'), `---\ntype: person\nid: p_puck01\nname: Puck Stray\nrelationship: acquaintance\nprivate_to: household\n---\n\nBody.\n`);
  await rebuild(vault, memory, db);
  new TrackedFlightsStore(db).upsert({ flight_no: 'AA9', flight_date: '2026-07-01', user_id: 'jasper', person_id: 'p_puck01' }, new Date().toISOString());
  new PersonObservations(db).record({ person_id: 'p_puck01', user_id: 'jasper', kind: 'mention', summary: 'noise', source_type: 'chat', source_ref: 'cx', private_to: 'household' });
  // A research investigation pointing at them: the row must SURVIVE the delete
  // with person_id NULLED (an investigation is history + a shelved dossier; only
  // the person LINK dies). Pre-2026-07-30 this was left dangling.
  db.prepare(
    `INSERT INTO research_investigations
       (id, subject, subject_kind, brief, person_id, depth, status, state_json,
        findings_json, created_at, updated_at)
     VALUES ('ri_puckdel0001', 'Puck Stray', 'person', 'b', 'p_puck01', 'deep',
             'done', '{}', '[]', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')`,
  ).run();
  const dres = await delete_person.execute({ person: 'Puck Stray' }, ctx('jasper', 'owner'));
  check('delete_person reports removed', dres.ok && dres.removed === true);
  check('note gone from vault', memory.find_person({ name: 'Puck Stray' }) === null);
  check('people row gone', !memory.query_people({}).some((p) => p.id === 'p_puck01'));
  check('their tracked flights purged', new TrackedFlightsStore(db).list_for_person('jasper', 'p_puck01').length === 0);
  check('their observations purged', new PersonObservations(db).list_for_person('p_puck01', ownerCaller).length === 0);
  const inv_after = db
    .prepare(`SELECT person_id FROM research_investigations WHERE id = 'ri_puckdel0001'`)
    .get() as { person_id: string | null } | null;
  check('their investigation SURVIVES the delete (history is kept)', inv_after != null);
  check('…with person_id NULLED, not left dangling', inv_after?.person_id === null);
  check('cordon: owner cannot delete a siloed person', !(await delete_person.execute({ person: 'Quincy' }, ctx('jasper', 'owner'))).ok);

  db.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? '✓' : '✗'} entity-hydration: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
