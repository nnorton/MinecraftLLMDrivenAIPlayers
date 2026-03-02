#!/usr/bin/env bash
set -euo pipefail

# Bootstrap an Ubuntu/Debian server to run this repo (mc-agents).
# Installs: system deps, Node.js 20 LTS, PM2, and npm dependencies.
#
# Usage:
#   ./scripts/bootstrap_server.sh            # uses current directory as repo root
#   ./scripts/bootstrap_server.sh /path/to/repo
#
# After install, you can run:
#   pm2 start ecosystem.config.cjs
#   pm2 save
#   pm2 logs

REPO_DIR="${1:-$(pwd)}"

log()  { echo -e "\033[1;32m[bootstrap]\033[0m $*"; }
warn() { echo -e "\033[1;33m[bootstrap]\033[0m $*" >&2; }
die()  { echo -e "\033[1;31m[bootstrap]\033[0m $*" >&2; exit 1; }

if [[ ! -d "$REPO_DIR" ]]; then
  die "Repo directory not found: $REPO_DIR"
fi

if [[ ! -f "$REPO_DIR/package.json" ]]; then
  die "package.json not found in $REPO_DIR (pass the repo root as an argument)"
fi

# Detect OS (Ubuntu/Debian)
if [[ -r /etc/os-release ]]; then
  . /etc/os-release
else
  die "Cannot detect OS (/etc/os-release missing). This script supports Ubuntu/Debian."
fi

if [[ "${ID:-}" != "ubuntu" && "${ID:-}" != "debian" && "${ID_LIKE:-}" != *"debian"* ]]; then
  warn "Detected OS: ${PRETTY_NAME:-unknown}. This script is intended for Ubuntu/Debian."
fi

# Ensure we can sudo (or are root)
SUDO=""
if [[ "${EUID}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    die "Not running as root and sudo not found. Install sudo or run as root."
  fi
fi

log "Updating apt + installing base system dependencies..."
$SUDO apt-get update -y
$SUDO apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git \
  build-essential python3 make g++ \
  unzip jq

# Install Node.js 20 LTS (NodeSource)
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -v || true)"
  log "Node already installed: ${NODE_VER}"
else
  log "Installing Node.js 20 LTS from NodeSource..."
  # Create keyring dir if missing
  $SUDO mkdir -p /etc/apt/keyrings

  # Add NodeSource GPG key
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | $SUDO gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg

  # Add NodeSource apt repo
  ARCH="$(dpkg --print-architecture)"
  DISTRO_CODENAME="${VERSION_CODENAME:-}"
  if [[ -z "$DISTRO_CODENAME" ]]; then
    # Fallback for some Debian images
    DISTRO_CODENAME="$(lsb_release -cs 2>/dev/null || true)"
  fi
  [[ -n "$DISTRO_CODENAME" ]] || die "Could not determine distro codename (VERSION_CODENAME)."

  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg arch=${ARCH}] https://deb.nodesource.com/node_20.x ${DISTRO_CODENAME} main" \
    | $SUDO tee /etc/apt/sources.list.d/nodesource.list >/dev/null

  $SUDO apt-get update -y
  $SUDO apt-get install -y nodejs
fi

log "Node version: $(node -v)"
log "NPM version : $(npm -v)"

# Install PM2 globally
if command -v pm2 >/dev/null 2>&1; then
  log "PM2 already installed: $(pm2 -v || true)"
else
  log "Installing PM2 globally..."
  $SUDO npm install -g pm2
fi

# Optional: pm2-logrotate helps keep logs sane
if pm2 module:list 2>/dev/null | grep -q pm2-logrotate; then
  log "PM2 logrotate module already installed."
else
  log "Installing pm2-logrotate (optional but recommended)..."
  pm2 install pm2-logrotate >/dev/null || true
fi

# Install repo dependencies
log "Installing repo npm dependencies..."
cd "$REPO_DIR"

# Prefer npm ci when lockfile exists
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

# PM2 startup (so it restarts after reboot)
# This generates a command that must be run as root; we’ll execute it automatically via sudo if available.
log "Configuring PM2 to start on boot..."
if [[ -n "$SUDO" ]]; then
  STARTUP_CMD="$(pm2 startup systemd -u "$USER" --hp "$HOME" | tail -n 1 || true)"
  if [[ -n "$STARTUP_CMD" ]]; then
    # shellcheck disable=SC2086
    $SUDO bash -lc "$STARTUP_CMD" || true
  fi
else
  pm2 startup systemd -u "$USER" --hp "$HOME" || true
fi

log "Bootstrap complete."
echo
echo "Next steps:"
echo "1) Create / update your .env in the repo root (API keys, server host/port, etc.)."
echo "2) Start bots with PM2:"
echo "   cd \"$REPO_DIR\""
echo "   pm2 start ecosystem.config.cjs"
echo "   pm2 save"
echo
echo "Useful commands:"
echo "   pm2 status"
echo "   pm2 logs"
echo "   pm2 restart all"
