/**
 * LibraryStore — the file manager's storage engine.
 *
 * The library is a categorized tree of binary files at ~/hearth-library/
 * (env HEARTH_LIBRARY_ROOT), deliberately OUTSIDE the markdown vault —
 * binaries don't belong in a vault meant to stay human-readable and
 * git-diffable for years. Cordelia downloads files here on Jasper's
 * behalf; he browses them through the Finder-grade UI at /files.
 *
 * Two sources of truth, by design:
 *   - The filesystem is authoritative for what files EXIST. Jasper can
 *     drop a file into ~/hearth-library/Documents/ by hand and it shows
 *     up — no index write required.
 *   - The `library_files` SQLite table is the metadata INDEX: the source
 *     URL, description, tags, and who fetched a file — things a
 *     directory entry can't carry. It also assigns each file a stable
 *     `lib_` id the API and UI address it by.
 *
 * `list()` reconciles the two every call: any on-disk file missing an
 * index row gets a minimal one; any row whose file has vanished is
 * dropped. So the index can never drift far, and the UI never shows a
 * ghost or hides a real file.
 */
import { Database } from 'bun:sqlite';
import {
  mkdirSync,
  readdirSync,
  statSync,
  existsSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join, dirname, basename, extname, sep } from 'node:path';
import { ulid } from 'ulid';

/**
 * The fixed top-level category buckets. Cordelia (and Jasper) create
 * subfolders freely WITHIN a category — `Reference/Ioniq-5/`,
 * `Software/ROCm/` — but the seven roots themselves are structural and
 * cannot be renamed, moved, or deleted.
 */
export const LIBRARY_CATEGORIES = [
  'Documents',
  'Media',
  'Software',
  'Archives',
  'Reference',
  'Datasets',
  'Other',
] as const;

export type LibraryCategory = (typeof LIBRARY_CATEGORIES)[number];

const CATEGORY_SET: ReadonlySet<string> = new Set(LIBRARY_CATEGORIES);

/** A row of the `library_files` index, plus the parsed tag array. */
export interface LibraryFile {
  id: string;
  filename: string;
  rel_path: string;
  category: string;
  source_url: string | null;
  description: string | null;
  tags: string[];
  size: number;
  mime: string | null;
  downloaded_at: string;
  downloaded_by: string;
  /** Coarse file class for UI icon selection — derived, not stored. */
  kind: FileKind;
}

/** A folder entry in a directory listing. */
export interface LibraryFolder {
  name: string;
  rel_path: string;
  category: string;
  child_count: number;
}

/** A node in the sidebar folder tree. */
export interface LibraryTreeNode {
  name: string;
  rel_path: string;
  category: string;
  children: LibraryTreeNode[];
}

export interface LibraryListing {
  rel_path: string;
  folders: LibraryFolder[];
  files: LibraryFile[];
}

export type FileKind =
  | 'document'
  | 'image'
  | 'video'
  | 'audio'
  | 'archive'
  | 'code'
  | 'data'
  | 'other';

export interface WriteFileInput {
  /** Relative directory; first segment must be a valid category. */
  dir: string;
  filename: string;
  bytes: Uint8Array;
  source_url?: string | null;
  description?: string | null;
  tags?: string[];
  mime?: string | null;
  downloaded_by: string;
}

interface LibraryRow {
  id: string;
  filename: string;
  rel_path: string;
  category: string;
  source_url: string | null;
  description: string | null;
  tags_json: string;
  size: number;
  mime: string | null;
  downloaded_at: string;
  downloaded_by: string;
}

// ── file-kind / mime helpers ────────────────────────────────────────────

