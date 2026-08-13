/**
 * market_data — live stock-market data + momentum analysis for Vivian
 * (2026-06-11).
 *
 * Free, keyless Yahoo Finance endpoints (browser User-Agent required;
 * base overridable via YAHOO_FINANCE_BASE_URL — the smoke's fixture-server
 * seam):
 *
 *   - /v8/finance/chart/<symbol>?range=..&interval=..   — quote meta + OHLCV
 *   - /v1/finance/trending/US?count=N                   — trending tickers
 *   - /v1/finance/screener/predefined/saved?scrIds=day_gainers — gainers
 *   - /v1/finance/search?q=..                           — symbol candidates
 *     (the recovery-hint source: a failed symbol returns `candidates`)
 *
 * NOTE the v7 /finance/quote and custom-screener endpoints need a
 * crumb+cookie dance — deliberately NOT used; everything here rides the
 * four keyless endpoints above.
 *
 * Six tools, all `read` risk, gated on `read_market_data`:
 *   - market_quote        — batch quotes (price, session change, 52w range)
 *   - market_history      — OHLCV closes for one symbol, downsampled
 *   - technical_snapshot  — one symbol: returns / SMA trend / RSI /
 *                           volume surge / volatility / drawdown
 *   - market_movers       — trending or day-gainer tickers, enriched
 *   - momentum_screen     — rank a universe (theme / explicit symbols /
 *                           trending) by a transparent momentum blend
 *   - list_market_themes  — the universes in config/market-themes.yaml
 *
 * Honesty contract: these tools measure what IS moving — they do not
 * predict what will move. Output shapes carry the risk numbers
 * (volatility, drawdown) next to the momentum numbers so Vivian's
 * persona can keep every radar pick honest. Momentum metrics are pure
 * math over fetched bars; nothing here is an LLM judgment.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parse as parse_yaml } from 'yaml';
import type { Tool, ToolContext } from '@core/tool';
import { local_iso_date } from '@core/time';
import { safe_fetch } from './_audit';

const YF_BASE = () =>
  process.env.YAHOO_FINANCE_BASE_URL ?? 'https://query1.finance.yahoo.com';
const YF_USER_AGENT =
  process.env.YAHOO_FINANCE_USER_AGENT ??
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
/** Resolve the themes file path (env override wins) — also the write seam
 *  for `update_market_themes`, so reads and writes target one file. */
export const THEMES_PATH = (): string =>
  process.env.HEARTH_MARKET_THEMES ??
  resolve(import.meta.dir, '../../config/market-themes.yaml');

export const SYMBOL_RE = /^[A-Za-z0-9.\-^=]{1,12}$/;
// NOTE: `SymbolSchema` is a plain length-bounded string — NO `.regex()`. A tool
// input_schema becomes a GBNF grammar on the interactive 9B, and llama.cpp's
// converter mistranslates a regex `pattern` and SILENTLY disables the whole
// tool grammar (length bounds are fine — only a `pattern` triggers it). A
// malformed symbol is caught at resolution time: it fails to resolve at Yahoo
// and the tool returns `candidates` (similar real tickers), which is the
// recovery path already designed for a bad symbol. SYMBOL_RE stays exported for
// execute()-time shape checks (e.g. update_market_themes).
const SymbolSchema = z
  .string()
  .min(1)
  .max(12)
  .describe('A ticker symbol, e.g. "NVDA" or "BRK-B".');

// ── Yahoo response shapes (defensive — only the fields we read) ────────────

interface YfChartMeta {
  currency?: string;
  symbol?: string;
  exchangeTimezoneName?: string;
  regularMarketPrice?: number;
  regularMarketVolume?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  longName?: string;
  shortName?: string;
  regularMarketTime?: number;
}

interface YfChartResponse {
  chart?: {
    result?: Array<{
      meta?: YfChartMeta;
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: Array<number | null>; volume?: Array<number | null> }> };
    }>;
    error?: { code?: string; description?: string } | null;
  };
}

interface YfTrendingResponse {
  finance?: { result?: Array<{ quotes?: Array<{ symbol?: string }> }> };
}

interface YfScreenerResponse {
  finance?: { result?: Array<{ quotes?: Array<{ symbol?: string }> }> };
}

interface YfSearchResponse {
  quotes?: Array<{
    symbol?: string;
    shortname?: string;
    longname?: string;
    quoteType?: string;
    exchange?: string;
  }>;
}

/** A cleaned bar series — null closes dropped, arrays index-aligned. */
export interface BarSeries {
  symbol: string;
  name: string;
  currency: string;
  exchange_tz: string;
  price: number;
  fifty_two_week_high: number | null;
  fifty_two_week_low: number | null;
  as_of_ts: number | null;
  timestamps: number[];
  closes: number[];
  volumes: Array<number | null>;
}

