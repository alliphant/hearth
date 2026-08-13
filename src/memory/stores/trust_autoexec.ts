/**
 * TrustAutoexecStore — the trust-teeth undo-window ledger (2026-07-02).
 *
 * One row per proposal the Proposal Court armed for auto-execution
 * (graduated tier2c/tier3 signature + unanimous court approve on a
 * user-action kind). A row is born `armed` with an `execute_after`
 * instant (now + HEARTH_TRUST_UNDO_MINUTES); the orchestrator's 60s
 * sweep (src/core/trust_teeth.ts) then resolves it exactly once:
 *
 *   armed → executed   the window passed with the proposal still open —
 *                       decide('approve') + the owner-tap effects ran.
 *   armed → canceled   the owner touched the proposal first (deny = the
 *                       undo, approve = they beat the sweep, snooze =
 *                       an explicit defer the sweep must respect).
 *   armed → failed     the execution attempt threw; terminal — the
 *                       proposal stays wherever decide()/effects left it
 *                       and the owner still holds the card.
 *
 * Transitions are guarded on `status = 'armed'` so a concurrent sweep
 * tick / manual cancel can't double-resolve a row. The table is the
 * durable half of the undo window — rows survive a restart and the
 * sweep picks them back up.
 */

import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';

export type TrustAutoexecStatus = 'armed' | 'executed' | 'canceled' | 'failed';

export interface TrustAutoexecRow {
  id: string;
  proposal_id: string;
  signature_hash: string | null;
  tier: string;
  ts_armed: string;
  execute_after: string;
  status: TrustAutoexecStatus;
  ts_resolved: string | null;
  resolution: string | null;
  votes_json: string | null;
}

export class TrustAutoexecStore {
  constructor(private db: Database) {}

  /**
   * Arm a proposal for auto-execution. Idempotent on proposal_id — a
   * re-convening that sees the same still-pending proposal returns the
   * existing row instead of resetting its window.
   */
  arm(input: {
    proposal_id: string;
    signature_hash: string | null;
    tier: string;
    execute_after: string;
    votes_json?: string;
    now?: Date;
  }): TrustAutoexecRow {
    const existing = this.get_by_proposal(input.proposal_id);
    if (existing) return existing;
    const id = `ta_${ulid().toLowerCase()}`;
    const ts = (input.now ?? new Date()).toISOString();
    this.db
      .prepare(
        `INSERT INTO trust_autoexec
         (id, proposal_id, signature_hash, tier, ts_armed, execute_after, status, votes_json)
         VALUES (@id, @pid, @sig, @tier, @ts, @after, 'armed', @votes)`,
      )
      .run({
        '@id': id,
        '@pid': input.proposal_id,
        '@sig': input.signature_hash,
        '@tier': input.tier,
        '@ts': ts,
        '@after': input.execute_after,
        '@votes': input.votes_json ?? null,
      });
    return this.get_by_proposal(input.proposal_id)!;
  }

  get(id: string): TrustAutoexecRow | null {
    const row = this.db
      .prepare(`SELECT * FROM trust_autoexec WHERE id = @id`)
      .get({ '@id': id }) as TrustAutoexecRow | null;
    return row ?? null;
  }

  get_by_proposal(proposal_id: string): TrustAutoexecRow | null {
    const row = this.db
      .prepare(`SELECT * FROM trust_autoexec WHERE proposal_id = @pid`)
      .get({ '@pid': proposal_id }) as TrustAutoexecRow | null;
    return row ?? null;
  }

  /** Armed rows whose window has passed, oldest due first. */
  due(now: Date = new Date()): TrustAutoexecRow[] {
    return this.db
      .prepare(
        `SELECT * FROM trust_autoexec
         WHERE status = 'armed' AND execute_after <= @now
         ORDER BY execute_after ASC`,
      )
      .all({ '@now': now.toISOString() }) as TrustAutoexecRow[];
  }

  /** All still-armed rows (the queue/digest "about to run" view). */
  list_armed(): TrustAutoexecRow[] {
    return this.db
      .prepare(`SELECT * FROM trust_autoexec WHERE status = 'armed' ORDER BY execute_after ASC`)
      .all() as TrustAutoexecRow[];
  }

  private _resolve(id: string, status: TrustAutoexecStatus, resolution: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE trust_autoexec
         SET status = @s, ts_resolved = @ts, resolution = @why
         WHERE id = @id AND status = 'armed'`,
      )
      .run({ '@s': status, '@ts': new Date().toISOString(), '@why': resolution.slice(0, 500), '@id': id });
    return res.changes > 0;
  }

  cancel(id: string, reason: string): boolean {
    return this._resolve(id, 'canceled', reason);
  }

  mark_executed(id: string, summary: string): boolean {
    return this._resolve(id, 'executed', summary);
  }

  mark_failed(id: string, error: string): boolean {
    return this._resolve(id, 'failed', error);
  }
}
