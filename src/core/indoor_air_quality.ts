/**
 * IndoorAirQualityDriver — proactive safety alerts for dangerous INDOOR air
 * (2026-06-25). The indoor sibling of DangerousWeatherDriver: a 60s ticker that
 * edge-detects a dangerous indoor-air condition from the household's AirThings
 * monitors (CO₂, radon, VOC, PM2.5) + the UniFi cameras' CO/smoke-alarm
 * detection, and on the false→true edge alerts the household BOTH ways — speaks
 * it over the Satellite1 (if anyone's home + near) AND pushes every home member.
 *
 * It reuses the SHARED cadence engine (src/core/episodic_alert.ts): alert once
 * when a level crosses, stay silent while it's elevated, re-alert only on a
 * strictly-worse band (the relief valve), and end the episode after the level
 * clears for a clear-gap. The model is never in the loop — detection + the
 * Kate-framed text are composed in code (a CO₂ leak alert can't depend on the
 * LLM choosing to call a tool).
 *
 * Tiering (owner calls 2026-06-25):
 *   - CO₂ is ACUTE in this household — a 5 lb kegerator CO₂ cylinder leak in an
 *     enclosed basement displaces oxygen, and CO₂ pools LOW (where the dogs are,
 *     below the wall sensor) — so it chimes early (≥1500 ppm) then fires the EBS
 *     KLAXON (critical, pierces quiet hours) as it climbs into 2500 / 5000 ppm,
 *     re-reminding while elevated (an ongoing emergency should nag).
 *   - A CO / smoke ALARM the cameras hear is the genuinely acute, evacuate-now
 *     event → EBS klaxon, pierces quiet hours.
 *   - Radon / VOC / PM2.5 are chronic → a gentle CHIME (notice), once per
 *     episode, that does NOT pierce quiet hours (a 3am radon ping you can't act
 *     on is alarm fatigue).
 *
 * Mirrors the weather driver's contracts: DARK by default (`attach()` is a no-op
 * unless HEARTH_AIR_QUALITY_ALERTS=1), fail-open per tick, deterministic.
 */
import type { MemoryClient } from '@memory/client';
import type { UserRegistry } from '@core/users';
import type { ToolContext } from '@core/tool';
import type { Severity } from '@policy/quiet_hours';
import { is_within_quiet_hours } from '@policy/quiet_hours';
import { push_text_to_user } from '@policy/push';
import { try_speak_followup } from '@core/voice_announce';
import { fetch_ha_all_states } from '@connectors/home_assistant';
import { maybe_flash_emergency_lights } from '@core/emergency_lights';
import { airthings_conditions } from '@connectors/airthings';
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

export function indoor_air_quality_enabled(): boolean {
  return process.env.HEARTH_AIR_QUALITY_ALERTS === '1';
}

const MIN = 60_000;

/** The worst-room reading for one pollutant (the connector's `signals.worst`). */
export interface WorstHit {
  room: string;
  value: number;
  unit: string | null;
}

/** A snapshot of indoor air quality this tick — worst room per pollutant. */
export interface AirQualitySnapshot {
  co2: WorstHit | null;
  radon: WorstHit | null;
  voc: WorstHit | null;
  pm25: WorstHit | null;
}

/** A CO / smoke alarm the cameras report as actively sounding. */
export interface AlarmHit {
  kind: 'co' | 'smoke';
  location: string;
}

export interface AirQualitySources {
  /** Worst-room digest, or null when air quality couldn't be read. */
  read_air_quality(): Promise<AirQualitySnapshot | null>;
  /** Currently-sounding CO / smoke alarms (camera-detected). */
  read_alarms(): Promise<AlarmHit[]>;
}

export interface AirDelivery {
  /** Phone push to one user — the driver passes the tier-mapped severity so the
   *  quiet-hours gate pierces for critical and holds notice overnight. */
  push(user_id: string, text: string, severity: Severity): Promise<void>;
  /** Best-effort house announcement over the Satellite1, with an alert tone. */
  speak(text: string, summary: string, tone: AlertTone): Promise<void>;
}

// ── Pollutant alert specs ────────────────────────────────────────────────────

interface PollutantSpec {
  key: keyof AirQualitySnapshot;
  /** Ascending alert thresholds (band 1 = first threshold met). */
  bands: number[];
  /** 1-based band index at/above which the tone is CRITICAL (Infinity = never —
   *  a chronic pollutant that only ever chimes). */
  critical_from: number;
  compose(band: number, hit: WorstHit, escalating: boolean): AlertText;
}

