import XCTest
@testable import ModelDeckMacCore

// Issue #204 — the UI half of the shared-across-accounts user scope: the
// additive `/api/state` `sharedScope` object decodes tolerantly (nil on
// pre-#204 daemons = nothing renders), the enable/disable state machine
// relays the daemon's disclosed merge outcome calmly (409 tolerated as
// "already in progress", never a failure), the outcome presentation carries
// merged counts / conflicts / skipped verbatim, and the toggle reflects the
// daemon-reported enabled flag — state wins over local optimism (#68).
// All account names are synthetic fixtures.

final class SharedScopeTests: XCTestCase {
    // MARK: - Decoding: /api/state

    func testStateWithoutSharedScopeDecodesNil() throws {
        // Daemon-version skew (the contract): a pre-#204 daemon omits the
        // whole object; nil renders nothing.
        let json = """
        { "accounts": [], "usage": [] }
        """
        let state = try JSONDecoder().decode(DeckState.self, from: Data(json.utf8))
        XCTAssertNil(state.sharedScope)
    }

    func testStateWithSharedScopeAndNullLastOutcomeDecodes() throws {
        let json = """
        { "accounts": [], "usage": [], "sharedScope": { "enabled": true, "lastOutcome": null } }
        """
        let state = try JSONDecoder().decode(DeckState.self, from: Data(json.utf8))
        XCTAssertEqual(state.sharedScope?.enabled, true)
        XCTAssertNil(state.sharedScope?.lastOutcome)
    }

    func testStateWithAbsentLastOutcomeDecodes() throws {
        let json = """
        { "accounts": [], "usage": [], "sharedScope": { "enabled": false } }
        """
        let state = try JSONDecoder().decode(DeckState.self, from: Data(json.utf8))
        XCTAssertEqual(state.sharedScope?.enabled, false)
        XCTAssertNil(state.sharedScope?.lastOutcome)
    }

    func testSharedScopeWithFullLastOutcomeDecodes() throws {
        let json = """
        {
          "accounts": [], "usage": [],
          "sharedScope": {
            "enabled": true,
            "lastOutcome": {
              "enabled": true,
              "merged": { "mcpServers": 3, "memoryItems": 12 },
              "conflicts": [ { "name": "content-miner", "winner": "Studio" } ],
              "skipped": [ { "what": "memory index", "reason": "unreadable file" } ]
            }
          }
        }
        """
        let state = try JSONDecoder().decode(DeckState.self, from: Data(json.utf8))
        let outcome = try XCTUnwrap(state.sharedScope?.lastOutcome)
        XCTAssertTrue(outcome.enabled)
        XCTAssertEqual(outcome.merged, SharedScopeMergedCounts(mcpServers: 3, memoryItems: 12))
        XCTAssertEqual(outcome.conflicts, [SharedScopeConflict(name: "content-miner", winner: "Studio")])
        XCTAssertEqual(outcome.skipped, [SharedScopeSkippedItem(what: "memory index", reason: "unreadable file")])
    }

    func testUnknownOutcomeFieldsAreIgnored() throws {
        // Growth tolerance: unknown keys anywhere in the outcome must never
        // fail the decode (the lenient-decoding house policy).
        let json = """
        {
          "enabled": true,
          "merged": { "mcpServers": 1, "memoryItems": 0, "futureCount": 9 },
          "conflicts": [ { "name": "a", "winner": "b", "loser": "c" } ],
          "skipped": [],
          "futureField": { "nested": true }
        }
        """
        let outcome = try JSONDecoder().decode(SharedScopeOutcome.self, from: Data(json.utf8))
        XCTAssertEqual(outcome.merged?.mcpServers, 1)
        XCTAssertEqual(outcome.conflicts.first?.name, "a")
        XCTAssertEqual(outcome.conflicts.first?.winner, "b")
    }

    func testUnexpectedSharedScopeShapeDecodesAsNil() throws {
        // A malformed shape must never fail the whole state decode — the
        // `activation`/`renew` tolerance contract: it reads as absent.
        let json = """
        { "accounts": [], "usage": [], "sharedScope": "unexpected" }
        """
        let state = try JSONDecoder().decode(DeckState.self, from: Data(json.utf8))
        XCTAssertNil(state.sharedScope)
    }

