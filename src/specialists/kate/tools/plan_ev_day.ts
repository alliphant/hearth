/**
 * plan_ev_day — Iris-only tool that answers "will tomorrow's plans fit
 * on this charge?" concretely.
 *
 * Composition:
 *   1. Calendar events for the target day, read from the iOS-sourced
 *      calendar snapshot (POST /api/sensors/calendar → the
 *      `calendar_snapshots` projection, the same store Kate's
 *      sensor_calendar_* tools read). This replaces the deprecated
 *      HA-CalDAV path (`ha_calendar_query`) per
 *      BACKEND_HA_CALDAV_DEPRECATION_BRIEF — no server-side Apple
 *      credentials, every EventKit-visible calendar aggregated.
 *   2. Route between consecutive events in order, starting from home
 *      (or current location if it's late evening).
 *   3. Sum distance, apply a conservative kWh-per-mile estimate.
 *   4. Compare against current SoC from HA.
 *
 * The output is intentionally human-shaped: a verdict + a one-line
 * recommended_action that Iris paraphrases in her voice. This tool
 * doesn't make an LLM call itself; the LLM consumes its output.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import { route, geocode } from '@connectors/maps';
import { ha_get_state } from '@connectors/home_assistant';
import { get_current_location } from '@core/location_awareness';

const KWH_PER_MILE = parseFloat(
  process.env.IONIQ5_KWH_PER_MILE_CONSERVATIVE ?? '0.35',
);
// Ioniq 5 Long Range RWD has a 77.4 kWh usable pack. SR is 58 kWh; LR
// AWD/RWD 77.4 kWh. Conservative default = 77.4.
const PACK_KWH = parseFloat(process.env.IONIQ5_USABLE_KWH ?? '77.4');
const SOC_ENTITY = process.env.IONIQ5_SOC_ENTITY ?? '';
const RANGE_ENTITY = process.env.IONIQ5_RANGE_ENTITY ?? '';

const InputSchema = z.object({
  date: z
    .union([z.literal('today'), z.literal('tomorrow'), z.string()])
    .default('tomorrow'),
});

const EventLegSchema = z.object({
  event: z.object({
    summary: z.string(),
    start: z.string(),
    end: z.string(),
    location: z.string().nullable(),
  }),
  from: z.union([
    z.object({ kind: z.literal('home'), lat: z.number(), lon: z.number() }),
    z.object({ kind: z.literal('current'), lat: z.number(), lon: z.number() }),
    z.object({ kind: z.literal('prev_event'), lat: z.number(), lon: z.number() }),
  ]),
  to: z.object({
    lat: z.number(),
    lon: z.number(),
    label: z.string(),
  }),
  distance_meters: z.number(),
  duration_seconds: z.number(),
  estimated_kwh_used: z.number(),
});

const OutputSchema = z.object({
  events_with_legs: z.array(EventLegSchema),
  total_miles: z.number(),
  total_kwh_estimated: z.number(),
  current_charge_pct: z.number().nullable(),
  current_range_miles: z.number().nullable(),
  verdict: z.enum([
    'easily_fits',
    'fits_with_buffer',
    'tight_consider_charging',
    'requires_charging',
    'requires_dc_fast_charge',
  ]),
  recommended_action: z.string().nullable(),
  error: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function resolve_date(d: Input['date']): Date {
  const now = new Date();
  if (d === 'today') return now;
  if (d === 'tomorrow') {
    const t = new Date(now);
    t.setDate(t.getDate() + 1);
    return t;
  }
  return new Date(d);
}

function day_window(d: Date): { start: string; end: string } {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return { start: start.toISOString(), end: end.toISOString() };
}

function meters_to_miles(m: number): number {
  return m / 1609.344;
}

/** Internal event shape the leg builder consumes. Exported for smoke:ev. */
export interface DayEvent {
  summary: string;
  start: string;
  end: string;
  location: string | null;
}

/**
 * Read the target day's located events from the iOS calendar snapshot
 * (`MemoryClient.query_calendar_snapshot` — the same store Kate's
 * sensor_calendar_* tools read). Returns events whose start falls inside
 * the [start, end] UTC window, chronological, located-only (an event with
 * no location can't be routed). No snapshot → empty list: an EV plan with
 * no known commitments is "easily_fits", not an error.
 */
