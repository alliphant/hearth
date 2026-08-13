/**
 * ToolLoader — dynamic discovery and hot reload of specialist tools.
 *
 * Tool modules live under a few scan roots (connectors, per-specialist
 * `tools/` folders, and `src/tools/` for cross-cutting tools). The loader
 * imports each, registers what it finds in the ToolRegistry, and — once
 * watching — keeps the registry in sync as files are added, changed, or
 * removed. This is what lets a tool Beatrice ships in a merged PR become
 * invocable with no orchestrator restart.
 *
 * A tool module exposes its tools one of two ways:
 *   - `export function create(deps: ToolDeps): Tool | Tool[]` — a factory
 *     that needs runtime services; the loader calls it with the dep bag.
 *   - one or more `export const ...: Tool` — plain tools with no deps,
 *     discovered by shape.
 * A directory with an `index.ts` is a *pack*: the index is the sole entry
 * (it aggregates its siblings), and a change to any file in the directory
 * reloads the whole pack.
 *
 * Re-import after a change: Bun caches ES modules by resolved path and
 * ignores query strings, so re-importing a changed file in place returns
 * the stale module. The loader sidesteps this by importing an ephemeral
 * snapshot — a copy written at the original's own DEPTH (a fresh path
 * imports fresh; equal depth keeps relative + alias imports resolving) —
 * then deleting it. A single file snapshots as a sibling of itself; a pack
 * snapshots as a whole directory beside the pack directory, so both the
 * index's sibling imports and any import that escapes the pack resolve
 * unchanged.
 *
 * Boundary: this hot path covers a tool whose own file (or own pack)
 * changes, and brand-new tool files. A change to a *shared helper* that
 * tools import (e.g. a connector's `maps_cache.ts`) does not propagate to
 * already-loaded importers — that is a restart-class change.
 *
 * Failure isolation: a module that throws on import, or whose `create`
 * throws, is logged and skipped — never fatal. Tools already registered
 * are left intact. But "left intact" means the process keeps serving the
 * PREVIOUS version of that entry, so a failed hot reload is recorded in
 * `stale_entries()` and re-logged as an explicit stale-tools warning —
 * a reload failure must never look like a reload success.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Tool } from './tool';
import type { ToolDeps } from './tool_deps';
import type { ToolRegistry } from './tool_registry';

const SNAP_MARK = '__snap__';
const REPO_ROOT = process.env.HEARTH_REPO_ROOT ?? process.cwd();

/**
 * After the last filesystem event in the watched roots, wait this long
 * before reloading. A `git pull` writes many files near-simultaneously;
 * each one's `awaitWriteFinish` settles that file individually but says
 * nothing about its siblings or its (unwatched) transitive dependencies.
 * Coalescing every event in the burst into ONE reload pass after the
 * roots go quiet lets the whole pull land — including a tool's
 * dependency module under `src/memory` / `src/core` — before any
 * `import()` fires. This is the fix for the "first restart logs one
 * transient `[tools] load failed … (keeping previous)`" race.
 */
const RELOAD_DEBOUNCE_MS = 350;

/**
 * On a stale-dependency import error, wait this long and retry once. The
 * window covers a dependency file that was still mid-write when the entry
 * first re-imported it (so it threw and was NOT cached); by now the write
 * has settled and the retry reads it fresh. A dependency that already
 * evaluated to a stale-but-valid version is cached by canonical path for
 * the process lifetime — the debounce above, not this retry, is what
 * keeps that from happening.
 */
const STALE_DEP_RETRY_MS = 300;

/**
 * Signatures of an import failure caused by a not-yet-settled dependency
 * (or a transiently unresolvable module), as opposed to a real syntax
 * error in the entry itself. A genuine parse error ("Unexpected token",
 * "Expected …") does not match, so it still fails loudly and keeps the
 * previous registration.
 */
const STALE_DEP_RE =
  /not found in module|does not provide an export named|Importing binding name .* is not found|Cannot find module|Failed to resolve module/i;

