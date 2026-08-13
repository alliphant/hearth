/**
 * APNs — direct Hearth → Apple Push Notification service.
 *
 * Per Jasper's 2026-05-26 directive: iOS pushes go Hearth → Apple → device.
 * APNs is the sole push channel — the deprecated Hermes/Telegram bridge was
 * removed 2026-06-14. push.ts gates by quiet hours, fans out to a user's
 * registered tokens via send_apns(), and queues to pending_pushes on miss.
 *
 * Layout:
 *
 *   - ApnsTokenStore: CRUD over the apns_tokens table.
 *   - sign_apns_jwt(): ES256 JWT, cached in memory for 50 minutes
 *     (Apple's hard limit is 60 min; 50 leaves headroom).
 *   - send_apns_payload(): single-token POST to APNs HTTP/2.
 *   - send_apns(): high-level fan-out — looks up every registered
 *     token for a user and pushes in parallel, purging 410s.
 *
 * Bun's built-in fetch speaks HTTP/2 to Apple — no extra deps. We do
 * NOT keep a long-lived connection per call: Bun's fetch pools internally.
 * For sub-100ms-latency push-rate workloads we'd want to manage a single
 * persistent H/2 stream, but Hearth's volume is bounded by Kate's
 * deliberation cadence (hours apart) so per-call connect cost is fine.
 */

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { connect as http2_connect, type ClientHttp2Session } from 'node:http2';
import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import type { MemoryClient } from '@memory/client';

// ── Config (env) ──────────────────────────────────────────────────────────

const APNS_KEY_PATH = process.env.APNS_KEY_PATH ?? '';
const APNS_KEY_ID = process.env.APNS_KEY_ID ?? '';
const APNS_TEAM_ID = process.env.APNS_TEAM_ID ?? '';
/** Bundle id of the main iOS app. APNs `apns-topic` for regular alerts. */
const APNS_TOPIC = process.env.APNS_TOPIC ?? 'com.hearthcrew.app';
/** Optional Live Activity topic = `<bundle>.push-type.liveactivity`. */
const APNS_LIVE_ACTIVITY_TOPIC =
  process.env.APNS_LIVE_ACTIVITY_TOPIC ?? `${APNS_TOPIC}.push-type.liveactivity`;

const APNS_HOST_PROD = 'https://api.push.apple.com';
const APNS_HOST_SANDBOX = 'https://api.sandbox.push.apple.com';

/** Apple expires JWTs at 1h; refresh at 50m so we never race the clock. */
const JWT_TTL_MS = 50 * 60 * 1000;

// ── Token storage ─────────────────────────────────────────────────────────

export type ApnsEnvironment = 'sandbox' | 'production';

export interface ApnsTokenRow {
  user_id: string;
  device_token: string;
  environment: ApnsEnvironment;
  bundle_id: string;
  app_build: string | null;
  registered_at: string;
  last_seen_at: string;
  live_activity_push_token: string | null;
  live_activity_id: string | null;
}

export class ApnsTokenStore {
  constructor(private db: Database) {}

