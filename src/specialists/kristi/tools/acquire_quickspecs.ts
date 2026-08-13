/**
 * acquire_quickspecs — Kristi's FOCUSED spec-sheet acquisition job.
 *
 * QuickSpecs (HP), PSREF (Lenovo), and Dell spec sheets / technical guidebooks
 * are the AUTHORITATIVE source for a machine's supported configuration options +
 * MAXIMUMS — max cores, max memory, supported CPUs, supported GPUs, PCIe slots,
 * PSU wattage, sockets, storage. That capability envelope is exactly what the
 * (lane-aware) HP-Z gap view, the swimlane clustering, and the generational
 * projections run on — and it's been starved (sku_specs is thin), which is why
 * the gap view is sparse.
 *
 * Spec sheets carry NO pricing — only supported options + maximums. Pricing
 * stays on the configurator/reseller path (acquire_pricing / drive_configurator);
 * this job NEVER records a price. The two are complementary: one fills the spec
 * envelope, the other fills the price.
 *
 * For each brand-new ANNOUNCED machine (and any spec-thin SKU), this mirrors
 * acquire_pricing's proven shape:
 *   1. a model-targeted spec-doc query (vendor-aware: HP QuickSpecs / Lenovo
 *      PSREF / Dell spec sheet) through SearXNG;
 *   2. fetch the top authoritative hit ONCE (Firecrawl → the workstation fallback;
 *      Firecrawl extracts PDF text too) and file it onto her shelf;
 *   3. ONE bounded LLM call PER MODEL over the just-fetched spec text records the
 *      canonical config MAXIMUMS into sku_specs (record_spec) + the supported
 *      GPU list into gpu_options (record_gpu_option).
 * Bounded, no multi-round loop (same family as acquire_pricing / extract_layer).
 * "When available": a newly-announced model whose spec sheet isn't published yet
 * simply yields no good hit and is skipped, retried next run. The
 * compare/contrast/INFER is the EXISTING pipeline: cluster_swimlanes +
 * hp_z_gap_view + record_projection + assess_competitive_items.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  getKristiWorkstationsStore,
  type Vendor,
  type GpuClass,
  type SkuRow,
} from '@memory/stores/kristi_workstations';
import { make_ingest_to_library } from '@connectors/ingest_to_library';
import { fetch_with_browser_fallback } from '@connectors/fetch_with_browser_fallback';
import { web_search } from '@connectors/searxng';
import { BACKGROUND_MAX_AGE_MS } from '@connectors/search_router';
import { createHash } from 'node:crypto';

const DEFAULT_K = 4; // models per run (each is one bounded extraction call)
const DEFAULT_PER_QUERY = 4; // top search hits to consider per model
const DEFAULT_MIN_INTERVAL_HOURS = 72; // min gap before re-FETCHING a spec-doc URL
const DEFAULT_STALE_DAYS = 21; // a SKU's specs older than this get a re-check sweep
const MAX_EXTRACT_CHARS = 28_000;
const GPU_CLASSES = new Set<GpuClass>(['rtx_pro_blackwell', 'rtx_pro_ada', 'geforce', 'datacenter', 'other']);

// Official vendor domains — the AUTHORITATIVE spec-sheet sources (HP QuickSpecs,
// Dell spec sheets, Lenovo PSREF). Search hits on these are preferred so a
// third-party mirror never beats the vendor's own document.
const OFFICIAL_HOSTS: Record<string, string[]> = {
  hp: ['hp.com', 'hpe.com'],
  dell: ['dell.com'],
  lenovo: ['lenovo.com', 'psref.lenovo.com'],
  nvidia: ['nvidia.com'],
};
function is_official(vendor: string, url: string): boolean {
  try {
    const host = new URL(url).host.toLowerCase();
    return (OFFICIAL_HOSTS[vendor] || []).some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

const InputSchema = z
  .object({
    k: z.number().int().min(1).max(12).optional().describe('How many models to acquire spec sheets for this run.'),
    per_query: z.number().int().min(1).max(5).optional().describe('Top-N search hits to try per model.'),
    include_spec_thin: z
      .boolean()
      .default(true)
      .describe('Also target shipping SKUs that have few recorded specs, not just newly-announced ones.'),
    force: z.boolean().default(false).describe('Re-fetch + re-extract even if the spec doc is unchanged / fetched recently.'),
    min_interval_hours: z.number().min(0).optional(),
    stale_days: z.number().min(0).optional().describe('Re-check SKUs whose specs are older than this many days (catches mid-life CPU/platform refreshes).'),
    official_only: z.boolean().default(false).describe('Only fetch from official vendor domains (hp.com / dell.com / lenovo.com / nvidia.com).'),
  })
  .strict();
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
  ok: z.boolean(),
  targeted: z.number(),
  fetched: z.number(),
  /** Spec docs re-fetched but byte-identical to last time → extraction skipped. */
  unchanged: z.number(),
  specs_recorded: z.number(),
  /** Comparable specs REJECTED at the write gate as absolutely-implausible
   *  mis-reads (a 4.2M-GB memory figure, a 3595-"core" CPU model number) —
   *  kept OUT of sku_specs. >0 opens one process_miss to Beatrice. */
  specs_rejected: z.number(),
  gpus_recorded: z.number(),
  per_model: z.array(z.object({ model_id: z.string(), specs: z.number(), gpus: z.number(), changed: z.boolean().optional(), source: z.string().optional() })),
  failed: z.array(z.object({ model_id: z.string(), error: z.string() })),
  error: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

