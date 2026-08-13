#!/usr/bin/env bash
# avalanche-activity.sh — emits JSON describing whether the workstation is busy.
# Runs in under 1 second. Used by agentd for pre-flight and drain ticks.
#
# Output schema: see HANDOFF / prompt.md
# --human: prints a friendly summary instead of JSON.

set -u

HUMAN=0
if [[ "${1-}" == "--human" ]]; then
  HUMAN=1
fi

# ---------- helpers ----------
json_bool() { [[ "$1" == "1" || "$1" == "true" ]] && echo true || echo false; }
json_str_arr() {
  # space-separated -> json array
  local out="[" first=1
  for s in "$@"; do
    [[ -z "$s" ]] && continue
    if [[ $first -eq 1 ]]; then first=0; else out+=","; fi
    out+="\"${s//\"/\\\"}\""
  done
  out+="]"
  echo "$out"
}

# ---------- 1. idle seconds ----------
# Seconds since the human last touched keyboard or mouse — or EMPTY when this
# platform gives no way to know. Empty is a real answer, emitted as JSON null,
# and callers must treat it as "unknown": not as idle, not as active.
#
# WHAT DOES NOT WORK UNDER KWIN/WAYLAND, which is why this probe is tiered:
#   - org.freedesktop.ScreenSaver GetSessionIdleTime → NotSupported. KWin
#     exports the interface but implements this method only on X11.
#   - logind IdleHint → KDE never sets it; it reads "no" indefinitely.
#   - /dev/input/event* mtimes → THE KERNEL DOES NOT UPDATE THESE ON INPUT.
#     This was v1's primary Wayland path and it silently reported SECONDS
#     SINCE BOOT. Measured 2026-08-03: every event node on this box, including
#     PC Speaker and Power Button, shared one frozen mtime of boot+9s, and two
#     samples taken 6s apart while typing showed no movement. Because it
#     produced a confident number rather than failing, it also shadowed the
#     working fallback beneath it. Cost: a full day of the workstation
#     suspending under an active user. It is deliberately NOT kept as a
#     last-resort tier — a sensor that reports uptime as idleness is worse
#     than no sensor at all, because everything downstream believes it.
#
# What DOES work is ext-idle-notify-v1, implemented by KWin since 5.27.
# swayidle speaks it; ops/systemd/agentd-idle-stamp.service runs it and
# maintains the stamp read below.
IDLE_STAMP="${AGENTD_IDLE_STAMP_PATH:-/run/agentd-wake/idle-since}"
IDLE_STAMP_GRACE="${AGENTD_IDLE_STAMP_GRACE:-10}"

idle_seconds=""
idle_source="unavailable"

# Tier 1 — swayidle stamp (Wayland; the real sensor).
#
# Gated on the daemon actually running, and the liveness check comes FIRST for
# a reason: if swayidle dies mid-idle it leaves a stamp behind that would age
# into an ever-larger "idle" reading, and if it dies while active its absent
# stamp would read as "typing right now, forever". Neither is true. A dead
# sensor must report unknown, not a stale number in either direction.
if pgrep -x swayidle >/dev/null 2>&1; then
  if [[ -f "$IDLE_STAMP" ]]; then
    # Contents: the epoch second at which idleness crossed the grace threshold,
    # so last input was (contents - grace).
    stamp=$(cat "$IDLE_STAMP" 2>/dev/null || echo "")
    if [[ "$stamp" =~ ^[0-9]+$ ]]; then
      idle_seconds=$(( $(date +%s) - stamp + IDLE_STAMP_GRACE ))
      [[ $idle_seconds -lt 0 ]] && idle_seconds=0
      idle_source="swayidle"
    fi
  else
    # No stamp while the daemon is alive ⇒ input within the last grace window.
    idle_seconds=0
    idle_source="swayidle"
  fi
fi

