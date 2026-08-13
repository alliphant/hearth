/**
 * FlightTrackingDriver — the live half of flight tracking (2026-06-21).
 *
 * Outbound-only "instant" notice without a webhook: a 60s ticker that polls
 * every active row in `tracked_flights` on its ADAPTIVE cadence (cadence_ms),
 * diffs the fresh status against the stored snapshot, and pushes the watching
 * user the moment a meaningful field flips — delay, takeoff, landing, gate
 * change, baggage belt, cancellation, diversion. The per-minute tick is the
 * latency floor (≈ "told within a minute"); sub-window polling only fires in
 * the departure/arrival windows so quota stays small.
 *
 * Mirrors MailIdleDriver: DARK by default (`attach()` is a no-op unless
 * HEARTH_FLIGHT_TRACKING=1), fail-open per flight (a throwing poll is logged +
 * skipped, never aborts the tick or the boot), `stop()` clears the timer.
 *
 * v1 surfaces events via push only (the cordon-correct push_text_to_user). The
 * pickup-timing fusion (wake a deliberation to re-time the airport run on a
 * delay) + an AppEvent for a Friends/Travel office tab are phase-2 hooks.
 */
import { Database } from 'bun:sqlite';
import type { AppEventBus } from '@app/events';
import { format_short_datetime } from '@core/time';
import { push_text_to_user } from '@policy/push';
import {
  TrackedFlightsStore,
  type TrackedFlight,
  type TrackedFlightSnapshot,
} from '@memory/stores/flights';
import {
  fetch_flight_status,
  is_due,
  diff_events,
  snapshot_columns,
  type FlightEvent,
  type FlightSnapshot,
} from '@connectors/flights';

