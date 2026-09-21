import Foundation
import CryptoKit
import Combine
import Testing
@testable import ModelDeckMacCore

struct AppRollbackTargetTests {
    let system = OperatingSystemVersion(majorVersion: 15, minorVersion: 0, patchVersion: 0)

    @Test func firstCapableVersionIsTheFeatureRelease() {
        #expect(AppRollbackTarget.firstCapableVersion == "1.1.16")
    }

    @Test func preRollbackReleasesAreNeverOffered() {
        let legacy = AppcastItem(shortVersionString: "1.1.15", build: "15")
        let capable = AppcastItem(shortVersionString: "1.1.16", build: "16")
        #expect(AppRollbackTarget.select(items: [legacy, capable], currentVersion: "1.1.16", currentBuild: "16") == nil)
        #expect(AppRollbackTarget.select(items: [legacy], currentVersion: "1.1.17", currentBuild: "17") == nil)
        #expect(AppRollbackTarget.select(items: [legacy, capable], currentVersion: "1.1.17", currentBuild: "17") == capable)
    }

    @Test func selectsOlderStableEligibleBuildAndHonorsRunningFloor() {
        let older = AppcastItem(shortVersionString: "1.1.16", build: "10")
        let current = AppcastItem(shortVersionString: "1.2.0", build: "20", rollbackFloor: "1.1.16")
        let items = [older, current,
            AppcastItem(shortVersionString: "1.3.0", build: "30", rollbackFloor: "1.3.0"),
            AppcastItem(shortVersionString: "1.1.19", build: "19", channel: "beta"),
            AppcastItem(shortVersionString: "1.1.18", minimumSystemVersion: "26", build: "18"),
            AppcastItem(shortVersionString: "1.1.17"),
            AppcastItem(shortVersionString: "1.0.0", build: "9")]
        #expect(AppRollbackTarget.select(items: items, currentVersion: "1.2.0", currentBuild: "20", runningSystem: system) == older)
        #expect(AppRollbackTarget.select(items: Array(items.dropFirst(2)), currentVersion: "1.2.0", currentBuild: "20", runningSystem: system) == nil)
        #expect(AppRollbackTarget.select(items: [older], currentVersion: "1.0.0", currentBuild: "9", runningSystem: system) == nil)
        #expect(AppRollbackTarget.select(items: [older], currentVersion: "1.2.0", currentBuild: "20", runningSystem: system) == older)
    }

    @Test func runningBuildOwnsFloorEvenWhenDisplayVersionsDiffer() {
        let old = AppcastItem(shortVersionString: "1.1.16", build: "10")
        let own = AppcastItem(shortVersionString: "1.2.0", build: "20")
        let newest = AppcastItem(shortVersionString: "1.3.0", build: "30", rollbackFloor: "1.2.0")
        #expect(AppRollbackTarget.select(items: [old, own, newest], currentVersion: "1.2.0", currentBuild: "20", runningSystem: system) == old)
        #expect(AppRollbackTarget.select(items: [old, own, newest], currentVersion: "1.2.0", currentBuild: "21", runningSystem: system) == nil)
        #expect(AppRollbackTarget.select(items: [], currentVersion: "1.2.0", currentBuild: "20", runningSystem: system) == nil)
    }

    @Test func decodesRollbackIdentityAndEnclosureEvidence() throws {
        let xml = Data("""
        <rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:modeldeck="https://modeldeck.app/xml-namespaces/modeldeck"><channel><item>
        <sparkle:shortVersionString>1.1.0</sparkle:shortVersionString><sparkle:version>123</sparkle:version>
        <modeldeck:rollbackFloor>1.0.0</modeldeck:rollbackFloor><sparkle:channel>beta</sparkle:channel>
        <enclosure url="https://example.invalid/app.dmg" length="42" sparkle:edSignature="signed"/>
        </item><item><sparkle:shortVersionString>1.0.0</sparkle:shortVersionString></item></channel></rss>
        """.utf8)
        let items = try AppcastDecoder.items(from: xml)
        #expect(items[0].build == "123")
        #expect(items[0].rollbackFloor == "1.0.0")
        #expect(items[0].channel == "beta")
        #expect(items[0].edSignature == "signed")
        #expect(items[0].enclosureLength == 42)
        #expect(items[1].build == nil && items[1].edSignature == nil && items[1].channel == nil)
    }

