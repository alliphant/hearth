/**
 * standing_duties — the scheduled half of a deliberation addendum, as data.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A mature `deliberation_addendum` is mostly a rota written as prose, and the
 * prose asks the model to do two things it is measurably bad at before it gets
 * to the part it is good at:
 *
 *   "**House, MONDAYS only (check the date line):** … diff for due/overdue
 *    inside 14 days and lead-time items inside 90 … Not Monday → skip entirely."
 *   "At the 07:00 slot, call `upcoming_dates` — days_ahead=60 on Mondays (the
 *    full planning sweep), 7 the other mornings."
 *
 * Both require the model to work out what day it is and then pick a parameter
 * or a branch from that. Day-of-week is precisely the reasoning the runtime
 * already distrusts enough to ship an eight-day anchor table for — so gating a
 * weekly duty on it builds the rota on the known-weak spot. When it slips there
 * is no error: the Monday pass simply doesn't happen, or happens on a Thursday,
 * and nothing anywhere records that it didn't. That silence is the real cost;
 * the tokens are incidental.
 *
 * ── What changes ────────────────────────────────────────────────────────────
 * The schedule becomes declarative and the runtime resolves it. For a given
 * pass we know the slot, the local date and the weekday with certainty, so we
 * can hand the model the duties that are ACTUALLY due, with every parameter
 * already chosen and every day-window already converted to an absolute date. A
 * duty that is not due is not rendered at all — it cannot be forgotten, and it
 * cannot be run on the wrong day, because it is not in the prompt.
 *
 * What stays in prose is the part that was always the specialist's job: what
 * counts as an anomaly, when quiet is a finding, when a line becomes a
 * proposal. That is judgment, and it does not belong in a config table any more
 * than the date arithmetic belonged in the persona.
 *
 * ── Relationship to `tool_reflexes` ─────────────────────────────────────────
 * Same move, different surface. Reflexes are chat: "this ask ⇒ this tool."
 * Duties are the scheduled pass: "this slot ⇒ these tools, with these
 * parameters, today." Both replace repeated prose with linted config; both are
 * verified by a CI smoke, which is what makes them safe to state imperatively.
 */

import { local_dow, local_iso_date } from './time';

/** Lowercase short weekday names, matching `local_dow` and the `dow` gate used
 *  by background jobs — so a duty's weekday filter reads identically to a
 *  job's. */
export type Dow = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

/** One tool call a duty performs, with any static arguments already chosen. */
export interface DutyStep {
  tool: string;
  input?: Record<string, unknown>;
  /** Optional one-clause note about reading THIS call's result. */
  note?: string;
}

export interface StandingDuty {
  id: string;
  title: string;
  /** Deliberation slots this duty belongs to, or `['*']` for every slot. */
  slots: string[];
  /** Restrict to these local weekdays. Omit = every day. */
  dow?: Dow[];
  /** Only when the local day-of-month ≤ this. With `dow:['mon']`, `dom_max:7`
   *  is "the first Monday of the month". */
  dom_max?: number;
  steps: DutyStep[];
  /** Named day-windows, resolved to absolute dates at render time so the model
   *  never computes one. `{ due_soon: 14 }` renders as an on-or-before date. */
  windows?: Record<string, number>;
  /** The part that stays prose: what counts as a finding, and what to do. */
  judgment?: string;
}

/** Local day-of-month, in the recipient's zone (not the server's). */
function local_dom(now: Date, tz: string): number {
  const iso = local_iso_date(now, tz); // YYYY-MM-DD
  return Number(iso.slice(8, 10));
}

/**
 * Add `days` to the local date and return it as YYYY-MM-DD.
 *
 * Deliberately computed on the local CALENDAR date rather than by adding
 * milliseconds to the instant: a DST transition inside the window would shift
 * a ms-based result by a day, and "due on or before the 17th" must not depend
 * on whether the clocks changed. Constructed at UTC noon so the ±12h zone
 * spread can never roll the date either.
 */
export function local_date_plus(now: Date, tz: string, days: number): string {
  const [y, m, d] = local_iso_date(now, tz).split('-').map(Number);
  const anchor = new Date(Date.UTC(y!, m! - 1, d!, 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() + days); // time-guard-ok: pure calendar math on a date local_iso_date already localized
  return anchor.toISOString().slice(0, 10); // time-guard-ok: reads back that shifted local calendar date, not the host clock
}

/** Is this duty due for `slot` at this local moment? */
export function duty_is_due(duty: StandingDuty, slot: string, now: Date, tz: string): boolean {
  const slot_ok = duty.slots.includes('*') || duty.slots.includes(slot);
  if (!slot_ok) return false;
  if (duty.dow && !duty.dow.includes(local_dow(now, tz))) return false;
  if (duty.dom_max !== undefined && local_dom(now, tz) > duty.dom_max) return false;
  return true;
}

const DOW_LONG: Record<Dow, string> = {
  sun: 'Sunday',
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
};

/**
 * Render the duties due for THIS pass.
 *
 * Returns `''` when the specialist declares none, or when none are due — an
 * empty rota is a real answer ("nothing scheduled for this slot"), but it needs
 * no prompt real estate to say so, and an un-migrated specialist's prompt stays
 * byte-identical.
 */
export function render_standing_duties(
  duties: readonly StandingDuty[],
  slot: string,
  now: Date,
  tz: string,
): string {
  if (duties.length === 0) return '';
  const due = duties.filter((d) => duty_is_due(d, slot, now, tz));
  if (due.length === 0) return '';

  const today = local_iso_date(now, tz);
  const weekday = DOW_LONG[local_dow(now, tz)];

  const lines: string[] = [];
  lines.push(`**STANDING DUTIES — ${slot}, ${weekday} ${today}.**`);
  lines.push('');
  lines.push(
    'The rota below has ALREADY been resolved against the calendar for you. ' +
      'These are the duties due right now — all of them, and only them. Do not ' +
      'work out from the date whether something else is due: a duty that is not ' +
      'listed is not due for this pass, and one that is listed is. Every window ' +
      'is given as an absolute date, so never compute one from a number of days.',
  );
  lines.push('');
  lines.push(
    'These are GLANCES, not reports. On most passes the honest outcome of most ' +
      'of them is nothing at all, and reporting nothing is the correct result — ' +
      'quiet is a finding, not an empty one.',
  );

  for (const d of due) {
    lines.push('');
    lines.push(`— **${d.title}**`);
    for (const s of d.steps) {
      const args =
        s.input && Object.keys(s.input).length > 0 ? ` with ${JSON.stringify(s.input)}` : '';
      lines.push(`  · call \`${s.tool}\`${args}${s.note ? ` — ${s.note}` : ''}`);
    }
    for (const [name, days] of Object.entries(d.windows ?? {})) {
      lines.push(
        `  · ${name}: on or before **${local_date_plus(now, tz, days)}** (${days} days out)`,
      );
    }
    if (d.judgment) {
      for (const line of d.judgment.trim().split('\n')) lines.push(`  ${line.trim()}`);
    }
  }

  return lines.join('\n');
}
