/**
 * Kristi's workstation competitive-intelligence cache — the structured
 * mirror she runs apples-to-apples comparisons, pricing-over-time, and the
 * cert-registry leak radar against.
 *
 * Kristi (Workstation Competitive-Intelligence Analyst) tracks the
 * desktop / rack / edge-AI workstation market: HP Z, Dell Pro Precision 9
 * Towers (T2/T4/T6), Lenovo ThinkStation (Xeon W + Threadripper Pro),
 * NVIDIA DGX Spark / IGX / N1X, RTX (PRO) Blackwell pro graphics, and the
 * ISV certification surface (AEC, M&E, PD&M, Fed/Gov, OEM, Healthcare).
 *
 * Two layers feed this store (see src/specialists/kristi/):
 *   - The *knowledge* layer: `scan_sources` fetches her source manifest and
 *     pipes each page through `ingest_to_library` (RAG, FTS5). Nothing
 *     structured is parsed there.
 *   - The *structured* layer: her deliberation passes READ those clippings
 *     and call the `record_*` tools, which write normalized rows HERE. Every
 *     row carries a `source_url` + `captured_at` so a claim is always
 *     traceable — "cold hard data," never a hunch. The query tools +
 *     `compose_competitive_pane` read this store.
 *
 * The cert-registry leak radar is the one place a scraper writes here
 * directly: `scan_cert_registries` diffs the set of certified model-strings
 * (DMTF / EnergyStar / TCO) and inserts NEW ones — vendors must certify
 * before retail, so a new string is a pre-launch leak (e.g. the Dec-2025
 * `dell-pro-precision-9-t6-pw9t6260` DMTF listing).
 *
 * Lives in its OWN SQLite file beside hearth.db (default
 * `<dir of HEARTH_DB_PATH>/kristi_workstations.db`, override with
 * HEARTH_KRISTI_DB_PATH) so it never bloats the main application DB.
 */

import { Database } from 'bun:sqlite';
import { dirname, resolve } from 'node:path';
import { normalizeSpec, dropSuspectOutliers, validateSpec } from '@specialists/kristi/spec_metrics';
import {
  validate_commodity_price,
  validate_system_price,
  validate_benchmark_score,
  KNOWN_BENCHMARKS,
  fit_drift,
  trend_direction,
  trend_confidence,
  project_price,
  median,
  type DriftFit,
  type TrendDirection,
  type TrendConfidence,
} from '@specialists/kristi/cost_model';

// ── cache DB location ────────────────────────────────────────────────────────

function cache_db_path(): string {
  const override = process.env.HEARTH_KRISTI_DB_PATH?.trim();
  if (override) return override;
  const main = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
  return resolve(dirname(main), 'kristi_workstations.db');
}

// ── enums (kept as string unions; stored as TEXT) ────────────────────────────

export type Vendor = 'hp' | 'dell' | 'lenovo' | 'nvidia' | 'other';
export type FormFactor = 'tower' | 'rack' | 'edge' | 'mobile' | 'sff' | 'other';

/**
 * Workstation CLASS — the top-level segmentation the Recon Desk toggles between:
 * Desktop (DTWS), Mobile (MWS), Rack (RWS), and Edge-AI. Derived from a SKU's
 * form factor, or guessed from a cert-registry model string (which has no SKU
 * yet). 'other' = a standalone part / unclassifiable (e.g. a bare GPU).
 */
export type WsClass = 'dtws' | 'mws' | 'rws' | 'edge_ai' | 'other';

/** IDC-aligned performance tier WITHIN a workstation class. The vendor's own
 *  line position is the anchor (HP Z2 / Dell Precision 3xxx / Lenovo P3 = entry;
 *  HP Z8 / Dell Pro Precision 9 / Lenovo PX = expert), capability ceiling the
 *  tiebreaker. Combined with the class it forms the swimlane slug `<class> ·
 *  <tier>` so equivalent machines across OEMs share a lane and an entry box is
 *  never bucketed with an expert one. '' = unassigned. Rack / edge-ai lanes may
 *  leave it blank (the class IS the lane there). */
export type Tier = 'entry' | 'mainstream' | 'performance' | 'expert' | '';

/** Human label for a class, used to compose swimlane slugs (`<class> · <tier>`)
 *  and coverage-gap rows. Mirrors the four tabs + 'other'. */
export function ws_class_label(c: WsClass): string {
  switch (c) {
    case 'dtws': return 'desktop';
    case 'mws': return 'mobile';
    case 'rws': return 'rack';
    case 'edge_ai': return 'edge-ai';
    default: return 'other';
  }
}

/** The form factors that belong to a workstation class — the inverse of
 *  `ws_class_from_form_factor`, for SQL filtering (`form_factor IN (...)`). */
export function form_factors_for_class(c: WsClass): FormFactor[] {
  switch (c) {
    case 'dtws':
      return ['tower', 'sff'];
    case 'mws':
      return ['mobile'];
    case 'rws':
      return ['rack'];
    case 'edge_ai':
      return ['edge'];
    default:
      return ['other'];
  }
}

/** Map a SKU's form factor to its workstation class. */
export function ws_class_from_form_factor(ff: FormFactor): WsClass {
  switch (ff) {
    case 'tower':
    case 'sff':
      return 'dtws';
    case 'mobile':
      return 'mws';
    case 'rack':
      return 'rws';
    case 'edge':
      return 'edge_ai';
    default:
      return 'other';
  }
}

/**
 * Guess the workstation class from a cert-registry / model string when no SKU
 * (hence no form factor) exists yet. Nomenclature is the signal: Lenovo
 * ThinkPad = mobile vs ThinkStation = desktop; HP ZBook = mobile vs Z = desktop;
 * Dell "Precision" spans all, so it leans on the Rack/Tower/Pro-Max qualifier.
 * Checked most-specific-first; defaults to desktop (towers dominate the
 * registries). Deterministic + cheap so it can tag every sighting.
 */
export function ws_class_from_nomenclature(model_string: string): WsClass {
  const s = model_string.toLowerCase();
  const mobile_signal = /\b(mobile|laptop|notebook)\b/.test(s);
  // Edge / AI appliances first (DGX Spark, IGX, Jetson, edge inference boxes),
  // plus dedicated inference accelerators that show up in a cert registry. Only
  // the UNAMBIGUOUS paired phrases here (not bare npu/fpga/asic) so an
  // NPU-equipped laptop string doesn't get pulled out of its mobile class.
  if (
    /\b(dgx|igx|jetson)\b|edge[\s-]*(ai|inference|box)|inference[\s-]*(accelerator|asic|chip|card)|ai[\s-]*accelerator/.test(s)
  )
    return 'edge_ai';
  // Rack workstations (Dell Precision … Rack, rack-mount Z, rack AI).
  if (/\brack\b/.test(s)) return 'rws';
  // Mobile — clean vendor signals (HP ZBook, Lenovo ThinkPad), or an explicit
  // mobile/laptop/notebook word (catches Dell Precision-mobile + Pro Max mobile).
  if (/\bzbook\b|\bthinkpad\b/.test(s)) return 'mws';
  if (mobile_signal) return 'mws';
  // Desktop — ThinkStation; HP Z / Z1 / Z2 / Elite Tower (+ Mini / SFF / Slim);
  // Dell Precision 9 (the current desktop pivot) / tower / Pro Max desktop.
  // NOTE: Dell naming is genuinely ambiguous — the short-lived "Precision Pro
  // Max" and the pivot to "Precision 9" mean a bare "Precision NNNN" or "Pro Max"
  // string can't be reliably classed by name. We default such cases to desktop
  // (the registries are overwhelmingly desktop), and the SKU's RECORDED
  // form_factor (Kristi reads it off the spec sheet) is the authoritative class
  // once the model is catalogued — see ws_class_from_form_factor.
  if (
    /\bthinkstation\b|\belite\s?tower\b|\bz[0-9]\s?g[0-9]|\bz[12]\b|\btower\b|\bsff\b|\bmini\b|\bslim\b|\bmicro\b|\bdesktop\b/.test(s) ||
    /\bprecision\s*9\b|pro\s+precision\s+9/.test(s)
  )
    return 'dtws';
  return 'dtws';
}

/**
 * Class signal for a FREE-STANDING radar item (threat / new player / platform
 * shift) from its name. Unlike `ws_class_from_nomenclature`, this returns
 * `'all'` (cross-class) when there is no positive class keyword — a platform
 * shift like "Windows-on-ARM agentic ISV" pressures every workstation class, so
 * it must NOT be force-bucketed into a single tab. Only a confident keyword
 * scopes the item to one class; everything else stays cross-class and surfaces
 * in every class tab. Deterministic + cheap.
 */
export function radar_class_signal(name: string): WsClass | 'all' {
  const s = name.toLowerCase();
  // Edge·AI — NVIDIA's appliance line AND the independent inference-accelerator
  // field (inference FPGAs / ASICs / NPUs, PCIe/M.2 add-in cards). A radar item
  // here IS the silicon, so bare npu/fpga/asic tokens are safe to anchor on.
  if (
    /\b(dgx|igx|jetson|npu|fpga|asic)\b|edge[\s-]*(ai|inference|box)|inference[\s-]*(accelerator|asic|chip|card)|ai[\s-]*accelerator/.test(s)
  )
    return 'edge_ai';
  if (/\brack\b/.test(s)) return 'rws';
  if (/\bzbook\b|\bthinkpad\b|\b(mobile|laptop|notebook)\b/.test(s)) return 'mws';
  if (/\bthinkstation\b|\belite\s?tower\b|\bz[0-9]\s?g[0-9]|\bz[12]\b|\btower\b|\bprecision\s*9\b/.test(s)) return 'dtws';
  return 'all';
}

export type CpuPlatform =
  | 'xeon_w'
  | 'threadripper_pro'
  | 'arm'
  | 'core_ultra'
  | 'grace'
  | 'other';
export type SkuStatus = 'leaked' | 'announced' | 'shipping' | 'eol';
export type PriceSegment = 'smb' | 'prosumer' | 'enterprise' | 'edu' | 'gov';
export type GpuClass =
  | 'rtx_pro_blackwell'
  | 'rtx_pro_ada'
  | 'geforce'
  | 'datacenter'
  | 'other';
export type IsvCategory =
  | 'aec'
  | 'me'
  | 'pdm'
  | 'fedgov'
  | 'oem'
  | 'healthcare'
  | 'other';
export type CertRegistry = 'dmtf' | 'energystar' | 'tco';
export type Confidence = 'low' | 'medium' | 'high';
export type CommodityClass = 'gpu' | 'cpu' | 'memory' | 'storage' | 'psu' | 'cooling' | 'other';
/** What a projection extrapolates FROM. `tech_push` = supply-side: the line's
 *  verified generational lineage + the public compute roadmap ("where this line
 *  is GOING"). `market_pull` = demand-side: the lane's persona/ICP/UCP demand
 *  profiles + analyst/market signals ("where this lane NEEDS to go"). Both are
 *  labeled inference; a lane can carry one of each, kept distinct so the Recon
 *  Desk shows them side by side. */
export type ProjectionKind = 'tech_push' | 'market_pull';
/** Competitive radar beyond the tier-1 towers. `threat` = a disruptor pressuring
 *  the x86 workstation (ARM/agentic/edge/cloud — e.g. NVIDIA N1X); `new_player` =
 *  a net-new vendor outside HP/Dell/Lenovo (BOXX, Puget, Maingear, Lambda…);
 *  `platform_shift` = an industry move (agentic-ISV, Windows-on-ARM, etc.). */
export type RadarKind = 'threat' | 'new_player' | 'platform_shift';
export type Severity = 'low' | 'medium' | 'high';
/** Which kind of pane item an assessment is attached to. One assessment per
 *  (subject_type, subject_key) — Kristi's durable written VIEW on that item,
 *  surfaced as the tap-through `detail_md` on the Recon Desk pane. */
export type AssessmentSubject =
  | 'sku'
  | 'radar_item'
  | 'projection'
  | 'swimlane'
  | 'hp_gap'
  | 'commodity'
  | 'leak';

// ── public row shapes ────────────────────────────────────────────────────────

export interface SkuRow {
  model_id: string; // slug, e.g. 'dell-pro-precision-9-t6'
  vendor: Vendor;
  family: string; // 'Z', 'Pro Precision 9', 'ThinkStation PX', 'DGX Spark'
  model_name: string; // display name
  form_factor: FormFactor;
  chassis_variant: string; // 'extended side panel', 'T4-derived', ''
  cpu_platform: CpuPlatform;
  status: SkuStatus;
  announced_at: string; // ISO date or ''
  launched_at: string;
  source_url: string;
  notes: string;
  first_seen: string;
  last_seen: string;
  /** Competitive swimlane Kristi derived by clustering on capability envelope
   *  (max GPU count / memory / PSU / socket-CPU tier), NOT vendor or naming.
   *  Set by `cluster_swimlanes`, preserved across SKU re-records. '' = unassigned. */
  swimlane: string;
  swimlane_rationale: string;
  /** IDC-aligned performance tier within the class (entry / mainstream /
   *  performance / expert). Set by `cluster_swimlanes` alongside `swimlane`;
   *  '' = unassigned. The swimlane slug is `<class> · <tier>`. */
  tier: Tier;
}

export interface SpecRow {
  model_id: string;
  spec_key: string;
  spec_value: string;
  unit: string;
  source_url: string;
  captured_at: string;
}

export interface PriceRow {
  id: number;
  model_id: string;
  config_label: string;
  segment: PriceSegment;
  list_price: number | null;
  sale_price: number | null;
  discount_pct: number | null;
  currency: string;
  url: string;
  captured_at: string;
  captured_date: string; // YYYY-MM-DD (one point per config per segment per day)
}

/**
 * What a SINGLE OEM charges for ONE component (commodity) at a point in time —
 * the à-la-carte / configurator price. The competitive-intel value: the SAME
 * commodity (e.g. an RTX 4000 Ada) priced across Dell vs HP vs Lenovo reveals
 * each vendor's component markup. Tracked over time (one point per
 * commodity/vendor/platform/day) so the spread is queryable historically.
 * `commodity` is a NORMALIZED canonical name shared across OEMs so they compare.
 */
export interface CommodityPriceRow {
  id: number;
  commodity: string; // canonical, e.g. 'NVIDIA RTX 4000 Ada'
  commodity_class: CommodityClass;
  vendor: Vendor;
  model_id: string; // platform the option was priced within ('' if standalone)
  price: number | null; // the OEM's price for this commodity
  price_kind: string; // 'addon' | 'config_delta' | 'standalone' | 'included'
  currency: string;
  url: string;
  captured_at: string;
  captured_date: string;
}

/**
 * A competitive-radar item — a workstation-adjacent THREAT/disruptor or a
 * net-new PLAYER outside the tier-1 OEM scope. Captured so nothing relevant
 * goes unwatched, and the material ones get bubbled up (propose_action).
 */
export interface RadarItemRow {
  id: number;
  kind: RadarKind;
  name: string; // e.g. 'NVIDIA N1X', 'BOXX', 'Windows-on-ARM agentic ISV'
  vendor_name: string; // the player/maker, free text (not the tier-1 enum)
  summary: string; // what it is
  thesis: string; // why it matters / how it pressures the x86 workstation
  attacks: string; // which segment/lane it pressures (free text)
  severity: Severity;
  confidence: Confidence;
  status: string; // 'rumored' | 'announced' | 'shipping' | 'tracking'
  source_url: string;
  first_seen: string;
  last_seen: string;
}

export interface GpuOptionRow {
  model_id: string;
  gpu_name: string;
  gpu_class: GpuClass;
  vram_gb: number | null;
  tdp_w: number | null;
  source_url: string;
  captured_at: string;
}

export interface IsvCertRow {
  model_id: string; // '' = vendor-wide cert
  vendor: Vendor;
  isv_name: string;
  isv_category: IsvCategory;
  gpu_support_note: string;
  mentions_geforce: boolean;
  source_url: string;
  captured_at: string;
}

export interface CertSightingRow {
  id: number;
  registry: CertRegistry;
  cert_model_string: string;
  vendor_guess: string;
  raw_url: string;
  leaked_at: string;
  first_seen: string;
  matched_sku: string; // model_id once reconciled, else ''
  /** Launch-date cross-reference verdict. '' = not yet checked; 'pre_launch' =
   *  genuine unannounced leak; 'in_market' = already announced/shipping (drops
   *  off the leak radar). Set by reconcile_sightings_against_catalog (auto) or
   *  the reconcile_leak_radar job (web-evidence judgment). */
  market_status: '' | 'pre_launch' | 'in_market';
  market_reason: string;
  /** When the market_status verdict was last verified (ISO). A pre_launch
   *  verdict EXPIRES — the reconcile job re-verifies stale ones so a leak that
   *  launches drops off the radar on its own. '' = never verified. */
  market_checked_at: string;
  /** Best web source the verdict rests on ('' when judged without evidence). */
  evidence_url: string;
  /** Workstation class guessed from the model string (dtws/mws/rws/edge_ai) so
   *  the leak radar can be segmented by Desktop / Mobile / Rack / Edge-AI. */
  ws_class: WsClass;
}

export interface SourceSyncRow {
  etag: string | null;
  content_hash: string | null;
  synced_at: string;
  row_count: number;
}

/**
 * A clearly-labeled INFERENCE — Kristi's projection of an OEM's next-generation
 * SKU in a swimlane, extrapolated from that line's verified generational
 * lineage + public roadmap signals (`tech_push`), OR — for a `market_pull`
 * projection — from the lane's demand profiles + analyst/market signals. Kept
 * in its OWN table, never mixed into `skus`/`sku_specs`, so a hypothesis never
 * contaminates a real spec comparison (hp_z_gap_view, compare_configs). One
 * live projection per (vendor, swimlane, projection_kind) — re-projecting the
 * same kind replaces it, so a lane can hold both a tech_push and a market_pull
 * inference at once.
 */
