#!/bin/bash
# demo-daemon.sh — run a FULLY ISOLATED demo daemon for screenshots (issue #129).
#
# DEMO/DEV ONLY. Never use this for a real install. Everything — database,
# profile homes, active-provider links, projects — lives under one throwaway
# demo directory, on its own port. It must never touch:
#   - the live daemon on 127.0.0.1:3867
#   - ~/Library/Application Support/ModelDeck
#   - ~/.claude, ~/.codex, real profile homes, or the macOS Keychain
#
# Usage:
#   scripts/demo-daemon.sh /path/to/demo-dir [port]
#
# Seeds the demo roster (scripts/seed-demo.mjs — placeholder identities only)
# on first run, then starts the daemon in the foreground. Point the app at it
# with:  MODELDECK_PORT=<port> swift run ModelDeckMac
# Capture flow: docs/RELEASE.md "README screenshots".
set -euo pipefail

DEMO_DIR="${1:?usage: demo-daemon.sh /path/to/demo-dir [port]}"
PORT="${2:-4867}"

if [ "$PORT" = "3867" ]; then
  echo "refusing to run the demo daemon on 3867 — that port belongs to the live daemon" >&2
  exit 1
fi

mkdir -p "$DEMO_DIR"
# Resolve the PHYSICAL path (symlinks followed) before the live-directory
# check: a symlink like /tmp/demo -> ~/Library/Application Support/ModelDeck
# would pass a lexical comparison and then write fixtures into live data.
DEMO_DIR="$(cd -P "$DEMO_DIR" && pwd -P)"
LIVE_DATA_DIR="$HOME/Library/Application Support/ModelDeck"
LIVE_DATA_DIR_REAL="$(cd -P "$LIVE_DATA_DIR" 2>/dev/null && pwd -P || echo "$LIVE_DATA_DIR")"
case "$DEMO_DIR" in
  "$LIVE_DATA_DIR"|"$LIVE_DATA_DIR"/*|"$LIVE_DATA_DIR_REAL"|"$LIVE_DATA_DIR_REAL"/*)
    echo "refusing to use the live ModelDeck data directory for a demo" >&2
    exit 1
    ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Every path the daemon can read or write is pinned inside DEMO_DIR, and the
# Keychain lookup for the mutation token is skipped (an ephemeral per-process
# token is generated instead; the app authorizes via its /api/session cookie).
export MODELDECK_DATA_DIR="$DEMO_DIR"
# Pin the database explicitly: an inherited MODELDECK_DB_PATH overrides the
# DATA_DIR-derived default in src/paths.mjs and could point at a live DB.
export MODELDECK_DB_PATH="$DEMO_DIR/modeldeck.sqlite"
export MODELDECK_PORT="$PORT"
export MODELDECK_PROJECTS_ROOT="$DEMO_DIR/projects"
export MODELDECK_CLAUDE_PROFILES_DIR="$DEMO_DIR/claude-profiles"
export MODELDECK_CODEX_PROFILES_DIR="$DEMO_DIR/demo-profiles"
export MODELDECK_CLAUDE_ACTIVE_LINK="$DEMO_DIR/active-claude"
export MODELDECK_CODEX_ACTIVE_LINK="$DEMO_DIR/active-codex"
export MODELDECK_CLAUDE_SHELL_ENV_FILE="$DEMO_DIR/claude-env.sh"
export MODELDECK_SKIP_KEYCHAIN=1
# Fixture snapshots are authoritative: no provider refresh, no scheduler
# (src/service.mjs demoFixtures — placeholder accounts hold no credentials,
# so any real refresh could only fail and degrade the seeded healthy chips).
export MODELDECK_DEMO_FIXTURES=1

if [ ! -f "$DEMO_DIR/modeldeck.sqlite" ]; then
  echo "seeding demo roster into $DEMO_DIR"
  node "$REPO_ROOT/scripts/seed-demo.mjs"
fi

echo "demo daemon starting on 127.0.0.1:$PORT (data: $DEMO_DIR)"
exec node "$REPO_ROOT/src/server.mjs"
