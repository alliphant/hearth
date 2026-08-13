/**
 * smoke:civic-hygiene — the civic-ledger hygiene migration (2026-07-29).
 * Temp DB, no network. Locks the two guarantees that make it safe to run on
 * real reporting: nothing is deleted, and a second run is a no-op.
 */
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
const ROOT = resolve(tmpdir(), `hearth-civic-hygiene-${Date.now()}`);
mkdirSync(ROOT, { recursive: true });

import { open_db } from '../src/memory/stores/structured';
import { plan_hygiene, apply_hygiene } from './migrate-civic-ledger-hygiene';

let passed = 0, failed = 0;
const check = (n: string, c: boolean): void => {
  if (c) { console.log(`  ✓ ${n}`); passed++; } else { console.error(`  ✗ ${n}`); failed++; }
};

const db = open_db(resolve(ROOT, 'h.db'));
const now = new Date().toISOString();
const ev = (id: string, topic: string, headline: string, at: string) =>
  db.prepare(`INSERT INTO civic_watch_events (id,user_id,topic,headline,event_at,status,dedup_key,ts_created,ts_updated)
              VALUES (?,?,?,?,?, 'open', ?, ?, ?)`)
    .run(id, 'jasper', topic, headline, at, `watch:${topic}:${at}:${headline}`, now, now);
const mem = (id: string, name: string) =>
  db.prepare(`INSERT INTO civic_members (id,user_id,name,active,dedup_key,ts_created,ts_updated)
              VALUES (?,?,?,1,?,?,?)`).run(id, 'jasper', name, name.toLowerCase(), now, now);

ev('e1', 'flock-cameras', 'Contract signed', '2026-01-10');
ev('e2', 'flock-camera-opposition', 'Residents petition', '2026-03-02');
ev('e3', 'flock-camera-opposition', 'Council hears comment', '2026-04-15');
mem('m1', 'Councilmember');
mem('m2', 'City Council');
mem('m3', 'Chris Barrett');
db.prepare(`INSERT INTO civic_votes (id,user_id,member_name,item_title,vote,source_url,dedup_key,ts_created,ts_updated)
            VALUES ('v1','jasper','Councilmember','Ordinance 141','nay','https://citygov.com/x','v1',?,?)`).run(now, now);

console.log('→ the plan sees both defects');
const plan = plan_hygiene(db);
check('flags the duplicate topic', plan.topic_moves[0]?.from === 'flock-camera-opposition' && plan.topic_moves[0]?.events === 2);
check('flags both heading rows', plan.heading_members.length === 2);
check('does NOT flag the real councilmember', !plan.heading_members.some((m) => m.name === 'Chris Barrett'));
check('counts the votes attached to a heading row', plan.heading_members.find((m) => m.name === 'Councilmember')?.votes === 1);

console.log('→ applying preserves every development and every vote');
apply_hygiene(db, plan);
const total = db.prepare(`SELECT COUNT(*) AS n FROM civic_watch_events`).get() as { n: number };
check('no development was deleted (3 in, 3 out)', total.n === 3);
const merged = db.prepare(`SELECT COUNT(*) AS n FROM civic_watch_events WHERE topic='flock-cameras'`).get() as { n: number };
check('all 3 now sit on the canonical topic', merged.n === 3);
const alias = db.prepare(`SELECT COUNT(*) AS n FROM civic_watch_events WHERE topic='flock-camera-opposition'`).get() as { n: number };
check('the alias topic is empty', alias.n === 0);
const votes = db.prepare(`SELECT COUNT(*) AS n FROM civic_votes`).get() as { n: number };
check('the vote row is UNTOUCHED (a citation is never destroyed)', votes.n === 1);

console.log('→ roster rows are tombstoned, not deleted');
const rows = db.prepare(`SELECT name, active FROM civic_members ORDER BY name`).all() as Array<{ name: string; active: number }>;
check('all 3 member rows still exist', rows.length === 3);
check('"Councilmember" is inactive', rows.find((r) => r.name === 'Councilmember')?.active === 0);
check('"City Council" is inactive', rows.find((r) => r.name === 'City Council')?.active === 0);
check('Chris Barrett stays active', rows.find((r) => r.name === 'Chris Barrett')?.active === 1);

console.log('→ idempotent');
const plan2 = plan_hygiene(db);
check('a second plan finds nothing to move', plan2.topic_moves.length === 0);
check('a second plan finds no heading rows', plan2.heading_members.length === 0);
apply_hygiene(db, plan2);
check('re-applying changes nothing', (db.prepare(`SELECT COUNT(*) AS n FROM civic_watch_events`).get() as { n: number }).n === 3);

db.close(); rmSync(ROOT, { recursive: true, force: true });
console.log(`\n  passed=${passed}  failed=${failed}`);
if (failed > 0) { console.error('\n✗ CIVIC-HYGIENE SMOKE FAILED'); process.exit(1); }
console.log('\n✓ CIVIC-HYGIENE SMOKE OK');
