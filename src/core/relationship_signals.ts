/**
 * relationship_signals — the shared "who needs attention" computation behind
 * BOTH the Friends tab and Kate's brief (2026-06-22).
 *
 * Two signals, derived purely from the People/ notes:
 *   - OVERDUE to reconnect: contact_cadence vs last_contacted.
 *   - OCCASIONS coming up: birthday + anniversaries (via upcoming_dates) +
 *     tracked important_dates, within a lead-time horizon.
 *
 * Cordon-aware (per caller, owner has no god-view) and genealogy-excluded —
 * the same rules the Friends route applies, in one place so the brief and the
 * tab can't drift. Pure given the memory reads; no LLM.
 */
import type { MemoryClient } from '@memory/client';
import { note_visible_to_caller, parse_private_to, type Caller } from '@memory/private_to';

export const CADENCE_DAYS: Record<string, number> = {
  weekly: 7, monthly: 30, quarterly: 90, annually: 365,
};

export function parse_fm(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** GEDCOM-imported ancestor (gedcom_xref / -ancestor.md) — not a contact. */
export function is_genealogy(fm: Record<string, unknown>, note_path: string): boolean {
  return 'gedcom_xref' in fm || /-ancestor\.md$/i.test(note_path);
}

/**
 * Someone in the PUBLIC record rather than in the household's life — an elected
 * official, a candidate, an executive, an author (2026-07-29). A person-shaped
 * note, but not a relationship: no birthday to remember, no gift, no cadence to
 * fall behind on.
 *
 * They land in People/ for the same reason ancestors do — `who_is` should answer
 * "who is Chris Barrett" from one place, and the relations graph can tie them to
 * an org or a place. What they must NOT do is enter the relationship surfaces.
 * The classification is the researching model's judgment (`subject_kind:
 * 'public_figure'` on deep_research), never a name list or a per-specialist
 * carve-out.
 */
export function is_public_figure(row: { relationship: string }): boolean {
  return row.relationship === 'public_figure';
}

/** Not a "contact" for the Friends tab / brief nudges: a genealogy import, a
 *  public figure, OR the owner's own `self` biographical note (you're not your
 *  own friend). The one place every surface agrees on who counts as a person you
 *  relate TO — a site that needs a different cut (person_enrichment and the
 *  Friends tab both keep `self`) composes the class predicates instead of
 *  re-deriving them inline. */
export function is_non_contact(row: { relationship: string; frontmatter_json: string; note_path: string }): boolean {
  return (
    row.relationship === 'self' ||
    is_public_figure(row) ||
    is_genealogy(parse_fm(row.frontmatter_json), row.note_path)
  );
}

/** Whole days from today (YYYY-MM-DD local) to a date string; recurring/MM-DD →
 *  next yearly occurrence, one-off → signed delta. Pure Date.UTC arithmetic. */
export function days_until(date_str: string, today_iso: string, recurring: boolean): number | null {
  const [ty, tm, td] = today_iso.split('-').map(Number);
  const parts = date_str.split('-').map((n) => Number(n));
  let y: number | undefined, m: number, d: number;
  if (parts.length === 3) [y, m, d] = parts as [number, number, number];
  else if (parts.length === 2) [m, d] = parts as [number, number];
  else return null;
  if (!m || !d || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const today = Date.UTC(ty!, tm! - 1, td!);
  if (recurring || parts.length === 2) {
    let occ = Date.UTC(ty!, m - 1, d);
    if (occ < today) occ = Date.UTC(ty! + 1, m - 1, d);
    return Math.round((occ - today) / 86_400_000);
  }
  return Math.round((Date.UTC(y!, m - 1, d) - today) / 86_400_000);
}

export function days_since(iso: string | null, today_iso: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso.length > 10 ? iso : `${iso}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  const [ty, tm, td] = today_iso.split('-').map(Number);
  return Math.round((Date.UTC(ty!, tm! - 1, td!) - t) / 86_400_000);
}

export interface OverdueContact {
  id: string;
  name: string;
  days_since: number;
  cadence: string;
}
export interface Occasion {
  id: string;
  name: string;
  what: string;
  kind: 'birthday' | 'anniversary' | 'date';
  days_until: number;
  date: string;
}
export interface RelationshipSignals {
  overdue: OverdueContact[];
  occasions: Occasion[];
}

interface UpcomingRow {
  kind: 'birthday' | 'anniversary';
  person_id: string;
  name: string;
  date: string;
  days_until: number;
  what?: string;
}

/** The caller's overdue-to-reconnect contacts + upcoming occasions, cordoned
 *  and genealogy-excluded, soonest/most-overdue first. */
export function compute_relationship_signals(
  memory: Pick<MemoryClient, 'query_people' | 'upcoming_dates'>,
  caller: Caller,
  today_iso: string,
  opts: { horizon_days?: number; max?: number } = {},
): RelationshipSignals {
  const horizon = opts.horizon_days ?? 21;
  const max = opts.max ?? 8;

  const by_person = new Map<string, UpcomingRow[]>();
  // Anchor the occasion window to the SAME today_iso the day math below uses —
  // upcoming_dates otherwise reads the host clock, and the two drift apart
  // late-evening Denver in a UTC container (and under pinned-date smokes).
  for (const e of memory.upcoming_dates(horizon, undefined, today_iso) as UpcomingRow[]) {
    const arr = by_person.get(e.person_id) ?? [];
    arr.push(e);
    by_person.set(e.person_id, arr);
  }

  const overdue: OverdueContact[] = [];
  const occasions: Occasion[] = [];
  for (const row of memory.query_people({})) {
    const fm = parse_fm(row.frontmatter_json);
    if (is_non_contact(row)) continue;
    if (!note_visible_to_caller(parse_private_to(fm.private_to), caller)) continue;

    const cad = row.contact_cadence;
    const since = days_since(row.last_contacted, today_iso);
    if (cad && cad in CADENCE_DAYS && since !== null && since > CADENCE_DAYS[cad]!) {
      overdue.push({ id: row.id, name: row.name, days_since: since, cadence: cad });
    }
    for (const e of by_person.get(row.id) ?? []) {
      occasions.push({ id: row.id, name: row.name, what: e.what ?? (e.kind === 'birthday' ? 'birthday' : 'anniversary'), kind: e.kind, days_until: e.days_until, date: e.date });
    }
    for (const it of Array.isArray(fm.important_dates) ? fm.important_dates : []) {
      if (!it || typeof it !== 'object') continue;
      const o = it as { date?: unknown; what?: unknown; recurring?: unknown };
      if (typeof o.date !== 'string') continue;
      const du = days_until(o.date, today_iso, Boolean(o.recurring));
      if (du === null || du < 0 || du > horizon) continue;
      occasions.push({ id: row.id, name: row.name, what: typeof o.what === 'string' ? o.what : 'date', kind: 'date', days_until: du, date: o.date });
    }
  }
  overdue.sort((a, b) => b.days_since - a.days_since);
  occasions.sort((a, b) => a.days_until - b.days_until);
  return { overdue: overdue.slice(0, max), occasions: occasions.slice(0, max) };
}

/** Render the signals as brief grounding lines (evidence the fact-critic
 *  accepts) — one fact per overdue contact / occasion. Empty → "". */
export function relationship_grounding_lines(s: RelationshipSignals): string[] {
  const lines: string[] = [];
  for (const o of s.overdue) lines.push(`reconnect: ${o.name} — ${o.days_since} days since contact (cadence ${o.cadence})`);
  for (const e of s.occasions) lines.push(`occasion: ${e.name}'s ${e.what} in ${e.days_until} day${e.days_until === 1 ? '' : 's'} (${e.date})`);
  return lines;
}