export function read_day_events(
  ctx: ToolContext,
  user_id: string,
  window: { start: string; end: string },
): DayEvent[] {
  const snap = ctx.memory.query_calendar_snapshot(user_id);
  if (!snap) return [];
  return snap.events
    .filter((e) => Boolean(e.ts_start) && e.ts_start >= window.start && e.ts_start <= window.end)
    .filter((e) => Boolean(e.location))
    .sort((a, b) => (a.ts_start < b.ts_start ? -1 : a.ts_start > b.ts_start ? 1 : 0))
    .map((e) => ({
      summary: e.title,
      start: e.ts_start,
      end: e.ts_end,
      location: e.location ?? null,
    }));
}

async function fetch_soc(ctx: ToolContext): Promise<{
  charge_pct: number | null;
  range_miles: number | null;
}> {
  let charge_pct: number | null = null;
  let range_miles: number | null = null;

  if (SOC_ENTITY) {
    const s = await ha_get_state.execute({ entity_id: SOC_ENTITY }, ctx);
    if (s.state) {
      const n = parseFloat(s.state);
      if (Number.isFinite(n)) charge_pct = n;
    }
  }
  if (RANGE_ENTITY) {
    const s = await ha_get_state.execute({ entity_id: RANGE_ENTITY }, ctx);
    if (s.state) {
      const n = parseFloat(s.state);
      if (Number.isFinite(n)) {
        const unit = (s.attributes?.unit_of_measurement as string | undefined) ?? '';
        // Companion app exposes range in km by default in non-US locales.
        range_miles = unit.toLowerCase().startsWith('km')
          ? n / 1.609344
          : n;
      }
    }
  }
  return { charge_pct, range_miles };
}

async function resolve_event_location(
  ctx: ToolContext,
  loc: string | null,
): Promise<{ lat: number; lon: number; label: string } | null> {
  if (!loc) return null;
  // 1) Try Place name/alias lookup first (cached, free).
  const place = ctx.memory.find_place_by_name(loc);
  if (place && place.lat != null && place.lon != null) {
    return { lat: place.lat, lon: place.lon, label: place.name };
  }
  // 2) Geocode the address.
  const g = await geocode.execute({ query: loc }, ctx);
  if (g.results.length > 0 && g.results[0]) {
    return { lat: g.results[0].lat, lon: g.results[0].lon, label: loc };
  }
  return null;
}

function classify_verdict(
  charge_pct: number | null,
  range_miles: number | null,
  total_miles: number,
  total_kwh: number,
): {
  verdict: Output['verdict'];
  recommended_action: string | null;
} {
  // No driving planned at all — short-circuit before consulting SoC.
  if (total_miles === 0) {
    return { verdict: 'easily_fits', recommended_action: null };
  }
  if (charge_pct === null && range_miles === null) {
    return {
      verdict: 'fits_with_buffer',
      recommended_action:
        "I can't read your charge state from HA right now — verdict assumes a typical 60% start.",
    };
  }
  const available_kwh = charge_pct !== null ? (charge_pct / 100) * PACK_KWH : null;
  const available_miles =
    range_miles !== null
      ? range_miles
      : available_kwh !== null
        ? available_kwh / KWH_PER_MILE
        : null;

  if (available_miles === null) {
    return { verdict: 'fits_with_buffer', recommended_action: null };
  }

  const margin = available_miles - total_miles;
  // Tier thresholds biased conservative:
  //   easily   — > 50% margin
  //   buffer   — 25-50% margin
  //   tight    — 10-25%
  //   require  — 0-10%
  //   dc_fast  — negative (need to recharge en route)
  const margin_frac = margin / Math.max(total_miles, 1);
  if (margin_frac > 0.5) {
    return { verdict: 'easily_fits', recommended_action: null };
  }
  if (margin_frac > 0.25) {
    return {
      verdict: 'fits_with_buffer',
      recommended_action: 'Plenty of range; no charging action needed.',
    };
  }
  if (margin_frac > 0.10) {
    return {
      verdict: 'tight_consider_charging',
      recommended_action: `~${margin.toFixed(0)} mi headroom on ${total_miles.toFixed(0)} mi of driving — top up overnight if you can.`,
    };
  }
  if (margin >= 0) {
    return {
      verdict: 'requires_charging',
      recommended_action: `Plan to charge tonight before tomorrow — total ${total_miles.toFixed(0)} mi vs ~${available_miles.toFixed(0)} mi range.`,
    };
  }
  return {
    verdict: 'requires_dc_fast_charge',
    recommended_action: `Tomorrow's driving (${total_miles.toFixed(0)} mi) exceeds available range (~${available_miles.toFixed(0)} mi); plan for a DC fast charge en route.`,
  };
}

