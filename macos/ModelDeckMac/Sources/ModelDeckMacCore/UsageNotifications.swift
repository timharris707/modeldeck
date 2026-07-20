import Foundation
import Observation

// Issue #7 — usage notifications. Spec: "macOS banner when any account
// crosses a configurable remaining-% threshold." Alerts fire only on a
// worsening state TRANSITION (healthy → warning, warning → critical, …),
// never on every refresh at the same level, and re-arm once the worst
// remaining recovers above the threshold.

/// Alert level derived from the worst remaining % against the configured
/// thresholds. Ordered so "worse" compares greater.
public enum UsageAlertLevel: Int, Comparable, Equatable, Sendable {
    case none = 0
    case warning = 1
    case critical = 2

    public static func < (lhs: UsageAlertLevel, rhs: UsageAlertLevel) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    public static func level(for worst: WorstRemaining?, thresholds: UsageThresholds) -> UsageAlertLevel {
        guard let worst else { return .none }
        if worst.percent <= thresholds.criticalPercent { return .critical }
        if worst.percent <= thresholds.warningPercent { return .warning }
        return .none
    }
}

/// A banner ready to post.
public struct UsageAlert: Equatable, Sendable {
    public var level: UsageAlertLevel
    public var title: String
    public var body: String

    public init(level: UsageAlertLevel, title: String, body: String) {
        self.level = level
        self.title = title
        self.body = body
    }
}

/// Pure transition logic: given the previous level and the new worst
/// remaining, decide whether a banner is due and compose it. Testable
/// without UserNotifications.
public enum UsageAlertPlanner {
    /// Non-nil only when the level WORSENED (that's the state transition the
    /// spec notifies on). Same level or recovery → nil.
    public static func alert(
        previous: UsageAlertLevel,
        worst: WorstRemaining?,
        state: DeckState?,
        thresholds: UsageThresholds
    ) -> UsageAlert? {
        let level = UsageAlertLevel.level(for: worst, thresholds: thresholds)
        guard level > previous, let worst else { return nil }
        let label = accountLabel(for: worst.accountId, in: state)
        let window = DeckBuilder.windowTitle(for: worst.scope)
        let percent = worst.displayPercent
        switch level {
        case .critical:
            return UsageAlert(
                level: .critical,
                title: "\(label) is critically low",
                body: "\(percent)% left on the \(window) window."
            )
        case .warning:
            return UsageAlert(
                level: .warning,
                title: "\(label) is running low",
                body: "\(percent)% left on the \(window) window (threshold \(Int(thresholds.warningPercent))%)."
            )
        case .none:
            return nil
        }
    }

    static func accountLabel(for accountId: String, in state: DeckState?) -> String {
        guard let account = state?.accounts.first(where: { $0.id == accountId }) else {
            return "An account"
        }
        if let provider = DeckProvider.from(account.provider) {
            return "\(account.label) (\(provider.displayName))"
        }
        return account.label
    }
}

/// Seam over UserNotifications so the coordinator is testable. The real
/// implementation (app target) wraps UNUserNotificationCenter and requests
/// authorization lazily, on the first post.
public protocol UserNotificationPosting: Sendable {
    func post(_ alert: UsageAlert) async
}

/// Tracks the alert level across refreshes and posts banners only on
/// worsening transitions. Recovery (level drops) silently re-arms.
@MainActor
public final class UsageNotificationCoordinator: ObservableObject {
    @Published public private(set) var currentLevel: UsageAlertLevel = .none

    /// Thresholds mirror the Settings notification threshold (warning) and
    /// the fixed critical line; updated live by the settings sync.
    public var thresholds: UsageThresholds

    private let poster: any UserNotificationPosting

    public init(poster: any UserNotificationPosting, thresholds: UsageThresholds = .default) {
        self.poster = poster
        self.thresholds = thresholds
    }

    /// Feed every fresh daemon state through here (refresh ticks, manual
    /// refreshes, post-activate verification reads). Never spams: a banner
    /// goes out only when the level worsens.
    public func evaluate(worst: WorstRemaining?, state: DeckState?) async {
        let level = UsageAlertLevel.level(for: worst, thresholds: thresholds)
        let alert = UsageAlertPlanner.alert(
            previous: currentLevel,
            worst: worst,
            state: state,
            thresholds: thresholds
        )
        currentLevel = level
        if let alert {
            await poster.post(alert)
        }
    }
}
