import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import { append_style_observations } from '@specialists/kate/style/append_observations';

const InputSchema = z.object({
  observation: z.string().min(1).max(2_000),
});

const OutputSchema = z.object({
  note_path: z.string(),
  entries_after: z.number(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_update_jasper_style_memory(vault_root: string): Tool<Input, Output> {
  return {
    name: 'update_jasper_style_memory',
    description:
      "Append a single dated, specific observation about Jasper's communication style to Knowledge/Kate/jasper_style.md. Use when you notice him push back on phrasing you used, or when seeing how he edits a draft. Capture intentional voice (register, idiom, rhythm), not typos or grammar slips he'd correct on a reread. Cap is 200 entries; oldest rotates out when full.",
    risk: 'write_internal',
    required_capabilities: ['write_vault_general'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `style:${createHash('sha256').update(input.observation).digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext) {
      const result = append_style_observations(
        ctx.memory,
        vault_root,
        [input.observation],
        ctx.now,
        ctx.user?.timezone,
      );
      return { note_path: result.note_path, entries_after: result.entries_after };
    },
  };
}
