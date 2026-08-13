/**
 * flights — live flight status + a CRUD watch-list for Kate (2026-06-21).
 *
 * Backed by AeroDataBox over RapidAPI (freemium key). Outbound-only, like
 * every other connector here — there is NO inbound webhook (that would need a
 * public ingress, against the no-WAN-bind rule). "Live/instant" notice comes
 * from the FlightTrackingDriver ([src/core/flight_tracking.ts]) polling the
 * watch-list on an ADAPTIVE cadence (sparse far out, ~60s in the
 * departure/arrival windows) and pushing the user the moment a field flips.
 *
 * Endpoints (RapidAPI host aerodatabox.p.rapidapi.com; base overridable via
 * AERODATABOX_BASE_URL — the smoke's fixture-server seam):
 *   - GET /flights/number/{number}/{date}  — status by flight# + departure day
 *
 * Auth: X-RapidAPI-Key (AERODATABOX_API_KEY) + X-RapidAPI-Host
 * (AERODATABOX_RAPIDAPI_HOST). Secret — set in hearth.env, never YAML/LLM.
 *
 * Tools (read_flights / track_flights gated):
 *   - flight_status        — one-shot lookup (chat + voice)
 *   - track_flight         — add to the live watch-list (write_internal)
 *   - list_tracked_flights — the caller's active watches
 *   - untrack_flight       — stop watching
 *
 * Honesty contract: on an unknown flight# the tools return `found:false` +
 * `candidates` (actionable next steps), NEVER a fabricated gate/time — the
 * connector-affordance pattern (ha_get_state 404 candidates). Times are stored
 * + returned as ISO-8601 UTC; local rendering is the caller's job (time.ts).
 *
 * Field shapes are mapped DEFENSIVELY (only what we read, all optional); the
 * smoke fixture encodes the AeroDataBox response shape we map against.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { local_iso_date } from '@core/time';
import {
  TrackedFlightsStore,
  type FlightPhase,
  type TrackedFlight,
  type TrackedFlightSnapshot,
} from '@memory/stores/flights';
import { safe_fetch } from './_audit';

// ── Configuration ─────────────────────────────────────────────────────────
const ADB_BASE = (): string =>
  process.env.AERODATABOX_BASE_URL ?? 'https://aerodatabox.p.rapidapi.com';
const ADB_KEY = (): string => process.env.AERODATABOX_API_KEY ?? '';
const ADB_HOST = (): string =>
  process.env.AERODATABOX_RAPIDAPI_HOST ?? 'aerodatabox.p.rapidapi.com';

/** True when a key (or a non-default base, i.e. the fixture) is configured. */
export function flights_configured(): boolean {
  return Boolean(ADB_KEY()) || Boolean(process.env.AERODATABOX_BASE_URL);
}

export const FLIGHT_NO_RE = /^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/;

/** "ua 2245" / "UA-2245" → "UA2245". */
export function normalize_flight_no(s: string): string {
  return s.toUpperCase().replace(/[\s-]+/g, '');
}

// ── AeroDataBox response shapes (defensive — only fields we read) ───────────
interface AdbTime {
  utc?: string | null; // "2026-06-24 14:30Z"
  local?: string | null;
}
interface AdbAirport {
  iata?: string | null;
  icao?: string | null;
  name?: string | null;
}
interface AdbMovement {
  airport?: AdbAirport;
  scheduledTime?: AdbTime | null;
  revisedTime?: AdbTime | null; // estimated or actual
  predictedTime?: AdbTime | null;
  runwayTime?: AdbTime | null;
  terminal?: string | null;
  gate?: string | null;
  baggageBelt?: string | null;
}
interface AdbFlight {
  number?: string | null;
  status?: string | null;
  airline?: { name?: string | null } | null;
  aircraft?: { model?: string | null } | null;
  departure?: AdbMovement | null;
  arrival?: AdbMovement | null;
}

// ── Normalized output shapes ────────────────────────────────────────────────
export interface FlightEndpoint {
  airport_iata: string | null;
  airport_name: string | null;
  terminal: string | null;
  gate: string | null;
  baggage_belt: string | null;
  scheduled_utc: string | null;
  revised_utc: string | null; // estimated/actual, when present
}

