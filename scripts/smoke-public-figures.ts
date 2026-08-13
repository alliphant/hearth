/**
 * smoke:public-figures — self-contained proof that a person in the PUBLIC record
 * stays OUT of the household's personal relationship graph (2026-07-29).
 *
 * Replays the live defect: Ruby's civic deep-research filed Pleasantville
 * councilmember Chris Barrett into People/ as `relationship: acquaintance` with
 * `tone: warm` and empty gift_history — so Jasper's brief named a stranger as a
 * contact — and four research passes left four near-identical
 * "## Deep research" sections repeating the same four facts.
 *
 * No orchestrator, no LLM, no network: a temp vault + temp SQLite, the REAL
 * MemoryClient, the REAL person tools, and the real migration planner.
 *
 * Covers
 *   A. the shared class predicates (is_public_figure / is_non_contact)
 *   B. the exclusion matrix on the surfaces that read the people table directly
 *      (birthdays_within → the GIFT loop; people_occasions → cross-signal)
 *   C. `who_is`-shaped reads still SEE them (exclusion ≠ erasure)
 *   D. strip_body_sections + the idempotent `body_section` write — N runs leave
 *      ONE section, and a note that already accreted several collapses
 *   E. the relationship seed on create + the acquaintance-only reclassify
 *   F. the migration planner: derives candidates, refuses to guess, never
 *      touches a deliberately-set relationship or a note with a contact surface
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import matter from 'gray-matter';
import { ulid } from 'ulid';
import { MemoryClient } from '../src/memory/client';
import { open_db } from '../src/memory/stores/structured';
import { PersonObservations } from '../src/memory/stores/person_observations';
import {
  is_public_figure,
  is_non_contact,
  compute_relationship_signals,
} from '../src/core/relationship_signals';
import {
  upsert_person_note,
  strip_body_sections,
} from '../src/agents/scribe/tools/upsert_person_note';
import { find_or_create_person } from '../src/agents/scribe/tools/find_or_create_person';
import type { ToolContext } from '../src/core/tool';
import type { LLMRouter } from '../src/core/llm';
import {
  plan_public_figures,
  apply_public_figures,
  count_sections,
} from './migrate-public-figures';

let pass = 0, fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); }
}
function section(s: string): void { console.log(`\n${s}`); }

const root = mkdtempSync(resolve(tmpdir(), 'hearth-pubfig-'));
const vault = resolve(root, 'vault');
mkdirSync(resolve(vault, 'People'), { recursive: true });
const db_path = resolve(root, 'hearth.db');
const db = open_db(db_path);
// `person_observations` is created by its store's constructor, not open_db —
// instantiate it so the migration's mention-dismissal path is exercised for real.
const observations = new PersonObservations(db);
const memory = new MemoryClient({ vault_root: vault, db });
const ctx: ToolContext = {
  memory,
  llm: null as unknown as LLMRouter,
  now: new Date('2026-07-29T12:00:00Z'),
  intent_id: ulid(),
  user: { id: 'jasper', tier: 'owner' },
};

/** Write a person note + its projected row (the ingestor isn't running here). */
function seed_person(id: string, name: string, fm_extra: Record<string, unknown>, body = ''): string {
  const note_path = `People/${name.replace(/\s+/g, '-')}.md`;
  const fm: Record<string, unknown> = {
    type: 'person', id, name, relationship: 'acquaintance', anniversaries: [],
    contact: { email: [], phone: [] }, tone: 'warm', sensitive: false,
    friday_managed: false, do_not_contact: false, gift_history: [], likes: [],
    dislikes: [], pets: [], important_dates: [], relations: [], dietary: [],
    private_to: 'household', ...fm_extra,
  };
  writeFileSync(resolve(vault, note_path), matter.stringify(body, fm), 'utf8');
  db.prepare(
    `INSERT OR REPLACE INTO people
       (id, name, relationship, birthday, contact_cadence, last_contacted,
        sensitive, friday_managed, do_not_contact, note_path, frontmatter_json, mtime)
     VALUES (@id, @name, @rel, @bday, @cad, @last, 0, 0, 0, @path, @fm, @mtime)`,
  ).run({
    '@id': id, '@name': name, '@rel': String(fm.relationship),
    '@bday': (fm.birthday as string) ?? null,
    '@cad': (fm.contact_cadence as string) ?? null,
    '@last': (fm.last_contacted as string) ?? null,
    '@path': note_path, '@fm': JSON.stringify(fm), '@mtime': new Date().toISOString(),
  });
  return note_path;
}

