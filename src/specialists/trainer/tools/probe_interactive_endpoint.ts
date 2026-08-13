/**
 * probe_interactive_endpoint — let Beatrice reproduce, on demand, the live
 * `:8088` tool-call probe a human runs by hand (2026-06-22).
 *
 * Sends three canonical tool schemas (simple / nested / regex-`pattern`) to the
 * interactive endpoint with the tool channel FORCED, and reports per shape
 * whether the model emitted a native tool_call with schema-valid args. The
 * verdict localizes blame: if the endpoint emits valid args for every shape,
 * a recurring per-tool failure is the SCHEMA/CONTRACT, not the model.
 *
 * Read-only, fail-open (an endpoint outage degrades to `reachable:false`), and
 * kill-switched (HEARTH_INTERACTIVE_PROBE=0). On Beatrice's diagnostic surface.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  run_interactive_probe,
  render_probe_markdown,
  type InteractiveProbeDeps,
} from '@core/interactive_probe';

const InputSchema = z.object({
  role: z
    .string()
    .optional()
    .describe(
      "Which interactive role's endpoint to probe — default 'specialist' (the chat tier). " +
        "Use 'specialist_deliberation' to probe the deliberation tier.",
    ),
});

const ShapeResultSchema = z.object({
  shape: z.string(),
  reachable: z.boolean(),
  emitted_tool_call: z.boolean(),
  called_right_tool: z.boolean(),
  args_valid: z.boolean(),
  invalid_detail: z.string().nullable(),
  model: z.string().nullable(),
  latency_ms: z.number().nullable(),
  error: z.string().nullable(),
});

const OutputSchema = z.object({
  ok: z.boolean(),
  enabled: z.boolean(),
  role: z.string(),
  summary: z.string(),
  all_emitted: z.boolean(),
  all_valid: z.boolean(),
  results: z.array(ShapeResultSchema),
  markdown: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export interface ProbeEndpointDeps {
  /** Smoke seam — defaults to the real run_interactive_probe. */
  probe_fn?: (deps: InteractiveProbeDeps) => ReturnType<typeof run_interactive_probe>;
}

export function make_probe_interactive_endpoint(deps: ProbeEndpointDeps = {}): Tool<Input, Output> {
  return {
    name: 'probe_interactive_endpoint',
    description:
      'PROBE the interactive LLM endpoint to characterize its tool-calling health. ' +
      'Forces the tool channel on three canonical schema shapes (simple / nested / ' +
      'regex-pattern) and reports, per shape, whether the model emitted a native ' +
      'tool_call with schema-valid args. Use it to LOCALIZE blame when a tool keeps ' +
      'failing argument validation: if the endpoint emits valid args for all shapes, ' +
      "the model is fine and the failing tool's SCHEMA/CONTRACT is the problem (a " +
      'gratuitously-specific required field). Read-only; pass `role` to probe a ' +
      "non-chat tier (default 'specialist').",
    risk: 'read',
    required_capabilities: ['diagnose_toolcalls'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,

    idempotency_key(input) {
      return `probe_interactive_endpoint:${input.role ?? 'specialist'}:${Math.floor(Date.now() / 60_000)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const probe = deps.probe_fn ?? run_interactive_probe;
      const report = await probe({
        ...(ctx.llm ? { llm: ctx.llm } : {}),
        ...(input.role ? { role: input.role } : {}),
      });

      ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'trainer',
        tool_name: 'probe_interactive_endpoint',
        tool_input: { role: report.role },
        execution_result: { all_emitted: report.all_emitted, all_valid: report.all_valid, summary: report.summary },
      });

      return {
        ok: report.enabled,
        enabled: report.enabled,
        role: report.role,
        summary: report.summary,
        all_emitted: report.all_emitted,
        all_valid: report.all_valid,
        results: report.results.map((r) => ({
          shape: r.shape,
          reachable: r.reachable,
          emitted_tool_call: r.emitted_tool_call,
          called_right_tool: r.called_right_tool,
          args_valid: r.args_valid,
          invalid_detail: r.invalid_detail,
          model: r.model,
          latency_ms: r.latency_ms,
          error: r.error,
        })),
        markdown: render_probe_markdown(report),
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(_deps: ToolDeps): Tool {
  return make_probe_interactive_endpoint() as Tool;
}
