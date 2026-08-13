/**
 * distill_imessage_observations — the iMessage observer's nightly distill tick
 * (2026-06-22).
 *
 * Kate's off-peak background job (NOT a chat tool — the job IS the trigger;
 * manual catch-up via `fire_background_job?name=distill_imessage`). Consumes the
 * transient staged iMessage windows the macOS app uploaded for opted-in
 * contacts, distills them into durable People-note facts + relationship
 * observations, and DROPS the raw. Cheap tier, grounded, cordoned, cadence-
 * gated. DARK until HEARTH_IMESSAGE_OBSERVER=1.
 *
 * See src/core/imessage_distill.ts for the engine + the privacy spine.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  run_imessage_distill_sweep,
  imessage_observer_enabled,
} from '@core/imessage_distill';
import type { EnrichLLM } from '@core/person_enrichment';

const InputSchema = z.object({});
const OutputSchema = z.object({
  enabled: z.boolean(),
  skipped: z.boolean(),
  people: z.number(),
  facts: z.number(),
  observations: z.number(),
  dropped: z.number(),
});
type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'distill_imessage_observations',
    description:
      'Off-peak background job: distill the staged iMessage windows uploaded for ' +
      'opted-in contacts into durable People-note facts + relationship ' +
      'observations, then drop the raw (cheap tier, grounded, cordoned). Not a ' +
      'chat tool.',
    risk: 'write_internal',
    required_capabilities: ['write_vault_general'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,

    // Reporting-only: the fields are authoritative, but distills only what was uploaded and passed the substance filter; no staged windows is a normal night.
    yield: { produced: ['observations'], considered: ['dropped'], armed: false },
    idempotency_key() {
      return `distill_imessage:${Math.floor(Date.now() / 60_000)}`;
    },

    async execute(_input: Input, ctx: ToolContext): Promise<Output> {
      if (!imessage_observer_enabled()) {
        return { enabled: false, skipped: false, people: 0, facts: 0, observations: 0, dropped: 0 };
      }
      return run_imessage_distill_sweep({
        db: deps.db,
        memory: ctx.memory,
        llm: ctx.llm as unknown as EnrichLLM,
        users: deps.users,
        now: () => ctx.now,
      });
    },
  };
}