const NOW = new Date('2026-07-29T12:00:00Z');
/** A birthday 5 days out, so it lands inside every window under test. */
const SOON = '08-03';

// A real friend, a public figure, an ancestor, and the owner — one of each class.
seed_person('p_frie01', 'Natalie', { relationship: 'friend', birthday: SOON });
seed_person('p_pub001', 'Chris Barrett', {
  relationship: 'public_figure', birthday: SOON,
  anniversaries: [{ date: SOON, what: 'took office' }],
});
seed_person('p_anc001', 'Agnes Rivers', {
  relationship: 'family', birthday: SOON, gedcom_xref: '@I9999@',
});
seed_person('p_self01', 'Jasper', { relationship: 'self', birthday: SOON });

const rows = () => memory.query_people({});
const row_of = (id: string) => rows().find((r) => r.id === id)!;

// ── A. the class predicates ─────────────────────────────────────────────────
section('A. class predicates — one definition per class');
check('is_public_figure true for a public figure', is_public_figure(row_of('p_pub001')));
check('is_public_figure false for a friend', !is_public_figure(row_of('p_frie01')));
check('is_non_contact excludes the public figure', is_non_contact(row_of('p_pub001')));
check('is_non_contact excludes the ancestor', is_non_contact(row_of('p_anc001')));
check('is_non_contact excludes self', is_non_contact(row_of('p_self01')));
check('is_non_contact KEEPS the real friend', !is_non_contact(row_of('p_frie01')));

// ── B. exclusion on the surfaces that read the people table directly ────────
section('B. the personal surfaces exclude a public figure');

// birthdays_within backs the GIFT loop — a present for a councilmember is the
// single most embarrassing thing this class could produce.
const bdays = memory.birthdays_within(14, NOW).map((b) => b.person_id);
check('birthdays_within includes the friend', bdays.includes('p_frie01'));
check('birthdays_within EXCLUDES the public figure (gift loop)', !bdays.includes('p_pub001'));
check('birthdays_within EXCLUDES the ancestor', !bdays.includes('p_anc001'));
check('birthdays_within EXCLUDES self', !bdays.includes('p_self01'));

// people_occasions backs the cross-signal coincidence scan.
const occ = memory.people_occasions().map((o) => o.person_id);
check('people_occasions includes the friend', occ.includes('p_frie01'));
check('people_occasions EXCLUDES the public figure', !occ.includes('p_pub001'));
check('people_occasions EXCLUDES the ancestor', !occ.includes('p_anc001'));

// compute_relationship_signals backs the Friends tab AND the brief's occasions —
// the surface that actually put Barrett in front of Jasper.
const signals = compute_relationship_signals(
  {
    query_people: (f) => memory.query_people(f),
    upcoming_dates: (d: number, t?: Array<'birthday' | 'anniversary'>, today?: string) =>
      memory.upcoming_dates(d, t, today),
  } as Parameters<typeof compute_relationship_signals>[0],
  { user_id: 'jasper', tier: 'owner' },
  '2026-07-29',
  { horizon_days: 21 },
);
const occ_ids = signals.occasions.map((o) => o.id);
check('brief occasions include the friend', occ_ids.includes('p_frie01'));
check('brief occasions EXCLUDE the public figure', !occ_ids.includes('p_pub001'));

// A public figure with a cadence set must still never be nudged as overdue.
seed_person('p_pub002', 'Kyle Doster', {
  relationship: 'public_figure', contact_cadence: 'weekly', last_contacted: '2020-01-01',
});
const overdue_ids = compute_relationship_signals(
  {
    query_people: (f) => memory.query_people(f),
    upcoming_dates: (d: number, t?: Array<'birthday' | 'anniversary'>, today?: string) =>
      memory.upcoming_dates(d, t, today),
  } as Parameters<typeof compute_relationship_signals>[0],
  { user_id: 'jasper', tier: 'owner' },
  '2026-07-29',
).overdue.map((o) => o.id);
check('cadence nudges EXCLUDE a public figure even with last_contacted set',
  !overdue_ids.includes('p_pub002'));

// ── C. exclusion is not erasure ─────────────────────────────────────────────
section('C. exclusion ≠ erasure — who_is-shaped reads still resolve them');
check('query_people still returns the public figure', rows().some((r) => r.id === 'p_pub001'));
check('find_person resolves the public figure by name',
  memory.find_person({ name: 'Chris Barrett' })?.id === 'p_pub001');
