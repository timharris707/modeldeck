#!/usr/bin/env bash
# generate-dmg-ds-store.sh — Issue #69: regenerate design/dmg/DS_Store.
#
# The release DMG (scripts/release-dmg.sh) gets its installer window layout
# (background image, icon positions, window size, hidden chrome) from a
# COMMITTED Finder .DS_Store, copied into the staging folder at build time.
# That keeps the release pipeline deterministic: no Finder scripting, no
# Automation permission prompt, and no third-party .DS_Store writer at
# release time (create-dmg's approach, vendored).
#
# This maintenance script is how that committed file is (re)produced. It:
#   1. stages a THROWAWAY layout fixture: a stub ModelDeck.app, the
#      /Applications symlink, and .background/modeldeck-installer-bg.png —
#      the same names release-dmg.sh stages;
#   2. builds a read-write DMG with the FIXED volume name "ModelDeck"
#      (release-dmg.sh must use the same volname: the .DS_Store background
#      reference is an alias that records the volume name, so a versioned
#      volname would break it);
#   3. mounts it and drives Finder via AppleScript to set the layout
#      (this prompts for Automation permission the first time);
#   4. copies the resulting .DS_Store to design/dmg/DS_Store and detaches.
#
# Run it only when the layout or background art changes:
#   swift scripts/generate-dmg-background.swift   # if the art changed
#   scripts/generate-dmg-ds-store.sh
# then commit design/dmg/DS_Store.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKGROUND="$REPO_ROOT/design/dmg/modeldeck-installer-bg.png"
OUTPUT="$REPO_ROOT/design/dmg/DS_Store"
VOLNAME="ModelDeck"
MOUNTPOINT="/Volumes/$VOLNAME"

fail() { echo "generate-dmg-ds-store.sh: ERROR: $*" >&2; exit 1; }

[[ -f "$BACKGROUND" ]] || fail "background art missing: $BACKGROUND (run swift scripts/generate-dmg-background.swift)"
[[ -e "$MOUNTPOINT" ]] && fail "$MOUNTPOINT is already mounted; detach it first"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/modeldeck-ds-store.XXXXXX")"
DMG="$WORK/layout.dmg"
STAGING="$WORK/staging"
cleanup() {
  hdiutil detach "$MOUNTPOINT" -quiet 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# 1. staging fixture — stub app only; the layout cares about names, not code.
mkdir -p "$STAGING/ModelDeck.app/Contents/MacOS" "$STAGING/.background"
printf '#!/bin/sh\nexit 0\n' > "$STAGING/ModelDeck.app/Contents/MacOS/ModelDeckMac"
chmod +x "$STAGING/ModelDeck.app/Contents/MacOS/ModelDeckMac"
ln -s /Applications "$STAGING/Applications"
cp "$BACKGROUND" "$STAGING/.background/modeldeck-installer-bg.png"

# 2. read-write DMG with the fixed release volname.
hdiutil create -volname "$VOLNAME" -srcfolder "$STAGING" -ov -format UDRW \
  -fs HFS+ "$DMG" >/dev/null

# 3. mount and lay out via Finder.
hdiutil attach "$DMG" -noautoopen >/dev/null
[[ -d "$MOUNTPOINT" ]] || fail "mount point $MOUNTPOINT did not appear"

# Window bounds 600x428 (content 600x400 with the title bar) matching the
# 600x400pt background; icon centers at (150,195) and (450,195) matching
# the arrow/ring anchors in generate-dmg-background.swift.
osascript <<'APPLESCRIPT'
tell application "Finder"
  tell disk "ModelDeck"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {200, 120, 800, 548}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 100
    set text size of viewOptions to 12
    set background picture of viewOptions to file ".background:modeldeck-installer-bg.png"
    set position of item "ModelDeck.app" of container window to {150, 195}
    set position of item "Applications" of container window to {450, 195}
    close
    open
    update without registering applications
    delay 2
    close
  end tell
end tell
APPLESCRIPT

# Give Finder a moment to flush the .DS_Store to disk.
sync
for _ in $(seq 1 20); do
  [[ -f "$MOUNTPOINT/.DS_Store" ]] && break
  sleep 0.5
done
[[ -f "$MOUNTPOINT/.DS_Store" ]] || fail "Finder never wrote $MOUNTPOINT/.DS_Store"

# 4. capture and detach.
cp "$MOUNTPOINT/.DS_Store" "$OUTPUT"
hdiutil detach "$MOUNTPOINT" >/dev/null

echo "wrote $OUTPUT"
echo "commit it together with the background art; release-dmg.sh copies both into the DMG staging folder."
