/**
 * Per-specialist "what is this specialist doing right now" producers.
 *
 * Stage 0 of the Specialist-as-Room shift (see
 * `~/Projects/hearth-ios/SPECIALIST_AS_ROOM_BRIEF.md`). The Today
 * bento and Staff roster on iOS read `Specialist.active_status` and
 * render the label in place of the static role line when the
 * specialist is doing something a glanceable surface should
 * surface. The shape is intentionally tiny:
 *
 *   { label, kind: live|idle|quiet, icon?, pulse_opacity?,
 *     started_at?, expires_at?, deep_link? }
 *
 * `kind` is the consumer's render hint, not a query filter:
 *   - "live"  — a real-time signal is actively driving this status
 *               (workout in flight, listening session, etc.). iOS
 *               pulses the row hue.
 *   - "idle"  — autonomous work happened recently or is ready to
 *               read (brief landed, captures indexed). No pulse.
 *   - "quiet" — explicit "nothing here" — used by callers that want
 *               to override the default null→quiet collapse.
 *
 * Producers are pure: `(db, specialist_id, user_id) → ActiveStatus
 * | null`. Cheap to call — every read is a single indexed query.
 * Recomputed on demand when /api/specialists is served, so there's
 * no cron, no background refresh, no in-process cache to invalidate.
 * iOS refreshes the roster on the existing SSE triggers
 * (messageAdded / inboxMessageAdded / specialistVisited) plus the
 * workout/music lifecycle events added in Stage 0, and the new
 * field comes through with the next /api/specialists pull.
 *
 * Labels are clipped to MAX_LABEL_CHARS at the boundary — the iOS
 * card has a fixed footprint and a runaway 200-char status would
 * blow it out. Producers should write tight strings; the clip is a
 * safety net, not a budget.
 */

import type { Database } from 'bun:sqlite';

export interface ActiveStatus {
  /** ≤60 chars after clip(); render in place of the role label. */
  label: string;
  /** Render hint — see module docstring. */
  kind: 'live' | 'idle' | 'quiet';
  /** Optional SF Symbol name iOS prefixes the label with. */
  icon?: string;
  /** Hue-pulse intensity (0.0–1.0). Used when kind === 'live'. */
  pulse_opacity?: number;
  /** Optional in-app route iOS deep-links to on tap. */
  deep_link?: string;
  /** ISO 8601 — when this state began. iOS uses it for "elapsed" labels. */
  started_at?: string;
  /** ISO 8601 — backend stops claiming this status past this point. */
  expires_at?: string;
}

const MAX_LABEL_CHARS = 60;

function clip(label: string): string {
  if (label.length <= MAX_LABEL_CHARS) return label;
  return label.slice(0, MAX_LABEL_CHARS - 1) + '…';
}

/** "MM:SS" elapsed-time formatter for live workout labels. */
function fmt_elapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Astrid — coaching a live workout if one's active.
 *
 * Reads the most recent `workout_sessions` row with status='active'
 * for this user. iOS posts `start` and `end` packets to /api/workout
 * which flip the status column; while the row is 'active' Astrid is
 * understood to be coaching it (the live-throttle subscriber runs
 * heartbeat decisions through her every 30s).
 *
 * Future passes can layer in the in-memory `WorkoutSessionTracker`
 * state (current HR zone, next-cue countdown) for a richer label;
 * Stage 0 sticks to the row-derived fields so the producer has zero
 * runtime dependencies.
 */
function astrid_status(
  db: Database,
  user_id: string,
): ActiveStatus | null {
  type Row = {
    session_id: string;
    started_at: string;
    workout_type: string;
  };
  const active = db
    .prepare(
      `SELECT session_id, started_at, workout_type
         FROM workout_sessions
        WHERE user_id = @uid AND status = 'active'
        ORDER BY started_at DESC
        LIMIT 1`,
    )
    .get({ '@uid': user_id }) as Row | undefined;
  if (!active) return null;
  const elapsed_s = Math.floor(
    (Date.now() - new Date(active.started_at).getTime()) / 1000,
  );
  return {
    label: clip(`Coaching · ${fmt_elapsed(elapsed_s)} · ${active.workout_type}`),
    kind: 'live',
    icon: 'figure.run',
    pulse_opacity: 0.8,
    started_at: active.started_at,
  };
}

/**
 * Maggie — "listening with you" when a recent music_context snapshot
 * is fresh (within 4h). The snapshot is iOS-driven (MusicKit sensor
 * posts daily + on foreground when stale), so freshness is the
 * proxy for "playing now" — a more accurate "now playing" signal
 * lands when iOS ships a separate "currently playing" sensor.
 *
 * Picks the top artist for the label — the highest-affinity name in
 * the snapshot. Top-1 is enough for a glance; the chat thread is
 * where the full picture lives.
 */
