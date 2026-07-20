import Foundation
import Observation

// Phase 4 — the two-column deck popover's view model layer.
// Design authority: design/mac-app-spec.md ("Popover layout", "Row behavior",
// "Sorting", "Bar colors") and design/mockups/modeldeck-mac-app-mockups.html §02.
// Everything here is pure derivation over `DeckState` so it is directly unit
// testable; the SwiftUI views in the app target stay thin.

/// The two providers the deck knows how to column-ize.
public enum DeckProvider: String, CaseIterable, Equatable, Sendable {
    case claude
    case codex

    /// Lenient mapping from the daemon's `provider` strings.
    public static func from(_ raw: String) -> DeckProvider? {
        switch raw.lowercased() {
        case "claude", "anthropic": return .claude
        case "codex", "openai": return .codex
        default: return nil
        }
    }

    /// Column header title.
    public var displayName: String {
        switch self {
        case .claude: return "Claude"
        case .codex: return "Codex"
        }
    }
}

/// Popover layout. Two-column is the locked default; single-column is the
/// Settings-selectable alternate driven by the same view model.
public enum DeckLayout: String, Equatable, Sendable {
    case twoColumn = "two-column"
    case singleColumn = "single-column"
}

/// Sort order applied per column in two-column mode and to the interleaved
/// list in single-column mode. Next reset is the locked default.
///
/// Issue #30 adds Provider: groups accounts by provider (Claude first,
/// Codex second, unknown providers last) even in single-column mode; within
/// a group rows keep the next-reset order. It is a popover-local view mode —
/// the daemon's settings schema only accepts next-reset/lowest-remaining, so
/// Provider persists via UserDefaults and never syncs.
public enum DeckSortOrder: String, Equatable, Sendable, CaseIterable {
    case nextReset = "next-reset"
    case lowestRemaining = "lowest-remaining"
    case provider = "provider"

    public var displayName: String {
        switch self {
        case .nextReset: return "Reset"
        case .lowestRemaining: return "Lowest"
        case .provider: return "Provider"
        }
    }

    /// SF Symbol for the popover's compact icon-segment sort control
    /// (issue #30 item 10): a clock for time-to-reset, a percent for lowest
    /// remaining, a grid for grouped-by-provider. `displayName` stays the
    /// accessibility label and tooltip text.
    public var iconName: String {
        switch self {
        case .nextReset: return "clock"
        case .lowestRemaining: return "percent"
        case .provider: return "square.grid.2x2"
        }
    }
}

/// Health of a usage window on the locked "% left" thresholds:
/// blue when healthy, yellow-gold below warning, red at critical.
public enum UsageSeverity: Equatable, Sendable {
    case healthy
    case warning
    case critical
    case unknown

    public static func severity(remainingPercent: Double?, thresholds: UsageThresholds) -> UsageSeverity {
        guard let remaining = remainingPercent else { return .unknown }
        if remaining <= thresholds.criticalPercent { return .critical }
        if remaining <= thresholds.warningPercent { return .warning }
        return .healthy
    }
}

/// One rate-limit window inside an account row (5-hour / weekly / model-scoped).
public struct DeckWindow: Equatable, Identifiable, Sendable {
    public var scope: String
    public var title: String
    public var remainingPercent: Double?
    public var resetsAt: Date?
    public var resetText: String
    public var severity: UsageSeverity
    public var stale: Bool

    public var id: String { scope }

    /// Issue #28: spend renders as a tertiary row — last, muted, never the
    /// headline — and hides entirely when it carries no meaningful data.
    public var isSpend: Bool { UsageScope.isSpend(scope) }

    /// Bars fill with **usage** while the number reads **% left** (mockup §02).
    public var usedFraction: Double {
        guard let remaining = remainingPercent else { return 0 }
        return min(max((100 - remaining) / 100, 0), 1)
    }

    /// "72% left" — the locked number convention, both providers.
    public var remainingText: String? {
        remainingPercent.map { "\(Int($0.rounded()))% left" }
    }

    public init(
        scope: String,
        title: String,
        remainingPercent: Double?,
        resetsAt: Date?,
        resetText: String,
        severity: UsageSeverity,
        stale: Bool
    ) {
        self.scope = scope
        self.title = title
        self.remainingPercent = remainingPercent
        self.resetsAt = resetsAt
        self.resetText = resetText
        self.severity = severity
        self.stale = stale
    }
}

