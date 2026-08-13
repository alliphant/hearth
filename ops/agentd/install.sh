#!/usr/bin/env bash
# ============================================================================
# agentd Installer — the browser-host side of Hearth
# ============================================================================
# Sets up agentd on a workstation with a real GPU + Firefox + KWin Wayland.
# This is the companion to Hearth's main install.sh, which lives on the
# always-on host. The two pair via a shared auth token.
#
# Usage:
#   bash <(curl -fsSL https://raw.githubusercontent.com/alliphant/hearth/main/ops/agentd/install.sh)
#
# Or, if you cloned the Hearth repo here:
#   cd ~/hearth && bash ops/agentd/install.sh
#
# Flags:
#   --quick             defaults everywhere; non-interactive
#   --reconfigure       re-run setup against existing install
#   --uninstall         stop service + remove unit file (token + profiles preserved)
#   --purge             --uninstall + drop the agentd home + the token
#   --doctor            run health checks against an existing install
#   --no-services       skip systemd unit install (run agentd by hand)
#   --skip-wol          skip the Wake-on-LAN setup hint
#   --dir <path>        agentd install directory (default: ~/agentd)
#   --port <n>          port to bind (default: 4446)
#   --help, -h          this
#
# What you'll need before running:
#   - A box with a discrete GPU (Cloudflare/PerimeterX fingerprinting
#     looks at WebGL vendor strings; an integrated GPU may give you
#     llvmpipe, which is itself a bot signal)
#   - KDE Plasma 6 on Wayland (we spawn nested kwin_wayland sessions)
#   - 16+ GB RAM (Firefox profiles are hungry; multiple compound)
#   - Wired network preferred for WoL reliability
# ============================================================================

set -e

if [ -n "${PYTHONPATH:-}" ]; then unset PYTHONPATH; fi

# ── Colors ──────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

# ── Defaults ────────────────────────────────────────────────────────────────

REPO_URL_HTTPS="https://github.com/alliphant/hearth.git"
HEARTH_TMP_DIR="${HEARTH_TMP_DIR:-/tmp/hearth-install-$$}"
AGENTD_DIR="${AGENTD_DIR:-$HOME/agentd}"
AGENTD_PORT="${AGENTD_PORT:-4446}"
AGENTD_TOKEN_FILE="$HOME/.config/agentd/token"
AGENTD_CONFIG_DIR="$HOME/.config/agentd"
WAKE_MARKER_DIR="/run/agentd-wake"

MODE="install"
QUICK=false
SKIP_SERVICES=false
SKIP_WOL=false

if [ -t 0 ]; then IS_INTERACTIVE=true; else IS_INTERACTIVE=false; fi

# ── Banner + helpers ────────────────────────────────────────────────────────

print_banner() {
    echo ""
    echo -e "${MAGENTA}${BOLD}"
    echo "  ┌──────────────────────────────────────────────────────────┐"
    echo "  │                                                          │"
    echo "  │     🦊  agentd — the browser host for Hearth             │"
    echo "  │                                                          │"
    echo "  │     A small Bun service that drives a real warmed        │"
    echo "  │     Firefox session, for pages headless tools can't get  │"
    echo "  │     past. Pairs with Hearth on your always-on host.      │"
    echo "  │                                                          │"
    echo "  └──────────────────────────────────────────────────────────┘"
    echo -e "${NC}"
    echo -e "${DIM}  Run this on the workstation with the GPU. The OTHER installer"
    echo -e "  (ops/install.sh) runs on the always-on host. They pair via a"
    echo -e "  shared auth token, which this installer generates and prints"
    echo -e "  at the end.${NC}"
    echo ""
}

log_info()    { echo -e "${CYAN}→${NC} $1"; }
log_success() { echo -e "${GREEN}✓${NC} $1"; }
log_warn()    { echo -e "${YELLOW}⚠${NC} $1"; }
log_error()   { echo -e "${RED}✗${NC} $1"; }
log_step()    { echo ""; echo -e "${BOLD}${BLUE}━━ $1 ━━${NC}"; }

