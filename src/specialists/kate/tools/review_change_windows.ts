/**
 * review_change_windows — score every automated change against the eval suite
 * (2026-08-01). Kate's post-eval job.
 *
 * The measure half of apply-measure-revert. Each pending window carries the
 * golden-suite outcomes as they stood when its change was applied; this reads
 * the outcomes now, compares the SAME task set, and acts on the verdict.
 *
 * TWO DISCIPLINES, both deliberate:
 *
 * 1. **It flags before it reverts.** `HEARTH_AUTO_REVERT` is opt-in and default
 *    OFF, mirroring `HEARTH_RESEARCH_VERIFY_DROP` exactly: research
 *    verification surfaces verdicts and only DELETES dossier lines once its
 *    precision has been measured against real dossiers, because an automated
 *    actor that destroys work on a wrong verdict is worse than one that
 *    reports. Same here — the flake rate of this suite against a live model is
 *    precisely what has not been measured, and a reverter that misreads a flaky
 *    task undoes a good change. Off, a regression files a miss, wakes Beatrice
 *    and tells the owner exactly which one call would undo it.
 *
 * 2. **Mixed results are NEUTRAL, never reverted.** A change that fixes two
 *    behaviors and breaks one is a trade-off, and deciding it is the owner's
 *    job. Only a clean regression — something broke, nothing improved — is ever
 *    a candidate for an automatic undo.
 *
 * Only the role override is machine-revertible (one row update, exact recorded
 * prior, effective next request). A low-risk config fix has an inverse but it
 * routes through Kate review + owner merge; a code merge needs `git revert`
 * against shared main. Both escalate with the specific next step named.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { MemoryClient } from '@memory/client';
import type { ProcessMissStore } from '@core/process_misses';
import type { ScopedWaker } from '@core/reactive_triggers';
import type { ConfigLLMRouter } from '@core/router';
import {
  auto_revert_enabled,
  is_machine_revertible,
  measure_delta,
} from '@core/change_measurement';
import { ChangeWindowStore } from '@memory/stores/change_windows';
import { LlmRoleOverrideStore } from '@memory/stores/llm_role_overrides';

const InputSchema = z.object({
  /** Score one window instead of every pending one. */
  window_id: z.string().optional(),
});

const ResultSchema = z.object({
  window_id: z.string(),
  kind: z.string(),
  target: z.string(),
  verdict: z.string(),
  summary: z.string(),
  action_taken: z.string(),
  regressed_tasks: z.array(z.string()),
});

