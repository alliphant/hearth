/**
 * acquire_campaign_finance — Ruby's money-trail acquisition pass.
 *
 * Campaign-finance facts live in documents nobody reads casually: the
 * city clerk's filing PDFs (Pleasantville council races), TRACER (the
 * Colorado SoS campaign-finance system, for state-level committees and
 * the state money behind local actors), and occasionally local reporting
 * that surfaces a donor before the filing does. This tool runs the Kristi
 * search-first acquisition shape over that corpus:
 *
 *   1. discover filing/report pages via SearXNG (or an explicit `url`);
 *   2. fetch each once (Firecrawl → the workstation fallback) and file the SAME
 *      markdown onto Ruby's shelf so the filing is searchable later;
 *   3. ONE bounded LLM pass lifts itemized contributions + filing-period
 *      summaries, and `apply_finance_rows` records them through the
 *      store's plausibility gates (implausible amounts are REJECTED and
 *      counted, never silently stored).
 *
 * `source_kind` is derived from the document's host, in code: citygov.com /
 * pleasantville.gov → city_clerk, the SoS domains → tracer, anything else →
 * news. A news-sourced donation is a lead to corroborate against a
 * filing, and the rows carry that provenance so Ruby (and the conflict
 * scan) can weight them honestly.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { web_search } from '@connectors/searxng';
import { fetch_with_browser_fallback } from '@connectors/fetch_with_browser_fallback';
import { make_ingest_to_library } from '@connectors/ingest_to_library';
import {
  get_ruby_civic_store,
  type RubyCivicStore,
  type FinanceSourceKind,
} from '@memory/stores/ruby_civic';

const DEFAULT_MAX_DOCS = 3;
const DEFAULT_PER_QUERY = 2;
const DEFAULT_MIN_INTERVAL_HOURS = 20;
const MAX_EXTRACT_CHARS = 26_000;

const InputSchema = z
  .object({
    candidate: z
      .string()
      .max(120)
      .optional()
      .describe('Scope the pass to one candidate/member (their filings + TRACER trail).'),
    url: z.string().url().optional().describe('Read a specific filing/report page instead of searching.'),
    election_cycle: z.string().max(24).optional().describe("Default cycle label for rows that don't state one, e.g. '2025'."),
    max_docs: z.number().int().min(1).max(5).default(DEFAULT_MAX_DOCS),
    per_query: z.number().int().min(1).max(4).default(DEFAULT_PER_QUERY),
    force: z.boolean().default(false),
  })
  .strict();
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
  ok: z.boolean(),
  searched: z.number(),
  fetched: z.number(),
  /** Raw donation rows the LLM returned, BEFORE the plausibility gates —
   *  "the pages had no itemized money" (0 extracted) reads differently
   *  from "we found rows but dropped them" (extracted > recorded). */
  donations_extracted: z.number(),
  donations_recorded: z.number(),
  /** Rows the store's gates refused (implausible amount, missing source). */
  rejected: z.number(),
  filings_recorded: z.number(),
  failed: z.array(z.object({ url: z.string(), error: z.string() })),
  error: z.string().optional(),
  recovery_hint: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

/** Provenance from the document host — code-derived, never model-claimed. */
export function source_kind_for(url: string): FinanceSourceKind {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith('citygov.com') || host.endsWith('pleasantville.gov')) return 'city_clerk';
    if (host.endsWith('sos.colorado.gov') || host.endsWith('coloradosos.gov') || host.endsWith('sos.state.co.us')) {
      return 'tracer';
    }
    return 'news';
  } catch {
    return 'other';
  }
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Tolerant parse of the extractor's `{donations, filings}` object — strip
 * think/fence, isolate the outermost JSON, clean parse, and on failure
 * salvage complete flat objects, bucketing by their keys (a donation row
 * has a `donor`; a filing row has a `period`). A truncated tail drops a
 * row, never the batch.
 */
export function parse_finance_extraction(raw: string): {
  donations: Array<Record<string, unknown>>;
  filings: Array<Record<string, unknown>>;
} {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) t = fence[1].trim();
  const starts = [t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (start >= 0 && end > start) t = t.slice(start, end + 1);

  try {
    const p = JSON.parse(t) as { donations?: unknown; filings?: unknown };
    return {
      donations: Array.isArray(p.donations) ? (p.donations as Array<Record<string, unknown>>) : [],
      filings: Array.isArray(p.filings) ? (p.filings as Array<Record<string, unknown>>) : [],
    };
  } catch {
    const donations: Array<Record<string, unknown>> = [];
    const filings: Array<Record<string, unknown>> = [];
    for (const m of t.matchAll(/\{[^{}]*\}/g)) {
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(m[0]) as Record<string, unknown>;
      } catch {
        continue;
      }
      if ('donor' in o || 'amount_usd' in o) donations.push(o);
      else if ('period' in o || 'total_raised_usd' in o) filings.push(o);
    }
    return { donations, filings };
  }
}

