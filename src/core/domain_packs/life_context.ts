/**
 * Life-context domain pack (moved from src/core/brief_context.ts into
 * src/core/domain_packs/ during the Durable-Truth Phase 1 generalization,
 * 2026-05-30). A "domain pack" pre-pumps verified, sourced context into a
 * specialist's prompt BEFORE the LLM turn, so the turn renders live state
 * instead of deciding whether to fetch it — and so its fresh readings
 * become legitimate grounding entries the provenance validator can check
 * brief claims against (see src/core/domain_packs/index.ts and
 * src/core/provenance.ts). `life_context` is the first pack; it backs
 * Kate's report-time briefs. src/core/brief_context.ts remains as a
 * thin re-export shim for legacy importers.
 *
 * Brief context puller — pre-pumps verified life-context into Kate's
 * deliberation prompt at report-time slots (07:00 / 12:30 / 18:00 /
 * 22:00) so the brief is rendering live state, not deciding whether to
 * fetch it.
 *
 * Why this exists: Kate's brief leads with whichever signals she has
 * at deliberation time. If her ctx only contains inbox flags + the
 * proposals queue, the brief leads with Hearth-meta. If a value (EV
 * SoC, weather, calendar) is reachable but Kate has to remember to
 * call the tool, she will sometimes recall a number from her own
 * memory instead — that's how "Ioniq 5 at 97%" lands on the hero card
 * when the SoC entity isn't even configured.
 *
 * Mechanism: this puller runs BEFORE the LLM turn. It composes
 * readings from the right source per signal and emits a
 * `VerifiedLifeContext` object. Unconfigured / unreachable readings
 * return `status: 'unavailable'` with a `reason` — Kate sees an
 * explicit "no data" marker rather than nothing, so she can't fill
 * the gap from memory.
 *
 * Source map (2026-05-26 cutover):
 *   - EV (SoC + range): Home Assistant entities via IONIQ5_*_ENTITY env vars.
 *   - Weather: Pirate Weather API via `read_weather` connector. Coords
 *     come from HEARTH_HOME_LAT / HEARTH_HOME_LON env. No HA dependency.
 *   - Calendar: iOS-sourced calendar snapshot via MemoryClient.query_calendar_snapshot.
 *     Replaces the prior HA-CalDAV path per BACKEND_HA_CALDAV_DEPRECATION_BRIEF.
 *     iOS posts via POST /api/sensors/calendar; if no snapshot has landed
 *     yet, the reading is `unavailable` with a recovery hint.
 *   - Indoor temperature: still HA via HEARTH_BRIEF_INDOOR_TEMP_ENTITY
 *     (room sensor lives on HA; no equivalent iOS source).
 *
 * Entity IDs come from environment variables (matching the existing
 * Iris/plan_ev_day convention — IONIQ5_SOC_ENTITY etc.). The brief
 * prompt cites this block as the canonical source for any number,
 * percentage, status descriptor, or named entity in the brief.
 */

import { fetch_ha_state } from '@connectors/home_assistant';
import { fetch_brief_weather } from '@connectors/weather';
import type { MemoryClient, CalendarSnapshotEventShape } from '@memory/client';
import type { UserRegistry } from '../users';
import { resolve_weather_coords } from '../weather_location';
import { to_local_instant, local_iso_date, type LocalInstant } from '../time';
import {
  compute_relationship_signals,
  relationship_grounding_lines,
  type RelationshipSignals,
} from '../relationship_signals';
import { get_household_context } from '../household';
import { effective_facets } from '@memory/stores/user_profile';

export interface VerifiedReading {
  status: 'fresh' | 'unavailable';
  /** entity_id when from HA; provider name when from a connector; null when no source available. */
  source_entity: string | null;
  /** Raw state value from the source — string, number, or null. */
  value: unknown;
  /** Unit / friendly label when known (e.g. "%", "miles", "°F"). */
  unit?: string | null;
  /** ISO timestamp this puller ran. */
  ts_read: string;
  /** When status is 'unavailable', explains why so the LLM can't fill the gap. */
  reason?: string;
}

export interface VerifiedCalendarEvent {
  summary: string;
  // LocalInstant, not string: the calendar times the LLM reads in the
  // brief MUST be localized. This is the farmers-market fix made
  // structural — assigning a raw `ts_start` here is a compile error.
  start: LocalInstant;
  end: LocalInstant;
  all_day: boolean;
  location: string | null;
  calendar: string;
}

