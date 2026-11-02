import Foundation

// Issue #421 — 1.0 build C: the Swift shell owns the bundled CLIProxyAPI's
// lifecycle (#397): start, stop, restart-on-crash, health surfaced in the
// deck. Management touches CONFIG + PROCESS only — never auth files (#398),
// which CLIProxyAPI remains the sole writer of. State lives at
// ~/.config/cliproxyapi, the SAME directory an external instance uses, so an
// existing install is adoptable without any credential migration.
//
// Everything side-effectful lives behind the protocols below so the state
// machine is fully unit-testable and tests NEVER spawn a proxy, touch port
// 8317, or read a real auth file.
//
// The safety rail (#400 double-consume): a managed instance is NEVER started
// while an EXTERNAL proxy answers on the port. Slice C refuses loudly and
// reports honestly — no offers, no consent screens, and it never stops a
// process the user started. The adoption UX is slice D (#422).
//
// Issue #784: the pool may live on another Mac, reached through a forwarder
// on this Mac's port. Off the pool host nothing starts, and the lifecycle
// stands down when the role moves away. The role is remembered across
// launches, so launch never waits on the daemon to decide.

// MARK: - Paths

/// The proxy's on-disk state directory. One authority for every path the
/// lifecycle touches, so the write guard below can reason about all of them.
public struct ManagedProxyPaths: Equatable, Sendable {
    /// `~/.config/cliproxyapi` — shared with an external instance by
    /// construction (#398). Never a ModelDeck-private directory.
    public let configDirectory: URL

    public init(configDirectory: URL) {
        self.configDirectory = configDirectory
    }

    /// One of the TWO files the managed lifecycle may ever write.
    public var configFile: URL {
        configDirectory.appendingPathComponent(ManagedProxyWriteGuard.configFileName)
    }

    /// The daemon's `CLIPROXY_MANAGEMENT_KEY_PATH` (src/paths.mjs). Written
    /// once, at config-seed time only (#431, Tim 2026-08-14): a fresh install
    /// otherwise runs a proxy whose usage queue nothing can authenticate to.
    /// Not an auth file — a management secret is not a provider credential, so
    /// #398 is untouched.
    public var managementKeyFile: URL {
        configDirectory.appendingPathComponent(ManagedProxyWriteGuard.managementKeyFileName)
    }

    /// CLIProxyAPI's auth-file directory. ModelDeck reads nothing here and
    /// writes nothing here, ever — the guard treats it as radioactive.
    public var authDirectory: URL {
        configDirectory.appendingPathComponent("auth")
    }

    public static func standard(
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> ManagedProxyPaths {
        ManagedProxyPaths(
            configDirectory: home.appendingPathComponent(".config/cliproxyapi", isDirectory: true)
        )
    }
}

// MARK: - Write guard (TRIPWIRE managed-proxy-never-writes-auth)

/// The structural half of "management never writes auth files": every
/// filesystem write in the managed-proxy lifecycle goes through
/// `requirePermittedWrite`, which admits exactly TWO destinations — the config
/// file and the seed-time management key file (#431) — and names an auth-file
/// attempt as its own violation so a mistake can never degrade into a generic
/// error someone swallows.
///
/// The static half lives in the tripwire test, which asserts the lifecycle
/// sources contain no unguarded write API at all.
public enum ManagedProxyWriteGuard {
    public static let configFileName = "config.yaml"
    /// Must match src/paths.mjs `CLIPROXY_MANAGEMENT_KEY_PATH`'s basename —
    /// the daemon already looks here; #431 only makes the file exist.
    public static let managementKeyFileName = ".mgmt-key"

    /// True iff `url` is inside (or is) the proxy's auth directory. Compared
    /// on standardized paths so `../` can never smuggle a path past it.
    public static func isAuthFile(_ url: URL, paths: ManagedProxyPaths) -> Bool {
        let candidate = standardizedPath(url)
        let authRoot = standardizedPath(paths.authDirectory)
        return candidate == authRoot || candidate.hasPrefix(authRoot + "/")
    }

