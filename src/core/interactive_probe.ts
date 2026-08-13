/**
 * interactive_probe — reproduce, in code, the live `:8088` tool-call probe a
 * human runs by hand (2026-06-22).
 *
 * When a tool keeps failing argument validation, the FIRST question is: can the
 * interactive model emit valid args AT ALL, or is the schema the problem? The
 * 2026-06-22 session answered it by POSTing canonical tool schemas to the
 * interactive endpoint and observing clean native `tool_calls` for simple,
 * nested, AND `pattern` shapes — which localized the blame to the SCHEMA
 * (gratuitously-specific field names), not the model. This module gives Beatrice
 * the same instrument: force the tool channel on three canonical shapes and
 * report, per shape, whether the model emitted a native tool_call with
 * schema-valid args.
 *
 * It is a pure capability probe — no side effects, fail-open (an endpoint outage
 * degrades to `reachable:false`, never throws), and the LLM call is behind a
 * `complete_fn` seam so the smoke drives it with a scripted model.
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { LLMRequest, LLMResponse, LLMRole, LLMRouter, ToolDef } from './llm';

export type ProbeShape = 'simple' | 'nested' | 'pattern';

export interface ProbeShapeResult {
  shape: ProbeShape;
  /** The endpoint responded at all. */
  reachable: boolean;
  /** The model returned a NATIVE tool_call (vs leaking it into `content`). */
  emitted_tool_call: boolean;
  /** The emitted call named our test tool. */
  called_right_tool: boolean;
  /** The emitted args validate against the test schema. */
  args_valid: boolean;
  /** Zod's first complaint when args_valid is false. */
  invalid_detail: string | null;
  model: string | null;
  latency_ms: number | null;
  /** When no tool_call was emitted, what landed in `content` (the dialect leak). */
  raw_content_sample: string;
  error: string | null;
}

export interface InteractiveProbeReport {
  role: string;
  enabled: boolean;
  results: ProbeShapeResult[];
  /** Every shape produced a native tool_call. */
  all_emitted: boolean;
  /** Every shape's args validated. */
  all_valid: boolean;
  /** One-line verdict that localizes blame (endpoint vs schema). */
  summary: string;
}

export function interactive_probe_enabled(): boolean {
  return process.env.HEARTH_INTERACTIVE_PROBE !== '0';
}

/** A canonical probe: a tool schema shape + a prompt that should elicit it +
 *  the validator for the args we expect back. */
interface ProbeSpec {
  shape: ProbeShape;
  tool: ToolDef;
  prompt: string;
  schema: z.ZodTypeAny;
}

function tool_def(name: string, description: string, schema: z.ZodTypeAny): ToolDef {
  const parameters = zodToJsonSchema(schema, { $refStrategy: 'none' }) as Record<string, unknown>;
  delete parameters.$schema;
  return { name, description, parameters };
}

/** The three shapes the 2026-06-22 probe used. `pattern` is the GBNF
 *  silent-fail-open trap (llama.cpp #22314) — the load-bearing one. */
function probe_specs(): ProbeSpec[] {
  const simple = z.object({ city: z.string().min(1) });
  const nested = z.object({
    location: z.object({ lat: z.number(), lng: z.number() }),
    label: z.string().min(1),
  });
  const pattern = z.object({ code: z.string().regex(/^[A-Z]{2}-\d{4}$/) });
  return [
    {
      shape: 'simple',
      tool: tool_def('get_weather', 'Get the current weather for a city.', simple),
      prompt: 'Get the current weather for Denver.',
      schema: simple,
    },
    {
      shape: 'nested',
      tool: tool_def('drop_pin', 'Drop a labeled pin at a coordinate.', nested),
      prompt: 'Drop a pin labeled "trailhead" at latitude 40.05, longitude -104.76.',
      schema: nested,
    },
    {
      shape: 'pattern',
      tool: tool_def('lookup_code', 'Look up a product by its code (format AB-1234).', pattern),
      prompt: 'Look up product code AB-1234.',
      schema: pattern,
    },
  ];
}

export type ProbeCompleteFn = (req: LLMRequest) => Promise<LLMResponse>;

export interface InteractiveProbeDeps {
  llm?: LLMRouter;
  /** Which role's endpoint to probe — default 'specialist' (the interactive
   *  chat tier). Beatrice can probe 'specialist_deliberation' for a
   *  deliberation-time failure. */
  role?: LLMRole;
  /** Restrict to a subset of shapes (default: all three). */
  shapes?: ProbeShape[];
  /** Test seam — defaults to the resolved role's provider.complete. */
  complete_fn?: ProbeCompleteFn;
  now?: () => number;
}

function default_complete(llm: LLMRouter | undefined, role: LLMRole): ProbeCompleteFn | null {
  if (!llm) return null;
  let resolved;
  try {
    resolved = llm.for_role(role);
  } catch {
    return null;
  }
  return (req) => resolved.provider.complete({ ...resolved.defaults, ...req });
}

