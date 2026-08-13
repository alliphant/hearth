/**
 * In-orchestrator scheduled-tasks tick — fires scheduled HTTP requests
 * against the orchestrator on a 60s cadence.
 *
 * This is the former standalone `apps/scheduler` process folded into the
 * orchestrator (Hearth 2.0 P0, 2026-07-06): same `scheduled_tasks` table,
 * same atomic pending→firing CAS claim, same backoff/audit semantics — one
 * fewer process on the box. The CAS makes the cutover safe: if the old
 * container and this tick briefly overlap, only one claims each task.
 *
 * Live consumers of the table today:
 *   - `promise_followup` delivery rows (src/core/followups.ts) — arbitrary
 *     future fire times; the reason this mechanism must survive.
 *   - the nightly golden-eval run (`POST /api/evals/run` at 03:15 local).
 *
 * The nightly-eval seeding is SELF-RESEEDING here (`seed_recurring`): every
 * cycle upserts idempotent `nightly-evals-<date>` rows for today + tomorrow.
 * The old pattern (scripts/schedule-nightly-evals.ts seeding 30 days, a
 * human re-running it) was 2 days from silently running dry when this
 * landed — that failure class is closed, and the seeder script is gone.
 *
 * NOT started under HEARTH_DISABLE_LOOPS=1 (smokes/dev) — wired next to
 * loop_driver.start() in apps/orchestrator/server.ts. The first cycle is
 * DELAYED one poll interval so the HTTP server is listening before any
 * self-fetch (an immediate boot-time cycle would burn a task attempt on
 * connection-refused).
 */

import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import type { MemoryClient } from '@memory/client';

const SCHEDULER_UA = 'hearth-scheduler/0.2-intick';

/**
 * Outbound headers for a scheduled fire. Extracted + exported so the auth
 * policy is unit-testable without the interval/db/fetch machinery.
 *
 * The scheduler fires against its OWN orchestrator, which sits behind the auth
 * wall (`auth_middleware` resolves a Bearer via `DeviceStore.find_by_token`).
 * So it must authenticate like every other internal caller —
 * `HEARTH_INTERNAL_BEARER`, the same DeviceStore-backed service token the
 * weather / air-quality / house-anomaly internal posts already use. Without it
 * every fire 401'd silently: the golden evals + promise-followup delivery ran
 * dead ~55 days (first 401 2026-05-26). A task's own `ctx.headers` still win
 * (spread last), so a task can override the principal deliberately.
 */
export function build_scheduler_fire_headers(
  task_id: string,
  ctx_headers: Record<string, string> | undefined,
  internal_bearer: string | undefined,
): Record<string, string> {
  if (!internal_bearer) {
    console.error(
      '[scheduler-tick] HEARTH_INTERNAL_BEARER is unset — fires will 401 ' +
        'against the authenticated orchestrator; mint one via ' +
        'scripts/mint-service-bearer.ts and set it in the compose env.',
    );
  }
  return {
    'User-Agent': SCHEDULER_UA,
    'X-Scheduler-Fire': task_id,
    ...(internal_bearer ? { Authorization: `Bearer ${internal_bearer}` } : {}),
    ...(ctx_headers ?? {}),
  };
}

interface TaskRow {
  id: string;
  fire_at: string;
  intent: string;
  context_json: string;
  idempotency_key: string;
  max_attempts: number;
  attempts: number;
  status: string;
}

interface TaskContext {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ScheduledTasksTickDeps {
  db: Database;
  memory: MemoryClient;
  /** Base URL the stored requests fire against. Defaults to the local
   *  orchestrator (self). */
  base_url?: string;
  poll_ms?: number;
  /** Local hour for the nightly eval seed (default 3 → 03:15). */
  eval_hour_local?: number;
}

function parse_endpoint(raw: unknown): TaskContext | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const method = typeof obj.method === 'string' ? obj.method.toUpperCase() : 'GET';
  if (method !== 'GET' && method !== 'POST') return null;
  if (typeof obj.path !== 'string') return null;
  return {
    method,
    path: obj.path,
    body: obj.body,
    headers: (obj.headers as Record<string, string>) ?? undefined,
  };
}

