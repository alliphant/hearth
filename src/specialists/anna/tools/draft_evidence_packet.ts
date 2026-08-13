/**
 * draft_evidence_packet — Anna's deliverable. Writes a copy/print-ready
 * protest evidence packet as a markdown note in the vault under
 * Property/<parcel>/packet-<taxyear>.md, where it renders in the iOS Library
 * viewer and is searchable. This is the artifact the owner takes into the
 * informal review or the CBOE hearing.
 *
 * v1 is markdown (zero iOS work — the Library markdown viewer already renders
 * it). A bespoke evidence-packet card is a later, paired iOS build.
 *
 * Anna composes the case (curated comps, adjustments, the value to request);
 * this tool is the persistence + render primitive. Pair it with a
 * propose_action (kind 'recommendation') for the file-by-deadline nudge.
 *
 * Risk write_internal; gated by write_vault_property.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { stamp_private_to_if_needed } from '@memory/private_to';

const CompRow = z.object({
  address: z.string().max(120),
  sale_date: z.string().max(20),
  sale_price: z.number(),
  sqft: z.number().nullable().optional(),
  price_per_sf: z.number().nullable().optional(),
  adjusted_note: z.string().max(200).optional().describe('e.g. "time-adjusted to 6/30/2024; −$8k for larger lot".'),
});

const InputSchema = z.object({
  parcel_address: z.string().min(3).max(160),
  account_no: z.string().max(20).optional(),
  tax_year: z.number().int().describe('The tax year being protested, e.g. 2026.'),
  method: z.enum(['market', 'equity', 'characteristic_correction', 'mixed']).describe('Primary basis. Colorado residential is normally "market".'),
  current_actual_value: z.number().positive(),
  indicated_value: z.number().positive(),
  requested_value: z.number().positive().describe('The value Anna recommends requesting (often the indicated value, sometimes a touch above for credibility).'),
  projected_annual_tax_saving: z.number(),
  deadline: z.string().max(60).describe('The protest/abatement deadline, e.g. "Assessor protest by June 1, 2026".'),
  characteristic_corrections: z.array(z.string().max(200)).default([]).describe('County-record errors to assert, e.g. "County has 2,400 sqft; actual is 2,150 (measured)".'),
  comps: z.array(CompRow).default([]),
  adjustments_note: z.string().max(1200).optional().describe('Prose on the adjustments applied (condition, lot, age) and the market time-trend used.'),
  summary: z.string().min(10).max(1500).describe("Anna's plain-English case summary — what's wrong and what she's asking for."),
});
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
  rel_path: z.string(),
  tax_year: z.number(),
  over_assessment: z.number(),
});
type Output = z.infer<typeof OutputSchema>;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'parcel';
}
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'draft_evidence_packet',
    description:
      'Write the protest evidence packet as a markdown note in the vault (Property/<parcel>/packet-<taxyear>.md) — subject summary, characteristic corrections, the comp table (label each "time-adjusted to <appraisal date>"), the indicated value, the value to request, the projected saving, and the deadline. This is the owner\'s hearing artifact. Compose the case first (lookup_parcel → find_comps → assess_protest_case); then call this. Also file a propose_action (recommendation) for the file-by-deadline nudge.',
    risk: 'write_internal',
    required_capabilities: ['write_vault_property'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(`${input.parcel_address}\n${input.tax_year}\n${input.requested_value}`);
      return `draft_evidence_packet:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const over = Math.round(input.current_actual_value - input.indicated_value);
      const rel_path = `Property/${slug(input.parcel_address)}/packet-${input.tax_year}.md`;

      const lines: string[] = [];
      lines.push(`# Property Tax Protest — ${input.parcel_address}`);
      lines.push('');
      lines.push(`**Tax year:** ${input.tax_year}  ·  **Basis:** ${input.method}  ·  **Deadline:** ${input.deadline}`);
      if (input.account_no) lines.push(`**Account:** ${input.account_no}`);
      lines.push('');
      lines.push('## Summary');
      lines.push(input.summary);
      lines.push('');
      lines.push('## The numbers');
      lines.push('');
      lines.push('| | Value |');
      lines.push('|---|---|');
      lines.push(`| County actual value | ${usd(input.current_actual_value)} |`);
      lines.push(`| Indicated value (comps) | ${usd(input.indicated_value)} |`);
      lines.push(`| **Requested value** | **${usd(input.requested_value)}** |`);
      lines.push(`| Over-assessment | ${usd(over)} |`);
      lines.push(`| Projected annual tax saving | ${usd(input.projected_annual_tax_saving)} |`);
      lines.push('');
      if (input.characteristic_corrections.length) {
        lines.push('## Record corrections');
        lines.push('*The county record appears wrong on the following — correcting these alone can lower the value:*');
        lines.push('');
        for (const c of input.characteristic_corrections) lines.push(`- ${c}`);
        lines.push('');
      }
      if (input.comps.length) {
        lines.push('## Comparable sales');
        lines.push('');
        lines.push('| Address | Sale date | Sale price | SqFt | $/sqft | Notes |');
        lines.push('|---|---|---|---|---|---|');
        for (const c of input.comps) {
          lines.push(
            `| ${c.address} | ${c.sale_date} | ${usd(c.sale_price)} | ${c.sqft ?? '—'} | ${c.price_per_sf != null ? '$' + c.price_per_sf : '—'} | ${c.adjusted_note ?? ''} |`,
          );
        }
        lines.push('');
      }
      if (input.adjustments_note) {
        lines.push('## Adjustments & method');
        lines.push(input.adjustments_note);
        lines.push('');
      }
      lines.push('---');
      lines.push('*Prepared by Anna (Property & Land Specialist). Not legal advice. Verify the deadline and assessment rate against county.gov before filing.*');

      const frontmatter = {
        type: 'protest_packet',
        specialist: 'anna',
        parcel_address: input.parcel_address,
        account_no: input.account_no ?? null,
        tax_year: input.tax_year,
        method: input.method,
        current_actual_value: input.current_actual_value,
        indicated_value: input.indicated_value,
        requested_value: input.requested_value,
        projected_annual_tax_saving: input.projected_annual_tax_saving,
        over_assessment: over,
        deadline: input.deadline,
        created: (ctx.now ?? new Date()).toISOString(),
      };

      // A tax-protest packet is personal to the requesting user.
      const stamped = stamp_private_to_if_needed(
        frontmatter,
        ctx.user ? { user_id: ctx.user.id, tier: ctx.user.tier } : undefined,
      );
      deps.memory.upsert_note(rel_path, stamped, lines.join('\n'));
      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'anna',
        tool_name: 'draft_evidence_packet',
        tool_input: { parcel_address: input.parcel_address, tax_year: input.tax_year },
        execution_result: { rel_path, over_assessment: over },
      });

      return { rel_path, tax_year: input.tax_year, over_assessment: over };
    },
  };
}
