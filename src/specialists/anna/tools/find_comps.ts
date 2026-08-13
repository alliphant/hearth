/**
 * find_comps — pull comparable SALES for a subject parcel from the local
 * your county cache: arms-length (warranty-deed) sales in the statutory data
 * window, in the same subdivision, of like-kind parcels, joined to each
 * comp's characteristics (sqft, beds/baths, year) so $/sqft is available.
 *
 * Colorado residential value is market-approach-only and comps must sell
 * within the cycle's data window, time-adjusted to the appraisal date. The
 * window defaults to the 2025–2026 cycle (Jan 1 2023 – Jun 30 2024); override
 * for a different cycle. The actual time-adjustment + indicated value is the
 * job of assess_protest_case — this tool gathers the candidates.
 *
 * Risk read; gated by read_property_records.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { getCountyAssessorStore } from '@memory/stores/assessor_county';

// 2025–2026 reappraisal cycle data window (appraisal date 6/30/2024).
const CYCLE_WINDOW_START = '2023-01-01';
const CYCLE_WINDOW_END = '2024-06-30';

const InputSchema = z
  .object({
    account_no: z.string().min(3).max(20).optional().describe('Subject account/schedule number (preferred).'),
    address: z.string().min(3).max(120).optional().describe('Subject street address, if the account number is unknown.'),
    // NOTE: no `.regex()` on the window fields — a tool input_schema becomes a
    // GBNF grammar on the interactive 9B, and llama.cpp's converter
    // mistranslates a regex `pattern` and SILENTLY disables the whole tool
    // grammar. The YYYY-MM-DD shape is validated in execute() and returned as a
    // typed message.
    window_start: z.string().optional().describe(`Sale-window start (inclusive, YYYY-MM-DD). Defaults to ${CYCLE_WINDOW_START} (2025–26 cycle).`),
    window_end: z.string().optional().describe(`Sale-window end (inclusive, YYYY-MM-DD). Defaults to ${CYCLE_WINDOW_END} (appraisal date).`),
    limit: z.number().int().min(1).max(20).default(8),
  })
  .refine((v) => v.account_no || v.address, { message: 'Provide account_no or address.' });
type Input = z.infer<typeof InputSchema>;

const CompSchema = z.object({
  address: z.string(),
  sale_date: z.string(),
  sale_price: z.number(),
  sqft: z.number().nullable(),
  price_per_sf: z.number().nullable(),
  bedrooms: z.number().nullable(),
  baths: z.number().nullable(),
  year_built: z.number().nullable(),
  quality: z.string(),
  deed: z.string(),
});
const OutputSchema = z.object({
  found: z.boolean(),
  message: z.string().optional(),
  subject: z
    .object({
      address: z.string(),
      subdivision: z.string(),
      actual_value: z.number().nullable(),
      sqft: z.number().nullable(),
      year_built: z.number().nullable(),
      own_recent_sale: z
        .object({ date: z.string(), price: z.number(), deed: z.string() })
        .nullable()
        .describe("The subject's own most recent market-deed sale — pass to assess_protest_case as subject_recent_sale (strongest evidence)."),
    })
    .optional(),
  window: z.object({ start: z.string(), end: z.string() }).optional(),
  comp_count: z.number().optional(),
  comps: z.array(CompSchema).optional(),
});
type Output = z.infer<typeof OutputSchema>;

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'find_comps',
    description:
      'Find comparable arms-length sales for a your county subject parcel from the local cache — same subdivision, like-kind, within the statutory sale window (defaults to the 2025–26 cycle: Jan 2023–Jun 2024), each joined to its sqft/beds/baths/year so $/sqft is available. Feed the result to assess_protest_case to time-adjust and compute the indicated value. Call lookup_parcel first to confirm the subject.',
    risk: 'read',
    required_capabilities: ['read_property_records'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    llm_budget: 'full',

    idempotency_key(input) {
      return `find_comps:${(input.account_no ?? input.address ?? '').trim().toLowerCase()}:${input.window_start ?? ''}:${input.window_end ?? ''}:${input.limit}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      // Date-shape checks moved off the schema (a regex `pattern` silently
      // disables the 9B's tool grammar). Surface a typed recovery message.
      const ymd = /^\d{4}-\d{2}-\d{2}$/;
      const bad =
        (input.window_start && !ymd.test(input.window_start) && 'window_start') ||
        (input.window_end && !ymd.test(input.window_end) && 'window_end');
      if (bad) {
        return {
          found: false,
          message: `${bad} must be YYYY-MM-DD (or omit it to use the cycle default).`,
        };
      }
      const store = getCountyAssessorStore();
      const subject = input.account_no
        ? store.get_by_account(input.account_no)
        : store.find_by_address(input.address ?? '')[0] ?? null;

      if (!subject) {
        return { found: false, message: `Couldn't resolve the subject parcel (${input.account_no ?? input.address}). Run lookup_parcel first.` };
      }
      if (!subject.subdivision_name) {
        return {
          found: false,
          message: `Subject ${subject.situs_address} has no subdivision on record, so subdivision-matched comps aren't available. This is common for rural/acreage parcels — comp per-acre from recent land sales instead, and tell the owner the comp basis is weaker here.`,
        };
      }

      const window_start = input.window_start ?? CYCLE_WINDOW_START;
      const window_end = input.window_end ?? CYCLE_WINDOW_END;
      const comps = store.find_comps({ subject, window_start, window_end, limit: input.limit });

      // The subject's own most recent market-deed sale (warranty deed, priced) —
      // the strongest single comp; surface it for assess_protest_case.
      const own = subject.recent_sales.find(
        (s) => s.sale_price > 1000 && /warranty/i.test(s.deed_description),
      );
      const own_recent_sale = own
        ? { date: own.sale_date, price: own.sale_price, deed: own.deed_description }
        : null;

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'anna',
        tool_name: 'find_comps',
        tool_input: { account_no: subject.account_no, window_start, window_end },
        execution_result: { comp_count: comps.length },
      });

      return {
        found: true,
        subject: {
          address: subject.situs_address,
          subdivision: subject.subdivision_name,
          actual_value: subject.actual_value_total,
          sqft: subject.improvement?.sf ?? null,
          year_built: subject.improvement?.year_built ?? null,
          own_recent_sale,
        },
        window: { start: window_start, end: window_end },
        comp_count: comps.length,
        comps: comps.map((c) => ({
          address: c.situs_address,
          sale_date: c.sale_date,
          sale_price: c.sale_price,
          sqft: c.sf,
          price_per_sf: c.price_per_sf,
          bedrooms: c.bedroom_count,
          baths: c.bath_count,
          year_built: c.year_built,
          quality: c.quality,
          deed: c.deed_description,
        })),
      };
    },
  };
}
