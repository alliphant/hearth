/**
 * HealthIncidentStore — the durable incident ledger behind system_health
 * (2026-06-20).
 *
 * One OPEN row per degraded/down dependency (recovered_at IS NULL); closed
 * rows are history. This is what makes the health monitor honest + non-spammy:
 *
 *   - open_or_update() reports `is_new_edge` only when an incident FRESHLY
 *     opens (or a degraded one worsens to down), so the scan escalates ONCE on
 *     the edge, not every tick.
 *   - first_seen gives a truthful "down for N days" (the 8-day Firecrawl case).
 *   - restart_attempts + last_restart_at back Beatrice's restart circuit-
 *     breaker (don't restart-loop; escalate to the owner instead).
 *   - observations counts how many consecutive scans have seen this incident
 *     down. It's the input to the scan's ALERT hysteresis: the ledger opens +
 *     the auto-restart fires immediately, but the OWNER push / Beatrice flag /
 *     process-miss wait until the incident has survived N scans (alerted_at
 *     stamps the one time we escalated). A blip that self-heals within the
 *     confirmation window stays silent — the fix for "firecrawl pages me every
 *     night even though it recovers within the hour" (2026-06-28).
 */
import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';

export type IncidentStatus = 'degraded' | 'down';

export interface HealthIncident {
  id: string;
  dependency: string;
  status: IncidentStatus;
  reason: string | null;
  evidence: unknown;
  first_seen: string;
  last_checked: string;
  recovered_at: string | null;
  restart_attempts: number;
  last_restart_at: string | null;
  /** Consecutive scans that have seen this incident down (1 on fresh open). */
  observations: number;
  /** Set the one time the scan escalated this incident to the owner. Null while
   *  the incident is still below the alert-confirmation threshold (silent). */
  alerted_at: string | null;
}

interface RawRow {
  id: string;
  dependency: string;
  status: string;
  reason: string | null;
  evidence_json: string | null;
  first_seen: string;
  last_checked: string;
  recovered_at: string | null;
  restart_attempts: number;
  last_restart_at: string | null;
  observations: number;
  alerted_at: string | null;
}

function to_incident(raw: RawRow): HealthIncident {
  let evidence: unknown = null;
  if (raw.evidence_json) {
    try {
      evidence = JSON.parse(raw.evidence_json);
    } catch {
      evidence = null;
    }
  }
  return {
    id: raw.id,
    dependency: raw.dependency,
    status: raw.status === 'degraded' ? 'degraded' : 'down',
    reason: raw.reason,
    evidence,
    first_seen: raw.first_seen,
    last_checked: raw.last_checked,
    recovered_at: raw.recovered_at,
    restart_attempts: raw.restart_attempts,
    last_restart_at: raw.last_restart_at,
    observations: raw.observations ?? 1,
    alerted_at: raw.alerted_at ?? null,
  };
}

const STATUS_RANK = { degraded: 1, down: 2 } as const;

export interface OpenResult {
  incident: HealthIncident;
  /** True the first time this dependency opens an incident, OR when it worsens
   *  degraded → down. The escalation hook fires only on this. */
  is_new_edge: boolean;
}

export class HealthIncidentStore {
  constructor(private db: Database) {}

  get_open(dependency: string): HealthIncident | null {
    const raw = this.db
      .prepare(
        `SELECT * FROM health_incidents
          WHERE dependency = @dep AND recovered_at IS NULL
          ORDER BY first_seen DESC LIMIT 1`,
      )
      .get({ '@dep': dependency }) as RawRow | undefined;
    return raw ? to_incident(raw) : null;
  }

