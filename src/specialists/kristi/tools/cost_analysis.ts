/**
 * Kristi's cost-analysis read tools — the base-unit (platform) residuals, the
 * commodity street-price trends, and the deterministic forward COST OUTLOOK.
 *
 * These read the same store views the Recon Desk renders, so what Kristi says
 * in chat and what the pane shows can never drift apart. The outlook math is
 * pure extrapolation over recorded observations (cost_model.ts) — no LLM in
 * the loop; every input row carries a source_url. Kristi's job on top of these
 * numbers is the ANALYSIS: which OEM's platform tax is moving, which lane's
 * economics a commodity squeeze breaks, and when to bubble that up.
 */
import { z } from 'zod';
import type { Tool } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { getKristiWorkstationsStore, type CommodityClass, type WsClass } from '@memory/stores/kristi_workstations';

const WsClassIn = z.enum(['dtws', 'mws', 'rws', 'edge_ai']);
const CommodityClassIn = z.enum(['gpu', 'cpu', 'memory', 'storage', 'psu', 'cooling', 'other']);

// ── base_unit_costs ──────────────────────────────────────────────────────────

const BaseUnitIn = z.object({
  ws_class: WsClassIn.optional().describe('Restrict to one class: dtws (desktop), mws (mobile), rws (rack), edge_ai.'),
});

const make_base_unit_costs = (): Tool<z.infer<typeof BaseUnitIn>, unknown> => ({
  name: 'base_unit_costs',
  description:
    "The derived BASE-UNIT (platform) cost per recorded workstation: the OEM's base config price with its included commodities backed out at ROBUST street (median of recent observations) — the residual is chassis + PSU + motherboard + base margin, comparable across OEMs. Each row carries the backed-out components, `missing` (components with no street price yet — your worklist for lookup/record_commodity_price standalone rows), and integrity `flags` (negative residual, noisy street). It's an ESTIMATE that leans high (OEMs mark base commodities up over street); the cross-OEM comparison is the insight — always say so.",
  risk: 'read',
  required_capabilities: ['read_workstation_intel'],
  input_schema: BaseUnitIn,
  output_schema: z.any(),
  llm_budget: 'full',
  idempotency_key: (i) => `base_unit_costs:${i.ws_class ?? '*'}`,
  async execute(input) {
    const store = getKristiWorkstationsStore();
    const rows = store.base_unit_view(input.ws_class as WsClass | undefined);
    const missing_street_prices = [...new Set(rows.flatMap((r) => r.missing))];
    return {
      platforms: rows,
      // The cross-row worklist: street-price these (record_commodity_price,
      // price_kind 'standalone') and every residual that uses them tightens.
      missing_street_prices,
    };
  },
});

// ── commodity_trends ─────────────────────────────────────────────────────────

const TrendsIn = z.object({
  commodity: z.string().optional().describe("One commodity's full trend detail (normalized name from list/compare), e.g. '64GB DDR5-6400 ECC'."),
  commodity_class: CommodityClassIn.optional().describe('Restrict the table to one class (memory/storage/gpu = the squeeze classes).'),
  limit: z.number().int().min(1).max(60).optional(),
});

const make_commodity_trends = (): Tool<z.infer<typeof TrendsIn>, unknown> => ({
  name: 'commodity_trends',
  description:
    "How component STREET prices are MOVING: per commodity, the latest observed market price, week/month change, and a fitted compounding monthly drift % (log-linear over the recorded daily series, with r², point count, and span — so you can judge the fit before quoting it). Plus the per-class median drift (`market_drift`) — the DRAM/NAND/VRAM squeeze as one number per class. Strongest movers first. A drift is an OBSERVED RATE on your own recorded series, not a forecast; quote it with its window ('+8%/mo over 60 days') and treat thin fits (confidence: low) as directional only.",
  risk: 'read',
  required_capabilities: ['read_workstation_intel'],
  input_schema: TrendsIn,
  output_schema: z.any(),
  llm_budget: 'full',
  idempotency_key: (i) => `commodity_trends:${i.commodity ?? '*'}:${i.commodity_class ?? '*'}:${i.limit ?? 24}`,
  async execute(input) {
    const store = getKristiWorkstationsStore();
    if (input.commodity) {
      return {
        trend: store.commodity_trend(input.commodity),
        history: store.price_series(input.commodity, { price_kinds: ['standalone'] }),
      };
    }
    const trends = store.trend_table({
      commodity_class: input.commodity_class as CommodityClass | undefined,
      limit: input.limit,
    });
    const market_drift = (['memory', 'storage', 'gpu', 'cpu', 'psu'] as CommodityClass[])
      .map((cls) => ({ commodity_class: cls, drift: store.class_drift(cls) }))
      .filter((x) => x.drift != null)
      .map((x) => ({ commodity_class: x.commodity_class, ...x.drift! }));
    return { market_drift, trends };
  },
});

