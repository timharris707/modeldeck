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
    /// Issue #101: how this window's reset presents — `.anchored` (normal
    /// timestamp), `.unanchored` (no usage this period; the provider's
    /// resetsAt is a drifting placeholder, so `resetText` carries the
    /// "resets N after first use" copy instead), or `.recentlyRolled`
    /// (annotated via `rolloverText`). See WindowPresentation.swift for
    /// the detection heuristics.
    public var anchor: WindowAnchor
    /// Issue #101: the small "Week reset just now / at 10:19 AM" line for a
    /// recently rolled window, nil otherwise.
    public var rolloverText: String?

    public var id: String { scope }

    /// Issue #101: hover tooltip for the reset text. Anchored windows keep
    /// the absolute-timestamp backstop (issue #67); unanchored windows
    /// explain the fresh-window state instead of surfacing the placeholder
    /// timestamp the copy just declined to show.
    public var resetTooltip: String {
        if case .unanchored(let duration) = anchor {
            return WindowPresentation.unanchoredTooltip(windowDuration: duration)
        }
        return DeckBuilder.absoluteResetText(for: resetsAt)
            ?? "The provider didn't report a reset time for this window"
    }

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
        stale: Bool,
        anchor: WindowAnchor = .anchored,
        rolloverText: String? = nil
    ) {
        self.scope = scope
        self.title = title
        self.remainingPercent = remainingPercent
        self.resetsAt = resetsAt
        self.resetText = resetText
        self.severity = severity
        self.stale = stale
        self.anchor = anchor
        self.rolloverText = rolloverText
    }
}

/// One account row in the deck. Collapsed it shows the worst window's bar,
/// % left, and next reset; expanded it lists every window.
public struct DeckAccountRow: Equatable, Identifiable, Sendable {
    public var account: DeckAccount
    public var provider: DeckProvider?
    public var windows: [DeckWindow]
    /// Whether this is the provider's DB-default account (the account the
    /// daemon INTENDS new sessions to use — spec amendment 2026-07-19
    /// replaced the ACTIVE badge, and the Activate control lives in
    /// Settings → Accounts). Whether that intent is physically in effect is
    /// `activationState` (issue #55).
    public var isActive: Bool
    /// The provider's verified physical activation state (issue #55).
    /// `.unknown` when the daemon didn't report it (pre-#56) — the marker
    /// then renders the full checkmark exactly as before.
    public var activationState: ProviderActivationState
    /// Issue #89: the newest provider observation across ALL of this
    /// account's usage snapshots (computed by `DeckBuilder.rows` before any
    /// window filtering). Feeds the per-card staleness marker; nil when no
    /// snapshot carries a parseable `observedAt`.
    public var newestObservedAt: Date?

    public var id: String { account.id }

    /// Issue #89: this card's staleness marker, or nil while its data is
    /// fresh. Pure derivation so the threshold math is unit-testable; the
    /// view calls this with the app's effective auto-refresh interval.
    /// Issue #98: suppressed while the keychain recovery notice is up — one
    /// notice per card, and the actionable one wins over the bare age line
    /// (the denial is WHY the data is aging).
    /// Issue #114: likewise suppressed while the sign-in recovery notice is
    /// up — one notice per card, and "Sign in needed" explains the aging
    /// data better than the age itself.
    public func staleness(now: Date, autoRefreshInterval: TimeInterval) -> DeckFreshness.CardStaleness? {
        guard keychainRecovery == nil, signInRecovery == nil else { return nil }
        return DeckFreshness.cardStaleness(
            newestObservedAt: newestObservedAt,
            lastRefreshError: account.lastRefreshError,
            now: now,
            autoRefreshInterval: autoRefreshInterval
        )
    }

    /// Issue #98: non-nil when macOS denied the daemon's read of this
    /// account's existing Keychain credentials (dismissed prompt). The card
    /// renders it as an actionable warning line — "ModelDeck needs Keychain
    /// access" with the Refresh + Always Allow coaching in the tooltip —
    /// instead of silently stale-looking data.
    public var keychainRecovery: DeckFreshness.KeychainAccessRecovery? {
        DeckFreshness.keychainRecovery(for: account)
    }

