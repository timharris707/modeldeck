import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #784 (slice 1 of #783) — the app's half of the proxy pool role.
//
// Tim is moving to one CLIProxyAPI pool on the Mac Studio. The other Macs
// reach it through a forwarder on their own 127.0.0.1:8317, so on those Macs
// the port answers and nothing behind it is theirs to manage. The daemon
// reports `proxy: { role }` in /api/state and refuses pool work in remote
// role. These pin the app's side: the role decodes tolerantly and is
// remembered across launches, the first-launch question never appears off
// the pool host, the header says where the pool is in one quiet label, and
// the app is wired so a state's role lands before any launch-time decision.
//
// The lifecycle half (never starts, stops only its own proxy, never waits
// on the daemon) lives with its fakes in ManagedProxyTests.swift.

// MARK: - Decoding

@Suite("Issue #784 — proxy.role decodes tolerantly")
struct Issue784RoleDecodingTests {
    private func state(_ extra: String) throws -> DeckState {
        let json = #"{"accounts": [{"id": "a1", "provider": "claude", "label": "Work", "enabled": true, "isDefault": true}], "usage": []\#(extra)}"#
        return try JSONDecoder().decode(DeckState.self, from: Data(json.utf8))
    }

    @Test("a present role decodes, host and remote alike")
    func presentRole() throws {
        #expect(try state(#", "proxy": {"role": "remote"}"#).proxyRole == .remote)
        #expect(try state(#", "proxy": {"role": "host"}"#).proxyRole == .host)
        #expect(try state(#", "proxy": {"role": "remote"}"#).proxy == DeckProxyStatus(role: .remote))
    }

    @Test("a daemon from before #784 omits the block, which reads as host")
    func missingRoleIsHost() throws {
        let decoded = try state("")
        #expect(decoded.proxy == nil)
        #expect(decoded.proxyRole == .host)
        #expect(decoded.accounts.map(\.id) == ["a1"])
    }

    @Test("a malformed block reads as missing, which is host, without failing the state")
    func malformedBlockIsHost() throws {
        for extra in [
            #", "proxy": {"role": 1}"#,
            #", "proxy": {}"#,
            #", "proxy": "remote""#,
            #", "proxy": null"#,
        ] {
            let decoded = try state(extra)
            #expect(decoded.proxyRole == .host, "\(extra) must read as host")
            #expect(decoded.accounts.map(\.id) == ["a1"], "\(extra) must not cost the rest of the state")
        }
    }

    // Review fix: a role name this build does not know is still the daemon
    // saying "not the host". Starting a proxy on that word would be a guess.
    @Test("a present role name this build does not know stands down like remote")
    func unknownRoleNameStandsDown() throws {
        for name in ["relay", "REMOTE", "Host", ""] {
            #expect(try state(#", "proxy": {"role": "\#(name)"}"#).proxyRole == .remote, "\(name)")
        }
        #expect(ProxyRole(named: "host") == .host)
        #expect(ProxyRole(named: "remote") == .remote)
    }

    @Test("a repair poll answer carries the daemon's refusal code")
    func reloginStateDecodesTheCode() throws {
        let json = #"{"accountId": "a1", "phase": "idle", "available": false, "code": "proxy-role-remote", "reason": "This Mac uses the proxy pool on another machine; manage it there."}"#
        let decoded = try JSONDecoder().decode(ProxyReloginState.self, from: Data(json.utf8))
        #expect(decoded.code == ProxyRoleCopy.remoteRefusalCode)
        #expect(decoded.reason == ProxyRoleCopy.remoteReason)
    }
}

// MARK: - The remembered role

@Suite("Issue #784 — the last role a state reported survives a relaunch")
struct Issue784RoleMemoryTests {
    @Test("never recorded is nil; a recorded role round-trips; a name this build does not know stands down")
    func roundTrip() {
        let defaults = ScratchDefaults.make("proxy-role")
        let memory = UserDefaultsProxyRoleMemory(defaults: defaults)
        #expect(memory.lastSeenRole == nil)
        memory.lastSeenRole = .remote
        #expect(UserDefaultsProxyRoleMemory(defaults: defaults).lastSeenRole == .remote)
        memory.lastSeenRole = .host
        #expect(UserDefaultsProxyRoleMemory(defaults: defaults).lastSeenRole == .host)
        // A newer build's role, read after a downgrade.
        defaults.set("relay", forKey: "proxyRoleLastSeen")
        #expect(UserDefaultsProxyRoleMemory(defaults: defaults).lastSeenRole == .remote)
        memory.lastSeenRole = nil
        #expect(UserDefaultsProxyRoleMemory(defaults: defaults).lastSeenRole == nil)
    }