    @Test func signatureRejectsTamperingAndWrongKey() throws {
        let key = Curve25519.Signing.PrivateKey()
        let bytes = Data("signed disk image".utf8)
        let signature = try key.signature(for: bytes).base64EncodedString()
        let verifier = AppRollbackSignatureVerifier()
        try verifier.verify(data: bytes, signature: signature, publicKey: key.publicKey.rawRepresentation.base64EncodedString())
        var tampered = bytes
        tampered[0] ^= 1
        #expect(throws: (any Error).self) {
            try verifier.verify(data: tampered, signature: signature, publicKey: key.publicKey.rawRepresentation.base64EncodedString())
        }
        #expect(throws: (any Error).self) {
            try verifier.verify(data: bytes, signature: signature, publicKey: Curve25519.Signing.PrivateKey().publicKey.rawRepresentation.base64EncodedString())
        }
    }
}

@MainActor
struct AppRollbackModelTests {
    @Test(arguments: ["byte", "length", "inode"])
    func persistedImageMustMatchSignatureAndIdentity(change: String) async throws {
        let fixture = try RollbackFixture()
        defer { fixture.clean() }
        var changed = false
        let observer = fixture.model.$phase.sink { phase in
            guard phase == .downloading(fraction: 1) else { return }
            do {
                let files = FileManager.default
                let enumerator = try #require(files.enumerator(at: fixture.root, includingPropertiesForKeys: nil))
                let images = enumerator.allObjects.compactMap { $0 as? URL }.filter { $0.pathExtension == "dmg" }
                let image = try #require(images.first)
                var bytes = try Data(contentsOf: image)
                if change == "byte" { bytes[0] ^= 1 }
                if change == "length" { bytes.append(0) }
                // Atomic replacement substitutes the inode, even with authentic bytes.
                if change == "inode" {
                    try bytes.write(to: image, options: [.atomic])
                } else {
                    let file = try FileHandle(forWritingTo: image)
                    defer { try? file.close() }
                    try file.write(contentsOf: bytes)
                }
                changed = true
            } catch { Issue.record("Could not mutate owned image: \(error)") }
        }
        await fixture.model.rollback(to: fixture.item)
        withExtendedLifetime(observer) {}
        #expect(changed)
        guard case .failed(let message) = fixture.model.phase else {
            Issue.record("Changed image was accepted"); return
        }
        let reason = change == "byte" ? "signature" : change == "length" ? "size" : "file changed"
        #expect(message.contains(reason))
        #expect(fixture.operations.events.isEmpty, "Unauthenticated file must never reach the mounter")
    }

    @Test func verifiedImageLivesInPrivateDirectoryAndIsRemoved() async throws {
        let fixture = try RollbackFixture()
        defer { fixture.clean() }
        var mountedImage: URL?
        fixture.operations.onMount = { image in
            mountedImage = image
            let attributes = try FileManager.default.attributesOfItem(atPath: image.deletingLastPathComponent().path)
            #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700)
            #expect(try Data(contentsOf: image) == Data("disk image".utf8))
        }
        await fixture.model.rollback(to: fixture.item)
        let image = try #require(mountedImage)
        #expect(!FileManager.default.fileExists(atPath: image.deletingLastPathComponent().path))
    }

    @Test func lengthMismatchNeverInspectsOrSwaps() async throws {
        let fixture = try RollbackFixture()
        defer { fixture.clean() }
        var item = fixture.item
        item.enclosureLength = 99
        await fixture.model.rollback(to: item)
        #expect(fixture.model.phase.isFailure)
        #expect(fixture.operations.events.isEmpty)
    }

    @Test(arguments: ["team", "build"])
    func identityMismatchNeverSwaps(mismatch: String) async throws {
        let fixture = try RollbackFixture()
        defer { fixture.clean() }
        if mismatch == "team" { fixture.operations.team = "OTHER" }
        else { fixture.operations.build = "999" }
        await fixture.model.rollback(to: fixture.item)
        #expect(fixture.model.phase.isFailure)
        #expect(!fixture.operations.events.contains("stage"))
        #expect(!fixture.operations.events.contains("swap"))
        #expect(fixture.operations.events.last == "detach")
    }