/** Isolate JSON from a model reply: drop a `<think>` block, strip a ```json
 *  fence, then slice first `{` to last `}` so a stray preamble can't break parse. */
function strip_fence(s: string): string {
  let t = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1]!.trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return t.trim();
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/** Vendor-aware spec-document search query for one model — biased toward the
 *  official document type on the vendor's own domain. (Hit ranking also prefers
 *  official hosts; this just nudges the search.) */
function spec_query(vendor: Vendor, model_name: string): string {
  switch (vendor) {
    case 'hp':
      return `${model_name} QuickSpecs specifications maximum memory supported processors graphics site:hp.com OR site:hpe.com`;
    case 'lenovo':
      return `${model_name} PSREF specifications maximum memory supported processors site:lenovo.com`;
    case 'dell':
      return `${model_name} spec sheet specifications maximum memory supported processors graphics site:dell.com`;
    case 'nvidia':
      return `${model_name} specifications datasheet site:nvidia.com`;
    default:
      return `${model_name} specifications maximum supported configuration datasheet`;
  }
}

// Canonical spec_keys to steer the model toward — these are the ones
// normalize_metric (hp_z_gap_view) and the swimlane clustering actually read, so
// recording them under these exact labels makes the comparisons light up.
const SPEC_INSTRUCTION =
  'You are a workstation SPEC-SHEET extractor reading an OFFICIAL spec document ' +
  '(HP QuickSpecs, Lenovo PSREF, or a Dell spec sheet / technical guidebook) for ONE model. ' +
  'FIRST verify the document is actually for the MODEL named in the request. Search self-heals ' +
  'against URL churn but sometimes returns the WRONG machine\'s sheet — if the document is clearly ' +
  'for a different model (different family / series / number, e.g. a Dell Precision 7920 when the ' +
  'request asked for a Pro Precision 9 T2), DO NOT record its specs: return an empty "specs" array ' +
  'and empty "gpus". Attributing another machine\'s numbers is far worse than recording nothing. ' +
  'Extract its SUPPORTED CONFIGURATION OPTIONS and MAXIMUMS — never a price (these documents ' +
  'carry no pricing; ignore anything that looks like one). Pull ONLY values present in the text; ' +
  'never invent a number. Prefer the MAXIMUM where a range/list is given (e.g. the top CPU = max cores).\n\n' +
  'Return ONLY a JSON object (no prose, no fence):\n' +
  '{\n' +
  '  "specs": [ {"spec_key":"<canonical label>","spec_value":"<value, include unit in the string>","unit":"<unit or empty>"} ],\n' +
  '  "gpus":  [ {"gpu_name":"<e.g. NVIDIA RTX PRO 6000 Blackwell>","gpu_class":"rtx_pro_blackwell|rtx_pro_ada|geforce|datacenter|other","vram_gb":<number or null>,"tdp_w":<number or null>} ]\n' +
  '}\n\n' +
  'Use these EXACT canonical spec_key labels where the document supports them (omit any not stated): ' +
  '"Max Cores", "Max Threads", "Supported CPUs", "Max Memory (GB)" (give the value in GB, or as "N TB"), ' +
  '"Memory Type", "Memory Slots", "Max GPUs", "Max PCIe Slots", "PCIe Lanes", "PSU (W)" (the highest POWER-SUPPLY-UNIT ' +
  'wattage offered — the figure that powers the WHOLE machine, so it must exceed the combined CPU + GPU draw; for a ' +
  'desktop/rack that is typically 300–2400 W. Do NOT mistake a CPU or GPU TDP for it — if the only wattage you can find ' +
  'is near a component TDP (~100–150 W) it is almost certainly NOT the PSU, so omit "PSU (W)" rather than record it), ' +
  '"Sockets", "Max Storage (TB)", "Form Factor", "Chassis". List EVERY supported discrete GPU in "gpus".\n\n' +
  'ACCURACY DISCIPLINE — for every numeric spec, record the number ANCHORED TO ITS UNIT for the MAXIMUM ' +
  'supported config: "Max Cores" = the core count of the HIGHEST CPU offered (the number before "cores", ' +
  'NOT DIMM slots, NOT a base/standard CPU, NOT a CPU model number); "Max Memory (GB)" = the largest total ' +
  'capacity (the number before GB/TB; give "4 TB" or "4096 GB", never multiply). SANITY-CHECK against the ' +
  'machine\'s tier: a modern workstation tower maxes roughly 8–96 cores, 64 GB–4 TB memory, 1–4 GPUs, ' +
  '1–2 sockets, 300–2400 W PSU. If a value you read falls FAR outside that (e.g. "max cores = 8" for an ' +
  'expert tower, or a 4-digit "core" number that is really a CPU model), you have mis-read it — re-read or ' +
  'OMIT it. A missing spec is fine; a wrong one corrupts every comparison built on it.';