async function fetch_chart(
  symbol: string,
  range: string,
  interval: string,
): Promise<BarSeries | { error: string }> {
  const sym = symbol.toUpperCase().trim();
  const res = await safe_fetch(
    `${YF_BASE()}/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}`,
    { headers: { 'User-Agent': YF_USER_AGENT, Accept: 'application/json' } },
  );
  if (!res.ok) return { error: `chart HTTP ${res.status} for ${sym}` };
  let parsed: YfChartResponse;
  try {
    parsed = JSON.parse(res.body) as YfChartResponse;
  } catch (err) {
    return { error: `chart parse failed for ${sym}: ${(err as Error).message}` };
  }
  const yf_err = parsed.chart?.error;
  if (yf_err) {
    return { error: `${sym}: ${yf_err.description ?? yf_err.code ?? 'unknown Yahoo error'}` };
  }
  const result = parsed.chart?.result?.[0];
  const meta = result?.meta;
  if (!result || !meta || typeof meta.regularMarketPrice !== 'number') {
    return { error: `no chart data for ${sym}` };
  }
  const raw_ts = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0];
  const raw_close = quote?.close ?? [];
  const raw_vol = quote?.volume ?? [];
  const timestamps: number[] = [];
  const closes: number[] = [];
  const volumes: Array<number | null> = [];
  for (let i = 0; i < raw_ts.length; i++) {
    const c = raw_close[i];
    const t = raw_ts[i];
    if (typeof c !== 'number' || typeof t !== 'number') continue;
    timestamps.push(t);
    closes.push(c);
    volumes.push(typeof raw_vol[i] === 'number' ? (raw_vol[i] as number) : null);
  }
  return {
    symbol: meta.symbol ?? sym,
    name: meta.longName ?? meta.shortName ?? sym,
    currency: meta.currency ?? 'USD',
    exchange_tz: meta.exchangeTimezoneName ?? 'America/New_York',
    price: meta.regularMarketPrice,
    fifty_two_week_high: meta.fiftyTwoWeekHigh ?? null,
    fifty_two_week_low: meta.fiftyTwoWeekLow ?? null,
    as_of_ts: meta.regularMarketTime ?? null,
    timestamps,
    closes,
    volumes,
  };
}

