#!/usr/bin/env bash
set -euo pipefail

# Configure logrotate for mc-agents logs
# Repo location:
MC_AGENTS_DIR="/mc-agents"
LOGS_DIR="$MC_AGENTS_DIR/logs"

CONF_DST="/etc/logrotate.d/mc-agents"

log() { echo "[mc-agents-logrotate] $*"; }
die() { echo "[mc-agents-logrotate] ERROR: $*" >&2; exit 1; }

if [[ $EUID -ne 0 ]]; then
  die "Run with sudo: sudo $0"
fi

if [[ ! -d "$LOGS_DIR" ]]; then
  die "Logs directory not found: $LOGS_DIR"
fi

log "Installing logrotate (if needed)..."
apt-get update -y
apt-get install -y logrotate

log "Writing logrotate configuration..."

cat > "$CONF_DST" <<EOF
# mc-agents log rotation
# Handles llm_plans.jsonl and other log/jsonl files safely

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
    create 0644 root root
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
echo "  • rotate daily OR at 200MB"
echo "  • keep 14 days"
echo "  • compress automatically"
echo "  • NOT restart running bots"
