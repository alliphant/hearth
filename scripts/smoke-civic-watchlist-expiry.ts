/**
 * smoke:civic-watchlist-expiry — the 71%-of-the-office fix (2026-07-31).
 *
 * Ruby's civic office held 136 active items; 96 of them (71%) were
 * unverified `watching` leads, the oldest two months old, and nothing could
 * ever retire one. `civic_items.status` has allowed `'expired'` since the
 * table was written and no code had ever set it.
 *
 * The bucket fills for a structural reason worth pinning: `watching` is the
 * evidence-quote gate's escape hatch. `record_civic_item` refuses an
 * `announcement` / `agenda_item` whose claim isn't backed by a verbatim
 * quote from a page read that turn — and all three of its rejection messages
 * end with "or record it as kind 'watching'". Correct steer, but with no
 * lifetime on the destination it made `watching` a free permanent disposal.
 *
 * Self-contained: temp vault + temp db, no network, no LLM.
 */
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

const ROOT = resolve(tmpdir(), `hearth-civic-expiry-smoke-${Date.now()}`);
mkdirSync(resolve(ROOT, 'data'), { recursive: true });
mkdirSync(resolve(ROOT, 'vault'), { recursive: true });
process.env.HEARTH_RUBY_CIVIC_DB_PATH = resolve(ROOT, 'data', 'ruby_civic.db');

import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import {
  civic_expiry_verdict,
  DEFAULT_CIVIC_EXPIRY,
  type ExpiryCandidate,
} from '../src/specialists/ruby/civic_analysis';
import { expire_civic_watchlist } from '../src/specialists/ruby/tools/expire_civic_watchlist';

let passed = 0, failed = 0;
const check = (n: string, c: boolean): void => {
  if (c) { console.log(`  ✓ ${n}`); passed++; } else { console.error(`  ✗ ${n}`); failed++; }
};

const NOW = new Date('2026-07-31T18:00:00.000Z');
const days_ago = (d: number): string => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const days_ahead = (d: number): string => new Date(NOW.getTime() + d * 86_400_000).toISOString();

const cand = (o: Partial<ExpiryCandidate>): ExpiryCandidate => ({
  kind: 'watching', status: 'active', event_at: null, ts_updated: days_ago(1), ...o,
});

// ── A. the pure verdict ─────────────────────────────────────────────────────
console.log('\nA. civic_expiry_verdict — the two ways a lead dies');

check('a fresh undated lead is kept', !civic_expiry_verdict(cand({ ts_updated: days_ago(3) }), NOW).expire);
check('an undated lead untouched 45d ages out', civic_expiry_verdict(cand({ ts_updated: days_ago(45) }), NOW).reason === 'unverified_and_stale');
check('  exactly at the 30d boundary it is still kept', !civic_expiry_verdict(cand({ ts_updated: days_ago(30) }), NOW).expire);
check('  just past it, it goes', civic_expiry_verdict(cand({ ts_updated: days_ago(31) }), NOW).expire);

// The live row this was built for: "Pleasantville 2026 Fourth of July
// celebration planning", filed June 1 with a July 4 date.
check('THE LIVE CASE: a July 4 lead filed June 1 is past on July 31',
  civic_expiry_verdict(cand({ event_at: '2026-07-04T00:00:00Z', ts_updated: days_ago(60) }), NOW).reason === 'event_passed');

check('a dated lead inside the 2d grace is kept', !civic_expiry_verdict(cand({ event_at: days_ago(1) }), NOW).expire);
check('a dated lead 3d past its date goes', civic_expiry_verdict(cand({ event_at: days_ago(3) }), NOW).reason === 'event_passed');

// A dated lead about something far off must NOT be aged out for being old:
// a note about a November hearing is filed months early by definition.
check('an UPCOMING dated lead survives regardless of age',
  !civic_expiry_verdict(cand({ event_at: days_ahead(90), ts_updated: days_ago(120) }), NOW).expire);

console.log('\nA2. what expiry must never touch');
check('a recorded announcement is never expired', !civic_expiry_verdict(cand({ kind: 'announcement', ts_updated: days_ago(300) }), NOW).expire);
check('an agenda_item is never expired', !civic_expiry_verdict(cand({ kind: 'agenda_item', ts_updated: days_ago(300) }), NOW).expire);
check('a council_meeting is never expired (the scan owns it)', !civic_expiry_verdict(cand({ kind: 'council_meeting', ts_updated: days_ago(300) }), NOW).expire);
check('a corridor_alert is never expired', !civic_expiry_verdict(cand({ kind: 'corridor_alert', ts_updated: days_ago(300) }), NOW).expire);
check('DISMISSED stays dismissed — a human "no" is not re-decided', !civic_expiry_verdict(cand({ status: 'dismissed', ts_updated: days_ago(300) }), NOW).expire);
check('re-deciding an already-expired row is a no-op', !civic_expiry_verdict(cand({ status: 'expired', ts_updated: days_ago(300) }), NOW).expire);

