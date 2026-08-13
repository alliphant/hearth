/**
 * One-off backfill: set routed_to='trainer' on every miss with
 * status='escalated' where routed_to is null or some prior reporter.
 *
 * Why this exists: until the fix to apply_miss_action this session,
 * action='escalate' updated lifecycle status but left routed_to
 * pointing at whoever ran 'route' previously (usually Mariah). The
 * inbox flag did fire to trainer, but the queryable owner stayed
 * wrong — so Mariah's program_dashboard counted these as her queue
 * and Beatrice never appeared in any routed_to aggregate.
 *
 * Idempotent. Safe to re-run. Prints before/after counts and writes a
 * lifecycle note to each touched row so the trail is auditable.
 *
 * Usage: `bun run scripts/backfill-escalated-misses-trainer.ts`
 */

import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';

const DB_PATH = resolve(
  process.env.HEARTH_DB_PATH ??
    `${process.env.HOME ?? '/root'}/hearth/data/hearth.db`,
);

function run(): void {
  const db = new Database(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');

  const before = (
    db
      .prepare(
        `SELECT count(*) as n FROM process_misses
         WHERE status = 'escalated'
           AND (routed_to IS NULL OR routed_to <> 'trainer')`,
      )
      .get() as { n: number }
  ).n;
  console.log(`[backfill] ${before} escalated misses with wrong routed_to`);

  if (before === 0) {
    console.log('[backfill] nothing to do');
    return;
  }

  const now = new Date().toISOString();
  const note = `- [${now}] escalated -> escalated: backfill — routing escalated misses to trainer (apply_miss_action used to leave routed_to unchanged on escalate; fix shipped this session)`;

  db.transaction(() => {
    db.prepare(
      `UPDATE process_misses
          SET routed_to = 'trainer',
              ts_updated = @ts,
              notes_md = notes_md || char(10) || @note
        WHERE status = 'escalated'
          AND (routed_to IS NULL OR routed_to <> 'trainer')`,
    ).run({ '@ts': now, '@note': note });
  })();

  const after = (
    db
      .prepare(
        `SELECT count(*) as n FROM process_misses
         WHERE status = 'escalated' AND routed_to = 'trainer'`,
      )
      .get() as { n: number }
  ).n;
  console.log(`[backfill] ${after} escalated misses now routed_to=trainer`);
}

run();
