/**
 * sec_fundamentals — real financial statements + valuation for Vivian
 * (2026-06-14).
 *
 * The momentum tools answer "what is moving"; this answers "is the move
 * backed by a real business, or is it a story." Free, keyless SEC XBRL
 * (data.sec.gov) for the financials + the existing keyless Yahoo quote
 * for the live price → valuation ratios. One tool: company_fundamentals.
 *
 * It pulls each company's annual (10-K) series for the line items that
 * matter — revenue, net income, gross profit, diluted EPS, operating
 * cash flow, capex (→ free cash flow), assets/liabilities/equity, cash,
 * shares — computes growth + margins + leverage, and combines the latest
 * price with shares + EPS + revenue for market cap / P/E / P/S. It also
 * surfaces the most recent 8-K (material-event filing) so a name that's
 * MOVING and just filed something is obvious at a glance.
 *
 * Self-contained SEC client (its own seam-aware CIK map + concept +
 * submissions fetchers) so the smoke can fixture it without touching the
 * sec_edgar connector. Envs:
 *   SEC_DATA_BASE    default https://data.sec.gov   (xbrl + submissions)
 *   SEC_TICKERS_URL  default https://www.sec.gov/files/company_tickers.json
 *   SEC_EDGAR_USER_AGENT  the fair-use UA header (shared with sec_edgar)
 *
 * Gated on read_market_data (Vivian's market surface); pure read.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import { safe_fetch } from './_audit';
import { market_quote } from './market_data';

const SEC_DATA_BASE = () => process.env.SEC_DATA_BASE ?? 'https://data.sec.gov';
const SEC_TICKERS_URL = () =>
  process.env.SEC_TICKERS_URL ?? 'https://www.sec.gov/files/company_tickers.json';
const SEC_UA = () =>
  process.env.SEC_EDGAR_USER_AGENT ?? 'Hearth (jasper@hearthcrew.com)';

// ── seam-aware SEC client ────────────────────────────────────────────────────

let CIK_CACHE: { map: Map<string, { cik: string; name: string }>; at: number } | null = null;
const CIK_TTL_MS = 24 * 60 * 60 * 1000;

interface CompanyTicker {
  ticker?: string;
  cik_str?: number | string;
  title?: string;
}

async function load_cik_map(): Promise<Map<string, { cik: string; name: string }>> {
  if (CIK_CACHE && Date.now() - CIK_CACHE.at < CIK_TTL_MS) return CIK_CACHE.map;
  const res = await safe_fetch(SEC_TICKERS_URL(), {
    headers: { 'User-Agent': SEC_UA(), Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`SEC ticker map HTTP ${res.status}`);
  const map = new Map<string, { cik: string; name: string }>();
  const json = JSON.parse(res.body) as Record<string, CompanyTicker>;
  for (const e of Object.values(json)) {
    if (typeof e?.ticker === 'string' && e?.cik_str !== undefined) {
      map.set(e.ticker.toUpperCase(), {
        cik: String(e.cik_str).padStart(10, '0'),
        name: e.title ?? '',
      });
    }
  }
  CIK_CACHE = { map, at: Date.now() };
  return map;
}

async function ticker_to_cik(
  ticker: string,
): Promise<{ cik: string; name: string; norm: string } | { error: string; candidates: string[] }> {
  const norm = ticker.toUpperCase().trim();
  const map = await load_cik_map();
  const hit = map.get(norm);
  if (hit) return { cik: hit.cik, name: hit.name, norm };
  const candidates: string[] = [];
  for (const k of map.keys()) {
    if (k.startsWith(norm) || norm.startsWith(k)) {
      candidates.push(k);
      if (candidates.length >= 8) break;
    }
  }
  return { error: `ticker "${norm}" not found in SEC registry`, candidates };
}

interface XbrlFact {
  end?: string;
  start?: string;
  val?: number;
  form?: string;
  filed?: string;
}

/**
 * Fetch a concept's facts under EVERY candidate tag (not first-hit). A
 * company migrates XBRL tags over the years — e.g. NVDA's recent revenue
 * lives under `Revenues` while an older segment tag still carries stale
 * pre-2022 values; first-hit-wins would return the stale one. The caller
 * picks the freshest series across all tags' facts.
 */
