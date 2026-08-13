/**
 * DelegationStore — durable state for Kate's sub-agent delegations
 * (Kate sub-agents Phase 1, 2026-07-03 — docs/design-kate-subagents.md).
 *
 * A delegation is one task handed by a requesting specialist (Kate, the
 * chief of staff) to another specialist profile, run as a DETACHED turn in
 * the delegatee's own context so the requester's window pays only for the
 * task framing + the returned digest. The runner
 * (src/core/delegation.ts) owns the lifecycle; this store is the record.
 *
 * Status machine:
 *   running → done (carries digest_md)
 *          → failed (carries error)
 * A quick delegation that finishes inside the wall cap returns its digest
 * synchronously AND lands here as done; one that overruns flips nothing —
 * it simply completes later and reports back via the specialist inbox.
 *
 * Cordon: `user_id` is the originating user (nullable = system/legacy).
 * `list_recent` filters by requester + user so one household member's
 * delegated work never surfaces in another's status read.
 */
import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';

export type DelegationStatus = 'running' | 'done' | 'failed';
export type DelegationMode = 'quick' | 'background';

export interface DelegationRow {
  id: string;
  requested_by: string;
  profile_id: string;
  task: string;
  context: string | null;
  mode: DelegationMode;
  status: DelegationStatus;
  user_id: string | null;
  conversation_id: string | null;
  digest_md: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export class DelegationStore {
  constructor(private db: Database) {}

  create(input: {
    requested_by: string;
    profile_id: string;
    task: string;
    context?: string | null;
    mode: DelegationMode;
    user_id?: string | null;
    conversation_id?: string | null;
  }): DelegationRow {
    const id = `dg_${ulid().toLowerCase()}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO delegations
           (id, requested_by, profile_id, task, context, mode, status,
            user_id, conversation_id, created_at)
         VALUES (@id, @rb, @pid, @task, @ctx, @mode, 'running', @uid, @cid, @now)`,
      )
      .run({
        '@id': id,
        '@rb': input.requested_by,
        '@pid': input.profile_id,
        '@task': input.task,
        '@ctx': input.context ?? null,
        '@mode': input.mode,
        '@uid': input.user_id ?? null,
        '@cid': input.conversation_id ?? null,
        '@now': now,
      });
    return this.get(id)!;
  }

  get(id: string): DelegationRow | null {
    const row = this.db
      .prepare(`SELECT * FROM delegations WHERE id = @id`)
      .get({ '@id': id }) as DelegationRow | null;
    // bun:sqlite returns null (not undefined) for no row.
    return row != null ? row : null;
  }

  complete(id: string, digest_md: string): void {
    this.db
      .prepare(
        `UPDATE delegations
            SET status = 'done', digest_md = @d, completed_at = @now
          WHERE id = @id`,
      )
      .run({ '@id': id, '@d': digest_md, '@now': new Date().toISOString() });
  }

  fail(id: string, error: string): void {
    this.db
      .prepare(
        `UPDATE delegations
            SET status = 'failed', error = @e, completed_at = @now
          WHERE id = @id`,
      )
      .run({ '@id': id, '@e': error.slice(0, 2000), '@now': new Date().toISOString() });
  }

  /**
   * Recent delegations for a requester, cordoned to the calling user —
   * the proposals-queue pattern: a user sees THEIR rows; system rows
   * (user_id NULL, deliberation-initiated) surface for the owner only.
   * A null caller (system context) reads as owner-equivalent internal use.
   */
  list_recent(
    requested_by: string,
    caller: { user_id: string | null; is_owner: boolean },
    limit = 10,
  ): DelegationRow[] {
    const include_system = caller.is_owner || caller.user_id === null;
    return this.db
      .prepare(
        `SELECT * FROM delegations
          WHERE requested_by = @rb
            AND (
              (user_id IS NOT NULL AND user_id = @uid)
              OR (user_id IS NULL AND @sys = 1)
            )
          ORDER BY created_at DESC
          LIMIT @lim`,
      )
      .all({
        '@rb': requested_by,
        '@uid': caller.user_id,
        '@sys': include_system ? 1 : 0,
        '@lim': Math.max(1, Math.min(50, limit)),
      }) as DelegationRow[];
  }
}
