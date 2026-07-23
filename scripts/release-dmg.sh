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
# Appcast (issue #121, Sparkle 2 in-app updates): after the DMG is stapled,
# the script generates dist/appcast.xml — EdDSA-signed via Sparkle's
# sign_update (private key in the login Keychain from Tim's one-time
# generate_keys run; never in the repo) — and stamps the Sparkle PUBLIC key
# into the app's Info.plist (SUPublicEDKey) before signing. Publish BOTH the
# DMG and appcast.xml as assets on the version's GitHub release; the app's
# SUFeedURL points at the stable releases/latest/download/appcast.xml
# redirect.
#
# Usage:
#   scripts/release-dmg.sh [--dry-run] [--check-only] [--allow-dirty]
#                          [--ref <ref>]
#   scripts/release-dmg.sh --appcast-only <dmg>
#       Regenerate only the appcast for an existing ModelDeck-<ver>.dmg
#       (written beside it). No git guard, no identities — this is also the
#       test hook: inject MD_SPARKLE_SIGN_UPDATE (+ MD_SPARKLE_KEY_FILE with
#       the fake fixture key) to verify the step without real credentials.
#
# Environment (names, never secret values):
#   MD_SIGN_IDENTITY            codesign identity name. Required for signing;
#                               the committed default is a placeholder.
#   MODELDECK_NOTARY_PROFILE    notarytool keychain profile name.
#                               Default: "modeldeck-notary"
#   MD_SPARKLE_SIGN_UPDATE      path to Sparkle's sign_update tool. Default:
#                               auto-located in the SwiftPM artifacts dir.
#   MD_SPARKLE_KEY_FILE         EdDSA private key FILE for sign_update -f.
#                               TESTS ONLY (fake fixture key) — real releases
#                               leave it unset so the Keychain key is used.
#   MD_SPARKLE_PUBLIC_ED_KEY    Sparkle EdDSA PUBLIC key for Info.plist.
#                               Default: derived via `generate_keys -p`.
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

# ------------------------------------------------- Sparkle appcast helpers
# Issue #121. sign_update ships inside the resolved SwiftPM Sparkle artifact;
# the private key lives ONLY in the login Keychain (generate_keys, one-time).
SPARKLE_ONE_TIME_HELP="Sparkle EdDSA key setup (ONE TIME, on the release Mac):
  1. swift package resolve --package-path $PACKAGE_DIR
  2. run the generate_keys tool from the resolved artifact:
       find $PACKAGE_DIR/.build/artifacts -type f -name generate_keys
     -> stores the private key in the login Keychain (item 'Private key for signing Sparkle updates').
  3. generate_keys -p prints the PUBLIC key (for Info.plist SUPublicEDKey stamping).
Never copy the private key into the repo, environment files, or scripts."

locate_sign_update() {
  if [[ -n "${MD_SPARKLE_SIGN_UPDATE:-}" ]]; then
    echo "$MD_SPARKLE_SIGN_UPDATE"
    return
  fi
  # `|| true`: in a pristine worktree .build/artifacts does not exist yet, so
  # find exits nonzero; under pipefail that status escapes through the
  # callers' command substitutions and set -e kills the script with NO
  # message, before the intended loud "tool not found" fail. Empty output is
  # the not-found signal — the callers check for it.
  find "$PACKAGE_DIR/.build/artifacts" -type f -name sign_update 2>/dev/null | head -1 || true
}

# Generates <dir-of-dmg>/appcast.xml for a ModelDeck-<version>.dmg.
# $1 = dmg path, $2 = sparkle build number (CFBundleVersion).
generate_appcast() {
  local dmg="$1" build="$2" version base sign_update out
  base="$(basename "$dmg")"
  version="${base#ModelDeck-}"; version="${version%.dmg}"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] \
    || fail "cannot derive a version from DMG name '$base' (expected ModelDeck-<version>.dmg)"
  sign_update="$(locate_sign_update)"
  [[ -n "$sign_update" && -x "$sign_update" ]] || fail "Sparkle sign_update tool not found (set MD_SPARKLE_SIGN_UPDATE or resolve SwiftPM packages).
$SPARKLE_ONE_TIME_HELP"
  out="$(cd "$(dirname "$dmg")" && pwd)/appcast.xml"
  local key_args=()
  # TESTS ONLY: an injected key FILE (fake fixture). Real releases use the
  # Keychain — sign_update's default — and fail loudly when it is absent.
  if [[ -n "${MD_SPARKLE_KEY_FILE:-}" ]]; then
    key_args=(--key-file "$MD_SPARKLE_KEY_FILE")
  fi
  node "$REPO_ROOT/scripts/generate-appcast.mjs" \
    --version "$version" \
    --build "$build" \
    --dmg "$dmg" \
    --url "https://github.com/timharris707/modeldeck/releases/download/v$version/ModelDeck-$version.dmg" \
    --release-notes-url "https://github.com/timharris707/modeldeck/releases/tag/v$version" \
    --sign-update "$sign_update" \
    "${key_args[@]+"${key_args[@]}"}" \
    --out "$out" \
    || fail "appcast generation failed.
