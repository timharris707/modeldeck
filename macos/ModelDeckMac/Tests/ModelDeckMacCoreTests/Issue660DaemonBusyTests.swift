import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #660: a daemon that answers /api/health but takes longer than the
// data-read timeout on /api/state is BUSY, not unreachable. Tim saw the
// orange "Daemon unreachable" banner on 2026-09-12 while health answered in
// ~1 ms between 4–36 s state stalls (#658). These pin the classification and
// the request timeouts that make it possible.

private func busyFixtureState() -> DeckState {
    DeckState(
        accounts: [
            DeckAccount(id: "acct-1", provider: "claude", label: "Studio", enabled: true, isDefault: true)
        ],
        usage: [
            UsageSnapshot(accountId: "acct-1", scope: "5-hour", usedPercent: 40, remainingPercent: 60)
        ]
    )
}

/// Scriptable state provider: pops one queued result per call.
private final class ScriptedStateProvider: DeckStateProviding, @unchecked Sendable {
    private let lock = NSLock()
    private var results: [Result<DeckState, Error>]
    init(results: [Result<DeckState, Error>]) { self.results = results }
    func deckState() async throws -> DeckState {
        try lock.withLock { results.removeFirst() }.get()
    }
}

private final class ScriptedHealthProbe: DaemonHealthProbing, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var callCount = 0
    var error: Error?
    init(error: Error? = nil) { self.error = error }
    func probeHealth() async throws {
        let error = lock.withLock { () -> Error? in
            callCount += 1
            return self.error
        }
        if let error { throw error }
    }
}

/// Health probe that parks until released, so a verified apply(deckState:)
/// can land while classifyFailure is suspended.
private final class GatedHealthProbe: DaemonHealthProbing, @unchecked Sendable {
    private let lock = NSLock()
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private(set) var entered = false
    func probeHealth() async throws {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            lock.withLock {
                entered = true
                waiters.append(continuation)
            }
        }
    }
    func release() {
        let pending = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            defer { waiters.removeAll() }
            return waiters
        }
        for waiter in pending { waiter.resume() }
    }
}

private struct FailingEvaluator: UsageEvaluating {
    func evaluateWorstRemaining() async throws -> WorstRemaining? {
        throw URLError(.cannotConnectToHost)
    }
}

@Suite("Issue #660: slow daemon is busy, not unreachable")
@MainActor
struct Issue660DaemonBusyTests {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    private func makeModel(
        stateResults: [Result<DeckState, Error>],
        probe: ScriptedHealthProbe?,
        clock: @escaping @Sendable () -> Date
    ) -> MenuBarStatusModel {
        MenuBarStatusModel(
            evaluator: FailingEvaluator(),
            stateProvider: ScriptedStateProvider(results: stateResults),
            healthProbe: probe,
            clock: clock
        )
    }

    @Test("state timeout with health answering keeps the deck and reads busy")
    func timeoutWithHealthAnsweringIsBusy() async {
        let probe = ScriptedHealthProbe()
        let now = LockedClock(start)
        let model = makeModel(
            stateResults: [.success(busyFixtureState()), .failure(URLError(.timedOut))],
            probe: probe,
            clock: { now.value }
        )
        await model.refresh()
        #expect(model.connection == .connected)
        let deckBefore = model.deckState
        let worstBefore = model.worstRemaining
        #expect(deckBefore != nil)

        now.value = start.addingTimeInterval(11 * 60)
        await model.refresh()
        #expect(model.connection == .busy(since: now.value))
        #expect(model.deckState == deckBefore)
        #expect(model.worstRemaining == worstBefore)
        #expect(model.hasLoadedOnce)
        #expect(probe.callCount == 1)
        #expect(model.busyStatusText(now: now.value) == "Daemon busy · showing data from 11 min ago")
    }

    @Test("state timeout with health failing too is unreachable")
    func timeoutWithHealthFailingIsUnreachable() async {
        let probe = ScriptedHealthProbe(error: URLError(.cannotConnectToHost))
        let model = makeModel(
            stateResults: [.success(busyFixtureState()), .failure(URLError(.timedOut))],
            probe: probe,
            clock: { self.start }
        )
        await model.refresh()
        await model.refresh()
        guard case .unreachable = model.connection else {
            Issue.record("expected .unreachable, got \(model.connection)")
            return
        }
        #expect(probe.callCount == 1)
        #expect(model.busyStatusText() == nil)
    }

