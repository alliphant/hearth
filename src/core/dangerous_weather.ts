/**
 * DangerousWeatherDriver — proactive safety alerts for dangerous weather
 * (2026-06-23; cadence redesigned 2026-06-24).
 *
 * The Tempest gives ground-truth lightning + wind; Pirate gives NWS severe-
 * weather warnings. This is the autonomous layer that turns those PULL signals
 * into a PUSH: a 60s ticker that edge-detects a genuine danger — a close active
 * lightning strike, an extreme wind gust, or an active NWS warning (tornado /
 * severe thunderstorm) — and on the false→true edge alerts the household
 * BOTH ways: it speaks the warning over the Satellite1 (if anyone's home + near
 * it) AND pushes every home member's phone at `high` severity, which pierces
 * quiet hours and the read-the-room gate (a tornado warning at 3am must wake
 * you).
 *
 * Why a deterministic driver and NOT a woken deliberation: safety delivery
 * cannot depend on the LLM choosing to call a speak/push tool. The detection +
 * the alert text are composed in code; the model is never in the loop. (This is
 * the one place the "wake a scoped deliberation" reactive-trigger pattern is
 * deliberately NOT used — see docs/design-tempest-weather-integration.md.)
 *
 * Mirrors FlightTrackingDriver / MailIdleDriver: DARK by default (`attach()` is
 * a no-op unless HEARTH_DANGEROUS_WEATHER=1), fail-open per tick (a throwing
 * source/delivery is logged + skipped, never aborts the tick or the boot),
 * `stop()` clears the timer.
 *
 * ── Cadence: episode-based gentle + a pressure-relief valve (2026-06-24) ─────
 * The hard problem a lightning sensor surfaces: a danger can last minutes
 * (a close strike) or HOURS (a winter-storm / extreme-cold warning), and a
 * fixed "re-alert every N minutes" cadence is wrong for both — it nags on the
 * long ones and can still firehose on a flickering storm. The redesign:
 *
 *   1. GENTLE = ONCE PER EPISODE. The value is in the FIRST alert. While a
 *      danger is ongoing the driver stays SILENT — no clock-based re-alerts at
 *      all for the notice tier. An "episode" ends only when the danger has been
 *      ABSENT for a full clear-gap (`HEARTH_DANGER_CLEAR_GAP_MS`/30m); the next
 *      occurrence after that is a fresh alert. Tracked via `last_seen_current_ms`
 *      (refreshed every tick the danger is present), so an INTERMITTENT signal
 *      (lightning toggles active↔clear between strikes) keeps the episode alive
 *      as long as strikes are closer together than the clear-gap — it can't
 *      re-fire as a "new edge."
 *
 *   2. PRESSURE-RELIEF VALVE = release on genuine INTENSIFICATION. The episode
 *      cooldown holds back routine continuation, but if the danger is getting
 *      genuinely WORSE — lightning closing in — that releases an alert even
 *      mid-episode. The release is a MONOTONIC band crossing: each Tempest
 *      danger has an intensity axis (lightning: closeness; wind: gust strength)
 *      mapped to an escalation band; the valve opens ONLY when the current band
 *      is STRICTLY HIGHER than the worst band already alerted this episode, then
 *      re-seats `worst_band` higher. This is self-limiting — it can only release
 *      as the storm strictly worsens, never on steady-state or oscillation. A
 *      6→5→6 mi distance drift stays in one band → NO release (the invariant);
 *      a real 8→2 mi close-in releases once. NWS alerts carry no band (an
 *      upgrade arrives as a different KEY — Tornado Warning→Emergency), so the
 *      valve is naturally Tempest-only.
 *
 *   3. CRITICAL keeps a periodic reminder. A sustained take-cover event
 *      (tornado / flash-flood / extreme-wind / fire warning) is the one case
 *      where repetition is a safety feature — it re-fires on the clock
 *      (`HEARTH_DANGER_CRITICAL_MIN_INTERVAL_MS`/10m) while ongoing, toggleable
 *      via `HEARTH_DANGER_CRITICAL_REMIND`. The gentle/notice tier never does.
 */
