/**
 * SwarmReviewStore — the durable ledger for the review swarm (a red/blue/judge
 * bench of critic sub-agents over ONE Beatrice code change). One `swarm_reviews`
 * row per run; `swarm_findings` rows are its findings ledger.
 *
 * Inform-only (2026-07-21): the swarm reports; Kate still rules via
 * `review_change` and the owner still merges. Nothing here touches the
 * code-teeth guard. The rows back the live `swarm_*` SSE events so the iOS bee
 * icon + web Code Shop panel can reconcile on (re)connect. See
 * docs/build-kate-swarm-beeicon.md.
 */
import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';

/** Bench seats attack/defend/judge; higher-court seats sit by lens. */
export type SwarmRole = 'red' | 'blue' | 'judge' | 'evidence' | 'mechanism' | 'impact';
export type SwarmSeatPhase = 'queued' | 'working' | 'done' | 'failed';
export type SwarmVerdict = 'pass' | 'pass_with_concerns' | 'block';
export type SwarmSeverity = 'blocker' | 'concern' | 'nit';
/** 'bench' = first pass; 'higher_court' = the appeal a block escalates to (once). */
export type SwarmTier = 'bench' | 'higher_court';

export interface SwarmSeatSpec {
  seat_id: string;
  role: SwarmRole;
  conversation_id: string;
}

export interface SwarmFindingRow {
  id: string;
  review_id: string;
  seat_id: string;
  role: SwarmRole;
  severity: SwarmSeverity;
  summary: string;
  file: string | null;
  line: number | null;
  refuted: boolean;
  ts: string;
}

export interface SwarmReviewRow {
  id: string;
  change_id: string;
  status: 'running' | 'judged' | 'failed';
  verdict: SwarmVerdict | null;
  title: string;
  bench: SwarmSeatSpec[];
  user_id: string | null;
  started_at: string;
  judged_at: string | null;
  tier: SwarmTier;
  /** On an appeal, the review this one is appealing. */
  escalated_from: string | null;
}

/** A review plus its findings — the shape the refetch route returns. */
export interface SwarmReviewWithFindings extends SwarmReviewRow {
  findings: SwarmFindingRow[];
}

interface SwarmReviewSqlRow {
  id: string;
  change_id: string;
  status: string;
  verdict: string | null;
  title: string;
  bench_json: string;
  user_id: string | null;
  started_at: string;
  judged_at: string | null;
  tier: string | null;
  escalated_from: string | null;
}

interface SwarmFindingSqlRow {
  id: string;
  review_id: string;
  seat_id: string;
  role: string;
  severity: string;
  summary: string;
  file: string | null;
  line: number | null;
  refuted: number;
  ts: string;
}

export class SwarmReviewStore {
  constructor(private db: Database) {}

