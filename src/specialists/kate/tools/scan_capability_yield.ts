/**
 * scan_capability_yield — the detector for capabilities that succeed their way
 * to zero output (2026-08-01).
 *
 * Kate detects, Beatrice fixes — the same split `scan_system_health` uses. This
 * scan answers the one question nothing in the system asked before: **"this ran
 * 59 times and produced 3 rows — is that right?"**
 *
 * Three properties are deliberate:
 *
 *  1. **It reads `audit_log` rows that ALREADY EXIST.** No new write path, no
 *     hot-path cost, and — the part that matters — it works RETROACTIVELY. The
 *     background-job audit row has carried the full result JSON all along; the
 *     evidence for a two-month outage was sitting there unread. Pointing SQL at
 *     it means the first run diagnoses history rather than starting a clock.
 *
 *  2. **Deterministic, no LLM.** A yield verdict is arithmetic over run counts.
 *     Per LAW #1 the model's judgment belongs in the DIAGNOSIS
 *     (`diagnose_capability_yield`), not in deciding whether 0 is less than 1.
 *
 *  3. **It emits the EXISTING `quality_signal`**, so the escalation path is the
 *     one that already works: GuardFeedbackDriver → process_miss (Mariah's
 *     ledger, deduped at the chokepoint) → scoped Beatrice wake. There is no
 *     second closed loop, which is the failure mode this whole design avoids.
 *
 * `current_findings_refs` is the contract with `verify_fix_landed`: once a fix
 * restores yield, the ref stops appearing here and the miss auto-closes. Without
 * that the misses would accumulate forever — the exact thing the ledger's
 * verify step exists to prevent.
 */
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { MemoryClient } from '@memory/client';
import type { AppEventBus } from '@app/events';
import type { ToolRegistry } from '@core/tool_registry';
import {
  assess_yield,
  capability_yield_enabled,
  read_yield,
  run_is_active,
  yield_evidence_ref,
  yield_window_runs,
  type YieldAssessment,
  type YieldRun,
} from '@core/capability_yield';

/** How far back the run history is read. Generous — a weekly job needs weeks. */
function window_days(): number {
  const raw = Number.parseInt(process.env.HEARTH_YIELD_WINDOW_DAYS ?? '', 10);
  const v = Number.isFinite(raw) && raw > 0 ? raw : 45;
  return Math.max(2, Math.min(v, 365));
}

const InputSchema = z.object({
  /** Narrow to one capability — used by `verify_fix_landed` and by hand. */
  tool: z.string().optional(),
  /** Report every verdict, not just the actionable ones. Observability. */
  include_healthy: z.coerce.boolean().optional(),
});

const FindingSchema = z.object({
  tool: z.string(),
  specialist_id: z.string(),
  verdict: z.string(),
  runs_examined: z.number(),
  active_runs: z.number(),
  total_considered: z.number(),
  total_produced: z.number(),
  yield_ratio: z.number().nullable(),
  basis: z.string(),
  summary: z.string(),
});

