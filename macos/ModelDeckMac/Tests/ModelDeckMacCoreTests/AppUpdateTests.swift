import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #33 — app version derivation and the "Check for App Updates" state
// machine. Issue #685: the feed is the Sparkle appcast (the same one the
// installer reads), no longer the GitHub API.

@Suite("App version (issue #33)")
struct AppVersionTests {
    @Test func displayNormalizesInfoDictionaryValues() {
        #expect(AppVersion.display(of: "0.2.0") == "0.2.0")
        #expect(AppVersion.display(of: "  0.2.0\n") == "0.2.0")
        #expect(AppVersion.display(of: "") == nil)
        #expect(AppVersion.display(of: "   ") == nil)
        #expect(AppVersion.display(of: nil) == nil)
        #expect(AppVersion.display(of: 7) == nil) // non-string plist value
    }

    @Test func footerTextIsLowercaseVPrefix() {
        #expect(AppVersion.footerText(for: "0.2.0") == "v0.2.0")
        #expect(AppVersion.footerText(for: nil) == nil)
    }

    @Test func tagNormalizationStripsLeadingV() {
        #expect(AppVersion.normalized(tag: "v0.3.0") == "0.3.0")
        #expect(AppVersion.normalized(tag: "V1.0.0") == "1.0.0")
        #expect(AppVersion.normalized(tag: "0.3.0") == "0.3.0")
        // A leading "v" not followed by a digit is a name, not a prefix.
        #expect(AppVersion.normalized(tag: "vintage") == "vintage")
    }

    @Test func numericComparison() {
        #expect(AppVersion.isNewer("0.3.0", than: "0.2.0"))
        #expect(AppVersion.isNewer("v0.10.0", than: "0.9.9"))
        #expect(AppVersion.isNewer("1.0", than: "0.99.99"))
        #expect(!AppVersion.isNewer("0.2.0", than: "0.2.0"))
        #expect(!AppVersion.isNewer("0.1.9", than: "0.2.0"))
    }

    @Test func missingSegmentsReadAsZero() {
        #expect(!AppVersion.isNewer("1.2", than: "1.2.0"))
        #expect(AppVersion.isNewer("1.2.1", than: "1.2"))
    }
}

/// Scriptable release feed for the update model.
final class StubReleaseChecker: AppReleaseChecking, @unchecked Sendable {
    private let lock = NSLock()
    var result: Result<AppReleaseInfo?, Error> = .success(nil)
    private(set) var callCount = 0

    func latestRelease() async throws -> AppReleaseInfo? {
        try locked {
            callCount += 1
            return try result.get()
        }
    }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }
}

@Suite("App update model (issue #33)")
@MainActor
struct AppUpdateModelTests {
    private let releaseURL = URL(string: "https://github.com/timharris707/modeldeck/releases/tag/v0.3.0")!

    @Test func newerReleaseBecomesUpdateAvailable() async {
        let checker = StubReleaseChecker()
        let release = AppReleaseInfo(version: "0.3.0", url: releaseURL)
        checker.result = .success(release)
        let model = AppUpdateModel(checker: checker, currentVersion: "0.2.0")
        await model.check()
        #expect(model.phase == .updateAvailable(release))
    }

    @Test func sameVersionIsUpToDate() async {
        let checker = StubReleaseChecker()
        checker.result = .success(AppReleaseInfo(version: "0.2.0", url: releaseURL))
        let model = AppUpdateModel(checker: checker, currentVersion: "0.2.0")
        await model.check()
        #expect(model.phase == .upToDate(latest: "0.2.0"))
    }

