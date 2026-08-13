/**
 * Live workout throttle + smart-trigger evaluator (Astrid Pass 3;
 * insight engine + Laur voice clips added by Live Ride Companion
 * Phase 1 — docs/design-astrid-live-companion.md §6).
 *
 * Subscribes to workout_packet events. Per packet, evaluates whether
 * to send Astrid a coaching push. DETECTION stays deterministic and
 * LLM-free in the per-packet loop (this file + insight.ts). On a hit,
 * the cue TEXT is rendered by the interactive LLM tier grounded in the
 * live evidence (cue_render.ts, numeric-grounding-checked, FAIL-OPEN
 * to the deterministic templates below), and — when voice is on — a
 * Laur clip is synthesized (cue_voice.ts) and attached to the APNs
 * `hearth.workout_cue` payload. Kill switches:
 * HEARTH_ASTRID_INSIGHT=0 (templates only) and HEARTH_ASTRID_VOICE=0
 * (text-only pushes); both also disabled under HEARTH_TEST_MODE.
 *
 * Legacy pacing triggers (evaluated first, in priority order — first
 * match wins, throttle cap applies):
 *
 *   1. session_end           — final summary at workout completion.
 *                              Bypasses the 10-min cap.
 *   2. pr_in_reach           — current active_kcal within 90% of the
 *                              user's highest_active_kcal PR for this
 *                              workout_type AND enough time remains
 *                              to plausibly beat it. (Distance + duration
 *                              PRs land in a future tightening pass.)
 *   3. midpoint              — once per session: elapsed_s >= half of
 *                              the prior-PR duration (proxy for "you
 *                              should be feeling it"). Skipped if
 *                              no PR baseline exists, or if the
 *                              baseline is under 10 min (a degenerate
 *                              "PR" from a phantom session is not a
 *                              pacing baseline — see
 *                              MIN_DURATION_BASELINE_S).
 *   4. final_push            — once per session: elapsed_s >= 90% of
 *                              prior-PR duration. Same baseline floor.
 *   5. check_in              — the LAST-RESORT presence beat: only on
 *                              sessions >15 min, only every ~15 min,
 *                              and only when NO cue of any kind has
 *                              been sent for a full interval. Insight
 *                              triggers (insight.ts) outrank it.
 *
 * Throttle: per-user min-gap between cues (default 5 min via
 * users.yaml training.cue_min_gap_min) + a per-session cue cap
 * (default 12). Exceptions: session_end always sends, and pr_in_reach
 * can bypass the gap when the PR delta is small (within 5%) AND
 * time-remaining is tight — earning the spam by the strength of the
 * trigger. The caps are checked BEFORE insight detection so a
 * throttled packet never consumes a detector one-shot.
 *
 * Mute is real: POST /api/workout/cues/mute flips cues_muted on the
 * workout_sessions row (restart-proof); this subscriber checks it
 * before any send.
 *
 * State is in-memory (per session). Restart loses it — orphan
 * sessions GC at 6h anyway, and a fresh session starts clean.
 */

import { ulid } from 'ulid';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { AppEvent, AppEventBus } from '../../app/events';
import type { MemoryClient } from '@memory/client';
import type { LLMRouter } from '@core/llm';
import type { UserRegistry } from '@core/users';
import type { WorkoutSessionTracker, ActiveWorkoutSession } from '../../app/routes/workout';
import { push_text } from '../../policy/push';
import { send_apns, build_alert_payload, audit_apns, type ApnsTokenStore } from '../../policy/apns';
import { WorkoutCueStore, CLIP_TTL_MS } from '@memory/stores/workout_cues';
import { WorkoutRouteStore } from '@memory/stores/workout_routes';
import { read_shelf, update_shelf, is_meaningful_session, MIN_MEANINGFUL_SESSION_S } from './pr_shelf';
import { SessionInsightState, detect_insight, type InsightTriggerId } from './insight';
import { type Units, units_for, dist_to_m, dist_from_m, dist_unit, elev_from_m, speed_from_pace_s_per_km } from '@core/units';
import { render_cue } from './cue_render';
import { synthesize_cue_clip } from './cue_voice';
import { generate_ride_name, power_band_label, time_of_day_label, type RideNameInput } from './ride_name';
import { fetch_brief_weather } from '../../connectors/weather';

const CHECK_IN_MIN_SESSION_MS = 15 * 60 * 1000;  // 15 minutes
const CHECK_IN_INTERVAL_MS = 15 * 60 * 1000;     // 15 minutes
const PR_IN_REACH_THRESHOLD = 0.9;          // 90% of PR
const FINAL_PUSH_THRESHOLD = 0.9;           // 90% of prior duration

const DEFAULT_CUE_MIN_GAP_MIN = 5;
const DEFAULT_CUE_SESSION_CAP = 12;
/** Default distance-milestone interval, in the user's display units. */
const DEFAULT_MILESTONE_IMPERIAL_MI = 5;
const DEFAULT_MILESTONE_METRIC_KM = 10;

/** Insight render + voice are skipped under TEST_MODE so the fixture
 *  smokes stay deterministic (same gating shape as the fact critic). */
function insight_enabled(): boolean {
  return process.env.HEARTH_ASTRID_INSIGHT !== '0' && process.env.HEARTH_TEST_MODE !== '1';
}

function voice_enabled(): boolean {
  return process.env.HEARTH_ASTRID_VOICE !== '0' && process.env.HEARTH_TEST_MODE !== '1';
}