    /// True iff `url` is one of the two files the lifecycle is allowed to
    /// write: the config, and the management key it seeds alongside it (#431).
    public static func isPermittedWrite(_ url: URL, paths: ManagedProxyPaths) -> Bool {
        let candidate = standardizedPath(url)
        return candidate == standardizedPath(paths.configFile)
            || candidate == standardizedPath(paths.managementKeyFile)
    }

    /// Throws unless `url` is a permitted destination. Auth-file attempts get their
    /// own case: the message has to say what was refused and why.
    public static func requirePermittedWrite(_ url: URL, paths: ManagedProxyPaths) throws {
        if isPermittedWrite(url, paths: paths) { return }
        if isAuthFile(url, paths: paths) {
            throw Violation.authFileWrite(standardizedPath(url))
        }
        throw Violation.unmanagedPathWrite(standardizedPath(url))
    }

    public enum Violation: Error, LocalizedError, Equatable {
        /// The one that must never happen: CLIProxyAPI owns auth files.
        case authFileWrite(String)
        /// Anything else outside the managed config file.
        case unmanagedPathWrite(String)

        public var errorDescription: String? {
            switch self {
            case .authFileWrite(let path):
                return "ModelDeck refused to write a CLIProxyAPI auth file (\(path)). ModelDeck manages the proxy's config and process only; sign-ins stay CLIProxyAPI's alone."
            case .unmanagedPathWrite(let path):
                return "ModelDeck refused to write outside the managed proxy's config and management key (\(path))."
            }
        }
    }

    private static func standardizedPath(_ url: URL) -> String {
        url.standardizedFileURL.resolvingSymlinksInPath().path
    }
}

// MARK: - Bundled binary (slice A's pin is the ONE path authority)

/// scripts/cliproxyapi-pin.json, staged into the app bundle by
/// release-dmg.sh. `bundlePath` is the single authority for where the proxy
/// binary lives inside the app — slice C reads it rather than duplicating a
/// second copy of the path (the pin's own note in release-dmg.sh).
public struct CLIProxyBundlePin: Codable, Equatable, Sendable {
    public var tag: String?
    public var commit: String?
    public var bundlePath: String?

    public init(tag: String? = nil, commit: String? = nil, bundlePath: String? = nil) {
        self.tag = tag
        self.commit = commit
        self.bundlePath = bundlePath
    }

    /// Staged at Contents/Resources/cliproxyapi-pin.json. Absent in dev
    /// builds (`swift run`, Scripts/build_app.sh) — which is exactly the
    /// honest "no managed proxy in this build" signal.
    public static let bundleResourceName = "cliproxyapi-pin"

    public static func load(from bundle: Bundle) -> CLIProxyBundlePin? {
        guard let url = bundle.url(forResource: bundleResourceName, withExtension: "json"),
              let data = try? Data(contentsOf: url)
        else { return nil }
        return try? JSONDecoder().decode(CLIProxyBundlePin.self, from: data)
    }
}

/// Resolves the pin's app-relative `bundlePath` against the .app root,
/// mirroring the validation scripts/cliproxyapi-pin.mjs already enforces on
/// the writing side: relative, normalized, non-escaping, under
/// Contents/Resources. Returns nil for anything else — a malformed pin turns
/// the feature off rather than launching something from an unexpected path.
public func resolveCLIProxyBinaryURL(appBundleURL: URL, bundlePath: String?) -> URL? {
    guard let bundlePath, !bundlePath.isEmpty else { return nil }
    guard !bundlePath.hasPrefix("/") else { return nil }
    let components = bundlePath.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard !components.contains(""), !components.contains(".."), !components.contains(".")
    else { return nil }
    guard components.count > 2, components[0] == "Contents", components[1] == "Resources"
    else { return nil }
    return components.reduce(appBundleURL) { $0.appendingPathComponent($1) }
}

/// What this build can manage. `binaryURL == nil` is the dev build: the deck
/// shows an honest unavailable state and offers nothing (the
/// dev-build-never-offers-install precedent).
public struct ManagedProxyBundle: Equatable, Sendable {
    public var binaryURL: URL?
    /// The pin's tag, for display only.
    public var version: String?

