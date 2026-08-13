/**
 * read_utility_history — Anna reads the household's utility readings (parsed
 * from uploaded bills by intake_utility_bill) to benchmark consumption, spot
 * trends/anomalies, and feed real usage into heat-pump sizing + payback.
 *
 * Reads the shared utility_readings table for the calling user. Returns the
 * recent readings plus a trailing-12-bill rollup. Risk read; gated by
 * read_property_records (Anna's energy/property data surface).
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { UtilityReadingsStore } from '@memory/stores/utility_readings';

const InputSchema = z.object({
  limit: z.number().int().min(1).max(60).default(24).describe('How many recent readings to return (newest first).'),
});
type Input = z.infer<typeof InputSchema>;

const Reading = z.object({
  provider: z.string().nullable(),
  service: z.string().nullable(),
  period_start: z.string().nullable(),
  period_end: z.string().nullable(),
  electric_kwh: z.number().nullable(),
  gas_therms: z.number().nullable(),
  water_gallons: z.number().nullable(),
  total_cost: z.number().nullable(),
});
const OutputSchema = z.object({
  count: z.number(),
  message: z.string().optional(),
  readings: z.array(Reading).optional(),
  trailing_12: z
    .object({
      bills: z.number(),
      electric_kwh: z.number().nullable(),
      gas_therms: z.number().nullable(),
      water_gallons: z.number().nullable(),
      total_cost: z.number().nullable(),
    })
    .optional()
    .describe('Sum across up to the 12 most recent readings — a rough annual picture.'),
});
type Output = z.infer<typeof OutputSchema>;

const sumOf = (xs: (number | null)[]): number | null => {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) * 100) / 100 : null;
};

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'read_utility_history',
    description:
      "Read the household's utility readings (from uploaded bills) — electric kWh, gas therms, water gallons, and costs by billing period — to benchmark consumption (2 people, 2 dogs, ~3,600 sqft + 13.86 kW solar), spot trends/anomalies (water spike = leak/irrigation; gas = heating load), and feed real usage into heat-pump sizing + payback. Returns recent readings + a trailing-12 rollup. Empty until utility bills have been uploaded.",
    risk: 'read',
    required_capabilities: ['read_property_records'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    llm_budget: 'full',

    idempotency_key(input) {
      return `read_utility_history:${input.limit}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const user_id = ctx.user?.id;
      if (!user_id) return { count: 0, message: 'No user in context — can only read utility history inside a user conversation.' };
      const store = new UtilityReadingsStore(deps.db);
      const rows = store.list_for_user(user_id, input.limit);
      if (rows.length === 0) {
        return { count: 0, message: 'No utility readings yet — upload a utility bill (Cordelia routes it here) and it will appear.' };
      }
      const recent12 = rows.slice(0, 12);
      return {
        count: rows.length,
        readings: rows.map((r) => ({
          provider: r.utility_provider,
          service: r.service,
          period_start: r.period_start,
          period_end: r.period_end,
          electric_kwh: r.electric_kwh,
          gas_therms: r.gas_therms,
          water_gallons: r.water_gallons,
          total_cost: r.total_cost,
        })),
        trailing_12: {
          bills: recent12.length,
          electric_kwh: sumOf(recent12.map((r) => r.electric_kwh)),
          gas_therms: sumOf(recent12.map((r) => r.gas_therms)),
          water_gallons: sumOf(recent12.map((r) => r.water_gallons)),
          total_cost: sumOf(recent12.map((r) => r.total_cost)),
        },
      };
    },
  };
}