  /** Upsert: re-registering the same token bumps last_seen + updates
   *  user_id/build. The composite (token, env) PK absorbs duplicates. */
  upsert(input: {
    user_id: string;
    device_token: string;
    environment: ApnsEnvironment;
    bundle_id: string;
    app_build: string | null;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO apns_tokens
           (user_id, device_token, environment, bundle_id, app_build,
            registered_at, last_seen_at)
         VALUES (@user_id, @device_token, @environment, @bundle_id, @app_build,
                 @now, @now)
         ON CONFLICT(device_token, environment) DO UPDATE SET
           user_id = excluded.user_id,
           bundle_id = excluded.bundle_id,
           app_build = excluded.app_build,
           last_seen_at = excluded.last_seen_at`,
      )
      .run({
        '@user_id': input.user_id,
        '@device_token': input.device_token,
        '@environment': input.environment,
        '@bundle_id': input.bundle_id,
        '@app_build': input.app_build,
        '@now': now,
      });
  }

  list_for_user(user_id: string): ApnsTokenRow[] {
    return this.db
      .prepare(`SELECT * FROM apns_tokens WHERE user_id = @uid`)
      .all({ '@uid': user_id }) as ApnsTokenRow[];
  }

  /** Apple says the token is dead — drop the row. Idempotent. */
  delete_token(device_token: string, environment: ApnsEnvironment): void {
    this.db
      .prepare(
        `DELETE FROM apns_tokens
         WHERE device_token = @t AND environment = @e`,
      )
      .run({ '@t': device_token, '@e': environment });
  }

  /** Caller invoked POST /api/apns/unregister explicitly — same delete. */
  unregister(user_id: string, device_token: string): void {
    this.db
      .prepare(
        `DELETE FROM apns_tokens
         WHERE user_id = @uid AND device_token = @t`,
      )
      .run({ '@uid': user_id, '@t': device_token });
  }

  /** Attach (or update) a per-activity push token for an existing device.
   *  Looks up the canonical device by user_id + matching environment when
   *  the iOS app reports a new Activity push token; we update both rows
   *  if (somehow) the same device_token spans sandbox+production. */
  set_live_activity_token(input: {
    user_id: string;
    device_token: string;
    environment: ApnsEnvironment;
    live_activity_id: string | null;
    live_activity_push_token: string | null;
  }): void {
    this.db
      .prepare(
        `UPDATE apns_tokens
         SET live_activity_id = @aid,
             live_activity_push_token = @apt,
             last_seen_at = @now
         WHERE user_id = @uid
           AND device_token = @t
           AND environment = @env`,
      )
      .run({
        '@uid': input.user_id,
        '@t': input.device_token,
        '@env': input.environment,
        '@aid': input.live_activity_id,
        '@apt': input.live_activity_push_token,
        '@now': new Date().toISOString(),
      });
  }

  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM apns_tokens`)
      .get() as { n: number };
    return row.n;
  }
}

// ── JWT signer (ES256) ────────────────────────────────────────────────────

interface CachedJwt {
  token: string;
  expires_at_ms: number;
}
let cached_jwt: CachedJwt | null = null;
/** Set by tests to bypass JWT signing in environments without a real .p8. */
let test_jwt_override: string | null = null;

export function _test_set_jwt(token: string | null): void {
  test_jwt_override = token;
  cached_jwt = null;
}

