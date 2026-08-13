/**
 * Civic-ledger hygiene migration (2026-07-29) — one-shot, idempotent,
 * DRY-RUN BY DEFAULT. Pass --apply to write.
 *
 * Two defects the 2026-07-29 Ruby audit surfaced. Both are DATA, so neither
 * could be fixed by the code guards that now prevent recurrence:
 *
 *  1. DUPLICATE TOPIC SLUGS. One story accumulated under two threads —
 *     `flock-cameras` (10 developments) and `flock-camera-opposition` (7).
 *     The derived board therefore shows one fight twice, ages the halves
 *     independently, and the campaign opened 2026-07-29 linked to only one
 *     of them. Merging re-points the alias's events onto the canonical slug;
 *     every development is PRESERVED (the timeline is real reporting).
 *
 *  2. HEADING ROWS IN THE ROSTER. `civic_members` holds rows named
 *     "Councilmember" and "City Council" — agenda headings the vote
 *     extractor lifted into member_name before `is_plausible_member_name`
 *     gated that path. They are not people, and they sit under every
 *     receipts read.
 *
 * Conservative by construction:
 *   - Heading members are TOMBSTONED (active = 0), never deleted, and their
 *     civic_votes rows are left untouched. A vote row is a citation with a
 *     source_url; destroying one to tidy a display is the wrong trade, and
 *     `active = 0` is reversible with one UPDATE.
 *   - The topic merge only ever rewrites `topic`; no event is dropped. A
 *     dedup_key collision (the same headline+date already on the canonical
 *     topic) leaves the alias row in place rather than violating the unique
 *     index — reported, not forced.
 *
 * Usage (on the LLM host):
 *   docker exec -w /app hearth-orchestrator bun run scripts/migrate-civic-ledger-hygiene.ts
 *   docker exec -w /app hearth-orchestrator bun run scripts/migrate-civic-ledger-hygiene.ts --apply
 */
import { Database } from 'bun:sqlite';
import { is_plausible_member_name } from '../src/specialists/ruby/civic_analysis';

/** Alias slug -> canonical slug. Extend as duplicates are found. */
const TOPIC_MERGES: Record<string, string> = {
  'flock-camera-opposition': 'flock-cameras',
};

export interface HygienePlan {
  topic_moves: Array<{ from: string; to: string; events: number; blocked: number }>;
  heading_members: Array<{ id: string; name: string; votes: number }>;
}

/** Compute the plan. Pure w.r.t. the DB — reads only, so the dry run and the
 *  apply run agree by construction. Exported for the smoke. */
export function plan_hygiene(db: Database): HygienePlan {
  const topic_moves: HygienePlan['topic_moves'] = [];
  for (const [from, to] of Object.entries(TOPIC_MERGES)) {
    const rows = db
      .prepare(`SELECT id, dedup_key FROM civic_watch_events WHERE topic = ?`)
      .all(from) as Array<{ id: string; dedup_key: string }>;
    if (rows.length === 0) continue;
    let blocked = 0;
    for (const r of rows) {
      const clash = db
        .prepare(
          `SELECT 1 FROM civic_watch_events WHERE topic = ? AND dedup_key = ? AND id != ?`,
        )
        .get(to, r.dedup_key, r.id);
      if (clash) blocked++;
    }
    topic_moves.push({ from, to, events: rows.length - blocked, blocked });
  }

  const heading_members: HygienePlan['heading_members'] = [];
  const members = db
    .prepare(`SELECT id, name FROM civic_members WHERE active = 1`)
    .all() as Array<{ id: string; name: string }>;
  for (const m of members) {
    if (is_plausible_member_name(m.name)) continue;
    const votes = db
      .prepare(`SELECT COUNT(*) AS n FROM civic_votes WHERE member_name = ?`)
      .get(m.name) as { n: number };
    heading_members.push({ id: m.id, name: m.name, votes: votes.n });
  }
  return { topic_moves, heading_members };
}

/** Apply the plan. Idempotent — a second run finds nothing to do. */
export function apply_hygiene(db: Database, plan: HygienePlan): void {
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const mv of plan.topic_moves) {
      const rows = db
        .prepare(`SELECT id, dedup_key FROM civic_watch_events WHERE topic = ?`)
        .all(mv.from) as Array<{ id: string; dedup_key: string }>;
      for (const r of rows) {
        const clash = db
          .prepare(`SELECT 1 FROM civic_watch_events WHERE topic = ? AND dedup_key = ? AND id != ?`)
          .get(mv.to, r.dedup_key, r.id);
        if (clash) continue; // the development already exists on the canonical topic
        db.prepare(`UPDATE civic_watch_events SET topic = ?, ts_updated = ? WHERE id = ?`)
          .run(mv.to, now, r.id);
      }
    }
    for (const m of plan.heading_members) {
      db.prepare(`UPDATE civic_members SET active = 0, ts_updated = ? WHERE id = ?`).run(now, m.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

if (import.meta.main) {
  const apply = process.argv.includes('--apply');
  const path = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
  // bun:sqlite rejects an explicit `{readonly: false}` with SQLITE_MISUSE —
  // read-write is the default and must be requested by OMITTING the option.
  const db = apply ? new Database(path) : new Database(path, { readonly: true });
  const plan = plan_hygiene(db);

  console.log(`civic-ledger hygiene — ${apply ? 'APPLY' : 'DRY RUN'} against ${path}\n`);
  if (plan.topic_moves.length === 0) console.log('  topics: nothing to merge');
  for (const mv of plan.topic_moves) {
    console.log(`  topic: ${mv.from} → ${mv.to}  (${mv.events} developments move` +
      `${mv.blocked > 0 ? `, ${mv.blocked} already present and left in place` : ''})`);
  }
  if (plan.heading_members.length === 0) console.log('  roster: no heading rows');
  for (const m of plan.heading_members) {
    console.log(`  roster: tombstone "${m.name}" (active→0; ${m.votes} vote row(s) left untouched)`);
  }

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply to commit.');
  } else {
    apply_hygiene(db, plan);
    console.log('\nApplied.');
  }
  db.close();
}