async function run_one(spec: ProbeSpec, complete: ProbeCompleteFn, now: () => number): Promise<ProbeShapeResult> {
  const base: ProbeShapeResult = {
    shape: spec.shape,
    reachable: false,
    emitted_tool_call: false,
    called_right_tool: false,
    args_valid: false,
    invalid_detail: null,
    model: null,
    latency_ms: null,
    raw_content_sample: '',
    error: null,
  };
  const t0 = now();
  let resp: LLMResponse;
  try {
    resp = await complete({
      messages: [
        {
          role: 'system',
          content:
            'You are a tool-calling probe. Call the single provided tool with arguments derived from the user message. Reply with the tool call only.',
        },
        { role: 'user', content: spec.prompt },
      ],
      tools: [spec.tool],
      // Force the channel so this measures arg VALIDITY, not whether the model
      // chose to call — the runtime's force_first_tool uses the same lever.
      tool_choice: 'required',
      temperature: 0.1,
      max_tokens: 256,
      think: false,
    });
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
  base.reachable = true;
  base.model = resp.cost?.model ?? null;
  base.latency_ms = Math.max(0, now() - t0);
  const call = resp.tool_calls?.[0];
  if (!call) {
    base.raw_content_sample = (resp.content ?? '').slice(0, 200);
    return base;
  }
  base.emitted_tool_call = true;
  base.called_right_tool = call.name === spec.tool.name;
  const parsed = spec.schema.safeParse(call.arguments);
  base.args_valid = parsed.success;
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    base.invalid_detail = issue ? `${issue.path.join('.') || '<root>'}: ${issue.message}` : 'invalid args';
  }
  return base;
}

/**
 * Probe the interactive endpoint across the canonical shapes. Fail-open:
 * disabled → an empty report; an outage → per-shape `reachable:false`.
 */
export async function run_interactive_probe(deps: InteractiveProbeDeps = {}): Promise<InteractiveProbeReport> {
  const role: LLMRole = deps.role ?? 'specialist';
  const now = deps.now ?? (() => Date.now());
  if (!interactive_probe_enabled()) {
    return { role, enabled: false, results: [], all_emitted: false, all_valid: false, summary: 'probe disabled (HEARTH_INTERACTIVE_PROBE=0)' };
  }
  const complete = deps.complete_fn ?? default_complete(deps.llm, role);
  if (!complete) {
    return { role, enabled: true, results: [], all_emitted: false, all_valid: false, summary: 'no LLM router wired — probe could not run' };
  }
  const want = new Set(deps.shapes ?? (['simple', 'nested', 'pattern'] as ProbeShape[]));
  const specs = probe_specs().filter((s) => want.has(s.shape));
  const results: ProbeShapeResult[] = [];
  for (const spec of specs) {
    results.push(await run_one(spec, complete, now));
  }
  const reached = results.filter((r) => r.reachable);
  const all_emitted = reached.length > 0 && reached.every((r) => r.emitted_tool_call && r.called_right_tool);
  const all_valid = reached.length > 0 && reached.every((r) => r.args_valid);
  return { role, enabled: true, results, all_emitted, all_valid, summary: summarize(role, results, all_emitted, all_valid) };
}

function summarize(role: string, results: ProbeShapeResult[], all_emitted: boolean, all_valid: boolean): string {
  if (results.length === 0) return 'no shapes probed';
  const unreached = results.filter((r) => !r.reachable);
  if (unreached.length === results.length) {
    return `the ${role} endpoint is UNREACHABLE (${results[0]?.error ?? 'no response'}) — can't characterize tool-calling`;
  }
  if (all_emitted && all_valid) {
    return `the ${role} endpoint emits VALID native tool_calls for all probed shapes (simple/nested/pattern) — a recurring per-tool failure is the SCHEMA/CONTRACT, not the model`;
  }
  const bad = results
    .filter((r) => r.reachable && (!r.emitted_tool_call || !r.args_valid))
    .map((r) => `${r.shape}(${!r.emitted_tool_call ? 'no-tool-call' : `invalid: ${r.invalid_detail}`})`);
  return `the ${role} endpoint FAILED some shapes: ${bad.join(', ')} — the model/decoding may be implicated, not only the schema`;
}

/** Compact markdown for the evidence pack / proposal card. */
export function render_probe_markdown(report: InteractiveProbeReport): string {
  const lines: string[] = [];
  lines.push(`Interactive probe (\`${report.role}\`): ${report.summary}`);
  for (const r of report.results) {
    const verdict = !r.reachable
      ? `unreachable (${r.error ?? 'no response'})`
      : !r.emitted_tool_call
        ? `NO tool_call — leaked to content: "${r.raw_content_sample.slice(0, 80)}"`
        : !r.called_right_tool
          ? 'called the wrong tool'
          : r.args_valid
            ? `valid args (${r.latency_ms}ms, ${r.model ?? '?'})`
            : `INVALID args — ${r.invalid_detail}`;
    lines.push(`  - ${r.shape}: ${verdict}`);
  }
  return lines.join('\n');
}
