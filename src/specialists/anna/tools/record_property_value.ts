/**
 * record_property_value — append a value datapoint to the parcel's
 * longitudinal series that powers Anna's office sparkline. Multi-source:
 * the county appraised value, a Zillow Zestimate (browsed via the workstation),
 * a Redfin estimate, an actual sale, or Anna's own comp estimate.
 *
 * Anna calls this after she has a number in hand — e.g. after browse_url'ing
 * the Zillow property page (Zestimate + its tax-history table backfills
 * older county values), after estimate_market_value, or from lookup_parcel's
 * county value. Idempotent on (account, source, as-of date), so re-recording
 * the same datum updates in place rather than duplicating.
 */

import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import { getCountyAssessorStore } from '@memory/stores/assessor_county';
import { getPropertyHistoryStore, type ValueSource } from '@memory/stores/property_history';

const InputSchema = z.object({
  source: z
    .enum(['county', 'zillow_zestimate', 'redfin', 'sale', 'anna_estimate'])
    .describe('Where the figure came from. county = your county appraised; zillow_zestimate/redfin = browsed estimate; sale = an actual transaction; anna_estimate = estimate_market_value output.'),
  value: z.number().positive().describe('The value in USD.'),
  // NOTE: no `.regex()` — a tool input_schema becomes a GBNF grammar on the
  // interactive 9B, and llama.cpp's converter mistranslates a regex `pattern`
  // and SILENTLY disables the whole tool grammar. The YYYY-MM-DD shape is
  // validated in execute() and returned as a typed message.
  as_of_date: z.string().describe('The date this value is AS OF (YYYY-MM-DD) — e.g. the assessment year 06-30, the Zestimate date, or the sale date.'),
  account_no: z.string().optional().describe('your county schedule/account number. Provide this OR address.'),
  address: z.string().optional().describe('Property address. Provide this OR account_no.'),
  note: z.string().optional().describe('Provenance detail — e.g. "Zillow Zestimate, browsed 2026-06", "county tax-history table".'),
});
type Input = z.infer<typeof InputSchema>;

const PointOut = z.object({ as_of_date: z.string(), source: z.string(), value: z.number() });
const OutputSchema = z.object({
  recorded: z.boolean(),
  message: z.string(),
  account_no: z.string().nullable(),
  address: z.string().nullable(),
  series_now: z.array(PointOut).describe('The full value series for this parcel after the insert, oldest→newest.'),
});
type Output = z.infer<typeof OutputSchema>;

export const record_property_value: Tool<Input, Output> = {
  name: 'record_property_value',
  description:
    "Append one house-value datapoint to the parcel's history series that drives Anna's office sparkline. source = county | zillow_zestimate | redfin | sale | anna_estimate; pass value + as_of_date + account_no/address. Call after you have a number: e.g. after browse_url'ing the Zillow page for the Zestimate (and its tax-history table for older county values), after estimate_market_value, or from lookup_parcel's county value. Idempotent per (source, as-of date).",
  risk: 'write_internal',
  required_capabilities: ['write_vault_property'],
  weight: 'light',
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    return `record_property_value:${(input.account_no ?? input.address ?? '').toLowerCase()}:${input.source}:${input.as_of_date}`;
  },

  async execute(input, _ctx: ToolContext): Promise<Output> {
    // Date-shape check moved off the schema (a regex `pattern` silently
    // disables the 9B's tool grammar). Surface a typed recovery message.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.as_of_date)) {
      return {
        recorded: false,
        message: `as_of_date must be YYYY-MM-DD; got "${input.as_of_date}". Re-call with that format.`,
        account_no: input.account_no ?? null,
        address: input.address ?? null,
        series_now: [],
      };
    }
    const assessor = getCountyAssessorStore();
    const subject = input.account_no
      ? assessor.get_by_account(input.account_no)
      : assessor.find_by_address(input.address ?? '')[0] ?? null;
    const account_no = subject?.account_no ?? input.account_no ?? null;
    const address = subject?.situs_address ?? input.address ?? null;

    if (!account_no) {
      return {
        recorded: false,
        message: `Couldn't resolve a parcel for "${input.address ?? input.account_no}". The series is keyed by account — run lookup_parcel first, then record with the account_no.`,
        account_no: null,
        address,
        series_now: [],
      };
    }

    const store = getPropertyHistoryStore();
    store.record_value_point({
      account_no,
      address,
      as_of_date: input.as_of_date,
      source: input.source as ValueSource,
      value: input.value,
      note: input.note ?? null,
    });

    const series = store.list_value_history(account_no).map((p) => ({
      as_of_date: p.as_of_date,
      source: p.source,
      value: p.value,
    }));

    return {
      recorded: true,
      message: `Recorded ${input.source} = $${Math.round(input.value).toLocaleString()} as of ${input.as_of_date} for ${address ?? account_no}. Series now has ${series.length} point(s).`,
      account_no,
      address,
      series_now: series,
    };
  },
};
