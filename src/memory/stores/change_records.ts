/**
 * ChangeRecordsStore — the pipeline ledger for every change Beatrice (the
 * `trainer` meta-agent) proposes to the system.
 *
 * One row per change (config tuning OR code), each tied to an isolated
 * `beatrice/*` branch + PR opened via `change_pipeline.open_change_pr`. The row
 * carries the embedded diff (so Kate can review without repo-read access), the
 * code metrics shown in the Code Shop office (LOC, languages, coding tok/sec),
 * Kate's skeptic verdict, and the lifecycle status. Revising a denied change
 * reuses the same `dedup_key`, which retires the prior row (`superseded`).
 *
 * System-global (no user_id): Beatrice's changes are owner-scoped self-
 * improvement, surfaced only in the owner's Code Shop office.
 *
 * Status machine:
 *   pending_kate_review → pending_owner_merge → merged
 *                       ↘ denied_by_kate (→ superseded on re-file)
 *                                            ↘ merge_failed
 */
import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { GUARD_CHANGE_DEDUP_SUPERSESSION, bump_guard_counter } from './guard_counters';

export type ChangeStatus =
  | 'pending_kate_review'
  | 'pending_owner_merge'
  | 'merged'
  | 'denied_by_kate'
  | 'superseded'
  | 'merge_failed';

export type KateVerdict = 'approve' | 'approve_with_concerns' | 'deny';

/**
 * The verbatim authoring inputs (open_change_pr's files/edits), persisted so
 * merge recovery can re-land an approved change whose PR went stale. Declared
 * structurally here (not imported from the trainer module) to keep the memory
 * layer free of specialist-code imports; shape-compatible with
 * `change_pipeline.ChangeInputs`.
 */
export interface StoredChangeInputs {
  files: Array<{ path: string; contents: string }>;
  edits: Array<{ path: string; old_string: string; new_string: string; replace_all?: boolean }>;
}

/** Inputs over this size store as NULL — recovery degrades to update-branch-
 *  or-park for the rare oversized change rather than bloating the ledger. */
const CHANGE_INPUTS_STORE_CAP = 512 * 1024;

export interface ChangeRecord {
  id: string;
  ts_created: string;
  ts_updated: string;
  origin: string; // 'apply_low_risk_fix' | 'propose_code_change'
  change_kind: string; // 'config' | 'code' | the low-risk change.kind
  target_specialist_id: string | null;
  branch: string;
  pr_number: number | null;
  pr_url: string | null;
  commit_sha: string | null;
  files: string[];
  lines_added: number;
  lines_removed: number;
  languages: string[];
  diff_summary: string;
  diff_truncated: boolean;
  rationale_md: string;
  dedup_key: string | null;
  superseded_by: string | null;
  status: ChangeStatus;
  kate_verdict: KateVerdict | null;
  kate_reasons_md: string | null;
  related_proposal_id: string | null;
  gen_tokens_out: number | null;
  gen_ms: number | null;
  gen_tok_per_sec: number | null;
  merged_at: string | null;
  merged_sha: string | null;
  audit_id: string | null;
  /** Deterministic-gate verdict (tsc + guard) at PR-open time. null = not
   *  recorded (legacy row / not opened through the pipeline). false should be
   *  unreachable in practice — a red change throws before a record is created —
   *  but Kate's review gate hard-refuses approving one as defense-in-depth. */
  checks_passed: boolean | null;
  checks_summary: string | null;
  /** Verbatim authoring inputs; null = not recorded (legacy row / oversized). */
  change_inputs: StoredChangeInputs | null;
}

