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

/// Issue #72: seam for the daemon's forced usage refresh
/// (`POST /api/refresh` — a real provider poll, which is what actually
/// advances the snapshots' `observedAt`). `DaemonClient` conforms; tests
/// stub it.
public protocol UsageRefreshing: Sendable {
    func refreshUsage() async throws
}

extension DaemonClient: UsageRefreshing {}

/// Icon-path diagnostics (issue #45 reopen): opt-in via
/// `MODELDECK_ICON_DEBUG=1`, silent otherwise. Kept permanently so a future
/// "icon looks wrong" report can be diagnosed on a live install without a
/// custom build.
public enum IconDebugLog {
    public static let enabled = ProcessInfo.processInfo.environment["MODELDECK_ICON_DEBUG"] == "1"

    public static func log(_ message: @autoclosure () -> String) {
        guard enabled else { return }
        // stderr: unbuffered, so lines survive even an abrupt exit.
        FileHandle.standardError.write(Data("[icon-debug] \(message())\n".utf8))
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
    /// Starts `.loading` (issue #58): the cold-start placeholder holds until
    /// the first successful state lands — a failed fetch keeps it, because
    /// data still hasn't arrived and a plain glyph would claim "healthy".
    @Published public private(set) var iconState: MenuBarIconState = .loading
    @Published public private(set) var lastUpdatedAt: Date?
    @Published public private(set) var isRefreshing = false
    /// Full daemon state for the popover deck; nil before the first
    /// successful load or when no state provider was supplied.
    @Published public private(set) var deckState: DeckState?

    public var thresholds: UsageThresholds {
        didSet { recomputeIconState() }
    }

    /// True once any state has landed (refresh success or `apply`); gates
    /// the `.loading` placeholder (issue #58).
    private var hasLoadedOnce = false

    private func recomputeIconState() {
        iconState = hasLoadedOnce
            ? MenuBarIconState.state(for: worstRemaining, thresholds: thresholds)
            : .loading
    }

    /// Called after every successful state update (manual/auto refresh and
    /// `apply(deckState:)`) with the new worst-remaining + deck state. The
    /// app wires the notification coordinator here (issue #7).
    public var onStateUpdate: ((WorstRemaining?, DeckState?) -> Void)?

    private let evaluator: any UsageEvaluating
    private let stateProvider: (any DeckStateProviding)?
    /// Issue #72: the manual-Refresh provider poll; nil keeps every refresh
    /// a cheap cached read (pre-#72 behavior).
    private let usageRefresher: (any UsageRefreshing)?
    private let clock: @Sendable () -> Date
    private var autoRefreshTask: Task<Void, Never>?

    public init(
        evaluator: any UsageEvaluating,
        stateProvider: (any DeckStateProviding)? = nil,
        usageRefresher: (any UsageRefreshing)? = nil,
        thresholds: UsageThresholds = .default,
        clock: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.evaluator = evaluator
        self.stateProvider = stateProvider
        self.usageRefresher = usageRefresher
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
        await loadState()
    }

    /// Issue #72: the manual Refresh button's path. The plain `refresh()`
    /// only GETs the daemon's cached state, which never advances the usage
    /// snapshots' `observedAt` — so the footer's "Data from N min ago"
    /// counter visibly ignored the click. This first asks the daemon for a
    /// real provider poll (`POST /api/refresh`), then re-reads state; the
    /// footer age restarts because the fresh snapshots carry a new
    /// `observedAt`. A failed poll (older daemon, transient error)
    /// degrades to the cached read — never a dead button.
    public func refreshFromProviders() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        if let usageRefresher {
            do {
                try await usageRefresher.refreshUsage()
            } catch {
                IconDebugLog.log("forced usage refresh FAILED (\(error)); falling back to cached read")
            }
        }
        await loadState()
    }

