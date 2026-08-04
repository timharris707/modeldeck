import XCTest
@testable import ModelDeckMacCore

// Issue #96 — the bundled-daemon lifecycle state machine. Every seam is a
// fake: these tests never touch SMAppService, the Keychain, launchctl, or a
// live daemon.

// MARK: - Fakes

private final class FakeRegistrar: DaemonServiceRegistrar, @unchecked Sendable {
    var statusValue: ServiceRegistrationStatus = .notRegistered
    /// Status reported AFTER a successful register() (SMAppService flips to
    /// .enabled or .requiresApproval).
    var statusAfterRegister: ServiceRegistrationStatus = .enabled
    var registerError: Error?
    /// Status the failed register() leaves behind (SMAppService can throw
    /// while flipping to .requiresApproval); nil keeps the current status.
    var errorLeavesStatus: ServiceRegistrationStatus?
    var registerCalls = 0
    var unregisterCalls = 0

    var status: ServiceRegistrationStatus { statusValue }

    func register() throws {
        registerCalls += 1
        if let registerError {
            if let errorLeavesStatus { statusValue = errorLeavesStatus }
            throw registerError
        }
        statusValue = statusAfterRegister
    }

    func unregister() throws {
        unregisterCalls += 1
        statusValue = .notRegistered
    }
}

private final class FakeTokenStore: MutationTokenStore, @unchecked Sendable {
    var exists = false
    var existsError: Error?
    var createError: Error?
    var createCalls = 0

    func tokenExists() throws -> Bool {
        if let existsError { throw existsError }
        return exists
    }

    func createToken() throws {
        createCalls += 1
        if let createError { throw createError }
        exists = true
    }
}

private final class FakeLegacyAgent: LegacyAgentInspecting, @unchecked Sendable {
    var present = false
    var removeError: Error?
    var removeCalls = 0

    func isLegacyAgentPresent() -> Bool { present }

    func removeLegacyAgent() throws {
        removeCalls += 1
        if let removeError { throw removeError }
        present = false
    }
}

private final class FakeMarker: RegistrationMarkerStore, @unchecked Sendable {
    var registeredCommit: String?
}

private final class FakeProbe: DaemonReachabilityProbing, @unchecked Sendable {
    /// Consumed front-to-first; the last value repeats.
    var results: [Bool]
    /// What the reachable daemon self-reports as its build commit. Defaults
    /// to the fixture's bundled commit so happy paths verify; nil models a
    /// pre-self-reporting (stale) daemon.
    var runningCommit: String?
    init(_ results: [Bool], runningCommit: String? = "new") {
        self.results = results
        self.runningCommit = runningCommit
    }
    /// Health round-trips this fake has served — the model must make ONE
    /// per launch evaluation (CodeRabbit PR #223: split reachability/commit
    /// requests could disagree and boot out a healthy daemon).
    var probeCalls = 0
    func probeDaemon() async -> DaemonProbeSnapshot? {
        probeCalls += 1
        let reachable: Bool
        if results.count > 1 { reachable = results.removeFirst() } else { reachable = results.first ?? false }
        return reachable ? DaemonProbeSnapshot(runningCommit: runningCommit) : nil
    }
}

private final class FakeLaunchdControl: LaunchdServiceControlling, @unchecked Sendable {
    var probeResult: LaunchdServiceProbe = .loaded
    var bootOutCalls = 0
    /// Models the real-world effect of the bootout (e.g. the stale process
    /// dies and the next registration starts the NEW build).
    var onBootOut: (() -> Void)?
    func probeService() async -> LaunchdServiceProbe { probeResult }
    func bootOutService() async {
        bootOutCalls += 1
        probeResult = .notFound
        onBootOut?()
    }
}

private struct TestError: LocalizedError {
    var errorDescription: String? { "boom" }
}

// MARK: - Pure decision

final class DaemonSetupDecisionTests: XCTestCase {
    /// Baseline call with the non-pathological extras: service present in
    /// launchd, probe snapshot assembled from reachable + runningCommit.
    private func decide(
        reachable: Bool,
        runningCommit: String? = nil,
        registration: ServiceRegistrationStatus,
        launchdService: LaunchdServiceProbe = .loaded,
        legacyPresent: Bool = false,
        recordedCommit: String?,
        bundledCommit: String?
    ) -> DaemonSetupDecision {
        decideDaemonSetup(
            probe: reachable ? DaemonProbeSnapshot(runningCommit: runningCommit) : nil,
            registration: registration, launchdService: launchdService,
            legacyPresent: legacyPresent,
            recordedCommit: recordedCommit, bundledCommit: bundledCommit
        )
    }

