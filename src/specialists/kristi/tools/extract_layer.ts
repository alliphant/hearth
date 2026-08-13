/**
 * extract_workstation_layer — Kristi's FOCUSED per-layer extractor.
 *
 * The full deliberation pass kept getting cut short (flaky web_fetch_clean
 * spirals, round-budget exhausted re-recording SKUs) before it reached the
 * deeper layers — so prices / commodity / ISV stayed empty. This splits that
 * work into short, single-purpose passes: ONE layer, ONE bounded LLM call over
 * the clippings the scrapers ALREADY ingested (no web fetch, no multi-round
 * tool loop), recorded straight into the store. A flaky fetch can't starve it
 * and it can't spiral. Each layer is scheduled as its own background job, so
 * one failing doesn't affect the others.
 *
 * Extraction layers (data lifted from sources): skus, prices, commodity, isv,
 * radar. The `skus` layer is the deterministic catalog pass — it turns ingested
 * model clippings into SKU rows so the catalog never depends on the
 * discretionary deliberation pass (which advanced one layer per run and
 * under-catalogued the tail: no Lenovo, no HP Z2, only one ZBook). Projections
 * are synthesis (cross-gen + roadmap reasoning) and stay in deliberation.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  getKristiWorkstationsStore,
  type Vendor,
  type FormFactor,
  type CpuPlatform,
  type SkuStatus,
  type PriceSegment,
  type CommodityClass,
  type IsvCategory,
} from '@memory/stores/kristi_workstations';
import { parse_rows_tolerant } from './_json_rows';

const VENDORS = new Set(['hp', 'dell', 'lenovo', 'nvidia', 'other']);
const FORM_FACTORS = new Set(['tower', 'rack', 'edge', 'mobile', 'sff', 'other']);
const CPU_PLATFORMS = new Set(['xeon_w', 'threadripper_pro', 'arm', 'core_ultra', 'grace', 'other']);
const SKU_STATUSES = new Set(['leaked', 'announced', 'shipping', 'eol']);
const SEGMENTS = new Set(['smb', 'prosumer', 'enterprise', 'edu', 'gov']);
const COMMODITY_CLASSES = new Set(['gpu', 'cpu', 'memory', 'storage', 'psu', 'cooling', 'other']);
const ISV_CATEGORIES = new Set(['aec', 'me', 'pdm', 'fedgov', 'oem', 'healthcare', 'other']);
const RADAR_KINDS = new Set(['threat', 'new_player', 'platform_shift']);
const SEVERITIES = new Set(['low', 'medium', 'high']);

/** Stable slug for model_id — mirrors record_facts.ts so the deterministic
 *  extractor and the deliberation writer converge on the same primary key. */
function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const InputSchema = z
  .object({
    layer: z.enum(['skus', 'prices', 'commodity', 'isv', 'radar']),
    vendor: z
      .enum(['hp', 'dell', 'lenovo', 'nvidia'])
      .optional()
      .describe('skus layer only — scope the catalog pass to ONE vendor so the tail (Lenovo) gets a dedicated read HP/Dell can\'t crowd out of the top-k. Mirrors drive_configurator\'s one-OEM-per-job isolation.'),
    k: z.number().int().min(4).max(40).optional().describe('How many clipping chunks to read.'),
  })
  .strict();
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
  ok: z.boolean(),
  layer: z.string(),
  chunks_read: z.number(),
  recorded: z.number(),
  /** Rows the store's price-plausibility gate refused (misread/decimal-shift class). */
  rejected: z.number().optional(),
  error: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

const LAYER_QUERY: Record<Input['layer'], string> = {
  skus: 'workstation model lineup specifications tower mobile SFF mini rack ThinkStation Precision ZBook Z2 Z4 Z6 Z8 ThinkPad P-series form factor Xeon Threadripper',
  prices: 'price starting price configuration configure base USD cost',
  commodity: 'GPU CPU memory storage option upgrade add configure price RTX Xeon Threadripper',
  isv: 'certified ISV Autodesk SOLIDWORKS Siemens certification GPU support GeForce',
  radar: 'N1X ARM agentic ISV DGX Spark cloud virtual workstation BOXX Puget Maingear Lambda Exxact boutique builder disruptor',
};

