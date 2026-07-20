import Foundation
import UserNotifications
import ModelDeckMacCore

/// Real banner delivery via UserNotifications. Authorization is requested
/// lazily — the first time a banner is actually due — never at launch. When
/// the user declines, posts become silent no-ops (the coordinator still
/// tracks levels so nothing spams if they later enable notifications in
/// System Settings).
struct UserNotificationCenterPoster: UserNotificationPosting {
    func post(_ alert: UsageAlert) async {
        // UNUserNotificationCenter requires a real app bundle; from a bare
        // `swift run` binary it throws an Objective-C exception. Same guard
        // philosophy as LaunchAtLogin: bundle-only features stay quiet in
        // dev runs.
        guard Bundle.main.bundleIdentifier != nil else { return }
        let center = UNUserNotificationCenter.current()
        var status = await center.notificationSettings().authorizationStatus
        if status == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
            status = await center.notificationSettings().authorizationStatus
        }
        guard status == .authorized || status == .provisional else { return }
        let content = UNMutableNotificationContent()
        content.title = alert.title
        content.body = alert.body
        content.sound = alert.level == .critical ? .default : nil
        let request = UNNotificationRequest(
            // One identifier per level: a newer banner for the same level
            // replaces the old one instead of stacking.
            identifier: "modeldeck.usage.level-\(alert.level.rawValue)",
            content: content,
            trigger: nil
        )
        try? await center.add(request)
    }
}