    @Test("the app's wiring decides at launch from the role remembered in its defaults")
    @MainActor
    func liveWiringDecidesFromTheRememberedRole() {
        let defaults = ScratchDefaults.make("proxy-role-live")
        let fresh = ManagedProxyModel(dependencies: .live(reporter: NoopManagedProxyReporter(), defaults: defaults))
        #expect(fresh.proxyRole == .host)
        defaults.set("remote", forKey: "proxyRoleLastSeen")
        let remembered = ManagedProxyModel(dependencies: .live(reporter: NoopManagedProxyReporter(), defaults: defaults))
        #expect(remembered.proxyRole == .remote)
    }
}

// MARK: - Copy

@Suite("Issue #784 — the remote role speaks the daemon's own words")
struct Issue784RoleCopyTests {
    private static let repoRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // ModelDeckMacCoreTests
        .deletingLastPathComponent()   // Tests
        .deletingLastPathComponent()   // ModelDeckMac
        .deletingLastPathComponent()   // macos
        .deletingLastPathComponent()   // repo root

    /// The app restates the daemon's sentence where a control is hidden, so
    /// the two must not drift: a hidden control and a refusal give one reason.
    @Test("the reason and code are the daemon's, verbatim")
    func copyMatchesTheDaemon() throws {
        let service = try String(
            contentsOf: Self.repoRoot.appendingPathComponent("src/service.mjs"),
            encoding: .utf8
        )
        #expect(service.contains("reason: '\(ProxyRoleCopy.remoteReason)'"))
        #expect(service.contains("code: '\(ProxyRoleCopy.remoteRefusalCode)'"))
    }

    @Test("the header label exists in remote role only")
    func headerLabelOnlyInRemoteRole() {
        #expect(ProxyRoleCopy.headerLabel(for: .remote) == "Remote pool")
        #expect(ProxyRoleCopy.headerLabel(for: .host) == nil)
    }

    // Review fix (label in name): a voice user says what they see.
    @Test("the spoken label starts with the visible words")
    func spokenLabelStartsWithTheVisibleWords() {
        #expect(ProxyRoleCopy.remotePoolAccessibilityLabel == "Remote pool: proxy pool on another machine")
        #expect(ProxyRoleCopy.remotePoolAccessibilityLabel.hasPrefix(ProxyRoleCopy.remotePoolLabel))
    }

    @Test("only the remote-role refusal is recognised as one")
    func remoteRefusalIsRecognised() {
        #expect(ProxyRoleCopy.isRemoteRefusal(DaemonClientError.daemonCodedError(
            message: ProxyRoleCopy.remoteReason, code: "proxy-role-remote", status: 409
        )))
        #expect(!ProxyRoleCopy.isRemoteRefusal(DaemonClientError.daemonCodedError(
            message: "blocked", code: DaemonClientError.activeLinkBlockedCode, status: 409
        )))
        #expect(!ProxyRoleCopy.isRemoteRefusal(DaemonClientError.daemonError(
            message: ProxyRoleCopy.remoteReason, status: 409
        )))
        #expect(!ProxyRoleCopy.isRemoteRefusal(URLError(.timedOut)))
    }

    @Test("Settings states the reason in remote role and offers neither Enable nor Stop Managing")
    func settingsInRemoteRole() {
        for choice: ManagedProxyOnboardingChoice? in [nil, .adopted, .coexist, .managedEnabled, .managedDeclined] {
            #expect(ManagedProxyOnboardingCopy.settingsSummary(for: choice, role: .remote)
                == ProxyRoleCopy.remoteReason)
            #expect(ManagedProxyOnboardingCopy.settingsSummary(for: choice, role: .host)
                == ManagedProxyOnboardingCopy.settingsSummary(for: choice))
        }
        #expect(!managedProxySettingsOffersActions(role: .remote))
        #expect(managedProxySettingsOffersActions(role: .host))
    }
}

// MARK: - The first-launch question

/// Flips the role while supervision inspection is out — the window between
/// the adoption click and the stop.
private final class RoleFlippingInspector: ExternalProxySupervisionInspecting, @unchecked Sendable {
    @MainActor var model: ManagedProxyOnboardingModel?

    func inspectSupervision() async -> ExternalProxySupervision {
        await MainActor.run { _ = model?.applyProxyRole(.remote) }
        return .launchAgent(label: "com.example.cliproxyapi", plistPath: "/p.plist")
    }
}

@MainActor
@Suite("Issue #784 — no first-launch question off the pool host")
struct Issue784OnboardingTests {
    @Test("remote role asks nothing and never sends the handshake through the forwarder")
    func remoteRoleAsksNothing() async {
        let detector = FakeDetector([answeringConfirmed])
        let model = makeOnboardingModel(detector: detector, proxyRole: .remote)
        await model.evaluateOnLaunch()
        #expect(model.phase == .hidden)
        #expect(detector.calls == 0)
    }

