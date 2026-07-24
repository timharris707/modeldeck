#!/bin/sh
set -eu

target="${HOME}/.zshenv"
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

if [ "${1:-}" = '--remove' ]; then
  remove_block "$begin" "$end"
  remove_block "$codex_begin" "$codex_end"
  exit 0
fi

if [ "${1:-}" != '' ]; then
  echo 'usage: scripts/install-shell-env.sh [--remove]' >&2
  exit 2
fi

if ! { [ -f "$target" ] && grep -Fq 'ModelDeck/claude-env.sh' "$target"; }; then
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

if ! { [ -f "$target" ] && grep -Fq "$codex_begin" "$target"; }; then
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
