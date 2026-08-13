/**
 * record_home_improvement — the owner tells Anna about a feature/upgrade
 * they've added (or plan to add) to the house, so she can factor it into
 * value. The your county roll never reflects a finished basement, new HVAC, a
 * solar array, a renovated kitchen — so estimate_market_value needs the
 * owner's own ground truth. This is the write side of that channel; the
 * improvements surface in Anna's office and adjust her market estimate.
 *
 * Anna may fill `est_value_add` herself from her ROI knowledge (Remodeling
 * Cost-vs-Value, NREL solar, local comps) — or leave it null and research it.
 */

import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import { getCountyAssessorStore } from '@memory/stores/assessor_county';
import { getPropertyHistoryStore } from '@memory/stores/property_history';

const InputSchema = z.object({
  title: z.string().min(2).describe('Short name for the improvement, e.g. "Finished basement", "New cold-climate heat pump", "13.86 kW solar array".'),
  account_no: z.string().optional().describe('your county schedule/account number. Provide this OR address.'),
  address: z.string().optional().describe('Property address (resolved to the parcel). Provide this OR account_no.'),
  category: z
    .enum(['kitchen', 'bath', 'hvac', 'solar', 'roof', 'windows', 'basement', 'addition', 'electrical', 'plumbing', 'flooring', 'landscape', 'energy', 'other'])
    .optional()
    .describe('Improvement category (drives ROI benchmarking).'),
  cost: z.number().nonnegative().optional().describe('What the owner spent, if known (USD).'),
  est_value_add: z.number().optional().describe('Estimated market value added (USD). Fill from ROI knowledge (Cost-vs-Value, solar payback, comps) when you can; omit to research later.'),
  status: z.enum(['planned', 'done']).default('done').describe('done = already completed; planned = intends to.'),
  // NOTE: no `.regex()` — a tool input_schema becomes a GBNF grammar on the
  // interactive 9B, and llama.cpp's converter mistranslates a regex `pattern`
  // and SILENTLY disables the whole tool grammar. The YYYY-MM-DD shape is
  // validated in execute() and returned as a typed message.
  date_done: z.string().optional().describe('When completed (YYYY-MM-DD), if known.'),
  note: z.string().optional().describe('Any detail — scope, materials, permit, sqft added.'),
});
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
  recorded: z.boolean(),
  message: z.string(),
  account_no: z.string().nullable(),
  address: z.string().nullable(),
  improvement_id: z.string().optional(),
  total_value_add_recorded: z.number().optional().describe('Sum of est_value_add across all completed improvements for this parcel.'),
});
type Output = z.infer<typeof OutputSchema>;

export const record_home_improvement: Tool<Input, Output> = {
  name: 'record_home_improvement',
  description:
    "Record a home improvement / added feature the OWNER reports (finished basement, new HVAC, solar, renovated kitchen, addition, etc.) so it factors into the home's value — the county roll doesn't capture these. Pass title + account_no or address; optionally category, cost, est_value_add (fill from ROI knowledge when you can), status (done|planned), date, note. The improvement appears in Anna's property office and adjusts estimate_market_value. Use this whenever the owner tells you about something they've done to the house.",
  risk: 'write_internal',
  required_capabilities: ['write_vault_property'],
  weight: 'light',
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    return `record_home_improvement:${(input.account_no ?? input.address ?? '').toLowerCase()}:${input.title.toLowerCase()}:${input.date_done ?? ''}`;
  },

  async execute(input, _ctx: ToolContext): Promise<Output> {
    // Date-shape check moved off the schema (a regex `pattern` silently
    // disables the 9B's tool grammar). Surface a typed recovery message.
    if (input.date_done && !/^\d{4}-\d{2}-\d{2}$/.test(input.date_done)) {
      return {
        recorded: false,
        message: `date_done must be YYYY-MM-DD; got "${input.date_done}". Re-call with that format, or omit it.`,
        account_no: input.account_no ?? null,
        address: input.address ?? null,
      };
    }
    const assessor = getCountyAssessorStore();
    const subject = input.account_no
      ? assessor.get_by_account(input.account_no)
      : assessor.find_by_address(input.address ?? '')[0] ?? null;

    // We still record even if the parcel can't be resolved (owner ground
    // truth shouldn't be lost), but resolving lets the office + estimate
    // tie it to the right parcel.
    const account_no = subject?.account_no ?? input.account_no ?? null;
    const address = subject?.situs_address ?? input.address ?? null;

    const store = getPropertyHistoryStore();
    const row = store.add_improvement({
      account_no,
      address,
      date_done: input.date_done ?? null,
      title: input.title,
      category: input.category ?? null,
      cost: input.cost ?? null,
      est_value_add: input.est_value_add ?? null,
      status: input.status,
      note: input.note ?? null,
    });

    const total = account_no ? store.sum_value_add(account_no) : 0;
    const addClause = input.est_value_add != null
      ? ` (est. +$${Math.round(input.est_value_add).toLocaleString()} value)`
      : '';
    const resolveNote = subject ? '' : ' (parcel not matched in the county cache — recorded anyway; re-run lookup_parcel to tie it to the roll)';

    return {
      recorded: true,
      message: `Recorded "${input.title}"${addClause} for ${address ?? 'the property'}${resolveNote}.`,
      account_no,
      address,
      improvement_id: row.id,
      total_value_add_recorded: total,
    };
  },
};
