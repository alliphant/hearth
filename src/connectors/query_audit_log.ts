/**
 * query_audit_log — read-only access to the audit_log SQLite table.
 *
 * Lets a specialist (Beatrice the Trainer, Cassandra for security
 * audits) see what tools the rest of the team has been reaching for,
 * which ones failed, and what kinds of asks fell through to "no
 * tool exists." This is the input she needs to identify capability
 * gaps and propose new skills/tools.
 *
 * Hard caps: 200 rows max, 7 days max lookback, no SQL injection
 * surface (all params bound). The audit_log is privileged — bound
 * by `read_audit_log` capability — but it's bounded to the
 * post-redaction values, so map coordinates etc. are already
 * coarsened (see PART 10 of the maps connector).
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { SqlBind } from '@memory/stores/structured';
import type { Tool, ToolContext } from '@core/tool';
import { require_caller_tier } from '@core/tool_gates';

const InputSchema = z.object({
  /** Filter by agent (specialist id, 'orchestrator', 'ingestor', etc.). */
  agent: z.string().optional(),
  /** Filter by tool name (exact match). */
  tool_name: z.string().optional(),
  /** Substring match against tool_name (use when you don't know the exact name). */
  tool_name_contains: z.string().optional(),
  /** Only rows with a non-null error. */
  errors_only: z.coerce.boolean().default(false),
  /** Hours of lookback. Default 24, max 168 (one week). */
  hours: z.coerce.number().int().positive().max(168).default(24),
  /** Max rows returned. Default 50, max 200. */
  limit: z.coerce.number().int().positive().max(200).default(50),
});

const Row = z.object({
  ts: z.string(),
  agent: z.string(),
  tool_name: z.string(),
  tool_input_preview: z.string(),
  execution_result_preview: z.string().nullable(),
  error: z.string().nullable(),
});

const OutputSchema = z.object({
  rows: z.array(Row),
  total_matched: z.number(),
  window: z.object({ start_iso: z.string(), end_iso: z.string() }),
  /**
   * Aggregate by tool_name with counts (success/error). Lets the
   * caller see "tool X errored 17/20 times" without scanning rows.
   */
  by_tool: z.array(
    z.object({
      tool_name: z.string(),
      count: z.number(),
      error_count: z.number(),
    }),
  ),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function preview(s: string | null, max = 200): string | null {
  if (s == null) return null;
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export const query_audit_log: Tool<Input, Output> = {
  name: 'query_audit_log',
  description:
    "Inspect the audit_log table — what tools have been invoked, by whom, with what results / errors. Useful for capability-gap analysis and security-pattern audits. Filter by `agent` (specialist id), `tool_name` (exact) or `tool_name_contains` (substring), `errors_only`, and a `hours` lookback (≤168). Returns up to 200 rows plus a per-tool count aggregate. Example: {agent: 'kate', errors_only: true, hours: 48} to see what Kate's been trying and failing at.",
  risk: 'read',
  required_capabilities: ['read_audit_log'],
  input_schema: InputSchema,
  output_schema: OutputSchema,
  // A pure read: it SELECTs from audit_log and returns rows. There is no write
  // path, so "produced zero" is meaningless here — the whole output IS the
  // product. It was the loudest false positive on the yield scan's first live
  // run (62,243 rows "considered", 0 "produced") for exactly that reason.
  yield: { none: true, reason: 'read-only query — returns audit rows, writes nothing' },

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(JSON.stringify(input));
    return `query_audit_log:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    // Phase 2b/4 — owner-only tool. Defense-in-depth: Cassandra and
    // Mariah (the specialists granted read_audit_log) are already
    // hard-refused for non-owner via allowed_tiers, but a future
    // specialist getting this capability by mistake should still bounce.
    require_caller_tier(ctx, ['owner']);
    const db = (ctx.memory as unknown as { cfg: { db: import('bun:sqlite').Database } })
      .cfg.db;
    const end = new Date();
    const start = new Date(end.getTime() - input.hours * 60 * 60 * 1000);

    const clauses: string[] = ['ts >= @start_iso', 'ts <= @end_iso'];
    const params: Record<string, SqlBind> = {
      '@start_iso': start.toISOString(),
      '@end_iso': end.toISOString(),
    };
    if (input.agent) {
      clauses.push('agent = @agent');
      params['@agent'] = input.agent;
    }
    if (input.tool_name) {
      clauses.push('tool_name = @tool_name');
      params['@tool_name'] = input.tool_name;
    }
    if (input.tool_name_contains) {
      clauses.push("tool_name LIKE @tool_like");
      params['@tool_like'] = `%${input.tool_name_contains}%`;
    }
    if (input.errors_only) {
      clauses.push('error IS NOT NULL');
    }

    const where = clauses.join(' AND ');
    const rows = db
      .prepare(
        `SELECT ts, agent, tool_name, tool_input, execution_result, error
         FROM audit_log
         WHERE ${where}
         ORDER BY ts DESC
         LIMIT @limit`,
      )
      .all({ ...params, '@limit': input.limit }) as Array<{
      ts: string;
      agent: string;
      tool_name: string;
      tool_input: string;
      execution_result: string | null;
      error: string | null;
    }>;

    const total_row = db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE ${where}`)
      .get(params) as { n: number };

    const by_tool_rows = db
      .prepare(
        `SELECT tool_name,
                COUNT(*) AS count,
                SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS error_count
         FROM audit_log
         WHERE ${where}
         GROUP BY tool_name
         ORDER BY count DESC`,
      )
      .all(params) as Array<{ tool_name: string; count: number; error_count: number }>;

    const result: Output = {
      rows: rows.map((r) => ({
        ts: r.ts,
        agent: r.agent,
        tool_name: r.tool_name,
        tool_input_preview: preview(r.tool_input, 200) ?? '',
        execution_result_preview: preview(r.execution_result, 200),
        error: preview(r.error, 300),
      })),
      total_matched: total_row.n,
      window: { start_iso: start.toISOString(), end_iso: end.toISOString() },
      by_tool: by_tool_rows.map((r) => ({
        tool_name: r.tool_name,
        count: r.count,
        error_count: r.error_count,
      })),
    };

    ctx.memory.log_action({
      intent_id: ctx.intent_id || ulid(),
      agent: 'orchestrator',
      tool_name: 'query_audit_log',
      tool_input: {
        agent: input.agent,
        tool_name: input.tool_name,
        tool_name_contains: input.tool_name_contains,
        hours: input.hours,
        errors_only: input.errors_only,
      },
      execution_result: {
        returned: rows.length,
        total_matched: result.total_matched,
        distinct_tools: result.by_tool.length,
      },
    });

    return result;
  },
};
