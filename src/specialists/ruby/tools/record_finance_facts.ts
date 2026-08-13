/**
 * Ruby's manual writers into the civic-intelligence ledger — the
 * record_facts.ts idiom: one file, three normalized-row writers, all
 * gated on `write_civic_intel`, all routed through the store's
 * plausibility gates so a misread never lands silently.
 *
 *   - record_donation        — one itemized contribution from a filing
 *                              (or reporting, with that provenance).
 *   - record_member_interest — a disclosed/reported tie: employer,
 *                              business, board seat, property, client.
 *   - record_conflict_flag   — a documented money/interest tie near a
 *                              vote. A flag is a QUESTION with receipts,
 *                              never an accusation; this tool is also how
 *                              Ruby moves a flag through review
 *                              (flagged → reviewed → substantiated |
 *                              cleared) after reading the documents.
 *
 * The acquisition pass (acquire_campaign_finance) writes the bulk; these
 * exist for the one-off facts Ruby reads in a document mid-pass.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import { get_ruby_civic_store } from '@memory/stores/ruby_civic';

function sha(parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) {
    h.update(p);
    h.update('\n');
  }
  return h.digest('hex').slice(0, 16);
}

// ── record_donation ──────────────────────────────────────────────────────────

const DonationInputSchema = z
  .object({
    recipient: z.string().min(1).max(120).describe('The candidate/member the money went to.'),
    committee: z.string().max(160).optional(),
    donor: z.string().min(1).max(160),
    donor_type: z
      .enum(['individual', 'business', 'pac', 'party', 'union', 'nonprofit', 'self', 'unknown'])
      .optional(),
    employer: z.string().max(160).optional(),
    occupation: z.string().max(120).optional(),
    amount_usd: z.number().positive(),
    donated_at: z.string().max(20).optional().describe('YYYY-MM-DD when the filing lists it.'),
    election_cycle: z.string().max(24).optional(),
    in_kind: z.boolean().default(false),
    jurisdiction: z.enum(['city', 'county', 'state', 'federal']).default('city'),
    source_kind: z.enum(['city_clerk', 'tracer', 'news', 'other']).optional(),
    /** REQUIRED — the filing/report URL the contribution was read from. */
    source_url: z.string().url().max(500),
    notes: z.string().max(500).optional(),
  })
  .strict();

const WriteOutputSchema = z.object({
  ok: z.boolean(),
  stored: z.boolean(),
  reason: z.string().optional(),
  error: z.string().optional(),
});

type DonationInput = z.infer<typeof DonationInputSchema>;
type WriteOutput = z.infer<typeof WriteOutputSchema>;

export const record_donation: Tool<DonationInput, WriteOutput> = {
  name: 'record_donation',
  description:
    "Record ONE itemized campaign contribution into Ruby's civic money ledger — donor, exact amount, date, recipient — REQUIRES source_url (the filing/report you read it from; no donation enters the record uncited). Idempotent per (recipient, donor, amount, date), so re-reading a filing refreshes rather than duplicates. Implausible amounts are rejected by the store's gate, not stored. A cycle TOTAL is not a donation — that belongs in acquire_campaign_finance's filing rows.",
  risk: 'write_internal',
  required_capabilities: ['write_civic_intel'],
  input_schema: DonationInputSchema,
  output_schema: WriteOutputSchema,

  idempotency_key(input) {
    return `record_donation:${sha([input.recipient, input.donor, String(input.amount_usd), input.donated_at ?? ''])}`;
  },

  async execute(input, _ctx: ToolContext): Promise<WriteOutput> {
    try {
      const verdict = get_ruby_civic_store().record_donation(input);
      return { ok: verdict.stored, stored: verdict.stored, reason: verdict.reason };
    } catch (err) {
      return { ok: false, stored: false, error: (err as Error).message };
    }
  },
};

// ── record_member_interest ───────────────────────────────────────────────────

const InterestInputSchema = z
  .object({
    member: z.string().min(1).max(120),
    kind: z
      .enum(['employer', 'business_ownership', 'board_seat', 'property', 'client', 'family', 'investment', 'other'])
      .default('other'),
    organization: z.string().min(1).max(160).describe('The entity the member is tied to.'),
    description: z.string().max(500).optional(),
    disclosed: z
      .boolean()
      .default(false)
      .describe('true when read from an official disclosure filing; false when uncovered by reporting.'),
    as_of: z.string().max(20).optional(),
    /** REQUIRED — the disclosure/article URL the tie was read from. */
    source_url: z.string().url().max(500),
  })
  .strict();

