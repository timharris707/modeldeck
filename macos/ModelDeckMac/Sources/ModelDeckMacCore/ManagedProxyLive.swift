import Foundation
import os
import Security

// Issue #421 — live implementations of the ManagedProxy seams. Constructed
// only by the app target; unit tests use fakes and never spawn a proxy, never
// touch port 8317, and never read or write a real CLIProxyAPI file.

// MARK: - Process control

/// Spawns and supervises the bundle-embedded CLIProxyAPI. Owns ONLY processes
/// it started itself: `stop` can never reach a proxy the user launched.
public final class ManagedProxyProcessController: ManagedProxyProcessControlling, @unchecked Sendable {
    private let lock = NSLock()
    private var processes: [Int: Process] = [:]
    private var nextID = 1

    public init() {}

    public func start(executable: URL, configFile: URL, workingDirectory: URL) throws -> ManagedProxyProcessToken {
        let process = Process()
        process.executableURL = executable
        // `-config <file>` is CLIProxyAPI's own flag (the same invocation
        // scripts/build-cliproxyapi.sh uses for its release handshake).
        process.arguments = ["-config", configFile.path]
        process.currentDirectoryURL = workingDirectory
        // Output goes nowhere: a log file would be a second write path, and
        // the whole point of this lifecycle is that it writes exactly one file.
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        return lock.withLock {
            let id = nextID
            nextID += 1
            processes[id] = process
            return ManagedProxyProcessToken(id: id, pid: Int(process.processIdentifier))
        }
    }

    public func isRunning(_ token: ManagedProxyProcessToken) -> Bool {
        lock.withLock { processes[token.id] }?.isRunning ?? false
    }

    public func stop(_ token: ManagedProxyProcessToken) async {
        guard let process = lock.withLock({ processes.removeValue(forKey: token.id) }) else { return }
        guard process.isRunning else { return }
        // SIGTERM first so the proxy can close its listeners; SIGKILL only if
        // it ignores that for the grace period.
        process.terminate()
        for _ in 0..<20 {
            if !process.isRunning { return }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    }
}

// MARK: - Health probe

/// True iff the URL is loopback HTTP — the managed proxy is a local process
/// and its health probe must never leave the machine (same rule as the
/// daemon's own loopback-only posture).
public func isLoopbackProxyURL(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
    guard let host = url.host?.lowercased() else { return false }
    return host == "127.0.0.1" || host == "localhost" || host == "::1"
}

/// `GET /healthz` on the proxy port — the same readiness endpoint
/// scripts/build-cliproxyapi.sh handshakes against.
public struct CLIProxyHealthProbe: ManagedProxyHealthProbing {
    private let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL, timeout: TimeInterval = 2) {
        self.baseURL = baseURL
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        session = URLSession(configuration: configuration)
    }

    public func probeProxy() async -> Bool {
        guard isLoopbackProxyURL(baseURL) else { return false }
        var request = URLRequest(url: baseURL.appendingPathComponent("healthz"))
        request.httpMethod = "GET"
        guard let (_, response) = try? await session.data(for: request),
              let http = response as? HTTPURLResponse
        else { return false }
        // Any HTTP answer proves something owns the port — which is exactly
        // what the occupancy classifier asks. A 404 from a different server
        // still means "occupied", and refusing to start is the safe read.
        return (200..<500).contains(http.statusCode)
    }
}

// MARK: - Config writer

/// Failures of the seed-time management-key provisioning (#431). Every case
/// names a PATH and never the secret: the value must not reach a log, a UI
/// string, or an error message.
public enum ManagedProxySeedError: Error, LocalizedError, Equatable {
    case secretGenerationFailed(status: Int32)
    case managementKeyWriteFailed(String)
    case configWriteFailed(String)
    /// A key file exists but holds nothing usable. Reported, never repaired —
    /// overwriting it could invalidate a key something else already reads.
    case existingManagementKeyUnusable(String)

