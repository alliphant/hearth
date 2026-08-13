/**
 * Manually run Anna's your county County assessor-roll sync — the exact tool the
 * daily 03:30 background job (`refresh_county_assessor_roll` in anna.yaml)
 * fires. Use it to populate the cache immediately after a deploy instead of
 * waiting for the overnight run, or to force a refresh.
 *
 * Streams the ~227MB county public CSVs into the local cache DB
 * (HEARTH_ASSESSOR_DB_PATH, default beside hearth.db) that lookup_parcel /
 * find_comps read. Always forces (a manual run means "do it now").
 *
 *   # in prod (inside the orchestrator container, where bun + env live):
 *   cd /docker && docker compose exec hearth-orchestrator \
 *     bun run scripts/sync-county-assessor.ts
 *
 *   # subset:
 *   ... bun run scripts/sync-county-assessor.ts sales account
 */
import { create } from '../src/specialists/anna/tools/sync_county_assessor_data';

const VALID = ['account', 'value-detail', 'improvement', 'sales'] as const;
const tables = process.argv.slice(2).filter((a) => (VALID as readonly string[]).includes(a));

const tool = create({ memory: { log_action: () => '' } } as never);
const started = Date.now();
console.log(`[sync-county] starting (force) ${tables.length ? tables.join(',') : 'all tables'}…`);

const r = await tool.execute(
  { force: true, ...(tables.length ? { tables } : {}) } as never,
  { intent_id: 'manual-sync', now: new Date(), specialist_id: 'anna' } as never,
);

console.log(`[sync-county] done in ${Math.round((Date.now() - started) / 1000)}s, ok=${r.ok}:`);
for (const row of r.results) {
  console.log(`  ${row.table.padEnd(14)} ${String(row.rows).padStart(8)} rows  ${String(row.ms).padStart(7)}ms  ${row.error ?? ''}`);
}
process.exit(r.ok ? 0 : 1);
