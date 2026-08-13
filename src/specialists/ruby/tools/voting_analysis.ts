/**
 * Ruby's deterministic voting analytics — the record, not the vibe.
 *
 *   - voting_record: one member's history grouped by topic (keyword
 *     buckets over the recorded item titles) with tallies + the recent
 *     cited votes. "How has X voted on housing, historically" answered
 *     from civic_votes rows, every one of which carries its source_url.
 *   - council_alignment: pairwise agreement between members across items
 *     they BOTH cast a substantive vote on, plus the contested items —
 *     the actual blocs and the actual splits.
 *
 * Pure math over the ledger (no LLM, no network) — see
 * ../civic_analysis.ts for the functions and the smoke that pins them.
 * Characterize a member's record from THESE reads before naming names.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import {
  alignment_matrix,
  classify_civic_topic,
  voting_record_summary,
} from '../civic_analysis';

function norm_name(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

// ── voting_record ────────────────────────────────────────────────────────────

const RecordInputSchema = z
  .object({
    member_name: z.string().min(1).max(120),
    topic: z
      .enum([
        'housing', 'land_use', 'transport', 'budget_tax', 'police_safety',
        'utilities', 'parks_natural_areas', 'climate_energy', 'governance', 'other',
      ])
      .optional()
      .describe('Narrow the recent-votes list to one topic bucket.'),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

const RecordOutputSchema = z.object({
  ok: z.boolean(),
  member: z.string(),
  total_votes: z.number(),
  aye: z.number(),
  nay: z.number(),
  recused: z.number(),
  by_topic: z.array(z.record(z.string(), z.unknown())),
  recent: z.array(z.record(z.string(), z.unknown())),
  note: z.string().optional(),
  error: z.string().optional(),
});

type RecordInput = z.infer<typeof RecordInputSchema>;
type RecordOutput = z.infer<typeof RecordOutputSchema>;

export const voting_record: Tool<RecordInput, RecordOutput> = {
  name: 'voting_record',
  description:
    "One council member's voting record, analyzed: tallies by topic (housing, transport, budget, police/safety, utilities, parks, land use, climate, governance) over every vote in the ledger, plus the recent votes with their source_url citations. This is how you answer 'how has X voted on Y, historically' — from the record. If total_votes is low, the record is thin: extract_meeting_votes on more minutes before characterizing anyone.",
  risk: 'read',
  required_capabilities: ['read_vault'],
  input_schema: RecordInputSchema,
  output_schema: RecordOutputSchema,

  idempotency_key(input) {
    return `voting_record:${norm_name(input.member_name)}:${input.topic ?? ''}:${input.limit}`;
  },

  async execute(input, ctx: ToolContext): Promise<RecordOutput> {
    const user_id = ctx.user?.id ?? process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
    try {
      // Fetch all and match on the normalized name — the SQL filter is
      // exact-equality and a case difference would silently miss.
      const all = ctx.memory.list_civic_votes(user_id);
      const summary = voting_record_summary(all, input.member_name);
      const key = norm_name(input.member_name);
      const recent = all
        .filter((v) => norm_name(v.member_name) === key)
        .map((v) => ({
          item_title: v.item_title,
          topic: classify_civic_topic(v.item_title),
          vote: v.vote,
          meeting_date: v.meeting_date,
          outcome: v.outcome,
          source_url: v.source_url,
        }))
        .filter((v) => !input.topic || v.topic === input.topic)
        .slice(0, input.limit);
      const note =
        summary.total_votes === 0
          ? `No votes recorded for "${input.member_name}" yet — check the roster spelling via query_civic_ledger(section='members'), or grow the ledger with extract_meeting_votes.`
          : summary.total_votes < 5
            ? 'Thin record — treat tallies as anecdote until more minutes are extracted.'
            : undefined;
      return { ok: true, ...summary, by_topic: summary.by_topic as unknown as Array<Record<string, unknown>>, recent, note };
    } catch (err) {
      return {
        ok: false, member: input.member_name, total_votes: 0, aye: 0, nay: 0, recused: 0,
        by_topic: [], recent: [], error: (err as Error).message,
      };
    }
  },
};

// ── council_alignment ────────────────────────────────────────────────────────

const AlignInputSchema = z
  .object({
    min_shared: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(3)
      .describe('Drop pairs sharing fewer substantive votes than this — two votes of overlap is noise, not a bloc.'),
  })
  .strict();

const AlignOutputSchema = z.object({
  ok: z.boolean(),
  members: z.array(z.string()),
  items_counted: z.number(),
  /** Sorted least-aligned first — the divisions are the story. */
  pairs: z.array(z.record(z.string(), z.unknown())),
  contested: z.array(z.record(z.string(), z.unknown())),
  note: z.string().optional(),
  error: z.string().optional(),
});

type AlignInput = z.infer<typeof AlignInputSchema>;
type AlignOutput = z.infer<typeof AlignOutputSchema>;

export const council_alignment: Tool<AlignInput, AlignOutput> = {
  name: 'council_alignment',
  description:
    'Pairwise voting alignment across the whole council, computed from the recorded ledger: for every pair of members, the % of shared substantive (aye/nay) votes where they agreed — sorted least-aligned first — plus the contested items with the actual aye/nay lineups. The deterministic answer to "who votes together" and "what actually splits this council." Absences and abstentions are excluded by design.',
  risk: 'read',
  required_capabilities: ['read_vault'],
  input_schema: AlignInputSchema,
  output_schema: AlignOutputSchema,

  idempotency_key(input) {
    return `council_alignment:${input.min_shared}`;
  },

  async execute(input, ctx: ToolContext): Promise<AlignOutput> {
    const user_id = ctx.user?.id ?? process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
    try {
      const result = alignment_matrix(ctx.memory.list_civic_votes(user_id), input.min_shared);
      const note =
        result.pairs.length === 0
          ? `No member pair shares ${input.min_shared}+ substantive votes yet — the ledger needs more meetings (extract_meeting_votes) before alignment means anything.`
          : undefined;
      return {
        ok: true,
        members: result.members,
        items_counted: result.items_counted,
        pairs: result.pairs as unknown as Array<Record<string, unknown>>,
        contested: result.contested as unknown as Array<Record<string, unknown>>,
        note,
      };
    } catch (err) {
      return { ok: false, members: [], items_counted: 0, pairs: [], contested: [], error: (err as Error).message };
    }
  },
};
