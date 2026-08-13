/**
 * read_service_logs — Beatrice's general read-only container-log access
 * (2026-06-22).
 *
 * diagnose_dependency reads the logs of a DOWN dependency; this generalizes that
 * to any allowlisted service so Beatrice can read the orchestrator's OWN logs
 * (the `[tool-recovery]` / `[guard-feedback]` lines, validation errors, the
 * spiral warnings) while diagnosing a tool-call miss — the same step a human
 * takes by hand. It is the SAME read-only ops-relay `/logs` path
 * (connectors/ops_relay.ts), with the SAME bearer + allowlist security model:
 * the relay only serves a service named on HEARTH_OPS_RESTART_ALLOWED, and is
 * fail-safe (unwired/unreachable → a structured `relay_unavailable`, never a
 * throw). No write surface — it cannot restart or change anything.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { fetch_logs, type OpsLogsResult } from '@connectors/ops_relay';

const InputSchema = z.object({
  service: z
    .string()
    .min(1)
    .max(120)
    .describe(
      'The container/service name whose recent logs to read (must be on the ' +
        "ops-relay allowlist), e.g. 'hearth-orchestrator', 'firecrawl-worker'.",
    ),
  tail: z
    .number()
    .int()
    .positive()
    .max(2000)
    .optional()
    .describe('How many recent log lines to return (default 200).'),
});

const OutputSchema = z.object({
  ok: z.boolean(),
  service: z.string(),
  reason: z.string(),
  logs: z.string(),
  note: z.string().nullable(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const LOG_CHAR_CAP = 12_000;

export interface ReadServiceLogsDeps {
  /** Smoke seam — defaults to the real ops-relay fetch_logs. */
  fetch_logs_fn?: (service: string, opts: { tail?: number }) => Promise<OpsLogsResult>;
}

export function make_read_service_logs(deps: ReadServiceLogsDeps = {}): Tool<Input, Output> {
  return {
    name: 'read_service_logs',
    description:
      "Read a service's recent container logs (read-only) via the guarded " +
      'ops-relay. Use it while diagnosing a tool-call/honesty miss to see the ' +
      "orchestrator's own logs — the `[tool-recovery]` remaps, the " +
      '`[guard-feedback]` escalations, validation errors, spiral warnings — or a ' +
      'failing connector container. Only services on the ops-relay allowlist are ' +
      'readable; an unwired/unreachable relay returns a clean ' +
      '`relay_unavailable` (reason it out from the audit log + the probe instead). ' +
      'It CANNOT restart or change anything.',
    risk: 'read',
    required_capabilities: ['read_service_logs'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,

    idempotency_key(input) {
      return `read_service_logs:${input.service}:${input.tail ?? 200}:${Math.floor(Date.now() / 30_000)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const fn = deps.fetch_logs_fn ?? ((svc, opts) => fetch_logs(svc, opts));
      let res: OpsLogsResult;
      try {
        res = await fn(input.service, { tail: input.tail ?? 200 });
      } catch (err) {
        res = { ok: false, reason: 'relay_unavailable', detail: err instanceof Error ? err.message : String(err) };
      }

      ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'trainer',
        tool_name: 'read_service_logs',
        tool_input: { service: input.service, tail: input.tail ?? 200 },
        execution_result: { ok: res.ok, reason: res.reason },
      });

      const note =
        res.ok
          ? null
          : res.reason === 'relay_unavailable'
            ? 'ops-relay is not wired/reachable (set HEARTH_OPS_RELAY_URL); read the audit log + run probe_interactive_endpoint instead'
            : res.reason === 'not_allowed'
              ? `"${input.service}" is not on the ops-relay allowlist (HEARTH_OPS_RESTART_ALLOWED) — only allowlisted services are readable`
              : (res.detail ?? 'log read failed');

      return {
        ok: res.ok,
        service: input.service,
        reason: res.reason,
        logs: typeof res.logs === 'string' ? res.logs.slice(-LOG_CHAR_CAP) : '',
        note,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(_deps: ToolDeps): Tool {
  return make_read_service_logs() as Tool;
}
