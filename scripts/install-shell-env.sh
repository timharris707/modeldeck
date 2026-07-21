#!/bin/sh
set -eu

target="${HOME}/.zshenv"
begin='# >>> ModelDeck Claude identity switching >>>'
end='# <<< ModelDeck Claude identity switching <<<'

if [ "${1:-}" = '--remove' ]; then
  [ -f "$target" ] || exit 0
  temporary="${target}.modeldeck.$$"
  awk -v begin="$begin" -v end="$end" '
    $0 == begin { skip = 1; next }
    $0 == end { skip = 0; next }
    !skip { print }
  ' "$target" > "$temporary"
  mv "$temporary" "$target"
  exit 0
fi

if [ "${1:-}" != '' ]; then
  echo 'usage: scripts/install-shell-env.sh [--remove]' >&2
  exit 2
fi

if [ -f "$target" ] && grep -Fq "$begin" "$target"; then
  exit 0
fi

{
  printf '\n%s\n' "$begin"
  printf '%s\n' 'export CLAUDE_SECURESTORAGE_CONFIG_DIR="$(readlink ~/.claude 2>/dev/null || true)"'
  printf '%s\n' "$end"
} >> "$target"
