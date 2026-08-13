/**
 * reconcile_solar — is the array producing what it should?
 *
 * Computes EXPECTED production for the home's solar system and compares it to
 * ACTUAL (what the owner reads off the Tesla app, or a future Tesla-API pull),
 * returning a performance ratio, a healthy/watch/underperforming verdict,
 * month-by-month flags with likely causes, and degradation context.
 *
 * Expected production: NREL PVWatts v8 API when NREL_API_KEY is set (exact for
 * the roof's tilt/azimuth); otherwise a modeled Pleasantville monthly profile
 * scaled by system size. ACTUAL is owner-supplied for now — utility bills don't
 * show GROSS production (only grid import/export), so the Tesla app is the
 * source until a Tesla connector lands.
 *
 * Risk read; gated by read_property_records.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { safe_fetch } from '@connectors/_audit';

// Pleasantville (39.739, -104.990). Modeled monthly production in kWh per kW DC
// (south, ~30° tilt, ~14% losses) — sums ≈ 1,585 kWh/kWp/yr, typical Front
// Range. Approximate (±~10%); set NREL_API_KEY for exact PVWatts per the roof.
const FC_MONTHLY_KWH_PER_KW = [95, 110, 142, 152, 160, 165, 162, 153, 142, 122, 96, 86];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FC_LAT = 39.7392, FC_LON = -104.9903;
const FC_OPTIMAL_KWH_PER_KW = FC_MONTHLY_KWH_PER_KW.reduce((a, b) => a + b, 0); // ≈1585, south @ ~30°
const FC_MONTHLY_FRACTION = FC_MONTHLY_KWH_PER_KW.map((p) => p / FC_OPTIMAL_KWH_PER_KW);

// The household's actual roof, per the install proposal (3215 Westwood Ct):
// 33× REC Alpha Pure-R 420 = 13.86 kW DC, all @ 30° tilt, split across two
// opposing planes — WSW (az 250°) = 18 panels / 7.56 kW, ENE (az 70°) =
// 15 panels / 6.30 kW. Used automatically when reconciling this system (no
// explicit roof_faces AND the default 13.86 kW), so Anna models the real
// geometry without being told. Any non-default system_kw means a DIFFERENT
// house → don't impose Jasper's geometry.
const HOUSEHOLD_SYSTEM_KW = 13.86;
const HOUSEHOLD_ROOF_FACES = [
  { kw: 7.56, tilt: 30, azimuth: 250, label: 'WSW' },
  { kw: 6.30, tilt: 30, azimuth: 70, label: 'ENE' },
];

/** Linear interpolation over (x,y) breakpoints. */
function interp(x: number, pts: [number, number][]): number {
  if (x <= pts[0]![0]) return pts[0]![1];
  if (x >= pts[pts.length - 1]![0]) return pts[pts.length - 1]![1];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!, [x1, y1] = pts[i]!;
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return pts[pts.length - 1]![1];
}
// Annual-yield derates vs an optimal south @ ~30° array at ~40°N (modeled).
// Azimuth deviation from due south (0=S, 90=E/W, 180=N).
function azimuth_factor(azimuth: number): number {
  const dev = Math.abs(((azimuth % 360) + 360) % 360 - 180);
  return interp(dev, [[0, 1.0], [45, 0.96], [90, 0.87], [135, 0.72], [180, 0.58]]);
}
function tilt_factor(tilt: number): number {
  return interp(tilt, [[0, 0.89], [15, 0.97], [30, 1.0], [45, 0.97], [60, 0.88], [90, 0.6]]);
}

