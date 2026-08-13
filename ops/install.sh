#!/usr/bin/env bash
# ============================================================================
# Hearth Installer
# ============================================================================
# A personal chief-of-staff layer for your household. 12 specialists running
# over one local LLM, with an Obsidian-friendly markdown vault as the source
# of truth.
#
# Usage:
#   bash <(curl -fsSL https://raw.githubusercontent.com/alliphant/hearth/main/ops/install.sh)
#
# Or, if you already cloned:
#   cd ~/hearth && bash ops/install.sh
#
# Flags:
#   --quick             skip every optional prompt (defaults everywhere)
#   --reconfigure       re-run the wizard against an existing install
#   --uninstall         stop services, remove unit files (vault untouched)
#   --purge             --uninstall + drop vault + library + db (typed confirm)
#   --doctor            skip install; run preflight + smoke checks
#   --no-services       skip systemd / launchd unit setup
#   --no-containers     skip docker compose for SearXNG / Firecrawl / OSRM
#   --skip-smoke        don't run the smoke suite at the end
#   --branch <name>     install from a specific git branch (default: main)
#   --dir <path>        install directory (default: ~/hearth)
#   --vault <path>      vault directory (default: ~/vault-friday)
#   --non-interactive   same as --quick
#   --help, -h          this
#
# Modeled on the Hermes Agent installer idiom (script-per-phase, idempotent,
# main() at the bottom).
# ============================================================================

set -e

# Guard against env leakage when launched from a Python-driven tool session.
if [ -n "${PYTHONPATH:-}" ]; then
    echo "⚠ Unsetting inherited PYTHONPATH to avoid module shadowing"
    unset PYTHONPATH
fi

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

# ── Config defaults ─────────────────────────────────────────────────────────

REPO_URL_HTTPS="https://github.com/alliphant/hearth.git"
REPO_URL_SSH="git@github.com:alliphant/hearth.git"
HEARTH_DIR="${HEARTH_DIR:-$HOME/hearth}"
VAULT_DIR="${HEARTH_VAULT_ROOT:-$HOME/vault-friday}"
LIBRARY_DIR="${HEARTH_LIBRARY_ROOT:-$HOME/hearth-library}"
BRANCH="${HEARTH_BRANCH:-main}"

# Modes
MODE="install"          # install | reconfigure | uninstall | purge | doctor
QUICK=false
SKIP_SERVICES=false
SKIP_CONTAINERS=false
SKIP_SMOKE=false
EXPLICIT_DIR=false

# Detect non-interactive (curl|bash) early — TTY-less mode for read.
if [ -t 0 ]; then
    IS_INTERACTIVE=true
else
    IS_INTERACTIVE=false
fi

# ── Banner + log helpers ────────────────────────────────────────────────────

print_banner() {
    echo ""
    echo -e "${MAGENTA}${BOLD}"
    echo "  ┌──────────────────────────────────────────────────────────┐"
    echo "  │                                                          │"
    echo "  │     🔥  Hearth — let's get you set up                    │"
    echo "  │                                                          │"
    echo "  │     A small team of specialists for your household,      │"
    echo "  │     running locally, on hardware you own.                │"
    echo "  │                                                          │"
    echo "  └──────────────────────────────────────────────────────────┘"
    echo -e "${NC}"
    echo -e "${DIM}  This installer asks a handful of questions, then sets up the"
    echo "  staff and the vault. Most prompts have sensible defaults — press"
    echo "  Enter to accept any of them. You can always re-run with"
    echo -e "  --reconfigure to change your answers later.${NC}"
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

# ── TTY-safe prompts ────────────────────────────────────────────────────────
# Hermes-style: handle curl|bash by reading from /dev/tty when stdin isn't one.

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

_read_tty_secret() {
    local prompt="$1"
    local answer=""
    if [ "$IS_INTERACTIVE" = true ]; then
        read -rs -p "$prompt " answer || answer=""
        echo "" >&2
    elif [ -r /dev/tty ] && [ -w /dev/tty ]; then
        printf "%s " "$prompt" > /dev/tty
        # Disable echo on /dev/tty for the read.
        stty -echo < /dev/tty 2>/dev/null || true
        IFS= read -r answer < /dev/tty || answer=""
        stty echo < /dev/tty 2>/dev/null || true
        echo "" > /dev/tty
    fi
    echo "$answer"
}

prompt_yes_no() {
    local question="$1"
    local default="${2:-yes}"
    local suffix=""
    case "$default" in
        [yY]*|[tT]*|1) suffix="[Y/n]" ;;
        *) suffix="[y/N]" ;;
    esac
    if [ "$QUICK" = true ]; then
        case "$default" in [yY]*|[tT]*|1) return 0 ;; *) return 1 ;; esac
    fi
    local answer
    answer=$(_read_tty "$question $suffix")
    # Trim
    answer="${answer#"${answer%%[![:space:]]*}"}"
    answer="${answer%"${answer##*[![:space:]]}"}"
    if [ -z "$answer" ]; then
        case "$default" in [yY]*|[tT]*|1) return 0 ;; *) return 1 ;; esac
    fi
    case "$answer" in [yY]*) return 0 ;; *) return 1 ;; esac
}

prompt_text() {
    local question="$1"
    local default="$2"
    local with_default
    if [ -n "$default" ]; then
        with_default="$question [$default]:"
    else
        with_default="$question:"
    fi
    if [ "$QUICK" = true ]; then
        echo "$default"
        return
    fi
    local answer
    answer=$(_read_tty "$with_default")
    if [ -z "$answer" ]; then
        echo "$default"
    else
        echo "$answer"
    fi
}

# ── Arg parsing ─────────────────────────────────────────────────────────────

parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --quick|--non-interactive)  QUICK=true; shift ;;
            --reconfigure)              MODE="reconfigure"; shift ;;
            --uninstall)                MODE="uninstall"; shift ;;
            --purge)                    MODE="purge"; shift ;;
            --doctor)                   MODE="doctor"; shift ;;
            --no-services)              SKIP_SERVICES=true; shift ;;
            --no-containers)            SKIP_CONTAINERS=true; shift ;;
            --skip-smoke)               SKIP_SMOKE=true; shift ;;
            --branch)                   BRANCH="$2"; shift 2 ;;
            --dir)                      HEARTH_DIR="$2"; EXPLICIT_DIR=true; shift 2 ;;
            --vault)                    VAULT_DIR="$2"; shift 2 ;;
            --help|-h)
                sed -n '4,32p' "$0" | sed 's/^# //;s/^#//'
                exit 0 ;;
            *)
                log_warn "unknown flag: $1 (ignored)"
                shift ;;
        esac
    done
}

# ── Read existing config (for --reconfigure pre-fill) ──────────────────────
#
# Populates EXISTING_* shell variables from the running install's .env and
# config/users.yaml. The wizard's prompts read these via ${EXISTING_X:-default}
# so reconfigure-mode users just press Enter to keep what they already have.

