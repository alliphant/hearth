/**
 * Smoke test for Beatrice's scrum / dev-board engine.
 *
 *   bun run scripts/smoke-scrum.ts
 *
 * Exercises the store end-to-end against a throwaway DB: project + sprint +
 * epics (feature/bug, scored/unscored), the deterministic ranking (critical bug
 * tops; ROI orders the rest; unscored sinks), the lane-transition event log,
 * commit → say/do + backend/iOS split, burndown, and the markdown/pane renders.
 * Asserts the invariants and exits non-zero on any failure.
 */

import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { ScrumStore } from '@memory/stores/scrum';
import { render_scrum_canvas_md, render_scrum_search_md, render_standup_entry_md } from '@core/scrum_render';
import { scrum_pane_blocks } from '@core/scrum_pane';
import { MemoryClient } from '@memory/client';
import { local_iso_date } from '@core/time';
import type { ToolContext } from '@core/tool';
import { write_standup_snapshot } from '../src/specialists/trainer/tools/write_standup_snapshot';
import { Hono } from 'hono';
import { create_scrum_router, build_develop_directive } from '@app/routes/scrum';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ FAIL: ${msg}`);
    failures++;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'scrum-smoke-'));
const db = open_db(join(dir, 'scrum.db'));
const store = new ScrumStore(db);

console.log('· project + sprint');
const project = store.create_project({ name: 'Scrum Tool', slug: 'scrum-tool', board: 'backend' });
assert(!!project.id, 'project created');
const sprint = store.create_sprint({
  label: 'Sprint 1',
  start_date: '2026-06-05',
  end_date: '2026-06-12',
  capacity_pts: 10,
});
assert(store.open_sprint()?.id === sprint.id, 'open sprint is the one created');
let threw = false;
try {
  store.create_sprint({ label: 'Sprint 2', start_date: '2026-06-12', end_date: '2026-06-19' });
} catch {
  threw = true;
}
assert(threw, 'second open sprint refused (single-open invariant)');

console.log('· epics (feature/bug, scored/unscored)');
const quickWin = store.create_epic({ project_id: project.id, title: 'Quick win', type: 'feature', size: 'S', value: 'L' });
const strategic = store.create_epic({ project_id: project.id, title: 'Strategic', type: 'feature', size: 'M', value: 'L' });
const fillIn = store.create_epic({ project_id: project.id, title: 'Fill-in', type: 'feature', size: 'S', value: 'M' });
const unscored = store.create_epic({ project_id: project.id, title: 'Unscored', type: 'feature' });
const critBug = store.create_epic({ project_id: project.id, title: 'Crash on launch', type: 'bug', severity: 'critical', size: 'M', board: 'ios' });
const lowBug = store.create_epic({ project_id: project.id, title: 'Typo', type: 'bug', severity: 'low', size: 'S' });

console.log('· ranking');
const board0 = store.read_board();
const backlog = board0.lanes.product_backlog;
assert(backlog[0]?.id === critBug.id, 'critical bug ranks first');
assert(backlog[backlog.length - 1]?.id === unscored.id, 'unscored sinks to the bottom');
assert(backlog.find((c) => c.id === unscored.id)?.unscored === true, 'unscored epic is flagged');
assert(backlog.find((c) => c.id === quickWin.id)?.quadrant === 'Quick Win', 'quick-win quadrant computed');
const qwRoi = backlog.find((c) => c.id === quickWin.id)?.roi;
assert(qwRoi === 5, `quick win ROI = 5 (got ${qwRoi})`);

console.log('· lane moves + event log');
store.move_epic(strategic.id, 'sprint_backlog');
store.move_epic(strategic.id, 'in_progress');
store.move_epic(strategic.id, 'done');
const events = db
  .prepare(`SELECT to_lane FROM scrum_epic_events WHERE epic_id = @id ORDER BY ts_created`)
  .all({ '@id': strategic.id }) as Array<{ to_lane: string }>;
// create logs (null→product_backlog) + 3 moves = 4 rows.
assert(events.length === 4, `4 lane events logged for the moved epic (got ${events.length})`);
assert(events[events.length - 1]?.to_lane === 'done', 'last event lands in done');

console.log('· commit gate — unscored is refused');
let gateThrew = false;
try {
  store.commit_sprint([quickWin.id, unscored.id]); // unscored not yet scored here
} catch {
  gateThrew = true;
}
assert(gateThrew, 'commit_sprint refuses an unscored epic (deterministic gate)');

console.log('· commit → say/do + split');
store.commit_sprint([quickWin.id, strategic.id, critBug.id]);
const board1 = store.read_board();
// committed effort: quickWin S=1, strategic M=3, critBug M=3 → 7; shipped = strategic (done) = 3.
assert(board1.say_do.committed === 7, `committed pts = 7 (got ${board1.say_do.committed})`);
assert(board1.say_do.shipped === 3, `shipped pts = 3 (got ${board1.say_do.shipped})`);
assert(board1.say_do.pct === 43, `say/do pct = 43 (got ${board1.say_do.pct})`);
// split: quickWin(1) + strategic(3) on backend = 4; critBug(3) on ios.
assert(board1.split.backend === 4, `backend split = 4 (got ${board1.split.backend})`);
assert(board1.split.ios === 3, `ios split = 3 (got ${board1.split.ios})`);

console.log('· burndown + renders');
const burn = store.burndown();
assert(burn.length >= 1, `burndown produced ${burn.length} point(s)`);
const md = render_scrum_canvas_md(store);
assert(md.includes('# Hearth Dev Board'), 'canvas markdown has the h1');
assert(md.includes('Burndown') && md.includes('xychart-beta'), 'canvas markdown has a burndown mermaid chart');
assert(md.includes('Ranked backlog'), 'canvas markdown has the ranked backlog table');
const blocks = scrum_pane_blocks(db);
assert(blocks.length > 0, `pane composed ${blocks.length} block(s)`);
assert(blocks[0]?.type === 'hero_metric', 'pane leads with a hero_metric');

console.log('· shipped history (roadmap / work done)');
const shipped = store.shipped_history();
assert(shipped.some((s) => s.id === strategic.id), 'shipped history includes the epic moved to done');
assert(shipped.find((s) => s.id === strategic.id)?.shipped_at != null, 'shipped epic carries a shipped_at timestamp');
assert(shipped.every((s) => s.title), 'every shipped row has a title');

console.log('· importer upsert idempotency (source_key)');
const u1 = store.upsert_epic_by_source('next:test', { project_id: project.id, title: 'Imported item', description: 'v1', board: 'backend' });
assert(u1.created === true, 'first upsert creates');
store.move_epic(u1.epic.id, 'in_progress'); // simulate human grooming
const u2 = store.upsert_epic_by_source('next:test', { project_id: project.id, title: 'Imported item (renamed)', description: 'v2', board: 'ios' });
assert(u2.created === false && u2.epic.id === u1.epic.id, 'second upsert updates the same epic (no duplicate)');
assert(u2.epic.title === 'Imported item (renamed)', 'upsert refreshes the title');
assert(u2.epic.lane === 'in_progress', 'upsert preserves the human-moved lane (does not reset to backlog)');

console.log('· batch score (grooming primitive)');
const sr = store.score_epics([{ epic_id: unscored.id, size: 'S', value: 'L' }, { epic_id: 'nope', size: 'M' }]);
assert(sr.scored === 1, 'scored the 1 valid epic');
assert(sr.not_found.length === 1 && sr.not_found[0] === 'nope', 'reports not-found ids');
const rescored = store.read_board().lanes.product_backlog.find((c) => c.id === unscored.id);
assert(!!rescored && rescored.unscored === false, 'previously-unscored epic is now scored');
assert(!!rescored && rescored.roi === 5, `batch-scored S/L epic gets ROI 5 (got ${rescored?.roi})`);

console.log('· keyword search (resolve a title → id, no human-pasted sep_…)');
// single distinctive keyword, case-insensitive → the one epic, by id
const byWord = store.search_epics('CRASH');
assert(byWord.length === 1 && byWord[0]?.id === critBug.id, 'single keyword resolves the matching epic by id (case-insensitive)');
// multi-term: every term must match, order-independent + non-contiguous
const multi = store.search_epics('launch crash');
assert(multi.some((e) => e.id === critBug.id), 'multi-term (reordered, non-contiguous) still matches');
// description is searched too, not just the title
assert(store.search_epics('v2').some((e) => e.id === u1.epic.id), 'description text is searched, not just the title');
// a real miss returns empty — she should report "no match", not beg for an id
assert(store.search_epics('zzz nonexistent').length === 0, 'no match returns empty');
// LIKE wildcards in the query are escaped — `_` matches a literal underscore
const underscore = store.create_epic({ project_id: project.id, title: 'role_play notes', type: 'feature' });
store.create_epic({ project_id: project.id, title: 'roleXplay decoy', type: 'feature' });
const esc = store.search_epics('role_play');
assert(esc.length === 1 && esc[0]?.id === underscore.id, 'LIKE wildcard in the query is escaped (literal _, not any-char)');
// lane scoping
assert(store.search_epics('strategic', { lane: 'done' }).some((e) => e.id === strategic.id), 'lane filter finds the epic in its lane');
assert(store.search_epics('strategic', { lane: 'product_backlog' }).length === 0, 'lane filter excludes other lanes');
// blank query → empty, never a full dump
assert(store.search_epics('   ').length === 0, 'blank query returns empty (no full dump)');
// id-forward markdown render carries the sep_ id Beatrice needs to act
const searchMd = render_scrum_search_md(store, 'crash', byWord);
assert(searchMd.includes(critBug.id), 'search render surfaces the epic id');

console.log('· archive (soft-delete — prune the board, recoverable)');
// archive an uncommitted backlog epic
const arch = store.archive_epic(fillIn.id);
assert(arch.archived === 1, 'archive sets archived=1');
assert(!Object.values(store.read_board().lanes).flat().some((c) => c.id === fillIn.id), 'archived epic is gone from read_board lanes');
assert(!store.list_epics().some((e) => e.id === fillIn.id), 'archived epic is gone from list_epics (default)');
assert(store.list_epics({ include_archived: true }).some((e) => e.id === fillIn.id), 'include_archived:true surfaces it');
assert(!store.search_epics('fill').some((e) => e.id === fillIn.id), 'archived epic is gone from keyword search');
assert(store.list_archived().some((e) => e.id === fillIn.id), 'list_archived shows it');
// a committed epic is protected (archiving would distort say/do)
let archThrew = false;
try { store.archive_epic(quickWin.id); } catch { archThrew = true; }
assert(archThrew, 'archive refuses an epic committed to the open sprint');
// unarchive restores it to its lane
const un = store.unarchive_epic(fillIn.id);
assert(un.archived === 0, 'unarchive clears the flag');
assert(store.read_board().lanes.product_backlog.some((c) => c.id === fillIn.id), 'unarchived epic is back on the board');
// an archived done-item drops out of shipped_history
const ghost = store.create_epic({ project_id: project.id, title: 'Ghost done item', type: 'feature', size: 'S', value: 'S' });
store.move_epic(ghost.id, 'done');
assert(store.shipped_history().some((s) => s.id === ghost.id), 'done item is in shipped_history before archive');
store.archive_epic(ghost.id);
assert(!store.shipped_history().some((s) => s.id === ghost.id), 'archived done item drops out of shipped_history');

console.log('· daily standup ceremony (write_standup_snapshot)');
// pure render — dated, self-contained board snapshot
const standupMd = render_standup_entry_md(store, '2026-06-07');
assert(standupMd.startsWith('## 2026-06-07 — standup'), 'standup render leads with the dated header');
assert(standupMd.includes('Say/Do'), 'standup render includes the say/do line');
assert(/Lanes: .*Backlog \d+/.test(standupMd), 'standup render includes lane counts');
// end-to-end write via the tool against a temp-vault MemoryClient
const memory = new MemoryClient({ vault_root: dir, db });
const standupCtx = {
  memory,
  now: new Date(),
  intent_id: 'standup-smoke',
  specialist_id: 'trainer',
} as unknown as ToolContext;
const sr1 = await write_standup_snapshot.execute({}, standupCtx);
assert(sr1.skipped === false, 'first standup write is not skipped');
const logAbs = join(dir, 'Knowledge', 'Trainer', 'standup-log.md');
assert(existsSync(logAbs), 'standup log note was written to the vault');
const today = local_iso_date(standupCtx.now);
assert(readFileSync(logAbs, 'utf8').includes(`## ${today} — standup`), "standup log carries today's entry");
// idempotent — a second run the same day is a no-op (one entry only)
const sr2 = await write_standup_snapshot.execute({}, standupCtx);
assert(sr2.skipped === true, 'second standup write the same day is skipped (idempotent)');
const dayCount = (readFileSync(logAbs, 'utf8').match(new RegExp(`## ${today} — standup`, 'g')) || []).length;
assert(dayCount === 1, 'standup log has exactly one entry for today');

