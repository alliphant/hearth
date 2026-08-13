import { spawn } from "node:child_process";
import { config } from "./config";
import { warn } from "./log";

export interface ActivityReport {
  busy: boolean;
  user_present: boolean;
  blockers: string[];
  details: Record<string, unknown> & {
    // null means the probe could not MEASURE idleness on this platform — not
    // that the box is fresh. Under KWin/Wayland every available source is
    // unusable (ScreenSaver D-Bus returns NotSupported, logind's IdleHint is
    // never set, evdev needs group input), so without the swayidle stamp there
    // is genuinely no answer. v1 returned a confident number here derived from
    // /dev/input mtimes that the kernel never updates, which made "seconds
    // since boot" masquerade as "seconds since the human last typed".
    user_idle_seconds: number | null;
    ssh_sessions_external: number;
    media_playing: boolean;
    video_conf_active: boolean;
    agentd_session_active: boolean;
    steam_running: boolean;
    steam_downloading: boolean;
    network_throughput_mbps: number;
  };
}

export async function runActivityCheck(): Promise<ActivityReport> {
  return await new Promise((resolve, reject) => {
    const child = spawn(config.activityScript, [], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AGENTD_PORT: String(config.port),
        // Tell the script not to recurse back into /status
        AGENTD_INTERNAL_CHECK: "1",
        // Single source of truth for where swayidle writes the idle stamp, so
        // the daemon and the probe cannot drift apart on the path.
        AGENTD_IDLE_STAMP_PATH: config.idleStampPath,
        // Propagate optional smoke-test override
        ...(process.env.AGENTD_IDLE_THRESHOLD_SECONDS
          ? { AGENTD_IDLE_THRESHOLD_SECONDS: process.env.AGENTD_IDLE_THRESHOLD_SECONDS }
          : {}),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("activity script timed out after 10s"));
    }, 10000);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        warn("activity_script_nonzero", { code, stderr });
      }
      try {
        const parsed = JSON.parse(stdout) as ActivityReport;
        resolve(parsed);
      } catch (e) {
        reject(new Error(`activity JSON parse failed: ${(e as Error).message}; stdout=${stdout.slice(0, 200)}`));
      }
    });
    child.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
  });
}

// Subset of blockers that should refuse a browser session START.
//
// A session runs on a nested, headless compositor output (config.compositorCmd)
// Jasper cannot see — it coexists with his real desktop session invisibly
// (see architecture.md "Takeover semantics"). So HUMAN-PRESENCE signals
// are deliberately NOT start-blockers: gaming, media, video calls, and
// recent keyboard/mouse input do not conflict with an invisible session.
// Jasper explicitly wants browsing to proceed even while he's gaming
// (2026-05-31 decision; he accepts the single-GPU contention trade-off).
//
// What REMAINS a start-blocker is genuine RESOURCE CONTENTION — work that
// would actually fight a browser session for CPU/disk/network/USB. Steam
// *downloads* and torrents are not here (they don't conflict); compilation,
// package installs, USB imaging, large transfers, sustained network, and an
// external SSH operator are.
//
// NOTE: this filter ONLY governs session start. The auto-suspend (drain)
// gate uses isCleanForSleep() below, which checks the FULL blocker list —
// so the box still will not sleep under Jasper while he's present.
//
// The set above models a WORKSTATION: "is Jasper doing something at his desk
// that a browser session would fight." That model does not transfer to an
// always-on SERVER browser host (the always-on host), where several of these are normal
// steady state rather than contention — `external_ssh` most of all, since
// routine admin (or a diagnostic shell) would otherwise stall an in-turn
// browse for as long as someone stays logged in. Override the whole set per
// box with AGENTD_SESSION_BLOCKERS (comma-separated; empty string ⇒ no
// start-blockers at all). Unset keeps the workstation default, so the workstation
// is unchanged.
const DEFAULT_SESSION_BLOCKERS = [
  "external_ssh",
  "compilation_running",
  "package_manager_running",
  "usb_imaging",
  "large_file_transfer",
  "sustained_network_high",
];

const SESSION_BLOCKERS = new Set(
  (process.env.AGENTD_SESSION_BLOCKERS === undefined
    ? DEFAULT_SESSION_BLOCKERS
    : process.env.AGENTD_SESSION_BLOCKERS.split(","))
    .map((b) => b.trim())
    .filter((b) => b.length > 0),
);

export function sessionBlockers(report: ActivityReport): string[] {
  return report.blockers.filter((b) => SESSION_BLOCKERS.has(b));
}

export function isCleanForSleep(report: ActivityReport): boolean {
  // For auto-sleep we are stricter — any blocker means stay awake.
  return report.blockers.length === 0;
}
