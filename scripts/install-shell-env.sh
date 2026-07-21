#!/bin/sh
set -eu

target="${HOME}/.zshenv"
begin='# >>> ModelDeck Claude identity switching >>>'
end='# <<< ModelDeck Claude identity switching <<<'
# Issue #66: the daemon rewrites this snippet atomically at every account
# activation with CLAUDE_CONFIG_DIR and CLAUDE_SECURESTORAGE_CONFIG_DIR both
# pinned to the active profile's resolved real path (from ModelDeck's records,
# never a launch-time readlink). New terminal sessions are therefore
# insulated from later account switches. The generated block honors the same
# MODELDECK_CLAUDE_SHELL_ENV_FILE override the daemon reads (src/paths.mjs,
# CLAUDE_SHELL_ENV_FILE) so activation and shells always agree on one file;
# the default fallback must stay in sync with that module.

remove_block() {
  [ -f "$target" ] || return 0
  temporary="${target}.modeldeck.$$"
  awk -v begin="$begin" -v end="$end" '
    $0 == begin { skip = 1; next }
    $0 == end { skip = 0; next }
    !skip { print }
  ' "$target" > "$temporary"
  mv "$temporary" "$target"
}

if [ "${1:-}" = '--remove' ]; then
  remove_block
  exit 0
fi

if [ "${1:-}" != '' ]; then
  echo 'usage: scripts/install-shell-env.sh [--remove]' >&2
  exit 2
fi

if [ -f "$target" ] && grep -Fq 'ModelDeck/claude-env.sh' "$target"; then
  exit 0
fi

# Replace any earlier (readlink-based) ModelDeck block with the current one.
remove_block

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
