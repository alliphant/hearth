import { readFileSync } from "node:fs";
import { config } from "./config";
import { info, warn } from "./log";

// WAKE CYCLE IDENTITY
//
// The question agentd has to answer before it may auto-suspend is not "is the
// box idle" but "did *I* wake this box." v1 answered it with a tmpfs marker
// scoped to the whole uptime, which is wrong: /run survives suspend/resume, so
// a marker written by a 06:01 WoL wake was still sitting there at 14:00, twelve
// resumes later, and every one of those resumes — all of them human — was
// treated as WoL-initiated. Observed 2026-08-03: one the LLM host wake, then seven
// auto-suspends under an actively-used desktop.
//
// The kernel already tracks exactly what we need. /sys/power/suspend_stats/success
// counts completed suspend/resume cycles; it is world-readable, resets on boot,
// and increments once per successful suspend. That counter IS the identity of
// the current awake period:
//
//   counter == 0   → this awake period began at BOOT
//   counter == N   → this awake period began at the Nth RESUME
//
// A marker stamped with cycle N is meaningless once the counter reads N+1 — the
// box has slept since, so whatever woke it this time is a different event. That
// makes yesterday's marker stale BY CONSTRUCTION rather than by a timeout.
//
// Counter identity alone is not sufficient, though. Consider a box the human
// woke at 13:00 (counter 1) that the LLM host then browses at 13:30: the counter is
// still 1, but WoL was never needed — the box was already up. So arming also
// requires TIME PROXIMITY to the start of the cycle: a /wake-ack that lands
// within `wakeAckWindowSeconds` of the resume is attributable to that resume;
// one that arrives half an hour later is the LLM host using a box that was already
// awake for someone else's reasons, and must not arm sleep.
//
// Hence the state machine: a resume opens an attribution window; a /wake-ack
// inside the window claims the cycle for WoL; silence means the cycle belongs
// to the human and will never auto-suspend.

const SUSPEND_COUNTER_PATH = "/sys/power/suspend_stats/success";
const POLL_INTERVAL_MS = 5_000;

export interface CycleState {
  // Kernel suspend counter — the identity of the current awake period.
  // null when the counter is unreadable (non-Linux, or a kernel built without
  // CONFIG_PM_SLEEP). Unreadable is treated as "cannot attribute", never as 0.
  cycleId: number | null;
  // When this awake period began, or null if agentd cannot know. Unknown is a
  // hard "do not arm": a restart mid-cycle must not inherit an attribution
  // window it never observed.
  cycleStartedAt: number | null;
  // How this awake period began — for logs and /status, so a stale-marker
  // question is answerable from the journal instead of by inference.
  origin: "boot" | "resume" | "unknown";
}

let state: CycleState = { cycleId: null, cycleStartedAt: null, origin: "unknown" };
let pollHandle: ReturnType<typeof setInterval> | null = null;

export function readSuspendCount(): number | null {
  try {
    const n = parseInt(readFileSync(SUSPEND_COUNTER_PATH, "utf8").trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// System boot time in ms since epoch, derived from /proc/uptime's first field.
// That field is CLOCK_BOOTTIME-based, so it INCLUDES time spent suspended —
// which is what we want here: we are locating the boot instant on the wall
// clock, not measuring how long the box has been awake.
function bootTimeMs(): number | null {
  try {
    const secs = parseFloat(readFileSync("/proc/uptime", "utf8").split(/\s+/)[0]);
    return Number.isFinite(secs) ? Date.now() - secs * 1000 : null;
  } catch {
    return null;
  }
}

export function cycleState(): CycleState {
  return { ...state };
}

// True when a /wake-ack arriving RIGHT NOW would be attributable to the event
// that started this awake period. Callers use this to decide whether a wake
// marker may arm auto-suspend.
export function withinAttributionWindow(now = Date.now()): boolean {
  if (state.cycleStartedAt === null) return false;
  return now - state.cycleStartedAt <= config.wakeAckWindowSeconds * 1000;
}

export function secondsSinceCycleStart(now = Date.now()): number | null {
  if (state.cycleStartedAt === null) return null;
  return Math.round((now - state.cycleStartedAt) / 1000);
}

function initState() {
  const count = readSuspendCount();
  if (count === null) {
    // No counter → no way to tell a resume from a boot, and no way to tell
    // cycles apart. Refuse to attribute rather than guessing; drain.ts turns
    // this into "never auto-suspend", which is the safe direction.
    state = { cycleId: null, cycleStartedAt: null, origin: "unknown" };
    warn("wake_cycle_counter_unavailable", { path: SUSPEND_COUNTER_PATH });
    return;
  }

  if (count === 0) {
    // The box has not suspended since boot, so this awake period IS the boot
    // period. Anchoring to boot time (not to agentd's start time) keeps the
    // attribution window honest across an agentd restart in the first minutes
    // of uptime, and covers WoL-from-power-off, where the magic packet boots
    // the machine instead of resuming it and the counter never moves.
    const boot = bootTimeMs();
    state = { cycleId: 0, cycleStartedAt: boot, origin: boot === null ? "unknown" : "boot" };
  } else {
    // agentd restarted partway through an awake period that began with a resume
    // it never observed. The resume instant is not recoverable after the fact,
    // so the window is unknown and this cycle cannot be armed. A genuine WoL
    // wake immediately after an agentd crash-restart is the cost; staying awake
    // is the correct failure.
    state = { cycleId: count, cycleStartedAt: null, origin: "unknown" };
  }

  info("wake_cycle_init", {
    cycle_id: state.cycleId,
    origin: state.origin,
    cycle_started_at: state.cycleStartedAt ? new Date(state.cycleStartedAt).toISOString() : null,
    attribution_window_seconds: config.wakeAckWindowSeconds,
  });
}

function poll() {
  const count = readSuspendCount();
  if (count === null || count === state.cycleId) return;

  // Counter moved: the box suspended and has just come back. This is the only
  // place a cycle starts with origin "resume", and it re-opens the attribution
  // window. Any marker stamped with the previous cycle id is now stale and will
  // be rejected by wake.ts without needing to be deleted.
  const previous = state.cycleId;
  state = { cycleId: count, cycleStartedAt: Date.now(), origin: "resume" };
  info("wake_cycle_resumed", {
    cycle_id: count,
    previous_cycle_id: previous,
    attribution_window_seconds: config.wakeAckWindowSeconds,
  });
}

export function startWakeCycleTracker() {
  if (pollHandle) return;
  initState();
  // 5s polling of a one-line sysfs read. The interval bounds how late a resume
  // can be noticed, which matters because Hearth's /wake-ack lands within
  // seconds of the box answering /health — detecting the resume after the ack
  // would reject a legitimate WoL wake.
  pollHandle = setInterval(poll, POLL_INTERVAL_MS);
  pollHandle.unref?.();
}

export function stopWakeCycleTracker() {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}
