/**
 * assess_competitive_items — Kristi's per-item ANALYTICAL ASSESSMENT writer.
 *
 * The Recon Desk pane rows (a new announcement, a competitive threat, a
 * projection, an HP-Z gap, a commodity price spread, a pre-launch leak) each
 * deserve more than a one-line field on tap — they deserve Kristi's VIEW: what
 * it is, why it matters competitively, the delta a buyer actually feels, and
 * her read (confirmed / announced / leaked, with a confidence). This job writes
 * that durably so the pane can reveal it instantly (the pane's `detail_md`) —
 * no live LLM call on the tap path.
 *
 * Pattern mirrors the other Kristi background jobs (extract_workstation_layer /
 * cluster_swimlanes): bounded, no multi-round spiral, off the conversation
 * path. It enumerates the pane's items from the structured store, and for each
 * that is UNASSESSED or whose underlying data has MOVED (a `subject_hash`
 * mismatch) writes a focused assessment — so "every item stays current" without
 * rewriting all of them every day. Capped at `k` items per run; over a few runs
 * the backlog fills, then it just refreshes what changed. Material items (new
 * announcements, threats, projections, leaks) get the deep model
 * (`deep_consult`); routine items get the standard role. Each item is its own
 * bounded call grounded in her shelf clippings; a failure on one is logged and
 * skipped, never fatal.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  getKristiWorkstationsStore,
  type AssessmentSubject,
  type Confidence,
} from '@memory/stores/kristi_workstations';

const DEFAULT_K = 6; // items assessed per run (bounded; deep-model calls are heavy)

const InputSchema = z
  .object({
    k: z.number().int().min(1).max(20).optional().describe('How many items to (re)assess this run.'),
    subject_types: z
      .array(z.enum(['sku', 'radar_item', 'projection', 'swimlane', 'hp_gap', 'commodity', 'leak']))
      .optional()
      .describe('Restrict to these item kinds. Omit for all.'),
    force: z.boolean().default(false).describe('Re-assess even items whose data is unchanged.'),
  })
  .strict();
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
  ok: z.boolean(),
  candidates: z.number(),
  needing: z.number(),
  assessed: z.number(),
  total_assessments: z.number(),
  /** Per-item failure breakdown — so a 0-assessed run is diagnosable without a
   *  code change (parse = bad JSON from the model, llm = provider error,
   *  empty = model returned no assessment_md). */
  fails: z.object({ parse: z.number(), empty: z.number(), llm: z.number() }).optional(),
  error: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

/** A pane item that can carry an assessment. `salient` is hashed to detect
 *  movement; `context` + `sources` ground the writeup. */
interface Candidate {
  subject_type: AssessmentSubject;
  subject_key: string;
  label: string;
  salient: string;
  context: string;
  sources: Array<{ title?: string; url: string }>;
  material: boolean; // → deep model
}

/** Robustly isolate the JSON object/array from a model reply: drop any
 *  `<think>…</think>` reasoning block (Qwen reasoning models emit one), strip a
 *  ```json fence, then slice from the first `{`/`[` to the last `}`/`]` so a
 *  stray preamble can't break JSON.parse. */
function strip_fence(s: string): string {
  let t = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) t = fence[1].trim();
  const start = Math.min(
    ...[t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0).concat([Infinity]),
  );
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (Number.isFinite(start) && end > start) t = t.slice(start, end + 1);
  return t.trim();
}

function hash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

