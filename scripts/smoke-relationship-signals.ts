/**
 * smoke:relationship-signals — the shared overdue/occasions computation behind
 * the brief nudges + the Friends tab. Pure function, fake memory.
 */
import type { MemoryClient, PersonRow } from '../src/memory/client';
import { compute_relationship_signals, relationship_grounding_lines } from '../src/core/relationship_signals';

let pass = 0, fail = 0;
function check(n: string, c: boolean): void { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } }

function person(id: string, name: string, fm: Record<string, unknown>): PersonRow {
  return {
    id, name, preferred_name: null, relationship: String(fm.relationship ?? 'friend'),
    birthday: (fm.birthday as string) ?? null, contact_cadence: (fm.contact_cadence as string) ?? null,
    last_contacted: (fm.last_contacted as string) ?? null, sensitive: 0, friday_managed: 0, do_not_contact: 0,
    note_path: `People/${name}.md`, frontmatter_json: JSON.stringify({ id, name, ...fm }), mtime: '',
  };
}

const TODAY = '2026-06-22';
const PEOPLE: PersonRow[] = [
  person('p_over01', 'Kim', { private_to: 'household', contact_cadence: 'weekly', last_contacted: '2026-05-01' }), // 52d > 7
  person('p_bday1', 'Sam', { private_to: 'household', contact_cadence: 'monthly', last_contacted: TODAY }),       // recent → not overdue
  person('p_date01', 'Mara', { private_to: 'household', important_dates: [{ date: '2026-06-30', what: 'surgery' }] }),
  person('p_far001', 'Cold', { private_to: 'household', contact_cadence: 'quarterly', last_contacted: '2026-06-10' }), // 12d < 90 → not overdue
  person('p_anc001', 'Granny', { private_to: 'household', gedcom_xref: '@I1@', contact_cadence: 'weekly', last_contacted: '2000-01-01' }), // genealogy → excluded
  person('p_self01', 'Me', { private_to: 'household', relationship: 'self', contact_cadence: 'weekly', last_contacted: '2000-01-01' }), // own self note → excluded
  person('p_lee_priv', 'Privet', { private_to: 'kim', contact_cadence: 'weekly', last_contacted: '2000-01-01' }), // cordon
];

// upcoming_dates(horizon) returns birthday/anniversary within horizon — Sam's bday in 5d.
const UPCOMING = [{ kind: 'birthday', person_id: 'p_bday1', name: 'Sam', date: '06-27', days_until: 5, note_path: 'People/Sam.md' }];

const memory = {
  query_people: () => PEOPLE,
  upcoming_dates: () => UPCOMING,
} as unknown as MemoryClient;

function main(): void {
  console.log('relationship_signals');
  const owner = compute_relationship_signals(memory, { user_id: 'jasper', tier: 'owner' }, TODAY);
  check('overdue includes Kim (52d > weekly)', owner.overdue.some((o) => o.name === 'Kim' && o.days_since === 52));
  check('not-overdue excluded (Sam recent, Cold within cadence)', !owner.overdue.some((o) => o.name === 'Sam' || o.name === 'Cold'));
  check('genealogy excluded from overdue', !owner.overdue.some((o) => o.name === 'Granny'));
  check('own self note excluded from overdue', !owner.overdue.some((o) => o.name === 'Me'));
  check('occasions include Sam birthday (5d)', owner.occasions.some((e) => e.name === 'Sam' && e.kind === 'birthday' && e.days_until === 5));
  check('occasions include Mara surgery (important_date in horizon)', owner.occasions.some((e) => e.name === 'Mara' && e.kind === 'date' && e.what === 'surgery' && e.days_until === 8));
  check('occasions sorted soonest-first', owner.occasions[0]!.days_until <= owner.occasions[owner.occasions.length - 1]!.days_until);

  // Cordon: a friend-tier caller (kim) sees only their own siloed person.
  const kim = compute_relationship_signals(memory, { user_id: 'kim', tier: 'friend' }, TODAY);
  check('cordon: friend sees only kim-siloed (Privet overdue), not household', kim.overdue.some((o) => o.name === 'Privet') && !kim.overdue.some((o) => o.name === 'Kim'));

  // Horizon: a far-out important date is excluded.
  const narrow = compute_relationship_signals(
    { query_people: () => [person('p_x', 'X', { private_to: 'household', important_dates: [{ date: '2026-12-25', what: 'xmas' }] })], upcoming_dates: () => [] } as unknown as MemoryClient,
    { user_id: 'jasper', tier: 'owner' }, TODAY, { horizon_days: 21 },
  );
  check('far-out date beyond horizon excluded', narrow.occasions.length === 0);

  // Grounding lines render as evidence.
  const lines = relationship_grounding_lines(owner);
  check('grounding renders reconnect + occasion lines', lines.some((l) => l.startsWith('reconnect: Kim')) && lines.some((l) => l.includes("Sam's birthday")));

  console.log(`\n${fail === 0 ? '✅' : '❌'} relationship-signals: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main();
