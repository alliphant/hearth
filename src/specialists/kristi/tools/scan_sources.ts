/**
 * scan_sources — Kristi's knowledge-layer scraper, SEARCH-FIRST.
 *
 * Runs her seed queries through SearXNG (`web_search`), takes the top current
 * results, and ingests each via `ingest_to_library` — which itself escalates
 * Firecrawl→the workstation (browse_url) on bot-blocked pages. So the sweep
 * self-heals against URL churn (a vendor reorganizing its site just changes
 * which URL the search returns) instead of blind-fetching hardcoded deep links
 * that 404. Everything lands RAG/FTS5-searchable on her shelf; her deliberation
 * then READS the clippings and records structured rows via the record_* tools.
 *
 * Conditional: a URL ingested within `min_interval_hours` is skipped unless
 * `force`. Background-job tool (heavy); per-item failures are captured, never
 * thrown.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { getKristiWorkstationsStore } from '@memory/stores/kristi_workstations';
import { make_ingest_to_library } from '@connectors/ingest_to_library';
import { web_search } from '@connectors/searxng';
import { BACKGROUND_MAX_AGE_MS } from '@connectors/search_router';
import { SEED_QUERIES, type SeedQuery } from '../sources';

const DEFAULT_MIN_INTERVAL_HOURS = 20; // a daily run skips a same-day re-ingest
const DEFAULT_MAX_PER_RUN = 16; // bound total ingests (heavy) per invocation
const DEFAULT_PER_QUERY = 2; // top-N search hits to ingest per seed query
/**
 * Hard ceiling on SEARCHES per invocation (2026-07-28).
 *
 * DEFAULT_MAX_PER_RUN bounds INGESTS, not searches — the loop keeps searching
 * while results are skipped as already-ingested, which on a steady-state shelf
 * (where almost everything IS already ingested) means it walked nearly the
 * whole seed list every run. With this tool on four scheduled slots a day, that
 * was the single largest source of provider calls in the household. Coverage
 * does not suffer: the rotation below means consecutive runs start from
 * different variants, so the full list is still swept over a few days.
 */
const DEFAULT_MAX_SEARCHES = 14;

/**
 * Round-robin the seed queries across their coverage buckets so a bounded run
 * SPREADS across vendors + classes instead of draining the array in order
 * (HP-desktop first → Lenovo / MWS / entry tier starved). Depth across runs is
 * carried by the existing per-URL recency skip: a re-run skips already-ingested
 * URLs, so the next run's budget flows to still-uncovered buckets. Bucket order
 * is stable (insertion order) so coverage is deterministic.
 *
 * `rotation` (2026-07-28) picks WHICH variant within each bucket leads. Several
 * buckets hold near-duplicate hand-written phrasings of one intent — e.g.
 *   'Dell Precision tower workstation lineup specifications site:dell.com'
 *   'Dell Pro Precision tower workstation lineup specifications site:dell.com'
 *   'Dell Precision entry tower SFF workstation specifications site:dell.com'
 * — which return largely the same pages for three separate provider calls.
 * Rotating by day means one run issues ONE of them and the others come up on
 * later days, so coverage is preserved across the week while a single run costs
 * a fraction of the calls. (The router's semantic collapse catches these too;
 * this stops them being generated in the first place, which is cheaper still.)
 */
function interleave_by_bucket(queries: SeedQuery[], rotation = 0): SeedQuery[] {
  const buckets = new Map<string, SeedQuery[]>();
  for (const q of queries) {
    const b = q.bucket ?? q.category;
    const list = buckets.get(b);
    if (list) list.push(q);
    else buckets.set(b, [q]);
  }
  // Rotate each bucket's variants so the lead query differs run to run.
  const lists = [...buckets.values()].map((l) =>
    l.length <= 1 ? l : l.map((_, i) => l[(i + rotation) % l.length]!),
  );
  const out: SeedQuery[] = [];
  for (let i = 0; ; i++) {
    let added = false;
    for (const l of lists) {
      const q = l[i];
      if (q) { out.push(q); added = true; }
    }
    if (!added) break;
  }
  return out;
}

const InputSchema = z
  .object({
    categories: z
      .array(z.enum(['vendor', 'nvidia', 'benchmark', 'isv', 'frontier', 'analyst']))
      .optional()
      .describe('Which source categories to sweep. Omit for all. `analyst` = public analyst-firm / market-direction coverage (its own WEEKLY job).'),
    force: z.boolean().default(false).describe('Re-ingest even if fetched recently.'),
    max: z.number().int().min(1).max(20).optional().describe('Cap total ingests per run.'),
    max_searches: z
      .number()
      .int()
      .min(1)
      .max(64)
      .optional()
      .describe('Cap total SEARCHES per run (distinct from `max`, which caps ingests).'),
    per_query: z.number().int().min(1).max(5).optional().describe('Top-N search hits to ingest per query.'),
    min_interval_hours: z.number().min(0).optional(),
  })
  .strict();
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
  ok: z.boolean(),
  searched: z.number(),
  ingested: z.array(z.object({ url: z.string(), title: z.string().nullable(), via_query: z.string() })),
  skipped: z.array(z.object({ url: z.string(), reason: z.string() })),
  failed: z.array(z.object({ url: z.string(), error: z.string() })),
});
type Output = z.infer<typeof OutputSchema>;

