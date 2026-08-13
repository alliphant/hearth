/**
 * scan_expected_bills — Kate anticipates from the Services & Bills ledger
 * (executive-assistant endgame Phase C, 2026-07-04).
 *
 * The EXPECTED-but-missing probe: Phase A learned the household's standing
 * vendor relationships (cadence, last bill, typical amount); this job notices
 * what DIDN'T happen — "the Cox bill usually lands around the 12th and
 * hasn't" — plus the lapse edge (a service whose mail has gone quiet for
 * multiple cycles → offer to mark it lapsed). The scan_calendar_followups
 * probe idiom exactly: a deterministic background job (edge dedup must
 * survive multi-day windows + restarts), `exists_for_signature` once-only
 * filing, cordon-scoped advisory `action_proposal`s (execution_kind 'none' —
 * the owner's tap is the floor; deciding accrues Trust-Ladder XP).
 *
 * Deterministic by design — pure cadence math (`detect_bill_edges` in
 * household_services.ts) over the ledger + per-root-domain mail recency; no
 * LLM. Every rendered date is a cadence-derived ESTIMATE and is phrased
 * "usually lands around", never "overdue" (the ledger's standing rule).
 * Suppression is conservative: ANY inbound vendor mail this cycle mutes the
 * missing-bill edge — a proactive surface must under-offer.
 *
 * DARK behind HEARTH_BILL_ANTICIPATION. NOT on Kate's LLM surfaces — the
 * background_jobs runner invokes it by name (daily 08:35; manual catch-up:
 * POST /api/specialists/kate/fire_background_job?name=expected_bills).
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { MemoryClient } from '@memory/client';
import type { ProposalsStore } from '@core/proposals';
import { MailStore } from '@memory/stores/mail';
import {
  build_last_mail_by_root,
  detect_bill_edges,
  format_cents,
  type BillEdge,
} from '@core/household_services';

/** Kill switch — DARK by default; the anticipation probe over the ledger. */
export function bill_anticipation_enabled(): boolean {
  return process.env.HEARTH_BILL_ANTICIPATION === '1';
}

/** How far back the mail-recency read looks (covers annual cadences ×2.5). */
const MAIL_LOOKBACK_DAYS = 950;

const InputSchema = z.object({});
const OutputSchema = z.object({
  enabled: z.boolean(),
  services: z.number(),
  edges: z.number(),
  filed: z.number(),
  proposal_ids: z.array(z.string()),
});
type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/** household/owner-scoped service → owner-global proposal (null). */
function cordon_user(private_to: string | null): string | null {
  if (!private_to || private_to === 'household' || private_to === 'owner') return null;
  return private_to;
}

function rationale_for(edge: BillEdge): string {
  if (edge.kind === 'missing_bill') {
    const amount =
      edge.typical_amount_cents != null
        ? ` (~${format_cents(edge.typical_amount_cents, edge.currency)} ${edge.cadence})`
        : '';
    return (
      `The **${edge.vendor}** bill usually lands around ${edge.expected_date}${amount} ` +
      `and hasn't shown up yet. Want me to keep an eye out and flag it if nothing arrives, ` +
      `or is it worth checking the account?`
    );
  }
  return (
    `**${edge.vendor}** has gone quiet — nothing since ${edge.last_heard} ` +
    `(about ${edge.cycles_quiet} cycles for a ${edge.cadence} service). ` +
    `Mark it lapsed in the ledger, or did it move to a different sender?`
  );
}

export interface ScanExpectedBillsDeps {
  memory: MemoryClient;
  proposals: ProposalsStore;
  mail: Pick<MailStore, 'latest_inbound_by_sender'>;
}

export function make_scan_expected_bills(deps: ScanExpectedBillsDeps): Tool<Input, Output> {
  return {
    name: 'scan_expected_bills',
    description:
      'Background job: walk the Services & Bills ledger for EXPECTED-but-missing ' +
      'bills (cadence says one should have landed, no vendor mail this cycle) and ' +
      'gone-quiet services, filing once-only advisory proposals. Not a chat tool.',
    risk: 'write_internal',
    required_capabilities: ['monitor_household_services'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key() {
      return `scan_expected_bills:${Math.floor(Date.now() / 60_000)}`;
    },

    async execute(_input: Input, ctx: ToolContext): Promise<Output> {
      if (!bill_anticipation_enabled()) {
        return { enabled: false, services: 0, edges: 0, filed: 0, proposal_ids: [] };
      }
      const services = deps.memory.services_for_bill_scan();
      const since = new Date(
        ctx.now.getTime() - MAIL_LOOKBACK_DAYS * 86_400_000,
      ).toISOString();
      let last_mail_by_root = new Map<string, string>();
      try {
        last_mail_by_root = build_last_mail_by_root(deps.mail.latest_inbound_by_sender(since));
      } catch {
        /* mail store absent — cadence math still runs off last_bill_date;
           suppression just has less evidence (missing-bill edges may fire
           that vendor mail would have muted; still advisory-only) */
      }

      const edges = detect_bill_edges(services, last_mail_by_root, ctx.now, ctx.user?.timezone);
      const proposal_ids: string[] = [];
      for (const edge of edges) {
        // Stable per-edge anchor: one proposal per (service, expected cycle) /
        // per (service, quiet-since) — a re-run or a later day in the same
        // window never re-files; a NEW cycle or a re-lapse after recovery does.
        const anchor =
          edge.kind === 'missing_bill'
            ? `${edge.service_id}:missing:${edge.expected_date}`
            : `${edge.service_id}:lapsed:${edge.last_heard}`;
        const signature = {
          specialist_id: 'kate',
          kind: 'action_proposal',
          category: edge.kind === 'missing_bill' ? 'expected_bill_missing' : 'service_lapsed',
          anchor,
        };
        if (deps.proposals.exists_for_signature(signature)) continue;
        try {
          const pid = deps.proposals.create({
            specialist_id: 'kate',
            kind: 'action_proposal',
            user_id: cordon_user(edge.private_to),
            execution_kind: 'none',
            payload: {
              followup_kind: signature.category,
              service_id: edge.service_id,
              vendor: edge.vendor,
              note_path: edge.note_path,
              cadence: edge.cadence,
              ...(edge.kind === 'missing_bill'
                ? {
                    expected_date: edge.expected_date,
                    days_late: edge.days_late,
                    ...(edge.typical_amount_cents != null
                      ? { typical_amount_cents: edge.typical_amount_cents, currency: edge.currency }
                      : {}),
                  }
                : {
                    last_heard: edge.last_heard,
                    quiet_days: edge.quiet_days,
                    cycles_quiet: edge.cycles_quiet,
                  }),
              verb: 'review',
            },
            rationale: rationale_for(edge),
            signature,
          });
          proposal_ids.push(pid);
        } catch {
          /* fail-open — one bad row never aborts the sweep */
        }
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kate',
        tool_name: 'expected_bills_scan',
        tool_input: {},
        execution_result: { services: services.length, edges: edges.length, filed: proposal_ids.length },
      });

      return {
        enabled: true,
        services: services.length,
        edges: edges.length,
        filed: proposal_ids.length,
        proposal_ids,
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_scan_expected_bills({
    memory: deps.memory,
    proposals: deps.proposals,
    mail: new MailStore(deps.db),
  }) as Tool;
}
