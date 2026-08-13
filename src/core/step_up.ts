/**
 * StepUpStore — PIN as second factor for high-risk actions.
 *
 * Per the 2026-05-25 BACKEND_AUTH_BRIEF: PIN is step-up, not primary.
 * After authenticating via password OR bearer, the user POSTs to
 * /api/auth/step_up with their PIN to earn a short-lived grant; any
 * handler that calls requireStepUp() consumes that grant before
 * executing a high-risk action.
 *
 * Subject keying: a grant is bound to a specific session OR a specific
 * device, not to a user-id-at-large. If Jasper has the iOS app open
 * AND a browser tab logged in, stepping up in the browser doesn't
 * help him approve a $500 proposal from iOS — explicit > implicit.
 *
 *   subject = `session:<sess_id>`     for cookie-auth requests
 *   subject = `device:<dev_id>`       for bearer-auth requests
 *
 * TTL: 5 minutes from grant. Single-use: the first requireStepUp()
 * that finds an active grant marks it consumed; the user re-PINs for
 * the next high-risk action. Brief explicitly chose this shape.
 */
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';

const GRANT_TTL_MS = 5 * 60 * 1000;

export interface GrantRow {
  id: string;
  subject: string;
  user_id: string;
  granted_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export class StepUpStore {
  constructor(private db: Database) {}

  /** Issue a fresh grant against `subject`. Any previous unconsumed
   *  grant on the same subject is left alone — TTL handles it. */
  grant(subject: string, user_id: string): GrantRow {
    const now = Date.now();
    const row: GrantRow = {
      id: `grant_${ulid().toLowerCase()}`,
      subject,
      user_id,
      granted_at: new Date(now).toISOString(),
      expires_at: new Date(now + GRANT_TTL_MS).toISOString(),
      consumed_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO step_up_grants
           (id, subject, user_id, granted_at, expires_at, consumed_at)
         VALUES (@id, @subject, @user_id, @granted_at, @expires_at, NULL)`,
      )
      .run({
        '@id': row.id,
        '@subject': row.subject,
        '@user_id': row.user_id,
        '@granted_at': row.granted_at,
        '@expires_at': row.expires_at,
      });
    return row;
  }

  /**
   * Consume an active grant for `subject` — returns the row on
   * success, null when no active grant exists. Atomic via the UPDATE
   * ... WHERE consumed_at IS NULL clause so two concurrent high-risk
   * actions don't both pass on a single PIN entry. The first request
   * wins; the second sees no active grant and gets the step-up-required
   * response.
   */
  consume(subject: string): GrantRow | null {
    const active = this.find_active(subject);
    if (!active) return null;
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        `UPDATE step_up_grants
            SET consumed_at = @ts
          WHERE id = @id AND consumed_at IS NULL`,
      )
      .run({ '@ts': now, '@id': active.id });
    if (Number(res.changes) === 0) return null; // raced; lost
    return { ...active, consumed_at: now };
  }

  /** Read-only check: is there an active grant for `subject` right now?
   *  Doesn't consume. Used for diagnostic surfaces (e.g., a UI badge
   *  showing "step-up active — N min left"). The actual gate is
   *  consume() above. */
  find_active(subject: string): GrantRow | null {
    const now_iso = new Date().toISOString();
    const row = this.db
      .prepare(
        `SELECT * FROM step_up_grants
          WHERE subject = @subject
            AND consumed_at IS NULL
            AND expires_at > @now
          ORDER BY granted_at DESC
          LIMIT 1`,
      )
      .get({ '@subject': subject, '@now': now_iso }) as GrantRow | undefined;
    return row ?? null;
  }

  /** Sweep expired + consumed rows older than the TTL window. Cheap;
   *  run on a periodic timer (or at orchestrator boot). Keeps the
   *  table from growing indefinitely without losing audit-relevant
   *  recently-consumed rows. */
  prune(retention_hours = 24): number {
    const cutoff = new Date(Date.now() - retention_hours * 3_600_000).toISOString();
    const res = this.db
      .prepare(
        `DELETE FROM step_up_grants
          WHERE (consumed_at IS NOT NULL AND consumed_at < @cutoff)
             OR (consumed_at IS NULL AND expires_at < @cutoff)`,
      )
      .run({ '@cutoff': cutoff });
    return Number(res.changes);
  }
}

/**
 * Derive the step-up `subject` string from the auth method on a Hono
 * context. Handlers call this before calling StepUpStore.consume() so
 * the same subject convention is used everywhere — bearer auth maps
 * to the device, cookie auth maps to the session.
 *
 * Returns null when neither auth state is present (which means the
 * caller is unauthenticated; auth middleware will have already 401'd
 * before any handler that calls requireStepUp can run).
 */
export function subject_from_ctx(ctx: {
  session_id?: string;
  device_id?: string;
}): string | null {
  if (ctx.device_id) return `device:${ctx.device_id}`;
  if (ctx.session_id) return `session:${ctx.session_id}`;
  return null;
}

/**
 * Handler-side gate per the brief's `requireStepUp()`. Consumes an
 * active grant for the caller's subject; returns `{ ok: true }` on
 * success or a structured `{ ok: false, response: ... }` the handler
 * should return directly (403 with the standard payload shape).
 *
 * The iOS client (and any future native consumer) recognizes the 403
 * shape and prompts for the PIN, POSTs to /api/auth/step_up, then
 * retries the original request. The PWA path doesn't reach this
 * helper today — it's cookie-only and not on the high-risk surface
 * the brief scoped for day-1.
 */
export interface RequireStepUpDeps {
  step_up: StepUpStore;
}

export interface RequireStepUpResult {
  ok: boolean;
  /** When !ok, the response body the caller should return with HTTP 403. */
  response?: { error: 'step_up_required'; endpoint: '/api/auth/step_up' };
}

export function require_step_up(
  deps: RequireStepUpDeps,
  ctx: { session_id?: string; device_id?: string },
): RequireStepUpResult {
  const subject = subject_from_ctx(ctx);
  if (!subject) {
    return {
      ok: false,
      response: { error: 'step_up_required', endpoint: '/api/auth/step_up' },
    };
  }
  const grant = deps.step_up.consume(subject);
  if (!grant) {
    return {
      ok: false,
      response: { error: 'step_up_required', endpoint: '/api/auth/step_up' },
    };
  }
  return { ok: true };
}
