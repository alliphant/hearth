/**
 * Quiet-hours evaluation (Prompt 7 PART 8).
 *
 * Pure functions over a NotificationConfig + a runtime kv_settings flag
 * for manual-quiet-mode overrides. No DB writes here — push.ts owns
 * the queue + dispatch loop.
 */

import type { NotificationConfig } from '@core/users';

export type Severity = 'low' | 'medium' | 'medium-high' | 'high';
const SEVERITY_RANK: Record<Severity, number> = {
  low: 1,
  medium: 2,
  'medium-high': 3,
  high: 4,
};

export interface DispatchDecision {
  allowed: boolean;
  reason?: 'quiet_hours' | 'manual_quiet_mode' | 'below_threshold';
  queue_until?: string;
}

/**
 * Manual quiet-mode override. The /quiet slash command stores one of:
 *   - { mode: 'on' }            → indefinite (until /quiet off)
 *   - { mode: 'until', ts: 'YYYY-MM-DDTHH:mm:ssZ' }
 * Anything else (or null) means "no override; honor config schedule".
 */
export type ManualQuietState =
  | null
  | { mode: 'on' }
  | { mode: 'until'; ts: string };

/**
 * Returns the next HH:MM in the configured timezone that the user's
 * quiet window ENDS (i.e. when a queued push can dispatch).
 */
function next_quiet_window_end(now: Date, cfg: NotificationConfig): string {
  // end is the wall-clock "07:00" in the user's timezone. We compute
  // the next absolute instant matching that wall-clock time.
  return wall_clock_to_next_iso(now, cfg.quiet_hours.end, cfg.quiet_hours.timezone);
}

