/**
 * lookup_parcel — resolve a your county County parcel from the local assessor
 * cache by street address or account/schedule number, returning the subject's
 * actual value, characteristics, mill levy, and recent sales.
 *
 * Crucially it also returns `verify_these` — the county-recorded characteristics
 * the owner should confirm (sqft, beds/baths, finished-basement SF, year built,
 * condition/quality). A record error here is the fastest, surest protest win in
 * Colorado, so Anna leads with it.
 *
 * Reads the cache populated by sync_county_assessor_data; if the cache is
 * empty it says so and points at the sync rather than inventing data.
 * Risk read; gated by read_property_records.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { getCountyAssessorStore } from '@memory/stores/assessor_county';

const InputSchema = z
  .object({
    address: z.string().min(3).max(120).optional().describe('Street address, e.g. "123 W Mountain Ave". City/zip optional.'),
    account_no: z.string().min(3).max(20).optional().describe('Assessor account number (R-number) or schedule number, if known.'),
  })
  .refine((v) => v.address || v.account_no, { message: 'Provide address or account_no.' });
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
  found: z.boolean(),
  cache_empty: z.boolean(),
  message: z.string().optional(),
  matches: z.number().optional().describe('When an address matched several parcels, how many.'),
  parcel: z
    .object({
      schedule_num: z.string(),
      account_no: z.string(),
      situs_address: z.string(),
      situs_city: z.string(),
      subdivision_name: z.string(),
      acct_type: z.string(),
      owner_name: z.string().nullable(),
      owner_occupied: z.boolean().nullable().describe('Heuristic: mailing address matches the situs → likely owner-occupied (homestead/senior-exemption eligible).'),
      tax_year: z.number().nullable(),
      total_mill_levy: z.number().nullable(),
      actual_value_total: z.number().nullable(),
      actual_value_land: z.number().nullable(),
      actual_value_improvement: z.number().nullable(),
      land_gross_acres: z.number().nullable(),
      sqft: z.number().nullable(),
      finished_basement_sf: z.number().nullable(),
      garage_sf: z.number().nullable(),
      bedrooms: z.number().nullable(),
      baths: z.number().nullable(),
      year_built: z.number().nullable(),
      quality: z.string(),
      condition: z.string(),
      recent_sales: z.array(z.object({ date: z.string(), price: z.number(), deed: z.string() })),
    })
    .optional(),
  verify_these: z.array(z.string()).optional().describe('County-recorded characteristics the owner should confirm — a record error is the easiest protest win.'),
});
type Output = z.infer<typeof OutputSchema>;

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'lookup_parcel',
    description:
      "Look up a your county County property in the local assessor cache by address or account number. Returns its current actual value, the county-recorded characteristics (sqft, beds/baths, finished basement, year built, quality/condition), mill levy, and recent sales — plus `verify_these`, the characteristics the owner should confirm (a wrong record is the fastest protest win). Call this first on any parcel.",
    risk: 'read',
    required_capabilities: ['read_property_records'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    llm_budget: 'full',

    idempotency_key(input) {
      return `lookup_parcel:${(input.account_no ?? input.address ?? '').trim().toLowerCase()}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const store = getCountyAssessorStore();
      const status = store.sync_status();
      const cache_empty = status.length === 0 || status.every((s) => s.row_count === 0);
      if (cache_empty) {
        return {
          found: false,
          cache_empty: true,
          message:
            'The your county assessor cache is empty — it needs sync_county_assessor_data to run (background job) before parcels can be looked up. Until then, work from what the owner shares (his Notice of Valuation) and the open web.',
        };
      }

      let parcel = input.account_no ? store.get_by_account(input.account_no) : null;
      let matches = 1;
      if (!parcel && input.address) {
        const found = store.find_by_address(input.address);
        matches = found.length;
        parcel = found[0] ?? null;
      }
      if (!parcel) {
        return {
          found: false,
          cache_empty: false,
          message: `No your county parcel matched ${input.account_no ?? input.address}. Check the spelling, or ask the owner for the account number off his Notice of Valuation.`,
        };
      }

      const imp = parcel.improvement;
      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'anna',
        tool_name: 'lookup_parcel',
        tool_input: { address: input.address, account_no: input.account_no },
        execution_result: { schedule_num: parcel.schedule_num },
      });

      const verify: string[] = [];
      if (imp?.sf) verify.push(`Living area: ${imp.sf} sqft`);
      if (imp?.bsmnt_fin_sf != null) verify.push(`Finished basement: ${imp.bsmnt_fin_sf} sqft`);
      if (imp?.bedroom_count != null) verify.push(`Bedrooms: ${imp.bedroom_count}`);
      if (imp?.bath_count != null) verify.push(`Baths: ${imp.bath_count}`);
      if (imp?.year_built) verify.push(`Year built: ${imp.year_built}`);
      if (imp?.quality) verify.push(`Quality grade: ${imp.quality}`);
      if (imp?.condition) verify.push(`Condition: ${imp.condition}`);
      if (parcel.owner_occupied) {
        verify.push('Appears owner-occupied (mailing = situs) — confirm the homestead exemption is filed, and the senior/disabled-vet exemption if eligible.');
      }

      return {
        found: true,
        cache_empty: false,
        matches,
        parcel: {
          schedule_num: parcel.schedule_num,
          account_no: parcel.account_no,
          situs_address: parcel.situs_address,
          situs_city: parcel.situs_city,
          subdivision_name: parcel.subdivision_name,
          acct_type: parcel.acct_type,
          owner_name: parcel.owner_name,
          owner_occupied: parcel.owner_occupied,
          tax_year: parcel.tax_year,
          total_mill_levy: parcel.total_mill_levy,
          actual_value_total: parcel.actual_value_total,
          actual_value_land: parcel.actual_value_land,
          actual_value_improvement: parcel.actual_value_improvement,
          land_gross_acres: parcel.land_gross_acres,
          sqft: imp?.sf ?? null,
          finished_basement_sf: imp?.bsmnt_fin_sf ?? null,
          garage_sf: imp?.gar_sf ?? null,
          bedrooms: imp?.bedroom_count ?? null,
          baths: imp?.bath_count ?? null,
          year_built: imp?.year_built ?? null,
          quality: imp?.quality ?? '',
          condition: imp?.condition ?? '',
          recent_sales: parcel.recent_sales.map((s) => ({
            date: s.sale_date,
            price: s.sale_price,
            deed: s.deed_description,
          })),
        },
        verify_these: verify,
      };
    },
  };
}