export interface FlightSnapshot {
  flight_no: string;
  airline: string | null;
  aircraft: string | null;
  status: string | null;
  phase: FlightPhase;
  departure: FlightEndpoint;
  arrival: FlightEndpoint;
}

export interface FlightStatusResult {
  found: boolean;
  flight_no: string;
  date: string;
  flights: FlightSnapshot[];
  candidates?: string[];
  error?: string;
}

// ── Time + status normalization (pure; exported for the smoke) ──────────────

/** AeroDataBox "2026-06-24 14:30Z" → canonical ISO-8601 UTC, or null. */
export function to_iso_utc(t?: AdbTime | null): string | null {
  const raw = t?.utc;
  if (!raw) return null;
  const d = new Date(raw.replace(' ', 'T')); // canonicalize space→T; value is UTC (Z)
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const ACTIVE = new Set(['departed', 'enroute', 'approaching', 'expectedlanding']);
/** Provider status → lifecycle phase. Unrecognized pre-flight → 'scheduled'. */
export function phase_of(status: string | null | undefined): FlightPhase {
  if (!status) return 'unknown';
  const s = status.toLowerCase().replace(/\s+/g, '');
  if (s === 'arrived') return 'landed';
  if (s.startsWith('cancel')) return 'canceled';
  if (s === 'diverted') return 'diverted';
  if (ACTIVE.has(s)) return 'active';
  return 'scheduled';
}

function to_endpoint(m: AdbMovement | null | undefined): FlightEndpoint {
  return {
    airport_iata: m?.airport?.iata ?? null,
    airport_name: m?.airport?.name ?? null,
    terminal: m?.terminal ?? null,
    gate: m?.gate ?? null,
    baggage_belt: m?.baggageBelt ?? null,
    scheduled_utc: to_iso_utc(m?.scheduledTime),
    revised_utc: to_iso_utc(m?.revisedTime) ?? to_iso_utc(m?.predictedTime) ?? to_iso_utc(m?.runwayTime),
  };
}

function to_snapshot(f: AdbFlight, fallback_no: string): FlightSnapshot {
  return {
    flight_no: f.number ? normalize_flight_no(f.number) : fallback_no,
    airline: f.airline?.name ?? null,
    aircraft: f.aircraft?.model ?? null,
    status: f.status ?? null,
    phase: phase_of(f.status),
    departure: to_endpoint(f.departure),
    arrival: to_endpoint(f.arrival),
  };
}

/** Actionable recovery hint when no flight matched — never fabricate instead. */
function not_found_candidates(flight_no: string): string[] {
  return [
    `No flight matched "${flight_no}" on that date. AeroDataBox indexes by the DEPARTURE local day (YYYY-MM-DD) — confirm the date.`,
    `Confirm the airline + number as IATA code + number, e.g. "UA2245" or "BA117".`,
  ];
}

/** Parse a /flights/number response body into the normalized result. */
export function parse_flight_status(body: string, flight_no: string, date: string): FlightStatusResult {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { found: false, flight_no, date, flights: [], candidates: not_found_candidates(flight_no), error: 'unparseable provider response' };
  }
  // AeroDataBox returns an array of flights; error bodies are { message }.
  if (!Array.isArray(json)) {
    const msg = typeof (json as { message?: unknown })?.message === 'string'
      ? (json as { message: string }).message
      : undefined;
    return { found: false, flight_no, date, flights: [], candidates: not_found_candidates(flight_no), ...(msg ? { error: msg } : {}) };
  }
  const flights = (json as AdbFlight[]).map((f) => to_snapshot(f, flight_no));
  return flights.length > 0
    ? { found: true, flight_no, date, flights }
    : { found: false, flight_no, date, flights: [], candidates: not_found_candidates(flight_no) };
}

