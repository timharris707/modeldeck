import Foundation

/// Issue #230: pure identification of the `.window`-style MenuBarExtra deck
/// panel among `NSApp.windows`, kept in Core so it is unit-testable (the
/// same seam shape as `SettingsWindowMatcher`).
///
/// SwiftUI hosts the deck in a private panel class named
/// `MenuBarExtraWindow` (observed on macOS 13–15; the runtime name may carry
/// a module prefix, hence a SUFFIX match — anchored at the end so a
/// non-deck class like a hypothetical `MenuBarExtraWindowHost` can never
/// match; CodeRabbit on PR #231). That panel floats at status level —
/// ABOVE normal windows — which is exactly why a Settings window opened
/// from it came up occluded.
///
/// Matching is deliberately NARROW, the opposite of the Settings matcher's
/// looseness: a match gets CLOSED, so a false positive would dismiss an
/// unrelated window, while a false negative merely leaves the popover up
/// (the pre-#230 status quo, and the fronting retries still run). In
/// particular the status ITEM's own `NSStatusBarWindow` (the menu bar icon)
/// must never match.
public enum DeckPopoverWindowMatcher {
    public static func matches(className: String) -> Bool {
        className.hasSuffix("MenuBarExtraWindow")
    }
}