function b64url(input: Buffer): string {
  return input.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Read + cache the PEM-encoded ES256 private key. */
let cached_pem: string | null = null;
function load_pem(): string {
  if (cached_pem) return cached_pem;
  if (!APNS_KEY_PATH) {
    throw new Error('APNS_KEY_PATH not set');
  }
  cached_pem = readFileSync(APNS_KEY_PATH, 'utf8');
  return cached_pem;
}

/**
 * Sign a fresh provider JWT or return the cached one if still valid.
 * Apple's APNs server accepts ES256 JWTs signed with the team's .p8
 * key — the JWT proves the caller is authorized to push for this
 * bundle. Cached for JWT_TTL_MS so we don't sign per push.
 */
export function sign_apns_jwt(): string {
  if (test_jwt_override !== null) return test_jwt_override;
  if (cached_jwt && cached_jwt.expires_at_ms > Date.now()) {
    return cached_jwt.token;
  }
  if (!APNS_KEY_ID || !APNS_TEAM_ID) {
    throw new Error('APNS_KEY_ID and APNS_TEAM_ID must be set');
  }
  const pem = load_pem();
  const header = { alg: 'ES256', kid: APNS_KEY_ID, typ: 'JWT' };
  const now_s = Math.floor(Date.now() / 1000);
  const payload = { iss: APNS_TEAM_ID, iat: now_s };
  const header_b64 = b64url(Buffer.from(JSON.stringify(header)));
  const payload_b64 = b64url(Buffer.from(JSON.stringify(payload)));
  const signing_input = `${header_b64}.${payload_b64}`;

  const sign = createSign('SHA256');
  sign.update(signing_input);
  sign.end();
  // Node returns ES256 as DER-encoded ASN.1 by default; APNs wants the
  // raw IEEE-P1363 (R || S, 64 bytes) form. Convert.
  const der = sign.sign({ key: pem, dsaEncoding: 'ieee-p1363' });
  const signature_b64 = b64url(der);

  const token = `${signing_input}.${signature_b64}`;
  cached_jwt = { token, expires_at_ms: Date.now() + JWT_TTL_MS };
  return token;
}

// ── Sender ────────────────────────────────────────────────────────────────

/** APNs `apns-push-type` header. Apple requires alert/background for
 *  regular notifications; liveactivity for Activity updates. */
export type ApnsPushType = 'alert' | 'background' | 'liveactivity';

export interface ApnsAttempt {
  device_token: string;
  environment: ApnsEnvironment;
  status: number;
  apns_id: string | null;
  /** Apple's `reason` field from the JSON error body when status != 200. */
  reason: string | null;
  ok: boolean;
  /** True when we deleted the row in response to a definitive-dead status. */
  purged: boolean;
}

function apns_host(env: ApnsEnvironment): string {
  return env === 'production' ? APNS_HOST_PROD : APNS_HOST_SANDBOX;
}

/** Transport function — the thing that actually talks to APNs. Tests
 *  swap this out via `_test_set_transport` to bypass http2 entirely. */
export type ApnsTransport = (input: {
  jwt: string;
  device_token: string;
  environment: ApnsEnvironment;
  topic: string;
  push_type: ApnsPushType;
  payload: unknown;
  collapse_id?: string | null;
  expiration_s?: number | null;
  priority?: 5 | 10;
}) => Promise<{ status: number; apns_id: string | null; reason: string | null }>;

let transport_override: ApnsTransport | null = null;

export function _test_set_transport(fn: ApnsTransport | null): void {
  transport_override = fn;
}

// ── HTTP/2 session cache ──────────────────────────────────────────────────
//
// APNs requires HTTP/2 and is happiest with a long-lived multiplexed
// session. Bun's `fetch` ostensibly handles HTTP/2 but in practice
// returns `Malformed_HTTP_Response` against `api.push.apple.com` —
// known interaction issue with the way Apple's edge frames responses.
// The canonical Node-side pattern (used by node-apn etc.) is to talk
// to APNs through `node:http2` directly. Bun supports the http2 module
// natively, so we use the same pattern.
//
// We hold one session per (env_host) and reuse it for the lifetime of
// the process. The session auto-recovers on close/error — the next
// call rebuilds. Apple aggressively GOAWAYs idle sessions after a
// couple of minutes, so we treat `goaway` / `close` / `error` as
// "drop from cache, next call reconnects."
const http2_sessions = new Map<string, ClientHttp2Session>();

function get_http2_session(host: string): ClientHttp2Session {
  const existing = http2_sessions.get(host);
  if (existing && !existing.closed && !existing.destroyed) {
    return existing;
  }
  const session = http2_connect(host);
  // Drop from cache on any terminal event so the next call dials fresh.
  const evict = () => {
    if (http2_sessions.get(host) === session) {
      http2_sessions.delete(host);
    }
  };
  session.on('close', evict);
  session.on('error', evict);
  session.on('goaway', () => {
    evict();
    try { session.close(); } catch { /* already closing */ }
  });
  // Errors on the unhandled-error path crash the process otherwise.
  session.on('error', () => { /* logged via per-request reject */ });
  http2_sessions.set(host, session);
  return session;
}

/**
 * Single-token push to APNs via a multiplexed HTTP/2 session.
 *
 * Apple status codes we act on:
 *   200       — delivered to APNs (not necessarily seen by user)
 *   400 (DeviceTokenNotForTopic / BadDeviceToken)
 *   410 (Unregistered)        — token is dead, drop
 *   429 / 500-series          — transient, no purge
 *
 *  See: developer.apple.com/documentation/usernotifications/sending_notification_requests_to_apns
 */
async function post_to_apns(input: {
  jwt: string;
  device_token: string;
  environment: ApnsEnvironment;
  topic: string;
  push_type: ApnsPushType;
  payload: unknown;
  collapse_id?: string | null;
  expiration_s?: number | null;
  priority?: 5 | 10;
}): Promise<{ status: number; apns_id: string | null; reason: string | null }> {
  if (transport_override) return transport_override(input);
  const host = apns_host(input.environment);
  const session = get_http2_session(host);
  const headers: Record<string, string | number> = {
    ':method': 'POST',
    ':path': `/3/device/${input.device_token}`,
    authorization: `bearer ${input.jwt}`,
    'apns-topic': input.topic,
    'apns-push-type': input.push_type,
    'apns-priority': input.priority ?? 10,
    'content-type': 'application/json',
  };
  if (input.expiration_s != null) {
    headers['apns-expiration'] = input.expiration_s;
  }
  if (input.collapse_id) {
    headers['apns-collapse-id'] = input.collapse_id;
  }

  const body = JSON.stringify(input.payload);

  return await new Promise((resolve, reject) => {
    const req = session.request(headers);
    let status = 0;
    let apns_id: string | null = null;
    const chunks: Buffer[] = [];

    req.on('response', (h) => {
      const raw_status = h[':status'];
      status = typeof raw_status === 'number' ? raw_status : Number(raw_status ?? 0);
      const id = h['apns-id'];
      apns_id = typeof id === 'string' ? id : Array.isArray(id) ? id[0] ?? null : null;
    });
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let reason: string | null = null;
      if (status !== 200 && chunks.length > 0) {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            reason?: string;
          };
          reason = parsed.reason ?? null;
        } catch {
          reason = null;
        }
      }
      resolve({ status, apns_id, reason });
    });
    req.on('error', (err) => reject(err));
    // Apple's reference implementations cap per-request at 30s. APNs's
    // edge typically responds in 10–200ms; a hung request means the
    // session is wedged and we want the caller to see that as a
    // transient failure (no token purge).
    req.setTimeout(30_000, () => {
      req.close(0x8 /* CANCEL */);
      reject(new Error('APNs request timed out'));
    });
    req.end(body);
  });
}

