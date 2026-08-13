/**
 * codebase_fs — the single path-safety boundary + bounded filesystem walk
 * shared by Beatrice's read-only codebase tools (read_codebase_file,
 * grep_codebase, list_codebase).
 *
 * Why this lives OUTSIDE `trainer/tools/`: the ToolLoader scans each
 * specialist's `tools/` directory (pattern `[/\\]tools[/\\]`) and treats
 * every module there as a tool. A shared helper must sit one level up so it
 * is never mistaken for a tool module.
 *
 * One allowlist, one denylist, one secret-pattern set — duplicating a
 * security boundary across three tools is exactly how a denylist update lands
 * in two of three and quietly opens a hole. Keep it here.
 *
 * Hot-reload note: per ToolLoader, an edit to a SHARED helper does not
 * propagate to already-loaded importers — changing this file is a
 * restart-class change (the orchestrator must restart to pick it up).
 * Allowlist/denylist edits are deploy-time changes anyway, so that is fine.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, normalize, resolve } from 'node:path';
import { looks_binary } from '@core/binary_text';

// Default to the process cwd (the repo root the app runs from — `/app` in the
// container), matching read_codebase_file and the canonical tool_loader.
export const REPO_ROOT = process.env.HEARTH_REPO_ROOT ?? process.cwd();

/** Roots Beatrice may read. A bare entry (`config`) is treated as `config/`. */
export const PATH_ALLOWLIST = ['src/', 'config/', 'scripts/', 'apps/'];

export const PATH_DENYLIST = [
  '.git/',
  '.env',
  'node_modules/',
  'data/',
  'bun.lock',
  'package-lock.json',
];

export const SECRET_FILE_PATTERNS = [/\.key$/, /\.pem$/, /\.secret$/, /secrets?\./];

/** Directory names pruned during a walk regardless of where they appear. */
const PRUNE_DIRS = new Set(['.git', 'node_modules', 'data']);

/**
 * Extensions we never read as text. grep on a PNG is noise at best and a
 * giant allocation at worst; list still shows them, it just won't open them.
 */
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg', 'pdf',
  'zip', 'gz', 'tgz', 'tar', 'br',
  'mp3', 'mp4', 'mov', 'wav', 'm4a', 'aac',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'bin', 'wasm', 'db', 'sqlite', 'sqlite3', 'lock',
]);

/** Per-file cap for content reads — skip pathological files. */
export const MAX_GREP_FILE_BYTES = 512 * 1024;

/** Hard ceiling on files visited per walk so a bad subtree can't hang a turn. */
export const MAX_WALK_FILES = 6000;

/**
 * Validate path shape (relative, no traversal, not denylisted, not a secret).
 * Returns the normalized relative path. Throws with `tool_name`-prefixed
 * messages so the error reads naturally in the calling tool's audit row.
 */
export function assert_safe_path(rel_path: string, tool_name: string): string {
  if (isAbsolute(rel_path)) {
    throw new Error(`${tool_name}: path must be relative (got "${rel_path}")`);
  }
  const normalized = normalize(rel_path);
  if (normalized.startsWith('..') || normalized.includes('/../')) {
    throw new Error(`${tool_name}: path traversal forbidden (got "${rel_path}")`);
  }
  for (const deny of PATH_DENYLIST) {
    const bare = deny.replace(/\/$/, '');
    if (normalized === bare || normalized.startsWith(deny)) {
      throw new Error(`${tool_name}: path "${rel_path}" is on the denylist (${deny})`);
    }
  }
  for (const re of SECRET_FILE_PATTERNS) {
    if (re.test(normalized)) {
      throw new Error(`${tool_name}: path "${rel_path}" looks like a secret/key file — refusing`);
    }
  }
  return normalized;
}

/** True if `normalized` is at or under one of the allowlist roots. */
export function within_allowlist(normalized: string): boolean {
  return PATH_ALLOWLIST.some((p) => {
    const bare = p.replace(/\/$/, '');
    return normalized === bare || normalized.startsWith(p);
  });
}

