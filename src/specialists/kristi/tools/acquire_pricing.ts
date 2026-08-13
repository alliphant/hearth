/**
 * acquire_pricing — Kristi's FOCUSED price-acquisition job.
 *
 * The prices + commodity_prices tables stayed empty because nothing PRICED ever
 * reached her shelf: `scan_sources` seeds spec/overview queries ("…QuickSpecs
 * lineup"), so the clippings `extract_workstation_layer` reads contain specs,
 * not prices. The extractor wasn't broken — it had no priced text to lift.
 *
 * This closes that gap with a discovery step the layer extractor lacks, fused
 * with extraction into ONE bounded pass (no multi-round spiral):
 *   1. price-targeted SearXNG queries (PRICE_QUERIES in ../sources) surface
 *      pages that actually carry prices — reseller listings (CDW / Insight /
 *      Newegg Business), vendor "configure / starting at" pages, configurator
 *      option matrices, as-configured reviews;
 *   2. each top hit is fetched ONCE via fetch_with_browser_fallback
 *      (Firecrawl → the workstation warmed-Firefox on bot-block), and the SAME
 *      markdown is filed onto her shelf (ingest markdown-mode — no double
 *      fetch) so search_library + the layer extractors benefit next pass;
 *   3. ONE bounded LLM call over the freshly-fetched price text records BOTH
 *      system prices (record_price) and per-OEM commodity prices
 *      (record_commodity_price) — extracting from text we just fetched, NOT
 *      via RAG over a spec-dominated shelf (the proven failure point of the
 *      indirect path).
 *
 * Why fuse rather than lean on extract_workstation_layer's prices/commodity
 * layers: those read the shelf through `retrieve_scoped_chunks`, where price
 * chunks can rank below the larger spec corpus and never reach the top-k.
 * Extracting from the just-fetched text removes that variable. The layer
 * extractors stay scheduled as a belt-and-suspenders second reader once price
 * pages are on the shelf.
 *
 * On the COMMODITY spread: a genuine per-OEM spread needs the SAME commodity
 * priced for ≥2 OEMs. A standalone street price (a bare card at a reseller) is
 * vendor-agnostic — it CANNOT be honestly attributed to an OEM, so those land
 * as vendor 'other'. The honest per-OEM signal is a config-delta (same OEM
 * platform, two priced variants differing by one component) or a statically-
 * rendered configurator option matrix. The extraction prompt is steered toward
 * those; the output reports how many distinct OEMs the spread covers so thin
 * coverage is VISIBLE (the escalation trigger to a configurator-driver), never
 * silently assumed away.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  getKristiWorkstationsStore,
  type Vendor,
  type PriceSegment,
  type CommodityClass,
} from '@memory/stores/kristi_workstations';
import { make_ingest_to_library } from '@connectors/ingest_to_library';
import { fetch_with_browser_fallback } from '@connectors/fetch_with_browser_fallback';
import { web_search } from '@connectors/searxng';
import { BACKGROUND_MAX_AGE_MS } from '@connectors/search_router';
import { PRICE_QUERIES, type PriceVendor } from '../sources';

const DEFAULT_MIN_INTERVAL_HOURS = 20; // a daily run skips a same-day re-fetch
const DEFAULT_MAX_PER_RUN = 8; // bound total fetches (heavy) per invocation
const DEFAULT_PER_QUERY = 2; // top-N search hits to fetch per price query
const MAX_EXTRACT_CHARS = 26_000; // cap the text the single LLM call reads

// Sanity bounds (USD) — a workstation system price and a single component
// option live in known ranges; anything outside is almost certainly a misread
// (financing "$X/mo", an accessory, a warranty line) and is dropped, counted.
const SYSTEM_MIN = 800;
const SYSTEM_MAX = 200_000;
const COMMODITY_MIN = 30;
const COMMODITY_MAX = 40_000;

const VENDORS = new Set<Vendor>(['hp', 'dell', 'lenovo', 'nvidia', 'other']);
const OEMS = new Set(['hp', 'dell', 'lenovo']);
const SEGMENTS = new Set(['smb', 'prosumer', 'enterprise', 'edu', 'gov']);
const COMMODITY_CLASSES = new Set(['gpu', 'cpu', 'memory', 'storage', 'psu', 'cooling', 'other']);
const PRICE_KINDS = new Set(['addon', 'config_delta', 'standalone', 'included']);

const InputSchema = z
  .object({
    vendors: z
      .array(z.enum(['hp', 'dell', 'lenovo']))
      .optional()
      .describe('Restrict to these OEMs (plus the cross-OEM commodity queries). Omit for all.'),
    force: z.boolean().default(false).describe('Re-fetch even if a URL was fetched recently.'),
    max: z.number().int().min(1).max(20).optional().describe('Cap total fetches per run.'),
    per_query: z.number().int().min(1).max(5).optional().describe('Top-N search hits to fetch per query.'),
    min_interval_hours: z.number().min(0).optional(),
  })
  .strict();
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
  ok: z.boolean(),
  searched: z.number(),
  fetched: z.number(),
  /** Raw whole-system price rows the LLM returned, BEFORE filtering. Lets us
   *  tell "the pages had no prices" (0 extracted) apart from "we found prices
   *  but dropped them" (extracted > recorded) on the next run. */
  prices_extracted: z.number().default(0),
  prices_recorded: z.number(),
  /** Subset of prices_recorded stored with an empty model_id — a real price we
   *  could NOT tie to a catalog SKU (e.g. a Lenovo/older-Dell model not yet in
   *  the catalog). Recorded (name kept in config_label) rather than dropped, so
   *  the signal isn't lost; a non-zero value flags a catalog-coverage gap. */
  prices_unmapped: z.number().default(0),
  commodity_recorded: z.number(),
  /** Distinct OEMs (hp/dell/lenovo) the recorded commodity rows cover — the
   *  honest measure of whether a per-OEM SPREAD is forming. ≤1 means the static
   *  path isn't yielding cross-OEM commodity pricing and a configurator-driver
   *  is the next step. */
  commodity_oem_coverage: z.number(),
  dropped_out_of_range: z.number(),
  failed: z.array(z.object({ url: z.string(), error: z.string() })),
  error: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

