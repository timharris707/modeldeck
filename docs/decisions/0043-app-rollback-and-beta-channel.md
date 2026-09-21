# 0043 — Beta channel and rollback to the previous version, without going through Sparkle's installer for the rollback

- Date: 2026-09-20
- Links: issues #704 (part 1), #705 (beta channel), #706 (rollback); decision 0041 (post-update daemon restart); issue #685 (one feed); issue #121 (Sparkle install)
- Status: recorded by the orchestrating session from Tim's ruling; Tim may overrule. Build lanes are gpt-6-astra; adversarial review is mandatory on #706 (never-compromise 3: a code path that replaces the app bundle).

## The problem, in Tim's words

"Here's an example of one that's done really nicely. It allows for automatic
updates and beta releases. You can check for updates, and it has release notes
right there. You can even do a rollback." (FluidVoice's update panel,
2026-09-20.) Ruling: build all of it.

ModelDeck already has automatic checks, automatic install, Update Now, and
notes inside the update dialog. Missing: a beta channel, and any way back to
the previous version.

## Decision

### 1. The feed lists more than one item

`generate-appcast.mjs` gains `--merge-existing <appcast.xml>` and
`--channel <name>`. `release-dmg.sh` downloads the currently published
`appcast.xml` from the public releases page and merges it, so the feed
carries the newest stable, the newest beta (if any), and the last **three**
older stables. Items older than that fall off. Every item keeps its own
EdDSA signature; nothing is re-signed. Sparkle 2 picks the newest item it is
allowed to install, so a longer feed changes nothing for today's updater.

Why three: enough to roll back past a bad release and its hotfix; small enough
that the feed stays under a few kilobytes and the rollback target is never a
build older than a month or two.

### 2. Beta channel: a second feed file, not a channel tag in the shared feed

CodeRabbit on the first draft: every installed app before this change reads
the shared appcast with a decoder that ignores `sparkle:channel` and picks
the highest version, so a beta item in the shared feed would be offered to
every notify-only install out there. There is no way to migrate those
installs first. So betas never enter the shared feed.

- A beta is a version with a prerelease suffix (`1.2.0-beta.1`), published
  as a GitHub prerelease. Its release carries `appcast-beta.xml`, and the
  stable release's assets carry BOTH `appcast.xml` (stables only) and
  `appcast-beta.xml` (stables plus betas, merged), so the stable
  `releases/latest/download/appcast-beta.xml` redirect always resolves.
  Items in the beta feed still carry `<sparkle:channel>beta</sparkle:channel>`
  for the record; nothing depends on it.
- The app's "Beta Releases" toggle (default OFF, app-local) switches ONE
  value the checker and the Sparkle delegate both read: the feed URL.
  `AppcastReleaseChecker.feedURL` and `SPUUpdaterDelegate.feedURLString(for:)`
  return the beta feed when the toggle is on, the shared feed otherwise.
  Old installs never see a beta because they never read that file.
- `AppVersion.isNewer` learns the semver prerelease rule:
  `1.1.15 < 1.2.0-beta.1 < 1.2.0`. Today a non-numeric segment falls back to
  string comparison, which orders these wrong.
- Turning the toggle off while running a beta downgrades nothing. The next
  stable newer than the beta is offered as usual.

### 3. Rollback does not use Sparkle's installer

Sparkle refuses to install an item older than the running app; its standard
comparator runs at install time even with a custom comparator, and the
delegate hook for custom comparators is deprecated. So rollback is the app's
own path, reusing the feed and the key Sparkle verifies with:

1. **Target**: the newest item in the shared (stable) feed that is older
   than the running version, eligible for this macOS, and not below the
   running release's rollback floor (§3a). "Rollback to <version>" is shown
   only when such an item exists. "Get Previous Builds" opens the public
   releases page and always shows. **Identity is the numeric build**
   (`sparkle:version` = `CFBundleVersion`, the repo commit count), never the
   display version: `CFBundleShortVersionString` is what Apple restricts to
   dotted numbers, a beta's `1.2.0-beta.1` lives in `sparkle:shortVersionString`
   and is used for display and ordering only (CodeRabbit).
