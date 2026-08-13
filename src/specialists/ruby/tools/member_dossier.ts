/**
 * member_dossier — the to-date view of one council member, assembled from
 * every ledger Ruby keeps: roster row (main DB), voting record by topic,
 * top donors + filing totals, documented interests, and conflict flags
 * with their review status. One read instead of five, so a "tell me about
 * Councilmember X" turn grounds itself in the whole record before saying
 * a word. Every constituent row carries its source_url.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import { get_ruby_civic_store } from '@memory/stores/ruby_civic';
import { classify_civic_topic, voting_record_summary } from '../civic_analysis';

const InputSchema = z
  .object({
    member_name: z.string().min(1).max(120),
  })
  .strict();

const OutputSchema = z.object({
  ok: z.boolean(),
  member: z.string(),
  roster: z.record(z.string(), z.unknown()).nullable(),
  voting: z.record(z.string(), z.unknown()),
  recent_votes: z.array(z.record(z.string(), z.unknown())),
  top_donors: z.array(z.record(z.string(), z.unknown())),
  donations_total_usd: z.number(),
  filings: z.array(z.record(z.string(), z.unknown())),
  interests: z.array(z.record(z.string(), z.unknown())),
  conflicts: z.array(z.record(z.string(), z.unknown())),
  note: z.string().optional(),
  error: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function norm_name(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

export const member_dossier: Tool<Input, Output> = {
  name: 'member_dossier',
  description:
    "The full to-date dossier on one Pleasantville council member, from the record: roster details, voting tallies by topic with the recent cited votes, top campaign donors + totals, filing summaries, documented interests, and any conflict-of-interest flags with review status. The first call on a 'tell me about Councilmember X' question — every row carries its source_url, so the reply can cite documents, not vibes. Gaps in the dossier are the cue for extract_meeting_votes / acquire_campaign_finance, not for filling in from memory.",
  risk: 'read',
  required_capabilities: ['read_vault', 'read_civic_intel'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    return `member_dossier:${norm_name(input.member_name)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    const user_id = ctx.user?.id ?? process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
    const store = get_ruby_civic_store();
    try {
      const key = norm_name(input.member_name);
      const roster_row =
        ctx.memory.list_civic_members(user_id, false).find((m) => norm_name(m.name) === key) ?? null;
      const display = roster_row?.name ?? input.member_name;

      const all_votes = ctx.memory.list_civic_votes(user_id);
      const voting = voting_record_summary(all_votes, display);
      const recent_votes = all_votes
        .filter((v) => norm_name(v.member_name) === key)
        .slice(0, 10)
        .map((v) => ({
          item_title: v.item_title,
          topic: classify_civic_topic(v.item_title),
          vote: v.vote,
          meeting_date: v.meeting_date,
          outcome: v.outcome,
          source_url: v.source_url,
        }));

      const top_donors = store.donor_rollup({ recipient: display, limit: 10 });
      const donations_total_usd = top_donors.reduce((sum, d) => sum + d.total_usd, 0);
      const filings = store.list_filings(display);
      const interests = store.list_interests(display);
      const conflicts = store.list_conflicts({ member: display });

      const gaps: string[] = [];
      if (!roster_row) gaps.push('not in the roster (upsert_civic_member from the minutes)');
      if (voting.total_votes === 0) gaps.push('no recorded votes (extract_meeting_votes)');
      if (top_donors.length === 0 && filings.length === 0) gaps.push('no campaign-finance data (acquire_campaign_finance)');
      const note = gaps.length > 0 ? `Dossier gaps: ${gaps.join('; ')}.` : undefined;

      return {
        ok: true,
        member: display,
        roster: roster_row as unknown as Record<string, unknown> | null,
        voting: voting as unknown as Record<string, unknown>,
        recent_votes,
        top_donors: top_donors as unknown as Array<Record<string, unknown>>,
        donations_total_usd,
        filings: filings as unknown as Array<Record<string, unknown>>,
        interests: interests as unknown as Array<Record<string, unknown>>,
        conflicts: conflicts as unknown as Array<Record<string, unknown>>,
        note,
      };
    } catch (err) {
      return {
        ok: false, member: input.member_name, roster: null,
        voting: {}, recent_votes: [], top_donors: [], donations_total_usd: 0,
        filings: [], interests: [], conflicts: [],
        error: (err as Error).message,
      };
    }
  },
};
