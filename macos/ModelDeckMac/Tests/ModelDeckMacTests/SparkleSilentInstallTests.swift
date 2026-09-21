import Foundation
import Testing
import ModelDeckMacCore
import Sparkle
@testable import ModelDeckMac

@MainActor
struct SparkleSilentInstallTests {
    @Test func silentDelegateBlocksRollbackAfterSessionEnds() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let defaults = try #require(UserDefaults(suiteName: root.appendingPathComponent("defaults").path))
        let model = AppUpdateInstallModel(defaults: defaults)
        let delegate = RelaunchMarkingUpdaterDelegate(marker: NoUpdateRelaunchMarker(), installModel: model)
        // Initialization does not start Sparkle. Never start/check/install:
        // the real delegate callback is the only production action under test.
        let updater = SPUUpdater(hostBundle: .main, applicationBundle: .main,
                                 userDriver: OneClickUserDriver(installModel: model), delegate: delegate)
        let item = try #require(SUAppcastItem(dictionary: [
            "sparkle:shortVersionString": "1.2.0-beta.1",
            "enclosure": ["url": "https://example.invalid/update.dmg", "sparkle:version": "640"]
        ]))
        var immediateInstallCalled = false
        let protocolDelegate: any SPUUpdaterDelegate = delegate
        let takesResponsibility = protocolDelegate.updater?(updater, willInstallUpdateOnQuit: item,
            immediateInstallationBlock: { immediateInstallCalled = true })
        #expect(takesResponsibility == false)
        #expect(!immediateInstallCalled)
        #expect(model.phase == .installedPendingRelaunch(version: "1.2.0-beta.1"))
        #expect(model.stagedVersion == "1.2.0-beta.1")
        #expect(!model.canReserveForRollback(canCheckForUpdates: true, sessionInProgress: false))
        #expect(defaults.string(forKey: "modeldeck.appupdate.pendingInstallBuild") == "640")
        let nextProcess = AppUpdateInstallModel(defaults: defaults)
        #expect(!nextProcess.canReserveForRollback(canCheckForUpdates: true, sessionInProgress: false))
        nextProcess.finishInstallLaunch(currentBuild: "640", isRunningProcess: true)
        #expect(nextProcess.phase == .idle)
        #expect(nextProcess.canReserveForRollback(canCheckForUpdates: true, sessionInProgress: false))
        #expect(defaults.string(forKey: AppUpdateInstallModel.pendingInstallBuildKey) == nil)
    }
}
