#!/usr/bin/env bash
set -euo pipefail

# Configure logrotate for mc-agents logs located at:
#   ~/mc-agents/logs

log() { echo "[mc-agents-logrotate] $*"; }
die() { echo "[mc-agents-logrotate] ERROR: $*" >&2; exit 1; }

if [[ $EUID -ne 0 ]]; then
  die "Run with sudo: sudo $0"
fi

# Detect the invoking (non-root) user
REAL_USER="${SUDO_USER:-$USER}"
USER_HOME="$(eval echo "~$REAL_USER")"

MC_AGENTS_DIR="$USER_HOME/mc-agents"
LOGS_DIR="$MC_AGENTS_DIR/logs"
CONF_DST="/etc/logrotate.d/mc-agents"

log "Detected user: $REAL_USER"
log "Resolved home directory: $USER_HOME"

if [[ ! -d "$LOGS_DIR" ]]; then
  die "Logs directory not found: $LOGS_DIR"
fi

log "Installing logrotate if needed..."
apt-get update -y
apt-get install -y logrotate

log "Writing logrotate configuration..."

cat > "$CONF_DST" <<EOF
# mc-agents log rotation
# Rotates llm_plans.jsonl and other JSONL/log files safely

$LOGS_DIR/llm_plans.jsonl
$LOGS_DIR/*.log
$LOGS_DIR/*.jsonl
{
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    dateext
    dateformat -%Y-%m-%d
    maxsize 200M
    su $REAL_USER $REAL_USER
    create 0644 $REAL_USER $REAL_USER
}
EOF

chmod 644 "$CONF_DST"

log "Testing configuration (dry run)..."
logrotate -d "$CONF_DST" >/dev/null

log "Forcing initial rotation test..."
logrotate -f "$CONF_DST" || true

log "✅ Logrotate successfully configured"
echo
echo "Logs will now:"
echo "  • rotate daily OR when exceeding 200MB"
echo "  • keep 14 rotations"
echo "  • compress old logs"
echo "  • continue without restarting bots"
