/**
 * scan_conflicts — Ruby's deterministic conflict-of-interest sweep.
 *
 * Cross-references the recorded voting ledger (civic_votes, main DB)
 * against the money-and-interests ledger (donations donor-rollups +
 * member_interests): when a donor's or organization's DISTINCTIVE name
 * tokens appear in an agenda item a tied member voted on, a conflict_flags
 * row lands with the receipts — the donation totals/dates, the interest,
 * the vote, the citing URLs.
 *
 * No LLM, no network — pure token math (civic_analysis.match_conflicts),
 * so the same ledgers always produce the same candidates and the smoke
 * pins the behavior. Generic civic vocabulary is stopworded so "Friends of
 * Pleasantville" never "matches" the city budget; ties below the amount
 * floor are skipped as noise.
 *
 * THE OUTPUT IS A QUESTION, NOT A VERDICT. New flags land status
 * 'flagged'; Ruby's review (record_conflict_flag with an explicit status)
 * moves each to reviewed → substantiated | cleared after reading the
 * documents — and a re-scan PRESERVES that status, so a cleared flag
 * never resurrects. Scheduled weekly after the finance pull; volatile so
 * a re-scan in the same turn (after recording a new donation) re-runs.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import { get_ruby_civic_store } from '@memory/stores/ruby_civic';
import { conflict_severity, match_conflicts, type TieRecord } from '../civic_analysis';

const InputSchema = z
  .object({
    member: z.string().max(120).optional().describe('Scope the scan to one member.'),
    min_amount_usd: z
      .number()
      .min(0)
      .default(100)
      .describe('Ignore donor ties whose TOTAL to the member is below this.'),
  })
  .strict();

const OutputSchema = z.object({
  ok: z.boolean(),
  votes_scanned: z.number(),
  ties_considered: z.number(),
  candidates: z.number(),
  new_flags: z.number(),
  updated_flags: z.number(),
  note: z.string().optional(),
  error: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function norm_name(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

export const scan_conflicts: Tool<Input, Output> = {
  name: 'scan_conflicts',
  description:
    "Deterministic conflict-of-interest sweep: cross-reference the recorded voting ledger against documented donations and member interests, and flag every (member, counterparty, agenda item) where a tie's distinctive name appears in an item the member voted on. Flags land with full receipts at status 'flagged' — they are QUESTIONS for review (record_conflict_flag moves them to reviewed/substantiated/cleared; a cleared flag stays cleared through re-scans). No LLM — pure cross-reference; it can only find ties the ledgers already document, so grow them first (extract_meeting_votes, acquire_campaign_finance).",
  risk: 'write_internal',
  required_capabilities: ['read_vault', 'write_civic_intel'],
  volatile: true,
  input_schema: InputSchema,
  output_schema: OutputSchema,

  // Reporting-only: the fields are authoritative, but flags only genuine donation/vote conflicts; no conflicts is the desired outcome.
  yield: { produced: ['new_flags', 'updated_flags'], considered: ['votes_scanned'], armed: false },
  idempotency_key(input) {
    return `scan_conflicts:${input.member ?? 'all'}:${input.min_amount_usd}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    const user_id = ctx.user?.id ?? process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
    const store = get_ruby_civic_store();
    try {
      let votes = ctx.memory.list_civic_votes(user_id);
      if (input.member) {
        const key = norm_name(input.member);
        votes = votes.filter((v) => norm_name(v.member_name) === key);
      }

      // Build the tie set: donor rollups above the floor + every interest.
      const ties: TieRecord[] = [];
      for (const d of store.donor_rollup({ recipient: input.member, min_total_usd: input.min_amount_usd })) {
        const span = d.first_donated_at && d.first_donated_at !== d.last_donated_at
          ? `${d.first_donated_at} → ${d.last_donated_at}`
          : d.last_donated_at || 'date unrecorded';
        ties.push({
          member: d.recipient,
          member_slug: d.recipient_slug,
          counterparty: d.donor,
          counterparty_slug: d.donor_slug,
          basis: 'donation',
          amount_usd: d.total_usd,
          detail: `${d.donor} donated $${d.total_usd.toFixed(0)} total across ${d.n} gift(s) (${span})`,
          source_url: d.source_url,
        });
      }
      for (const i of store.list_interests(input.member)) {
        ties.push({
          member: i.member,
          member_slug: i.member_slug,
          counterparty: i.organization,
          counterparty_slug: i.org_slug,
          basis: 'interest',
          amount_usd: null,
          detail: `${i.kind.replace(/_/g, ' ')}: ${i.organization}${i.disclosed ? ' (officially disclosed)' : ' (reported)'}${i.description ? ` — ${i.description}` : ''}`,
          source_url: i.source_url,
        });
      }

      const candidates = match_conflicts(votes, ties);
      let new_flags = 0;
      let updated_flags = 0;
      for (const c of candidates) {
        const evidence_md = [
          `**Vote:** ${c.vote} on "${c.item_title}"${c.meeting_date ? ` (${c.meeting_date})` : ''}`,
          ...c.evidence.map((e) => `**Tie:** ${e}`),
          `_Matched on: ${c.matched_tokens.join(', ')} (deterministic scan)_`,
        ].join('\n');
        const verdict = store.upsert_conflict_flag({
          member: c.member,
          item_title: c.item_title,
          meeting_date: c.meeting_date,
          vote: c.vote,
          basis: c.basis,
          counterparty: c.counterparty,
          amount_usd: c.amount_usd,
          evidence_md,
          severity: conflict_severity(c),
          // No status passed — a re-scan refreshes evidence but PRESERVES
          // the review verdict (cleared stays cleared).
          source_urls: c.source_urls,
        });
        if (!verdict.stored) continue;
        if (verdict.created) new_flags++;
        else updated_flags++;
      }

      const note =
        ties.length === 0
          ? 'No documented ties to scan against — the donations/interests ledger is empty. Run acquire_campaign_finance first.'
          : candidates.length === 0
            ? 'No tie names intersect any voted item — clean scan over the current ledgers.'
            : undefined;

      ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'ruby',
        tool_name: 'scan_conflicts',
        tool_input: { member: input.member, min_amount_usd: input.min_amount_usd },
        execution_result: {
          ok: true, votes_scanned: votes.length, ties_considered: ties.length,
          candidates: candidates.length, new_flags, updated_flags,
        },
      });
      return {
        ok: true,
        votes_scanned: votes.length,
        ties_considered: ties.length,
        candidates: candidates.length,
        new_flags,
        updated_flags,
        note,
      };
    } catch (err) {
      return {
        ok: false, votes_scanned: 0, ties_considered: 0, candidates: 0,
        new_flags: 0, updated_flags: 0, error: (err as Error).message,
      };
    }
  },
};
