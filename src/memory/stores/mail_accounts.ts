/**
 * MailAccounts — the secrets store for Kate's "Post Office" muscle.
 *
 * One row per configured email inbox (IMAP read + SMTP send). This is the
 * SAME secret-safety posture as CodeShopSettings, the only difference being
 * multi-row (per account) instead of a single owner-global row:
 *
 *   - Credentials (IMAP/SMTP passwords — app-specific passwords, never the
 *     account password) live ONLY in this table. Never in YAML, never in an
 *     LLM prompt or tool surface, never in an audit row.
 *   - The only callers that read the secret values are the IMAP ingest driver
 *     and the SMTP sender. Routes + the pane composer use `list_redacted()` /
 *     `get_redacted()`, which collapse each secret to a boolean.
 *   - The POST route audits the CHANGED KEY NAMES (`set()` returns them),
 *     never the values.
 *
 * The table is created in this store's constructor (CREATE TABLE IF NOT
 * EXISTS), not the central SCHEMA_SQL — self-contained, the same additive
 * pattern as CodeShopSettings / UserProfileStore. Columns are additive; no
 * SCHEMA_VERSION bump.
 *
 * Cordon: every account carries `private_to` ('owner' | 'household' | a
 * specific user_id). Read routes filter via `note_visible_to_caller`; the
 * owner has NO god-view (a 'household' account is shared, an 'owner' account
 * is the owner's alone). `private_to` is fail-closed, so `create()` REQUIRES
 * it — an unstamped account would vanish from household reads.
 */
import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';

/** Providers with known IMAP/SMTP endpoints; 'manual' = the user typed them. */
export type MailProvider = 'gmail' | 'icloud' | 'outlook' | 'fastmail' | 'manual';

/** Live connection health, set by the test/sync path (machine-owned). */
export type MailConnStatus = 'untested' | 'ok' | 'auth_failed' | 'unreachable';

/** A full account row, including secrets. Returned ONLY to the ingest driver
 *  and the SMTP sender — never to a route, pane, or LLM. */
