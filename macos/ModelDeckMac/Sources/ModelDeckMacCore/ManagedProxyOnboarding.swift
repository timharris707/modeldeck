import Foundation

// Issue #422 — 1.0 build D: the FIRST-LAUNCH surface for the managed proxy.
// One surface, two branches, per the #401 verdict and the onboarding addendum
// in docs/full-app-1.0-decision-map.md (2026-08-14):
//
//   1. An external CLIProxyAPI already answers on :8317 → offer ADOPTION.
//      Adopting stops the user's own job VISIBLY, names what it stopped and
//      how, and takes over the SAME config dir (#398 makes that
//      credential-migration-free). Declining = coexist: ModelDeck stays a
//      client of their instance and says WHY managed-only features are off.
//   2. Nothing answering → ONE consent screen, Enable pre-selected (tier-3
//      default, charter d4). Declining lands on tiers 1–2 and the upgrade
//      stays visible in Settings.
//
// The two rules that outrank everything here: NEVER silent coexistence and
// NEVER silent replacement. Structurally, that means every adoption attempt —
// success, failure, or refusal — produces an `AdoptionRecord` (TRIPWIRE
// adoption-never-silent), and no process is ever stopped outside an explicit
// user action in this flow.
//
// Slice C (#421) owns the lifecycle mechanics; this file owns the offer, the
// consent, the remembered choice, and the rollback's restore steps. As in
// slice C, everything side-effectful sits behind a protocol so tests never
// touch :8317, never read a real management key, and never stop a process.

// MARK: - Detection (a SINGLE named check)

/// Outcome of the ONE management call this flow makes: an authenticated
/// `GET /v0/management/config` with the key at `~/.config/cliproxyapi/.mgmt-key`
/// (src/paths.mjs CLIPROXY_MANAGEMENT_KEY_PATH). That endpoint is already the
/// project's named handshake — scripts/build-cliproxyapi.sh uses it for the
/// release handshake and test/cliproxyapi-pin-compat.test.mjs for the pin
/// suite — and it is non-destructive, unlike `/v0/management/usage-queue`,
/// whose read consumes the queue (#400).
///
/// Detection never walks a list of endpoints looking for one that answers:
/// probing management surfaces to see what sticks is credential exploration,
/// not identification.
public enum ManagementHandshake: Equatable, Sendable {
    /// The named endpoint authenticated with the existing key: this is
    /// CLIProxyAPI, and it is the user's own instance.
    case confirmed
    /// It answered, but the existing key didn't authenticate (401/403).
    case rejected
    /// No key file, or an empty one — nothing to handshake WITH.
    case keyUnavailable
    /// The call failed or answered in a shape the handshake can't read.
    case inconclusive
    /// The port was silent, so no management call was made at all.
    case notPerformed
}

/// One detection round-trip: does the port answer, and did the single named
/// handshake confirm it is CLIProxyAPI.
public struct ExternalProxyProbe: Equatable, Sendable {
    public var portAnswering: Bool
    public var handshake: ManagementHandshake

    public init(portAnswering: Bool, handshake: ManagementHandshake) {
        self.portAnswering = portAnswering
        self.handshake = handshake
    }

    public static let silent = ExternalProxyProbe(portAnswering: false, handshake: .notPerformed)
}

/// What is on the proxy port, as far as ONE port probe plus ONE management
/// handshake can honestly say.
public enum ExternalProxyDetection: Equatable, Sendable {
    /// Nothing answering — the fresh-install branch.
    case absent
    /// Confirmed CLIProxyAPI: the adoption offer's confident case.
    case cliProxyAPI
    /// Something answers on the port that the handshake could not confirm.
    /// Adoption is still OFFERED (the port is occupied either way, and the
    /// #400 rail already blocks a managed start), but the copy says plainly
    /// that ModelDeck could not confirm what it is.
    case unidentifiedListener(reason: String)
}

