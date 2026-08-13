/**
 * DelegationRunner — Kate's sub-agent spine (Phase 1, 2026-07-03).
 * Design: docs/design-kate-subagents.md.
 *
 * A delegation runs another specialist profile's FULL turn in its own
 * disposable context — its own tool rounds, its own token budget, its own
 * (ephemeral) conversation — and hands back only a bounded digest. The
 * requester's context pays for the task framing + the digest, never the
 * delegatee's tool exhaust. This is the structural fix for the two
 * consult_specialist failure modes: the consultee squeezed into a blocking
 * synchronous call, and the requester's turn burning wall-clock while it
 * waits.
 *
 * Two modes, one lifecycle:
 *   - quick: awaited up to a wall cap (HEARTH_DELEGATE_QUICK_TIMEOUT_MS,
 *     default 90s). Finishes in time → digest returns inline to the
 *     requester's turn. Overruns → the run KEEPS GOING detached and the
 *     digest reports back via a specialist-inbox FYI; the requester gets
 *     the delegation id + an honest "still working" note instead.
 *   - background: detached from the start; inbox FYI on completion.
 *
 * Non-negotiables (mirror the reactive-trigger / runner contracts):
 *   - Concurrency is bounded by a module-level Semaphore
 *     (HEARTH_DELEGATE_MAX_CONCURRENCY, default 2) so a delegation burst
 *     queues instead of starving the shared 35B slots. Module-level so a
 *     ToolLoader hot-reload can't mint a second, wider pool.
 *   - Fail-honest: a failed run marks the row failed AND reports the
 *     failure back — a delegation never vanishes silently.
 *   - Cordon: the originating user threads into the sub-turn (their
 *     visibility rules apply inside it) and stamps the row + the FYI's
 *     originating_user_id.
 *   - Kill switch HEARTH_DELEGATE=0 — the tool declines with a
 *     recovery hint; nothing dispatches.
 */
import type { Database } from 'bun:sqlite';
import type { AuditRecord } from './types';
import type { AppEvent } from '@app/events';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { DelegationRow, DelegationStore } from '@memory/stores/delegations';
import { ulid } from 'ulid';
import { Semaphore } from './semaphore';
import type {
  SpecialistTurnInput,
  SpecialistTurnOutput,
} from './specialist_runtime';

export function delegate_enabled(): boolean {
  return process.env.HEARTH_DELEGATE !== '0';
}

function quick_timeout_ms(): number {
  const raw = Number(process.env.HEARTH_DELEGATE_QUICK_TIMEOUT_MS ?? '90000');
  return Number.isFinite(raw) && raw > 0 ? raw : 90_000;
}

function digest_max_tokens(): number {
  const raw = Number(process.env.HEARTH_DELEGATE_DIGEST_MAX_TOKENS ?? '1200');
  return Number.isFinite(raw) && raw > 0 ? Math.min(4000, raw) : 1200;
}

function max_concurrency(): number {
  const raw = Number(process.env.HEARTH_DELEGATE_MAX_CONCURRENCY ?? '2');
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 2;
}

/** Module-level so ToolLoader hot-reloads share ONE bounded pool. Sized at
 *  first use; a mid-process env change needs a restart (documented). */
let _pool: Semaphore | null = null;
function pool(): Semaphore {
  if (!_pool) _pool = new Semaphore(max_concurrency());
  return _pool;
}
/** Smoke seam — replace the pool (e.g. to assert queueing at max=1). */
export function _test_reset_pool(max?: number): void {
  _pool = max === undefined ? null : new Semaphore(max);
}

export interface DelegationUser {
  id: string;
  display_name: string;
  tier?: import('./users').Tier;
  timezone?: string;
}

/**
 * Structural (narrow) dependency contracts — the production SpecialistRuntime
 * / SpecialistRegistry / MemoryClient satisfy them as-is, and smokes inject
 * scripted fakes without standing up the full stack.
 */
export interface DelegationTurnRunner {
  turn(input: SpecialistTurnInput): Promise<SpecialistTurnOutput>;
}

