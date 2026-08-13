/**
 * household_services — THE comprehensive Services & Bills read (Phase A of
 * the executive-assistant endgame, 2026-07-04).
 *
 * ONE tool per domain concept (the all-encompassing-tools rule): query the
 * household's standing service ledger by name/category/due-window and get the
 * whole bills picture back in one call — matched services, upcoming bills,
 * and a monthly-equivalent total. Answers "do we have trash service?",
 * "lay out my bills", "what's due this month?".
 *
 * Read-only, cordoned per caller (household-stamped rows are the communal
 * ledger; a friend-tier caller sees none of it). Empty matches return the
 * known vendor roster as a recovery hint instead of a bare miss.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { MemoryClient, HouseholdServiceRow } from '@memory/client';
import type { Caller } from '@memory/private_to';
import { format_cents, monthly_equivalent_cents } from '@core/household_services';

const InputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe('Vendor or service to look for (a name fragment is fine, e.g. "republic" or "trash")'),
  category: z.string().optional().describe('Filter by category (waste, utility, insurance, telecom, streaming, …)'),
  due_within_days: z
    .number()
    .int()
    .positive()
    .max(365)
    .default(45)
    .describe('Window for the upcoming-bills picture (days from today)'),
  status: z.enum(['active', 'lapsed', 'uncertain']).optional(),
  limit: z.number().int().positive().max(100).default(25),
});

const ServiceViewSchema = z.object({
  vendor: z.string(),
  category: z.string().nullable(),
  cadence: z.string().nullable(),
  typical_amount: z.string().nullable(),
  autopay: z.boolean().nullable(),
  status: z.string(),
  confidence: z.number().nullable(),
  account_hint: z.string().nullable(),
  last_bill_date: z.string().nullable(),
  next_due_estimate: z.string().nullable(),
});
const OutputSchema = z.object({
  services: z.array(ServiceViewSchema),
  upcoming_bills: z.array(
    z.object({ vendor: z.string(), due_estimate: z.string(), typical_amount: z.string().nullable() }),
  ),
  /** Sum of active services normalized to a month — the "lay out my bills" line. */
  monthly_total_estimate: z.string().nullable(),
  /** Recovery hint: when a query matches nothing, the vendors the ledger DOES know. */
  known_vendors: z.array(z.string()).optional(),
  note: z.string().optional(),
});
type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function to_view(r: HouseholdServiceRow): z.infer<typeof ServiceViewSchema> {
  return {
    vendor: r.vendor,
    category: r.category,
    cadence: r.cadence,
    typical_amount: r.typical_amount_cents != null ? format_cents(r.typical_amount_cents, r.currency) : null,
    autopay: r.autopay == null ? null : r.autopay === 1,
    status: r.status,
    confidence: r.confidence,
    account_hint: r.account_hint,
    last_bill_date: r.last_bill_date,
    next_due_estimate: r.next_due_estimate,
  };
}

function matches_query(r: HouseholdServiceRow, q: string): boolean {
  const hay = `${r.vendor} ${r.vendor_anchor} ${r.category ?? ''}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .some((tok) => hay.includes(tok));
}

export function make_household_services(deps: { memory: MemoryClient }): Tool<Input, Output> {
  return {
    name: 'household_services',
    description:
      'The household Services & Bills ledger — standing vendor relationships learned from the mail exhaust (waste, utilities, insurance, telecom, subscriptions, …). Query by vendor/category/due window; returns matched services plus the bills picture (upcoming due estimates + a monthly-equivalent total). Use for "do we have X service?", "lay out my bills", "what is due soon?".',
    risk: 'read',
    required_capabilities: ['monitor_household_services'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `household_services:${input.query ?? ''}:${input.category ?? ''}:${input.status ?? ''}:${input.due_within_days}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      // ToolContext contract: absence of ctx.user = legacy owner-default.
      const caller: Caller = ctx.user
        ? { user_id: ctx.user.id, tier: ctx.user.tier }
        : { user_id: 'owner', tier: 'owner' };
      const now = ctx.now ?? new Date();
      const tz = ctx.user?.timezone;

      const all = deps.memory.query_household_services({
        caller,
        status: input.status,
        category: input.category,
        limit: 100,
      });
      const matched = input.query ? all.filter((r) => matches_query(r, input.query!)) : all;
      const services = matched.slice(0, input.limit).map(to_view);

      const upcoming = deps.memory
        .services_with_upcoming_bills(input.due_within_days, caller, now, tz)
        .map((r) => ({
          vendor: r.vendor,
          due_estimate: r.next_due_estimate ?? '',
          typical_amount: r.typical_amount_cents != null ? format_cents(r.typical_amount_cents, r.currency) : null,
        }));

      const monthly = all
        .filter((r) => r.status === 'active')
        .map((r) => monthly_equivalent_cents(r))
        .filter((c): c is number => c != null);
      const monthly_total = monthly.length
        ? format_cents(monthly.reduce((a, b) => a + b, 0))
        : null;

      const out: Output = {
        services,
        upcoming_bills: upcoming,
        monthly_total_estimate: monthly_total,
      };
      if (input.query && services.length === 0) {
        out.known_vendors = all.map((r) => r.vendor).slice(0, 25);
        out.note =
          all.length === 0
            ? 'The service ledger is empty so far — it fills from the weekly mail learner (or tell me a service and I can note it).'
            : `No service matched "${input.query}" — the ledger currently knows the vendors in known_vendors. Due estimates are approximate (derived from cadence), not hard due dates.`;
      } else if (services.length > 0) {
        out.note = 'next_due_estimate values are cadence-derived ESTIMATES, not verified due dates — say "around" when relaying them.';
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kate',
        tool_name: 'household_services',
        tool_input: { ...input },
        execution_result: { matched: services.length, upcoming: upcoming.length },
        ...(ctx.user ? { user_id: ctx.user.id } : {}),
      });

      return out;
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_household_services({ memory: deps.memory }) as Tool;
}