    @Test("a remembered remote role asks nothing at launch; a state that says host asks then")
    func rememberedRemoteAsksOnHost() async {
        let detector = FakeDetector([.silent])
        let model = makeOnboardingModel(detector: detector, proxyRole: .remote)
        await model.evaluateOnLaunch()
        #expect(model.phase == .hidden)
        #expect(detector.calls == 0)

        await model.applyProxyRole(.host)?.value
        #expect(model.phase == .consent)
        #expect(detector.calls == 1)
    }

    @Test("a card that is up is withdrawn when the role moves to remote, and asked again back on host")
    func cardWithdrawnOnRemote() async {
        let store = FakeOnboardingStore()
        let model = makeOnboardingModel(detection: [answeringConfirmed], store: store)
        await model.evaluateOnLaunch()
        #expect(model.phase == .adoptionOffer(.cliProxyAPI))

        #expect(model.applyProxyRole(.remote) == nil)
        #expect(model.phase == .hidden)
        // Withdrawn, not answered.
        #expect(store.choice == nil)

        await model.applyProxyRole(.host)?.value
        #expect(model.phase == .adoptionOffer(.cliProxyAPI))
    }

    @Test("an answered question stays answered whatever the role does")
    func answeredStaysAnswered() async {
        let detector = FakeDetector([.silent])
        let model = makeOnboardingModel(
            store: FakeOnboardingStore(choice: .managedDeclined),
            detector: detector,
            proxyRole: .remote
        )
        await model.evaluateOnLaunch()
        #expect(model.applyProxyRole(.host) == nil)
        #expect(model.phase == .hidden)
        #expect(detector.calls == 0)
    }

    @Test("adoption in remote role stops nothing, starts nothing, and is recorded")
    func adoptionRefusedInRemoteRole() async {
        let store = FakeOnboardingStore()
        let spy = LifecycleSpy()
        let stopper = FakeStopper(succeeds: true)
        let model = makeOnboardingModel(
            supervision: .launchAgent(label: "com.example.cliproxyapi", plistPath: "/p.plist"),
            store: store, spy: spy, stopper: stopper, proxyRole: .remote
        )
        await model.adopt()

        #expect(stopper.stopped.isEmpty)
        #expect(spy.adoptions == 0)
        #expect(spy.starts == 0)
        #expect(store.choice == nil)
        guard case .record(let record) = model.phase else {
            Issue.record("a refused adoption is still a visible record, got \(model.phase)")
            return
        }
        #expect(record == remoteRoleAdoptionRecord())
        #expect(record.outcome == .refused(reason: ProxyRoleCopy.remoteReason))
        // Never the generic advice to stop "your proxy": here that is the
        // forwarder to the pool host.
        #expect(!record.lines.joined().contains("Stop your proxy yourself"))
    }

    @Test("a role that moves to remote while adoption inspects stops nothing")
    func roleMovesDuringAdoption() async {
        let store = FakeOnboardingStore()
        let spy = LifecycleSpy()
        let stopper = FakeStopper(succeeds: true)
        let inspector = RoleFlippingInspector()
        let model = makeOnboardingModel(
            detection: [answeringConfirmed, .silent],
            store: store, spy: spy, stopper: stopper,
            supervisionInspector: inspector
        )
        inspector.model = model
        await model.evaluateOnLaunch()
        await model.adopt()

        #expect(stopper.stopped.isEmpty)
        #expect(spy.adoptions == 0)
        #expect(store.choice == nil)
        #expect(model.lastAdoptionRecord == remoteRoleAdoptionRecord())
    }
}

// MARK: - TRIPWIRES on the app layer

@Suite("Issue #784 — TRIPWIRES on the app layer")
struct Issue784AppSourceTripwireTests {
    private struct AnchorMissing: Error, CustomStringConvertible {
        let anchor: String
        var description: String { "anchor not found: \(anchor)" }
    }

    private static let packageRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()

    private static func source(_ relativePath: String) throws -> String {
        try String(contentsOf: packageRoot.appendingPathComponent(relativePath), encoding: .utf8)
    }

    /// The braced block that opens at `anchor`: from the anchor through the
    /// brace that closes the first one it opens.
    private static func block(in text: Substring, openingAt anchor: String) throws -> Substring {
        guard let start = text.range(of: anchor) else { throw AnchorMissing(anchor: anchor) }
        var depth = 0
        var index = start.lowerBound
        while index < text.endIndex {
            switch text[index] {
            case "{":
                depth += 1
            case "}":
                depth -= 1
                if depth == 0 { return text[start.lowerBound...index] }
            default:
                break
            }
            index = text.index(after: index)
        }
        throw AnchorMissing(anchor: anchor)
    }