/// Pure classification of a detection round-trip.
public func classifyExternalProxy(_ probe: ExternalProxyProbe) -> ExternalProxyDetection {
    guard probe.portAnswering else { return .absent }
    switch probe.handshake {
    case .confirmed:
        return .cliProxyAPI
    case .rejected:
        return .unidentifiedListener(reason: ManagedProxyOnboardingCopy.handshakeRejectedReason)
    case .keyUnavailable:
        return .unidentifiedListener(reason: ManagedProxyOnboardingCopy.handshakeKeyMissingReason)
    case .inconclusive, .notPerformed:
        return .unidentifiedListener(reason: ManagedProxyOnboardingCopy.handshakeInconclusiveReason)
    }
}

// MARK: - Supervision of the user's own proxy

/// How the user's own CLIProxyAPI is kept running. Adoption has to name this
/// out loud: "we stopped your proxy" is only honest if it says which job and
/// by what command.
public enum ExternalProxySupervision: Equatable, Sendable, Codable {
    /// A launchd LaunchAgent (`~/Library/LaunchAgents/<file>.plist`) — the
    /// common shape for a proxy that survives logout.
    case launchAgent(label: String, plistPath: String)
    /// A bare process someone started by hand or from a shell profile.
    case plainProcess(pid: Int32, command: String)
    /// Something is on the port but ModelDeck can't identify what keeps it
    /// there. Adoption REFUSES here rather than half-stopping it.
    case unknown
}

/// What adoption would do, derived only from the supervision shape. Pure so
/// the copy — the part the user reads before consenting — is unit-tested.
public enum AdoptionPlan: Equatable, Sendable {
    case stopLaunchAgent(label: String, plistPath: String)
    case terminateProcess(pid: Int32, command: String)
    /// The honest stop: ModelDeck can't stop this safely, so it won't try.
    case refuse(reason: String)

    /// WHAT would be stopped, in the user's own terms.
    public var targetDescription: String {
        switch self {
        case .stopLaunchAgent(let label, _):
            return "your launchd job \(label)"
        case .terminateProcess(let pid, let command):
            return "your proxy process \(pid) (\(command))"
        case .refuse:
            return "nothing"
        }
    }

    /// HOW it would be stopped — the literal command or signal, never a vague
    /// "shut down your proxy".
    public var actionDescription: String {
        switch self {
        case .stopLaunchAgent(let label, _):
            return "launchctl bootout gui/$(id -u)/\(label)"
        case .terminateProcess(let pid, _):
            return "SIGTERM to pid \(pid)"
        case .refuse:
            return "no command was run"
        }
    }
}

/// Maps a discovered supervision onto the plan. `.unknown` refuses: a proxy
/// ModelDeck cannot name is a proxy it must not stop.
public func planAdoption(for supervision: ExternalProxySupervision) -> AdoptionPlan {
    switch supervision {
    case .launchAgent(let label, let plistPath):
        return .stopLaunchAgent(label: label, plistPath: plistPath)
    case .plainProcess(let pid, let command):
        return .terminateProcess(pid: pid, command: command)
    case .unknown:
        return .refuse(reason: ManagedProxyOnboardingCopy.cannotIdentifySupervisionReason)
    }
}

// MARK: - The visible record (TRIPWIRE adoption-never-silent)

/// The record adoption ALWAYS emits. Its existence is the never-silent rule
/// made structural: there is no adoption path — success, failed stop, or
/// refusal — that produces no record, and every record names what was
/// stopped and by what command.
public struct AdoptionRecord: Equatable, Sendable {
    public enum Outcome: Equatable, Sendable {
        /// The user's proxy is stopped and ModelDeck now manages one.
        case nowManaged
        /// The stop was attempted and something is still on the port.
        case stopFailed(reason: String)
        /// ModelDeck declined to try; nothing on the machine changed.
        case refused(reason: String)
    }

    public var outcome: Outcome
    /// What was stopped (or "nothing").
    public var stoppedWhat: String
    /// The exact command or signal used.
    public var stoppedHow: String
    public var headline: String
    /// The body of the visible record, one plain line each.
    public var lines: [String]

