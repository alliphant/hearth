/**
 * Kristi's structured-write tools. She calls these during deliberation after
 * reading the freshly-ingested clippings, normalizing what she read into the
 * `kristi_workstations` store. Every write carries a `source_url` so a claim is
 * always traceable.
 *
 * One file exporting `create()` → Tool[] (the documented multi-tool pattern).
 * No ToolDeps needed beyond the audit log — the store is a process singleton.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { getKristiWorkstationsStore } from '@memory/stores/kristi_workstations';

const Vendor = z.enum(['hp', 'dell', 'lenovo', 'nvidia', 'other']);
const FormFactor = z.enum(['tower', 'rack', 'edge', 'mobile', 'sff', 'other']);
const CpuPlatform = z.enum(['xeon_w', 'threadripper_pro', 'arm', 'core_ultra', 'grace', 'other']);
const SkuStatus = z.enum(['leaked', 'announced', 'shipping', 'eol']);
const PriceSegment = z.enum(['smb', 'prosumer', 'enterprise', 'edu', 'gov']);
const GpuClass = z.enum(['rtx_pro_blackwell', 'rtx_pro_ada', 'geforce', 'datacenter', 'other']);
const IsvCategory = z.enum(['aec', 'me', 'pdm', 'fedgov', 'oem', 'healthcare', 'other']);
const Registry = z.enum(['dmtf', 'energystar', 'tco']);

function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ── source_url: permissive schema, honest check in execute (2026-07-26) ──────
//
// `source_url: z.string().url()` was an ARG-SPIRAL generator — the same class as
// the banned `.regex()` in an input_schema. The model reads a page, then emits
// something that is a real citation but not a strictly-valid URL
// ("dell.com/precision-9", "www.hp.com/z2-g1i", a trailing-comma'd link), Zod
// rejects the WHOLE call, the model retries identically → DUPLICATE_TOOL_CALL →
// spiral, and the SKU never lands. It was still failing live on 2026-07-26.
//
// The house fix is NOT to drop validation (`.min(1)` stores garbage and quietly
// breaks provenance — every claim here is supposed to be traceable). It's the
// documented shape: accept a permissive string in the schema, then NORMALIZE +
// check in `execute()` and return a TYPED RECOVERY message the model can act on.
// Bare hosts and protocol-relative links are recovered rather than rejected,
// because they're a correct citation typed slightly wrong.

/** A source_url that is unusable no matter how we normalize it. */
export interface SourceUrlProblem {
  ok: false;
  recovery: string;
}
export type SourceUrlResult = { ok: true; url: string } | SourceUrlProblem;

/** Normalize a model-supplied citation into a usable absolute URL, or explain
 *  precisely what to re-send. PURE — the smoke drives every branch. */
export function normalize_source_url(raw: string, field = 'source_url'): SourceUrlResult {
  const t = (raw ?? '').trim().replace(/[),.;'"]+$/, '');
  if (!t) {
    return { ok: false, recovery: `\`${field}\` was empty. Re-call with the page you actually read it from, e.g. "https://www.dell.com/…".` };
  }
  // A bare host or protocol-relative link is a correct citation, typed short.
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t) ? t : t.startsWith('//') ? `https:${t}` : `https://${t}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return {
      ok: false,
      recovery:
        `\`${field}\` isn't a usable link (got ${JSON.stringify(raw.slice(0, 80))}). Re-call with the full ` +
        `address of the page you read — "https://host/path". If you don't have one, say where the claim came ` +
        `from in \`notes\` instead of inventing a link.`,
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, recovery: `\`${field}\` must be an http(s) page, not ${parsed.protocol.replace(':', '')}. Re-call with the web address you read.` };
  }
  // A host with no dot and no port isn't a real site ("localhost" aside, which
  // is never a citation for a public spec).
  if (!parsed.hostname.includes('.')) {
    return { ok: false, recovery: `\`${field}\` has no real domain in it (got ${JSON.stringify(raw.slice(0, 80))}). Re-call with the page address, e.g. "https://www.dell.com/…".` };
  }
  return { ok: true, url: parsed.toString() };
}
/** Best-effort normalize for spots where the citation is context rather than
 *  the claim itself — a bare host becomes https://host, anything unusable is
 *  kept verbatim rather than rejecting the whole call. */
export function coerce_url(raw: string): string {
  const r = normalize_source_url(raw);
  return r.ok ? r.url : raw.trim();
}

function hash(input: unknown): string {
  return createHash('sha1').update(JSON.stringify(input)).digest('hex').slice(0, 10);
}

function logAction(deps: ToolDeps, ctx: ToolContext, tool: string, input: unknown, result: unknown): void {
  deps.memory.log_action({
    intent_id: ctx.intent_id,
    agent: ctx.specialist_id ?? 'kristi',
    tool_name: tool,
    tool_input: input as Record<string, unknown>,
    execution_result: result as Record<string, unknown>,
  });
}

// ── record_sku (with inline specs + gpu options) ────────────────────────────

const SpecIn = z.object({
  spec_key: z.string().min(1),
  spec_value: z.string().min(1),
  unit: z.string().optional(),
});
const GpuIn = z.object({
  gpu_name: z.string().min(1),
  gpu_class: GpuClass,
  vram_gb: z.number().nullable().optional(),
  tdp_w: z.number().nullable().optional(),
});

