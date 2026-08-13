/**
 * Sensor-backed calendar tools — read from the iOS-sourced calendar
 * snapshot (POST /api/sensors/calendar from hearth-ios via EventKit).
 *
 * Why these exist: the HA-CalDAV integration was the prior path for
 * Kate's calendar reads. That integration carries an Apple
 * app-specific-password on the always-on host, doesn't scale to other household
 * residents, requires manual setup per user / per rotation, and
 * duplicates a pipeline iOS already ships. The deprecation brief
 * (hearth-ios/BACKEND_HA_CALDAV_DEPRECATION_BRIEF.md) is the canonical
 * spec for the cutover. These tools are the specialist-side surface
 * that replaces `caldav_upcoming` / `ha_calendar_query` on Kate's
 * curated tool list.
 *
 * Storage: the iOS app aggregates iCloud + Google + Exchange + every
 * other EventKit-visible calendar into one snapshot. Backend
 * DELETE+INSERTs into `calendar_snapshots` (one row per user). These
 * tools read that snapshot via MemoryClient.query_calendar_snapshot,
 * then derive the requested projection.
 *
 * If the snapshot hasn't been pushed yet (iOS app never foregrounded,
 * EventKit permission denied, etc.), the tools return a structured
 * recovery hint pointing at the iOS-side cause — same pattern as
 * `ha_get_state`'s 404 candidates. The LLM reads the hint and either
 * tells the user OR retries against a different signal source.
 *
 * Iris's `plan_ev_day` also reads this snapshot store directly (via
 * MemoryClient.query_calendar_snapshot) for its synchronous flow; the
 * HA-CalDAV path it used to call was retired 2026-06-14.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import { format_relative_when, to_local_instant, zoned_wall_to_utc_iso, type LocalInstant } from '@core/time';
import type { ToolDeps } from '@core/tool_deps';
import type {
  MemoryClient,
  CalendarSnapshotResult,
  CalendarSnapshotEventShape,
} from '@memory/client';

// ── Shared ───────────────────────────────────────────────────────────────

function resolve_user_id(input: { user_id?: string }, ctx: ToolContext): string {
  // ToolContext doesn't yet carry user_id in deliberation paths; chat
  // turns thread it via the turn's TurnUser. Until per-user briefs land
  // for non-owner users, env override + the documented single-owner
  // default is the right fallback.
  if (input.user_id) return input.user_id;
  const turn_user = (ctx as { turn_user?: { id?: string } }).turn_user;
  if (turn_user?.id) return turn_user.id;
  return process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
}

const NO_SNAPSHOT_HINT =
  'No iOS calendar snapshot has been posted for this user yet. The iPhone posts via POST /api/sensors/calendar on the next app foreground with EventKit permission granted. If iOS is foregrounded and the snapshot still does not arrive, check Settings → Privacy & Security → Calendars on the device (Hearth must be enabled) and the device-as-sensor consent in Hearth iOS Settings → Sensors.';

interface EventOut {
  event_id: string;
  title: string;
  // Localized to the user's zone — NOT raw UTC. The LLM never sees a
  // `...16:00:00Z` it can misread as "4pm" (the recurring farmers-market
  // bug). LocalInstant + the single `to_local_instant` door enforce it;
  // filtering/sorting still happen on the raw UTC `ts_start` upstream.
  when: LocalInstant;
  when_end: LocalInstant;
  location: string | null;
  is_all_day: boolean;
  calendar_name: string;
  organizer: string | null;
  has_attendees: boolean;
  notes_preview: string | null;
}

function event_to_out(e: CalendarSnapshotEventShape, tz: string): EventOut {
  return {
    event_id: e.event_id,
    title: e.title,
    // Relative-day marker + date + time ("Tomorrow (Fri, Jul 3) 9:00 AM") —
    // the day-mapping lives in the record, not the model (the 2026-07-02
    // late-evening "tomorrow is Saturday" voice miss). Cast keeps the
    // LocalInstant brand: this IS a localized instant, richer-rendered.
    when: (format_relative_when(e.ts_start, tz) ?? e.ts_start) as ReturnType<typeof to_local_instant>,
    when_end: to_local_instant(e.ts_end, tz),
    location: e.location ?? null,
    is_all_day: Boolean(e.is_all_day),
    calendar_name: e.calendar_name,
    organizer: e.organizer ?? null,
    has_attendees: e.has_attendees,
    notes_preview: e.notes_preview ?? null,
  };
}

function audit_calendar_tool(
  ctx: ToolContext,
  tool_name: string,
  input: Record<string, unknown>,
  result: unknown,
  error?: string,
): void {
  ctx.memory.log_action({
    intent_id: ctx.intent_id || ulid(),
    agent: ctx.specialist_id || 'sensor_calendar',
    tool_name,
    tool_input: input,
    execution_result: error
      ? undefined
      : {
          ok: !error,
          event_count: (result as { events?: unknown[] })?.events?.length ?? null,
        },
    error,
  });
}

/**
 * Normalize an `until` cap into an absolute UTC ISO instant so the upcoming
 * filter does a correct CHRONOLOGICAL comparison against event `ts_start`
 * values, not a lexicographic string compare.
 *
 * The model commonly resolves "tomorrow" to a BARE DATE ("2026-06-08").
 * Compared as a raw string that bugged out two ways (the 2026-06-07 voice
 * "your calendar is empty" incident): (1) "2026-06-08" sorts BEFORE every
 * "2026-06-08T..Z" timestamp on that day, so a bare-date cap excluded the
 * whole day's events; (2) it only sorts after `now` while `now` is still on
 * the PRIOR UTC day, so the cap silently disabled itself after 00:00Z —
 * making the result flip with the time of day.
 *
 * Fix: a bare date → the inclusive END of that local day in `tz` (so an
 * 8pm-local event that is technically next-day-UTC still counts as "today");
 * a zone-less wall-clock datetime → interpreted in `tz`; an already-absolute
 * instant (carries `Z`/offset) → passed straight through. Returns null on
 * unparseable input so the caller drops the cap rather than mis-filtering.
 */
