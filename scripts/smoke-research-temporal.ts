/**
 * smoke:research-temporal — the deterministic temporal check on deep-research
 * findings (2026-07-29).
 *
 * Why it exists: the investigation verifier's grounding pass is SELF-
 * REFERENTIAL (the evidence corpus contains the findings it is checking), so
 * `unsupported` comes back empty essentially always — the 2026-07-28 Barrett
 * dossier recorded `claims_checked: 4, verdicts: []` while asserting he was
 * "re-elected in November 2029" in a document written in July 2026. That
 * inverted the answer to the very question the investigation was filed to
 * answer ("when is he up for re-election"). This check needs no evidence
 * corpus at all, so it works even while source bodies go unpersisted.
 */
import { temporal_inconsistencies } from '../src/specialists/kate/research_investigation_runner';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}

const NOW = new Date('2026-07-28T12:00:00Z');

console.log('→ the claim that actually shipped');
{
  const conway = 'While it is confirmed that he was elected in November 2025 and re-elected in November 2029, specific votes are not grounded.';
  const hits = temporal_inconsistencies([conway], NOW);
  check('"re-elected in November 2029" written in 2026 is flagged', hits.length === 1);
  check('…and the reason names the future date', /2029/.test(hits[0]?.reason ?? ''));
  check('…and it is FLAGGED, not dropped (caller keeps the sentence)', hits[0]?.claim.includes('elected in November 2025') === true);
}

console.log('→ legitimate past claims are left alone');
{
  check('a past election is fine', temporal_inconsistencies(['He was elected in November 2025.'], NOW).length === 0);
  check('a past vote is fine', temporal_inconsistencies(['Council voted 6-1 on June 16, 2026 to end the contract.'], NOW).length === 0);
  check('current month is not "future"', temporal_inconsistencies(['The policy review began in July 2026.'], NOW).length === 0);
}

console.log('→ forward-looking statements are not past tense, so they pass');
{
  check('a scheduled future event is fine', temporal_inconsistencies(['His seat is up for election in November 2029.'], NOW).length === 0);
  check('a future deadline is fine', temporal_inconsistencies(['The contract runs through 2030.'], NOW).length === 0);
  check('a plan is fine', temporal_inconsistencies(['The city will complete the review in 2027.'], NOW).length === 0);
}

console.log('→ the mirror-image error (a finished event written as upcoming)');
{
  const stale = 'Chris Barrett is a teacher and co-founder of YIMBY Pleasantville, currently running for the District 1 seat in the November 4, 2025, election.';
  const hits = temporal_inconsistencies([stale], NOW);
  check('"currently running ... November 4, 2025" in 2026 is flagged', hits.length === 1);
  check('…and the reason says the date already passed', /already passed/.test(hits[0]?.reason ?? ''));
  check('a past election described as upcoming is flagged', temporal_inconsistencies(['The 2025 election is scheduled for November.'], NOW).length === 1);
  check('a FUTURE pending event is still fine', temporal_inconsistencies(['The seat is up for election in November 2029.'], NOW).length === 0);
  check('a past event in past tense is still fine', temporal_inconsistencies(['He was elected in November 2025.'], NOW).length === 0);
}

console.log('→ edges');
{
  check('empty input → no hits', temporal_inconsistencies([], NOW).length === 0);
  check('no date at all → no hits', temporal_inconsistencies(['He voted against the measure.'], NOW).length === 0);
  check('a future year in past tense without a month still flags', temporal_inconsistencies(['The contract was terminated in 2028.'], NOW).length === 1);
  // One flag per claim, even when several future dates appear.
  check('one flag per claim', temporal_inconsistencies(['He was elected in 2029 and re-elected in 2033.'], NOW).length === 1);
  // A year that is future-by-month only.
  check('same year, later month, past tense → flagged', temporal_inconsistencies(['He was appointed in December 2026.'], NOW).length === 1);
}

console.log(`\n  passed=${passed}  failed=${failed}`);
if (failed > 0) { console.error('\n✗ RESEARCH-TEMPORAL SMOKE FAILED'); process.exit(1); }
console.log('\n✓ RESEARCH-TEMPORAL SMOKE OK');