/**
 * A tool entry whose latest reload attempt FAILED. The registry still
 * serves the previously-loaded version of its tools, so the running tool
 * set no longer matches the tree on disk: a restart is required to apply
 * the change. Surfaced by `ToolLoader.stale_entries()` and on `/status`.
 */
export interface StaleToolEntry {
  /** Repo-relative path of the entry module (a file, or a pack's index.ts). */
  entry: string;
  /** Tool names still registered from the pre-change version of this entry. */
  serving: string[];
  /** Message from the failing import / extraction. */
  error: string;
  /** ISO instant of the first failure in the current stale streak. */
  since: string;
  /** Consecutive failed reload attempts since the last success. */
  attempts: number;
}

/** A directory to scan for tool modules. */
export interface ToolRoot {
  /** Absolute directory path. */
  dir: string;
  /**
   * When set, a file under `dir` is a tool module only if its path
   * relative to `dir` matches. Used to scope `src/specialists` to each
   * specialist's `tools/` folder.
   */
  pattern?: RegExp;
}

export interface ToolLoaderOptions {
  registry: ToolRegistry;
  deps: ToolDeps;
  roots: ToolRoot[];
}

function is_snapshot(p: string): boolean {
  return p.includes(SNAP_MARK);
}

/**
 * Duck-typed Tool check. A discovered export is a tool when it carries
 * the load-bearing fields; helpers, schemas, types and factory functions
 * all fail this.
 */
function is_tool(x: unknown): x is Tool {
  if (!x || typeof x !== 'object') return false;
  const t = x as Record<string, unknown>;
  const schema_like = (s: unknown): boolean =>
    !!s && typeof (s as { safeParse?: unknown }).safeParse === 'function';
  return (
    typeof t.name === 'string' &&
    t.name.length > 0 &&
    typeof t.description === 'string' &&
    typeof t.risk === 'string' &&
    typeof t.execute === 'function' &&
    typeof t.idempotency_key === 'function' &&
    schema_like(t.input_schema) &&
    schema_like(t.output_schema)
  );
}

function rel(p: string): string {
  return relative(REPO_ROOT, p) || p;
}

let _seq = 0;
function unique(): string {
  _seq = (_seq + 1) % 1_000_000;
  return `${Date.now().toString(36)}_${_seq.toString(36)}`;
}

