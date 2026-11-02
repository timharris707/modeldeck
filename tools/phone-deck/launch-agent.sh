#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd -P)"
LABEL=ai.modeldeck.phone-deck
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/modeldeck-phone-deck.log"
DOMAIN="gui/$(id -u)"
NODE=/opt/homebrew/bin/node

serve_hint() {
  local tailscale status
  tailscale="$(command -v tailscale || true)"
  if [[ -z "$tailscale" && -x /opt/homebrew/bin/tailscale ]]; then
    tailscale=/opt/homebrew/bin/tailscale
  fi
  if [[ -n "$tailscale" ]]; then
    if status="$("$tailscale" serve status --json 2>/dev/null)" &&
      printf '%s' "$status" | "$NODE" --input-type=module -e '
        let text = "";
        for await (const chunk of process.stdin) text += chunk;
        try {
          const rule = JSON.parse(text).TCP?.["3871"];
          process.exit(rule?.TCPForward === "127.0.0.1:3871" ? 0 : 1);
        } catch { process.exit(1); }
      '; then
      return
    fi
  fi
  printf '%s\n' 'No matching Tailscale serve entry could be confirmed. To expose it on the tailnet, run:'
  printf '%s\n' 'tailscale serve --bg --tcp=3871 tcp://127.0.0.1:3871'
}

case "${1:-}" in
  install)
    [[ -x "$NODE" ]] || { printf 'Node is missing: %s\n' "$NODE" >&2; exit 1; }
    [[ $# == 1 || ( $# == 2 && "$2" == --two-mac ) ]] || { printf 'Usage: %s install [--two-mac]\n' "$0" >&2; exit 2; }
    if [[ -f "$PLIST" ]]; then
      /usr/bin/plutil -lint "$PLIST" >/dev/null
      for key in SOURCES MACHINE_LABEL ALLOWED_NAMES DAEMON_PORT; do
        # An explicit mode reset discards the hub settings and a scratch daemon
        # port, but keeps host aliases; a port given now still applies.
        [[ "${2:-}" == --two-mac && ( "$key" == SOURCES || "$key" == MACHINE_LABEL || "$key" == DAEMON_PORT ) ]] && continue
        if [[ -z "${!key+x}" ]] && /usr/bin/plutil -type "EnvironmentVariables.$key" "$PLIST" >/dev/null 2>&1; then
          # The sentinel preserves trailing newlines so validation cannot lose them.
          value="$(/usr/bin/plutil -extract "EnvironmentVariables.$key" raw -expect string -n "$PLIST" && printf .)" || exit 1
          export "$key=${value%.}"
          printf 'Preserving %s from installed plist\n' "$key"
        fi
      done
    fi
    if [[ "${2:-}" == --two-mac ]]; then
      unset SOURCES MACHINE_LABEL
      printf '%s\n' 'Using two-Mac mode (--two-mac)'
    fi
    "$NODE" --input-type=module - "$DIR" <<'VALIDATE'
import { pathToFileURL } from 'node:url';
const { validateConfig } = await import(pathToFileURL(`${process.argv[2]}/config.mjs`));
try { validateConfig(process.env); }
catch (error) { console.error(error.message); process.exit(1); }
VALIDATE
    # Only a listener owned by this loaded agent may be replaced.
    agent_status="$(/bin/launchctl print "$DOMAIN/$LABEL" 2>/dev/null || true)"
    agent_pid="$(printf '%s\n' "$agent_status" | /usr/bin/awk '$1 == "pid" && $2 == "=" { print $3; exit }')"
    listeners="$(/usr/sbin/lsof -nP -t -iTCP:3871 -sTCP:LISTEN || true)"
    for pid in $listeners; do
      if [[ -z "$agent_pid" || "$pid" != "$agent_pid" ]]; then
        printf 'Port 3871 is already in use by another process (PID %s); nothing changed.\n' "$pid" >&2
        printf '%s\n' 'If it is the old prototype agent, stop it with:' >&2
        printf 'launchctl bootout "%s/ai.modeldeck.phone-deck-proto"\n' "$DOMAIN" >&2
        printf '%s\n' 'Then remove its login entry so it stays stopped:' >&2
        printf '%s\n' 'rm "$HOME/Library/LaunchAgents/ai.modeldeck.phone-deck-proto.plist"' >&2
        exit 1
      fi
    done
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
    temporary="$(mktemp "$PLIST.XXXXXX")"
    trap 'rm -f "$temporary"' EXIT
    "$NODE" --input-type=module - "$DIR" "$HOME" > "$temporary" <<'NODE'
const [dir, home] = process.argv.slice(2);
const xml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const optionalEnv = ['SOURCES', 'MACHINE_LABEL', 'ALLOWED_NAMES', 'DAEMON_PORT']
  .filter((key) => process.env[key] !== undefined)
  .map((key) => `    <key>${key}</key><string>${xml(process.env[key])}</string>\n`).join('');
console.log(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.modeldeck.phone-deck</string>
  <key>ProgramArguments</key><array>
    <string>/opt/homebrew/bin/node</string><string>${xml(dir)}/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(dir)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PORT</key><string>3871</string>
    <key>HOSTS</key><string>127.0.0.1</string>
${optionalEnv}  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(home)}/Library/Logs/modeldeck-phone-deck.log</string>
  <key>StandardErrorPath</key><string>${xml(home)}/Library/Logs/modeldeck-phone-deck.log</string>
</dict></plist>`);
NODE
    /usr/bin/plutil -lint "$temporary" >/dev/null
    chmod 644 "$temporary"
    if [[ -n "$agent_status" ]]; then
      /bin/launchctl bootout "$DOMAIN/$LABEL"
    fi
    mv "$temporary" "$PLIST"
    /bin/launchctl bootstrap "$DOMAIN" "$PLIST"
    printf 'Installed %s\nLogs: %s\n' "$LABEL" "$LOG"
    serve_hint
    ;;
  uninstall)
    if /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      /bin/launchctl bootout "$DOMAIN/$LABEL"
    fi
    rm -f "$PLIST"
    printf 'Stopped and removed %s. Log retained: %s\n' "$LABEL" "$LOG"
    ;;
  status)
    if ! /bin/launchctl print "$DOMAIN/$LABEL"; then
      printf '%s is not loaded.\n' "$LABEL"
      exit 1
    fi
    ;;
  *)
    printf 'Usage: %s install [--two-mac] | uninstall | status\n' "$0" >&2
    exit 2
    ;;
esac
