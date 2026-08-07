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

/// One decoded `/api/health` answer. "The daemon answered but predates
/// self-reporting" (a snapshot with a nil commit) and "no answer" (no
/// snapshot at all) must never be conflated: the first is the stale-process
/// signal, the second is plain unreachability. Keeping both in one value
/// also forces every evaluation to use a SINGLE health round-trip — with
/// separate reachability and commit requests, a transient failure between
/// them would read as "reachable but no commit" and boot out a healthy
/// daemon (CodeRabbit, PR #223).
public struct DaemonProbeSnapshot: Equatable, Sendable {
    /// The RUNNING daemon's self-reported build commit (`MDGitCommit`);
    /// nil for pre-0.3.17 daemons that don't self-report.
    public var runningCommit: String?
    public init(runningCommit: String? = nil) {
        self.runningCommit = runningCommit
    }
}

/// Loopback reachability of the daemon on the configured port.
public protocol DaemonReachabilityProbing: Sendable {
    /// A single `/api/health` round-trip: nil iff the daemon didn't answer.
    func probeDaemon() async -> DaemonProbeSnapshot?
}

/// launchd-level control of our SMAppService agent, below the SMAppService
/// API. Needed because SMAppService.register()/unregister() can silently
/// no-op at the BTM layer while a stale daemon process keeps running (and
/// its stale job record then makes every respawn fail EX_CONFIG). The live
/// implementation shells out to /bin/launchctl for the gui domain.
/// What `launchctl print` said about our service. Three-valued on purpose:
/// only a CONFIRMED absence may trigger the wedge repair — a probe that
/// failed for any other reason (launchctl couldn't run, permission trouble,
/// an exit code we don't recognize) must read as "don't know", never as
/// "absent" (CodeRabbit, PR #223).
public enum LaunchdServiceProbe: Equatable, Sendable {
    /// Exit 0: the service exists in the launchd domain.
    case loaded
    /// launchctl's "could not find service" — the confirmed-absent state
    /// the wedge repair keys on.
    case notFound
    /// The probe itself failed; treat as loaded for repair purposes.
    case unknown
}

/// `launchctl print` exit-code classification, kept pure for tests. 113 is
/// launchctl's stable "could not find service" status; anything else that
/// isn't success — including our runner's synthetic 127 for "launchctl
/// couldn't run at all" — is an unknown probe outcome, not evidence of
/// absence.
public func classifyLaunchctlPrintExit(_ code: Int32) -> LaunchdServiceProbe {
    switch code {
    case 0: return .loaded
    case 113: return .notFound
    default: return .unknown
    }
}