/// One account row in the deck. Collapsed it shows the worst window's bar,
/// % left, and next reset; expanded it lists every window.
public struct DeckAccountRow: Equatable, Identifiable, Sendable {
    public var account: DeckAccount
    public var provider: DeckProvider?
    public var windows: [DeckWindow]
    /// Whether this is the provider's active account (checkmark beside the
    /// title — spec amendment 2026-07-19 replaced the ACTIVE badge, and the
    /// Activate control lives in Settings → Accounts).
    public var isActive: Bool

    public var id: String { account.id }

    /// The window with the lowest % left — what the collapsed line shows.
    ///
    /// Issue #28: spend is excluded from the headline pick (card headline,
    /// Lowest sort key, worst summary). Only when every non-spend window is
    /// absent does the headline fall back to whatever exists.
    public var worstWindow: DeckWindow? {
        let measurable = windows.filter { $0.remainingPercent != nil }
        let rateLimits = measurable.filter { !$0.isSpend }
        return (rateLimits.isEmpty ? measurable : rateLimits)
            .min { ($0.remainingPercent ?? .infinity) < ($1.remainingPercent ?? .infinity) }
    }

    /// The soonest upcoming reset across all windows — the "next reset" sort key.
    public var nextReset: Date? {
        windows.compactMap(\.resetsAt).min()
    }

    /// Lowest % left across windows — the "lowest remaining" sort key.
    public var lowestRemaining: Double? {
        worstWindow?.remainingPercent
    }

    /// Collapsed-line detail beside the % left, e.g. "Weekly · Fable · Wed 6:00 PM".
    public var worstSummary: String? {
        guard let worst = worstWindow else { return nil }
        return "\(worst.title) · \(worst.resetText)"
    }

    public init(account: DeckAccount, provider: DeckProvider?, windows: [DeckWindow], isActive: Bool) {
        self.account = account
        self.provider = provider
        self.windows = windows
        self.isActive = isActive
    }
}

/// One provider column in two-column mode.
public struct DeckColumn: Equatable, Identifiable, Sendable {
    public var provider: DeckProvider
    public var rows: [DeckAccountRow]

    public var id: String { provider.rawValue }
    public var title: String { provider.displayName }
    public var accountCountText: String {
        rows.count == 1 ? "1 account" : "\(rows.count) accounts"
    }

    public init(provider: DeckProvider, rows: [DeckAccountRow]) {
        self.provider = provider
        self.rows = rows
    }
}

/// Pure builders turning daemon `DeckState` into deck rows/columns.
public enum DeckBuilder {
    /// All rows for enabled accounts, unsorted.
    public static func rows(
        state: DeckState,
        thresholds: UsageThresholds = .default,
        now: Date = Date()
    ) -> [DeckAccountRow] {
        let usageByAccount = Dictionary(grouping: state.usage, by: \.accountId)
        return state.accounts
            .filter(\.enabled)
            .map { account in
                let windows = (usageByAccount[account.id] ?? [])
                    .map { window(from: $0, thresholds: thresholds, now: now) }
                    .filter { !isMeaninglessSpend($0) }
                    .sorted { lhs, rhs in
                        let l = windowRank(scope: lhs.scope)
                        let r = windowRank(scope: rhs.scope)
                        if l != r { return l < r }
                        return lhs.scope.localizedCaseInsensitiveCompare(rhs.scope) == .orderedAscending
                    }
                return DeckAccountRow(
                    account: account,
                    provider: DeckProvider.from(account.provider),
                    windows: windows,
                    isActive: account.isDefault
                )
            }
    }

    /// Rows sorted by the given order. Ties break by label so the order is stable.
    public static func sorted(_ rows: [DeckAccountRow], by order: DeckSortOrder) -> [DeckAccountRow] {
        rows.sorted { lhs, rhs in
            switch order {
            case .nextReset:
                let l = lhs.nextReset ?? .distantFuture
                let r = rhs.nextReset ?? .distantFuture
                if l != r { return l < r }
            case .lowestRemaining:
                let l = lhs.lowestRemaining ?? .infinity
                let r = rhs.lowestRemaining ?? .infinity
                if l != r { return l < r }
            case .provider:
                // Issue #30: group by provider even in single-column mode;
                // within a provider group keep the next-reset order. In
                // two-column mode every row in a column shares a provider,
                // so this degrades to next-reset there.
                let lp = providerRank(lhs.provider)
                let rp = providerRank(rhs.provider)
                if lp != rp { return lp < rp }
                let l = lhs.nextReset ?? .distantFuture
                let r = rhs.nextReset ?? .distantFuture
                if l != r { return l < r }
            }
            return lhs.account.label.localizedCaseInsensitiveCompare(rhs.account.label) == .orderedAscending
        }
    }