const KIND_BY_EXT: Record<string, FileKind> = {
  // documents
  pdf: 'document', doc: 'document', docx: 'document', odt: 'document',
  rtf: 'document', txt: 'document', md: 'document', epub: 'document',
  pages: 'document', xls: 'document', xlsx: 'document', ppt: 'document',
  pptx: 'document', key: 'document', numbers: 'document',
  // images
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  svg: 'image', bmp: 'image', tiff: 'image', heic: 'image', avif: 'image',
  ico: 'image',
  // video
  mp4: 'video', mkv: 'video', mov: 'video', avi: 'video', webm: 'video',
  m4v: 'video', wmv: 'video',
  // audio
  mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', ogg: 'audio',
  m4a: 'audio', opus: 'audio',
  // archives
  zip: 'archive', tar: 'archive', gz: 'archive', tgz: 'archive',
  bz2: 'archive', xz: 'archive', '7z': 'archive', rar: 'archive',
  zst: 'archive',
  // code
  js: 'code', ts: 'code', py: 'code', sh: 'code', c: 'code', h: 'code',
  cpp: 'code', rs: 'code', go: 'code', java: 'code', rb: 'code',
  html: 'code', css: 'code', yaml: 'code', yml: 'code', toml: 'code',
  // data
  json: 'data', csv: 'data', tsv: 'data', parquet: 'data', db: 'data',
  sqlite: 'data', xml: 'data', jsonl: 'data', ndjson: 'data',
};

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
  csv: 'text/csv', json: 'application/json', html: 'text/html',
  xml: 'application/xml', zip: 'application/zip',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
  wav: 'audio/wav', flac: 'audio/flac',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function ext_of(filename: string): string {
  return extname(filename).slice(1).toLowerCase();
}

export function kind_of(filename: string): FileKind {
  return KIND_BY_EXT[ext_of(filename)] ?? 'other';
}

export function mime_of(filename: string): string {
  return MIME_BY_EXT[ext_of(filename)] ?? 'application/octet-stream';
}

/**
 * Strip a user/LLM-supplied filename down to a safe basename: no path
 * separators, no traversal, no control characters. An empty result
 * falls back to a generic name.
 */
export function sanitize_filename(name: string): string {
  // basename() drops any directory part. Then drop control characters
  // (code points below 0x20), map stray separators to underscore, and
  // strip leading dots. Spaces, hyphens, parentheses and other printable
  // characters are legal and preserved — this is a file manager.
  const printable = Array.from(basename(String(name ?? '')))
    .filter((ch) => ch.charCodeAt(0) >= 0x20)
    .join('');
  const safe = printable.split('/').join('_').split('\\').join('_').replace(/^\.+/, '').trim();
  return safe.length > 0 ? safe.slice(0, 200) : 'file';
}

// ── LibraryStore ────────────────────────────────────────────────────────

export interface LibraryStoreConfig {
  root: string;
  db: Database;
}

export class LibraryStore {
  readonly root: string;
  private readonly db: Database;

  constructor(cfg: LibraryStoreConfig) {
    this.root = resolve(cfg.root);
    this.db = cfg.db;
    this.ensure_layout();
  }

  /** Create the library root and the seven fixed category directories. */
  ensure_layout(): void {
    mkdirSync(this.root, { recursive: true });
    for (const cat of LIBRARY_CATEGORIES) {
      mkdirSync(join(this.root, cat), { recursive: true });
    }
  }

  is_category(token: string): token is LibraryCategory {
    return CATEGORY_SET.has(token);
  }

  // ── path safety ───────────────────────────────────────────────────────