async function fetch_concept_all(
  cik: string,
  namespace: string,
  tags: string[],
): Promise<XbrlFact[][]> {
  const out: XbrlFact[][] = [];
  for (const tag of tags) {
    const res = await safe_fetch(
      `${SEC_DATA_BASE()}/api/xbrl/companyconcept/CIK${cik}/${namespace}/${tag}.json`,
      { headers: { 'User-Agent': SEC_UA(), Accept: 'application/json' } },
    );
    if (!res.ok) continue;
    try {
      const parsed = JSON.parse(res.body) as { units?: Record<string, XbrlFact[]> };
      const units = parsed.units ?? {};
      const arr =
        units['USD'] ??
        units['USD/shares'] ??
        units['shares'] ??
        Object.values(units)[0];
      if (Array.isArray(arr) && arr.length > 0) out.push(arr);
    } catch {
      /* try next tag */
    }
  }
  return out;
}

export interface AnnualPoint {
  fy_end: string;
  value: number;
}

/** Latest-filed annual (10-K) value per fiscal year, oldest→newest. */
function annual_series(facts: XbrlFact[], kind: 'duration' | 'instant'): AnnualPoint[] {
  const by_year = new Map<string, { end: string; val: number; filed: string }>();
  for (const f of facts) {
    if (typeof f.val !== 'number' || !f.end) continue;
    const form = f.form ?? '';
    if (form !== '10-K' && form !== '10-K/A') continue;
    if (kind === 'duration') {
      if (!f.start) continue;
      const span = (Date.parse(f.end) - Date.parse(f.start)) / 86_400_000;
      if (span < 340 || span > 380) continue; // annual span only — drops quarters
    }
    const year = f.end.slice(0, 4);
    const filed = f.filed ?? '';
    const prev = by_year.get(year);
    if (!prev || filed > prev.filed) by_year.set(year, { end: f.end, val: f.val, filed });
  }
  return [...by_year.values()]
    .sort((a, b) => (a.end < b.end ? -1 : 1))
    .map((p) => ({ fy_end: p.end, value: p.val }));
}

/**
 * The freshest annual series across all of a concept's candidate tags —
 * the one whose latest fiscal year is most recent (tiebreak: more points).
 * Guards against an outdated tag shadowing the current one.
 */
function best_annual(lists: XbrlFact[][], kind: 'duration' | 'instant'): AnnualPoint[] {
  let best: AnnualPoint[] = [];
  let best_end = '';
  for (const facts of lists) {
    const series = annual_series(facts, kind);
    if (series.length === 0) continue;
    const last_end = series[series.length - 1]?.fy_end ?? '';
    if (last_end > best_end || (last_end === best_end && series.length > best.length)) {
      best = series;
      best_end = last_end;
    }
  }
  return best;
}

/** Most-recent value by period end across all candidate tags' facts. */
function latest_value(lists: XbrlFact[][]): number | null {
  let best: { end: string; val: number } | null = null;
  for (const facts of lists) {
    for (const f of facts) {
      if (typeof f.val !== 'number' || !f.end) continue;
      if (!best || f.end > best.end) best = { end: f.end, val: f.val };
    }
  }
  return best?.val ?? null;
}

interface RecentEvent {
  form: string;
  filed_at: string;
  days_ago: number;
  description: string | null;
}

interface SubmissionsRecent {
  form?: string[];
  filingDate?: string[];
  primaryDocDescription?: string[];
}

