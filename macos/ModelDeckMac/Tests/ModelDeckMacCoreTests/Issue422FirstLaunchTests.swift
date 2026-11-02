import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #422 — 1.0 build D: the first-launch flow's decision logic.
//
// Everything the user reads or the flow decides is pure and tested here: which
// branch first launch takes, what the adoption offer would stop and how, what
// the visible record says, and what the rollback prints. Nothing in this file
// touches port 8317, reads a management key, spawns anything, or stops a
// process — the seams are fakes.

// MARK: - Fakes

final class FakeDetector: ExternalProxyDetecting, @unchecked Sendable {
    private let lock = NSLock()
    private var answers: [ExternalProxyProbe]
    private(set) var calls = 0

    /// `answers` is consumed in order; the last one repeats (adoption probes
    /// twice: once to detect, once to verify the port is really free).
    init(_ answers: [ExternalProxyProbe]) { self.answers = answers }

    func detectExternalProxy() async -> ExternalProxyProbe {
        lock.withLock {
            calls += 1
            return answers.count > 1 ? answers.removeFirst() : (answers.first ?? .silent)
        }
    }
}

final class FakeSupervisionInspector: ExternalProxySupervisionInspecting, @unchecked Sendable {
    private let supervision: ExternalProxySupervision
    init(_ supervision: ExternalProxySupervision) { self.supervision = supervision }
    func inspectSupervision() async -> ExternalProxySupervision { supervision }
}

final class FakeStopper: ExternalProxyStopping, @unchecked Sendable {
    private let lock = NSLock()
    private let succeeds: Bool
    private(set) var stopped: [AdoptionPlan] = []

    init(succeeds: Bool = true) { self.succeeds = succeeds }

    func stopExternalProxy(_ plan: AdoptionPlan) async -> Bool {
        lock.withLock { stopped.append(plan) }
        return succeeds
    }
}

final class FakeOnboardingStore: ManagedProxyOnboardingStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var _choice: ManagedProxyOnboardingChoice?
    private var _supervision: ExternalProxySupervision?

    init(choice: ManagedProxyOnboardingChoice? = nil,
         supervision: ExternalProxySupervision? = nil) {
        _choice = choice
        _supervision = supervision
    }

    var choice: ManagedProxyOnboardingChoice? {
        get { lock.withLock { _choice } }
        set { lock.withLock { _choice = newValue } }
    }

    var adoptedSupervision: ExternalProxySupervision? {
        get { lock.withLock { _supervision } }
        set { lock.withLock { _supervision = newValue } }
    }
}

/// Counts the lifecycle callbacks so a test can prove the flow asked slice C
/// to start or stop — and, more importantly, that it did NOT.
@MainActor
final class LifecycleSpy {
    private(set) var starts = 0
    private(set) var adoptions = 0
    private(set) var stops = 0
    func start() { starts += 1 }
    func adopt() { adoptions += 1 }
    func stop() { stops += 1 }
}

/// `proxyRole` defaults to `.host`, the pool host the pre-#784 tests
/// describe (and the app's role when none was ever recorded).
@MainActor
func makeOnboardingModel(
    detection: [ExternalProxyProbe] = [.silent],
    supervision: ExternalProxySupervision = .unknown,
    stopSucceeds: Bool = true,
    store: FakeOnboardingStore = FakeOnboardingStore(),
    bundleAvailable: Bool = true,
    spy: LifecycleSpy = LifecycleSpy(),
    detector: FakeDetector? = nil,
    stopper: FakeStopper? = nil,
    supervisionInspector: (any ExternalProxySupervisionInspecting)? = nil,
    proxyRole: ProxyRole = .host
) -> ManagedProxyOnboardingModel {
    ManagedProxyOnboardingModel(dependencies: .init(
        detector: detector ?? FakeDetector(detection),
        supervision: supervisionInspector ?? FakeSupervisionInspector(supervision),
        stopper: stopper ?? FakeStopper(succeeds: stopSucceeds),
        store: store,
        bundleAvailable: bundleAvailable,
        uid: 501,
        startManagedProxy: { spy.start() },
        stopManagedProxy: { spy.stop() },
        adoptManagedProxy: { spy.adopt() }
    ), proxyRole: proxyRole)
}

