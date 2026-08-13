/**
 * jobs — "On the Fire": ONE read-only projection over every long-running piece
 * of work a human asked for (2026-07-29).
 *
 * WHY THIS EXISTS. A media download and a deep-research dive both run detached,
 * both take tens of seconds to minutes, and both used to be INVISIBLE while
 * running — the only announcement was a terminal `push_text_to_user`, which the
 * delivery-window gate is free to defer for hours. On 2026-07-29 job
 * `ma_qqwrhh1a4gcg` finished in 17 seconds and its notice was queued to
 * 05:59:59Z the next morning (`queued_reason: in_meeting`) while the owner sat
 * in the thread asking "are you going to let me know?". Two Chris Barrett
 * research completions were parked the same way. The fix is two-part: this
 * projection (so in-flight work is always on a wall, never a question) and the
 * `is_awaited` bypass in delivery_window.ts (so a completion notice for work the
 * user asked for is not treated as an interruption).
 *
 * WHAT THIS IS NOT. Not a job engine. Every runner here is already resumable,
 * per-id serialized and fail-open; they keep owning their own state machines.
 * This module only READS them and normalizes the shapes. **If it ever writes a
 * domain row, the design is wrong** — a cancel belongs to the domain that knows
 * how to stand its runner down (see research's POST …/cancel).
 *
 * ONE MAPPER, TWO CONSUMERS. `GET /api/jobs` and the `job_progress` SSE event
 * both project through the functions below, so a phase label can never disagree
 * between the list and the live patch. The runners call `emit_job_progress`
 * where they ALREADY persist a status transition.
 *
 * CORDON. Each mapper carries the domain row's own `private_to` (or its
 * per-user id where the domain has no cordon column), and both the route and
 * the SSE fan-out gate on `note_visible_to_caller` — the media router's
 * 404-shape discipline, extended. A job is never listed to someone who can't
 * see its result.
 *
 * `progress: null` IS HONEST. A media download has four discrete phases and no
 * byte counter; a synthesized percentage that jumps 0→25→50→100 in 17 seconds
 * is noise. Clients render null as indeterminate.
 */
import type { Database } from 'bun:sqlite';
import type { AppEvent } from '@app/events';
import { note_visible_to_caller, type Caller } from '@memory/private_to';
import {
  OPEN_MEDIA_JOB_STATUSES,
  type MediaJobRow,
  type MediaJobStatus,
} from '@memory/stores/media_jobs';
import {
  ResearchInvestigationStore,
  OPEN_INVESTIGATION_STATUSES,
  type InvestigationRow,
  type InvestigationStatus,
} from '@memory/stores/research_investigations';
import {
  ResearchCommissionStore,
  OPEN_STATUSES as OPEN_COMMISSION_STATUSES,
  type CommissionRow,
  type CommissionStatus,
} from '@memory/stores/research_commissions';
import { MediaArchiveJobStore } from '@memory/stores/media_jobs';
import {
  SwarmReviewStore,
  type SwarmReviewRow,
  type SwarmFindingRow,
} from '@memory/stores/swarm_reviews';

/**
 * The narrowest thing that can receive a ledger patch. Deliberately NOT
 * `AppEventBus`: the swarm runner's own deps carry only `{ emit }`
 * (`review_swarm.ts:50`), and this helper never needs subscribe/replay. Widening
 * the parameter here instead of widening SwarmDeps keeps the runner's surface small.
 */
export interface JobEventSink {
  emit(event: AppEvent): void;
}

