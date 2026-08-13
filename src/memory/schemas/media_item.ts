/**
 * media_item — a PROJECTED node type (Media Archive, 2026-07-11).
 *
 * The vault note is the source of truth (RAG + human-navigable); the
 * media_items table is the structured/browse projection. Mirrors
 * household_good file-for-file (schema → note_types → structured.ts table →
 * client.ts row+query → ingestor projector → rebuild/unproject).
 *
 * The measured metrics ride in `.passthrough()` + the note body; the typed
 * fields are the browse/scan columns. NSFW items carry `private_to: <owner>`
 * (the cordon — never household).
 */
import { z } from 'zod';

export const MediaItemFrontmatter = z
  .object({
    type: z.literal('media_item'),
    id: z.string().regex(/^mi_[a-z0-9]{6,}$/),
    name: z.string().min(1), // display title
    media_kind: z.string().optional(), // MediaKind (kept as string for passthrough tolerance)
    source_site: z.string().optional(), // extractor, e.g. 'youtube'
    source_url: z.string().optional(),
    creator: z.string().optional(), // artist/channel — from metadata only
    genre: z.string().optional(),
    nsfw: z.boolean().default(false),
    nsfw_score: z.number().optional(),
    duration_s: z.number().nonnegative().optional(),
    width: z.number().nonnegative().optional(),
    height: z.number().nonnegative().optional(),
    fps: z.number().nonnegative().optional(),
    vcodec: z.string().optional(),
    acodec: z.string().optional(),
    container: z.string().optional(),
    filesize: z.number().nonnegative().optional(), // bytes
    resolution_label: z.string().optional(),
    language: z.string().optional(),
    age_limit: z.number().optional(),
    view_count: z.number().optional(),
    like_count: z.number().optional(),
    published_at: z.string().optional(), // ISO date (from upload_date)
    archived_at: z.string().optional(), // ISO datetime
    nas_path: z.string().optional(), // media file path under the archive root
    thumbnail_path: z.string().optional(),
    tags: z.array(z.string()).default([]),
    quality_policy: z.string().optional(),
    private_to: z.string().optional(),
    // Explicit per-item named grants (sharing, 2026-07-29). Users listed here
    // see + stream the item even though the `private_to` cordon alone would
    // hide it; the file itself never moves, so a recipient finds it at the
    // identical `nas_path`. Written ONLY by the item's own owner via
    // POST /api/media/item/:id/share — never a tier keyword, always names.
    shared_with: z.array(z.string()).optional(),
    // Subtitle/caption tracks pulled by rescan_media_metadata (rides
    // frontmatter_json — no SQL column). Path is relative to the archive root.
    captions: z
      .array(
        z.object({
          lang: z.string(),
          path: z.string(),
          format: z.string().default('srt'),
          auto: z.boolean().optional(),
        }),
      )
      .optional(),
  })
  .passthrough();

export type MediaItem = z.infer<typeof MediaItemFrontmatter>;