    /// Provider grouping order: Claude first, Codex second (mirroring the
    /// two-column left→right order), unknown providers last.
    static func providerRank(_ provider: DeckProvider?) -> Int {
        switch provider {
        case .claude: return 0
        case .codex: return 1
        case nil: return 2
        }
    }

    /// Two-column mode: Claude column left, Codex right, each sorted
    /// independently. Accounts with unknown providers are omitted from
    /// columns (they still appear in single-column mode).
    public static func columns(
        state: DeckState,
        sortOrder: DeckSortOrder,
        thresholds: UsageThresholds = .default,
        now: Date = Date()
    ) -> [DeckColumn] {
        let allRows = rows(state: state, thresholds: thresholds, now: now)
        return [DeckProvider.claude, .codex].map { provider in
            DeckColumn(
                provider: provider,
                rows: sorted(allRows.filter { $0.provider == provider }, by: sortOrder)
            )
        }
    }

    /// Single-column mode: both providers interleaved by the sort order.
    public static func interleavedRows(
        state: DeckState,
        sortOrder: DeckSortOrder,
        thresholds: UsageThresholds = .default,
        now: Date = Date()
    ) -> [DeckAccountRow] {
        sorted(rows(state: state, thresholds: thresholds, now: now), by: sortOrder)
    }

    // MARK: - Windows

    static func window(from snapshot: UsageSnapshot, thresholds: UsageThresholds, now: Date) -> DeckWindow {
        let remaining = snapshot.remainingPercent ?? snapshot.usedPercent.map { 100 - $0 }
        let resetDate = DeckDateParsing.date(from: snapshot.resetsAt)
        return DeckWindow(
            scope: snapshot.scope,
            title: windowTitle(for: snapshot.scope),
            remainingPercent: remaining,
            resetsAt: resetDate,
            resetText: resetText(for: resetDate, now: now),
            severity: UsageSeverity.severity(remainingPercent: remaining, thresholds: thresholds),
            stale: snapshot.stale
        )
    }

    /// Issue #28: a spend row with no reset data and zero/unknown usage is
    /// meaningless for subscription users — hide it entirely.
    static func isMeaninglessSpend(_ window: DeckWindow) -> Bool {
        guard window.isSpend, window.resetsAt == nil else { return false }
        guard let remaining = window.remainingPercent else { return true } // unknown usage
        return remaining >= 100 // zero usage
    }

    /// Display title for a daemon scope: "5h" → "5-hour limit",
    /// "week" → "Weekly · all models", model-scoped weeklies (both the
    /// "week:<model>" prefix form and the daemon's "<Model> weekly" labels)
    /// → "Weekly · <Model>", "spend" → "Spend", anything else passes through.
    public static func windowTitle(for scope: String) -> String {
        let lower = scope.lowercased()
        switch lower {
        case "5h", "5hr", "5-hour", "five_hour", "session":
            return "5-hour limit"
        case "week", "weekly", "7d":
            return "Weekly · all models"
        case "spend":
            return "Spend"
        default:
            for separator in [":", "_", "-", " "] where lower.hasPrefix("week\(separator)") {
                let model = scope.dropFirst("week".count + separator.count)
                if !model.isEmpty {
                    return "Weekly · \(model.prefix(1).uppercased() + model.dropFirst())"
                }
            }
            // Daemon-labelled model-scoped weekly, e.g. "Fable weekly".
            for separator in [" ", "_", "-"] where lower.hasSuffix("\(separator)weekly") {
                let model = scope.dropLast("weekly".count + separator.count)
                if !model.isEmpty, !UsageScope.isSpend(String(model)) {
                    return "Weekly · \(model.prefix(1).uppercased() + model.dropFirst())"
                }
            }
            return scope
        }
    }

    /// Expanded-view ordering: 5-hour first, weekly-all-models, then
    /// model-scoped windows (mockup §02 ordering); spend is always the
    /// tertiary last row (issue #28).
    static func windowRank(scope: String) -> Int {
        if UsageScope.isSpend(scope) { return 3 }
        switch windowTitle(for: scope) {
        case "5-hour limit": return 0
        case "Weekly · all models": return 1
        default: return 2
        }
    }

    // MARK: - Reset text

