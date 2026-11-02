#!/bin/bash
set -euo pipefail

DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd -P)"
LABEL=ai.modeldeck.pool-forwarder
LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LAUNCHCTL="${LAUNCHCTL:-/bin/launchctl}"
LSOF="${LSOF:-/usr/sbin/lsof}"
NODE="${NODE:-$(command -v node || true)}"
if [[ "$NODE" != /* || ! -f "$NODE" || ! -x "$NODE" ]]; then
  printf 'Node must be an absolute executable path; set NODE or put node on PATH.\n' >&2
  exit 1
fi
PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
LOG="$HOME/Library/Logs/modeldeck-pool-forwarder.log"
DOMAIN="gui/$UID"

case "${1:-}" in
  install)
    # Validate before any writes or launchd calls. The same validator runs at startup.
    "$NODE" --input-type=module - "$DIR/forwarder.mjs" <<'NODE'
import { pathToFileURL } from 'node:url';
const { readConfig } = await import(pathToFileURL(process.argv[2]));
try { readConfig(); } catch (e) { console.error(e.message); process.exit(1); }
NODE
    agent_status="$("$LAUNCHCTL" print "$DOMAIN/$LABEL" 2>/dev/null || true)"
    agent_pid=''
    if [[ "$agent_status" =~ pid[[:space:]]*=[[:space:]]*([0-9]+) ]]; then agent_pid="${BASH_REMATCH[1]}"; fi
    # lsof exit 1 means no listener; a broken probe must never authorize install.
    if listeners="$("$LSOF" -nP -t -iTCP:"${PORT:-8317}" -sTCP:LISTEN 2>&1)"; then :
    else
      code=$?
      [[ "$code" == 1 && -z "$listeners" ]] || exit "$code"
    fi
    for pid in $listeners; do
      if [[ -z "$agent_pid" || "$pid" != "$agent_pid" ]]; then
        printf 'Port %s is held by another process (PID %s); stop it first.\n' "${PORT:-8317}" "$pid" >&2
        "$LSOF" -nP -iTCP:"${PORT:-8317}" -sTCP:LISTEN >&2 || true
        exit 1
      fi
    done
    mkdir -p "$LAUNCH_AGENTS_DIR" "$HOME/Library/Logs"
    temporary="$(mktemp "$PLIST.XXXXXX")"
    trap 'rm -f "$temporary"' EXIT
    "$NODE" --input-type=module - "$DIR" "$LOG" "$NODE" > "$temporary" <<'NODE'
import { pathToFileURL } from 'node:url';
const [dir, log, node] = process.argv.slice(2);
const { readConfig } = await import(pathToFileURL(`${dir}/forwarder.mjs`));
const { target, port } = readConfig();
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
console.log(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>ai.modeldeck.pool-forwarder</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(dir)}/forwarder.mjs</string></array>
<key>WorkingDirectory</key><string>${xml(dir)}</string>
<key>EnvironmentVariables</key><dict>
<key>POOL_HOST_URL</key><string>${xml(target.origin)}</string>
<key>PORT</key><string>${port}</string>
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>`);
NODE
    chmod 644 "$temporary"
    if [[ -n "$agent_status" ]]; then "$LAUNCHCTL" bootout "$DOMAIN/$LABEL"; fi
    mv "$temporary" "$PLIST"
    "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"
    printf 'Installed %s\nLogs: %s\n' "$LABEL" "$LOG"
    ;;
  uninstall)
    if "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; then "$LAUNCHCTL" bootout "$DOMAIN/$LABEL"; fi
    rm -f "$PLIST"
    printf 'Stopped and removed %s; log retained.\n' "$LABEL"
    ;;
  status) "$LAUNCHCTL" print "$DOMAIN/$LABEL" ;;
  *) printf 'Usage: %s install|uninstall|status\n' "$0" >&2; exit 2 ;;
esac
