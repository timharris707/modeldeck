import XCTest
@testable import ModelDeckMacCore

// Issue #678 — TRIPWIRE (CLAUDE.md never-compromise #4). Decision 0041.
//
// Before this change every app update ran unregister → register → poll (up
// to ≈ 55 s with 5 s health probes) → verify → maybe bootout, all BEFORE the
// first state read, under a setup card, with the "service updated" banner on
// every release, and with the unregister/register round-trip able to revoke
// Login Items approval. These tests fail if any of that comes back:
//
// - drift with an enabled registrar restarts in place — one kickstart, no
//   register/unregister, no banner;
// - a restart that does not yield the bundled commit falls back to today's
//   ladder exactly once per rung (re-register, then bootout);
// - the restart wait uses the 1 s probe timeout and completes within the
//   reduced budget under a fake clock;
// - reconciliation and the first state read run concurrently;
// - the Sparkle relaunch marker skips the launchctl probe and is consumed;
// - `.awaitingApproval` is never entered from the drift path while the
//   registrar stays `.enabled`.

// MARK: - Fakes

private final class RestartRegistrar: DaemonServiceRegistrar, @unchecked Sendable {
    var statusValue: ServiceRegistrationStatus = .enabled
    var statusAfterRegister: ServiceRegistrationStatus = .enabled
    var registerCalls = 0
    var unregisterCalls = 0
    var onRegister: (() -> Void)?
    var status: ServiceRegistrationStatus { statusValue }
    func register() throws {
        registerCalls += 1
        onRegister?()
        statusValue = statusAfterRegister
    }
    func unregister() throws {
        unregisterCalls += 1
        statusValue = .notRegistered
    }
}

private final class RestartTokenStore: MutationTokenStore, @unchecked Sendable {
    func tokenExists() throws -> Bool { true }
    func createToken() throws {}
}

private final class RestartLegacyAgent: LegacyAgentInspecting, @unchecked Sendable {
    func isLegacyAgentPresent() -> Bool { false }
    func removeLegacyAgent() throws {}
}

private final class RestartMarker: RegistrationMarkerStore, @unchecked Sendable {
    var registeredCommit: String?
    var registeredPlistFingerprint: String?
}

/// Records the timeout of every health probe the model makes, and drives a
/// fake clock forward by that timeout when the probe goes unanswered — so
/// the wait budget is measurable without sleeping.
private final class TimedProbe: DaemonReachabilityProbing, @unchecked Sendable {
    var reachable = true
    var runningCommit: String?
    /// nil = the default `probeDaemon()`; a value = `probeDaemon(timeout:)`.
    var timeoutsSeen: [TimeInterval?] = []
    var clock: FakeClock?
    var probeCalls: Int { timeoutsSeen.count }

    func probeDaemon() async -> DaemonProbeSnapshot? {
        timeoutsSeen.append(nil)
        return answer(spent: 5)
    }

    func probeDaemon(timeout: TimeInterval) async -> DaemonProbeSnapshot? {
        timeoutsSeen.append(timeout)
        return answer(spent: timeout)
    }

    private func answer(spent: TimeInterval) -> DaemonProbeSnapshot? {
        if reachable { return DaemonProbeSnapshot(runningCommit: runningCommit) }
        clock?.advance(by: spent)
        return nil
    }
}

private final class FakeClock: @unchecked Sendable {
    private(set) var elapsed: TimeInterval = 0
    func advance(by seconds: TimeInterval) { elapsed += seconds }
}

private final class RestartLaunchdControl: LaunchdServiceControlling, @unchecked Sendable {
    var probeResult: LaunchdServiceProbe = .loaded
    var probeCalls = 0
    var restartCalls = 0
    var bootOutCalls = 0
    /// Main-actor hook so a test can read the model's phase at the moment
    /// of the kickstart (the model drives this seam from the main actor).
    var onRestart: (@MainActor () -> Void)?
    var onBootOut: (() -> Void)?
    func probeService() async -> LaunchdServiceProbe {
        probeCalls += 1
        return probeResult
    }
    func restartService() async {
        restartCalls += 1
        if let onRestart { await onRestart() }
    }
    func bootOutService() async {
        bootOutCalls += 1
        probeResult = .notFound
        onBootOut?()
    }
}

private final class RestartBundledDaemon: BundledDaemonVerifying, @unchecked Sendable {
    func verifyBundledDaemon() async -> BundledDaemonVerification { .valid }
}