const InputSchema = z.object({
  system_kw: z.number().positive().default(13.86).describe('DC array size in kW (default = the household 33× REC Alpha Pure-R 420 = 13.86 kW).'),
  actual_annual_kwh: z.number().positive().optional().describe('Actual production over the last 12 months (from the Tesla app). Omit to just get the expected forecast.'),
  actual_monthly_kwh: z.array(z.number().min(0)).length(12).optional().describe('Optional Jan→Dec actual monthly production (Tesla app) for per-month flags.'),
  panel_age_years: z.number().min(0).max(40).default(0).describe('Array age in years — applies the ~0.25%/yr (premium) degradation to the expected baseline.'),
  tilt: z.number().min(0).max(90).default(30).describe('Roof tilt (degrees) — PVWatts path only.'),
  azimuth: z.number().min(0).max(360).default(180).describe('Array azimuth (180 = south) — PVWatts path only.'),
  losses_pct: z.number().min(0).max(50).default(14).describe('System losses % — PVWatts path only.'),
  roof_faces: z
    .array(z.object({
      kw: z.number().positive(),
      tilt: z.number().min(0).max(90),
      azimuth: z.number().min(0).max(360).describe('0=N, 90=E, 180=S, 270=W.'),
      label: z.string().max(40).optional(),
    }))
    .optional()
    .describe('Per-face sub-arrays for a MULTI-ORIENTATION roof (panels split across faces). Each {kw, tilt, azimuth} is derated by azimuth+tilt and summed — far more accurate than the single-array default when panels face different directions. Overrides system_kw/tilt/azimuth when given.'),
});
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
  source: z.enum(['pvwatts_api', 'modeled_fort_collins']),
  system_kw: z.number(),
  expected_annual_kwh: z.number(),
  expected_annual_kwh_after_degradation: z.number(),
  degradation_factor: z.number(),
  expected_monthly_kwh: z.array(z.number()),
  actual_annual_kwh: z.number().nullable(),
  performance_ratio: z.number().nullable().describe('actual ÷ degradation-adjusted expected. ~1.0 = on target.'),
  status: z.enum(['healthy', 'watch', 'underperforming', 'forecast_only']),
  monthly: z.array(z.object({ month: z.string(), expected: z.number(), actual: z.number().nullable(), ratio: z.number().nullable() })).optional(),
  flags: z.array(z.string()),
  notes: z.array(z.string()),
});
type Output = z.infer<typeof OutputSchema>;

const round = (n: number) => Math.round(n);

