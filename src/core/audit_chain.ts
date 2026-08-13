/**
 * Tamper-evident audit ledger — the hash-chain over `audit_log` (Phase 1b of
 * the provable cordon, docs/security/provable-cordon-concept.md).
 *
 * Every audit row is linked to the previous one by an HMAC:
 *
 *   row_hash = HMAC_sha256(KEY, prev_row_hash ‖ canonical(this row))
 *
 * Editing any field, deleting a row, or reordering rows breaks the chain at
 * the first affected row — detectable by re-walking and recomputing. The
 * chain is computed at the single audit-write chokepoint (`MemoryClient.
 * log_action`) inside a `BEGIN IMMEDIATE` transaction, so it is correct
 * across the three processes (orchestrator / ingestor / scheduler) that
 * share the one SQLite file.
 *
 * Threat model (Jasper's, 2026-06-20): this defends against the IN-SCOPE
 * adversaries — a developer/AI/backup editor WITHOUT the orchestrator's
 * environment cannot forge a valid chain after an edit, because the HMAC
 * KEY lives in `HEARTH_AUDIT_CHAIN_KEY` (env only — never the DB, never the
 * repo, never a backup-of-the-DB). It does NOT defend against the
 * owner-on-the-box with the env (deliberately trusted). Off-box anchoring of
 * the head hash (Phase 1.5) is what would close the owner-rewrite case.
 *
 * The chain is a SUBSEQUENCE over rows whose `row_hash IS NOT NULL`, linked
 * in `rowid` order. Rows written before the feature (or by a rare fail-open
 * path) carry NULL hashes and are simply not part of the chain — counted as
 * "unchained" but never reported as tampered.
 */

import { createHmac } from 'node:crypto';
import type { Database } from 'bun:sqlite';

/** Seed for the very first chained row. */
export const GENESIS_HASH = 'hearth-audit-genesis-v1';

/** Kill switch — `HEARTH_AUDIT_CHAIN=0` reverts log_action to a plain insert. */
export function audit_chain_enabled(): boolean {
  return process.env.HEARTH_AUDIT_CHAIN !== '0';
}

/**
 * The HMAC key. Set `HEARTH_AUDIT_CHAIN_KEY` in the orchestrator env (NOT the
 * repo, NOT the DB) so a backup/DB-dump editor can't forge the chain. Unset
 * falls back to a published constant — still detects accidental corruption +
 * casual edits, but a source-reader could forge; document the env in deploy.
 */
function chain_key(): string {
  return process.env.HEARTH_AUDIT_CHAIN_KEY || 'hearth-audit-chain-v1-unsealed-default';
}

/**
 * The exact, AS-STORED column values the `row_hash` commits to. Order is
 * load-bearing — the verifier reads these same columns back and must produce
 * the identical canonical string. `tool_input`/`gate_decision`/… are the
 * already-`JSON.stringify`'d strings (or NULL), i.e. what sits in the column.
 */
export interface AuditChainFields {
  id: string;
  ts: string;
  intent_id: string;
  agent: string;
  tool_name: string;
  tool_input: string;
  gate_decision: string | null;
  execution_result: string | null;
  human_verdict: string | null;
  cost: string | null;
  error: string | null;
  user_id: string | null;
  subject_user_id: string | null;
}

/** Deterministic, unambiguous encoding (JSON array handles delimiters/escaping). */
export function canonical_row(f: AuditChainFields): string {
  return JSON.stringify([
    f.id,
    f.ts,
    f.intent_id,
    f.agent,
    f.tool_name,
    f.tool_input,
    f.gate_decision,
    f.execution_result,
    f.human_verdict,
    f.cost,
    f.error,
    f.user_id,
    f.subject_user_id,
  ]);
}

/** row_hash = HMAC(KEY, prev_hash ‖ canonical(row)). */
export function chain_row_hash(prev_hash: string, f: AuditChainFields): string {
  const h = createHmac('sha256', chain_key());
  h.update(prev_hash);
  h.update('\n');
  h.update(canonical_row(f));
  return h.digest('hex');
}

export interface ChainVerifyResult {
  /** intact = unbroken; broken = a row was edited/deleted/reordered. */
  status: 'intact' | 'broken' | 'empty' | 'unavailable';
  /** 'full' = anchored at genesis; 'recent' = internal-linkage over a window. */
  scope: 'full' | 'recent';
  rows_checked: number;
  total_chained: number;
  /** Rows with NULL row_hash (pre-feature or fail-open) — not tampered, just outside the chain. */
  unchained_rows: number;
  /** The latest chained row's hash — the client can remember this to detect later truncation. */
  head_hash: string | null;
  first_break_id?: string;
  first_break_reason?: 'edited' | 'deleted_or_reordered';
}

type ChainDbRow = AuditChainFields & {
  rowid: number;
  prev_hash: string | null;
  row_hash: string | null;
};

const SELECT_COLS =
  'rowid, id, ts, intent_id, agent, tool_name, tool_input, gate_decision, ' +
  'execution_result, human_verdict, cost, error, user_id, subject_user_id, prev_hash, row_hash';