/** Symbol candidates for a failed lookup — the recovery-hint source. */
async function search_candidates(query: string): Promise<string[]> {
  const res = await safe_fetch(
    `${YF_BASE()}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=6&newsCount=0`,
    { headers: { 'User-Agent': YF_USER_AGENT, Accept: 'application/json' } },
  );
  if (!res.ok) return [];
  try {
    const parsed = JSON.parse(res.body) as YfSearchResponse;
    const out: string[] = [];
    for (const q of parsed.quotes ?? []) {
      if (typeof q.symbol !== 'string') continue;
      const name = q.longname ?? q.shortname ?? '';
      out.push(name ? `${q.symbol} (${name})` : q.symbol);
      if (out.length >= 6) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Bounded-concurrency map — keeps the fan-out polite to Yahoo. */
async function pooled_map<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        const item = items[i];
        if (item === undefined) continue;
        out[i] = await fn(item);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

// ── pure math (exported for the smoke) ─────────────────────────────────────

/** Percent return from `n` bars back to the last bar; null when too short. */
export function pct_return_over(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const last = closes[closes.length - 1];
  const base = closes[closes.length - 1 - n];
  if (last === undefined || base === undefined || base === 0) return null;
  return ((last - base) / base) * 100;
}

/** Simple moving average of the last `n` closes; null when too short. */
export function sma_last(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  let sum = 0;
  for (let i = closes.length - n; i < closes.length; i++) sum += closes[i] ?? 0;
  return sum / n;
}

/** Wilder RSI(14) over the series; null when fewer than 15 closes. */
export function rsi_14(closes: number[]): number | null {
  const period = 14;
  if (closes.length < period + 1) return null;
  let avg_gain = 0;
  let avg_loss = 0;
  for (let i = 1; i <= period; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (prev === undefined || cur === undefined) return null;
    const d = cur - prev;
    if (d > 0) avg_gain += d;
    else avg_loss -= d;
  }
  avg_gain /= period;
  avg_loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (prev === undefined || cur === undefined) continue;
    const d = cur - prev;
    avg_gain = (avg_gain * (period - 1) + Math.max(d, 0)) / period;
    avg_loss = (avg_loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avg_loss === 0) return 100;
  const rs = avg_gain / avg_loss;
  return 100 - 100 / (1 + rs);
}

/** Annualized volatility (%) from daily log returns; null when too short. */
export function annualized_volatility_pct(closes: number[]): number | null {
  if (closes.length < 10) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (prev === undefined || cur === undefined || prev <= 0 || cur <= 0) continue;
    rets.push(Math.log(cur / prev));
  }
  if (rets.length < 9) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance =
    rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

/** Max peak-to-trough decline (%) over the last `n` bars (positive magnitude). */
export function max_drawdown_pct(closes: number[], n?: number): number | null {
  const window = n ? closes.slice(-n) : closes;
  if (window.length < 2) return null;
  let peak = -Infinity;
  let max_dd = 0;
  for (const c of window) {
    if (c > peak) peak = c;
    else if (peak > 0) max_dd = Math.max(max_dd, ((peak - c) / peak) * 100);
  }
  return max_dd;
}

/** Avg volume last 5 bars vs avg over last 63 — >1 means volume is surging. */
export function volume_surge_ratio(volumes: Array<number | null>): number | null {
  const vols = volumes.filter((v): v is number => typeof v === 'number' && v > 0);
  if (vols.length < 25) return null;
  const recent = vols.slice(-5);
  const base = vols.slice(-63);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const base_avg = avg(base);
  if (base_avg <= 0) return null;
  return avg(recent) / base_avg;
}

/** Per-symbol momentum metrics computed from a 1y daily series. */
export interface MomentumMetrics {
  symbol: string;
  name: string;
  price: number;
  r_1mo_pct: number | null;
  r_3mo_pct: number | null;
  pct_off_52w_high: number | null;
  volume_surge: number | null;
  rsi_14: number | null;
  annualized_volatility_pct: number | null;
  max_drawdown_3mo_pct: number | null;
}

export function compute_momentum_metrics(bars: BarSeries): MomentumMetrics {
  const high_52w =
    bars.fifty_two_week_high ??
    (bars.closes.length ? Math.max(...bars.closes) : null);
  return {
    symbol: bars.symbol,
    name: bars.name,
    price: round2(bars.price) ?? bars.price,
    r_1mo_pct: round2(pct_return_over(bars.closes, 21)),
    r_3mo_pct: round2(pct_return_over(bars.closes, 63)),
    pct_off_52w_high:
      high_52w && high_52w > 0
        ? round2(((high_52w - bars.price) / high_52w) * 100)
        : null,
    volume_surge: round2(volume_surge_ratio(bars.volumes)),
    rsi_14: round2(rsi_14(bars.closes)),
    annualized_volatility_pct: round2(annualized_volatility_pct(bars.closes)),
    max_drawdown_3mo_pct: round2(max_drawdown_pct(bars.closes, 63)),
  };
}

/**
 * Rank-percentile momentum blend over a universe. Transparent weights:
 * 35% 3-month return, 30% 1-month return, 20% proximity to the 52-week
 * high, 15% volume surge. A missing metric ranks neutral (0.5) so a
 * thin series can't dominate either tail. Score is 0–100 RELATIVE TO
 * THE SCREENED UNIVERSE — it measures what's moving, not what will.
 */
export function compute_momentum_scores(
  rows: MomentumMetrics[],
): Array<MomentumMetrics & { momentum_score: number }> {
  const percentile = (values: Array<number | null>): number[] => {
    const present = values
      .map((v, i) => ({ v, i }))
      .filter((x): x is { v: number; i: number } => x.v !== null);
    const sorted = [...present].sort((a, b) => a.v - b.v);
    const ranks = new Array<number>(values.length).fill(0.5);
    const denom = Math.max(sorted.length - 1, 1);
    sorted.forEach((x, rank) => {
      ranks[x.i] = sorted.length === 1 ? 0.5 : rank / denom;
    });
    return ranks;
  };
  const p_3m = percentile(rows.map((r) => r.r_3mo_pct));
  const p_1m = percentile(rows.map((r) => r.r_1mo_pct));
  // proximity: closer to the high is better, so negate the distance.
  const p_prox = percentile(
    rows.map((r) => (r.pct_off_52w_high === null ? null : -r.pct_off_52w_high)),
  );
  const p_vol = percentile(rows.map((r) => r.volume_surge));
  return rows.map((r, i) => ({
    ...r,
    momentum_score: Math.round(
      100 *
        (0.35 * (p_3m[i] ?? 0.5) +
          0.3 * (p_1m[i] ?? 0.5) +
          0.2 * (p_prox[i] ?? 0.5) +
          0.15 * (p_vol[i] ?? 0.5)),
    ),
  }));
}

function round2(v: number | null): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  return Math.round(v * 100) / 100;
}

// ── themes config ───────────────────────────────────────────────────────────

const ThemeSchema = z.object({
  label: z.string().min(1),
  description: z.string().default(''),
  tickers: z.array(SymbolSchema).min(1),
});
const ThemesFileSchema = z.object({
  themes: z.record(z.string(), ThemeSchema),
});
export type MarketThemes = z.infer<typeof ThemesFileSchema>['themes'];

/** Read config/market-themes.yaml fresh — hand-edits are live next call. */
export async function load_market_themes(): Promise<
  { themes: MarketThemes } | { error: string }
> {
  const path = THEMES_PATH();
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch (err) {
    return { error: `themes file unreadable at ${path}: ${(err as Error).message}` };
  }
  try {
    const parsed = ThemesFileSchema.safeParse(parse_yaml(raw));
    if (!parsed.success) {
      return { error: `themes file invalid: ${parsed.error.message.slice(0, 400)}` };
    }
    return { themes: parsed.data.themes };
  } catch (err) {
    return { error: `themes file YAML parse failed: ${(err as Error).message}` };
  }
}

// ── market_quote ────────────────────────────────────────────────────────────

const QuoteInputSchema = z.object({
  symbols: z
    .array(SymbolSchema)
    .min(1)
    .max(10)
    .describe('1–10 ticker symbols, e.g. ["NVDA", "VRT"]. Case-insensitive.'),
});

const QuoteRowSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  price: z.number(),
  currency: z.string(),
  session_change_pct: z.number().nullable(),
  fifty_two_week_high: z.number().nullable(),
  fifty_two_week_low: z.number().nullable(),
  pct_off_52w_high: z.number().nullable(),
});