/** Test hook: close any cached HTTP/2 sessions. Smoke calls this so the
 *  process exits cleanly; production never needs it. */
export function _test_close_sessions(): void {
  for (const session of http2_sessions.values()) {
    try { session.close(); } catch { /* already closed */ }
  }
  http2_sessions.clear();
}

/**
 * Send a payload to every APNs token registered for `user_id`.
 *
 * Returns an attempt per token so the audit caller can record what
 * actually fanned out (delivered / failed / purged). Tokens that come
 * back 410 (or with the "Unregistered" / "BadDeviceToken" reason on
 * 400) get hard-deleted from the store before this returns.
 */
export async function send_apns(input: {
  store: ApnsTokenStore;
  user_id: string;
  topic?: string;
  push_type?: ApnsPushType;
  priority?: 5 | 10;
  collapse_id?: string | null;
  expiration_s?: number | null;
  payload: unknown;
}): Promise<{ attempts: ApnsAttempt[]; delivered: boolean }> {
  const tokens = input.store.list_for_user(input.user_id);
  if (tokens.length === 0) {
    return { attempts: [], delivered: false };
  }
  let jwt: string;
  try {
    jwt = sign_apns_jwt();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      attempts: tokens.map((t) => ({
        device_token: t.device_token,
        environment: t.environment,
        status: 0,
        apns_id: null,
        reason,
        ok: false,
        purged: false,
      })),
      delivered: false,
    };
  }
  const topic = input.topic ?? APNS_TOPIC;
  const push_type: ApnsPushType = input.push_type ?? 'alert';

  const results = await Promise.all(
    tokens.map(async (t) => {
      try {
        const out = await post_to_apns({
          jwt,
          device_token: t.device_token,
          environment: t.environment,
          topic,
          push_type,
          payload: input.payload,
          priority: input.priority,
          collapse_id: input.collapse_id ?? null,
          expiration_s: input.expiration_s ?? null,
        });
        const dead = out.status === 410 ||
          (out.status === 400 &&
            (out.reason === 'BadDeviceToken' || out.reason === 'Unregistered'));
        if (dead) {
          input.store.delete_token(t.device_token, t.environment);
        }
        return {
          device_token: t.device_token,
          environment: t.environment,
          status: out.status,
          apns_id: out.apns_id,
          reason: out.reason,
          ok: out.status === 200,
          purged: dead,
        } as ApnsAttempt;
      } catch (err) {
        return {
          device_token: t.device_token,
          environment: t.environment,
          status: 0,
          apns_id: null,
          reason: err instanceof Error ? err.message : String(err),
          ok: false,
          purged: false,
        } as ApnsAttempt;
      }
    }),
  );
  const delivered = results.some((r) => r.ok);
  return { attempts: results, delivered };
}