/**
 * Domains that project into the ledger. Widened freely — clients decode
 * leniently, so a new kind costs no client deploy.
 *
 * `swarm_review` was added 2026-07-30 when the owner deleted the floating "bee"
 * glyph: one pane holds every piece of live background work, so a code review
 * became a row here instead of its own indicator. The first cut excluded it on
 * the grounds that it is never `awaited` — that was the wrong test. `awaited`
 * gates ATTENTION (the pill count, the Live Activity, the push bypass); it must
 * not gate VISIBILITY, or deleting the bee would have made reviews invisible.
 *
 * STILL ABSENT, and these reasons are about shape, not attention:
 *   - `delegations` — `requested_by` is a SPECIALIST id, not a user id
 *     (`tools/delegate.ts:148`), so it cannot fill the user slot `visible()`
 *     compares against; the store has no global list (`list_recent` is keyed per
 *     requesting specialist) and no `private_to` column.
 *   - `beatrice_changes` — a `bchg_*` row is a pending REVIEW awaiting the
 *     owner's decision, which is the proposal queue's job, not a running task.
 *     Its swarm review IS here, which is the part that actually moves.
 *   - agent rooms — real detached work, but its phase machine is SSE-only with
 *     no status row at all, so there is nothing to project. Giving rooms a row
 *     is its own change.
 */
export type JobKind = 'media_archive' | 'research' | 'commission' | 'swarm_review';

/** The five states every domain collapses to. `queued` = accepted, not started. */
export type JobState =
  | 'queued'
  | 'running'
  /**
   * Stopped, recoverable, and waiting on a HUMAN — not on more work.
   * Added for a stalled research investigation (v2 phase 5), which is neither
   * open (the sweep must not revive it) nor terminal. Without it the row fell
   * through to 'failed' at progress 1, showing a stopped-but-recoverable run as
   * a failure that finished. Consumers that only distinguish
   * finished-vs-unfinished should treat this as unfinished.
   */
  | 'blocked'
  | 'done'
  | 'failed'
  | 'cancelled';

/**
 * Structured, per-kind detail for a rich row. Everything here is OPTIONAL and
 * additive: a client that doesn't understand a variant still renders the row
 * from `title`/`phase_label`/`progress` alone.
 */
export interface JobDetail {
  /**
   * Named work units — swarm seats today. Rendered as chips, not a list.
   *
   * ⚠ There is NO persisted per-seat state: `SwarmSeatPhase` is a TYPE that
   * only ever types the SSE emit params (`review_swarm.ts:171`), never a column.
   * So `phase` here is what the bench SPEC says exists, not live progress; live
   * seat phases arrive only on `swarm_seat_update` and are lost on reload. A
   * client must not present these as authoritative live state.
   */
  seats?: Array<{ id: string; role: string; phase: 'queued' | 'working' | 'done' | 'failed' }>;
  /** Countable outcomes — findings on a review, angles answered on a dive. */
  tally?: Array<{ label: string; value: number }>;
  /** A short verdict/outcome word for a finished job ('pass', 'block'). */
  outcome?: string;
}

export interface Job {
  /** The NATIVE domain id (ma_*, ri_*, rc_*, dl_*) — never a synthetic key, so
   *  a client that already holds a domain id can address the same job. */
  id: string;
  kind: JobKind;
  title: string;
  subtitle: string | null;
  /** Drives the hue + avatar. Falls back to 'kate' where a domain has no owner. */
  owner_specialist_id: string;
  /** Domain-native phase (`downloading`, `verifying`) — stable for logic. */
  phase: string;
  /** Human phase, for display. Never empty. */
  phase_label: string;
  state: JobState;
  /** 0…1, or null for indeterminate. Do NOT synthesize from phase ordinals. */
  progress: number | null;
  /** The runner's own log tail — already written by every domain. */
  log: string[];
  /**
   * A human asked for this, in a thread, and is owed an answer. Viewer-
   * independent (a property of the job, not of who's looking) so the route and
   * the SSE emit share one mapper. Drives the delivery-window bypass and
   * whether the job counts toward the pill.
   */
  awaited: boolean;
  requested_by: string | null;
  conversation_id: string | null;
  /** Where "done" lands, as a `hearth://` deep link. Null while running. */
  result_route: string | null;
  error: string | null;
  /** Whether this domain can stand its runner down (research only, today). */
  cancellable: boolean;
  /**
   * Optional per-kind detail so a row can be RICH rather than a log line — the
   * owner's brief was "web2.0 rich, not some shitty feed". Absent for kinds with
   * nothing structured to show; clients must render fine without it.
   */
  detail?: JobDetail;
  /**
   * The ordered phases this kind moves through, so a client can render POSITION
   * IN A CHAIN (Queued → Downloading → **Filing** → Filed) instead of a bare
   * label. A chain reads as a state; a lone label reads as a status line, which
   * is the difference between a dashboard and a feed.
   *
   * Terminal phases are deliberately excluded — the chain is the road, not the
   * destination. Empty for kinds whose phases aren't a fixed sequence.
   */
  phase_chain: Array<{ phase: string; label: string }>;
  /**
   * How long jobs of this kind USUALLY take, in ms, from real history — or null
   * when there isn't enough of it.
   *
   * This is the honest alternative to a fake progress bar. A media download has
   * no byte counter, so instead of animating a lie we tell the user what normal
   * looks like: "2m elapsed · these usually take ~3m". Median, not mean: one
   * pathological 40-minute download must not move the number.
   */
  typical_ms: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  /** The row's cordon — used by the route filter and the SSE fan-out. Not for display. */
  private_to: string | null;
}