private final class RecordingRelaunchMarker: UpdateRelaunchMarking, @unchecked Sendable {
    var recorded = false
    var consumeCalls = 0
    func recordRelaunch() { recorded = true }
    func consumeRelaunchMarker() -> Bool {
        consumeCalls += 1
        defer { recorded = false }
        return recorded
    }
}

// MARK: - Pure decision

final class Issue678DecisionTests: XCTestCase {
    private func decide(
        reachable: Bool = true,
        runningCommit: String? = "old",
        launchdService: LaunchdServiceProbe = .loaded,
        recordedCommit: String? = "old"
    ) -> DaemonSetupDecision {
        decideDaemonSetup(
            hostSignatureAllowsServiceManagement: true,
            probe: reachable ? DaemonProbeSnapshot(runningCommit: runningCommit) : nil,
            registration: .enabled,
            launchdService: launchdService,
            legacyPresent: false,
            recordedCommit: recordedCommit,
            bundledCommit: "new",
            bundledDaemon: .unavailable
        )
    }

    func testEnabledDriftDecidesRestartNotReregister() {
        XCTAssertEqual(
            decide(),
            .driftRestart(recorded: "old", bundled: "new"),
            "TRIPWIRE #678: an ordinary update decided anything other than the in-place restart"
        )
    }

    func testDriftWithNothingAnsweringStillRestarts() {
        // The daemon is between spawns (or slow); launchd has the job. A
        // kickstart is still the cheapest correct move.
        XCTAssertEqual(decide(reachable: false), .driftRestart(recorded: "old", bundled: "new"))
    }

    func testDriftWithUnknownLaunchdProbeStillRestarts() {
        // A failed launchctl probe is not evidence of absence (PR #223).
        XCTAssertEqual(
            decide(launchdService: .unknown),
            .driftRestart(recorded: "old", bundled: "new")
        )
    }

    func testCommitOnlyDriftNeverDecidesTheFullReregister() {
        // Re-registering is reserved for a changed service DEFINITION (the
        // plist fingerprint, review of PR #687). A commit-only change — the
        // ordinary release — must never reach it as a launch-time decision;
        // it is the restart's fallback, decided by the running daemon.
        let outcomes: [DaemonSetupDecision] = [
            decide(), decide(reachable: false), decide(reachable: false, launchdService: .notFound),
            decide(reachable: false, launchdService: .spawnFailed), decide(launchdService: .unknown),
        ]
        for outcome in outcomes {
            if case .driftReregister = outcome {
                XCTFail("TRIPWIRE #678: commit-only drift decided the full re-register: \(outcome)")
            }
        }
    }
}

// MARK: - Model: the ladder

@MainActor
final class Issue678RestartLadderTests: XCTestCase {
    private var registrar = RestartRegistrar()
    private var marker = RestartMarker()
    private var probe = TimedProbe()
    private var launchd = RestartLaunchdControl()
    private var relaunch = RecordingRelaunchMarker()
    private var clock = FakeClock()

    override func setUp() {
        super.setUp()
        registrar = RestartRegistrar()
        marker = RestartMarker()
        probe = TimedProbe()
        launchd = RestartLaunchdControl()
        relaunch = RecordingRelaunchMarker()
        clock = FakeClock()
        probe.clock = clock
        // The ordinary update: recorded "old", bundle "new", old daemon up,
        // and the registered plist is this bundle's plist.
        marker.registeredCommit = "old"
        marker.registeredPlistFingerprint = "plist-v1"
        probe.runningCommit = "old"
    }

    /// The bundled plist's fingerprint; tests vary the RECORDED one.
    private let bundledPlistFingerprint = "plist-v1"

    private func makeModel(attempts: Int = 10) -> DaemonSetupModel {
        DaemonSetupModel(
            dependencies: .init(
                registrar: registrar,
                tokenStore: RestartTokenStore(),
                legacyAgent: RestartLegacyAgent(),
                marker: marker,
                probe: probe,
                launchdControl: launchd,
                bundledDaemon: RestartBundledDaemon(),
                updateRelaunchMarker: relaunch,
                bundledCommit: "new",
                bundledPlistFingerprint: bundledPlistFingerprint,
                hostSignatureAllowsServiceManagement: true
            ),
            startupProbeAttempts: attempts,
            // The fake clock charges 0.5 s per inter-probe delay, matching
            // the production `Task.sleep(500 ms)`.
            startupProbeDelay: { [clock] in clock.advance(by: 0.5) }
        )
    }