    /// Issue #114: non-nil when the daemon reported `signin-required` — the
    /// stored sign-in is missing or expired (for Claude, the structural fate
    /// of every non-active account under CLI ≥ 2.1.216). The card renders an
    /// actionable "Sign in needed" line instead of a bare stale age.
    /// Mutually exclusive with `keychainRecovery` (single-valued authState).
    public var signInRecovery: DeckFreshness.SignInRecovery? {
        DeckFreshness.signInRecovery(for: account)
    }

    /// How this row's active marker renders when `isActive`: the full
    /// checkmark only when activation is physically effective (or
    /// unreported); a hollow warning-tinted marker with an honest caption
    /// otherwise.
    public var activeIndicator: ActiveIndicator {
        ActiveIndicator.indicator(for: activationState)
    }

    /// The window with the lowest % left — what the collapsed line shows.
    ///
    /// Issue #28: spend is excluded from the headline pick (card headline,
    /// Lowest sort key, worst summary). Only when every non-spend window is
    /// absent does the headline fall back to whatever exists.
    ///
    /// Issue #53 tie-break: among windows tied at the worst remainingPercent,
    /// prefer one that carries a real upcoming reset (soonest first) — the
    /// collapsed headline must never say "no reset data" while a sibling at
    /// the same percent shows a reset time. Only when NO tied window has a
    /// reset does the pick fall back to display order (5-hour first).
    public var worstWindow: DeckWindow? {
        let measurable = windows.filter { $0.remainingPercent != nil }
        let rateLimits = measurable.filter { !$0.isSpend }
        let eligible = rateLimits.isEmpty ? measurable : rateLimits
        guard let worst = eligible.compactMap(\.remainingPercent).min() else { return nil }
        let tied = eligible.filter { $0.remainingPercent == worst }
        let withReset = tied
            .compactMap { window in window.resetsAt.map { (window, $0) } }
            .min { $0.1 < $1.1 }?.0
        return withReset ?? tied.first
    }

    /// Issue #33 amendment (2026-07-20): the top-right headline "% left"
    /// renders ONLY while the card is collapsed — it summarizes the worst
    /// meter you can't see. Expanded cards list every window with its own
    /// percent, so the headline hides (no duplicated number); it returns on
    /// collapse. Both layouts share this rule.
    public func headlineWindow(isExpanded: Bool) -> DeckWindow? {
        isExpanded ? nil : worstWindow
    }

    /// The Reset sort key (issue #43): the DISPLAYED binding (worst)
    /// window's reset — the same reset time the collapsed card shows — so
    /// visible order always matches visible text. The old key (soonest
    /// reset across ALL windows) sorted by a number the user couldn't see,
    /// e.g. a nearly-idle 5-hour window resetting in minutes. Nil when the
    /// binding window carries no reset data; those rows sort last.
    public var displayedReset: Date? {
        worstWindow?.resetsAt
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

    /// VoiceOver label for the whole card button. The card's Button carries
    /// an EXPLICIT accessibility label, which suppresses the child marker
    /// views' own labels — so every state the row's markers show must be
    /// spoken here (issue #55's pending caption, issue #73's opted-in
    /// email, and issue #65's duplicate-token warning). Pure derivation so
    /// it is directly unit testable; the view calls this verbatim.
    public func accessibilityLabel(showsIdentity: Bool) -> String {
        let identity = showsIdentity
            ? (account.identity.flatMap { $0.isEmpty ? nil : ", \($0)" } ?? "")
            : ""
        var label: String
        if case .pending(let caption) = activeIndicator {
            label = "\(account.label)\(identity), marked active, pending — \(caption)"
        } else {
            label = "\(account.label)\(identity)\(isActive ? ", active" : "")"
        }
        if account.hasDuplicateToken {
            label += ", \(DuplicateTokenMarker.accessibilityLabel)"
        }
        return label
    }

    public init(
        account: DeckAccount,
        provider: DeckProvider?,
        windows: [DeckWindow],
        isActive: Bool,
        activationState: ProviderActivationState = .unknown,
        newestObservedAt: Date? = nil
    ) {
        self.account = account
        self.provider = provider
        self.windows = windows
        self.isActive = isActive
        self.activationState = activationState
        self.newestObservedAt = newestObservedAt
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
                let snapshots = usageByAccount[account.id] ?? []
                let windows = snapshots
                    .map { window(from: $0, thresholds: thresholds, now: now) }
                    .filter { !isMeaninglessSpend($0) }
                    .sorted { lhs, rhs in
                        let l = windowRank(scope: lhs.scope)
                        let r = windowRank(scope: rhs.scope)
                        if l != r { return l < r }
                        return lhs.scope.localizedCaseInsensitiveCompare(rhs.scope) == .orderedAscending
                    }
                let provider = DeckProvider.from(account.provider)
                return DeckAccountRow(
                    account: account,
                    provider: provider,
                    windows: windows,
                    isActive: account.isDefault,
                    activationState: provider.map { state.activationState(for: $0) } ?? .unknown,
                    // Issue #89: from ALL snapshots (pre-filter) — the card's
                    // data age must not shift when a spend row is hidden.
                    newestObservedAt: snapshots
                        .compactMap { DeckDateParsing.date(from: $0.observedAt) }
                        .max()
                )
            }
    }

