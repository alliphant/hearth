import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool } from '@core/tool';
import type { Caller } from '@memory/private_to';
import { resolve_person_for_write } from '@core/entity_hydration';
import { create_person } from './_person_record';

const InputSchema = z.object({
  name: z.string().min(1).max(200),
  hints: z.record(z.string(), z.string()).optional(),
});

const OutputSchema = z.object({
  id: z.string().regex(/^p_[a-z0-9]{6}$/),
  note_path: z.string(),
  created: z.boolean(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export const find_or_create_person: Tool<Input, Output> = {
  name: 'find_or_create_person',
  description:
    'Find a CONTACT by name (case-insensitive), creating a minimal person note under People/ if not found. Use for any person — including a service contact you just met (plumber, contractor, realtor, doctor) or someone who works at a business; they are contacts, recorded under People/, never as a Place. To add their details (relationship, work address, phone, birthday) in the same step, prefer upsert_person_note (it creates-or-updates in one call).',
  risk: 'write_internal',
  // Specialist invocation path requires the capability; Scribe's
  // /scribe/* HTTP route bypasses the registry and ignores this field.
  required_capabilities: ['write_vault_general'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.name.toLowerCase().trim());
    return `find_or_create_person:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx): Promise<Output> {
    // Resolve smartly (exact, then the salient existing person) so a bare "Kim"
    // lands on "Kim Reyes" instead of minting a duplicate. Cordon via ctx.user.
    const caller: Caller = { user_id: ctx.user?.id, tier: (ctx.user?.tier ?? 'friend') as Caller['tier'] };
    const existing = resolve_person_for_write(ctx.memory, input.name, caller);
    if (existing) {
      return {
        id: existing.id,
        note_path: existing.note_path,
        created: false,
      };
    }

    // create_person owns the id/filename/frontmatter/stamp shape (shared with
    // upsert_person_note's create-or-update branch). upsert_note merges into an
    // existing file; if the name already existed an explicit prior `private_to`
    // wins (the stamp helper won't override it).
    const { id, note_path } = create_person(ctx, input.name, input.hints?.relationship);
    return { id, note_path, created: true };
  },
};