    @Test func failedLauncherRestoresBackupAndPreferences() async throws {
        let fixture = try RollbackFixture()
        defer { fixture.clean() }
        fixture.operations.launchFails = true
        await fixture.model.rollback(to: fixture.item)
        #expect(fixture.model.phase.isFailure)
        #expect(fixture.operations.events == ["mount", "inspect", "stage", "inspect", "detach", "swap", "launch", "restore", "cleanup"])
        #expect(!fixture.operations.swapped)
        #expect(fixture.defaults.string(forKey: AppRollbackReadiness.backupPathKey) == nil)
        #expect(fixture.defaults.string(forKey: AppUpdateSkipPolicy.key) == nil)
        #expect(!fixture.defaults.bool(forKey: UserDefaultsUpdateRelaunchMarker.key))
    }

    @Test func invalidEnclosureSignatureNeverMounts() async throws {
        let fixture = try RollbackFixture()
        defer { fixture.clean() }
        var item = fixture.item
        item.edSignature = Data(repeating: 0, count: 64).base64EncodedString()
        await fixture.model.rollback(to: item)
        #expect(fixture.model.phase.isFailure)
        #expect(fixture.operations.events.isEmpty)
    }

    @Test func failedRestoreKeepsRecoveryPathAndNeverTerminates() async throws {
        let fixture = try RollbackFixture()
        defer { fixture.clean() }
        fixture.operations.launchFails = true
        fixture.operations.restoreFails = true
        await fixture.model.rollback(to: fixture.item)
        guard case .failed(let message) = fixture.model.phase else {
            Issue.record("Restore failure was not surfaced"); return
        }
        #expect(message.contains(fixture.operations.backup.path))
        // CodeRabbit (PR #711): the restore failure must not hide why the launch failed.
        #expect(message.contains(CocoaError(.fileWriteNoPermission).localizedDescription))
        #expect(message.contains(fixture.operations.launchErrorDescription))
        #expect(fixture.defaults.string(forKey: AppRollbackReadiness.backupPathKey) == fixture.operations.backup.path)
        #expect(!fixture.operations.events.contains("terminate"))
    }

    @Test func successfulRollbackRecordsRecoveryBeforeLaunchAndTerminates() async throws {
        let fixture = try RollbackFixture()
        defer { fixture.clean() }
        fixture.operations.onLaunch = { [defaults = fixture.defaults, backup = fixture.operations.backup] in
            #expect(defaults.string(forKey: AppRollbackReadiness.backupPathKey) == backup.path)
            #expect(defaults.string(forKey: AppUpdateSkipPolicy.key) == "1.2.0")
            #expect(defaults.bool(forKey: UserDefaultsUpdateRelaunchMarker.key))
        }
        await fixture.model.rollback(to: fixture.item)
        #expect(fixture.model.phase == .relaunching)
        #expect(fixture.operations.events == ["mount", "inspect", "stage", "inspect", "detach", "swap", "launch", "cleanup", "terminate"])
        #expect(fixture.defaults.string(forKey: AppUpdateSkipPolicy.key) == "1.2.0")
        #expect(fixture.defaults.string(forKey: AppRollbackReadiness.backupPathKey) == fixture.operations.backup.path)
        #expect(fixture.defaults.bool(forKey: UserDefaultsUpdateRelaunchMarker.key))
        #expect(fixture.model.lastAttemptAt == Date(timeIntervalSince1970: 123))
    }
}

private extension AppRollbackModel.Phase {
    var isFailure: Bool { if case .failed = self { true } else { false } }
}

