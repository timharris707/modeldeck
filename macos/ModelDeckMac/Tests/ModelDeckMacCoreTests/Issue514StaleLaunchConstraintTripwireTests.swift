import XCTest
@testable import ModelDeckMacCore

// Issue #514 — TRIPWIRE (CLAUDE.md never-compromise #4). Incident
// 2026-08-18, immediately after the 1.0.2 → 1.0.3 update on Tim's machine:
// the update replaced Contents/Resources/daemon/modeldeckd, but launchd kept
// enforcing the launch constraint captured from the OLD binary, so every
// spawn of the new (validly signed, hand-runnable) one failed before exec —
// `state = spawn failed`, `last exit code = 78` (EX_CONFIG), properties
// carrying `needs LWCR update`.
//
// What made it a wedge rather than a hiccup: `launchctl print` exits 0 for
// that job, so the probe read `.loaded`, the drift re-register "succeeded",
// the app announced "Background service updated to match this app version",
// and Check Again re-ran the exact same no-op forever. Recovery needed
// `launchctl bootout` from a terminal.
//
// These tests fail if that state ever reads as healthy again: at the pure
// launchctl-record classifier, at the pure decision, and at every model path
// the user can reach — including the Check Again escalation. They also fail
// if the repair ever fires WITHOUT the bundled binary verifying, which is
// the property that keeps it a registration repair and not a way to
// re-stamp a launch constraint from a binary nobody checked.

// MARK: - Fixtures

/// The shape `launchctl print gui/<uid>/ai.hermes.modeldeck` produced during
/// the live diagnosis. Paths are the ordinary install locations; no identity
/// or credential material appears in this record.
private let wedgedJobRecord = """
ai.hermes.modeldeck = {
\tactive count = 0
\tpath = /Applications/ModelDeck.app/Contents/Library/LaunchAgents/ai.hermes.modeldeck.plist
\tstate = spawn failed
\tprogram = /Applications/ModelDeck.app/Contents/Resources/daemon/modeldeckd
\tlast exit code = 78
\tproperties = keepalive | runatload | inferred program | needs LWCR update
}
"""

private let healthyJobRecord = """
ai.hermes.modeldeck = {
\tactive count = 1
\tpath = /Applications/ModelDeck.app/Contents/Library/LaunchAgents/ai.hermes.modeldeck.plist
\tstate = running
\tpid = 4242
\tprogram = /Applications/ModelDeck.app/Contents/Resources/daemon/modeldeckd
\tlast exit code = 0
\tproperties = keepalive | runatload | inferred program
}
"""

// MARK: - Fakes

private final class WedgeRegistrar: DaemonServiceRegistrar, @unchecked Sendable {
    var statusValue: ServiceRegistrationStatus = .enabled
    var statusAfterRegister: ServiceRegistrationStatus = .enabled
    var registerCalls = 0
    var unregisterCalls = 0
    var status: ServiceRegistrationStatus { statusValue }
    func register() throws {
        registerCalls += 1
        statusValue = statusAfterRegister
    }
    func unregister() throws {
        unregisterCalls += 1
        statusValue = .notRegistered
    }
}

private final class WedgeTokenStore: MutationTokenStore, @unchecked Sendable {
    func tokenExists() throws -> Bool { true }
    func createToken() throws {}
}

private final class WedgeLegacyAgent: LegacyAgentInspecting, @unchecked Sendable {
    func isLegacyAgentPresent() -> Bool { false }
    func removeLegacyAgent() throws {}
}

private final class WedgeMarker: RegistrationMarkerStore, @unchecked Sendable {
    var registeredCommit: String?
    var registeredPlistFingerprint: String?
}

/// Reachability, as the wedge produces it: nothing answers until a bootout
/// actually clears the job record.
private final class WedgeProbe: DaemonReachabilityProbing, @unchecked Sendable {
    var runningCommit: String?
    var reachable = false
    var probeCalls = 0
    func probeDaemon() async -> DaemonProbeSnapshot? {
        probeCalls += 1
        return reachable ? DaemonProbeSnapshot(runningCommit: runningCommit) : nil
    }
}

