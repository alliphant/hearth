/**
 * delivery_window — the "read the room" gate for NON-URGENT proactive pushes
 * (Piece 5, 2026-06-21). A deterministic, fail-open check so an "I noticed" nudge
 * lands at a good moment instead of the instant it's generated — mid-meeting,
 * while the user is out, or right on top of the last push.
 *
 * PURE: `should_deliver_now` takes already-resolved signals and returns a
 * decision; the I/O (quiet hours via push.ts, presence via location_awareness,
 * the active meeting via the calendar snapshot, recency via the audit log) is
 * the caller's. So a smoke drives the whole matrix without a vault or a clock.
 *
 * Contracts (mirroring the rest of the proactive stack):
 *   - URGENT always delivers — severity 'high' or an interrupt is never deferred.
 *   - AWAITED work always delivers through the read-the-room signals (a
 *     completion the user is waiting on is not an interruption); quiet hours
 *     still holds it once the request has gone cold. See `is_awaited_bypass`.
 *   - A deferred push is QUEUED with a not_before (the caller queues to
 *     pending_pushes), NEVER dropped — the existing 60s sweep re-airs it.
 *   - A LOCATION-triggered nudge (welcome-home) is EXEMPT from presence-away —
 *     it's FOR the moment the user gets home.
 *   - DARK behind HEARTH_DELIVERY_WINDOW; off → the legacy quiet-hours-only gate,
 *     byte-identical. Fail-open: the wiring runs this inside a try/catch and
 *     falls through to quiet-hours-only on any error.
 */
import type { Severity } from '@policy/quiet_hours';
import { classify_home_transition, type HomeAnchor } from './home_anchor';

/** Kill switch — DARK by default (off). */
export function delivery_window_enabled(): boolean {
  return process.env.HEARTH_DELIVERY_WINDOW === '1';
}

export type DeferReason = 'quiet_hours' | 'in_meeting' | 'presence_away' | 'recency';
export type Presence = 'home' | 'away' | 'unknown';

const DEFAULT_MIN_GAP_MS = 10 * 60_000; // don't pile on within 10 min
const DEFAULT_RECHECK_MS = 20 * 60_000; // re-air delay when a defer has no known clear time

/**
 * Awaited work stays fresh for this long before quiet hours can hold it.
 * Exported because push.ts's LEGACY quiet-hours-only gate applies the same test
 * — two copies of this number would eventually disagree about when a completion
 * notice is allowed to wake the house.
 */
export const AWAITED_GRACE_MS = 30 * 60_000;

export interface DeliveryWindowContext {
  /** Push severity. 'high' ALWAYS delivers. */
  severity?: Severity;
  /** The push kind. An interrupt ALWAYS delivers. */
  kind?: string;
  /** A location-triggered nudge (welcome-home) — exempt from presence-away. */
  is_location_nudge?: boolean;
  /**
   * This notice COMPLETES work the user explicitly asked for (a media download,
   * a research dive) — the second half of a turn they started, not an
   * interruption of it. Set by the runners' report-back when the job carries a
   * real requester and a conversation. See `is_awaited_bypass` for what it skips.
   */
  is_awaited?: boolean;
  /** ms since the user's request, for the awaited freshness test. */
  awaited_age_ms?: number;
  /** How long an awaited notice may still wake the house. */
  awaited_grace_ms?: number;
  /** Quiet hours active now (resolved by the caller via push.ts's
   *  should_dispatch_now — REUSED, not reimplemented here). */
  quiet?: boolean;
  /** ISO when quiet hours end — the not_before for a quiet defer. */
  quiet_until?: string | null;
  /** The user is in a calendar event / focus block right now. */
  in_meeting?: boolean;
  /** ISO end of the active meeting — the not_before for a meeting defer. */
  meeting_ends?: string | null;
  /** Resolved presence ('unknown' → no away-defer). */
  presence?: Presence;
  /** ms since the last push to this user (undefined = none / unknown). */
  last_push_ms_ago?: number;
  /** Minimum gap between non-urgent pushes (recency window). */
  min_gap_ms?: number;
  /** Re-air delay for a defer with no known clear time. */
  recheck_ms?: number;
}

export interface DeliveryDecision {
  deliver: boolean;
  defer_reason?: DeferReason;
  /** ISO the caller should set as not_before for the queued push (when known). */
  not_before?: string | null;
}

/** Urgent pushes bypass the read-the-room gate entirely. */
function is_urgent(ctx: DeliveryWindowContext): boolean {
  return ctx.severity === 'high' || ctx.kind === 'interrupt';
}