console.log('· "start developing" (card → in_progress + Beatrice directed build)');
const builds: Array<{ directive: string; tools: string[] }> = [];
const devApp = new Hono<{ Variables: { user: { tier: string } } }>();
devApp.use('*', (c, next) => { c.set('user', { tier: 'owner' }); return next(); });
devApp.route('/', create_scrum_router({ db, fire_directed_build: (directive, tools) => builds.push({ directive, tools }) }));
// backend backlog epic → moves to In Progress + kicks off a build
const devEpic = store.create_epic({ project_id: project.id, title: 'Wire a new connector recovery hint', type: 'feature', size: 'M', value: 'L', board: 'backend' });
const dres = await devApp.request('/epic/' + devEpic.id + '/develop', { method: 'POST' });
const dbody = await dres.json();
assert(dres.status === 200 && dbody.building === true, 'backend epic kicks off a build (building:true)');
assert(store.get_epic(devEpic.id)?.lane === 'in_progress', 'develop moved the epic to In Progress');
assert(builds.length === 1 && builds[0]!.tools.includes('propose_code_edit') && builds[0]!.tools.includes('grep_codebase'), 'fire_directed_build got the build tool surface');
assert(builds[0]!.directive.includes(devEpic.title), 'the directive carries the epic title');
// iOS epic → moves, but no backend build fired (her pipeline is the backend repo)
const iosEpic = store.create_epic({ project_id: project.id, title: 'iOS card polish', type: 'feature', size: 'S', value: 'M', board: 'ios' });
builds.length = 0;
const ires = await devApp.request('/epic/' + iosEpic.id + '/develop', { method: 'POST' });
const ibody = await ires.json();
assert(ibody.building === false && builds.length === 0, 'iOS epic does NOT fire a backend build');
assert(store.get_epic(iosEpic.id)?.lane === 'in_progress', 'iOS epic still moved to In Progress');
// owner gate — a household-tier caller is refused
const guestApp = new Hono<{ Variables: { user: { tier: string } } }>();
guestApp.use('*', (c, next) => { c.set('user', { tier: 'household' }); return next(); });
guestApp.route('/', create_scrum_router({ db }));
const gres = await guestApp.request('/epic/' + devEpic.id + '/develop', { method: 'POST' });
assert(gres.status === 403, 'non-owner is blocked from develop');
// directive helper follows the directed-build rules
assert(build_develop_directive(store.get_epic(devEpic.id)!).includes('propose_code_edit'), 'directive names propose_code_edit (edit existing files)');

console.log('· note + retro + close');
store.add_note({ project_id: project.id, body: 'shipped strategic early', kind: 'progress' });
store.add_retro({ went_well: 'momentum', slipped: 'fill-in', lessons: 'score before grooming' });
store.close_sprint('wrapped');
assert(store.open_sprint() === null, 'sprint closed (no open sprint)');

db.close();
if (failures > 0) {
  console.error(`\n✗ ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\n✓ scrum engine smoke passed');
