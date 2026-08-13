/**
 * reconcile_leak_radar — Kristi's VERIFIED leak triage.
 *
 * The cert registries (DMTF Redfish, ENERGY STAR, TCO) list certified model
 * strings — but ENERGY STAR / TCO certify products at/after they SHIP, so a raw
 * "every unmatched cert string is a pre-launch leak" floods the radar with
 * long-shipping workstations. The radar is only valuable when Kristi has a
 * pulse on the ENTIRETY of what's already launched/announced and shows ONLY
 * what's genuinely new. Three mechanisms enforce that:
 *
 *   1. Deterministic catalog cross-reference first
 *      (reconcile_sightings_against_catalog) — cheap, always correct, and it
 *      gets stronger every run because of (3).
 *   2. WEB-EVIDENCE judgment for the rest. The old pass judged from model
 *      memory alone — anything launched after the model's training cutoff
 *      looked "unannounced" and landed on the radar as a fake leak (the live
 *      Precision 3490 / Pro Max Slim false positives). Now each pending
 *      sighting gets a bounded SearXNG search and the LLM classifies from the
 *      retrieved evidence; memory is only the tiebreak, and "unsure" defaults
 *      to in_market (keep the radar clean). Verdicts carry the evidence URL
 *      and a `market_checked_at` stamp.
 *   3. Verdicts FEED THE CATALOG. An in_market verdict that confidently
 *      identifies the retail product auto-records the SKU (announced/shipping,
 *      sourced to the evidence) and matches the sighting to it — so the known
 *      universe converges toward every launched + announced workstation, and
 *      the next sighting from that line reconciles deterministically.
 *
 * Pre-launch verdicts EXPIRE: rows unchecked for `recheck_days` re-enter the
 * worklist, so a leak that launches flips to in_market and drops off the
 * radar on its own. The radar read (store.leak_radar) shows ONLY verified
 * pre_launch rows; unverified sightings surface as a `pending` count.
 *
 * Bounded: ≤ k sightings per run (one search each + ONE LLM call), backfills
 * over runs. Scheduled after the cert sweeps and before the assess pass.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  getKristiWorkstationsStore,
  ws_class_from_nomenclature,
  type CertRegistry,
  type CertSightingRow,
  type FormFactor,
  type KristiWorkstationsStore,
  type SkuStatus,
  type Vendor,
  type WsClass,
} from '@memory/stores/kristi_workstations';
import { web_search } from '@connectors/searxng';
import { parse_rows_tolerant } from './_json_rows';

const InputSchema = z
  .object({
    k: z.number().int().min(1).max(30).optional().describe('Max sightings to verify in one pass (each costs one web search).'),
    recheck_days: z.number().int().min(1).max(60).optional().describe('Re-verify pre_launch verdicts older than this (default 10).'),
  })
  .strict();
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
  ok: z.boolean(),
  catalog_matched: z.number(),
  judged: z.number(),
  in_market: z.number(),
  pre_launch: z.number(),
  /** in_market verdicts that auto-recorded the identified SKU into the catalog. */
  catalog_enriched: z.number(),
  /** Of the judged, how many were expiry re-checks of an old pre_launch verdict. */
  rechecked: z.number(),
  /** Sightings still awaiting verification after this run (backlog). */
  pending_remaining: z.number(),
  error: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

const DEFAULT_K = 12;
const DEFAULT_RECHECK_DAYS = 10;

const VENDORS = new Set(['hp', 'dell', 'lenovo', 'nvidia', 'other']);
const FORM_FACTORS = new Set(['tower', 'rack', 'edge', 'mobile', 'sff', 'other']);

function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Representative form factor for a class — the fallback when the judge can't
 *  read one off the evidence (keeps an auto-recorded SKU in the right tab). */
function form_factor_for_class(c: WsClass): FormFactor {
  switch (c) {
    case 'mws': return 'mobile';
    case 'rws': return 'rack';
    case 'edge_ai': return 'edge';
    case 'dtws': return 'tower';
    default: return 'other';
  }
}

/**
 * Apply parsed judgment rows to the store: classify each sighting (with
 * evidence + freshness stamp), and for an in_market verdict that confidently
 * names the retail product, record the SKU + match the sighting to it (the
 * catalog-enrichment loop). Exported for the smoke — pure store effects, no
 * LLM/web inside.
 */