    func testNoBundledDaemonStandsDown() {
        XCTAssertEqual(
            decide(reachable: false, registration: .notRegistered,
                   recordedCommit: nil, bundledCommit: nil),
            .bundledServiceUnavailable
        )
        XCTAssertEqual(
            decide(reachable: false, registration: .notRegistered,
                   recordedCommit: nil, bundledCommit: ""),
            .bundledServiceUnavailable
        )
    }

    func testReachableAndCurrentIsRunning() {
        XCTAssertEqual(
            decide(reachable: true, runningCommit: "abc", registration: .enabled,
                   recordedCommit: "abc", bundledCommit: "abc"),
            .running
        )
    }

    func testReachableWithoutRegistrationIsRunning() {
        // Dev daemon started by hand — never nag while something answers.
        XCTAssertEqual(
            decide(reachable: true, registration: .notRegistered,
                   recordedCommit: nil, bundledCommit: "abc"),
            .running
        )
    }

    func testTrueFirstRunNeedsConsent() {
        XCTAssertEqual(
            decide(reachable: false, registration: .notRegistered,
                   recordedCommit: nil, bundledCommit: "abc"),
            .needsConsent
        )
    }

    func testDriftWinsEvenWhileRunning() {
        // The running daemon is the OLD build; re-register replaces it.
        XCTAssertEqual(
            decide(reachable: true, runningCommit: "old", registration: .enabled,
                   recordedCommit: "old", bundledCommit: "new"),
            .driftReregister(recorded: "old", bundled: "new")
        )
    }

    func testMissingMarkerCountsAsDrift() {
        XCTAssertEqual(
            decide(reachable: false, registration: .enabled,
                   recordedCommit: nil, bundledCommit: "new"),
            .driftReregister(recorded: nil, bundled: "new")
        )
    }

    func testLegacyPresentBlocksConsent() {
        XCTAssertEqual(
            decide(reachable: false, registration: .notRegistered,
                   legacyPresent: true, recordedCommit: nil, bundledCommit: "abc"),
            .legacyInstalledNotRunning
        )
    }

    func testLegacyPresentButReachableIsRunning() {
        XCTAssertEqual(
            decide(reachable: true, registration: .notRegistered,
                   legacyPresent: true, recordedCommit: nil, bundledCommit: "abc"),
            .running
        )
    }

    func testRegisteredAwaitingApproval() {
        XCTAssertEqual(
            decide(reachable: false, registration: .requiresApproval,
                   recordedCommit: nil, bundledCommit: "abc"),
            .awaitingApproval
        )
    }

    func testRegisteredCurrentButDownIsRegisteredNotRunning() {
        XCTAssertEqual(
            decide(reachable: false, registration: .enabled,
                   recordedCommit: "abc", bundledCommit: "abc"),
            .registeredNotRunning
        )
    }

    // The 2026-08-02 incident states

    func testStaleRunningDaemonForcesRestartEvenWithCurrentMarker() {
        // The incident's hidden state: two drift re-registers advanced the
        // marker while the 0.3.13 process kept answering. Only the running
        // daemon's self-report can expose it.
        XCTAssertEqual(
            decide(reachable: true, runningCommit: "old", registration: .enabled,
                   recordedCommit: "new", bundledCommit: "new"),
            .staleDaemonRestart(running: "old", bundled: "new")
        )
    }

    func testNonSelfReportingDaemonCountsAsStale() {
        // A daemon old enough not to self-report is by definition not the
        // build this app registered (self-reporting shipped with the fix).
        XCTAssertEqual(
            decide(reachable: true, runningCommit: nil, registration: .enabled,
                   recordedCommit: "new", bundledCommit: "new"),
            .staleDaemonRestart(running: nil, bundled: "new")
        )
    }

    func testDriftStillWinsOverStaleness() {
        // Drift re-register runs first; its own verification escalates to
        // the forced restart if the process survives.
        XCTAssertEqual(
            decide(reachable: true, runningCommit: nil, registration: .enabled,
                   recordedCommit: "old", bundledCommit: "new"),
            .driftReregister(recorded: "old", bundled: "new")
        )
    }

    func testEnabledButAbsentFromLaunchdIsWedged() {
        // Observed live after a manual bootout: SMAppService still claims
        // .enabled, launchd has nothing, register() no-ops.
        XCTAssertEqual(
            decide(reachable: false, registration: .enabled,
                   launchdService: .notFound,
                   recordedCommit: "abc", bundledCommit: "abc"),
            .wedgedServiceRepair(bundled: "abc")
        )
    }