const RecordSkuIn = z.object({
  model_id: z.string().min(1).optional().describe('Stable slug; derived from model_name if omitted.'),
  vendor: Vendor,
  family: z.string().min(1),
  model_name: z.string().min(1),
  form_factor: FormFactor,
  chassis_variant: z.string().optional(),
  cpu_platform: CpuPlatform,
  status: SkuStatus,
  announced_at: z.string().optional(),
  launched_at: z.string().optional(),
  source_url: z.string().min(1).describe('The page you read this from — full address (https://host/path). Shape is checked and normalized on execute, not by the schema.'),
  notes: z.string().optional(),
  specs: z.array(SpecIn).optional().describe('Key specs to record alongside the SKU.'),
  gpu_options: z.array(GpuIn).optional(),
});
const RecordSkuOut = z.object({ error: z.string().optional(), recovery: z.string().optional(), ok: z.boolean(), model_id: z.string(), specs: z.number(), gpu_options: z.number() });

function make_record_sku(deps: ToolDeps): Tool<z.infer<typeof RecordSkuIn>, z.infer<typeof RecordSkuOut>> {
  return {
    name: 'record_sku',
    description:
      "Record (or update) a workstation SKU in Kristi's structured store, with optional key specs and GPU options inline. Use a stable model_id slug (e.g. 'dell-pro-precision-9-t6'); it's derived from model_name if omitted. Always pass the source_url you read it from.",
    risk: 'write_internal',
    required_capabilities: ['write_workstation_intel'],
    input_schema: RecordSkuIn,
    output_schema: RecordSkuOut,
    idempotency_key: (i) => `record_sku:${i.model_id ?? slug(i.model_name)}:${hash(i)}`,
    async execute(input, ctx) {
      // Provenance is the point of this store, so a citation that can't be
      // made usable fails HONESTLY with a typed recovery — never silently
      // stored as garbage, and never a schema reject the model can only retry.
      const src = normalize_source_url(input.source_url);
      if (!src.ok) {
        return { ok: false, model_id: '', specs: 0, gpu_options: 0, error: 'INVALID_SOURCE_URL', recovery: src.recovery };
      }
      const source_url = src.url;
      const store = getKristiWorkstationsStore();
      const model_id = input.model_id ? slug(input.model_id) : slug(input.model_name);
      store.upsert_sku({
        model_id,
        vendor: input.vendor,
        family: input.family,
        model_name: input.model_name,
        form_factor: input.form_factor,
        chassis_variant: input.chassis_variant ?? '',
        cpu_platform: input.cpu_platform,
        status: input.status,
        announced_at: input.announced_at ?? '',
        launched_at: input.launched_at ?? '',
        source_url,
        notes: input.notes ?? '',
      });
      for (const s of input.specs ?? []) {
        store.record_spec(model_id, s.spec_key, s.spec_value, s.unit ?? '', source_url);
      }
      for (const g of input.gpu_options ?? []) {
        store.record_gpu_option({
          model_id,
          gpu_name: g.gpu_name,
          gpu_class: g.gpu_class,
          vram_gb: g.vram_gb ?? null,
          tdp_w: g.tdp_w ?? null,
          source_url,
        });
      }
      const out = { ok: true, model_id, specs: (input.specs ?? []).length, gpu_options: (input.gpu_options ?? []).length };
      logAction(deps, ctx, 'record_sku', input, out);
      return out;
    },
  };
}

// ── update_sku (patch an already-recorded SKU — fix a misclassified field) ───
// record_sku requires the full 7-field SKU contract; re-supplying all of it
// just to flip one enum is the heavy-contract shape that spirals the model
// (the ThinkStation PGX sat misfiled as 'sff' for days — Kristi had no patch
// tool, Beatrice wrongly called the store insert-only, and an approved
// correction proposal pointed at a nonexistent `update_workstation`). This is
// the minimal-contract patch: model_id + only the field(s) to change.

const UpdateSkuIn = z
  .object({
    model_id: z
      .string()
      .min(1)
      .describe("Slug of the SKU to patch, e.g. 'lenovo-thinkstation-pgx' (find it with lookup_workstation). Must already exist."),
    vendor: Vendor.optional(),
    family: z.string().min(1).optional(),
    model_name: z.string().min(1).optional(),
    form_factor: FormFactor.optional().describe("Correct the chassis class, e.g. 'edge' for an ARM edge-AI box misfiled as 'sff'."),
    chassis_variant: z.string().optional(),
    cpu_platform: CpuPlatform.optional().describe("Correct the CPU platform, e.g. 'grace' for an NVIDIA GB10 Grace Blackwell SoC."),
    status: SkuStatus.optional(),
    announced_at: z.string().optional(),
    launched_at: z.string().optional(),
    source_url: z.string().min(1).optional().describe('Cite the source for the correction; omit to keep the existing source_url.'),
    notes: z.string().optional(),
  })
  .refine(
    (v) => Object.entries(v).some(([k, val]) => k !== 'model_id' && val !== undefined),
    { message: 'Pass model_id plus at least one field to change (e.g. form_factor, cpu_platform).' },
  );
