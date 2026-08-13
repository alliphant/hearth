/**
 * read_capability_demand — Kate's view of the tool-surface miss ledger.
 *
 * The read half of the capability-acquisition loop (2026-07-14): the runtime
 * records every forbidden-tool call, unknown-tool call, and load_tools
 * catalog miss into `capability_demand` (content-free — tool + capability +
 * specialist + surface, never message text); this tool returns the clustered
 * report so Kate can see what the team keeps reaching for and doesn't have.
 *
 * What she does with it:
 *   - a recurring 'unknown_tool' / 'forbidden' gap on a REAL need →
 *     `file_build_request` (Beatrice builds; Kate reviews; owner merges)
 *   - a 'forbidden' miss where the tool EXISTS and a teammate holds it →
 *     that's a grant question, not a build — flag Beatrice
 *     (apply_low_risk_fix covers surfacing an existing registered tool)
 *   - one-off noise (a hallucinated name that never recurs) → ignore
 *
 * This is the redesigned demand signal that replaced drive_roster_gaps
 * (disabled 2026-06-20): live, concrete misses from real turns instead of
 * mined audit clusters.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';

const InputSchema = z.object({
  /** Look-back window in days (1–90). */
  days: z.number().int().min(1).max(90).default(14),
  /** Max gap clusters returned. */
  limit: z.number().int().min(1).max(200).default(30),
});

const OutputSchema = z.object({
  window_days: z.number(),
  gaps: z.array(
    z.object({
      specialist_id: z.string(),
      kind: z.enum(['forbidden', 'unknown_tool', 'load_miss']),
      tool_name: z.string(),
      missing_capability: z.string().nullable(),
      hits: z.number(),
      first_seen: z.string(),
      last_seen: z.string(),
    }),
  ),
  next_action: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function create(deps: ToolDeps): Tool {
  const tool: Tool<Input, Output> = {
    name: 'read_capability_demand',
    description:
      'Read the capability-demand ledger — the clustered report of tools the team ' +
      '(you included) reached for and could not use — forbidden calls, unknown tool ' +
      'names, and load_tools misses, with recurrence counts. Use it when the owner asks ' +
      'what the system cannot do yet, or before filing a build — a gap that recurs is ' +
      'real demand. A recurring gap for a tool that does not exist → file_build_request ' +
      '(Beatrice builds it, review + owner-merge gated). A forbidden miss on a tool a ' +
      'teammate already owns → a grant/surfacing question — flag Beatrice. One-off ' +
      'noise → ignore. Read-only.',
    risk: 'read',
    required_capabilities: ['read_capability_demand'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key: (i) => `read_capability_demand:${i.days}:${i.limit}`,

    async execute(input, _ctx: ToolContext): Promise<Output> {
      const gaps = deps.memory.capability_demand.summarize({
        days: input.days,
        limit: input.limit,
      });
      const recurring = gaps.filter((g) => g.hits >= 3).length;
      return {
        window_days: input.days,
        gaps,
        next_action:
          gaps.length === 0
            ? 'No capability misses in the window — nothing to acquire.'
            : `${gaps.length} gap cluster(s), ${recurring} recurring (3+ hits). For a real ` +
              `recurring need, file_build_request with concrete acceptance criteria; for a ` +
              `tool a teammate already owns, flag Beatrice about the grant. Ignore one-off noise.`,
      };
    },
  };
  return tool as Tool;
}