  list_open(): HealthIncident[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM health_incidents WHERE recovered_at IS NULL
          ORDER BY first_seen ASC`,
      )
      .all() as RawRow[];
    return rows.map(to_incident);
  }

  /**
   * Record the current degraded/down state for a dependency. Opens a fresh
   * incident if none is open; otherwise bumps last_checked + observations (and
   * escalates the status if it worsened). `is_new_edge` is true only on a fresh
   * open or a degraded→down worsening. `observations` on the returned incident
   * is the consecutive-down-scan count the scan's alert hysteresis reads.
   */
  open_or_update(
    dependency: string,
    status: IncidentStatus,
    reason: string,
    evidence: unknown,
    now: Date = new Date(),
  ): OpenResult {
    const iso = now.toISOString();
    const existing = this.get_open(dependency);
    if (!existing) {
      const id = `hi_${ulid().toLowerCase().slice(-12)}`;
      this.db
        .prepare(
          `INSERT INTO health_incidents
             (id, dependency, status, reason, evidence_json, first_seen,
              last_checked, restart_attempts, observations)
           VALUES (@id, @dep, @status, @reason, @ev, @now, @now, 0, 1)`,
        )
        .run({
          '@id': id,
          '@dep': dependency,
          '@status': status,
          '@reason': reason,
          '@ev': JSON.stringify(evidence ?? null),
          '@now': iso,
        });
      return { incident: this.get_open(dependency)!, is_new_edge: true };
    }
    const worsened = STATUS_RANK[status] > STATUS_RANK[existing.status];
    this.db
      .prepare(
        `UPDATE health_incidents
            SET status = @status, reason = @reason, evidence_json = @ev,
                last_checked = @now, observations = observations + 1
          WHERE id = @id`,
      )
      .run({
        '@status': status,
        '@reason': reason,
        '@ev': JSON.stringify(evidence ?? null),
        '@now': iso,
        '@id': existing.id,
      });
    return { incident: this.get_open(dependency)!, is_new_edge: worsened };
  }

  /** Stamp the one time the scan escalated this incident to the owner, so a
   *  still-down incident on later scans doesn't re-page. No-op if nothing is
   *  open. */
  mark_alerted(dependency: string, now: Date = new Date()): void {
    const existing = this.get_open(dependency);
    if (!existing) return;
    this.db
      .prepare(`UPDATE health_incidents SET alerted_at = @now WHERE id = @id AND alerted_at IS NULL`)
      .run({ '@now': now.toISOString(), '@id': existing.id });
  }

  /** Stamp recovery on the open incident. Returns the closed incident + how
   *  long it was down (ms), or null if nothing was open. */
  close(dependency: string, now: Date = new Date()): { incident: HealthIncident; down_ms: number } | null {
    const existing = this.get_open(dependency);
    if (!existing) return null;
    const iso = now.toISOString();
    this.db
      .prepare(`UPDATE health_incidents SET recovered_at = @now, last_checked = @now WHERE id = @id`)
      .run({ '@now': iso, '@id': existing.id });
    const down_ms = now.getTime() - new Date(existing.first_seen).getTime();
    return { incident: { ...existing, recovered_at: iso }, down_ms };
  }

  /** recovered_at of the most-recently-RECOVERED incident for this dependency
   *  (null if it has never recovered). The scan reads this to suppress
   *  re-opening a freshly-recovered dep on a stale error-rate window — the long
   *  window still holds pre-recovery failures, but the dep is serving fine. */
  last_recovered_at(dependency: string): string | null {
    const raw = this.db
      .prepare(
        `SELECT recovered_at FROM health_incidents
          WHERE dependency = @dep AND recovered_at IS NOT NULL
          ORDER BY recovered_at DESC LIMIT 1`,
      )
      .get({ '@dep': dependency }) as { recovered_at: string } | undefined;
    return raw?.recovered_at ?? null;
  }

  /** Bump the restart counter on the open incident (circuit-breaker input). */
  record_restart(dependency: string, now: Date = new Date()): void {
    const existing = this.get_open(dependency);
    if (!existing) return;
    this.db
      .prepare(
        `UPDATE health_incidents
            SET restart_attempts = restart_attempts + 1, last_restart_at = @now
          WHERE id = @id`,
      )
      .run({ '@now': now.toISOString(), '@id': existing.id });
  }
}

/** "down for 8 days" from an open incident's first_seen. */
export function down_duration_human(first_seen: string, now: Date = new Date()): string {
  const ms = Math.max(0, now.getTime() - new Date(first_seen).getTime());
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
