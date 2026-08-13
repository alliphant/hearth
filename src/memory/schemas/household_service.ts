import { z } from 'zod';

/**
 * household_service — a standing vendor relationship the household pays or
 * relies on (waste/recycling, utilities, insurance, telecom, streaming,
 * mortgage, memberships…). Phase A of Kate's executive-assistant endgame
 * (2026-07-04): the STANDING-FACTS ledger that lets her reason "we HAVE
 * Republic waste service → this bill is legitimate" instead of guessing.
 *
 * A PROJECTED note type (Zod schema here + a `household_services` SQLite
 * table in structured.ts + a projector in apps/ingestor/project.ts), the
 * household_good pattern file-for-file: the vault note is the source of
 * truth (RAG-searchable via chunks paths, wikilink graph), the table is the
 * date-scannable read the bills surface + mail-triage grounding query.
 *
 * LEARNED from the mail exhaust by Kate's weekly `learn_household_services`
 * background job — deterministic recurring-sender clustering feeds ONE
 * deep-tier classification call; the MODEL decides what is a service, the
 * code only stores it (LAW #1). Manual entries are welcome too (`source:
 * 'manual'`). Notes are keyed on `vendor_anchor` (the normalized sender
 * root domain) so a re-run refreshes the same note, never duplicates.
 *
 * Shared household entity — stamps `private_to: 'household'` (the
 * People/Places shared-entity cordon).
 */
export const HouseholdServiceFrontmatter = z
  .object({
    type: z.literal('household_service'),
    id: z.string().regex(/^hs_[a-z0-9]{6,}$/),
    /** Display vendor name, e.g. "Republic Services". */
    vendor: z.string().min(1),
    /** Normalized stable anchor (the sender root domain, e.g.
     *  "republicservices.com") — the idempotency key across learner runs. */
    vendor_anchor: z.string().min(1),
    /** waste | utility | insurance | telecom | streaming | mortgage |
     *  subscription | medical | membership | other — free text, classifier-assigned. */
    category: z.string().optional(),
    /** weekly | monthly | quarterly | semiannual | annual | irregular —
     *  free text, classifier-assigned. */
    cadence: z.string().optional(),
    typical_amount_cents: z.number().int().nonnegative().optional(),
    currency: z.string().default('USD'),
    autopay: z.boolean().optional(),
    /** Short account identifier when the mail carries one (never invented). */
    account_hint: z.string().optional(),
    status: z.enum(['active', 'lapsed', 'uncertain']).default('active'),
    /** Classifier confidence 0..1. */
    confidence: z.number().min(0).max(1).optional(),
    /** Provenance — `mail:<message_id>` refs backing the record. */
    evidence_refs: z.array(z.string()).default([]),
    /** Full sender domains seen for this vendor — the triage-grounding match key. */
    sender_domains: z.array(z.string()).default([]),
    last_bill_date: z.string().optional(), // ISO date
    /** Deterministic estimate from last_bill_date + cadence — approximate by design. */
    next_due_estimate: z.string().optional(), // ISO date
    source: z.enum(['mail', 'manual']).default('mail'),
    notes: z.string().optional(),
    // Phase 2b — per-note visibility scope (see src/memory/private_to.ts).
    private_to: z.string().optional(),
  })
  .passthrough();

export type HouseholdService = z.infer<typeof HouseholdServiceFrontmatter>;