export const plan_ev_day: Tool<Input, Output> = {
  name: 'plan_ev_day',
  description:
    "Will the Ioniq 5's current charge cover today's or tomorrow's calendar plans? Sums routed distance between events, applies a conservative consumption estimate, and compares against the live SoC from HA. Returns a verdict (easily_fits → requires_dc_fast_charge) plus a human-shaped recommended_action.",
  risk: 'read',
  required_capabilities: [
    'query_maps',
    'read_my_location',
    'read_home_assistant',
    'read_calendar',
  ],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(String(input.date));
    return `plan_ev_day:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    const day = resolve_date(input.date);
    const window = day_window(day);
    const user_id = ctx.user?.id ?? process.env.HEARTH_OWNER_USER_ID ?? 'jasper';

    // 1) Calendar events for that day — read from the iOS calendar
    // snapshot (replaces the deprecated HA-CalDAV path). Located-only;
    // an event with no location can't be routed.
    const events = read_day_events(ctx, user_id, window);

    // 2) Resolve "home" from the Places vault. Falls back to current
    // location coords; if neither, no routing.
    const home_place = ctx.memory.find_place_by_name('Home');
    const current_snap = await get_current_location(user_id);
    const home: { lat: number; lon: number } | null =
      home_place && home_place.lat != null && home_place.lon != null
        ? { lat: home_place.lat, lon: home_place.lon }
        : current_snap.coords ?? null;

    if (!home) {
      const out: Output = {
        events_with_legs: [],
        total_miles: 0,
        total_kwh_estimated: 0,
        current_charge_pct: null,
        current_range_miles: null,
        verdict: 'easily_fits',
        recommended_action: null,
        error: "couldn't resolve a starting point (no Places/Home.md and no current location)",
      };
      ctx.memory.log_action({
        intent_id: ctx.intent_id || ulid(),
        agent: 'iris',
        tool_name: 'plan_ev_day',
        tool_input: { date: input.date },
        execution_result: { verdict: out.verdict, events: 0 },
        error: out.error,
      });
      return out;
    }

    // 3) Compute legs in calendar order. "from" of the first leg is
    // home (or current location); subsequent legs chain from the
    // previous event's location.
    let prev: { lat: number; lon: number; kind: 'home' | 'current' | 'prev_event' } = {
      ...home,
      kind: 'home',
    };
    const legs: z.infer<typeof EventLegSchema>[] = [];
    let total_meters = 0;
    let total_kwh = 0;

    for (const ev of events) {
      const dest = await resolve_event_location(ctx, ev.location);
      if (!dest) continue;
      const r = await route.execute(
        {
          from: { lat: prev.lat, lon: prev.lon },
          to: { lat: dest.lat, lon: dest.lon },
          mode: 'drive',
          include_geometry: false,
        },
        ctx,
      );
      if (r.error) continue;
      const miles = meters_to_miles(r.distance_meters);
      const kwh = miles * KWH_PER_MILE;
      legs.push({
        event: {
          summary: ev.summary,
          start: ev.start,
          end: ev.end,
          location: ev.location,
        },
        from: { kind: prev.kind, lat: prev.lat, lon: prev.lon },
        to: { lat: dest.lat, lon: dest.lon, label: dest.label },
        distance_meters: r.distance_meters,
        duration_seconds: r.duration_seconds,
        estimated_kwh_used: kwh,
      });
      total_meters += r.distance_meters;
      total_kwh += kwh;
      prev = { ...dest, kind: 'prev_event' };
    }

    const { charge_pct, range_miles } = await fetch_soc(ctx);
    const total_miles = meters_to_miles(total_meters);
    const { verdict, recommended_action } = classify_verdict(
      charge_pct,
      range_miles,
      total_miles,
      total_kwh,
    );

    const out: Output = {
      events_with_legs: legs,
      total_miles,
      total_kwh_estimated: total_kwh,
      current_charge_pct: charge_pct,
      current_range_miles: range_miles,
      verdict,
      recommended_action,
    };

    ctx.memory.log_action({
      intent_id: ctx.intent_id || ulid(),
      agent: 'iris',
      tool_name: 'plan_ev_day',
      tool_input: { date: input.date },
      execution_result: {
        verdict,
        events: legs.length,
        total_miles,
        charge_pct,
      },
    });

    return out;
  },
};
