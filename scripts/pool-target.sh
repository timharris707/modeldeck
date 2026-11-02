#!/bin/bash
set -euo pipefail
# Never enable shell tracing: the Keychain response belongs only in curl stdin.
set +x
set +a

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Linux runs the systemd counterpart with the same modes and flags (#809).
if [[ "$(uname -s)" != Darwin ]]; then exec "$SCRIPT_DIR/pool-target-linux.sh" "$@"; fi
LAUNCHCTL="${LAUNCHCTL:-/bin/launchctl}"
LSOF="${LSOF:-/usr/sbin/lsof}"
CURL="${CURL:-curl}"
SECURITY="${SECURITY:-/usr/bin/security}"
NODE="${NODE:-}"
SLEEP="${SLEEP:-sleep}"
CP="${CP:-cp}"
RM="${RM:-rm}"
MKTEMP="${MKTEMP:-mktemp}"
LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
FORWARDER_DIR="${FORWARDER_DIR:-$SCRIPT_DIR/../tools/pool-forwarder}"
DAEMON_URL="${DAEMON_URL:-http://127.0.0.1:3867}"
DOMAIN="gui/$UID"
FORWARDER=ai.modeldeck.pool-forwarder
SERVER=com.cliproxyapi.server
REBALANCE=com.cliproxyapi.rebalance-weights
HEALTH=http://127.0.0.1:8317/healthz
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

# Builtins only until the dry-run exit; even a status probe is an external effect.
quote() { printf '%q ' "$@"; }
action() { printf 'Action: '; quote "$@"; printf '\n'; }
if [[ "$mode" == status ]]; then
  action "$CURL" --disable --noproxy '*' --fail --silent --show-error "$DAEMON_URL/api/settings"
  if ! "$CURL" --disable --noproxy '*' --fail --silent --show-error --max-time 5 "$DAEMON_URL/api/settings"; then printf 'daemon not answering\n'; fi
  printf '\nPort 8317 listeners:\n'
  "$LSOF" -nP -iTCP:8317 -sTCP:LISTEN || [[ $? == 1 ]]
  for label in "$REBALANCE" "$SERVER" "$FORWARDER"; do
    if "$LAUNCHCTL" print "$DOMAIN/$label"; then :; else printf '%s is not loaded.\n' "$label"; fi
  done
  printf 'Disabled agent state:\n'
  "$LAUNCHCTL" print-disabled "$DOMAIN"
  exit 0
fi
printf 'Plan (%s):\n' "$mode"
if [[ "$mode" == remote ]]; then
  action "$LAUNCHCTL" disable "$DOMAIN/$REBALANCE"
  action "$LAUNCHCTL" bootout "$DOMAIN/$REBALANCE" '(if loaded)'
  action "$LAUNCHCTL" disable "$DOMAIN/$SERVER"
  action "$LAUNCHCTL" bootout "$DOMAIN/$SERVER" '(if loaded)'
  action env "POOL_HOST_URL=$hub" PORT=8317 "$FORWARDER_DIR/launch-agent.sh" install
  printf 'Action: wait up to 10 seconds for %s to return {"status":"ok"}\n' "$HEALTH"
  printf 'Action: PUT %s/api/settings proxyRole=remote poolHubUrl=%q; Keychain token through curl -H @-\n' "$DAEMON_URL" "$page"
else
  printf 'Action: PUT %s/api/settings {"proxyRole":"host","poolHubUrl":""}; Keychain token through curl -H @-\n' "$DAEMON_URL"
  action "$FORWARDER_DIR/launch-agent.sh" uninstall
  action "$LAUNCHCTL" enable "$DOMAIN/$SERVER"
  action "$LAUNCHCTL" bootstrap "$DOMAIN" "$LAUNCH_AGENTS_DIR/$SERVER.plist" '(if present)'
  action "$LAUNCHCTL" enable "$DOMAIN/$REBALANCE"
  action "$LAUNCHCTL" bootstrap "$DOMAIN" "$LAUNCH_AGENTS_DIR/$REBALANCE.plist" '(if present)'
  printf 'Action: wait up to 10 seconds for %s to return {"status":"ok"}\n' "$HEALTH"
  printf 'Action: read routed Claude profile keys from Keychain and Codex bearers from config.toml; append missing keys to local management api-keys after health succeeds.\n'
fi
printf 'Action: validate inputs and snapshot previous settings/forwarder for undo before applying changes.\n'
if [[ "$yes" != true ]]; then printf 'Dry-run: nothing changed. Add --yes to apply.\n'; exit 0; fi

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
    // The credential-free status page still supports single-label tailnet
    // names; only the inference origin has the stricter HTTPS-only policy.
    const single = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(p.hostname) && !/^\d+$/.test(p.hostname);
    if (single) {
      if (['localhost', 'broadcasthost'].includes(p.hostname) || p.hostname.endsWith('-localhost')) throw Error();
    } else validatePoolHost(p.origin.replace(/^http:/, 'https:'));
  }
  console.log(JSON.stringify({ proxyRole: mode, poolHubUrl: mode === 'remote' ? page : '' }));
} catch { console.error('Invalid hub, page or loopback daemon URL; nothing changed.'); process.exit(2); }
NODE
)"

