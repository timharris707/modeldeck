import Foundation
import Testing
@testable import ModelDeckMacCore

@MainActor
struct Issue706SparkleOwnershipTests {
    @Test func inheritedSilentInstallerRemainsStagedBeforeReadiness() {
        let defaults = ScratchDefaults.make("silent-installer")
        let oldProcess = AppUpdateInstallModel(defaults: defaults)
        oldProcess.report(.installedPendingRelaunch(version: "1.3.0"))
        oldProcess.clearTransientProgress()
        let newProcess = AppUpdateInstallModel(defaults: defaults)
        #expect(newProcess.stagedVersion == "1.3.0")
        #expect(newProcess.phase == .installedPendingRelaunch(version: "1.3.0"))
    }

    @Test func blocksSilentInstallerAfterItsSessionEnds() {
        let model = AppUpdateInstallModel(defaults: ScratchDefaults.make("silent-ended"))
        #expect(model.canReserveForRollback(canCheckForUpdates: true, sessionInProgress: false))
        // The silent delegate reports this even though OneClickUserDriver
        // receives no progress and Sparkle ends its session.
        model.report(.installedPendingRelaunch(version: "1.3.0"))
        model.clearTransientProgress()
        #expect(!model.isBusy)
        #expect(!model.canReserveForRollback(canCheckForUpdates: true, sessionInProgress: false))
        model.report(.failed(message: "Later check failed"))
        #expect(!model.canReserveForRollback(canCheckForUpdates: true, sessionInProgress: false))
    }

    @Test func blocksSessionEvenWhenSparkleAllowsAnotherCheck() {
        let model = AppUpdateInstallModel(defaults: ScratchDefaults.make("visible-session"))
        #expect(!model.canReserveForRollback(canCheckForUpdates: true, sessionInProgress: true))
        #expect(!model.canReserveForRollback(canCheckForUpdates: false, sessionInProgress: false))
        model.report(.downloading(fraction: 0.5))
        #expect(!model.canReserveForRollback(canCheckForUpdates: true, sessionInProgress: false))
    }

    @Test func onlyInstalledVersionReadinessClearsInheritedOwnership() {
        let defaults = ScratchDefaults.make("silent-ready")
        AppUpdateInstallModel(defaults: defaults).report(.installedPendingRelaunch(version: "1.3.0"), build: "645")
        let next = AppUpdateInstallModel(defaults: defaults)
        next.finishInstallLaunch(currentBuild: "640", isRunningProcess: true)
        #expect(!next.canReserveForRollback(canCheckForUpdates: true, sessionInProgress: false))
        next.finishInstallLaunch(currentBuild: "645", isRunningProcess: false)
        #expect(!next.canReserveForRollback(canCheckForUpdates: true, sessionInProgress: false))
        #expect(defaults.string(forKey: AppUpdateInstallModel.pendingInstallVersionKey) == "1.3.0")
        next.finishInstallLaunch(currentBuild: "645", isRunningProcess: true)
        #expect(next.phase == .idle)
        #expect(next.canReserveForRollback(canCheckForUpdates: true, sessionInProgress: false))
        #expect(defaults.string(forKey: AppUpdateInstallModel.pendingInstallVersionKey) == nil)
        #expect(AppUpdateInstallModel(defaults: defaults).stagedVersion == nil)
    }

    // CodeRabbit (PR #711): a build key left without its version key must
    // still block rollback until the installed build supersedes it.
    @Test func buildKeyAloneStillBlocksRollback() {
        let defaults = ScratchDefaults.make("build-key-alone")
        defaults.set("645", forKey: AppUpdateInstallModel.pendingInstallBuildKey)
        let model = AppUpdateInstallModel(defaults: defaults)
        #expect(model.stagedVersion == nil)
        #expect(!model.canReserveForRollback(canCheckForUpdates: true, sessionInProgress: false))
        model.finishInstallLaunch(currentBuild: "640", isRunningProcess: true)
        #expect(!model.canReserveForRollback(canCheckForUpdates: true, sessionInProgress: false))
        model.finishInstallLaunch(currentBuild: "645", isRunningProcess: true)
        #expect(model.canReserveForRollback(canCheckForUpdates: true, sessionInProgress: false))
    }

    @Test(arguments: [
        ("640", "640", "1.2.0-beta.1", true, true),
        ("630", "645", "1.2.0", true, true),
        ("650", "645", "1.2.0", true, false),
        ("645", "640", "1.2.0", true, false),
        ("640", "640", "1.2.0-beta.1", false, false),
        ("630", "645", "1.2.0", false, false),
        ("99", "100", "1.2.0", true, true)
    ])
    func pendingBuildReadiness(pending: String, running: String, display: String,
                               hashMatches: Bool, clears: Bool) throws {
        let defaults = ScratchDefaults.make("pending-build")
        defaults.set(display, forKey: AppUpdateInstallModel.pendingInstallVersionKey)
        defaults.set(pending, forKey: "modeldeck.appupdate.pendingInstallBuild")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let contents = root.appendingPathComponent("ModelDeck.app/Contents")
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        let plist = ["CFBundleIdentifier": "test.modeldeck.readiness", "CFBundleVersion": running,
                     "CFBundleShortVersionString": "1.2.0", "CFBundlePackageType": "APPL"]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            .write(to: contents.appendingPathComponent("Info.plist"))
        let bundle = try #require(Bundle(url: contents.deletingLastPathComponent()))
        let model = AppUpdateInstallModel(defaults: defaults)
        #expect(model.stagedVersion == display)
        #expect(!model.canReserveForRollback(canCheckForUpdates: true, sessionInProgress: false))
        model.finishInstallLaunch(currentBuild: bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
                                  isRunningProcess: hashMatches)
        #expect((defaults.string(forKey: "modeldeck.appupdate.pendingInstallBuild") == nil) == clears)
        #expect((defaults.string(forKey: AppUpdateInstallModel.pendingInstallVersionKey) == nil) == clears)
        #expect(model.canReserveForRollback(canCheckForUpdates: true, sessionInProgress: false) == clears)
        #expect(model.phase == (clears ? .idle : .installedPendingRelaunch(version: display)))
        #expect((AppUpdateInstallModel(defaults: defaults).stagedVersion == nil) == clears)
    }

    // Sparkle is deliberately outside Core. Keep a wiring check as well as
    // behavioral model tests so dropping the silent callback cannot pass them.
    @Test func silentDelegateAndSessionGuardAreWired() throws {
        let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: package.appendingPathComponent("Sources/ModelDeckMac/SparkleUpdateDriver.swift"), encoding: .utf8)
        let delegate = try #require(source.components(separatedBy: "final class RelaunchMarkingUpdaterDelegate").last)
        #expect(delegate.contains("installModel?.report(.installedPendingRelaunch(version: version), build: build)"))
        #expect(source.contains("marker: UserDefaultsUpdateRelaunchMarker(), installModel: installModel"))
        #expect(source.contains("installModel?.canReserveForRollback"))
        #expect(source.contains("willInstallUpdateOnQuit"))
        #expect(source.contains("immediateInstallationBlock"))
        #expect(source.contains("updater.sessionInProgress"))
        let readiness = try String(contentsOf: package.appendingPathComponent("Sources/ModelDeckMac/AppRollbackLive.swift"), encoding: .utf8)
        #expect(readiness.contains("finishInstallLaunch(currentBuild: bundle.object(forInfoDictionaryKey: \"CFBundleVersion\") as? String"))
    }
}