export class ToolLoader {
  private readonly registry: ToolRegistry;
  private readonly deps: ToolDeps;
  private readonly roots: ToolRoot[];
  private watcher: FSWatcher | null = null;
  /** entry module path → names of tools currently registered from it. */
  private readonly entry_tools = new Map<string, string[]>();
  /** entry module path → latest pending op, awaiting the debounce flush. */
  private readonly pending = new Map<string, 'upsert' | 'unlink'>();
  /** entry module path → failed-reload record; cleared on a good load. */
  private readonly stale = new Map<string, StaleToolEntry>();
  private reload_timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: ToolLoaderOptions) {
    this.registry = opts.registry;
    this.deps = opts.deps;
    this.roots = opts.roots
      .map((r) => ({ dir: resolve(r.dir), pattern: r.pattern }))
      .filter((r) => existsSync(r.dir));
  }

  /** One-shot scan of every root. Call once at boot, before serving. */
  async load_all(): Promise<void> {
    let count = 0;
    for (const entry of this.discover_entries()) {
      count += (await this.load_entry(entry, false)).length;
    }
    console.log(
      `[tools] loaded ${count} tool(s) from ${this.entry_tools.size} module(s)` +
        (this.stale.size > 0 ? ` — ${this.stale.size} module(s) FAILED to load` : ''),
    );
  }

  /**
   * Start watching the roots; keep the registry in sync on file events.
   * Resolves once chokidar's initial scan completes — until `ready`, a
   * file created in a watched directory is swept into the (ignored)
   * initial scan rather than emitting an `add` event.
   */
  async watch(): Promise<void> {
    if (this.watcher) return;
    const w = chokidar.watch(
      this.roots.map((r) => r.dir),
      {
        ignoreInitial: true,
        ignored: /__snap__/,
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      },
    );
    this.watcher = w;
    w.on('add', (p) => this.enqueue(p, 'upsert'));
    w.on('change', (p) => this.enqueue(p, 'upsert'));
    w.on('unlink', (p) => this.enqueue(p, 'unlink'));
    await new Promise<void>((res) => w.once('ready', () => res()));
    console.log(`[tools] watching ${this.roots.length} root(s) for changes`);
  }

  async close(): Promise<void> {
    if (this.reload_timer) {
      clearTimeout(this.reload_timer);
      this.reload_timer = null;
    }
    this.pending.clear();
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /** Entry modules currently tracked — for diagnostics and the smoke. */
  entries(): string[] {
    return [...this.entry_tools.keys()];
  }

  /**
   * Entries whose latest load attempt failed. Non-empty means the running
   * tool set is out of date with the tree and a restart is required — the
   * signal `/status` (and anything monitoring it) reads.
   */
  stale_entries(): StaleToolEntry[] {
    return [...this.stale.values()];
  }

  // ── event handlers (debounced) ─────────────────────────────────────────

  /**
   * Record a watched-file event and (re)arm the debounce. Every event in a
   * burst resets the timer, so a multi-file `git pull` collapses into a
   * single `flush()` once the roots fall quiet — no `import()` fires until
   * the whole burst has landed. Latest op per entry wins; the final disk
   * state is re-checked in `flush()`.
   */
  private enqueue(p: string, op: 'upsert' | 'unlink'): void {
    if (!this.is_tool_file(p)) return;
    this.pending.set(this.entry_for(p), op);
    if (this.reload_timer) clearTimeout(this.reload_timer);
    this.reload_timer = setTimeout(() => void this.flush(), RELOAD_DEBOUNCE_MS);
  }

  /** Apply every coalesced event once the watched roots are quiet. */
  private async flush(): Promise<void> {
    this.reload_timer = null;
    const batch = [...this.pending];
    this.pending.clear();
    for (const [entry, op] of batch) {
      try {
        // Resolve the action against the FINAL disk state: an entry that
        // still exists is a (re)load even if the triggering event was an
        // unlink of one pack sibling; an entry that's gone is an unload.
        if (op === 'upsert' || existsSync(entry)) {
          await this.load_entry(entry, true);
        } else {
          this.unload_entry(entry);
        }
      } catch (err) {
        // load_entry/unload_entry don't throw; this only guards existsSync
        // and keeps the watcher's "never break the running process" rule.
        console.error(`[tools] reload of ${rel(entry)} failed:`, err);
      }
    }
  }

  // ── core ───────────────────────────────────────────────────────────────

  /**
   * Import an entry module, extract its tools, and reconcile the
   * registry. Returns the names now registered from this entry. Never
   * throws — a failure logs and leaves the previous registration intact.
   */
  private async load_entry(entry: string, hot: boolean): Promise<string[]> {
    let tools: Tool[];
    try {
      tools = await this.extract(entry, hot);
    } catch (err) {
      if (hot && STALE_DEP_RE.test(err instanceof Error ? err.message : String(err))) {
        // A dependency module was still mid-write when this entry
        // re-imported it — the multi-file-pull race. Wait for the write
        // to settle and retry the import ONCE; a real syntax error in the
        // entry doesn't match the signature and goes straight to
        // `mark_stale` below.
        console.warn(
          `[tools] ${rel(entry)} hit a stale-dependency import; retrying once in ${STALE_DEP_RETRY_MS}ms`,
        );
        await new Promise((r) => setTimeout(r, STALE_DEP_RETRY_MS));
        try {
          tools = await this.extract(entry, hot);
        } catch (err2) {
          return this.mark_stale(entry, err2, hot);
        }
      } else {
        return this.mark_stale(entry, err, hot);
      }
    }
    this.stale.delete(entry);
    const prev = this.entry_tools.get(entry) ?? [];
    const next = tools.map((t) => t.name);
    for (const name of prev) {
      if (!next.includes(name)) this.registry.unregister(name);
    }
    for (const t of tools) {
      const owner = this.owner_of(t.name);
      if (owner && owner !== entry) {
        console.warn(
          `[tools] '${t.name}' from ${rel(entry)} overrides ${rel(owner)}`,
        );
      }
      this.registry.register(t);
    }
    if (next.length > 0) this.entry_tools.set(entry, next);
    else this.entry_tools.delete(entry);
    if (hot) {
      console.log(
        `[tools] reloaded ${rel(entry)} → [${next.join(', ') || 'no tools'}]`,
      );
    }
    return next;
  }

  /**
   * Record a failed load and say so plainly. The registry keeps whatever
   * this entry last registered, so from the outside a broken reload is
   * indistinguishable from a clean one — that is the failure mode this
   * exists to kill. The entry stays in `stale_entries()` (and on
   * `/status`) until a later load of the same entry succeeds, so an
   * operator, a smoke, or Kate's own change pipeline can tell that the
   * running tool set no longer matches the tree and needs a restart.
   */
  private mark_stale(entry: string, err: unknown, hot: boolean): string[] {
    const serving = this.entry_tools.get(entry) ?? [];
    const prior = this.stale.get(entry);
    const record: StaleToolEntry = {
      entry: rel(entry),
      serving,
      error: err instanceof Error ? err.message : String(err),
      since: prior?.since ?? new Date().toISOString(),
      attempts: (prior?.attempts ?? 0) + 1,
    };
    this.stale.set(entry, record);
    console.error(`[tools] load failed for ${rel(entry)}:`, err);
    console.error(
      hot && serving.length > 0
        ? `[tools] ⚠ STALE TOOLS — ${rel(entry)} failed to reload; still serving the ` +
            `PREVIOUS version of [${serving.join(', ')}]. The running tool set does ` +
            `NOT match the tree on disk; restart the orchestrator to apply the change.`
        : `[tools] ⚠ MISSING TOOLS — ${rel(entry)} did not load; its tools are ` +
            `unavailable until the module is fixed.`,
    );
    return serving;
  }

  private unload_entry(entry: string): void {
    this.stale.delete(entry);
    const names = this.entry_tools.get(entry) ?? [];
    for (const name of names) this.registry.unregister(name);
    this.entry_tools.delete(entry);
    if (names.length > 0) {
      console.log(`[tools] unloaded ${rel(entry)} → removed [${names.join(', ')}]`);
    }
  }

  /**
   * Dynamic-import an entry and pull Tool objects out of it. When `hot`,
   * import an ephemeral snapshot so Bun's module cache is bypassed.
   */
  private async extract(entry: string, hot: boolean): Promise<Tool[]> {
    const is_pack = basename(entry) === 'index.ts';
    let import_path = entry;
    let cleanup: (() => void) | null = null;
    if (hot) {
      const snap = is_pack
        ? this.snapshot_pack(dirname(entry))
        : this.snapshot_file(entry);
      import_path = snap.path;
      cleanup = snap.cleanup;
    }
    try {
      // Canonicalize before importing: on macOS `/var/folders/...` is a
      // symlink to `/private/var/folders/...`, and Bun's dynamic-import
      // resolver fails ("Cannot find module") on the symlinked form. The
      // file exists here (a snapshot just written, or the original entry),
      // so realpath is safe; on the LLM host (bind mount, no symlink) it's a
      // no-op, so production resolution is unchanged.
      const canonical = realpathSync(import_path);
      const mod = (await import(pathToFileURL(canonical).href)) as Record<
        string,
        unknown
      >;
      return await this.tools_from_module(mod, entry);
    } finally {
      if (cleanup) {
        try {
          cleanup();
        } catch (err) {
          console.error(`[tools] snapshot cleanup failed for ${rel(entry)}:`, err);
        }
      }
    }
  }

  private async tools_from_module(
    mod: Record<string, unknown>,
    entry: string,
  ): Promise<Tool[]> {
    const out: Tool[] = [];
    if (typeof mod.create === 'function') {
      const create = mod.create as (d: ToolDeps) => unknown;
      const produced = await create(this.deps);
      const list = Array.isArray(produced) ? produced : [produced];
      for (const c of list) {
        if (is_tool(c)) out.push(c);
        else console.warn(`[tools] ${rel(entry)}: create() yielded a non-tool`);
      }
    } else {
      for (const val of Object.values(mod)) {
        if (is_tool(val)) out.push(val);
      }
    }
    return out;
  }

  // ── snapshots ──────────────────────────────────────────────────────────

  /** Copy a single file to a fresh sibling path. */
  private snapshot_file(entry: string): { path: string; cleanup: () => void } {
    const stem = basename(entry, '.ts');
    const snap = join(dirname(entry), `${stem}.${SNAP_MARK}.${unique()}.ts`);
    writeFileSync(snap, readFileSync(entry));
    return { path: snap, cleanup: () => rmSync(snap, { force: true }) };
  }

  /**
   * Copy a whole pack directory so the index's sibling imports are fresh.
   *
   * The snapshot is a SIBLING of the pack directory, never a child of it.
   * Depth is load-bearing: a pack file may import out of the pack
   * (`archive_url.ts` → `../media_archive_runner`), and a relative
   * specifier resolves against the importing file's directory. A snapshot
   * nested inside the pack sits one level too deep, so every `../` lands
   * one directory short and the import fails to resolve — which the loader
   * could only report as "load failed (keeping previous)", silently
   * serving the pre-change tools. At the pack's own depth every relative
   * specifier — `./sibling`, `../x`, `../../y` — resolves exactly as it
   * does from the real pack.
   */
  private snapshot_pack(dir: string): { path: string; cleanup: () => void } {
    const snapdir = join(dirname(dir), `${SNAP_MARK}.${unique()}`);
    mkdirSync(snapdir, { recursive: true });
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') || is_snapshot(f)) continue;
      writeFileSync(join(snapdir, f), readFileSync(join(dir, f)));
    }
    return {
      path: join(snapdir, 'index.ts'),
      cleanup: () => rmSync(snapdir, { recursive: true, force: true }),
    };
  }

  // ── path classification ────────────────────────────────────────────────

  /** True when `p` is a discoverable tool module under a configured root. */
  private is_tool_file(p: string): boolean {
    const abs = resolve(p);
    if (!abs.endsWith('.ts') || abs.endsWith('.d.ts')) return false;
    if (is_snapshot(abs)) return false;
    if (basename(abs).startsWith('_')) return false;
    for (const root of this.roots) {
      if (!abs.startsWith(root.dir + sep)) continue;
      if (root.pattern && !root.pattern.test(relative(root.dir, abs))) continue;
      return true;
    }
    return false;
  }

  /** The entry module for a file: the directory's index.ts if one exists
   *  (the directory is a pack), otherwise the file itself. */
  private entry_for(p: string): string {
    const abs = resolve(p);
    const idx = join(dirname(abs), 'index.ts');
    return existsSync(idx) ? idx : abs;
  }

  private discover_entries(): string[] {
    const entries = new Set<string>();
    for (const root of this.roots) {
      let files: string[];
      try {
        files = readdirSync(root.dir, { recursive: true }) as string[];
      } catch {
        continue;
      }
      for (const f of files) {
        const abs = resolve(root.dir, f);
        if (this.is_tool_file(abs)) entries.add(this.entry_for(abs));
      }
    }
    return [...entries];
  }

  private owner_of(name: string): string | null {
    for (const [entry, names] of this.entry_tools) {
      if (names.includes(name)) return entry;
    }
    return null;
  }
}
