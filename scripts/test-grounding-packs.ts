/**
 * Unit checks for chat grounding packs (Phase 1b). Ruby's pack is stubbable
 * (its reads are MemoryClient methods we can fake), so it's exercised directly.
 * Anna/Kristi read singleton stores (real DB files) — they're fail-open + gated
 * here and validated against live data post-deploy via `grounding_pack` audit
 * rows. Run: bun run scripts/test-grounding-packs.ts
 */
import {
  gather_grounding_packs,
  render_verified_section,
} from '../src/core/grounding_packs';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}

// Minimal MemoryClient stub exposing only the civic reads ruby_pack calls.
function stubMemory(opts: { items?: any[]; votes?: any[] }): any {
  return {
    list_civic_items: () => opts.items ?? [],
    list_civic_votes: (_uid: string, f?: { item_contains?: string }) =>
      (opts.votes ?? []).filter(
        (v) =>
          !f?.item_contains ||
          v.item_title.toLowerCase().includes(f.item_contains.toLowerCase()),
      ),
    list_civic_members: () => [],
  };
}

const now = new Date('2026-06-10T12:00:00Z');

console.log('grounding packs — Ruby civic pack + dispatcher + fail-open\n');

// 1. unknown specialist → no blocks
const r1 = await gather_grounding_packs('nobody', {
  message: 'anything',
  memory: stubMemory({}),
  user_id: 'jasper',
  now,
});
check('unknown specialist → []', r1.length === 0);

// 2. ruby: upcoming meeting (future only) + keyword-matched item + cited vote
const items = [
  { id: 'm1', kind: 'council_meeting', title: 'Regular Council Meeting', summary: 'agenda', event_at: '2026-06-16', url: 'http://meet', status: 'active' },
  { id: 'm0', kind: 'council_meeting', title: 'Past Meeting', summary: null, event_at: '2026-06-01', url: null, status: 'active' },
  { id: 'i1', kind: 'issue', title: 'Mill Creek Trail extension', summary: 'paving the trail', event_at: null, url: null, status: 'active' },
  { id: 'i2', kind: 'issue', title: 'Unrelated budget thing', summary: '', event_at: null, url: null, status: 'active' },
];
const votes = [
  { id: 'v1', member_name: 'Jane Doe', item_title: 'Mill Creek Trail extension', vote: 'aye', outcome: 'passed', meeting_date: '2026-05-20', source_url: 'http://src' },
];
const r2 = await gather_grounding_packs('ruby', {
  message: 'what about the spring creek trail?',
  memory: stubMemory({ items, votes }),
  user_id: 'jasper',
  now,
});
const j2 = r2.join('\n');
check('ruby → blocks produced', r2.length > 0);
check('upcoming meeting included, past one excluded', j2.includes('Regular Council Meeting') && !j2.includes('Past Meeting'));
check('civic item matched by keyword', j2.includes('Mill Creek Trail extension'));
check('vote rendered with member + source url', j2.includes('Jane Doe voted aye') && j2.includes('http://src'));
check('unrelated item not injected', !j2.includes('Unrelated budget thing'));

// 3. off-topic message, no upcoming meetings → []
const r3 = await gather_grounding_packs('ruby', {
  message: 'hello there friend',
  memory: stubMemory({ items: [items[1]] }), // only the past meeting
  user_id: 'jasper',
  now,
});
check('no relevant data → []', r3.length === 0);

// 4. fail-open: a throwing memory must not break the turn
const throwMem: any = {
  list_civic_items: () => {
    throw new Error('db down');
  },
};
const r4 = await gather_grounding_packs('ruby', {
  message: 'trail',
  memory: throwMem,
  user_id: 'jasper',
  now,
});
check('fail-open on memory error → []', r4.length === 0);

// 5. render_verified_section
check('render empty → ""', render_verified_section([]) === '');
check('render non-empty → has header + body', render_verified_section(['### X\n- y']).includes('Authoritative records') && render_verified_section(['### X\n- y']).includes('- y'));

