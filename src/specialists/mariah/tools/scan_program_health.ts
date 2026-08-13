/**
 * scan_program_health — Mariah's detection pass for the closed loop.
 *
 * Sweeps the program for work that fell short and opens a process miss
 * for each failure not already tracked:
 *   - failed proposals — a specialist's dispatched action errored
 *   - failed promised follow-ups — a "let me look into X" that never
 *     delivered after its retries
 *   - stalled approvals — a proposal Jasper approved that was never
 *     executed; the work silently fell through after approval
 *   - guard recurrences (2026-08-11) — a `guard_counters` row (checks-gate
 *     rejections, dedup supersessions, round-ceiling exhaustions, directed
 *     duplicate-failure cuts) that crossed the recurrence threshold inside
 *     the window: a gate REPEATEDLY blocking work is a process gap even
 *     though each individual rejection was working as designed
 *
 * Deterministic and idempotent: a miss is keyed to its source by
 * evidence_ref, so re-running the scan never double-flags. Runs as
 * Mariah's hourly background job and can also be invoked directly.
 */
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { ProcessMissStore } from '@core/process_misses';
import type { ProposalsStore } from '@core/proposals';
import type { SpecialistRegistry } from '@core/specialist';
import type { ToolRegistry } from '@core/tool_registry';
import {
  GUARD_DIRECTED_DUP_FAILURE_CUT,
  GUARD_ROUND_CEILING_EXHAUST,
  GuardCounterStore,
} from '@memory/stores/guard_counters';
import { dispatch_proposal_now } from './dispatch_approved_proposal';

const InputSchema = z.object({
  // Reserved for future windowing; the scan is idempotent, so running
  // it over the whole failed set every time is safe.
  lookback_hours: z.coerce.number().int().positive().max(8760).optional(),
});

const OpenedSchema = z.object({
  miss_id: z.string(),
  subject_specialist_id: z.string(),
  source: z.string(),
  evidence_ref: z.string(),
});

const AutoDispatchSchema = z.object({
  proposal_id: z.string(),
  dispatched_tool: z.string().nullable(),
  ok: z.boolean(),
  detail: z.string(),
});

