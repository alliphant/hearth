/**
 * repo_map — a navigable index of the Hearth source tree for Beatrice.
 *
 * The directed-build failure mode this closes: to find an export she
 * half-remembers, the model reads 500-line files in 5 KB windows until the
 * round budget dies (the read_codebase_file spiral class). A map of
 * `file — first-doc-line — exported symbols` lets her jump straight to the
 * right file and read a RANGE, the same way a human uses an IDE's symbol
 * index instead of paging through source.
 *
 * Deterministic, regex-level extraction — this is a MAP, not a type
 * checker; `bunx tsc` remains the authority on what actually exports.
 * Cached per (root, file-count, Σmtime) so repeat calls in a build session
 * are free and a `git pull` invalidates naturally.
 *
 * Lives outside tools/ (no `create` export) — the tool surface is
 * tools/repo_map.ts. Shared with the smoke via direct import.
 */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, read_text_file, walk_files } from './codebase_fs';

export interface FileMapEntry {
  path: string;
  /** First sentence of the file's leading doc comment, if any. */
  doc: string;
  /** Exported symbol names, prefixed by kind (fn/const/class/type/enum). */
  exports: string[];
}

const EXPORT_RE =
  /^export\s+(?:async\s+)?(function|const|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST_RE = /^export\s*\{([^}]+)\}/gm;

const KIND_TAG: Record<string, string> = {
  function: 'fn',
  const: 'const',
  class: 'class',
  interface: 'type',
  type: 'type',
  enum: 'enum',
};

/** First non-empty, non-decoration line of the file's leading comment. */
export function extract_doc_line(source: string): string {
  const m = source.match(/^\s*\/\*\*?([\s\S]{0,500}?)(?:\*\/|$)/);
  if (!m) return '';
  for (const raw of m[1]!.split('\n')) {
    const line = raw.replace(/^\s*\*?\s?/, '').trim();
    if (line.length > 0) return line.length > 110 ? line.slice(0, 107) + '…' : line;
  }
  return '';
}

export function extract_exports(source: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  EXPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPORT_RE.exec(source)) !== null) {
    const name = m[2]!;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(`${KIND_TAG[m[1]!] ?? m[1]!} ${name}`);
  }
  EXPORT_LIST_RE.lastIndex = 0;
  while ((m = EXPORT_LIST_RE.exec(source)) !== null) {
    for (const piece of m[1]!.split(',')) {
      const name = piece.replace(/\btype\b/, '').split(/\s+as\s+/)[0]!.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(`reexport ${name}`);
    }
  }
  return out;
}

interface CacheEntry {
  key: string;
  entries: FileMapEntry[];
}

const _cache = new Map<string, CacheEntry>();

function cache_key(root: string, files: string[]): string {
  let mtime_sum = 0;
  for (const f of files) {
    try {
      mtime_sum += statSync(resolve(REPO_ROOT, f)).mtimeMs;
    } catch {
      /* deleted mid-walk; the count still varies the key */
    }
  }
  return `${root}:${files.length}:${Math.round(mtime_sum)}`;
}

/**
 * Build (or serve cached) map entries for every .ts file under `root`
 * (a repo-relative dir inside the allowlist; '' = all roots is refused
 * upstream by the tool schema to keep output bounded).
 */
export function build_repo_map(root: string): { entries: FileMapEntry[]; truncated: boolean } {
  const { files, truncated } = walk_files(root.replace(/\/$/, ''));
  const ts_files = files.filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort();
  const key = cache_key(root, ts_files);
  const hit = _cache.get(root);
  if (hit && hit.key === key) return { entries: hit.entries, truncated };

  const entries: FileMapEntry[] = [];
  for (const path of ts_files) {
    const src = read_text_file(path);
    if (src === null) continue;
    entries.push({ path, doc: extract_doc_line(src), exports: extract_exports(src) });
  }
  _cache.set(root, { key, entries });
  return { entries, truncated };
}

/** Render entries as the compact model-facing text block. */
export function render_repo_map(entries: FileMapEntry[], char_cap: number): {
  text: string;
  truncated: boolean;
} {
  const lines: string[] = [];
  for (const e of entries) {
    lines.push(`${e.path}${e.doc ? ` — ${e.doc}` : ''}`);
    if (e.exports.length > 0) {
      lines.push(`    ${e.exports.join(', ')}`);
    }
  }
  const text = lines.join('\n');
  if (text.length <= char_cap) return { text, truncated: false };
  return {
    text: text.slice(0, char_cap) + '\n…[map truncated — pass a narrower dir]',
    truncated: true,
  };
}

/**
 * Per-file outline for read_codebase_file's outline mode: exported
 * symbols with their line numbers and the declaration line itself —
 * enough to pick a read range without paging the whole file.
 */
export function outline_file(source: string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  const re = /^export\s+(?:async\s+)?(?:function|const|class|interface|type|enum)\s+[A-Za-z_$]/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (re.test(line)) {
      const decl = line.length > 140 ? line.slice(0, 137) + '…' : line;
      out.push(`${String(i + 1).padStart(4)} | ${decl}`);
    }
  }
  return out.length > 0 ? out.join('\n') : '(no top-level exports found)';
}