interface CueSettings {
  min_gap_ms: number;
  session_cap: number;
  voice: boolean;
  /** Milestone interval in meters (knob is in the user's display units). */
  milestone_m: number;
  units: Units;
}

function cue_settings_for(user_id: string, deps: LiveThrottleDeps): CueSettings {
  const user = deps.users?.get(user_id);
  const t = user?.training;
  const units = units_for(user);
  const milestone_display =
    t?.cue_distance_milestone ??
    (units === 'imperial' ? DEFAULT_MILESTONE_IMPERIAL_MI : DEFAULT_MILESTONE_METRIC_KM);
  return {
    min_gap_ms: (t?.cue_min_gap_min ?? DEFAULT_CUE_MIN_GAP_MIN) * 60_000,
    session_cap: t?.cue_session_cap ?? DEFAULT_CUE_SESSION_CAP,
    voice: (t?.voice_cues ?? 'on') !== 'off',
    milestone_m: dist_to_m(milestone_display, units),
    units,
  };
}

/**
 * A prior "longest session" shorter than this is no pacing baseline:
 * midpoint/final_push stay silent rather than firing "Halfway through"
 * minutes into a real workout. The 2026-06-10 ride hit exactly that —
 * a phantom 2026-06-01 session left a ~0-min cycling PR, so midpoint
 * fired at elapsed=30s and final_push at ~60s. Defense in depth with
 * the write-side floor in pr_shelf (MIN_MEANINGFUL_SESSION_S): this
 * guard also covers legacy shelves written before that floor existed.
 */
const MIN_DURATION_BASELINE_S = 600;        // 10 minutes

type Trigger = 'session_end' | 'pr_in_reach' | 'midpoint' | 'final_push' | 'check_in' | InsightTriggerId;

interface LivePushState {
  midpoint_pushed: boolean;
  final_push_pushed: boolean;
  pr_distance_pushed: boolean;
  last_check_in_at: number | null;
}

const live_state = new Map<string, LivePushState>();

function get_state(session_id: string): LivePushState {
  let s = live_state.get(session_id);
  if (!s) {
    s = { midpoint_pushed: false, final_push_pushed: false, pr_distance_pushed: false, last_check_in_at: null };
    live_state.set(session_id, s);
  }
  return s;
}

const insight_states = new Map<string, SessionInsightState>();

function get_insight_state(session_id: string): SessionInsightState {
  let s = insight_states.get(session_id);
  if (!s) {
    s = new SessionInsightState();
    insight_states.set(session_id, s);
  }
  return s;
}

function within_cap(session: ActiveWorkoutSession, now_ms: number, gap_ms: number): boolean {
  const last_str = session.pushes_sent_at[session.pushes_sent_at.length - 1];
  if (!last_str) return true;
  const last = Date.parse(last_str);
  if (!Number.isFinite(last)) return true;
  return now_ms - last >= gap_ms;
}

function is_muted(deps: LiveThrottleDeps, session_id: string): boolean {
  if (!deps.db) return false;
  try {
    const row = deps.db
      .prepare('SELECT cues_muted FROM workout_sessions WHERE session_id = @s')
      .get({ '@s': session_id }) as { cues_muted: number | null } | null;
    return row?.cues_muted === 1;
  } catch {
    return false;
  }
}

interface TriggerHit {
  trigger: Trigger;
  override_cap: boolean;
  template: string;
  /** Deterministic facts for the render evidence (numbers as numbers). */
  facts?: Record<string, unknown>;
  /** Trigger class — tints the render register. Legacy triggers map
   *  via LEGACY_CLASS at delivery. */
  cls?: string;
}

const LEGACY_CLASS: Record<string, string> = {
  pr_in_reach: 'effort',
  midpoint: 'effort',
  final_push: 'effort',
  check_in: 'presence',
  session_end: 'wrap_up',
};

const r1 = (n: number): number => Math.round(n * 10) / 10;

