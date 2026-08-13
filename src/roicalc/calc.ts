// src/roicalc/calc.ts — pure ROI math for the local-vs-cloud LLM calculator.
// No I/O here: the server route validates with RoiInputSchema and calls
// compute_roi; the smoke asserts the numbers directly.

import { z } from 'zod';

/** 8760 h/yr ÷ 12 — the standard datacenter month. */
export const HOURS_PER_MONTH = 730;

export const RoiInputSchema = z.object({
  bench: z.object({
    /** Measured (or hand-entered) prompt-processing rate, tokens/second. */
    prefill_tps: z.number().finite().positive(),
    /** Measured (or hand-entered) generation rate, tokens/second. */
    gen_tps: z.number().finite().positive(),
  }),
  workload: z.object({
    prompt_mtok_month: z.number().finite().min(0),
    output_mtok_month: z.number().finite().min(0),
  }),
  local: z.object({
    /** Total capex: GPU(s) + the rest of the box. The client sums its line items. */
    hardware_cost_usd: z.number().finite().min(0),
    /** Whole-system draw while inferring, watts. */
    power_load_w: z.number().finite().min(0),
    /** Whole-system idle draw, watts. Only billed in dedicated_24_7 mode. */
    power_idle_w: z.number().finite().min(0).default(0),
    electricity_usd_per_kwh: z.number().finite().min(0),
    /** true → the box exists for this workload, so idle hours bill to it too.
     *  false → shared box that would be powered on anyway; bill only the
     *  energy the inference itself burns. */
    dedicated_24_7: z.boolean().default(false),
    misc_monthly_usd: z.number().finite().min(0).default(0),
  }),
  cloud: z.object({
    input_usd_per_mtok: z.number().finite().min(0),
    output_usd_per_mtok: z.number().finite().min(0),
    /** Flat plans (Claude Max, ChatGPT Plus/Pro, Copilot…). Added on top of
     *  any per-token rates; set the rates to 0 if the plan covers the usage. */
    subscription_usd_month: z.number().finite().min(0).default(0),
  }),
  horizons_months: z
    .array(z.number().int().min(1).max(120))
    .min(1)
    .max(8)
    .default([12, 24, 36, 48]),
});

export type RoiInput = z.infer<typeof RoiInputSchema>;

export type CapacityFlag = 'ok' | 'high' | 'over';

export interface RoiHorizonRow {
  months: number;
  local_total_usd: number;
  cloud_total_usd: number;
  /** cloud_total − local_total: positive means local wins by this horizon. */
  savings_usd: number;
  /** savings ÷ hardware capex; null when capex is 0. */
  roi_pct: number | null;
  /** Blended in+out $/Mtok with hardware amortized over this horizon. */
  local_usd_per_mtok: number | null;
}

export interface RoiResult {
  busy_hours_month: number;
  utilization_pct: number;
  capacity: CapacityFlag;
  energy_kwh_month: number;
  energy_cost_month_usd: number;
  local_opex_month_usd: number;
  cloud_cost_month_usd: number;
  /** Blended in+out cloud $/Mtok; null when the workload is zero. */
  cloud_usd_per_mtok: number | null;
  /** Month where cumulative cloud spend overtakes hardware + local opex;
   *  null when local opex alone meets or exceeds the cloud bill. */
  breakeven_months: number | null;
  rows: RoiHorizonRow[];
}

export function compute_roi(input: RoiInput): RoiResult {
  const { bench, workload, local, cloud } = input;

  const prompt_tok = workload.prompt_mtok_month * 1e6;
  const output_tok = workload.output_mtok_month * 1e6;
  const total_mtok_month = workload.prompt_mtok_month + workload.output_mtok_month;

  // GPU-busy time to serve the month's tokens, single-stream — no batching
  // credit, so capacity reads conservative.
  const busy_seconds = prompt_tok / bench.prefill_tps + output_tok / bench.gen_tps;
  const busy_hours = busy_seconds / 3600;
  const utilization = busy_hours / HOURS_PER_MONTH;
  const capacity: CapacityFlag = utilization > 1 ? 'over' : utilization > 0.7 ? 'high' : 'ok';

  const load_kwh = (local.power_load_w * busy_hours) / 1000;
  const idle_kwh = local.dedicated_24_7
    ? (local.power_idle_w * Math.max(0, HOURS_PER_MONTH - busy_hours)) / 1000
    : 0;
  const energy_kwh = load_kwh + idle_kwh;
  const energy_cost = energy_kwh * local.electricity_usd_per_kwh;
  const local_opex = energy_cost + local.misc_monthly_usd;

  const cloud_month =
    workload.prompt_mtok_month * cloud.input_usd_per_mtok +
    workload.output_mtok_month * cloud.output_usd_per_mtok +
    cloud.subscription_usd_month;

  const monthly_saving = cloud_month - local_opex;
  const breakeven_months =
    monthly_saving > 0 ? local.hardware_cost_usd / monthly_saving : null;

  const rows: RoiHorizonRow[] = input.horizons_months.map((months) => {
    const local_total = local.hardware_cost_usd + local_opex * months;
    const cloud_total = cloud_month * months;
    const savings = cloud_total - local_total;
    return {
      months,
      local_total_usd: local_total,
      cloud_total_usd: cloud_total,
      savings_usd: savings,
      roi_pct: local.hardware_cost_usd > 0 ? (savings / local.hardware_cost_usd) * 100 : null,
      local_usd_per_mtok:
        total_mtok_month > 0
          ? (local.hardware_cost_usd / months + local_opex) / total_mtok_month
          : null,
    };
  });

  return {
    busy_hours_month: busy_hours,
    utilization_pct: utilization * 100,
    capacity,
    energy_kwh_month: energy_kwh,
    energy_cost_month_usd: energy_cost,
    local_opex_month_usd: local_opex,
    cloud_cost_month_usd: cloud_month,
    cloud_usd_per_mtok: total_mtok_month > 0 ? cloud_month / total_mtok_month : null,
    breakeven_months,
    rows,
  };
}