    public init(binaryURL: URL? = nil, version: String? = nil) {
        self.binaryURL = binaryURL
        self.version = version
    }

    /// Dev builds and tests that shouldn't manage anything.
    public static let unavailable = ManagedProxyBundle()

    public var isAvailable: Bool { binaryURL != nil }
}

// MARK: - Seams

/// Identifies one launched proxy process. `id` stays the lifecycle's opaque
/// ownership handle; `pid` is observed only for the issue-#432 daemon report
/// and never participates in a supervision decision.
public struct ManagedProxyProcessToken: Hashable, Sendable {
    public let id: Int
    public let pid: Int?

    public init(id: Int, pid: Int? = nil) {
        self.id = id
        self.pid = pid
    }
}

/// Process half of "config + process, never auth files". Semantic, not a
/// generic process runner — same convention as `LaunchdServiceControlling`.
public protocol ManagedProxyProcessControlling: Sendable {
    /// Spawns the proxy against `configFile`, returning a token for it.
    func start(executable: URL, configFile: URL, workingDirectory: URL) throws -> ManagedProxyProcessToken
    /// Is the process we started still alive? False after a crash or a kill.
    func isRunning(_ token: ManagedProxyProcessToken) -> Bool
    /// Terminate the process we started. Best effort; never touches a
    /// process ModelDeck did not spawn.
    func stop(_ token: ManagedProxyProcessToken) async
}

/// Loopback reachability of the proxy port. Answers the ONE question the
/// occupancy classifier needs: is something serving on the port.
public protocol ManagedProxyHealthProbing: Sendable {
    func probeProxy() async -> Bool
}

/// Config half. The only write path in the whole lifecycle, and it writes at
/// most two files: the config, and — on a seed only — the management key.
public protocol ManagedProxyConfigWriting: Sendable {
    /// Ensures a usable config exists, returning the file the proxy should
    /// be launched against. An EXISTING config is never modified — that is
    /// what makes adopting a user's install non-destructive (#398).
    func ensureConfig(paths: ManagedProxyPaths, port: Int) throws -> URL
}

/// Lifecycle event names sent to the daemon. These are transition facts, not
/// a second state machine: no timer or steady-state heartbeat emits them.
public enum ManagedProxyReportPhase {
    public static let started = "started"
    public static let stopped = "stopped"
    public static let restart = "restart"
    public static let crashGaveUp = "crash-gave-up"
    public static let adopted = "adopted"
    /// Issue #784: management stopped because the role moved to remote.
    /// Named after the daemon's own refusal code, so the report says why.
    public static let proxyRoleRemote = ProxyRoleCopy.remoteRefusalCode
}

/// The app-owned process facts the daemon cannot observe itself (#432).
/// Optional values encode as explicit JSON nulls to keep the wire shape
/// stable across transitions.
public struct ManagedProxyAppReport: Encodable, Equatable, Sendable {
    public var managed: Bool
    public var phase: String
    public var pid: Int?
    public var restartCount: Int?
    public var appVersion: String?
    public var reportedAt: String

    public init(
        managed: Bool,
        phase: String,
        pid: Int?,
        restartCount: Int?,
        appVersion: String?,
        reportedAt: String
    ) {
        self.managed = managed
        self.phase = phase
        self.pid = pid
        self.restartCount = restartCount
        self.appVersion = appVersion
        self.reportedAt = reportedAt
    }

