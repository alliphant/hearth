/**
 * research_pane — the "Research" TAB for Kate's briefing office (2026-07-29).
 *
 * Kate's office already uses the server-side `tabs` pane primitive (the Ruby
 * Politics Desk pattern): Briefing | News Desk | Security. This adds the
 * Research Room — what's being investigated right now, how far along each run
 * is, and the finished dossiers, each previewed in place.
 *
 * Lives in its own file per the news_pane / market_radar_pane extraction
 * pattern: specialist_pane.ts is shared across concurrent session lanes, so the
 * hook there stays two lines. Reads only the store + the two progress helpers
 * the office route already serves (`progress_of` / `sub_question_progress` in
 * app/routes/research.ts) so the tab and the route can never disagree about how
 * far along a run is.
 *
 * GATED ON THE CAPABILITY, not on a specialist name — `deep_research`, exactly
 * as the office route gates (routes/research.ts). Ruby is granted it and files
 * investigations of her own, so when her office grows a tabbed surface it gets
 * this room for free; nothing here says "kate".
 *
 * CORDONED PER REQUESTER, like the route: `list_for_user`, so the owner has NO
 * god-view of a household member's research. A pane is composed per viewing
 * user, so the caller passed in IS the cordon.
 *
 * ── Phase 1 is deliberately conservative about the wire ────────────────────
 * Every block here is a kind BOTH clients already render — `hero_metric`,
 * `text`, `list`, `load_chart` — and every enum value is one already in the
 * shipped decoders (`load_chart.kind: 'bars'`, `height_hint: 'sm'`,
 * `hero_metric.delta_kind: 'neutral' | 'up_good'`). That is not timidity: iOS
 * THROWS on an unknown value for those three enums, and a throw doesn't blank
 * the block — it blanks Kate's ENTIRE office, because the pane decodes as one
 * document. So a new block kind or a widened enum here is a client-side outage
 * for every build already in the field, and it would have to ship iOS-first.
 * Nothing in this room needs one.
 *
 * Two more iOS contracts this file is written around:
 *   • A list row's `detail_md` and `deep_link` are MUTUALLY EXCLUSIVE —
 *     `detail_md` wins and kills the link. There is also no `hearth://` route
 *     for a dossier, so there is nothing to link to. Reports therefore preview
 *     via `detail_md` (an excerpt — see DOSSIER_EXCERPT_CAP) and NO row here
 *     sets `deep_link`.
 *   • `Tab.blocks` is NON-optional in the iOS decoder: a tab emitted without
 *     the key throws and blanks the pane. Every return path below carries
 *     `blocks`.
 *
 * `native: "research_room"` is stamped from day one. Old clients ignore the
 * field and render `blocks` exactly as composed; the native iOS Research Room
 * flips on by recognizing it, with no deploy-ordering constraint either way
 * (the design-security-room-swift §1 contract, already proven by
 * `native: "security_room"`). Installed builds that predate it still get the
 * blocks, so this tab has to stand on its own — it does.
 *
 * ── `id: 'research'` is DELIBERATE, and it is not new ──────────────────────
 * The web office already has a client-rendered Research room
 * (`app/client/app.js` → `render_research_office`) sitting under its own tab key
 * `'research'`, reading the same `/api/specialists/:id/research` route this tab
 * reads the store for. Two things claim that id, so it is worth being explicit
 * about which is which, because the alternative was considered and is worse.
 *
 * The convention this file follows is the one the neighbouring tabs already
 * established: a server pane tab id and the web's office tab key are the SAME
 * STRING for the same CONCEPT, and the web deliberately SHADOWS the server tab
 * with a richer client-rendered surface where it has one. `news` (server
 * `compose_news_desk_tab` id `'news'` ↔ web `render_news_desk_view`), `radar`
 * (↔ the market-radar canvas) and `security` (↔ the People enrolment surface)
 * are all exactly this. The web's briefing branch renders ONLY the `briefing`
 * tab's blocks flat and drives its own tab bar, so the server tab and the web
 * room never both render: iOS reads the server tab (or the native room), web
 * reads its own. One surface per client, per id.
 *
 * Giving this tab a different id (`research_room`) was the alternative. It would
 * have produced TWO tabs both labelled "Research" the moment the web stopped
 * unwrapping, broken the convention its three neighbours follow, and — the
 * concrete cost — cut the web off from the pattern it uses to DISCOVER a server
 * tab: the `security` entry appears in the web tab bar only when the server doc
 * carries a tab with id `'security'`. Sharing the id keeps that door open.
 *
 * What sharing the id does NOT solve is that two IMPLEMENTATIONS of the same
 * room can drift apart in content. That is a real cost, and it is the same cost
 * already accepted for news/radar/security. Collapsing the web room onto this
 * tab (deleting `render_research_office`) is the one-implementation end state,
 * but it retires a shipped surface and is the owner's call, not this diff's.
 */