    private func loadState() async {
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
                    IconDebugLog.log("evaluator worst=\(String(describing: worst))")
                } catch {
                    IconDebugLog.log("evaluator FAILED (\(error)); falling back to client calc")
                    worst = WorstRemainingCalculator.worstRemaining(in: state)
                    IconDebugLog.log("fallback worst=\(String(describing: worst))")
                }
            } else {
                worst = try await evaluator.evaluateWorstRemaining()
            }
            guard generation == stateGeneration else { return }
            worstRemaining = worst
            hasLoadedOnce = true
            recomputeIconState()
            connection = .connected
            lastUpdatedAt = clock()
            IconDebugLog.log("refresh done: thresholds=(warn \(thresholds.warningPercent), crit \(thresholds.criticalPercent)) iconState=\(iconState)")
            onStateUpdate?(worst, deckState)
        } catch {
            guard generation == stateGeneration else { return }
            IconDebugLog.log("refresh FAILED: \(error)")
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
        hasLoadedOnce = true
        recomputeIconState()
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

    /// The app-configured auto-refresh cadence (seconds); 0 while disabled.
    public private(set) var autoRefreshInterval: TimeInterval = 0

    /// Issue #90: the interval stale math runs against — the daemon-reported
    /// EFFECTIVE cadence when it is slower than the configured one (e.g. the
    /// active-session cap slowing the default interval to 30 min), so a
    /// deliberately slowed scheduler can never falsely mark data stale.
    /// Falls back to the configured interval on older daemons that don't
    /// report an effective cadence.
    public var stalenessInterval: TimeInterval {
        if let seconds = deckState?.scheduler?.effectiveRefreshIntervalSeconds,
           TimeInterval(seconds) > autoRefreshInterval {
            return TimeInterval(seconds)
        }
        return autoRefreshInterval
    }

    // MARK: - Refresh-cadence honesty (issue #90)

    /// The calm footer indicator shown only while the daemon's effective
    /// refresh cadence is slower than the user's configured setting.
    public struct RefreshCadenceNotice: Equatable, Sendable {
        public var text: String
        public var tooltip: String

        public init(text: String, tooltip: String) {
            self.text = text
            self.tooltip = tooltip
        }
    }

    /// Issue #90 (Tim's design call): when the active-session cap slows the
    /// never-customized default interval, the deck says so instead of
    /// silently serving old data. Nil whenever the daemon reports no
    /// slowdown, reports an unknown reason, or is too old to report at all.
    public var refreshCadenceNotice: RefreshCadenceNotice? {
        guard let scheduler = deckState?.scheduler,
              scheduler.effectiveRefreshReason == "active-session-cap",
              let effective = scheduler.effectiveRefreshIntervalSeconds,
              let configured = scheduler.configuredRefreshIntervalSeconds,
              effective > configured
        else { return nil }
        let effectiveMinutes = max(1, Int((Double(effective) / 60).rounded()))
        let configuredMinutes = max(1, Int((Double(configured) / 60).rounded()))
        return RefreshCadenceNotice(
            text: "Auto-refresh slowed",
            tooltip: "A CLI session is running, so scheduled refresh is slowed to every "
                + "\(effectiveMinutes) min instead of every \(configuredMinutes) min. "
                + "Choosing a refresh interval in Settings — or clicking Keep to confirm "
                + "your current \(configuredMinutes) min — lifts this cap permanently; "
                + "the Refresh button always polls immediately."
        )
    }

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

    /// Footer freshness derived from provider observations (`observedAt`),
    /// NOT this app's last GET of the daemon cache (issue #42's exact
    /// complaint). Issue #89 rebased it per account: the line reads "Oldest
    /// data N min ago", keyed on the account whose newest snapshot is
    /// OLDEST, so one silently failing account can no longer hide behind its
    /// siblings' fresh data. Stale when that age exceeds ~2x the
    /// auto-refresh interval or the daemon flags any row stale. Falls back
    /// to the app-side "Updated…" text when no snapshot carries observedAt
    /// (older daemons); nil before the first load.
    public func footerStatus(now: Date? = nil) -> FooterStatus? {
        let now = now ?? clock()
        let rowStale = deckState.map(DeckFreshness.anyRowStale(in:)) ?? false
        if let state = deckState, let observedAt = DeckFreshness.oldestAccountObservation(in: state) {
            return FooterStatus(
                text: DeckFreshness.text(observedAt: observedAt, now: now),
                isStale: rowStale || DeckFreshness.isStale(
                    observedAt: observedAt,
                    now: now,
                    // Issue #90: EFFECTIVE cadence — a daemon deliberately
                    // slowed by the active-session cap is not "stale".
                    autoRefreshInterval: stalenessInterval
                )
            )
        }
        guard let text = updatedAgoText(now: now) else { return nil }
        return FooterStatus(text: text, isStale: rowStale)
    }

    /// Issue #113 addendum: what clicking the footer's oldest-data line
    /// explains — the oldest-account basis, naming the stale account(s)
    /// with their ages. Same effective-cadence basis as `footerStatus` and
    /// the per-card markers.
    public func footerFreshnessExplanation(now: Date? = nil) -> DeckWarningExplanation {
        DeckFreshness.footerFreshnessExplanation(
            state: deckState,
            now: now ?? clock(),
            autoRefreshInterval: stalenessInterval
        )
    }

    // MARK: - Per-card staleness (issue #89)

    /// The staleness marker for one deck card, computed against this model's
    /// effective auto-refresh interval; nil while the card's data is fresh.
    public func cardStaleness(for row: DeckAccountRow, now: Date? = nil) -> DeckFreshness.CardStaleness? {
        // Issue #90: same effective-cadence basis as the footer — the cap
        // slowing refresh must never falsely mark cards stale.
        row.staleness(now: now ?? clock(), autoRefreshInterval: stalenessInterval)
    }
}
