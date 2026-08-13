/**
 * Hono auth middleware. Looks up the session cookie, attaches the
 * authenticated user to the request context, and rejects/redirects
 * unauthenticated traffic.
 *
 * Allow-list (no session required):
 *   GET  /status                    healthcheck
 *   ANY  /api/auth/*                login/logout/me/users
 *   ANY  /musickit-auth/*           Apple Music broker (token-flow)
 *   POST /api/maggie/plex_event     Tautulli webhook (LAN-bound; Tautulli
 *                                   can't carry session cookies)
 *   GET  /app/login.html            login page itself
 *   GET  /app/app.css|app.js|sw.js|manifest.webmanifest|assets/*
 *                                   shell assets the login page needs
 *   GET  /app/api/avatars/*         login tiles render specialist avatars
 *   GET  /app/api/banners/*         specialist profile-card banners
 *                                   (matches avatars — neither is sensitive)
 *
 * Behavior on miss:
 *   /api/*     → 401 JSON
 *   /app/*     → 302 redirect to /app/login.html (preserving "from"
 *                so the login page can bounce back)
 *   /inbox, /files, /  → 302 redirect to /app/login.html
 *
 * On success, downstream handlers can read the user via
 * `c.get('user')` (typed in app_context.d.ts).
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { UserRegistry, UserConfig } from '@core/users';
import { is_valid_iana_timezone } from '@core/users';
import type { SessionStore } from '@core/sessions';
import type { DeviceStore } from '@core/devices';
import { get_session_cookie } from './routes/auth';

export interface AuthMiddlewareDeps {
  users: UserRegistry;
  sessions: SessionStore;
  /** 2026-05-25 BACKEND_AUTH_BRIEF. Optional so the middleware mounts
   *  cleanly in legacy / smoke wirings; absent ⇒ bearer auth disabled. */
  devices?: DeviceStore;
}

/** Lift the bearer token out of the Authorization header. Returns null
 *  when the header is missing or doesn't start with the expected
 *  `Bearer ` prefix (case-insensitive per RFC 6750). */
