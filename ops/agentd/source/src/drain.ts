import { exec } from "node:child_process";
import { config } from "./config";
import { info, warn } from "./log";
import { sessionsActive, lastSessionEndedAt } from "./sessions";
import { runActivityCheck, isCleanForSleep, ActivityReport } from "./activity";
import { evaluateWakeMarker, clearWakeMarker } from "./wake";
import { cycleState } from "./wakeCycle";

let tickHandle: ReturnType<typeof setInterval> | null = null;

function execAsync(cmd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 10000 }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        code: err ? (err as any).code ?? 1 : 0,
      });
    });
  });
}

let lastSuspendAt = 0;
let startedAt = Date.now();

// When the box last had a reason to be awake.
//
// v1 measured the drain window from the last SESSION TEARDOWN, which quietly
// turned `drainSeconds` into a one-shot: after the final session of the day
// ended, `drainedFor` grew without bound (observed: 28,678s against a 180s
// window) and the grace period was permanently expired. With the gate stuck
// open, a single 30-second tick that happened to sample zero blockers was
// enough to suspend — no debounce, no sustained-idle requirement. That is why
// the box slept the instant a video paused.
//
// Measuring from the last BUSY observation restores the contract the setting
// describes: the box must be continuously clean for `drainSeconds` before it
// may sleep, every time, not once per session.
let lastBusyAt = 0;

function markBusy(now = Date.now()) {
  lastBusyAt = now;
}

// The instant from which the current drain window is measured. Whichever
// reason-to-be-awake is most recent wins.
function drainSince(): number {
  return Math.max(startedAt, lastBusyAt, lastSessionEndedAt());
}

async function tick() {
  try {
    if (sessionsActive() > 0) {
      // A live session IS activity — hold the drain window open so teardown
      // starts a fresh one rather than inheriting a window that elapsed while
      // the session was running.
      markBusy();
      return;
    }

    let activity: ActivityReport;
    try {
      activity = await runActivityCheck();
    } catch (e) {
      // An unreadable activity probe is not evidence of an idle box. Treat the
      // failure as busy: it holds the drain window open and the box stays
      // awake, which is the recoverable direction.
      markBusy();
      warn("drain_activity_check_failed", { error: (e as Error).message });
      return;
    }

    // Human at the keyboard retires the marker outright. This is the one place
    // a wake cycle changes hands: Hearth woke the box, but the human has since
    // sat down at it, so it is now theirs and agentd must not take it away.
    //
    // Keyed off the probe's own `user_present` rather than a second, lower
    // hardcoded threshold. v1 compared user_idle_seconds < 60 while the probe
    // called anything under 600s "present", leaving a 540-second band where the
    // box would neither sleep nor release the marker — and, since the probe was
    // reporting uptime rather than idleness, a window that in practice only
    // opened in the first 60 seconds after boot. The marker was cleared twice
    // in its entire service life.
    const verdict = evaluateWakeMarker();
    if (activity.user_present && verdict.marker !== null) {
      clearWakeMarker("user_active");
      markBusy();
      return;
    }

    if (!verdict.honored) {
      // INVARIANT: no honored marker → never auto-suspend. A box agentd did not
      // wake is not agentd's to put back to sleep.
      if (!activity.busy) markBusy();
      return;
    }

    const drainedFor = (Date.now() - drainSince()) / 1000;
    if (drainedFor < config.drainSeconds) {
      info("drain_evaluated", {
        busy: activity.busy,
        drained_for: Math.round(drainedFor),
        drain_seconds: config.drainSeconds,
        marker_present: true,
        reason: "drain_not_elapsed",
      });
      return;
    }

    if (!isCleanForSleep(activity)) {
      markBusy();
      info("drain_evaluated", {
        busy: true,
        drained_for: Math.round(drainedFor),
        blockers: activity.blockers,
        marker_present: true,
      });
      return;
    }

    // throttle suspend calls to once per 60s to avoid spam if stub used
    if (Date.now() - lastSuspendAt < 60_000) return;
    lastSuspendAt = Date.now();

    const marker = verdict.marker;
    info("auto_suspend", {
      drained_for: Math.round(drainedFor),
      // Real provenance, read off the marker. v1 hardcoded woken_by:"wol" here,
      // so every suspend in the journal claimed to be answering a WoL wake —
      // including the seven that were not, which is why this went unnoticed.
      woken_by: marker?.source ?? "unknown",
      task_id: marker?.task_id ?? null,
      cycle_id: verdict.current_cycle_id,
      cycle_origin: marker?.cycle_origin ?? "unknown",
      cmd: config.suspendCmd,
    });

    // Consume the marker BEFORE suspending. The wake it recorded is now
    // answered, and a marker must never outlive the cycle it authorized — the
    // cycle-id check in wake.ts would reject it on the next resume anyway, but
    // leaving a spent marker on disk makes /status lie about why the box is
    // asleep. If the suspend command then fails, the box stays awake with no
    // marker: it will not retry, which is the correct failure.
    clearWakeMarker("consumed_by_suspend");

    const r = await execAsync(config.suspendCmd);
    if (r.code !== 0) {
      warn("auto_suspend_cmd_nonzero", { code: r.code, stderr: r.stderr, stdout: r.stdout });
    } else if (r.stdout.trim().length > 0) {
      info("auto_suspend_cmd_output", { stdout: r.stdout.trim() });
    }
  } catch (e) {
    warn("drain_tick_error", { error: (e as Error).message });
  }
}

export function startDrainTicker() {
  startedAt = Date.now();
  markBusy(startedAt);
  if (tickHandle) return;
  tickHandle = setInterval(() => {
    void tick();
  }, 30_000);
  info("drain_armed", {
    drain_seconds: config.drainSeconds,
    cycle_id: cycleState().cycleId,
    cycle_origin: cycleState().origin,
  });
}

export function stopDrainTicker() {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

// Allow test/manual evaluation immediately.
export async function evaluateDrainNow() {
  await tick();
}