private final class WedgeLaunchdControl: LaunchdServiceControlling, @unchecked Sendable {
    /// Consumed front-to-first; the last value repeats — so a probe can
    /// report `.loaded` before the first spawn attempt and `.spawnFailed`
    /// after it, which is the ordering the post-update launch really sees.
    var probeResults: [LaunchdServiceProbe] = [.spawnFailed]
    var bootOutCalls = 0
    var onBootOut: (() -> Void)?
    func probeService() async -> LaunchdServiceProbe {
        if probeResults.count > 1 { return probeResults.removeFirst() }
        return probeResults.first ?? .unknown
    }
    func bootOutService() async {
        bootOutCalls += 1
        probeResults = [.notFound]
        onBootOut?()
    }
    /// Issue #678: a kickstart against a spawn-rejected job changes nothing
    /// (launchd still refuses to exec the binary) — which is exactly why the
    /// #514 repair must outrank the drift restart.
    var restartCalls = 0
    func restartService() async { restartCalls += 1 }
}

private final class WedgeBundledDaemon: BundledDaemonVerifying, @unchecked Sendable {
    var verification: BundledDaemonVerification = .valid
    var verifyCalls = 0
    func verifyBundledDaemon() async -> BundledDaemonVerification {
        verifyCalls += 1
        return verification
    }
}

// MARK: - Pure classifier: the wedge is invisible in the exit code

final class Issue514LaunchctlRecordTests: XCTestCase {
    func testLiveIncidentRecordReadsAsSpawnFailed() {
        // TRIPWIRE: `launchctl print` exits 0 for a job launchd will never
        // spawn. If this ever classifies as .loaded again, the deck goes
        // back to "Background service starting…" forever.
        XCTAssertEqual(
            classifyLaunchctlPrint(exitCode: 0, output: wedgedJobRecord),
            .spawnFailed,
            "TRIPWIRE #514: the stale-launch-constraint job record classified as healthy"
        )
    }

    func testHealthyRecordStaysLoaded() {
        XCTAssertEqual(classifyLaunchctlPrint(exitCode: 0, output: healthyJobRecord), .loaded)
    }

    func testWhitespaceAndCaseAreNotAContract() {
        let squashed = wedgedJobRecord
            .replacingOccurrences(of: "state = spawn failed", with: "STATE   =    Spawn Failed")
        XCTAssertEqual(classifyLaunchctlPrint(exitCode: 0, output: squashed), .spawnFailed)
    }

    func testSpawnFailureWithoutAConfigRejectionIsNotOurs() {
        // A spawn failure with some other exit code is not the stale-
        // constraint state, and a re-registration would not fix it.
        let other = wedgedJobRecord
            .replacingOccurrences(of: "last exit code = 78", with: "last exit code = 1")
            .replacingOccurrences(of: " | needs LWCR update", with: "")
        XCTAssertEqual(classifyLaunchctlPrint(exitCode: 0, output: other), .loaded)
    }

    func testEitherConfigRejectionSignalSuffices() {
        // launchd names the cause two ways; the repair keys on both.
        let lwcrOnly = wedgedJobRecord
            .replacingOccurrences(of: "last exit code = 78", with: "last exit code = 0")
        XCTAssertEqual(classifyLaunchctlPrint(exitCode: 0, output: lwcrOnly), .spawnFailed)
        let exitOnly = wedgedJobRecord
            .replacingOccurrences(of: " | needs LWCR update", with: "")
        XCTAssertEqual(classifyLaunchctlPrint(exitCode: 0, output: exitOnly), .spawnFailed)
    }

    func testNonZeroExitsKeepTheirOldMeaning() {
        // Absence and probe failure outrank the record text: a service that
        // could not be found has no record to trust (CodeRabbit, PR #223).
        XCTAssertEqual(classifyLaunchctlPrint(exitCode: 113, output: wedgedJobRecord), .notFound)
        XCTAssertEqual(classifyLaunchctlPrint(exitCode: 127, output: wedgedJobRecord), .unknown)
        XCTAssertEqual(classifyLaunchctlPrint(exitCode: 1, output: ""), .unknown)
    }
}

// MARK: - Pure decision