    /// The kickstart takes: the relaunched process is the new build.
    private func restartYieldsTheNewBuild() {
        launchd.onRestart = { [probe] in probe.runningCommit = "new" }
    }

    // Rung 1

    func testDriftRestartsOnceAndNeverTouchesTheRegistration() async {
        restartYieldsTheNewBuild()
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.restartCalls, 1, "TRIPWIRE #678: the in-place restart did not run")
        XCTAssertEqual(registrar.unregisterCalls, 0, "TRIPWIRE #678: a plain update called unregister()")
        XCTAssertEqual(registrar.registerCalls, 0, "TRIPWIRE #678: a plain update called register()")
        XCTAssertEqual(launchd.bootOutCalls, 0)
        XCTAssertEqual(marker.registeredCommit, "new", "the marker advances once the new build answers")
        XCTAssertFalse(model.didReregisterForUpdate, "TRIPWIRE #678: the per-release banner fired on a clean restart")
        XCTAssertFalse(model.keychainPromptCoachingActive)
        XCTAssertEqual(model.phase, .quiet)
    }

    func testCleanRestartNeverShowsASetupCard() async {
        // The phase is observed at every probe: a plain update must never
        // pass through `.startingUp` (the card) on its way to quiet.
        restartYieldsTheNewBuild()
        var phasesSeen: [DaemonSetupModel.Phase] = []
        let model = makeModel()
        launchd.onRestart = { [probe] in
            probe.runningCommit = "new"
            phasesSeen.append(model.phase)
        }
        await model.evaluateOnLaunch()
        XCTAssertEqual(phasesSeen, [.checking])
        XCTAssertEqual(model.phase, .quiet)
    }

    // Rung 2 and 3

    func testRestartThatDoesNotYieldTheBundledCommitFallsBackToReregisterOnce() async {
        // The kickstarted process still answers "old" (the #514 shape from
        // above: launchd respawned from a record that no longer fits). The
        // fallback re-register brings up the new build.
        registrar.onRegister = { [probe] in probe.runningCommit = "new" }
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.restartCalls, 1)
        XCTAssertEqual(registrar.unregisterCalls, 1, "exactly one fallback re-register")
        XCTAssertEqual(registrar.registerCalls, 1)
        XCTAssertEqual(launchd.bootOutCalls, 0, "the re-register took; no bootout")
        XCTAssertTrue(model.didReregisterForUpdate, "the banner is honest here: the registration WAS replaced")
        XCTAssertEqual(marker.registeredCommit, "new")
        XCTAssertEqual(model.phase, .quiet)
    }

    func testRestartThenReregisterThenBootoutMatchesTodaysLadder() async {
        // Nothing short of a bootout dislodges the stale process.
        launchd.onBootOut = { [probe] in probe.runningCommit = "new" }
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.restartCalls, 1, "one kickstart")
        XCTAssertEqual(launchd.bootOutCalls, 1, "one bootout")
        XCTAssertEqual(registrar.unregisterCalls, 2, "re-register, then the bootout's re-register")
        XCTAssertEqual(registrar.registerCalls, 2)
        XCTAssertTrue(model.didReregisterForUpdate)
        XCTAssertEqual(model.phase, .quiet)
    }

    func testAStaleProcessThatSurvivesEverythingFailsActionablyWithOneOfEach() async {
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.restartCalls, 1, "TRIPWIRE #678: kickstart looped")
        XCTAssertEqual(launchd.bootOutCalls, 1, "bootout looped")
        XCTAssertEqual(registrar.registerCalls, 2)
        XCTAssertEqual(model.phase, .failed(DaemonSetupModel.staleDaemonAfterRestartMessage))
    }

    func testRestartWithNothingAnsweringFallsBackToReregister() async {
        // The daemon never comes back after the kickstart (the wait budget
        // expires); the re-register is the next rung, and its own wait uses
        // the DEFAULT probe timeout, not the restart's short one.
        probe.reachable = false
        registrar.onRegister = { [probe] in
            probe.reachable = true
            probe.runningCommit = "new"
        }
        let model = makeModel(attempts: 3)
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.restartCalls, 1)
        XCTAssertEqual(registrar.registerCalls, 1)
        XCTAssertEqual(model.phase, .quiet)
        // Launch probe (default), 3 restart probes (1 s), 1 post-register
        // probe (default).
        XCTAssertEqual(probe.timeoutsSeen, [nil, 1, 1, 1, nil])
    }

    // Wait budget

    func testRestartProbeTimeoutIsOneSecondAndTheDefaultIsUntouched() async {
        restartYieldsTheNewBuild()
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(DaemonSetupModel.restartProbeTimeout, 1)
        // One launch probe on the default timeout, one restart probe on 1 s.
        XCTAssertEqual(probe.timeoutsSeen, [nil, 1],
                       "TRIPWIRE #678: the restart wait is not using the 1 s probe timeout")
    }

    func testRestartWaitCompletesWithinTheReducedBudgetUnderAFakeClock() async {
        // The restart never yields a reachable daemon; the whole restart wait
        // runs to exhaustion. Pre-#678 the same wait cost 10 × 5 s probes +
        // 9 × 0.5 s ≈ 54.5 s. Now: 10 × 1 s + 9 × 0.5 s = 14.5 s.
        probe.reachable = false
        let model = makeModel(attempts: 10)
        // Measure only the restart rung: stop the clock once the fallback
        // re-register begins.
        var elapsedAtFallback: TimeInterval?
        registrar.onRegister = { [clock] in elapsedAtFallback = clock.elapsed }
        await model.evaluateOnLaunch()
        // Subtract the launch probe's own default 5 s (charged before the
        // restart began).
        let restartWait = (elapsedAtFallback ?? .infinity) - 5
        XCTAssertEqual(restartWait, 14.5, accuracy: 0.001,
                       "TRIPWIRE #678: the restart wait budget regressed toward the ~55 s worst case")
        XCTAssertLessThan(restartWait, 16)
    }

    // Approval

    func testDriftRestartNeverEntersAwaitingApproval() async {
        // TRIPWIRE #678: the restart rung has no registration call, so it
        // has no way to land the user in "Waiting for your approval".
        // Observed at every phase the model passes through, not just the end.
        restartYieldsTheNewBuild()
        var phasesSeen: [DaemonSetupModel.Phase] = []
        let model = makeModel()
        launchd.onRestart = { [probe] in
            probe.runningCommit = "new"
            phasesSeen.append(model.phase)
        }
        await model.evaluateOnLaunch()
        phasesSeen.append(model.phase)
        XCTAssertFalse(phasesSeen.contains(.awaitingApproval),
                       "TRIPWIRE #678: a plain update landed in Waiting for your approval")
        XCTAssertEqual(registrar.status, .enabled, "the registrar was never asked to change")
        XCTAssertEqual(model.phase, .quiet)
    }

    func testFallbackReregisterMayStillGateOnApprovalAndSaysSo() async {
        // The honest residual (decision 0041 §5): only the FALLBACK can hit
        // the approval gate, and when it does the existing routing applies.
        registrar.statusAfterRegister = .requiresApproval
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.restartCalls, 1)
        XCTAssertEqual(registrar.registerCalls, 1)
        XCTAssertEqual(model.phase, .awaitingApproval)
        XCTAssertTrue(model.didReregisterForUpdate)
    }

    // Relaunch marker

    func testRelaunchMarkerSkipsTheLaunchctlProbeAndIsConsumed() async {
        relaunch.recorded = true
        restartYieldsTheNewBuild()
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.probeCalls, 0,
                       "TRIPWIRE #678: the relaunch marker did not skip the launchctl print probe")
        XCTAssertEqual(launchd.restartCalls, 1)
        XCTAssertEqual(relaunch.consumeCalls, 1)
        XCTAssertFalse(relaunch.recorded, "the marker is launch-scoped: consumed on read")
        XCTAssertEqual(model.phase, .quiet)

        // A second evaluation in the same launch sees no marker.
        marker.registeredCommit = "older"
        probe.runningCommit = "old"
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.probeCalls, 1, "without the marker, today's probe runs")
    }

    func testAbsentMarkerTakesTodaysPath() async {
        restartYieldsTheNewBuild()
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.probeCalls, 1)
        XCTAssertEqual(launchd.restartCalls, 1)
        XCTAssertEqual(relaunch.consumeCalls, 1, "the marker is always consumed, even when absent")
    }

    func testMarkerWithoutDriftDoesNotSkipTheProbe() async {
        // A relaunch that did not move the commit (same-version reinstall)
        // still needs the probe: a wedged or spawn-rejected job must be seen.
        relaunch.recorded = true
        marker.registeredCommit = "new"
        probe.runningCommit = "new"
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.probeCalls, 1)
        XCTAssertEqual(launchd.restartCalls, 0)
        XCTAssertEqual(model.phase, .quiet)
    }

    func testRelaunchMarkerStillHealsASpawnRejectedJobInTheSameLaunch() async {
        // The #514 shape on a relaunch: the marker skips the probe, so the
        // spawn-rejected job is not seen up front. The kickstart changes
        // nothing, the restart wait expires, the fallback re-register runs,
        // and ITS verification tail asks launchd — which is where #514's
        // bootout repair still fires. One rung later than today (≈ 15 s),
        // never a stranded "starting…" (decision 0041, question 3).
        relaunch.recorded = true
        probe.reachable = false
        launchd.probeResult = .spawnFailed
        launchd.onBootOut = { [probe] in
            probe.reachable = true
            probe.runningCommit = "new"
        }
        let model = makeModel(attempts: 2)
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.restartCalls, 1)
        XCTAssertEqual(launchd.probeCalls, 1, "the probe ran in the verification tail, not up front")
        XCTAssertEqual(launchd.bootOutCalls, 1, "TRIPWIRE #514/#678: the relaunch marker hid a spawn-rejected job")
        XCTAssertEqual(model.phase, .quiet)
    }

    func testMarkerNeverSkipsTheWedgeOrSpawnFailedRepairsWhenThereIsNoDrift() async {
        relaunch.recorded = true
        marker.registeredCommit = "new"
        probe.reachable = false
        launchd.probeResult = .notFound
        launchd.onBootOut = { [probe] in
            probe.reachable = true
            probe.runningCommit = "new"
        }
        let model = makeModel(attempts: 2)
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.probeCalls, 1)
        XCTAssertEqual(launchd.bootOutCalls, 1, "the wedge repair still runs")
        XCTAssertEqual(launchd.restartCalls, 0)
        XCTAssertEqual(model.phase, .quiet)
    }

    // Plist fingerprint (review of PR #687): a changed service definition is
    // invisible to commit verification — the new binary starts under the
    // OLD settings and reports its new commit — so it needs its own signal.

    func testChangedPlistWithNewCommitReregistersOnceAndNeverKickstarts() async {
        marker.registeredPlistFingerprint = "plist-v0"
        registrar.onRegister = { [probe] in probe.runningCommit = "new" }
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.restartCalls, 0,
                       "TRIPWIRE #678: a changed service definition was kickstarted — the new settings would never apply")
        XCTAssertEqual(registrar.unregisterCalls, 1)
        XCTAssertEqual(registrar.registerCalls, 1)
        XCTAssertTrue(model.didReregisterForUpdate)
        XCTAssertEqual(marker.registeredCommit, "new")
        XCTAssertEqual(marker.registeredPlistFingerprint, "plist-v1", "the marker records the definition it registered")
        XCTAssertEqual(model.phase, .quiet)
    }

    func testChangedPlistWithSameCommitStillReregisters() async {
        // A release that changes only a plist key ships the same daemon
        // build; the definition still has to be applied.
        marker.registeredCommit = "new"
        marker.registeredPlistFingerprint = "plist-v0"
        probe.runningCommit = "new"
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.restartCalls, 0)
        XCTAssertEqual(registrar.registerCalls, 1)
        XCTAssertEqual(marker.registeredPlistFingerprint, "plist-v1")
        XCTAssertEqual(model.phase, .quiet)
    }

    func testUnchangedPlistWithNewCommitKickstartsOnly() async {
        restartYieldsTheNewBuild()
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.restartCalls, 1)
        XCTAssertEqual(registrar.registerCalls, 0)
        XCTAssertEqual(marker.registeredPlistFingerprint, "plist-v1")
    }

    func testMissingRecordedFingerprintIsRecordedWithoutAReregister() async {
        // An install from before the fingerprint existed: the registered
        // definition is known to be this plist (unchanged in every release
        // since #96), so it is recorded, not re-registered.
        marker.registeredCommit = "new"
        marker.registeredPlistFingerprint = nil
        probe.runningCommit = "new"
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(registrar.registerCalls, 0, "TRIPWIRE #678: the first launch after the fingerprint shipped forced a re-register")
        XCTAssertEqual(launchd.restartCalls, 0)
        XCTAssertEqual(marker.registeredPlistFingerprint, "plist-v1")
        XCTAssertFalse(model.didReregisterForUpdate)
        XCTAssertEqual(model.phase, .quiet)
    }

    func testMissingRecordedFingerprintWithDriftStillJustRestarts() async {
        marker.registeredPlistFingerprint = nil
        restartYieldsTheNewBuild()
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.restartCalls, 1)
        XCTAssertEqual(registrar.registerCalls, 0)
        XCTAssertEqual(marker.registeredPlistFingerprint, "plist-v1")
    }

    // Untrusted host

    func testUntrustedHostNeverKickstarts() async {
        let model = DaemonSetupModel(
            dependencies: .init(
                registrar: registrar,
                tokenStore: RestartTokenStore(),
                legacyAgent: RestartLegacyAgent(),
                marker: marker,
                probe: probe,
                launchdControl: launchd,
                bundledDaemon: RestartBundledDaemon(),
                updateRelaunchMarker: relaunch,
                bundledCommit: "new",
                bundledPlistFingerprint: bundledPlistFingerprint,
                hostSignatureAllowsServiceManagement: false
            ),
            startupProbeAttempts: 1,
            startupProbeDelay: {}
        )
        marker.registeredPlistFingerprint = nil
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.restartCalls, 0, "TRIPWIRE #486/#678: kickstart from an untrusted build")
        XCTAssertNil(marker.registeredPlistFingerprint, "an untrusted build records nothing about the production registration")
        XCTAssertEqual(model.phase, .quiet)
    }
}