    public init(
        outcome: Outcome,
        stoppedWhat: String,
        stoppedHow: String,
        headline: String,
        lines: [String]
    ) {
        self.outcome = outcome
        self.stoppedWhat = stoppedWhat
        self.stoppedHow = stoppedHow
        self.headline = headline
        self.lines = lines
    }

    public var succeeded: Bool { outcome == .nowManaged }
}

/// Builds the visible record from what actually happened. `portStillAnswering`
/// is re-probed AFTER the stop: claiming a takeover while the old instance is
/// still serving would be exactly the silent-replacement failure the #401
/// verdict rules out.
public func adoptionRecord(
    plan: AdoptionPlan,
    stopSucceeded: Bool,
    portStillAnswering: Bool,
    configDirectory: String
) -> AdoptionRecord {
    if case .refuse(let reason) = plan {
        return AdoptionRecord(
            outcome: .refused(reason: reason),
            stoppedWhat: plan.targetDescription,
            stoppedHow: plan.actionDescription,
            headline: ManagedProxyOnboardingCopy.adoptionRefusedHeadline,
            lines: [
                reason,
                "ModelDeck stopped nothing and changed nothing on this Mac.",
                "Stop your proxy yourself and reopen ModelDeck, or keep using it as a client of the proxy you already run.",
            ]
        )
    }
    guard stopSucceeded, !portStillAnswering else {
        let reason = stopSucceeded
            ? "Something is still answering on port \(ManagedProxyDefaults.port) after the stop."
            : "The stop command did not succeed."
        return AdoptionRecord(
            outcome: .stopFailed(reason: reason),
            stoppedWhat: plan.targetDescription,
            stoppedHow: plan.actionDescription,
            headline: ManagedProxyOnboardingCopy.adoptionFailedHeadline,
            lines: [
                "ModelDeck tried to stop \(plan.targetDescription) with: \(plan.actionDescription).",
                reason,
                "ModelDeck did not start its own proxy — two proxies would each drain half the usage queue.",
            ]
        )
    }
    return AdoptionRecord(
        outcome: .nowManaged,
        stoppedWhat: plan.targetDescription,
        stoppedHow: plan.actionDescription,
        headline: ManagedProxyOnboardingCopy.adoptionSucceededHeadline,
        lines: [
            "Stopped \(plan.targetDescription) with: \(plan.actionDescription).",
            "ModelDeck now manages your proxy, using the same configuration and sign-ins at \(configDirectory) — nothing was copied or migrated.",
            "You can hand it back any time: Settings → General → Stop Managing prints the exact steps to restart your own job.",
        ]
    )
}

/// Issue #784: adoption's refusal on a Mac that is not the pool host. Its
/// proxy port belongs to the forwarder that reaches the host, so nothing was
/// inspected or stopped — and unlike the generic refusal, the record never
/// suggests stopping what is on the port.
public func remoteRoleAdoptionRecord() -> AdoptionRecord {
    let plan = AdoptionPlan.refuse(reason: ProxyRoleCopy.remoteReason)
    return AdoptionRecord(
        outcome: .refused(reason: ProxyRoleCopy.remoteReason),
        stoppedWhat: plan.targetDescription,
        stoppedHow: plan.actionDescription,
        headline: ManagedProxyOnboardingCopy.adoptionRefusedHeadline,
        lines: [
            ProxyRoleCopy.remoteReason,
            "ModelDeck stopped nothing and changed nothing on this Mac.",
        ]
    )
}

// MARK: - Rollback (honest-uninstall style)

/// The concrete steps the user's OWN setup needs to take the proxy back.
public struct RestoreInstructions: Equatable, Sendable {
    public var headline: String
    /// Literal commands, in order. Empty only when there is nothing to
    /// restore, and then `note` says so.
    public var steps: [String]
    public var note: String?

    public init(headline: String, steps: [String], note: String? = nil) {
        self.headline = headline
        self.steps = steps
        self.note = note
    }

    /// What the Copy button puts on the clipboard.
    public var clipboardText: String { steps.joined(separator: "\n") }
}