export interface ProjectionRow {
  id: number;
  vendor: Vendor;
  swimlane: string; // e.g. 'mid-xeon-w' / 'z4-class'
  projection_kind: ProjectionKind; // 'tech_push' (supply lineage) | 'market_pull' (demand/market)
  projected_label: string; // e.g. 'HP Z4 G-next'
  basis_models: string; // csv of model_id lineage the projection extrapolates
  cpu_platform: string; // projected platform (free text — may not be an enum yet)
  key_deltas: string; // projected spec deltas vs current gen (markdown/free text)
  confidence: Confidence;
  falsifier: string; // what observation would falsify this projection
  rationale_md: string; // the reasoning
  source_urls: string; // roadmap/lineage sources grounding it
  created_at: string;
}

/**
 * Kristi's durable analytical VIEW on one pane item — the deep-think writeup the
 * Recon Desk reveals on tap (the pane's `detail_md`). One live row per
 * (subject_type, subject_key); re-writing replaces it. `subject_hash` is a hash
 * of the item's salient underlying data at assessment time, so the background
 * assessor re-writes only items that are new or have MOVED, not everything daily.
 * `sources_json` is a JSON array of {title?, url} the assessment is grounded in.
 */
export interface AssessmentRow {
  subject_type: AssessmentSubject;
  subject_key: string;
  headline: string; // one-line takeaway
  assessment_md: string; // the written deep-think view
  sources_json: string; // JSON: Array<{ title?: string; url: string }>
  confidence: Confidence;
  subject_hash: string; // hash of salient data at assessment time
  model_used: string; // 'deep' | 'standard' — which tier wrote it
  updated_at: string;
}

/** The demand-side profile kinds Kristi derives per swimlane. The lane's
 *  capability ENVELOPE answers "what can it do"; these answer "who is it for":
 *  - `persona` = the human role/seat that runs the lane's workloads.
 *  - `icp`     = the IDEAL customer profile — the org/account that should buy here.
 *  - `ucp`     = the UNIDEAL customer profile — who looks like a fit but should
 *                NOT buy this lane, plus where they actually belong (a redirect).
 *  The split is orthogonal: a UCP carries a `redirect_swimlane`; persona/ICP
 *  carry `best_fit_by_oem` + the GeForce-vs-pro call. */
export type ProfileKind = 'persona' | 'icp' | 'ucp';

/**
 * A grounded demand-side profile for one swimlane, derived by
 * `derive_swimlane_profiles` (or written by hand via `record_swimlane_profile`)
 * and surfaced as the tap-through under each lane on the Recon Desk. Lives in
 * its own table, keyed by (ws_class, swimlane, profile_kind, title) so a
 * re-derivation upserts cleanly. Every profile traces back to a real workflow's
 * compute demand (`grounded_on`) and the envelope spec that justifies the lane
 * (`capability_drivers`) — a persona Kristi can't ground is a guess, labeled
 * low-confidence with a `falsifier`.
 */
export interface SwimlaneProfileRow {
  id: number;
  ws_class: WsClass;
  swimlane: string;
  profile_kind: ProfileKind;
  title: string; // e.g. 'AEC BIM coordinator' / 'Mid-market AE firm, 50-200 seats'
  body_md: string; // the grounded writeup
  grounded_on: string; // the ISV workflow / AI use case / OEM vertical it derives from
  capability_drivers: string; // which envelope specs make this lane the fit
  segment: string; // smb|prosumer|enterprise|edu|gov ('' if n/a)
  geforce_vs_pro: string; // persona/icp: does the workload's ISV stack allow GeForce or require RTX PRO
  best_fit_by_oem: string; // persona/icp: which OEM wins this seat and why
  disqualifier: string; // ucp: the compute mismatch that makes them unideal here
  redirect_swimlane: string; // ucp: the lane they actually belong in
  redirect_reason: string; // ucp: why that lane fits them instead
  confidence: Confidence;
  falsifier: string; // what observation would prove the profile wrong
  source_urls: string; // newline-joined grounding sources
  updated_at: string;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function date_part(iso: string): string {
  return (iso || '').slice(0, 10);
}

// Comparable-spec understanding (which specs compare + how to read them
// accurately + what a delta MEANS) lives in `@specialists/kristi/spec_metrics`
// (normalizeSpec / dropSuspectOutliers). hp_z_gap_view below uses it. The old
// lead_num + first-number + TB-double-count normalize_metric is GONE — it parsed
// "4096 GB (4 TB)" as 4.2M GB, "16GB base up to 512GB" as 16, and "Memory Slots:
// 4x DDR5" as 4 GB of memory.

/**
 * CPU GENERATION + release YEAR, parsed from a CPU spec string (e.g. "Intel
 * Xeon 600 series (Granite Rapids-WS)", "AMD Threadripper Pro 7000 WX"). The
 * year is the generational guard the gap view uses: it compares only
 * contemporaries (within ~1 year), so a current-gen part (Granite Rapids, 2025)
 * is never compared to a prev-gen one (Sapphire Rapids, 2023), while a
 * cross-vendor contemporary (Threadripper Pro 7000, 2024) still compares.
 * Maintained table — add a gen + year as new platforms land. `year: null` when
 * unclassifiable (those entries don't anchor a generation window).
 */
const _CPU_GENERATIONS: Array<{ re: RegExp; label: string; year: number }> = [
  { re: /granite\s*rapids/i,            label: 'Granite Rapids',        year: 2025 },
  { re: /emerald\s*rapids/i,            label: 'Emerald Rapids',        year: 2023 },
  { re: /sapphire\s*rapids/i,           label: 'Sapphire Rapids',       year: 2023 },
  { re: /cascade\s*lake/i,              label: 'Cascade Lake',          year: 2019 },
  { re: /threadripper\s*pro\s*9\d{3}/i, label: 'Threadripper Pro 9000', year: 2025 },
  { re: /threadripper\s*pro\s*7\d{3}/i, label: 'Threadripper Pro 7000', year: 2024 },
  { re: /threadripper\s*pro\s*5\d{3}/i, label: 'Threadripper Pro 5000', year: 2022 },
  { re: /threadripper\s*pro\s*3\d{3}/i, label: 'Threadripper Pro 3000', year: 2020 },
  { re: /core\s*ultra/i,                label: 'Core Ultra',            year: 2025 },
  { re: /grace\s*blackwell|\bgb10\b/i,  label: 'Grace Blackwell',       year: 2025 },
  { re: /\bgrace\b/i,                   label: 'Grace',                 year: 2024 },
  // Intel "Xeon 6 / 600 series" IS Granite Rapids — keep last so the explicit
  // "Granite Rapids" string wins when both are present.
  { re: /xeon\s*6\b|xeon\s*6\d{2}/i,    label: 'Xeon 6 (Granite Rapids)', year: 2025 },
];
function cpu_generation(spec_value: string): { label: string; year: number | null } {
  const t = spec_value || '';
  for (const g of _CPU_GENERATIONS) if (g.re.test(t)) return { label: g.label, year: g.year };
  return { label: t.trim() || 'unknown', year: null };
}

/**
 * Canonicalize a commodity name so the SAME part matches ACROSS OEMs (HP's
 * "2TB NVMe Gen4 M.2 SSD" ≡ Dell's "M.2 2TB PCIe NVMe Class 40 SSD") while
 * genuinely-different variants stay SEPARATE. The discriminators, per the
 * household rule (model → capacity → speed):
 *   - storage: capacity + interface + GEN + form factor — a 1TB M.2 is a 1TB
 *     M.2 *until* it's Gen4 vs Gen5, then they're tracked apart.
 *   - memory: capacity + DDR type + SPEED + ECC + DIMM kind.
 *   - gpu: vendor + model + GENERATION — an RTX 6000 is an RTX 6000 *until*
 *     it's Ada vs Blackwell (the generation token is preserved; Max-Q etc. too).
 *   - cpu: each SKU is unique — left intact (only light cleanup).
 * Deterministic + stable so a commodity key holds steady over time → the
 * historical price series stays continuous. Conservative: when a class pattern
 * doesn't match, returns the cleaned original rather than risk a wrong merge.
 */
export function normalize_commodity(raw: string, klass: CommodityClass): string {
  const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const s = clean(raw);
  if (!s) return s;
  const low = s.toLowerCase();

  if (klass === 'storage') {
    const cap = low.match(/(\d+(?:\.\d+)?)\s*(tb|gb)\b/);
    if (!cap || !cap[1] || !cap[2]) return s;
    const capStr = `${cap[1]}${cap[2].toUpperCase()}`;
    const gen = low.match(/gen\s*([45])/) ?? low.match(/pcie\s*(?:gen\s*)?([45])/);
    const genStr = gen ? `Gen${gen[1]}` : '';
    const form = /m\.?2/.test(low) ? 'M.2' : /u\.?2/.test(low) ? 'U.2' : /2\.5/.test(low) ? '2.5in' : '';
    const nvme = /nvme/.test(low) ? 'NVMe' : '';
    return [capStr, nvme, genStr, form, 'SSD'].filter(Boolean).join(' ');
  }

  if (klass === 'memory') {
    const cap = low.match(/(\d+(?:\.\d+)?)\s*(tb|gb)\b/);
    if (!cap || !cap[1] || !cap[2]) return s;
    const capStr = `${cap[1]}${cap[2].toUpperCase()}`;
    const type = (low.match(/ddr[45]/) ?? [''])[0].toUpperCase();
    const sp = (low.match(/ddr[45][\s-]*(\d{4,5})/) ?? low.match(/\b(\d{4,5})\s*(?:mt\/s|mhz)/))?.[1];
    const typeStr = type ? `${type}${sp ? `-${sp}` : ''}` : '';
    const ecc = /ecc/.test(low) ? 'ECC' : '';
    const dimm = /rdimm|registered/.test(low) ? 'RDIMM' : /udimm|unbuffered/.test(low) ? 'UDIMM' : '';
    return [capStr, typeStr, ecc, dimm].filter(Boolean).join(' ');
  }

  if (klass === 'gpu') {
    let g = s.replace(/\bgraphics?\b/gi, '').replace(/\bgpu\b/gi, '').replace(/\bprofessional\b/gi, '');
    g = clean(g).replace(/nvidia/gi, 'NVIDIA').replace(/\bamd\b/gi, 'AMD');
    if (/\brtx\b/i.test(g) && !/nvidia|amd/i.test(g)) g = `NVIDIA ${g}`;
    if (/radeon/i.test(g) && !/amd/i.test(g)) g = `AMD ${g}`;
    return clean(g);
  }

  // cpu (unique SKU) + everything else: light cleanup only.
  return clean(s.replace(/\bprocessor\b/gi, '').replace(/\(.*?\)/g, ''));
}

// ── store ──────────────────────────────────────────────────────────────────

export class KristiWorkstationsStore {
  readonly db: Database;

