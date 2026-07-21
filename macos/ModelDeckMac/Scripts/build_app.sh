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

# SwiftPM resource bundle (issue #103: provider icons). Bundle.module resolves
# it via Bundle.main.resourceURL, so it must sit in Contents/Resources.
RESOURCE_BUNDLE="$(dirname "$BIN")/ModelDeckMac_ModelDeckMacCore.bundle"
[[ -d "$RESOURCE_BUNDLE" ]] || { echo "build_app.sh: resource bundle not found at $RESOURCE_BUNDLE" >&2; exit 1; }
cp -R "$RESOURCE_BUNDLE" "$APP/Contents/Resources/"

# Issue #96 (optional in dev): when a daemon binary has been built
# (scripts/build-daemon-binary.sh → dist/daemon/), stage it plus its
# manifest and the SMAppService agent plist so the first-run flow can be
# hand-tested from a dev bundle. Without it the app runs as a pure client
# and the first-run surface stays off.
REPO_ROOT="$(cd "$PACKAGE_DIR/../.." && pwd)"
if [[ -x "$REPO_ROOT/dist/daemon/modeldeckd" && -f "$REPO_ROOT/dist/daemon/manifest.json" ]]; then
  echo "==> staging bundled daemon from $REPO_ROOT/dist/daemon"
  mkdir -p "$APP/Contents/Resources/daemon" "$APP/Contents/Library/LaunchAgents"
  cp "$REPO_ROOT/dist/daemon/modeldeckd" "$APP/Contents/Resources/daemon/modeldeckd"
  chmod 755 "$APP/Contents/Resources/daemon/modeldeckd"
  cp "$REPO_ROOT/dist/daemon/manifest.json" "$APP/Contents/Resources/daemon/manifest.json"
  cp "$PACKAGE_DIR/Support/ai.hermes.modeldeck.plist" "$APP/Contents/Library/LaunchAgents/ai.hermes.modeldeck.plist"
fi

echo "==> codesign (identity: $IDENTITY)"
codesign --force --options runtime --sign "$IDENTITY" "$APP"
codesign --verify --deep "$APP"

echo "==> done: $APP"
