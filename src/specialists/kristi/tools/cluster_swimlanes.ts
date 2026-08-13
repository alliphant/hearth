/**
 * cluster_swimlanes — Kristi files each SKU into an IDC-aligned competitive lane.
 *
 * The lane is two axes: FORM-FACTOR CLASS (desktop / mobile / rack / edge-ai —
 * derived deterministically in CODE from the SKU's recorded form_factor, so a
 * machine can never be mis-filed across classes) × PERFORMANCE TIER (entry /
 * mainstream / performance / expert — assigned by one bounded LLM call, anchored
 * on the OEM's own line position with the capability ceiling as tiebreaker). The
 * slug is composed as `<class> · <tier>`, so equivalent machines across HP/Dell/
 * Lenovo share a lane and an entry box is never bucketed with an expert one
 * (the old free-form capability-envelope clustering did exactly that — e.g. HP
 * Z1 landing beside Dell Pro Precision 9). A genuinely net-new segment the model
 * can't place gets its OWN new lane — the one sanctioned path for a new swimlane
 * to emerge. One LLM call over the SKUs already in the store (no web fetch, no
 * loop → can't spiral); writes lane + tier + rationale onto each SKU; preserved
 * across SKU re-records.
 *
 * Background-job tool. SKUs feed it; it doesn't fetch anything.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  getKristiWorkstationsStore,
  ws_class_from_form_factor,
  ws_class_label,
  type Tier,
  type WsClass,
} from '@memory/stores/kristi_workstations';
import { parse_rows_tolerant } from './_json_rows';

const VALID_TIERS: ReadonlySet<string> = new Set(['entry', 'mainstream', 'performance', 'expert']);

/**
 * Compose the swimlane slug from the (code-derived) class + the LLM-assigned
 * tier — so equivalent machines across OEMs share a lane and an entry box is
 * NEVER bucketed with an expert one. Desktop/mobile get `<class> · <tier>`;
 * rack/edge-ai are their own (untiered) lane; a genuinely-novel SKU the model
 * couldn't place (`new_lane`, only honored for the 'other' class) becomes its
 * own lane — the single sanctioned path for a NEW swimlane to emerge.
 */
function compose_lane(cls: WsClass, raw_tier: string, new_lane?: string): { slug: string; tier: Tier } {
  if (cls === 'other' && new_lane) return { slug: new_lane.slice(0, 60), tier: '' };
  if (cls === 'dtws' || cls === 'mws') {
    const tier = (VALID_TIERS.has(raw_tier) ? raw_tier : '') as Tier;
    return { slug: tier ? `${ws_class_label(cls)} · ${tier}` : ws_class_label(cls), tier };
  }
  // rack / edge-ai / other: the class IS the lane.
  return { slug: ws_class_label(cls), tier: '' };
}

const InputSchema = z.object({}).strict();
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
  ok: z.boolean(),
  skus: z.number(),
  assigned: z.number(),
  lanes: z.array(z.object({ swimlane: z.string(), members: z.array(z.string()) })),
  error: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;


