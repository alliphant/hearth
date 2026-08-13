/**
 * reflect_household — Kate's nightly walk-the-house reflection tick (C2 of
 * docs/design-kate-self-direction.md; engine in @core/kate_reflection).
 *
 * Background job at 05:30 (after the 03:30–04:15 sweeps fill the stores,
 * before the 07:00 brief so the ledger feeds it). NOT on her LLM surfaces —
 * the job is the trigger; manual catch-up via
 * POST /api/specialists/kate/fire_background_job?name=household_reflection.
 * DARK behind HEARTH_KATE_REFLECTION; the act disposition additionally
 * behind HEARTH_KATE_REFLECTION_ACT (watch-only soak first — the scored-week
 * discipline applied to initiative).
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { run_reflection, kate_reflection_enabled } from '@core/kate_reflection';

const InputSchema = z.object({
  /** Override the reflection recipient (defaults to the owner). */
  user_id: z.string().optional(),
});
const OutputSchema = z.object({
  enabled: z.boolean(),
  ran: z.boolean(),
  observations: z.number(),
  new_items: z.number(),
  recurring: z.number(),
  suppressed: z.number(),
  downgraded: z.number(),
  proposals_filed: z.array(z.string()),
  /** Ask-disposition briefing cards filed this pass (2026-07-20). */
  asks_filed: z.array(z.string()),
  /** The envelope needed (and survived) the one-shot repair round. */
  repaired: z.boolean().optional(),
  expired: z.number(),
});
type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function create_reflect_household(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'reflect_household',
    description:
      'Nightly walk-the-house reflection: one open-mandate deep-tier pass over ' +
      'the fused household picture + the open watch ledger — notice what no ' +
      'scheduled scan owns, keep a durable watch list, act only through the ' +
      'normal proposal gates. Background job; not a chat tool.',
    risk: 'write_internal',
    required_capabilities: ['reflect_household'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,

    idempotency_key() {
      return `reflect_household:${Math.floor(Date.now() / 60_000)}`;
    },

    async execute(input: Input, ctx: ToolContext): Promise<Output> {
      if (!kate_reflection_enabled()) {
        return {
          enabled: false,
          ran: false,
          observations: 0,
          new_items: 0,
          recurring: 0,
          suppressed: 0,
          downgraded: 0,
          proposals_filed: [],
          asks_filed: [],
          expired: 0,
        };
      }
      const user_id =
        input.user_id ?? ctx.user?.id ?? process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
      const tier = deps.users?.get(user_id)?.tier ?? 'owner';
      const timezone = deps.users?.get_timezone(user_id);
      const { parse_failed: _pf, ...out } = await run_reflection(
        {
          db: deps.db,
          memory: deps.memory,
          llm: deps.llm,
          proposals: deps.proposals,
          audit: (summary) => {
            try {
              deps.memory.log_action({
                intent_id: `reflect-${Date.now()}`,
                agent: 'orchestrator',
                tool_name: 'kate_reflection_pass',
                tool_input: { user_id },
                execution_result: summary,
              });
            } catch {
              /* audit is best-effort */
            }
          },
        },
        { user_id, tier, timezone, now: ctx.now },
      );
      return out;
    },
  };
}