// MARK: - Launch ordering: reconciliation alongside the first read

@MainActor
final class Issue678LaunchOrderingTests: XCTestCase {
    /// A health probe that does not answer until released — models the
    /// restart wait holding the reconciliation open.
    private final class GatedProbe: DaemonReachabilityProbing, @unchecked Sendable {
        private let gate = AsyncGate()
        var runningCommit: String? = "new"
        func probeDaemon() async -> DaemonProbeSnapshot? {
            await gate.wait()
            return DaemonProbeSnapshot(runningCommit: runningCommit)
        }
        func release() { gate.open() }
    }

    /// Minimal one-shot gate: `wait()` suspends until `open()`.
    private final class AsyncGate: @unchecked Sendable {
        private let lock = NSLock()
        private var opened = false
        private var waiters: [CheckedContinuation<Void, Never>] = []
        func wait() async {
            await withCheckedContinuation { continuation in
                lock.lock()
                if opened {
                    lock.unlock()
                    continuation.resume()
                } else {
                    waiters.append(continuation)
                    lock.unlock()
                }
            }
        }
        func open() {
            lock.lock()
            opened = true
            let pending = waiters
            waiters = []
            lock.unlock()
            pending.forEach { $0.resume() }
        }
    }

    func testFirstReadCompletesBeforeReconciliationFinishes() async {
        // Reconciliation is held on its first health probe; the first read
        // must not wait for it. Pre-#678 the app awaited evaluateOnLaunch()
        // before calling refresh(), so the read could never finish first.
        let probe = GatedProbe()
        let registrar = RestartRegistrar()
        let marker = RestartMarker()
        marker.registeredCommit = "new"
        let model = DaemonSetupModel(
            dependencies: .init(
                registrar: registrar,
                tokenStore: RestartTokenStore(),
                legacyAgent: RestartLegacyAgent(),
                marker: marker,
                probe: probe,
                launchdControl: RestartLaunchdControl(),
                bundledDaemon: RestartBundledDaemon(),
                bundledCommit: "new",
                hostSignatureAllowsServiceManagement: true
            ),
            startupProbeAttempts: 1,
            startupProbeDelay: {}
        )

        let order = OrderLog()
        await LaunchReconciliation.runAlongsideFirstRead(
            reconcile: {
                let verifiedUp = await model.evaluateOnLaunch()
                order.append("reconcile-done")
                return verifiedUp
            },
            read: {
                order.append("read-done")
                // The read has landed; only now let the health probe answer.
                probe.release()
            }
        )
        XCTAssertEqual(order.entries, ["read-done", "reconcile-done", "read-done"],
                       "TRIPWIRE #678: the first state read waited for the daemon reconciliation")
        XCTAssertEqual(model.phase, .quiet)
    }

