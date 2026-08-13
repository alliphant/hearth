import { spawn, ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { config } from "./config";
import { info, warn, error as logError, debug } from "./log";
import { ensureProfileUnlocked } from "./profileLock";

// Resolve a per-agent Firefox profile path. Profiles live under
// `firefoxProfileBase` but Firefox's profile manager hashes the directory
// name (`<hash>.<name>`) when a profile is created via the standard
// `firefox -CreateProfile` flow without an explicit target dir, while
// profiles created with an explicit target dir keep the bare name. Both
// shapes coexist in the same `profiles.ini`, and earlier code hard-coded
// `<base>/<agent>`, which silently broke for any hash-prefixed profile
// (geckodriver returns "Failed to set preferences: unknown error" when
// the path doesn't exist).
//
// Lookup order:
//   1. Parse profiles.ini and find the section where Name=<agent>.
//      Honour IsRelative=1.
//   2. Fall back to `<base>/<agent>` if the INI is missing or has no entry.
//
// The result is not required to exist — Firefox creates the dir on first
// launch if needed — but we surface a clear log line either way.
export function resolveProfilePath(agent: string): string {
  const base = config.firefoxProfileBase;
  const iniPath = join(base, "profiles.ini");
  if (existsSync(iniPath)) {
    try {
      const ini = readFileSync(iniPath, "utf8");
      // Walk sections; record (Name, Path, IsRelative) per [ProfileN] block.
      const sections = ini.split(/\r?\n(?=\[)/);
      for (const sec of sections) {
        if (!/^\[Profile/i.test(sec)) continue;
        const name = sec.match(/^Name=(.+)$/m)?.[1]?.trim();
        if (name !== agent) continue;
        const pth = sec.match(/^Path=(.+)$/m)?.[1]?.trim();
        const rel = sec.match(/^IsRelative=(\d)/m)?.[1] === "1";
        if (!pth) break;
        const resolved = rel || !isAbsolute(pth) ? join(base, pth) : pth;
        debug("profile_resolved", { agent, source: "profiles.ini", path: resolved });
        return resolved;
      }
    } catch (e) {
      warn("profile_ini_read_failed", { agent, error: (e as Error).message });
    }
  }
  const fallback = join(base, agent);
  debug("profile_resolved", { agent, source: "fallback", path: fallback });
  return fallback;
}

// The preload script body. Runs in the page's main realm BEFORE any
// author-defined script, on every document of the session, redefining the
// `navigator.webdriver` getter to return false (what a normal, un-automated
// browser reports). Defined on Navigator.prototype — not the instance — so a
// `getOwnPropertyDescriptor(navigator,'webdriver')` probe still looks vanilla.
const WEBDRIVER_MASK_FN =
  "() => { try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }); } catch (e) {} }";

/**
 * Mask `navigator.webdriver` via a WebDriver BiDi preload script.
 *
 * Firefox sets `navigator.webdriver === true` whenever it's driven by
 * Marionette, and on current Firefox (151) that is NOT overridable by the
 * `dom.webdriver.enabled` pref — the getter follows the live remote agent, not
 * the pref (verified on the box: the pref is written to prefs.js, yet the getter
 * still returns true). The version-robust lever is a BiDi
 * `script.addPreloadScript` that redefines the getter before any page script
 * runs, in every document of the session. agentd has localhost access to
 * geckodriver's BiDi socket, so we register it here at spawn and KEEP THE
 * CONNECTION OPEN for the session's lifetime — geckodriver scopes preload
 * scripts to the live BiDi connection, so dropping it would drop the mask. The
 * socket is closed in teardownSession. Best-effort throughout: any failure
 * resolves to null and the session runs unmasked rather than failing.
 *
 * Returns the open WebSocket on success (to be stored on the Session and closed
 * at teardown), or null on any failure.
 */
function applyWebdriverMask(
  webSocketUrl: string,
  session_id: string,
): Promise<WebSocket | null> {
  return new Promise<WebSocket | null>((resolve) => {
    let settled = false;
    const finish = (ws: WebSocket | null) => {
      if (settled) return;
      settled = true;
      resolve(ws);
    };

    let ws: WebSocket;
    try {
      ws = new WebSocket(webSocketUrl);
    } catch (e) {
      warn("webdriver_mask_connect_failed", { session_id, error: (e as Error).message });
      finish(null);
      return;
    }

    const timeout = setTimeout(() => {
      warn("webdriver_mask_timeout", { session_id });
      try { ws.close(); } catch {}
      finish(null);
    }, 5000);

    // A persistent error handler so an unexpected drop (now or later in the
    // session) can never surface as an unhandled rejection / crash Bun.
    ws.addEventListener("error", () => {
      if (!settled) {
        clearTimeout(timeout);
        warn("webdriver_mask_ws_error", { session_id });
        finish(null);
      }
    });

    ws.addEventListener("open", () => {
      try {
        ws.send(JSON.stringify({
          id: 1,
          method: "script.addPreloadScript",
          params: { functionDeclaration: WEBDRIVER_MASK_FN },
        }));
      } catch (e) {
        clearTimeout(timeout);
        warn("webdriver_mask_send_failed", { session_id, error: (e as Error).message });
        try { ws.close(); } catch {}
        finish(null);
      }
    });

    ws.addEventListener("message", (ev: MessageEvent) => {
      let msg: { id?: number; type?: string; result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id !== 1) return; // not our command's reply
      clearTimeout(timeout);
      if (msg.type === "success" || msg.result) {
        info("webdriver_mask_applied", { session_id });
        finish(ws); // leave OPEN — the preload is scoped to this connection
      } else {
        warn("webdriver_mask_rejected", { session_id, error: JSON.stringify(msg.error ?? msg).slice(0, 200) });
        try { ws.close(); } catch {}
        finish(null);
      }
    });
  });
}

export interface Session {
  session_id: string;
  agent: string;
  gd_session_id: string;
  port: number;
  wayland_socket: string;
  compositor: ChildProcess;
  geckodriver: ChildProcess;
  /** Firefox PID reported by geckodriver (`moz:processID`). Used to reap an
   *  orphaned Firefox in teardown so it doesn't leave a stale profile lock. */
  firefox_pid?: number;
  /** Live WebDriver BiDi connection, held open ONLY to keep the
   *  `navigator.webdriver` preload mask registered for the session's lifetime
   *  (see applyWebdriverMask). Closed in teardown. Undefined when BiDi was
   *  unavailable or the mask failed — the session is fully functional either way. */
  bidi?: WebSocket;
  started_at: number;
  last_activity_at: number;
  expires_at: number;
}

// In-memory session store.
const sessions = new Map<string, Session>(); // session_id -> Session
const byGdSession = new Map<string, Session>(); // gd_session_id -> Session
const byAgent = new Map<string, Session>(); // agent -> Session

export function listSessions(): Session[] {
  return Array.from(sessions.values());
}

/**
 * Tear down any session past its `expires_at` — the recovery path for a
 * session whose WebDriver DELETE never arrived (a wedged geckodriver, or a
 * client that crashed mid-session), which would otherwise sit holding a
 * profile lock and reading as "busy" until the next restart. Best-effort;
 * returns how many were reaped. Wired to a periodic ticker in main.ts.
 *
 * NB this only reaps sessions THIS process still tracks — in-memory sessions
 * die with the process, so a fresh agentd has nothing here to reap (the
 * across-restart orphan is handled pre-flight by the client's reapAgentSessions
 * / forceTeardown). This is the in-process hang sweep.
 */
export async function reapExpiredSessions(now: number = Date.now()): Promise<number> {
  const expired = listSessions().filter((s) => s.expires_at <= now);
  let reaped = 0;
  for (const s of expired) {
    try {
      info("session_expired_reap", {
        session_id: s.session_id,
        agent: s.agent,
        age_ms: now - s.started_at,
      });
      await teardownSession(s.session_id);
      reaped++;
    } catch (e) {
      warn("session_expired_reap_failed", {
        session_id: s.session_id,
        error: (e as Error).message,
      });
    }
  }
  return reaped;
}

export function getSession(session_id: string): Session | undefined {
  return sessions.get(session_id);
}

export function getSessionByGd(gd_session_id: string): Session | undefined {
  return byGdSession.get(gd_session_id);
}

export function getSessionByAgent(agent: string): Session | undefined {
  return byAgent.get(agent);
}

export function sessionsActive(): number {
  return sessions.size;
}

// ===== port allocation =====
const usedPorts = new Set<number>();
function allocPort(): number {
  for (let p = config.geckodriverPortMin; p <= config.geckodriverPortMax; p++) {
    if (!usedPorts.has(p)) {
      usedPorts.add(p);
      return p;
    }
  }
  throw new Error("no free port in geckodriver range");
}
function releasePort(p: number) {
  usedPorts.delete(p);
}

// ===== short uuid =====
function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ===== teardown listener =====
type TeardownListener = (session_id: string) => void;
const teardownListeners: TeardownListener[] = [];
export function onTeardown(l: TeardownListener) {
  teardownListeners.push(l);
}

// ===== waitFor helpers =====
async function waitForSocket(path: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function waitForGeckodriver(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(500),
      });
      if (r.ok) {
        const body = (await r.json()) as { value?: { ready?: boolean } };
        if (body?.value?.ready) return true;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// ===== spawn =====
export interface SpawnResult {
  session: Session;
  webdriver_base: string;
}

export class SpawnError extends Error {
  status: number;
  reason: string;
  constructor(status: number, reason: string, msg?: string) {
    super(msg ?? reason);
    this.status = status;
    this.reason = reason;
  }
}

export async function spawnSession(agent: string, capabilities: any = {}): Promise<SpawnResult> {
  if (byAgent.has(agent)) {
    throw new SpawnError(409, "agent_busy", `session already exists for ${agent}`);
  }
  if (sessions.size >= config.maxSessions) {
    // Bounded concurrency. Was a hard-coded 1 (see config.maxSessions for why
    // that stopped being the right default once a second agent browsed).
    throw new SpawnError(503, "concurrent_sessions_at_capacity");
  }

  // Self-heal a stale Firefox profile lock before we spend time spawning the compositor
  // + geckodriver. resolveProfilePath is a pure profiles.ini read, so it's
  // safe to do up front. A lock with no live owner is removed automatically; a
  // lock held by a live Firefox — i.e. Jasper's own interactive
  // `firefox -P <agent>` session — is refused with 409 so the caller defers,
  // because attaching a second instance would corrupt the profile's logins.
  const profilePath = resolveProfilePath(agent);
  if (!existsSync(profilePath)) {
    // geckodriver writes prefs INTO the profile dir before launching Firefox,
    // so the dir must pre-exist — a missing dir fails with the SAME
    // "Failed to set preferences" error a stale lock produces (and the
    // Hearth side then misreads it as a stale lock). resolveProfilePath's note
    // that "Firefox creates the dir on first launch" holds for interactive
    // `firefox --profile` but NOT this geckodriver path. Create it so a
    // never-before-used agent profile (e.g. `orchestrator`'s first browse)
    // just works instead of dead-ending.
    mkdirSync(profilePath, { recursive: true });
    info("profile_dir_created", { agent, profile_path: profilePath });
  }
  const lock = ensureProfileUnlocked(profilePath);
  if (lock.state === "live") {
    info("session_refused_profile_in_use", {
      agent,
      profile_path: profilePath,
      owner_pid: lock.pid,
    });
    throw new SpawnError(
      409,
      "profile_in_use",
      `Firefox profile for ${agent} is held by a live process (pid ${lock.pid}); not launching a second instance`,
    );
  }
  if (lock.state === "cleared_stale") {
    warn("stale_profile_lock_cleared", {
      agent,
      profile_path: profilePath,
      stale_pid: lock.stalePid ?? null,
      removed: lock.removed ?? [],
    });
  }

  const session_id = shortId();
  const port = allocPort();
  const waylandSocket = `agentd-${session_id}`;
  const socketPath = join(config.xdgRuntimeDir, waylandSocket);

  info("session_spawn_start", { session_id, agent, port, wayland_socket: waylandSocket });

  // Step 6: spawn the nested compositor. Which one is box-specific (KWin on
  // KDE/the workstation, weston's headless backend on GNOME/the always-on host) — see
  // config.compositorCmd. The contract either must satisfy is the same and is
  // all this code depends on: create a Wayland socket named {socket} inside
  // XDG_RUNTIME_DIR, backed by HARDWARE GL. Readiness is the socket appearing,
  // which is why the substitution happens here and not in the caller.
  const compositorArgs = config.compositorArgs
    .split(/\s+/)
    .filter((a) => a.length > 0)
    .map((a) =>
      a
        .replaceAll("{socket}", waylandSocket)
        .replaceAll("{width}", config.compositorWidth)
        .replaceAll("{height}", config.compositorHeight),
    );
  const compositor = spawn(
    config.compositorCmd,
    compositorArgs,
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: config.xdgRuntimeDir,
      },
      detached: false,
    },
  );
  compositor.stdout?.on("data", (d) => debug("compositor_stdout", { session_id, line: d.toString().trim() }));
  compositor.stderr?.on("data", (d) => debug("compositor_stderr", { session_id, line: d.toString().trim() }));
  let compositorExited = false;
  compositor.on("exit", (code, sig) => {
    compositorExited = true;
    info("compositor_exit", { session_id, code, signal: sig });
  });

  const sockOk = await waitForSocket(socketPath, 10000);
  if (!sockOk || compositorExited) {
    try { compositor.kill("SIGKILL"); } catch {}
    releasePort(port);
    logError("session_spawn_failed", { session_id, agent, stage: "compositor_socket", port });
    throw new SpawnError(500, "compositor_failed_to_start");
  }
  info("compositor_ready", { session_id, socket: socketPath });

  // Step 7: spawn geckodriver
  const gdEnv = {
    HOME: process.env.HOME ?? "/root",
    PATH: config.geckodriverPath,
    XDG_RUNTIME_DIR: config.xdgRuntimeDir,
    WAYLAND_DISPLAY: waylandSocket,
    MOZ_ENABLE_WAYLAND: "1",
    // Firefox profile location override — our profiles live under XDG dir.
    MOZ_LEGACY_PROFILES: "1",
  };

  const geckodriver = spawn(
    config.geckodriverBinary,
    ["--host", "127.0.0.1", "--port", String(port), "--log", "info"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: gdEnv,
      detached: false,
    },
  );
  geckodriver.stdout?.on("data", (d) =>
    debug("geckodriver_stdout", { session_id, line: d.toString().trim() }),
  );
  geckodriver.stderr?.on("data", (d) =>
    debug("geckodriver_stderr", { session_id, line: d.toString().trim() }),
  );
  let gdExited = false;
  geckodriver.on("exit", (code, sig) => {
    gdExited = true;
    info("geckodriver_exit", { session_id, code, signal: sig });
  });

  const gdOk = await waitForGeckodriver(port, 15000);
  if (!gdOk || gdExited) {
    try { geckodriver.kill("SIGKILL"); } catch {}
    try { compositor.kill("SIGTERM"); } catch {}
    releasePort(port);
    logError("session_spawn_failed", { session_id, agent, stage: "geckodriver_ready" });
    throw new SpawnError(500, "geckodriver_failed_to_start");
  }
  info("geckodriver_ready", { session_id, port });

  // Step 8: POST /session
  // Use --profile <path> rather than -P <name>: geckodriver explicitly
  // warns that named profiles block its pref injection, including the
  // marionette.port pref that lets it find Firefox. profilePath was resolved
  // (and any stale lock cleared) at the top of spawnSession.
  const requestedCaps = capabilities ?? {};
  const wdBody = {
    capabilities: {
      alwaysMatch: {
        browserName: "firefox",
        // Proceed past TLS-cert problems (expired / self-signed / hostname
        // mismatch / incomplete chain) instead of failing the navigation.
        // Without this, geckodriver rejects `POST /session/:id/url` with
        // "insecure certificate" (W3C default is false) — which silently
        // dropped vendor/cert-registry pages from Kristi's scans and left
        // noisy paired teardown errors. This is a dedicated scraping profile
        // reading public pages, so relaxing TLS validity here is appropriate
        // and benefits every agentd browser session, not just one tool.
        acceptInsecureCerts: true,
        // Enable WebDriver BiDi so we can register a `navigator.webdriver`
        // preload mask after the session is created (see applyWebdriverMask).
        // This is the load-bearing automation-tell fix on current Firefox; the
        // pref below is kept as defense-in-depth but is INERT on FF 151 (the
        // getter follows the live Marionette agent, not the pref — verified on
        // the box). geckodriver returns a `webSocketUrl` capability when set.
        webSocketUrl: true,
        "moz:firefoxOptions": {
          // Pin the Firefox binary when the box needs it. Omitted (the
          // the workstation case) geckodriver searches PATH, which is right where
          // the distro Firefox is unconfined. On the always-on host the PATH Firefox is a
          // SNAP and would be confined away from both `profilePath` and our
          // per-session Wayland socket, so config.firefoxBinary points at an
          // unconfined build. See config.firefoxBinary.
          ...(config.firefoxBinary ? { binary: config.firefoxBinary } : {}),
          args: ["--profile", profilePath, "--no-remote"],
          prefs: {
            "marionette.enabled": true,
            // ── automation-tell hygiene ──────────────────────────────────
            // Present as a vanilla, human Firefox. We drive a REAL headed
            // Firefox on a real Wayland display (genuine UA / plugins / TLS
            // fingerprint), so the headless- and Chrome-specific tells don't
            // apply here. The ONE web-visible giveaway is `navigator.webdriver`.
            // This pref WAS the lever on older Firefox, but FF 151 ignores it
            // under Marionette (the pref lands in prefs.js yet the getter still
            // returns true). The actual mask is the BiDi preload script applied
            // post-create. Kept here as belt-and-suspenders for other FF builds.
            "dom.webdriver.enabled": false,
            "useAutomationExtension": false,
            // ── present our REAL hardware fingerprint, not Firefox's sanitized
            //    one ──────────────────────────────────────────────────────────
            // Firefox's Fingerprinting Protection (default-on in 151) spoofs the
            // WebGL renderer to a generic "NVIDIA GeForce 8800 GTX, or similar"
            // and ADDS PER-SESSION CANVAS NOISE. That's the opposite of what an
            // Akamai-class bot wall's stricter `sbsd` tier wants: it mints its
            // trust cookie from a STABLE, REAL gpu/canvas hash, and a modern
            // browser reporting a 2006 GPU + shifting canvas reads as a spoofed
            // (bot/VM) environment. We ARE a real machine — the workstation has a real
            // RTX PRO 4000 Blackwell doing hardware WebGL — so we turn the
            // sanitization OFF and let the genuine, consistent fingerprint show.
            // This is de-masking our real hardware, not spoofing. Verified: the
            // PDP tier passes already; this targets the configurator's sbsd tier.
            "privacy.resistFingerprinting": false,
            "privacy.fingerprintingProtection": false,
            "privacy.fingerprintingProtection.pbmode": false,
          },
        },
        ...(requestedCaps.alwaysMatch ?? {}),
      },
    },
  };

  let gd_session_id: string;
  let firefox_pid: number | undefined;
  let webSocketUrl: string | undefined;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(wdBody),
    });
    const txt = await r.text();
    if (!r.ok) {
      logError("webdriver_create_failed", { session_id, status: r.status, body: txt.slice(0, 400) });
      try { geckodriver.kill("SIGTERM"); } catch {}
      try { compositor.kill("SIGTERM"); } catch {}
      releasePort(port);
      throw new SpawnError(500, "webdriver_create_failed", txt.slice(0, 200));
    }
    const parsed = JSON.parse(txt);
    gd_session_id = parsed?.value?.sessionId ?? parsed?.sessionId;
    if (!gd_session_id) {
      throw new SpawnError(500, "webdriver_no_session_id", txt.slice(0, 200));
    }
    const mozPid = parsed?.value?.capabilities?.["moz:processID"];
    if (typeof mozPid === "number") firefox_pid = mozPid;
    const wsu = parsed?.value?.capabilities?.webSocketUrl;
    if (typeof wsu === "string" && wsu) webSocketUrl = wsu;
  } catch (e) {
    if (e instanceof SpawnError) throw e;
    try { geckodriver.kill("SIGTERM"); } catch {}
    try { compositor.kill("SIGTERM"); } catch {}
    releasePort(port);
    throw new SpawnError(500, "webdriver_create_exception", (e as Error).message);
  }

  // Register the navigator.webdriver mask over BiDi before the caller navigates.
  // Best-effort: a failure leaves the session fully usable (just unmasked).
  let bidi: WebSocket | undefined;
  if (webSocketUrl) {
    bidi = (await applyWebdriverMask(webSocketUrl, session_id)) ?? undefined;
  } else {
    warn("webdriver_mask_no_socket", { session_id });
  }

  const now = Date.now();
  const session: Session = {
    session_id,
    agent,
    gd_session_id,
    port,
    wayland_socket: waylandSocket,
    compositor,
    geckodriver,
    firefox_pid,
    bidi,
    started_at: now,
    last_activity_at: now,
    expires_at: now + 1000 * 60 * 60, // 1h soft default
  };

  sessions.set(session_id, session);
  byGdSession.set(gd_session_id, session);
  byAgent.set(agent, session);

  info("session_spawn_ready", {
    session_id,
    agent,
    gd_session_id,
    port,
  });

  return {
    session,
    webdriver_base: `http://${config.publicHost}:${config.port}/wd`,
  };
}

