import AppKit
import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #685 — update visibility. Tim (2026-09-19): "Updating could be a bit
// more sophisticated, it seems smoother in other apps." Three findings, three
// tripwires:
//   1. one feed — the app's update check reads the Sparkle appcast, never
//      the GitHub API, and the "feeds disagree" copy is gone;
//   2. a staged update shows on the menu-bar icon, and ONLY a staged one;
//   3. notification clicks route by the kind the poster stamps.

// MARK: - 1. One feed: the appcast

@Suite("Issue #685 — appcast decoder")
struct Issue685AppcastDecoderTests {
    @Test func decodesVersionNotesLinkAndEnclosure() throws {
        let xml = appcastXML(
            version: "9.9.9",
            description: "# ModelDeck 9.9.9\n\n**Bold lead.** Fixes a < b && c > d.\n\n- one\n- two\n"
        )
        let item = try #require(try AppcastDecoder.newestItem(from: Data(xml.utf8)))
        #expect(item.shortVersionString == "9.9.9")
        // CDATA arrives verbatim — markdown punctuation survives.
        #expect(item.description == "# ModelDeck 9.9.9\n\n**Bold lead.** Fixes a < b && c > d.\n\n- one\n- two\n")
        #expect(item.releaseNotesLink?.absoluteString
            == "https://github.com/timharris707/modeldeck/releases/tag/v9.9.9")
        #expect(item.enclosureURL?.absoluteString
            == "https://github.com/timharris707/modeldeck/releases/download/v9.9.9/ModelDeck-9.9.9.dmg")
    }

    @Test func anEmptyChannelDecodesAsNoReleases() throws {
        #expect(try AppcastDecoder.newestItem(from: Data(emptyAppcastXML.utf8)) == nil)
        #expect(try AppcastDecoder.items(from: Data(emptyAppcastXML.utf8)).isEmpty)
    }

    // The appcast published before #685 has no <description>; the app must
    // read it as "no notes", never fail the check over it.
    @Test func aPreIssue685ItemWithoutDescriptionYieldsNilNotes() throws {
        let item = try #require(try AppcastDecoder.newestItem(from: Data(appcastXML(version: "1.1.13").utf8)))
        #expect(item.description == nil)
        let release = try #require(AppcastReleaseChecker.releaseInfo(for: item))
        #expect(release.notes == nil)
        let dialog = AppUpdateModel.dialog(for: .updateAvailable(release), currentVersion: "1.1.12")
        #expect(dialog?.releaseNotes == nil)
        #expect(dialog?.title == "Version 1.1.13 is available")
    }

    @Test func notesReachTheDialogHeadingStripped() throws {
        let xml = appcastXML(version: "1.1.14", description: "# ModelDeck 1.1.14\n\nA lead paragraph.\n")
        let item = try #require(try AppcastDecoder.newestItem(from: Data(xml.utf8)))
        let release = try #require(AppcastReleaseChecker.releaseInfo(for: item))
        let dialog = AppUpdateModel.dialog(for: .updateAvailable(release), currentVersion: "1.1.13")
        #expect(dialog?.releaseNotes == "A lead paragraph.")
        #expect(dialog?.releaseURL == release.url)
    }

    @Test func notAnAppcastIsRefused() {
        #expect(throws: AppcastDecoder.DecodeError.notAnAppcast) {
            _ = try AppcastDecoder.newestItem(from: Data("{\"tag_name\": \"v1.0.0\"}".utf8))
        }
        #expect(throws: AppcastDecoder.DecodeError.notAnAppcast) {
            _ = try AppcastDecoder.newestItem(from: Data("<html><body>404</body></html>".utf8))
        }
    }

    @Test func newestItemWinsInAMultiItemFeed() throws {
        let xml = """
        <?xml version="1.0" encoding="utf-8"?>
        <rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
            <channel><title>ModelDeck</title>
                <item><sparkle:shortVersionString>1.1.12</sparkle:shortVersionString></item>
                <item><sparkle:shortVersionString>1.1.14</sparkle:shortVersionString></item>
                <item><sparkle:shortVersionString>1.1.13</sparkle:shortVersionString></item>
                <item><title>no version — skipped</title></item>
            </channel>
        </rss>
        """
        let item = try #require(try AppcastDecoder.newestItem(from: Data(xml.utf8)))
        #expect(item.shortVersionString == "1.1.14")
        #expect(try AppcastDecoder.items(from: Data(xml.utf8)).count == 3)
    }

    // A "]]>" inside the notes is split across two CDATA sections by the
    // generator; the decoder must reassemble it.
    @Test func splitCDATAReassembles() throws {
        let xml = """
        <rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
            <channel><item>
                <sparkle:shortVersionString>1.0.0</sparkle:shortVersionString>
                <description><![CDATA[before ]]]]><![CDATA[> after]]></description>
            </item></channel>
        </rss>
        """
        let item = try #require(try AppcastDecoder.newestItem(from: Data(xml.utf8)))
        #expect(item.description == "before ]]> after")
    }

    // CodeRabbit (PR #686): an item whose minimumSystemVersion is above the
    // running macOS is one Sparkle refuses at install time — offering it as
    // Update Now would end in a visible failure. The decoder skips it and
    // answers with the newest item this Mac CAN run.
    @Test func anItemNeedingANewerMacOSIsSkippedForTheNewestEligibleOne() throws {
        let xml = """
        <?xml version="1.0" encoding="utf-8"?>
        <rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
            <channel><title>ModelDeck</title>
                <item>
                    <sparkle:shortVersionString>1.2.0</sparkle:shortVersionString>
                    <sparkle:minimumSystemVersion>15.0</sparkle:minimumSystemVersion>
                </item>
                <item>
                    <sparkle:shortVersionString>1.1.14</sparkle:shortVersionString>
                    <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>
                </item>
            </channel>
        </rss>
        """
        let sonoma = OperatingSystemVersion(majorVersion: 14, minorVersion: 6, patchVersion: 1)
        let item = try #require(try AppcastDecoder.newestItem(from: Data(xml.utf8), runningSystem: sonoma))
        #expect(item.shortVersionString == "1.1.14")
        // On a Mac that meets the floor, the newest wins as before.
        let sequoia = OperatingSystemVersion(majorVersion: 15, minorVersion: 0, patchVersion: 0)
        #expect(try AppcastDecoder.newestItem(from: Data(xml.utf8), runningSystem: sequoia)?
            .shortVersionString == "1.2.0")
    }

    @Test func aFeedWhoseEveryItemNeedsANewerMacOSReportsNoUpdate() async throws {
        let xml = appcastXML(version: "2.0.0", minimumSystemVersion: "26.0")
        let ventura = OperatingSystemVersion(majorVersion: 13, minorVersion: 6, patchVersion: 0)
        #expect(try AppcastDecoder.newestItem(from: Data(xml.utf8), runningSystem: ventura) == nil)
        // Through the checker: nil, the same honest "nothing to offer".
        let transport = StubTransport(stubs: [.init(status: 200, body: xml)])
        let checker = AppcastReleaseChecker(transport: transport, runningSystem: ventura)
        #expect(try await checker.latestRelease() == nil)
    }

    @Test func eligibilityIsAMajorMinorPatchCompare() {
        func item(_ floor: String?) -> AppcastItem {
            AppcastItem(shortVersionString: "1.0.0", minimumSystemVersion: floor)
        }
        let running = OperatingSystemVersion(majorVersion: 14, minorVersion: 6, patchVersion: 1)
        #expect(item("14.0").isEligible(on: running))
        #expect(item("14.6.1").isEligible(on: running))
        #expect(item("14.6").isEligible(on: running))
        #expect(!item("14.6.2").isEligible(on: running))
        #expect(!item("14.7").isEligible(on: running))
        #expect(!item("15.0").isEligible(on: running))
        #expect(item("13.5").isEligible(on: running))
        // No floor, or one the decoder cannot read: never hide a release
        // over a field it cannot compare.
        #expect(item(nil).isEligible(on: running))
        #expect(item("").isEligible(on: running))
        #expect(item("soon").isEligible(on: running))
    }

    // Astra round 2 (PR #686): a malformed floor must read as "unreadable,
    // eligible", never as a real floor — "14..1" once became 14.1.0 and
    // ".15" became 15.0.0, hiding releases Sparkle itself would install.
    // Driven through the decoder, floor text verbatim from the feed.
    @Test func aMalformedFloorIsUnreadableAndNeverHidesARelease() throws {
        let running = OperatingSystemVersion(majorVersion: 14, minorVersion: 0, patchVersion: 1)
        for floor in ["14..1", ".15", "14.", "14.0.1.2", "", " ", "14.a", "-14", "14.0.1.", "+14"] {
            let xml = appcastXML(version: "1.1.14", minimumSystemVersion: floor)
            let item = try #require(try AppcastDecoder.newestItem(from: Data(xml.utf8), runningSystem: running),
                "floor \"\(floor)\" must be unreadable → eligible, not a hidden release")
            #expect(item.shortVersionString == "1.1.14")
            #expect(AppcastItem.parsedFloor(floor.trimmingCharacters(in: .whitespacesAndNewlines)) == nil,
                "floor \"\(floor)\" parsed as a real floor")
        }
    }

    @Test func aReadableFloorHasOneToThreeNonEmptyIntegerComponents() {
        #expect(AppcastItem.parsedFloor("14") == [14, 0, 0])
        #expect(AppcastItem.parsedFloor("14.0") == [14, 0, 0])
        #expect(AppcastItem.parsedFloor("14.0.1") == [14, 0, 1])
        #expect(AppcastItem.parsedFloor("26.1") == [26, 1, 0])
        #expect(AppcastItem.parsedFloor(nil) == nil)
        // Four components: Sparkle treats the extra one as significant, so
        // truncating could invent a floor it would not apply — unreadable.
        #expect(AppcastItem.parsedFloor("14.0.1.2") == nil)
    }

    @Test func feedURLPrefersTheBundlesSUFeedURL() {
        #expect(AppcastReleaseChecker.feedURL(bundle: Bundle(for: BundleAnchor.self))
            == AppcastReleaseChecker.defaultFeedURL) // the test bundle has no SUFeedURL
    }

    private final class BundleAnchor {}
}

