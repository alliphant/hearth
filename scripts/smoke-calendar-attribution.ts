/**
 * smoke:calendar-attribution — "whose event is this?" fusion + learning + the
 * Calendar signal source (Phase 2b/2c).
 *
 * Self-contained: temp db + vault, real MemoryClient/AppEventBus/SpecialistInbox,
 * a stub UserRegistry, an injected calendar snapshot. Exercises:
 *   A. the attribution engine — calendar / organizer / location / learned
 *      signals; conflicting signals → uncertain; the LEARN loop (record an
 *      answer → future generic occurrence self-attributes)
 *   B. the CalendarSource end-to-end — snapshot → attribute → life_event note
 *      (cordoned to owner) → ONE batched FYI to Kate listing attributions +
 *      "whose is this?" asks; idempotency; the kill switch
 *
 *   bun run smoke:calendar-attribution
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient, type CalendarSnapshotResult } from '@memory/client';
import { AppEventBus } from '@app/events';
import { SpecialistInbox } from '@memory/stores/conversations';
import { EventAttributions } from '@memory/stores/event_attributions';
import { attribute_event_owner, type AttributionMember } from '@core/calendar/attribution';
import { CalendarSource } from '@core/calendar/calendar_source';
import type { UserRegistry } from '@core/users';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

const TZ = 'America/Denver';
const MEMBERS: AttributionMember[] = [
  { id: 'jasper', display_name: 'Jasper', email: 'jasper@x.com' },
  { id: 'sam', display_name: 'Sam', email: 'sam@x.com' },
];
// A Tuesday 14:00 in Denver (MDT, UTC-6) = 20:00 UTC.
const TUE_2PM = '2026-06-16T20:00:00Z';

const users = {
  list: () => [
    { id: 'jasper', display_name: 'Jasper', email: 'jasper@x.com', tier: 'owner' },
    { id: 'sam', display_name: 'Sam', email: 'sam@x.com', tier: 'household' },
    { id: 'kim', display_name: 'Kim', email: 'kim@x.com', tier: 'friend' },
  ],
  get: (id: string) =>
    ({ jasper: { id: 'jasper', display_name: 'Jasper', email: 'jasper@x.com', tier: 'owner' },
       sam: { id: 'sam', display_name: 'Sam', email: 'sam@x.com', tier: 'household' } } as Record<string, unknown>)[id] ?? null,
  get_timezone: () => TZ,
} as unknown as UserRegistry;

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-calattr-'));
  const vault = join(tmp, 'vault');
  mkdirSync(vault, { recursive: true });
  const db = open_db(join(tmp, 'hearth.db'));
  const memory = new MemoryClient({ vault_root: vault, db });
  const events = new AppEventBus();
  const inbox = new SpecialistInbox(db);
  const attributions = new EventAttributions(db);
  const place_owner = (loc: string) => (loc.toLowerCase().includes('salon') ? 'sam' : null);
  const D = { members: MEMBERS, attributions, place_owner, tz: TZ };

  // ── A. The attribution engine ────────────────────────────────────────────
  check(
    'calendar_name "Sam\'s Gmail" → sam',
    attribute_event_owner({ title: 'appointment', calendar_name: "Sam's Gmail", ts_start: TUE_2PM }, D).user_id === 'sam',
  );
  check(
    'organizer email → sam',
    attribute_event_owner({ title: 'meeting', organizer: 'sam@x.com', ts_start: TUE_2PM }, D).user_id === 'sam',
  );
  check(
    'location (her salon) → sam',
    attribute_event_owner({ title: 'appt', location: 'Downtown Salon', ts_start: TUE_2PM }, D).user_id === 'sam',
  );
  const generic = attribute_event_owner({ title: 'appointment', ts_start: TUE_2PM }, D);
  check('generic event, no signals → UNCERTAIN (null)', generic.user_id === null);
  check('uncertain confidence is 0', generic.confidence === 0);
  // Conflicting signals (calendar→sam 0.6 vs organizer→jasper 0.7) within the
  // margin → still uncertain (ask, don't guess).
  const conflict = attribute_event_owner(
    { title: 'thing', calendar_name: "Sam's", organizer: 'jasper@x.com', ts_start: TUE_2PM }, D,
  );
  check('conflicting signals within margin → uncertain', conflict.user_id === null);

  // ── The LEARN loop ───────────────────────────────────────────────────────
  // Before learning: a generic "haircut" on Tue 2pm is uncertain.
  check(
    'pre-learn: generic recurring slot → uncertain',
    attribute_event_owner({ title: 'haircut', ts_start: TUE_2PM }, D).user_id === null,
  );
  // The owner tells Kate "the Tuesday 2pm haircut is Sam's".
  attributions.record({ title_norm: 'haircut', location_norm: '', weekday: 'tue', hour: 14 }, 'sam');
  // After learning: the SAME generic slot self-attributes (exact fingerprint).
  const learned = attribute_event_owner({ title: 'haircut', ts_start: TUE_2PM }, D);
  check('post-learn: generic recurring slot → sam (learned exact)', learned.user_id === 'sam');
  check('post-learn confidence high', learned.confidence >= 0.9);
  // And a future occurrence WITH a location still matches at the title+time tier.
  const future = attribute_event_owner({ title: 'haircut', location: 'Some Salon', ts_start: TUE_2PM }, D);
  check('post-learn: same slot w/ a location still attributes (title+time tier)', future.user_id === 'sam');

  // ── B. The CalendarSource end-to-end ─────────────────────────────────────
  const snapshot: CalendarSnapshotResult = {
    user_id: 'jasper',
    captured_at: '2026-06-15T00:00:00Z',
    received_at: '2026-06-15T00:00:00Z',
    window_start: '2026-06-15T00:00:00Z',
    window_end: '2026-07-15T00:00:00Z',
    event_count: 3,
    events: [
      { event_id: 'ev-sam', title: 'appointment', ts_start: TUE_2PM, ts_end: TUE_2PM, calendar_name: "Sam's Gmail", calendar_type: 'caldav', has_attendees: false },
      { event_id: 'ev-jasper', title: 'dentist', ts_start: TUE_2PM, ts_end: TUE_2PM, calendar_name: 'iCloud', calendar_type: 'caldav', organizer: 'jasper@x.com', has_attendees: false },
      { event_id: 'ev-mystery', title: 'meeting', ts_start: TUE_2PM, ts_end: TUE_2PM, calendar_name: 'iCloud', calendar_type: 'caldav', has_attendees: false },
    ],
  };
  const source = new CalendarSource({ events, memory, db, inbox, users });
  // Inject the snapshot (instance-method seam).
  (memory as unknown as { query_calendar_snapshot: () => CalendarSnapshotResult }).query_calendar_snapshot = () => snapshot;

  await source.on_snapshot('jasper');

  // life_event notes written, attributed + cordoned.
  const sara_note = memory.read_note('Household/Calendar/' + le_id('ev-sam') + '.md');
  check('life_event note written for the calendar-attributed event', !!sara_note);
  check('sam event attributed to sam', sara_note?.frontmatter?.owner === 'sam');
  check('sam event cordoned private_to sam', sara_note?.frontmatter?.private_to === 'sam');
  const mystery_note = memory.read_note('Household/Calendar/' + le_id('ev-mystery') + '.md');
  check('uncertain event marked owner_uncertain', mystery_note?.frontmatter?.owner_uncertain === true);
  check('uncertain event cordon defaults to snapshot owner', mystery_note?.frontmatter?.private_to === 'jasper');

  // ONE batched FYI to Kate listing attributions + the "whose is this?" ask.
  const kate_fyi = inbox.unread_for('kate', 10);
  check('one batched calendar FYI to Kate', kate_fyi.length === 1);
  const body = kate_fyi[0]!.body_md;
  check('FYI attributes sam', body.includes('sam'));
  check('FYI flags the uncertain one for an ask', body.toLowerCase().includes('whose is this'));

  // Idempotency: a re-run over the same snapshot adds nothing.
  await source.on_snapshot('jasper');
  check('idempotent — no new FYI on re-run', inbox.unread_for('kate', 10).length === 1);

  // Kill switch: attach() when disabled does not subscribe → emitting a
  // calendar packet processes nothing (Kate's FYI count stays at 1).
  delete process.env.HEARTH_CALENDAR_GRAPH;
  const events2 = new AppEventBus();
  const src_off = new CalendarSource({ events: events2, memory, db, inbox, users });
  src_off.attach();
  events2.emit({ type: 'sensor_packet_received', user_id: 'jasper', signal: 'calendar', captured_at: 'x', packet_id: 'p' });
  await new Promise((r) => setTimeout(r, 15));
  check('kill switch OFF → attach does not process snapshots', inbox.unread_for('kate', 10).length === 1);

  db.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n✅ smoke:calendar-attribution — ${passed} checks passed`);
}

function le_id(event_id: string): string {
  // Mirror calendar_source.le_id_for (sha256 first 8 hex).
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return `le_${createHash('sha256').update(event_id).digest('hex').slice(0, 8)}`;
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
