/**
 * settle_observation — mark a watch ledger row PERMANENTLY settled.
 *
 * The `dismissed` status has existed since the ledger shipped, and carries the
 * strongest guarantee in it: `KateObservations.upsert` refuses to write over a
 * dismissed anchor, so a dismissed concern can never be re-raised. Until now
 * nothing outside the smoke could set it — no tool, no route. The ledger had a
 * terminal state and no door to it.
 *
 * What that cost, concretely: the household cancelled its Hyundai Bluelink
 * subscription outright, which makes "Bluelink cancellation still pending" not
 * a stale watch but a permanently false one. Kate re-noticed it on 15
 * consecutive nights across three splintered anchors, because the only
 * dispositions she could reach were `ignore` (re-derived nightly, from
 * scratch) and `watch` (re-entered the next pass by design). Neither can
 * express "this will never be true again."
 *
 * `ignore` says *not tonight*. `dismissed` says *not ever* — the difference
 * between a judgment she has to keep making and one she gets to keep.
 *
 * Risk is write_internal: the effect is bounded to Kate's own attention
 * ledger, touches no household state, sends nothing, and is reversible by the
 * owner from the People/observations surface. Under the standing rule that
 * composition is unrestricted and EFFECTS are what get gated, letting her
 * close her own open loops is exactly the class that should not need a human
 * in it.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { KateObservations } from '@memory/stores/kate_observations';

const InputSchema = z.object({
  /** The ledger anchor to settle. Normalized the same way it was written. */
  anchor: z.string().min(2),
  /** Why it is permanently settled — kept on the row for the audit trail. */
  reason: z.string().min(3),
});
const OutputSchema = z.object({
  settled: z.boolean(),
  anchor: z.string(),
  /** Absent when the anchor matched nothing (already gone, or mistyped). */
  previous_status: z.string().optional(),
  times_seen: z.number().optional(),
  note: z.string().optional(),
});
type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function create_settle_observation(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'settle_observation',
    description:
      'Permanently settle one of your own watch-ledger observations by anchor, ' +
      'so it is never raised again. Use it when a concern has become false for ' +
      'good rather than merely quiet — the service was cancelled, the trip is ' +
      'over, the person moved. Prefer the ignore disposition for something that ' +
      'is simply not worth attention tonight; this is the one-way door.',
    risk: 'write_internal',
    required_capabilities: ['reflect_household'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input: Input) {
      return `settle_observation:${KateObservations.normalize_anchor(input.anchor)}`;
    },

    async execute(input: Input, ctx: ToolContext): Promise<Output> {
      const store = new KateObservations(deps.db);
      const anchor = KateObservations.normalize_anchor(input.anchor);
      const row = store.get_by_anchor(anchor);
      if (row === null) {
        return {
          settled: false,
          anchor,
          note: 'No observation carries that anchor — nothing to settle.',
        };
      }
      if (row.status === 'dismissed') {
        return {
          settled: true,
          anchor,
          previous_status: 'dismissed',
          times_seen: row.times_seen,
          note: 'Already settled.',
        };
      }
      const ok = store.set_status(row.id, 'dismissed', ctx.now);
      try {
        deps.memory.log_action({
          intent_id: `settle-${Date.now()}`,
          agent: 'kate',
          tool_name: 'settle_observation',
          tool_input: { anchor, reason: input.reason, previous_status: row.status },
          execution_result: { settled: ok, times_seen: row.times_seen },
        });
      } catch {
        /* audit is best-effort */
      }
      return {
        settled: ok,
        anchor,
        previous_status: row.status,
        times_seen: row.times_seen,
      };
    },
  };
}