let answeringConfirmed = ExternalProxyProbe(portAnswering: true, handshake: .confirmed)
let answeringUnknownKey = ExternalProxyProbe(portAnswering: true, handshake: .keyUnavailable)

// MARK: - Detection

@Suite("Issue #422 — detection: one port probe, one named handshake")
struct Issue422DetectionTests {

    @Test("a silent port is the fresh-install case")
    func silentPortIsAbsent() {
        #expect(classifyExternalProxy(.silent) == .absent)
        #expect(classifyExternalProxy(
            ExternalProxyProbe(portAnswering: false, handshake: .confirmed)
        ) == .absent)
    }

    @Test("the named handshake confirming makes it CLIProxyAPI")
    func confirmedHandshake() {
        #expect(classifyExternalProxy(answeringConfirmed) == .cliProxyAPI)
    }

    @Test("an answering port the handshake can't confirm says WHY, never silently")
    func unconfirmedAnswersCarryTheirReason() {
        for handshake: ManagementHandshake in [.rejected, .keyUnavailable, .inconclusive, .notPerformed] {
            let detection = classifyExternalProxy(
                ExternalProxyProbe(portAnswering: true, handshake: handshake)
            )
            guard case .unidentifiedListener(let reason) = detection else {
                Issue.record("handshake \(handshake) should stay unidentified, got \(detection)")
                continue
            }
            #expect(!reason.isEmpty)
            #expect(reason.contains("\(ManagedProxyDefaults.port)"))
        }
        // The three reasons are distinguishable: "no key" and "key rejected"
        // are different facts about the user's machine.
        #expect(ManagedProxyOnboardingCopy.handshakeRejectedReason
                != ManagedProxyOnboardingCopy.handshakeKeyMissingReason)
    }

    @Test("HTTP status maps to the handshake outcome")
    func handshakeStatusClassification() {
        #expect(classifyManagementHandshakeStatus(200) == .confirmed)
        #expect(classifyManagementHandshakeStatus(204) == .confirmed)
        #expect(classifyManagementHandshakeStatus(401) == .rejected)
        #expect(classifyManagementHandshakeStatus(403) == .rejected)
        #expect(classifyManagementHandshakeStatus(404) == .inconclusive)
        #expect(classifyManagementHandshakeStatus(500) == .inconclusive)
    }

    @Test("detection uses the ONE named non-destructive endpoint, never the usage queue")
    func detectionEndpointIsTheNamedOne() {
        // The usage-queue read CONSUMES the queue (#400): identifying a proxy
        // with it would destroy usage data.
        #expect(CLIProxyExternalDetector.handshakePath == "v0/management/config")
        #expect(!CLIProxyExternalDetector.handshakePath.contains("usage-queue"))
    }
}

// MARK: - Branch

@Suite("Issue #422 — which first-launch surface, and asked exactly once")
struct Issue422BranchTests {

    @Test("nothing on the port asks for consent")
    func freshInstallGoesToConsent() {
        #expect(decideFirstLaunch(
            bundleAvailable: true, recordedChoice: nil, detection: .absent
        ) == .consent)
    }

    @Test("something on the port offers adoption, confirmed or not")
    func occupiedPortOffersAdoption() {
        #expect(decideFirstLaunch(
            bundleAvailable: true, recordedChoice: nil, detection: .cliProxyAPI
        ) == .adoptionOffer(.cliProxyAPI))
        let unidentified = ExternalProxyDetection.unidentifiedListener(reason: "because")
        #expect(decideFirstLaunch(
            bundleAvailable: true, recordedChoice: nil, detection: unidentified
        ) == .adoptionOffer(unidentified))
    }

    @Test("a dev build with no bundled proxy asks nothing at all")
    func devBuildAsksNothing() {
        #expect(decideFirstLaunch(
            bundleAvailable: false, recordedChoice: nil, detection: .absent
        ) == .none)
        #expect(decideFirstLaunch(
            bundleAvailable: false, recordedChoice: nil, detection: .cliProxyAPI
        ) == .none)
    }

    @Test("every recorded choice ends the asking — no re-prompt at any later launch")
    func rememberedChoiceIsNeverReasked() {
        for choice in [ManagedProxyOnboardingChoice.adopted, .coexist, .managedEnabled, .managedDeclined] {
            #expect(decideFirstLaunch(
                bundleAvailable: true, recordedChoice: choice, detection: .cliProxyAPI
            ) == .none)
            #expect(decideFirstLaunch(
                bundleAvailable: true, recordedChoice: choice, detection: .absent
            ) == .none)
        }
    }

    @Test("nothing starts before the user has said yes — at any launch")
    func neverSilentOn() {
        // The undecided first launch, and every launch after a decline.
        #expect(!managedProxyMayRunAtLaunch(recordedChoice: nil))
        #expect(!managedProxyMayRunAtLaunch(recordedChoice: .managedDeclined))
        #expect(!managedProxyMayRunAtLaunch(recordedChoice: .coexist))
        #expect(managedProxyMayRunAtLaunch(recordedChoice: .managedEnabled))
        #expect(managedProxyMayRunAtLaunch(recordedChoice: .adopted))
    }

    @Test("only adoption and consent-enabled want a managed proxy")
    func wantsManagedProxy() {
        #expect(ManagedProxyOnboardingChoice.adopted.wantsManagedProxy)
        #expect(ManagedProxyOnboardingChoice.managedEnabled.wantsManagedProxy)
        #expect(!ManagedProxyOnboardingChoice.coexist.wantsManagedProxy)
        #expect(!ManagedProxyOnboardingChoice.managedDeclined.wantsManagedProxy)
    }
}

