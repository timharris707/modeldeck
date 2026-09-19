import XCTest
@testable import ModelDeckMacCore

// Issue #486 — TRIPWIRE (CLAUDE.md never-compromise #4). Incident 2026-08-17:
// an ad-hoc-signed dev bundle (build_app.sh) launched for README screenshots
// decided the live registration was "an older build" and re-registered
// ai.hermes.modeldeck, stamping a launch constraint derived from the DEV
// signature — launchd then SIGKILLed the production daemon ("Launch
// Constraint Violation", CODESIGNING exit 78) on every spawn.
//
// These tests fail if a build not signed like the production app can reach
// the service-(re)registration path again — at the pure decision, at every
// registrar-touching model path, and at the live signature classifier.

// MARK: - Fakes (registration attempts are the tripwire signal)

private final class TripwireRegistrar: DaemonServiceRegistrar, @unchecked Sendable {
    var statusValue: ServiceRegistrationStatus = .enabled
    var registerCalls = 0
    var unregisterCalls = 0
    var status: ServiceRegistrationStatus { statusValue }
    func register() throws { registerCalls += 1 }
    func unregister() throws { unregisterCalls += 1 }
}

private final class TripwireTokenStore: MutationTokenStore, @unchecked Sendable {
    var createCalls = 0
    func tokenExists() throws -> Bool { false }
    func createToken() throws { createCalls += 1 }
}

private final class TripwireLegacyAgent: LegacyAgentInspecting, @unchecked Sendable {
    var present = false
    var removeCalls = 0
    func isLegacyAgentPresent() -> Bool { present }
    func removeLegacyAgent() throws { removeCalls += 1; present = false }
}

private final class TripwireMarker: RegistrationMarkerStore, @unchecked Sendable {
    var registeredCommit: String?
    var registeredPlistFingerprint: String?
}

private final class TripwireProbe: DaemonReachabilityProbing, @unchecked Sendable {
    var snapshot: DaemonProbeSnapshot?
    init(_ snapshot: DaemonProbeSnapshot? = nil) { self.snapshot = snapshot }
    func probeDaemon() async -> DaemonProbeSnapshot? { snapshot }
}

private final class TripwireLaunchdControl: LaunchdServiceControlling, @unchecked Sendable {
    var probeResult: LaunchdServiceProbe = .loaded
    var bootOutCalls = 0
    var restartCalls = 0
    func probeService() async -> LaunchdServiceProbe { probeResult }
    func bootOutService() async { bootOutCalls += 1 }
    func restartService() async { restartCalls += 1 }
}

/// A perfectly verified bundled daemon — the #514 repair's precondition, so
/// the untrusted-host stand-down is proved against the MOST tempting inputs.
private final class TripwireBundledDaemon: BundledDaemonVerifying, @unchecked Sendable {
    func verifyBundledDaemon() async -> BundledDaemonVerification { .valid }
}

// MARK: - Pure decision: untrusted signature outranks everything

final class Issue486DecisionTripwireTests: XCTestCase {
    private func decide(
        probe: DaemonProbeSnapshot?,
        registration: ServiceRegistrationStatus,
        launchdService: LaunchdServiceProbe = .loaded,
        recordedCommit: String? = "old"
    ) -> DaemonSetupDecision {
        decideDaemonSetup(
            hostSignatureAllowsServiceManagement: false,
            probe: probe, registration: registration,
            launchdService: launchdService, legacyPresent: false,
            recordedCommit: recordedCommit, bundledCommit: "new",
            bundledDaemon: .valid
        )
    }

    func testDriftNeverReregistersFromUntrustedHost() {
        // The EXACT incident inputs: enabled registration, recorded commit
        // differing from the (accidentally staged) dev bundle's manifest.
        XCTAssertEqual(
            decide(probe: DaemonProbeSnapshot(runningCommit: "prod"), registration: .enabled),
            .hostSignatureStandDown,
            "issue #486: an untrusted build re-registering here launch-constrains the production daemon to the dev signature"
        )
    }

    func testStaleAndWedgeRepairsStandDownFromUntrustedHost() {
        XCTAssertEqual(
            decide(probe: DaemonProbeSnapshot(runningCommit: "other"), registration: .enabled,
                   recordedCommit: "new"),
            .hostSignatureStandDown
        )
        XCTAssertEqual(
            decide(probe: nil, registration: .enabled, launchdService: .notFound,
                   recordedCommit: "new"),
            .hostSignatureStandDown
        )
    }

    func testFirstRunConsentNeverOffersFromUntrustedHost() {
        XCTAssertEqual(decide(probe: nil, registration: .notRegistered, recordedCommit: nil),
                       .hostSignatureStandDown)
    }
}

// MARK: - Model: no registrar mutation is reachable from an untrusted host

@MainActor
final class Issue486ModelTripwireTests: XCTestCase {
    private var registrar = TripwireRegistrar()
    private var tokenStore = TripwireTokenStore()
    private var legacy = TripwireLegacyAgent()
    private var marker = TripwireMarker()
    private var probe = TripwireProbe()
    private var launchd = TripwireLaunchdControl()