interface RawRow {
  id: string;
  ts_created: string;
  ts_updated: string;
  origin: string;
  change_kind: string;
  target_specialist_id: string | null;
  branch: string;
  pr_number: number | null;
  pr_url: string | null;
  commit_sha: string | null;
  files_json: string;
  lines_added: number;
  lines_removed: number;
  languages_json: string;
  diff_summary: string;
  diff_truncated: number;
  rationale_md: string;
  dedup_key: string | null;
  superseded_by: string | null;
  status: ChangeStatus;
  kate_verdict: KateVerdict | null;
  kate_reasons_md: string | null;
  related_proposal_id: string | null;
  gen_tokens_out: number | null;
  gen_ms: number | null;
  gen_tok_per_sec: number | null;
  merged_at: string | null;
  merged_sha: string | null;
  audit_id: string | null;
  checks_passed: number | null;
  checks_summary: string | null;
  change_inputs_json: string | null;
}

function parse_change_inputs(s: string | null): StoredChangeInputs | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as StoredChangeInputs;
    if (!Array.isArray(v.files) || !Array.isArray(v.edits)) return null;
    return v;
  } catch {
    return null;
  }
}

function hydrate(r: RawRow): ChangeRecord {
  const parse_arr = (s: string): string[] => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  return {
    ...r,
    files: parse_arr(r.files_json),
    languages: parse_arr(r.languages_json),
    diff_truncated: r.diff_truncated === 1,
    checks_passed: r.checks_passed == null ? null : r.checks_passed === 1,
    change_inputs: parse_change_inputs(r.change_inputs_json),
  } as ChangeRecord;
}

/** Statuses that a re-filed change (same dedup_key) supersedes. */
const SUPERSEDABLE: ChangeStatus[] = [
  'pending_kate_review',
  'pending_owner_merge',
  'denied_by_kate',
  'merge_failed',
];

export class ChangeRecordsStore {
  constructor(private db: Database) {}

  create(input: {
    origin: string;
    change_kind: string;
    target_specialist_id?: string | null;
    branch: string;
    pr_number?: number | null;
    pr_url?: string | null;
    commit_sha?: string | null;
    files: string[];
    lines_added?: number;
    lines_removed?: number;
    languages?: string[];
    diff_summary?: string;
    diff_truncated?: boolean;
    rationale_md?: string;
    dedup_key?: string | null;
    related_proposal_id?: string | null;
    gen_tokens_out?: number | null;
    gen_ms?: number | null;
    gen_tok_per_sec?: number | null;
    audit_id?: string | null;
    checks_passed?: boolean | null;
    checks_summary?: string | null;
    change_inputs?: StoredChangeInputs | null;
  }): ChangeRecord {
    const id = `bchg_${ulid().toLowerCase().slice(-16)}`;
    const now = new Date().toISOString();
    let inputs_json: string | null = null;
    if (input.change_inputs) {
      const serialized = JSON.stringify(input.change_inputs);
      if (serialized.length <= CHANGE_INPUTS_STORE_CAP) inputs_json = serialized;
    }

    // A re-filed change reusing the same dedup_key retires the prior open rows.
    if (input.dedup_key) this.supersede_by_dedup(input.dedup_key, id);

    this.db
      .prepare(
        `INSERT INTO beatrice_changes (
           id, ts_created, ts_updated, origin, change_kind, target_specialist_id,
           branch, pr_number, pr_url, commit_sha, files_json, lines_added,
           lines_removed, languages_json, diff_summary, diff_truncated, rationale_md,
           dedup_key, status, related_proposal_id, gen_tokens_out, gen_ms,
           gen_tok_per_sec, audit_id, checks_passed, checks_summary,
           change_inputs_json
         ) VALUES (
           @id, @now, @now, @origin, @change_kind, @target, @branch, @pr_number,
           @pr_url, @commit_sha, @files, @added, @removed, @langs, @diff, @trunc,
           @rationale, @dedup, 'pending_kate_review', @rel, @tok_out, @gen_ms,
           @tps, @audit, @checks_passed, @checks_summary, @inputs
         )`,
      )
      .run({
        '@id': id,
        '@now': now,
        '@origin': input.origin,
        '@change_kind': input.change_kind,
        '@target': input.target_specialist_id ?? null,
        '@branch': input.branch,
        '@pr_number': input.pr_number ?? null,
        '@pr_url': input.pr_url ?? null,
        '@commit_sha': input.commit_sha ?? null,
        '@files': JSON.stringify(input.files),
        '@added': input.lines_added ?? 0,
        '@removed': input.lines_removed ?? 0,
        '@langs': JSON.stringify(input.languages ?? []),
        '@diff': input.diff_summary ?? '',
        '@trunc': input.diff_truncated ? 1 : 0,
        '@rationale': input.rationale_md ?? '',
        '@dedup': input.dedup_key ?? null,
        '@rel': input.related_proposal_id ?? null,
        '@tok_out': input.gen_tokens_out ?? null,
        '@gen_ms': input.gen_ms ?? null,
        '@tps': input.gen_tok_per_sec ?? null,
        '@audit': input.audit_id ?? null,
        '@checks_passed': input.checks_passed == null ? null : input.checks_passed ? 1 : 0,
        '@checks_summary': input.checks_summary ?? null,
        '@inputs': inputs_json,
      });
    return this.get(id)!;
  }