/** Latest 8-K within `within_days`, plus the latest periodic filing date. */
async function recent_filings(
  cik: string,
  now: Date,
  within_days = 30,
): Promise<{ recent_8k: RecentEvent | null; latest_periodic: RecentEvent | null }> {
  const res = await safe_fetch(`${SEC_DATA_BASE()}/submissions/CIK${cik}.json`, {
    headers: { 'User-Agent': SEC_UA(), Accept: 'application/json' },
  });
  if (!res.ok) return { recent_8k: null, latest_periodic: null };
  let recent: SubmissionsRecent;
  try {
    recent = (JSON.parse(res.body) as { filings?: { recent?: SubmissionsRecent } }).filings?.recent ?? {};
  } catch {
    return { recent_8k: null, latest_periodic: null };
  }
  const forms = recent.form ?? [];
  const dates = recent.filingDate ?? [];
  const descs = recent.primaryDocDescription ?? [];
  const mk = (i: number): RecentEvent => {
    const filed = dates[i] ?? '';
    return {
      form: forms[i] ?? '',
      filed_at: filed,
      days_ago: filed ? Math.round((now.getTime() - Date.parse(filed)) / 86_400_000) : -1,
      description: descs[i] || null,
    };
  };
  let recent_8k: RecentEvent | null = null;
  let latest_periodic: RecentEvent | null = null;
  // Submissions are newest-first.
  for (let i = 0; i < forms.length; i++) {
    const form = forms[i] ?? '';
    if (!recent_8k && form === '8-K') {
      const ev = mk(i);
      if (ev.days_ago >= 0 && ev.days_ago <= within_days) recent_8k = ev;
    }
    if (!latest_periodic && (form === '10-K' || form === '10-Q')) latest_periodic = mk(i);
    if (recent_8k && latest_periodic) break;
  }
  return { recent_8k, latest_periodic };
}

// ── pure helpers (exported for the smoke) ────────────────────────────────────

