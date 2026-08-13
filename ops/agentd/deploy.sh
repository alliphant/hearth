#!/usr/bin/env bash
# ============================================================================
# agentd deploy — push the repo's reference source to the the workstation box
# ============================================================================
# the workstation's agentd runs from a hand-copied tree at ~/hearthoperator/agentd
# that is NOT a git checkout. Before this script existed it drifted silently
# from the repo's reference copy (ops/agentd/source). This makes the deploy
# reproducible: rsync ops/agentd/source/ -> the box, then restart + health
# check. `--check` does a no-op drift diff (source + the systemd unit) and
# exits non-zero on any difference, so it is safe to wire into CI.
#
# Run it from a machine that can `ssh avalanche` (Jasper's Mac — the workstation is
# NOT name-resolvable from the LLM host). the workstation's login shell is fish, so every
# remote command is wrapped as `bash -lc "..."`.
#
# There is more than one browser host now (the always-on host is the always-on primary,
# the workstation the last-resort fallback), so the box-specific bits are selected by
# HOST PROFILE. A profile is just a naming convention in this directory:
#   <profile>.service            the canonical systemd --user unit  (required)
#   <profile>-activity.sh        the activity probe                 (optional)
#   <profile>-idle-stamp.service the swayidle idle sensor unit      (optional)
# The unit carries every box-specific value as Environment= overrides, so
# adding a third browser host means adding files here — not editing
# config.ts, and not editing this script.
#
# Usage:
#   ops/agentd/deploy.sh            # deploy source, restart, verify health
#   ops/agentd/deploy.sh --check    # drift check only; non-zero exit on drift
#   ops/agentd/deploy.sh --no-restart  # deploy files but leave the service alone
#   ops/agentd/deploy.sh --help
#
#   AGENTD_HOST_PROFILE=mint AGENTD_SSH_HOST=your-always-on-host.local ops/agentd/deploy.sh
#
# Env overrides:
#   AGENTD_HOST_PROFILE box profile / unit basename (default: avalanche)
#   AGENTD_SSH_HOST     ssh alias / host           (default: the profile name)
#   AGENTD_REMOTE_DIR   home-relative target dir   (default: hearthoperator/agentd)
#   AGENTD_ACTIVITY_DIR home-relative probe dir    (default: hearthoperator/bin)
#   AGENTD_PORT         health-check port          (default: 4446)
# ============================================================================
set -euo pipefail

AGENTD_HOST_PROFILE="${AGENTD_HOST_PROFILE:-avalanche}"
AGENTD_SSH_HOST="${AGENTD_SSH_HOST:-$AGENTD_HOST_PROFILE}"
AGENTD_REMOTE_DIR="${AGENTD_REMOTE_DIR:-hearthoperator/agentd}"   # relative to remote $HOME
AGENTD_ACTIVITY_DIR="${AGENTD_ACTIVITY_DIR:-hearthoperator/bin}"  # relative to remote $HOME
AGENTD_PORT="${AGENTD_PORT:-4446}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/source"
REF_UNIT="$SCRIPT_DIR/${AGENTD_HOST_PROFILE}.service"
# Optional: only some profiles keep their probe in the repo. Both the workstation's
# and the always-on host's are now version-controlled — the workstation's was untracked on the box
# until 2026-08-03, and drifted into reporting seconds-since-boot as idleness,
# which is exactly the class of silent gating change this script exists to stop.
REF_ACTIVITY="$SCRIPT_DIR/${AGENTD_HOST_PROFILE}-activity.sh"
# Optional: the idle sensor unit. agentd's activity probe reads the stamp this
# maintains, so a missing or stale copy silently downgrades user_idle_seconds
# to null and changes what the box is willing to sleep through.
REF_IDLE_STAMP="$SCRIPT_DIR/${AGENTD_HOST_PROFILE}-idle-stamp.service"
IDLE_STAMP_UNIT="agentd-idle-stamp.service"

