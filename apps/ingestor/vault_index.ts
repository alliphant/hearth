/**
 * Basename → note-path index for resolving [[wikilinks]].
 *
 * Wikilinks address notes by basename (without the .md extension), but
 * the vault has nested directories — two notes can share a basename
 * (`Projects/Foo.md` and `Drafts/Foo.md` both have basename `Foo`).
 * Resolution is intentionally strict: the projector only upserts a
 * graph edge when there's exactly one match; 0 or >1 candidates are
 * logged as ambiguous and skipped.
 *
 * Maintained incrementally by the watcher (add/remove on file events)
 * and rebuilt from scratch by the rebuild driver.
 */

import { existsSync } from 'node:fs';
import { Glob } from 'bun';
import { relative } from 'node:path';
import { note_basename } from './project';

export class VaultIndex {
  // basename → set of relative paths (e.g. "Foo" → {"Projects/Foo.md", "Drafts/Foo.md"})
  private by_basename = new Map<string, Set<string>>();
  // rel_path → basename (for fast removal on unlink, since we lose the file by then)
  private by_path = new Map<string, string>();

  add(rel_path: string): void {
    const bn = note_basename(rel_path);
    const existing_bn = this.by_path.get(rel_path);
    if (existing_bn && existing_bn !== bn) {
      this.remove_internal(rel_path, existing_bn);
    }
    this.by_path.set(rel_path, bn);
    let set = this.by_basename.get(bn);
    if (!set) {
      set = new Set();
      this.by_basename.set(bn, set);
    }
    set.add(rel_path);
  }

  remove(rel_path: string): void {
    const bn = this.by_path.get(rel_path);
    if (!bn) return;
    this.remove_internal(rel_path, bn);
  }

  private remove_internal(rel_path: string, bn: string): void {
    this.by_path.delete(rel_path);
    const set = this.by_basename.get(bn);
    if (!set) return;
    set.delete(rel_path);
    if (set.size === 0) this.by_basename.delete(bn);
  }

  /** All rel_paths matching the wikilink target basename. */
  resolve(target: string): string[] {
    const set = this.by_basename.get(target.trim());
    return set ? [...set] : [];
  }

  size(): number {
    return this.by_path.size;
  }

  /** Scan the vault and build a fresh index. */
  static async build(vault_root: string): Promise<VaultIndex> {
    const idx = new VaultIndex();
    if (!existsSync(vault_root)) return idx;

    const glob = new Glob('**/*.md');
    for await (const abs of glob.scan({ cwd: vault_root, absolute: true })) {
      idx.add(relative(vault_root, abs));
    }
    return idx;
  }
}