    override func setUp() {
        super.setUp()
        registrar = TripwireRegistrar()
        tokenStore = TripwireTokenStore()
        legacy = TripwireLegacyAgent()
        marker = TripwireMarker()
        probe = TripwireProbe()
        launchd = TripwireLaunchdControl()
    }

    private func makeModel() -> DaemonSetupModel {
        DaemonSetupModel(
            dependencies: .init(
                registrar: registrar,
                tokenStore: tokenStore,
                legacyAgent: legacy,
                marker: marker,
                probe: probe,
                launchdControl: launchd,
                bundledDaemon: TripwireBundledDaemon(),
                bundledCommit: "new",
                hostSignatureAllowsServiceManagement: false
            ),
            startupProbeAttempts: 1,
            startupProbeDelay: {}
        )
    }

    /// The registrar/launchctl seams must be untouched, and the marker must
    /// keep whatever the production app recorded.
    private func assertNothingManaged(_ marker: String? = "old",
                                      file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(registrar.registerCalls, 0, "TRIPWIRE #486: register() reached from an untrusted build", file: file, line: line)
        XCTAssertEqual(registrar.unregisterCalls, 0, file: file, line: line)
        XCTAssertEqual(launchd.bootOutCalls, 0, file: file, line: line)
        XCTAssertEqual(launchd.restartCalls, 0, "TRIPWIRE #486/#678: kickstart reached from an untrusted build", file: file, line: line)
        XCTAssertEqual(tokenStore.createCalls, 0, file: file, line: line)
        XCTAssertEqual(self.marker.registeredCommit, marker, file: file, line: line)
    }

    func testIncidentShapeLaunchEvaluationStaysQuiet() async {
        // The incident: drift conditions from a dev bundle with a staged
        // daemon. Must stay quiet, never show the "updated" notice.
        marker.registeredCommit = "old"
        probe.snapshot = DaemonProbeSnapshot(runningCommit: "prod")
        let model = makeModel()
        await model.evaluateOnLaunch()
        XCTAssertEqual(model.phase, .quiet)
        XCTAssertFalse(model.didReregisterForUpdate)
        XCTAssertFalse(model.bundledServiceAvailable,
                       "the setup surface must hide entirely, like a manifest-less dev build")
        assertNothingManaged()
    }

    func testConsentAdoptAndRepairPathsAreDead() async {
        marker.registeredCommit = "old"
        legacy.present = true
        let model = makeModel()
        await model.consentToInstall()
        XCTAssertEqual(model.phase, .quiet)
        await model.adoptBundledService()
        XCTAssertEqual(model.phase, .quiet)
        XCTAssertEqual(legacy.removeCalls, 0,
                       "an untrusted build may not even remove the legacy agent en route to install")
        let repaired = await model.repairMissingDaemonBinary()
        XCTAssertFalse(repaired)
        assertNothingManaged()
    }
}

// MARK: - Live classifier: ad-hoc / teamless signatures may not manage

final class Issue486HostSignatureClassifierTests: XCTestCase {
    func testAdhocFlagRefused() {
        // codesign flags=0x2(adhoc) — build_app.sh's default identity "-".
        XCTAssertFalse(HostCodeSignature.allowsServiceManagement(
            flags: SecCodeSignatureFlags.adhoc.rawValue, teamIdentifier: nil))
        // Even the production team ID alongside the adhoc flag stays refused.
        XCTAssertFalse(HostCodeSignature.allowsServiceManagement(
            flags: SecCodeSignatureFlags.adhoc.rawValue | SecCodeSignatureFlags.runtime.rawValue,
            teamIdentifier: HostCodeSignature.productionTeamIdentifier))
    }

    func testMissingOrForeignTeamIdentifierRefused() {
        XCTAssertFalse(HostCodeSignature.allowsServiceManagement(flags: 0, teamIdentifier: nil))
        XCTAssertFalse(HostCodeSignature.allowsServiceManagement(flags: 0, teamIdentifier: ""))
        // A dev build signed with a real but non-production identity is
        // still not the production app (CodeRabbit, PR #487).
        XCTAssertFalse(HostCodeSignature.allowsServiceManagement(
            flags: SecCodeSignatureFlags.runtime.rawValue, teamIdentifier: "ZZOTHERTEAM"))
    }

    func testProductionShapeAllowed() {
        // Developer ID + hardened runtime, as release-dmg.sh signs.
        XCTAssertTrue(HostCodeSignature.allowsServiceManagement(
            flags: SecCodeSignatureFlags.runtime.rawValue,
            teamIdentifier: HostCodeSignature.productionTeamIdentifier))
    }

    /// The live end-to-end tripwire: THIS test process is never signed like
    /// the production app (swift test binaries are ad-hoc; xctest carries no
    /// team), so the production wiring must classify it as not-allowed. If a
    /// refactor ever makes the probe or classifier permissive — defaulting
    /// open on failure, dropping the team check — this fails immediately.
    func testTestProcessMayNeverManageTheService() {
        XCTAssertFalse(
            HostCodeSignature.currentProcessAllowsServiceManagement(),
            "TRIPWIRE #486: a process not signed like the production app classified as allowed to (re)register ai.hermes.modeldeck"
        )
    }
}