import type { MemoryClient } from '@memory/client';
import type { UserRegistry } from '@core/users';
import type { ToolContext } from '@core/tool';
import { push_text_to_user } from '@policy/push';
import { try_speak_followup } from '@core/voice_announce';
import { tempest_conditions } from '@connectors/tempest';
import { fetch_weather_alerts, type ActiveWeatherAlert } from '@connectors/weather';
import { resolve_weather_coords } from '@core/weather_location';
import { format_short_datetime } from '@core/time';
import { maybe_flash_emergency_lights } from '@core/emergency_lights';
import type { Database } from 'bun:sqlite';
import {
  EpisodicAlertEngine,
  sqlite_episode_store,
  type ActiveAlert,
  type AlertTone,
  type DeliveryReason,
  env_num,
  env_num_list,
  default_home_user_ids,
} from '@core/episodic_alert';

// The cadence (once-per-episode + the monotonic pressure-relief valve) lives in
// EpisodicAlertEngine now (src/core/episodic_alert.ts), shared with the indoor
// air-quality driver. This file owns the WEATHER-specific detection (Tempest
// lightning/wind + NWS warnings), the band math, and the delivery (push every
// home member at `high` severity + speak via the Satellite1).
export { is_synthetic_account } from '@core/episodic_alert';

export function dangerous_weather_enabled(): boolean {
  return process.env.HEARTH_DANGEROUS_WEATHER === '1';
}

const MIN = 60_000;

/** The raw danger signals one tick reads. */
export interface DangerReadings {
  ok: boolean;
  lightning_active: boolean | null;
  lightning_distance: number | null; // avg strike distance, station unit (mi US)
  /** Strikes in the last obs window (Tempest reports strikes/min). Optional —
   *  threaded for a future strike-rate escalation axis; the live valve uses
   *  closeness only (the count is a noisier intensification signal). */
  lightning_count?: number | null;
  wind_gust: number | null; // station unit (mph US)
}

export interface DangerSources {
  read_tempest(): Promise<DangerReadings>;
  read_alerts(): Promise<ActiveWeatherAlert[]>;
}

export interface DangerDelivery {
  /** Phone push to one user — wired to push_text_to_user at `high` severity. */
  push(user_id: string, text: string): Promise<void>;
  /** Best-effort house announcement over the Satellite1, with an alert tone. */
  speak(text: string, summary: string, tone: AlertTone): Promise<void>;
}

/** One detected weather danger this tick — an `ActiveAlert` (the engine's shape)
 *  whose `value` carries the lightning distance / wind gust for the audit. */
type ActiveDanger = ActiveAlert;

export class DangerousWeatherDriver {
  private readonly memory: MemoryClient;
  private readonly users: UserRegistry | undefined;
  private readonly sources: DangerSources;
  private readonly delivery: DangerDelivery;
  private readonly home_user_ids: () => string[];
  private readonly now: () => number;

  private readonly tick_ms: number;
  private readonly lightning_mi: number;
  private readonly wind_gust_mph: number;
  /** Distance bands (mi, < the alert threshold) whose crossing pierces the
   *  episode cooldown as the storm CLOSES IN. Default two bands — ≤3 mi
   *  ("closing in") + ≤2 mi ("right overhead") — each strictly-worse crossing
   *  releasing once. Sorted descending internally. */
  private readonly lightning_escalation_mi: number[];
  /** Gust bands (mph, > the alert threshold) whose crossing pierces the
   *  cooldown as the wind STRENGTHENS. Default 70 / 90 mph. Ascending. */
  private readonly wind_escalation_mph: number[];
  /** How long a danger must be ABSENT before the next occurrence is a new
   *  episode (and re-alerts). The episode-lifecycle clock. */
  private readonly clear_gap_ms: number;
  /** Critical (take-cover) reminder cadence + toggle: while a critical event is
   *  ongoing, re-fire on this clock (repetition is a safety feature there).
   *  The notice tier NEVER re-fires on a clock — once per episode. */
  private readonly critical_min_interval_ms: number;
  private readonly critical_remind: boolean;

  /** The shared once-per-episode + relief-valve cadence state machine. */
  private readonly engine: EpisodicAlertEngine;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private running = false;

