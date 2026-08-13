/**
 * /api/auth/* — multi-user web authentication.
 *
 *   POST /api/auth/verify_pin   { user_id, pin_sha256 }
 *     Verifies the PIN hash against users.yaml; on success creates a
 *     session, Set-Cookie's hearth_sid, returns the user profile.
 *     Rate-limited per user_id (5 attempts / 15 min) — survives
 *     orchestrator restarts via kv_settings persistence.
 *
 *   POST /api/auth/logout
 *     Revokes the current session row, clears the cookie.
 *
 *   GET /api/auth/me
 *     Returns the current authenticated user, or 401 if no session.
 *     Used by the client shell to decide whether to redirect to login.
 *
 *   GET /api/auth/users
 *     The roster for the login tile screen — id, display_name,
 *     has_pin, theme, role. Public (no session required) — same
 *     threat model as FRIDAY's tile picker. Strips pin_hash.
 *
 * Cookie shape:
 *   Set-Cookie: hearth_sid=<sess_xxxxx>; Path=/; HttpOnly; SameSite=Lax;
 *               Max-Age=2592000
 *   (Secure flag added when SERVE_HTTPS=1 — local mkcert proxy.)
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Context } from 'hono';
import type { UserRegistry } from '@core/users';
import type { SessionStore } from '@core/sessions';
import type { DeviceStore } from '@core/devices';
import type { StepUpStore } from '@core/step_up';
import { subject_from_ctx } from '@core/step_up';
import {
  verify_apple_identity_token,
  apple_sso_configured,
  apple_audiences,
} from '@core/apple_identity';
import type { MemoryClient } from '@memory/client';
import { ulid } from 'ulid';

export interface AuthRoutesDeps {
  users: UserRegistry;
  sessions: SessionStore;
  /** 2026-05-25 BACKEND_AUTH_BRIEF additions. Optional so the auth
   *  router still mounts cleanly in legacy / smoke wirings. */
  devices?: DeviceStore;
  step_up?: StepUpStore;
  memory?: MemoryClient;
}

/** Helper: write an audit_log row for an auth-surface event. Falls
 *  silently silent when no memory dep is wired (test fixtures), so
 *  routes don't need to null-check at every call site. */
function _audit_auth(
  deps: AuthRoutesDeps,
  c: Context,
  tool_name: string,
  detail: Record<string, unknown>,
  user_id?: string,
): void {
  if (!deps.memory) return;
  try {
    deps.memory.log_action({
      intent_id: ulid(),
      agent: 'auth',
      tool_name,
      tool_input: {
        ...detail,
        ip: c.req.header('x-real-ip') ?? c.req.header('x-forwarded-for') ?? null,
        ua: c.req.header('user-agent') ?? null,
      },
      ...(user_id ? { user_id } : {}),
    } as Parameters<MemoryClient['log_action']>[0]);
  } catch {
    /* audit must not break the auth path */
  }
}

export const SESSION_COOKIE = 'hearth_sid';
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60; // 30 days

function _is_secure_env(): boolean {
  return process.env.SERVE_HTTPS === '1';
}

function _set_session_cookie(c: Context, session_id: string): void {
  const attrs = [
    `${SESSION_COOKIE}=${session_id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${COOKIE_MAX_AGE_S}`,
  ];
  if (_is_secure_env()) attrs.push('Secure');
  c.header('Set-Cookie', attrs.join('; '));
}

function _clear_session_cookie(c: Context): void {
  const attrs = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (_is_secure_env()) attrs.push('Secure');
  c.header('Set-Cookie', attrs.join('; '));
}

/** Lift the session id out of the Cookie header. */
export function get_session_cookie(c: Context): string | null {
  const header = c.req.header('cookie') || '';
  // Single-value match — cookies are k=v; k2=v2.
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE) return rest.join('=') || null;
  }
  return null;
}

/** Lift the bearer token out of the Authorization header. Returns null
 *  when missing or doesn't match `Bearer <token>` (case-insensitive). */
