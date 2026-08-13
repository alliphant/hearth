/**
 * GET /api/specialists/:id/bills — the Bills office tab's data feed (Kate's
 * office, 2026-07-04 — the "lay out my bills" surface of the executive-
 * assistant endgame).
 *
 * One read over the Services & Bills ledger, shaped for a glanceable tab:
 *   - the monthly-equivalent total (what the household's standing services
 *     cost per month, summed over the rows whose cadence+amount are known),
 *   - upcoming bills (next_due_estimate within the window — ESTIMATES,
 *     rendered "around <date>" client-side, never hard due dates),
 *   - needs-attention: the anticipation probe's OPEN proposals
 *     (expected_bill_missing / service_lapsed) visible to the caller,
 *   - the active roster + the inactive tail (lapsed/uncertain).
 *
 * Generic by capability, not by name: any specialist GRANTED
 * monitor_household_services serves a Bills tab; everyone else 404s.
 * PER-REQUESTER cordon: every ledger read goes through the cordoned
 * query surface (the owner has NO god-view of a member-siloed service; a
 * friend-tier caller sees none of it — services are household/member-scoped
 * by construction), and the attention list rides the proposals queue's own
 * visible_to filter.
 *
 * Mounted at app.route('/api/specialists', …) — an EXISTING /api namespace,
 * so no nginx alternation change is needed.
 */
import { Hono } from 'hono';
import type { MemoryClient, HouseholdServiceRow } from '@memory/client';
import type { SpecialistRegistry } from '@core/specialist';
import type { ProposalsStore } from '@core/proposals';
import type { Caller } from '@memory/private_to';
import { monthly_equivalent_cents } from '@core/household_services';

export interface BillsRouterDeps {
  memory: MemoryClient;
  specialists: SpecialistRegistry;
  proposals: ProposalsStore;
}

/** How far ahead the "coming up" list looks (days). */
const UPCOMING_DAYS = 35;

const ATTENTION_KINDS = new Set(['expected_bill_missing', 'service_lapsed']);

function service_view(r: HouseholdServiceRow) {
  return {
    id: r.id,
    vendor: r.vendor,
    category: r.category,
    cadence: r.cadence,
    typical_amount_cents: r.typical_amount_cents,
    currency: r.currency,
    monthly_equivalent_cents: monthly_equivalent_cents(r),
    autopay: r.autopay === 1,
    status: r.status,
    confidence: r.confidence,
    last_bill_date: r.last_bill_date,
    next_due_estimate: r.next_due_estimate,
    note_path: r.note_path,
  };
}

export function create_bills_router(deps: BillsRouterDeps): Hono {
  const r = new Hono();

  r.get('/:id/bills', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthenticated' }, 401);
    const id = c.req.param('id');
    const specialist = deps.specialists.get(id);
    if (!specialist || !specialist.granted.has('monitor_household_services')) {
      return c.json({ error: 'no bills desk for this specialist' }, 404);
    }
    const caller: Caller = { user_id: user.id, tier: (user.tier ?? 'friend') as Caller['tier'] };
    const now = new Date();

    const active = deps.memory.query_household_services({ caller, status: 'active' });
    const lapsed = deps.memory.query_household_services({ caller, status: 'lapsed' });
    const uncertain = deps.memory.query_household_services({ caller, status: 'uncertain' });
    const upcoming = deps.memory.services_with_upcoming_bills(UPCOMING_DAYS, caller, now);

    // Monthly-equivalent total over the rows whose cadence+amount are known —
    // an HONEST partial: the response says how many rows it covers.
    let monthly_total_cents = 0;
    let monthly_total_basis = 0;
    for (const row of active) {
      const m = monthly_equivalent_cents(row);
      if (m != null) {
        monthly_total_cents += m;
        monthly_total_basis += 1;
      }
    }

    // The anticipation probe's open flags, through the queue's own cordon.
    const attention = deps.proposals
      .list({
        status: 'pending',
        specialist_id: specialist.id,
        limit: 50,
        visible_to: { user_id: caller.user_id ?? '', tier: caller.tier },
      })
      .flatMap((p) => {
        let payload: { followup_kind?: string; vendor?: string; expected_date?: string; last_heard?: string; cycles_quiet?: number };
        try {
          payload = JSON.parse(p.payload_json) as typeof payload;
        } catch {
          return [];
        }
        if (!payload.followup_kind || !ATTENTION_KINDS.has(payload.followup_kind)) return [];
        return [
          {
            proposal_id: p.id,
            kind: payload.followup_kind,
            vendor: payload.vendor ?? '',
            expected_date: payload.expected_date ?? null,
            last_heard: payload.last_heard ?? null,
            cycles_quiet: payload.cycles_quiet ?? null,
            rationale_md: p.rationale_md,
            ts_created: p.ts_created,
          },
        ];
      });

    return c.json({
      generated_at: now.toISOString(),
      monthly_total_cents,
      monthly_total_basis,
      currency: active[0]?.currency ?? 'USD',
      attention,
      upcoming: upcoming.map(service_view),
      services: active.map(service_view),
      inactive: [...lapsed, ...uncertain].map(service_view),
    });
  });

  return r;
}
