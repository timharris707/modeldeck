import Foundation
import Combine
import CryptoKit

// Issue #706: rollback bypasses Sparkle's newer-build-only installer, but
// never bypasses its signed-enclosure trust boundary (decision 0043).
public enum AppRollbackTarget {
    // The release shipping #706 must match this version and name it in its
    // release notes: older apps cannot honor the skip or clean up the backup.
    public static let firstCapableVersion = "1.1.16"

    public static func select(
        items: [AppcastItem], currentVersion: String, currentBuild: String,
        runningSystem: OperatingSystemVersion = ProcessInfo.processInfo.operatingSystemVersion
    ) -> AppcastItem? {
        let newest = items.max { AppVersion.isNewer($1.shortVersionString, than: $0.shortVersionString) }
        let running = items.first { $0.build == currentBuild }
        let floor = running != nil ? running?.rollbackFloor : newest?.rollbackFloor
        return items.filter {
            $0.channel == nil && $0.isEligible(on: runningSystem)
                && !AppVersion.isNewer(firstCapableVersion, than: $0.shortVersionString)
                && $0.build.map(isNumericBuild) == true
                && AppVersion.isNewer(currentVersion, than: $0.shortVersionString)
                && (floor == nil || !AppVersion.isNewer(floor!, than: $0.shortVersionString))
        }.max { AppVersion.isNewer($1.shortVersionString, than: $0.shortVersionString) }
    }

    static func isNumericBuild(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.allSatisfy { (48...57).contains($0) }
    }
}

public struct AppRollbackError: LocalizedError, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

public protocol AppRollbackSignatureVerifying: Sendable {
    func verify(data: Data, signature: String, publicKey: String) throws
}

public struct AppRollbackSignatureVerifier: AppRollbackSignatureVerifying {
    public init() {}
    public func verify(data: Data, signature: String, publicKey: String) throws {
        guard let keyBytes = Data(base64Encoded: publicKey),
              let signatureBytes = Data(base64Encoded: signature),
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyBytes),
              key.isValidSignature(signatureBytes, for: data) else {
            throw AppRollbackError("The download's signature could not be verified.")
        }
    }
}

public struct AppRollbackBundleIdentity: Sendable {
    public let runningTeamID: String
    public let candidateTeamID: String
    public let build: String
    public init(runningTeamID: String, candidateTeamID: String, build: String) {
        self.runningTeamID = runningTeamID
        self.candidateTeamID = candidateTeamID
        self.build = build
    }
}

@MainActor public protocol AppRollbackBundleInspecting {
    func mount(image: URL) async throws -> URL
    func inspect(bundle: URL, runningBundle: URL) async throws -> AppRollbackBundleIdentity
    func detach(mount: URL) async throws
}

@MainActor public protocol AppRollbackSwapping {
    func stage(bundle: URL, runningBundle: URL) async throws -> URL
    func swap(staged: URL, runningBundle: URL) throws -> URL
    func restore(backup: URL, runningBundle: URL) throws
    func cleanStaging(staged: URL)
}

@MainActor public protocol AppRollbackLaunching {
    func launch(bundle: URL) async throws
    func terminate()
}

@MainActor
public final class AppRollbackModel: ObservableObject {
    public enum Phase: Equatable, Sendable {
        case idle, downloading(fraction: Double?), verifying, swapping, relaunching
        case failed(message: String)
    }
    @Published public private(set) var phase: Phase = .idle
    @Published public private(set) var target: AppcastItem?
    public private(set) var lastAttemptAt: Date?
    private let currentVersion: String
    private let currentBuild: String
    private let runningBundle: URL
    private let publicKey: String
    private let transport: any HTTPDataTransport
    private let verifier: any AppRollbackSignatureVerifying
    private let inspector: any AppRollbackBundleInspecting
    private let swapper: any AppRollbackSwapping
    private let launcher: any AppRollbackLaunching
    private let defaults: UserDefaults
    private let temporaryDirectory: URL
    private let clock: () -> Date
    private let reserveInstallation: () -> Bool
    private let releaseInstallation: () -> Void

    public init(currentVersion: String, currentBuild: String, runningBundle: URL, publicKey: String,
                transport: any HTTPDataTransport = URLSession.shared,
                verifier: any AppRollbackSignatureVerifying = AppRollbackSignatureVerifier(),
                inspector: any AppRollbackBundleInspecting, swapper: any AppRollbackSwapping,
                launcher: any AppRollbackLaunching, defaults: UserDefaults = .standard,
                clock: @escaping () -> Date = Date.init,
                temporaryDirectory: URL = FileManager.default.temporaryDirectory,
                reserveInstallation: @escaping () -> Bool = { true },
                releaseInstallation: @escaping () -> Void = {}) {
        self.currentVersion = currentVersion
        self.currentBuild = currentBuild
        self.runningBundle = runningBundle
        self.publicKey = publicKey
        self.transport = transport
        self.verifier = verifier
        self.inspector = inspector
        self.swapper = swapper
        self.launcher = launcher
        self.defaults = defaults
        self.clock = clock
        self.temporaryDirectory = temporaryDirectory
        self.reserveInstallation = reserveInstallation
        self.releaseInstallation = releaseInstallation
    }

    public var isBusy: Bool {
        switch phase {
        case .idle, .failed: false
        default: true
        }
    }

    public func refreshTarget() async {
        guard !isBusy, !currentVersion.isEmpty, !currentBuild.isEmpty, !publicKey.isEmpty else { return }
        do {
            let data = try await download(AppcastReleaseChecker.defaultFeedURL, timeout: 15)
            target = AppRollbackTarget.select(items: try AppcastDecoder.items(from: data),
                                              currentVersion: currentVersion, currentBuild: currentBuild)
        } catch { target = nil }
    }