final class Issue514DecisionTripwireTests: XCTestCase {
    private func decide(
        reachable: Bool = false,
        runningCommit: String? = nil,
        registration: ServiceRegistrationStatus = .enabled,
        launchdService: LaunchdServiceProbe = .spawnFailed,
        recordedCommit: String? = "new",
        bundledDaemon: BundledDaemonVerification = .valid
    ) -> DaemonSetupDecision {
        decideDaemonSetup(
            hostSignatureAllowsServiceManagement: true,
            probe: reachable ? DaemonProbeSnapshot(runningCommit: runningCommit) : nil,
            registration: registration,
            launchdService: launchdService,
            legacyPresent: false,
            recordedCommit: recordedCommit,
            bundledCommit: "new",
            bundledDaemon: bundledDaemon
        )
    }

    /// The acceptance criterion: registration present, job spawn-rejected,
    /// bundled binary verifies → re-register, never "everything matches".
    func testSpawnRejectedJobWithAVerifiedBinaryRepairs() {
        XCTAssertEqual(
            decide(),
            .staleLaunchConstraintRepair(bundled: "new"),
            "TRIPWIRE #514: a registration launchd refuses to spawn read as a healthy registration"
        )
    }

    func testSpawnRejectionOutranksDrift() {
        // The post-update shape: the commit moved AND the job is wedged. The
        // plain drift re-register is exactly what failed to recover the
        // incident, so the repair must win.
        XCTAssertEqual(
            decide(recordedCommit: "old"),
            .staleLaunchConstraintRepair(bundled: "new")
        )
    }

    func testUnverifiedBundledBinaryNeverRepairs() {
        // The repair re-stamps the launch constraint from the bundled
        // binary. A binary that fails its own signature/DR check, or one we
        // could not check at all, must not trigger the stale-launch-constraint
        // repair. Independent commit drift retains its existing
        // re-registration behavior.
        XCTAssertEqual(decide(bundledDaemon: .invalid), .registeredNotRunning)
        XCTAssertEqual(decide(bundledDaemon: .unavailable), .registeredNotRunning)
        XCTAssertEqual(
            decide(recordedCommit: "old", bundledDaemon: .invalid),
            .driftRestart(recorded: "old", bundled: "new")
        )
    }

    func testNeverRepairsWhileSomethingAnswers() {
        // A hand-started dev daemon holding the port gets the same courtesy
        // as the .notFound wedge rule.
        XCTAssertEqual(decide(reachable: true, runningCommit: "new"), .running)
    }

    func testUnregisteredServiceIsNeverRepaired() {
        XCTAssertEqual(
            decide(registration: .notRegistered, recordedCommit: nil),
            .needsConsent
        )
    }

    func testUntrustedHostStillStandsDown() {
        // Issue #486 outranks this repair too: an ad-hoc dev build must not
        // "fix" the production registration by stamping its own signature.
        XCTAssertEqual(
            decideDaemonSetup(
                hostSignatureAllowsServiceManagement: false,
                probe: nil, registration: .enabled, launchdService: .spawnFailed,
                legacyPresent: false, recordedCommit: "new", bundledCommit: "new",
                bundledDaemon: .valid
            ),
            .hostSignatureStandDown
        )
    }
}

// MARK: - Model: the repair, and Check Again reaching it

@MainActor
final class Issue514RepairTripwireTests: XCTestCase {
    private var registrar = WedgeRegistrar()
    private var marker = WedgeMarker()
    private var probe = WedgeProbe()
    private var launchd = WedgeLaunchdControl()
    private var bundledDaemon = WedgeBundledDaemon()

    override func setUp() {
        super.setUp()
        registrar = WedgeRegistrar()
        marker = WedgeMarker()
        probe = WedgeProbe()
        launchd = WedgeLaunchdControl()
        bundledDaemon = WedgeBundledDaemon()
    }

    private func makeModel() -> DaemonSetupModel {
        DaemonSetupModel(
            dependencies: .init(
                registrar: registrar,
                tokenStore: WedgeTokenStore(),
                legacyAgent: WedgeLegacyAgent(),
                marker: marker,
                probe: probe,
                launchdControl: launchd,
                bundledDaemon: bundledDaemon,
                bundledCommit: "new",
                hostSignatureAllowsServiceManagement: true
            ),
            startupProbeAttempts: 2,
            startupProbeDelay: {}
        )
    }

    /// The bootout is what actually clears the stale job record; model its
    /// real effect so a repaired service can come up.
    private func bootoutHealsTheService() {
        launchd.onBootOut = { [probe] in
            probe.reachable = true
            probe.runningCommit = "new"
        }
    }

