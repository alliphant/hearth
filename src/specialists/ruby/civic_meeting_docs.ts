/**
 * civic_meeting_docs — resolve a MuniCode meeting to the DOCUMENT that
 * actually carries the votes (2026-07-31).
 *
 * `extract_meeting_votes` recorded 3 votes in two months of nightly runs.
 * Its fetches were succeeding (`docs_fetched: 2, failed_n: 0`) and it still
 * found nothing, because discovery and extraction were each aimed one step
 * short of the record:
 *
 *   1. DISCOVERY was a blind `web_search` for "Pleasantville City Council
 *      minutes" filtered to official hosts. Search returns whatever it
 *      indexed, with no relation to recency — the live runs on 2026-07-30
 *      and 07-31 read `/page/city-council-regular-meeting-24`, which is the
 *      meeting of **October 17, 2023**. Nothing in the tool ever asked
 *      "which meeting happened most recently?", though `civic_meetings_api`
 *      has answered exactly that since it was written.
 *   2. The fetched meeting page is an INDEX. It lists "Agenda", "Agenda
 *      Packet", "Minutes" as links; the roll calls live one hop further, in
 *      the linked document. Handing the index page to the extractor asks it
 *      to find votes in a table of contents, so a correct recent meeting
 *      would ALSO have yielded zero.
 *
 * The chain this module implements, every hop verified against the live
 * portal:
 *
 *   list_meetings()            → MeetingID + date        (civic_meetings_api)
 *   /node/{MeetingID}          → 301 → the meeting page  (resolve_meeting_page)
 *   meeting page               → the document links      (parse_meeting_document_links)
 *   {date}_minutes.pdf         → roll calls              (the caller fetches)
 *
 * The `/node/{id}` hop is the one that was missing: the portal's `/api/`
 * namespace exposes no per-meeting endpoint (they 404 — see
 * civic_meetings_api's header), but Drupal's internal-path redirect does the
 * same job and is stable.
 *
 * Document PREFERENCE is load-bearing and ordered by what each document can
 * prove: minutes (the record: attendance roll call + per-motion outcome) >
 * action agenda (outcomes within a day, before minutes are approved) >
 * agenda/packet (published BEFORE the meeting — it cannot contain a vote,
 * and is never a vote source).
 *
 * Everything here is pure except `resolve_meeting_page`, which takes an
 * injectable fetch seam so the smoke pins the contract without the network.
 */
import { local_iso_date } from '@core/time';
import { list_meetings, type CivicMeeting } from './civic_meetings_api';

const DEFAULT_BASE = 'https://pleasantville-co.municodemeetings.com';

function base_url(): string {
  return (process.env.RUBY_CIVIC_MEETINGS_BASE ?? DEFAULT_BASE).replace(/\/+$/, '');
}

// ── document classification ─────────────────────────────────────────────────

/**
 * What a civic meeting document can prove, most authoritative first.
 *
 * - `minutes` — the approved record. Carries the attendance roll call and
 *   the per-motion outcome ("The motion carried 6-1 with Councilmember
 *   Barrett dissenting."). This is the only document that can attribute a
 *   vote to a named member.
 * - `action_agenda` — posted within a day of the meeting, before minutes are
 *   approved. Carries outcomes but usually not named dissents. Real value:
 *   it is the ONLY vote source for the most recent meeting, because minutes
 *   lag by a meeting or two.
 * - `agenda` / `packet` — published BEFORE the meeting. Structurally cannot
 *   contain a vote. Kept in the parse output so a caller can cite them, and
 *   excluded from vote extraction by `best_vote_document`.
 */
export type CivicDocKind = 'minutes' | 'action_agenda' | 'agenda' | 'packet' | 'other';

const DOC_RANK: Record<CivicDocKind, number> = {
  minutes: 0,
  action_agenda: 1,
  agenda: 2,
  packet: 3,
  other: 4,
};

/** Document kinds that can actually carry a recorded vote. */
export const VOTE_BEARING_KINDS: ReadonlySet<CivicDocKind> = new Set<CivicDocKind>([
  'minutes',
  'action_agenda',
]);