die() {
    log_error "$1"
    exit "${2:-1}"
}

_read_tty() {
    local prompt="$1"
    local answer=""
    if [ "$IS_INTERACTIVE" = true ]; then
        read -r -p "$prompt " answer || answer=""
    elif [ -r /dev/tty ] && [ -w /dev/tty ]; then
        printf "%s " "$prompt" > /dev/tty
        IFS= read -r answer < /dev/tty || answer=""
    fi
    echo "$answer"
}

prompt_yes_no() {
    local question="$1"
    local default="${2:-yes}"
    local suffix=""
    case "$default" in [yY]*|1) suffix="[Y/n]" ;; *) suffix="[y/N]" ;; esac
    if [ "$QUICK" = true ]; then
        case "$default" in [yY]*|1) return 0 ;; *) return 1 ;; esac
    fi
    local answer
    answer=$(_read_tty "$question $suffix")
    answer="${answer#"${answer%%[![:space:]]*}"}"
    answer="${answer%"${answer##*[![:space:]]}"}"
    if [ -z "$answer" ]; then
        case "$default" in [yY]*|1) return 0 ;; *) return 1 ;; esac
    fi
    case "$answer" in [yY]*) return 0 ;; *) return 1 ;; esac
}

prompt_text() {
    local question="$1"
    local default="$2"
    local with_default
    if [ -n "$default" ]; then with_default="$question [$default]:"; else with_default="$question:"; fi
    if [ "$QUICK" = true ]; then echo "$default"; return; fi
    local answer
    answer=$(_read_tty "$with_default")
    if [ -z "$answer" ]; then echo "$default"; else echo "$answer"; fi
}

# ── Arg parsing ─────────────────────────────────────────────────────────────

parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --quick|--non-interactive) QUICK=true; shift ;;
            --reconfigure)             MODE="reconfigure"; shift ;;
            --uninstall)               MODE="uninstall"; shift ;;
            --purge)                   MODE="purge"; shift ;;
            --doctor)                  MODE="doctor"; shift ;;
            --no-services)             SKIP_SERVICES=true; shift ;;
            --skip-wol)                SKIP_WOL=true; shift ;;
            --dir)                     AGENTD_DIR="$2"; shift 2 ;;
            --port)                    AGENTD_PORT="$2"; shift 2 ;;
            --help|-h)
                sed -n '4,33p' "$0" | sed 's/^# //;s/^#//'
                exit 0 ;;
            *) log_warn "unknown flag: $1 (ignored)"; shift ;;
        esac
    done
}

# ── OS detection ────────────────────────────────────────────────────────────

detect_os() {
    case "$(uname -s)" in
        Linux*)
            OS="linux"
            if [ -f /etc/os-release ]; then
                . /etc/os-release
                DISTRO="$ID"
            else
                DISTRO="unknown"
            fi
            ;;
        *) die "agentd only supports Linux on the browser host (needs kwin_wayland). The Hearth always-on host can be macOS or Windows." ;;
    esac
    log_info "Detected ${BOLD}${OS}${NC} (${DISTRO})"

    # Soft check for Wayland — agentd technically can run under X11 but
    # nested compositors are happier on Wayland.
    if [ "${XDG_SESSION_TYPE:-}" != "wayland" ]; then
        log_warn "session type is '${XDG_SESSION_TYPE:-unknown}' — agentd is designed for Wayland (Plasma 6). It may still work, but expect rough edges."
    fi
}

# ── Preflight ──────────────────────────────────────────────────────────────

preflight() {
    log_step "Looking around"

    local avail_kb
    avail_kb=$(df -kP "$HOME" | awk 'NR==2 {print $4}')
    local avail_gb=$((avail_kb / 1024 / 1024))
    if [ "$avail_gb" -lt 5 ]; then
        log_warn "only ${avail_gb} GB free — Firefox profiles want room to grow"
    else
        log_success "${avail_gb} GB free"
    fi

    # GPU sanity check
    if command -v lspci >/dev/null 2>&1; then
        if lspci | grep -qiE "nvidia|amd|radeon"; then
            log_success "discrete GPU detected — good (the fingerprint authenticity reason)"
        else
            log_warn "no discrete GPU detected. Sites that fingerprint WebGL vendor (Cloudflare, PerimeterX) may flag llvmpipe as a bot signal."
        fi
    fi

    if curl -fsS -m 5 -o /dev/null https://github.com 2>/dev/null; then
        log_success "github.com reachable"
    fi
}