/**
 * Vendor-scoped retrieval query for the skus layer — DELIBERATELY SHORT.
 * `retrieve_scoped_chunks` does an FTS5 **AND** of every token (OR only as a
 * zero-hit fallback), so a long query enumerating model names matches ONLY a
 * page containing ALL of them — i.e. one all-encompassing catalogue page (the HP
 * pass read exactly 1 chunk on 2026-06-04), and a query weighted with stale
 * model numbers ranks the OLD lineup over the current one (the Dell pass missed
 * the Pro Max line). Two tokens both present on every one of a vendor's pages
 * (`<vendor> workstation`) keeps the AND broad so the read spans the whole
 * shelf — single-model spec sheets AND catalogue pages, current naming included.
 */
const VENDOR_SKU_QUERY: Record<NonNullable<Input['vendor']>, string> = {
  hp: 'HP workstation',
  dell: 'Dell workstation',
  lenovo: 'Lenovo workstation',
  nvidia: 'NVIDIA workstation',
};

/** Per-vendor focus appended to the skus instruction when a pass is OEM-scoped. */
const VENDOR_FOCUS: Record<NonNullable<Input['vendor']>, string> = {
  hp: 'Focus ONLY on HP models. Enumerate HP\'s FULL workstation lineup across every form factor — Z2 Mini/SFF/Tower, Z1/Z4/Z6/Z8 towers, Z8 Fury, the ZBook mobile line (Fury/Power/Studio/Firefly/X), and Z-rack/ZCentral.',
  dell: 'Focus ONLY on Dell models. Enumerate Dell\'s FULL CURRENT workstation lineup across every form factor, using the EXACT current model names from the sources (prefer Dell\'s new "Pro Max" / "Pro Precision" branding over older "Precision N000" numbering when a page shows it): the Z2-class small-form line — Pro Max Micro, Pro Max Slim, Pro Max Tower T2, Pro Precision 7 T1 — the high-end towers Pro Precision 9 T2/T4/T6, the Pro Max mobile line, and any legacy Precision tower/mobile/SFF still listed.',
  lenovo: 'Focus ONLY on Lenovo models. Enumerate Lenovo\'s FULL ThinkStation + ThinkPad-P lineup across every form factor — P3/P5/P7/P8/PX towers, the Tiny/SFF small-form boxes, and the ThinkPad P-series mobile workstations.',
  nvidia: 'Focus ONLY on NVIDIA models — DGX Spark / IGX edge-AI boxes and the RTX PRO Blackwell workstation cards.',
};

