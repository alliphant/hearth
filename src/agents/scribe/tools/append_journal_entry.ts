import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import { stamp_private_to_if_needed } from '@memory/private_to';
import { local_iso_date } from '@core/time';

const InputSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  body: z.string().min(1).max(10_000),
  tags: z.array(z.string()).default([]),
});

const OutputSchema = z.object({
  note_path: z.string(),
  date: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export const append_journal_entry: Tool<Input, Output> = {
  name: 'append_journal_entry',
  description:
    'Append a body of text to the journal entry for a given date (defaults to today). Creates the journal note if missing.',
  risk: 'write_internal',
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.date ?? '');
    h.update('\n');
    h.update(input.body);
    return `journal:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input: Input, ctx: ToolContext): Promise<Output> {
    const date = input.date ?? local_iso_date(new Date(), ctx.user?.timezone);
    // Phase 2b/5 — per-user journal paths. Owner-tier (and absent caller,
    // i.e. legacy / deliberation / scheduler) stays at the canonical
    // `Journal/<date>.md` so the existing vault and ingestor projections
    // see no behavior change. Non-owner callers write to a per-user
    // subdirectory so Sam's journal doesn't merge with Jasper's day —
    // separate files, separate `private_to: <user_id>` stamps, no
    // collision possible.
    const tier = ctx.user?.tier ?? 'owner';
    const note_path =
      tier === 'owner'
        ? `Journal/${date}.md`
        : `Journal/${ctx.user!.id}/${date}.md`;

    // Ensure the journal note exists with proper frontmatter, then append a
    // timestamped block. Two writes — upsert is idempotent re: frontmatter,
    // append adds the block. The auto-stamp helper layers `private_to`
    // onto non-owner writes (owner writes pass through unchanged).
    const fm = stamp_private_to_if_needed(
      {
        type: 'journal_entry',
        date,
        tags: input.tags,
      },
      ctx.user ? { user_id: ctx.user.id, tier: ctx.user.tier } : undefined,
    );
    ctx.memory.upsert_note(
      note_path,
      fm,
      '', // empty body — append below
    );

    const tag_line =
      input.tags.length > 0
        ? `\n_Tags:_ ${input.tags.map((t) => `#${t}`).join(' ')}`
        : '';
    const ts = ctx.now.toISOString();
    const block = `### ${ts}${tag_line}\n\n${input.body}`;

    ctx.memory.append_to_note(note_path, block);

    return { note_path, date };
  },
};
