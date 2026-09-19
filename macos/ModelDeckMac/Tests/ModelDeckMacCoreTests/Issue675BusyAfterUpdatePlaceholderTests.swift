import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #675 — the deck's first-load copy after an update.
//
// Tim took 1.1.11 on 2026-09-19 and sat on "Connecting to daemon…" for about
// six minutes. The daemon was alive and answering /api/health the whole time;
// it was busy pruning a backlog (#673). The deck showed the same sentence a
// DEAD daemon shows, so nothing on screen told him "busy" from "broken".
//
// These pin the three states apart: nothing has answered yet (connecting),
// health answered but no data has ever arrived this launch (busy, and "after
// the update" when the background service re-registered for this version),
// and the daemon answered with nothing to show. They also pin the "one
// message, not two" rule — with no successful read behind it the header's
// busy line stays silent, because the placeholder is already saying it.

private func placeholderFixtureState() -> DeckState {
    DeckState(
        accounts: [
            DeckAccount(id: "acct-1", provider: "claude", label: "Studio", enabled: true, isDefault: true)
        ],
        usage: [
            UsageSnapshot(accountId: "acct-1", scope: "5-hour", usedPercent: 40, remainingPercent: 60)
        ]
    )
}

private final class QueuedStateProvider: DeckStateProviding, @unchecked Sendable {
    private let lock = NSLock()
    private var results: [Result<DeckState, Error>]
    init(_ results: [Result<DeckState, Error>]) { self.results = results }
    func deckState() async throws -> DeckState {
        try lock.withLock { results.removeFirst() }.get()
    }
}

private struct AnsweringHealthProbe: DaemonHealthProbing {
    func probeHealth() async throws {}
}

private struct UnusableEvaluator: UsageEvaluating {
    func evaluateWorstRemaining() async throws -> WorstRemaining? {
        throw URLError(.cannotConnectToHost)
    }
}

/// Mutable clock for the test that ages a successful read.
private final class MovableClock: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Date
    init(_ date: Date) { stored = date }
    var value: Date {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}

@Suite("Issue #675: busy-after-update first-load copy")
@MainActor
struct Issue675BusyAfterUpdatePlaceholderTests {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    private func makeModel(
        _ results: [Result<DeckState, Error>],
        clock: @escaping @Sendable () -> Date
    ) -> MenuBarStatusModel {
        MenuBarStatusModel(
            evaluator: UnusableEvaluator(),
            stateProvider: QueuedStateProvider(results),
            healthProbe: AnsweringHealthProbe(),
            clock: clock
        )
    }

    @Test("before anything answers, the deck still says it is connecting")
    func unknownKeepsTheConnectingCopy() {
        let model = makeModel([], clock: { self.start })
        #expect(model.connection == .unknown)
        #expect(model.firstLoadPlaceholderText() == "Connecting to daemon…")
        // Even mid-update: nothing has answered, so nothing is known yet.
        #expect(model.firstLoadPlaceholderText(afterUpdate: true) == "Connecting to daemon…")
    }

    @Test("health answering with no state yet reads busy, not connecting")
    func busyWithoutAnyPriorReadSaysBusy() async {
        let model = makeModel([.failure(URLError(.timedOut))], clock: { self.start })
        await model.refresh()
        guard case .busy = model.connection else {
            Issue.record("expected .busy, got \(model.connection)")
            return
        }
        #expect(!model.hasLoadedOnce)
        #expect(model.firstLoadPlaceholderText()
            == "The background service is busy. The deck will fill in shortly.")
    }

    @Test("a launch that re-registered the service says so in the copy")
    func afterUpdateWordingWhenTheServiceWasReregistered() async {
        let model = makeModel([.failure(URLError(.timedOut))], clock: { self.start })
        await model.refresh()
        #expect(model.firstLoadPlaceholderText(afterUpdate: true)
            == "The background service is busy after the update. The deck will fill in shortly.")
    }

    @Test("with no prior read the header busy line stays silent — one message, not two")
    func headerBusyLineIsSuppressedWithoutAPriorRead() async {
        let model = makeModel([.failure(URLError(.timedOut))], clock: { self.start })
        await model.refresh()
        #expect(model.busyStatusText(now: start) == nil)
    }

    @Test("with data already on the cards the header line comes back and the placeholder steps aside")
    func priorReadKeepsTheHeaderLine() async {
        let now = MovableClock(start)
        let model = makeModel(
            [.success(placeholderFixtureState()), .failure(URLError(.timedOut))],
            clock: { now.value }
        )
        await model.refresh()
        now.value = start.addingTimeInterval(11 * 60)
        await model.refresh()
        #expect(model.hasLoadedOnce)
        #expect(model.busyStatusText(now: now.value) == "Daemon busy · showing data from 11 min ago")
        // The cards render in this state; the placeholder is not the busy copy.
        #expect(model.firstLoadPlaceholderText() == "No usage data yet.")
        #expect(model.firstLoadPlaceholderText(afterUpdate: true) == "No usage data yet.")
    }

    @Test("a daemon that answered with nothing to show is not called busy")
    func connectedWithNoDataKeepsItsOwnCopy() async {
        let model = makeModel([.success(placeholderFixtureState())], clock: { self.start })
        await model.refresh()
        #expect(model.connection == .connected)
        #expect(model.firstLoadPlaceholderText() == "No usage data yet.")
    }

    // TRIPWIRE busy-after-update-copy: the deck must read this copy from the
    // model. A literal "Connecting to daemon…" back in the view is the exact
    // regression — a hardcoded string that cannot tell busy from broken — and
    // a literal "Daemon busy" fallback is the second message this issue
    // removed.
    @Test("the deck view holds no first-load copy of its own")
    func deckViewCarriesNoHardcodedFirstLoadCopy() throws {
        let source = try deckPopoverSource()
        #expect(!source.contains("Connecting to daemon"),
                "TRIPWIRE busy-after-update-copy: DeckPopoverView hardcodes the connecting copy again")
        #expect(!source.contains("Daemon busy"),
                "TRIPWIRE busy-after-update-copy: DeckPopoverView hardcodes a bare busy line again")
        #expect(source.contains("firstLoadPlaceholderText("),
                "TRIPWIRE busy-after-update-copy: the deck no longer asks the model for its placeholder")
        #expect(source.contains("afterUpdate: setupModel.didReregisterForUpdate"),
                "TRIPWIRE busy-after-update-copy: the placeholder no longer knows an update just happened")
    }

    private func deckPopoverSource() throws -> String {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try String(
            contentsOf: packageRoot.appendingPathComponent("Sources/ModelDeckMac/DeckPopoverView.swift"),
            encoding: .utf8
        )
    }
}