export interface VerifiedCalendar {
  status: 'fresh' | 'unavailable';
  today: VerifiedCalendarEvent[];
  tomorrow: VerifiedCalendarEvent[];
  /** Source descriptors — e.g. "ios_sensor_snapshot" plus the captured_at timestamp. */
  source_entities: string[];
  reason?: string;
}

export interface VerifiedWeather {
  /** Plain English forecast for today (e.g. "Rain in the afternoon"). */
  forecast: VerifiedReading;
  /** Probability 0..1 — Kate's prompt expects a percentage. */
  precip_probability_today: VerifiedReading;
  /** From HA indoor temp sensor when configured. */
  indoor_temp: VerifiedReading;
  /** New: high/low for the rest of today. */
  temperature_high_today: VerifiedReading;
  temperature_low_today: VerifiedReading;
  /** Count of active severe-weather alerts at the user's home. */
  active_alert_count: VerifiedReading;
}

export interface VerifiedLifeContext {
  generated_at: string;
  /**
   * EV charge/range. **Omitted entirely** (the key is absent, not
   * `unavailable`) for a user without the `ev` facet — that's the difference
   * between "Sam has no EV" and "Sam's EV reads no data". Present with real
   * readings for an owner whose household has a vehicle (unchanged), present
   * with `unavailable` markers only in the future per-user-EV case.
   */
  ev?: {
    soc_percent: VerifiedReading;
    range_miles: VerifiedReading;
  };
  weather: VerifiedWeather;
  calendar: VerifiedCalendar;
  /** Who to reconnect with + upcoming occasions (birthdays/anniversaries/tracked
   *  dates) for THIS user — the brief's relationship nudges. Cordoned. */
  relationships?: RelationshipSignals;
}

function ts_now(): string {
  return new Date().toISOString();
}

function unavailable(source_entity: string | null, reason: string): VerifiedReading {
  return {
    status: 'unavailable',
    source_entity,
    value: null,
    ts_read: ts_now(),
    reason,
  };
}

function fresh(args: {
  source: string;
  value: unknown;
  unit?: string | null;
}): VerifiedReading {
  return {
    status: 'fresh',
    source_entity: args.source,
    value: args.value,
    unit: args.unit ?? null,
    ts_read: ts_now(),
  };
}