    func testEndpointEnvelopeDecodes() throws {
        // The enable/disable POST body shape from the #204 contract.
        let json = """
        {
          "sharedScope": {
            "enabled": true,
            "merged": { "mcpServers": 2, "memoryItems": 5 },
            "conflicts": [],
            "skipped": []
          }
        }
        """
        struct Envelope: Decodable { var sharedScope: SharedScopeOutcome }
        let envelope = try JSONDecoder().decode(Envelope.self, from: Data(json.utf8))
        XCTAssertTrue(envelope.sharedScope.enabled)
        XCTAssertEqual(envelope.sharedScope.merged?.memoryItems, 5)
        XCTAssertTrue(envelope.sharedScope.conflicts.isEmpty)
    }

    // MARK: - Decoding: settings document

    func testSettingsWithoutSharedScopeKeyDefaultsOff() throws {
        let json = """
        { "autoRefreshEnabled": true }
        """
        let settings = try JSONDecoder().decode(DaemonSettings.self, from: Data(json.utf8))
        XCTAssertFalse(settings.sharedUserScopeEnabled, "opt-in by direction — default OFF")
    }

    func testSettingsWithSharedScopeKeyDecodes() throws {
        let json = """
        { "sharedUserScopeEnabled": true }
        """
        let settings = try JSONDecoder().decode(DaemonSettings.self, from: Data(json.utf8))
        XCTAssertTrue(settings.sharedUserScopeEnabled)
    }

    // MARK: - Toggle reflects daemon state (state wins, #68 discipline)

    func testStateWinsOverSettings() {
        let state = DeckState(sharedScope: SharedScopeStatus(enabled: true))
        var settings = DaemonSettings.defaults
        settings.sharedUserScopeEnabled = false
        XCTAssertTrue(SharedScopeModel.isEnabled(state: state, settings: settings))

        settings.sharedUserScopeEnabled = true
        let offState = DeckState(sharedScope: SharedScopeStatus(enabled: false))
        XCTAssertFalse(SharedScopeModel.isEnabled(state: offState, settings: settings),
                       "the daemon-reported state must win over the settings echo")
    }

    func testSettingsAreOnlyTheFallbackWhileStateIsAbsent() {
        var settings = DaemonSettings.defaults
        settings.sharedUserScopeEnabled = true
        XCTAssertTrue(SharedScopeModel.isEnabled(state: nil, settings: settings))
        XCTAssertTrue(SharedScopeModel.isEnabled(state: DeckState(), settings: settings),
                      "a state without the sharedScope object falls back to the settings document")
    }

    // MARK: - Outcome presentation

    func testPresentationCarriesCountsConflictsAndSkipped() {
        let outcome = SharedScopeOutcome(
            enabled: true,
            merged: SharedScopeMergedCounts(mcpServers: 3, memoryItems: 12),
            conflicts: [SharedScopeConflict(name: "content-miner", winner: "Studio")],
            skipped: [SharedScopeSkippedItem(what: "memory index", reason: "unreadable file")]
        )
        let presentation = SharedScope.presentation(for: outcome)
        XCTAssertEqual(presentation.headline,
                       "Sharing is on — merged 3 MCP servers and 12 memory items.")
        XCTAssertEqual(presentation.conflictLines, ["content-miner — kept Studio's version"])
        XCTAssertEqual(presentation.skippedLines, ["Skipped memory index — unreadable file"])
    }

    func testPresentationSingularCounts() {
        let outcome = SharedScopeOutcome(
            enabled: true,
            merged: SharedScopeMergedCounts(mcpServers: 1, memoryItems: 1)
        )
        XCTAssertEqual(SharedScope.presentation(for: outcome).headline,
                       "Sharing is on — merged 1 MCP server and 1 memory item.")
    }