    @Test func noReleasesDegradesHonestly() async {
        // The public repo may 404 until the first release ships — the model
        // must say "unavailable", never a fake "up to date".
        let checker = StubReleaseChecker()
        checker.result = .success(nil)
        let model = AppUpdateModel(checker: checker, currentVersion: "0.2.0")
        await model.check()
        #expect(model.phase == .unavailable(
            message: "Update check unavailable — no releases published yet."))
    }

    @Test func feedErrorDegradesHonestly() async {
        let checker = StubReleaseChecker()
        checker.result = .failure(URLError(.notConnectedToInternet))
        let model = AppUpdateModel(checker: checker, currentVersion: "0.2.0")
        await model.check()
        #expect(model.phase == .unavailable(
            message: "Update check unavailable — couldn't reach the releases feed."))
    }

    @Test func unknownCurrentVersionRefusesToCompare() async {
        // Unstamped dev builds have no version — refusing beats guessing.
        let checker = StubReleaseChecker()
        checker.result = .success(AppReleaseInfo(version: "0.3.0", url: releaseURL))
        let model = AppUpdateModel(checker: checker, currentVersion: nil)
        await model.check()
        #expect(model.phase == .unavailable(
            message: "This build has no version to compare (development build)."))
    }

    @Test func recheckAfterFailureCanSucceed() async {
        let checker = StubReleaseChecker()
        checker.result = .failure(URLError(.notConnectedToInternet))
        let model = AppUpdateModel(checker: checker, currentVersion: "0.2.0")
        await model.check()
        checker.result = .success(AppReleaseInfo(version: "0.2.0", url: releaseURL))
        await model.check()
        #expect(model.phase == .upToDate(latest: "0.2.0"))
        #expect(checker.callCount == 2)
    }
}

/// A single-item appcast the way scripts/generate-appcast.mjs renders it
/// (placeholder version, fake signature). `description` nil = the
/// pre-#685 shape.
func appcastXML(
    version: String, description: String? = nil, link: Bool = true, minimumSystemVersion: String = "14.0"
) -> String {
    let notesLink = link
        ? "\n            <sparkle:releaseNotesLink>https://github.com/timharris707/modeldeck/releases/tag/v\(version)</sparkle:releaseNotesLink>"
        : ""
    let body = description.map { "\n            <description><![CDATA[\($0)]]></description>" } ?? ""
    return """
    <?xml version="1.0" encoding="utf-8"?>
    <rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
        <channel>
            <title>ModelDeck</title>
            <item>
                <title>ModelDeck \(version)</title>
                <pubDate>Wed, 22 Jul 2026 12:00:00 +0000</pubDate>\(notesLink)\(body)
                <sparkle:version>512</sparkle:version>
                <sparkle:shortVersionString>\(version)</sparkle:shortVersionString>
                <sparkle:minimumSystemVersion>\(minimumSystemVersion)</sparkle:minimumSystemVersion>
                <enclosure
                    url="https://github.com/timharris707/modeldeck/releases/download/v\(version)/ModelDeck-\(version).dmg"
                    length="4096"
                    type="application/octet-stream"
                    sparkle:edSignature="FAKEsigFAKEsig00=="
                />
            </item>
        </channel>
    </rss>
    """
}

let emptyAppcastXML = """
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
    <channel>
        <title>ModelDeck</title>
    </channel>
</rss>
"""

@Suite("Appcast release checker (issues #33, #685)")
struct AppcastReleaseCheckerTests {
    @Test func decodesVersionNotesAndReleasePageFromTheAppcast() async throws {
        let transport = StubTransport(stubs: [.init(status: 200, body: appcastXML(
            version: "0.3.0",
            description: "# ModelDeck 0.3.0\n\nA lead paragraph.\n\n**Something changed.** And here is why."
        ))])
        let checker = AppcastReleaseChecker(transport: transport)
        let release = try await checker.latestRelease()
        #expect(release?.version == "0.3.0")
        #expect(release?.url.absoluteString == "https://github.com/timharris707/modeldeck/releases/tag/v0.3.0")
        #expect(release?.notes?.hasPrefix("# ModelDeck 0.3.0") == true)
        #expect(release?.notes?.contains("**Something changed.**") == true)
        // Read-only public GET — the daemon's mutation token never leaves
        // localhost, so it must not appear here.
        #expect(transport.requests.first?.value(forHTTPHeaderField: "x-modeldeck-token") == nil)
    }

