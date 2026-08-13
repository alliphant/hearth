import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';

const InputSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  context: z.string().optional(),
});

const OutputSchema = z.object({
  from: z.string(),
  to: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function basename_no_ext(rel_path: string): string {
  const base = rel_path.split('/').pop() ?? rel_path;
  return base.replace(/\.md$/, '');
}

export const link_notes: Tool<Input, Output> = {
  name: 'link_notes',
  description:
    'Insert a [[wikilink]] from one note to another under a "## Related" section, and record a graph_edges row.',
  risk: 'write_internal',
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.from);
    h.update('\n');
    h.update(input.to);
    h.update('\n');
    h.update(input.context ?? '');
    return `link_notes:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx): Promise<Output> {
    const wikilink = `[[${basename_no_ext(input.to)}]]`;
    const list_item = input.context
      ? `- ${wikilink} — ${input.context}`
      : `- ${wikilink}`;

    const existing = ctx.memory.read_note(input.from);
    const has_section = existing
      ? /^## Related\b/m.test(existing.body)
      : false;

    const block = has_section ? list_item : `## Related\n\n${list_item}`;

    ctx.memory.append_to_note(input.from, block);
    ctx.memory.add_edge(input.from, input.to, input.context);

    return { from: input.from, to: input.to };
  },
};
