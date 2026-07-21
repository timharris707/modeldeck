import Foundation

// Issue #96 — one-DMG app half. The app owns the lifecycle of the bundled
// daemon (Contents/Resources/daemon/modeldeckd, staged by release-dmg.sh):
// first-run consent → SMAppService registration → Keychain mutation token →
// re-register on MDGitCommit drift → graceful coexistence with a legacy
// scripts/install-launch-agent.sh install.
//
// Everything side-effectful lives behind the protocols below so the state
// machine is fully unit-testable and tests NEVER touch the real
// SMAppService, Keychain, launchctl, or a live daemon.

// MARK: - Seams

/// Mirror of `SMAppService.Status`, decoupled from ServiceManagement so the
/// state machine and its tests don't import the framework.
public enum ServiceRegistrationStatus: Equatable, Sendable {
    /// Registered and permitted to run.
    case enabled
    /// Registered but the user must approve it in System Settings → Login Items.
    case requiresApproval
    case notRegistered
    /// The service plist is missing from the bundle (dev builds via `swift run`).
    case notFound
    case unknown
}

/// Registration seam. The live implementation wraps
/// `SMAppService.agent(plistName:)`; tests use a fake.
public protocol DaemonServiceRegistrar: Sendable {
    var status: ServiceRegistrationStatus { get }
    func register() throws
    func unregister() throws
}

/// Keychain seam for the daemon's mutation token (service "modeldeck",
/// account "mutation-token" — the exact item scripts/set-mutation-token.sh
/// manages, and the one src/token.mjs reads at daemon startup).
///
/// Deliberately narrow: the token can be created and its existence checked,
/// but its VALUE never crosses this boundary — so no caller can ever log or
/// display it.
public protocol MutationTokenStore: Sendable {
    func tokenExists() throws -> Bool
    /// Generate a fresh random token and store it. Must not overwrite an
    /// existing token. The value stays inside the implementation.
    func createToken() throws
}

/// Legacy dev install (scripts/install-launch-agent.sh →
/// ~/Library/LaunchAgents/ai.hermes.modeldeck.plist).
public protocol LegacyAgentInspecting: Sendable {
    func isLegacyAgentPresent() -> Bool
    /// Boot the legacy agent out of the gui domain and delete its plist.
    /// Only ever called from the explicit Settings takeover action.
    func removeLegacyAgent() throws
}

/// Where the app remembers which daemon build (MDGitCommit) it last
/// registered, for the drift comparison on later launches.
public protocol RegistrationMarkerStore: AnyObject, Sendable {
    var registeredCommit: String? { get set }
}

/// Loopback reachability of the daemon on the configured port.
public protocol DaemonReachabilityProbing: Sendable {
    func checkReachable() async -> Bool
}

// MARK: - Bundle manifest

/// scripts/write-daemon-manifest.mjs output, staged by release-dmg.sh at
/// Contents/Resources/daemon/manifest.json next to the binary.
public struct DaemonBundleManifest: Codable, Equatable, Sendable {
    public var artifact: String?
    public var nodeVersion: String?
    public var MDGitCommit: String?
    public var sha256: String?

    public init(artifact: String? = nil, nodeVersion: String? = nil,
                MDGitCommit: String? = nil, sha256: String? = nil) {
        self.artifact = artifact
        self.nodeVersion = nodeVersion
        self.MDGitCommit = MDGitCommit
        self.sha256 = sha256
    }

    public static func load(from bundle: Bundle) -> DaemonBundleManifest? {
        guard let url = bundle.url(forResource: "manifest", withExtension: "json",
                                   subdirectory: "daemon"),
              let data = try? Data(contentsOf: url)
        else { return nil }
        return try? JSONDecoder().decode(DaemonBundleManifest.self, from: data)
    }
}

// MARK: - Decision

/// What a launch evaluation concluded. Pure output of `decideDaemonSetup` —
/// the model maps it onto phases and performs the side effects.
public enum DaemonSetupDecision: Equatable, Sendable {
    /// No bundled daemon in this build (swift run / build_app.sh dev bundle).
    /// The existing "Daemon unreachable" banner covers the dev workflow;
    /// first-run UI stays out of the way.
    case bundledServiceUnavailable
    /// The registered service's recorded MDGitCommit differs from the
    /// bundle's manifest — replace the registration.
    case driftReregister(recorded: String?, bundled: String)
    /// Daemon answering on the loopback port; nothing to do.
    case running
    /// Legacy LaunchAgent installed but the daemon isn't answering. Never
    /// auto-install over it — takeover is an explicit Settings action.
    case legacyInstalledNotRunning
    /// Our registration exists but the user hasn't approved it in System
    /// Settings → Login Items yet.
    case awaitingApproval
    /// Registered and approved, but not answering (yet).
    case registeredNotRunning
    /// True first run: unreachable, nothing registered, no legacy install.
    case needsConsent
}