function get_bearer_token(c: Context): string | null {
  const h = c.req.header('authorization') || c.req.header('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? (m[1] ?? null) : null;
}

// Anything that should bypass the auth wall. Order matters only for
// readability; matching is OR'd.
const PUBLIC_PREFIXES: Array<{ method?: string; prefix: string }> = [
  { method: 'GET', prefix: '/status' },
  // User-facing changelog parsed from CHANGELOG.md at the repo root.
  // Same readability tier as /status — no per-user data, just "what
  // Hearth has shipped" descriptions. iOS long-press surface on
  // Today's flame icon hits it before the session cookie may have
  // arrived on a cold open; gating it on auth would force a sign-in
  // loop on first launch.
  { method: 'GET', prefix: '/api/changelog' },
  { prefix: '/api/auth' },
  { prefix: '/musickit-auth' },
  { method: 'POST', prefix: '/api/maggie/plex_event' },
  { method: 'GET', prefix: '/app/login.html' },
  { method: 'GET', prefix: '/app/showcase.html' },
  { method: 'GET', prefix: '/app/app.css' },
  { method: 'GET', prefix: '/app/app.js' },
  { method: 'GET', prefix: '/app/sw.js' },
  { method: 'GET', prefix: '/app/manifest.webmanifest' },
  { method: 'GET', prefix: '/app/assets/' },
  { method: 'GET', prefix: '/app/api/avatars/' },
  // Banners are visual chrome just like avatars; iOS hit 401 here and
  // had to forward a device bearer through a parallel fetch path
  // before this was opened up. Match the avatars allow.
  { method: 'GET', prefix: '/app/api/banners/' },
  // Mac app download: the landing page (/app/download) and the .app zip
  // (/app/download/<file>). Same public tier as showcase.html — a download
  // page shouldn't sit behind a sign-in. Boundary-aware prefix below covers
  // both the exact page path and the binary sub-path.
  { method: 'GET', prefix: '/app/download' },
  // Guest panel (/app/panel/) — page, assets and its own API. A guest has no
  // Hearth account, so a login gate would defeat the surface entirely. This is
  // the ONLY allow-listed entry that can actuate anything, and it is safe only
  // because every route inside create_panel_router is additionally gated on the
  // caller being on the house LAN (routes/panel.ts). POST is allowed for
  // /app/panel/api/action; keep both methods pointed at that one prefix.
  { method: 'GET', prefix: '/app/panel' },
  { method: 'POST', prefix: '/app/panel/api/' },
];

function _request_path(c: Context): string {
  // c.req.url may be a full URL (`http://host/path`) or a path-only
  // (`/path`) depending on the runtime. URL() throws on path-only,
  // so fall back to a stripped substring after the host.
  const raw = c.req.url;
  try {
    return new URL(raw).pathname;
  } catch {
    // Strip leading scheme://host if present; otherwise raw IS the
    // pathname. Drop any query string.
    const q = raw.indexOf('?');
    const no_q = q >= 0 ? raw.slice(0, q) : raw;
    return no_q.startsWith('/') ? no_q : '/' + no_q;
  }
}

function _is_public(c: Context): boolean {
  const path = _request_path(c);
  const method = c.req.method.toUpperCase();
  for (const rule of PUBLIC_PREFIXES) {
    if (rule.method) {
      // GET rules also accept HEAD — browsers / curl -I / preflight
      // helpers send HEAD for the same resources; treating them as a
      // separate gate breaks tile-preview tooling without buying any
      // security (HEAD returns no body anyway).
      if (rule.method === 'GET' && method !== 'GET' && method !== 'HEAD') continue;
      if (rule.method !== 'GET' && rule.method !== method) continue;
    }
    if (path === rule.prefix) return true;
    // Boundary-aware prefix match so `/app/api/avatars/` doesn't
    // mistakenly cover `/app/api/avatars_other`.
    const sep = rule.prefix.endsWith('/') ? rule.prefix : rule.prefix + '/';
    if (path.startsWith(sep)) return true;
  }
  return false;
}

export function create_auth_middleware(deps: AuthMiddlewareDeps): MiddlewareHandler {
  return async (c, next) => {
    if (_is_public(c)) return next();

    // Bearer takes precedence when both are present — the brief
    // explicitly notes "newer request shape wins" so an iOS client
    // logging in (which sets cookie THEN registers a device) doesn't
    // get stuck on the stale cookie path.
    let user: UserConfig | null = null;
    let session_id: string | null = null;
    let device_id: string | null = null;
    let auth_method: 'cookie' | 'bearer' | null = null;

    const bearer = get_bearer_token(c);
    if (bearer && deps.devices) {
      const dev = await deps.devices.find_by_token(bearer);
      if (dev) {
        const u = deps.users.get(dev.user_id);
        if (u) {
          user = u;
          device_id = dev.id;
          auth_method = 'bearer';
          deps.devices.touch(dev.id);
        }
      }
    }
    if (!user) {
      const sid = get_session_cookie(c);
      const session = sid ? deps.sessions.get(sid) : null;
      const u = session ? deps.users.get(session.user_id) : null;
      if (session && u) {
        user = u;
        session_id = sid;
        auth_method = 'cookie';
        // Sliding session — every authenticated hit refreshes expiry.
        deps.sessions.touch(sid!);
      }
    }

    if (!user) {
      const path = new URL(c.req.url).pathname;
      // API surface gets a clean 401 — clients handle redirect themselves.
      if (path.startsWith('/api/') || path.startsWith('/app/api/')) {
        return c.json({ error: 'authentication required' }, 401);
      }
      // User-facing surface: bounce to login, preserving the original
      // path as a `?from=` query for post-login redirect.
      const from = encodeURIComponent(path + (new URL(c.req.url).search || ''));
      return c.redirect(`/app/login.html?from=${from}`, 302);
    }

    c.set('user', user);
    if (session_id) c.set('session_id', session_id);
    if (device_id) c.set('device_id', device_id);
    if (auth_method) c.set('auth_method', auth_method);

    // Capture the device's local IANA timezone if the client sent one.
    // iOS and the PWA include `X-User-Timezone: America/Denver` (or
    // whichever zone the device is currently in) on every request so the
    // backend can persist on cross-zone travel — a Denver-stored user
    // checks the inbox from Tokyo and inbox files land under the Tokyo
    // date, not the Denver date. The request-scoped `user_tz` is what
    // handlers thread into `src/core/time.ts` helpers; the persisted
    // value is the fallback when no header is supplied (e.g. a scheduler
    // tick, an out-of-band tool call, a curl from the LAN).
    const header_tz = (c.req.header('x-user-timezone') ?? '').trim();
    let resolved_tz = user.timezone || 'America/Denver';
    if (header_tz && is_valid_iana_timezone(header_tz)) {
      resolved_tz = header_tz;
      if (header_tz !== user.timezone) {
        try {
          deps.users.update_user(user.id, { timezone: header_tz });
        } catch (err) {
          console.error(`[auth] failed to persist timezone for ${user.id}:`, err);
        }
      }
    }
    c.set('user_tz', resolved_tz);

    return next();
  };
}

/** Type augmentation so c.get('user') is typed across handlers. */
declare module 'hono' {
  interface ContextVariableMap {
    user: UserConfig;
    session_id: string;
    /** Set when auth_method === 'bearer' — the active device row's id. */
    device_id: string;
    /** Which path authenticated this request. Handlers gate on this
     *  when behavior differs by surface (e.g. cookie-only endpoints
     *  during the iOS transition). */
    auth_method: 'cookie' | 'bearer';
    /** IANA timezone for this request — the X-User-Timezone header if
     *  the client sent a valid one, otherwise the user's persisted
     *  timezone, otherwise America/Denver. Thread into `src/core/time.ts`
     *  helpers when rendering for the device's wall clock. */
    user_tz: string;
  }
}