/// Restore steps for whatever adoption originally stopped. `uid` is the live
/// user id so the printed launchctl domain is the one the user must type.
public func managedProxyRestoreInstructions(
    for supervision: ExternalProxySupervision?,
    uid: UInt32
) -> RestoreInstructions {
    switch supervision {
    case .launchAgent(let label, let plistPath):
        return RestoreInstructions(
            headline: "ModelDeck stopped managing the proxy. To put your launchd job back in charge:",
            steps: [
                "launchctl bootstrap gui/\(uid) \(plistPath)",
                "launchctl kickstart -k gui/\(uid)/\(label)",
            ],
            note: "Your configuration and sign-ins never moved — they are still in \(ManagedProxyOnboardingCopy.configDirectoryDisplay)."
        )
    case .plainProcess(_, let command):
        return RestoreInstructions(
            headline: "ModelDeck stopped managing the proxy. You were running it yourself; start it again with:",
            steps: [command],
            note: "The pid ModelDeck stopped is gone, so the old process id no longer applies. Your configuration and sign-ins are unchanged in \(ManagedProxyOnboardingCopy.configDirectoryDisplay)."
        )
    case .unknown, .none:
        return RestoreInstructions(
            headline: "ModelDeck stopped managing the proxy.",
            steps: [],
            note: "ModelDeck never stopped a proxy of yours, so there is nothing to restore. If you ran one before, start it the way you normally do. Your configuration and sign-ins are unchanged in \(ManagedProxyOnboardingCopy.configDirectoryDisplay)."
        )
    }
}

// MARK: - The remembered choice

/// What the user chose at first launch. Recorded so the flow asks ONCE; every
/// value is revisitable in Settings, never re-prompted at launch.
public enum ManagedProxyOnboardingChoice: String, Codable, Equatable, Sendable {
    /// Adopted an external instance; ModelDeck manages the proxy now.
    case adopted
    /// Declined adoption: ModelDeck stays a client of their instance.
    case coexist
    /// Fresh install, consent given.
    case managedEnabled
    /// Fresh install, consent declined: tiers 1–2 only.
    case managedDeclined

    /// Whether ModelDeck should be running its own proxy under this choice.
    public var wantsManagedProxy: Bool {
        self == .adopted || self == .managedEnabled
    }
}

/// Where the choice (and what adoption stopped, for the rollback steps) is
/// remembered. `AnyObject` for the same reason as slice C's marker store: the
/// model mutates it.
public protocol ManagedProxyOnboardingStoring: AnyObject, Sendable {
    var choice: ManagedProxyOnboardingChoice? { get set }
    /// The supervision adoption took over from — the ONLY input the rollback
    /// steps have about the user's own setup, so it has to outlive the launch
    /// that adopted.
    var adoptedSupervision: ExternalProxySupervision? { get set }
}

// MARK: - The branch

/// Which first-launch surface to show, if any.
public enum FirstLaunchBranch: Equatable, Sendable {
    /// Nothing to ask: already decided, or a build with no proxy to manage.
    case none
    case adoptionOffer(ExternalProxyDetection)
    case consent
}

/// The whole first-launch decision, kept pure. Precedence:
/// 1. no bundled binary → dev build, ask nothing (slice C's
///    dev-build-never-offers rule);
/// 2. the user already answered → never ask again (Settings owns revisits);
/// 3. something on the port → the adoption offer;
/// 4. otherwise → the consent screen.
public func decideFirstLaunch(
    bundleAvailable: Bool,
    recordedChoice: ManagedProxyOnboardingChoice?,
    detection: ExternalProxyDetection
) -> FirstLaunchBranch {
    guard bundleAvailable else { return .none }
    guard recordedChoice == nil else { return .none }
    return detection == .absent ? .consent : .adoptionOffer(detection)
}

/// Whether slice C's lifecycle may run AT ALL this launch. The never-silent-on
/// rule applied to the launch sequence: a build that can manage a proxy still
/// starts nothing until the user has answered the one first-launch question,
/// and a user who declined (or chose to coexist) stays declined across every
/// later launch until they change it in Settings.
public func managedProxyMayRunAtLaunch(
    recordedChoice: ManagedProxyOnboardingChoice?
) -> Bool {
    recordedChoice?.wantsManagedProxy == true
}

