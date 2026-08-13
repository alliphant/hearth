/**
 * Small shared helpers used by the Cordelia classifier and the
 * per-specialist intake handlers. Underscored so the tool loader
 * ignores it (no tool exports here).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import matter from 'gray-matter';
import type { MemoryClient } from '@memory/client';

/** Read frontmatter from a vault-relative note path. Returns null when
 *  the note doesn't exist or has no frontmatter. */
export function read_clipping_frontmatter(
  memory: MemoryClient,
  rel_path: string,
): Record<string, unknown> | null {
  const vault_root = (memory as unknown as { cfg: { vault_root: string } }).cfg.vault_root;
  const abs = resolve(vault_root, rel_path);
  if (!existsSync(abs)) return null;
  try {
    const parsed = matter(readFileSync(abs, 'utf8'));
    return parsed.data as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Merge new frontmatter fields onto an existing clipping note without
 *  rewriting the body. Used by intake handlers to stamp the
 *  `routed_to` array, `reviewed_at`, etc. */
export function patch_clipping_frontmatter(
  memory: MemoryClient,
  rel_path: string,
  patch: Record<string, unknown>,
): void {
  const vault_root = (memory as unknown as { cfg: { vault_root: string } }).cfg.vault_root;
  const abs = resolve(vault_root, rel_path);
  if (!existsSync(abs)) return;
  const parsed = matter(readFileSync(abs, 'utf8'));
  memory.upsert_note(rel_path, { ...parsed.data, ...patch }, parsed.content);
}