// MARK: - Adoption plan and record

@Suite("Issue #422 — the adoption plan names what it would stop and how")
struct Issue422AdoptionPlanTests {

    @Test("a launchd job is stopped by its label, with the command shown")
    func launchAgentPlan() {
        let plan = planAdoption(for: .launchAgent(
            label: "com.example.cliproxyapi",
            plistPath: "/Users/x/Library/LaunchAgents/com.example.cliproxyapi.plist"
        ))
        #expect(plan == .stopLaunchAgent(
            label: "com.example.cliproxyapi",
            plistPath: "/Users/x/Library/LaunchAgents/com.example.cliproxyapi.plist"
        ))
        #expect(plan.targetDescription.contains("com.example.cliproxyapi"))
        #expect(plan.actionDescription.contains("launchctl bootout"))
    }

    @Test("a plain process is stopped by pid, with the signal shown")
    func plainProcessPlan() {
        let plan = planAdoption(for: .plainProcess(pid: 4242, command: "cliproxyapi -config x.yaml"))
        #expect(plan.targetDescription.contains("4242"))
        #expect(plan.targetDescription.contains("cliproxyapi -config x.yaml"))
        #expect(plan.actionDescription.contains("SIGTERM"))
    }

    @Test("supervision it cannot name is REFUSED, not half-stopped")
    func unknownSupervisionRefuses() {
        let plan = planAdoption(for: .unknown)
        guard case .refuse(let reason) = plan else {
            Issue.record("unknown supervision must refuse, got \(plan)")
            return
        }
        #expect(reason.contains("won't try to stop it"))
        #expect(plan.targetDescription == "nothing")
    }

    @Test("a successful adoption reports what it stopped, how, and the shared config dir")
    func successfulRecordIsSpecific() {
        let plan = planAdoption(for: .launchAgent(label: "com.example.cliproxyapi", plistPath: "/p.plist"))
        let record = adoptionRecord(
            plan: plan, stopSucceeded: true, portStillAnswering: false,
            configDirectory: "~/.config/cliproxyapi"
        )
        #expect(record.succeeded)
        #expect(record.headline == "ModelDeck now manages your proxy")
        #expect(record.stoppedWhat.contains("com.example.cliproxyapi"))
        #expect(record.stoppedHow.contains("launchctl bootout"))
        let body = record.lines.joined(separator: "\n")
        #expect(body.contains("com.example.cliproxyapi"))
        #expect(body.contains("launchctl bootout"))
        #expect(body.contains("~/.config/cliproxyapi"))
        // #398: adoption is credential-migration-free BY CONSTRUCTION, and
        // the user is told so rather than left to wonder.
        #expect(body.contains("nothing was copied or migrated"))
    }

    @Test("a stop that failed never claims a takeover")
    func failedStopIsHonest() {
        let plan = planAdoption(for: .plainProcess(pid: 7, command: "cliproxyapi"))
        let record = adoptionRecord(
            plan: plan, stopSucceeded: false, portStillAnswering: true,
            configDirectory: "~/.config/cliproxyapi"
        )
        #expect(!record.succeeded)
        #expect(record.headline == "ModelDeck couldn't take over your proxy")
        #expect(record.lines.joined().contains("did not start its own proxy"))
    }

    @Test("a stop that 'succeeded' while the port still answers is still a failure")
    func portStillAnsweringIsFailure() {
        let plan = planAdoption(for: .plainProcess(pid: 7, command: "cliproxyapi"))
        let record = adoptionRecord(
            plan: plan, stopSucceeded: true, portStillAnswering: true,
            configDirectory: "~/.config/cliproxyapi"
        )
        #expect(!record.succeeded)
        #expect(record.lines.joined().contains("still answering"))
    }

    @Test("a refusal says nothing was touched")
    func refusalRecord() {
        let record = adoptionRecord(
            plan: planAdoption(for: .unknown), stopSucceeded: false,
            portStillAnswering: true, configDirectory: "~/.config/cliproxyapi"
        )
        #expect(record.outcome == .refused(reason: ManagedProxyOnboardingCopy.cannotIdentifySupervisionReason))
        #expect(record.stoppedHow == "no command was run")
        #expect(record.lines.joined().contains("stopped nothing and changed nothing"))
    }
}

