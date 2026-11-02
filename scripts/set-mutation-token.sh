#!/bin/bash
# Store (or rotate) the ModelDeck mutation token in the macOS login Keychain,
# or, off macOS, in the owner-only file ~/.config/modeldeck/mutation-token
# (decision 0046).
#
# The server reads this at startup (service "modeldeck", account
# "mutation-token"). The token is never written to logs or stdout, and on
# macOS never to disk.
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

if [[ "$(uname -s)" != Darwin ]]; then
  # Fixed path, never XDG_CONFIG_HOME: the daemon reads the same one (src/paths.mjs).
  DIR="${MODELDECK_SECRETS_DIR:-$HOME/.config/modeldeck}"
  # The daemon resolves a relative override against its own folder, not ours.
  [[ "$DIR" == /* ]] || { echo "MODELDECK_SECRETS_DIR must be an absolute path; refusing" >&2; exit 1; }
  FILE="$DIR/$ACCOUNT"
  RESTART="systemctl --user restart modeldeck.service"
  store() {
    umask 077
    # Refuse what the daemon would refuse (decision 0046), rather than report
    # success for a token it will never read (Codex review of #812).
    [[ ! -L "$DIR" ]] || { echo "$DIR is a symlink; refusing" >&2; exit 1; }
    mkdir -p "$DIR"
    [[ -d "$DIR" && -O "$DIR" ]] || { echo "$DIR is not a directory owned by you; refusing" >&2; exit 1; }
    [[ ! -e "$FILE" && ! -L "$FILE" ]] || [[ -f "$FILE" && ! -L "$FILE" ]] \
      || { echo "$FILE is not a regular file; refusing" >&2; exit 1; }
    chmod 700 "$DIR"
    # The reader takes at most 4096 bytes, newline included; count bytes, not characters.
    local LC_ALL=C
    (( ${#1} < 4096 )) || { echo "token is longer than 4095 bytes; refusing" >&2; exit 1; }
    local temporary
    temporary="$(mktemp "$FILE.XXXXXX")"
    printf '%s\n' "$1" > "$temporary"
    mv -f "$temporary" "$FILE"
  }
  case "$MODE" in
    --show) cat "$FILE" ;;
    --delete) rm -f "$FILE"; echo "Deleted $FILE" ;;
    --stdin)
      # unset drops an inherited export, so the token never reaches a child.
      unset TOKEN
      IFS= read -r TOKEN
      if [[ -z "$TOKEN" ]]; then echo "empty token" >&2; exit 1; fi
      store "$TOKEN"
      echo "Stored provided token in $FILE"
      ;;
    generate)
      store "$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
      echo "Stored a new random token in $FILE (not printed)"
      echo "Restart every ModelDeck unit that reads it to pick it up, e.g. $RESTART"
      ;;
    *) echo "usage: $0 [--stdin|--show|--delete]" >&2; exit 1 ;;
  esac
  exit 0
fi

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
