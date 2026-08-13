/**
 * grep_codebase — find where something is defined in the Hearth source tree
 * by CONTENT, so Beatrice can locate a file she doesn't have an exact path
 * for instead of guessing/permuting filenames (the failure mode that had her
 * burn a dozen rounds on `workstation.ts` / `workstations.ts` /
 * `query_workstations.ts` and then punt to a scheduled followup).
 *
 * Regex search across the same allowlisted tree read_codebase_file can open
 * (src/, config/, scripts/, apps/). Returns matching `path:line: text` rows;
 * the usual next move is one read_codebase_file on the winning path.
 *
 * Read-only. Owner-tier only (Beatrice is internal staff). Bounded: caps on
 * files walked, per-file size, and matches returned so it can never hang a
 * turn.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  assert_allowed_path,
  existing_roots,
  read_text_file,
  walk_files,
} from '../codebase_fs';

const MAX_RESULTS_CAP = 200;
const MAX_LINE_LEN = 240;

const InputSchema = z.object({
  // JavaScript regex source. Plain substrings work too (they're valid regex).
  pattern: z.string().min(1).max(200),
  // Restrict the search to a subtree, e.g. "src/connectors". Omit to search
  // every allowlisted root.
  path_prefix: z.string().min(1).max(500).optional(),
  // Filename glob filter on the basename, e.g. "*.ts" or "*.yaml". Only `*`
  // and `?` are special.
  glob: z.string().min(1).max(100).optional(),
  case_sensitive: z.coerce.boolean().default(false),
  max_results: z.coerce.number().int().min(1).max(MAX_RESULTS_CAP).default(50),
});

const MatchSchema = z.object({
  path: z.string(),
  line: z.number(),
  text: z.string(),
});

const OutputSchema = z.object({
  pattern: z.string(),
  path_prefix: z.string(),
  files_scanned: z.number(),
  match_count: z.number(),
  truncated: z.boolean(),
  matches: z.array(MatchSchema),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/** Compile a basename glob (`*`, `?`) into an anchored RegExp. */
function glob_to_regexp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export function make_grep_codebase(): Tool<Input, Output> {
  return {
    name: 'grep_codebase',
    description:
      'Search the Hearth source tree by content (regex) to LOCATE code you do not have an exact path for — where a tool/capability/route/symbol is defined, every caller of a function, which YAML grants a token. Returns path:line:text hits; then read_codebase_file the winner. Use this BEFORE guessing paths. Searches src/, config/, scripts/, apps/; skips secrets, .git, node_modules, data/, and binary files. Args: pattern (regex), optional path_prefix (e.g. "src/connectors"), optional glob (e.g. "*.ts"), case_sensitive, max_results. Read-only.',
    risk: 'read',
    required_capabilities: ['read_codebase'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `grep_codebase:${input.case_sensitive ? 'cs' : 'ci'}:${input.path_prefix ?? '*'}:${input.glob ?? '*'}:${input.max_results}:${input.pattern}`;
    },

    async execute(input, _ctx: ToolContext): Promise<Output> {
      let re: RegExp;
      try {
        re = new RegExp(input.pattern, input.case_sensitive ? '' : 'i');
      } catch (err) {
        throw new Error(
          `grep_codebase: invalid regex "${input.pattern}" — ${(err as Error).message}. Escape regex metacharacters (. * + ? ( ) [ ] { } | \\) to search them literally.`,
        );
      }
      const glob_re = input.glob ? glob_to_regexp(input.glob) : null;

      // Resolve the search roots: an explicit prefix (allowlist-validated) or
      // every existing allowlist root.
      const roots = input.path_prefix
        ? [assert_allowed_path(input.path_prefix, 'grep_codebase')]
        : existing_roots();

      const matches: Output['matches'] = [];
      let files_scanned = 0;
      let walk_truncated = false;

      outer: for (const root of roots) {
        const { files, truncated } = walk_files(root);
        walk_truncated ||= truncated;
        for (const rel of files) {
          if (glob_re && !glob_re.test(rel.slice(rel.lastIndexOf('/') + 1))) continue;
          const contents = read_text_file(rel);
          if (contents === null) continue;
          files_scanned++;
          const lines = contents.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const ln = lines[i];
            if (ln === undefined) continue;
            if (re.test(ln)) {
              const text = ln.trim().slice(0, MAX_LINE_LEN);
              matches.push({ path: rel, line: i + 1, text });
              if (matches.length >= input.max_results) break outer;
            }
          }
        }
      }

      const truncated = walk_truncated || matches.length >= input.max_results;
      return {
        pattern: input.pattern,
        path_prefix: input.path_prefix ?? roots.join(', '),
        files_scanned,
        match_count: matches.length,
        truncated,
        matches,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(_deps: ToolDeps): Tool {
  return make_grep_codebase() as Tool;
}
