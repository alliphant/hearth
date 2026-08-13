/**
 * propose_hire — Kate's agentic hiring tool.
 *
 * Hiring used to be a modal: a form, straight to a YAML file. This makes
 * it a deliberate, reviewed decision. Kate drafts the role — persona,
 * knowledge scope, cadence — consults Beatrice for a capability gap
 * analysis, and assembles a two-tier plan:
 *
 *   - day-1 capabilities — backed by tools that already exist
 *   - a build queue      — capabilities that need a tool built first
 *
 * The whole thing is filed as a Proposal (a "hiring packet") for Jasper
 * to approve. On approval the hire route's `/from-packet` endpoint
 * materializes the specialist and flags the build queue to Beatrice.
 *
 * The persona is drafted here so Jasper sees it before approving;
 * HEARTH_TEST_MODE skips the LLM and uses a plain template.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ProposalsStore } from '@core/proposals';
import type { SpecialistRegistry } from '@core/specialist';
import type { ToolRegistry } from '@core/tool_registry';
import {
  HIRING_PROPOSAL_KIND,
  HIRING_SIGNATURE_KIND,
  ProactiveSchema,
  VoiceEnum,
  draft_persona_validated,
  valid_deliberation_at,
  type HiringPacket,
} from '@core/hiring';
import type { LLMMessage } from '@core/llm';

// NOTE: this is a tool input_schema — it becomes a JSON Schema and then
// a GBNF grammar inside llama.cpp. Do NOT use `.regex()` here: llama.cpp's
// converter mistranslates regex metaclasses (`\d` → literal `"\d"`) and
// fails the whole tool grammar. Shape constraints are validated in
// execute() instead.
const InputSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe('Stable lowercase snake_case id for the new specialist, e.g. "harper".'),
  name: z.string().min(1).describe('Display name, e.g. "Harper".'),
  role: z.string().min(1).describe('Their role, e.g. "Travel Coordinator".'),
  voice: VoiceEnum.describe('Voice family for the persona.'),
  description: z
    .string()
    .min(10)
    .max(2000)
    .describe("Jasper's description of what this specialist is for."),
  knowledge_scope: z
    .array(z.string())
    .optional()
    .describe('Vault path globs the specialist may read; defaults to their own namespace.'),
  proactive: ProactiveSchema.optional().describe(
    'Proactive cadence; defaults to reactive (conversation only).',
  ),
  capability_wishlist: z
    .array(z.string().min(1))
    .optional()
    .describe('Capability tokens this specialist would ideally have — Beatrice sorts them into day-1 vs build-queue.'),
});

const OutputSchema = z.object({
  proposal_id: z.string(),
  day_1_capabilities: z.array(z.string()),
  build_queue: z.array(z.string()),
  persona_preview: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

interface GapAnalysis {
  analyzed: Array<{
    capability: string;
    status: string;
    existing_tools: string[];
    note: string;
  }>;
  day_1: string[];
  build_queue: string[];
}

/**
 * Draft the new specialist's persona — LLM in prod, template under test.
 *
 * The draft passes the shared shape gate (`validate_persona_draft`) before
 * it's stored: the drafter role runs think-ON, and a model that emits its
 * reasoning as plain prose used to land the whole dump in the packet as the
 * persona. One corrective retry, then the deterministic template.
 */
async function draft_persona(input: Input, ctx: ToolContext): Promise<string> {
  const template =
    `You are ${input.name}, the household's ${input.role}.\n\n` +
    `${input.description}\n\n` +
    `Voice: ${input.voice}. You are new — your library and memory start ` +
    `empty, and you will get up to speed as Jasper adds materials.`;
  if (process.env.HEARTH_TEST_MODE === '1') return template;
  try {
    const role = ctx.llm.for_role('specialist_drafter');
    return await draft_persona_validated({
      name: input.name,
      fallback: template,
      log_label: 'propose_hire',
      attempt: async (retry_nudge) => {
        const messages: LLMMessage[] = [
          {
            role: 'system',
            content:
              'You are Kate, the Chief of Staff, drafting the persona for a new ' +
              'staff member during hiring. Write 150-300 words in second person ' +
              `("You are ${input.name} ..."), warm coherent prose, no bullet lists. ` +
              'It should feel like a real colleague, not a tool. Output ONLY the persona text.',
          },
          {
            role: 'user',
            content:
              `Name: ${input.name}\nRole: ${input.role}\n` +
              `Voice family: ${input.voice}\n` +
              `Jasper's description: ${input.description}`,
          },
        ];
        if (retry_nudge) messages.push({ role: 'user', content: retry_nudge });
        const resp = await role.provider.complete({
          messages,
          temperature: role.defaults.temperature,
        });
        return resp.content;
      },
    });
  } catch (err) {
    console.error('[propose_hire] persona draft failed; using template:', err);
    return template;
  }
}