# Tier 2 — ScreenSaver D-Bus. Correct on X11; returns NotSupported on Wayland,
# leaving idle_seconds empty so we fall through rather than inventing a value.
if [[ -z "$idle_seconds" ]] && command -v qdbus6 >/dev/null 2>&1; then
  ms=$(qdbus6 org.freedesktop.ScreenSaver /ScreenSaver GetSessionIdleTime 2>/dev/null || true)
  if [[ "$ms" =~ ^[0-9]+$ ]]; then
    idle_seconds=$((ms / 1000))
    idle_source="screensaver"
  fi
fi

# Tier 3 — unmeasurable. idle_seconds stays empty → reported as null.
#
# Unknown deliberately does NOT raise user_input_recent. What keeps the box
# awake under a human is wake-cycle provenance (agentd/src/wakeCycle.ts): a box
# agentd did not wake is never a box agentd suspends, whatever the idle reading
# says. Treating unknown as "present" here would instead pin the box awake after
# every legitimate remote wake, which is the failure this daemon exists to avoid.

user_input_recent=0
# Allow override (smoke tests, scripted runs)
IDLE_THRESHOLD="${AGENTD_IDLE_THRESHOLD_SECONDS:-600}"
if [[ -n "$idle_seconds" && "$idle_seconds" -lt "$IDLE_THRESHOLD" ]]; then
  user_input_recent=1
fi

# ---------- 2. external SSH ----------
mint_ips=$(getent ahosts the always-on host.local 2>/dev/null | awk '{print $1}' | sort -u)
mint_ips_re=""
for ip in $mint_ips; do
  esc=$(echo "$ip" | sed 's/\./\\./g')
  if [[ -n "$mint_ips_re" ]]; then mint_ips_re+="|"; fi
  mint_ips_re+="$esc"
done

ssh_external_count=0
ssh_lines=$(who 2>/dev/null | awk '$2 ~ /^pts/ {print $0}' || true)
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  host=$(echo "$line" | sed -n 's/.*(\([^)]*\)).*/\1/p')
  [[ -z "$host" ]] && continue
  # Local display sessions (konsole, plasma terminal) show host like ":0" or
  # "tmux(...)". Not external SSH.
  case "$host" in
    :*|tmux*|screen*) continue ;;
  esac
  # Loopback / localhost = not external
  case "$host" in
    localhost|127.0.0.1|::1) continue ;;
  esac
  # Resolve hostname to IP if needed
  if [[ ! "$host" =~ ^[0-9.]+$ ]] && [[ ! "$host" =~ ^[0-9a-fA-F:]+$ ]]; then
    resolved=$(getent ahosts "$host" 2>/dev/null | awk '{print $1; exit}')
    [[ -n "$resolved" ]] && host="$resolved"
  fi
  if [[ -n "$mint_ips_re" ]] && echo "$host" | grep -Eq "^($mint_ips_re)$"; then
    continue
  fi
  ssh_external_count=$((ssh_external_count + 1))
done <<< "$ssh_lines"

# ---------- 3. torrents ----------
torrent_procs=()
for p in qbittorrent qbittorrent-nox transmission-daemon deluged rtorrent; do
  if pgrep -x "$p" >/dev/null 2>&1; then torrent_procs+=("$p"); fi
done
# Active count via webui (best-effort)
active_torrents=0
if command -v curl >/dev/null 2>&1; then
  resp=$(curl -fsS --max-time 0.3 "http://127.0.0.1:8080/api/v2/torrents/info?filter=active" 2>/dev/null || true)
  if [[ -n "$resp" ]] && command -v jq >/dev/null 2>&1; then
    n=$(echo "$resp" | jq 'length' 2>/dev/null || echo 0)
    [[ "$n" =~ ^[0-9]+$ ]] && active_torrents=$n
  fi
fi

# ---------- 4. USB imaging ----------
usb_imaging=()
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  usb_imaging+=("$(echo "$line" | awk '{print $1}')")
done < <(pgrep -fa 'dd if=|balena|ddrescue|caligula|fedora-media-writer|popsicle' 2>/dev/null | grep -Ev 'pgrep|avalanche-activity|bash|zsh|sh ' || true)

