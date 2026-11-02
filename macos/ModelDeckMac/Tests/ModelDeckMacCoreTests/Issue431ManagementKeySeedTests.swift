import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #431 — seed-time management-key provisioning.
//
// Before this, a genuinely fresh install got a config with no
// `remote-management.secret-key` and no ~/.config/cliproxyapi/.mgmt-key, so the
// daemon's usage-queue consumer (src/usage-queue-consumer.mjs, path from
// CLIPROXY_MANAGEMENT_KEY_PATH) had nothing to authenticate with and the queue
// was never pulled. Tim's ruling (2026-08-14): generate at CONFIG-SEED TIME
// ONLY, write the secret into the seeded config AND the key file (0600), no
// Keychain, and never touch an existing install.
//
// Every test owns a fresh temp directory: no real ~/.config, no port 8317, no
// network, no real secrets.

private func scratchPaths() -> (ManagedProxyPaths, URL) {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("modeldeck-mgmt-key-\(UUID().uuidString)", isDirectory: true)
    return (
        ManagedProxyPaths(configDirectory: root.appendingPathComponent(".config/cliproxyapi", isDirectory: true)),
        root
    )
}

/// The seeded config's secret, read back the way a YAML consumer would.
private func secretKey(inConfigAt url: URL) throws -> String? {
    let text = try String(contentsOf: url, encoding: .utf8)
    for line in text.components(separatedBy: "\n") {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("secret-key:") else { continue }
        return trimmed
            .dropFirst("secret-key:".count)
            .trimmingCharacters(in: .whitespaces)
            .trimmingCharacters(in: CharacterSet(charactersIn: "\""))
    }
    return nil
}

