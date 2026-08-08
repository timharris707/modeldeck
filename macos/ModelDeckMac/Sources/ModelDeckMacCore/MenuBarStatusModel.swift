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

    /// The daemon-settings pinned menu-bar source (nil = lowest across all
    /// accounts, the original behavior): a plain account id or an
    /// "active:<provider>" follow-active sentinel (`MenuBarPinResolver`
    /// grammar). While pinned and resolvable against the current deck
    /// state, the icon shows THAT account's lowest non-spend window
    /// continuously — `worstRemaining` itself stays the global worst so
    /// notifications keep firing for any account.
    @Published public var pinnedAccountId: String? {
        didSet { recomputeIconState() }
    }

    /// Issue #238 quiet mode: the stored `menuBarShowWhen` value — WHEN the
    /// menu bar shows the indicator the display mode selects
    /// (`MenuBarShowWhen` grammar; "" = always, the default). Display-only
    /// like the pin itself: `worstRemaining` and `onStateUpdate` are
    /// untouched, so notifications keep watching every account no matter
    /// how quiet the icon is.
    @Published public var showWhen: String = MenuBarShowWhen.alwaysStored {
        didSet { recomputeIconState() }
    }

    /// Issue #297: the deck's #254 general-weekly focus toggle, mirrored in
    /// from `DeckPopoverModel` (it is an app-local popover preference, not a
    /// daemon setting, so it never arrives through the settings document
    /// like the pin and quiet mode do). The health-mode dot must evaluate
    /// the same pool as the popover chip (issue #258: the toggle, Claude
    /// only inside the engine) — otherwise dot and chip can disagree.
    /// Display-only like every mode input here: `worstRemaining` and
    /// `onStateUpdate` are untouched.
    @Published public var focusGeneralWeekly: Bool = false {
        didSet { recomputeIconState() }
    }

    /// The account id the stored pin currently resolves to; nil while
    /// unpinned or unresolvable (account removed, no active account yet).
    public var resolvedPinnedAccountId: String? {
        guard let pinnedAccountId, let state = deckState else { return nil }
        return MenuBarPinResolver.resolve(pinnedAccountId, in: state)
    }

    /// The pinned account's display label for accessibility; nil while
    /// unpinned or when the pin doesn't resolve.
    public var pinnedAccountLabel: String? {
        guard let resolved = resolvedPinnedAccountId else { return nil }
        return deckState?.accounts.first { $0.id == resolved }?.label
    }

    /// Issue #131: the account whose window currently feeds the menu bar —
    /// what the deck's single checkmark marks. Mirrors
    /// `recomputeIconState`'s source order exactly (resolved pin first,
    /// lowest-across fallback otherwise; see `MenuBarSourceResolver`). Nil
    /// before the first load — the `.loading` placeholder comes from no
    /// account — and when there is no measurable usage anywhere.
    public var menuBarSourceAccountId: String? {
        guard hasLoadedOnce else { return nil }
        return MenuBarSourceResolver.sourceAccountID(
            pinnedSetting: pinnedAccountId,
            state: deckState,
            worstRemaining: worstRemaining
        )
    }

    /// Issue #249: the exact window feeding the percent the menu bar is
    /// CURRENTLY displaying — the traceability anchor for the popover's
    /// source line and the icon's accessibility label. Mirrors
    /// `recomputeIconState`'s source order (resolved pin's lowest non-spend
    /// window, global worst otherwise); nil whenever no percent is shown
    /// (loading, plain — including quiet-mode hiding — and the icon-only /
    /// health display modes), because a hidden number needs no explaining.
    public var menuBarPercentSource: WorstRemaining? {
        switch iconState {
        case .pinned, .warning, .critical:
            break
        case .loading, .plain, .health:
            return nil
        }
        if let state = deckState, let resolved = resolvedPinnedAccountId {
            return pinnedWorstRemaining(state: state, resolved: resolved)
        }
        return worstRemaining
    }

    /// Issue #292: the pinned account's displayed window — the pin's chosen
    /// window class when it carries one AND the account reports a measurable
    /// window of that class; the lowest non-spend window otherwise (both the
    /// plain pre-#292 pin and the honest fallback for an absent class, e.g.
    /// a pin on "model weekly" while the account reports no model window).
    private func pinnedWorstRemaining(state: DeckState, resolved: String) -> WorstRemaining? {
        if let stored = pinnedAccountId,
           let choice = MenuBarPinResolver.pinWindow(stored),
           let chosen = WorstRemainingCalculator.worstRemaining(
               in: state, accountId: resolved, pinWindow: choice
           ) {
            return chosen
        }
        return WorstRemainingCalculator.worstRemaining(in: state, accountId: resolved)
    }

    /// Issue #249: the popover's rendered source caption ("Menu bar 36% —
    /// Studio · 5-hour limit" plus the mode's rule as hover copy); nil
    /// whenever the menu bar shows no percent.
    public var menuBarNumberSourceLine: MenuBarSourceResolver.NumberSourceLine? {
        guard let source = menuBarPercentSource else { return nil }
        return MenuBarSourceResolver.numberSourceLine(
            source: source,
            accountLabel: deckState?.accounts.first { $0.id == source.accountId }?.label,
            pinnedSetting: pinnedAccountId,
            resolvedPinnedAccountID: resolvedPinnedAccountId
        )
    }

    /// True once any state has landed (refresh success or `apply`); gates
    /// the `.loading` placeholder (issue #58).
    private var hasLoadedOnce = false

    private func recomputeIconState() {
        // Issue #229: "None — icon only" hides the number entirely —
        // including the cold-start "–%" placeholder, since the user asked
        // for a bare glyph. Display-only: `worstRemaining` and
        // `onStateUpdate` are untouched, so notifications keep watching
        // every account exactly as before.
        if let pinnedAccountId, MenuBarPinResolver.isNone(pinnedAccountId) {
            iconState = .plain
            return
        }
        // Issue #235: the Availability Health display mode — the icon
        // shows the provider's shape-coded verdict dot instead of a
        // percentage, including before the first load (a muted hollow
        // ring rather than the "–%" percent placeholder, which would
        // claim a mode the user turned off). Display-only like #229:
        // `worstRemaining` and
        // `onStateUpdate` are untouched, so notifications keep watching
        // every account. An unrecognized "health:<future>" value is NOT
        // health mode — it falls through to the unresolvable-pin fallback
        // below, the #229 downgrade contract in this build's own forward
        // direction.
        if let pinnedAccountId,
           let healthProvider = MenuBarPinResolver.healthProvider(pinnedAccountId) {
            // Issue #244: the dot reads the burst-aware verdict — the same
            // report source as the popover chip, so a burst-degraded
            // YELLOW shows in the menu bar with no extra wiring.
            let now = clock()
            let verdict = deckState.flatMap {
                AvailabilityHealthEngine.report(
                    for: healthProvider, state: $0, now: now,
                    burstPointsPerDay: burnWindow.burstRate(for: healthProvider, now: now),
                    // Issue #297: same pool selection as the popover chip
                    // (the deck's general-weekly toggle), so the two can
                    // never render different verdicts from one state.
                    generalWeekly: focusGeneralWeekly
                ).verdict
            }
            // Issue #238 quiet mode: "When yellow or worse" / "Only when
            // red" render a GREEN deck as the plain glyph — all-clear is
            // silence. A nil verdict (no data yet, empty pool) always keeps
            // the muted no-data ring: quiet mode must never dress unknown
            // up as all-clear. Display-only: notifications keep watching
            // every account.
            if MenuBarShowWhen.parse(showWhen).showsHealth(verdict: verdict) {
                iconState = .health(provider: healthProvider, verdict: verdict)
            } else {
                iconState = .plain
            }
            return
        }
        guard hasLoadedOnce else {
            iconState = .loading
            return
        }
        // Pinned mode is client-side by design: the daemon's
        // /api/capacity/worst stays the global severity authority, and the
        // deck state we already fetch every refresh carries everything a
        // single account's windows need. A pin that no longer resolves
        // (account removed, follow-active with no active account) falls
        // back to the global-worst behavior; a resolvable account with no
        // usable windows shows the plain glyph rather than borrowing
        // another account's number.
        // Issue #238 quiet mode, percentage modes: "Show when below X%"
        // hides the number (plain glyph) while the displayed percent sits
        // at or above the threshold. Below it, the number renders with its
        // usual severity colors — neutral above the warning line, gold and
        // red under it. The gate reads the same percent the icon would
        // display (the pinned account's when pinned, the global worst
        // otherwise). The source account is unchanged while hidden — like
        // #131's empty-window pin, the account still owns the (empty) menu
        // bar slot, so the deck checkmark doesn't drift. Display-only:
        // notifications keep watching every account.
        let showWhenMode = MenuBarShowWhen.parse(showWhen)
        if let state = deckState, let resolved = resolvedPinnedAccountId {
            // Issue #292: honors the pin's window choice when it carries one.
            let pinned = pinnedWorstRemaining(state: state, resolved: resolved)
            if let pinned, !showWhenMode.showsPercent(pinned.percent) {
                iconState = .plain
                return
            }
            iconState = MenuBarIconState.state(for: pinned, thresholds: thresholds, alwaysShowPercent: true)
            return
        }
        if case .belowPercent = showWhenMode {
            // Lowest-across with an explicit visibility threshold: the
            // number shows exactly while the worst percent is below X —
            // even above the warning line (neutral color) when X is set
            // higher than the warning threshold.
            if let worst = worstRemaining, showWhenMode.showsPercent(worst.percent) {
                iconState = MenuBarIconState.state(for: worst, thresholds: thresholds, alwaysShowPercent: true)
            } else {
                iconState = .plain
            }
            return
        }
        iconState = MenuBarIconState.state(for: worstRemaining, thresholds: thresholds)
    }

    /// Called after every successful state update (manual/auto refresh and
    /// `apply(deckState:)`) with the new worst-remaining + deck state. The
    /// app wires the notification coordinator here (issue #7).
    public var onStateUpdate: ((WorstRemaining?, DeckState?) -> Void)?

    /// Issue #244: the rolling short-window burn-rate store ("today's
    /// rate"). Fed by `recordBurnSample` from the app's fresh-state hook —
    /// the same flow that runs reconcileActivation/reconcileWarnings — so
    /// it sees exactly the states the deck already fetches.
    /// Issue #260: PERSISTED across relaunches. Losing it silently reverts
    /// the verdict to its steady-state GREEN, which is what Tim watched
    /// happen the instant v0.3.20 relaunched itself mid-burn.
    public private(set) var burnWindow: BurnRateWindow

    /// Where the burn window is persisted; nil disables persistence (tests
    /// and any caller that wants the pre-#260 in-memory behavior).
    private let burnWindowStore: UserDefaults?
    static let burnWindowDefaultsKey = "modeldeck.burnWindow.samples"

    /// Records one fresh deck state into the burn window, then recomputes
    /// the icon so a health-mode dot reflects the burst-aware verdict
    /// immediately (the hook fires after the refresh's own recompute).
    public func recordBurnSample(state: DeckState) {
        burnWindow.record(state: state, now: clock())
        persistBurnWindow()
        recomputeIconState()
    }

    private func persistBurnWindow() {
        guard let burnWindowStore else { return }
        if let data = burnWindow.encoded() {
            burnWindowStore.set(data, forKey: Self.burnWindowDefaultsKey)
        } else {
            burnWindowStore.removeObject(forKey: Self.burnWindowDefaultsKey)
        }
    }

    /// The provider's current short-window burn rate (pts/day); nil while
    /// the window is inactive. The popover feeds this into the engine.
    public func burstRate(for provider: DeckProvider) -> Double? {
        burnWindow.burstRate(for: provider, now: clock())
    }

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
        clock: @escaping @Sendable () -> Date = { Date() },
        // Issue #260: nil keeps the pre-#260 in-memory window (tests).
        burnWindowStore: UserDefaults? = nil
    ) {
        self.evaluator = evaluator
        self.stateProvider = stateProvider
        self.usageRefresher = usageRefresher
        self.thresholds = thresholds
        self.clock = clock
        self.burnWindowStore = burnWindowStore
        // Restored samples are pruned to the same 3h span, so an app that
        // was closed for hours comes back cold rather than fabricating a
        // rate across the downtime gap.
        self.burnWindow = BurnRateWindow(
            restoring: burnWindowStore?.data(forKey: Self.burnWindowDefaultsKey),
            now: clock()
        )
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
        /// Tooltip for the healthy age line — nothing stale.
        public static let freshTooltip =
            "Age of the oldest account's newest provider-reported usage"
        /// Tooltip for the amber line — unexplained staleness (issue #168:
        /// the alarm's ONLY remaining trigger).
        public static let staleTooltip =
            "Usage data is older than expected — Refresh forces a fresh provider poll."
        /// Tooltip for the neutral explained-staleness summary (issue #168).
        public static let explainedTooltip =
            "Idle, signed-out, or Keychain-blocked accounts pause their usage data; live accounts are up to date. Click for details."

        public var text: String
        public var isStale: Bool
        public var tooltip: String

        public init(text: String, isStale: Bool, tooltip: String = FooterStatus.freshTooltip) {
            self.text = text
            self.isStale = isStale
            self.tooltip = tooltip
        }
    }

    /// Footer freshness derived from provider observations (`observedAt`),
    /// NOT this app's last GET of the daemon cache (issue #42's exact
    /// complaint). Issue #89 rebased it per account: the line reads "Oldest
    /// data N min ago", keyed on the account whose newest snapshot is
    /// OLDEST, so one silently failing account can no longer hide behind its
    /// siblings' fresh data. Staleness triggers past ~2x the auto-refresh
    /// interval or on the daemon's per-row stale flag. Falls back
    /// to the app-side "Updated…" text when no snapshot carries observedAt
    /// (older daemons); nil before the first load.
    /// Issue #168 (Tim's decision): the amber alarm fires ONLY for
    /// unexplained staleness. When every stale enabled account's age is
    /// explained by its card state (idle-decay #149, signed-out #114/#164,
    /// Keychain-blocked #98), the footer renders a neutral summary instead
    /// ("Live accounts current · 3 idle") — an idle deck surviving Refresh
    /// is expected behavior, not a contradiction.
    public func footerStatus(now: Date? = nil) -> FooterStatus? {
        let now = now ?? clock()
        guard let state = deckState else {
            guard let text = updatedAgoText(now: now) else { return nil }
            return FooterStatus(text: text, isStale: false)
        }
        // Issue #90: EFFECTIVE cadence — a daemon deliberately slowed by
        // the active-session cap is not "stale".
        let breakdown = DeckFreshness.footerBreakdown(
            state: state, now: now, autoRefreshInterval: stalenessInterval
        )
        if breakdown.allExplained {
            return FooterStatus(
                text: DeckFreshness.explainedFooterText(breakdown),
                isStale: false,
                tooltip: FooterStatus.explainedTooltip
            )
        }
        if let observedAt = DeckFreshness.oldestAccountObservation(in: state) {
            let stale = breakdown.hasUnexplained
            return FooterStatus(
                text: DeckFreshness.text(observedAt: observedAt, now: now),
                isStale: stale,
                tooltip: stale ? FooterStatus.staleTooltip : FooterStatus.freshTooltip
            )
        }
        guard let text = updatedAgoText(now: now) else { return nil }
        return FooterStatus(
            text: text,
            isStale: breakdown.hasUnexplained,
            tooltip: breakdown.hasUnexplained ? FooterStatus.staleTooltip : FooterStatus.freshTooltip
        )
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
