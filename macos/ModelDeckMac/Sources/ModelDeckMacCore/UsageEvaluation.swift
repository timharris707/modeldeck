import Foundation

/// Warning thresholds on **% left** (design authority: design/mac-app-spec.md
/// and DESIGN.md warning semantics — warn at ≤25% left, critical at ≤10%,
/// both user-configurable in a later phase).
public struct UsageThresholds: Equatable, Sendable {
    public var warningPercent: Double
    public var criticalPercent: Double

    public init(warningPercent: Double = 25, criticalPercent: Double = 10) {
        self.warningPercent = warningPercent
        self.criticalPercent = criticalPercent
    }

    public static let `default` = UsageThresholds()
}

/// Scope classification shared by every worst-remaining computation.
///
/// Issue #28 (Tim's call, overrides mockups): the `spend` scope is the least
/// important signal for subscription users, so it must never drive the card
/// headline, the Lowest sort, or the menu bar icon severity. It only counts
/// when no other scope exists at all (fallback).
public enum UsageScope {
    /// Whether a daemon scope string names a spend/extra-usage budget rather
    /// than a rate-limit window.
    public static func isSpend(_ scope: String) -> Bool {
        scope.lowercased().contains("spend")
    }
}

/// The lowest remaining % across all enabled accounts and windows — the
/// single number that drives the menu bar icon.
public struct WorstRemaining: Equatable, Sendable {
    public var percent: Double
    public var accountId: String
    public var scope: String
    public var resetsAt: String?
    public var stale: Bool

    public init(percent: Double, accountId: String, scope: String, resetsAt: String? = nil, stale: Bool = false) {
        self.percent = percent
        self.accountId = accountId
        self.scope = scope
        self.resetsAt = resetsAt
        self.stale = stale
    }

    /// Integer percent for display beside the glyph ("N%").
    public var displayPercent: Int {
        Int(percent.rounded())
    }
}

/// Menu bar icon states per the locked spec decision: plain template deck
/// glyph when healthy; gold "N%" beside it below the warning threshold; red
/// at critical; the percent auto-hides on recovery (back to `.plain`).
/// Issue #58 adds `.loading` — the intentional cold-start state before the
/// first fetch completes: a muted "–%" placeholder so the blank pre-data
/// icon reads as "loading", never as "healthy".
public enum MenuBarIconState: Equatable, Sendable {
    /// Cold start: no state fetch has succeeded yet (issue #58).
    case loading
    case plain
    /// A pinned account above the warning threshold: the percent is shown
    /// continuously (Tim's picker request), in the neutral label color so
    /// it never reads as a severity signal.
    case pinned(percentRemaining: Int)
    case warning(percentRemaining: Int)
    case critical(percentRemaining: Int)
    /// Issue #235: the Availability Health display mode — the menu bar
    /// shows the provider's verdict as a full-color, shape-coded status
    /// dot beside the template glyph (green circle / yellow triangle /
    /// red octagon; the verdict stays available as text via accessibility
    /// and the deck chip). A nil verdict (no state yet, or no usable
    /// accounts) renders a muted hollow ring so the mode never claims a
    /// health it can't compute. Display-only, like #229's icon-only mode:
    /// `worstRemaining` and the notification path keep watching every
    /// account.
    case health(provider: DeckProvider, verdict: AvailabilityVerdict?)

    /// `alwaysShowPercent` is the pinned-account mode: a healthy percent
    /// renders as `.pinned` instead of hiding behind the plain glyph.
    /// Warning/critical severities are unchanged either way.
    public static func state(
        for worst: WorstRemaining?,
        thresholds: UsageThresholds = .default,
        alwaysShowPercent: Bool = false
    ) -> MenuBarIconState {
        guard let worst else { return .plain }
        if worst.percent <= thresholds.criticalPercent {
            return .critical(percentRemaining: worst.displayPercent)
        }
        if worst.percent <= thresholds.warningPercent {
            return .warning(percentRemaining: worst.displayPercent)
        }
        return alwaysShowPercent ? .pinned(percentRemaining: worst.displayPercent) : .plain
    }

