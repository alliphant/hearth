/**
 * court_scorecard — Kate's read on how the Proposal Court is scoring against
 * the owner (trust-teeth Phase 1, 2026-07-02; engine:
 * src/core/court_scorecard.ts).
 *
 * "How's the court doing?" / "Are we ready to arm trust teeth?" — returns
 * per-lens + overall court-vs-owner agreement over the window, reversal and
 * digest-reaction counts, the historical-signature backtest, and the
 * documented arming gate (`meets_target` + `gate_note`). Pure derived read;
 * the arming itself stays a human decision (HEARTH_TRUST_TEETH).
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { Database } from 'bun:sqlite';
import { gather_court_scorecard } from '@core/court_scorecard';
import { ProposalsStore } from '@core/proposals';

const InputSchema = z.object({
  window_days: z
    .number()
    .int()
    .min(1)
    .max(90)
    .optional()
    .describe('Lookback window in days (default 30).'),
});

const RateSchema = z.object({
  comparisons: z.number(),
  agreed: z.number(),
  rate: z.number().nullable(),
});

const OutputSchema = z.object({
  window_days: z.number(),
  since: z.string(),
  cases_total: z.number(),
  split_resolved: z.number(),
  split_pending: z.number(),
  decided_by_court: z.number(),
  decided_reversed: z.number(),
  decided_endorsed: z.number(),
  decided_challenged: z.number(),
  decided_unchallenged: z.number(),
  armed: z.number(),
  overall: RateSchema,
  per_lens: z.array(RateSchema.extend({ seat: z.string() })),
  // Per-kind agreement + the kinds that have EARNED arming on their own
  // record. The engine has computed these since 2026-08-02, but this schema
  // never declared them, so zod stripped them on the way out and Kate could
  // not see the very numbers the ratchet is read from. A field the specialist
  // cannot see is not shipped.
  per_kind: z.array(RateSchema.extend({ kind: z.string(), meets_target: z.boolean().nullable() })),
  armable_kinds: z.array(z.string()),
  backtest: z.object({ cases: z.number(), agreed: z.number(), rate: z.number().nullable() }),
  target_rate: z.number(),
  min_comparisons: z.number(),
  min_kind_comparisons: z.number(),
  meets_target: z.boolean().nullable(),
  gate_note: z.string(),
  /** What became of what the staff filed — the drain, as a learning signal. */
  filing_yield: z.array(
    z.object({
      specialist_id: z.string(),
      kind: z.string(),
      filed: z.number(),
      acted: z.number(),
      denied: z.number(),
      lapsed: z.number(),
      open: z.number(),
      yield_rate: z.number().nullable(),
    }),
  ),
  filing_note: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_court_scorecard(deps: { db: Database }): Tool<Input, Output> {
  return {
    name: 'court_scorecard',
    description:
      'How the Proposal Court is scoring against the owner: per-lens, per-KIND and overall ' +
      'agreement, which kinds have earned arming on their own record, reversals, the signature ' +
      'backtest, the arming bar, and filing YIELD — what became of what each specialist filed. ' +
      'Use when asked how the court is doing, whether auto-execution has earned arming, or why ' +
      'the queue is not draining.',
    risk: 'read',
    required_capabilities: ['convene_court'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    idempotency_key(input) {
      return `court_scorecard:${input.window_days ?? 30}`;
    },
    async execute(input, ctx: ToolContext): Promise<Output> {
      const card = gather_court_scorecard(deps.db, { window_days: input.window_days });
      const yields = new ProposalsStore(deps.db).filing_yield({
        window_days: card.window_days,
      });
      // Lead with what is NOT landing: a class filed repeatedly and acted on
      // rarely is the loop worth closing, and it is the one a queue count
      // hides. Scored only where there is terminal evidence.
      const worst = yields
        .filter((y) => y.yield_rate !== null && y.acted + y.denied + y.lapsed >= 3)
        .sort((a, b) => (a.yield_rate ?? 1) - (b.yield_rate ?? 1))[0];
      const filing_note = worst
        ? `Lowest-yield filing: ${worst.specialist_id}/${worst.kind} — ${worst.acted} of ` +
          `${worst.acted + worst.denied + worst.lapsed} decided landed ` +
          `(${worst.lapsed} lapsed unactioned). A class that keeps lapsing is not a queue ` +
          `problem; it is a signal the household does not want it filed.`
        : 'Not enough decided filings yet to judge yield.';
      ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: 'kate',
        tool_name: 'court_scorecard',
        tool_input: { window_days: card.window_days },
        execution_result: {
          cases_total: card.cases_total,
          overall: card.overall,
          meets_target: card.meets_target,
          armable_kinds: card.armable_kinds,
          lowest_yield: worst ? `${worst.specialist_id}/${worst.kind}` : null,
        },
      });
      return { ...card, filing_yield: yields, filing_note };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_court_scorecard({ db: deps.db }) as Tool;
}
