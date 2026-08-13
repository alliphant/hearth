/**
 * sec_edgar — SEC EDGAR full-filings access for Vivian (2026-05-30).
 *
 * Free, authoritative, no API key required — just a User-Agent header
 * naming the household (SEC's fair-use policy at
 * https://www.sec.gov/os/accessing-edgar-data). The relevant endpoints:
 *
 *   - https://www.sec.gov/files/company_tickers.json — CIK ↔ ticker lookup
 *   - https://data.sec.gov/submissions/CIK<10-pad>.json — recent filings
 *   - https://data.sec.gov/api/xbrl/companyconcept/CIK<10-pad>/us-gaap/<tag>.json
 *     — financial concept values from XBRL filings
 *   - Filing primary docs at
 *     https://www.sec.gov/Archives/edgar/data/<cik-no-pad>/<accession-no-dashes>/<primary-doc>
 *
 * Four tools, all `read` risk:
 *   - edgar_search_filings — list recent filings by ticker, optionally
 *     filtered by form type (10-K / 10-Q / 8-K / DEF 14A / Form 4 / 13F)
 *   - edgar_read_filing — fetch a specific filing's primary document as
 *     markdown (via the existing Firecrawl path so paywalled forms get
 *     the the workstation fallback)
 *   - edgar_insider_activity — Form 4 transactions on a ticker over a
 *     window (cluster execs buying with their own money is signal; sells
 *     are noisy because exec comp is mostly stock — persona handles
 *     interpretation)
 *   - edgar_institutional_holdings — 13F filings for a ticker, listing
 *     which funds hold it. Persona caveat: 45-day legal lag means the
 *     institutions already moved; this is context, not action.
 *
 * Vivian uses these for evidence-based portfolio context, never as a
 * stock-picking signal generator. The persona section in vivian.yaml
 * holds the line.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import { safe_fetch } from './_audit';

const EDGAR_USER_AGENT =
  process.env.SEC_EDGAR_USER_AGENT ?? 'Hearth (jasper@hearthcrew.com)';

// In-memory cache for the CIK lookup. The file is ~1MB and rarely
// changes; refetch every 24h to keep new IPOs current.
let CIK_CACHE: { data: Map<string, string>; loaded_at: number } | null = null;
const CIK_TTL_MS = 24 * 60 * 60 * 1000;

interface CompanyTicker {
  ticker?: string;
  cik_str?: number | string;
  title?: string;
}

async function load_cik_map(): Promise<Map<string, string>> {
  if (CIK_CACHE && Date.now() - CIK_CACHE.loaded_at < CIK_TTL_MS) {
    return CIK_CACHE.data;
  }
  const res = await safe_fetch(
    'https://www.sec.gov/files/company_tickers.json',
    {
      headers: {
        'User-Agent': EDGAR_USER_AGENT,
        Accept: 'application/json',
      },
    },
  );
  if (!res.ok) {
    throw new Error(`SEC ticker lookup failed: HTTP ${res.status}`);
  }
  const map = new Map<string, string>();
  try {
    const json = JSON.parse(res.body) as Record<string, CompanyTicker>;
    for (const entry of Object.values(json)) {
      if (typeof entry?.ticker === 'string' && entry?.cik_str !== undefined) {
        const cik_pad = String(entry.cik_str).padStart(10, '0');
        map.set(entry.ticker.toUpperCase(), cik_pad);
      }
    }
  } catch (err) {
    throw new Error(`SEC ticker parse failed: ${(err as Error).message}`);
  }
  CIK_CACHE = { data: map, loaded_at: Date.now() };
  return map;
}

async function ticker_to_cik(
  ticker: string,
): Promise<{ cik: string; ticker_norm: string } | { error: string; candidates: string[] }> {
  const t_norm = ticker.toUpperCase().trim();
  const map = await load_cik_map();
  const direct = map.get(t_norm);
  if (direct) return { cik: direct, ticker_norm: t_norm };
  // Recovery hint: surface nearest tickers by prefix so the LLM can
  // retry instead of fabricating.
  const candidates: string[] = [];
  for (const k of map.keys()) {
    if (k.startsWith(t_norm) || t_norm.startsWith(k)) {
      candidates.push(k);
      if (candidates.length >= 8) break;
    }
  }
  return {
    error: `ticker "${t_norm}" not found in SEC registry`,
    candidates,
  };
}

interface SecSubmissionsResponse {
  cik: string;
  name: string;
  tickers?: string[];
  filings?: {
    recent?: {
      accessionNumber: string[];
      filingDate: string[];
      form: string[];
      primaryDocument: string[];
      primaryDocDescription: string[];
    };
  };
}

// ── edgar_search_filings ────────────────────────────────────────────────────

const SearchInputSchema = z.object({
  ticker: z.string().min(1).max(8).describe(
    'Stock ticker symbol (e.g. "AAPL", "MSFT"). Case-insensitive.',
  ),
  form_type: z
    .string()
    .max(16)
    .optional()
    .describe(
      'Filter to a specific filing form: "10-K" (annual), "10-Q" (quarterly), "8-K" (material events), "DEF 14A" (proxy), "4" (insider transactions), "13F-HR" (institutional holdings). Omit for all recent filings.',
    ),
  limit: z.number().int().min(1).max(40).default(10),
});

const FilingSchema = z.object({
  accession_number: z.string(),
  filing_date: z.string(),
  form: z.string(),
  primary_document: z.string(),
  description: z.string().nullable(),
  filing_url: z.string(),
});

const SearchOutputSchema = z.object({
  ticker: z.string(),
  cik: z.string(),
  company_name: z.string(),
  filings: z.array(FilingSchema),
  error: z.string().optional(),
  candidates: z.array(z.string()).optional(),
});

type SearchIn = z.infer<typeof SearchInputSchema>;
type SearchOut = z.infer<typeof SearchOutputSchema>;

export const edgar_search_filings: Tool<SearchIn, SearchOut> = {
  name: 'edgar_search_filings',
  description:
    "Search recent SEC filings for a ticker via EDGAR. Returns the most recent N filings with their form type, filing date, and a URL to the primary document. Filter to a specific form_type ('10-K' annual, '10-Q' quarterly, '8-K' material events, 'DEF 14A' proxy, '4' insider, '13F-HR' institutional) when you know what you're looking for. Use this for fundamentals research, NOT for stock picking — Vivian's persona handles the interpretation discipline. Returns a `candidates` recovery hint when the ticker isn't found.",
  risk: 'read',
  required_capabilities: ['read_finance_signals'],
  input_schema: SearchInputSchema,
  output_schema: SearchOutputSchema,

  idempotency_key(input) {
    return `edgar_search:${input.ticker.toUpperCase()}:${input.form_type ?? '*'}:${input.limit}`;
  },

  async execute(input: SearchIn, _ctx: ToolContext): Promise<SearchOut> {
    const lookup = await ticker_to_cik(input.ticker);
    if ('error' in lookup) {
      return {
        ticker: input.ticker.toUpperCase(),
        cik: '',
        company_name: '',
        filings: [],
        error: lookup.error,
        candidates: lookup.candidates,
      };
    }
    const cik_no_pad = String(parseInt(lookup.cik, 10));
    const res = await safe_fetch(
      `https://data.sec.gov/submissions/CIK${lookup.cik}.json`,
      {
        headers: {
          'User-Agent': EDGAR_USER_AGENT,
          Accept: 'application/json',
        },
      },
    );
    if (!res.ok) {
      return {
        ticker: lookup.ticker_norm,
        cik: lookup.cik,
        company_name: '',
        filings: [],
        error: `SEC submissions HTTP ${res.status}`,
      };
    }
    let parsed: SecSubmissionsResponse;
    try {
      parsed = JSON.parse(res.body) as SecSubmissionsResponse;
    } catch (err) {
      return {
        ticker: lookup.ticker_norm,
        cik: lookup.cik,
        company_name: '',
        filings: [],
        error: `SEC submissions parse failed: ${(err as Error).message}`,
      };
    }
    const recent = parsed.filings?.recent;
    if (!recent) {
      return {
        ticker: lookup.ticker_norm,
        cik: lookup.cik,
        company_name: parsed.name ?? '',
        filings: [],
      };
    }
    const form_filter = input.form_type?.toUpperCase().trim();
    const filings: z.infer<typeof FilingSchema>[] = [];
    for (let i = 0; i < recent.form.length; i++) {
      const form = recent.form[i] ?? '';
      if (form_filter && form.toUpperCase() !== form_filter) continue;
      const accession = recent.accessionNumber[i] ?? '';
      const accession_no_dashes = accession.replace(/-/g, '');
      const primary = recent.primaryDocument[i] ?? '';
      filings.push({
        accession_number: accession,
        filing_date: recent.filingDate[i] ?? '',
        form,
        primary_document: primary,
        description: recent.primaryDocDescription[i] ?? null,
        filing_url: `https://www.sec.gov/Archives/edgar/data/${cik_no_pad}/${accession_no_dashes}/${primary}`,
      });
      if (filings.length >= input.limit) break;
    }
    return {
      ticker: lookup.ticker_norm,
      cik: lookup.cik,
      company_name: parsed.name ?? '',
      filings,
    };
  },
};

// ── edgar_read_filing ───────────────────────────────────────────────────────
//
// Thin wrapper that fetches the primary document URL and returns the raw
// HTML/XBRL body. Most callers will use this for short forms (8-K, Form
// 4); for 10-K and 10-Q full text Vivian should route through
// `web_fetch_clean` (which converts to markdown and handles the long
// document better). We expose the raw text path here because some
// downstream parsers want the XBRL structure intact.

const ReadInputSchema = z.object({
  filing_url: z.string().url().describe(
    'The primary_document URL returned by edgar_search_filings.',
  ),
  max_chars: z.number().int().min(1000).max(500_000).default(100_000),
});

const ReadOutputSchema = z.object({
  filing_url: z.string(),
  content: z.string(),
  content_length: z.number(),
  truncated: z.boolean(),
  error: z.string().optional(),
});

type ReadIn = z.infer<typeof ReadInputSchema>;
type ReadOut = z.infer<typeof ReadOutputSchema>;

export const edgar_read_filing: Tool<ReadIn, ReadOut> = {
  name: 'edgar_read_filing',
  description:
    "Fetch a SEC filing's primary document directly from EDGAR. Returns raw HTML/XBRL content up to max_chars. For long forms (10-K, 10-Q) you'll generally want `web_fetch_clean` instead — it converts to clean markdown. Use this when you need the raw XBRL structure intact (Form 4 transaction tables, 13F holdings lists, structured fundamental data).",
  risk: 'read',
  required_capabilities: ['read_finance_signals'],
  input_schema: ReadInputSchema,
  output_schema: ReadOutputSchema,
  llm_budget: 4000,

  idempotency_key(input) {
    return `edgar_read:${createHash('sha256').update(input.filing_url).digest('hex').slice(0, 16)}`;
  },

  async execute(input: ReadIn, _ctx: ToolContext): Promise<ReadOut> {
    const res = await safe_fetch(input.filing_url, {
      headers: {
        'User-Agent': EDGAR_USER_AGENT,
      },
    });
    if (!res.ok) {
      return {
        filing_url: input.filing_url,
        content: '',
        content_length: 0,
        truncated: false,
        error: `EDGAR HTTP ${res.status}: ${res.body.slice(0, 200)}`,
      };
    }
    const truncated = res.body.length > input.max_chars;
    return {
      filing_url: input.filing_url,
      content: truncated ? res.body.slice(0, input.max_chars) : res.body,
      content_length: res.body.length,
      truncated,
    };
  },
};

// ── edgar_insider_activity ──────────────────────────────────────────────────

const InsiderInputSchema = z.object({
  ticker: z.string().min(1).max(8),
  limit: z.number().int().min(1).max(30).default(15).describe(
    'Number of recent Form 4 filings to surface. Cluster buys within ~2 weeks are a known weak signal worth noting; isolated sells are noisy (exec comp is mostly stock).',
  ),
});

const InsiderRowSchema = z.object({
  accession_number: z.string(),
  filing_date: z.string(),
  filing_url: z.string(),
  description: z.string().nullable(),
});

const InsiderOutputSchema = z.object({
  ticker: z.string(),
  cik: z.string(),
  company_name: z.string(),
  insider_filings: z.array(InsiderRowSchema),
  guidance: z.string(),
  error: z.string().optional(),
  candidates: z.array(z.string()).optional(),
});

type InsiderIn = z.infer<typeof InsiderInputSchema>;
type InsiderOut = z.infer<typeof InsiderOutputSchema>;

export const edgar_insider_activity: Tool<InsiderIn, InsiderOut> = {
  name: 'edgar_insider_activity',
  description:
    "List recent Form 4 (insider transaction) filings for a ticker. Each row links to the filing; use edgar_read_filing or web_fetch_clean to see the actual transaction details. The persona disposition: cluster buying by multiple execs within a ~2-week window is a known weak signal worth noting; isolated sells are noisy because exec comp is heavily stock-based. Never treated as a buy/sell signal on its own.",
  risk: 'read',
  required_capabilities: ['read_finance_signals'],
  input_schema: InsiderInputSchema,
  output_schema: InsiderOutputSchema,

  idempotency_key(input) {
    return `edgar_insider:${input.ticker.toUpperCase()}:${input.limit}`;
  },

  async execute(input: InsiderIn, ctx: ToolContext): Promise<InsiderOut> {
    const search = await edgar_search_filings.execute(
      { ticker: input.ticker, form_type: '4', limit: input.limit },
      ctx,
    );
    return {
      ticker: search.ticker,
      cik: search.cik,
      company_name: search.company_name,
      insider_filings: search.filings.map((f) => ({
        accession_number: f.accession_number,
        filing_date: f.filing_date,
        filing_url: f.filing_url,
        description: f.description,
      })),
      guidance:
        'Cluster-buys by multiple insiders within ~2 weeks are a known weak signal worth noting. Isolated sells are noisy — most exec comp is stock-based. Never treat any single Form 4 as a buy/sell signal.',
      error: search.error,
      candidates: search.candidates,
    };
  },
};

// ── edgar_institutional_holdings ────────────────────────────────────────────

const HoldingsInputSchema = z.object({
  ticker: z.string().min(1).max(8),
  limit: z.number().int().min(1).max(30).default(15),
});

const HoldingsOutputSchema = z.object({
  ticker: z.string(),
  cik: z.string(),
  company_name: z.string(),
  thirteen_f_filings: z.array(InsiderRowSchema),
  guidance: z.string(),
  error: z.string().optional(),
  candidates: z.array(z.string()).optional(),
});

type HoldingsIn = z.infer<typeof HoldingsInputSchema>;
type HoldingsOut = z.infer<typeof HoldingsOutputSchema>;

export const edgar_institutional_holdings: Tool<HoldingsIn, HoldingsOut> = {
  name: 'edgar_institutional_holdings',
  description:
    "List recent 13F-HR (institutional holding) filings that reference a ticker. **The 45-day legal lag matters**: institutions had to disclose only after the reporting period ends, so anything you see here is what they HELD 45+ days ago, not what they hold now. Treat as context for understanding who owns a company structurally (passive index funds vs active managers), never as a tradeable signal.",
  risk: 'read',
  required_capabilities: ['read_finance_signals'],
  input_schema: HoldingsInputSchema,
  output_schema: HoldingsOutputSchema,

  idempotency_key(input) {
    return `edgar_13f:${input.ticker.toUpperCase()}:${input.limit}`;
  },

  async execute(input: HoldingsIn, ctx: ToolContext): Promise<HoldingsOut> {
    const search = await edgar_search_filings.execute(
      { ticker: input.ticker, form_type: '13F-HR', limit: input.limit },
      ctx,
    );
    return {
      ticker: search.ticker,
      cik: search.cik,
      company_name: search.company_name,
      thirteen_f_filings: search.filings.map((f) => ({
        accession_number: f.accession_number,
        filing_date: f.filing_date,
        filing_url: f.filing_url,
        description: f.description,
      })),
      guidance:
        '45-day legal disclosure lag: positions shown reflect holdings at the END of the reported quarter, not current. Use for structural ownership context (passive index funds dominate most large caps), never as a tradeable signal.',
      error: search.error,
      candidates: search.candidates,
    };
  },
};

// ── ToolLoader exports ──────────────────────────────────────────────────────

export function create(_deps: import('@core/tool_deps').ToolDeps): Tool[] {
  return [
    edgar_search_filings as Tool,
    edgar_read_filing as Tool,
    edgar_insider_activity as Tool,
    edgar_institutional_holdings as Tool,
  ];
}