    public var errorDescription: String? {
        switch self {
        case .secretGenerationFailed(let status):
            return "ModelDeck couldn't generate a management key for the proxy (random source error \(status))."
        case .managementKeyWriteFailed(let path):
            return "ModelDeck couldn't write the proxy's management key file (\(path))."
        case .configWriteFailed(let path):
            return "ModelDeck couldn't write the seeded proxy config (\(path))."
        case .existingManagementKeyUnusable(let path):
            return "The proxy's management key file exists but is empty or unreadable (\(path)). ModelDeck left it alone."
        }
    }
}

/// Writes the managed proxy's config — and, on a seed only, its management
/// key — and nothing else, ever. Every write passes
/// `ManagedProxyWriteGuard.requirePermittedWrite` first, so an auth-file
/// destination throws instead of landing on disk.
public struct ManagedProxyConfigFileWriter: ManagedProxyConfigWriting {
    public init() {}

    public func ensureConfig(paths: ManagedProxyPaths, port: Int) throws -> URL {
        let fileManager = FileManager.default
        let configFile = paths.configFile
        // An EXISTING install's config is never touched: that is what makes
        // adopting a user's proxy non-destructive and credential-migration-
        // free (#398). We launch against exactly what they already have —
        // including when its .mgmt-key is missing (#431, Tim 2026-08-14):
        // that machine's operator owns their arrangement, so ModelDeck
        // reports rather than repairs.
        if fileManager.fileExists(atPath: configFile.path) { return configFile }
        try fileManager.createDirectory(at: paths.configDirectory, withIntermediateDirectories: true)
        try ManagedProxyWriteGuard.requirePermittedWrite(configFile, paths: paths)
        // Half-state (a key file with no config): reuse the existing key
        // rather than orphaning it — a fresh secret in the seeded config
        // would silently invalidate the key the daemon already reads.
        let secret: String
        if let existing = try Self.existingManagementKey(paths: paths) {
            secret = existing
        } else {
            // CodeRabbit (PR #439): the key is created EXCLUSIVELY. Two
            // concurrent seeds each generating a secret would otherwise
            // overwrite .mgmt-key while their configs kept different values —
            // the daemon could then never authenticate, silently. The loser
            // of the race rereads and adopts the winner's key, so every
            // config written carries the one secret that is on disk.
            let generated = try Self.generateManagementSecret()
            if try Self.writeManagementKeyExclusively(generated, paths: paths) {
                secret = generated
            } else if let winner = try Self.existingManagementKey(paths: paths) {
                secret = winner
            } else {
                throw ManagedProxySeedError.existingManagementKeyUnusable(paths.managementKeyFile.path)
            }
        }
        try Self.writeSeededConfig(
            Self.seedConfig(paths: paths, port: port, managementSecret: secret),
            to: configFile
        )
        return configFile
    }

    /// The minimum that makes a fresh proxy usable: where to listen, where its
    /// own auth files live, and the management secret the daemon's usage-queue
    /// consumer authenticates with (#431), and an hour of usage-queue
    /// retention so records survive the daemon's 5-minute pull (#785; the
    /// proxy's default of 60 seconds drops most of them). Still says nothing
    /// about provider credentials — those remain CLIProxyAPI's alone (#398).
    static func seedConfig(paths: ManagedProxyPaths, port: Int, managementSecret: String) -> String {
        """
        # Written by ModelDeck when no CLIProxyAPI config existed yet.
        # ModelDeck manages this file and the proxy process only — CLIProxyAPI
        # remains the sole writer of everything under auth-dir. An existing
        # config is never modified.
        host: "127.0.0.1"
        port: \(port)
        remote-management:
          allow-remote: false
          secret-key: "\(managementSecret)"
        auth-dir: '\(paths.authDirectory.path.replacingOccurrences(of: "'", with: "''"))'
        redis-usage-queue-retention-seconds: 3600

        """
    }

