import Foundation
import Security
import ServiceManagement

// Issue #96 — live implementations of the DaemonSetup seams. Constructed
// only by the app target; unit tests use the fakes in
// Tests/ModelDeckMacCoreTests and never touch these.

// MARK: - SMAppService agent

/// The bundled daemon is registered as a **launchd agent** via
/// `SMAppService.agent(plistName:)` — not `.daemon(plistName:)`. Rationale:
/// the service is strictly per-user (loopback HTTP on 127.0.0.1, SQLite
/// under the user's ~/Library/Application Support/ModelDeck, reads the
/// user's login Keychain and the user's claude/codex profiles), so it
/// belongs in the gui/per-user launchd domain. SMAppService daemons run in
/// the system domain as root and require admin approval — wrong on every
/// axis for this service.
///
/// The plist lives at Contents/Library/LaunchAgents/ai.hermes.modeldeck.plist
/// (staged by release-dmg.sh) with BundleProgram pointing at
/// Contents/Resources/daemon/modeldeckd. It reuses the legacy label
/// `ai.hermes.modeldeck` on purpose: launchd refuses two services with the
/// same label in one domain, so even if the coexistence UI is somehow
/// bypassed, two daemons can never run.
public struct SMAppServiceAgentRegistrar: DaemonServiceRegistrar {
    public static let plistName = "ai.hermes.modeldeck.plist"

    public init() {}

    private var service: SMAppService { SMAppService.agent(plistName: Self.plistName) }

    public var status: ServiceRegistrationStatus {
        switch service.status {
        case .enabled: return .enabled
        case .requiresApproval: return .requiresApproval
        case .notRegistered: return .notRegistered
        case .notFound: return .notFound
        @unknown default: return .unknown
        }
    }

    public func register() throws { try service.register() }
    public func unregister() throws { try service.unregister() }

    /// Deep-links System Settings → General → Login Items for the
    /// requires-approval state.
    public static func openLoginItemsSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}

// MARK: - Keychain token

/// Generic-password item `modeldeck` / `mutation-token` in the login
/// Keychain — the exact item scripts/set-mutation-token.sh writes and
/// src/token.mjs reads (`security find-generic-password -s modeldeck -a
/// mutation-token -w`). The token value never leaves this type: it is
/// generated, handed to SecItemAdd, and discarded.
public struct KeychainMutationTokenStore: MutationTokenStore {
    public static let service = "modeldeck"
    public static let account = "mutation-token"

    public init() {}

    public func tokenExists() throws -> Bool {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: Self.service,
            kSecAttrAccount: Self.account,
        ]
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        switch status {
        case errSecSuccess, errSecInteractionNotAllowed:
            return true
        case errSecItemNotFound:
            return false
        default:
            throw KeychainError(status: status)
        }
    }

    public func createToken() throws {
        // Same shape as set-mutation-token.sh: 32 random bytes, base64url,
        // no padding.
        var bytes = [UInt8](repeating: 0, count: 32)
        let rc = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard rc == errSecSuccess else { throw KeychainError(status: rc) }
        let token = Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        // NOTE deliberately minimal: no kSecAttrAccessible (that attribute
        // belongs to the data-protection keychain and is REJECTED by the
        // macOS default file-based login keychain — where this item must
        // live so the daemon's `security find-generic-password` can read
        // it), and no kSecUseDataProtectionKeychain for the same reason.
        let attributes: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: Self.service,
            kSecAttrAccount: Self.account,
            kSecValueData: Data(token.utf8),
        ]
        let status = SecItemAdd(attributes as CFDictionary, nil)
        // A concurrent writer beat us to it — an existing token wins, ours
        // is discarded. Never overwrite.
        guard status == errSecSuccess || status == errSecDuplicateItem else {
            throw KeychainError(status: status)
        }
    }

    public struct KeychainError: Error, LocalizedError {
        public let status: OSStatus
        public var errorDescription: String? {
            let detail = SecCopyErrorMessageString(status, nil) as String?
            return detail ?? "Keychain error \(status)"
        }
    }
}