/** assert_safe_path + allowlist gate, for tools that must stay inside the roots. */
export function assert_allowed_path(rel_path: string, tool_name: string): string {
  const normalized = assert_safe_path(rel_path, tool_name);
  if (!within_allowlist(normalized)) {
    throw new Error(
      `${tool_name}: path "${rel_path}" must start with one of: ${PATH_ALLOWLIST.join(', ')}`,
    );
  }
  return normalized;
}

/** Is this filename one we will open and scan as text? */
export function is_text_file(name: string): boolean {
  const ext = extname(name).slice(1).toLowerCase();
  return ext === '' || !BINARY_EXT.has(ext);
}

/** The allowlist roots that actually exist on disk, as relative dir names. */
export function existing_roots(): string[] {
  return PATH_ALLOWLIST.map((p) => p.replace(/\/$/, '')).filter((d) =>
    existsSync(resolve(REPO_ROOT, d)),
  );
}

export interface DirEntry {
  name: string;
  rel_path: string;
  type: 'file' | 'dir';
  size_bytes: number;
}

/** One-level directory listing, denylisted/secret children omitted. */
export function list_dir(normalized_rel_dir: string): DirEntry[] {
  const abs = resolve(REPO_ROOT, normalized_rel_dir);
  const out: DirEntry[] = [];
  for (const name of readdirSync(abs)) {
    const child_rel = normalized_rel_dir === '' ? name : `${normalized_rel_dir}/${name}`;
    // Reuse the same safety gate; silently skip anything it would reject.
    try {
      assert_safe_path(child_rel, 'list_codebase');
    } catch {
      continue;
    }
    if (PRUNE_DIRS.has(name)) continue;
    let st;
    try {
      st = statSync(join(abs, name));
    } catch {
      continue;
    }
    out.push({
      name,
      rel_path: child_rel,
      type: st.isDirectory() ? 'dir' : 'file',
      size_bytes: st.isFile() ? st.size : 0,
    });
  }
  // Dirs first, then files, each alphabetical — the shape a human scans fastest.
  out.sort((a, b) =>
    a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name),
  );
  return out;
}

/**
 * Depth-first walk yielding relative file paths under `normalized_rel_dir`,
 * pruning denylisted dirs and capping at MAX_WALK_FILES. `truncated` is true
 * if the cap was hit (more files exist than were visited).
 */
export function walk_files(normalized_rel_dir: string): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const stack: string[] = [normalized_rel_dir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let names: string[];
    try {
      names = readdirSync(resolve(REPO_ROOT, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (PRUNE_DIRS.has(name)) continue;
      const child_rel = dir === '' ? name : `${dir}/${name}`;
      try {
        assert_safe_path(child_rel, 'grep_codebase');
      } catch {
        continue;
      }
      let st;
      try {
        st = statSync(resolve(REPO_ROOT, child_rel));
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(child_rel);
      } else if (st.isFile()) {
        if (files.length >= MAX_WALK_FILES) {
          truncated = true;
          return { files, truncated };
        }
        files.push(child_rel);
      }
    }
  }
  return { files, truncated };
}

/** Read a file as text, or null if it's binary / too big / unreadable. */
export function read_text_file(normalized_rel: string): string | null {
  if (!is_text_file(basename(normalized_rel))) return null;
  let st;
  try {
    st = statSync(resolve(REPO_ROOT, normalized_rel));
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_GREP_FILE_BYTES) return null;
  let text: string;
  try {
    text = readFileSync(resolve(REPO_ROOT, normalized_rel), 'utf-8');
  } catch {
    return null;
  }
  // Content backstop. `is_text_file` above is a DENYLIST — an extension it has
  // never heard of passes, and an extensionless file always passes — so it let
  // nine ~118 KB `.vrma` avatar-animation files under `src/app/client/face/`
  // through as readable "text". A model handed that mojibake does not report
  // failure, it invents contents (see core/binary_text.ts). Cheap: 2 KB sample.
  if (looks_binary(text)) return null;
  return text;
}