async function pvwatts_monthly(input: Input, key: string): Promise<number[] | null> {
  const url =
    `https://developer.nrel.gov/api/pvwatts/v8.json?api_key=${key}` +
    `&system_capacity=${input.system_kw}&module_type=1&array_type=1` +
    `&losses=${input.losses_pct}&tilt=${input.tilt}&azimuth=${input.azimuth}` +
    `&lat=${FC_LAT}&lon=${FC_LON}`;
  const res = await safe_fetch(url, { headers: { Accept: 'application/json' } }, 15000);
  if (!res.ok) return null;
  try {
    const j = JSON.parse(res.body) as { outputs?: { ac_monthly?: number[] } };
    const m = j.outputs?.ac_monthly;
    return Array.isArray(m) && m.length === 12 ? m : null;
  } catch {
    return null;
  }
}

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'reconcile_solar',
    description:
      "Check whether the home's solar array is producing what it should. Computes EXPECTED production (NREL PVWatts if NREL_API_KEY is set, else a modeled Pleasantville profile) for the system size, applies panel-age degradation, and — when given ACTUAL production (from the Tesla app: actual_annual_kwh, optionally actual_monthly_kwh) — returns a performance ratio, a healthy/watch/underperforming verdict, per-month flags with likely causes (snow, soiling, shading, an inverter down), and degradation context. With no actual, returns the expected forecast.",
    risk: 'read',
    required_capabilities: ['read_property_records'],
    weight: 'light',
    input_schema: InputSchema,
    output_schema: OutputSchema,
    llm_budget: 'full',

    idempotency_key(input) {
      return `reconcile_solar:${input.system_kw}:${input.actual_annual_kwh ?? '-'}:${input.panel_age_years}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const notes: string[] = [];
      const flags: string[] = [];

      // Expected monthly: per-face model (multi-orientation roof) → PVWatts →
      // single-array modeled profile.
      let expected_monthly: number[];
      let source: Output['source'];
      let system_kw = input.system_kw;
      // Use explicit roof_faces if passed; otherwise auto-apply the household's
      // real geometry when reconciling the default 13.86 kW system.
      const using_household_default =
        (!input.roof_faces || input.roof_faces.length === 0) &&
        Math.abs(input.system_kw - HOUSEHOLD_SYSTEM_KW) < 0.05;
      const effective_faces =
        input.roof_faces && input.roof_faces.length > 0
          ? input.roof_faces
          : using_household_default
            ? HOUSEHOLD_ROOF_FACES
            : null;
      if (effective_faces) {
        if (using_household_default) {
          notes.push("Using the household's actual roof geometry (3215 Westwood): WSW 7.56 kW @ 250° + ENE 6.30 kW @ 70°, both 30° tilt.");
        }
        system_kw = effective_faces.reduce((a, f) => a + f.kw, 0);
        let annual = 0;
        for (const f of effective_faces) {
          const fac = azimuth_factor(f.azimuth) * tilt_factor(f.tilt);
          const y = f.kw * FC_OPTIMAL_KWH_PER_KW * fac;
          annual += y;
          notes.push(`face ${f.label ?? ''} ${f.kw}kW @ ${f.tilt}°/${f.azimuth}° → ~${round(y)} kWh (${Math.round(fac * 100)}% of optimal)`.replace('  ', ' '));
        }
        expected_monthly = FC_MONTHLY_FRACTION.map((fr) => fr * annual);
        source = 'modeled_fort_collins';
        notes.push('Per-face modeled: each plane derated by azimuth+tilt vs an optimal south array, then summed — accurate for a split roof. (Per-face PVWatts is exact when the API is reachable.)');
      } else {
        const key = process.env.NREL_API_KEY?.trim();
        const pv = key ? await pvwatts_monthly(input, key) : null;
        if (pv) {
          expected_monthly = pv;
          source = 'pvwatts_api';
        } else {
          if (key) notes.push('PVWatts API call failed — fell back to the modeled profile.');
          else notes.push('Modeled profile assumes a single optimal-ish south array — for THIS roof pass roof_faces (panels are on multiple faces), or set NREL_API_KEY for exact PVWatts.');
          expected_monthly = FC_MONTHLY_KWH_PER_KW.map((p) => p * input.system_kw);
          source = 'modeled_fort_collins';
        }
      }
      const expected_annual = expected_monthly.reduce((a, b) => a + b, 0);

      // Degradation: REC premium ≈ first year 98%, then −0.25%/yr.
      const age = input.panel_age_years;
      const degradation_factor = age <= 0 ? 1 : Math.max(0.8, 0.98 - Math.max(0, age - 1) * 0.0025);
      const expected_adj = expected_annual * degradation_factor;
      if (age > 0) notes.push(`Degradation applied for ${age}-yr-old panels: expected baseline ×${degradation_factor.toFixed(3)} (premium ~0.25%/yr).`);

      // Compare to actual.
      const actual_annual = input.actual_annual_kwh ?? (input.actual_monthly_kwh ? input.actual_monthly_kwh.reduce((a, b) => a + b, 0) : null);
      let status: Output['status'] = 'forecast_only';
      let pr: number | null = null;
      if (actual_annual != null) {
        pr = actual_annual / expected_adj;
        status = pr >= 0.92 ? 'healthy' : pr >= 0.82 ? 'watch' : 'underperforming';
        if (status === 'underperforming') flags.push(`Annual production is ${Math.round(pr * 100)}% of expected — materially low. Check for shading growth, soiling, snow cover, or an inverter/string fault (you have 2 Tesla inverters — a single dead one ≈ −50% on its strings).`);
        else if (status === 'watch') flags.push(`Annual production is ${Math.round(pr * 100)}% of expected — slightly low; could be a soiling/snow season or modeling error. Watch the monthly pattern.`);
      } else {
        notes.push('No actual production supplied — this is the expected forecast. Read your 12-month production from the Tesla app and pass actual_annual_kwh (and actual_monthly_kwh for per-month flags).');
      }

      // Per-month detail + flags.
      let monthly: Output['monthly'];
      if (input.actual_monthly_kwh) {
        monthly = expected_monthly.map((exp, i) => {
          const expd = exp * degradation_factor;
          const act = input.actual_monthly_kwh![i]!;
          const ratio = expd > 0 ? act / expd : null;
          return { month: MONTHS[i]!, expected: round(expd), actual: round(act), ratio: ratio == null ? null : Math.round(ratio * 100) / 100 };
        });
        for (const m of monthly) {
          if (m.ratio != null && m.ratio < 0.7) {
            const cause = ['Dec', 'Jan', 'Feb'].includes(m.month) ? 'snow cover is the usual winter culprit' : ['Jun', 'Jul', 'Aug'].includes(m.month) ? 'summer dip points to soiling, new shading, or heat derate' : 'check shading/soiling or a partial outage';
            flags.push(`${m.month}: ${Math.round(m.ratio * 100)}% of expected — ${cause}.`);
          }
        }
      }

      notes.push('Utility bills show grid import/export, not GROSS solar production — actual production comes from the Tesla app (or a future Tesla-API pull).');
      notes.push('On FC net metering, summer surplus banks credits that roll forward to cover winter — track the credit-bank balance separately from production health.');

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'anna',
        tool_name: 'reconcile_solar',
        tool_input: { system_kw: input.system_kw, actual_annual_kwh: actual_annual, source },
        execution_result: { expected_annual: round(expected_annual), performance_ratio: pr, status },
      });

      return {
        source,
        system_kw,
        expected_annual_kwh: round(expected_annual),
        expected_annual_kwh_after_degradation: round(expected_adj),
        degradation_factor: Math.round(degradation_factor * 1000) / 1000,
        expected_monthly_kwh: expected_monthly.map(round),
        actual_annual_kwh: actual_annual == null ? null : round(actual_annual),
        performance_ratio: pr == null ? null : Math.round(pr * 100) / 100,
        status,
        monthly,
        flags,
        notes,
      };
    },
  };
}