    func testPresentationWithoutMergedCountsStaysCalm() {
        let outcome = SharedScopeOutcome(enabled: true)
        let presentation = SharedScope.presentation(for: outcome)
        XCTAssertEqual(presentation.headline, "Sharing is on.")
        XCTAssertTrue(presentation.conflictLines.isEmpty)
        XCTAssertTrue(presentation.skippedLines.isEmpty)
    }

    func testDisableOutcomePresentation() {
        let outcome = SharedScopeOutcome(enabled: false)
        XCTAssertEqual(SharedScope.presentation(for: outcome).headline,
                       "Sharing is off — each account's own MCP servers and memory are restored.")
    }

    func testDisableOutcomeWithSkippedEntriesRendersThem() {
        // The contract: disable may report skipped[] for profiles whose
        // config write was deferred by a concurrent rewrite — rendered like
        // any other skipped reason, calmly under the restore headline.
        let outcome = SharedScopeOutcome(
            enabled: false,
            skipped: [SharedScopeSkippedItem(
                what: "profile config",
                reason: "deferred — file was being rewritten"
            )]
        )
        let presentation = SharedScope.presentation(for: outcome)
        XCTAssertEqual(presentation.headline,
                       "Sharing is off — each account's own MCP servers and memory are restored.")
        XCTAssertEqual(presentation.skippedLines,
                       ["Skipped profile config — deferred — file was being rewritten"])
    }

    func testDuplicateSkippedAndConflictLinesAreAllKept() {
        // PR #207 review: identical lines are legitimate — the same skip
        // reason from two profiles — and the presentation must expose BOTH
        // (the view keys rows by position, not content, so none collide).
        let skip = SharedScopeSkippedItem(what: "profile config", reason: "deferred")
        let conflict = SharedScopeConflict(name: "content-miner", winner: "Studio")
        let outcome = SharedScopeOutcome(
            enabled: false,
            conflicts: [conflict, conflict],
            skipped: [skip, skip]
        )
        let presentation = SharedScope.presentation(for: outcome)
        XCTAssertEqual(presentation.skippedLines,
                       ["Skipped profile config — deferred", "Skipped profile config — deferred"])
        XCTAssertEqual(presentation.conflictLines.count, 2)
    }

    func testEmptyNamedConflictAndSkippedRowsAreDropped() {
        // Tolerantly-decoded garbage elements (empty strings) render nothing
        // rather than blank lines.
        let outcome = SharedScopeOutcome(
            enabled: true,
            conflicts: [SharedScopeConflict(name: "", winner: "")],
            skipped: [SharedScopeSkippedItem(what: "", reason: "")]
        )
        let presentation = SharedScope.presentation(for: outcome)
        XCTAssertTrue(presentation.conflictLines.isEmpty)
        XCTAssertTrue(presentation.skippedLines.isEmpty)
    }

    func testConflictWithoutWinnerFallsBackToNewestWording() {
        let outcome = SharedScopeOutcome(
            enabled: true,
            conflicts: [SharedScopeConflict(name: "content-miner", winner: "")]
        )
        XCTAssertEqual(SharedScope.presentation(for: outcome).conflictLines,
                       ["content-miner — newest version kept"])
    }

    // MARK: - Enable/disable state machine

    @MainActor
    private func makeModel(
        results: [Result<SharedScopeOutcome, DaemonClientError>],
        state: DeckState = DeckState(sharedScope: SharedScopeStatus(enabled: true))
    ) -> (SharedScopeModel, StubSharedScopeBackend) {
        let backend = StubSharedScopeBackend(results: results, state: state)
        return (SharedScopeModel(controller: backend, stateProvider: backend), backend)
    }

    @MainActor
    func testConfirmationGatesTheOp() async {
        let (model, backend) = makeModel(results: [.success(SharedScopeOutcome(enabled: true))])

        // The toggle's setter only raises the sheet — nothing is sent yet.
        model.requestChange(to: true, currentlyEnabled: false)
        XCTAssertEqual(model.confirmationTarget, true)
        XCTAssertEqual(backend.requests, [])

        // Cancel: nothing ever sent; the toggle snaps back to daemon truth.
        model.cancelConfirmation()
        XCTAssertNil(model.confirmationTarget)
        XCTAssertEqual(backend.requests, [])
    }

