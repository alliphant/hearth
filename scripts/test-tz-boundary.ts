/**
 * Proof for the timezone boundary fix — the across-the-cut version of the
 * recurring farmers-market bug (16:00Z rendered as "4pm").
 *
 *   1. The localizer converts the real event correctly (16:00Z → 10:00 AM
 *      in Denver, never 4pm).
 *   2. The brief's verified-calendar boundary (pull_brief_context →
 *      read_calendar_from_snapshot → event_to_verified) emits localized
 *      times only — no raw UTC ISO reaches the LLM-facing object.
 *
 * Run: bun run scripts/test-tz-boundary.ts
 * The compile-time half (a raw string can't be assigned to a LocalInstant
 * context field) is proven separately by `tsc` rejecting such an assignment.
 */
import {
  to_local_instant,
  zoned_wall_to_utc_iso,
  local_midnight_utc_iso,
} from '../src/core/time';
import { pull_brief_context } from '../src/core/domain_packs/life_context';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log('  ✓', name);
  else {
    failures++;
    console.log('  ✗', name, detail ? `— ${detail}` : '');
  }
}

// 1. The localizer: the real Pleasantville Farmers Market start.
console.log('to_local_instant (the one door from UTC → LLM-facing local):');
const li = String(to_local_instant('2026-05-24T16:00:00Z', 'America/Denver'));
check('16:00Z → contains "10:00 AM"', li.includes('10:00 AM'), `got "${li}"`);
check('never the UTC-hour misread "4:00 PM"', !li.includes('4:00 PM'), `got "${li}"`);
check('no raw ISO / Zulu leaks through', !li.includes('Z') && !/T\d\d:\d\d/.test(li), `got "${li}"`);

// 1b. The WRITE door: zoned_wall_to_utc_iso (local wall-clock → UTC instant).
//     This is the calendar-write inverse of to_local_instant; getting it
//     wrong reintroduces the farmers-market bug from the other direction
//     (user says 4pm, event lands at the wrong absolute time).
console.log('\nzoned_wall_to_utc_iso (the write door — local wall-clock → UTC):');
const summer = zoned_wall_to_utc_iso('2026-06-13T16:00:00', 'America/Denver');
check('summer 4pm MDT (UTC-6) → "2026-06-13T22:00:00Z"', summer === '2026-06-13T22:00:00Z', `got "${summer}"`);
const winter = zoned_wall_to_utc_iso('2026-01-10T16:00:00', 'America/Denver');
check('winter 4pm MST (UTC-7) → "2026-01-10T23:00:00Z"', winter === '2026-01-10T23:00:00Z', `got "${winter}"`);
check('no fractional seconds (iOS ISO8601DateFormatter rejects .000Z)',
  summer !== null && /:00Z$/.test(summer) && !summer.includes('.'), `got "${summer}"`);
// Round-trips back to "4:00 PM" through the read door (closes the loop).
const round = summer ? String(to_local_instant(summer, 'America/Denver')) : '';
check('round-trips back to "4:00 PM"', round.includes('4:00 PM'), `got "${round}"`);
check('tolerates "HH:MM" (no seconds)', zoned_wall_to_utc_iso('2026-06-13T16:00', 'America/Denver') === '2026-06-13T22:00:00Z');
check('malformed input → null (caller rejects, never fabricates)',
  zoned_wall_to_utc_iso('next saturday at 4', 'America/Denver') === null);
const midnight = local_midnight_utc_iso('2026-06-13', 'America/Denver');
check('local_midnight_utc_iso all-day anchor → "2026-06-13T06:00:00Z"',
  midnight === '2026-06-13T06:00:00Z', `got "${midnight}"`);

// 2. The brief boundary, end to end, with a mock snapshot. Place the event
//    a couple hours from now so it lands in the "today" window on any run.
console.log('\nverified_life_context calendar boundary:');
const start = new Date(Date.now() + 2 * 3600_000);
const end = new Date(start.getTime() + 4 * 3600_000);
const fakeMemory = {
  query_calendar_snapshot: () => ({
    captured_at: new Date().toISOString(),
    events: [
      {
        event_id: 'fm-test',
        title: 'Pleasantville Farmers Market',
        ts_start: start.toISOString(),
        ts_end: end.toISOString(),
        location: '200 W Oak St, Pleasantville, CO',
        is_all_day: false,
        calendar_name: 'Westwood',
        calendar_type: 'caldav',
        organizer: null,
        has_attendees: false,
        notes_preview: null,
      },
    ],
  }),
  // Weather path stubs — not under test; return null so it degrades to
  // 'unavailable' instead of touching the network.
  query_latest_location_packet: () => null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const ctx = await pull_brief_context({ memory: fakeMemory, user_id: 'jasper', users: undefined });
const events = [...ctx.calendar.today, ...ctx.calendar.tomorrow];
check('event reached the verified calendar', events.length >= 1,
  `today=${ctx.calendar.today.length} tomorrow=${ctx.calendar.tomorrow.length}`);
const e0 = events[0];
const startStr = String(e0?.start ?? '');
check('event.start carries NO raw UTC (no Zulu)', !startStr.includes('Z'), `start="${startStr}"`);
check('event.start carries NO raw ISO clock (no "Txx:xx")', !/T\d\d:\d\d/.test(startStr), `start="${startStr}"`);
check('event.start reads as a localized clock (AM/PM)', /\b(AM|PM)\b/.test(startStr), `start="${startStr}"`);

// ── format_relative_when: the late-evening day-mapping fix (2026-07-02) ──
// At 10:27 PM MDT Thursday (already Friday in UTC), sensor_calendar's
// weekday-only "Fri 9:00 AM" labels read as "today" to the voice model.
// The relative form must anchor Today/Tomorrow by LOCAL date, never UTC.
{
  const { format_relative_when } = await import('../src/core/time');
  const late_thu = new Date('2026-07-03T04:27:00Z'); // Thu Jul 2, 10:27 PM MDT
  const tonight = format_relative_when('2026-07-03T05:30:00Z', 'America/Denver', late_thu); // 11:30 PM MDT Thu
  check('late-evening: an event later tonight is "Today"', /^Today /.test(String(tonight)), `got="${tonight}"`);
  const fri_morning = format_relative_when('2026-07-03T15:00:00Z', 'America/Denver', late_thu); // Fri 9 AM MDT
  check('late-evening: Friday morning is "Tomorrow (Fri, Jul 3)"', /^Tomorrow \(Fri, Jul 3\) /.test(String(fri_morning)), `got="${fri_morning}"`);
  const sat = format_relative_when('2026-07-04T15:00:00Z', 'America/Denver', late_thu); // Sat 9 AM MDT
  check('late-evening: Saturday carries weekday + DATE (no bare weekday)', /^Sat, Jul 4 /.test(String(sat)), `got="${sat}"`);
  const noon = new Date('2026-07-02T18:00:00Z'); // Thu noon MDT — the boring case
  const same_eve = format_relative_when('2026-07-03T01:00:00Z', 'America/Denver', noon); // Thu 7 PM MDT (Fri in UTC!)
  check('midday: tonight-7PM (next-day UTC) is still "Today"', /^Today /.test(String(same_eve)), `got="${same_eve}"`);
}

console.log(failures === 0 ? '\nALL PASS ✓' : `\n${failures} CHECK(S) FAILED ✗`);
process.exit(failures === 0 ? 0 : 1);
