import Foundation
import Testing
@testable import ModelDeckMacCore

/// Issue #852 — with provider polling off (Part B of #834), the app never
/// re-read the daemon's cached state, so every Mac's deck showed what it
/// loaded at launch. Re-reading the cached state is local and free; it now
/// runs on its own timer whatever `autoRefreshEnabled` says.
@Suite("Issue #852 — the deck re-reads cached state with polling off")
@MainActor
struct Issue852StateReloadTests {
    private final class CountingStateProvider: DeckStateProviding, @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        var reads: Int { lock.withLock { count } }
        func deckState() async throws -> DeckState {
            lock.withLock { count += 1 }
            return DeckState(accounts: [], usage: [])
        }
    }

    @Test func settingsReloadOnTheirOwnCadenceWhenPollingIsOff() {
        var settings = DaemonSettings.defaults
        settings.autoRefreshEnabled = false
        #expect(settings.effectiveAutoRefreshInterval == 0)
        #expect(settings.stateReloadInterval == DaemonSettings.stateReloadWhileRefreshOff)
        settings.autoRefreshEnabled = true
        settings.autoRefreshIntervalSeconds = 120
        #expect(settings.stateReloadInterval == 120)
    }

    /// TRIPWIRE #852: polling off, the reload timer still re-reads state, and
    /// the freshness rules still see polling as off.
    @Test func reloadTimerRunsWithPollingOff() async throws {
        let provider = CountingStateProvider()
        let model = MenuBarStatusModel(evaluator: StubEvaluator(results: []), stateProvider: provider)
        model.startAutoRefresh(interval: 0, reloadEvery: 0.05)
        defer { model.stopAutoRefresh() }
        #expect(model.autoRefreshInterval == 0)
        // Wait for two reloads rather than a fixed window: the full suite runs
        // on a busy main actor, where 0.4 s saw only one tick (2026-11-20).
        let deadline = Date().addingTimeInterval(10)
        while provider.reads < 2, Date() < deadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        #expect(provider.reads >= 2, "reads: \(provider.reads)")
    }

    @Test func noReloadEveryKeepsThePollingCadence() async throws {
        let provider = CountingStateProvider()
        let model = MenuBarStatusModel(evaluator: StubEvaluator(results: []), stateProvider: provider)
        model.startAutoRefresh(interval: 0)
        defer { model.stopAutoRefresh() }
        try await Task.sleep(nanoseconds: 200_000_000)
        #expect(provider.reads == 0, "existing callers without reloadEvery keep today's behavior")
    }
}