async function read_ha_entity(
  env_var: string,
  unit: string | null,
): Promise<VerifiedReading> {
  const entity_id = process.env[env_var];
  if (!entity_id) {
    return unavailable(
      null,
      `not configured (set env ${env_var} to the HA entity_id)`,
    );
  }
  try {
    const raw = await fetch_ha_state(entity_id);
    if (!raw || raw.state === undefined || raw.state === null) {
      return unavailable(entity_id, 'HA returned null/missing state');
    }
    return fresh({ source: entity_id, value: raw.state, unit });
  } catch (err) {
    return unavailable(
      entity_id,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function read_weather_block(
  users: UserRegistry | undefined,
  memory: MemoryClient,
  user_id: string,
): Promise<{
  forecast: VerifiedReading;
  precip: VerifiedReading;
  high: VerifiedReading;
  low: VerifiedReading;
  alerts: VerifiedReading;
}> {
  // Weather follows the user when iOS has pushed a fresh location
  // packet; otherwise reads from the home_location anchor in
  // config/users.yaml. See src/core/weather_location.ts.
  const coords = await resolve_weather_coords({ user_id, users, memory });
  if (!coords) {
    const r =
      `no coordinates for user "${user_id}" — no fresh iOS location packet and no home_location in config/users.yaml. Add home_location to the user's entry.`;
    return {
      forecast: unavailable(null, r),
      precip: unavailable(null, r),
      high: unavailable(null, r),
      low: unavailable(null, r),
      alerts: unavailable(null, r),
    };
  }
  const fetched = await fetch_brief_weather({
    lat: coords.lat,
    lng: coords.lng,
    location_label: coords.label,
  });
  if (!fetched.ok) {
    const r = fetched.reason;
    return {
      forecast: unavailable(null, r),
      precip: unavailable(null, r),
      high: unavailable(null, r),
      low: unavailable(null, r),
      alerts: unavailable(null, r),
    };
  }
  const d = fetched.data;
  // Source label captures BOTH the location AND how we found it, so
  // Kate's brief can lead with the right framing — "weather at the
  // cabin (sensor_current, 12m old)" vs "weather at home
  // (user_config)". Useful for debugging and for the brief to be
  // honest about whether it's reading where you ARE or where you
  // nominally are.
  const place_part = d.location_label ?? 'unknown_location';
  const source_label =
    `pirate_weather@${place_part} (via ${coords.source}, confidence=${coords.confidence}` +
    (coords.staleness_seconds !== null ? `, ${coords.staleness_seconds}s stale)` : ')');
  return {
    forecast: fresh({ source: source_label, value: d.forecast_summary }),
    precip: fresh({ source: source_label, value: d.precip_chance_today, unit: 'probability' }),
    high: fresh({ source: source_label, value: d.temperature_high_f, unit: '°F' }),
    low: fresh({ source: source_label, value: d.temperature_low_f, unit: '°F' }),
    alerts: fresh({ source: source_label, value: d.alert_count, unit: 'count' }),
  };
}

function day_iso_window(offset_days: number): { start: string; end: string } {
  const d = new Date();
  d.setDate(d.getDate() + offset_days);
  d.setHours(0, 0, 0, 0);
  const start = new Date(d).toISOString();
  d.setHours(23, 59, 59, 999);
  const end = new Date(d).toISOString();
  return { start, end };
}

function event_to_verified(e: CalendarSnapshotEventShape, tz: string): VerifiedCalendarEvent {
  return {
    summary: e.title,
    // Localize at the boundary so the LLM never sees raw UTC (16:00Z) and
    // can't render it as "4pm". `to_local_instant` is the only way to make
    // a LocalInstant; the brand makes `start: e.ts_start` not compile.
    start: to_local_instant(e.ts_start, tz),
    end: to_local_instant(e.ts_end, tz),
    all_day: Boolean(e.is_all_day),
    location: e.location ?? null,
    calendar: e.calendar_name,
  };
}

export function read_calendar_from_snapshot(
  memory: MemoryClient,
  user_id: string,
  tz: string,
): VerifiedCalendar {
  const snap = memory.query_calendar_snapshot(user_id);
  if (!snap) {
    return {
      status: 'unavailable',
      today: [],
      tomorrow: [],
      source_entities: [],
      reason:
        'no iOS calendar snapshot for this user yet (the iPhone has not posted to /api/sensors/calendar — first push lands on app foreground with EventKit permission granted)',
    };
  }
  const today_w = day_iso_window(0);
  const tomorrow_w = day_iso_window(1);
  // Bucket RAW events, sort by the UTC ISO `ts_start` (sortable), THEN
  // localize — sorting must key off the raw instant, not the localized
  // display string ("Sun 10:00 AM" wouldn't order correctly).
  const today_raw: CalendarSnapshotEventShape[] = [];
  const tomorrow_raw: CalendarSnapshotEventShape[] = [];
  for (const e of snap.events) {
    if (!e.ts_start) continue;
    if (e.ts_start >= today_w.start && e.ts_start <= today_w.end) {
      today_raw.push(e);
    } else if (e.ts_start > today_w.end && e.ts_start <= tomorrow_w.end) {
      tomorrow_raw.push(e);
    }
  }
  const by_start = (a: CalendarSnapshotEventShape, b: CalendarSnapshotEventShape) =>
    a.ts_start < b.ts_start ? -1 : a.ts_start > b.ts_start ? 1 : 0;
  today_raw.sort(by_start);
  tomorrow_raw.sort(by_start);
  return {
    status: 'fresh',
    today: today_raw.map((e) => event_to_verified(e, tz)),
    tomorrow: tomorrow_raw.map((e) => event_to_verified(e, tz)),
    source_entities: [`ios_sensor_snapshot@${snap.captured_at}`],
  };
}

/**
 * Reason stamped on the HA-sourced readings (EV SoC/range, indoor temp)
 * when a brief is built for a NON-owner recipient. Those sensors live on
 * the single admin-home Home Assistant instance, so for a household
 * member they are the admin's device data, not the recipient's — the
 * pump is suppressed and this explicit "no data" marker takes its place.
 * The brief prompt forbids Kate from filling an `unavailable` reading
 * from memory, so the scoping rides the existing grounding contract.
 * Until a per-user HA source exists, owner-only is the correct scope.
 */
const HA_OWNER_ONLY_REASON =
  'owner-only — EV charge and indoor-temp sensors live on the admin-home ' +
  "Home Assistant; a household-member brief does not carry the admin's device data";

/**
 * Pull verified life-context for Kate's brief. Safe to call at any
 * deliberation pass; returns a fully-shaped object with explicit
 * unavailable markers when sources aren't configured or are
 * unreachable.
 *
 * `user_id` is load-bearing for the per-user branches:
 *   - Weather coords resolve via `users.home_coords(user_id)` — each
 *     household member sees weather at THEIR home, not the captain's.
 *   - Calendar snapshot resolves via `memory.query_calendar_snapshot(user_id)` —
 *     each user's iOS app posts their own snapshot.
 *
 * `is_owner` scopes the HA-sourced readings (EV SoC/range, indoor temp).
 * Those come from the single admin-home Home Assistant instance, so they
 * are pumped ONLY for owner-tier briefs; a non-owner brief gets explicit
 * `unavailable` markers in their place (no admin device data leaks into a
 * household member's context, and the brief prompt's HARD RULE keeps Kate
 * from filling the gap from memory). When omitted, it is resolved from
 * `users.get(user_id).tier`, defaulting to owner when the registry can't
 * resolve the user — preserving legacy single-user behavior. Weather and
 * calendar are per-user regardless of tier.
 *
 * Pass `users` to enable per-user resolution; omitting it falls back
 * to "no home coords" everywhere (helpful for unit tests that don't
 * need the full registry).
 */
export async function pull_brief_context(args: {
  memory: MemoryClient;
  user_id: string;
  users?: UserRegistry;
  is_owner?: boolean;
}): Promise<VerifiedLifeContext> {
  // HA device readings come from the ONE admin-home Home Assistant, so they
  // are owner-only. Resolve the recipient tier from the explicit flag, else
  // from the registry, else owner (legacy single-user default).
  // Resolve tier honoring an explicit is_owner override when the registry
  // can't (e.g. a direct puller call with users undefined): a passed
  // is_owner:false means a household member, not the owner default.
  const tier =
    args.users?.get(args.user_id)?.tier ??
    (args.is_owner === false ? 'household' : 'owner');
  const is_owner = args.is_owner ?? (tier === 'owner');
  // FACET GATE (2026-06-15): the EV block is pumped for the OWNER unconditionally
  // (historically always present, and independent of whether a household block
  // is bound in this context) and for a NON-owner only when they have the `ev`
  // facet. So Jasper is byte-unchanged while a household member without it
  // (Sam) gets NO ev key at all — not an `unavailable` slot. This is the "no
  // mention of EV" fix at the data source. effective_facets falls open to
  // tier+household defaults when the user has never been onboarded.
  const stored =
    typeof args.memory.get_user_profile === 'function'
      ? args.memory.get_user_profile(args.user_id)
      : null;
  const has_ev =
    is_owner || effective_facets(stored, tier, get_household_context()).has('ev');
  // For a non-owner, the HA pump is replaced by an explicit owner-only
  // `unavailable` marker (same shape a read tool returns on a miss); weather
  // + calendar below stay per-user either way.
  const ha_owner_only = (): VerifiedReading => unavailable(null, HA_OWNER_ONLY_REASON);
  const [weather, indoor] = await Promise.all([
    read_weather_block(args.users, args.memory, args.user_id),
    is_owner ? read_ha_entity('HEARTH_BRIEF_INDOOR_TEMP_ENTITY', '°F') : ha_owner_only(),
  ]);
  // EV reads only when the user has the facet. The IONIQ5_* entities live on
  // the admin home HA, so they stay owner-gated for the VALUE; a non-owner who
  // (future) gains the ev facet gets the explicit owner-only marker.
  let ev: VerifiedLifeContext['ev'];
  if (has_ev) {
    const [soc, range] = await Promise.all([
      is_owner ? read_ha_entity('IONIQ5_SOC_ENTITY', '%') : ha_owner_only(),
      is_owner ? read_ha_entity('IONIQ5_RANGE_ENTITY', 'mi') : ha_owner_only(),
    ]);
    ev = { soc_percent: soc, range_miles: range };
  }
  // Resolve the user's zone once, here at the boundary — every calendar
  // event in the brief is localized to it. Denver fallback for an unknown
  // user (matches the deliberation `now` anchor's fallback).
  const tz = args.users?.get_timezone(args.user_id) ?? 'America/Denver';
  const cal = read_calendar_from_snapshot(args.memory, args.user_id, tz);
  // Relationship nudges — who's overdue to reconnect + occasions in the next
  // few weeks, cordoned to this user. Fail-open: a throw degrades to none.
  let relationships: RelationshipSignals = { overdue: [], occasions: [] };
  try {
    relationships = compute_relationship_signals(
      args.memory,
      { user_id: args.user_id, tier },
      local_iso_date(new Date(), tz),
    );
  } catch {
    /* keep empty */
  }
  return {
    generated_at: ts_now(),
    ...(ev ? { ev } : {}),
    weather: {
      forecast: weather.forecast,
      precip_probability_today: weather.precip,
      indoor_temp: indoor,
      temperature_high_today: weather.high,
      temperature_low_today: weather.low,
      active_alert_count: weather.alerts,
    },
    calendar: cal,
    relationships,
  };
}

// ── Warm life-context cache (for chat/voice pre-injection) ────────────────
//
// `pull_brief_context` makes NETWORK reads (Pirate weather API, HA entities) —
// fine for a scheduled deliberation pass, fatal for an interactive voice/chat
// turn that must answer in ~2s. So a background warmer (apps/orchestrator/
// server.ts) calls `pull_brief_context` on an interval and stows the result
// here; `kate_pack` (src/core/grounding_packs.ts) reads the warm entry and
// pre-injects weather + EV with ZERO live fetch. A cold/expired entry → the
// pack pre-injects nothing for those signals (the forced-tool backstop /
// model-decides covers the gap), so this never blocks a turn. The TTL is set
// generously above the warm interval so an entry is always fresh between warms;
// the weather connector's own 5-min (lat,lng) cache is what actually rate-limits
// the upstream API, not this TTL.

interface WarmLifeEntry {
  ctx: VerifiedLifeContext;
  cached_at_ms: number;
}

const _warm_life_context = new Map<string, WarmLifeEntry>();
const WARM_LIFE_CONTEXT_TTL_MS = 6 * 60_000;

/** Stow a freshly-pulled life-context for `user_id` (called by the warmer). */
export function put_warm_life_context(user_id: string, ctx: VerifiedLifeContext): void {
  _warm_life_context.set(user_id, { ctx, cached_at_ms: Date.now() });
}

/** Read the warm life-context for `user_id`, or null when cold/expired. */
export function get_warm_life_context(user_id: string): VerifiedLifeContext | null {
  const e = _warm_life_context.get(user_id);
  if (!e) return null;
  if (Date.now() - e.cached_at_ms > WARM_LIFE_CONTEXT_TTL_MS) {
    _warm_life_context.delete(user_id);
    return null;
  }
  return e.ctx;
}

/** Test-only: clear the warm cache between runs. */
export function _test_clear_warm_life_context(): void {
  _warm_life_context.clear();
}

/**
 * Render the FRESH readings of a VerifiedLifeContext as a flat text
 * corpus suitable for grounding (Durable-Truth Phase 1). Only
 * `status: 'fresh'` readings contribute — an `unavailable` reading is
 * an explicit "no data" marker and must NOT ground a claim (citing a
 * value for it is exactly the fabrication the brief grounding block
 * forbids). Each fresh reading emits its source label, value, and unit
 * so the provenance validator resolves both the value AND the source
 * entity name. Calendar events contribute their summary + location +
 * times. Used by domain_packs/index.ts → grounding for the deliberation
 * finalize validator.
 */
export function life_context_grounding_corpus(ctx: VerifiedLifeContext): string {
  const lines: string[] = [];
  const push_reading = (label: string, r: VerifiedReading) => {
    if (r.status !== 'fresh') return;
    const unit = r.unit ? ` ${r.unit}` : '';
    lines.push(`${label}: ${String(r.value)}${unit} (source: ${r.source_entity ?? 'unknown'})`);
  };
  if (ctx.ev) {
    push_reading('ev.soc_percent', ctx.ev.soc_percent);
    push_reading('ev.range_miles', ctx.ev.range_miles);
  }
  push_reading('weather.forecast', ctx.weather.forecast);
  push_reading('weather.precip_probability_today', ctx.weather.precip_probability_today);
  push_reading('weather.indoor_temp', ctx.weather.indoor_temp);
  push_reading('weather.temperature_high_today', ctx.weather.temperature_high_today);
  push_reading('weather.temperature_low_today', ctx.weather.temperature_low_today);
  push_reading('weather.active_alert_count', ctx.weather.active_alert_count);
  if (ctx.calendar.status === 'fresh') {
    for (const e of [...ctx.calendar.today, ...ctx.calendar.tomorrow]) {
      const loc = e.location ? ` at ${e.location}` : '';
      lines.push(`calendar: ${e.summary}${loc} ${e.start} ${e.end} (${e.calendar})`);
    }
    for (const src of ctx.calendar.source_entities) lines.push(`calendar source: ${src}`);
  }
  if (ctx.relationships) lines.push(...relationship_grounding_lines(ctx.relationships));
  return lines.join('\n');
}