    /// "N%" when the percent is shown, the neutral "–%" placeholder while
    /// loading; nil when the icon is plain. Health mode carries no percent
    /// — its verdict word renders through the renderer's dedicated path.
    public var percentLabel: String? {
        switch self {
        case .plain, .health: return nil
        case .loading: return "–%"
        case .pinned(let percent), .warning(let percent), .critical(let percent): return "\(percent)%"
        }
    }
}

/// The stored `menuBarAccountId` setting's grammar (account percentage
/// picker): "" = lowest across accounts, a plain account id = that account,
/// the "active:<provider>" sentinels = whichever account is currently
/// ACTIVE for that provider — Tim's "track my current active account" mode,
/// which follows every activation switch automatically — "none"
/// (issue #229) = hide the percentage entirely, glyph only, and
/// "health:<provider>" (issue #235) = show that provider's Availability
/// Health verdict instead of a percentage.
public enum MenuBarPinResolver {
    /// The stored value that follows a provider's active account.
    public static func followActiveSentinel(for provider: DeckProvider) -> String {
        "active:\(provider.rawValue)"
    }

    /// Issue #235: the stored value that shows a provider's Availability
    /// Health verdict in the menu bar instead of a percentage. Rides the
    /// same free-string setting as the #229 "none" sentinel, with the same
    /// downgrade contract: a pre-#235 build reading "health:claude" finds
    /// no matching account id, treats it as an unresolvable pin, and falls
    /// back to the lowest-across percentage — degraded but never a crash.
    public static func healthSentinel(for provider: DeckProvider) -> String {
        "health:\(provider.rawValue)"
    }

    /// The provider a stored health sentinel names, or nil when the value
    /// isn't a recognizable health sentinel (including "health:" values for
    /// providers this build doesn't know — those fall back to the
    /// unresolvable-pin behavior, the same forward-compatibility path as
    /// any unknown future sentinel).
    public static func healthProvider(_ stored: String) -> DeckProvider? {
        guard stored.hasPrefix("health:") else { return nil }
        return DeckProvider(rawValue: String(stored.dropFirst("health:".count)))
    }

    /// Whether a stored value selects the issue #235 health display mode.
    public static func isHealth(_ stored: String) -> Bool {
        healthProvider(stored) != nil
    }

    /// Issue #229: the stored value that hides the menu bar percentage
    /// entirely — the ModelDeck glyph with no number, at every severity.
    /// Display-only, like the pin itself: `worstRemaining` and the
    /// notification path keep watching every account. Chosen to ride the
    /// existing free-string setting so a DOWNGRADED build reading "none"
    /// never crashes: with no account id equal to the literal string, the
    /// pin doesn't resolve and the old build falls back to lowest-across.
    /// (An account id that literally equals "none" WOULD be pinned by a
    /// pre-#229 build, which has no sentinel guard — ids are
    /// store-generated UUIDs, so the collision is implausible, but no
    /// sentinel string is collision-proof on old builds: they treat every
    /// non-"active:" value as a candidate account id. THIS build guards
    /// the collision explicitly in `resolve`.)
    public static let noneSentinel = "none"

    /// Whether a stored value is the issue #229 icon-only sentinel.
    public static func isNone(_ stored: String) -> Bool {
        stored == noneSentinel
    }

    // MARK: - Pinned window choice (issue #292)