/**
 * Robustly parse the extractor's `{prices, commodity_prices}` object.
 *
 * The model sometimes wraps its JSON in an OPENING ```json fence with NO closing
 * fence (the object is long and truncates at max_tokens), which left a leading
 * backtick that crashed a naive `JSON.parse` ("Unrecognized token '`'") and
 * zeroed the ENTIRE run — observed 2026-06-03. Mirror drive_configurator's
 * salvage: strip think/fence, isolate the outermost JSON, try a clean parse,
 * and on failure SALVAGE every complete flat `{…}` row — bucketing each into
 * prices vs commodity_prices by its keys — so a truncated array still records
 * the rows it did emit instead of throwing them all away.
 */
function parse_price_extraction(raw: string): {
  prices: Record<string, unknown>[];
  commodity_prices: Record<string, unknown>[];
} {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) t = fence[1].trim();
  // Isolate the outermost object/array — drops a dangling unclosed ```json
  // opener, stray prose, or a leading backtick that has no matching close.
  const starts = [t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (start >= 0 && end > start) t = t.slice(start, end + 1);

  try {
    const p = JSON.parse(t) as { prices?: unknown; commodity_prices?: unknown };
    return {
      prices: Array.isArray(p.prices) ? (p.prices as Record<string, unknown>[]) : [],
      commodity_prices: Array.isArray(p.commodity_prices) ? (p.commodity_prices as Record<string, unknown>[]) : [],
    };
  } catch {
    const prices: Record<string, unknown>[] = [];
    const commodity_prices: Record<string, unknown>[] = [];
    for (const m of t.matchAll(/\{[^{}]*\}/g)) {
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(m[0]) as Record<string, unknown>;
      } catch {
        continue; // skip a partial object (the truncated tail)
      }
      // commodity rows carry `commodity`/`commodity_class`; check that FIRST
      // since they also carry model_id (which a system price has too).
      if ('commodity' in o || 'commodity_class' in o) commodity_prices.push(o);
      else if ('list_price' in o || 'sale_price' in o || 'model_name' in o || 'model_id' in o) prices.push(o);
    }
    return { prices, commodity_prices };
  }
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/** Numeric price within [lo, hi], else null (out-of-range → caller counts it). */
function in_range(n: number | null, lo: number, hi: number): number | null {
  if (n === null) return null;
  return n >= lo && n <= hi ? n : null;
}