const UpdateSkuOut = z.object({ error: z.string().optional(), recovery: z.string().optional(), ok: z.boolean(), model_id: z.string(), changed: z.array(z.string()) });

function make_update_sku(deps: ToolDeps): Tool<z.infer<typeof UpdateSkuIn>, z.infer<typeof UpdateSkuOut>> {
  return {
    name: 'update_sku',
    description:
      "Patch fields on an ALREADY-RECORDED workstation SKU — pass model_id plus ONLY the field(s) to change; everything else is left exactly as it is. Use this to CORRECT a misclassification (e.g. fix the ThinkStation PGX from form_factor 'sff' to 'edge' and cpu_platform to 'grace'). Find the model_id with lookup_workstation. To CREATE a new SKU, use record_sku instead. After changing form_factor or the capability envelope, re-run cluster_swimlanes so the lane stays accurate.",
    risk: 'write_internal',
    required_capabilities: ['write_workstation_intel'],
    input_schema: UpdateSkuIn,
    output_schema: UpdateSkuOut,
    idempotency_key: (i) => `update_sku:${slug(i.model_id)}:${hash(i)}`,
    async execute(input, ctx) {
      // Optional here — only a SUPPLIED citation has to be usable.
      let patch_source: string | undefined;
      if (input.source_url !== undefined) {
        const src = normalize_source_url(input.source_url);
        if (!src.ok) {
          return { ok: false, model_id: slug(input.model_id), changed: [], error: 'INVALID_SOURCE_URL', recovery: src.recovery };
        }
        patch_source = src.url;
      }
      const store = getKristiWorkstationsStore();
      const model_id = slug(input.model_id);
      const existing = store.get_sku(model_id);
      if (!existing) {
        throw new Error(
          `update_sku: no SKU with model_id '${model_id}'. Use lookup_workstation to find the right id, or record_sku to create it.`,
        );
      }
      const FIELDS = [
        'vendor', 'family', 'model_name', 'form_factor', 'chassis_variant',
        'cpu_platform', 'status', 'announced_at', 'launched_at', 'source_url', 'notes',
      ] as const;
      const merged = { ...existing };
      const changed: string[] = [];
      for (const f of FIELDS) {
        // source_url writes the NORMALIZED value, not the raw one.
        const v =
          f === 'source_url' ? patch_source : (input as unknown as Record<string, unknown>)[f];
        if (v !== undefined && v !== (existing as unknown as Record<string, unknown>)[f]) {
          (merged as unknown as Record<string, unknown>)[f] = v;
          changed.push(f);
        }
      }
      store.upsert_sku({
        model_id: existing.model_id,
        vendor: merged.vendor,
        family: merged.family,
        model_name: merged.model_name,
        form_factor: merged.form_factor,
        chassis_variant: merged.chassis_variant,
        cpu_platform: merged.cpu_platform,
        status: merged.status,
        announced_at: merged.announced_at,
        launched_at: merged.launched_at,
        source_url: merged.source_url,
        notes: merged.notes,
      });
      const out = { ok: true, model_id: existing.model_id, changed };
      logAction(deps, ctx, 'update_sku', input, out);
      return out;
    },
  };
}

// ── record_price ────────────────────────────────────────────────────────────

const RecordPriceIn = z.object({
  model_id: z.string().min(1),
  config_label: z.string().min(1).describe("Which configuration this price is for, e.g. 'base' or 'RTX PRO 6000 + 128GB'."),
  segment: PriceSegment,
  list_price: z.number().nullable().optional(),
  sale_price: z.number().nullable().optional(),
  currency: z.string().optional(),
  url: z.string().min(1).describe('Source page — full address; normalized on execute.'),
});
const RecordPriceOut = z.object({
  ok: z.boolean(),
  stored: z.boolean(),
  reason: z.string().optional().describe('Why the plausibility gate refused the write — re-read the source and correct the figure.'),
});

function make_record_price(deps: ToolDeps): Tool<z.infer<typeof RecordPriceIn>, z.infer<typeof RecordPriceOut>> {
  return {
    name: 'record_price',
    description:
      'Record one price observation for a SKU configuration + buyer segment (smb/prosumer/enterprise/edu/gov). At most one point per config/segment/day, so daily runs build a clean discount-over-time series. Pass list_price and, when on sale, sale_price; discount % is computed. A write-side plausibility gate rejects an impossible system price (stored:false + reason) — when that happens, re-read the source for the real figure rather than retrying the same number.',
    risk: 'write_internal',
    required_capabilities: ['write_workstation_intel'],
    input_schema: RecordPriceIn,
    output_schema: RecordPriceOut,
    idempotency_key: (i) => `record_price:${i.model_id}:${slug(i.config_label)}:${i.segment}:${new Date().toISOString().slice(0, 10)}`, // time-guard-ok: UTC day component of a dedup idempotency key
    async execute(input, ctx) {
      const verdict = getKristiWorkstationsStore().record_price({
        model_id: input.model_id,
        config_label: input.config_label,
        segment: input.segment,
        list_price: input.list_price ?? null,
        sale_price: input.sale_price ?? null,
        currency: input.currency,
        url: input.url,
      });
      const out = { ok: verdict.stored, stored: verdict.stored, ...(verdict.reason ? { reason: verdict.reason } : {}) };
      logAction(deps, ctx, 'record_price', input, out);
      return out;
    },
  };
}

