/**
 * smoke:life-events — the Calendar Knowledge Graph foundation (Phase 3):
 * life_event PROJECTED + the inference enricher + the CalendarSource wiring.
 *
 * Self-contained: temp db + vault, real MemoryClient/AppEventBus/SpecialistInbox,
 * a stub UserRegistry, an injected calendar snapshot. No orchestrator, no LLM.
 * Exercises:
 *   A. the pure enricher (enrich_life_event): actionable vs informational,
 *      typed implications per category, participants + typed knowledge_edges
 *      (attending / located-at), fail-open lookups.
 *   B. the PROJECTION + query surface: a life_event note projects into the
 *      life_events table; query_life_events / events_within (cordon-filtered);
 *      life_events_needing_followup (uncordoned system scan, actionable + window).
 *   C. the cordon matrix: a household event visible to owner+household but NOT a
 *      friend; a member's personal event visible to that member but NOT the
 *      owner (no god-view).
 *   D. the CalendarSource end-to-end: snapshot → attribute → enriched
 *      life_event note (actionable/implications/participants) + knowledge_edges.
 *
 *   bun run smoke:life-events
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { open_db } from '@memory/stores/structured';
import { MemoryClient, type CalendarSnapshotResult } from '@memory/client';
import { rebuild } from '@ingestor/rebuild';
import { AppEventBus } from '@app/events';
import { SpecialistInbox } from '@memory/stores/conversations';
import { CalendarSource } from '@core/calendar/calendar_source';
import { enrich_life_event } from '@core/calendar/enrich_life_event';
import type { UserRegistry } from '@core/users';
import type { Caller } from '@memory/private_to';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

const TZ = 'America/Denver';
const owner: Caller = { user_id: 'jasper', tier: 'owner' };
const member: Caller = { user_id: 'sam', tier: 'household' };
const friend: Caller = { user_id: 'kim', tier: 'friend' };

const users = {
  list: () => [
    { id: 'jasper', display_name: 'Jasper', email: 'jasper@x.com', tier: 'owner' },
    { id: 'sam', display_name: 'Sam', email: 'sam@x.com', tier: 'household' },
    { id: 'kim', display_name: 'Kim', email: 'kim@x.com', tier: 'friend' },
  ],
  get: (id: string) =>
    ({ jasper: { id: 'jasper', display_name: 'Jasper', tier: 'owner' },
       sam: { id: 'sam', display_name: 'Sam', tier: 'household' } } as Record<string, unknown>)[id] ?? null,
  get_timezone: () => TZ,
} as unknown as UserRegistry;

function le_id(event_id: string): string {
  return `le_${createHash('sha256').update(event_id).digest('hex').slice(0, 8)}`;
}

function write_life_event(
  memory: MemoryClient,
  fm: Record<string, unknown>,
): void {
  memory.upsert_note(`Household/Calendar/${fm.id}.md`, { type: 'life_event', source: 'calendar', ...fm }, `# ${fm.title}`);
}

async function main(): Promise<void> {
  process.env.HEARTH_CALENDAR_GRAPH = '1';
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-life-events-'));
  const vault = join(tmp, 'vault');
  mkdirSync(vault, { recursive: true });
  const db = open_db(join(tmp, 'hearth.db'));
  const memory = new MemoryClient({ vault_root: vault, db });
  const now = new Date('2026-06-20T12:00:00Z');

  // ── A. The pure enricher ──────────────────────────────────────────────────
  const vac = enrich_life_event(
    { title: 'Bali', category: 'vacation', owner: 'kim', note_path: 'Household/Calendar/le_x.md', private_to: 'household' },
  );
  check('vacation is actionable', vac.actionable === true);
  check('vacation implies flight details', vac.implications.some((i) => /flight|travel/i.test(i)));
  check('vacation schedules a welcome-back', vac.implications.some((i) => /welcome-back/i.test(i)));
  check('owner is a participant', vac.participants.includes('kim'));
  check('owner gets an attending edge', vac.edges.some((e) => e.kind === 'attending' && e.to_ref === 'user:kim'));

  const mtg = enrich_life_event(
    { title: 'standup', category: 'meeting', owner: 'jasper', note_path: 'x.md', private_to: 'household' },
  );
  check('a routine meeting is NOT actionable', mtg.actionable === false);
  check('a meeting has no implications', mtg.implications.length === 0);

  const appt = enrich_life_event(
    { title: 'Dr. Kirshnappa', category: 'appointment', owner: 'sam', location: 'Foothills Clinic', note_path: 'x.md', private_to: 'sam' },
    { find_place: (loc) => (loc.includes('Foothills') ? { note_path: 'Places/Foothills Clinic.md' } : null) },
  );
  check('appointment is actionable', appt.actionable === true);
  check('appointment implies address + drive-time prep', appt.implications.some((i) => /address|drive/i.test(i)));
  check('a resolved location yields a located-at edge', appt.edges.some((e) => e.kind === 'located-at' && e.to_ref === 'Places/Foothills Clinic.md'));

  const dinner = enrich_life_event(
    { title: 'Dinner with Dana', category: 'other', owner: 'jasper', note_path: 'x.md', private_to: 'household' },
    { find_person: (name) => (name.includes('Dana') ? { note_path: 'People/Dana.md', display: 'Dana' } : null) },
  );
  check('a person named in the title becomes a participant', dinner.participants.includes('Dana'));
  check('the named person gets an attending edge to their note', dinner.edges.some((e) => e.kind === 'attending' && e.to_ref === 'People/Dana.md'));

  // Fail-open: a throwing lookup never breaks enrichment.
  const robust = enrich_life_event(
    { title: 'thing', category: 'appointment', owner: 'jasper', location: 'X', note_path: 'x.md', private_to: 'household' },
    { find_person: () => { throw new Error('boom'); }, find_place: () => { throw new Error('boom'); } },
  );
  check('enricher fails open on a throwing lookup', robust.actionable === true && robust.edges.length === 1);

  // ── B + C. Projection + queries + cordon ──────────────────────────────────
  write_life_event(memory, { id: 'le_vac001', title: 'Kim — Bali', category: 'vacation', owner: 'jasper', event_date: '2026-06-28T18:00:00Z', actionable: true, implications: ['Ask for flight / travel details'], participants: ['jasper'], private_to: 'household' });
  write_life_event(memory, { id: 'le_appt01', title: 'appointment', category: 'appointment', owner: 'sam', event_date: '2026-06-21T18:00:00Z', actionable: true, participants: ['sam'], private_to: 'sam' });
  write_life_event(memory, { id: 'le_mtg001', title: 'standup', category: 'meeting', owner: 'jasper', event_date: '2026-06-22T18:00:00Z', actionable: false, private_to: 'household' });
  write_life_event(memory, { id: 'le_vacfar', title: 'Summer trip', category: 'vacation', owner: 'jasper', event_date: '2026-08-19T18:00:00Z', actionable: true, private_to: 'household' });
  await rebuild(vault, memory, db);

  const proj_count = (db.prepare(`SELECT COUNT(*) AS n FROM life_events`).get() as { n: number }).n;
  check('all 4 life_events projected into the table', proj_count === 4);
  const vac_row = db.prepare(`SELECT * FROM life_events WHERE id = 'le_vac001'`).get() as { actionable: number; category: string; owner: string };
  check('projected row carries actionable=1', vac_row.actionable === 1);
  check('projected row carries category', vac_row.category === 'vacation');

  // Cordon: the owner sees household events but NOT Sam's personal appointment.
  const owner_view = memory.query_life_events({ caller: owner });
  check('owner sees the 3 household events', owner_view.length === 3);
  check('owner has NO god-view of Sam’s personal appointment', !owner_view.some((e) => e.id === 'le_appt01'));
  // Sam sees the household events AND her own.
  const sara_view = memory.query_life_events({ caller: member });
  check('member sees her own personal appointment', sara_view.some((e) => e.id === 'le_appt01'));
  check('member also sees household events', sara_view.some((e) => e.id === 'le_vac001'));
  // A friend sees neither household nor a member's personal events.
  const lee_view = memory.query_life_events({ caller: friend });
  check('a friend sees no household/personal events', lee_view.length === 0);

  // category filter
  const vacs = memory.query_life_events({ caller: owner, category: 'vacation' });
  check('category filter returns only vacations', vacs.length === 2 && vacs.every((e) => e.category === 'vacation'));

  // events_within (cordon-filtered): owner, 14d → le_vac001 (8d) + le_mtg001 (2d); NOT far vacation, NOT Sam's appt.
  const within = memory.events_within(14, owner, now, TZ);
  check('events_within(14) returns the 2 in-window household events', within.length === 2);
  check('events_within excludes the 60-day-out vacation', !within.some((e) => e.id === 'le_vacfar'));

  // life_events_needing_followup (SYSTEM, uncordoned): actionable vacation+appointment in window.
  const due = memory.life_events_needing_followup(['vacation', 'appointment'], 14, now, TZ);
  const due_ids = due.map((d) => d.event.id).sort();
  check('followup scan finds the actionable vacation + appointment in window', JSON.stringify(due_ids) === JSON.stringify(['le_appt01', 'le_vac001']));
  check('followup scan EXCLUDES the non-actionable meeting', !due.some((d) => d.event.id === 'le_mtg001'));
  check('followup scan EXCLUDES the out-of-window vacation', !due.some((d) => d.event.id === 'le_vacfar'));
  check('followup scan computes a local due_date', due.find((d) => d.event.id === 'le_appt01')?.due_date === '2026-06-21');

  // ── D. CalendarSource end-to-end (enrichment lands on the note + edges) ────
  const events = new AppEventBus();
  const inbox = new SpecialistInbox(db);
  const snapshot: CalendarSnapshotResult = {
    user_id: 'jasper',
    captured_at: '2026-06-20T00:00:00Z',
    received_at: '2026-06-20T00:00:00Z',
    window_start: '2026-06-20T00:00:00Z',
    window_end: '2026-07-20T00:00:00Z',
    event_count: 1,
    events: [
      { event_id: 'ev-maui', title: 'Maui getaway', ts_start: '2026-07-04T18:00:00Z', ts_end: '2026-07-11T18:00:00Z', calendar_name: "Jasper's iCloud", calendar_type: 'caldav', has_attendees: false },
    ],
  };
  const source = new CalendarSource({ events, memory, db, inbox, users });
  (memory as unknown as { query_calendar_snapshot: () => CalendarSnapshotResult }).query_calendar_snapshot = () => snapshot;
  await source.on_snapshot('jasper');

  const maui_path = `Household/Calendar/${le_id('ev-maui')}.md`;
  const maui = memory.read_note(maui_path);
  check('CalendarSource wrote the life_event note', !!maui);
  check('the source attributed the vacation to jasper', maui?.frontmatter?.owner === 'jasper');
  check('the source enriched it actionable', maui?.frontmatter?.actionable === true);
  check('the source wrote typed implications', Array.isArray(maui?.frontmatter?.implications) && (maui!.frontmatter!.implications as string[]).length > 0);
  const edges = memory.knowledge_edges.from(maui_path, owner);
  check('the source wrote an attending knowledge_edge', edges.some((e) => e.kind === 'attending' && e.to_ref === 'user:jasper'));

  db.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n✅ smoke:life-events — ${passed} checks passed`);
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
