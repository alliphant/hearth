/**
 * avalanche — Hearth-side client for agentd on the workstation.local + the
 * `browse_url` Tool that lets Maggie (and future browser-using
 * specialists) drive a real Firefox session through it.
 *
 * Topology (see architecture.md "Browser specialist surface"):
 *   the always-on host (this process) ──HTTP──► the workstation:4446 (agentd)
 *                                     │
 *                                     ├─ kwin_wayland --virtual --xwayland
 *                                     ├─ geckodriver (localhost-bound)
 *                                     └─ firefox -P <agent>
 *
 * Configuration is env-driven (matches every other connector in this
 * directory). At runtime, getClient() lazy-initializes on first use:
 *
 *   AVALANCHE_HOST          default "the workstation.local" — resolves to the
 *                                   wifi interface (ens3, 10 GbE WiFi 7,
 *                                   currently 192.168.0.11). This is the
 *                                   DATA path: SSH, sshfs, agentd session +
 *                                   WebDriver traffic.
 *   AVALANCHE_HEALTH_HOST   default = AVALANCHE_HOST. Set to the COPPER NIC
 *                                   IP (192.168.0.83) so wake DETECTION and
 *                                   /wake-ack hit the interface that's up
 *                                   the instant WoL wakes the box. agentd
 *                                   binds 0.0.0.0, so the same process
 *                                   answers on both NICs. Splitting this
 *                                   from AVALANCHE_HOST is what stops a
 *                                   slow-to-re-associate WiFi NIC from
 *                                   reading as "box never woke" — see
 *                                   AvalancheClient.wake()'s two phases.
 *   AVALANCHE_PORT          default "4446"
 *   AVALANCHE_MAC           default "02:00:00:00:00:2d" — the I219-LM copper
 *                                   NIC (enp44s31f6, 1 GbE, 192.168.0.83).
 *                                   WoL-only. Copper stays powered through
 *                                   S3 suspend; the WiFi 7 NIC can't WoL
 *                                   through suspend reliably. Don't
 *                                   conflate the two interfaces — copper
 *                                   wakes the box, wifi carries the work.
 *   AVALANCHE_TOKEN_PATH    default "~/.config/agentd/token"
 *   AVALANCHE_WAKE_TIMEOUT  default "240000" (ms). Raised from 90s on
 *                                   2026-07-29: 90s covers a resume from
 *                                   suspend but NOT a cold boot, so every
 *                                   browse_url against a powered-off box
 *                                   failed while WoL was in fact working.
 *
 * Audit redaction: see redact_for_audit() at the bottom — URLs are
 * recorded host-only by default, mirroring the maps-connector pattern
 * for sensitive data (config/privacy.yaml `browse.audit_redaction`).
 */

import { createSocket } from 'node:dgram';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { z } from 'zod';
import { attach } from 'webdriverio';
import type { Browser } from 'webdriverio';
import type { Tool, ToolContext } from '@core/tool';
import { browse_audit_redaction_enabled } from '@core/privacy';

// ─── Client types ───────────────────────────────────────────────────────────

export interface AvalancheClientOptions {
  host: string;
  /** Host used for wake detection + /wake-ack. Defaults to `host`. Set to
   *  the copper NIC IP so power-on is detected on the interface that comes
   *  up immediately after WoL, independent of the slower WiFi session NIC. */
  healthHost?: string;
  port?: number;
  token: string;
  mac: string;
  wolBroadcast?: string;
  /** When set, the magic packet is sent by POSTing the host-network
   *  WoL relay (ops/wol-relay/relay.ts) instead of broadcasting directly.
   *  Required when this process runs in a Docker bridge network, whose
   *  broadcast never reaches the physical LAN — see the relay's header and
   *  architecture.md "Browser specialist surface". Falls back to a direct
   *  broadcast if the relay call fails. */
  wolRelayUrl?: string;
  /** Bearer token the relay requires on POST /wake. */
  wolRelayToken?: string;
  wakeTimeoutMs?: number;
  /** This host NEVER sleeps (the always-on host), so there is nothing to wake: skip WoL and
   *  skip /wake-ack entirely and treat wake() as a plain reachability probe.
   *
   *  This is not merely an optimization. An always-on agentd REFUSES
   *  /wake-ack with 409 (arming a suspend path there would take the FRIDAY
   *  kiosk, Firecrawl and Home Assistant down with it), and wake() throws on
   *  any non-200 — so without this flag every single call to an always-on
   *  host would fail at the last step of wake(). */
  alwaysOn?: boolean;
  /** Human-readable host label used in errors and logs ("mint" / "avalanche"),
   *  so a failure says WHICH browser host it came from. */
  name?: string;
  fetchImpl?: typeof fetch;
}

export interface HealthStatus {
  ok: boolean;
  version?: string;
}

/** One live agentd session as reported by /status. */
export interface AgentdSession {
  session_id: string;
  gd_session_id: string;
  agent: string;
  started_at?: string;
  last_activity_at?: string;
}

export interface StatusResponse {
  ready: boolean;
  sessions_active: number;
  wake_marker_present: boolean;
  idle_seconds: number;
  will_suspend_at?: string;
  /** Active sessions (present in agentd's /status payload). */
  sessions?: AgentdSession[];
}