_extract_env_var() {
    local var="$1"
    local env_file="$HEARTH_DIR/.env"
    [ -f "$env_file" ] || return 0
    grep -E "^${var}=" "$env_file" 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

load_existing_values() {
    local users_yaml="$HEARTH_DIR/config/users.yaml"

    # .env values — straight grep
    EXISTING_HA_URL=$(_extract_env_var HA_BASE_URL)
    EXISTING_HA_TOKEN=$(_extract_env_var HA_TOKEN)
    EXISTING_CALDAV_URL=$(_extract_env_var CALDAV_BASE_URL)
    EXISTING_CALDAV_USER=$(_extract_env_var CALDAV_USERNAME)
    EXISTING_CALDAV_PASS=$(_extract_env_var CALDAV_PASSWORD)
    EXISTING_TAUTULLI_URL=$(_extract_env_var TAUTULLI_URL)
    EXISTING_TAUTULLI_KEY=$(_extract_env_var TAUTULLI_API_KEY)
    EXISTING_TELEGRAM_TOKEN=$(_extract_env_var TELEGRAM_BOT_TOKEN)
    EXISTING_TELEGRAM_CHAT=$(_extract_env_var HERMES_USER_CHAT_ID)
    EXISTING_DISCORD_TOKEN=$(_extract_env_var DISCORD_BOT_TOKEN)
    EXISTING_OLLAMA_URL=$(_extract_env_var OLLAMA_BASE_URL)
    EXISTING_OPENAI_URL=$(_extract_env_var OPENAI_BASE_URL)
    EXISTING_OPENAI_KEY=$(_extract_env_var OPENAI_API_KEY)
    # Fall back to live /status — covers the case where these come from a
    # systemd Environment= line rather than .env. The orchestrator exposes
    # both URLs in its /status payload (the API key never leaves the process).
    if [ -z "$EXISTING_OPENAI_URL" ] || [ -z "$EXISTING_OLLAMA_URL" ]; then
        if command -v curl >/dev/null 2>&1; then
            local status_json
            status_json=$(curl -fsS -m 2 http://localhost:7700/status 2>/dev/null || true)
            if [ -n "$status_json" ]; then
                [ -z "$EXISTING_OPENAI_URL" ] && EXISTING_OPENAI_URL=$(echo "$status_json" | grep -oE '"openai_base_url":"[^"]*"' | cut -d'"' -f4)
                [ -z "$EXISTING_OLLAMA_URL" ] && EXISTING_OLLAMA_URL=$(echo "$status_json" | grep -oE '"ollama_url":"[^"]*"' | cut -d'"' -f4)
            fi
        fi
    fi
    EXISTING_VAULT_DIR=$(_extract_env_var HEARTH_VAULT_ROOT)
    EXISTING_LIBRARY_DIR=$(_extract_env_var HEARTH_LIBRARY_ROOT)

    # users.yaml values — bun does the YAML parsing
    if [ -f "$users_yaml" ] && command -v bun >/dev/null 2>&1; then
        # Use a heredoc-fed eval so quoting stays sane
        local yaml_extracted
        yaml_extracted=$(bun -e "$(cat <<'BUNJS'
import { parse } from "yaml";
import { readFileSync } from "node:fs";
function bashEsc(v) {
  return JSON.stringify(String(v ?? "")).replace(/\$/g, "\\$");
}
try {
  const d = parse(readFileSync(process.argv[1], "utf8"));
  const h = d.household ?? {};
  const u = d.users?.find((x) => x.role === "admin") ?? d.users?.[0] ?? {};
  const pets = (h.pets ?? [])
    .map((p) => `${p.name}:${p.species ?? "animal"}`)
    .join(", ");
  const veh = h.vehicles?.[0]
    ? `${h.vehicles[0].make ?? ""} ${h.vehicles[0].model ?? ""}`.trim()
    : "";
  const lines = [
    `EXISTING_USER_NAME=${bashEsc(u.display_name)}`,
    `EXISTING_USERNAME=${bashEsc(u.id)}`,
    `EXISTING_PIN_HASH=${bashEsc(u.pin_hash)}`,
    `EXISTING_TIMEZONE=${bashEsc(u.timezone)}`,
    `EXISTING_BRAND=${bashEsc(h.brand)}`,
    `EXISTING_PARTNER=${bashEsc(h.partner_name)}`,
    `EXISTING_CITY=${bashEsc(h.primary_city)}`,
    `EXISTING_REGION=${bashEsc(h.primary_region)}`,
    `EXISTING_ZONE=${bashEsc(h.usda_growing_zone)}`,
    `EXISTING_PETS=${bashEsc(pets)}`,
    `EXISTING_VEHICLE=${bashEsc(veh)}`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
} catch (e) {
  process.stderr.write("(prefill: yaml parse failed — " + e.message + ")\n");
}
BUNJS
)" "$users_yaml" 2>/dev/null) || true
        if [ -n "$yaml_extracted" ]; then
            eval "$yaml_extracted"
        fi
    fi
}

# ── OS detection ────────────────────────────────────────────────────────────

detect_os() {
    case "$(uname -s)" in
        Linux*)
            OS="linux"
            if [ -f /etc/os-release ]; then
                # shellcheck disable=SC1091
                . /etc/os-release
                DISTRO="$ID"
            else
                DISTRO="unknown"
            fi
            ;;
        Darwin*) OS="macos"; DISTRO="macos" ;;
        *) die "unsupported OS: $(uname -s) — Hearth supports Linux + macOS (Windows via WSL2)" ;;
    esac
    log_info "Detected ${BOLD}${OS}${NC} (${DISTRO})"
}

# ── Preflight ──────────────────────────────────────────────────────────────

preflight() {
    log_step "Looking around"

    # Disk
    local avail_kb
    avail_kb=$(df -kP "$HOME" | awk 'NR==2 {print $4}')
    local avail_gb=$((avail_kb / 1024 / 1024))
    if [ "$avail_gb" -lt 5 ]; then
        log_warn "only ${avail_gb} GB free in your home directory — Hearth itself is small (~2 GB), but your vault and library will grow over time"
    else
        log_success "${avail_gb} GB free in your home directory — plenty of room"
    fi

    # Network
    if curl -fsS -m 5 -o /dev/null https://github.com 2>/dev/null; then
        log_success "github.com is reachable"
    else
        log_warn "github.com isn't responding — the repo clone step may fail. Check your network?"
    fi

    # Sudo (advisory only — we'll prompt when needed)
    if command -v sudo >/dev/null 2>&1; then
        log_info "sudo is available (only used to install a few system packages)"
    else
        log_warn "no sudo here — you'll need to install a couple of system packages by hand. I'll tell you which when we get there."
    fi
}

# ── Bun ────────────────────────────────────────────────────────────────────

install_bun() {
    log_step "Bun (the runtime)"
    if command -v bun >/dev/null 2>&1; then
        log_success "Bun is already here: $(bun --version)"
        return 0
    fi
    log_info "Bun isn't installed yet — pulling it now via bun.sh's official installer..."
    curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || die "Bun install hit a snag. Try installing it yourself from https://bun.sh and re-run."
    # Source the shell rc that bun added so the rest of this script can find it
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    if command -v bun >/dev/null 2>&1; then
        log_success "Bun is ready: $(bun --version)"
    else
        die "Bun installed but isn't on PATH yet. Restart your shell and re-run this installer."
    fi
}

# ── System packages ────────────────────────────────────────────────────────

install_system_packages() {
    log_step "System packages"
    case "$DISTRO" in
        ubuntu|debian|mint|pop|linuxmint)
            local pkgs="build-essential python3 libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev curl git"
            log_info "Installing via apt: $pkgs"
            sudo apt-get update -qq && sudo apt-get install -y -qq $pkgs >/dev/null
            log_success "apt packages installed"
            ;;
        fedora|rhel|rocky|alma)
            local pkgs="gcc gcc-c++ python3 cairo-devel pango-devel libjpeg-turbo-devel giflib-devel librsvg2-devel curl git"
            log_info "Installing via dnf: $pkgs"
            sudo dnf install -y -q $pkgs >/dev/null
            log_success "dnf packages installed"
            ;;
        arch|cachyos|endeavouros|manjaro)
            local pkgs="base-devel python cairo pango libjpeg-turbo giflib librsvg curl git"
            log_info "Installing via pacman: $pkgs"
            sudo pacman -S --needed --noconfirm $pkgs >/dev/null
            log_success "pacman packages installed"
            ;;
        macos)
            if ! command -v brew >/dev/null 2>&1; then
                log_warn "Homebrew not detected — install from https://brew.sh and re-run"
                return 0
            fi
            local pkgs="cairo pango libjpeg giflib librsvg pkg-config"
            log_info "Installing via brew: $pkgs"
            brew install -q $pkgs >/dev/null 2>&1 || true
            log_success "brew packages installed"
            ;;
        *)
            log_warn "Unknown distro '$DISTRO' — install these by hand:"
            log_warn "  build tools (gcc/g++), python3, cairo, pango, libjpeg, giflib, librsvg"
            ;;
    esac
}

