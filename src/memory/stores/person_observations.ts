/**
 * PersonObservations — the afferent observation log for the People reasoning
 * substrate (A+D, 2026-06-22). Append-only, provenance-stamped signals the
 * system NOTICES about a person from the exhaust it already emits (a chat
 * mention, a routed capture, later a visit / calendar event / iMessage), so the
 * Friends layer keeps each person current ON ITS OWN — you stop data-entering.
 *
 * This store is BOTH the raw signal log AND the provenance source of truth for
 * the trust surface (D): every row carries WHAT was noticed, the SOURCE that
 * asserted it (source_type + source_ref), a confidence, WHEN, and the cordon.
 * The nightly synthesis (a later slice) distills these into durable person-note
 * facts; v1 surfaces them directly on the card as "what Hearth has noticed,"
 * each with its provenance + a one-tap dismiss.
 *
 * Self-contained additive table (CREATE IF NOT EXISTS in the ctor; no SCHEMA_SQL
 * edit, no SCHEMA_VERSION bump) — the MailStore / knowledge_edges pattern.
 * Named-sigil binds (the open_db guard). Cordon: every row carries `private_to`,
 * read through `note_visible_to_caller` — the owner has NO god-view of a person
 * siloed to another user.
 */
import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { note_visible_to_caller, type Caller } from '@memory/private_to';

/** Where an observation came from — extensible; iMessage/Discord/presence land here. */
export type ObservationSource =
  | 'chat'
  | 'capture'
  | 'presence'
  | 'calendar'
  | 'mail'
  | 'imessage'
  | 'discord';

export interface PersonObservation {
  id: string;
  person_id: string;
  /** The user whose signal produced this (the observer/cordon principal). */
  user_id: string;
  /** A short verb-class label: 'mention' | 'capture' | 'visit' | … (free text). */
  kind: string;
  /** Human-readable one-liner — what was noticed. */
  summary: string;
  source_type: ObservationSource;
  /** conversation_id / capture_id / event_id that asserted it. */
  source_ref: string | null;
  confidence: number;
  private_to: string;
  observed_at: string;
  dismissed: boolean;
  ts: string;
}

export interface ObservationInput {
  person_id: string;
  user_id: string;
  kind: string;
  summary: string;
  source_type: ObservationSource;
  source_ref?: string | null;
  confidence?: number;
  private_to: string;
  observed_at?: string;
}

interface Row {
  id: string;
  person_id: string;
  user_id: string;
  kind: string;
  summary: string;
  source_type: string;
  source_ref: string | null;
  confidence: number;
  private_to: string;
  observed_at: string;
  dismissed: number;
  ts: string;
}

function hydrate(r: Row): PersonObservation {
  return {
    ...r,
    source_type: r.source_type as ObservationSource,
    dismissed: r.dismissed === 1,
  };
}

