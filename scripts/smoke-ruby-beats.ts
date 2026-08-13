/**
 * smoke:ruby-beats — one pass, one beat (2026-07-31).
 *
 * Ruby's desk ran three monolithic deliberation passes whose tails never
 * executed. The morning pass carried NINE numbered steps with the Colorado
 * desk at (7); the evening pass carried seven with the nation & world desk
 * at (7) and a Herald `browse_url` at (3) that had been failing for
 * weeks while the browser host slept — so the evening pass reliably died
 * around steps 3-5.
 *
 * The measured consequence, before the fix: `record_politics_item` had
 * NEVER been called with scope `national` or `world` since 2026-07-10, six
 * consecutive passes returned `flags=0 proposals=0 interrupts=0`, and ~180
 * passes over two months produced 3 votes and 0 proposals. Cadence was
 * never the bottleneck; per-pass yield was.
 *
 * A long scripted pass systematically starves its own tail. This pins the
 * partition: every declared slot has exactly one beat, and the two desks
 * that were starved now own a whole pass each.
 *
 * Config-level and self-contained — no db, no network, no LLM.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { load_extra_capabilities } from '../src/core/capabilities';
import { SpecialistConfigSchema } from '../src/core/specialist';

let passed = 0, failed = 0;
const check = (n: string, c: boolean): void => {
  if (c) { console.log(`  ✓ ${n}`); passed++; } else { console.error(`  ✗ ${n}`); failed++; }
};

load_extra_capabilities('config/capabilities.yaml');
const raw = readFileSync('config/specialists/ruby.yaml', 'utf8');
const doc = parse(raw) as Record<string, unknown>;

console.log('\nA. the config still loads');
const parsed = SpecialistConfigSchema.safeParse(doc);
check('ruby.yaml validates against SpecialistConfigSchema', parsed.success);
if (!parsed.success) {
  console.error(JSON.stringify(parsed.error.issues.slice(0, 5), null, 2));
  console.log(`\n  passed=${passed}  failed=${failed}`);
  process.exit(1);
}
const cfg = parsed.data;
const prelude = cfg.proactive?.deliberation_prelude_override ?? '';
const outro = cfg.proactive?.deliberation_outro_override ?? '';
const slots = cfg.proactive?.deliberation_at ?? [];
// 2026-08-05: beats moved out of the prelude into slot-keyed
// `deliberation_beats` — the runtime renders ONLY the current slot's beat,
// so one-pass-one-beat is now structural rather than an instruction the
// model has to obey. The whole rota riding every pass was 14k chars of the
// round-0 context overflow that killed all six slots on 2026-08-04/05.
const beats = cfg.proactive?.deliberation_beats ?? {};

// ── B. one beat per slot ────────────────────────────────────────────────────
console.log('\nB. every slot has a beat, every beat has a slot');

const BEATS: Array<{ slot: string; name: string; must_mention: string[] }> = [
  // courtlistener_search was granted by a concurrent session (2026-07-31) and
  // added to her tool lists but named nowhere in the prelude. Granted +
  // surfaced + unmentioned is the "chronically under-used" case from the
  // capability-visibility scan — and the campaigns step is exactly where a
  // vendor's litigation history is the strongest argument available.
  { slot: '06:15', name: 'CITY HALL', must_mention: ['fetch_council_meetings', 'record_civic_vote', 'query_civic_ledger', 'courtlistener_search'] },
  { slot: '07:30', name: 'COMMUNITY', must_mention: ['read_subreddit', 'read_reddit_thread'] },
  { slot: '10:00', name: 'DEEP BUILD', must_mention: ['Knowledge/Pleasantville/', 'ingest_to_library'] },
  { slot: '12:30', name: 'STATE DESK', must_mention: ["scope: 'state'"] },
  { slot: '16:30', name: 'LOCAL PRESS', must_mention: ['herald.com', 'fcreport.org', 'KUNC'] },
  { slot: '19:00', name: 'NATION & WORLD', must_mention: ["'national' | 'world'"] },
];

check(`declares ${BEATS.length} slots`, slots.length === BEATS.length);
for (const b of BEATS) {
  const beat = beats[b.slot] ?? '';
  check(`slot ${b.slot} is scheduled`, slots.includes(b.slot));
  check(`  ${b.slot} has a "${b.name}" beat entry`, beat.includes(b.name));
  for (const m of b.must_mention) {
    check(`    …and names ${m}`, beat.includes(m));
  }
}

// A slot with no beat entry is a pass with no instructions — it would run
// the bare shared prelude and produce nothing, which is the exact
// silent-no-op this whole change exists to remove.
check('NO slot is missing a beat entry', slots.every((s) => (beats[s] ?? '').length > 0));

// The inverse: a beat keyed to a slot that is never scheduled never runs —
// dead config masquerading as coverage.
check('NO beat is keyed to an unscheduled slot', Object.keys(beats).every((s) => slots.includes(s)));

// The prelude must NOT carry the rota any more: that is the regression this
// structure exists to prevent (every pass paying every beat's tokens).
check('the shared prelude no longer carries the whole rota',
  !prelude.includes('CITY HALL') && !prelude.includes('DEEP BUILD') && prelude.length < 4000);

// ── C. the starved desks own a whole pass now ───────────────────────────────
console.log('\nC. the two desks that never ran');

const all_beats = Object.values(beats).join('\n');
// Both used to be step (7). The check that matters is not "is it mentioned"
// (it always was) but "does it have its own slot".
check('the STATE desk has its own slot', slots.includes('12:30'));
check('the NATION & WORLD desk has its own slot', slots.includes('19:00'));
check('neither is buried under a step (7) any more', !/^\s*\(7\)/m.test(all_beats));

// The Herald browse is what ate the evening pass. It must not sit in
// front of another beat's work ever again — structurally now: it may appear
// ONLY in the 16:30 beat.
check('the Herald browse lives in its OWN beat', (beats['16:30'] ?? '').includes('herald.com'));
check('  and nothing in the nation/world beat depends on it', !(beats['19:00'] ?? '').includes('herald'));

// ── D. the instruction that makes the partition hold ────────────────────────
console.log('\nD. the model is told to run ONE beat');

check('the prelude states one pass = one beat', /ONE PASS IS ONE BEAT/i.test(prelude));
check('  and forbids borrowing the pass for another beat', /Do not\s+run another beat/i.test(prelude.replace(/\s+/g, ' ')));
check('  and says a failed source does not abandon the pass', /note it and CONTINUE/i.test(prelude));
check('the outro tells it to finish its beat and stop', /Finish the beat you were given/i.test(outro));

// The old outro hard-coded "mornings"/"evenings", which no longer maps to
// six slots and would send four of them to the wrong first tool call.
check('the outro no longer hard-codes mornings/evenings', !/\(mornings\)|\(evenings\)/.test(outro));

// ── E. the watching bucket has a lifetime, and the desk knows it ────────────
console.log('\nE. the expiry sweep is wired and taught');

const jobs = cfg.proactive?.background_jobs ?? [];
check('expire_civic_watchlist is a scheduled job', jobs.some((j) => j.tool === 'expire_civic_watchlist'));
check('extract_meeting_votes is still scheduled', jobs.some((j) => j.tool === 'extract_meeting_votes'));
check('the sweep runs BEFORE the first beat of the day',
  (() => {
    const sweep = jobs.find((j) => j.tool === 'expire_civic_watchlist')?.at ?? '';
    return sweep < '06:15' && sweep.includes(':');
  })());

// Expiry only works if she stops treating `watching` as free parking.
check('the prelude tells her a watching lead now EXPIRES', /watching.*lead with a LIFETIME|choosing to let expire/is.test(prelude));

console.log(`\n  passed=${passed}  failed=${failed}`);
if (failed > 0) { console.error('\n✗ RUBY-BEATS SMOKE FAILED'); process.exit(1); }
console.log('\n✓ RUBY-BEATS SMOKE OK');
process.exit(0);
