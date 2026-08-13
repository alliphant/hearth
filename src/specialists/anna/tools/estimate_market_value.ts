/**
 * estimate_market_value — Anna's home-value-advocate tool. Distinct from
 * assess_protest_case (which targets the 6/30/2024 appraisal date for a tax
 * protest): this estimates what the home would sell for TODAY and positions it
 * against its neighborhood on the bones the assessor records (sqft, beds/baths,
 * quality grade, condition, finished basement, age), surfacing where the home
 * trails the block as improvement levers.
 *
 * One-call, self-contained: pass account_no (preferred) or address. Uses recent
 * arms-length SOLD comps (last ~24 months), size-adjusted.
 *
 * IMPORTANT data boundary: the assessor roll has NO solar / renovated-finish /
 * active-listing data. Those (and improvement ROI) are Anna's WEB research job;
 * this tool gives the quantitative backbone (value + characteristic gaps).
 *
 * Risk read; gated by read_property_records.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { getCountyAssessorStore } from '@memory/stores/assessor_county';

const InputSchema = z
  .object({
    account_no: z.string().min(3).max(20).optional().describe('Subject account/schedule number (preferred).'),
    address: z.string().min(3).max(120).optional().describe('Subject street address, if the account is unknown.'),
    lookback_months: z.number().int().min(6).max(60).default(24).describe('How far back to pull sold comps. 24 = last two years.'),
    annual_appreciation_pct: z.number().default(0).describe('Optional %/yr to carry comps forward to today from their sale dates. 0 = report as-of the comps (state it); supply a local figure for a current-dollar estimate.'),
    marginal_sqft_ratio: z.number().min(0).max(1).default(0.5).describe('GLA size-adjustment factor (fraction of median $/sqft for size differences).'),
    comp_limit: z.number().int().min(1).max(20).default(10),
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
      assessed_value: z.number().nullable(),
      sqft: z.number().nullable(),
      year_built: z.number().nullable(),
      quality: z.string(),
      condition: z.string(),
      finished_basement_sf: z.number().nullable(),
      bedrooms: z.number().nullable(),
      baths: z.number().nullable(),
    })
    .optional(),
  estimated_market_value: z.number().optional(),
  value_range: z.object({ low: z.number(), high: z.number() }).optional(),
  as_of: z.string().optional().describe('Date basis of the estimate (median comp date, unless appreciation carried it to today).'),
  vs_assessed: z.object({ delta: z.number(), pct: z.number() }).optional().describe('market − assessed; positive means the market thinks it is worth more than the county does.'),
  comps_used: z.number().optional(),
  neighborhood: z
    .object({
      median_sqft: z.number().nullable(),
      median_year_built: z.number().nullable(),
      median_price_per_sf: z.number().nullable(),
      finished_basement_share: z.number().describe('Fraction of comps with a finished basement (0–1).'),
      typical_quality: z.string(),
    })
    .optional(),
  improvement_levers: z.array(z.string()).optional().describe('Where the subject trails the block — candidate value-adders. Pair with web-researched ROI (Cost-vs-Value, NREL solar, etc.).'),
  notes: z.array(z.string()).optional(),
});
type Output = z.infer<typeof OutputSchema>;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const round = (n: number) => Math.round(n);
const usd = (n: number) => `$${round(n).toLocaleString('en-US')}`;
function months_between(from: string, to: Date): number {
  const a = new Date(`${from.slice(0, 10)}T00:00:00Z`).getTime();
  return (to.getTime() - a) / (1000 * 60 * 60 * 24 * 30.4375);
}
const QUALITY_RANK: Record<string, number> = {
  low: 1, minimum: 1, fair: 2, average: 3, 'above average': 4,
  good: 5, 'very good': 6, excellent: 7, exceptional: 8, luxury: 8,
};
function quality_rank(q: string): number | null {
  let k = (q || '').trim().toLowerCase();
  let bump = 0;
  if (k.endsWith(' plus')) { bump = 0.5; k = k.slice(0, -5).trim(); }
  else if (k.endsWith(' minus')) { bump = -0.5; k = k.slice(0, -6).trim(); }
  const base = QUALITY_RANK[k];
  return base != null ? base + bump : null;
}
function mode_str(xs: string[]): string {
  const counts = new Map<string, number>();
  for (const x of xs) if (x) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best = '', n = 0;
  for (const [k, c] of counts) if (c > n) { best = k; n = c; }
  return best;
}

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'estimate_market_value',
    description:
      "Estimate what a your county home would SELL for today and position it against its neighborhood — pass just account_no or address. Uses recent (default 24mo) arms-length sold comps, size-adjusted, for a market value + range; compares the subject's sqft / quality / condition / finished-basement / age to the block; and flags where it trails as improvement levers. This is the value-ADVOCATE counterpart to assess_protest_case. NOTE: the assessor roll has no solar / renovated-finish / active-listing data — research those and improvement ROI on the web; this gives the quantitative backbone.",
    risk: 'read',
    required_capabilities: ['read_property_records'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    llm_budget: 'full',

    idempotency_key(input) {
      return `estimate_market_value:${(input.account_no ?? input.address ?? '').trim().toLowerCase()}:${input.lookback_months}:${input.annual_appreciation_pct}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const store = getCountyAssessorStore();
      const subject = input.account_no
        ? store.get_by_account(input.account_no)
        : store.find_by_address(input.address ?? '')[0] ?? null;
      if (!subject) {
        return { found: false, message: `Couldn't resolve the parcel (${input.account_no ?? input.address}). Run lookup_parcel first.` };
      }

      const imp = subject.improvement;
      const subj_summary = {
        address: subject.situs_address,
        account_no: subject.account_no,
        assessed_value: subject.actual_value_total,
        sqft: imp?.sf ?? null,
        year_built: imp?.year_built ?? null,
        quality: imp?.quality ?? '',
        condition: imp?.condition ?? '',
        finished_basement_sf: imp?.bsmnt_fin_sf ?? null,
        bedrooms: imp?.bedroom_count ?? null,
        baths: imp?.bath_count ?? null,
      };
      const subject_sqft = imp?.sf ?? null;
      if (!subject_sqft) {
        return { found: true, subject: subj_summary, message: `No living-area sqft on record for ${subject.situs_address} (vacant land or a record gap) — can't run a $/sqft market estimate. For land, comp recent per-acre land sales instead.` };
      }

      // Recent window ending "now".
      const now = ctx.now ?? new Date();
      const start = new Date(now.getTime() - input.lookback_months * 30.4375 * 24 * 60 * 60 * 1000);
      const window_start = start.toISOString().slice(0, 10); // time-guard-ok: UTC day bound for a comp-window DB query (not user-facing)
      const window_end = now.toISOString().slice(0, 10); // time-guard-ok: UTC day bound for a comp-window DB query (not user-facing)
      const raw = store.find_comps({ subject, window_start, window_end, limit: input.comp_limit });
      const comps = raw.filter((c) => c.sf && c.price_per_sf && c.sf > 0);
      if (comps.length === 0) {
        return { found: true, subject: subj_summary, comps_used: 0, message: `No recent (${input.lookback_months}mo) in-subdivision sold comps with sqft for ${subject.situs_address}. Widen lookback_months, or research active/sold listings on the web.` };
      }

      const notes: string[] = [];
      const appr = 1 + input.annual_appreciation_pct / 100;
      const carry = (price: number, date: string) =>
        input.annual_appreciation_pct === 0 ? price : price * Math.pow(appr, months_between(date, now) / 12);

      // Size-adjusted, appreciation-carried value.
      const ppsf = comps.map((c) => carry(c.sale_price, c.sale_date) / c.sf!);
      const ppsf_median = median(ppsf);
      const marginal_psf = input.marginal_sqft_ratio * ppsf_median;
      const vals = comps.map((c) => carry(c.sale_price, c.sale_date) + (subject_sqft - c.sf!) * marginal_psf);
      const est = round(median(vals));
      // Range from the SAME size-adjusted values so it brackets the estimate
      // (raw $/sqft × sqft would sit above it when comps are smaller).
      const low = round(Math.min(...vals));
      const high = round(Math.max(...vals));

      // As-of basis.
      const med_date = comps.map((c) => c.sale_date).sort()[Math.floor(comps.length / 2)] ?? window_end;
      const as_of = input.annual_appreciation_pct === 0 ? `~${med_date} (median comp date)` : window_end;
      if (input.annual_appreciation_pct === 0) notes.push('No appreciation applied — estimate is as-of the comps\' median sale date. Supply annual_appreciation_pct (or research the current local trend) for a today-dollar figure.');

      // Neighborhood positioning.
      const sqfts = comps.map((c) => c.sf!).filter(Boolean);
      const years = comps.map((c) => c.year_built).filter((x): x is number => !!x);
      const fin_share = comps.filter((c) => (c.finished_basement_sf ?? 0) > 0).length / comps.length;
      const typ_quality = mode_str(comps.map((c) => c.quality));
      const neighborhood = {
        median_sqft: sqfts.length ? round(median(sqfts)) : null,
        median_year_built: years.length ? round(median(years)) : null,
        median_price_per_sf: Math.round(ppsf_median * 100) / 100,
        finished_basement_share: Math.round(fin_share * 100) / 100,
        typical_quality: typ_quality,
      };

      // Improvement levers — where the subject trails the block.
      const levers: string[] = [];
      const subj_fin = (imp?.bsmnt_fin_sf ?? 0) > 0;
      if (!subj_fin && fin_share >= 0.5) {
        levers.push(`Most comps (${Math.round(fin_share * 100)}%) have a finished basement; yours is recorded unfinished — finishing it is typically a strong $/sqft add. (Research current finish-out ROI.)`);
      }
      const subjQ = quality_rank(imp?.quality ?? '');
      const neighQ = quality_rank(typ_quality);
      if (subjQ != null && neighQ != null && subjQ < neighQ) {
        levers.push(`Quality grade "${imp?.quality}" is below the block norm "${typ_quality}" — kitchen/bath/finish upgrades move this grade and the value with it.`);
      }
      const cond = (imp?.condition ?? '').toLowerCase();
      if (/fair|poor|low/.test(cond)) {
        levers.push(`Condition is recorded "${imp?.condition}" — deferred-maintenance fixes (roof, HVAC, paint, systems) lift both the grade and buyer confidence.`);
      }
      levers.push('Items the assessor roll can\'t see — solar, renovated kitchen/baths, new windows, curb appeal — are real market movers; compare against current Zillow/Redfin listings in the subdivision and weigh each against published ROI (Cost-vs-Value).');

      const delta = subject.actual_value_total != null ? est - subject.actual_value_total : 0;
      const vs_assessed = subject.actual_value_total != null
        ? { delta: round(delta), pct: Math.round((delta / subject.actual_value_total) * 1000) / 10 }
        : undefined;

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'anna',
        tool_name: 'estimate_market_value',
        tool_input: { account_no: subject.account_no, lookback_months: input.lookback_months },
        execution_result: { estimated_market_value: est, comps: comps.length },
      });

      notes.push(`Estimate from ${comps.length} size-adjusted in-subdivision sold comps (${usd(low)}–${usd(high)} range).`);

      return {
        found: true,
        subject: subj_summary,
        estimated_market_value: est,
        value_range: { low, high },
        as_of,
        vs_assessed,
        comps_used: comps.length,
        neighborhood,
        improvement_levers: levers,
        notes,
      };
    },
  };
}
