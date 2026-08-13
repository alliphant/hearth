/**
 * kate_observations — the observation LEDGER behind Kate's walk-the-house
 * reflection pass (C2 of [docs/design-kate-self-direction.md](../../../docs/design-kate-self-direction.md)).
 *
 * This is the organ that turns one-shot scans into ONGOING ATTENTION: each
 * reflection observation is keyed on a content-stable `anchor` so tomorrow's
 * pass recognizes the same thing (recurrence trail, not row explosion), open
 * `watch` items re-enter the next pass's input until resolved/dismissed/
 * expired, and a dismissed anchor STAYS dismissed (the person_observations /
 * process-miss idiom — the owner's "stop watching this" is durable).
 *
 * Status semantics:
 *   open      — live; re-enters the next reflection pass + the brief's watching section
 *   resolved  — recorded but not watched (an `ignore` disposition lands here;
 *               dedup survives so she doesn't re-notice it fresh every night).
 *               A NON-ignore re-observation REOPENS it (the miss-ledger rule).
 *   dismissed — the owner said stop; re-observation is SUPPRESSED, never reopens
 *   expired   — went stale (no re-observation inside the freshness window)
 *
 * `intended_disposition` is what the model chose; `applied_disposition` is what
 * the system actually did (during the watch-only soak, act/investigate/ask are
 * DOWNGRADED to watch and this pair is the soak's evidence of what she WOULD
 * have done — the trust-teeth scored-week discipline applied to initiative).
 *
 * Owns its table (CREATE IF NOT EXISTS in the constructor — the
 * person_observations pattern; no structured.ts edit, no SCHEMA_VERSION bump).
 */
import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';

export type ObservationDisposition = 'ignore' | 'watch' | 'investigate' | 'act' | 'ask';
export type ObservationStatus = 'open' | 'resolved' | 'dismissed' | 'expired';

export interface KateObservationRow {
  id: string;
  anchor: string;
  summary: string;
  rationale: string;
  evidence_refs: string[];
  intended_disposition: ObservationDisposition;
  applied_disposition: string;
  recheck_when: string | null;
  status: ObservationStatus;
  private_to: string | null;
  times_seen: number;
  ts_created: string;
  ts_last_seen: string;
}

export interface ObservationUpsert {
  anchor: string;
  summary: string;
  rationale: string;
  evidence_refs: string[];
  intended_disposition: ObservationDisposition;
  applied_disposition: string;
  recheck_when?: string | null;
  private_to?: string | null;
  now?: Date;
}

interface RawRow {
  id: string;
  anchor: string;
  summary: string;
  rationale: string;
  evidence_refs_json: string;
  intended_disposition: string;
  applied_disposition: string;
  recheck_when: string | null;
  status: string;
  private_to: string | null;
  times_seen: number;
  ts_created: string;
  ts_last_seen: string;
}

function hydrate(r: RawRow): KateObservationRow {
  let refs: string[] = [];
  try {
    const parsed = JSON.parse(r.evidence_refs_json) as unknown;
    if (Array.isArray(parsed)) refs = parsed.map((x) => String(x));
  } catch {
    /* tolerate legacy/garbled refs */
  }
  return {
    id: r.id,
    anchor: r.anchor,
    summary: r.summary,
    rationale: r.rationale,
    evidence_refs: refs,
    intended_disposition: r.intended_disposition as ObservationDisposition,
    applied_disposition: r.applied_disposition,
    recheck_when: r.recheck_when,
    status: r.status as ObservationStatus,
    private_to: r.private_to,
    times_seen: r.times_seen,
    ts_created: r.ts_created,
    ts_last_seen: r.ts_last_seen,
  };
}

