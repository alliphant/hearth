/**
 * Approval queue — persistence for human-in-the-loop decisions.
 *
 * Rows live in the `approvals` SQLite table (schema in
 * src/memory/stores/structured.ts). Each row captures the original
 * ToolCall, the gate decision that triggered the prompt, and (after
 * the user decides) their verdict and any modifications they made
 * before approval.
 *
 * This is a thin store — the orchestrator wires it to HTTP routes and
 * the policy/push.ts module. Nothing here does HTTP or pushes.
 */

import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { ToolCall } from '@core/tool';
import type { GateDecision } from './gateway';

export type ApprovalStatus = 'open' | 'approved' | 'denied' | 'expired';

export interface ApprovalRow {
  id: string;
  ts_created: string;
  ts_decided: string | null;
  status: ApprovalStatus;
  tool_call: ToolCall;
  gate_decision: GateDecision;
  modified_call: ToolCall | null;
  human_verdict: HumanVerdict | null;
}

export interface HumanVerdict {
  verdict: 'approve' | 'deny';
  who: string;
  reason?: string;
  modified: boolean;
}

interface ApprovalRowRaw {
  id: string;
  ts_created: string;
  ts_decided: string | null;
  status: ApprovalStatus;
  tool_call_json: string;
  gate_decision_json: string;
  modified_call_json: string | null;
  human_verdict_json: string | null;
}

function hydrate(raw: ApprovalRowRaw): ApprovalRow {
  return {
    id: raw.id,
    ts_created: raw.ts_created,
    ts_decided: raw.ts_decided,
    status: raw.status,
    tool_call: JSON.parse(raw.tool_call_json) as ToolCall,
    gate_decision: JSON.parse(raw.gate_decision_json) as GateDecision,
    modified_call: raw.modified_call_json
      ? (JSON.parse(raw.modified_call_json) as ToolCall)
      : null,
    human_verdict: raw.human_verdict_json
      ? (JSON.parse(raw.human_verdict_json) as HumanVerdict)
      : null,
  };
}

export class ApprovalStore {
  constructor(private db: Database) {}

  /** Create a new open approval. Returns the assigned id. */
  create(call: ToolCall, gate_decision: GateDecision): string {
    const id = `ap_${ulid().toLowerCase().slice(-12)}`;
    this.db
      .prepare(
        `INSERT INTO approvals
         (id, ts_created, status, tool_call_json, gate_decision_json)
         VALUES (@id, @ts, 'open', @call, @gate)`,
      )
      .run({
        '@id': id,
        '@ts': new Date().toISOString(),
        '@call': JSON.stringify(call),
        '@gate': JSON.stringify(gate_decision),
      });
    return id;
  }

  get(id: string): ApprovalRow | null {
    const raw = this.db
      .prepare(`SELECT * FROM approvals WHERE id = @id`)
      .get({ '@id': id }) as ApprovalRowRaw | undefined;
    return raw ? hydrate(raw) : null;
  }

  list(status?: ApprovalStatus): ApprovalRow[] {
    const rows = status
      ? (this.db
          .prepare(
            `SELECT * FROM approvals WHERE status = @status
             ORDER BY ts_created DESC`,
          )
          .all({ '@status': status }) as ApprovalRowRaw[])
      : (this.db
          .prepare(`SELECT * FROM approvals ORDER BY ts_created DESC`)
          .all() as ApprovalRowRaw[]);
    return rows.map(hydrate);
  }

  /**
   * Atomically update an open approval to decided state.
   * Returns the updated row, or null if the approval was not found.
   * If the row was already decided (not 'open'), the existing row is
   * returned unchanged — callers should check `status` for idempotency.
   */
  decide(
    id: string,
    verdict: HumanVerdict,
    modified_call?: ToolCall,
  ): ApprovalRow | null {
    const existing = this.get(id);
    if (!existing) return null;
    if (existing.status !== 'open') return existing;

    const new_status: ApprovalStatus =
      verdict.verdict === 'approve' ? 'approved' : 'denied';
    this.db
      .prepare(
        `UPDATE approvals
         SET status = @status,
             ts_decided = @ts,
             modified_call_json = @modified,
             human_verdict_json = @verdict
         WHERE id = @id AND status = 'open'`,
      )
      .run({
        '@status': new_status,
        '@ts': new Date().toISOString(),
        '@modified': modified_call ? JSON.stringify(modified_call) : null,
        '@verdict': JSON.stringify(verdict),
        '@id': id,
      });
    return this.get(id);
  }

  /** Expire approvals older than `older_than`. Returns ids that were expired. */
  expire_open_before(older_than: Date): string[] {
    const cutoff = older_than.toISOString();
    const rows = this.db
      .prepare(
        `SELECT id FROM approvals
         WHERE status = 'open' AND ts_created < @cutoff`,
      )
      .all({ '@cutoff': cutoff }) as Array<{ id: string }>;
    if (rows.length === 0) return [];
    this.db
      .prepare(
        `UPDATE approvals
         SET status = 'expired', ts_decided = @ts
         WHERE status = 'open' AND ts_created < @cutoff`,
      )
      .run({ '@ts': new Date().toISOString(), '@cutoff': cutoff });
    return rows.map((r) => r.id);
  }
}
