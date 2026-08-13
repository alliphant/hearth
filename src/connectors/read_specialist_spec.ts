/**
 * read_specialist_spec — Cordelia's window into a specialist's DEFINITION,
 * not just their library shelf (NEXT.md 15c part B; design at
 * docs/design-cordelia-specialist-excellence.md).
 *
 * Cordelia is the household's expert on what makes specialists experts. Her
 * `knowledge_scope` reaches every library shelf, so she can
 * see what's ON a shelf — but not the `persona` / `tools` / `trusted_sources` /
 * `knowledge_scope` that DEFINE the specialist. To answer "is this specialist
 * actually expert in their domain — where is their coverage thin, are their
 * sources tiered, do they group by capability or by naming" she has to read the
 * spec. This tool gives her structured read access to `config/specialists/<id>.yaml`
 * via the live SpecialistRegistry (always current — chokidar hot-reloads on edit),
 * so she audits the DEFINITION against the Specialist Craft rubric
 * (Knowledge/Cordelia/craft/), then deepens via `curate_for_specialist` + a
 * `propose_action` for any spec-level delta.
 *
 * Read-only. The YAML is config, not credentials — there is nothing secret in a
 * persona. Gated to Cordelia via the `read_specialist_spec` capability.
 *
 * Follows the connector affordance pattern (the private dev log "Connectors must expose a
 * recovery hint when they can return error"): an unknown id returns
 * `{ error, available_specialists: [...] }` so the model retries with a real id
 * instead of fabricating a spec.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { SpecialistRegistry, LoadedSpecialist } from '@core/specialist';

const InputSchema = z.object({
  specialist_id: z
    .string()
    .optional()
    .describe(
      "The specialist whose definition to read. Lowercase id ('kristi', 'anna', " +
        "'eleanor'), not the display name. OMIT THIS to enumerate the roster " +
        'instead — you get `staff` (the teammates the owner knows by name) and ' +
        '`internal` (folded machinery, never named to the owner). Omit ' +
        '`include_persona` to get the full persona text; set it false for a ' +
        'lighter structural-only read.',
    ),
  include_persona: z
    .boolean()
    .default(true)
    .describe(
      'Include the full persona + chat/deliberation addenda text (true, default) ' +
        "— needed to audit persona disciplines (recurring-question flags, " +
        'grounded-with-falsifier rules, demand-side method). Set false when you ' +
        'only need the structural surface (tools, sources, scope, capabilities).',
    ),
});

const AvailableSpecialistSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
});

const SpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  voice: z.string(),
  llm_role: z.string().nullable(),
  pane_kind: z.string().nullable(),
  aliases: z.array(z.string()),
  max_tool_rounds: z.number().nullable(),
  /** Deliberation-slot ceiling override (2026-08-11) — null when unset
   *  (deliberation falls through to max_tool_rounds). */
  max_tool_rounds_deliberation: z.number().nullable(),
  // Persona text — present only when include_persona (default true).
  persona: z.string().optional(),
  chat_addendum: z.string().nullable().optional(),
  deliberation_addendum: z.string().nullable().optional(),
  knowledge_scope: z.array(z.string()),
  capabilities: z.array(z.string()),
  tools_for_chat: z.array(z.string()),
  tools_for_deliberation: z.array(z.string()),
  trusted_sources: z.object({
    tier_1: z.array(z.string()),
    tier_2: z.array(z.string()),
  }),
  proactive: z.object({
    mode: z.string(),
    deliberation_at: z.array(z.string()),
    research_workload: z.boolean(),
    intake_captures: z.boolean(),
    wake_on_flag: z.boolean(),
  }),
  discretion: z.object({
    allowed_tiers: z.array(z.string()).nullable(),
    visibility_household: z.string(),
    visibility_friend: z.string(),
  }),
});