// TRIPWIRE one-feed: discovery must never read the GitHub API again, and
// the "feeds disagree" copy must never come back — neither can exist once
// the check reads the appcast Sparkle installs from.
@Suite("Issue #685 — one-feed source tripwire")
struct Issue685OneFeedTripwireTests {
    private func coreSource(_ file: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // .../Tests/ModelDeckMacCoreTests
            .deletingLastPathComponent()   // .../Tests
            .deletingLastPathComponent()   // .../ModelDeckMac (package root)
            .appendingPathComponent("Sources/ModelDeckMacCore/\(file)")
        return try String(contentsOf: url, encoding: .utf8)
    }

    @Test func theUpdateCheckNeverReferencesTheGitHubAPI() throws {
        let source = try coreSource("AppUpdate.swift")
        #expect(!source.contains("api.github.com"))
        #expect(!source.contains("GitHubReleaseChecker"))
        #expect(!source.contains("releases/latest\""))
        #expect(source.contains("releases/latest/download/appcast.xml"))
    }

    @Test func theFeedDisagreementCopyIsGone() throws {
        let source = try coreSource("AppUpdateInstall.swift")
        #expect(!source.contains("The update feed has no newer version yet"))
        #expect(!source.contains("feedNoNewerVersionMessage"))
    }
}