# ── Bun ────────────────────────────────────────────────────────────────────

install_bun() {
    log_step "Bun runtime"
    if command -v bun >/dev/null 2>&1; then
        log_success "Bun is here: $(bun --version)"
        return 0
    fi
    log_info "Installing Bun via bun.sh's official installer..."
    curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || die "Bun install failed"
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    command -v bun >/dev/null 2>&1 && log_success "Bun installed: $(bun --version)" \
        || die "Bun isn't on PATH yet; restart your shell and re-run"
}

# ── System packages ────────────────────────────────────────────────────────

install_system_packages() {
    log_step "System packages"
    case "$DISTRO" in
        ubuntu|debian|mint|pop|linuxmint)
            local pkgs="firefox firefox-esr geckodriver kwin-wayland xprintidle wakeonlan curl jq"
            log_info "Installing via apt: $pkgs"
            sudo apt-get update -qq
            # firefox vs firefox-esr varies by distro; install whichever is available
            sudo apt-get install -y -qq firefox 2>/dev/null || sudo apt-get install -y -qq firefox-esr 2>/dev/null || true
            sudo apt-get install -y -qq geckodriver kwin-wayland xprintidle wakeonlan curl jq 2>/dev/null || \
                log_warn "some apt packages weren't available; install them by hand if smoke fails"
            ;;
        fedora|rhel|rocky|alma)
            local pkgs="firefox geckodriver kwin xprintidle ethtool curl jq"
            log_info "Installing via dnf: $pkgs"
            sudo dnf install -y -q $pkgs >/dev/null 2>&1 || log_warn "some dnf packages weren't available"
            ;;
        arch|cachyos|endeavouros|manjaro)
            local pkgs="firefox geckodriver kwin xprintidle wol curl jq"
            log_info "Installing via pacman: $pkgs"
            sudo pacman -S --needed --noconfirm $pkgs >/dev/null 2>&1 || log_warn "some pacman packages weren't available"
            ;;
        *)
            log_warn "Unknown distro '$DISTRO'. Install these by hand:"
            log_warn "  firefox, geckodriver, kwin_wayland, xprintidle, wakeonlan/ethtool, curl, jq"
            ;;
    esac
    # Verify the load-bearing ones
    command -v firefox >/dev/null 2>&1 && log_success "firefox: $(firefox --version 2>/dev/null | head -1)" \
        || log_warn "firefox not on PATH — agentd needs it"
    command -v geckodriver >/dev/null 2>&1 && log_success "geckodriver: $(geckodriver --version 2>/dev/null | head -1)" \
        || log_warn "geckodriver not on PATH — agentd needs it"
    command -v kwin_wayland >/dev/null 2>&1 && log_success "kwin_wayland present" \
        || log_warn "kwin_wayland not on PATH — agentd spawns nested KWin sessions"
}

# ── Source layout ──────────────────────────────────────────────────────────

