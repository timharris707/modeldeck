#!/bin/bash
# Install (or reinstall) a ModelDeck piece as a systemd user unit (Linux,
# #807, #809, #810). The Linux counterpart of install-launch-agent.sh and the
# tools' launch-agent.sh installers.
#
# Roles:
#   daemon      modeldeck.service: the daemon on 127.0.0.1 (default port 3867).
#               Its mutation token comes from ~/.config/modeldeck/mutation-token
#               (scripts/set-mutation-token.sh), never from the unit file.
#   usage-page  modeldeck-usage-page.service: tools/phone-deck on 127.0.0.1
#               (default 3871). --env SOURCES=local MACHINE_LABEL=... for hub mode.
#   forwarder   modeldeck-pool-forwarder.service: tools/pool-forwarder on
#               127.0.0.1 (default 8317). --env POOL_HOST_URL=https://<hub>.ts.net
#   rebalance   modeldeck-rebalance.service + .timer: the pool weight job every
#               300 s (--script, default ~/.config/cliproxyapi/rebalance-weights.py).
#
# Renders ~/.config/systemd/user/<unit>.service (and .timer), then reloads
# systemd and enables and (re)starts it. Every listener binds 127.0.0.1 only.
#
# Usage:
#   scripts/install-systemd-unit.sh [--role ROLE] [--port N] [--projects-root DIR]
#       [--node PATH] [--script PATH] [--unit NAME] [--env NAME=VALUE]... [--dry-run]
#   scripts/install-systemd-unit.sh [--role ROLE] --uninstall [--unit NAME] [--dry-run]
#
# --unit and --env exist for scratch instances; each role accepts only its own
# variable names. Units keep running after logout only with lingering on:
# loginctl enable-linger "$USER".
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
LSOF="${LSOF:-/usr/bin/lsof}"
ROLE=daemon
UNIT=''
PORT=''
PROJECTS_ROOT="$HOME/projects"
NODE_BIN=''
SCRIPT=''
DRY_RUN=0
UNINSTALL=0
EXTRA_ENV=()

