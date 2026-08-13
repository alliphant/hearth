export {};
/**
 * Smoke for Sign in with Apple (account-linking auth).
 *
 * Self-contained: a temp users.yaml + temp SQLite, the REAL /api/auth
 * router mounted in-process, and a locally-generated RSA keypair injected
 * as Apple's JWKS so we sign our own identity tokens and never touch
 * Apple. Asserts the whole contract:
 *
 *   • 503 when APPLE_SSO_AUDIENCES is unset (not configured).
 *   • provision-first: an unknown `sub` with no email match → 409
 *     no_linked_account (Apple can authenticate, never create).
 *   • Settings link (authenticated): a logged-in user binds their sub;
 *     thereafter /auth/apple logs them straight in (linked:'existing').
 *   • login-screen auto-link on an exact VERIFIED, NON-private email
 *     match → linked:'auto'; private-relay / unverified email never
 *     auto-links.
 *   • one Apple ID → one account: linking a sub already bound elsewhere
 *     → 409 sub_in_use.
 *   • token verification rejects bad aud / expired / bad iss / tampered
 *     signature, and the nonce check (verifier-level).
 *   • disconnect: DELETE unlinks; the sub no longer logs in.
 *
 *   bun run smoke:auth-apple
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { UserRegistry } from '@core/users';
import { SessionStore } from '@core/sessions';
import { DeviceStore } from '@core/devices';
import { create_auth_router } from '@app/routes/auth';
import {
  _test_set_jwks,
  verify_apple_identity_token,
  type AppleJwk,
} from '@core/apple_identity';

const AUD = 'com.hearth.app';
const APPLE_ISS = 'https://appleid.apple.com';
const KID = 'test-key-1';

let checks = 0;
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  checks++;
}

// ── test JWT signing (mirrors what Apple does; production only verifies) ──

function bytes_to_b64url(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function json_b64url(o: unknown): string {
  return bytes_to_b64url(new TextEncoder().encode(JSON.stringify(o)));
}

async function make_token(
  priv: CryptoKey,
  claims: Record<string, unknown>,
  opts: { kid?: string; tamper?: boolean } = {},
): Promise<string> {
  const header = json_b64url({ alg: 'RS256', kid: opts.kid ?? KID, typ: 'JWT' });
  const payload = json_b64url(claims);
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', priv, data);
  let sig_b64 = bytes_to_b64url(sig);
  if (opts.tamper) {
    // Flip one char so the signature no longer verifies.
    const c = sig_b64[5] === 'A' ? 'B' : 'A';
    sig_b64 = sig_b64.slice(0, 5) + c + sig_b64.slice(6);
  }
  return `${header}.${payload}.${sig_b64}`;
}

function base_claims(over: Record<string, unknown>): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: APPLE_ISS, aud: AUD, iat: now, exp: now + 600, ...over };
}

// ── harness ──────────────────────────────────────────────────────────────────

async function setup() {
  const root = mkdtempSync(resolve(tmpdir(), 'hearth-apple-'));
  const vault = resolve(root, 'vault');
  mkdirSync(vault, { recursive: true });
  const db = open_db(resolve(root, 'hearth.db'));
  const memory = new MemoryClient({ vault_root: vault, db });

  const pw = async (s: string) =>
    Bun.password.hash(s, { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3 });

  const users_path = resolve(root, 'users.yaml');
  const yaml = [
    'users:',
    '  - id: jasper',
    '    display_name: Jasper',
    "    allowed_specialists: '*'",
    '    timezone: America/Denver',
    '    notification_config_ref: default',
    '    tier: owner',
    '    email: jasper@example.com',
    `    password_hash: '${await pw('pw-jasper')}'`,
    '  - id: sam',
    '    display_name: Sam',
    "    allowed_specialists: '*'",
    '    timezone: America/Denver',
    '    notification_config_ref: default',
    '    tier: household',
    '    email: sam@example.com',
    `    password_hash: '${await pw('pw-sam')}'`,
    '  - id: kim',
    '    display_name: Kim',
    "    allowed_specialists: '*'",
    '    timezone: America/Denver',
    '    notification_config_ref: default',
    '    tier: household',
    '    email: kim@example.com',
    `    password_hash: '${await pw('pw-kim')}'`,
    '',
  ].join('\n');
  writeFileSync(users_path, yaml, 'utf-8');

  const users = new UserRegistry(users_path, resolve(root, 'notifications.yaml'), db);
  const sessions = new SessionStore(db);
  const devices = new DeviceStore(db);

  const app = new Hono();
  app.route('/api', create_auth_router({ users, sessions, devices, memory }));

  return { root, users, app };
}

function cookie_from(res: Response): string | null {
  const sc = res.headers.get('set-cookie');
  if (!sc) return null;
  const m = sc.match(/hearth_sid=([^;]+)/);
  return m ? `hearth_sid=${m[1]}` : null;
}

async function req(
  app: Hono,
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string | null } = {},
): Promise<{ status: number; json: any; res: Response }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.cookie) headers['cookie'] = opts.cookie;
  const res = await app.fetch(
    new Request(`http://test${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  );
  let json: any = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json, res };
}

// ── run ────────────────────────────────────────────────────────────────────

async function main() {
  // Local keypair → injected as Apple's JWKS.
  const kp = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
  const jwk: AppleJwk = { kty: pub.kty!, kid: KID, use: 'sig', alg: 'RS256', n: pub.n!, e: pub.e! };
  _test_set_jwks([jwk]);

  process.env.APPLE_SSO_AUDIENCES = AUD;

  const SUB_JASON = '000111.jasonapplesub.0001';
  const SUB_SARA = '000222.saraapplesub.0002';
  const SUB_LEE = '000333.leeapplesub.0003';
  const SUB_GHOST = '000999.ghostsub.0009';

  const { root, users, app } = await setup();
  try {
    // 1 — not configured → 503.
    delete process.env.APPLE_SSO_AUDIENCES;
    {
      const tok = await make_token(kp.privateKey, base_claims({ sub: SUB_JASON }));
      const r = await req(app, 'POST', '/api/auth/apple', { body: { identity_token: tok } });
      assert(r.status === 503, `unconfigured → 503 (got ${r.status})`);
    }
    process.env.APPLE_SSO_AUDIENCES = AUD;

    // 2 — unknown sub, no email → 409 provision-first.
    {
      const tok = await make_token(kp.privateKey, base_claims({ sub: SUB_GHOST }));
      const r = await req(app, 'POST', '/api/auth/apple', { body: { identity_token: tok } });
      assert(r.status === 409 && r.json?.code === 'no_linked_account', `ghost sub → 409 (got ${r.status} ${r.json?.code})`);
    }

    // 3 — Settings link (authenticated) for jasper.
    const jasper_login = await req(app, 'POST', '/api/auth/login', { body: { email: 'jasper@example.com', password: 'pw-jasper' } });
    assert(jasper_login.status === 200, `jasper password login → 200 (got ${jasper_login.status})`);
    const jasper_cookie = cookie_from(jasper_login.res);
    assert(!!jasper_cookie, 'login set a session cookie');
    {
      const tok = await make_token(kp.privateKey, base_claims({ sub: SUB_JASON }));
      const r = await req(app, 'POST', '/api/auth/apple/link', { body: { identity_token: tok }, cookie: jasper_cookie });
      assert(r.status === 200 && r.json?.linked === true, `jasper link → ok (got ${r.status} ${JSON.stringify(r.json)})`);
      assert(users.resolve_by_apple_sub(SUB_JASON)?.id === 'jasper', 'sub now resolves to jasper');
    }
    // link requires auth
    {
      const tok = await make_token(kp.privateKey, base_claims({ sub: SUB_JASON }));
      const r = await req(app, 'POST', '/api/auth/apple/link', { body: { identity_token: tok } });
      assert(r.status === 401, `link without session → 401 (got ${r.status})`);
    }

    // 4 — login via the linked sub (no cookie).
    {
      const tok = await make_token(kp.privateKey, base_claims({ sub: SUB_JASON }));
      const r = await req(app, 'POST', '/api/auth/apple', { body: { identity_token: tok } });
      assert(r.status === 200 && r.json?.user?.id === 'jasper' && r.json?.linked === 'existing', `linked login → jasper existing (got ${r.status} ${JSON.stringify(r.json?.linked)})`);
      assert(!!cookie_from(r.res), 'apple login set a session cookie');
    }

    // 5 — auto-link on exact verified non-private email.
    {
      const tok = await make_token(kp.privateKey, base_claims({ sub: SUB_SARA, email: 'sam@example.com', email_verified: true, is_private_email: false }));
      const r = await req(app, 'POST', '/api/auth/apple', { body: { identity_token: tok } });
      assert(r.status === 200 && r.json?.user?.id === 'sam' && r.json?.linked === 'auto', `auto-link sam (got ${r.status} ${JSON.stringify(r.json?.linked)})`);
      assert(users.resolve_by_apple_sub(SUB_SARA)?.id === 'sam', 'sam now linked by sub');
    }

    // 6 — private-relay email must NOT auto-link; unverified must NOT either.
    {
      const tok = await make_token(kp.privateKey, base_claims({ sub: SUB_LEE, email: 'kim@example.com', email_verified: true, is_private_email: true }));
      const r = await req(app, 'POST', '/api/auth/apple', { body: { identity_token: tok } });
      assert(r.status === 409, `private-relay no auto-link → 409 (got ${r.status})`);
      assert(users.resolve_by_apple_sub(SUB_LEE) === null && users.get('kim')?.apple_sub == null, 'kim still unlinked after private-relay');
    }
    {
      const tok = await make_token(kp.privateKey, base_claims({ sub: '000444.x.0004', email: 'kim@example.com', email_verified: false, is_private_email: false }));
      const r = await req(app, 'POST', '/api/auth/apple', { body: { identity_token: tok } });
      assert(r.status === 409, `unverified email no auto-link → 409 (got ${r.status})`);
      assert(users.get('kim')?.apple_sub == null, 'kim still unlinked after unverified email');
    }

    // 7 — one Apple ID → one account (cross-link conflict).
    const sara_login = await req(app, 'POST', '/api/auth/login', { body: { email: 'sam@example.com', password: 'pw-sam' } });
    const sara_cookie = cookie_from(sara_login.res);
    {
      const tok = await make_token(kp.privateKey, base_claims({ sub: SUB_JASON }));
      const r = await req(app, 'POST', '/api/auth/apple/link', { body: { identity_token: tok }, cookie: sara_cookie });
      assert(r.status === 409 && r.json?.code === 'sub_in_use', `cross-link → 409 sub_in_use (got ${r.status} ${r.json?.code})`);
    }

    // 8 — bad tokens all reject (401) at /auth/apple.
    for (const [label, claims, sopts] of [
      ['wrong aud', base_claims({ sub: SUB_JASON, aud: 'com.someone.else' }), {}],
      ['expired', { iss: APPLE_ISS, aud: AUD, sub: SUB_JASON, iat: 0, exp: Math.floor(Date.now() / 1000) - 1000 }, {}],
      ['bad iss', base_claims({ sub: SUB_JASON, iss: 'https://evil.example' }), {}],
      ['tampered sig', base_claims({ sub: SUB_JASON }), { tamper: true }],
      ['unknown kid', base_claims({ sub: SUB_JASON }), { kid: 'no-such-kid' }],
    ] as Array<[string, Record<string, unknown>, { tamper?: boolean; kid?: string }]>) {
      const tok = await make_token(kp.privateKey, claims, sopts);
      const r = await req(app, 'POST', '/api/auth/apple', { body: { identity_token: tok } });
      assert(r.status === 401, `${label} → 401 (got ${r.status})`);
    }

    // 9 — nonce check (verifier-level).
    {
      const nonce = 'abc-123-raw';
      const tok = await make_token(kp.privateKey, base_claims({ sub: SUB_JASON, nonce: createHash('sha256').update(nonce).digest('hex') }));
      const good = await verify_apple_identity_token(tok, { audiences: [AUD], raw_nonce: nonce });
      assert(good.ok === true, 'matching nonce verifies');
      const bad = await verify_apple_identity_token(tok, { audiences: [AUD], raw_nonce: 'wrong' });
      assert(bad.ok === false && bad.reason === 'bad_nonce', `mismatched nonce → bad_nonce (got ${bad.ok ? 'ok' : (bad as any).reason})`);
    }

    // 10 — disconnect: DELETE unlinks; the sub no longer logs in.
    {
      const del = await req(app, 'DELETE', '/api/auth/apple/link', { cookie: jasper_cookie });
      assert(del.status === 200 && del.json?.linked === false, `unlink → ok (got ${del.status})`);
      assert(users.resolve_by_apple_sub(SUB_JASON) === null, 'jasper sub cleared after unlink');
      const tok = await make_token(kp.privateKey, base_claims({ sub: SUB_JASON }));
      const r = await req(app, 'POST', '/api/auth/apple', { body: { identity_token: tok } });
      assert(r.status === 409, `unlinked sub login → 409 (got ${r.status})`);
    }

    console.log(`\n✅ smoke:auth-apple PASS — ${checks} checks`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`\n❌ smoke:auth-apple FAILED: ${err.message}`);
  process.exit(1);
});