# ── Repo clone / update ────────────────────────────────────────────────────

clone_or_update_repo() {
    log_step "Repo"
    if [ -d "$HEARTH_DIR/.git" ]; then
        log_info "Existing repo at $HEARTH_DIR — fetching latest"
        ( cd "$HEARTH_DIR" && git fetch --quiet && git checkout --quiet "$BRANCH" && git pull --quiet ) || \
            die "git fetch/pull failed in $HEARTH_DIR"
        log_success "Repo up to date at $HEARTH_DIR ($BRANCH)"
    elif [ -d "$HEARTH_DIR" ] && [ -n "$(ls -A "$HEARTH_DIR" 2>/dev/null)" ]; then
        die "$HEARTH_DIR exists and is not empty (not a git repo). Choose another --dir or move it aside."
    else
        log_info "Cloning $REPO_URL_HTTPS → $HEARTH_DIR (branch: $BRANCH)"
        git clone --quiet --branch "$BRANCH" "$REPO_URL_HTTPS" "$HEARTH_DIR" || \
            die "git clone failed"
        log_success "Cloned to $HEARTH_DIR"
    fi
}

bun_install() {
    log_step "Dependencies"
    log_info "Running 'bun install' in $HEARTH_DIR..."
    ( cd "$HEARTH_DIR" && bun install --silent ) || die "bun install failed"
    log_success "Dependencies installed"
}

# ── Wizard ─────────────────────────────────────────────────────────────────
#
# Split into one sub-function per section so --reconfigure can run a subset.
# Every prompt uses ${EXISTING_X:-default} so reconfigure pre-fills from the
# current install — just Enter to keep what's already there.

wizard_identity() {
    echo -e "${BOLD}${CYAN}── Who am I talking to? ──${NC}"
    local default_name="${EXISTING_USER_NAME}"
    if [ -z "$default_name" ]; then
        default_name=$(getent passwd "$USER" 2>/dev/null | cut -d: -f5 | cut -d, -f1)
        default_name="${default_name:-$(whoami)}"
    fi
    echo -e "${DIM}  The staff will address you by this name in conversations and briefs.${NC}"
    HEARTH_USER_NAME=$(prompt_text "  Your name" "$default_name")
    echo ""

    echo -e "${DIM}  Your household has a brand — Hearth is the default, but plenty of"
    echo -e "  households give theirs a name (\"FRIDAY\", \"Watson\", a family name).${NC}"
    HEARTH_BRAND=$(prompt_text "  Household brand" "${EXISTING_BRAND:-Hearth}")
    echo ""

    echo -e "${BOLD}${CYAN}── Tell me a little about the household ──${NC}"
    echo -e "${DIM}  These bind into persona text at boot. Every one is optional — Enter"
    echo -e "  to skip and the personas fall back to generic placeholders.${NC}"
    HEARTH_PARTNER=$(prompt_text "  Partner's name (the \"you and ___\" person)" "${EXISTING_PARTNER}")
    HEARTH_CITY=$(prompt_text "  Your city (Eleanor and Maggie use this for local context)" "${EXISTING_CITY}")
    HEARTH_REGION=$(prompt_text "  Your region/state" "${EXISTING_REGION}")
    HEARTH_ZONE=$(prompt_text "  USDA growing zone, if you garden (e.g. 5b)" "${EXISTING_ZONE}")
    echo ""
    echo -e "${DIM}  Pets format: 'Name:species, Name:species'. Examples: 'Rex:dog'"
    echo -e "  or 'Bailey:dog, Mango:cat'. Dr. Anya will look after them.${NC}"
    HEARTH_PETS=$(prompt_text "  Pets in the household" "${EXISTING_PETS}")
    echo ""
    echo -e "${DIM}  Iris uses this for EV trip planning. Anything goes — gas or electric."
    echo -e "  e.g. 'Hyundai Ioniq 5' or 'Honda CR-V'.${NC}"
    HEARTH_VEHICLE=$(prompt_text "  Primary vehicle" "${EXISTING_VEHICLE}")
}

wizard_paths() {
    echo ""
    echo -e "${BOLD}${CYAN}── Where things live ──${NC}"
    echo -e "${DIM}  The vault is your personal markdown knowledge base — people, journals,"
    echo -e "  decisions, clippings. Obsidian-friendly. The library is for non-markdown"
    echo -e "  files (PDFs, datasets, downloads) that Cordelia fetches and files for you.${NC}"
    VAULT_DIR=$(prompt_text "  Vault directory" "${EXISTING_VAULT_DIR:-$VAULT_DIR}")
    LIBRARY_DIR=$(prompt_text "  Library directory" "${EXISTING_LIBRARY_DIR:-$LIBRARY_DIR}")
}

wizard_llm() {
    echo ""
    echo -e "${BOLD}${CYAN}── Where does your LLM live? ──${NC}"
    echo -e "${DIM}  Hearth runs all reasoning through one local-friendly LLM endpoint."
    echo -e "  You can swap models later by editing config/llm-roles.yaml.${NC}"
    # Show current state if reconfiguring
    if [ -n "${EXISTING_OPENAI_URL}" ]; then
        echo -e "${DIM}  Current: OPENAI_BASE_URL = ${EXISTING_OPENAI_URL}${NC}"
    elif [ -n "${EXISTING_OLLAMA_URL}" ]; then
        echo -e "${DIM}  Current: OLLAMA_BASE_URL = ${EXISTING_OLLAMA_URL}${NC}"
    fi
    echo ""
    echo "    1) Ollama on this machine        ${DIM}— simplest; good default${NC}"
    echo -e "    2) llama.cpp / Lemonade / LM Studio  ${DIM}— if you already serve OpenAI-compatible locally${NC}"
    echo -e "    3) Remote OpenAI-compatible      ${DIM}— OpenAI, Anthropic via proxy, etc.${NC}"
    echo -e "    4) Skip and wire up later        ${DIM}— installer continues; specialists won't answer until you set this${NC}"
    echo ""
    # Default choice: 2 if OPENAI_URL already set, 1 if OLLAMA_URL set, else 1
    local default_choice="1"
    [ -n "${EXISTING_OPENAI_URL}" ] && default_choice="2"
    local choice
    choice=$(prompt_text "  Choice" "$default_choice")
    case "$choice" in
        1) HEARTH_LLM_KIND="ollama"
           echo -e "${DIM}  If you haven't pulled a model yet: 'ollama pull qwen3:32b' (or whichever you prefer).${NC}"
           HEARTH_LLM_URL=$(prompt_text "  Ollama URL" "${EXISTING_OLLAMA_URL:-http://localhost:11434}")
           HEARTH_LLM_MODEL=$(prompt_text "  Model" "qwen3:32b") ;;
        2) HEARTH_LLM_KIND="llamacpp"
           HEARTH_LLM_URL=$(prompt_text "  Endpoint URL" "${EXISTING_OPENAI_URL:-http://localhost:8088/v1}")
           HEARTH_LLM_MODEL=$(prompt_text "  Model name (as your server reports it)" "qwen3-32b") ;;
        3) HEARTH_LLM_KIND="remote"
           HEARTH_LLM_URL=$(prompt_text "  Endpoint URL" "${EXISTING_OPENAI_URL:-https://api.openai.com/v1}")
           HEARTH_LLM_MODEL=$(prompt_text "  Model" "gpt-4o-mini")
           if [ -n "${EXISTING_OPENAI_KEY}" ]; then
               echo -e "${DIM}  Existing API key found in .env. Press Enter to keep it.${NC}"
           else
               echo -e "${DIM}  Your API key will be written to .env with mode 600 — readable only by you.${NC}"
           fi
           local new_key
           new_key=$(_read_tty_secret "  API key (hidden, Enter to keep existing):")
           HEARTH_LLM_KEY="${new_key:-$EXISTING_OPENAI_KEY}" ;;
        *) HEARTH_LLM_KIND="skip"
           log_info "  Okay — you can set OLLAMA_BASE_URL or OPENAI_BASE_URL in .env later." ;;
    esac
}