const OutputSchema = z.object({
  enabled: z.boolean(),
  auto_revert_armed: z.boolean(),
  windows_examined: z.number(),
  scored: z.array(ResultSchema),
  /** Windows left pending because the suite has not run since they opened. */
  still_pending: z.number(),
  reverted: z.number(),
  flagged: z.number(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export interface ReviewChangeWindowsDeps {
  db: import('bun:sqlite').Database;
  memory: MemoryClient;
  process_misses?: ProcessMissStore;
  waker?: ScopedWaker;
  router?: ConfigLLMRouter;
}

export function make_review_change_windows(deps: ReviewChangeWindowsDeps): Tool<Input, Output> {
  return {
    name: 'review_change_windows',
    description:
      'Score every automated change that has not been measured yet against the golden ' +
      'eval suite — a same-task before/after delta, never an absolute pass rate. A clean ' +
      'regression files a miss, wakes Beatrice, and names the one call that undoes it; ' +
      'with HEARTH_AUTO_REVERT=1 a machine-revertible change (an LLM role override) is ' +
      'undone automatically. Mixed results are a trade-off and are never auto-reverted.',
    risk: 'write_internal',
    required_capabilities: ['monitor_capability_yield'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,
    yield: { produced: ['scored'], considered: ['windows_examined'] },

    idempotency_key(input) {
      return `review_change_windows:${input.window_id ?? 'all'}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const windows = new ChangeWindowStore(deps.db);
      const armed = auto_revert_enabled();
      const pending = input.window_id
        ? [windows.get(input.window_id)].filter((w): w is NonNullable<typeof w> => w != null)
        : windows.pending();

      const after = windows.current_outcomes();
      const scored: z.infer<typeof ResultSchema>[] = [];
      let still_pending = 0;
      let reverted = 0;
      let flagged = 0;

      for (const w of pending) {
        const delta = measure_delta(w.baseline, after);

        // Inconclusive means the suite hasn't given us comparable evidence yet.
        // Leave the window OPEN so the next run can score it, rather than
        // burning it on a verdict that says nothing.
        if (delta.verdict === 'inconclusive') {
          still_pending += 1;
          continue;
        }

        let action = 'none';

        if (delta.verdict === 'regressed') {
          const can_revert = is_machine_revertible(w.kind);
          const undo_call =
            w.kind === 'llm_role_override'
              ? `manage_llm_role{action:"revert", role:"${w.target}"}`
              : w.kind === 'low_risk_fix'
                ? `revert_low_risk_fix{audit_id:"${w.ref}"} (routes through Kate review + owner merge)`
                : `git revert ${w.ref} (a human's call against shared main)`;

          if (armed && can_revert) {
            try {
              new LlmRoleOverrideStore(deps.db).revert(w.target, 'auto_revert');
              deps.router?.invalidate_override_cache();
              action = 'reverted';
              reverted += 1;
            } catch {
              action = 'revert_failed';
            }
          } else {
            action = 'flagged';
            flagged += 1;
          }

          // File the miss + wake Beatrice either way — a revert is not the end
          // of the story, it's the start of finding out why the change hurt.
          try {
            deps.process_misses?.create({
              subject_specialist_id: 'trainer',
              reporter: 'orchestrator',
              task_summary: `automated change to ${w.target} regressed the eval suite`,
              gap:
                `${delta.summary} The change: ${w.kind} on ${w.target} (${w.ref}), applied ` +
                `${w.applied_at} by ${w.applied_by} — "${w.reason}". ` +
                (action === 'reverted'
                  ? `It has been AUTO-REVERTED; the regression evidence stands and the change ` +
                    `should not be re-applied unmodified. `
                  : `It is STILL LIVE — undo with \`${undo_call}\`. `) +
                `Note the comparison is a same-task delta against the suite's own baseline, so a ` +
                `standing failure elsewhere is not what tripped this: these specific tasks passed ` +
                `before the change and fail after it.`,
              severity: 'high',
              evidence_ref: `change:regressed:${w.id}`,
            });
          } catch {
            /* fail-open */
          }
          try {
            deps.waker?.wake_deliberation_scoped('trainer', {
              task:
                `An automated change regressed the golden eval suite. ${delta.summary} ` +
                `Change: ${w.kind} on ${w.target} (${w.ref}) — "${w.reason}". ` +
                (action === 'reverted'
                  ? `It was auto-reverted, so behavior should be back to baseline — confirm that on ` +
                    `the next run, then work out WHY it regressed before anyone re-applies it. `
                  : `It is still live; the owner has been told the one call that undoes it. `) +
                `Diagnose which of the failing tasks' assertions the change broke — the eval detail ` +
                `for each names them — and fix the owning layer through your change pipeline.`,
              reason: `${w.kind} on ${w.target} regressed ${delta.regressed_tasks.length} eval task(s).`,
              dedupe_key: `change:regressed:${w.id}`,
            });
          } catch {
            /* fail-open */
          }
        }

        windows.record_verdict({
          id: w.id,
          verdict: delta.verdict,
          delta_summary: delta.summary,
          action_taken: action,
          ...(ctx.now ? { now: ctx.now } : {}),
        });

        scored.push({
          window_id: w.id,
          kind: w.kind,
          target: w.target,
          verdict: delta.verdict,
          summary: delta.summary,
          action_taken: action,
          regressed_tasks: delta.regressed_tasks,
        });
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kate',
        tool_name: 'change_windows_reviewed',
        tool_input: { window_id: input.window_id ?? null },
        execution_result: {
          auto_revert_armed: armed,
          windows_examined: pending.length,
          scored: scored.length,
          reverted,
          flagged,
        },
      });

      return {
        enabled: true,
        auto_revert_armed: armed,
        windows_examined: pending.length,
        scored,
        still_pending,
        reverted,
        flagged,
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_review_change_windows({
    db: deps.db,
    memory: deps.memory,
    ...(deps.process_misses ? { process_misses: deps.process_misses } : {}),
    ...(deps.wake_scoped
      ? { waker: { wake_deliberation_scoped: deps.wake_scoped } as ScopedWaker }
      : {}),
    ...(typeof (deps.llm as { invalidate_override_cache?: unknown }).invalidate_override_cache === 'function'
      ? { router: deps.llm as unknown as ConfigLLMRouter }
      : {}),
  }) as Tool;
}
