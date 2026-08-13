/**
 * HouseAnomalyDriver — "the HVAC is running and losing ground" alerts
 * (house-fusion Phase 3, 2026-07-13).
 *
 * The deterministic push half of house awareness: a 5-min ticker samples the
 * thermostat (hvac_action + current temp) and the outdoor reference, and
 * edge-detects the one condition that deserves a proactive interruption —
 * the equipment has run CONTINUOUSLY for the whole window (default 45 min)
 * while the indoor temperature moved the WRONG WAY by ≥ the threshold
 * (default 1.5°): the furnace failing on a cold night, the AC losing to a
 * heat wave (failed capacitor / dirty filter / a door standing open).
 *
 * Severity is honest about stakes: heating-losing-ground with the outdoors
 * below freezing is a pipe-freeze risk → CRITICAL (pierces quiet hours,
 * re-reminds while ongoing); everything else is a notice-tier chime that
 * quiet hours hold overnight. Composed in code, model never in the loop —
 * the same "safety delivery cannot depend on the LLM choosing a tool" rule
 * as DangerousWeatherDriver (whose EpisodicAlertEngine this reuses:
 * once-per-episode + monotonic band escalation — it re-fires only when the
 * deficit genuinely WORSENS past 2× the threshold, never on oscillation).
 *
 * Mirrors IndoorAirQualityDriver's contracts: DARK by default (`attach()`
 * is a no-op unless HEARTH_HOUSE_ANOMALY=1), fail-open per tick, injectable
 * sources/delivery/clock for the smoke, `stop()` clears the timer.
 *
 * Deliberately NOT detected here: duty-cycle trends, envelope regressions,
 * solar underperformance — those are ANALYSIS, owned by Kate's deliberation
 * passes over house_thermal_history + the nightly house ledger. This driver
 * exists only for the condition where waiting for the next deliberation
 * slot could cost real money or frozen pipes.
 */
import type { MemoryClient } from '@memory/client';
import type { UserRegistry } from '@core/users';
import type { Severity } from '@policy/quiet_hours';
import { is_within_quiet_hours } from '@policy/quiet_hours';
import { push_text_to_user } from '@policy/push';
import { try_speak_followup } from '@core/voice_announce';
import { fetch_ha_all_states } from '@connectors/home_assistant';
import {
  hvac_climate_entity,
  normalize_hvac_action,
  outdoor_temp_entity,
} from '@connectors/house_climate';
import type { Database } from 'bun:sqlite';
import {
  EpisodicAlertEngine,
  sqlite_episode_store,
  type ActiveAlert,
  type AlertTone,
  type DeliveryReason,
  env_num,
  default_home_user_ids,
} from '@core/episodic_alert';

export function house_anomaly_enabled(): boolean {
  return process.env.HEARTH_HOUSE_ANOMALY === '1';
}

const MIN = 60_000;

/** One thermostat sample this tick. */
export interface ClimateSample {
  /** hvac_action: heating | cooling | idle | fan | off | null (unknown). */
  action: string | null;
  /** Thermostat current temperature. */
  current: number | null;
  setpoint: number | null;
  /** Outdoor reference temperature (Tempest). */
  outdoor: number | null;
  /** Garage door state ('open' / 'closed' / null unknown) — the one envelope
   *  opening HA can see (cover.double_bay_isg). */
  garage: string | null;
}

function garage_entity(): string {
  return process.env.HEARTH_HOUSE_GARAGE_ENTITY?.trim() || 'cover.double_bay_isg';
}

export interface HouseAnomalySources {
  read_climate(): Promise<ClimateSample | null>;
}

export interface HouseAnomalyDelivery {
  push(user_id: string, text: string, severity: Severity): Promise<void>;
  speak(text: string, summary: string, tone: AlertTone): Promise<void>;
}

interface BufferedSample {
  t: number;
  action: string | null;
  current: number | null;
  /** Optional so the pure losing-ground tests can omit it. */
  garage?: string | null;
}

