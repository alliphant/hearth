/**
 * Pleasantville council/board meeting DISCOVERY via the MuniCode Meetings
 * (CivicPlus "Aha") PUBLIC API — no auth, structured JSON. Replaces blind
 * HTML-scraping of citygov.com/cityclerk/agendas with a real feed of which
 * bodies meet, when, and a `revision_id` that powers reactive change
 * detection (scan_council_meetings).
 *
 * Scope: meeting discovery only. FC's instance does NOT enable the
 * agenda-item / vote endpoints (they 404/500), so item + vote detail come
 * from the agenda/minutes document Ruby fetches separately and records via
 * record_civic_vote. Base host is env-overridable so this is reusable if
 * the city's portal moves.
 */
const DEFAULT_BASE = 'https://pleasantville-co.municodemeetings.com';

export interface CivicMeeting {
  meeting_id: string;
  revision_id: string | null;
  title: string;
  group: string | null;
  summary: string | null;
  /** Best-effort ISO date; null when the API carries a TBD placeholder
   *  (year >= 2099) and no date is recoverable from the title. */
  date: string | null;
  /** True when `date` was recovered from the title because the API's
   *  CalendarDate was a TBD placeholder. */
  date_from_title: boolean;
}

export interface ListResult {
  ok: boolean;
  meetings: CivicMeeting[];
  error?: string;
}

function base_url(): string {
  return (process.env.RUBY_CIVIC_MEETINGS_BASE ?? DEFAULT_BASE).replace(/\/+$/, '');
}

/** Pull a date out of a title like "City Council Work Session 1-16-2026". */
function date_from_title(title: string): string | null {
  const m = title.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (!m) return null;
  const iso = `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * Canonicalize a MuniCode CalendarDate.FromDate into a real ISO-8601 UTC
 * instant. The API ships the meeting-start instant in UTC but timezone-naive
 * (e.g. "2026-06-10 00:00:00" == Jun 9 6pm MDT), which downstream code
 * misreads as a local date one day late for evening meetings. Returns null
 * for date-only / unparseable values so the caller keeps the original.
 */
function to_iso_utc_instant(s: string): string | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, m[6] ? +m[6] : 0);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function normalize(raw: Record<string, unknown>): CivicMeeting {
  const cal = Array.isArray(raw.CalendarDate)
    ? (raw.CalendarDate[0] as Record<string, unknown> | undefined)
    : undefined;
  const from_date = typeof cal?.FromDate === 'string' ? cal.FromDate : null;
  const title = String(raw.Title ?? '').trim();

  let date: string | null = null;
  let from_title = false;
  if (from_date && Number(from_date.slice(0, 4)) < 2099) {
    // MuniCode FromDate is the meeting-start instant in UTC but timezone-naive;
    // stored verbatim it reads one local day late for evening meetings.
    // Canonicalize to a real ISO-8601 UTC instant so downstream tz-aware
    // formatting renders the correct local date + time. Date-only values
    // (rare title-derived fallbacks) are kept as-is.
    date = to_iso_utc_instant(from_date) ?? from_date;
  } else {
    const t = date_from_title(title);
    if (t) {
      date = t;
      from_title = true;
    }
  }

  return {
    meeting_id: String(raw.MeetingID ?? ''),
    revision_id: raw.RevisionID != null ? String(raw.RevisionID) : null,
    title,
    group: typeof raw.GroupName === 'string' ? raw.GroupName : null,
    summary:
      typeof raw.BodySummary === 'string' && raw.BodySummary.trim()
        ? raw.BodySummary.trim()
        : null,
    date,
    date_from_title: from_title,
  };
}

/** Fetch + normalize the public meeting list, optionally filtered by the
 *  meeting body (GroupName substring, case-insensitive). */
export async function list_meetings(opts?: {
  group_contains?: string;
  timeout_ms?: number;
}): Promise<ListResult> {
  const url = `${base_url()}/api/v1/public/meeting/list.json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts?.timeout_ms ?? 20_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, meetings: [], error: `HTTP ${res.status} from ${url}` };
    const json = (await res.json()) as { Meetings?: Array<Record<string, unknown>> };
    const rows = Array.isArray(json.Meetings) ? json.Meetings : [];
    let meetings = rows.map(normalize).filter((m) => m.meeting_id);
    if (opts?.group_contains) {
      const needle = opts.group_contains.toLowerCase();
      meetings = meetings.filter((m) => (m.group ?? '').toLowerCase().includes(needle));
    }
    return { ok: true, meetings };
  } catch (err) {
    return { ok: false, meetings: [], error: `fetch failed: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}
