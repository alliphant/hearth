/**
 * Ruby (#2) — record/refresh a Pleasantville elected official in the
 * structured civic_members ledger. Idempotent on the normalized name, so
 * re-recording across passes refreshes role/term rather than duplicating.
 * Pair with record_civic_vote to build a queryable voting history.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import { is_plausible_member_name } from '../civic_analysis';

const InputSchema = z
  .object({
    name: z.string().min(1).max(120),
    role: z.string().max(80).optional(),
    district: z.string().max(80).optional(),
    term: z.string().max(120).optional(),
    active: z.boolean().default(true),
    notes: z.string().max(2_000).optional(),
    source_url: z.string().url().max(500).optional(),
  })
  .strict();

const OutputSchema = z.object({
  ok: z.boolean(),
  id: z.string().optional(),
  error: z.string().optional(),
  recovery_hint: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function member_key(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

export const upsert_civic_member: Tool<Input, Output> = {
  name: 'upsert_civic_member',
  description:
    "Record or update a Pleasantville council member / elected official in the civic ledger (role, district/seat, term). Idempotent on the name. Building this roster is what lets you answer 'how did Councilmember X vote on Y' once votes are recorded via record_civic_vote.",
  risk: 'write_internal',
  required_capabilities: ['write_vault_general'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    return `upsert_civic_member:${member_key(input.name)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    const user_id = ctx.user?.id ?? process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
    // The roster is the spine of every receipts read (member_dossier,
    // voting_record, council_alignment). A scraped heading landing here as a
    // "member" poisons all of them — the live roster held exactly two such
    // rows ("Councilmember", "City Council") and Chris Barrett's dossier came
    // back empty because of it. Reject the heading, name the fix.
    if (!is_plausible_member_name(input.name)) {
      return {
        ok: false,
        error:
          `"${input.name}" is a role or body, not a person's name — it looks like an ` +
          `agenda heading rather than a councilmember.`,
        recovery_hint:
          'Read the actual name off the minutes (e.g. "Chris Barrett") and re-call. ' +
          'If the document only says "Councilmember" without a name, skip the row — ' +
          'an unnamed vote cannot enter the record.',
      };
    }
    try {
      const id = ctx.memory.upsert_civic_member({
        user_id,
        name: input.name,
        role: input.role ?? null,
        district: input.district ?? null,
        term: input.term ?? null,
        active: input.active,
        notes: input.notes ?? null,
        source_url: input.source_url ?? null,
        dedup_key: member_key(input.name),
      });
      return { ok: true, id };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};