    private enum CodingKeys: String, CodingKey {
        case managed, phase, pid, restartCount, appVersion, reportedAt
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(managed, forKey: .managed)
        try container.encode(phase, forKey: .phase)
        if let pid { try container.encode(pid, forKey: .pid) }
        else { try container.encodeNil(forKey: .pid) }
        if let restartCount { try container.encode(restartCount, forKey: .restartCount) }
        else { try container.encodeNil(forKey: .restartCount) }
        if let appVersion { try container.encode(appVersion, forKey: .appVersion) }
        else { try container.encodeNil(forKey: .appVersion) }
        try container.encode(reportedAt, forKey: .reportedAt)
    }
}

/// Daemon mutation seam. Tests stub this; production uses `DaemonClient` and
/// its existing token-header + session-cookie authorization path.
public protocol ManagedProxyReporting: Sendable {
    func reportManagedProxy(_ report: ManagedProxyAppReport) async throws
}

public struct NoopManagedProxyReporter: ManagedProxyReporting {
    public init() {}
    public func reportManagedProxy(_ report: ManagedProxyAppReport) async throws {}
}

// MARK: - Occupancy

/// Who is serving on the proxy port. `.foreign` is the safety rail: something
/// answers that ModelDeck did not start, so starting a managed instance would
/// double-consume the usage queue (#400).
public enum ManagedProxyOccupant: Equatable, Sendable {
    /// Nothing answering and no managed process alive.
    case none
    /// Our process is alive (answering yet or still coming up).
    case managed
    /// Something answers on the port and it is NOT ours.
    case foreign
}

/// Pure occupancy classification. Process ownership is the authority: the
/// port itself cannot say who owns it, so "answering while we have no live
/// child" is the only sound definition of foreign — and it deliberately
/// stays foreign for the whole session, because a proxy we did not spawn is
/// never ours to supervise.
public func classifyProxyOccupant(portAnswering: Bool, managedProcessAlive: Bool) -> ManagedProxyOccupant {
    if managedProcessAlive { return .managed }
    return portAnswering ? .foreign : .none
}

// MARK: - Decision

/// Whether the user wants a managed proxy at all. A user-initiated stop must
/// STAY stopped — the supervisor may never resurrect it.
public enum ManagedProxyDesiredState: Equatable, Sendable {
    case running
    case stopped
}

/// Pure output of `decideManagedProxy`; the model maps it onto phases and
/// performs the effects.
public enum ManagedProxyDecision: Equatable, Sendable {
    /// No proxy in this build (dev build). Honest unavailable state, no offer.
    case unavailable
    /// Issue #784: this Mac uses the pool on another machine and its proxy
    /// port belongs to the forwarder. Stand down; stop only what we started.
    case remotePool
    /// An external proxy answers on the port — refuse loudly, change nothing.
    case refuseExternalInstance
    /// The user stopped it; leave it down.
    case stayStopped
    /// Our process is alive; nothing to do.
    case running
    /// Nothing running and nothing has crashed yet — first launch.
    case start
    /// Our process died and the user never stopped it — restart after
    /// `managedProxyRestartDelay(attempt:)`.
    case restart(attempt: Int)
    /// Restarted `attempts` times without staying up. Stop trying, surface an
    /// actionable failure — a tight crash loop is the failure mode to kill.
    case crashLoopGiveUp(attempts: Int)
}

/// The supervision decision, kept pure for tests. Precedence:
/// 1. no bundled binary → dev build, stand down (never offer anything);
/// 2. (#784) remote role → stand down, before the port: off the pool host
///    the port is the forwarder's, and the model never probes it;
/// 3. a foreign proxy answers → refuse, loudly, in every desired state (the
///    #400 double-consume rail outranks even a user stop, because it is the
///    honest description of what is on the port);
/// 4. the user stopped it → stay stopped;
/// 5. our process alive → running;
/// 6. nothing there → start / bounded-backoff restart / give up.
/// `role` defaults to host, the pre-#784 behaviour; the model always passes
/// its own.
public func decideManagedProxy(
    desired: ManagedProxyDesiredState,
    binaryAvailable: Bool,
    role: ProxyRole = .host,
    occupant: ManagedProxyOccupant,
    restartsSoFar: Int,
    maxRestarts: Int = ManagedProxyRestartPolicy.maxRestarts
) -> ManagedProxyDecision {
    guard binaryAvailable else { return .unavailable }
    if role == .remote { return .remotePool }
    if occupant == .foreign { return .refuseExternalInstance }
    if desired == .stopped { return .stayStopped }
    if occupant == .managed { return .running }
    if restartsSoFar <= 0 { return .start }
    if restartsSoFar > maxRestarts { return .crashLoopGiveUp(attempts: maxRestarts) }
    return .restart(attempt: restartsSoFar)
}

// MARK: - Backoff

/// Nonisolated constants shared by the model, its live wiring, and the deck.
public enum ManagedProxyDefaults {
    /// CLIProxyAPI's port, matching src/paths.mjs CLIPROXY_BASE_URL.
    public static let port = 8317
}

public enum ManagedProxyRestartPolicy {
    /// Consecutive restarts allowed before the supervisor gives up and shows
    /// an actionable failure instead of hammering launch.
    public static let maxRestarts = 5
    public static let baseDelay: TimeInterval = 1
    public static let maxDelay: TimeInterval = 30
}

/// Bounded exponential backoff: 1s, 2s, 4s, 8s, 16s, capped. There is never a
/// zero delay — "restart immediately, forever" is the tight crash loop the
/// ticket forbids.
public func managedProxyRestartDelay(
    attempt: Int,
    base: TimeInterval = ManagedProxyRestartPolicy.baseDelay,
    cap: TimeInterval = ManagedProxyRestartPolicy.maxDelay
) -> TimeInterval {
    let clamped = max(1, attempt)
    // Exponent capped before the shift so a long-lived session can't overflow.
    let exponent = min(clamped - 1, 16)
    return min(cap, base * pow(2, Double(exponent)))
}

// MARK: - Model

/// Supervises the bundle-embedded CLIProxyAPI. Owned by the app, surfaced in
/// the deck as a live self-clearing banner (healthy is silent, exactly like
/// the daemon's own connection state).
@MainActor
public final class ManagedProxyModel: ObservableObject {
    public enum Phase: Equatable, Sendable {
        case idle
        /// Dev build without the embedded binary. Honest, and offers nothing.
        case unavailable
        case starting
        /// Our managed instance is up.
        case running
        /// User-initiated stop. Stays down until the user starts it again.
        case stopped
        /// Crashed; waiting out the backoff before attempt `attempt`.
        case restarting(attempt: Int)
        /// CRITICAL SAFETY RAIL (#400): something ModelDeck did not start is
        /// answering on the proxy port. Refuse, say so, touch nothing.
        case externalInstanceDetected
        case failed(String)
        /// Issue #784: this Mac uses the proxy pool on another machine. Its
        /// port is the forwarder's: nothing to start, adopt, probe, or offer.
        case remotePool
    }