    /// Deck space is sacred: the label sits in the header's existing line,
    /// beside the wordmark — after the wordmark's combined accessibility
    /// element closes, so it is never swallowed (#65/#113/#272) — and never
    /// in the deck's vertical stack.
    @Test("TRIPWIRE remote-pool-label: in the header line, outside the wordmark's element, not a row")
    func labelLivesInTheHeaderLine() throws {
        let deck = try Self.source("Sources/ModelDeckMac/DeckPopoverView.swift")
        let header = try #require(deck.range(of: "private var header: some View {"))
        let spacer = try #require(deck.range(of: "Spacer()", range: header.upperBound..<deck.endIndex))
        let leading = deck[header.upperBound..<spacer.lowerBound]
        let combine = try #require(leading.range(of: ".accessibilityElement(children: .combine)"))
        let label = try #require(leading.range(of: "RemotePoolHeaderLabel(header: ProxyRoleCopy.remotePoolHeader("))
        #expect(combine.upperBound <= label.lowerBound,
                "the label must follow the wordmark's combined element, not sit inside it")
        // The role the lifecycle acts on, so a remembered remote role shows
        // before the first read (#788 added the hub beside it).
        let call = try #require(leading.range(of: "))", range: label.upperBound..<leading.endIndex))
        #expect(leading[label.upperBound..<call.lowerBound].contains("role: proxyModel.proxyRole,"))

        let bodyStart = try #require(deck.range(of: "var body: some View {"))
        let bodyEnd = try #require(deck.range(of: "Divider()", range: bodyStart.upperBound..<deck.endIndex))
        #expect(!deck[bodyStart.upperBound..<bodyEnd.lowerBound].contains("RemotePoolHeaderLabel"),
                "the label moved into the deck's row stack")

        // The label is a leaf with its own spoken name; it combines nothing.
        let view = try Self.block(in: deck[...], openingAt: "struct RemotePoolHeaderLabel: View {")
        #expect(view.contains(".accessibilityLabel(ProxyRoleCopy.remotePoolAccessibilityLabel)"))
        #expect(!view.contains(".accessibilityElement("))
    }

    /// The startup ordering rests on three facts in the app: the onboarding
    /// model starts from the lifecycle's remembered role, every fresh state
    /// applies the role synchronously (not in a Task, which could run after
    /// the launch-time evaluation), and the launch evaluates the proxy only
    /// after the first read.
    @Test("TRIPWIRE role-before-launch-decision: one remembered role, applied on every state, before the launch evaluates")
    func appAppliesTheRoleBeforeTheLaunchDecision() throws {
        let app = try Self.source("Sources/ModelDeckMac/ModelDeckMacApp.swift")
        #expect(app.contains("proxyRole: managedProxyModel.proxyRole"))

        let hook = try #require(app.range(of: "statusModel.onStateUpdate = {"))
        let firstTask = try #require(app.range(of: "Task {", range: hook.upperBound..<app.endIndex))
        let synchronous = app[hook.upperBound..<firstTask.lowerBound]
        #expect(synchronous.contains("managedProxyModel?.applyProxyRole(state.proxyRole)"))
        #expect(synchronous.contains("proxyOnboardingModel?.applyProxyRole(state.proxyRole)"))

        let anchors = [
            "LaunchReconciliation.runAlongsideFirstRead(",
            "await managedProxyModel.evaluateOnLaunch()",
            "await proxyOnboardingModel.evaluateOnLaunch()",
        ]
        let positions = anchors.map { app.range(of: $0)?.lowerBound }
        #expect(positions.allSatisfy { $0 != nil })
        #expect(positions.compactMap { $0 } == positions.compactMap { $0 }.sorted())
    }

    /// Off the pool host there is no proxy of this Mac's own to enable or
    /// hand back, so Settings → Managed proxy may render neither control
    /// outside the role gate.
    @Test("TRIPWIRE settings-lifecycle-controls-behind-role-gate: Enable and Stop Managing render only inside it")
    func settingsControlsSitBehindTheRoleGate() throws {
        let views = try Self.source("Sources/ModelDeckMac/ManagedProxyOnboardingViews.swift")
        let section = try Self.block(in: views[...], openingAt: "struct ManagedProxySection: View {")
        let body = try Self.block(in: section, openingAt: "var body: some View {")
        let gate = try Self.block(in: body, openingAt: "if managedProxySettingsOffersActions(role: model.proxyRole) {")
        for control in ["stopManaging", "ManagedProxyOnboardingCopy.enableFromSettingsTitle"] {
            let inBody = body.components(separatedBy: control).count - 1
            let inGate = gate.components(separatedBy: control).count - 1
            #expect(inBody > 0, "\(control) no longer renders in the section; the tripwire must not pass on nothing")
            #expect(inBody == inGate, "TRIPWIRE settings-lifecycle-controls-behind-role-gate: \(control) renders outside the role gate")
        }
    }
}