const SYSTEM_INSTRUCTION =
  'You are a workstation-market PRICE extractor. From the provided pages, pull ONLY ' +
  'prices that are explicitly attached to a workstation model or a component — never ' +
  'invent or estimate a number. IGNORE: monthly financing / lease lines ("$X/mo", "as ' +
  'low as"), struck-through/was prices unless a separate current sale price is also shown, ' +
  'warranty/service/accessory line items, and bundle totals you cannot attribute to one model. ' +
  'Attribute every row to the [source: <url>] it came from.\n\n' +
  'Return ONLY a JSON object with two arrays (no prose, no fence):\n' +
  '{\n' +
  '  "prices": [ // whole-SYSTEM prices\n' +
  '    {"model_id":"<one of the KNOWN model_ids, or empty if none fits>",' +
  '"model_name":"<ALWAYS fill this from the page — the workstation name as written, e.g. \\"Lenovo ThinkStation P5\\" — even when model_id is empty>",' +
  '"config_label":"<normalized build, e.g. base or \\"RTX PRO 6000 / 128GB / 2TB\\">",' +
  '"segment":"smb|prosumer|enterprise|edu|gov","list_price":<number USD>,"sale_price":<number USD or null>,' +
  '"source":"<source url>"}\n' +
  '  ],\n' +
  '  "commodity_prices": [ // per-COMPONENT prices — what an OEM charges to add/upgrade ONE part\n' +
  '    {"commodity":"<normalized canonical part name shared across OEMs, e.g. \\"NVIDIA RTX 4000 Ada\\", ' +
  '\\"64GB DDR5-4800 ECC\\", \\"2TB NVMe Gen4 SSD\\">","commodity_class":"gpu|cpu|memory|storage|psu|cooling|other",' +
  '"vendor":"hp|dell|lenovo|other","model_id":"<known model_id this option was priced within, or empty>",' +
  '"price":<number USD>,"price_kind":"addon|config_delta|standalone|included","source":"<source url>"}\n' +
  '  ]\n' +
  '}\n\n' +
  'For commodity_prices, the HIGH-VALUE rows are per-OEM: a configurator option/upgrade price, or a ' +
  'config_delta you compute from two priced variants of the SAME OEM platform that differ by one ' +
  'component (delta = that OEM\'s price for the part) — set vendor to that OEM (hp/dell/lenovo) and ' +
  'price_kind accordingly. Use vendor "other" ONLY for a truly standalone street price you cannot tie ' +
  'to an OEM. Use "prosumer" segment for a single-unit web price unless the page says otherwise. ' +
  'Normalize commodity names so the SAME part matches across OEMs. Only prices you can actually read.';

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
    name: 'acquire_pricing',
    description:
      "BACKGROUND JOB. Price-targeted, search-first acquisition: run Kristi's PRICE queries through SearXNG, fetch the top hits once (Firecrawl→the workstation fallback), file each onto her shelf, and in ONE bounded LLM pass over the just-fetched text record BOTH whole-system prices (record_price) and per-OEM commodity prices (record_commodity_price). Self-healing against URL churn, can't spiral. Reports commodity_oem_coverage so a thin per-OEM spread is visible. Use `vendors` to scope.",
    risk: 'write_internal',
    required_capabilities: ['write_workstation_intel', 'query_web', 'browse_web', 'write_vault_any_library'],
    weight: 'heavy',
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const v = (input.vendors ?? ['hp', 'dell', 'lenovo']).slice().sort().join(',');
      const hour = new Date().toISOString().slice(0, 13);
      return `acquire_pricing:${v}:${hour}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const store = getKristiWorkstationsStore();
      const min_ms = (input.min_interval_hours ?? DEFAULT_MIN_INTERVAL_HOURS) * 3_600_000;
      const max = input.max ?? DEFAULT_MAX_PER_RUN;
      const per_query = input.per_query ?? DEFAULT_PER_QUERY;
      const now = Date.now();

      // Scope: the requested OEMs' queries, ALWAYS plus the cross-OEM commodity
      // queries (vendor 'mixed') — those are where a per-OEM spread forms.
      const want = new Set<PriceVendor>([...(input.vendors ?? ['hp', 'dell', 'lenovo']), 'mixed']);
      const queries = PRICE_QUERIES.filter((q) => want.has(q.vendor));

      const failed: Output['failed'] = [];
      const seen_urls = new Set<string>();
      const sources: Array<{ url: string; markdown: string; title: string | null }> = [];
      let searched = 0;
      let ok = true;

      // ── 1+2. discover + fetch (bounded, heavy-capped) ──────────────────────
      for (const sq of queries) {
        if (sources.length >= max) break;
        let results: Array<{ title: string; url: string }> = [];
        try {
          const res = await web_search.execute(
            { query: sq.query, max_results: per_query, max_age_ms: BACKGROUND_MAX_AGE_MS },
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
          if (sources.length >= max) break;
          if (!r.url || seen_urls.has(r.url)) continue;
          seen_urls.add(r.url);
          if (!input.force) {
            const prior = store.get_source_sync(r.url);
            if (prior && now - Date.parse(prior.synced_at) < min_ms) continue;
          }
          try {
            const outcome = await fetch_with_browser_fallback(r.url, ctx, { title_fallback: r.title || undefined });
            if (outcome.kind !== 'firecrawl' && outcome.kind !== 'browser') {
              failed.push({ url: r.url, error: `${outcome.kind}: ${outcome.reason}` });
              if (outcome.kind === 'failed') ok = false;
              continue;
            }
            sources.push({ url: r.url, markdown: outcome.markdown, title: outcome.title });
            store.record_source_sync(r.url, { content_hash: null });
            // File the SAME fetched markdown onto her shelf (no second fetch) so
            // search_library + the layer extractors see the price page next pass.
            try {
              await ingest.execute(
                { target_specialist_id: 'kristi', markdown: outcome.markdown.slice(0, 200_000), title_hint: r.title || outcome.title || undefined },
                ctx,
              );
            } catch {
              /* shelf-filing is non-critical for price extraction */
            }
          } catch (err) {
            ok = false;
            failed.push({ url: r.url, error: err instanceof Error ? err.message : String(err) });
          }
        }
      }

      if (sources.length === 0) {
        deps.memory.log_action({
          intent_id: ctx.intent_id,
          agent: ctx.specialist_id ?? 'kristi',
          tool_name: 'acquire_pricing',
          tool_input: { vendors: input.vendors },
          execution_result: { ok, searched, fetched: 0, prices_extracted: 0, prices_recorded: 0, prices_unmapped: 0, commodity_recorded: 0 },
        });
        return { ok, searched, fetched: 0, prices_extracted: 0, prices_recorded: 0, prices_unmapped: 0, commodity_recorded: 0, commodity_oem_coverage: 0, dropped_out_of_range: 0, failed };
      }

      // ── 3. one bounded extraction pass over the just-fetched price text ────
      const known = store
        .find_skus({ limit: 80 })
        .map((s) => `${s.model_id} = ${s.vendor} ${s.model_name}`)
        .join('\n');
      const corpus = sources
        .map((s) => `[source: ${s.url}]\n${s.markdown}`)
        .join('\n\n---\n\n')
        .slice(0, MAX_EXTRACT_CHARS);
      const user = `KNOWN model_ids (map rows to these; empty string if none fits):\n${known || '(none yet)'}\n\nPAGES:\n${corpus}`;

      let prices_recorded = 0;
      let prices_unmapped = 0;
      let prices_extracted = 0;
      let commodity_recorded = 0;
      let dropped = 0;
      const oem_coverage = new Set<string>();
      try {
        const role = deps.llm.for_role('research_extract');
        const resp = await role.provider.complete({
          messages: [
            { role: 'system', content: SYSTEM_INSTRUCTION },
            { role: 'user', content: user },
          ],
          max_tokens: 4000,
          think: false,
        });
        const { prices: price_rows, commodity_prices: commodity_rows } = parse_price_extraction(resp.content);
        prices_extracted = price_rows.length;

        for (const r of price_rows) {
          try {
            const model_id = String(r.model_id ?? '').trim();
            const model_name = String(r.model_name ?? '').trim();
            const list_price = in_range(num(r.list_price), SYSTEM_MIN, SYSTEM_MAX);
            const sale_price = in_range(num(r.sale_price), SYSTEM_MIN, SYSTEM_MAX);
            if (num(r.list_price) !== null && list_price === null) dropped++;
            if (list_price === null && sale_price === null) continue; // no usable number
            const segment = (SEGMENTS.has(String(r.segment)) ? String(r.segment) : 'prosumer') as PriceSegment;
            const base_label = String(r.config_label ?? 'base');
            // A price with no catalog match used to be DROPPED ("can't be
            // compared"), which silently zeroed the prices table whenever the
            // page named a model not yet in the catalog (Lenovo, older Dell).
            // Record it instead with an empty model_id and the page's model name
            // folded into config_label, so the signal survives and a catalog-gap
            // is visible (prices_unmapped) rather than invisible.
            const config_label = (model_id ? base_label : `${model_name || 'unknown model'} — ${base_label}`).slice(0, 120);
            const verdict = store.record_price({
              model_id,
              config_label,
              segment,
              list_price,
              sale_price,
              url: String(r.source ?? sources[0]!.url),
            });
            if (!verdict.stored) { dropped++; continue; } // store plausibility gate
            prices_recorded++;
            if (!model_id) prices_unmapped++;
          } catch {
            /* skip a malformed row */
          }
        }

        for (const r of commodity_rows) {
          try {
            const commodity = String(r.commodity ?? '').trim();
            const vendor = String(r.vendor ?? '');
            const raw = num(r.price);
            const price = in_range(raw, COMMODITY_MIN, COMMODITY_MAX);
            if (raw !== null && price === null) dropped++;
            if (!commodity || !VENDORS.has(vendor as Vendor) || price === null) continue;
            const cls = String(r.commodity_class ?? 'other');
            const kind = String(r.price_kind ?? 'addon');
            const verdict = store.record_commodity_price({
              commodity: commodity.slice(0, 120),
              commodity_class: (COMMODITY_CLASSES.has(cls) ? cls : 'other') as CommodityClass,
              vendor: vendor as Vendor,
              model_id: String(r.model_id ?? '').trim(),
              price,
              price_kind: PRICE_KINDS.has(kind) ? kind : 'addon',
              url: String(r.source ?? sources[0]!.url),
            });
            if (!verdict.stored) { dropped++; continue; } // store plausibility gate
            commodity_recorded++;
            if (OEMS.has(vendor)) oem_coverage.add(vendor);
          } catch {
            /* skip a malformed row */
          }
        }
      } catch (err) {
        deps.memory.log_action({
          intent_id: ctx.intent_id,
          agent: ctx.specialist_id ?? 'kristi',
          tool_name: 'acquire_pricing',
          tool_input: { vendors: input.vendors },
          execution_result: { ok: false, fetched: sources.length, prices_extracted, prices_recorded, prices_unmapped, error: err instanceof Error ? err.message : String(err) },
        });
        return {
          ok: false, searched, fetched: sources.length, prices_extracted, prices_recorded, prices_unmapped, commodity_recorded,
          commodity_oem_coverage: oem_coverage.size, dropped_out_of_range: dropped, failed,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kristi',
        tool_name: 'acquire_pricing',
        tool_input: { vendors: input.vendors },
        execution_result: { ok, searched, fetched: sources.length, prices_extracted, prices_recorded, prices_unmapped, commodity_recorded, commodity_oem_coverage: oem_coverage.size, dropped_out_of_range: dropped },
      });

      return {
        ok, searched, fetched: sources.length, prices_extracted, prices_recorded, prices_unmapped, commodity_recorded,
        commodity_oem_coverage: oem_coverage.size, dropped_out_of_range: dropped, failed,
      };
    },
  };
}
