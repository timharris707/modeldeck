#!/bin/bash
# Store (or rotate) the ModelDeck mutation token in the macOS login Keychain.
#
# The server reads this at startup (service "modeldeck", account
# "mutation-token"). The token is never written to disk, logs, or stdout.
#
# Usage:
#   scripts/set-mutation-token.sh            # generate a random token and store it
#   scripts/set-mutation-token.sh --stdin    # read a token from stdin (no echo)
#   scripts/set-mutation-token.sh --show     # print the stored token (explicit opt-in)
#   scripts/set-mutation-token.sh --delete   # remove the Keychain entry
set -euo pipefail

SERVICE="modeldeck"
ACCOUNT="mutation-token"
MODE="${1:-generate}"

case "$MODE" in
  --show)
    /usr/bin/security find-generic-password -s "$SERVICE" -a "$ACCOUNT" -w
    ;;
  --delete)
    /usr/bin/security delete-generic-password -s "$SERVICE" -a "$ACCOUNT" >/dev/null
    echo "Deleted Keychain entry $SERVICE/$ACCOUNT"
    ;;
  --stdin)
    IFS= read -r TOKEN
    if [[ -z "$TOKEN" ]]; then echo "empty token" >&2; exit 1; fi
    /usr/bin/security add-generic-password -U -s "$SERVICE" -a "$ACCOUNT" -w "$TOKEN"
    echo "Stored provided token in Keychain entry $SERVICE/$ACCOUNT"
    ;;
  generate)
    TOKEN="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
    /usr/bin/security add-generic-password -U -s "$SERVICE" -a "$ACCOUNT" -w "$TOKEN"
    echo "Stored a new random token in Keychain entry $SERVICE/$ACCOUNT (not printed)"
    echo "Restart the service to pick it up: launchctl kickstart -k gui/\$(id -u)/ai.hermes.modeldeck"
    ;;
  *)
    echo "usage: $0 [--stdin|--show|--delete]" >&2
    exit 1
    ;;
esac