// ── The fetch (used by the tools AND the driver) ────────────────────────────
export async function fetch_flight_status(
  flight_no_raw: string,
  date: string,
): Promise<FlightStatusResult> {
  const flight_no = normalize_flight_no(flight_no_raw);
  if (!flights_configured()) {
    return {
      found: false,
      flight_no,
      date,
      flights: [],
      candidates: ['Flight tracking is not configured — set AERODATABOX_API_KEY in hearth.env.'],
      error: 'flights connector not configured',
    };
  }
  const url = `${ADB_BASE()}/flights/number/${encodeURIComponent(flight_no)}/${encodeURIComponent(date)}`;
  const res = await safe_fetch(url, {
    headers: { 'X-RapidAPI-Key': ADB_KEY(), 'X-RapidAPI-Host': ADB_HOST() },
  });
  if (!res.ok) {
    // 204/404 = no such flight (actionable); other codes = a real error.
    if (res.status === 404 || res.status === 204) {
      return { found: false, flight_no, date, flights: [], candidates: not_found_candidates(flight_no) };
    }
    if (res.status === 429) {
      return {
        found: false,
        flight_no,
        date,
        flights: [],
        candidates: ['Rate limit hit (AeroDataBox BASIC = 1 request/second) — try again in a few seconds.'],
        error: 'provider HTTP 429 (rate limited)',
      };
    }
    return {
      found: false,
      flight_no,
      date,
      flights: [],
      candidates: not_found_candidates(flight_no),
      error: res.error ?? `provider HTTP ${res.status}`,
    };
  }
  return parse_flight_status(res.body, flight_no, date);
}

// ── Live-tracking pure helpers (exported for the driver + smoke) ─────────────

function ms_until(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t - now.getTime();
}

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * Adaptive poll interval — fast only in the windows that matter, so a tracked
 * flight costs ~100-150 calls across its whole lifecycle, not thousands.
 */
export function cadence_ms(
  row: Pick<TrackedFlight, 'phase' | 'sched_dep_utc' | 'sched_arr_utc' | 'est_dep_utc' | 'est_arr_utc'>,
  now: Date,
): number {
  const arr = ms_until(row.est_arr_utc ?? row.sched_arr_utc, now);
  const dep = ms_until(row.est_dep_utc ?? row.sched_dep_utc, now);
  if (row.phase === 'landed') return MIN; // until retired (baggage belt / +90m)
  if (row.phase === 'active') {
    if (arr !== null && arr <= 30 * MIN) return MIN; // arrival window — landing + belt
    return 5 * MIN; // cruising — ETA drift
  }
  // pre-departure
  if (dep !== null && dep <= 2 * HOUR) return 2 * MIN; // gate / boarding / delay
  if (dep !== null && dep > 3 * HOUR) return 30 * MIN; // far out — just schedule moves
  return 10 * MIN;
}

/** Is this row due for a poll given its cadence and last_polled_at? */
export function is_due(row: TrackedFlight, now: Date): boolean {
  if (!row.last_polled_at) return true; // never polled
  const since = now.getTime() - new Date(row.last_polled_at).getTime();
  return since >= cadence_ms(row, now);
}

export type FlightEventKind =
  | 'departed'
  | 'landed'
  | 'delayed'
  | 'gate_change'
  | 'baggage'
  | 'cancelled'
  | 'diverted'
  | 'eta_moved';

export interface FlightEvent {
  kind: FlightEventKind;
  detail: string;
}

const ETA_DRIFT_MIN = 10;

/**
 * What meaningfully changed between the stored snapshot and a fresh one. Keyed
 * on PHASE transitions (not raw status strings) so a provider re-wording can't
 * fire a phantom event. The seed poll (prev all-null) produces only the natural
 * scheduled→… transitions, which emit nothing until a real edge.
 */