export interface CivicDocument {
  url: string;
  kind: CivicDocKind;
  /** The link text as written on the page, when there was any. */
  label: string | null;
}

/**
 * Classify a meeting document by its URL.
 *
 * Keyed on the filename the city publishes — `2026-06-16_minutes.pdf`,
 * `2026-07-21_action_agenda.pdf` — and on MuniCode's own CDN naming
 * (`MEET-Agenda-<hash>.pdf`, `MEET-Packet-<hash>.pdf`). Order matters:
 * `action_agenda` must be tested before `agenda`, or every action agenda
 * classifies as a (pre-meeting, vote-free) agenda and the most recent
 * meeting loses its only vote source.
 */
export function classify_civic_document(url: string): CivicDocKind {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname).toLowerCase();
  } catch {
    path = url.toLowerCase();
  }
  const q = url.toLowerCase();
  if (/minute/.test(path)) return 'minutes';
  if (/action[-_ ]?agenda/.test(path)) return 'action_agenda';
  if (/packet/.test(path) || /meet-packet/.test(q)) return 'packet';
  if (/agenda/.test(path) || /meet-agenda/.test(q)) return 'agenda';
  return 'other';
}

/**
 * The best document to extract votes from, or null when the meeting has
 * published none yet (agenda-only — the meeting hasn't happened, or minutes
 * aren't approved and no action agenda was posted).
 *
 * Returning null is a real, common answer: an upcoming meeting has an agenda
 * and nothing else, and reading it would produce fabricated votes.
 */
export function best_vote_document(docs: readonly CivicDocument[]): CivicDocument | null {
  const usable = docs.filter((d) => VOTE_BEARING_KINDS.has(d.kind));
  if (usable.length === 0) return null;
  return usable.slice().sort((a, b) => DOC_RANK[a.kind] - DOC_RANK[b.kind])[0]!;
}

// ── meeting-page link extraction ────────────────────────────────────────────

const HREF_RE = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;

function decode_entities(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

function strip_tags(s: string): string {
  return decode_entities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Pull the document links off a MuniCode meeting page.
 *
 * Deliberately a regex over the raw HTML rather than a DOM parse: the portal
 * is Drupal-rendered and the link block is flat anchors, so a parser buys
 * nothing and costs a dependency. Relative hrefs resolve against `page_url`.
 *
 * Only documents are returned — `.pdf`/`.doc(x)` paths plus MuniCode's
 * `adaHtmlDocument` viewer (an HTML rendering of the same agenda). Navigation,
 * calendar and video links are dropped. Results are de-duplicated by URL,
 * keeping the first (most specific) classification.
 */
export function parse_meeting_document_links(html: string, page_url: string): CivicDocument[] {
  const out: CivicDocument[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(HREF_RE)) {
    const raw = decode_entities(m[2] ?? m[3] ?? '').trim();
    if (!raw || raw.startsWith('#') || /^(mailto|javascript):/i.test(raw)) continue;
    let abs: string;
    try {
      abs = new URL(raw, page_url).toString();
    } catch {
      continue;
    }
    let path: string;
    try {
      path = new URL(abs).pathname.toLowerCase();
    } catch {
      continue;
    }
    const is_doc = /\.(pdf|docx?|rtf)$/.test(path) || /adahtmldocument/i.test(abs);
    if (!is_doc) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    const label = strip_tags(m[4] ?? '');
    out.push({ url: abs, kind: classify_civic_document(abs), label: label || null });
  }
  return out;
}

// ── meeting-page resolution (the /node/{id} hop) ────────────────────────────

export type PageFetch = (url: string) => Promise<{ ok: boolean; url: string; html: string; status: number }>;

const DEFAULT_TIMEOUT_MS = 25_000;

/**
 * ⚠ NO `(+...)` COMMENT IN THIS STRING.
 *
 * The portal's edge RESETS the connection (ECONNRESET, not a 403) for any
 * User-Agent carrying the parenthetical crawler-comment form that bots
 * conventionally use — `hearth-civic/1.0 (+household civic desk)` is reset
 * where `hearth-civic/1.0` returns 200, verified against the live host. It
 * is UA-shape sniffing, nothing else about the request changes.
 *
 * The trap is that it applies only to the Drupal-served HTML pages
 * (`/node/{id}`, `/bc-citycouncil/page/...`). The static file attachments
 * (`/sites/.../*.pdf`) serve fine either way — which is why the shared
 * `research_fetch` fetcher, whose default UA DOES carry that comment, still
 * reads the minutes PDF correctly and needs no change. Anyone "helpfully"
 * restoring a descriptive comment here breaks meeting discovery and the
 * failure looks like a network flake, not a block.
 */
const CIVIC_USER_AGENT = 'hearth-civic/1.0';

async function default_page_fetch(
  url: string,
): Promise<{ ok: boolean; url: string; html: string; status: number }> {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    headers: { Accept: 'text/html', 'User-Agent': CIVIC_USER_AGENT },
  });
  const html = res.ok ? await res.text() : '';
  return { ok: res.ok, url: res.url || url, html, status: res.status };
}