type InterestInput = z.infer<typeof InterestInputSchema>;

export const record_member_interest: Tool<InterestInput, WriteOutput> = {
  name: 'record_member_interest',
  description:
    "Record a council member's documented outside tie — employer, business ownership, board seat, property, client, family link — into Ruby's interests ledger. REQUIRES source_url (the disclosure filing or article). Set disclosed:true only for official disclosure documents. Idempotent per (member, kind, organization). The weekly conflict scan cross-references these against the voting record.",
  risk: 'write_internal',
  required_capabilities: ['write_civic_intel'],
  input_schema: InterestInputSchema,
  output_schema: WriteOutputSchema,

  idempotency_key(input) {
    return `record_member_interest:${sha([input.member, input.kind, input.organization])}`;
  },

  async execute(input, _ctx: ToolContext): Promise<WriteOutput> {
    try {
      const verdict = get_ruby_civic_store().upsert_interest(input);
      return { ok: verdict.stored, stored: verdict.stored, reason: verdict.reason };
    } catch (err) {
      return { ok: false, stored: false, error: (err as Error).message };
    }
  },
};

// ── record_conflict_flag ─────────────────────────────────────────────────────

const ConflictInputSchema = z
  .object({
    member: z.string().min(1).max(120),
    item_title: z.string().min(1).max(300).describe('The agenda item / vote the tie sits next to.'),
    meeting_date: z.string().max(20).optional(),
    vote: z.enum(['aye', 'nay', 'abstain', 'absent', 'recused']).optional(),
    basis: z.enum(['donation', 'interest', 'both']),
    counterparty: z.string().min(1).max(160).describe('The donor/organization creating the tie.'),
    amount_usd: z.number().positive().optional(),
    /** The receipts: name the donation(s)/interest and the vote, with dates. */
    evidence_md: z.string().min(10).max(4_000),
    severity: z.enum(['low', 'medium', 'high']).optional(),
    /** Omit to keep the current status; pass to transition a flag through
     *  review after reading the documents. */
    status: z.enum(['flagged', 'reviewed', 'substantiated', 'cleared']).optional(),
    source_urls: z.array(z.string().url().max(500)).min(1),
  })
  .strict();

const ConflictOutputSchema = z.object({
  ok: z.boolean(),
  stored: z.boolean(),
  id: z.number().optional(),
  created: z.boolean().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
});

type ConflictInput = z.infer<typeof ConflictInputSchema>;
type ConflictOutput = z.infer<typeof ConflictOutputSchema>;

export const record_conflict_flag: Tool<ConflictInput, ConflictOutput> = {
  name: 'record_conflict_flag',
  description:
    "Record or review a potential conflict of interest: a DOCUMENTED money/interest tie (basis: donation | interest | both) sitting next to a recorded vote. A flag is a question with receipts, never an accusation — evidence_md must name the specific donation/interest and the specific vote, with dates, and source_urls must cite the documents. Re-recording the same (member, counterparty, item) updates it; status is PRESERVED unless you pass it — use status to move a flag through review: 'reviewed' once you've read the documents, 'substantiated' when the tie holds up, 'cleared' when there's an innocent explanation (a cleared flag stays cleared through future scans).",
  risk: 'write_internal',
  required_capabilities: ['write_civic_intel'],
  input_schema: ConflictInputSchema,
  output_schema: ConflictOutputSchema,

  idempotency_key(input) {
    return `record_conflict_flag:${sha([input.member, input.counterparty, input.item_title, input.status ?? ''])}`;
  },

  async execute(input, _ctx: ToolContext): Promise<ConflictOutput> {
    try {
      const verdict = get_ruby_civic_store().upsert_conflict_flag(input);
      return {
        ok: verdict.stored,
        stored: verdict.stored,
        id: verdict.id,
        created: verdict.created,
        reason: verdict.reason,
      };
    } catch (err) {
      return { ok: false, stored: false, error: (err as Error).message };
    }
  },
};
