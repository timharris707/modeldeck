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

## Daemon activation (app half of #91 — shipped)

The one-DMG artifact contains the self-contained daemon binary, and the app
half of issue #91 is implemented: on first launch the app asks consent, then
registers the bundled daemon as a launchd agent via `SMAppService`
(`SMAppServiceAgentRegistrar` in
`macos/ModelDeckMac/Sources/ModelDeckMacCore/DaemonSetupLive.swift`) and
creates the `modeldeck` / `mutation-token` Keychain item if missing. A fresh
machine needs no Terminal steps.

## Sparkle in-app updates (issue #121)

The script's final step generates `dist/appcast.xml` — the Sparkle 2 feed for
in-app updates — and, during assembly, embeds `Sparkle.framework` and stamps
the Sparkle EdDSA **public** key into the app's `Info.plist`
(`SUPublicEDKey`). The app's `SUFeedURL` is the stable redirect
`https://github.com/timharris707/modeldeck/releases/latest/download/appcast.xml`,
so the appcast **must be uploaded as an asset named `appcast.xml` on every
release** (see Publishing below); GitHub's `releases/latest/download/`
redirect then always serves the newest release's feed.

One-time provisioning (release Mac, in addition to the identity/notary
profile):

```sh
# after swift package resolve has run at least once:
GENERATE_KEYS="$(find macos/ModelDeckMac/.build/artifacts -type f -name generate_keys | head -1)"
"$GENERATE_KEYS"        # stores the EdDSA private key in the login Keychain
"$GENERATE_KEYS" -p     # prints the PUBLIC key (used for SUPublicEDKey stamping)
```

The private key never leaves the Keychain — never commit, echo, or export
it. The script auto-derives the public key via `generate_keys -p` (override
with `MD_SPARKLE_PUBLIC_ED_KEY`) and signs the DMG's appcast entry with
Sparkle's `sign_update` (auto-located in the SwiftPM artifacts; override
with `MD_SPARKLE_SIGN_UPDATE`). Both preflight checks fail loudly with these
instructions when the key or tool is missing.

`scripts/release-dmg.sh --appcast-only <dmg>` regenerates just the appcast
for an existing DMG (also the test hook — `MD_SPARKLE_KEY_FILE` may inject
the fake fixture key for tests, never for real releases).

## Publishing

Attach the DMG **and the appcast** to a GitHub Release for the version tag:

```sh
VERSION="$(cat VERSION)"
gh release create -R timharris707/modeldeck "v$VERSION" \
  "dist/ModelDeck-$VERSION.dmg" "dist/appcast.xml"
```

The release must live on the **public mirror repo** (`-R
timharris707/modeldeck`): that is where the app's update checker and the
Sparkle `SUFeedURL` both point. Both assets are required: the DMG is what
the appcast's enclosure URL points at, and `appcast.xml` is what installed
apps poll via the stable `releases/latest/download/appcast.xml` URL.

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

## README screenshots (demo-seeded, issue #129)

README images live in `docs/images/` and MUST come from a demo-seeded
instance — never from a live deck. The safety contract (DESIGN.md) forbids
real identities in anything published; the demo roster uses Tim's chosen
placeholder labels (Personal / Business / Hobby Account / School, 4 Claude +
3 Codex) with `…@example.invalid` identities and clearly-labelled
placeholder marker files instead of credentials.

To refresh the screenshots for a release:

1. **Start the isolated demo daemon** (own data dir, own port; never 3867):

   ```sh
   scripts/demo-daemon.sh /tmp/modeldeck-demo 4867
   ```

   This seeds `scripts/seed-demo.mjs` on first run and starts the daemon
   with every path pinned inside the demo dir and
   `MODELDECK_DEMO_FIXTURES=1` — fixture snapshots are authoritative, the
   provider-refresh scheduler never arms, and `/api/refresh` is a no-op, so
   the placeholder accounts keep their healthy chips. Delete the demo dir
   and rerun to reseed (reset times are anchored relative to seed time).

2. **Build and launch the app against it** (`build_app.sh` stamps the repo
   `VERSION` into the dev bundle so the popover footer shows the real
   version):

   ```sh
   macos/ModelDeckMac/Scripts/build_app.sh --release
   MODELDECK_PORT=4867 \
     macos/ModelDeckMac/dist/ModelDeck.app/Contents/MacOS/ModelDeckMac
   ```

   If the production ModelDeck app is running you will have TWO menu bar
   icons. Quit the real one first, or verify before every capture that the
   open popover shows only the placeholder labels above.

3. **Capture with `screencapture` window captures** (Retina resolution comes
   from the display):

   ```sh
   # find the popover/settings window id of the demo app process
   # (e.g. via CGWindowListCopyWindowInfo filtered by the demo app's PID)
   screencapture -o -x -l <windowID> docs/images/<name>.png
   ```

   The three shipped shots: `deck-popover.png` (default next-reset sort,
   one card per column expanded), `deck-popover-percent.png` (lowest-
   remaining sort via the % segment), `settings-general.png` (Settings →
   General).

4. **Before committing**: confirm every visible label/identity is one of the
   placeholders, the version chip matches the release, and no real account
   data appears anywhere in the frame.

## Known gaps / future

- No custom app icon yet: there is no vector/raster brand asset in the
  repo (`design/` holds HTML mockups only), so the bundle ships without
  an `.icns` rather than inventing artwork.
- CI signing is out of scope; releases are cut from a provisioned Mac.