/// The launch-time decision, kept pure for tests. Precedence:
/// 1. no bundled daemon → dev build, stand down;
/// 2. registered + commit drift → re-register (even while running: the
///    running daemon is the OLD build);
/// 3. reachable → running;
/// 4. legacy plist present → never install over it;
/// 5. registration status → approval / retry / first-run consent.
public func decideDaemonSetup(
    reachable: Bool,
    registration: ServiceRegistrationStatus,
    legacyPresent: Bool,
    recordedCommit: String?,
    bundledCommit: String?
) -> DaemonSetupDecision {
    guard let bundledCommit, !bundledCommit.isEmpty else {
        return .bundledServiceUnavailable
    }
    if registration == .enabled, recordedCommit != bundledCommit {
        return .driftReregister(recorded: recordedCommit, bundled: bundledCommit)
    }
    if reachable { return .running }
    if legacyPresent { return .legacyInstalledNotRunning }
    switch registration {
    case .requiresApproval: return .awaitingApproval
    case .enabled: return .registeredNotRunning
    case .notRegistered, .notFound, .unknown: return .needsConsent
    }
}

// MARK: - System prompt coaching (issue #98)

/// Copy for the calm pre-prompt explainers around the two macOS prompts the
/// first-run flow triggers. Found in Tim's v0.3 hand test: an unexplained OS
/// password prompt from a just-installed app reads as a credential grab, and
/// a dismissed Keychain prompt silently strands the deck on stale data. The
/// copy lives in Core so tests can pin the load-bearing guidance ("Always
/// Allow", "once per account", "from macOS, not ModelDeck").
public enum SystemPromptCoaching {
    /// Rendered on the first-run consent card (issue #96's card — extended,
    /// not redesigned): frames the Login Items approval before macOS asks.
    public static let loginItemsConsentNote = "macOS will confirm this with its own system prompt, and may ask for your password. That request comes from macOS, not ModelDeck."

    /// Headline + body for the Keychain heads-up shown while the service is
    /// installing/starting — BEFORE its first refresh triggers the per-
    /// account Keychain prompts.
    public static let keychainHeadline = "Next: Keychain permission prompts"
    public static let keychainBody = "Once the service starts, macOS will ask permission for it to read each Claude account's sign-in from your Keychain — one prompt per account, from macOS itself. Choose Always Allow (it may ask for your password once per account); plain Allow asks again on every refresh. Properly signed app updates won't re-prompt."
}

// MARK: - Model

/// Launch-time coordinator for the bundled background service. Owned by the
/// app, surfaced in the popover (first-run consent card, declined state) and
/// in Settings → General (status + legacy takeover).
@MainActor
public final class DaemonSetupModel: ObservableObject {
    public enum Phase: Equatable, Sendable {
        case idle
        case checking
        /// Daemon reachable (or dev build without a bundled daemon —
        /// nothing for this surface to say).
        case quiet
        /// First run: show the consent card.
        case consentNeeded
        /// User said "Not Now". Deck stays in a clear not-running state
        /// with a retry affordance; nothing nags.
        case declined
        case installing
        /// Registered; user must approve in System Settings → Login Items.
        case awaitingApproval
        /// Registered + approved but the daemon isn't answering yet.
        case startingUp
        /// Legacy dev LaunchAgent present but not answering.
        case legacyNotRunning
        case failed(String)
    }

    public struct Dependencies {
        public var registrar: any DaemonServiceRegistrar
        public var tokenStore: any MutationTokenStore
        public var legacyAgent: any LegacyAgentInspecting
        public var marker: any RegistrationMarkerStore
        public var probe: any DaemonReachabilityProbing
        /// MDGitCommit from the bundle's daemon manifest; nil in dev builds.
        public var bundledCommit: String?

        public init(
            registrar: any DaemonServiceRegistrar,
            tokenStore: any MutationTokenStore,
            legacyAgent: any LegacyAgentInspecting,
            marker: any RegistrationMarkerStore,
            probe: any DaemonReachabilityProbing,
            bundledCommit: String?
        ) {
            self.registrar = registrar
            self.tokenStore = tokenStore
            self.legacyAgent = legacyAgent
            self.marker = marker
            self.probe = probe
            self.bundledCommit = bundledCommit
        }
    }

    @Published public private(set) var phase: Phase = .idle
    /// False in dev builds without a bundled daemon manifest — the entire
    /// surface (popover card + Settings section) stays hidden.
    public var bundledServiceAvailable: Bool {
        deps.bundledCommit?.isEmpty == false
    }
    /// Drives the Settings takeover section — independent of `phase`, since
    /// the legacy agent can be present while its daemon is happily running.
    @Published public private(set) var legacyAgentPresent = false
    /// Set when a drift re-register happened this launch; the UI notes it
    /// subtly ("Background service updated to match this app version").
    @Published public private(set) var didReregisterForUpdate = false
    /// Issue #98: true from the moment the user consents to an install (or
    /// legacy takeover) this session — the fresh registration means the
    /// daemon is NOT yet in the Claude credential items' ACLs, so its first
    /// refresh will trigger one macOS Keychain prompt per account. The card
    /// shows `SystemPromptCoaching.keychain*` while this is set. Never set
    /// by the drift re-register (a same-signature update keeps its ACL
    /// entries) or by plain launch evaluation.
    @Published public private(set) var keychainPromptCoachingActive = false