function maggie_status(
  db: Database,
  user_id: string,
): ActiveStatus | null {
  type Row = { snapshot_json: string; captured_at: string };
  const row = db
    .prepare(
      `SELECT snapshot_json, captured_at
         FROM music_context
        WHERE user_id = @uid`,
    )
    .get({ '@uid': user_id }) as Row | undefined;
  if (!row) return null;
  const age_h = (Date.now() - new Date(row.captured_at).getTime()) / 3_600_000;
  if (age_h > 4) return null;
  let artist: string | null = null;
  try {
    const snap = JSON.parse(row.snapshot_json) as {
      top_artists?: Array<{ name: string }>;
    };
    artist = snap.top_artists?.[0]?.name ?? null;
  } catch {
    return null;
  }
  if (!artist) return null;
  return {
    label: clip(`Listening with you · ${artist}`),
    kind: 'live',
    icon: 'music.note',
    pulse_opacity: 0.5,
    started_at: row.captured_at,
  };
}

/**
 * Cordelia — captures indexed today + the triage backlog.
 *
 * "Today" is UTC-day-bucketed against `audit_log.ts` for
 * `cordelia_capture` rows. Triage is pending interrupts originated
 * by Cordelia (low-confidence routes that escalate to Kate). Either
 * being non-zero produces an "Indexing · …" idle line; both zero
 * collapses to null (rendered as "Quiet" on iOS).
 *
 * The `audit_log.user_id` filter is permissive (`= @uid OR IS NULL`)
 * because pre-Phase-2b rows have nil user_id, and a strict equals
 * would hide them. Phase 2c may tighten this to strict-equals once
 * every code path stamps user_id, but Stage 0 keeps it loose so
 * single-user installs still see counts.
 */
function cordelia_status(
  db: Database,
  user_id: string,
): ActiveStatus | null {
  const start_of_day = new Date();
  start_of_day.setUTCHours(0, 0, 0, 0);
  type CountRow = { n: number };
  const today_count =
    (db
      .prepare(
        `SELECT COUNT(*) as n
           FROM audit_log
          WHERE tool_name = 'cordelia_capture'
            AND ts >= @since
            AND (user_id = @uid OR user_id IS NULL)`,
      )
      .get({ '@since': start_of_day.toISOString(), '@uid': user_id }) as
      | CountRow
      | undefined)?.n ?? 0;
  const triage_count =
    (db
      .prepare(
        `SELECT COUNT(*) as n
           FROM interrupts
          WHERE originating_specialist_id = 'cordelia'
            AND status = 'pending'`,
      )
      .get() as CountRow | undefined)?.n ?? 0;
  if (today_count === 0 && triage_count === 0) return null;
  const parts: string[] = [`${today_count} today`];
  if (triage_count > 0) parts.push(`${triage_count} awaiting triage`);
  return {
    label: clip(`Indexing · ${parts.join(' · ')}`),
    kind: 'idle',
    icon: 'tray.full',
    pulse_opacity: 0.4,
  };
}

/**
 * Kate — a brief landed recently and Jasper hasn't consumed it yet.
 *
 * "Recently" is the last 30 min — long enough that a brief generated
 * at 07:00 still surfaces when Jasper picks up his phone at 07:25,
 * tight enough that it doesn't claim "new brief ready" all day.
 * Once consumed_at is set on the brief row (iOS marks it on read),
 * the status collapses to null.
 */
function kate_status(
  db: Database,
  user_id: string,
): ActiveStatus | null {
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  type Row = { id: string; ts_generated: string };
  const row = db
    .prepare(
      `SELECT id, ts_generated
         FROM briefs
        WHERE generated_by_specialist_id = 'kate'
          AND consumed_at IS NULL
          AND ts_generated >= @since
          AND (user_id = @uid OR user_id IS NULL)
        ORDER BY ts_generated DESC
        LIMIT 1`,
    )
    .get({ '@since': since, '@uid': user_id }) as Row | undefined;
  if (!row) return null;
  return {
    label: 'New brief ready to read',
    kind: 'idle',
    icon: 'doc.text',
    pulse_opacity: 0.6,
    started_at: row.ts_generated,
  };
}

/**
 * Dispatch. New specialists earn a producer here as they grow
 * glanceable real-time signals — keep the file lean; a producer is
 * justified only when it reads from data that already exists, not
 * by ginning up filler text from `audit_log`.
 */
export function compute_active_status(
  db: Database,
  specialist_id: string,
  user_id: string,
): ActiveStatus | null {
  switch (specialist_id) {
    case 'astrid':
      return astrid_status(db, user_id);
    case 'maggie':
      return maggie_status(db, user_id);
    case 'cordelia':
      return cordelia_status(db, user_id);
    case 'kate':
      return kate_status(db, user_id);
    default:
      return null;
  }
}