    func testWedgeCheckNeverFiresWhileSomethingAnswers() {
        // Enabled + answering + no launchd job = hand-started dev daemon
        // holding the port; leave it alone.
        XCTAssertEqual(
            decide(reachable: true, runningCommit: "abc", registration: .enabled,
                   launchdService: .notFound,
                   recordedCommit: "abc", bundledCommit: "abc"),
            .running
        )
    }

    func testUnknownLaunchdProbeNeverWedges() {
        // A failed/unrecognized launchctl probe is NOT evidence of absence
        // (CodeRabbit PR #223) — fall through to plain starting-up handling.
        XCTAssertEqual(
            decide(reachable: false, registration: .enabled,
                   launchdService: .unknown,
                   recordedCommit: "abc", bundledCommit: "abc"),
            .registeredNotRunning
        )
    }

    func testNotRegisteredIsNeverWedged() {
        XCTAssertEqual(
            decide(reachable: false, registration: .notRegistered,
                   launchdService: .notFound,
                   recordedCommit: nil, bundledCommit: "abc"),
            .needsConsent
        )
    }
}

// MARK: - launchctl print exit classification (pure)

final class LaunchctlPrintExitTests: XCTestCase {
    func testZeroIsLoaded() {
        XCTAssertEqual(classifyLaunchctlPrintExit(0), .loaded)
    }

    func testCouldNotFindServiceIsNotFound() {
        // launchctl's "could not find service" status — the ONLY exit that
        // may arm the wedge repair.
        XCTAssertEqual(classifyLaunchctlPrintExit(113), .notFound)
    }

    func testRunnerLaunchFailureIsUnknown() {
        // The runner's synthetic exit when /bin/launchctl couldn't run.
        XCTAssertEqual(classifyLaunchctlPrintExit(127), .unknown)
    }

    func testOtherFailuresAreUnknown() {
        XCTAssertEqual(classifyLaunchctlPrintExit(1), .unknown)
        XCTAssertEqual(classifyLaunchctlPrintExit(64), .unknown)
    }
}

// MARK: - Post-re-register verification (pure)

final class ReregisterVerificationTests: XCTestCase {
    func testMatchingCommitVerifies() {
        XCTAssertEqual(
            verifyDaemonAfterReregister(probe: DaemonProbeSnapshot(runningCommit: "new"), bundledCommit: "new"),
            .verified
        )
    }

    func testWrongCommitIsStale() {
        XCTAssertEqual(
            verifyDaemonAfterReregister(probe: DaemonProbeSnapshot(runningCommit: "old"), bundledCommit: "new"),
            .staleProcessNeedsRestart
        )
    }

    func testMissingCommitIsStale() {
        // The exact incident shape: the surviving 0.3.13 daemon answers
        // /api/health but predates self-reporting — a DECODED answer with no
        // commit, which must never be confused with an unreachable daemon.
        XCTAssertEqual(
            verifyDaemonAfterReregister(probe: DaemonProbeSnapshot(runningCommit: nil), bundledCommit: "new"),
            .staleProcessNeedsRestart
        )
    }

    func testUnreachableIsNotAVerificationFailure() {
        XCTAssertEqual(
            verifyDaemonAfterReregister(probe: nil, bundledCommit: "new"),
            .unreachable
        )
    }
}

// MARK: - Model

@MainActor
final class DaemonSetupModelTests: XCTestCase {
    private var registrar = FakeRegistrar()
    private var tokenStore = FakeTokenStore()
    private var legacy = FakeLegacyAgent()
    private var marker = FakeMarker()
    private var probe = FakeProbe([false])
    private var launchd = FakeLaunchdControl()

    override func setUp() {
        super.setUp()
        registrar = FakeRegistrar()
        tokenStore = FakeTokenStore()
        legacy = FakeLegacyAgent()
        marker = FakeMarker()
        probe = FakeProbe([false])
        launchd = FakeLaunchdControl()
    }

    private func makeModel(bundledCommit: String? = "new") -> DaemonSetupModel {
        DaemonSetupModel(
            dependencies: .init(
                registrar: registrar,
                tokenStore: tokenStore,
                legacyAgent: legacy,
                marker: marker,
                probe: probe,
                launchdControl: launchd,
                bundledCommit: bundledCommit
            ),
            startupProbeAttempts: 3,
            startupProbeDelay: {} // instant in tests
        )
    }