// ── record_isv_cert ──────────────────────────────────────────────────────────

const RecordIsvIn = z.object({
  model_id: z.string().optional().describe("SKU slug, or omit for a vendor-wide cert."),
  vendor: Vendor,
  isv_name: z.string().min(1),
  isv_category: IsvCategory,
  gpu_support_note: z.string().optional(),
  mentions_geforce: z.boolean().optional().describe('True if the ISV explicitly mentions GeForce/consumer-GPU support.'),
  source_url: z.string().min(1).describe('The page you read this from — full address. Shape is checked on execute.'),
});
const RecordIsvOut = z.object({ error: z.string().optional(), recovery: z.string().optional(), ok: z.boolean() });

function make_record_isv_cert(deps: ToolDeps): Tool<z.infer<typeof RecordIsvIn>, z.infer<typeof RecordIsvOut>> {
  return {
    name: 'record_isv_cert',
    description:
      "Record an ISV certification / hardware-support fact: which ISV (Autodesk, SOLIDWORKS, Siemens, etc.) in which category (aec/me/pdm/fedgov/oem/healthcare) certifies a SKU or vendor, what it says about GPU support, and crucially whether it mentions GeForce/consumer GPUs vs pro-only. Always cite source_url.",
    risk: 'write_internal',
    required_capabilities: ['write_workstation_intel'],
    input_schema: RecordIsvIn,
    output_schema: RecordIsvOut,
    idempotency_key: (i) => `record_isv:${i.model_id ?? ''}:${slug(i.isv_name)}:${hash(i)}`,
    async execute(input, ctx) {
      const src = normalize_source_url(input.source_url);
      if (!src.ok) return { ok: false, error: 'INVALID_SOURCE_URL', recovery: src.recovery };
      getKristiWorkstationsStore().record_isv_cert({
        model_id: input.model_id ?? '',
        vendor: input.vendor,
        isv_name: input.isv_name,
        isv_category: input.isv_category,
        gpu_support_note: input.gpu_support_note ?? '',
        mentions_geforce: input.mentions_geforce ?? false,
        source_url: src.url,
      });
      const out = { ok: true };
      logAction(deps, ctx, 'record_isv_cert', input, out);
      return out;
    },
  };
}

// ── reconcile a leak sighting to a known SKU ─────────────────────────────────

const ReconcileIn = z.object({
  registry: Registry,
  cert_model_string: z.string().min(1),
  model_id: z.string().min(1).describe('The SKU this certified string belongs to (clears it from the leak radar).'),
});
const ReconcileOut = z.object({ ok: z.boolean() });

function make_reconcile_cert_sighting(deps: ToolDeps): Tool<z.infer<typeof ReconcileIn>, z.infer<typeof ReconcileOut>> {
  return {
    name: 'reconcile_cert_sighting',
    description:
      "Once you've identified which workstation a leaked cert-registry model-string belongs to, link it to the SKU. This clears it from the leak radar (it's no longer an unidentified pre-launch signal).",
    risk: 'write_internal',
    required_capabilities: ['write_workstation_intel'],
    input_schema: ReconcileIn,
    output_schema: ReconcileOut,
    idempotency_key: (i) => `reconcile:${i.registry}:${slug(i.cert_model_string)}`,
    async execute(input, ctx) {
      getKristiWorkstationsStore().match_cert_sighting(input.registry, input.cert_model_string, input.model_id);
      const out = { ok: true };
      logAction(deps, ctx, 'reconcile_cert_sighting', input, out);
      return out;
    },
  };
}

// ── record_projection (clearly-labeled inference) ───────────────────────────

const Confidence = z.enum(['low', 'medium', 'high']);

const ProjectionKind = z.enum(['tech_push', 'market_pull']);