private struct RollbackTransport: HTTPDataTransport {
    var bytes: Data
    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        (bytes, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

@MainActor
private final class RollbackOperations: AppRollbackBundleInspecting, AppRollbackSwapping, AppRollbackLaunching {
    var events: [String] = []
    var team = "EXPECTED"
    var build = "10"
    var swapped = false
    var launchFails = false
    let launchErrorDescription = "open could not finish (1)."
    var restoreFails = false
    var onLaunch: () -> Void = {}
    var onMount: (URL) throws -> Void = { _ in }
    let root: URL
    var backup: URL { root.appendingPathComponent("ModelDeck (before rollback).app") }
    init(root: URL) { self.root = root }
    func mount(image: URL) async throws -> URL { events.append("mount"); try onMount(image); return root }
    func inspect(bundle: URL, runningBundle: URL) async throws -> AppRollbackBundleIdentity {
        events.append("inspect")
        return .init(runningTeamID: "EXPECTED", candidateTeamID: team, build: build)
    }
    func detach(mount: URL) async throws { events.append("detach") }
    func stage(bundle: URL, runningBundle: URL) async throws -> URL {
        events.append("stage"); return root.appendingPathComponent("staged.app")
    }
    func swap(staged: URL, runningBundle: URL) throws -> URL {
        events.append("swap"); swapped = true; return backup
    }
    func restore(backup: URL, runningBundle: URL) throws {
        events.append("restore")
        if restoreFails { throw CocoaError(.fileWriteNoPermission) }
        swapped = false
    }
    func cleanStaging(staged: URL) { events.append("cleanup") }
    func launch(bundle: URL) async throws {
        events.append("launch")
        onLaunch()
        if launchFails { throw AppRollbackError(launchErrorDescription) }
    }
    func terminate() {
        #expect(events.last == "cleanup", "AppKit may exit without returning; cleanup must precede terminate")
        events.append("terminate")
    }
}

@MainActor
private struct RollbackFixture {
    let root: URL
    let defaults: UserDefaults
    let operations: RollbackOperations
    let model: AppRollbackModel
    let item: AppcastItem
    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defaults = ScratchDefaults.make("rollback")
        operations = RollbackOperations(root: root)
        let bytes = Data("disk image".utf8)
        let key = Curve25519.Signing.PrivateKey()
        item = AppcastItem(shortVersionString: "1.1.16", enclosureURL: URL(string: "https://example.invalid/app.dmg"), build: "10", edSignature: try key.signature(for: bytes).base64EncodedString(), enclosureLength: bytes.count)
        model = AppRollbackModel(currentVersion: "1.2.0", currentBuild: "20", runningBundle: root.appendingPathComponent("ModelDeck.app"), publicKey: key.publicKey.rawRepresentation.base64EncodedString(), transport: RollbackTransport(bytes: bytes), verifier: AppRollbackSignatureVerifier(), inspector: operations, swapper: operations, launcher: operations, defaults: defaults, clock: { Date(timeIntervalSince1970: 123) }, temporaryDirectory: root)
    }
    func clean() { try? FileManager.default.removeItem(at: root) }
}

@MainActor
struct AppRollbackPolicyTests {
    @Test func skipHidesExactlyOneVersionAndExplicitCheckClearsIt() async {
        let defaults = ScratchDefaults.make("rollback-skip")
        defaults.set("1.2.0", forKey: AppUpdateSkipPolicy.key)
        #expect(!AppUpdateSkipPolicy.allows(version: "1.2.0", defaults: defaults))
        #expect(AppUpdateSkipPolicy.allows(version: "1.3.0", defaults: defaults))
        #expect(AppUpdateSkipPolicy.allows(version: "1.1.0", defaults: defaults))
        let checker = RollbackReleaseChecker(version: "1.2.0")
        let model = AppUpdateModel(checker: checker, currentVersion: "1.1.0", defaults: defaults)
        await model.check()
        #expect(model.phase == .upToDate(latest: "1.1.0"))
        _ = await model.explicitCheck()
        #expect(defaults.string(forKey: AppUpdateSkipPolicy.key) == nil)
        let release = try! await checker.latestRelease()!
        #expect(model.phase == .updateAvailable(release))
    }

    @Test func checkerFiltersSkipBeforeChoosingNewestAndOffersLaterFix() async throws {
        let defaults = ScratchDefaults.make("rollback-checker")
        defaults.set("1.2.0", forKey: AppUpdateSkipPolicy.key)
        func checker(_ versions: [String]) -> AppcastReleaseChecker {
            let items = versions.map { "<item><sparkle:shortVersionString>\($0)</sparkle:shortVersionString></item>" }.joined()
            let xml = "<rss xmlns:sparkle=\"http://www.andymatuschak.org/xml-namespaces/sparkle\"><channel>\(items)</channel></rss>"
            return AppcastReleaseChecker(feedURL: URL(string: "https://example.invalid/feed")!,
                transport: RollbackTransport(bytes: Data(xml.utf8)), defaults: defaults)
        }
        #expect(try await checker(["1.1.0", "1.2.0"]).latestRelease()?.version == "1.1.0")
        #expect(try await checker(["1.1.0", "1.2.0", "1.3.0"]).latestRelease()?.version == "1.3.0")
        #expect(try await checker(["1.2.0"]).latestRelease() == nil)
    }

