#!/usr/bin/env bash
# mint-activity.sh — agentd activity probe for MINT, the always-on browser host.
#
# Emits the JSON ActivityReport agentd's activity.ts expects (see the
# ActivityReport interface there). Runs in well under a second.
#
# WHY THIS IS NOT avalanche-activity.sh
# -------------------------------------
# the workstation's probe (~17 KB, lives untracked at ~/hearthoperator/bin/) answers
# a WORKSTATION question: "is Jasper at his desk doing something a browser
# session would fight?" — KWin idle time, Steam, media playback, video calls.
# the always-on host is a headless always-on SERVER (FRIDAY kiosk, Firecrawl, Home Assistant,
# searxng, mealie, matter-server, mosquitto). Nobody sits at it, so nearly all
# of that is dead weight, and treating an admin SSH as contention would stall
# an in-turn browse for as long as someone stays logged in.
#
# What actually contends on the always-on host is RAM: 31 GiB of system memory (96 GiB of the
# 128 is carved out to the Radeon 8060S) shared with the whole container stack.
# So this probe reports the workstation fields honestly-but-inertly and spends
# its attention on memory pressure and package-manager locks.
#
# The blockers emitted here are only advisory until listed in
# AGENTD_SESSION_BLOCKERS (see mint.service) — agentd filters against that set.
#
# Unlike the workstation's, this script is IN THE REPO. deploy.sh installs it; do not
# hand-edit the copy on the box.

set -u

# MemAvailable below this ⇒ memory_pressure. A Firefox session with a handful
# of tabs is comfortably under 2 GiB; 3 GiB leaves the container stack room to
# breathe rather than pushing the box toward the OOM killer.
MIN_AVAIL_MB="${AGENTD_MIN_AVAIL_MB:-3072}"

blockers=()

# ---------- memory ----------
avail_kb=$(awk '/^MemAvailable:/{print $2; exit}' /proc/meminfo 2>/dev/null || echo 0)
avail_mb=$(( avail_kb / 1024 ))
if [[ "$avail_mb" -gt 0 && "$avail_mb" -lt "$MIN_AVAIL_MB" ]]; then
  blockers+=("memory_pressure")
fi

# ---------- package manager ----------
# apt/dpkg/unattended-upgrades hold locks and churn disk; starting a browser
# mid-upgrade is asking for a half-installed library to be loaded.
pkg_running=false
if pgrep -x "apt|apt-get|dpkg|unattended-upgr" >/dev/null 2>&1; then
  pkg_running=true
  blockers+=("package_manager_running")
fi

# ---------- external ssh (REPORTED, not a blocker by default) ----------
# Counted for observability so `/status` still shows who is on the box, but
# deliberately absent from mint.service's AGENTD_SESSION_BLOCKERS: SSH is the
# normal way this server is administered, not a sign of contention.
ssh_external=$(who 2>/dev/null | grep -c "(" || true)
[[ "$ssh_external" =~ ^[0-9]+$ ]] || ssh_external=0

# ---------- agentd's own session ----------
# Determined by inspecting processes rather than calling back into /status, so
# the probe can never recurse into the daemon that spawned it.
agentd_session_active=false
if pgrep -x geckodriver >/dev/null 2>&1; then
  agentd_session_active=true
fi

# ---------- idle ----------
# No human sits at the always-on host; the only graphical session is the unattended FRIDAY
# kiosk running as user `friday`. Report a large idle so no presence heuristic
# anywhere reads this box as "someone is here."
idle_seconds="${AGENTD_FAKE_IDLE_SECONDS:-999999}"

# ---------- emit ----------
busy=false
[[ ${#blockers[@]} -gt 0 ]] && busy=true

blockers_json="["
first=1
for b in ${blockers[@]+"${blockers[@]}"}; do
  [[ $first -eq 1 ]] && first=0 || blockers_json+=","
  blockers_json+="\"$b\""
done
blockers_json+="]"

cat <<JSON
{
  "busy": $busy,
  "user_present": false,
  "blockers": $blockers_json,
  "details": {
    "user_idle_seconds": $idle_seconds,
    "ssh_sessions_external": $ssh_external,
    "media_playing": false,
    "video_conf_active": false,
    "agentd_session_active": $agentd_session_active,
    "steam_running": false,
    "steam_downloading": false,
    "network_throughput_mbps": 0,
    "mem_available_mb": $avail_mb,
    "mem_available_floor_mb": $MIN_AVAIL_MB,
    "package_manager_running": $pkg_running,
    "host_role": "always_on_browser_host"
  }
}
JSON