    private let deps: Dependencies
    /// Post-install reachability polling: attempts × delay. Injectable so
    /// tests run instantly.
    private let startupProbeAttempts: Int
    private let startupProbeDelay: @Sendable () async -> Void

    public init(
        dependencies: Dependencies,
        startupProbeAttempts: Int = 10,
        startupProbeDelay: @escaping @Sendable () async -> Void = {
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
    ) {
        self.deps = dependencies
        self.startupProbeAttempts = max(1, startupProbeAttempts)
        self.startupProbeDelay = startupProbeDelay
    }

    // MARK: Launch

    public func evaluateOnLaunch() async {
        phase = .checking
        legacyAgentPresent = deps.legacyAgent.isLegacyAgentPresent()
        let decision = decideDaemonSetup(
            reachable: await deps.probe.checkReachable(),
            registration: deps.registrar.status,
            legacyPresent: legacyAgentPresent,
            recordedCommit: deps.marker.registeredCommit,
            bundledCommit: deps.bundledCommit
        )
        switch decision {
        case .bundledServiceUnavailable, .running:
            phase = .quiet
        case .needsConsent:
            phase = .consentNeeded
        case .awaitingApproval:
            phase = .awaitingApproval
        case .registeredNotRunning:
            phase = .startingUp
        case .legacyInstalledNotRunning:
            phase = .legacyNotRunning
        case .driftReregister(_, let bundled):
            await reregister(bundledCommit: bundled)
        }
    }

    /// User clicked Install on the first-run consent card (or the Settings
    /// mirror). Token first, then registration, then wait for the service.
    public func consentToInstall() async {
        await install()
    }

    /// "Not Now" on the consent card. Clear not-running state; the retry
    /// affordance re-offers installation, nothing else nags.
    public func decline() {
        phase = .declined
    }

    /// Retry from the declined / failed / starting-up states.
    public func retry() async {
        await evaluateOnLaunch()
    }

    // MARK: Legacy takeover (explicit Settings action only)

    /// Adopt the bundled service: boot out + delete the legacy LaunchAgent,
    /// then run the normal install. Never called automatically.
    public func adoptBundledService() async {
        phase = .installing
        do {
            try deps.legacyAgent.removeLegacyAgent()
        } catch {
            phase = .failed("Couldn't remove the previous ModelDeck service: \(error.localizedDescription)")
            return
        }
        legacyAgentPresent = deps.legacyAgent.isLegacyAgentPresent()
        await install()
    }

    // MARK: Internals

    private func install() async {
        phase = .installing
        // Issue #98: from here on, the daemon's first refresh will hit the
        // per-account Keychain prompts — keep the coaching visible through
        // installing/approval/starting so the user knows what to click
        // before macOS asks.
        keychainPromptCoachingActive = true
        // Keychain token before first daemon start, so the daemon's startup
        // token resolution lands on source "keychain", never "ephemeral".
        do {
            if try !deps.tokenStore.tokenExists() {
                try deps.tokenStore.createToken()
            }
        } catch {
            phase = .failed("Couldn't prepare the service token in your Keychain: \(error.localizedDescription)")
            return
        }
        do {
            try deps.registrar.register()
        } catch {
            if deps.registrar.status == .requiresApproval {
                deps.marker.registeredCommit = deps.bundledCommit
                phase = .awaitingApproval
                return
            }
            phase = .failed("Couldn't register the background service: \(error.localizedDescription)")
            return
        }
        deps.marker.registeredCommit = deps.bundledCommit
        if deps.registrar.status == .requiresApproval {
            phase = .awaitingApproval
            return
        }
        await waitForDaemon()
    }

    private func reregister(bundledCommit: String) async {
        // Replace the registration so launchd picks up the new bundle's
        // service definition, then record the new commit.
        try? deps.registrar.unregister()
        do {
            try deps.registrar.register()
        } catch {
            // Same as install(): SMAppService can refuse register() while
            // flipping to requiresApproval — that's a user gate, not a
            // failure.
            if deps.registrar.status == .requiresApproval {
                deps.marker.registeredCommit = bundledCommit
                didReregisterForUpdate = true
                phase = .awaitingApproval
                return
            }
            phase = .failed("Couldn't update the background service: \(error.localizedDescription)")
            return
        }
        deps.marker.registeredCommit = bundledCommit
        didReregisterForUpdate = true
        // The unregister/register round-trip can revoke Login Items
        // approval; polling a daemon that isn't allowed to start would just
        // strand the UI in "starting up" — route to the approval state.
        if deps.registrar.status == .requiresApproval {
            phase = .awaitingApproval
            return
        }
        await waitForDaemon()
    }

    private func waitForDaemon() async {
        phase = .startingUp
        for attempt in 0..<startupProbeAttempts {
            if attempt > 0 { await startupProbeDelay() }
            if await deps.probe.checkReachable() {
                phase = .quiet
                return
            }
        }
        // Still starting (or failing); leave the retry affordance up.
        phase = .startingUp
    }
}
