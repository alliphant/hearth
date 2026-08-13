import { z } from 'zod';

/**
 * life_event — an attributed calendar event, the second node type of the
 * Household Knowledge Graph (Phase 3, 2026-06-20). PROMOTED from AUXILIARY →
 * PROJECTED so it is BOTH RAG-searchable (chunks_fts, via the vault note) AND
 * date-scannable (the projected `life_events` table) — the foundation the
 * cross-domain reactive triggers (birthday−14d gift, vacation flights,
 * appointment prep) date-scan.
 *
 * Written by the CalendarSource (calendar_source.ts) on each iOS calendar
 * snapshot: one note per source event, idempotent on the per-event id, owner
 * ATTRIBUTED via the fusion engine (attribution.ts) and ENRICHED with typed
 * implications/participants (enrich_life_event.ts). Shared across the household
 * (it answers "whose event, when") so it stamps `private_to` from the event's
 * attributed owner: a household/family event → `household`, a member's personal
 * event → their user_id (the owner has no god-view). Mirrors the
 * household_good projection pattern exactly.
 */
export const LifeEventFrontmatter = z
  .object({
    type: z.literal('life_event'),
    id: z.string().regex(/^le_[a-z0-9]{6,}$/),
    title: z.string().min(1),
    /** birthday | anniversary | vacation | trip | appointment | meeting | other —
     *  free text (the classifier's keyword pass), kept a string for forward
     *  compatibility with new categories. */
    category: z.string().optional(),
    /** ISO date or datetime — the event start (`ts_start`). The date-scan column. */
    event_date: z.string().optional(),
    /** ISO date or datetime — the event end (`ts_end`), when present. */
    end_date: z.string().optional(),
    location: z.string().optional(),
    /** The attributed household member (user_id), when the fusion engine resolved one. */
    owner: z.string().optional(),
    /** 0..1 attribution confidence (present only when an owner was attributed). */
    attribution_confidence: z.number().optional(),
    /** Set when the fusion engine could NOT resolve an owner — Kate asks rather than assumes. */
    owner_uncertain: z.boolean().optional(),
    // ── Phase 3 enrichment (enrich_life_event.ts) ──────────────────────────
    /** Whether this event implies a follow-up action (vacation/appointment/birthday)
     *  vs being purely informational (a routine meeting). */
    actionable: z.boolean().optional(),
    /** Typed implications the enricher derived (e.g. "ask for flight details"). */
    implications: z.array(z.string()).optional(),
    /** Display names / user ids of the people the event involves (the owner +
     *  any People matched in the title); also written as typed knowledge_edges. */
    participants: z.array(z.string()).optional(),
    /** Where this record came from. */
    source: z.enum(['calendar', 'manual']).default('calendar'),
    source_event_id: z.string().optional(),
    calendar_name: z.string().optional(),
    // Phase 2b — per-note visibility scope (see src/memory/private_to.ts).
    private_to: z.string().optional(),
  })
  .passthrough();

export type LifeEvent = z.infer<typeof LifeEventFrontmatter>;