wizard_connectors() {
    echo ""
    echo -e "${BOLD}${CYAN}── Optional integrations ──${NC}"
    echo -e "${DIM}  Skip any of these — every connector cleanly degrades when its env"
    echo -e "  vars are unset, returning 'not configured' instead of erroring.${NC}"
    echo ""
    # Default to yes if already configured (so reconfigure keeps them)
    local ha_default="no"; [ -n "${EXISTING_HA_URL}" ] && ha_default="yes"
    if prompt_yes_no "  Connect Home Assistant?" "$ha_default"; then
        echo -e "${DIM}    Cassandra reads HA for presence + sensors; Iris reads it for the EV;"
        echo -e "    Kate uses it for location-aware briefs.${NC}"
        HEARTH_HA_URL=$(prompt_text "    HA URL" "${EXISTING_HA_URL:-http://homeassistant.local:8123}")
        if [ -n "${EXISTING_HA_TOKEN}" ]; then
            local new_tok
            new_tok=$(_read_tty_secret "    Token (hidden, Enter to keep existing):")
            HEARTH_HA_TOKEN="${new_tok:-$EXISTING_HA_TOKEN}"
        else
            HEARTH_HA_TOKEN=$(_read_tty_secret "    Long-lived access token (hidden):")
        fi
    fi
    local cd_default="no"; [ -n "${EXISTING_CALDAV_URL}" ] && cd_default="yes"
    if prompt_yes_no "  Connect CalDAV (Fastmail / Nextcloud / iCloud)?" "$cd_default"; then
        echo -e "${DIM}    Kate uses this for the morning brief; Iris uses it for trip planning.${NC}"
        HEARTH_CALDAV_URL=$(prompt_text "    CalDAV URL" "${EXISTING_CALDAV_URL}")
        HEARTH_CALDAV_USER=$(prompt_text "    Username" "${EXISTING_CALDAV_USER}")
        if [ -n "${EXISTING_CALDAV_PASS}" ]; then
            local new_pass
            new_pass=$(_read_tty_secret "    Password (hidden, Enter to keep existing):")
            HEARTH_CALDAV_PASS="${new_pass:-$EXISTING_CALDAV_PASS}"
        else
            HEARTH_CALDAV_PASS=$(_read_tty_secret "    Password (hidden):")
        fi
    fi
    local plex_default="no"; [ -n "${EXISTING_TAUTULLI_URL}" ] && plex_default="yes"
    if prompt_yes_no "  Connect Plex (via Tautulli)?" "$plex_default"; then
        echo -e "${DIM}    Maggie uses this for watch history + taste signal.${NC}"
        HEARTH_TAUTULLI_URL=$(prompt_text "    Tautulli URL" "${EXISTING_TAUTULLI_URL}")
        if [ -n "${EXISTING_TAUTULLI_KEY}" ]; then
            local new_key
            new_key=$(_read_tty_secret "    API key (hidden, Enter to keep existing):")
            HEARTH_TAUTULLI_KEY="${new_key:-$EXISTING_TAUTULLI_KEY}"
        else
            HEARTH_TAUTULLI_KEY=$(_read_tty_secret "    API key (hidden):")
        fi
    fi
}

wizard_containers() {
    echo ""
    echo -e "${BOLD}${CYAN}── Local services ──${NC}"
    if command -v docker >/dev/null 2>&1 && [ "$SKIP_CONTAINERS" = false ]; then
        echo -e "${DIM}  These run as docker containers alongside Hearth.${NC}"
        echo ""
        echo -e "${DIM}  SearXNG: private web metasearch — every specialist with web access uses it.${NC}"
        HEARTH_WANT_SEARXNG=$(prompt_yes_no "  Stand up SearXNG?" "yes" && echo "yes" || echo "no")
        echo -e "${DIM}  Firecrawl: turns any URL into clean markdown — the default web fetch.${NC}"
        HEARTH_WANT_FIRECRAWL=$(prompt_yes_no "  Stand up Firecrawl?" "yes" && echo "yes" || echo "no")
        echo -e "${DIM}  Maps (OSRM + Nominatim): offline routing + geocoding. First-build is slow"
        echo -e "  (~60-90 min for the OSM extract); skip unless you want spatial awareness.${NC}"
        HEARTH_WANT_MAPS=$(prompt_yes_no "  Stand up local maps?" "no" && echo "yes" || echo "no")
    else
        log_info "  No docker on this machine — skipping container offers."
        log_info "  Web fetch will work without them, just using public endpoints."
        HEARTH_WANT_SEARXNG="no"; HEARTH_WANT_FIRECRAWL="no"; HEARTH_WANT_MAPS="no"
    fi
}

wizard_messaging() {
    echo ""
    echo -e "${BOLD}${CYAN}── Messaging surfaces ──${NC}"
    echo -e "${DIM}  How would you like to reach the staff from your phone? You can"
    echo -e "  enable more than one — the same conversation continues across them.${NC}"
    echo ""
    local tg_default="no"; [ -n "${EXISTING_TELEGRAM_TOKEN}" ] && tg_default="yes"
    if prompt_yes_no "  Set up Telegram?" "$tg_default"; then
        echo -e "${DIM}    Message @BotFather on Telegram to create a bot and get a token."
        echo -e "    Your numeric user_id: message @userinfobot.${NC}"
        if [ -n "${EXISTING_TELEGRAM_TOKEN}" ]; then
            local new_tok
            new_tok=$(_read_tty_secret "    Bot token (hidden, Enter to keep existing):")
            HEARTH_TELEGRAM_TOKEN="${new_tok:-$EXISTING_TELEGRAM_TOKEN}"
        else
            HEARTH_TELEGRAM_TOKEN=$(_read_tty_secret "    Bot token (hidden):")
        fi
        HEARTH_TELEGRAM_CHAT=$(prompt_text "    Your Telegram numeric user_id" "${EXISTING_TELEGRAM_CHAT}")
    fi
    local dc_default="no"; [ -n "${EXISTING_DISCORD_TOKEN}" ] && dc_default="yes"
    if prompt_yes_no "  Set up Discord?" "$dc_default"; then
        echo -e "${DIM}    Create a bot at discord.com/developers/applications and copy its token.${NC}"
        if [ -n "${EXISTING_DISCORD_TOKEN}" ]; then
            local new_tok
            new_tok=$(_read_tty_secret "    Bot token (hidden, Enter to keep existing):")
            HEARTH_DISCORD_TOKEN="${new_tok:-$EXISTING_DISCORD_TOKEN}"
        else
            HEARTH_DISCORD_TOKEN=$(_read_tty_secret "    Bot token (hidden):")
        fi
    fi
}

wizard_first_user() {
    echo ""
    echo -e "${BOLD}${CYAN}── Your account ──${NC}"
    echo -e "${DIM}  You're the admin. More household members can be added later via the"
    echo -e "  /app interface. Your PIN logs you into the web app; the hash goes into"
    echo -e "  config/users.yaml (the PIN itself is never stored).${NC}"
    local default_username="${EXISTING_USERNAME:-$(echo "$HEARTH_USER_NAME" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_')}"
    HEARTH_USERNAME=$(prompt_text "  Username (lowercase, no spaces)" "$default_username")
    local pin1 pin2
    while true; do
        pin1=$(_read_tty_secret "  Choose a 4-digit PIN (hidden):")
        pin2=$(_read_tty_secret "  And once more to confirm:")
        if [ "$pin1" != "$pin2" ]; then
            log_warn "Those didn't match. Let's try again."
            continue
        fi
        if [ "${#pin1}" -ne 4 ] || ! [[ "$pin1" =~ ^[0-9]{4}$ ]]; then
            log_warn "A PIN should be exactly 4 digits. Try once more."
            continue
        fi
        break
    done
    HEARTH_PIN_HASH=$(printf "%s" "$pin1" | sha256sum | cut -c1-64)
    log_success "PIN captured (the hash, not the digits)"
}

