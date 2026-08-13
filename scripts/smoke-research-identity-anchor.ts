/**
 * smoke:research-identity-anchor — a source that never names the subject is not
 * about the subject (2026-07-30).
 *
 * The failure this replays, in full. The owner asked Kate to deep-research a
 * friend, "Josie Kim Reyes". What came back was a confident professional
 * biography — Project Manager II for Commercial Vehicle Charging Corridor
 * Development at CLEANFLEET, formerly Director of the Triangle Clean Cities
 * Coalition, degrees from Campbell University and Gardner-Webb, an MIT
 * certificate. Every sentence was true, correctly cited, and about a COMPLETELY
 * DIFFERENT WOMAN. Kate then appended that stranger's career to the friend's
 * People note.
 *
 * The mechanism was only visible because v2 phase 1 had started persisting
 * source bodies the day before. Across all FOURTEEN sources the investigation
 * read, the string "Josie Kim Reyes" appeared ZERO times:
 *
 *   - six sources matched "Josie" with no "Reyes" anywhere in them (a
 *     CLEANFLEET staff page, an OpenAI employee's LinkedIn, a New York lawyer, a
 *     healthcare board member) — and every claim in the dossier came from these;
 *   - the rest matched "Reyes" with no "Josie" (surname genealogy tables, a
 *     barrel racer named Katie Jo Reyes).
 *
 * Search engines drop tokens from a three-part name, and nothing between the
 * search and the dossier ever asked whether a page was about the right person.
 *
 * Every existing guard passed: the coverage ledger honestly reported "1 of 5
 * facets answered" (coverage is orthogonal to identity — a facet answered from
 * the wrong person still reads `answered`); `verify_investigation` returned
 * `claims_checked: 8, verdicts: []` (the self-referential phase-3 gap); and
 * `identity_conflicts` only matches explicit location phrasing, so a bio saying
 * "Josie Kim is Project Manager II" tripped nothing and the writeback gate
 * opened.
 *
 * The fixture below carries the REAL name-occurrence profile of those fourteen
 * pages, measured from the persisted bodies on the live box.
 *
 * Self-contained: pure functions, no db, no network, no LLM.
 */
import {
  name_anchor_applies,
  normalize_for_match,
  source_mentions_subject,
  subject_name,
} from '../src/core/research_identity';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

const SUBJECT = 'Josie Kim Reyes';

/* ------------------------------------------------------------------ */
console.log('→ A. the name itself');
/* ------------------------------------------------------------------ */
{
  const n = subject_name(SUBJECT);
  check('tokens split in order', JSON.stringify(n.tokens) === '["josie","kim","reyes"]');
  check('surname is the last token', n.surname === 'reyes');
  check('given names are the rest', JSON.stringify(n.others) === '["josie","kim"]');

  check('titles and suffixes are not name parts', JSON.stringify(subject_name('Dr. Josie Reyes Jr.').tokens) === '["josie","reyes"]');
  check('punctuation and case normalise', normalize_for_match("O'Brien-Smith, Anne") === 'o brien smith anne');
  check('diacritics fold', normalize_for_match('José Muñoz') === 'jose nunez');

  check('gate applies to a multi-token PERSON', name_anchor_applies(true, SUBJECT));
  check('…and to a public_figure (a common name is riskier there, not safer)', name_anchor_applies(true, 'Chris Barrett'));
  check('…and not to a product (described, not named)', !name_anchor_applies(false, 'Ioniq 5'));
  check('…and not to a place', !name_anchor_applies(false, 'Pleasantville'));
  check('…and not to a mononym (no surname to anchor on)', !name_anchor_applies(true, 'Cher'));
}