import type { Database } from 'bun:sqlite';
import type { PaneBlock } from './specialist_pane';
import { format_short_date, format_short_datetime } from './time';
import { progress_of, sub_question_progress } from '@app/routes/research';
import type { Caller } from '@memory/private_to';
import {
  ResearchInvestigationStore,
  OPEN_INVESTIGATION_STATUSES,
  type InvestigationRow,
} from '@memory/stores/research_investigations';

/** How many of the caller's investigations to read (newest-first). */
const SCAN_LIMIT = 60;
/** Finished dossiers listed. */
const MAX_RECENT = 8;
/**
 * Dossier markdown EXCERPTED into a row's `detail_md`.
 *
 * ⚠ This is a budget, not a display preference. The briefing pane is composed
 * on EVERY office open and re-composed on the office's refresh, so whatever this
 * costs is paid over the wire every time. The first cut inlined whole dossiers
 * (8 000 chars × 12 rows ≈ 96 KB of markdown per composition) to make reports
 * "readable in place" — but a list row is a PREVIEW: the full text already has
 * two homes that fetch on demand (the drill-in `GET …/research/:rid`, which both
 * the web Research office and the native iOS room read, and the shelved library
 * note), so the pane was paying 96 KB to duplicate them. 8 rows × 700 chars is
 * ≈ 5.6 KB of excerpt — a ~17× cut with nothing lost that isn't one tap away.
 */
const DOSSIER_EXCERPT_CAP = 700;
/** Trailing 7-day buckets in the cadence chart. */
const CHART_WEEKS = 8;
/** Below this many investigations a chart is noise, not a trend. */
const CHART_MIN_TOTAL = 3;

export interface ResearchRoomTab {
  id: string;
  label: string;
  badge?: number;
  native?: string;
  blocks: PaneBlock[];
}

/** What the run is DOING, in words a person would use. */
const PHASE_LABEL: Record<string, string> = {
  pending: 'queued',
  planning: 'planning the angles',
  investigating: 'reading sources',
  verifying: 'checking the claims',
  synthesizing: 'writing it up',
};

function is_open(row: InvestigationRow): boolean {
  return OPEN_INVESTIGATION_STATUSES.includes(row.status);
}

function finding_count(row: InvestigationRow): number {
  return row.findings.reduce((n, f) => n + f.findings.length, 0);
}