install_source() {
    log_step "agentd source"
    if [ -d "$AGENTD_DIR" ] && [ -f "$AGENTD_DIR/src/main.ts" ]; then
        log_info "Existing agentd at $AGENTD_DIR — refreshing in place"
    else
        # If we were curl|bash'd we don't have a local repo. Clone Hearth into a
        # scratch dir, copy ops/agentd/source/ into $AGENTD_DIR, drop the scratch.
        local script_dir
        script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "")"
        local source_dir=""
        if [ -n "$script_dir" ] && [ -d "$script_dir/source" ]; then
            source_dir="$script_dir/source"
            log_info "Using local source at $source_dir"
        else
            log_info "Cloning Hearth to extract agentd source..."
            git clone --quiet --depth=1 "$REPO_URL_HTTPS" "$HEARTH_TMP_DIR" || die "git clone failed"
            source_dir="$HEARTH_TMP_DIR/ops/agentd/source"
        fi
        mkdir -p "$AGENTD_DIR"
        cp -r "$source_dir"/. "$AGENTD_DIR"/
        # Clean up tmp clone if we made one
        [ -d "$HEARTH_TMP_DIR" ] && rm -rf "$HEARTH_TMP_DIR"
        log_success "agentd source installed at $AGENTD_DIR"
    fi
    log_info "Running 'bun install' in $AGENTD_DIR..."
    ( cd "$AGENTD_DIR" && bun install --silent ) || die "bun install failed"
    log_success "Dependencies installed"
}

# ── Token + config ─────────────────────────────────────────────────────────

setup_config() {
    log_step "Auth token + config"
    mkdir -p "$AGENTD_CONFIG_DIR"
    chmod 700 "$AGENTD_CONFIG_DIR"
    if [ ! -f "$AGENTD_TOKEN_FILE" ] || [ "$MODE" = "reconfigure" ]; then
        if [ -f "$AGENTD_TOKEN_FILE" ] && [ "$MODE" = "reconfigure" ]; then
            local backup="$AGENTD_TOKEN_FILE.bak.$(date +%Y%m%d-%H%M%S)"
            cp "$AGENTD_TOKEN_FILE" "$backup"
            log_info "Backed up existing token to $backup"
        fi
        # Generate via /proc/sys/kernel/random/uuid (always present on Linux)
        local token
        if [ -r /proc/sys/kernel/random/uuid ]; then
            token=$(cat /proc/sys/kernel/random/uuid | tr -d '-')
        elif command -v uuidgen >/dev/null 2>&1; then
            token=$(uuidgen | tr -d '-')
        else
            token=$(head -c 32 /dev/urandom | xxd -p | tr -d '\n')
        fi
        echo "$token" > "$AGENTD_TOKEN_FILE"
        chmod 600 "$AGENTD_TOKEN_FILE"
        log_success "Auth token generated: $AGENTD_TOKEN_FILE"
        AGENTD_TOKEN="$token"
    else
        AGENTD_TOKEN=$(cat "$AGENTD_TOKEN_FILE")
        log_info "Reusing existing token from $AGENTD_TOKEN_FILE"
    fi

    # Drop a minimal activity.sh script. Tells agentd how long since last
    # human input — needed for the sleep-on-idle decision.
    local activity_script="$AGENTD_CONFIG_DIR/activity.sh"
    if [ ! -f "$activity_script" ]; then
        cat > "$activity_script" <<'ACTIVITY_EOF'
#!/usr/bin/env bash
# Print the number of seconds since the last keyboard/mouse activity.
# Used by agentd's drain logic to decide whether the box is genuinely idle.
#
# Two paths, in order of preference:
#   1. xprintidle (X11/XWayland: works under most KDE/Plasma sessions)
#   2. KDE Plasma DBus call (Wayland-native)
#
# Output: an integer (seconds). On failure: 0 (treat as "active", don't sleep).

if command -v xprintidle >/dev/null 2>&1; then
    # xprintidle prints ms; convert to seconds
    ms=$(xprintidle 2>/dev/null || echo 0)
    echo $((ms / 1000))
    exit 0
fi

# KDE Plasma fallback
if command -v qdbus6 >/dev/null 2>&1; then
    ms=$(qdbus6 org.freedesktop.ScreenSaver /ScreenSaver GetSessionIdleTime 2>/dev/null || echo 0)
    echo $((ms / 1000))
    exit 0
fi

if command -v qdbus >/dev/null 2>&1; then
    ms=$(qdbus org.freedesktop.ScreenSaver /ScreenSaver GetSessionIdleTime 2>/dev/null || echo 0)
    echo $((ms / 1000))
    exit 0
fi

# No way to detect idle — treat as active
echo 0
ACTIVITY_EOF
        chmod +x "$activity_script"
        log_success "Activity script written: $activity_script"
    fi

    # Profile root — Firefox needs SOMEWHERE to keep its per-agent profiles
    local profile_root="${AGENTD_FIREFOX_PROFILE_BASE:-$HOME/.mozilla/firefox}"
    mkdir -p "$profile_root"
    log_success "Firefox profile root: $profile_root"
}