export class PersonObservations {
  constructor(private db: Database) {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS person_observations (
         id TEXT PRIMARY KEY,
         person_id TEXT NOT NULL,
         user_id TEXT NOT NULL,
         kind TEXT NOT NULL DEFAULT '',
         summary TEXT NOT NULL DEFAULT '',
         source_type TEXT NOT NULL DEFAULT 'chat',
         source_ref TEXT,
         confidence REAL NOT NULL DEFAULT 1.0,
         private_to TEXT NOT NULL DEFAULT 'household',
         observed_at TEXT NOT NULL,
         dismissed INTEGER NOT NULL DEFAULT 0,
         ts TEXT NOT NULL,
         UNIQUE(person_id, source_type, source_ref, kind)
       )`,
    );
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_pobs_person ON person_observations(person_id, observed_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_pobs_user ON person_observations(user_id, observed_at)`);
  }

  /**
   * Append an observation. Idempotent on (person_id, source_type, source_ref,
   * kind) — the same capture/conversation re-observing the same person updates
   * in place rather than piling duplicates (re-run safe, like the projectors).
   * Returns whether the row was newly inserted.
   *
   * `opts.resurrect` (2026-07-28): a re-observation ALSO clears `dismissed`.
   * Without it a decayed row is a one-way door — record() kept bumping corpses
   * and the appearance profiles stayed dark forever. Reserved for ENGINE-OWNED
   * deterministic kinds (the camera appearance refresh) where fresh recurrence
   * is honest ground truth; conversational kinds keep the old semantics so a
   * model/TTL dismissal stays dismissed.
   */
  record(o: ObservationInput, opts: { resurrect?: boolean } = {}): { id: string; is_new: boolean } {
    const now = new Date().toISOString();
    const observed_at = o.observed_at ?? now;
    const existing = this.db
      .prepare(
        `SELECT id FROM person_observations
           WHERE person_id = @p AND source_type = @st
             AND COALESCE(source_ref,'') = COALESCE(@sr,'') AND kind = @k`,
      )
      .get({ '@p': o.person_id, '@st': o.source_type, '@sr': o.source_ref ?? null, '@k': o.kind }) as
      | { id: string }
      | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE person_observations SET summary = @summary, confidence = @confidence,
             private_to = @private_to, observed_at = @observed_at
             ${opts.resurrect ? ', dismissed = 0' : ''}
             WHERE id = @id`,
        )
        .run({
          '@id': existing.id,
          '@summary': o.summary,
          '@confidence': o.confidence ?? 1.0,
          '@private_to': o.private_to,
          '@observed_at': observed_at,
        });
      return { id: existing.id, is_new: false };
    }
    const id = `po_${ulid().toLowerCase().slice(-16)}`;
    this.db
      .prepare(
        `INSERT INTO person_observations
           (id, person_id, user_id, kind, summary, source_type, source_ref,
            confidence, private_to, observed_at, dismissed, ts)
         VALUES
           (@id, @person_id, @user_id, @kind, @summary, @source_type, @source_ref,
            @confidence, @private_to, @observed_at, 0, @ts)`,
      )
      .run({
        '@id': id,
        '@person_id': o.person_id,
        '@user_id': o.user_id,
        '@kind': o.kind,
        '@summary': o.summary,
        '@source_type': o.source_type,
        '@source_ref': o.source_ref ?? null,
        '@confidence': o.confidence ?? 1.0,
        '@private_to': o.private_to,
        '@observed_at': observed_at,
        '@ts': now,
      });
    return { id, is_new: true };
  }

  // ── synthesis-sweep surface (engine-trusted: NO cordon — the sweep resolves
  //    the cordon itself by grouping a person's rows on user_id) ───────────────

  /** Distinct person_ids that carry at least one non-dismissed observation —
   *  the candidate set the nightly synthesis sweep walks. */
  person_ids_with_active(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT person_id FROM person_observations WHERE dismissed = 0`)
      .all() as Array<{ person_id: string }>;
    return rows.map((r) => r.person_id);
  }

  /** All non-dismissed observations for a person, newest first, UNCORDONED. Only
   *  the synthesis engine calls this — it partitions by user_id and applies the
   *  uploader's cordon to every write it derives. User surfaces use list_for_person. */
  all_active_for_person(person_id: string): PersonObservation[] {
    const rows = this.db
      .prepare(`SELECT * FROM person_observations WHERE person_id = @p AND dismissed = 0 ORDER BY observed_at DESC`)
      .all({ '@p': person_id }) as Row[];
    return rows.map(hydrate);
  }

  /** Recent non-dismissed life_event observations across everyone, newest first,
   *  UNCORDONED (the life-event-offer scan resolves the cordon per row from each
   *  observation's `private_to`). A window keeps a stale milestone from back-filling
   *  a fresh offer; edge-dedup on the proposal then fires each at most once. */
  recent_life_events(since_iso: string): PersonObservation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM person_observations
           WHERE kind = 'life_event' AND dismissed = 0 AND observed_at >= @since
           ORDER BY observed_at DESC`,
      )
      .all({ '@since': since_iso }) as Row[];
    return rows.map(hydrate);
  }

  /** Bulk-dismiss by id (engine-trusted — the sweep already owns the cordon
   *  decision when it selected these rows). Returns rows affected. */
  dismiss_many(ids: string[]): number {
    if (ids.length === 0) return 0;
    const ph = ids.map((_, i) => `@id${i}`).join(',');
    const bind: Record<string, string> = {};
    ids.forEach((id, i) => { bind[`@id${i}`] = id; });
    return this.db.prepare(`UPDATE person_observations SET dismissed = 1 WHERE id IN (${ph}) AND dismissed = 0`).run(bind).changes ?? 0;
  }

  /** Deterministic decay backstop: age-out non-dismissed observations whose last
   *  reconfirmation (`observed_at`) is older than a per-kind TTL, so the "noticed"
   *  surface stays a recent glance even when the LLM under-decays. A recurring
   *  signal keeps its row fresh (record() bumps observed_at on re-observation);
   *  a one-off goes stale and ages out. Returns rows decayed. */
  decay_stale(now: Date, ttl_days_by_kind: Record<string, number>, default_ttl_days?: number): number {
    let total = 0;
    const day_ms = 86_400_000;
    // Each present kind by its own cutoff; everything else by the default (if set).
    const kinds = new Set(
      (this.db.prepare(`SELECT DISTINCT kind FROM person_observations WHERE dismissed = 0`).all() as Array<{ kind: string }>).map((r) => r.kind),
    );
    for (const kind of kinds) {
      const ttl = ttl_days_by_kind[kind] ?? default_ttl_days;
      if (ttl === undefined || !(ttl > 0)) continue; // 0/undefined → that kind never auto-decays
      const cutoff = new Date(now.getTime() - ttl * day_ms).toISOString();
      total += this.db
        .prepare(`UPDATE person_observations SET dismissed = 1 WHERE dismissed = 0 AND kind = @k AND observed_at < @cutoff`)
        .run({ '@k': kind, '@cutoff': cutoff }).changes ?? 0;
    }
    return total;
  }

  /** The HISTORY half of the synthesis corpus: already-decayed (dismissed)
   *  observations for a person, newest first, UNCORDONED + capped.
   *
   *  Why this exists: decay outran accumulation. `decay_stale` + the model's own
   *  decay list retire observations aggressively (a live table read 137 dismissed
   *  vs 16 active), and the sweep only ever saw the ACTIVE ones — so the evidence
   *  was destroyed before the dossier could compound, and each pass re-derived a
   *  portrait from a handful of rows. Dismissed rows stay in the table anyway;
   *  this exposes a bounded tail of them as CONTEXT for refinement. They are
   *  never re-promoted as fresh signal and never re-surface on the card — the
   *  "noticed" list still reads `dismissed = 0` (list_for_person) and so does
   *  every user surface. Engine-only, same contract as `all_active_for_person`.
   *
   *  This is the friend-side analogue of the style loop's rotating 200-bullet
   *  `jasper_style.md` corpus: a body of evidence, not a glance. */
  history_for_person(person_id: string, limit = 200): PersonObservation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM person_observations
           WHERE person_id = @p AND dismissed = 1
           ORDER BY observed_at DESC LIMIT @limit`,
      )
      .all({ '@p': person_id, '@limit': Math.max(0, limit) }) as Row[];
    return rows.map(hydrate);
  }

  /** Hard-delete dismissed observations older than `days` — the retention floor
   *  under the history corpus, so "keep the evidence" stays bounded rather than
   *  becoming the message archive the iMessage privacy boundary forbids. Active
   *  rows are never touched (a still-live open loop can outlive any window).
   *  Returns rows removed; 0/undefined days disables the prune. */
  prune_dismissed(now: Date, days: number): number {
    if (!(days > 0)) return 0;
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    return (
      this.db
        .prepare(`DELETE FROM person_observations WHERE dismissed = 1 AND observed_at < @cutoff`)
        .run({ '@cutoff': cutoff }).changes ?? 0
    );
  }

  /** Recent (non-dismissed) observations for a person, cordon-filtered, newest first. */
  list_for_person(person_id: string, caller: Caller, opts: { limit?: number; include_dismissed?: boolean } = {}): PersonObservation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM person_observations
           WHERE person_id = @p ${opts.include_dismissed ? '' : 'AND dismissed = 0'}
           ORDER BY observed_at DESC LIMIT @limit`,
      )
      .all({ '@p': person_id, '@limit': opts.limit ?? 20 }) as Row[];
    return rows.map(hydrate).filter((o) => note_visible_to_caller(o.private_to, caller));
  }

  /** Map of person_id → recent observations for a set of people (the list view). */
  by_person(person_ids: string[], caller: Caller, per_person = 5): Map<string, PersonObservation[]> {
    const out = new Map<string, PersonObservation[]>();
    for (const pid of person_ids) {
      const obs = this.list_for_person(pid, caller, { limit: per_person });
      if (obs.length) out.set(pid, obs);
    }
    return out;
  }

  /** Dismiss one observation (the D trust action). Cordon-checked. Returns success. */
  dismiss(id: string, caller: Caller): boolean {
    const row = this.db.prepare(`SELECT * FROM person_observations WHERE id = @id`).get({ '@id': id }) as Row | undefined;
    if (!row || !note_visible_to_caller(row.private_to, caller)) return false;
    this.db.prepare(`UPDATE person_observations SET dismissed = 1 WHERE id = @id`).run({ '@id': id });
    return true;
  }
}
