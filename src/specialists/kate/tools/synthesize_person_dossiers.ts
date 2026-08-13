/**
 * synthesize_person_dossiers — the People-engine synthesis/promotion nightly tick
 * (2026-06-24).
 *
 * Kate's off-peak background job (NOT a chat tool — the job IS the trigger;
 * manual catch-up via `fire_background_job?name=synthesize_dossiers`). Runs AFTER
 * the 03:45 iMessage distill so it synthesizes the freshest observations: it
 * PROMOTES durable/recurring stream signal up into the dossier (communal facts →
 * the People note; the relationship narrative → the cordoned synthesis store),
 * DECAYS the ephemeral (LLM-judged + a per-kind TTL backstop) and converts
 * actionable open loops into Kate followup proposals, GATING on durability +
 * importance. Deep tier, grounded, cordoned, cadence-gated, dirty-gated. DARK
 * until HEARTH_PEOPLE_SYNTHESIS=1.
 *
 * See src/core/people_synthesis.ts for the engine + disciplines.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  run_people_synthesis_sweep,
  people_synthesis_enabled,
} from '@core/people_synthesis';
import type { EnrichLLM } from '@core/person_enrichment';

const InputSchema = z.object({});
const OutputSchema = z.object({
  enabled: z.boolean(),
  skipped: z.boolean(),
  people: z.number(),
  facts: z.number(),
  themes: z.number(),
  followups: z.number(),
  decayed: z.number(),
});
type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'synthesize_person_dossiers',
    description:
      'Off-peak background job: synthesize each person\'s observation stream into ' +
      'the durable dossier — promote durable facts + a relationship narrative, ' +
      'decay the ephemeral, and surface actionable open loops as followups (deep ' +
      'tier, grounded, cordoned, dirty-gated). Not a chat tool.',
    risk: 'write_internal',
    required_capabilities: ['write_vault_general'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,

    // Reporting-only: the fields are authoritative, but re-synthesizes only contacts whose observations changed; an unchanged roster costs no LLM call and writes nothing.
    yield: { produced: ['people'], armed: false },
    idempotency_key() {
      return `synthesize_person_dossiers:${Math.floor(Date.now() / 60_000)}`;
    },

    async execute(_input: Input, ctx: ToolContext): Promise<Output> {
      if (!people_synthesis_enabled()) {
        return { enabled: false, skipped: false, people: 0, facts: 0, themes: 0, followups: 0, decayed: 0 };
      }
      return run_people_synthesis_sweep({
        db: deps.db,
        memory: ctx.memory,
        llm: ctx.llm as unknown as EnrichLLM,
        proposals: deps.proposals,
        users: deps.users,
        now: () => ctx.now,
      });
    },
  };
}