    /// Issue #292 (Tim's field report): a pinned account always displayed
    /// its LOWEST window — usually the 5-hour burst limit — with no way to
    /// watch the window he actually plans around (the Fable weekly). An
    /// account pin can now carry a window choice: "<account id>|win:<key>"
    /// shows that window CLASS instead of the lowest. Same free-string
    /// setting, same downgrade contract as every sentinel: an old build
    /// reads the whole value as a candidate account id, finds no match,
    /// and falls back to lowest-across — degraded but never a crash.
    public enum PinWindow: String, CaseIterable, Sendable {
        /// The 5-hour burst limit.
        case fiveHour = "5h"
        /// The all-models weekly window.
        case generalWeekly = "weekly"
        /// The model-scoped weekly window (e.g. "Weekly · Fable") — keyed
        /// on the CLASS, not a model name, so a provider-side model rename
        /// never strands the pin.
        case modelWeekly = "model"

        /// Whether a snapshot scope belongs to this window class — the
        /// same classification the deck's expanded-row ordering uses.
        public func matches(scope: String) -> Bool {
            DeckBuilder.windowRank(scope: scope) == windowRank
        }

        private var windowRank: Int {
            switch self {
            case .fiveHour: return 0
            case .generalWeekly: return 1
            case .modelWeekly: return 2
            }
        }

        /// The class's generic name, for copy that has no concrete window
        /// to title (e.g. the chosen class is absent from the account).
        public var genericTitle: String {
            switch self {
            case .fiveHour: return "5-hour limit"
            case .generalWeekly: return "Weekly · all models"
            case .modelWeekly: return "model weekly"
            }
        }
    }

    /// The suffix separator carrying an account pin's window choice.
    private static let windowSeparator = "|win:"

    /// The stored value pinning an account to a window choice. A nil
    /// choice (the "Lowest window" default) stores the plain account id —
    /// byte-identical to the pre-#292 grammar, so the default never
    /// writes a value an older build would treat as unresolvable.
    public static func pinnedValue(accountId: String, window: PinWindow?) -> String {
        guard let window else { return accountId }
        return accountId + windowSeparator + window.rawValue
    }

    /// The stored value with any window-choice suffix removed — what
    /// account resolution and every base-equality check runs on.
    public static func pinBase(_ stored: String) -> String {
        guard let range = stored.range(of: windowSeparator) else { return stored }
        return String(stored[..<range.lowerBound])
    }

    /// The pin's window choice; nil for the plain grammar, every
    /// sentinel, and an unrecognized future key — which degrades to the
    /// lowest-window behavior rather than failing the whole pin.
    public static func pinWindow(_ stored: String) -> PinWindow? {
        guard let range = stored.range(of: windowSeparator) else { return nil }
        return PinWindow(rawValue: String(stored[range.upperBound...]))
    }

    /// Resolves a stored pin to a concrete account id against the current
    /// deck state; nil when it doesn't resolve (empty/unpinned, account
    /// removed, no active account for the provider, unknown sentinel) — the
    /// caller then falls back to lowest-across behavior.
    public static func resolve(_ stored: String, in state: DeckState) -> String? {
        guard !stored.isEmpty else { return nil }
        // Issue #229: "none" is a display-mode sentinel, never an account
        // pin — it must not resolve even if some account id collides with
        // the literal string.
        guard !isNone(stored) else { return nil }
        // Issue #235: every "health:"-prefixed value is likewise a
        // display-mode sentinel, never an account pin — the prefix guard
        // covers unknown future providers too.
        guard !stored.hasPrefix("health:") else { return nil }
        if stored.hasPrefix("active:") {
            guard let provider = DeckProvider(rawValue: String(stored.dropFirst("active:".count))) else {
                return nil
            }
            return state.accounts.first {
                DeckProvider.from($0.provider) == provider && $0.isDefault
            }?.id
        }
        // Issue #292: an account pin may carry a "|win:<key>" window
        // choice — resolution runs on the bare account id.
        let base = pinBase(stored)
        return state.accounts.contains { $0.id == base } ? base : nil
    }
}