// MARK: - Rollback

@Suite("Issue #422 — 'stop managing' prints the concrete restore steps")
struct Issue422RollbackTests {

    @Test("a launchd job comes back with bootstrap + kickstart in the user's own domain")
    func launchAgentRestoreSteps() {
        let steps = managedProxyRestoreInstructions(
            for: .launchAgent(label: "com.example.cliproxyapi",
                              plistPath: "/Users/x/Library/LaunchAgents/com.example.cliproxyapi.plist"),
            uid: 501
        )
        #expect(steps.steps == [
            "launchctl bootstrap gui/501 /Users/x/Library/LaunchAgents/com.example.cliproxyapi.plist",
            "launchctl kickstart -k gui/501/com.example.cliproxyapi",
        ])
        #expect(steps.clipboardText.contains("\n"))
        #expect(steps.note?.contains("~/.config/cliproxyapi") == true)
    }

    @Test("a hand-started proxy comes back with the command that was running")
    func plainProcessRestoreSteps() {
        let steps = managedProxyRestoreInstructions(
            for: .plainProcess(pid: 900, command: "cliproxyapi -config /Users/x/.config/cliproxyapi/config.yaml"),
            uid: 501
        )
        #expect(steps.steps == ["cliproxyapi -config /Users/x/.config/cliproxyapi/config.yaml"])
        #expect(steps.note?.contains("pid") == true)
    }

    @Test("nothing adopted means nothing to restore, said plainly")
    func nothingToRestore() {
        for supervision: ExternalProxySupervision? in [ExternalProxySupervision.unknown, nil] {
            let steps = managedProxyRestoreInstructions(for: supervision, uid: 501)
            #expect(steps.steps.isEmpty)
            #expect(steps.note?.contains("nothing to restore") == true)
            #expect(steps.clipboardText.isEmpty)
        }
    }
}

// MARK: - Copy

@Suite("Issue #422 — the copy states the reason, never a bare 'unavailable'")
struct Issue422CopyTests {

    @Test("coexist names why managed-only features are off")
    func coexistReason() {
        let reason = ManagedProxyOnboardingCopy.coexistUnavailableReason
        #expect(reason.contains("\(ManagedProxyDefaults.port)"))
        #expect(reason.contains("client"))
        // The named features, not a vague "some features".
        #expect(reason.contains("restarting"))
    }

    @Test("declining consent states the honest tier-1–2 cost and the way back")
    func declineIsHonestAndReversible() {
        let reason = ManagedProxyOnboardingCopy.consentDeclinedReason
        #expect(reason.contains("estimated"))
        #expect(reason.contains("Settings"))
        #expect(ManagedProxyOnboardingCopy.consentTitle.contains("measured usage truth"))
        #expect(ManagedProxyOnboardingCopy.consentBody.contains("this Mac only"))
    }