    func testBothSidesRunAndAVerifiedDaemonGetsOneFollowUpRead() async {
        let order = OrderLog()
        await LaunchReconciliation.runAlongsideFirstRead(
            reconcile: { order.append("reconcile"); return true },
            read: { order.append("read") }
        )
        XCTAssertEqual(order.entries.filter { $0 == "read" }.count, 2, "one concurrent read, one follow-up")
        XCTAssertEqual(order.entries.filter { $0 == "reconcile" }.count, 1)
    }

    func testNoFollowUpReadWhenTheDaemonIsNotVerifiedUp() async {
        // Consent / approval / failed: the setup card owns the story and a
        // read against a daemon that is not there would only add a failure.
        let order = OrderLog()
        await LaunchReconciliation.runAlongsideFirstRead(
            reconcile: { false },
            read: { order.append("read") }
        )
        XCTAssertEqual(order.entries, ["read"])
    }

    /// The review's reproduced finding (PR #687, `first-read` probe): the
    /// first state read hits connection-refused in the gap while the old
    /// daemon is going down, the restart then verifies, and with automatic
    /// refresh disabled nothing ever reads again — the deck sat on
    /// "unreachable" beside a healthy new daemon.
    func testFirstReadFailingDuringTheRestartStillEndsConnected() async {
        let world = RestartGapWorld()
        let registrar = RestartRegistrar()
        let marker = RestartMarker()
        marker.registeredCommit = "old"
        marker.registeredPlistFingerprint = "plist-v1"
        let launchd = RestartLaunchdControl()
        launchd.onRestart = { world.daemonIsUp = true }
        let setup = DaemonSetupModel(
            dependencies: .init(
                registrar: registrar,
                tokenStore: RestartTokenStore(),
                legacyAgent: RestartLegacyAgent(),
                marker: marker,
                probe: world,
                launchdControl: launchd,
                bundledDaemon: RestartBundledDaemon(),
                bundledCommit: "new",
                bundledPlistFingerprint: "plist-v1",
                hostSignatureAllowsServiceManagement: true
            ),
            startupProbeAttempts: 3,
            startupProbeDelay: {}
        )
        let status = MenuBarStatusModel(evaluator: world, stateProvider: world)
        var settings = DaemonSettings.defaults
        settings.autoRefreshEnabled = false
        status.startAutoRefresh(interval: settings.effectiveAutoRefreshInterval)

        await LaunchReconciliation.runAlongsideFirstRead(
            reconcile: { await setup.evaluateOnLaunch() },
            read: { await status.refresh() }
        )
        XCTAssertEqual(launchd.restartCalls, 1)
        XCTAssertEqual(registrar.registerCalls, 0)
        XCTAssertEqual(setup.phase, .quiet)
        XCTAssertEqual(world.reads, 2, "the concurrent read, then the follow-up after verification")
        XCTAssertEqual(status.connection, .connected,
                       "TRIPWIRE #678: a first read that failed during the restart left the deck unreachable beside a healthy daemon")
        XCTAssertTrue(status.hasLoadedOnce)
    }