/// Issue #238: the stored `menuBarShowWhen` setting's grammar — WHEN the menu
/// bar shows its indicator, layered on top of WHAT `menuBarAccountId` selects.
/// Mode-specific by design (Tim's refinement): the percentage option carries
/// its own threshold, the health options name verdicts. A value that doesn't
/// apply to the currently selected display mode (e.g. "yellow" while a
/// percentage mode is active) simply doesn't gate anything — the mode shows
/// always, exactly like the default. Unknown future values parse as `.always`
/// so a downgrade can never crash or hide data it wasn't asked to hide.
/// Display-only throughout: notifications keep watching every account
/// regardless of what the menu bar hides.
public enum MenuBarShowWhen: Equatable, Sendable {
    /// "" — the indicator is always shown (the pre-#238 behavior and the
    /// stored default; also what every unrecognized value degrades to).
    case always
    /// "below:<1-99>" — percentage modes show the number only while the
    /// displayed percent is strictly below this threshold.
    case belowPercent(Int)
    /// "yellow" — health modes show the status dot only for a YELLOW or RED
    /// verdict; a green deck renders the plain glyph.
    case yellowOrWorse
    /// "red" — health modes show the status dot only for a RED verdict.
    case redOnly

    /// The stored default: always shown.
    public static let alwaysStored = ""

    /// The stored string for this case (round-trips through `parse`).
    public var stored: String {
        switch self {
        case .always: return Self.alwaysStored
        case .belowPercent(let percent): return "below:\(percent)"
        case .yellowOrWorse: return "yellow"
        case .redOnly: return "red"
        }
    }

    /// Lenient parse: "" and every unrecognized value — including a
    /// "below:" threshold outside 1–99 — mean `.always`, the graceful
    /// degradation contract for values written by newer builds.
    public static func parse(_ stored: String) -> MenuBarShowWhen {
        switch stored {
        case alwaysStored: return .always
        case "yellow": return .yellowOrWorse
        case "red": return .redOnly
        default:
            guard stored.hasPrefix("below:"),
                  let percent = Int(stored.dropFirst("below:".count)),
                  (1...99).contains(percent)
            else { return .always }
            return .belowPercent(percent)
        }
    }

    /// The percentage-mode visibility threshold; nil when this value doesn't
    /// gate percentage display (always / health-only values).
    public var percentThreshold: Int? {
        if case .belowPercent(let percent) = self { return percent }
        return nil
    }

    /// Whether a health verdict passes this gate. Health-mode callers only:
    /// `.always` and the percentage value never hide the dot. A nil verdict
    /// (no data yet, empty provider pool) always shows — the muted no-data
    /// ring is honest "unknown", and quiet mode must never dress unknown up
    /// as all-clear.
    public func showsHealth(verdict: AvailabilityVerdict?) -> Bool {
        guard let verdict else { return true }
        switch self {
        case .always, .belowPercent: return true
        case .yellowOrWorse: return verdict != .green
        case .redOnly: return verdict == .red
        }
    }

    /// Whether a displayed percent passes this gate. Percentage-mode callers
    /// only: `.always` and the health values never hide the number.
    public func showsPercent(_ percent: Double) -> Bool {
        guard case .belowPercent(let threshold) = self else { return true }
        return percent < Double(threshold)
    }
}

