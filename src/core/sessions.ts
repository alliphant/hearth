/**
 * Web-session store for multi-user auth (Phase 1).
 *
 * Cookie-backed: the cookie value IS the session id (opaque ULID). All
 * authority is server-side — clients can't forge a session by editing
 * cookies because nothing in the cookie is meaningful without a row.
 *
 * Sliding 30-day expiry. Every authenticated request calls touch()
 * which updates last_seen_at and pushes expires_at forward, so active
 * users never get logged out mid-flow but idle sessions die on their
 * own. Revoke = DELETE the row.
 *
 * The store does NOT issue cookies or read them — that's the
 * middleware's job in app/router.ts. This store only knows about
 * rows in the sessions table.
 */
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionRow {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  ip: string | null;
  ua: string | null;
}

/**
 * Second-precision ISO8601 UTC. The native iOS/macOS client decodes dates
 * with ISO8601DateFormatter (`.iso8601`), which on macOS 15 / iOS 18 REJECTS
 * fractional seconds — so a millisecond `expires_at` made every real
 * email+password login fail to decode ("data couldn't be read because it
 * isn't in the correct format"). Drop the `.sss`, matching the calendar-write
 * path's second-precision emit. The client also gained a tolerant decoder
 * (hearth-ios HearthTransport); this stays as defense-in-depth so older
 * clients can still authenticate.
 */
function iso_seconds(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19) + 'Z';
}

export class SessionStore {
  constructor(private db: Database) {}

  create(input: { user_id: string; ip?: string | null; ua?: string | null }): SessionRow {
    const now = Date.now();
    const row: SessionRow = {
      id: `sess_${ulid().toLowerCase()}`,
      user_id: input.user_id,
      created_at: new Date(now).toISOString(),
      expires_at: iso_seconds(now + SESSION_TTL_MS),
      last_seen_at: new Date(now).toISOString(),
      ip: input.ip ?? null,
      ua: input.ua ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, ip, ua)
         VALUES (@id, @user_id, @created_at, @expires_at, @last_seen_at, @ip, @ua)`,
      )
      .run({
        '@id': row.id,
        '@user_id': row.user_id,
        '@created_at': row.created_at,
        '@expires_at': row.expires_at,
        '@last_seen_at': row.last_seen_at,
        '@ip': row.ip,
        '@ua': row.ua,
      });
    return row;
  }

  /** Return the session iff it exists AND hasn't expired. */
  get(id: string): SessionRow | null {
    if (!id) return null;
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE id = @id`)
      .get({ '@id': id }) as SessionRow | undefined;
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      // Expired — clean up lazily on read.
      this.revoke(id);
      return null;
    }
    return row;
  }

  /** Bump last_seen_at + slide expires_at forward. Called by the auth
   *  middleware on every authenticated hit. */
  touch(id: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE sessions
            SET last_seen_at = @last_seen,
                expires_at = @expires
          WHERE id = @id`,
      )
      .run({
        '@last_seen': new Date(now).toISOString(),
        '@expires': iso_seconds(now + SESSION_TTL_MS),
        '@id': id,
      });
  }

  revoke(id: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE id = @id`).run({ '@id': id });
  }

  revoke_all_for_user(user_id: string): number {
    const res = this.db
      .prepare(`DELETE FROM sessions WHERE user_id = @uid`)
      .run({ '@uid': user_id });
    return Number(res.changes);
  }

  /** Sweep expired rows. Cheap; run on a periodic timer or at boot. */
  prune_expired(): number {
    const res = this.db
      .prepare(`DELETE FROM sessions WHERE expires_at < @now`)
      .run({ '@now': new Date().toISOString() });
    return Number(res.changes);
  }

  list_for_user(user_id: string): SessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM sessions WHERE user_id = @uid ORDER BY last_seen_at DESC`,
      )
      .all({ '@uid': user_id }) as SessionRow[];
  }
}