// ── 6. Kate household/person blocks (2026-07-28; security half removed 2026-08-04) ──
// Tested on the VOICE surface: voice runs ONLY the topic-gated blocks (the
// always-on calendar/weather/EV are skipped), which both proves the lean-voice
// contract and keeps the stub small. Stores read through cfg.db — a real
// in-memory sqlite the store ctors initialize themselves.
import { Database } from 'bun:sqlite';
import { CALENDAR_INTENT_RE } from '@core/grounding_packs';

console.log('\nkate household/person blocks (voice-lean surface)\n');

const kdb = new Database(':memory:');
function kateMemory(opts: {
  occupants?: any[];
  unknown?: any[];
  household?: any[];
  enrolled?: any[];
  people?: any[];
} = {}): any {
  return {
    cfg: { db: kdb },
    get_household_occupancy: () => ({
      generated_at: now.toISOString(),
      window_minutes: 30,
      occupants: opts.occupants ?? [],
      unknown_present: opts.unknown ?? [],
      household: opts.household ?? [],
    }),
    list_enrolled_persons: () => opts.enrolled ?? [],
    query_people: () => opts.people ?? [],
  };
}

// 6a. household gate + abstention: nothing seen → the explicit NO DATA block.
const k1 = await gather_grounding_packs('kate', {
  message: "who's home right now?",
  memory: kateMemory(),
  user_id: 'jasper',
  now,
  tier: 'owner',
  surface: 'voice',
});
check('household: empty window → explicit NO DATA abstention block', k1.length === 1 && k1[0]!.includes('NO DATA') && k1[0]!.includes('Never guess'));

// 6b. household with a sighting + phone presence + unknown → VERIFIED lines.
const k2 = await gather_grounding_packs('kate', {
  message: 'is anyone home?',
  memory: kateMemory({
    occupants: [{ kind: 'known', name: 'Sam Reed', zone: 'Living Room', camera_name: 'living_room', seconds_ago: 300 }],
    unknown: [{ kind: 'unknown', zone: 'Driveway', camera_name: 'driveway_left', appearance: 'medium build, red jacket', seconds_ago: 60 }],
    household: [{ user_id: 'jasper', display_name: 'Jasper', presence: 'away', presence_as_of: '2026-06-10T11:55:00Z' }],
  }),
  user_id: 'jasper',
  now,
  tier: 'owner',
  surface: 'voice',
});
const k2j = k2.join('\n');
check('household: known occupant + zone rendered', k2j.includes('Sam Reed') && k2j.includes('Living Room'));
check('household: unknown person carries appearance, no name', k2j.includes('UNRECOGNIZED') && k2j.includes('red jacket'));
check('household: phone presence joined', k2j.includes("Jasper's phone: away"));

// 6c. cordon: friend tier gets NO household/security blocks.
const k3 = await gather_grounding_packs('kate', {
  message: "who's home?",
  memory: kateMemory({ occupants: [{ kind: 'known', name: 'Sam', zone: 'Kitchen', seconds_ago: 60 }] }),
  user_id: 'kim',
  now,
  tier: 'friend',
  surface: 'voice',
});
check('cordon: friend tier → no household blocks', k3.length === 0);

// 6d. person dossier: a bare mention resolves and injects the empty-dossier honesty block.
const k4 = await gather_grounding_packs('kate', {
  message: "what's Kim been up to lately?",
  memory: kateMemory({
    people: [{ id: 'p_lee', name: 'Kim Reyes', preferred_name: null, relationship: 'friend', note_path: 'People/Kim Reyes.md', frontmatter_json: '{}', mtime: '' }],
  }),
  user_id: 'jasper',
  now,
  tier: 'owner',
  surface: 'voice',
});
check('person: bare first name resolves to the dossier block', k4.length === 1 && k4[0]!.includes('Kim Reyes'));
// The row carries a relationship, so the block takes the non-empty branch —
// either way the closing honesty guard must forbid filling gaps from memory.
check(
  'person: thin dossier carries the do-not-invent guard',
  k4[0]!.includes('nothing about Kim Reyes is on file') || k4[0]!.includes('nothing beyond the name'),
);