const RecordProjectionIn = z.object({
  vendor: Vendor,
  swimlane: z.string().min(1).describe("The IDC/competitive lane, e.g. 'mid-xeon-w' or 'z4-class'. Use the SAME slug across the three OEMs so their projections compare."),
  projection_kind: ProjectionKind.default('tech_push').describe(
    "What this projection extrapolates FROM. 'tech_push' (default) = SUPPLY-side: this line's verified generational lineage + the public compute roadmap — 'where this line is GOING'. 'market_pull' = DEMAND-side: fuse the analyst/market signals you just ingested + this lane's persona/ICP/UCP demand profiles + the compute roadmap into 'where this lane NEEDS to go'. A lane can hold ONE of each — they're stored distinctly and shown side by side. Pick the kind that matches the basis you actually reasoned from; never relabel a lineage projection as market_pull.",
  ),
  projected_label: z.string().min(1).describe("tech_push: the next-gen SKU, e.g. 'HP Z4 G-next'. market_pull: the demand target, e.g. 'Entry lane — local-LLM-ready envelope'."),
  basis_models: z.array(z.string().min(1)).describe('The model_id lineage/anchor this projection extrapolates. tech_push: the recorded generations (e.g. Z4 G4/G5/G6). market_pull: the lane’s CURRENT SKUs whose envelope the demand is measured against.'),
  cpu_platform: z.string().min(1).describe('tech_push: projected CPU platform (e.g. next Intel Xeon W / AMD Threadripper Pro 9000). market_pull: the platform the demand REQUIRES, or "n/a" when the need is non-CPU (VRAM/accelerator).'),
  key_deltas: z.string().min(1).describe('tech_push: projected spec deltas vs the current gen (cores, memory, PCIe gen+lanes, GPU count/power, chassis). market_pull: the capability TARGETS the demand requires (e.g. "≥48GB VRAM for 70B-class local inference; ≥2 dual-slot pro GPUs"). Markdown ok.'),
  confidence: Confidence,
  falsifier: z.string().min(1).describe('What observation would falsify this projection (for market_pull: what would show the demand ISN’T there, e.g. analyst forecast revises the segment down).'),
  rationale_md: z.string().min(1).describe('The reasoning. tech_push: which gen-over-gen trend + which roadmap signals this extrapolates. market_pull: cite the DEMAND/MARKET BASIS explicitly — the analyst/market signals (tagged DIRECTIONAL), the persona/ICP/UCP demand, and the roadmap headroom they imply.'),
  source_urls: z.array(z.string().min(1)).describe('Grounding sources. tech_push: roadmap + lineage. market_pull: the analyst/market coverage + the ISV-workflow/demand pages it rests on.'),
});
const RecordProjectionOut = z.object({ ok: z.boolean() });

function make_record_projection(deps: ToolDeps): Tool<z.infer<typeof RecordProjectionIn>, z.infer<typeof RecordProjectionOut>> {
  return {
    name: 'record_projection',
    description:
      "Record a clearly-labeled INFERENCE about a swimlane — kept separate from real spec data, never stated as fact. Two kinds (set `projection_kind`): 'tech_push' (default) projects the OEM's NEXT-GEN SKU from that line's verified lineage + public roadmap ('where it's going'); 'market_pull' projects 'where this lane NEEDS to go' by fusing the freshly-ingested analyst/market signals + the lane's persona/ICP/UCP demand profiles + the roadmap. Use the same `swimlane` slug across the three OEMs so projections compare. Re-projecting the same (vendor, swimlane, kind) replaces it, so a lane can hold both a tech_push and a market_pull view. Always include a falsifier and source_urls.",
    risk: 'write_internal',
    required_capabilities: ['write_workstation_intel'],
    input_schema: RecordProjectionIn,
    output_schema: RecordProjectionOut,
    idempotency_key: (i) => `record_projection:${i.vendor}:${slug(i.swimlane)}:${i.projection_kind ?? 'tech_push'}:${hash(i)}`,
    async execute(input, ctx) {
      getKristiWorkstationsStore().record_projection({
        vendor: input.vendor,
        swimlane: input.swimlane,
        projection_kind: input.projection_kind,
        projected_label: input.projected_label,
        basis_models: input.basis_models,
        cpu_platform: input.cpu_platform,
        key_deltas: input.key_deltas,
        confidence: input.confidence,
        falsifier: input.falsifier,
        rationale_md: input.rationale_md,
        source_urls: input.source_urls,
      });
      const out = { ok: true };
      logAction(deps, ctx, 'record_projection', input, out);
      return out;
    },
  };
}

// ── record_commodity_price (per-OEM component price) ────────────────────────

const CommodityClass = z.enum(['gpu', 'cpu', 'memory', 'storage', 'psu', 'cooling', 'other']);

const RecordCommodityIn = z.object({
  commodity: z.string().min(1).describe("NORMALIZED canonical component name shared across OEMs so they compare, e.g. 'NVIDIA RTX 4000 Ada', 'Intel Xeon w7-3565X', '64GB DDR5-4800 ECC', '2TB NVMe Gen4 SSD'."),
  commodity_class: CommodityClass,
  vendor: Vendor,
  model_id: z.string().optional().describe('The platform the option was priced within (the configurator chassis); omit for a standalone price.'),
  price: z.number().nullable().describe("What THIS OEM charges for this component (the configurator add-on / delta price)."),
  price_kind: z.enum(['addon', 'config_delta', 'standalone', 'included']).optional().describe("How the price was quoted: 'addon' (à-la-carte option), 'config_delta' (vs base), 'standalone', or 'included'."),
  currency: z.string().optional(),
  url: z.string().min(1).describe('Source page — full address; normalized on execute.'),
});
const RecordCommodityOut = z.object({
  ok: z.boolean(),
  stored: z.boolean(),
  reason: z.string().optional().describe('Why the plausibility gate refused the write — re-read the source and correct the figure.'),
});

