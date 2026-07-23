import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #121 — Sparkle 2 in-app updates (Tim directive 2026-07-22). These
// tests cover the Sparkle-FREE core: the install state machine, the
// "Install updates automatically" preference (default ON), the dialog's
// Update Now upgrade, and the auto-checker's hand-off modes. Sparkle itself
// is seamed behind `AppUpdateInstalling` and is not under test.

/// Scriptable driver standing in for SparkleUpdateDriver.
@MainActor
private final class StubInstallDriver: AppUpdateInstalling {
    private(set) var beginInstallCount = 0
    private(set) var backgroundCheckCount = 0
    private(set) var autoInstallValues: [Bool] = []

    func beginInstall() { beginInstallCount += 1 }
    func checkInBackground() { backgroundCheckCount += 1 }
    func setAutomaticInstallEnabled(_ enabled: Bool) { autoInstallValues.append(enabled) }
}

private func freshDefaults() -> UserDefaults {
    let suite = "install-update-tests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    return defaults
}

@Suite("App update install model (issue #121)")
@MainActor
struct AppUpdateInstallModelTests {
    @Test func autoInstallDefaultsOn() {
        // Tim's call on #121: automatic install is ON until turned off —
        // an absent key must read true, not false.
        let model = AppUpdateInstallModel(defaults: freshDefaults())
        #expect(model.isAutoInstallEnabled)
    }

    @Test func clearTransientProgressPreservesTerminalStates() {
        // A staged pending-relaunch must survive a later background-check
        // error (the driver clears via this method, never a bare idle).
        let model = AppUpdateInstallModel(defaults: freshDefaults())
        model.report(.installedPendingRelaunch(version: "0.4.0"))
        model.clearTransientProgress()
        guard case .installedPendingRelaunch(let version) = model.phase else {
            Issue.record("pending-relaunch was clobbered"); return
        }
        #expect(version == "0.4.0")

        model.report(.failed(message: "boom"))
        model.clearTransientProgress()
        guard case .failed = model.phase else {
            Issue.record("failure state was clobbered"); return
        }

        model.report(.downloading(fraction: 0.5))
        model.clearTransientProgress()
        guard case .idle = model.phase else {
            Issue.record("transient progress was not cleared"); return
        }
    }

    @Test func autoInstallTogglePersistsAndRereads() {
        let defaults = freshDefaults()
        let model = AppUpdateInstallModel(defaults: defaults)
        model.setAutoInstall(false)
        #expect(!model.isAutoInstallEnabled)
        #expect(AppUpdateInstallModel.storedAutoInstall(defaults) == false)
        // A second model over the same store sees the stored choice.
        #expect(!AppUpdateInstallModel(defaults: defaults).isAutoInstallEnabled)
        model.setAutoInstall(true)
        #expect(AppUpdateInstallModel.storedAutoInstall(defaults) == true)
    }

    @Test func attachPushesThePreferenceIntoTheDriver() {
        let model = AppUpdateInstallModel(defaults: freshDefaults())
        let driver = StubInstallDriver()
        model.attach(driver: driver)
        #expect(model.canInstall)
        #expect(driver.autoInstallValues == [true])
        model.setAutoInstall(false)
        #expect(driver.autoInstallValues == [true, false])
    }

    @Test func updateNowWithoutDriverFailsHonestly() {
        // Dev builds / pre-Sparkle bundles have no driver: the button must
        // say so, never silently no-op or pretend to install.
        let model = AppUpdateInstallModel(defaults: freshDefaults())
        model.updateNow()
        guard case .failed(let message) = model.phase else {
            Issue.record("expected .failed, got \(model.phase)")
            return
        }
        #expect(message.contains("isn't available in this build"))
    }

    @Test func updateNowStartsTheDriverOnceAndIgnoresReentry() {
        let model = AppUpdateInstallModel(defaults: freshDefaults())
        let driver = StubInstallDriver()
        model.attach(driver: driver)
        model.updateNow()
        #expect(model.phase == .checking)
        #expect(driver.beginInstallCount == 1)
        // Busy: a second click cannot start a second install.
        model.updateNow()
        #expect(driver.beginInstallCount == 1)
        // Terminal failure: retry is allowed again.
        model.report(.failed(message: "Update failed — x"))
        model.updateNow()
        #expect(driver.beginInstallCount == 2)
    }