/// Whether the deck may offer Start / Try Again for the bundled proxy under
/// this choice. Same rule as launch: a user who runs their own proxy
/// (`coexist`), declined a managed one, or has not answered yet gets no way
/// to start the bundled binary from the deck.
///
/// Field incident, 2026-09-01: under a recorded `coexist` the launch-time
/// stop left the lifecycle in `.stopped`, the deck rendered that as
/// "Proxy stopped · Start", and one click during an outage put the bundled
/// (pinned, older) binary on the port ahead of the user's own upgraded
/// launch agent, which then failed to bind for two days.
public func managedProxyStartOffered(
    recordedChoice: ManagedProxyOnboardingChoice?
) -> Bool {
    managedProxyMayRunAtLaunch(recordedChoice: recordedChoice)
}

/// Issue #784: whether Settings → General → Managed proxy offers Enable or
/// Stop Managing at all. Not on a Mac that uses the pool on another machine:
/// there is no proxy of its own to manage, and the section says why instead.
public func managedProxySettingsOffersActions(role: ProxyRole) -> Bool {
    role != .remote
}

// MARK: - Copy

/// Every user-visible string in the flow, in one place so the tests can hold
/// the honest-copy rules (names what was stopped, states why a feature is
/// off, never implies a silent change).
public enum ManagedProxyOnboardingCopy {
    public static let configDirectoryDisplay = "~/.config/cliproxyapi"

    // Detection reasons
    public static let handshakeRejectedReason =
        "Something is answering on port \(ManagedProxyDefaults.port), but ModelDeck's existing management key didn't authenticate with it."
    public static let handshakeKeyMissingReason =
        "Something is answering on port \(ManagedProxyDefaults.port). There's no management key at \(configDirectoryDisplay)/.mgmt-key, so ModelDeck couldn't confirm what it is."
    public static let handshakeInconclusiveReason =
        "Something is answering on port \(ManagedProxyDefaults.port), but it didn't respond to CLIProxyAPI's management check."

    // Adoption offer
    public static let adoptionTitle = "ModelDeck can manage your proxy"
    public static let adoptionConfirmedBody =
        "You're already running CLIProxyAPI on port \(ManagedProxyDefaults.port). ModelDeck can take over keeping it running — same configuration, same sign-ins, same folder (\(configDirectoryDisplay)). Nothing is copied or migrated."
    public static let adoptionUnidentifiedBody =
        "ModelDeck couldn't confirm what's on port \(ManagedProxyDefaults.port). If it's your own CLIProxyAPI, ModelDeck can take over keeping it running — same configuration and folder (\(configDirectoryDisplay)). If it's something else, leave it alone."
    public static let adoptButtonTitle = "Let ModelDeck Manage It"
    public static let declineAdoptionButtonTitle = "Leave It Alone"
    public static let adoptionWorkingMessage = "Stopping your proxy and taking over…"

    public static let adoptionSucceededHeadline = "ModelDeck now manages your proxy"
    public static let adoptionFailedHeadline = "ModelDeck couldn't take over your proxy"
    public static let adoptionRefusedHeadline = "ModelDeck didn't touch your proxy"
    public static let cannotIdentifySupervisionReason =
        "ModelDeck couldn't identify what keeps the proxy on port \(ManagedProxyDefaults.port) running — no matching launchd job and no process it can name — so it won't try to stop it."

    // Coexist (decline adoption)
    public static let coexistTitle = "ModelDeck is using the proxy you already run"
    /// The REASON half of "managed-only features show unavailable WITH the
    /// reason" — never a bare disabled control.
    public static let coexistUnavailableReason =
        "Your own CLIProxyAPI is on port \(ManagedProxyDefaults.port), so ModelDeck reads from it as a client but doesn't start, stop, or restart it. Starting, restarting after a crash, and version pinning stay off while you manage it yourself."

