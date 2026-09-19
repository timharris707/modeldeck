import Foundation

// Issue #685 — notifications are clickable. Every banner the app posts is
// stamped with a kind (its UNNotificationContent.categoryIdentifier), and a
// click routes by that kind to ONE of the actions below. The routing is a
// pure function here so it is testable without UNUserNotificationCenter;
// the app target's delegate reads the kind off the response and applies
// the action. Nothing about WHEN banners fire or what they say changes.

/// The kind stamped on every ModelDeck notification.
public enum UserNotificationKind: String, Sendable, CaseIterable {
    /// Usage warning/critical banners (#7) and model-drop banners (#377) —
    /// everything the deck itself explains.
    case usage = "modeldeck.kind.usage"
    /// "ModelDeck <version> is available" (#60): informational only.
    case updateAvailable = "modeldeck.kind.updateAvailable"
    /// "ModelDeck <version> is ready" (#241): a restart finishes the update.
    case updateStaged = "modeldeck.kind.updateStaged"
}

/// What a click on a notification does.
public enum UserNotificationClickAction: Equatable, Sendable {
    /// The same one-click Restart the deck banner runs (#241 → #303).
    case restartToUpdate
    /// Show the deck (the menu-bar popover, or the floating deck when
    /// detached).
    case openDeck
    /// Nothing — an unknown kind, or a dismissal rather than a click.
    case none
}

/// Pure kind → action table.
public enum UserNotificationClickRouter {
    /// `categoryIdentifier` is the stamped kind (an empty or foreign value
    /// is unknown); `isDefaultAction` is true for the user's click on the
    /// banner itself, false for a dismissal or any custom action button.
    public static func action(
        categoryIdentifier: String,
        isDefaultAction: Bool
    ) -> UserNotificationClickAction {
        guard isDefaultAction, let kind = UserNotificationKind(rawValue: categoryIdentifier) else {
            return .none
        }
        switch kind {
        case .updateStaged: return .restartToUpdate
        case .usage: return .openDeck
        case .updateAvailable: return .none
        }
    }
}

/// The click handler the app target's `UNUserNotificationCenterDelegate`
/// adapter calls (Astra review, PR #686): takes the response's category and
/// action identity, routes through `UserNotificationClickRouter`, runs the
/// wired callback, and calls `completion` exactly once — testable with no
/// UNUserNotificationCenter in sight.
@MainActor
public final class UserNotificationClickHandler {
    private let onRestartToUpdate: () -> Void
    private let onOpenDeck: () -> Void

    public init(onRestartToUpdate: @escaping () -> Void, onOpenDeck: @escaping () -> Void) {
        self.onRestartToUpdate = onRestartToUpdate
        self.onOpenDeck = onOpenDeck
    }

    /// Handles one notification response. `completion` is always called,
    /// once, after the action (the center's contract for
    /// `didReceive`'s completion handler).
    public func handle(categoryIdentifier: String, isDefaultAction: Bool, completion: () -> Void) {
        switch UserNotificationClickRouter.action(
            categoryIdentifier: categoryIdentifier, isDefaultAction: isDefaultAction
        ) {
        case .restartToUpdate: onRestartToUpdate()
        case .openDeck: onOpenDeck()
        case .none: break
        }
        completion()
    }
}

/// Everything the app-side poster needs to build a notification request,
/// derived here so the identifier and kind rules are pinned by tests.
public struct UserNotificationRequestSpec: Equatable, Sendable {
    /// Coalescing identifier: a newer banner with the same identifier
    /// replaces the older one instead of stacking.
    public var identifier: String
    public var title: String
    public var body: String
    public var kind: UserNotificationKind
    /// Whether the banner plays the default sound.
    public var sound: Bool

    public init(identifier: String, title: String, body: String, kind: UserNotificationKind, sound: Bool) {
        self.identifier = identifier
        self.title = title
        self.body = body
        self.kind = kind
        self.sound = sound
    }

    /// Usage/model-drop banners. One identifier per level, so a newer
    /// banner for the same level replaces the old one; an alert carrying
    /// its own identity key (#377's model drops — several can be live at
    /// once, all .critical) coalesces on that instead (CodeRabbit, PR #472).
    public static func usage(_ alert: UsageAlert) -> UserNotificationRequestSpec {
        UserNotificationRequestSpec(
            identifier: alert.identityKey.map { "modeldeck.\($0)" }
                ?? "modeldeck.usage.level-\(alert.level.rawValue)",
            title: alert.title,
            body: alert.body,
            kind: .usage,
            sound: alert.level == .critical
        )
    }

    /// Issue #60: one fixed identifier so a newer release banner replaces a
    /// stale one.
    public static func updateAvailable(_ notification: AppUpdateNotification) -> UserNotificationRequestSpec {
        UserNotificationRequestSpec(
            identifier: "modeldeck.appupdate.available",
            title: notification.title,
            body: notification.body,
            kind: .updateAvailable,
            sound: false
        )
    }

    /// Issue #241: its own identifier — it replaces itself per version but
    /// never clobbers the availability banner (availability and readiness
    /// are different events; both may be pending at once).
    public static func updateStaged(_ notification: AppUpdateNotification) -> UserNotificationRequestSpec {
        UserNotificationRequestSpec(
            identifier: "modeldeck.appupdate.staged",
            title: notification.title,
            body: notification.body,
            kind: .updateStaged,
            sound: false
        )
    }
}