export type CanStartResult =
  | { ok: true }
  | { ok: false; reason: string; details: Record<string, unknown> };

export interface SessionInfo {
  session_id: string;
  gd_session_id: string;
  webdriver_base: string;
  expires_at?: string;
}

export interface BrowserSessionOptions {
  agent: string;
  taskId: string;
  capabilities?: Record<string, unknown>;
  wakeTimeoutMs?: number;
  /** Which browser host to run on. Defaults to the primary (getClient()).
   *  Pass getFallbackClient() ONLY as a deliberate last-resort escalation —
   *  on the WoL host that means physically powering a workstation on. */
  client?: AvalancheClient;
}

export type DeferredHandler = (
  reason: Extract<CanStartResult, { ok: false }>,
) => Promise<unknown> | unknown;

// ─── Low-level client ───────────────────────────────────────────────────────

export class AvalancheClient {
  readonly host: string;
  readonly healthHost: string;
  readonly port: number;
  readonly token: string;
  readonly mac: string;
  readonly wolBroadcast: string;
  readonly wolRelayUrl: string | undefined;
  readonly wolRelayToken: string | undefined;
  readonly wakeTimeoutMs: number;
  readonly alwaysOn: boolean;
  readonly name: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AvalancheClientOptions) {
    this.host = opts.host;
    this.healthHost = opts.healthHost ?? opts.host;
    this.port = opts.port ?? 4446;
    this.token = opts.token.trim();
    this.mac = opts.mac;
    this.wolBroadcast = opts.wolBroadcast ?? '255.255.255.255';
    this.wolRelayUrl = opts.wolRelayUrl?.replace(/\/+$/, '') || undefined;
    this.wolRelayToken = opts.wolRelayToken?.trim() || undefined;
    // 90s was a resume-from-suspend budget. A box that is fully OFF needs a
    // cold boot (POST + OS + agentd), which routinely exceeds it — Ruby's
    // 2026-07-29 civic passes lost browse_url 5-8 times in a row to this
    // while both hosts answered /health fine minutes later. Wake is its own
    // step, so a longer budget costs nothing on an already-awake box.
    this.wakeTimeoutMs = opts.wakeTimeoutMs ?? 240_000;
    this.alwaysOn = opts.alwaysOn ?? false;
    this.name = opts.name ?? opts.host;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private url(path: string, host: string = this.host): string {
    return `http://${host}:${this.port}${path}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { 'X-Agentd-Auth': this.token, ...(extra ?? {}) };
  }

  async health(
    timeoutMs = 2000,
    host: string = this.healthHost,
  ): Promise<HealthStatus | null> {
    try {
      const res = await this.fetchImpl(this.url('/health', host), {
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

  /**
   * Send the Wake-on-LAN magic packet.
   *
   * Prefers the host-network relay (`wolRelayUrl`) when configured: this
   * process runs in a Docker bridge network whose broadcast never reaches
   * the physical LAN, so a direct broadcast from here is a no-op. The relay
   * shares the host net namespace and broadcasts on the real LAN. If the
   * relay call fails (down/misconfigured), fall back to a direct broadcast
   * — harmless when it can't reach the LAN, and the correct path for
   * non-containerized / single-host deploys with no relay configured.
   */
  async sendWol(): Promise<void> {
    if (this.wolRelayUrl) {
      try {
        await this.sendWolViaRelay();
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[avalanche] WoL relay (${this.wolRelayUrl}) failed: ${msg} — ` +
            `falling back to direct broadcast`,
        );
      }
    }
    await this.sendWolDirect();
  }

  private async sendWolViaRelay(): Promise<void> {
    const res = await this.fetchImpl(`${this.wolRelayUrl}/wake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.wolRelayToken ? { Authorization: `Bearer ${this.wolRelayToken}` } : {}),
      },
      body: JSON.stringify({ mac: this.mac, broadcast: this.wolBroadcast }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`relay /wake returned ${res.status}: ${text}`);
    }
  }

  private async sendWolDirect(): Promise<void> {
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
   * Bring the workstation up and confirm it's reachable for a session.
   *
   * Two-phase, because WoL wakes the box through the COPPER NIC
   * (healthHost) but the 10 GbE WiFi NIC (host) that carries session +
   * WebDriver traffic re-associates more slowly after S3 resume:
   *
   *   1. Detect power-on via healthHost (copper). It answers within a
   *      second of the box waking, so a copper /health miss across the
   *      whole budget means the box genuinely did not power on (WoL or
   *      BIOS problem) — NOT a slow NIC.
   *   2. Once powered on, wait for the session host (host / WiFi) to
   *      answer too, within the remaining budget. agentd binds 0.0.0.0,
   *      so the same process answers on both NICs; this step gates only
   *      on the WiFi interface actually being back. A copper-up-but-
   *      host-down timeout is the WiFi-slow-resume case and says so.
   *
   * When healthHost === host (single-NIC setups) phase 2 is a no-op and
   * behavior is identical to the original single-probe wake.
   */
  async wake(opts: { taskId: string; timeoutMs?: number }): Promise<void> {
    const budget = opts.timeoutMs ?? this.wakeTimeoutMs;
    const deadline = Date.now() + budget;

    // ALWAYS-ON HOST — nothing to wake. Probe reachability and return. No WoL
    // (there is no sleeping box to raise) and NO /wake-ack: an always-on
    // agentd answers that with 409 by design, and the check below would turn
    // that into a thrown error on every call.
    if (this.alwaysOn) {
      const h = await this.health(5000, this.healthHost);
      if (h?.ok !== true) {
        throw new HostUnreachableError(
          this.name,
          `${this.name} (always-on browser host) is not answering /health at ` +
            `${this.healthHost}:${this.port} — the daemon is down or the host is off ` +
            `the network; this host is never expected to sleep, so there is nothing to wake`,
        );
      }
      return;
    }

    // Phase 1 — power-on, detected on the reliable copper NIC.
    let h = await this.health(2000, this.healthHost);
    if (h == null) {
      await this.sendWol();
      while (Date.now() < deadline) {
        await sleep(2000);
        h = await this.health(2000, this.healthHost);
        if (h?.ok) break;
      }
      if (h?.ok !== true) {
        throw new Error(
          `${this.name} did not answer /health within ${budget}ms after WoL ` +
            `(probed ${this.healthHost}:${this.port}). If the box answers /health a few ` +
            `minutes later, WoL worked and the budget was simply short of a cold boot — ` +
            `raise AVALANCHE_WAKE_TIMEOUT. Suspect WoL or BIOS only when the host stays ` +
            `unreachable after that.`,
        );
      }
    }

    // Phase 2 — session NIC reachable (no-op when it's the same host).
    if (this.healthHost !== this.host) {
      let s = await this.health(2000, this.host);
      while (s?.ok !== true && Date.now() < deadline) {
        await sleep(2000);
        s = await this.health(2000, this.host);
      }
      if (s?.ok !== true) {
        throw new Error(
          `the workstation powered on (${this.healthHost} up) but session NIC ` +
            `${this.host}:${this.port} not reachable within ${budget}ms — ` +
            `WiFi likely slow or failed to re-associate after resume`,
        );
      }
    }

    // wake-ack on the reliable NIC.
    const res = await this.fetchImpl(this.url('/wake-ack', this.healthHost), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ source: 'glacier', task_id: opts.taskId }),
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
    if (res.status === 409) {
      // agentd refuses the spawn: either the activity gate tripped
      // (`user_busy`) or a live Firefox holds the target profile
      // (`profile_in_use` — Jasper's own interactive session). Both are
      // "come back later", not failures — surface as a deferral.
      const body = (await res.json().catch(() => ({}))) as {
        reason?: string;
        details?: Record<string, unknown>;
        blockers?: unknown;
      };
      throw new DeferredError({
        ok: false,
        reason: body.reason ?? 'user_busy',
        details: body.details ?? (body.blockers ? { blockers: body.blockers } : {}),
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`createSession returned ${res.status}: ${text}`);
    }
    return (await res.json()) as SessionInfo;
  }

  /**
   * Force teardown via agentd's own session route (`DELETE /sessions/{id}`),
   * which kills the session's Firefox process directly (reapFirefox) even when
   * the clean WebDriver DELETE would HANG on a wedged geckodriver. This is the
   * recovery path `deleteSession` can't cover — a geckodriver that stopped
   * answering. `sessionId` is the agentd session id (status `session_id`), not
   * the gd session id. Returns false when agentd already has no such session.
   */
  async forceTeardown(sessionId: string): Promise<boolean> {
    const res = await this.fetchImpl(this.url(`/sessions/${sessionId}`), {
      method: 'DELETE',
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return false; // already gone — nothing to reap
    if (!res.ok) throw new Error(`forceTeardown returned ${res.status}`);
    return true;
  }

  /** Clean shutdown — goes through geckodriver's WebDriver DELETE. */
  async deleteSession(gdSessionId: string): Promise<void> {
    const res = await this.fetchImpl(
      this.url(`/wd/session/${gdSessionId}`),
      {
        method: 'DELETE',
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`deleteSession returned ${res.status}`);
    }
  }

  /**
   * Reap any agentd session still open for `agent` and return how many were
   * cleared. Called pre-flight by withBrowserSession: the caller holds the
   * per-agent lock and owns no live browser, so a session agentd still reports
   * for this agent is an ORPHAN from a crashed/restarted prior run (a hard
   * restart / SIGKILL skips the teardown `finally`, leaving the remote
   * geckodriver session alive → the agent reads as busy forever). Reaping it
   * here self-heals that without touching the activity gate — a genuine
   * user-at-keyboard deferral still surfaces via canStart's `user_busy`.
   */
  async reapAgentSessions(agent: string): Promise<number> {
    let status: StatusResponse;
    try {
      status = await this.status();
    } catch {
      return 0; // status unreachable — let canStart/createSession decide
    }
    const orphans = (status.sessions ?? []).filter((s) => s.agent === agent && s.gd_session_id);
    let cleared = 0;
    for (const s of orphans) {
      try {
        await this.deleteSession(s.gd_session_id);
        cleared++;
      } catch {
        // The clean WebDriver DELETE failed — most often a wedged geckodriver
        // that stopped answering. Fall back to a force teardown via agentd's
        // session route, which kills the Firefox process directly regardless
        // of geckodriver state. Best-effort either way.
        try {
          if (await this.forceTeardown(s.session_id)) cleared++;
        } catch {
          /* both paths failed; canStart will defer as before */
        }
      }
    }
    return cleared;
  }
}

// ─── Lazy singleton + env config ────────────────────────────────────────────

let _client: AvalancheClient | null = null;

function expand_home(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, homedir()) : p;
}

function read_token_or_throw(path: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `avalanche: token file not found at ${path} — see MINT-SETUP.md step 3`,
    );
  }
  return readFileSync(path, 'utf8').trim();
}

/** Explicit override (tests + boot wiring). After this, getClient() returns it. */
export function configureClient(opts: AvalancheClientOptions): AvalancheClient {
  _client = new AvalancheClient(opts);
  return _client;
}

/**
 * The WoL workstation host (the workstation). Historically the ONLY browser host,
 * which is why its env vars are unprefixed-legacy `AVALANCHE_*`. Since
 * 2026-07-28 it is the LAST-RESORT fallback behind the always-on primary.
 */
function build_avalanche_client(): AvalancheClient {
  const token_path = expand_home(
    process.env.AVALANCHE_TOKEN_PATH ?? '~/.config/agentd/token',
  );
  return new AvalancheClient({
    name: 'avalanche',
    host: process.env.AVALANCHE_HOST ?? 'the workstation.local',
    // undefined when unset → ctor falls back to `host` (single-probe wake)
    healthHost: process.env.AVALANCHE_HEALTH_HOST,
    port: Number(process.env.AVALANCHE_PORT ?? '4446'),
    mac: process.env.AVALANCHE_MAC ?? '02:00:00:00:00:2d',
    // Default 255.255.255.255 in the ctor; set AVALANCHE_WOL_BROADCAST to the
    // LAN directed broadcast (e.g. 192.168.0.255) — the target the relay puts
    // on the wire — when running behind the relay.
    wolBroadcast: process.env.AVALANCHE_WOL_BROADCAST,
    // When the orchestrator runs in a Docker bridge network, route the WoL
    // through the host-network relay (ops/wol-relay) — a bridge broadcast
    // never reaches the LAN. Unset → direct broadcast (single-host deploys).
    wolRelayUrl: process.env.AVALANCHE_WOL_RELAY_URL,
    wolRelayToken: process.env.AVALANCHE_WOL_RELAY_TOKEN,
    token: read_token_or_throw(token_path),
    wakeTimeoutMs: Number(process.env.AVALANCHE_WAKE_TIMEOUT ?? '240000'),
  });
}

/**
 * The ALWAYS-ON primary browser host (the always-on host), when configured.
 *
 * the always-on host is the right default for browsing on every axis that matters here: it
 * is already up 24/7 (FRIDAY kiosk, Firecrawl, Home Assistant), so a scrape
 * costs no power-on and no wake latency, and it already runs Firecrawl — which
 * makes `web_fetch_clean → browse_url` a single-box escalation. the workstation is a
 * workstation with a discrete GPU whose POST + resume dumps heat into a house
 * that clears it slowly; waking it is a genuine last resort, not a failover.
 *
 * Returns null when BROWSER_HOST is unset, in which case the primary IS
 * the workstation and behavior is exactly what it was before this tier existed.
 */
function build_primary_client(): AvalancheClient | null {
  const host = process.env.BROWSER_HOST?.trim();
  if (!host) return null;
  const token_path = expand_home(
    process.env.BROWSER_TOKEN_PATH ??
      process.env.AVALANCHE_TOKEN_PATH ??
      '~/.config/agentd/token',
  );
  return new AvalancheClient({
    name: process.env.BROWSER_HOST_NAME ?? 'mint',
    host,
    port: Number(process.env.BROWSER_PORT ?? '4446'),
    token: read_token_or_throw(token_path),
    // No WoL: an always-on host has no MAC to wake and never sleeps. The
    // field is required by the options type, so it is deliberately blank —
    // sendWol() is unreachable for this client (wake() returns early).
    mac: '',
    alwaysOn: true,
  });
}

let _fallback_client: AvalancheClient | null | undefined;

/**
 * The last-resort fallback host, or null when there isn't one.
 *
 * Gated on BROWSER_FALLBACK_ENABLED because reaching it WAKES A WORKSTATION.
 * Callers must treat this as an explicit, content-driven escalation — never a
 * retry path for a timeout, a 503, or a deferral. See should_escalate_to_fallback().
 */
export function getFallbackClient(): AvalancheClient | null {
  if (_fallback_client !== undefined) return _fallback_client;
  const enabled = (process.env.BROWSER_FALLBACK_ENABLED ?? '0') === '1';
  // With no primary configured, the workstation already IS the primary — a
  // "fallback" to the same box would just be a pointless second attempt.
  _fallback_client =
    enabled && process.env.BROWSER_HOST?.trim() ? build_avalanche_client() : null;
  return _fallback_client;
}

/** Lazy init from env if configureClient() was never called. */
export function getClient(): AvalancheClient {
  if (_client) return _client;
  _client = build_primary_client() ?? build_avalanche_client();
  return _client;
}

/** For tests / fresh re-init. */
export function resetClient(): void {
  _client = null;
  _fallback_client = undefined;
}

// ─── Per-agent serialization ────────────────────────────────────────────────

// agentd v1 serializes per-agent and 503s for cross-agent concurrent sessions.
// Hearth-side, we keep one promise per agent so two concurrent specialist turns
// queue rather than fail. This is intentionally weaker than process-wide
// serialization — different agents in parallel will hit agentd's 503; the
// dispatcher's job is to mark those as deferred (handled in withBrowserSession).
const _agent_locks = new Map<string, Promise<unknown>>();

async function with_agent_lock<T>(agent: string, fn: () => Promise<T>): Promise<T> {
  // Chain fn behind the prior call for this agent. `prev` may have
  // rejected; swallow that so the chain continues either way.
  const prev = _agent_locks.get(agent) ?? Promise.resolve();
  const next: Promise<T> = prev.then(fn, fn);
  // Store a swallowed view in the map so an in-flight rejection doesn't
  // surface as an unhandled-rejection (Bun will exit the process). The
  // caller still gets the real rejection via the returned `next`.
  const stored: Promise<unknown> = next.catch(() => undefined);
  _agent_locks.set(agent, stored);
  // Don't bother clearing the map entry on settle — a settled Promise
  // chained into is harmless (resolves immediately), and the next call
  // for this agent overwrites the entry anyway.
  return next;
}

/**
 * The recommended entry point for any tool that needs a real browser.
 * Handles wake / pre-flight / spawn / attach / teardown.
 *
 * Returns the result of `fn`, or the result of `onDeferred` if pre-flight
 * blocked (and onDeferred was provided). If blocked with no onDeferred,
 * throws DeferredError so the caller can react (typically: schedule a
 * `promise_followup` and return a structured deferred result to the LLM).
 */
export async function withBrowserSession<T>(
  opts: BrowserSessionOptions,
  fn: (browser: Browser) => Promise<T>,
  onDeferred?: DeferredHandler,
): Promise<T | undefined> {
  const client = opts.client ?? getClient();

  // Lock per (agent, host): the same agent may legitimately hold one session
  // on the primary and, during an escalation, one on the fallback. Keying the
  // lock on the agent alone would deadlock that against itself.
  return with_agent_lock(`${client.name}:${opts.agent}`, async () => {
    await client.wake({ taskId: opts.taskId, timeoutMs: opts.wakeTimeoutMs });

    // Self-heal: clear any orphaned session for this agent left by a crashed or
    // restarted prior run before pre-flight — otherwise it reads as busy forever
    // (a hard restart skips the teardown finally). Safe because we hold the
    // per-agent lock and own no live browser; the activity gate is untouched.
    const reaped = await client.reapAgentSessions(opts.agent).catch(() => 0);
    if (reaped > 0) {
      console.log(`[avalanche] reaped ${reaped} orphaned session(s) for agent '${opts.agent}' before start`);
    }

    try {
      const pre = await client.canStart(opts.agent);
      if (!pre.ok) throw new DeferredError(pre);

      const session = await create_session_with_retry(
        client,
        opts.agent,
        opts.capabilities,
      );

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
        try {
          if (browser) await browser.deleteSession();
        } catch {
          await client.deleteSession(session.gd_session_id).catch(() => {});
        }
      }
    } catch (err) {
      // A deferral can come from the pre-flight activity gate OR from
      // createSession's 409 (live profile owner). Either way, hand it to
      // onDeferred when provided; otherwise let it propagate.
      if (err instanceof DeferredError && onDeferred) {
        await onDeferred(err.reason);
        return undefined;
      }
      throw err;
    }
  });
}

/**
 * The always-on primary browser host did not answer /health at all — the box
 * is down or off the network, as opposed to busy, at capacity, or blocked.
 *
 * This is the ONE error condition that justifies escalating to the WoL
 * fallback. It matters because Firecrawl and the primary browser host now run
 * on the SAME box (the always-on host): `fetch_with_browser_fallback` escalates a Firecrawl
 * outage to `browse_url` on the reasoning that the browser host is separate
 * infrastructure, and without this the whole ladder would collapse whenever
 * the always-on host went down. A Firecrawl *container* dying while the always-on host is up still
 * resolves on the always-on host and never reaches here.
 *
 * Distinct from every other failure precisely because it is unambiguous and
 * rare — "the box is gone", not "try again in a moment".
 */
export class HostUnreachableError extends Error {
  constructor(
    public readonly hostName: string,
    message: string,
  ) {
    super(message);
    this.name = 'HostUnreachableError';
  }
}

export class DeferredError extends Error {
  constructor(public readonly reason: Extract<CanStartResult, { ok: false }>) {
    super(`agentd refused start: ${reason.reason}`);
    this.name = 'DeferredError';
  }
}

/**
 * Thrown when agentd's createSession fails because the target Firefox
 * profile has a stale lock — the canonical signal is geckodriver's
 * `webdriver_create_failed / Failed to set preferences` error, raised
 * by Firefox when it can't acquire `<profile>/.parentlock` or the
 * `<profile>/lock` symlink. Most common cause: a prior interactive
 * `firefox -P <agent>` session (a manual login pass on the workstation)
 * exited uncleanly and left the locks behind, even though no Firefox
 * process actually holds the profile.
 *
 * The connector retries createSession ONCE after a 1.5s delay before
 * raising this — that handles real races (Firefox slow to release on
 * a clean exit).
 *
 * As of the profileLock self-heal in agentd, this is now a rare
 * BACKSTOP, not the normal recovery path. agentd proactively clears a
 * stale lock before every spawn (and refuses with 409 `profile_in_use`
 * — surfaced as a DeferredError — when a *live* Firefox owns the
 * profile). So if this error still fires, the lock could not be
 * auto-cleared: most likely agentd on the workstation predates the self-heal
 * and needs a redeploy, or Firefox is failing "Failed to set
 * preferences" for a non-lock reason. The manual command below remains
 * the genuine last resort. The browse_url Tool surfaces it as a
 * structured recovery_hint so callers react cleanly instead of seeing
 * a raw 500.
 */
export class StaleProfileLockError extends Error {
  constructor(
    public readonly agent: string,
    public readonly raw_message: string,
  ) {
    super(
      `Firefox profile lock for '${agent}' appears stale on the workstation. ` +
        `Manual cleanup needed: \`ssh the workstation 'find ~/.config/mozilla/firefox -maxdepth 2 -name ".parentlock" -o -name "lock" | grep ${agent} | xargs rm'\` ` +
        `(or remove ~/.config/mozilla/firefox/<profile-for-${agent}>/{lock,.parentlock} by hand).`,
    );
    this.name = 'StaleProfileLockError';
  }
}

