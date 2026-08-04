import Foundation

/// Issue #230: pure identification of the `.window`-style MenuBarExtra deck
/// panel among `NSApp.windows`, kept in Core so it is unit-testable (the
/// same seam shape as `SettingsWindowMatcher`).
///
/// REOPEN (Tim's 2026-08-04 field report on v0.3.17): this name-based
/// identification is now the FALLBACK only. `MenuBarExtraWindow` was
/// observed on macOS 13–15 but did not match on macOS 26 — the class-name
/// guess is exactly how the shipped fix no-opped. The primary mechanism is
/// direct capture (`DeckWindowRegistry`: the deck hierarchy registers its
/// own `NSWindow`); this scan runs only when nothing was ever registered.
/// Extend the accepted names ONLY with an empirically observed runtime
/// class name, documented with where/when it was observed.
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
    /// Empirically observed on macOS 26.5.2 (25F84, Tim's machine,
    /// 2026-08-04, this lane's runtime verification): SwiftUI now hosts the
    /// deck in a GENERIC class — `MenuBarExtraWindow<AnyView>`, runtime name
    /// `_TtGC7SwiftUI18MenuBarExtraWindowVS_7AnyView_` — which ends in the
    /// generic argument's mangling, so the macOS 13–15 suffix match silently
    /// never fired (the v0.3.17 regression). The prefix pins the full
    /// mangled identity `_TtGC7SwiftUI18` + `MenuBarExtraWindow`: generic
    /// class, module SwiftUI, name length EXACTLY 18 — a hypothetical
    /// `MenuBarExtraWindowHost` would mangle with length 22 and not match.
    static let macOS26GenericPrefix = "_TtGC7SwiftUI18MenuBarExtraWindow"

    public static func matches(className: String) -> Bool {
        className.hasSuffix("MenuBarExtraWindow")
            || className.hasPrefix(macOS26GenericPrefix)
    }
}
