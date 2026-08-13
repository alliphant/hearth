/**
 * User-facing time formatting in the configured local zone.
 *
 * Per the system rule "All time stored as ISO 8601 UTC; local-display
 * is the UI's job" — but there are display strings, bucket keys, and
 * scheduler slot matches that the server bakes into output keyed to
 * "what local day / time is it for this user." Those callers must
 * route through this module instead of reading `getUTC*` or `getHours()`
 * from a `Date` directly, or they pick up the host clock by accident
 * (the May-2026 farmers-market bug — 9 AM event rendered as 3 PM —
 * was a `getUTCHours()` formatter in `proposal_render.ts`).
 *
 * Every helper takes an optional `tz` parameter that defaults to
 * `America/Denver`. Per-user timezone plumbing (resolving `tz` from
 * `users.yaml` / an iOS-supplied request header) is additive — pass
 * the resolved zone in and the helpers do the right thing without
 * a second migration.
 *
 * Server-internal logic (storage, dedup keys, audit timestamps,
 * comparisons) should still operate on UTC.
 */

const DEFAULT_TZ = 'America/Denver';

interface DateTimeFmtOpts extends Intl.DateTimeFormatOptions {
  timeZone: string;
}

function fmt(opts: DateTimeFmtOpts): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', opts);
}

