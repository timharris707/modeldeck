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
