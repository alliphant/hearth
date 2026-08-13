/**
 * fred_macro — Federal Reserve Economic Data API for Vivian (2026-05-30).
 *
 * Free, official, authoritative for macroeconomic time series. The
 * household's go-to for "what's the 10-year yield today" / "where's
 * core CPI tracking" / "what's the dollar index doing this quarter."
 *
 * Needs `FRED_API_KEY` env var — sign up free at
 * https://fred.stlouisfed.org/docs/api/api_key.html. Without it, both
 * tools return a "not configured" error pointing at the signup link.
 *
 * Two tools:
 *   - fred_series — metadata lookup for a series id (DGS10, CPIAUCSL,
 *     UNRATE, DFF, etc.). Returns title, units, frequency, last
 *     observation, last update.
 *   - fred_observations — recent observations of a series with a
 *     configurable window (default 12 most recent).
 *
 * Both `read` risk, gated by `read_finance_signals`.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import { safe_fetch } from './_audit';

const FRED_BASE = 'https://api.stlouisfed.org/fred';
function api_key(): string | null {
  const k = process.env.FRED_API_KEY?.trim();
  return k && k.length > 0 ? k : null;
}

const NOT_CONFIGURED =
  'FRED_API_KEY not set. Sign up free at https://fred.stlouisfed.org/docs/api/api_key.html and add FRED_API_KEY=<token> to /docker/hearth/hearth.env.';

// ── fred_series ─────────────────────────────────────────────────────────────

const SeriesInputSchema = z.object({
  series_id: z.string().min(1).max(64).describe(
    'A FRED series identifier. Common ones: DGS10 (10-year Treasury yield), DGS2 (2-year), DFF (effective fed funds rate), CPIAUCSL (CPI), CPILFESL (core CPI), UNRATE (unemployment), DCOILWTICO (WTI crude), DTWEXBGS (dollar index trade-weighted), SP500 (S&P 500 closing). Catalog at https://fred.stlouisfed.org/.',
  ),
});

const SeriesOutputSchema = z.object({
  series_id: z.string(),
  title: z.string().nullable(),
  units: z.string().nullable(),
  units_short: z.string().nullable(),
  frequency: z.string().nullable(),
  seasonal_adjustment: z.string().nullable(),
  last_updated: z.string().nullable(),
  observation_start: z.string().nullable(),
  observation_end: z.string().nullable(),
  notes: z.string().nullable(),
  error: z.string().optional(),
});

type SeriesIn = z.infer<typeof SeriesInputSchema>;
type SeriesOut = z.infer<typeof SeriesOutputSchema>;

interface FredSeriesResponse {
  seriess?: Array<{
    id?: string;
    title?: string;
    units?: string;
    units_short?: string;
    frequency?: string;
    seasonal_adjustment?: string;
    last_updated?: string;
    observation_start?: string;
    observation_end?: string;
    notes?: string;
  }>;
}

const EMPTY_SERIES: Omit<SeriesOut, 'series_id'> = {
  title: null,
  units: null,
  units_short: null,
  frequency: null,
  seasonal_adjustment: null,
  last_updated: null,
  observation_start: null,
  observation_end: null,
  notes: null,
};

export const fred_series: Tool<SeriesIn, SeriesOut> = {
  name: 'fred_series',
  description:
    "Look up metadata for a Federal Reserve Economic Data series — title, units, frequency, last update, observation window. Use this to confirm a series id is what you think it is BEFORE fetching observations. Catalog: https://fred.stlouisfed.org/.",
  risk: 'read',
  required_capabilities: ['read_finance_signals'],
  input_schema: SeriesInputSchema,
  output_schema: SeriesOutputSchema,

  idempotency_key(input) {
    return `fred_series:${input.series_id.toUpperCase()}`;
  },

  async execute(input: SeriesIn, _ctx: ToolContext): Promise<SeriesOut> {
    const key = api_key();
    if (!key) {
      return { series_id: input.series_id, ...EMPTY_SERIES, error: NOT_CONFIGURED };
    }
    const url = `${FRED_BASE}/series?series_id=${encodeURIComponent(input.series_id)}&api_key=${key}&file_type=json`;
    const res = await safe_fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      return {
        series_id: input.series_id,
        ...EMPTY_SERIES,
        error: `FRED HTTP ${res.status}: ${res.body.slice(0, 200)}`,
      };
    }
    try {
      const json = JSON.parse(res.body) as FredSeriesResponse;
      const s = json.seriess?.[0];
      if (!s) {
        return {
          series_id: input.series_id,
          ...EMPTY_SERIES,
          error: `FRED returned no series for "${input.series_id}"`,
        };
      }
      return {
        series_id: s.id ?? input.series_id,
        title: s.title ?? null,
        units: s.units ?? null,
        units_short: s.units_short ?? null,
        frequency: s.frequency ?? null,
        seasonal_adjustment: s.seasonal_adjustment ?? null,
        last_updated: s.last_updated ?? null,
        observation_start: s.observation_start ?? null,
        observation_end: s.observation_end ?? null,
        notes: s.notes ?? null,
      };
    } catch (err) {
      return {
        series_id: input.series_id,
        ...EMPTY_SERIES,
        error: `FRED parse failed: ${(err as Error).message}`,
      };
    }
  },
};

// ── fred_observations ───────────────────────────────────────────────────────

const ObservationsInputSchema = z.object({
  series_id: z.string().min(1).max(64),
  limit: z.number().int().min(1).max(200).default(12).describe(
    "Number of most-recent observations to return. Default 12 — for monthly series that's a year; for daily series that's about two weeks. Bump up for longer trend windows.",
  ),
});

const ObservationSchema = z.object({
  date: z.string(),
  value: z.union([z.number(), z.null()]).describe(
    "Numeric observation value, or null when FRED's source marked the period as missing (the API returns '.' which we coerce to null).",
  ),
});

const ObservationsOutputSchema = z.object({
  series_id: z.string(),
  observations: z.array(ObservationSchema),
  count: z.number(),
  error: z.string().optional(),
});

type ObservationsIn = z.infer<typeof ObservationsInputSchema>;
type ObservationsOut = z.infer<typeof ObservationsOutputSchema>;

interface FredObservationsResponse {
  observations?: Array<{ date?: string; value?: string }>;
}

export const fred_observations: Tool<ObservationsIn, ObservationsOut> = {
  name: 'fred_observations',
  description:
    "Fetch recent observations for a FRED series. Returns ordered most-recent-first by default. Pair with fred_series first to verify what units/frequency you're getting back. Common patterns: 'what's the 10-year yield doing this month' (DGS10, limit=20), 'where's core CPI tracking' (CPILFESL, limit=12 for a year of monthly).",
  risk: 'read',
  required_capabilities: ['read_finance_signals'],
  input_schema: ObservationsInputSchema,
  output_schema: ObservationsOutputSchema,

  idempotency_key(input) {
    return `fred_obs:${input.series_id.toUpperCase()}:${input.limit}`;
  },

  async execute(input: ObservationsIn, _ctx: ToolContext): Promise<ObservationsOut> {
    const key = api_key();
    if (!key) {
      return {
        series_id: input.series_id,
        observations: [],
        count: 0,
        error: NOT_CONFIGURED,
      };
    }
    const url =
      `${FRED_BASE}/series/observations?series_id=${encodeURIComponent(input.series_id)}` +
      `&api_key=${key}&file_type=json&sort_order=desc&limit=${input.limit}`;
    const res = await safe_fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      return {
        series_id: input.series_id,
        observations: [],
        count: 0,
        error: `FRED HTTP ${res.status}: ${res.body.slice(0, 200)}`,
      };
    }
    try {
      const json = JSON.parse(res.body) as FredObservationsResponse;
      const obs = (json.observations ?? []).map((o) => {
        const v = o.value;
        const num = v && v !== '.' ? Number(v) : null;
        return {
          date: o.date ?? '',
          value: Number.isFinite(num as number) ? (num as number) : null,
        };
      });
      return {
        series_id: input.series_id,
        observations: obs,
        count: obs.length,
      };
    } catch (err) {
      return {
        series_id: input.series_id,
        observations: [],
        count: 0,
        error: `FRED parse failed: ${(err as Error).message}`,
      };
    }
  },
};

export function create(_deps: import('@core/tool_deps').ToolDeps): Tool[] {
  return [fred_series as Tool, fred_observations as Tool];
}