/* ------------------------------------------------------------------ */
console.log('→ B. the fourteen real sources that shipped a stranger');
/* ------------------------------------------------------------------ */
{
  // Bodies reconstructed to the measured name profile of the live sources.
  const filler = 'clean transportation infrastructure planning and project delivery. '.repeat(12);
  const SOURCES: Array<{ host: string; sq: string; body: string; expect: boolean; why: string }> = [
    {
      host: 'CleanFleet.org', sq: 'sq_0', expect: false,
      why: 'the page every false claim came from: "Josie" ×10, "Reyes" ×0',
      body: `Staff Page: Josie Kim — CLEANFLEET. ${filler} Josie Kim is Project Manager II for ` +
        `Commercial Vehicle Charging Corridor Development on the Clean Fuels and Infrastructure ` +
        `team. Josie holds a B.S. from Campbell University and a Master's from Gardner-Webb. ` +
        `Josie previously served as Director of the Triangle Clean Cities Coalition. ${filler}`,
    },
    {
      host: 'linkedin.com/in/josie-kim-5a267541', sq: 'sq_0', expect: false,
      why: 'a different Josie Kim entirely — at OpenAI',
      body: `Josie Kim - OpenAI | LinkedIn. ${filler} Josie Kim. Josie Kim. Josie. ${filler}`,
    },
    {
      host: 'linkedin.com/in/josie-kim-6baaab181', sq: 'sq_0', expect: false,
      why: 'a LinkedIn signup wall — 549 chars, no name at all',
      body: 'Sign Up | LinkedIn. Join LinkedIn to see this profile. Sign in. Continue with Google. ' + filler,
    },
    {
      host: 'connectforhealthco.com', sq: 'sq_1', expect: false,
      why: 'a Colorado healthcare board member named Josie',
      body: `Healthcare Leader Named to Connect for Health Colorado Board. ${filler} Josie was ` +
        `appointed to the board. Josie brings two decades of experience. ${filler}`,
    },
    {
      host: 'lawyers.findlaw.com', sq: 'sq_1', expect: false,
      why: 'Josie H. Kim, a New York regulatory lawyer',
      body: `Josie H. Kim - a New York, New York (NY) Regulatory Lawyer. ${filler} Josie H. Kim ` +
        `practices regulatory law. Contact Josie. Josie's practice areas. ${filler}`,
    },
    {
      host: 'lh-www.citygov.com', sq: 'sq_1', expect: false,
      why: 'a Pleasantville archival citation guide — matched on the city, not the person',
      body: `Citing Archival Material: Pleasantville History Connection. ${filler} Josie. ${filler}`,
    },
    {
      host: 'barrelracing.com', sq: 'sq_3', expect: false,
      why: 'Katie Jo Reyes, barrel racer: "Reyes" ×23, "Josie" ×1, never together',
      body: `Katie Jo Reyes Trusts Bigger Plan. ${'Reyes rode well. Reyes won. '.repeat(11)}` +
        `Reyes on Melania. ${filler} A spectator named Josie cheered from the stands. ${filler}`,
    },
    {
      host: 'ourcity.citygov.com', sq: 'sq_4', expect: false,
      why: 'a civic-assembly page naming nobody',
      body: `Civic Assemblies | Our City. ${filler} Residents are invited to participate. ${filler}`,
    },
  ];

  let dropped = 0;
  for (const s of SOURCES) {
    const v = source_mentions_subject(s.body, SUBJECT);
    if (!v.mentions) dropped++;
    check(`DROP ${s.host} — ${s.why}`, v.mentions === s.expect, `basis=${v.basis}`);
  }
  check('every one of the stranger sources is refused', dropped === SOURCES.length);

  // The specific diagnosis the reader needs.
  const CleanFleet = source_mentions_subject(SOURCES[0]!.body, SUBJECT);
  check('the CLEANFLEET refusal names the missing surname', /reyes/i.test(CleanFleet.reason) && CleanFleet.basis === 'no_surname_match');
  check('…and reports the partial-name hits that fooled the pipeline', CleanFleet.other_hits > 0);

  const racer = source_mentions_subject(SOURCES[6]!.body, SUBJECT);
  check('the barrel racer dies on PROXIMITY, not absence', racer.basis === 'surname_without_given_name');
  check('…having matched the surname many times', racer.surname_hits > 10, String(racer.surname_hits));
}

/* ------------------------------------------------------------------ */
console.log('→ C. real sources about the real person must still pass');
/* ------------------------------------------------------------------ */
{
  const pass = (body: string) => source_mentions_subject(body, SUBJECT).mentions;
  check('full name verbatim', pass('Josie Kim Reyes has lived in Pleasantville since 2019.'));
  check('the name she actually goes by (Kim Reyes)', pass('Kim Reyes runs the community garden.'));
  check('first + last, middle dropped', pass('Contact Josie Reyes for details.'));
  check('reversed with a comma', pass('Reyes, Josie Kim — Milton, CO'));
  check('middle initial', pass('Josie L. Reyes was elected treasurer.'));
  check('case and punctuation are irrelevant', pass('ANNIE HALBERT!!!'));
  check('a long page that names her once, deep in the body', pass('filler text. '.repeat(400) + 'Josie Reyes volunteers here.'));
  check(
    'a page naming her AND unrelated Annies still passes',
    pass('Josie Smith spoke. '.repeat(20) + 'Josie Reyes then presented the budget.'),
  );
}

