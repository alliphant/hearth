/**
 * drive_open_cases — Kate's Case Driver tick (Incident→Immunity S1,
 * 2026-07-02; engine: src/core/case_driver.ts).
 *
 * The deterministic walker that owns every process miss to proven closure:
 * stale cases get ONE directed scoped wake at the meta-agent whose step is
 * next (trainer to diagnose/fix, Mariah to verify a dispatched fix landed),
 * and cases still stuck after the nudge budget escalate ONCE to the owner as
 * an aggregate recommendation. All bookkeeping is durable ([case-driver]
 * markers in the miss's own notes_md), so restarts never re-nudge.
 *
 * NOT on Kate's LLM surfaces — the background job is the trigger; manual
 * catch-up via POST /api/specialists/kate/fire_background_job?name=drive_open_cases.
 * DARK behind HEARTH_CASE_DRIVER=1.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  run_case_driver,
  case_driver_enabled,
  type CaseDriverDeps,
} from '@core/case_driver';
import { ulid } from 'ulid';

const InputSchema = z.object({});
const OutputSchema = z.object({
  enabled: z.boolean(),
  examined: z.number(),
  nudged: z.array(z.string()),
  verify_swept: z.array(z.string()),
  escalated: z.array(z.string()),
  skipped_meta: z.number(),
  note: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_drive_open_cases(deps: CaseDriverDeps | null): Tool<Input, Output> {
  return {
    name: 'drive_open_cases',
    description:
      'Case Driver tick: walk every open process miss; nudge the owning meta-agent on stale ' +
      'cases, sweep dispatched fixes to verification, escalate the truly stuck ONCE. ' +
      'Deterministic; job-only.',
    risk: 'write_internal',
    required_capabilities: ['drive_cases'],
    // Result depends on ledger + wall-clock state — never serve a cached tick.
    volatile: true,
    input_schema: InputSchema,
    output_schema: OutputSchema,
    yield: { none: true, reason: 'a driver — it nudges only STALE open cases; zero means nothing has gone stale' },
    idempotency_key() {
      return `drive_open_cases:${ulid()}`;
    },
    async execute(_input, ctx: ToolContext): Promise<Output> {
      if (!deps) {
        return {
          enabled: case_driver_enabled(),
          examined: 0,
          nudged: [],
          verify_swept: [],
          escalated: [],
          skipped_meta: 0,
          note: 'case-driver deps unwired (no loop driver in this runtime) — no-op',
        };
      }
      const r = run_case_driver(deps, { now: ctx.now });
      ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: 'kate',
        tool_name: 'case_driver_tick',
        tool_input: {},
        execution_result: {
          enabled: r.enabled,
          examined: r.examined,
          nudged: r.nudged.length,
          verify_swept: r.verify_swept.length,
          escalated: r.escalated.length,
        },
      });
      return r;
    },
  };
}

/** ToolLoader entry: build from the shared deps bag. `wake_scoped` is wired
 *  by the orchestrator; absent (unit smokes, partial runtimes) the tool
 *  degrades to an honest no-op note instead of crashing. */
export function create(deps: ToolDeps): Tool {
  const wake = deps.wake_scoped;
  const driver_deps: CaseDriverDeps | null = wake
    ? { misses: deps.process_misses, proposals: deps.proposals, wake }
    : null;
  return make_drive_open_cases(driver_deps) as Tool;
}
