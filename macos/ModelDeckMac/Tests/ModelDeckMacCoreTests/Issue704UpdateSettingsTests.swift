import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #704: manual checks and the automatic schedule share one persisted
// date, including across launches. Tests never read the installed app's defaults.
@Suite("Issue #704 update settings")
@MainActor
struct Issue704UpdateSettingsTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let tagURL = URL(string: "https://github.com/timharris707/modeldeck/releases/tag/v1.1.15")!

    @Test(arguments: ["1.1.15", "1.1.16", nil])
    func explicitCheckStampsReachedFeed(version: String?) async {
        let defaults = ScratchDefaults.make("issue704")
        let checker = StubReleaseChecker()
        checker.result = .success(version.map { AppReleaseInfo(version: $0, url: tagURL) })
        let now = now
        let model = AppUpdateModel(checker: checker, currentVersion: "1.1.15",
                                   defaults: defaults, clock: { now })
        _ = await model.explicitCheck()
        #expect(defaults.object(forKey: "modeldeck.appupdate.lastAutoCheckAt") as? Date == now)
    }

    @Test func transportFailurePreservesPreviousStamp() async {
        let defaults = ScratchDefaults.make("issue704")
        let previous = now.addingTimeInterval(-3600)
        defaults.set(previous, forKey: AppUpdateAutoChecker.lastCheckDefaultsKey)
        let checker = StubReleaseChecker()
        checker.result = .failure(URLError(.notConnectedToInternet))
        let now = now
        let model = AppUpdateModel(checker: checker, currentVersion: "1.1.15",
                                   defaults: defaults, clock: { now })
        _ = await model.explicitCheck()
        #expect(defaults.object(forKey: AppUpdateAutoChecker.lastCheckDefaultsKey) as? Date == previous)
    }

    @Test func reachedButInvalidFeedStillStamps() async {
        let defaults = ScratchDefaults.make("issue704")
        let checker = StubReleaseChecker()
        checker.result = .failure(AppReleaseCheckError.httpStatus(503))
        let now = now
        let model = AppUpdateModel(checker: checker, defaults: defaults, clock: { now })
        _ = await model.explicitCheck()
        #expect(defaults.object(forKey: AppUpdateAutoChecker.lastCheckDefaultsKey) as? Date == now)
    }

    @Test func explicitCheckDelaysAutomaticCheckUsingExistingKey() async {
        let defaults = ScratchDefaults.make("issue704")
        let checker = StubReleaseChecker()
        let now = now
        let model = AppUpdateModel(checker: checker, defaults: defaults, clock: { now })
        _ = await model.explicitCheck()
        let auto = AppUpdateAutoChecker(model: model, defaults: defaults,
                                        clock: { now.addingTimeInterval(3600) }, notify: { _ in })
        await auto.checkIfDue()
        #expect(checker.callCount == 1)
        #expect(auto.lastCheckAt == now)
        let due = AppUpdateAutoChecker(model: model, defaults: defaults,
            clock: { now.addingTimeInterval(AppUpdateAutoChecker.checkInterval) }, notify: { _ in })
        await due.checkIfDue()
        #expect(checker.callCount == 2)
    }
    @Test func currentVersionNotesStayAvailableAfterAnUpToDateCheck() async {
        let checker = StubReleaseChecker()
        let release = AppReleaseInfo(version: "1.1.15", url: tagURL,
                                     notes: "# ModelDeck 1.1.15\n\n**Fixed.** A useful change.")
        checker.result = .success(release)
        let model = AppUpdateModel(checker: checker, currentVersion: "1.1.15",
                                   defaults: ScratchDefaults.make("issue704"))
        await model.check()
        #expect(model.phase == .upToDate(latest: "1.1.15"))
        #expect(model.latestKnownRelease == release)
        #expect(AppReleaseNotes.resolve(currentVersion: model.currentVersion, latestRelease: model.latestKnownRelease)
            == .inApp(version: "1.1.15", body: "**Fixed.** A useful change."))
        checker.result = .failure(URLError(.notConnectedToInternet))
        await model.check()
        #expect(model.latestKnownRelease == release)
        checker.result = .success(nil)
        await model.check()
        #expect(model.latestKnownRelease == nil)
    }

    @Test func notesFallBackToTheRunningVersionsTag() {
        for version in ["1.1.14", "1.1.16"] {
            let release = AppReleaseInfo(version: version,
                url: URL(string: "https://example.invalid/newest")!, notes: "Other version's notes")
            #expect(AppReleaseNotes.resolve(currentVersion: "1.1.15", latestRelease: release) == .web(tagURL))
        }
        #expect(AppReleaseNotes.resolve(currentVersion: "1.1.15", latestRelease: nil) == .web(tagURL))
        #expect(AppReleaseNotes.resolve(currentVersion: "1.1.15",
            latestRelease: AppReleaseInfo(version: "1.1.15", url: tagURL)) == .web(tagURL))
        #expect(AppcastReleaseChecker.releaseInfo(for: AppcastItem(shortVersionString: "1.1.15"))?.url == tagURL)
    }

    @Test func nonNilEmptyDescriptionStillResolvesInApp() {
        #expect(AppReleaseNotes.resolve(currentVersion: "1.1.15",
            latestRelease: AppReleaseInfo(version: "1.1.15", url: tagURL, notes: ""))
            == .inApp(version: "1.1.15", body: ""))
    }

}