    @Test("Settings summarises whichever choice is recorded, including 'not asked yet'")
    func settingsSummaries() {
        #expect(ManagedProxyOnboardingCopy.settingsSummary(for: .adopted).contains("took over"))
        #expect(ManagedProxyOnboardingCopy.settingsSummary(for: .managedEnabled).contains("manages the proxy"))
        #expect(ManagedProxyOnboardingCopy.settingsSummary(for: .coexist)
                == ManagedProxyOnboardingCopy.coexistUnavailableReason)
        #expect(ManagedProxyOnboardingCopy.settingsSummary(for: .managedDeclined)
                == ManagedProxyOnboardingCopy.consentDeclinedReason)
        #expect(!ManagedProxyOnboardingCopy.settingsSummary(for: nil).isEmpty)
    }
}

// MARK: - Supervision discovery helpers

@Suite("Issue #422 — supervision discovery identifies the SERVER, by executable")
struct Issue422SupervisionDiscoveryTests {

    /// The real field install (#422's own test machine): the proxy server, the
    /// tolerated rebalance cron (#401a) whose python command line ALSO
    /// contains "cliproxyapi", and unrelated processes.
    private static let fieldPS = """
          501 /usr/bin/python3 /Users/x/.config/cliproxyapi/rebalance-weights.py
          640 /Users/x/bin/cliproxyapi -config /Users/x/.config/cliproxyapi/config.yaml
          701 /usr/sbin/cupsd -l
        """

    @Test("the rebalance cron is never mistaken for the proxy")
    func picksTheServerNotTheCron() {
        let found = findCLIProxyServerProcess(psOutput: Self.fieldPS, ownPID: 1)
        #expect(found?.pid == 640)
        #expect(found?.executable == "/Users/x/bin/cliproxyapi")
        #expect(found?.command.contains("-config") == true)
    }

    @Test("only an executable actually named cliproxyapi counts")
    func executableIdentity() {
        #expect(isCLIProxyExecutable("/Users/x/bin/cliproxyapi"))
        #expect(isCLIProxyExecutable("cliproxyapi"))
        #expect(!isCLIProxyExecutable("/usr/bin/python3"))
        #expect(!isCLIProxyExecutable("/Users/x/.config/cliproxyapi/rebalance-weights.py"))
        #expect(findCLIProxyServerProcess(psOutput: "", ownPID: 1) == nil)
        // Our own process is never the adoption target.
        #expect(findCLIProxyServerProcess(psOutput: "  640 /bin/cliproxyapi", ownPID: 640) == nil)
    }

    @Test("the launchd match is the job running THAT executable — not a name match")
    func launchAgentMatchesByExecutable() {
        let running = "/Users/x/bin/cliproxyapi"
        #expect(isCLIProxyServerLaunchAgent(
            label: "com.cliproxyapi.server", program: nil,
            arguments: [running, "-config", "/Users/x/.config/cliproxyapi/config.yaml"],
            runningExecutable: running
        ))
        // #401a: the tolerated rebalance job — same word everywhere, wrong job.
        #expect(!isCLIProxyServerLaunchAgent(
            label: "com.cliproxyapi.rebalance-weights", program: nil,
            arguments: ["/usr/bin/python3", "/Users/x/.config/cliproxyapi/rebalance-weights.py"],
            runningExecutable: running
        ))
        // A second install of the same binary elsewhere isn't what's running.
        #expect(!isCLIProxyServerLaunchAgent(
            label: "com.other.cliproxyapi", program: "/opt/bin/cliproxyapi", arguments: nil,
            runningExecutable: running
        ))
    }

    @Test("ModelDeck's own agents are never adoption targets")
    func neverAdoptsOurOwnAgent() {
        #expect(!isCLIProxyServerLaunchAgent(
            label: "ai.hermes.modeldeck", program: "/Applications/ModelDeck.app/cliproxyapi",
            arguments: nil, runningExecutable: "/Applications/ModelDeck.app/cliproxyapi"
        ))
        #expect(!isCLIProxyServerLaunchAgent(
            label: "app.modeldeck.mac", program: nil, arguments: nil,
            runningExecutable: "/Users/x/bin/cliproxyapi"
        ))
    }
}

// MARK: - Model

@MainActor
@Suite("Issue #422 — the first-launch model")
struct Issue422ModelTests {

