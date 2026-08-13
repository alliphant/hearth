/**
 * Memory file maintenance (Prompt 6c).
 *
 * Each specialist has a long-running `Knowledge/<Name>/memory.md` that
 * accumulates dated entries from deliberation passes. Without maintenance
 * this grows unbounded.
 *
 * Operations:
 *   - append_to_memory: add a dated entry under a "## YYYY-MM-DD HH:MM" header.
 *   - read_memory: return the parsed entries, optionally the last N.
 *   - read_memory_tail: convenience — last N entries as plain text.
 *   - compact_memory: weekly maintenance. Entries older than keep_recent_days
 *     are LLM-summarized into a single "## Archive: pre-<date>" block at the
 *     top of the file. Existing archive blocks are preserved verbatim.
 *
 * Memory files are also user-editable in Obsidian. compact_memory is
 * idempotent: running it twice on the same file produces the same result.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import matter from 'gray-matter';
import type { MemoryClient } from '@memory/client';
import { local_iso_date, local_iso_minute } from './time';
import { capitalize } from './loops';

export interface MemoryEntry {
  date_header: string; // "## 2026-05-15 18:30"
  ts: Date | null;
  body: string;
}

export interface ArchiveBlock {
  header: string; // "## Archive: pre-2026-04-15"
  body: string;
}

/**
 * Per-user memory file resolution (Phase 2b multi-user isolation).
 *
 * Memory files live at `Knowledge/<Specialist>/memory.md` historically;
 * with multi-user, we need to NOT leak Jasper's accumulated memory into
 * Sam's conversations. The split:
 *
 *   - `memory.md` is implicitly Jasper's memory (legacy — that's whose
 *     history accumulated there). For backward compat, `jasper` keeps
 *     reading/writing memory.md directly.
 *   - Every other user gets `memory_<user_id>.md` (starts empty, fills
 *     on their own deliberation cycles). Non-existent file = empty
 *     tail, which is the correct starting state for a fresh user.
 *   - A user-less caller (a specialist's own domain deliberation, the
 *     scheduler, the awareness-buffer flush) resolves to `memory.md`:
 *     system context, owner-scoped by the same rule the `private_to`
 *     cordon applies to an unstamped note.
 *
 * Kate used to be EXEMPT here, reading and writing the canonical
 * `memory.md` for every user on the theory that a Chief of Staff needs
 * household-wide recall, with her persona prompt asked to exercise
 * discretion about what it surfaced to whom. That put a layer-2 (soft
 * prompt) control on a layer-3 (data) problem, and it leaked: her
 * per-user brief fan-out wrote each member's private facts into the one
 * shared file, and the owner's next pass read them back as recall.
 * Grace Ma's birthday — a `private_to: sam` life event — reached
 * Jasper's 2026-07-29 briefs that way. `note_visible_to_caller` gives the
 * owner no bypass over a member's personal note, so neither does this.
 */
export function memory_path(specialist_id: string, user_id?: string): string {
  const base = `Knowledge/${capitalize(specialist_id)}`;
  if (!user_id || user_id === 'jasper') {
    return `${base}/memory.md`;
  }
  return `${base}/memory_${user_id}.md`;
}

function memory_abs(memory: MemoryClient, specialist_id: string, user_id?: string): string {
  // We need direct fs access to do the full rewrite for compaction; the
  // MemoryClient's vault_root is the only thing we need from it.
  const vault_root = (memory as unknown as { cfg: { vault_root: string } }).cfg.vault_root;
  return resolve(vault_root, memory_path(specialist_id, user_id));
}

export function append_to_memory(
  memory: MemoryClient,
  specialist_id: string,
  body: string,
  context_tag?: string,
  user_id?: string,
): void {
  const stamp = local_iso_minute();
  const header = `## ${stamp}`;
  const tag = context_tag ? ` _(${context_tag})_` : '';
  const entry = `${header}${tag}\n\n${body.trim()}\n`;
  // MemoryClient.append_to_note prefixes with blank line — that's fine.
  memory.append_to_note(memory_path(specialist_id, user_id), entry);
}

export function read_memory(
  memory: MemoryClient,
  specialist_id: string,
  last_n_entries?: number,
  user_id?: string,
): { archive: ArchiveBlock | null; entries: MemoryEntry[] } {
  const abs = memory_abs(memory, specialist_id, user_id);
  if (!existsSync(abs)) return { archive: null, entries: [] };
  const parsed = matter(readFileSync(abs, 'utf8'));
  return parse_memory_body(parsed.content, last_n_entries);
}

