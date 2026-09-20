import XCTest
@testable import ModelDeckMacCore

// Issue #697: at login the app and the background service start together,
// and a service opening a large database can take tens of seconds to listen.
// The launch evaluation used to park on "Background service starting…" after
// ONE refused probe and never look again; only Check Again cleared it.

private final class SlowRegistrar: DaemonServiceRegistrar, @unchecked Sendable {
    var status: ServiceRegistrationStatus = .enabled
    var registerCalls = 0
    func register() throws { registerCalls += 1 }
    func unregister() throws {}
}

private final class SlowTokenStore: MutationTokenStore, @unchecked Sendable {
    func tokenExists() throws -> Bool { true }
    func createToken() throws {}
}

private final class SlowLegacyAgent: LegacyAgentInspecting, @unchecked Sendable {
    func isLegacyAgentPresent() -> Bool { false }
    func removeLegacyAgent() throws {}
}

private final class SlowMarker: RegistrationMarkerStore, @unchecked Sendable {
    var registeredCommit: String? = "new"
    var registeredPlistFingerprint: String? = "plist-v1"
}

/// Refuses every probe until `answersAtCall`, then answers as `runningCommit`.
private final class SlowProbe: DaemonReachabilityProbing, @unchecked Sendable {
    var answersAtCall: Int
    var runningCommit: String? = "new"
    var probeCalls = 0
    /// nil = the default `probeDaemon()`; a value = `probeDaemon(timeout:)`.
    var timeoutsSeen: [TimeInterval?] = []
    init(answersAtCall: Int) { self.answersAtCall = answersAtCall }
    func probeDaemon() async -> DaemonProbeSnapshot? {
        timeoutsSeen.append(nil)
        return answer()
    }
    func probeDaemon(timeout: TimeInterval) async -> DaemonProbeSnapshot? {
        timeoutsSeen.append(timeout)
        return answer()
    }
    private func answer() -> DaemonProbeSnapshot? {
        probeCalls += 1
        return probeCalls >= answersAtCall ? DaemonProbeSnapshot(runningCommit: runningCommit) : nil
    }
}

private final class SlowLaunchdControl: LaunchdServiceControlling, @unchecked Sendable {
    var restartCalls = 0
    var bootOutCalls = 0
    var onBootOut: (() -> Void)?
    /// Runs on the main actor while the bootout is suspended, so a test
    /// can deliver a concurrent callback mid-restart.
    var duringBootOut: (@MainActor () async -> Void)?
    func probeService() async -> LaunchdServiceProbe { .loaded }
    func restartService() async { restartCalls += 1 }
    func bootOutService() async {
        bootOutCalls += 1
        if let duringBootOut { await duringBootOut() }
        onBootOut?()
    }
}

private final class SlowBundledDaemon: BundledDaemonVerifying, @unchecked Sendable {
    func verifyBundledDaemon() async -> BundledDaemonVerification { .valid }
}

@MainActor
final class Issue697LaunchWaitTests: XCTestCase {
    private var probe = SlowProbe(answersAtCall: 4)
    private var launchd = SlowLaunchdControl()
    private var registrar = SlowRegistrar()

    override func setUp() {
        super.setUp()
        probe = SlowProbe(answersAtCall: 4)
        launchd = SlowLaunchdControl()
        registrar = SlowRegistrar()
    }

    private func makeModel(launchProbeAttempts: Int = 6) -> DaemonSetupModel {
        DaemonSetupModel(
            dependencies: .init(
                registrar: registrar,
                tokenStore: SlowTokenStore(),
                legacyAgent: SlowLegacyAgent(),
                marker: SlowMarker(),
                probe: probe,
                launchdControl: launchd,
                bundledDaemon: SlowBundledDaemon(),
                bundledCommit: "new",
                bundledPlistFingerprint: "plist-v1",
                hostSignatureAllowsServiceManagement: true
            ),
            startupProbeAttempts: 2,
            launchProbeAttempts: launchProbeAttempts,
            startupProbeDelay: {}
        )
    }

    func testAServiceThatListensLateClearsTheCardWithoutAClick() async {
        // TRIPWIRE #697: registration enabled, marker current, the service
        // answers on the fourth probe. The evaluation must keep asking and
        // end verified-up, so the launch follow-up read fills the deck.
        let model = makeModel()
        let verifiedUp = await model.evaluateOnLaunch()
        XCTAssertTrue(verifiedUp, "TRIPWIRE #697: a late-listening service was reported as not up")
        XCTAssertEqual(model.phase, .quiet, "TRIPWIRE #697: the card stayed on 'Background service starting…'")
        XCTAssertEqual(probe.probeCalls, 4)
        XCTAssertEqual(launchd.restartCalls, 0, "a slow start is not a repair case")
        XCTAssertEqual(launchd.bootOutCalls, 0)
    }

