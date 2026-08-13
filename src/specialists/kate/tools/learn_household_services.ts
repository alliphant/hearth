/**
 * learn_household_services — Kate's weekly Services & Bills learner (Phase A
 * of the executive-assistant endgame, 2026-07-04).
 *
 * The standing-facts ledger is LEARNED from the mail exhaust, never typed in:
 *
 *   1. CODE (deterministic): cluster inbound mail_messages by root sender
 *      domain into recurring-sender candidates — counts, date spans, median
 *      cadence gaps, money mentions (src/core/household_services.ts).
 *   2. MODEL (ONE deep-tier call per run): judges which candidates are real
 *      household services and assigns vendor/category/cadence/typical amount/
 *      autopay/status — candidates referenced by [number] (the citations
 *      idiom; the 35B garbles free-form ids). LAW #1: the judgment is the
 *      model's; the code only stores it.
 *   3. STORE (idempotent): upsert a household_service vault note keyed on the
 *      normalized vendor anchor — a re-run refreshes the same note with fresh
 *      evidence, never duplicates. The ingestor projects it to the
 *      household_services table for the bills surface + triage grounding.
 *
 * Fail-OPEN end to end: a missed service is recoverable (next Sunday's pass
 * sees the same evidence); a bad candidate never aborts the sweep. DARK
 * behind HEARTH_HOUSEHOLD_SERVICES. Background job only — off Kate's LLM
 * surfaces; manual catch-up:
 * POST /api/specialists/kate/fire_background_job?name=learn_household_services.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { LLMRouter } from '@core/llm';
import type { MemoryClient } from '@memory/client';
import type { Database } from 'bun:sqlite';
import { MailStore } from '@memory/stores/mail';
import { stamp_private_to_if_needed } from '@memory/private_to';
import {
  household_services_enabled,
  cluster_mail_candidates,
  classify_service_candidates,
  estimate_next_due,
  format_cents,
  service_id_for,
  service_note_path,
  type ServiceCandidate,
  type ClassifiedService,
} from '@core/household_services';

const InputSchema = z.object({
  /** How far back the mail evidence window reaches. */
  window_days: z.number().int().positive().max(365).default(90),
  /** Minimum messages from one sender root before it's a candidate. */
  min_messages: z.number().int().positive().max(20).default(2),
  /** Cap on candidates handed to the classifier (one batch call). Ranked
   *  transactional-triage-first, so the cap trims marketing-volume noise,
   *  not the sparse monthly billers. */
  max_candidates: z.number().int().positive().max(60).default(32),
});
const OutputSchema = z.object({
  enabled: z.boolean(),
  messages_scanned: z.number(),
  candidates: z.number(),
  classified: z.number(),
  upserted: z.number(),
  note: z.string().optional(),
});
type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export interface LearnHouseholdServicesDeps {
  db: Database;
  memory: MemoryClient;
  llm?: LLMRouter;
}

interface ExistingServiceLine {
  vendor: string;
  vendor_anchor: string;
  category: string | null;
  cadence: string | null;
  status: string;
}

/** The ledger's current state, rendered for the classifier so it refreshes
 *  coherently instead of re-deriving from scratch. Uncordoned SYSTEM read —
 *  this is the learner's own dedup context, not a user-facing surface. */
function existing_ledger_lines(db: Database): string[] {
  try {
    const rows = db
      .prepare(
        `SELECT vendor, vendor_anchor, category, cadence, status
         FROM household_services ORDER BY vendor ASC LIMIT 100`,
      )
      .all() as ExistingServiceLine[];
    return rows.map(
      (r) =>
        `${r.vendor} (${r.vendor_anchor})${r.category ? ` — ${r.category}` : ''}${r.cadence ? `, ${r.cadence}` : ''}${r.status !== 'active' ? `, ${r.status}` : ''}`,
    );
  } catch {
    return [];
  }
}

function note_body(c: ServiceCandidate, s: ClassifiedService): string {
  const amount =
    s.typical_amount_cents != null
      ? `${format_cents(s.typical_amount_cents)}${s.cadence ? ` ${s.cadence}` : ''}`
      : '(amount unknown)';
  return (
    `# ${s.vendor}\n\n` +
    `Standing household service learned from the mail exhaust — ${amount}.\n\n` +
    `## Evidence (window ending ${c.last_date})\n` +
    `- ${c.message_count} messages from ${c.domains.join(', ')} between ${c.first_date} and ${c.last_date}\n` +
    (c.median_gap_days != null ? `- ~${c.median_gap_days} days between messages\n` : '') +
    (c.amounts_cents.length
      ? `- amounts seen: ${c.amounts_cents.slice(0, 6).map((a) => format_cents(a)).join(', ')}\n`
      : '') +
    (c.sample_subjects.length ? `- recent subjects: ${c.sample_subjects.join(' | ')}\n` : '')
  );
}

