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
# Installer window art (issue #69): the DMG carries a background image and a
# committed Finder .DS_Store (design/dmg/) that pins the drag-to-Applications
# layout — app icon left, arrow, /Applications right, sized window, hidden
# chrome. Regenerate with scripts/generate-dmg-background.swift and
# scripts/generate-dmg-ds-store.sh when the art or layout changes. The volume
# name is the FIXED string "ModelDeck" (not versioned): the .DS_Store's
# background reference is a Finder alias that records the volume name, so a
# per-version volname would orphan it.
#
# Usage:
#   scripts/release-dmg.sh [--dry-run] [--check-only] [--allow-dirty]
#                          [--ref <ref>]
#
# Environment (names, never secret values):
#   MD_SIGN_IDENTITY            codesign identity name. Required for signing;
#                               the committed default is a placeholder.
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
DAEMON_BINARY="$DIST_DIR/daemon/modeldeckd"
DAEMON_MANIFEST="$DIST_DIR/daemon/manifest.json"
# Issue #96: SMAppService agent definition registered by the app on first run.
AGENT_PLIST="$PACKAGE_DIR/Support/ai.hermes.modeldeck.plist"

fail() { echo "release-dmg.sh: ERROR: $*" >&2; exit 1; }
warn_override() {
  echo >&2
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
  echo "!! RELEASE SAFETY OVERRIDE: $*" >&2
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
  echo >&2
}

tracked_dirt() {
  git -C "$REPO_ROOT" status --porcelain --untracked-files=no -- \
    . ':(exclude)dist' ':(exclude)dist/**'
}

DEFAULT_IDENTITY="Developer ID Application: EXAMPLE DEVELOPER (TEAMID1234)"
IDENTITY="${MD_SIGN_IDENTITY:-$DEFAULT_IDENTITY}"
NOTARY_PROFILE="${MODELDECK_NOTARY_PROFILE:-modeldeck-notary}"

DRY_RUN=0
CHECK_ONLY=0
ALLOW_DIRTY=0
RELEASE_REF="origin/main"
REF_OVERRIDDEN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --check-only) CHECK_ONLY=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --ref)
      [[ $# -ge 2 ]] || fail "--ref requires a git ref"
      RELEASE_REF="$2"
      REF_OVERRIDDEN=1
      shift
      ;;
    -h|--help) awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) echo "release-dmg.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

# ------------------------------------------------ repository safety guard
git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 \
  || fail "$REPO_ROOT is not a git checkout"

echo "==> fetching origin for release provenance check"
git -C "$REPO_ROOT" fetch origin \
  || fail "git fetch origin failed; refusing to build from an unverified ref"

DIRTY_TRACKED="$(tracked_dirt)"
if [[ -n "$DIRTY_TRACKED" ]]; then
  if [[ "$ALLOW_DIRTY" == 1 ]]; then
    warn_override "--allow-dirty packages these tracked changes:"
    printf '%s\n' "$DIRTY_TRACKED" >&2
  else
    echo "release-dmg.sh: ERROR: tracked working-tree changes would be packaged:" >&2
    printf '%s\n' "$DIRTY_TRACKED" >&2
    echo "release-dmg.sh: commit/stash them, or use --allow-dirty explicitly" >&2
    exit 1
  fi
elif [[ "$ALLOW_DIRTY" == 1 ]]; then
  warn_override "--allow-dirty was supplied (the tracked tree is currently clean)"
fi

if [[ "$REF_OVERRIDDEN" == 1 ]]; then
  warn_override "--ref overrides origin/main; requiring HEAD == $RELEASE_REF"
fi
EXPECTED_COMMIT="$(git -C "$REPO_ROOT" rev-parse --verify "${RELEASE_REF}^{commit}" 2>/dev/null)" \
  || fail "release ref '$RELEASE_REF' does not resolve to a commit"
GIT_COMMIT="$(git -C "$REPO_ROOT" rev-parse --verify HEAD)" \
  || fail "could not resolve HEAD"
if [[ "$GIT_COMMIT" != "$EXPECTED_COMMIT" ]]; then
  fail "HEAD ($GIT_COMMIT) is not $RELEASE_REF ($EXPECTED_COMMIT); use --ref <ref> only for an intentional release override"
fi

echo "==> repository guard OK"
echo "    packaged commit: $GIT_COMMIT"
echo "    required ref:    $RELEASE_REF"

if [[ "$CHECK_ONLY" == 1 ]]; then
  echo "==> check-only complete; signing and build steps were not run"
  echo "    release assembly will require: $DAEMON_BINARY"
  exit 0
fi

[[ -x "$DAEMON_BINARY" ]] \
  || fail "daemon binary missing or not executable: $DAEMON_BINARY (run scripts/build-daemon-binary.sh first)"
[[ -f "$DAEMON_MANIFEST" ]] \
  || fail "daemon manifest missing: $DAEMON_MANIFEST (run scripts/build-daemon-binary.sh first; the app's drift check needs it)"
[[ -f "$AGENT_PLIST" ]] \
  || fail "SMAppService agent plist missing: $AGENT_PLIST"

if [[ "$IDENTITY" == "$DEFAULT_IDENTITY" ]]; then
  fail "the signing identity is still the placeholder; set MD_SIGN_IDENTITY before signing"
fi

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
echo "    git commit:     $GIT_COMMIT"
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
  echo "    2. assemble $APP, stage $DAEMON_BINARY in Contents/Resources/daemon/, stamp CFBundleShortVersionString=$VERSION CFBundleVersion=$BUILD_NUMBER"
  echo "    3. codesign the nested modeldeckd binary, then the app, with --options runtime --timestamp and the identity above"
  echo "    4. notarize the app (zip -> notarytool submit --wait), staple the app"
  echo "    5. hdiutil create $DMG (app + /Applications symlink + installer background/layout from design/dmg)"
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

