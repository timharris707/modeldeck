#!/usr/bin/env bash
# release-dmg.sh — Issue #16: signed + notarized DMG release pipeline.
#
# Builds the ModelDeckMac release binary, assembles ModelDeck.app with the
# version stamped from the VERSION file (the release-tag authority; see
# Sources/ModelDeckMacCore/AppVersion.swift), signs with a Developer ID
# identity (hardened runtime + secure timestamp), notarizes and staples the
# app, packages it into dist/ModelDeck-<version>.dmg with an /Applications
# symlink, then signs, notarizes, and staples the DMG as well. Both layers
# are stapled so the app passes Gatekeeper even offline after being copied
# out of the DMG.
#
# Usage:
#   scripts/release-dmg.sh [--dry-run]
#
# Environment (names, never secret values):
#   MODELDECK_SIGNING_IDENTITY  codesign identity name. Default:
#                               "Developer ID Application: TIMOTHY G HARRIS (F66FM4V88Q)"
#   MODELDECK_NOTARY_PROFILE    notarytool keychain profile name.
#                               Default: "modeldeck-notary"
#
# The identity name and profile name are labels, not secrets; the private
# key and Apple credentials live only in the login keychain. This script
# never prints, exports, or copies credential material.
#
# Idempotent: every run rebuilds from scratch into dist/ and overwrites the
# previous artifacts for the same version.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_DIR="$REPO_ROOT/macos/ModelDeckMac"
DIST_DIR="$REPO_ROOT/dist"

IDENTITY="${MODELDECK_SIGNING_IDENTITY:-Developer ID Application: TIMOTHY G HARRIS (F66FM4V88Q)}"
NOTARY_PROFILE="${MODELDECK_NOTARY_PROFILE:-modeldeck-notary}"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "release-dmg.sh: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

fail() { echo "release-dmg.sh: ERROR: $*" >&2; exit 1; }

# ---------------------------------------------------------------- resolve
[[ -f "$REPO_ROOT/VERSION" ]] || fail "VERSION file not found at $REPO_ROOT/VERSION"
VERSION="$(tr -d '[:space:]' < "$REPO_ROOT/VERSION")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] \
  || fail "VERSION file content '$VERSION' is not a dotted version"

# Monotonic build number for CFBundleVersion (distinct from the marketing
# version): commit count on HEAD.
BUILD_NUMBER="$(git -C "$REPO_ROOT" rev-list --count HEAD 2>/dev/null || true)"
[[ -n "$BUILD_NUMBER" ]] || fail "could not derive build number from git (rev-list failed) — run from a git checkout"

APP="$DIST_DIR/ModelDeck.app"
DMG="$DIST_DIR/ModelDeck-$VERSION.dmg"
STAGING="$DIST_DIR/.dmg-staging"
NOTARY_ZIP="$DIST_DIR/.ModelDeck-notary-submit.zip"

echo "==> release-dmg.sh"
echo "    version:        $VERSION (build $BUILD_NUMBER)"
echo "    app bundle:     $APP"
echo "    dmg:            $DMG"
echo "    identity:       $IDENTITY"
echo "    notary profile: $NOTARY_PROFILE"

# ------------------------------------------------------------ preflight
security find-identity -v -p codesigning | grep -Fq "$IDENTITY" \
  || fail "signing identity not found in keychain: $IDENTITY"
xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 \
  || fail "notarytool profile '$NOTARY_PROFILE' missing or not accepted by Apple"
echo "==> preflight OK (identity present, notary profile accepted)"

if [[ "$DRY_RUN" == 1 ]]; then
  echo "==> dry run: would perform:"
  echo "    1. swift build -c release (package: $PACKAGE_DIR)"
  echo "    2. assemble $APP, stamp CFBundleShortVersionString=$VERSION CFBundleVersion=$BUILD_NUMBER"
  echo "    3. codesign --options runtime --timestamp with the identity above"
  echo "    4. notarize the app (zip -> notarytool submit --wait), staple the app"
  echo "    5. hdiutil create $DMG (app + /Applications symlink)"
  echo "    6. codesign the DMG, notarize (submit --wait), staple the DMG"
  echo "    7. verify: codesign --verify --deep --strict, spctl app + dmg"
  echo "==> dry run complete; nothing was built"
  exit 0
fi

mkdir -p "$DIST_DIR"

# ------------------------------------------------------------ 1. build
echo "==> swift build -c release"
swift build --package-path "$PACKAGE_DIR" -c release

BIN="$(swift build --package-path "$PACKAGE_DIR" -c release --show-bin-path)/ModelDeckMac"
[[ -x "$BIN" ]] || fail "built binary not found at $BIN"

# --------------------------------------------------------- 2. assemble
echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/ModelDeckMac"
cp "$PACKAGE_DIR/Support/Info.plist" "$APP/Contents/Info.plist"

echo "==> stamping version $VERSION (build $BUILD_NUMBER) into Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$APP/Contents/Info.plist"

# ------------------------------------------------------------- 3. sign
# Single Mach-O executable, no nested frameworks/helpers today; if nested
# code appears later, sign inside-out before the outer bundle.
echo "==> codesign app (hardened runtime, timestamp)"
codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

# ------------------------------------------- 4. notarize + staple app
echo "==> notarizing app (this waits on Apple; typically 1-5 minutes)"
rm -f "$NOTARY_ZIP"
ditto -c -k --keepParent "$APP" "$NOTARY_ZIP"
notarize() { # $1 = path
  local out id status
  out="$(xcrun notarytool submit "$1" --keychain-profile "$NOTARY_PROFILE" --wait 2>&1)" || true
  echo "$out"
  id="$(echo "$out" | awk '/^  id:/ {print $2; exit}')"
  status="$(echo "$out" | awk '/status: /{s=$2} END{print s}')"
  if [[ "$status" != "Accepted" ]]; then
    echo "release-dmg.sh: notarization FAILED (status: ${status:-unknown}, id: ${id:-unknown})" >&2
    if [[ -n "$id" ]]; then
      echo "---- notarytool log ----" >&2
      xcrun notarytool log "$id" --keychain-profile "$NOTARY_PROFILE" >&2 || true
    fi
    exit 1
  fi
  echo "==> notarization Accepted (id: $id)"
}
notarize "$NOTARY_ZIP"
rm -f "$NOTARY_ZIP"

echo "==> stapling app"
xcrun stapler staple "$APP"

# -------------------------------------------------------------- 5. dmg
echo "==> building $DMG"
rm -rf "$STAGING" "$DMG"
mkdir -p "$STAGING"
cp -R "$APP" "$STAGING/ModelDeck.app"
ln -s /Applications "$STAGING/Applications"
hdiutil create -volname "ModelDeck $VERSION" -srcfolder "$STAGING" -ov -format UDZO "$DMG"
rm -rf "$STAGING"

# ------------------------------------------- 6. sign + notarize + staple dmg
echo "==> codesign dmg"
codesign --force --timestamp --sign "$IDENTITY" "$DMG"

echo "==> notarizing dmg (second Apple round-trip)"
notarize "$DMG"

echo "==> stapling dmg"
xcrun stapler staple "$DMG"

# ------------------------------------------------------------ 7. verify
echo "==> verification"
codesign --verify --deep --strict --verbose=2 "$APP"
spctl -a -vv "$APP"
spctl -a -t open --context context:primary-signature -vv "$DMG"

echo "==> done: $DMG"