    @Test("a live proxy on the port opens the adoption offer")
    func launchOffersAdoption() async {
        let model = makeOnboardingModel(detection: [answeringConfirmed])
        await model.evaluateOnLaunch()
        #expect(model.phase == .adoptionOffer(.cliProxyAPI))
    }

    @Test("a silent port opens the one consent screen")
    func launchAsksConsent() async {
        let model = makeOnboardingModel(detection: [.silent])
        await model.evaluateOnLaunch()
        #expect(model.phase == .consent)
    }

    @Test("a dev build asks nothing and never probes the port")
    func devBuildStaysQuiet() async {
        let detector = FakeDetector([answeringConfirmed])
        let model = makeOnboardingModel(bundleAvailable: false, detector: detector)
        await model.evaluateOnLaunch()
        #expect(model.phase == .hidden)
        #expect(detector.calls == 0)
    }

    @Test("a remembered choice means the second launch asks nothing")
    func askedOnce() async {
        let store = FakeOnboardingStore()
        let model = makeOnboardingModel(detection: [.silent], store: store)
        await model.evaluateOnLaunch()
        #expect(model.phase == .consent)
        model.declineManagedProxy()
        #expect(store.choice == .managedDeclined)

        let second = makeOnboardingModel(detection: [.silent], store: store)
        await second.evaluateOnLaunch()
        #expect(second.phase == .hidden)
    }

    @Test("adopting a launchd-supervised proxy stops it, starts ours, and records the choice")
    func adoptionHappyPath() async {
        let store = FakeOnboardingStore()
        let spy = LifecycleSpy()
        let stopper = FakeStopper(succeeds: true)
        let model = makeOnboardingModel(
            // Answering at detect time; silent when re-probed after the stop.
            detection: [answeringConfirmed, .silent],
            supervision: .launchAgent(label: "com.example.cliproxyapi", plistPath: "/p.plist"),
            store: store, spy: spy, stopper: stopper
        )
        await model.evaluateOnLaunch()
        await model.adopt()

        #expect(stopper.stopped.count == 1)
        #expect(store.choice == .adopted)
        #expect(store.adoptedSupervision == .launchAgent(label: "com.example.cliproxyapi", plistPath: "/p.plist"))
        #expect(spy.adoptions == 1)
        #expect(spy.starts == 0)
        guard case .record(let record) = model.phase else {
            Issue.record("adoption must end on its visible record, got \(model.phase)")
            return
        }
        #expect(record.succeeded)
    }

    @Test("adoption that can't identify the supervision stops NOTHING and records nothing chosen")
    func adoptionRefusesUnknownSupervision() async {
        let store = FakeOnboardingStore()
        let spy = LifecycleSpy()
        let stopper = FakeStopper(succeeds: true)
        let model = makeOnboardingModel(
            detection: [answeringUnknownKey],
            supervision: .unknown, store: store, spy: spy, stopper: stopper
        )
        await model.evaluateOnLaunch()
        await model.adopt()

        #expect(stopper.stopped.isEmpty)
        #expect(spy.starts == 0)
        // Nothing changed on the machine, so nothing is recorded — the offer
        // is still open next launch.
        #expect(store.choice == nil)
        guard case .record(let record) = model.phase else {
            Issue.record("a refusal is still a visible record, got \(model.phase)")
            return
        }
        #expect(!record.succeeded)
    }

    @Test("a stop that leaves the port occupied never starts a second proxy")
    func adoptionNeverDoubleStarts() async {
        let store = FakeOnboardingStore()
        let spy = LifecycleSpy()
        let model = makeOnboardingModel(
            // Still answering on the verification probe.
            detection: [answeringConfirmed],
            supervision: .plainProcess(pid: 4242, command: "cliproxyapi"),
            stopSucceeds: true, store: store, spy: spy
        )
        await model.adopt()
        #expect(spy.starts == 0)
        #expect(store.choice == nil)
        #expect(model.lastAdoptionRecord?.succeeded == false)
    }

    @Test("declining adoption records coexist and stops asking")
    func declineAdoptionCoexists() async {
        let store = FakeOnboardingStore()
        let spy = LifecycleSpy()
        let model = makeOnboardingModel(detection: [answeringConfirmed], store: store, spy: spy)
        await model.evaluateOnLaunch()
        model.declineAdoption()
        #expect(store.choice == .coexist)
        #expect(model.phase == .hidden)
        #expect(spy.starts == 0)
    }

