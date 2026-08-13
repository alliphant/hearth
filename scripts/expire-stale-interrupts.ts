/**
 * expire-stale-interrupts — drain interrupts nobody ever actioned.
 *
 * An interrupt means "look at this now". One that has sat pending for weeks is
 * no longer a signal; it's a queue that buries the real ones. Found 2026-07-26:
 * 141 Cassandra interrupts raised 06-15 → 07-01, never resolved, roughly 30×
 * everything else in Kate's queue combined.
 *
 * DRY-RUN BY DEFAULT (the backfill-script idiom). Shows what it would close and
 * why; pass --apply to actually write. Marks them `dismissed`, which is the
 * honest status — nobody acted — rather than `acknowledged`, which would claim
 * someone did. Audited as `expire_stale_interrupts`.
 *
 *   bun run scripts/expire-stale-interrupts.ts --days=14
 *   bun run scripts/expire-stale-interrupts.ts --days=14 --from=cassandra --apply
 */
import { resolve } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { InterruptStore } from '@memory/stores/conversations';
import { ulid } from 'ulid';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function main() {
  const apply = process.argv.includes('--apply');
  const days = Number(arg('days') ?? '14');
  const from = arg('from');
  if (!Number.isFinite(days) || days <= 0) {
    console.error('--days must be a positive number');
    process.exit(2);
  }

  const db = open_db(resolve(process.env.HEARTH_DB_PATH ?? './data/hearth.db'));
  const interrupts = new InterruptStore(db);

  // Preview from the same predicate the store uses, so the dry run and the
  // apply can't disagree.
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT id, originating_specialist_id AS orig, routed_to, ts, substr(coalesce(summary,''),1,70) AS summary
         FROM interrupts
        WHERE status = 'pending' AND ts < @cutoff
          ${from ? 'AND originating_specialist_id = @orig' : ''}
        ORDER BY ts`,
    )
    .all(from ? { '@cutoff': cutoff, '@orig': from } : { '@cutoff': cutoff }) as Array<{
    id: string; orig: string; routed_to: string; ts: string; summary: string;
  }>;

  const by_source = new Map<string, number>();
  for (const r of rows) by_source.set(r.orig, (by_source.get(r.orig) ?? 0) + 1);

  console.log(`\nPending interrupts older than ${days}d${from ? ` from ${from}` : ''} (cutoff ${cutoff}):`);
  if (rows.length === 0) {
    console.log('  none — queue is clean.\n');
    return;
  }
  for (const [src, n] of [...by_source.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${src.padEnd(14)} ${String(n).padStart(4)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(14)} ${String(rows.length).padStart(4)}`);
  console.log(`  oldest ${rows[0]!.ts.slice(0, 10)} → newest ${rows[rows.length - 1]!.ts.slice(0, 10)}`);

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to close these.\n');
    return;
  }

  const closed = interrupts.expire_stale({ older_than_days: days, ...(from ? { originating_specialist_id: from } : {}) });
  try {
    db.prepare(
      `INSERT INTO audit_log (id, ts, intent_id, agent, tool_name, tool_input, execution_result)
       VALUES (@id, @ts, @intent, 'orchestrator', 'expire_stale_interrupts', @in, @out)`,
    ).run({
      '@id': ulid(),
      '@ts': new Date().toISOString(),
      '@intent': ulid(),
      '@in': JSON.stringify({ older_than_days: days, from: from ?? null }),
      '@out': JSON.stringify({ closed: closed.length, by_source: Object.fromEntries(by_source) }),
    });
  } catch (err) {
    // Best-effort — never fail the cleanup on the audit row.
    console.warn(`  (audit row not written: ${String(err).slice(0, 120)})`);
  }
  console.log(`\n✓ closed ${closed.length} stale interrupt(s) as 'dismissed'.\n`);
}

main();