  get(id: string): ChangeRecord | null {
    const r = this.db.prepare(`SELECT * FROM beatrice_changes WHERE id = @id`).get({ '@id': id }) as
      | RawRow
      | undefined;
    return r ? hydrate(r) : null;
  }

  list(opts: { status?: ChangeStatus | ChangeStatus[]; limit?: number } = {}): ChangeRecord[] {
    let clause = '';
    const params: Record<string, string | number> = { '@lim': opts.limit ?? 100 };
    if (opts.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      const placeholders = statuses.map((_, i) => `@s${i}`).join(', ');
      clause = `WHERE status IN (${placeholders})`;
      statuses.forEach((s, i) => (params[`@s${i}`] = s));
    }
    const rows = this.db
      .prepare(`SELECT * FROM beatrice_changes ${clause} ORDER BY ts_created DESC LIMIT @lim`)
      .all(params) as RawRow[];
    return rows.map(hydrate);
  }

  /**
   * Record Kate's skeptic verdict and advance the status. The UPDATE is guarded
   * on `status='pending_kate_review'`, so it is the single legal transition into
   * `pending_owner_merge`. Returns the updated record, or null if no row moved
   * (already reviewed by a concurrent call) so the caller can bail without
   * double-filing a merge proposal.
   */
  set_kate_verdict(id: string, verdict: KateVerdict, reasons_md: string): ChangeRecord | null {
    const next: ChangeStatus = verdict === 'deny' ? 'denied_by_kate' : 'pending_owner_merge';
    const info = this.db
      .prepare(
        `UPDATE beatrice_changes
           SET kate_verdict = @v, kate_reasons_md = @r, status = @s, ts_updated = @now
         WHERE id = @id AND status = 'pending_kate_review'`,
      )
      .run({ '@v': verdict, '@r': reasons_md, '@s': next, '@now': new Date().toISOString(), '@id': id });
    if (info.changes === 0) return null;
    return this.get(id);
  }

  attach_proposal(id: string, proposal_id: string): void {
    this.db
      .prepare(`UPDATE beatrice_changes SET related_proposal_id = @p, ts_updated = @now WHERE id = @id`)
      .run({ '@p': proposal_id, '@now': new Date().toISOString(), '@id': id });
  }