    // Launch evaluation

    func testDevBuildStaysQuiet() async {
        let model = makeModel(bundledCommit: nil)
        await model.evaluateOnLaunch()
        XCTAssertEqual(model.phase, .quiet)
        XCTAssertFalse(model.bundledServiceAvailable)
    }

    func testFirstRunShowsConsent() async {
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(model.phase, .consentNeeded)
        XCTAssertEqual(registrar.registerCalls, 0, "nothing installs before consent")
        XCTAssertEqual(tokenStore.createCalls, 0)
    }

    func testReachableDaemonStaysQuiet() async {
        probe = FakeProbe([true])
        registrar.statusValue = .enabled
        marker.registeredCommit = "new"
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(model.phase, .quiet)
    }

    // Consent outcomes

    func testConsentInstallsTokenThenRegistersThenRuns() async {
        probe = FakeProbe([false, true]) // launch probe, then post-install
        let model = makeModel()
        await model.evaluateOnLaunch()
        await model.consentToInstall()
        XCTAssertEqual(tokenStore.createCalls, 1)
        XCTAssertEqual(registrar.registerCalls, 1)
        XCTAssertEqual(marker.registeredCommit, "new")
        XCTAssertEqual(model.phase, .quiet)
        XCTAssertFalse(model.didReregisterForUpdate, "fresh install is not a drift update")
    }

    func testExistingTokenIsNeverRecreated() async {
        tokenStore.exists = true
        probe = FakeProbe([false, true])
        let model = makeModel()
        await model.evaluateOnLaunch()
        await model.consentToInstall()
        XCTAssertEqual(tokenStore.createCalls, 0)
        XCTAssertEqual(registrar.registerCalls, 1)
    }

    func testTokenFailureAbortsBeforeRegistration() async {
        tokenStore.createError = TestError()
        let model = makeModel()
        await model.evaluateOnLaunch()
        await model.consentToInstall()
        guard case .failed(let message) = model.phase else {
            return XCTFail("expected failed, got \(model.phase)")
        }
        XCTAssertTrue(message.contains("Keychain"))
        XCTAssertEqual(registrar.registerCalls, 0)
        XCTAssertNil(marker.registeredCommit)
    }

    func testRegisterFailureSurfacesAndKeepsMarkerClear() async {
        registrar.registerError = TestError()
        let model = makeModel()
        await model.evaluateOnLaunch()
        await model.consentToInstall()
        guard case .failed = model.phase else {
            return XCTFail("expected failed, got \(model.phase)")
        }
        XCTAssertNil(marker.registeredCommit)
    }

    func testRegisterLandingInRequiresApproval() async {
        registrar.statusAfterRegister = .requiresApproval
        let model = makeModel()
        await model.evaluateOnLaunch()
        await model.consentToInstall()
        XCTAssertEqual(model.phase, .awaitingApproval)
        XCTAssertEqual(marker.registeredCommit, "new")
    }

    func testInstalledButSlowDaemonLandsInStartingUp() async {
        probe = FakeProbe([false]) // never comes up
        let model = makeModel()
        await model.evaluateOnLaunch()
        await model.consentToInstall()
        XCTAssertEqual(model.phase, .startingUp)
    }

    func testDeclineLeavesClearStateAndRetryReoffersConsent() async {
        let model = makeModel()
        await model.evaluateOnLaunch()
        model.decline()
        XCTAssertEqual(model.phase, .declined)
        XCTAssertEqual(registrar.registerCalls, 0)
        await model.retry()
        XCTAssertEqual(model.phase, .consentNeeded, "retry re-evaluates, never auto-installs")
    }

    // Drift

    func testDriftReregistersReplacesAndNotes() async {
        registrar.statusValue = .enabled
        marker.registeredCommit = "old"
        probe = FakeProbe([true]) // running old build; still drift
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(registrar.unregisterCalls, 1)
        XCTAssertEqual(registrar.registerCalls, 1)
        XCTAssertEqual(marker.registeredCommit, "new")
        XCTAssertTrue(model.didReregisterForUpdate)
        XCTAssertEqual(model.phase, .quiet)
    }

    func testNoDriftNoReregister() async {
        registrar.statusValue = .enabled
        marker.registeredCommit = "new"
        probe = FakeProbe([true])
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(registrar.unregisterCalls, 0)
        XCTAssertEqual(registrar.registerCalls, 0)
        XCTAssertFalse(model.didReregisterForUpdate)
    }

