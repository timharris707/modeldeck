import Foundation
import Testing
@testable import ModelDeckMacCore

/// Issue #230: Settings opened from the deck popover came up BEHIND it —
/// the popover is a status-level panel, so ordinary fronting can never win.
/// The fix dismisses the popover (via `DeckPopoverWindowMatcher` +
/// `window.close()` in `SettingsWindowFronting.activateAndFront()`); these
/// tests pin the matcher, whose contract is NARROW because a match gets
/// closed: false positives close unrelated windows, false negatives merely
/// leave the pre-#230 status quo.
@Suite("Issue #230 regressions")
struct Issue230RegressionTests {
    @Test("matches the .window-style MenuBarExtra panel class")
    func matchesMenuBarExtraWindow() {
        // Observed private class name, bare and module-prefixed forms —
        // the match is SUFFIX-anchored (CodeRabbit on PR #231), so prefixes
        // are tolerated but trailing additions are not.
        #expect(DeckPopoverWindowMatcher.matches(className: "MenuBarExtraWindow"))
        #expect(DeckPopoverWindowMatcher.matches(className: "SwiftUI.MenuBarExtraWindow"))
        #expect(DeckPopoverWindowMatcher.matches(className: "_TtC7SwiftUI18MenuBarExtraWindow"))
    }

    @Test("never matches the status item, Settings, or ordinary windows")
    func rejectsEverythingElse() {
        // The menu bar ICON's own window — closing it would remove the
        // status item entirely.
        #expect(!DeckPopoverWindowMatcher.matches(className: "NSStatusBarWindow"))
        // The Settings window being fronted must never be self-closed.
        #expect(!DeckPopoverWindowMatcher.matches(className: "SwiftUI.AppKitWindow"))
        #expect(!DeckPopoverWindowMatcher.matches(className: "NSWindow"))
        #expect(!DeckPopoverWindowMatcher.matches(className: "NSPanel"))
        // The #163 floating update dialog panel.
        #expect(!DeckPopoverWindowMatcher.matches(className: "AppUpdateDialogPanel"))
        // Suffix anchoring (CodeRabbit on PR #231): a class that merely
        // CONTAINS the panel name must not match.
        #expect(!DeckPopoverWindowMatcher.matches(className: "MenuBarExtraWindowHost"))
        #expect(!DeckPopoverWindowMatcher.matches(className: ""))
    }
}
