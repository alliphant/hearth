/**
 * read_note — return the full body of a single note in the vault.
 * The complement to `search_library`: search returns ranked chunk
 * hits; this returns the entire document (frontmatter summary + body)
 * for a known note_path.
 *
 * Necessary because RAG auto-retrieval only surfaces the top-k chunks
 * for the user's question — when a specialist needs to READ the
 * whole document (e.g. Anya wanting Bailey's full visit notes to do
 * clinical reasoning rather than keyword spotting), there was no
 * tool path for that. Specialists were trying web_fetch_clean on a
 * vault-relative path and getting an empty result, then concluding
 * "PDFs return empty" when in fact the markdown body was indexed and
 * available all along.
 *
 * UNSCOPED as of 2026-07-17 (owner directive: "give every specialist
 * the ability to read/search whatever"). This matches search_library,
 * which has been vault-global since v0 — the old knowledge_scope gate
 * meant a specialist could FIND a note anywhere via search but then
 * couldn't READ it, forcing consult round-trips for no safety gain.
 * knowledge_scope still governs turn-start auto-RAG (a relevance
 * choice, not access control).
 *
 * The one real boundary is the per-user `private_to` cordon — enforced
 * here through the same ONE rule RAG retrieval uses
 * (`note_frontmatter_visible_to_caller`: cordon OR named `shared_with`
 * grant). The scope gate never checked it, so this tool is strictly
 * SAFER for multi-user notes than before, not looser. An invisible note
 * answers "not found" (no existence oracle).
 *
 * The grant half is load-bearing, not decoration (2026-07-29): this tool
 * used to pass only `private_to` while the RAG chunk gate passed
 * `shared_with` too, so a grantee's `search_library` legitimately
 * returned a chunk from an item shared with them and the `read_note` on
 * the path it just handed over answered "not found… Try search_library"
 * — a loop that made a shared item discoverable-but-unreadable by the
 * one person it was shared with.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { with_candidates } from '@core/tool_registry';
import { note_frontmatter_visible_to_caller } from '@memory/private_to';
import { looks_binary } from '@core/binary_text';
import { within_allowlist } from '@specialists/trainer/codebase_fs';

/**
 * Real vault paths to offer when a `read_note` misses — the reference
 * implementation of the thrown-error recovery channel (`with_candidates`).
 *
 * Sourced through `retrieve_scoped_chunks` with the CALLER's id + tier, so
 * the suggestions pass exactly the same per-user cordon as the "not found"
 * answer above. That is load-bearing, not incidental: this tool deliberately
 * answers "not found" for a note the caller may not see so the error is not
 * an existence oracle, and a candidate list assembled any other way would
 * hand back the exact fact the cordon just withheld.
 *
 * The query is the requested path's own stem, punctuation-split — a wrong
 * path is usually near-miss ("…/household.md" for "…/household_notes.md"),
 * and the FTS tokenizer wants words, not slashes. Best-effort throughout:
 * a failure here must never replace the real "not found" with a stack trace.
 */
function close_match_paths(requested: string, ctx: ToolContext): string[] {
  try {
    const stem = (requested.split('/').pop() ?? requested)
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[-_.]+/g, ' ')
      .trim();
    if (stem.length < 2) return [];
    const hits = ctx.memory.retrieve_scoped_chunks({
      query: stem,
      knowledge_scope: ['**'],
      k: 12,
      user_id: ctx.user?.id,
      user_tier: ctx.user?.tier ?? 'owner',
    });
    const paths: string[] = [];
    for (const h of hits) {
      // The requested path itself is never a useful retry.
      if (h.note_path === requested) continue;
      if (!paths.includes(h.note_path)) paths.push(h.note_path);
      if (paths.length >= 5) break;
    }
    return paths;
  } catch {
    return [];
  }
}

const InputSchema = z.object({
  note_path: z.string().min(1).max(500),
  // Cap the returned body so very long docs don't blow the model's
  // context. Higher = more context but slower. 16k is generous;
  // longer docs should be excerpted via search_library.
  max_chars: z.coerce.number().int().min(500).max(64_000).optional(),
});