wizard() {
    log_step "A few questions about your household"
    echo -e "${DIM}  Nothing here is final — every answer becomes an edit in"
    echo -e "  config/users.yaml that you can change later. Enter accepts defaults.${NC}"
    echo ""
    wizard_identity
    wizard_paths
    wizard_llm
    wizard_connectors
    wizard_containers
    wizard_messaging
    wizard_first_user
    echo ""
    log_info "Thanks — that's everything I needed. The rest is unattended."
}

# ── Vault scaffolding ──────────────────────────────────────────────────────

init_vault() {
    log_step "Vault"
    mkdir -p "$VAULT_DIR"/{People,Journal,Decisions,Calendar,Accounts,Projects,Drafts,Inbox,Places,Animals,_attachments}
    mkdir -p "$VAULT_DIR/System"/{Audit,Prompts,Policies,Tools}
    log_success "Vault skeleton at $VAULT_DIR"
    mkdir -p "$LIBRARY_DIR"
    log_success "Library at $LIBRARY_DIR"
    log_info "Running 'bun run init:vault' to scaffold Knowledge/<Specialist>/..."
    ( cd "$HEARTH_DIR" && HEARTH_VAULT_ROOT="$VAULT_DIR" bun run init:vault >/dev/null 2>&1 ) || \
        log_warn "bun run init:vault returned non-zero — vault scaffolding may be partial"
    log_success "Knowledge/ namespaces scaffolded"
}

# ── .env writer ────────────────────────────────────────────────────────────

write_env() {
    log_step "Environment file"
    local env_file="$HEARTH_DIR/.env"
    if [ -f "$env_file" ] && [ "$MODE" = "install" ]; then
        local backup="$env_file.bak.$(date +%Y%m%d-%H%M%S)"
        cp "$env_file" "$backup"
        log_info "Existing .env backed up to $backup"
    fi
    {
        echo "# Generated by ops/install.sh on $(date -Iseconds)"
        echo "HEARTH_VAULT_ROOT=$VAULT_DIR"
        echo "HEARTH_LIBRARY_ROOT=$LIBRARY_DIR"
        echo "HEARTH_PORT=7700"
        echo ""
        echo "# ── LLM endpoint ──────────────────────────────────────────────"
        case "$HEARTH_LLM_KIND" in
            ollama)
                echo "OLLAMA_BASE_URL=$HEARTH_LLM_URL" ;;
            llamacpp|remote)
                echo "OPENAI_BASE_URL=$HEARTH_LLM_URL"
                if [ -n "${HEARTH_LLM_KEY:-}" ]; then
                    echo "OPENAI_API_KEY=$HEARTH_LLM_KEY"
                fi
                ;;
            skip)
                echo "# OLLAMA_BASE_URL=http://localhost:11434"
                echo "# OPENAI_BASE_URL="
                echo "# OPENAI_API_KEY="
                ;;
        esac
        echo ""
        echo "# ── Optional connectors ───────────────────────────────────────"
        [ -n "${HEARTH_HA_URL:-}" ] && echo "HA_BASE_URL=$HEARTH_HA_URL" || echo "# HA_BASE_URL="
        [ -n "${HEARTH_HA_TOKEN:-}" ] && echo "HA_TOKEN=$HEARTH_HA_TOKEN" || echo "# HA_TOKEN="
        [ -n "${HEARTH_CALDAV_URL:-}" ] && echo "CALDAV_BASE_URL=$HEARTH_CALDAV_URL" || echo "# CALDAV_BASE_URL="
        [ -n "${HEARTH_CALDAV_USER:-}" ] && echo "CALDAV_USERNAME=$HEARTH_CALDAV_USER" || echo "# CALDAV_USERNAME="
        [ -n "${HEARTH_CALDAV_PASS:-}" ] && echo "CALDAV_PASSWORD=$HEARTH_CALDAV_PASS" || echo "# CALDAV_PASSWORD="
        echo ""
        echo "# ── Messaging surfaces ────────────────────────────────────────"
        [ -n "${HEARTH_TELEGRAM_TOKEN:-}" ] && echo "TELEGRAM_BOT_TOKEN=$HEARTH_TELEGRAM_TOKEN" || echo "# TELEGRAM_BOT_TOKEN="
        [ -n "${HEARTH_TELEGRAM_CHAT:-}" ] && echo "HERMES_USER_CHAT_ID=$HEARTH_TELEGRAM_CHAT" || echo "# HERMES_USER_CHAT_ID="
        [ -n "${HEARTH_DISCORD_TOKEN:-}" ] && echo "DISCORD_BOT_TOKEN=$HEARTH_DISCORD_TOKEN" || echo "# DISCORD_BOT_TOKEN="
    } > "$env_file"
    chmod 600 "$env_file"
    log_success ".env written ($(wc -l < "$env_file") lines, mode 600)"
}

# ── users.yaml writer ──────────────────────────────────────────────────────

write_users_yaml() {
    log_step "Users + household"
    local users_file="$HEARTH_DIR/config/users.yaml"
    if [ -f "$users_file" ] && [ "$MODE" = "install" ]; then
        cp "$users_file" "$users_file.bak.$(date +%Y%m%d-%H%M%S)"
    fi

    # Build pets YAML from comma-separated "name:species" list
    local pets_yaml=""
    if [ -n "$HEARTH_PETS" ]; then
        pets_yaml=$(echo "$HEARTH_PETS" | tr ',' '\n' | while IFS= read -r entry; do
            entry="$(echo "$entry" | sed 's/^ *//;s/ *$//')"
            [ -z "$entry" ] && continue
            local name="${entry%%:*}"
            local species="${entry#*:}"
            [ "$species" = "$entry" ] && species="animal"
            echo "    - name: \"$(echo "$name" | sed 's/^ *//;s/ *$//')\""
            echo "      species: \"$(echo "$species" | sed 's/^ *//;s/ *$//')\""
        done)
    fi

    # Build vehicles YAML
    local vehicles_yaml=""
    if [ -n "$HEARTH_VEHICLE" ]; then
        local make="${HEARTH_VEHICLE%% *}"
        local model="${HEARTH_VEHICLE#* }"
        [ "$model" = "$HEARTH_VEHICLE" ] && { make="$HEARTH_VEHICLE"; model=""; }
        vehicles_yaml="    - make: \"$make\""
        [ -n "$model" ] && vehicles_yaml="$vehicles_yaml"$'\n'"      model: \"$model\""
    fi

    {
        echo "# Generated by ops/install.sh on $(date -Iseconds)"
        echo "# Edit and restart hearth-orchestrator to re-bind persona tokens."
        echo ""
        echo "household:"
        echo "  brand: \"$HEARTH_BRAND\""
        [ -n "$HEARTH_PARTNER" ] && echo "  partner_name: \"$HEARTH_PARTNER\""
        [ -n "$HEARTH_CITY" ]    && echo "  primary_city: \"$HEARTH_CITY\""
        [ -n "$HEARTH_REGION" ]  && echo "  primary_region: \"$HEARTH_REGION\""
        [ -n "$HEARTH_ZONE" ]    && echo "  usda_growing_zone: \"$HEARTH_ZONE\""
        if [ -n "$pets_yaml" ]; then
            echo "  pets:"
            echo "$pets_yaml"
        else
            echo "  pets: []"
        fi
        if [ -n "$vehicles_yaml" ]; then
            echo "  vehicles:"
            echo "$vehicles_yaml"
        else
            echo "  vehicles: []"
        fi
        echo "  nearby_venues: []"
        echo "  nearby_cities: []"
        echo ""
        echo "users:"
        echo "  - id: \"$HEARTH_USERNAME\""
        echo "    display_name: \"$HEARTH_USER_NAME\""
        echo "    telegram_user_id: ${HEARTH_TELEGRAM_CHAT:+\"$HEARTH_TELEGRAM_CHAT\"}"
        [ -z "${HEARTH_TELEGRAM_CHAT:-}" ] && echo -n "" # no-op
        echo "    telegram_chat_id: null"
        echo "    app_token: null"
        echo "    allowed_specialists: \"*\""
        echo "    timezone: \"$(date +%Z)\""
        echo "    notification_config_ref: \"default_user\""
        echo "    pin_hash: \"$HEARTH_PIN_HASH\""
        echo "    theme: \"dark\""
        echo "    role: \"admin\""
    } > "$users_file"
    chmod 600 "$users_file"
    log_success "users.yaml written (admin user: $HEARTH_USERNAME)"
}