  constructor(deps: {
    /** Needed for the durable episode ledger (alert_episodes). */
    db: Database;
    memory: MemoryClient;
    users?: UserRegistry;
    coordinator_url?: string;
    bearer?: string;
    /** Test seams — default to the real HA/Pirate readers + push/speak. */
    sources?: DangerSources;
    delivery?: DangerDelivery;
    home_user_ids?: () => string[];
    now?: () => number;
  }) {
    this.memory = deps.memory;
    this.users = deps.users;
    this.now = deps.now ?? (() => Date.now());
    this.tick_ms = env_num('HEARTH_DANGER_POLL_MS', MIN);
    this.lightning_mi = env_num('HEARTH_DANGER_LIGHTNING_MI', 10);
    this.wind_gust_mph = env_num('HEARTH_DANGER_WIND_GUST_MPH', 50);
    // Relief-valve bands. Lightning: a ≤3 mi "closing in" band + a ≤2 mi "right
    // overhead" band (each strictly-worse crossing releases once); wind: 70/90 mph.
    this.lightning_escalation_mi = env_num_list('HEARTH_DANGER_LIGHTNING_ESCALATION_MI', [3, 2])
      .slice()
      .sort((a, b) => b - a); // descending: nearer = worse
    this.wind_escalation_mph = env_num_list('HEARTH_DANGER_WIND_ESCALATION_MPH', [70, 90])
      .slice()
      .sort((a, b) => a - b); // ascending: stronger = worse
    // Episode-end clear-gap (30 min). An existing HEARTH_DANGER_NOTICE_MIN_INTERVAL_MS
    // (the retired per-window floor) is honored as a back-compat default so a box
    // that set it keeps a sane gap.
    this.clear_gap_ms = env_num(
      'HEARTH_DANGER_CLEAR_GAP_MS',
      env_num('HEARTH_DANGER_NOTICE_MIN_INTERVAL_MS', 30 * MIN),
    );
    this.critical_min_interval_ms = env_num('HEARTH_DANGER_CRITICAL_MIN_INTERVAL_MS', 10 * MIN);
    // Default ON: a sustained take-cover warning should keep reminding. Set
    // HEARTH_DANGER_CRITICAL_REMIND=0 to make critical also once-per-episode.
    this.critical_remind = (process.env.HEARTH_DANGER_CRITICAL_REMIND ?? '1') !== '0';
    this.engine = new EpisodicAlertEngine({
      store: sqlite_episode_store(deps.db),
      scope: 'weather',
      clear_gap_ms: this.clear_gap_ms,
      critical_min_interval_ms: this.critical_min_interval_ms,
      critical_remind: this.critical_remind,
    });

    this.sources = deps.sources ?? this.default_sources();
    this.delivery =
      deps.delivery ?? this.default_delivery(deps.coordinator_url, deps.bearer);
    this.home_user_ids = deps.home_user_ids ?? (() => default_home_user_ids(this.users));
  }

