// Core types shared across the codebase.

export type AgentName = 'scribe' | 'concierge';

export type NoteType =
  | 'person'
  | 'journal_entry'
  | 'decision'
  | 'event'
  | 'account'
  | 'project'
  | 'draft'
  | 'audit_log';

export type RiskTier = 'read' | 'write_internal' | 'send_external' | 'spend_money';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts?: string;
}

export interface AuditRecord {
  id: string;
  ts: string;
  intent_id: string;
  /**
   * One of the fixed agents OR a specialist id (e.g. 'kate', 'vivian').
   * Specialist ids are validated upstream by the runtime; this field
   * accepts a string so the audit table stays open to future specialists
   * without a type-system change every time.
   */
  agent: AgentName | 'orchestrator' | 'ingestor' | 'specialist' | string;
  tool_name: string;
  tool_input: unknown;
  gate_decision?: {
    decision: string;
    rationale: string;
    matched_rules: string[];
  };
  execution_result?: unknown;
  human_verdict?: {
    who: string;
    verdict: 'approve' | 'deny';
    modified: boolean;
  };
  cost?: {
    tokens_in: number;
    tokens_out: number;
    ms: number;
    model: string;
  };
  error?: string;
  /**
   * Phase 2b — id of the user whose session triggered this row.
   * Nullable for system-initiated rows (deliberation, scheduler,
   * ingestor). Joins back to config/users.yaml for audit reports.
   */
  user_id?: string;
  /**
   * Provable cordon Phase 1a — id of the user whose DATA this row targets
   * (distinct from `user_id` = who triggered it). Set on sanctioned
   * cross-user actions (e.g. owner-oversight, target = the reviewed user);
   * powers the member-facing "who reached my data" access log.
   */
  subject_user_id?: string;
}