/** Distinct, non-empty source URLs, capped. */
function dedupe_sources(rows: Array<{ title?: string; url: string }>): Array<{ title?: string; url: string }> {
  const seen = new Set<string>();
  const out: Array<{ title?: string; url: string }> = [];
  for (const r of rows) {
    const url = (r.url ?? '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(r.title ? { title: r.title, url } : { url });
    if (out.length >= 6) break;
  }
  return out;
}

const SYSTEM =
  "You are Kristi, the household's workstation competitive-intelligence analyst. Write your " +
  'ANALYTICAL ASSESSMENT — your VIEW — of ONE market item for a reader who tapped it open. ' +
  'Cover, tightly: what it is; why it matters competitively (the delta a buyer actually feels — ' +
  'cores / memory bandwidth / PCIe lanes / GPU power / chassis / price); how it pressures or ' +
  'defends against rivals and the ARM/edge wave where relevant; and YOUR read. Label each claim ' +
  'confirmed (shipping/spec sheet), announced (vendor claim, unmeasured), or leaked (cert string ' +
  'only). Ground everything in the provided context — NEVER invent a number or a model. If the ' +
  "data is thin, say so. You love this stuff and it shows, but enthusiasm never outruns the data. " +
  'Reply with ONLY a JSON object (no prose, no fence): ' +
  '{"headline":"<one-line takeaway, <=120 chars>","assessment_md":"<2-5 short paragraphs or tight ' +
  'bullets, GitHub-flavored markdown, no top-level heading>","confidence":"low|medium|high"}.';

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'assess_competitive_items',
    description:
      "BACKGROUND JOB. Write Kristi's per-item analytical assessment (her VIEW) for the Recon Desk pane's tap-through detail. Enumerates pane items (SKUs/moves, threats, projections, swimlanes, HP-gaps, commodities, leaks) and (re)assesses those that are new or have MOVED (subject_hash mismatch), bounded to `k` per run. Material items use the deep model; each writeup is grounded in her shelf clippings. Stored as `assessments`; surfaced as the pane's `detail_md`. No live call on the tap path.",
    risk: 'write_internal',
    required_capabilities: ['read_workstation_intel', 'write_workstation_intel', 'read_vault', 'consult_deep_model'],
    weight: 'heavy',
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const t = (input.subject_types ?? ['all']).slice().sort().join(',');
      return `assess_competitive_items:${t}:${new Date().toISOString().slice(0, 13)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const store = getKristiWorkstationsStore();
      const want = new Set<AssessmentSubject>(
        input.subject_types ?? ['sku', 'radar_item', 'projection', 'swimlane', 'hp_gap', 'commodity', 'leak'],
      );
      const candidates: Candidate[] = [];

      // ── enumerate pane items from the structured store ────────────────────
      if (want.has('sku')) {
        for (const s of store.find_skus({ limit: 80 })) {
          const specs = store.specs_for(s.model_id).map((sp) => `${sp.spec_key}=${sp.spec_value}${sp.unit ? ' ' + sp.unit : ''}`);
          const gpus = store.gpu_options_for(s.model_id).map((g) => g.gpu_name);
          const prices = store.latest_prices(s.model_id).map((p) => `${p.config_label}: $${p.sale_price ?? p.list_price ?? '?'}`);
          candidates.push({
            subject_type: 'sku',
            subject_key: s.model_id,
            // model_name already carries the brand — no vendor prefix (it doubled
            // as "DELL Dell …" / "NVIDIA NVIDIA …").
            label: s.model_name,
            salient: `${s.status}|${s.cpu_platform}|${specs.join(';')}|${gpus.join(',')}|${prices.join(',')}`,
            context: `SKU: ${s.vendor} ${s.model_name} (${s.family}, ${s.form_factor}, ${s.cpu_platform}); status ${s.status}; chassis ${s.chassis_variant || 'n/a'}; swimlane ${s.swimlane || 'unassigned'}.\nSpecs: ${specs.join('; ') || 'none recorded'}.\nGPU options: ${gpus.join(', ') || 'none'}.\nLatest prices: ${prices.join('; ') || 'none recorded'}.\nNotes: ${s.notes || 'none'}.`,
            sources: dedupe_sources([{ title: s.model_name, url: s.source_url }]),
            material: s.status === 'leaked' || s.status === 'announced',
          });
        }
      }

      if (want.has('radar_item')) {
        for (const r of store.radar({ limit: 50 })) {
          candidates.push({
            subject_type: 'radar_item',
            subject_key: `${r.kind}:${r.name}`,
            label: r.name,
            salient: `${r.severity}|${r.status}|${r.summary}|${r.thesis}`,
            context: `Radar item (${r.kind.replace('_', ' ')}): ${r.name}${r.vendor_name ? ` by ${r.vendor_name}` : ''}.\nSummary: ${r.summary}\nThesis: ${r.thesis || 'none'}\nAttacks: ${r.attacks || 'n/a'}\nSeverity ${r.severity}, status ${r.status}.`,
            sources: dedupe_sources([{ url: r.source_url }]),
            material: r.severity === 'high' || r.kind === 'threat',
          });
        }
      }

      if (want.has('projection')) {
        for (const p of store.list_projections()) {
          // Key by kind too: a lane can hold both a tech_push and a market_pull
          // projection, each with its own assessment.
          const kind_label = p.projection_kind === 'market_pull' ? 'market-pull (demand-side)' : 'tech-push (lineage)';
          candidates.push({
            subject_type: 'projection',
            subject_key: `${p.vendor}:${p.swimlane}:${p.projection_kind}`,
            label: p.projected_label,
            salient: `${p.projection_kind}|${p.cpu_platform}|${p.key_deltas}|${p.confidence}`,
            context: `${kind_label} projection (labeled INFERENCE) for ${p.vendor.toUpperCase()} in the ${p.swimlane} lane: ${p.projected_label}.\nProjected platform: ${p.cpu_platform}\nKey ${p.projection_kind === 'market_pull' ? 'demand targets' : 'deltas'}: ${p.key_deltas}\nBasis: ${p.basis_models}\nFalsifier: ${p.falsifier}\nRationale: ${p.rationale_md}`,
            sources: dedupe_sources((p.source_urls || '').split('\n').filter(Boolean).map((url) => ({ url }))),
            material: true,
          });
        }
      }

      if (want.has('swimlane')) {
        for (const l of store.swimlane_view().filter((x) => x.swimlane)) {
          const member_srcs = l.members.map((m) => store.get_sku(m.model_id)).filter(Boolean).map((s) => ({ title: s!.model_name, url: s!.source_url }));
          candidates.push({
            subject_type: 'swimlane',
            subject_key: l.swimlane,
            label: l.swimlane,
            salient: l.members.map((m) => m.model_id).sort().join(','),
            context: `Competitive swimlane "${l.swimlane}" (grouped by capability envelope, not vendor). Members: ${l.members.map((m) => m.model_name).join('; ')}.`,
            sources: dedupe_sources(member_srcs),
            material: false,
          });
        }
      }

      if (want.has('hp_gap')) {
        for (const g of store.hp_z_gap_view()) {
          if (g.hp_best === null || g.rival_best === null) continue;
          candidates.push({
            subject_type: 'hp_gap',
            subject_key: `${g.ws_class}::${g.swimlane}::${g.spec_key}`,
            label: `${g.ws_class.toUpperCase()} · ${g.swimlane} · ${g.spec_key}`,
            salient: `${g.hp_best}|${g.hp_model}|${g.rival_best}|${g.rival_model}`,
            context:
              `HP-Z competitive position in the ${g.ws_class.toUpperCase()} class, "${g.swimlane}" lane, on "${g.spec_key}": ` +
              `HP best = ${g.hp_best} (${g.hp_model}, ${g.hp_platform}); ` +
              `best rival = ${g.rival_best} (${g.rival_model}, ${g.rival_platform}); ` +
              `lead = ${g.lead} (positive = HP ahead, negative = HP gap). This is a SAME-CLASS, SAME-LANE comparison; ` +
              `if the two sides are different CPU generations, say so and weigh the gap accordingly.` +
              (g.meaning ? `\nWhat this metric means for a buyer: ${g.meaning} — frame the delta in those workload terms, don't just restate the numbers.` : '') +
              (g.suspect ? `\nNOTE: a same-lane value was dropped as a likely mis-read before this comparison — caveat the confidence and suggest verifying the recorded spec.` : ''),
            sources: [],
            material: false,
          });
        }
      }

      if (want.has('commodity')) {
        for (const name of store.list_commodities()) {
          const spread = store.commodity_compare(name);
          if (spread.length === 0) continue;
          // Market street-price trend so the blurb can speak to the CHANGE over
          // time (the NAND/DRAM/VRAM squeeze), not just today's spread.
          const mkt = store.commodity_change(name, { price_kind: 'standalone' });
          const trend =
            mkt.latest != null
              ? `Market street ≈ $${mkt.latest}${mkt.wow_pct != null ? `, ${mkt.wow_pct}% w/w` : ''}${mkt.mom_pct != null ? `, ${mkt.mom_pct}% m/m` : ''} (as of ${mkt.latest_date}).`
              : 'No market street price tracked yet.';
          candidates.push({
            subject_type: 'commodity',
            subject_key: name,
            label: name,
            salient: spread.map((v) => `${v.vendor}:${v.price ?? '?'}`).join(',') + `|mkt:${mkt.latest ?? '?'}`,
            context:
              `Commodity "${name}" priced per OEM: ${spread.map((v) => `${v.vendor.toUpperCase()} $${v.price ?? '?'}`).join('; ')}.\n` +
              `${trend}\nComment on BOTH the per-OEM spread AND the price trend over time — what's moving and why (memory/NAND/DRAM/VRAM supply), and which OEM's markup is richest.`,
            sources: dedupe_sources(spread.map((v) => ({ url: v.url }))),
            material: false,
          });
        }
      }

      if (want.has('leak')) {
        for (const l of store.leak_radar(12)) {
          candidates.push({
            subject_type: 'leak',
            subject_key: l.cert_model_string,
            label: l.cert_model_string,
            salient: `${l.registry}|${l.vendor_guess}`,
            context: `Pre-launch cert-registry leak: "${l.cert_model_string}" on ${l.registry.toUpperCase()}, vendor guess ${l.vendor_guess || 'TBD'}, first seen ${l.first_seen}. A certified model-string not yet a known SKU = a workstation certified but not yet announced.`,
            sources: dedupe_sources([{ url: l.raw_url }]),
            material: true,
          });
        }
      }

      // ── pick those missing or moved (material first), capped at k ─────────
      const needing = candidates.filter((c) => {
        if (input.force) return true;
        const prior = store.get_assessment(c.subject_type, c.subject_key);
        return !prior || prior.subject_hash !== hash(c.salient);
      });
      needing.sort((a, b) => Number(b.material) - Number(a.material));
      const batch = needing.slice(0, input.k ?? DEFAULT_K);

      let assessed = 0;
      const fails = { parse: 0, empty: 0, llm: 0 }; // visibility instead of silent skips
      for (const c of batch) {
        try {
          // Ground in her shelf clippings — gives the writeup real sources/context.
          const chunks = deps.memory.retrieve_scoped_chunks({
            query: c.label,
            knowledge_scope: ['Knowledge/Kristi/**'],
            k: 4,
            bypass_private: true,
          });
          const clippings = chunks.map((ch) => `[source: ${ch.note_path}]\n${ch.chunk_text}`).join('\n\n').slice(0, 8_000);
          // Material items use the bigger deep_consult model for a sharper
          // read, but think:false — the reasoning model's <think> block breaks
          // JSON.parse, and the codebase convention for JSON-returning tools is
          // think:false (strip_fence also defends against a stray <think>).
          const role = deps.llm.for_role(c.material ? 'deep_consult' : 'research_extract');
          let content: string;
          try {
            const resp = await role.provider.complete({
              messages: [
                { role: 'system', content: SYSTEM },
                {
                  role: 'user',
                  content:
                    `ITEM (${c.subject_type}): ${c.label}\n\nWHAT WE HAVE ON IT:\n${c.context}\n\n` +
                    `RELATED CLIPPINGS FROM YOUR SHELF:\n${clippings || '(none retrieved — assess from the structured data above and say where it is thin)'}`,
                },
              ],
              max_tokens: 1500,
              think: false,
            });
            content = resp.content;
          } catch {
            fails.llm++;
            continue;
          }
          let parsed: { headline?: string; assessment_md?: string; confidence?: string };
          try {
            parsed = JSON.parse(strip_fence(content));
          } catch {
            fails.parse++;
            continue;
          }
          const assessment_md = String(parsed.assessment_md ?? '').trim();
          if (!assessment_md) {
            fails.empty++;
            continue;
          }
          const confidence = (['low', 'medium', 'high'].includes(String(parsed.confidence)) ? parsed.confidence : 'medium') as Confidence;
          store.record_assessment({
            subject_type: c.subject_type,
            subject_key: c.subject_key,
            headline: String(parsed.headline ?? c.label).slice(0, 160),
            assessment_md: assessment_md.slice(0, 6_000),
            sources: c.sources,
            confidence,
            subject_hash: hash(c.salient),
            model_used: c.material ? 'deep' : 'standard',
          });
          assessed++;
        } catch {
          /* defensive: skip one bad item, keep going */
        }
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kristi',
        tool_name: 'assess_competitive_items',
        tool_input: { subject_types: input.subject_types, k: input.k },
        execution_result: { ok: true, candidates: candidates.length, needing: needing.length, assessed, fails },
      });

      return {
        ok: true,
        candidates: candidates.length,
        needing: needing.length,
        assessed,
        total_assessments: store.count_assessments(),
        fails,
      };
    },
  };
}