/**
 * Heuristic — does this createSession error match the stale-lock
 * signature? geckodriver wraps Firefox's profile-acquisition failure
 * in a "session not created / Failed to set preferences" message;
 * agentd wraps that further in `reason: "webdriver_create_failed"`.
 * The two strings together are the canonical signal — looking for
 * one of them in isolation produces false positives (Firefox can
 * fail to set preferences for non-lock reasons; webdriver_create_failed
 * fires for several issues).
 */
function is_stale_profile_lock_error(msg: string): boolean {
  return (
    msg.includes('webdriver_create_failed') &&
    msg.includes('Failed to set preferences')
  );
}

async function create_session_with_retry(
  client: AvalancheClient,
  agent: string,
  capabilities?: Record<string, unknown>,
): Promise<SessionInfo> {
  try {
    return await client.createSession(agent, capabilities);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!is_stale_profile_lock_error(msg)) throw err;
    // Race-case retry — Firefox might be slow to release the lock on a
    // genuinely clean shutdown. One retry, brief delay, costs almost
    // nothing. If it works, great; the lock wasn't really stale.
    await sleep(1500);
    try {
      return await client.createSession(agent, capabilities);
    } catch (err2) {
      const msg2 = err2 instanceof Error ? err2.message : String(err2);
      if (is_stale_profile_lock_error(msg2)) {
        throw new StaleProfileLockError(agent, msg2);
      }
      throw err2;
    }
  }
}

