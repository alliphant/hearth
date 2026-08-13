import { exec } from "node:child_process";
import { config, getToken, VERSION } from "./config";
import { info, warn, error as logError } from "./log";
import { runActivityCheck, sessionBlockers } from "./activity";
import { setWakeMarker, wakeMarkerPresent, evaluateWakeMarker, clearWakeMarker } from "./wake";
import { startWakeCycleTracker, stopWakeCycleTracker, cycleState, secondsSinceCycleStart } from "./wakeCycle";
import {
  spawnSession,
  SpawnError,
  listSessions,
  sessionsActive,
  teardownSession,
  teardownAll,
  reapExpiredSessions,
  getSessionByGd,
  getSession,
  lastSessionEndedAt,
} from "./sessions";
import { proxyWebDriver } from "./proxy";
import { startDrainTicker, stopDrainTicker, evaluateDrainNow } from "./drain";

// Token validation (timing-safe-ish)
function authOk(req: Request): boolean {
  const tok = req.headers.get("x-agentd-auth");
  if (!tok) return false;
  let expected: string;
  try {
    expected = getToken();
  } catch {
    return false;
  }
  if (tok.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < tok.length; i++) diff |= tok.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function jsonResp(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

function unauthorized(): Response {
  return jsonResp(401, { error: "unauthorized" }, { "WWW-Authenticate": "Custom realm=agentd" });
}

async function readJson(req: Request): Promise<any> {
  const txt = await req.text();
  if (!txt) return {};
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

const startedAt = Date.now();

const server = Bun.serve({
  port: config.port,
  hostname: config.bind,
  // 5 min idle is fine; some webdriver operations are long
  idleTimeout: 255,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // /health is open
    if (method === "GET" && path === "/health") {
      return jsonResp(200, { ok: true, version: VERSION });
    }

    // Everything else needs auth
    if (!authOk(req)) {
      return unauthorized();
    }

    // /status
    if (method === "GET" && path === "/status") {
      const active = sessionsActive();
      // null, not 0, when the probe cannot measure idleness — see activity.ts.
      // Reporting 0 for "unknown" would read as "the human just touched it",
      // which is the opposite of what an unmeasurable probe tells you.
      let idle: number | null = null;
      try {
        const a = await runActivityCheck();
        idle = a.details.user_idle_seconds;
      } catch {}
      const ses = listSessions().map((s) => ({
        session_id: s.session_id,
        agent: s.agent,
        gd_session_id: s.gd_session_id,
        port: s.port,
        wayland_socket: s.wayland_socket,
        started_at: new Date(s.started_at).toISOString(),
        last_activity_at: new Date(s.last_activity_at).toISOString(),
      }));
      // Marker state is reported as the VERDICT, not just file presence. "A
      // marker exists" and "that marker authorizes sleep" are different
      // questions, and conflating them is what made the 2026-08-03 stale-marker
      // failure invisible from outside the daemon.
      const verdict = evaluateWakeMarker();
      const cycle = cycleState();
      return jsonResp(200, {
        ready: true,
        version: VERSION,
        uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
        sessions_active: active,
        sessions: ses,
        wake_marker_present: wakeMarkerPresent(),
        wake_marker_honored: verdict.honored,
        wake_marker_reason: verdict.reason,
        wake_cycle_id: cycle.cycleId,
        wake_cycle_origin: cycle.origin,
        seconds_since_cycle_start: secondsSinceCycleStart(),
        idle_seconds: idle,
        last_session_ended_at:
          lastSessionEndedAt() > 0 ? new Date(lastSessionEndedAt()).toISOString() : null,
      });
    }

    // /wake-ack
    if (method === "POST" && path === "/wake-ack") {
      // On an always-on host there is no WoL-vs-human uptime to record, and
      // honouring this would arm a suspend path that must never fire (it would
      // take the FRIDAY kiosk, Firecrawl and Home Assistant down with it).
      // Refuse loudly rather than accepting a no-op, so a misconfigured
      // connector shows up here instead of silently half-working.
      if (config.alwaysOn) {
        info("wake_ack_refused_always_on", {});
        return jsonResp(409, {
          ok: false,
          reason: "always_on_host",
          message: "host never sleeps; wake/suspend lifecycle is disabled",
        });
      }
      const body = await readJson(req);
      if (body === null) return jsonResp(400, { error: "bad_json" });
      const source = (body?.source ?? "unknown").toString();
      const taskId = body?.task_id ? body.task_id.toString() : undefined;
      try {
        setWakeMarker(source, taskId);
        info("wake_ack_received", { source, task_id: taskId });
        return jsonResp(200, { ok: true });
      } catch (e) {
        return jsonResp(500, { error: "wake_marker_failed", message: (e as Error).message });
      }
    }

    // POST /suspend — OWNER-COMMANDED sleep.
    //
    // Distinct from the drain ticker's automatic suspend, which is bound by the
    // wake-marker invariants (only sleep a box THIS system woke). This is a
    // human saying "put that machine to sleep," so the marker rules do not
    // apply — but two hard guards do:
    //
    //   1. NEVER on an always-on host. the always-on host runs the FRIDAY kiosk, Firecrawl
    //      and Home Assistant; suspending it takes the household down. The
    //      guard lives HERE rather than in the caller so it cannot be bypassed
    //      by any client, present or future.
    //   2. Never mid-session. A live browser session means work in flight;
    //      the caller should wait or tear it down first.
    //
    // Motivating case: a box woken by WoL that never received a /wake-ack has
    // no marker, so invariant #1 ("no marker → no auto-suspend, ever") leaves
    // it awake indefinitely. Observed on the workstation — idle 3h25m after a single
    // browse session, burning workstation power the whole time.
    if (method === "POST" && path === "/suspend") {
      if (config.alwaysOn) {
        info("suspend_refused_always_on", {});
        return jsonResp(409, {
          ok: false,
          reason: "always_on_host",
          message:
            "this host is always-on (it runs household services); it must never be suspended",
        });
      }
      const active = sessionsActive();
      if (active > 0) {
        info("suspend_refused_sessions_active", { sessions_active: active });
        return jsonResp(409, {
          ok: false,
          reason: "sessions_active",
          message: `${active} browser session(s) still running; tear them down first`,
        });
      }
      const body = await readJson(req);
      const reason = (body?.reason ?? "owner_request").toString();
      info("suspend_commanded", { reason, cmd: config.suspendCmd });
      // Consume any marker on the way down, for the same reason the drain path
      // does: the wake it recorded is answered, and nothing should survive the
      // suspend still claiming this box was woken remotely.
      if (wakeMarkerPresent()) clearWakeMarker("consumed_by_commanded_suspend");
      // Respond BEFORE suspending — the process is about to lose the network,
      // so a reply written after the syscall would never reach the caller.
      queueMicrotask(() => {
        void (async () => {
          await new Promise((r) => setTimeout(r, 500));
          exec(config.suspendCmd, (err) => {
            if (err) warn("suspend_cmd_failed", { error: err.message });
          });
        })();
      });
      return jsonResp(200, { ok: true, suspending: true, cmd: config.suspendCmd });
    }

    // /can-start
    if (method === "GET" && path === "/can-start") {
      const agent = url.searchParams.get("agent") ?? "";
      if (!agent) return jsonResp(400, { error: "missing_agent" });
      let report;
      try {
        report = await runActivityCheck();
      } catch (e) {
        return jsonResp(500, { error: "activity_check_failed", message: (e as Error).message });
      }
      const blockers = sessionBlockers(report);
      const decision = blockers.length === 0;
      info("can_start_decision", {
        agent,
        ok: decision,
        blockers,
        idle_seconds: report.details.user_idle_seconds,
      });
      if (decision) return jsonResp(200, { ok: true });
      return jsonResp(409, { ok: false, reason: "user_busy", blockers, details: report.details });
    }

    // POST /sessions
    if (method === "POST" && path === "/sessions") {
      const body = await readJson(req);
      if (body === null) return jsonResp(400, { error: "bad_json" });
      const agent = (body?.agent ?? "").toString();
      if (!agent || !/^[a-z][a-z0-9_]{0,30}$/.test(agent)) {
        return jsonResp(400, { error: "bad_agent" });
      }
      // Activity gate
      try {
        const report = await runActivityCheck();
        const blockers = sessionBlockers(report);
        if (blockers.length > 0) {
          info("session_refused_busy", { agent, blockers });
          return jsonResp(409, { ok: false, reason: "user_busy", blockers });
        }
      } catch (e) {
        return jsonResp(500, { error: "activity_check_failed", message: (e as Error).message });
      }

      try {
        const r = await spawnSession(agent, body?.capabilities ?? {});
        return jsonResp(200, {
          session_id: r.session.session_id,
          gd_session_id: r.session.gd_session_id,
          webdriver_base: r.webdriver_base,
          wayland_socket: r.session.wayland_socket,
          expires_at: new Date(r.session.expires_at).toISOString(),
        });
      } catch (e) {
        if (e instanceof SpawnError) {
          return jsonResp(e.status, { ok: false, reason: e.reason, message: e.message });
        }
        logError("session_spawn_unhandled", { error: (e as Error).message });
        return jsonResp(500, { ok: false, reason: "internal_error", message: (e as Error).message });
      }
    }

    // WebDriver proxy: /wd/session/{gd_session_id}/...
    if (path.startsWith("/wd/")) {
      const pathAfter = path.slice(3); // keep leading "/"
      // DELETE /wd/session/{id} (top-level — full teardown)
      const topDelete = pathAfter.match(/^\/session\/([^/]+)$/);
      if (method === "DELETE" && topDelete) {
        const gdId = topDelete[1];
        const sess = getSessionByGd(gdId);
        if (!sess) return jsonResp(404, { error: "unknown_session" });
        await teardownSession(sess.session_id, { proxyDelete: true });
        return jsonResp(200, { ok: true, session_id: sess.session_id });
      }
      return await proxyWebDriver(req, url, pathAfter);
    }

    // DELETE /sessions/{session_id}
    {
      const m = path.match(/^\/sessions\/([^/]+)$/);
      if (m && method === "DELETE") {
        const id = m[1];
        const sess = getSession(id);
        if (!sess) return jsonResp(404, { error: "unknown_session" });
        await teardownSession(id);
        return jsonResp(200, { ok: true, session_id: id });
      }
    }

    // Debug evaluation endpoint (test only — still auth-gated)
    if (method === "POST" && path === "/_debug/drain-now") {
      await evaluateDrainNow();
      return jsonResp(200, { ok: true });
    }

    return jsonResp(404, { error: "not_found", path, method });
  },
  error(e) {
    logError("server_error", { error: e.message, stack: e.stack });
    return jsonResp(500, { error: "internal" });
  },
});

info("boot", {
  version: VERSION,
  port: config.port,
  bind: config.bind,
  always_on: config.alwaysOn,
  max_sessions: config.maxSessions,
  compositor: config.compositorCmd,
  firefox_binary: config.firefoxBinary || "(PATH)",
  drain_seconds: config.alwaysOn ? null : config.drainSeconds,
  suspend_cmd: config.alwaysOn ? null : config.suspendCmd,
  activity_script: config.activityScript,
});

// Wake-cycle tracking starts before anything can arm sleep. It must be running
// before the first /wake-ack can arrive, since that request's arming decision
// is made against the cycle state — an ack processed before the tracker
// initialised would be attributed to an unknown cycle and refused. Started even
// on always-on hosts, where it costs one sysfs read per 5s and keeps /status
// answering the same questions everywhere.
startWakeCycleTracker();

// The drain ticker is the ONLY caller of `systemctl suspend`. Leaving it
// unarmed on an always-on host makes the suspend path unreachable by
// construction, rather than relying on "no wake marker was ever written."
if (config.alwaysOn) {
  info("drain_disabled_always_on", {});
} else {
  startDrainTicker();
}

// Periodic expiry reaper — tear down any session past its `expires_at`, the
// recovery path for a hung session whose WebDriver DELETE never came (wedged
// geckodriver / crashed client). A RUNTIME sweep, not a boot reap: in-memory
// sessions die with the process, so a fresh agentd has nothing to reap here.
const REAP_INTERVAL_MS = 5 * 60 * 1000;
const reaperTimer = setInterval(() => {
  void reapExpiredSessions()
    .then((n) => {
      if (n > 0) info("expired_sessions_reaped", { count: n });
    })
    .catch((e) => warn("reaper_tick_failed", { error: (e as Error).message }));
}, REAP_INTERVAL_MS);
reaperTimer.unref?.();

// Graceful shutdown
const cleanup = async (sig: string) => {
  info("shutdown_signal", { signal: sig });
  stopDrainTicker();
  stopWakeCycleTracker();
  clearInterval(reaperTimer);
  try {
    await teardownAll();
  } catch (e) {
    warn("teardown_all_failed", { error: (e as Error).message });
  }
  server.stop();
  process.exit(0);
};
process.on("SIGINT", () => void cleanup("SIGINT"));
process.on("SIGTERM", () => void cleanup("SIGTERM"));