/** "reading sources · 45% · 3/5 angles · 11 findings" */
function active_subtitle(row: InvestigationRow): string {
  const sq = sub_question_progress(row);
  const pct = Math.round(progress_of(row.status) * 100);
  const parts = [PHASE_LABEL[row.status] ?? row.status, `${pct}%`];
  if (sq.total > 0) parts.push(`${sq.answered}/${sq.total} angles`);
  const n = finding_count(row);
  if (n > 0) parts.push(`${n} finding${n === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** The brief plus the run's own progress trail — enough to see it working. */
function active_detail(row: InvestigationRow): string {
  const log = (row.state.log ?? []).slice(-6);
  return (
    `**Asked:** ${row.brief}\n\n` +
    (log.length > 0
      ? log.map((line) => `- ${line}`).join('\n')
      : '_Just filed — no progress yet._')
  );
}

function recent_subtitle(row: InvestigationRow): string {
  const when = row.completed_at ? format_short_date(row.completed_at) : null;
  const parts: string[] = [];
  if (row.status !== 'done') parts.push(row.status);
  if (when) parts.push(when);
  const n = finding_count(row);
  if (n > 0) parts.push(`${n} finding${n === 1 ? '' : 's'}`);
  const dropped = row.verification?.dropped_claims.length ?? 0;
  if (dropped > 0) parts.push(`${dropped} claim${dropped === 1 ? '' : 's'} dropped`);
  return parts.join(' · ');
}

/**
 * Cut at the last paragraph break inside the cap, falling back to the last
 * sentence end, then to a hard slice. Mid-word truncation of markdown can leave
 * a dangling `[`, `**`, or fence open, which renders as garbage rather than as a
 * shortened report.
 */
function excerpt(body: string, cap: number): string {
  if (body.length <= cap) return body;
  const head = body.slice(0, cap);
  const para = head.lastIndexOf('\n\n');
  const sentence = head.lastIndexOf('. ');
  // Only honour a break that still leaves a substantial excerpt — otherwise a
  // dossier whose first paragraph break sits at char 20 would show one line.
  const floor = cap * 0.4;
  const cut = para > floor ? para : sentence > floor ? sentence + 1 : cap;
  return head.slice(0, cut).trimEnd();
}

/**
 * A PREVIEW of the report — the opening excerpt, not the whole thing (see
 * DOSSIER_EXCERPT_CAP for why). A run that ended without a report says so
 * instead of expanding to nothing: a silently empty disclosure reads as a broken
 * app, and "this didn't finish" is real information the office owes the reader.
 */
function recent_detail(row: InvestigationRow): string {
  if (row.dossier_md && row.dossier_md.trim().length > 0) {
    const body = row.dossier_md.trim();
    return body.length > DOSSIER_EXCERPT_CAP
      ? `${excerpt(body, DOSSIER_EXCERPT_CAP)}\n\n_…opening excerpt — open the report for the rest._`
      : body;
  }
  if (row.status === 'cancelled') {
    return `**${row.subject}** — cancelled before a report was written.\n\n**Asked:** ${row.brief}`;
  }
  const why = row.error ? `\n\n_${row.error}_` : '';
  return (
    `**${row.subject}** — this one didn't produce a report.\n\n` +
    `**Asked:** ${row.brief}${why}`
  );
}

/**
 * Investigations filed per week, over trailing 7-day windows anchored on now.
 * Trailing windows rather than calendar/ISO weeks on purpose: the label is the
 * window's start date, so there is no locale week-start question to get wrong,
 * and `bars` + `height_hint: 'sm'` are both already-shipped enum values.
 *
 * Returns null below CHART_MIN_TOTAL — a two-bar chart is decoration.
 */
function cadence_chart(
  rows: readonly InvestigationRow[],
): Extract<PaneBlock, { type: 'load_chart' }> | null {
  if (rows.length < CHART_MIN_TOTAL) return null;
  const week_ms = 7 * 24 * 3_600_000;
  const now = Date.now();
  // Bucket i's window STARTS (CHART_WEEKS - 1 - i) weeks ago, so i = 0 is the
  // oldest and the chart reads left-to-right in time. Index arithmetic rather
  // than a start/end range scan: a range whose newest window ended exactly at
  // `now` excluded a row filed this instant, which is the most likely row to
  // exist. `max(0, …)` also parks a row timestamped slightly ahead of the clock
  // in the newest bucket instead of dropping it.
  const counts = new Array<number>(CHART_WEEKS).fill(0);
  let counted = 0;
  for (const row of rows) {
    const t = new Date(row.created_at).getTime();
    if (Number.isNaN(t)) continue;
    const weeks_ago = Math.floor(Math.max(0, now - t) / week_ms);
    const idx = CHART_WEEKS - 1 - weeks_ago;
    if (idx < 0) continue; // older than the window
    counts[idx] = (counts[idx] ?? 0) + 1;
    counted++;
  }
  if (counted < CHART_MIN_TOTAL) return null;
  return {
    type: 'load_chart',
    title: 'Investigations filed',
    kind: 'bars',
    height_hint: 'sm',
    points: counts.map((n, i) => {
      const start_iso = new Date(now - (CHART_WEEKS - 1 - i) * week_ms).toISOString();
      const label = format_short_date(start_iso);
      return {
        x: start_iso,
        y: n,
        ...(label ? { label } : {}),
        detail: `${n} filed in the week of ${label ?? '—'}`,
      };
    }),
  };
}

/**
 * Compose the Research tab for a viewing caller, or null when they have no
 * investigations at all — in which case Kate's office stays byte-identical to
 * pre-Research-Room (an empty room is worse than no room).
 */
export function compose_research_room_tab(db: Database, caller: Caller): ResearchRoomTab | null {
  const rows = new ResearchInvestigationStore(db).list_for_user(caller, { limit: SCAN_LIMIT });
  if (rows.length === 0) return null;

  const active = rows.filter(is_open);
  const recent = rows.filter((r) => !is_open(r)).slice(0, MAX_RECENT);
  const blocks: PaneBlock[] = [];

  // 1. The hero: what's running, or — when nothing is — what's on the shelf.
  //    A count of finished reports is the honest idle number; showing "0
  //    running" as the headline makes an office with twenty dossiers in it
  //    look empty.
  if (active.length > 0) {
    const angles = active.reduce(
      (acc, r) => {
        const sq = sub_question_progress(r);
        return { answered: acc.answered + sq.answered, total: acc.total + sq.total };
      },
      { answered: 0, total: 0 },
    );
    blocks.push({
      type: 'hero_metric',
      value: String(active.length),
      label: active.length === 1 ? 'investigation running' : 'investigations running',
      ...(angles.total > 0
        ? {
            delta: `${angles.answered}/${angles.total} angles answered`,
            // More answered angles IS progress — the one place a value
            // judgment is honest here.
            delta_kind: 'up_good' as const,
          }
        : {}),
    });
  } else {
    const finished = rows.filter((r) => r.status === 'done');
    // MAX of completed_at, not `finished[0]` — `rows` is ordered by created_at
    // DESC, and a long run filed on Monday can complete after a short one filed
    // on Tuesday, so the first row's completion is not the newest completion.
    const newest = finished.reduce<string | null>(
      (best, r) => (r.completed_at && (best === null || r.completed_at > best) ? r.completed_at : best),
      null,
    );
    const newest_label = newest ? format_short_date(newest) : null;
    blocks.push({
      type: 'hero_metric',
      value: String(finished.length),
      label: finished.length === 1 ? 'report on the shelf' : 'reports on the shelf',
      // Neutral: a standing count of past reports isn't good news or bad.
      ...(newest_label ? { delta: `newest ${newest_label}`, delta_kind: 'neutral' as const } : {}),
    });
  }

  // 2. In progress — the live rows. `detail_md` only; no deep_link (see header).
  if (active.length > 0) {
    blocks.push({
      type: 'list',
      title: 'In progress',
      items: active.map((row) => ({
        title: row.subject,
        subtitle: active_subtitle(row),
        detail_md: active_detail(row),
      })),
    });
  }

  // 3. Recent reports — the dossier body inlined. Again `detail_md` only.
  if (recent.length > 0) {
    blocks.push({
      type: 'list',
      title: 'Recent reports',
      items: recent.map((row) => ({
        title: row.subject,
        subtitle: recent_subtitle(row),
        detail_md: recent_detail(row),
      })),
    });
  } else {
    blocks.push({
      type: 'text',
      body_md: '_No finished reports yet — the first one lands when a run completes._',
    });
  }

  // 4. Cadence, when there's enough of it to be a trend.
  const chart = cadence_chart(rows);
  if (chart) blocks.push(chart);

  const stamp = format_short_datetime(new Date().toISOString());
  if (stamp) blocks.push({ type: 'text', body_md: `*as of ${stamp}*` });

  return {
    id: 'research',
    label: 'Research',
    ...(active.length > 0 ? { badge: Math.min(active.length, 99) } : {}),
    // The future activation switch for a native iOS Research Room; ignored by
    // every build shipped today.
    native: 'research_room',
    blocks,
  };
}