// MARK: - 2. Staged-update mark on the menu-bar icon

@Suite("Issue #685 — staged-update mark on the menu-bar icon")
struct Issue685StagedMarkTests {
    /// Every icon state, health colours included.
    private static let allStates: [MenuBarIconState] = [
        .loading, .plain,
        .pinned(percentRemaining: 52),
        .warning(percentRemaining: 22),
        .critical(percentRemaining: 3),
        .health(provider: .claude, verdict: .green),
        .health(provider: .claude, verdict: .yellow),
        .health(provider: .codex, verdict: .red),
        .health(provider: .codex, verdict: nil),
    ]

    @Test func theMarkDrawsOnlyWhileAnUpdateIsStaged() {
        #expect(MenuBarIconRenderer.stagedMarkRect(updateStaged: false) == nil)
        #expect(MenuBarIconRenderer.stagedMarkRect(updateStaged: true) != nil)
    }

    @Test func theMarkSitsInTheGlyphsClearTopRightCorner() throws {
        let rect = try #require(MenuBarIconRenderer.stagedMarkRect(updateStaged: true))
        #expect(rect.width == 3 && rect.height == 3)
        // Inside the 16 x 16 glyph, right of the 12-wide top bar.
        #expect(rect.minX >= DeckGlyphGeometry.barWidthsTopToBottom[0])
        #expect(rect.maxX <= DeckGlyphGeometry.designWidth)
        #expect(rect.maxY <= 16)
    }