export function create(deps: ToolDeps): Tool<Input, Output> {
  const ingest = make_ingest_to_library({
    library_deps: {
      db: deps.db,
      vault_root: deps.vault_root,
      memory: deps.memory,
      specialists: deps.specialists,
      runtime: deps.runtime,
      conversations: deps.conversations,
      llm: deps.llm,
      events: deps.events,
    },
    specialists: deps.specialists,
    users: deps.users,
  });

  return {
    name: 'scan_sources',
    description:
      "Search-first knowledge sweep: run Kristi's seed queries through SearXNG, then ingest the top current results onto her library shelf (Firecrawl→the workstation fallback) so they're searchable. Self-heals against URL churn — no hardcoded deep links. Skips URLs ingested recently unless `force`. Use `categories` to sweep a slice; after scanning, read the new clippings (search_library) and record structured rows with the record_* tools.",
    risk: 'write_internal',
    required_capabilities: ['write_vault_any_library', 'query_web'],
    weight: 'heavy',
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const c = (input.categories ?? ['vendor', 'nvidia', 'benchmark', 'isv', 'frontier', 'analyst']).slice().sort().join(',');
      const hour = new Date().toISOString().slice(0, 13);
      return `scan_sources:${c}:${hour}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const store = getKristiWorkstationsStore();
      const min_ms = (input.min_interval_hours ?? DEFAULT_MIN_INTERVAL_HOURS) * 3_600_000;
      const cats = new Set(input.categories ?? ['vendor', 'nvidia', 'benchmark', 'isv', 'frontier', 'analyst']);
      const max = input.max ?? DEFAULT_MAX_PER_RUN;
      const max_searches = input.max_searches ?? DEFAULT_MAX_SEARCHES;
      const per_query = input.per_query ?? DEFAULT_PER_QUERY;
      const now = Date.now();

      const ingested: Output['ingested'] = [];
      const skipped: Output['skipped'] = [];
      const failed: Output['failed'] = [];
      const seen_urls = new Set<string>();
      let searched = 0;
      let ok = true;

      // Rotate the per-bucket lead query by day so consecutive runs don't
      // re-issue the same near-duplicate phrasings (see interleave_by_bucket).
      const rotation = Math.floor(now / 86_400_000);
      const queries = interleave_by_bucket(
        SEED_QUERIES.filter((q) => cats.has(q.category)),
        rotation,
      );
      for (const sq of queries) {
        if (ingested.length >= max) break;
        // Bound SEARCHES, not just ingests: on a steady-state shelf almost every
        // result is skipped as already-ingested, so the ingest cap alone let a
        // run walk the whole seed list and pay for every query.
        if (searched >= max_searches) break;
        let results: Array<{ title: string; url: string }> = [];
        try {
          const res = await web_search.execute(
            {
              query: sq.query,
              max_results: per_query,
              // Vendor spec sheets change on a weekly-or-slower cadence and this
              // tool re-runs the SAME seeds daily; 30-minute freshness bought
              // nothing and guaranteed a provider call every run.
              max_age_ms: BACKGROUND_MAX_AGE_MS,
            },
            ctx,
          );
          searched++;
          if (res.error) { failed.push({ url: `search:${sq.query}`, error: res.error }); ok = false; continue; }
          results = res.results.slice(0, per_query);
        } catch (err) {
          ok = false;
          failed.push({ url: `search:${sq.query}`, error: err instanceof Error ? err.message : String(err) });
          continue;
        }

        for (const r of results) {
          if (ingested.length >= max) break;
          if (!r.url || seen_urls.has(r.url)) continue;
          seen_urls.add(r.url);
          if (!input.force) {
            const prior = store.get_source_sync(r.url);
            if (prior && now - Date.parse(prior.synced_at) < min_ms) {
              skipped.push({ url: r.url, reason: 'fetched recently' });
              continue;
            }
          }
          try {
            const out = await ingest.execute(
              { target_specialist_id: 'kristi', url: r.url, title_hint: r.title || undefined },
              ctx,
            );
            if (out.rejected) {
              skipped.push({ url: r.url, reason: `rejected: ${out.rejection_reason ?? 'shell'}` });
            } else {
              store.record_source_sync(r.url, { content_hash: out.wrapper_note_path ?? null });
              ingested.push({ url: r.url, title: out.title, via_query: sq.query });
            }
          } catch (err) {
            ok = false;
            failed.push({ url: r.url, error: err instanceof Error ? err.message : String(err) });
          }
        }
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kristi',
        tool_name: 'scan_sources',
        tool_input: { categories: [...cats] },
        execution_result: { ok, searched, ingested: ingested.length, skipped: skipped.length, failed: failed.length },
      });

      return { ok, searched, ingested, skipped, failed };
    },
  };
}