# The 0.2.1 near-miss came from a concurrent session editing the shared
# checkout; the multi-minute build reopens that window, so re-verify the
# tree before anything gets packaged and signed.
if [[ "$ALLOW_DIRTY" != 1 ]]; then
  POST_BUILD_DIRT="$(tracked_dirt)"
  if [[ -n "$POST_BUILD_DIRT" ]]; then
    echo "release-dmg.sh: ERROR: tracked files changed during the build:" >&2
    printf '%s\n' "$POST_BUILD_DIRT" >&2
    exit 1
  fi
  [[ "$(git -C "$REPO_ROOT" rev-parse --verify HEAD)" == "$GIT_COMMIT" ]] \
    || fail "HEAD moved during the build; refusing to package a moving target"
fi

# --------------------------------------------------------- 2. assemble
APP_ICON="$REPO_ROOT/design/icon/ModelDeck.icns"
[[ -f "$APP_ICON" ]] || fail "app icon missing: $APP_ICON (swift scripts/generate-app-icon.swift)"

echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/daemon"
cp "$BIN" "$APP/Contents/MacOS/ModelDeckMac"
cp "$PACKAGE_DIR/Support/Info.plist" "$APP/Contents/Info.plist"
# App icon (issue #82); Info.plist's CFBundleIconFile names "ModelDeck".
cp "$APP_ICON" "$APP/Contents/Resources/ModelDeck.icns"
# SwiftPM resource bundle (issue #103: provider icons). Bundle.module resolves
# it via Bundle.main.resourceURL, so it must sit in Contents/Resources.
RESOURCE_BUNDLE="$(dirname "$BIN")/ModelDeckMac_ModelDeckMacCore.bundle"
[[ -d "$RESOURCE_BUNDLE" ]] || fail "SwiftPM resource bundle not found at $RESOURCE_BUNDLE"
cp -R "$RESOURCE_BUNDLE" "$APP/Contents/Resources/"
cp "$DAEMON_BINARY" "$APP/Contents/Resources/daemon/modeldeckd"
chmod 755 "$APP/Contents/Resources/daemon/modeldeckd"
# Issue #96: the manifest travels with the binary — the app compares its
# MDGitCommit against the registered-version marker to re-register on drift.
cp "$DAEMON_MANIFEST" "$APP/Contents/Resources/daemon/manifest.json"
# SMAppService agent definition; BundleProgram points at the daemon above.
mkdir -p "$APP/Contents/Library/LaunchAgents"
cp "$AGENT_PLIST" "$APP/Contents/Library/LaunchAgents/ai.hermes.modeldeck.plist"
plutil -lint "$APP/Contents/Library/LaunchAgents/ai.hermes.modeldeck.plist" >/dev/null

echo "==> stamping version $VERSION (build $BUILD_NUMBER), commit $GIT_COMMIT into Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :MDGitCommit $GIT_COMMIT" "$APP/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :MDGitCommit string $GIT_COMMIT" "$APP/Contents/Info.plist"

# ------------------------------------------------------------- 3. sign
# Sign nested code inside-out. The daemon build's ad-hoc signature is replaced
# here with the same Developer ID identity used for the outer app.
echo "==> codesign embedded modeldeckd (hardened runtime, timestamp)"
codesign --force --options runtime --timestamp \
  --entitlements "$REPO_ROOT/scripts/daemon-entitlements.plist" --sign "$IDENTITY" \
  "$APP/Contents/Resources/daemon/modeldeckd"
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
DMG_ART_DIR="$REPO_ROOT/design/dmg"
DMG_BACKGROUND="$DMG_ART_DIR/modeldeck-installer-bg.png"
DMG_DS_STORE="$DMG_ART_DIR/DS_Store"
[[ -f "$DMG_BACKGROUND" ]] || fail "DMG background art missing: $DMG_BACKGROUND (swift scripts/generate-dmg-background.swift)"
[[ -f "$DMG_DS_STORE" ]] || fail "DMG layout .DS_Store missing: $DMG_DS_STORE (scripts/generate-dmg-ds-store.sh)"

echo "==> building $DMG"
rm -rf "$STAGING" "$DMG"
mkdir -p "$STAGING/.background"
cp -R "$APP" "$STAGING/ModelDeck.app"
ln -s /Applications "$STAGING/Applications"
cp "$DMG_BACKGROUND" "$STAGING/.background/modeldeck-installer-bg.png"
cp "$DMG_DS_STORE" "$STAGING/.DS_Store"
# DMG volume icon (issue #82): .VolumeIcon.icns plus the custom-icon Finder
# attribute on the staging folder, which hdiutil -srcfolder carries onto the
# volume root. Best-effort: skip quietly if SetFile (Xcode tools) is absent.
cp "$APP_ICON" "$STAGING/.VolumeIcon.icns"
if command -v SetFile >/dev/null 2>&1; then
  SetFile -a C "$STAGING"
else
  echo "==> note: SetFile not found; DMG volume icon attribute not set"
fi
# HFS+ explicitly: the committed .DS_Store layout was captured on HFS+, and
# APFS default DMGs are fine too, but keep the filesystem stable so the
# layout never silently shifts under a macOS default change.
hdiutil create -volname "ModelDeck" -srcfolder "$STAGING" -ov -format UDZO \
  -fs HFS+ "$DMG"
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