    // Review of PR #687, round 2: `.quiet` also covers the stand-downs, so
    // the follow-up read must key on evaluateOnLaunch's explicit result.

    private func makeStandDownModel(hostTrusted: Bool, bundledCommit: String?) -> DaemonSetupModel {
        let registrar = RestartRegistrar()
        let marker = RestartMarker()
        marker.registeredCommit = "old"
        return DaemonSetupModel(
            dependencies: .init(
                registrar: registrar,
                tokenStore: RestartTokenStore(),
                legacyAgent: RestartLegacyAgent(),
                marker: marker,
                probe: TimedProbe(),
                launchdControl: RestartLaunchdControl(),
                bundledDaemon: RestartBundledDaemon(),
                bundledCommit: bundledCommit,
                hostSignatureAllowsServiceManagement: hostTrusted
            ),
            startupProbeAttempts: 1,
            startupProbeDelay: {}
        )
    }

    func testHostSignatureStandDownIsQuietButNotVerifiedUpAndGetsNoFollowUpRead() async {
        let model = makeStandDownModel(hostTrusted: false, bundledCommit: "new")
        let order = OrderLog()
        await LaunchReconciliation.runAlongsideFirstRead(
            reconcile: { await model.evaluateOnLaunch() },
            read: { order.append("read") }
        )
        XCTAssertEqual(model.phase, .quiet, "the surface has nothing to show")
        XCTAssertEqual(order.entries, ["read"],
                       "TRIPWIRE #678: the stand-down phase was read as a verified daemon and drew a follow-up read")
    }