    // Fresh-install consent
    public static let consentTitle = "Enable measured usage truth?"
    public static let consentBody =
        "ModelDeck runs a managed proxy locally, on this Mac only. With it, your usage numbers are measured from real requests instead of estimated, and pooled subscriptions get per-subscription attribution. It listens on 127.0.0.1:\(ManagedProxyDefaults.port), stores its state in \(configDirectoryDisplay), and sends nothing anywhere else."
    public static let consentEnableTitle = "Enable"
    public static let consentDeclineTitle = "Not Now"
    /// What declining honestly costs — no dark pattern, no nagging.
    public static let consentDeclinedReason =
        "Usage comes from local logs and your plan's own quota windows — accurate for windows and limits, estimated for token counts, with no per-subscription attribution for pooled subscriptions. You can turn the managed proxy on any time in Settings → General."

    // Settings
    public static let settingsSectionTitle = "Managed proxy"
    public static let stopManagingTitle = "Stop Managing"
    public static let stopManagingExplanation =
        "ModelDeck stops its proxy and hands the port back. It will print the exact commands your own setup needs to take over again."
    public static let enableFromSettingsTitle = "Enable Managed Proxy"

    /// The choice, as one plain line in Settings. Issue #784: in remote role
    /// the line is the daemon's own reason instead — the choice still stands
    /// for when this Mac hosts the pool again.
    public static func settingsSummary(
        for choice: ManagedProxyOnboardingChoice?,
        role: ProxyRole = .host
    ) -> String {
        if role == .remote { return ProxyRoleCopy.remoteReason }
        switch choice {
        case .adopted:
            return "ModelDeck manages the proxy — it took over the one you were running."
        case .managedEnabled:
            return "ModelDeck manages the proxy on this Mac."
        case .coexist:
            return coexistUnavailableReason
        case .managedDeclined:
            return consentDeclinedReason
        case .none:
            return "ModelDeck hasn't been asked about the proxy yet."
        }
    }
}

// MARK: - Seams

/// ONE detection round-trip: port probe + the single named management
/// handshake. One method on purpose — a caller can't turn this into endpoint
/// exploration by composing extra calls.
public protocol ExternalProxyDetecting: Sendable {
    func detectExternalProxy() async -> ExternalProxyProbe
}

/// Discovers how the user's own proxy is supervised. Read-only.
public protocol ExternalProxySupervisionInspecting: Sendable {
    func inspectSupervision() async -> ExternalProxySupervision
}

/// Stops the user's own proxy. Called from exactly ONE place — `adopt()`,
/// behind an explicit button — and never for a `.refuse` plan.
public protocol ExternalProxyStopping: Sendable {
    /// True iff the stop command reported success. The caller re-probes the
    /// port regardless; a success claim is never taken on trust.
    func stopExternalProxy(_ plan: AdoptionPlan) async -> Bool
}

// MARK: - Model

/// The first-launch surface's state machine. Owns the offer, the consent, the
/// remembered choice, and the rollback's restore steps; slice C's
/// `ManagedProxyModel` still owns every lifecycle mechanic, reached here only
/// through the two callbacks.
@MainActor
public final class ManagedProxyOnboardingModel: ObservableObject {
    public enum Phase: Equatable, Sendable {
        /// Nothing to show. Healthy steady state.
        case hidden
        case adoptionOffer(ExternalProxyDetection)
        case working(String)
        /// The visible record of an adoption attempt. Reached by EVERY
        /// adoption path — that is the never-silent rule.
        case record(AdoptionRecord)
        case consent
    }

    public struct Dependencies {
        public var detector: any ExternalProxyDetecting
        public var supervision: any ExternalProxySupervisionInspecting
        public var stopper: any ExternalProxyStopping
        public var store: any ManagedProxyOnboardingStoring
        /// Slice C's `startManaging()` / `stopManaging()`.
        public var startManagedProxy: @MainActor () async -> Void
        public var adoptManagedProxy: @MainActor () async -> Void
        public var stopManagedProxy: @MainActor () async -> Void
        /// Whether this build has a proxy to manage at all (slice C's bundle).
        public var bundleAvailable: Bool
        public var configDirectoryDisplay: String
        public var uid: UInt32

