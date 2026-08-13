/**
 * analyze_capability_gaps — Beatrice's hiring-time gap analysis.
 *
 * Given a capability wishlist for a prospective specialist, Beatrice
 * sorts each token into one of two tiers:
 *
 *   - covered     — the capability already exists in the system, so it
 *                   can be granted on day one. (A capability token is
 *                   registered in the same PR as the tool that backs
 *                   it — see config/capabilities.yaml — so a known
 *                   token always has tooling behind it.)
 *   - needs_build — no such capability exists yet; a new tool (and its
 *                   token) has to be built before the specialist can do
 *                   this. It goes on the build queue.
 *
 * Kate's `propose_hire` consults this tool to turn a wishlist into the
 * two-tier hiring plan; Beatrice can also be asked it directly.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { ToolRegistry } from '@core/tool_registry';
import { is_capability } from '@core/capabilities';

const InputSchema = z.object({
  capability_wishlist: z
    .array(z.string().min(1))
    .describe('Capability tokens the prospective specialist would want.'),
});

const AnalyzedSchema = z.object({
  capability: z.string(),
  status: z.enum(['covered', 'needs_build']),
  existing_tools: z.array(z.string()),
  note: z.string(),
});

const OutputSchema = z.object({
  analyzed: z.array(AnalyzedSchema),
  /** Covered tokens — grantable on day one. */
  day_1: z.array(z.string()),
  /** needs_build tokens — each one needs a tool built before it works. */
  build_queue: z.array(z.string()),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/** Tools in the registry that declare `token` in required_capabilities. */
function tools_providing(registry: ToolRegistry, token: string): string[] {
  return registry
    .list()
    .filter((t) => (t.required_capabilities ?? []).includes(token as never))
    .map((t) => t.name)
    .sort();
}

function make_analyze_capability_gaps(registry: ToolRegistry): Tool<Input, Output> {
  return {
    name: 'analyze_capability_gaps',
    description:
      'Hiring-time gap analysis. Given a capability wishlist for a prospective specialist, sort each token into `covered` (the capability already exists — grantable on day one) or `needs_build` (no such capability yet — a new tool has to be built first). Returns the per-token analysis plus two convenience lists: day_1 and build_queue. Takes `capability_wishlist`, an array of capability tokens.',
    risk: 'read',
    required_capabilities: ['read_codebase'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `analyze_capability_gaps:${[...input.capability_wishlist].sort().join(',')}`;
    },

    async execute(input, _ctx: ToolContext): Promise<Output> {
      // De-dupe the wishlist; order is not meaningful.
      const wishlist = [...new Set(input.capability_wishlist)];
      const analyzed: z.infer<typeof AnalyzedSchema>[] = [];
      const day_1: string[] = [];
      const build_queue: string[] = [];

      for (const token of wishlist) {
        const known = is_capability(token);
        const providers = tools_providing(registry, token);
        if (known) {
          day_1.push(token);
          analyzed.push({
            capability: token,
            status: 'covered',
            existing_tools: providers,
            note:
              providers.length > 0
                ? `Already supported — backed by: ${providers.join(', ')}.`
                : 'Capability token exists; grantable on day one.',
          });
        } else {
          build_queue.push(token);
          analyzed.push({
            capability: token,
            status: 'needs_build',
            existing_tools: [],
            note:
              'No capability token exists yet — a new tool (and its token) ' +
              'must be built before this specialist can do it.',
          });
        }
      }

      return { analyzed, day_1, build_queue };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_analyze_capability_gaps(deps.tool_registry) as Tool;
}