    @Test func readinessOnlyRemovesExistingNamedBackupForRunningProcess() throws {
        let defaults = ScratchDefaults.make("rollback-ready")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let running = root.appendingPathComponent("ModelDeck.app")
        let backup = root.appendingPathComponent("ModelDeck (before rollback).app")
        defaults.set(backup.path, forKey: AppRollbackReadiness.backupPathKey)
        #expect(!AppRollbackReadiness.finishLaunch(runningBundle: running, isRunningProcess: true, defaults: defaults))
        #expect(defaults.string(forKey: AppRollbackReadiness.backupPathKey) != nil)
        try FileManager.default.createDirectory(at: backup, withIntermediateDirectories: true)
        #expect(!AppRollbackReadiness.finishLaunch(runningBundle: running, isRunningProcess: false, defaults: defaults))
        #expect(FileManager.default.fileExists(atPath: backup.path))
        #expect(AppRollbackReadiness.finishLaunch(runningBundle: running, isRunningProcess: true, defaults: defaults))
        #expect(!FileManager.default.fileExists(atPath: backup.path))
        #expect(defaults.string(forKey: AppRollbackReadiness.backupPathKey) == nil)
        defaults.set(root.path, forKey: AppRollbackReadiness.backupPathKey)
        #expect(!AppRollbackReadiness.finishLaunch(runningBundle: running, isRunningProcess: true, defaults: defaults))
        #expect(FileManager.default.fileExists(atPath: root.path))
    }
}

private struct RollbackReleaseChecker: AppReleaseChecking {
    let version: String
    func latestRelease() async throws -> AppReleaseInfo? {
        AppReleaseInfo(version: version, url: URL(string: "https://example.invalid/release")!)
    }
}

@MainActor
struct AppRollbackFileSwapperTests {
    @Test func swapKeepsBackupAndRestoreReturnsOriginalBytes() async throws {
        let files = FileManager.default
        let root = files.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? files.removeItem(at: root) }
        let running = root.appendingPathComponent("ModelDeck.app")
        let candidate = root.appendingPathComponent("image/ModelDeck.app")
        for bundle in [running, candidate] {
            try files.createDirectory(at: bundle, withIntermediateDirectories: true)
        }
        try Data("original".utf8).write(to: running.appendingPathComponent("payload"))
        try Data("older".utf8).write(to: candidate.appendingPathComponent("payload"))
        let swapper = AppRollbackFileSwapper()
        let staged = try await swapper.stage(bundle: candidate, runningBundle: running)
        let backup = try swapper.swap(staged: staged, runningBundle: running)
        #expect(try Data(contentsOf: backup.appendingPathComponent("payload")) == Data("original".utf8))
        #expect(try Data(contentsOf: running.appendingPathComponent("payload")) == Data("older".utf8))
        try swapper.restore(backup: backup, runningBundle: running)
        #expect(try Data(contentsOf: running.appendingPathComponent("payload")) == Data("original".utf8))
        swapper.cleanStaging(staged: staged)
        #expect(!files.fileExists(atPath: staged.deletingLastPathComponent().path))
    }

    @Test func existingStageIsNeverRemovedOrReused() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let stage = root.appendingPathComponent(".ModelDeck-rollback-staging")
        try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: true)
        try Data("keep".utf8).write(to: stage.appendingPathComponent("precious"))
        do {
            _ = try await AppRollbackFileSwapper().stage(bundle: root.appendingPathComponent("source.app"), runningBundle: root.appendingPathComponent("ModelDeck.app"))
            Issue.record("An existing staging folder was reused")
        } catch {}
        #expect(try Data(contentsOf: stage.appendingPathComponent("precious")) == Data("keep".utf8))
    }
}
