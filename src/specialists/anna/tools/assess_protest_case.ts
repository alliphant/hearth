/**
 * assess_protest_case — the one-call protest analyzer.
 *
 * The model identifies the property (account number or address); this tool does
 * everything else from the local cache: resolves the subject, pulls comparable
 * sales, finds the subject's own recent market sale, and runs the deterministic
 * math (time-adjust → size-adjust → median → over-assessment → projected tax
 * saving), with the owner's own sale as a veto. Returns a full, presentable
 * result + a protest / borderline / no_case recommendation.
 *
 * v2.1: made self-contained. The prior version required the model to hand-
 * assemble a nested `comps` array + the subject value/sqft/mill levy by
 * transcribing earlier tool output; the 27B reliably dropped all of it and
 * called with `{}`, so the turn exhausted. The arithmetic still lives here
 * (reproducible + auditable); the model just names the parcel.
 *
 * Risk read; gated by read_property_records.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { getCountyAssessorStore } from '@memory/stores/assessor_county';

// 2025–2026 reappraisal cycle data window (appraisal date 6/30/2024).
const CYCLE_WINDOW_START = '2023-01-01';
const CYCLE_WINDOW_END = '2024-06-30';
const APPRAISAL_DATE = '2024-06-30';

const InputSchema = z
  .object({
    account_no: z.string().min(3).max(20).optional().describe('Subject account/schedule number (preferred — pass what lookup_parcel/find_comps returned).'),
    address: z.string().min(3).max(120).optional().describe('Subject street address, if the account number is unknown.'),
    monthly_trend_pct: z.number().default(0).describe('Optional market time-trend, %/month, applied from each sale date to the 6/30/2024 appraisal date. 0 = none (default).'),
    assessment_rate: z.number().positive().default(0.0675).describe('Residential assessment rate (~0.0675 current cycle; verify live).'),
    marginal_sqft_ratio: z.number().min(0).max(1).default(0.5).describe('GLA size-adjustment factor (fraction of median $/sqft for size differences; ~0.5 = diminishing returns).'),
    comp_limit: z.number().int().min(1).max(20).default(8),
  })
  .refine((v) => v.account_no || v.address, { message: 'Provide account_no or address.' });
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
  found: z.boolean(),
  message: z.string().optional(),
  subject: z
    .object({
      address: z.string(),
      account_no: z.string(),
      actual_value: z.number().nullable(),
      sqft: z.number().nullable(),
      year_built: z.number().nullable(),
      mill_levy: z.number().nullable(),
    })
    .optional(),
  comps_used: z.number().optional(),
  comps: z
    .array(z.object({ address: z.string(), sale_date: z.string(), sale_price: z.number(), sqft: z.number().nullable(), price_per_sf: z.number().nullable() }))
    .optional(),
  indicated_value: z.number().optional().describe('Size-adjusted comp median = the value the comps support.'),
  over_assessment: z.number().optional().describe('current − indicated. ≤0 means no case.'),
  over_assessment_pct: z.number().optional(),
  projected_annual_tax_saving: z.number().nullable().optional().describe('max(0, over) × assessment_rate × mill_levy/1000 (null if mill levy unknown).'),
  subject_sale_indicated: z.number().nullable().optional().describe("The subject's own recent sale, time-adjusted — strongest single data point."),
  ppsf_median: z.number().optional(),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  recommendation: z.enum(['protest', 'borderline', 'no_case']).optional(),
  notes: z.array(z.string()).optional(),
});
type Output = z.infer<typeof OutputSchema>;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function months_between(from: string, to: string): number {
  const a = new Date(`${from.slice(0, 10)}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return (b - a) / (1000 * 60 * 60 * 24 * 30.4375);
}
const round = (n: number) => Math.round(n);

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'assess_protest_case',
    description:
      "Run the full Colorado protest analysis for ONE property in a single call — pass just account_no (preferred) or address. It pulls the subject, comparable sales, and the owner's own recent sale from the cache, then time-adjusts + SIZE-adjusts the comps, takes the median for the indicated value, applies the owner's own sale as a veto (a sale at/above the county value → no_case), and returns over-assessment, projected tax saving, and a protest/borderline/no_case recommendation. You do NOT assemble comps yourself.",
    risk: 'read',
    required_capabilities: ['read_property_records'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    llm_budget: 'full',

    idempotency_key(input) {
      return `assess_protest_case:${(input.account_no ?? input.address ?? '').trim().toLowerCase()}:${input.monthly_trend_pct}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const store = getCountyAssessorStore();
      const subject = input.account_no
        ? store.get_by_account(input.account_no)
        : store.find_by_address(input.address ?? '')[0] ?? null;

      if (!subject) {
        return { found: false, message: `Couldn't resolve the subject parcel (${input.account_no ?? input.address}). Run lookup_parcel to confirm the address/account, or check the cache is synced.` };
      }

      const subj_summary = {
        address: subject.situs_address,
        account_no: subject.account_no,
        actual_value: subject.actual_value_total,
        sqft: subject.improvement?.sf ?? null,
        year_built: subject.improvement?.year_built ?? null,
        mill_levy: subject.total_mill_levy,
      };

      const subject_actual_value = subject.actual_value_total;
      const subject_sqft = subject.improvement?.sf ?? null;
      if (!subject_actual_value || !subject_sqft) {
        return {
          found: true,
          subject: subj_summary,
          message:
            `Can't run the $/sqft case for ${subject.situs_address}: the county record is missing ${!subject_actual_value ? 'an actual value' : 'living-area sqft'} (common for vacant land or some condos). For land, comp per-acre from recent land sales instead.`,
        };
      }

      // Gather comps from the cache (subdivision-matched, arms-length, in-window,
      // outlier-filtered, size-joined) — the model doesn't assemble these.
      const raw = store.find_comps({
        subject,
        window_start: CYCLE_WINDOW_START,
        window_end: CYCLE_WINDOW_END,
        limit: input.comp_limit,
      });
      const comps = raw.filter((c) => c.sf && c.price_per_sf && c.sf > 0);
      const comps_out = comps.map((c) => ({
        address: c.situs_address,
        sale_date: c.sale_date,
        sale_price: c.sale_price,
        sqft: c.sf,
        price_per_sf: c.price_per_sf,
      }));

      // The subject's own recent market-deed sale (strongest single data point).
      const own = subject.recent_sales.find((s) => s.sale_price > 1000 && /warranty/i.test(s.deed_description));

      const notes: string[] = [];
      const factor = 1 + input.monthly_trend_pct / 100;
      const adj = (price: number, date: string) =>
        input.monthly_trend_pct === 0 ? price : price * Math.pow(factor, months_between(date, APPRAISAL_DATE));

      let subject_sale_indicated: number | null = null;
      let sale_contradicts = false;
      if (own) {
        subject_sale_indicated = round(adj(own.sale_price, own.sale_date));
        if (subject_sale_indicated >= subject_actual_value) {
          sale_contradicts = true;
          notes.push(`The subject's OWN sale (${own.sale_date}, ${own.deed_description}, time-adjusted to $${subject_sale_indicated.toLocaleString()}) is at or above the county value — the strongest evidence there is, and it says the assessment is fair-to-low. Don't protest on comps alone against the property's own sale.`);
        } else {
          notes.push(`The subject's own sale time-adjusts to $${subject_sale_indicated.toLocaleString()}, below the county value — consistent with a case.`);
        }
      }

      if (comps.length === 0) {
        notes.push('No usable in-window, in-subdivision comparable sales with sqft were found.');
        // With no comps, the only signal is the owner's own sale (if any).
        const rec: Output['recommendation'] = sale_contradicts ? 'no_case' : 'borderline';
        return {
          found: true,
          subject: subj_summary,
          comps_used: 0,
          comps: [],
          subject_sale_indicated,
          recommendation: own ? rec : undefined,
          confidence: 'low',
          notes: own ? notes : [...notes, 'No comps and no recent owner sale — not enough to assess from the cache; gather sales manually or widen the window.'],
        };
      }

      // Raw time-adjusted $/sqft (for the marginal rate + reporting).
      const ppsf = comps.map((c) => adj(c.sale_price, c.sale_date) / c.sf!);
      const ppsf_median = median(ppsf);
      const ppsf_min = Math.min(...ppsf);
      const ppsf_max = Math.max(...ppsf);

      // Size (GLA) adjustment at a marginal rate so differently-sized comps
      // don't distort a pure $/sqft × area.
      const marginal_psf = input.marginal_sqft_ratio * ppsf_median;
      const size_adj_values = comps.map((c) => adj(c.sale_price, c.sale_date) + (subject_sqft - c.sf!) * marginal_psf);
      const indicated_value = round(median(size_adj_values));
      const over = subject_actual_value - indicated_value;
      const over_pct = (over / subject_actual_value) * 100;
      const mill = subject.total_mill_levy;
      const saving = mill ? Math.max(0, over) * input.assessment_rate * (mill / 1000) : null;
      if (!mill) notes.push('Mill levy missing on the parcel record — projected tax saving not computed.');
      if (input.monthly_trend_pct === 0) notes.push('No time-trend applied (comps at raw sale price). In a rising market a positive trend raises comp values and weakens the case.');

      const spread = ppsf_max > 0 ? (ppsf_max - ppsf_min) / ppsf_median : 1;
      let confidence: NonNullable<Output['confidence']> = 'low';
      if (comps.length >= 5 && spread < 0.35) confidence = 'high';
      else if (comps.length >= 3 && spread < 0.6) confidence = 'medium';
      if (comps.length < 3) notes.push('Fewer than 3 comps — directional, not decisive.');
      if (spread >= 0.6) notes.push('Wide $/sqft spread — tighten to closer matches before relying on the median.');

      let recommendation: NonNullable<Output['recommendation']> = 'no_case';
      if (over_pct >= 7) recommendation = 'protest';
      else if (over_pct >= 3) recommendation = 'borderline';
      if (sale_contradicts) {
        recommendation = 'no_case';
        confidence = 'high';
      } else if (recommendation === 'no_case') {
        notes.push('Indicated value is at or above the county figure — the assessment looks defensible; a weak protest can invite a closer look.');
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'anna',
        tool_name: 'assess_protest_case',
        tool_input: { account_no: subject.account_no, comps: comps.length, monthly_trend_pct: input.monthly_trend_pct },
        execution_result: { indicated_value, over_assessment: round(over), recommendation },
      });

      return {
        found: true,
        subject: subj_summary,
        comps_used: comps.length,
        comps: comps_out,
        indicated_value,
        over_assessment: round(over),
        over_assessment_pct: Math.round(over_pct * 10) / 10,
        projected_annual_tax_saving: saving === null ? null : round(saving),
        subject_sale_indicated,
        ppsf_median: Math.round(ppsf_median * 100) / 100,
        confidence,
        recommendation,
        notes,
      };
    },
  };
}