    @Test func theLabelImageSpeaksTheMarkOnlyWhenStaged() {
        for state in Self.allStates {
            let quiet = MenuBarIconRenderer.labelImage(for: state, updateStaged: false)
            let marked = MenuBarIconRenderer.labelImage(for: state, updateStaged: true)
            #expect(quiet.accessibilityDescription?.contains("update ready") != true, "\(state)")
            #expect(marked.accessibilityDescription?.contains("update ready to install") == true, "\(state)")
            // The mark rides the existing image; it never changes the
            // template decision or the label's footprint.
            #expect(quiet.isTemplate == marked.isTemplate, "\(state)")
            #expect(quiet.size == marked.size, "\(state)")
        }
    }

    @Test func thePlainGlyphIsUntouchedWithoutAStagedUpdate() {
        #expect(MenuBarIconRenderer.labelImage(for: .plain) === MenuBarIconRenderer.deckGlyph)
        #expect(MenuBarIconRenderer.labelImage(for: .plain, updateStaged: false) === MenuBarIconRenderer.deckGlyph)
        let marked = MenuBarIconRenderer.labelImage(for: .plain, updateStaged: true)
        #expect(marked !== MenuBarIconRenderer.deckGlyph)
        #expect(marked.isTemplate) // template-safe: the menu bar tints it
    }

    /// The icon's condition is the #241 prompt model's staged version — the
    /// exact state behind the deck banner (prompting) and badge (badged).
    @Test @MainActor func theMarkFollowsThePromptModelsStagedState() {
        let defaults = ScratchDefaults.make("issue685-mark")
        let installModel = AppUpdateInstallModel(defaults: defaults)
        let prompt = AppUpdateStagedPromptModel(installModel: installModel, defaults: defaults) { _ in }
        #expect(prompt.stagedVersion == nil) // hidden → no mark

        installModel.report(.installedPendingRelaunch(version: "1.1.14"))
        #expect(prompt.stagedVersion == "1.1.14") // prompting → mark
        prompt.dismissPrompt()
        #expect(prompt.stagedVersion == "1.1.14") // badged → mark stays

        // Restart clicked: the install phase moves on and the mark clears.
        installModel.report(.checking)
        #expect(prompt.stagedVersion == nil)
        // "Available but not staged" never marks: a plain .idle after a
        // background check that found something stays quiet.
        installModel.report(.idle)
        #expect(prompt.stagedVersion == nil)
    }
}

// MARK: - 3. Clickable notifications

