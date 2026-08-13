import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ProposalsStore, CalendarEventPayload } from '@core/proposals';
import { zoned_wall_to_utc_iso, local_midnight_utc_iso } from '@core/time';

/**
 * Kate's calendar-write helper — proposes adding OR moving a calendar
 * event via the iOS EventKit write-back path.
 *
 * It does NOT write a calendar directly. It creates a proposal of
 * `kind: 'calendar_event'`; the runtime fires a `calendar_event_proposed`
 * SSE event (see proposal_events.ts), and the iOS app's
 * CalendarWritebackCoordinator surfaces a confirmation sheet, writes the
 * event to `EKEventStore` against the user-picked calendar on approval,
 * and POSTs the decide endpoint back. iOS's native sync engine then
 * propagates to iCloud / Google / Exchange — no server-side calendar
 * credentials anywhere (the HA-CalDAV path this replaced needed an Apple
 * app-specific password on the box; see BACKEND_HA_CALDAV_DEPRECATION_BRIEF).
 *
 * Two write shapes ride the same proposal:
 *  - **Add** — no `replaces_event_id`. A fresh event.
 *  - **Move/reschedule** — `replaces_event_id` set to an existing event's
 *    iOS id (from sensor_calendar_upcoming). iOS relocates that event IN
 *    PLACE rather than creating a duplicate. This is the only path on
 *    which a true "move" is possible — HA's REST surface exposes only
 *    create_event, no delete/update.
 *
 * Time contract: the model passes the user's LOCAL wall-clock
 * (`start_date_time: "2026-06-13T16:00:00"`, no zone); execute() resolves
 * the user's timezone and converts to the absolute UTC instant the
 * payload + iOS need. `end_date_time` is optional — a user who says "4pm"
 * gave a start, not a duration, so a missing end defaults to one hour
 * later instead of forcing the model into the all-day fallback (the
 * arg-spiral that produced the original all-day-at-the-wrong-time bug).
 */

const InputSchema = z
  .object({
    summary: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    location: z.string().max(200).optional(),
    /** Which of the user's calendars to land on. iOS maps this to a real
     *  account (household → shared family, personal → iCloud default,
     *  work → Exchange) and lets the user override at confirm time. */
    calendar_hint: z.enum(['work', 'personal', 'household']).optional(),
    /** Timed event: local wall-clock, no zone, e.g. "2026-06-13T16:00:00". */
    start_date_time: z.string().optional(),
    /** Optional — defaults to start_date_time + 1 hour. */
    end_date_time: z.string().optional(),
    // NOTE: no `.regex()` on the date fields — a tool input_schema becomes a
    // GBNF grammar on the interactive 9B, and llama.cpp's converter
    // mistranslates a regex `pattern` and SILENTLY disables the whole tool
    // grammar. The YYYY-MM-DD shape is already enforced in execute() (via
    // local_midnight_utc_iso → throws "must be YYYY-MM-DD" on a bad value).
    /** All-day event: YYYY-MM-DD. */
    start_date: z.string().optional(),
    /** Optional — all-day end (exclusive); defaults to start_date + 1 day. */
    end_date: z.string().optional(),
    /** Set to MOVE an existing event in place instead of adding a new one.
     *  The iOS event_id from sensor_calendar_upcoming. */
    replaces_event_id: z.string().min(1).optional(),
    rationale: z.string().min(1).max(1000),
  })
  .refine(
    // Timed needs start_date_time (end defaults to +1h); all-day needs
    // start_date (end defaults to the next day). Neither forces the
    // model to supply an end it doesn't have.
    (d) => Boolean(d.start_date_time || d.start_date),
    {
      message:
        'Provide start_date_time (timed event, e.g. "2026-06-13T16:00:00"; end_date_time is OPTIONAL and defaults to one hour later) OR start_date (all-day, YYYY-MM-DD).',
    },
  );

function next_day_iso(d: string): string {
  // start_date is YYYY-MM-DD; UTC math is safe because we never touch a
  // time component. All-day end is exclusive (HA/EventKit convention):
  // start = 2026-06-28, end = 2026-06-29 = "all of 6/28".
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1); // time-guard-ok: UTC date arithmetic on a date-only value (all-day end is exclusive)
  return t.toISOString().slice(0, 10); // time-guard-ok: UTC-anchored date-only render (no time component)
}

