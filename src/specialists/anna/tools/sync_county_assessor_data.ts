/**
 * sync_county_assessor_data — Anna's data pipeline.
 *
 * Streams the your county County assessor public roll (clean CSVs on Google Cloud
 * Storage, no auth) into the local cache DB that lookup_parcel / find_comps
 * query. The files are large (~44–96MB each), so this is a BACKGROUND JOB,
 * never a chat-turn tool — it's declared in anna.yaml's proactive.background_jobs
 * and runs off the conversation path. Each table is a clean truncate + reload
 * (the roll is a full snapshot, refreshed by the county per its RUNDATE).
 *
 * Source of record: https://www.county.gov/assessor/publicdata
 * Fetch path: direct GCS download (unauthenticated, programmatic-friendly).
 * No the workstation/browser needed — these are published bulk files, not the
 * bot-protected interactive parcel search.
 *
 * Risk write_internal; gated by read_property_records; weight heavy.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { getCountyAssessorStore } from '@memory/stores/assessor_county';
import { parseCsvStream } from '@memory/stores/_csv_stream';

const BASE = 'https://storage.googleapis.com/lc-public/asr';

type TableKey = 'account' | 'value-detail' | 'improvement' | 'sales' | 'owner';
const ALL_TABLES: TableKey[] = ['account', 'value-detail', 'improvement', 'sales', 'owner'];

const InputSchema = z.object({
  tables: z
    .array(z.enum(['account', 'value-detail', 'improvement', 'sales', 'owner']))
    .optional()
    .describe('Which roll tables to refresh. Omit to sync all five.'),
  force: z.boolean().default(false).describe('Ignore the stored ETag and re-download even if the county file is unchanged. The daily job leaves this false so a 304 (unchanged) costs ~nothing.'),
});
type Input = z.infer<typeof InputSchema>;

const TableResult = z.object({
  table: z.string(),
  rows: z.number(),
  ms: z.number(),
  unchanged: z.boolean().optional().describe('True when the county file was a 304 (ETag match) — skipped, no download.'),
  error: z.string().optional(),
});
const OutputSchema = z.object({
  ok: z.boolean(),
  results: z.array(TableResult),
});
type Output = z.infer<typeof OutputSchema>;

// Per-file download ceiling — the 96MB sales file over a slow link still
// needs to finish, so this is generous (10 min) and deliberately not the
// 15s connector default.
const FETCH_TIMEOUT_MS = 10 * 60 * 1000;

const DEST: Record<TableKey, 'parcels' | 'parcel_values' | 'improvements' | 'sales' | 'owners'> = {
  account: 'parcels',
  'value-detail': 'parcel_values',
  improvement: 'improvements',
  sales: 'sales',
  owner: 'owners',
};

async function sync_one(
  table: TableKey,
  store: ReturnType<typeof getCountyAssessorStore>,
  force: boolean,
): Promise<{ rows: number; ms: number; unchanged: boolean }> {
  const started = Date.now();
  const dest = DEST[table];

  // Conditional fetch: send the ETag from the last successful sync. If the
  // county hasn't republished, GCS returns 304 (no body) and we skip the
  // ~44–96MB download entirely. force=true omits the ETag to pull fresh.
  const prior_etag = force ? null : store.get_etag(dest);
  const headers: Record<string, string> = {
    Accept: 'text/csv',
    'User-Agent': 'hearth-anna/1.0 (+property-tax assistant)',
  };
  if (prior_etag) headers['If-None-Match'] = prior_etag;

  const res = await fetch(`${BASE}/assessor-public-${table}.csv`, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (res.status === 304) {
    return { rows: 0, ms: Date.now() - started, unchanged: true };
  }
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} fetching ${table}.csv`);
  }

  const ingest = (rows: Record<string, string>[]) => {
    switch (table) {
      case 'account': store.ingest_accounts(rows); break;
      case 'value-detail': store.ingest_values(rows); break;
      case 'improvement': store.ingest_improvements(rows); break;
      case 'sales': store.ingest_sales(rows); break;
      case 'owner': store.ingest_owners(rows); break;
    }
  };

  // Clean rebuild of this table, then stream rows in. Record the new ETag
  // only after a successful parse so a mid-stream failure retries next run.
  store.truncate(dest);
  const rows = await parseCsvStream(res.body, ingest, { batch_size: 5000 });
  store.record_sync(dest, rows, res.headers.get('etag'));
  return { rows, ms: Date.now() - started, unchanged: false };
}

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'sync_county_assessor_data',
    description:
      'BACKGROUND JOB ONLY (not a chat tool). Refresh the local your county County assessor cache from the county public roll CSVs (account / value-detail / improvement / sales). Large multi-minute download; lookup_parcel and find_comps read the cache this populates. Pass `tables` to refresh a subset; omit for a full rebuild.',
    risk: 'write_internal',
    required_capabilities: ['read_property_records'],
    weight: 'heavy',
    input_schema: InputSchema,
    output_schema: OutputSchema,

    // Reporting-only: the fields are authoritative, but per-table row counts are NESTED in results[] and the reader scans only top level, so `results` length (tables synced) is the coverable signal.
    yield: { produced: ['results'], armed: false },
    idempotency_key(input) {
      const t = (input.tables ?? ALL_TABLES).slice().sort().join(',');
      // Bucket by hour so a re-fire within the same hour de-dupes, but a
      // scheduled daily/weekly run always re-syncs.
      const hour = new Date().toISOString().slice(0, 13);
      return `sync_county_assessor_data:${t}:${hour}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const store = getCountyAssessorStore();
      const tables = input.tables ?? ALL_TABLES;
      const results: Output['results'] = [];
      let ok = true;
      // Per-table conditional fetch: a 304 (unchanged) costs ~nothing, so the
      // daily job is cheap and 227MB only moves when the county republishes.
      for (const table of tables) {
        try {
          const { rows, ms, unchanged } = await sync_one(table, store, input.force);
          results.push({ table: DEST[table], rows, ms, unchanged });
        } catch (err) {
          ok = false;
          results.push({
            table: DEST[table],
            rows: 0,
            ms: 0,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'anna',
        tool_name: 'sync_county_assessor_data',
        tool_input: { tables },
        execution_result: { ok, results },
      });
      return { ok, results };
    },
  };
}