/**
 * Awaited work skips the READ-THE-ROOM signals — in-meeting, presence-away and
 * recency all mean "you look busy," which is exactly wrong for an answer the
 * user is sitting there waiting for. On 2026-07-29 a 17-second download's "it's
 * filed" was deferred SEVEN HOURS for `in_meeting` while the owner typed "are
 * you going to let me know?" into the same thread; Kate's promise became a lie
 * because the gate could not tell a completion from an interruption.
 *
 * Quiet hours is different and is NOT skipped once the request has gone cold: a
 * deep dive fired at 23:00 that lands at 02:00 must not wake the house. Inside
 * the grace window the user demonstrably just asked, so it delivers.
 */
function is_awaited_bypass(ctx: DeliveryWindowContext): boolean {
  if (!ctx.is_awaited) return false;
  if (!ctx.quiet) return true;
  const grace = ctx.awaited_grace_ms ?? AWAITED_GRACE_MS;
  // Unknown age is treated as fresh — the runners set it, and a missing value
  // means the job just reported back through a caller that didn't measure.
  return (ctx.awaited_age_ms ?? 0) <= grace;
}

function iso_after(now: Date, ms: number): string {
  return new Date(now.getTime() + ms).toISOString();
}

/**
 * Decide whether to deliver a non-urgent push NOW, or defer it (and to when).
 * Precedence: urgent → deliver; awaited-and-fresh → deliver; then quiet hours →
 * in-meeting → presence-away → recency. The FIRST blocking signal wins, with a
 * not_before that targets when that signal is expected to clear.
 */
export function should_deliver_now(ctx: DeliveryWindowContext, now: Date = new Date()): DeliveryDecision {
  if (is_urgent(ctx)) return { deliver: true };
  if (is_awaited_bypass(ctx)) return { deliver: true };

  const recheck_ms = ctx.recheck_ms ?? DEFAULT_RECHECK_MS;

  // 1. Quiet hours (reused from push.ts) — defer until quiet end.
  if (ctx.quiet) {
    return { deliver: false, defer_reason: 'quiet_hours', not_before: ctx.quiet_until ?? iso_after(now, recheck_ms) };
  }
  // 2. In a meeting / focus block — defer until it ends (or a re-check).
  if (ctx.in_meeting) {
    return { deliver: false, defer_reason: 'in_meeting', not_before: ctx.meeting_ends ?? iso_after(now, recheck_ms) };
  }
  // 3. Presence away — general nudges only; a location nudge is FOR being away.
  if (ctx.presence === 'away' && !ctx.is_location_nudge) {
    return { deliver: false, defer_reason: 'presence_away', not_before: iso_after(now, recheck_ms) };
  }
  // 4. Recency — don't pile on within the min gap.
  const min_gap = ctx.min_gap_ms ?? DEFAULT_MIN_GAP_MS;
  if (ctx.last_push_ms_ago !== undefined && ctx.last_push_ms_ago >= 0 && ctx.last_push_ms_ago < min_gap) {
    return { deliver: false, defer_reason: 'recency', not_before: iso_after(now, min_gap - ctx.last_push_ms_ago) };
  }
  return { deliver: true };
}

/**
 * Three-state presence from a location snapshot's latest packet, conservative:
 * only 'away' when we're confident (left home, or arrived somewhere that isn't
 * home); otherwise 'unknown' (→ no away-defer). Pure (the caller passes the
 * snapshot fields + the resolved home anchor).
 *
 * Delegates to `classify_home_transition` — the ONE definition of home-ness,
 * shared with `compute_is_home` (sensors.ts) and the reactive home triggers.
 * This used to string-match `place_id === 'home'`, which live iOS payloads
 * never send, so it returned 'unknown' on every real arrival and the
 * presence-away defer never engaged (see core/home_anchor.ts).
 */
export function resolve_presence(
  snap: {
    available: boolean;
    kind: string | null;
    place_id: string | null;
    coords?: { lat: number; lon: number } | null;
  },
  home_anchor?: HomeAnchor | null,
): Presence {
  if (!snap.available) return 'unknown';
  const t = classify_home_transition(
    {
      kind: snap.kind,
      lat: snap.coords?.lat ?? null,
      lng: snap.coords?.lon ?? null,
      place_id: snap.place_id,
    },
    home_anchor ?? null,
  );
  return t?.presence ?? 'unknown';
}