export interface MailAccount {
  id: string;
  user_id: string;
  /** Cordon: 'owner' | 'household' | <user_id>. Fail-closed when unset. */
  private_to: string;
  display_name: string;
  provider: MailProvider;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  imap_password: string;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_password: string;
  enabled: boolean;
  connection_status: MailConnStatus;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const SECRET_KEYS = ['imap_password', 'smtp_password'] as const;
type SecretKey = (typeof SECRET_KEYS)[number];

/** What routes/panes get: every field minus the secret values, plus a
 *  boolean per secret indicating whether it is set. */
export type RedactedMailAccount = Omit<MailAccount, SecretKey> & {
  imap_password_set: boolean;
  smtp_password_set: boolean;
};

/** Fields a caller may set on create/update. `id`/timestamps are managed. */
export type MailAccountPatch = Partial<
  Omit<MailAccount, 'id' | 'created_at' | 'updated_at'>
>;

/** Endpoint presets the setup UI and manual-form validation share. One
 *  source of truth so a provider's host/port live in exactly one place. */
export interface MailPreset {
  label: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  /** Where the user generates an app-specific password (these providers
   *  require one with 2FA on — the account password will NOT work). */
  app_password_url: string;
  note: string;
}

export const MAIL_PRESETS: Record<Exclude<MailProvider, 'manual'>, MailPreset> = {
  gmail: {
    label: 'Gmail / Google',
    imap_host: 'imap.gmail.com',
    imap_port: 993,
    smtp_host: 'smtp.gmail.com',
    smtp_port: 587,
    app_password_url: 'https://myaccount.google.com/apppasswords',
    note: 'Requires 2-Step Verification, then an App Password (16 chars). Your normal password will not work.',
  },
  icloud: {
    label: 'iCloud / me.com',
    imap_host: 'imap.mail.me.com',
    imap_port: 993,
    smtp_host: 'smtp.mail.me.com',
    smtp_port: 587,
    app_password_url: 'https://appleid.apple.com/account/manage',
    note: 'Requires two-factor auth, then an app-specific password from appleid.apple.com.',
  },
  outlook: {
    label: 'Outlook / Microsoft 365',
    imap_host: 'outlook.office365.com',
    imap_port: 993,
    smtp_host: 'smtp.office365.com',
    smtp_port: 587,
    app_password_url: 'https://account.microsoft.com/security',
    note: 'Requires an app password if 2FA is enabled.',
  },
  fastmail: {
    label: 'Fastmail',
    imap_host: 'imap.fastmail.com',
    imap_port: 993,
    smtp_host: 'smtp.fastmail.com',
    smtp_port: 465,
    app_password_url: 'https://app.fastmail.com/settings/security/apppassword',
    note: 'Create an app password scoped to Mail (IMAP/SMTP).',
  },
};

interface Row {
  id: string;
  user_id: string;
  private_to: string;
  display_name: string;
  provider: string;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  imap_password: string;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_password: string;
  enabled: number;
  connection_status: string;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function hydrate(r: Row): MailAccount {
  return {
    id: r.id,
    user_id: r.user_id,
    private_to: r.private_to,
    display_name: r.display_name,
    provider: r.provider as MailProvider,
    imap_host: r.imap_host,
    imap_port: r.imap_port,
    imap_user: r.imap_user,
    imap_password: r.imap_password,
    smtp_host: r.smtp_host,
    smtp_port: r.smtp_port,
    smtp_user: r.smtp_user,
    smtp_password: r.smtp_password,
    enabled: r.enabled === 1,
    connection_status: r.connection_status as MailConnStatus,
    last_synced_at: r.last_synced_at,
    last_error: r.last_error,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function redact(a: MailAccount): RedactedMailAccount {
  const { imap_password, smtp_password, ...rest } = a;
  return {
    ...rest,
    imap_password_set: imap_password.length > 0,
    smtp_password_set: smtp_password.length > 0,
  };
}

export class MailAccounts {
  constructor(private db: Database) {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS mail_accounts (
         id TEXT PRIMARY KEY,
         user_id TEXT NOT NULL,
         private_to TEXT NOT NULL,
         display_name TEXT NOT NULL,
         provider TEXT NOT NULL,
         imap_host TEXT NOT NULL DEFAULT '',
         imap_port INTEGER NOT NULL DEFAULT 993,
         imap_user TEXT NOT NULL DEFAULT '',
         imap_password TEXT NOT NULL DEFAULT '',
         smtp_host TEXT NOT NULL DEFAULT '',
         smtp_port INTEGER NOT NULL DEFAULT 587,
         smtp_user TEXT NOT NULL DEFAULT '',
         smtp_password TEXT NOT NULL DEFAULT '',
         enabled INTEGER NOT NULL DEFAULT 1,
         connection_status TEXT NOT NULL DEFAULT 'untested',
         last_synced_at TEXT,
         last_error TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_mail_accounts_user ON mail_accounts(user_id)`,
    );
  }

  /** Full rows incl. secrets — ingest driver + sender only. */
  list(opts?: { enabled_only?: boolean }): MailAccount[] {
    const sql = opts?.enabled_only
      ? `SELECT * FROM mail_accounts WHERE enabled = 1 ORDER BY created_at ASC`
      : `SELECT * FROM mail_accounts ORDER BY created_at ASC`;
    return (this.db.prepare(sql).all() as Row[]).map(hydrate);
  }

  /** Redacted rows — routes + pane. */
  list_redacted(): RedactedMailAccount[] {
    return this.list().map(redact);
  }

  /** Full row incl. secrets — caller MUST cordon-check before use. */
  get(id: string): MailAccount | undefined {
    const r = this.db
      .prepare(`SELECT * FROM mail_accounts WHERE id = @id`)
      .get({ '@id': id }) as Row | undefined;
    return r ? hydrate(r) : undefined;
  }

  get_redacted(id: string): RedactedMailAccount | undefined {
    const a = this.get(id);
    return a ? redact(a) : undefined;
  }

  /** Create an account. `user_id`, `private_to`, `display_name`, `provider`
   *  are required (private_to is fail-closed, so it must be explicit). */
  create(input: {
    user_id: string;
    private_to: string;
    display_name: string;
    provider: MailProvider;
  } & MailAccountPatch): string {
    const id = `ma_${ulid().toLowerCase().slice(-12)}`;
    const now = new Date().toISOString();
    const preset =
      input.provider !== 'manual' ? MAIL_PRESETS[input.provider] : undefined;
    const row: Row = {
      id,
      user_id: input.user_id,
      private_to: input.private_to,
      display_name: input.display_name,
      provider: input.provider,
      imap_host: input.imap_host ?? preset?.imap_host ?? '',
      imap_port: input.imap_port ?? preset?.imap_port ?? 993,
      imap_user: input.imap_user ?? '',
      imap_password: input.imap_password ?? '',
      smtp_host: input.smtp_host ?? preset?.smtp_host ?? '',
      smtp_port: input.smtp_port ?? preset?.smtp_port ?? 587,
      smtp_user: input.smtp_user ?? '',
      smtp_password: input.smtp_password ?? '',
      enabled: input.enabled === false ? 0 : 1,
      connection_status: 'untested',
      last_synced_at: null,
      last_error: null,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO mail_accounts
           (id, user_id, private_to, display_name, provider,
            imap_host, imap_port, imap_user, imap_password,
            smtp_host, smtp_port, smtp_user, smtp_password,
            enabled, connection_status, last_synced_at, last_error,
            created_at, updated_at)
         VALUES
           (@id, @user_id, @private_to, @display_name, @provider,
            @imap_host, @imap_port, @imap_user, @imap_password,
            @smtp_host, @smtp_port, @smtp_user, @smtp_password,
            @enabled, @connection_status, @last_synced_at, @last_error,
            @created_at, @updated_at)`,
      )
      .run({
        '@id': row.id,
        '@user_id': row.user_id,
        '@private_to': row.private_to,
        '@display_name': row.display_name,
        '@provider': row.provider,
        '@imap_host': row.imap_host,
        '@imap_port': row.imap_port,
        '@imap_user': row.imap_user,
        '@imap_password': row.imap_password,
        '@smtp_host': row.smtp_host,
        '@smtp_port': row.smtp_port,
        '@smtp_user': row.smtp_user,
        '@smtp_password': row.smtp_password,
        '@enabled': row.enabled,
        '@connection_status': row.connection_status,
        '@last_synced_at': row.last_synced_at,
        '@last_error': row.last_error,
        '@created_at': row.created_at,
        '@updated_at': row.updated_at,
      });
    return id;
  }

  /** Patch a subset of fields. A secret given as '' or null is treated as
   *  "leave unchanged" (the GET never returns it, so a form re-submit with a
   *  blank password must not blank the stored one). Returns the changed keys
   *  (secrets reported by NAME only). */
  set(id: string, patch: MailAccountPatch): string[] {
    const current = this.get(id);
    if (!current) return [];
    const next: MailAccount = { ...current };
    const changed: string[] = [];
    for (const [k, v] of Object.entries(patch) as [keyof MailAccount, unknown][]) {
      if (v === undefined) continue;
      if (k === 'id' || k === 'created_at' || k === 'updated_at') continue;
      if ((SECRET_KEYS as readonly string[]).includes(k) && (v === '' || v === null)) {
        continue;
      }
      (next as unknown as Record<string, unknown>)[k] = v;
      changed.push(k);
    }
    if (changed.length === 0) return [];
    next.updated_at = new Date().toISOString();
    this.write(next);
    return changed;
  }

  /** Explicitly clear a stored secret (the form's "remove password"). */
  clear_secret(id: string, key: SecretKey): void {
    const current = this.get(id);
    if (!current) return;
    this.write({ ...current, [key]: '', updated_at: new Date().toISOString() });
  }

  /** Machine-owned connection health, set by test/sync. Never resets creds. */
  set_status(
    id: string,
    status: {
      connection_status: MailConnStatus;
      last_synced_at?: string | null;
      last_error?: string | null;
    },
  ): void {
    const current = this.get(id);
    if (!current) return;
    this.write({
      ...current,
      connection_status: status.connection_status,
      last_synced_at:
        status.last_synced_at !== undefined ? status.last_synced_at : current.last_synced_at,
      last_error: status.last_error !== undefined ? status.last_error : current.last_error,
      updated_at: new Date().toISOString(),
    });
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM mail_accounts WHERE id = @id`).run({ '@id': id });
  }

  private write(a: MailAccount): void {
    this.db
      .prepare(
        `UPDATE mail_accounts SET
           user_id = @user_id, private_to = @private_to, display_name = @display_name,
           provider = @provider, imap_host = @imap_host, imap_port = @imap_port,
           imap_user = @imap_user, imap_password = @imap_password,
           smtp_host = @smtp_host, smtp_port = @smtp_port, smtp_user = @smtp_user,
           smtp_password = @smtp_password, enabled = @enabled,
           connection_status = @connection_status, last_synced_at = @last_synced_at,
           last_error = @last_error, updated_at = @updated_at
         WHERE id = @id`,
      )
      .run({
        '@id': a.id,
        '@user_id': a.user_id,
        '@private_to': a.private_to,
        '@display_name': a.display_name,
        '@provider': a.provider,
        '@imap_host': a.imap_host,
        '@imap_port': a.imap_port,
        '@imap_user': a.imap_user,
        '@imap_password': a.imap_password,
        '@smtp_host': a.smtp_host,
        '@smtp_port': a.smtp_port,
        '@smtp_user': a.smtp_user,
        '@smtp_password': a.smtp_password,
        '@enabled': a.enabled ? 1 : 0,
        '@connection_status': a.connection_status,
        '@last_synced_at': a.last_synced_at,
        '@last_error': a.last_error,
        '@updated_at': a.updated_at,
      });
  }
}