MODE="deploy"
DO_RESTART=true

while [ $# -gt 0 ]; do
  case "$1" in
    --check)      MODE="check"; shift ;;
    --no-restart) DO_RESTART=false; shift ;;
    --help|-h)    sed -n '2,39p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Files rsync must never push or delete on the box:
#   node_modules  — installed remotely, not vendored in the repo
#   *.bak.*       — rollback backups left by hand-edits; preserved deliberately
RSYNC_EXCLUDES=(--exclude 'node_modules' --exclude '*.bak.*' --exclude '.DS_Store')

red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

remote() { ssh "$AGENTD_SSH_HOST" "bash -lc '$1'"; }

[ -d "$SOURCE_DIR" ] || { red "source dir missing: $SOURCE_DIR"; exit 1; }
[ -f "$REF_UNIT" ] || {
  red "unknown host profile '${AGENTD_HOST_PROFILE}': no ${REF_UNIT}"
  dim "  available: $(ls "$SCRIPT_DIR"/*.service 2>/dev/null | xargs -n1 basename 2>/dev/null | sed 's/\.service$//' | tr '\n' ' ')"
  exit 1
}

# ── activity probe drift (only for profiles that keep theirs in the repo) ────
activity_drift() {
  [ -f "$REF_ACTIVITY" ] || return 0
  local live
  live="$(remote "cat ~/${AGENTD_ACTIVITY_DIR}/$(basename "$REF_ACTIVITY")" 2>/dev/null || true)"
  if [ -z "$live" ]; then
    echo "LIVE ACTIVITY PROBE MISSING"
    return
  fi
  diff -u "$REF_ACTIVITY" <(printf '%s\n' "$live") || true
}

# ── idle sensor unit drift ──────────────────────────────────────────────────
# Deployed under the generic name agentd-idle-stamp.service on the box: the
# profile prefix distinguishes hosts in the repo, not in the box's unit dir.
idle_stamp_drift() {
  [ -f "$REF_IDLE_STAMP" ] || return 0
  local live
  live="$(remote "cat ~/.config/systemd/user/${IDLE_STAMP_UNIT}" 2>/dev/null || true)"
  if [ -z "$live" ]; then
    echo "LIVE IDLE SENSOR UNIT MISSING"
    return
  fi
  diff -u "$REF_IDLE_STAMP" <(printf '%s\n' "$live") || true
}

# ── source drift (checksum-based; ignores mtime) ────────────────────────────
# -c compares by checksum so a redeploy with fresh timestamps is not flagged.
# We grep for actual file transfers (>f...) and deletions (*deleting); pure
# directory-timestamp lines (.d..t...) are noise and ignored.
source_drift() {
  rsync -rlci --dry-run --delete "${RSYNC_EXCLUDES[@]}" -e ssh \
    "$SOURCE_DIR/" "${AGENTD_SSH_HOST}:${AGENTD_REMOTE_DIR}/" \
    | grep -E '^>f|^<f|^\*deleting' || true
}

# ── unit drift (the env contract lives in the unit, not config.ts) ──────────
unit_drift() {
  local live
  live="$(remote 'cat ~/.config/systemd/user/agentd.service' 2>/dev/null || true)"
  if [ -z "$live" ]; then
    echo "LIVE UNIT MISSING"
    return
  fi
  diff -u "$REF_UNIT" <(printf '%s\n' "$live") || true
}

