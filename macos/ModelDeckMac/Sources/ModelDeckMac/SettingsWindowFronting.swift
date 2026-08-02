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
    /// until it appears; if it never appears, there is nothing to front and
    /// the retries end silently.
    ///
    /// Issue #213 (Tim's field report 2026-08-02): the old single
    /// front-once-found inside a ~500 ms window lost two races — cooperative
    /// activation can be DENIED on the first ask (the window then sits
    /// behind the frontmost app, non-key), and a Terminal login launched
    /// alongside activates ~a daemon round-trip later, past the retry
    /// window. Fronting now keeps re-asserting (re-activate + key + order)
    /// until the window is genuinely key, for up to ~2.5 s — and cedes the
    /// moment another app takes activation away after we held it, because
    /// that app (e.g. Terminal running a provider login) is then the thing
    /// the user must interact with; stealing front back would be worse than
    /// the bug.
    static func activateAndFront() {
        activate()
        front(attempt: 0, heldActivation: NSApp.isActive)
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

    /// One assertion pass per tick: done when the window is key; ceded when
    /// activation was held once and then lost to another app; otherwise
    /// re-activate + re-front and try again. `heldActivation` latches the
    /// first observed active state so a slow cooperative-activation grant is
    /// never misread as "another app took over".
    private static func front(attempt: Int, heldActivation: Bool) {
        let isActive = NSApp.isActive
        if let window = settingsWindow() {
            if window.isKeyWindow { return } // settled in front
            if heldActivation && !isActive { return } // ceded (e.g. to Terminal)
            activate()
            window.makeKeyAndOrderFront(nil)
            // Accessory-policy apps can lose the key-window race to the
            // previously frontmost app; regardless-ordering keeps the
            // window visually on top even then.
            window.orderFrontRegardless()
        }
        guard attempt < 50 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(50)) {
            front(attempt: attempt + 1, heldActivation: heldActivation || isActive)
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