export interface DelegationSpecialistLookup {
  get(id: string): { id: string; name: string } | null | undefined;
}

export interface DelegationAuditSink {
  log_action(record: Omit<AuditRecord, 'id' | 'ts'>): string;
}

export interface DelegationRunnerDeps {
  runtime: DelegationTurnRunner;
  specialists: DelegationSpecialistLookup;
  store: DelegationStore;
  inbox: Pick<SpecialistInbox, 'push'>;
  memory: DelegationAuditSink;
  /**
   * Optional event bus (2026-07-14, live-subagents): emits content-free
   * `delegation_started` / `delegation_completed` so the web GUI renders
   * live sub-agent chips + the subagent tray badge. Optional so smokes and
   * legacy wiring run unchanged.
   */
  events?: { emit: (e: AppEvent) => void };
  /**
   * Optional db handle (2026-07-14): lets a BACKGROUND delegation that
   * originated from a real user conversation close its own loop — on
   * completion the runner enqueues an immediate deliver-followup
   * scheduled_task, so the requester gets a fresh turn in the ORIGINAL
   * conversation to report the digest to the user (the same machinery
   * promise_followup uses; scheduler fires it within one poll, ≤60s).
   * Optional so smokes and legacy wiring run unchanged.
   */
  db?: Database;
}

export interface DelegateRunInput {
  requested_by: string;
  profile_id: string;
  task: string;
  context?: string;
  mode: 'quick' | 'background';
  user?: DelegationUser;
  conversation_id?: string;
}

export type DelegateRunResult =
  | { outcome: 'done'; delegation_id: string; digest: string }
  | { outcome: 'failed'; delegation_id: string; error: string }
  | {
      outcome: 'backgrounded';
      delegation_id: string;
      note: string;
    };

/** Internal result of one detached run — never throws. */
type RunOutcome = { ok: true; digest: string } | { ok: false; error: string };

export class DelegationRunner {
  constructor(private deps: DelegationRunnerDeps) {}

  /**
   * Dispatch a delegation. Quick mode awaits up to the wall cap then
   * degrades to backgrounded (the run continues; inbox FYI on landing).
   * Background mode returns immediately.
   */
  async run(input: DelegateRunInput): Promise<DelegateRunResult> {
    const requester_name =
      this.deps.specialists.get(input.requested_by)?.name ?? input.requested_by;
    const row = this.deps.store.create({
      requested_by: input.requested_by,
      profile_id: input.profile_id,
      task: input.task,
      context: input.context ?? null,
      mode: input.mode,
      user_id: input.user?.id ?? null,
      conversation_id: input.conversation_id ?? null,
    });

    this.deps.memory.log_action({
      intent_id: ulid(),
      agent: input.requested_by,
      tool_name: 'delegate_dispatched',
      tool_input: {
        delegation_id: row.id,
        profile_id: input.profile_id,
        mode: input.mode,
        task: input.task.slice(0, 300),
      },
      execution_result: { status: 'running' },
      user_id: input.user?.id,
    });

    this._emit({
      type: 'delegation_started',
      delegation_id: row.id,
      requested_by: input.requested_by,
      profile_id: input.profile_id,
      profile_name: this._profile_name(input.profile_id),
      mode: input.mode,
      conversation_id: row.conversation_id,
    });

    const run_promise = this._run(row, requester_name, input.user);

    if (input.mode === 'background') {
      void run_promise.then((res) => this._report_back(row, res));
      return {
        outcome: 'backgrounded',
        delegation_id: row.id,
        note:
          `${this._profile_name(input.profile_id)} is on it in the background — ` +
          `the result will land in your inbox as delegation ${row.id}.`,
      };
    }

    // quick: race the run against the wall cap. Losing the race does NOT
    // abort the run — it degrades to the background contract.
    const timeout = Symbol('timeout');
    const winner = await Promise.race([
      run_promise,
      new Promise<typeof timeout>((resolve) =>
        setTimeout(() => resolve(timeout), quick_timeout_ms()),
      ),
    ]);

    if (winner === timeout) {
      void run_promise.then((res) => this._report_back(row, res));
      return {
        outcome: 'backgrounded',
        delegation_id: row.id,
        note:
          `${this._profile_name(input.profile_id)} needs more time — the run continues in ` +
          `the background and the digest will land in your inbox as delegation ${row.id}. ` +
          `Tell the user you'll report back; do NOT restate this as a finished result.`,
      };
    }

    const res = winner as RunOutcome;
    if (res.ok) return { outcome: 'done', delegation_id: row.id, digest: res.digest };
    return { outcome: 'failed', delegation_id: row.id, error: res.error };
  }

