import Foundation
import Testing
@testable import ModelDeckMacCore

/// Scriptable settings transport: records patches, returns queued results.
final class StubSettingsSync: SettingsSyncing, @unchecked Sendable {
    enum Result {
        case success(DaemonSettings)
        case failure(Error)
    }

    private let lock = NSLock()
    private var results: [Result]
    private(set) var fetchCount = 0
    private(set) var pushedPatches: [DaemonSettingsPatch] = []

    init(results: [Result]) {
        self.results = results
    }

    func fetchSettings() async throws -> DaemonSettings {
        try nextResult(recordingPatch: nil, isFetch: true)
    }

    func pushSettings(_ patch: DaemonSettingsPatch) async throws -> DaemonSettings {
        try nextResult(recordingPatch: patch, isFetch: false)
    }

    private func nextResult(recordingPatch patch: DaemonSettingsPatch?, isFetch: Bool) throws -> DaemonSettings {
        lock.lock()
        defer { lock.unlock() }
        if isFetch { fetchCount += 1 }
        if let patch { pushedPatches.append(patch) }
        let result = results.isEmpty ? nil : results.removeFirst()
        switch result {
        case .success(let settings): return settings
        case .failure(let error): throw error
        case nil: throw URLError(.cannotConnectToHost)
        }
    }
}

@Suite("Settings sync model (issue #7)")
@MainActor
struct SettingsSyncModelTests {
    private var daemonDocument: DaemonSettings {
        var settings = DaemonSettings.defaults
        settings.layout = DeckLayout.singleColumn.rawValue
        settings.notificationThresholdPercent = 15
        settings.autoRefreshEnabled = false
        return settings
    }

    @Test func loadAdoptsAndAppliesDaemonDocument() async {
        let sync = StubSettingsSync(results: [.success(daemonDocument)])
        let model = SettingsSyncModel(sync: sync)
        var applied: [DaemonSettings] = []
        model.onApply = { applied.append($0) }

        await model.load()

        #expect(model.isLoaded)
        #expect(model.lastError == nil)
        #expect(model.settings.deckLayout == .singleColumn)
        #expect(model.settings.notificationThresholdPercent == 15)
        #expect(model.settings.effectiveAutoRefreshInterval == 0) // disabled
        #expect(applied.count == 1)
        #expect(applied.first?.usageThresholds.warningPercent == 15)
    }

    @Test func loadFailureKeepsDefaultsAndSurfacesError() async {
        let sync = StubSettingsSync(results: [
            .failure(DaemonClientError.daemonError(message: "boom", status: 500)),
        ])
        let model = SettingsSyncModel(sync: sync)
        var appliedCount = 0
        model.onApply = { _ in appliedCount += 1 }

        await model.load()

        #expect(!model.isLoaded)
        #expect(model.settings == .defaults)
        #expect(model.lastError == "boom")
        #expect(appliedCount == 0)
    }

    @Test func updateAdoptsMergedResponseAndApplies() async {
        var merged = DaemonSettings.defaults
        merged.autoRefreshIntervalSeconds = 600
        let sync = StubSettingsSync(results: [.success(merged)])
        let model = SettingsSyncModel(sync: sync)
        var applied: [DaemonSettings] = []
        model.onApply = { applied.append($0) }

        await model.setAutoRefreshInterval(seconds: 600)

        #expect(sync.pushedPatches.count == 1)
        #expect(sync.pushedPatches.first?.autoRefreshIntervalSeconds == 600)
        #expect(sync.pushedPatches.first?.layout == nil) // partial patch only
        #expect(model.settings.autoRefreshIntervalSeconds == 600)
        #expect(applied.count == 1)
    }

    @Test func failedSaveKeepsLastConfirmedValuesAndDoesNotApply() async {
        let sync = StubSettingsSync(results: [
            .success(daemonDocument),
            .failure(DaemonClientError.daemonError(message: "layout must be two-column or single-column", status: 400)),
        ])
        let model = SettingsSyncModel(sync: sync)
        await model.load()
        var appliedCount = 0
        model.onApply = { _ in appliedCount += 1 }

        await model.setNotificationThreshold(percent: 40)

        #expect(model.settings.notificationThresholdPercent == 15) // unchanged
        #expect(model.lastError == "layout must be two-column or single-column")
        #expect(appliedCount == 0)
    }

    @Test func unchangedFieldUpdatesAreNoOps() async {
        let sync = StubSettingsSync(results: [.success(daemonDocument)])
        let model = SettingsSyncModel(sync: sync)
        await model.load()

        // Echoes from the live models (e.g. the popover layout picker being
        // set by onApply) must not loop back into PUTs.
        await model.setLayout(.singleColumn)
        await model.setAutoRefreshEnabled(false)
        await model.setNotificationThreshold(percent: 15)
        await model.setDefaultSort(.nextReset)
        await model.setPauseWhileActive(true)

        #expect(sync.pushedPatches.isEmpty)
    }

    // Issue #30: Provider grouping is a popover-local view mode — the
    // daemon's settings schema only accepts next-reset/lowest-remaining, so
    // selecting it must never produce a PUT (which the daemon would reject).
    @Test func providerSortNeverSyncsToTheDaemon() async {
        let sync = StubSettingsSync(results: [.success(daemonDocument)])
        let model = SettingsSyncModel(sync: sync)
        await model.load()

        await model.setDefaultSort(.provider)

        #expect(sync.pushedPatches.isEmpty)
        #expect(model.lastError == nil)
    }

    @Test func emptyPatchNeverHitsTheWire() async {
        let sync = StubSettingsSync(results: [])
        let model = SettingsSyncModel(sync: sync)
        await model.update(DaemonSettingsPatch())
        #expect(sync.pushedPatches.isEmpty)
        #expect(model.lastError == nil)
    }

    @Test func patchEncodesOnlyProvidedKeys() throws {
        let patch = DaemonSettingsPatch(pauseWhileActive: false, defaultSort: "lowest-remaining")
        let data = try JSONEncoder().encode(patch)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        #expect(object?.count == 2)
        #expect(object?["pauseWhileActive"] as? Bool == false)
        #expect(object?["defaultSort"] as? String == "lowest-remaining")
    }
}
