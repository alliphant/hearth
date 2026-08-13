/**
 * courtlistener — real court records for deep research (2026-07-31).
 *
 * ## Why this exists
 *
 * The Daniel Torres investigation (`ri_3kq84nfd4mz0`) asked for Williamson
 * and Bastrop county court records, divorce history and debt. It answered by
 * running an open-web search for the WORDS "court records" and reading, among
 * eighteen sources, a Bible dictionary, a Honda tuning forum, and a page about
 * the etymology of the name "Jonathan". Zero records were found because a
 * records question was routed to a search index instead of to a court system.
 *
 * CourtListener is the correction: a free, keyless API over the RECAP archive
 * (federal PACER dockets, including bankruptcy) plus a large opinion corpus
 * with growing state appellate coverage. A party-name search returns real
 * dockets with case numbers, courts and filing dates. Probed against the live
 * API while building this, `"Daniel Torres"` returns 267 dockets — including
 * a 2026 Arizona bankruptcy filed under that exact party name.
 *
 * ## What it is not
 *
 * It is NOT county coverage. Divorce, protective orders, civil judgments,
 * deeds and property are county-level and appear nowhere in RECAP. Those go
 * through the jurisdiction roster (research_jurisdiction.ts +
 * config/research-sources.yaml). Saying so plainly is part of the tool's job —
 * `coverage_note` on every result exists so a model cannot read an empty
 * federal result as "he has no court history".
 *
 * ## Contract
 *
 * Keyless by default; COURTLISTENER_API_TOKEN raises the rate limit if set.
 * Base overridable via COURTLISTENER_BASE_URL (the smoke's fixture seam).
 * Fields are mapped DEFENSIVELY — only what we read, all optional — so an
 * upstream shape change degrades to fewer fields, never a throw.
 *
 * Per the connector-affordance rule, every error and every empty result
 * carries `candidates`: concrete next moves, never a dead end.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import { audit_connector, safe_fetch } from './_audit';

/**
 * `audit_connector` wants an explicit `agent`; a ToolContext carries
 * `specialist_id`, which is undefined when the detached research runner calls
 * `.execute()` directly rather than through the registry. Same shape every
 * other connector uses (flights, airthings, house_energy).
 */
function audit_ctx(ctx: ToolContext) {
  return {
    memory: ctx.memory,
    agent: ctx.specialist_id || 'courtlistener_connector',
    intent_id: ctx.intent_id,
  };
}

const CL_BASE = (): string =>
  process.env.COURTLISTENER_BASE_URL ?? 'https://www.courtlistener.com';
const CL_TOKEN = (): string => process.env.COURTLISTENER_API_TOKEN ?? '';
const TIMEOUT_MS = 25_000;

/** Search types we expose, mapped to CourtListener's `type` parameter. */
const TYPE_PARAM: Record<'dockets' | 'opinions', string> = {
  dockets: 'r', // RECAP: PACER dockets + documents
  opinions: 'o',
};

const InputSchema = z.object({
  query: z
    .string()
    .min(2)
    .max(300)
    .describe(
      'Party or case text. For a person, quote the full name — "Daniel Ray Torres" — ' +
        'so the engine cannot drop a token and return a different person.',
    ),
  type: z
    .enum(['dockets', 'opinions'])
    .default('dockets')
    .describe(
      'dockets = federal PACER/RECAP case filings (civil, criminal, bankruptcy). ' +
        'opinions = published decisions, incl. state appellate.',
    ),
  court: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Optional CourtListener court id filter, comma-separated (e.g. "txwd" for ' +
        'W.D. Texas, "arb" for D. Arizona bankruptcy). Omit to search all courts — ' +
        'results name their own court, so filtering afterwards is usually better.',
    ),
  filed_after: z
    .string()
    .max(20)
    .optional()
    .describe('Only cases filed on/after this date. ISO YYYY-MM-DD.'),
  filed_before: z
    .string()
    .max(20)
    .optional()
    .describe('Only cases filed on/before this date. ISO YYYY-MM-DD.'),
  max_results: z.number().int().min(1).max(30).default(10),
});