const QuoteOutputSchema = z.object({
  quotes: z.array(QuoteRowSchema),
  failed: z.array(
    z.object({
      symbol: z.string(),
      error: z.string(),
      candidates: z.array(z.string()).optional(),
    }),
  ),
  error: z.string().optional(),
});

type QuoteIn = z.infer<typeof QuoteInputSchema>;
type QuoteOut = z.infer<typeof QuoteOutputSchema>;

export const market_quote: Tool<QuoteIn, QuoteOut> = {
  name: 'market_quote',
  description:
    'Current price snapshot for up to 10 tickers: price, latest-session change %, 52-week range, and distance below the 52-week high. Data is delayed ~15 minutes. A symbol that fails to resolve lands in `failed` with `candidates` (similar real tickers) — retry with one of those, never guess a price.',
  risk: 'read',
  required_capabilities: ['read_market_data'],
  input_schema: QuoteInputSchema,
  output_schema: QuoteOutputSchema,

  idempotency_key(input) {
    return `market_quote:${input.symbols.map((s) => s.toUpperCase()).sort().join(',')}`;
  },

  async execute(input: QuoteIn, _ctx: ToolContext): Promise<QuoteOut> {
    const symbols = [...new Set(input.symbols.map((s) => s.toUpperCase().trim()))];
    const results = await pooled_map(symbols, 5, async (sym) => ({
      sym,
      bars: await fetch_chart(sym, '5d', '1d'),
    }));
    const quotes: z.infer<typeof QuoteRowSchema>[] = [];
    const failed: QuoteOut['failed'] = [];
    for (const { sym, bars } of results) {
      if ('error' in bars) {
        failed.push({
          symbol: sym,
          error: bars.error,
          candidates: await search_candidates(sym),
        });
        continue;
      }
      const prev =
        bars.closes.length >= 2 ? bars.closes[bars.closes.length - 2] : undefined;
      const high = bars.fifty_two_week_high;
      quotes.push({
        symbol: bars.symbol,
        name: bars.name,
        price: round2(bars.price) ?? bars.price,
        currency: bars.currency,
        session_change_pct:
          prev !== undefined && prev > 0
            ? round2(((bars.price - prev) / prev) * 100)
            : null,
        fifty_two_week_high: round2(high),
        fifty_two_week_low: round2(bars.fifty_two_week_low),
        pct_off_52w_high:
          high && high > 0 ? round2(((high - bars.price) / high) * 100) : null,
      });
    }
    return { quotes, failed };
  },
};

// ── market_history ──────────────────────────────────────────────────────────

const HistoryInputSchema = z.object({
  symbol: SymbolSchema.describe('One ticker symbol, e.g. "NVDA".'),
  range: z
    .enum(['1mo', '3mo', '6mo', '1y', '2y', '5y'])
    .default('6mo')
    .describe('Lookback window.'),
  interval: z
    .enum(['1d', '1wk', '1mo'])
    .default('1d')
    .describe('Bar size. Use "1wk"/"1mo" for the long ranges.'),
  max_points: z
    .number()
    .int()
    .min(10)
    .max(120)
    .default(40)
    .describe('Series is downsampled to at most this many points (most recent kept exact).'),
});

const HistoryOutputSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  currency: z.string(),
  range: z.string(),
  interval: z.string(),
  points: z.array(
    z.object({
      date: z.string(),
      close: z.number(),
      volume: z.number().nullable(),
    }),
  ),
  summary: z
    .object({
      start_close: z.number(),
      end_close: z.number(),
      total_return_pct: z.number(),
      high: z.number(),
      low: z.number(),
      max_drawdown_pct: z.number().nullable(),
      annualized_volatility_pct: z.number().nullable(),
    })
    .nullable(),
  error: z.string().optional(),
  candidates: z.array(z.string()).optional(),
});

type HistoryIn = z.infer<typeof HistoryInputSchema>;
type HistoryOut = z.infer<typeof HistoryOutputSchema>;

