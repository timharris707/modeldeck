import Foundation
import Observation

/// Transport seam for the settings document; `DaemonClient` conforms and
/// tests stub it.
public protocol SettingsSyncing: Sendable {
    func fetchSettings() async throws -> DaemonSettings
    func pushSettings(_ patch: DaemonSettingsPatch) async throws -> DaemonSettings
}

extension DaemonClient: SettingsSyncing {
    public func fetchSettings() async throws -> DaemonSettings {
        try await settings()
    }

    public func pushSettings(_ patch: DaemonSettingsPatch) async throws -> DaemonSettings {
        try await saveSettings(patch)
    }
}

/// The Settings window's source of truth. The daemon owns the settings
/// document (`GET/PUT /api/settings`); this model loads it at launch, PUTs
/// partial patches as the user edits, adopts the daemon's merged response,
/// and re-broadcasts every accepted document through `onApply` so the running
/// models (popover layout/sort, refresh cadence, thresholds, notifications)
/// update live. On a failed save nothing is applied — the UI keeps showing
/// the last daemon-confirmed values plus an inline error.
@MainActor
public final class SettingsSyncModel: ObservableObject {
    @Published public private(set) var settings: DaemonSettings = .defaults
    /// True once the first successful daemon load happened; until then
    /// `settings` are the typed defaults.
    @Published public private(set) var isLoaded = false
    @Published public private(set) var isSaving = false
    @Published public private(set) var lastError: String?

    /// Called with every daemon-confirmed document (initial load and each
    /// successful save). The app wires this to the live models.
    public var onApply: ((DaemonSettings) -> Void)?

    private let sync: any SettingsSyncing

    public init(sync: any SettingsSyncing) {
        self.sync = sync
    }

    /// Initial load from `GET /api/settings`. On failure the typed defaults
    /// stay in effect and the error is surfaced.
    public func load() async {
        do {
            let loaded = try await sync.fetchSettings()
            settings = loaded
            isLoaded = true
            lastError = nil
            onApply?(loaded)
        } catch {
            lastError = Self.message(for: error)
        }
    }

    /// PUT a partial patch; adopt and apply the daemon's merged response.
    /// No-ops on an empty patch. A patch arriving while a save is in flight
    /// is coalesced into `pendingPatch` and pushed right after — changes are
    /// never silently dropped.
    public func update(_ patch: DaemonSettingsPatch) async {
        guard !patch.isEmpty else { return }
        if isSaving {
            pendingPatch = pendingPatch.merging(patch)
            return
        }
        isSaving = true
        var next: DaemonSettingsPatch? = patch
        while let current = next {
            do {
                let merged = try await sync.pushSettings(current)
                settings = merged
                isLoaded = true
                lastError = nil
                onApply?(merged)
            } catch {
                lastError = Self.message(for: error)
            }
            next = pendingPatch.isEmpty ? nil : pendingPatch
            pendingPatch = DaemonSettingsPatch()
        }
        isSaving = false
    }

    private var pendingPatch = DaemonSettingsPatch()

    // MARK: - Field updates (each a no-op when unchanged, so live-model
    // echoes — e.g. the popover's own layout picker — never loop).

    public func setAutoRefreshEnabled(_ enabled: Bool) async {
        guard enabled != settings.autoRefreshEnabled else { return }
        await update(DaemonSettingsPatch(autoRefreshEnabled: enabled))
    }

    public func setAutoRefreshInterval(seconds: Int) async {
        guard seconds != settings.autoRefreshIntervalSeconds else { return }
        await update(DaemonSettingsPatch(autoRefreshIntervalSeconds: seconds))
    }

    public func setPauseWhileActive(_ pause: Bool) async {
        guard pause != settings.pauseWhileActive else { return }
        await update(DaemonSettingsPatch(pauseWhileActive: pause))
    }

    public func setLayout(_ layout: DeckLayout) async {
        guard layout.rawValue != settings.layout else { return }
        await update(DaemonSettingsPatch(layout: layout.rawValue))
    }

    public func setDefaultSort(_ order: DeckSortOrder) async {
        // Provider grouping (issue #30) is a popover-local view mode: the
        // daemon's settings schema accepts only next-reset/lowest-remaining,
        // so it never syncs (UserDefaults persists it across launches).
        guard order != .provider else { return }
        guard order.rawValue != settings.defaultSort else { return }
        await update(DaemonSettingsPatch(defaultSort: order.rawValue))
    }

    public func setNotificationThreshold(percent: Int) async {
        guard percent != settings.notificationThresholdPercent else { return }
        await update(DaemonSettingsPatch(notificationThresholdPercent: percent))
    }

    static func message(for error: Error) -> String {
        if case DaemonClientError.daemonError(let message, _) = error {
            return message
        }
        return error.localizedDescription
    }
}