export function read_memory_tail(
  memory: MemoryClient,
  specialist_id: string,
  last_n_entries = 10,
  user_id?: string,
): string {
  const { entries } = read_memory(memory, specialist_id, last_n_entries, user_id);
  return entries.map((e) => `${e.date_header}\n${e.body}`).join('\n\n');
}

function parse_memory_body(
  body: string,
  last_n_entries?: number,
): { archive: ArchiveBlock | null; entries: MemoryEntry[] } {
  // The first "## Archive: pre-<date>" block (if any) is preserved as-is.
  // Subsequent "## YYYY-MM-DD HH:MM" headers delimit entries.
  let archive: ArchiveBlock | null = null;
  let rest = body;
  const archive_match = body.match(/^## Archive: pre-(\d{4}-\d{2}-\d{2})\n([\s\S]*?)(?=\n## (?!Archive: )|$)/);
  if (archive_match) {
    archive = {
      header: `## Archive: pre-${archive_match[1]}`,
      body: (archive_match[2] ?? '').trim(),
    };
    rest = body.slice(archive_match[0].length);
  }

  const entries: MemoryEntry[] = [];
  // Match dated headers — entries are everything between this header and the next.
  const re = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?:\s*_\([^)]*\)_)?\s*\n([\s\S]*?)(?=\n## (?:\d{4}|Archive)|$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    const ts_str = m[1]!;
    const ts = parse_entry_ts(ts_str);
    entries.push({
      date_header: `## ${ts_str}`,
      ts,
      body: (m[2] ?? '').trim(),
    });
  }

  return {
    archive,
    entries: last_n_entries === undefined ? entries : entries.slice(-last_n_entries),
  };
}

function parse_entry_ts(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(
    parseInt(m[1]!, 10),
    parseInt(m[2]!, 10) - 1,
    parseInt(m[3]!, 10),
    parseInt(m[4]!, 10),
    parseInt(m[5]!, 10),
  );
}

export interface CompactMemoryInput {
  memory: MemoryClient;
  specialist_id: string;
  /**
   * Which user's memory file to compact (see `memory_path`). Omit for the
   * canonical `memory.md`. The weekly job walks every user so a member's
   * `memory_<id>.md` is bounded the same way the owner's is — before the
   * 2026-07-29 per-user split there was only one file to compact, and a
   * job that still passed nothing here would let member files grow forever.
   */
  user_id?: string;
  keep_recent_days?: number;
  /** Async summarizer (LLM-driven in prod, simple concat-truncate in tests). */
  summarize: (text: string) => Promise<string>;
}

/**
 * Compact memory.md: entries older than keep_recent_days get summarized
 * into the "## Archive: pre-<date>" header. Entries within the window are
 * kept verbatim. Idempotent — re-running with the same input produces the
 * same output (only entries that newly fall outside the window are folded
 * into the archive).
 */
export async function compact_memory(input: CompactMemoryInput): Promise<{
  archived_count: number;
  remaining_count: number;
}> {
  const { memory, specialist_id, summarize } = input;
  const keep_days = input.keep_recent_days ?? 30;
  const abs = memory_abs(memory, specialist_id, input.user_id);
  if (!existsSync(abs)) return { archived_count: 0, remaining_count: 0 };

  const parsed = matter(readFileSync(abs, 'utf8'));
  const { archive, entries } = parse_memory_body(parsed.content);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - keep_days);

  const to_archive = entries.filter((e) => e.ts && e.ts < cutoff);
  const to_keep = entries.filter((e) => !e.ts || e.ts >= cutoff);

  if (to_archive.length === 0) {
    return { archived_count: 0, remaining_count: to_keep.length };
  }

  const archive_input =
    (archive ? `${archive.header}\n\n${archive.body}\n\n---\n\n` : '') +
    to_archive.map((e) => `${e.date_header}\n${e.body}`).join('\n\n');
  const summary_text = await summarize(archive_input);

  // Use today's cutoff as the archive's "pre-" date so future runs know
  // what's covered. (Anything-with-a-ts < cutoff is now folded in.)
  const cutoff_iso = local_iso_date(cutoff);
  const new_archive: ArchiveBlock = {
    header: `## Archive: pre-${cutoff_iso}`,
    body: summary_text.trim(),
  };

  const new_body =
    `${new_archive.header}\n\n${new_archive.body}\n\n` +
    to_keep.map((e) => `${e.date_header}\n${e.body}`).join('\n\n') +
    '\n';

  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, matter.stringify(new_body, parsed.data), 'utf8');

  return { archived_count: to_archive.length, remaining_count: to_keep.length };
}