    func testBundledServiceUnavailableIsQuietButNotVerifiedUpAndGetsNoFollowUpRead() async {
        let model = makeStandDownModel(hostTrusted: true, bundledCommit: nil)
        let order = OrderLog()
        await LaunchReconciliation.runAlongsideFirstRead(
            reconcile: { await model.evaluateOnLaunch() },
            read: { order.append("read") }
        )
        XCTAssertEqual(model.phase, .quiet)
        XCTAssertEqual(order.entries, ["read"],
                       "TRIPWIRE #678: a dev build without a bundled daemon drew a follow-up read")
    }

    func testEvaluateReportsVerifiedUpOnlyWhenTheDaemonAnswered() async {
        // Reachable and current → true. Stand-downs → false despite `.quiet`.
        // Genuine setup states → false.
        let registrar = RestartRegistrar()
        let marker = RestartMarker()
        marker.registeredCommit = "new"
        marker.registeredPlistFingerprint = "plist-v1"
        let probe = TimedProbe()
        probe.runningCommit = "new"
        let running = DaemonSetupModel(
            dependencies: .init(
                registrar: registrar, tokenStore: RestartTokenStore(),
                legacyAgent: RestartLegacyAgent(), marker: marker, probe: probe,
                launchdControl: RestartLaunchdControl(), bundledDaemon: RestartBundledDaemon(),
                bundledCommit: "new", bundledPlistFingerprint: "plist-v1",
                hostSignatureAllowsServiceManagement: true
            ),
            startupProbeAttempts: 1, startupProbeDelay: {}
        )
        let runningResult = await running.evaluateOnLaunch()
        XCTAssertTrue(runningResult)
        XCTAssertEqual(running.phase, .quiet)

        let standDown = await makeStandDownModel(hostTrusted: false, bundledCommit: "new").evaluateOnLaunch()
        XCTAssertFalse(standDown)
        let devBuild = await makeStandDownModel(hostTrusted: true, bundledCommit: nil).evaluateOnLaunch()
        XCTAssertFalse(devBuild)

        registrar.statusValue = .notRegistered
        probe.reachable = false
        let consent = await running.evaluateOnLaunch()
        XCTAssertFalse(consent)
        XCTAssertEqual(running.phase, .consentNeeded)
    }