    /// Rows sorted by the given order. Ties break by label so the order is stable.
    public static func sorted(_ rows: [DeckAccountRow], by order: DeckSortOrder) -> [DeckAccountRow] {
        rows.sorted { lhs, rhs in
            switch order {
            case .nextReset:
                // Issue #43: keyed on the displayed (binding) window's
                // reset, never a hidden window's.
                let l = lhs.displayedReset ?? .distantFuture
                let r = rhs.displayedReset ?? .distantFuture
                if l != r { return l < r }
            case .lowestRemaining:
                let l = lhs.lowestRemaining ?? .infinity
                let r = rhs.lowestRemaining ?? .infinity
                if l != r { return l < r }
            case .provider:
                // Issue #30: group by provider even in single-column mode;
                // within a provider group keep the Reset order (displayed
                // binding reset, issue #43). In two-column mode every row in
                // a column shares a provider, so this degrades to Reset.
                let lp = providerRank(lhs.provider)
                let rp = providerRank(rhs.provider)
                if lp != rp { return lp < rp }
                let l = lhs.displayedReset ?? .distantFuture
                let r = rhs.displayedReset ?? .distantFuture
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
        // Issue #101: classify the window (anchored / unanchored /
        // recently rolled) so correct-but-confusing states get honest copy.
        // Spend rows are excluded — they carry no rate-limit window.
        let anchor: WindowAnchor = UsageScope.isSpend(snapshot.scope) ? .anchored : WindowPresentation.anchor(
            remainingPercent: remaining,
            resetsAt: resetDate,
            observedAt: DeckDateParsing.date(from: snapshot.observedAt),
            windowDuration: WindowPresentation.windowDuration(
                scope: snapshot.scope,
                detailMinutes: snapshot.detail?.windowDurationMins
            ),
            now: now
        )
        let text: String
        var rollover: String?
        switch anchor {
        case .unanchored(let duration):
            // The provider's resetsAt is a placeholder that drifts on every
            // refresh — never show it as a timestamp.
            text = WindowPresentation.unanchoredResetText(windowDuration: duration)
        case .recentlyRolled(let rolledAt, let duration):
            text = resetText(for: resetDate, now: now)
            rollover = WindowPresentation.rolloverText(
                rolledAt: rolledAt,
                windowDuration: duration,
                now: now
            )
        case .anchored:
            text = resetText(for: resetDate, now: now)
        }
        return DeckWindow(
            scope: snapshot.scope,
            title: windowTitle(for: snapshot.scope),
            remainingPercent: remaining,
            resetsAt: resetDate,
            resetText: text,
            severity: UsageSeverity.severity(remainingPercent: remaining, thresholds: thresholds),
            stale: snapshot.stale,
            anchor: anchor,
            rolloverText: rollover
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

    /// Issue #67: the full absolute reset timestamp for hover tooltips —
    /// "Sun Jul 26, 6:59 AM PDT" — the backstop on every reset text
    /// (collapsed and expanded) so the exact moment is always reachable
    /// even where layout must compromise. Nil when no reset data exists.
    public static func absoluteResetText(for date: Date?, calendar: Calendar = .current) -> String? {
        guard let date else { return nil }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "EEE MMM d, h:mm a zzz"
        return formatter.string(from: date)
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

/// Issue #100: one provider's live activation-trouble record — the daemon's
/// verbatim clobber-guard guidance (issue #55) or a generic activation
/// failure, attached to the account whose attempt earned it. Kept as a
/// single record per provider so the roster's one-banner-per-section surface
/// always renders the LATEST outcome; a stale record can never mask a newer
/// failure, and an orphaned record (its account removed from the roster)
/// stays surfaceable at the provider level.
public struct ActivationTrouble: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// The daemon's `code: "active-link-blocked"` refusal — rendered
        /// verbatim as guidance (issue #55), never as a generic failure.
        case guidance
        /// Any other activation failure.
        case error
    }

    public var accountID: String
    public var kind: Kind
    public var message: String

    public init(accountID: String, kind: Kind, message: String) {
        self.accountID = accountID
        self.kind = kind
        self.message = message
    }
}

/// Issue #93: the daemon's informational activation warnings, remembered
/// per provider after a successful switch. `accountID` is the row whose
/// activation earned them (so the notice can attach to the right section
/// even after a later state refresh).
public struct PostActivationWarnings: Equatable, Sendable {
    public var accountID: String
    public var warnings: [String]

    public init(accountID: String, warnings: [String]) {
        self.accountID = accountID
        self.warnings = warnings
    }
}

/// The Settings window's panes (issue #118): the deck's "Sign in again…"
/// action must open Settings ON the Accounts pane, so the tab selection is
/// model state rather than view-local.
public enum SettingsPane: Hashable, Sendable {
    case accounts
    case general
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
    static let showEmailsDefaultsKey = "modeldeck.popover.showEmails"

    @Published public var layout: DeckLayout {
        didSet {
            defaults.set(layout.rawValue, forKey: Self.layoutDefaultsKey)
            guard !isAdoptingConfirmedSettings, oldValue != layout else { return }
            onSelectionChange?(layout, sortOrder)
        }
    }
    @Published public var sortOrder: DeckSortOrder {
        didSet {
            defaults.set(sortOrder.rawValue, forKey: Self.sortDefaultsKey)
            guard !isAdoptingConfirmedSettings, oldValue != sortOrder else { return }
            onSelectionChange?(layout, sortOrder)
        }
    }

    /// Fires whenever the USER changes layout or sort (popover controls).
    /// The app forwards these to the daemon settings sync. It never fires
    /// for `adopt(confirmedLayout:confirmedSortOrder:)` — a daemon-confirmed
    /// document echoed back would seed a settings ping-pong (see the
    /// PR #68-era idle re-render loop) — nor for assignments that don't
    /// change the value.
    public var onSelectionChange: ((DeckLayout, DeckSortOrder) -> Void)?

    /// True while a daemon-confirmed settings document is being applied.
    /// Suppresses `onSelectionChange`: the daemon already holds these values,
    /// and pushing them back is how the launch-time ping-pong loop started —
    /// `layout`'s didSet fired mid-apply with the not-yet-updated `sortOrder`
    /// captured, pushed that stale sort to the daemon, whose confirmed
    /// response re-applied and flipped it back, forever (the per-field no-op
    /// guards in the sync model can't catch a stale value that genuinely
    /// differs from the freshly confirmed document).
    private var isAdoptingConfirmedSettings = false

    /// Apply a daemon-confirmed document's layout/sort WITHOUT echoing them
    /// back through `onSelectionChange`. Pass nil to leave a field alone
    /// (e.g. the popover-local provider grouping, which the daemon never
    /// stores). Values still persist to UserDefaults exactly like user
    /// selections.
    public func adopt(confirmedLayout: DeckLayout?, confirmedSortOrder: DeckSortOrder?) {
        isAdoptingConfirmedSettings = true
        defer { isAdoptingConfirmedSettings = false }
        if let confirmedLayout { layout = confirmedLayout }
        if let confirmedSortOrder { sortOrder = confirmedSortOrder }
    }
    @Published public private(set) var expandedAccountIDs: Set<String> = []

    /// Issue #113: which warning affordance's explanation popover is up, or
    /// nil. `.help` tooltips are unreliable inside a MenuBarExtra window,
    /// so every warning affordance opens an anchored explanation on click.
    /// At most ONE explanation is presented at a time — clicking the same
    /// affordance again dismisses it, clicking a different one switches.
    @Published public private(set) var presentedWarning: DeckWarningID?

    /// Whether this affordance's explanation popover is currently up.
    public func isWarningPresented(_ id: DeckWarningID) -> Bool {
        presentedWarning == id
    }

    /// Click handler: present this affordance's explanation, or dismiss it
    /// when it is already up.
    public func toggleWarning(_ id: DeckWarningID) {
        presentedWarning = presentedWarning == id ? nil : id
    }

    /// Binding-shaped setter for SwiftUI `.popover(isPresented:)`: a
    /// dismissal (outside click, Escape) clears only the matching id — a
    /// stale false from a popover that already lost the slot must never
    /// dismiss its successor.
    public func setWarningPresented(_ id: DeckWarningID, _ presented: Bool) {
        if presented {
            presentedWarning = id
        } else if presentedWarning == id {
            presentedWarning = nil
        }
    }

    /// Issue #113 (CodeRabbit): SwiftUI does NOT reset an `isPresented`
    /// binding when the anchoring `.popover` leaves the hierarchy — if a
    /// warning affordance disappears while its explanation is up (a stale
    /// account refreshes, keychain access is granted, the cadence cap
    /// lifts), `presentedWarning` would stay set and desync the
    /// one-at-a-time slot. Every fresh deck state runs this reconcile: a
    /// presented warning whose affordance is no longer live is cleared.
    public func reconcileWarnings(
        rows: [DeckAccountRow],
        staleness: (DeckAccountRow) -> DeckFreshness.CardStaleness?,
        cadenceNoticeVisible: Bool
    ) {
        guard let presented = presentedWarning,
              !Self.liveWarningIDs(
                  rows: rows,
                  staleness: staleness,
                  cadenceNoticeVisible: cadenceNoticeVisible
              ).contains(presented)
        else { return }
        presentedWarning = nil
    }

    /// Which warning affordances the deck currently renders — the mirror of
    /// the view's `if` conditions, kept here so the reconcile is testable.
    /// The footer's oldest-data line always renders (even "Not updated yet"
    /// is clickable), so `.footerFreshness` is always live.
    public static func liveWarningIDs(
        rows: [DeckAccountRow],
        staleness: (DeckAccountRow) -> DeckFreshness.CardStaleness?,
        cadenceNoticeVisible: Bool
    ) -> Set<DeckWarningID> {
        var live: Set<DeckWarningID> = [DeckWarningID(topic: .footerFreshness)]
        if cadenceNoticeVisible {
            live.insert(DeckWarningID(topic: .refreshCadence))
        }
        for row in rows {
            if row.account.hasDuplicateToken {
                live.insert(DeckWarningID(topic: .duplicateToken, elementID: row.id))
            }
            if row.keychainRecovery != nil {
                live.insert(DeckWarningID(topic: .keychainAccess, elementID: row.id))
            }
            if row.signInRecovery != nil {
                live.insert(DeckWarningID(topic: .signInRequired, elementID: row.id))
            }
            if staleness(row) != nil {
                live.insert(DeckWarningID(topic: .staleData, elementID: row.id))
            }
        }
        return live
    }

    // MARK: Sign in again from the deck (issue #118)

    /// Which Settings pane the Settings window shows. Held here because the
    /// deck model is already the one model both windows share (activation
    /// moved to Settings → Accounts on the same grounds) — the popover's
    /// "Sign in again…" action must land the user ON the Accounts pane,
    /// not wherever the tab selection last sat.
    @Published public var settingsPane: SettingsPane = .accounts

    /// Fired by `requestSignInAgain(for:)` with the target account's id.
    /// The app resolves the id against the FRESH daemon state (via
    /// `signInAgainTarget`) and hands the account to the roster's existing
    /// `AccountSignInModel.beginSignIn` — the exact same code path as
    /// clicking "Sign in again" on the roster row. No new credential
    /// machinery: this is pure navigation plumbing.
    public var onSignInAgain: ((String) -> Void)?

    // MARK: - Menu bar pin (account percentage picker)

    /// The daemon-confirmed `menuBarAccountId` mirrored here (set by the
    /// app's settings apply, same as thresholds) so the cards' context
    /// menus can render and toggle the pin. "" = lowest across accounts;
    /// `MenuBarPinResolver` grammar otherwise. Plain assignment — adopting
    /// a confirmed document never echoes back to the daemon because pin
    /// changes go through `onPinMenuBarAccount`, never through this
    /// property's setter.
    @Published public var menuBarPinnedSetting: String = ""

    /// Fired when a card's context menu picks a new pin value ("" = unpin,
    /// account id, or a follow-active sentinel). The app wires it to
    /// `SettingsSyncModel.setMenuBarAccount`, whose confirmed document then
    /// flows back into `menuBarPinnedSetting` via the settings apply.
    public var onPinMenuBarAccount: ((String) -> Void)?

    /// Whether this exact account id is the stored pin (follow-active
    /// sentinels deliberately don't match: the context menu shows the
    /// follow-active checkmark on its own item instead).
    public func isMenuBarPinned(_ accountID: String) -> Bool {
        menuBarPinnedSetting == accountID
    }

    public func isMenuBarFollowingActive(provider: DeckProvider) -> Bool {
        menuBarPinnedSetting == MenuBarPinResolver.followActiveSentinel(for: provider)
    }

    /// Pin/unpin this specific account from a card's context menu.
    public func toggleMenuBarPin(accountID: String) {
        onPinMenuBarAccount?(isMenuBarPinned(accountID) ? "" : accountID)
    }

    /// Toggle the provider's follow-active mode from a card's context menu.
    public func toggleMenuBarFollowActive(provider: DeckProvider) {
        onPinMenuBarAccount?(
            isMenuBarFollowingActive(provider: provider)
                ? ""
                : MenuBarPinResolver.followActiveSentinel(for: provider)
        )
    }

    /// The #118 one-click path: the "Sign in again…" button inside the
    /// sign-in-needed explanation popover. Dismisses whatever explanation is
    /// up (the button IS inside it), routes Settings to the Accounts pane,
    /// and fires `onSignInAgain`. No-op (beyond the dismissal) when the
    /// row's notice has cleared — a state refresh may have landed a
    /// verified sign-in between render and click, and re-launching the flow
    /// for a healthy account would be noise.
    public func requestSignInAgain(for row: DeckAccountRow) {
        presentedWarning = nil
        guard row.signInRecovery != nil else { return }
        settingsPane = .accounts
        onSignInAgain?(row.id)
    }

    /// Resolves a requested sign-in target against the freshest daemon
    /// state. Nil when the account vanished (removed between click and
    /// dispatch) — the flow then quietly does nothing rather than launching
    /// a login for a ghost. Nil likewise when the account no longer needs a
    /// sign-in (a verified sign-in landed between the render-time click and
    /// this dispatch): the recovery check uses the SAME derivation the card
    /// notice renders from (`DeckFreshness.signInRecovery`, issue #114), so
    /// the action and the notice can never diverge on who needs signing in.
    nonisolated public static func signInAgainTarget(
        accountID: String,
        state: DeckState?
    ) -> DeckAccount? {
        state?.accounts.first {
            $0.id == accountID && DeckFreshness.signInRecovery(for: $0) != nil
        }
    }

    /// Issue #73: whether deck rows show the account identity (email) under
    /// the label. DEFAULT OFF — identity appeared on Claude rows as a side
    /// effect of #62's capture, unrequested and asymmetric. When ON, both
    /// providers render uniformly (an account without a captured identity
    /// simply shows nothing). App-local preference (UserDefaults), never
    /// synced to the daemon; Settings → Accounts always shows identities —
    /// it's the management surface.
    @Published public var showAccountEmails: Bool {
        didSet { defaults.set(showAccountEmails, forKey: Self.showEmailsDefaultsKey) }
    }

    // MARK: Activation state (issue #6)

    /// Account currently mid-activation, or nil. One switch at a time.
    @Published public private(set) var activatingAccountID: String?
    /// Issue #100: ONE live activation-trouble record per provider key —
    /// the daemon's verbatim clobber-guard guidance (issue #55) or a generic
    /// failure, attached to the account whose attempt earned it. Single-slot
    /// BY DESIGN: activation runs one switch at a time and the roster shows
    /// one banner per provider section, so a stale record for one account
    /// must never linger and mask a newer failure on another — the exact
    /// mechanism behind issue #100's "clicked the radio, nothing happened".
    @Published private var activationTroubleByProvider: [String: ActivationTrouble] = [:]
    /// Issue #93: the daemon's informational `warnings` from the last
    /// verified-successful activation, keyed by provider activation key (one
    /// notice per provider — a newer switch supersedes the previous notice).
    /// Purely informational: the switch has already happened by the time the
    /// daemon attaches these, so they render as a calm post-activation
    /// notice, never a blocker. Cleared when the user dismisses the notice
    /// or the provider's next activation starts.
    @Published public private(set) var postActivationWarnings: [String: PostActivationWarnings] = [:]
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
        // Absent key reads false — the issue #73 default-off requirement.
        self.showAccountEmails = defaults.bool(forKey: Self.showEmailsDefaultsKey)
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
        activationTroubleByProvider.values
            .first { $0.accountID == accountID && $0.kind == .error }?.message
    }

    /// The daemon's one-time-migration guidance for a refused activation of
    /// this account (issue #55), or nil.
    public func blockedActivationGuidance(for accountID: String) -> String? {
        activationTroubleByProvider.values
            .first { $0.accountID == accountID && $0.kind == .guidance }?.message
    }

    /// Issue #100: the provider's live activation-trouble record, whichever
    /// account earned it. The roster's banner derivation uses this to keep a
    /// failure visible even when its account has since left the roster —
    /// the per-account lookups above can never find an orphaned record.
    public func activationTrouble(for provider: DeckProvider) -> ActivationTrouble? {
        activationTroubleByProvider[provider.rawValue]
    }

    /// Issue #93: the informational warnings from this provider's last
    /// activation, or nil when there is nothing to show.
    public func postActivationWarnings(for provider: DeckProvider) -> PostActivationWarnings? {
        postActivationWarnings[provider.rawValue]
    }

    /// Issue #93: the user acknowledged the notice — it never comes back for
    /// that activation (the next switch computes fresh warnings).
    public func dismissPostActivationWarnings(for provider: DeckProvider) {
        postActivationWarnings[provider.rawValue] = nil
    }

    /// One-click switch for a non-active account (Settings → Accounts since
    /// the 2026-07-19 spec amendment): flip the active checkmark
    /// optimistically, `POST …/activate`, then verify against a fresh
    /// `GET /api/state`; on any failure revert the flip and surface an
    /// inline error. The daemon owns the new-sessions-only semantics — this
    /// never touches running sessions and adds nothing beyond the call.
    ///
    /// Issue #61: the DB-active row is allowed back in when its activation
    /// is link-pending (blocked/unlinked/mismatched) — the Complete
    /// Activation affordance re-runs the same daemon activate to lay the
    /// symlink once the user has cleared the blocker.
    public func activate(_ row: DeckAccountRow) async {
        let key = Self.activationKey(for: row.account)
        // Issue #100: NO silent terminal states, and no STALE ones either.
        // A new attempt supersedes the provider's previous trouble record
        // immediately — every path below either succeeds (leaving no stale
        // record on screen) or re-records its own outcome. An attempt that
        // ends in "nothing happened" is the bug.
        activationTroubleByProvider[key] = nil
        guard activatingAccountID == nil else {
            // The roster disables activation controls while a switch runs,
            // so reaching here means a stale render raced an in-flight
            // switch. Say so instead of swallowing the click.
            activationTroubleByProvider[key] = ActivationTrouble(
                accountID: row.id,
                kind: .error,
                message: "Another activation is still running — try again once it finishes."
            )
            return
        }
        guard let activator, let stateProvider else {
            activationTroubleByProvider[key] = ActivationTrouble(
                accountID: row.id,
                kind: .error,
                message: "Activation isn't available — this build has no daemon connection."
            )
            return
        }
        guard !row.isActive || row.activationState.needsLinkCompletion else {
            // The app already believes this account is active with nothing
            // left to complete, so the click can only have come from a stale
            // render. Resync so the radio/marker snaps to the daemon's truth
            // (a no-op re-render when nothing actually changed); a failed
            // read surfaces like any other activation failure.
            do {
                let fresh = try await stateProvider.deckState()
                onVerifiedState?(fresh)
            } catch {
                activationTroubleByProvider[key] = ActivationTrouble(
                    accountID: row.id,
                    kind: .error,
                    message: Self.activationMessage(for: error)
                )
            }
            return
        }
        let previous = optimisticActive[key]
        postActivationWarnings[key] = nil // a new switch supersedes the old notice
        activatingAccountID = row.id
        optimisticActive[key] = row.id // optimistic flip — badge moves now
        defer { activatingAccountID = nil }
        do {
            let outcome = try await activator.activateAccount(id: row.id)
            // Issue #93: once the POST returned, the daemon has flipped —
            // record its informational warnings NOW, before verification,
            // so a later verification failure can't swallow an honest
            // heads-up about running unpinned sessions.
            if !outcome.warnings.isEmpty {
                postActivationWarnings[key] = PostActivationWarnings(
                    accountID: row.id,
                    warnings: outcome.warnings
                )
            }
            let fresh = try await stateProvider.deckState()
            guard fresh.accounts.first(where: { $0.id == row.id })?.isDefault == true else {
                throw DeckActivationError.verificationFailed
            }
            // Verified: the fresh state carries the badge itself, so the
            // override can go before the state is pushed to the UI.
            optimisticActive[key] = nil
            // A click raced against THIS flight may have recorded "still
            // running" trouble mid-flight — the verified success supersedes
            // it, same no-stale-record principle as the top-of-attempt clear.
            activationTroubleByProvider[key] = nil
            onVerifiedState?(fresh)
        } catch {
            optimisticActive[key] = previous // revert the flip
            if let guidance = Self.blockedGuidance(for: error) {
                // Issue #55: the clobber-guard refusal is guidance, not a
                // generic failure — the daemon's message renders VERBATIM
                // in a prominent inline alert near the row.
                activationTroubleByProvider[key] = ActivationTrouble(
                    accountID: row.id, kind: .guidance, message: guidance
                )
            } else {
                activationTroubleByProvider[key] = ActivationTrouble(
                    accountID: row.id, kind: .error, message: Self.activationMessage(for: error)
                )
            }
        }
    }

    /// The daemon's verbatim guidance when activation hit the clobber guard
    /// (`code: "active-link-blocked"`), nil for every other failure.
    nonisolated static func blockedGuidance(for error: Error) -> String? {
        guard case DaemonClientError.daemonCodedError(let message, let code, _) = error,
              code == DaemonClientError.activeLinkBlockedCode
        else { return nil }
        return message
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
        case DaemonClientError.daemonError(let message, _),
             DaemonClientError.daemonCodedError(let message, _, _):
            return "Couldn't activate: \(message)"
        default:
            return "Couldn't activate: \(error.localizedDescription)"
        }
    }
}
