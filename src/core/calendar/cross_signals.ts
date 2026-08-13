/**
 * cross_signals — the PURE coincidence math behind Kate's "I noticed" fusion
 * nudges (Piece 2, 2026-06-21). A single-domain scan sees one signal at a time;
 * this detects where TWO upcoming signals coincide in a way worth a heads-up:
 *
 *   - visitor + their occasion (the flagship): an upcoming visit/trip/vacation
 *     whose participant has a birthday/anniversary inside the visit window
 *     (± a pad). "Kim visits 6/26 and his birthday's 6/28 — want me to sort a
 *     gift and plan something while he's here?"
 *   - double-booking: two TIMED events for the same owner whose times overlap.
 *     "Heads up — your 2pm and 2:30 overlap."
 *
 * Pure + deterministic (no LLM, no clock beyond the caller's input) so a smoke
 * drives it without a vault. The tool (scan_cross_signals.ts) does the db reads +
 * cordon-scoped proposal filing; this module is the detection it composes.
 */

/** Kill switch — DARK by default (off); the autonomous coincidence proposer. */
export function cross_signal_enabled(): boolean {
  return process.env.HEARTH_CROSS_SIGNAL === '1';
}

const DAY_MS = 86_400_000;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Parse a YYYY-MM-DD or full ISO datetime to epoch ms. Date-only → UTC
 *  midnight; a naive datetime parses in the host frame (consistent within one
 *  db's events, which is all overlap detection needs). null if unparseable. */
function to_ms(iso: string): number | null {
  if (!iso) return null;
  const s = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Does a year-agnostic occasion (YYYY-MM-DD or MM-DD) fall within the visit
 * window [visit_start, visit_end] padded by `pad_days` on each side? Resolves
 * the occasion to the visit's year AND the next year (a late-December visit with
 * an early-January birthday). Returns the resolved YYYY-MM-DD of the occurrence
 * in the window, or null. Compares on date granularity (the visit's date prefix).
 */
export function occasion_in_visit_window(
  occasion: string,
  visit_start: string,
  visit_end: string,
  pad_days: number,
): string | null {
  const m = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec((occasion ?? '').trim());
  if (!m) return null;
  const mm = parseInt(m[2]!, 10);
  const dd = parseInt(m[3]!, 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

  const start_ms = to_ms((visit_start ?? '').slice(0, 10));
  const end_ms = to_ms(((visit_end || visit_start) ?? '').slice(0, 10));
  if (start_ms === null || end_ms === null) return null;
  const lo = start_ms - pad_days * DAY_MS;
  const hi = end_ms + pad_days * DAY_MS;

  const start_year = new Date(start_ms).getUTCFullYear();
  for (const yr of [start_year, start_year + 1]) {
    const occ_iso = `${yr}-${pad2(mm)}-${pad2(dd)}`;
    const occ_ms = to_ms(occ_iso);
    if (occ_ms !== null && occ_ms >= lo && occ_ms <= hi) return occ_iso;
  }
  return null;
}

export interface TimedBounds {
  start_ms: number;
  end_ms: number;
}

/**
 * Time bounds for a TIMED event (its start carries a clock time). A date-only
 * (all-day) event returns null — two all-day events on a day aren't a
 * scheduling conflict. A missing/invalid end defaults to start + 1h.
 */
export function timed_bounds(start: string | null, end: string | null): TimedBounds | null {
  if (!start || !/T\d{2}:\d{2}/.test(start)) return null;
  const start_ms = to_ms(start);
  if (start_ms === null) return null;
  let end_ms = end ? to_ms(end) : null;
  if (end_ms === null || end_ms <= start_ms) end_ms = start_ms + 3_600_000;
  return { start_ms, end_ms };
}

/** Half-open interval overlap: [a) ∩ [b) ≠ ∅. */
export function ranges_overlap(a: TimedBounds, b: TimedBounds): boolean {
  return a.start_ms < b.end_ms && b.start_ms < a.end_ms;
}

/** Normalize a name/title for whole-word matching. */
export function normalize_name(s: string): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Does `person_name` appear as a whole word/phrase in `haystack`? Used to match
 * a visiting Person against an event title or its participants list. Requires a
 * word-boundary match on the full name so "Kim" doesn't match "sleeve" but
 * "Kim" DOES match "Kim visits".
 */
export function name_mentioned(person_name: string, haystack: string): boolean {
  const n = normalize_name(person_name);
  const h = normalize_name(haystack);
  if (!n || !h) return false;
  return new RegExp(`(?:^| )${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`).test(h);
}