    /// 32 random bytes, base64url, unpadded — the same shape as the daemon's
    /// mutation token. No Keychain: the proxy needs the secret in its config
    /// file in plain form, so a second copy would add complexity, not secrecy
    /// (#431 ruling).
    static func generateManagementSecret() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let rc = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard rc == errSecSuccess else { throw ManagedProxySeedError.secretGenerationFailed(status: rc) }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// nil when no key file exists; throws when one exists but holds nothing
    /// usable, so a broken half-state surfaces instead of being papered over.
    static func existingManagementKey(paths: ManagedProxyPaths) throws -> String? {
        let keyFile = paths.managementKeyFile
        guard FileManager.default.fileExists(atPath: keyFile.path) else { return nil }
        let contents = (try? String(contentsOf: keyFile, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let contents, !contents.isEmpty else {
            throw ManagedProxySeedError.existingManagementKeyUnusable(keyFile.path)
        }
        return contents
    }

    /// Owner-only (0600) from creation, not chmod'ed afterwards: the secret
    /// must never exist on disk world-readable, even briefly.
    /// The seeded config carries the same secret as the key file, so it gets
    /// the same 0600-from-birth treatment (CodeRabbit, PR #439 round 2):
    /// mkstemp creates the temp owner-only, rename keeps both the mode and
    /// the all-or-nothing property — a crash leaves no torn, readable config.
    /// One publication discipline for both secret-bearing files (CodeRabbit,
    /// PR #439 rounds 2-3): the bytes land in an mkstemp temp (owner-only by
    /// construction), then publish via renamex_np(RENAME_EXCL) — atomic AND
    /// no-replace. A file therefore only ever appears complete: no empty-key
    /// window a competing seed could misread, and no clobbering of a file
    /// that appeared after the caller's existence check. Returns false when
    /// the destination already exists (the caller adopts the winner's file).
    private static func publishExclusively(
        _ contents: String,
        at destination: URL,
        onFailure fail: (String) -> ManagedProxySeedError
    ) throws -> Bool {
        let directory = destination.deletingLastPathComponent().path
        var template = Array("\(directory)/.seed.XXXXXX".utf8CString)
        let fd = mkstemp(&template)
        guard fd >= 0 else { throw fail(destination.path) }
        let tempPath = String(decoding: template.prefix(while: { $0 != 0 }).map { UInt8(bitPattern: $0) }, as: UTF8.self)
        defer { close(fd) }
        // write(2) may return short counts or EINTR — loop to completion
        // (CodeRabbit, PR #439 round 4); terminal failures still clean up.
        let payload = Array(contents.utf8)
        var written = 0
        while written < payload.count {
            let n = payload.withUnsafeBytes {
                write(fd, $0.baseAddress!.advanced(by: written), $0.count - written)
            }
            if n > 0 { written += n; continue }
            if n < 0 && errno == EINTR { continue }
            unlink(tempPath)
            throw fail(destination.path)
        }
        guard renamex_np(tempPath, destination.path, UInt32(RENAME_EXCL)) == 0 else {
            // errno is read BEFORE unlink, which would clobber it
            // (CodeRabbit, PR #439 round 5).
            let renameErrno = errno
            unlink(tempPath)
            if renameErrno == EEXIST { return false }
            throw fail(destination.path)
        }
        return true
    }

    static func writeSeededConfig(_ contents: String, to configFile: URL) throws {
        // A config that exists by publish time was created by someone else
        // after our existence check — theirs stands, per the non-destructive
        // existing-install contract; racing seeds carry the same secret anyway.
        _ = try publishExclusively(contents, at: configFile, onFailure: ManagedProxySeedError.configWriteFailed)
    }

    static func writeManagementKeyExclusively(_ secret: String, paths: ManagedProxyPaths) throws -> Bool {
        let keyFile = paths.managementKeyFile
        try ManagedProxyWriteGuard.requirePermittedWrite(keyFile, paths: paths)
        return try publishExclusively(secret + "\n", at: keyFile, onFailure: ManagedProxySeedError.managementKeyWriteFailed)
    }

}

/// The probe URL is load-bearing for the #400 double-consume rail: a nil
/// here once fell back to a file URL the probe silently rejected, which
/// disabled foreign-instance detection outright (PR #430 review). Built from
/// components so it cannot fail for a valid port; anything else is a
/// programmer error worth crashing a debug build over.
func loopbackBaseURL(port: Int) -> URL {
    var components = URLComponents()
    components.scheme = "http"
    components.host = "127.0.0.1"
    components.port = port
    guard let url = components.url else {
        assertionFailure("loopback URL could not be built for port \(port)")
        return URL(string: "http://127.0.0.1:8317")!
    }
    return url
}

// MARK: - Remembered pool role

/// Issue #784 review: the last pool role a daemon state reported, in the
/// app's own defaults domain (same convention as the onboarding choice). A
/// stored name this build does not know stands down like remote.
public final class UserDefaultsProxyRoleMemory: ProxyRoleRemembering, @unchecked Sendable {
    private static let key = "proxyRoleLastSeen"
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public var lastSeenRole: ProxyRole? {
        get { defaults.string(forKey: Self.key).map(ProxyRole.init(named:)) }
        set {
            if let newValue {
                defaults.set(newValue.rawValue, forKey: Self.key)
            } else {
                defaults.removeObject(forKey: Self.key)
            }
        }
    }
}

// MARK: - Assembly

extension ManagedProxyModel.Dependencies {
    /// The app's production wiring. `bundle` resolves the proxy binary from
    /// scripts/cliproxyapi-pin.json staged into the app — the ONE authority
    /// for that path — and comes back unavailable in dev builds, which turns
    /// the whole feature off honestly (decision `.unavailable`).
    public static func live(
        reporter: any ManagedProxyReporting,
        bundle: Bundle = .main,
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        port: Int = ManagedProxyDefaults.port,
        defaults: UserDefaults = .standard
    ) -> Self {
        let pin = CLIProxyBundlePin.load(from: bundle)
        let binaryURL = resolveCLIProxyBinaryURL(
            appBundleURL: bundle.bundleURL,
            bundlePath: pin?.bundlePath
        )
        let executable = binaryURL.flatMap {
            FileManager.default.isExecutableFile(atPath: $0.path) ? $0 : nil
        }
        let logger = Logger(subsystem: "app.modeldeck.mac", category: "managed-proxy")
        if pin != nil, executable == nil {
            logger.info("cliproxyapi pin present but no executable at the pinned bundle path; managed proxy unavailable")
        }
        return .init(
            bundle: ManagedProxyBundle(binaryURL: executable, version: pin?.tag),
            paths: .standard(home: home),
            process: ManagedProxyProcessController(),
            health: CLIProxyHealthProbe(baseURL: loopbackBaseURL(port: port)),
            config: ManagedProxyConfigFileWriter(),
            reporter: reporter,
            appVersion: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
            reportFailure: { message in logger.error("\(message, privacy: .public)") },
            port: port,
            roleMemory: UserDefaultsProxyRoleMemory(defaults: defaults)
        )
    }

    /// Dev builds, previews, and anything that must not manage a proxy.
    public static func unavailable(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> Self {
        .init(
            bundle: .unavailable,
            paths: .standard(home: home),
            process: ManagedProxyProcessController(),
            health: UnreachableProxyProbe(),
            config: ManagedProxyConfigFileWriter()
        )
    }
}

/// Never answers — used by the unavailable wiring so a dev build performs no
/// network activity at all.
struct UnreachableProxyProbe: ManagedProxyHealthProbing {
    func probeProxy() async -> Bool { false }
}