/// Issue #131 (Tim directive 2026-07-22): the deck checkmark means "shown in
/// the menu bar" — it marks exactly ONE account across the whole deck, the
/// one whose window currently feeds the menu bar percentage. This resolver is
/// the single derivation of that account, mirroring
/// `MenuBarStatusModel.recomputeIconState`'s source order exactly so the
/// checkmark can never point at an account the menu bar isn't actually
/// showing:
///
/// 1. A stored pin that RESOLVES (plain account id, or a follow-active
///    sentinel with a current active account) wins — including the spend-only
///    edge, where the resolved account has no usable non-spend window and the
///    menu bar shows the plain glyph: the pin is still in force and that
///    account still owns the (empty) menu bar slot, so the checkmark stays on
///    it rather than hiding or drifting to the global worst (documented lane
///    decision on issue #131).
/// 2. Otherwise — unpinned, or an unresolvable pin (account removed, no
///    active account for the provider, unknown sentinel) — the source is the
///    lowest-remaining account across the deck (`worstRemaining`), the same
///    fallback the icon takes (#123). Nil when there is no worst either (no
///    measurable usage anywhere): no account feeds the menu bar, so no card
///    gets the checkmark.
public enum MenuBarSourceResolver {
    /// The account id whose window currently feeds the menu bar, or nil when
    /// no account does.
    public static func sourceAccountID(
        pinnedSetting: String?,
        state: DeckState?,
        worstRemaining: WorstRemaining?
    ) -> String? {
        // Issue #229: icon-only mode shows no percentage at all, so no
        // account feeds the menu bar and no card gets the checkmark —
        // mirroring recomputeIconState's plain-glyph short-circuit.
        if let pinnedSetting, MenuBarPinResolver.isNone(pinnedSetting) {
            return nil
        }
        // Issue #235: health mode shows a pool-wide verdict, not one
        // account's window — no single account feeds the menu bar, so no
        // card gets the checkmark. Keyed on the RECOGNIZED sentinel only
        // (`isHealth`), matching recomputeIconState: an unknown
        // "health:<future>" value falls through to the unresolvable-pin
        // fallback exactly like any unknown sentinel, and the checkmark
        // then honestly marks the lowest-across account the icon shows.
        if let pinnedSetting, MenuBarPinResolver.isHealth(pinnedSetting) {
            return nil
        }
        if let pinnedSetting, let state,
           let resolved = MenuBarPinResolver.resolve(pinnedSetting, in: state) {
            return resolved
        }
        return worstRemaining?.accountId
    }

    /// Hover tooltip for the deck's single source checkmark — honest per
    /// mode, including the fallback case where a stored pin didn't resolve
    /// and the lowest-across account is what the menu bar actually shows.
    /// `resolvedPinnedAccountID` is `resolve(pinnedSetting, in: state)` —
    /// passed in (rather than recomputed) so the copy is keyed on the same
    /// resolution the marked row was chosen by.
    /// Issue #249: `windowTitle`, when the menu bar is currently showing a
    /// percent from this account, names the WINDOW feeding that number —
    /// the checkmark named the account but not the window, which is exactly
    /// the half that read as a mix-up when the cards were toggled to a
    /// different headline window.
    public static func checkmarkTooltip(
        pinnedSetting: String?,
        resolvedPinnedAccountID: String?,
        accountID: String,
        windowTitle: String? = nil
    ) -> String {
        let base: String
        if pinnedSetting == nil || pinnedSetting?.isEmpty == true {
            base = "Shown in the menu bar — currently the lowest % left across accounts"
        } else if resolvedPinnedAccountID != accountID {
            // The stored pin didn't resolve; this row won the lowest-across
            // fallback (#123).
            base = "Shown in the menu bar — the pinned selection isn't available, "
                + "so the lowest % left across accounts is shown"
        } else if pinnedSetting?.hasPrefix("active:") == true {
            base = "Shown in the menu bar — following the active account"
        } else {
            base = "Shown in the menu bar — pinned (right-click to unpin)"
        }
        guard let windowTitle else { return base }
        return base + ". Its \(windowTitle) is the number in the menu bar."
    }

    // MARK: - Menu bar number traceability (issue #249)

    /// How a scope is NAMED in traceability copy. Normally the card's own
    /// window title, so the line always matches a row the user can find.
    /// Spend is the exception (CodeRabbit, PR #250): `WorstRemainingCalculator`
    /// falls back to a spend scope when an account has no measurable
    /// rate-limit window, and calling a budget a "limit window" would be a
    /// lie in exactly the state the traceability copy exists to clarify.
    public static func windowDescriptor(for scope: String) -> String {
        let title = DeckBuilder.windowTitle(for: scope)
        return UsageScope.isSpend(scope) ? "\(title) budget" : title
    }