const RUNNING = new Set(['heating', 'cooling']);

/**
 * Pure detection over the sample buffer (exported for the smoke): the
 * newest `window_ms` of samples must ALL show the same running action,
 * span ≥90% of the window, and the temperature must have moved against
 * the equipment by ≥ `delta_threshold`.
 */
export function detect_losing_ground(
  buffer: BufferedSample[],
  now: number,
  window_ms: number,
  delta_threshold: number,
): { action: 'heating' | 'cooling'; delta: number; minutes: number } | null {
  const window = buffer.filter((s) => s.t >= now - window_ms && s.t <= now);
  if (window.length < 3) return null;
  const newest = window[window.length - 1];
  const oldest = window[0];
  if (!newest || !oldest) return null;
  if (newest.action === null || !RUNNING.has(newest.action)) return null;
  if (!window.every((s) => s.action === newest.action)) return null;
  // The run must genuinely span the window, not just cluster at one end.
  if (oldest.t > now - window_ms * 0.9) return null;
  if (newest.current === null || oldest.current === null) return null;

  const delta = newest.current - oldest.current;
  const losing = newest.action === 'heating' ? delta <= -delta_threshold : delta >= delta_threshold;
  if (!losing) return null;
  return {
    action: newest.action as 'heating' | 'cooling',
    delta: Number(delta.toFixed(1)),
    minutes: Math.round((newest.t - oldest.t) / MIN),
  };
}

export class HouseAnomalyDriver {
  private readonly memory: MemoryClient;
  private readonly users: UserRegistry | undefined;
  private readonly sources: HouseAnomalySources;
  private readonly delivery: HouseAnomalyDelivery;
  private readonly home_user_ids: () => string[];
  private readonly quiet_now: () => boolean;
  private readonly now: () => number;

  private readonly tick_ms: number;
  private readonly window_ms: number;
  private readonly delta_threshold: number;
  /** Below this outdoor temperature, heating-losing-ground is CRITICAL
   *  (pipe-freeze stakes). */
  private readonly freeze_line: number;
  /** Garage open at least this long while conditioning → notice alert. */
  private readonly garage_min_ms: number;
  private readonly cooling_enabled: boolean;
  private readonly garage_enabled: boolean;