private func keyFileContents(_ paths: ManagedProxyPaths) throws -> String {
    try String(contentsOf: paths.managementKeyFile, encoding: .utf8)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

private func posixPermissions(_ url: URL) throws -> Int {
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    return (attributes[.posixPermissions] as? NSNumber)?.intValue ?? -1
}

@Suite("Issue #431 — seed-time management key")
struct Issue431ManagementKeySeedTests {

    @Test("a fresh seed writes the config and a 0600 key file carrying the same secret")
    func freshSeedWritesBoth() throws {
        let (paths, root) = scratchPaths()
        defer { try? FileManager.default.removeItem(at: root) }

        let configFile = try ManagedProxyConfigFileWriter().ensureConfig(paths: paths, port: 8317)

        let fromConfig = try secretKey(inConfigAt: configFile)
        let fromKeyFile = try keyFileContents(paths)
        #expect(fromConfig == fromKeyFile)
        #expect(!fromKeyFile.isEmpty)
        // 32 random bytes as unpadded base64url — the daemon reads this
        // verbatim as a bearer token.
        #expect(fromKeyFile.count >= 43)
        #expect(fromKeyFile.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
        #expect(try posixPermissions(paths.managementKeyFile) == 0o600)
        // The config carries the same secret — same owner-only bar
        // (CodeRabbit PR #439 round 2).
        #expect(try posixPermissions(paths.configFile) == 0o600)
        // Still emphatically not an auth file, and no auth dir was created.
        #expect(!ManagedProxyWriteGuard.isAuthFile(paths.managementKeyFile, paths: paths))
        #expect(!FileManager.default.fileExists(atPath: paths.authDirectory.path))
    }

    // Issue #785: the proxy drops usage records unread for 60 seconds by
    // default, and the daemon pulls every 5 minutes.
    @Test("a fresh seed keeps unread usage records for an hour")
    func freshSeedSetsUsageQueueRetention() throws {
        let (paths, root) = scratchPaths()
        defer { try? FileManager.default.removeItem(at: root) }

        let configFile = try ManagedProxyConfigFileWriter().ensureConfig(paths: paths, port: 8317)
        let lines = try String(contentsOf: configFile, encoding: .utf8).components(separatedBy: "\n")
        #expect(lines.filter { $0.hasPrefix("redis-usage-queue-retention-seconds:") }
            == ["redis-usage-queue-retention-seconds: 3600"])
    }

    @Test("concurrent seeds of one directory agree on a single secret (CodeRabbit PR #439)")
    func concurrentSeedsAgree() async throws {
        // The race arbiter is O_EXCL creation: whichever seed creates
        // .mgmt-key wins, the loser rereads and adopts it, and every config
        // written carries the on-disk secret — never a mismatched pair the
        // daemon could not authenticate against.
        let (paths, root) = scratchPaths()
        defer { try? FileManager.default.removeItem(at: root) }

        let configs = try await withThrowingTaskGroup(of: URL.self) { group -> [URL] in
            for _ in 0..<8 {
                group.addTask {
                    try ManagedProxyConfigFileWriter().ensureConfig(paths: paths, port: 8317)
                }
            }
            var seeded: [URL] = []
            for try await next in group { seeded.append(next) }
            return seeded
        }
        #expect(configs.count == 8)

        let onDisk = try keyFileContents(paths)
        #expect(try secretKey(inConfigAt: paths.configFile) == onDisk)
        #expect(!onDisk.isEmpty)
        #expect(try posixPermissions(paths.managementKeyFile) == 0o600)
        #expect(try posixPermissions(paths.configFile) == 0o600)
        // Losing publishers unlink their temps — nothing half-published
        // survives the race (PR #439 round 3).
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: paths.configDirectory.path)
            .filter { $0.hasPrefix(".seed.") }
        #expect(leftovers.isEmpty)
    }

    @Test("two fresh seeds never produce the same secret")
    func secretsAreRandom() throws {
        var seen: Set<String> = []
        for _ in 0..<3 {
            let (paths, root) = scratchPaths()
            defer { try? FileManager.default.removeItem(at: root) }
            _ = try ManagedProxyConfigFileWriter().ensureConfig(paths: paths, port: 8317)
            seen.insert(try keyFileContents(paths))
        }
        #expect(seen.count == 3)
    }

    @Test("an existing config with an existing key file is left completely alone")
    func existingInstallUntouched() throws {
        let (paths, root) = scratchPaths()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: paths.configDirectory, withIntermediateDirectories: true)
        let config = "port: 8317\n# hand-tuned by the user\n"
        let key = "operator-placeholder-key\n"
        try Data(config.utf8).write(to: paths.configFile)
        try Data(key.utf8).write(to: paths.managementKeyFile)

        _ = try ManagedProxyConfigFileWriter().ensureConfig(paths: paths, port: 8317)

        #expect(try String(contentsOf: paths.configFile, encoding: .utf8) == config)
        #expect(try String(contentsOf: paths.managementKeyFile, encoding: .utf8) == key)
    }

    /// The ruled case: a config exists but no key file. ModelDeck reports,
    /// it does not repair — that machine's operator owns their arrangement.
    @Test("an existing config with NO key file is not repaired")
    func existingConfigWithoutKeyIsNotRepaired() throws {
        let (paths, root) = scratchPaths()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: paths.configDirectory, withIntermediateDirectories: true)
        let config = "port: 8317\n# hand-tuned by the user\n"
        try Data(config.utf8).write(to: paths.configFile)

        _ = try ManagedProxyConfigFileWriter().ensureConfig(paths: paths, port: 8317)

        #expect(try String(contentsOf: paths.configFile, encoding: .utf8) == config)
        #expect(!FileManager.default.fileExists(atPath: paths.managementKeyFile.path))
    }

    /// The odd half-state: a key file with no config (an interrupted seed).
    /// Seeding invents a NEW secret there would silently invalidate the key
    /// something already reads, so the existing value is reused.
    @Test("a key file without a config is reused, not orphaned")
    func halfStateReusesExistingKey() throws {
        let (paths, root) = scratchPaths()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: paths.configDirectory, withIntermediateDirectories: true)
        let existing = "half-state-placeholder-key"
        try Data((existing + "\n").utf8).write(to: paths.managementKeyFile)

        let configFile = try ManagedProxyConfigFileWriter().ensureConfig(paths: paths, port: 8317)

        #expect(try secretKey(inConfigAt: configFile) == existing)
        // The key file itself was not rewritten.
        #expect(try String(contentsOf: paths.managementKeyFile, encoding: .utf8) == existing + "\n")
    }

    @Test("an empty key file is reported, never overwritten")
    func emptyKeyFileIsReported() throws {
        let (paths, root) = scratchPaths()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: paths.configDirectory, withIntermediateDirectories: true)
        try Data("   \n".utf8).write(to: paths.managementKeyFile)

        #expect(throws: ManagedProxySeedError.existingManagementKeyUnusable(paths.managementKeyFile.path)) {
            _ = try ManagedProxyConfigFileWriter().ensureConfig(paths: paths, port: 8317)
        }
        // No config was seeded against a key nobody can use.
        #expect(!FileManager.default.fileExists(atPath: paths.configFile.path))
        #expect(try String(contentsOf: paths.managementKeyFile, encoding: .utf8) == "   \n")
    }

    @Test("a key file that cannot be written fails honestly, naming the path")
    func permissionFailureSurfaces() throws {
        guard getuid() != 0 else { return }  // root ignores the mode; nothing to prove
        let (paths, root) = scratchPaths()
        try FileManager.default.createDirectory(at: paths.configDirectory, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: paths.configDirectory.path)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: paths.configDirectory.path)
            try? FileManager.default.removeItem(at: root)
        }

        #expect(throws: ManagedProxySeedError.managementKeyWriteFailed(paths.managementKeyFile.path)) {
            _ = try ManagedProxyConfigFileWriter().ensureConfig(paths: paths, port: 8317)
        }
        #expect(!FileManager.default.fileExists(atPath: paths.configFile.path))
    }
}