// ─── browse_url Tool ────────────────────────────────────────────────────────

const BrowseInput = z.object({
  url: z.string().url().describe('Absolute URL to load.'),
  wait_ms: z
    .coerce.number()
    .int()
    .min(0)
    .max(15_000)
    .default(1500)
    .describe('Milliseconds to wait after navigation for JS-rendered content (0–15000).'),
  selector: z
    .string()
    .max(200)
    .optional()
    .describe('Optional CSS selector. If set, the text content of matching elements is returned in `extracted`.'),
});

const RecoveryHint = z
  .object({
    /** A one-line description the LLM can paraphrase into a user-facing
     *  reply ("Ruby's Firefox profile has a stale lock; needs manual
     *  cleanup"). */
    next_action: z.string(),
    /** A concrete shell command Jasper can run to recover. Optional —
     *  not every error path has a copy-pasteable fix. */
    command: z.string().optional(),
    /** Why this happens — short root-cause explanation so the LLM
     *  doesn't fabricate one. */
    why: z.string().optional(),
  })
  .optional();

const BrowseOutput = z.object({
  url: z.string(),
  title: z.string().nullable(),
  text: z.string(),
  extracted: z.array(z.string()).optional(),
  deferred: z.boolean().default(false),
  defer_reason: z.string().optional(),
  fetched_at: z.string(),
  error: z.string().optional(),
  /** Per the connector-affordance pattern (see architecture.md "The
   *  connector affordance pattern"): when `error` is populated, this
   *  carries a structured recovery hint the LLM can act on instead of
   *  fabricating an answer. The canonical case today is
   *  StaleProfileLockError — Jasper needs to clear the lock on
   *  the workstation. */
  recovery_hint: RecoveryHint,
  /** Which browser host served this page ("mint" / "avalanche"). Present so a
   *  fallback escalation is visible in the audit log rather than silent — the
   *  fallback physically powers a workstation on. */
  served_by: z.string().optional(),
});