# ── Container stacks (optional) ────────────────────────────────────────────

install_containers() {
    [ "$SKIP_CONTAINERS" = true ] && return 0
    log_step "Local containers"
    local docker_cmd="docker"
    if ! command -v docker >/dev/null 2>&1; then
        if command -v podman >/dev/null 2>&1; then
            docker_cmd="podman"
        else
            log_warn "Docker not installed — skipping container stacks"
            return 0
        fi
    fi
    if [ "${HEARTH_WANT_MAPS:-no}" = "yes" ]; then
        log_info "Starting OSRM + Nominatim (this is the slow one — first build can take 60-90 min)"
        ( cd "$HEARTH_DIR/ops/maps" && bash setup.sh ) || log_warn "maps setup returned non-zero — see ops/maps/setup.sh"
    fi
    if [ "${HEARTH_WANT_SEARXNG:-no}" = "yes" ] && [ -f "$HEARTH_DIR/ops/searxng/docker-compose.yaml" ]; then
        ( cd "$HEARTH_DIR/ops/searxng" && $docker_cmd compose up -d ) || log_warn "SearXNG compose failed"
    fi
    if [ "${HEARTH_WANT_FIRECRAWL:-no}" = "yes" ] && [ -f "$HEARTH_DIR/ops/firecrawl/docker-compose.yaml" ]; then
        ( cd "$HEARTH_DIR/ops/firecrawl" && $docker_cmd compose up -d ) || log_warn "Firecrawl compose failed"
    fi
}

# ── Services (systemd user / launchd) ──────────────────────────────────────

install_services() {
    [ "$SKIP_SERVICES" = true ] && return 0
    log_step "Services"
    if [ "$OS" = "linux" ]; then
        install_systemd_units
    elif [ "$OS" = "macos" ]; then
        install_launchd_plists
    fi
}

install_systemd_units() {
    local unit_dir="$HOME/.config/systemd/user"
    mkdir -p "$unit_dir"
    local templates="$HEARTH_DIR/ops/systemd"
    if [ ! -d "$templates" ]; then
        log_warn "$templates not found — skipping systemd unit install"
        return 0
    fi
    for unit in hearth-orchestrator hearth-ingestor hearth-scheduler; do
        local src="$templates/$unit.service"
        local dst="$unit_dir/$unit.service"
        if [ ! -f "$src" ]; then
            log_warn "$src missing — skipping $unit"
            continue
        fi
        # Substitute install paths into the unit template.
        sed -e "s|/home/jasper/hearth|$HEARTH_DIR|g" \
            -e "s|/home/jasper/vault-friday|$VAULT_DIR|g" \
            "$src" > "$dst"
        log_success "$unit.service installed"
    done
    systemctl --user daemon-reload
    # Enable lingering so services survive logout
    if [ "$(id -u)" -ne 0 ]; then
        sudo loginctl enable-linger "$USER" 2>/dev/null && \
            log_success "user-lingering enabled (services persist across logout)" || \
            log_warn "couldn't enable lingering — services will stop at logout"
    fi
    systemctl --user enable --now hearth-orchestrator hearth-ingestor hearth-scheduler 2>/dev/null && \
        log_success "services enabled + started" || \
        log_warn "systemctl enable/start returned non-zero — check 'systemctl --user status hearth-orchestrator'"
}

install_launchd_plists() {
    log_warn "launchd plist generation not yet wired — see ops/launchd/ (TODO)"
    log_info "For now: bun run dev in $HEARTH_DIR works as a foreground server"
}

# ── Healthcheck + smoke ────────────────────────────────────────────────────

healthcheck() {
    [ "$SKIP_SERVICES" = true ] && return 0
    log_step "Healthcheck"
    local tries=0
    until curl -fsS -o /dev/null http://localhost:7700/status 2>/dev/null; do
        tries=$((tries+1))
        if [ $tries -ge 30 ]; then
            log_warn "orchestrator did not come up on :7700 after 30s"
            log_info "Check: journalctl --user -u hearth-orchestrator -n 50"
            return 0
        fi
        sleep 1
    done
    log_success "orchestrator answering on :7700 (${tries}s)"
}

run_smokes() {
    [ "$SKIP_SMOKE" = true ] && return 0
    [ "$SKIP_SERVICES" = true ] && return 0
    log_step "Smoke tests"
    log_info "Running 'bun run smoke' (vault write end-to-end)..."
    ( cd "$HEARTH_DIR" && bun run smoke >/dev/null 2>&1 ) && \
        log_success "smoke passed" || \
        log_warn "smoke failed — investigate before relying on the install"
}

# ── Final summary ──────────────────────────────────────────────────────────

print_success() {
    echo ""
    echo -e "${GREEN}${BOLD}"
    echo "  ┌──────────────────────────────────────────────────────────┐"
    echo "  │                                                          │"
    echo "  │     ✓  All set. Hearth is up and ready to meet you.      │"
    echo "  │                                                          │"
    echo "  └──────────────────────────────────────────────────────────┘"
    echo -e "${NC}"
    echo ""
    echo -e "  ${BOLD}Hello, $HEARTH_USER_NAME.${NC} The staff is awake. Here's where to find"
    echo -e "  everything if you ever need it:"
    echo ""
    echo -e "${CYAN}${BOLD}  📁 Files${NC}"
    echo "     Code:      $HEARTH_DIR"
    echo "     Vault:     $VAULT_DIR"
    echo "     Library:   $LIBRARY_DIR"
    echo "     Settings:  $HEARTH_DIR/.env"
    echo "     Household: $HEARTH_DIR/config/users.yaml"
    echo "     Database:  $HEARTH_DIR/data/hearth.db"
    echo ""
    echo -e "${CYAN}${BOLD}  🌐 Open these in a browser${NC}"
    echo "     http://localhost:7700/app/                  ${DIM}← chat with Kate + the staff${NC}"
    echo "     http://localhost:7700/app/showcase.html     ${DIM}← a tour of the architecture${NC}"
    echo "     http://localhost:7700/inbox                 ${DIM}← drag files in for ingestion${NC}"
    echo "     http://localhost:7700/files                 ${DIM}← browse the library${NC}"
    echo ""
    echo -e "${CYAN}${BOLD}  🔧 Useful commands${NC}"
    echo "     cd $HEARTH_DIR && bun run smoke               ${DIM}# verify the install${NC}"
    echo "     cd $HEARTH_DIR && bun run init:vault          ${DIM}# rescaffold Knowledge/${NC}"
    if [ "$OS" = "linux" ] && [ "$SKIP_SERVICES" = false ]; then
        echo "     systemctl --user status hearth-orchestrator   ${DIM}# service status${NC}"
        echo "     journalctl --user -u hearth-orchestrator -f   ${DIM}# tail the logs${NC}"
    fi
    echo "     bash $HEARTH_DIR/ops/install.sh --reconfigure ${DIM}# re-run the wizard${NC}"
    echo "     bash $HEARTH_DIR/ops/install.sh --doctor      ${DIM}# health diagnostics${NC}"
    echo ""
    echo -e "${CYAN}${BOLD}  📚 Where to start${NC}"
    echo "     1. Open http://localhost:7700/app/ and log in as ${BOLD}$HEARTH_USERNAME${NC} with your PIN."
    echo "     2. Say hello to Kate — she's the chief of staff and the default landing."
    echo "     3. Drop a PDF onto any specialist's library panel; you'll see it indexed in seconds."
    echo "     4. When you want the design rationale: $HEARTH_DIR/architecture.md"
    echo ""
    if [ "$HEARTH_LLM_KIND" = "skip" ]; then
        echo -e "${YELLOW}  ⚠ Heads up — you skipped the LLM endpoint setup. Specialists won't"
        echo -e "    answer until you set OLLAMA_BASE_URL or OPENAI_BASE_URL in"
        echo -e "    $HEARTH_DIR/.env and restart the orchestrator.${NC}"
        echo ""
    fi
    echo -e "${DIM}  Everything Hearth ever does is in the audit log — both as queryable"
    echo -e "  SQLite rows and as plain-markdown files in your vault. If something"
    echo -e "  feels off, that's where to look:${NC}"
    echo -e "${DIM}    cat $VAULT_DIR/System/Audit/\$(date +%Y-%m-%d).md${NC}"
    echo ""
    echo -e "  ${DIM}— the staff is waiting.${NC}"
    echo ""
}