@Suite("Issue #685 — notification click routing")
struct Issue685NotificationRoutingTests {
    @Test func stagedUpdateClickRestarts() {
        #expect(UserNotificationClickRouter.action(
            categoryIdentifier: UserNotificationKind.updateStaged.rawValue, isDefaultAction: true)
            == .restartToUpdate)
    }

    @Test func usageClickOpensTheDeck() {
        #expect(UserNotificationClickRouter.action(
            categoryIdentifier: UserNotificationKind.usage.rawValue, isDefaultAction: true)
            == .openDeck)
    }

    @Test func unknownKindsAndDismissalsDoNothing() {
        #expect(UserNotificationClickRouter.action(categoryIdentifier: "", isDefaultAction: true) == .none)
        #expect(UserNotificationClickRouter.action(categoryIdentifier: "com.example.other", isDefaultAction: true) == .none)
        // "Available" is informational; the copy already says what to do.
        #expect(UserNotificationClickRouter.action(
            categoryIdentifier: UserNotificationKind.updateAvailable.rawValue, isDefaultAction: true) == .none)
        // A dismissal (or a custom action) is not a click on the banner.
        for kind in UserNotificationKind.allCases {
            #expect(UserNotificationClickRouter.action(categoryIdentifier: kind.rawValue, isDefaultAction: false) == .none)
        }
    }

    // The poster stamps the kind — and keeps the identifiers, sound rule,
    // and copy exactly as before #685 (nothing about when banners fire or
    // what they say changes).
    @Test func thePosterStampsTheKind() {
        let usage = UserNotificationRequestSpec.usage(
            UsageAlert(level: .critical, title: "T", body: "B"))
        #expect(usage.kind == .usage)
        #expect(usage.identifier == "modeldeck.usage.level-2")
        #expect(usage.sound)
        #expect(usage.title == "T" && usage.body == "B")

        let warning = UserNotificationRequestSpec.usage(
            UsageAlert(level: .warning, title: "T", body: "B"))
        #expect(warning.kind == .usage)
        #expect(warning.identifier == "modeldeck.usage.level-1")
        #expect(!warning.sound)

        let drop = UserNotificationRequestSpec.usage(
            UsageAlert(level: .critical, title: "T", body: "B", identityKey: "modeldrop.s1"))
        #expect(drop.kind == .usage)
        #expect(drop.identifier == "modeldeck.modeldrop.s1")

        let available = UserNotificationRequestSpec.updateAvailable(
            AppUpdateNotification(title: "ModelDeck 1.1.14 is available", body: "B"))
        #expect(available.kind == .updateAvailable)
        #expect(available.identifier == "modeldeck.appupdate.available")
        #expect(!available.sound)

        let staged = UserNotificationRequestSpec.updateStaged(
            AppUpdateStagedPromptModel.notification(version: "1.1.14"))
        #expect(staged.kind == .updateStaged)
        #expect(staged.identifier == "modeldeck.appupdate.staged")
        #expect(staged.title == "ModelDeck 1.1.14 is ready")
        #expect(!staged.sound)
    }

    // Astra review (PR #686): the router's enum alone could not catch a
    // delegate that decides right and then calls nothing. These drive the
    // Core handler the app-target adapter hands every response to, and pin
    // that the right callback fires exactly once and completion always once.
    @MainActor
    private final class HandlerLog {
        var restarts = 0
        var opens = 0
        var completions = 0
    }

    @MainActor
    private func makeHandler() -> (UserNotificationClickHandler, HandlerLog) {
        let log = HandlerLog()
        let handler = UserNotificationClickHandler(
            onRestartToUpdate: { log.restarts += 1 },
            onOpenDeck: { log.opens += 1 }
        )
        return (handler, log)
    }

    @Test @MainActor func theHandlerRunsRestartForAStagedClickAndCompletesOnce() {
        let (handler, log) = makeHandler()
        handler.handle(
            categoryIdentifier: UserNotificationKind.updateStaged.rawValue,
            isDefaultAction: true
        ) { log.completions += 1 }
        #expect(log.restarts == 1)
        #expect(log.opens == 0)
        #expect(log.completions == 1)
    }

    @Test @MainActor func theHandlerOpensTheDeckForAUsageClickAndCompletesOnce() {
        let (handler, log) = makeHandler()
        handler.handle(
            categoryIdentifier: UserNotificationKind.usage.rawValue,
            isDefaultAction: true
        ) { log.completions += 1 }
        #expect(log.opens == 1)
        #expect(log.restarts == 0)
        #expect(log.completions == 1)
    }

    @Test @MainActor func theHandlerDoesNothingForUnknownOrDismissedButStillCompletes() {
        let (handler, log) = makeHandler()
        handler.handle(categoryIdentifier: "com.example.other", isDefaultAction: true) { log.completions += 1 }
        handler.handle(categoryIdentifier: "", isDefaultAction: true) { log.completions += 1 }
        handler.handle(
            categoryIdentifier: UserNotificationKind.updateAvailable.rawValue, isDefaultAction: true
        ) { log.completions += 1 }
        // A dismissal of a staged banner must never restart the app.
        handler.handle(
            categoryIdentifier: UserNotificationKind.updateStaged.rawValue, isDefaultAction: false
        ) { log.completions += 1 }
        #expect(log.restarts == 0)
        #expect(log.opens == 0)
        #expect(log.completions == 4)
    }

    @Test func kindsAreDistinctReverseDNSStrings() {
        let raws = UserNotificationKind.allCases.map(\.rawValue)
        #expect(Set(raws).count == raws.count)
        for raw in raws { #expect(raw.hasPrefix("modeldeck.kind.")) }
    }
}