export interface FinanceRowsResult {
  donations_extracted: number;
  donations_recorded: number;
  rejected: number;
  filings_recorded: number;
}

/**
 * Validate + record extracted finance rows through the store's gates.
 * Exported pure-of-network so the smoke pins the gate behavior without a
 * live LLM or fetch.
 */
export function apply_finance_rows(
  parsed: { donations: Array<Record<string, unknown>>; filings: Array<Record<string, unknown>> },
  opts: { store: RubyCivicStore; default_source_url: string; default_cycle?: string },
): FinanceRowsResult {
  const result: FinanceRowsResult = {
    donations_extracted: parsed.donations.length,
    donations_recorded: 0,
    rejected: 0,
    filings_recorded: 0,
  };

  for (const r of parsed.donations) {
    const source_url = typeof r.source === 'string' && /^https?:\/\//i.test(r.source) ? r.source : opts.default_source_url;
    const verdict = opts.store.record_donation({
      recipient: String(r.recipient ?? '').trim(),
      committee: String(r.committee ?? ''),
      donor: String(r.donor ?? '').trim(),
      donor_type: String(r.donor_type ?? 'unknown'),
      employer: String(r.employer ?? ''),
      occupation: String(r.occupation ?? ''),
      amount_usd: num(r.amount_usd) ?? NaN,
      donated_at: String(r.donated_at ?? ''),
      election_cycle: String(r.election_cycle ?? '') || opts.default_cycle,
      in_kind: r.in_kind === true,
      jurisdiction: String(r.jurisdiction ?? 'city'),
      source_kind: source_kind_for(source_url),
      source_url,
      notes: String(r.notes ?? ''),
    });
    if (verdict.stored) result.donations_recorded++;
    else result.rejected++;
  }

  for (const r of parsed.filings) {
    const source_url = typeof r.source === 'string' && /^https?:\/\//i.test(r.source) ? r.source : opts.default_source_url;
    const verdict = opts.store.record_filing({
      candidate: String(r.candidate ?? '').trim(),
      committee: String(r.committee ?? ''),
      period: String(r.period ?? '').trim(),
      total_raised_usd: num(r.total_raised_usd),
      total_spent_usd: num(r.total_spent_usd),
      cash_on_hand_usd: num(r.cash_on_hand_usd),
      jurisdiction: String(r.jurisdiction ?? 'city'),
      source_url,
    });
    if (verdict.stored) result.filings_recorded++;
    else result.rejected++;
  }
  return result;
}