  constructor(path: string = cache_db_path()) {
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skus (
        model_id        TEXT PRIMARY KEY,
        vendor          TEXT,
        family          TEXT,
        model_name      TEXT,
        form_factor     TEXT,
        chassis_variant TEXT,
        cpu_platform    TEXT,
        status          TEXT,
        announced_at    TEXT,
        launched_at     TEXT,
        source_url      TEXT,
        notes           TEXT,
        first_seen      TEXT,
        last_seen       TEXT,
        swimlane            TEXT DEFAULT '',
        swimlane_rationale  TEXT DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_skus_vendor ON skus(vendor);
      CREATE INDEX IF NOT EXISTS idx_skus_family ON skus(family);
      CREATE INDEX IF NOT EXISTS idx_skus_form   ON skus(form_factor);
      CREATE INDEX IF NOT EXISTS idx_skus_status ON skus(status);

      CREATE TABLE IF NOT EXISTS sku_specs (
        model_id    TEXT,
        spec_key    TEXT,
        spec_value  TEXT,
        unit        TEXT,
        source_url  TEXT,
        captured_at TEXT,
        PRIMARY KEY (model_id, spec_key)
      );
      CREATE INDEX IF NOT EXISTS idx_specs_model ON sku_specs(model_id);

      CREATE TABLE IF NOT EXISTS prices (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id      TEXT,
        config_label  TEXT,
        segment       TEXT,
        list_price    REAL,
        sale_price    REAL,
        discount_pct  REAL,
        currency      TEXT,
        url           TEXT,
        captured_at   TEXT,
        captured_date TEXT,
        UNIQUE (model_id, config_label, segment, captured_date)
      );
      CREATE INDEX IF NOT EXISTS idx_prices_model ON prices(model_id);
      CREATE INDEX IF NOT EXISTS idx_prices_date  ON prices(captured_date);

      CREATE TABLE IF NOT EXISTS commodity_prices (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        commodity       TEXT,
        commodity_class TEXT,
        vendor          TEXT,
        model_id        TEXT,
        price           REAL,
        price_kind      TEXT,
        currency        TEXT,
        url             TEXT,
        captured_at     TEXT,
        captured_date   TEXT,
        UNIQUE (commodity, vendor, model_id, captured_date)
      );
      CREATE INDEX IF NOT EXISTS idx_commodity_name  ON commodity_prices(commodity);
      CREATE INDEX IF NOT EXISTS idx_commodity_class ON commodity_prices(commodity_class);

      CREATE TABLE IF NOT EXISTS gpu_options (
        model_id    TEXT,
        gpu_name    TEXT,
        gpu_class   TEXT,
        vram_gb     REAL,
        tdp_w       REAL,
        source_url  TEXT,
        captured_at TEXT,
        PRIMARY KEY (model_id, gpu_name)
      );
      CREATE INDEX IF NOT EXISTS idx_gpu_model ON gpu_options(model_id);

      CREATE TABLE IF NOT EXISTS isv_certs (
        model_id         TEXT,
        vendor           TEXT,
        isv_name         TEXT,
        isv_category     TEXT,
        gpu_support_note TEXT,
        mentions_geforce INTEGER,
        source_url       TEXT,
        captured_at      TEXT,
        PRIMARY KEY (model_id, isv_name)
      );
      CREATE INDEX IF NOT EXISTS idx_isv_cat    ON isv_certs(isv_category);
      CREATE INDEX IF NOT EXISTS idx_isv_vendor ON isv_certs(vendor);

      CREATE TABLE IF NOT EXISTS cert_sightings (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        registry          TEXT,
        cert_model_string TEXT,
        vendor_guess      TEXT,
        raw_url           TEXT,
        leaked_at         TEXT,
        first_seen        TEXT,
        matched_sku       TEXT,
        -- '' = not yet cross-referenced; 'pre_launch' = genuine unannounced leak;
        -- 'in_market' = already announced/shipping (NOT a leak — drops off radar).
        market_status     TEXT DEFAULT '',
        market_reason     TEXT DEFAULT '',
        ws_class          TEXT DEFAULT '',
        -- verdict freshness + provenance: pre_launch verdicts expire + re-verify
        market_checked_at TEXT DEFAULT '',
        evidence_url      TEXT DEFAULT '',
        UNIQUE (registry, cert_model_string)
      );
      CREATE INDEX IF NOT EXISTS idx_cert_registry ON cert_sightings(registry);
      CREATE INDEX IF NOT EXISTS idx_cert_matched  ON cert_sightings(matched_sku);

      CREATE TABLE IF NOT EXISTS sync_meta (
        source_key   TEXT PRIMARY KEY,
        etag         TEXT,
        content_hash TEXT,
        synced_at    TEXT,
        row_count    INTEGER
      );

      -- Base unit cost: the workstation PLATFORM cost (chassis + PSU + motherboard
      -- + base margin) isolated by backing the COMMODITIES out of an OEM's base
      -- "starting" configuration price. Kristi captures the base config price + its
      -- minimal included commodities (CPU/GPU/RAM/SSD); base_unit_view() subtracts
      -- each one's observed STREET price (latest_standalone) so the residual is the
      -- platform. NOT exact (OEM marks its base commodities up over street, so the
      -- residual leans high), but cross-OEM comparable — the platform tax.
      CREATE TABLE IF NOT EXISTS base_units (
        model_id             TEXT PRIMARY KEY,
        vendor               TEXT,
        base_config_price    REAL,
        base_components_json TEXT NOT NULL DEFAULT '[]',
        confidence           TEXT DEFAULT 'medium',
        note                 TEXT DEFAULT '',
        source_url           TEXT DEFAULT '',
        captured_date        TEXT,
        updated_at           TEXT
      );

      CREATE TABLE IF NOT EXISTS projections (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        vendor          TEXT,
        swimlane        TEXT,
        projection_kind TEXT DEFAULT 'tech_push',
        projected_label TEXT,
        basis_models    TEXT,
        cpu_platform    TEXT,
        key_deltas      TEXT,
        confidence      TEXT,
        falsifier       TEXT,
        rationale_md    TEXT,
        source_urls     TEXT,
        created_at      TEXT,
        UNIQUE (vendor, swimlane, projection_kind)
      );
      CREATE INDEX IF NOT EXISTS idx_proj_swimlane ON projections(swimlane);

      CREATE TABLE IF NOT EXISTS radar_items (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        kind         TEXT,
        name         TEXT,
        vendor_name  TEXT,
        summary      TEXT,
        thesis       TEXT,
        attacks      TEXT,
        severity     TEXT,
        confidence   TEXT,
        status       TEXT,
        ws_class     TEXT DEFAULT 'all',
        source_url   TEXT,
        first_seen   TEXT,
        last_seen    TEXT,
        UNIQUE (kind, name)
      );
      CREATE INDEX IF NOT EXISTS idx_radar_kind ON radar_items(kind);
      CREATE INDEX IF NOT EXISTS idx_radar_sev  ON radar_items(severity);
      -- NOTE: idx_radar_class(ws_class) is created AFTER the ws_class ALTER
      -- below, NOT here. On an existing DB this CREATE-TABLE-IF-NOT-EXISTS block
      -- no-ops, so the column isn't added until the ALTER — referencing it here
      -- would abort the whole migrate() exec before the ALTER ever runs.

      CREATE TABLE IF NOT EXISTS assessments (
        subject_type  TEXT,
        subject_key   TEXT,
        headline      TEXT,
        assessment_md TEXT,
        sources_json  TEXT,
        confidence    TEXT,
        subject_hash  TEXT,
        model_used    TEXT,
        updated_at    TEXT,
        PRIMARY KEY (subject_type, subject_key)
      );
      CREATE INDEX IF NOT EXISTS idx_assess_type ON assessments(subject_type);

      -- Benchmark scores per CPU/GPU commodity (canonical benchmark keys from
      -- cost_model KNOWN_BENCHMARKS). Latest score per (component, benchmark) —
      -- silicon does not drift, so no time series; captured_at is provenance.
      -- Joined against street prices for the perf-per-dollar view.
      CREATE TABLE IF NOT EXISTS benchmark_scores (
        component       TEXT,
        component_class TEXT,
        benchmark       TEXT,
        score           REAL,
        source_url      TEXT,
        captured_at     TEXT,
        PRIMARY KEY (component, benchmark)
      );
      CREATE INDEX IF NOT EXISTS idx_bench_class ON benchmark_scores(component_class);

      CREATE TABLE IF NOT EXISTS swimlane_profiles (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        ws_class           TEXT,
        swimlane           TEXT,
        profile_kind       TEXT,
        title              TEXT,
        body_md            TEXT,
        grounded_on        TEXT,
        capability_drivers TEXT,
        segment            TEXT DEFAULT '',
        geforce_vs_pro     TEXT DEFAULT '',
        best_fit_by_oem    TEXT DEFAULT '',
        disqualifier       TEXT DEFAULT '',
        redirect_swimlane  TEXT DEFAULT '',
        redirect_reason    TEXT DEFAULT '',
        confidence         TEXT DEFAULT 'medium',
        falsifier          TEXT DEFAULT '',
        source_urls        TEXT DEFAULT '',
        updated_at         TEXT,
        UNIQUE (ws_class, swimlane, profile_kind, title)
      );
      CREATE INDEX IF NOT EXISTS idx_swprof_lane ON swimlane_profiles(ws_class, swimlane);
    `);
    // Forward-compat: add swimlane columns to a skus table that predates them,
    // THEN index — the column must exist before the index references it (a
    // fresh CREATE TABLE already has the columns; ALTER no-ops there).
    try { this.db.exec("ALTER TABLE skus ADD COLUMN swimlane TEXT DEFAULT '';"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE skus ADD COLUMN swimlane_rationale TEXT DEFAULT '';"); } catch { /* exists */ }
    // IDC performance tier within the class (entry/mainstream/performance/expert);
    // composed with the class into the swimlane slug. Additive — no SCHEMA_VERSION bump.
    try { this.db.exec("ALTER TABLE skus ADD COLUMN tier TEXT DEFAULT '';"); } catch { /* exists */ }
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_skus_swimlane ON skus(swimlane);'); } catch { /* column missing on a partial DB */ }
    // Forward-compat: leak-radar launch-date cross-reference columns on a
    // cert_sightings table that predates them. Un-indexed, so no index-after-ALTER
    // ordering hazard.
    try { this.db.exec("ALTER TABLE cert_sightings ADD COLUMN market_status TEXT DEFAULT '';"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE cert_sightings ADD COLUMN market_reason TEXT DEFAULT '';"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE cert_sightings ADD COLUMN ws_class TEXT DEFAULT '';"); } catch { /* exists */ }
    // Verdict freshness + provenance for the verified leak radar (2026-06-10):
    // pre_launch verdicts expire and re-verify; the evidence URL grounds each.
    try { this.db.exec("ALTER TABLE cert_sightings ADD COLUMN market_checked_at TEXT DEFAULT '';"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE cert_sightings ADD COLUMN evidence_url TEXT DEFAULT '';"); } catch { /* exists */ }
    // Forward-compat: per-class scoping for the free-standing threat/disruptor
    // radar. Defaults to 'all' (cross-class) so nothing disappears from a tab on
    // migration; the backfill then scopes only the rows with a confident class
    // keyword, leaving genuinely cross-class items visible in every tab.
    try { this.db.exec("ALTER TABLE radar_items ADD COLUMN ws_class TEXT DEFAULT 'all';"); } catch { /* exists */ }
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_radar_class ON radar_items(ws_class);'); } catch { /* column missing on a partial DB */ }
    this.backfill_radar_ws_class();
    this.migrate_projection_kind();
  }

  /** Forward-compat: add `projection_kind` to a `projections` table that
   *  predates it, AND widen its uniqueness from (vendor, swimlane) to
   *  (vendor, swimlane, projection_kind) so a lane can carry BOTH a tech_push
   *  and a market_pull projection. A table-level UNIQUE constraint can't be
   *  ALTERed in place in SQLite, so this rebuilds the table once — guarded on
   *  the column's absence (PRAGMA), so a fresh DB (whose CREATE TABLE already
   *  has the new shape) and a second run both no-op. Existing rows are stamped
   *  'tech_push' (every projection recorded before this migration was supply-
   *  side lineage). */
  private migrate_projection_kind(): void {
    const cols = this.db.prepare(`PRAGMA table_info(projections)`).all() as { name: string }[];
    if (cols.length === 0 || cols.some((c) => c.name === 'projection_kind')) return;
    this.db.exec(`
      ALTER TABLE projections RENAME TO projections_pre_kind;
      CREATE TABLE projections (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        vendor          TEXT,
        swimlane        TEXT,
        projection_kind TEXT DEFAULT 'tech_push',
        projected_label TEXT,
        basis_models    TEXT,
        cpu_platform    TEXT,
        key_deltas      TEXT,
        confidence      TEXT,
        falsifier       TEXT,
        rationale_md    TEXT,
        source_urls     TEXT,
        created_at      TEXT,
        UNIQUE (vendor, swimlane, projection_kind)
      );
      INSERT INTO projections
        (id, vendor, swimlane, projection_kind, projected_label, basis_models,
         cpu_platform, key_deltas, confidence, falsifier, rationale_md, source_urls, created_at)
      SELECT id, vendor, swimlane, 'tech_push', projected_label, basis_models,
         cpu_platform, key_deltas, confidence, falsifier, rationale_md, source_urls, created_at
      FROM projections_pre_kind;
      DROP TABLE projections_pre_kind;
      CREATE INDEX IF NOT EXISTS idx_proj_swimlane ON projections(swimlane);
    `);
  }

  /** One-time (idempotent): scope existing radar items that carry a confident
   *  class keyword in their name; leave genuinely cross-class items as 'all'.
   *  Only touches rows still at the default, and only when a signal exists, so
   *  it never overwrites a class Kristi set deliberately. */
  private backfill_radar_ws_class(): void {
    const rows = this.db
      .prepare(`SELECT id, name FROM radar_items WHERE ws_class='all' OR ws_class IS NULL OR ws_class=''`)
      .all() as { id: number; name: string }[];
    const upd = this.db.prepare(`UPDATE radar_items SET ws_class=@c WHERE id=@id`);
    for (const r of rows) {
      const c = radar_class_signal(r.name);
      if (c !== 'all') upd.run({ '@c': c, '@id': r.id });
    }
  }

  // ── sku writes ─────────────────────────────────────────────────────────────

  /** Upsert a SKU. Preserves first_seen + swimlane (clustering survives
   *  re-records); refreshes last_seen + every other field. */
  upsert_sku(row: Omit<SkuRow, 'first_seen' | 'last_seen' | 'swimlane' | 'swimlane_rationale' | 'tier'>): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO skus
           (model_id, vendor, family, model_name, form_factor, chassis_variant,
            cpu_platform, status, announced_at, launched_at, source_url, notes,
            first_seen, last_seen)
         VALUES (@id,@vendor,@family,@name,@form,@chassis,@cpu,@status,@ann,@launch,
                 @src,@notes,@now,@now)
         ON CONFLICT(model_id) DO UPDATE SET
           vendor=excluded.vendor, family=excluded.family, model_name=excluded.model_name,
           form_factor=excluded.form_factor, chassis_variant=excluded.chassis_variant,
           cpu_platform=excluded.cpu_platform, status=excluded.status,
           announced_at=excluded.announced_at, launched_at=excluded.launched_at,
           source_url=excluded.source_url, notes=excluded.notes, last_seen=excluded.last_seen`,
      )
      .run({
        '@id': row.model_id,
        '@vendor': row.vendor,
        '@family': row.family,
        '@name': row.model_name,
        '@form': row.form_factor,
        '@chassis': row.chassis_variant,
        '@cpu': row.cpu_platform,
        '@status': row.status,
        '@ann': row.announced_at,
        '@launch': row.launched_at,
        '@src': row.source_url,
        '@notes': row.notes,
        '@now': now,
      });
  }

  /**
   * Upsert one spec (latest value per model+key wins; provenance carried).
   *
   * WRITE-side plausibility gate: an absolutely-implausible COMPARABLE value
   * (a 4.2M-GB memory mis-read, a 3595-"core" CPU model number, "512 cores")
   * is REJECTED before the INSERT — `validateSpec` returns `{ ok:false }` and
   * we skip the write so garbage never enters `sku_specs` to poison the gap
   * view's subtraction. Context specs (Memory Type, Form Factor, Supported
   * CPUs…) and in-range comparables always store. Returns whether the row was
   * stored, with the rejection reason when it wasn't (callers may ignore it).
   */
  record_spec(
    model_id: string,
    spec_key: string,
    spec_value: string,
    unit: string,
    source_url: string,
  ): { stored: boolean; reason?: string } {
    const verdict = validateSpec(spec_key, spec_value, unit);
    if (!verdict.ok) {
      return { stored: false, reason: verdict.reason };
    }
    this.db
      .prepare(
        `INSERT INTO sku_specs (model_id, spec_key, spec_value, unit, source_url, captured_at)
         VALUES (@m,@k,@v,@u,@src,@ts)
         ON CONFLICT(model_id, spec_key) DO UPDATE SET
           spec_value=excluded.spec_value, unit=excluded.unit,
           source_url=excluded.source_url, captured_at=excluded.captured_at`,
      )
      .run({
        '@m': model_id,
        '@k': spec_key,
        '@v': spec_value,
        '@u': unit,
        '@src': source_url,
        '@ts': new Date().toISOString(),
      });
    return { stored: true };
  }

  /**
   * Append one price observation. At most one row per
   * (model, config_label, segment, day) so a daily scrape builds a clean
   * discount-over-time series without dupes. Re-running the same day updates
   * the day's point.
   *
   * WRITE-side plausibility gate (the pricing sibling of `record_spec`'s):
   * a whole-system price outside the sane window — a $4 "workstation" (a
   * misread component figure) or a $2M one (financing total, comma slip) —
   * is REJECTED before the INSERT so it never poisons price_history /
   * discount-over-time. USD only; non-USD rows pass (rare, and the windows
   * are dollar-calibrated). Returns whether the row stored, with the
   * rejection reason when it didn't.
   */
  record_price(p: {
    model_id: string;
    config_label: string;
    segment: PriceSegment;
    list_price: number | null;
    sale_price: number | null;
    currency?: string;
    url: string;
  }): { stored: boolean; reason?: string } {
    const now = new Date().toISOString();
    if ((p.currency ?? 'USD') === 'USD') {
      for (const [label, v] of [['list_price', p.list_price], ['sale_price', p.sale_price]] as const) {
        if (v == null) continue;
        const verdict = validate_system_price(v);
        if (!verdict.ok) return { stored: false, reason: `${label}: ${verdict.reason}` };
      }
    }
    const discount =
      p.list_price && p.list_price > 0 && p.sale_price != null
        ? Math.round((1 - p.sale_price / p.list_price) * 1000) / 10
        : null;
    this.db
      .prepare(
        `INSERT INTO prices
           (model_id, config_label, segment, list_price, sale_price, discount_pct,
            currency, url, captured_at, captured_date)
         VALUES (@m,@cfg,@seg,@list,@sale,@disc,@cur,@url,@ts,@day)
         ON CONFLICT(model_id, config_label, segment, captured_date) DO UPDATE SET
           list_price=excluded.list_price, sale_price=excluded.sale_price,
           discount_pct=excluded.discount_pct, currency=excluded.currency,
           url=excluded.url, captured_at=excluded.captured_at`,
      )
      .run({
        '@m': p.model_id,
        '@cfg': p.config_label,
        '@seg': p.segment,
        '@list': p.list_price,
        '@sale': p.sale_price,
        '@disc': discount,
        '@cur': p.currency ?? 'USD',
        '@url': p.url,
        '@ts': now,
        '@day': date_part(now),
      });
    return { stored: true };
  }

  record_gpu_option(g: {
    model_id: string;
    gpu_name: string;
    gpu_class: GpuClass;
    vram_gb: number | null;
    tdp_w: number | null;
    source_url: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO gpu_options (model_id, gpu_name, gpu_class, vram_gb, tdp_w, source_url, captured_at)
         VALUES (@m,@name,@class,@vram,@tdp,@src,@ts)
         ON CONFLICT(model_id, gpu_name) DO UPDATE SET
           gpu_class=excluded.gpu_class, vram_gb=excluded.vram_gb, tdp_w=excluded.tdp_w,
           source_url=excluded.source_url, captured_at=excluded.captured_at`,
      )
      .run({
        '@m': g.model_id,
        '@name': g.gpu_name,
        '@class': g.gpu_class,
        '@vram': g.vram_gb,
        '@tdp': g.tdp_w,
        '@src': g.source_url,
        '@ts': new Date().toISOString(),
      });
  }

  record_isv_cert(c: {
    model_id: string;
    vendor: Vendor;
    isv_name: string;
    isv_category: IsvCategory;
    gpu_support_note: string;
    mentions_geforce: boolean;
    source_url: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO isv_certs
           (model_id, vendor, isv_name, isv_category, gpu_support_note, mentions_geforce, source_url, captured_at)
         VALUES (@m,@vendor,@isv,@cat,@note,@gf,@src,@ts)
         ON CONFLICT(model_id, isv_name) DO UPDATE SET
           vendor=excluded.vendor, isv_category=excluded.isv_category,
           gpu_support_note=excluded.gpu_support_note, mentions_geforce=excluded.mentions_geforce,
           source_url=excluded.source_url, captured_at=excluded.captured_at`,
      )
      .run({
        '@m': c.model_id,
        '@vendor': c.vendor,
        '@isv': c.isv_name,
        '@cat': c.isv_category,
        '@note': c.gpu_support_note,
        '@gf': c.mentions_geforce ? 1 : 0,
        '@src': c.source_url,
        '@ts': new Date().toISOString(),
      });
  }

  // ── cert-sighting leak radar ─────────────────────────────────────────────