interface AlertText {
  push: string;
  spoken: string;
  summary: string;
}

function fmt(hit: WorstHit): string {
  const u = hit.unit ? ` ${hit.unit}` : '';
  return `${Math.round(hit.value)}${u}`;
}

/** band index for a value against ascending thresholds. 0 = below all. */
export function air_band(value: number, bands_asc: number[]): number {
  let band = 0;
  for (const t of bands_asc) if (value >= t) band++;
  return band;
}

/** Build the pollutant alert specs, reading thresholds from env at call time
 *  (constructed per-driver, so a test can set env before instantiating). */
function build_specs(): PollutantSpec[] {
  return [
  {
    key: 'co2',
    bands: env_num_list('HEARTH_AIR_CO2_BANDS', [1500, 2500, 5000]),
    critical_from: env_num('HEARTH_AIR_CO2_CRITICAL_FROM', 2),
    compose(band, hit, escalating) {
      const where = hit.room;
      const v = fmt(hit);
      if (band >= 3) {
        return {
          push: `🚨 DANGEROUS CO₂ in the ${where} — ${v}. Leave the area now, ventilate, and shut off the kegerator CO₂ cylinder. Watch the pets.`,
          spoken: `This is Kate, with an urgent safety alert. Carbon dioxide in the ${where} is dangerously high — ${v}. Please leave the area now, open it up to ventilate, and shut off the kegerator cylinder. Get the dogs out.`,
          summary: `Dangerous CO₂ — ${where} ${v}`,
        };
      }
      if (band >= 2) {
        return {
          push: `🚨 Possible CO₂ leak — the ${where} is ${escalating ? 'climbing, now ' : 'at '}${v}. Ventilate now, get pets and people out, and check the kegerator CO₂ cylinder.`,
          spoken: `This is Kate, with a safety alert. Carbon dioxide in the ${where} is ${escalating ? 'climbing and now at ' : 'at '}${v} — that can mean a CO₂ leak. Please ventilate the room now, get the pets and anyone in there out, and check the kegerator cylinder.`,
          summary: `Possible CO₂ leak — ${where} ${v}`,
        };
      }
      return {
        push: `🫁 CO₂ is elevated in the ${where} — ${v}. Crack a window or improve ventilation.`,
        spoken: `This is Kate. Carbon dioxide is a bit elevated in the ${where}, at ${v}. It would help to crack a window or improve the ventilation in there.`,
        summary: `CO₂ elevated — ${where} ${v}`,
      };
    },
  },
  {
    key: 'radon',
    // Alerting starts at the EPA ACTION LEVEL (148 Bq/m³ ≈ 4 pCi/L), not the
    // lower WHO reference level of 100 (owner decision, 2026-07-27). Radon is
    // chronic and its remedy is a weeks-to-months mitigation project, so a
    // reading between the two thresholds is something to KNOW, not to be
    // notified about: the basement sits permanently at 110–127, which under the
    // old band 1 = 100 meant a standing always-true alert. Sub-action-level
    // radon still surfaces in the brief and the air-quality office — this only
    // governs what is allowed to reach a phone and the Satellite1 speaker.
    // Band 2 is 2× the action level (~8 pCi/L), where mitigation stops being
    // optional.
    bands: env_num_list('HEARTH_AIR_RADON_BANDS', [148, 296]),
    critical_from: Number.POSITIVE_INFINITY, // chronic — always a gentle chime
    compose(band, hit) {
      const where = hit.room;
      const v = fmt(hit);
      if (band >= 2) {
        return {
          push: `🏠 Radon in the ${where} is WELL above the EPA action level — ${v} (≈8 pCi/L). Worth prioritizing mitigation; keep lower levels ventilated.`,
          spoken: `This is Kate. Radon in the ${where} is well above the EPA action level, at ${v}. It's not an emergency, but this is worth prioritizing mitigation for, and keeping the lower levels ventilated in the meantime.`,
          summary: `Radon well above action level — ${where} ${v}`,
        };
      }
      return {
        push: `🏠 Radon in the ${where} has reached the EPA action level — ${v} (≈4 pCi/L). Worth planning mitigation; keep lower levels ventilated.`,
        spoken: `This is Kate. Radon in the ${where} has reached the EPA action level, at ${v}. It's not an emergency, but it's worth planning mitigation, and keeping the lower levels ventilated in the meantime.`,
        summary: `Radon at action level — ${where} ${v}`,
      };
    },
  },
  {
    key: 'voc',
    bands: env_num_list('HEARTH_AIR_VOC_BANDS', [1000, 2000]),
    critical_from: Number.POSITIVE_INFINITY,
    compose(band, hit) {
      const where = hit.room;
      const v = fmt(hit);
      const high = band >= 2;
      return {
        push: `🧪 VOCs are ${high ? 'high' : 'elevated'} in the ${where} — ${v}. Ventilate${high ? ' well' : ''} and check for a source (cleaners, paint, new furnishings).`,
        spoken: `This is Kate. Airborne chemicals — VOCs — are ${high ? 'high' : 'a bit elevated'} in the ${where}, at ${v}. Opening it up to ventilate would help, and it's worth checking for a source like cleaners, paint, or something new.`,
        summary: `VOCs ${high ? 'high' : 'elevated'} — ${where} ${v}`,
      };
    },
  },
  {
    key: 'pm25',
    bands: env_num_list('HEARTH_AIR_PM25_BANDS', [35, 55]),
    critical_from: Number.POSITIVE_INFINITY,
    compose(band, hit) {
      const where = hit.room;
      const v = fmt(hit);
      const high = band >= 2;
      return {
        push: `💨 Fine-particle pollution (PM2.5) is ${high ? 'high' : 'elevated'} in the ${where} — ${v}. Likely cooking, candles, or smoke; ventilate${high ? ' and run a purifier' : ''}.`,
        spoken: `This is Kate. Fine-particle pollution in the ${where} is ${high ? 'high' : 'elevated'}, at ${v} — usually cooking, candles, or smoke. Some ventilation${high ? ', and an air purifier,' : ''} would clear it.`,
        summary: `PM2.5 ${high ? 'high' : 'elevated'} — ${where} ${v}`,
      };
    },
  },
  ];
}

