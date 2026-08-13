/**
 * DeviceStore — bearer-token auth for native clients (iOS first).
 *
 * Per the 2026-05-25 BACKEND_AUTH_BRIEF from hearth-ios: long-lived
 * per-device tokens let the iOS app authenticate without re-asking for
 * the password on every launch (Face ID gates Keychain on-device).
 * The token is emitted to the client exactly once at register time and
 * stored argon2id-hashed in the `devices` table. Soft-revoke via
 * `revoked_at` so audit history survives.
 *
 * Token shape:
 *
 *   hearth_dev_<ulid>.<base64url(32 random bytes)>
 *
 * The dev_id is in the token's prefix so server-side lookup is O(1):
 * split on the first `.`, look up by id, Bun.password.verify the
 * secret half against `token_hash`. The client doesn't need to know
 * the structure — it stores the whole string in Keychain and sends
 * it as `Authorization: Bearer <token>`.
 *
 * Last-seen tracking: bumped on every successful bearer auth (the
 * middleware calls touch()). Used by the /devices list so Jasper can
 * see "last seen 3 days ago" and confidently revoke a stale device.
 *
 * NEVER logs the plaintext token. Audit rows record the dev_id only.
 */
import { ulid } from 'ulid';
import { randomBytes } from 'node:crypto';
import type { Database } from 'bun:sqlite';

export interface DeviceRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
}

/** What's safe to return on /auth/devices (no token_hash). */
export interface DeviceSafe {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string;
  current: boolean;
}

const TOKEN_PREFIX = 'hearth_dev_';

/** Parse a bearer string into (dev_id, secret). Returns null when the
 *  string doesn't match the expected `hearth_dev_<id>.<secret>` shape —
 *  callers should treat that as "no device match," same as a bad hash. */
export function parse_bearer(token: string): { dev_id: string; secret: string } | null {
  const trimmed = token.trim();
  if (!trimmed.startsWith(TOKEN_PREFIX)) return null;
  const dot = trimmed.indexOf('.', TOKEN_PREFIX.length);
  if (dot < 0) return null;
  const dev_id = trimmed.slice(0, dot);
  const secret = trimmed.slice(dot + 1);
  if (!dev_id || !secret) return null;
  return { dev_id, secret };
}

/** Generate the (id, token, secret) triple for a new device. The token
 *  is what we hand the client; the secret is what we hash. */
function _mint_token(): { id: string; token: string; secret: string } {
  const id = `${TOKEN_PREFIX}${ulid().toLowerCase()}`;
  // 32 bytes per the brief; base64url has no padding/special chars.
  const secret = randomBytes(32).toString('base64url');
  return { id, token: `${id}.${secret}`, secret };
}

export class DeviceStore {
  constructor(private db: Database) {}

  /** Register a new device for `user_id`. Returns the plaintext token
   *  ONCE — caller writes it to the client response and forgets. */
  async create(input: {
    user_id: string;
    name: string;
  }): Promise<{ device_id: string; token: string }> {
    const { id, token, secret } = _mint_token();
    const token_hash = await Bun.password.hash(secret, {
      algorithm: 'argon2id',
      memoryCost: 65536,
      timeCost: 3,
    });
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO devices
           (id, user_id, name, token_hash, created_at, last_seen_at, revoked_at)
         VALUES (@id, @user_id, @name, @hash, @ts, @ts, NULL)`,
      )
      .run({
        '@id': id,
        '@user_id': input.user_id,
        '@name': input.name,
        '@hash': token_hash,
        '@ts': now,
      });
    return { device_id: id, token };
  }

  /** Auth path: parse the bearer, look up by id, verify the secret.
   *  Returns the device row on match (and null on every failure mode —
   *  unknown id, revoked, hash mismatch — to keep the caller's error
   *  branch single and the timing relatively flat). */
  async find_by_token(token: string): Promise<DeviceRow | null> {
    const parsed = parse_bearer(token);
    if (!parsed) return null;
    const row = this.db
      .prepare(`SELECT * FROM devices WHERE id = @id`)
      .get({ '@id': parsed.dev_id }) as DeviceRow | undefined;
    if (!row) return null;
    if (row.revoked_at) return null;
    let ok = false;
    try {
      ok = await Bun.password.verify(parsed.secret, row.token_hash);
    } catch {
      ok = false;
    }
    return ok ? row : null;
  }

  /** Bump last_seen_at. Cheap. Middleware calls this on every
   *  bearer-authenticated request. */
  touch(dev_id: string): void {
    this.db
      .prepare(`UPDATE devices SET last_seen_at = @ts WHERE id = @id`)
      .run({ '@ts': new Date().toISOString(), '@id': dev_id });
  }

  /** List a user's devices (active ones — revoked rows hidden). */
  list_for_user(user_id: string, current_dev_id?: string | null): DeviceSafe[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, created_at, last_seen_at
           FROM devices
          WHERE user_id = @uid AND revoked_at IS NULL
          ORDER BY last_seen_at DESC`,
      )
      .all({ '@uid': user_id }) as Array<{
      id: string;
      name: string;
      created_at: string;
      last_seen_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      created_at: r.created_at,
      last_seen_at: r.last_seen_at,
      current: current_dev_id ? r.id === current_dev_id : false,
    }));
  }

  /** Soft-revoke. Subsequent find_by_token returns null; audit history
   *  (created_at, last_seen_at, revoked_at) is preserved. */
  revoke(dev_id: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE devices
            SET revoked_at = @ts
          WHERE id = @id AND revoked_at IS NULL`,
      )
      .run({ '@ts': new Date().toISOString(), '@id': dev_id });
    return Number(res.changes) > 0;
  }

  /** Used by /auth/devices/:id DELETE to confirm ownership before
   *  revoking — a user can only revoke their own devices. */
  get(dev_id: string): DeviceRow | null {
    const row = this.db
      .prepare(`SELECT * FROM devices WHERE id = @id`)
      .get({ '@id': dev_id }) as DeviceRow | undefined;
    return row ?? null;
  }
}