    func testTheLaunchWaitIsBoundedAndLeavesCheckAgain() async {
        // Nothing answers inside the launch budget: the card and its
        // Check Again stay, exactly as before, and nothing escalates.
        probe = SlowProbe(answersAtCall: .max)
        let model = makeModel(launchProbeAttempts: 5)
        let verifiedUp = await model.evaluateOnLaunch()
        XCTAssertFalse(verifiedUp)
        XCTAssertEqual(model.phase, .startingUp)
        XCTAssertEqual(probe.probeCalls, 6, "one launch probe plus the five-attempt wait")
        XCTAssertEqual(launchd.bootOutCalls, 0)
    }

    func testTheLaunchWaitOutlastsTheInstallWait() async {
        // The launch budget is its own knob: a service that answers after
        // the short post-install budget but inside the launch one still
        // clears the card at launch.
        probe = SlowProbe(answersAtCall: 5)
        let model = makeModel(launchProbeAttempts: 6)
        let verifiedUp = await model.evaluateOnLaunch()
        XCTAssertTrue(verifiedUp)
        XCTAssertEqual(model.phase, .quiet)
    }

    func testALateAnswerFromAnotherBuildGetsTheSameForcedRestartAsAnImmediateOne() async {
        // CodeRabbit (PR #698): the late answer must be checked like an
        // immediate one. A process reporting an older build than the bundle
        // is the stale-daemon case, so the launch wait must not report it
        // as verified-up; it gets the one forced restart, after which the
        // relaunched process answers as the bundled build.
        probe = SlowProbe(answersAtCall: 3)
        probe.runningCommit = "old"
        launchd.onBootOut = { [probe] in probe.runningCommit = "new" }
        let model = makeModel()
        let verifiedUp = await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.bootOutCalls, 1, "a late stale answer was accepted without the forced restart")
        XCTAssertEqual(registrar.registerCalls, 1)
        XCTAssertTrue(verifiedUp)
        XCTAssertEqual(model.phase, .quiet)
    }

    func testALateStaleAnswerThatSurvivesTheRestartFailsActionably() async {
        // Same guard as the immediate path: exactly one forced restart,
        // then the actionable failure, never a bootout loop.
        probe = SlowProbe(answersAtCall: 3)
        probe.runningCommit = "old"
        let model = makeModel()
        let verifiedUp = await model.evaluateOnLaunch()
        XCTAssertFalse(verifiedUp)
        XCTAssertEqual(launchd.bootOutCalls, 1)
        XCTAssertEqual(model.phase, .failed(DaemonSetupModel.staleDaemonAfterRestartMessage))
    }

    func testAMissingBinaryReportDuringTheLateStaleRestartDoesNotRegisterTwice() async {
        // Astra review of PR #698, round 2: the wait's answer set `.quiet`,
        // and the #185 repair is guarded on exactly that phase. The first
        // state read runs alongside the launch evaluation, so its
        // missing-binary callback can land while the forced restart is
        // suspended in the bootout. It must be refused; one registration
        // cycle, not two.
        probe = SlowProbe(answersAtCall: 3)
        probe.runningCommit = "old"
        var repairAccepted: Bool?
        var registrationsDuringBootOut = 0
        let model = makeModel()
        launchd.duringBootOut = { [registrar] in
            repairAccepted = await model.repairMissingDaemonBinary()
            registrationsDuringBootOut = registrar.registerCalls
        }
        launchd.onBootOut = { [probe] in probe.runningCommit = "new" }
        let verifiedUp = await model.evaluateOnLaunch()
        XCTAssertEqual(repairAccepted, false,
                       "TRIPWIRE #697: the missing-binary repair ran during the forced restart")
        XCTAssertEqual(registrationsDuringBootOut, 0)
        XCTAssertEqual(registrar.registerCalls, 1, "exactly one registration cycle")
        XCTAssertTrue(verifiedUp)
        XCTAssertEqual(model.phase, .quiet)
    }

    func testTheDefaultLaunchBudgetCoversAMinute() {
        // 120 × 0.5 s ≈ 60 s against a refused connection; the live boot
        // that filed the issue measured ~35 s before the service listened.
        XCTAssertEqual(DaemonSetupModel.defaultLaunchProbeAttempts, 120)
    }

    func testTheLaunchWaitProbesUnderTheShortTimeout() async {
        // Astra review of PR #698: the attempt budget is only a time budget
        // if each probe fails fast. The launch probe itself keeps the
        // default; every wait probe runs under the 1 s restart timeout, so
        // a port that accepts but does not answer costs ≤ 3 min, not 11.
        probe = SlowProbe(answersAtCall: .max)
        let model = makeModel(launchProbeAttempts: 3)
        _ = await model.evaluateOnLaunch()
        XCTAssertEqual(probe.timeoutsSeen, [nil, 1, 1, 1],
                       "TRIPWIRE #697: a launch wait probe ran under the 5 s default timeout")
        XCTAssertEqual(DaemonSetupModel.restartProbeTimeout, 1)
    }
}