export function diff_events(prev: TrackedFlightSnapshot, next: FlightSnapshot): FlightEvent[] {
  const out: FlightEvent[] = [];
  // No prior real observation (a row seeded before the flight was in the feed,
  // or tracking started mid-flight): establish the baseline SILENTLY. We notify
  // on CHANGES to known data, never on first acquisition — else every non-null
  // field reads as "changed from null" and fires a phantom gate/baggage push.
  if (prev.phase === 'unknown' && prev.status === null) return [];
  if (next.phase === 'active' && prev.phase !== 'active' && prev.phase !== 'landed') {
    out.push({ kind: 'departed', detail: next.departure.airport_iata ?? '' });
  }
  if (next.phase === 'landed' && prev.phase !== 'landed') {
    out.push({ kind: 'landed', detail: next.arrival.airport_iata ?? '' });
  }
  if (next.phase === 'canceled' && prev.phase !== 'canceled') {
    out.push({ kind: 'cancelled', detail: next.flight_no });
  }
  if (next.phase === 'diverted' && prev.phase !== 'diverted') {
    out.push({ kind: 'diverted', detail: next.arrival.airport_iata ?? '' });
  }
  if (next.departure.gate && next.departure.gate !== prev.dep_gate) {
    out.push({ kind: 'gate_change', detail: `departure gate ${next.departure.gate}` });
  }
  if (next.arrival.gate && next.arrival.gate !== prev.arr_gate) {
    out.push({ kind: 'gate_change', detail: `arrival gate ${next.arrival.gate}` });
  }
  if (next.arrival.baggage_belt && next.arrival.baggage_belt !== prev.baggage_belt) {
    out.push({ kind: 'baggage', detail: `belt ${next.arrival.baggage_belt}` });
  }
  // ETA drift while not already captured by a phase change.
  const prev_eta = prev.est_arr_utc ?? prev.sched_arr_utc;
  const next_eta = next.arrival.revised_utc ?? next.arrival.scheduled_utc;
  if (prev_eta && next_eta && next.phase !== 'landed') {
    const drift = (new Date(next_eta).getTime() - new Date(prev_eta).getTime()) / MIN;
    if (Number.isFinite(drift) && Math.abs(drift) >= ETA_DRIFT_MIN) {
      out.push({ kind: drift > 0 ? 'delayed' : 'eta_moved', detail: `${Math.round(drift)} min` });
    }
  }
  return out;
}

/** Fold a fresh FlightSnapshot into the store's snapshot column shape. */
export function snapshot_columns(s: FlightSnapshot): TrackedFlightSnapshot {
  return {
    status: s.status,
    phase: s.phase,
    dep_iata: s.departure.airport_iata,
    arr_iata: s.arrival.airport_iata,
    dep_terminal: s.departure.terminal,
    dep_gate: s.departure.gate,
    arr_terminal: s.arrival.terminal,
    arr_gate: s.arrival.gate,
    baggage_belt: s.arrival.baggage_belt,
    sched_dep_utc: s.departure.scheduled_utc,
    sched_arr_utc: s.arrival.scheduled_utc,
    est_dep_utc: s.departure.revised_utc,
    est_arr_utc: s.arrival.revised_utc,
  };
}

// ── Tools ────────────────────────────────────────────────────────────────────
function audit(
  ctx: ToolContext,
  tool_name: string,
  input: Record<string, unknown>,
  result: unknown,
  error?: string,
): void {
  ctx.memory.log_action({
    intent_id: ctx.intent_id || ulid(),
    agent: ctx.specialist_id || 'flights_connector',
    tool_name,
    tool_input: input,
    execution_result: error ? undefined : result,
    error,
  });
}

/** Ambient user id — resolve from ctx, never a model arg (multi-user-correct). */
function caller_id(ctx: ToolContext): string | null {
  return ctx.user?.id ?? null;
}

// NOTE: no `.regex()` on date fields — a tool input_schema becomes a GBNF
// grammar on the interactive 9B, and llama.cpp's converter mistranslates a
// regex `pattern` and SILENTLY disables the whole tool grammar. The
// YYYY-MM-DD shape is validated in execute() with a typed recovery message.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const bad_date_hint = (got: string): string =>
  `date must be ISO YYYY-MM-DD (got "${got}"). Re-call with that format, or omit it to default to today.`;

const FlightStatusInput = z.object({
  flight_no: z.string().min(2).max(8).describe('Flight number, e.g. "UA2245" or "BA 117".'),
  date: z
    .string()
    .optional()
    .describe('Departure date YYYY-MM-DD. Defaults to today in your timezone.'),
});