function _get_bearer(c: Context): string | null {
  const h = c.req.header('authorization') || c.req.header('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? (m[1]?.trim() || null) : null;
}

/**
 * Self-gate for /auth/* endpoints that require authentication —
 * /api/auth is in the middleware's public-prefix list (so /auth/login
 * itself can run without auth), so handlers below that need a caller
 * resolve them inline here. Accepts cookie OR bearer, mirrors what the
 * middleware does for non-auth routes.
 *
 * Returns the user + the auth subject pieces the handler needs to file
 * audit rows / consume step-up grants, or null when no valid credential
 * was presented. Touches sliding-session expiry on cookie hits; touches
 * device last_seen_at on bearer hits.
 */
interface ResolvedCaller {
  user: import('@core/users').UserConfig;
  session_id?: string;
  device_id?: string;
  auth_method: 'cookie' | 'bearer';
}

async function _resolve_caller(
  c: Context,
  deps: AuthRoutesDeps,
): Promise<ResolvedCaller | null> {
  // Bearer first per "newer request shape wins" (brief).
  const bearer = _get_bearer(c);
  if (bearer && deps.devices) {
    const dev = await deps.devices.find_by_token(bearer);
    if (dev) {
      const u = deps.users.get(dev.user_id);
      if (u) {
        deps.devices.touch(dev.id);
        return { user: u, device_id: dev.id, auth_method: 'bearer' };
      }
    }
  }
  const sid = get_session_cookie(c);
  if (sid) {
    const session = deps.sessions.get(sid);
    if (session) {
      const u = deps.users.get(session.user_id);
      if (u) {
        deps.sessions.touch(sid);
        return { user: u, session_id: sid, auth_method: 'cookie' };
      }
    }
  }
  return null;
}

const VerifyPinSchema = z.object({
  user_id: z.string().min(1).max(64),
  pin_sha256: z.string().regex(/^[a-f0-9]{64}$/, 'expected lowercase hex SHA-256'),
});

const LoginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1024),
});

const RegisterDeviceSchema = z.object({
  device_name: z.string().min(1).max(120),
});

const StepUpSchema = z.object({
  pin_sha256: z.string().regex(/^[a-f0-9]{64}$/, 'expected lowercase hex SHA-256'),
});

const ChangePasswordSchema = z.object({
  /** Required for rotation; omitted/ignored in bootstrap mode
   *  (must_change_password=true) since the user hasn't authenticated
   *  with a "real" password yet — admin-issued initial password
   *  authed the session that's now setting their own. */
  current_password: z.string().min(1).max(1024).optional(),
  new_password: z.string().min(10, 'new_password must be at least 10 characters').max(1024),
});

const SetPinSchema = z.object({
  pin_sha256: z.string().regex(/^[a-f0-9]{64}$/, 'expected lowercase hex SHA-256'),
});

const AppleAuthSchema = z.object({
  /** The AuthenticationServices identity token (a signed JWT). */
  identity_token: z.string().min(1).max(8192),
  /** Raw nonce the client generated; when present we verify
   *  sha256(raw_nonce) === the token's `nonce` claim (replay defense). */
  raw_nonce: z.string().min(1).max(256).optional(),
});