/**
 * Does this page look like a HARD bot wall — i.e. the one thing worth waking a
 * workstation for?
 *
 * Deliberately narrow. Escalating to the fallback host means powering on
 * the workstation, whose discrete GPU dumps heat into a house that clears it slowly,
 * so a false positive is expensive and a false negative merely costs us the
 * page. That asymmetry drives every choice here:
 *
 *   - ONLY explicit, well-known challenge/denial markers count. A short body,
 *     an empty title, a slow render or a sparse page do NOT — plenty of
 *     legitimate pages look like that, and we would be waking the box for
 *     them constantly.
 *   - ERRORS never reach this function. Timeouts, 503s at capacity, activity
 *     deferrals and stale profile locks are all conditions where the fallback
 *     would fail for the same reason or where retrying later is correct.
 *     Escalation is strictly for "the primary rendered a page, and the page
 *     was a wall."
 *
 * The markers are matched against title + the head of the body, lowercased.
 */
export function looks_like_bot_wall(title: string, text: string): boolean {
  const haystack = `${title}\n${text.slice(0, 4000)}`.toLowerCase();
  const MARKERS = [
    // Cloudflare interstitial + block page
    'just a moment...',
    'checking your browser before accessing',
    'cf-browser-verification',
    'attention required! | cloudflare',
    'sorry, you have been blocked',
    'enable javascript and cookies to continue',
    // PerimeterX / HUMAN
    'access to this page has been denied',
    'px-captcha',
    // Akamai
    'access denied',
    "you don't have permission to access",
    // DataDome
    'detected unusual activity',
    // Generic interstitials
    'verify you are human',
    'are you a robot',
  ];
  return MARKERS.some((m) => haystack.includes(m));
}

