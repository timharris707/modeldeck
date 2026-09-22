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
npm test
scripts/build-daemon-binary.sh
scripts/build-cliproxyapi.sh --fetch-go --handshake-port 18317
npm run test:cliproxyapi-pin
scripts/release-dmg.sh --check-only
mkdir -p dist
curl --fail --location https://github.com/timharris707/modeldeck/releases/latest/download/appcast.xml -o dist/previous-appcast.xml
curl --fail --location https://github.com/timharris707/modeldeck/releases/latest/download/appcast-beta.xml -o dist/previous-appcast-beta.xml
scripts/release-dmg.sh --merge-existing-stable dist/previous-appcast.xml --merge-existing-beta dist/previous-appcast-beta.xml

xcrun stapler validate dist/ModelDeck.app
xcrun stapler validate "dist/ModelDeck-$(tr -d '\n' < VERSION).dmg"
scripts/build-cliproxyapi.sh --handshake-only \
  dist/ModelDeck.app/Contents/Resources/cliproxyapi/cliproxyapi \
  --handshake-port 18318
```

The proxy build only ever uses the checksum-verified official Go toolchain
from the pin (`--allow-unpinned-go` is a dev-only escape hatch and never
feeds a release artifact).

For the coordinated 0.4.6 install and analytics cutover after the artifact is
built, follow [`docs/0.4.6-GO-LIVE.md`](0.4.6-GO-LIVE.md). It is deliberately
separate from artifact creation: launchd retirement and live settings remain
release-day, Tim-gated operations.

Run on a Mac provisioned with the signing identity and notary profile (see
"One-time provisioning" below). After publishing, remove the dedicated
worktree with `git worktree remove "$RELEASE_WORKTREE"` from the original
checkout.

```sh
scripts/release-dmg.sh --merge-existing-stable dist/previous-appcast.xml \
  --merge-existing-beta dist/previous-appcast-beta.xml   # the real thing (both prior feeds are required)
scripts/release-dmg.sh --dry-run  # preflight + plan, builds nothing
scripts/release-dmg.sh --check-only # repository guard + release checks; no credentials/build
scripts/release-dmg.sh --first-feeds # ONLY for the very first publication: no prior feeds exist
```

Output: `dist/ModelDeck-<version>.dmg` (gitignored). The version comes
from the `VERSION` file at the repo root (bump `package.json` **and
`package-lock.json`** versions in the same commit — the daemon inlines ITS
version from package.json, release-checks fails if VERSION and package.json
disagree, and a stale lock gets rewritten by `npm install` in the pristine
worktree, which the repository guard then rejects as a dirty tree; the 1.1.5
release hit exactly that. `npm install --package-lock-only` after editing
package.json updates the lock's two version fields) — the release-tag authority
documented in `macos/ModelDeckMac/Sources/ModelDeckMacCore/AppVersion.swift`.
Bump `VERSION` first; the script stamps it into the app bundle's
`CFBundleShortVersionString` at build time (numeric portion only for betas).
`ModelDeckDisplayVersion` preserves the full version for display and update
comparisons; `CFBundleVersion` is the repo commit count. The exact commit hash is logged and stamped as `MDGitCommit`
in the built app's `Info.plist`.

The repository guard fetches `origin`, rejects tracked changes outside
`dist/`, and requires `HEAD` to equal `origin/main`. Emergency overrides
`--allow-dirty` and `--ref <ref>` print prominent warning banners and should
only be used when the release decision explicitly calls for them.

## Bundled CLIProxyAPI

[`scripts/cliproxyapi-pin.json`](../scripts/cliproxyapi-pin.json) is the one
authority for the stock upstream repository, release tag, full commit SHA,
pinned Go version and official-toolchain checksum, and the in-app path
`Contents/Resources/cliproxyapi/cliproxyapi`. The build fetches that exact
source commit and tag—never an upstream release binary—then refuses a
floating tag, a tag/SHA mismatch, a different checked-out HEAD, or any dirty
fetched source. The current target is darwin/arm64; universal packaging needs
a follow-up rather than being inferred by this script.

`scripts/build-cliproxyapi.sh --fetch-go --handshake-port <unused-port>` uses
the pinned official Go archive when Go is absent, verifies its recorded
SHA-256, builds with fixed source-derived version metadata, and signs with the
same `MD_SIGN_IDENTITY` used by `release-dmg.sh`. It then launches the signed
binary with isolated placeholder-only config and verifies `/healthz` plus an
authenticated `/v0/management/config` response. `--handshake-only <binary>`
reruns that live check without rebuilding. Port 8317 is rejected so the check
cannot collide with the normal CLIProxyAPI service by accident. The generated
`dist/cliproxyapi/manifest.json` binds the signed artifact's SHA-256 and build
inputs back to the current pin; `release-dmg.sh` refuses a stale or changed
artifact.

After `release-dmg.sh` completes, exercise the exact binary that was staged,
re-signed, and carried through notarization:

```sh
scripts/build-cliproxyapi.sh --handshake-only \
  dist/ModelDeck.app/Contents/Resources/cliproxyapi/cliproxyapi \
  --handshake-port 18318
