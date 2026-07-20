import Foundation
import Testing
@testable import ModelDeckMacCore

final class StubPoster: UserNotificationPosting, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var posted: [UsageAlert] = []

    func post(_ alert: UsageAlert) async {
        record(alert)
    }

    private func record(_ alert: UsageAlert) {
        lock.lock()
        defer { lock.unlock() }
        posted.append(alert)
    }
}

@Suite("Usage notifications (issue #7)")
struct UsageAlertPlannerTests {
    private let thresholds = UsageThresholds(warningPercent: 25, criticalPercent: 10)

    private func worst(_ percent: Double, accountId: String = "acct-1", scope: String = "5h") -> WorstRemaining {
        WorstRemaining(percent: percent, accountId: accountId, scope: scope)
    }

    private var state: DeckState {
        DeckState(accounts: [
            DeckAccount(id: "acct-1", provider: "claude", label: "Deck One"),
            DeckAccount(id: "acct-2", provider: "codex", label: "Deck Two"),
        ])
    }

    @Test func levelsFollowConfiguredThresholds() {
        #expect(UsageAlertLevel.level(for: worst(80), thresholds: thresholds) == .none)
        #expect(UsageAlertLevel.level(for: worst(25), thresholds: thresholds) == .warning)
        #expect(UsageAlertLevel.level(for: worst(10), thresholds: thresholds) == .critical)
        #expect(UsageAlertLevel.level(for: nil, thresholds: thresholds) == .none)
        // The configurable Settings threshold moves the warning line.
        let tight = UsageThresholds(warningPercent: 15, criticalPercent: 10)
        #expect(UsageAlertLevel.level(for: worst(20), thresholds: tight) == .none)
    }

    @Test func crossingIntoWarningPostsOnce() {
        let alert = UsageAlertPlanner.alert(previous: .none, worst: worst(18), state: state, thresholds: thresholds)
        #expect(alert?.level == .warning)
        #expect(alert?.title == "Deck One (Claude) is running low")
        #expect(alert?.body.contains("18% left") == true)
        #expect(alert?.body.contains("5-hour limit") == true)
    }

    @Test func sameLevelOnNextRefreshStaysSilent() {
        let alert = UsageAlertPlanner.alert(previous: .warning, worst: worst(17), state: state, thresholds: thresholds)
        #expect(alert == nil)
    }

    @Test func escalatingToCriticalPostsAgain() {
        let alert = UsageAlertPlanner.alert(previous: .warning, worst: worst(6), state: state, thresholds: thresholds)
        #expect(alert?.level == .critical)
        #expect(alert?.title == "Deck One (Claude) is critically low")
    }

    @Test func recoveryNeverPosts() {
        #expect(UsageAlertPlanner.alert(previous: .critical, worst: worst(18), state: state, thresholds: thresholds) == nil)
        #expect(UsageAlertPlanner.alert(previous: .warning, worst: worst(90), state: state, thresholds: thresholds) == nil)
        #expect(UsageAlertPlanner.alert(previous: .warning, worst: nil, state: state, thresholds: thresholds) == nil)
    }

    @Test func unknownAccountStillComposesABanner() {
        let alert = UsageAlertPlanner.alert(
            previous: .none, worst: worst(5, accountId: "gone"), state: state, thresholds: thresholds
        )
        #expect(alert?.title == "An account is critically low")
    }
}

@Suite("Usage notification coordinator (issue #7)")
@MainActor
struct UsageNotificationCoordinatorTests {
    private func worst(_ percent: Double) -> WorstRemaining {
        WorstRemaining(percent: percent, accountId: "acct-1", scope: "week")
    }

    private var state: DeckState {
        DeckState(accounts: [DeckAccount(id: "acct-1", provider: "codex", label: "Deck Two")])
    }

    @Test func postsOnlyOnWorseningTransitionsAndRearmsAfterRecovery() async {
        let poster = StubPoster()
        let coordinator = UsageNotificationCoordinator(poster: poster)

        await coordinator.evaluate(worst: worst(80), state: state) // healthy
        await coordinator.evaluate(worst: worst(20), state: state) // → warning: post
        await coordinator.evaluate(worst: worst(18), state: state) // still warning: silent
        await coordinator.evaluate(worst: worst(8), state: state)  // → critical: post
        await coordinator.evaluate(worst: worst(7), state: state)  // still critical: silent
        await coordinator.evaluate(worst: worst(90), state: state) // recovered: silent, re-arms
        await coordinator.evaluate(worst: worst(21), state: state) // → warning again: post

        #expect(poster.posted.map(\.level) == [.warning, .critical, .warning])
        #expect(coordinator.currentLevel == .warning)
    }

    @Test func settingsThresholdChangeAppliesToNextEvaluation() async {
        let poster = StubPoster()
        let coordinator = UsageNotificationCoordinator(poster: poster)

        await coordinator.evaluate(worst: worst(30), state: state) // above default 25: silent
        #expect(poster.posted.isEmpty)

        coordinator.thresholds = UsageThresholds(warningPercent: 40, criticalPercent: 10)
        await coordinator.evaluate(worst: worst(30), state: state) // below new 40: post
        #expect(poster.posted.map(\.level) == [.warning])
    }

    @Test func missingDataNeverAlerts() async {
        let poster = StubPoster()
        let coordinator = UsageNotificationCoordinator(poster: poster)
        await coordinator.evaluate(worst: nil, state: nil)
        #expect(poster.posted.isEmpty)
        #expect(coordinator.currentLevel == .none)
    }
}