export function create_auth_router(deps: AuthRoutesDeps): Hono {
  const r = new Hono();

  r.get('/auth/users', (c) => {
    return c.json({ users: deps.users.list_for_login() });
  });

  r.post('/auth/verify_pin', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); }
    catch (err) { return c.json({ error: `invalid JSON: ${(err as Error).message}` }, 400); }
    const parsed = VerifyPinSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const result = deps.users.verify_pin(parsed.data.user_id, parsed.data.pin_sha256);
    if (!result.ok) {
      if (result.reason === 'rate_limited') {
        c.header('Retry-After', String(result.retry_after_seconds || 60));
        return c.json(
          { error: 'too many failed attempts; try again later',
            retry_after_seconds: result.retry_after_seconds },
          429,
        );
      }
      // Constant-time-ish: don't leak whether the user_id or the PIN was wrong.
      return c.json({ error: 'invalid PIN' }, 401);
    }

    const session = deps.sessions.create({
      user_id: result.user.id,
      ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || null,
      ua: c.req.header('user-agent') || null,
    });
    _set_session_cookie(c, session.id);

    return c.json({
      user: {
        id: result.user.id,
        display_name: result.user.display_name,
        theme: result.user.theme,
        role: result.user.role,
        allowed_specialists: result.user.allowed_specialists,
      },
      session_expires_at: session.expires_at,
    });
  });

  // ── POST /auth/login (email + password) ──────────────────────────────
  // 2026-05-25 BACKEND_AUTH_BRIEF. Sets the same cookie shape
  // /auth/verify_pin sets so /auth/me + downstream cookie-only callers
  // don't need to change. iOS clients hit this first, then immediately
  // call /auth/register_device for a long-lived bearer.
  r.post('/auth/login', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); }
    catch (err) { return c.json({ error: `invalid JSON: ${(err as Error).message}` }, 400); }
    const parsed = LoginSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const result = await deps.users.verify_password(parsed.data.email, parsed.data.password);
    if (!result.ok) {
      _audit_auth(deps, c, 'auth_login_failed', {
        email_hash: _short_hash(parsed.data.email),
      });
      // Single message regardless of which case — don't leak whether
      // the email exists or the password was wrong.
      return c.json({ error: 'invalid credentials' }, 401);
    }

    const session = deps.sessions.create({
      user_id: result.user.id,
      ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || null,
      ua: c.req.header('user-agent') || null,
    });
    _set_session_cookie(c, session.id);
    _audit_auth(
      deps,
      c,
      'auth_login_succeeded',
      { session_id: session.id },
      result.user.id,
    );

    return c.json({
      user: {
        id: result.user.id,
        display_name: result.user.display_name,
        theme: result.user.theme,
        role: result.user.role,
        allowed_specialists: result.user.allowed_specialists,
      },
      session_expires_at: session.expires_at,
      bootstrap: {
        must_change_password: result.user.must_change_password,
        must_set_pin: result.user.must_set_pin,
      },
    });
  });

  // ── POST /auth/apple (Sign in with Apple — unauthenticated login) ────
  // Native iOS/macOS posts the AuthenticationServices identity token. We
  // verify it server-side (JWKS sig + iss + aud + exp + optional nonce),
  // then resolve the account by the Apple `sub`:
  //   • linked sub  → issue a session, exactly like /auth/login.
  //   • not linked, but the token's VERIFIED, NON-private email exactly
  //     matches a provisioned account with no Apple link yet → auto-link
  //     + session. (A @privaterelay address never matches — by design.)
  //   • otherwise   → 409. Apple cannot CREATE an account; it only
  //     authenticates one a human already provisioned + linked.
  r.post('/auth/apple', async (c) => {
    if (!apple_sso_configured()) {
      return c.json({ error: 'Apple sign-in is not configured' }, 503);
    }
    let body: unknown;
    try { body = await c.req.json(); }
    catch (err) { return c.json({ error: `invalid JSON: ${(err as Error).message}` }, 400); }
    const parsed = AppleAuthSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const v = await verify_apple_identity_token(parsed.data.identity_token, {
      audiences: apple_audiences(),
      raw_nonce: parsed.data.raw_nonce,
    });
    if (!v.ok) {
      _audit_auth(deps, c, 'auth_apple_login_failed', { reason: v.reason });
      return c.json({ error: 'invalid Apple token' }, 401);
    }

    let user = deps.users.resolve_by_apple_sub(v.identity.sub);
    let linked: 'existing' | 'auto' | null = user ? 'existing' : null;

    // Auto-link: exact match on a VERIFIED, NON-private email to a
    // provisioned account not already bound to a different Apple ID.
    if (!user && v.identity.email && v.identity.email_verified && !v.identity.is_private_email) {
      const candidate = deps.users.resolve_by_email(v.identity.email);
      if (candidate && !candidate.apple_sub) {
        user = deps.users.update_user(candidate.id, { apple_sub: v.identity.sub });
        linked = 'auto';
        _audit_auth(
          deps,
          c,
          'auth_apple_autolinked',
          { email_hash: _short_hash(v.identity.email), sub_hint: v.identity.sub.slice(0, 8) },
          candidate.id,
        );
      }
    }

    if (!user) {
      _audit_auth(deps, c, 'auth_apple_no_account', { sub_hint: v.identity.sub.slice(0, 8) });
      return c.json(
        {
          error:
            'No Hearth account is linked to this Apple ID. Sign in with your password, then connect Apple in Settings.',
          code: 'no_linked_account',
        },
        409,
      );
    }

    const session = deps.sessions.create({
      user_id: user.id,
      ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || null,
      ua: c.req.header('user-agent') || null,
    });
    _set_session_cookie(c, session.id);
    _audit_auth(deps, c, 'auth_apple_login_succeeded', { session_id: session.id, linked }, user.id);

    return c.json({
      user: {
        id: user.id,
        display_name: user.display_name,
        theme: user.theme,
        role: user.role,
        allowed_specialists: user.allowed_specialists,
      },
      session_expires_at: session.expires_at,
      linked,
      bootstrap: {
        must_change_password: user.must_change_password,
        must_set_pin: user.must_set_pin,
      },
    });
  });

  // ── POST /auth/apple/link (authenticated — "Connect Apple" in Settings) ─
  // The primary, most-explicit link path: a user proven by an existing
  // session binds their Apple `sub` to their OWN account. Refuses a sub
  // already linked elsewhere (one Apple ID → one account).
  r.post('/auth/apple/link', async (c) => {
    if (!apple_sso_configured()) {
      return c.json({ error: 'Apple sign-in is not configured' }, 503);
    }
    const caller = await _resolve_caller(c, deps);
    if (!caller) return c.json({ error: 'authentication required' }, 401);

    let body: unknown;
    try { body = await c.req.json(); }
    catch (err) { return c.json({ error: `invalid JSON: ${(err as Error).message}` }, 400); }
    const parsed = AppleAuthSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const v = await verify_apple_identity_token(parsed.data.identity_token, {
      audiences: apple_audiences(),
      raw_nonce: parsed.data.raw_nonce,
    });
    if (!v.ok) {
      _audit_auth(deps, c, 'auth_apple_link_failed', { reason: v.reason }, caller.user.id);
      return c.json({ error: 'invalid Apple token' }, 401);
    }

    const existing = deps.users.resolve_by_apple_sub(v.identity.sub);
    if (existing && existing.id !== caller.user.id) {
      _audit_auth(
        deps,
        c,
        'auth_apple_link_conflict',
        { sub_hint: v.identity.sub.slice(0, 8) },
        caller.user.id,
      );
      return c.json(
        { error: 'This Apple ID is already linked to another account.', code: 'sub_in_use' },
        409,
      );
    }

    deps.users.update_user(caller.user.id, { apple_sub: v.identity.sub });
    _audit_auth(deps, c, 'auth_apple_linked', { sub_hint: v.identity.sub.slice(0, 8) }, caller.user.id);
    return c.json({ ok: true, linked: true });
  });

  // ── DELETE /auth/apple/link (authenticated — disconnect Apple) ───────
  r.delete('/auth/apple/link', async (c) => {
    const caller = await _resolve_caller(c, deps);
    if (!caller) return c.json({ error: 'authentication required' }, 401);
    deps.users.update_user(caller.user.id, { apple_sub: null });
    _audit_auth(deps, c, 'auth_apple_unlinked', {}, caller.user.id);
    return c.json({ ok: true, linked: false });
  });

  // ── POST /auth/register_device (cookie-auth → issue bearer) ──────────
  // Brief requires this run AFTER /auth/login in the same request flow
  // (so the freshly-set cookie auths the call). The plaintext token is
  // returned exactly once — the iOS app stores it in Keychain with
  // biometric access control and uses Authorization: Bearer on every
  // subsequent request.
  r.post('/auth/register_device', async (c) => {
    if (!deps.devices) {
      return c.json({ error: 'devices store not wired in this build' }, 500);
    }
    const caller = await _resolve_caller(c, deps);
    if (!caller) return c.json({ error: 'authentication required' }, 401);

    let body: unknown;
    try { body = await c.req.json(); }
    catch (err) { return c.json({ error: `invalid JSON: ${(err as Error).message}` }, 400); }
    const parsed = RegisterDeviceSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const issued = await deps.devices.create({
      user_id: caller.user.id,
      name: parsed.data.device_name,
    });
    _audit_auth(
      deps,
      c,
      'auth_device_registered',
      { device_id: issued.device_id, device_name: parsed.data.device_name },
      caller.user.id,
    );
    // The brief is explicit: token shown ONCE in the response, never
    // logged. The audit payload above carries device_id only.
    return c.json(issued);
  });

  // ── GET /auth/devices (list user's active devices) ───────────────────
  r.get('/auth/devices', async (c) => {
    if (!deps.devices) return c.json({ devices: [] });
    const caller = await _resolve_caller(c, deps);
    if (!caller) return c.json({ error: 'authentication required' }, 401);
    const devices = deps.devices.list_for_user(
      caller.user.id,
      caller.device_id ?? null,
    );
    return c.json({ devices });
  });

  // ── DELETE /auth/devices/:id (revoke) ────────────────────────────────
  r.delete('/auth/devices/:id', async (c) => {
    if (!deps.devices) {
      return c.json({ error: 'devices store not wired in this build' }, 500);
    }
    const caller = await _resolve_caller(c, deps);
    if (!caller) return c.json({ error: 'authentication required' }, 401);
    const dev_id = c.req.param('id');
    const dev = deps.devices.get(dev_id);
    if (!dev || dev.user_id !== caller.user.id) {
      // Don't leak existence — same 404 for "doesn't exist" and "not yours".
      return c.json({ error: 'device not found' }, 404);
    }
    const ok = deps.devices.revoke(dev_id);
    _audit_auth(
      deps,
      c,
      'auth_device_revoked',
      { device_id: dev_id, was_active: ok },
      caller.user.id,
    );
    return c.json({ ok: true });
  });

  // ── POST /auth/step_up (PIN as second factor) ────────────────────────
  r.post('/auth/step_up', async (c) => {
    if (!deps.step_up) {
      return c.json({ error: 'step-up store not wired in this build' }, 500);
    }
    const caller = await _resolve_caller(c, deps);
    if (!caller) return c.json({ error: 'authentication required' }, 401);

    let body: unknown;
    try { body = await c.req.json(); }
    catch (err) { return c.json({ error: `invalid JSON: ${(err as Error).message}` }, 400); }
    const parsed = StepUpSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    // Reuse the existing rate-limited PIN verify path — same window,
    // same lockout semantics. Step-up doesn't get its own counter
    // (would split the rate limit and let an attacker burn 5+5 = 10
    // attempts per 15 min).
    const verify = deps.users.verify_pin(caller.user.id, parsed.data.pin_sha256);
    if (!verify.ok) {
      if (verify.reason === 'rate_limited') {
        c.header('Retry-After', String(verify.retry_after_seconds || 60));
        _audit_auth(
          deps,
          c,
          'auth_step_up_rate_limited',
          { retry_after_seconds: verify.retry_after_seconds },
          caller.user.id,
        );
        return c.json(
          { error: 'too many failed PIN attempts; try again later',
            retry_after_seconds: verify.retry_after_seconds },
          429,
        );
      }
      _audit_auth(deps, c, 'auth_step_up_denied', { reason: 'wrong_pin' }, caller.user.id);
      return c.json({ error: 'wrong pin' }, 401);
    }

    const subject = subject_from_ctx({
      session_id: caller.session_id,
      device_id: caller.device_id,
    });
    if (!subject) {
      // Should be unreachable — _resolve_caller sets one or the other.
      return c.json({ error: 'no auth subject for step-up' }, 500);
    }
    const grant = deps.step_up.grant(subject, caller.user.id);
    _audit_auth(
      deps,
      c,
      'auth_step_up_granted',
      { subject, grant_id: grant.id, expires_at: grant.expires_at },
      caller.user.id,
    );
    return c.json({ grant_expires_at: grant.expires_at });
  });

  // ── POST /auth/change_password (rotation OR bootstrap) ───────────────
  // Bootstrap mode: user.must_change_password is true (admin issued an
  // initial password). current_password is not required because admin
  // gave it; the freshly-authed session is the proof. After success,
  // the flag clears and rotation rules apply.
  // Rotation mode: current_password REQUIRED + verified against the
  // stored hash. Prevents an attacker who hijacks an already-authed
  // session from silently swapping the password.
  r.post('/auth/change_password', async (c) => {
    const caller = await _resolve_caller(c, deps);
    if (!caller) return c.json({ error: 'authentication required' }, 401);

    let body: unknown;
    try { body = await c.req.json(); }
    catch (err) { return c.json({ error: `invalid JSON: ${(err as Error).message}` }, 400); }
    const parsed = ChangePasswordSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const is_bootstrap = caller.user.must_change_password === true;
    if (!is_bootstrap) {
      // Rotation mode — current_password REQUIRED + verified.
      if (!parsed.data.current_password || !caller.user.email) {
        return c.json(
          { error: 'current_password is required to rotate' },
          400,
        );
      }
      const check = await deps.users.verify_password(
        caller.user.email,
        parsed.data.current_password,
      );
      if (!check.ok || check.user.id !== caller.user.id) {
        _audit_auth(
          deps,
          c,
          'auth_change_password_denied',
          { reason: 'current_password_mismatch' },
          caller.user.id,
        );
        return c.json({ error: 'current password is incorrect' }, 401);
      }
    }

    const new_hash = await Bun.password.hash(parsed.data.new_password, {
      algorithm: 'argon2id',
      memoryCost: 65536,
      timeCost: 3,
    });
    deps.users.update_user(caller.user.id, {
      password_hash: new_hash,
      ...(is_bootstrap ? { must_change_password: false } : {}),
    });
    _audit_auth(
      deps,
      c,
      'auth_password_changed',
      { mode: is_bootstrap ? 'bootstrap' : 'rotation' },
      caller.user.id,
    );
    return c.json({ ok: true, mode: is_bootstrap ? 'bootstrap' : 'rotation' });
  });

  // ── POST /auth/set_pin (rotation OR bootstrap) ───────────────────────
  // Bootstrap mode: user.must_set_pin is true (admin marked the new
  // account as PIN-required). No step-up required; this IS the first
  // PIN. Sets pin_hash + clears must_set_pin.
  // Rotation mode: must have an active step-up grant (i.e. user
  // already POSTed /auth/step_up with their CURRENT PIN within 5 min).
  // The grant is consumed by this call.
  r.post('/auth/set_pin', async (c) => {
    const caller = await _resolve_caller(c, deps);
    if (!caller) return c.json({ error: 'authentication required' }, 401);

    let body: unknown;
    try { body = await c.req.json(); }
    catch (err) { return c.json({ error: `invalid JSON: ${(err as Error).message}` }, 400); }
    const parsed = SetPinSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const is_bootstrap = caller.user.must_set_pin === true;
    if (!is_bootstrap) {
      // Rotation mode — require an active step-up grant on the caller's
      // subject (which was earned by POSTing the OLD PIN). Same grant
      // semantics as the proposals/decide gate. Without step_up store
      // wired, refuse politely.
      if (!deps.step_up) {
        return c.json(
          { error: 'step-up not wired; cannot rotate PIN this build' },
          500,
        );
      }
      const { require_step_up } = await import('@core/step_up');
      const gate = require_step_up(
        { step_up: deps.step_up },
        { session_id: caller.session_id, device_id: caller.device_id },
      );
      if (!gate.ok) {
        _audit_auth(
          deps,
          c,
          'auth_set_pin_step_up_required',
          { mode: 'rotation' },
          caller.user.id,
        );
        return c.json(gate.response, 403);
      }
    }

    deps.users.update_user(caller.user.id, {
      pin_hash: parsed.data.pin_sha256,
      ...(is_bootstrap ? { must_set_pin: false } : {}),
    });
    _audit_auth(
      deps,
      c,
      'auth_pin_set',
      { mode: is_bootstrap ? 'bootstrap' : 'rotation' },
      caller.user.id,
    );
    return c.json({ ok: true, mode: is_bootstrap ? 'bootstrap' : 'rotation' });
  });

  // ── POST /auth/logout (cookie OR bearer) ─────────────────────────────
  r.post('/auth/logout', async (c) => {
    // Resolve before revoking so we have the caller for audit. May be
    // null when the caller is already unauthenticated — still clear the
    // cookie + return ok so the client can treat the call as idempotent.
    const caller = await _resolve_caller(c, deps);
    const sid = get_session_cookie(c);
    if (sid) deps.sessions.revoke(sid);
    if (caller?.device_id && deps.devices) deps.devices.revoke(caller.device_id);
    _clear_session_cookie(c);
    _audit_auth(
      deps,
      c,
      'auth_logout',
      { session_revoked: !!sid, device_revoked: !!caller?.device_id },
      caller?.user.id,
    );
    return c.json({ ok: true });
  });

  r.get('/auth/me', async (c) => {
    const caller = await _resolve_caller(c, deps);
    if (!caller) return c.json({ error: 'not authenticated' }, 401);
    // Cookie callers want the session expiry; bearer callers don't have
    // one (devices are long-lived) — omit cleanly for them.
    const session =
      caller.session_id ? deps.sessions.get(caller.session_id) : null;
    return c.json({
      user: {
        id: caller.user.id,
        display_name: caller.user.display_name,
        theme: caller.user.theme,
        role: caller.user.role,
        allowed_specialists: caller.user.allowed_specialists,
        // Whether a PIN is set — lets the web client REQUIRE it (not just offer
        // it) on the NSFW/Private folder lock, and guide a PIN-less owner to set
        // one rather than prompt for a PIN they don't have. Never exposes the hash.
        has_pin: !!caller.user.pin_hash,
      },
      auth_method: caller.auth_method,
      apple_linked: !!caller.user.apple_sub,
      ...(session ? { session_expires_at: session.expires_at } : {}),
      ...(caller.device_id ? { device_id: caller.device_id } : {}),
      bootstrap: {
        must_change_password: caller.user.must_change_password,
        must_set_pin: caller.user.must_set_pin,
      },
    });
  });

  return r;
}

/** Short non-secret hash for audit purposes — surfaces the email
 *  attempt at a glance without writing the plaintext into the log. */
function _short_hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}
