/**
 * read_codebase_file — read a file from the Hearth repo so Beatrice
 * can see existing code before proposing changes. Read-only counterpart
 * to propose_code_change / the workbench.
 *
 * Same path safety as the write tools: allowlist src/, config/, scripts/,
 * apps/; denylist .git/, .env, node_modules, data/, *.key/*.pem; no
 * traversal.
 *
 * Three reading shapes, in escalating cost:
 *   - `mode: 'outline'` — exported symbols with line numbers (pick a range)
 *   - `start_line`/`end_line` — a bounded, line-numbered range
 *   - full read (capped) — only for genuinely small files
 *
 * Recovery hints (the connector affordance pattern, applied to her own
 * tooling): a path that doesn't exist returns `candidates` (nearest
 * basename matches inside the allowlist), and a path that is a DIRECTORY
 * returns its children as candidates — both were live spiral starters
 * ("src/connectors" is not a regular file ×2, 2026-06).
 */
import { z } from 'zod';
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  REPO_ROOT,
  assert_allowed_path,
  existing_roots,
  list_dir,
  read_text_file,
  walk_files,
} from '../codebase_fs';
import { outline_file } from '../repo_map';

const MAX_RETURNED_CHARS = 48_000;
const RANGE_LINE_CAP = 400;
const CANDIDATE_CAP = 8;

const InputSchema = z.object({
  path: z.string().min(1).max(500),
  /** 'outline' returns exported symbols + line numbers only — the cheap
   *  first look at any non-trivial file. Default 'full'. */
  mode: z.enum(['full', 'outline']).optional(),
  /** Optional 1-based line range for a bounded read. */
  start_line: z.coerce.number().int().positive().optional(),
  end_line: z.coerce.number().int().positive().optional(),
});

const OutputSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  total_lines: z.number(),
  truncated: z.boolean(),
  contents: z.string(),
  /** Populated on the error path: nearest paths worth retrying. */
  candidates: z.array(z.string()).optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/** Character-bigram set of a lowercased string. */
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  const t = s.toLowerCase();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/**
 * Nearest allowlist files by Dice similarity of basename bigrams — robust
 * to the typo shapes models actually produce (transpositions like
 * "tiem.ts", dropped underscores), where token matching isn't.
 */
function path_candidates(missing: string): string[] {
  const want = bigrams(basename(missing));
  if (want.size === 0) return [];
  const scored: Array<{ path: string; score: number }> = [];
  for (const root of existing_roots()) {
    for (const f of walk_files(root).files) {
      const got = bigrams(basename(f));
      let overlap = 0;
      for (const b of want) if (got.has(b)) overlap++;
      const score = (2 * overlap) / (want.size + got.size);
      if (score >= 0.35) scored.push({ path: f, score });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATE_CAP)
    .map((s) => s.path);
}

export function make_read_codebase_file(): Tool<Input, Output> {
  return {
    name: 'read_codebase_file',
    description:
      'Read a file from the Hearth source tree. CHEAPEST FIRST: mode:"outline" lists ' +
      'exported symbols with line numbers; then read just the start_line/end_line range ' +
      'around what you need. Full reads are for small files only. A missing path returns ' +
      '`candidates` (likely intended files) — retry one of those, never re-read the same ' +
      'failing path. Allowlist: src/, config/, scripts/, apps/.',
    risk: 'write_internal',
    required_capabilities: ['read_codebase'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `read_codebase_file:${input.path}:${input.mode ?? 'full'}:${input.start_line ?? 0}-${input.end_line ?? 'end'}`;
    },

    async execute(input, _ctx: ToolContext): Promise<Output> {
      assert_allowed_path(input.path, 'read_codebase_file');
      const abs = resolve(REPO_ROOT, input.path);
      if (!existsSync(abs)) {
        const cands = path_candidates(input.path);
        return {
          path: input.path,
          exists: false,
          total_lines: 0,
          truncated: false,
          contents:
            `"${input.path}" does not exist. Retry with one of the candidates above, or admit the read failed — do not assert contents of a path you haven't read.` +
            (cands.length > 0
              ? ` Closest matches: ${cands.join(', ')}.`
              : ' No close matches found.'),
          candidates: cands,
        };
      }
      const stat = statSync(abs);
      if (!stat.isFile()) {
        // A directory is a navigation mistake, not a dead end — hand back
        // its children so the next call lands on a real file.
        const children = list_dir(input.path.replace(/\/$/, ''))
          .slice(0, 40)
          .map((e) => e.rel_path + (e.type === 'dir' ? '/' : ''));
        return {
          path: input.path,
          exists: true,
          total_lines: 0,
          truncated: false,
          contents:
            `"${input.path}" is a directory, not a file. Retry with one of the entries above, or admit the read failed — do not assert contents of a path you haven't read.` +
            (children.length > 0
              ? ` Entries: ${children.join(', ')}.`
              : ' No entries found.'),
          candidates: children,
        };
      }

      const source = read_text_file(input.path);
      if (source === null) {
        throw new Error(
          `read_codebase_file: "${input.path}" is binary or too large to read as text.`,
        );
      }
      const lines = source.split('\n');

      if (input.mode === 'outline') {
        return {
          path: input.path,
          exists: true,
          total_lines: lines.length,
          truncated: false,
          contents:
            `Outline of ${input.path} (${lines.length} lines). Read a range with ` +
            `start_line/end_line around the symbol you need:\n` +
            outline_file(source),
        };
      }

      const from = Math.max(1, input.start_line ?? 1);
      const to = Math.min(
        lines.length,
        input.end_line ?? (input.start_line ? from + RANGE_LINE_CAP - 1 : lines.length),
      );
      let body = lines
        .slice(from - 1, to)
        .map((l, i) => `${String(from + i).padStart(4)} | ${l}`)
        .join('\n');
      let truncated = from > 1 || to < lines.length;
      if (body.length > MAX_RETURNED_CHARS) {
        body =
          body.slice(0, MAX_RETURNED_CHARS) +
          `\n…[char cap. This file is large — use mode:"outline" to find the right range]`;
        truncated = true;
      }
      return {
        path: input.path,
        exists: true,
        total_lines: lines.length,
        truncated,
        contents: body,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(_deps: ToolDeps): Tool {
  return make_read_codebase_file() as Tool;
}
