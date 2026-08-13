// Firefox profile-lock self-healing.
//
// Firefox enforces one-instance-per-profile with two lock files in the
// profile directory:
//   • `lock`        — a symlink whose target encodes `<ip>:+<pid>` of the
//                     owning process. Dangling by design (the target is not
//                     a real path), so it must be probed with lstat, never
//                     existsSync (which follows the link and reports false).
//   • `.parentlock` — a regular file held under an fcntl lock by the main
//                     Firefox process.
//
// Both are written on profile open and removed on clean close. After an
// unclean exit (crash, SIGKILL of a geckodriver-spawned Firefox, an
// interactive `firefox -P <agent>` session that didn't shut down cleanly, or
// a suspend that froze a lingering process) the files survive with no live
// owner — a STALE lock. geckodriver then fails the next `POST /session` with
// "Failed to set preferences", even though nothing actually holds the profile.
//
// Clearing a stale lock is safe: the files carry no profile data, and a clean
// Firefox close removes them as a matter of course. The ONLY danger is
// removing a lock a *live* Firefox still holds and then launching a second
// instance against the same profile — concurrent writers corrupt the saved
// logins/cookies these per-agent profiles exist to hold. So we never remove a
// lock blindly: we first prove no live Firefox owns the profile, and report a
// live owner so the caller refuses rather than corrupts.

import { lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { warn } from "./log";

export type ProfileLockState = "clear" | "cleared_stale" | "live";

export interface ProfileLockResult {
  /** "clear": no lock present. "cleared_stale": lock had no live owner and was
   *  removed. "live": a real Firefox owns the profile — do not touch it. */
  state: ProfileLockState;
  /** PID of the live Firefox owning the profile (state === "live"). */
  pid?: number;
  /** PID parsed from the `lock` symlink before removal, for diagnostics
   *  (state === "cleared_stale"); null if the symlink was absent/unparseable. */
  stalePid?: number | null;
  /** Lock files actually removed (state === "cleared_stale"). */
  removed?: string[];
}

const LOCK_FILES = ["lock", ".parentlock"] as const;

/** lstat-based existence — detects the dangling `lock` symlink, which
 *  existsSync misses because it follows the link to a non-existent target. */
function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort PID from the `lock` symlink target (`<ip>:+<pid>`). */
function readLockPid(profilePath: string): number | null {
  try {
    const target = readlinkSync(join(profilePath, "lock"));
    const m = target.match(/\+(\d+)\s*$/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function isFirefoxProc(pid: number): boolean {
  try {
    if (/firefox/i.test(readFileSync(`/proc/${pid}/comm`, "utf8").trim())) return true;
  } catch {
    /* process gone or comm unreadable — fall through to cmdline */
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("firefox");
  } catch {
    return false;
  }
}

/** Does process `pid` hold an open file descriptor inside `dir`? */
function holdsFdUnder(pid: number, dir: string): boolean {
  const fdDir = `/proc/${pid}/fd`;
  let entries: string[];
  try {
    entries = readdirSync(fdDir);
  } catch {
    return false; // process exited, or not our uid
  }
  const prefix = dir.endsWith("/") ? dir : dir + "/";
  for (const fd of entries) {
    try {
      const target = readlinkSync(join(fdDir, fd));
      if (target === dir || target.startsWith(prefix)) return true;
    } catch {
      /* fd vanished mid-scan */
    }
  }
  return false;
}

/**
 * Scan /proc for a live Firefox process holding an open descriptor inside
 * `profilePath`. This is the launch-method-independent proof that a browser is
 * using the profile right now: it catches geckodriver's `--profile <path>`
 * spawns AND a human's `firefox -P <name>` session (whose cmdline names the
 * profile, not its path), and is immune to PID reuse — a recycled PID won't
 * have the profile's sqlite files open. Returns the owning PID, or null.
 *
 * agentd and any interactive Firefox run as the same uid, so /proc/<pid>/fd is
 * readable for the processes we care about; foreign-uid procs simply fail the
 * readdir and are skipped.
 */
function findLiveOwner(profilePath: string): number | null {
  let pids: string[];
  try {
    pids = readdirSync("/proc");
  } catch {
    return null;
  }
  for (const ent of pids) {
    if (!/^\d+$/.test(ent)) continue;
    const pid = Number(ent);
    if (!isFirefoxProc(pid)) continue;
    if (holdsFdUnder(pid, profilePath)) return pid;
  }
  return null;
}

/**
 * Ensure `profilePath` is safe to launch Firefox against. Removes a stale lock
 * (no live owner) automatically; reports a live owner without touching
 * anything. Call before spawning geckodriver for the profile.
 */
export function ensureProfileUnlocked(profilePath: string): ProfileLockResult {
  const present = LOCK_FILES
    .map((f) => join(profilePath, f))
    .filter((p) => lexists(p));
  if (present.length === 0) return { state: "clear" };

  const owner = findLiveOwner(profilePath);
  if (owner !== null) return { state: "live", pid: owner };

  // No live Firefox owns the profile → the lock is stale. Remove it.
  const stalePid = readLockPid(profilePath);
  const removed: string[] = [];
  for (const p of present) {
    try {
      rmSync(p, { force: true });
      removed.push(p);
    } catch (e) {
      warn("profile_lock_unlink_failed", { path: p, error: (e as Error).message });
    }
  }
  return { state: "cleared_stale", stalePid, removed };
}