export const market_history: Tool<HistoryIn, HistoryOut> = {
  name: 'market_history',
  description:
    'Price history for one ticker — downsampled close/volume series plus a summary (total return, high/low, max drawdown, volatility) over the window. Use this to show how a position has actually behaved. On an unresolvable symbol returns `candidates` with similar real tickers.',
  risk: 'read',
  required_capabilities: ['read_market_data'],
  input_schema: HistoryInputSchema,
  output_schema: HistoryOutputSchema,

  idempotency_key(input) {
    return `market_history:${input.symbol.toUpperCase()}:${input.range}:${input.interval}:${input.max_points}`;
  },

  async execute(input: HistoryIn, _ctx: ToolContext): Promise<HistoryOut> {
    const empty = {
      symbol: input.symbol.toUpperCase(),
      name: '',
      currency: '',
      range: input.range,
      interval: input.interval,
      points: [],
      summary: null,
    };
    const bars = await fetch_chart(input.symbol, input.range, input.interval);
    if ('error' in bars) {
      return {
        ...empty,
        error: bars.error,
        candidates: await search_candidates(input.symbol),
      };
    }
    if (bars.closes.length === 0) {
      return { ...empty, name: bars.name, currency: bars.currency, error: `no bars returned for ${bars.symbol}` };
    }
    // Downsample from the end so the most recent bars survive exactly.
    const n = bars.closes.length;
    const stride = Math.max(1, Math.ceil(n / input.max_points));
    const idxs: number[] = [];
    for (let i = n - 1; i >= 0; i -= stride) idxs.push(i);
    idxs.reverse();
    const points = idxs.map((i) => ({
      date: local_iso_date(
        new Date((bars.timestamps[i] ?? 0) * 1000),
        bars.exchange_tz,
      ),
      close: round2(bars.closes[i] ?? 0) ?? 0,
      volume: bars.volumes[i] ?? null,
    }));
    const start = bars.closes[0];
    const end = bars.closes[n - 1];
    const summary =
      start !== undefined && end !== undefined && start > 0
        ? {
            start_close: round2(start) ?? start,
            end_close: round2(end) ?? end,
            total_return_pct: round2(((end - start) / start) * 100) ?? 0,
            high: round2(Math.max(...bars.closes)) ?? 0,
            low: round2(Math.min(...bars.closes)) ?? 0,
            max_drawdown_pct: round2(max_drawdown_pct(bars.closes)),
            annualized_volatility_pct:
              input.interval === '1d'
                ? round2(annualized_volatility_pct(bars.closes))
                : null,
          }
        : null;
    return {
      symbol: bars.symbol,
      name: bars.name,
      currency: bars.currency,
      range: input.range,
      interval: input.interval,
      points,
      summary,
    };
  },
};

// ── technical_snapshot ──────────────────────────────────────────────────────

const SnapshotInputSchema = z.object({
  symbol: SymbolSchema.describe('One ticker symbol, e.g. "VRT".'),
});

const SnapshotOutputSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  price: z.number().nullable(),
  currency: z.string(),
  as_of: z.string().nullable(),
  returns: z
    .object({
      r_5d_pct: z.number().nullable(),
      r_1mo_pct: z.number().nullable(),
      r_3mo_pct: z.number().nullable(),
      r_6mo_pct: z.number().nullable(),
      r_1y_pct: z.number().nullable(),
    })
    .nullable(),
  trend: z
    .object({
      sma_50: z.number().nullable(),
      sma_200: z.number().nullable(),
      price_vs_sma50_pct: z.number().nullable(),
      price_vs_sma200_pct: z.number().nullable(),
      sma50_above_sma200: z.boolean().nullable(),
    })
    .nullable(),
  rsi_14: z.number().nullable(),
  volume_surge: z.number().nullable(),
  fifty_two_week: z
    .object({
      high: z.number().nullable(),
      low: z.number().nullable(),
      pct_off_high: z.number().nullable(),
    })
    .nullable(),
  risk: z
    .object({
      annualized_volatility_pct: z.number().nullable(),
      max_drawdown_3mo_pct: z.number().nullable(),
    })
    .nullable(),
  error: z.string().optional(),
  candidates: z.array(z.string()).optional(),
});

type SnapshotIn = z.infer<typeof SnapshotInputSchema>;
type SnapshotOut = z.infer<typeof SnapshotOutputSchema>;