```

A pin bump rides an app release; changing the embedded binary outside that
flow would invalidate the outer signature and notarization ticket. For a bump:

1. Resolve the selected upstream release tag to its full 40-character commit,
   review its changelog/security impact, and update only the pin file (including
   Go version/checksum if upstream changed them).
2. Run `npm test`, build the pinned binary with the live handshake above, then
   run the pin-bump compatibility suite with one command:

   ```sh
   npm run test:cliproxyapi-pin
   ```

   The suite discovers `MD_CLIPROXYAPI_BINARY` when set, otherwise
   `dist/cliproxyapi/cliproxyapi`. It starts only its own placeholder-configured
   instance on port 18319 (override with `MD_CLIPROXYAPI_TEST_PORT`; ports 8317
   and 3867 are refused), destructively reads only that instance's empty usage
   queue, and writes a safe live-capture receipt to
   `dist/cliproxyapi/compatibility.json`. `release-checks.mjs` binds that receipt
   to the current pin and exact binary SHA-256; a fixture-only pass, skipped
   live test, stale pin, or rebuilt binary cannot ship. The CVE expedite path
   uses the same command and gate while accelerating the app release; it does
   not create an out-of-band binary swap.
3. Run `release-dmg.sh` normally so the embedded binary rides the existing
   inner-sign → app-notarize/staple → DMG-notarize/staple flow.

### Upstream watch + CVE-only expedite (issue #425)

Every release includes one checklist step: check the pin against upstream
(`gh release list -R router-for-me/CLIProxyAPI` or the releases page),
decide bump-or-hold, and record the decision — tag reviewed, verdict, one
line of reasoning — on the release's tracking issue. The verdict answers two
questions, not one:

1. **Security**: does any skipped release carry a security fix? (This was
   the original, sole lens.)
2. **Compatibility**: does any skipped release carry a change staying behind
   would break — a bumped client fingerprint or minimum client version,
   support for a new provider model, or a CLI protocol change? Holding is
   only safe when both answers are no.

A compatibility-relevant finding converts the hold into a bump that rides
the next app release, pulled forward on the calendar when the incompatibility
already bites current CLIs or models. That is a normal release in every gate;
the out-of-cycle expedite path stays security-only ("CVE-only", below and in
decision 0012) and does not widen.

"Checked v7.2.130 → hold, nothing security-relevant, nothing
compatibility-relevant" is a complete record; the point is that every
release either moved the pin deliberately or kept it deliberately, never by
omission. Decision 0039 added the second lens after a hold that was
security-clean still left the proxy unable to speak for a new Codex CLI and
a new Anthropic model (2026-09-01). Compatibility findings that affect Tim's
live machine (not just the bundle) also go to the pairing policy in the
private live-proxy ops doc (`docs/live-proxy-ops.md`, mirror-stripped).

Outside the release cadence there is exactly one reason to bump the pin: a
security fix in the bundled binary — a published CVE or an upstream security
advisory ("CVE-only" is this path's recorded shorthand for security-only;
an advisory without a CVE number qualifies, a feature or bugfix release
never does). An
expedited bump is a normal app release in every respect — pin-file edit,
`npm run test:cliproxyapi-pin`, full `release-dmg.sh` flow — compressed in
calendar time, not in gates. The compatibility suite is the bar; urgency
does not waive it, and there is no out-of-band binary-swap path (an
unsigned swap would invalidate the notarization ticket anyway). Feature
releases upstream wait for the next ModelDeck release.

### Third-party notices (NOTICES + Credits.rtf)

The bundled components' MIT notices ship through two channels that must
both exist: the repo-root `NOTICES` file (covers the public source mirror)
and `macos/ModelDeckMac/Resources/Credits.rtf`, which `release-dmg.sh`
stages into the app bundle where the standard About panel renders it
(About ModelDeck in the menu-bar icon's context menu). The full NOTICES
file is staged into the bundle too (`Contents/Resources/NOTICES`) so the
vendored components' complete texts travel with the binary. `release-checks.mjs`
fails if either file is missing, empty, or lacking its required component
markers. A pin bump that changes upstream's
copyright/license text must update both files in the same commit.

CLIProxyAPI starts with **no entitlements**: its codesign commands deliberately
have no `--entitlements` argument. An entitlement may be added only after a
hardened-runtime launch failure demonstrates the need and the reason is
recorded beside the signing step. The Node/V8 daemon entitlements are not a
precedent for this Go binary.

## What the script does

1. Requires `dist/daemon/modeldeckd`, produced first with
   `scripts/build-daemon-binary.sh`. That build bundles the dependency-free
   Node daemon, embeds it in a Node >=24 single executable application,
   ad-hoc signs it, writes `dist/daemon/manifest.json`, and smoke-checks
   `GET /api/health`. The smoke daemon runs under a scratch HOME so it can never
   see the operator's real profiles. It also requires the signed pinned-source CLIProxyAPI at
   `dist/cliproxyapi/cliproxyapi`, produced by the command above.
2. Runs `swift build -c release` in `macos/ModelDeckMac`.
3. Assembles `dist/ModelDeck.app` (bundle id `app.modeldeck.mac`,
   `LSUIElement` menu-bar app, macOS 14+), stages the daemon at
   `Contents/Resources/daemon/modeldeckd`, stages CLIProxyAPI at its pinned
   bundle path, and stamps the version.
4. Re-signs both embedded executables and then the app with the Developer ID
   identity—hardened runtime (`--options runtime`) and secure timestamp, as
   notarization requires. CLIProxyAPI is signed with no entitlements.
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

The script's final step generates `dist/appcast.xml` and `dist/appcast-beta.xml` — the Sparkle 2 feeds for
in-app updates — and, during assembly, embeds `Sparkle.framework` and stamps
the Sparkle EdDSA **public** key into the app's `Info.plist`
(`SUPublicEDKey`). The app's `SUFeedURL` is the stable redirect
`https://github.com/timharris707/modeldeck/releases/latest/download/appcast.xml`,
so **both feeds must be uploaded on every stable release** (see Publishing below); GitHub's `releases/latest/download/`
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
instructions when the key or tool is missing. In a pristine release worktree
the SwiftPM artifacts directory cannot exist yet, so the script runs
`swift package resolve` itself before this preflight (the v0.3.2 release
tripped over a silent exit here before that was added).