function normalize_until_cap(until: string, tz: string): string | null {
  const s = until.trim();
  // Bare calendar date → inclusive end of that local day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return zoned_wall_to_utc_iso(`${s}T23:59:59`, tz);
  }
  // Zone-less wall-clock datetime → interpret in the user's zone.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    return zoned_wall_to_utc_iso(s, tz);
  }
  // Already an absolute instant (Z or ±offset) → normalize to UTC ISO.
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ── sensor_calendar_upcoming ─────────────────────────────────────────────

const UpcomingInput = z
  .object({
    /** Number of events to return, starting from now (max 100). */
    limit: z.number().int().min(1).max(100).default(10),
    /** Optional ISO window cap — events ending after this are filtered out. */
    until: z.string().optional(),
    /** Multi-user expansion; defaults to owner via env / turn_user. */
    user_id: z.string().optional(),
  })
  .strict();

const UpcomingOutput = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  recovery_hint: z.string().optional(),
  events: z
    .array(
      z.object({
        event_id: z.string(),
        title: z.string(),
        when: z.string(),
        when_end: z.string(),
        location: z.string().nullable(),
        is_all_day: z.boolean(),
        calendar_name: z.string(),
        organizer: z.string().nullable(),
        has_attendees: z.boolean(),
        notes_preview: z.string().nullable(),
      }),
    )
    .optional(),
  snapshot_captured_at: z.string().optional(),
  window_end: z.string().optional(),
});

type UpcomingIn = z.infer<typeof UpcomingInput>;
type UpcomingOut = z.infer<typeof UpcomingOutput>;