export const technical_snapshot: Tool<SnapshotIn, SnapshotOut> = {
  name: 'technical_snapshot',
  description:
    'Full technical read on one ticker from a year of daily bars: returns over 5d/1mo/3mo/6mo/1y, price vs the 50/200-day moving averages, RSI(14), volume surge (5d avg vs 3mo avg), 52-week-high proximity, plus the risk numbers (annualized volatility, 3-month max drawdown). Quote the risk numbers whenever you quote the momentum ones. On an unresolvable symbol returns `candidates`.',
  risk: 'read',
  required_capabilities: ['read_market_data'],
  input_schema: SnapshotInputSchema,
  output_schema: SnapshotOutputSchema,

  idempotency_key(input) {
    return `technical_snapshot:${input.symbol.toUpperCase()}`;
  },

  async execute(input: SnapshotIn, _ctx: ToolContext): Promise<SnapshotOut> {
    const empty: SnapshotOut = {
      symbol: input.symbol.toUpperCase(),
      name: '',
      price: null,
      currency: '',
      as_of: null,
      returns: null,
      trend: null,
      rsi_14: null,
      volume_surge: null,
      fifty_two_week: null,
      risk: null,
    };
    const bars = await fetch_chart(input.symbol, '1y', '1d');
    if ('error' in bars) {
      return {
        ...empty,
        error: bars.error,
        candidates: await search_candidates(input.symbol),
      };
    }
    const sma50 = sma_last(bars.closes, 50);
    const sma200 = sma_last(bars.closes, 200);
    const high = bars.fifty_two_week_high;
    return {
      symbol: bars.symbol,
      name: bars.name,
      price: round2(bars.price),
      currency: bars.currency,
      as_of: bars.as_of_ts
        ? new Date(bars.as_of_ts * 1000).toISOString()
        : null,
      returns: {
        r_5d_pct: round2(pct_return_over(bars.closes, 5)),
        r_1mo_pct: round2(pct_return_over(bars.closes, 21)),
        r_3mo_pct: round2(pct_return_over(bars.closes, 63)),
        r_6mo_pct: round2(pct_return_over(bars.closes, 126)),
        r_1y_pct: round2(pct_return_over(bars.closes, Math.min(250, bars.closes.length - 1))),
      },
      trend: {
        sma_50: round2(sma50),
        sma_200: round2(sma200),
        price_vs_sma50_pct:
          sma50 && sma50 > 0 ? round2(((bars.price - sma50) / sma50) * 100) : null,
        price_vs_sma200_pct:
          sma200 && sma200 > 0 ? round2(((bars.price - sma200) / sma200) * 100) : null,
        sma50_above_sma200: sma50 !== null && sma200 !== null ? sma50 > sma200 : null,
      },
      rsi_14: round2(rsi_14(bars.closes)),
      volume_surge: round2(volume_surge_ratio(bars.volumes)),
      fifty_two_week: {
        high: round2(high),
        low: round2(bars.fifty_two_week_low),
        pct_off_high:
          high && high > 0 ? round2(((high - bars.price) / high) * 100) : null,
      },
      risk: {
        annualized_volatility_pct: round2(annualized_volatility_pct(bars.closes)),
        max_drawdown_3mo_pct: round2(max_drawdown_pct(bars.closes, 63)),
      },
    };
  },
};

// ── market_movers ───────────────────────────────────────────────────────────

const MoversInputSchema = z.object({
  source: z
    .enum(['trending', 'day_gainers'])
    .default('trending')
    .describe(
      '"trending" = what the market is searching/chasing right now (rank order); "day_gainers" = biggest % gainers this session.',
    ),
  count: z.number().int().min(1).max(20).default(10),
});

const MoversOutputSchema = z.object({
  source: z.string(),
  movers: z.array(
    z.object({
      symbol: z.string(),
      name: z.string(),
      price: z.number(),
      session_change_pct: z.number().nullable(),
      pct_off_52w_high: z.number().nullable(),
    }),
  ),
  failed: z.array(z.object({ symbol: z.string(), error: z.string() })),
  error: z.string().optional(),
  suggestions: z.array(z.string()).optional(),
});

type MoversIn = z.infer<typeof MoversInputSchema>;
type MoversOut = z.infer<typeof MoversOutputSchema>;

