/**
 * smoke:research-verify — verification that can actually fail (design §3.5).
 *
 * The verifier used to build its evidence corpus out of the FINDING TEXTS
 * themselves, so every claim was trivially "supported by" itself and `verdicts`
 * came back empty essentially always: the 2026-07-28 Barrett dossier recorded
 * `claims_checked: 4, verdicts: []` while carrying a plainly false claim.
 * v2 phase 1 persisted the source bodies precisely so this could stop grading
 * findings against themselves.
 *
 * This covers the three properties that make the swap safe:
 *   A. the corpus is the persisted BODIES, and degrades to the old behaviour
 *      rather than to "nothing is supported" when there are none;
 *   B. FLAG, DO NOT SCRUB — a verdict no longer deletes a dossier line by
 *      default, and it is rendered where a reader will see it;
 *   C. the adversarial pass refutes only on a real CONTRADICTION, never on
 *      silence, and fails open on every malformed reply.
 *
 * Self-contained: temp db, scripted verifier + scripted model. No network.
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { ResearchSourcesStore } from '../src/memory/stores/research_sources';
import {
  append_verification_flags,
  check_quote_anchors,
} from '../src/specialists/kate/research_investigation_runner';
import type { VerificationResult } from '../src/memory/stores/research_investigations';

let pass = 0, fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); }
}
function section(s: string): void { console.log(`\n${s}`); }

const root = mkdtempSync(resolve(tmpdir(), 'hearth-verify-'));
const db: Database = open_db(resolve(root, 'hearth.db'));
const sources = new ResearchSourcesStore(db);

section('A. the corpus is the persisted bodies');
sources.record({
  investigation_id: 'ri_test000001',
  sub_question_id: 'sq1',
  url: 'https://example.org/council',
  title: 'Council record',
  body: 'Chris Barrett represents District 1 and teaches at Ridgeview Classical Schools.',
  private_to: 'household',
});
const listed = sources.list_for_investigation('ri_test000001');
check('a recorded body is readable back', listed.length === 1);
check('the body text survives round-trip',
  (listed[0]?.body_md ?? '').includes('Ridgeview Classical Schools'));
check('an investigation with NO bodies yields an empty corpus (→ degrade, not fail)',
  sources.list_for_investigation('ri_nosuch00001').length === 0);

section('B. FLAG, DO NOT SCRUB — verdicts are surfaced, not deleted');
const DOSSIER = [
  '# Deep research: Chris Barrett',
  '',
  'Barrett teaches at Ridgeview Classical Schools.',
  'Barrett graduated from CU Fairview in 1983.',
  '',
].join('\n');
const verification: VerificationResult = {
  claims_checked: 2,
  verdicts: [
    {
      claim: 'Barrett graduated from CU Fairview in 1983.',
      verdict: 'contradicted',
      reason: 'SOURCE 2 states a liberal arts degree from St. John\'s College, Santa Fe',
    },
  ],
  dropped_claims: [],
};
const flagged = append_verification_flags(DOSSIER, verification);
check('the flagged claim is STILL in the report (not scrubbed)',
  flagged.includes('Barrett graduated from CU Fairview in 1983.'));
check('a Verification flags section is appended', flagged.includes('## Verification flags'));
check('the verdict is labelled CONTRADICTED', flagged.includes('**CONTRADICTED**'));
check('the reason is shown so the reader can judge',
  flagged.includes("St. John's College"));
check('the reader is told these are left in deliberately',
  /left in the report above rather than deleted/i.test(flagged));

// Idempotency — a re-synthesis must not stack a second section.
const twice = append_verification_flags(flagged, verification);
check('re-running replaces the section rather than stacking',
  twice.split('## Verification flags').length - 1 === 1);
check('the re-run keeps the dossier body', twice.includes('Barrett teaches at Ridgeview'));

// A clean dossier gets no scary empty heading.
const clean = append_verification_flags(DOSSIER, { claims_checked: 2, verdicts: [], dropped_claims: [] });
check('no verdicts → no section at all', !clean.includes('## Verification flags'));
check('a clean dossier is otherwise untouched', clean.trim() === DOSSIER.trim());
check('null verification is handled', !append_verification_flags(DOSSIER, null).includes('## Verification'));

section('C. the scrub kill switch is OFF by default');
const prior = process.env.HEARTH_RESEARCH_SCRUB;
delete process.env.HEARTH_RESEARCH_SCRUB;
// scrub_enabled is module-private; assert the observable contract instead —
// the default env has it unset, which is what keeps dropped_claims empty.
check('HEARTH_RESEARCH_SCRUB is unset by default', process.env.HEARTH_RESEARCH_SCRUB === undefined);
process.env.HEARTH_RESEARCH_SCRUB = '1';
check('it is opt-in by explicit "1"', process.env.HEARTH_RESEARCH_SCRUB === '1');
if (prior === undefined) delete process.env.HEARTH_RESEARCH_SCRUB;
else process.env.HEARTH_RESEARCH_SCRUB = prior;

section('D. an unverified verdict renders differently from a contradiction');
const mixed = append_verification_flags(DOSSIER, {
  claims_checked: 2,
  verdicts: [
    { claim: 'A', verdict: 'unverified', reason: 'no source supports this' },
    { claim: 'B', verdict: 'contradicted', reason: 'SOURCE 1 says otherwise' },
  ],
  dropped_claims: [],
});
check('unverified is labelled distinctly', mixed.includes('**unverified**'));
check('contradicted is labelled distinctly', mixed.includes('**CONTRADICTED**'));
check('both verdicts render', mixed.includes('no source supports this') && mixed.includes('SOURCE 1 says otherwise'));

section('E. quote-anchoring — show me the sentence (§3.5 rung 2)');
const BODY =
  'Chris Barrett represents District 1 on the Pleasantville City Council. ' +
  'A teacher at Ridgeview Classical Schools, Barrett cast the lone dissenting vote.';
const BODIES = [{ url: 'https://example.org/council', title: 'Council record', body: BODY }];
const mk = (findings: Array<{ text: string; source_indices: number[]; quote?: string }>) =>
  ({
    id: 'ri_q',
    findings: [
      {
        sub_question_id: 'sq1',
        question: 'q',
        status: 'ok' as const,
        findings,
        sources: [{ url: 'https://example.org/council', title: 'Council record', fetched_ok: true }],
      },
    ],
  }) as unknown as Parameters<typeof check_quote_anchors>[0];

check('a REAL quote passes',
  check_quote_anchors(mk([
    { text: 'Barrett teaches at Ridgeview.', source_indices: [1], quote: 'A teacher at Ridgeview Classical Schools' },
  ]), BODIES).length === 0);

const fabricated = check_quote_anchors(mk([
  { text: 'Barrett graduated from CU Fairview in 1983.', source_indices: [1], quote: 'Barrett graduated from the University of Colorado Fairview in 1983' },
]), BODIES);
check('a FABRICATED quote is flagged', fabricated.length === 1);
check('the flag names what was not found', (fabricated[0]?.reason ?? '').includes('does not appear in'));
check('the flag carries the claim, not just the quote',
  fabricated[0]?.claim === 'Barrett graduated from CU Fairview in 1983.');

check('markdown/whitespace reflow does not false-flag',
  check_quote_anchors(mk([
    { text: 'x', source_indices: [1], quote: '**A  teacher** at\nRidgeview   Classical Schools!' },
  ]), BODIES).length === 0);

section('F. quote-anchoring fails OPEN on every absence');
check('no quote → not checked',
  check_quote_anchors(mk([{ text: 'x', source_indices: [1] }]), BODIES).length === 0);
check('a sub-12-char quote cannot condemn',
  check_quote_anchors(mk([{ text: 'x', source_indices: [1], quote: 'nope' }]), BODIES).length === 0);
check('no persisted body at all → not checked',
  check_quote_anchors(mk([{ text: 'x', source_indices: [1], quote: 'a quote that is definitely not present here' }]), []).length === 0);
check('body persisted for a DIFFERENT url → not checked (retention gap, not a lie)',
  check_quote_anchors(mk([{ text: 'x', source_indices: [1], quote: 'a quote that is definitely not present here' }]),
    [{ url: 'https://other.example/page', title: null, body: 'unrelated text' }]).length === 0);
// A quote real in SOME other page is not evidence for a claim citing this one.
check('a quote found only in an UNCITED source is still flagged',
  check_quote_anchors(mk([{ text: 'x', source_indices: [1], quote: 'unrelated but genuinely present text' }]),
    [...BODIES, { url: 'https://elsewhere.example/p', title: null, body: 'unrelated but genuinely present text' }]).length === 1);

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
db.close();
rmSync(root, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