    // Stale-process verification + forced restart (2026-08-02 incident)

    func testStaleSurvivorAfterDriftReregisterGetsBootedOut() async {
        // The incident replay: upgrade drift triggers re-register, the BTM
        // layer no-ops, and the 0.3.13 process (which doesn't self-report a
        // commit) keeps answering. Verification must catch it and escalate
        // to the launchd bootout; only then does the NEW build start.
        registrar.statusValue = .enabled
        marker.registeredCommit = "old"
        probe = FakeProbe([true], runningCommit: nil)
        launchd.onBootOut = { [probe] in probe.runningCommit = "new" }
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.bootOutCalls, 1)
        XCTAssertEqual(registrar.unregisterCalls, 2, "drift replace, then the forced re-register")
        XCTAssertEqual(registrar.registerCalls, 2)
        XCTAssertEqual(marker.registeredCommit, "new")
        XCTAssertTrue(model.didReregisterForUpdate)
        XCTAssertFalse(model.keychainPromptCoachingActive, "same-signature update keeps its ACLs")
        XCTAssertEqual(model.phase, .quiet)
    }

    func testVerifiedReregisterNeverTouchesLaunchd() async {
        registrar.statusValue = .enabled
        marker.registeredCommit = "old"
        probe = FakeProbe([true], runningCommit: "new")
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.bootOutCalls, 0)
        XCTAssertEqual(registrar.registerCalls, 1)
        XCTAssertEqual(model.phase, .quiet)
    }

    func testQuietLaunchEvaluationMakesExactlyOneHealthRequest() async {
        // CodeRabbit PR #223: reachability and the staleness check must ride
        // ONE decoded /api/health answer — a second request could fail
        // independently and boot out a healthy daemon.
        registrar.statusValue = .enabled
        marker.registeredCommit = "new"
        probe = FakeProbe([true], runningCommit: "new")
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(model.phase, .quiet)
        XCTAssertEqual(probe.probeCalls, 1)
        XCTAssertEqual(launchd.bootOutCalls, 0)
    }

    func testStillStaleAfterForcedRestartFailsActionably() async {
        // The stale process survives even the bootout (or something else old
        // grabs the port): exactly ONE forced restart per session, then an
        // actionable failure — never a silent wrong-version steady state and
        // never a bootout/register loop against launchd.
        registrar.statusValue = .enabled
        marker.registeredCommit = "old"
        probe = FakeProbe([true], runningCommit: nil)
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.bootOutCalls, 1)
        XCTAssertEqual(model.phase, .failed(DaemonSetupModel.staleDaemonAfterRestartMessage))
    }

    func testLaunchTimeStaleDecisionForcesExactlyOneRestartWhenItDoesNotTake() async {
        // CodeRabbit PR #223: the decision-driven forced restart counts as
        // THE one attempt — its own verification must fail out, not grant a
        // second bootout/register cycle.
        registrar.statusValue = .enabled
        marker.registeredCommit = "new"
        probe = FakeProbe([true], runningCommit: "old") // stale, and stays stale
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.bootOutCalls, 1)
        XCTAssertEqual(registrar.unregisterCalls, 1)
        XCTAssertEqual(registrar.registerCalls, 1)
        XCTAssertEqual(model.phase, .failed(DaemonSetupModel.staleDaemonAfterRestartMessage))
    }

    func testStaleDaemonCaughtAtLaunchEvenWithCurrentMarker() async {
        // Post-incident safety net: if a forced restart failed in an earlier
        // session, the marker already matches the bundle — but the running
        // daemon still betrays itself at every launch evaluation.
        registrar.statusValue = .enabled
        marker.registeredCommit = "new"
        probe = FakeProbe([true], runningCommit: "old")
        launchd.onBootOut = { [probe] in probe.runningCommit = "new" }
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.bootOutCalls, 1)
        XCTAssertEqual(registrar.unregisterCalls, 1)
        XCTAssertEqual(registrar.registerCalls, 1)
        XCTAssertEqual(model.phase, .quiet)
    }

    // Wedged registration repair (enabled in SMAppService, absent in launchd)

    func testWedgedServiceRepairsAtLaunch() async {
        // Observed live: SMAppService .enabled, launchd domain empty, daemon
        // down. Plain register() would no-op; the repair goes through
        // bootout (a no-op there) + unregister + register.
        registrar.statusValue = .enabled
        marker.registeredCommit = "new"
        launchd.probeResult = .notFound
        probe = FakeProbe([false, true], runningCommit: "new")
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.bootOutCalls, 1)
        XCTAssertEqual(registrar.unregisterCalls, 1)
        XCTAssertEqual(registrar.registerCalls, 1)
        XCTAssertEqual(marker.registeredCommit, "new")
        XCTAssertEqual(model.phase, .quiet)
    }

    func testWedgedRepairLandingInRequiresApprovalRoutesToApproval() async {
        registrar.statusValue = .enabled
        registrar.statusAfterRegister = .requiresApproval
        marker.registeredCommit = "new"
        launchd.probeResult = .notFound
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(model.phase, .awaitingApproval)
        XCTAssertEqual(launchd.bootOutCalls, 1)
    }

    // Missing-binary repair (issue #185)

    /// The exact incident: same commit (no drift), port answering (launch
    /// says .running/.quiet) — but the daemon's own executable is gone.
    private func makeQuietRunningModel() async -> DaemonSetupModel {
        registrar.statusValue = .enabled
        marker.registeredCommit = "new"
        probe = FakeProbe([true])
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(model.phase, .quiet)
        return model
    }

    func testMissingBinaryRepairReregistersFromThisBundle() async {
        let model = await makeQuietRunningModel()
        let repaired = await model.repairMissingDaemonBinary()
        XCTAssertTrue(repaired)
        XCTAssertEqual(registrar.unregisterCalls, 1)
        XCTAssertEqual(registrar.registerCalls, 1)
        XCTAssertEqual(marker.registeredCommit, "new")
        XCTAssertTrue(model.didReregisterForUpdate, "the subtle service-updated note applies")
        XCTAssertEqual(model.phase, .quiet)
    }

    func testMissingBinaryRepairRunsOncePerSession() async {
        let model = await makeQuietRunningModel()
        let first = await model.repairMissingDaemonBinary()
        XCTAssertTrue(first)
        // A daemon that keeps reporting a missing binary (repair didn't
        // take) must never loop unregister/register against launchd.
        let second = await model.repairMissingDaemonBinary()
        XCTAssertFalse(second)
        XCTAssertEqual(registrar.unregisterCalls, 1)
        XCTAssertEqual(registrar.registerCalls, 1)
    }

    func testMissingBinaryRepairStandsDownInDevBuilds() async {
        probe = FakeProbe([true])
        let model = makeModel(bundledCommit: nil)
        await model.evaluateOnLaunch() // .quiet via bundledServiceUnavailable
        XCTAssertEqual(model.phase, .quiet)
        let repaired = await model.repairMissingDaemonBinary()
        XCTAssertFalse(repaired)
        XCTAssertEqual(registrar.unregisterCalls, 0)
        XCTAssertEqual(registrar.registerCalls, 0)
    }

    func testMissingBinaryRepairNeverRacesAnActiveSetupFlow() async {
        // First run: consent card up — a repair must not grab the registrar
        // out from under the visible flow.
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(model.phase, .consentNeeded)
        let repaired = await model.repairMissingDaemonBinary()
        XCTAssertFalse(repaired)
        XCTAssertEqual(registrar.unregisterCalls, 0)
        XCTAssertEqual(registrar.registerCalls, 0)
    }

    func testMissingBinaryRepairLandingInRequiresApprovalReportsNotRepaired() async {
        let model = await makeQuietRunningModel()
        registrar.statusAfterRegister = .requiresApproval
        let repaired = await model.repairMissingDaemonBinary()
        XCTAssertFalse(repaired)
        XCTAssertEqual(model.phase, .awaitingApproval, "the user gate surfaces; no silent success claim")
    }

    func testDriftReregisterLandingInRequiresApprovalRoutesToApprovalNotStartingUp() async {
        // The unregister/register round-trip can revoke Login Items
        // approval; the model must send the user to System Settings instead
        // of polling a daemon that isn't allowed to start.
        registrar.statusValue = .enabled
        registrar.statusAfterRegister = .requiresApproval
        marker.registeredCommit = "old"
        probe = FakeProbe([true])
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(model.phase, .awaitingApproval)
        XCTAssertEqual(registrar.unregisterCalls, 1)
        XCTAssertEqual(registrar.registerCalls, 1)
        XCTAssertEqual(marker.registeredCommit, "new")
        XCTAssertTrue(model.didReregisterForUpdate)
    }

    func testDriftReregisterThrowIntoRequiresApprovalAlsoRoutesToApproval() async {
        // register() may throw WHILE the status flips to requiresApproval —
        // same user gate, not a failure.
        registrar.statusValue = .enabled
        registrar.registerError = TestError()
        registrar.errorLeavesStatus = .requiresApproval
        marker.registeredCommit = "old"
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(model.phase, .awaitingApproval)
        XCTAssertEqual(marker.registeredCommit, "new")
        XCTAssertTrue(model.didReregisterForUpdate)
    }

    func testDriftRegisterFailureSurfaces() async {
        registrar.statusValue = .enabled
        marker.registeredCommit = "old"
        registrar.registerError = TestError()
        let model = makeModel()
        await model.evaluateOnLaunch()
        guard case .failed = model.phase else {
            return XCTFail("expected failed, got \(model.phase)")
        }
        XCTAssertEqual(marker.registeredCommit, "old", "marker only advances on success")
        XCTAssertFalse(model.didReregisterForUpdate)
    }

    // Coexistence with the legacy LaunchAgent

    func testLegacyPresentAndDownSurfacesWithoutInstalling() async {
        legacy.present = true
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(model.phase, .legacyNotRunning)
        XCTAssertTrue(model.legacyAgentPresent)
        XCTAssertEqual(registrar.registerCalls, 0, "never double-install over the legacy agent")
        XCTAssertEqual(legacy.removeCalls, 0, "never remove the legacy agent without an explicit action")
    }

    func testLegacyPresentAndRunningStaysQuietButFlagged() async {
        legacy.present = true
        probe = FakeProbe([true])
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(model.phase, .quiet)
        XCTAssertTrue(model.legacyAgentPresent, "Settings still offers the takeover")
        XCTAssertEqual(registrar.registerCalls, 0)
    }

    func testAdoptBundledServiceRemovesLegacyThenInstalls() async {
        legacy.present = true
        probe = FakeProbe([false, true])
        let model = makeModel()
        await model.evaluateOnLaunch()
        await model.adoptBundledService()
        XCTAssertEqual(legacy.removeCalls, 1)
        XCTAssertFalse(model.legacyAgentPresent)
        XCTAssertEqual(tokenStore.createCalls, 1)
        XCTAssertEqual(registrar.registerCalls, 1)
        XCTAssertEqual(marker.registeredCommit, "new")
        XCTAssertEqual(model.phase, .quiet)
    }

    func testAdoptFailureLeavesLegacyAndDoesNotRegister() async {
        legacy.present = true
        legacy.removeError = TestError()
        let model = makeModel()
        await model.evaluateOnLaunch()
        await model.adoptBundledService()
        guard case .failed = model.phase else {
            return XCTFail("expected failed, got \(model.phase)")
        }
        XCTAssertTrue(model.legacyAgentPresent)
        XCTAssertEqual(registrar.registerCalls, 0)
    }
}