export interface MeetingDocsResult {
  ok: boolean;
  meeting_id: string;
  /** The resolved page URL (after the /node/{id} redirect). */
  page_url: string | null;
  documents: CivicDocument[];
  error?: string;
}

/**
 * MeetingID → the meeting's document links.
 *
 * `/node/{MeetingID}` 301s to the human-readable page
 * (`/bc-citycouncil/page/city-council-regular-meeting-82`), whose slug is a
 * sequential disambiguator with no relation to the MeetingID — which is why
 * the page URL cannot be derived and must be resolved.
 */
export async function resolve_meeting_documents(
  meeting_id: string,
  opts?: { fetch_page?: PageFetch; base?: string },
): Promise<MeetingDocsResult> {
  const base = (opts?.base ?? base_url()).replace(/\/+$/, '');
  const node_url = `${base}/node/${encodeURIComponent(meeting_id)}`;
  const fetch_page = opts?.fetch_page ?? default_page_fetch;
  try {
    const res = await fetch_page(node_url);
    if (!res.ok) {
      return { ok: false, meeting_id, page_url: null, documents: [], error: `HTTP ${res.status} from ${node_url}` };
    }
    return {
      ok: true,
      meeting_id,
      page_url: res.url,
      documents: parse_meeting_document_links(res.html, res.url),
    };
  } catch (err) {
    return {
      ok: false,
      meeting_id,
      page_url: null,
      documents: [],
      error: `fetch failed: ${(err as Error).message}`,
    };
  }
}

// ── recency (the half discovery never asked about) ──────────────────────────

export interface DatedMeeting extends CivicMeeting {
  /**
   * The meeting's LOCAL calendar day, YYYY-MM-DD.
   *
   * Must be formatted in the city's zone, not sliced off the UTC instant.
   * Council meets at 6pm MT, so `civic_meetings_api` canonicalizes that to
   * `2026-06-17T00:00:00Z` — a UTC slice reads "2026-06-17" for a meeting the
   * city itself calls June 16, and names `2026-06-16_minutes.pdf`. That
   * one-day skew would land on every evening meeting's `civic_votes` row and
   * silently mismatch the dedup key the manual `record_civic_vote` builds.
   */
  day: string;
}

/**
 * Meetings that have ALREADY HAPPENED, newest first.
 *
 * The portal's list is unordered and salted with TBD placeholders — the
 * `CalendarDate` for a template row is year 2099, and `normalize()` already
 * falls back to a date parsed out of the title for those. Meetings with no
 * recoverable date are dropped rather than guessed: an undated row cannot be
 * ranked by recency, and including it would put a template at the top of the
 * queue.
 *
 * `now` is a parameter, never the host clock, so a smoke can pin the window
 * (the repo's date-scan rule).
 */