    public struct Dependencies {
        public var bundle: ManagedProxyBundle
        public var paths: ManagedProxyPaths
        public var process: any ManagedProxyProcessControlling
        public var health: any ManagedProxyHealthProbing
        public var config: any ManagedProxyConfigWriting
        public var reporter: any ManagedProxyReporting
        public var appVersion: String?
        public var reportFailure: @Sendable (String) -> Void
        /// The port the config seeds and the health probe watches.
        public var port: Int
        /// Issue #784 review: the last pool role a state reported, across
        /// launches. Never recorded reads as host.
        public var roleMemory: any ProxyRoleRemembering

        public init(
            bundle: ManagedProxyBundle,
            paths: ManagedProxyPaths,
            process: any ManagedProxyProcessControlling,
            health: any ManagedProxyHealthProbing,
            config: any ManagedProxyConfigWriting,
            reporter: any ManagedProxyReporting = NoopManagedProxyReporter(),
            appVersion: String? = nil,
            reportFailure: @escaping @Sendable (String) -> Void = { _ in },
            port: Int = ManagedProxyDefaults.port,
            roleMemory: any ProxyRoleRemembering = EphemeralProxyRoleMemory()
        ) {
            self.bundle = bundle
            self.paths = paths
            self.process = process
            self.health = health
            self.config = config
            self.reporter = reporter
            self.appVersion = appVersion
            self.reportFailure = reportFailure
            self.port = port
            self.roleMemory = roleMemory
        }
    }

    public static let externalInstanceMessage = "Another CLIProxyAPI is already running on port \(ManagedProxyDefaults.port). ModelDeck left it alone and did not start its own — two proxies would each drain half the usage queue."
    public static let crashLoopMessage = "The bundled proxy keeps stopping right after it starts. ModelDeck stopped restarting it."