const OutputSchema = z.object({
  enabled: z.boolean(),
  jobs_examined: z.number(),
  /** Declared-contract zero-output. These ESCALATE. */
  barren: z.array(FindingSchema),
  /** Convention-derived zero-output — REPORTED for a human, never escalated.
   *  The first live run flagged 15 of 54 this way and was wrong about most:
   *  a detector's correct output is zero, and the convention can latch onto
   *  the wrong field entirely. A declaration is what earns a wake. */
  suspected: z.array(FindingSchema),
  /** Neither a `Tool.yield` declaration nor the convention matched — an HONEST
   *  coverage gap. Reported, never escalated: unknown yield is not zero yield. */
  uncovered: z.array(FindingSchema),
  /** Present when include_healthy. Low-ratio jobs live here, not in `barren`. */
  healthy: z.array(FindingSchema).optional(),
  signals_emitted: z.number(),
  /** Evidence refs currently emitting — `verify_fix_landed` closes on absence. */
  current_findings_refs: z.array(z.string()),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export interface ScanYieldDeps {
  db: Database;
  memory: MemoryClient;
  tool_registry?: ToolRegistry;
  events?: AppEventBus;
}

interface RawRow {
  ts: string;
  agent: string;
  tool: string | null;
  result_json: string | null;
}

/**
 * Pull background-job runs, newest first. The `tool` comes from `tool_input.tool`
 * (the job's target) rather than the row's own `tool_name`, which is always the
 * literal string 'background_job'.
 */
function load_runs(db: Database, since_iso: string, only_tool?: string): RawRow[] {
  const params: Record<string, string> = { '@since': since_iso };
  let filter = '';
  if (only_tool) {
    filter = " AND json_extract(tool_input, '$.tool') = @tool";
    params['@tool'] = only_tool;
  }
  return db
    .prepare(
      `SELECT ts, agent,
              json_extract(tool_input, '$.tool') AS tool,
              execution_result AS result_json
         FROM audit_log
        WHERE tool_name = 'background_job'
          AND ts >= @since${filter}
        ORDER BY ts DESC`,
    )
    .all(params) as RawRow[];
}

/** Unwrap the loop's `{ok, tool, result}` envelope to the tool's own result. */
function inner_result(result_json: string | null): unknown {
  if (!result_json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result_json);
  } catch {
    return null;
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if ('result' in obj && obj.result && typeof obj.result === 'object') return obj.result;
  }
  return parsed;
}

export function make_scan_capability_yield(deps: ScanYieldDeps): Tool<Input, Output> {
  return {
    name: 'scan_capability_yield',
    description:
      'Find capabilities that RUN CLEANLY and produce nothing — the failure class error ' +
      'rate cannot see. Reads background-job run history and reports any whose input ' +
      'arrived but whose output stayed at zero. A job with no input is idle, not broken.',
    risk: 'write_internal',
    required_capabilities: ['monitor_capability_yield'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    // Its own yield is its findings — this scan is covered by its own rule.
    yield: { produced: ['signals_emitted'], considered: ['jobs_examined'] },

    idempotency_key(input) {
      return `scan_capability_yield:${input.tool ?? 'all'}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      if (!capability_yield_enabled()) {
        return {
          enabled: false,
          jobs_examined: 0,
          barren: [],
          suspected: [],
          uncovered: [],
          signals_emitted: 0,
          current_findings_refs: [],
        };
      }

      const since = new Date(Date.now() - window_days() * 86_400_000).toISOString();
      const rows = load_runs(deps.db, since, input.tool);

      // Group runs per capability, newest first (the query's order is preserved).
      const by_tool = new Map<string, { agent: string; runs: YieldRun[] }>();
      for (const row of rows) {
        if (!row.tool) continue;
        const declared = deps.tool_registry?.get(row.tool)?.yield;
        const result = inner_result(row.result_json);
        const entry = by_tool.get(row.tool) ?? { agent: row.agent, runs: [] };
        // Cap per tool at the assessment window — no point parsing 700 rows of
        // `scan_council_meetings` to answer a question about the last 10.
        if (entry.runs.length < yield_window_runs()) {
          entry.runs.push({
            ts: row.ts,
            active: run_is_active(result),
            reading: read_yield(result, declared),
          });
        }
        by_tool.set(row.tool, entry);
      }

      const barren: z.infer<typeof FindingSchema>[] = [];
      const suspected: z.infer<typeof FindingSchema>[] = [];
      const uncovered: z.infer<typeof FindingSchema>[] = [];
      const healthy: z.infer<typeof FindingSchema>[] = [];
      const refs: string[] = [];
      let signals = 0;

      for (const [tool, { agent, runs }] of by_tool) {
        const a: YieldAssessment = assess_yield(tool, runs);
        const finding = {
          tool,
          specialist_id: agent,
          verdict: a.verdict,
          runs_examined: a.runs_examined,
          active_runs: a.active_runs,
          total_considered: a.total_considered,
          total_produced: a.total_produced,
          yield_ratio: a.yield_ratio,
          basis: a.basis,
          summary: a.summary,
        };

        if (a.verdict === 'uncovered') {
          uncovered.push(finding);
          continue;
        }
        // Convention-derived zero-output is REPORTED, never escalated — it is
        // not evidence enough to wake an agent (see YieldVerdict's docs).
        if (a.verdict === 'suspected_barren') {
          suspected.push(finding);
          continue;
        }
        if (a.verdict !== 'barren') {
          healthy.push(finding);
          continue;
        }

        barren.push(finding);
        refs.push(yield_evidence_ref(tool));

        // Emit the EXISTING signal — GuardFeedbackDriver owns the escalation
        // (miss + scoped Beatrice wake + its own rate limits). Fail-open: a
        // detector must never break the scan that found the problem.
        try {
          deps.events?.emit({
            type: 'quality_signal',
            specialist_id: agent,
            signal_class: 'yield',
            guard: 'capability_yield_barren',
            tool,
            detail: a.summary,
          });
          signals += 1;
        } catch (err) {
          console.error(`[yield-scan] emit failed for ${tool} (continuing):`, err);
        }
      }

      barren.sort((x, y) => y.total_considered - x.total_considered);
      suspected.sort((x, y) => y.total_considered - x.total_considered);

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kate',
        tool_name: 'capability_yield_scan',
        tool_input: { tool: input.tool ?? null, window_days: window_days() },
        execution_result: {
          jobs_examined: by_tool.size,
          barren: barren.map((b) => b.tool),
          suspected: suspected.map((b) => b.tool),
          uncovered: uncovered.map((u) => u.tool),
          signals_emitted: signals,
        },
      });

      return {
        enabled: true,
        jobs_examined: by_tool.size,
        barren,
        suspected,
        uncovered,
        ...(input.include_healthy ? { healthy } : {}),
        signals_emitted: signals,
        current_findings_refs: refs,
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_scan_capability_yield({
    db: deps.db,
    memory: deps.memory,
    ...(deps.tool_registry ? { tool_registry: deps.tool_registry } : {}),
    ...(deps.events ? { events: deps.events } : {}),
  }) as Tool;
}
