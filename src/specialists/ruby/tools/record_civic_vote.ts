/**
 * Ruby (#2 + #4) — record a single council member's vote on an agenda item
 * into the structured civic_votes ledger. `source_url` is REQUIRED (the
 * agenda/minutes document the vote was read from): no civic vote enters the
 * record without a citation. This is the verification floor — votes aren't
 * in the meeting API, so they come from reading the document, and the
 * citation makes every recorded vote checkable.
 *
 * Idempotent on (member, item, meeting), so re-reading the same minutes
 * refreshes rather than duplicates.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';

const InputSchema = z
  .object({
    member_name: z.string().min(1).max(120),
    item_title: z.string().min(1).max(300),
    vote: z.enum(['aye', 'nay', 'abstain', 'absent', 'recused']),
    meeting_id: z.string().max(40).optional(),
    meeting_date: z.string().max(40).optional(),
    outcome: z.string().max(200).optional(),
    /** REQUIRED — the agenda/minutes URL the vote was read from. */
    source_url: z.string().url().max(500),
  })
  .strict();

const OutputSchema = z.object({
  ok: z.boolean(),
  id: z.string().optional(),
  error: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function slug(s: string, max = 60): string {
  return s.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, max);
}

export const record_civic_vote: Tool<Input, Output> = {
  name: 'record_civic_vote',
  description:
    "Record how a Pleasantville council member voted on an agenda item, into the structured voting ledger. REQUIRES source_url — the agenda/minutes document you read the vote from (votes aren't in the meeting API). Call once per (member, item). Over time this answers 'how did X vote on Y' and 'who's been consistently for/against Z'. Idempotent per member+item+meeting.",
  risk: 'write_internal',
  required_capabilities: ['write_vault_general'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    return `record_civic_vote:${slug(input.member_name, 30)}:${input.meeting_id ?? input.meeting_date ?? ''}:${slug(input.item_title, 40)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    const user_id = ctx.user?.id ?? process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
    try {
      // Resolve member_id if this person is already in the roster (best
      // effort; vote still records with the denormalized name if not).
      const member = ctx.memory
        .list_civic_members(user_id, false)
        .find((m) => m.name.toLowerCase().trim() === input.member_name.toLowerCase().trim());
      const dedup_key = `vote:${slug(input.member_name, 30)}:${input.meeting_id ?? input.meeting_date ?? 'na'}:${slug(input.item_title, 60)}`;
      const id = ctx.memory.record_civic_vote({
        user_id,
        member_id: member?.id ?? null,
        member_name: input.member_name,
        meeting_id: input.meeting_id ?? null,
        meeting_date: input.meeting_date ?? null,
        item_title: input.item_title,
        vote: input.vote,
        outcome: input.outcome ?? null,
        source_url: input.source_url,
        dedup_key,
      });
      return { ok: true, id };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};