const OutputSchema = z.object({
  proposal_id: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_schedule_calendar_event(
  proposals: ProposalsStore,
): Tool<Input, Output> {
  return {
    name: 'schedule_calendar_event',
    description:
      "Propose adding an event to the user's calendar — or MOVING an existing one. Creates a proposal the user confirms on their iPhone; Hearth then writes it natively via iOS, syncing to iCloud / Google / Exchange (no server-side calendar credentials). Use for appointments, reminders, anniversaries, plans. " +
      'TIMED event: pass start_date_time as the user\'s LOCAL wall-clock with NO timezone, e.g. "2026-06-13T16:00:00" for 4 PM. end_date_time is OPTIONAL — omit it and the event is one hour long; do not invent an end the user did not give. ' +
      'ALL-DAY event (birthday / anniversary / holiday): pass start_date as YYYY-MM-DD; end_date is optional. ' +
      'MOVING / rescheduling: FIRST call sensor_calendar_upcoming to find the event and read its event_id, THEN call this with replaces_event_id set to that id and the NEW start_date_time. That relocates the original in place — it does NOT create a duplicate. ' +
      "calendar_hint routes which calendar it lands on: 'household' (shared with the family — joint plans, things others should see), 'personal' (private — surprises, solo commitments), or 'work'. Default to 'household' for shared plans, 'personal' for private ones. The user can change the calendar when confirming.",
    risk: 'write_internal',
    required_capabilities: ['write_caldav', 'write_proposals'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.summary);
      h.update('\n');
      h.update(input.start_date_time ?? input.start_date ?? '');
      h.update('\n');
      h.update(input.replaces_event_id ?? '');
      return `schedule_calendar_event:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext) {
      // The user's wall-clock is in THEIR zone. Resolve it (chat turns
      // thread user.timezone); the time helpers fall back to America/Denver
      // when undefined.
      const tz = ctx.user?.timezone;

      let ts_start: string | null;
      let ts_end: string | null;
      let is_all_day = false;

      if (input.start_date_time) {
        ts_start = zoned_wall_to_utc_iso(input.start_date_time, tz);
        if (!ts_start) {
          throw new Error(
            `start_date_time must be a local wall-clock datetime like "2026-06-13T16:00:00" (no timezone). Got: ${input.start_date_time}`,
          );
        }
        if (input.end_date_time) {
          ts_end = zoned_wall_to_utc_iso(input.end_date_time, tz);
          if (!ts_end) {
            throw new Error(
              `end_date_time must be a local wall-clock datetime like "2026-06-13T17:00:00" (no timezone). Got: ${input.end_date_time}`,
            );
          }
        } else {
          // No end given — default to one hour after the start. The user
          // supplied a start, not a duration.
          ts_end = `${new Date(Date.parse(ts_start) + 3_600_000).toISOString().slice(0, 19)}Z`;
        }
      } else if (input.start_date) {
        is_all_day = true;
        ts_start = local_midnight_utc_iso(input.start_date, tz);
        if (!ts_start) {
          throw new Error(`start_date must be YYYY-MM-DD. Got: ${input.start_date}`);
        }
        const end_date = input.end_date ?? next_day_iso(input.start_date);
        ts_end = local_midnight_utc_iso(end_date, tz);
        if (!ts_end) {
          throw new Error(`end_date must be YYYY-MM-DD. Got: ${end_date}`);
        }
      } else {
        // refine() guards this; defensive only.
        throw new Error('Provide start_date_time (timed) or start_date (all-day).');
      }

      const payload: CalendarEventPayload = {
        title: input.summary,
        ts_start,
        ts_end,
        rationale_md: input.rationale,
      };
      if (input.location) payload.location = input.location;
      if (input.description) payload.notes = input.description;
      if (input.calendar_hint) payload.calendar_hint = input.calendar_hint;
      if (input.replaces_event_id) payload.replaces_event_id = input.replaces_event_id;
      if (is_all_day) payload.is_all_day = true;

      const proposal_id = proposals.create({
        specialist_id: 'kate',
        kind: 'calendar_event',
        // Cordon the calendar write to the user it's for.
        user_id: ctx.user?.id ?? null,
        // The actual write happens ON the user's device (iOS EKEventStore);
        // the backend never executes it server-side. 'none' keeps the
        // proposal from claiming a server-side execution it didn't do —
        // it lands 'approved' and iOS reports the EKEvent id via the
        // decide call's modifications.
        execution_kind: 'none',
        payload,
        rationale: input.rationale,
        signature: {
          // Anchor on the calendar_hint so trust earned adding to the
          // household calendar doesn't silently extend to the work one.
          specialist_id: 'kate',
          kind: 'calendar_event',
          category: 'calendar',
          anchor: input.calendar_hint ?? 'personal',
        },
      });

      return { proposal_id };
    },
  };
}