export function recent_past_meetings(
  meetings: readonly CivicMeeting[],
  now: Date,
  within_days: number,
  tz?: string,
): DatedMeeting[] {
  const now_ms = now.getTime();
  const floor_ms = now_ms - within_days * 86_400_000;
  const out: DatedMeeting[] = [];
  for (const m of meetings) {
    if (!m.date) continue;
    const ms = Date.parse(m.date);
    if (Number.isNaN(ms)) continue;
    // A placeholder year is a template row, not a meeting.
    if (new Date(ms).getUTCFullYear() >= 2099) continue;
    if (ms > now_ms || ms < floor_ms) continue;
    out.push({ ...m, day: local_iso_date(new Date(ms), tz) });
  }
  out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  return out;
}

/** Discover recent past council meetings, newest first. */
export async function discover_recent_meetings(opts: {
  now: Date;
  within_days: number;
  group_contains?: string;
  list_fn?: typeof list_meetings;
  /** The city's zone; defaults to time.ts's household default. */
  tz?: string;
}): Promise<{ ok: boolean; meetings: DatedMeeting[]; error?: string }> {
  const list = opts.list_fn ?? list_meetings;
  const res = await list({ group_contains: opts.group_contains ?? 'council' });
  if (!res.ok) return { ok: false, meetings: [], error: res.error ?? 'meeting API unavailable' };
  return {
    ok: true,
    meetings: recent_past_meetings(res.meetings, opts.now, opts.within_days, opts.tz),
  };
}

// ── extraction windows ──────────────────────────────────────────────────────

/**
 * Split a long document into OVERLAPPING windows for extraction.
 *
 * Truncating to a single window silently loses the most valuable votes.
 * Minutes are chronological and the consent calendar comes first, so a
 * one-window read keeps the routine unanimous items and discards the
 * contested ones. Measured on the 2026-06-16 minutes (42,164 chars against a
 * 26,000-char cap): of five recorded motions the cap kept ONE, and the one it
 * dropped last was `the motion carried 6-1 with Councilmember Barrett
 * dissenting` at char 41,549 — the only contested vote in the meeting, and
 * the single most useful row an accountability ledger could hold.
 *
 * `overlap` exists so a motion straddling a boundary is whole in at least one
 * window; the caller de-duplicates by item title. `max_windows` bounds the
 * work — this runs per document in a nightly job, and an unbounded loop over
 * a pathological document is how a bounded pass becomes a spiral.
 */
export function chunk_for_extraction(
  text: string,
  opts?: { size?: number; overlap?: number; max_windows?: number },
): string[] {
  const size = Math.max(1000, opts?.size ?? 24_000);
  const overlap = Math.max(0, Math.min(opts?.overlap ?? 2_000, size - 500));
  const max_windows = Math.max(1, opts?.max_windows ?? 4);
  if (text.length <= size) return [text];
  const out: string[] = [];
  let start = 0;
  while (start < text.length && out.length < max_windows) {
    out.push(text.slice(start, start + size));
    start += size - overlap;
  }
  return out;
}

/**
 * Merge extracted rows from overlapping windows, de-duplicating by item.
 *
 * An item straddling a window boundary appears twice; the copy with MORE
 * attributed votes wins, because the truncated half of a straddling item is
 * exactly the one missing its roll call.
 */
export function merge_extracted_rows(
  batches: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>,
): Array<Record<string, unknown>> {
  const by_item = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  for (const batch of batches) {
    for (const row of batch) {
      const title = String(row.item_title ?? '').trim();
      if (!title) continue;
      // Normalize for comparison only; the stored title stays as written.
      const key = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120);
      const votes = Array.isArray(row.votes) ? row.votes.length : 0;
      const prior = by_item.get(key);
      if (!prior) {
        by_item.set(key, row);
        order.push(key);
        continue;
      }
      const prior_votes = Array.isArray(prior.votes) ? prior.votes.length : 0;
      if (votes > prior_votes) by_item.set(key, row);
    }
  }
  return order.map((k) => by_item.get(k)!).filter(Boolean);
}