# ── Uninstall ──────────────────────────────────────────────────────────────

uninstall_mode() {
    log_step "Uninstalling"
    echo -e "${DIM}  This stops the services and removes the systemd units. Your vault,"
    echo -e "  library, database, and code stay exactly where they are — nothing"
    echo -e "  about your data is destroyed by --uninstall. If you really want a"
    echo -e "  clean slate including your data, --purge is the next step.${NC}"
    echo ""
    if ! prompt_yes_no "Go ahead?" "no"; then
        log_info "No problem — nothing changed."
        exit 0
    fi
    if [ "$OS" = "linux" ]; then
        systemctl --user disable --now hearth-orchestrator hearth-ingestor hearth-scheduler 2>/dev/null || true
        rm -f "$HOME/.config/systemd/user/hearth-orchestrator.service"
        rm -f "$HOME/.config/systemd/user/hearth-ingestor.service"
        rm -f "$HOME/.config/systemd/user/hearth-scheduler.service"
        systemctl --user daemon-reload 2>/dev/null || true
        log_success "Services stopped, unit files removed."
    fi
    echo ""
    log_info "Your data is still here, exactly as you left it:"
    log_info "  $VAULT_DIR"
    log_info "  $LIBRARY_DIR"
    log_info "  $HEARTH_DIR/data/"
    echo ""
    log_info "If you want the code gone too: rm -rf $HEARTH_DIR"
    log_info "If you want every trace gone including your data: --purge"
}

purge_mode() {
    log_step "Purge"
    echo -e "${RED}${BOLD}  This is the destructive one.${NC} It removes:"
    echo "    • all of $HEARTH_DIR (code + db + audit log)"
    echo "    • all of $VAULT_DIR (people, journals, decisions, clippings)"
    echo "    • all of $LIBRARY_DIR (PDFs, files Cordelia fetched for you)"
    echo ""
    echo -e "${RED}  Your backups, if any, are your responsibility.${NC}"
    echo -e "${DIM}  (If you have any second thoughts, --uninstall is non-destructive"
    echo -e "  and leaves your data untouched.)${NC}"
    echo ""
    local confirm
    confirm=$(prompt_text "Type 'DELETE EVERYTHING' exactly, in capitals, to confirm" "")
    if [ "$confirm" != "DELETE EVERYTHING" ]; then
        log_info "Confirmation phrase didn't match. Nothing changed."
        exit 0
    fi
    # Stop services first
    if [ "$OS" = "linux" ]; then
        systemctl --user disable --now hearth-orchestrator hearth-ingestor hearth-scheduler 2>/dev/null || true
        rm -f "$HOME/.config/systemd/user/hearth-"*.service
        systemctl --user daemon-reload 2>/dev/null || true
    fi
    rm -rf "$HEARTH_DIR" "$VAULT_DIR" "$LIBRARY_DIR"
    log_success "All gone. Take care."
}

# ── Doctor ─────────────────────────────────────────────────────────────────

doctor_mode() {
    # Delegate to the richer bun-based doctor (scripts/doctor.ts) when
    # available. Falls back to a minimal shell-side check otherwise so
    # --doctor still works on a half-broken install where bun is missing.
    if command -v bun >/dev/null 2>&1 && [ -f "$HEARTH_DIR/scripts/doctor.ts" ]; then
        ( cd "$HEARTH_DIR" && bun run scripts/doctor.ts "$@" )
        return $?
    fi

    log_step "Doctor (minimal — bun or scripts/doctor.ts missing)"
    [ -d "$HEARTH_DIR" ] && log_success "code:    $HEARTH_DIR" || log_error "code MISSING: $HEARTH_DIR"
    [ -d "$VAULT_DIR" ]  && log_success "vault:   $VAULT_DIR"  || log_error "vault MISSING: $VAULT_DIR"
    [ -f "$HEARTH_DIR/.env" ] && log_success ".env present" || log_warn ".env missing — run --reconfigure"
    [ -f "$HEARTH_DIR/config/users.yaml" ] && log_success "users.yaml present" || log_warn "users.yaml missing — run --reconfigure"
    if curl -fsS -o /dev/null http://localhost:7700/status 2>/dev/null; then
        log_success "orchestrator answering on :7700"
    else
        log_error "orchestrator NOT answering on :7700"
        log_info "  Try: systemctl --user start hearth-orchestrator"
    fi
    if [ "$OS" = "linux" ]; then
        for unit in hearth-orchestrator hearth-ingestor hearth-scheduler; do
            local state
            state=$(systemctl --user is-active "$unit" 2>/dev/null || echo "inactive")
            [ "$state" = "active" ] && log_success "$unit: $state" || log_warn "$unit: $state"
        done
    fi
    log_info "For the full diagnostic: cd $HEARTH_DIR && bun install && bun run doctor"
}

# ── Reconfigure ────────────────────────────────────────────────────────────
#
# Reconfigure flow: skip everything install-side (Bun, system packages, repo
# clone, bun install — they're already done). Pre-fill all wizard prompts
# from the running install. Let the user pick WHICH sections to re-prompt;
# unselected sections preserve their existing values automatically.

# Sections the picker can target. Set to "yes" if the user selects them.
RECONFIG_IDENTITY="no"
RECONFIG_PATHS="no"
RECONFIG_LLM="no"
RECONFIG_CONNECTORS="no"
RECONFIG_CONTAINERS="no"
RECONFIG_MESSAGING="no"
RECONFIG_FIRST_USER="no"

# Seed HEARTH_* variables from EXISTING_* so write_env / write_users_yaml
# preserve any values the user didn't reconfigure. Wizard sections that
# ARE run will overwrite these.
preload_from_existing() {
    HEARTH_USER_NAME="${EXISTING_USER_NAME}"
    HEARTH_USERNAME="${EXISTING_USERNAME}"
    HEARTH_PIN_HASH="${EXISTING_PIN_HASH}"
    HEARTH_BRAND="${EXISTING_BRAND:-Hearth}"
    HEARTH_PARTNER="${EXISTING_PARTNER}"
    HEARTH_CITY="${EXISTING_CITY}"
    HEARTH_REGION="${EXISTING_REGION}"
    HEARTH_ZONE="${EXISTING_ZONE}"
    HEARTH_PETS="${EXISTING_PETS}"
    HEARTH_VEHICLE="${EXISTING_VEHICLE}"
    HEARTH_HA_URL="${EXISTING_HA_URL}"
    HEARTH_HA_TOKEN="${EXISTING_HA_TOKEN}"
    HEARTH_CALDAV_URL="${EXISTING_CALDAV_URL}"
    HEARTH_CALDAV_USER="${EXISTING_CALDAV_USER}"
    HEARTH_CALDAV_PASS="${EXISTING_CALDAV_PASS}"
    HEARTH_TAUTULLI_URL="${EXISTING_TAUTULLI_URL}"
    HEARTH_TAUTULLI_KEY="${EXISTING_TAUTULLI_KEY}"
    HEARTH_TELEGRAM_TOKEN="${EXISTING_TELEGRAM_TOKEN}"
    HEARTH_TELEGRAM_CHAT="${EXISTING_TELEGRAM_CHAT}"
    HEARTH_DISCORD_TOKEN="${EXISTING_DISCORD_TOKEN}"
    # Vault + library from existing if present
    [ -n "${EXISTING_VAULT_DIR}" ] && VAULT_DIR="${EXISTING_VAULT_DIR}"
    [ -n "${EXISTING_LIBRARY_DIR}" ] && LIBRARY_DIR="${EXISTING_LIBRARY_DIR}"
    # LLM: figure out which kind based on what's set
    if [ -n "${EXISTING_OPENAI_URL}" ]; then
        HEARTH_LLM_KIND="llamacpp"
        HEARTH_LLM_URL="${EXISTING_OPENAI_URL}"
        HEARTH_LLM_KEY="${EXISTING_OPENAI_KEY}"
    elif [ -n "${EXISTING_OLLAMA_URL}" ]; then
        HEARTH_LLM_KIND="ollama"
        HEARTH_LLM_URL="${EXISTING_OLLAMA_URL}"
    fi
    # Container choices: assume the user wants to keep whatever they had
    HEARTH_WANT_SEARXNG="no"
    HEARTH_WANT_FIRECRAWL="no"
    HEARTH_WANT_MAPS="no"
}