type BrowseIn = z.infer<typeof BrowseInput>;
type BrowseOut = z.infer<typeof BrowseOutput>;

export const browse_url: Tool<BrowseIn, BrowseOut> = {
  name: 'browse_url',
  description:
    "Load a URL in a real warmed Firefox profile on the household browser " +
    "host (one profile per specialist) and return the page title, " +
    "plain-text body, and optionally text matching a CSS selector. Use " +
    "this when web_fetch_clean (Firecrawl) is blocked by " +
    "Cloudflare/PerimeterX or the page needs JS execution. Returns " +
    "deferred=true when the host is busy — the LLM should call " +
    "promise_followup to retry later. On a stale profile-lock from a prior " +
    "interactive login session, returns error + a recovery_hint naming the " +
    "cleanup command — relay the hint to Jasper and stop retrying until he's " +
    "cleared the lock.",
  risk: 'read',
  required_capabilities: ['browse_web'],
  // Rendered Firefox page text routinely exceeds 50 KB on venue /
  // calendar sites with iframes + JS-injected widgets. Same rationale
  // as web_fetch_clean; full body remains in the audit log.
  llm_budget: 2000,
  // Slow, JS-rendered external fetch — counts against the per-turn
  // heavy-call cap.
  weight: 'heavy',
  input_schema: BrowseInput,
  output_schema: BrowseOutput,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.url);
    h.update('\n');
    h.update(String(input.wait_ms));
    h.update('\n');
    h.update(input.selector ?? '');
    return `browse_url:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx) {
    const agent = ctx.specialist_id ?? 'maggie';
    const intent_id = ctx.intent_id || ulid();
    const fetched_at = new Date().toISOString();

    // The page fetch itself, parameterized by host so the (rare) fallback
    // escalation reuses exactly this logic instead of a divergent copy.
    const load_page = (client?: AvalancheClient) =>
      withBrowserSession({ agent, taskId: intent_id, client }, async (browser) => {
        await browser.url(input.url);
        if (input.wait_ms > 0) await sleep(input.wait_ms);
        const title = await browser.getTitle().catch(() => '');
        const body = await browser.$('body');
        const text = await body.getText().catch(() => '');
        let extracted: string[] | undefined;
        if (input.selector) {
          const els = await browser.$$(input.selector);
          const texts: string[] = [];
          for (const el of els) {
            const t = await el.getText().catch(() => '');
            if (t.trim()) texts.push(t);
          }
          extracted = texts;
        }
        return { title, text, extracted };
      });

    try {
      const primary = getClient();
      const fallback_host = getFallbackClient();
      let served_by = primary.name;
      let result: Awaited<ReturnType<typeof load_page>>;

      try {
        result = await load_page();
      } catch (e) {
        // The primary box is DOWN (not busy, not blocked). This is the only
        // error that escalates — see HostUnreachableError for why it has to,
        // now that Firecrawl and the primary browser host share a box.
        if (e instanceof HostUnreachableError && fallback_host) {
          console.warn(
            `[browse] primary host '${primary.name}' is unreachable; ` +
              `escalating to fallback '${fallback_host.name}' (this wakes it)`,
          );
          result = await load_page(fallback_host);
          served_by = fallback_host.name;
        } else {
          throw e;
        }
      }

      // LAST-RESORT ESCALATION. Only when the primary actually rendered a page
      // AND that page is a recognized bot wall — never on a timeout, a
      // deferral or a capacity 503 (see looks_like_bot_wall). On the WoL host
      // this physically powers a workstation on, so it stays this narrow.
      const fallback = served_by === primary.name ? fallback_host : null;
      if (
        fallback &&
        result !== undefined &&
        looks_like_bot_wall(result.title ?? '', result.text ?? '')
      ) {
        console.log(
          `[browse] ${primary.name} hit a bot wall on ${redact_url_for_audit(input.url)}; ` +
            `escalating to fallback host '${fallback.name}' (this wakes it)`,
        );
        try {
          const escalated = await load_page(fallback);
          if (escalated !== undefined) {
            result = escalated;
            served_by = fallback.name;
          }
        } catch (e) {
          // The fallback is a bonus, not a contract: if waking it fails, keep
          // the primary's walled page rather than turning a partial result
          // into a hard error.
          console.warn(
            `[browse] fallback host '${fallback.name}' failed: ${(e as Error).message}; ` +
              `returning ${primary.name}'s result`,
          );
        }
      }

      if (result === undefined) {
        // withBrowserSession returned undefined only if onDeferred ran;
        // since we didn't pass one, this branch is unreachable — but the
        // type union forces us to handle it.
        const out: BrowseOut = {
          url: input.url,
          title: null,
          text: '',
          deferred: true,
          defer_reason: 'unknown',
          fetched_at,
        };
        audit_browse(ctx, input, out, intent_id, agent);
        return out;
      }

      const out: BrowseOut = {
        url: input.url,
        title: result.title || null,
        text: (result.text ?? '').slice(0, 50_000),
        ...(result.extracted ? { extracted: result.extracted } : {}),
        deferred: false,
        fetched_at,
        served_by,
      };
      audit_browse(ctx, input, out, intent_id, agent);
      return out;
    } catch (err) {
      if (err instanceof DeferredError) {
        const out: BrowseOut = {
          url: input.url,
          title: null,
          text: '',
          deferred: true,
          defer_reason: err.reason.reason,
          fetched_at,
        };
        audit_browse(ctx, input, out, intent_id, agent);
        return out;
      }
      if (err instanceof StaleProfileLockError) {
        const out: BrowseOut = {
          url: input.url,
          title: null,
          text: '',
          deferred: false,
          fetched_at,
          error: err.message,
          recovery_hint: {
            next_action:
              `The Firefox profile for ${err.agent} on the workstation has a lock ` +
              `that agentd could not auto-clear. agentd normally removes a ` +
              `stale lock before every spawn, so this usually means agentd ` +
              `on the workstation predates that self-heal and needs a redeploy ` +
              `(rebuild + restart the agentd service). The manual clear ` +
              `below unblocks ${err.agent} in the meantime; tell Jasper.`,
            command:
              `ssh the workstation 'find ~/.config/mozilla/firefox -maxdepth 2 ` +
              `-name lock -path "*${err.agent}*" -delete; ` +
              `find ~/.config/mozilla/firefox -maxdepth 2 ` +
              `-name .parentlock -path "*${err.agent}*" -delete'`,
            why:
              `Firefox writes <profile>/.parentlock and <profile>/lock when ` +
              `it opens a profile; on a clean exit it removes them. After ` +
              `an unclean exit (crash, kill, or sometimes just a slow ` +
              `shutdown) the locks linger. agentd's WebDriver call then ` +
              `fails with "Failed to set preferences" even though no ` +
              `Firefox process holds the profile. agentd now self-heals ` +
              `this: it clears a stale lock before spawning, and refuses ` +
              `(deferral, not error) when a live Firefox actually owns the ` +
              `profile. Reaching this error means that self-heal did not ` +
              `run — almost always a stale agentd build.`,
          },
        };
        audit_browse(ctx, input, out, intent_id, agent);
        return out;
      }
      const out: BrowseOut = {
        url: input.url,
        title: null,
        text: '',
        deferred: false,
        fetched_at,
        error: err instanceof Error ? err.message : String(err),
      };
      audit_browse(ctx, input, out, intent_id, agent);
      return out;
    }
  },
};

// ─── Audit redaction ────────────────────────────────────────────────────────

function host_of(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '<unparseable>';
  }
}

function redact_url_for_audit(url: string): string {
  return browse_audit_redaction_enabled() ? host_of(url) : url;
}

function audit_browse(
  ctx: ToolContext,
  input: BrowseIn,
  result: BrowseOut,
  intent_id: string,
  agent: string,
): void {
  ctx.memory.log_action({
    intent_id,
    agent: `avalanche_connector:${agent}`,
    tool_name: 'browse_url',
    tool_input: {
      url: redact_url_for_audit(input.url),
      wait_ms: input.wait_ms,
      selector: input.selector,
    },
    execution_result: result.error
      ? undefined
      : {
          ok: !result.deferred && !result.error,
          deferred: result.deferred,
          defer_reason: result.defer_reason,
          title: result.title ? result.title.slice(0, 200) : null,
          text_chars: result.text.length,
        },
    error: result.error,
  });
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
