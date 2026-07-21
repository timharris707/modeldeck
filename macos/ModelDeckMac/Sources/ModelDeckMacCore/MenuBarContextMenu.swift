import Foundation

/// Issue #59 — the menu bar icon's right-click (or ctrl-click) context menu:
/// the standard menu-bar-agent affordance for an app with no Dock icon and
/// no app menu. Pure derivation of the menu's contents so the AppKit
/// controller in the app target stays thin and this is unit-testable.
public enum MenuBarContextMenu {
    public enum Action: Equatable, Sendable {
        case checkForAppUpdates
        case quit
    }

    public struct Item: Equatable, Sendable {
        public var title: String
        public var action: Action
        public var isEnabled: Bool

        public init(title: String, action: Action, isEnabled: Bool = true) {
            self.title = title
            self.action = action
            self.isEnabled = isEnabled
        }
    }

    /// The fixed menu: Check for App Updates… (issue #59 scope addition —
    /// reachable without digging into the gear menu; disabled while a check
    /// is already in flight) above Quit ModelDeck. Wording matches the gear
    /// menu exactly — same shared AppUpdateModel behind both.
    public static func items(isCheckingForUpdates: Bool) -> [Item] {
        [
            Item(
                title: "Check for App Updates…",
                action: .checkForAppUpdates,
                isEnabled: !isCheckingForUpdates
            ),
            Item(title: "Quit ModelDeck", action: .quit),
        ]
    }

    /// Whether a mouse event on the status item should open the context
    /// menu: right-click, or ctrl-click (the standard secondary-click
    /// equivalent). A plain left click stays the popover toggle.
    public static func isContextMenuTrigger(isRightClick: Bool, isControlDown: Bool) -> Bool {
        isRightClick || isControlDown
    }
}
