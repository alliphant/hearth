/**
 * query_civic_finance — read back the money-and-interests side of Ruby's
 * civic ledger (the companion to query_civic_ledger, which reads votes /
 * roster / watch timelines from the main DB). One sectioned read tool so
 * the surface stays small:
 *
 *   donations    — itemized contributions (filter recipient / donor / cycle)
 *   donor_rollup — per-(recipient, donor) totals: the "top donors" view
 *   filings      — per-period committee summaries
 *   interests    — documented member ties
 *   conflicts    — conflict-of-interest flags with their review status
 *   coverage     — per-member stock-take: votes recorded × donations ×
 *                  interests × open flags. The "where is the ledger thin"
 *                  read that starts a deliberation pass.
 *
 * Every row carries its source_url — cite the document, not the table.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import { get_ruby_civic_store, civic_slug } from '@memory/stores/ruby_civic';

const InputSchema = z
  .object({
    section: z.enum(['donations', 'donor_rollup', 'filings', 'interests', 'conflicts', 'coverage']),
    /** donations/donor_rollup: the recipient; filings/interests/conflicts: the member. */
    member: z.string().max(120).optional(),
    donor: z.string().max(160).optional(),
    election_cycle: z.string().max(24).optional(),
    /** conflicts: filter by review status. */
    status: z.enum(['flagged', 'reviewed', 'substantiated', 'cleared']).optional(),
    limit: z.number().int().min(1).max(200).default(40),
  })
  .strict();

const OutputSchema = z.object({
  ok: z.boolean(),
  section: z.string(),
  count: z.number(),
  rows: z.array(z.record(z.string(), z.unknown())),
  note: z.string().optional(),
  error: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export const query_civic_finance: Tool<Input, Output> = {
  name: 'query_civic_finance',
  description:
    "Read Ruby's civic money-and-interests ledger. section='donations' = itemized contributions (filter member/donor/cycle); 'donor_rollup' = top donors per recipient with totals; 'filings' = campaign-finance period summaries; 'interests' = documented member ties; 'conflicts' = conflict-of-interest flags + review status; 'coverage' = per-member stock-take (votes recorded × donations × interests × open flags) — the where-is-the-ledger-thin read. Every row carries its source_url; cite the document.",
  risk: 'read',
  required_capabilities: ['read_civic_intel'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    return `query_civic_finance:${input.section}:${input.member ?? ''}:${input.donor ?? ''}:${input.status ?? ''}:${input.election_cycle ?? ''}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    const store = get_ruby_civic_store();
    try {
      let rows: Array<Record<string, unknown>>;
      let note: string | undefined;

      if (input.section === 'donations') {
        rows = store.list_donations({
          recipient: input.member,
          donor: input.donor,
          election_cycle: input.election_cycle,
          limit: input.limit,
        }) as unknown as Array<Record<string, unknown>>;
      } else if (input.section === 'donor_rollup') {
        rows = store.donor_rollup({ recipient: input.member, limit: input.limit }) as unknown as Array<
          Record<string, unknown>
        >;
      } else if (input.section === 'filings') {
        rows = store.list_filings(input.member) as unknown as Array<Record<string, unknown>>;
      } else if (input.section === 'interests') {
        rows = store.list_interests(input.member) as unknown as Array<Record<string, unknown>>;
      } else if (input.section === 'conflicts') {
        rows = store.list_conflicts({
          member: input.member,
          status: input.status,
          limit: input.limit,
        }) as unknown as Array<Record<string, unknown>>;
      } else {
        // coverage — join the main-DB roster + votes with the money ledger.
        const user_id = ctx.user?.id ?? process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
        const members = ctx.memory.list_civic_members(user_id, false);
        const votes = ctx.memory.list_civic_votes(user_id);
        const vote_counts = new Map<string, number>();
        for (const v of votes) {
          const k = civic_slug(v.member_name);
          vote_counts.set(k, (vote_counts.get(k) ?? 0) + 1);
        }
        const donations = new Map(store.donations_by_recipient().map((d) => [d.recipient_slug, d]));
        const interests = new Map(store.interests_by_member().map((i) => [i.member_slug, i.n]));
        const conflicts = new Map(store.conflicts_by_member().map((c) => [c.member_slug, c.n]));
        rows = members.map((m) => {
          const slug = civic_slug(m.name);
          const d = donations.get(slug);
          return {
            member: m.name,
            role: m.role,
            active: m.active,
            votes_recorded: vote_counts.get(slug) ?? 0,
            donations_recorded: d?.n ?? 0,
            donations_total_usd: d?.total_usd ?? 0,
            distinct_donors: d?.donors ?? 0,
            interests_recorded: interests.get(slug) ?? 0,
            conflicts_open: conflicts.get(slug) ?? 0,
          };
        });
        if (rows.length === 0) {
          note =
            'No council roster recorded yet — run extract_meeting_votes (or upsert_civic_member from the minutes) to build it.';
        }
      }

      return { ok: true, section: input.section, count: rows.length, rows: rows.slice(0, input.limit), note };
    } catch (err) {
      return { ok: false, section: input.section, count: 0, rows: [], error: (err as Error).message };
    }
  },
};
