/**
 * Smoke for same_tool_spiral (2026-07-20) — the same-tool spiral detector that
 * backs the runtime's turn-exhaust guard.
 *
 * The guard used to break the streak on anything that didn't set c.error, so a
 * SOFT failure — a tool that returns its own {ok:false}/{error} without throwing
 * (a connector 503) — slipped past it and a browse_url storm ran the whole turn
 * out (62 of 67 events on one 2026-07-09 intent shared a single intent_id). This
 * locks the three spiral-qualifying kinds: thrown error, cache-served duplicate,
 * and soft failure — and the non-spiral cases that must NOT trip it.
 */
import { same_tool_spiral, spiral_is_stuck } from '../src/core/specialist_runtime';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}

const ok = (name: string) => ({ name, result: { ok: true } });
const thrown = (name: string) => ({ name, error: 'boom' });
const dup = (name: string) => ({ name, result: { duplicate_call: true } });
const soft = (name: string) => ({ name, result: { ok: false, reason: 'concurrent_sessions_not_yet_supported' } });

console.log('→ a clean tail is not a spiral');
check('all-ok calls → null', same_tool_spiral([ok('a'), ok('b'), ok('a')]) === null);
check('empty list → null', same_tool_spiral([]) === null);

console.log('→ the three spiral-qualifying kinds each count');
{
  const errs = same_tool_spiral([ok('x'), thrown('browse_url'), thrown('browse_url'), thrown('browse_url')]);
  check('3 thrown errors → streak 3, 0 dups', errs?.streak === 3 && errs?.dups === 0 && errs?.tool === 'browse_url');
  const dups = same_tool_spiral([dup('search'), dup('search'), dup('search')]);
  check('3 cache duplicates → streak 3, 3 dups', dups?.streak === 3 && dups?.dups === 3);
  // THE FIX: a soft failure ({ok:false}) sets no c.error and is not a dup.
  const softs = same_tool_spiral([soft('browse_url'), soft('browse_url'), soft('browse_url')]);
  check('3 soft failures ({ok:false} 503s) → streak 3', softs?.streak === 3 && softs?.tool === 'browse_url');
  check('…and soft failures are counted as errors, not duplicates', softs?.dups === 0);
}

console.log('→ non-spiral cases must NOT trip it');
{
  // A later SUCCESS at the tail means the tool recovered — no spiral.
  check('soft fails then a success → null (recovered)', same_tool_spiral([soft('browse_url'), soft('browse_url'), ok('browse_url')]) === null);
  // Different tools at the tail break the streak.
  const mixed = same_tool_spiral([thrown('a'), thrown('b'), thrown('c')]);
  check('3 failures on DIFFERENT tools → streak 1 (not a same-tool spiral)', mixed?.streak === 1);
  // A single soft fail is below the guard's limit of 3.
  check('one soft fail → streak 1 (guard needs 3)', same_tool_spiral([ok('x'), soft('browse_url')])?.streak === 1);
}

console.log('→ mixed errors + soft fails on one tool accumulate honestly');
{
  const m = same_tool_spiral([thrown('browse_url'), soft('browse_url'), dup('browse_url')]);
  check('throw + soft + dup on one tool → streak 3, 1 dup', m?.streak === 3 && m?.dups === 1);
}

// ── 2026-07-29: a spiral is REPETITION, not "three failures in a row" ────────
// Ruby's civic pass called browse_url on three DIFFERENT urls — one of them
// handed to her by a failing web_fetch_clean's own `candidates` list — and the
// argument-blind guard scored it exactly like three retries of one dead call,
// exhausting a turn that had 14 of 18 rounds left and 50k chars of the
// municipal code already retrieved. These lock the distinction.
console.log('→ arguments decide whether a streak is "stuck"');
{
  const at = (name: string, url: string) => ({ name, input: { url }, error: 'boom' });
  const same = same_tool_spiral([at('browse_url', '/a'), at('browse_url', '/a'), at('browse_url', '/a')]);
  check('3 failures on the SAME args → distinct_args 1', same?.distinct_args === 1);
  check('…and that IS stuck (repetition, limit 3)', spiral_is_stuck(same!));

  const varied = same_tool_spiral([at('browse_url', '/a'), at('browse_url', '/b'), at('browse_url', '/c')]);
  check('3 failures on DIFFERENT args → distinct_args 3', varied?.distinct_args === 3);
  check('…and that is NOT stuck when the errors also differ', !spiral_is_stuck({ ...varied!, distinct_errors: 3 }));
}

console.log('→ a connector storm is still caught (distinct args, ONE error signature)');
{
  const storm = (u: string) => ({ name: 'browse_url', input: { url: u }, result: { ok: false, error: 'agentd 503 unavailable' } });
  const four = same_tool_spiral([storm('/a'), storm('/b'), storm('/c'), storm('/d')]);
  check('4 distinct-url 503s → not yet stuck (storm bar is 5)', !spiral_is_stuck(four!));
  const five = same_tool_spiral([storm('/a'), storm('/b'), storm('/c'), storm('/d'), storm('/e')]);
  check('5 distinct-url 503s → stuck (the 2026-07-20 case still trips)', spiral_is_stuck(five!));
  check('…because the error signature collapses to one', five?.distinct_errors === 1);
}

console.log('→ a failure that hands over a next move is never spiral fuel');
{
  const withCandidates = {
    name: 'web_fetch_clean',
    input: { url: 'https://library.municode.com/x' },
    result: { markdown: '', error: 'Firecrawl returned no markdown', candidates: [{ url: 'https://library.municode.com/x/', why_relevant: 'same path with trailing slash' }] },
  };
  const hinted = { name: 'browse_url', input: { url: '/z' }, result: { ok: false, recovery_hint: 'fall back to browse_url' } };
  check('a candidates-bearing failure breaks the streak', same_tool_spiral([withCandidates, withCandidates, withCandidates]) === null);
  check('a recovery_hint failure breaks the streak', same_tool_spiral([hinted, hinted, hinted]) === null);
  // 2026-07-31: a THROWN failure has no result object — its hints ride the
  // invoke envelope (InvokeOutcome.candidates). Without this arm a specialist
  // that correctly follows a thrown-error hint accrues streak and gets cut
  // off for adapting, which is the opposite of what the hint is for.
  const thrownHinted = { name: 'read_note', input: { note_path: '/a.md' }, error: 'read_note: note not found at "/a.md".', candidates: ['Knowledge/Anya/household.md'] };
  check('a thrown failure carrying envelope candidates breaks the streak', same_tool_spiral([thrownHinted, thrownHinted, thrownHinted]) === null);
  check('…but an empty candidates array is not a free pass', same_tool_spiral([
    { ...thrownHinted, candidates: [] }, { ...thrownHinted, candidates: [] }, { ...thrownHinted, candidates: [] },
  ])?.streak === 3);
  // …and it must not mask a genuine spiral that follows it.
  const after = same_tool_spiral([withCandidates, thrown('browse_url'), thrown('browse_url'), thrown('browse_url')]);
  check('a real 3-error spiral after a recoverable failure still trips', after?.streak === 3 && spiral_is_stuck(after!));
}

console.log(`\n  passed=${passed}  failed=${failed}`);
if (failed > 0) { console.error('\n✗ SAME-TOOL-SPIRAL SMOKE FAILED'); process.exit(1); }
console.log('\n✓ SAME-TOOL-SPIRAL SMOKE OK');
