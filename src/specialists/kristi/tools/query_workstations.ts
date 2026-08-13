/**
 * Kristi's read tools over the `kristi_workstations` store — apples-to-apples
 * comparison, pricing history, the leak radar, the HP-Z gap view, and the ISV
 * matrix. Surfaced in chat AND deliberation. Read-only; light.
 */
import { z } from 'zod';
import type { Tool } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { getKristiWorkstationsStore } from '@memory/stores/kristi_workstations';

const Vendor = z.enum(['hp', 'dell', 'lenovo', 'nvidia', 'other']);
const FormFactor = z.enum(['tower', 'rack', 'edge', 'mobile', 'sff', 'other']);
const SkuStatus = z.enum(['leaked', 'announced', 'shipping', 'eol']);
const IsvCategory = z.enum(['aec', 'me', 'pdm', 'fedgov', 'oem', 'healthcare', 'other']);

// ── lookup_workstation ───────────────────────────────────────────────────────

const LookupIn = z.object({
  model_id: z.string().optional().describe('Exact SKU slug for full detail.'),
  vendor: Vendor.optional(),
  family: z.string().optional(),
  form_factor: FormFactor.optional(),
  status: SkuStatus.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const make_lookup_workstation = (): Tool<z.infer<typeof LookupIn>, unknown> => ({
  name: 'lookup_workstation',
  description:
    "Look up workstation SKUs in Kristi's store. Pass a model_id for full detail (specs, GPU options, latest prices), or filter by vendor/family/form_factor (tower/rack/edge/mobile/sff)/status (leaked/announced/shipping/eol) to list matches.",
  risk: 'read',
  required_capabilities: ['read_workstation_intel'],
  input_schema: LookupIn,
  output_schema: z.any(),
  idempotency_key: (i) => `lookup_workstation:${JSON.stringify(i)}`,
  async execute(input) {
    const store = getKristiWorkstationsStore();
    if (input.model_id) {
      const detail = store.compare_configs([input.model_id]);
      return detail[0] ?? { error: `no SKU ${input.model_id}` };
    }
    return store.find_skus({
      vendor: input.vendor,
      family: input.family,
      form_factor: input.form_factor,
      status: input.status,
      limit: input.limit,
    });
  },
});

// ── compare_configs ──────────────────────────────────────────────────────────

const CompareIn = z.object({
  model_ids: z.array(z.string().min(1)).min(2).describe('Two or more SKU slugs to compare apples-to-apples.'),
});

const make_compare_configs = (): Tool<z.infer<typeof CompareIn>, unknown> => ({
  name: 'compare_configs',
  description:
    'Assemble an apples-to-apples comparison across two or more SKUs: each with its specs, GPU options, and latest price points per segment. Use this to answer "how does the HP Z vs the Dell T6 vs the Lenovo PX stack up." You frame the advantage/gap narrative from the rows.',
  risk: 'read',
  required_capabilities: ['read_workstation_intel'],
  input_schema: CompareIn,
  output_schema: z.any(),
  llm_budget: 'full',
  idempotency_key: (i) => `compare_configs:${i.model_ids.slice().sort().join(',')}`,
  async execute(input) {
    return getKristiWorkstationsStore().compare_configs(input.model_ids);
  },
});

// ── price_history ─────────────────────────────────────────────────────────────

const PriceHistIn = z.object({
  model_id: z.string().min(1),
  config_label: z.string().optional(),
});

const make_price_history = (): Tool<z.infer<typeof PriceHistIn>, unknown> => ({
  name: 'price_history',
  description:
    'Return the recorded price points for a SKU over time (optionally one configuration), oldest→newest, with computed discount %. Use to see how a vendor is discounting to capture SMB/prosumer.',
  risk: 'read',
  required_capabilities: ['read_workstation_intel'],
  input_schema: PriceHistIn,
  output_schema: z.any(),
  idempotency_key: (i) => `price_history:${i.model_id}:${i.config_label ?? '*'}`,
  async execute(input) {
    return getKristiWorkstationsStore().price_history(input.model_id, input.config_label);
  },
});

// ── leak_radar ────────────────────────────────────────────────────────────────

const LeakIn = z.object({ limit: z.number().int().min(1).max(50).optional() });

const make_leak_radar = (): Tool<z.infer<typeof LeakIn>, unknown> => ({
  name: 'leak_radar',
  description:
    'The VERIFIED pre-launch leak radar: cert-registry model-strings (DMTF/ENERGY STAR/TCO) confirmed by the reconcile pass to have NO announced or shipping retail product behind them — each with its verification date + evidence URL. Already-in-market machines never show here (they are matched/classified out, and the catalog auto-grows from those verdicts); sightings still awaiting verification appear only in the `coverage.pending` count, never as leaks. These rows are the genuinely-new platforms worth researching.',
  risk: 'read',
  required_capabilities: ['read_workstation_intel'],
  input_schema: LeakIn,
  output_schema: z.any(),
  idempotency_key: (i) => `leak_radar:${i.limit ?? 12}`,
  async execute(input) {
    const store = getKristiWorkstationsStore();
    return {
      leaks: store.leak_radar(input.limit ?? 12),
      coverage: store.cert_watch_totals(),
    };
  },
});

// ── hp_z_gaps ─────────────────────────────────────────────────────────────────

const make_hp_z_gaps = (): Tool<Record<string, never>, unknown> => ({
  name: 'hp_z_gaps',
  description:
    "HP Z competitive-advantage / gap view, LANE-AWARE: per swimlane + recorded spec, HP's best numeric value vs the best rival value within the SAME capability lane (with each side's model + cpu_platform). Positive lead = HP ahead in that lane; negative = a gap to close. Compares within a lane so it never pairs an expert-lane prev-gen HP against a mid-lane current-gen rival; platforms are carried so a cross-generation pairing is visible.",
  risk: 'read',
  required_capabilities: ['read_workstation_intel'],
  input_schema: z.object({}).strict(),
  output_schema: z.any(),
  idempotency_key: () => 'hp_z_gaps',
  async execute() {
    return getKristiWorkstationsStore().hp_z_gap_view();
  },
});

// ── isv_matrix ────────────────────────────────────────────────────────────────

const IsvIn = z.object({
  category: IsvCategory.optional(),
  vendor: Vendor.optional(),
  model_id: z.string().optional(),
});

const make_isv_matrix = (): Tool<z.infer<typeof IsvIn>, unknown> => ({
  name: 'isv_matrix',
  description:
    'List recorded ISV certifications, filterable by category (aec/me/pdm/fedgov/oem/healthcare), vendor, or SKU. Each row carries the GPU-support note and whether the ISV mentions GeForce/consumer-GPU support.',
  risk: 'read',
  required_capabilities: ['read_workstation_intel'],
  input_schema: IsvIn,
  output_schema: z.any(),
  idempotency_key: (i) => `isv_matrix:${JSON.stringify(i)}`,
  async execute(input) {
    return getKristiWorkstationsStore().isv_certs_for({
      category: input.category,
      vendor: input.vendor,
      model_id: input.model_id,
    });
  },
});

// ── list_projections ──────────────────────────────────────────────────────

const ProjIn = z.object({
  swimlane: z.string().optional().describe("Filter to one lane, e.g. 'mid-xeon-w' / 'z4-class' — pass this to pull all three OEM projections for a side-by-side."),
  vendor: Vendor.optional(),
  projection_kind: z.enum(['tech_push', 'market_pull']).optional().describe("Filter by kind: 'tech_push' (next-gen lineage inference) or 'market_pull' (where the lane NEEDS to go, from demand + market signals). Omit to get both."),
});

const make_list_projections = (): Tool<z.infer<typeof ProjIn>, unknown> => ({
  name: 'list_projections',
  description:
    "List Kristi's recorded swimlane projections (clearly-labeled inference, not fact). Each is either a 'tech_push' next-gen lineage projection OR a 'market_pull' projection of where the lane NEEDS to go (from demand + analyst/market signals). Filter by swimlane to pull the three OEMs' projections for the same lane and compare/contrast; filter by projection_kind to get just one kind. Each carries projection_kind, cpu_platform, key deltas/targets, confidence, falsifier, rationale, and its grounding sources.",
  risk: 'read',
  required_capabilities: ['read_workstation_intel'],
  input_schema: ProjIn,
  output_schema: z.any(),
  llm_budget: 'full',
  idempotency_key: (i) => `list_projections:${JSON.stringify(i)}`,
  async execute(input) {
    return getKristiWorkstationsStore().list_projections({
      swimlane: input.swimlane,
      vendor: input.vendor,
      projection_kind: input.projection_kind,
    });
  },
});

// ── commodity_compare ──────────────────────────────────────────────────────

const CommodityIn = z.object({
  commodity: z.string().min(1).describe("Normalized component name, e.g. 'NVIDIA RTX 4000 Ada'."),
  include_history: z.boolean().optional().describe('Also return the full price history across OEMs over time.'),
});

const make_commodity_compare = (): Tool<z.infer<typeof CommodityIn>, unknown> => ({
  name: 'commodity_compare',
  description:
    "The per-OEM price spread for one component: what Dell vs HP vs Lenovo charge for the SAME commodity (e.g. 'RTX 4000 Ada: Dell $X, HP $Z'), latest price each, cheapest first. Pass include_history for the full over-time series. Use to answer how each vendor marks up a given part up and down the stack.",
  risk: 'read',
  required_capabilities: ['read_workstation_intel'],
  input_schema: CommodityIn,
  output_schema: z.any(),
  llm_budget: 'full',
  idempotency_key: (i) => `commodity_compare:${i.commodity}:${i.include_history ? 'h' : 'l'}`,
  async execute(input) {
    const store = getKristiWorkstationsStore();
    const spread = store.commodity_compare(input.commodity);
    return input.include_history
      ? { commodity: input.commodity, spread, history: store.commodity_history(input.commodity) }
      : { commodity: input.commodity, spread };
  },
});

// ── swimlanes ──────────────────────────────────────────────────────────────

const make_swimlanes = (): Tool<Record<string, never>, unknown> => ({
  name: 'swimlanes',
  description:
    "The competitive swimlanes Kristi derived by clustering SKUs on capability envelope (max GPU / memory / PSU-chassis / socket-CPU tier), NOT vendor or naming — each lane with its cross-OEM members. Use to compare like-for-like (an HP Z6 vs Lenovo P7/P8 vs Dell 7875 sit in one lane). Run by `cluster_swimlanes`.",
  risk: 'read',
  required_capabilities: ['read_workstation_intel'],
  input_schema: z.object({}).strict(),
  output_schema: z.any(),
  idempotency_key: () => 'swimlanes',
  async execute() {
    return getKristiWorkstationsStore().swimlane_view();
  },
});

// ── coverage_gaps (which class × vendor × tier cells are empty) ──────────────

const make_coverage_gaps = (): Tool<Record<string, never>, unknown> => ({
  name: 'coverage_gaps',
  description:
    "Recorded-SKU coverage per (class × vendor × tier) — which competitive cells are FILLED vs EMPTY. Call this FIRST in a recording pass and record NET-NEW models into the empty cells, instead of re-confirming flagships already present. An empty 'desktop · entry / lenovo' means no Lenovo entry desktop (ThinkStation P3/Tiny) is catalogued yet; 'mobile / lenovo' empty means no ThinkPad P. Tiers: entry/mainstream/performance/expert; classes: desktop/mobile/rack/edge-ai.",
  risk: 'read',
  required_capabilities: ['read_workstation_intel'],
  input_schema: z.object({}).strict(),
  output_schema: z.any(),
  idempotency_key: () => 'coverage_gaps',
  async execute() {
    const cells = getKristiWorkstationsStore().coverage_summary();
    const fmt = (c: { ws_class_label: string; tier: string; vendor: string }) =>
      c.tier ? `${c.ws_class_label} · ${c.tier} / ${c.vendor}` : `${c.ws_class_label} / ${c.vendor}`;
    return {
      empty_cells: cells.filter((c) => c.count === 0).map(fmt),
      filled_cells: cells.filter((c) => c.count > 0).map((c) => `${fmt(c)}: ${c.count}`),
      total_recorded: cells.reduce((n, c) => n + c.count, 0),
    };
  },
});

// ── radar (threats + net-new players) ───────────────────────────────────────

const RadarIn = z.object({
  kind: z.enum(['threat', 'new_player', 'platform_shift']).optional(),
  severity: z.enum(['low', 'medium', 'high']).optional(),
});

const make_radar = (): Tool<z.infer<typeof RadarIn>, unknown> => ({
  name: 'radar',
  description:
    "The competitive radar BEYOND the tier-1 towers: workstation-adjacent threats/disruptors (ARM/agentic/edge/cloud — e.g. NVIDIA N1X) and net-new players (BOXX, Puget, Maingear, Lambda…), highest-severity first, each with the thesis for why it pressures the x86 workstation. Filter by kind or severity.",
  risk: 'read',
  required_capabilities: ['read_workstation_intel'],
  input_schema: RadarIn,
  output_schema: z.any(),
  llm_budget: 'full',
  idempotency_key: (i) => `radar:${i.kind ?? '*'}:${i.severity ?? '*'}`,
  async execute(input) {
    return getKristiWorkstationsStore().radar({ kind: input.kind, severity: input.severity });
  },
});

// ── swimlane_profiles (persona / ICP / UCP per lane) ────────────────────────

const ProfilesIn = z.object({
  ws_class: z.enum(['dtws', 'mws', 'rws', 'edge_ai']).optional().describe('Restrict to one class: dtws (desktop), mws (mobile), rws (rack), edge_ai.'),
  swimlane: z.string().optional().describe('Restrict to one capability-envelope lane (the slug from `swimlanes`).'),
  profile_kind: z.enum(['persona', 'icp', 'ucp']).optional().describe("'persona' (the human seat), 'icp' (ideal customer org), or 'ucp' (UNideal customer + redirect)."),
});

const make_swimlane_profiles = (): Tool<z.infer<typeof ProfilesIn>, unknown> => ({
  name: 'swimlane_profiles',
  description:
    "The DEMAND-SIDE view per swimlane: who each lane is FOR. personas (the human seat), the ICP (ideal customer org), and the UCP (UNideal customer — who looks like a fit but shouldn't buy here, plus the lane they belong in). Each is grounded backwards from a real workflow's compute demand to the capability driver that makes the lane fit. Filter by ws_class / swimlane / profile_kind. This is the 'Who it's for' tap-down on the Recon Desk.",
  risk: 'read',
  required_capabilities: ['read_workstation_intel'],
  input_schema: ProfilesIn,
  output_schema: z.any(),
  llm_budget: 'full',
  idempotency_key: (i) => `swimlane_profiles:${i.ws_class ?? '*'}:${i.swimlane ?? '*'}:${i.profile_kind ?? '*'}`,
  async execute(input) {
    return getKristiWorkstationsStore().list_swimlane_profiles({
      ws_class: input.ws_class,
      swimlane: input.swimlane,
      profile_kind: input.profile_kind,
    });
  },
});

// ── data_health (completeness + freshness — stale beats missing) ────────────

const make_data_health = (): Tool<Record<string, never>, unknown> => ({
  name: 'data_health',
  description:
    "The QUALITY companion to coverage_gaps: per (class × tier / vendor) cell, how USABLE the recorded SKUs are — how many have ≥3 comparable specs (can join a lane comparison), a system price observed in the last 14 days, fresh configurator deltas, and a recorded base unit. A cell that EXISTS but is stale misleads more than an empty one (it looks covered). The `worklist` names the worst cells — start a recording pass there after coverage_gaps' empty cells.",
  risk: 'read',
  required_capabilities: ['read_workstation_intel'],
  input_schema: z.object({}).strict(),
  output_schema: z.any(),
  llm_budget: 'full',
  idempotency_key: () => 'data_health',
  async execute() {
    return getKristiWorkstationsStore().data_health();
  },
});

export function create(_deps: ToolDeps): Tool[] {
  return [
    make_lookup_workstation(),
    make_compare_configs(),
    make_price_history(),
    make_leak_radar(),
    make_hp_z_gaps(),
    make_isv_matrix(),
    make_list_projections(),
    make_commodity_compare(),
    make_swimlanes(),
    make_coverage_gaps(),
    make_radar(),
    make_swimlane_profiles(),
    make_data_health(),
  ];
}
