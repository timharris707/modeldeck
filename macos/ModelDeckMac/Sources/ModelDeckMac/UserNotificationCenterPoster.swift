import Foundation
import UserNotifications
import ModelDeckMacCore

/// Real banner delivery via UserNotifications. Authorization is requested
/// lazily — the first time a banner is actually due — never at launch. When
/// the user declines, posts become silent no-ops (the coordinator still
/// tracks levels so nothing spams if they later enable notifications in
/// System Settings).
///
/// Issue #685: every banner is stamped with its kind (`categoryIdentifier`)
/// so a click on it can be routed — see `UserNotificationClickDelegate`.
/// Identifiers, kinds, and sound rules live in Core
/// (`UserNotificationRequestSpec`) where they are pinned by tests.
struct UserNotificationCenterPoster: UserNotificationPosting {
    func post(_ alert: UsageAlert) async {
        await deliverBanner(.usage(alert))
    }
}

/// Issue #60: banner for the automatic update check.
struct AppUpdateNotificationPoster {
    func post(_ notification: AppUpdateNotification) async {
        await deliverBanner(.updateAvailable(notification))
    }
}

/// Issue #241: banner for a background update that finished staging —
/// "ModelDeck <version> is ready, restart to finish".
struct AppUpdateStagedNotificationPoster {
    func post(_ notification: AppUpdateNotification) async {
        await deliverBanner(.updateStaged(notification))
    }
}

/// Shared delivery: lazy authorization on the first banner, silent no-op
/// when declined or when running unbundled.
private func deliverBanner(_ spec: UserNotificationRequestSpec) async {
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
    content.title = spec.title
    content.body = spec.body
    content.sound = spec.sound ? .default : nil
    // Issue #685: the kind the click delegate routes on.
    content.categoryIdentifier = spec.kind.rawValue
    let request = UNNotificationRequest(identifier: spec.identifier, content: content, trigger: nil)
    try? await center.add(request)
}
