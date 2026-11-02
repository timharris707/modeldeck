#!/bin/sh
set -eu

# The block is written for macOS paths and zsh. On Linux (#806) ModelDeck does
# not switch the default homes; start sessions with `modeldeck launch`, which
# pins the profile itself.
if [ "$(uname -s)" != Darwin ]; then
  echo 'install-shell-env.sh is macOS-only; on Linux start sessions with: modeldeck launch claude|codex' >&2
  exit 1
fi

target="${MODELDECK_ZSHENV_PATH:-${HOME}/.zshenv}"
script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
begin='# >>> ModelDeck Claude identity switching >>>'
end='# <<< ModelDeck Claude identity switching <<<'
codex_begin='# >>> ModelDeck Codex identity switching >>>'
codex_end='# <<< ModelDeck Codex identity switching <<<'
# Issue #66: the daemon rewrites this snippet atomically at every account
# activation with CLAUDE_CONFIG_DIR and CLAUDE_SECURESTORAGE_CONFIG_DIR both
# pinned to the active profile's resolved real path (from ModelDeck's records,
# never a launch-time readlink). New terminal sessions are therefore
# insulated from later account switches. The generated block honors the same
# MODELDECK_CLAUDE_SHELL_ENV_FILE override the daemon reads (src/paths.mjs,
# CLAUDE_SHELL_ENV_FILE) so activation and shells always agree on one file;
# the default fallback must stay in sync with that module.
#
# Issue #161: the Codex block freezes each terminal's CODEX_HOME to the
# profile the ~/.codex symlink pointed at when the terminal opened. Without
# it, `codex login` resolves the symlink at invocation time, so a login
# intended for one profile lands in whichever profile is active at that
# instant — overwriting that profile's auth.json (the #108 duplicate
# genesis). An already-exported CODEX_HOME always wins (per-profile launch
# commands — issue #106 — set it explicitly), and a missing symlink means no
# export, preserving stock Codex behavior.

remove_block() {
  # $1 = begin marker, $2 = end marker
  [ -f "$target" ] || return 0
  temporary="${target}.modeldeck.$$"
  awk -v begin="$1" -v end="$2" '
    $0 == begin { skip = 1; next }
    $0 == end { skip = 0; next }
    !skip { print }
  ' "$target" > "$temporary"
  mv "$temporary" "$target"
}

if [ "${1:-}" != '' ] && [ "${1:-}" != '--remove' ]; then
  echo 'usage: scripts/install-shell-env.sh [--remove]' >&2
  exit 2
fi