export const market_movers: Tool<MoversIn, MoversOut> = {
  name: 'market_movers',
  description:
    'What is moving TODAY: trending tickers (what the market is chasing, rank order) or the session\'s biggest percentage gainers, each enriched with price, session change, and 52-week-high proximity. A day list is noise-heavy by nature — cross-check anything interesting with technical_snapshot before repeating it. On feed failure returns `suggestions` for the alternate path.',
  risk: 'read',
  required_capabilities: ['read_market_data'],
  input_schema: MoversInputSchema,
  output_schema: MoversOutputSchema,

  idempotency_key(input) {
    return `market_movers:${input.source}:${input.count}`;
  },

  async execute(input: MoversIn, _ctx: ToolContext): Promise<MoversOut> {
    const url =
      input.source === 'trending'
        ? `${YF_BASE()}/v1/finance/trending/US?count=${input.count}`
        : `${YF_BASE()}/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=${input.count}`;
    const res = await safe_fetch(url, {
      headers: { 'User-Agent': YF_USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) {
      return {
        source: input.source,
        movers: [],
        failed: [],
        error: `${input.source} feed HTTP ${res.status}`,
        suggestions: [
          input.source === 'trending'
            ? 'try source:"day_gainers", or run momentum_screen over a theme universe'
            : 'try source:"trending", or run momentum_screen over a theme universe',
        ],
      };
    }
    let symbols: string[] = [];
    try {
      const parsed = JSON.parse(res.body) as YfTrendingResponse & YfScreenerResponse;
      symbols = (parsed.finance?.result?.[0]?.quotes ?? [])
        .map((q) => q.symbol)
        .filter((s): s is string => typeof s === 'string' && SYMBOL_RE.test(s))
        .slice(0, input.count);
    } catch (err) {
      return {
        source: input.source,
        movers: [],
        failed: [],
        error: `${input.source} feed parse failed: ${(err as Error).message}`,
        suggestions: ['run momentum_screen over a theme universe instead'],
      };
    }
    const results = await pooled_map(symbols, 5, async (sym) => ({
      sym,
      bars: await fetch_chart(sym, '5d', '1d'),
    }));
    const movers: MoversOut['movers'] = [];
    const failed: MoversOut['failed'] = [];
    for (const { sym, bars } of results) {
      if ('error' in bars) {
        failed.push({ symbol: sym, error: bars.error });
        continue;
      }
      const prev =
        bars.closes.length >= 2 ? bars.closes[bars.closes.length - 2] : undefined;
      const high = bars.fifty_two_week_high;
      movers.push({
        symbol: bars.symbol,
        name: bars.name,
        price: round2(bars.price) ?? bars.price,
        session_change_pct:
          prev !== undefined && prev > 0
            ? round2(((bars.price - prev) / prev) * 100)
            : null,
        pct_off_52w_high:
          high && high > 0 ? round2(((high - bars.price) / high) * 100) : null,
      });
    }
    if (input.source === 'day_gainers') {
      movers.sort(
        (a, b) => (b.session_change_pct ?? -999) - (a.session_change_pct ?? -999),
      );
    }
    return { source: input.source, movers, failed };
  },
};

// ── momentum_screen ─────────────────────────────────────────────────────────

const ScreenInputSchema = z.object({
  theme: z
    .string()
    .max(64)
    .optional()
    .describe(
      'A theme id from config/market-themes.yaml (e.g. "ai_infrastructure", "datacenters", "power_nuclear", "vertical_farming_agtech"). Unknown theme returns `available_themes`.',
    ),
  symbols: z
    .array(SymbolSchema)
    .max(25)
    .optional()
    .describe('Explicit tickers to screen (alone or in addition to a theme).'),
  include_trending: z
    .boolean()
    .default(false)
    .describe('Also fold in the current trending-ticker feed.'),
  top_n: z.number().int().min(1).max(15).default(8),
});

const ScreenRowSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  price: z.number(),
  momentum_score: z.number(),
  r_1mo_pct: z.number().nullable(),
  r_3mo_pct: z.number().nullable(),
  pct_off_52w_high: z.number().nullable(),
  volume_surge: z.number().nullable(),
  rsi_14: z.number().nullable(),
  annualized_volatility_pct: z.number().nullable(),
  max_drawdown_3mo_pct: z.number().nullable(),
});

const ScreenOutputSchema = z.object({
  universe_size: z.number(),
  ranked: z.array(ScreenRowSchema),
  skipped: z.array(z.object({ symbol: z.string(), error: z.string() })),
  note: z.string().optional(),
  error: z.string().optional(),
  available_themes: z.array(z.string()).optional(),
});

type ScreenIn = z.infer<typeof ScreenInputSchema>;
type ScreenOut = z.infer<typeof ScreenOutputSchema>;

const UNIVERSE_CAP = 30;