  /**
   * Resolve a library-relative path to an absolute one, refusing
   * anything that would escape the root. `resolve` collapses `..`
   * segments first, so a crafted `Documents/../../etc/passwd` lands
   * outside the root and is rejected here.
   */
  private safe_abs(rel_path: string): string {
    const cleaned = String(rel_path ?? '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    if (cleaned.includes('\0')) {
      throw new Error('invalid path: contains null byte');
    }
    const abs = resolve(this.root, cleaned);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new Error(`path escapes the library root: ${rel_path}`);
    }
    return abs;
  }

  /** Library-relative POSIX path for an absolute path under the root. */
  private rel_of(abs: string): string {
    if (abs === this.root) return '';
    return abs.slice(this.root.length + 1).split(sep).join('/');
  }

  /** First path segment — the category. */
  private category_of(rel_path: string): string {
    return rel_path.split('/')[0] ?? '';
  }

  // ── index row ↔ LibraryFile ──────────────────────────────────────────

  private to_file(row: LibraryRow): LibraryFile {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(row.tags_json) as unknown;
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
    } catch {
      /* malformed tag JSON — treat as none */
    }
    return {
      id: row.id,
      filename: row.filename,
      rel_path: row.rel_path,
      category: row.category,
      source_url: row.source_url,
      description: row.description,
      tags,
      size: row.size,
      mime: row.mime,
      downloaded_at: row.downloaded_at,
      downloaded_by: row.downloaded_by,
      kind: kind_of(row.filename),
    };
  }

  // ── reconciliation ───────────────────────────────────────────────────

  /**
   * Make the index agree with the filesystem for ONE directory's direct
   * file children: insert a minimal row for any file lacking one, refresh
   * a stale size, and drop rows whose file has vanished. Folders are not
   * indexed — only files.
   */
  private reconcile_dir(rel_dir: string): void {
    const abs = this.safe_abs(rel_dir);
    let names: string[] = [];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }

    const on_disk = new Set<string>();
    for (const name of names) {
      const child_abs = join(abs, name);
      let st;
      try {
        st = statSync(child_abs);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const rel = this.rel_of(child_abs);
      on_disk.add(rel);

      const existing = this.db
        .query('SELECT id, size FROM library_files WHERE rel_path = @rel')
        .get({ '@rel': rel }) as { id: string; size: number } | undefined;

      if (!existing) {
        this.db
          .query(
            `INSERT INTO library_files
               (id, filename, rel_path, category, source_url, description,
                tags_json, size, mime, downloaded_at, downloaded_by)
             VALUES
               (@id, @filename, @rel, @category, NULL, NULL,
                '[]', @size, @mime, @downloaded_at, 'filesystem')`,
          )
          .run({
            '@id': `lib_${ulid().toLowerCase().slice(-10)}`,
            '@filename': name,
            '@rel': rel,
            '@category': this.category_of(rel),
            '@size': st.size,
            '@mime': mime_of(name),
            '@downloaded_at': st.mtime.toISOString(),
          });
      } else if (existing.size !== st.size) {
        this.db
          .query('UPDATE library_files SET size = @size WHERE id = @id')
          .run({ '@size': st.size, '@id': existing.id });
      }
    }

    // Drop index rows for files in this directory that no longer exist.
    const indexed = this.db
      .query('SELECT id, rel_path FROM library_files')
      .all() as Array<{ id: string; rel_path: string }>;
    const prefix = rel_dir ? `${rel_dir}/` : '';
    for (const row of indexed) {
      if (!row.rel_path.startsWith(prefix)) continue;
      // direct children of rel_dir only
      const remainder = row.rel_path.slice(prefix.length);
      if (remainder.includes('/')) continue;
      if (!on_disk.has(row.rel_path)) {
        this.db.query('DELETE FROM library_files WHERE id = @id').run({ '@id': row.id });
      }
    }
  }

  // ── reads ─────────────────────────────────────────────────────────────

  /** The sidebar folder tree: seven categories, each with its subfolders. */
  tree(): LibraryTreeNode[] {
    const walk = (rel_dir: string, category: string): LibraryTreeNode[] => {
      const abs = this.safe_abs(rel_dir);
      let names: string[] = [];
      try {
        names = readdirSync(abs);
      } catch {
        return [];
      }
      const nodes: LibraryTreeNode[] = [];
      for (const name of names.sort((a, b) => a.localeCompare(b))) {
        const child_abs = join(abs, name);
        let st;
        try {
          st = statSync(child_abs);
        } catch {
          continue;
        }
        if (!st.isDirectory()) continue;
        const rel = this.rel_of(child_abs);
        nodes.push({
          name,
          rel_path: rel,
          category,
          children: walk(rel, category),
        });
      }
      return nodes;
    };
    return LIBRARY_CATEGORIES.map((cat) => ({
      name: cat,
      rel_path: cat,
      category: cat,
      children: walk(cat, cat),
    }));
  }

  /** List one directory: its folders and its files (index-reconciled). */
  list(rel_dir: string): LibraryListing {
    const norm = String(rel_dir ?? '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    const abs = this.safe_abs(norm);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new Error(`not a directory: ${norm || '/'}`);
    }
    this.reconcile_dir(norm);

    const folders: LibraryFolder[] = [];
    for (const name of readdirSync(abs)) {
      const child_abs = join(abs, name);
      let st;
      try {
        st = statSync(child_abs);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const rel = this.rel_of(child_abs);
      let child_count = 0;
      try {
        child_count = readdirSync(child_abs).length;
      } catch {
        /* unreadable — report 0 */
      }
      folders.push({
        name,
        rel_path: rel,
        category: this.category_of(rel),
        child_count,
      });
    }
    folders.sort((a, b) => a.name.localeCompare(b.name));

    const prefix = norm ? `${norm}/` : '';
    const rows = this.db
      .query('SELECT * FROM library_files ORDER BY filename')
      .all() as LibraryRow[];
    const files = rows
      .filter((r) => {
        if (!r.rel_path.startsWith(prefix)) return false;
        return !r.rel_path.slice(prefix.length).includes('/');
      })
      .map((r) => this.to_file(r));

    return { rel_path: norm, folders, files };
  }

  /** Filename / tag / description / source-URL substring search. */
  search(query: string): LibraryFile[] {
    const q = query.trim();
    if (!q) return [];
    const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const rows = this.db
      .query(
        `SELECT * FROM library_files
         WHERE filename LIKE @like ESCAPE '\\'
            OR tags_json LIKE @like ESCAPE '\\'
            OR description LIKE @like ESCAPE '\\'
            OR source_url LIKE @like ESCAPE '\\'
         ORDER BY downloaded_at DESC
         LIMIT 200`,
      )
      .all({ '@like': like }) as LibraryRow[];
    // reconcile: drop any hit whose file has since vanished
    return rows
      .filter((r) => {
        try {
          return existsSync(this.safe_abs(r.rel_path));
        } catch {
          return false;
        }
      })
      .map((r) => this.to_file(r));
  }

  /**
   * The most recently added files across every category — the Recents
   * view. Ordered by `downloaded_at` descending; index rows whose file
   * has since vanished are filtered out, same as search().
   */
  recents(limit = 50): LibraryFile[] {
    const n = Math.max(1, Math.min(500, Math.floor(limit) || 50));
    const rows = this.db
      .query(
        `SELECT * FROM library_files ORDER BY downloaded_at DESC LIMIT ${n}`,
      )
      .all() as LibraryRow[];
    return rows
      .filter((r) => {
        try {
          return existsSync(this.safe_abs(r.rel_path));
        } catch {
          return false;
        }
      })
      .map((r) => this.to_file(r));
  }

  get_by_id(id: string): LibraryFile | undefined {
    const row = this.db
      .query('SELECT * FROM library_files WHERE id = @id')
      .get({ '@id': id }) as LibraryRow | undefined;
    if (!row) return undefined;
    if (!existsSync(this.safe_abs(row.rel_path))) {
      // the file is gone — clean the stale row and report not found
      this.db.query('DELETE FROM library_files WHERE id = @id').run({ '@id': id });
      return undefined;
    }
    return this.to_file(row);
  }

  /** Absolute path for a file (download serving). */
  abs_path(rel_path: string): string {
    return this.safe_abs(rel_path);
  }

  // ── writes ────────────────────────────────────────────────────────────

  /**
   * Write a file into a category directory (creating sub-directories as
   * needed) and register/refresh its index row. The destination
   * directory's first segment must be a valid category. Returns the
   * indexed file. A name collision is resolved by suffixing ` (2)`,
   * ` (3)`, … so a download never silently overwrites.
   */
  write_file(input: WriteFileInput): LibraryFile {
    const dir = String(input.dir ?? '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    const category = this.category_of(dir);
    if (!this.is_category(category)) {
      throw new Error(
        `invalid library category "${category}" — must be one of: ` +
          LIBRARY_CATEGORIES.join(', '),
      );
    }
    const dir_abs = this.safe_abs(dir);
    mkdirSync(dir_abs, { recursive: true });

    const safe_name = sanitize_filename(input.filename);
    const final_name = this.dedupe_name(dir_abs, safe_name);
    const file_abs = join(dir_abs, final_name);
    writeFileSync(file_abs, input.bytes);

    const rel = this.rel_of(file_abs);
    const id = `lib_${ulid().toLowerCase().slice(-10)}`;
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO library_files
           (id, filename, rel_path, category, source_url, description,
            tags_json, size, mime, downloaded_at, downloaded_by)
         VALUES
           (@id, @filename, @rel, @category, @source_url, @description,
            @tags_json, @size, @mime, @downloaded_at, @downloaded_by)`,
      )
      .run({
        '@id': id,
        '@filename': final_name,
        '@rel': rel,
        '@category': category,
        '@source_url': input.source_url ?? null,
        '@description': input.description ?? null,
        '@tags_json': JSON.stringify(input.tags ?? []),
        '@size': input.bytes.byteLength,
        '@mime': input.mime ?? mime_of(final_name),
        '@downloaded_at': now,
        '@downloaded_by': input.downloaded_by,
      });

    return this.get_by_id(id)!;
  }

  /** Suffix ` (n)` until the name is free in `dir_abs`. */
  private dedupe_name(dir_abs: string, name: string): string {
    if (!existsSync(join(dir_abs, name))) return name;
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 2; n < 1000; n++) {
      const candidate = `${stem} (${n})${ext}`;
      if (!existsSync(join(dir_abs, candidate))) return candidate;
    }
    throw new Error(`cannot find a free filename for ${name}`);
  }

  /** Create a folder. The first path segment must be a valid category. */
  mkdir(rel_dir: string): { rel_path: string } {
    const dir = String(rel_dir ?? '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    if (!dir) throw new Error('mkdir: empty path');
    const category = this.category_of(dir);
    if (!this.is_category(category)) {
      throw new Error(`invalid library category "${category}"`);
    }
    if (dir === category) {
      throw new Error(`"${category}" already exists — it is a fixed category`);
    }
    const abs = this.safe_abs(dir);
    if (existsSync(abs)) throw new Error(`already exists: ${dir}`);
    mkdirSync(abs, { recursive: true });
    return { rel_path: dir };
  }

  /** Move a file or folder into a target directory. Updates the index. */
  move(from_rel: string, to_dir_rel: string): { rel_path: string } {
    const from = this.normalize(from_rel);
    const to_dir = this.normalize(to_dir_rel);
    if (!from) throw new Error('move: empty source');
    this.assert_not_category_root(from, 'move');

    const from_abs = this.safe_abs(from);
    if (!existsSync(from_abs)) throw new Error(`not found: ${from}`);

    // The destination directory must be the library root… no — root has
    // no files; it must be a category or a subfolder under one.
    const to_category = this.category_of(to_dir);
    if (!this.is_category(to_category)) {
      throw new Error(`invalid destination category "${to_category}"`);
    }
    const to_dir_abs = this.safe_abs(to_dir);
    if (!existsSync(to_dir_abs) || !statSync(to_dir_abs).isDirectory()) {
      throw new Error(`destination is not a directory: ${to_dir}`);
    }
    const name = basename(from);
    const dest = join(to_dir_abs, name);
    const dest_rel = this.rel_of(dest);
    if (dest_rel === from) return { rel_path: from }; // no-op
    if (dest_rel.startsWith(`${from}/`)) {
      throw new Error('cannot move a folder into itself');
    }
    if (existsSync(dest)) throw new Error(`destination already exists: ${dest_rel}`);

    renameSync(from_abs, dest);
    this.reindex_paths(from, dest_rel, statSync(dest).isDirectory());
    return { rel_path: dest_rel };
  }

  /** Rename a file or folder in place. Updates the index. */
  rename(rel_path: string, new_name: string): { rel_path: string } {
    const from = this.normalize(rel_path);
    if (!from) throw new Error('rename: empty path');
    this.assert_not_category_root(from, 'rename');
    const safe_new = sanitize_filename(new_name);
    if (!safe_new) throw new Error('rename: empty new name');

    const from_abs = this.safe_abs(from);
    if (!existsSync(from_abs)) throw new Error(`not found: ${from}`);
    const parent = dirname(from);
    const dest_rel = parent ? `${parent}/${safe_new}` : safe_new;
    const dest_abs = this.safe_abs(dest_rel);
    if (existsSync(dest_abs)) throw new Error(`already exists: ${dest_rel}`);

    renameSync(from_abs, dest_abs);
    const is_dir = statSync(dest_abs).isDirectory();
    this.reindex_paths(from, dest_rel, is_dir);
    if (!is_dir) {
      this.db
        .query('UPDATE library_files SET filename = @n WHERE rel_path = @rel')
        .run({ '@n': safe_new, '@rel': dest_rel });
    }
    return { rel_path: dest_rel };
  }

  /** Delete a file or folder (recursively). Removes index rows. */
  remove(rel_path: string): void {
    const target = this.normalize(rel_path);
    if (!target) throw new Error('delete: empty path');
    this.assert_not_category_root(target, 'delete');
    const abs = this.safe_abs(target);
    if (!existsSync(abs)) throw new Error(`not found: ${target}`);
    rmSync(abs, { recursive: true, force: true });
    this.db
      .query('DELETE FROM library_files WHERE rel_path = @p OR rel_path LIKE @pre ESCAPE \'\\\'')
      .run({ '@p': target, '@pre': `${target.replace(/[%_]/g, (m) => `\\${m}`)}/%` });
  }

  // ── internal helpers ─────────────────────────────────────────────────

  private normalize(p: string): string {
    return String(p ?? '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
  }

  private assert_not_category_root(rel_path: string, op: string): void {
    if (this.is_category(rel_path)) {
      throw new Error(`cannot ${op} "${rel_path}" — it is a fixed category root`);
    }
  }

  /**
   * After a file or folder moved from `old_rel` to `new_rel`, rewrite
   * every affected index row's rel_path + category. A file touches one
   * row; a folder touches every row beneath it.
   */
  private reindex_paths(old_rel: string, new_rel: string, is_dir: boolean): void {
    if (!is_dir) {
      this.db
        .query(
          'UPDATE library_files SET rel_path = @new, category = @cat WHERE rel_path = @old',
        )
        .run({
          '@new': new_rel,
          '@cat': this.category_of(new_rel),
          '@old': old_rel,
        });
      return;
    }
    const old_prefix = `${old_rel}/`;
    const rows = this.db
      .query('SELECT id, rel_path FROM library_files')
      .all() as Array<{ id: string; rel_path: string }>;
    for (const row of rows) {
      if (!row.rel_path.startsWith(old_prefix)) continue;
      const moved = `${new_rel}/${row.rel_path.slice(old_prefix.length)}`;
      this.db
        .query(
          'UPDATE library_files SET rel_path = @new, category = @cat WHERE id = @id',
        )
        .run({ '@new': moved, '@cat': this.category_of(moved), '@id': row.id });
    }
  }
}