// 6f. voice-lean: an off-topic voice turn injects NOTHING (no calendar/weather).
const k6 = await gather_grounding_packs('kate', {
  message: 'tell me something interesting',
  memory: kateMemory(),
  user_id: 'jasper',
  now,
  tier: 'owner',
  surface: 'voice',
});
check('voice-lean: off-topic voice turn → zero blocks', k6.length === 0);


// ── 7. VOICE calendar grounding (2026-08-03) ────────────────────────────────
// The void this closes: from 2026-06-07 the pack skipped calendar on voice,
// `_LOOKUP_INTENT_RE` held no calendar term, and each guard's comment named the
// other as the safety net. Voice had NO calendar grounding, and on 2026-08-02
// Kate spoke a real 6:00 PM "Dinner at little" back as "Little Hen at 7 PM".
{
  // Build on the section-6 stub so every store method the earlier kate blocks
  // touch is present; only the calendar reader is added here.
  const calMemory = (events: any[] | null): any => ({
    ...kateMemory({}),
    query_calendar_snapshot: () =>
      events === null
        ? null
        : { user_id: 'jasper', captured_at: now.toISOString(), received_at: now.toISOString(), window_start: '', window_end: '', event_count: events.length, events },
  });
  // NB: read_calendar_from_snapshot buckets against day_iso_window(), which
  // reads the REAL clock rather than the injected `now` — so the fixture has to
  // be built from the real clock too or it lands outside "tomorrow".
  const tomorrow_at = (h: number): string => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(h, 0, 0, 0);
    return d.toISOString();
  };
  const real = [{ title: 'Dinner at little', summary: 'Dinner at little', ts_start: tomorrow_at(18), ts_end: tomorrow_at(19), all_day: false }];

  const v1 = await gather_grounding_packs('kate', {
    message: "what's on my calendar tomorrow?",
    memory: calMemory(real), user_id: 'jasper', now, tier: 'owner', surface: 'voice',
  });
  check('voice calendar: a calendar question NOW gets the verified block',
    v1.some((b) => /Calendar — VERIFIED/.test(b)));
  check('voice calendar: the block carries the REAL event',
    v1.some((b) => b.includes('Dinner at little')));

  const v2 = await gather_grounding_packs('kate', {
    message: 'what is the capital of France?',
    memory: calMemory(real), user_id: 'jasper', now, tier: 'owner', surface: 'voice',
  });
  check('voice calendar: an off-topic voice turn stays lean (no calendar block)',
    v2.every((b) => !/Calendar — /.test(b)));

  const v3 = await gather_grounding_packs('kate', {
    message: "what's on my calendar tomorrow?",
    memory: calMemory(null), user_id: 'jasper', now, tier: 'owner', surface: 'voice',
  });
  check('voice calendar: no snapshot → explicit do-not-guess block, not silence',
    v3.some((b) => /Calendar — UNAVAILABLE/.test(b) && /Do NOT state, guess/.test(b)));

  const c1 = await gather_grounding_packs('kate', {
    message: 'what is the capital of France?',
    memory: calMemory(real), user_id: 'jasper', now, tier: 'owner', surface: 'chat',
  });
  check('chat calendar: still ALWAYS-on, even off-topic (unchanged behaviour)',
    c1.some((b) => /Calendar — VERIFIED/.test(b)));

  check('the pack and the forced-fetch backstop share ONE definition',
    CALENDAR_INTENT_RE.test("what's on my calendar tomorrow?") &&
    !CALENDAR_INTENT_RE.test('what is the capital of France?'));
}
console.log(fail === 0 ? `\n✓ all ${pass} checks passed` : `\n✗ ${fail} of ${pass + fail} FAILED`);
if (fail > 0) process.exit(1);
