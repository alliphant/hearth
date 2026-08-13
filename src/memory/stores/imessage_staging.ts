/**
 * iMessage observer persistence — the opt-in registry + the TRANSIENT raw
 * staging buffer for the People observational engine (the iMessage signal
 * source, 2026-06-22). The richest friend channel, and the most sensitive
 * data source in the system; the privacy spine is load-bearing here.
 *
 * Three concerns, one cohesive additive module (the MailStore idiom — several
 * related tables in one file, `CREATE TABLE IF NOT EXISTS` in the ctor, no
 * SCHEMA_SQL edit, no SCHEMA_VERSION bump, named-sigil binds only):
 *
 *   1. `ImessageOptIn` — per-contact opt-in, **default OFF**. The macOS app
 *      reads this to decide which 1:1 threads to upload; the Friends card
 *      toggles it. Cordoned (`private_to` = the opting user) — a household
 *      member can't see (or ride) the owner's opt-ins.
 *
 *   2. `ImessageStaging` — the **transient** raw-window buffer. The macOS app
 *      uploads raw message windows (text + ts + from_me) here; the nightly
 *      distill consumes them and then **DROPS them** (`drop`). THIS STORE IS
 *      NEVER READ BY ANY USER-FACING SURFACE — only the distill reads it, then
 *      deletes. Hearth keeps only the DISTILLATE (durable facts → the person
 *      note; loops/life-events/topics → `person_observations`). The Mac's
 *      chat.db is the source of truth; re-distill = re-upload. This is the
 *      difference between a chief-of-staff and a wiretap.
 *
 *   3. `imessage_meta` — a tiny key/value cursor (the `last_distill_at` the
 *      cadence gate reads, so the distill clock is a tunable knob decoupled
 *      from the upload clock).
 *
 * Idempotency: a staged window keys on a deterministic `content_hash` of its
 * inputs, so a retry-upload of the identical window collapses (INSERT OR
 * IGNORE) rather than double-staging. An `attempts` counter bounds raw
 * retention even on a persistently-failing distill (the privacy backstop).
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { note_visible_to_caller, type Caller } from '@memory/private_to';

// ── Opt-in registry ──────────────────────────────────────────────────────────

export interface OptInRow {
  person_id: string;
  user_id: string;
  private_to: string;
  enabled: boolean;
  updated_at: string;
}

interface OptInDbRow {
  person_id: string;
  user_id: string;
  private_to: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export class ImessageOptIn {
  constructor(private db: Database) {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS imessage_opt_in (
         person_id TEXT PRIMARY KEY,
         user_id TEXT NOT NULL,
         private_to TEXT NOT NULL DEFAULT 'owner',
         enabled INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    );
  }

  /** Set a contact's opt-in. Default OFF — a row exists only once toggled.
   *  `private_to` is the opting user (owner-only by default), so the registry
   *  is itself cordoned. Upsert; preserves created_at. */
  set(person_id: string, user_id: string, private_to: string, enabled: boolean): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO imessage_opt_in (person_id, user_id, private_to, enabled, created_at, updated_at)
         VALUES (@p, @u, @pt, @e, @now, @now)
         ON CONFLICT(person_id) DO UPDATE SET
           user_id = @u, private_to = @pt, enabled = @e, updated_at = @now`,
      )
      .run({ '@p': person_id, '@u': user_id, '@pt': private_to, '@e': enabled ? 1 : 0, '@now': now });
  }

  /** Is this contact opted in at all? (display / quick check) */
  is_enabled(person_id: string): boolean {
    const r = this.db
      .prepare(`SELECT enabled FROM imessage_opt_in WHERE person_id = @p`)
      .get({ '@p': person_id }) as { enabled: number } | undefined;
    return r?.enabled === 1;
  }

  /** The ingest gate: opted in AND owned by THIS uploader (a user can't ride
   *  another user's opt-in). */
  is_enabled_for(person_id: string, user_id: string): boolean {
    const r = this.db
      .prepare(`SELECT enabled FROM imessage_opt_in WHERE person_id = @p AND user_id = @u`)
      .get({ '@p': person_id, '@u': user_id }) as { enabled: number } | undefined;
    return r?.enabled === 1;
  }

  get(person_id: string): OptInRow | null {
    const r = this.db
      .prepare(`SELECT * FROM imessage_opt_in WHERE person_id = @p`)
      .get({ '@p': person_id }) as OptInDbRow | undefined;
    return r ? { person_id: r.person_id, user_id: r.user_id, private_to: r.private_to, enabled: r.enabled === 1, updated_at: r.updated_at } : null;
  }

  /** Cordon-filtered set of person_ids that are enabled AND visible to the
   *  caller (the Friends-card display + the macOS app's upload allowlist). */
  enabled_set(caller: Caller): Set<string> {
    const rows = this.db
      .prepare(`SELECT person_id, private_to FROM imessage_opt_in WHERE enabled = 1`)
      .all() as Array<{ person_id: string; private_to: string }>;
    const out = new Set<string>();
    for (const r of rows) if (note_visible_to_caller(r.private_to, caller)) out.add(r.person_id);
    return out;
  }
}

// ── Transient raw-window staging ───────────────────────────────────────────────

/** One uploaded iMessage line: speaker-attributed, ISO ts (the macOS app
 *  converts Apple's nanosecond epoch → ISO before upload). */
export interface StagedMessage {
  text: string;
  /** ISO 8601 UTC. */
  ts: string;
  /** true when the OWNER sent it (drives open-loop directionality). */
  from_me: boolean;
}

export interface StageInput {
  person_id: string;
  /** The uploading user (owner). The raw window is cordoned to them. */
  user_id: string;
  private_to: string;
  chat_guid?: string;
  window_start?: string;
  window_end?: string;
  messages: StagedMessage[];
}

export interface StagedWindow {
  id: string;
  person_id: string;
  user_id: string;
  private_to: string;
  chat_guid: string;
  window_start: string | null;
  window_end: string | null;
  messages: StagedMessage[];
  attempts: number;
  received_at: string;
}

interface StagedDbRow {
  id: string;
  person_id: string;
  user_id: string;
  private_to: string;
  chat_guid: string;
  messages_json: string;
  window_start: string | null;
  window_end: string | null;
  content_hash: string;
  attempts: number;
  received_at: string;
}

function parse_messages(json: string): StagedMessage[] {
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v
      .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
      .map((m) => ({ text: String(m.text ?? ''), ts: String(m.ts ?? ''), from_me: m.from_me === true }));
  } catch {
    return [];
  }
}

function hydrate_window(r: StagedDbRow): StagedWindow {
  return {
    id: r.id,
    person_id: r.person_id,
    user_id: r.user_id,
    private_to: r.private_to,
    chat_guid: r.chat_guid,
    window_start: r.window_start,
    window_end: r.window_end,
    messages: parse_messages(r.messages_json),
    attempts: r.attempts,
    received_at: r.received_at,
  };
}

export class ImessageStaging {
  constructor(private db: Database) {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS imessage_staging (
         id TEXT PRIMARY KEY,
         person_id TEXT NOT NULL,
         user_id TEXT NOT NULL,
         private_to TEXT NOT NULL,
         chat_guid TEXT NOT NULL DEFAULT '',
         messages_json TEXT NOT NULL DEFAULT '[]',
         window_start TEXT,
         window_end TEXT,
         content_hash TEXT NOT NULL,
         attempts INTEGER NOT NULL DEFAULT 0,
         received_at TEXT NOT NULL,
         UNIQUE(content_hash)
       )`,
    );
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_imsg_stage_person ON imessage_staging(person_id)`);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS imessage_meta (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    );
  }

  /** Deterministic hash of a window's inputs (NOT time/ulid) — a retry-upload
   *  of the identical window collapses rather than double-staging. */
  static content_hash(input: StageInput): string {
    const h = createHash('sha256');
    h.update(input.person_id);
    h.update('\n');
    h.update(input.chat_guid ?? '');
    h.update('\n');
    h.update(input.window_start ?? '');
    h.update('\n');
    h.update(input.window_end ?? '');
    h.update('\n');
    for (const m of input.messages) {
      h.update(m.from_me ? '1' : '0');
      h.update(m.ts);
      h.update(m.text);
      h.update(' ');
    }
    return h.digest('hex').slice(0, 32);
  }

  /** Stage a raw window. Idempotent on content_hash (retry-safe). Returns
   *  whether the row was newly inserted. */
  stage(input: StageInput): { id: string; is_new: boolean } {
    const hash = ImessageStaging.content_hash(input);
    const existing = this.db
      .prepare(`SELECT id FROM imessage_staging WHERE content_hash = @h`)
      .get({ '@h': hash }) as { id: string } | undefined;
    if (existing) return { id: existing.id, is_new: false };
    const id = `im_${ulid().toLowerCase().slice(-16)}`;
    this.db
      .prepare(
        `INSERT INTO imessage_staging
           (id, person_id, user_id, private_to, chat_guid, messages_json,
            window_start, window_end, content_hash, attempts, received_at)
         VALUES
           (@id, @person_id, @user_id, @private_to, @chat_guid, @messages_json,
            @window_start, @window_end, @content_hash, 0, @received_at)`,
      )
      .run({
        '@id': id,
        '@person_id': input.person_id,
        '@user_id': input.user_id,
        '@private_to': input.private_to,
        '@chat_guid': input.chat_guid ?? '',
        '@messages_json': JSON.stringify(input.messages ?? []),
        '@window_start': input.window_start ?? null,
        '@window_end': input.window_end ?? null,
        '@content_hash': hash,
        '@received_at': new Date().toISOString(),
      });
    return { id, is_new: true };
  }

  /** Distinct person_ids that have pending (un-distilled) staged windows. */
  pending_person_ids(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT person_id FROM imessage_staging ORDER BY person_id`)
      .all() as Array<{ person_id: string }>;
    return rows.map((r) => r.person_id);
  }

  /** Pending windows for a person, oldest-received first. */
  pending_for_person(person_id: string): StagedWindow[] {
    const rows = this.db
      .prepare(`SELECT * FROM imessage_staging WHERE person_id = @p ORDER BY received_at ASC`)
      .all({ '@p': person_id }) as StagedDbRow[];
    return rows.map(hydrate_window);
  }

  /** The TRANSIENT consume — drop staged rows once the distill has extracted
   *  their distillate. After this, the raw is gone; re-distill = re-upload. */
  drop(ids: string[]): number {
    let n = 0;
    const stmt = this.db.prepare(`DELETE FROM imessage_staging WHERE id = @id`);
    for (const id of ids) n += stmt.run({ '@id': id }).changes as number;
    return n;
  }

  /** Increment the failed-distill counter on a person's pending rows (the
   *  retention backstop — see `exhausted_ids`). */
  bump_attempts(ids: string[]): void {
    const stmt = this.db.prepare(`UPDATE imessage_staging SET attempts = attempts + 1 WHERE id = @id`);
    for (const id of ids) stmt.run({ '@id': id });
  }

  /** Ids whose distill has failed `>= max_attempts` times — dropped to bound
   *  how long raw can linger when a distill persistently errors. */
  exhausted_ids(max_attempts: number): string[] {
    const rows = this.db
      .prepare(`SELECT id FROM imessage_staging WHERE attempts >= @m`)
      .all({ '@m': max_attempts }) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /** Total pending staged rows (observability / smoke). */
  count(): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM imessage_staging`).get() as { n: number };
    return r.n;
  }

  // ── meta cursor (the cadence gate reads/writes last_distill_at) ──────────────

  get_meta(key: string): string | null {
    const r = this.db.prepare(`SELECT value FROM imessage_meta WHERE key = @k`).get({ '@k': key }) as
      | { value: string }
      | undefined;
    return r?.value ?? null;
  }

  set_meta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO imessage_meta (key, value, updated_at) VALUES (@k, @v, @now)
         ON CONFLICT(key) DO UPDATE SET value = @v, updated_at = @now`,
      )
      .run({ '@k': key, '@v': value, '@now': new Date().toISOString() });
  }
}