/** "Tue 9:00 AM" — weekday + 12-hour time in the local zone. */
export function format_short_datetime(iso: string, tz: string = DEFAULT_TZ): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return fmt({
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
}

/**
 * A timestamp already localized to a user's zone — the ONLY string shape
 * permitted in an LLM-facing context's time fields. A raw ISO / UTC
 * `string` is NOT assignable to `LocalInstant`; the sole constructor is
 * `to_local_instant`, which forces a `tz`. Typing a context field as
 * `LocalInstant` turns "a raw UTC instant reached the model" into a
 * COMPILE ERROR — closing the farmers-market bug class (16:00Z read as
 * "4pm") structurally, instead of relying on every call site to remember
 * to format. That opt-in pattern is exactly what let the bug recur after
 * the 22-site audit; this makes the wrong thing un-representable.
 */
export type LocalInstant = string & { readonly __localInstant: 'LocalInstant' };

/**
 * The one door from a UTC instant to an LLM-facing local string. Render a
 * stored UTC ISO timestamp in the user's zone; the result is branded so it
 * can flow into `LocalInstant` context fields. Storage / sorting / dedup
 * still operate on the raw UTC ISO — localize only at the boundary where
 * a human (or an LLM speaking to one) reads it.
 */
export function to_local_instant(iso: string, tz: string = DEFAULT_TZ): LocalInstant {
  return (format_short_datetime(iso, tz) ?? iso) as LocalInstant;
}

/**
 * "Today 4:00 PM" | "Tomorrow (Fri, Jul 3) 9:00 AM" | "Sat, Jul 4 9:00 AM" —
 * an event instant rendered with an EXPLICIT relative-day marker + calendar
 * date, all in the user's zone (2026-07-02). The fix for the late-evening
 * off-by-one class: `sensor_calendar_upcoming` used to return weekday-only
 * labels ("Fri 9:00 AM"), and at 10:27 PM Thursday a voice turn — whose lean
 * prompt deliberately omits the weekday↔date table — read the first upcoming
 * "Fri" events as "today" and told the owner tomorrow was the 4th. Ambiguity
 * belongs OUT of the record, not patched in the persona: with Today/Tomorrow
 * and the date in the string, no model on any surface has day-mapping to do.
 * Today/Tomorrow are computed by LOCAL calendar date in `tz`, never UTC.
 */
export function format_relative_when(
  iso: string,
  tz: string = DEFAULT_TZ,
  now: Date = new Date(),
): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const day = local_iso_date(d, tz);
  const today = local_iso_date(now, tz);
  const tomorrow = local_iso_date(new Date(now.getTime() + 86_400_000), tz);
  const time = fmt({ timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  const wd_date = fmt({ timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  if (day === today) return `Today ${time}`;
  if (day === tomorrow) return `Tomorrow (${wd_date}) ${time}`;
  return `${wd_date} ${time}`;
}

/** "Sep 12" — month + day in the local zone. */
export function format_short_date(iso: string, tz: string = DEFAULT_TZ): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return fmt({
    timeZone: tz,
    month: 'short',
    day: 'numeric',
  }).format(d);
}

/**
 * The "right now" anchor every LLM turn reasons from — the current moment
 * in the user's zone PLUS an explicit 8-day weekday↔date table. This is the
 * ONE canonical builder; the chat turn (specialist_runtime) and the
 * deliberation / brief pass (deliberation.ts) both render it, so a
 * specialist's sense of "today / tomorrow / what weekday it is" is identical
 * on every surface — and grounded in the RECIPIENT's wall clock, never the
 * host's UTC. (The 2026-06-24 overnight brief read the UTC sort-instant out
 * of its JSON context and announced "It's 4 AM Thursday" at 10 PM Wednesday;
 * a single prominent local anchor — and dropping the UTC field from the
 * model-facing context — is the fix.)
 *
 * Qwen in think-off mode reliably gets day-of-week arithmetic wrong from an
 * ISO date alone, so we hand it the mapping rather than trust it to compute.
 * The moment line is human-readable; the table maps each upcoming weekday to
 * its ISO date so the model can line calendar-tool output (ISO strings) up
 * against weekday names.
 *
 * Output:
 *   Wednesday, June 24, 2026 at 10:00 PM MDT.
 *
 *   **The next 8 days** (use this table to map weekday names to dates — do
 *   not compute day-of-week from ISO dates yourself):
 *     - Today: Wednesday, June 24 (2026-06-24)
 *     - Tomorrow: Thursday, June 25 (2026-06-25)
 *     - Friday, June 26 (2026-06-26)
 *     ...
 */
export function format_now_anchor(tz: string = DEFAULT_TZ, now: Date = new Date()): string {
  const moment = fmt({
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(now);
  return (
    `${moment}.\n\n` +
    `**The next 8 days** (use this table to map weekday names to dates — ` +
    `do not compute day-of-week from ISO dates yourself):\n` +
    format_weekday_anchors(now, 8, tz)
  );
}

/**
 * The next N days as an explicit "weekday (ISO date)" lookup table — the
 * body of `format_now_anchor`, exported for any caller that wants the table
 * alone. Day 0 is prefixed "Today: ", day 1 "Tomorrow: ".
 */
export function format_weekday_anchors(
  now: Date = new Date(),
  days = 8,
  tz: string = DEFAULT_TZ,
): string {
  const day_label = fmt({ timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' });
  const lines: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getTime() + i * 86_400_000);
    const prefix = i === 0 ? 'Today: ' : i === 1 ? 'Tomorrow: ' : '';
    lines.push(`  - ${prefix}${day_label.format(d)} (${local_iso_date(d, tz)})`);
  }
  return lines.join('\n');
}

/**
 * "2026-05-29" — the local calendar date for an instant.
 *
 * Replaces every `d.toISOString().slice(0, 10)` that meant "what day
 * is this for the user." Use UTC slicing only for storage keys that
 * never get shown or matched against the user's wall clock.
 */
export function local_iso_date(d: Date | string = new Date(), tz: string = DEFAULT_TZ): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '';
  // en-CA returns YYYY-MM-DD in `Intl.DateTimeFormat`, regardless of locale.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * "2026-W24" — the ISO-8601 week (Monday-start; week 1 contains the
 * year's first Thursday) of the LOCAL calendar date for an instant.
 * Used as an aggregation bucket key — e.g. the runtime's
 * round-ceiling process-miss evidence_ref groups every exhaustion by
 * (specialist, local week) so a noisy week is ONE ledger row, not one
 * per occurrence.
 */
export function local_iso_week(d: Date | string = new Date(), tz: string = DEFAULT_TZ): string {
  const local = local_iso_date(d, tz);
  if (!local) return '';
  const [y, m, day] = local.split('-').map((s) => Number.parseInt(s, 10));
  if (!y || !m || !day) return '';
  // UTC date arithmetic on the already-localized calendar date — the tz
  // conversion happened in local_iso_date; from here it's pure math.
  const date = new Date(Date.UTC(y, m - 1, day));
  // ISO week: shift to the Thursday of this week, whose year is the
  // ISO year; week number = Thursdays elapsed since Jan 1 of that year.
  const dow = date.getUTCDay() || 7; // Mon=1 … Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dow);
  const iso_year = date.getUTCFullYear();
  const jan1 = new Date(Date.UTC(iso_year, 0, 1));
  const week = Math.ceil(((date.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);
  return `${iso_year}-W${String(week).padStart(2, '0')}`;
}

/**
 * "07:00" — wall-clock HH:MM in the local zone. Used by the deliberation
 * loop in `loops.ts` to match `proactive.deliberation_at` slots.
 *
 * Don't use `now.getHours()` / `now.getMinutes()` for slot matching —
 * those read the *host* clock, so Kate's 07:00 brief fires at 01:00
 * Denver if the container is in UTC.
 */
export function local_hhmm(d: Date = new Date(), tz: string = DEFAULT_TZ): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

/**
 * "mon" — lowercase short weekday of the LOCAL calendar date for an
 * instant. The companion of `local_hhmm` for day-of-week gates
 * (`proactive.deliberation_dow`, background-job `dow`): both must read
 * the same wall clock or a Sunday-23:30 slot in a UTC container gates
 * against Monday. Values match the `DowEnum` in specialist.ts
 * ('sun' … 'sat', `Date.getDay()` order).
 */
export function local_dow(
  d: Date = new Date(),
  tz: string = DEFAULT_TZ,
): 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' {
  const short = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  })
    .format(d)
    .slice(0, 3)
    .toLowerCase();
  const all = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
  return all.find((x) => x === short) ?? 'sun';
}

/**
 * "2026-05-29 07:00" — local-zone date+minute, the shape used by the
 * memory-file dated-entry headers in `memory_files.ts`.
 */
export function local_iso_minute(d: Date = new Date(), tz: string = DEFAULT_TZ): string {
  return `${local_iso_date(d, tz)} ${local_hhmm(d, tz)}`;
}

/**
 * The UTC instant when the local zone's "today" began. Used by SQL
 * filters that bucket by Denver day against UTC `ts_created` columns
 * ("how many conversations today" / "show me today's audit rows").
 *
 * Computed from formatToParts so DST transitions don't introduce
 * a one-hour drift.
 */
export function local_day_start(d: Date = new Date(), tz: string = DEFAULT_TZ): Date {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
  const ms_into_day = get('hour') * 3_600_000 + get('minute') * 60_000 + get('second') * 1_000;
  return new Date(d.getTime() - ms_into_day);
}

/** The offset (local − UTC, in ms) of `tz` AT a given UTC instant. DST-aware
 *  because it measures the zone at that specific instant, not at "now". */
function tz_offset_ms(utc_ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utc_ms));
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
  let hour = get('hour');
  if (hour === 24) hour = 0; // en-GB renders local midnight as "24"
  const as_utc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return as_utc - utc_ms;
}

/**
 * Inverse of the display helpers: a naive local WALL-CLOCK datetime
 * ("YYYY-MM-DDTHH:MM" or "...:SS", with no zone) interpreted in `tz`,
 * returned as the absolute UTC instant — a second-precision ISO string
 * ending in `Z`. e.g. "2026-06-13T16:00:00" + America/Denver (MDT) →
 * "2026-06-13T22:00:00Z".
 *
 * This is the one door for the calendar-WRITE path: a specialist proposes
 * an event in the user's wall-clock ("Saturday 4pm"); storage and the iOS
 * EventKit write need the absolute instant. The mirror of `to_local_instant`
 * (which is the read door, UTC → local display).
 *
 * Two deliberate properties:
 *  - **Second precision, no fractional seconds.** iOS's default
 *    `ISO8601DateFormatter` REJECTS a `.000Z` fraction (returns nil) — a
 *    millisecond suffix would make the iOS coordinator silently drop the
 *    proposal. Calendar events don't need sub-second resolution anyway.
 *  - **DST-correct.** It measures the zone's offset at the candidate
 *    instant and refines once, so an event a minute either side of a DST
 *    transition still resolves to the intended wall-clock. The single
 *    genuinely-ambiguous fall-back hour per year resolves to the earlier
 *    offset — acceptable for an appointment time.
 *
 * Returns null on malformed input so a caller rejects rather than
 * fabricates a time.
 */
export function zoned_wall_to_utc_iso(
  naive_local: string,
  tz: string = DEFAULT_TZ,
): string | null {
  const m = naive_local
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m;
  if (!Y || !Mo || !D || !H || !Mi) return null; // narrow under noUncheckedIndexedAccess
  const wall = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, S ? +S : 0);
  if (Number.isNaN(wall)) return null;
  // Guess the wall-clock is UTC, measure the zone's offset there, then
  // refine once at the corrected instant (resolves the DST edge).
  const o1 = tz_offset_ms(wall, tz);
  const o2 = tz_offset_ms(wall - o1, tz);
  return `${new Date(wall - o2).toISOString().slice(0, 19)}Z`;
}

/**
 * "Block the whole of <YYYY-MM-DD>" as the UTC instant of that local
 * day's midnight in `tz`. Used by the all-day calendar-write path — iOS
 * sets `EKEvent.isAllDay = true` and EventKit takes the calendar day
 * containing this instant in the device zone, so local-midnight is the
 * correct anchor. Returns null on a malformed date.
 */
export function local_midnight_utc_iso(
  date: string,
  tz: string = DEFAULT_TZ,
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) return null;
  return zoned_wall_to_utc_iso(`${date.trim()}T00:00:00`, tz);
}