export interface JobFeed {
  generated_at: string;
  active: Job[];
  recent: Job[];
}

/** How long a finished job keeps showing in `recent`. */
const RECENT_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Is this a REAL conversation a human is sitting in, or a synthetic context?
 *
 * A bare ULID is a real thread. Anything carrying a colon is machinery —
 * `deliberation:ruby:00:00`, `delegate:…`, `swarm:<review>:<seat>` — and
 * `specialist_runtime.ts` states outright that such an id "will not exist in the
 * conversations table". `delegation.ts:352` guards on exactly this before
 * enqueuing a conversation report; the ledger has to apply the same test.
 *
 * LOAD-BEARING, not cosmetic. `awaited` drives the pill count, the iOS Live
 * Activity, AND the delivery-window push bypass — so getting it wrong means an
 * autonomous deliberation's research dive wakes the owner's phone claiming to be
 * work they asked for. Live proof the first cut had it wrong: investigation
 * `ri_8kpyxw9m4ncr` carries `conversation_id = 'deliberation:ruby:00:00'` and was
 * projected as `awaited: true`.
 */
function is_human_conversation(conversation_id: string | null): boolean {
  return conversation_id !== null && conversation_id.length > 0 && !conversation_id.includes(':');
}

/** Work a human asked for, in a real thread, and is owed an answer about. */
function is_awaited(requested_by: string | null, conversation_id: string | null): boolean {
  return requested_by !== null && is_human_conversation(conversation_id);
}


// ── phase chains + "how long does this usually take" ─────────────────────────

/**
 * The road each kind travels, in order. Terminal phases are excluded — the
 * chain shows where a job IS, and "done" is where it stops being on the chain.
 * Derived from the same label maps the rows use, so a chain step and a phase
 * label can never disagree.
 */
const MEDIA_CHAIN: MediaJobStatus[] = ['pending', 'probing', 'classifying', 'downloading', 'filing', 'indexing'];
const RESEARCH_CHAIN: InvestigationStatus[] = ['pending', 'planning', 'investigating', 'verifying', 'synthesizing'];
const COMMISSION_CHAIN: CommissionStatus[] = ['pending', 'acquiring', 'synthesizing'];

function chain_of<T extends string>(steps: readonly T[], labels: Record<T, string>) {
  return steps.map((phase) => ({ phase, label: labels[phase] }));
}

/**
 * Median wall-clock for COMPLETED jobs of a kind, from real history.
 *
 * Median rather than mean so one pathological run (a 40-minute download behind
 * a slow CDN) can't move the number the user is shown. Requires at least
 * MIN_SAMPLES finished rows — below that "usually" would be a guess dressed as
 * a fact, and the field is null so clients say nothing rather than something
 * wrong.
 *
 * Recomputed per feed read and memoised for a minute: this is a handful of rows
 * scanned in SQLite, and staleness of up to 60 s in an "about how long" number
 * is beneath notice.
 */
const MIN_SAMPLES = 3;
const TYPICAL_TTL_MS = 60_000;
const _typical_cache = new Map<string, { at: number; ms: number | null }>();

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