/* ------------------------------------------------------------------ */
console.log('→ D. fail-open, and the documented limit');
/* ------------------------------------------------------------------ */
{
  check('an empty body never drops a source', source_mentions_subject('', SUBJECT).mentions);
  check('an empty subject never drops a source', source_mentions_subject('anything at all', '').mentions);
  check('…and both are recorded as skipped, not as a match', source_mentions_subject('', SUBJECT).basis === 'skipped');

  // HONEST BOUNDARY: this is a NECESSARY condition, not a sufficient one. A
  // genealogy table containing some other, long-dead "Josie Reyes" passes —
  // it does name a person by that name. Separating same-NAME from same-PERSON
  // needs attributes, and is the identity-anchor phase (design §3.3). Three of
  // the fourteen live sources survived for exactly this reason; the six that
  // produced the false biography did not.
  const genealogy = 'Reyes family tree. ' + 'Reyes, John b.1848. '.repeat(30) +
    'Reyes, Josie b.1887 d.1954. ' + 'Reyes, Mary b.1901. '.repeat(30);
  const v = source_mentions_subject(genealogy, SUBJECT);
  check('a same-name genealogy entry PASSES (known limit, not a bug)', v.mentions && v.basis === 'surname_with_given_nearby');

  // The kill switch.
  process.env.HEARTH_RESEARCH_NAME_ANCHOR = '0';
  check('kill switch disables the gate entirely', !name_anchor_applies(true, SUBJECT));
  delete process.env.HEARTH_RESEARCH_NAME_ANCHOR;
  check('…and it re-arms', name_anchor_applies(true, SUBJECT));
}