const OutputSchema = z.object({
  failed_proposals_seen: z.number(),
  failed_followups_seen: z.number(),
  stalled_approvals_seen: z.number(),
  /** guard_counters rows at/over the recurrence threshold inside the window
   *  (2026-08-11) — each untracked one opens a miss. */
  guard_recurrences_seen: z.number(),
  /**
   * Stalled approvals the scan auto-dispatched. An approved proposal
   * with `dispatch_tool` in its payload that has been pending execution
   * for at least AUTO_DISPATCH_AFTER_HOURS — typically because the
   * /decide route's auto-dispatch didn't fire — gets retried here.
   * Each entry is the result of one dispatch attempt.
   */
  auto_dispatched: z.array(AutoDispatchSchema),
  already_tracked: z.number(),
  misses_opened: z.array(OpenedSchema),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

interface FailedProposal {
  id: string;
  specialist_id: string;
  kind: string;
  rationale_md: string;
  execution_result_json: string | null;
}

interface FailedTask {
  id: string;
  context_json: string;
  attempts: number;
}

interface StalledProposal {
  id: string;
  specialist_id: string;
  kind: string;
  rationale_md: string;
  ts_decided: string;
}

/**
 * A proposal approved longer ago than this and still not executed is a
 * stall — not just in-flight. `execution_kind: 'none'` proposals are
 * excluded (they have nothing to execute, e.g. recommendations).
 */
const STALE_APPROVAL_HOURS = 12;

/**
 * When a stalled approval has a `dispatch_tool` named in its payload,
 * the /decide route should have run it automatically on approval. If
 * that didn't happen (the dispatch errored silently, the orchestrator
 * crashed mid-execution, or the proposal was filed before the dispatch
 * path was wired), the proposal sits in approved-not-executed limbo.
 * The scan auto-retries the dispatch after this window so a brief
 * transient failure doesn't trip an immediate re-attempt and Jasper
 * has time to manually intervene if he wants to. Shorter than
 * STALE_APPROVAL_HOURS so we cure the dispatch before opening a miss.
 */
const AUTO_DISPATCH_AFTER_HOURS = 1;

/**
 * Guard-recurrence sweep thresholds (2026-08-11). A single gate rejection is
 * the gate WORKING — only a counter that keeps climbing is a process gap. 3
 * hits inside 7 days matches the guard-feedback driver's escalation shape;
 * the window reads `last_at` so a historic counter that went quiet ages out.
 */
const GUARD_RECURRENCE_THRESHOLD = 3;
const GUARD_RECURRENCE_WINDOW_HOURS = 7 * 24;

/** Subject specialist for a guard-counter miss. Runtime guards scope by
 *  specialist (`<sid>` / `<sid>:<tool>`); the change-pipeline guards are
 *  Beatrice's machinery, so 'trainer' owns their recurrences. */
function guard_subject(guard: string, scope: string): string {
  if (guard === GUARD_ROUND_CEILING_EXHAUST) return scope;
  if (guard === GUARD_DIRECTED_DUP_FAILURE_CUT) return scope.split(':')[0] ?? 'trainer';
  return 'trainer';
}

function snippet(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function make_scan_program_health(
  db: Database,
  misses: ProcessMissStore,
  proposals: ProposalsStore,
  specialists: SpecialistRegistry,
  tool_registry: ToolRegistry,
): Tool<Input, Output> {
  return {
    name: 'scan_program_health',
    description:
      "Sweep the program for work that fell short and act on each one: failed proposals (a specialist's dispatched action errored — opens a process miss), failed promised follow-ups (a 'let me look into X' that never delivered — opens a process miss), stalled approvals (a proposal Jasper approved that names a dispatch_tool — auto-dispatches it, and opens a miss only if that dispatch FAILS; a manual/no-dispatch approval is a pending human action surfaced in the proposals queue, NOT a system miss, so it is left alone), and guard recurrences (a gate — checks failures, dedup supersessions, round-ceiling exhaustions, duplicate-failure cuts — that has fired 3+ times on one subject inside a week: opens a miss so a guard repeatedly blocking approved work becomes reviewable). Deterministic and idempotent — safe to run any time; misses key off evidence_ref so they don't double-open. Takes no required arguments. Returns a digest of what was seen plus the dispatches retried and misses newly opened. Mariah's detection-AND-resolution pass; runs hourly as her background job.",
    risk: 'write_internal',
    required_capabilities: ['write_process_miss', 'dispatch_proposal'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    yield: { none: true, reason: 'a detector — zero misses opened means the program is healthy, which is the good outcome' },
    idempotency_key() {
      return 'scan_program_health';
    },

    async execute(_input, ctx: ToolContext): Promise<Output> {
      const now = ctx.now ?? new Date();
      const tracked = new Set<string>();
      for (const m of misses.list()) {
        if (m.evidence_ref) tracked.add(m.evidence_ref);
      }
      const opened: z.infer<typeof OpenedSchema>[] = [];
      const auto_dispatched: z.infer<typeof AutoDispatchSchema>[] = [];
      let already = 0;

      // ── failed proposals ────────────────────────────────────────────────
      const failed_proposals = db
        .prepare(
          `SELECT id, specialist_id, kind, rationale_md, execution_result_json
             FROM proposals WHERE status = 'failed'`,
        )
        .all() as FailedProposal[];
      for (const p of failed_proposals) {
        if (tracked.has(p.id)) {
          already++;
          continue;
        }
        let gap = 'the proposal was approved but its execution failed';
        if (p.execution_result_json) {
          try {
            const r = JSON.parse(p.execution_result_json) as { error?: unknown };
            if (typeof r.error === 'string' && r.error.length > 0) {
              gap = `execution failed: ${snippet(r.error, 280)}`;
            }
          } catch {
            /* keep the default gap */
          }
        }
        const miss_id = misses.create({
          subject_specialist_id: p.specialist_id,
          reporter: 'mariah',
          task_summary: `proposal (${p.kind}) — ${snippet(p.rationale_md, 200)}`,
          gap,
          severity: 'medium',
          evidence_ref: p.id,
        });
        opened.push({
          miss_id,
          subject_specialist_id: p.specialist_id,
          source: 'failed_proposal',
          evidence_ref: p.id,
        });
      }

      // ── failed promised follow-ups ──────────────────────────────────────
      const failed_tasks = db
        .prepare(
          `SELECT id, context_json, attempts FROM scheduled_tasks
            WHERE status = 'failed' AND intent = 'deliver_followup'`,
        )
        .all() as FailedTask[];
      for (const t of failed_tasks) {
        if (tracked.has(t.id)) {
          already++;
          continue;
        }
        let subject = 'orchestrator';
        let summary = 'a promised follow-up';
        try {
          const parsed = JSON.parse(t.context_json) as {
            body?: { specialist_id?: string; summary?: string };
          };
          if (parsed.body?.specialist_id) subject = parsed.body.specialist_id;
          if (parsed.body?.summary) summary = parsed.body.summary;
        } catch {
          /* keep the defaults */
        }
        const miss_id = misses.create({
          subject_specialist_id: subject,
          reporter: 'mariah',
          task_summary: `promised follow-up — ${snippet(summary, 200)}`,
          gap: `the follow-up never delivered after ${t.attempts} attempt(s)`,
          severity: 'medium',
          evidence_ref: t.id,
        });
        opened.push({
          miss_id,
          subject_specialist_id: subject,
          source: 'failed_followup',
          evidence_ref: t.id,
        });
      }

      // ── stalled approvals ───────────────────────────────────────────────
      // Approved, never executed, and decided long enough ago to be a
      // real stall rather than in-flight work. `execution_kind: 'none'`
      // is excluded (nothing to execute), as is anything already carrying
      // `action_taken` (a manual proposal Jasper acted on — manual proposals
      // never stamp ts_executed, so action_taken is their completion mark).
      // The has_dispatch_tool gate below further filters to proposals the
      // system was actually meant to auto-run.
      //
      // Two paths: (1) if the payload names a `dispatch_tool` and the
      // approval is older than AUTO_DISPATCH_AFTER_HOURS, the scan
      // auto-retries the dispatch — Jasper already approved the proposal,
      // we're just curing a missed auto-execute. (2) Otherwise, or if
      // the dispatch errors, fall through to opening a process miss the
      // same way previous behavior did.
      const stale_cutoff = new Date(
        now.getTime() - STALE_APPROVAL_HOURS * 3_600_000,
      ).toISOString();
      const auto_cutoff = new Date(
        now.getTime() - AUTO_DISPATCH_AFTER_HOURS * 3_600_000,
      ).toISOString();
      // Pull both windows in one query — anything past auto-cutoff is a
      // candidate; whether it's also past stale-cutoff just tunes the
      // miss copy. payload_json is fetched so we can introspect
      // dispatch_tool without a second round-trip.
      const stalled = db
        .prepare(
          `SELECT id, specialist_id, kind, rationale_md, ts_decided, payload_json
             FROM proposals
            WHERE status = 'approved'
              AND ts_executed IS NULL
              AND execution_kind != 'none'
              AND (action_taken IS NULL OR action_taken = '')
              AND ts_decided IS NOT NULL
              AND ts_decided <= @cutoff`,
        )
        .all({ '@cutoff': auto_cutoff }) as Array<
        StalledProposal & { payload_json: string }
      >;
      for (const p of stalled) {
        // Try auto-dispatch first if the payload names a dispatch_tool.
        // The helper updates the proposal in-place (record_execution),
        // so a successful dispatch retires the stall without ever
        // opening a miss. A failed dispatch falls through to the
        // miss-opening path below (with the dispatch error captured).
        let has_dispatch_tool = false;
        try {
          const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
          has_dispatch_tool = typeof payload.dispatch_tool === 'string';
        } catch {
          /* unparseable payload — treat as no dispatch_tool */
        }
        let dispatch_error: string | null = null;
        if (has_dispatch_tool) {
          try {
            const result = await dispatch_proposal_now(p.id, {
              proposals,
              specialists,
              tool_registry,
              ctx: { memory: ctx.memory, llm: ctx.llm },
            });
            auto_dispatched.push({
              proposal_id: result.proposal_id,
              dispatched_tool: result.dispatched_tool,
              ok: result.ok,
              detail: result.detail,
            });
            if (result.ok) {
              // Cured: skip the miss.
              continue;
            }
            dispatch_error = result.detail;
          } catch (err) {
            dispatch_error = (err as Error).message;
            auto_dispatched.push({
              proposal_id: p.id,
              dispatched_tool: null,
              ok: false,
              detail: dispatch_error,
            });
          }
        }

        // A proposal with no dispatch_tool has no automated execution path —
        // its "execution" is a human action Jasper takes (or the owning
        // specialist's later turn), surfaced in the proposals queue, NOT a
        // SYSTEM stall for Beatrice to fix. Only a FAILED auto-dispatch
        // (has_dispatch_tool + dispatch_error) is a real process miss.
        // Before 2026-06-04 this branch opened a miss for every approved manual
        // proposal — and manual proposals NEVER stamp ts_executed (0/128), so
        // each re-fired hourly into 38 standing false positives in the inbox.
        if (!has_dispatch_tool) {
          continue;
        }

        // Only open a miss past the stale-approval window — between
        // auto-cutoff and stale-cutoff a failed dispatch retry sits
        // for one more scan cycle in case the cause was transient.
        if (p.ts_decided > stale_cutoff) {
          continue;
        }
        if (tracked.has(p.id)) {
          already++;
          continue;
        }
        const hours = Math.max(
          1,
          Math.round((now.getTime() - new Date(p.ts_decided).getTime()) / 3_600_000),
        );
        const gap = dispatch_error
          ? `the proposal was approved ${hours}h ago and auto-dispatch failed: ${dispatch_error}`
          : `the proposal was approved ${hours}h ago but never executed`;
        const miss_id = misses.create({
          subject_specialist_id: p.specialist_id,
          reporter: 'mariah',
          task_summary: `approved ${p.kind} — ${snippet(p.rationale_md, 200)}`,
          gap,
          severity: 'medium',
          evidence_ref: p.id,
        });
        opened.push({
          miss_id,
          subject_specialist_id: p.specialist_id,
          source: 'stalled_approval',
          evidence_ref: p.id,
        });
      }

      // ── guard recurrences (2026-08-11) ──────────────────────────────────
      // A guard_counters row over the threshold inside the window: a checks
      // gate, dedup key, round ceiling, or duplicate-failure cut that keeps
      // firing on the same subject. Each rejection was correct in isolation;
      // the RECURRENCE is the miss (the gate is blocking work structurally,
      // or the worker keeps walking into it — either way it's reviewable).
      const guard_rows = new GuardCounterStore(db).list({
        min_count: GUARD_RECURRENCE_THRESHOLD,
        since_hours: GUARD_RECURRENCE_WINDOW_HOURS,
      });
      for (const g of guard_rows) {
        const ref = `guard-counter:${g.guard}:${g.scope}`;
        if (tracked.has(ref)) {
          already++;
          continue;
        }
        const subject = guard_subject(g.guard, g.scope);
        const miss_id = misses.create({
          subject_specialist_id: subject,
          reporter: 'mariah',
          task_summary: `guard recurrence — ${g.guard} on ${g.scope}`,
          gap:
            `guard-recurrence: \`${g.guard}\` has fired ${g.count}× on \`${g.scope}\` ` +
            `(first ${g.first_at.slice(0, 10)}, last ${g.last_at.slice(0, 10)}). ` +
            `A gate rejecting the same subject repeatedly means approved work is being ` +
            `blocked structurally — diagnose whether the gate is wrong (fix the guard) ` +
            `or the worker keeps producing the same rejected input (fix the workflow).` +
            (g.last_detail ? ` Last detail: ${snippet(g.last_detail, 240)}` : ''),
          severity: 'medium',
          evidence_ref: ref,
        });
        opened.push({
          miss_id,
          subject_specialist_id: subject,
          source: 'guard_recurrence',
          evidence_ref: ref,
        });
      }

      return {
        failed_proposals_seen: failed_proposals.length,
        failed_followups_seen: failed_tasks.length,
        stalled_approvals_seen: stalled.length,
        guard_recurrences_seen: guard_rows.length,
        auto_dispatched,
        already_tracked: already,
        misses_opened: opened,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_scan_program_health(
    deps.db,
    deps.process_misses,
    deps.proposals,
    deps.specialists,
    deps.tool_registry,
  ) as Tool;
}