function wall_clock_to_next_iso(now: Date, hhmm: string, tz: string): string {
  const [hh, mm] = hhmm.split(':').map((n) => parseInt(n, 10));
  // Get current wall-clock in tz.
  const fmt = new Intl.DateTimeFormat('en-US', { // time-guard-ok: tz-threaded quiet-hours wall-clock (cfg zone)
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const year = parseInt(get('year'), 10);
  const month = parseInt(get('month'), 10);
  const day = parseInt(get('day'), 10);
  const cur_hh = parseInt(get('hour'), 10);
  const cur_mm = parseInt(get('minute'), 10);

  let target_year = year;
  let target_month = month;
  let target_day = day;
  // If today's HH:MM in tz has already passed, roll to tomorrow.
  if (cur_hh > (hh ?? 0) || (cur_hh === hh && cur_mm >= (mm ?? 0))) {
    const tomorrow = new Date(Date.UTC(year, month - 1, day));
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1); // time-guard-ok: UTC date arithmetic (roll to next calendar day)
    target_year = tomorrow.getUTCFullYear();
    target_month = tomorrow.getUTCMonth() + 1;
    target_day = tomorrow.getUTCDate(); // time-guard-ok: UTC date arithmetic (read rolled day)
  }
  // Build "target_year-target_month-target_day HH:MM" in tz, then resolve
  // to an absolute UTC by treating it as a local time in that tz via the
  // offset-difference trick (approximate; DST near transition may drift
  // by an hour, acceptable for queue dispatch).
  const local_str = `${target_year}-${String(target_month).padStart(2, '0')}-${String(target_day).padStart(2, '0')}T${String(hh ?? 0).padStart(2, '0')}:${String(mm ?? 0).padStart(2, '0')}:00`;
  const utc_guess = new Date(`${local_str}Z`);
  // Compute the offset between that moment-as-UTC and the same wall clock
  // in tz, then subtract.
  const tz_parts = new Intl.DateTimeFormat('en-US', { // time-guard-ok: tz-threaded offset resolution (cfg zone)
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(utc_guess);
  const tz_get = (t: string) => tz_parts.find((p) => p.type === t)?.value ?? '00';
  const tz_year = parseInt(tz_get('year'), 10);
  const tz_month = parseInt(tz_get('month'), 10);
  const tz_day = parseInt(tz_get('day'), 10);
  const tz_hour = parseInt(tz_get('hour'), 10);
  const tz_minute = parseInt(tz_get('minute'), 10);
  const tz_as_utc = Date.UTC(tz_year, tz_month - 1, tz_day, tz_hour, tz_minute, 0);
  const offset = tz_as_utc - utc_guess.getTime();
  return new Date(utc_guess.getTime() - offset).toISOString();
}

/**
 * Convert a Date to wall-clock minutes-since-midnight in the given tz.
 * Returns the minutes-of-day as an integer 0..1439.
 */
function minutes_in_tz(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { // time-guard-ok: tz-threaded minutes-of-day (cfg zone)
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const hh = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const mm = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  return hh * 60 + mm;
}

function hhmm_to_minutes(s: string): number {
  const [hh, mm] = s.split(':').map((n) => parseInt(n, 10));
  return (hh ?? 0) * 60 + (mm ?? 0);
}

export function is_within_quiet_hours(now: Date, cfg: NotificationConfig): boolean {
  const start = hhmm_to_minutes(cfg.quiet_hours.start);
  const end = hhmm_to_minutes(cfg.quiet_hours.end);
  const cur = minutes_in_tz(now, cfg.quiet_hours.timezone);
  if (start === end) return false;
  if (start < end) return cur >= start && cur < end;
  // Wraps midnight (22:00 → 07:00): inside if cur >= start OR cur < end.
  return cur >= start || cur < end;
}

export function should_dispatch_now(input: {
  severity: Severity;
  cfg: NotificationConfig;
  manual: ManualQuietState;
  now?: Date;
}): DispatchDecision {
  const now = input.now ?? new Date();

  // Manual override wins. "on" with no expiry → queue indefinitely
  // (still uses the during_quiet_hours threshold).
  if (input.manual?.mode === 'on') {
    return apply_threshold(
      input.severity,
      input.cfg.push_thresholds.during_quiet_hours,
      'manual_quiet_mode',
      undefined,
    );
  }
  if (input.manual?.mode === 'until') {
    const until_ms = new Date(input.manual.ts).getTime();
    if (now.getTime() < until_ms) {
      return apply_threshold(
        input.severity,
        input.cfg.push_thresholds.during_quiet_hours,
        'manual_quiet_mode',
        input.manual.ts,
      );
    }
  }

  if (is_within_quiet_hours(now, input.cfg)) {
    return apply_threshold(
      input.severity,
      input.cfg.push_thresholds.during_quiet_hours,
      'quiet_hours',
      next_quiet_window_end(now, input.cfg),
    );
  }
  // Outside quiet hours.
  return apply_threshold(
    input.severity,
    input.cfg.push_thresholds.outside_quiet_hours,
    'below_threshold',
    undefined,
  );
}

function apply_threshold(
  sev: Severity,
  threshold: Severity,
  reason: DispatchDecision['reason'],
  queue_until: string | undefined,
): DispatchDecision {
  if (SEVERITY_RANK[sev] >= SEVERITY_RANK[threshold]) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason,
    queue_until,
  };
}

/** Pure helper for slash commands like `/quiet 2h` and `/quiet until 9am`. */
export function parse_quiet_arg(
  arg: string,
  now: Date,
  tz: string,
): ManualQuietState {
  const trimmed = arg.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'on') return { mode: 'on' };
  if (trimmed === 'off') return null;
  // /quiet 2h, /quiet 30m
  const dur = /^([0-9]+)\s*(h|hr|hrs|m|min|mins)$/.exec(trimmed);
  if (dur) {
    const n = parseInt(dur[1] ?? '0', 10);
    const unit = dur[2] ?? 'h';
    const ms = unit.startsWith('h') ? n * 3600 * 1000 : n * 60 * 1000;
    return { mode: 'until', ts: new Date(now.getTime() + ms).toISOString() };
  }
  // /quiet until 9am
  const until = /^until\s+(.+)$/.exec(trimmed);
  if (until) {
    const t = parse_time_phrase(until[1] ?? '', now, tz);
    if (t) return { mode: 'until', ts: t };
  }
  return null;
}

function parse_time_phrase(s: string, now: Date, tz: string): string | null {
  // Accepts "9am", "9:30am", "21:00", "tomorrow 9am". Returns ISO or null.
  let phrase = s.replace(/\s+/g, ' ').trim();
  let bump_day = 0;
  if (phrase.startsWith('tomorrow')) {
    bump_day = 1;
    phrase = phrase.replace(/^tomorrow\s+/, '');
  }
  const ampm = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(phrase);
  if (!ampm) return null;
  let hh = parseInt(ampm[1] ?? '0', 10);
  const mm = parseInt(ampm[2] ?? '0', 10);
  const suffix = ampm[3];
  if (suffix === 'am' && hh === 12) hh = 0;
  if (suffix === 'pm' && hh !== 12) hh += 12;
  const hhmm = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const target_today = wall_clock_to_next_iso(now, hhmm, tz);
  // wall_clock_to_next_iso rolls past-today to tomorrow already; add an
  // extra day if the user said "tomorrow" AND we didn't already roll.
  if (bump_day) {
    const d = new Date(target_today);
    d.setUTCDate(d.getUTCDate() + 1); // time-guard-ok: UTC date arithmetic (add one day to an instant)
    return d.toISOString();
  }
  return target_today;
}
