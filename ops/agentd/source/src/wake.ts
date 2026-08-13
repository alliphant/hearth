import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { info, warn } from "./log";
import { cycleState, withinAttributionWindow, secondsSinceCycleStart } from "./wakeCycle";

// THE WAKE MARKER
//
// Records that the CURRENT awake period was started by a remote wake, and is
// therefore agentd's to end. See wakeCycle.ts for why "current awake period"
// and not "current uptime" — that distinction is the whole bug this file was
// rewritten to fix.
//
// The marker now carries the wake-cycle id it was written in, plus whether it
// was written close enough to the start of that cycle to be attributable to it.
// Both are decided ONCE, at /wake-ack time, and frozen into the file: a marker
// that did not arm sleep when it was written must never become armed later.

export interface WakeMarker {
  woken_at: string;
  source: string;
  task_id: string | null;
  // Wake-cycle id (kernel suspend counter) at the moment of /wake-ack. A marker
  // is only honored while the counter still reads this value.
  cycle_id: number | null;
  // How the cycle this marker belongs to began.
  cycle_origin: "boot" | "resume" | "unknown";
  // Whether this ack landed inside the attribution window — i.e. whether a
  // remote wake is what made the box available. False means Hearth reached a
  // box that was ALREADY AWAKE for someone else's reasons; it may use it, but
  // it may not put it to sleep afterwards.
  armed: boolean;
  // Seconds between the start of the cycle and this ack, for diagnosis.
  ack_delay_seconds: number | null;
}

function markerPath(): string {
  return join(config.wakeMarkerDir, config.wakeMarkerFile);
}

export function readWakeMarker(): WakeMarker | null {
  try {
    const raw = readFileSync(markerPath(), "utf8").trim();
    if (!raw) return null;
    return JSON.parse(raw) as WakeMarker;
  } catch {
    return null;
  }
}

export function wakeMarkerPresent(): boolean {
  return existsSync(markerPath());
}

export interface MarkerVerdict {
  // The single question drain.ts asks: may this box auto-suspend right now?
  honored: boolean;
  reason:
    | "armed"
    | "no_marker"
    | "unreadable"
    | "not_armed_at_ack"
    | "stale_cycle";
  marker: WakeMarker | null;
  current_cycle_id: number | null;
}

// Decide whether the marker on disk authorizes an auto-suspend.
//
// Deliberately a pure read: a marker that fails this check is NOT deleted.
// Deleting it would destroy the evidence that explains why a box did or did not
// sleep, and the check is cheap and idempotent. Markers are removed only when
// consumed by a suspend, or when the human is observed at the keyboard.
export function evaluateWakeMarker(): MarkerVerdict {
  const current = cycleState().cycleId;
  if (!wakeMarkerPresent()) {
    return { honored: false, reason: "no_marker", marker: null, current_cycle_id: current };
  }
  const marker = readWakeMarker();
  if (marker === null) {
    return { honored: false, reason: "unreadable", marker: null, current_cycle_id: current };
  }
  if (!marker.armed) {
    return { honored: false, reason: "not_armed_at_ack", marker, current_cycle_id: current };
  }
  // The stale case that caused 2026-08-03: marker written in cycle N, box has
  // since slept and come back as cycle N+1. Whatever woke it this time, it was
  // not the wake this marker describes.
  if (marker.cycle_id !== current) {
    return { honored: false, reason: "stale_cycle", marker, current_cycle_id: current };
  }
  return { honored: true, reason: "armed", marker, current_cycle_id: current };
}

export function setWakeMarker(source: string, taskId: string | undefined) {
  try {
    if (!existsSync(config.wakeMarkerDir)) {
      mkdirSync(config.wakeMarkerDir, { recursive: true, mode: 0o755 });
    }
    const cycle = cycleState();
    const armed = withinAttributionWindow();
    const payload: WakeMarker = {
      woken_at: new Date().toISOString(),
      source,
      task_id: taskId ?? null,
      cycle_id: cycle.cycleId,
      cycle_origin: cycle.origin,
      armed,
      ack_delay_seconds: secondsSinceCycleStart(),
    };
    writeFileSync(markerPath(), JSON.stringify(payload) + "\n", { mode: 0o644 });
    // Logged at info either way, and loudly when NOT armed: "Hearth acked but
    // the box stays awake" is the single most likely thing to look confusing in
    // the journal, so it explains itself on the spot.
    if (armed) {
      info("wake_marker_set", {
        source,
        task_id: taskId,
        cycle_id: payload.cycle_id,
        cycle_origin: payload.cycle_origin,
        ack_delay_seconds: payload.ack_delay_seconds,
        armed: true,
      });
    } else {
      info("wake_marker_set_unarmed", {
        source,
        task_id: taskId,
        cycle_id: payload.cycle_id,
        cycle_origin: payload.cycle_origin,
        ack_delay_seconds: payload.ack_delay_seconds,
        attribution_window_seconds: config.wakeAckWindowSeconds,
        armed: false,
        note: "box was already awake; session may proceed but auto-suspend stays disarmed",
      });
    }
  } catch (e) {
    warn("wake_marker_set_failed", { error: (e as Error).message });
    throw e;
  }
}

export function clearWakeMarker(reason: string) {
  try {
    rmSync(markerPath(), { force: true });
    info("wake_marker_cleared", { reason });
  } catch (e) {
    warn("wake_marker_clear_failed", { error: (e as Error).message });
  }
}
