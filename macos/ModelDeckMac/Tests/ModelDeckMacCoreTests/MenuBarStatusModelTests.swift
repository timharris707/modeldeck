import Foundation
import Testing
@testable import ModelDeckMacCore

/// Scriptable evaluator: pops one queued result per call.
final class StubEvaluator: UsageEvaluating, @unchecked Sendable {
    private let lock = NSLock()
    private var results: [Result<WorstRemaining?, Error>]
    private(set) var callCount = 0

    init(results: [Result<WorstRemaining?, Error>]) {
        self.results = results
    }

    func evaluateWorstRemaining() async throws -> WorstRemaining? {
        try nextResult()?.get()
    }

    private func nextResult() -> Result<WorstRemaining?, Error>? {
        lock.lock()
        defer { lock.unlock() }
        callCount += 1
        guard !results.isEmpty else { return nil }
        return results.removeFirst()
    }
}

@Suite("MenuBarStatusModel")
@MainActor
struct MenuBarStatusModelTests {
    private func worst(_ percent: Double) -> WorstRemaining {
        WorstRemaining(percent: percent, accountId: "acct-1", scope: "5h")
    }

    @Test func successfulRefreshUpdatesIconAndTimestamp() async {
        let fixedNow = Date(timeIntervalSince1970: 1_800_000_000)
        let model = MenuBarStatusModel(
            evaluator: StubEvaluator(results: [.success(worst(18))]),
            clock: { fixedNow }
        )
        await model.refresh()
        #expect(model.iconState == .warning(percentRemaining: 18))
        #expect(model.connection == .connected)
        #expect(model.lastUpdatedAt == fixedNow)
    }

    @Test func criticalStateAtTenPercent() async {
        let model = MenuBarStatusModel(evaluator: StubEvaluator(results: [.success(worst(7))]))
        await model.refresh()
        #expect(model.iconState == .critical(percentRemaining: 7))
    }

    @Test func recoveryHidesThePercent() async {
        let model = MenuBarStatusModel(evaluator: StubEvaluator(results: [
            .success(worst(12)),
            .success(worst(88)),
        ]))
        await model.refresh()
        #expect(model.iconState == .warning(percentRemaining: 12))
        await model.refresh()
        #expect(model.iconState == .plain)
    }

    @Test func failureKeepsLastKnownStateAndReportsUnreachable() async {
        let model = MenuBarStatusModel(evaluator: StubEvaluator(results: [
            .success(worst(18)),
            .failure(URLError(.cannotConnectToHost)),
        ]))
        await model.refresh()
        await model.refresh()
        #expect(model.iconState == .warning(percentRemaining: 18))
        #expect(model.worstRemaining?.percent == 18)
        if case .unreachable = model.connection {
        } else {
            Issue.record("expected .unreachable, got \(model.connection)")
        }
    }

    @Test func changingThresholdsRecomputesIconState() async {
        let model = MenuBarStatusModel(evaluator: StubEvaluator(results: [.success(worst(30))]))
        await model.refresh()
        #expect(model.iconState == .plain)
        model.thresholds = UsageThresholds(warningPercent: 40, criticalPercent: 35)
        #expect(model.iconState == .critical(percentRemaining: 30))
    }

    @Test func updatedAgoTextFormats() async {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let model = MenuBarStatusModel(
            evaluator: StubEvaluator(results: [.success(nil)]),
            clock: { start }
        )
        #expect(model.updatedAgoText() == nil)
        await model.refresh()
        #expect(model.updatedAgoText(now: start.addingTimeInterval(30)) == "Updated just now")
        #expect(model.updatedAgoText(now: start.addingTimeInterval(320)) == "Updated 5 min ago")
    }

    @Test func noDataMeansPlainIcon() async {
        let model = MenuBarStatusModel(evaluator: StubEvaluator(results: [.success(nil)]))
        await model.refresh()
        #expect(model.iconState == .plain)
        #expect(model.worstRemaining == nil)
        #expect(model.connection == .connected)
    }

    // MARK: - Cold start (issue #58)

    @Test func coldStartShowsLoadingUntilFirstSuccessfulFetch() async {
        let model = MenuBarStatusModel(evaluator: StubEvaluator(results: [.success(nil)]))
        #expect(model.iconState == .loading)
        await model.refresh()
        #expect(model.iconState == .plain)
    }

    @Test func failedFirstFetchKeepsTheLoadingPlaceholder() async {
        // Data still hasn't arrived — a plain glyph would claim "healthy".
        let model = MenuBarStatusModel(evaluator: StubEvaluator(results: [
            .failure(URLError(.cannotConnectToHost)),
            .success(worst(88)),
        ]))
        await model.refresh()
        #expect(model.iconState == .loading)
        if case .unreachable = model.connection {
        } else {
            Issue.record("expected .unreachable, got \(model.connection)")
        }
        await model.refresh()
        #expect(model.iconState == .plain)
    }