export function make_propose_hire(
  proposals: ProposalsStore,
  specialists: SpecialistRegistry,
  tool_registry: ToolRegistry,
): Tool<Input, Output> {
  return {
    name: 'propose_hire',
    description:
      "Propose hiring a new specialist. Kate drafts the role (persona, knowledge scope, proactive cadence), consults Beatrice for a capability gap analysis, and files a two-tier hiring packet — day-1 capabilities plus a build queue — as a Proposal for Jasper to approve. On approval the specialist is created and the build queue is flagged to Beatrice. Arguments: id (snake_case), name, role, voice, description, optional knowledge_scope, optional proactive cadence, optional capability_wishlist (capability tokens). Returns the proposal id and the two-tier split.",
    risk: 'write_internal',
    required_capabilities: ['write_proposals'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `propose_hire:${input.id}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      // Shape checks that used to live in the schema as `.regex()` —
      // moved here so the tool's JSON Schema stays grammar-safe.
      if (!/^[a-z][a-z0-9_]*$/.test(input.id)) {
        throw new Error(
          `id "${input.id}" must be lowercase snake_case: a letter, then ` +
            `letters/digits/underscores (e.g. "harper", "travel_planner").`,
        );
      }
      if (
        input.proactive?.deliberation_at &&
        !valid_deliberation_at(input.proactive.deliberation_at)
      ) {
        throw new Error(
          `proactive.deliberation_at must be 24-hour "HH:MM" strings ` +
            `(e.g. "09:00"); got ${JSON.stringify(input.proactive.deliberation_at)}.`,
        );
      }
      if (specialists.has(input.id)) {
        throw new Error(
          `a specialist with id "${input.id}" already exists — pick a different id`,
        );
      }

      // Draft the persona Jasper will see in the packet.
      const persona = await draft_persona(input, ctx);

      // Consult Beatrice: run her gap analysis under her own identity so
      // the capability-gated tool resolves exactly as a direct consult
      // would. The two-tier plan is whatever she returns.
      const beatrice = specialists.get('trainer');
      if (!beatrice) {
        throw new Error(
          'cannot run the hiring gap analysis: Beatrice (trainer) is not loaded',
        );
      }
      const wishlist = input.capability_wishlist ?? [];
      const outcome = await tool_registry.invoke(
        'analyze_capability_gaps',
        { capability_wishlist: wishlist },
        ctx,
        beatrice.granted,
        'trainer',
      );
      if (!outcome.ok || !outcome.result) {
        throw new Error(
          `Beatrice's capability gap analysis failed: ${outcome.error ?? 'no result'}`,
        );
      }
      const gaps = outcome.result as GapAnalysis;
      const note_for = (cap: string): string =>
        gaps.analyzed.find((a) => a.capability === cap)?.note ??
        'No tool exists for this capability yet.';

      const proactive = input.proactive ?? { mode: 'reactive' as const };
      const knowledge_scope =
        input.knowledge_scope && input.knowledge_scope.length > 0
          ? input.knowledge_scope
          : [`Knowledge/${input.id.charAt(0).toUpperCase() + input.id.slice(1)}/**`];

      const packet: HiringPacket = {
        headline: `Hire ${input.name} as ${input.role}`,
        specialist: {
          id: input.id,
          name: input.name,
          role: input.role,
          voice: input.voice,
          persona,
          knowledge_scope,
          proactive,
        },
        day_1_capabilities: gaps.day_1,
        build_queue: gaps.build_queue.map((cap) => ({
          capability: cap,
          why: note_for(cap),
        })),
        gap_analysis: gaps.analyzed,
      };

      const rationale =
        `Hiring packet for **${input.name}**, ${input.role}.\n\n` +
        `${input.description}\n\n` +
        `Day-1 capabilities (${gaps.day_1.length}): ` +
        `${gaps.day_1.length > 0 ? gaps.day_1.join(', ') : 'none beyond the defaults'}.\n` +
        `Build queue (${gaps.build_queue.length}): ` +
        `${gaps.build_queue.length > 0 ? gaps.build_queue.join(', ') : 'none — everything is ready'}.\n\n` +
        `Gap analysis by Beatrice. Approve to create ${input.name}; the ` +
        `build queue is then flagged to Beatrice for tooling.`;

      const proposal_id = proposals.create({
        specialist_id: 'kate',
        kind: HIRING_PROPOSAL_KIND,
        execution_kind: 'manual',
        payload: packet,
        rationale,
        signature: {
          specialist_id: 'kate',
          kind: HIRING_SIGNATURE_KIND,
          category: 'staffing',
          anchor: input.id,
        },
      });

      return {
        proposal_id,
        day_1_capabilities: gaps.day_1,
        build_queue: gaps.build_queue,
        persona_preview: persona.slice(0, 300),
      };
    },
  };
}