  /**
   * Insert a certified model-string sighting. Idempotent on
   * (registry, cert_model_string) — returns whether this was a NEW string
   * (i.e. a fresh pre-launch leak) so the scanner can surface it.
   */
  record_cert_sighting(s: {
    registry: CertRegistry;
    cert_model_string: string;
    vendor_guess?: string;
    raw_url: string;
    leaked_at?: string;
  }): { inserted: boolean } {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO cert_sightings
           (registry, cert_model_string, vendor_guess, raw_url, leaked_at, first_seen, matched_sku, ws_class)
         VALUES (@reg,@str,@vendor,@url,@leaked,@seen,'',@cls)
         ON CONFLICT(registry, cert_model_string) DO NOTHING`,
      )
      .run({
        '@reg': s.registry,
        '@str': s.cert_model_string,
        '@vendor': s.vendor_guess ?? '',
        '@url': s.raw_url,
        '@leaked': s.leaked_at ?? date_part(now),
        '@seen': now,
        '@cls': ws_class_from_nomenclature(s.cert_model_string),
      });
    return { inserted: info.changes > 0 };
  }

  /** Backfill ws_class on any sighting that predates the column (one-time,
   *  cheap, idempotent — run from the cert sweep). Returns rows updated. */
  backfill_sighting_classes(): number {
    const rows = this.db
      .prepare(`SELECT registry, cert_model_string FROM cert_sightings WHERE ws_class='' OR ws_class IS NULL`)
      .all() as { registry: CertRegistry; cert_model_string: string }[];
    let n = 0;
    const upd = this.db.prepare(`UPDATE cert_sightings SET ws_class=@c WHERE registry=@r AND cert_model_string=@s`);
    for (const r of rows) {
      upd.run({ '@c': ws_class_from_nomenclature(r.cert_model_string), '@r': r.registry, '@s': r.cert_model_string });
      n++;
    }
    return n;
  }

  /** All cert model-strings already recorded for a registry (for diffing). */
  get_cert_strings(registry: CertRegistry): Set<string> {
    const rows = this.db
      .prepare(`SELECT cert_model_string FROM cert_sightings WHERE registry=@r`)
      .all({ '@r': registry }) as { cert_model_string: string }[];
    return new Set(rows.map((r) => r.cert_model_string));
  }

  /** Mark a sighting reconciled to a known SKU (so it leaves the leak radar). */
  match_cert_sighting(registry: CertRegistry, cert_model_string: string, model_id: string): void {
    this.db
      .prepare(
        `UPDATE cert_sightings SET matched_sku=@m WHERE registry=@r AND cert_model_string=@s`,
      )
      .run({ '@m': model_id, '@r': registry, '@s': cert_model_string });
  }

  /**
   * Record the launch-date cross-reference verdict for a sighting. `in_market`
   * (already announced/shipping → not a leak) drops it off the radar;
   * `pre_launch` keeps it (a genuine unannounced certified model).
   */
  classify_cert_sighting(
    registry: CertRegistry,
    cert_model_string: string,
    market_status: 'pre_launch' | 'in_market',
    reason = '',
    evidence_url = '',
  ): void {
    this.db
      .prepare(
        `UPDATE cert_sightings SET market_status=@st, market_reason=@rsn,
                market_checked_at=@chk, evidence_url=@ev
           WHERE registry=@r AND cert_model_string=@s`,
      )
      .run({
        '@st': market_status,
        '@rsn': reason.slice(0, 280),
        '@chk': new Date().toISOString(),
        '@ev': evidence_url.slice(0, 500),
        '@r': registry,
        '@s': cert_model_string,
      });
  }

  /**
   * Pre-launch verdicts older than `days` (or never stamped) — the
   * re-verification worklist. A genuine leak eventually LAUNCHES; without
   * expiry it would sit on the radar as a "leak" forever. Oldest-checked
   * first so the most overdue re-verify first.
   */
  stale_pre_launch(days = 10, limit = 20): CertSightingRow[] {
    return this.db
      .prepare(
        `SELECT * FROM cert_sightings
           WHERE matched_sku='' AND market_status='pre_launch'
             AND (market_checked_at='' OR julianday('now') - julianday(market_checked_at) > @d)
           ORDER BY market_checked_at ASC LIMIT @lim`,
      )
      .all({ '@d': days, '@lim': limit }) as CertSightingRow[];
  }

  /**
   * Deterministic half of the launch-date cross-reference: auto-flag any
   * still-unclassified sighting whose model string clearly belongs to a SKU we
   * already track as **announced or shipping** (i.e. it has a launch date / a
   * past announce — not a pre-launch leak). Token-overlap match on the model
   * number, so "precision 9 t4" ↔ "Dell Pro Precision 9 T4". Returns how many
   * it reconciled. The off-catalog shipping lines (older Dell, all Lenovo)
   * aren't in the catalog, so the judgment pass (reconcile_leak_radar) handles
   * those; this is the cheap, always-correct first pass.
   */
  reconcile_sightings_against_catalog(): number {
    const announced = this.db
      .prepare(
        `SELECT model_id, model_name FROM skus
           WHERE status IN ('announced','shipping','eol') OR announced_at != '' OR launched_at != ''`,
      )
      .all() as { model_id: string; model_name: string }[];
    const sightings = this.db
      .prepare(`SELECT registry, cert_model_string FROM cert_sightings WHERE matched_sku='' AND market_status=''`)
      .all() as { registry: CertRegistry; cert_model_string: string }[];
    const tokenize = (s: string): Set<string> =>
      new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((t) => t.length >= 2));
    // Vendor + form-factor + filler words are NOT distinctive product LINES, so
    // they can't be the discriminator between e.g. "Pro Max" and "Pro Precision".
    const NON_LINE = new Set([
      'hp', 'dell', 'lenovo', 'nvidia', 'pro', 'tower', 'mini', 'micro', 'compact', 'sff',
      'desktop', 'mobile', 'rack', 'laptop', 'workstation', 'pc', 'gen', 'series', 'plus',
      'ultra', 'premium', 'edition', 'the', 'and', 'with',
    ]);
    // The SKU's distinctive LINE token = its longest pure-alpha (≥4) word that
    // isn't vendor/form-factor filler — e.g. "precision", "thinkstation",
    // "zbook", "fury". A cert must contain it to match, so a "pro max" string can
    // NEVER reconcile to a "pro precision 9" SKU on a shared "t2"/"t4"/"t6"
    // suffix alone (they are different product lines — the names differ on
    // purpose). When a SKU has no such token (e.g. "HP Z1 …"), fall back to the
    // digit-token test alone.
    const lineToken = (toks: Set<string>): string | null => {
      let best: string | null = null;
      for (const t of toks) {
        if (/\d/.test(t) || NON_LINE.has(t) || t.length < 4) continue;
        if (!best || t.length > best.length) best = t;
      }
      return best;
    };
    // Self-heal: re-validate EXISTING matches against the line-token guard and
    // clear any that now fail (e.g. a prior "pro max" → "pro precision 9"
    // conflation that matched on a shared t2/t4/t6 suffix before the guard
    // existed). A cleared row falls back to unmatched and is re-evaluated below /
    // classified by the judgment pass — no manual data surgery needed.
    const matched = this.db
      .prepare(
        `SELECT cs.registry, cs.cert_model_string, k.model_name
           FROM cert_sightings cs JOIN skus k ON k.model_id = cs.matched_sku
          WHERE cs.matched_sku != ''`,
      )
      .all() as { registry: CertRegistry; cert_model_string: string; model_name: string }[];
    const clearMatch = this.db.prepare(
      `UPDATE cert_sightings SET matched_sku='' WHERE registry=@r AND cert_model_string=@s`,
    );
    for (const mrow of matched) {
      const line = lineToken(tokenize(mrow.model_name));
      if (line && !tokenize(mrow.cert_model_string).has(line)) {
        clearMatch.run({ '@r': mrow.registry, '@s': mrow.cert_model_string });
      }
    }
    let n = 0;
    for (const sgt of sightings) {
      const st = tokenize(sgt.cert_model_string);
      for (const a of announced) {
        const at = tokenize(a.model_name);
        // Require the distinctive model-number-ish tokens (digit-bearing) to all
        // be present, so "precision 7960" doesn't match "Precision 9 T4".
        const numTokens = [...at].filter((t) => /\d/.test(t));
        if (numTokens.length === 0) continue;
        if (!numTokens.every((t) => st.has(t))) continue;
        // Line-token guard: if the SKU names a distinct product line, the cert
        // must carry that exact line word — blocks cross-line conflation.
        const line = lineToken(at);
        if (line && !st.has(line)) continue;
        if ([...at].some((t) => st.has(t) && /[a-z]/.test(t))) {
          this.match_cert_sighting(sgt.registry, sgt.cert_model_string, a.model_id);
          n++;
          break;
        }
      }
    }
    return n;
  }

  /**
   * Sightings still needing the judgment cross-reference: not matched to a SKU
   * and not yet launch-date-classified. Fed to the reconcile_leak_radar job.
   */
  unclassified_sightings(limit = 40): CertSightingRow[] {
    return this.db
      .prepare(
        `SELECT * FROM cert_sightings
           WHERE matched_sku='' AND market_status='' ORDER BY first_seen DESC LIMIT @lim`,
      )
      .all({ '@lim': limit }) as CertSightingRow[];
  }

  /**
   * Pre-launch leak radar: ONLY sightings VERIFIED as pre-launch — not matched
   * to a known SKU, and positively classified `pre_launch` by the reconcile
   * pass (catalog cross-reference + web-evidence judgment). An unverified
   * sighting is NOT a leak yet — it surfaces as a `pending` count
   * (cert_watch_counts), never as a radar row, so an already-shipping machine
   * the judge hasn't reached can't masquerade as a leak. Newest first.
   * Optionally scoped to one workstation class for the Recon Desk's tabs.
   */
  leak_radar(limit = 12, ws_class?: WsClass): CertSightingRow[] {
    const clause = ws_class ? ' AND ws_class=@cls' : '';
    return this.db
      .prepare(
        `SELECT * FROM cert_sightings
           WHERE matched_sku='' AND market_status = 'pre_launch'${clause}
           ORDER BY first_seen DESC LIMIT @lim`,
      )
      .all(ws_class ? { '@lim': limit, '@cls': ws_class } : { '@lim': limit }) as CertSightingRow[];
  }

  /** Count of VERIFIED pre-launch leaks per workstation class — drives the
   *  class-tab badges on the Recon Desk. */
  leak_counts_by_class(): Record<WsClass, number> {
    const rows = this.db
      .prepare(
        `SELECT ws_class AS cls, COUNT(*) AS n FROM cert_sightings
           WHERE matched_sku='' AND market_status = 'pre_launch' GROUP BY ws_class`,
      )
      .all() as { cls: string; n: number }[];
    const out: Record<WsClass, number> = { dtws: 0, mws: 0, rws: 0, edge_ai: 0, other: 0 };
    for (const r of rows) {
      const c = (r.cls || 'dtws') as WsClass;
      if (c in out) out[c] = r.n;
    }
    return out;
  }

  /** Coverage for one class's leak-radar "proof of life" empty state: how many
   *  cert strings are being watched, how many are accounted for (matched to a
   *  known SKU or classified already-shipping), and how many are PENDING
   *  verification (seen, not yet judged) — so an empty radar reads as "all
   *  clear, here's the coverage" rather than "dead feature", and a stuck
   *  reconcile job is visible as a growing pending count. */
  cert_watch_counts(ws_class: WsClass): { watching: number; accounted: number; pending: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS watching,
                SUM(CASE WHEN matched_sku!='' OR market_status='in_market' THEN 1 ELSE 0 END) AS accounted,
                SUM(CASE WHEN matched_sku='' AND market_status='' THEN 1 ELSE 0 END) AS pending
           FROM cert_sightings WHERE ws_class=@c`,
      )
      .get({ '@c': ws_class }) as { watching: number; accounted: number | null; pending: number | null };
    return { watching: r.watching ?? 0, accounted: r.accounted ?? 0, pending: r.pending ?? 0 };
  }

  /** Same coverage counts, all classes — the leak_radar tool's honesty header
   *  ("N verified leaks, M sightings awaiting verification, K accounted"). */
  cert_watch_totals(): { watching: number; accounted: number; pending: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS watching,
                SUM(CASE WHEN matched_sku!='' OR market_status='in_market' THEN 1 ELSE 0 END) AS accounted,
                SUM(CASE WHEN matched_sku='' AND market_status='' THEN 1 ELSE 0 END) AS pending
           FROM cert_sightings`,
      )
      .get() as { watching: number; accounted: number | null; pending: number | null };
    return { watching: r.watching ?? 0, accounted: r.accounted ?? 0, pending: r.pending ?? 0 };
  }

  count_new_leaks(since_iso: string): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM cert_sightings WHERE first_seen >= @s`)
      .get({ '@s': since_iso }) as { n: number };
    return r.n;
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  get_sku(model_id: string): SkuRow | null {
    const r = this.db
      .prepare(`SELECT * FROM skus WHERE model_id=@m`)
      .get({ '@m': model_id }) as SkuRow | undefined;
    return r ?? null;
  }