reconfigure_picker() {
    log_step "What would you like to change?"
    echo -e "${DIM}  Pick one or more sections (comma-separated numbers, or 'all').${NC}"
    echo -e "${DIM}  Sections you don't pick keep their existing values.${NC}"
    echo ""
    echo "    1) Identity & household       ${DIM}(name, partner, pets, city, vehicle, brand)${NC}"
    echo "    2) Paths                      ${DIM}(vault, library directories)${NC}"
    echo "    3) LLM endpoint               ${DIM}(Ollama / llama.cpp / remote)${NC}"
    echo "    4) Optional integrations      ${DIM}(HA, CalDAV, Plex)${NC}"
    echo "    5) Local containers           ${DIM}(SearXNG, Firecrawl, OSRM maps)${NC}"
    echo "    6) Messaging surfaces         ${DIM}(Telegram, Discord)${NC}"
    echo "    7) First-user account         ${DIM}(username, PIN)${NC}"
    echo -e "    ${BOLD}all)${NC} Everything                  ${DIM}(full wizard)${NC}"
    echo ""
    local choice
    choice=$(prompt_text "  Choice" "all")
    choice=$(echo "$choice" | tr '[:upper:]' '[:lower:]' | tr -d ' ')
    if [ "$choice" = "all" ] || [ -z "$choice" ]; then
        RECONFIG_IDENTITY="yes"
        RECONFIG_PATHS="yes"
        RECONFIG_LLM="yes"
        RECONFIG_CONNECTORS="yes"
        RECONFIG_CONTAINERS="yes"
        RECONFIG_MESSAGING="yes"
        RECONFIG_FIRST_USER="yes"
        return
    fi
    # Parse comma-separated digits
    IFS=',' read -ra picks <<< "$choice"
    for pick in "${picks[@]}"; do
        case "$pick" in
            1) RECONFIG_IDENTITY="yes" ;;
            2) RECONFIG_PATHS="yes" ;;
            3) RECONFIG_LLM="yes" ;;
            4) RECONFIG_CONNECTORS="yes" ;;
            5) RECONFIG_CONTAINERS="yes" ;;
            6) RECONFIG_MESSAGING="yes" ;;
            7) RECONFIG_FIRST_USER="yes" ;;
            *) log_warn "  ignoring unknown choice: '$pick'" ;;
        esac
    done
}

restart_orchestrator() {
    if [ "$OS" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
        if systemctl --user is-enabled hearth-orchestrator >/dev/null 2>&1; then
            log_info "Restarting hearth-orchestrator to pick up the new config..."
            systemctl --user restart hearth-orchestrator 2>&1 | tail -2 || \
                log_warn "restart returned non-zero — check 'systemctl --user status hearth-orchestrator'"
            # Give it a moment + healthcheck
            sleep 2
            if curl -fsS -o /dev/null http://localhost:7700/status 2>/dev/null; then
                log_success "orchestrator answering on :7700"
            else
                log_warn "orchestrator not answering yet — give it a few seconds, then 'systemctl --user status hearth-orchestrator'"
            fi
        else
            log_info "hearth-orchestrator not enabled as a service — restart by hand if it's running"
        fi
    fi
}

print_reconfigure_success() {
    echo ""
    echo -e "${GREEN}${BOLD}"
    echo "  ┌──────────────────────────────────────────────────────────┐"
    echo "  │                                                          │"
    echo "  │     ✓  Reconfigured. The staff is back at the door.      │"
    echo "  │                                                          │"
    echo "  └──────────────────────────────────────────────────────────┘"
    echo -e "${NC}"
    echo ""
    echo -e "  ${BOLD}Sections you touched:${NC}"
    [ "$RECONFIG_IDENTITY"   = "yes" ] && echo -e "    ${GREEN}✓${NC} identity / household"
    [ "$RECONFIG_PATHS"      = "yes" ] && echo -e "    ${GREEN}✓${NC} paths"
    [ "$RECONFIG_LLM"        = "yes" ] && echo -e "    ${GREEN}✓${NC} LLM endpoint"
    [ "$RECONFIG_CONNECTORS" = "yes" ] && echo -e "    ${GREEN}✓${NC} integrations"
    [ "$RECONFIG_CONTAINERS" = "yes" ] && echo -e "    ${GREEN}✓${NC} local containers"
    [ "$RECONFIG_MESSAGING"  = "yes" ] && echo -e "    ${GREEN}✓${NC} messaging surfaces"
    [ "$RECONFIG_FIRST_USER" = "yes" ] && echo -e "    ${GREEN}✓${NC} first-user account"
    echo ""
    echo -e "${DIM}  Anything you didn't pick kept its existing values. If something${NC}"
    echo -e "${DIM}  doesn't look right, run 'bash $0 --doctor' for a health check.${NC}"
    echo ""
}

reconfigure_mode() {
    detect_os
    if [ ! -f "$HEARTH_DIR/config/users.yaml" ] && [ ! -f "$HEARTH_DIR/.env" ]; then
        log_warn "No existing install detected at $HEARTH_DIR. Run without --reconfigure for a fresh install."
        exit 1
    fi
    log_step "Reading your current setup"
    load_existing_values
    preload_from_existing
    log_success "Loaded existing config from $HEARTH_DIR/config/users.yaml + .env"

    reconfigure_picker

    log_step "Updating only what you picked"
    [ "$RECONFIG_IDENTITY"   = "yes" ] && wizard_identity
    [ "$RECONFIG_PATHS"      = "yes" ] && wizard_paths
    [ "$RECONFIG_LLM"        = "yes" ] && wizard_llm
    [ "$RECONFIG_CONNECTORS" = "yes" ] && wizard_connectors
    [ "$RECONFIG_CONTAINERS" = "yes" ] && wizard_containers
    [ "$RECONFIG_MESSAGING"  = "yes" ] && wizard_messaging
    [ "$RECONFIG_FIRST_USER" = "yes" ] && wizard_first_user

    write_env
    write_users_yaml
    # Container changes need compose up; everything else is just a config rewrite
    [ "$RECONFIG_CONTAINERS" = "yes" ] && install_containers
    restart_orchestrator
    print_reconfigure_success
}

# ── Main ───────────────────────────────────────────────────────────────────

main() {
    parse_args "$@"
    print_banner

    case "$MODE" in
        uninstall)   detect_os; uninstall_mode; exit 0 ;;
        purge)       detect_os; purge_mode; exit 0 ;;
        doctor)      detect_os; doctor_mode; exit 0 ;;
        reconfigure) reconfigure_mode; exit 0 ;;
    esac

    detect_os
    preflight
    install_bun
    install_system_packages
    clone_or_update_repo
    bun_install
    wizard
    write_env
    write_users_yaml
    init_vault
    install_containers
    install_services
    healthcheck
    run_smokes
    print_success
}

main "$@"