$SPARKLE_ONE_TIME_HELP"
  echo "==> appcast written: $out"
}

DRY_RUN=0
CHECK_ONLY=0
ALLOW_DIRTY=0
APPCAST_ONLY=""
RELEASE_REF="origin/main"
REF_OVERRIDDEN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --check-only) CHECK_ONLY=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --appcast-only)
      [[ $# -ge 2 ]] || fail "--appcast-only requires a DMG path"
      APPCAST_ONLY="$2"
      shift
      ;;
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

# --------------------------------------- appcast-only mode (issue #121)
# Regenerates the feed for an already-built DMG. Deliberately BEFORE the
# repository guard: no build, no signing identities, no git required — this
# is the test hook for the new release step.
if [[ -n "$APPCAST_ONLY" ]]; then
  [[ -f "$APPCAST_ONLY" ]] || fail "DMG not found: $APPCAST_ONLY"
  BUILD_NUMBER="$(git -C "$REPO_ROOT" rev-list --count HEAD 2>/dev/null || echo 0)"
  generate_appcast "$APPCAST_ONLY" "$BUILD_NUMBER"
  exit 0
fi

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

# A pristine release worktree has no .build/artifacts until SwiftPM has
# resolved packages, so the Sparkle tools below genuinely cannot exist yet
# (the v0.3.2 release hit exactly this). Resolve first so the preflight
# checks the real post-resolve state instead of failing on a fresh checkout.
if [[ ! -d "$PACKAGE_DIR/.build/artifacts" ]]; then
  echo "==> swift package resolve (SwiftPM artifacts not present yet)"
  swift package resolve --package-path "$PACKAGE_DIR" \
    || fail "swift package resolve failed — cannot locate the Sparkle tools for the preflight"
fi

# Issue #121: the Sparkle EdDSA PUBLIC key must be stamped into the app's
# Info.plist (SUPublicEDKey) or shipped updates can never verify. Explicit
# env wins; otherwise derive it from the Keychain via generate_keys -p.
# `|| true` on the find pipeline for the same reason as locate_sign_update:
# a missing artifacts dir must reach the loud fail below, not a silent exit.
SPARKLE_PUBLIC_KEY="${MD_SPARKLE_PUBLIC_ED_KEY:-}"
if [[ -z "$SPARKLE_PUBLIC_KEY" ]]; then
  GENERATE_KEYS="$(find "$PACKAGE_DIR/.build/artifacts" -type f -name generate_keys 2>/dev/null | head -1 || true)"
  if [[ -n "$GENERATE_KEYS" && -x "$GENERATE_KEYS" ]]; then
    SPARKLE_PUBLIC_KEY="$("$GENERATE_KEYS" -p 2>/dev/null | tail -1 | tr -d '[:space:]')" || true
  fi
fi
[[ -n "$SPARKLE_PUBLIC_KEY" ]] || fail "Sparkle public key unavailable (no MD_SPARKLE_PUBLIC_ED_KEY and generate_keys -p produced nothing).
$SPARKLE_ONE_TIME_HELP"
SIGN_UPDATE_TOOL="$(locate_sign_update)"
[[ -n "$SIGN_UPDATE_TOOL" && -x "$SIGN_UPDATE_TOOL" ]] \
  || fail "Sparkle sign_update tool not found — the appcast step would fail after notarization; resolve SwiftPM packages first.
$SPARKLE_ONE_TIME_HELP"
echo "==> preflight OK (identity present, notary profile accepted, Sparkle key + sign_update present)"

if [[ "$DRY_RUN" == 1 ]]; then
  echo "==> dry run: would perform:"
  echo "    1. swift build -c release (package: $PACKAGE_DIR)"
  echo "    2. assemble $APP, stage $DAEMON_BINARY in Contents/Resources/daemon/, stamp CFBundleShortVersionString=$VERSION CFBundleVersion=$BUILD_NUMBER"
  echo "    3. codesign the nested modeldeckd binary, then the app, with --options runtime --timestamp and the identity above"
  echo "    4. notarize the app (zip -> notarytool submit --wait), staple the app"
  echo "    5. hdiutil create $DMG (app + /Applications symlink + installer background/layout from design/dmg)"
  echo "    6. codesign the DMG, notarize (submit --wait), staple the DMG"
  echo "    7. verify: codesign --verify --deep --strict, spctl app + dmg"
  echo "    8. generate dist/appcast.xml (EdDSA signature via sign_update; key from the login Keychain)"
  echo "    NB: step 2 also embeds Sparkle.framework in Contents/Frameworks and stamps SUPublicEDKey"
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
PACKAGED_BUNDLE="$APP/Contents/Resources/ModelDeckMac_ModelDeckMacCore.bundle"
# Issue #151 belt-and-braces: Package.swift's defaultLocalization makes
# SwiftPM generate the bundle's Info.plist; if a toolchain change ever drops
# it again, synthesize a minimal plist here rather than package a directory
# Bundle(url:) rejects (the v0.3.3 SIGTRAP). The preflight below still
# fails the release if neither path produced a printable plist.
if [[ ! -f "$PACKAGED_BUNDLE/Info.plist" && ! -f "$PACKAGED_BUNDLE/Contents/Info.plist" ]]; then
  echo "==> WARNING: SwiftPM emitted no Info.plist in the resource bundle; synthesizing a minimal one (issue #151)"
  /usr/libexec/PlistBuddy \
    -c "Add :CFBundleIdentifier string app.modeldeck.mac.ModelDeckMacCore.resources" \
    -c "Add :CFBundleName string ModelDeckMac_ModelDeckMacCore" \
    -c "Add :CFBundlePackageType string BNDL" \
    -c "Add :CFBundleDevelopmentRegion string en" \
    "$PACKAGED_BUNDLE/Info.plist" >/dev/null \
    || fail "could not synthesize the resource bundle Info.plist"
fi
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

# Issue #121: Sparkle. Embed the framework the SwiftPM build linked against
# and stamp the PUBLIC EdDSA key (the app refuses to build its updater
# without SUFeedURL + SUPublicEDKey — dev bundles stay updater-less).
SPARKLE_FRAMEWORK="$(dirname "$BIN")/Sparkle.framework"
[[ -d "$SPARKLE_FRAMEWORK" ]] || fail "Sparkle.framework not found beside the built binary at $SPARKLE_FRAMEWORK"
echo "==> embedding Sparkle.framework + stamping SUPublicEDKey"
mkdir -p "$APP/Contents/Frameworks"
cp -R "$SPARKLE_FRAMEWORK" "$APP/Contents/Frameworks/"
# The SwiftPM binary references @rpath/Sparkle.framework/... with an rpath
# pointing into .build; make the bundle self-contained and drop the
# build-dir rpath so the shipped app can never resolve outside itself.
APP_MAIN_BIN="$APP/Contents/MacOS/ModelDeckMac"
BUILD_RPATH="$(dirname "$BIN")"
if ! otool -l "$APP_MAIN_BIN" | grep -q "path @executable_path/../Frameworks "; then
  install_name_tool -add_rpath "@executable_path/../Frameworks" "$APP_MAIN_BIN" \
    || fail "could not add the Frameworks rpath to the app binary"
fi
if otool -l "$APP_MAIN_BIN" | grep -q "path $BUILD_RPATH "; then
  install_name_tool -delete_rpath "$BUILD_RPATH" "$APP_MAIN_BIN" \
    || fail "could not remove the build-dir rpath from the app binary"
fi
otool -l "$APP_MAIN_BIN" | grep -q "path @executable_path/../Frameworks " \
  || fail "app binary lacks the Frameworks rpath after cleanup"
if otool -l "$APP_MAIN_BIN" | grep -q "path $BUILD_RPATH "; then
  fail "build-dir rpath still present in the app binary after cleanup"
fi
/usr/libexec/PlistBuddy -c "Set :SUPublicEDKey $SPARKLE_PUBLIC_KEY" "$APP/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :SUPublicEDKey string $SPARKLE_PUBLIC_KEY" "$APP/Contents/Info.plist"

# --------------------------------- resource-bundle preflight (issue #151)
# v0.3.3 shipped ModelDeckMac_ModelDeckMacCore.bundle as loose PNGs with NO
# Info.plist; macOS Bundle(url:) rejected the directory, the generated
# Bundle.module accessor exhausted its candidates, and the app trapped
# (SIGTRAP) on the first popover open — 100% repro in the field (public
# report modeldeck#1). Refuse to sign a bundle that would trap: the plist
# must EXIST (NB: `PlistBuddy -c Print` on a missing path happily CREATES
# an empty file and exits 0, so existence is checked explicitly first) and
# print, and every provider PNG that Bundle.module serves must be present.
echo "==> resource bundle preflight (issue #151: Info.plist + provider icons)"
BUNDLE_PLIST=""
for candidate in "$PACKAGED_BUNDLE/Info.plist" "$PACKAGED_BUNDLE/Contents/Info.plist"; do
  if [[ -f "$candidate" ]]; then BUNDLE_PLIST="$candidate"; break; fi
done
[[ -n "$BUNDLE_PLIST" ]] \
  || fail "resource bundle has NO Info.plist (flat or Contents/ layout): $PACKAGED_BUNDLE
Bundle.module would trap (SIGTRAP) on first popover open — the v0.3.3 field crash.
Check defaultLocalization in macos/ModelDeckMac/Package.swift and the synthesis step above."
/usr/libexec/PlistBuddy -c Print "$BUNDLE_PLIST" >/dev/null \
  || fail "resource bundle Info.plist does not print via PlistBuddy: $BUNDLE_PLIST
A malformed plist makes Bundle(url:) reject the bundle and Bundle.module trap (issue #151)."
for png in provider-claude-32.png provider-claude-64.png provider-claude-128.png \
           provider-codex-32.png provider-codex-64.png provider-codex-128.png; do
  [[ -f "$PACKAGED_BUNDLE/$png" || -f "$PACKAGED_BUNDLE/Contents/Resources/$png" ]] \
    || fail "resource bundle is missing provider icon $png (issue #103 artwork): $PACKAGED_BUNDLE"
done
echo "==> resource bundle preflight OK ($BUNDLE_PLIST prints; all 6 provider PNGs present)"

# ------------------------------------------------------------- 3. sign
# Sign nested code inside-out. The daemon build's ad-hoc signature is replaced
# here with the same Developer ID identity used for the outer app.
echo "==> codesign embedded modeldeckd (hardened runtime, timestamp)"
codesign --force --options runtime --timestamp \
  --entitlements "$REPO_ROOT/scripts/daemon-entitlements.plist" --sign "$IDENTITY" \
  "$APP/Contents/Resources/daemon/modeldeckd"
# Issue #121: re-sign Sparkle's nested executables with OUR Developer ID
# (hardened runtime — notarization requires every nested Mach-O to carry
# it). Sparkle's documented non-sandboxed order: Autoupdate, Updater.app,
# then the framework itself. --preserve-metadata keeps Sparkle's own
# entitlements on its helpers.
SPARKLE_EMBEDDED="$APP/Contents/Frameworks/Sparkle.framework"
echo "==> codesign embedded Sparkle.framework (hardened runtime, timestamp)"
codesign --force --options runtime --timestamp --preserve-metadata=entitlements \
  --sign "$IDENTITY" "$SPARKLE_EMBEDDED/Versions/B/Autoupdate"
codesign --force --options runtime --timestamp --preserve-metadata=entitlements \
  --sign "$IDENTITY" "$SPARKLE_EMBEDDED/Versions/B/Updater.app"
if compgen -G "$SPARKLE_EMBEDDED/Versions/B/XPCServices/*.xpc" >/dev/null 2>&1; then
  for xpc in "$SPARKLE_EMBEDDED"/Versions/B/XPCServices/*.xpc; do
    codesign --force --options runtime --timestamp --preserve-metadata=entitlements \
      --sign "$IDENTITY" "$xpc"
  done
fi
codesign --force --options runtime --timestamp --sign "$IDENTITY" "$SPARKLE_EMBEDDED"
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

# ---------------------------------------------------- 8. appcast (issue #121)
# Signed AFTER stapling: the EdDSA signature must cover the exact bytes
# users download. Publish appcast.xml as an asset on the SAME release as
# the DMG (SUFeedURL reads releases/latest/download/appcast.xml).
echo "==> generating Sparkle appcast"
generate_appcast "$DMG" "$BUILD_NUMBER"

# ------------------------------------- 9. stable-named asset (modeldeck.ai)
# The website's no-JavaScript fallback download link is the PERMANENT URL
#   https://github.com/timharris707/modeldeck/releases/latest/download/ModelDeck.dmg
# which only resolves if EVERY release ships an asset with that exact name.
# The copy is made from the stapled DMG so the bytes are identical; the
# Sparkle appcast enclosure keeps pointing at the versioned asset.
STABLE_DMG="$DIST_DIR/ModelDeck.dmg"
cp "$DMG" "$STABLE_DMG"
echo "==> stable-named asset written: $STABLE_DMG (same bytes as $DMG)"

echo "==> done: $DMG"
echo "    publish ALL THREE assets on the release (the stable-named"
echo "    ModelDeck.dmg keeps the website's permanent download URL alive):"
echo "    gh release create v$VERSION \"$DMG\" \"$DIST_DIR/appcast.xml\" \"$STABLE_DMG\""
