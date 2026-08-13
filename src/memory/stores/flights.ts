/**
 * TrackedFlightsStore — the durable watch-list behind live flight tracking
 * (2026-06-21).
 *
 * One row per flight a user is watching (flight_no × departure-local-day ×
 * user). This is what makes tracking DYNAMIC rather than a one-shot lookup:
 * the `FlightTrackingDriver` ([src/core/flight_tracking.ts]) polls every active
 * row on an adaptive cadence, hash-diffs the snapshot, and pushes the user the
 * moment a meaningful field flips (delay / gate / takeoff / landing / baggage).
 *
 * Cordoned: every row carries `user_id` (== private_to). The driver pushes to
 * THAT user; the read/CRUD tools filter to the caller. `person_id` optionally
 * links the watch to a People/ note so a friend's flight surfaces on Kate's
 * Friends tab (the "almost a GUI view of a friend's data" ask).
 *
 * Self-creating table (IF NOT EXISTS), additive columns — no SCHEMA_VERSION
 * bump, mirroring the recent store idiom (system_health / presence_zones).
 */
import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';

export type FlightPhase =
  | 'scheduled'
  | 'active'
  | 'landed'
  | 'canceled'
  | 'diverted'
  | 'unknown';

/** The point-in-time status fields the driver diffs across polls. */
export interface TrackedFlightSnapshot {
  status: string | null; // raw provider status (e.g. "Departed", "Arrived")
  phase: FlightPhase;
  dep_iata: string | null;
  arr_iata: string | null;
  dep_terminal: string | null;
  dep_gate: string | null;
  arr_terminal: string | null;
  arr_gate: string | null;
  baggage_belt: string | null;
  sched_dep_utc: string | null;
  sched_arr_utc: string | null;
  est_dep_utc: string | null;
  est_arr_utc: string | null;
}

export interface TrackedFlightInput {
  flight_no: string; // normalized, e.g. "UA2245"
  flight_date: string; // YYYY-MM-DD — departure local day (AeroDataBox convention)
  user_id: string; // private_to — who is watching
  person_id?: string | null; // optional link to a People/ note (Friends tab)
  label?: string | null; // optional human label ("Sam coming home")
}

export interface TrackedFlight extends TrackedFlightInput, TrackedFlightSnapshot {
  id: string;
  created_at: string;
  last_polled_at: string | null;
  last_event_at: string | null;
  retired_at: string | null;
}

interface RawRow {
  id: string;
  flight_no: string;
  flight_date: string;
  user_id: string;
  person_id: string | null;
  label: string | null;
  status: string | null;
  phase: string | null;
  dep_iata: string | null;
  arr_iata: string | null;
  dep_terminal: string | null;
  dep_gate: string | null;
  arr_terminal: string | null;
  arr_gate: string | null;
  baggage_belt: string | null;
  sched_dep_utc: string | null;
  sched_arr_utc: string | null;
  est_dep_utc: string | null;
  est_arr_utc: string | null;
  created_at: string;
  last_polled_at: string | null;
  last_event_at: string | null;
  retired_at: string | null;
}

function to_flight(r: RawRow): TrackedFlight {
  return {
    id: r.id,
    flight_no: r.flight_no,
    flight_date: r.flight_date,
    user_id: r.user_id,
    person_id: r.person_id,
    label: r.label,
    status: r.status,
    phase: (r.phase as FlightPhase) ?? 'unknown',
    dep_iata: r.dep_iata,
    arr_iata: r.arr_iata,
    dep_terminal: r.dep_terminal,
    dep_gate: r.dep_gate,
    arr_terminal: r.arr_terminal,
    arr_gate: r.arr_gate,
    baggage_belt: r.baggage_belt,
    sched_dep_utc: r.sched_dep_utc,
    sched_arr_utc: r.sched_arr_utc,
    est_dep_utc: r.est_dep_utc,
    est_arr_utc: r.est_arr_utc,
    created_at: r.created_at,
    last_polled_at: r.last_polled_at,
    last_event_at: r.last_event_at,
    retired_at: r.retired_at,
  };
}