    @Test func checksTheSameFeedSparkleInstallsFrom() async throws {
        let transport = StubTransport(stubs: [.init(status: 200, body: appcastXML(version: "0.3.0"))])
        _ = try await AppcastReleaseChecker(transport: transport).latestRelease()
        #expect(transport.requests.first?.url == AppcastReleaseChecker.defaultFeedURL)
        #expect(AppcastReleaseChecker.defaultFeedURL.absoluteString
            == "https://github.com/timharris707/modeldeck/releases/latest/download/appcast.xml")
    }

    // A pre-#685 appcast (no <description>) is still a perfectly good
    // release — just one with no notes to read.
    @Test func anAppcastWithoutADescriptionStillDecodes() async throws {
        let transport = StubTransport(stubs: [.init(status: 200, body: appcastXML(version: "0.3.0"))])
        let release = try await AppcastReleaseChecker(transport: transport).latestRelease()
        #expect(release?.version == "0.3.0")
        #expect(release?.notes == nil)
    }

    @Test func anEmptyChannelMeansNoReleasesYet() async throws {
        let transport = StubTransport(stubs: [.init(status: 200, body: emptyAppcastXML)])
        let release = try await AppcastReleaseChecker(transport: transport).latestRelease()
        #expect(release == nil)
    }

    // The feed has its own error domain (PR #44 review note) — feed
    // failures never masquerade as daemon client errors. #685: a 404 is a
    // broken feed now (the appcast lives on the newest release), not "no
    // releases yet".
    @Test func serverErrorThrowsFeedDomainError() async {
        let transport = StubTransport(stubs: [.init(status: 500, body: "oops")])
        await #expect(throws: AppReleaseCheckError.httpStatus(500)) {
            _ = try await AppcastReleaseChecker(transport: transport).latestRelease()
        }
        let missing = StubTransport(stubs: [.init(status: 404, body: "Not Found")])
        await #expect(throws: AppReleaseCheckError.httpStatus(404)) {
            _ = try await AppcastReleaseChecker(transport: missing).latestRelease()
        }
    }

    @Test func malformedBodyThrowsFeedDomainError() async {
        let transport = StubTransport(stubs: [.init(status: 200, body: #"{"unexpected": true}"#)])
        await #expect(throws: AppReleaseCheckError.invalidResponse) {
            _ = try await AppcastReleaseChecker(transport: transport).latestRelease()
        }
    }
}

// Issue #33 final placement decision: the gear-menu check presents a
// standard small dialog derived purely from the finished phase.
@Suite("App update result dialog (issue #33)")
@MainActor
struct AppUpdateDialogTests {
    private let releaseURL = URL(string: "https://github.com/timharris707/modeldeck/releases/tag/v0.3.0")!

    @Test func nothingToPresentWhileIdleOrChecking() {
        #expect(AppUpdateModel.dialog(for: .idle, currentVersion: "0.2.0") == nil)
        #expect(AppUpdateModel.dialog(for: .checking, currentVersion: "0.2.0") == nil)
    }

    @Test func upToDateDialogNamesTheVersion() {
        let dialog = AppUpdateModel.dialog(for: .upToDate(latest: "0.2.0"), currentVersion: "0.2.0")
        #expect(dialog?.title == "You're up to date")
        #expect(dialog?.message == "ModelDeck v0.2.0 is the latest release.")
        #expect(dialog?.releaseURL == nil) // plain OK dialog — no link button
    }

    @Test func updateAvailableDialogCarriesTheReleaseLink() {
        let release = AppReleaseInfo(version: "0.3.0", url: releaseURL)
        let dialog = AppUpdateModel.dialog(for: .updateAvailable(release), currentVersion: "0.2.0")
        #expect(dialog?.title == "Version 0.3.0 is available")
        #expect(dialog?.message == "You're running v0.2.0. View the release to download it.")
        #expect(dialog?.releaseURL == releaseURL) // → View Release + Cancel
    }

    // Issue #675: the notes travel with the dialog, heading stripped, so the
    // user reads what they are getting before clicking Update Now.
    @Test func updateAvailableDialogCarriesTheReleaseNotes() {
        let release = AppReleaseInfo(
            version: "1.1.12",
            url: releaseURL,
            notes: "# ModelDeck 1.1.12\n\nA lead paragraph.\n\n**Bold lead.** Detail."
        )
        let dialog = AppUpdateModel.dialog(for: .updateAvailable(release), currentVersion: "1.1.11")
        #expect(dialog?.releaseNotes == "A lead paragraph.\n\n**Bold lead.** Detail.")
    }

    @Test func aReleaseWithoutNotesGivesTheDialogNone() {
        let release = AppReleaseInfo(version: "0.3.0", url: releaseURL)
        let dialog = AppUpdateModel.dialog(for: .updateAvailable(release), currentVersion: "0.2.0")
        #expect(dialog?.releaseNotes == nil)
        // Nothing to read is silent, never an apology in the dialog.
        #expect(dialog?.message == "You're running v0.2.0. View the release to download it.")
    }

    @Test func unavailableDialogKeepsTheHonestMessage() {
        let dialog = AppUpdateModel.dialog(
            for: .unavailable(message: "Update check unavailable — no releases published yet."),
            currentVersion: "0.2.0"
        )
        #expect(dialog?.title == "Couldn't check for updates")
        #expect(dialog?.message == "Update check unavailable — no releases published yet.")
        #expect(dialog?.releaseURL == nil)
    }

    @Test func modelExposesTheDialogForItsOwnPhase() async {
        let checker = StubReleaseChecker()
        checker.result = .success(AppReleaseInfo(version: "0.3.0", url: releaseURL))
        let model = AppUpdateModel(checker: checker, currentVersion: "0.2.0")
        #expect(model.resultDialog == nil) // idle — nothing to present
        await model.check()
        #expect(model.resultDialog?.releaseURL == releaseURL)
    }
}

// Issue #60 — the "Check for updates automatically" toggle: daily check of
// the SAME releases feed as the manual button, banner-only outcome. The
// scheduler math and notify-once rule are pure and tested here; the hourly
// wake loop itself is a trivial sleep wrapper.
@Suite("Automatic update checks (issue #60)")
@MainActor
struct AppUpdateAutoCheckerTests {
    private let releaseURL = URL(string: "https://github.com/timharris707/modeldeck/releases/tag/v0.3.0")!

    /// Mutable test clock — advance() moves "now" forward.
    private final class TestClock: @unchecked Sendable {
        private let lock = NSLock()
        private var current = Date(timeIntervalSince1970: 1_800_000_000)
        var now: Date {
            lock.lock(); defer { lock.unlock() }
            return current
        }
        func advance(_ interval: TimeInterval) {
            lock.lock(); defer { lock.unlock() }
            current = current.addingTimeInterval(interval)
        }
    }

    private final class NotificationLog {
        var posted: [AppUpdateNotification] = []
    }

    private func freshDefaults() -> UserDefaults {
        ScratchDefaults.make("auto-update-tests")
    }

    private func makeChecker(
        checker: StubReleaseChecker,
        defaults: UserDefaults,
        clock: TestClock,
        log: NotificationLog
    ) -> AppUpdateAutoChecker {
        AppUpdateAutoChecker(
            model: AppUpdateModel(checker: checker, currentVersion: "0.2.0"),
            defaults: defaults,
            clock: { clock.now },
            notify: { log.posted.append($0) }
        )
    }

    // Issue #675 (Tim, 2026-09-19): ON out of the box. It shipped off, so a
    // fresh install checked for updates only if someone found the switch.
    @Test func enabledByDefaultAndTogglePersists() {
        let defaults = freshDefaults()
        let auto = makeChecker(
            checker: StubReleaseChecker(), defaults: defaults,
            clock: TestClock(), log: NotificationLog())
        #expect(auto.isEnabled)
        auto.setEnabled(false)
        #expect(!auto.isEnabled)
        #expect(!defaults.bool(forKey: AppUpdateAutoChecker.enabledDefaultsKey))
        auto.setEnabled(true)
        #expect(auto.isEnabled)
        #expect(defaults.bool(forKey: AppUpdateAutoChecker.enabledDefaultsKey))
    }

    // TRIPWIRE auto-check-default-on: the default must never overrule a user
    // who turned automatic checks OFF — that persisted false outlives every
    // relaunch, and re-enabling it behind their back is the regression.
    @Test func aStoredOffChoiceSurvivesTheNewDefault() {
        let defaults = freshDefaults()
        let first = makeChecker(
            checker: StubReleaseChecker(), defaults: defaults,
            clock: TestClock(), log: NotificationLog())
        first.setEnabled(false)
        // Next launch, same stored preference.
        let relaunched = makeChecker(
            checker: StubReleaseChecker(), defaults: defaults,
            clock: TestClock(), log: NotificationLog())
        #expect(!relaunched.isEnabled)
    }

    @Test func aStoredOnChoiceIsAlsoHonoured() {
        let defaults = freshDefaults()
        defaults.set(true, forKey: AppUpdateAutoChecker.enabledDefaultsKey)
        let auto = makeChecker(
            checker: StubReleaseChecker(), defaults: defaults,
            clock: TestClock(), log: NotificationLog())
        #expect(auto.isEnabled)
    }

    @Test func dueRuleIsDailyFromTheLastCheck() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(AppUpdateAutoChecker.isDue(now: now, lastCheck: nil))
        #expect(!AppUpdateAutoChecker.isDue(now: now, lastCheck: now.addingTimeInterval(-3600)))
        #expect(AppUpdateAutoChecker.isDue(
            now: now, lastCheck: now.addingTimeInterval(-AppUpdateAutoChecker.checkInterval)))
    }

    @Test func disabledNeverTouchesTheFeed() async {
        let checker = StubReleaseChecker()
        let auto = makeChecker(
            checker: checker, defaults: freshDefaults(),
            clock: TestClock(), log: NotificationLog())
        // Issue #675: the toggle now starts ON, so the off case is set here.
        auto.setEnabled(false)
        await auto.checkIfDue()
        #expect(checker.callCount == 0)
    }

    @Test func newerReleaseNotifiesOnceThenStaysQuiet() async {
        let checker = StubReleaseChecker()
        checker.result = .success(AppReleaseInfo(version: "0.3.0", url: releaseURL))
        let clock = TestClock()
        let log = NotificationLog()
        let auto = makeChecker(
            checker: checker, defaults: freshDefaults(), clock: clock, log: log)
        auto.setEnabled(true)

        await auto.checkIfDue() // never checked → due immediately
        #expect(checker.callCount == 1)
        #expect(log.posted.count == 1)
        #expect(log.posted.first?.title == "ModelDeck 0.3.0 is available")
        // Notify only — the copy says so explicitly.
        #expect(log.posted.first?.body.contains("nothing installs automatically") == true)

        // Same version discovered again tomorrow: check runs, no re-banner.
        clock.advance(AppUpdateAutoChecker.checkInterval)
        await auto.checkIfDue()
        #expect(checker.callCount == 2)
        #expect(log.posted.count == 1)
    }

    @Test func withinTheDailyIntervalNoSecondCheckHappens() async {
        let checker = StubReleaseChecker()
        checker.result = .success(nil)
        let clock = TestClock()
        let auto = makeChecker(
            checker: checker, defaults: freshDefaults(),
            clock: clock, log: NotificationLog())
        auto.setEnabled(true)

        await auto.checkIfDue()
        #expect(checker.callCount == 1)
        // The hourly scheduler wake inside the same day is a no-op.
        clock.advance(3600)
        await auto.checkIfDue()
        #expect(checker.callCount == 1)
        clock.advance(AppUpdateAutoChecker.checkInterval)
        await auto.checkIfDue()
        #expect(checker.callCount == 2)
    }

    @Test func failedCheckStampsTheClockAndRetriesTomorrowNotInALoop() async {
        let checker = StubReleaseChecker()
        checker.result = .failure(URLError(.notConnectedToInternet))
        let clock = TestClock()
        let log = NotificationLog()
        let auto = makeChecker(
            checker: checker, defaults: freshDefaults(), clock: clock, log: log)
        auto.setEnabled(true)

        await auto.checkIfDue()
        #expect(checker.callCount == 1)
        #expect(log.posted.isEmpty)
        await auto.checkIfDue() // immediately after failure: NOT due again
        #expect(checker.callCount == 1)
        clock.advance(AppUpdateAutoChecker.checkInterval)
        await auto.checkIfDue()
        #expect(checker.callCount == 2)
    }

    @Test func upToDateStaysSilent() async {
        let checker = StubReleaseChecker()
        checker.result = .success(AppReleaseInfo(version: "0.2.0", url: releaseURL))
        let log = NotificationLog()
        let auto = makeChecker(
            checker: checker, defaults: freshDefaults(), clock: TestClock(), log: log)
        auto.setEnabled(true)
        await auto.checkIfDue()
        #expect(checker.callCount == 1)
        #expect(log.posted.isEmpty)
    }

    @Test func notificationCopyNamesBothVersionsAndTheManualPath() {
        let note = AppUpdateAutoChecker.notification(
            for: AppReleaseInfo(version: "0.3.0", url: releaseURL),
            currentVersion: "0.2.0"
        )
        #expect(note.title == "ModelDeck 0.3.0 is available")
        #expect(note.body.contains("v0.2.0"))
        #expect(note.body.contains("Check for App Updates"))
        // Unstamped dev build: the body simply omits the current version.
        let devNote = AppUpdateAutoChecker.notification(
            for: AppReleaseInfo(version: "0.3.0", url: releaseURL),
            currentVersion: nil
        )
        #expect(!devNote.body.contains("You're running"))
    }
}