2. **Download** the item's enclosure to a temp file. Verify the length
   matches the enclosure's `length` and the EdDSA signature
   (`sparkle:edSignature`) over the file against `SUPublicEDKey` using
   CryptoKit `Curve25519.Signing.PublicKey` (the key is a plain base64
   32-byte ed25519 public key; Sparkle's own verifier is not public API).
   Any mismatch: delete the file, report a failure, change nothing.
3. **Mount** the DMG read-only, no browser. Verify the contained
   `ModelDeck.app` with `SecStaticCodeCheckValidity` against a designated
   requirement pinning our Team ID and bundle identifier, and require that
   its `CFBundleVersion` equals the target item's `sparkle:version`. Copy it
   to a staging directory beside the running bundle (same volume, so the
   swap is a rename). Detach the image.
4. **Swap, recoverably** (CodeRabbit): `FileManager.replaceItemAt(_:withItemAt:backupItemName:options:)`
   replaces the running bundle with the staged one in one call and keeps
   the old bundle as a named backup beside it. Record the backup path and
   the decision-0041 relaunch marker in UserDefaults, then `open -n` the
   new bundle. Only after `open` reports success does the old process
   terminate; if `open` fails, the old process moves the backup back into
   place and reports the failure, still running. The NEW app's launch
   removes the recorded backup once it is up (it is the readiness signal),
   so a swap that never launched leaves the previous bundle on disk for the
   user. The next launch's reconciliation sees a commit drift and restarts
   the background service in place, exactly as after an update.
4a. **Database compatibility is declared per release, not assumed**
   (CodeRabbit: `Store.migrate()` also rebuilds `accounts` and replaces
   `usage_estimate_fits`, and the constructor converts the file's vacuum
   mode; forward migrations prove nothing about an older daemon opening a
   newer file). Each appcast item carries `<modeldeck:rollbackFloor>` = the
   oldest release whose daemon can open the database this release writes.
   A release whose schema change an older daemon cannot open sets the floor
   to itself; otherwise the floor is inherited from the previous item.
   `release-checks.mjs` refuses a release whose notes mention a schema change
   without a floor line in `docs/release-notes/<version>.md`
   (`Rollback floor: <version>` or `Rollback floor: unchanged`). The rollback
   target must not be below the running release's floor. Known today: the
   #701 incremental auto_vacuum mode is readable by every SQLite the daemon
   has shipped with, and both table rebuilds are idempotent on a rebuilt
   file (they read the recorded DDL first), so 1.1.16's floor is unchanged.
5. **Skip the version we left.** Record
   `modeldeck.appupdate.skippedVersion = <version rolled back from>`. The
   checker and the Sparkle delegate (`bestValidUpdateInAppcast`) both hide
   exactly that version; anything newer is offered normally. An explicit
   "Check for App Updates" clears the skip, so the user can come back on
   purpose.
6. **Never touch the database, the Keychain, the registration, or Login
   Items.** A rollback is an app-bundle swap and nothing else.

### 4. What is not decided here

- Rolling back the background service without the app (not offered; the
  daemon rides inside the bundle by design, decision 0026).
- A "Get Previous Builds" browser inside the app. The releases page is enough.

## Tripwires named for the lanes

- Prerelease ordering: `1.1.15 < 1.2.0-beta.1 < 1.2.0`, `1.2.0-beta.1 < 1.2.0-beta.2`.
- With the toggle off the checker and the Sparkle delegate both read the
  shared feed URL; with it on, both read the beta feed URL; the shared feed
  never contains a beta item (release-checks refuses one).
- Rollback identity compares `CFBundleVersion` to `sparkle:version`; a
  bundle with the right display version and the wrong build is refused.
- A failed `open -n` after the swap restores the backup and leaves the old
  process running; a successful launch removes the backup.
- A target below the running release's rollback floor is never offered.
- Merging an appcast keeps prior items, caps older stables at three, keeps
  every item's signature byte-for-byte.
- Rollback target selection: newest OLDER default-channel eligible item;
  nil when none.
- Signature verify rejects a one-byte change; length mismatch rejects; a
  bundle signed by another Team ID is refused before the swap; a version
  mismatch between the target and the mounted bundle is refused.
- The skipped version is hidden and the next newer one is offered; an
  explicit check clears the skip.