function make_record_commodity_price(deps: ToolDeps): Tool<z.infer<typeof RecordCommodityIn>, z.infer<typeof RecordCommodityOut>> {
  return {
    name: 'record_commodity_price',
    description:
      "Record what ONE OEM charges for ONE component at a point in time — the configurator à-la-carte / upgrade price. Use a NORMALIZED `commodity` name shared across OEMs so the same part compares (e.g. 'NVIDIA RTX 4000 Ada' priced at Dell vs HP vs Lenovo). Walk the configurator option stack and record each primary commodity (GPU, CPU, memory, storage, PSU) per vendor. One point per commodity/vendor/platform/day. Powers commodity_compare and the trend/outlook tools. Always cite the configurator url. A write-side plausibility gate rejects an impossible price or a >4× jump vs the series' own recent history (stored:false + reason) — re-read the source for the real figure rather than retrying the same number.",
    risk: 'write_internal',
    required_capabilities: ['write_workstation_intel'],
    input_schema: RecordCommodityIn,
    output_schema: RecordCommodityOut,
    idempotency_key: (i) => `record_commodity:${slug(i.commodity)}:${i.vendor}:${slug(i.model_id ?? '')}:${new Date().toISOString().slice(0, 10)}`, // time-guard-ok: UTC day component of a dedup idempotency key
    async execute(input, ctx) {
      const verdict = getKristiWorkstationsStore().record_commodity_price({
        commodity: input.commodity,
        commodity_class: input.commodity_class,
        vendor: input.vendor,
        model_id: input.model_id,
        price: input.price,
        price_kind: input.price_kind,
        currency: input.currency,
        url: input.url,
      });
      const out = { ok: verdict.stored, stored: verdict.stored, ...(verdict.reason ? { reason: verdict.reason } : {}) };
      logAction(deps, ctx, 'record_commodity_price', input, out);
      return out;
    },
  };
}

// ── record_radar_item (threats + net-new players) ───────────────────────────

const RadarKind = z.enum(['threat', 'new_player', 'platform_shift']);
const Severity = z.enum(['low', 'medium', 'high']);

const RecordRadarIn = z.object({
  kind: RadarKind.describe("'threat' (ARM/agentic/edge/cloud disruptor pressuring x86 workstations, e.g. NVIDIA N1X), 'new_player' (net-new vendor outside HP/Dell/Lenovo, e.g. BOXX, Puget), 'platform_shift' (industry move, e.g. agentic-ISV, Windows-on-ARM)."),
  name: z.string().min(1).describe("Stable name, e.g. 'NVIDIA N1X', 'BOXX', 'Windows-on-ARM agentic ISV'."),
  vendor_name: z.string().optional().describe('The maker/player (free text — not the tier-1 enum).'),
  summary: z.string().min(1).describe('What it is, in a sentence.'),
  thesis: z.string().optional().describe('Why it matters / how it pressures the traditional x86 workstation.'),
  attacks: z.string().optional().describe('Which segment/swimlane it pressures.'),
  severity: Severity,
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  status: z.enum(['rumored', 'announced', 'shipping', 'tracking']).optional(),
  ws_class: z
    .enum(['dtws', 'mws', 'rws', 'edge_ai', 'all'])
    .optional()
    .describe(
      "Workstation class this pressures — 'dtws' (desktop), 'mws' (mobile), 'rws' (rack), 'edge_ai', or 'all' for a genuinely cross-class threat (e.g. a Windows-on-ARM platform shift). Scopes the item to that class's Recon Desk tab; 'all' shows it in every tab. Omit to auto-derive from the name (defaults to 'all' when no class keyword is present).",
    ),
  source_url: z.string().min(1).describe('The page you read this from — full address. Shape is checked on execute, not by the schema.'),
});
const RecordRadarOut = z.object({ error: z.string().optional(), recovery: z.string().optional(), ok: z.boolean(), inserted: z.boolean() });

function make_record_radar_item(deps: ToolDeps): Tool<z.infer<typeof RecordRadarIn>, z.infer<typeof RecordRadarOut>> {
  return {
    name: 'record_radar_item',
    description:
      "Capture a workstation-adjacent THREAT/disruptor (ARM/agentic/edge/cloud — e.g. NVIDIA N1X with across-the-board agentic ISV support) or a NET-NEW PLAYER outside the tier-1 OEMs (BOXX, Puget Systems, Maingear, Lambda, Exxact, Velocity Micro…). Idempotent on (kind, name); returns inserted=true on first sighting. Bubble up the material/high-severity NEW ones to Jasper via propose_action. Always cite source_url.",
    risk: 'write_internal',
    required_capabilities: ['write_workstation_intel'],
    input_schema: RecordRadarIn,
    output_schema: RecordRadarOut,
    idempotency_key: (i) => `record_radar:${i.kind}:${slug(i.name)}:${hash(i)}`,
    async execute(input, ctx) {
      const { inserted } = getKristiWorkstationsStore().record_radar_item({
        kind: input.kind,
        name: input.name,
        vendor_name: input.vendor_name,
        summary: input.summary,
        thesis: input.thesis,
        attacks: input.attacks,
        severity: input.severity,
        confidence: input.confidence,
        status: input.status,
        ws_class: input.ws_class,
        source_url: input.source_url,
      });
      const out = { ok: true, inserted };
      logAction(deps, ctx, 'record_radar_item', input, out);
      return out;
    },
  };
}

// ── record_swimlane_profile (demand-side persona / ICP / UCP per lane) ───────

const WsClass = z.enum(['dtws', 'mws', 'rws', 'edge_ai']);
const ProfileKind = z.enum(['persona', 'icp', 'ucp']);