// MARK: - Legacy takeover go/no-go (pure)

final class LegacyAgentRemovalTests: XCTestCase {
    func testLoadedServiceBlocksRemoval() {
        // `launchctl print` exits 0 when the service is still loaded — the
        // plist must survive and takeover must fail.
        XCTAssertFalse(LegacyAgentRemoval.serviceIsGone(printExitCode: 0))
    }

    func testAbsentServiceAllowsRemoval() {
        // Typical launchctl "could not find service" exits.
        XCTAssertTrue(LegacyAgentRemoval.serviceIsGone(printExitCode: 113))
        XCTAssertTrue(LegacyAgentRemoval.serviceIsGone(printExitCode: 1))
    }

    func testStillLoadedErrorNamesTheService() {
        let message = LegacyLaunchAgentInspector.RemovalError.stillLoaded.errorDescription ?? ""
        XCTAssertTrue(message.contains("ai.hermes.modeldeck"))
    }
}

// MARK: - Manifest decoding

final class DaemonBundleManifestTests: XCTestCase {
    func testDecodesWriterOutput() throws {
        // Shape from scripts/write-daemon-manifest.mjs.
        let json = Data("""
        {"artifact":"modeldeckd","nodeVersion":"v24.1.0","MDGitCommit":"abc123","sha256":"deadbeef"}
        """.utf8)
        let manifest = try JSONDecoder().decode(DaemonBundleManifest.self, from: json)
        XCTAssertEqual(manifest.MDGitCommit, "abc123")
        XCTAssertEqual(manifest.artifact, "modeldeckd")
    }