// ===== teardown =====
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Reap an orphaned Firefox. geckodriver normally terminates Firefox on a clean
// WebDriver DELETE or on its own SIGTERM, but if geckodriver had to be
// SIGKILLed the Firefox child can survive and leave a stale profile lock — the
// exact failure this whole path exists to prevent. We track Firefox's PID from
// geckodriver's `moz:processID` and make sure it's gone.
async function reapFirefox(pid: number | undefined, session_id: string) {
  if (pid === undefined || !pidAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  await new Promise((r) => setTimeout(r, 2000));
  if (pidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    warn("firefox_force_killed", { session_id, firefox_pid: pid });
  } else {
    debug("firefox_reaped", { session_id, firefox_pid: pid });
  }
}

async function gracefulKill(proc: ChildProcess, label: string, hardAfterMs: number) {
  if (proc.exitCode !== null || proc.killed) return;
  try {
    proc.kill("SIGTERM");
  } catch (e) {
    warn("kill_sigterm_failed", { label, error: (e as Error).message });
  }
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      if (proc.exitCode === null && !proc.killed) {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }
      resolve();
    }, hardAfterMs);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

export async function teardownSession(
  session_id: string,
  options: { proxyDelete?: boolean } = {},
): Promise<void> {
  const sess = sessions.get(session_id);
  if (!sess) return;
  info("session_teardown", { session_id, agent: sess.agent, gd_session_id: sess.gd_session_id });

  // Drop the BiDi connection that held the navigator.webdriver mask open.
  if (sess.bidi) {
    try { sess.bidi.close(); } catch {}
  }

  if (options.proxyDelete) {
    // best-effort: tell webdriver to close cleanly
    try {
      await fetch(`http://127.0.0.1:${sess.port}/session/${sess.gd_session_id}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(3000),
      });
    } catch (e) {
      debug("teardown_wd_delete_failed", { session_id, error: (e as Error).message });
    }
  }

  // remove from indices early so listings are accurate during teardown
  sessions.delete(session_id);
  byGdSession.delete(sess.gd_session_id);
  byAgent.delete(sess.agent);

  await gracefulKill(sess.geckodriver, "geckodriver", 5000);
  // Backstop: ensure the Firefox child geckodriver spawned is actually gone
  // before we drop the compositor, so no orphan lingers to hold the profile lock.
  await reapFirefox(sess.firefox_pid, session_id);
  await gracefulKill(sess.compositor, "compositor", 3000);

  releasePort(sess.port);

  for (const l of teardownListeners) {
    try {
      l(session_id);
    } catch (e) {
      warn("teardown_listener_threw", { error: (e as Error).message });
    }
  }
}

export async function teardownAll() {
  const ids = Array.from(sessions.keys());
  await Promise.all(ids.map((id) => teardownSession(id)));
}

export function lastSessionEndedAt(): number {
  return _lastSessionEndedAt;
}

let _lastSessionEndedAt = 0;

// Update timestamp when teardown happens
onTeardown(() => {
  if (sessions.size === 0) {
    _lastSessionEndedAt = Date.now();
  }
});