# additional: dd writing to /dev/sd[b-z] or /dev/nvme[1-9]
if pgrep -fa 'dd .*of=/dev/(sd[b-z]|nvme[1-9])' 2>/dev/null | grep -qvE 'avalanche-activity|bash|zsh|sh ' ; then
  if pgrep -fa 'dd .*of=/dev/(sd[b-z]|nvme[1-9])' 2>/dev/null | grep -vE 'avalanche-activity|bash|zsh|sh ' | grep -q .; then
    usb_imaging+=("dd-block")
  fi
fi

# ---------- 5. Steam ----------
steam_running=0; pgrep -x steam >/dev/null 2>&1 && steam_running=1

steam_downloading=0
sd_dir="/home/jasper/.steam/steam/steamapps/downloading"
if [[ -d "$sd_dir" ]]; then
  # subdir mtime within last 60s
  if find "$sd_dir" -mindepth 1 -maxdepth 1 -mmin -1 2>/dev/null | grep -q .; then
    steam_downloading=1
  fi
fi

steam_game_running=0
# Cheap heuristic: walk /proc/[pid]/cwd symlinks for one containing steamapps/common.
# A real Steam game's cwd is always inside the game dir. Bound the walk so we
# don't slow the script on machines with thousands of procs.
count=0
for p in /proc/[0-9]*/cwd; do
  count=$((count+1))
  [[ $count -gt 500 ]] && break
  link=$(readlink "$p" 2>/dev/null) || continue
  if [[ "$link" == */steamapps/common/* ]]; then
    steam_game_running=1; break
  fi
done

steam_remote_play_active=0
if ss -ulnp 2>/dev/null | grep -E ':2703[1567]' >/dev/null; then
  steam_remote_play_active=1
fi

# ---------- 6. media ----------
media_playing=0
if command -v playerctl >/dev/null 2>&1; then
  while IFS= read -r status; do
    [[ "$status" == "Playing" ]] && media_playing=1 && break
  done < <(playerctl -a status 2>/dev/null || true)
fi

# ---------- 7. compilation ----------
compile_proc=0
for p in cargo rustc make ninja cc gcc clang tsc node; do
  if pgrep -x "$p" >/dev/null 2>&1; then compile_proc=1; break; fi
done
load_high=0
load1=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)
if awk -v l="$load1" 'BEGIN{exit !(l>2.0)}'; then load_high=1; fi
compilation_running=0
if [[ $compile_proc -eq 1 && $load_high -eq 1 ]]; then compilation_running=1; fi

# ---------- 8. package manager ----------
pkg_running=0
for p in pacman paru yay makepkg; do
  if pgrep -x "$p" >/dev/null 2>&1; then pkg_running=1; break; fi
done

# ---------- 9. agentd session active ----------
# When agentd itself invokes this script, hitting /status here creates a
# recursive call. The daemon sets AGENTD_INTERNAL_CHECK=1 in that case.
agentd_session_active=0
if [[ "${AGENTD_INTERNAL_CHECK:-0}" != "1" ]]; then
  agentd_resp=$(curl -fsS --max-time 0.2 "http://127.0.0.1:${AGENTD_PORT:-4446}/status" \
    -H "X-Agentd-Auth: $(cat /home/jasper/.config/agentd/token 2>/dev/null || true)" 2>/dev/null || true)
  if [[ -n "$agentd_resp" ]] && command -v jq >/dev/null 2>&1; then
    n=$(echo "$agentd_resp" | jq -r '.sessions_active // 0' 2>/dev/null || echo 0)
    [[ "$n" =~ ^[0-9]+$ ]] && [[ "$n" -gt 0 ]] && agentd_session_active=1
  fi
fi

# ---------- 10. network throughput (delta vs last invocation) ----------
# Cache prior sample to avoid a synchronous 1s sleep each call. For startup,
# the first call returns mbps=0; subsequent calls compute the delta vs the
# stored sample.
read_net_bytes() {
  awk 'NR>2 && $1 !~ /^lo:/ {gsub(":","",$1); rx+=$2; tx+=$10} END {print rx+tx+0}' /proc/net/dev
}

# Subtract the always-on host-bound SSH traffic from the throughput measurement. sshfs
# reads + SSH command execution from the the always-on host Claude session look like a
# generic download to /proc/net/dev, but they aren't "Jasper is doing
# something on the workstation" — they're cross-host work. Without this
# subtraction, every agent session is blocked by sustained_network_high
# whenever the always-on host has the sshfs mount active, which is most of the time
# during dev. Other blockers (Steam, torrents, USB imaging, video conf)
# still catch the things we actually care about.
read_mint_ssh_bytes() {
  [[ -z "$mint_ips_re" ]] && { echo 0; return; }
  # ss -tnHi columns (no -p): Recv-Q Send-Q Local-Addr Peer-Addr,
  # followed by a tab-indented info line. paste - - joins the two
  # halves into one line, after which the peer is field 4 (the info
  # line's first token "cubic" lands at field 5+).
  ss -tnHi state established sport = :22 2>/dev/null | \
    paste - - 2>/dev/null | \
    awk -v mips="$mint_ips_re" '
      {
        peer = $4; sub(/:[0-9]+$/, "", peer)
        if (peer !~ "^("mips")$") next
        for (i=1; i<=NF; i++) {
          if ($i ~ /^bytes_sent:/)     { split($i, a, ":"); s += a[2] }
          if ($i ~ /^bytes_received:/) { split($i, a, ":"); r += a[2] }
        }
      }
      END { print s+r+0 }
    '
}

NET_CACHE="/tmp/avalanche-activity-net.cache"
MINT_SSH_CACHE="/tmp/avalanche-activity-mint-ssh.cache"
now=$(date +%s)
cur_bytes=$(read_net_bytes)
cur_mint_ssh=$(read_mint_ssh_bytes)
prev_mint_ssh=$cur_mint_ssh
if [[ -f "$MINT_SSH_CACHE" ]]; then
  read -r prev_mint_ssh < "$MINT_SSH_CACHE" 2>/dev/null || true
fi
echo "$cur_mint_ssh" > "$MINT_SSH_CACHE"
mint_ssh_delta=$(( cur_mint_ssh - prev_mint_ssh ))
# Connections can rotate (new TCP session, ss only reports established);
# clamp negative deltas to 0 so churn doesn't underflow the global delta.
[[ $mint_ssh_delta -lt 0 ]] && mint_ssh_delta=0

prev_ts=0; prev_bytes=$cur_bytes
if [[ -f "$NET_CACHE" ]]; then
  read -r prev_ts prev_bytes < "$NET_CACHE" 2>/dev/null || true
fi
echo "$now $cur_bytes" > "$NET_CACHE"
span=$(( now - prev_ts ))
[[ $span -le 0 ]] && span=1
delta=$(( cur_bytes - prev_bytes - mint_ssh_delta ))
[[ $delta -lt 0 ]] && delta=0
# bytes/sec → Mb/s
mbps=$(awk -v d="$delta" -v s="$span" 'BEGIN{printf "%.2f", (d*8)/(s*1000000)}')

# Rolling-window throughput: we want "sustained avg > N MB/s over 30s."
#
# Previous shape stored raw deltas per sample and divided total bytes by
# (last_ts - first_ts). That broke any time the cadence was irregular:
#   - After agentd restart, the first sample's delta could cover minutes
#     of pre-restart traffic, but the in-window "span" was 0–2s, so the
#     ratio exploded into the MB/s range from sub-Mb/s real traffic.
#   - Single-sample windows divided by clamped span=1 → bytes-per-1s, also
#     wrong.
#
# New shape: each sample stores (ts, rate_bps, span_sec) where rate is the
# bytes-per-second computed across the actual prev→now interval. The
# sustained check time-weights samples and clips each one's contribution
# to the in-window slice — so an old big-span sample can't pretend its
# bytes all landed inside the rolling window. We also require ≥20s of
# evidence in the window before flagging, so a fresh-from-restart single
# sample can't trip the gate.
#
# Old THR_STATE file is left alone; we use a new path so format drift is
# self-healing.
inst_bps=$(( delta / span ))
THR_STATE="/tmp/avalanche-activity-thr.v2.state"
now=$(date +%s)
echo "$now $inst_bps $span" >> "$THR_STATE"
# trim to last 30s window
if [[ -f "$THR_STATE" ]]; then
  awk -v cutoff=$((now-30)) '$1>=cutoff' "$THR_STATE" > "${THR_STATE}.t" && mv "${THR_STATE}.t" "$THR_STATE"
fi

# Time-weighted bytes and effective coverage over the last 30s.
# Each sample (ts, rate, span) contributes rate*eff_span bytes where
# eff_span = min(span, ts - cutoff) — i.e. clipped to the in-window slice.
thr_total_bytes=0
thr_cover_sec=0
if [[ -f "$THR_STATE" ]]; then
  read -r thr_total_bytes thr_cover_sec < <(awk -v cutoff=$((now-30)) '
    {
      ts=$1; rate=$2; span=$3
      in_window = ts - cutoff
      if (in_window < 0) next
      eff = (span < in_window) ? span : in_window
      if (eff < 1) eff = 1
      total += rate * eff
      cover += eff
    }
    END { printf "%d %d\n", total+0, cover+0 }
  ' "$THR_STATE")
fi
[[ -z "$thr_total_bytes" ]] && thr_total_bytes=0
[[ -z "$thr_cover_sec" ]] && thr_cover_sec=0

sustained_high=0
# 2 MB/s = 2*1024*1024 bytes/s = 2097152. Require ≥20s of evidence.
if [[ "$thr_cover_sec" -ge 20 ]]; then
  avg_bps=$(( thr_total_bytes / thr_cover_sec ))
  if [[ $avg_bps -gt 2097152 ]]; then sustained_high=1; fi
fi

# Large file transfer = rsync/scp/sftp AND avg throughput > 1MB/s (1048576
# B/s) sustained over at least 10s. Reuses the v2 rolling window.
large_file_transfer=0
xfer_proc=0
for p in rsync scp sftp; do
  if pgrep -x "$p" >/dev/null 2>&1; then xfer_proc=1; break; fi
done
if [[ $xfer_proc -eq 1 && "$thr_cover_sec" -ge 10 ]]; then
  avg_bps=$(( thr_total_bytes / thr_cover_sec ))
  if [[ $avg_bps -gt 1048576 ]]; then large_file_transfer=1; fi
fi

# ---------- 11. video conference ----------
video_conf_active=0
if command -v pactl >/dev/null 2>&1; then
  # iterate source-outputs, find binary names that are video-conf clients
  src_out=$(pactl list source-outputs 2>/dev/null || true)
  if [[ -n "$src_out" ]]; then
    # walk paragraph blocks
    while IFS= read -r block; do
      [[ -z "$block" ]] && continue
      pid=$(echo "$block" | sed -n 's/.*application\.process\.id = "\([0-9]*\)".*/\1/p')
      bin=$(echo "$block" | sed -n 's/.*application\.process\.binary = "\([^"]*\)".*/\1/p')
      [[ -z "$bin" ]] && continue
      case "$bin" in
        zoom|teams|slack|Discord|discord|chromium)
          video_conf_active=1; break ;;
        firefox)
          # is this our nested-compositor firefox?
          if [[ -n "$pid" ]] && [[ -r "/proc/$pid/environ" ]]; then
            wd=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -E '^WAYLAND_DISPLAY=' | head -1 | cut -d= -f2 || true)
            if [[ -n "$wd" ]] && [[ "$wd" != agentd-* ]]; then
              video_conf_active=1; break
            elif [[ -z "$wd" ]]; then
              video_conf_active=1; break
            fi
          else
            video_conf_active=1; break
          fi
          ;;
      esac
    done < <(echo "$src_out" | awk 'BEGIN{RS="\n\n"} {print; print "---PARABREAK---"}' | sed 's/---PARABREAK---//')
  fi
