#!/bin/bash
# Uninstall the ModelDeck LaunchAgent from this machine.
#
# Boots the agent out of the GUI login session and removes the plist.
# Idempotent: safe to run when the agent is not loaded or not installed.
# Never touches the database, logs, or Keychain entries.
#
# Usage: scripts/uninstall-launch-agent.sh
set -euo pipefail

LABEL="ai.hermes.modeldeck"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
GUI_TARGET="gui/$(id -u)"

launchctl bootout "$GUI_TARGET/$LABEL" 2>/dev/null && echo "Booted out $GUI_TARGET/$LABEL" || echo "$LABEL was not loaded"

if [[ -f "$PLIST" ]]; then
  rm "$PLIST"
  echo "Removed $PLIST"
else
  echo "No plist at $PLIST"
fi

echo "Database, logs, and Keychain token were left in place."