function alarm_alert(a: AlarmHit): ActiveAlert {
  const at = a.location ? ` (${a.location})` : '';
  if (a.kind === 'co') {
    return {
      key: `alarm:co:${a.location.toLowerCase()}`,
      band: 1,
      tone: 'critical',
      push_text: `🚨 A carbon-monoxide alarm is sounding${at}. Get everyone OUTSIDE to fresh air now and call 911. Do not re-enter.`,
      spoken_text: `This is Kate, with an emergency alert. A carbon-monoxide alarm is going off${at}. Please get everyone outside to fresh air right now, and call 911. Do not go back inside.`,
      summary: `CO alarm sounding${at}`,
    };
  }
  return {
    key: `alarm:smoke:${a.location.toLowerCase()}`,
    band: 1,
    tone: 'critical',
    push_text: `🚨 A smoke alarm is sounding${at}. If there's fire or smoke, get everyone OUT now and call 911.`,
    spoken_text: `This is Kate, with an emergency alert. A smoke alarm is going off${at}. If there is fire or smoke, please get everyone out now and call 911.`,
    summary: `Smoke alarm sounding${at}`,
  };
}

// ── Driver ───────────────────────────────────────────────────────────────────

export class IndoorAirQualityDriver {
  private readonly memory: MemoryClient;
  private readonly users: UserRegistry | undefined;
  private readonly sources: AirQualitySources;
  private readonly delivery: AirDelivery;
  private readonly home_user_ids: () => string[];
  private readonly quiet_now: () => boolean;
  private readonly now: () => number;

  private readonly tick_ms: number;
  private readonly clear_gap_ms: number;
  private readonly critical_min_interval_ms: number;
  private readonly critical_remind: boolean;

