#!/bin/bash
set -euo pipefail
# Linux counterpart of pool-target.sh (#809, #810): the same remote, host and
# status modes, plan, --yes and printed undo, on systemd user units.
# The mutation token is read from the owner-only token file (decision 0046)
# into curl's stdin, never argv or the environment.
set +x
set +a

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
LSOF="${LSOF:-/usr/bin/lsof}"
CURL="${CURL:-curl}"
NODE="${NODE:-}"
SLEEP="${SLEEP:-sleep}"
DAEMON_URL="${DAEMON_URL:-http://127.0.0.1:3867}"
# The live install's names; a scratch run passes its own.
PROXY_UNIT="${PROXY_UNIT:-cliproxyapi.service}"
REBALANCE_UNIT="${REBALANCE_UNIT:-modeldeck-rebalance.timer}"
FORWARDER_UNIT="${FORWARDER_UNIT:-modeldeck-pool-forwarder}"
PROXY_PORT="${PROXY_PORT:-8317}"
# Fixed folders, never XDG (decision 0046): the daemon and the units agree.
CONFIG_HOME="$HOME/.config"
SECRETS_DIR="${MODELDECK_SECRETS_DIR:-$CONFIG_HOME/modeldeck}"
INSTALLER="$SCRIPT_DIR/install-systemd-unit.sh"
HEALTH="http://127.0.0.1:$PROXY_PORT/healthz"

mode="${1:-}"
[[ $# -gt 0 ]] && shift
hub='' page='' yes=false
usage() { printf 'Usage: %s remote --hub-url URL --page-url URL [--yes] | host [--yes] | status\n' "$0" >&2; exit 2; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) yes=true; shift ;;
    --hub-url|--page-url)
      [[ $# -ge 2 && -n "$2" ]] || usage
      if [[ "$1" == --hub-url ]]; then hub="$2"; else page="$2"; fi
      shift 2 ;;
    *) usage ;;
  esac
done
case "$mode" in
  remote) [[ -n "$hub" && -n "$page" ]] || usage ;;
  host|status) [[ -z "$hub$page" ]] || usage ;;
  *) usage ;;
esac
for unit in "$PROXY_UNIT" "$REBALANCE_UNIT"; do
  [[ "$unit" =~ ^[A-Za-z0-9@._-]+\.(service|timer)$ ]] || { printf 'Invalid unit name: %s\n' "$unit" >&2; exit 2; }
