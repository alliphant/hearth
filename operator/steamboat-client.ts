/**
 * steamboat-client.ts — Hearth-side client for agentd on the workstation.local
 *
 * Lives on the always-on host, imported by any Hearth agent that needs a real Firefox
 * browser session (Maggie, future librarian, etc.). Hides the wake / can-start
 * / session-spawn / sleep dance behind a single high-level call.
 *
 * Usage (typical agent):
 *
 *   import { configureClient, withBrowserSession } from './steamboat-client';
 *
 *   // Once at Hearth boot:
 *   configureClient({
 *     host: 'the workstation.local',
 *     port: 4446,
 *     mac: '02:00:00:00:00:2d',  // I219-LM copper, not the wifi ens3
 *     token: await Bun.file('/home/jasper/.config/agentd/token').text(),
 *   });
 *
 *   // Per task:
 *   await withBrowserSession(
 *     { agent: 'maggie', taskId: 'concerts-2026-05-24' },
 *     async (browser) => {
 *       await browser.url('https://www.mishawaka.com/calendar');
 *       const titles = await browser.$$('.event-title').map(e => e.getText());
 *       return titles;
 *     },
 *     async (reason) => {
 *       // onDeferred — called when Jasper is at the keyboard
 *       await hearth.promiseFollowup({
 *         when: 'tonight_2am',
 *         retry: 'concerts-2026-05-24',
 *         because: reason.reason,
 *       });
 *     },
 *   );
 *
 * Runtime deps: Bun >= 1.x, webdriverio >= 9 (peer dep — `bun add webdriverio`).
 */

import { createSocket } from 'node:dgram';
import { attach } from 'webdriverio';
import type { Browser } from 'webdriverio';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SteamboatClientOptions {
  host: string;                // e.g. "the workstation.local"
  port?: number;               // default 4446
  token: string;               // contents of /home/jasper/.config/agentd/token
  mac: string;                 // "02:00:00:00:00:2d" (I219-LM copper)
  wolBroadcast?: string;       // default "255.255.255.255"
  wakeTimeoutMs?: number;      // overall WoL→ready timeout, default 90_000
  fetchImpl?: typeof fetch;    // for tests
}

export interface HealthStatus {
  ok: boolean;
  version?: string;
}

export interface StatusResponse {
  ready: boolean;
  sessions_active: number;
  wake_marker_present: boolean;
  idle_seconds: number;
  will_suspend_at?: string;
}

export type CanStartResult =
  | { ok: true }
  | { ok: false; reason: string; details: Record<string, unknown> };

export interface SessionInfo {
  session_id: string;
  gd_session_id: string;
  webdriver_base: string;       // "http://the workstation.local:4446/wd"
  expires_at?: string;
}

export interface BrowserSessionOptions {
  agent: string;
  taskId: string;
  capabilities?: Record<string, unknown>;
  wakeTimeoutMs?: number;
}

export type DeferredHandler = (
  reason: Extract<CanStartResult, { ok: false }>,
) => Promise<unknown> | unknown;

// ─── Low-level client ───────────────────────────────────────────────────────