fi

# ---------- aggregate ----------
blockers=()
[[ $user_input_recent -eq 1 ]] && blockers+=("user_input_recent")
[[ $ssh_external_count -gt 0 ]] && blockers+=("external_ssh")
[[ ${#torrent_procs[@]} -gt 0 || $active_torrents -gt 0 ]] && blockers+=("torrents_active")
[[ ${#usb_imaging[@]} -gt 0 ]] && blockers+=("usb_imaging")
[[ $steam_running -eq 1 ]] && blockers+=("steam_running")
[[ $steam_downloading -eq 1 ]] && blockers+=("steam_downloading")
[[ $steam_game_running -eq 1 ]] && blockers+=("steam_game_running")
[[ $steam_remote_play_active -eq 1 ]] && blockers+=("steam_remote_play_active")
[[ $media_playing -eq 1 ]] && blockers+=("media_playing")
[[ $compilation_running -eq 1 ]] && blockers+=("compilation_running")
[[ $large_file_transfer -eq 1 ]] && blockers+=("large_file_transfer")
[[ $pkg_running -eq 1 ]] && blockers+=("package_manager_running")
[[ $agentd_session_active -eq 1 ]] && blockers+=("agentd_session_active")
[[ $sustained_high -eq 1 ]] && blockers+=("sustained_network_high")
[[ $video_conf_active -eq 1 ]] && blockers+=("video_conf_active")

busy=0
[[ ${#blockers[@]} -gt 0 ]] && busy=1
user_present=0
[[ $user_input_recent -eq 1 ]] && user_present=1

if [[ $HUMAN -eq 1 ]]; then
  echo "the workstation activity:"
  echo "  busy: $([[ $busy -eq 1 ]] && echo yes || echo no)"
  echo "  user_present: $([[ $user_present -eq 1 ]] && echo yes || echo no)"
  echo "  idle_seconds: ${idle_seconds:-unknown} (source: $idle_source)"
  echo "  net_mbps_inst: $mbps"
  echo "  blockers: ${blockers[*]:-none}"
  exit 0
fi

# emit JSON
torrent_arr=$(json_str_arr "${torrent_procs[@]}")
usb_arr=$(json_str_arr "${usb_imaging[@]}")
blockers_arr=$(json_str_arr "${blockers[@]}")

cat <<EOF
{
  "busy": $(json_bool $busy),
  "user_present": $(json_bool $user_present),
  "blockers": $blockers_arr,
  "details": {
    "user_idle_seconds": ${idle_seconds:-null},
    "idle_source": "$idle_source",
    "ssh_sessions_external": $ssh_external_count,
    "torrent_processes": $torrent_arr,
    "torrents_active_count": $active_torrents,
    "usb_imaging": $usb_arr,
    "steam_running": $(json_bool $steam_running),
    "steam_downloading": $(json_bool $steam_downloading),
    "steam_game_running": $(json_bool $steam_game_running),
    "steam_remote_play_active": $(json_bool $steam_remote_play_active),
    "media_playing": $(json_bool $media_playing),
    "compilation_running": $(json_bool $compilation_running),
    "large_file_transfer": $(json_bool $large_file_transfer),
    "package_manager_running": $(json_bool $pkg_running),
    "agentd_session_active": $(json_bool $agentd_session_active),
    "network_throughput_mbps": $mbps,
    "sustained_network_high": $(json_bool $sustained_high),
    "video_conf_active": $(json_bool $video_conf_active)
  }
}
EOF
