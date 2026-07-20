#!/usr/bin/env bash
# Assemble and sign ModelDeck.app from the SwiftPM build (PanelyMac
# scripts/build_macos_app pattern, trimmed for Phase 3).
#
# Usage: Scripts/build_app.sh [--release]
#
# Signing: ad-hoc ("-") by default so the bundle runs locally. Set
# MODELDECK_SIGNING_IDENTITY to a keychain identity for a stable code
# identity (needed for TCC/launch-at-login decisions to stick across
# rebuilds).
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIGURATION="debug"
if [[ "${1:-}" == "--release" ]]; then
  CONFIGURATION="release"
fi

DIST_DIR="$PACKAGE_DIR/dist"
APP="$DIST_DIR/ModelDeck.app"
IDENTITY="${MODELDECK_SIGNING_IDENTITY:--}"

echo "==> swift build -c $CONFIGURATION"
swift build --package-path "$PACKAGE_DIR" -c "$CONFIGURATION"

BIN="$(swift build --package-path "$PACKAGE_DIR" -c "$CONFIGURATION" --show-bin-path)/ModelDeckMac"
[[ -x "$BIN" ]] || { echo "build_app.sh: built binary not found at $BIN" >&2; exit 1; }

echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/ModelDeckMac"
cp "$PACKAGE_DIR/Support/Info.plist" "$APP/Contents/Info.plist"

echo "==> codesign (identity: $IDENTITY)"
codesign --force --options runtime --sign "$IDENTITY" "$APP"
codesign --verify --deep "$APP"

echo "==> done: $APP"