// ── the attendance roll call ────────────────────────────────────────────────

export interface RollCallMember {
  /** The person's name, title stripped ("Emily Whitaker"). */
  name: string;
  /** The title as printed ("Mayor", "Councilmember"), when there was one. */
  role: string | null;
  present: boolean;
}

const TITLE_RE =
  /^(mayor pro tem|mayor protem|mayor|councilmember|councilman|councilwoman|council member|commissioner|chair|vice chair|board member|member)\s+/i;

/** Split a printed roster entry into title + person name. */
export function split_member_title(entry: string): { name: string; role: string | null } {
  const clean = entry.replace(/\s+/g, ' ').trim();
  const m = clean.match(TITLE_RE);
  if (!m) return { name: clean, role: null };
  const role = m[1]!.replace(/\s+/g, ' ').trim();
  const name = clean.slice(m[0].length).trim();
  // A bare title with no name behind it is a heading, not a person — hand
  // back the original so the caller's name gate rejects it rather than
  // silently inventing an empty member.
  return name ? { name, role } : { name: clean, role: null };
}

/**
 * Parse the `ROLL CALL / PRESENT … ABSENT …` block that opens Pleasantville
 * council minutes.
 *
 * This is the authoritative roster, and its absence is why the live
 * `civic_members` table holds exactly two rows — "Councilmember" and "City
 * Council" — scraped out of prose. The block reads:
 *
 *   ROLL CALL PRESENT Mayor Emily Whitaker Mayor Pro Tem Julie Romano
 *   Councilmember Josh Fudge … ABSENT None STAFF PRESENT City Manager …
 *
 * Names run together with no separator, so the split is on the TITLES —
 * every council entry is title-prefixed, which is what makes the boundary
 * recoverable. Parsing stops at `STAFF PRESENT`: staff are not voting
 * members and must never enter the roster.
 *
 * Returns [] when the block is absent or unparseable. A caller must treat
 * that as "no roster from this document", never as "no one was present".
 */
export function parse_roll_call_roster(text: string): RollCallMember[] {
  const flat = text.replace(/\s+/g, ' ');
  const start = flat.search(/ROLL\s*CALL/i);
  if (start < 0) return [];
  // Bound the block: staff roster / the first agenda section ends it.
  const rest = flat.slice(start);
  const end = rest.search(/STAFF\s+PRESENT|AGENDA\s+REVIEW|PUBLIC\s+COMMENT|CONSENT\s+CALENDAR/i);
  const block = end > 0 ? rest.slice(0, end) : rest.slice(0, 2000);

  const present_m = block.match(/PRESENT\b([\s\S]*?)(?=\bABSENT\b|$)/i);
  const absent_m = block.match(/\bABSENT\b([\s\S]*)$/i);

  const parse_side = (segment: string, present: boolean): RollCallMember[] => {
    const s = segment.replace(/\s+/g, ' ').trim();
    if (!s || /^none\b/i.test(s)) return [];
    // Split immediately BEFORE each title; the lookahead keeps the title with
    // its name. Entries carry no delimiter otherwise.
    const parts = s
      .split(/(?=\b(?:Mayor Pro Tem|Mayor|Councilmember|Councilman|Councilwoman|Council Member|Commissioner|Board Member)\b)/i)
      .map((p) => p.trim())
      .filter(Boolean);
    const rows: RollCallMember[] = [];
    for (const p of parts) {
      const { name, role } = split_member_title(p);
      // Require a two-token human name; drops trailing prose fragments that
      // survive the split.
      if (!/^[\p{L}][\p{L}'’.-]*(\s+[\p{L}][\p{L}'’.-]*)+$/u.test(name)) continue;
      if (name.length > 60) continue;
      rows.push({ name, role, present });
    }
    return rows;
  };

  const out = [
    ...parse_side(present_m?.[1] ?? '', true),
    ...parse_side(absent_m?.[1] ?? '', false),
  ];
  // De-dupe by normalized name, keeping the first appearance.
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = r.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
