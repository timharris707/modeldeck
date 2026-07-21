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
    init(_ results: [Bool]) { self.results = results }
    func checkReachable() async -> Bool {
        if results.count > 1 { return results.removeFirst() }
        return results.first ?? false
    }
}

private struct TestError: LocalizedError {
    var errorDescription: String? { "boom" }
}

// MARK: - Pure decision

final class DaemonSetupDecisionTests: XCTestCase {
    func testNoBundledDaemonStandsDown() {
        XCTAssertEqual(
            decideDaemonSetup(reachable: false, registration: .notRegistered,
                              legacyPresent: false, recordedCommit: nil, bundledCommit: nil),
            .bundledServiceUnavailable
        )
        XCTAssertEqual(
            decideDaemonSetup(reachable: false, registration: .notRegistered,
                              legacyPresent: false, recordedCommit: nil, bundledCommit: ""),
            .bundledServiceUnavailable
        )
    }

    func testReachableAndCurrentIsRunning() {
        XCTAssertEqual(
            decideDaemonSetup(reachable: true, registration: .enabled,
                              legacyPresent: false, recordedCommit: "abc", bundledCommit: "abc"),
            .running
        )
    }

    func testReachableWithoutRegistrationIsRunning() {
        // Dev daemon started by hand — never nag while something answers.
        XCTAssertEqual(
            decideDaemonSetup(reachable: true, registration: .notRegistered,
                              legacyPresent: false, recordedCommit: nil, bundledCommit: "abc"),
            .running
        )
    }

    func testTrueFirstRunNeedsConsent() {
        XCTAssertEqual(
            decideDaemonSetup(reachable: false, registration: .notRegistered,
                              legacyPresent: false, recordedCommit: nil, bundledCommit: "abc"),
            .needsConsent
        )
    }

    func testDriftWinsEvenWhileRunning() {
        // The running daemon is the OLD build; re-register replaces it.
        XCTAssertEqual(
            decideDaemonSetup(reachable: true, registration: .enabled,
                              legacyPresent: false, recordedCommit: "old", bundledCommit: "new"),
            .driftReregister(recorded: "old", bundled: "new")
        )
    }

    func testMissingMarkerCountsAsDrift() {
        XCTAssertEqual(
            decideDaemonSetup(reachable: false, registration: .enabled,
                              legacyPresent: false, recordedCommit: nil, bundledCommit: "new"),
            .driftReregister(recorded: nil, bundled: "new")
        )
    }

    func testLegacyPresentBlocksConsent() {
        XCTAssertEqual(
            decideDaemonSetup(reachable: false, registration: .notRegistered,
                              legacyPresent: true, recordedCommit: nil, bundledCommit: "abc"),
            .legacyInstalledNotRunning
        )
    }

    func testLegacyPresentButReachableIsRunning() {
        XCTAssertEqual(
            decideDaemonSetup(reachable: true, registration: .notRegistered,
                              legacyPresent: true, recordedCommit: nil, bundledCommit: "abc"),
            .running
        )
    }

    func testRegisteredAwaitingApproval() {
        XCTAssertEqual(
            decideDaemonSetup(reachable: false, registration: .requiresApproval,
                              legacyPresent: false, recordedCommit: nil, bundledCommit: "abc"),
            .awaitingApproval
        )
    }

    func testRegisteredCurrentButDownIsRegisteredNotRunning() {
        XCTAssertEqual(
            decideDaemonSetup(reachable: false, registration: .enabled,
                              legacyPresent: false, recordedCommit: "abc", bundledCommit: "abc"),
            .registeredNotRunning
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

    override func setUp() {
        super.setUp()
        registrar = FakeRegistrar()
        tokenStore = FakeTokenStore()
        legacy = FakeLegacyAgent()
        marker = FakeMarker()
        probe = FakeProbe([false])
    }

    private func makeModel(bundledCommit: String? = "new") -> DaemonSetupModel {
        DaemonSetupModel(
            dependencies: .init(
                registrar: registrar,
                tokenStore: tokenStore,
                legacyAgent: legacy,
                marker: marker,
                probe: probe,
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

    override func setUp() {
        super.setUp()
        registrar = FakeRegistrar()
        tokenStore = FakeTokenStore()
        legacy = FakeLegacyAgent()
        marker = FakeMarker()
        probe = FakeProbe([false])
    }

    private func makeModel(bundledCommit: String? = "new") -> DaemonSetupModel {
        DaemonSetupModel(
            dependencies: .init(
                registrar: registrar,
                tokenStore: tokenStore,
                legacyAgent: legacy,
                marker: marker,
                probe: probe,
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
