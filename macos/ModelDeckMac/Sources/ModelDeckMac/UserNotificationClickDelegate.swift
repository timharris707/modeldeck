import AppKit
import UserNotifications
import ModelDeckMacCore

/// Issue #685 — clicking a ModelDeck notification does something. Before
/// this the app had no `UNUserNotificationCenterDelegate`, so "ModelDeck
/// 1.1.13 is ready" was a banner you could only dismiss. Now the click is
/// routed by the kind the poster stamped (`UserNotificationClickRouter`,
/// Core, pure): the staged-update banner runs the SAME Restart the deck
/// banner runs; a usage banner opens the deck; anything else is ignored.
/// Installed once at app start (`install()`); this object is the center's
/// delegate for the process lifetime, so the app holds it strongly.
///
/// No `willPresent` on purpose: foreground presentation stays exactly what
/// it was without a delegate (the system's own default) — this change is
/// about what a click does, never about when banners show.
///
/// This type is only the UNUserNotificationCenter adapter; the routing and
/// callback dispatch live in Core (`UserNotificationClickHandler`) where
/// the tests drive them directly.
@MainActor
final class UserNotificationClickDelegate: NSObject, UNUserNotificationCenterDelegate {
    private let handler: UserNotificationClickHandler

    init(onRestartToUpdate: @escaping () -> Void, onOpenDeck: @escaping () -> Void) {
        handler = UserNotificationClickHandler(
            onRestartToUpdate: onRestartToUpdate, onOpenDeck: onOpenDeck
        )
    }

    /// Registers as the center's delegate. Bundle-only, like the poster —
    /// `UNUserNotificationCenter.current()` throws from a bare `swift run`.
    func install() {
        guard Bundle.main.bundleIdentifier != nil else { return }
        UNUserNotificationCenter.current().delegate = self
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let categoryIdentifier = response.notification.request.content.categoryIdentifier
        let isDefaultAction = response.actionIdentifier == UNNotificationDefaultActionIdentifier
        nonisolated(unsafe) let completionHandler = completionHandler
        Task { @MainActor in
            handler.handle(
                categoryIdentifier: categoryIdentifier,
                isDefaultAction: isDefaultAction,
                completion: completionHandler
            )
        }
    }
}

/// Issue #685: "open the deck" for a notification click. The deck has two
/// homes (#295): the floating window when detached, else the menu-bar
/// popover — which `MenuBarExtra` offers no API to open, so this presses
/// the status item's own button (the same window identification the #45
/// diagnostics and the #59 context menu use). A popover that is already
/// showing is left alone: pressing the button again would close it.
@MainActor
enum DeckOpener {
    static func openDeck(floatingModel: FloatingDeckModel, floatingController: FloatingDeckWindowController) {
        if floatingModel.isDetached {
            floatingController.show()
            return
        }
        if let window = DeckWindowRegistry.shared.registeredWindow as? NSWindow, window.isVisible {
            return
        }
        statusItemButton()?.performClick(nil)
    }

    private static func statusItemButton() -> NSStatusBarButton? {
        for window in NSApp.windows
        where String(describing: type(of: window)).contains("StatusBar") {
            if let button = firstStatusBarButton(in: window.contentView) {
                return button
            }
        }
        return nil
    }

    private static func firstStatusBarButton(in view: NSView?) -> NSStatusBarButton? {
        guard let view else { return nil }
        if let button = view as? NSStatusBarButton { return button }
        for sub in view.subviews {
            if let button = firstStatusBarButton(in: sub) { return button }
        }
        return nil
    }
}