  private readonly engine: EpisodicAlertEngine;
  private buffer: BufferedSample[] = [];
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
    sources?: HouseAnomalySources;
    delivery?: HouseAnomalyDelivery;
    home_user_ids?: () => string[];
    quiet_now?: () => boolean;
    now?: () => number;
  }) {
    this.memory = deps.memory;
    this.users = deps.users;
    this.now = deps.now ?? (() => Date.now());
    this.tick_ms = env_num('HEARTH_HOUSE_ANOMALY_TICK_MS', 5 * MIN);
    this.window_ms = env_num('HEARTH_HOUSE_ANOMALY_WINDOW_MS', 45 * MIN);
    this.delta_threshold = env_num('HEARTH_HOUSE_ANOMALY_DELTA', 1.5);
    this.freeze_line = env_num('HEARTH_HOUSE_ANOMALY_FREEZE_LINE', 32);
    this.garage_min_ms = env_num('HEARTH_HOUSE_ANOMALY_GARAGE_MIN_MS', 15 * MIN);
    // Owner kill-switches per condition (2026-07-28). Cooling-losing-ground
    // fired every heat-wave afternoon — at 99° outside "can't gain ground" is
    // expected physics, not a fault. The garage alert's premise was wrong for
    // this house: cover.double_bay_isg is the EXTERIOR vehicle door of an
    // UNCONDITIONED garage, so an open door doesn't spill conditioned air.
    // Heating-losing-ground (winter pipe-freeze) stays armed by default.
    this.cooling_enabled = (process.env.HEARTH_HOUSE_ANOMALY_COOLING ?? '1') !== '0';
    this.garage_enabled = (process.env.HEARTH_HOUSE_ANOMALY_GARAGE ?? '1') !== '0';
    this.engine = new EpisodicAlertEngine({
      store: sqlite_episode_store(deps.db),
      scope: 'house',
      // A struggling system flaps near the threshold as it barely keeps up —
      // a long clear-gap (90 min) keeps that one episode, not a nag stream.
      clear_gap_ms: env_num('HEARTH_HOUSE_ANOMALY_CLEAR_GAP_MS', 90 * MIN),
      // A CRITICAL (freezing) episode re-reminds — frozen pipes are the one
      // case where repetition is a feature.
      critical_min_interval_ms: env_num('HEARTH_HOUSE_ANOMALY_CRITICAL_MIN_INTERVAL_MS', 30 * MIN),
      critical_remind: (process.env.HEARTH_HOUSE_ANOMALY_CRITICAL_REMIND ?? '1') !== '0',
    });

    this.sources = deps.sources ?? this.default_sources();
    this.delivery = deps.delivery ?? this.default_delivery(deps.coordinator_url, deps.bearer);
    this.home_user_ids = deps.home_user_ids ?? (() => default_home_user_ids(this.users));
    this.quiet_now = deps.quiet_now ?? (() => this.owner_in_quiet_hours());
  }

  attach(): () => void {
    if (!house_anomaly_enabled()) {
      console.log('[house] HouseAnomalyDriver disabled (HEARTH_HOUSE_ANOMALY≠1)');
      return () => {};
    }
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.tick_ms);
    console.log(
      `[house] HouseAnomalyDriver attached (tick ${Math.round(this.tick_ms / MIN)}min, ` +
        `window ${Math.round(this.window_ms / MIN)}min, threshold ${this.delta_threshold}°, ` +
        `freeze line ${this.freeze_line}°, conditions: heating${this.cooling_enabled ? '+cooling' : ''}${
          this.garage_enabled ? '+garage' : ''
        })`,
    );
    return () => this.stop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Fail-open: any throw is logged + swallowed, never aborts. */
  async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const alerts = await this.detect();
      for (const { alert, reason } of this.engine.decide_pass(alerts, this.now())) {
        await this.deliver(alert, reason);
      }
    } catch (err) {
      console.error('[house] tick failed (skipped):', err);
    } finally {
      this.running = false;
    }
  }

  private async detect(): Promise<ActiveAlert[]> {
    let sample: ClimateSample | null = null;
    try {
      sample = await this.sources.read_climate();
    } catch (err) {
      console.error('[house] climate read failed (skipped):', err);
    }
    const now = this.now();
    if (sample) {
      this.buffer.push({
        t: now,
        action: sample.action,
        current: sample.current,
        garage: sample.garage ?? null,
      });
      const horizon = now - this.window_ms * 3;
      this.buffer = this.buffer.filter((s) => s.t >= horizon);
    }

    const alerts: ActiveAlert[] = [];
    if (this.garage_enabled) this.append_garage_alert(alerts, now);

    const hit = detect_losing_ground(this.buffer, now, this.window_ms, this.delta_threshold);
    if (!hit) return alerts;

    const outdoor = sample?.outdoor ?? null;
    const setpoint = sample?.setpoint ?? null;
    const current = sample?.current ?? null;
    const heating = hit.action === 'heating';
    if (!heating && !this.cooling_enabled) return alerts;
    const freezing = heating && outdoor !== null && outdoor <= this.freeze_line;
    const tone: AlertTone = freezing ? 'critical' : 'notice';
    // Band 2 = the deficit has doubled past the threshold → the engine's
    // monotonic escalation releases exactly once as it genuinely worsens.
    const band = Math.abs(hit.delta) >= this.delta_threshold * 2 ? 2 : 1;

    const gear = heating ? 'furnace' : 'AC';
    const dir = heating ? 'falling' : 'rising';
    const at = current !== null ? `${current.toFixed(1)}°` : 'the indoor temperature';
    const vs =
      outdoor !== null ? ` against ${outdoor.toFixed(0)}° outside` : '';
    const goal = setpoint !== null ? ` (set to ${setpoint}°)` : '';
    const causes = heating
      ? 'a failing igniter/blower, a dead zone valve, or a door standing open'
      : 'a dirty filter, iced coils, a failing capacitor, or a door standing open';

    const push_text = freezing
      ? `HEAT NOT KEEPING UP: the furnace has run ${hit.minutes} min straight and the house is still cooling — ${at} and ${dir}${goal}${vs}. Below freezing outside: pipe risk if this continues. Worth checking now (${causes}).`
      : `The ${gear} has run ${hit.minutes} min straight and is losing ground — ${at} and ${dir}${goal}${vs}. Possible ${causes}.`;
    const spoken_text = freezing
      ? `Heads up — the furnace has been running ${hit.minutes} minutes and the house is still getting colder, with freezing temperatures outside. Please check the furnace; there is a pipe-freeze risk if it keeps losing ground.`
      : `Heads up — the ${gear} has been running for ${hit.minutes} minutes but the house is ${heating ? 'still cooling down' : 'still warming up'}. It may not be keeping up.`;
    const summary = `${gear} losing ground: ${hit.delta > 0 ? '+' : ''}${hit.delta}° over ${hit.minutes}min`;

    alerts.push(
      {
        key: `house:${hit.action}_losing_ground`,
        band,
        tone,
        value: hit.delta,
        push_text,
        spoken_text,
        summary,
        escalation_push: `${push_text} The gap is WIDENING (${hit.delta > 0 ? '+' : ''}${hit.delta}° over the last ${hit.minutes} min).`,
        escalation_spoken: `${spoken_text} The gap is widening.`,
        escalation_summary: `${summary} — widening`,
      },
    );
    return alerts;
  }

  /** The one envelope opening HA can see: the garage door open ≥ the
   *  threshold while the HVAC is actively conditioning → a notice chime
   *  ("you're conditioning the driveway"). Band 2 (one escalation) at 2×. */
  private append_garage_alert(alerts: ActiveAlert[], now: number): void {
    const newest = this.buffer[this.buffer.length - 1];
    if (!newest || newest.action === null || !RUNNING.has(newest.action)) return;
    if (newest.garage !== 'open') return;
    let open_since = newest.t;
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const s = this.buffer[i];
      if (!s || s.garage !== 'open') break;
      open_since = s.t;
    }
    const open_ms = now - open_since;
    if (open_ms < this.garage_min_ms) return;
    const minutes = Math.round(open_ms / MIN);
    const gear = newest.action === 'heating' ? 'furnace' : 'AC';
    alerts.push({
      key: 'house:garage_open_conditioning',
      band: open_ms >= this.garage_min_ms * 2 ? 2 : 1,
      tone: 'notice',
      value: minutes,
      push_text: `The garage door has been open ${minutes} min while the ${gear} runs — you're conditioning the driveway. Worth closing it.`,
      spoken_text: `Heads up — the garage door has been open about ${minutes} minutes while the ${gear} is running.`,
      summary: `garage open ${minutes}min while ${newest.action}`,
      escalation_push: `The garage door is STILL open (${minutes} min now) with the ${gear} running.`,
      escalation_spoken: `The garage door is still open with the ${gear} running.`,
      escalation_summary: `garage still open (${minutes}min) while ${newest.action}`,
    });
  }

  private async deliver(a: ActiveAlert, reason: DeliveryReason): Promise<void> {
    const escalating = reason === 'escalation';
    const push_text = (escalating && a.escalation_push) || a.push_text;
    const spoken_text = (escalating && a.escalation_spoken) || a.spoken_text;
    const summary = (escalating && a.escalation_summary) || a.summary;
    const severity: Severity = a.tone === 'critical' ? 'high' : 'medium';

    const recipients = this.home_user_ids();
    let pushed = 0;
    for (const uid of recipients) {
      try {
        await this.delivery.push(uid, push_text, severity);
        pushed++;
      } catch (err) {
        console.error(`[house] push failed for ${uid}:`, err);
      }
    }

    let spoke = false;
    if (a.tone === 'critical' || !this.quiet_now()) {
      try {
        await this.delivery.speak(spoken_text, summary, a.tone);
        spoke = true;
      } catch (err) {
        console.error('[house] speak failed:', err);
      }
    }

    try {
      this.memory.log_action?.({
        intent_id: `house:${a.key}`,
        agent: 'house_anomaly',
        tool_name: 'house_anomaly_alert',
        tool_input: { key: a.key, delta: a.value ?? null, band: a.band, tone: a.tone, reason, summary },
        execution_result: { pushed, spoke },
      });
    } catch {
      /* audit is best-effort */
    }
    console.log(
      `[house] ALERT ${a.key} (${reason}, band ${a.band}, ${a.tone}) → pushed ${pushed}/${recipients.length}, spoke=${spoke}`,
    );
  }

  // ── Default real sources / delivery ──────────────────────────────────────

  private default_sources(): HouseAnomalySources {
    return {
      read_climate: async (): Promise<ClimateSample | null> => {
        const fetched = await fetch_ha_all_states();
        if (!fetched.ok) return null;
        const by_id = new Map(fetched.states.map((e) => [e.entity_id, e]));
        const climate = by_id.get(hvac_climate_entity());
        const outdoor_row = by_id.get(outdoor_temp_entity());
        const attrs = climate?.attributes ?? {};
        const num = (k: string): number | null =>
          typeof attrs[k] === 'number' && Number.isFinite(attrs[k] as number)
            ? (attrs[k] as number)
            : null;
        const outdoor = outdoor_row ? Number.parseFloat(outdoor_row.state) : NaN;
        const garage_row = by_id.get(garage_entity());
        const g = (garage_row?.state ?? '').toLowerCase();
        return {
          action: normalize_hvac_action(
            typeof attrs['hvac_action'] === 'string' ? (attrs['hvac_action'] as string) : null,
            typeof attrs['equipment_running'] === 'string'
              ? (attrs['equipment_running'] as string)
              : null,
          ),
          current: num('current_temperature'),
          setpoint: num('temperature'),
          outdoor: Number.isFinite(outdoor) ? outdoor : null,
          garage: g === 'open' || g === 'opening' ? 'open' : g === 'closed' || g === 'closing' ? 'closed' : null,
        };
      },
    };
  }

  private default_delivery(coordinator_url?: string, bearer?: string): HouseAnomalyDelivery {
    return {
      push: async (user_id: string, text: string, severity: Severity): Promise<void> => {
        await push_text_to_user(user_id, text, {
          kind: 'ad_hoc',
          severity,
          originating_specialist_id: 'kate',
        });
      },
      speak: async (text: string, summary: string, tone: AlertTone): Promise<void> => {
        await try_speak_followup({
          text,
          conversation_id: 'house-anomaly',
          summary,
          pre_tone: tone,
          coordinator_url: coordinator_url ?? process.env.HEARTH_VOICE_COORDINATOR_URL,
          bearer: bearer ?? process.env.HEARTH_INTERNAL_BEARER,
          // Every home member is pushed separately above — suppress the speak
          // path's own push-fallback so we don't double-notify.
          push: async () => true,
        });
      },
    };
  }

  /** Default quiet-hours predicate — the owner's configured quiet window
   *  (mirrors IndoorAirQualityDriver's). */
  private owner_in_quiet_hours(): boolean {
    try {
      const owner_id = process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
      const cfg = this.users?.get_notification_config(owner_id);
      if (!cfg) return false;
      return is_within_quiet_hours(new Date(this.now()), cfg);
    } catch {
      return false; // fail-open: never suppress a speak on a config error
    }
  }
}