// ── cost_outlook ─────────────────────────────────────────────────────────────

const OutlookIn = z.object({
  ws_class: WsClassIn.optional().describe('Restrict to one class.'),
  model_id: z.string().optional().describe('One platform (SKU slug) only.'),
  horizons_months: z
    .array(z.number().int().min(1).max(36))
    .max(6)
    .optional()
    .describe('Projection horizons in months. Default [3, 6, 12].'),
});

const make_cost_outlook = (): Tool<z.infer<typeof OutlookIn>, unknown> => ({
  name: 'cost_outlook',
  description:
    "The deterministic FORWARD COST projection per recorded base unit: hold the platform residual constant, compound each backed-out commodity by its fitted street drift (own series first, class-median as labeled proxy), and re-sum — 'where this platform's base config price is heading IF the observed commodity drift holds', at 3/6/12-month horizons with widening low/high bands. Use it to answer 'what will the Z4 cost next quarter' and to compare which OEM the DRAM/NAND/VRAM squeeze hurts most (memory-heavy bases drift hardest). ALWAYS present as a labeled extrapolation with its confidence + caveats — the falsifier is the drift itself reversing. `market_drift` gives the per-class squeeze rates the projection used.",
  risk: 'read',
  required_capabilities: ['read_workstation_intel'],
  input_schema: OutlookIn,
  output_schema: z.any(),
  llm_budget: 'full',
  idempotency_key: (i) => `cost_outlook:${i.ws_class ?? '*'}:${i.model_id ?? '*'}:${(i.horizons_months ?? []).join(',') || 'default'}`,
  async execute(input) {
    return getKristiWorkstationsStore().cost_outlook({
      ws_class: input.ws_class as WsClass | undefined,
      model_id: input.model_id,
      horizons_months: input.horizons_months,
    });
  },
});

// ── perf_per_dollar ──────────────────────────────────────────────────────────

const PerfIn = z.object({
  component_class: z.enum(['cpu', 'gpu']).optional().describe('Restrict to CPUs or GPUs.'),
  limit: z.number().int().min(1).max(60).optional(),
});

const make_perf_per_dollar = (): Tool<z.infer<typeof PerfIn>, unknown> => ({
  name: 'perf_per_dollar',
  description:
    "PRICE-PER-PERFORMANCE: each scored CPU/GPU joined to its robust street price → score-per-dollar, grouped by benchmark (PassMark CPU Mark / G3D — scores ONLY compare within one benchmark; never compare a CPU Mark to a G3D number). The value axis beside capability (compare_configs) and cost (commodity_compare): use it to say which part delivers the most throughput per dollar in a lane, and pair with commodity_compare to show which OEM's upgrade path to that part is cheapest. A scored part with a null score_per_dollar lacks a street price — that's the worklist. Benchmark scores are Tier-2 directional synthetic numbers: name the benchmark when you quote one, and never present score-per-dollar as application performance.",
  risk: 'read',
  required_capabilities: ['read_workstation_intel'],
  input_schema: PerfIn,
  output_schema: z.any(),
  llm_budget: 'full',
  idempotency_key: (i) => `perf_per_dollar:${i.component_class ?? '*'}:${i.limit ?? '*'}`,
  async execute(input) {
    return getKristiWorkstationsStore().perf_per_dollar({
      component_class: input.component_class,
      limit: input.limit,
    });
  },
});

export function create(_deps: ToolDeps): Tool[] {
  return [make_base_unit_costs(), make_commodity_trends(), make_cost_outlook(), make_perf_per_dollar()];
}