// MARK: - Legacy LaunchAgent

/// The dev-path install (scripts/install-launch-agent.sh) renders a plist to
/// ~/Library/LaunchAgents/ai.hermes.modeldeck.plist and bootstraps it into
/// the gui domain. Presence of that FILE is the detection signal —
/// SMAppService plists live inside the app bundle, so there is no overlap.
public struct LegacyLaunchAgentInspector: LegacyAgentInspecting {
    public static let label = "ai.hermes.modeldeck"

    private let plistURL: URL

    public init(home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        plistURL = home
            .appendingPathComponent("Library/LaunchAgents")
            .appendingPathComponent("\(Self.label).plist")
    }

    public func isLegacyAgentPresent() -> Bool {
        FileManager.default.fileExists(atPath: plistURL.path)
    }

    public func removeLegacyAgent() throws {
        // Boot the loaded agent out of the gui session first (mirrors
        // uninstall-launch-agent.sh); "not loaded" exits non-zero and is
        // fine — the authoritative check is the `launchctl print` below.
        _ = runLaunchctl(["bootout", "gui/\(getuid())/\(Self.label)"])
        // Verify the service is actually GONE before touching the plist or
        // letting the caller register the same label: `launchctl print`
        // exits 0 iff the service is still loaded.
        let printExit = runLaunchctl(["print", "gui/\(getuid())/\(Self.label)"])
        guard LegacyAgentRemoval.serviceIsGone(printExitCode: printExit) else {
            throw RemovalError.stillLoaded
        }
        // Only now remove the rendered plist so it never loads again.
        do {
            try FileManager.default.removeItem(at: plistURL)
        } catch CocoaError.fileNoSuchFile {
            // Already gone — the goal state.
        }
    }

    /// Runs /bin/launchctl with the given arguments, discarding output;
    /// returns the exit code (127 if the process couldn't launch at all).
    private func runLaunchctl(_ arguments: [String]) -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return 127
        }
        process.waitUntilExit()
        return process.terminationStatus
    }

    public enum RemovalError: Error, LocalizedError, Equatable {
        /// bootout ran but `launchctl print` still finds the service loaded.
        case stillLoaded
        public var errorDescription: String? {
            switch self {
            case .stillLoaded:
                return "The previous ModelDeck service is still loaded. Try quitting it (launchctl bootout gui/$(id -u)/\(LegacyLaunchAgentInspector.label)) and switch again."
            }
        }
    }
}

/// The takeover's go/no-go decision, kept pure for tests. `launchctl print
/// gui/<uid>/<label>` exits 0 iff the service is still loaded — only a
/// non-zero exit (service not found) may proceed to plist deletion and
/// re-registration of the same label. Even in the pathological case where
/// /bin/launchctl itself can't run (exit 127 from our runner), the shared
/// label keeps the invariant: launchd refuses a second service with the
/// same label, so a stale daemon makes registration fail loudly instead of
/// ever double-running.
public enum LegacyAgentRemoval {
    public static func serviceIsGone(printExitCode: Int32) -> Bool {
        printExitCode != 0
    }
}

// MARK: - Registration marker

/// UserDefaults-backed record of the last MDGitCommit this app registered,
/// for the launch-time drift comparison.
public final class UserDefaultsRegistrationMarker: RegistrationMarkerStore, @unchecked Sendable {
    public static let key = "modeldeck.daemon.registeredCommit"
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public var registeredCommit: String? {
        get { defaults.string(forKey: Self.key) }
        set { defaults.set(newValue, forKey: Self.key) }
    }
}

// MARK: - Reachability

