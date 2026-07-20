# ModelDeck release runbook (Mac app DMG)

How to cut a signed, notarized, stapled DMG of the Mac app. One command,
run on a Mac provisioned with the signing identity and notary profile
(see "One-time provisioning" below).

```sh
scripts/release-dmg.sh            # the real thing
scripts/release-dmg.sh --dry-run  # preflight + plan, builds nothing
```

Output: `dist/ModelDeck-<version>.dmg` (gitignored). The version comes
from the `VERSION` file at the repo root — the release-tag authority
documented in `macos/ModelDeckMac/Sources/ModelDeckMacCore/AppVersion.swift`.
Bump `VERSION` first; the script stamps it into the app bundle's
`CFBundleShortVersionString` at build time (`CFBundleVersion` is the repo
commit count).

## What the script does

1. `swift build -c release` in `macos/ModelDeckMac`.
2. Assembles `dist/ModelDeck.app` (bundle id `app.modeldeck.mac`,
   `LSUIElement` menu-bar app, macOS 14+), stamps the version.
3. Signs the app with the Developer ID identity — hardened runtime
   (`--options runtime`) and secure timestamp, as notarization requires.
4. Zips the app, submits to Apple with
   `xcrun notarytool submit --keychain-profile <profile> --wait`
   (typically 1–5 minutes), then staples the ticket to the app.
5. Builds the DMG with `hdiutil` (app + `/Applications` symlink).
6. Signs, notarizes, and staples the DMG too. Both layers are stapled so
   Gatekeeper passes even offline, both for the mounted DMG and for the
   app after it is copied to /Applications.
7. Verifies: `codesign --verify --deep --strict` on the app,
   `spctl -a -vv` on the app, and
   `spctl -a -t open --context context:primary-signature -vv` on the DMG.

On a notarization rejection the script exits non-zero and prints the
`notarytool log` for the failed submission id.

## One-time provisioning (per build machine)

Neither of these lives in the repo; both are referenced by name only.

- **Signing identity** in the login keychain, e.g.
  `Developer ID Application: Jane Developer (TEAMID1234)`.
  Export/import via Xcode or Keychain Access. Override the default with
  `MODELDECK_SIGNING_IDENTITY="Developer ID Application: ..."`.
- **Notary profile**: store App Store Connect credentials once with
  `xcrun notarytool store-credentials modeldeck-notary` (Apple ID +
  app-specific password + team id, or an ASC API key). Override the
  profile name with `MODELDECK_NOTARY_PROFILE=<name>`.

The identity string and profile name are labels, not secrets — the
private key and Apple credentials stay in the keychain. Never commit or
echo credential values.

## Scope: this DMG ships the Mac app only

`ModelDeck.app` is the menu-bar app. The Node daemon is **not** bundled —
it still installs separately via `scripts/install-launch-agent.sh`
(see `docs/ACCOUNT_ONBOARDING.md`). A fresh machine needs both steps:
install the daemon, then drag the app from the DMG into /Applications.

Bundling the daemon (embedding a node runtime or a compiled daemon inside
the app, signed as nested code) is a future item — tracked on the roadmap,
deliberately not attempted in the initial pipeline.

## Publishing

Attach the DMG to a GitHub Release for the version tag:

```sh
VERSION="$(cat VERSION)"
gh release create "v$VERSION" "dist/ModelDeck-$VERSION.dmg"
```

## Known gaps / future

- No custom app icon yet: there is no vector/raster brand asset in the
  repo (`design/` holds HTML mockups only), so the bundle ships without
  an `.icns` rather than inventing artwork.
- Daemon bundling (above).
- CI signing is out of scope; releases are cut from a provisioned Mac.
