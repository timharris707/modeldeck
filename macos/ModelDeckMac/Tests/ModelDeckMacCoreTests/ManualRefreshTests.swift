import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #72 — pressing Refresh must visibly restart the footer's
// "Data from N min ago" counter. Root cause: the button only re-read the
// daemon's CACHE, which never advances the snapshots' observedAt.
// refreshFromProviders() first forces a provider poll (POST /api/refresh),
// then re-reads state — the footer age then derives from a fresh observedAt.

/// Stub daemon: refreshUsage() flips the served state to the "freshly
/// polled" variant, mimicking the real daemon (poll writes new snapshots;
/// the next GET /api/state returns them).
private final class StubRefreshingDaemon: DeckStateProviding, UsageRefreshing, @unchecked Sendable {
    private let lock = NSLock()
    private let staleState: DeckState
    private let freshState: DeckState
    private let refreshError: Error?
    private(set) var refreshCalls = 0
    private(set) var stateReadsAfterRefresh = 0
    private var polled = false

    init(staleState: DeckState, freshState: DeckState, refreshError: Error? = nil) {
        self.staleState = staleState
        self.freshState = freshState
        self.refreshError = refreshError
    }

    func refreshUsage() async throws {
        try recordRefresh()
    }

    func deckState() async throws -> DeckState {
        currentState()
    }

    private func recordRefresh() throws {
        lock.lock()
        defer { lock.unlock() }
        refreshCalls += 1
        if let refreshError { throw refreshError }
        polled = true
    }

    private func currentState() -> DeckState {
        lock.lock()
        defer { lock.unlock() }
        if polled { stateReadsAfterRefresh += 1 }
        return polled ? freshState : staleState
    }
}

@Suite("Manual refresh resets footer data age (issue #72)")
@MainActor
struct ManualRefreshTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func state(observedAgoSeconds: TimeInterval) -> DeckState {
        let observed = now.addingTimeInterval(-observedAgoSeconds)
        return DeckState(
            accounts: [DeckAccount(id: "a1", provider: "claude", label: "Work")],
            usage: [UsageSnapshot(
                accountId: "a1",
                scope: "5h",
                remainingPercent: 80,
                observedAt: ISO8601DateFormatter().string(from: observed)
            )]
        )
    }

    private func model(daemon: StubRefreshingDaemon) -> MenuBarStatusModel {
        MenuBarStatusModel(
            evaluator: StubEvaluator(results: [.success(nil)]),
            stateProvider: daemon,
            usageRefresher: daemon,
            clock: { [now] in now }
        )
    }

    @Test func manualRefreshPollsProvidersThenReloadsStateAndAgeResets() async {
        let daemon = StubRefreshingDaemon(
            staleState: state(observedAgoSeconds: 25 * 60),
            freshState: state(observedAgoSeconds: 5)
        )
        let model = model(daemon: daemon)

        // Popover open: cheap cached read — footer honestly shows old data.
        await model.refresh()
        #expect(daemon.refreshCalls == 0)
        #expect(model.footerStatus(now: now)?.text == "Oldest data 25 min ago")

        // Refresh button: forced poll first, THEN the state re-read.
        await model.refreshFromProviders()
        #expect(daemon.refreshCalls == 1)
        #expect(daemon.stateReadsAfterRefresh == 1)
        #expect(model.footerStatus(now: now)?.text == "Oldest data just now")
    }

    @Test func failedProviderPollStillReloadsState() async {
        // Older daemon / transient failure: the button must never go dead —
        // it degrades to the cached read (pre-#72 behavior).
        let daemon = StubRefreshingDaemon(
            staleState: state(observedAgoSeconds: 10 * 60),
            freshState: state(observedAgoSeconds: 5),
            refreshError: URLError(.timedOut)
        )
        let model = model(daemon: daemon)
        await model.refreshFromProviders()
        #expect(daemon.refreshCalls == 1)
        #expect(model.connection == .connected)
        #expect(model.footerStatus(now: now)?.text == "Oldest data 10 min ago")
    }

    @Test func plainRefreshNeverTriggersProviderPoll() async {
        // Auto-refresh and popover-open reads must stay cheap cached GETs.
        let daemon = StubRefreshingDaemon(
            staleState: state(observedAgoSeconds: 60),
            freshState: state(observedAgoSeconds: 5)
        )
        let model = model(daemon: daemon)
        await model.refresh()
        await model.refresh()
        #expect(daemon.refreshCalls == 0)
    }

    @Test func manualRefreshWithoutRefresherStillLoadsState() async {
        let daemon = StubRefreshingDaemon(
            staleState: state(observedAgoSeconds: 60),
            freshState: state(observedAgoSeconds: 5)
        )
        let model = MenuBarStatusModel(
            evaluator: StubEvaluator(results: [.success(nil)]),
            stateProvider: daemon,
            clock: { [now] in now }
        )
        await model.refreshFromProviders()
        #expect(daemon.refreshCalls == 0)
        #expect(model.deckState != nil)
        #expect(model.connection == .connected)
    }
}