    /// Issue #249 (Tim's 2026-08-04 field report): the menu bar read "36%"
    /// while no visible card showed 36 — the cards were toggled to the
    /// model-window headline, so the same account headlined "Weekly · Fable
    /// 81%" and the number looked like a tracking bug. The data was right;
    /// nothing said which account/window the number refers to. This is the
    /// popover's one-line answer, rendered under the header whenever the
    /// menu bar is showing a percent.
    public struct NumberSourceLine: Equatable, Sendable {
        /// The compact caption: "Menu bar 36% — Studio · 5-hour limit".
        public var text: String
        /// Hover copy stating the selection RULE for the current mode, in
        /// the state-honest style of the Settings menu-bar caption.
        public var tooltip: String

        public init(text: String, tooltip: String) {
            self.text = text
            self.tooltip = tooltip
        }
    }

    /// Builds the caption for the window currently feeding the menu bar
    /// percent. `source` is the exact `WorstRemaining` the icon displays
    /// (`MenuBarStatusModel.menuBarPercentSource`); the pin arguments key
    /// the tooltip on the same resolution the icon used, like
    /// `checkmarkTooltip`.
    public static func numberSourceLine(
        source: WorstRemaining,
        accountLabel: String?,
        pinnedSetting: String?,
        resolvedPinnedAccountID: String?
    ) -> NumberSourceLine {
        let window = windowDescriptor(for: source.scope)
        let text: String
        if let accountLabel, !accountLabel.isEmpty {
            text = "Menu bar \(source.displayPercent)% — \(accountLabel) · \(window)"
        } else {
            text = "Menu bar \(source.displayPercent)% — \(window)"
        }
        // "Studio's 5-hour limit" / "the 5-hour limit" for tooltip prose.
        let possessiveWindow: String
        if let accountLabel, !accountLabel.isEmpty {
            possessiveWindow = "\(accountLabel)'s \(window)"
        } else {
            possessiveWindow = "the \(window)"
        }
        // "usage window" rather than "limit window": the same copy has to
        // stay true when the source is a spend budget (CodeRabbit, PR #250).
        let tooltip: String
        if pinnedSetting == nil || pinnedSetting?.isEmpty == true {
            tooltip = "The menu bar shows the lowest % left across every account and "
                + "usage window — right now \(possessiveWindow). "
                + "Right-click a card to pin one account instead."
        } else if resolvedPinnedAccountID != source.accountId {
            tooltip = "The pinned selection isn't available, so the menu bar shows the "
                + "lowest % left across every account — right now \(possessiveWindow)."
        } else if pinnedSetting?.hasPrefix("active:") == true {
            tooltip = "The menu bar follows the active account and shows its lowest "
                + "usage window — right now \(possessiveWindow)."
        } else if let choice = pinnedSetting.flatMap(MenuBarPinResolver.pinWindow) {
            // Issue #292: a pin carrying a window choice states the rule
            // actually in force — the chosen window while it feeds the
            // number, the honest fallback while that class isn't reported.
            if choice.matches(scope: source.scope) {
                tooltip = "The menu bar is pinned to \(possessiveWindow). "
                    + "Right-click its card to unpin."
            } else {
                tooltip = "The pinned account's \(choice.genericTitle) window isn't "
                    + "reported right now, so the menu bar shows its lowest "
                    + "usage window — right now \(possessiveWindow). "
                    + "Right-click its card to unpin."
            }
        } else {
            tooltip = "The menu bar is pinned to this account and shows its lowest "
                + "usage window — right now \(possessiveWindow). "
                + "Right-click its card to unpin."
        }
        return NumberSourceLine(text: text, tooltip: tooltip)
    }
}

/// Client-side computation of worst-remaining from `GET /api/state`. The
/// daemon grows a dedicated evaluation endpoint in Phase 2; this stays the
/// fallback and the endpoint becomes another `UsageEvaluating` conformer.
public enum WorstRemainingCalculator {
    public static func worstRemaining(in state: DeckState, now: Date = Date()) -> WorstRemaining? {
        worstRemaining(accounts: state.accounts, usage: headlineEligibleUsage(in: state, now: now))
    }