export function apply_reconcile_verdicts(
  store: KristiWorkstationsStore,
  pending: CertSightingRow[],
  rows: Record<string, unknown>[],
): { judged: number; in_market: number; pre_launch: number; catalog_enriched: number } {
  const byString = new Map(pending.map((s) => [s.cert_model_string.toLowerCase().trim(), s]));
  let judged = 0;
  let in_market = 0;
  let pre_launch = 0;
  let catalog_enriched = 0;
  for (const r of rows) {
    const cms = String(r.cert_model_string ?? '').toLowerCase().trim();
    const status = String(r.market_status ?? '');
    if (status !== 'pre_launch' && status !== 'in_market') continue;
    const sgt = byString.get(cms);
    if (!sgt) continue;
    const evidence = String(r.evidence_url ?? '');
    store.classify_cert_sighting(sgt.registry as CertRegistry, sgt.cert_model_string, status, String(r.reason ?? ''), evidence);
    judged++;
    if (status === 'pre_launch') {
      pre_launch++;
      continue;
    }
    in_market++;
    // Catalog enrichment: a confidently-identified in-market product becomes a
    // SKU row, so the deterministic pass owns this line from now on.
    const p = (r.product ?? null) as Record<string, unknown> | null;
    const model_name = String(p?.model_name ?? '').trim();
    if (!p || model_name.length < 6) continue;
    const vendor = (VENDORS.has(String(p.vendor)) ? String(p.vendor) : 'other') as Vendor;
    const ff_raw = String(p.form_factor ?? '');
    const form_factor = (FORM_FACTORS.has(ff_raw)
      ? ff_raw
      : form_factor_for_class(ws_class_from_nomenclature(sgt.cert_model_string))) as FormFactor;
    const status_raw = String(p.status ?? '');
    const sku_status = (status_raw === 'announced' ? 'announced' : 'shipping') as SkuStatus;
    const model_id = slug(model_name);
    if (!model_id) continue;
    store.upsert_sku({
      model_id,
      vendor,
      family: String(p.family ?? '').trim() || model_name,
      model_name: model_name.slice(0, 160),
      form_factor,
      chassis_variant: '',
      cpu_platform: 'other',
      status: sku_status,
      announced_at: '',
      launched_at: '',
      source_url: evidence || sgt.raw_url,
      notes: 'auto-recorded by reconcile_leak_radar (cert sighting verified in-market)',
    });
    store.match_cert_sighting(sgt.registry as CertRegistry, sgt.cert_model_string, model_id);
    catalog_enriched++;
  }
  return { judged, in_market, pre_launch, catalog_enriched };
}

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'reconcile_leak_radar',
    description:
      'BACKGROUND JOB. Verifies cert-registry sightings so the leak radar shows ONLY genuinely-unannounced platforms. Pass 1: deterministic catalog match against tracked announced/shipping SKUs. Pass 2: for each remaining sighting (plus expired pre_launch verdicts due a re-check), ONE bounded web search + one LLM judgment over the retrieved evidence — pre_launch (no retail launch found) vs in_market (already announced/shipping). An in_market verdict that identifies the product AUTO-RECORDS the SKU into the catalog, so the known universe converges toward everything launched + announced. Bounded per run; backfills.',
    risk: 'write_internal',
    required_capabilities: ['write_workstation_intel', 'query_web'],
    weight: 'heavy',
    input_schema: InputSchema,
    output_schema: OutputSchema,

    // Reporting-only: the fields are authoritative, but judges only unverified sightings; an empty backlog legitimately produces nothing.
    yield: { produced: ['judged'], considered: ['pending_remaining'], armed: false },
    idempotency_key() {
      const hour = new Date().toISOString().slice(0, 13);
      return `reconcile_leak_radar:${hour}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const store = getKristiWorkstationsStore();
      const k = input.k ?? DEFAULT_K;
      const recheck_days = input.recheck_days ?? DEFAULT_RECHECK_DAYS;

      // 1. Deterministic catalog cross-reference (cheap, always correct).
      const catalog_matched = store.reconcile_sightings_against_catalog();

      // 2. Worklist: never-judged sightings first (newest), then expired
      //    pre_launch verdicts due a re-check (a leak that launched must drop
      //    off). Both bounded by k — backfills across the twice-daily runs.
      const fresh = store.unclassified_sightings(k);
      const stale = fresh.length < k ? store.stale_pre_launch(recheck_days, k - fresh.length) : [];
      const pending = [...fresh, ...stale];
      const pending_remaining = () =>
        Math.max(0, store.unclassified_sightings(200).length);
      if (pending.length === 0) {
        return {
          ok: true, catalog_matched, judged: 0, in_market: 0, pre_launch: 0,
          catalog_enriched: 0, rechecked: 0, pending_remaining: 0,
        };
      }

      // 3. One bounded web search per sighting — the evidence the judgment
      //    rests on. A failed search degrades that sighting to knowledge-only
      //    (still biased to in_market when unsure), never fails the run.
      const evidence_blocks: string[] = [];
      for (let i = 0; i < pending.length; i++) {
        const s = pending[i]!;
        const despelled = s.cert_model_string.replace(/[-_]+/g, ' ').trim();
        const header = `${i + 1}. "${s.cert_model_string}" [${s.registry}${s.vendor_guess ? `, guess: ${s.vendor_guess}` : ''}]`;
        let lines = '   (no web evidence available — judge from knowledge; prefer in_market when unsure)';
        try {
          const sr = await web_search.execute(
            { query: `${s.vendor_guess ?? ''} ${despelled} workstation launch`.trim(), max_results: 4 },
            ctx,
          );
          const hits = (sr.results ?? []).slice(0, 4);
          if (hits.length > 0) {
            lines = hits
              .map((h) => `   - ${h.title.slice(0, 110)} (${h.url}) — ${h.snippet.replace(/\s+/g, ' ').slice(0, 200)}`)
              .join('\n');
          }
        } catch {
          /* keep the knowledge-only fallback line */
        }
        evidence_blocks.push(`${header}\n${lines}`);
      }

      const today = new Date().toISOString().slice(0, 10); // time-guard-ok: UTC day label for an internal judging prompt (not user-facing)
      const system =
        'You are a workstation-market analyst doing pre-launch leak triage. ' +
        `Today is ${today}. You are given certified model-strings from product registries (DMTF Redfish, ENERGY STAR, TCO), ` +
        'EACH with retrieved web evidence. Decide from the EVIDENCE FIRST (your own knowledge is only a tiebreak — products may have ' +
        'launched after your training data): pre_launch = NO announced or shipping retail product behind the string yet (the valuable ' +
        'early signal — typically no product page, no reviews, no store listing in the evidence); in_market = the product is already ' +
        'announced or shipping (product pages, spec sheets, reviews, store listings). ENERGY STAR/TCO mostly certify shipping products. ' +
        'When the evidence is thin or ambiguous, prefer in_market — the radar must stay clean. ' +
        'For every in_market verdict where the evidence names the retail product, include a `product` object identifying it. ' +
        'Reply with ONLY a JSON array, one object per input in order: ' +
        '[{"cert_model_string":"<verbatim>","market_status":"pre_launch|in_market","reason":"<≤20 words citing the evidence>",' +
        '"evidence_url":"<the single best source url, or empty>",' +
        '"product":{"vendor":"hp|dell|lenovo|nvidia|other","model_name":"<retail name, e.g. Dell Precision 3490>","family":"<line, e.g. Precision>","form_factor":"tower|sff|mobile|rack|edge|other","status":"announced|shipping"}}]. ' +
        'Omit `product` for pre_launch rows or when you cannot confidently name the product. No prose, no fence.';
      const user = `Classify these ${pending.length} certified model-strings:\n\n${evidence_blocks.join('\n\n')}`;

      let verdicts = { judged: 0, in_market: 0, pre_launch: 0, catalog_enriched: 0 };
      try {
        const role = deps.llm.for_role('research_extract');
        const resp = await role.provider.complete({
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_tokens: 2500,
          think: false,
        });
        verdicts = apply_reconcile_verdicts(store, pending, parse_rows_tolerant(resp.content));
      } catch (err) {
        deps.memory.log_action({
          intent_id: ctx.intent_id,
          agent: ctx.specialist_id ?? 'kristi',
          tool_name: 'reconcile_leak_radar',
          tool_input: { k, recheck_days },
          execution_result: { ok: false, error: err instanceof Error ? err.message : String(err) },
        });
        return {
          ok: false, catalog_matched, ...verdicts, rechecked: stale.length,
          pending_remaining: pending_remaining(),
          error: err instanceof Error ? err.message : String(err),
        };
      }

      const out = {
        ok: true, catalog_matched, ...verdicts, rechecked: stale.length,
        pending_remaining: pending_remaining(),
      };
      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kristi',
        tool_name: 'reconcile_leak_radar',
        tool_input: { k, recheck_days },
        execution_result: out,
      });
      return out;
    },
  };
}
