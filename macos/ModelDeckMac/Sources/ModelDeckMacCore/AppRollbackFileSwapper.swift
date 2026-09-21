import Foundation
import Darwin

// Issue #706: staging stays beside the app so replacement is on one volume.
// An existing stage or backup belongs to an interrupted attempt, not this one.
@MainActor
public struct AppRollbackFileSwapper: AppRollbackSwapping {
    public init() {}

    public func stage(bundle: URL, runningBundle: URL) async throws -> URL {
        try await Task.detached {
            let files = FileManager.default
            let directory = runningBundle.deletingLastPathComponent().appendingPathComponent(".ModelDeck-rollback-staging")
            guard mkdir(directory.path, 0o700) == 0 else {
                throw AppRollbackError("The rollback staging folder could not be created. An earlier rollback may need recovery.")
            }
            let staged = directory.appendingPathComponent("ModelDeck.app")
            do { try files.copyItem(at: bundle, to: staged) }
            catch { try? files.removeItem(at: directory); throw error }
            return staged
        }.value
    }

    public func swap(staged: URL, runningBundle: URL) throws -> URL {
        let backup = runningBundle.deletingLastPathComponent().appendingPathComponent(AppRollbackReadiness.backupName)
        guard (try? FileManager.default.attributesOfItem(atPath: backup.path)) == nil else {
            throw AppRollbackError("A previous rollback backup is still present at \(backup.path). Restart ModelDeck before trying again.")
        }
        // Issue #706: [] deletes the backup on success. Foundation requires
        // this option to keep recovery possible until the new app launches.
        _ = try FileManager.default.replaceItemAt(runningBundle, withItemAt: staged,
            backupItemName: AppRollbackReadiness.backupName, options: [.withoutDeletingBackupItem])
        return backup
    }

    public func restore(backup: URL, runningBundle: URL) throws {
        _ = try FileManager.default.replaceItemAt(runningBundle, withItemAt: backup)
    }

    public func cleanStaging(staged: URL) {
        try? FileManager.default.removeItem(at: staged.deletingLastPathComponent())
    }
}
