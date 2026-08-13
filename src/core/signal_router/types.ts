/**
 * Signal router seam (2026-06-20) — the forward-looking contract for the
 * generalized "any source feeds one router" spine.
 *
 * PHASE 1 scope: this file is the SEAM only. The first concrete source is
 * mail orders, fanned into the Household Knowledge Graph by
 * `HouseholdGraphDriver` (src/core/household_knowledge/driver.ts), which
 * subscribes to the `order_upserted` AppEvent. Cordelia's capture pipeline is
 * the second real source (already live via ReactiveInboxDriver). PHASE 2
 * extracts the generic cluster→classify→fan-out→intake driver from those two
 * real sources — the principled moment to abstract (two data points, not zero).
 *
 * Until then these types document the shared shape every source converges on,
 * so Phase 2's router and the existing Cordelia `CordeliaRoutingDecision` /
 * `IntakeHandlerInput` can be unified without a redesign.
 */

/** A normalized unit of incoming signal from ANY source. */
export interface SignalItem {
  /** Stable id for this signal (capture_id, order_key, calendar event_id, …). */
  signal_id: string;
  /** The source that produced it. */
  source: 'capture' | 'mail_order' | 'mail' | 'calendar' | 'sighting';
  /** The user whose signal this is (drives the cordon). */
  user_id: string;
  /** Cordon value to stamp on anything derived from it. */
  private_to: string;
  /** ISO when the signal occurred. */
  occurred_at: string;
  /** Source-specific structured payload (the order, the capture decision, …). */
  payload: Record<string, unknown>;
}

/** One routing decision: a (signal, specialist) destination + why. Mirrors
 *  CordeliaRoutingDecision so Phase 2 can unify them. */
export interface SignalRoutingDecision {
  signal_id: string;
  specialist_id: string;
  confidence: number;
  reason: string;
  /** Independent evidence this route rests on (the multi-route fan-out gate
   *  keys on substrate distinctness — see filter_secondary_routes). */
  signal_substrate?: string;
}