check('the note still exists on disk',
  (memory.read_note('People/Chris-Barrett.md')?.frontmatter?.id ?? null) === 'p_pub001');
check('upcoming_dates (the raw read who_is uses) still carries their dates',
  memory.upcoming_dates(366).some((e) => e.person_id === 'p_pub001'));

// ── D. the idempotent research section ──────────────────────────────────────
section('D. an idempotent section replaces; it does not accrete');
const ACCRETED = [
  '## Deep research (2026-07-28)', '', '- teaches at Ridgeview', '',
  '## Deep research (2026-07-29)', '', '- co-founded YIMBY Pleasantville', '',
  '## Deep research (2026-07-29)', '', '- ran in the 2025 District 1 race', '',
].join('\n');
check('count_sections sees all four of the live shape',
  count_sections(`${ACCRETED}\n## Deep research (2026-07-29)\n\n- x\n`, '## Deep research') === 4);
const stripped = strip_body_sections(`## Keep me\n\nhuman prose\n\n${ACCRETED}`, '## Deep research');
check('strip_body_sections drops every matching section', !stripped.includes('Ridgeview'));
check('strip_body_sections preserves other sections', stripped.includes('human prose'));
check('strip_body_sections keeps the surviving heading', stripped.includes('## Keep me'));
// A `###` subsection inside a replaced `##` block goes with it; a later `##` doesn't.
const nested = strip_body_sections(
  '## Deep research (a)\n\n### sub\n\ninner\n\n## Other\n\nouter\n', '## Deep research',
);
check('strip_body_sections takes nested deeper headings with the block', !nested.includes('inner'));
check('strip_body_sections stops at the next same-depth heading', nested.includes('outer'));

seed_person('p_sec001', 'Repeat Subject', {}, `## Deep research (2026-07-01)\n\n- old fact\n`);
for (const [i, fact] of ['second pass', 'third pass'].entries()) {
  await upsert_person_note.execute(
    {
      identifier: { id: 'p_sec001' },
      patch: {},
      body_section: {
        heading: '## Deep research',
        heading_suffix: `(2026-07-2${i + 1})`,
        body: `- ${fact}`,
      },
    },
    ctx,
  );
}
const sec_body = memory.read_note('People/Repeat-Subject.md')?.body ?? '';
check('three passes leave exactly ONE research section',
  count_sections(sec_body, '## Deep research') === 1);
check('the surviving section is the newest', sec_body.includes('third pass'));
check('the superseded passes are gone',
  !sec_body.includes('old fact') && !sec_body.includes('second pass'));

// body_append still appends (the human/distiller path must be unchanged).
await upsert_person_note.execute(
  { identifier: { id: 'p_sec001' }, patch: {}, body_append: '- a human note' }, ctx,
);
const after_append = memory.read_note('People/Repeat-Subject.md')?.body ?? '';
check('body_append is unchanged — it still appends', after_append.includes('- a human note'));
check('body_append did not disturb the research section',
  count_sections(after_append, '## Deep research') === 1);

// ── E. the writeback's relationship handling ────────────────────────────────
section('E. relationship seeded on create, corrected only from the old default');
const created = await find_or_create_person.execute(
  { name: 'Brand New Official', hints: { relationship: 'public_figure' } }, ctx,
);
check('find_or_create_person seeds public_figure on a NEW record',
  memory.find_person({ id: created.id })?.frontmatter?.relationship === 'public_figure');

// `acquaintance` is what the pre-fix writeback produced — correcting it is safe.
seed_person('p_acq001', 'Default Acquaintance', { relationship: 'acquaintance' });
await upsert_person_note.execute(
  { identifier: { id: 'p_acq001' }, patch: { relationship: 'public_figure' } }, ctx,
);
check('a patch can reclassify an acquaintance',
  memory.find_person({ id: 'p_acq001' })?.frontmatter?.relationship === 'public_figure');
check('public_figure validates against the person schema (the write landed)',
  memory.read_note('People/Default-Acquaintance.md')?.frontmatter?.relationship === 'public_figure');

// ── F. the migration planner ────────────────────────────────────────────────
section('F. the migration derives candidates and refuses to guess');
function seed_investigation(id: string, subject: string, person_id: string): void {
  db.prepare(
    `INSERT INTO research_investigations
       (id, subject, subject_kind, brief, person_id, depth, status, state_json,
        findings_json, created_at, updated_at)
     VALUES (@id, @s, 'person', 'b', @pid, 'deep', 'done', '{}', '[]', @t, @t)`,
  ).run({ '@id': id, '@s': subject, '@pid': person_id, '@t': new Date().toISOString() });
}