  find_skus(filter: {
    vendor?: Vendor;
    family?: string;
    form_factor?: FormFactor;
    ws_class?: WsClass;
    status?: SkuStatus;
    limit?: number;
  } = {}): SkuRow[] {
    const where: string[] = [];
    const params: Record<string, string | number | null> = { '@lim': filter.limit ?? 50 };
    if (filter.vendor) { where.push('vendor=@vendor'); params['@vendor'] = filter.vendor; }
    if (filter.family) { where.push('family LIKE @family'); params['@family'] = `%${filter.family}%`; }
    if (filter.form_factor) { where.push('form_factor=@form'); params['@form'] = filter.form_factor; }
    // A whole workstation class spans several form factors — `form_factor IN
    // (...)`. Values come from the FormFactor enum (not user input), so the
    // inlined list is injection-safe. `form_factor` (exact) wins if both given.
    else if (filter.ws_class) {
      const ffs = form_factors_for_class(filter.ws_class).map((f) => `'${f}'`).join(',');
      where.push(`form_factor IN (${ffs})`);
    }
    if (filter.status) { where.push('status=@status'); params['@status'] = filter.status; }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM skus ${clause} ORDER BY vendor, family, model_name LIMIT @lim`)
      .all(params) as SkuRow[];
  }

  specs_for(model_id: string): SpecRow[] {
    return this.db
      .prepare(`SELECT * FROM sku_specs WHERE model_id=@m ORDER BY spec_key`)
      .all({ '@m': model_id }) as SpecRow[];
  }

  gpu_options_for(model_id: string): GpuOptionRow[] {
    return this.db
      .prepare(`SELECT * FROM gpu_options WHERE model_id=@m ORDER BY gpu_class, gpu_name`)
      .all({ '@m': model_id }) as GpuOptionRow[];
  }

  isv_certs_for(filter: { model_id?: string; category?: IsvCategory; vendor?: Vendor } = {}): IsvCertRow[] {
    const where: string[] = [];
    const params: Record<string, string | number | null> = {};
    if (filter.model_id) { where.push('model_id=@m'); params['@m'] = filter.model_id; }
    if (filter.category) { where.push('isv_category=@cat'); params['@cat'] = filter.category; }
    if (filter.vendor) { where.push('vendor=@vendor'); params['@vendor'] = filter.vendor; }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM isv_certs ${clause} ORDER BY isv_category, isv_name`)
      .all(params) as (Omit<IsvCertRow, 'mentions_geforce'> & { mentions_geforce: number })[];
    return rows.map((r) => ({ ...r, mentions_geforce: r.mentions_geforce === 1 }));
  }

  /** Full price history for a SKU (optionally one config), oldest → newest. */
  price_history(model_id: string, config_label?: string): PriceRow[] {
    const params: Record<string, string | number | null> = { '@m': model_id };
    let clause = 'WHERE model_id=@m';
    if (config_label) { clause += ' AND config_label=@cfg'; params['@cfg'] = config_label; }
    return this.db
      .prepare(`SELECT * FROM prices ${clause} ORDER BY captured_date ASC, config_label ASC`)
      .all(params) as PriceRow[];
  }

  /** Latest price per (config, segment) for a SKU. */
  latest_prices(model_id: string): PriceRow[] {
    return this.db
      .prepare(
        `SELECT p.* FROM prices p
           JOIN (SELECT config_label, segment, MAX(captured_date) AS d
                   FROM prices WHERE model_id=@m
                  GROUP BY config_label, segment) latest
             ON p.config_label=latest.config_label
            AND p.segment=latest.segment
            AND p.captured_date=latest.d
          WHERE p.model_id=@m
          ORDER BY p.config_label, p.segment`,
      )
      .all({ '@m': model_id }) as PriceRow[];
  }

  count_price_moves(since_iso: string): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM prices WHERE captured_at >= @s`)
      .get({ '@s': since_iso }) as { n: number };
    return r.n;
  }

  /**
   * Assemble a comparison across SKUs: each SKU with its specs (keyed),
   * top GPU options, and latest price points. The caller (LLM / pane)
   * frames the apples-to-apples narrative; this just gathers the rows.
   */
  compare_configs(model_ids: string[]): Array<{
    sku: SkuRow;
    specs: Record<string, string>;
    gpu_options: GpuOptionRow[];
    latest_prices: PriceRow[];
  }> {
    const out: Array<{
      sku: SkuRow;
      specs: Record<string, string>;
      gpu_options: GpuOptionRow[];
      latest_prices: PriceRow[];
    }> = [];
    for (const id of model_ids) {
      const sku = this.get_sku(id);
      if (!sku) continue;
      const specs: Record<string, string> = {};
      for (const s of this.specs_for(id)) {
        specs[s.spec_key] = s.unit ? `${s.spec_value} ${s.unit}`.trim() : s.spec_value;
      }
      out.push({
        sku,
        specs,
        gpu_options: this.gpu_options_for(id),
        latest_prices: this.latest_prices(id),
      });
    }
    return out;
  }

  /**
   * HP Z competitive-advantage / gap view — **lane-aware**. Compares HP's best
   * value against the best non-HP value WITHIN THE SAME SWIMLANE (Kristi's
   * capability-envelope cluster), and ONLY for whitelisted, unit-normalized
   * scalar metrics (cores / threads / GPUs / memory-GB / PCIe lanes / PSU-W /
   * sockets) — see `normalize_metric`.
   *
   * Why per-lane: the old global-max-vs-global-max paired whatever HP SKU held
   * the highest scraped value against whatever rival did — e.g. an expert-lane
   * *previous-gen* HP Z8 G5 (Sapphire Rapids, 64 cores) against a mid-lane
   * *current-gen* Dell Pro Precision 9 T4 (Granite Rapids, 86 cores), printing a
   * misleading "HP is 22 cores behind." Constraining to one lane keeps the
   * comparison apples-to-apples, and each side carries its `cpu_platform` so any
   * residual cross-generation pairing is VISIBLE in the assessment, not hidden.
   * Unclustered SKUs (no swimlane yet) are skipped — they have no lane peer.
   *
   * `spec_key` holds the canonical metric label (e.g. "Max memory (GB)").
   * lead>0 = HP ahead in that lane, lead<0 = HP gap. Specs that aren't a
   * comparable metric (CPU model, price, free text) are skipped, so it never
   * compares e.g. Threadripper-7000 vs Xeon-600 model numbers.
   */
  hp_z_gap_view(ws_class_filter?: WsClass): Array<{
    ws_class: WsClass;
    swimlane: string;
    spec_key: string;
    hp_best: number | null;
    hp_model: string;
    hp_platform: string;
    rival_best: number | null;
    rival_model: string;
    rival_platform: string;
    lead: number | null;
    meaning: string;
    suspect: boolean;
  }> {
    // CPU GENERATION per model (the generational guard). The `cpu_platform`
    // column is only a coarse enum (xeon_w / threadripper_pro) — the actual
    // generation (Sapphire vs Granite Rapids) lives in the CPU spec, so we read
    // it from there and classify it to a generation + RELEASE YEAR.
    const cpuByModel = new Map<string, { label: string; year: number | null }>();
    const cpuRows = this.db
      .prepare(
        `SELECT model_id, spec_value FROM sku_specs
           WHERE lower(spec_key) IN ('cpu','processor','processors','cpu platform','supported cpus')`,
      )
      .all() as { model_id: string; spec_value: string }[];
    for (const r of cpuRows) {
      const g = cpu_generation(r.spec_value);
      const prior = cpuByModel.get(r.model_id);
      // Prefer a classified generation (with a year) over an unclassified one.
      if (!prior || (prior.year === null && g.year !== null)) cpuByModel.set(r.model_id, g);
    }

    const rows = this.db
      .prepare(
        `SELECT s.spec_key, s.spec_value, s.unit, k.model_id, k.vendor, k.model_name, k.cpu_platform, k.swimlane, k.form_factor
           FROM sku_specs s JOIN skus k ON k.model_id = s.model_id`,
      )
      .all() as {
      spec_key: string;
      spec_value: string;
      unit: string;
      model_id: string;
      vendor: string;
      model_name: string;
      cpu_platform: string;
      swimlane: string;
      form_factor: FormFactor;
    }[];

    // Group by (CLASS, swimlane, metric); collect every candidate entry with its
    // CPU generation + year, then within each group apply a GENERATION WINDOW so
    // HP and the rival are only compared if they're contemporaries.
    interface Entry { vendor: string; value: number; model: string; gen: string; year: number | null }
    const groups = new Map<
      string,
      { ws_class: WsClass; swimlane: string; metric: string; metric_key: string; meaning: string; entries: Entry[] }
    >();
    for (const r of rows) {
      if (!r.swimlane) continue; // only compare within an assigned lane
      const cls = ws_class_from_form_factor(r.form_factor);
      if (cls === 'other') continue; // standalone parts have no class peer
      if (ws_class_filter && cls !== ws_class_filter) continue;
      // Unit-anchored, plausibility-validated read (a CPU model number can't
      // pose as the core count; "4096 GB (4 TB)" is 4096 not 4.2M; an
      // implausible value is dropped as a mis-read). See spec_metrics.ts.
      const nm = normalizeSpec(r.spec_key, r.spec_value, r.unit);
      if (!nm) continue;
      const cpu = cpuByModel.get(r.model_id) ?? { label: r.cpu_platform, year: null };
      const gkey = `${cls}::${r.swimlane}::${nm.key}`;
      const g =
        groups.get(gkey) ??
        { ws_class: cls, swimlane: r.swimlane, metric: nm.label, metric_key: nm.key, meaning: nm.meaning, entries: [] };
      g.entries.push({ vendor: r.vendor, value: nm.value, model: r.model_name, gen: cpu.label, year: cpu.year });
      groups.set(gkey, g);
    }

    const out: Array<{
      ws_class: WsClass; swimlane: string; spec_key: string;
      hp_best: number | null; hp_model: string; hp_platform: string;
      rival_best: number | null; rival_model: string; rival_platform: string;
      lead: number | null;
      /** What this metric's delta MEANS for a workload (from the metric registry). */
      meaning: string;
      /** A same-lane value was dropped as suspect bad data before comparing. */
      suspect: boolean;
    }> = [];
    for (const g of groups.values()) {
      // Generation window: compare ONLY the newest generation present (and
      // within 1 year of it). A current-gen part (Granite Rapids, 2025) never
      // gets compared to a prev-gen one (Sapphire Rapids, 2023); a cross-vendor
      // contemporary (Threadripper Pro 7000, 2024) still does. If no entry has a
      // known year, fall back to comparing as-is (best effort).
      const years = g.entries.map((e) => e.year).filter((y): y is number => y !== null);
      let pool = g.entries;
      if (years.length) {
        const maxY = Math.max(...years);
        pool = g.entries.filter((e) => e.year !== null && e.year >= maxY - 1);
      }
      // Drop same-lane values far below their peers as suspect bad data (e.g. a
      // mid/expert tower mis-recorded with "8 max cores" or "64GB max memory"),
      // so the view never prints a confident lead off a mis-read.
      const { kept, suspect } = dropSuspectOutliers(pool, g.metric_key);
      const hp = kept.filter((e) => e.vendor === 'hp').sort((a, b) => b.value - a.value)[0];
      const rival = kept.filter((e) => e.vendor !== 'hp').sort((a, b) => b.value - a.value)[0];
      if (!hp || !rival) continue;
      out.push({
        ws_class: g.ws_class,
        swimlane: g.swimlane,
        spec_key: g.metric,
        hp_best: hp.value,
        hp_model: hp.model,
        hp_platform: hp.gen, // the real CPU generation (e.g. "Granite Rapids"), not the enum
        rival_best: rival.value,
        rival_model: rival.model,
        rival_platform: rival.gen,
        lead: hp.value - rival.value,
        meaning: g.meaning,
        suspect,
      });
    }
    return out.sort(
      (a, b) =>
        a.ws_class.localeCompare(b.ws_class) ||
        a.swimlane.localeCompare(b.swimlane) ||
        a.spec_key.localeCompare(b.spec_key),
    );
  }

  // ── per-source sync bookkeeping (conditional/diff fetch) ─────────────────

  get_source_sync(source_key: string): SourceSyncRow | null {
    const r = this.db
      .prepare(`SELECT etag, content_hash, synced_at, row_count FROM sync_meta WHERE source_key=@k`)
      .get({ '@k': source_key }) as SourceSyncRow | undefined;
    return r ?? null;
  }

  record_source_sync(
    source_key: string,
    meta: { etag?: string | null; content_hash?: string | null; row_count?: number } = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO sync_meta (source_key, etag, content_hash, synced_at, row_count)
         VALUES (@k,@e,@h,@ts,@c)
         ON CONFLICT(source_key) DO UPDATE SET
           etag=excluded.etag, content_hash=excluded.content_hash,
           synced_at=excluded.synced_at, row_count=excluded.row_count`,
      )
      .run({
        '@k': source_key,
        '@e': meta.etag ?? null,
        '@h': meta.content_hash ?? null,
        '@ts': new Date().toISOString(),
        '@c': meta.row_count ?? 0,
      });
  }
  // ── swimlanes (capability-envelope clustering) ───────────────────────────

  /** Assign a SKU's competitive swimlane + IDC tier (written by
   *  cluster_swimlanes). The slug is `<class> · <tier>`; `tier` is stored
   *  separately so coverage gaps can be computed per (class × vendor × tier). */
  set_swimlane(model_id: string, swimlane: string, rationale: string, tier: Tier = ''): void {
    this.db
      .prepare(`UPDATE skus SET swimlane=@s, swimlane_rationale=@r, tier=@t WHERE model_id=@m`)
      .run({ '@s': swimlane, '@r': rationale, '@t': tier, '@m': model_id });
  }

  /** Recorded-SKU coverage per (class × vendor × tier) — the map Kristi reads to
   *  see which cells are EMPTY and record net-new models into the gaps instead of
   *  re-confirming flagships. Every (class × vendor) cell that SHOULD have models
   *  is emitted even at count 0 (a 0 is the signal). Tracked vendors per class are
   *  the tier-1 OEMs that compete there; `nvidia` only in edge-ai. */
  coverage_summary(): Array<{
    ws_class: WsClass;
    ws_class_label: string;
    vendor: Vendor;
    tier: Tier;
    count: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT vendor, form_factor, COALESCE(NULLIF(tier,''),'') AS tier, COUNT(*) AS n
           FROM skus GROUP BY vendor, form_factor, tier`,
      )
      .all() as { vendor: Vendor; form_factor: FormFactor; tier: Tier; n: number }[];
    // Roll observed rows up to (class × vendor × tier).
    const have = new Map<string, number>();
    for (const r of rows) {
      const cls = ws_class_from_form_factor(r.form_factor);
      const key = `${cls} ${r.vendor} ${r.tier}`;
      have.set(key, (have.get(key) ?? 0) + r.n);
    }
    // Emit the EXPECTED cells (so a 0 surfaces), plus any observed cell not in the
    // expected grid (e.g. a net-new vendor). Expected: the three tier-1 OEMs ×
    // {dtws, mws} × the four tiers; rack/edge tracked at class-vendor level (tier
    // blank). nvidia/edge-ai is its own untiered cell.
    const TIERS: Tier[] = ['entry', 'mainstream', 'performance', 'expert'];
    const OEMS: Vendor[] = ['hp', 'dell', 'lenovo'];
    const out: Array<{ ws_class: WsClass; ws_class_label: string; vendor: Vendor; tier: Tier; count: number }> = [];
    const emitted = new Set<string>();
    const push = (cls: WsClass, vendor: Vendor, tier: Tier) => {
      const key = `${cls} ${vendor} ${tier}`;
      emitted.add(key);
      out.push({ ws_class: cls, ws_class_label: ws_class_label(cls), vendor, tier, count: have.get(key) ?? 0 });
    };
    for (const cls of ['dtws', 'mws'] as WsClass[]) {
      for (const v of OEMS) for (const t of TIERS) push(cls, v, t);
    }
    for (const v of OEMS) push('rws', v, '');
    push('edge_ai', 'nvidia', '');
    // Any observed cell outside the expected grid — surfaces a genuinely new
    // vendor / tier / class so it isn't silently dropped from the coverage view.
    for (const [key, n] of have) {
      if (emitted.has(key)) continue;
      const [cls, vendor, tier] = key.split(' ') as [WsClass, Vendor, Tier];
      out.push({ ws_class: cls, ws_class_label: ws_class_label(cls), vendor, tier, count: n });
    }
    return out;
  }

  /** SKUs grouped by derived swimlane (lane → cross-OEM members). Unassigned
   *  SKUs collect under the '' lane. */
  swimlane_view(ws_class?: WsClass): Array<{
    swimlane: string;
    members: Array<{ model_id: string; vendor: string; model_name: string }>;
  }> {
    // Class filter via `form_factor IN (...)`; values are FormFactor enums, not
    // user input, so the inlined list is injection-safe.
    const clause = ws_class
      ? `WHERE form_factor IN (${form_factors_for_class(ws_class).map((f) => `'${f}'`).join(',')})`
      : '';
    const rows = this.db
      .prepare(`SELECT swimlane, model_id, vendor, model_name FROM skus ${clause} ORDER BY swimlane, vendor, model_name`)
      .all() as { swimlane: string; model_id: string; vendor: string; model_name: string }[];
    const by = new Map<string, Array<{ model_id: string; vendor: string; model_name: string }>>();
    for (const r of rows) {
      const lane = r.swimlane || '';
      if (!by.has(lane)) by.set(lane, []);
      by.get(lane)!.push({ model_id: r.model_id, vendor: r.vendor, model_name: r.model_name });
    }
    return [...by.entries()].map(([swimlane, members]) => ({ swimlane, members }));
  }

  // ── commodity (component) prices per OEM ─────────────────────────────────

  /** Append one commodity price observation (one point per
   *  commodity/vendor/platform/day). `commodity` must be a NORMALIZED canonical
   *  name so the same part compares across OEMs. */
  /**
   * Record one per-OEM (or standalone market) commodity price observation.
   *
   * WRITE-side plausibility gate (mirrors `record_spec`): a price outside its
   * class's absolute USD window, OR >4×/<¼ its own series' recent median (a
   * decimal-shift / misread, never a real one-day move), is REJECTED before
   * the INSERT — garbage never reaches commodity_compare / premium_view /
   * the base-unit backout / the trend fits. The relative gate needs ≥2 prior
   * points, so a single bad seed can't lock a series shut. USD only.
   * Returns whether the row stored, with the reason when it didn't.
   */
  record_commodity_price(c: {
    commodity: string;
    commodity_class: CommodityClass;
    vendor: Vendor;
    model_id?: string;
    price: number | null;
    price_kind?: string;
    currency?: string;
    url: string;
  }): { stored: boolean; reason?: string } {
    const now = new Date().toISOString();
    // Canonicalize at the single write chokepoint so every source
    // (drive_configurator / acquire_pricing / lookup_market_prices) converges
    // on one key per part → cross-OEM matching + a continuous price history.
    const commodity = normalize_commodity(c.commodity, c.commodity_class);
    if (c.price != null && (c.currency ?? 'USD') === 'USD') {
      const reference = this._recent_price_reference(commodity, c.vendor, c.price_kind ?? 'addon', date_part(now));
      // A $0 'included' base option is a legitimate observation, not a price —
      // only gate real (positive) prices. The canonical name enables the
      // per-GB floor for memory/storage (first-observation misread defense).
      const verdict =
        c.price === 0 && (c.price_kind ?? 'addon') === 'included'
          ? { ok: true as const }
          : validate_commodity_price(c.commodity_class, c.price, reference, commodity);
      if (!verdict.ok) return { stored: false, reason: `${commodity}: ${verdict.reason}` };
    }
    this.db
      .prepare(
        `INSERT INTO commodity_prices
           (commodity, commodity_class, vendor, model_id, price, price_kind, currency, url, captured_at, captured_date)
         VALUES (@c,@cls,@v,@m,@p,@kind,@cur,@url,@ts,@day)
         ON CONFLICT(commodity, vendor, model_id, captured_date) DO UPDATE SET
           commodity_class=excluded.commodity_class, price=excluded.price,
           price_kind=excluded.price_kind, currency=excluded.currency,
           url=excluded.url, captured_at=excluded.captured_at`,
      )
      .run({
        '@c': commodity,
        '@cls': c.commodity_class,
        '@v': c.vendor,
        '@m': c.model_id ?? '',
        '@p': c.price,
        '@kind': c.price_kind ?? 'addon',
        '@cur': c.currency ?? 'USD',
        '@url': c.url,
        '@ts': now,
        '@day': date_part(now),
      });
    return { stored: true };
  }

  /** Recent-history reference for the relative outlier gate: median of the
   *  most recent ≤5 distinct-day points of the SAME series (commodity +
   *  vendor + price_kind) within 120 days, EXCLUDING today's point (so a
   *  same-day re-record can't reference itself). */
  private _recent_price_reference(
    commodity: string,
    vendor: Vendor,
    price_kind: string,
    today: string,
  ): { median: number; n: number } | null {
    const rows = this.db
      .prepare(
        `SELECT price FROM commodity_prices
          WHERE commodity=@c AND vendor=@v AND price_kind=@k AND price IS NOT NULL
            AND captured_date < @today
            AND julianday(@today) - julianday(captured_date) <= 120
          ORDER BY captured_date DESC LIMIT 5`,
      )
      .all({ '@c': commodity, '@v': vendor, '@k': price_kind, '@today': today }) as { price: number }[];
    const m = median(rows.map((r) => r.price));
    return m != null ? { median: m, n: rows.length } : null;
  }

  /** Latest price per (vendor, model) for a commodity — the per-OEM spread
   *  ("RTX 4000 Ada: Dell $X, HP $Z"), cheapest first. */
  commodity_compare(commodity: string): Array<{
    vendor: string;
    model_id: string;
    price: number | null;
    currency: string;
    captured_date: string;
    url: string;
  }> {
    return this.db
      .prepare(
        `SELECT cp.vendor, cp.model_id, cp.price, cp.currency, cp.captured_date, cp.url
           FROM commodity_prices cp
           JOIN (SELECT vendor, model_id, MAX(captured_date) AS d
                   FROM commodity_prices WHERE commodity=@c GROUP BY vendor, model_id) latest
             ON cp.vendor=latest.vendor AND cp.model_id=latest.model_id AND cp.captured_date=latest.d
          WHERE cp.commodity=@c
          ORDER BY cp.price ASC NULLS LAST`,
      )
      .all({ '@c': commodity }) as Array<{
      vendor: string; model_id: string; price: number | null; currency: string; captured_date: string; url: string;
    }>;
  }

  /** Full price history for a commodity (optionally one vendor), oldest→newest. */
  commodity_history(commodity: string, vendor?: Vendor): CommodityPriceRow[] {
    const params: Record<string, string> = { '@c': commodity };
    let clause = 'WHERE commodity=@c';
    if (vendor) { clause += ' AND vendor=@v'; params['@v'] = vendor; }
    return this.db
      .prepare(`SELECT * FROM commodity_prices ${clause} ORDER BY captured_date ASC, vendor`)
      .all(params) as CommodityPriceRow[];
  }

  list_commodities(commodity_class?: CommodityClass): string[] {
    const params: Record<string, string> = {};
    const clause = commodity_class ? 'WHERE commodity_class=@cls' : '';
    if (commodity_class) params['@cls'] = commodity_class;
    return (
      this.db
        .prepare(`SELECT DISTINCT commodity FROM commodity_prices ${clause} ORDER BY commodity`)
        .all(params) as { commodity: string }[]
    ).map((r) => r.commodity);
  }

  /** Pane helper: commodities priced across the most OEMs, with each vendor's
   *  latest price — drives the room's "commodity price spread" section. */
  commodity_spread(limit = 6, ws_class?: WsClass): Array<{
    commodity: string;
    commodity_class: string;
    vendors: Array<{ vendor: string; price: number | null }>;
  }> {
    // Optionally scope to commodities priced WITHIN a model of this class (a
    // DTWS GPU option vs an MWS one) by joining the SKU's form_factor.
    const ffIn = ws_class
      ? form_factors_for_class(ws_class).map((f) => `'${f}'`).join(',')
      : '';
    const sql = ws_class
      ? `SELECT cp.commodity AS commodity, cp.commodity_class AS commodity_class, COUNT(DISTINCT cp.vendor) AS nv
           FROM commodity_prices cp JOIN skus k ON k.model_id = cp.model_id
          WHERE k.form_factor IN (${ffIn})
          GROUP BY cp.commodity ORDER BY nv DESC, cp.commodity LIMIT @lim`
      : `SELECT commodity, commodity_class, COUNT(DISTINCT vendor) AS nv
           FROM commodity_prices GROUP BY commodity ORDER BY nv DESC, commodity LIMIT @lim`;
    const names = this.db
      .prepare(sql)
      .all({ '@lim': limit }) as { commodity: string; commodity_class: string; nv: number }[];
    return names.map((n) => ({
      commodity: n.commodity,
      commodity_class: n.commodity_class,
      vendors: this.commodity_compare(n.commodity).map((r) => ({ vendor: r.vendor, price: r.price })),
    }));
  }

  // ── market price vs OEM configurator delta (the markup signal) ───────────
  //
  // A configurator shows `+$X` over the included base option, NOT the part's
  // absolute — and OEMs mark components up well above street (HP's RTX PRO 6000
  // delta +$10,907 vs ~$8,500 street), non-linearly, so you CANNOT back out an
  // OEM absolute from a street anchor. The honest, useful inference instead:
  // capture the OBSERVED market street/MSRP absolute per commodity (a standalone
  // row, vendor-agnostic) and surface it NEXT TO each OEM's delta — the premium
  // is the insight, and it tracks the NAND/DRAM/VRAM spike directly.

  /** Distinct commodities (with class) that have an OEM configurator delta OR
   *  ride INCLUDED in a base config — the worklist for market-price lookup.
   *  'included' matters: those are the base-unit backout's components, and
   *  without street prices the platform residuals never tighten (live finding,
   *  2026-06-10 — base CPUs/RAM/SSDs sat unpriced forever). */
  delta_commodities(classes?: CommodityClass[]): Array<{ commodity: string; commodity_class: CommodityClass }> {
    let clause = "WHERE price_kind IN ('config_delta','addon','included') AND vendor IN ('hp','dell','lenovo')";
    const params: Record<string, string> = {};
    if (classes && classes.length) {
      clause += ` AND commodity_class IN (${classes.map((_, i) => `@c${i}`).join(',')})`;
      classes.forEach((c, i) => { params[`@c${i}`] = c; });
    }
    // Constrained classes FIRST (memory/storage/gpu — the AI-server NAND/DRAM/
    // VRAM squeeze), then CPU (needed to back the base unit out of the platform),
    // then PSU/cooling/etc.
    return this.db
      .prepare(
        `SELECT DISTINCT commodity, commodity_class FROM commodity_prices ${clause}
          ORDER BY CASE commodity_class
                     WHEN 'memory' THEN 0 WHEN 'storage' THEN 1 WHEN 'gpu' THEN 2 WHEN 'cpu' THEN 3 ELSE 4 END,
                   commodity_class, commodity`,
      )
      .all(params) as Array<{ commodity: string; commodity_class: CommodityClass }>;
  }

  /** Daily price series for a commodity, for charting. Aggregates to the MIN
   *  price per captured_date (collapses multiple model_ids / configurator
   *  options the same day) so a sparkline gets ONE clean point per day,
   *  ascending. Filter by vendor and/or price_kind(s); `limit` keeps only the
   *  most recent N points. This is the point-in-time history each change is
   *  recorded into (one row per commodity/vendor/model/day, upserted). */
  price_series(
    commodity: string,
    opts: { vendor?: Vendor; price_kinds?: string[]; limit?: number } = {},
  ): Array<{ date: string; price: number }> {
    const where: string[] = ['commodity=@c', 'price IS NOT NULL'];
    const params: Record<string, string> = { '@c': commodity };
    if (opts.vendor) { where.push('vendor=@v'); params['@v'] = opts.vendor; }
    if (opts.price_kinds && opts.price_kinds.length) {
      where.push(`price_kind IN (${opts.price_kinds.map((_, i) => `@k${i}`).join(',')})`);
      opts.price_kinds.forEach((k, i) => { params[`@k${i}`] = k; });
    }
    const rows = this.db
      .prepare(
        `SELECT captured_date AS date, MIN(price) AS price FROM commodity_prices
          WHERE ${where.join(' AND ')}
          GROUP BY captured_date ORDER BY captured_date ASC`,
      )
      .all(params) as Array<{ date: string; price: number }>;
    return opts.limit && rows.length > opts.limit ? rows.slice(-opts.limit) : rows;
  }

  /** Distinct commodities that have a STANDALONE market street price recorded —
   *  the worklist for the Base unit cost tracker. `scope` controls class
   *  relevance (a standalone row has no model_id, so it can't be classed on its
   *  own — we class it by the models that PRICE it):
   *   - a `WsClass` → only commodities also priced WITHIN a model of that class
   *     (so a desktop RDIMM never surfaces under the Mobile tab);
   *   - `'unclassed'` → only commodities with NO model-tied price row in any
   *     class (a street price not yet attached to a catalogued SKU) — kept in a
   *     clearly cross-class section rather than force-bucketed into one tab;
   *   - omitted → every standalone commodity (legacy, unscoped). */
  standalone_commodities(limit = 12, scope?: WsClass | 'unclassed'): string[] {
    if (scope === 'unclassed') {
      return (
        this.db
          .prepare(
            `SELECT DISTINCT sp.commodity FROM commodity_prices sp
              WHERE sp.price_kind='standalone' AND sp.price IS NOT NULL
                AND sp.commodity NOT IN (
                  SELECT cp.commodity FROM commodity_prices cp
                    JOIN skus k ON k.model_id = cp.model_id)
              ORDER BY sp.commodity LIMIT @lim`,
          )
          .all({ '@lim': limit }) as { commodity: string }[]
      ).map((r) => r.commodity);
    }
    if (scope) {
      // Class-scoped: standalone price AND a model of this class prices the part.
      const ffIn = form_factors_for_class(scope).map((f) => `'${f}'`).join(',');
      return (
        this.db
          .prepare(
            `SELECT DISTINCT sp.commodity FROM commodity_prices sp
              WHERE sp.price_kind='standalone' AND sp.price IS NOT NULL
                AND sp.commodity IN (
                  SELECT cp.commodity FROM commodity_prices cp
                    JOIN skus k ON k.model_id = cp.model_id
                    WHERE k.form_factor IN (${ffIn}))
              ORDER BY sp.commodity LIMIT @lim`,
          )
          .all({ '@lim': limit }) as { commodity: string }[]
      ).map((r) => r.commodity);
    }
    return (
      this.db
        .prepare(
          `SELECT DISTINCT commodity FROM commodity_prices
            WHERE price_kind='standalone' AND price IS NOT NULL
            ORDER BY commodity LIMIT @lim`,
        )
        .all({ '@lim': limit }) as { commodity: string }[]
    ).map((r) => r.commodity);
  }

  /** Latest observed STANDALONE market street price for a commodity, if any. */
  latest_standalone(commodity: string): { price: number; url: string; captured_date: string } | null {
    const r = this.db
      .prepare(
        `SELECT price, url, captured_date FROM commodity_prices
          WHERE commodity=@c AND price_kind='standalone' AND price IS NOT NULL
          ORDER BY captured_date DESC LIMIT 1`,
      )
      .get({ '@c': commodity }) as { price: number; url: string; captured_date: string } | undefined;
    return r ?? null;
  }

  /**
   * ROBUST street price: the median over the most recent ≤5 daily standalone
   * points within 60 days, with the median-nearest observation as provenance.
   * One scrape misreading one retailer page can swing `latest_standalone` by
   * itself; everything that BACKS A NUMBER OUT (base_unit_view) or anchors a
   * markup comparison (premium_view) reads this instead. `spread_pct` is the
   * window's (max−min)/median — a dispersion tell the consumer can surface
   * ("street price noisy ±18%").
   */
  robust_standalone(
    commodity: string,
  ): { price: number; url: string; captured_date: string; n_obs: number; spread_pct: number } | null {
    const rows = this.db
      .prepare(
        `SELECT price, url, captured_date FROM commodity_prices
          WHERE commodity=@c AND price_kind='standalone' AND price IS NOT NULL
            AND julianday('now') - julianday(captured_date) <= 60
          ORDER BY captured_date DESC LIMIT 5`,
      )
      .all({ '@c': commodity }) as Array<{ price: number; url: string; captured_date: string }>;
    if (rows.length === 0) {
      // Degrade to the latest point of any age rather than "no price" — an old
      // anchor labeled by its captured_date beats a hole in the backout.
      const last = this.latest_standalone(commodity);
      return last ? { ...last, n_obs: 1, spread_pct: 0 } : null;
    }
    const m = median(rows.map((r) => r.price))!;
    const rep = rows.reduce((best, r) => (Math.abs(r.price - m) < Math.abs(best.price - m) ? r : best), rows[0]!);
    const lo = Math.min(...rows.map((r) => r.price));
    const hi = Math.max(...rows.map((r) => r.price));
    return {
      price: m,
      url: rep.url,
      captured_date: rep.captured_date,
      n_obs: rows.length,
      spread_pct: m > 0 ? Math.round(((hi - lo) / m) * 1000) / 10 : 0,
    };
  }

  /** Recent standalone observations for one commodity — the PROOF log a price
   *  click-in shows (date · price · source), newest first. */
  standalone_observations(
    commodity: string,
    limit = 6,
  ): Array<{ captured_date: string; price: number; url: string }> {
    return this.db
      .prepare(
        `SELECT captured_date, price, url FROM commodity_prices
          WHERE commodity=@c AND price_kind='standalone' AND price IS NOT NULL
          ORDER BY captured_date DESC LIMIT @lim`,
      )
      .all({ '@c': commodity, '@lim': limit }) as Array<{ captured_date: string; price: number; url: string }>;
  }

  // ── base unit cost (the workstation PLATFORM, commodities backed out) ────────

  /** Record/refresh the OEM BASE configuration price + the minimal commodities
   *  it includes (CPU/GPU/RAM/SSD), for one SKU. `base_unit_view` derives the
   *  platform residual by backing those out at street. Idempotent on model_id. */
  record_base_unit(b: {
    model_id: string;
    vendor: Vendor;
    base_config_price: number;
    base_components: Array<{ commodity_class: CommodityClass; commodity: string }>;
    confidence?: Confidence;
    note?: string;
    source_url?: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO base_units
           (model_id, vendor, base_config_price, base_components_json, confidence, note, source_url, captured_date, updated_at)
         VALUES (@m,@v,@p,@bom,@conf,@note,@url,@day,@now)
         ON CONFLICT(model_id) DO UPDATE SET
           vendor=excluded.vendor, base_config_price=excluded.base_config_price,
           base_components_json=excluded.base_components_json, confidence=excluded.confidence,
           note=excluded.note, source_url=excluded.source_url,
           captured_date=excluded.captured_date, updated_at=excluded.updated_at`,
      )
      .run({
        '@m': b.model_id, '@v': b.vendor, '@p': b.base_config_price,
        '@bom': JSON.stringify(b.base_components ?? []),
        '@conf': b.confidence ?? 'medium', '@note': b.note ?? '',
        '@url': b.source_url ?? '', '@day': date_part(now), '@now': now,
      });
  }

  /** Derived base-unit (platform) view: for each recorded SKU, back the minimal
   *  included commodities out of the base config price at their observed STREET
   *  price. `base_unit` = base_config_price − Σ(priced street). Components with no
   *  street price yet land in `missing` — the residual leans HIGH by their cost
   *  until they're priced (and by the OEM's markup on the rest, inherently). */
  base_unit_view(ws_class?: WsClass): Array<{
    model_id: string; vendor: string; base_config_price: number | null;
    backed_out: Array<{
      commodity: string; commodity_class: string; street: number | null; street_n_obs: number;
      /** Provenance of the street anchor (median-nearest observation). */
      street_url: string; street_date: string;
    }>;
    base_unit: number | null; missing: string[];
    /** Integrity tells the consumer should surface: a NEGATIVE residual (base
     *  price below the street sum — re-check the components), or a noisy
     *  street window on a backed-out part. */
    flags: string[];
    note: string; confidence: string; source_url: string; captured_date: string;
  }> {
    // A base unit IS a SKU (model_id), so it's inherently class-scoped — when a
    // class is given, join its SKU and keep only matching form factors so a
    // desktop platform residual never shows under the Mobile tab. (Uncatalogued
    // model_ids — no SKU row — drop out of the scoped view; without a form
    // factor they have no class.)
    const sql = ws_class
      ? `SELECT b.* FROM base_units b JOIN skus k ON k.model_id = b.model_id
          WHERE k.form_factor IN (${form_factors_for_class(ws_class).map((f) => `'${f}'`).join(',')})
          ORDER BY b.vendor, b.base_config_price DESC`
      : `SELECT * FROM base_units ORDER BY vendor, base_config_price DESC`;
    const rows = this.db
      .prepare(sql)
      .all() as Array<{
        model_id: string; vendor: string; base_config_price: number | null;
        base_components_json: string; note: string; confidence: string;
        source_url: string; captured_date: string;
      }>;
    return rows.map((r) => {
      let comps: Array<{ commodity_class: string; commodity: string }> = [];
      try { comps = JSON.parse(r.base_components_json || '[]'); } catch { comps = []; }
      const flags: string[] = [];
      const backed_out = comps.map((c) => {
        // Canonicalize the recorded component name the same way the price table
        // keys are — a base unit recorded with "2TB NVMe Gen4 M.2" must still
        // find the street row keyed "2TB NVMe Gen4 M.2 SSD". Read-side so
        // legacy rows benefit too.
        const key = normalize_commodity(c.commodity, (c.commodity_class || 'other') as CommodityClass);
        // ROBUST street (median of recent), not the latest single observation —
        // one bad scrape must not swing the platform residual.
        const street = this.robust_standalone(key);
        if (street && street.spread_pct > 25) {
          flags.push(`${key}: street price noisy (±${street.spread_pct}% over ${street.n_obs} recent points)`);
        }
        return {
          commodity: key,
          commodity_class: c.commodity_class,
          street: street?.price ?? null,
          street_n_obs: street?.n_obs ?? 0,
          street_url: street?.url ?? '',
          street_date: street?.captured_date ?? '',
        };
      });
      const priced = backed_out.filter((b) => b.street != null);
      const missing = backed_out.filter((b) => b.street == null).map((b) => b.commodity);
      const base_unit =
        r.base_config_price != null
          ? r.base_config_price - priced.reduce((s, b) => s + (b.street as number), 0)
          : null;
      if (base_unit != null && base_unit < 0) {
        flags.push(
          'NEGATIVE residual — base price below the street sum of its components; re-check the base components (a loaded config recorded as base?) or the street prices',
        );
      }
      return {
        model_id: r.model_id, vendor: r.vendor, base_config_price: r.base_config_price,
        backed_out, base_unit, missing, flags,
        note: r.note, confidence: r.confidence, source_url: r.source_url, captured_date: r.captured_date,
      };
    });
  }

  /**
   * Base-unit cost OVER TIME, derived: for each day the platform's BASE config
   * price was observed (the 'base' rows the configurator drive feeds daily),
   * back out each base component at its street price AS OF that day (latest
   * standalone ≤ the date). The residual series is what "the box itself" cost
   * historically — base_units keeps only the latest snapshot, but the price
   * tables carry the history, so this derives it instead of storing a copy.
   * `priced` = how many components had a street anchor on that day (early days
   * may back out fewer — the residual leans higher there; the consumer should
   * say so).
   */
  base_unit_series(model_id: string, limit = 30): Array<{
    date: string;
    base_price: number;
    residual: number;
    priced: number;
  }> {
    const bu = this.db
      .prepare(`SELECT base_components_json FROM base_units WHERE model_id=@m`)
      .get({ '@m': model_id }) as { base_components_json: string } | undefined;
    if (!bu) return [];
    let comps: Array<{ commodity_class: string; commodity: string }> = [];
    try { comps = JSON.parse(bu.base_components_json || '[]'); } catch { comps = []; }
    const keys = comps.map((c) => normalize_commodity(c.commodity, (c.commodity_class || 'other') as CommodityClass));
    const base_pts = this.db
      .prepare(
        `SELECT captured_date AS date, MIN(COALESCE(sale_price, list_price)) AS price FROM prices
          WHERE model_id=@m AND config_label='base'
            AND (list_price IS NOT NULL OR sale_price IS NOT NULL)
          GROUP BY captured_date ORDER BY captured_date ASC`,
      )
      .all({ '@m': model_id }) as Array<{ date: string; price: number }>;
    const asof = this.db.prepare(
      `SELECT price FROM commodity_prices
        WHERE commodity=@c AND price_kind='standalone' AND price IS NOT NULL AND captured_date <= @d
        ORDER BY captured_date DESC LIMIT 1`,
    );
    const out = base_pts.map((p) => {
      let backed = 0;
      let priced = 0;
      for (const k of keys) {
        const r = asof.get({ '@c': k, '@d': p.date }) as { price: number } | undefined;
        if (r) { backed += r.price; priced++; }
      }
      return { date: p.date, base_price: p.price, residual: Math.round((p.price - backed) * 100) / 100, priced };
    });
    return out.length > limit ? out.slice(-limit) : out;
  }

  /**
   * Week-over-week + month-over-month price change for a commodity/price-kind,
   * from the daily history (one row per captured_date). Compares the latest
   * point to the most recent point at least 7 / 30 days earlier. Nulls when
   * there isn't enough history yet (it accrues over time). Direction: 'up' /
   * 'down' / 'flat'.
   */
  commodity_change(commodity: string, opts: { vendor?: string; model_id?: string; price_kind?: string } = {}): {
    latest: number | null;
    latest_date: string | null;
    wow_abs: number | null; wow_pct: number | null;
    mom_abs: number | null; mom_pct: number | null;
  } {
    const where: string[] = ['commodity=@c', 'price IS NOT NULL'];
    const params: Record<string, string> = { '@c': commodity };
    if (opts.vendor) { where.push('vendor=@v'); params['@v'] = opts.vendor; }
    if (opts.model_id !== undefined) { where.push('model_id=@m'); params['@m'] = opts.model_id; }
    if (opts.price_kind) { where.push('price_kind=@k'); params['@k'] = opts.price_kind; }
    const rows = this.db
      .prepare(`SELECT price, captured_date FROM commodity_prices WHERE ${where.join(' AND ')} ORDER BY captured_date DESC`)
      .all(params) as Array<{ price: number; captured_date: string }>;
    const empty = { latest: null, latest_date: null, wow_abs: null, wow_pct: null, mom_abs: null, mom_pct: null };
    if (rows.length === 0) return empty;
    const latest = rows[0]!;
    const latestMs = Date.parse(latest.captured_date);
    const priorAtLeast = (days: number): number | null => {
      const cutoff = latestMs - days * 86_400_000;
      const r = rows.find((x) => Date.parse(x.captured_date) <= cutoff);
      return r ? r.price : null;
    };
    const wkP = priorAtLeast(7);
    const moP = priorAtLeast(30);
    const chg = (prev: number | null): { abs: number | null; pct: number | null } =>
      prev != null && prev > 0
        ? { abs: Math.round((latest.price - prev) * 100) / 100, pct: Math.round(((latest.price - prev) / prev) * 1000) / 10 }
        : { abs: null, pct: null };
    const wow = chg(wkP);
    const mom = chg(moP);
    return {
      latest: latest.price, latest_date: latest.captured_date,
      wow_abs: wow.abs, wow_pct: wow.pct, mom_abs: mom.abs, mom_pct: mom.pct,
    };
  }

  /** Latest OEM configurator deltas for one commodity, per (vendor, model). */
  commodity_deltas(commodity: string): Array<{ vendor: string; model_id: string; delta: number; captured_date: string; url: string }> {
    return this.db
      .prepare(
        `SELECT cp.vendor, cp.model_id, cp.price AS delta, cp.captured_date, cp.url FROM commodity_prices cp
           JOIN (SELECT vendor, model_id, MAX(captured_date) AS d FROM commodity_prices
                  WHERE commodity=@c AND price_kind IN ('config_delta','addon') GROUP BY vendor, model_id) latest
             ON cp.vendor=latest.vendor AND cp.model_id=latest.model_id AND cp.captured_date=latest.d
          WHERE cp.commodity=@c AND cp.price_kind IN ('config_delta','addon') AND cp.price IS NOT NULL
          ORDER BY cp.vendor`,
      )
      .all({ '@c': commodity }) as Array<{ vendor: string; model_id: string; delta: number; captured_date: string; url: string }>;
  }

  // ── commodity trends + forward cost outlook ────────────────────────────────
  //
  // The deterministic "project the future impact" layer: fit each commodity's
  // observed street-price series to a compounding monthly drift (cost_model's
  // log-linear OLS), roll the drifts up per class (the DRAM/NAND/VRAM squeeze
  // as ONE number), and compound them forward over a recorded base unit to get
  // a projected base-config cost per platform at 3/6/12 months. Pure math over
  // recorded observations — every number traces to rows with source URLs; no
  // LLM in the loop. Projections are labeled extrapolations with widening
  // bands, never facts.

  /** Fitted trend for one commodity's series (standalone street by default;
   *  pass vendor + price_kinds for an OEM configurator-delta trend). */
  commodity_trend(
    commodity: string,
    opts: { vendor?: Vendor; price_kinds?: string[] } = {},
  ): {
    commodity: string;
    commodity_class: string;
    latest: number | null;
    latest_date: string | null;
    wow_pct: number | null;
    mom_pct: number | null;
    fit: DriftFit | null;
    direction: TrendDirection | null;
    confidence: TrendConfidence | null;
  } {
    const kinds = opts.price_kinds ?? ['standalone'];
    const series = this.price_series(commodity, { vendor: opts.vendor, price_kinds: kinds });
    const fit = fit_drift(series);
    const change = this.commodity_change(commodity, {
      vendor: opts.vendor,
      price_kind: kinds.length === 1 ? kinds[0] : undefined,
    });
    const cls = this.db
      .prepare(`SELECT commodity_class FROM commodity_prices WHERE commodity=@c LIMIT 1`)
      .get({ '@c': commodity }) as { commodity_class: string } | undefined;
    return {
      commodity,
      commodity_class: cls?.commodity_class ?? 'other',
      latest: change.latest,
      latest_date: change.latest_date,
      wow_pct: change.wow_pct,
      mom_pct: change.mom_pct,
      fit,
      direction: fit ? trend_direction(fit) : null,
      confidence: fit ? trend_confidence(fit) : null,
    };
  }

  /** Trend table across every commodity with a standalone street series —
   *  strongest fitted movers first, then the not-yet-fittable tail (history
   *  still accruing). Optionally one class. */
  trend_table(opts: { commodity_class?: CommodityClass; limit?: number } = {}): Array<
    ReturnType<KristiWorkstationsStore['commodity_trend']>
  > {
    const limit = Math.min(opts.limit ?? 24, 60);
    const params: Record<string, string> = {};
    let clause = `WHERE price_kind='standalone' AND price IS NOT NULL`;
    if (opts.commodity_class) { clause += ' AND commodity_class=@cls'; params['@cls'] = opts.commodity_class; }
    const names = (
      this.db
        .prepare(`SELECT DISTINCT commodity FROM commodity_prices ${clause} ORDER BY commodity`)
        .all(params) as { commodity: string }[]
    ).map((r) => r.commodity);
    const rows = names.map((n) => this.commodity_trend(n));
    rows.sort((a, b) => {
      if (a.fit && !b.fit) return -1;
      if (!a.fit && b.fit) return 1;
      return Math.abs(b.fit?.monthly_pct ?? 0) - Math.abs(a.fit?.monthly_pct ?? 0);
    });
    return rows.slice(0, limit);
  }

  /** Class-level drift: the median fitted monthly drift across this class's
   *  street-tracked commodities — "memory is moving +X%/mo across the board."
   *  The proxy drift for a component with no series of its own. */
  class_drift(commodity_class: CommodityClass): { monthly_pct: number; n_commodities: number } | null {
    const fits = this.trend_table({ commodity_class, limit: 60 })
      .map((t) => t.fit)
      .filter((f): f is DriftFit => f != null);
    const m = median(fits.map((f) => f.monthly_pct));
    return m != null ? { monthly_pct: m, n_commodities: fits.length } : null;
  }

  /**
   * Forward COST OUTLOOK per recorded base unit: hold the platform residual
   * constant (the OEM's chassis/board/margin moves slowly), compound each
   * backed-out commodity by its fitted drift (own series first, class-median
   * drift as the labeled proxy, flat when neither exists), and re-sum. The
   * output is "where this platform's BASE CONFIG price is heading if the
   * observed commodity drift holds" — a falsifiable extrapolation with
   * widening bands and explicit caveats, comparable across OEMs.
   */
  cost_outlook(opts: { ws_class?: WsClass; model_id?: string; horizons_months?: number[] } = {}): {
    as_of: string;
    horizons_months: number[];
    /** The squeeze, per class: median fitted street drift across tracked parts. */
    market_drift: Array<{ commodity_class: string; monthly_pct: number; n_commodities: number }>;
    platforms: Array<{
      model_id: string;
      vendor: string;
      base_config_price: number | null;
      platform_residual: number | null;
      components: Array<{
        commodity: string;
        commodity_class: string;
        street: number | null;
        drift_monthly_pct: number | null;
        drift_source: 'fitted' | 'class_median' | 'none';
        confidence: TrendConfidence | null;
      }>;
      projections: Array<{
        months: number;
        projected_base_config: number;
        delta_abs: number;
        delta_pct: number;
        low: number;
        high: number;
      }>;
      confidence: TrendConfidence;
      missing: string[];
      flags: string[];
      caveats: string[];
    }>;
  } {
    const horizons = (opts.horizons_months ?? [3, 6, 12]).filter((h) => h > 0 && h <= 36).slice(0, 6);
    const CONF_RANK: Record<TrendConfidence, number> = { low: 0, medium: 1, high: 2 };
    const classDrifts = new Map<string, { monthly_pct: number; n_commodities: number } | null>();
    const class_drift_of = (cls: CommodityClass): { monthly_pct: number; n_commodities: number } | null => {
      if (!classDrifts.has(cls)) classDrifts.set(cls, this.class_drift(cls));
      return classDrifts.get(cls) ?? null;
    };

    let units = this.base_unit_view(opts.ws_class);
    if (opts.model_id) units = units.filter((u) => u.model_id === opts.model_id);

    const platforms = units.map((u) => {
      const caveats: string[] = [];
      let conf: TrendConfidence = 'high';
      const components = u.backed_out.map((c) => {
        const trend = this.commodity_trend(c.commodity);
        if (trend.fit) {
          const tc = trend_confidence(trend.fit);
          conf = CONF_RANK[tc] < CONF_RANK[conf] ? tc : conf;
          return {
            commodity: c.commodity,
            commodity_class: c.commodity_class,
            street: c.street,
            drift_monthly_pct: trend.fit.monthly_pct,
            drift_source: 'fitted' as const,
            confidence: tc,
            sigma_pct: trend.fit.sigma_pct,
          };
        }
        const proxy = class_drift_of(c.commodity_class as CommodityClass);
        if (proxy && c.street != null) {
          conf = 'low';
          caveats.push(`${c.commodity}: no own price series yet — using the ${c.commodity_class}-class median drift (${proxy.monthly_pct}%/mo over ${proxy.n_commodities} parts) as proxy`);
          return {
            commodity: c.commodity,
            commodity_class: c.commodity_class,
            street: c.street,
            drift_monthly_pct: proxy.monthly_pct,
            drift_source: 'class_median' as const,
            confidence: 'low' as const,
            sigma_pct: 0,
          };
        }
        if (c.street != null) {
          conf = 'low';
          caveats.push(`${c.commodity}: no trend history — held flat`);
        }
        return {
          commodity: c.commodity,
          commodity_class: c.commodity_class,
          street: c.street,
          drift_monthly_pct: null,
          drift_source: 'none' as const,
          confidence: null,
          sigma_pct: 0,
        };
      });

      const projectable = u.base_config_price != null && u.base_unit != null;
      if (u.missing.length) {
        caveats.push(`${u.missing.join(', ')} not street-priced — riding inside the platform residual, held flat`);
      }
      caveats.push('platform residual (chassis/board/margin) held constant; commodity drift extrapolated from observed street series');

      const projections = projectable
        ? horizons.map((months) => {
            let total = u.base_unit as number;
            let low = u.base_unit as number;
            let high = u.base_unit as number;
            for (const comp of components) {
              if (comp.street == null) continue;
              if (comp.drift_monthly_pct == null) {
                total += comp.street; low += comp.street; high += comp.street;
                continue;
              }
              const p = project_price(comp.street, comp.drift_monthly_pct, months, comp.sigma_pct);
              total += p.projected; low += p.low; high += p.high;
            }
            const base = u.base_config_price as number;
            return {
              months,
              projected_base_config: Math.round(total * 100) / 100,
              delta_abs: Math.round((total - base) * 100) / 100,
              delta_pct: base > 0 ? Math.round(((total - base) / base) * 1000) / 10 : 0,
              low: Math.round(low * 100) / 100,
              high: Math.round(high * 100) / 100,
            };
          })
        : [];
      if (!projectable) caveats.push('base config price or residual not derivable yet — record the base unit + street prices first');
      const anyDrift = components.some((c) => c.drift_monthly_pct != null);
      if (!anyDrift) conf = 'low';

      return {
        model_id: u.model_id,
        vendor: u.vendor,
        base_config_price: u.base_config_price,
        platform_residual: u.base_unit,
        components: components.map(({ sigma_pct: _s, ...rest }) => rest),
        projections,
        confidence: conf,
        missing: u.missing,
        flags: u.flags,
        caveats,
      };
    });

    const market_drift = (['memory', 'storage', 'gpu', 'cpu', 'psu'] as CommodityClass[])
      .map((cls) => ({ cls, d: class_drift_of(cls) }))
      .filter((x): x is { cls: CommodityClass; d: { monthly_pct: number; n_commodities: number } } => x.d != null)
      .map((x) => ({ commodity_class: x.cls, monthly_pct: x.d.monthly_pct, n_commodities: x.d.n_commodities }));

    return {
      as_of: new Date().toISOString(),
      horizons_months: horizons,
      market_drift,
      platforms,
    };
  }

  // ── benchmark scores + price-per-performance ───────────────────────────────

  /** Record one benchmark score for a CPU/GPU commodity. Gated: canonical
   *  benchmark key + class match + plausibility window (cost_model
   *  KNOWN_BENCHMARKS). The component name canonicalizes through
   *  normalize_commodity so it joins the price table's keys. Latest wins. */
  record_benchmark_score(b: {
    component: string;
    component_class: 'cpu' | 'gpu';
    benchmark: string;
    score: number;
    source_url: string;
  }): { stored: boolean; reason?: string } {
    const verdict = validate_benchmark_score(b.benchmark, b.component_class, b.score);
    if (!verdict.ok) return { stored: false, reason: verdict.reason };
    const component = normalize_commodity(b.component, b.component_class);
    this.db
      .prepare(
        `INSERT INTO benchmark_scores (component, component_class, benchmark, score, source_url, captured_at)
         VALUES (@c,@cls,@b,@s,@url,@ts)
         ON CONFLICT(component, benchmark) DO UPDATE SET
           component_class=excluded.component_class, score=excluded.score,
           source_url=excluded.source_url, captured_at=excluded.captured_at`,
      )
      .run({
        '@c': component, '@cls': b.component_class, '@b': b.benchmark,
        '@s': b.score, '@url': b.source_url, '@ts': new Date().toISOString(),
      });
    return { stored: true };
  }

  benchmark_scores_for(component: string): Array<{ benchmark: string; score: number; source_url: string; captured_at: string }> {
    return this.db
      .prepare(`SELECT benchmark, score, source_url, captured_at FROM benchmark_scores WHERE component=@c ORDER BY benchmark`)
      .all({ '@c': component }) as Array<{ benchmark: string; score: number; source_url: string; captured_at: string }>;
  }

  /** CPU/GPU commodities with NO benchmark score yet — the lookup job's
   *  worklist. Street-priced parts first (they yield a perf-per-dollar row the
   *  moment a score lands). Sources: the priced commodities + the catalogued
   *  GPU options (normalized onto the same keys). */
  unbenchmarked_components(limit = 10): Array<{ component: string; component_class: 'cpu' | 'gpu'; has_street: boolean }> {
    const priced = this.db
      .prepare(
        `SELECT commodity AS component, commodity_class AS cls,
                MAX(CASE WHEN price_kind='standalone' AND price IS NOT NULL THEN 1 ELSE 0 END) AS has_street
           FROM commodity_prices WHERE commodity_class IN ('cpu','gpu')
           GROUP BY commodity`,
      )
      .all() as Array<{ component: string; cls: 'cpu' | 'gpu'; has_street: number }>;
    const gpu_opts = this.db
      .prepare(`SELECT DISTINCT gpu_name FROM gpu_options WHERE gpu_name != ''`)
      .all() as Array<{ gpu_name: string }>;
    const seen = new Map<string, { component: string; component_class: 'cpu' | 'gpu'; has_street: boolean }>();
    for (const p of priced) {
      seen.set(p.component, { component: p.component, component_class: p.cls, has_street: p.has_street === 1 });
    }
    for (const g of gpu_opts) {
      const key = normalize_commodity(g.gpu_name, 'gpu');
      if (!seen.has(key)) seen.set(key, { component: key, component_class: 'gpu', has_street: false });
    }
    const scored = new Set(
      (this.db.prepare(`SELECT DISTINCT component FROM benchmark_scores`).all() as { component: string }[]).map((r) => r.component),
    );
    return [...seen.values()]
      .filter((c) => !scored.has(c.component))
      .sort((a, b) => Number(b.has_street) - Number(a.has_street) || a.component.localeCompare(b.component))
      .slice(0, limit);
  }

  /**
   * Price-per-performance: each scored CPU/GPU joined to its ROBUST street
   * price → score-per-dollar, grouped by benchmark (scores only compare
   * WITHIN one benchmark). A scored part with no street price still lists
   * (score_per_dollar null) — that row IS the street-price worklist.
   */
  perf_per_dollar(opts: { component_class?: 'cpu' | 'gpu'; limit?: number } = {}): Array<{
    benchmark: string;
    benchmark_label: string;
    component: string;
    component_class: string;
    score: number;
    street: number | null;
    street_date: string | null;
    score_per_dollar: number | null;
    score_url: string;
  }> {
    const params: Record<string, string | number> = {};
    let clause = '';
    if (opts.component_class) { clause = 'WHERE component_class=@cls'; params['@cls'] = opts.component_class; }
    const rows = this.db
      .prepare(`SELECT component, component_class, benchmark, score, source_url FROM benchmark_scores ${clause}`)
      .all(params) as Array<{ component: string; component_class: string; benchmark: string; score: number; source_url: string }>;
    const out = rows.map((r) => {
      const street = this.robust_standalone(r.component);
      return {
        benchmark: r.benchmark,
        benchmark_label: KNOWN_BENCHMARKS[r.benchmark]?.label ?? r.benchmark,
        component: r.component,
        component_class: r.component_class,
        score: r.score,
        street: street?.price ?? null,
        street_date: street?.captured_date ?? null,
        score_per_dollar: street && street.price > 0 ? Math.round((r.score / street.price) * 100) / 100 : null,
        score_url: r.source_url,
      };
    });
    out.sort(
      (a, b) =>
        a.benchmark.localeCompare(b.benchmark) ||
        (b.score_per_dollar ?? -1) - (a.score_per_dollar ?? -1),
    );
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  // ── data health (completeness + freshness, beyond existence) ───────────────

  /**
   * The QUALITY companion to coverage_summary: that view says whether a
   * (class × vendor × tier) cell HAS a SKU; this one says whether the SKUs it
   * has are USABLE — enough comparable specs to join a lane comparison, a
   * price observed recently, configurator deltas recently, a base unit
   * recorded. "Stale beats missing" — a cell that exists but hasn't been
   * priced in a month misleads more than an empty one, because it LOOKS
   * covered. The worklist names the worst cells so a pass starts there.
   */
  data_health(): {
    cells: Array<{
      ws_class: string; tier: string; vendor: string; skus: number;
      /** SKUs with ≥3 distinct comparable metrics recorded (normalizeSpec). */
      specs_ok: number;
      /** SKUs with a system price observed in the last 14 days. */
      price_fresh: number;
      /** SKUs with an OEM configurator delta in the last 14 days. */
      delta_fresh: number;
      /** SKUs with a base unit recorded. */
      base_units: number;
    }>;
    totals: { skus: number; specs_ok: number; price_fresh: number; delta_fresh: number; base_units: number };
    worklist: string[];
  } {
    const FRESH_DAYS = 14;
    const skus = this.find_skus({ limit: 500 });
    const fresh = (dates: string[]): boolean => {
      const latest = dates.sort().at(-1);
      if (!latest) return false;
      const age = (Date.now() - Date.parse(latest)) / 86_400_000;
      return Number.isFinite(age) && age <= FRESH_DAYS;
    };
    const base_ids = new Set(
      (this.db.prepare(`SELECT model_id FROM base_units`).all() as { model_id: string }[]).map((r) => r.model_id),
    );
    type Cell = { ws_class: string; tier: string; vendor: string; skus: number; specs_ok: number; price_fresh: number; delta_fresh: number; base_units: number };
    const cells = new Map<string, Cell>();
    for (const s of skus) {
      const cls = ws_class_label(ws_class_from_form_factor(s.form_factor));
      const key = `${cls}|${s.tier}|${s.vendor}`;
      const cell = cells.get(key) ?? { ws_class: cls, tier: s.tier, vendor: s.vendor, skus: 0, specs_ok: 0, price_fresh: 0, delta_fresh: 0, base_units: 0 };
      cell.skus++;
      const metrics = new Set(
        this.specs_for(s.model_id)
          .map((sp) => normalizeSpec(sp.spec_key, sp.spec_value, sp.unit)?.key)
          .filter((k): k is string => !!k),
      );
      if (metrics.size >= 3) cell.specs_ok++;
      const priceDates = (this.db
        .prepare(`SELECT captured_date FROM prices WHERE model_id=@m`)
        .all({ '@m': s.model_id }) as { captured_date: string }[]).map((r) => r.captured_date);
      if (fresh(priceDates)) cell.price_fresh++;
      const deltaDates = (this.db
        .prepare(`SELECT captured_date FROM commodity_prices WHERE model_id=@m AND price_kind IN ('config_delta','addon')`)
        .all({ '@m': s.model_id }) as { captured_date: string }[]).map((r) => r.captured_date);
      if (fresh(deltaDates)) cell.delta_fresh++;
      if (base_ids.has(s.model_id)) cell.base_units++;
      cells.set(key, cell);
    }
    const list = [...cells.values()].sort(
      (a, b) => a.ws_class.localeCompare(b.ws_class) || a.tier.localeCompare(b.tier) || a.vendor.localeCompare(b.vendor),
    );
    const totals = list.reduce(
      (t, c) => ({
        skus: t.skus + c.skus, specs_ok: t.specs_ok + c.specs_ok, price_fresh: t.price_fresh + c.price_fresh,
        delta_fresh: t.delta_fresh + c.delta_fresh, base_units: t.base_units + c.base_units,
      }),
      { skus: 0, specs_ok: 0, price_fresh: 0, delta_fresh: 0, base_units: 0 },
    );
    const worklist: string[] = [];
    for (const c of list) {
      const cell = c.tier ? `${c.ws_class} · ${c.tier} / ${c.vendor}` : `${c.ws_class} / ${c.vendor}`;
      if (c.specs_ok < c.skus) worklist.push(`${cell}: ${c.skus - c.specs_ok}/${c.skus} SKUs thin on comparable specs (<3 metrics)`);
      if (c.price_fresh === 0) worklist.push(`${cell}: no system price observed in ${FRESH_DAYS}d`);
    }
    return { cells: list, totals, worklist: worklist.slice(0, 16) };
  }

  /** Pane helper: commodities that have BOTH an OEM configurator delta AND an
   *  observed market street price — each row shows the market cost beside each
   *  OEM's configurator add, so the premium/markup is visible. Constrained
   *  classes (memory/storage/gpu) first. */
  premium_view(limit = 10, ws_class?: WsClass): Array<{
    commodity: string;
    commodity_class: string;
    market_price: number | null;
    /** Provenance of the market price — WHERE (source host + url) and WHEN. */
    market_source: string | null;
    market_url: string | null;
    market_date: string | null;
    /** Market-price trend (the NAND/DRAM/VRAM move): WoW/MoM % + $. */
    market_wow_pct: number | null;
    market_mom_pct: number | null;
    market_mom_abs: number | null;
    /** Each OEM's configurator delta, with its own source host + capture date. */
    oem_deltas: Array<{ vendor: string; delta: number; source: string; date: string }>;
    cheapest_oem: string | null; // smallest configurator delta — the undercut signal
  }> {
    const host_of = (u: string): string => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } };
    // Optionally scope to commodities with an OEM delta WITHIN a model of this
    // class, so each class tab shows only its own component-cost picture.
    const ffIn = ws_class
      ? form_factors_for_class(ws_class).map((f) => `'${f}'`).join(',')
      : '';
    const sql = ws_class
      ? `SELECT DISTINCT cp.commodity AS commodity, cp.commodity_class AS commodity_class
           FROM commodity_prices cp JOIN skus k ON k.model_id = cp.model_id
          WHERE cp.price_kind IN ('config_delta','addon') AND cp.vendor IN ('hp','dell','lenovo')
            AND k.form_factor IN (${ffIn})
          ORDER BY CASE cp.commodity_class WHEN 'memory' THEN 0 WHEN 'storage' THEN 1 WHEN 'gpu' THEN 2 ELSE 3 END, cp.commodity`
      : `SELECT DISTINCT commodity, commodity_class FROM commodity_prices
          WHERE price_kind IN ('config_delta','addon') AND vendor IN ('hp','dell','lenovo')
          ORDER BY CASE commodity_class WHEN 'memory' THEN 0 WHEN 'storage' THEN 1 WHEN 'gpu' THEN 2 ELSE 3 END, commodity`;
    const rows = this.db.prepare(sql).all() as Array<{ commodity: string; commodity_class: string }>;
    const out: Array<{ commodity: string; commodity_class: string; market_price: number | null; market_source: string | null; market_url: string | null; market_date: string | null; market_wow_pct: number | null; market_mom_pct: number | null; market_mom_abs: number | null; oem_deltas: Array<{ vendor: string; delta: number; source: string; date: string }>; cheapest_oem: string | null }> = [];
    for (const r of rows) {
      // ROBUST median-of-recent street, so one bad scrape can't fake a markup story.
      const market = this.robust_standalone(r.commodity);
      if (!market) continue; // only rows where we have a market anchor to compare against
      const change = this.commodity_change(r.commodity, { vendor: 'other', model_id: '', price_kind: 'standalone' });
      const deltas = this.commodity_deltas(r.commodity).map((d) => ({ vendor: d.vendor, delta: d.delta, source: host_of(d.url), date: d.captured_date }));
      const cheapest = deltas.length ? [...deltas].sort((a, b) => a.delta - b.delta)[0]! : null;
      out.push({
        commodity: r.commodity,
        commodity_class: r.commodity_class,
        market_price: market.price,
        market_source: host_of(market.url),
        market_url: market.url,
        market_date: market.captured_date,
        market_wow_pct: change.wow_pct,
        market_mom_pct: change.mom_pct,
        market_mom_abs: change.mom_abs,
        oem_deltas: deltas,
        cheapest_oem: cheapest && deltas.length > 1 ? cheapest.vendor : null,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  // ── competitive radar (threats + net-new players) ───────────────────────

  /** Upsert a radar item (threat / new player / platform shift). Idempotent on
   *  (kind, name); preserves first_seen, refreshes the rest. Returns whether
   *  this was NEW (first sighting → candidate to bubble up). */
  record_radar_item(r: {
    kind: RadarKind;
    name: string;
    vendor_name?: string;
    summary: string;
    thesis?: string;
    attacks?: string;
    severity: Severity;
    confidence?: Confidence;
    status?: string;
    /** Workstation class this item pressures, or 'all' for genuinely
     *  cross-class threats. Omit to auto-derive from the name (defaults to
     *  'all' when no confident class keyword is present). */
    ws_class?: WsClass | 'all';
    source_url: string;
  }): { inserted: boolean } {
    const existed = this.db
      .prepare(`SELECT 1 FROM radar_items WHERE kind=@k AND name=@n`)
      .get({ '@k': r.kind, '@n': r.name });
    const cls = r.ws_class ?? radar_class_signal(r.name);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO radar_items
           (kind, name, vendor_name, summary, thesis, attacks, severity, confidence, status, ws_class, source_url, first_seen, last_seen)
         VALUES (@k,@n,@v,@s,@t,@a,@sev,@c,@st,@cls,@u,@now,@now)
         ON CONFLICT(kind, name) DO UPDATE SET
           vendor_name=excluded.vendor_name, summary=excluded.summary, thesis=excluded.thesis,
           attacks=excluded.attacks, severity=excluded.severity, confidence=excluded.confidence,
           status=excluded.status, ws_class=excluded.ws_class, source_url=excluded.source_url, last_seen=excluded.last_seen`,
      )
      .run({
        '@k': r.kind, '@n': r.name, '@v': r.vendor_name ?? '', '@s': r.summary,
        '@t': r.thesis ?? '', '@a': r.attacks ?? '', '@sev': r.severity,
        '@c': r.confidence ?? 'medium', '@st': r.status ?? 'tracking', '@cls': cls,
        '@u': r.source_url, '@now': now,
      });
    return { inserted: !existed };
  }

  /** Radar items, highest severity + most-recent first. */
  radar(filter: { kind?: RadarKind; severity?: Severity; ws_class?: WsClass; limit?: number } = {}): RadarItemRow[] {
    const where: string[] = [];
    const params: Record<string, string | number | null> = { '@lim': filter.limit ?? 50 };
    if (filter.kind) { where.push('kind=@k'); params['@k'] = filter.kind; }
    if (filter.severity) { where.push('severity=@sev'); params['@sev'] = filter.severity; }
    // A class tab shows its own items PLUS genuinely cross-class ('all') ones —
    // a platform shift that hits every class shouldn't vanish from a tab.
    if (filter.ws_class) { where.push("(ws_class=@cls OR ws_class='all')"); params['@cls'] = filter.ws_class; }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT * FROM radar_items ${clause}
          ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, last_seen DESC
          LIMIT @lim`,
      )
      .all(params) as RadarItemRow[];
  }

  count_new_radar(since_iso: string): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM radar_items WHERE first_seen >= @s`)
      .get({ '@s': since_iso }) as { n: number };
    return r.n;
  }

  // ── projections (clearly-labeled inference, kept separate) ───────────────

  /** Upsert the live projection for a (vendor, swimlane, projection_kind).
   *  Re-projecting the SAME kind replaces it; a lane can hold both a tech_push
   *  and a market_pull projection. `projection_kind` defaults to 'tech_push'. */
  record_projection(p: {
    vendor: Vendor;
    swimlane: string;
    projection_kind?: ProjectionKind;
    projected_label: string;
    basis_models: string[];
    cpu_platform: string;
    key_deltas: string;
    confidence: Confidence;
    falsifier: string;
    rationale_md: string;
    source_urls: string[];
  }): void {
    this.db
      .prepare(
        `INSERT INTO projections
           (vendor, swimlane, projection_kind, projected_label, basis_models, cpu_platform,
            key_deltas, confidence, falsifier, rationale_md, source_urls, created_at)
         VALUES (@v,@sl,@kind,@label,@basis,@cpu,@deltas,@conf,@fals,@rat,@src,@ts)
         ON CONFLICT(vendor, swimlane, projection_kind) DO UPDATE SET
           projected_label=excluded.projected_label, basis_models=excluded.basis_models,
           cpu_platform=excluded.cpu_platform, key_deltas=excluded.key_deltas,
           confidence=excluded.confidence, falsifier=excluded.falsifier,
           rationale_md=excluded.rationale_md, source_urls=excluded.source_urls,
           created_at=excluded.created_at`,
      )
      .run({
        '@v': p.vendor,
        '@sl': p.swimlane,
        '@kind': p.projection_kind ?? 'tech_push',
        '@label': p.projected_label,
        '@basis': p.basis_models.join(','),
        '@cpu': p.cpu_platform,
        '@deltas': p.key_deltas,
        '@conf': p.confidence,
        '@fals': p.falsifier,
        '@rat': p.rationale_md,
        '@src': p.source_urls.join('\n'),
        '@ts': new Date().toISOString(),
      });
  }

  list_projections(
    filter: { swimlane?: string; vendor?: Vendor; ws_class?: WsClass; projection_kind?: ProjectionKind } = {},
  ): ProjectionRow[] {
    const where: string[] = [];
    const params: Record<string, string | number | null> = {};
    if (filter.swimlane) { where.push('swimlane=@sl'); params['@sl'] = filter.swimlane; }
    if (filter.vendor) { where.push('vendor=@v'); params['@v'] = filter.vendor; }
    if (filter.projection_kind) { where.push('projection_kind=@pk'); params['@pk'] = filter.projection_kind; }
    // Projections have no form factor of their own — they inherit the class of
    // the swimlane they project, so scope by the SKUs in that lane. FormFactor
    // enums are inlined safely (not user input).
    if (filter.ws_class) {
      const ffs = form_factors_for_class(filter.ws_class).map((f) => `'${f}'`).join(',');
      where.push(`swimlane IN (SELECT DISTINCT swimlane FROM skus WHERE form_factor IN (${ffs}))`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM projections ${clause} ORDER BY swimlane, vendor, projection_kind`)
      .all(params) as ProjectionRow[];
  }

  // ── assessments (Kristi's per-item written view → pane detail_md) ────────

  /** Upsert Kristi's assessment of one pane item. One live row per
   *  (subject_type, subject_key); re-writing replaces it. */
  record_assessment(a: {
    subject_type: AssessmentSubject;
    subject_key: string;
    headline: string;
    assessment_md: string;
    sources?: Array<{ title?: string; url: string }>;
    confidence?: Confidence;
    subject_hash?: string;
    model_used?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO assessments
           (subject_type, subject_key, headline, assessment_md, sources_json,
            confidence, subject_hash, model_used, updated_at)
         VALUES (@t,@k,@head,@md,@src,@conf,@hash,@model,@ts)
         ON CONFLICT(subject_type, subject_key) DO UPDATE SET
           headline=excluded.headline, assessment_md=excluded.assessment_md,
           sources_json=excluded.sources_json, confidence=excluded.confidence,
           subject_hash=excluded.subject_hash, model_used=excluded.model_used,
           updated_at=excluded.updated_at`,
      )
      .run({
        '@t': a.subject_type,
        '@k': a.subject_key,
        '@head': a.headline,
        '@md': a.assessment_md,
        '@src': JSON.stringify(a.sources ?? []),
        '@conf': a.confidence ?? 'medium',
        '@hash': a.subject_hash ?? '',
        '@model': a.model_used ?? 'standard',
        '@ts': new Date().toISOString(),
      });
  }

  get_assessment(subject_type: AssessmentSubject, subject_key: string): AssessmentRow | null {
    const r = this.db
      .prepare(`SELECT * FROM assessments WHERE subject_type=@t AND subject_key=@k`)
      .get({ '@t': subject_type, '@k': subject_key }) as AssessmentRow | undefined;
    return r ?? null;
  }

  /** All assessments for a subject type, keyed by subject_key — the pane
   *  composer pulls one map per section instead of a query per row. */
  assessments_for(subject_type: AssessmentSubject): Map<string, AssessmentRow> {
    const rows = this.db
      .prepare(`SELECT * FROM assessments WHERE subject_type=@t`)
      .all({ '@t': subject_type }) as AssessmentRow[];
    return new Map(rows.map((r) => [r.subject_key, r]));
  }

  count_assessments(): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM assessments`).get() as { n: number };
    return r.n;
  }

  // ── swimlane profiles (persona / ICP / UCP per lane → pane tap-down) ──────

  /** Upsert one demand-side profile for a lane. Keyed by
   *  (ws_class, swimlane, profile_kind, title) so re-derivation replaces in place. */
  record_swimlane_profile(p: {
    ws_class: WsClass;
    swimlane: string;
    profile_kind: ProfileKind;
    title: string;
    body_md: string;
    grounded_on?: string;
    capability_drivers?: string;
    segment?: string;
    geforce_vs_pro?: string;
    best_fit_by_oem?: string;
    disqualifier?: string;
    redirect_swimlane?: string;
    redirect_reason?: string;
    confidence?: Confidence;
    falsifier?: string;
    source_urls?: string[];
  }): void {
    this.db
      .prepare(
        `INSERT INTO swimlane_profiles
           (ws_class, swimlane, profile_kind, title, body_md, grounded_on,
            capability_drivers, segment, geforce_vs_pro, best_fit_by_oem,
            disqualifier, redirect_swimlane, redirect_reason, confidence,
            falsifier, source_urls, updated_at)
         VALUES (@cls,@sl,@kind,@title,@body,@ground,@drivers,@seg,@gf,@best,
                 @disq,@rsl,@rreason,@conf,@fals,@src,@ts)
         ON CONFLICT(ws_class, swimlane, profile_kind, title) DO UPDATE SET
           body_md=excluded.body_md, grounded_on=excluded.grounded_on,
           capability_drivers=excluded.capability_drivers, segment=excluded.segment,
           geforce_vs_pro=excluded.geforce_vs_pro, best_fit_by_oem=excluded.best_fit_by_oem,
           disqualifier=excluded.disqualifier, redirect_swimlane=excluded.redirect_swimlane,
           redirect_reason=excluded.redirect_reason, confidence=excluded.confidence,
           falsifier=excluded.falsifier, source_urls=excluded.source_urls,
           updated_at=excluded.updated_at`,
      )
      .run({
        '@cls': p.ws_class,
        '@sl': p.swimlane,
        '@kind': p.profile_kind,
        '@title': p.title,
        '@body': p.body_md,
        '@ground': p.grounded_on ?? '',
        '@drivers': p.capability_drivers ?? '',
        '@seg': p.segment ?? '',
        '@gf': p.geforce_vs_pro ?? '',
        '@best': p.best_fit_by_oem ?? '',
        '@disq': p.disqualifier ?? '',
        '@rsl': p.redirect_swimlane ?? '',
        '@rreason': p.redirect_reason ?? '',
        '@conf': p.confidence ?? 'medium',
        '@fals': p.falsifier ?? '',
        '@src': (p.source_urls ?? []).join('\n'),
        '@ts': new Date().toISOString(),
      });
  }

  /** Clear a lane's profiles before a fresh derivation, so a persona that no
   *  longer fits the lane doesn't linger (upsert alone can't prune a dropped row). */
  delete_lane_profiles(ws_class: WsClass, swimlane: string): number {
    const info = this.db
      .prepare(`DELETE FROM swimlane_profiles WHERE ws_class=@c AND swimlane=@s`)
      .run({ '@c': ws_class, '@s': swimlane });
    return info.changes;
  }

  list_swimlane_profiles(
    filter: { ws_class?: WsClass; swimlane?: string; profile_kind?: ProfileKind } = {},
  ): SwimlaneProfileRow[] {
    const where: string[] = [];
    const params: Record<string, string> = {};
    if (filter.ws_class) { where.push('ws_class=@c'); params['@c'] = filter.ws_class; }
    if (filter.swimlane) { where.push('swimlane=@s'); params['@s'] = filter.swimlane; }
    if (filter.profile_kind) { where.push('profile_kind=@k'); params['@k'] = filter.profile_kind; }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT * FROM swimlane_profiles ${clause}
         ORDER BY swimlane,
           CASE profile_kind WHEN 'persona' THEN 0 WHEN 'icp' THEN 1 WHEN 'ucp' THEN 2 ELSE 3 END,
           title`,
      )
      .all(params) as SwimlaneProfileRow[];
  }

  /** All profiles for a class, grouped by swimlane — the pane composer pulls one
   *  map per class tab instead of a query per lane row. */
  profiles_by_lane(ws_class: WsClass): Map<string, SwimlaneProfileRow[]> {
    const rows = this.list_swimlane_profiles({ ws_class });
    const by = new Map<string, SwimlaneProfileRow[]>();
    for (const r of rows) {
      const arr = by.get(r.swimlane) ?? [];
      arr.push(r);
      by.set(r.swimlane, arr);
    }
    return by;
  }

  count_swimlane_profiles(): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM swimlane_profiles`).get() as { n: number };
    return r.n;
  }

  close(): void {
    this.db.close();
  }
}

// Module-level singleton so every Kristi tool + the pane composer share one
// connection.
let _store: KristiWorkstationsStore | null = null;
export function getKristiWorkstationsStore(): KristiWorkstationsStore {
  if (!_store) _store = new KristiWorkstationsStore();
  return _store;
}