export function create(deps: ToolDeps): Tool<Input, Output> {
  const ingest = make_ingest_to_library({
    library_deps: {
      db: deps.db,
      vault_root: deps.vault_root,
      memory: deps.memory,
      specialists: deps.specialists,
      runtime: deps.runtime,
      conversations: deps.conversations,
      llm: deps.llm,
      events: deps.events,
    },
    specialists: deps.specialists,
    users: deps.users,
  });

  return {
    name: 'acquire_quickspecs',
    description:
      "BACKGROUND JOB. For each ANNOUNCED workstation, spec-THIN SKU, or SKU whose specs are STALE (older than stale_days — catches mid-life CPU/platform refreshes), search the AUTHORITATIVE spec sheet on the vendor's OWN domain (HP QuickSpecs hp.com/hpe.com, Lenovo PSREF lenovo.com, Dell spec sheet dell.com — official hits preferred), fetch it (Firecrawl→the workstation; reads PDFs), file it, and re-extract ONLY when the document changed (SHA-256 content diff vs last sync) — recording canonical config MAXIMUMS into sku_specs + supported GPUs into gpu_options. Spec sheets carry NO pricing. Fills the capability envelope the gap view + swimlanes + projections run on.",
    risk: 'write_internal',
    required_capabilities: ['write_workstation_intel', 'query_web', 'browse_web', 'write_vault_any_library', 'write_process_miss'],
    weight: 'heavy',
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key() {
      return `acquire_quickspecs:${new Date().toISOString().slice(0, 13)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const store = getKristiWorkstationsStore();
      const k = input.k ?? DEFAULT_K;
      const per_query = input.per_query ?? DEFAULT_PER_QUERY;
      const min_ms = (input.min_interval_hours ?? DEFAULT_MIN_INTERVAL_HOURS) * 3_600_000;
      const stale_ms = (input.stale_days ?? DEFAULT_STALE_DAYS) * 86_400_000;
      const now = Date.now();

      // ── target selection ──────────────────────────────────────────────────
      // Priority: (1) newly ANNOUNCED, (2) SPEC-THIN, (3) STALE — a SKU whose
      // freshest recorded spec is older than `stale_days`. (3) is the mid-life
      // re-check: a shipping platform's spec sheet gains supported CPUs / GPUs /
      // memory through its life (CPU refreshes, platform refreshes), so a
      // well-specced SKU still needs a periodic re-read — the content-hash diff
      // below keeps that cheap when nothing actually changed.
      const announced = store.find_skus({ status: 'announced', limit: 60 });
      const seen = new Set(announced.map((s) => s.model_id));
      const targets: SkuRow[] = [...announced];
      const all = store.find_skus({ limit: 120 });
      if (input.include_spec_thin) {
        for (const s of all) {
          if (targets.length >= k * 3) break;
          if (seen.has(s.model_id)) continue;
          if (store.specs_for(s.model_id).length < 4) {
            targets.push(s);
            seen.add(s.model_id);
          }
        }
      }
      // Stale re-check — oldest-specs first so the catalog rotates through.
      const stale = all
        .filter((s) => !seen.has(s.model_id))
        .map((s) => {
          const specs = store.specs_for(s.model_id);
          const freshest = specs.reduce((mx, sp) => Math.max(mx, Date.parse(sp.captured_at) || 0), 0);
          return { sku: s, freshest };
        })
        .filter((x) => x.freshest > 0 && now - x.freshest > stale_ms)
        .sort((a, b) => a.freshest - b.freshest);
      for (const x of stale) {
        if (targets.length >= k * 3) break;
        targets.push(x.sku);
        seen.add(x.sku.model_id);
      }
      const queue = targets.slice(0, k);

      const failed: Output['failed'] = [];
      const per_model: Output['per_model'] = [];
      let fetched = 0;
      let unchanged = 0;
      let specs_recorded = 0;
      let specs_rejected = 0;
      let gpus_recorded = 0;
      let ok = true;
      // Absolutely-implausible comparable values the write gate threw out this
      // run — collected so a non-empty set opens ONE process_miss to Beatrice,
      // naming source + model + rejected metric/value for recurring-bad-
      // extraction triage.
      const rejections: Array<{ model_id: string; source_url: string; spec_key: string; spec_value: string; reason: string }> = [];

      for (const sku of queue) {
        // 1. search for the model's spec document.
        let hits: Array<{ title: string; url: string }> = [];
        try {
          const res = await web_search.execute(
            { query: spec_query(sku.vendor, sku.model_name), max_results: per_query, max_age_ms: BACKGROUND_MAX_AGE_MS },
            ctx,
          );
          if (res.error) { failed.push({ model_id: sku.model_id, error: `search: ${res.error}` }); ok = false; continue; }
          hits = res.results.slice(0, per_query);
          // Prefer the vendor's OWN document — official-domain hits first (and
          // only those when official_only). A third-party mirror never beats
          // hp.com / dell.com / lenovo.com / nvidia.com.
          const official = hits.filter((h) => is_official(sku.vendor, h.url || ''));
          hits = input.official_only ? official : [...official, ...hits.filter((h) => !official.includes(h))];
          if (!hits.length) { per_model.push({ model_id: sku.model_id, specs: 0, gpus: 0 }); continue; }
        } catch (err) {
          ok = false;
          failed.push({ model_id: sku.model_id, error: `search: ${err instanceof Error ? err.message : String(err)}` });
          continue;
        }

        // 2. fetch the first hit we can render (skip recently-synced unless forced),
        //    then DIFF: only re-extract when the document actually changed.
        let source_url = '';
        let markdown = '';
        let title: string | null = null;
        let changed = true;
        for (const h of hits) {
          if (!h.url) continue;
          const prior = store.get_source_sync(h.url);
          if (!input.force && prior && now - Date.parse(prior.synced_at) < min_ms) continue;
          try {
            const outcome = await fetch_with_browser_fallback(h.url, ctx, { title_fallback: h.title || undefined });
            if (outcome.kind !== 'firecrawl' && outcome.kind !== 'browser') continue;
            source_url = h.url;
            markdown = outcome.markdown;
            title = outcome.title;
            // Content diff: a spec sheet that's byte-identical to last time needs
            // no re-extraction (CPU/platform refreshes change the bytes → re-run).
            const hash = createHash('sha256').update(markdown).digest('hex');
            changed = input.force || !prior || prior.content_hash !== hash;
            store.record_source_sync(h.url, { content_hash: hash });
            if (changed) {
              try {
                await ingest.execute(
                  { target_specialist_id: 'kristi', markdown: outcome.markdown.slice(0, 200_000), title_hint: title || h.title || undefined },
                  ctx,
                );
              } catch {
                /* shelf-filing is non-critical */
              }
            }
            break;
          } catch {
            /* try the next hit */
          }
        }
        if (!markdown) {
          // No spec doc available yet (or all hits failed/recently-synced) — skip.
          per_model.push({ model_id: sku.model_id, specs: 0, gpus: 0 });
          continue;
        }
        fetched++;
        if (!changed) {
          // Spec sheet re-fetched but byte-identical — nothing new to extract.
          unchanged++;
          per_model.push({ model_id: sku.model_id, specs: 0, gpus: 0, changed: false, source: source_url });
          continue;
        }

        // 3. one bounded extraction over the just-fetched spec text.
        const user =
          `MODEL: ${sku.vendor.toUpperCase()} ${sku.model_name} (model_id ${sku.model_id})\n` +
          `Record its supported config maximums + supported GPUs from this spec sheet.\n\n` +
          `[source: ${source_url}]\n${markdown.slice(0, MAX_EXTRACT_CHARS)}`;
        let m_specs = 0;
        let m_gpus = 0;
        try {
          const role = deps.llm.for_role('research_extract');
          const resp = await role.provider.complete({
            messages: [
              { role: 'system', content: SPEC_INSTRUCTION },
              { role: 'user', content: user },
            ],
            max_tokens: 2000,
            think: false,
          });
          const parsed = JSON.parse(strip_fence(resp.content)) as {
            specs?: Record<string, unknown>[];
            gpus?: Record<string, unknown>[];
          };
          for (const r of Array.isArray(parsed.specs) ? parsed.specs : []) {
            const key = String(r.spec_key ?? '').trim();
            const value = String(r.spec_value ?? '').trim();
            if (!key || !value) continue;
            const k_clean = key.slice(0, 80);
            const v_clean = value.slice(0, 200);
            const res = store.record_spec(sku.model_id, k_clean, v_clean, String(r.unit ?? '').slice(0, 24), source_url);
            if (res.stored) {
              m_specs++;
              specs_recorded++;
            } else {
              specs_rejected++;
              rejections.push({ model_id: sku.model_id, source_url, spec_key: k_clean, spec_value: v_clean, reason: res.reason ?? 'implausible' });
            }
          }
          for (const r of Array.isArray(parsed.gpus) ? parsed.gpus : []) {
            const gpu_name = String(r.gpu_name ?? '').trim();
            if (!gpu_name) continue;
            const cls = String(r.gpu_class ?? 'other');
            store.record_gpu_option({
              model_id: sku.model_id,
              gpu_name: gpu_name.slice(0, 120),
              gpu_class: (GPU_CLASSES.has(cls as GpuClass) ? cls : 'other') as GpuClass,
              vram_gb: num(r.vram_gb),
              tdp_w: num(r.tdp_w),
              source_url,
            });
            m_gpus++;
            gpus_recorded++;
          }
        } catch (err) {
          ok = false;
          failed.push({ model_id: sku.model_id, error: `extract: ${err instanceof Error ? err.message : String(err)}` });
        }
        per_model.push({ model_id: sku.model_id, specs: m_specs, gpus: m_gpus, changed: true, source: source_url });
      }

      // Bridge to Beatrice: when the write gate threw out one or more
      // absolutely-implausible comparable values this run, open ONE
      // low-severity process_miss so recurring bad extraction (a source whose
      // sheet keeps mis-OCRing, an extractor prompt gap) is visible in the
      // channel she already consumes. Per-DAY evidence_ref so re-runs (the job
      // fires daily; idempotency_key is hourly) don't spam duplicates — dedup
      // against any still-open miss carrying the same ref.
      if (rejections.length > 0) {
        const day = new Date().toISOString().slice(0, 10); // time-guard-ok: UTC day evidence_ref dedup key (not user-facing)
        const evidence_ref = `kristi-spec-reject:${day}`;
        const already = deps.process_misses
          .list({ open_only: true })
          .some((m) => m.evidence_ref === evidence_ref);
        if (!already) {
          const detail = rejections
            .slice(0, 12)
            .map((r) => `- ${r.model_id} [${r.spec_key} = "${r.spec_value}"] — ${r.reason} (source: ${r.source_url})`)
            .join('\n');
          const more = rejections.length > 12 ? `\n…and ${rejections.length - 12} more.` : '';
          const gap =
            `Kristi's \`acquire_quickspecs\` write gate (\`validateSpec\`) rejected ` +
            `${rejections.length} absolutely-implausible comparable spec value(s) this run — ` +
            `parsed numbers that fall outside the metric's plausibility window (a memory ` +
            `figure in the millions of GB, a 4-digit "core" count that's really a CPU model ` +
            `number, etc.). These were kept OUT of sku_specs (correct — they'd poison the ` +
            `gap-view subtraction), but a recurring source/extractor producing them is a ` +
            `bad-extraction pattern worth a look: a spec sheet that keeps mis-OCRing, or a ` +
            `gap in the extraction prompt's accuracy discipline. Rejected this run:\n${detail}${more}`;
          const miss_id = deps.process_misses.create({
            subject_specialist_id: 'kristi',
            reporter: 'kristi',
            task_summary:
              `diagnosing why acquire_quickspecs extracted implausible comparable spec ` +
              `values (rejected at the write gate) — is a specific source/sheet or the ` +
              `extraction prompt the recurring cause?`,
            gap,
            severity: 'low',
            evidence_ref,
          });
          deps.memory.log_action({
            intent_id: ctx.intent_id,
            agent: ctx.specialist_id ?? 'kristi',
            tool_name: 'acquire_quickspecs_spec_reject',
            tool_input: { specs_rejected, evidence_ref },
            execution_result: { miss_id, rejections: rejections.slice(0, 12) },
          });
        }
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kristi',
        tool_name: 'acquire_quickspecs',
        tool_input: { k, include_spec_thin: input.include_spec_thin, stale_days: input.stale_days ?? DEFAULT_STALE_DAYS },
        execution_result: { ok, targeted: queue.length, fetched, unchanged, specs_recorded, specs_rejected, gpus_recorded },
      });
      return { ok, targeted: queue.length, fetched, unchanged, specs_recorded, specs_rejected, gpus_recorded, per_model, failed };
    },
  };
}
