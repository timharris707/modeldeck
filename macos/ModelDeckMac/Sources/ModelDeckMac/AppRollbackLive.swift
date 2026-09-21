import AppKit
import Security
import ModelDeckMacCore

// Issue #706: only this adapter can mount an image, validate macOS code
// signatures, or launch/terminate an app. Core tests replace these operations.
@MainActor
struct AppRollbackLive: AppRollbackBundleInspecting, AppRollbackLaunching {
    func mount(image: URL) async throws -> URL {
        let output = try await Self.run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-mountrandom", "/tmp", "-plist", image.path])
        guard let plist = try PropertyListSerialization.propertyList(from: output, format: nil) as? [String: Any],
              let entities = plist["system-entities"] as? [[String: Any]],
              let path = entities.compactMap({ $0["mount-point"] as? String }).first else {
            throw AppRollbackError("The downloaded disk image could not be mounted.")
        }
        return URL(fileURLWithPath: path)
    }

    func inspect(bundle: URL, runningBundle: URL) async throws -> AppRollbackBundleIdentity {
        try await Task.detached {
            let own = try Self.runningCodeInfo()
            guard let team = own[kSecCodeInfoTeamIdentifier as String] as? String,
                  !team.isEmpty, team.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) }) else {
                throw AppRollbackError("The running app has no valid developer identity.")
            }
            guard let attributes = try? FileManager.default.attributesOfItem(atPath: bundle.path),
                  attributes[.type] as? FileAttributeType == .typeDirectory else {
                throw AppRollbackError("The disk image does not contain a ModelDeck app.")
            }
            var code: SecStaticCode?
            try Self.check(SecStaticCodeCreateWithPath(bundle as CFURL, [], &code))
            guard let code else { throw AppRollbackError("The app's code signature could not be read.") }
            let text = "anchor apple generic and identifier \"app.modeldeck.mac\" and certificate leaf[subject.OU] = \"\(team)\""
            var requirement: SecRequirement?
            try Self.check(SecRequirementCreateWithString(text as CFString, [], &requirement))
            let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate)
            try Self.check(SecStaticCodeCheckValidity(code, flags, requirement))
            let info = try Self.signingInfo(code)
            guard let candidateTeam = info[kSecCodeInfoTeamIdentifier as String] as? String,
                  let plist = try PropertyListSerialization.propertyList(
                    from: Data(contentsOf: bundle.appendingPathComponent("Contents/Info.plist")), format: nil) as? [String: Any],
                  let build = plist["CFBundleVersion"] as? String else {
                throw AppRollbackError("The app is missing its signed build identity.")
            }
            return AppRollbackBundleIdentity(runningTeamID: team, candidateTeamID: candidateTeam, build: build)
        }.value
    }

    func detach(mount: URL) async throws {
        _ = try await Self.run("/usr/bin/hdiutil", ["detach", mount.path])
    }

    func launch(bundle: URL) async throws {
        _ = try await Self.run("/usr/bin/open", ["-n", bundle.path])
    }

    func terminate() { NSApplication.shared.terminate(nil) }

    static func finishLaunch(installModel: AppUpdateInstallModel, bundle: Bundle = .main,
                             defaults: UserDefaults = .standard) {
        guard defaults.string(forKey: AppRollbackReadiness.backupPathKey) != nil
                || defaults.string(forKey: AppUpdateInstallModel.pendingInstallVersionKey) != nil else { return }
        // Issue #706: comparing the process's code hash to the disk bundle
        // prevents a surviving old process from deleting its own recovery app.
        let matches: Bool
        do {
            let own = try runningCodeInfo()
            var disk: SecStaticCode?
            try check(SecStaticCodeCreateWithPath(bundle.bundleURL as CFURL, [], &disk))
            guard let disk else { return }
            let diskInfo = try signingInfo(disk)
            matches = (own[kSecCodeInfoUnique as String] as? Data).map {
                $0 == diskInfo[kSecCodeInfoUnique as String] as? Data
            } ?? false
        } catch { return }
        installModel.finishInstallLaunch(currentBuild: bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
                                         isRunningProcess: matches)
        AppRollbackReadiness.finishLaunch(runningBundle: bundle.bundleURL, isRunningProcess: matches, defaults: defaults)
    }

    nonisolated private static func runningCodeInfo() throws -> [String: Any] {
        var code: SecCode?
        try check(SecCodeCopySelf([], &code))
        guard let code else { throw AppRollbackError("The running app's signature could not be read.") }
        var snapshot: SecStaticCode?
        try check(SecCodeCopyStaticCode(code, [], &snapshot))
        guard let snapshot else { throw AppRollbackError("The running app’s signature could not be read.") }
        return try signingInfo(snapshot)
    }

    nonisolated private static func signingInfo(_ code: SecStaticCode) throws -> [String: Any] {
        var info: CFDictionary?
        try check(SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info))
        guard let result = info as? [String: Any] else { throw AppRollbackError("The app's signature is missing.") }
        return result
    }

    nonisolated private static func check(_ status: OSStatus) throws {
        guard status == errSecSuccess else { throw AppRollbackError("The app's code signature could not be verified (\(status)).") }
    }

    nonisolated private static func run(_ executable: String, _ arguments: [String]) async throws -> Data {
        try await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            let output = Pipe()
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            process.standardInput = FileHandle.nullDevice
            try process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else {
                throw AppRollbackError("\(URL(fileURLWithPath: executable).lastPathComponent) could not finish (\(process.terminationStatus)).")
            }
            return data
        }.value
    }
}