    @Test func backgroundCheckRequiresDriverAndIdleness() {
        let model = AppUpdateInstallModel(defaults: freshDefaults())
        model.backgroundCheck() // no driver → no-op, no phase change
        #expect(model.phase == .idle)
        let driver = StubInstallDriver()
        model.attach(driver: driver)
        model.backgroundCheck()
        #expect(driver.backgroundCheckCount == 1)
        model.report(.downloading(fraction: 0.5))
        model.backgroundCheck() // busy → never a second concurrent session
        #expect(driver.backgroundCheckCount == 1)
    }

    @Test func busyCoversExactlyTheInFlightPhases() {
        let model = AppUpdateInstallModel(defaults: freshDefaults())
        for phase: AppUpdateInstallPhase in [
            .checking, .downloading(fraction: nil), .downloading(fraction: 0.4),
            .extracting(fraction: 0.9), .installing,
        ] {
            model.report(phase)
            #expect(model.isBusy, "\(phase) should read busy")
        }
        for phase: AppUpdateInstallPhase in [
            .idle, .installedPendingRelaunch(version: "0.4.0"), .failed(message: "x"),
        ] {
            model.report(phase)
            #expect(!model.isBusy, "\(phase) should not read busy")
        }
    }

    @Test func statusTextIsHonestPerPhase() {
        #expect(AppUpdateInstallModel.statusText(for: .idle) == nil)
        #expect(AppUpdateInstallModel.statusText(for: .checking) == "Checking the update feed…")
        #expect(AppUpdateInstallModel.statusText(for: .downloading(fraction: nil)) == "Downloading update…")
        #expect(AppUpdateInstallModel.statusText(for: .downloading(fraction: 0.42)) == "Downloading update… 42%")
        #expect(AppUpdateInstallModel.statusText(for: .extracting(fraction: 0.5)) == "Preparing update… 50%")
        #expect(AppUpdateInstallModel.statusText(for: .installing) == "Installing — ModelDeck will relaunch.")
        #expect(AppUpdateInstallModel.statusText(for: .installedPendingRelaunch(version: "0.4.0"))
            == "v0.4.0 is downloaded and installs the next time ModelDeck relaunches.")
        #expect(AppUpdateInstallModel.statusText(for: .failed(message: "Update failed — boom")) == "Update failed — boom")
    }
}

@Suite("Update-found dialog with install capability (issue #121)")
@MainActor
struct AppUpdateInstallDialogTests {
    private let releaseURL = URL(string: "https://github.com/timharris707/modeldeck/releases/tag/v0.4.0")!

    @Test func installCapableDialogOffersUpdateNow() {
        let release = AppReleaseInfo(version: "0.4.0", url: releaseURL)
        let dialog = AppUpdateModel.dialog(
            for: .updateAvailable(release), currentVersion: "0.3.1", canInstall: true)
        #expect(dialog?.offersInstall == true)
        #expect(dialog?.releaseURL == releaseURL) // "Release Notes" secondary
        #expect(dialog?.message == "You're running v0.3.1. Update Now downloads, verifies, and installs it, then relaunches ModelDeck.")
    }

    @Test func withoutInstallCapabilityTheOldHandOffStands() {
        // Pre-Sparkle installs and dev builds: unchanged View Release path.
        let release = AppReleaseInfo(version: "0.4.0", url: releaseURL)
        let dialog = AppUpdateModel.dialog(
            for: .updateAvailable(release), currentVersion: "0.3.1", canInstall: false)
        #expect(dialog?.offersInstall == false)
        #expect(dialog?.message == "You're running v0.3.1. View the release to download it.")
    }

    @Test func modelDialogFollowsItsInstallFlag() async {
        let checker = StubReleaseChecker()
        checker.result = .success(AppReleaseInfo(version: "0.4.0", url: releaseURL))
        let model = AppUpdateModel(checker: checker, currentVersion: "0.3.1")
        await model.check()
        #expect(model.resultDialog?.offersInstall == false)
        model.canInstallUpdates = true
        #expect(model.resultDialog?.offersInstall == true)
    }