if [ "$MODE" = "check" ]; then
  echo "── source drift (repo → ${AGENTD_SSH_HOST}:${AGENTD_REMOTE_DIR}) ──"
  src="$(source_drift)"
  echo "── unit drift (${AGENTD_HOST_PROFILE}.service → live agentd.service) ──"
  unit="$(unit_drift)"
  act="$(activity_drift)"
  idle="$(idle_stamp_drift)"
  drift=false
  if [ -n "$src" ];  then red "SOURCE DRIFT:"; echo "$src"; drift=true; else green "source in sync"; fi
  if [ -n "$unit" ]; then red "UNIT DRIFT:";  echo "$unit"; drift=true; else green "unit in sync"; fi
  if [ -f "$REF_ACTIVITY" ]; then
    if [ -n "$act" ]; then red "ACTIVITY PROBE DRIFT:"; echo "$act"; drift=true; else green "activity probe in sync"; fi
  fi
  if [ -f "$REF_IDLE_STAMP" ]; then
    if [ -n "$idle" ]; then red "IDLE SENSOR DRIFT:"; echo "$idle"; drift=true; else green "idle sensor in sync"; fi
  fi
  $drift && { red "DRIFT DETECTED"; exit 1; }
  green "no drift"; exit 0
fi

# ── deploy ──────────────────────────────────────────────────────────────────
echo "Deploying ${SOURCE_DIR}/ → ${AGENTD_SSH_HOST}:${AGENTD_REMOTE_DIR}/"
rsync -rlci --delete "${RSYNC_EXCLUDES[@]}" -e ssh \
  "$SOURCE_DIR/" "${AGENTD_SSH_HOST}:${AGENTD_REMOTE_DIR}/"
green "source synced"

# The activity probe is a deploy artifact like the source is — agentd shells
# out to it every drain/pre-flight tick, so a stale copy silently changes
# gating behavior. Push it for profiles that keep it in the repo.
if [ -f "$REF_ACTIVITY" ]; then
  remote "mkdir -p ~/${AGENTD_ACTIVITY_DIR}"
  rsync -lci -e ssh "$REF_ACTIVITY" \
    "${AGENTD_SSH_HOST}:${AGENTD_ACTIVITY_DIR}/$(basename "$REF_ACTIVITY")"
  remote "chmod +x ~/${AGENTD_ACTIVITY_DIR}/$(basename "$REF_ACTIVITY")"
  green "activity probe synced"
fi

# The idle sensor unit is a deploy artifact for the same reason: agentd's
# gating reads the stamp swayidle maintains, so a stale unit changes behavior
# silently. try-restart rather than restart — a box where the sensor has never
# been enabled should stay that way until someone runs `enable --now` (and
# installs swayidle); this must not quietly start services on a new host.
if [ -f "$REF_IDLE_STAMP" ]; then
  remote 'mkdir -p ~/.config/systemd/user'
  rsync -lci -e ssh "$REF_IDLE_STAMP" \
    "${AGENTD_SSH_HOST}:.config/systemd/user/${IDLE_STAMP_UNIT}"
  remote "systemctl --user daemon-reload && systemctl --user try-restart ${IDLE_STAMP_UNIT}"
  green "idle sensor unit synced"
fi

# Warn (don't fail) if the live unit no longer matches the reference — env
# drift won't show up in the file rsync but breaks behavior just as silently.
if [ -n "$(unit_drift)" ]; then
  red "WARNING: live systemd unit differs from ${REF_UNIT}"
  dim "  run: ops/agentd/deploy.sh --check   to see the diff, then reconcile by hand"
fi

if ! $DO_RESTART; then
  dim "--no-restart: leaving the service as-is"
  exit 0
fi

echo "Restarting agentd…"
remote 'systemctl --user restart agentd'

echo -n "Waiting for health on :${AGENTD_PORT} "
for _ in $(seq 1 15); do
  if remote "curl -fsS -o /dev/null http://localhost:${AGENTD_PORT}/health"; then
    echo; green "agentd healthy on :${AGENTD_PORT}"
    exit 0
  fi
  echo -n "."
  sleep 1
done
echo
red "agentd did NOT report healthy on :${AGENTD_PORT} after 15s"
dim "  check: ssh ${AGENTD_SSH_HOST} 'bash -lc \"journalctl --user -u agentd -n 50 --no-pager\"'"
exit 1
