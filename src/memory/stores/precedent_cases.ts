/**
 * Precedent cases — household case law (Kate self-direction C3, 2026-07-05).
 *
 * The decided history is labeled training data nobody reads: every decided
 * proposal, every Proposal-Court verdict, every closed process miss. This
 * store indexes each as a compact CASE (situation → action → outcome) so the
 * court's lenses, the filing chokepoint, and Kate's recall_precedent tool can
 * ask "what did we do last time?".
 *
 * Self-contained additive table (CREATE IF NOT EXISTS in the ctor; no
 * SCHEMA_SQL edit, no SCHEMA_VERSION bump) — the person_observations pattern.
 * Named-sigil binds (the open_db guard). Cordon: each case inherits the
 * underlying proposal's user_id (NULL = owner-global/system, following the
 * proposal-visibility rules exactly — the owner has NO god-view of a case
 * distilled from another user's cordoned proposal).
 *
 * Embeddings are OPTIONAL fidelity: a case rows with `embedding` NULL still
 * matches via deterministic token overlap; the nightly indexer back-fills
 * vectors whenever the embedder is live. Vectors are Float32 LE BLOBs (the
 * chunk_embeddings pattern; pack_f32/unpack_f32 in @core/embeddings).
 */

import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { pack_f32 } from '@core/embeddings';
import type { Tier } from '@core/users';

export type PrecedentSourceKind = 'proposal' | 'court_verdict' | 'process_miss';

/** Label honesty (the known limiting factor): every case carries an explicit
 *  outcome-confidence so a reason-less denial reads as WEAK precedent, never
 *  as settled law. */
export type PrecedentConfidence = 'strong' | 'moderate' | 'weak';

export interface PrecedentCaseInput {
  source_kind: PrecedentSourceKind;
  /** Idempotency key with source_kind: proposal id / audit-row id / pm_* id. */
  source_id: string;
  /** Underlying proposal id when one exists (proposal + court_verdict cases) —
   *  recall dedupes on it so one decided proposal never fills two top-k slots. */
  proposal_id: string | null;
  /** Proposal kind, or 'process_miss'. */
  kind: string;
  specialist_id: string;
  /** The match/embed text — what the case was ABOUT. */
  situation: string;
  /** The rendered compact case doc (what a prompt receives verbatim). */
  case_md: string;
  outcome: string;
  confidence: PrecedentConfidence;
  /** One clause of label honesty ("denied, no reason recorded — weak precedent"). */
  confidence_note: string;
  /** Per-user cordon, inherited from the underlying proposal (NULL = system). */
  user_id: string | null;
  decided_at: string;
  /** Source-side change marker (ts_decided / ts_updated) — unchanged ⇒ skip. */
  source_updated_at: string;
}

export interface PrecedentCandidate {
  id: string;
  source_kind: PrecedentSourceKind;
  source_id: string;
  proposal_id: string | null;
  kind: string;
  specialist_id: string;
  situation: string;
  case_md: string;
  outcome: string;
  confidence: PrecedentConfidence;
  confidence_note: string;
  user_id: string | null;
  decided_at: string;
  embedding: Uint8Array | null;
  dim: number | null;
}

/** Who is asking. `viewer` mirrors the proposals-queue cordon (owner sees
 *  system NULL + own; a non-owner sees ONLY their own). `proposal` scopes
 *  evidence about one proposal to that proposal's own cordon (system
 *  pipelines: the court, create()). `system` = NULL-only (no user in ctx —
 *  fail closed, never wide). */
export type PrecedentScope =
  | { kind: 'viewer'; user_id: string; tier: Tier }
  | { kind: 'proposal'; user_id: string | null }
  | { kind: 'system' };

const MATCH_CANDIDATE_CAP = 4000;