    /// Issue #264 (bonus fix): an account that cannot refresh — sign-in
    /// required or Keychain-denied — freezes its stored percentages, yet
    /// those frozen numbers could still win the lowest-across headline
    /// while Availability Health counted the same account as ZERO capacity.
    /// The global headline now keys on data age exactly like health does
    /// (same `AvailabilityHealthEngine.defaultStaleAfter` threshold): a flagged
    /// account's rows count only while fresh (a live session's statusline
    /// captures keep them fresh — that account is honestly usable). The
    /// PINNED variants are deliberately untouched: a pin is an explicit
    /// user choice and its tooltip names the window it shows. Mirrors the
    /// daemon's `evaluateWorstCapacity` authFlagged rule (src/capacity.mjs)
    /// so the endpoint and this fallback pick the same headline.
    static func headlineEligibleUsage(in state: DeckState, now: Date) -> [UsageSnapshot] {
        let flagged = Set(state.accounts.filter {
            let auth = $0.authState?.lowercased()
            return auth == "signin-required" || auth == "keychain-denied"
        }.map(\.id))
        guard !flagged.isEmpty else { return state.usage }
        return state.usage.filter { snapshot in
            guard flagged.contains(snapshot.accountId) else { return true }
            guard let observed = DeckDateParsing.date(from: snapshot.observedAt) else { return false }
            return now.timeIntervalSince(observed) <= AvailabilityHealthEngine.defaultStaleAfter
        }
    }

    /// The pinned-account variant: the same lowest-non-spend-window rule,
    /// restricted to one account. Nil when the account is missing, disabled,
    /// or has no usable NON-SPEND usage — unlike the global fallback, a
    /// spend-only pinned account never surfaces a spend percentage: the menu
    /// bar shows the plain glyph instead (issue #28's spend rule, pinned).
    public static func worstRemaining(in state: DeckState, accountId: String) -> WorstRemaining? {
        worstRemaining(
            accounts: state.accounts.filter { $0.id == accountId },
            usage: state.usage.filter {
                $0.accountId == accountId && !UsageScope.isSpend($0.scope)
            }
        )
    }

    /// Issue #292: the chosen-window pinned variant — the pinned rule
    /// restricted to one window CLASS of the account. Nil when the account
    /// reports no measurable window of that class; the caller then falls
    /// back to the lowest-window pick (and its copy says so) rather than
    /// showing nothing.
    public static func worstRemaining(
        in state: DeckState,
        accountId: String,
        pinWindow: MenuBarPinResolver.PinWindow
    ) -> WorstRemaining? {
        worstRemaining(
            accounts: state.accounts.filter { $0.id == accountId },
            usage: state.usage.filter {
                $0.accountId == accountId && pinWindow.matches(scope: $0.scope)
            }
        )
    }

    public static func worstRemaining(accounts: [DeckAccount], usage: [UsageSnapshot]) -> WorstRemaining? {
        let enabledIds = Set(accounts.filter(\.enabled).map(\.id))
        let enabledUsage = usage.filter { enabledIds.contains($0.accountId) }
        // Presence is tracked before dropping unknown-usage snapshots: a
        // non-spend scope with unknown usage must still keep spend from
        // seizing the headline.
        let hasNonSpendScope = enabledUsage.contains { !UsageScope.isSpend($0.scope) }
        let candidates = enabledUsage
            .compactMap { snapshot -> WorstRemaining? in
                guard let remaining = snapshot.remainingPercent else { return nil }
                return WorstRemaining(
                    percent: remaining,
                    accountId: snapshot.accountId,
                    scope: snapshot.scope,
                    resetsAt: snapshot.resetsAt,
                    stale: snapshot.stale
                )
            }
        // Issue #28: spend never wins the headline/icon; it only counts when
        // every non-spend scope is absent (fallback to whatever exists).
        let rateLimits = candidates.filter { !UsageScope.isSpend($0.scope) }
        return (hasNonSpendScope ? rateLimits : candidates)
            .min { $0.percent < $1.percent }
    }
}