// The live shape: research-created, contactless, four repeated sections.
seed_person('p_mig001', 'Migrate Me', { relationship: 'acquaintance' }, ACCRETED);
seed_investigation('ri_mig000001', 'Migrate Me', 'p_mig001');
// The live noise: a `mention` observation the research turn itself created.
observations.record({
  person_id: 'p_mig001', user_id: 'jasper', kind: 'mention',
  summary: 'Came up in conversation: "Give me the lowdown on Migrate Me"',
  source_type: 'chat', source_ref: 'conv_mig001', private_to: 'jasper',
});
// Research-created but a REAL contact — has a phone number. Must not be a candidate.
seed_person('p_mig002', 'Real Contact', {
  relationship: 'acquaintance', contact: { email: [], phone: ['555-0100'] },
}, '## Deep research (2026-07-01)\n\n- a fact\n');
seed_investigation('ri_mig000002', 'Real Contact', 'p_mig002');
// Research-created but deliberately marked a friend. Never second-guessed.
seed_person('p_mig003', 'Actual Friend', { relationship: 'friend' },
  '## Deep research (2026-07-01)\n\n- a fact\n');
seed_investigation('ri_mig000003', 'Actual Friend', 'p_mig003');

const plan = plan_public_figures(db, vault);
const cand_ids = plan.filter((c) => c.disqualified_by.length === 0).map((c) => c.id);
check('the research-created contactless note IS a candidate', cand_ids.includes('p_mig001'));
check('a note with a phone number is NOT a candidate', !cand_ids.includes('p_mig002'));
check('a deliberately-set `friend` is NOT a candidate', !cand_ids.includes('p_mig003'));
check('a note no investigation created is not even reported',
  !plan.some((c) => c.id === 'p_frie01'));
check('an already-reclassified note is reported but not a candidate',
  plan.some((c) => c.id === 'p_pub001') && !cand_ids.includes('p_pub001'));
check('the plan records the accreted section count',
  plan.find((c) => c.id === 'p_mig001')?.deep_research_sections === 3);

// Apply is allowlisted: an unnamed candidate is untouched.
const applied = apply_public_figures(db, vault, plan, ['p_mig001']);
check('apply reclassifies only the named id', applied.reclassified.join() === 'p_mig001');
check('the named note is now public_figure',
  memory.read_note('People/Migrate-Me.md')?.frontmatter?.relationship === 'public_figure');
check('the unnamed candidate is untouched',
  matter(readFileSync(resolve(vault, 'People/Real-Contact.md'), 'utf8')).data.relationship
    === 'acquaintance');
const mig_body = memory.read_note('People/Migrate-Me.md')?.body ?? '';
check('apply collapses the accreted sections to one',
  count_sections(mig_body, '## Deep research') === 1);
check('apply keeps the NEWEST section', mig_body.includes('2025 District 1 race'));
check('apply reports what it collapsed', applied.sections_collapsed === 2);
check('apply dismissed the research-driven mention', applied.mentions_dismissed === 1);
check('the dismissed observation row SURVIVES (a flag, not a delete)',
  (db.prepare(`SELECT dismissed FROM person_observations WHERE person_id = 'p_mig001'`)
    .get() as { dismissed: number } | null)?.dismissed === 1);

// Refusing a disqualified id is explicit, not silent.
const refused = apply_public_figures(db, vault, plan, ['p_mig003', 'p_nosuch']);
check('apply refuses a deliberately-set relationship', refused.reclassified.length === 0);
check('apply names why it skipped', refused.skipped.length === 2);

// Idempotent: a second run finds nothing left to do.
const plan2 = plan_public_figures(db, vault);
check('re-planning no longer lists the migrated note as a candidate',
  !plan2.filter((c) => c.disqualified_by.length === 0).map((c) => c.id).includes('p_mig001'));

// And the migrated figure is now excluded everywhere, by the same predicate.
db.prepare(`UPDATE people SET relationship = 'public_figure', frontmatter_json = @fm WHERE id = 'p_mig001'`)
  .run({
    '@fm': JSON.stringify({
      ...matter(readFileSync(resolve(vault, 'People/Migrate-Me.md'), 'utf8')).data,
    }),
  });
check('the migrated note is excluded from the contact graph after reprojection',
  is_non_contact(row_of('p_mig001')));

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
db.close();
rmSync(root, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