export function start_scheduled_tasks_tick(deps: ScheduledTasksTickDeps): {
  stop: () => void;
} {
  const db = deps.db;
  const memory = deps.memory;
  const base = (deps.base_url ?? process.env.HEARTH_BASE_URL ?? 'http://localhost:7700').replace(
    /\/+$/,
    '',
  );
  const poll_ms = deps.poll_ms ?? parseInt(process.env.HEARTH_SCHEDULER_POLL_MS ?? '60000', 10);
  const eval_hour = deps.eval_hour_local ?? parseInt(process.env.HEARTH_EVAL_HOUR_LOCAL ?? '3', 10);

  function try_claim(id: string): boolean {
    const result = db
      .prepare(
        `UPDATE scheduled_tasks
         SET status = 'firing'
         WHERE id = @id AND status = 'pending'`,
      )
      .run({ '@id': id });
    return (result.changes ?? 0) > 0;
  }

  function mark_fired(id: string): void {
    db.prepare(`UPDATE scheduled_tasks SET status='fired' WHERE id=@id`).run({ '@id': id });
  }

  function mark_failed(id: string, attempts: number): void {
    db.prepare(
      `UPDATE scheduled_tasks SET status='failed', attempts=@attempts WHERE id=@id`,
    ).run({ '@id': id, '@attempts': attempts });
  }

  function reschedule_backoff(id: string, attempts: number): string {
    // Exponential: 2^attempts minutes. Cap at 60 minutes.
    const minutes = Math.min(60, Math.pow(2, attempts));
    const next = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    db.prepare(
      `UPDATE scheduled_tasks
       SET status='pending', attempts=@attempts, fire_at=@fire_at
       WHERE id=@id`,
    ).run({ '@id': id, '@attempts': attempts, '@fire_at': next });
    return next;
  }

  /**
   * Idempotent recurring seeds — today + tomorrow's nightly-eval rows.
   * Keys collapse on `nightly-evals-<date>` (UNIQUE), so re-running every
   * cycle inserts at most one row per day, and a fired/failed day is never
   * re-inserted (the key survives on the terminal row).
   */
  const seed_stmt = db.prepare(
    `INSERT INTO scheduled_tasks
       (id, fire_at, intent, context_json, idempotency_key, max_attempts, attempts, status)
     VALUES (@id, @fire_at, @intent, @ctx, @idem, 2, 0, 'pending')
     ON CONFLICT(idempotency_key) DO NOTHING`,
  );
  function seed_recurring(): void {
    for (let i = 0; i < 2; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      d.setHours(eval_hour, 15, 0, 0); // time-guard-ok: host-clock slot seed — correct under TZ=America/Denver container, same rationale as the loops.ts background-job slots
      if (d.getTime() <= Date.now()) continue;
      const date_str = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; // time-guard-ok: idempotency-key date component off the same host clock as the slot above
      seed_stmt.run({
        '@id': `sch_${ulid().toLowerCase().slice(-12)}`,
        '@fire_at': d.toISOString(),
        '@intent': 'nightly behavioral eval suite (golden tasks)',
        '@ctx': JSON.stringify({ method: 'POST', path: '/api/evals/run', body: {} }),
        '@idem': `nightly-evals-${date_str}`,
      });
    }
  }

  async function fire_task(task: TaskRow): Promise<void> {
    if (!try_claim(task.id)) return; // another tick/process won the claim

    const intent_id = `sched:${task.id}`;
    let ctx: TaskContext | null;
    try {
      ctx = parse_endpoint(JSON.parse(task.context_json));
    } catch {
      ctx = null;
    }
    if (!ctx) {
      mark_failed(task.id, task.attempts + 1);
      memory.log_action({
        intent_id,
        agent: 'orchestrator',
        tool_name: 'scheduler_fire',
        tool_input: { task_id: task.id, intent: task.intent },
        error: `unparseable context_json: ${task.context_json.slice(0, 200)}`,
      });
      return;
    }

    const url = `${base}${ctx.path}`;
    let ok = false;
    let status = 0;
    let body_preview = '';
    let err_message: string | undefined;

    try {
      const headers = build_scheduler_fire_headers(
        task.id,
        ctx.headers,
        process.env.HEARTH_INTERNAL_BEARER,
      );
      const init: RequestInit = { method: ctx.method, headers };
      if (ctx.method === 'POST' && ctx.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(ctx.body);
      }
      const resp = await fetch(url, init);
      status = resp.status;
      body_preview = (await resp.text()).slice(0, 240);
      ok = resp.ok;
    } catch (err) {
      err_message = err instanceof Error ? err.message : String(err);
    }

    if (ok) {
      mark_fired(task.id);
      memory.log_action({
        intent_id,
        agent: 'orchestrator',
        tool_name: 'scheduler_fire',
        tool_input: { task_id: task.id, intent: task.intent, method: ctx.method, path: ctx.path },
        execution_result: { status, body_preview },
      });
      return;
    }

    const next_attempts = task.attempts + 1;
    const reason = err_message ?? `HTTP ${status}: ${body_preview}`;
    if (next_attempts >= task.max_attempts) {
      mark_failed(task.id, next_attempts);
      // Retry exhaustion previously wrote only an audit row nobody watches —
      // which is exactly how the 401 outage ran ~55 days unnoticed. Surface it
      // to the container log too so a recurring failure is greppable/alertable.
      console.error(
        `[scheduler-tick] task ${task.id} (${task.intent}) gave up after ` +
          `${next_attempts} attempt(s): ${reason}`,
      );
      memory.log_action({
        intent_id,
        agent: 'orchestrator',
        tool_name: 'scheduler_fire',
        tool_input: { task_id: task.id, intent: task.intent },
        error: `gave up after ${next_attempts} attempt(s): ${reason}`,
      });
    } else {
      const next = reschedule_backoff(task.id, next_attempts);
      memory.log_action({
        intent_id,
        agent: 'orchestrator',
        tool_name: 'scheduler_fire',
        tool_input: { task_id: task.id, intent: task.intent },
        execution_result: { retry: true, attempt: next_attempts, next_fire_at: next },
        error: reason,
      });
    }
  }

  async function cycle(): Promise<void> {
    seed_recurring();
    const now_iso = new Date().toISOString();
    const due = db
      .prepare(
        `SELECT id, fire_at, intent, context_json, idempotency_key,
                max_attempts, attempts, status
         FROM scheduled_tasks
         WHERE status = 'pending' AND fire_at <= @now
         ORDER BY fire_at ASC
         LIMIT 50`,
      )
      .all({ '@now': now_iso }) as TaskRow[];

    for (const task of due) {
      try {
        await fire_task(task);
      } catch (err) {
        console.error(
          `[scheduler-tick] task ${task.id} threw:`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }

  // No immediate cycle — the server may not be listening yet at boot; the
  // first pass runs one poll interval in. Due tasks tolerate 60s.
  const handle = setInterval(() => {
    void cycle().catch((err) => {
      console.error('[scheduler-tick] cycle failed:', err);
    });
  }, poll_ms);

  console.log(`[scheduler-tick] started (poll ${poll_ms}ms, base ${base})`);
  return {
    stop: () => clearInterval(handle),
  };
}