# An explicit setting wins. Before the first decision, only an existing
# ModelDeck-owned symlink proves this is an older managed installation.
provider_managed() {
  provider="$1"
  active_link="$2"
  profiles_dir="$3"
  data_dir="${MODELDECK_DATA_DIR:-$HOME/Library/Application Support/ModelDeck}"
  database="${MODELDECK_DB_PATH:-$data_dir/modeldeck.sqlite}"
  if [ -e "$database" ]; then
    # Reuse the daemon's read-only WAL snapshot; SQLite's ordinary read-only
    # open can still create shared-memory sidecars before refusing a request.
    decision=$(node --input-type=module - "$database" "$provider" "$script_dir/../src/db.mjs" <<'JS'
import { pathToFileURL } from 'node:url';
const { Store } = await import(pathToFileURL(process.argv[4]));
const store = new Store(process.argv[2], { readOnly: true });
try {
  const value = store.getSettings()[`${process.argv[3]}Managed`];
  process.stdout.write(value === true ? '1' : value === false ? '0' : '');
} finally { store.close(); }
JS
    ) || return 1
    case "$decision" in
      1) return 0 ;;
      '') ;;
      *) return 1 ;;
    esac
  fi
  [ -L "$active_link" ] && [ -d "$profiles_dir" ] || return 1
  resolved=$(CDPATH='' cd -P "$active_link" && pwd -P) || return 1
  root=$(CDPATH='' cd -P "$profiles_dir" && pwd -P) || return 1
  case "$resolved" in "$root"/*) return 0 ;; *) return 1 ;; esac
}

claude_managed=false
codex_managed=false
provider_managed claude "${MODELDECK_CLAUDE_ACTIVE_LINK:-$HOME/.claude}" "${MODELDECK_CLAUDE_PROFILES_DIR:-${MODELDECK_DATA_DIR:-$HOME/Library/Application Support/ModelDeck}/claude-profiles}" && claude_managed=true
provider_managed codex "${MODELDECK_CODEX_ACTIVE_LINK:-$HOME/.codex}" "${MODELDECK_CODEX_PROFILES_DIR:-$HOME/.codex-profiles}" && codex_managed=true
if [ "$claude_managed" = false ] && [ "$codex_managed" = false ]; then
  echo 'not-managed (409): ModelDeck does not manage these home folders. Turn on Manage account switching in Settings first.' >&2
  exit 1
fi
if [ -L "$target" ]; then
  echo 'The shell configuration must be a real file.' >&2
  exit 1
fi

if [ "${1:-}" = '--remove' ]; then
  if [ "$claude_managed" = true ]; then remove_block "$begin" "$end"; fi
  if [ "$codex_managed" = true ]; then remove_block "$codex_begin" "$codex_end"; fi
  exit 0
fi

if [ "$claude_managed" = true ] && ! { [ -f "$target" ] && grep -Fq 'ModelDeck/claude-env.sh' "$target"; }; then
  # Replace any earlier (readlink-based) ModelDeck block with the current one.
  remove_block "$begin" "$end"

  {
    printf '\n%s\n' "$begin"
    printf '%s\n' '_modeldeck_claude_env="${MODELDECK_CLAUDE_SHELL_ENV_FILE:-$HOME/Library/Application Support/ModelDeck/claude-env.sh}"'
    printf '%s\n' 'if [ -f "$_modeldeck_claude_env" ]; then'
    printf '%s\n' '  . "$_modeldeck_claude_env"'
    printf '%s\n' 'else'
    # Pre-first-activation fallback: keep the legacy secure-storage scope
    # derived from the active symlink so scoping never regresses. It does not
    # pin CLAUDE_CONFIG_DIR — only the daemon-written snippet can pin new
    # sessions to a path recorded at activation time.
    printf '%s\n' '  export CLAUDE_SECURESTORAGE_CONFIG_DIR="$(readlink ~/.claude 2>/dev/null || true)"'
    printf '%s\n' 'fi'
    printf '%s\n' 'unset _modeldeck_claude_env'
    printf '%s\n' "$end"
  } >> "$target"
fi

if [ "$codex_managed" = true ] && ! { [ -f "$target" ] && grep -Fq "$codex_begin" "$target"; }; then
  {
    printf '\n%s\n' "$codex_begin"
    # Respect an explicit CODEX_HOME (per-profile launch commands, #106).
    printf '%s\n' 'if [ -z "${CODEX_HOME:-}" ]; then'
    # Resolve the active-profile symlink exactly once, at terminal open.
    # No symlink (real directory or nothing at ~/.codex) → no export →
    # stock Codex behavior.
    printf '%s\n' '  _modeldeck_codex_home="$(readlink ~/.codex 2>/dev/null || true)"'
    printf '%s\n' '  if [ -n "$_modeldeck_codex_home" ]; then'
    # readlink may return a target relative to the symlink's directory
    # ($HOME); anchor it there so the export is always absolute.
    printf '%s\n' '    case "$_modeldeck_codex_home" in'
    printf '%s\n' '      /*) ;;'
    printf '%s\n' '      *) _modeldeck_codex_home="$HOME/$_modeldeck_codex_home" ;;'
    printf '%s\n' '    esac'
    printf '%s\n' '    export CODEX_HOME="$_modeldeck_codex_home"'
    printf '%s\n' '  fi'
    printf '%s\n' '  unset _modeldeck_codex_home'
    printf '%s\n' 'fi'
    printf '%s\n' "$codex_end"
  } >> "$target"
fi
