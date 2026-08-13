/**
 * update_queue_note_status — Cordelia's post-action queue write.
 *
 * The book-candidate queue (`Knowledge/Cordelia/queue/<slug>.md`) has two
 * writers: `intake_book` files a note at `status: awaiting_decision`, and
 * the `book_candidate` proposal resolver routes Jasper's choice into
 * `queued` / `filed_for_reference` / `skipped`. Cordelia's 04:00 pass then
 * ACTS on `status: queued` rows — but until now had no way to mark a row
 * DONE once she'd acted, so a hunted-and-shelved book stayed `queued` and
 * was re-processed every night (or she'd narrate having "marked it
 * handled" with no tool behind the claim — the b3df2de fabrication shape).
 *
 * This is that missing terminal write: after she acquires a copy →
 * `acquired`; after she gives up the hunt or decides reference-only →
 * `skipped` / `filed_for_reference`. Scoped to her own queue folder and to
 * `book_candidate` notes; never touches the resolver's decision states.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { MemoryClient } from '@memory/client';
import { patch_clipping_frontmatter } from '../intake/_capture_io';

const QUEUE_PREFIX = 'Knowledge/Cordelia/queue/';

const InputSchema = z.object({
  queue_note_path: z
    .string()
    .min(1)
    .describe(
      'Vault path of the book-candidate queue note, exactly as listed in ' +
        'Knowledge/Cordelia/queue/ — e.g. ' +
        'Knowledge/Cordelia/queue/2026-06-14-the-overstory.md.',
    ),
  status: z
    .enum(['acquired', 'skipped', 'filed_for_reference', 'queued'])
    .describe(
      'The status to set AFTER you acted on a queued book this pass: ' +
        "'acquired' once a copy is shelved, 'skipped' if no copy was found " +
        "or it isn't worth chasing, 'filed_for_reference' to keep the note " +
        "without acquiring. 'queued' only to re-open one you deferred.",
    ),
  reason: z
    .string()
    .max(500)
    .optional()
    .describe('One line on why — recorded on the note for the trail.'),
});

const OutputSchema = z.object({
  queue_note_path: z.string(),
  updated: z.boolean(),
  status_before: z.string().nullable(),
  status_now: z.string(),
  /** Populated only when `updated` is false — why the write was a no-op. */
  note: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_update_queue_note_status(
  memory: MemoryClient,
): Tool<Input, Output> {
  return {
    name: 'update_queue_note_status',
    description:
      'Mark a book-candidate queue note done after your 04:00 pass acts on ' +
      "it: 'acquired' once you've shelved a copy, 'skipped' if you couldn't " +
      "find one, 'filed_for_reference' to keep only the note. This is what " +
      'stops a handled book from re-surfacing as `queued` every night — ' +
      'call it instead of claiming you handled it. Scoped to your own ' +
      'Knowledge/Cordelia/queue/ folder and to book_candidate notes.',
    risk: 'write_internal',
    required_capabilities: ['write_vault_librarian'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `update_queue_note_status:${input.queue_note_path}:${input.status}`;
    },

    async execute(input, _ctx: ToolContext): Promise<Output> {
      const path = input.queue_note_path.trim();

      // Scope guard — defense in depth over the capability gate.
      if (!path.startsWith(QUEUE_PREFIX) || !path.endsWith('.md')) {
        return {
          queue_note_path: path,
          updated: false,
          status_before: null,
          status_now: input.status,
          note: `out of scope — this tool only writes notes under ${QUEUE_PREFIX}`,
        };
      }

      const existing = memory.read_note(path);
      if (!existing) {
        return {
          queue_note_path: path,
          updated: false,
          status_before: null,
          status_now: input.status,
          note: `no queue note found at ${path} — list Knowledge/Cordelia/queue/ to confirm the exact path`,
        };
      }

      if (existing.frontmatter.type !== 'book_candidate') {
        return {
          queue_note_path: path,
          updated: false,
          status_before:
            typeof existing.frontmatter.status === 'string'
              ? existing.frontmatter.status
              : null,
          status_now:
            typeof existing.frontmatter.status === 'string'
              ? existing.frontmatter.status
              : input.status,
          note: 'not a book_candidate note — refusing to mutate it',
        };
      }

      const status_before =
        typeof existing.frontmatter.status === 'string'
          ? existing.frontmatter.status
          : null;

      patch_clipping_frontmatter(memory, path, {
        status: input.status,
        processed_at: new Date().toISOString(),
        ...(input.reason ? { processed_reason: input.reason } : {}),
      });

      return {
        queue_note_path: path,
        updated: true,
        status_before,
        status_now: input.status,
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_update_queue_note_status(deps.memory) as Tool;
}
