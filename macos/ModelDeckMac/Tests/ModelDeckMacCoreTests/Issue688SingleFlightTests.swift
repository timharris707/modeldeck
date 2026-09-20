import XCTest
@testable import ModelDeckMacCore

// Issue #688 — TRIPWIRE (CLAUDE.md never-compromise #4).
//
// `DaemonSetupModel.evaluateOnLaunch()` had no in-flight guard: `@MainActor`
// serializes the synchronous stretches, not the awaits between them, so a
// second call (launch reconciliation racing a Retry click, or two Retry
// clicks during a fallback wait) ran a second full evaluation — the PR #687
// review's scratch probe recorded two kickstarts. These tests fail if that
// comes back:
//
// - two overlapping evaluateOnLaunch() calls run ONE registrar/kickstart
//   sequence and both callers get the same Bool;
// - retry() during an in-flight evaluation joins it;
// - once an evaluation finishes (success or failure) the next call runs fresh.

// MARK: - Fakes (same shape as Issue678DaemonRestartTests, which keeps its own private)

private final class FlightRegistrar: DaemonServiceRegistrar, @unchecked Sendable {
    var statusValue: ServiceRegistrationStatus = .enabled
    var registerError: Error?
    var registerCalls = 0
    var unregisterCalls = 0
    var status: ServiceRegistrationStatus { statusValue }
    func register() throws {
        registerCalls += 1
        if let registerError { throw registerError }
    }
    func unregister() throws {
        unregisterCalls += 1
        statusValue = .notRegistered
    }
}

private struct FlightError: Error {}

private final class FlightTokenStore: MutationTokenStore, @unchecked Sendable {
    func tokenExists() throws -> Bool { true }
    func createToken() throws {}
}

private final class FlightLegacyAgent: LegacyAgentInspecting, @unchecked Sendable {
    func isLegacyAgentPresent() -> Bool { false }
    func removeLegacyAgent() throws {}
}

private final class FlightMarker: RegistrationMarkerStore, @unchecked Sendable {
    var registeredCommit: String?
    var registeredPlistFingerprint: String?
}

private final class FlightProbe: DaemonReachabilityProbing, @unchecked Sendable {
    var reachable = true
    var runningCommit: String?
    var probeCalls = 0
    func probeDaemon() async -> DaemonProbeSnapshot? { answer() }
    func probeDaemon(timeout: TimeInterval) async -> DaemonProbeSnapshot? { answer() }
    private func answer() -> DaemonProbeSnapshot? {
        probeCalls += 1
        return reachable ? DaemonProbeSnapshot(runningCommit: runningCommit) : nil
    }
}

/// The kickstart parks on a continuation until the test releases it, so a
/// second evaluation can be started while the first is provably suspended
/// mid-restart — the exact window the issue describes. Every parked
/// kickstart is held (not just the latest) so that, should the guard ever
/// go missing, the doubled evaluation fails on the count rather than
/// hanging the suite on a leaked continuation. Main-actor isolated (review
/// of PR #691, reproduced under ThreadSanitizer): the async protocol
/// methods of a nonisolated fake run off the main actor, so its gate array
/// raced the test's reads and release.
@MainActor
private final class GatedLaunchdControl: LaunchdServiceControlling {
    var probeCalls = 0
    var restartCalls = 0
    var bootOutCalls = 0
    private var gates: [CheckedContinuation<Void, Never>] = []
    private var arrival: CheckedContinuation<Void, Never>?
    /// Runs after release, before the restart returns (the process came up
    /// as the new build).
    var onRestart: (@MainActor () -> Void)?

    func probeService() async -> LaunchdServiceProbe {
        probeCalls += 1
        return .loaded
    }
    func restartService() async {
        restartCalls += 1
        await withCheckedContinuation { gate in
            gates.append(gate)
            arrival?.resume()
            arrival = nil
        }
        if let onRestart { await onRestart() }
    }
    /// Suspends until a kickstart is parked — the explicit arrival signal
    /// the tests wait on instead of polling the gate array.
    func kickstartParked() async {
        if !gates.isEmpty { return }
        await withCheckedContinuation { arrival = $0 }
    }
    func release() {
        let parked = gates
        gates = []
        parked.forEach { $0.resume() }
    }
    func bootOutService() async { bootOutCalls += 1 }
}

private final class FlightBundledDaemon: BundledDaemonVerifying, @unchecked Sendable {
    func verifyBundledDaemon() async -> BundledDaemonVerification { .valid }
}

// MARK: - Tests

@MainActor
final class Issue688SingleFlightTests: XCTestCase {
    private var registrar = FlightRegistrar()
    private var marker = FlightMarker()
    private var probe = FlightProbe()
    private var launchd = GatedLaunchdControl()

    override func setUp() {
        super.setUp()
        registrar = FlightRegistrar()
        marker = FlightMarker()
        probe = FlightProbe()
        launchd = GatedLaunchdControl()
        // The ordinary update: recorded "old", bundle "new", old daemon up,
        // registered plist unchanged — decides the in-place restart, whose
        // kickstart is the suspension point these tests exploit.
        marker.registeredCommit = "old"
        marker.registeredPlistFingerprint = "plist-v1"
        probe.runningCommit = "old"
        launchd.onRestart = { [probe] in probe.runningCommit = "new" }
    }