export function flight_tracking_enabled(): boolean {
  return process.env.HEARTH_FLIGHT_TRACKING === '1';
}
function env_ms(name: string, def: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const MIN = 60_000;

export class FlightTrackingDriver {
  private readonly store: TrackedFlightsStore;
  private readonly tick_ms: number;
  private readonly poll_gap_ms: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private running = false;

  constructor(
    private readonly deps: { db: Database; events?: AppEventBus },
    opts: { tick_ms?: number; poll_gap_ms?: number } = {},
  ) {
    this.store = new TrackedFlightsStore(deps.db);
    this.tick_ms = opts.tick_ms ?? env_ms('HEARTH_FLIGHT_TICK_MS', MIN);
    // AeroDataBox BASIC rate-limits to ~1 request/second — space sequential
    // polls in a tick so two due flights don't 429 each other.
    this.poll_gap_ms = opts.poll_gap_ms ?? env_ms('HEARTH_FLIGHT_POLL_GAP_MS', 1100);
  }

  /** Wire at boot. No-op unless HEARTH_FLIGHT_TRACKING=1. Returns a stop fn. */
  attach(): () => void {
    if (!flight_tracking_enabled()) {
      console.log('[flights] FlightTrackingDriver disabled (HEARTH_FLIGHT_TRACKING≠1)');
      return () => {};
    }
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.tick_ms);
    console.log(`[flights] FlightTrackingDriver attached (tick ${Math.round(this.tick_ms / 1000)}s)`);
    return () => this.stop();
  }

  /** One pass: poll every due active flight, fail-open per row. Exported shape
   *  re-entrancy-guarded so a slow poll can't overlap the next tick. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const due = this.store.list_active().filter((r) => is_due(r, now));
      for (let i = 0; i < due.length; i++) {
        if (i > 0 && this.poll_gap_ms > 0) await sleep(this.poll_gap_ms); // 1 req/sec
        try {
          await this.poll_one(due[i]!, now);
        } catch (err) {
          console.error(`[flights] poll failed for ${due[i]!.flight_no} (${due[i]!.id}):`, err);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async poll_one(row: TrackedFlight, now: Date): Promise<void> {
    const result = await fetch_flight_status(row.flight_no, row.flight_date);
    if (!result.found || !result.flights[0]) {
      // Empty/errored poll — a transient rate-limit (429), a provider blip, or
      // a future flight not yet in the feed. Advance the poll clock but NEVER
      // wipe a known snapshot: wiping would reset the baseline and SUPPRESS the
      // next real event (the diff would see nulls and stay silent).
      this.store.touch_polled(row.id, now.toISOString());
      return;
    }
    const fresh = result.flights[0];
    const events = diff_events(row, fresh);
    this.store.apply_snapshot(row.id, snapshot_columns(fresh), now.toISOString());
    if (events.length > 0) {
      this.store.mark_event(row.id, now.toISOString());
      for (const ev of events) {
        await this.notify(row, ev, fresh);
      }
    }
    this.maybe_retire(row.id, fresh, now);
  }

  private async notify(row: TrackedFlight, ev: FlightEvent, snap: FlightSnapshot): Promise<void> {
    const text = format_event(row, ev, snap);
    const severity = ev.kind === 'delayed' || ev.kind === 'cancelled' || ev.kind === 'diverted' ? 'high' : 'medium';
    try {
      const res = await push_text_to_user(row.user_id, text, { kind: 'ad_hoc', severity });
      console.log(`[flights] ${row.flight_no} ${ev.kind} → ${row.user_id} (${res.delivered ? res.via ?? 'sent' : res.error})`);
    } catch (err) {
      console.error(`[flights] push failed for ${row.flight_no}:`, err);
    }
  }

  /** Retire a finished watch so it stops consuming quota. */
  private maybe_retire(id: string, snap: FlightSnapshot, now: Date): void {
    if (snap.phase === 'landed') {
      const arr = snap.arrival.revised_utc ?? snap.arrival.scheduled_utc;
      const stale = arr ? now.getTime() - new Date(arr).getTime() > 90 * MIN : false;
      if (snap.arrival.baggage_belt || stale) this.store.retire(id, now.toISOString());
      return;
    }
    if (snap.phase === 'canceled' || snap.phase === 'diverted') {
      // Keep an hour for any follow-up, then retire. last_event_at was just set.
      const fresh = this.store.get(id);
      const last = fresh?.last_event_at;
      if (last && now.getTime() - new Date(last).getTime() > 60 * MIN) {
        this.store.retire(id, now.toISOString());
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Human push text per event. Times render in the default household tz (v1);
 *  per-user tz is a refinement once the driver resolves UserRegistry. */
function format_event(row: TrackedFlight, ev: FlightEvent, snap: FlightSnapshot): string {
  const no = row.label ? `${row.flight_no} (${row.label})` : row.flight_no;
  const dep = snap.departure.airport_iata ?? row.dep_iata ?? '';
  const arr = snap.arrival.airport_iata ?? row.arr_iata ?? '';
  const eta = snap.arrival.revised_utc ?? snap.arrival.scheduled_utc;
  const eta_s = eta ? format_short_datetime(eta) : '';
  switch (ev.kind) {
    case 'departed':
      return `✈️ ${no} has departed ${dep}${arr ? ` → ${arr}` : ''}${eta_s ? `, ETA ${eta_s}` : ''}.`;
    case 'landed':
      return `🛬 ${no} has landed at ${arr}${snap.arrival.gate ? ` (gate ${snap.arrival.gate})` : ''}.`;
    case 'delayed':
      return `⏱️ ${no} is delayed${eta_s ? ` — now arriving ${eta_s}` : ''} (${ev.detail}).`;
    case 'eta_moved':
      return `⏱️ ${no} ETA updated${eta_s ? ` — now ${eta_s}` : ''} (${ev.detail}).`;
    case 'gate_change':
      return `🚪 ${no}: ${ev.detail}.`;
    case 'baggage':
      return `🧳 ${no} bags at ${arr} — ${ev.detail}.`;
    case 'cancelled':
      return `❌ ${no} (${dep}${arr ? `→${arr}` : ''}) has been canceled.`;
    case 'diverted':
      return `↪️ ${no} has been diverted to ${arr}.`;
    default:
      return `${no}: ${ev.detail}`;
  }
}

// Re-export for the smoke / future callers.
export type { TrackedFlightSnapshot };
