/**
 * EpisodicAlertEngine — the shared cadence core for deterministic safety
 * alerters (2026-06-25).
 *
 * Extracted from DangerousWeatherDriver so the same once-per-episode + monotonic
 * pressure-relief-valve cadence backs every household danger surface (weather,
 * indoor air quality, …) without duplicating the subtle, safety-critical state
 * machine. The engine owns ONLY the cadence; each driver supplies the detection
 * (what's dangerous now, as `ActiveAlert[]`) and the delivery (push/speak, with
 * its own severity + quiet-hours policy). This keeps the cadence in ONE place.
 *
 * The model (see docs/design-tempest-weather-integration.md "Cadence"):
 *   1. GENTLE = ONCE PER EPISODE. An alert fires once and stays silent while the
 *      danger is ongoing — no clock re-alert for the notice tier. An "episode"
 *      ends only after the danger has been ABSENT for a full clear-gap; the next
 *      occurrence after that is a fresh alert. Tracked from `last_seen_current_ms`
 *      (last time PRESENT, not last ALERTED), so an intermittent signal stays one
 *      episode as long as it reappears within the clear-gap.
 *   2. PRESSURE-RELIEF VALVE = release on genuine INTENSIFICATION. A MONOTONIC
 *      band crossing: the valve releases ONLY when the current band is STRICTLY
 *      higher than the worst band already alerted this episode, then re-seats
 *      `worst_band` higher — so it can only release as the danger strictly
 *      worsens, never on steady-state or oscillation, at most once per band.
 *   3. CRITICAL keeps a periodic reminder. A critical-tone alert re-fires on the
 *      clock while ongoing (repetition is a safety feature for a take-cover /
 *      acute event); the notice tier never does.
 *
 * The engine is PURE w.r.t. delivery: `decide_pass(alerts, now)` mutates only its
 * internal episode state and RETURNS the alerts to deliver (each tagged with the
 * reason). The caller performs the actual push/speak — so the cadence is trivially
 * testable and each driver owns its own delivery policy.
 */
import type { Database } from 'bun:sqlite';
import type { UserRegistry } from '@core/users';

/** Pre-speech alert tone the Satellite1 plays AHEAD of the spoken words:
 *  'critical' = the EAS/EBS attention tone, 'notice' = a soft chime. */
export type AlertTone = 'critical' | 'notice';

/** Why a delivery fired — drives the audit trail + the spoken/push framing. */
export type DeliveryReason = 'fresh' | 'escalation' | 'reminder';

/** One detected danger this pass — the domain driver composes these. */
export interface ActiveAlert {
  /** Stable per-danger identity. Same key across ticks = same episode. */
  key: string;
  /** Escalation band index for this tick's intensity — 0 = alerted-but-not-
   *  escalated, higher = strictly more dangerous. A binary danger uses 0. */
  band: number;
  tone: AlertTone;
  push_text: string;
  spoken_text: string;
  summary: string;
  /** Intensification-flavored variants, used when the relief valve releases
   *  mid-episode. Absent → fall back to the base text. */
  escalation_push?: string;
  escalation_spoken?: string;
  escalation_summary?: string;
  /** Optional numeric carried through to the audit row (distance, ppm, …). */
  value?: number | null;
}

/** An alert the engine decided to deliver this pass, with the reason. */
export interface EpisodicDelivery {
  alert: ActiveAlert;
  reason: DeliveryReason;
}

interface EpisodeState {
  /** When we last DELIVERED for this key — drives the critical clock reminder. */
  last_delivered_ms: number;
  /** When the danger was last PRESENT (current) — refreshed every tick it's
   *  detected. The episode ends only after a full clear-gap of absence. */
  last_seen_current_ms: number;
  /** The worst band alerted so far THIS episode. The relief valve releases only
   *  on a band STRICTLY above this, then raises it (monotonic). */
  worst_band: number;
  /** The tier this key last alerted at (debug/audit; not load-bearing). */
  tone: AlertTone;
}

/**
 * Durable home for the episode ledger. The engine keeps a process-local Map as
 * its working set and WRITES THROUGH to this on every commit, so the
 * once-per-episode contract survives a restart.
 *
 * Why this exists: the ledger used to be a bare in-memory Map. Every
 * orchestrator restart wiped it, so any ongoing danger was re-decided as
 * `fresh` on the very first tick after boot. For an ACUTE danger that's mostly
 * harmless (it's usually over by the next boot); for a CHRONIC one it is a
 * notification storm proportional to your deploy rate. Basement radon sits
 * permanently above its first band, and the backend deploys many times a day —
 * 41 radon pushes, every one of them `fresh`, clustered entirely on
 * deploy-heavy days with nothing in between. (2026-07-27)
 */
export interface EpisodeStore {
  /** All live episodes for `scope`, keyed by alert key. Called once at wire-up. */
  load(scope: string): Map<string, EpisodeState>;
  /** Persist (insert or replace) one episode. */
  upsert(scope: string, key: string, state: EpisodeState): void;
  /** Drop one episode — the danger cleared. */
  remove(scope: string, key: string): void;
}

