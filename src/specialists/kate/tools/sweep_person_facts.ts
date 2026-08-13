/**
 * sweep_person_facts — the self-maintaining-dossier nightly tick (2026-06-22).
 *
 * Kate's off-peak background job (NOT a chat tool — the job IS the trigger;
 * manual catch-up via `fire_background_job?name=sweep_person_facts`). Mines
 * recent chat for durable facts the user stated about people in their contact
 * graph and merges them into the People/ dossier as structured fields. Cheap
 * tier, union-dedup (idempotent), cordoned. DARK until HEARTH_PERSON_ENRICH=1.
 *
 * See src/core/person_enrichment.ts for the engine + disciplines.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  run_person_enrichment_sweep,
  person_enrich_enabled,
  type EnrichLLM,
} from '@core/person_enrichment';

const InputSchema = z.object({});
const OutputSchema = z.object({
  enabled: z.boolean(),
  people: z.number(),
  facts: z.number(),
});
type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'sweep_person_facts',
    description:
      'Off-peak background job: mine recent chat for durable facts the user ' +
      'stated about people in their contact graph and merge them into the ' +
      'Friends dossier (cheap tier, union-dedup, cordoned). Not a chat tool.',
    risk: 'write_internal',
    required_capabilities: ['write_vault_general'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,

    // Reporting-only: the fields are authoritative, but promotes facts only for people with new observations; a quiet week legitimately yields none.
    yield: { produced: ['facts'], considered: ['people'], armed: false },
    idempotency_key() {
      return `sweep_person_facts:${Math.floor(Date.now() / 60_000)}`;
    },

    async execute(_input: Input, ctx: ToolContext): Promise<Output> {
      if (!person_enrich_enabled()) return { enabled: false, people: 0, facts: 0 };
      const r = await run_person_enrichment_sweep({
        db: deps.db,
        memory: ctx.memory,
        llm: ctx.llm as unknown as EnrichLLM,
        users: deps.users,
        now: () => ctx.now,
      });
      return { enabled: true, people: r.people, facts: r.facts };
    },
  };
}