/// Seam between the view model and however worst-remaining is obtained.
/// Phase 2's `/api/...` evaluation endpoint plugs in as a second conformer
/// without touching the view model.
public protocol UsageEvaluating: Sendable {
    func evaluateWorstRemaining() async throws -> WorstRemaining?
}

// MARK: - Daemon worst-capacity endpoint (issue #45)

/// Typed mirror of `GET /api/capacity/worst` (src/capacity.mjs
/// `evaluateWorstCapacity`) — the daemon's own worst-remaining evaluation,
/// which is the single source of truth. Decoding is lenient like every other
/// daemon mirror: unknown keys are ignored, optional fields stay optional.
public struct CapacityWorstReport: Codable, Equatable, Sendable {
    /// The winning row ("worst"): the lowest-remaining non-spend window
    /// across enabled accounts.
    public struct Row: Codable, Equatable, Sendable {
        public var accountId: String
        public var accountLabel: String?
        public var provider: String?
        public var scope: String
        public var remainingPercent: Double
        public var resetsAt: String?
        public var observedAt: String?

        public init(
            accountId: String,
            accountLabel: String? = nil,
            provider: String? = nil,
            scope: String,
            remainingPercent: Double,
            resetsAt: String? = nil,
            observedAt: String? = nil
        ) {
            self.accountId = accountId
            self.accountLabel = accountLabel
            self.provider = provider
            self.scope = scope
            self.remainingPercent = remainingPercent
            self.resetsAt = resetsAt
            self.observedAt = observedAt
        }
    }

    /// "ok" / "warn" / "critical" / "unknown".
    public var status: String
    public var worst: Row?
    public var thresholdPercent: Double?
    public var criticalPercent: Double?

    public init(
        status: String,
        worst: Row? = nil,
        thresholdPercent: Double? = nil,
        criticalPercent: Double? = nil
    ) {
        self.status = status
        self.worst = worst
        self.thresholdPercent = thresholdPercent
        self.criticalPercent = criticalPercent
    }

    /// The endpoint's worst row in the client's `WorstRemaining` shape; nil
    /// when the daemon has nothing to evaluate (status "unknown").
    public var worstRemaining: WorstRemaining? {
        guard let worst else { return nil }
        return WorstRemaining(
            percent: worst.remainingPercent,
            accountId: worst.accountId,
            scope: worst.scope,
            resetsAt: worst.resetsAt,
            stale: false
        )
    }
}

/// Source of the daemon's worst-capacity report. `DaemonClient` conforms;
/// tests stub it.
public protocol WorstCapacityProviding: Sendable {
    func worstCapacity() async throws -> CapacityWorstReport
}

/// Issue #45 evaluator: the daemon's `/api/capacity/worst` is the PRIMARY
/// worst-remaining source (single source of truth — same code path as the
/// CLI's capacity checks). `MenuBarStatusModel` falls back to the
/// client-side calc over the already-fetched `/api/state` when this
/// evaluator fails (daemon briefly unreachable between state fetches).
public struct DaemonWorstCapacityEvaluator: UsageEvaluating {
    private let provider: any WorstCapacityProviding

    public init(provider: any WorstCapacityProviding) {
        self.provider = provider
    }

    public func evaluateWorstRemaining() async throws -> WorstRemaining? {
        try await provider.worstCapacity().worstRemaining
    }
}

/// Phase 3 evaluator: fetch `GET /api/state`, compute worst-remaining locally.
public struct ClientSideUsageEvaluator: UsageEvaluating {
    private let client: DaemonClient

    public init(client: DaemonClient) {
        self.client = client
    }

    public func evaluateWorstRemaining() async throws -> WorstRemaining? {
        WorstRemainingCalculator.worstRemaining(in: try await client.state())
    }
}