export class TrackedFlightsStore {
  constructor(private db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tracked_flights (
        id            TEXT PRIMARY KEY,
        flight_no     TEXT NOT NULL,
        flight_date   TEXT NOT NULL,
        user_id       TEXT NOT NULL,
        person_id     TEXT,
        label         TEXT,
        status        TEXT,
        phase         TEXT,
        dep_iata      TEXT,
        arr_iata      TEXT,
        dep_terminal  TEXT,
        dep_gate      TEXT,
        arr_terminal  TEXT,
        arr_gate      TEXT,
        baggage_belt  TEXT,
        sched_dep_utc TEXT,
        sched_arr_utc TEXT,
        est_dep_utc   TEXT,
        est_arr_utc   TEXT,
        created_at    TEXT NOT NULL,
        last_polled_at TEXT,
        last_event_at TEXT,
        retired_at    TEXT
      )
    `);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_tracked_flights_active
         ON tracked_flights (retired_at, user_id)`,
    );
  }

  /** The active watch for (flight_no, date, user), or null. */
  find_active(user_id: string, flight_no: string, flight_date: string): TrackedFlight | null {
    const row = this.db
      .prepare(
        `SELECT * FROM tracked_flights
          WHERE user_id = @user_id AND flight_no = @flight_no
            AND flight_date = @flight_date AND retired_at IS NULL
          LIMIT 1`,
      )
      .get({
        '@user_id': user_id,
        '@flight_no': flight_no,
        '@flight_date': flight_date,
      }) as RawRow | undefined;
    return row ? to_flight(row) : null;
  }

  get(id: string): TrackedFlight | null {
    const row = this.db
      .prepare(`SELECT * FROM tracked_flights WHERE id = @id`)
      .get({ '@id': id }) as RawRow | undefined;
    return row ? to_flight(row) : null;
  }

  /**
   * Open a watch (idempotent on flight_no × date × user). Returns the row and
   * whether it already existed, so the tool can say "already tracking" rather
   * than fork a duplicate.
   */
  upsert(input: TrackedFlightInput, now_iso: string): { row: TrackedFlight; already: boolean } {
    const existing = this.find_active(input.user_id, input.flight_no, input.flight_date);
    if (existing) return { row: existing, already: true };
    const id = `tf_${ulid().toLowerCase()}`;
    this.db
      .prepare(
        `INSERT INTO tracked_flights
           (id, flight_no, flight_date, user_id, person_id, label, created_at)
         VALUES (@id, @flight_no, @flight_date, @user_id, @person_id, @label, @created_at)`,
      )
      .run({
        '@id': id,
        '@flight_no': input.flight_no,
        '@flight_date': input.flight_date,
        '@user_id': input.user_id,
        '@person_id': input.person_id ?? null,
        '@label': input.label ?? null,
        '@created_at': now_iso,
      });
    return { row: this.get(id)!, already: false };
  }

  /** Every active (non-retired) row — the driver's poll set. */
  list_active(): TrackedFlight[] {
    return (
      this.db
        .prepare(`SELECT * FROM tracked_flights WHERE retired_at IS NULL ORDER BY created_at ASC`)
        .all() as RawRow[]
    ).map(to_flight);
  }

  /** Active rows for one user — the CRUD/Friends-tab read. */
  list_for_user(user_id: string): TrackedFlight[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM tracked_flights
            WHERE user_id = @user_id AND retired_at IS NULL
            ORDER BY COALESCE(est_dep_utc, sched_dep_utc, created_at) ASC`,
        )
        .all({ '@user_id': user_id }) as RawRow[]
    ).map(to_flight);
  }

  /** The caller's active watches linked to a given person — the Friends tab
   *  ("Sam's flight" on her card). Flight watches are personal (user_id),
   *  so this returns only the caller's own watches for that person. */
  list_for_person(user_id: string, person_id: string): TrackedFlight[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM tracked_flights
            WHERE user_id = @user_id AND person_id = @person_id AND retired_at IS NULL
            ORDER BY COALESCE(est_dep_utc, sched_dep_utc, created_at) ASC`,
        )
        .all({ '@user_id': user_id, '@person_id': person_id }) as RawRow[]
    ).map(to_flight);
  }

  /** Overwrite the snapshot fields after a poll; stamps last_polled_at. */
  apply_snapshot(id: string, snap: TrackedFlightSnapshot, now_iso: string): void {
    this.db
      .prepare(
        `UPDATE tracked_flights SET
           status = @status, phase = @phase,
           dep_iata = @dep_iata, arr_iata = @arr_iata,
           dep_terminal = @dep_terminal, dep_gate = @dep_gate,
           arr_terminal = @arr_terminal, arr_gate = @arr_gate,
           baggage_belt = @baggage_belt,
           sched_dep_utc = @sched_dep_utc, sched_arr_utc = @sched_arr_utc,
           est_dep_utc = @est_dep_utc, est_arr_utc = @est_arr_utc,
           last_polled_at = @now
         WHERE id = @id`,
      )
      .run({
        '@id': id,
        '@status': snap.status,
        '@phase': snap.phase,
        '@dep_iata': snap.dep_iata,
        '@arr_iata': snap.arr_iata,
        '@dep_terminal': snap.dep_terminal,
        '@dep_gate': snap.dep_gate,
        '@arr_terminal': snap.arr_terminal,
        '@arr_gate': snap.arr_gate,
        '@baggage_belt': snap.baggage_belt,
        '@sched_dep_utc': snap.sched_dep_utc,
        '@sched_arr_utc': snap.sched_arr_utc,
        '@est_dep_utc': snap.est_dep_utc,
        '@est_arr_utc': snap.est_arr_utc,
        '@now': now_iso,
      });
  }

  /** Advance the poll clock WITHOUT touching the snapshot — used when a poll
   *  came back empty/errored (transient rate-limit, provider blip, or a future
   *  flight not yet in the feed). Never wipes known state. */
  touch_polled(id: string, now_iso: string): void {
    this.db
      .prepare(`UPDATE tracked_flights SET last_polled_at = @now WHERE id = @id`)
      .run({ '@id': id, '@now': now_iso });
  }

  mark_event(id: string, now_iso: string): void {
    this.db
      .prepare(`UPDATE tracked_flights SET last_event_at = @now WHERE id = @id`)
      .run({ '@id': id, '@now': now_iso });
  }

  retire(id: string, now_iso: string): void {
    this.db
      .prepare(`UPDATE tracked_flights SET retired_at = @now WHERE id = @id`)
      .run({ '@id': id, '@now': now_iso });
  }
}