    @MainActor
    func testConfirmThenImmediateDismissStillRunsTheOp() async {
        // The PR #207 review race, pinned: the sheet's confirm is followed
        // immediately by the dismissal echo (`isPresented` binding →
        // cancelConfirmation) BEFORE the spawned op Task gets to run. The
        // target must have been consumed synchronously at confirm time —
        // a deferred read would find it cleared and silently no-op.
        let outcome = SharedScopeOutcome(enabled: true)
        let (model, backend) = makeModel(results: [.success(outcome)])

        model.requestChange(to: true, currentlyEnabled: false)
        let op = model.confirmPending()
        XCTAssertNil(model.confirmationTarget, "the target is consumed synchronously")
        model.cancelConfirmation() // the sheet-dismissal echo, landing first

        await op?.value
        XCTAssertEqual(backend.requests, [true], "the op must still run after the dismissal echo")
        XCTAssertEqual(model.phase, .finished(outcome))
    }

    @MainActor
    func testConfirmWithoutPendingTargetIsANoOp() async {
        // A stray confirm (double-fire after dismissal) sends nothing.
        let (model, backend) = makeModel(results: [])
        XCTAssertNil(model.confirmPending())
        await Task.yield()
        XCTAssertEqual(backend.requests, [])
    }

    @MainActor
    func testRequestingTheCurrentValueIsANoOp() {
        // The settings-echo discipline: re-asserting the daemon's value must
        // never raise a sheet (SwiftUI bindings re-fire on adopt).
        let (model, _) = makeModel(results: [])
        model.requestChange(to: true, currentlyEnabled: true)
        XCTAssertNil(model.confirmationTarget)
    }

    @MainActor
    func testEnableSuccessRunsOpAndReReadsState() async {
        let outcome = SharedScopeOutcome(
            enabled: true,
            merged: SharedScopeMergedCounts(mcpServers: 2, memoryItems: 4)
        )
        let (model, backend) = makeModel(results: [.success(outcome)])
        var pushedStates: [DeckState] = []
        model.onStateChanged = { pushedStates.append($0) }

        model.requestChange(to: true, currentlyEnabled: false)
        await model.confirmPending()?.value

        XCTAssertEqual(backend.requests, [true])
        XCTAssertEqual(model.phase, .finished(outcome))
        XCTAssertNil(model.errorText)
        XCTAssertNil(model.infoText)
        XCTAssertEqual(pushedStates.count, 1, "a finished op re-reads /api/state (state honesty)")
        XCTAssertEqual(pushedStates.first?.sharedScope?.enabled, true)
    }

    @MainActor
    func testDisablePathRunsTheDisableEndpoint() async {
        let outcome = SharedScopeOutcome(enabled: false)
        let (model, backend) = makeModel(
            results: [.success(outcome)],
            state: DeckState(sharedScope: SharedScopeStatus(enabled: false))
        )

        model.requestChange(to: false, currentlyEnabled: true)
        await model.confirmPending()?.value

        XCTAssertEqual(backend.requests, [false])
        XCTAssertEqual(model.phase, .finished(outcome))
    }

    @MainActor
    func testConflict409IsToleratedAsAlreadyInProgress() async {
        // The contract: 409 while an op is in flight — a calm notice, never
        // an error tone, and state is still re-read.
        let (model, _) = makeModel(
            results: [.failure(.daemonError(message: "shared-scope operation already in progress", status: 409))]
        )
        var pushed = 0
        model.onStateChanged = { _ in pushed += 1 }

        await model.apply(target: true)

        XCTAssertNil(model.phase)
        XCTAssertNil(model.errorText, "409 must never render as a failure")
        XCTAssertEqual(model.infoText, SharedScope.alreadyInProgress)
        XCTAssertEqual(pushed, 1)
    }

    @MainActor
    func testBare409StatusIsAlsoTolerated() async {
        let (model, _) = makeModel(results: [.failure(.httpStatus(409))])
        await model.apply(target: false)
        XCTAssertNil(model.errorText)
        XCTAssertEqual(model.infoText, SharedScope.alreadyInProgress)
    }