    /// Human reset text in Claude Code's usage-panel style (issue #28):
    /// "Resets in 57 min" within the hour, "Resets in 3 hr 10 min" within a
    /// day, "Resets Wed 5:59 PM PDT" within a week (issue #30: absolute
    /// clock times carry the time-zone abbreviation), "Resets Jul 24" beyond
    /// (date only — no clock time, so no zone).
    public static func resetText(for date: Date?, now: Date, calendar: Calendar = .current) -> String {
        guard let date else { return "no reset data" }
        let interval = date.timeIntervalSince(now)
        if interval <= 0 { return "resetting now" }
        if interval < 3_600 {
            return "Resets in \(max(1, Int(interval / 60))) min"
        }
        if interval < 86_400 {
            let hours = Int(interval / 3_600)
            let minutes = Int(interval.truncatingRemainder(dividingBy: 3_600) / 60)
            return minutes > 0 ? "Resets in \(hours) hr \(minutes) min" : "Resets in \(hours) hr"
        }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        if interval < 7 * 86_400 {
            formatter.dateFormat = "EEE h:mm a zzz"
        } else {
            formatter.dateFormat = "MMM d"
        }
        return "Resets \(formatter.string(from: date))"
    }
}

/// Lenient ISO-8601 parsing for the daemon's timestamp strings.
public enum DeckDateParsing {
    private static func makeFormatter(fractional: Bool) -> ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        if fractional {
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        }
        return formatter
    }

    public static func date(from string: String?) -> Date? {
        guard let string, !string.isEmpty else { return nil }
        if let date = makeFormatter(fractional: false).date(from: string) { return date }
        if let date = makeFormatter(fractional: true).date(from: string) { return date }
        // Millisecond epoch (the daemon stores JS Date.now() in places).
        if let epoch = Double(string) {
            return Date(timeIntervalSince1970: epoch > 10_000_000_000 ? epoch / 1000 : epoch)
        }
        return nil
    }
}

/// Failures specific to the Activate flow (issue #6).
public enum DeckActivationError: Error, Equatable, Sendable, LocalizedError {
    /// The POST succeeded but a fresh `GET /api/state` did not confirm the
    /// switch — the optimistic badge must be reverted.
    case verificationFailed

    public var errorDescription: String? {
        switch self {
        case .verificationFailed:
            return "The daemon did not confirm the switch."
        }
    }
}

/// UI state for the popover deck: layout, sort order, which rows are
/// expanded, and the Activate flow (optimistic flip → POST → verify →
/// commit-or-revert). Row/column content stays pure derivation over
/// `MenuBarStatusModel.deckState`, plus the activation override. Since the
/// 2026-07-19 spec amendment the Activate flow is driven from
/// Settings → Accounts; the machinery here is unchanged.
@MainActor
public final class DeckPopoverModel: ObservableObject {
    static let layoutDefaultsKey = "modeldeck.popover.layout"
    static let sortDefaultsKey = "modeldeck.popover.sort"

    @Published public var layout: DeckLayout {
        didSet {
            defaults.set(layout.rawValue, forKey: Self.layoutDefaultsKey)
            onSelectionChange?(layout, sortOrder)
        }
    }
    @Published public var sortOrder: DeckSortOrder {
        didSet {
            defaults.set(sortOrder.rawValue, forKey: Self.sortDefaultsKey)
            onSelectionChange?(layout, sortOrder)
        }
    }

    /// Fires whenever layout or sort changes (popover controls or Settings
    /// window alike). The app forwards these to the daemon settings sync,
    /// whose per-field no-op guards break the echo loop.
    public var onSelectionChange: ((DeckLayout, DeckSortOrder) -> Void)?
    @Published public private(set) var expandedAccountIDs: Set<String> = []

    // MARK: Activation state (issue #6)

    /// Account currently mid-activation, or nil. One switch at a time.
    @Published public private(set) var activatingAccountID: String?
    /// Inline error text per account id, shown under the Activate button.
    @Published public private(set) var activationErrors: [String: String] = [:]
    /// Optimistic ACTIVE override, keyed by provider key. While set, rows of
    /// that provider render the override target as active regardless of what
    /// the (still stale) daemon state says. Cleared on verified success
    /// (fresh state then agrees) or reverted on failure.
    @Published private var optimisticActive: [String: String] = [:]

    /// Called with the fresh, verified `DeckState` after a successful switch
    /// so the app can push it into `MenuBarStatusModel` without waiting for
    /// the next refresh tick.
    public var onVerifiedState: ((DeckState) -> Void)?

    public var thresholds: UsageThresholds
    private let defaults: UserDefaults
    private let activator: (any AccountActivating)?
    private let stateProvider: (any DeckStateProviding)?

