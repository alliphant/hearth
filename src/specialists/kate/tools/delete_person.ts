import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import { note_visible_to_caller, parse_private_to, type Caller } from '@memory/private_to';
import { resolve_person_for_write } from '@core/entity_hydration';
import { purge_person } from '@core/person_delete';

/**
 * delete_person — remove a CONTACT from People/ (2026-06-23). The deliberate
 * counterpart to find_or_create_person, and the fix for "there's a duplicate Kim
 * and I can't remove it." Resolves the person SMARTLY (a bare "Kim" finds the
 * right one), CORDON-checks (you can only delete a contact you can see — the
 * owner has no god-view of a siloed person), then purges the note + their
 * relationships + observations + tracked flights via the shared purge_person.
 *
 * Use when the owner asks to delete / remove a contact (a duplicate, or someone
 * they no longer want tracked). Destructive but recoverable from the vault's
 * own backups/git; never deletes more than the one resolved person.
 */
const InputSchema = z.object({
  person: z.string().min(1).max(200).describe('Who to remove — their name (e.g. "Kim") or person id (p_xxxxxx).'),
});
const OutputSchema = z.object({
  ok: z.boolean(),
  removed: z.boolean().optional(),
  person: z.string().optional(),
  note_path: z.string().optional(),
  note: z.string(),
});
type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function db_of(memory: ToolContext['memory']): Database {
  return (memory as unknown as { cfg: { db: Database } }).cfg.db;
}

export const delete_person: Tool<Input, Output> = {
  name: 'delete_person',
  description:
    'Permanently remove a CONTACT from People/ — their note, relationships, observations, and tracked flights. ' +
    'Use when the owner asks to delete or remove a person (e.g. a duplicate contact, or someone they no longer want tracked). ' +
    'Pass their name (a first name is fine) or id; it resolves the right person and removes only that one.',
  risk: 'write_internal',
  required_capabilities: ['write_vault_general'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256').update(input.person.toLowerCase().trim());
    return `delete_person:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    const caller: Caller = { user_id: ctx.user?.id, tier: (ctx.user?.tier ?? 'friend') as Caller['tier'] };
    const resolved = resolve_person_for_write(ctx.memory, input.person, caller);
    // Cordon: a person not visible to the caller reads as not-found — never a leak,
    // and never a cross-user delete.
    if (!resolved || !note_visible_to_caller(parse_private_to((resolved.frontmatter as Record<string, unknown>)?.private_to), caller)) {
      return { ok: false, note: `No contact named "${input.person}" that you can remove.` };
    }
    const name = typeof resolved.frontmatter?.name === 'string' ? (resolved.frontmatter.name as string) : input.person;
    const res = purge_person(db_of(ctx.memory), ctx.memory, { id: resolved.id, note_path: resolved.note_path });
    ctx.memory.log_action({
      intent_id: ctx.intent_id,
      agent: ctx.specialist_id ?? 'kate',
      user_id: ctx.user?.id,
      tool_name: 'delete_person',
      tool_input: { person: input.person, resolved_id: resolved.id },
      execution_result: { note_removed: res.note_removed, rows: res.rows },
    });
    return {
      ok: true,
      removed: true,
      person: name,
      note_path: resolved.note_path,
      note: `Removed ${name} from your contacts (note + relationships + tracked flights + observations).`,
    };
  },
};