public protocol LaunchdServiceControlling: Sendable {
    /// Probes `launchctl print gui/<uid>/<label>`. `.notFound` + registrar
    /// `.enabled` is the wedged state observed live after a manual bootout:
    /// SMAppService still says enabled, launchd has nothing, register()
    /// no-ops. Async by contract: the model runs on the main actor and
    /// launchctl must never block it.
    func probeService() async -> LaunchdServiceProbe
    /// `launchctl bootout gui/<uid>/<label>` — kills the running process
    /// AND removes the stale job record that references the old bundle.
    /// Best-effort: booting out an absent service is already the goal state.
    func bootOutService() async
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
    /// SMAppService claims `.enabled` but the launchd gui domain has no such
    /// service (observed live after a manual bootout, and the end state of
    /// the 0.3.13→0.3.15 stale-record incident once the old process died:
    /// "spawn failed", synthesized exit 78 EX_CONFIG). Plain register()
    /// no-ops here — route to the forced bootout + fresh-register repair.
    case wedgedServiceRepair(bundled: String)
    /// Our registration, our recorded commit — but the RUNNING process
    /// self-reports a different build (or none: pre-0.3.17 daemons don't
    /// self-report). The marker comparison can't see this: the incident
    /// daemon survived TWO upgrades because each drift re-register advanced
    /// the marker while the old process kept answering. Forced restart.
    case staleDaemonRestart(running: String?, bundled: String)
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
/// 3. registered + answering, but the running process self-reports a build
///    other than the bundle's → forced restart (the marker can't see this);
/// 4. registered but absent from launchd AND not answering → wedged
///    (register() would no-op; needs the forced repair). A daemon that IS
///    answering without a launchd job is a hand-started dev daemon — leave
///    it alone, same courtesy as rule 5;
/// 5. reachable → running;
/// 6. legacy plist present → never install over it;
/// 7. registration status → approval / retry / first-run consent.
public func decideDaemonSetup(
    probe: DaemonProbeSnapshot?,
    registration: ServiceRegistrationStatus,
    launchdService: LaunchdServiceProbe,
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
    if registration == .enabled, let probe, probe.runningCommit != bundledCommit {
        return .staleDaemonRestart(running: probe.runningCommit, bundled: bundledCommit)
    }
    if registration == .enabled, launchdService == .notFound, probe == nil {
        return .wedgedServiceRepair(bundled: bundledCommit)
    }
    if probe != nil { return .running }
    if legacyPresent { return .legacyInstalledNotRunning }
    switch registration {
    case .requiresApproval: return .awaitingApproval
    case .enabled: return .registeredNotRunning
    case .notRegistered, .notFound, .unknown: return .needsConsent
    }
}

// MARK: - Post-re-register verification

/// What probing the daemon AFTER a re-register concluded. Pure output of
/// `verifyDaemonAfterReregister`.
public enum ReregisterVerification: Equatable, Sendable {
    /// The running daemon self-reports the bundle's commit — the update took.
    case verified
    /// Something is answering, but it is NOT this bundle's build: wrong
    /// commit, or no commit at all (a daemon old enough not to self-report
    /// is by definition not the build we just registered — the exact
    /// 0.3.13 incident shape). SMAppService replaced the registration on
    /// paper while the old process kept running; only a launchd-level
    /// bootout + fresh register actually restarts it.
    case staleProcessNeedsRestart
    /// Nothing answering — not a verification failure; the caller's normal
    /// starting-up handling covers it.
    case unreachable
}

/// The post-re-register check `reregister()` runs once the daemon answers,
/// kept pure for tests. Found in the 0.3.13→0.3.15 incident: register()
/// after unregister() can no-op at the BTM layer while the old daemon keeps
/// running, so "registration replaced" must never be trusted without asking
/// the RUNNING process what build it is. Takes the ONE probe snapshot the
/// startup wait already collected — never a fresh request that could fail
/// independently of it.
public func verifyDaemonAfterReregister(
    probe: DaemonProbeSnapshot?,
    bundledCommit: String
) -> ReregisterVerification {
    guard let probe else { return .unreachable }
    return probe.runningCommit == bundledCommit ? .verified : .staleProcessNeedsRestart
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
        public var launchdControl: any LaunchdServiceControlling
        /// MDGitCommit from the bundle's daemon manifest; nil in dev builds.
        public var bundledCommit: String?

        public init(
            registrar: any DaemonServiceRegistrar,
            tokenStore: any MutationTokenStore,
            legacyAgent: any LegacyAgentInspecting,
            marker: any RegistrationMarkerStore,
            probe: any DaemonReachabilityProbing,
            launchdControl: any LaunchdServiceControlling,
            bundledCommit: String?
        ) {
            self.registrar = registrar
            self.tokenStore = tokenStore
            self.legacyAgent = legacyAgent
            self.marker = marker
            self.probe = probe
            self.launchdControl = launchdControl
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

    /// Issue #269: the user has read the re-register notice and dismissed it.
    ///
    /// Scoped to this launch DELIBERATELY, matching `didReregisterForUpdate`
    /// itself: the notice only appears when a drift re-register actually
    /// happened, so persisting the dismissal would suppress the NEXT update's
    /// notice too — silencing a message the user has never seen. A later
    /// re-register in the same launch re-raises it, which is correct: that is
    /// a new event, not the one that was dismissed.
    public func dismissReregisterNotice() {
        didReregisterForUpdate = false
    }
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
        let registration = deps.registrar.status
        let decision = decideDaemonSetup(
            // ONE health round-trip answers both reachability and staleness.
            probe: await deps.probe.probeDaemon(),
            registration: registration,
            // Only consulted for the enabled-but-wedged check; skip the
            // launchctl spawn on the paths that can't be wedged.
            launchdService: registration == .enabled
                ? await deps.launchdControl.probeService() : .loaded,
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
        case .wedgedServiceRepair(let bundled), .staleDaemonRestart(_, let bundled):
            await forceRestartService(bundledCommit: bundled)
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

    // MARK: Missing-binary repair (issue #185)

    /// Guards the repair to ONE attempt per app session: a repair that
    /// can't take (registration error, revoked Login Items approval) must
    /// degrade to the visible setup phases, never loop unregister/register
    /// against launchd.
    private var didAttemptMissingBinaryRepair = false

    /// Issue #185: the reachable daemon ADMITTED its own executable no
    /// longer exists (`/api/state` → `daemon.binaryPresent: false`) — the
    /// state a staged/temp bundle leaves behind when its directory is
    /// deleted: the process survives and keeps answering HTTP, but every
    /// SEA self-spawn (the Claude usage probe) fails ENOENT, so usage
    /// quietly fossilizes. The launch evaluation can't catch it — the port
    /// answers and the MDGitCommit matches (same release!).
    ///
    /// Repair = the SAME unregister/register cycle as the drift path, run
    /// from THIS bundle, so launchd relaunches the daemon from a binary
    /// that exists. Only meaningful while the setup surface is otherwise
    /// quiet (a consent/install/approval flow in progress owns the
    /// registrar). Returns true when the repaired daemon is reachable
    /// again — the caller then forces a provider poll so the deck heals
    /// without any user action.
    @discardableResult
    public func repairMissingDaemonBinary() async -> Bool {
        guard !didAttemptMissingBinaryRepair,
              phase == .quiet,
              let bundledCommit = deps.bundledCommit, !bundledCommit.isEmpty
        else { return false }
        didAttemptMissingBinaryRepair = true
        await reregister(bundledCommit: bundledCommit)
        return phase == .quiet
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
        _ = await waitForDaemon()
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
        await verifyAfterReregister(probe: await waitForDaemon(), bundledCommit: bundledCommit)
    }

    /// Guards verification escalation to ONE launchd-level forced restart
    /// per launch evaluation chain — same rationale as the #185 repair
    /// guard: a restart that can't take must degrade to a visible state,
    /// never loop bootout/register against launchd. Set by
    /// `forceRestartService` itself, so a decision-driven forced restart
    /// (wedge, launch-time staleness) counts as the one attempt too; a
    /// user-clicked Retry re-evaluates and may legitimately try again.
    private var didForceRestartService = false

    /// The 0.3.13→0.3.15 lesson: a re-register that "succeeded" is a claim
    /// about BTM bookkeeping, not about the process. Once the daemon
    /// answers, ask it what build it is; a stale answer escalates to the
    /// launchd-level restart (once), and a stale answer AFTER that restart
    /// surfaces as an actionable failure instead of a silent wrong-version
    /// steady state.
    private func verifyAfterReregister(probe: DaemonProbeSnapshot?, bundledCommit: String) async {
        // Reuses the snapshot waitForDaemon() already collected — a second
        // request could fail independently and misread a healthy daemon as
        // stale. Not answering is not a verification failure: waitForDaemon()
        // already left the starting-up state with its retry affordance.
        let verification = verifyDaemonAfterReregister(
            probe: probe,
            bundledCommit: bundledCommit
        )
        guard verification == .staleProcessNeedsRestart else { return }
        guard !didForceRestartService else {
            phase = .failed(Self.staleDaemonAfterRestartMessage)
            return
        }
        await forceRestartService(bundledCommit: bundledCommit)
    }

    public static let staleDaemonAfterRestartMessage = "The background service is still running an older ModelDeck build after a forced restart. Restart your Mac, then click Retry."

    /// The launchd-level repair for the states SMAppService can't fix from
    /// above: bootout kills a stale process AND its stale job record, then
    /// unregister clears SMAppService's own belief so register() actually
    /// registers this bundle instead of no-opping (the manual recovery
    /// sequence from the 2026-08-02 incident, automated).
    private func forceRestartService(bundledCommit: String) async {
        didForceRestartService = true
        await deps.launchdControl.bootOutService()
        try? deps.registrar.unregister()
        do {
            try deps.registrar.register()
        } catch {
            if deps.registrar.status == .requiresApproval {
                deps.marker.registeredCommit = bundledCommit
                didReregisterForUpdate = true
                phase = .awaitingApproval
                return
            }
            phase = .failed("Couldn't restart the background service: \(error.localizedDescription)")
            return
        }
        deps.marker.registeredCommit = bundledCommit
        didReregisterForUpdate = true
        if deps.registrar.status == .requiresApproval {
            phase = .awaitingApproval
            return
        }
        await verifyAfterReregister(probe: await waitForDaemon(), bundledCommit: bundledCommit)
    }

    /// Polls until the daemon answers, returning the answering probe
    /// snapshot so callers can verify the build WITHOUT a second request.
    @discardableResult
    private func waitForDaemon() async -> DaemonProbeSnapshot? {
        phase = .startingUp
        for attempt in 0..<startupProbeAttempts {
            if attempt > 0 { await startupProbeDelay() }
            if let snapshot = await deps.probe.probeDaemon() {
                phase = .quiet
                return snapshot
            }
        }
        // Still starting (or failing); leave the retry affordance up.
        phase = .startingUp
        return nil
    }
}