    func testPostUpdateLaunchRepairsInsteadOfClaimingItMatches() async {
        // The incident's first launch: commit drift AND a job wedged on the
        // old binary's constraint.
        marker.registeredCommit = "old"
        launchd.probeResults = [.spawnFailed]
        bootoutHealsTheService()
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.bootOutCalls, 1, "TRIPWIRE #514: the wedged job was never booted out")
        XCTAssertEqual(registrar.unregisterCalls, 1)
        XCTAssertEqual(registrar.registerCalls, 1)
        XCTAssertEqual(marker.registeredCommit, "new")
        XCTAssertEqual(model.phase, .quiet)
    }

    /// Acceptance criterion 2: Check Again escalates to the repair path.
    /// `retry()` is exactly what the "Check Again" buttons in
    /// DaemonSetupViews (startingUp + awaitingApproval) invoke.
    func testCheckAgainEscalatesToTheStaleConstraintRepair() async {
        // The state the user was stranded in: registration enabled, marker
        // already advanced by the drift re-register, service spawn-rejected.
        marker.registeredCommit = "new"
        launchd.probeResults = [.spawnFailed]
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(model.phase, .startingUp, "nothing answers until the record is cleared")
        XCTAssertEqual(launchd.bootOutCalls, 1)

        // Second press, after the repair took: the service comes up.
        launchd.probeResults = [.spawnFailed]
        bootoutHealsTheService()
        await model.retry()
        XCTAssertEqual(launchd.bootOutCalls, 2,
                       "TRIPWIRE #514: Check Again re-ran the no-op instead of the repair")
        XCTAssertEqual(model.phase, .quiet)
    }

    func testReregisterThatLeavesTheJobSpawnRejectedEscalatesOnceInTheSameLaunch() async {
        // Timing variant: at evaluation the job had not yet tried to spawn
        // (`.loaded`), so drift ran its restart (#678), nothing answered,
        // the fallback re-register ran — and the service still cannot start.
        // The verification tail must ask launchd again rather than parking
        // on "starting…" under the "service updated" notice, and must do so
        // exactly once.
        marker.registeredCommit = "old"
        launchd.probeResults = [.loaded, .spawnFailed]
        bootoutHealsTheService()
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.restartCalls, 1)
        XCTAssertEqual(launchd.bootOutCalls, 1)
        XCTAssertEqual(registrar.unregisterCalls, 2, "drift replace, then the forced repair")
        XCTAssertEqual(registrar.registerCalls, 2)
        XCTAssertEqual(model.phase, .quiet)
    }

    func testAStillDeadServiceNeverLoopsBootouts() async {
        // The repair didn't take (nothing ever answers): one kickstart, one
        // bootout, then the visible starting-up state with its retry
        // affordance.
        marker.registeredCommit = "old"
        launchd.probeResults = [.loaded, .spawnFailed]
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.restartCalls, 1)
        XCTAssertEqual(launchd.bootOutCalls, 1)
        XCTAssertEqual(model.phase, .startingUp)
    }

    func testUnverifiedBundledBinaryNeverReachesLaunchd() async {
        // TRIPWIRE: the repair's security gate, at the model boundary.
        marker.registeredCommit = "new"
        launchd.probeResults = [.spawnFailed]
        bundledDaemon.verification = .invalid
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(launchd.bootOutCalls, 0,
                       "TRIPWIRE #514: a bootout/re-register ran for a daemon binary that failed verification")
        XCTAssertEqual(registrar.unregisterCalls, 0)
        XCTAssertEqual(registrar.registerCalls, 0)
        XCTAssertEqual(model.phase, .startingUp)
    }

    func testHealthyLaunchNeverHashesTheBundledBinary() async {
        // The verification is a whole-binary hash: it must stay on the
        // spawn-rejected path and never join the ordinary launch.
        marker.registeredCommit = "new"
        launchd.probeResults = [.loaded]
        probe.reachable = true
        probe.runningCommit = "new"
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(model.phase, .quiet)
        XCTAssertEqual(bundledDaemon.verifyCalls, 0)
        XCTAssertEqual(launchd.bootOutCalls, 0)
    }
}
