/**
 * smoke:research-identity — a name match is not a person match (2026-07-29).
 *
 * The Barrett conflation: an investigation into "Chris Barrett, Pleasantville
 * city councilmember" returned a section describing an X account belonging to
 * a New York Times Opinion editor living in New York. Every sentence was
 * individually TRUE and correctly cited, so every guard passed — the pipeline
 * verifies claim -> source and never source -> SUBJECT. The synthesis model
 * even noticed ("though it lists his location as New York, NY") and shipped
 * it anyway, because nothing downstream could act on the contradiction.
 */
import {
  identity_anchor_places,
  identity_conflicts,
} from '../src/specialists/kate/research_investigation_runner';

let passed = 0, failed = 0;
const check = (n: string, c: boolean): void => {
  if (c) { console.log(`  ✓ ${n}`); passed++; } else { console.error(`  ✗ ${n}`); failed++; }
};

const BRIEF = 'Full workup on Chris Barrett, Pleasantville City Council District 1, first term.';
const anchor = identity_anchor_places(BRIEF, 'Chris Barrett');

console.log('→ the anchor');
check('anchors on the distinguishing token', anchor.has('collins'));
check('"fort" is stopworded (Fort Worth must not match Pleasantville)', !anchor.has('fort'));

console.log('→ the paragraph that actually shipped');
{
  const real = "His X profile describes him as an editor at the New York Times Opinion section and NYT Sunday Review, married to Jennifer Preston, and a father of twins, though it lists his location as New York, NY.";
  const hits = identity_conflicts([real], anchor);
  check('the NYT-editor paragraph is flagged', hits.length === 1);
  check('…and it names the conflicting place', /New York/.test(hits[0]?.place ?? ''));
  check('…and the reason states the rule', /same-name match is not a same-person match/.test(hits[0]?.reason ?? ''));
}

console.log('→ on-subject claims are left alone');
for (const ok of [
  'Chris Barrett is an English teacher at Ridgeview Classical Schools and founder of YIMBY Pleasantville.',
  'He is based in Pleasantville, Colorado.',
  'Council voted 6-1 to end the contract.',
]) check(`accepts: "${ok.slice(0, 46)}…"`, identity_conflicts([ok], anchor).length === 0);

console.log('→ other assertion phrasings');
check('"lives in Denver" flags', identity_conflicts(['He lives in Denver, CO.'], anchor).length === 1);
check('"based in Brooklyn" flags', identity_conflicts(['The author is based in Brooklyn.'], anchor).length === 1);
check('"located in Pleasantville" passes', identity_conflicts(['The office is located in Pleasantville.'], anchor).length === 0);

console.log('→ edges');
check('no anchor → no flags (never guess)', identity_conflicts(['He lives in Denver.'], new Set<string>()).length === 0);
check('no location assertion → no flags', identity_conflicts(['He voted no.'], anchor).length === 0);
check('empty input', identity_conflicts([], anchor).length === 0);
check('one flag per claim', identity_conflicts(['He lives in Denver, CO and is based in Brooklyn.'], anchor).length === 1);

console.log(`\n  passed=${passed}  failed=${failed}`);
if (failed > 0) { console.error('\n✗ RESEARCH-IDENTITY SMOKE FAILED'); process.exit(1); }
console.log('\n✓ RESEARCH-IDENTITY SMOKE OK');