    @Published public private(set) var phase: Phase = .idle
    /// CONSECUTIVE rapid restarts — observable proof a crash restart
    /// happened, and the crash-loop ladder's input. Reset by a user-initiated
    /// start/stop and by a managed instance that stays up for
    /// `healthyResetInterval`, so one crash a week never inherits the last
    /// crash's exhausted budget.
    @Published public private(set) var restartCount = 0
    /// When the PORT last answered. Distinct from `.running`, which only
    /// claims our process is alive: a hung-but-alive proxy keeps the phase
    /// and freezes this timestamp rather than pretending to be healthy.
    @Published public private(set) var lastHealthyAt: Date?

    /// User intent, independent of phase: a stop must survive every
    /// supervision tick until the user asks for a start.
    public private(set) var desiredState: ManagedProxyDesiredState = .running

    /// Issue #784: the pool role this lifecycle acts on — the remembered one
    /// at launch, then the latest state's. Nothing starts unless it is host.
    @Published public private(set) var proxyRole: ProxyRole

    public var isAvailable: Bool { deps.bundle.isAvailable }

    private let deps: Dependencies
    private let clock: @Sendable () -> Date
    /// Backoff sleep, injectable so tests run instantly.
    private let sleep: @Sendable (TimeInterval) async -> Void
    private let maxRestarts: Int
    /// How long a managed instance must stay up before its crash budget is
    /// considered spent — i.e. before the next crash counts as attempt 1.
    private let healthyResetInterval: TimeInterval
    private var token: ManagedProxyProcessToken?
    private var lastLaunchAt: Date?
    private var monitorTask: Task<Void, Never>?
    private var reportTask: Task<Void, Never>?
    private var isSupervising = false
    private var hasManagedState = false

    public init(
        dependencies: Dependencies,
        maxRestarts: Int = ManagedProxyRestartPolicy.maxRestarts,
        healthyResetInterval: TimeInterval = 60,
        clock: @escaping @Sendable () -> Date = { Date() },
        sleep: @escaping @Sendable (TimeInterval) async -> Void = { seconds in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        }
    ) {
        self.deps = dependencies
        // Issue #784 review: decided from what the last state said, never by
        // waiting for the daemon — after an update it can stay busy for
        // minutes (#660/#675), and a host's routed sessions need the proxy.
        self.proxyRole = dependencies.roleMemory.lastSeenRole ?? .host
        self.maxRestarts = max(1, maxRestarts)
        self.healthyResetInterval = max(0, healthyResetInterval)
        self.clock = clock
        self.sleep = sleep
    }

    deinit {
        monitorTask?.cancel()
        reportTask?.cancel()
    }

    // MARK: Launch

    /// Called once from the app's launch sequence. Never starts anything if
    /// an external proxy is already answering, or (#784) off the pool host.
    public func evaluateOnLaunch() async {
        await superviseOnce()
    }

    // MARK: Pool role (issue #784)

    /// Applies, and remembers, the role from a fresh daemon state. Recorded
    /// synchronously, so the role always matches the latest state. Moved to
    /// remote: stop the proxy this app started, now — the role change is the
    /// user's own explicit action, and the report says so; a proxy someone
    /// else runs on the port is never touched. The stop runs in the returned
    /// task (tests await it; the app fires and forgets). Moved back to host:
    /// the next monitoring tick decides, as a launch would, and only ticks
    /// that run after the launch-time choice gate (#422) ever start anything.
    @discardableResult
    public func applyProxyRole(_ role: ProxyRole) -> Task<Void, Never>? {
        guard role != proxyRole else { return nil }
        proxyRole = role
        deps.roleMemory.lastSeenRole = role
        return role == .remote ? standDownForRemotePool() : nil
    }

