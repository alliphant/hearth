/**
 * get_energy_history — Iris-owned read of the household's actual energy
 * history from the FRIDAY energy archive (friday.db `energy_daily`,
 * populated every ~5 min by friday_energy_archive.py from Teslemetry-in-HA).
 *
 * Why Iris owns it: Iris is the Home Automation specialist with
 * `read_friday_system` + `read_home_assistant`. Other specialists who need
 * real production/usage numbers — notably Anna for solar reconciliation —
 * reach this via `consult_specialist({ specialist_id: "iris", ... })`
 * rather than growing their own HA/FRIDAY pipe.
 *
 * Source: friday-writer `/db/query` (SELECT-only, via FridayClient). The
 * `energy_daily` table:
 *   date PK, solar_kwh, grid_imported, grid_exported, home_usage,
 *   peak_solar_kw, peak_load_kw, import_cost, export_credit, net_cost.
 *
 * COVERAGE: the archive begins when Teslemetry→HA→FRIDAY archival started
 * (~Apr 2026), NOT at panel install. The tool always reports the archive's
 * real horizon so callers never imply they have history they don't — older
 * production lives only in the Tesla app.
 */

import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import { get_friday_client } from '@connectors/friday/client';

const InputSchema = z.object({
  granularity: z
    .enum(['monthly', 'daily'])
    .default('monthly')
    .describe('monthly = solar_kwh summed per calendar month (for reconciliation); daily = one row per day.'),
  months_back: z
    .number()
    .int()
    .min(1)
    .max(60)
    .default(13)
    .describe('How many months back from today to cover when start_date is omitted. Default 13 (trailing year + current month).'),
  // NOTE: no `.regex()` on the date fields — a tool input_schema becomes a GBNF
  // grammar on the interactive 9B, and llama.cpp's converter mistranslates a
  // regex `pattern` and SILENTLY disables the whole tool grammar. The
  // YYYY-MM-DD shape is validated in execute() instead.
  start_date: z
    .string()
    .optional()
    .describe('Inclusive start YYYY-MM-DD. Overrides months_back when given.'),
  end_date: z
    .string()
    .optional()
    .describe('Inclusive end YYYY-MM-DD. Defaults to today.'),
});
type Input = z.infer<typeof InputSchema>;

const MonthlyRow = z.object({
  month: z.string(),
  solar_kwh: z.number().nullable(),
  grid_imported_kwh: z.number().nullable(),
  grid_exported_kwh: z.number().nullable(),
  home_usage_kwh: z.number().nullable(),
  net_cost: z.number().nullable(),
  days_covered: z.number(),
  first_day: z.string(),
  last_day: z.string(),
});
const DailyRow = z.object({
  date: z.string(),
  solar_kwh: z.number().nullable(),
  grid_imported_kwh: z.number().nullable(),
  grid_exported_kwh: z.number().nullable(),
  home_usage_kwh: z.number().nullable(),
  peak_solar_kw: z.number().nullable(),
});

const OutputSchema = z.object({
  granularity: z.enum(['monthly', 'daily']),
  requested_start: z.string(),
  requested_end: z.string(),
  archive_starts: z.string().nullable(),
  archive_ends: z.string().nullable(),
  days_in_archive: z.number(),
  rows: z.array(z.union([MonthlyRow, DailyRow])),
  coverage_note: z.string(),
});
type Output = z.infer<typeof OutputSchema>;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10); // time-guard-ok: UTC day key for energy-archive rows (internal grouping)
}

export const get_energy_history: Tool<Input, Output> = {
  name: 'get_energy_history',
  description:
    "Read the household's ACTUAL energy history (solar production, grid import/export, home usage, cost) from the FRIDAY energy archive, sourced from Teslemetry via Home Assistant. Use 'monthly' to get solar_kwh summed per month — this is what Anna needs to reconcile solar performance. The archive only goes back to when Teslemetry archival started (~Apr 2026); the tool reports its real horizon and production before that lives only in the Tesla app.",
  risk: 'read',
  required_capabilities: ['read_friday_system'],
  weight: 'light',
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    return `get_energy_history:${input.granularity}:${input.start_date ?? `m${input.months_back}`}:${input.end_date ?? 'today'}`;
  },

  async execute(input, _ctx: ToolContext): Promise<Output> {
    // Date-shape checks moved off the schema (a regex `pattern` silently
    // disables the 9B's tool grammar). Validate here for a clean error.
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    if (input.start_date && !ymd.test(input.start_date)) {
      throw new Error(`start_date must be YYYY-MM-DD; got "${input.start_date}".`);
    }
    if (input.end_date && !ymd.test(input.end_date)) {
      throw new Error(`end_date must be YYYY-MM-DD; got "${input.end_date}".`);
    }
    const now = new Date();
    const end = input.end_date ?? isoDay(now);
    let start = input.start_date;
    if (!start) {
      const s = new Date(now);
      s.setMonth(s.getMonth() - input.months_back);
      s.setDate(1);
      start = isoDay(s);
    }

    const client = get_friday_client();

    // Archive horizon — report it honestly so callers never imply coverage
    // they don't have.
    const horizon = (await client.db_query(
      'SELECT min(date) AS f, max(date) AS l, count(*) AS n FROM energy_daily',
    )) as Array<{ f: string | null; l: string | null; n: number }>;
    const archive_starts = horizon[0]?.f ?? null;
    const archive_ends = horizon[0]?.l ?? null;
    const days_in_archive = horizon[0]?.n ?? 0;

    let rows: Output['rows'];
    if (input.granularity === 'monthly') {
      rows = (await client.db_query(
        `SELECT substr(date,1,7) AS month,
                round(sum(solar_kwh),1)     AS solar_kwh,
                round(sum(grid_imported),1) AS grid_imported_kwh,
                round(sum(grid_exported),1) AS grid_exported_kwh,
                round(sum(home_usage),1)    AS home_usage_kwh,
                round(sum(net_cost),2)      AS net_cost,
                count(*)   AS days_covered,
                min(date)  AS first_day,
                max(date)  AS last_day
         FROM energy_daily
         WHERE date >= ? AND date <= ?
         GROUP BY month ORDER BY month`,
        [start, end],
      )) as Output['rows'];
    } else {
      rows = (await client.db_query(
        `SELECT date,
                round(solar_kwh,2)     AS solar_kwh,
                round(grid_imported,2) AS grid_imported_kwh,
                round(grid_exported,2) AS grid_exported_kwh,
                round(home_usage,2)    AS home_usage_kwh,
                round(peak_solar_kw,2) AS peak_solar_kw
         FROM energy_daily
         WHERE date >= ? AND date <= ?
         ORDER BY date`,
        [start, end],
      )) as Output['rows'];
    }

    const coverage_note =
      archive_starts == null
        ? 'The FRIDAY energy archive is empty.'
        : `FRIDAY energy archive covers ${archive_starts} → ${archive_ends} (${days_in_archive} days). ` +
          `Production before ${archive_starts} is NOT in this archive — that history lives only in the Tesla app. ` +
          `Months at the edges of the requested window may be partial (see days_covered).`;

    return {
      granularity: input.granularity,
      requested_start: start,
      requested_end: end,
      archive_starts,
      archive_ends,
      days_in_archive,
      rows,
      coverage_note,
    };
  },
};