export const momentum_screen: Tool<ScreenIn, ScreenOut> = {
  name: 'momentum_screen',
  description:
    'Rank a universe of tickers by price/volume momentum — a transparent blend of 3-month return (35%), 1-month return (30%), 52-week-high proximity (20%), and volume surge (15%), scored 0–100 relative to the screened universe. Universe = a theme from config/market-themes.yaml, explicit symbols, the trending feed, or any combination. Every row carries its risk numbers (volatility, drawdown, RSI) — quote them alongside the score. This measures what IS moving, not what will; momentum reverses faster than it builds. Call with no universe (or an unknown theme) to get `available_themes`.',
  risk: 'read',
  required_capabilities: ['read_market_data'],
  input_schema: ScreenInputSchema,
  output_schema: ScreenOutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.theme ?? '');
    h.update('\n');
    h.update((input.symbols ?? []).map((s) => s.toUpperCase()).sort().join(','));
    h.update('\n');
    h.update(String(input.include_trending));
    h.update('\n');
    h.update(String(input.top_n));
    return `momentum_screen:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input: ScreenIn, _ctx: ToolContext): Promise<ScreenOut> {
    const universe = new Set<string>();
    let note: string | undefined;

    if (input.theme) {
      const loaded = await load_market_themes();
      if ('error' in loaded) {
        return { universe_size: 0, ranked: [], skipped: [], error: loaded.error };
      }
      const theme = loaded.themes[input.theme.toLowerCase().trim()];
      if (!theme) {
        return {
          universe_size: 0,
          ranked: [],
          skipped: [],
          error: `unknown theme "${input.theme}"`,
          available_themes: Object.keys(loaded.themes),
        };
      }
      for (const t of theme.tickers) universe.add(t.toUpperCase());
    }
    for (const s of input.symbols ?? []) universe.add(s.toUpperCase().trim());
    if (input.include_trending) {
      const res = await safe_fetch(`${YF_BASE()}/v1/finance/trending/US?count=15`, {
        headers: { 'User-Agent': YF_USER_AGENT, Accept: 'application/json' },
      });
      if (res.ok) {
        try {
          const parsed = JSON.parse(res.body) as YfTrendingResponse;
          for (const q of parsed.finance?.result?.[0]?.quotes ?? []) {
            if (typeof q.symbol === 'string' && SYMBOL_RE.test(q.symbol)) {
              universe.add(q.symbol.toUpperCase());
            }
          }
        } catch {
          note = 'trending feed unparseable — screened without it';
        }
      } else {
        note = `trending feed HTTP ${res.status} — screened without it`;
      }
    }

    if (universe.size === 0) {
      const loaded = await load_market_themes();
      return {
        universe_size: 0,
        ranked: [],
        skipped: [],
        error:
          'no universe given — pass a `theme`, explicit `symbols`, and/or `include_trending: true`',
        available_themes: 'error' in loaded ? [] : Object.keys(loaded.themes),
      };
    }

    let symbols = [...universe];
    if (symbols.length > UNIVERSE_CAP) {
      symbols = symbols.slice(0, UNIVERSE_CAP);
      note = [note, `universe truncated to ${UNIVERSE_CAP} symbols`]
        .filter(Boolean)
        .join('; ');
    }

    const results = await pooled_map(symbols, 5, async (sym) => ({
      sym,
      bars: await fetch_chart(sym, '1y', '1d'),
    }));
    const metrics: MomentumMetrics[] = [];
    const skipped: ScreenOut['skipped'] = [];
    for (const { sym, bars } of results) {
      if ('error' in bars) {
        skipped.push({ symbol: sym, error: bars.error });
        continue;
      }
      metrics.push(compute_momentum_metrics(bars));
    }
    if (metrics.length === 0) {
      return {
        universe_size: symbols.length,
        ranked: [],
        skipped,
        error: 'every symbol in the universe failed to fetch',
        ...(note ? { note } : {}),
      };
    }
    const ranked = compute_momentum_scores(metrics)
      .sort((a, b) => b.momentum_score - a.momentum_score)
      .slice(0, input.top_n)
      .map((r) => ({
        symbol: r.symbol,
        name: r.name,
        price: r.price,
        momentum_score: r.momentum_score,
        r_1mo_pct: r.r_1mo_pct,
        r_3mo_pct: r.r_3mo_pct,
        pct_off_52w_high: r.pct_off_52w_high,
        volume_surge: r.volume_surge,
        rsi_14: r.rsi_14,
        annualized_volatility_pct: r.annualized_volatility_pct,
        max_drawdown_3mo_pct: r.max_drawdown_3mo_pct,
      }));
    return {
      universe_size: symbols.length,
      ranked,
      skipped,
      ...(note ? { note } : {}),
    };
  },
};

// ── list_market_themes ──────────────────────────────────────────────────────

const ListThemesInputSchema = z.object({});

const ListThemesOutputSchema = z.object({
  themes: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      description: z.string(),
      tickers: z.array(z.string()),
    }),
  ),
  error: z.string().optional(),
  suggestions: z.array(z.string()).optional(),
});

type ListThemesIn = z.infer<typeof ListThemesInputSchema>;
type ListThemesOut = z.infer<typeof ListThemesOutputSchema>;

export const list_market_themes: Tool<ListThemesIn, ListThemesOut> = {
  name: 'list_market_themes',
  description:
    'List the thematic ticker universes available to momentum_screen (from config/market-themes.yaml) — id, label, description, and members. Call this before screening when unsure which theme fits the question.',
  risk: 'read',
  required_capabilities: ['read_market_data'],
  input_schema: ListThemesInputSchema,
  output_schema: ListThemesOutputSchema,

  idempotency_key() {
    return 'list_market_themes';
  },

  async execute(_input: ListThemesIn, _ctx: ToolContext): Promise<ListThemesOut> {
    const loaded = await load_market_themes();
    if ('error' in loaded) {
      return {
        themes: [],
        error: loaded.error,
        suggestions: [
          'pass explicit `symbols` to momentum_screen until the themes file is restored',
        ],
      };
    }
    return {
      themes: Object.entries(loaded.themes).map(([id, t]) => ({
        id,
        label: t.label,
        description: t.description,
        tickers: t.tickers.map((s) => s.toUpperCase()),
      })),
    };
  },
};

// ── factory ─────────────────────────────────────────────────────────────────

export function create(_deps: import('@core/tool_deps').ToolDeps): Tool[] {
  return [
    market_quote as Tool,
    market_history as Tool,
    technical_snapshot as Tool,
    market_movers as Tool,
    momentum_screen as Tool,
    list_market_themes as Tool,
  ];
}