const ResultSchema = z.object({
  case_name: z.string(),
  court: z.string(),
  court_id: z.string().nullable(),
  docket_number: z.string().nullable(),
  date_filed: z.string().nullable(),
  date_terminated: z.string().nullable(),
  /** Bankruptcy chapter when present — a strong relevance signal for a
   *  debt-history question. */
  chapter: z.string().nullable(),
  parties: z.array(z.string()),
  url: z.string(),
  snippet: z.string().nullable(),
});

const OutputSchema = z.object({
  query: z.string(),
  type: z.string(),
  /** Total matches upstream, which can far exceed `results.length`. */
  total_matches: z.number(),
  results: z.array(ResultSchema),
  /** ALWAYS populated. What this corpus does and does not cover. */
  coverage_note: z.string(),
  error: z.string().optional(),
  candidates: z
    .array(z.object({ next_step: z.string(), why: z.string() }))
    .optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;
type Result = z.infer<typeof ResultSchema>;

const COVERAGE_NOTE =
  'CourtListener/RECAP covers FEDERAL courts (district, appellate, bankruptcy) plus a ' +
  'growing published-opinion corpus including state appellate courts. It does NOT cover ' +
  'county-level records: divorce, protective orders, civil judgments, probate, deeds, ' +
  'liens and property ownership are held by the county district clerk, county clerk and ' +
  'appraisal district, and must be searched there. An empty result here means "nothing ' +
  'FEDERAL under this name", never "no court history".';

/** ISO YYYY-MM-DD → CourtListener's MM/DD/YYYY. Returns null if unparseable. */
export function to_cl_date(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${mo}/${d}/${y}`;
}

/** Shapes we read. Every field optional — upstream drift degrades, never throws. */
interface RawHit {
  caseName?: string;
  case_name_full?: string;
  court?: string;
  court_id?: string;
  docketNumber?: string;
  dateFiled?: string;
  dateTerminated?: string;
  chapter?: string;
  party?: string[];
  absolute_url?: string;
  docket_absolute_url?: string;
  snippet?: string;
  recap_documents?: Array<{ snippet?: string }>;
}

/**
 * Map an upstream hit to our shape.
 *
 * Exported so the smoke can pin it against a real captured response without
 * standing up a fixture server.
 */
export function map_hit(raw: RawHit, base: string): Result {
  const path = raw.docket_absolute_url ?? raw.absolute_url ?? '';
  const snippet =
    raw.snippet ??
    raw.recap_documents?.map((d) => d.snippet).find((s) => s && s.length > 0) ??
    null;
  return {
    case_name: raw.case_name_full && raw.case_name_full.length > 0
      ? raw.case_name_full
      : (raw.caseName ?? '(unnamed case)'),
    court: raw.court ?? '(court not stated)',
    court_id: raw.court_id ?? null,
    docket_number: raw.docketNumber ?? null,
    date_filed: raw.dateFiled ?? null,
    date_terminated: raw.dateTerminated ?? null,
    chapter: raw.chapter ?? null,
    parties: Array.isArray(raw.party) ? raw.party.filter((p) => typeof p === 'string') : [],
    url: path.startsWith('http') ? path : `${base.replace(/\/$/, '')}${path}`,
    snippet: snippet && snippet.length > 0 ? snippet : null,
  };
}

/** Next moves when federal search comes back empty or broken. */
function candidates_for(input: Input, reason: 'empty' | 'error') {
  const base = [
    {
      next_step: 'Search the COUNTY district clerk for civil, family and divorce cases',
      why:
        'Divorce, protective orders and civil judgments are county-level and are absent ' +
        'from RECAP entirely. Resolve the county first — the record lives in a specific one.',
    },
    {
      next_step: 'Search the county clerk for deeds, liens and UCC filings',
      why: 'Debt secured against property is recorded at the county, not federally.',
    },
    {
      next_step: 'Try the opinions corpus as well as dockets',
      why:
        'A person can appear in a published state appellate opinion without any federal ' +
        'docket. Re-run with type "opinions".',
    },
  ];
  if (reason === 'empty') {
    base.unshift({
      next_step: 'Re-run without the quoted full name, or with a middle name dropped',
      why:
        'RECAP party strings are as the filer typed them — "Daniel Torres Cruz" will not ' +
        'match a quoted "Daniel Ray Torres". Widen, then filter the results by hand.',
    });
  }
  return base;
}

export const courtlistener_search: Tool<Input, Output> = {
  name: 'courtlistener_search',
  description:
    'Search real court records by party name: federal PACER/RECAP dockets (civil, ' +
    'criminal, bankruptcy) and published opinions including state appellate courts. ' +
    'Free, no account needed. Use this INSTEAD of a web search whenever the question is ' +
    'about someone\'s court history — an open-web search for the words "court records" ' +
    'returns SEO farms, not records. Does not cover county courts (divorce, judgments, ' +
    'property); the result says so.',
  risk: 'read',
  required_capabilities: ['read_court_records'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(
      [
        input.query.trim().toLowerCase(),
        input.type,
        input.court ?? '',
        input.filed_after ?? '',
        input.filed_before ?? '',
        String(input.max_results),
      ].join('\n'),
    );
    return `courtlistener_search:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    const base = CL_BASE();
    const fail = (error: string): Output => ({
      query: input.query,
      type: input.type,
      total_matches: 0,
      results: [],
      coverage_note: COVERAGE_NOTE,
      error,
      candidates: candidates_for(input, 'error'),
    });

    // Shape checks live in execute(), never as an input_schema regex — a regex
    // in a tool schema silently disables the whole tool's GBNF grammar on the
    // llama.cpp tier (see the private dev log).
    const params = new URLSearchParams({
      q: input.query,
      type: TYPE_PARAM[input.type],
      order_by: 'score desc',
    });
    if (input.court) params.set('court', input.court.trim());
    for (const [field, raw] of [
      ['filed_after', input.filed_after],
      ['filed_before', input.filed_before],
    ] as const) {
      if (!raw) continue;
      const converted = to_cl_date(raw);
      if (!converted) {
        return fail(
          `${field} must be ISO YYYY-MM-DD (got "${raw}"). Re-call with e.g. "2015-01-01".`,
        );
      }
      params.set(field, converted);
    }

    const url = `${base.replace(/\/$/, '')}/api/rest/v4/search/?${params.toString()}`;
    const token = CL_TOKEN();
    const res = await safe_fetch(
      url,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'hearth-research/1.0 (household research)',
          ...(token ? { Authorization: `Token ${token}` } : {}),
        },
      },
      TIMEOUT_MS,
    );

    if (!res.ok) {
      const out = fail(
        res.error ??
          `CourtListener returned HTTP ${res.status}` +
            (res.status === 429 ? ' (rate limited — set COURTLISTENER_API_TOKEN)' : ''),
      );
      audit_connector(audit_ctx(ctx), 'courtlistener_search', input, undefined, out.error);
      return out;
    }

    let parsed: { count?: number; results?: RawHit[] };
    try {
      parsed = JSON.parse(res.body) as { count?: number; results?: RawHit[] };
    } catch (err) {
      const out = fail(`CourtListener response was not JSON: ${(err as Error).message}`);
      audit_connector(audit_ctx(ctx), 'courtlistener_search', input, undefined, out.error);
      return out;
    }

    const hits = Array.isArray(parsed.results) ? parsed.results : [];
    const results = hits.slice(0, input.max_results).map((h) => map_hit(h, base));
    const out: Output = {
      query: input.query,
      type: input.type,
      total_matches: typeof parsed.count === 'number' ? parsed.count : results.length,
      results,
      coverage_note: COVERAGE_NOTE,
      ...(results.length === 0 ? { candidates: candidates_for(input, 'empty') } : {}),
    };
    audit_connector(audit_ctx(ctx), 'courtlistener_search', input, {
      total_matches: out.total_matches,
      returned: results.length,
    });
    return out;
  },
};
