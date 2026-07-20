#!/bin/bash
# Install (or reinstall) the ModelDeck LaunchAgent on this machine.
#
# Renders deploy/ai.hermes.modeldeck.plist.template into
# ~/Library/LaunchAgents/ai.hermes.modeldeck.plist and bootstraps it into the
# current GUI login session. Idempotent: an already-loaded agent is booted out
# first, then re-bootstrapped.
#
# Usage:
#   scripts/install-launch-agent.sh [--port N] [--projects-root DIR] [--dry-run]
#
# Defaults: port 3867 (the app default), projects root ~/projects.
set -euo pipefail

LABEL="ai.hermes.modeldeck"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$REPO_DIR/deploy/$LABEL.plist.template"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/ModelDeck"
DATA_DIR="$HOME/Library/Application Support/ModelDeck"
PORT=3867
PROJECTS_ROOT="$HOME/projects"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --projects-root) PROJECTS_ROOT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node not found on PATH; install Node >= 24 first" >&2
  exit 1
fi
PATH_LINE="$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin"

render() {
  sed \
    -e "s|{{NODE_BIN}}|$NODE_BIN|g" \
    -e "s|{{REPO_DIR}}|$REPO_DIR|g" \
    -e "s|{{HOME_DIR}}|$HOME|g" \
    -e "s|{{PORT}}|$PORT|g" \
    -e "s|{{PROJECTS_ROOT}}|$PROJECTS_ROOT|g" \
    -e "s|{{LOG_DIR}}|$LOG_DIR|g" \
    -e "s|{{PATH_LINE}}|$PATH_LINE|g" \
    "$TEMPLATE"
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  render
  exit 0
fi

mkdir -p "$LOG_DIR"
mkdir -p "$DATA_DIR" && chmod 700 "$DATA_DIR"
mkdir -p "$(dirname "$PLIST")"

render > "$PLIST"
chmod 644 "$PLIST"
plutil -lint "$PLIST" >/dev/null

GUI_TARGET="gui/$(id -u)"
# Idempotent reload: boot out a previously loaded copy, ignore "not loaded".
launchctl bootout "$GUI_TARGET/$LABEL" 2>/dev/null || true
launchctl bootstrap "$GUI_TARGET" "$PLIST"
launchctl kickstart "$GUI_TARGET/$LABEL" 2>/dev/null || true

echo "Installed $PLIST"
echo "Service: $GUI_TARGET/$LABEL on port $PORT"
echo "Logs:    $LOG_DIR"
echo "Check:   launchctl print $GUI_TARGET/$LABEL | head -20"
echo "Health:  curl -s http://127.0.0.1:$PORT/api/health"