  private readonly engine: EpisodicAlertEngine;
  private readonly specs: PollutantSpec[];
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
    sources?: AirQualitySources;
    delivery?: AirDelivery;
    home_user_ids?: () => string[];
    quiet_now?: () => boolean;
    now?: () => number;
  }) {
    this.memory = deps.memory;
    this.users = deps.users;
    this.now = deps.now ?? (() => Date.now());
    this.tick_ms = env_num('HEARTH_AIR_POLL_MS', MIN);
    // Air quality is SLOW — a longer clear-gap (60 min) so a level hovering near
    // a threshold doesn't flap episodes. Critical (CO₂ leak / alarm) re-reminds.
    this.clear_gap_ms = env_num('HEARTH_AIR_CLEAR_GAP_MS', 60 * MIN);
    this.critical_min_interval_ms = env_num('HEARTH_AIR_CRITICAL_MIN_INTERVAL_MS', 10 * MIN);
    this.critical_remind = (process.env.HEARTH_AIR_CRITICAL_REMIND ?? '1') !== '0';
    this.engine = new EpisodicAlertEngine({
      store: sqlite_episode_store(deps.db),
      scope: 'air',
      clear_gap_ms: this.clear_gap_ms,
      critical_min_interval_ms: this.critical_min_interval_ms,
      critical_remind: this.critical_remind,
    });
    this.specs = build_specs();

    this.sources = deps.sources ?? this.default_sources();
    this.delivery = deps.delivery ?? this.default_delivery(deps.coordinator_url, deps.bearer);
    this.home_user_ids = deps.home_user_ids ?? (() => default_home_user_ids(this.users));
    this.quiet_now = deps.quiet_now ?? (() => this.owner_in_quiet_hours());
  }

  attach(): () => void {
    if (!indoor_air_quality_enabled()) {
      console.log('[air] IndoorAirQualityDriver disabled (HEARTH_AIR_QUALITY_ALERTS≠1)');
      return () => {};
    }
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.tick_ms);
    const co2 = this.specs.find((s) => s.key === 'co2');
    console.log(
      `[air] IndoorAirQualityDriver attached (tick ${Math.round(this.tick_ms / 1000)}s, ` +
        `CO₂ bands [${co2?.bands.join(',')}]ppm (klaxon from band ${co2?.critical_from}), ` +
        `radon/voc/pm2.5 = gentle chime, CO/smoke-alarm = klaxon, ` +
        `clear-gap ${Math.round(this.clear_gap_ms / MIN)}min, ` +
        `critical-reminder ${this.critical_remind ? `≤1/${Math.round(this.critical_min_interval_ms / MIN)}min` : 'off'})`,
    );
    return () => this.stop();
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
      console.error('[air] tick failed (skipped):', err);
    } finally {
      this.running = false;
    }
  }

  /** Compose the active indoor-air dangers, fail-open per source. */
  private async detect(): Promise<ActiveAlert[]> {
    const out: ActiveAlert[] = [];

    let snap: AirQualitySnapshot | null = null;
    try {
      snap = await this.sources.read_air_quality();
    } catch (err) {
      console.error('[air] air-quality read failed (skipped):', err);
    }
    if (snap) {
      for (const spec of this.specs) {
        const hit = snap[spec.key];
        if (!hit) continue;
        const band = air_band(hit.value, spec.bands);
        if (band < 1) continue;
        const tone: AlertTone = band >= spec.critical_from ? 'critical' : 'notice';
        const base = spec.compose(band, hit, false);
        const esc = spec.compose(band, hit, true);
        out.push({
          key: `air:${spec.key}`,
          band,
          tone,
          value: hit.value,
          push_text: base.push,
          spoken_text: base.spoken,
          summary: base.summary,
          escalation_push: esc.push,
          escalation_spoken: esc.spoken,
          escalation_summary: esc.summary,
        });
      }
    }

    let alarms: AlarmHit[] = [];
    try {
      alarms = await this.sources.read_alarms();
    } catch (err) {
      console.error('[air] alarm read failed (skipped):', err);
    }
    for (const a of alarms) out.push(alarm_alert(a));

    return out;
  }

  private async deliver(a: ActiveAlert, reason: DeliveryReason): Promise<void> {
    const escalating = reason === 'escalation';
    const push_text = (escalating && a.escalation_push) || a.push_text;
    const spoken_text = (escalating && a.escalation_spoken) || a.spoken_text;
    const summary = (escalating && a.escalation_summary) || a.summary;

    // Tier → severity. Critical pierces quiet hours ('high'); a gentle chime
    // uses 'medium', which the quiet-hours gate HOLDS overnight and delivers in
    // waking hours (the "only the firmest tier wakes you" rule).
    const severity: Severity = a.tone === 'critical' ? 'high' : 'medium';

    const recipients = this.home_user_ids();
    let pushed = 0;
    for (const uid of recipients) {
      try {
        await this.delivery.push(uid, push_text, severity);
        pushed++;
      } catch (err) {
        console.error(`[air] push failed for ${uid}:`, err);
      }
    }

    // The house announcement: critical always speaks; a gentle chime stays quiet
    // during quiet hours (a 3am chronic-air chime is intrusive + not actionable).
    let spoke = false;
    if (a.tone === 'critical' || !this.quiet_now()) {
      try {
        await this.delivery.speak(spoken_text, summary, a.tone);
        spoke = true;
      } catch (err) {
        console.error('[air] speak failed:', err);
      }
    }

    // Third alert channel: flash the house lights RED on a CRITICAL event (a
    // CO₂-leak klaxon or a CO/smoke alarm). Fire-and-forget + fail-open + gated.
    if (a.tone === 'critical') maybe_flash_emergency_lights({ memory: this.memory });

    this.audit(a, reason, pushed, spoke);
    console.log(
      `[air] ALERT ${a.key} (${reason}, band ${a.band}, ${a.tone}) → pushed ${pushed}/${recipients.length}, spoke=${spoke}`,
    );
  }

  private audit(a: ActiveAlert, reason: DeliveryReason, pushed: number, spoke: boolean): void {
    try {
      this.memory.log_action?.({
        intent_id: `air:${a.key}`,
        agent: 'indoor_air_quality',
        tool_name: 'indoor_air_quality_alert',
        tool_input: { key: a.key, value: a.value ?? null, band: a.band, tone: a.tone, reason, summary: a.summary },
        execution_result: { pushed, spoke },
      });
    } catch {
      /* audit is best-effort */
    }
  }

  // ── Default real sources / delivery ──────────────────────────────────────

  private default_sources(): AirQualitySources {
    const memory = this.memory;
    return {
      read_air_quality: async (): Promise<AirQualitySnapshot | null> => {
        const ctx = { memory, now: new Date(), intent_id: 'indoor-air-quality' } as unknown as ToolContext;
        const out = await airthings_conditions.execute({}, ctx);
        if (!out.ok || !out.signals) return null;
        const w = out.signals.worst;
        return { co2: w.co2, radon: w.radon, voc: w.voc, pm25: w.pm25 };
      },
      read_alarms: async (): Promise<AlarmHit[]> => {
        const fetched = await fetch_ha_all_states();
        if (!fetched.ok) return [];
        const out: AlarmHit[] = [];
        for (const e of fetched.states) {
          const m = e.entity_id.match(/^binary_sensor\.(.+)_(co|smoke)_alarm_detected$/);
          if (!m) continue;
          if ((e.state ?? '').toLowerCase() !== 'on') continue; // only a SOUNDING alarm
          const kind: 'co' | 'smoke' = m[2] === 'co' ? 'co' : 'smoke';
          const fn = typeof e.attributes?.friendly_name === 'string' ? e.attributes.friendly_name : '';
          out.push({ kind, location: alarm_location(fn, m[1] ?? '') });
        }
        return out;
      },
    };
  }

  private default_delivery(coordinator_url?: string, bearer?: string): AirDelivery {
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
          conversation_id: 'indoor-air-quality',
          summary,
          pre_tone: tone,
          coordinator_url: coordinator_url ?? process.env.HEARTH_VOICE_COORDINATOR_URL,
          bearer: bearer ?? process.env.HEARTH_INTERNAL_BEARER,
          // We push every home member separately; suppress the speak path's own
          // push-fallback so we don't double-notify.
          push: async () => true,
        });
      },
    };
  }

  /** Default quiet-hours predicate — the owner's configured quiet window. */
  private owner_in_quiet_hours(): boolean {
    try {
      const owner_id = process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
      const cfg = this.users?.get_notification_config(owner_id);
      if (!cfg) return false;
      return is_within_quiet_hours(new Date(), cfg);
    } catch {
      return false; // fail-open: never suppress a speak on a config error
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Derive a human location from a CO/smoke binary_sensor's friendly_name
 *  ("Garage CO alarm detected" → "Garage"), falling back to the entity stem. */
export function alarm_location(friendly_name: string, entity_stem: string): string {
  const cleaned = friendly_name
    .replace(/\b(carbon[\s-]?monoxide|co|smoke)\b/gi, '')
    .replace(/\balarm\b/gi, '')
    .replace(/\bdetect(ed|ion)?\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned) return cleaned;
  return entity_stem.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim() || 'the house';
}
