import { z } from 'zod';

export const PlaceFrontmatter = z.object({
  type: z.literal('place'),
  id: z.string().regex(/^pl_[a-z0-9]{6}$/),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  address: z.string().optional(),
  coords: z
    .tuple([z.number(), z.number()]) // [lat, lon]
    .nullable()
    .optional(),
  category: z.string().optional(),
  ha_zone_name: z.string().nullable().optional(),
  parking_buffer_minutes: z.number().int().min(0).max(120).default(0),
  hours: z
    .record(z.string(), z.string())
    .optional(),
  phone: z.string().optional(),
  notes: z.string().optional(),
  // Phase 2b — per-note visibility scope (see src/memory/private_to.ts).
  // Optional/unset preserves legacy broad visibility on existing notes.
  private_to: z.string().optional(),
});

export type Place = z.infer<typeof PlaceFrontmatter>;