const OutputSchema = z.object({
  note_path: z.string(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  body: z.string(),
  truncated: z.boolean(),
  total_chars: z.number(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/** Vault-relative paths whose bytes are an IMAGE — the refusal below points
 *  these at the vision tools by name instead of just saying "no". */
const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'tif',
]);

function extension_of(note_path: string): string {
  const base = note_path.slice(note_path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

export const read_note: Tool<Input, Output> = {
  name: 'read_note',
  description:
    "Read the FULL body of any single markdown note in the vault, given its vault-relative note_path — your own shelf, another specialist's library, People/, Decisions/, anywhere. Examples: 'Knowledge/Kate/jasper_style_profile.md', 'Knowledge/Anya/library/2026-05-19-vet-hospital-jasper-doe-bailey-0000000-visit-date-2-17-2026-p.md', 'People/Alex.md'. Returns the title, the LLM-generated summary if any, and the full markdown body. Use this when you have a specific note in mind and want the whole document — reading a reference profile, drafting a careful reply, clinical reasoning, side-by-side comparison — rather than the keyword-ranked chunks that search_library returns. NOT for fetching external URLs; that's web_fetch_clean. If you don't know the path, search_library first and use its hits.",
  risk: 'read',
  required_capabilities: ['read_vault'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    return `read_note:${input.note_path}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    const note = ctx.memory.read_note(input.note_path);
    // Per-user privacy cordon — the same ONE rule RAG retrieval applies
    // (cordon OR named grant): a user's personal note never bleeds into
    // another user's turn, and an item explicitly shared WITH them reads
    // straight through. Resolved from the live note we just read, which is
    // also the source the chunk gate uses, so search→read can't disagree.
    // Owner default preserves legacy single-user behavior when ctx.user is
    // absent (deliberation, scheduler, internal callers). Invisible === not
    // found so the error doesn't confirm the note exists.
    const visible =
      note !== null &&
      note_frontmatter_visible_to_caller(
        note.frontmatter as Record<string, unknown>,
        { user_id: ctx.user?.id, tier: ctx.user?.tier ?? 'owner' },
      );
    if (!note || !visible) {
      // Cross-namespace guess (2026-08-02). A path under a CODEBASE root
      // ("config/specialists/kate.yaml") is not a vault note and never will
      // be, so the standard "try search_library" advice sends the model to a
      // tool that searches the vault — it cannot ever resolve, and the model
      // re-guesses until DUPLICATE_TOOL_CALL or the round ceiling ends the
      // turn. Same shape as the binary-asset guard below: name the tool that
      // CAN read it, so the next move is the correct one instead of a guess.
      const rel = input.note_path.replace(/^\.?\//, '');
      if (within_allowlist(rel)) {
        throw new Error(
          `read_note: "${input.note_path}" is a path in the CODEBASE, not a ` +
            `note in the vault — read_note and search_library only ever see ` +
            `the vault, so re-trying either with this path cannot work. ` +
            `Call read_codebase_file with path="${rel}" to read it, or ` +
            `list_codebase to see what's in that directory.`,
        );
      }
      throw with_candidates(
        new Error(
          `read_note: note not found at "${input.note_path}". ` +
            `Try search_library to find the correct path.`,
        ),
        close_match_paths(input.note_path, ctx),
      );
    }

    // Binary asset guard — never hand a model raw bytes as if they were prose.
    // An image/video/archive in the vault has no indexed text, so `body` is the
    // file itself decoded as a string; a model reads that as "a document I
    // couldn't parse" and confabulates the contents rather than admitting it
    // saw nothing. The refusal names the tool that CAN read the file, so the
    // model's next move is the correct one instead of a guess.
    if (looks_binary(note.body)) {
      const is_image = IMAGE_EXTENSIONS.has(extension_of(input.note_path));
      throw new Error(
        `read_note: "${input.note_path}" is a binary asset, not a text note — ` +
          `there is no indexed text for it, and its raw bytes must NOT be ` +
          `interpreted, described, or summarized as content. ` +
          (is_image
            ? `To read what this IMAGE actually contains, call consult_deep_model ` +
              `with image_path="${input.note_path}" (the vision model genuinely ` +
              `looks at it); analyze_image and ocr_image also accept the path. `
            : '') +
          `Do not answer from what you saw here.`,
      );
    }

    const max_chars = input.max_chars ?? 16_000;
    const total_chars = note.body.length;
    const truncated = total_chars > max_chars;
    const body = truncated
      ? note.body.slice(0, max_chars) +
        `\n\n[...truncated at ${max_chars} chars; total was ${total_chars}. ` +
        `Call again with max_chars=<higher> to read more, or use search_library ` +
        `to drill into a specific section.]`
      : note.body;

    const fm = note.frontmatter as Record<string, unknown>;
    const title = typeof fm.title === 'string' ? fm.title : null;
    const summary = typeof fm.summary === 'string' ? fm.summary : null;

    return {
      note_path: input.note_path,
      title,
      summary,
      body,
      truncated,
      total_chars,
    };
  },
};

/** ToolLoader entry point. */
export function create(_deps: ToolDeps): Tool {
  return read_note as Tool;
}