    @MainActor
    func testFailureSurfacesTheDaemonMessageAndClearsProgress() async {
        let (model, _) = makeModel(
            results: [.failure(.daemonError(message: "merge failed: disk full", status: 500))]
        )

        await model.apply(target: true)

        XCTAssertNil(model.phase, "a failed op returns to idle — the toggle snaps back to daemon truth")
        XCTAssertEqual(model.errorText, "merge failed: disk full")
        XCTAssertNil(model.infoText)
    }

    @MainActor
    func testReEntrancyGuardWhileRunning() async {
        // A second apply while one runs must not fire a second request (the
        // client-side guard on top of the daemon's own 409 single-flight).
        let backend = StubSharedScopeBackend(
            results: [.success(SharedScopeOutcome(enabled: true))],
            state: DeckState()
        )
        backend.holdRequests = true
        let model = SharedScopeModel(controller: backend, stateProvider: backend)

        let first = Task { await model.apply(target: true) }
        // Wait until the first request is actually in flight.
        while backend.requests.isEmpty { await Task.yield() }
        XCTAssertTrue(model.isBusy)
        XCTAssertEqual(model.runningTarget, true)

        await model.apply(target: false)
        XCTAssertEqual(backend.requests, [true], "the second apply must be refused while one runs")

        // The sheet can't be raised mid-op either — controls are disabled,
        // and the model refuses even if a stale click gets through.
        model.requestChange(to: false, currentlyEnabled: true)
        XCTAssertNil(model.confirmationTarget)

        backend.release()
        await first.value
        XCTAssertFalse(model.isBusy)
    }

    @MainActor
    func testDismissClearsOutcomeAndNotices() async {
        let (model, _) = makeModel(results: [.success(SharedScopeOutcome(enabled: true))])
        await model.apply(target: true)
        XCTAssertNotNil(model.phase)

        model.dismissOutcome()
        XCTAssertNil(model.phase)
        XCTAssertNil(model.errorText)
        XCTAssertNil(model.infoText)
    }
}

// MARK: - Stub backend

/// Stubs both the shared-scope endpoints and the post-op state re-read.
///
/// `SharedScopeControlling` is a nonisolated seam, so this runs OFF the
/// MainActor while the test body runs on it — every mutable access shares
/// one lock (the StubSleeper lesson from PR #218: a request-recorded /
/// continuation-parked pair observed from another thread is a torn state).
private final class StubSharedScopeBackend: SharedScopeControlling, DeckStateProviding, @unchecked Sendable {
    private let lock = NSLock()
    private var recordedRequests: [Bool] = []
    private let results: [Result<SharedScopeOutcome, DaemonClientError>]
    private let state: DeckState
    /// When true, requests park until `release()` — for in-flight assertions.
    var holdRequests = false
    private var released = false
    private var continuations: [CheckedContinuation<Void, Never>] = []

    var requests: [Bool] { locked { recordedRequests } }

    init(results: [Result<SharedScopeOutcome, DaemonClientError>], state: DeckState) {
        self.results = results
        self.state = state
    }

    func setSharedScope(enabled: Bool) async throws -> SharedScopeOutcome {
        let (index, shouldPark) = locked { () -> (Int, Bool) in
            let index = recordedRequests.count
            recordedRequests.append(enabled)
            return (index, holdRequests)
        }
        if shouldPark {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                // The released check and the append share one critical
                // section: the test's spin loop wakes on the request being
                // recorded (above), so `release()` can land BEFORE this park
                // — resuming nothing and stranding the continuation forever
                // (the intermittent 0%-CPU suite hang).
                let parked: Bool = locked {
                    guard !released else { return false }
                    continuations.append(continuation)
                    return true
                }
                if !parked { continuation.resume() }
            }
        }
        guard index < results.count else {
            throw DaemonClientError.httpStatus(500)
        }
        return try results[index].get()
    }

    func release() {
        let drained: [CheckedContinuation<Void, Never>] = locked {
            defer {
                released = true
                continuations = []
            }
            return continuations
        }
        drained.forEach { $0.resume() }
    }

    func deckState() async throws -> DeckState {
        state
    }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }
}