console.log('\nA3. never guess from a bad timestamp');
check('an unparseable event_at falls through to staleness (fresh → keep)', !civic_expiry_verdict(cand({ event_at: 'sometime in the fall', ts_updated: days_ago(2) }), NOW).expire);
check('an unparseable event_at + stale → expires', civic_expiry_verdict(cand({ event_at: 'TBD', ts_updated: days_ago(90) }), NOW).reason === 'unverified_and_stale');
check('an unparseable ts_updated is KEPT, never guessed', !civic_expiry_verdict(cand({ ts_updated: 'not a date' }), NOW).expire);
check('now is a parameter — the same row is live at an earlier now',
  !civic_expiry_verdict(cand({ ts_updated: days_ago(45) }), new Date('2026-06-20T00:00:00Z')).expire);
check('config is overridable', civic_expiry_verdict(cand({ ts_updated: days_ago(10) }), NOW, { ...DEFAULT_CIVIC_EXPIRY, stale_days: 7 }).expire);

// ── B. the store sweep ──────────────────────────────────────────────────────
console.log('\nB. expire_stale_civic_items — archive, tally, and what survives');

const db = open_db(resolve(ROOT, 'data', 'hearth.db'));
const memory = new MemoryClient({ db, vault_root: resolve(ROOT, 'vault') });
const U = 'jasper';

const put = (dedup_key: string, o: Partial<{ kind: string; title: string; event_at: string | null }>): string =>
  memory.record_civic_item({
    user_id: U,
    kind: (o.kind ?? 'watching') as never,
    title: o.title ?? dedup_key,
    summary: null,
    event_at: o.event_at ?? null,
    url: null,
    location_label: null,
    lat: null,
    lon: null,
    corridor_match: null,
    interest_score: 0.5,
    dedup_key,
    source: null,
  });

// Age a row's ts_updated the way two months of real passes would.
const age = (dedup_key: string, d: number): void => {
  db.prepare(`UPDATE civic_items SET ts_updated = @t WHERE user_id = @u AND dedup_key = @k`)
    .run({ '@t': days_ago(d), '@u': U, '@k': dedup_key });
};

put('w:stale', { title: 'Riverside-to-Mill Creek Trail Connector — research pending' });
age('w:stale', 60);
put('w:july4', { title: 'Pleasantville 2026 Fourth of July celebration planning', event_at: '2026-07-04T00:00:00Z' });
age('w:july4', 60);
put('w:fresh', { title: 'Flock successor contract — records request pending' });
put('w:upcoming', { title: 'November charter hearing', event_at: days_ahead(90) });
age('w:upcoming', 100);
put('a:recorded', { kind: 'announcement', title: 'Council adopted Ordinance 062' });
age('a:recorded', 200);

const before = memory.list_civic_items(U);
check('setup: 5 active items', before.length === 5);

const decide = (row: { kind: string; status: string; event_at: string | null; ts_updated: string }) =>
  civic_expiry_verdict(row, NOW);
const res = memory.expire_stale_civic_items(U, NOW, decide);

check('retires exactly the two dead leads', res.expired === 2);
check('tallies BY REASON', res.by_reason.event_passed === 1 && res.by_reason.unverified_and_stale === 1);

const after = memory.list_civic_items(U);
const keys = after.map((r) => r.dedup_key).sort();
check('the stale lead is gone from the office', !keys.includes('w:stale'));
check('the past-dated lead is gone', !keys.includes('w:july4'));
check('the fresh lead stays', keys.includes('w:fresh'));
check('the upcoming dated lead stays despite being 100d old', keys.includes('w:upcoming'));
check('the recorded announcement is untouched at 200d', keys.includes('a:recorded'));

console.log('\nB2. archived, not deleted');
const archived = db
  .prepare(`SELECT status, title, ts_created FROM civic_items WHERE user_id=@u AND dedup_key=@k`)
  .get({ '@u': U, '@k': 'w:stale' }) as { status: string; title: string; ts_created: string } | null;
check('the row still EXISTS', archived != null);
check("  with status 'expired'", archived?.status === 'expired');
check('  its title survives for "what were we watching in June?"', (archived?.title ?? '').includes('Riverside-to-Mill Creek'));
check('  and its original ts_created is preserved', typeof archived?.ts_created === 'string' && archived!.ts_created.length > 0);

console.log('\nB3. a second sweep is idempotent');
const again = memory.expire_stale_civic_items(U, NOW, decide);
check('nothing left to retire', again.expired === 0);
check('the office is unchanged', memory.list_civic_items(U).length === after.length);