export class PrecedentStore {
  constructor(private db: Database) {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS precedent_cases (
         id TEXT PRIMARY KEY,
         source_kind TEXT NOT NULL,
         source_id TEXT NOT NULL,
         proposal_id TEXT,
         kind TEXT NOT NULL DEFAULT '',
         specialist_id TEXT NOT NULL DEFAULT '',
         situation TEXT NOT NULL,
         case_md TEXT NOT NULL,
         outcome TEXT NOT NULL,
         confidence TEXT NOT NULL DEFAULT 'weak',
         confidence_note TEXT NOT NULL DEFAULT '',
         user_id TEXT,
         decided_at TEXT NOT NULL,
         source_updated_at TEXT NOT NULL,
         embedding BLOB,
         embedding_model TEXT,
         dim INTEGER,
         indexed_at TEXT NOT NULL,
         UNIQUE(source_kind, source_id)
       )`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_precedent_user ON precedent_cases(user_id, decided_at)`,
    );
  }

  /**
   * Idempotent per (source_kind, source_id): a new source inserts; an
   * unchanged one (same source_updated_at) is a no-op; a changed one updates
   * in place — and clears the embedding ONLY when the situation text moved
   * (outcome-field churn shouldn't cost a re-embed).
   */
  upsert(c: PrecedentCaseInput): { id: string; changed: boolean; is_new: boolean } {
    const existing = this.db
      .prepare(
        `SELECT id, situation, source_updated_at FROM precedent_cases
          WHERE source_kind = @sk AND source_id = @sid`,
      )
      .get({ '@sk': c.source_kind, '@sid': c.source_id }) as
      | { id: string; situation: string; source_updated_at: string }
      | null;
    const now = new Date().toISOString();
    if (existing != null) {
      if (existing.source_updated_at === c.source_updated_at) {
        return { id: existing.id, changed: false, is_new: false };
      }
      const situation_moved = existing.situation !== c.situation;
      this.db
        .prepare(
          `UPDATE precedent_cases
              SET proposal_id = @pid, kind = @kind, specialist_id = @spec,
                  situation = @sit, case_md = @md, outcome = @outcome,
                  confidence = @conf, confidence_note = @note, user_id = @uid,
                  decided_at = @decided, source_updated_at = @sup,
                  indexed_at = @now,
                  embedding = CASE WHEN @moved = 1 THEN NULL ELSE embedding END,
                  embedding_model = CASE WHEN @moved = 1 THEN NULL ELSE embedding_model END,
                  dim = CASE WHEN @moved = 1 THEN NULL ELSE dim END
            WHERE id = @id`,
        )
        .run({
          '@id': existing.id,
          '@pid': c.proposal_id,
          '@kind': c.kind,
          '@spec': c.specialist_id,
          '@sit': c.situation,
          '@md': c.case_md,
          '@outcome': c.outcome,
          '@conf': c.confidence,
          '@note': c.confidence_note,
          '@uid': c.user_id,
          '@decided': c.decided_at,
          '@sup': c.source_updated_at,
          '@now': now,
          '@moved': situation_moved ? 1 : 0,
        });
      return { id: existing.id, changed: true, is_new: false };
    }
    const id = `pc_${ulid().toLowerCase().slice(-14)}`;
    this.db
      .prepare(
        `INSERT INTO precedent_cases
           (id, source_kind, source_id, proposal_id, kind, specialist_id,
            situation, case_md, outcome, confidence, confidence_note, user_id,
            decided_at, source_updated_at, embedding, embedding_model, dim, indexed_at)
         VALUES
           (@id, @sk, @sid, @pid, @kind, @spec, @sit, @md, @outcome, @conf,
            @note, @uid, @decided, @sup, NULL, NULL, NULL, @now)`,
      )
      .run({
        '@id': id,
        '@sk': c.source_kind,
        '@sid': c.source_id,
        '@pid': c.proposal_id,
        '@kind': c.kind,
        '@spec': c.specialist_id,
        '@sit': c.situation,
        '@md': c.case_md,
        '@outcome': c.outcome,
        '@conf': c.confidence,
        '@note': c.confidence_note,
        '@uid': c.user_id,
        '@decided': c.decided_at,
        '@sup': c.source_updated_at,
        '@now': now,
      });
    return { id, changed: true, is_new: true };
  }

  /** Cases still waiting for a vector (embedding NULL), newest decisions
   *  first so fresh case law becomes vector-searchable ahead of the backlog. */
  needing_embedding(limit: number): Array<{ id: string; situation: string }> {
    return this.db
      .prepare(
        `SELECT id, situation FROM precedent_cases
          WHERE embedding IS NULL ORDER BY decided_at DESC LIMIT @lim`,
      )
      .all({ '@lim': limit }) as Array<{ id: string; situation: string }>;
  }

  set_embedding(id: string, vec: number[] | Float32Array, model: string): void {
    const f = vec instanceof Float32Array ? vec : Float32Array.from(vec);
    this.db
      .prepare(
        `UPDATE precedent_cases
            SET embedding = @e, embedding_model = @m, dim = @d WHERE id = @id`,
      )
      .run({ '@id': id, '@e': pack_f32(f), '@m': model, '@d': f.length });
  }

  /** Cordon WHERE clause + params for a scope. Mirrors the proposals-queue
   *  visibility rules; `system` fails closed to NULL-only. */
  private scope_clause(scope: PrecedentScope): { clause: string; params: Record<string, unknown> } {
    if (scope.kind === 'viewer') {
      return scope.tier === 'owner'
        ? { clause: '(user_id IS NULL OR user_id = @scope_uid)', params: { '@scope_uid': scope.user_id } }
        : { clause: 'user_id = @scope_uid', params: { '@scope_uid': scope.user_id } };
    }
    if (scope.kind === 'proposal' && scope.user_id !== null) {
      return { clause: '(user_id IS NULL OR user_id = @scope_uid)', params: { '@scope_uid': scope.user_id } };
    }
    return { clause: 'user_id IS NULL', params: {} };
  }

  /** All match candidates visible under `scope` (capped; this corpus is
   *  hundreds-to-thousands — brute-force cosine/overlap is the right tool). */
  match_candidates(scope: PrecedentScope): PrecedentCandidate[] {
    const { clause, params } = this.scope_clause(scope);
    return this.db
      .prepare(
        `SELECT id, source_kind, source_id, proposal_id, kind, specialist_id,
                situation, case_md, outcome, confidence, confidence_note,
                user_id, decided_at, embedding, dim
           FROM precedent_cases WHERE ${clause}
          ORDER BY decided_at DESC LIMIT @cap`,
      )
      .all({ ...params, '@cap': MATCH_CANDIDATE_CAP }) as PrecedentCandidate[];
  }

  counts(): { total: number; embedded: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded
           FROM precedent_cases`,
      )
      .get() as { total: number; embedded: number | null } | null;
    return { total: row?.total ?? 0, embedded: row?.embedded ?? 0 };
  }
}