// Issue #675 — the release body as the dialog shows it.
@Suite("Release notes for display (issue #675)")
struct AppReleaseNotesTests {
    @Test func dropsTheReleaseHeadingTheDialogTitleAlreadyShows() {
        let raw = "# ModelDeck 1.1.12\n\nThis release fixes the update flow.\n\n- one\n- two"
        #expect(AppReleaseNotes.forDisplay(raw)
            == "This release fixes the update flow.\n\n- one\n- two")
    }

    @Test func aBodyWithNoHeadingIsLeftAlone() {
        #expect(AppReleaseNotes.forDisplay("Just a paragraph.") == "Just a paragraph.")
    }

    @Test func windowsLineEndingsAndBlankEdgesAreNormalized() {
        #expect(AppReleaseNotes.forDisplay("\r\n# ModelDeck 1.0.0\r\n\r\nBody.\r\n\r\n") == "Body.")
    }

    @Test func nothingToReadIsNil() {
        #expect(AppReleaseNotes.forDisplay(nil) == nil)
        #expect(AppReleaseNotes.forDisplay("") == nil)
        #expect(AppReleaseNotes.forDisplay("   \n\n") == nil)
        // Heading only: the dialog title already says that much.
        #expect(AppReleaseNotes.forDisplay("# ModelDeck 1.1.12\n") == nil)
    }

    @Test func aDeeperHeadingIsNotMistakenForTheTitle() {
        #expect(AppReleaseNotes.forDisplay("## Fixes\n\nBody.") == "## Fixes\n\nBody.")
    }
}
