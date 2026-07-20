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
public enum MenuBarIconState: Equatable, Sendable {
    case plain
    case warning(percentRemaining: Int)
    case critical(percentRemaining: Int)

    public static func state(for worst: WorstRemaining?, thresholds: UsageThresholds = .default) -> MenuBarIconState {
        guard let worst else { return .plain }
        if worst.percent <= thresholds.criticalPercent {
            return .critical(percentRemaining: worst.displayPercent)
        }
        if worst.percent <= thresholds.warningPercent {
            return .warning(percentRemaining: worst.displayPercent)
        }
        return .plain
    }

    /// "N%" when the percent is shown; nil when the icon is plain.
    public var percentLabel: String? {
        switch self {
        case .plain: return nil
        case .warning(let percent), .critical(let percent): return "\(percent)%"
        }
    }
}

/// Client-side computation of worst-remaining from `GET /api/state`. The
/// daemon grows a dedicated evaluation endpoint in Phase 2; this stays the
/// fallback and the endpoint becomes another `UsageEvaluating` conformer.
public enum WorstRemainingCalculator {
    public static func worstRemaining(in state: DeckState) -> WorstRemaining? {
        worstRemaining(accounts: state.accounts, usage: state.usage)
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