export interface EpisodicAlertConfig {
  /** How long a danger must be ABSENT before the next occurrence is a fresh
   *  episode. The episode-lifecycle clock. */
  clear_gap_ms: number;
  /** Reminder cadence for a CRITICAL alert that's still ongoing. */
  critical_min_interval_ms: number;
  /** Whether critical alerts re-remind on the clock (notice never does). */
  critical_remind: boolean;
  /**
   * Where the episode ledger lives. REQUIRED — not optional, deliberately. A
   * silently-absent store is precisely the failure this fix removes, so a
   * caller that genuinely wants no persistence has to say so out loud with
   * `in_memory_episode_store()`. Real drivers pass `sqlite_episode_store(db)`.
   */
  store: EpisodeStore;
  /** Namespaces this driver's keys inside the shared store: 'air', 'weather',
   *  'house'. Two drivers may legitimately use the same alert key. */
  scope: string;
}

export class EpisodicAlertEngine {
  private readonly active: Map<string, EpisodeState>;

  constructor(private readonly cfg: EpisodicAlertConfig) {
    // Hydrate the working set from the durable ledger. Staleness needs no
    // special handling: an episode whose danger is no longer present is ended
    // by the normal clear-gap sweep on the first pass (measured from
    // last_seen_current_ms, which froze while the process was down), and one
    // whose danger IS still present correctly stays a single ongoing episode.
    this.active = cfg.store.load(cfg.scope);
  }

  /** Run one cadence pass over the currently-detected alerts. Ends stale
   *  episodes, decides per alert, COMMITS the episode state for anything it
   *  decides to deliver, and returns those (alert, reason) pairs. The caller
   *  does the push/speak. `now` is injected for determinism. */
  decide_pass(alerts: ActiveAlert[], now: number): EpisodicDelivery[] {
    const current_keys = new Set(alerts.map((a) => a.key));
    // 1. End episodes that have been fully ABSENT for the clear-gap. (Measured
    //    from last_seen_current_ms — NOT last_delivered — so an intermittent
    //    danger reappearing within the gap stays one episode.)
    for (const [key, st] of [...this.active.entries()]) {
      if (!current_keys.has(key) && now - st.last_seen_current_ms >= this.cfg.clear_gap_ms) {
        this.active.delete(key);
        this.persist_remove(key);
      }
    }
    // 2. For each current danger: refresh presence, decide, commit + collect.
    const out: EpisodicDelivery[] = [];
    for (const a of alerts) {
      const prev = this.active.get(a.key);
      if (prev) {
        // Ongoing — keep the episode alive. This refresh must be DURABLE too:
        // if it only lived in memory, a restart would resurrect a stale
        // last_seen and could end a still-present episode a gap later.
        prev.last_seen_current_ms = now;
        this.persist_upsert(a.key, prev);
      }
      const reason = this.decide(a, prev, now);
      if (reason) {
        // A release re-seats worst_band to (at least) the band that fired; a
        // fresh alert seeds it at the current band.
        const next: EpisodeState = {
          last_delivered_ms: now,
          last_seen_current_ms: now,
          worst_band: Math.max(prev?.worst_band ?? 0, a.band),
          tone: a.tone,
        };
        this.active.set(a.key, next);
        this.persist_upsert(a.key, next);
        out.push({ alert: a, reason });
      }
    }
    return out;
  }

  /** Write-through helpers. FAIL-OPEN: a ledger write that throws must never
   *  break a safety alerter — worst case we degrade to the old in-memory
   *  behavior for that key, which is noisier but never silent. */
  private persist_upsert(key: string, state: EpisodeState): void {
    try {
      this.cfg.store.upsert(this.cfg.scope, key, state);
    } catch (err) {
      console.error(`[episodic-alert] ledger upsert failed (${this.cfg.scope}/${key}):`, err);
    }
  }

  private persist_remove(key: string): void {
    try {
      this.cfg.store.remove(this.cfg.scope, key);
    } catch (err) {
      console.error(`[episodic-alert] ledger remove failed (${this.cfg.scope}/${key}):`, err);
    }
  }

  /**
   *  - `fresh`      — a new episode (no live state for the key).
   *  - `escalation` — the relief valve: current band STRICTLY worse than the
   *                   worst alerted this episode (genuine intensification).
   *  - `reminder`   — a critical event still ongoing, on its clock.
   *  - `null`       — ongoing steady-state notice → SILENT (once per episode).
   */
  private decide(a: ActiveAlert, prev: EpisodeState | undefined, now: number): DeliveryReason | null {
    if (!prev) return 'fresh';
    if (a.band > prev.worst_band) return 'escalation';
    if (
      a.tone === 'critical' &&
      this.cfg.critical_remind &&
      now - prev.last_delivered_ms >= this.cfg.critical_min_interval_ms
    ) {
      return 'reminder';
    }
    return null;
  }

