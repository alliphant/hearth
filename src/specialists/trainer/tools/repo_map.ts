/**
 * repo_map — Beatrice's symbol index over the source tree.
 *
 * `file — doc line — exported symbols` for every .ts file under a
 * directory, so she navigates by export name + reads RANGES instead of
 * paging whole files through 5 KB windows (the read-spiral class). Pair
 * with read_codebase_file's `mode: 'outline'` to pick a line range, then
 * a ranged full read of just that span.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { assert_allowed_path } from '../codebase_fs';
import { build_repo_map, render_repo_map } from '../repo_map';

const OUTPUT_CHAR_CAP = 24_000;

const InputSchema = z.object({
  /** Repo-relative directory to map, e.g. "src/core" or "src/specialists/kate".
   *  Keep it narrow — the whole of src/ is large; map the area you're
   *  changing. */
  dir: z.string().min(2).max(200),
});

const OutputSchema = z.object({
  dir: z.string(),
  file_count: z.number(),
  map: z.string(),
  truncated: z.boolean(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export const repo_map_tool: Tool<Input, Output> = {
  name: 'repo_map',
  description:
    'Symbol index of a source directory: every .ts file with its doc line and exported ' +
    'symbols (fn/const/class/type). THE way to find where something lives before reading ' +
    'code — jump to the file, use read_codebase_file mode:"outline" for line numbers, then ' +
    'read just that range. Keep dir narrow ("src/core", not "src"). Cached; repeat calls ' +
    'are free.',
  risk: 'read',
  required_capabilities: ['read_codebase'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    return `repo_map:${input.dir}`;
  },

  async execute(input, _ctx: ToolContext): Promise<Output> {
    const dir = input.dir.replace(/\/$/, '');
    assert_allowed_path(dir, 'repo_map');
    const { entries, truncated: walk_truncated } = build_repo_map(dir);
    const rendered = render_repo_map(entries, OUTPUT_CHAR_CAP);
    return {
      dir,
      file_count: entries.length,
      map: rendered.text,
      truncated: walk_truncated || rendered.truncated,
    };
  },
};

/** ToolLoader entry point. */
export function create(_deps: ToolDeps): Tool {
  return repo_map_tool as Tool;
}
