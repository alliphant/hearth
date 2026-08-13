/**
 * derive_swimlane_profiles — Kristi turns the supply-side picture into a
 * DEMAND-side one, per swimlane.
 *
 * `cluster_swimlanes` answers "what can this lane DO" (the capability envelope).
 * This job answers "who is it FOR": for each lane it derives a grounded set of
 *   - personas (the human seat that runs the lane's workloads),
 *   - one ICP (the ideal customer org/account that should buy here), and
 *   - UCPs (UNideal customers — who looks like a fit but should NOT buy this
 *     lane, plus the lane they actually belong in).
 *
 * The discipline that keeps it honest is the GROUNDING CHAIN, derived BACKWARDS:
 * a real workflow's compute demand → the capability driver that makes THIS lane
 * the right envelope → the buyer. A persona that can't trace to a workflow's
 * compute demand is a guess (labeled low-confidence, with a falsifier). A UCP
 * always carries a redirect to a real lane — an unideal profile without a
 * redirect is just a complaint.
 *
 * Pattern mirrors the other Kristi background jobs (assess_competitive_items /
 * cluster_swimlanes): bounded, no multi-round spiral, off the conversation path.
 * One deep-model call PER LANE, grounded in the lane's recorded specs/GPU
 * options/ISV certs/price segments + her shelf clippings. Re-derives only lanes
 * whose supply-side data has MOVED (a `sync_meta` content-hash mismatch),
 * capped at `k` lanes per run, so the backlog fills over a few runs then just
 * refreshes what changed. Replaces a lane's profiles atomically
 * (delete-then-insert) so a dropped persona doesn't linger. Surfaced as the
 * "Who it's for" tap-down under each lane on the Recon Desk pane.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  getKristiWorkstationsStore,
  type WsClass,
  type ProfileKind,
  type Confidence,
} from '@memory/stores/kristi_workstations';

const DEFAULT_K = 4; // lanes derived per run (bounded; deep-model calls are heavy)
const CLASSES: Array<{ id: WsClass; label: string }> = [
  { id: 'dtws', label: 'Desktop workstation' },
  { id: 'mws', label: 'Mobile workstation' },
  { id: 'rws', label: 'Rack workstation' },
  { id: 'edge_ai', label: 'Edge-AI box' },
];
const KINDS = new Set<ProfileKind>(['persona', 'icp', 'ucp']);

const InputSchema = z
  .object({
    k: z.number().int().min(1).max(20).optional().describe('How many lanes to (re)derive this run.'),
    ws_class: z.enum(['dtws', 'mws', 'rws', 'edge_ai']).optional().describe('Restrict to one class. Omit for all four.'),
    force: z.boolean().default(false).describe('Re-derive even lanes whose supply-side data is unchanged.'),
  })
  .strict();
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
  ok: z.boolean(),
  lanes: z.number(),
  needing: z.number(),
  derived: z.number(),
  profiles_written: z.number(),
  total_profiles: z.number(),
  fails: z.object({ parse: z.number(), empty: z.number(), llm: z.number() }).optional(),
  error: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

/** A lane that can carry demand-side profiles. `salient` is hashed to detect
 *  supply-side movement; `context` grounds the writeup. */
interface LaneCandidate {
  ws_class: WsClass;
  class_label: string;
  swimlane: string;
  salient: string;
  context: string;
  peer_lanes: string[]; // other lanes in this class — valid UCP redirect targets
  has_profiles: boolean;
}

/** Drop a stray <think> block, strip a ```json fence, then slice to the outer
 *  array/object so a preamble can't break JSON.parse. */
function strip_fence(s: string): string {
  let t = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) t = fence[1].trim();
  const start = Math.min(...[t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0).concat([Infinity]));
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (Number.isFinite(start) && end > start) t = t.slice(start, end + 1);
  return t.trim();
}

function hash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