function make_sensor_calendar_upcoming(memory: MemoryClient): Tool<UpcomingIn, UpcomingOut> {
  return {
    name: 'sensor_calendar_upcoming',
    description:
      "List the user's next N calendar events across every account iOS sees (iCloud + Google + Exchange + Outlook + local), in chronological order. Reads the iOS-sourced calendar snapshot — NOT Home Assistant CalDAV (which is deprecated). Returns event_id, title, when, when_end (event times ALREADY LOCALIZED to the user's zone — state them verbatim, never re-convert), location, is_all_day, calendar_name (which account it lives on), organizer, has_attendees, notes_preview. Use this in chat turns when the user asks 'what's coming up', 'what's today', 'when am I free'; in deliberation, the verified_life_context block already exposes today + tomorrow. If the snapshot hasn't been posted yet (recovery_hint tells you why), don't fabricate events — surface the gap.",
    risk: 'read',
    required_capabilities: ['read_calendar'],
    input_schema: UpcomingInput,
    output_schema: UpcomingOutput,
    idempotency_key(input) {
      const key = `${input.user_id ?? 'env'}:${input.limit}:${input.until ?? ''}`;
      return `sensor_calendar_upcoming:${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
    },
    async execute(input, ctx) {
      const user_id = resolve_user_id(input, ctx);
      const snap: CalendarSnapshotResult | null = memory.query_calendar_snapshot(user_id);
      if (!snap) {
        const out: UpcomingOut = {
          ok: false,
          error: 'no calendar snapshot for user',
          recovery_hint: NO_SNAPSHOT_HINT,
        };
        audit_calendar_tool(ctx, 'sensor_calendar_upcoming', { user_id, ...input }, out, out.error);
        return out;
      }
      const tz = ctx.user?.timezone ?? 'America/Denver';
      const now_iso = new Date().toISOString();
      // `until` normalized to an absolute UTC instant (end-of-local-day for a
      // bare date) so this is a correct chronological comparison — not the
      // prior lexicographic date-vs-timestamp bug that silently emptied
      // "tomorrow" for any query before 00:00Z. See normalize_until_cap.
      const cap = input.until ? normalize_until_cap(input.until, tz) : null;
      const upcoming = snap.events
        .filter((e) => e.ts_start && e.ts_start >= now_iso)
        .filter((e) => (cap ? e.ts_start <= cap : true))
        .sort((a, b) => (a.ts_start < b.ts_start ? -1 : a.ts_start > b.ts_start ? 1 : 0))
        .slice(0, input.limit)
        .map((e) => event_to_out(e, tz));
      const out: UpcomingOut = {
        ok: true,
        events: upcoming,
        snapshot_captured_at: snap.captured_at,
        window_end: snap.window_end,
      };
      audit_calendar_tool(ctx, 'sensor_calendar_upcoming', { user_id, ...input }, out);
      return out;
    },
  };
}

// ── sensor_in_meeting ────────────────────────────────────────────────────

const InMeetingInput = z
  .object({
    user_id: z.string().optional(),
  })
  .strict();

const InMeetingOutput = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  recovery_hint: z.string().optional(),
  in_meeting: z.boolean().optional(),
  current_event: z
    .object({
      event_id: z.string(),
      title: z.string(),
      when: z.string(),
      when_end: z.string(),
      location: z.string().nullable(),
      calendar_name: z.string(),
    })
    .nullable()
    .optional(),
  snapshot_captured_at: z.string().optional(),
});

type InMeetingIn = z.infer<typeof InMeetingInput>;
type InMeetingOut = z.infer<typeof InMeetingOutput>;

function make_sensor_in_meeting(memory: MemoryClient): Tool<InMeetingIn, InMeetingOut> {
  return {
    name: 'sensor_in_meeting',
    description:
      "Is the user currently in a calendar event? Returns boolean + the current event details when true. Use this to decide whether to suppress non-critical chatter ('hold this until the meeting ends'), to time push notifications, or to answer 'are you free right now'. Reads the iOS-sourced calendar snapshot — accounts for every EventKit-visible calendar at once. All-day events count as 'in meeting' if they cover the current instant.",
    risk: 'read',
    required_capabilities: ['read_calendar'],
    input_schema: InMeetingInput,
    output_schema: InMeetingOutput,
    idempotency_key(input) {
      return `sensor_in_meeting:${input.user_id ?? 'env'}`;
    },
    async execute(input, ctx) {
      const user_id = resolve_user_id(input, ctx);
      const snap = memory.query_calendar_snapshot(user_id);
      if (!snap) {
        const out: InMeetingOut = {
          ok: false,
          error: 'no calendar snapshot for user',
          recovery_hint: NO_SNAPSHOT_HINT,
        };
        audit_calendar_tool(ctx, 'sensor_in_meeting', { user_id }, out, out.error);
        return out;
      }
      const tz = ctx.user?.timezone ?? 'America/Denver';
      const now_iso = new Date().toISOString();
      const active = snap.events.find(
        (e) => e.ts_start && e.ts_end && e.ts_start <= now_iso && e.ts_end >= now_iso,
      );
      const out: InMeetingOut = {
        ok: true,
        in_meeting: Boolean(active),
        current_event: active
          ? {
              event_id: active.event_id,
              title: active.title,
              when: to_local_instant(active.ts_start, tz),
              when_end: to_local_instant(active.ts_end, tz),
              location: active.location ?? null,
              calendar_name: active.calendar_name,
            }
          : null,
        snapshot_captured_at: snap.captured_at,
      };
      audit_calendar_tool(ctx, 'sensor_in_meeting', { user_id }, out);
      return out;
    },
  };
}

// ── sensor_free_blocks ───────────────────────────────────────────────────

const FreeBlocksInput = z
  .object({
    /** Minimum block size in minutes (5-480). */
    duration_min: z.number().int().min(5).max(480).default(30),
    /** Forward window in hours (1-720, i.e. up to 30 days). */
    window_hours: z.number().int().min(1).max(720).default(168),
    user_id: z.string().optional(),
  })
  .strict();

const FreeBlocksOutput = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  recovery_hint: z.string().optional(),
  blocks: z
    .array(
      z.object({
        start: z.string(),
        end: z.string(),
        duration_min: z.number(),
      }),
    )
    .optional(),
  duration_min: z.number().optional(),
  window_minutes: z.number().optional(),
});

type FreeBlocksIn = z.infer<typeof FreeBlocksInput>;
type FreeBlocksOut = z.infer<typeof FreeBlocksOutput>;

function make_sensor_free_blocks(memory: MemoryClient): Tool<FreeBlocksIn, FreeBlocksOut> {
  return {
    name: 'sensor_free_blocks',
    description:
      "Find gaps of at least `duration_min` minutes in the user's calendar over the next `window_hours` hours. Returns each free block as {start, end, duration_min}. Use this when proposing a meeting time, a focused work block, or any commitment that needs a confirmed hole in the schedule. Reads the iOS-sourced calendar snapshot. Returns an empty list when the calendar is fully booked — that's a real answer, not an error.",
    risk: 'read',
    required_capabilities: ['read_calendar'],
    input_schema: FreeBlocksInput,
    output_schema: FreeBlocksOutput,
    idempotency_key(input) {
      const key = `${input.user_id ?? 'env'}:${input.duration_min}:${input.window_hours}`;
      return `sensor_free_blocks:${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
    },
    async execute(input, ctx) {
      const user_id = resolve_user_id(input, ctx);
      const snap = memory.query_calendar_snapshot(user_id);
      if (!snap) {
        const out: FreeBlocksOut = {
          ok: false,
          error: 'no calendar snapshot for user',
          recovery_hint: NO_SNAPSHOT_HINT,
        };
        audit_calendar_tool(ctx, 'sensor_free_blocks', { user_id, ...input }, out, out.error);
        return out;
      }
      const now = Date.now();
      const window_ms = input.window_hours * 60 * 60_000;
      const end_ms = now + window_ms;
      const duration_ms = input.duration_min * 60_000;

      type Interval = { start: number; end: number };
      const busy: Interval[] = [];
      for (const e of snap.events) {
        const s_ms = Date.parse(e.ts_start);
        const e_ms = Date.parse(e.ts_end);
        if (!Number.isFinite(s_ms) || !Number.isFinite(e_ms)) continue;
        const cs = Math.max(s_ms, now);
        const ce = Math.min(e_ms, end_ms);
        if (cs < ce) busy.push({ start: cs, end: ce });
      }
      busy.sort((a, b) => a.start - b.start);
      const merged: Interval[] = [];
      for (const iv of busy) {
        const last = merged[merged.length - 1];
        if (last && iv.start <= last.end) {
          if (iv.end > last.end) last.end = iv.end;
        } else {
          merged.push({ ...iv });
        }
      }

      const blocks: Array<{ start: string; end: string; duration_min: number }> = [];
      let cursor = now;
      for (const iv of merged) {
        if (iv.start - cursor >= duration_ms) {
          blocks.push({
            start: new Date(cursor).toISOString(),
            end: new Date(iv.start).toISOString(),
            duration_min: Math.round((iv.start - cursor) / 60_000),
          });
        }
        cursor = Math.max(cursor, iv.end);
      }
      if (end_ms - cursor >= duration_ms) {
        blocks.push({
          start: new Date(cursor).toISOString(),
          end: new Date(end_ms).toISOString(),
          duration_min: Math.round((end_ms - cursor) / 60_000),
        });
      }

      const out: FreeBlocksOut = {
        ok: true,
        blocks,
        duration_min: input.duration_min,
        window_minutes: window_ms / 60_000,
      };
      audit_calendar_tool(ctx, 'sensor_free_blocks', { user_id, ...input }, out);
      return out;
    },
  };
}

// ── Loader factory ───────────────────────────────────────────────────────

export function create(deps: ToolDeps): Tool[] {
  return [
    make_sensor_calendar_upcoming(deps.memory),
    make_sensor_in_meeting(deps.memory),
    make_sensor_free_blocks(deps.memory),
  ];
}