    func testNullCommitDecodes() throws {
        let json = Data(#"{"artifact":"modeldeckd","nodeVersion":"v24.1.0","MDGitCommit":null,"sha256":"d"}"#.utf8)
        let manifest = try JSONDecoder().decode(DaemonBundleManifest.self, from: json)
        XCTAssertNil(manifest.MDGitCommit)
    }
}

// MARK: - Keychain prompt coaching (issue #98)

@MainActor
final class KeychainPromptCoachingTests: XCTestCase {
    private var registrar = FakeRegistrar()
    private var tokenStore = FakeTokenStore()
    private var legacy = FakeLegacyAgent()
    private var marker = FakeMarker()
    private var probe = FakeProbe([false])
    private var launchd = FakeLaunchdControl()

    override func setUp() {
        super.setUp()
        registrar = FakeRegistrar()
        tokenStore = FakeTokenStore()
        legacy = FakeLegacyAgent()
        marker = FakeMarker()
        probe = FakeProbe([false])
        launchd = FakeLaunchdControl()
    }

    private func makeModel(bundledCommit: String? = "new") -> DaemonSetupModel {
        DaemonSetupModel(
            dependencies: .init(
                registrar: registrar,
                tokenStore: tokenStore,
                legacyAgent: legacy,
                marker: marker,
                probe: probe,
                launchdControl: launchd,
                bundledCommit: bundledCommit
            ),
            startupProbeAttempts: 3,
            startupProbeDelay: {}
        )
    }