    /// The daemon as the restart gap sees it: down for the first state read,
    /// up (as the new build) once the kickstart has run.
    private final class RestartGapWorld: DaemonReachabilityProbing, DeckStateProviding,
                                          UsageEvaluating, @unchecked Sendable {
        var daemonIsUp = false
        var reads = 0
        func probeDaemon() async -> DaemonProbeSnapshot? {
            daemonIsUp ? DaemonProbeSnapshot(runningCommit: "new") : DaemonProbeSnapshot(runningCommit: "old")
        }
        func deckState() async throws -> DeckState {
            reads += 1
            // Refused while the old process is between SIGTERM and respawn.
            guard daemonIsUp else { throw URLError(.cannotConnectToHost) }
            return DeckState()
        }
        func evaluateWorstRemaining() async throws -> WorstRemaining? {
            guard daemonIsUp else { throw URLError(.cannotConnectToHost) }
            return nil
        }
    }

    private final class OrderLog: @unchecked Sendable {
        private let lock = NSLock()
        private(set) var entries: [String] = []
        func append(_ entry: String) { lock.withLock { entries.append(entry) } }
    }
}

// MARK: - The relaunch marker store

final class Issue678RelaunchMarkerStoreTests: XCTestCase {
    func testRecordThenConsumeIsTrueAndClears() {
        let store = UserDefaultsUpdateRelaunchMarker(defaults: ScratchDefaults.make("issue678"))
        XCTAssertFalse(store.consumeRelaunchMarker(), "nothing recorded yet")
        store.recordRelaunch()
        XCTAssertTrue(store.consumeRelaunchMarker())
        XCTAssertFalse(store.consumeRelaunchMarker(), "TRIPWIRE #678: the relaunch marker outlived its consume")
    }

    func testNoMarkerIsTheDefaultDependency() {
        // The dependency default is "no marker" so every wiring that does
        // not mention it — and every existing test — keeps today's path.
        XCTAssertFalse(NoUpdateRelaunchMarker().consumeRelaunchMarker())
    }
}