        public init(
            detector: any ExternalProxyDetecting,
            supervision: any ExternalProxySupervisionInspecting,
            stopper: any ExternalProxyStopping,
            store: any ManagedProxyOnboardingStoring,
            bundleAvailable: Bool,
            configDirectoryDisplay: String = ManagedProxyOnboardingCopy.configDirectoryDisplay,
            uid: UInt32 = getuid(),
            startManagedProxy: @escaping @MainActor () async -> Void,
            stopManagedProxy: @escaping @MainActor () async -> Void,
            adoptManagedProxy: (@MainActor () async -> Void)? = nil
        ) {
            self.detector = detector
            self.supervision = supervision
            self.stopper = stopper
            self.store = store
            self.bundleAvailable = bundleAvailable
            self.configDirectoryDisplay = configDirectoryDisplay
            self.uid = uid
            self.startManagedProxy = startManagedProxy
            self.adoptManagedProxy = adoptManagedProxy ?? startManagedProxy
            self.stopManagedProxy = stopManagedProxy
        }
    }

    @Published public private(set) var phase: Phase = .hidden
    /// The last adoption attempt's record, kept after the card is dismissed so
    /// Settings can still show what ModelDeck did.
    @Published public private(set) var lastAdoptionRecord: AdoptionRecord?
    /// Set by `stopManagingProxy()`; the rollback's printed steps.
    @Published public private(set) var restoreInstructions: RestoreInstructions?
    /// Issue #784: the pool role the app acts on — the remembered one at
    /// launch, then the latest state's. The question is asked on host only.
    @Published public private(set) var proxyRole: ProxyRole

    public var choice: ManagedProxyOnboardingChoice? { deps.store.choice }

    private let deps: Dependencies
    /// Issue #784: the launch question was due while the role was remote, so
    /// a host role asks it then.
    private var launchQuestionPending = false

    /// `proxyRole` is the role the lifecycle remembered (the app passes the
    /// managed proxy model's); host, today's behaviour, when none is.
    public init(dependencies: Dependencies, proxyRole: ProxyRole = .host) {
        self.deps = dependencies
        self.proxyRole = proxyRole
    }

    // MARK: Launch

    /// Called once from the app's launch sequence, after slice C's evaluation
    /// (and by `applyProxyRole` when the host role it waited for arrives).
    /// Asks at most one question, and only if the user has never answered.
    public func evaluateOnLaunch() async {
        guard deps.bundleAvailable, deps.store.choice == nil else {
            phase = .hidden
            return
        }
        // Issue #784: asked on the pool host only. Elsewhere port 8317 is the
        // forwarder's: the adoption offer would offer to stop it, the consent
        // screen to start a proxy on its port, and detection would send the
        // management handshake through it.
        guard proxyRole == .host else {
            deferLaunchQuestion()
            return
        }
        let detection = classifyExternalProxy(await deps.detector.detectExternalProxy())
        // The role may have moved while detection was out.
        guard proxyRole == .host else {
            deferLaunchQuestion()
            return
        }
        switch decideFirstLaunch(
            bundleAvailable: deps.bundleAvailable,
            recordedChoice: deps.store.choice,
            detection: detection
        ) {
        case .none:
            phase = .hidden
        case .adoptionOffer(let detection):
            phase = .adoptionOffer(detection)
        case .consent:
            phase = .consent
        }
    }

    // MARK: Pool role (issue #784)

    /// Applies the role from a fresh daemon state, synchronously and in state
    /// order. A host role asks a launch question that was waiting for it (in
    /// the returned task; tests await it, the app fires and forgets). A
    /// remote role withdraws a card that is up — withdrawn, not answered, so
    /// it is asked again if the role returns to host.
    @discardableResult
    public func applyProxyRole(_ role: ProxyRole) -> Task<Void, Never>? {
        guard role != proxyRole else { return nil }
        proxyRole = role
        switch role {
        case .remote:
            switch phase {
            case .adoptionOffer, .consent:
                deferLaunchQuestion()
            case .hidden, .working, .record:
                break
            }
            return nil
        case .host:
            guard launchQuestionPending else { return nil }
            launchQuestionPending = false
            return Task { await self.evaluateOnLaunch() }
        }
    }