export class KateObservations {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kate_observations (
        id TEXT PRIMARY KEY,
        anchor TEXT NOT NULL UNIQUE,
        summary TEXT NOT NULL,
        rationale TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        intended_disposition TEXT NOT NULL,
        applied_disposition TEXT NOT NULL,
        recheck_when TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        private_to TEXT,
        times_seen INTEGER NOT NULL DEFAULT 1,
        ts_created TEXT NOT NULL,
        ts_last_seen TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kate_obs_status ON kate_observations (status, ts_last_seen);
    `);
  }

  /** Normalize an LLM-authored anchor into a stable key (lowercase, word chars
   *  + colons — the content_anchor idiom). Never empty: garbled input hashes
   *  to its own text so dedup still holds run-over-run. */
  static normalize_anchor(raw: string): string {
    const a = (raw ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9:]+/g, ' ')
      .trim()
      .replace(/\s+/g, '-');
    return a.length > 0 ? a.slice(0, 120) : 'unanchored';
  }

  /**
   * Record one observation. Dedup on anchor:
   *  - no row → insert (is_new)
   *  - dismissed → SUPPRESSED, nothing written (dismissed-stays-dismissed)
   *  - open/resolved/expired → refresh summary/rationale/refs, bump
   *    times_seen + ts_last_seen; status reopens to 'open' UNLESS the fresh
   *    disposition is `ignore` (an ignore re-observation keeps resolved rows
   *    resolved — she noted it again, it still doesn't warrant attention).
   */
  upsert(o: ObservationUpsert): { id: string; is_new: boolean; suppressed: boolean } {
    const now = (o.now ?? new Date()).toISOString();
    const anchor = KateObservations.normalize_anchor(o.anchor);
    const existing = this.db
      .prepare(`SELECT * FROM kate_observations WHERE anchor = @anchor`)
      .get({ '@anchor': anchor }) as RawRow | null;

    if (existing != null) {
      if (existing.status === 'dismissed') {
        return { id: existing.id, is_new: false, suppressed: true };
      }
      // `ignore` is a TERMINAL judgment, not a status-preserving no-op: she
      // looked at the thing and decided it does not warrant attention. It
      // resolves the row whatever the row was before. The old rule preserved
      // an existing 'open' — so a concern first seen as `watch` and ignored
      // every night after stayed open forever, and the pass spent its whole
      // budget re-deriving conclusions it had already reached (nine rows at
      // times_seen 10–16 by 2026-08). Re-raising it later is still free: the
      // next non-ignore observation on the anchor reopens it.
      const next_status = o.intended_disposition === 'ignore' ? 'resolved' : 'open';
      this.db
        .prepare(
          `UPDATE kate_observations SET summary=@summary, rationale=@rationale,
             evidence_refs_json=@refs, intended_disposition=@intended,
             applied_disposition=@applied, recheck_when=@recheck, status=@status,
             times_seen=times_seen+1, ts_last_seen=@now WHERE id=@id`,
        )
        .run({
          '@summary': o.summary,
          '@rationale': o.rationale,
          '@refs': JSON.stringify(o.evidence_refs.slice(0, 8)),
          '@intended': o.intended_disposition,
          '@applied': o.applied_disposition,
          '@recheck': o.recheck_when ?? null,
          '@status': next_status,
          '@now': now,
          '@id': existing.id,
        });
      return { id: existing.id, is_new: false, suppressed: false };
    }

    const id = `ko_${ulid().toLowerCase()}`;
    this.db
      .prepare(
        `INSERT INTO kate_observations
           (id, anchor, summary, rationale, evidence_refs_json, intended_disposition,
            applied_disposition, recheck_when, status, private_to, times_seen, ts_created, ts_last_seen)
         VALUES (@id, @anchor, @summary, @rationale, @refs, @intended, @applied,
                 @recheck, @status, @private_to, 1, @now, @now)`,
      )
      .run({
        '@id': id,
        '@anchor': anchor,
        '@summary': o.summary,
        '@rationale': o.rationale,
        '@refs': JSON.stringify(o.evidence_refs.slice(0, 8)),
        '@intended': o.intended_disposition,
        '@applied': o.applied_disposition,
        '@recheck': o.recheck_when ?? null,
        '@status': o.intended_disposition === 'ignore' ? 'resolved' : 'open',
        '@private_to': o.private_to ?? null,
        '@now': now,
      });
    return { id, is_new: true, suppressed: false };
  }

  /** Open items, most-recently-seen first — the next pass's input + the brief's
   *  watching feed. `for_user` filters by cordon (null private_to = visible). */
  open_watches(limit = 12, for_user?: string): KateObservationRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM kate_observations WHERE status='open' ORDER BY ts_last_seen DESC LIMIT @lim`)
      .all({ '@lim': limit * 2 }) as RawRow[];
    return rows
      .map(hydrate)
      .filter((r) => !for_user || !r.private_to || r.private_to === for_user)
      .slice(0, limit);
  }

  /**
   * Every anchor she has JUDGED recently, whatever the verdict — the dedup
   * pool. `open_watches` alone is not enough for that job: a resolved/ignored
   * anchor is invisible to it, so the next pass re-coins a fresh variant for
   * the same concern and the ledger splinters (one Bluelink cancellation
   * became three rows). Dismissed rows are excluded because `upsert` already
   * suppresses them structurally — surfacing them would only re-teach a
   * suppressed concern.
   *
   * Ordered most-recently-seen first so a caller that caps the pool keeps the
   * anchors most likely to be re-observed tonight.
   */
  recent_anchors(within_days = 30, limit = 60, for_user?: string): KateObservationRow[] {
    const cutoff = new Date(Date.now() - within_days * 86_400_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM kate_observations WHERE status != 'dismissed' AND ts_last_seen >= @cut
           ORDER BY ts_last_seen DESC LIMIT @lim`,
      )
      .all({ '@cut': cutoff, '@lim': limit * 2 }) as RawRow[];
    return rows
      .map(hydrate)
      .filter((r) => !for_user || !r.private_to || r.private_to === for_user)
      .slice(0, limit);
  }

  get_by_anchor(anchor: string): KateObservationRow | null {
    const r = this.db
      .prepare(`SELECT * FROM kate_observations WHERE anchor=@a`)
      .get({ '@a': KateObservations.normalize_anchor(anchor) }) as RawRow | null;
    return r != null ? hydrate(r) : null;
  }

  set_status(id: string, status: ObservationStatus, now?: Date): boolean {
    const res = this.db
      .prepare(`UPDATE kate_observations SET status=@s, ts_last_seen=@now WHERE id=@id`)
      .run({ '@s': status, '@now': (now ?? new Date()).toISOString(), '@id': id });
    return res.changes > 0;
  }

  /** Open items not re-observed within the freshness window go stale → expired.
   *  Returns the number expired. Keeps the watch list honest — an open watch is
   *  something the passes still SEE, not a fossil. */
  expire_stale(max_age_days: number, now?: Date): number {
    const cutoff = new Date((now ?? new Date()).getTime() - max_age_days * 86_400_000).toISOString();
    const res = this.db
      .prepare(`UPDATE kate_observations SET status='expired' WHERE status='open' AND ts_last_seen < @cutoff`)
      .run({ '@cutoff': cutoff });
    return res.changes;
  }

  counts(): { open: number; resolved: number; dismissed: number; expired: number } {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM kate_observations GROUP BY status`)
      .all() as Array<{ status: string; n: number }>;
    const out = { open: 0, resolved: 0, dismissed: 0, expired: 0 };
    for (const r of rows) if (r.status in out) out[r.status as keyof typeof out] = r.n;
    return out;
  }
}