const RecordProfileIn = z.object({
  ws_class: WsClass.describe("Workstation class the lane belongs to: 'dtws' (desktop), 'mws' (mobile), 'rws' (rack), 'edge_ai'."),
  swimlane: z.string().min(1).describe('The capability-envelope lane this profile is for — use the SAME lane slug `cluster_swimlanes` assigned (read it with `swimlanes`).'),
  profile_kind: ProfileKind.describe("'persona' (the human role/seat), 'icp' (ideal customer — the org that SHOULD buy this lane), or 'ucp' (UNideal customer — who looks like a fit but should NOT buy here)."),
  title: z.string().min(1).describe("Short label, e.g. 'AEC BIM coordinator' (persona) / 'Mid-market AE firm, 50-200 seats' (icp) / 'Viewport-only CAD seat over-buying' (ucp)."),
  body_md: z.string().min(1).describe('The grounded writeup (GitHub-flavored markdown, tight).'),
  grounded_on: z.string().min(1).describe('The real ISV workflow / AI-agentic use case / OEM vertical whose COMPUTE DEMAND this profile derives from — the entry point of the grounding chain.'),
  capability_drivers: z.string().min(1).describe('Which envelope spec(s) make THIS lane the right fit (e.g. "single-thread clock + one pro GPU; not solver cores"). A profile must tie to a driver.'),
  segment: PriceSegment.optional().describe('Buyer segment for an ICP/persona (smb/prosumer/enterprise/edu/gov).'),
  geforce_vs_pro: z.string().optional().describe("persona/icp: does this seat's ISV stack permit GeForce/consumer or require RTX PRO? Flag it."),
  best_fit_by_oem: z.string().optional().describe('persona/icp: which OEM wins this seat and why (lean on hp_z_gaps).'),
  disqualifier: z.string().optional().describe('ucp ONLY: the compute mismatch that makes this buyer unideal here (the spec they would waste or starve).'),
  redirect_swimlane: z.string().optional().describe('ucp ONLY: the lane they ACTUALLY belong in. An unideal profile without a redirect is just a complaint — always provide one.'),
  redirect_reason: z.string().optional().describe('ucp ONLY: why that lane fits them instead.'),
  confidence: Confidence,
  falsifier: z.string().min(1).describe('What observation would prove this profile wrong.'),
  source_urls: z.array(z.string().min(1)).optional().describe('Grounding sources (ISV workflow / pricing / spec pages).'),
});
const RecordProfileOut = z.object({ ok: z.boolean() });

function make_record_swimlane_profile(deps: ToolDeps): Tool<z.infer<typeof RecordProfileIn>, z.infer<typeof RecordProfileOut>> {
  return {
    name: 'record_swimlane_profile',
    description:
      "Record a grounded DEMAND-SIDE profile for one swimlane — a persona (the human seat), an ICP (ideal customer org), or a UCP (UNideal customer + where they belong). Derive it BACKWARDS from a real workflow's compute demand → the capability driver that makes this lane fit → the buyer. Surfaced as the 'Who it's for' tap-down under the lane on the Recon Desk. A UCP MUST carry a redirect_swimlane. Keyed by (ws_class, swimlane, profile_kind, title); re-recording replaces. Always include grounded_on, capability_drivers, and a falsifier.",
    risk: 'write_internal',
    required_capabilities: ['write_workstation_intel'],
    input_schema: RecordProfileIn,
    output_schema: RecordProfileOut,
    idempotency_key: (i) => `record_swimlane_profile:${i.ws_class}:${slug(i.swimlane)}:${i.profile_kind}:${slug(i.title)}`,
    async execute(input, ctx) {
      getKristiWorkstationsStore().record_swimlane_profile({
        ws_class: input.ws_class,
        swimlane: input.swimlane,
        profile_kind: input.profile_kind,
        title: input.title,
        body_md: input.body_md,
        grounded_on: input.grounded_on,
        capability_drivers: input.capability_drivers,
        segment: input.segment,
        geforce_vs_pro: input.geforce_vs_pro,
        best_fit_by_oem: input.best_fit_by_oem,
        disqualifier: input.disqualifier,
        redirect_swimlane: input.redirect_swimlane,
        redirect_reason: input.redirect_reason,
        confidence: input.confidence,
        falsifier: input.falsifier,
        source_urls: input.source_urls,
      });
      const out = { ok: true };
      logAction(deps, ctx, 'record_swimlane_profile', input, out);
      return out;
    },
  };
}

// ── record_base_unit (the workstation PLATFORM cost basis) ───────────────────