    /// The remote-role stand-down. Bookkeeping happens at once, so no
    /// supervision tick can see the token after the role moved; the stop
    /// itself (SIGTERM, then a bounded wait) and its report run in the
    /// returned task. Only `token` — a process this app spawned — is ever
    /// stopped.
    @discardableResult
    private func standDownForRemotePool() -> Task<Void, Never>? {
        // Every remote-role tick lands here; unchanged values are not
        // republished, so an open deck is not re-rendered for nothing.
        let resting: Phase = deps.bundle.isAvailable ? .remotePool : .unavailable
        if phase != resting { phase = resting }
        if restartCount != 0 { restartCount = 0 }
        let started = token
        let wasManaging = hasManagedState
        token = nil
        hasManagedState = false
        guard started != nil || wasManaging else { return nil }
        let process = deps.process
        return Task {
            if let started { await process.stop(started) }
            self.enqueueReport(managed: false, phase: ManagedProxyReportPhase.proxyRoleRemote, pid: nil)
        }
    }

    // MARK: User actions

    /// Explicit start (from the deck's stopped/failed state). Clears the
    /// crash-loop counter — a user asking again is a fresh mandate.
    public func startManaging() async {
        await startManaging(reportPhase: ManagedProxyReportPhase.started)
    }

    /// Adoption is still a slice-C launch; the distinct phase preserves the
    /// observed handover event without adding a second lifecycle owner.
    public func startManagingAfterAdoption() async {
        await startManaging(reportPhase: ManagedProxyReportPhase.adopted)
    }

    private func startManaging(reportPhase: String) async {
        desiredState = .running
        restartCount = 0
        await superviseOnce(startReportPhase: reportPhase)
    }

    /// User-initiated stop: the process goes down AND STAYS down. The
    /// supervisor sees `.stopped` on every later tick and never resurrects it.
    public func stopManaging() async {
        let shouldReport = hasManagedState
        desiredState = .stopped
        if let token {
            await deps.process.stop(token)
        }
        token = nil
        restartCount = 0
        // Issue #784: off the pool host there is nothing of ours to call
        // stopped; the phase keeps saying where the pool is.
        phase = deps.bundle.isAvailable ? (proxyRole == .remote ? .remotePool : .stopped) : .unavailable
        hasManagedState = false
        if shouldReport {
            enqueueReport(managed: false, phase: ManagedProxyReportPhase.stopped, pid: nil)
        }
    }

    /// Retry from `.failed`.
    public func retry() async {
        await startManaging()
    }

    // MARK: Supervision

    /// One supervision tick: classify what is on the port, decide, act.
    /// Internal so tests can drive it deterministically without a timer.
    func superviseOnce(startReportPhase: String = ManagedProxyReportPhase.started) async {
        guard !isSupervising else { return }
        isSupervising = true
        defer { isSupervising = false }

        let alive = token.map { deps.process.isRunning($0) } ?? false
        if !alive { token = nil }
        // A dev build has nothing to supervise and nothing to say about the
        // port; don't spend a request finding that out. Issue #784: nor does
        // a Mac off the pool host — in remote role the port is the
        // forwarder's.
        let answering = deps.bundle.isAvailable && proxyRole == .host
            ? await deps.health.probeProxy()
            : false
        let occupant = classifyProxyOccupant(portAnswering: answering, managedProcessAlive: alive)

        // The role is read AFTER the probe: a change that landed while it was
        // out is the one that counts.
        switch decideManagedProxy(
            desired: desiredState,
            binaryAvailable: deps.bundle.isAvailable,
            role: proxyRole,
            occupant: occupant,
            restartsSoFar: restartCount,
            maxRestarts: maxRestarts
        ) {
        case .unavailable:
            phase = .unavailable
        case .remotePool:
            await standDownForRemotePool()?.value
        case .refuseExternalInstance:
            // Refusal only. No offer, no consent screen, and emphatically no
            // stopping the user's process — that is slice D's story (#422).
            phase = .externalInstanceDetected
        case .stayStopped:
            phase = .stopped
        case .running:
            if answering {
                lastHealthyAt = clock()
                // Stayed up long enough to have earned a fresh crash budget.
                if let lastLaunchAt,
                   clock().timeIntervalSince(lastLaunchAt) >= healthyResetInterval {
                    restartCount = 0
                }
            }
            phase = .running
        case .start:
            await launch(reportPhase: startReportPhase)
        case .restart(let attempt):
            phase = .restarting(attempt: attempt)
            await sleep(managedProxyRestartDelay(attempt: attempt))
            // Issue #784: the role may have moved to remote during the wait;
            // its stand-down already owns the phase.
            guard proxyRole == .host else { return }
            // The user may have stopped it, or an external instance may have
            // claimed the port, while we waited out the backoff.
            guard desiredState == .running else {
                phase = .stopped
                return
            }
            if await deps.health.probeProxy() {
                // Off the pool host the answer is the forwarder's, and the
                // stand-down owns the phase.
                if proxyRole == .host { phase = .externalInstanceDetected }
                return
            }
            // A role that moved during that probe stops at the spawn site.
            await launch(reportPhase: ManagedProxyReportPhase.restart)
        case .crashLoopGiveUp:
            let failedPhase = Phase.failed(Self.crashLoopMessage)
            if phase != failedPhase {
                phase = failedPhase
                hasManagedState = true
                enqueueReport(
                    managed: true,
                    phase: ManagedProxyReportPhase.crashGaveUp,
                    pid: nil
                )
            }
        }
    }