extension DaemonClient: DaemonReachabilityProbing {
    /// One `GET /api/health` round-trip on the configured loopback port:
    /// nil iff no decodable health document answered. A decoded answer
    /// without `MDGitCommit` is a pre-self-reporting daemon, NOT a failure —
    /// the snapshot keeps that distinction.
    public func probeDaemon() async -> DaemonProbeSnapshot? {
        guard let health = try? await health() else { return nil }
        return DaemonProbeSnapshot(runningCommit: health.MDGitCommit)
    }
}

// MARK: - launchd-level service control

/// launchctl access to our SMAppService agent's gui-domain job, for the
/// states SMAppService can't see or fix from above (stale still-running
/// process after a no-op re-register; enabled-but-absent wedge). Same label
/// as the registration: launchd is the single source of truth here.
public struct LaunchctlDaemonServiceController: LaunchdServiceControlling {
    /// Shared with the legacy inspector on purpose — every ModelDeck
    /// service artifact carries the ONE label (that's the anti-double-daemon
    /// invariant), so the probe target can never drift from what the plists
    /// actually register.
    public static let label = LegacyLaunchAgentInspector.label

    public init() {}

    public func probeService() async -> LaunchdServiceProbe {
        // Exit-code semantics live in the pure classifier: only launchctl's
        // explicit "could not find service" (113) reads as absent; every
        // other failure — including launchctl not running at all — is
        // unknown and can never trigger the wedge repair.
        classifyLaunchctlPrintExit(
            await Self.runLaunchctl(["print", "gui/\(getuid())/\(Self.label)"])
        )
    }

    public func bootOutService() async {
        // Best-effort by contract: booting out an absent service exits
        // non-zero and that's already the goal state. The caller always
        // verifies the outcome through the running daemon's self-report.
        _ = await Self.runLaunchctl(["bootout", "gui/\(getuid())/\(Self.label)"])
    }

    /// Serializes exactly one resume of the continuation across the three
    /// competing paths (termination handler, launch failure, deadline).
    private final class ResumeOnce: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<Int32, Never>?
        init(_ continuation: CheckedContinuation<Int32, Never>) {
            self.continuation = continuation
        }
        func resume(_ status: Int32) {
            lock.lock()
            let continuation = self.continuation
            self.continuation = nil
            lock.unlock()
            continuation?.resume(returning: status)
        }
    }

    /// Runs /bin/launchctl without ever blocking the calling actor — the
    /// model drives this from the main actor at launch — and with a hard
    /// deadline: a hung launchctl is terminated and reported as the same
    /// synthetic 127 as "couldn't launch", which the classifier maps to
    /// `.unknown` (never repair, never bootout on a probe that didn't
    /// actually answer).
    private static func runLaunchctl(
        _ arguments: [String],
        deadline: TimeInterval = 5
    ) async -> Int32 {
        await withCheckedContinuation { continuation in
            let resumeOnce = ResumeOnce(continuation)
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            process.arguments = arguments
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            process.terminationHandler = { finished in
                resumeOnce.resume(finished.terminationStatus)
            }
            do {
                try process.run()
            } catch {
                resumeOnce.resume(127)
                return
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + deadline) {
                guard process.isRunning else { return }
                process.terminate()
                resumeOnce.resume(127)
            }
        }
    }
}

// MARK: - Assembly

extension DaemonSetupModel.Dependencies {
    /// The app's production wiring. `bundledCommit` comes from the daemon
    /// manifest release-dmg.sh stages next to the binary; nil in dev builds,
    /// which turns the whole feature off (decision `.bundledServiceUnavailable`).
    public static func live(client: DaemonClient, bundle: Bundle = .main) -> Self {
        .init(
            registrar: SMAppServiceAgentRegistrar(),
            tokenStore: KeychainMutationTokenStore(),
            legacyAgent: LegacyLaunchAgentInspector(),
            marker: UserDefaultsRegistrationMarker(),
            probe: client,
            launchdControl: LaunchctlDaemonServiceController(),
            bundledCommit: DaemonBundleManifest.load(from: bundle)?.MDGitCommit
        )
    }
}