export function make_learn_household_services(deps: LearnHouseholdServicesDeps): Tool<Input, Output> {
  return {
    name: 'learn_household_services',
    description:
      'Weekly Services & Bills learner: cluster inbound mail into recurring-sender candidates, have the deep model judge which are real household services, and upsert the household_service ledger notes. Background job; not a chat tool.',
    risk: 'write_internal',
    required_capabilities: ['monitor_household_services'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,

    idempotency_key() {
      return `learn_household_services:${Math.floor(Date.now() / 60_000)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      if (!household_services_enabled()) {
        return { enabled: false, messages_scanned: 0, candidates: 0, classified: 0, upserted: 0 };
      }
      const now = ctx.now ?? new Date();

      // 1. Deterministic clustering over the evidence window (handled mail
      // included — "handled" is a digest state, not an evidence filter).
      const since = new Date(now.getTime() - input.window_days * 86_400_000).toISOString();
      const mail = new MailStore(deps.db);
      const messages = mail.recent_inbound({ since, limit: 2000, include_handled: true });
      const candidates = cluster_mail_candidates(messages, {
        min_messages: input.min_messages,
        max_candidates: input.max_candidates,
      });
      if (candidates.length === 0) {
        return {
          enabled: true,
          messages_scanned: messages.length,
          candidates: 0,
          classified: 0,
          upserted: 0,
          note: 'no recurring-sender candidates in the window',
        };
      }

      // 2. ONE deep-tier batch classification (fail-open null).
      const classified = await classify_service_candidates(
        deps.llm,
        candidates,
        existing_ledger_lines(deps.db),
      );
      if (classified === null) {
        deps.memory.log_action({
          intent_id: ctx.intent_id,
          agent: ctx.specialist_id ?? 'kate',
          tool_name: 'household_services_learn',
          tool_input: { ...input },
          execution_result: { messages_scanned: messages.length, candidates: candidates.length },
          error: 'classifier unavailable/unparseable — nothing upserted (fail-open; next weekly pass retries)',
        });
        return {
          enabled: true,
          messages_scanned: messages.length,
          candidates: candidates.length,
          classified: 0,
          upserted: 0,
          note: 'classifier unavailable — fail-open, nothing written',
        };
      }

      // 3. Idempotent note upserts keyed on the vendor anchor.
      let upserted = 0;
      for (const s of classified) {
        const c = candidates[s.ref - 1];
        if (!c) continue;
        try {
          const fm: Record<string, unknown> = {
            type: 'household_service',
            id: service_id_for(c.anchor),
            vendor: s.vendor,
            vendor_anchor: c.anchor,
            currency: 'USD',
            status: s.status,
            confidence: s.confidence,
            evidence_refs: c.evidence_refs,
            sender_domains: c.domains,
            last_bill_date: c.last_date,
            source: 'mail',
          };
          if (s.category) fm.category = s.category;
          if (s.cadence) fm.cadence = s.cadence;
          if (s.typical_amount_cents != null) fm.typical_amount_cents = s.typical_amount_cents;
          if (s.autopay !== undefined) fm.autopay = s.autopay;
          if (s.account_hint) fm.account_hint = s.account_hint;
          const due = estimate_next_due(c.last_date, s.cadence, now, ctx.user?.timezone);
          if (due) fm.next_due_estimate = due;

          // Shared household entity: a caller-carrying invocation stamps via
          // the standard helper; the background job (no ctx.user) stamps
          // 'household' explicitly — the ledger is the communal family graph.
          const stamped = stamp_private_to_if_needed(fm, ctx.user ? { user_id: ctx.user.id, tier: ctx.user.tier } : undefined, 'shared_entity');
          if (!stamped.private_to) stamped.private_to = 'household';

          deps.memory.upsert_note(service_note_path(c.anchor), stamped, note_body(c, s));
          upserted++;
        } catch (err) {
          // Fail-open — one bad candidate never aborts the sweep.
          console.error(`[household-services] upsert skip (${c.anchor}):`, err);
        }
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kate',
        tool_name: 'household_services_learn',
        tool_input: { ...input },
        execution_result: {
          messages_scanned: messages.length,
          candidates: candidates.length,
          classified: classified.length,
          upserted,
        },
      });

      return {
        enabled: true,
        messages_scanned: messages.length,
        candidates: candidates.length,
        classified: classified.length,
        upserted,
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_learn_household_services({ db: deps.db, memory: deps.memory, llm: deps.llm }) as Tool;
}