    private func deferLaunchQuestion() {
        phase = .hidden
        launchQuestionPending = true
    }

    // MARK: Adoption branch

    /// The one place a process the user started is ever stopped, and only
    /// from the explicit button. Every exit emits a record.
    public func adopt() async {
        // Issue #784: only the pool host adopts. Elsewhere the port belongs
        // to the forwarder that reaches the host, so nothing is inspected or
        // stopped, and the refusal is recorded like every other exit.
        guard proxyRole == .host else {
            finish(record: remoteRoleAdoptionRecord())
            return
        }
        phase = .working(ManagedProxyOnboardingCopy.adoptionWorkingMessage)
        let supervision = await deps.supervision.inspectSupervision()
        // Re-checked after the inspection: a role that moved meanwhile stops
        // nothing.
        guard proxyRole == .host else {
            finish(record: remoteRoleAdoptionRecord())
            return
        }
        let plan = planAdoption(for: supervision)

        if case .refuse = plan {
            // Nothing was stopped and nothing was recorded as a choice: the
            // machine is unchanged, so the offer is still open next launch.
            finish(record: adoptionRecord(
                plan: plan,
                stopSucceeded: false,
                portStillAnswering: true,
                configDirectory: deps.configDirectoryDisplay
            ))
            return
        }

        let stopped = await deps.stopper.stopExternalProxy(plan)
        // Never trust the stop's own word: re-probe the port.
        let stillAnswering = await deps.detector.detectExternalProxy().portAnswering
        let record = adoptionRecord(
            plan: plan,
            stopSucceeded: stopped,
            portStillAnswering: stillAnswering,
            configDirectory: deps.configDirectoryDisplay
        )
        if record.succeeded {
            deps.store.choice = .adopted
            deps.store.adoptedSupervision = supervision
            await deps.adoptManagedProxy()
        }
        finish(record: record)
    }

    /// Decline adoption = coexist, recorded so the offer never returns, with
    /// the reason managed-only features are off stated out loud.
    public func declineAdoption() {
        deps.store.choice = .coexist
        phase = .hidden
    }

    // MARK: Consent branch

    /// The pre-selected default (tier-3, charter d4).
    public func enableManagedProxy() async {
        deps.store.choice = .managedEnabled
        phase = .hidden
        await deps.startManagedProxy()
    }

    public func declineManagedProxy() {
        deps.store.choice = .managedDeclined
        phase = .hidden
    }

    // MARK: Rollback

    /// The "stop managing" affordance: detach cleanly, then PRINT what the
    /// user's own setup needs to take over again.
    public func stopManagingProxy() async {
        await deps.stopManagedProxy()
        let supervision = deps.store.adoptedSupervision
        // .coexist claims the user runs their OWN proxy — true only when
        // adoption took one over (PR #433 review). A fresh managed install
        // that stops managing has nothing on the port and nothing to
        // restore; that state is .managedDeclined, and the restore
        // instructions say so honestly.
        deps.store.choice = supervision == nil ? .managedDeclined : .coexist
        restoreInstructions = managedProxyRestoreInstructions(for: supervision, uid: deps.uid)
        phase = .hidden
    }

    /// The upgrade path from a declined/coexist state, offered only in
    /// Settings — the flow never re-prompts at launch.
    public func enableFromSettings() async {
        deps.store.choice = .managedEnabled
        restoreInstructions = nil
        phase = .hidden
        await deps.startManagedProxy()
    }

    public func dismissRecord() {
        if case .record = phase { phase = .hidden }
    }

    public func dismissRestoreInstructions() {
        restoreInstructions = nil
    }

    /// Records and shows, in that order — the single exit from `adopt()`.
    private func finish(record: AdoptionRecord) {
        lastAdoptionRecord = record
        phase = .record(record)
    }
}
