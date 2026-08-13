/**
 * cleanup_library_trash — universal housekeeping tool. Any specialist can
 * call it; the scope is hard-clamped to the caller's own library
 * (`Knowledge/<CapitalizedId>/library/`) via ctx.specialist_id, so Anya
 * can't sweep Iris's, Iris can't sweep Anya's, etc. No chief-librarian
 * persona needed.
 *
 * What gets removed:
 *   - Zero-byte files under .../library/_attachments/ — failed PDF/image
 *     uploads where pdfjs or a similar parser detached the input buffer
 *     and the bytes never made it to disk (the historical Anya the clinic VTH
 *     case; pdf.ts now clones bytes before pdfjs runs, but old artifacts
 *     remain and the symptom is search returning nothing for a doc the
 *     user clearly uploaded).
 *   - The wrapper markdown note that referenced the broken attachment.
 *   - The clippings DB row.
 *   - Any chunks_fts rows for that note (so the broken entry stops
 *     polluting search-result counts).
 *
 * Safety: dry_run=true returns the list without touching anything.
 * Default is action — the user wants specialists to actually fix broken
 * libraries when they notice them, not file a ticket.
 */
import { z } from 'zod';
import { readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';

const InputSchema = z.object({
  // Qwen-safe: accept "true"/"false" string form as well. Kept
  // optional (no `.default()`) so input and parsed-output types stay
  // identical — `.default()` makes Zod widen the input type and
  // breaks the Tool<I, O> generic. Default applied in execute().
  dry_run: z.coerce.boolean().optional(),
});

const RemovedEntrySchema = z.object({
  attachment_path: z.string(),
  wrapper_note_path: z.string().nullable(),
  chunks_removed: z.number(),
});

const OutputSchema = z.object({
  library_root: z.string(),
  scanned_attachments: z.number(),
  zero_byte_count: z.number(),
  removed: z.array(RemovedEntrySchema),
  dry_run: z.boolean(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function capitalize_id(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function make_cleanup_library_trash(
  db: Database,
  vault_root: string,
): Tool<Input, Output> {
  return {
    name: 'cleanup_library_trash',
    description:
      "Sweep your own library (Knowledge/<You>/library/) for zero-byte attachment files — failed uploads where the bytes never landed on disk — and remove them along with their wrapper notes, clippings rows, and search-index entries. Use this WHENEVER a search_library call comes back empty for a document the user clearly uploaded: the most common cause is a broken ingest that left an empty placeholder. Default behavior DELETES. Pass dry_run=true to preview. Scope is hard-clamped to your own library; you cannot affect other specialists' libraries.",
    risk: 'write_internal',
    required_capabilities: [],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key() {
      // Stateless sweep — re-calling is safe (idempotent on the
      // filesystem since deleted files stay deleted). No per-input
      // identity to hash.
      return 'cleanup_library_trash';
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      if (!ctx.specialist_id) {
        throw new Error(
          'cleanup_library_trash requires specialist_id on ToolContext; ' +
            'this tool can only be called from a specialist turn',
        );
      }
      const dry_run = input.dry_run ?? false;
      const ns = capitalize_id(ctx.specialist_id);
      const lib_rel = `Knowledge/${ns}/library`;
      const att_dir_rel = `${lib_rel}/_attachments`;
      const att_dir_abs = resolve(vault_root, att_dir_rel);

      const removed: Array<z.infer<typeof RemovedEntrySchema>> = [];
      let scanned = 0;
      let zero_byte = 0;

      if (!existsSync(att_dir_abs)) {
        return {
          library_root: lib_rel,
          scanned_attachments: 0,
          zero_byte_count: 0,
          removed,
          dry_run: dry_run,
        };
      }

      for (const name of readdirSync(att_dir_abs)) {
        const att_abs_file = join(att_dir_abs, name);
        let st;
        try {
          st = statSync(att_abs_file);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        scanned++;
        if (st.size !== 0) continue;
        zero_byte++;

        const att_rel = `${att_dir_rel}/${name}`;
        // Match the wrapper note via the clippings table — its
        // frontmatter_json embeds the attachment_path. Use the filename
        // (which contains the c_<ulid> id) as a robust substring match,
        // since historical wrappers may reference an old path prefix
        // (e.g. "Knowledge/Dr. Anya/...") that no longer matches lib_rel.
        const row = db
          .prepare(
            `SELECT note_path FROM clippings
             WHERE frontmatter_json LIKE @lk
                OR attachment_path LIKE @lk
             LIMIT 1`,
          )
          .get({ '@lk': `%${name}%` }) as { note_path?: string } | undefined;
        const wrapper_rel = row?.note_path ?? null;

        let chunks_removed = 0;
        if (!dry_run) {
          try {
            unlinkSync(att_abs_file);
          } catch {
            /* already gone */
          }
          if (wrapper_rel) {
            const note_abs = resolve(vault_root, wrapper_rel);
            try {
              unlinkSync(note_abs);
            } catch {
              /* may not exist on disk anymore */
            }
            db.prepare(`DELETE FROM clippings WHERE note_path = @p`).run({
              '@p': wrapper_rel,
            });
            const r = db
              .prepare(`DELETE FROM chunks_fts WHERE note_path = @p`)
              .run({ '@p': wrapper_rel });
            chunks_removed = r.changes ?? 0;
            // Drop the parallel vector rows (RAG Pass 7) so a removed note
            // leaves no orphaned embeddings behind.
            db.prepare(`DELETE FROM chunk_embeddings WHERE note_path = @p`).run({
              '@p': wrapper_rel,
            });
          }
        }

        removed.push({
          attachment_path: att_rel,
          wrapper_note_path: wrapper_rel,
          chunks_removed,
        });
      }

      return {
        library_root: lib_rel,
        scanned_attachments: scanned,
        zero_byte_count: zero_byte,
        removed,
        dry_run: dry_run,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_cleanup_library_trash(deps.db, deps.vault_root) as Tool;
}