# ── systemd unit ───────────────────────────────────────────────────────────

install_service() {
    [ "$SKIP_SERVICES" = true ] && return 0
    log_step "Service (systemd user unit)"
    local unit_dir="$HOME/.config/systemd/user"
    mkdir -p "$unit_dir"
    local unit_file="$unit_dir/agentd.service"
    cat > "$unit_file" <<UNIT_EOF
[Unit]
Description=Hearth agentd — LAN browser daemon
After=graphical-session.target

[Service]
Type=simple
ExecStart=$(command -v bun) run $AGENTD_DIR/src/main.ts
WorkingDirectory=$AGENTD_DIR
Restart=on-failure
RestartSec=3
Environment="AGENTD_PORT=$AGENTD_PORT"
Environment="AGENTD_BIND=0.0.0.0"
Environment="AGENTD_TOKEN_FILE=$AGENTD_TOKEN_FILE"
Environment="AGENTD_ACTIVITY_SCRIPT=$AGENTD_CONFIG_DIR/activity.sh"
PassEnvironment=AGENTD_DRAIN_SECONDS AGENTD_SUSPEND_CMD AGENTD_IDLE_THRESHOLD_SECONDS AGENTD_DEBUG AGENTD_FIREFOX_PROFILE_BASE

[Install]
WantedBy=default.target
UNIT_EOF
    log_success "Wrote $unit_file"
    systemctl --user daemon-reload
    if [ "$(id -u)" -ne 0 ]; then
        sudo loginctl enable-linger "$USER" 2>/dev/null \
            && log_success "Lingering enabled (agentd starts at boot without a login)" \
            || log_warn "Couldn't enable lingering — service stops at logout"
    fi
    systemctl --user enable --now agentd 2>&1 | tail -2
}

healthcheck() {
    [ "$SKIP_SERVICES" = true ] && return 0
    log_step "Healthcheck"
    local tries=0
    until curl -fsS -o /dev/null "http://localhost:$AGENTD_PORT/health" 2>/dev/null; do
        tries=$((tries+1))
        if [ $tries -ge 15 ]; then
            log_warn "agentd didn't come up on :$AGENTD_PORT after 15s"
            log_info "Check: journalctl --user -u agentd -n 30"
            return 0
        fi
        sleep 1
    done
    log_success "agentd answering on :$AGENTD_PORT (${tries}s)"
}

# ── Wake-on-LAN hint ───────────────────────────────────────────────────────

wol_hint() {
    [ "$SKIP_WOL" = true ] && return 0
    log_step "Wake-on-LAN"
    echo -e "${DIM}  agentd's sleep-when-idle behavior only matters if your Hearth"
    echo -e "  host can wake this box back up. That needs WoL enabled on this"
    echo -e "  machine's network interface. Most distros leave it off by default.${NC}"
    echo ""
    # Try to identify the primary wired interface
    local iface
    iface=$(ip -o link show | awk -F': ' '/state UP/ && /enp|eno|eth/ {print $2; exit}')
    if [ -n "$iface" ] && command -v ethtool >/dev/null 2>&1; then
        local wol_state
        wol_state=$(sudo ethtool "$iface" 2>/dev/null | awk '/Wake-on/ {print $2}')
        if [ "$wol_state" = "g" ]; then
            log_success "WoL already enabled on $iface (Wake-on: g)"
        elif [ -n "$wol_state" ]; then
            log_warn "WoL is OFF on $iface (current: $wol_state). To enable:"
            log_info "  sudo ethtool -s $iface wol g"
            log_info "  (and persist it via a NetworkManager / systemd-networkd profile so it sticks across reboots)"
        fi
    else
        log_info "Couldn't auto-detect a wired interface. If you want WoL:"
        log_info "  sudo ethtool -s <your-iface> wol g"
        log_info "  ip link show  # to find your interface name"
    fi
    echo ""
    log_info "On the Hearth host side, the magic-packet command will be:"
    local mac
    if [ -n "$iface" ]; then
        mac=$(cat /sys/class/net/"$iface"/address 2>/dev/null)
        if [ -n "$mac" ]; then
            log_info "  wakeonlan $mac        ${DIM}# this box's MAC address${NC}"
        fi
    fi
}