export class SteamboatClient {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly mac: string;
  readonly wolBroadcast: string;
  readonly wakeTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SteamboatClientOptions) {
    this.host = opts.host;
    this.port = opts.port ?? 4446;
    this.token = opts.token.trim();
    this.mac = opts.mac;
    this.wolBroadcast = opts.wolBroadcast ?? '255.255.255.255';
    this.wakeTimeoutMs = opts.wakeTimeoutMs ?? 90_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private url(path: string): string {
    return `http://${this.host}:${this.port}${path}`;
  }

  private headers(extra?: HeadersInit): HeadersInit {
    return { 'X-Agentd-Auth': this.token, ...extra };
  }

  /** Returns null if agentd is unreachable, status otherwise. No auth needed. */
  async health(timeoutMs = 2000): Promise<HealthStatus | null> {
    try {
      const res = await this.fetchImpl(this.url('/health'), {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      return (await res.json()) as HealthStatus;
    } catch {
      return null;
    }
  }

  async status(): Promise<StatusResponse> {
    const res = await this.fetchImpl(this.url('/status'), {
      headers: this.headers(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`status returned ${res.status}`);
    return (await res.json()) as StatusResponse;
  }

  /** Send WoL magic packet. Doesn't wait for the host to come up. */
  async sendWol(): Promise<void> {
    const packet = buildMagicPacket(this.mac);
    await new Promise<void>((resolve, reject) => {
      const sock = createSocket('udp4');
      sock.once('error', reject);
      sock.bind(0, () => {
        sock.setBroadcast(true);
        sock.send(packet, 9, this.wolBroadcast, (err) => {
          sock.close();
          if (err) reject(err); else resolve();
        });
      });
    });
  }

  /**
   * Bring the workstation up if it's asleep and register the wake marker.
   * No-op (still POSTs wake-ack) if it's already up.
   */
  async wake(opts: { taskId: string; timeoutMs?: number }): Promise<void> {
    const budget = opts.timeoutMs ?? this.wakeTimeoutMs;
    const deadline = Date.now() + budget;

    let h = await this.health();
    if (h == null) {
      await this.sendWol();
      // Poll every 2s until health comes back or budget exhausted.
      while (Date.now() < deadline) {
        await sleep(2000);
        h = await this.health();
        if (h?.ok) break;
      }
      if (h?.ok !== true) {
        throw new Error(
          `the workstation did not come up within ${budget}ms after WoL`,
        );
      }
    }

    const res = await this.fetchImpl(this.url('/wake-ack'), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ source: 'mint', task_id: opts.taskId }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`wake-ack returned ${res.status}`);
  }

  async canStart(agent: string): Promise<CanStartResult> {
    const res = await this.fetchImpl(
      this.url(`/can-start?agent=${encodeURIComponent(agent)}`),
      { headers: this.headers(), signal: AbortSignal.timeout(5000) },
    );
    if (res.status === 200) return { ok: true };
    if (res.status === 409) {
      return (await res.json()) as Extract<CanStartResult, { ok: false }>;
    }
    throw new Error(`can-start returned ${res.status}`);
  }

  async createSession(
    agent: string,
    capabilities?: Record<string, unknown>,
  ): Promise<SessionInfo> {
    const res = await this.fetchImpl(this.url('/sessions'), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ agent, capabilities }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`createSession returned ${res.status}: ${text}`);
    }
    return (await res.json()) as SessionInfo;
  }

  async deleteSession(gdSessionId: string): Promise<void> {
    const res = await this.fetchImpl(
      this.url(`/wd/session/${gdSessionId}`),
      {
        method: 'DELETE',
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      },
    );
    // 404 is fine — already gone.
    if (!res.ok && res.status !== 404) {
      throw new Error(`deleteSession returned ${res.status}`);
    }
  }
}

// ─── Singleton + convenience ────────────────────────────────────────────────

let _client: SteamboatClient | null = null;

export function configureClient(opts: SteamboatClientOptions): SteamboatClient {
  _client = new SteamboatClient(opts);
  return _client;
}

export function getClient(): SteamboatClient {
  if (!_client) {
    throw new Error('SteamboatClient not configured — call configureClient() first');
  }
  return _client;
}

/**
 * The recommended path for any agent task. Handles:
 *   1. Bring the workstation up if asleep (WoL + poll).
 *   2. Pre-flight check; defer if Jasper is at the keyboard.
 *   3. Spawn a per-agent Firefox session.
 *   4. Hand you a webdriverio Browser instance.
 *   5. Tear down on return or throw.
 *
 * Returns the result of `fn`, or the result of `onDeferred` if pre-flight
 * blocked (and onDeferred was provided). If blocked and no onDeferred, throws.
 */
export async function withBrowserSession<T>(
  opts: BrowserSessionOptions,
  fn: (browser: Browser) => Promise<T>,
  onDeferred?: DeferredHandler,
): Promise<T | undefined> {
  const client = getClient();

  await client.wake({ taskId: opts.taskId, timeoutMs: opts.wakeTimeoutMs });

  const pre = await client.canStart(opts.agent);
  if (!pre.ok) {
    if (onDeferred) {
      await onDeferred(pre);
      return undefined;
    }
    throw new DeferredError(pre);
  }

  const session = await client.createSession(opts.agent, opts.capabilities);

  let browser: Browser | null = null;
  try {
    browser = await attach({
      sessionId: session.gd_session_id,
      hostname: client.host,
      port: client.port,
      path: '/wd',
      protocol: 'http',
      headers: { 'X-Agentd-Auth': client.token },
    });
    return await fn(browser);
  } finally {
    // Best-effort: prefer the WebDriver delete (clean Firefox shutdown);
    // fall back to forcing teardown via the REST endpoint.
    try {
      if (browser) await browser.deleteSession();
    } catch {
      await client.deleteSession(session.gd_session_id).catch(() => {});
    }
  }
}

export class DeferredError extends Error {
  constructor(public readonly reason: Extract<CanStartResult, { ok: false }>) {
    super(`agentd refused start: ${reason.reason}`);
    this.name = 'DeferredError';
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function buildMagicPacket(mac: string): Buffer {
  const hex = mac.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) throw new Error(`Invalid MAC: ${mac}`);
  const macBytes = Buffer.from(hex, 'hex');
  const packet = Buffer.alloc(6 + 16 * 6);
  packet.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) macBytes.copy(packet, 6 + i * 6);
  return packet;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