  create(input: {
    id?: string;
    change_id: string;
    title: string;
    bench: SwarmSeatSpec[];
    user_id?: string | null;
    tier?: SwarmTier;
    escalated_from?: string | null;
  }): SwarmReviewRow {
    const id = input.id ?? `swr_${ulid()}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO swarm_reviews (id, change_id, status, verdict, title, bench_json, user_id, started_at, judged_at, tier, escalated_from)
         VALUES (@id, @change_id, 'running', NULL, @title, @bench_json, @user_id, @started_at, NULL, @tier, @escalated_from)`,
      )
      .run({
        '@id': id,
        '@change_id': input.change_id,
        '@title': input.title,
        '@bench_json': JSON.stringify(input.bench),
        '@user_id': input.user_id ?? null,
        '@started_at': now,
        '@tier': input.tier ?? 'bench',
        '@escalated_from': input.escalated_from ?? null,
      });
    return this.get(id)!;
  }

  add_finding(input: {
    review_id: string;
    seat_id: string;
    role: SwarmRole;
    severity: SwarmSeverity;
    summary: string;
    file?: string | null;
    line?: number | null;
    refuted?: boolean;
  }): SwarmFindingRow {
    const id = `swf_${ulid()}`;
    const ts = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO swarm_findings (id, review_id, seat_id, role, severity, summary, file, line, refuted, ts)
         VALUES (@id, @review_id, @seat_id, @role, @severity, @summary, @file, @line, @refuted, @ts)`,
      )
      .run({
        '@id': id,
        '@review_id': input.review_id,
        '@seat_id': input.seat_id,
        '@role': input.role,
        '@severity': input.severity,
        '@summary': input.summary,
        '@file': input.file ?? null,
        '@line': input.line ?? null,
        '@refuted': input.refuted ? 1 : 0,
        '@ts': ts,
      });
    return {
      id,
      review_id: input.review_id,
      seat_id: input.seat_id,
      role: input.role,
      severity: input.severity,
      summary: input.summary,
      file: input.file ?? null,
      line: input.line ?? null,
      refuted: !!input.refuted,
      ts,
    };
  }

  set_verdict(id: string, verdict: SwarmVerdict): void {
    this.db
      .prepare(
        `UPDATE swarm_reviews SET status = 'judged', verdict = @verdict, judged_at = @now WHERE id = @id`,
      )
      .run({ '@id': id, '@verdict': verdict, '@now': new Date().toISOString() });
  }

  fail(id: string): void {
    this.db
      .prepare(`UPDATE swarm_reviews SET status = 'failed', judged_at = @now WHERE id = @id`)
      .run({ '@id': id, '@now': new Date().toISOString() });
  }

  /** True while a run for this change is still in flight (dedup guard). */
  has_active_for_change(change_id: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM swarm_reviews WHERE change_id = @cid AND status = 'running' LIMIT 1`,
      )
      .get({ '@cid': change_id });
    return row != null;
  }

  get(id: string): SwarmReviewRow | null {
    const r = this.db
      .prepare(`SELECT * FROM swarm_reviews WHERE id = @id`)
      .get({ '@id': id }) as SwarmReviewSqlRow | null;
    return r ? this.hydrate(r) : null;
  }

  get_findings(review_id: string): SwarmFindingRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM swarm_findings WHERE review_id = @rid ORDER BY ts ASC`)
      .all({ '@rid': review_id }) as SwarmFindingSqlRow[];
    return rows.map((r) => ({
      id: r.id,
      review_id: r.review_id,
      seat_id: r.seat_id,
      role: r.role as SwarmRole,
      severity: r.severity as SwarmSeverity,
      summary: r.summary,
      file: r.file,
      line: r.line,
      refuted: r.refuted === 1,
      ts: r.ts,
    }));
  }

  /**
   * Reviews worth showing right now: every running one, plus any judged/failed
   * within `recent_minutes`. Most-recent first. Each carries its findings — the
   * shape the bee icon's foreground refetch consumes.
   *
   * MEMORY (2026-07-21): a bench sits for ~3 minutes, so a pure live window left
   * the panel blank ~99% of the time — hiding the most interesting artifact
   * there is (the last verdict). When nothing is live we fall back to the most
   * recent whole CASE: every review for the latest change_id, so a bench and the
   * higher court that heard its appeal come back together rather than as one
   * orphaned half. Callers tell live from historical by `judged_at` age.
   */
  list_active(recent_minutes = 30): SwarmReviewWithFindings[] {
    const cutoff = new Date(Date.now() - recent_minutes * 60_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM swarm_reviews
          WHERE status = 'running' OR (judged_at IS NOT NULL AND judged_at >= @cutoff)
          ORDER BY started_at DESC`,
      )
      .all({ '@cutoff': cutoff }) as SwarmReviewSqlRow[];
    const live = rows.map((r) => {
      const review = this.hydrate(r);
      return { ...review, findings: this.get_findings(review.id) };
    });
    if (live.length > 0) return live;
    return this.latest_case();
  }

  /** Every review for the most recently started change — the panel's fallback. */
  latest_case(): SwarmReviewWithFindings[] {
    const latest = this.db
      .prepare(`SELECT change_id FROM swarm_reviews ORDER BY started_at DESC LIMIT 1`)
      .get() as { change_id?: string } | undefined;
    if (!latest?.change_id) return [];
    const rows = this.db
      .prepare(`SELECT * FROM swarm_reviews WHERE change_id = @cid ORDER BY started_at ASC`)
      .all({ '@cid': latest.change_id }) as SwarmReviewSqlRow[];
    return rows.map((r) => {
      const review = this.hydrate(r);
      return { ...review, findings: this.get_findings(review.id) };
    });
  }

  private hydrate(r: SwarmReviewSqlRow): SwarmReviewRow {
    let bench: SwarmSeatSpec[] = [];
    try {
      bench = JSON.parse(r.bench_json) as SwarmSeatSpec[];
    } catch {
      bench = [];
    }
    return {
      id: r.id,
      change_id: r.change_id,
      status: r.status as SwarmReviewRow['status'],
      verdict: (r.verdict as SwarmVerdict | null) ?? null,
      title: r.title,
      bench,
      user_id: r.user_id,
      started_at: r.started_at,
      judged_at: r.judged_at,
      // Legacy rows (written before the higher court shipped) read as a plain bench.
      tier: (r.tier as SwarmTier | null) ?? 'bench',
      escalated_from: r.escalated_from ?? null,
    };
  }
}