  private _profile_name(profile_id: string): string {
    return this.deps.specialists.get(profile_id)?.name ?? profile_id;
  }

  /** One bounded, detached run. Completes/fails the row; never throws. */
  private async _run(
    row: DelegationRow,
    requester_name: string,
    user?: DelegationUser,
  ): Promise<RunOutcome> {
    const release = await pool().acquire();
    try {
      const out = await this.deps.runtime.turn({
        specialist_id: row.profile_id,
        conversation_id: `delegate:${row.id}`,
        message: {
          role: 'specialist',
          content: this._framing(row, requester_name),
          from_specialist_id: row.requested_by,
        },
        conversation_history: [],
        ...(user ? { user } : {}),
        max_tokens_override: digest_max_tokens(),
      });
      const digest = out.message_text.trim();
      if (digest.length === 0) {
        const tool_count = out.tool_calls_made.length;
        const err =
          `${this._profile_name(row.profile_id)} produced no digest — ` +
          `${tool_count} tool call${tool_count === 1 ? '' : 's'} but no final reply`;
        this.deps.store.fail(row.id, err);
        this._audit(row, 'delegate_failed', { error: err });
        this._emit_completed(row, false);
        return { ok: false, error: err };
      }
      this.deps.store.complete(row.id, digest);
      this._audit(row, 'delegate_completed', {
        digest_chars: digest.length,
        tool_calls: out.tool_calls_made.length,
      });
      this._emit_completed(row, true);
      return { ok: true, digest };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.deps.store.fail(row.id, msg);
      this._audit(row, 'delegate_failed', { error: msg.slice(0, 500) });
      this._emit_completed(row, false);
      return { ok: false, error: msg };
    } finally {
      release();
    }
  }

  /** Best-effort event emission — the bus must never break a run. */
  private _emit(e: AppEvent): void {
    try {
      this.deps.events?.emit(e);
    } catch {
      /* observability, not control flow */
    }
  }

  private _emit_completed(row: DelegationRow, ok: boolean): void {
    this._emit({
      type: 'delegation_completed',
      delegation_id: row.id,
      requested_by: row.requested_by,
      profile_id: row.profile_id,
      profile_name: this._profile_name(row.profile_id),
      ok,
      conversation_id: row.conversation_id,
    });
  }

  /** Detached completion → specialist-inbox FYI to the requester. */
  private _report_back(row: DelegationRow, res: RunOutcome): void {
    try {
      const body = res.ok
        ? `Delegation ${row.id} complete.\n\n**Task:** ${row.task}\n\n${res.digest}`
        : `Delegation ${row.id} FAILED.\n\n**Task:** ${row.task}\n\n**Error:** ${res.error}\n\n` +
          `Re-delegate with a narrower task, or handle it another way — the user was told ` +
          `you'd follow up.`;
      this.deps.inbox.push({
        from_specialist_id: row.profile_id,
        to_specialist_id: row.requested_by,
        kind: 'fyi',
        body_md: body,
        originating_user_id: row.user_id,
      });
    } catch {
      // Fail-open: a report-back miss must never crash the detached run.
      // The row itself is already complete/failed and readable via the
      // delegate tool's status action.
    }
    this._enqueue_conversation_report(row, res);
  }