export function create(deps: ToolDeps): Tool[] {
  const store = new TrackedFlightsStore(deps.db);

  const flight_status: Tool<z.infer<typeof FlightStatusInput>, FlightStatusResult> = {
    name: 'flight_status',
    description:
      'Look up the live status of a specific flight (status, gate, terminal, scheduled vs estimated times, delay, baggage belt) by flight number and date. On an unknown flight it returns candidates with what to check — never a guessed time or gate.',
    risk: 'read',
    required_capabilities: ['read_flights'],
    input_schema: FlightStatusInput,
    output_schema: z.object({
      found: z.boolean(),
      flight_no: z.string(),
      date: z.string(),
      flights: z.array(z.any()),
      candidates: z.array(z.string()).optional(),
      error: z.string().optional(),
    }),
    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(`${normalize_flight_no(input.flight_no)}|${input.date ?? ''}`);
      return `flight_status:${h.digest('hex').slice(0, 16)}`;
    },
    async execute(input, ctx): Promise<FlightStatusResult> {
      if (input.date && !ISO_DATE_RE.test(input.date)) {
        const out: FlightStatusResult = {
          found: false,
          flight_no: input.flight_no,
          date: input.date,
          flights: [],
          candidates: [bad_date_hint(input.date)],
        };
        audit(ctx, 'flight_status', { flight_no: input.flight_no, date: input.date }, { found: false, n: 0 }, 'malformed date');
        return out;
      }
      const date = input.date ?? local_iso_date(ctx.now, ctx.user?.timezone);
      // A flight number always has digits. A non-numeric value is a person's name
      // jammed in (the "Kim" misfire) — don't burn a lookup; point to the right
      // tool. who_is returns a person's tracked flights, no flight number needed.
      if (!/\d/.test(input.flight_no)) {
        const hint: FlightStatusResult = {
          found: false,
          flight_no: input.flight_no,
          date,
          flights: [],
          candidates: [
            `"${input.flight_no}" is not a flight number. To see the flights tracked for a PERSON, ` +
              `call who_is with their name (e.g. who_is name="${input.flight_no}") — their tracked ` +
              `flights come back in the result.`,
          ],
        };
        audit(ctx, 'flight_status', { flight_no: input.flight_no, date }, { found: false, n: 0 }, 'not a flight number');
        return hint;
      }
      const result = await fetch_flight_status(input.flight_no, date);
      audit(ctx, 'flight_status', { flight_no: input.flight_no, date }, { found: result.found, n: result.flights.length }, result.error);
      return result;
    },
  };

  const TrackInput = z.object({
    flight_no: z.string().min(2).max(8),
    date: z.string().optional().describe('Departure date YYYY-MM-DD. Defaults to today.'),
    person_id: z.string().optional().describe('Optional People/ note id to link this flight to (Friends tab).'),
    label: z.string().max(120).optional().describe('Optional note, e.g. "Sam coming home".'),
  });
  const track_flight: Tool<z.infer<typeof TrackInput>, { tracked: boolean; id?: string; already?: boolean; found: boolean; candidates?: string[] }> = {
    name: 'track_flight',
    description:
      'Start tracking a flight LIVE — it will push the user the moment it is delayed, departs, lands, changes gate, or assigns a baggage belt. Use this when the user wants ongoing notice, not a one-time check. Seeds from the current status; returns candidates if the flight number/date is unknown.',
    risk: 'write_internal',
    required_capabilities: ['track_flights'],
    input_schema: TrackInput,
    output_schema: z.object({
      tracked: z.boolean(),
      id: z.string().optional(),
      already: z.boolean().optional(),
      found: z.boolean(),
      candidates: z.array(z.string()).optional(),
    }),
    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(`${normalize_flight_no(input.flight_no)}|${input.date ?? ''}`);
      return `track_flight:${h.digest('hex').slice(0, 16)}`;
    },
    async execute(input, ctx) {
      const user_id = caller_id(ctx);
      if (!user_id) {
        return { tracked: false, found: false, candidates: ['No user in context — tracking is per-user.'] };
      }
      if (input.date && !ISO_DATE_RE.test(input.date)) {
        return { tracked: false, found: false, candidates: [bad_date_hint(input.date)] };
      }
      const flight_no = normalize_flight_no(input.flight_no);
      const date = input.date ?? local_iso_date(ctx.now, ctx.user?.timezone);
      const status = await fetch_flight_status(flight_no, date);
      const { row, already } = store.upsert(
        { flight_no, flight_date: date, user_id, person_id: input.person_id ?? null, label: input.label ?? null },
        ctx.now.toISOString(),
      );
      // Seed the snapshot so the driver diffs from "now" forward (no event on
      // the first real-status poll).
      if (status.found && status.flights[0]) {
        store.apply_snapshot(row.id, snapshot_columns(status.flights[0]), ctx.now.toISOString());
      } else {
        store.apply_snapshot(row.id, snapshot_columns({
          flight_no, airline: null, aircraft: null, status: null, phase: 'unknown',
          departure: { airport_iata: null, airport_name: null, terminal: null, gate: null, baggage_belt: null, scheduled_utc: null, revised_utc: null },
          arrival: { airport_iata: null, airport_name: null, terminal: null, gate: null, baggage_belt: null, scheduled_utc: null, revised_utc: null },
        }), ctx.now.toISOString());
      }
      const out = {
        tracked: true,
        id: row.id,
        already,
        found: status.found,
        ...(status.found ? {} : { candidates: status.candidates }),
      };
      audit(ctx, 'track_flight', { flight_no, date, label: input.label ?? null }, { id: row.id, already, found: status.found });
      return out;
    },
  };

  const list_tracked_flights: Tool<Record<string, never>, { flights: TrackedFlight[] }> = {
    name: 'list_tracked_flights',
    description: 'List the flights you are currently tracking live, with their latest status, gate, and times.',
    risk: 'read',
    required_capabilities: ['read_flights'],
    input_schema: z.object({}),
    output_schema: z.object({ flights: z.array(z.any()) }),
    idempotency_key() {
      return `list_tracked_flights:${ulid()}`; // per-user live read; never dedup
    },
    async execute(_input, ctx) {
      const user_id = caller_id(ctx);
      const flights = user_id ? store.list_for_user(user_id) : [];
      audit(ctx, 'list_tracked_flights', {}, { n: flights.length });
      return { flights };
    },
  };

  const UntrackInput = z.object({
    id: z.string().optional().describe('The tracked-flight id (tf_…).'),
    flight_no: z.string().optional(),
    // Date-shape validated implicitly: a malformed date matches no active row
    // → honest { untracked: false }. No `.regex()` (GBNF silent-fail trap).
    date: z.string().optional().describe('Departure date YYYY-MM-DD.'),
  });
  const untrack_flight: Tool<z.infer<typeof UntrackInput>, { untracked: boolean }> = {
    name: 'untrack_flight',
    description: 'Stop tracking a flight — by its id, or by flight number + date.',
    risk: 'write_internal',
    required_capabilities: ['track_flights'],
    input_schema: UntrackInput,
    output_schema: z.object({ untracked: z.boolean() }),
    idempotency_key(input) {
      return `untrack_flight:${input.id ?? `${normalize_flight_no(input.flight_no ?? '')}|${input.date ?? ''}`}`;
    },
    async execute(input, ctx) {
      const user_id = caller_id(ctx);
      if (!user_id) return { untracked: false };
      let row: TrackedFlight | null = null;
      if (input.id) {
        const candidate = store.get(input.id);
        // Cordon: only the owner may untrack their own row.
        if (candidate && candidate.user_id === user_id && !candidate.retired_at) row = candidate;
      } else if (input.flight_no && input.date) {
        row = store.find_active(user_id, normalize_flight_no(input.flight_no), input.date);
      }
      if (row) store.retire(row.id, ctx.now.toISOString());
      audit(ctx, 'untrack_flight', { id: input.id ?? null, flight_no: input.flight_no ?? null }, { untracked: Boolean(row) });
      return { untracked: Boolean(row) };
    },
  };

  return [flight_status, track_flight, list_tracked_flights, untrack_flight] as unknown as Tool[];
}