const SYSTEM =
  "You are Kristi, the household's workstation competitive-intelligence analyst. Derive the DEMAND-SIDE " +
  'profiles for ONE capability-envelope swimlane: who is this lane FOR. Produce, grounded in the supply-side ' +
  'data and clippings provided:\n' +
  '- 2-4 `persona` rows — the human ROLE/SEAT that runs this lane\'s workloads (e.g. "AEC BIM coordinator", ' +
  '"M&E lookdev artist", "ML engineer fine-tuning local LLMs").\n' +
  '- exactly 1 `icp` row — the IDEAL customer org/account that should buy this lane (firmographics + segment).\n' +
  '- 1-2 `ucp` rows — the UNIDEAL customer: a buyer who LOOKS like a fit but should NOT buy this lane ' +
  '(over-buying a heavier envelope than the workflow needs, or under-buying one too light), AND the lane they ' +
  'actually belong in.\n\n' +
  'THE GROUNDING CHAIN (derive every profile BACKWARDS along it): a real workflow\'s COMPUTE DEMAND → the ' +
  'capability driver that makes THIS lane the right envelope → the buyer. Put the workflow/use-case in ' +
  '`grounded_on` and the envelope spec in `capability_drivers`. A persona you cannot tie to a workflow\'s ' +
  'compute demand is a GUESS — mark it confidence "low" and give a sharp falsifier. For persona/icp, state the ' +
  'GeForce-vs-pro call (does the workload\'s ISV stack permit consumer GPUs or require RTX PRO) in ' +
  '`geforce_vs_pro`, and which OEM wins the seat in `best_fit_by_oem`. For EVERY ucp, set `disqualifier` (the ' +
  'spec they would waste or starve) and `redirect_swimlane` to one of the PEER LANES listed — an unideal ' +
  'profile without a redirect is just a complaint. Never invent a spec or a model; if the data is thin, say so ' +
  'and lower confidence. Enthusiasm never outruns the data.\n\n' +
  'Reply with ONLY a JSON array (no prose, no fence). Each item: ' +
  '{"profile_kind":"persona|icp|ucp","title":"<short label>","body_md":"<2-4 tight sentences/bullets, GitHub ' +
  'markdown, no heading>","grounded_on":"<the workflow/use-case>","capability_drivers":"<the envelope spec(s) ' +
  'that make this lane fit>","segment":"smb|prosumer|enterprise|edu|gov|","geforce_vs_pro":"<persona/icp; else ' +
  'empty>","best_fit_by_oem":"<persona/icp; else empty>","disqualifier":"<ucp; else empty>",' +
  '"redirect_swimlane":"<ucp: one of the peer lanes; else empty>","redirect_reason":"<ucp; else empty>",' +
  '"confidence":"low|medium|high","falsifier":"<what would prove this wrong>"}.';

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'derive_swimlane_profiles',
    description:
      "BACKGROUND JOB. Derive the demand-side profiles per swimlane — personas (the human seat), the ICP (ideal customer org), and UCPs (UNideal customer + the lane they belong in) — grounded backwards from a real workflow's compute demand to the lane's capability envelope. One deep-model call per lane over the recorded specs/GPU/ISV/prices + her shelf clippings; re-derives only lanes whose supply-side data moved (sync_meta hash), capped at `k` per run, replacing each lane's set atomically. Surfaced as the 'Who it's for' tap-down under each lane on the Recon Desk.",
    risk: 'write_internal',
    required_capabilities: ['read_workstation_intel', 'write_workstation_intel', 'read_vault', 'consult_deep_model'],
    weight: 'heavy',
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `derive_swimlane_profiles:${input.ws_class ?? 'all'}:${new Date().toISOString().slice(0, 13)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const store = getKristiWorkstationsStore();
      const classes = input.ws_class ? CLASSES.filter((c) => c.id === input.ws_class) : CLASSES;
      const candidates: LaneCandidate[] = [];

      // ── enumerate lanes per class, building the supply-side context ────────
      for (const cls of classes) {
        const lanes = store.swimlane_view(cls.id).filter((l) => l.swimlane);
        const peer_lanes = lanes.map((l) => l.swimlane);
        for (const lane of lanes) {
          const memberLines: string[] = [];
          const salientParts: string[] = [];
          for (const m of lane.members) {
            const sku = store.get_sku(m.model_id);
            if (!sku) continue;
            const specs = store.specs_for(m.model_id).map((sp) => `${sp.spec_key}=${sp.spec_value}${sp.unit ? ' ' + sp.unit : ''}`);
            const gpus = store.gpu_options_for(m.model_id).map((g) => `${g.gpu_name}${g.vram_gb ? ` (${g.vram_gb}GB)` : ''}`);
            const isv = store.isv_certs_for({ model_id: m.model_id }).map((c) => `${c.isv_name}${c.mentions_geforce ? ' (mentions GeForce)' : ' (pro-only)'}`);
            const segs = [...new Set(store.latest_prices(m.model_id).map((p) => p.segment))];
            memberLines.push(
              `- ${sku.vendor} ${sku.model_name} (${sku.form_factor}/${sku.cpu_platform}, status ${sku.status})` +
                `\n    specs: ${specs.join('; ') || 'none recorded'}` +
                `\n    GPU options: ${gpus.join(', ') || 'none'}` +
                `\n    ISV certs: ${isv.join(', ') || 'none'}` +
                `\n    price segments seen: ${segs.join(', ') || 'none'}`,
            );
            salientParts.push(`${m.model_id}:${sku.status}:${specs.join(',')}:${gpus.join(',')}:${isv.join(',')}:${segs.join(',')}`);
          }
          if (memberLines.length === 0) continue;
          const context =
            `CLASS: ${cls.label} (${cls.id}).\nSWIMLANE: "${lane.swimlane}".\n` +
            `PEER LANES in this class (valid UCP redirect targets): ${peer_lanes.filter((p) => p !== lane.swimlane).map((p) => `"${p}"`).join(', ') || '(none — this is the only lane in its class)'}.\n\n` +
            `LANE MEMBERS (the capability envelope to ground against):\n${memberLines.join('\n')}`;
          candidates.push({
            ws_class: cls.id,
            class_label: cls.label,
            swimlane: lane.swimlane,
            salient: salientParts.sort().join('|'),
            context,
            peer_lanes,
            has_profiles: store.list_swimlane_profiles({ ws_class: cls.id, swimlane: lane.swimlane }).length > 0,
          });
        }
      }

      // ── pick lanes that are new or whose supply-side data moved ────────────
      const sync_key = (c: LaneCandidate) => `swimlane_profiles:${c.ws_class}::${c.swimlane}`;
      const needing = candidates.filter((c) => {
        if (input.force) return true;
        const prior = store.get_source_sync(sync_key(c));
        return !prior || prior.content_hash !== hash(c.salient) || !c.has_profiles;
      });
      // Lanes with no profiles yet go first (backfill before refresh).
      needing.sort((a, b) => Number(a.has_profiles) - Number(b.has_profiles));
      const batch = needing.slice(0, input.k ?? DEFAULT_K);

      let derived = 0;
      let profiles_written = 0;
      const fails = { parse: 0, empty: 0, llm: 0 };
      for (const c of batch) {
        try {
          const chunks = deps.memory.retrieve_scoped_chunks({
            query: `${c.swimlane} ${c.class_label} workflow use case persona buyer ISV ${c.peer_lanes.join(' ')}`,
            knowledge_scope: ['Knowledge/Kristi/**'],
            k: 5,
            bypass_private: true,
          });
          const clippings = chunks.map((ch) => `[source: ${ch.note_path}]\n${ch.chunk_text}`).join('\n\n').slice(0, 9_000);

          const role = deps.llm.for_role('deep_consult');
          let content: string;
          try {
            const resp = await role.provider.complete({
              messages: [
                { role: 'system', content: SYSTEM },
                {
                  role: 'user',
                  content:
                    `${c.context}\n\nRELATED CLIPPINGS FROM YOUR SHELF (use for the workflow/use-case grounding):\n` +
                    `${clippings || '(none retrieved — derive from the envelope above and lower confidence where the demand-side picture is thin)'}`,
                },
              ],
              max_tokens: 2600,
              think: false,
            });
            content = resp.content;
          } catch {
            fails.llm++;
            continue;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(strip_fence(content));
          } catch {
            fails.parse++;
            continue;
          }
          const rows: Record<string, unknown>[] = Array.isArray(parsed)
            ? (parsed as Record<string, unknown>[])
            : Array.isArray((parsed as { rows?: unknown }).rows)
              ? ((parsed as { rows: Record<string, unknown>[] }).rows)
              : [];
          const valid = rows.filter((r) => {
            const k = String(r.profile_kind ?? '');
            return KINDS.has(k as ProfileKind) && String(r.title ?? '').trim() && String(r.body_md ?? '').trim();
          });
          if (valid.length === 0) {
            fails.empty++;
            continue;
          }

          // Replace the lane's profiles atomically so a dropped persona doesn't linger.
          store.delete_lane_profiles(c.ws_class, c.swimlane);
          const peerSet = new Set(c.peer_lanes);
          for (const r of valid) {
            const kind = String(r.profile_kind) as ProfileKind;
            const conf = (['low', 'medium', 'high'].includes(String(r.confidence)) ? r.confidence : 'medium') as Confidence;
            // A UCP redirect must point at a real peer lane; drop a hallucinated one.
            const redirect = String(r.redirect_swimlane ?? '').trim();
            const redirect_swimlane = kind === 'ucp' && peerSet.has(redirect) ? redirect : '';
            store.record_swimlane_profile({
              ws_class: c.ws_class,
              swimlane: c.swimlane,
              profile_kind: kind,
              title: String(r.title).slice(0, 160),
              body_md: String(r.body_md).slice(0, 2_000),
              grounded_on: String(r.grounded_on ?? '').slice(0, 400),
              capability_drivers: String(r.capability_drivers ?? '').slice(0, 400),
              segment: String(r.segment ?? '').slice(0, 20),
              geforce_vs_pro: kind === 'ucp' ? '' : String(r.geforce_vs_pro ?? '').slice(0, 300),
              best_fit_by_oem: kind === 'ucp' ? '' : String(r.best_fit_by_oem ?? '').slice(0, 300),
              disqualifier: kind === 'ucp' ? String(r.disqualifier ?? '').slice(0, 300) : '',
              redirect_swimlane,
              redirect_reason: kind === 'ucp' ? String(r.redirect_reason ?? '').slice(0, 300) : '',
              confidence: conf,
              falsifier: String(r.falsifier ?? '').slice(0, 300),
              source_urls: chunks.map((ch) => ch.note_path).filter(Boolean).slice(0, 6),
            });
            profiles_written++;
          }
          store.record_source_sync(sync_key(c), { content_hash: hash(c.salient), row_count: valid.length });
          derived++;
        } catch {
          /* defensive: skip one bad lane, keep going */
        }
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kristi',
        tool_name: 'derive_swimlane_profiles',
        tool_input: { ws_class: input.ws_class, k: input.k },
        execution_result: { ok: true, lanes: candidates.length, needing: needing.length, derived, profiles_written, fails },
      });

      return {
        ok: true,
        lanes: candidates.length,
        needing: needing.length,
        derived,
        profiles_written,
        total_profiles: store.count_swimlane_profiles(),
        fails,
      };
    },
  };
}
