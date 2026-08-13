import { z } from 'zod';

export const JournalEntryFrontmatter = z.object({
  type: z.literal('journal_entry'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tags: z.array(z.string()).default([]),
  mood: z.string().optional(),
  // Phase 2b — per-note visibility scope. See PrivateToValueSchema in
  // src/memory/private_to.ts. Optional/unset = legacy broad visibility
  // (preserves existing notes). New writes should opt into explicit
  // scoping via 'owner' | 'household' | '<user_id>'.
  private_to: z.string().optional(),
});

export type JournalEntry = z.infer<typeof JournalEntryFrontmatter>;
