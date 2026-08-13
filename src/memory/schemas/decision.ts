import { z } from 'zod';

export const DecisionFrontmatter = z.object({
  type: z.literal('decision'),
  id: z.string().regex(/^d_[a-z0-9]{6}$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  domain: z.string().min(1),
  options_considered: z.array(z.string()).min(1),
  chosen: z.string().min(1),
  rationale: z.string().min(1),
  reversible: z.boolean(),
  related: z.array(z.string()).default([]),
  // Phase 2b — per-note visibility scope (see src/memory/private_to.ts).
  // Optional/unset preserves legacy broad visibility on existing notes.
  private_to: z.string().optional(),
});

export type Decision = z.infer<typeof DecisionFrontmatter>;
