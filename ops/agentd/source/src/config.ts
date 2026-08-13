import { readFileSync } from "node:fs";

export const VERSION = "0.1.0";

const HOME = process.env.HOME ?? "/root";

// Resolved once because two things live in it: the wake marker and the swayidle
// idle stamp. Deriving the stamp path from this means a box that overrides
// AGENTD_WAKE_MARKER_DIR — the workstation does, to /run/avalanche-wake — gets a
// matching stamp path for free instead of needing a second environment
// override kept in sync by hand.
const WAKE_MARKER_DIR = process.env.AGENTD_WAKE_MARKER_DIR ?? "/run/agentd-wake";

export const config = {
  port: parseInt(process.env.AGENTD_PORT ?? "4446", 10),
  bind: process.env.AGENTD_BIND ?? "0.0.0.0",
  tokenFile: process.env.AGENTD_TOKEN_FILE ?? `${HOME}/.config/agentd/token`,
  // Path to a small shell script that prints the seconds-since-keyboard-
  // input. Defaults to the one ops/agentd/install.sh drops next to the
  // service. Override with AGENTD_ACTIVITY_SCRIPT for custom setups.
  activityScript:
    process.env.AGENTD_ACTIVITY_SCRIPT ?? `${HOME}/.config/agentd/activity.sh`,
  // Idle stamp maintained by swayidle (see ops/systemd/agentd-idle-stamp.service).
  // The activity script reads it to get a REAL seconds-since-input on Wayland,
  // where neither the ScreenSaver D-Bus call nor logind's IdleHint reports
  // anything usable under KWin. Exported to the script via the environment so
  // both halves agree on the path without hard-coding it twice.
  idleStampPath:
    process.env.AGENTD_IDLE_STAMP_PATH ?? `${WAKE_MARKER_DIR}/idle-since`,
  drainSeconds: parseInt(process.env.AGENTD_DRAIN_SECONDS ?? "180", 10),
  // tmpfs-backed marker dir. Tracks whether the current WAKE CYCLE was
  // WoL-initiated (OK to auto-sleep) or human-initiated.
  //
  // "Wake cycle", emphatically not "uptime" — /run is cleared on boot but
  // SURVIVES suspend/resume, so a marker scoped to uptime outlives the wake it
  // describes and keeps authorizing sleep across every later resume, including
  // the human's. That is exactly what happened on 2026-08-03. The cycle
  // identity that makes the scoping correct lives in wakeCycle.ts; the marker
  // itself now records which cycle wrote it.
  wakeMarkerDir: WAKE_MARKER_DIR,
  wakeMarkerFile: "woken-by-wol",
  // How long after a wake cycle begins a /wake-ack is still attributable to
  // that wake. Hearth's documented sequence is: magic packet → poll /health
  // every 2s for up to 90s → POST /wake-ack, so a legitimate ack lands well
  // inside this. An ack arriving LATER means Hearth reached a box that was
  // already awake — WoL was never needed — and must not arm auto-suspend.
  wakeAckWindowSeconds: parseInt(process.env.AGENTD_WAKE_ACK_WINDOW_SECONDS ?? "180", 10),
  suspendCmd: process.env.AGENTD_SUSPEND_CMD ?? "systemctl suspend",
  // ALWAYS-ON MODE. On a box that never sleeps (the always-on host — it hosts the FRIDAY
  // kiosk, Firecrawl, Home Assistant and friends 24/7) the whole WoL / drain /
  // suspend state machine is not merely unnecessary but wrong: there is no
  // "woken by WoL" uptime to tell apart from a human one, and issuing
  // `systemctl suspend` would take the household stack down. With
  // AGENTD_ALWAYS_ON=1 the drain ticker is never armed and /wake-ack is
  // refused, so the suspend path is unreachable BY CONSTRUCTION rather than
  // merely unused. Defaults off — the workstation's behavior is untouched.
  //
  // NB agentd already never auto-suspends without a wake marker (drain.ts
  // invariant #1). This flag makes that structural instead of incidental, and
  // stops a stray /wake-ack from arming sleep on a host whose entire point is
  // being always-on.
  alwaysOn: (process.env.AGENTD_ALWAYS_ON ?? "0") === "1",
  geckodriverPortMin: 4500,
  geckodriverPortMax: 4599,
  // Max concurrent browser sessions. v1 hard-coded 1 — any second agent got a
  // 503. That was a soft limit chosen when only Maggie browsed; it becomes a
  // real contention point once Kate uses browse_url as her in-turn
  // web_fetch_clean failover on an always-on host. The per-session plumbing
  // (unique Wayland socket, unique geckodriver port out of a 100-port range,
  // per-agent profile) was already built for concurrency — only this cap stood
  // in the way. Default stays 1, so the workstation behaves byte-identically.
  maxSessions: parseInt(process.env.AGENTD_MAX_SESSIONS ?? "1", 10),
  // Compositor hosting the nested, human-invisible session output. the workstation
  // runs KDE, so kwin_wayland is native there and stays the default. the always-on host runs
  // GNOME, where `apt install kwin-wayland` drags in 461 packages of Plasma;
  // weston's headless backend is 10 and yields the same thing — verified
  // hardware GL on the Radeon 8060S (the integrated AI accelerator):
  //   GL renderer: AMD Radeon Graphics (radeonsi, gfx1151, LLVM 20.1.2)
  // Hardware GL is REQUIRED, not a nicety: a software (llvmpipe) WebGL vendor
  // string is precisely the bot signal this whole surface exists to avoid.
  //
  // {socket} / {width} / {height} are substituted at spawn. Args split on
  // whitespace, so no single argument may contain a space.
  compositorCmd: process.env.AGENTD_COMPOSITOR_CMD ?? "kwin_wayland",
  compositorArgs:
    process.env.AGENTD_COMPOSITOR_ARGS ??
    "--virtual --width {width} --height {height} --xwayland --socket {socket}",
  compositorWidth: process.env.AGENTD_COMPOSITOR_WIDTH ?? "1920",
  compositorHeight: process.env.AGENTD_COMPOSITOR_HEIGHT ?? "1080",
  // Absolute path to the Firefox binary geckodriver should launch. Empty ⇒
  // geckodriver's own PATH search (correct on the workstation, whose distro Firefox
  // is unconfined). the always-on host's distro Firefox is a SNAP — confined to
  // ~/snap/firefox, so it can neither open a profile at an arbitrary path nor
  // reach our per-session Wayland socket under XDG_RUNTIME_DIR. There we point
  // at an unconfined Mozilla build under ~/opt.
  firefoxBinary: process.env.AGENTD_FIREFOX_BINARY ?? "",
  // geckodriver executable, and the PATH handed to it. Both matter on a box
  // where the browser stack is NOT distro-installed: the always-on host's geckodriver lives
  // under ~/opt/bin (the distro one is a snap), which neither `geckodriver` on
  // a bare PATH nor the "/usr/bin:/usr/local/bin" default below would find.
  // geckodriver also uses this PATH for its own subprocess lookups, so keep
  // the Firefox binary's directory on it even though we pin it explicitly.
  geckodriverBinary: process.env.AGENTD_GECKODRIVER_BINARY ?? "geckodriver",
  geckodriverPath: process.env.AGENTD_GECKODRIVER_PATH ?? "/usr/bin:/usr/local/bin",
  // host:port the ORCHESTRATOR reaches this agentd on, echoed back as
  // `webdriver_base`. Informational (the connector builds its own URLs from
  // its own config), but it was hard-coded to "the workstation.local" — wrong the
  // moment a second browser host exists.
  publicHost: process.env.AGENTD_PUBLIC_HOST ?? "localhost",
  // Firefox profile root. On most distros this is ~/.mozilla/firefox,
  // but some XDG-flavored setups (e.g. some Plasma configurations) use
  // ~/.config/mozilla/firefox. Override with AGENTD_FIREFOX_PROFILE_BASE.
  firefoxProfileBase:
    process.env.AGENTD_FIREFOX_PROFILE_BASE ?? `${HOME}/.mozilla/firefox`,
  xdgRuntimeDir: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`,
};

let cachedToken: string | null = null;
export function getToken(): string {
  if (cachedToken !== null) return cachedToken;
  try {
    cachedToken = readFileSync(config.tokenFile, "utf8").trim();
  } catch (e) {
    throw new Error(`Cannot read token at ${config.tokenFile}: ${(e as Error).message}`);
  }
  if (!cachedToken) throw new Error(`Empty token at ${config.tokenFile}`);
  return cachedToken;
}