    public func rollback(to item: AppcastItem) async {
        guard !isBusy else { return }
        guard reserveInstallation() else {
            phase = .failed(message: "An app update is already in progress. Finish that update before rolling back.")
            return
        }
        lastAttemptAt = clock()
        phase = .downloading(fraction: nil)
        let directory = temporaryDirectory.appendingPathComponent("modeldeck-rollback-\(UUID().uuidString)")
        let image = directory.appendingPathComponent("update.dmg")
        var mounted: URL?
        var staged: URL?
        defer {
            try? FileManager.default.removeItem(at: directory)
            if let staged { swapper.cleanStaging(staged: staged) }
        }
        do {
            guard let url = item.enclosureURL, url.scheme == "https",
                  let length = item.enclosureLength, length > 0,
                  let signature = item.edSignature, let build = item.build,
                  AppRollbackTarget.isNumericBuild(build),
                  !AppVersion.isNewer(AppRollbackTarget.firstCapableVersion, than: item.shortVersionString),
                  item.channel == nil, item.isEligible(on: ProcessInfo.processInfo.operatingSystemVersion),
                  AppVersion.isNewer(currentVersion, than: item.shortVersionString) else {
                throw AppRollbackError("This release is missing the information needed for a safe rollback.")
            }
            let bytes = try await download(url, timeout: 300)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                                    attributes: [.posixPermissions: 0o700])
            try bytes.write(to: image, options: [.atomic])
            let writtenInode = try FileManager.default.attributesOfItem(atPath: image.path)[.systemFileNumber] as? NSNumber
            phase = .downloading(fraction: 1)
            let persistedBytes = try Data(contentsOf: image, options: [.uncached])
            let readAttributes = try FileManager.default.attributesOfItem(atPath: image.path)
            guard let writtenInode, readAttributes[.systemFileNumber] as? NSNumber == writtenInode,
                  readAttributes[.type] as? FileAttributeType == .typeRegular else {
                throw AppRollbackError("The downloaded file changed before it could be verified.")
            }
            guard persistedBytes.count == length else { throw AppRollbackError("The download size does not match the release.") }
            phase = .verifying
            try verifier.verify(data: persistedBytes, signature: signature, publicKey: publicKey)
            let mount = try await inspector.mount(image: image)
            mounted = mount
            let bundle = mount.appendingPathComponent("ModelDeck.app")
            let identity = try await inspector.inspect(bundle: bundle, runningBundle: runningBundle)
            guard !identity.runningTeamID.isEmpty, identity.candidateTeamID == identity.runningTeamID else {
                throw AppRollbackError("This app is not signed by the same developer as the running app.")
            }
            guard identity.build == build else { throw AppRollbackError("The app's build does not match the selected release.") }
            let stage = try await swapper.stage(bundle: bundle, runningBundle: runningBundle)
            staged = stage
            let stagedIdentity = try await inspector.inspect(bundle: stage, runningBundle: runningBundle)
            guard stagedIdentity.runningTeamID == identity.runningTeamID,
                  stagedIdentity.candidateTeamID == identity.runningTeamID, stagedIdentity.build == build else {
                throw AppRollbackError("The staged app does not match the verified release.")
            }
            try await inspector.detach(mount: mount)
            mounted = nil
            try Task.checkCancellation()
            phase = .swapping
            let backup = try swapper.swap(staged: stage, runningBundle: runningBundle)
            let previousSkip = defaults.string(forKey: AppUpdateSkipPolicy.key)
            let previousMarker = defaults.object(forKey: UserDefaultsUpdateRelaunchMarker.key)
            defaults.set(backup.path, forKey: AppRollbackReadiness.backupPathKey)
            defaults.set(currentVersion, forKey: AppUpdateSkipPolicy.key)
            UserDefaultsUpdateRelaunchMarker(defaults: defaults).recordRelaunch()
            // Issue #706: the new process may start before this one exits.
            defaults.synchronize()
            phase = .relaunching
            do {
                try await launcher.launch(bundle: runningBundle)
            } catch let launchError {
                do { try swapper.restore(backup: backup, runningBundle: runningBundle) }
                catch let restoreError {
                    // CodeRabbit (PR #711): both failures matter in this case.
                    throw AppRollbackError("ModelDeck could not restart (\(launchError.localizedDescription)) or restore its previous app (\(restoreError.localizedDescription)). The backup is at \(backup.path).")
                }
                defaults.removeObject(forKey: AppRollbackReadiness.backupPathKey)
                defaults.set(previousSkip, forKey: AppUpdateSkipPolicy.key)
                defaults.set(previousMarker, forKey: UserDefaultsUpdateRelaunchMarker.key)
                throw AppRollbackError("ModelDeck could not restart. The previous app has been restored.")
            }
            // Issue #706: AppKit termination does not unwind Swift defers.
            // Remove our temporary files before asking the process to exit.
            swapper.cleanStaging(staged: stage)
            staged = nil
            try? FileManager.default.removeItem(at: directory)
            launcher.terminate()
        } catch {
            if let mounted { try? await inspector.detach(mount: mounted) }
            releaseInstallation()
            phase = .failed(message: error.localizedDescription)
        }
    }

    private func download(_ url: URL, timeout: TimeInterval) async throws -> Data {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "GET"
        let (data, response) = try await transport.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              http.url?.scheme == "https" else { throw AppRollbackError("The release download failed.") }
        return data
    }
}