# ── Success summary ────────────────────────────────────────────────────────

print_success() {
    echo ""
    echo -e "${GREEN}${BOLD}"
    echo "  ┌──────────────────────────────────────────────────────────┐"
    echo "  │                                                          │"
    echo "  │     ✓  agentd is ready. Pair it with Hearth next.        │"
    echo "  │                                                          │"
    echo "  └──────────────────────────────────────────────────────────┘"
    echo -e "${NC}"
    echo ""
    echo -e "${CYAN}${BOLD}  🔑 Pairing — do this on your Hearth host${NC}"
    echo ""
    echo -e "  The auth token Hearth needs to talk to this box:"
    echo ""
    echo -e "    ${BOLD}${YELLOW}$AGENTD_TOKEN${NC}"
    echo ""
    echo -e "  Copy that to your Hearth host. Add it to ${BOLD}~/hearth/.env${NC} as:"
    echo ""
    echo -e "    ${DIM}AVALANCHE_URL=http://$(hostname -s 2>/dev/null || echo "your-workstation").local:$AGENTD_PORT${NC}"
    echo -e "    ${DIM}AVALANCHE_TOKEN=$AGENTD_TOKEN${NC}"
    echo ""
    echo -e "  Then restart Hearth's orchestrator there:"
    echo -e "    ${DIM}systemctl --user restart hearth-orchestrator${NC}"
    echo ""
    echo -e "${CYAN}${BOLD}  🦊 Profile warming — the manual part${NC}"
    echo ""
    echo -e "${DIM}  A pristine Firefox profile is itself a bot signal. Cloudflare"
    echo -e "  flags 'first-ever-visit' fingerprints regardless of how authentic"
    echo -e "  the browser is. The cure is human warmth: log in, browse like a"
    echo -e "  person, accumulate history.${NC}"
    echo ""
    echo -e "  For each agent that will use the browser (e.g. 'maggie'):"
    echo ""
    echo -e "    1. ${BOLD}Create the profile:${NC}"
    echo -e "       firefox -CreateProfile maggie"
    echo ""
    echo -e "    2. ${BOLD}Launch and use it for 2-3 weeks before letting agentd use it:${NC}"
    echo -e "       firefox -P maggie --no-remote"
    echo ""
    echo -e "       Log into the sites the agent will visit. Browse like a"
    echo -e "       human — scroll a few pages, watch a YouTube video, click"
    echo -e "       around. Install Bitwarden or uBlock Origin (real extensions"
    echo -e "       beat pristine profiles). Let cookies accumulate."
    echo ""
    echo -e "    3. ${BOLD}When it feels lived-in, point agentd at it.${NC}"
    echo -e "       (No config change — agentd just spawns the profile by name.)"
    echo ""
    echo -e "${CYAN}${BOLD}  🔧 Useful commands${NC}"
    echo ""
    echo -e "     systemctl --user status agentd                  ${DIM}# is it running?${NC}"
    echo -e "     journalctl --user -u agentd -f                  ${DIM}# tail logs${NC}"
    echo -e "     curl -s http://localhost:$AGENTD_PORT/health          ${DIM}# quick check${NC}"
    echo -e "     curl -s -H 'X-Agentd-Auth: <token>' \\"
    echo -e "          http://localhost:$AGENTD_PORT/status             ${DIM}# session state${NC}"
    echo -e "     bash $0 --reconfigure        ${DIM}# re-run setup${NC}"
    echo -e "     bash $0 --doctor             ${DIM}# health diagnostic${NC}"
    echo ""
    echo -e "${DIM}  agentd owns its own sleep policy. If this box was woken via WoL"
    echo -e "  by your Hearth host, it'll suspend again after sessions drain. If"
    echo -e "  you booted it manually, it stays up — agentd never sleeps a box"
    echo -e "  the user is using.${NC}"
    echo ""
}