    private func makeModel(attempts: Int = 2) -> DaemonSetupModel {
        DaemonSetupModel(
            dependencies: .init(
                registrar: registrar,
                tokenStore: FlightTokenStore(),
                legacyAgent: FlightLegacyAgent(),
                marker: marker,
                probe: probe,
                launchdControl: launchd,
                bundledDaemon: FlightBundledDaemon(),
                bundledCommit: "new",
                bundledPlistFingerprint: "plist-v1",
                hostSignatureAllowsServiceManagement: true
            ),
            startupProbeAttempts: attempts,
            startupProbeDelay: {}
        )
    }

    /// Starts an evaluation and waits until it is parked inside the kickstart.
    private func startEvaluationParkedInRestart(_ model: DaemonSetupModel) async -> Task<Bool, Never> {
        let first = Task { @MainActor in await model.evaluateOnLaunch() }
        await launchd.kickstartParked()
        return first
    }

    func testOverlappingEvaluationsRunOneSequenceAndShareTheResult() async {
        let model = makeModel()
        let first = await startEvaluationParkedInRestart(model)
        let launchProbes = probe.probeCalls
        let launchdProbes = launchd.probeCalls

        let second = Task { @MainActor in await model.evaluateOnLaunch() }
        for _ in 0..<100 { await Task.yield() }
        XCTAssertEqual(launchd.restartCalls, 1, "TRIPWIRE #688: the second call kickstarted again")
        XCTAssertEqual(probe.probeCalls, launchProbes, "TRIPWIRE #688: the second call re-ran the launch probe")
        XCTAssertEqual(launchd.probeCalls, launchdProbes, "TRIPWIRE #688: the second call re-probed launchd")

        launchd.release()
        let (firstResult, secondResult) = await (first.value, second.value)
        XCTAssertTrue(firstResult)
        XCTAssertEqual(firstResult, secondResult, "TRIPWIRE #688: the joiner got a different answer than the evaluation it joined")
        XCTAssertEqual(launchd.restartCalls, 1, "TRIPWIRE #688: two evaluations ran")
        XCTAssertEqual(registrar.registerCalls, 0)
        XCTAssertEqual(registrar.unregisterCalls, 0)
        XCTAssertEqual(launchd.bootOutCalls, 0)
        XCTAssertEqual(model.phase, .quiet)
        XCTAssertEqual(marker.registeredCommit, "new")
    }

    func testRetryDuringAnEvaluationJoinsIt() async {
        let model = makeModel()
        let first = await startEvaluationParkedInRestart(model)

        let retry = Task { @MainActor in await model.retry() }
        for _ in 0..<100 { await Task.yield() }
        XCTAssertEqual(launchd.restartCalls, 1, "TRIPWIRE #688: Retry during a fallback wait started a second evaluation")

        launchd.release()
        _ = await (first.value, retry.value)
        XCTAssertEqual(launchd.restartCalls, 1, "TRIPWIRE #688: two evaluations ran")
        XCTAssertEqual(registrar.registerCalls, 0)
        XCTAssertEqual(model.phase, .quiet)
    }

    func testTheSlotClearsAfterASuccessfulEvaluation() async {
        let model = makeModel()
        let first = await startEvaluationParkedInRestart(model)
        launchd.release()
        let firstResult = await first.value
        XCTAssertTrue(firstResult)
        let probesAfterFirst = probe.probeCalls
        let launchdProbesAfterFirst = launchd.probeCalls

        // Marker and daemon now agree on "new": a fresh evaluation decides
        // `.running` — one launch probe, one launchd probe, no restart.
        let later = await model.evaluateOnLaunch()
        XCTAssertTrue(later)
        XCTAssertEqual(probe.probeCalls, probesAfterFirst + 1, "TRIPWIRE #688: the later call did not run a fresh evaluation")
        XCTAssertEqual(launchd.probeCalls, launchdProbesAfterFirst + 1, "TRIPWIRE #688: the later call did not run a fresh evaluation")
        XCTAssertEqual(launchd.restartCalls, 1)
    }

    func testTheSlotClearsAfterAFailedEvaluation() async {
        // The restart does not take and the fallback re-register fails, so
        // the first evaluation ends in `.failed` and returns false.
        launchd.onRestart = { [probe] in probe.reachable = false }
        registrar.registerError = FlightError()
        let model = makeModel()
        let first = await startEvaluationParkedInRestart(model)
        launchd.release()
        let firstResult = await first.value
        XCTAssertFalse(firstResult)
        guard case .failed = model.phase else {
            return XCTFail("test setup: expected the first evaluation to fail, got \(model.phase)")
        }
        XCTAssertEqual(launchd.restartCalls, 1)
        XCTAssertEqual(registrar.registerCalls, 1)

        // Retry after the failure runs fresh — a second kickstart is correct
        // here (the user asked), and proves the slot did not stay occupied.
        // The failed re-register left the registrar unregistered; put it
        // back to `.enabled` so the retry decides the restart again.
        probe.reachable = true
        registrar.registerError = nil
        registrar.statusValue = .enabled
        launchd.onRestart = { [probe] in probe.runningCommit = "new" }
        let retry = Task { @MainActor in await model.retry() }
        await launchd.kickstartParked()
        launchd.release()
        await retry.value
        XCTAssertEqual(launchd.restartCalls, 2, "TRIPWIRE #688: the slot stayed occupied after a failed evaluation")
        XCTAssertEqual(model.phase, .quiet)
    }
}