undo=()
backup=''
failed() {
  local code=$? i
  # ERR inheritance is needed in functions, but substitutions must not print
  # an undo block (or contaminate their captured output) before the caller fails.
  if (( BASH_SUBSHELL > 0 )); then return "$code"; fi
  trap - ERR
  printf 'Cutover stopped (exit %s). Undo commands, in order (including any partially applied step):\n' "$code" >&2
  if [[ ${#undo[@]} == 0 ]]; then printf 'No changes were made.\n' >&2; fi
  for ((i=${#undo[@]}-1; i>=0; i--)); do bash_command "${undo[i]}" >&2; printf '\n' >&2; done
  exit "$code"
}
trap failed ERR
set -E
# Always print a literal bash wrapper, including for users whose login shell is zsh.
bash_command() { printf "bash -c '%s'" "${1//\'/\'\\\'\'}"; }
headers_js='let t=""; for await (const c of process.stdin) t+=c; t=t.trim(); if (!t || /[\r\n]/.test(t)) process.exit(1); process.stdout.write(`x-modeldeck-token: ${t}\nCookie: modeldeck_session=${encodeURIComponent(t)}\n`);'
mutation_command() {
  printf 'set -euo pipefail; set +x; set +a; unset pool_token_headers; pool_token_headers=$('
  quote "$SECURITY" find-generic-password -s modeldeck -a mutation-token -w
  printf '2>/dev/null | '; quote "$NODE" --input-type=module -e "$headers_js"
  printf '); printf "%%s\\n" "$pool_token_headers" | '; quote "$CURL" --disable --noproxy '*' --fail --silent --show-error --max-time 5 -X PUT "$DAEMON_URL/api/settings" -H @- -H 'Content-Type: application/json' --data "$1"
  printf ' >/dev/null'
}
# Unset removes an inherited export attribute; the new variable is shell-only.
unset pool_token_headers
pool_token_headers="$("$SECURITY" find-generic-password -s modeldeck -a mutation-token -w 2>/dev/null |
  "$NODE" --input-type=module -e "$headers_js")"
mutate() {
  printf '%s\n' "$pool_token_headers" |
    "$CURL" --disable --noproxy '*' --fail --silent --show-error --max-time 5 -X PUT "$DAEMON_URL/api/settings" -H @- -H 'Content-Type: application/json' --data "$1" >/dev/null
}
if [[ "$mode" == remote ]]; then
  for label in "$REBALANCE" "$SERVER"; do
    [[ -f "$LAUNCH_AGENTS_DIR/$label.plist" ]] || { printf 'Cannot restore %s: plist absent; nothing changed.\n' "$label" >&2; false; }
  done
fi
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

# Check every listener before changing settings, agents or files. An existing
# registered forwarder is also safe to replace/remove on repeated cutovers.
known_pids=' '
forwarder_loaded=false
for label in "$REBALANCE" "$SERVER" "$FORWARDER"; do
  if agent_status="$("$LAUNCHCTL" print "$DOMAIN/$label" 2>/dev/null)"; then
    if [[ "$label" == "$FORWARDER" ]]; then forwarder_loaded=true; fi
    if [[ "$agent_status" =~ pid[[:space:]]*=[[:space:]]*([0-9]+) ]]; then known_pids+="${BASH_REMATCH[1]} "; fi
  fi
done
if listeners="$("$LSOF" -nP -t -iTCP:8317 -sTCP:LISTEN 2>&1)"; then :
else
  code=$?
  [[ "$code" == 1 && -z "$listeners" ]] || { printf 'Cannot check port 8317; nothing changed.\n' >&2; false; }
fi
for pid in $listeners; do
  if [[ ! "$pid" =~ ^[0-9]+$ || "$known_pids" != *" $pid "* ]]; then
    program="PID $pid"
    details="$("$LSOF" -nP -a -p "$pid" -iTCP:8317 -sTCP:LISTEN -Fpc 2>/dev/null || true)"
    while IFS= read -r line; do [[ "$line" != c* ]] || program="${line#c}"; done <<< "$details"
    printf 'port 8317 is held by %s; if ModelDeck manages the proxy, open Settings → Managed proxy → Stop Managing, then re-run\n' "$program" >&2
    false
  fi
done
disabled="$("$LAUNCHCTL" print-disabled "$DOMAIN")"
is_disabled() { [[ "$disabled" =~ \"$1\"[[:space:]]*=\>[[:space:]]*(true|disabled) ]]; }
plist="$LAUNCH_AGENTS_DIR/$FORWARDER.plist"
if [[ -f "$plist" ]]; then
  backup_dir="$HOME/Library/Application Support/ModelDeck/pool-target-backups"
  mkdir -p "$backup_dir"
  chmod 700 "$backup_dir"
  backup="$("$MKTEMP" "$backup_dir/forwarder.XXXXXX")"
  "$CP" "$plist" "$backup"
elif [[ "$forwarder_loaded" == true ]]; then
  printf 'Loaded forwarder has no plist to restore; nothing changed.\n' >&2
  false
fi
restore_forwarder="if $(quote "$LAUNCHCTL" print "$DOMAIN/$FORWARDER") >/dev/null 2>&1; then $(quote "$LAUNCHCTL" bootout "$DOMAIN/$FORWARDER"); fi"
if [[ -n "$backup" ]]; then
  restore_forwarder+=$'\n'"$(quote "$CP" "$backup" "$plist")"
  if [[ "$forwarder_loaded" == true ]]; then restore_forwarder+=$'\n'"$(quote "$LAUNCHCTL" bootstrap "$DOMAIN" "$plist")"; fi
else
  restore_forwarder+=$'\n'"$(quote "$RM" -f "$plist")"
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
  for label in "$REBALANCE" "$SERVER"; do
    restore_job="$(quote "$LAUNCHCTL" enable "$DOMAIN/$label")"
    loaded=false
    if "$LAUNCHCTL" print "$DOMAIN/$label" >/dev/null 2>&1; then
      loaded=true
      restore_job+=$'\n'"if ! $(quote "$LAUNCHCTL" print "$DOMAIN/$label") >/dev/null 2>&1; then $(quote "$LAUNCHCTL" bootstrap "$DOMAIN" "$LAUNCH_AGENTS_DIR/$label.plist"); fi"
    fi
    if is_disabled "$label"; then restore_job+=$'\n'"$(quote "$LAUNCHCTL" disable "$DOMAIN/$label")"; fi
    undo+=("$restore_job")
    "$LAUNCHCTL" disable "$DOMAIN/$label"
    if [[ "$loaded" == true ]]; then "$LAUNCHCTL" bootout "$DOMAIN/$label"; fi
  done
  undo+=("$restore_forwarder")
  POOL_HOST_URL="$hub" PORT=8317 LAUNCHCTL="$LAUNCHCTL" LSOF="$LSOF" NODE="$NODE" LAUNCH_AGENTS_DIR="$LAUNCH_AGENTS_DIR" "$FORWARDER_DIR/launch-agent.sh" install
  wait_health
  undo+=("$(mutation_command "$previous")")
  mutate "$payload"
else
  if [[ "$daemon_up" == true ]]; then
    undo+=("$(mutation_command "$previous")")
    mutate "$payload"
  fi
  undo+=("$restore_forwarder")
  LAUNCHCTL="$LAUNCHCTL" LSOF="$LSOF" NODE="$NODE" LAUNCH_AGENTS_DIR="$LAUNCH_AGENTS_DIR" "$FORWARDER_DIR/launch-agent.sh" uninstall
  for label in "$SERVER" "$REBALANCE"; do
    if [[ -f "$LAUNCH_AGENTS_DIR/$label.plist" ]]; then
      if is_disabled "$label"; then undo+=("$(quote "$LAUNCHCTL" disable "$DOMAIN/$label")"); fi
      "$LAUNCHCTL" enable "$DOMAIN/$label"
      if ! "$LAUNCHCTL" print "$DOMAIN/$label" >/dev/null 2>&1; then
        "$LAUNCHCTL" bootstrap "$DOMAIN" "$LAUNCH_AGENTS_DIR/$label.plist"
        undo+=("$(quote "$LAUNCHCTL" bootout "$DOMAIN/$label")")
      fi
    fi
  done
  wait_health
  if [[ "$daemon_up" == true ]]; then
    "$NODE" "$SCRIPT_DIR/../tools/pool-forwarder/restore-local-keys.mjs" "$DAEMON_URL"
  else
    printf 'Local proxy restored; after the daemon returns, apply host settings and restore local profile keys:\n'
    retry="$(mutation_command "$payload")"
    retry+="; $(quote env "CURL=$CURL" "SECURITY=$SECURITY" "MANAGEMENT_KEY_FILE=${MANAGEMENT_KEY_FILE:-$HOME/.config/cliproxyapi/.mgmt-key}" "$NODE" "$SCRIPT_DIR/../tools/pool-forwarder/restore-local-keys.mjs" "$DAEMON_URL")"
    bash_command "$retry"; printf '\n'
  fi
fi
[[ -z "$backup" ]] || "$RM" -f "$backup"
if [[ "$daemon_up" == true ]]; then printf 'Pool target is now %s.\n' "$mode"; fi