# ── Uninstall / purge / doctor ─────────────────────────────────────────────

uninstall_mode() {
    log_step "Uninstalling"
    echo -e "${DIM}  Stops the service and removes the systemd unit. Your token and"
    echo -e "  warmed Firefox profiles stay where they are.${NC}"
    echo ""
    if ! prompt_yes_no "Go ahead?" "no"; then log_info "No problem — nothing changed."; exit 0; fi
    systemctl --user disable --now agentd 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/agentd.service"
    systemctl --user daemon-reload 2>/dev/null || true
    log_success "Service stopped + unit file removed."
    echo ""
    log_info "Token and config are still at $AGENTD_CONFIG_DIR"
    log_info "Source is still at $AGENTD_DIR"
    log_info "Firefox profiles at ~/.mozilla/firefox (untouched)"
}

purge_mode() {
    log_step "Purge"
    echo -e "${RED}${BOLD}  This removes:${NC}"
    echo "    • $AGENTD_DIR (source)"
    echo "    • $AGENTD_CONFIG_DIR (token + activity script)"
    echo "    • the systemd unit"
    echo ""
    echo -e "${DIM}  Firefox profiles at ~/.mozilla/firefox are NOT touched."
    echo -e "  (They might be useful for other things; delete by hand if you want.)${NC}"
    echo ""
    local confirm
    confirm=$(prompt_text "Type 'DELETE AGENTD' exactly to confirm" "")
    if [ "$confirm" != "DELETE AGENTD" ]; then
        log_info "Confirmation phrase didn't match. Nothing changed."
        exit 0
    fi
    systemctl --user disable --now agentd 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/agentd.service"
    systemctl --user daemon-reload 2>/dev/null || true
    rm -rf "$AGENTD_DIR" "$AGENTD_CONFIG_DIR"
    log_success "All gone."
}

doctor_mode() {
    log_step "Doctor"
    [ -d "$AGENTD_DIR" ] && log_success "source:  $AGENTD_DIR" || log_error "source MISSING: $AGENTD_DIR"
    [ -f "$AGENTD_TOKEN_FILE" ] && log_success "token:   present at $AGENTD_TOKEN_FILE" || log_error "token MISSING"
    [ -f "$AGENTD_CONFIG_DIR/activity.sh" ] && log_success "activity.sh: present" || log_warn "activity.sh missing"
    command -v firefox >/dev/null 2>&1 && log_success "firefox: present" || log_error "firefox MISSING"
    command -v geckodriver >/dev/null 2>&1 && log_success "geckodriver: present" || log_error "geckodriver MISSING"
    command -v kwin_wayland >/dev/null 2>&1 && log_success "kwin_wayland: present" || log_error "kwin_wayland MISSING"
    if curl -fsS -o /dev/null "http://localhost:$AGENTD_PORT/health" 2>/dev/null; then
        log_success "agentd answering on :$AGENTD_PORT"
    else
        log_warn "agentd NOT answering on :$AGENTD_PORT — try: systemctl --user start agentd"
    fi
    local state
    state=$(systemctl --user is-active agentd 2>/dev/null || echo "inactive")
    [ "$state" = "active" ] && log_success "agentd service: $state" || log_warn "agentd service: $state"
}

# ── Main ───────────────────────────────────────────────────────────────────

main() {
    parse_args "$@"
    print_banner

    case "$MODE" in
        uninstall) detect_os; uninstall_mode; exit 0 ;;
        purge)     detect_os; purge_mode; exit 0 ;;
        doctor)    detect_os; doctor_mode; exit 0 ;;
    esac

    detect_os
    preflight
    install_bun
    install_system_packages
    install_source
    setup_config
    install_service
    healthcheck
    wol_hint
    print_success
}

main "$@"