    @Test("consent Enable starts the managed proxy; declining starts nothing")
    func consentBranches() async {
        let enabledStore = FakeOnboardingStore()
        let enabledSpy = LifecycleSpy()
        let enabled = makeOnboardingModel(store: enabledStore, spy: enabledSpy)
        await enabled.evaluateOnLaunch()
        await enabled.enableManagedProxy()
        #expect(enabledStore.choice == .managedEnabled)
        #expect(enabledSpy.starts == 1)
        #expect(enabled.phase == .hidden)

        let declinedStore = FakeOnboardingStore()
        let declinedSpy = LifecycleSpy()
        let declined = makeOnboardingModel(store: declinedStore, spy: declinedSpy)
        await declined.evaluateOnLaunch()
        declined.declineManagedProxy()
        #expect(declinedStore.choice == .managedDeclined)
        #expect(declinedSpy.starts == 0)
    }

    @Test("stop managing detaches and prints the adopted job's restore steps")
    func rollbackPrintsRestoreSteps() async {
        let store = FakeOnboardingStore(
            choice: .adopted,
            supervision: .launchAgent(label: "com.example.cliproxyapi", plistPath: "/p.plist")
        )
        let spy = LifecycleSpy()
        let model = makeOnboardingModel(store: store, spy: spy)
        await model.stopManagingProxy()

        #expect(spy.stops == 1)
        #expect(store.choice == .coexist)
        #expect(model.restoreInstructions?.steps == [
            "launchctl bootstrap gui/501 /p.plist",
            "launchctl kickstart -k gui/501/com.example.cliproxyapi",
        ])
    }

    // PR #433 review: .coexist claims the user runs their own proxy. A fresh
    // managed install that stops managing adopted nothing — recording
    // coexistence would lie about what's on the port.
    @Test("stop managing on a fresh managed install records declined, not coexist")
    func rollbackWithoutAdoptionRecordsDeclined() async {
        let store = FakeOnboardingStore(choice: .managedEnabled, supervision: nil)
        let spy = LifecycleSpy()
        let model = makeOnboardingModel(store: store, spy: spy)
        await model.stopManagingProxy()

        #expect(spy.stops == 1)
        #expect(store.choice == .managedDeclined)
        // Nothing was adopted, so there is nothing to restore — and the
        // instructions say so instead of printing launchd steps.
        #expect(model.restoreInstructions?.steps.isEmpty == true)
    }

    @Test("the upgrade path from Settings enables management without a launch prompt")
    func enableFromSettings() async {
        let store = FakeOnboardingStore(choice: .managedDeclined)
        let spy = LifecycleSpy()
        let model = makeOnboardingModel(store: store, spy: spy)
        await model.stopManagingProxy()
        #expect(model.restoreInstructions != nil)

        await model.enableFromSettings()
        #expect(store.choice == .managedEnabled)
        #expect(spy.starts == 1)
        #expect(model.restoreInstructions == nil)
        #expect(model.phase == .hidden)
    }
}

// MARK: - Storage

@Suite("Issue #422 — the choice survives a relaunch")
struct Issue422StoreTests {

    @Test("choice and adopted supervision round-trip through UserDefaults")
    func roundTrip() throws {
        let defaults = ScratchDefaults.make("onboarding")

        let store = UserDefaultsManagedProxyOnboardingStore(defaults: defaults)
        #expect(store.choice == nil)
        #expect(store.adoptedSupervision == nil)

        store.choice = .adopted
        store.adoptedSupervision = .launchAgent(label: "com.example.cliproxyapi", plistPath: "/p.plist")

        let reopened = UserDefaultsManagedProxyOnboardingStore(defaults: defaults)
        #expect(reopened.choice == .adopted)
        #expect(reopened.adoptedSupervision == .launchAgent(label: "com.example.cliproxyapi", plistPath: "/p.plist"))

        reopened.choice = nil
        reopened.adoptedSupervision = nil
        #expect(UserDefaultsManagedProxyOnboardingStore(defaults: defaults).choice == nil)
        #expect(UserDefaultsManagedProxyOnboardingStore(defaults: defaults).adoptedSupervision == nil)
    }
}
