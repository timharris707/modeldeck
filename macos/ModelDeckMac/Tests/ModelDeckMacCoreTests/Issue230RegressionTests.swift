import Foundation
import Testing
@testable import ModelDeckMacCore

/// Issue #230: Settings opened from the deck popover came up BEHIND it —
/// the popover is a status-level panel, so ordinary fronting can never win.
/// REOPEN: the matcher pinned here is now the FALLBACK only (the primary
/// mechanism is direct capture via `DeckWindowRegistry` — see
/// `DeckWindowRegistryTests`); its contract stays NARROW because a match
/// still gets closed: false positives close unrelated windows, false
/// negatives merely leave the never-registered status quo.
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

    @Test("matches the macOS 26 generic host class, empirically observed")
    func matchesMacOS26GenericClass() {
        // Observed verbatim on macOS 26.5.2 (25F84, 2026-08-04) via the
        // #230-reopen runtime capture: MenuBarExtraWindow<AnyView>. The
        // suffix rule alone missed it — the mangled name ends in the
        // generic argument, which is the whole v0.3.17 regression.
        #expect(DeckPopoverWindowMatcher.matches(
            className: "_TtGC7SwiftUI18MenuBarExtraWindowVS_7AnyView_"
        ))
        // Any other generic argument still matches — the prefix pins the
        // class identity (module SwiftUI, name length exactly 18), not the
        // hosted content type.
        #expect(DeckPopoverWindowMatcher.matches(
            className: "_TtGC7SwiftUI18MenuBarExtraWindowVS_9SomeOther_"
        ))
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
        // The macOS 26 generic-prefix rule pins name length 18: a mangled
        // 22-char `MenuBarExtraWindowHost<...>` must not match either.
        #expect(!DeckPopoverWindowMatcher.matches(
            className: "_TtGC7SwiftUI22MenuBarExtraWindowHostVS_7AnyView_"
        ))
        // Nor another module's identically named generic class.
        #expect(!DeckPopoverWindowMatcher.matches(
            className: "_TtGC9SomeOther18MenuBarExtraWindowVS_7AnyView_"
        ))
        #expect(!DeckPopoverWindowMatcher.matches(className: ""))
    }
}