/**
 * Walk the chained rows in rowid order and recompute each hash. With no
 * `limit` (or a log smaller than it) the walk is GENESIS-anchored (full
 * proof). With a `limit` smaller than the chain, only the most recent
 * `limit` rows are verified, anchored on the first row's stored `prev_hash`
 * — proves recent entries are internally unbroken (the full CLI is
 * genesis-anchored). Fail-safe: any error → `unavailable` (never a false
 * `broken`).
 */
export function verify_audit_chain(
  db: Database,
  opts: { limit?: number } = {},
): ChainVerifyResult {
  const limit = opts.limit ?? 0;
  try {
    const total_chained =
      (db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE row_hash IS NOT NULL`).get() as {
        n: number;
      }).n ?? 0;
    const unchained_rows =
      (db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE row_hash IS NULL`).get() as {
        n: number;
      }).n ?? 0;

    if (total_chained === 0) {
      return {
        status: 'empty',
        scope: 'full',
        rows_checked: 0,
        total_chained: 0,
        unchained_rows,
        head_hash: null,
      };
    }

    let rows: ChainDbRow[];
    let scope: 'full' | 'recent';
    if (limit > 0 && total_chained > limit) {
      rows = db
        .prepare(
          // The inner query must select rowid explicitly — a `SELECT *`
          // subquery does NOT expose rowid to the outer ORDER BY.
          `SELECT ${SELECT_COLS} FROM (
             SELECT ${SELECT_COLS} FROM audit_log WHERE row_hash IS NOT NULL
             ORDER BY rowid DESC LIMIT @lim
           ) ORDER BY rowid ASC`,
        )
        .all({ '@lim': limit }) as ChainDbRow[];
      scope = 'recent';
    } else {
      rows = db
        .prepare(
          `SELECT ${SELECT_COLS} FROM audit_log WHERE row_hash IS NOT NULL ORDER BY rowid ASC`,
        )
        .all() as ChainDbRow[];
      scope = 'full';
    }

    // Genesis-anchored for a full walk; for a recent window, anchor on the
    // first row's stored prev_hash (internal-linkage proof).
    let prev = scope === 'full' ? GENESIS_HASH : rows[0]?.prev_hash ?? GENESIS_HASH;
    let checked = 0;

    for (const r of rows) {
      // Linkage: a deleted/reordered predecessor shows up as a prev mismatch.
      if ((r.prev_hash ?? GENESIS_HASH) !== prev) {
        return {
          status: 'broken',
          scope,
          rows_checked: checked,
          total_chained,
          unchained_rows,
          head_hash: rows[rows.length - 1]?.row_hash ?? null,
          first_break_id: r.id,
          first_break_reason: 'deleted_or_reordered',
        };
      }
      // Content: an edited field recomputes to a different hash.
      const expect = chain_row_hash(prev, r);
      if (expect !== r.row_hash) {
        return {
          status: 'broken',
          scope,
          rows_checked: checked,
          total_chained,
          unchained_rows,
          head_hash: rows[rows.length - 1]?.row_hash ?? null,
          first_break_id: r.id,
          first_break_reason: 'edited',
        };
      }
      prev = r.row_hash as string;
      checked += 1;
    }

    return {
      status: 'intact',
      scope,
      rows_checked: checked,
      total_chained,
      unchained_rows,
      head_hash: prev,
    };
  } catch {
    return {
      status: 'unavailable',
      scope: 'full',
      rows_checked: 0,
      total_chained: 0,
      unchained_rows: 0,
      head_hash: null,
    };
  }
}

const RESEAL_COLS =
  'id, ts, intent_id, agent, tool_name, tool_input, gate_decision, ' +
  'execution_result, human_verdict, cost, error, user_id, subject_user_id';

/**
 * (Re)seal the ENTIRE audit_log as one genesis-anchored chain — used by
 * `backfill:audit-chain` to bring pre-feature rows (and any fail-open gaps)
 * into the chain. Deterministic + idempotent (same rows + same key → same
 * hashes), so a re-run is safe. Run with the orchestrator + ingestor stopped:
 * a row inserted mid-reseal chains from a head this is concurrently
 * rewriting, which a re-run then heals.
 */
export function reseal_audit_chain(db: Database): { sealed: number; head: string | null } {
  const rows = db
    .prepare(`SELECT ${RESEAL_COLS} FROM audit_log ORDER BY rowid ASC`)
    .all() as AuditChainFields[];
  const upd = db.prepare(`UPDATE audit_log SET prev_hash = @prev, row_hash = @hash WHERE id = @id`);
  const already = db.inTransaction;
  if (!already) db.exec('BEGIN IMMEDIATE');
  try {
    let prev = GENESIS_HASH;
    for (const f of rows) {
      const hash = chain_row_hash(prev, f);
      upd.run({ '@prev': prev, '@hash': hash, '@id': f.id });
      prev = hash;
    }
    if (!already) db.exec('COMMIT');
    return { sealed: rows.length, head: rows.length > 0 ? prev : null };
  } catch (e) {
    if (!already) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
    }
    throw e;
  }
}