`scripts/release-dmg.sh --appcast-only <dmg> --build <CFBundleVersion>` regenerates just the feeds
for an existing DMG. Read the numeric build from that archive, not the current
checkout; pass the same merge arguments and `--beta` when appropriate. This is
also the test hook — `MD_SPARKLE_KEY_FILE` may inject
the fake fixture key for tests, never for real releases.

Since issue #685 the selected appcast is the app's ONLY update feed: the in-app check
("Check for App Updates", the 4-hourly automatic check) reads the same
`appcast.xml` Sparkle installs from, taking the version, the release page
link, and the release notes from it — the GitHub API is no longer consulted.
The release script embeds `docs/release-notes/<version>.md` as the item's
`<description>` (`--release-notes-file`), which is what the update dialog
renders; a version without that file still gets an appcast, just with no
notes in the dialog.

## Publishing

Attach **all four** build outputs to every stable GitHub Release:

```sh
VERSION="$(cat VERSION)"
gh release create -R timharris707/modeldeck "v$VERSION" \
  "dist/ModelDeck-$VERSION.dmg" "dist/appcast.xml" "dist/appcast-beta.xml" "dist/ModelDeck.dmg"
```

The release must live on the **public mirror repo** (`-R
timharris707/modeldeck`): that is where the app's update checker and the
Sparkle `SUFeedURL` both point. All four assets are required:

- `ModelDeck-<version>.dmg` — what the appcast's enclosure URL points at.
- `appcast.xml` — what installed apps poll via the stable
  `releases/latest/download/appcast.xml` URL.
- `appcast-beta.xml` — stable history plus every beta newer than the newest
  stable, for users who enable Beta Releases. Publish it even if no beta exists.
- `ModelDeck.dmg` — the stable-named copy (identical bytes, produced by
  the script since v0.3.3). modeldeck.ai's no-JavaScript fallback download
  link is the permanent URL
  `releases/latest/download/ModelDeck.dmg`, which resolves only while
  **every** release ships an asset with that exact name. Omitting it
  silently breaks the website's fallback download for the release.

## Beta releases and feed history (issue #705)

Fetch both current feeds with the two `curl --fail --location` commands above
**before** building. Keep them under the `previous-` filenames so output cannot
overwrite an input. On the first release that introduces the beta feed, its URL
will return 404; copy `dist/previous-appcast.xml` to
`dist/previous-appcast-beta.xml` for that one bootstrap. Any other download
failure needs resolving before release. The feed-generation step itself makes
no network requests; signing/notarization and the repository guard retain their
existing network requirements.

Every stable release writes and publishes **both feeds**. The stable feed never
contains beta items, including for old app versions that ignore channel tags.
The beta feed keeps each beta newer than the newest stable. Both retain the
newest stable and three older stables, with each carried item's XML unchanged.