// ── Helpers used by push.ts to build aps payloads ─────────────────────────

export interface AlertPayloadInput {
  /** Human-readable title for the lock-screen alert. */
  title?: string;
  /** Body text. APNs truncates >2048 bytes; iOS truncates per device. */
  body: string;
  /** UNNotificationCategory id registered on the iOS side — drives
   *  category-specific UI affordances. */
  category?: string;
  /** APNs thread-id: groups related pushes into a single bubble. */
  thread_id?: string;
  /** APNs sound: 'default' for the system sound, null/undefined = silent. */
  sound?: 'default' | null;
  /** App-side route data — see PushCoordinator.handleNotificationResponse. */
  hearth_route?: { kind: string; id?: string };
  /** Optional extra payload merged into the top-level aps sibling. */
  extras?: Record<string, unknown>;
}

export function build_alert_payload(input: AlertPayloadInput): unknown {
  const aps: Record<string, unknown> = {
    alert: input.title
      ? { title: input.title, body: input.body }
      : { body: input.body },
  };
  if (input.sound !== null) aps.sound = input.sound ?? 'default';
  if (input.category) aps.category = input.category;
  if (input.thread_id) aps['thread-id'] = input.thread_id;
  // Always include a badge increment of 1 by default — the app clears
  // it when the user views the surface. Configurable per-call if a
  // category shouldn't badge (e.g. silent background updates).
  aps.badge = 1;
  const top: Record<string, unknown> = { aps };
  if (input.hearth_route) {
    top.hearth = { route: input.hearth_route };
  }
  if (input.extras) Object.assign(top, input.extras);
  return top;
}

// ── Audit helper ──────────────────────────────────────────────────────────

/**
 * Audit one apns dispatch. Records who, what category, the per-token
 * outcomes — but NEVER the full device token (we redact to last 6 hex
 * chars) and NEVER the message body (PII). Same redaction pattern as
 * the maps connector for sensitive payloads.
 */
export function audit_apns(
  memory: MemoryClient,
  input: {
    user_id: string;
    category: string | null;
    push_type: ApnsPushType;
    attempts: ApnsAttempt[];
    reason: string; // why-Hearth-pushed-this, not the message text
  },
): string {
  const intent_id = ulid();
  return memory.log_action({
    intent_id,
    agent: 'orchestrator',
    tool_name: 'apns_dispatch',
    tool_input: {
      user_id: input.user_id,
      category: input.category,
      push_type: input.push_type,
      reason: input.reason,
      // Redact tokens to a fingerprint — last 6 chars + environment.
      attempts: input.attempts.map((a) => ({
        token_tail: a.device_token.slice(-6),
        environment: a.environment,
        status: a.status,
        apns_id: a.apns_id,
        reason: a.reason,
        ok: a.ok,
        purged: a.purged,
      })),
    },
    execution_result: {
      delivered_count: input.attempts.filter((a) => a.ok).length,
      purged_count: input.attempts.filter((a) => a.purged).length,
    },
    user_id: input.user_id,
  });
}

// ── Public config probe ──────────────────────────────────────────────────

export function apns_configured(): boolean {
  return Boolean(APNS_KEY_PATH && APNS_KEY_ID && APNS_TEAM_ID);
}

export const APNS_DEFAULT_TOPIC = APNS_TOPIC;
export const APNS_LIVE_ACTIVITY_DEFAULT_TOPIC = APNS_LIVE_ACTIVITY_TOPIC;
