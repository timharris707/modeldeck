import Foundation
import Observation

/// Source of the full deck state (accounts + usage windows) that the Phase 4
/// popover renders. `DaemonClient` conforms; tests stub it.
public protocol DeckStateProviding: Sendable {
    func deckState() async throws -> DeckState
}

extension DaemonClient: DeckStateProviding {
    public func deckState() async throws -> DeckState {
        try await state()
    }
}

/// View model behind the menu bar icon and the popover deck. Owns refresh,
/// connection status, the derived icon state, and (when a state provider is
/// supplied) the full deck state the popover renders.
/// GET-only: refreshing reads the daemon's cached state and never triggers
/// provider polling.
@MainActor
public final class MenuBarStatusModel: ObservableObject {
    public enum ConnectionStatus: Equatable, Sendable {
        case unknown
        case connected
        case unreachable(String)
    }

    @Published public private(set) var connection: ConnectionStatus = .unknown
    @Published public private(set) var worstRemaining: WorstRemaining?
    @Published public private(set) var iconState: MenuBarIconState = .plain
    @Published public private(set) var lastUpdatedAt: Date?
    @Published public private(set) var isRefreshing = false
    /// Full daemon state for the popover deck; nil before the first
    /// successful load or when no state provider was supplied.
    @Published public private(set) var deckState: DeckState?

    public var thresholds: UsageThresholds {
        didSet { iconState = MenuBarIconState.state(for: worstRemaining, thresholds: thresholds) }
    }

    /// Called after every successful state update (manual/auto refresh and
    /// `apply(deckState:)`) with the new worst-remaining + deck state. The
    /// app wires the notification coordinator here (issue #7).
    public var onStateUpdate: ((WorstRemaining?, DeckState?) -> Void)?

    private let evaluator: any UsageEvaluating
    private let stateProvider: (any DeckStateProviding)?
    private let clock: @Sendable () -> Date
    private var autoRefreshTask: Task<Void, Never>?

    public init(
        evaluator: any UsageEvaluating,
        stateProvider: (any DeckStateProviding)? = nil,
        thresholds: UsageThresholds = .default,
        clock: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.evaluator = evaluator
        self.stateProvider = stateProvider
        self.thresholds = thresholds
        self.clock = clock
    }

    deinit {
        autoRefreshTask?.cancel()
    }

    /// Manual refresh. On failure the last known usage state is kept (the
    /// icon does not flap) and the connection status carries the error.
    private var stateGeneration = 0

    public func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        // If apply(deckState:) lands while we await the daemon, this refresh
        // is stale — its result must not clobber the verified state.
        let generation = stateGeneration
        do {
            let worst: WorstRemaining?
            if let stateProvider {
                // One fetch feeds both the popover deck and the icon.
                let state = try await stateProvider.deckState()
                guard generation == stateGeneration else { return }
                deckState = state
                // Issue #45: the evaluator (in the app, the daemon's own
                // /api/capacity/worst — the single source of truth) is the
                // PRIMARY worst-remaining source; the client-side calc over
                // the state we already fetched is the offline fallback so
                // the icon keeps working against daemons without the
                // endpoint or when the second GET fails mid-refresh.
                do {
                    worst = try await evaluator.evaluateWorstRemaining()
                } catch {
                    worst = WorstRemainingCalculator.worstRemaining(in: state)
                }
            } else {
                worst = try await evaluator.evaluateWorstRemaining()
            }
            guard generation == stateGeneration else { return }
            worstRemaining = worst
            iconState = MenuBarIconState.state(for: worst, thresholds: thresholds)
            connection = .connected
            lastUpdatedAt = clock()
            onStateUpdate?(worst, deckState)
        } catch {
            guard generation == stateGeneration else { return }
            connection = .unreachable(error.localizedDescription)
        }
    }

    /// Adopt a deck state fetched elsewhere (e.g. the Activate flow's
    /// post-switch verification read) without waiting for the next refresh.
    public func apply(deckState state: DeckState) {
        stateGeneration += 1
        deckState = state
        let worst = WorstRemainingCalculator.worstRemaining(in: state)
        worstRemaining = worst
        iconState = MenuBarIconState.state(for: worst, thresholds: thresholds)
        connection = .connected
        lastUpdatedAt = clock()
        onStateUpdate?(worst, state)
    }

    /// Optional background auto-refresh against the local daemon (spec
    /// default 5 min; 0 or negative disables). Replaces any prior schedule.
    public func startAutoRefresh(interval: TimeInterval) {
        stopAutoRefresh()
        autoRefreshInterval = max(interval, 0)
        guard interval > 0 else { return }
        autoRefreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                guard !Task.isCancelled else { return }
                await self?.refresh()
            }
        }
    }

    public func stopAutoRefresh() {
        autoRefreshTask?.cancel()
        autoRefreshTask = nil
    }

    /// "Updated N min ago" footer text; nil before the first successful load.
    public func updatedAgoText(now: Date? = nil) -> String? {
        guard let lastUpdatedAt else { return nil }
        let seconds = (now ?? clock()).timeIntervalSince(lastUpdatedAt)
        if seconds < 60 { return "Updated just now" }
        let minutes = Int(seconds / 60)
        return "Updated \(minutes) min ago"
    }

    // MARK: - Footer freshness (issue #42)

    /// The effective auto-refresh cadence (seconds); 0 while disabled. Feeds
    /// the footer's staleness threshold (~2x this interval).
    public private(set) var autoRefreshInterval: TimeInterval = 0

    /// What the popover footer renders: the freshness line plus whether it
    /// should carry the muted warning tint.
    public struct FooterStatus: Equatable, Sendable {
        public var text: String
        public var isStale: Bool

        public init(text: String, isStale: Bool) {
            self.text = text
            self.isStale = isStale
        }
    }

    /// Footer freshness derived from the newest usage snapshot's
    /// `observedAt` — the provider observation, NOT this app's last GET of
    /// the daemon cache (issue #42's exact complaint). Stale when that age
    /// exceeds ~2x the auto-refresh interval or the daemon flags any row
    /// stale. Falls back to the app-side "Updated…" text when no snapshot
    /// carries observedAt (older daemons); nil before the first load.
    public func footerStatus(now: Date? = nil) -> FooterStatus? {
        let now = now ?? clock()
        let rowStale = deckState.map(DeckFreshness.anyRowStale(in:)) ?? false
        if let state = deckState, let observedAt = DeckFreshness.newestObservedAt(in: state) {
            return FooterStatus(
                text: DeckFreshness.text(observedAt: observedAt, now: now),
                isStale: rowStale || DeckFreshness.isStale(
                    observedAt: observedAt,
                    now: now,
                    autoRefreshInterval: autoRefreshInterval
                )
            )
        }
        guard let text = updatedAgoText(now: now) else { return nil }
        return FooterStatus(text: text, isStale: rowStale)
    }
}