    /// Observes the managed process on an interval so a crash is noticed
    /// without the user opening anything. Cancelled in `deinit`. Local
    /// supervision only — one liveness check plus one loopback /healthz per
    /// tick, never a provider request.
    public func startMonitoring(interval: TimeInterval = 10) {
        monitorTask?.cancel()
        monitorTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.sleepForMonitor(interval)
                if Task.isCancelled { return }
                await self?.superviseOnce()
            }
        }
    }

    public func stopMonitoring() {
        monitorTask?.cancel()
        monitorTask = nil
    }

    private func sleepForMonitor(_ interval: TimeInterval) async {
        await sleep(interval)
    }

    // MARK: Effects

    private func launch(reportPhase: String) async {
        guard let executable = deps.bundle.binaryURL else {
            phase = .unavailable
            return
        }
        // Issue #784: the one place a proxy is spawned holds the role gate
        // too, so no path can start one off the pool host — a role that
        // moved during the restart path's last probe stops here.
        guard proxyRole == .host else { return }
        phase = .starting
        let configFile: URL
        do {
            // The ONLY write the lifecycle performs, and the writer refuses
            // any destination but the config file (see ManagedProxyWriteGuard).
            configFile = try deps.config.ensureConfig(paths: deps.paths, port: deps.port)
        } catch {
            phase = .failed("Couldn't prepare the proxy configuration: \(error.localizedDescription)")
            return
        }
        // Counted BEFORE the spawn (PR #430 review): a spawn that always
        // throws must climb the same bounded ladder as a crashing child, or
        // the supervisor retries a doomed launch forever.
        restartCount += 1
        lastLaunchAt = clock()
        do {
            token = try deps.process.start(
                executable: executable,
                configFile: configFile,
                workingDirectory: deps.paths.configDirectory
            )
        } catch {
            token = nil
            phase = .failed("Couldn't start the bundled proxy: \(error.localizedDescription)")
            return
        }
        // The process exists; the port has not answered yet. `lastHealthyAt`
        // stays untouched until a tick sees it answer.
        phase = .running
        hasManagedState = true
        enqueueReport(managed: true, phase: reportPhase, pid: token?.pid)
    }

    /// Serialized fire-and-forget delivery: lifecycle operations never await
    /// the daemon, while a rapid start→stop cannot arrive out of order and
    /// make the daemon's last in-memory report regress (#432).
    private func enqueueReport(managed: Bool, phase: String, pid: Int?) {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let report = ManagedProxyAppReport(
            managed: managed,
            phase: phase,
            pid: pid,
            restartCount: restartCount,
            appVersion: deps.appVersion,
            reportedAt: formatter.string(from: clock())
        )
        let previous = reportTask
        let reporter = deps.reporter
        let reportFailure = deps.reportFailure
        reportTask = Task {
            await previous?.value
            guard !Task.isCancelled else { return }
            do {
                try await reporter.reportManagedProxy(report)
            } catch {
                reportFailure("managed-proxy report failed: \(error.localizedDescription)")
            }
        }
    }
}
