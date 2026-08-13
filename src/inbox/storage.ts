import { mkdirSync, writeFileSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { dirname, resolve, join, basename, extname } from 'node:path';
import matter from 'gray-matter';
import { ulid } from 'ulid';
import type { MemoryClient } from '@memory/client';
import { local_iso_date } from '@core/time';
import { stamp_private_to_if_needed } from '@memory/private_to';
import type { Tier } from '@core/users';
import type { ConversionResult } from './types';

export interface InboxStorageConfig {
  vault_root: string;
  memory: MemoryClient;
}

export interface SavedClipping {
  id: string;
  wrapper_note_path: string; // relative to vault root
  attachment_path?: string; // relative to vault root
  title: string;
  kind: string;
}

export class InboxStorage {
  constructor(private cfg: InboxStorageConfig) {}

  /**
   * Save a converted inbox item:
   *   - if conversion produced an attachment, store it under _attachments/
   *   - write a wrapper note under Inbox/<date>-<slug>.md with frontmatter
   *
   * The MemoryClient handles the wrapper-note write so the same code path
   * applies as for any other note. The ingestor (when running) will project
   * it into the clippings table.
   */
  save(
    result: ConversionResult,
    opts: {
      source: 'file' | 'url';
      source_url?: string;
      now?: Date;
      tz?: string;
      /** Uploading user — stamps `private_to` so the clipping cordons to them. */
      caller?: { user_id: string | undefined; tier: Tier };
    },
  ): SavedClipping {
    const now = opts.now ?? new Date();
    const id = `c_${ulid().toLowerCase().slice(-10)}`;
    const date_str = local_iso_date(now, opts.tz);

    // 1. Attachment (if any) goes to vault/_attachments/<id>-<original-name>
    let attachment_rel: string | undefined;
    if (result.attachment_bytes && result.attachment_filename) {
      const safe_name = sanitize_filename(result.attachment_filename);
      attachment_rel = `_attachments/${id}-${safe_name}`;
      const attachment_abs = resolve(this.cfg.vault_root, attachment_rel);
      mkdirSync(dirname(attachment_abs), { recursive: true });
      writeFileSync(attachment_abs, result.attachment_bytes);
    }

    // 2. Wrapper note path: Inbox/<date>-<slug>.md
    const slug = slugify(result.title) || id;
    const wrapper_rel = `Inbox/${date_str}-${slug}.md`;

    const frontmatter: Record<string, unknown> = {
      type: 'clipping',
      id,
      kind: result.kind,
      source: opts.source,
      title: result.title,
      captured_at: now.toISOString(),
      reviewed: false,
      tags: [],
      extracted_metadata: result.extracted_metadata,
    };
    if (opts.source_url) frontmatter.source_url = opts.source_url;
    if (attachment_rel) frontmatter.attachment_path = attachment_rel;

    // Rewrite the body to point at the actual attachment path if it's an image
    // (the image_converter writes a placeholder using just the original filename)
    let body = result.markdown_body;
    if (result.kind === 'image' && attachment_rel) {
      body = `![${result.title}](${attachment_rel})\n`;
    }

    // Inbox clippings are personal to the uploading user.
    const stamped = stamp_private_to_if_needed(frontmatter, opts.caller);

    this.cfg.memory.upsert_note(wrapper_rel, stamped, body);

    return {
      id,
      wrapper_note_path: wrapper_rel,
      attachment_path: attachment_rel,
      title: result.title,
      kind: result.kind,
    };
  }

  /**
   * List recent Inbox items by reading the Inbox/ folder directly. No SQLite
   * dependency — works whether the ingestor is running or not.
   */
  list_recent(limit = 20): Array<{
    path: string;
    title: string;
    captured_at: string;
    kind: string;
    reviewed: boolean;
  }> {
    const inbox_dir = resolve(this.cfg.vault_root, 'Inbox');
    let entries: string[] = [];
    try {
      entries = readdirSync(inbox_dir).filter((n) => n.endsWith('.md'));
    } catch {
      return [];
    }

    const items = entries
      .map((name) => {
        const full = join(inbox_dir, name);
        const stat = statSync(full);
        let title = name.replace(/\.md$/, '');
        let captured_at = stat.mtime.toISOString();
        let kind = 'other';
        let reviewed = false;
        try {
          const parsed = matter(readFileSync(full, 'utf8'));
          const fm = parsed.data as Record<string, unknown>;
          if (typeof fm.title === 'string') title = fm.title;
          if (typeof fm.captured_at === 'string') captured_at = fm.captured_at;
          if (typeof fm.kind === 'string') kind = fm.kind;
          if (typeof fm.reviewed === 'boolean') reviewed = fm.reviewed;
        } catch {
          // ignore
        }
        return {
          path: `Inbox/${name}`,
          title,
          captured_at,
          kind,
          reviewed,
        };
      })
      .sort((a, b) => (a.captured_at < b.captured_at ? 1 : -1))
      .slice(0, limit);

    return items;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function sanitize_filename(name: string): string {
  // Strip dangerous characters; keep base + ext
  const ext = extname(name);
  const base = basename(name, ext)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 80);
  return base + ext.toLowerCase();
}
