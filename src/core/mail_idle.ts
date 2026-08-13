/**
 * MailIdleDriver — the always-on Post Office ingest.
 *
 * Two layers, both fail-open:
 *
 *   1. POLL backbone (always on) — a periodic `sync_all` reconcile. This is
 *      the correctness guarantee: even if IDLE never establishes, every
 *      enabled account is pulled + triaged on the interval.
 *
 *   2. IMAP IDLE push (best-effort) — one long-lived imapflow connection per
 *      enabled account with an `exists` listener. The server pushes a
 *      new-mail signal down; we sync that account immediately (the
 *      low-latency "push" the office shows live). On a dropped connection it
 *      reconnects with backoff. If IDLE can't establish for an account, the
 *      poll still covers it.
 *
 * DARK by default: `attach()` is a no-op unless HEARTH_MAIL=1 (a new,
 * credential-bearing, network-touching feature defaults OFF). A throwing
 * account is logged + skipped, never aborting the others or the boot. Stop
 * closes every connection + timer.
 *
 * NOTE: the long-lived parked-IDLE socket under Bun is the one piece not
 * unit-tested (it needs a live account). The spike proved the imapflow TLS
 * path runs under Bun; the poll is the safety net while IDLE is validated
 * live. Set HEARTH_MAIL_IDLE=0 to run poll-only.
 */
import { ImapFlow } from 'imapflow';
import { Database } from 'bun:sqlite';
import type { LLMRouter } from '@core/llm';
import type { AppEventBus } from '@app/events';
import type { UserRegistry } from '@core/users';
import { MailAccounts, type MailAccount } from '@memory/stores/mail_accounts';
import { sync_all, type MailIngestDeps } from '@core/mail_ingest';

export function mail_enabled(): boolean {
  return process.env.HEARTH_MAIL === '1';
}
function idle_enabled(): boolean {
  return process.env.HEARTH_MAIL_IDLE !== '0';
}
function env_ms(name: string, def: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

interface IdleConn {
  client: ImapFlow;
  stop: boolean;
}

export class MailIdleDriver {
  private readonly accounts: MailAccounts;
  private readonly deps: MailIngestDeps;
  private readonly poll_ms: number;
  private poll_timer: ReturnType<typeof setInterval> | null = null;
  private readonly idle: Map<string, IdleConn> = new Map();
  private stopped = false;

  constructor(deps: { db: Database; llm?: LLMRouter; events?: AppEventBus; users?: UserRegistry }, opts: { poll_ms?: number } = {}) {
    this.accounts = new MailAccounts(deps.db);
    this.deps = { db: deps.db, llm: deps.llm, events: deps.events, users: deps.users };
    this.poll_ms = opts.poll_ms ?? env_ms('HEARTH_MAIL_POLL_MS', 5 * 60_000);
  }

  /** Wire at boot. No-op unless HEARTH_MAIL=1. Returns an unsubscribe/stop. */
  attach(events: AppEventBus): () => void {
    if (!mail_enabled()) return () => {};
    this.stopped = false;
    // Initial catch-up + the poll backbone.
    void this.reconcile();
    this.poll_timer = setInterval(() => void this.reconcile(), this.poll_ms);
    if (idle_enabled()) this.refresh_idle_loops();
    // An account added/edited in the gear should sync + (re)IDLE right away.
    const unsub = events.subscribe((e) => {
      if (e.type === 'mail_account_updated') {
        void this.sync_one(e.account_id);
        if (idle_enabled()) this.refresh_idle_loops();
      }
    });
    console.log(
      `[mail] MailIdleDriver attached (poll ${Math.round(this.poll_ms / 1000)}s, idle ${idle_enabled() ? 'on' : 'off'})`,
    );
    return () => {
      unsub();
      this.stop();
    };
  }

  private async reconcile(): Promise<void> {
    if (this.stopped) return;
    try {
      await sync_all(this.accounts, this.deps);
    } catch (err) {
      console.error('[mail] reconcile failed:', err);
    }
  }

  private async sync_one(account_id: string): Promise<void> {
    if (this.stopped) return;
    try {
      await sync_all(this.accounts, this.deps, { only_account_id: account_id });
    } catch (err) {
      console.error('[mail] sync_one failed:', account_id, err);
    }
  }

  /** Start an IDLE loop for every enabled account that lacks one; stop loops
   *  whose account is gone/disabled. Best-effort. */
  private refresh_idle_loops(): void {
    if (this.stopped) return;
    const enabled = new Map(this.accounts.list({ enabled_only: true }).map((a) => [a.id, a]));
    // Stop loops for accounts no longer enabled.
    for (const [id, conn] of this.idle) {
      if (!enabled.has(id)) {
        conn.stop = true;
        void conn.client.logout().catch(() => {});
        this.idle.delete(id);
      }
    }
    // Start loops for newly-enabled accounts.
    for (const [id, account] of enabled) {
      if (!this.idle.has(id)) void this.run_idle_loop(account);
    }
  }

  private async run_idle_loop(account: MailAccount): Promise<void> {
    if (this.idle.has(account.id)) return;
    const conn: IdleConn = {
      client: new ImapFlow({
        host: account.imap_host,
        port: account.imap_port,
        secure: true,
        auth: { user: account.imap_user, pass: account.imap_password },
        logger: false,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
      }),
      stop: false,
    };
    this.idle.set(account.id, conn);
    let backoff = 5_000;
    while (!this.stopped && !conn.stop) {
      try {
        await conn.client.connect();
        await conn.client.mailboxOpen('INBOX', { readOnly: true });
        backoff = 5_000; // healthy connection — reset backoff
        // imapflow auto-IDLEs while the mailbox is open and idle; on a new
        // message it emits `exists`. Trigger an immediate sync of this account.
        conn.client.on('exists', () => {
          if (!conn.stop) void this.sync_one(account.id);
        });
        // Park until the connection closes (server IDLE drop, network blip).
        await new Promise<void>((resolve) => {
          conn.client.on('close', () => resolve());
          conn.client.on('error', () => resolve());
        });
      } catch (err) {
        if (this.stopped || conn.stop) break;
        console.error(`[mail] IDLE loop error (acct ${account.id}), backoff ${backoff}ms:`, err);
      }
      if (this.stopped || conn.stop) break;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 5 * 60_000); // cap at 5 min
    }
    void conn.client.logout().catch(() => {});
    if (this.idle.get(account.id) === conn) this.idle.delete(account.id);
  }

  stop(): void {
    this.stopped = true;
    if (this.poll_timer) {
      clearInterval(this.poll_timer);
      this.poll_timer = null;
    }
    for (const conn of this.idle.values()) {
      conn.stop = true;
      void conn.client.logout().catch(() => {});
    }
    this.idle.clear();
  }
}