function typical_ms_for(db: Database, kind: JobKind, now: number): number | null {
  const hit = _typical_cache.get(kind);
  if (hit && now - hit.at < TYPICAL_TTL_MS) return hit.ms;

  const TABLES: Partial<Record<JobKind, { table: string; start: string; end: string }>> = {
    media_archive: { table: 'media_archive_jobs', start: 'created_at', end: 'completed_at' },
    research: { table: 'research_investigations', start: 'created_at', end: 'completed_at' },
    commission: { table: 'research_commissions', start: 'created_at', end: 'completed_at' },
    swarm_review: { table: 'swarm_reviews', start: 'started_at', end: 'judged_at' },
  };
  const spec = TABLES[kind];
  if (!spec) return null;

  let ms: number | null = null;
  try {
    const rows = db
      .prepare(
        `SELECT ${spec.start} AS a, ${spec.end} AS b FROM ${spec.table}
          WHERE ${spec.end} IS NOT NULL ORDER BY ${spec.end} DESC LIMIT 40`,
      )
      .all() as Array<{ a: string | null; b: string | null }>;
    const durations = rows
      .map((r) => Date.parse(r.b ?? '') - Date.parse(r.a ?? ''))
      // Guard against clock weirdness and rows whose timestamps disagree.
      .filter((d) => Number.isFinite(d) && d > 0 && d < 6 * 60 * 60_000);
    ms = durations.length >= MIN_SAMPLES ? median(durations) : null;
  } catch {
    ms = null;
  }
  _typical_cache.set(kind, { at: now, ms });
  return ms;
}

function terminal_state(status: string): JobState {
  if (status === 'done' || status === 'judged') return 'done';
  if (status === 'cancelled') return 'cancelled';
  return 'failed';
}

// ── media downloads ──────────────────────────────────────────────────────────

