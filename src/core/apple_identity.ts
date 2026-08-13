/**
 * Sign in with Apple — identity-token verification.
 *
 * Apple's AuthenticationServices (native iOS / macOS) hands the client a
 * signed identity token (a JWT, RS256) on each sign-in. We verify it
 * SERVER-SIDE before trusting the `sub`:
 *
 *   1. signature against Apple's published JWKS (cached by `kid`)
 *   2. iss === https://appleid.apple.com
 *   3. aud ∈ our configured bundle-id allowlist (APPLE_SSO_AUDIENCES)
 *   4. exp not past (small clock-skew allowance)
 *   5. nonce (optional) — sha256(raw_nonce) === the token's `nonce` claim
 *      when the client supplies a raw nonce (replay defense)
 *
 * No Apple `.p8` / client secret is needed for PURE AUTHENTICATION — we
 * only READ the identity token, never call Apple's `/auth/token`. The
 * RS256 verify runs on WebCrypto (global `crypto.subtle` in Bun), so this
 * module adds no dependency.
 *
 * The `aud` allowlist is config, not a magic constant: set
 * `APPLE_SSO_AUDIENCES` to a comma-separated list of the app's Bundle
 * IDs (iOS and macOS may differ — both go in). Unset ⇒ `apple_sso_
 * configured()` is false and the routes return a clean 503, mirroring
 * `apns_configured()`.
 *
 * Nonce contract with the client: the iOS/macOS app generates a random
 * `raw_nonce`, sets `ASAuthorizationAppleIDRequest.nonce =
 * sha256_hex(raw_nonce)` (Apple echoes that verbatim into the token's
 * `nonce` claim), and posts BOTH the identity token and the raw nonce.
 * We recompute and compare. Omitting the raw nonce skips the check.
 *
 * Test seam: `_test_set_jwks()` swaps in a local key set so the smoke
 * signs its own tokens and runs fully offline — mirrors `apns.ts`'s
 * `_test_set_transport`.
 */

import { createHash } from 'node:crypto';

const APPLE_ISS = 'https://appleid.apple.com';
const APPLE_KEYS_URL = process.env.APPLE_KEYS_URL ?? 'https://appleid.apple.com/auth/keys';
const JWKS_TTL_MS = 6 * 60 * 60 * 1000; // Apple rotates keys infrequently.
const CLOCK_SKEW_S = 300; // 5 min, both directions, for clock drift.

/** A signing key as Apple publishes it at /auth/keys. */
export interface AppleJwk {
  kty: string;
  kid: string;
  use?: string;
  alg?: string;
  n: string;
  e: string;
}

/** The trustworthy claims we expose to callers after a clean verify. */
export interface AppleIdentity {
  /** The stable per-(Apple ID × app) subject id — THE link key. */
  sub: string;
  /** Lowercased email when the user granted email scope, else null.
   *  May be a `@privaterelay.appleid.com` address (see is_private_email). */
  email: string | null;
  email_verified: boolean;
  /** True when Apple issued a relay address ("Hide My Email"). */
  is_private_email: boolean;
  aud: string;
}

export type AppleVerifyResult =
  | { ok: true; identity: AppleIdentity }
  | { ok: false; reason: string };

// ── config ──────────────────────────────────────────────────────────────────

/** The configured Bundle-ID audience allowlist (APPLE_SSO_AUDIENCES). */
export function apple_audiences(): string[] {
  return (process.env.APPLE_SSO_AUDIENCES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True once at least one audience is configured — the routes' 503 gate. */
export function apple_sso_configured(): boolean {
  return apple_audiences().length > 0;
}

// ── JWKS cache + test seam ────────────────────────────────────────────────────

let _jwks_cache: { keys: AppleJwk[]; fetched_at: number } | null = null;
let _test_jwks: AppleJwk[] | null = null;

/** Inject a local key set (smoke only); pass null to restore live fetch. */
export function _test_set_jwks(keys: AppleJwk[] | null): void {
  _test_jwks = keys;
  _jwks_cache = null;
}

async function get_jwks(force = false): Promise<AppleJwk[]> {
  if (_test_jwks) return _test_jwks;
  const now = Date.now();
  if (!force && _jwks_cache && now - _jwks_cache.fetched_at < JWKS_TTL_MS) {
    return _jwks_cache.keys;
  }
  const res = await fetch(APPLE_KEYS_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Apple JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: AppleJwk[] };
  const keys = body.keys ?? [];
  _jwks_cache = { keys, fetched_at: now };
  return keys;
}

// ── verify ────────────────────────────────────────────────────────────────────

/**
 * Verify an Apple identity token end-to-end. Returns the trustworthy
 * claims on success, or `{ ok:false, reason }` for any failure (the
 * caller collapses every reason into one opaque 401 — the reason is for
 * the audit row, not the client).
 */
export async function verify_apple_identity_token(
  token: string,
  opts: { audiences: string[]; raw_nonce?: string; now_ms?: number },
): Promise<AppleVerifyResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed_token' };
  const [h_b64, p_b64, s_b64] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(utf8(b64url_to_bytes(h_b64)));
    claims = JSON.parse(utf8(b64url_to_bytes(p_b64)));
  } catch {
    return { ok: false, reason: 'undecodable' };
  }
  if (header.alg !== 'RS256') return { ok: false, reason: 'unexpected_alg' };
  if (!header.kid) return { ok: false, reason: 'no_kid' };

  // Signature — find the key by kid; refetch once on a miss (key rotation).
  let jwk = (await get_jwks()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await get_jwks(true)).find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'unknown_kid' };

  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true } as JsonWebKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const data = new TextEncoder().encode(`${h_b64}.${p_b64}`);
    valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64url_to_bytes(s_b64),
      data,
    );
  } catch {
    return { ok: false, reason: 'verify_error' };
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };

  // Claims.
  if (claims.iss !== APPLE_ISS) return { ok: false, reason: 'bad_iss' };
  const aud = typeof claims.aud === 'string' ? claims.aud : '';
  if (!opts.audiences.includes(aud)) return { ok: false, reason: 'bad_aud' };
  const now_s = Math.floor((opts.now_ms ?? Date.now()) / 1000);
  const exp = typeof claims.exp === 'number' ? claims.exp : 0;
  if (exp + CLOCK_SKEW_S < now_s) return { ok: false, reason: 'expired' };
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  if (!sub) return { ok: false, reason: 'no_sub' };

  // Nonce — enforced only when the caller supplied a raw nonce to check.
  if (opts.raw_nonce !== undefined) {
    const expected = createHash('sha256').update(opts.raw_nonce).digest('hex');
    const got = typeof claims.nonce === 'string' ? claims.nonce : '';
    if (got !== expected) return { ok: false, reason: 'bad_nonce' };
  }

  return {
    ok: true,
    identity: {
      sub,
      email: typeof claims.email === 'string' ? claims.email.toLowerCase() : null,
      email_verified: truthy(claims.email_verified),
      is_private_email: truthy(claims.is_private_email),
      aud,
    },
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Apple sends `email_verified` / `is_private_email` as bool OR "true"/"false". */
function truthy(v: unknown): boolean {
  return v === true || v === 'true';
}

function b64url_to_bytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}