    public init(
        thresholds: UsageThresholds = .default,
        defaults: UserDefaults = .standard,
        activator: (any AccountActivating)? = nil,
        stateProvider: (any DeckStateProviding)? = nil
    ) {
        self.thresholds = thresholds
        self.defaults = defaults
        self.activator = activator
        self.stateProvider = stateProvider
        self.layout = defaults.string(forKey: Self.layoutDefaultsKey)
            .flatMap(DeckLayout.init(rawValue:)) ?? .twoColumn
        self.sortOrder = defaults.string(forKey: Self.sortDefaultsKey)
            .flatMap(DeckSortOrder.init(rawValue:)) ?? .nextReset
    }

    public func isExpanded(_ accountID: String) -> Bool {
        expandedAccountIDs.contains(accountID)
    }

    public func toggleExpansion(of accountID: String) {
        if expandedAccountIDs.contains(accountID) {
            expandedAccountIDs.remove(accountID)
        } else {
            expandedAccountIDs.insert(accountID)
        }
    }

    /// Two-column mode content.
    public func columns(for state: DeckState, now: Date = Date()) -> [DeckColumn] {
        DeckBuilder.columns(state: state, sortOrder: sortOrder, thresholds: thresholds, now: now)
            .map { DeckColumn(provider: $0.provider, rows: applyingActivation($0.rows)) }
    }

    /// Single-column mode content (both providers interleaved by sort).
    public func interleavedRows(for state: DeckState, now: Date = Date()) -> [DeckAccountRow] {
        applyingActivation(
            DeckBuilder.interleavedRows(state: state, sortOrder: sortOrder, thresholds: thresholds, now: now)
        )
    }

    // MARK: - Activate (issue #6)

    /// Whether Activate can be offered at all (client + verifier wired in).
    public var canActivate: Bool {
        activator != nil && stateProvider != nil
    }

    public func activationError(for accountID: String) -> String? {
        activationErrors[accountID]
    }

    /// One-click switch for a non-active account (Settings → Accounts since
    /// the 2026-07-19 spec amendment): flip the active checkmark
    /// optimistically, `POST …/activate`, then verify against a fresh
    /// `GET /api/state`; on any failure revert the flip and surface an
    /// inline error. The daemon owns the new-sessions-only semantics — this
    /// never touches running sessions and adds nothing beyond the call.
    public func activate(_ row: DeckAccountRow) async {
        guard !row.isActive, activatingAccountID == nil else { return }
        guard let activator, let stateProvider else { return }
        let key = Self.activationKey(for: row.account)
        let previous = optimisticActive[key]
        activationErrors[row.id] = nil
        activatingAccountID = row.id
        optimisticActive[key] = row.id // optimistic flip — badge moves now
        defer { activatingAccountID = nil }
        do {
            _ = try await activator.activateAccount(id: row.id)
            let fresh = try await stateProvider.deckState()
            guard fresh.accounts.first(where: { $0.id == row.id })?.isDefault == true else {
                throw DeckActivationError.verificationFailed
            }
            // Verified: the fresh state carries the badge itself, so the
            // override can go before the state is pushed to the UI.
            optimisticActive[key] = nil
            onVerifiedState?(fresh)
        } catch {
            optimisticActive[key] = previous // revert the flip
            activationErrors[row.id] = Self.activationMessage(for: error)
        }
    }

    /// Rows with the optimistic ACTIVE override applied: within an
    /// overridden provider, exactly the target row is active.
    func applyingActivation(_ rows: [DeckAccountRow]) -> [DeckAccountRow] {
        guard !optimisticActive.isEmpty else { return rows }
        return rows.map { row in
            guard let target = optimisticActive[Self.activationKey(for: row.account)] else { return row }
            var row = row
            row.isActive = row.id == target
            return row
        }
    }

    /// Override scope key: one active account per provider (spec "Active
    /// semantics"), so overrides are keyed by the daemon's provider string.
    static func activationKey(for account: DeckAccount) -> String {
        DeckProvider.from(account.provider)?.rawValue ?? account.provider.lowercased()
    }

    static func activationMessage(for error: Error) -> String {
        switch error {
        case DeckActivationError.verificationFailed:
            return "Switch not confirmed — the daemon still reports the previous account."
        case DaemonClientError.daemonError(let message, _):
            return "Couldn't activate: \(message)"
        default:
            return "Couldn't activate: \(error.localizedDescription)"
        }
    }
}