  /** Wire at boot. No-op unless HEARTH_DANGEROUS_WEATHER=1. Returns a stop fn. */
  attach(): () => void {
    if (!dangerous_weather_enabled()) {
      console.log('[danger] DangerousWeatherDriver disabled (HEARTH_DANGEROUS_WEATHER≠1)');
      return () => {};
    }
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.tick_ms);
    console.log(
      `[danger] DangerousWeatherDriver attached (tick ${Math.round(this.tick_ms / 1000)}s, ` +
        `lightning≤${this.lightning_mi}mi, gust≥${this.wind_gust_mph}mph, ` +
        `once-per-episode, clear-gap ${Math.round(this.clear_gap_ms / MIN)}min, ` +
        `relief-valve lightning≤[${this.lightning_escalation_mi.join(',')}]mi ` +
        `wind≥[${this.wind_escalation_mph.join(',')}]mph, ` +
        `critical-reminder ${this.critical_remind ? `≤1/${Math.round(this.critical_min_interval_ms / MIN)}min` : 'off'})`,
    );
    return () => this.stop();
  }

  /** One pass. Fail-open: any throw is logged + swallowed, never aborts. The
   *  shared engine owns the once-per-episode + relief-valve cadence; this driver
   *  detects + delivers. */
  async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const dangers = await this.detect();
      for (const { alert, reason } of this.engine.decide_pass(dangers, this.now())) {
        await this.deliver(alert, reason);
      }
    } catch (err) {
      console.error('[danger] tick failed (skipped):', err);
    } finally {
      this.running = false;
    }
  }

  /** Read both sources, fail-open per source, and compose the active dangers. */
  private async detect(): Promise<ActiveDanger[]> {
    const out: ActiveDanger[] = [];

    let t: DangerReadings | null = null;
    try {
      t = await this.sources.read_tempest();
    } catch (err) {
      console.error('[danger] tempest read failed (skipped):', err);
    }
    if (t?.ok) {
      // Lightning: a strike in the last obs window, close (or distance unknown).
      if (t.lightning_active === true && (t.lightning_distance === null || t.lightning_distance <= this.lightning_mi)) {
        const d = t.lightning_distance;
        const dist_phrase = d === null || d <= 0 ? 'very close by' : `about ${Math.round(d)} mile${Math.round(d) === 1 ? '' : 's'} away`;
        // "Right overhead" copy when the strike is within the INNERMOST escalation
        // band (≤2 mi by default) AND a closer tier exists — a genuinely on-top-of-
        // you strike earns a stronger message than the ≤3 mi "closing in" one.
        const has_overhead_tier = this.lightning_escalation_mi.length >= 2;
        const innermost_mi = this.lightning_escalation_mi.length
          ? Math.min(...this.lightning_escalation_mi)
          : 0;
        const overhead = has_overhead_tier && d !== null && d <= innermost_mi;
        const esc = overhead
          ? {
              push: `⚡ Lightning is right overhead — the latest strike was ${dist_phrase}. Stay away from windows and exterior walls, and do NOT go outside.`,
              spoken: `This is Kate, with an urgent update. The lightning is right overhead now — the latest strike was ${dist_phrase}. Please stay away from windows and exterior walls, and do not go outside.`,
              summary: `Lightning overhead — ${dist_phrase}`,
            }
          : {
              push: `⚡ Lightning is closing in — the latest strike was ${dist_phrase}. Stay indoors and away from windows, water, and metal.`,
              spoken: `This is Kate, with an update. The lightning is closing in — the latest strike was ${dist_phrase}. Please stay indoors, away from windows, water, and anything metal.`,
              summary: `Lightning closing in — ${dist_phrase}`,
            };
        out.push({
          key: 'lightning',
          value: d,
          band: lightning_escalation_band(d, this.lightning_escalation_mi),
          tone: 'notice',
          push_text: `⚡ Lightning — a strike ${dist_phrase}. Head indoors now; stay clear of windows, water, and metal.`,
          spoken_text: `This is Kate. Lightning just struck ${dist_phrase}. Please head indoors now, and stay away from windows, water, and anything metal.`,
          summary: `Lightning strike ${dist_phrase}`,
          escalation_push: esc.push,
          escalation_spoken: esc.spoken,
          escalation_summary: esc.summary,
        });
      }
      // Extreme wind gust.
      if (t.wind_gust !== null && t.wind_gust >= this.wind_gust_mph) {
        const g = Math.round(t.wind_gust);
        out.push({
          key: 'wind',
          value: g,
          band: wind_escalation_band(t.wind_gust, this.wind_escalation_mph),
          tone: 'notice',
          push_text: `💨 High wind — gusting to ${g} mph at the house. Secure or bring in anything loose outside.`,
          spoken_text: `This is Kate. Winds are gusting to ${g} miles per hour at the house. Please bring in or secure anything loose outside, and take care near trees and power lines.`,
          summary: `Wind gusting ${g} mph`,
          escalation_push: `💨 Wind is picking up — now gusting to ${g} mph. Stay clear of trees and power lines; secure anything still loose.`,
          escalation_spoken: `This is Kate, with an update. The wind is picking up — gusts are now ${g} miles per hour. Please stay clear of trees and power lines, and secure anything still loose.`,
          escalation_summary: `Wind intensifying — gusting ${g} mph`,
        });
      }
    }

    let alerts: ActiveWeatherAlert[] = [];
    try {
      alerts = await this.sources.read_alerts();
    } catch (err) {
      console.error('[danger] alerts read failed (skipped):', err);
    }
    for (const a of alerts) {
      const tier = classify_alert(a.title, a.description);
      if (!tier) continue; // watch / advisory / statement → not a take-action warning
      const until = a.ts_expires ? ` until ${format_short_datetime(a.ts_expires)}` : '';
      const desc = a.description ? ` ${first_sentence(a.description)}` : '';
      // Urgency-tiered closing: take-cover-NOW vs prepare/be-aware.
      const push_action = tier === 'critical' ? ' Take cover now.' : ' Take precautions.';
      const spoken_action =
        tier === 'critical'
          ? ' Please take cover and take appropriate precautions now.'
          : ' Please take appropriate precautions.';
      out.push({
        key: `alert:${slug(a.title)}`,
        value: null,
        band: 0, // NWS alerts have no continuous axis — an upgrade is a new key
        tone: tier,
        push_text: `⚠️ ${a.title} in effect${until}.${desc}${push_action}`,
        spoken_text: `This is Kate. There's a ${a.title} in effect${until}.${desc}${spoken_action}`,
        summary: a.title,
      });
    }
    return out;
  }

  /** Push + speak one weather danger. The engine already committed the episode
   *  state; this just composes the (escalation-aware) text and delivers. */
  private async deliver(d: ActiveDanger, reason: DeliveryReason): Promise<void> {
    const escalating = reason === 'escalation';
    const push_text = (escalating && d.escalation_push) || d.push_text;
    const spoken_text = (escalating && d.escalation_spoken) || d.spoken_text;
    const summary = (escalating && d.escalation_summary) || d.summary;

    const recipients = this.home_user_ids();
    let pushed = 0;
    for (const uid of recipients) {
      try {
        await this.delivery.push(uid, push_text);
        pushed++;
      } catch (err) {
        console.error(`[danger] push failed for ${uid}:`, err);
      }
    }
    let spoke = false;
    try {
      await this.delivery.speak(spoken_text, summary, d.tone);
      spoke = true;
    } catch (err) {
      console.error('[danger] speak failed:', err);
    }
    // Third alert channel: flash the house lights RED on a CRITICAL (EBS) event.
    // Fire-and-forget + fail-open + gated — never on the push/speak critical path.
    if (d.tone === 'critical') maybe_flash_emergency_lights({ memory: this.memory });
    this.audit(d, reason, pushed, spoke);
    console.log(
      `[danger] ALERT ${d.key} (${reason}, band ${d.band}) → pushed ${pushed}/${recipients.length}, spoke=${spoke}`,
    );
  }

  private audit(d: ActiveDanger, reason: DeliveryReason, pushed: number, spoke: boolean): void {
    try {
      this.memory.log_action?.({
        intent_id: `danger:${d.key}`,
        agent: 'dangerous_weather',
        tool_name: 'dangerous_weather_alert',
        tool_input: { key: d.key, value: d.value, band: d.band, reason, summary: d.summary },
        execution_result: { pushed, spoke },
      });
    } catch {
      /* audit is best-effort */
    }
  }

  // ── Default real sources / delivery ──────────────────────────────────────

  private default_sources(): DangerSources {
    const memory = this.memory;
    const users = this.users;
    return {
      read_tempest: async (): Promise<DangerReadings> => {
        const ctx = {
          memory,
          now: new Date(),
          intent_id: 'dangerous-weather',
        } as unknown as ToolContext;
        const out = await tempest_conditions.execute({}, ctx);
        if (!out.ok) return { ok: false, lightning_active: null, lightning_distance: null, lightning_count: null, wind_gust: null };
        return {
          ok: true,
          lightning_active: out.signals?.lightning_active ?? null,
          lightning_distance: out.signals?.lightning_distance ?? null,
          lightning_count: out.readings?.lightning_count?.value ?? null,
          wind_gust: out.readings?.wind_gust?.value ?? null,
        };
      },
      read_alerts: async (): Promise<ActiveWeatherAlert[]> => {
        const owner_id = process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
        const coords = await resolve_weather_coords({ user_id: owner_id, users, memory });
        if (!coords) return [];
        const r = await fetch_weather_alerts({ lat: coords.lat, lng: coords.lng });
        return r.ok ? r.alerts : [];
      },
    };
  }

  private default_delivery(coordinator_url?: string, bearer?: string): DangerDelivery {
    const memory = this.memory;
    return {
      push: async (user_id: string, text: string): Promise<void> => {
        await push_text_to_user(user_id, text, {
          kind: 'ad_hoc',
          severity: 'high', // pierces quiet hours + the read-the-room gate
          originating_specialist_id: 'kate',
        });
      },
      speak: async (text: string, summary: string, tone: AlertTone): Promise<void> => {
        await try_speak_followup({
          text,
          conversation_id: 'dangerous-weather',
          summary,
          pre_tone: tone,
          coordinator_url: coordinator_url ?? process.env.HEARTH_VOICE_COORDINATOR_URL,
          bearer: bearer ?? process.env.HEARTH_INTERNAL_BEARER,
          // We already push every home member separately; the speak path's own
          // push-fallback would double-notify, so make it a no-op.
          push: async () => true,
        });
        void memory; // reserved for a future spoken-announcement audit row
      },
    };
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// ── Pure helpers ───────────────────────────────────────────────────────────
// (`is_synthetic_account` + the cadence engine live in @core/episodic_alert and
//  are re-exported above; these are the weather-specific band math.)

/** Lightning escalation band for the relief valve: how many "closing-in"
 *  thresholds (mi, descending) the strike distance is now WITHIN. 0 = alerted
 *  but not yet escalated (or distance unknown — can't measure closeness);
 *  higher = nearer = strictly more dangerous. Pure + deterministic. */
export function lightning_escalation_band(distance_mi: number | null, thresholds_desc: number[]): number {
  if (distance_mi === null) return 0; // unknown distance → can't escalate on it
  let band = 0;
  for (const t of thresholds_desc) if (distance_mi <= t) band++;
  return band;
}

/** Wind escalation band: how many gust thresholds (mph, ascending) the gust now
 *  EXCEEDS. 0 = alerted but not escalated; higher = stronger = worse. */
export function wind_escalation_band(gust_mph: number | null, thresholds_asc: number[]): number {
  if (gust_mph === null) return 0;
  let band = 0;
  for (const t of thresholds_asc) if (gust_mph >= t) band++;
  return band;
}

/** NWS event types that warrant the EAS `critical` tone — the short,
 *  genuinely take-cover-NOW, life-threatening-at-home set. Matched as a
 *  substring of the lowercased title (the NWS event name). Everything else in
 *  the warning taxonomy gets the friendlier `notice` chime. Flash-flood is here
 *  on purpose: in the Riverside / Big Thompson canyons + post-burn-scar terrain
 *  it's fast and deadly. (Severe Thunderstorm Warning is `notice` UNLESS it's
 *  destructive/tornado-tagged — handled below.) */
const CRITICAL_WARNINGS = [
  'tornado warning',
  'flash flood warning',
  'extreme wind warning',
  'fire warning', // an official NWS active-fire / evacuation alert (not a fire-weather Red Flag)
] as const;

/**
 * Classify an NWS alert into the TIER it should fire at — `'critical'` (EAS
 * attention tone, pierces everything) or `'notice'` (soft chime) — or `null`
 * when it is NOT a take-action WARNING (a watch / advisory / statement /
 * outlook is precautionary, not take-cover-now → no danger alert).
 *
 * Tiering keys on the EVENT TYPE (the title is the NWS event name) — the most
 * reliable urgency signal, because the alert feed's `severity` field is
 * unreliable (we've seen "Unknown"). Only `CRITICAL_WARNINGS` + an "Emergency"
 * (Tornado/Flash-Flood Emergency) + a destructive-tagged severe thunderstorm
 * get the loud tone; every other "* Warning" defaults to the friendly `notice`
 * (so a new/rare NWS warning type is never WRONGLY alarming). This is the
 * "friendlier tone where possible, critical only for true urgency" rule.
 */
export function classify_alert(title: string, description?: string | null): AlertTone | null {
  const t = (title ?? '').toLowerCase();
  const both = `${t} ${(description ?? '').toLowerCase()}`;
  const is_emergency = t.includes('emergency') && (t.includes('tornado') || t.includes('flash flood'));
  const is_warning = /\bwarning\b/.test(t);
  if (!is_warning && !is_emergency) return null; // watch / advisory / statement / outlook
  if (is_emergency) return 'critical';
  if (CRITICAL_WARNINGS.some((e) => t.includes(e))) return 'critical';
  // A severe thunderstorm warning is usually 'notice', but a destructive- or
  // tornado-tagged one (NWS "damage threat: DESTRUCTIVE") is take-cover-now.
  if (t.includes('severe thunderstorm warning') && /destructive|tornado|particularly dangerous/.test(both)) {
    return 'critical';
  }
  return 'notice'; // the rest of the warning taxonomy → friendlier chime
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'alert';
}

function first_sentence(s: string): string {
  const trimmed = s.replace(/\s+/g, ' ').trim();
  const m = trimmed.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : trimmed).trim().slice(0, 200);
}
