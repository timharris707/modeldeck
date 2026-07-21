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
}