const SYSTEM_INSTRUCTION =
  'You are a campaign-finance extractor reading official filings (city clerk reports, Colorado ' +
  'TRACER pages) and credible local reporting. Pull ONLY figures actually printed on the pages — ' +
  'never estimate, sum, or invent a number, a donor, or a date. IGNORE expenditure line items ' +
  '(spending goes in filing totals only).\n\n' +
  'Return ONLY a JSON object with two arrays (no prose, no fence):\n' +
  '{\n' +
  '  "donations": [ // ITEMIZED contributions — one row per contribution as listed\n' +
  '    {"recipient":"<candidate/member the money went to>","committee":"<committee name as registered, or empty>",' +
  '"donor":"<contributor name as printed>","donor_type":"individual|business|pac|party|union|nonprofit|self|unknown",' +
  '"employer":"<if listed>","occupation":"<if listed>","amount_usd":<number>,"donated_at":"<YYYY-MM-DD if listed, else empty>",' +
  '"election_cycle":"<e.g. 2025, if stated>","in_kind":<true|false>,"jurisdiction":"city|county|state|federal",' +
  '"source":"<the page url this row came from>"}\n' +
  '  ],\n' +
  '  "filings": [ // PER-PERIOD summaries — totals from a filing cover page\n' +
  '    {"candidate":"<candidate>","committee":"<committee, or empty>","period":"<filing period as printed>",' +
  '"total_raised_usd":<number or null>,"total_spent_usd":<number or null>,"cash_on_hand_usd":<number or null>,' +
  '"jurisdiction":"city|county|state|federal","source":"<page url>"}\n' +
  '  ]\n' +
  '}\n\n' +
  'A cycle TOTAL is a filing row, never a donation row. Attribute every row to the [source: <url>] ' +
  'page it came from. Only rows you can actually read.';

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
      embedder: deps.embedder,
    },
    specialists: deps.specialists,
    users: deps.users,
  });

  return {
    name: 'acquire_campaign_finance',
    description:
      "Search-first campaign-finance acquisition: find Pleasantville city-clerk filings, Colorado TRACER pages, and credible reporting on council campaign money, fetch the top documents once, and in ONE bounded LLM pass record itemized donations (record_donation) + filing-period totals through the store's plausibility gates. Provenance (city_clerk | tracer | news) is derived from the document host in code. Scope with `candidate`; pass `url` to read a specific filing. Runs weekly as a background job; the conflict scan reads what this records.",
    risk: 'write_internal',
    required_capabilities: ['query_web', 'browse_web', 'write_civic_intel', 'write_vault_any_library'],
    weight: 'heavy',
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const hour = new Date().toISOString().slice(0, 13);
      return `acquire_campaign_finance:${input.candidate ?? input.url ?? 'all'}:${hour}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const store = get_ruby_civic_store();
      const min_ms = DEFAULT_MIN_INTERVAL_HOURS * 3_600_000;
      const now = Date.now();
      const failed: Output['failed'] = [];
      let searched = 0;

      // ── 1. discover ───────────────────────────────────────────────────────
      const sources: Array<{ url: string; markdown: string }> = [];
      const fetch_one = async (url: string): Promise<void> => {
        try {
          const outcome = await fetch_with_browser_fallback(url, ctx, {});
          if (outcome.kind !== 'firecrawl' && outcome.kind !== 'browser') {
            failed.push({ url, error: `${outcome.kind}: ${outcome.reason}` });
            return;
          }
          sources.push({ url, markdown: outcome.markdown });
          store.record_source_sync(url, { content_hash: null });
          try {
            await ingest.execute(
              { target_specialist_id: 'ruby', markdown: outcome.markdown.slice(0, 200_000), title_hint: `Campaign finance — ${url}` },
              ctx,
            );
          } catch {
            /* shelf-filing is non-critical */
          }
        } catch (err) {
          failed.push({ url, error: err instanceof Error ? err.message : String(err) });
        }
      };

      if (input.url) {
        await fetch_one(input.url);
      } else {
        const queries = input.candidate
          ? [
              `"${input.candidate}" campaign finance Pleasantville city council`,
              `"${input.candidate}" contributions Colorado TRACER committee`,
            ]
          : [
              'Pleasantville city council campaign finance reports city clerk',
              'Pleasantville council candidate campaign contributions filing',
              'Pleasantville city council election campaign donors',
            ];
        const seen = new Set<string>();
        for (const q of queries) {
          if (sources.length >= input.max_docs) break;
          let results: Array<{ url: string }> = [];
          try {
            const res = await web_search.execute({ query: q, max_results: input.per_query + 2 }, ctx);
            searched++;
            if (res.error) {
              failed.push({ url: `search:${q}`, error: res.error });
              continue;
            }
            results = res.results.slice(0, input.per_query + 2);
          } catch (err) {
            failed.push({ url: `search:${q}`, error: err instanceof Error ? err.message : String(err) });
            continue;
          }
          let taken = 0;
          for (const r of results) {
            if (sources.length >= input.max_docs || taken >= input.per_query) break;
            if (!r.url || seen.has(r.url)) continue;
            seen.add(r.url);
            if (!input.force) {
              const prior = store.get_source_sync(r.url);
              if (prior && now - Date.parse(prior.synced_at) < min_ms) continue;
            }
            await fetch_one(r.url);
            taken++;
          }
        }
      }

      if (sources.length === 0) {
        return {
          ok: failed.length === 0,
          searched, fetched: 0,
          donations_extracted: 0, donations_recorded: 0, rejected: 0, filings_recorded: 0,
          failed,
          recovery_hint:
            'No finance documents surfaced. Try a candidate-scoped pass (candidate: "<name>"), or pass the city clerk campaign-finance page / a TRACER committee URL directly via `url`.',
        };
      }

      // ── 2. one bounded extraction pass ────────────────────────────────────
      const corpus = sources
        .map((s) => `[source: ${s.url}]\n${s.markdown}`)
        .join('\n\n---\n\n')
        .slice(0, MAX_EXTRACT_CHARS);

      let applied: FinanceRowsResult = { donations_extracted: 0, donations_recorded: 0, rejected: 0, filings_recorded: 0 };
      try {
        const role = deps.llm.for_role('research_extract');
        const resp = await role.provider.complete({
          messages: [
            { role: 'system', content: SYSTEM_INSTRUCTION },
            { role: 'user', content: `PAGES:\n${corpus}` },
          ],
          max_tokens: 4096,
          think: false,
        });
        applied = apply_finance_rows(parse_finance_extraction(resp.content), {
          store,
          default_source_url: sources[0]!.url,
          default_cycle: input.election_cycle,
        });
      } catch (err) {
        ctx.memory.log_action({
          intent_id: ctx.intent_id,
          agent: ctx.specialist_id ?? 'ruby',
          tool_name: 'acquire_campaign_finance',
          tool_input: { candidate: input.candidate, url: input.url },
          execution_result: { ok: false, fetched: sources.length, error: err instanceof Error ? err.message : String(err) },
        });
        return {
          ok: false, searched, fetched: sources.length,
          ...applied, failed,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'ruby',
        tool_name: 'acquire_campaign_finance',
        tool_input: { candidate: input.candidate, url: input.url },
        execution_result: { ok: true, searched, fetched: sources.length, ...applied, failed_n: failed.length },
      });
      return { ok: true, searched, fetched: sources.length, ...applied, failed };
    },
  };
}
