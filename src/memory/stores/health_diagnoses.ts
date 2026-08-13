/**
 * HealthDiagnosisStore — the durable ledger behind diagnose_dependency
 * (2026-06-20).
 *
 * One row per diagnosis run: the grounded root cause, the ranked + scored
 * candidate fixes, the recommended pick, the evidence snapshot, and (once
 * filed) the owner-facing proposal id. The companion to HealthIncidentStore —
 * the incident says "X is down"; the diagnosis says "here's WHY and here are
 * the scored fixes." Kept as its own table (not stuffed onto the incident row)
 * because a diagnosis has its own lifecycle: diagnosed → applied / superseded.
 *
 * The fix/evidence shapes are owned by @core/health_diagnosis; this store
 * persists + hydrates them. Type-only import, so no runtime edge.
 */
import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import type { ScoredFix, EvidencePack } from '@core/health_diagnosis';

export type DiagnosisStatus = 'diagnosed' | 'applied' | 'superseded';

export interface NewDiagnosis {
  dependency: string;
  incident_id?: string | null;
  root_cause: string;
  inconclusive: boolean;
  confidence: number | null;
  diagnosis_md?: string | null;
  fixes: ScoredFix[];
  recommended_index: number;
  evidence: EvidencePack;
  ungrounded_dropped: string[];
  model: string;
}

export interface StoredDiagnosis {
  id: string;
  dependency: string;
  incident_id: string | null;
  root_cause: string;
  inconclusive: boolean;
  confidence: number | null;
  diagnosis_md: string | null;
  fixes: ScoredFix[];
  recommended_index: number;
  evidence: EvidencePack | null;
  ungrounded_dropped: string[];
  model: string | null;
  proposal_id: string | null;
  applied_fix: ScoredFix | null;
  status: DiagnosisStatus;
  created_at: string;
}

interface RawRow {
  id: string;
  dependency: string;
  incident_id: string | null;
  root_cause: string;
  inconclusive: number;
  confidence: number | null;
  diagnosis_md: string | null;
  fixes_json: string | null;
  recommended_index: number;
  evidence_json: string | null;
  ungrounded_json: string | null;
  model: string | null;
  proposal_id: string | null;
  applied_fix_json: string | null;
  status: string;
  created_at: string;
}

function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function to_diagnosis(raw: RawRow): StoredDiagnosis {
  return {
    id: raw.id,
    dependency: raw.dependency,
    incident_id: raw.incident_id,
    root_cause: raw.root_cause,
    inconclusive: raw.inconclusive === 1,
    confidence: raw.confidence,
    diagnosis_md: raw.diagnosis_md,
    fixes: parse<ScoredFix[]>(raw.fixes_json, []),
    recommended_index: raw.recommended_index,
    evidence: parse<EvidencePack | null>(raw.evidence_json, null),
    ungrounded_dropped: parse<string[]>(raw.ungrounded_json, []),
    model: raw.model,
    proposal_id: raw.proposal_id,
    applied_fix: parse<ScoredFix | null>(raw.applied_fix_json, null),
    status: raw.status === 'applied' || raw.status === 'superseded' ? raw.status : 'diagnosed',
    created_at: raw.created_at,
  };
}

export class HealthDiagnosisStore {
  constructor(private db: Database) {}

  create(d: NewDiagnosis, now: Date = new Date()): string {
    const id = `hd_${ulid().toLowerCase().slice(-12)}`;
    this.db
      .prepare(
        `INSERT INTO health_diagnoses
           (id, dependency, incident_id, root_cause, inconclusive, confidence,
            diagnosis_md, fixes_json, recommended_index, evidence_json,
            ungrounded_json, model, status, created_at)
         VALUES
           (@id, @dep, @incident, @root, @inconclusive, @confidence,
            @md, @fixes, @rec, @evidence, @ungrounded, @model, 'diagnosed', @now)`,
      )
      .run({
        '@id': id,
        '@dep': d.dependency,
        '@incident': d.incident_id ?? null,
        '@root': d.root_cause,
        '@inconclusive': d.inconclusive ? 1 : 0,
        '@confidence': d.confidence,
        '@md': d.diagnosis_md ?? null,
        '@fixes': JSON.stringify(d.fixes ?? []),
        '@rec': d.recommended_index,
        '@evidence': JSON.stringify(d.evidence ?? null),
        '@ungrounded': JSON.stringify(d.ungrounded_dropped ?? []),
        '@model': d.model,
        '@now': now.toISOString(),
      });
    return id;
  }

  get(id: string): StoredDiagnosis | null {
    const raw = this.db.prepare(`SELECT * FROM health_diagnoses WHERE id = @id`).get({ '@id': id }) as
      | RawRow
      | undefined;
    return raw ? to_diagnosis(raw) : null;
  }

  /** The most recent diagnosis for a dependency. */
  latest_for(dependency: string): StoredDiagnosis | null {
    const raw = this.db
      .prepare(
        `SELECT * FROM health_diagnoses WHERE dependency = @dep
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get({ '@dep': dependency }) as RawRow | undefined;
    return raw ? to_diagnosis(raw) : null;
  }

  list_recent(limit = 20): StoredDiagnosis[] {
    const rows = this.db
      .prepare(`SELECT * FROM health_diagnoses ORDER BY created_at DESC LIMIT @lim`)
      .all({ '@lim': Math.max(1, Math.min(limit, 200)) }) as RawRow[];
    return rows.map(to_diagnosis);
  }

  /** Link the owner-facing proposal once it's filed. */
  attach_proposal(id: string, proposal_id: string): void {
    this.db
      .prepare(`UPDATE health_diagnoses SET proposal_id = @pid WHERE id = @id`)
      .run({ '@pid': proposal_id, '@id': id });
  }

  /** Record that a fix from this diagnosis was applied (through an existing
   *  gate). Does NOT claim recovery — the next health scan confirms that. */
  mark_applied(id: string, applied_fix: ScoredFix): void {
    this.db
      .prepare(
        `UPDATE health_diagnoses SET status = 'applied', applied_fix_json = @fix WHERE id = @id`,
      )
      .run({ '@fix': JSON.stringify(applied_fix), '@id': id });
  }

  /** Supersede any older OPEN diagnosis for the same dependency when a fresh
   *  one lands — keep one live diagnosis per dep. */
  supersede_open(dependency: string, except_id: string): void {
    this.db
      .prepare(
        `UPDATE health_diagnoses SET status = 'superseded'
          WHERE dependency = @dep AND id != @id AND status = 'diagnosed'`,
      )
      .run({ '@dep': dependency, '@id': except_id });
  }
}