export function pct_change(curr: number | null, prev: number | null): number | null {
  if (curr === null || prev === null || prev === 0) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

/** Compound annual growth rate (%) over the series; null if too short/invalid. */
export function cagr_pct(series: AnnualPoint[]): number | null {
  if (series.length < 2) return null;
  const first = series[0];
  const last = series[series.length - 1];
  if (!first || !last || first.value <= 0 || last.value <= 0) return null;
  const years = series.length - 1;
  return (Math.pow(last.value / first.value, 1 / years) - 1) * 100;
}

function round(v: number | null, dp = 2): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function last_val(series: AnnualPoint[]): number | null {
  return series.length ? (series[series.length - 1]?.value ?? null) : null;
}

// ── the tool ─────────────────────────────────────────────────────────────────

const InputSchema = z.object({
  ticker: z
    .string()
    .min(1)
    .max(8)
    .describe('Stock ticker, e.g. "NVDA". Case-insensitive. US filers only (SEC XBRL).'),
  years: z
    .number()
    .int()
    .min(2)
    .max(6)
    .default(5)
    .describe('How many fiscal years of history to return.'),
});

const SeriesSchema = z.array(z.object({ fy_end: z.string(), value: z.number() }));

const OutputSchema = z.object({
  ticker: z.string(),
  company_name: z.string(),
  price: z.number().nullable(),
  as_of: z.string(),
  fundamentals: z
    .object({
      revenue: SeriesSchema,
      net_income: SeriesSchema,
      gross_profit: SeriesSchema,
      eps_diluted: SeriesSchema,
      operating_cash_flow: SeriesSchema,
      free_cash_flow: SeriesSchema,
      shares_outstanding: z.number().nullable(),
      total_assets: z.number().nullable(),
      total_liabilities: z.number().nullable(),
      stockholders_equity: z.number().nullable(),
      cash: z.number().nullable(),
    })
    .nullable(),
  derived: z
    .object({
      revenue_growth_yoy_pct: z.number().nullable(),
      revenue_cagr_pct: z.number().nullable(),
      gross_margin_pct: z.number().nullable(),
      net_margin_pct: z.number().nullable(),
      fcf_margin_pct: z.number().nullable(),
      debt_to_equity: z.number().nullable(),
      profitable_ttm: z.boolean().nullable(),
    })
    .nullable(),
  valuation: z
    .object({
      market_cap: z.number().nullable(),
      pe_fy: z.number().nullable(),
      ps_fy: z.number().nullable(),
      basis: z.string(),
    })
    .nullable(),
  recent_8k: z
    .object({
      filed_at: z.string(),
      days_ago: z.number(),
      description: z.string().nullable(),
    })
    .nullable(),
  latest_periodic_filing: z
    .object({ form: z.string(), filed_at: z.string(), days_ago: z.number() })
    .nullable(),
  error: z.string().optional(),
  candidates: z.array(z.string()).optional(),
  note: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export const company_fundamentals: Tool<Input, Output> = {
  name: 'company_fundamentals',
  description:
    "Real financial statements + valuation for a US-listed company, straight from its SEC filings (XBRL). Returns annual revenue / net income / gross profit / diluted EPS / operating & free cash flow series, balance-sheet snapshot, computed growth + margins + debt-to-equity, and live market cap / P/E / P/S, plus the most recent 8-K (material event). Use this to VET a momentum name — is the run backed by accelerating revenue and real profit, or is it a pre-revenue story? US filers only; a non-US/unknown ticker returns `candidates`.",
  risk: 'read',
  required_capabilities: ['read_market_data'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    return `company_fundamentals:${input.ticker.toUpperCase()}:${input.years}`;
  },

  async execute(input: Input, _ctx: ToolContext): Promise<Output> {
    const now = _ctx.now ?? new Date();
    const base: Output = {
      ticker: input.ticker.toUpperCase(),
      company_name: '',
      price: null,
      as_of: now.toISOString(),
      fundamentals: null,
      derived: null,
      valuation: null,
      recent_8k: null,
      latest_periodic_filing: null,
    };

    const lookup = await ticker_to_cik(input.ticker);
    if ('error' in lookup) {
      return { ...base, error: lookup.error, candidates: lookup.candidates };
    }
    base.company_name = lookup.name;

    // Financials (parallel, bounded) + recent filings + price.
    const want: Array<[keyof typeof FETCHERS, () => Promise<XbrlFact[][]>]> = [];
    const FETCHERS = {
      revenue: () =>
        fetch_concept_all(lookup.cik, 'us-gaap', [
          'RevenueFromContractWithCustomerExcludingAssessedTax',
          'Revenues',
          'RevenueFromContractWithCustomerIncludingAssessedTax',
          'SalesRevenueNet',
        ]),
      net_income: () => fetch_concept_all(lookup.cik, 'us-gaap', ['NetIncomeLoss', 'ProfitLoss']),
      gross_profit: () => fetch_concept_all(lookup.cik, 'us-gaap', ['GrossProfit']),
      eps_diluted: () =>
        fetch_concept_all(lookup.cik, 'us-gaap', ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted']),
      ocf: () =>
        fetch_concept_all(lookup.cik, 'us-gaap', [
          'NetCashProvidedByUsedInOperatingActivities',
          'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
        ]),
      capex: () =>
        fetch_concept_all(lookup.cik, 'us-gaap', [
          'PaymentsToAcquirePropertyPlantAndEquipment',
          'PaymentsToAcquireProductiveAssets',
        ]),
      assets: () => fetch_concept_all(lookup.cik, 'us-gaap', ['Assets']),
      liabilities: () => fetch_concept_all(lookup.cik, 'us-gaap', ['Liabilities']),
      equity: () =>
        fetch_concept_all(lookup.cik, 'us-gaap', [
          'StockholdersEquity',
          'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
        ]),
      cash: () =>
        fetch_concept_all(lookup.cik, 'us-gaap', [
          'CashAndCashEquivalentsAtCarryingValue',
          'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
        ]),
      shares_dei: () => fetch_concept_all(lookup.cik, 'dei', ['EntityCommonStockSharesOutstanding']),
      shares_gaap: () => fetch_concept_all(lookup.cik, 'us-gaap', ['CommonStockSharesOutstanding', 'CommonStockSharesIssued']),
    } as const;
    for (const k of Object.keys(FETCHERS) as Array<keyof typeof FETCHERS>) {
      want.push([k, FETCHERS[k]]);
    }

    const facts: Partial<Record<keyof typeof FETCHERS, XbrlFact[][]>> = {};
    // Bounded concurrency (SEC fair-use ~10 req/s) — pool of 4.
    let idx = 0;
    const workers = Array.from({ length: 4 }, async () => {
      while (idx < want.length) {
        const i = idx++;
        const entry = want[i];
        if (!entry) continue;
        try {
          facts[entry[0]] = await entry[1]();
        } catch {
          facts[entry[0]] = [];
        }
      }
    });
    const [, , quote_out] = await Promise.all([
      Promise.all(workers),
      recent_filings(lookup.cik, now).then((rf) => {
        base.recent_8k = rf.recent_8k
          ? { filed_at: rf.recent_8k.filed_at, days_ago: rf.recent_8k.days_ago, description: rf.recent_8k.description }
          : null;
        base.latest_periodic_filing = rf.latest_periodic
          ? { form: rf.latest_periodic.form, filed_at: rf.latest_periodic.filed_at, days_ago: rf.latest_periodic.days_ago }
          : null;
      }),
      market_quote.execute({ symbols: [input.ticker] }, _ctx).catch(() => null),
    ]);
    const price = quote_out?.quotes?.[0]?.price ?? null;
    base.price = price;

    const rev = best_annual(facts.revenue ?? [], 'duration').slice(-input.years);
    const ni = best_annual(facts.net_income ?? [], 'duration').slice(-input.years);
    const gp = best_annual(facts.gross_profit ?? [], 'duration').slice(-input.years);
    const eps = best_annual(facts.eps_diluted ?? [], 'duration').slice(-input.years);
    const ocf = best_annual(facts.ocf ?? [], 'duration').slice(-input.years);
    const capex = best_annual(facts.capex ?? [], 'duration').slice(-input.years);

    if (rev.length === 0 && ni.length === 0 && eps.length === 0) {
      return {
        ...base,
        error: `no US-GAAP XBRL financials for ${lookup.norm} (foreign/IFRS filer, ETF, or pre-IPO?)`,
        note: 'company_fundamentals covers US domestic filers; use web_search for an IFRS filer or fund.',
      };
    }

    // Free cash flow = operating cash flow − capex, matched by fiscal year.
    const capex_by_year = new Map(capex.map((p) => [p.fy_end, p.value]));
    const fcf: AnnualPoint[] = ocf.map((p) => ({
      fy_end: p.fy_end,
      value: p.value - (capex_by_year.get(p.fy_end) ?? 0),
    }));

    const shares = latest_value(facts.shares_dei ?? []) ?? latest_value(facts.shares_gaap ?? []);
    const assets = latest_value(facts.assets ?? []);
    const liabilities = latest_value(facts.liabilities ?? []);
    const equity = latest_value(facts.equity ?? []);
    const cash = latest_value(facts.cash ?? []);

    const rev_last = last_val(rev);
    const rev_prev = rev.length >= 2 ? (rev[rev.length - 2]?.value ?? null) : null;
    const ni_last = last_val(ni);
    const gp_last = last_val(gp);
    const fcf_last = last_val(fcf);
    const eps_last = last_val(eps);

    const fundamentals = {
      revenue: rev,
      net_income: ni,
      gross_profit: gp,
      eps_diluted: eps,
      operating_cash_flow: ocf,
      free_cash_flow: fcf,
      shares_outstanding: shares,
      total_assets: assets,
      total_liabilities: liabilities,
      stockholders_equity: equity,
      cash,
    };

    const derived = {
      revenue_growth_yoy_pct: round(pct_change(rev_last, rev_prev)),
      revenue_cagr_pct: round(cagr_pct(rev)),
      gross_margin_pct: round(gp_last !== null && rev_last ? (gp_last / rev_last) * 100 : null),
      net_margin_pct: round(ni_last !== null && rev_last ? (ni_last / rev_last) * 100 : null),
      fcf_margin_pct: round(fcf_last !== null && rev_last ? (fcf_last / rev_last) * 100 : null),
      debt_to_equity: round(liabilities !== null && equity && equity !== 0 ? liabilities / equity : null),
      profitable_ttm: ni_last !== null ? ni_last > 0 : null,
    };

    const market_cap = price !== null && shares ? price * shares : null;
    const valuation = {
      market_cap: round(market_cap, 0),
      pe_fy: round(price !== null && eps_last && eps_last > 0 ? price / eps_last : null),
      ps_fy: round(market_cap !== null && rev_last && rev_last > 0 ? market_cap / rev_last : null),
      basis: 'trailing fiscal year (10-K)',
    };

    return { ...base, fundamentals, derived, valuation };
  },
};

export function create(_deps: import('@core/tool_deps').ToolDeps): Tool[] {
  return [company_fundamentals as Tool];
}