For a beta, use a prerelease version such as `1.2.0-beta.1` in VERSION and both
package files, and write `docs/release-notes/1.2.0-beta.1.md`. Pass `--beta` to
both the release checks (`npm run release:check -- --beta`) and the build:

```sh
scripts/release-dmg.sh --beta --merge-existing-stable dist/previous-appcast.xml --merge-existing-beta dist/previous-appcast-beta.xml
VERSION="$(cat VERSION)"
gh release create -R timharris707/modeldeck "v$VERSION" --prerelease \
  "dist/ModelDeck-$VERSION.dmg" dist/appcast-beta.xml
STABLE_TAG="$(gh release view -R timharris707/modeldeck --json tagName --jq .tagName)"
gh release upload -R timharris707/modeldeck "$STABLE_TAG" dist/appcast-beta.xml --clobber
```

The final upload matters: GitHub's `releases/latest` excludes prereleases.
Replace only `appcast-beta.xml` on the latest stable release so opted-in apps
see the new beta through their permanent URL. Leave its stable appcast and DMGs
alone. Beta releases do not update the Homebrew cask or the website's stable
DMG. Verify the permanent beta URL serves the new version after uploading.

Settings → General → Beta Releases is off by default. It switches both the
app's check and Sparkle to `appcast-beta.xml` on the next check, without a
relaunch. Turning it off while running a beta does not downgrade the app.

Release notes may declare `Rollback floor: <version>` or
`Rollback floor: unchanged` on its own line. Omission means unchanged, unless
the notes mention "schema" in any letter case; then the line is required.
Use a release's own version when its database changes prevent an older daemon
from opening the data. Unchanged inherits the newest carried stable item's
floor; when that item or its floor is absent, it uses the new release's version.

## Homebrew tap bump

After publishing, update the cask in the tap repo
(`timharris707/homebrew-modeldeck`) so `brew install --cask
timharris707/modeldeck/modeldeck` serves the new version. The cask needs
two edits: the `version` line and the `sha256` of the **versioned** DMG.

```sh
VERSION="$(cat VERSION)"
SHA256="$(shasum -a 256 "dist/ModelDeck-$VERSION.dmg" | cut -d' ' -f1)"
TAP_DIR="$(mktemp -d)/homebrew-modeldeck"
git clone https://github.com/timharris707/homebrew-modeldeck "$TAP_DIR"
cd "$TAP_DIR"
sed -i '' -e "s/^  version .*/  version \"$VERSION\"/" \
  -e "s/^  sha256 .*/  sha256 \"$SHA256\"/" Casks/modeldeck.rb
brew style . && brew audit --cask --online Casks/modeldeck.rb
git commit -am "modeldeck $VERSION" && git push
cd - && rm -rf "$(dirname "$TAP_DIR")"
```

The audit step downloads the published DMG and verifies the checksum, so
run it only after the release assets are live. The cask is marked
`auto_updates` (Sparkle owns upgrades), so a missed bump doesn't strand
brew users on an old build — but the bump is still part of every release.

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
- `docs/live-proxy-ops.md`
- `docs/incidents/`
- `scripts/lane-codex.sh`
- `scripts/lane-watch.mjs`
- `test/lane-codex-args.test.mjs`
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
   version). **Strip the bundled daemon first**: if a stale `dist/daemon/`
   exists at the repo root, `build_app.sh` stages it into the dev bundle,
   and on 2026-08-17 that made the ad-hoc-signed demo app treat the live
   registration as drift and re-register `ai.hermes.modeldeck` — stamping a
   launch constraint from the DEV signature that made launchd SIGKILL the
   production daemon ("Launch Constraint Violation", exit 78) until a manual
   `launchctl bootout` (issue #486). The app now stands down on any
   non-production signature, but the screenshot bundle should not carry a
   daemon at all; re-sign after the removal so the bundle seal stays valid:

   ```sh
   macos/ModelDeckMac/Scripts/build_app.sh --release
   rm -rf macos/ModelDeckMac/dist/ModelDeck.app/Contents/Resources/daemon \
          macos/ModelDeckMac/dist/ModelDeck.app/Contents/Library/LaunchAgents
   codesign --force --sign - macos/ModelDeckMac/dist/ModelDeck.app
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

- Data removal is opt-in: deleting `<DATA_DIR>` removes managed Codex homes
  in `codex-profiles/` and their migration recovery backups. Uninstalling the
  app or LaunchAgent alone retains them. Custom profile-directory overrides
  and the migration's empty `~/.codex-profiles` directory remain separate;
  see the README uninstall instructions.
- No custom app icon yet: there is no vector/raster brand asset in the
  repo (`design/` holds HTML mockups only), so the bundle ships without
  an `.icns` rather than inventing artwork.
- CI signing is out of scope; releases are cut from a provisioned Mac.
