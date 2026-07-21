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
        await deliverBanner(
            // One identifier per level: a newer banner for the same level
            // replaces the old one instead of stacking.
            identifier: "modeldeck.usage.level-\(alert.level.rawValue)",
            title: alert.title,
            body: alert.body,
            sound: alert.level == .critical ? .default : nil
        )
    }
}

/// Issue #60: banner for the automatic update check — same lazy
/// authorization path as usage banners; silent, and one fixed identifier so
/// a newer release banner replaces a stale one.
struct AppUpdateNotificationPoster {
    func post(_ notification: AppUpdateNotification) async {
        await deliverBanner(
            identifier: "modeldeck.appupdate.available",
            title: notification.title,
            body: notification.body,
            sound: nil
        )
    }
}

/// Shared delivery: lazy authorization on the first banner, silent no-op
/// when declined or when running unbundled.
private func deliverBanner(
    identifier: String,
    title: String,
    body: String,
    sound: UNNotificationSound?
) async {
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
    content.title = title
    content.body = body
    content.sound = sound
    let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
    try? await center.add(request)
}