done
[[ "$FORWARDER_UNIT" =~ ^modeldeck[a-z0-9-]*$ ]] || { printf 'Invalid forwarder unit name\n' >&2; exit 2; }
[[ "$PROXY_PORT" =~ ^[0-9]+$ ]] && (( PROXY_PORT > 0 && PROXY_PORT < 65536 )) || { printf 'Invalid proxy port\n' >&2; exit 2; }
# The daemon is always this machine's; checked before any command uses it,
# status included (Codex review of #814).
[[ "$DAEMON_URL" =~ ^http://(127\.0\.0\.1|localhost):[0-9]{1,5}/?$ ]] || { printf 'DAEMON_URL must be http://127.0.0.1:<port>\n' >&2; exit 2; }
DAEMON_URL="${DAEMON_URL%/}"

quote() { printf '%q ' "$@"; }
action() { printf 'Action: '; quote "$@"; printf '\n'; }
if [[ "$mode" == status ]]; then
  action "$CURL" --disable --noproxy '*' --fail --silent --show-error --url "$DAEMON_URL/api/settings"
  if ! "$CURL" --disable --noproxy '*' --fail --silent --show-error --max-time 5 --url "$DAEMON_URL/api/settings"; then printf 'daemon not answering\n'; fi
  printf '\nPort %s listeners:\n' "$PROXY_PORT"
  "$LSOF" -nP -iTCP:"$PROXY_PORT" -sTCP:LISTEN || [[ $? == 1 ]]
  for unit in "$PROXY_UNIT" "$REBALANCE_UNIT" "$FORWARDER_UNIT.service"; do
    printf '%s: %s, %s\n' "$unit" "$("$SYSTEMCTL" --user is-enabled "$unit" 2>/dev/null || true)" "$("$SYSTEMCTL" --user is-active "$unit" 2>/dev/null || true)"
  done
  exit 0
fi

# Inputs are checked before the plan is printed, so a rejected URL (with
# any credentials in it) never reaches the terminal (Codex review of #814).
NODE="${NODE:-$(command -v node || true)}"
if [[ "$NODE" != /* || ! -f "$NODE" || ! -x "$NODE" ]]; then
  printf 'Node must be an absolute executable path; set NODE or put node on PATH.\n' >&2
  exit 1
fi

# Reject an override that would send the mutation token off this machine.
payload="$("$NODE" --input-type=module - "$SCRIPT_DIR/../tools/pool-forwarder/forwarder.mjs" "$mode" "$hub" "$page" "$DAEMON_URL" <<'NODE'
import { pathToFileURL } from 'node:url';
const [modulePath, mode, hub, page, daemon] = process.argv.slice(2);
const { validatePoolHost } = await import(pathToFileURL(modulePath));
try {
  const d = new URL(daemon);
  if (d.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(d.hostname) || d.username || d.password || d.pathname !== '/' || /[\s\\?#@]/.test(daemon)) throw Error();
  if (mode === 'remote') {
    const h = validatePoolHost(hub);
    if (h.protocol !== 'https:' || !h.hostname.endsWith('.ts.net')) throw Error();
    const p = new URL(page);
    if (!/^https?:\/\//.test(page) || /[\s\\?#@]/.test(page) || page.length > 256) throw Error();
    const single = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(p.hostname) && !/^\d+$/.test(p.hostname);
    if (single) {
      if (['localhost', 'broadcasthost'].includes(p.hostname) || p.hostname.endsWith('-localhost')) throw Error();
    } else validatePoolHost(p.origin.replace(/^http:/, 'https:'));
  }
  console.log(JSON.stringify({ proxyRole: mode, poolHubUrl: mode === 'remote' ? page : '' }));
} catch { console.error('Invalid hub, page or loopback daemon URL; nothing changed.'); process.exit(2); }
NODE
)"

# Host mode wakes the rebalancer, so its service must read this switch's proxy
# and daemon; otherwise a scratch run could rebalance the live pool
# (CodeRabbit on #814). Unset ports mean the defaults, 8317 and 3867.
if [[ "$mode" == host ]]; then
  state="$("$SYSTEMCTL" --user is-enabled "$REBALANCE_UNIT" 2>/dev/null || true)"
  if [[ -n "$state" && "$state" != not-found ]]; then
    rebalance_env=" $("$SYSTEMCTL" --user show -p Environment --value "${REBALANCE_UNIT%.timer}.service" 2>/dev/null || true) "
    got_proxy=8317 got_daemon=3867
    [[ "$rebalance_env" =~ \ CLIPROXY_PORT=([0-9]+)\  ]] && got_proxy="${BASH_REMATCH[1]}"
    [[ "$rebalance_env" =~ \ MODELDECK_PORT=([0-9]+)\  ]] && got_daemon="${BASH_REMATCH[1]}"
    if [[ "$got_proxy:$got_daemon" != "$PROXY_PORT:${DAEMON_URL##*:}" ]]; then
      printf '%s reads proxy port %s and daemon port %s, but this switch uses %s and %s. Set REBALANCE_UNIT to the matching timer, or reinstall it with scripts/install-systemd-unit.sh --role rebalance. Nothing changed.\n' \
        "$REBALANCE_UNIT" "$got_proxy" "$got_daemon" "$PROXY_PORT" "${DAEMON_URL##*:}" >&2
      exit 1
    fi
  fi
fi

printf 'Plan (%s):\n' "$mode"
if [[ "$mode" == remote ]]; then
  action "$SYSTEMCTL" --user disable --now "$REBALANCE_UNIT"
  action "$SYSTEMCTL" --user disable --now "$PROXY_UNIT"
  action "$INSTALLER" --role forwarder --unit "$FORWARDER_UNIT" --port "$PROXY_PORT" --env "POOL_HOST_URL=$hub"
  printf 'Action: wait up to 10 seconds for %s to return {"status":"ok"}\n' "$HEALTH"
  printf 'Action: PUT %s/api/settings proxyRole=remote poolHubUrl=%q; token file through curl -H @-\n' "$DAEMON_URL" "$page"
else
  printf 'Action: PUT %s/api/settings {"proxyRole":"host","poolHubUrl":""}; token file through curl -H @-\n' "$DAEMON_URL"
  action "$INSTALLER" --role forwarder --unit "$FORWARDER_UNIT" --uninstall '(if installed)'
  action "$SYSTEMCTL" --user enable --now "$PROXY_UNIT"
  action "$SYSTEMCTL" --user enable --now "$REBALANCE_UNIT" '(if present)'
  printf 'Action: wait up to 10 seconds for %s to return {"status":"ok"}\n' "$HEALTH"
  printf 'Action: admit this machine'"'"'s pool-client-key and Codex bearers to the local proxy'"'"'s api-keys after health succeeds.\n'
fi
printf 'Action: validate inputs and snapshot previous settings and units for undo before applying changes.\n'
if [[ "$yes" != true ]]; then printf 'Dry-run: nothing changed. Add --yes to apply.\n'; exit 0; fi

undo=()
failed() {
  local code=$? i
  if (( BASH_SUBSHELL > 0 )); then return "$code"; fi
  trap - ERR
  printf 'Cutover stopped (exit %s). Undo commands, in order (including any partially applied step):\n' "$code" >&2
  if [[ ${#undo[@]} == 0 ]]; then printf 'No changes were made.\n' >&2; fi
  for ((i=${#undo[@]}-1; i>=0; i--)); do bash_command "${undo[i]}" >&2; printf '\n' >&2; done
  exit "$code"
}
trap failed ERR
set -E
bash_command() { printf "bash -c '%s'" "${1//\'/\'\\\'\'}"; }

# The token file is checked by the daemon's own reader (owner-only, no links)
# and turned straight into the two headers on stdout.
token_js='const { readSecretFile } = await import(process.argv[1]); const t = readSecretFile(process.argv[2]); if (!t) process.exit(1); process.stdout.write(`x-modeldeck-token: ${t}\nCookie: modeldeck_session=${encodeURIComponent(t)}\n`);'
token_reader="$SCRIPT_DIR/../src/secret-file.mjs"
mutation_command() {
  printf 'set -euo pipefail; set +x; set +a; unset pool_token_headers; pool_token_headers=$('
  quote "$NODE" --input-type=module -e "$token_js" "$token_reader" "$SECRETS_DIR/mutation-token"
  printf '); printf "%%s\\n" "$pool_token_headers" | '; quote "$CURL" --disable --noproxy '*' --fail --silent --show-error --max-time 5 -X PUT "$DAEMON_URL/api/settings" -H @- -H 'Content-Type: application/json' --data "$1"
  printf ' >/dev/null'
}
unset pool_token_headers
pool_token_headers="$("$NODE" --input-type=module -e "$token_js" "$token_reader" "$SECRETS_DIR/mutation-token")" \
  || { printf 'Cannot read the mutation token file in %s; nothing changed.\n' "$SECRETS_DIR" >&2; false; }
mutate() {
  printf '%s\n' "$pool_token_headers" |
    "$CURL" --disable --noproxy '*' --fail --silent --show-error --max-time 5 -X PUT "$DAEMON_URL/api/settings" -H @- -H 'Content-Type: application/json' --data "$1" >/dev/null
}

previous=''
daemon_up=true
if previous="$("$CURL" --disable --noproxy '*' --fail --silent --show-error --max-time 5 "$DAEMON_URL/api/settings" 2>/dev/null)"; then
  previous="$(printf '%s' "$previous" | "$NODE" --input-type=module -e '
let text=""; for await (const c of process.stdin) text+=c;
const s=JSON.parse(text); if (!["host","remote"].includes(s.proxyRole) || typeof s.poolHubUrl !== "string") process.exit(1);
console.log(JSON.stringify({proxyRole:s.proxyRole,poolHubUrl:s.poolHubUrl}));')"
else
  printf 'daemon not answering\n'
  if [[ "$mode" != host ]]; then false; fi
  daemon_up=false
fi

unit_state() { "$SYSTEMCTL" --user "$1" "$2" 2>/dev/null || true; }
main_pid() { "$SYSTEMCTL" --user show -p MainPID --value "$1" 2>/dev/null || true; }
# Only the proxy unit or our forwarder may hold the port; anything else stops the cutover.
known_pids=" $(main_pid "$PROXY_UNIT") $(main_pid "$FORWARDER_UNIT.service") "
if listeners="$("$LSOF" -nP -t -iTCP:"$PROXY_PORT" -sTCP:LISTEN 2>&1)"; then :
else
  code=$?
  [[ "$code" == 1 && -z "$listeners" ]] || { printf 'Cannot check port %s; nothing changed.\n' "$PROXY_PORT" >&2; false; }
fi
for pid in $listeners; do
  if [[ ! "$pid" =~ ^[0-9]+$ || "$pid" == 0 || "$known_pids" != *" $pid "* ]]; then
    printf 'port %s is held by PID %s, which is neither %s nor %s; stop it, then re-run\n' "$PROXY_PORT" "$pid" "$PROXY_UNIT" "$FORWARDER_UNIT.service" >&2
    false
  fi
done

forwarder_file="$CONFIG_HOME/systemd/user/$FORWARDER_UNIT.service"
backup=''
if [[ -f "$forwarder_file" ]]; then
  backup_dir="${MODELDECK_DATA_DIR:-$HOME/.local/share/modeldeck}/pool-target-backups"
  mkdir -p "$backup_dir"
  chmod 700 "$backup_dir"
  backup="$(mktemp "$backup_dir/forwarder.XXXXXX")"
  cp "$forwarder_file" "$backup"
fi
# Undo for a unit puts back exactly the enabled and running states seen now,
# each on its own: enabled-but-stopped stays stopped, running-but-disabled
# stays disabled (Codex review of #814). Other states (static, masked) are
# left as they are.
restore_unit() {
  local unit="$1" enabled active
  enabled="$(unit_state is-enabled "$unit")"
  active="$(unit_state is-active "$unit")"
  case "$enabled" in
    enabled) quote "$SYSTEMCTL" --user enable "$unit"; printf '\n' ;;
    disabled) quote "$SYSTEMCTL" --user disable "$unit"; printf '\n' ;;
  esac
  if [[ "$active" == active ]]; then quote "$SYSTEMCTL" --user start "$unit"; else quote "$SYSTEMCTL" --user stop "$unit"; fi
}

restore_forwarder="$(quote "$SYSTEMCTL" --user disable --now "$FORWARDER_UNIT.service") || true"
if [[ -n "$backup" ]]; then
  restore_forwarder+=$'\n'"$(quote cp "$backup" "$forwarder_file")"$'\n'"$(quote "$SYSTEMCTL" --user daemon-reload)"
  restore_forwarder+=$'\n'"$(restore_unit "$FORWARDER_UNIT.service")"
else
  restore_forwarder+=$'\n'"$(quote rm -f "$forwarder_file")"$'\n'"$(quote "$SYSTEMCTL" --user daemon-reload)"
fi

wait_health() {
  local deadline=$((SECONDS + 10)) remaining result
  while (( SECONDS < deadline )); do
    remaining=$((deadline - SECONDS))
    if result="$("$CURL" --disable --noproxy '*' --fail --silent --show-error --max-time "$remaining" "$HEALTH" 2>/dev/null)" &&
      printf '%s' "$result" | "$NODE" --input-type=module -e 'let s=""; for await (const c of process.stdin) s+=c; try { process.exit(JSON.parse(s)?.status === "ok" ? 0 : 1); } catch { process.exit(1); }'; then return 0; fi
    if (( SECONDS < deadline )); then "$SLEEP" 1; fi
  done
  printf 'Proxy healthz did not answer status ok within 10 seconds.\n' >&2
  return 1
}

if [[ "$mode" == remote ]]; then
  for unit in "$REBALANCE_UNIT" "$PROXY_UNIT"; do
    if [[ "$(unit_state is-enabled "$unit")" == not-found || -z "$(unit_state is-enabled "$unit")" ]]; then
      [[ "$unit" == "$REBALANCE_UNIT" ]] && continue
      printf 'Cannot restore %s: unit not found; nothing changed.\n' "$unit" >&2
      false
    fi
    undo+=("$(restore_unit "$unit")")
    "$SYSTEMCTL" --user disable --now "$unit"
  done
  undo+=("$restore_forwarder")
  SYSTEMCTL="$SYSTEMCTL" LSOF="$LSOF" "$INSTALLER" --role forwarder --unit "$FORWARDER_UNIT" --port "$PROXY_PORT" --node "$NODE" --env "POOL_HOST_URL=$hub"
  wait_health
  undo+=("$(mutation_command "$previous")")
  mutate "$payload"
else
  if [[ "$daemon_up" == true ]]; then
    undo+=("$(mutation_command "$previous")")
    mutate "$payload"
  fi
  undo+=("$restore_forwarder")
  if [[ -f "$forwarder_file" ]]; then
    SYSTEMCTL="$SYSTEMCTL" "$INSTALLER" --role forwarder --unit "$FORWARDER_UNIT" --uninstall
  fi
  for unit in "$PROXY_UNIT" "$REBALANCE_UNIT"; do
    state="$(unit_state is-enabled "$unit")"
    if [[ -z "$state" || "$state" == not-found ]]; then
      [[ "$unit" == "$REBALANCE_UNIT" ]] && continue
      printf 'Cannot start %s: unit not found.\n' "$unit" >&2
      false
    fi
    undo+=("$(restore_unit "$unit")")
    "$SYSTEMCTL" --user enable --now "$unit"
  done
  wait_health
  if [[ "$daemon_up" == true ]]; then
    PROXY_PORT="$PROXY_PORT" MODELDECK_SECRETS_DIR="$SECRETS_DIR" "$NODE" "$SCRIPT_DIR/../tools/pool-forwarder/restore-local-keys.mjs" "$DAEMON_URL"
  else
    printf 'Local proxy restored; after the daemon returns, apply host settings and restore local keys:\n'
    retry="$(mutation_command "$payload")"
    retry+="; $(quote env "CURL=$CURL" "PROXY_PORT=$PROXY_PORT" "MODELDECK_SECRETS_DIR=$SECRETS_DIR" "MANAGEMENT_KEY_FILE=${MANAGEMENT_KEY_FILE:-$HOME/.config/cliproxyapi/.mgmt-key}" "$NODE" "$SCRIPT_DIR/../tools/pool-forwarder/restore-local-keys.mjs" "$DAEMON_URL")"
    bash_command "$retry"; printf '\n'
  fi
fi
[[ -z "$backup" ]] || rm -f "$backup"
if [[ "$daemon_up" == true ]]; then printf 'Pool target is now %s.\n' "$mode"; fi