const RecordBaseUnitIn = z.object({
  model_id: z.string().min(1).describe("SKU slug, e.g. 'lenovo-thinkstation-p3-gen2'."),
  vendor: Vendor,
  base_config_price: z
    .number()
    .positive()
    .describe(
      "The OEM's BASE / lowest 'starting at' configuration price as shown on the configurator (minimal CPU/GPU/RAM/SSD) — NOT a configured/upgraded price.",
    ),
  base_components: z
    .array(
      z.object({
        commodity_class: CommodityClass,
        commodity: z
          .string()
          .min(1)
          .describe(
            "Canonical commodity name MATCHING a standalone street price you've recorded (record_commodity_price, price_kind 'standalone') so it can be backed out — e.g. '32GB DDR5-6400 ECC RDIMM', '1TB NVMe Gen4 M.2 SSD', 'Intel Core Ultra 7 165'.",
          ),
      }),
    )
    .describe('The minimal commodities INCLUDED in that base config (CPU, GPU if any, RAM, SSD).'),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  note: z.string().optional().describe("Caveat (e.g. 'GPU-less base', 'CPU street not yet priced')."),
  source_url: z.string().min(1).describe('The page you read this from — full address. Shape is checked on execute, not by the schema.'),
});
const RecordBaseUnitOut = z.object({ error: z.string().optional(), recovery: z.string().optional(), ok: z.boolean(), model_id: z.string() });

function make_record_base_unit(deps: ToolDeps): Tool<z.infer<typeof RecordBaseUnitIn>, z.infer<typeof RecordBaseUnitOut>> {
  return {
    name: 'record_base_unit',
    description:
      "Record a workstation's BASE-UNIT (platform) cost basis: the OEM's lowest base/starting CONFIG price + the minimal commodities (CPU/GPU/RAM/SSD) that base includes. The Recon Desk derives the platform residual — chassis + PSU + motherboard + base margin — by backing those commodities out at their observed STREET price, so you compare what each OEM charges for the BOX ITSELF, stripped of swappable parts. Capture when you drive a configurator (the base price + its default components are right there). It's an ESTIMATE — the OEM marks its base commodities up over street, so the residual leans high; note that. Match each commodity name to a standalone street price you've recorded. Idempotent on model_id.",
    risk: 'write_internal',
    required_capabilities: ['write_workstation_intel'],
    input_schema: RecordBaseUnitIn,
    output_schema: RecordBaseUnitOut,
    idempotency_key: (i) => `record_base_unit:${i.model_id}:${hash(i)}`,
    async execute(input, ctx) {
      getKristiWorkstationsStore().record_base_unit({
        model_id: input.model_id,
        vendor: input.vendor,
        base_config_price: input.base_config_price,
        base_components: input.base_components,
        confidence: input.confidence,
        note: input.note,
        source_url: input.source_url,
      });
      const out = { ok: true, model_id: input.model_id };
      logAction(deps, ctx, 'record_base_unit', input, out);
      return out;
    },
  };
}

// ── record_benchmark_score (the performance axis) ───────────────────────────

const RecordBenchIn = z.object({
  component: z.string().min(1).describe("Canonical CPU/GPU commodity name (matches the price table's keys), e.g. 'NVIDIA RTX 4000 Ada', 'Intel Xeon w7-3565X'."),
  component_class: z.enum(['cpu', 'gpu']),
  benchmark: z.enum(['passmark_cpu', 'passmark_g3d', 'geekbench6_single', 'geekbench6_multi']).describe('Canonical benchmark key — scores only compare within one benchmark.'),
  score: z.number().positive(),
  source_url: z.string().min(1).describe('The page you read this from — full address. Shape is checked on execute, not by the schema.'),
});
const RecordBenchOut = z.object({
  ok: z.boolean(),
  stored: z.boolean(),
  reason: z.string().optional().describe('Why the plausibility gate refused the write — re-read the source.'),
});

function make_record_benchmark_score(deps: ToolDeps): Tool<z.infer<typeof RecordBenchIn>, z.infer<typeof RecordBenchOut>> {
  return {
    name: 'record_benchmark_score',
    description:
      "Record a benchmark score for a CPU/GPU commodity (PassMark CPU Mark / G3D, Geekbench 6) — the performance axis perf_per_dollar joins against street prices. Use the canonical component name so it matches the price table. Latest score wins (silicon doesn't drift). A plausibility gate rejects an impossible score or a benchmark/class mismatch (stored:false + reason) — re-read the source rather than retrying the same number. Always cite the benchmark page URL.",
    risk: 'write_internal',
    required_capabilities: ['write_workstation_intel'],
    input_schema: RecordBenchIn,
    output_schema: RecordBenchOut,
    idempotency_key: (i) => `record_benchmark:${slug(i.component)}:${i.benchmark}:${hash(i)}`,
    async execute(input, ctx) {
      const verdict = getKristiWorkstationsStore().record_benchmark_score({
        component: input.component,
        component_class: input.component_class,
        benchmark: input.benchmark,
        score: input.score,
        source_url: input.source_url,
      });
      const out = { ok: verdict.stored, stored: verdict.stored, ...(verdict.reason ? { reason: verdict.reason } : {}) };
      logAction(deps, ctx, 'record_benchmark_score', input, out);
      return out;
    },
  };
}

export function create(deps: ToolDeps): Tool[] {
  return [
    make_record_sku(deps),
    make_update_sku(deps),
    make_record_price(deps),
    make_record_commodity_price(deps),
    make_record_isv_cert(deps),
    make_reconcile_cert_sighting(deps),
    make_record_projection(deps),
    make_record_radar_item(deps),
    make_record_swimlane_profile(deps),
    make_record_base_unit(deps),
    make_record_benchmark_score(deps),
  ];
}