const LAYER_INSTRUCTION: Record<Input['layer'], string> = {
  skus:
    'Extract WORKSTATION MODELS (SKUs) as a JSON array — every distinct workstation model named in the sources. Each item: ' +
    '{"model_id":"<stable slug, e.g. lenovo-thinkstation-p3-tower-g2 — or empty to derive from the name>","vendor":"hp|dell|lenovo|nvidia|other",' +
    '"family":"<product line, e.g. ThinkStation P3 / ZBook Fury / Precision 5000>","model_name":"<full model, e.g. Lenovo ThinkStation P3 Tower Gen 2>",' +
    '"form_factor":"tower|rack|edge|mobile|sff|other","cpu_platform":"xeon_w|threadripper_pro|arm|core_ultra|grace|other",' +
    '"status":"leaked|announced|shipping|eol","source":"<original vendor/article URL if visible, else the source path>",' +
    '"specs":[{"spec_key":"max_memory_gb|max_gpus|cpu|sockets|psu_w","spec_value":"<value>","unit":"<unit or omit>"}]}. ' +
    'form_factor drives the workstation CLASS the model is filed under (tower/sff = desktop, mobile = laptop WS, rack = rack WS, edge = edge-AI) — get it right. ' +
    'Record EVERY model you can identify, ESPECIALLY ones NOT already in the KNOWN list (Lenovo ThinkStation / ThinkPad P, HP Z2 Mini/SFF/Tower, the full ZBook line — Power/Studio/Firefly/X/Fury). Only models actually present in the sources; never invent one.',
  prices:
    'Extract WORKSTATION SYSTEM PRICES as a JSON array. Each item: ' +
    '{"model_id":"<one of the KNOWN model_ids>","config_label":"<normalized config, e.g. base or \'RTX PRO 6000 / 128GB / 2TB\'>",' +
    '"segment":"smb|prosumer|enterprise|edu|gov","list_price":<number USD>,"sale_price":<number or null>,"source":"<source path>"}. ' +
    'Use "prosumer" for a single-unit web price unless the source says otherwise. Only prices you can actually read.',
  commodity:
    'Extract PER-COMPONENT (commodity) prices as a JSON array — what an OEM charges to add/upgrade ONE component in its configurator. Each item: ' +
    '{"commodity":"<normalized component name, e.g. NVIDIA RTX 4000 Ada>","commodity_class":"gpu|cpu|memory|storage|psu|cooling|other",' +
    '"vendor":"hp|dell|lenovo","model_id":"<known model_id or empty>","price":<number USD>,"price_kind":"addon|config_delta|standalone|included","source":"<source path>"}. ' +
    'Normalize the commodity name so the same part matches across OEMs. Only prices you can read.',
  isv:
    'Extract ISV CERTIFICATION facts as a JSON array. Each item: ' +
    '{"model_id":"<known model_id or empty>","vendor":"hp|dell|lenovo|nvidia|other","isv_name":"<e.g. Autodesk>","isv_category":"aec|me|pdm|fedgov|oem|healthcare|other",' +
    '"gpu_support_note":"<short>","mentions_geforce":<true|false>,"source":"<source path>"}. ' +
    'Set mentions_geforce true only if the source explicitly mentions GeForce/consumer-GPU support.',
  radar:
    'Extract workstation-adjacent THREATS and NET-NEW PLAYERS as a JSON array. Each item: ' +
    '{"kind":"threat|new_player|platform_shift","name":"<e.g. NVIDIA N1X / BOXX / Windows-on-ARM agentic ISV>",' +
    '"vendor_name":"<maker>","summary":"<what it is>","thesis":"<why it pressures the x86 workstation>",' +
    '"attacks":"<which segment>","severity":"low|medium|high","status":"rumored|announced|shipping|tracking","source":"<source path>"}. ' +
    'threat = ARM/agentic/edge/cloud disruptor (e.g. N1X); new_player = a vendor OUTSIDE HP/Dell/Lenovo/NVIDIA (BOXX, Puget, Maingear, Lambda, Exxact, Velocity Micro); platform_shift = an industry move. Only items actually present in the sources.',
};

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'extract_workstation_layer',
    description:
      "BACKGROUND JOB. Focused single-layer extractor: read the clippings already on Kristi's shelf and lift ONE layer of structured rows (skus | prices | commodity | isv | radar) into the store via one bounded LLM call. No web fetch, no multi-round loop — can't spiral. Scheduled per layer so a failure in one doesn't starve the others. The skus layer catalogs models deterministically (idempotent on model_id); projections stay in deliberation.",
    risk: 'write_internal',
    required_capabilities: ['read_vault', 'write_workstation_intel'],
    weight: 'heavy',
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const hour = new Date().toISOString().slice(0, 13);
      return `extract_workstation_layer:${input.layer}:${input.vendor ?? 'all'}:${hour}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const store = getKristiWorkstationsStore();
      // skus layer can be OEM-scoped (one focused read per vendor); every other
      // layer uses its single global query.
      const query =
        input.layer === 'skus' && input.vendor ? VENDOR_SKU_QUERY[input.vendor] : LAYER_QUERY[input.layer];
      const chunks = deps.memory.retrieve_scoped_chunks({
        query,
        knowledge_scope: ['Knowledge/Kristi/**'],
        k: input.k ?? 24,
        bypass_private: true,
      });
      if (chunks.length === 0) {
        return { ok: true, layer: input.layer, chunks_read: 0, recorded: 0 };
      }

      const known = store
        .find_skus({ limit: 80 })
        .map((s) => `${s.model_id} = ${s.vendor} ${s.model_name}`)
        .join('\n');
      const sources = chunks
        .map((c) => `[source: ${c.note_path}]\n${c.chunk_text}`)
        .join('\n\n---\n\n')
        .slice(0, 24_000);

      const vendor_focus = input.layer === 'skus' && input.vendor ? ' ' + VENDOR_FOCUS[input.vendor] : '';
      const system =
        'You are a workstation-market data extractor. Pull ONLY facts present in the provided sources — never invent a number or a model. ' +
        'Attribute each row to the [source: ...] path it came from. ' +
        LAYER_INSTRUCTION[input.layer] +
        vendor_focus +
        ' Reply with ONLY the JSON array (no prose, no fence).';
      const user = `KNOWN model_ids (map rows to these; use empty string if none fits):\n${known || '(none yet)'}\n\nSOURCES:\n${sources}`;

      let recorded = 0;
      let rejected = 0;
      try {
        const role = deps.llm.for_role('research_extract');
        const resp = await role.provider.complete({
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          // A full vendor lineup (skus) is the largest output — 2000 truncated
          // mid-array. 4096 fits an OEM's catalogue; the tolerant parser below
          // still salvages a truncated tail if a lineup overflows even this.
          max_tokens: 4096,
          think: false,
        });
        const rows = parse_rows_tolerant(resp.content);

        for (const r of rows) {
          try {
            const source = String(r.source ?? chunks[0]?.note_path ?? 'Knowledge/Kristi/library');
            if (input.layer === 'skus') {
              const vendor = String(r.vendor ?? '');
              const model_name = String(r.model_name ?? '').trim();
              const ff = String(r.form_factor ?? '');
              const cpu = String(r.cpu_platform ?? 'other');
              const status = String(r.status ?? 'announced');
              if (!model_name || !VENDORS.has(vendor) || !FORM_FACTORS.has(ff)) continue;
              // OEM-scoped pass records only its own vendor's models — a stray
              // cross-vendor row belongs to that vendor's own pass.
              if (input.vendor && vendor !== input.vendor) continue;
              const model_id = slug(String(r.model_id ?? '').trim() || model_name);
              store.upsert_sku({
                model_id,
                vendor: vendor as Vendor,
                family: (String(r.family ?? '').trim() || model_name).slice(0, 80),
                model_name: model_name.slice(0, 160),
                form_factor: ff as FormFactor,
                chassis_variant: String(r.chassis_variant ?? '').slice(0, 80),
                cpu_platform: (CPU_PLATFORMS.has(cpu) ? cpu : 'other') as CpuPlatform,
                status: (SKU_STATUSES.has(status) ? status : 'announced') as SkuStatus,
                announced_at: String(r.announced_at ?? '').slice(0, 40),
                launched_at: String(r.launched_at ?? '').slice(0, 40),
                source_url: source,
                notes: String(r.notes ?? '').slice(0, 280),
              });
              for (const s of (Array.isArray(r.specs) ? r.specs : []) as Record<string, unknown>[]) {
                const sk = String(s.spec_key ?? '').trim();
                const sv = String(s.spec_value ?? '').trim();
                if (sk && sv) store.record_spec(model_id, sk.slice(0, 60), sv.slice(0, 120), String(s.unit ?? '').slice(0, 24), source);
              }
              recorded++;
            } else if (input.layer === 'prices') {
              const model_id = String(r.model_id ?? '').trim();
              const list_price = num(r.list_price);
              const sale_price = num(r.sale_price);
              const segment = (SEGMENTS.has(String(r.segment)) ? String(r.segment) : 'prosumer') as PriceSegment;
              if (!model_id || (list_price === null && sale_price === null)) continue;
              const verdict = store.record_price({
                model_id,
                config_label: String(r.config_label ?? 'base').slice(0, 120),
                segment,
                list_price,
                sale_price,
                url: source,
              });
              if (!verdict.stored) { rejected++; continue; }
              recorded++;
            } else if (input.layer === 'commodity') {
              const commodity = String(r.commodity ?? '').trim();
              const vendor = String(r.vendor ?? '');
              const price = num(r.price);
              const cls = String(r.commodity_class ?? 'other');
              if (!commodity || !VENDORS.has(vendor) || price === null) continue;
              const verdict = store.record_commodity_price({
                commodity: commodity.slice(0, 120),
                commodity_class: (COMMODITY_CLASSES.has(cls) ? cls : 'other') as CommodityClass,
                vendor: vendor as Vendor,
                model_id: String(r.model_id ?? '').trim(),
                price,
                price_kind: String(r.price_kind ?? 'addon'),
                url: source,
              });
              if (!verdict.stored) { rejected++; continue; }
              recorded++;
            } else if (input.layer === 'isv') {
              const isv_name = String(r.isv_name ?? '').trim();
              const vendor = String(r.vendor ?? '');
              const cat = String(r.isv_category ?? 'other');
              if (!isv_name || !VENDORS.has(vendor)) continue;
              store.record_isv_cert({
                model_id: String(r.model_id ?? '').trim(),
                vendor: vendor as Vendor,
                isv_name: isv_name.slice(0, 120),
                isv_category: (ISV_CATEGORIES.has(cat) ? cat : 'other') as IsvCategory,
                gpu_support_note: String(r.gpu_support_note ?? '').slice(0, 280),
                mentions_geforce: r.mentions_geforce === true,
                source_url: source,
              });
              recorded++;
            } else {
              // radar — threats + net-new players
              const kind = String(r.kind ?? '');
              const name = String(r.name ?? '').trim();
              const sev = String(r.severity ?? 'medium');
              if (!name || !RADAR_KINDS.has(kind)) continue;
              store.record_radar_item({
                kind: kind as 'threat' | 'new_player' | 'platform_shift',
                name: name.slice(0, 120),
                vendor_name: String(r.vendor_name ?? '').slice(0, 80),
                summary: String(r.summary ?? '').slice(0, 400),
                thesis: String(r.thesis ?? '').slice(0, 400),
                attacks: String(r.attacks ?? '').slice(0, 200),
                severity: (SEVERITIES.has(sev) ? sev : 'medium') as 'low' | 'medium' | 'high',
                status: String(r.status ?? 'tracking'),
                source_url: source,
              });
              recorded++;
            }
          } catch {
            /* skip a malformed row, keep going */
          }
        }
      } catch (err) {
        deps.memory.log_action({
          intent_id: ctx.intent_id,
          agent: ctx.specialist_id ?? 'kristi',
          tool_name: 'extract_workstation_layer',
          tool_input: { layer: input.layer },
          execution_result: { ok: false, error: err instanceof Error ? err.message : String(err) },
        });
        return { ok: false, layer: input.layer, chunks_read: chunks.length, recorded, error: err instanceof Error ? err.message : String(err) };
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kristi',
        tool_name: 'extract_workstation_layer',
        tool_input: { layer: input.layer },
        execution_result: { ok: true, chunks_read: chunks.length, recorded, rejected },
      });
      return { ok: true, layer: input.layer, chunks_read: chunks.length, recorded, rejected };
    },
  };
}
