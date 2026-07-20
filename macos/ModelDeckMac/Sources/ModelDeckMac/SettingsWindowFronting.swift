import AppKit
import ModelDeckMacCore

/// Issue #45 (bug 2 root cause): ModelDeck is a MenuBarExtra app running
/// with the accessory activation policy, so `SettingsLink`/`openSettings`
/// alone opens the Settings window WITHOUT activating the app — with any
/// other app frontmost the window comes up behind it (or, when it already
/// exists from a previous open, isn't raised at all), which reads as "the
/// gear does nothing". The fix is to activate the app around the open and
/// explicitly order the Settings window front + key once it exists.
@MainActor
enum SettingsWindowFronting {
    /// Activate the app, then front + key the Settings window. The window
    /// is created asynchronously by `openSettings()`, so fronting retries
    /// briefly until it appears (10 x 50 ms covers window creation
    /// comfortably; if it never appears, there is nothing to front and the
    /// retries end silently).
    static func activateAndFront() {
        activate()
        front(attempt: 0)
    }

    /// Activate the app so an alert/dialog presented from the popover comes
    /// up in front of whatever app was frontmost (same accessory-policy
    /// pitfall as the Settings window).
    static func activateForDialog() {
        activate()
    }

    /// macOS 14 deprecated `activate(ignoringOtherApps:)`; the replacement
    /// carries cooperative-activation semantics, which is what we want —
    /// keep the old call only for pre-14 deployment targets.
    private static func activate() {
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    private static func front(attempt: Int) {
        if let window = settingsWindow() {
            window.makeKeyAndOrderFront(nil)
            // Accessory-policy apps can lose the key-window race to the
            // previously frontmost app; regardless-ordering keeps the
            // window visually on top even then.
            window.orderFrontRegardless()
            return
        }
        guard attempt < 10 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(50)) {
            front(attempt: attempt + 1)
        }
    }

    private static func settingsWindow() -> NSWindow? {
        NSApp.windows.first { window in
            SettingsWindowMatcher.matches(
                identifier: window.identifier?.rawValue,
                title: window.title
            )
        }
    }
}