/* ------------------------------------------------------------------ */
console.log('→ E. telling Kate a new fact re-opens the SAME investigation');
/* ------------------------------------------------------------------ */
{
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { open_db } = await import('../src/memory/stores/structured');
  const { ResearchInvestigationStore } = await import('../src/memory/stores/research_investigations');

  const dir = mkdtempSync(join(tmpdir(), 'hearth-anchor-'));
  const db = open_db(join(dir, 'smoke.db'));
  const store = new ResearchInvestigationStore(db);

  const row = store.create({
    subject: SUBJECT,
    subject_kind: 'person',
    brief: 'background, current life in Pleasantville, professional history',
    requested_by: 'jasper',
    agent_id: 'kate',
  });
  check('a fresh investigation starts with no anchors', row.anchor_facts.length === 0);

  // It finishes having found only strangers — the live 2026-07-30 outcome.
  store.update(row.id, {
    status: 'done',
    findings: [
      {
        sub_question_id: 'sq_0',
        question: 'professional identity?',
        status: 'failed',
        findings: [],
        sources: [],
        dropped_sources: [
          { url: 'https://CleanFleet.org/josie-kim/', title: 'Josie Kim', reason: 'never mentions the surname "reyes"' },
        ],
        note: 'read 1 source(s), none of which are about Josie Kim Reyes',
      },
    ],
    coverage: { facets: [{ sub_question_id: 'sq_0', question: 'professional identity?', status: 'unanswerable', reason: 'not about her', finding_count: 0, source_count: 0 }] },
    dossier_md: '# Could not find this person',
  });
  check('it is done and unanswered', store.get(row.id)!.status === 'done');

  // The owner now tells Kate what she knows.
  const found = store.find_recent_for_subject(SUBJECT, 'jasper', 30 * 86_400_000);
  check('the finished investigation is findable for refinement', found?.id === row.id);
  check('a DIFFERENT requester cannot re-open it', store.find_recent_for_subject(SUBJECT, 'sam', 30 * 86_400_000) === null);
  check('an old one falls outside the window', store.find_recent_for_subject(SUBJECT, 'jasper', 1, new Date(Date.now() + 86_400_000)) === null);

  const reopened = store.reopen_with_facts(row.id, ['works at BrightCase in Pleasantville', 'goes by Kim'], { carry_dossier: false })!;
  check('the SAME row is re-opened, not a twin', reopened.id === row.id);
  check('it re-enters the pipeline at planning', reopened.status === 'planning');
  check('the facts are recorded', reopened.anchor_facts.length === 2 && reopened.anchor_facts[0]!.includes('BrightCase'));
  check('the stranger findings are CLEARED', reopened.findings.length === 0);
  check('…as is the coverage and the wrong dossier', reopened.coverage === null && reopened.dossier_md === null);
  check('…and completed_at is cleared so it is genuinely open again', reopened.completed_at === null);
  check('the cordon and requester survive', reopened.requested_by === 'jasper' && reopened.subject === SUBJECT);

  const twice = store.reopen_with_facts(row.id, ['goes by Kim', 'studied at the clinic'], { carry_dossier: false })!;
  check('a second refinement MERGES rather than replaces', twice.anchor_facts.length === 3);
  check('…and does not duplicate a repeated fact', twice.anchor_facts.filter((f) => f === 'goes by Kim').length === 1);

  check('re-opening an unknown id is a no-op, not a throw', store.reopen_with_facts('ri_nope', ['x'], { carry_dossier: false }) === null);

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
console.log('→ F. a report is as long as what it established');
/* ------------------------------------------------------------------ */
{
  // The 2026-07-30 "Daniel Ray Torres" dossier: 0 of 6 facets answered, and
  // 10,074 characters of elaborated absence — synthesized from a Wikipedia page
  // about the NAME "Jonathan", a baby-name site, a Bible dictionary, a Honda
  // tuning forum and a GitHub bug report. 17 of its 18 sources never named him.
  const { compute_coverage, coverage_tally, render_coverage_section } = await import(
    '../src/core/research_coverage'
  );
  const facets = Array.from({ length: 6 }, (_, i) => ({
    id: `sq_${i}`,
    question: `facet ${i}: employment / property / court / reddit / profile / local ties?`,
  }));
  const plan = { sub_questions: facets };
  const results = facets.map((f) => ({
    sub_question_id: f.id,
    question: f.question,
    status: 'partial' as const,
    findings: [],
    sources: [{ url: 'https://spokeo.example/x', title: 'Spokeo', fetched_ok: true }],
    note: 'sources read but no grounded answer found',
  }));
  const cov = compute_coverage(plan, results);
  const t = coverage_tally(cov);
  check('every facet is unanswerable', t.unanswerable === 6 && t.answered === 0 && t.partial === 0);
  check(
    'nothing answered and nothing partial is the trigger condition',
    !cov.facets.some((f) => f.status === 'answered' || f.status === 'partial'),
  );
  const block = render_coverage_section(cov);
  check('the ledger alone already names all six failures', (block.match(/⛔/g) ?? []).length === 6);
  check(
    'so the ledger is far shorter than the prose it replaces',
    block.length < 2000,
    `${block.length} chars vs the 10,074-char dossier`,
  );
}

  // The rule must NOT fire while the run is still resumable — a facet that was
  // never attempted means nothing was established YET, and burying a partial
  // dossier under a terminal "nothing established" would hide work in progress.
{
  const { compute_coverage } = await import('../src/core/research_coverage');
  const plan = { sub_questions: [{ id: 'sq_0', question: 'q0' }, { id: 'sq_1', question: 'q1' }] };
  const mixed = compute_coverage(plan, [
    { sub_question_id: 'sq_0', question: 'q0', status: 'failed', findings: [], sources: [], note: 'nope' },
    { sub_question_id: 'sq_1', question: 'q1', status: 'not_attempted', findings: [], sources: [], note: 'deadline' },
  ]);
  const all_unanswerable = mixed.facets.every((f) => f.status === 'unanswerable');
  check('a still-resumable run does NOT trip the short report', !all_unanswerable);
  const done = compute_coverage(plan, [
    { sub_question_id: 'sq_0', question: 'q0', status: 'failed', findings: [], sources: [], note: 'nope' },
    { sub_question_id: 'sq_1', question: 'q1', status: 'failed', findings: [], sources: [], note: 'nope' },
  ]);
  check('a finished-and-empty run DOES', done.facets.every((f) => f.status === 'unanswerable'));
}

console.log(`\n  passed=${passed}  failed=${failed}`);
if (failed > 0) {
  console.error('\n✗ RESEARCH-IDENTITY-ANCHOR SMOKE FAILED');
  process.exit(1);
}
console.log('\n✓ RESEARCH-IDENTITY-ANCHOR SMOKE OK');
process.exit(0);