    @Test func thresholdChangeBeforeFirstFetchKeepsLoading() async {
        // The cold-launch settings load applies thresholds BEFORE the first
        // state fetch resolves — that must not wipe the placeholder.
        let model = MenuBarStatusModel(evaluator: StubEvaluator(results: [.success(worst(30))]))
        model.thresholds = UsageThresholds(warningPercent: 40, criticalPercent: 35)
        #expect(model.iconState == .loading)
        await model.refresh()
        #expect(model.iconState == .critical(percentRemaining: 30))
    }

    @Test func loadingStateCarriesTheNeutralPlaceholderLabel() {
        #expect(MenuBarIconState.loading.percentLabel == "–%")
        #expect(MenuBarIconState.plain.percentLabel == nil)
    }

    // MARK: - Pinned menu-bar account (account percentage picker)

    private var pinnedFixtureState: DeckState {
        DeckState(
            accounts: [
                DeckAccount(id: "acct-1", provider: "claude", label: "Medved Instead"),
                DeckAccount(id: "acct-2", provider: "codex", label: "Insight"),
            ],
            usage: [
                UsageSnapshot(accountId: "acct-1", scope: "week", remainingPercent: 7),
                UsageSnapshot(accountId: "acct-2", scope: "week", remainingPercent: 52),
            ]
        )
    }

    @Test func pinnedAccountShowsItsPercentContinuously() async {
        let model = MenuBarStatusModel(evaluator: StubEvaluator(results: []))
        model.apply(deckState: pinnedFixtureState)
        // Unpinned: the global worst (7%) drives the icon.
        #expect(model.iconState == .critical(percentRemaining: 7))

        model.pinnedAccountId = "acct-2"
        #expect(model.iconState == .pinned(percentRemaining: 52))
        #expect(model.pinnedAccountLabel == "Insight")
        // Notifications keep watching the global worst.
        #expect(model.worstRemaining?.accountId == "acct-1")

        model.pinnedAccountId = nil
        #expect(model.iconState == .critical(percentRemaining: 7))
    }

    @Test func pinnedAccountKeepsSeverityColorsBelowThresholds() async {
        let model = MenuBarStatusModel(evaluator: StubEvaluator(results: []))
        var state = pinnedFixtureState
        state.usage = [UsageSnapshot(accountId: "acct-2", scope: "week", remainingPercent: 18)]
        model.pinnedAccountId = "acct-2"
        model.apply(deckState: state)
        #expect(model.iconState == .warning(percentRemaining: 18))
    }

    @Test func removedPinnedAccountFallsBackToGlobalWorst() async {
        let model = MenuBarStatusModel(evaluator: StubEvaluator(results: []))
        model.pinnedAccountId = "acct-gone"
        model.apply(deckState: pinnedFixtureState)
        #expect(model.iconState == .critical(percentRemaining: 7))
        #expect(model.pinnedAccountLabel == nil)
    }

    @Test func pinnedAccountWithoutUsableDataShowsPlainNotABorrowedNumber() async {
        let model = MenuBarStatusModel(evaluator: StubEvaluator(results: []))
        var state = pinnedFixtureState
        state.usage = [UsageSnapshot(accountId: "acct-1", scope: "week", remainingPercent: 47)]
        model.pinnedAccountId = "acct-2"
        model.apply(deckState: state)
        #expect(model.iconState == .plain)
    }

    @Test func pinningBeforeFirstLoadKeepsTheLoadingPlaceholder() async {
        let model = MenuBarStatusModel(evaluator: StubEvaluator(results: []))
        model.pinnedAccountId = "acct-2"
        #expect(model.iconState == .loading)
    }

    @Test func followActivePinTracksActivationSwitches() async {
        let model = MenuBarStatusModel(evaluator: StubEvaluator(results: []))
        model.pinnedAccountId = "active:claude"
        var state = DeckState(
            accounts: [
                DeckAccount(id: "cl-1", provider: "claude", label: "Insight", isDefault: true),
                DeckAccount(id: "cl-2", provider: "claude", label: "Medved Instead"),
            ],
            usage: [
                UsageSnapshot(accountId: "cl-1", scope: "week", remainingPercent: 74),
                UsageSnapshot(accountId: "cl-2", scope: "week", remainingPercent: 52),
            ]
        )
        model.apply(deckState: state)
        #expect(model.iconState == .pinned(percentRemaining: 74))
        #expect(model.pinnedAccountLabel == "Insight")

        // Activation flips to the other account — the pin follows.
        state.accounts[0].isDefault = false
        state.accounts[1].isDefault = true
        model.apply(deckState: state)
        #expect(model.iconState == .pinned(percentRemaining: 52))
        #expect(model.pinnedAccountLabel == "Medved Instead")
    }
}
