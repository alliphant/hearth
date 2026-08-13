/**
 * list_codebase — enumerate a directory in the Hearth source tree.
 *
 * read_codebase_file opens a FILE; pointed at a directory it throws ("is not
 * a regular file"). Beatrice hit that wall three times in one chat turn
 * (read src/, src/tools/, src/connectors/ → ERR) while fishing for a file
 * whose exact name she didn't know. This is the missing "what's in here?"
 * primitive: one call lists a directory so she can pick the real path instead
 * of permuting guesses.
 *
 * Pass no path (or "") to see the top-level roots she can explore. Read-only,
 * owner-tier, same allowlist/denylist as the other codebase tools.
 */
import { z } from 'zod';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  assert_allowed_path,
  existing_roots,
  list_dir,
  REPO_ROOT,
  walk_files,
  type DirEntry,
} from '../codebase_fs';

const InputSchema = z.object({
  // Directory to list, e.g. "src/connectors". Omit / "" lists the roots.
  path: z.string().max(500).default(''),
});

const EntrySchema = z.object({
  name: z.string(),
  rel_path: z.string(),
  type: z.enum(['file', 'dir']),
  size_bytes: z.number(),
});

const CANDIDATE_CAP = 8;

/** Character-bigram set of a lowercased string. */
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  const t = s.toLowerCase();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/**
 * Nearest allowlist directories by Dice similarity of path-component bigrams.
 * Mirrors path_candidates in read_codebase_file.ts but operates on directory
 * paths rather than file basenames — the shape Beatrice needs when she passes
 * a vault path (e.g. "Knowledge/Trainer/binding-proposals") to a codebase tool.
 */
function dir_candidates(missing: string): string[] {
  const want = bigrams(missing);
  if (want.size === 0) return [];
  const scored: Array<{ path: string; score: number }> = [];
  for (const root of existing_roots()) {
    for (const d of walk_files(root).files) {
      // Score on the full path AND on each directory component.
      const got = bigrams(d);
      let overlap = 0;
      for (const b of want) if (got.has(b)) overlap++;
      const score = (2 * overlap) / (want.size + got.size);
      if (score >= 0.35) scored.push({ path: d, score });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATE_CAP)
    .map((s) => s.path);
}

const OutputSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  entry_count: z.number(),
  entries: z.array(EntrySchema),
  /** Populated on the error path: nearest directories worth retrying. */
  candidates: z.array(z.string()).optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_list_codebase(): Tool<Input, Output> {
  return {
    name: 'list_codebase',
    description:
      'List the contents of a directory in the Hearth source tree (dirs first, then files with sizes). Use to discover the real filename before read_codebase_file — read_codebase_file errors on a directory, this is the "what files are in here?" tool. Pass no path to see the top-level roots (src/, config/, scripts/, apps/). Read-only; secrets, .git, node_modules, and data/ are hidden.',
    risk: 'read',
    required_capabilities: ['read_codebase'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `list_codebase:${input.path || '<roots>'}`;
    },

    async execute(input, _ctx: ToolContext): Promise<Output> {
      const trimmed = input.path.trim();
      // Root view: the existing allowlist roots, as dir entries.
      if (trimmed === '' || trimmed === '.' || trimmed === '/') {
        const entries: DirEntry[] = existing_roots().map((d) => ({
          name: d,
          rel_path: d,
          type: 'dir',
          size_bytes: 0,
        }));
        return { path: '', exists: true, entry_count: entries.length, entries };
      }

      const normalized = assert_allowed_path(trimmed, 'list_codebase');
      const abs = resolve(REPO_ROOT, normalized);
      if (!existsSync(abs)) {
        const candidates = dir_candidates(normalized);
        return {
          path: normalized,
          exists: false,
          entry_count: 0,
          entries: [],
          candidates,
        };
      }
      if (!statSync(abs).isDirectory()) {
        throw new Error(
          `list_codebase: "${normalized}" is a file, not a directory — use read_codebase_file to open it.`,
        );
      }
      const entries = list_dir(normalized);
      return { path: normalized, exists: true, entry_count: entries.length, entries };
    },
  };
}

/** ToolLoader entry point. */
export function create(_deps: ToolDeps): Tool {
  return make_list_codebase() as Tool;
}