// ── C. revival — the difference between expired and dismissed ───────────────
console.log('\nC. revival — expired is a machine verdict, dismissed is a human one');

// The story goes quiet for two months, then moves again. Re-recording is
// fresh evidence that the lead was not dead after all.
put('w:stale', { title: 'Riverside-to-Mill Creek Trail Connector — council funded design' });
const revived = memory.list_civic_items(U).find((r) => r.dedup_key === 'w:stale');
check('re-recording an EXPIRED lead revives it', revived != null);
check('  it comes back active', revived?.status === 'active');
check('  carrying the new title', (revived?.title ?? '').includes('council funded design'));
check('  and keeping its ORIGINAL ts_created', revived?.ts_created === archived?.ts_created);

// A dismissed item must behave the opposite way — that contract predates
// this work and expiry must not weaken it.
db.prepare(`UPDATE civic_items SET status='dismissed' WHERE user_id=@u AND dedup_key=@k`).run({ '@u': U, '@k': 'w:fresh' });
put('w:fresh', { title: 'Flock successor contract — new development' });
const dismissed = db
  .prepare(`SELECT status FROM civic_items WHERE user_id=@u AND dedup_key=@k`)
  .get({ '@u': U, '@k': 'w:fresh' }) as { status: string } | null;
check('a DISMISSED item is NOT revived by re-recording', dismissed?.status === 'dismissed');
check('  and stays out of the office', !memory.list_civic_items(U).some((r) => r.dedup_key === 'w:fresh'));

// ── D. per-user isolation ───────────────────────────────────────────────────
console.log('\nD. the sweep is per-user');
memory.record_civic_item({
  user_id: 'sam', kind: 'watching', title: 'Sam lead', summary: null, event_at: null, url: null,
  location_label: null, lat: null, lon: null, corridor_match: null, interest_score: 0.5,
  dedup_key: 'w:sam', source: null,
});
db.prepare(`UPDATE civic_items SET ts_updated=@t WHERE user_id='sam'`).run({ '@t': days_ago(90) });
const jasper_sweep = memory.expire_stale_civic_items(U, NOW, decide);
check("sweeping jasper does not touch sam's leads", jasper_sweep.expired === 0);
check("  sam's lead is still active", memory.list_civic_items('sam').length === 1);
check('  and sweeping sam retires it', memory.expire_stale_civic_items('sam', NOW, decide).expired === 1);

// ── E. the TOOL, run the way the scheduler runs it ──────────────────────────
console.log('\nE. the background-job path — no user in ctx');

// This section exists because the first version of this tool shipped with a
// `if (!ctx.user?.id) return { ok:false }` guard copied from record_civic_item
// (a CHAT tool). This is a BACKGROUND JOB: the loop driver invokes it
// directly, outside any user-scoped turn, so ctx.user is ALWAYS undefined and
// the sweep would have no-op'd every night at 04:45 while reporting ok:true.
// Section B tested the store method with an explicit user_id and so never
// touched the tool's own user resolution — which is exactly how it got past.
// Caught by firing the real job on the box, not by a test.
process.env.HEARTH_OWNER_USER_ID = U;
put('w:jobstale', { title: 'a lead nobody touched' });
age('w:jobstale', 90);

const job_ctx = {
  intent_id: 'smoke-job',
  memory,
  specialist_id: 'ruby',
  // NO `user` — this is what the scheduler passes.
} as unknown as Parameters<typeof expire_civic_watchlist.execute>[1];

const job_res = await expire_civic_watchlist.execute(
  { dry_run: false, stale_days: 30, event_grace_days: 2 } as never,
  job_ctx,
);
check('the job runs with NO user in ctx', job_res.ok === true);
check('  and reports no error', job_res.error === undefined);
check('  and actually retires the stale lead', job_res.expired >= 1);
check('  attributing it to the owner from HEARTH_OWNER_USER_ID',
  !memory.list_civic_items(U).some((r) => r.dedup_key === 'w:jobstale'));

// dry_run must be honest on the same path.
put('w:jobdry', { title: 'another stale lead' });
age('w:jobdry', 90);
const dry = await expire_civic_watchlist.execute(
  { dry_run: true, stale_days: 30, event_grace_days: 2 } as never,
  job_ctx,
);
check('dry_run reports what it WOULD retire', dry.expired >= 1);
check('  and changes nothing', memory.list_civic_items(U).some((r) => r.dedup_key === 'w:jobdry'));

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n  passed=${passed}  failed=${failed}`);
if (failed > 0) { console.error('\n✗ CIVIC-WATCHLIST-EXPIRY SMOKE FAILED'); process.exit(1); }
console.log('\n✓ CIVIC-WATCHLIST-EXPIRY SMOKE OK');
process.exit(0);