// MARK: - TRIPWIRE management-secret-never-in-an-error

/// The secret is the one string that must never leave the two files it lives
/// in: not a log line, not a UI string, not an error message. Errors name
/// paths. Mutation-verified: interpolating the secret into
/// `ManagedProxySeedError.managementKeyWriteFailed` fails both tests below.
@Suite("Issue #431 — TRIPWIRE management-secret-never-in-an-error")
struct Issue431SecretNeverInErrorTests {

    /// Anything that looks like a 32-byte base64url token.
    private func containsSecretShapedToken(_ text: String) -> Bool {
        text.range(of: "[A-Za-z0-9_-]{40,}", options: .regularExpression) != nil
    }

    private func errorText(_ error: Error) -> String {
        [String(describing: error), (error as? LocalizedError)?.errorDescription ?? "", error.localizedDescription]
            .joined(separator: " | ")
    }

    @Test("a failed seed never puts a generated secret in its error")
    func generatedSecretNeverLeaks() throws {
        guard getuid() != 0 else { return }
        let (paths, root) = scratchPaths()
        try FileManager.default.createDirectory(at: paths.configDirectory, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: paths.configDirectory.path)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: paths.configDirectory.path)
            try? FileManager.default.removeItem(at: root)
        }

        do {
            _ = try ManagedProxyConfigFileWriter().ensureConfig(paths: paths, port: 8317)
            Issue.record("expected the seed to fail against an unwritable config directory")
        } catch {
            let text = errorText(error)
            #expect(text.contains(paths.managementKeyFile.lastPathComponent), "the error must name the path")
            // Paths are allowed (and a temp path carries its own long UUID),
            // so scan what remains once the named paths are removed.
            let beyondPaths = text
                .replacingOccurrences(of: paths.managementKeyFile.path, with: "<key-path>")
                .replacingOccurrences(of: paths.configFile.path, with: "<config-path>")
                .replacingOccurrences(of: paths.configDirectory.path, with: "<config-dir>")
            #expect(!containsSecretShapedToken(beyondPaths), "a secret-shaped token appeared in an error message")
        }
    }

    @Test("a failed seed never puts a REUSED secret in its error")
    func reusedSecretNeverLeaks() throws {
        guard getuid() != 0 else { return }
        let (paths, root) = scratchPaths()
        try FileManager.default.createDirectory(at: paths.configDirectory, withIntermediateDirectories: true)
        // A placeholder standing in for a real key — the exact string the
        // error must not contain.
        let secret = "TRIPWIRE-placeholder-secret-431"
        try Data((secret + "\n").utf8).write(to: paths.managementKeyFile)
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: paths.configDirectory.path)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: paths.configDirectory.path)
            try? FileManager.default.removeItem(at: root)
        }

        do {
            _ = try ManagedProxyConfigFileWriter().ensureConfig(paths: paths, port: 8317)
            Issue.record("expected the config write to fail against an unwritable directory")
        } catch {
            #expect(!errorText(error).contains(secret))
        }
    }
}