// Exported for the self-contained smoke (scripts/test-astrid-live-floors.ts).
export function evaluate_triggers(
  vault_root: string,
  session: ActiveWorkoutSession,
  units: Units = 'imperial',
): TriggerHit | null {
  const now_ms = Date.now();
  const state = get_state(session.session_id);

  // pr_in_reach — kcal-based for v1, distance + duration in a future
  // pass. Only fires when active_kcal crossed 90% of PR threshold.
  const shelf = read_shelf(vault_root, session.user_id, session.workout_type);
  const kcal_pr = shelf?.highest_active_kcal?.value ?? null;
  if (kcal_pr != null && kcal_pr > 0) {
    const ratio = session.active_kcal / kcal_pr;
    if (ratio >= PR_IN_REACH_THRESHOLD && ratio < 1.0) {
      // Override the 10-min cap if you're within 5% AND elapsed is
      // already long (≥ 15 min) — the moment matters.
      const tight_window = ratio >= 0.95 && session.elapsed_s >= 15 * 60;
      const remaining_kcal = Math.round(kcal_pr - session.active_kcal);
      return {
        trigger: 'pr_in_reach',
        override_cap: tight_window,
        template: `${remaining_kcal} more kcal for your ${session.workout_type} PR. You've got the engine — keep the pressure. — A.`,
        facts: {
          remaining_kcal,
          kcal_pr: Math.round(kcal_pr),
          kcal_so_far: Math.round(session.active_kcal),
        },
      };
    }
  }

  // pr_in_reach, distance flavor (2026-06-12) — the farthest-ride
  // record is in reach. Duration deliberately has NO arm: final_push at
  // 90% of the longest-session baseline IS that moment already.
  const dist_pr = shelf?.longest_distance_m?.value ?? null;
  if (
    dist_pr != null &&
    dist_pr >= 5000 &&
    session.distance_m != null &&
    !state.pr_distance_pushed
  ) {
    const ratio = session.distance_m / dist_pr;
    if (ratio >= PR_IN_REACH_THRESHOLD && ratio < 1.0) {
      state.pr_distance_pushed = true;
      const remaining = dist_from_m(dist_pr - session.distance_m, units);
      const du = dist_unit(units);
      return {
        trigger: 'pr_in_reach',
        override_cap: ratio >= 0.95 && session.elapsed_s >= 15 * 60,
        template: `${remaining} ${du} more and your farthest ${session.workout_type} falls. Keep rolling. — A.`,
        facts: {
          metric: 'distance',
          [`remaining_${du}`]: remaining,
          [`pr_${du}`]: dist_from_m(dist_pr, units),
          [`distance_${du}`]: dist_from_m(session.distance_m, units),
        },
      };
    }
  }

  // midpoint — needs a prior-duration baseline (use the longest_seconds
  // PR or the prior_pr_metric on the session if it's longest_seconds).
  // A baseline below the floor is treated as absent.
  const raw_baseline_s =
    shelf?.longest_seconds?.value ??
    (session.prior_pr_metric?.metric === 'longest_seconds' ? session.prior_pr_metric.value : null);
  const duration_baseline_s =
    raw_baseline_s != null && raw_baseline_s >= MIN_DURATION_BASELINE_S ? raw_baseline_s : null;
  if (duration_baseline_s != null && !state.midpoint_pushed) {
    const half = duration_baseline_s / 2;
    if (session.elapsed_s >= half) {
      state.midpoint_pushed = true;
      return {
        trigger: 'midpoint',
        override_cap: false,
        template: `Halfway through. ${session.current_hr ? `HR's at ${session.current_hr}` : 'Steady'}. Don't slow down on me. — A.`,
        facts: {
          baseline_min: Math.round(duration_baseline_s / 60),
          elapsed_min: Math.round(session.elapsed_s / 60),
          current_hr: session.current_hr,
        },
      };
    }
  }

  // final_push — 90% of prior duration, once per session.
  if (duration_baseline_s != null && !state.final_push_pushed) {
    const final_threshold = duration_baseline_s * FINAL_PUSH_THRESHOLD;
    if (session.elapsed_s >= final_threshold) {
      state.final_push_pushed = true;
      return {
        trigger: 'final_push',
        override_cap: false,
        template: `Final stretch. This is the part that earns it. — A.`,
        facts: {
          baseline_min: Math.round(duration_baseline_s / 60),
          elapsed_min: Math.round(session.elapsed_s / 60),
        },
      };
    }
  }

  // check_in — only on long sessions (>15 min), every ~15 min wall-time.
  const session_start_ms = Date.parse(session.started_at);
  if (Number.isFinite(session_start_ms) && now_ms - session_start_ms >= CHECK_IN_MIN_SESSION_MS) {
    const last_check = state.last_check_in_at ?? session_start_ms;
    if (now_ms - last_check >= CHECK_IN_INTERVAL_MS) {
      state.last_check_in_at = now_ms;
      const mins = Math.round(session.elapsed_s / 60);
      return {
        trigger: 'check_in',
        override_cap: false,
        template: `${mins} min in. Still with you. — A.`,
        facts: { minutes_in: mins, presence_beat: 'true' },
      };
    }
  }

  return null;
}

// ── Coaching-log append helper (mirrors push_coaching_note tool) ─────

const COACHING_LOG_HEADER = `# Astrid's coaching-decision log

Every push Astrid sent AND every push she chose NOT to send. Trigger,
decision, one-sentence why. Makes "you nagged me too much last week"
debuggable, and gives Beatrice concrete substrate for persona tuning.
Newest first; capped at 500 entries.

<!-- entries below -->
`;

const MAX_LOG_ENTRIES = 500;

function append_capped(existing: string, header: string, entry: string, cap: number): string {
  let content = existing.length > 0 ? existing : header;
  if (!content.startsWith('# ')) content = header + '\n' + content;
  const marker = '<!-- entries below -->';
  const idx = content.indexOf(marker);
  const insert_at = idx >= 0 ? idx + marker.length : content.length;
  const prefix = content.slice(0, insert_at);
  const suffix = content.slice(insert_at);
  let next = `${prefix}\n\n${entry}\n${suffix}`;
  const headers = [...next.matchAll(/^### /gm)];
  if (headers.length > cap) {
    const cutoff = headers[cap];
    if (cutoff && cutoff.index !== undefined) {
      next = next.slice(0, cutoff.index);
    }
  }
  return next;
}

function log_decision(args: {
  vault_root: string;
  user_id: string;
  session_id: string;
  trigger: Trigger;
  message: string;
  delivered: boolean;
  via: string | null;
  reason: string;
}): void {
  const ts = new Date().toISOString();
  const rel_path = `users/${args.user_id}/astrid/coaching-log.md`;
  const abs_path = resolve(args.vault_root, rel_path);
  const existing = existsSync(abs_path) ? readFileSync(abs_path, 'utf8') : '';
  const entry = [
    `### ${ts}`,
    '',
    `**Trigger**: ${args.trigger} · **Delivered**: ${args.delivered ? 'yes' : 'no'}${args.via ? ` (via ${args.via})` : ''}`,
    '',
    `> ${args.message}`,
    '',
    `_${args.reason}_`,
    `_session: ${args.session_id}_`,
  ].join('\n');
  const final_content = append_capped(existing, COACHING_LOG_HEADER, entry, MAX_LOG_ENTRIES);
  try {
    mkdirSync(dirname(abs_path), { recursive: true });
    writeFileSync(abs_path, final_content, 'utf8');
  } catch (err) {
    console.error(`[astrid_live] failed to write coaching log: ${(err as Error).message}`);
  }
}

// ── The subscriber ────────────────────────────────────────────────────

export interface LiveThrottleDeps {
  events: AppEventBus;
  tracker: WorkoutSessionTracker;
  memory: MemoryClient;
  vault_root: string;
  /** Live Ride Companion Phase 1 deps — ALL optional. Absent ⇒ the
   *  legacy template/text-push behavior, which is also what every
   *  fail-open path degrades to. */
  db?: Database;
  llm?: LLMRouter;
  apns_tokens?: ApnsTokenStore;
  users?: UserRegistry;
  tts_base_url?: string;
  cue_clip_dir?: string;
}

let cue_store: WorkoutCueStore | null = null;
let route_store: WorkoutRouteStore | null = null;
let cue_gc_timer: ReturnType<typeof setInterval> | null = null;

export function register_live_throttle(deps: LiveThrottleDeps): () => void {
  if (deps.db) {
    cue_store = new WorkoutCueStore(deps.db);
    route_store = new WorkoutRouteStore(deps.db);
    if (!cue_gc_timer) {
      cue_gc_timer = setInterval(() => {
        try {
          cue_store?.sweep(CLIP_TTL_MS);
        } catch (err) {
          console.warn(`[astrid_live] cue clip sweep failed: ${(err as Error).message}`);
        }
      }, 6 * 60 * 60 * 1000);
      (cue_gc_timer as unknown as { unref?: () => void }).unref?.();
    }
  }
  return deps.events.subscribe((event: AppEvent) => {
    if (event.type === 'workout_packet') {
      void handle_packet(event, deps);
    } else if (event.type === 'workout_completed') {
      void handle_completed(event, deps);
    }
  });
}

function snapshot_of(session: ActiveWorkoutSession, units: Units): Record<string, number | string | null> {
  return {
    elapsed_min: Math.round(session.elapsed_s / 60),
    active_kcal: Math.round(session.active_kcal),
    [`distance_${dist_unit(units)}`]:
      session.distance_m != null ? dist_from_m(session.distance_m, units) : null,
    current_hr: session.current_hr,
    current_hr_zone: session.current_hr_zone,
    // Elevation rides in every cue's evidence, not just the climb
    // triggers' facts — "650 feet of climbing in the first hour" is
    // legitimate color for a zone_shift or check_in render too.
    [`elevation_gain_${units === 'imperial' ? 'ft' : 'm'}`]:
      session.elevation_gain_m != null ? elev_from_m(session.elevation_gain_m, units) : null,
  };
}

function strip_sig(t: string): string {
  return t.replace(/\s*—\s*A\.\s*$/, '').trim();
}

async function handle_packet(
  event: Extract<AppEvent, { type: 'workout_packet' }>,
  deps: LiveThrottleDeps,
): Promise<void> {
  const session = deps.tracker.get(event.session_id);
  if (!session) return;

  const istate = get_insight_state(event.session_id);
  istate.append({
    at_ms: Date.now(),
    elapsed_s: session.elapsed_s,
    active_kcal: session.active_kcal,
    distance_m: session.distance_m,
    current_hr: session.current_hr,
    current_hr_zone: session.current_hr_zone,
    elevation_gain_m: session.elevation_gain_m,
    lat: session.lat,
    lon: session.lon,
  });
  if (istate.inflight) return;

  const settings = cue_settings_for(session.user_id, deps);

  // Device autopause: the Watch paused the session. Total silence —
  // the sample is appended (the stop bookkeeping sees the freeze) but
  // no detection, no cues, until it resumes.
  if (session.paused) return;

  // 30-day comparable digest, loaded once per session — IO stays out
  // of the detector.
  if (!istate.history_loaded && session.elapsed_s >= 300) {
    istate.history_loaded = true;
    try {
      const rows = deps.memory.query_workouts(session.user_id, '30d', 100);
      const same = rows.filter((r) => r.workout_type === session.workout_type);
      istate.history_longest_s = same.length > 0 ? Math.max(...same.map((r) => r.duration_min * 60)) : null;
      istate.history_rides_30d = same.length;
      istate.history_distance_m_30d = same.reduce((a, r) => a + (r.total_distance_km ?? 0) * 1000, 0);
    } catch {
      istate.history_longest_s = null;
    }
  }

  const now_ms = Date.now();
  const legacy = evaluate_triggers(deps.vault_root, session, settings.units);
  const can_send = within_cap(session, now_ms, settings.min_gap_ms);
  const session_capped = session.pushes_sent_at.length >= settings.session_cap;
  const muted = is_muted(deps, event.session_id);

  let hit: TriggerHit | null = null;
  if (legacy && legacy.trigger !== 'check_in') {
    // Pacing/PR triggers keep their existing semantics (incl. the
    // tight-PR cap override), gated by mute + session cap.
    if (muted) {
      if (!istate.mute_logged) {
        istate.mute_logged = true;
        log_decision({
          vault_root: deps.vault_root,
          user_id: event.user_id,
          session_id: event.session_id,
          trigger: legacy.trigger,
          message: legacy.template,
          delivered: false,
          via: null,
          reason: 'suppressed: cues muted by user',
        });
      }
      return;
    }
    if (session_capped || (!legacy.override_cap && !can_send)) {
      log_decision({
        vault_root: deps.vault_root,
        user_id: event.user_id,
        session_id: event.session_id,
        trigger: legacy.trigger,
        message: legacy.template,
        delivered: false,
        via: null,
        reason: session_capped
          ? `suppressed: session cue cap (${settings.session_cap}) reached`
          : 'suppressed by cue min-gap throttle',
      });
      return;
    }
    hit = legacy;
  } else {
    // Insight + check_in path. Gate BEFORE detection so a throttled or
    // muted packet never consumes a detector one-shot.
    if (muted || session_capped || !can_send) return;
    // Live route recognition (owner-requested 2026-06-12): once the
    // ride has shape (>=1.5 km) and live positions are flowing, match
    // the in-RAM track against known route groups — once per session,
    // re-checked every ~2 min to bound cost. On match, the recognition
    // becomes a narrative cue AND rides in every later render's
    // evidence ("your 5th time on this loop; best is 48 min").
    if (
      route_store &&
      !istate.fired.has('route_recognized') &&
      session.distance_m != null &&
      session.distance_m >= 1500 &&
      istate.samples.length % 4 === 0
    ) {
      try {
        const track = istate.samples
          .filter((x) => x.lat != null && x.lon != null)
          .map((x) => ({ lat: x.lat!, lon: x.lon! }));
        if (track.length >= 10) {
          const grp = route_store.match_group(
            session.user_id,
            { points: track, length_m: session.distance_m },
            { partial: true },
          );
          if (grp) {
            istate.fired.add('route_recognized');
            const stats = route_store.group_stats(session.user_id, grp);
            const best_min = stats.best_duration_s != null ? Math.round(stats.best_duration_s / 60) : null;
            istate.recognized_route = {
              name: stats.name,
              times_ridden: stats.times_ridden + 1,
              best_min,
              group_id: grp,
            };
            hit = {
              trigger: 'route_recognized',
              override_cap: false,
              cls: 'narrative',
              template: `I know this one — ride ${stats.times_ridden + 1} on this route${best_min != null ? `. Your best is ${best_min} minutes` : ''}. — A.`,
              facts: {
                times_ridden: stats.times_ridden + 1,
                best_min,
                ...(stats.name ? { route_name: stats.name } : {}),
              },
            };
          }
        }
      } catch (err) {
        console.warn(`[astrid_live] route recognition failed (skipping): ${(err as Error).message}`);
      }
    }
    if (!hit && insight_enabled()) {
      const ih = detect_insight(istate, { milestone_m: settings.milestone_m, units: settings.units }, session.workout_type);
      if (ih) {
        hit = { trigger: ih.trigger, override_cap: false, template: `${ih.fallback} — A.`, facts: ih.facts, cls: ih.cls };
      }
    }
    if (!hit && legacy) {
      // check_in survives as the last-resort presence beat: only when
      // nothing of ANY kind has been said for a full interval.
      const last_push_str = session.pushes_sent_at[session.pushes_sent_at.length - 1];
      const silent_ms = last_push_str ? now_ms - Date.parse(last_push_str) : Number.POSITIVE_INFINITY;
      if (silent_ms >= CHECK_IN_INTERVAL_MS) hit = legacy;
    }
  }
  if (!hit) return;

  istate.inflight = true;
  try {
    await produce_and_deliver({
      hit,
      session_id: event.session_id,
      user_id: event.user_id,
      workout_type: session.workout_type,
      snapshot: snapshot_of(session, settings.units),
      settings,
      deps,
      istate,
      elapsed_s: session.elapsed_s,
      record_push: true,
      reason_detail: hit.override_cap
        ? 'override (tight PR window)'
        : `auto-trigger at elapsed=${session.elapsed_s}s, kcal=${Math.round(session.active_kcal)}`,
    });
  } finally {
    istate.inflight = false;
  }
}

// ── Render + voice + delivery ────────────────────────────────────────

interface DeliverArgs {
  hit: TriggerHit;
  session_id: string;
  user_id: string;
  workout_type: string;
  snapshot: Record<string, number | string | null>;
  settings: CueSettings;
  deps: LiveThrottleDeps;
  /** Insight state for evidence enrichment (curve, stops, 30-day digest). */
  istate?: SessionInsightState | null;
  /** Session elapsed at cue time (the map joins cues to route points). */
  elapsed_s?: number | null;
  /** False for session_end — the tracker session is already closed. */
  record_push: boolean;
  reason_detail: string;
}

async function produce_and_deliver(args: DeliverArgs): Promise<void> {
  const { hit, deps } = args;

  // 1. Grounded render (fail-open → deterministic template).
  let rendered_text: string | null = null;
  if (insight_enabled() && deps.llm) {
    const shelf = read_shelf(deps.vault_root, args.user_id, args.workout_type);
    const personal_records = shelf
      ? {
          longest_session_min: shelf.longest_seconds ? Math.round(shelf.longest_seconds.value / 60) : null,
          [`longest_distance_${dist_unit(args.settings.units)}`]: shelf.longest_distance_m
            ? dist_from_m(shelf.longest_distance_m.value, args.settings.units)
            : null,
          highest_active_kcal: shelf.highest_active_kcal ? Math.round(shelf.highest_active_kcal.value) : null,
        }
      : null;
    const u = args.settings.units;
    const istate = args.istate ?? null;
    const session_curve =
      istate && istate.chunks.length > 0
        ? istate.chunks.map((c) => {
            const span_s = Math.max(60, (c.end_min - c.start_min) * 60);
            const speed = c.distance_m > 0 ? r1((c.distance_m / span_s) * (u === 'imperial' ? 2.236936 : 3.6)) : null;
            return {
              minutes: `${c.start_min}-${c.end_min}`,
              avg_hr: c.avg_hr,
              [`speed_${u === 'imperial' ? 'mph' : 'kmh'}`]: speed,
              ...(c.gain_m > 0 ? { [`climb_${u === 'imperial' ? 'ft' : 'm'}`]: elev_from_m(c.gain_m, u) } : {}),
            };
          })
        : null;
    const stops =
      istate && istate.stops_count > 0
        ? { count: istate.stops_count, total_min: Math.round(istate.stopped_total_s / 60) }
        : null;
    const last_30_days =
      istate && istate.history_rides_30d != null
        ? {
            rides: istate.history_rides_30d,
            [`total_${dist_unit(u)}`]:
              istate.history_distance_m_30d != null ? dist_from_m(istate.history_distance_m_30d, u) : null,
            longest_min: istate.history_longest_s != null ? Math.round(istate.history_longest_s / 60) : null,
          }
        : null;
    rendered_text = await render_cue(deps.llm, {
      trigger: hit.trigger,
      cls: hit.cls ?? LEGACY_CLASS[hit.trigger],
      user_display: deps.users?.get(args.user_id)?.display_name ?? args.user_id,
      workout_type: args.workout_type,
      snapshot: args.snapshot,
      facts: hit.facts ?? {},
      personal_records,
      session_curve,
      stops,
      last_30_days,
      route: istate?.recognized_route
        ? {
            times_ridden: istate.recognized_route.times_ridden,
            best_min: istate.recognized_route.best_min,
            ...(istate.recognized_route.name ? { name: istate.recognized_route.name } : {}),
          }
        : null,
    });
  }
  const body = rendered_text ?? strip_sig(hit.template);

  // 2. Laur voice clip (fail-open → text-only).
  let clip: {
    id: string;
    url: string;
    duration_s: number | null;
    bytes: number;
    format: string;
  } | null = null;
  if (voice_enabled() && args.settings.voice && cue_store && deps.cue_clip_dir && deps.tts_base_url) {
    const clip_id = `wc_${ulid().toLowerCase()}`;
    const synth = await synthesize_cue_clip({
      text: body,
      clip_id,
      out_dir: join(deps.cue_clip_dir, args.user_id),
      tts_base_url: deps.tts_base_url,
    });
    if (synth) {
      cue_store.insert({
        clip_id,
        session_id: args.session_id,
        user_id: args.user_id,
        ts: new Date().toISOString(),
        trigger_id: hit.trigger,
        text: body,
        format: synth.format,
        duration_s: synth.duration_s,
        bytes: synth.bytes,
        file_path: synth.file_path,
      });
      clip = {
        id: clip_id,
        url: `/api/workout/cues/${clip_id}`,
        duration_s: synth.duration_s,
        bytes: synth.bytes,
        format: synth.format,
      };
    }
  }

  // 3. Deliver: APNs workout_cue payload first (the iOS app intercepts
  //    it, plays the clip, updates the Live Activity); push_text is the
  //    fallback when APNs is unconfigured / tokenless / failing.
  const push_body = `${body} — A.`;
  let delivered = false;
  let via: string | null = null;
  if (deps.apns_tokens) {
    try {
      const payload = build_alert_payload({
        body: push_body,
        // When a clip rides along the app speaks — no system chime on
        // top of Laur. Text-only keeps the default sound.
        sound: clip ? null : undefined,
        thread_id: `workout-${args.session_id}`,
        category: 'WORKOUT_CUE',
        extras: {
          hearth: {
            route: { kind: 'specialist', id: 'astrid' },
            workout_cue: {
              session_id: args.session_id,
              trigger: hit.trigger,
              text: body,
              ts: new Date().toISOString(),
              ...(clip ? { clip } : {}),
            },
          },
        },
      });
      const res = await send_apns({
        store: deps.apns_tokens,
        user_id: args.user_id,
        collapse_id: `wc-${args.session_id}`,
        payload,
      });
      audit_apns(deps.memory, {
        user_id: args.user_id,
        category: 'WORKOUT_CUE',
        push_type: 'alert',
        attempts: res.attempts,
        reason: `astrid:live:${hit.trigger}`,
      });
      delivered = res.delivered;
      via = delivered ? 'apns' : null;
    } catch (err) {
      console.warn(`[astrid_live] APNs cue delivery failed, falling back: ${(err as Error).message}`);
    }
  }
  if (!delivered) {
    const res = await push_text(push_body, deps.memory, ulid(), `astrid:live:${hit.trigger}`);
    delivered = res.delivered;
    via = res.via ?? null;
  }

  if (args.record_push) {
    deps.tracker.record_push(args.session_id, new Date().toISOString());
  }
  // The cue ledger — every DELIVERED cue with its WHY, queryable for
  // the coached-ride map (cue pins joined to route points by ts).
  if (delivered && route_store) {
    try {
      route_store.record_cue({
        cue_id: `cue_${ulid().toLowerCase()}`,
        session_id: args.session_id,
        user_id: args.user_id,
        ts: new Date().toISOString(),
        elapsed_s: args.elapsed_s ?? null,
        trigger_id: hit.trigger,
        cls: hit.cls ?? LEGACY_CLASS[hit.trigger] ?? null,
        text: body,
        reason: args.reason_detail,
        clip_id: clip?.id ?? null,
      });
    } catch (err) {
      console.warn(`[astrid_live] cue ledger write failed: ${(err as Error).message}`);
    }
  }
  log_decision({
    vault_root: deps.vault_root,
    user_id: args.user_id,
    session_id: args.session_id,
    trigger: hit.trigger,
    message: push_body,
    delivered,
    via,
    reason: `${args.reason_detail} · ${rendered_text != null ? 'rendered' : 'template'}${clip ? ` · voice ${clip.id}` : ''}`,
  });
}

async function handle_completed(
  event: Extract<AppEvent, { type: 'workout_completed' }>,
  deps: LiveThrottleDeps,
): Promise<void> {
  // Degenerate-session floor: phantom sessions (auto-detected walks,
  // aborted starts) post end packets with near-zero duration. No shelf
  // write, no "0-min walking done. 0 kcal." push — just the suppressed
  // decision in the coaching log so the trail stays debuggable.
  if (!is_meaningful_session(event.total_duration_s)) {
    log_decision({
      vault_root: deps.vault_root,
      user_id: event.user_id,
      session_id: event.session_id,
      trigger: 'session_end',
      message: `(no push) ${Math.round(event.total_duration_s)}s ${event.workout_type} below the ${MIN_MEANINGFUL_SESSION_S}s floor`,
      delivered: false,
      via: null,
      reason: 'suppressed: degenerate session below meaningful floor',
    });
    live_state.delete(event.session_id);
    insight_states.delete(event.session_id);
    return;
  }

  // Update PR shelf — returns broken records for the final message.
  const { broken } = update_shelf(deps.vault_root, event.user_id, {
    workout_type: event.workout_type,
    ended_at: event.ended_at,
    duration_s: event.total_duration_s,
    active_kcal: event.total_active_kcal,
    total_distance_m: event.total_distance_m,
  });

  // Name the ride (Phase 2.5) — fire-and-forget so the session_end cue
  // never waits on weather + a second LLM call. Fallback naming inside
  // is deterministic, so even a dead LLM leaves a usable name.
  void name_completed_ride(event, broken, deps).catch((err) => {
    console.warn(`[astrid_live] ride naming failed: ${(err as Error).message}`);
  });

  // Session-end cue: summary + PR ack, rendered + voiced like any
  // other cue (always sends — override_cap by design).
  const mins = Math.round(event.total_duration_s / 60);
  const kcal = Math.round(event.total_active_kcal);
  const end_settings = cue_settings_for(event.user_id, deps);
  const dist_key = `distance_${dist_unit(end_settings.units)}`;
  const dist_val =
    event.total_distance_m != null ? dist_from_m(event.total_distance_m, end_settings.units) : null;
  let route_facts: Record<string, unknown> = {};
  try {
    const grp = route_store?.get(event.session_id)?.route_group_id;
    if (grp && route_store) {
      const stats = route_store.group_stats(event.user_id, grp);
      route_facts = {
        route_times_ridden: stats.times_ridden,
        route_best_min: stats.best_duration_s != null ? Math.round(stats.best_duration_s / 60) : null,
      };
    }
  } catch {
    // route context is opportunistic
  }
  const pr_text = broken.length > 0
    ? ` New record on ${broken.length === 1 ? broken[0]!.replace(/_/g, ' ') : `${broken.length} metrics`}.`
    : '';
  const fallback = `${mins}-min ${event.workout_type} done. ${kcal} kcal.${pr_text} — A.`;

  await produce_and_deliver({
    hit: {
      trigger: 'session_end',
      override_cap: true,
      template: fallback,
      facts: {
        duration_min: mins,
        active_kcal: kcal,
        [dist_key]: dist_val,
        records_broken: broken.length > 0 ? broken.join(', ') : null,
        ...route_facts,
      },
    },
    session_id: event.session_id,
    user_id: event.user_id,
    workout_type: event.workout_type,
    snapshot: { duration_min: mins, active_kcal: kcal, [dist_key]: dist_val },
    settings: end_settings,
    istate: insight_states.get(event.session_id) ?? null,
    elapsed_s: event.total_duration_s,
    deps,
    record_push: false,
    reason_detail: broken.length > 0 ? `PRs broken: ${broken.join(', ')}` : 'standard session-end summary',
  });

  // Clear the per-session state maps (the tracker.close already
  // happened in the route — we just clean our parallel state).
  live_state.delete(event.session_id);
  insight_states.delete(event.session_id);
}

// ── Ride naming (Phase 2.5) ──────────────────────────────────────────
// Builds the grounded evidence (completed row + time-of-day + weather +
// power band + route descriptors) and writes ride_name back onto the
// session row. Weather comes from the household's home coordinates
// (HEARTH_HOME_LAT/LON) — ride coordinates never reach the server, so
// "the sky over the ride" is approximated by the sky over home.

async function name_completed_ride(
  event: Extract<AppEvent, { type: 'workout_completed' }>,
  records_broken: string[],
  deps: LiveThrottleDeps,
): Promise<void> {
  if (!deps.db) return;
  const row = deps.db
    .prepare(
      `SELECT started_at, avg_hr, max_hr, elevation_gain_m, avg_power_w,
              route_notes_json, hr_zone_minutes_json
         FROM workout_sessions
        WHERE session_id = @s AND user_id = @u`,
    )
    .get({ '@s': event.session_id, '@u': event.user_id }) as {
      started_at: string;
      avg_hr: number | null;
      max_hr: number | null;
      elevation_gain_m: number | null;
      avg_power_w: number | null;
      route_notes_json: string | null;
      hr_zone_minutes_json: string | null;
    } | null;
  if (!row) return;

  // Weather at session end — best-effort, never blocks the name.
  let weather: RideNameInput['weather'] = null;
  let weather_json: string | null = null;
  const lat = Number.parseFloat(process.env.HEARTH_HOME_LAT ?? '');
  const lng = Number.parseFloat(process.env.HEARTH_HOME_LON ?? '');
  if (insight_enabled() && Number.isFinite(lat) && Number.isFinite(lng)) {
    try {
      const res = await fetch_brief_weather({ lat, lng });
      if (res.ok) {
        weather = {
          current_temperature_f: res.data.current_temperature_f,
          current_condition: res.data.current_condition,
          forecast_summary: res.data.forecast_summary,
        };
        weather_json = JSON.stringify(weather);
      }
    } catch {
      // no weather, no problem — the name grounds in what exists
    }
  }

  const tz = deps.users?.get_timezone(event.user_id) ?? 'America/Denver';
  const started = new Date(row.started_at);
  let hour = 12;
  let local_start = row.started_at;
  if (Number.isFinite(started.getTime())) {
    try {
      const h = Number.parseInt(
        new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(started), // time-guard-ok: tz threaded from UserRegistry (Denver fallback) — hour-of-day flavor for ride naming
        10,
      );
      if (Number.isFinite(h)) hour = h % 24;
      local_start = new Intl.DateTimeFormat('en-US', { // time-guard-ok: tz threaded from UserRegistry (Denver fallback) — weekday+time string for the ride-name prompt
        weekday: 'long',
        hour: 'numeric',
        minute: '2-digit',
        hour12: false,
        timeZone: tz,
      }).format(started);
    } catch {
      // keep defaults — a midday-flavored name beats a crash
    }
  }

  const duration_min = Math.round(event.total_duration_s / 60);
  const name_units = units_for(deps.users?.get(event.user_id));
  const distance =
    event.total_distance_m != null && event.total_distance_m > 0
      ? dist_from_m(event.total_distance_m, name_units)
      : null;
  const avg_speed =
    distance != null && event.total_duration_s > 0
      ? Math.round((distance / (event.total_duration_s / 3600)) * 10) / 10
      : null;

  const parse_json = (s: string | null): unknown => {
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  const input: RideNameInput = {
    user_display: deps.users?.get(event.user_id)?.display_name ?? event.user_id,
    workout_type: event.workout_type,
    local_start,
    time_of_day: time_of_day_label(hour),
    duration_min,
    distance,
    distance_unit: dist_unit(name_units),
    avg_speed,
    speed_unit: name_units === 'imperial' ? 'mph' : 'km/h',
    active_kcal: Math.round(event.total_active_kcal),
    avg_hr: row.avg_hr != null ? Math.round(row.avg_hr) : null,
    max_hr: row.max_hr != null ? Math.round(row.max_hr) : null,
    elevation_gain: row.elevation_gain_m != null ? elev_from_m(row.elevation_gain_m, name_units) : null,
    elevation_unit: name_units === 'imperial' ? 'ft' : 'm',
    avg_power_w: row.avg_power_w != null ? Math.round(row.avg_power_w) : null,
    power_band: power_band_label(row.avg_power_w),
    hr_zone_minutes: parse_json(row.hr_zone_minutes_json) as Record<string, number> | null,
    weather,
    route_notes: parse_json(row.route_notes_json) as string[] | null,
    records_broken,
  };

  const { name, rendered } = await generate_ride_name(
    insight_enabled() ? deps.llm : undefined,
    input,
  );

  try {
    deps.db
      .prepare(
        `UPDATE workout_sessions
            SET ride_name = @n,
                end_weather_json = COALESCE(@w, end_weather_json)
          WHERE session_id = @s`,
      )
      .run({ '@n': name, '@w': weather_json, '@s': event.session_id });
  } catch (err) {
    console.error(`[astrid_live] failed to write ride name: ${(err as Error).message}`);
    return;
  }

  deps.memory.log_action({
    intent_id: `ride_name:${event.session_id}`,
    agent: 'astrid',
    tool_name: 'astrid_ride_name',
    tool_input: { session_id: event.session_id, rendered, evidence_keys: Object.keys(input) },
    execution_result: { name },
  });
}