    func testLaunchEvaluationNeverActivatesCoaching() async {
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(model.phase, .consentNeeded)
        XCTAssertFalse(model.keychainPromptCoachingActive,
                       "the consent card frames prompts in copy; coaching activates on install")
    }

    func testConsentToInstallActivatesCoaching() async {
        probe = FakeProbe([false, true])
        let model = makeModel()
        await model.evaluateOnLaunch()
        await model.consentToInstall()
        XCTAssertEqual(model.phase, .quiet)
        XCTAssertTrue(model.keychainPromptCoachingActive,
                      "a fresh registration means the daemon is not yet in the credential ACLs")
    }

    func testCoachingStaysActiveThroughApprovalWait() async {
        registrar.statusAfterRegister = .requiresApproval
        let model = makeModel()
        await model.evaluateOnLaunch()
        await model.consentToInstall()
        XCTAssertEqual(model.phase, .awaitingApproval)
        XCTAssertTrue(model.keychainPromptCoachingActive)

        // "Check Again" re-evaluates; the coaching must survive — the first
        // refresh (and its Keychain prompts) still hasn't happened.
        registrar.statusValue = .enabled
        marker.registeredCommit = "new"
        await model.retry()
        XCTAssertEqual(model.phase, .startingUp)
        XCTAssertTrue(model.keychainPromptCoachingActive)
    }

    func testLegacyTakeoverActivatesCoaching() async {
        legacy.present = true
        probe = FakeProbe([false, true])
        let model = makeModel()
        await model.adoptBundledService()
        XCTAssertEqual(model.phase, .quiet)
        XCTAssertTrue(model.keychainPromptCoachingActive)
    }

    func testDriftReregisterNeverActivatesCoaching() async {
        // A same-signature update keeps its Keychain ACL entries — coaching
        // there would cry wolf.
        registrar.statusValue = .enabled
        marker.registeredCommit = "old"
        probe = FakeProbe([false, true])
        let model = makeModel(bundledCommit: "new")
        await model.evaluateOnLaunch()
        XCTAssertTrue(model.didReregisterForUpdate)
        XCTAssertFalse(model.keychainPromptCoachingActive)
    }

    func testInstallFailureKeepsCoachingForTheRetry() async {
        tokenStore.createError = TestError()
        let model = makeModel()
        await model.evaluateOnLaunch()
        await model.consentToInstall()
        guard case .failed = model.phase else {
            return XCTFail("expected failed phase, got \(model.phase)")
        }
        XCTAssertTrue(model.keychainPromptCoachingActive)
    }

    func testCoachingCopyCarriesTheLoadBearingGuidance() {
        XCTAssertTrue(SystemPromptCoaching.keychainBody.contains("Always Allow"))
        XCTAssertTrue(SystemPromptCoaching.keychainBody.contains("one prompt per account"))
        XCTAssertTrue(SystemPromptCoaching.keychainBody.contains("from macOS itself"))
        XCTAssertTrue(SystemPromptCoaching.keychainBody.contains("won't re-prompt"))
        XCTAssertTrue(SystemPromptCoaching.loginItemsConsentNote.contains("macOS, not ModelDeck"))
    }
}