const MEDIA_PHASE_LABELS: Record<MediaJobStatus, string> = {
  pending: 'Queued',
  probing: 'Reading the page',
  classifying: 'Sorting it',
  downloading: 'Downloading',
  filing: 'Filing',
  indexing: 'Indexing',
  done: 'Filed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** yt-dlp's title, else the bare URL — probe_json is a full info-json passthrough. */
function media_title(row: MediaJobRow): string {
  const probe = row.probe as { title?: unknown } | null;
  const t = probe && typeof probe.title === 'string' ? probe.title.trim() : '';
  return t.length > 0 ? t : row.url;
}

function media_subtitle(row: MediaJobRow): string | null {
  const cat = row.category as { folder_segments?: unknown } | null;
  const segs = cat && Array.isArray(cat.folder_segments) ? cat.folder_segments : null;
  if (segs && segs.length > 0) return segs.filter((s): s is string => typeof s === 'string').join(' / ');
  try {
    return new URL(row.url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function job_from_media_row(row: MediaJobRow): Job {
  const open = OPEN_MEDIA_JOB_STATUSES.includes(row.status);
  return {
    id: row.id,
    kind: 'media_archive',
    title: media_title(row),
    subtitle: media_subtitle(row),
    owner_specialist_id: 'kate',
    phase: row.status,
    phase_label: MEDIA_PHASE_LABELS[row.status] ?? row.status,
    state: open ? (row.status === 'pending' ? 'queued' : 'running') : terminal_state(row.status),
    // Four discrete phases, no byte counter — indeterminate is the honest answer.
    progress: null,
    log: (row.state.log ?? []).slice(-8),
    awaited: is_awaited(row.requested_by, row.conversation_id),
    requested_by: row.requested_by,
    conversation_id: row.conversation_id,
    result_route: row.status === 'done' && row.media_item_id ? `hearth://media/${row.media_item_id}` : null,
    error: row.error,
    cancellable: false,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    private_to: row.private_to,
    phase_chain: chain_of(MEDIA_CHAIN, MEDIA_PHASE_LABELS),
    typical_ms: null,
  };
}

// ── deep research ────────────────────────────────────────────────────────────

const RESEARCH_PHASE_LABELS: Record<InvestigationStatus, string> = {
  pending: 'Queued',
  planning: 'Planning the angles',
  investigating: 'Searching',
  verifying: 'Checking claims',
  synthesizing: 'Writing it up',
  // Stopped moving, not finished and not broken (v2 phase 5). The owner is
  // asked whether to keep going with more budget, narrow it, or stop.
  stalled: 'Stalled — needs a decision',
  // OPEN, not terminal: a partial dossier exists but the coverage ledger still
  // carries un-attempted facets, so the runner will resume it (v2 phase 2).
  // Naming it "Paused" rather than "Incomplete" keeps the ledger's vocabulary
  // about what happens NEXT — the user's question is "is this still coming?".
  incomplete: 'Paused — more to gather',
  done: 'Filed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * Coarse progress from status. Deliberately NOT a second implementation:
 * `routes/research.ts` exports `progress_of` and the Research Room pane already
 * shares it, so this delegates rather than inventing a parallel ladder.
 */
export function job_from_investigation_row(
  row: InvestigationRow,
  progress_of: (s: InvestigationStatus) => number,
): Job {
  const open = OPEN_INVESTIGATION_STATUSES.includes(row.status);
  // A stalled run is neither open (the sweep must not revive it) nor terminal.
  // Without this it fell through to terminal_state() → 'failed' at progress 1:
  // the dock would show a stopped-but-recoverable investigation as a FAILED one
  // that finished, which is both wrong facts and the wrong call to action.
  const stalled = row.status === 'stalled';
  const answered = row.findings.filter((f) => f.findings.length > 0).length;
  const total = row.plan?.sub_questions.length ?? 0;
  return {
    id: row.id,
    kind: 'research',
    title: row.subject,
    subtitle: total > 0 ? `${answered} of ${total} angles` : row.subject_kind,
    owner_specialist_id: row.agent_id ?? 'kate',
    phase: row.status,
    phase_label: RESEARCH_PHASE_LABELS[row.status] ?? row.status,
    state: stalled
      ? 'blocked'
      : open
        ? row.status === 'pending'
          ? 'queued'
          : 'running'
        : terminal_state(row.status),
    progress: open || stalled ? progress_of(row.status) : 1,
    log: (row.state.log ?? []).slice(-8),
    awaited: is_awaited(row.requested_by, row.conversation_id),
    requested_by: row.requested_by,
    conversation_id: row.conversation_id,
    result_route: row.status === 'done' ? `hearth://research/${row.id}` : null,
    error: row.error,
    // The one domain that can genuinely stand its runner down (PR #197).
    cancellable: true,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    private_to: row.private_to,
    phase_chain: chain_of(RESEARCH_CHAIN, RESEARCH_PHASE_LABELS),
    typical_ms: null,
  };
}

// ── research commissions ─────────────────────────────────────────────────────

const COMMISSION_PHASE_LABELS: Record<CommissionStatus, string> = {
  pending: 'Queued',
  acquiring: 'Gathering sources',
  synthesizing: 'Writing it up',
  done: 'Shelved',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function job_from_commission_row(row: CommissionRow): Job {
  const open = OPEN_COMMISSION_STATUSES.includes(row.status);
  return {
    id: row.id,
    kind: 'commission',
    title: row.title,
    subtitle: `${row.shelved.length} shelved`,
    owner_specialist_id: row.target_specialist_id,
    phase: row.status,
    phase_label: COMMISSION_PHASE_LABELS[row.status] ?? row.status,
    state: open ? (row.status === 'pending' ? 'queued' : 'running') : terminal_state(row.status),
    progress: null,
    log: (row.state.log ?? []).slice(-8),
    // A commission is filed BY a specialist for a shelf — no conversation to
    // answer into, so it is never `awaited` and never counts toward the pill.
    awaited: false,
    requested_by: row.requested_by,
    conversation_id: null,
    result_route: row.status === 'done' && row.index_note_path ? `hearth://library/${row.target_specialist_id}` : null,
    error: row.error,
    cancellable: false,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    private_to: row.private_to,
    phase_chain: chain_of(COMMISSION_CHAIN, COMMISSION_PHASE_LABELS),
    typical_ms: null,
  };
}

// ── swarm reviews (the red/blue/judge bench on a code change) ────────────────

/**
 * A stranded `status='running'` row is PERMANENT. `run_swarm` is the only writer
 * of `status`, there is no boot sweep and no reconciliation, so an orchestrator
 * restart mid-review leaves a row that `list_active()` returns forever — and
 * that would sit in this pane reading "Reviewing" until someone edited SQL.
 *
 * 15 minutes is not invented here: `review_change.ts:35` already uses
 * `SWARM_WAIT_CEILING_MS = 15 * 60_000` to decide when a sitting bench has gone
 * stale enough to rule without it. A bench takes ~3 minutes in practice (the two
 * live rows: 2m13s and 2m33s), so this is generous.
 */
const SWARM_STALE_MS = 15 * 60_000;

export function job_from_swarm_row(
  row: SwarmReviewRow,
  findings: SwarmFindingRow[],
  now: number = Date.now(),
): Job {
  const started = Date.parse(row.started_at);
  const stale = row.status === 'running' && Number.isFinite(started) && now - started > SWARM_STALE_MS;
  const state: JobState = row.status === 'running' ? (stale ? 'failed' : 'running') : terminal_state(row.status);

  // Seat SPECS, not live state — see JobDetail.seats. A terminal review's seats
  // are all done by definition; a live one's are unknowable from the DB, so they
  // read 'working' rather than pretending to a per-seat phase nothing persists.
  const seat_phase: NonNullable<JobDetail['seats']>[number]['phase'] =
    state === 'running' ? 'working' : state === 'queued' ? 'queued' : 'done';
  const seats = row.bench.map((s) => ({ id: s.seat_id, role: s.role, phase: seat_phase }));

  return {
    id: row.id,
    kind: 'swarm_review',
    title: row.title,
    subtitle: row.tier === 'higher_court' ? 'appeal · higher court' : `${row.bench.length}-seat bench`,
    // The critic sits the bench; Kate receives the flag. Hue-wise this is the
    // critic's work, and `SpecialistHues.color(for:)` is total for any id.
    owner_specialist_id: 'critic',
    phase: stale ? 'stale' : row.status,
    phase_label: stale
      ? 'Stalled'
      : row.status === 'running'
        ? 'Reviewing'
        : row.status === 'judged'
          ? (row.verdict ?? 'judged').replace(/_/g, ' ')
          : 'Failed',
    state,
    // Seats complete one at a time with no per-seat persistence, so there is no
    // honest fraction to report. Indeterminate.
    progress: null,
    log: [],
    // Court-fired: no requester, no thread. `awaited` stays false so a review
    // never claims the pill, the Live Activity, or the push bypass — it is
    // visible without being an interruption, which is the whole distinction.
    awaited: false,
    requested_by: row.user_id,
    conversation_id: null,
    result_route: null,
    error: stale ? 'The reviewing process stopped without recording a verdict.' : null,
    cancellable: false,
    created_at: row.started_at,
    updated_at: row.judged_at ?? row.started_at,
    completed_at: row.judged_at,
    // `user_id` is hardcoded NULL at the only commission site
    // (`review_routing.ts:116`), so this is always null → `note_visible_to_caller`
    // fails CLOSED to owner-only (`private_to.ts:118`). That is the right answer
    // for a review of the household's own agent code, and it is stricter than the
    // existing `/swarm/active` route, which any authenticated tier can read.
    private_to: row.user_id,
    // A bench is not a SEQUENCE — the seats run concurrently and the judge
    // closes. An invented chain would misrepresent how the work happens.
    phase_chain: [],
    typical_ms: null,
    detail: {
      seats,
      tally: [{ label: 'findings', value: findings.length }],
      // Deliberately NOT surfacing per-finding `severity`: `extractFinding`
      // matches /\bblocker\b/ against the digest, so "no blocker found" mints a
      // `blocker`. Both live findings are severity='blocker' and one is the BLUE
      // seat agreeing with red. The count is honest; the severity is not.
      ...(row.verdict ? { outcome: row.verdict.replace(/_/g, ' ') } : {}),
    },
  };
}


// ── dismissals (the ONE thing this module writes) ────────────────────────────

/**
 * Per-user dismissal of a ledger row.
 *
 * This is the single exception to "the projection never writes", and it holds
 * the line: a dismissal is view state about the LEDGER, not about the domain.
 * Clearing a finished download from your pane must never touch
 * `media_archive_jobs`. Keyed per user, so a household member tidying up is
 * invisible to the owner.
 *
 * Only TERMINAL rows may be dismissed. Hiding live work would be a footgun —
 * the next `job_progress` patch puts it straight back, so the button would
 * appear to do nothing. Running work is stopped (where the domain supports it),
 * not hidden.
 */
export function dismiss_job(db: Database, user_id: string, job_key: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO job_dismissals (user_id, job_key, ts) VALUES (@u, @k, @ts)`,
  ).run({ '@u': user_id, '@k': job_key, '@ts': new Date().toISOString() });
}

/** Dismiss every row this caller can currently see that is finished. Returns the count. */
export function dismiss_all_finished(deps: JobsDeps, caller: Caller): number {
  if (!caller.user_id) return 0;
  const feed = list_jobs(deps, caller);
  for (const job of feed.recent) dismiss_job(deps.db, caller.user_id, job_key(job));
  return feed.recent.length;
}

/** `<kind>:<id>` — matches `Job.key` on the clients so a dismissal addresses the same row. */
export function job_key(job: Job): string {
  return `${job.kind}:${job.id}`;
}

function dismissed_keys(db: Database, user_id: string | undefined): Set<string> {
  if (!user_id) return new Set();
  try {
    const rows = db
      .prepare(`SELECT job_key FROM job_dismissals WHERE user_id = @u`)
      .all({ '@u': user_id }) as Array<{ job_key: string }>;
    return new Set(rows.map((r) => r.job_key));
  } catch {
    // A deployment that predates the table must still serve the ledger.
    return new Set();
  }
}

// ── the fan-in read ──────────────────────────────────────────────────────────

export interface JobsDeps {
  db: Database;
  /** Injected so this module does not re-implement research's progress ladder. */
  progress_of: (s: InvestigationStatus) => number;
}

function visible(job: Job, caller: Caller): boolean {
  if (job.requested_by !== null && job.requested_by === caller.user_id) return true;
  return note_visible_to_caller(job.private_to ?? undefined, caller);
}

function is_active(job: Job): boolean {
  return job.state === 'queued' || job.state === 'running';
}

/**
 * Every job this caller may see, split active / recent. Per-domain reads are
 * INDEPENDENTLY fail-open: one store throwing (a table a deployment predates,
 * a malformed state_json) drops that domain from the feed rather than blanking
 * the pane — the same per-element leniency the clients apply to the rows.
 */
export function list_jobs(deps: JobsDeps, caller: Caller, opts: { limit?: number } = {}): JobFeed {
  const limit = opts.limit ?? 40;
  const cutoff = new Date(Date.now() - RECENT_WINDOW_MS).toISOString();
  const jobs: Job[] = [];

  const collect = (fn: () => Job[]): void => {
    try {
      jobs.push(...fn());
    } catch {
      /* one domain's failure must not blank the pane */
    }
  };

  collect(() => new MediaArchiveJobStore(deps.db).list_for_user(caller, { limit }).map(job_from_media_row));
  collect(() =>
    new ResearchInvestigationStore(deps.db)
      .list_for_user(caller, { limit })
      .map((row) => job_from_investigation_row(row, deps.progress_of)),
  );
  collect(() =>
    new ResearchCommissionStore(deps.db).list({ limit }).map(job_from_commission_row),
  );
  collect(() => {
    // `list_active()` is the only global read the store offers, and it CANNOT be
    // trusted as "active": its own query already mixes running rows with anything
    // judged in the last 30 min, and — the real trap — when that set is empty it
    // falls back to `latest_case()`, which returns every review of the
    // most-recently-started change REGARDLESS OF AGE. With two rows in the whole
    // table and the newest 4 days old, an unfiltered call resurrects both on
    // every read. (That fallback is exactly why the bee glyph flashed on every
    // app foreground.) So take the rows and re-apply an honest window here.
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    return new SwarmReviewStore(deps.db)
      .list_active()
      .filter((r) => {
        if (r.status === 'running') return true;
        const judged = Date.parse(r.judged_at ?? '');
        return Number.isFinite(judged) && judged >= cutoff;
      })
      .map((r) => job_from_swarm_row(r, r.findings));
  });

  const cleared = dismissed_keys(deps.db, caller.user_id);
  const now_ms = Date.now();
  const mine = jobs
    .filter((j) => visible(j, caller) && !cleared.has(job_key(j)))
    // Filled HERE rather than in the mappers so those stay pure (and smoke-
    // testable without a history table). Memoised per kind for a minute.
    .map((j) => ({ ...j, typical_ms: typical_ms_for(deps.db, j.kind, now_ms) }));
  const active = mine.filter(is_active).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const recent = mine
    .filter((j) => !is_active(j))
    // A finished job stays on the wall for a day; older results live in the
    // library / dossier, which is the durable record.
    .filter((j) => (j.completed_at ?? j.updated_at) >= cutoff)
    .sort((a, b) => (b.completed_at ?? b.updated_at).localeCompare(a.completed_at ?? a.updated_at))
    .slice(0, 20);

  return { generated_at: new Date().toISOString(), active, recent };
}

/** One job by kind + id, cordon-checked. Null = not found OR not visible (the
 *  caller can't tell the difference — 404-shape, never a 403 leak). */
export function get_job(deps: JobsDeps, caller: Caller, kind: string, id: string): Job | null {
  let job: Job | null = null;
  try {
    switch (kind) {
      case 'media_archive': {
        const row = new MediaArchiveJobStore(deps.db).get(id);
        job = row ? job_from_media_row(row) : null;
        break;
      }
      case 'research': {
        const row = new ResearchInvestigationStore(deps.db).get(id);
        job = row ? job_from_investigation_row(row, deps.progress_of) : null;
        break;
      }
      case 'commission': {
        const row = new ResearchCommissionStore(deps.db).get(id);
        job = row ? job_from_commission_row(row) : null;
        break;
      }
      case 'swarm_review': {
        const store = new SwarmReviewStore(deps.db);
        const row = store.get(id);
        job = row ? job_from_swarm_row(row, store.get_findings(id)) : null;
        break;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
  if (!job || !visible(job, caller)) return null;
  return { ...job, typical_ms: typical_ms_for(deps.db, job.kind, Date.now()) };
}

// ── the live patch ───────────────────────────────────────────────────────────

/**
 * Emit `job_progress` for a job that just changed phase. Called by the runners
 * at the point they ALREADY persist a transition, so the event reflects
 * committed state. Fail-open: a bus error must never fail a pipeline phase.
 *
 * `log_tail` is capped at 3 lines — the event is a patch, not a transcript; a
 * client that wants the whole log drills into GET /api/jobs/:kind/:id.
 */
export function emit_job_progress(events: JobEventSink | undefined, job: Job): void {
  if (!events) return;
  try {
    events.emit({
      type: 'job_progress',
      kind: job.kind,
      job_id: job.id,
      title: job.title,
      subtitle: job.subtitle,
      owner_specialist_id: job.owner_specialist_id,
      phase: job.phase,
      phase_label: job.phase_label,
      state: job.state,
      progress: job.progress,
      log_tail: job.log.slice(-3),
      awaited: job.awaited,
      conversation_id: job.conversation_id,
      result_route: job.result_route,
      error: job.error,
      private_to: job.private_to,
      user_id: job.requested_by,
      // Rich detail rides the patch too, so a seat chip lights the moment the
      // bench moves rather than waiting for the next full read.
      ...(job.detail ? { detail: job.detail } : {}),
    });
  } catch {
    /* the bus is best-effort — a phase must not fail because nobody was listening */
  }
}