  /**
   * Close the user-facing loop (2026-07-14, live-subagents): a BACKGROUND
   * delegation that originated from a real user conversation enqueues an
   * immediate deliver-followup scheduled_task on completion — the requester
   * gets a fresh turn in the ORIGINAL conversation, with the digest in the
   * trigger's scope, and reports the outcome to the user in their own voice.
   * Reuses promise_followup's exact delivery machinery (deliver-followup
   * route: per-conversation serialization, voice shaping, retries ×3), so
   * nothing new touches the message path. Fires within one scheduler poll
   * (≤60s of completion).
   *
   * Guards: only with a db handle, only when a user + conversation are
   * attached, and only for REAL conversations — synthetic contexts
   * (`delegate:…`, `deliberation:…`) carry a colon; conversation ids are
   * bare ULIDs. Deliberation-launched delegations (e.g. Vera critiques)
   * stay inbox-only. Fail-open: an enqueue miss never crashes the run.
   */
  private _enqueue_conversation_report(row: DelegationRow, res: RunOutcome): void {
    try {
      const db = this.deps.db;
      if (!db || !row.user_id || !row.conversation_id) return;
      if (row.conversation_id.includes(':')) return;
      const profile_name = this._profile_name(row.profile_id);
      const followup_id = `flw_${ulid().toLowerCase().slice(-12)}`;
      const scope = res.ok
        ? `The delegated work is DONE — do NOT redo it. ${profile_name}'s digest:\n\n` +
          `${res.digest}\n\n` +
          `Report the outcome to the user grounded in this digest — cite its ` +
          `specifics. If the digest includes a proposal/spec that was filed, say ` +
          `what happens next (your review, the owner's approval).`
        : `The delegated work FAILED. Error from the run:\n\n${res.error}\n\n` +
          `Tell the user honestly, and either re-delegate with a narrower task or ` +
          `say what you'll do instead. Do not pretend progress.`;
      db.prepare(
        `INSERT INTO scheduled_tasks
           (id, fire_at, intent, context_json, idempotency_key, max_attempts, attempts, status)
         VALUES (@id, @fire_at, 'deliver_followup', @ctx, @idem, 3, 0, 'pending')
         ON CONFLICT(idempotency_key) DO NOTHING`,
      ).run({
        '@id': followup_id,
        '@fire_at': new Date().toISOString(),
        '@ctx': JSON.stringify({
          method: 'POST',
          path: '/api/specialists/deliver-followup',
          body: {
            conversation_id: row.conversation_id,
            specialist_id: row.requested_by,
            summary: `report back on the work you handed to ${profile_name}: ${row.task.slice(0, 180)}`,
            scope,
            promised_at_iso: row.created_at,
            followup_id,
          },
        }),
        '@idem': `delegation-report:${row.id}`,
      });
    } catch {
      // Fail-open: the inbox FYI above already carries the digest; the
      // conversation report is the nicety, never the contract.
    }
  }

  private _audit(
    row: DelegationRow,
    tool_name: 'delegate_completed' | 'delegate_failed',
    execution_result: Record<string, unknown>,
  ): void {
    try {
      this.deps.memory.log_action({
        intent_id: ulid(),
        agent: row.requested_by,
        tool_name,
        tool_input: { delegation_id: row.id, profile_id: row.profile_id },
        execution_result,
        user_id: row.user_id ?? undefined,
      });
    } catch {
      // Audit is best-effort here; log_action itself is fail-open.
    }
  }

  private _framing(row: DelegationRow, requester_name: string): string {
    const context_block = row.context
      ? `\n## Context from ${requester_name}\n${row.context}\n`
      : '';
    return (
      `${requester_name} has delegated a task to you. Work it fully with your ` +
      `tools, then reply with ONE tight, self-contained digest of the outcome — ` +
      `your reply is handed back to ${requester_name} verbatim and is all they see.\n\n` +
      `## Task\n${row.task}\n${context_block}\n` +
      `## Digest requirements\n` +
      `- Lead with the answer/outcome, not your process.\n` +
      `- Include the load-bearing specifics you actually verified (names, numbers, ` +
      `dates) and say what you checked.\n` +
      `- If you could not complete the task, say exactly what is missing or what ` +
      `failed — never pad, never guess.\n` +
      `- Keep it under ~400 words.`
    );
  }
}
