# ModelDeck release runbook (Mac app DMG)

How to cut a signed, notarized, stapled DMG of the Mac app. Releases must be
built from a pristine, dedicated worktree at `origin/main`—never from the
shared working checkout used by the orchestrator or other sessions.

```sh
git fetch origin
RELEASE_WORKTREE="$(mktemp -d)/modeldeck-release"
git worktree add --detach "$RELEASE_WORKTREE" origin/main
cd "$RELEASE_WORKTREE"
npm install
scripts/build-daemon-binary.sh
scripts/release-dmg.sh --check-only
scripts/release-dmg.sh
```

Run on a Mac provisioned with the signing identity and notary profile (see
"One-time provisioning" below). After publishing, remove the dedicated
worktree with `git worktree remove "$RELEASE_WORKTREE"` from the original
checkout.

```sh
scripts/release-dmg.sh            # the real thing
scripts/release-dmg.sh --dry-run  # preflight + plan, builds nothing
scripts/release-dmg.sh --check-only # repository guard only; no credentials/build
```

Output: `dist/ModelDeck-<version>.dmg` (gitignored). The version comes
from the `VERSION` file at the repo root — the release-tag authority
documented in `macos/ModelDeckMac/Sources/ModelDeckMacCore/AppVersion.swift`.
Bump `VERSION` first; the script stamps it into the app bundle's
`CFBundleShortVersionString` at build time (`CFBundleVersion` is the repo
commit count). The exact commit hash is logged and stamped as `MDGitCommit`
in the built app's `Info.plist`.

The repository guard fetches `origin`, rejects tracked changes outside
`dist/`, and requires `HEAD` to equal `origin/main`. Emergency overrides
`--allow-dirty` and `--ref <ref>` print prominent warning banners and should
only be used when the release decision explicitly calls for them.

## What the script does

1. Requires `dist/daemon/modeldeckd`, produced first with
   `scripts/build-daemon-binary.sh`. That build bundles the dependency-free
   Node daemon, embeds it in a Node >=24 single executable application,
   ad-hoc signs it, writes `dist/daemon/manifest.json`, and smoke-checks
   `GET /api/health`.
2. Runs `swift build -c release` in `macos/ModelDeckMac`.
3. Assembles `dist/ModelDeck.app` (bundle id `app.modeldeck.mac`,
   `LSUIElement` menu-bar app, macOS 14+), stages the daemon at
   `Contents/Resources/daemon/modeldeckd`, and stamps the version.
4. Re-signs the embedded daemon and then the app with the Developer ID
   identity — hardened runtime
   (`--options runtime`) and secure timestamp, as notarization requires.
5. Zips the app, submits to Apple with
   `xcrun notarytool submit --keychain-profile <profile> --wait`
   (typically 1–5 minutes), then staples the ticket to the app.
6. Builds the DMG with `hdiutil` (app + `/Applications` symlink).
7. Signs, notarizes, and staples the DMG too. Both layers are stapled so
   Gatekeeper passes even offline, both for the mounted DMG and for the
   app after it is copied to /Applications.
8. Verifies: `codesign --verify --deep --strict` on the app,
   `spctl -a -vv` on the app, and
   `spctl -a -t open --context context:primary-signature -vv` on the DMG.

On a notarization rejection the script exits non-zero and prints the
`notarytool log` for the failed submission id.

## One-time provisioning (per build machine)

Neither of these lives in the repo; both are referenced by name only.

- **Signing identity** in the login keychain, e.g.
  `Developer ID Application: Jane Developer (TEAMID1234)`.
  Export/import via Xcode or Keychain Access. Override the default with
  `MD_SIGN_IDENTITY="Developer ID Application: ..."`. The committed default
  is a non-functional placeholder, so this variable is required for signing.
- **Notary profile**: store App Store Connect credentials once with
  `xcrun notarytool store-credentials modeldeck-notary` (Apple ID +
  app-specific password + team id, or an ASC API key). Override the
  profile name with `MODELDECK_NOTARY_PROFILE=<name>`.

The identity string and profile name are labels, not secrets — the
private key and Apple credentials stay in the keychain. Never commit or
echo credential values.

## Daemon activation is a separate app issue

The one-DMG artifact now contains the self-contained daemon binary. Registering
and managing it from the Mac app with `SMAppService` is the app half of issue
#91 and remains separate from this daemon/release build work. Until that app
half lands, bundling alone does not activate the daemon on a fresh machine.

## Publishing

Attach the DMG to a GitHub Release for the version tag:

```sh
VERSION="$(cat VERSION)"
gh release create "v$VERSION" "dist/ModelDeck-$VERSION.dmg"
```

## Syncing the public mirror

Use the mirror script from a clean source checkout. It archives committed
`HEAD`, removes the private-only paths below, stages the candidate tree, and
refuses to commit if any scrub pattern matches. The pattern file contains one
extended regular expression per line; blank lines and `#` comments are ignored.
See `scripts/scrub-patterns.example` for fake examples.

```sh
MD_SCRUB_PATTERNS=/path/to/scrub-patterns \
  scripts/sync-mirror.sh /path/to/mirror-clone "release 0.0.0"

# Validate archive + strip + scrub without touching the mirror clone:
MD_SCRUB_PATTERNS=/path/to/scrub-patterns \
  scripts/sync-mirror.sh --check-only /path/to/mirror-clone "release 0.0.0"

# Publishing is explicit; without --push the neutral-author commit stays local:
MD_SCRUB_PATTERNS=/path/to/scrub-patterns \
  scripts/sync-mirror.sh --push /path/to/mirror-clone "release 0.0.0"
```

The following strip list is encoded in `scripts/sync-mirror.sh` and must stay
in sync with it:

- `.claude/`
- `docs/HANDOFF.md`
- `docs/ACCOUNT_ONBOARDING.md`
- `docs/lane-routing-policy.md`
- `docs/incidents/`
- `scripts/lane-codex.sh`
- `scripts/lane-watch.mjs`
- `design/mac-app-roadmap.md`
- The scrub-pattern file named by `MD_SCRUB_PATTERNS` when it is inside the
  source repository.

## Known gaps / future

- No custom app icon yet: there is no vector/raster brand asset in the
  repo (`design/` holds HTML mockups only), so the bundle ships without
  an `.icns` rather than inventing artwork.
- `SMAppService` registration and lifecycle management for the bundled daemon.
- CI signing is out of scope; releases are cut from a provisioned Mac.
