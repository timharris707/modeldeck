import Foundation

// Issue #706: both discovery and Sparkle must respect the version the user
// left. This is exact equality, not a ceiling on later fixes.
public enum AppUpdateSkipPolicy {
    public static let key = "modeldeck.appupdate.skippedVersion"
    public static func allows(version: String, defaults: UserDefaults = .standard) -> Bool {
        defaults.string(forKey: key) != version
    }
    public static func clear(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: key)
    }
}

public enum AppRollbackReadiness {
    public static let backupPathKey = "modeldeck.rollback.backupPath"
    public static let backupName = "ModelDeck (before rollback).app"

    // Issue #706: defaults are not permission to delete an arbitrary path,
    // and the old process must never clean up after a swap it hasn't launched.
    @discardableResult
    public static func finishLaunch(runningBundle: URL, isRunningProcess: Bool,
                                    defaults: UserDefaults = .standard,
                                    files: FileManager = .default) -> Bool {
        guard isRunningProcess, let path = defaults.string(forKey: backupPathKey) else { return false }
        let backup = URL(fileURLWithPath: path).standardizedFileURL
        let expected = runningBundle.deletingLastPathComponent().appendingPathComponent(backupName).standardizedFileURL
        guard backup == expected,
              let attributes = try? files.attributesOfItem(atPath: backup.path),
              attributes[.type] as? FileAttributeType == .typeDirectory else { return false }
        do {
            try files.removeItem(at: backup)
            defaults.removeObject(forKey: backupPathKey)
            return true
        } catch { return false }
    }
}
