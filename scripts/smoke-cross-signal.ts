/**
 * smoke:cross-signal — Kate's cross-signal "I noticed" fusion nudges (Piece 2).
 *
 * Self-contained: temp db + vault, no orchestrator. Exercises scan_cross_signals:
 *   - visitor + occasion (flagship): a visit whose participant has a birthday
 *     inside the window → ONE proposal carrying likes + the LEARNED budget
 *   - anniversary variant + a MEMBER-private visit → cordon-scoped to that member
 *   - NO false coincidence: a visit with no nearby occasion, a non-visit event
 *     whose participant has a birthday that day, a far-off birthday
 *   - double-booking: two timed same-owner events overlap → ONE proposal;
 *     non-overlapping / cross-owner / all-day pairs file nothing
 *   - edge dedup (a second run files nothing)
 *   - warm planner phrasing (mock LLM) + the no-LLM template fallback (fail-open)
 *   - the kill switch (HEARTH_CROSS_SIGNAL off → no-op)
 *
 *   bun run smoke:cross-signal
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { rebuild } from '@ingestor/rebuild';
import { ProposalsStore } from '@core/proposals';
import { make_scan_cross_signals } from '@specialists/kate/tools/scan_cross_signals';
import {
  occasion_in_visit_window,
  timed_bounds,
  ranges_overlap,
  name_mentioned,
  cross_signal_enabled,
} from '@core/calendar/cross_signals';
import type { ToolContext } from '@core/tool';
import type { LLMRouter } from '@core/llm';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

const CANNED = 'Kim is in town this week and their birthday lands right in the middle — want me to sort a gift and plan something?';
const mock_llm = {
  for_role: () => ({
    provider: { complete: async () => ({ content: CANNED }) },
    defaults: { temperature: 0.5 },
  }),
} as unknown as LLMRouter;

function payload_of(db: import('bun:sqlite').Database, pid: string): Record<string, unknown> {
  return JSON.parse((db.prepare(`SELECT payload_json FROM proposals WHERE id = @id`).get({ '@id': pid }) as { payload_json: string }).payload_json);
}
function user_of(db: import('bun:sqlite').Database, pid: string): string | null {
  return (db.prepare(`SELECT user_id FROM proposals WHERE id = @id`).get({ '@id': pid }) as { user_id: string | null }).user_id;
}

function pure_unit_checks(): void {
  // occasion_in_visit_window — year-agnostic, padded, year-rollover.
  check('occasion inside window hits', occasion_in_visit_window('06-28', '2026-06-26', '2026-06-29', 3) === '2026-06-28');
  check('occasion within pad hits', occasion_in_visit_window('07-02', '2026-06-26', '2026-06-29', 3) === '2026-07-02');
  check('occasion outside window misses', occasion_in_visit_window('07-20', '2026-06-26', '2026-06-29', 3) === null);
  check('full-date occasion parses', occasion_in_visit_window('1990-06-28', '2026-06-26', '2026-06-29', 3) === '2026-06-28');
  check('year rollover (Dec visit / Jan bday)', occasion_in_visit_window('01-02', '2026-12-30', '2026-12-31', 3) === '2027-01-02');
  check('garbage occasion → null', occasion_in_visit_window('not-a-date', '2026-06-26', '2026-06-29', 3) === null);

  // timed_bounds — all-day returns null; missing end defaults +1h.
  check('all-day event → no timed bounds', timed_bounds('2026-06-24', null) === null);
  const tb = timed_bounds('2026-06-22T14:00:00Z', null);
  check('timed event default end = +1h', tb !== null && tb.end_ms - tb.start_ms === 3_600_000);
  const a = timed_bounds('2026-06-22T14:00:00Z', '2026-06-22T15:00:00Z')!;
  const b = timed_bounds('2026-06-22T14:30:00Z', '2026-06-22T15:30:00Z')!;
  const c = timed_bounds('2026-06-22T16:00:00Z', '2026-06-22T17:00:00Z')!;
  check('overlapping ranges detected', ranges_overlap(a, b) === true);
  check('non-overlapping ranges rejected', ranges_overlap(a, c) === false);

  // name_mentioned — whole-word.
  check('name matches as a whole word', name_mentioned('Kim', 'Kim visits next week') === true);
  check('name does not match a substring', name_mentioned('Kim', 'sleeve shopping') === false);
}

async function main(): Promise<void> {
  pure_unit_checks();

  process.env.HEARTH_CROSS_SIGNAL = '1';
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-cross-sig-'));
  const vault = join(tmp, 'vault');
  mkdirSync(vault, { recursive: true });
  const db = open_db(join(tmp, 'hearth.db'));
  const memory = new MemoryClient({ vault_root: vault, db });
  const proposals = new ProposalsStore(db);
  const now = new Date('2026-06-20T12:00:00Z');

  // ── People (occasions; likes + gift_history for the learned budget) ────────
  memory.upsert_note('People/Kim.md', {
    type: 'person', id: 'p_lee001', name: 'Kim', relationship: 'friend',
    birthday: '06-28', likes: ['hiking', 'dark chocolate'],
    gift_history: [{ date: '2024-06-28', what: 'book', cost: 40 }, { date: '2025-06-28', what: 'speaker', cost: 60 }],
    private_to: 'household',
  }, '');
  memory.upsert_note('People/Sam.md', {
    type: 'person', id: 'p_sara01', name: 'Sam', relationship: 'family',
    anniversaries: [{ date: '07-11', what: 'wedding anniversary' }], private_to: 'household',
  }, '');
  // A visitor whose birthday is FAR from their visit → no coincidence.
  memory.upsert_note('People/Mike.md', {
    type: 'person', id: 'p_mike01', name: 'Mike', relationship: 'friend',
    birthday: '12-01', private_to: 'household',
  }, '');
  // A person with a birthday that day, but only a NON-visit event → no coincidence.
  memory.upsert_note('People/Nina.md', {
    type: 'person', id: 'p_nina01', name: 'Nina', relationship: 'colleague',
    birthday: '06-29', private_to: 'household',
  }, '');
  // The owner's own note — never a "visitor".
  memory.upsert_note('People/Jasper.md', {
    type: 'person', id: 'p_self01', name: 'Jasper', relationship: 'self',
    birthday: '06-26', private_to: 'household',
  }, '');

  const le = (fm: Record<string, unknown>) => memory.upsert_note(`Household/Calendar/${fm.id}.md`, { type: 'life_event', source: 'calendar', ...fm }, `# ${fm.title}`);
  // ── Visit events (Rule 1) ──────────────────────────────────────────────────
  le({ id: 'le_lee001', title: 'Kim visits', category: 'trip', owner: 'jasper', participants: ['jasper', 'Kim'], event_date: '2026-06-26T18:00:00Z', end_date: '2026-06-29T18:00:00Z', actionable: true, private_to: 'household' });
  le({ id: 'le_sara01', title: 'Sam comes to town', category: 'visit', owner: 'sam', participants: ['Sam'], event_date: '2026-07-10T18:00:00Z', end_date: '2026-07-12T18:00:00Z', actionable: true, private_to: 'sam' });
  le({ id: 'le_mike01', title: 'Mike visits', category: 'trip', owner: 'jasper', event_date: '2026-06-27T18:00:00Z', end_date: '2026-06-28T18:00:00Z', actionable: true, private_to: 'household' });
  le({ id: 'le_nina01', title: 'Nina 1:1', category: 'meeting', owner: 'jasper', participants: ['Nina'], event_date: '2026-06-29T18:00:00Z', actionable: false, private_to: 'household' });
  // ── Conflict events (Rule 2) ───────────────────────────────────────────────
  le({ id: 'le_dent01', title: 'Dentist', category: 'appointment', owner: 'sam', event_date: '2026-06-22T14:00:00Z', end_date: '2026-06-22T15:00:00Z', actionable: true, private_to: 'sam' });
  le({ id: 'le_bank01', title: 'Call with the bank', category: 'appointment', owner: 'sam', event_date: '2026-06-22T14:30:00Z', end_date: '2026-06-22T15:30:00Z', actionable: true, private_to: 'sam' });
  // jasper event overlapping sam's dentist in TIME but DIFFERENT owner → no fire.
  le({ id: 'le_jcall1', title: 'Jasper call', category: 'meeting', owner: 'jasper', event_date: '2026-06-22T14:15:00Z', end_date: '2026-06-22T15:15:00Z', actionable: false, private_to: 'household' });
  // jasper events that do NOT overlap → no fire.
  le({ id: 'le_gym001', title: 'Gym', category: 'meeting', owner: 'jasper', event_date: '2026-06-23T09:00:00Z', end_date: '2026-06-23T10:00:00Z', actionable: false, private_to: 'household' });
  le({ id: 'le_lunch1', title: 'Lunch', category: 'meeting', owner: 'jasper', event_date: '2026-06-23T12:00:00Z', end_date: '2026-06-23T13:00:00Z', actionable: false, private_to: 'household' });
  // two ALL-DAY same-owner events on a day → not a scheduling conflict.
  le({ id: 'le_ad0001', title: 'Holiday', category: 'other', owner: 'jasper', event_date: '2026-06-24', actionable: false, private_to: 'household' });
  le({ id: 'le_ad0002', title: 'Yard day', category: 'other', owner: 'jasper', event_date: '2026-06-24', actionable: false, private_to: 'household' });
  // Two DUPLICATE notes of ONE real event (shared calendar → distinct ids, same
  // title + start) → collapsed by dedupe; must NOT self-pair into a double-booking
  // (the live "Ann Kent ^ Ann Kent" artifact this guards against).
  le({ id: 'le_dup001', title: 'Town Hall', category: 'meeting', owner: 'jasper', event_date: '2026-06-25T10:00:00Z', end_date: '2026-06-25T11:00:00Z', actionable: false, private_to: 'household' });
  le({ id: 'le_dup002', title: 'Town Hall', category: 'meeting', owner: 'jasper', event_date: '2026-06-25T10:00:00Z', end_date: '2026-06-25T11:00:00Z', actionable: false, private_to: 'household' });
  await rebuild(vault, memory, db);

  const OPTS = { visit_within_days: 45, occasion_pad_days: 3, conflict_within_days: 14 };
  const ctx = { memory, now, intent_id: 'i1', specialist_id: 'kate' } as unknown as ToolContext;

  // ── 1. First run (mock LLM) files the coincidences ─────────────────────────
  const tool = make_scan_cross_signals({ memory, proposals, llm: mock_llm });
  const r1 = await tool.execute(OPTS, ctx);
  check('first run enabled', r1.enabled === true);
  check('three coincidence proposals filed (Kim bday + Sam anniv + 1 double-book)', r1.filed === 3);

  const all = r1.proposal_ids.map((pid) => ({ pid, p: payload_of(db, pid), user: user_of(db, pid) }));
  const kim = all.find((x) => x.p.followup_kind === 'visitor_occasion' && x.p.person_name === 'Kim')!;
  const sam = all.find((x) => x.p.followup_kind === 'visitor_occasion' && x.p.person_name === 'Sam')!;
  const dbl = all.find((x) => x.p.followup_kind === 'double_booking')!;

  // ── 2. Flagship payload — occasion, likes, learned budget, cordon ──────────
  check('Kim coincidence is a birthday', kim.p.occasion_kind === 'birthday');
  check('Kim occasion resolved to 2026-06-28', kim.p.occasion_date === '2026-06-28');
  check('Kim carries his likes', JSON.stringify(kim.p.likes) === JSON.stringify(['hiking', 'dark chocolate']));
  check('Kim carries the LEARNED budget (median 40,60 = 50)', (kim.p.budget as { amount: number }).amount === 50);
  check('household visit → owner-global proposal (user_id null)', kim.user === null);
  check('Kim rationale is the warm planner phrasing', proposals.get(kim.pid)!.rationale_md === CANNED);

  // ── 3. Anniversary variant + member-private cordon ─────────────────────────
  check('Sam coincidence is an anniversary', sam.p.occasion_kind === 'anniversary');
  check('Sam occasion resolved to 2026-07-11', sam.p.occasion_date === '2026-07-11');
  check('Sam member-private visit → cordon scoped to sam', sam.user === 'sam');

  // ── 4. Double-booking — same owner, overlapping, cordoned ──────────────────
  const dbl_rat = proposals.get(dbl.pid)!.rationale_md ?? '';
  check('double-booking names both events', /Dentist/.test(dbl_rat) && /bank/i.test(dbl_rat));
  check('double-booking cordoned to sam', dbl.user === 'sam');

  // ── 5. NO false coincidences ───────────────────────────────────────────────
  check('Mike (far birthday) files nothing', !all.some((x) => x.p.person_name === 'Mike'));
  check('Nina (non-visit event) files nothing', !all.some((x) => x.p.person_name === 'Nina'));
  check('owner self never a visitor', !all.some((x) => x.p.person_name === 'Jasper'));
  check('exactly ONE double-booking (no cross-owner / non-overlap / all-day)', all.filter((x) => x.p.followup_kind === 'double_booking').length === 1);
  // The duplicate-note pair (same title+start) must collapse, never self-pair.
  check('duplicate notes of ONE event do NOT self-double-book', !all.some((x) => x.p.followup_kind === 'double_booking' && JSON.stringify(x.p).includes('Town Hall')));

  // ── 6. Edge dedup ──────────────────────────────────────────────────────────
  const r2 = await tool.execute(OPTS, ctx);
  check('second run files NOTHING new (edge dedup)', r2.filed === 0);

  // ── 7. No-LLM fallback (fail-open to a template) ───────────────────────────
  const db2 = open_db(join(tmp, 'h2.db'));
  const mem2 = new MemoryClient({ vault_root: vault, db: db2 });
  const prop2 = new ProposalsStore(db2);
  await rebuild(vault, mem2, db2);
  const r3 = await make_scan_cross_signals({ memory: mem2, proposals: prop2 })
    .execute(OPTS, { memory: mem2, now, intent_id: 'i2', specialist_id: 'kate' } as unknown as ToolContext);
  check('no-LLM run still files the coincidences', r3.filed === 3);
  const lee2 = r3.proposal_ids.map((pid) => ({ pid, p: payload_of(db2, pid) })).find((x) => x.p.person_name === 'Kim')!;
  const lee2_rat = prop2.get(lee2.pid)!.rationale_md ?? '';
  check('no-LLM rationale is the template (names Kim + a gift offer)', /Kim/.test(lee2_rat) && /gift/i.test(lee2_rat));
  db2.close();

  // ── 8. Kill switch ─────────────────────────────────────────────────────────
  delete process.env.HEARTH_CROSS_SIGNAL;
  check('kill switch reads off', cross_signal_enabled() === false);
  const db3 = open_db(join(tmp, 'h3.db'));
  const mem3 = new MemoryClient({ vault_root: vault, db: db3 });
  await rebuild(vault, mem3, db3);
  const r4 = await make_scan_cross_signals({ memory: mem3, proposals: new ProposalsStore(db3), llm: mock_llm })
    .execute(OPTS, { memory: mem3, now, intent_id: 'i3', specialist_id: 'kate' } as unknown as ToolContext);
  check('kill switch OFF → tool no-ops', r4.enabled === false && r4.filed === 0);
  db3.close();

  db.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n✅ smoke:cross-signal — ${passed} checks passed`);
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
