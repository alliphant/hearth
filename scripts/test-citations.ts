/**
 * smoke:citations — the deterministic claim→source verifier.
 *
 * The contract under test: a cited sentence's specifics must be IN the
 * cited source (else 'mismatched'); a specific that IS in some source but
 * carries no marker is 'uncited'; a specific in NO source is NOT this
 * layer's call (the semantic fact-critic owns stable-vs-volatile).
 */
import {
  citation_retry_nudge,
  split_sentences,
  verify_citations,
  type CitationSource,
} from '../src/core/citations';

let checks = 0;
function check(name: string, ok: boolean): void {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) process.exitCode = 1;
}

const SOURCES: CitationSource[] = [
  {
    id: 'S1',
    tool: 'web_fetch_clean',
    content: 'City Council meets June 14 at Council Chambers. The Mill Creek Trail repaving was approved.',
  },
  {
    id: 'S2',
    tool: 'sensor_calendar_upcoming',
    content: 'Dentist at Foothills Activity Center at 4:30 PM on Wednesday.',
  },
];

function main(): void {
  check(
    'split_sentences handles prose + lines',
    split_sentences('One thing. Two things!\nThree.').length === 3,
  );

  // Correctly cited → clean.
  const ok = verify_citations('The council meets June 14 [S1]. Dentist at Foothills Activity Center [S2].', SOURCES);
  check('correctly cited claims produce no findings', ok.length === 0);

  // Cited the WRONG source → mismatched.
  const wrong = verify_citations('The dentist visit is at Foothills Activity Center [S1].', SOURCES);
  check(
    'claim cited against the wrong source → mismatched',
    wrong.some((f) => f.kind === 'mismatched' && /Foothills Activity Center/.test(f.claim)),
  );

  // In a source but unmarked → uncited.
  const bare = verify_citations('The Mill Creek Trail repaving was approved.', SOURCES);
  check(
    'sourced-but-unmarked claim → uncited',
    bare.some((f) => f.kind === 'uncited' && /Mill Creek Trail/.test(f.claim)),
  );

  // In NO source → not this layer's finding (fact-critic territory).
  const foreign = verify_citations('The Budget Work Session covers FY2027 [S1].', SOURCES);
  check(
    'claim in no source is left to the semantic critic',
    !foreign.some((f) => /Budget Work Session/.test(f.claim)),
  );

  // Markers themselves never read as claims.
  const marker_only = verify_citations('Sounds good [S1].', SOURCES);
  check('a bare marker is not a claim', marker_only.length === 0);

  // No sources → no findings (citation mode inactive shape).
  check('no sources → no findings', verify_citations('June 14 meeting.', []).length === 0);

  // Nudge: house style — silent correction, names the fix per kind.
  const nudge = citation_retry_nudge([
    { claim: 'Dr. Kirshnappa', kind: 'mismatched', cited: ['S1'], sentence_preview: 'x' },
    { claim: 'Mill Creek Trail', kind: 'uncited', cited: [], sentence_preview: 'y' },
  ]);
  check('nudge tells the model to fix the wrong citation', /doesn't contain it/.test(nudge));
  check('nudge tells the model to add the missing marker', /carries no \[S#\] marker/.test(nudge));
  check('nudge demands a silent direct correction', /no apology/.test(nudge) && /one retry/.test(nudge));

  if (process.exitCode === 1) {
    console.log('\nsmoke:citations FAILED');
    process.exit(1);
  }
  console.log(`\n✓ smoke:citations — ${checks} checks passed`);
}

main();