die() { printf 'install-systemd-unit.sh: %s\n' "$1" >&2; exit 1; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) [[ $# -ge 2 ]] || die 'missing value'; ROLE="$2"; shift 2 ;;
    --port) [[ $# -ge 2 ]] || die 'missing value'; PORT="$2"; shift 2 ;;
    --projects-root) [[ $# -ge 2 ]] || die 'missing value'; PROJECTS_ROOT="$2"; shift 2 ;;
    --node) [[ $# -ge 2 ]] || die 'missing value'; NODE_BIN="$2"; shift 2 ;;
    --script) [[ $# -ge 2 ]] || die 'missing value'; SCRIPT="$2"; shift 2 ;;
    --unit) [[ $# -ge 2 ]] || die 'missing value'; UNIT="$2"; shift 2 ;;
    --env) [[ $# -ge 2 ]] || die 'missing value'; EXTRA_ENV+=("$2"); shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

# Per role: default unit, default port, and the variable names --env accepts.
case "$ROLE" in
  daemon) UNIT="${UNIT:-modeldeck}"; PORT="${PORT:-3867}"; ALLOWED='MODELDECK_[A-Z0-9_]+'
    DENIED='MODELDECK_HOST|MODELDECK_PORT|MODELDECK_PROJECTS_ROOT|MODELDECK_MUTATION_TOKEN' ;;
  usage-page) UNIT="${UNIT:-modeldeck-usage-page}"; PORT="${PORT:-3871}"
    ALLOWED='SOURCES|MACHINE_LABEL|ALLOWED_NAMES|DAEMON_PORT'; DENIED='' ;;
  forwarder) UNIT="${UNIT:-modeldeck-pool-forwarder}"; PORT="${PORT:-8317}"; ALLOWED='POOL_HOST_URL'; DENIED='' ;;
  rebalance) UNIT="${UNIT:-modeldeck-rebalance}"; PORT="${PORT:-0}"
    ALLOWED='MODELDECK_PORT|CLIPROXY_PORT|CLIPROXY_CONFIG_DIR'; DENIED=''
    SCRIPT="${SCRIPT:-$HOME/.config/cliproxyapi/rebalance-weights.py}" ;;
  *) die 'role must be daemon, usage-page, forwarder or rebalance' ;;
esac

[[ "$UNIT" =~ ^modeldeck[a-z0-9-]*$ ]] || die 'unit name must start with modeldeck and use only a-z, 0-9 and -'
if [[ "$ROLE" != rebalance ]]; then
  [[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT > 0 && PORT < 65536 )) || die 'port must be 1-65535'
fi
for pair in ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"}; do
  [[ "$pair" =~ ^($ALLOWED)=[^[:cntrl:]]*$ ]] || die "--env for role $ROLE takes NAME=VALUE without control characters, NAME one of: ${ALLOWED//|/, }"
  if [[ -n "$DENIED" && "${pair%%=*}" =~ ^($DENIED)$ ]]; then die "${pair%%=*} cannot be set with --env"; fi
  # Port settings are plain numbers, so no value can name another host
  # (Codex review of #814: 3867@evil.example). Relative paths would resolve
  # against the repo here but against the caller's folder in the scripts
  # that share them.
  case "${pair%%=*}" in
    MODELDECK_PORT|CLIPROXY_PORT|DAEMON_PORT)
      value="${pair#*=}"
      [[ "$value" =~ ^[0-9]{1,5}$ ]] && (( value > 0 && value < 65536 )) || die "${pair%%=*} must be a port number" ;;
    *_DIR|*_PATH) [[ "${pair#*=}" == /* ]] || die "${pair%%=*} must be an absolute path" ;;
  esac
done
# Every value below lands in the unit file; a control character could start a
# new directive (Codex review of #812), so none is allowed anywhere.
[[ "$PROJECTS_ROOT" == /* && "$PROJECTS_ROOT$NODE_BIN$REPO_DIR$SCRIPT" != *[[:cntrl:]]* ]] \
  || die 'paths must be absolute and free of control characters'

UNIT_DIR="${SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
UNIT_FILE="$UNIT_DIR/$UNIT.service"
TIMER_FILE="$UNIT_DIR/$UNIT.timer"
FILES=("$UNIT_FILE")
[[ "$ROLE" != rebalance ]] || FILES+=("$TIMER_FILE")
# The rebalancer is started by its timer; everything else runs as a service.
START_UNIT="$UNIT.service"
[[ "$ROLE" != rebalance ]] || START_UNIT="$UNIT.timer"

MARKER='# Written by scripts/install-systemd-unit.sh. Re-run it to change; do not edit.'

if [[ "$UNINSTALL" -eq 1 ]]; then
  # Only units this script wrote are ever removed.
  for file in "${FILES[@]}"; do
    [[ -f "$file" && ! -L "$file" ]] || die "no $file to remove"
    [[ "$(head -n 1 "$file")" == "$MARKER" ]] || die "$file was not written by this script; leaving it"
  done
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "Would run: $SYSTEMCTL --user disable --now $START_UNIT; rm ${FILES[*]}; $SYSTEMCTL --user daemon-reload"
    exit 0
  fi
  # A unit that will not stop keeps its file, so nothing reports a removal
  # while the old process still runs (Codex review of #814).
  "$SYSTEMCTL" --user disable --now "$START_UNIT" || die "could not stop $START_UNIT; its unit file is left in place"
  [[ "$ROLE" != rebalance ]] || "$SYSTEMCTL" --user stop "$UNIT.service" || die "could not stop $UNIT.service; its unit files are left in place"
  rm -f "${FILES[@]}"
  "$SYSTEMCTL" --user daemon-reload
  echo "Removed ${FILES[*]}"
  exit 0
fi

if [[ "$ROLE" == rebalance ]]; then
  PYTHON=/usr/bin/python3
  [[ -x "$PYTHON" ]] || die "$PYTHON not found"
  [[ "$SCRIPT" == /* && -f "$SCRIPT" ]] || die "rebalance script not found: $SCRIPT (copy ops/cliproxyapi/rebalance-weights.py there first)"
  EXEC_PATHS="$PYTHON$SCRIPT"
else
  [[ -n "$NODE_BIN" ]] || NODE_BIN="$(command -v node || true)"
  [[ "$NODE_BIN" == /* && -x "$NODE_BIN" ]] || die 'node not found; pass --node /absolute/path/to/node (Node 24.16 or newer)'
  "$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>24||(a===24&&b>=16)?0:1)' \
    || die "$NODE_BIN is Node $("$NODE_BIN" --version); ModelDeck needs 24.16 or newer"
  EXEC_PATHS="$NODE_BIN"
fi
# systemd expands $ in ExecStart; refuse rather than escape an odd path.
[[ "$EXEC_PATHS$REPO_DIR" != *['$'[:cntrl:]]* ]] || die 'the program and repo paths must not contain $ or control characters'
# A trailing backslash would continue the unit line onto the next one.
for value in "$NODE_BIN" "$SCRIPT" "$REPO_DIR" "$PROJECTS_ROOT"; do [[ "$value" != *'\' ]] || die 'paths must not end in a backslash'; done

# The tools validate their settings with the same rules they apply at startup,
# so a bad value fails here rather than in a restart loop.
case "$ROLE" in
  usage-page)
    (unset SOURCES MACHINE_LABEL ALLOWED_NAMES DAEMON_PORT
     for pair in ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"}; do export "$pair"; done
     "$NODE_BIN" --input-type=module - "$REPO_DIR/tools/phone-deck/config.mjs" <<'NODE'
import { pathToFileURL } from 'node:url';
const { validateConfig } = await import(pathToFileURL(process.argv[2]));
try { validateConfig(process.env); } catch (error) { console.error(error.message); process.exit(1); }
NODE
    ) || die 'usage page settings refused'
    ;;
  forwarder)
    (unset POOL_HOST_URL HOST HOSTS
     for pair in ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"}; do export "$pair"; done
     PORT="$PORT" "$NODE_BIN" --input-type=module - "$REPO_DIR/tools/pool-forwarder/forwarder.mjs" <<'NODE'
import { pathToFileURL } from 'node:url';
const { readConfig } = await import(pathToFileURL(process.argv[2]));
try { readConfig(); } catch (error) { console.error(error.message); process.exit(1); }
NODE
    ) || die 'forwarder settings refused'
    ;;
esac

# A listener must never replace another process on its port (the Mac
# installers' rule). The unit's own running process may hold it.
if [[ "$ROLE" == forwarder || "$ROLE" == usage-page ]] && [[ "$DRY_RUN" -eq 0 ]]; then
  own="$("$SYSTEMCTL" --user show -p MainPID --value "$UNIT.service" 2>/dev/null || true)"
  if listeners="$("$LSOF" -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>&1)"; then :
  else
    code=$?
    [[ "$code" == 1 && -z "$listeners" ]] || die "cannot check port $PORT with $LSOF"
  fi
  for pid in $listeners; do
    [[ "$pid" == "$own" && "$own" != 0 ]] || die "port $PORT is held by another process (PID $pid); stop it first"
  done
fi

# systemd unit quoting: a value goes inside double quotes, with \ and " escaped
# and % doubled so specifiers never expand.
quote() { local v="${1//\\/\\\\}"; v="${v//\"/\\\"}"; printf '"%s"' "${v//%/%%}"; }
env_line() { printf 'Environment=%s\n' "$(quote "$1")"; }

render_service() {
  printf '%s\n' "$MARKER"
  case "$ROLE" in
    daemon)
      printf '[Unit]\nDescription=ModelDeck daemon (API on 127.0.0.1:%s)\n\n[Service]\n' "$PORT"
      printf 'ExecStart=%s %s\n' "$(quote "$NODE_BIN")" "$(quote "$REPO_DIR/src/server.mjs")"
      # WorkingDirectory takes the bare path (quotes are an error); % still doubles.
      printf 'WorkingDirectory=%s\n' "${REPO_DIR//%/%%}"
      env_line "PATH=$(dirname "$NODE_BIN"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
      env_line 'MODELDECK_HOST=127.0.0.1'
      env_line "MODELDECK_PORT=$PORT"
      env_line "MODELDECK_PROJECTS_ROOT=$PROJECTS_ROOT" ;;
    usage-page)
      printf '[Unit]\nDescription=ModelDeck usage page (127.0.0.1:%s)\n\n[Service]\n' "$PORT"
      printf 'ExecStart=%s %s\n' "$(quote "$NODE_BIN")" "$(quote "$REPO_DIR/tools/phone-deck/server.mjs")"
      printf 'WorkingDirectory=%s\n' "${REPO_DIR//%/%%}/tools/phone-deck"
      env_line "PORT=$PORT"
      env_line 'HOSTS=127.0.0.1' ;;
    forwarder)
      printf '[Unit]\nDescription=ModelDeck pool forwarder (127.0.0.1:%s)\n\n[Service]\n' "$PORT"
      printf 'ExecStart=%s %s\n' "$(quote "$NODE_BIN")" "$(quote "$REPO_DIR/tools/pool-forwarder/forwarder.mjs")"
      printf 'WorkingDirectory=%s\n' "${REPO_DIR//%/%%}/tools/pool-forwarder"
      env_line "PORT=$PORT" ;;
    rebalance)
      printf '[Unit]\nDescription=ModelDeck pool rebalance (weights from usage)\n\n[Service]\nType=oneshot\n'
      printf 'ExecStart=%s -I %s\n' "$(quote "$PYTHON")" "$(quote "$SCRIPT")"
      # The daemon it reads is always this machine's (Codex review of #814).
      env_line 'MODELDECK_HOST=127.0.0.1' ;;
  esac
  for pair in ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"}; do env_line "$pair"; done
  if [[ "$ROLE" == rebalance ]]; then
    printf 'UMask=0077\n'
  else
    printf 'UMask=0077\nRestart=on-failure\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n'
  fi
}

render_timer() {
  printf '%s\n' "$MARKER"
  printf '[Unit]\nDescription=Run %s every 300 s\n\n[Timer]\nOnBootSec=60\nOnUnitActiveSec=300\nUnit=%s.service\n\n[Install]\nWantedBy=timers.target\n' "$UNIT" "$UNIT"
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  render_service
  if [[ "$ROLE" == rebalance ]]; then printf '\n'; render_timer; fi
  exit 0
fi

mkdir -p "$UNIT_DIR"
write_unit() {
  local target="$1" renderer="$2" temporary
  temporary="$(mktemp "$target.XXXXXX")"
  trap 'rm -f "$temporary"' EXIT
  "$renderer" > "$temporary"
  chmod 644 "$temporary"
  mv -f "$temporary" "$target"
  trap - EXIT
}
write_unit "$UNIT_FILE" render_service
[[ "$ROLE" != rebalance ]] || write_unit "$TIMER_FILE" render_timer
"$SYSTEMCTL" --user daemon-reload
"$SYSTEMCTL" --user enable "$START_UNIT"
"$SYSTEMCTL" --user restart "$START_UNIT"

echo "Installed ${FILES[*]}"
echo "Status:  systemctl --user status $START_UNIT"
echo "Logs:    journalctl --user -u $UNIT.service"
case "$ROLE" in
  daemon) echo "Health:  curl -s http://127.0.0.1:$PORT/api/health" ;;
  forwarder) echo "Health:  curl -s http://127.0.0.1:$PORT/healthz" ;;
  usage-page) echo "Status:  curl -s http://127.0.0.1:$PORT/api/status" ;;
esac
if [[ "$(loginctl show-user "${USER:-$(id -un)}" -p Linger --value 2>/dev/null || true)" != yes ]]; then
  echo "Note: lingering is off, so the unit stops at logout. To keep it running: loginctl enable-linger ${USER:-$(id -un)}"
fi
