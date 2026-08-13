import { z } from 'zod';

export const ClippingFrontmatter = z.object({
  type: z.literal('clipping'),
  id: z.string().regex(/^c_[a-z0-9]{10}$/),
  // 'gedcom' — the inbox GEDCOM converter has written `kind: 'gedcom'`
  // since the genealogy feature landed, but this enum never learned it,
  // so every GEDCOM wrapper note failed projection (invisible to
  // structured queries) and re-logged a validation failure each pass.
  kind: z.enum(['article', 'pdf', 'docx', 'html', 'image', 'text', 'gedcom', 'other']),
  source: z.enum(['file', 'url']),
  source_url: z.string().url().optional(),
  title: z.string(),
  attachment_path: z.string().optional(), // relative to vault root
  captured_at: z.string(), // ISO timestamp
  reviewed: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  extracted_metadata: z.record(z.unknown()).default({}),
  /** Specialist this library item belongs to. null = global Inbox. */
  specialist_scope: z.string().nullable().default(null),
  // Phase 2b — per-note visibility scope (see src/memory/private_to.ts).
  // Optional/unset preserves legacy broad visibility on existing notes.
  private_to: z.string().optional(),
});

export type Clipping = z.infer<typeof ClippingFrontmatter>;