const OutputSchema = z.object({
  spec: SpecSchema.nullable(),
  error: z.string().nullable(),
  // Recovery hint (connector affordance pattern): the real ids to retry with
  // when `specialist_id` didn't resolve.
  available_specialists: z.array(AvailableSpecialistSchema).optional(),
  // ── Roster enumerate (2026-08-02) ────────────────────────────────────
  // Present when `specialist_id` is omitted. Split deliberately: `staff` is
  // who the OWNER knows by name and may be credited; `internal` is folded
  // machinery whose work belongs to the caller and is described by function,
  // never by name. See the note on the enumerate branch in execute().
  staff: z.array(AvailableSpecialistSchema).optional(),
  internal: z.array(AvailableSpecialistSchema).optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export interface ReadSpecialistSpecDeps {
  specialists: SpecialistRegistry;
}

function project_spec(s: LoadedSpecialist, include_persona: boolean): z.infer<typeof SpecSchema> {
  const base = {
    id: s.id,
    name: s.name,
    role: s.role,
    voice: s.voice,
    llm_role: s.llm_role ?? null,
    pane_kind: s.pane_kind ?? null,
    aliases: s.aliases ?? [],
    max_tool_rounds: s.max_tool_rounds ?? null,
    max_tool_rounds_deliberation: s.max_tool_rounds_deliberation ?? null,
    knowledge_scope: s.knowledge_scope,
    // The granted Set is the authoritative "what can this specialist do" view —
    // capabilities the YAML set to false never make it into `granted`.
    capabilities: Array.from(s.granted).sort(),
    tools_for_chat: s.proactive.tools_for_chat,
    tools_for_deliberation: s.proactive.tools_for_deliberation,
    trusted_sources: {
      tier_1: s.trusted_sources.tier_1 ?? [],
      tier_2: s.trusted_sources.tier_2 ?? [],
    },
    proactive: {
      mode: s.proactive.mode,
      deliberation_at: s.proactive.deliberation_at ?? [],
      research_workload: s.proactive.research_workload,
      intake_captures: s.proactive.intake_captures,
      wake_on_flag: s.proactive.wake_on_flag,
    },
    discretion: {
      allowed_tiers: s.discretion.allowed_tiers ?? null,
      visibility_household: s.discretion.visibility.household,
      visibility_friend: s.discretion.visibility.friend,
    },
  };
  if (!include_persona) return base;
  return {
    ...base,
    persona: s.persona,
    chat_addendum: s.chat_addendum ?? null,
    deliberation_addendum: s.deliberation_addendum ?? null,
  };
}

export function make_read_specialist_spec(deps: ReadSpecialistSpecDeps): Tool<Input, Output> {
  return {
    name: 'read_specialist_spec',
    description:
      "Read the live staff roster, or one specialist's DEFINITION. OMIT specialist_id to enumerate the roster: returns `staff` (the teammates the owner knows by name and may be credited) and `internal` (folded machinery — real, still running, but never named to the owner). This is the ONLY grounded answer to 'who is on your staff', 'who handles X', 'who should I ask about Y' — the roster changes as specialists are folded, so answer from this call, never from memory. Pass a lowercase specialist_id instead to read that one's DEFINITION (persona, role, voice, tools_for_chat/deliberation, trusted_sources tiers, knowledge_scope, granted capabilities) — for auditing the SPEC, e.g. 'where is Kristi's domain coverage thin'. Reads the live config (always current). Returns `available_specialists` if the id doesn't resolve.",
    risk: 'read',
    required_capabilities: ['read_specialist_spec'],
    // Bounded, structured output where every field carries audit weight — pass
    // it through verbatim rather than smart-truncating the persona mid-audit.
    llm_budget: 'full',
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `read_specialist_spec:${input.specialist_id ?? '*roster'}:${input.include_persona ? 'p' : 'np'}`;
    },

    async execute(input, _ctx: ToolContext): Promise<Output> {
      // ── Enumerate branch (2026-08-02) ─────────────────────────────────
      // "Who is on your staff?" was the one owner-facing question with NO
      // grounded path: every other domain answers from a tool, the roster
      // answered from parametric memory. Measured 2026-08-02, Kate returned
      // ~7 roughly-right names and then confabulated 45 more (Gladdy, Nyx,
      // Persephone — names that appear nowhere in the repo, vault or RAG),
      // identically across two differently-worded prompts. That is not a
      // sampler loop; it is an ungrounded question. This branch is the
      // grounded path.
      if (!input.specialist_id) {
        const project = (x: LoadedSpecialist) => ({ id: x.id, name: x.name, role: x.role });
        const by_id = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
        const all = deps.specialists.list();
        return {
          spec: null,
          error: null,
          staff: all.filter((x) => !x.subagent_only).map(project).sort(by_id),
          internal: all.filter((x) => x.subagent_only).map(project).sort(by_id),
        };
      }

      const s = deps.specialists.get(input.specialist_id);
      if (!s) {
        const available = deps.specialists
          .list()
          .map((x) => ({ id: x.id, name: x.name, role: x.role }))
          .sort((a, b) => a.id.localeCompare(b.id));
        return {
          spec: null,
          error: `No specialist with id "${input.specialist_id}". Pass the lowercase id (not the display name) from available_specialists.`,
          available_specialists: available,
        };
      }
      return {
        spec: project_spec(s, input.include_persona),
        error: null,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_read_specialist_spec({ specialists: deps.specialists }) as Tool;
}
