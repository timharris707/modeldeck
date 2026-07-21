import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #33 — app version derivation and the "Check for App Updates" state
// machine (GitHub releases feed of the public repo; link-out only, no
// self-replacing updater — that's issue #16's signed DMG work).

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

@Suite("GitHub release checker (issue #33)")
struct GitHubReleaseCheckerTests {
    @Test func decodesTagAndReleasePage() async throws {
        let transport = StubTransport(stubs: [.init(status: 200, body: #"""
        {"tag_name": "v0.3.0", "html_url": "https://github.com/timharris707/modeldeck/releases/tag/v0.3.0", "name": "ModelDeck 0.3.0"}
        """#)])
        let checker = GitHubReleaseChecker(transport: transport)
        let release = try await checker.latestRelease()
        #expect(release?.version == "0.3.0")
        #expect(release?.url.absoluteString == "https://github.com/timharris707/modeldeck/releases/tag/v0.3.0")
        // Read-only public GET — the daemon's mutation token never leaves
        // localhost, so it must not appear here.
        #expect(transport.requests.first?.value(forHTTPHeaderField: "x-modeldeck-token") == nil)
    }

    @Test func notFoundMeansNoReleasesYet() async throws {
        let transport = StubTransport(stubs: [.init(status: 404, body: #"{"message": "Not Found"}"#)])
        let release = try await GitHubReleaseChecker(transport: transport).latestRelease()
        #expect(release == nil)
    }

    // The feed has its own error domain (PR #44 review note) — GitHub
    // failures never masquerade as daemon client errors.
    @Test func serverErrorThrowsFeedDomainError() async {
        let transport = StubTransport(stubs: [.init(status: 500, body: "oops")])
        await #expect(throws: AppReleaseCheckError.httpStatus(500)) {
            _ = try await GitHubReleaseChecker(transport: transport).latestRelease()
        }
    }

    @Test func malformedBodyThrowsFeedDomainError() async {
        let transport = StubTransport(stubs: [.init(status: 200, body: #"{"unexpected": true}"#)])
        await #expect(throws: AppReleaseCheckError.invalidResponse) {
            _ = try await GitHubReleaseChecker(transport: transport).latestRelease()
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
        let suite = "auto-update-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
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

    @Test func disabledByDefaultAndTogglePersists() {
        let defaults = freshDefaults()
        let auto = makeChecker(
            checker: StubReleaseChecker(), defaults: defaults,
            clock: TestClock(), log: NotificationLog())
        #expect(!auto.isEnabled)
        auto.setEnabled(true)
        #expect(auto.isEnabled)
        #expect(defaults.bool(forKey: AppUpdateAutoChecker.enabledDefaultsKey))
        auto.setEnabled(false)
        #expect(!defaults.bool(forKey: AppUpdateAutoChecker.enabledDefaultsKey))
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