  /**
   * Send an already-Kate-approved change BACK to Beatrice from the owner's
   * merge queue (2026-07-18, conversational review). The owner reviewed the
   * change in chat and requested changes, so the `pending_owner_merge` row
   * returns to `denied_by_kate` carrying his feedback — the same revision
   * loop a Kate deny uses (Beatrice revises and re-files; the dedup_key
   * supersedes this row). Deliberately a SEPARATE method from
   * set_kate_verdict so that method's single-legal-transition guard stays
   * intact. Guarded on the one legal source status; returns null if the row
   * moved concurrently (e.g. the owner tapped merge while chatting).
   * Withdrawing the linked merge proposal is the CALLER's job
   * (review_change denies it with the same feedback) so a stale card can
   * never be approved.
   */
  send_back(id: string, reasons_md: string): ChangeRecord | null {
    const info = this.db
      .prepare(
        `UPDATE beatrice_changes
           SET kate_verdict = 'deny', kate_reasons_md = @r, status = 'denied_by_kate', ts_updated = @now
         WHERE id = @id AND status = 'pending_owner_merge'`,
      )
      .run({ '@r': reasons_md, '@now': new Date().toISOString(), '@id': id });
    if (info.changes === 0) return null;
    return this.get(id);
  }

  mark_merged(id: string, sha: string | null): ChangeRecord | null {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE beatrice_changes SET status = 'merged', merged_at = @now, merged_sha = @sha, ts_updated = @now WHERE id = @id`,
      )
      .run({ '@now': now, '@sha': sha, '@id': id });
    return this.get(id);
  }

  mark_merge_failed(id: string): void {
    this.db
      .prepare(`UPDATE beatrice_changes SET status = 'merge_failed', ts_updated = @now WHERE id = @id`)
      .run({ '@now': new Date().toISOString(), '@id': id });
  }

  /**
   * Retire ONE specific row as superseded-by another — the primitive behind
   * merge recovery's re-land (the fresh row replaces the conflicted one even
   * when the original carried no dedup_key). Guarded to supersedable statuses
   * so a merged/denied row can never be silently rewritten.
   */
  mark_superseded(id: string, by_id: string): void {
    const placeholders = SUPERSEDABLE.map((_, i) => `@s${i}`).join(', ');
    const params: Record<string, string | number> = {
      '@id': id,
      '@by': by_id,
      '@now': new Date().toISOString(),
    };
    SUPERSEDABLE.forEach((s, i) => (params[`@s${i}`] = s));
    const info = this.db
      .prepare(
        `UPDATE beatrice_changes
           SET status = 'superseded', superseded_by = @by, ts_updated = @now
         WHERE id = @id AND status IN (${placeholders})`,
      )
      .run(params);
    // Guard telemetry (2026-08-11): every supersession is a gate retiring an
    // open change — countable so a key that repeatedly eats work surfaces in
    // Mariah's scan instead of only in per-row status flips.
    if (info.changes > 0) {
      bump_guard_counter(
        this.db,
        GUARD_CHANGE_DEDUP_SUPERSESSION,
        `row:${id}`,
        `superseded by ${by_id}`,
      );
    }
  }

  /** Retire any open rows sharing a dedup_key (a revised change replaces them). */
  supersede_by_dedup(dedup_key: string, new_id: string): void {
    const placeholders = SUPERSEDABLE.map((_, i) => `@s${i}`).join(', ');
    const params: Record<string, string | number> = {
      '@dk': dedup_key,
      '@by': new_id,
      '@now': new Date().toISOString(),
    };
    SUPERSEDABLE.forEach((s, i) => (params[`@s${i}`] = s));
    const info = this.db
      .prepare(
        `UPDATE beatrice_changes
           SET status = 'superseded', superseded_by = @by, ts_updated = @now
         WHERE dedup_key = @dk AND status IN (${placeholders})`,
      )
      .run(params);
    // Guard telemetry (2026-08-11): a dedup key that keeps retiring open
    // changes is exactly the PR #268/#269 failure shape — count per key so
    // the recurrence is reviewable.
    if (info.changes > 0) {
      bump_guard_counter(
        this.db,
        GUARD_CHANGE_DEDUP_SUPERSESSION,
        dedup_key,
        `${info.changes} open change(s) retired by ${new_id}`,
      );
    }
  }
}