  /** Live episode count (debug/observability). */
  get episode_count(): number {
    return this.active.size;
  }
}

// ── Episode ledger implementations ──────────────────────────────────────────

/** Create the ledger table if it's absent. The canonical definition lives in
 *  SCHEMA_SQL; this makes the store self-sufficient so it can't be defeated by
 *  schema-vs-migration ORDERING (the boot-crash class this repo has been bitten
 *  by before) and so a smoke can drive the real store against `:memory:`.
 *  Idempotent + cheap — runs once per driver construction. */
export function ensure_alert_episodes_table(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS alert_episodes (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    last_delivered_ms INTEGER NOT NULL,
    last_seen_current_ms INTEGER NOT NULL,
    worst_band INTEGER NOT NULL DEFAULT 0,
    tone TEXT NOT NULL DEFAULT 'notice',
    PRIMARY KEY (scope, key)
  )`);
}

/** SQLite-backed ledger (`alert_episodes`) — what every real driver uses.
 *  Rows exist only for currently-active episodes, so the table stays tiny. */
export function sqlite_episode_store(db: Database): EpisodeStore {
  ensure_alert_episodes_table(db);
  return {
    load(scope) {
      const out = new Map<string, EpisodeState>();
      const rows = db
        .prepare(
          `SELECT key, last_delivered_ms, last_seen_current_ms, worst_band, tone
             FROM alert_episodes WHERE scope = @s`,
        )
        .all({ '@s': scope }) as Array<{
        key: string;
        last_delivered_ms: number;
        last_seen_current_ms: number;
        worst_band: number;
        tone: string;
      }>;
      for (const r of rows) {
        out.set(r.key, {
          last_delivered_ms: r.last_delivered_ms,
          last_seen_current_ms: r.last_seen_current_ms,
          worst_band: r.worst_band,
          // Defensive: anything that isn't the critical literal reads as
          // 'notice', the QUIETER tier — a corrupt row can't invent a klaxon.
          tone: r.tone === 'critical' ? 'critical' : 'notice',
        });
      }
      return out;
    },
    upsert(scope, key, st) {
      db.prepare(
        `INSERT INTO alert_episodes
           (scope, key, last_delivered_ms, last_seen_current_ms, worst_band, tone)
         VALUES (@s, @k, @ld, @ls, @wb, @t)
         ON CONFLICT(scope, key) DO UPDATE SET
           last_delivered_ms = @ld,
           last_seen_current_ms = @ls,
           worst_band = @wb,
           tone = @t`,
      ).run({
        '@s': scope,
        '@k': key,
        '@ld': Math.round(st.last_delivered_ms),
        '@ls': Math.round(st.last_seen_current_ms),
        '@wb': Math.round(st.worst_band),
        '@t': st.tone,
      });
    },
    remove(scope, key) {
      db.prepare(`DELETE FROM alert_episodes WHERE scope = @s AND key = @k`).run({
        '@s': scope,
        '@k': key,
      });
    },
  };
}

/** Non-persistent ledger — the pre-2026-07-27 behavior, kept ONLY for unit
 *  tests that drive the cadence directly. Using this in a live driver
 *  reintroduces restart amnesia: every ongoing danger re-fires as `fresh` on
 *  each boot. Named so that choosing it is deliberate and greppable. */
export function in_memory_episode_store(): EpisodeStore {
  const mem = new Map<string, Map<string, EpisodeState>>();
  const bucket = (scope: string) => {
    let b = mem.get(scope);
    if (!b) mem.set(scope, (b = new Map()));
    return b;
  };
  return {
    load: (scope) => new Map(bucket(scope)),
    upsert: (scope, key, st) => void bucket(scope).set(key, { ...st }),
    remove: (scope, key) => void bucket(scope).delete(key),
  };
}

// ── Shared env helpers ───────────────────────────────────────────────────────

export function env_num(name: string, def: number): number {
  const n = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Parse a comma-separated list of positive numbers from env (e.g. "3" or
 *  "70,90"); falls back to `def` on an absent/garbled value. */
export function env_num_list(name: string, def: number[]): number[] {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const parsed = raw
    .split(',')
    .map((s) => Number.parseFloat(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length ? parsed : def;
}

// ── Shared recipient resolution ──────────────────────────────────────────────

/** A synthetic / test account — identified by the internal `@hearth.local`
 *  email domain (real users carry real provider emails). Excluded from
 *  real-user notifications like danger alerts. Generalizes to ANY internal
 *  test account, so no per-id list to maintain. */
export function is_synthetic_account(u: { email?: string | null }): boolean {
  return (u.email ?? '').toLowerCase().endsWith('@hearth.local');
}

/** The household members a safety alert pushes to: owner + household tier,
 *  friends excluded, never a synthetic/test account. */
export function default_home_user_ids(users: UserRegistry | undefined): string[] {
  return (users?.list() ?? [])
    .filter((u) => u.tier === 'owner' || u.tier === 'household')
    .filter((u) => !is_synthetic_account(u))
    .map((u) => u.id);
}