const SYSTEM =
  'You assign each workstation SKU an IDC-aligned PERFORMANCE TIER within its class. ' +
  'Tiers, low → high: entry, mainstream, performance, expert. ' +
  "Anchor FIRST on the OEM's own line position, then use the capability ceiling " +
  '(max GPU count, total GPU power, max memory, PSU/chassis class, socket/CPU tier) as the tiebreaker:\n' +
  '  • HP: Z1 / Z2 = entry · Z4 = mainstream · Z6 = performance · Z8 / Z8 Fury = expert. ' +
  '(ZBook mobile: Firefly = entry · Power = mainstream · Fury = performance/expert.)\n' +
  '  • Dell: Precision 3xxx = entry · 5xxx = mainstream · 7xxx = performance. The Pro Precision 9 line is ' +
  'MULTI-CHASSIS (T2 < T4 < T6) and tiers ACROSS lanes — T2 ≈ HP Z4 (mainstream) · T4 ≈ Z6 (performance) · ' +
  'T6 ≈ Z8 (expert); never collapse T2/T4/T6 into one tier.\n' +
  '  • Lenovo: ThinkStation P3 / Tiny = entry · P5 = mainstream · P7 / P8 = performance · PX = expert. ' +
  '(ThinkPad P mobile: P14s/P16s = entry · P1 = mainstream · P16 = performance · PX = expert.)\n' +
  'A MULTI-CHASSIS line spans MULTIPLE tiers — HP Z-series (Z1 < Z2 < Z4 < Z6 < Z8), Dell Pro Precision 9 ' +
  '(T2 < T4 < T6), Lenovo ThinkStation chassis sizes — place EACH chassis by its OWN capability ceiling; ' +
  'never lump a whole line into one tier. ' +
  'Two machines from DIFFERENT OEMs in the SAME tier are direct competitors — that is the whole point. ' +
  'An ENTRY box is never the same tier as an EXPERT one even if a maxed-out entry config brushes a base expert config. ' +
  'Assign EVERY sku a tier. ' +
  'If a SKU genuinely fits NONE of these established workstation lines — a net-new segment such as a ' +
  'personal-AI / DGX-class desktop appliance — omit tier and instead give it a short "new_lane" label. ' +
  'Reply with ONLY a JSON array: ' +
  '[{"model_id":"...","tier":"entry|mainstream|performance|expert","rationale":"<=1 sentence naming the line position + capability signals"}]. ' +
  '(For a net-new segment use {"model_id":"...","new_lane":"<short label>","rationale":"..."} with no tier.)';

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'cluster_swimlanes',
    description:
      "Derive competitive swimlanes on the IDC-aligned taxonomy: form-factor class (desktop / mobile / rack / edge-ai, from each SKU's recorded form_factor) × performance tier (entry / mainstream / performance / expert, anchored on the OEM's line position + capability ceiling). Lane slug = `<class> · <tier>` so equivalent models across HP/Dell/Lenovo share a lane and an entry box is never bucketed with an expert one. One bounded LLM call; writes the lane + tier + rationale onto each SKU. Run after SKUs are recorded; re-run when they change.",
    risk: 'write_internal',
    required_capabilities: ['read_workstation_intel', 'write_workstation_intel'],
    weight: 'light',
    input_schema: InputSchema,
    output_schema: OutputSchema,

    // ARMED. `assigned` counts SKUs actually written with a swimlane; `skus`
    // is the input set. The empty-input path returns {skus:0, assigned:0}
    // early, so a genuinely idle run reads as idle rather than as a defect.
    yield: { produced: ['assigned'], considered: ['skus'] },
    idempotency_key() {
      return `cluster_swimlanes:${new Date().toISOString().slice(0, 13)}`;
    },

    async execute(_input, ctx: ToolContext): Promise<Output> {
      const store = getKristiWorkstationsStore();
      const skus = store.find_skus({ limit: 80 });
      if (skus.length === 0) return { ok: true, skus: 0, assigned: 0, lanes: [] };

      // Build a compact signal descriptor per SKU — the LLM reads the envelope
      // out of the recorded specs + GPU options itself.
      const lines = skus.map((s) => {
        const specs = store
          .specs_for(s.model_id)
          .map((sp) => `${sp.spec_key}=${sp.spec_value}${sp.unit ? ' ' + sp.unit : ''}`)
          .join('; ');
        const gpus = store
          .gpu_options_for(s.model_id)
          .map((g) => `${g.gpu_name}${g.vram_gb ? ` (${g.vram_gb}GB)` : ''}`)
          .join(', ');
        const bits = [`${s.form_factor}/${s.cpu_platform}`];
        if (s.chassis_variant) bits.push(s.chassis_variant);
        return `- ${s.model_id} (${s.vendor} ${s.model_name}): ${bits.join(', ')}; specs[ ${specs || 'n/a'} ]; gpus[ ${gpus || 'n/a'} ]`;
      });

      // Class is authoritative from the recorded form_factor — the LLM only
      // supplies the tier. So we can never mis-file across classes.
      const class_of = new Map(skus.map((s) => [s.model_id, ws_class_from_form_factor(s.form_factor)] as const));
      const valid = new Set(skus.map((s) => s.model_id));
      let assigned = 0;
      try {
        const role = deps.llm.for_role('research_extract');
        const resp = await role.provider.complete({
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: `SKUs:\n${lines.join('\n')}` },
          ],
          // The whole catalogue (one {model_id,tier,rationale} per SKU) — 1800
          // truncated mid-array at ~34 SKUs (→ "Unterminated string" → the
          // parse threw → 0 lanes assigned, the 2026-06-04 "Z2 won't show" bug).
          max_tokens: 4096,
          think: false,
        });
        const rows = parse_rows_tolerant(resp.content);
        for (const r of rows) {
          const model_id = String(r.model_id ?? '').trim();
          if (!model_id || !valid.has(model_id)) continue;
          const cls = class_of.get(model_id) ?? 'other';
          const { slug, tier } = compose_lane(
            cls,
            String(r.tier ?? '').trim().toLowerCase(),
            r.new_lane ? String(r.new_lane).trim() : undefined,
          );
          if (!slug) continue;
          store.set_swimlane(model_id, slug, String(r.rationale ?? '').slice(0, 280), tier);
          assigned++;
        }
      } catch (err) {
        deps.memory.log_action({
          intent_id: ctx.intent_id,
          agent: ctx.specialist_id ?? 'kristi',
          tool_name: 'cluster_swimlanes',
          tool_input: {},
          execution_result: { ok: false, error: err instanceof Error ? err.message : String(err) },
        });
        return { ok: false, skus: skus.length, assigned, lanes: [], error: err instanceof Error ? err.message : String(err) };
      }

      const lanes = store
        .swimlane_view()
        .filter((l) => l.swimlane)
        .map((l) => ({ swimlane: l.swimlane, members: l.members.map((m) => m.model_id) }));
      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kristi',
        tool_name: 'cluster_swimlanes',
        tool_input: {},
        execution_result: { ok: true, skus: skus.length, assigned, lane_count: lanes.length },
      });
      return { ok: true, skus: skus.length, assigned, lanes };
    },
  };
}