    @Test func nonUpdateDialogsNeverOfferInstall() {
        #expect(AppUpdateModel.dialog(
            for: .upToDate(latest: "0.3.1"), currentVersion: "0.3.1", canInstall: true)?.offersInstall == false)
        #expect(AppUpdateModel.dialog(
            for: .unavailable(message: "x"), currentVersion: "0.3.1", canInstall: true)?.offersInstall == false)
    }
}

@Suite("Auto checker hand-off (issue #121)")
@MainActor
struct AppUpdateAutoCheckerInstallTests {
    private let releaseURL = URL(string: "https://github.com/timharris707/modeldeck/releases/tag/v0.4.0")!

    private struct Rig {
        let checker: StubReleaseChecker
        let driver: StubInstallDriver
        let installModel: AppUpdateInstallModel
        let auto: AppUpdateAutoChecker
        let log: Log
    }

    final class Log { var posted: [AppUpdateNotification] = [] }

    private func makeRig(attachDriver: Bool = true, autoInstall: Bool = true) -> Rig {
        let defaults = freshDefaults()
        let checker = StubReleaseChecker()
        checker.result = .success(AppReleaseInfo(version: "0.4.0", url: releaseURL))
        let installModel = AppUpdateInstallModel(defaults: defaults)
        let driver = StubInstallDriver()
        if attachDriver { installModel.attach(driver: driver) }
        installModel.setAutoInstall(autoInstall)
        let log = Log()
        let auto = AppUpdateAutoChecker(
            model: AppUpdateModel(checker: checker, currentVersion: "0.3.1"),
            installModel: installModel,
            defaults: defaults,
            clock: { Date(timeIntervalSince1970: 1_800_000_000) },
            notify: { log.posted.append($0) }
        )
        auto.setEnabled(true)
        return Rig(checker: checker, driver: driver, installModel: installModel, auto: auto, log: log)
    }

    @Test func autoInstallOnHandsOffToTheDriverQuietly() async {
        let rig = makeRig(autoInstall: true)
        await rig.auto.checkIfDue()
        #expect(rig.driver.backgroundCheckCount == 1)
        #expect(rig.log.posted.count == 1)
        #expect(rig.log.posted.first?.body.contains("installs the next time ModelDeck relaunches") == true)
    }

    @Test func autoInstallOffNotifiesAboutUpdateNow() async {
        let rig = makeRig(autoInstall: false)
        await rig.auto.checkIfDue()
        #expect(rig.driver.backgroundCheckCount == 0) // nothing downloads
        #expect(rig.log.posted.first?.body.contains("Update Now") == true)
        #expect(rig.log.posted.first?.body.contains("nothing installs until you do") == true)
    }

    @Test func withoutDriverLegacyNotifyCopyStands() async {
        // Pre-Sparkle migration path: the checker still works and stays
        // honest about the manual install.
        let rig = makeRig(attachDriver: false, autoInstall: true)
        await rig.auto.checkIfDue()
        #expect(rig.log.posted.first?.body.contains("nothing installs automatically") == true)
    }

    @Test func notificationCopyPerMode() {
        let release = AppReleaseInfo(version: "0.4.0", url: releaseURL)
        let manual = AppUpdateAutoChecker.notification(for: release, currentVersion: "0.3.1", mode: .notifyOnly)
        #expect(manual.body.contains("nothing installs automatically"))
        let updateNow = AppUpdateAutoChecker.notification(for: release, currentVersion: "0.3.1", mode: .updateNow)
        #expect(updateNow.body.contains("Update Now"))
        let autoBody = AppUpdateAutoChecker.notification(for: release, currentVersion: "0.3.1", mode: .automaticInstall)
        #expect(autoBody.body.contains("relaunches"))
        // The 2-arg legacy signature (issue #60 tests, pre-Sparkle callers)
        // must keep the notify-only copy.
        let legacy = AppUpdateAutoChecker.notification(for: release, currentVersion: "0.3.1")
        #expect(legacy.body == manual.body)
    }
}