    @Test("connection refused is unreachable without a health round trip")
    func refusedIsUnreachableWithoutProbe() async {
        let probe = ScriptedHealthProbe()
        let model = makeModel(
            stateResults: [.success(busyFixtureState()), .failure(URLError(.cannotConnectToHost))],
            probe: probe,
            clock: { self.start }
        )
        await model.refresh()
        await model.refresh()
        guard case .unreachable = model.connection else {
            Issue.record("expected .unreachable, got \(model.connection)")
            return
        }
        #expect(probe.callCount == 0)
    }

    @Test("a verified apply(deckState:) during the health probe is not overwritten by busy")
    func applyDuringProbeWins() async {
        let probe = GatedHealthProbe()
        let model = MenuBarStatusModel(
            evaluator: FailingEvaluator(),
            stateProvider: ScriptedStateProvider(results: [.failure(URLError(.timedOut))]),
            healthProbe: probe,
            clock: { self.start }
        )
        let refresh = Task { await model.refresh() }
        while !probe.entered { await Task.yield() }
        model.apply(deckState: busyFixtureState())
        #expect(model.connection == .connected)
        probe.release()
        await refresh.value
        #expect(model.connection == .connected)
        #expect(model.deckState != nil)
    }

    @Test("a later successful refresh clears busy back to connected")
    func successClearsBusy() async {
        let model = makeModel(
            stateResults: [
                .success(busyFixtureState()),
                .failure(URLError(.timedOut)),
                .success(busyFixtureState()),
            ],
            probe: ScriptedHealthProbe(),
            clock: { self.start }
        )
        await model.refresh()
        await model.refresh()
        #expect(model.connection == .busy(since: start))
        await model.refresh()
        #expect(model.connection == .connected)
        #expect(model.busyStatusText() == nil)
    }

    @Test("busy keeps its first timestamp across repeated timeouts")
    func busySinceIsSticky() async {
        let now = LockedClock(start)
        let model = makeModel(
            stateResults: [
                .success(busyFixtureState()),
                .failure(URLError(.timedOut)),
                .failure(URLError(.timedOut)),
            ],
            probe: ScriptedHealthProbe(),
            clock: { now.value }
        )
        await model.refresh()
        await model.refresh()
        now.value = start.addingTimeInterval(300)
        await model.refresh()
        #expect(model.connection == .busy(since: start))
    }

    @Test("busy is treated as daemon-answered by the surfaces that gate on it")
    func busyCountsAsAnswered() {
        #expect(MenuBarStatusModel.ConnectionStatus.busy(since: start).daemonAnswered)
        #expect(MenuBarStatusModel.ConnectionStatus.connected.daemonAnswered)
        #expect(!MenuBarStatusModel.ConnectionStatus.unreachable("refused").daemonAnswered)
        #expect(!MenuBarStatusModel.ConnectionStatus.unknown.daemonAnswered)
        let url = URL(string: "http://127.0.0.1:3867/dashboard")!
        let phase = DashboardWindowState.phase(
            connection: .busy(since: start),
            dashboardURL: url,
            setupPhase: .quiet,
            bundledServiceAvailable: true
        )
        #expect(phase == .live(url))
    }
}

/// Mutable clock for tests that advance time between refreshes.
private final class LockedClock: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Date
    init(_ date: Date) { stored = date }
    var value: Date {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); defer { lock.unlock() }; stored = newValue }
    }
}

@Suite("Issue #660: request timeouts")
struct Issue660RequestTimeoutTests {
    private let stateBody = #"{"accounts":[],"usage":[]}"#
    private let healthBody = #"{"ok":true,"name":"ModelDeck","version":"0.1.0"}"#

    @Test("/api/state gets 60 s, /api/health stays at 5 s")
    func dataReadsOutlastTheHealthProbe() async throws {
        let transport = StubTransport(stubs: [
            .init(status: 200, body: stateBody),
            .init(status: 200, body: healthBody),
            .init(status: 200, body: #"{"status":"unknown"}"#),
            .init(status: 200, body: #"{"accounts":[]}"#),
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(port: 43287), transport: transport)
        _ = try await client.state()
        _ = try await client.health()
        _ = try? await client.worstCapacity()
        _ = try? await client.exhaustionForecast()
        let byPath = Dictionary(uniqueKeysWithValues: transport.requests.map {
            ($0.url!.path, $0.timeoutInterval)
        })
        #expect(byPath["/api/state"] == 60)
        #expect(byPath["/api/health"] == 5)
        #expect(byPath["/api/capacity/worst"] == 60)
        #expect(byPath["/api/usage/exhaustion-forecast"] == 60)
    }
}
